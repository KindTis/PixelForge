import assert from "node:assert/strict";
import test from "node:test";
import type { AiEditReadyResult, AiEditRequest } from "../src/core/ai-edit.ts";
import { createDocument, createProject } from "../src/core/document.ts";
import { addFrame } from "../src/core/timeline.ts";
import type { AnimationDirection, PngImportDestination } from "../src/core/types.ts";
import { api, appendAnimationIssue, cellEditApplicationDisposition, cellEditApplicationRequestTimeout, cellEditCompletionNotice, cellEditPayload, codexJobStatusTitle, completedFrameIndex, completedGenerationSelection, decodeProject, encodeProject, failedCodexJob, generationHistoryFields, generationPayload, isInitialBlankProject, isRetryablePollingError, pngImportPayload, pollingErrorCodexJob, projectJobOwnershipMatches, projectLifetimeMatches, releaseProjectJobOwnership, type CellEditJob, type GenerationJob, type GenerationTarget, type WireProject } from "../src/client/api.ts";

test("프로젝트 픽셀을 JSON 배열로 보내고 Uint8ClampedArray로 복원한다", () => {
  const project = createProject("저장", createDocument({ width: 1, height: 1 }));
  Object.values(project.document.images)[0].data.set([1, 2, 3, 255]);
  const wire = encodeProject(project);
  const parsed = JSON.parse(JSON.stringify(wire)) as WireProject;
  assert.equal(Array.isArray(Object.values(parsed.document.images)[0].data), true);
  assert.deepEqual(decodeProject(parsed), project);
});

test("전체 및 선택 프레임 생성을 위한 요청 본문을 조립한다", () => {
  const project = createProject("기사", createDocument({ width: 16, height: 24 }));
  const sheetTarget: GenerationTarget = {
    kind: "sheet",
    animationSet: { name: "idle", direction: "forward" },
  };
  const request = {
    prompt: "검 공격",
    frameCount: 8,
    columns: 4,
    cellWidth: 16,
    cellHeight: 24,
    durationMs: 100,
    parentId: undefined,
    referencePath: undefined,
  };

  assert.deepEqual(generationPayload(project, "검 공격", 8, 4, sheetTarget), {
    projectId: project.id,
    target: sheetTarget,
    request,
  });

  const selectedId = project.document.frames[0].id;
  const frameTarget: GenerationTarget = { kind: "frame", frameId: selectedId };
  assert.deepEqual(generationPayload(project, "검 공격", 8, 4, frameTarget), {
    projectId: project.id,
    target: frameTarget,
    request,
  });
});

test("추가 생성 payload는 배타적인 append target을 보낸다", () => {
  const project = createProject("기사", createDocument({ width: 16, height: 24 }));
  const target: GenerationTarget = {
    kind: "append",
    animationSet: { name: "attack", direction: "reverse" },
    baseFrameId: project.document.frames[0].id,
    targetLayerId: project.document.layers[0].id,
  };
  const payload = generationPayload(project, "검 공격", 3, 2, target);
  assert.deepEqual(payload.target, target);
  assert.equal("frameId" in payload, false);
  assert.equal("appendAnimation" in payload, false);
  assert.equal(payload.request.durationMs, 100);
});

function appendedProject(direction: AnimationDirection) {
  let document = createDocument({ width: 1, height: 1 });
  for (let index = 1; index < 4; index += 1) document = addFrame(document);
  document.tags.push({
    id: crypto.randomUUID(),
    name: "attack",
    frameIds: document.frames.map((frame) => frame.id),
    direction,
  });
  return createProject("기사", document);
}

test("전체 및 추가 완료 선택은 방향과 무관하게 세트의 첫 편집 프레임을 반환한다", () => {
  for (const direction of ["forward", "reverse", "pingPong"] as const) {
    const project = appendedProject(direction);
    for (const target of [
      { kind: "sheet", animationSet: { name: "attack", direction } },
      {
        kind: "append",
        animationSet: { name: "attack", direction },
        baseFrameId: "base",
        targetLayerId: "layer",
      },
    ] satisfies GenerationTarget[]) {
      const selection = completedGenerationSelection(project, target);
      const tag = project.document.tags.find((candidate) => candidate.name === "attack")!;
      assert.deepEqual(selection, {
        frameIndex: project.document.frames.findIndex((frame) => frame.id === tag.frameIds[0]),
        tag,
        frameCount: 4,
      });
    }
  }
});

