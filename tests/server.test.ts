import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import {
  AI_EDIT_CRITERIA,
  AI_EDIT_OUTPUT_SCHEMA,
  AI_EDIT_VERDICT_OUTPUT_SCHEMA,
  type AiEditReadyResult,
  type AiEditRequest,
  type AiEditVerdict,
} from "../src/core/ai-edit.ts";
import { runAiEditAttempts } from "../src/core/ai-edit-runner.ts";
import { createDocument, createProject as makeProject } from "../src/core/document.ts";
import { compositeFrame } from "../src/core/render.ts";
import { addFrame } from "../src/core/timeline.ts";
import { celKey, type RGBA } from "../src/core/types.ts";
import type { CellEditRunRequest, CodexEvent, GenerationRequest } from "../src/server/codex-bridge.ts";
import { createPixelForgeServer } from "../src/server/app.ts";
import { activeCelFrame } from "../src/server/ai-edit.ts";
import { decodePng, encodePng } from "../src/server/png.ts";
import { createProject, loadProject, saveProject } from "../src/server/project-store.ts";

class FakeCodex extends EventEmitter {
  lastPrompt = "";
  lastCellEdit?: CellEditRunRequest;
  lastRunId = "";
  cellEdits: CellEditRunRequest[] = [];
  judgments: CellEditRunRequest[] = [];
  runs: Array<{ id: string; role: "editing" | "judging" }> = [];
  responses: Array<{ id: number; result: unknown }> = [];
  interrupts: string[] = [];
  approvalDuringStart = false;
  interruptWait?: Promise<void>;
  judgmentWait?: Promise<void>;
  interruptError?: Error;
  cellEditError?: Error;
  cellEditEventsDuringStart: CodexEvent[] = [];
  private runNumber = 0;

  async getAccount() {
    return { account: { type: "chatgpt", email: "maker@example.com", planType: "plus" }, requiresOpenaiAuth: false };
  }

  async login() {
    return { type: "chatgpt" as const, loginId: "login-1", authUrl: "https://chatgpt.com/login" };
  }

  async startGeneration(request: GenerationRequest) {
    this.lastPrompt = request.prompt;
    const runId = `run-${++this.runNumber}`;
    this.lastRunId = runId;
    const threadId = `thread-${this.runNumber}`;
    if (this.approvalDuringStart) this.event({ type: "approval", requestId: 77, method: "item/fileChange/requestApproval", params: { threadId, turnId: runId }, runId, threadId });
    return { id: runId, threadId, turnId: runId };
  }

  private startRun(role: "editing" | "judging") {
    const id = `run-${++this.runNumber}`;
    const run = { id, threadId: `thread-${this.runNumber}`, turnId: id };
    this.lastRunId = id;
    this.runs.push({ id, role });
    return run;
  }

  async startCellEdit(request: CellEditRunRequest) {
    this.lastCellEdit = request;
    this.cellEdits.push(request);
    if (this.cellEditError) throw this.cellEditError;
    const candidate = basename(request.candidateCompositePath).match(/^attempt-(\d+)-composite\.png$/);
    if (candidate) await readFile(join(dirname(request.candidateCompositePath), `attempt-${candidate[1]}-verdict.json`));
    const run = this.startRun("editing");
    for (const event of this.cellEditEventsDuringStart) this.event({ ...event, runId: run.id } as CodexEvent);
    this.cellEditEventsDuringStart = [];
    return run;
  }

  async startCellEditJudgment(request: CellEditRunRequest) {
    this.judgments.push(request);
    await Promise.all([readFile(request.candidateCompositePath), readFile(request.candidateCelPath)]);
    await this.judgmentWait;
    return this.startRun("judging");
  }

