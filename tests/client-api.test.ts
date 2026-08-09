import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, createProject } from "../src/core/document.ts";
import { decodeProject, encodeProject, generationPayload, type WireProject } from "../src/client/api.ts";

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