test("추가 애니메이션 사전 안내는 이름과 활성 레이어 문제를 정확히 설명한다", () => {
  const project = createProject("기사", createDocument({ width: 1, height: 1 }));
  const layer = project.document.layers[0];
  assert.equal(appendAnimationIssue(project, "검 공격", "attack", layer, true), undefined);
  assert.match(appendAnimationIssue(project, "검 공격", "미분류", layer, true) ?? "", /예약/);
  project.document.tags.push({
    id: "walk",
    name: "walk",
    frameIds: [project.document.frames[0].id],
    direction: "forward",
  });
  assert.match(appendAnimationIssue(project, "검 공격", "walk", layer, true) ?? "", /고유/);
  project.document.tags[0].name = "attack?";
  project.document.tags.push({ ...project.document.tags[0], id: "legacy-attack", name: "ATTACK*" });
  assert.match(
    appendAnimationIssue(project, "검 공격", "run", layer, true) ?? "",
    /attack\?.*ATTACK\*.*충돌하는 태그를 삭제/,
  );
  project.document.tags.pop();
  project.document.tags[0].name = "walk";
  for (const invalidLayer of [
    { ...layer, visible: false },
    { ...layer, locked: true },
    { ...layer, blendMode: "multiply" as const },
    { ...layer, opacity: 0.5 },
  ]) {
    assert.match(
      appendAnimationIssue(project, "검 공격", "run", invalidLayer, true) ?? "",
      /보이고 잠기지 않은/,
    );
  }
});

test("초기 빈 프로젝트만 전체 시트 교체 확인을 생략한다", () => {
  const blank = createProject("기사", createDocument({ width: 1, height: 1 }));
  assert.equal(isInitialBlankProject(blank), true);

  const withHistory = structuredClone(blank);
  withHistory.generationHistory.push({ id: "g", prompt: "생성", createdAt: "2026-08-31T00:00:00.000Z", outputPath: "generated/g.png" });
  const withFrame = { ...blank, document: addFrame(blank.document) };
  const withSet = structuredClone(blank);
  withSet.document.tags.push({ id: "idle", name: "idle", direction: "forward", frameIds: [] });
  const withPixels = structuredClone(blank);
  Object.values(withPixels.document.images)[0].data[3] = 1;

  for (const project of [withHistory, withFrame, withSet, withPixels]) {
    assert.equal(isInitialBlankProject(project), false);
  }
});

test("생성 target은 결과가 실제로 바꾼 프로젝트 필드를 선언한다", () => {
  assert.deepEqual(generationHistoryFields({ kind: "sheet", animationSet: { name: "idle", direction: "forward" } }), ["document", "generationHistory", "exportSettings"]);
  assert.deepEqual(generationHistoryFields({ kind: "append", animationSet: { name: "run", direction: "forward" }, baseFrameId: "f", targetLayerId: "l" }), ["document", "generationHistory"]);
  assert.deepEqual(generationHistoryFields({ kind: "frame", frameId: "f" }), ["document"]);
});

test("PNG 가져오기 payload는 destination을 직접 전달한다", () => {
  const project = createProject("기사", createDocument({ width: 16, height: 24 }));
  const destination: PngImportDestination = { kind: "set", animationSet: { name: "idle", direction: "forward" } };
  assert.deepEqual(pngImportPayload(project, "png", 8, 4, destination), {
    projectId: project.id,
    pngBase64: "png",
    request: {
      frameCount: 8,
      columns: 4,
      cellWidth: 16,
      cellHeight: 24,
      durationMs: 100,
      destination,
    },
  });
});

test("현재 셀 편집 요청 본문을 그대로 조립한다", () => {
  const request: AiEditRequest = {
    prompt: "배경을 빨갛게 칠해줘",
    target: { frameId: "frame", layerId: "layer", celId: "cel" },
    settings: {
      tool: "pencil",
      color: [0, 0, 0, 255],
      secondaryColor: [255, 255, 255, 0],
      brushSize: 1,
      brushShape: "square",
      filled: false,
      mirrorX: false,
      mirrorY: false,
    },
  };
  assert.deepEqual(cellEditPayload("project", request), { projectId: "project", request });
});