  async completeResult(value: unknown, nextRole?: "editing" | "judging") {
    const runId = this.lastRunId;
    const runCount = this.runs.length;
    this.event({ type: "result", runId, text: JSON.stringify(value) });
    this.event({ type: "completed", runId, status: "completed" });
    for (let count = 0; nextRole && count < 50; count += 1) {
      if (this.runs.length !== runCount && this.runs.at(-1)?.role === nextRole) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    if (nextRole) throw new Error(`다음 ${nextRole} 실행이 시작되지 않았습니다.`);
  }

  async interrupt(runId: string) { this.interrupts.push(runId); await this.interruptWait; if (this.interruptError) throw this.interruptError; }

  respond(id: number, result: unknown) {
    this.responses.push({ id, result });
  }

  event(event: CodexEvent) {
    this.emit("event", event);
  }
}

function threeFrameProject() {
  let document = createDocument({ width: 2, height: 1 });
  document = addFrame(addFrame(document));
  const colors = [
    [255, 0, 0, 255],
    [0, 255, 0, 255],
    [0, 0, 255, 255],
  ];
  for (const [index, frame] of document.frames.entries()) {
    const cel = document.cels[celKey(frame.id, document.layers[0].id)];
    document.images[cel.imageId].data.set([...colors[index], ...colors[index]]);
  }
  document.tags.push({
    id: crypto.randomUUID(),
    name: "공격",
    fromFrameId: document.frames[0].id,
    toFrameId: document.frames[2].id,
    direction: "forward",
  });
  const project = makeProject("기사", document);
  project.generationHistory.push({ id: crypto.randomUUID(), prompt: "기존 생성", createdAt: "2026-08-09T00:00:00.000Z", outputPath: "old.png" });
  return project;
}

function pathFromPrompt(prompt: string, label: string): string {
  const path = prompt.split("\n").find((line) => line.startsWith(`${label}: `))?.slice(label.length + 2);
  assert.ok(path, `${label} 경로가 프롬프트에 필요합니다.`);
  return path;
}

async function waitForJob(base: string, jobId: string, kind: "generations" | "edits" = "generations") {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const job = await fetch(`${base}/api/${kind}/${jobId}`).then((response) => response.json()) as { status: string; error?: string };
    if (!["running", "awaitingApproval", "cancelling", "finalizing"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("생성 작업이 종료되지 않았습니다.");
}

function cellEditRequest(project: ReturnType<typeof threeFrameProject>): AiEditRequest {
  const frameId = project.document.frames[1].id;
  const layerId = project.document.layers[0].id;
  const celId = project.document.cels[celKey(frameId, layerId)].id;
  return {
    prompt: "배경을 빨갛게 칠해 줘",
    target: { frameId, layerId, celId },
    settings: {
      tool: "pencil",
      color: [0, 0, 0, 255],
      secondaryColor: [255, 255, 255, 255],
      brushSize: 1,
      brushShape: "square",
      filled: false,
      mirrorX: false,
      mirrorY: false,
    },
  };
}

async function startGenerationServer(
  root: string,
  codex: FakeCodex,
  cellEditCodex: FakeCodex = codex,
  cellEditApplicationTimeoutMs?: number,
) {
  const codexListeners = codex.listenerCount("event");
  const cellEditListeners = cellEditCodex.listenerCount("event");
  const server = createPixelForgeServer({ projectsRoot: root, codex, cellEditCodex, cellEditApplicationTimeoutMs });
  assert.equal(codex.listenerCount("event"), codexListeners + 1);
  if (cellEditCodex !== codex) assert.equal(cellEditCodex.listenerCount("event"), cellEditListeners + 1);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const session = await fetch(`${base}/api/session`).then((response) => response.json()) as { token: string };
  return { server, base, token: session.token };
}

type CellEditWire = {
  id: string;
  kind: "cellEdit";
  status: "running" | "cancelling" | "finalizing" | "completed" | "failed" | "cancelled";
  phase?: "editing" | "judging";
  attempt?: number;
  maxAttempts?: number;
  logPath?: string;
  error?: string;
  result?: AiEditReadyResult;
};

async function waitForCellEditStatus(base: string, id: string, status: CellEditWire["status"]): Promise<CellEditWire> {
  for (let count = 0; count < 50; count += 1) {
    const job = await fetch(`${base}/api/edits/${id}`).then((response) => response.json()) as CellEditWire;
    if (job.status === status) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`셀 편집 작업이 ${status} 상태가 되지 않았습니다.`);
}

async function waitUntil(condition: () => boolean, message: string): Promise<void> {
  for (let count = 0; count < 50; count += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

const passingCriteria = AI_EDIT_CRITERIA.map((id) => ({ id, passed: true, reason: "충족" }));
const pixelEdit = {
  summary: "픽셀 편집",
  actions: [{ tool: "fill" as const, points: [{ x: 0, y: 0 }], color: [255, 0, 0, 255] as RGBA }],
};
const repairEdit = {
  summary: "판정 피드백 수정",
  actions: [{ tool: "pencil" as const, points: [{ x: 1, y: 0 }], color: [0, 0, 255, 255] as RGBA }],
};
const passVerdict: AiEditVerdict = {
  verdict: "pass",
  summary: "모든 기준 통과",
  criteria: passingCriteria,
  corrections: [],
};
const failVerdict: AiEditVerdict = {
  verdict: "fail",
  summary: "요청 반영 부족",
  criteria: [{ ...passingCriteria[0], passed: false, reason: "요청한 변화가 부족함" }, ...passingCriteria.slice(1)],
  corrections: [{
    criterion: "request_fulfillment",
    region: "대상 셀 중앙",
    problem: "변화가 작음",
    requiredChange: "요청한 색 영역을 넓힐 것",
  }],
};

async function storedProjectBytes(projectRoot: string): Promise<Record<string, Buffer>> {
  const manifest = await readFile(join(projectRoot, "pixelforge.json"));
  const stored = JSON.parse(manifest.toString("utf8")) as { document: { images: Record<string, { file: string }> } };
  return Object.fromEntries(await Promise.all([
    ["pixelforge.json", manifest] as const,
    ...Object.values(stored.document.images).map(async ({ file }) => [file, await readFile(join(projectRoot, file))] as const),
  ]));
}

async function cellEditFixture(cellEditApplicationTimeoutMs?: number) {
  const root = await mkdtemp(join(tmpdir(), "pixelforge-cell-review-"));
  const project = threeFrameProject();
  const projectRoot = join(root, project.id);
  await createProject(projectRoot, project);
  const before = await loadProject(projectRoot);
  const beforeBytes = await storedProjectBytes(projectRoot);
  const request = cellEditRequest(project);
  const codex = new FakeCodex();
  const { server, base, token } = await startGenerationServer(root, codex, codex, cellEditApplicationTimeoutMs);
  const headers = { "content-type": "application/json", "x-pixelforge-token": token };
  const startEdit = async () => {
    const response = await fetch(`${base}/api/edits`, {
      method: "POST",
      headers,
      body: JSON.stringify({ projectId: project.id, request }),
    });
    assert.equal(response.status, 202);
    return await response.json() as CellEditWire;
  };
  const getEdit = (id: string) => fetch(`${base}/api/edits/${id}`).then((response) => response.json()) as Promise<CellEditWire>;
  const waitForStatus = async (id: string, status: CellEditWire["status"]) => {
    for (let count = 0; count < 50; count += 1) {
      const job = await getEdit(id);
      if (job.status === status) return job;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`셀 편집 작업이 ${status} 상태가 되지 않았습니다.`);
  };
  const readLog = async (job: Pick<CellEditWire, "logPath">, name: string) => {
    assert.ok(job.logPath);
    return readFile(join(projectRoot, job.logPath, name));
  };
  const close = async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  };
  return { root, projectRoot, before, beforeBytes, request, codex, base, headers, startEdit, getEdit, waitForStatus, readLog, close };
}

async function readyCellEdit(fixture: Awaited<ReturnType<typeof cellEditFixture>>) {
  const job = await fixture.startEdit();
  await fixture.codex.completeResult(pixelEdit, "judging");
  await fixture.codex.completeResult(passVerdict);
  return fixture.waitForStatus(job.id, "finalizing");
}

test("선택 프레임 생성은 역할별 PNG를 제공하고 선택 프레임만 교체한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixelforge-frame-generation-"));
  const project = threeFrameProject();
  const projectRoot = join(root, project.id);
  await createProject(projectRoot, project);
  await mkdir(join(projectRoot, "references"));
  await writeFile(join(projectRoot, "references", "hero.png"), encodePng(1, 1, new Uint8ClampedArray([255, 255, 255, 255])));
  const before = await loadProject(projectRoot);
  const beforeFrames = before.document.frames.map((frame) => Array.from(compositeFrame(before.document, frame.id).data));
  const codex = new FakeCodex();
  const { server, base, token } = await startGenerationServer(root, codex);

  try {
    const frameId = project.document.frames[1].id;
    const response = await fetch(`${base}/api/generations`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pixelforge-token": token },
      body: JSON.stringify({
        projectId: project.id,
        frameId,
        request: { prompt: "검 공격", frameCount: 3, columns: 3, cellWidth: 2, cellHeight: 1, durationMs: 100, referencePath: "references/hero.png" },
      }),
    });
    assert.equal(response.status, 202);
    const job = await response.json() as { id: string; status: string; frameId?: string };
    assert.equal(job.frameId, frameId);
    assert.match(codex.lastPrompt, /선택 프레임: 2\/3/);
    assert.match(codex.lastPrompt, /캐릭터 외형과 팔레트.*references[\\/]hero\.png/);
    assert.match(codex.lastPrompt, /첫 프레임 참조:/);
    assert.match(codex.lastPrompt, /이전 프레임 참조:/);
    assert.match(codex.lastPrompt, /다음 프레임 참조:/);

    const firstPath = pathFromPrompt(codex.lastPrompt, "첫 프레임 참조");
    const previousPath = pathFromPrompt(codex.lastPrompt, "이전 프레임 참조");
    const nextPath = pathFromPrompt(codex.lastPrompt, "다음 프레임 참조");
    assert.notEqual(firstPath, previousPath);
    assert.deepEqual(Array.from(decodePng(await readFile(firstPath)).data), beforeFrames[0]);
    assert.deepEqual(Array.from(decodePng(await readFile(previousPath)).data), beforeFrames[0]);
    assert.deepEqual(Array.from(decodePng(await readFile(nextPath)).data), beforeFrames[2]);

    const outputPath = pathFromPrompt(codex.lastPrompt, "결과를 반드시 다음 경로에 저장하세요");
    const regenerated = new Uint8ClampedArray([255, 255, 0, 255, 255, 255, 0, 255]);
    await writeFile(outputPath, encodePng(2, 1, regenerated));
    codex.event({ type: "completed", runId: "run-1", status: "completed" });
    assert.equal((await waitForJob(base, job.id)).status, "completed");

    const saved = await loadProject(projectRoot);
    assert.deepEqual(saved.document.frames, before.document.frames);
    assert.deepEqual(saved.document.layers, before.document.layers);
    assert.deepEqual(saved.document.tags, before.document.tags);
    assert.deepEqual(saved.document.palette, before.document.palette);
    assert.deepEqual(saved.generationHistory, before.generationHistory);
    assert.deepEqual(Array.from(compositeFrame(saved.document, saved.document.frames[0].id).data), beforeFrames[0]);
    assert.deepEqual(Array.from(compositeFrame(saved.document, saved.document.frames[1].id).data), Array.from(regenerated));
    assert.deepEqual(Array.from(compositeFrame(saved.document, saved.document.frames[2].id).data), beforeFrames[2]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("첫·마지막 프레임은 존재하는 참조만 만들고 취소 시 프로젝트를 보존한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixelforge-frame-boundary-"));
  const project = threeFrameProject();
  const projectRoot = join(root, project.id);
  await createProject(projectRoot, project);
  const before = JSON.stringify(await loadProject(projectRoot));
  const codex = new FakeCodex();
  const { server, base, token } = await startGenerationServer(root, codex);
  const start = (frameId: string) => fetch(`${base}/api/generations`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-pixelforge-token": token },
    body: JSON.stringify({
      projectId: project.id,
      frameId,
      request: { prompt: "경계 검사", frameCount: 3, columns: 3, cellWidth: 2, cellHeight: 1, durationMs: 100 },
    }),
  });

  try {
    const first = await (await start(project.document.frames[0].id)).json() as { id: string };
    assert.match(codex.lastPrompt, /첫 프레임 참조:/);
    assert.doesNotMatch(codex.lastPrompt, /이전 프레임 참조:/);
    assert.match(codex.lastPrompt, /다음 프레임 참조:/);
    await fetch(`${base}/api/generations/${first.id}`, { method: "DELETE", headers: { "x-pixelforge-token": token } });

    const last = await (await start(project.document.frames[2].id)).json() as { id: string };
    assert.match(codex.lastPrompt, /첫 프레임 참조:/);
    assert.match(codex.lastPrompt, /이전 프레임 참조:/);
    assert.doesNotMatch(codex.lastPrompt, /다음 프레임 참조:/);
    const cancelled = await fetch(`${base}/api/generations/${last.id}`, { method: "DELETE", headers: { "x-pixelforge-token": token } });
    assert.equal(cancelled.status, 200);
    assert.equal(JSON.stringify(await loadProject(projectRoot)), before);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("잘못된 선택 프레임 결과는 실패하고 저장 프로젝트를 변경하지 않는다", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixelforge-frame-failure-"));
  const project = threeFrameProject();
  const projectRoot = join(root, project.id);
  await createProject(projectRoot, project);
  const before = JSON.stringify(await loadProject(projectRoot));
  const codex = new FakeCodex();
  const { server, base, token } = await startGenerationServer(root, codex);

  try {
    const response = await fetch(`${base}/api/generations`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pixelforge-token": token },
      body: JSON.stringify({
        projectId: project.id,
        frameId: project.document.frames[1].id,
        request: { prompt: "실패 검사", frameCount: 3, columns: 3, cellWidth: 2, cellHeight: 1, durationMs: 100 },
      }),
    });
    const job = await response.json() as { id: string };
    await writeFile(pathFromPrompt(codex.lastPrompt, "결과를 반드시 다음 경로에 저장하세요"), encodePng(1, 1, new Uint8ClampedArray(4)));
    codex.event({ type: "completed", runId: "run-1", status: "completed" });
    const failed = await waitForJob(base, job.id);
    assert.equal(failed.status, "failed");
    assert.match(failed.error ?? "", /크기/);
    assert.equal(JSON.stringify(await loadProject(projectRoot)), before);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("완료된 생성의 결과 파일이 없으면 Codex 메시지를 포함해 실패하고 프로젝트를 보존한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixelforge-missing-generation-output-"));
  const project = threeFrameProject();
  const projectRoot = join(root, project.id);
  await createProject(projectRoot, project);
  const before = JSON.stringify(await loadProject(projectRoot));
  const codex = new FakeCodex();
  const { server, base, token } = await startGenerationServer(root, codex);

  const start = () => fetch(`${base}/api/generations`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-pixelforge-token": token },
    body: JSON.stringify({
      projectId: project.id,
      request: { prompt: "전체 재생성", frameCount: 3, columns: 3, cellWidth: 2, cellHeight: 1, durationMs: 100 },
    }),
  });

  try {
    const response = await start();
    assert.equal(response.status, 202);
    const job = await response.json() as { id: string };
    codex.event({ type: "message", runId: "run-1", text: "참조 이미지가 첨부되지 않았습니다. " });
    codex.event({ type: "message", runId: "run-1", text: "이미지를 첨부해 주세요." });
    codex.event({ type: "completed", runId: "run-1", status: "completed" });

    const failed = await waitForJob(base, job.id);
    assert.equal(failed.status, "failed");
    assert.match(failed.error ?? "", /^Codex가 결과 이미지를 생성하지 않았습니다\./);
    assert.match(failed.error ?? "", /참조 이미지가 첨부되지 않았습니다\. 이미지를 첨부해 주세요\./);
    assert.doesNotMatch(failed.error ?? "", /ENOENT|generated[\\/]|sheet\.png/);
    assert.equal(JSON.stringify(await loadProject(projectRoot)), before);

    const retry = await start();
    assert.equal(retry.status, 202);
    const retryJob = await retry.json() as { id: string };
    await fetch(`${base}/api/generations/${retryJob.id}`, { method: "DELETE", headers: { "x-pixelforge-token": token } });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("빈 frameId는 전체 시트 생성으로 폴백하지 않는다", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixelforge-empty-frame-"));
  const project = threeFrameProject();
  await createProject(join(root, project.id), project);
  const codex = new FakeCodex();
  const { server, base, token } = await startGenerationServer(root, codex);

  try {
    const response = await fetch(`${base}/api/generations`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pixelforge-token": token },
      body: JSON.stringify({
        projectId: project.id,
        frameId: "",
        request: { prompt: "잘못된 선택", frameCount: 3, columns: 3, cellWidth: 2, cellHeight: 1, durationMs: 100 },
      }),
    });
    assert.equal(response.status, 400);
    assert.equal(codex.lastPrompt, "");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("배열 frameId는 문자열 선택으로 변환하지 않고 거부한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixelforge-array-frame-"));
  const project = threeFrameProject();
  await createProject(join(root, project.id), project);
  const codex = new FakeCodex();
  const { server, base, token } = await startGenerationServer(root, codex);

  try {
    const response = await fetch(`${base}/api/generations`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pixelforge-token": token },
      body: JSON.stringify({
        projectId: project.id,
        frameId: [project.document.frames[1].id],
        request: { prompt: "잘못된 타입", frameCount: 3, columns: 3, cellWidth: 2, cellHeight: 1, durationMs: 100 },
      }),
    });
    assert.equal(response.status, 400);
    assert.match(((await response.json()) as { error: string }).error, /프레임 ID.*문자열/);
    assert.equal(codex.lastPrompt, "");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("로컬 API는 세션 토큰으로 프로젝트 생성과 Codex 결과 가져오기를 보호한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixelforge-server-"));
  const staticRoot = join(root, "static");
  await mkdir(staticRoot);
  await writeFile(join(staticRoot, "index.html"), "<!doctype html><title>PixelForge Smoke</title>");
  const codex = new FakeCodex();
  const server = createPixelForgeServer({ projectsRoot: root, codex, staticRoot });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    assert.match(await fetch(base).then((response) => response.text()), /PixelForge Smoke/);
    assert.equal((await fetch(`${base}/api/session`, { headers: { origin: "https://example.com" } })).status, 403);
    const session = await fetch(`${base}/api/session`).then((response) => response.json()) as {
      token: string;
      account: { account: { type: string } };
    };
    assert.equal(session.account.account.type, "chatgpt");

    const denied = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "기사", width: 1, height: 1 }),
    });
    assert.equal(denied.status, 403);

    const createdResponse = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pixelforge-token": session.token },
      body: JSON.stringify({ name: "기사", width: 1, height: 1 }),
    });
    assert.equal(createdResponse.status, 201);
    const project = await createdResponse.json() as { id: string; document: { images: Record<string, { data: number[] }> } };
    assert.equal(Array.isArray(Object.values(project.document.images)[0].data), true);

    const referenceResponse = await fetch(`${base}/api/references`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pixelforge-token": session.token },
      body: JSON.stringify({ projectId: project.id, pngBase64: encodePng(1, 1, new Uint8ClampedArray(4)).toString("base64") }),
    });
    assert.equal(referenceResponse.status, 201);
    assert.match(((await referenceResponse.json()) as { path: string }).path, /^references\//);

    const importResponse = await fetch(`${base}/api/imports`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pixelforge-token": session.token },
      body: JSON.stringify({
        projectId: project.id,
        pngBase64: encodePng(2, 1, new Uint8ClampedArray(8)).toString("base64"),
        request: { prompt: "직접 가져오기", frameCount: 2, columns: 2, cellWidth: 1, cellHeight: 1, durationMs: 100 },
      }),
    });
    assert.equal(importResponse.status, 200);
    assert.equal(((await importResponse.json()) as { document: { frames: unknown[] } }).document.frames.length, 2);

    const exportResponse = await fetch(`${base}/api/exports`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pixelforge-token": session.token },
      body: JSON.stringify({
        projectId: project.id,
        target: "common",
        options: { columns: 2, padding: 0, margin: 0, trim: false, pixelsPerUnit: 100, pivot: { x: 0.5, y: 0.5 } },
      }),
    });
    assert.equal(exportResponse.status, 201);
    const exported = await exportResponse.json() as { outputPath: string; files: string[] };
    assert.deepEqual(exported.files, ["spritesheet.png", "spritesheet.json"]);
    assert.equal(JSON.parse(await readFile(join(root, project.id, "exports", "common", "spritesheet.json"), "utf8")).meta.app, "PixelForge");

    const generationResponse = await fetch(`${base}/api/generations`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pixelforge-token": session.token },
      body: JSON.stringify({
        projectId: project.id,
        request: { prompt: "검 휘두르기", frameCount: 2, columns: 2, cellWidth: 1, cellHeight: 1, durationMs: 90 },
      }),
    });
    assert.equal(generationResponse.status, 202);
    const job = await generationResponse.json() as { id: string };
    const outputPath = codex.lastPrompt.match(/결과를 반드시 다음 경로에 저장하세요: (.+)$/m)?.[1];
    assert.ok(outputPath);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, encodePng(2, 1, new Uint8ClampedArray([
      255, 0, 0, 255,
      0, 255, 0, 255,
    ])));
    codex.event({ type: "completed", runId: "run-1", status: "completed" });

    let completed: { status: string; project?: { document: { frames: unknown[] } } } | undefined;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      completed = await fetch(`${base}/api/generations/${job.id}`).then((response) => response.json()) as typeof completed;
      if (completed && !["running", "finalizing"].includes(completed.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(completed?.status, "completed");
    assert.equal(completed?.project?.document.frames.length, 2);

    const savedProject = await fetch(`${base}/api/projects/${project.id}`).then((response) => response.json());
    const invalidExport = await fetch(`${base}/api/exports`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pixelforge-token": session.token },
      body: JSON.stringify({ projectId: project.id, target: "invalid", options: {} }),
    });
    assert.equal(invalidExport.status, 400);
    const saveAfterInvalidExport = await fetch(`${base}/api/projects/${project.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-pixelforge-token": session.token },
      body: JSON.stringify(savedProject),
    });
    assert.equal(saveAfterInvalidExport.status, 200);

    codex.approvalDuringStart = true;
    const startGeneration = () => fetch(`${base}/api/generations`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pixelforge-token": session.token },
      body: JSON.stringify({ projectId: project.id, request: { prompt: "연결 종료 검사", frameCount: 1, columns: 1, cellWidth: 1, cellHeight: 1, durationMs: 100 } }),
    });
    const generationResponses = await Promise.all([startGeneration(), startGeneration()]);
    assert.deepEqual(generationResponses.map((response) => response.status).sort(), [202, 409]);
    const disconnectedResponse = generationResponses.find((response) => response.status === 202)!;
    const disconnectedJob = await disconnectedResponse.json() as { id: string; status: string };
    assert.equal(disconnectedJob.status, "awaitingApproval");

    const lockedProject = await fetch(`${base}/api/projects/${project.id}`).then((response) => response.json());
    const lockedSave = await fetch(`${base}/api/projects/${project.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-pixelforge-token": session.token },
      body: JSON.stringify(lockedProject),
    });
    assert.equal(lockedSave.status, 409);

    const lockedImport = await fetch(`${base}/api/imports`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pixelforge-token": session.token },
      body: JSON.stringify({ projectId: project.id, pngBase64: encodePng(1, 1, new Uint8ClampedArray(4)).toString("base64"), request: { prompt: "잠금 검사", frameCount: 1, columns: 1, cellWidth: 1, cellHeight: 1, durationMs: 100 } }),
    });
    assert.equal(lockedImport.status, 409);

    const lockedExport = await fetch(`${base}/api/exports`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pixelforge-token": session.token },
      body: JSON.stringify({ projectId: project.id, target: "common", options: { columns: 1, padding: 0, margin: 0, trim: false, pixelsPerUnit: 100, pivot: { x: 0.5, y: 0.5 } } }),
    });
    assert.equal(lockedExport.status, 409);

    let releaseInterrupt!: () => void;
    codex.interruptWait = new Promise<void>((resolve) => { releaseInterrupt = resolve; });
    const approvalRequest = fetch(`${base}/api/approvals`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pixelforge-token": session.token },
      body: JSON.stringify({ jobId: disconnectedJob.id, accept: false }),
    });
    await waitUntil(() => codex.interrupts.length > 0, "생성 중단 요청이 시작되지 않았습니다.");
    const saveDuringInterrupt = await fetch(`${base}/api/projects/${project.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-pixelforge-token": session.token },
      body: JSON.stringify(lockedProject),
    });
    assert.equal(saveDuringInterrupt.status, 409);
    releaseInterrupt();
    const approvalResponse = await approvalRequest;
    assert.equal(approvalResponse.status, 200);
    assert.deepEqual(codex.responses.at(-1), { id: 77, result: { decision: "decline" } });
    assert.deepEqual(codex.interrupts, ["run-2"]);
    codex.event({ type: "approval", requestId: 78, method: "item/fileChange/requestApproval", params: { threadId: "thread-2", turnId: "run-2" }, runId: "run-2", threadId: "thread-2" });
    assert.deepEqual(codex.responses.at(-1), { id: 78, result: { decision: "decline" } });
    const cancelled = await fetch(`${base}/api/generations/${disconnectedJob.id}`).then((response) => response.json()) as { status: string };
    assert.equal(cancelled.status, "cancelled");

    codex.approvalDuringStart = false;
    codex.interruptWait = undefined;
    codex.interruptError = new Error("interrupt timeout");
    const interruptFailureResponse = await startGeneration();
    const interruptFailureJob = await interruptFailureResponse.json() as { id: string };
    const failedCancel = await fetch(`${base}/api/generations/${interruptFailureJob.id}`, {
      method: "DELETE",
      headers: { "x-pixelforge-token": session.token },
    });
    assert.equal(failedCancel.status, 400);
    const failedCancellation = await fetch(`${base}/api/generations/${interruptFailureJob.id}`).then((response) => response.json()) as { status: string };
    assert.equal(failedCancellation.status, "failed");
    const saveAfterInterruptFailure = await fetch(`${base}/api/projects/${project.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-pixelforge-token": session.token },
      body: JSON.stringify(lockedProject),
    });
    assert.equal(saveAfterInterruptFailure.status, 200);

    codex.interruptError = undefined;
    const finalResponse = await startGeneration();
    const finalJob = await finalResponse.json() as { id: string };
    codex.event({ type: "error", message: "Codex 연결 종료" });
    const disconnected = await fetch(`${base}/api/generations/${finalJob.id}`).then((response) => response.json()) as { status: string; error: string };
    assert.equal(disconnected.status, "failed");
    assert.equal(disconnected.error, "Codex 연결 종료");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("첫 픽셀 후보가 합격하면 한 번만 편집·판정하고 적용 확인을 기다린다", async () => {
  const fixture = await cellEditFixture();
  try {
    const first = await fixture.startEdit();
    assert.equal(first.kind, "cellEdit");
    assert.equal(first.phase, "editing");
    assert.equal(first.attempt, 1);
    assert.equal(first.maxAttempts, 6);
    assert.ok(first.logPath);
    assert.deepEqual(fixture.codex.lastCellEdit?.outputSchema, AI_EDIT_OUTPUT_SCHEMA);
    assert.deepEqual(
      Array.from(decodePng(await readFile(fixture.codex.lastCellEdit!.originalCompositePath)).data),
      Array.from(compositeFrame(fixture.before.document, fixture.request.target.frameId).data),
    );
    assert.deepEqual(
      Array.from(decodePng(await readFile(fixture.codex.lastCellEdit!.originalCelPath)).data),
      Array.from(activeCelFrame(fixture.before.document, fixture.request.target).data),
    );

    await fixture.codex.completeResult(pixelEdit, "judging");
    assert.deepEqual(fixture.codex.judgments[0].outputSchema, AI_EDIT_VERDICT_OUTPUT_SCHEMA);
    await fixture.codex.completeResult(passVerdict);
    const ready = await fixture.waitForStatus(first.id, "finalizing");
    assert.equal(ready.phase, "judging");
    assert.equal(ready.attempt, 1);
    assert.equal(ready.maxAttempts, 6);
    assert.equal(fixture.codex.cellEdits.length, 1);
    assert.equal(fixture.codex.judgments.length, 1);
    assert.equal(ready.result?.direct, false);
    assert.equal(ready.result?.acceptedAttempt, 1);
    assert.deepEqual(JSON.parse(await fixture.readLog(ready, "attempt-01-verdict.json").then((value) => value.toString("utf8"))), passVerdict);
    const { selection: _selection, ...editorSettings } = fixture.request.settings;
    const replay = runAiEditAttempts(
      { document: fixture.before.document, ...editorSettings },
      fixture.request.target,
      ready.result!.attempts,
    );
    const loggedCel = decodePng(await fixture.readLog(ready, "attempt-01-cel.png"));
    assert.deepEqual(Array.from(activeCelFrame(replay.document, fixture.request.target).data), Array.from(loggedCel.data));
    for (const internal of ["request", "project", "runId", "resultText", "resultConflict", "activeRun", "tempDir", "timer", "log"]) {
      assert.equal(internal in ready, false);
    }
    assert.equal(JSON.stringify(await loadProject(fixture.projectRoot)), JSON.stringify(fixture.before));
    assert.equal((await fetch(`${fixture.base}/api/generations/${first.id}`)).status, 404);
  } finally {
    await fixture.close();
  }
});

