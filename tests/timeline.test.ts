import assert from "node:assert/strict";
import test from "node:test";
import { addAnimationTag } from "../src/core/animation.ts";
import { createDocument } from "../src/core/document.ts";
import { celKey } from "../src/core/types.ts";
import {
  addFrame,
  addLayer,
  deleteFrame,
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

test("프레임 삭제는 세트에서 해당 ID를 제거하고 마지막 프레임은 지킨다", () => {
  let document = createDocument({ width: 1, height: 1 });
  document = addFrame(document, document.frames[0].id);
  document = addFrame(document, document.frames[1].id);
  document = addAnimationTag(document, { name: "공격", frameIds: document.frames.map((frame) => frame.id), direction: "forward" });
  const removed = document.frames[2].id;
  document = deleteFrame(document, removed);
  assert.deepEqual(document.tags[0].frameIds, document.frames.map((frame) => frame.id));
  document = deleteFrame(document, document.frames[0].id);
  assert.deepEqual(document.tags[0].frameIds, [document.frames[0].id]);
  assert.throws(() => deleteFrame(document, document.frames[0].id), /마지막 프레임/);
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