test("선택 프레임 작업의 모든 상태 제목에 프레임 문맥을 표시한다", () => {
  const selectedTitles: Record<GenerationJob["status"], string> = {
    running: "선택 프레임을 재생성 중입니다",
    awaitingApproval: "선택 프레임 재생성 승인 필요",
    cancelling: "선택 프레임 재생성을 취소하는 중입니다",
    finalizing: "선택 프레임 결과를 가져오는 중입니다",
    completed: "선택 프레임 가져오기 완료",
    failed: "선택 프레임 재생성 실패",
    cancelled: "선택 프레임 재생성 취소됨",
  };
  for (const [status, title] of Object.entries(selectedTitles) as Array<[GenerationJob["status"], string]>) {
    assert.equal(codexJobStatusTitle({ kind: "generation", frameId: "frame", status }), title);
  }
  assert.equal(codexJobStatusTitle({ kind: "generation", status: "awaitingApproval" }), "Codex 승인 필요");
});

test("현재 셀 편집 작업의 모든 상태 제목에 셀 문맥을 표시한다", () => {
  const target = { frameId: "frame", layerId: "layer", celId: "cel" };
  const judging: CellEditJob = {
    id: "edit",
    kind: "cellEdit",
    status: "running",
    phase: "judging",
    attempt: 2,
    maxAttempts: 6,
    messages: [],
    target,
    logPath: "generated/cell-edit-logs/edit",
    lastVerdict: "팔 위치를 수정해야 합니다.",
  };
  const readyResult: AiEditReadyResult = {
    summary: "수정 완료",
    attempts: [],
    actionCount: 3,
    acceptedAttempt: 2,
    direct: false,
  };

  assert.equal(codexJobStatusTitle(judging), "현재 셀 편집 · 2/6 · 판정 중");
  assert.equal(codexJobStatusTitle({ ...judging, status: "finalizing" }), "현재 셀 편집 · 적용 확인 중");
  assert.equal(cellEditCompletionNotice(readyResult, 3), "동작 3개 적용 · 2회차 판정 합격 · 완료");
  assert.equal(cellEditCompletionNotice({ ...readyResult, acceptedAttempt: undefined, direct: true }, 1), "판정 없이 선택·스포이드 동작을 적용했습니다.");
  assert.throws(() => cellEditCompletionNotice({ ...readyResult, acceptedAttempt: undefined }, 3), /합격 회차/);

  for (const [status, deadline, now, expected] of [
    ["finalizing", 1_000, 999, "pending"],
    ["completed", 1_000, 999, "completed"],
    ["failed", 1_000, 999, "rollback"],
    ["finalizing", 1_000, 1_000, "rollback"],
  ] as const) {
    assert.equal(cellEditApplicationDisposition({ ...judging, status }, deadline, now), expected);
  }
});

test("적용 확인 요청은 남은 제한 시간을 순수 판정한다", () => {
  assert.equal(cellEditApplicationRequestTimeout(0, 900), undefined);
  assert.equal(cellEditApplicationRequestTimeout(1_000, 900), 100);
  assert.equal(cellEditApplicationRequestTimeout(1_000, 1_000), 0);
  assert.equal(cellEditApplicationRequestTimeout(1_000, 1_100), 0);

});

test("프로젝트 epoch와 작업 소유권은 같은 ID의 오래된 응답과 cleanup을 거부한다", () => {
  const oldLifetime = { projectId: "same", epoch: 1 };
  const currentLifetime = { projectId: "same", epoch: 2 };
  const oldJob = { ...oldLifetime, jobId: "old-job" };
  const currentJob = { ...currentLifetime, jobId: "current-job" };
  assert.equal(projectLifetimeMatches(currentLifetime, oldLifetime), false);
  assert.equal(projectLifetimeMatches(currentLifetime, currentLifetime), true);
  assert.equal(projectJobOwnershipMatches(currentLifetime, currentJob, oldJob), false);
  assert.equal(projectJobOwnershipMatches(currentLifetime, { ...currentJob, jobId: "other-job" }, currentJob), false);
  assert.equal(projectJobOwnershipMatches(currentLifetime, currentJob, currentJob), true);
  assert.equal(releaseProjectJobOwnership(currentJob, oldJob), currentJob);
  assert.equal(releaseProjectJobOwnership(currentJob, currentJob), undefined);
});