test("불합격 피드백으로 직전 후보를 재편집한 뒤 합격한다", async () => {
  const fixture = await cellEditFixture();
  try {
    const retried = await fixture.startEdit();
    await fixture.codex.completeResult(pixelEdit, "judging");
    await fixture.codex.completeResult(failVerdict, "editing");
    const firstEdit = fixture.codex.cellEdits[0];
    const retryEdit = fixture.codex.cellEdits[1];
    assert.equal(retryEdit.originalCompositePath, firstEdit.originalCompositePath);
    assert.equal(retryEdit.originalCelPath, firstEdit.originalCelPath);
    assert.equal(basename(retryEdit.candidateCompositePath), "attempt-01-composite.png");
    assert.equal(basename(retryEdit.candidateCelPath), "attempt-01-cel.png");
    assert.match(retryEdit.prompt, /직전 판정 피드백:/);
    assert.match(retryEdit.prompt, new RegExp(failVerdict.summary));
    assert.equal(retryEdit.prompt.match(/직전 판정 피드백:/g)?.length, 1);

    await fixture.codex.completeResult(repairEdit, "judging");
    await fixture.codex.completeResult(passVerdict);
    const ready = await fixture.waitForStatus(retried.id, "finalizing");
    assert.equal(ready.attempt, 2);
    assert.equal(ready.result?.attempts.length, 2);
    assert.equal(ready.result?.actionCount, 2);
    assert.deepEqual(fixture.codex.runs.map(({ role }) => role), ["editing", "judging", "editing", "judging"]);
  } finally {
    await fixture.close();
  }
});

