import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createDocument, createProject as makeProject } from "../src/core/document.ts";
import { compositeFrame } from "../src/core/render.ts";
import { addFrame } from "../src/core/timeline.ts";
import { celKey } from "../src/core/types.ts";
import type { CodexEvent, GenerationRequest } from "../src/server/codex-bridge.ts";
import { createPixelForgeServer } from "../src/server/app.ts";
import { decodePng, encodePng } from "../src/server/png.ts";
import { createProject, loadProject } from "../src/server/project-store.ts";

class FakeCodex extends EventEmitter {
  lastPrompt = "";
  responses: Array<{ id: number; result: unknown }> = [];
  interrupts: string[] = [];
  approvalDuringStart = false;
  interruptWait?: Promise<void>;
  interruptError?: Error;
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
    const threadId = `thread-${this.runNumber}`;
    if (this.approvalDuringStart) this.event({ type: "approval", requestId: 77, method: "item/fileChange/requestApproval", params: { threadId, turnId: runId }, runId, threadId });
    return { id: runId, threadId, turnId: runId };
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

async function waitForJob(base: string, jobId: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const job = await fetch(`${base}/api/generations/${jobId}`).then((response) => response.json()) as { status: string; error?: string };
    if (!["running", "awaitingApproval", "cancelling", "finalizing"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("생성 작업이 종료되지 않았습니다.");
}

async function startGenerationServer(root: string, codex: FakeCodex) {
  const server = createPixelForgeServer({ projectsRoot: root, codex });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const session = await fetch(`${base}/api/session`).then((response) => response.json()) as { token: string };
  return { server, base, token: session.token };
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
    while (codex.interrupts.length === 0) await new Promise<void>((resolve) => setImmediate(resolve));
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