test("선택 재생성 완료는 시작한 프레임과 일치하는 결과만 선택한다", () => {
  const project = createProject("기사", createDocument({ width: 16, height: 24 }));
  const frameId = project.document.frames[0].id;

  assert.equal(completedFrameIndex(project), 0);
  assert.equal(completedFrameIndex(project, frameId, frameId), 0);
  assert.throws(() => completedFrameIndex(undefined, frameId, frameId), /완료된 생성 결과가 없습니다/);
  assert.throws(() => completedFrameIndex(project, frameId), /선택 프레임 ID/);
  assert.throws(() => completedFrameIndex(project, frameId, "다른 프레임"), /일치하지/);
  assert.throws(() => completedFrameIndex(project, "없는 프레임", "없는 프레임"), /찾을 수 없습니다/);
});

test("폴링 전송 오류는 같은 비종결 작업의 상태를 유지하고 오류만 반영한다", () => {
  const running: GenerationJob = { id: "job", kind: "generation", frameId: "frame", status: "running", messages: [] };
  const awaiting: GenerationJob = {
    ...running,
    status: "awaitingApproval",
    approval: { requestId: 1, method: "write" },
  };
  const completed: GenerationJob = { ...running, status: "completed" };

  assert.deepEqual(pollingErrorCodexJob(running, "job", "연결이 끊어졌습니다."), {
    ...running,
    error: "연결이 끊어졌습니다.",
  });
  assert.deepEqual(pollingErrorCodexJob(awaiting, "job", "응답을 읽을 수 없습니다."), {
    ...awaiting,
    error: "응답을 읽을 수 없습니다.",
  });
  assert.equal(pollingErrorCodexJob(running, "new-job", "연결이 끊어졌습니다."), running);
  assert.equal(pollingErrorCodexJob(completed, "job", "연결이 끊어졌습니다."), completed);

  const cell: CellEditJob = { id: "edit", kind: "cellEdit", status: "running", phase: "editing", attempt: 1, maxAttempts: 6, messages: [], target: { frameId: "f", layerId: "l", celId: "c" } };
  assert.deepEqual(pollingErrorCodexJob(cell, "edit", "재시도"), { ...cell, error: "재시도" });
});

test("폴링 실패는 같은 Codex 작업만 종류별 필드를 보존해 실패로 바꾼다", () => {
  const job: GenerationJob = { id: "job", kind: "generation", frameId: "frame", status: "running", messages: [] };

  assert.deepEqual(failedCodexJob(job, "job", "연결이 끊어졌습니다."), { ...job, status: "failed", error: "연결이 끊어졌습니다." });
  assert.equal(failedCodexJob(job, "new-job", "연결이 끊어졌습니다."), job);
  const cell: CellEditJob = { id: "edit", kind: "cellEdit", status: "running", phase: "editing", attempt: 1, maxAttempts: 6, messages: [], target: { frameId: "f", layerId: "l", celId: "c" } };
  assert.deepEqual(failedCodexJob(cell, "edit", "적용 실패"), { ...cell, status: "failed", error: "적용 실패" });
});

test("HTTP 응답 오류는 폴링 재시도에서 제외하고 전송·JSON 오류는 재시도한다", async () => {
  const originalFetch = globalThis.fetch;
  let body = JSON.stringify({ error: "생성 작업을 찾을 수 없습니다." });
  globalThis.fetch = async () => new Response(body, {
    status: 404,
    headers: { "content-type": "application/json" },
  });

  try {
    const httpError = await api("/api/generations/missing").then(() => undefined, (reason: unknown) => reason);
    assert.equal(httpError instanceof Error, true);
    assert.equal(isRetryablePollingError(httpError), false);
    body = "<html>not found</html>";
    const nonJsonHttpError = await api("/api/generations/missing").then(() => undefined, (reason: unknown) => reason);
    assert.equal(isRetryablePollingError(nonJsonHttpError), false);
    assert.equal(isRetryablePollingError(new TypeError("fetch failed")), true);
    assert.equal(isRetryablePollingError(new SyntaxError("Unexpected token")), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