test("여섯 후보가 모두 불합격이면 결과 없이 실패한다", async () => {
  const fixture = await cellEditFixture();
  try {
    const exhausted = await fixture.startEdit();
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      await fixture.codex.completeResult(pixelEdit, "judging");
      await fixture.codex.completeResult(failVerdict, attempt < 6 ? "editing" : undefined);
    }
    const failed = await fixture.waitForStatus(exhausted.id, "failed");
    assert.match(failed.error ?? "", /6회 판정이 모두 불합격/);
    assert.equal(failed.result, undefined);
    assert.equal(fixture.codex.cellEdits.length, 6);
    assert.equal(fixture.codex.judgments.length, 6);
    const summary = JSON.parse(await fixture.readLog(failed, "summary.json").then((value) => value.toString("utf8")));
    assert.equal(summary.outcome, "quality_failed");
    assert.equal(summary.attemptCount, 6);
  } finally {
    await fixture.close();
  }
});

test("빈 동작도 변경 없는 후보로 판정한다", async () => {
  const fixture = await cellEditFixture();
  try {
    const job = await fixture.startEdit();
    await fixture.codex.completeResult({ summary: "변경 없음", actions: [] }, "judging");
    assert.equal(fixture.codex.judgments.length, 1);
    await fixture.codex.completeResult(passVerdict);
    const ready = await fixture.waitForStatus(job.id, "finalizing");
    assert.equal(ready.result?.direct, false);
    assert.equal(ready.result?.acceptedAttempt, 1);
  } finally {
    await fixture.close();
  }
});

