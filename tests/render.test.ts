import assert from "node:assert/strict";
import test from "node:test";
import { createDocument } from "../src/core/document.ts";
import { blendPixel, compositeFrame } from "../src/core/render.ts";
import { celKey } from "../src/core/types.ts";

test("보이는 레이어를 아래에서 위로 알파 합성한다", () => {
  const document = createDocument({ width: 1, height: 1 });
  const frame = document.frames[0];
  const bottom = document.layers[0];
  const bottomCel = document.cels[celKey(frame.id, bottom.id)];
  document.images[bottomCel.imageId].data.set([255, 0, 0, 255]);

  const top = { ...bottom, id: crypto.randomUUID(), name: "위", opacity: 0.5 };
  const imageId = crypto.randomUUID();
  document.layers.unshift(top);
  document.images[imageId] = { width: 1, height: 1, data: new Uint8ClampedArray([0, 0, 255, 255]) };
  document.cels[celKey(frame.id, top.id)] = { id: crypto.randomUUID(), imageId, x: 0, y: 0, opacity: 1 };

  assert.deepEqual(Array.from(compositeFrame(document, frame.id).data), [128, 0, 128, 255]);
  top.visible = false;
  assert.deepEqual(Array.from(compositeFrame(document, frame.id).data), [255, 0, 0, 255]);
});

test("지원 혼합 모드가 정확한 RGBA를 반환한다", () => {
  assert.deepEqual(blendPixel([0, 0, 255, 255], [255, 0, 0, 255], "normal", 0.5), [128, 0, 128, 255]);
  assert.deepEqual(blendPixel([128, 128, 128, 255], [128, 255, 255, 255], "multiply", 1), [64, 128, 128, 255]);
  assert.deepEqual(blendPixel([128, 0, 0, 255], [128, 255, 255, 255], "screen", 1), [192, 255, 255, 255]);
  assert.deepEqual(blendPixel([100, 100, 100, 255], [200, 200, 200, 255], "add", 1), [255, 255, 255, 255]);
});

test("레이어 혼합 모드와 셀 위치를 적용한다", () => {
  const document = createDocument({ width: 2, height: 1 });
  const frame = document.frames[0];
  const bottom = document.layers[0];
  const bottomCel = document.cels[celKey(frame.id, bottom.id)];
  document.images[bottomCel.imageId].data.set([128, 128, 128, 255, 0, 0, 0, 0]);

  const top = { ...bottom, id: crypto.randomUUID(), name: "곱하기", blendMode: "multiply" as const };
  const imageId = crypto.randomUUID();
  document.layers.unshift(top);
  document.images[imageId] = { width: 1, height: 1, data: new Uint8ClampedArray([128, 255, 255, 255]) };
  document.cels[celKey(frame.id, top.id)] = { id: crypto.randomUUID(), imageId, x: 0, y: 0, opacity: 1 };

  assert.deepEqual(Array.from(compositeFrame(document, frame.id).data), [64, 128, 128, 255, 0, 0, 0, 0]);
});
