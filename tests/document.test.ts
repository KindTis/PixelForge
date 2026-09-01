import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, createProject, renameProject, validateDocument } from "../src/core/document.ts";
import type { AnimationTag } from "../src/core/types.ts";

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

test("애니메이션 세트는 존재성·단일 소속·고유 이름과 ID를 검증한다", () => {
  const base = createDocument({ width: 1, height: 1 });
  const frameId = base.frames[0].id;
  const cases: Array<[AnimationTag[], RegExp]> = [
    [[{ id: "a", name: "   ", direction: "forward", frameIds: [] }], /이름이 필요/],
    [[
      { id: "a", name: "idle", direction: "forward", frameIds: [] },
      { id: "a", name: "walk", direction: "forward", frameIds: [] },
    ], /세트 ID.*중복/],
    [[
      { id: "a", name: "idle", direction: "forward", frameIds: [] },
      { id: "b", name: "idle", direction: "forward", frameIds: [] },
    ], /세트 이름.*중복/],
    [[{ id: "a", name: "idle", direction: "forward", frameIds: ["missing"] }], /존재하지 않는 프레임/],
    [[{ id: "a", name: "idle", direction: "forward", frameIds: [frameId, frameId] }], /같은 프레임.*두 번/],
    [[
      { id: "a", name: "idle", direction: "forward", frameIds: [frameId] },
      { id: "b", name: "walk", direction: "forward", frameIds: [frameId] },
    ], /둘 이상의 세트/],
    [[{ id: "a", name: " 미분류 ", direction: "forward", frameIds: [] }], /예약 이름/],
    [[
      { id: "a", name: "attack?", direction: "forward", frameIds: [] },
      { id: "b", name: "ATTACK*", direction: "forward", frameIds: [] },
    ], /Unity AnimationClip 파일명/],
  ];
  for (const [tags, error] of cases) {
    const document = structuredClone(base);
    document.tags = tags;
    assert.throws(() => validateDocument(document), error);
  }
  const duplicateFrameId = structuredClone(base);
  duplicateFrameId.frames.push(structuredClone(base.frames[0]));
  assert.throws(() => validateDocument(duplicateFrameId), /프레임 ID.*중복/);
  const empty = structuredClone(base);
  empty.tags = [{ id: "empty", name: "attack", direction: "pingPong", frameIds: [] }];
  assert.doesNotThrow(() => validateDocument(empty));
});

test("인덱스 문서는 팔레트 밖 픽셀을 거부한다", () => {
  const document = createDocument({ width: 1, height: 1 });
  document.colorMode = "indexed";
  Object.values(document.images)[0].data.set([1, 2, 3, 255]);
  assert.throws(() => validateDocument(document), /팔레트 밖/);
});