test("최초 선택 전용 결과는 판정 없이 직접 적용 대기로 이동한다", async () => {
  const fixture = await cellEditFixture();
  try {
    const job = await fixture.startEdit();
    await fixture.codex.completeResult({ summary: "선택", actions: [{ tool: "select", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }] });
    const direct = await fixture.waitForStatus(job.id, "finalizing");
    assert.equal(direct.result?.direct, true);
    assert.equal(direct.result?.acceptedAttempt, undefined);
    assert.equal(direct.result?.attempts.length, 1);
    assert.equal(fixture.codex.judgments.length, 0);
    await assert.rejects(fixture.readLog(direct, "attempt-01-composite.png"), { code: "ENOENT" });
  } finally {
    await fixture.close();
  }
});

test("불합격 픽셀 후보 뒤 비픽셀 재편집은 현재 후보를 다시 판정한다", async () => {
  const fixture = await cellEditFixture();
  try {
    const job = await fixture.startEdit();
    await fixture.codex.completeResult(pixelEdit, "judging");
    await fixture.codex.completeResult(failVerdict, "editing");
    await fixture.codex.completeResult({ summary: "선택 조정", actions: [{ tool: "eyedropper", points: [{ x: 0, y: 0 }] }] }, "judging");
    assert.equal(fixture.codex.judgments.length, 2);
    await fixture.codex.completeResult(passVerdict);
    const ready = await fixture.waitForStatus(job.id, "finalizing");
    assert.equal(ready.result?.direct, false);
    assert.equal(ready.result?.acceptedAttempt, 2);
  } finally {
    await fixture.close();
  }
});

test("판정 불변식 위반은 품질 실패가 아닌 기술 실패로 끝난다", async () => {
  const fixture = await cellEditFixture();
  try {
    const job = await fixture.startEdit();
    await fixture.codex.completeResult(pixelEdit, "judging");
    await fixture.codex.completeResult({ ...passVerdict, criteria: [{ ...passingCriteria[0], passed: false }, ...passingCriteria.slice(1)] });
    const failed = await fixture.waitForStatus(job.id, "failed");
    assert.match(failed.error ?? "", /모든 기준/);
    assert.equal(fixture.codex.cellEdits.length, 1);
    assert.equal(fixture.codex.judgments.length, 1);
    assert.equal(JSON.parse(await fixture.readLog(failed, "summary.json").then((value) => value.toString("utf8"))).outcome, "technical_error");
  } finally {
    await fixture.close();
  }
});

test("초기 로그를 만들 수 없어도 Codex 호출 없이 추적 가능한 실패 작업을 반환한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixelforge-cell-edit-initial-log-failure-"));
  const project = threeFrameProject();
  const projectRoot = join(root, project.id);
  await createProject(projectRoot, project);
  await mkdir(join(projectRoot, "generated"), { recursive: true });
  await writeFile(join(projectRoot, "generated", "cell-edit-logs"), "occupied");
  const codex = new FakeCodex();
  const { server, base, token } = await startGenerationServer(root, codex);
  try {
    const response = await fetch(`${base}/api/edits`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pixelforge-token": token },
      body: JSON.stringify({ projectId: project.id, request: cellEditRequest(project) }),
    });
    assert.equal(response.status, 202);
    const failed = await response.json() as CellEditWire;
    assert.equal(failed.status, "failed");
    assert.match(failed.logPath ?? "", /^generated\/cell-edit-logs\/[0-9a-f-]{36}$/);
    assert.match(failed.error ?? "", new RegExp(`부분 로그: ${failed.logPath}`));
    assert.equal(codex.cellEdits.length, 0);
    assert.equal((await fetch(`${base}/api/edits/${failed.id}`).then((value) => value.json()) as CellEditWire).status, "failed");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("판정 로그 쓰기 실패는 결과 반환을 차단하고 terminal summary를 남긴다", async () => {
  const fixture = await cellEditFixture();
  try {
    const job = await fixture.startEdit();
    await fixture.codex.completeResult(pixelEdit, "judging");
    await mkdir(join(fixture.projectRoot, job.logPath!, "attempt-01-verdict.json"));
    await fixture.codex.completeResult(passVerdict);
    const failed = await fixture.waitForStatus(job.id, "failed");
    assert.doesNotMatch(failed.error ?? "", /부분 로그/);
    assert.equal(failed.result, undefined);
    assert.equal(fixture.codex.cellEdits.length, 1);
    assert.equal(fixture.codex.judgments.length, 1);
    assert.equal(JSON.parse(await fixture.readLog(failed, "summary.json").then((value) => value.toString("utf8"))).outcome, "technical_error");
  } finally {
    await fixture.close();
  }
});

