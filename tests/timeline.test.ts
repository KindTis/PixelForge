import assert from "node:assert/strict";
import test from "node:test";
import {
  addAnimationTag,
  addFrameToAnimationGroup,
  animationGroupFrameIds,
  deleteAnimationFrame,
  duplicateFrameInAnimationGroup,
  unclassifiedFrameIds,
} from "../src/core/animation.ts";
import { createDocument } from "../src/core/document.ts";
import { celKey } from "../src/core/types.ts";
import {
  addFrame,
  addLayer,
  deleteLayer,
  duplicateFrame,
  duplicateLayer,
  linkCel,
  moveFrame,
  moveLayer,
  setFrameDuration,
  unlinkCel,
} from "../src/core/timeline.ts";

test("프레임을 추가·이동·복제하고 속도를 조절한다", () => {
  let document = createDocument({ width: 1, height: 1 });
  const first = document.frames[0].id;
  document = addFrame(document, first);
  const second = document.frames[1].id;
  document = duplicateFrame(document, first);
  const duplicate = document.frames[1].id;
  const layer = document.layers[0].id;
  assert.equal(document.cels[celKey(first, layer)].imageId, document.cels[celKey(duplicate, layer)].imageId);
  document = setFrameDuration(document, duplicate, 240);
  document = moveFrame(document, second, 0);
  assert.equal(document.frames[0].id, second);
  assert.equal(document.frames.find((frame) => frame.id === duplicate)?.durationMs, 240);
});

test("연결 셀은 명시적으로 연결하고 분리할 수 있다", () => {
  let document = createDocument({ width: 1, height: 1 });
  document = addFrame(document, document.frames[0].id);
  const [first, second] = document.frames;
  const layer = document.layers[0];
  document = linkCel(document, first.id, layer.id, second.id, layer.id);
  const linkedId = document.cels[celKey(second.id, layer.id)].imageId;
  assert.equal(linkedId, document.cels[celKey(first.id, layer.id)].imageId);
  document = unlinkCel(document, second.id, layer.id);
  assert.notEqual(document.cels[celKey(second.id, layer.id)].imageId, linkedId);
});

test("프레임 추가와 복제는 활성 그룹의 저장·표시 삽입 규칙을 지킨다", () => {
  const named = createDocument({ width: 1, height: 1 });
  const namedSource = named.frames[0].id;
  named.tags = [{ id: "idle", name: "idle", direction: "forward", frameIds: [namedSource] }];
  const namedAdded = addFrameToAnimationGroup(named, "idle", namedSource);
  assert.deepEqual(namedAdded.document.frames.map((frame) => frame.id), [namedSource, namedAdded.frameId]);
  assert.deepEqual(animationGroupFrameIds(namedAdded.document, "idle"), [namedSource, namedAdded.frameId]);
  const namedDuplicate = duplicateFrameInAnimationGroup(named, "idle", namedSource);
  assert.equal(
    namedDuplicate.document.cels[celKey(namedDuplicate.frameId, named.layers[0].id)].imageId,
    named.cels[celKey(namedSource, named.layers[0].id)].imageId,
  );

  const unclassified = createDocument({ width: 1, height: 1 });
  const unclassifiedSource = unclassified.frames[0].id;
  const unclassifiedAdded = addFrameToAnimationGroup(unclassified, null, unclassifiedSource);
  assert.deepEqual(unclassifiedAdded.document.frames.map((frame) => frame.id), [unclassifiedSource, unclassifiedAdded.frameId]);
  assert.deepEqual(unclassifiedFrameIds(unclassifiedAdded.document), [unclassifiedSource, unclassifiedAdded.frameId]);

  const emptyNamed = createDocument({ width: 1, height: 1 });
  const storedFrame = emptyNamed.frames[0].id;
  emptyNamed.tags = [{ id: "attack", name: "attack", direction: "forward", frameIds: [] }];
  const firstNamed = addFrameToAnimationGroup(emptyNamed, "attack");
  assert.deepEqual(firstNamed.document.frames.map((frame) => frame.id), [storedFrame, firstNamed.frameId]);
  assert.deepEqual(animationGroupFrameIds(firstNamed.document, "attack"), [firstNamed.frameId]);

  const emptyUnclassified = createDocument({ width: 1, height: 1 });
  const ownedFrame = emptyUnclassified.frames[0].id;
  emptyUnclassified.tags = [{ id: "owned", name: "owned", direction: "forward", frameIds: [ownedFrame] }];
  const firstUnclassified = addFrameToAnimationGroup(emptyUnclassified, null);
  assert.deepEqual(unclassifiedFrameIds(firstUnclassified.document), [firstUnclassified.frameId]);
});

test("프레임 삭제는 세트에서 해당 ID를 제거하고 마지막 프레임은 지킨다", () => {
  let document = createDocument({ width: 1, height: 1 });
  document = addFrame(document, document.frames[0].id);
  document = addFrame(document, document.frames[1].id);
  document = addAnimationTag(document, { name: "공격", frameIds: document.frames.map((frame) => frame.id), direction: "forward" });
  const removed = document.frames[2].id;
  document = deleteAnimationFrame(document, removed);
  assert.deepEqual(document.tags[0].frameIds, document.frames.map((frame) => frame.id));
  document = deleteAnimationFrame(document, document.frames[0].id);
  assert.deepEqual(document.tags[0].frameIds, [document.frames[0].id]);
  assert.throws(() => deleteAnimationFrame(document, document.frames[0].id), /마지막 프레임/);
});

test("레이어를 추가·복제·이동·삭제하고 마지막 레이어는 지킨다", () => {
  let document = createDocument({ width: 1, height: 1 });
  document = addLayer(document, "잉크");
  const ink = document.layers[0].id;
  document = duplicateLayer(document, ink);
  assert.equal(document.layers.length, 3);
  document = moveLayer(document, ink, 2);
  assert.equal(document.layers[2].id, ink);
  document = deleteLayer(document, ink);
  document = deleteLayer(document, document.layers[0].id);
  assert.throws(() => deleteLayer(document, document.layers[0].id), /마지막 레이어/);
});

test("태그 이름을 검증한다", () => {
  let document = createDocument({ width: 1, height: 1 });
  document = addFrame(document, document.frames[0].id);
  document = addAnimationTag(document, { name: "idle", frameIds: document.frames.map((frame) => frame.id), direction: "pingPong" });
  assert.throws(() => addAnimationTag(document, { name: "idle", frameIds: [], direction: "forward" }), /이름/);
});
