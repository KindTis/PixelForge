import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, createProject } from "../src/core/document.ts";
import { completedFrameIndex, decodeProject, encodeProject, failedGenerationJob, generationPayload, generationStatusTitle, pollingErrorGenerationJob, type GenerationJob, type WireProject } from "../src/client/api.ts";

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

  assert.deepEqual(generationPayload(project, "검 공격", 8, 4), {
    projectId: project.id,
    request,
  });

  const selectedId = project.document.frames[0].id;
  assert.deepEqual(generationPayload(project, "검 공격", 8, 4, undefined, selectedId), {
    projectId: project.id,
    frameId: selectedId,
    request,
  });
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
    assert.equal(generationStatusTitle({ frameId: "frame", status }), title);
  }
  assert.equal(generationStatusTitle({ status: "awaitingApproval" }), "Codex 승인 필요");
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
  const running: GenerationJob = { id: "job", frameId: "frame", status: "running", messages: [] };
  const awaiting: GenerationJob = {
    ...running,
    status: "awaitingApproval",
    approval: { requestId: 1, method: "write" },
  };
  const completed: GenerationJob = { ...running, status: "completed" };

  assert.deepEqual(pollingErrorGenerationJob(running, "job", "연결이 끊어졌습니다."), {
    ...running,
    error: "연결이 끊어졌습니다.",
  });
  assert.deepEqual(pollingErrorGenerationJob(awaiting, "job", "응답을 읽을 수 없습니다."), {
    ...awaiting,
    error: "응답을 읽을 수 없습니다.",
  });
  assert.equal(pollingErrorGenerationJob(running, "new-job", "연결이 끊어졌습니다."), running);
  assert.equal(pollingErrorGenerationJob(completed, "job", "연결이 끊어졌습니다."), completed);
});

test("폴링 실패는 같은 생성 작업만 실패 상태로 바꾼다", () => {
  const job: GenerationJob = { id: "job", frameId: "frame", status: "running", messages: [] };

  assert.deepEqual(failedGenerationJob(job, "job", "연결이 끊어졌습니다."), { ...job, status: "failed", error: "연결이 끊어졌습니다." });
  assert.equal(failedGenerationJob(job, "new-job", "연결이 끊어졌습니다."), job);
});