test("셀 편집 bridge가 없으면 요청 본문보다 먼저 기능 불가로 거부한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixelforge-cell-edit-missing-bridge-"));
  const codex = new FakeCodex();
  const server = createPixelForgeServer({ projectsRoot: root, codex });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { token } = await fetch(`${base}/api/session`).then((response) => response.json()) as { token: string };

  try {
    const response = await fetch(`${base}/api/edits`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pixelforge-token": token },
      body: "{}",
    });
    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as { error: string }).error, "설치된 Codex App Server에서 현재 셀 편집을 사용할 수 없습니다.");
    assert.equal(codex.lastCellEdit, undefined);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("첫 편집 실행 실패는 추적 가능한 기술 실패로 남고 일반 생성 bridge를 막지 않는다", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixelforge-cell-edit-unavailable-"));
  const project = threeFrameProject();
  const projectRoot = join(root, project.id);
  await createProject(projectRoot, project);
  const codex = new FakeCodex();
  const cellEditCodex = new FakeCodex();
  cellEditCodex.cellEditError = new Error("설치된 Codex App Server에서 현재 셀 편집을 사용할 수 없습니다.");
  const { server, base, token } = await startGenerationServer(root, codex, cellEditCodex);

  try {
    const edit = await fetch(`${base}/api/edits`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pixelforge-token": token },
      body: JSON.stringify({ projectId: project.id, request: cellEditRequest(project) }),
    });
    assert.equal(edit.status, 202);
    const failed = await edit.json() as CellEditWire;
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "설치된 Codex App Server에서 현재 셀 편집을 사용할 수 없습니다.");
    assert.ok(failed.logPath);
    assert.equal(JSON.parse(await readFile(join(projectRoot, failed.logPath, "summary.json"), "utf8")).outcome, "technical_error");
    assert.equal(codex.lastCellEdit, undefined);

    const generation = await fetch(`${base}/api/generations`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pixelforge-token": token },
      body: JSON.stringify({ projectId: project.id, request: { prompt: "일반 생성", frameCount: 1, columns: 1, cellWidth: 2, cellHeight: 1, durationMs: 100 } }),
    });
    assert.equal(generation.status, 202);
    assert.match(codex.lastPrompt, /일반 생성/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("분리된 bridge의 동일 run ID 이벤트와 중단은 각 작업에만 적용된다", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixelforge-cell-edit-bridge-routing-"));
  const generationProject = threeFrameProject();
  const editProject = threeFrameProject();
  const cancelProject = threeFrameProject();
  await createProject(join(root, generationProject.id), generationProject);
  await createProject(join(root, editProject.id), editProject);
  await createProject(join(root, cancelProject.id), cancelProject);
  const codex = new FakeCodex();
  const cellEditCodex = new FakeCodex();
  const { server, base, token } = await startGenerationServer(root, codex, cellEditCodex);

  try {
    const generation = await (await fetch(`${base}/api/generations`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pixelforge-token": token },
      body: JSON.stringify({ projectId: generationProject.id, request: { prompt: "충돌 검사", frameCount: 1, columns: 1, cellWidth: 2, cellHeight: 1, durationMs: 100 } }),
    })).json() as { id: string };
    const edit = await (await fetch(`${base}/api/edits`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pixelforge-token": token },
      body: JSON.stringify({ projectId: editProject.id, request: cellEditRequest(editProject) }),
    })).json() as { id: string };
    assert.equal(codex.lastRunId, "run-1");
    assert.equal(cellEditCodex.lastRunId, "run-1");

    codex.event({ type: "result", runId: "run-1", text: JSON.stringify({ summary: "잘못된 bridge 결과", actions: [] }) });
    codex.event({ type: "error", message: "일반 생성 연결 종료" });
    assert.equal((await waitForJob(base, generation.id)).status, "failed");
    assert.equal(((await fetch(`${base}/api/edits/${edit.id}`).then((response) => response.json())) as { status: string }).status, "running");

    cellEditCodex.event({ type: "result", runId: "run-1", text: JSON.stringify({ summary: "선택", actions: [{ tool: "select", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }] }) });
    cellEditCodex.event({ type: "completed", runId: "run-1", status: "completed" });
    assert.equal((await waitForCellEditStatus(base, edit.id, "finalizing")).status, "finalizing");

    const cancellable = await (await fetch(`${base}/api/edits`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pixelforge-token": token },
      body: JSON.stringify({ projectId: cancelProject.id, request: cellEditRequest(cancelProject) }),
    })).json() as { id: string };
    assert.equal((await fetch(`${base}/api/edits/${cancellable.id}`, { method: "DELETE", headers: { "x-pixelforge-token": token } })).status, 200);
    assert.deepEqual(cellEditCodex.interrupts, ["run-2"]);
    assert.deepEqual(codex.interrupts, []);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("run 연결 전에 온 셀 편집 이벤트를 순서대로 한 번씩 재생한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixelforge-cell-edit-early-"));
  const projects = [threeFrameProject(), threeFrameProject(), threeFrameProject()];
  for (const project of projects) await createProject(join(root, project.id), project);
  const codex = new FakeCodex();
  const { server, base, token } = await startGenerationServer(root, codex);
  const start = (project: ReturnType<typeof threeFrameProject>) => fetch(`${base}/api/edits`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-pixelforge-token": token },
    body: JSON.stringify({ projectId: project.id, request: cellEditRequest(project) }),
  });

  try {
    const direct = JSON.stringify({ summary: "선택", actions: [{ tool: "select", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }] });
    codex.cellEditEventsDuringStart = [
      { type: "result", runId: "early", text: direct },
      { type: "completed", runId: "early", status: "completed" },
    ];
    const completedStart = await (await start(projects[0])).json() as { id: string };
    assert.equal((await waitForCellEditStatus(base, completedStart.id, "finalizing")).status, "finalizing");

    codex.cellEditEventsDuringStart = [
      { type: "approval", requestId: 91, method: "item/fileChange/requestApproval", params: {}, runId: "early" },
      { type: "completed", runId: "early", status: "completed" },
    ];
    const approvalStart = await (await start(projects[1])).json() as { id: string };
    assert.equal((await waitForJob(base, approvalStart.id, "edits")).status, "failed");
    assert.deepEqual(codex.responses.at(-1), { id: 91, result: { decision: "decline" } });

    codex.cellEditEventsDuringStart = [
      { type: "toolAttempt", runId: "early", tool: "commandExecution" },
      { type: "completed", runId: "early", status: "completed" },
    ];
    const toolStart = await (await start(projects[2])).json() as { id: string };
    assert.equal((await waitForJob(base, toolStart.id, "edits")).status, "failed");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("셀 편집은 잘못된 대상과 잠금을 시작 전에 거부하고 프로젝트 단위로 직렬화한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixelforge-cell-edit-reject-"));
  const project = threeFrameProject();
  await createProject(join(root, project.id), project);
  const request = cellEditRequest(project);
  const codex = new FakeCodex();
  const { server, base, token } = await startGenerationServer(root, codex);
  const post = (editRequest: AiEditRequest) => fetch(`${base}/api/edits`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-pixelforge-token": token },
    body: JSON.stringify({ projectId: project.id, request: editRequest }),
  });

  try {
    assert.equal((await post({ ...request, target: { ...request.target, celId: "missing" } })).status, 400);
    assert.equal(codex.lastCellEdit, undefined);
    const saved = await loadProject(join(root, project.id));
    saved.document.layers[0].locked = true;
    await saveProject(join(root, project.id), saved);
    assert.equal((await post(request)).status, 400);
    assert.equal(codex.lastCellEdit, undefined);
    saved.document.layers[0].locked = false;
    await saveProject(join(root, project.id), saved);

    const first = await (await post(request)).json() as { id: string };
    assert.equal((await post(request)).status, 409);
    assert.equal((await fetch(`${base}/api/generations`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pixelforge-token": token },
      body: JSON.stringify({ projectId: project.id, request: { prompt: "생성", frameCount: 1, columns: 1, cellWidth: 2, cellHeight: 1, durationMs: 100 } }),
    })).status, 409);
    await fetch(`${base}/api/edits/${first.id}`, { method: "DELETE", headers: { "x-pixelforge-token": token } });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("셀 편집의 누락·충돌·비JSON·잘못된 결과는 부분 로그를 남기고 기술 실패한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixelforge-cell-edit-results-"));
  const project = threeFrameProject();
  const projectRoot = join(root, project.id);
  await createProject(projectRoot, project);
  const before = JSON.stringify(await loadProject(projectRoot));
  const request = cellEditRequest(project);
  const codex = new FakeCodex();
  const { server, base, token } = await startGenerationServer(root, codex);
  const start = async () => (await fetch(`${base}/api/edits`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-pixelforge-token": token },
    body: JSON.stringify({ projectId: project.id, request }),
  })).json() as Promise<CellEditWire>;

  try {
    const scenarios: string[][] = [
      ["not-json"],
      [JSON.stringify({ summary: "잘못됨", actions: [{ tool: "line", points: [{ x: 0, y: 0 }] }] })],
      [],
      [JSON.stringify({ summary: "a", actions: [] }), JSON.stringify({ summary: "b", actions: [] })],
    ];
    for (const results of scenarios) {
      const job = await start();
      for (const text of results) codex.event({ type: "result", runId: codex.lastRunId, text });
      codex.event({ type: "completed", runId: codex.lastRunId, status: "completed" });
      const finished = await waitForJob(base, job.id, "edits") as CellEditWire;
      assert.equal(finished.status, "failed");
      assert.equal(finished.result, undefined);
      assert.ok(job.logPath);
      assert.equal(JSON.parse(await readFile(join(projectRoot, job.logPath, "summary.json"), "utf8")).outcome, "technical_error");
      assert.equal(JSON.stringify(await loadProject(projectRoot)), before);
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("셀 편집 승인과 도구 시도는 즉시 거부·중단하고 실패한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixelforge-cell-edit-forbidden-"));
  const project = threeFrameProject();
  const projectRoot = join(root, project.id);
  await createProject(projectRoot, project);
  const request = cellEditRequest(project);
  const codex = new FakeCodex();
  const { server, base, token } = await startGenerationServer(root, codex);
  const start = async () => (await fetch(`${base}/api/edits`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-pixelforge-token": token },
    body: JSON.stringify({ projectId: project.id, request }),
  })).json() as Promise<CellEditWire>;

  try {
    const approval = await start();
    const approvalRun = codex.lastRunId;
    codex.event({ type: "approval", requestId: 101, method: "item/fileChange/requestApproval", params: {}, runId: approvalRun });
    const approvalFailed = await waitForJob(base, approval.id, "edits") as CellEditWire;
    assert.equal(approvalFailed.status, "failed");
    assert.deepEqual(codex.responses.at(-1), { id: 101, result: { decision: "decline" } });
    assert.equal(JSON.parse(await readFile(join(projectRoot, approval.logPath!, "summary.json"), "utf8")).outcome, "technical_error");

    const tool = await start();
    const toolRun = codex.lastRunId;
    codex.event({ type: "toolAttempt", runId: toolRun, tool: "commandExecution" });
    codex.event({ type: "result", runId: toolRun, text: JSON.stringify(pixelEdit) });
    codex.event({ type: "completed", runId: toolRun, status: "completed" });
    assert.equal((await waitForJob(base, tool.id, "edits")).status, "failed");
    const toolSummary = JSON.parse(await readFile(join(projectRoot, tool.logPath!, "summary.json"), "utf8"));
    assert.equal(toolSummary.outcome, "technical_error");
    assert.match(toolSummary.error, /금지된 도구/);
    assert.equal(codex.judgments.length, 0);
    assert.ok(codex.interrupts.includes(approvalRun));
    assert.ok(codex.interrupts.includes(toolRun));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("셀 편집 취소와 최종화 경쟁은 먼저 선점한 상태만 유지한다", async () => {
  for (const phase of ["editing", "judging"] as const) {
    const fixture = await cellEditFixture();
    try {
      let releaseInterrupt!: () => void;
      fixture.codex.interruptWait = new Promise<void>((resolve) => { releaseInterrupt = resolve; });
      const job = await fixture.startEdit();
      if (phase === "judging") await fixture.codex.completeResult(pixelEdit, "judging");
      const cancelledRun = fixture.codex.lastRunId;
      const runCount = fixture.codex.runs.length;
      const cancelling = fetch(`${fixture.base}/api/edits/${job.id}`, {
        method: "DELETE",
        headers: { "x-pixelforge-token": fixture.headers["x-pixelforge-token"] },
      });
      await waitUntil(() => fixture.codex.interrupts.includes(cancelledRun), "취소 중단 요청이 시작되지 않았습니다.");
      assert.equal((await fixture.getEdit(job.id)).status, "cancelling");
      const late = phase === "editing" ? pixelEdit : passVerdict;
      fixture.codex.event({ type: "result", runId: cancelledRun, text: JSON.stringify(late) });
      fixture.codex.event({ type: "completed", runId: cancelledRun, status: "completed" });
      releaseInterrupt();
      const response = await cancelling;
      assert.equal(response.status, 200);
      assert.equal((await response.json() as CellEditWire).status, "cancelled");
      const cancelled = await fixture.waitForStatus(job.id, "cancelled");
      assert.equal(cancelled.result, undefined);
      assert.equal(fixture.codex.runs.length, runCount);
      assert.equal(JSON.parse(await fixture.readLog(cancelled, "summary.json").then((value) => value.toString("utf8"))).outcome, "cancelled");
      assert.deepEqual(await storedProjectBytes(fixture.projectRoot), fixture.beforeBytes);
    } finally {
      await fixture.close();
    }
  }
});

test("완료 처리가 다음 판정 실행을 여는 동안에는 취소가 완료 선점을 뒤집지 못한다", async () => {
  const fixture = await cellEditFixture();
  try {
    let releaseJudgment!: () => void;
    fixture.codex.judgmentWait = new Promise<void>((resolve) => { releaseJudgment = resolve; });
    const job = await fixture.startEdit();
    fixture.codex.event({ type: "result", runId: fixture.codex.lastRunId, text: JSON.stringify(pixelEdit) });
    fixture.codex.event({ type: "completed", runId: fixture.codex.lastRunId, status: "completed" });
    await waitUntil(() => fixture.codex.judgments.length > 0, "완료 처리가 판정 실행을 시작하지 않았습니다.");
    const rejected = await fetch(`${fixture.base}/api/edits/${job.id}`, {
      method: "DELETE",
      headers: { "x-pixelforge-token": fixture.headers["x-pixelforge-token"] },
    });
    assert.equal(rejected.status, 409);
    releaseJudgment();
    await waitUntil(() => fixture.codex.runs.at(-1)?.role === "judging", "판정 실행이 연결되지 않았습니다.");
    await fixture.codex.completeResult(passVerdict);
    assert.equal((await fixture.waitForStatus(job.id, "finalizing")).result?.acceptedAttempt, 1);

    const afterClaim = await fetch(`${fixture.base}/api/edits/${job.id}`, {
      method: "DELETE",
      headers: { "x-pixelforge-token": fixture.headers["x-pixelforge-token"] },
    });
    assert.equal(afterClaim.status, 409);
    assert.equal(((await afterClaim.json()) as { error: string }).error, "이미 적용 준비가 시작되어 취소할 수 없습니다.");
  } finally {
    await fixture.close();
  }
});

test("완료 처리가 판정 실행 반환을 기다리는 동안 전역 오류가 후속 전이를 차단한다", async () => {
  const fixture = await cellEditFixture();
  try {
    let releaseJudgment!: () => void;
    fixture.codex.judgmentWait = new Promise<void>((resolve) => { releaseJudgment = resolve; });
    const job = await fixture.startEdit();
    fixture.codex.event({ type: "result", runId: fixture.codex.lastRunId, text: JSON.stringify(pixelEdit) });
    fixture.codex.event({ type: "completed", runId: fixture.codex.lastRunId, status: "completed" });
    await waitUntil(() => fixture.codex.judgments.length > 0, "완료 처리가 판정 실행을 시작하지 않았습니다.");
    fixture.codex.event({ type: "error", message: "셀 편집 모델 연결 종료" });
    const failed = await fixture.waitForStatus(job.id, "failed");
    releaseJudgment();
    await waitUntil(() => fixture.codex.runs.length === 2, "늦은 판정 실행이 반환되지 않았습니다.");
    await waitUntil(() => fixture.codex.interrupts.includes(fixture.codex.runs[1].id), "늦은 판정 실행이 중단되지 않았습니다.");
    assert.equal(failed.error, "셀 편집 모델 연결 종료");
    assert.equal(failed.result, undefined);
    assert.equal(fixture.codex.cellEdits.length, 1);
    assert.equal(fixture.codex.judgments.length, 1);
    assert.equal(JSON.parse(await fixture.readLog(failed, "summary.json").then((value) => value.toString("utf8"))).outcome, "technical_error");
  } finally {
    await fixture.close();
  }
});

test("적용 확인 전에는 finalizing과 잠금을 유지하고 확인 뒤 완료한다", async () => {
  const fixture = await cellEditFixture();
  try {
    const ready = await readyCellEdit(fixture);
    assert.ok(ready.logPath);
    await assert.rejects(fixture.readLog(ready, "summary.json"), { code: "ENOENT" });
    assert.equal((await fetch(`${fixture.base}/api/edits`, {
      method: "POST",
      headers: fixture.headers,
      body: JSON.stringify({ projectId: fixture.before.id, request: fixture.request }),
    })).status, 409);

    const confirmed = await fetch(`${fixture.base}/api/edits/${ready.id}/application`, {
      method: "POST",
      headers: fixture.headers,
      body: JSON.stringify({ outcome: "applied" }),
    }).then((response) => response.json()) as CellEditWire;
    assert.equal(confirmed.status, "completed");
    const summary = JSON.parse(await readFile(join(fixture.projectRoot, ready.logPath, "summary.json"), "utf8"));
    assert.equal(summary.application, "applied");
    assert.equal(summary.status, "completed");
    assert.equal((await fixture.startEdit()).status, "running");
  } finally {
    await fixture.close();
  }
});

test("적용 확인 중복은 body와 무관하게 같은 완료와 한 번의 summary를 반환한다", async () => {
  const fixture = await cellEditFixture();
  try {
    const ready = await readyCellEdit(fixture);
    const post = (body: unknown) => fetch(`${fixture.base}/api/edits/${ready.id}/application`, {
      method: "POST",
      headers: fixture.headers,
      body: JSON.stringify(body),
    }).then((response) => response.json()) as Promise<CellEditWire>;
    const first = await post({ outcome: "applied" });
    assert.equal(first.status, "completed");
    const duplicate = await post({ ignored: true });
    assert.deepEqual(duplicate, first);
    const summary = JSON.parse(await fixture.readLog(ready, "summary.json").then((value) => value.toString("utf8")));
    assert.equal(summary.files.includes(`${ready.logPath}/summary.json`), false);
  } finally {
    await fixture.close();
  }
});

test("application body를 읽는 동안 확정되면 malformed body도 terminal wire를 반환한다", async () => {
  const fixture = await cellEditFixture();
  let pendingRequest: ReturnType<typeof httpRequest> | undefined;
  try {
    const ready = await readyCellEdit(fixture);
    let finishBody: (() => void) | undefined;
    const pendingResponse = new Promise<{ status: number; body: CellEditWire }>((resolve, reject) => {
      pendingRequest = httpRequest(`${fixture.base}/api/edits/${ready.id}/application`, {
        method: "POST",
        headers: fixture.headers,
      }, async (response) => {
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of response) chunks.push(Buffer.from(chunk));
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as CellEditWire,
          });
        } catch (error) {
          reject(error);
        }
      });
      pendingRequest.on("error", reject);
      pendingRequest.write("{", () => { finishBody = () => pendingRequest!.end("malformed"); });
    });
    await waitUntil(() => finishBody !== undefined, "느린 application 요청이 시작되지 않았습니다.");
    await new Promise((resolve) => setTimeout(resolve, 10));

    const terminal = await fetch(`${fixture.base}/api/edits/${ready.id}/application`, {
      method: "POST",
      headers: fixture.headers,
      body: JSON.stringify({ outcome: "applied" }),
    }).then((response) => response.json()) as CellEditWire;
    finishBody!();
    const pending = await pendingResponse;
    assert.equal(pending.status, 200);
    assert.deepEqual(pending.body, terminal);
  } finally {
    pendingRequest?.destroy();
    await fixture.close();
  }
});

