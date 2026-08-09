import assert from "node:assert/strict";
import test from "node:test";
import { History, applyCommand } from "../src/core/commands.ts";
import { createDocument } from "../src/core/document.ts";
import { celKey } from "../src/core/types.ts";

test("픽셀 변경은 실행 취소와 다시 실행을 왕복한다", () => {
  const document = createDocument({ width: 2, height: 2 });
  const cel = Object.values(document.cels)[0];
  const history = new History(document);
  history.execute({ type: "setPixels", celId: cel.id, pixels: [{ x: 1, y: 0, rgba: [255, 0, 0, 255] }] });

  assert.deepEqual(Array.from(history.document.images[history.document.cels[Object.keys(history.document.cels)[0]].imageId].data.slice(4, 8)), [255, 0, 0, 255]);
  history.undo();
  assert.deepEqual(Array.from(Object.values(history.document.images)[0].data.slice(4, 8)), [0, 0, 0, 0]);
  history.redo();
  assert.deepEqual(Array.from(Object.values(history.document.images)[0].data.slice(4, 8)), [255, 0, 0, 255]);
});

test("연결 셀을 편집하면 대상 셀만 자동 분리한다", () => {
  const document = createDocument({ width: 1, height: 1 });
  const sourceFrame = document.frames[0];
  const layer = document.layers[0];
  const sourceCel = document.cels[celKey(sourceFrame.id, layer.id)];
  const nextFrame = { id: crypto.randomUUID(), durationMs: 100 };
  const linkedCel = { ...sourceCel, id: crypto.randomUUID() };
  document.frames.push(nextFrame);
  document.cels[celKey(nextFrame.id, layer.id)] = linkedCel;

  const result = applyCommand(document, { type: "setPixels", celId: linkedCel.id, pixels: [{ x: 0, y: 0, rgba: [1, 2, 3, 255] }] });
  const edited = result.cels[celKey(nextFrame.id, layer.id)];
  assert.notEqual(edited.imageId, sourceCel.imageId);
  assert.deepEqual(Array.from(result.images[edited.imageId].data), [1, 2, 3, 255]);
  assert.deepEqual(Array.from(result.images[sourceCel.imageId].data), [0, 0, 0, 0]);
});

test("잠긴 레이어 편집을 거부하고 트랜잭션을 한 단계로 취소한다", () => {
  const document = createDocument({ width: 2, height: 1 });
  const cel = Object.values(document.cels)[0];
  document.layers[0].locked = true;
  assert.throws(() => applyCommand(document, { type: "setPixels", celId: cel.id, pixels: [{ x: 0, y: 0, rgba: [1, 1, 1, 255] }] }), /잠긴 레이어/);

  document.layers[0].locked = false;
  const history = new History(document);
  history.beginTransaction();
  history.execute({ type: "setPixels", celId: cel.id, pixels: [{ x: 0, y: 0, rgba: [1, 1, 1, 255] }] });
  history.execute({ type: "setPixels", celId: cel.id, pixels: [{ x: 1, y: 0, rgba: [2, 2, 2, 255] }] });
  history.commitTransaction();
  history.undo();
  assert.deepEqual(Array.from(Object.values(history.document.images)[0].data), [0, 0, 0, 0, 0, 0, 0, 0]);
});

test("구조 변경도 히스토리 한 단계로 기록한다", () => {
  const document = createDocument({ width: 1, height: 1 });
  const history = new History(document);
  const renamed = { ...document, layers: [{ ...document.layers[0], name: "잉크" }] };
  history.replace(renamed);
  assert.equal(history.document.layers[0].name, "잉크");
  history.undo();
  assert.equal(history.document.layers[0].name, "레이어 1");
});
