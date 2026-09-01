import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, createProject, renameProject, validateDocument } from "../src/core/document.ts";

test("새 문서는 한 프레임과 한 레이어를 가진다", () => {
  const document = createDocument({ width: 32, height: 48 });

  assert.equal(document.width, 32);
  assert.equal(document.height, 48);
  assert.equal(document.frames.length, 1);
  assert.equal(document.layers.length, 1);
  assert.doesNotThrow(() => validateDocument(document));
});

test("새 프로젝트는 새 형식 식별자와 다시 시작한 버전을 가진다", () => {
  const project = createProject("기사", createDocument({ width: 1, height: 1 }));

  assert.equal(project.format, "pixelforge-project");
  assert.equal(project.version, 1);
});

test("0 크기 캔버스는 거부한다", () => {
  assert.throws(() => createDocument({ width: 0, height: 32 }), /캔버스 크기/);
});

test("프로젝트 이름의 앞뒤 공백을 제거해 변경한다", () => {
  const project = createProject("기존 이름", createDocument({ width: 1, height: 1 }));

  assert.equal(renameProject(project, "  새 이름  ").name, "새 이름");
});

test("빈 프로젝트 이름은 거부한다", () => {
  const project = createProject("기존 이름", createDocument({ width: 1, height: 1 }));

  assert.throws(() => renameProject(project, "   "), /프로젝트 이름/);
});

test("존재하지 않는 프레임을 참조하는 태그는 거부한다", () => {
  const document = createDocument({ width: 16, height: 16 });
  document.tags.push({
    id: "tag",
    name: "공격",
    fromFrameId: document.frames[0].id,
    toFrameId: "missing",
    direction: "forward",
  });

  assert.throws(() => validateDocument(document), /태그 프레임/);
});

test("인덱스 문서는 팔레트 밖 픽셀을 거부한다", () => {
  const document = createDocument({ width: 1, height: 1 });
  document.colorMode = "indexed";
  Object.values(document.images)[0].data.set([1, 2, 3, 255]);
  assert.throws(() => validateDocument(document), /팔레트 밖/);
});