test("적용 성공과 실패 경쟁은 먼저 확정된 상태만 유지한다", async () => {
  const fixture = await cellEditFixture();
  try {
    const ready = await readyCellEdit(fixture);
    const post = (body: unknown) => fetch(`${fixture.base}/api/edits/${ready.id}/application`, {
      method: "POST",
      headers: fixture.headers,
      body: JSON.stringify(body),
    }).then((response) => response.json()) as Promise<CellEditWire>;
    const [first, competing] = await Promise.all([
      post({ outcome: "applied" }),
      post({ outcome: "failed", error: "경쟁 실패" }),
    ]);
    const duplicate = await post({ outcome: "applied" });
    assert.deepEqual(competing, first);
    assert.deepEqual(duplicate, first);
    const summary = JSON.parse(await fixture.readLog(ready, "summary.json").then((value) => value.toString("utf8")));
    assert.equal(summary.status, first.status);
    assert.equal(summary.application, first.status === "completed" ? "applied" : "failed");
  } finally {
    await fixture.close();
  }
});

test("클라이언트 적용 실패를 한 번만 failed로 확정한다", async () => {
  const fixture = await cellEditFixture();
  try {
    const ready = await readyCellEdit(fixture);
    const failed = await fetch(`${fixture.base}/api/edits/${ready.id}/application`, {
      method: "POST",
      headers: fixture.headers,
      body: JSON.stringify({ outcome: "failed", error: "대상 변경" }),
    }).then((response) => response.json()) as CellEditWire;
    assert.equal(failed.status, "failed");
    assert.match(failed.error ?? "", /대상 변경/);
    assert.equal(failed.result, undefined);
    const summary = JSON.parse(await fixture.readLog(ready, "summary.json").then((value) => value.toString("utf8")));
    assert.equal(summary.application, "failed");
    assert.equal((await fixture.startEdit()).status, "running");
  } finally {
    await fixture.close();
  }
});

