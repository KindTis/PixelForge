import assert from "node:assert/strict";
import test from "node:test";
import {
  animationGroupFrameIds,
  assertUniqueUnityAnimationClipFileNames,
  conflictingUnityAnimationTagNames,
  createAnimationSet,
  defaultAnimationSelection,
  deleteAnimationSet,
  editingFrameContext,
  frameSequence,
  reconcileAnimationSelection,
  reorderAnimationFrames,
  reorderAnimationSets,
  transferAnimationFrames,
  unclassifiedFrameIds,
  updateAnimationSet,
  unityAnimationClipFileName,
} from "../src/core/animation.ts";
import { createDocument, validateDocument } from "../src/core/document.ts";
import { addFrame } from "../src/core/timeline.ts";
import type { AnimationTag } from "../src/core/types.ts";

function tag(direction: AnimationTag["direction"]): AnimationTag {
  return { id: "tag", name: "공격", frameIds: ["a", "c", "b"], direction };
}

test("프레임 시퀀스는 저장된 명시 순서를 사용한다", () => {
  assert.deepEqual(frameSequence(tag("forward")), ["a", "c", "b"]);
  assert.deepEqual(frameSequence(tag("reverse")), ["b", "c", "a"]);
  assert.deepEqual(frameSequence(tag("pingPong")), ["a", "c", "b", "c"]);
});

test("미분류 프레임을 세트로 등록하고 삭제하면 프레임은 다시 미분류가 된다", () => {
  let document = createDocument({ width: 1, height: 1 });
  document = addFrame(document, document.frames[0].id);
  const sourceIds = document.frames.map((frame) => frame.id);

  const created = createAnimationSet(document, {
    sourceTagId: null,
    frameIds: sourceIds,
    name: "idle",
    direction: "forward",
    mode: "move",
  });

  assert.deepEqual(created.document.tags[0].frameIds, sourceIds);
  assert.deepEqual(unclassifiedFrameIds(created.document), []);
  const deleted = deleteAnimationSet(created.document, created.tagId);
  assert.deepEqual(unclassifiedFrameIds(deleted), sourceIds);
  assert.deepEqual(deleted.frames.map((frame) => frame.id), sourceIds);
});

test("다중 프레임 이동과 재정렬은 상대 순서와 단일 소속을 유지한다", () => {
  let document = createDocument({ width: 1, height: 1 });
  for (let index = 0; index < 5; index += 1) document = addFrame(document);
  const [a, b, c, d, x, y] = document.frames.map((frame) => frame.id);
  const idleId = "idle";
  const runId = "run";
  document.tags = [
    { id: idleId, name: "idle", direction: "forward", frameIds: [a, b, c, d] },
    { id: runId, name: "run", direction: "forward", frameIds: [x, y] },
  ];
  validateDocument(document);

  let moved = transferAnimationFrames(document, {
    sourceTagId: idleId,
    targetTagId: runId,
    frameIds: [b, d],
    insertAfterFrameId: x,
    mode: "move",
  });
  assert.deepEqual(moved.document.tags.find((tag) => tag.id === runId)?.frameIds, [x, b, d, y]);
  assert.deepEqual(moved.frameIds, [b, d]);

  moved = {
    ...moved,
    document: reorderAnimationFrames(moved.document, runId, [b, d], x),
  };
  assert.deepEqual(animationGroupFrameIds(moved.document, runId), [b, d, x, y]);
  moved = { ...moved, document: reorderAnimationSets(moved.document, runId, idleId) };
  assert.deepEqual(moved.document.tags.map((tag) => tag.id), [runId, idleId]);
  moved = { ...moved, document: updateAnimationSet(moved.document, runId, { name: " sprint ", direction: "reverse" }) };
  assert.deepEqual(
    moved.document.tags.find((tag) => tag.id === runId),
    { id: runId, name: "sprint", direction: "reverse", frameIds: [b, d, x, y] },
  );
  assert.doesNotThrow(() => validateDocument(moved.document));
});

test("편집 문맥과 선택 보정은 이름 세트와 미분류 경계를 넘지 않는다", () => {
  let document = createDocument({ width: 1, height: 1 });
  for (let index = 0; index < 4; index += 1) document = addFrame(document);
  const ids = document.frames.map((frame) => frame.id);
  const namedIds = [ids[0], ids[2], ids[4]];
  const namedTagId = "walk";
  document.tags = [{ id: namedTagId, name: "walk", direction: "reverse", frameIds: namedIds }];
  validateDocument(document);

  assert.deepEqual(editingFrameContext(document, namedIds[1]), {
    tagId: namedTagId,
    frameIds: namedIds,
    index: 1,
    position: 2,
    total: 3,
    firstFrameId: namedIds[0],
    previousFrameId: namedIds[0],
    nextFrameId: namedIds[2],
    direction: "reverse",
    name: "walk",
  });
  const unclassifiedIds = unclassifiedFrameIds(document);
  assert.equal(editingFrameContext(document, unclassifiedIds[0]).previousFrameId, undefined);
  assert.deepEqual(defaultAnimationSelection(document), { tagId: namedTagId, frameId: namedIds[0] });
  assert.deepEqual(
    reconcileAnimationSelection(document, { tagId: null, frameId: namedIds[1] }),
    { tagId: namedTagId, frameId: namedIds[1] },
  );
  assert.deepEqual(
    reconcileAnimationSelection(document, { tagId: namedTagId, frameId: "missing" }),
    { tagId: namedTagId, frameId: namedIds[0] },
  );
});

test("Unity AnimationClip 파일명은 importer 규칙으로 정규화하고 대소문자 없이 충돌한다", () => {
  assert.equal(unityAnimationClipFileName("attack/slash?"), "attack_slash");
  assert.equal(unityAnimationClipFileName("???"), "animation");
  const tags = [{ name: "attack?" }, { name: "ATTACK*" }, { name: "walk" }];
  assert.deepEqual(conflictingUnityAnimationTagNames(tags), ["attack?", "ATTACK*"]);
  assert.throws(
    () => assertUniqueUnityAnimationClipFileNames(tags),
    /attack\?.*ATTACK\*.*충돌하는 태그를 삭제하고 서로 다른 이름으로 다시 추가하세요/,
  );
});