test("적용 확인이 없으면 제한 시간 뒤 실패하고 잠금을 해제한다", async () => {
  const fixture = await cellEditFixture(20);
  try {
    const ready = await readyCellEdit(fixture);
    assert.ok(ready.logPath);
    const failed = await fixture.waitForStatus(ready.id, "failed");
    assert.match(failed.error ?? "", /적용 확인 시간이 초과/);
    const summary = JSON.parse(await readFile(join(fixture.projectRoot, ready.logPath, "summary.json"), "utf8"));
    assert.equal(summary.application, "timeout");
    assert.equal((await fixture.startEdit()).status, "running");
  } finally {
    await fixture.close();
  }
});

test("summary 기록 실패는 completed를 차단하고 부분 로그를 남긴다", async () => {
  const fixture = await cellEditFixture();
  try {
    const ready = await readyCellEdit(fixture);
    assert.ok(ready.logPath);
    await mkdir(join(fixture.projectRoot, ready.logPath, "summary.json"));
    const failed = await fetch(`${fixture.base}/api/edits/${ready.id}/application`, {
      method: "POST",
      headers: fixture.headers,
      body: JSON.stringify({ outcome: "applied" }),
    }).then((response) => response.json()) as CellEditWire;
    assert.equal(failed.status, "failed");
    assert.match(failed.error ?? "", /부분 로그/);
    assert.equal(failed.result, undefined);
    assert.ok((await readFile(join(fixture.projectRoot, ready.logPath, "request.json"))).length > 0);
    assert.equal((await fixture.startEdit()).status, "running");
  } finally {
    await fixture.close();
  }
});
