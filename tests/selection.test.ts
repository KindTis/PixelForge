import assert from "node:assert/strict";
import test from "node:test";
import {
  extractSelection,
  flipSelection,
  lassoMask,
  magicWandMask,
  moveSelection,
  rectangleMask,
  rotateSelection,
  scaleSelectionNearest,
} from "../src/core/selection.ts";

test("마술봉은 같은 색이어도 연결된 섬만 선택한다", () => {
  const data = new Uint8ClampedArray([
    255, 0, 0, 255, 0, 0, 0, 0, 255, 0, 0, 255,
  ]);
  assert.deepEqual(Array.from(magicWandMask({ width: 3, height: 1, data }, { x: 0, y: 0 })), [1, 0, 0]);
});

test("사각형과 올가미가 캔버스 안의 마스크를 만든다", () => {
  assert.deepEqual(Array.from(rectangleMask(3, 2, { x: 1, y: 0 }, { x: 3, y: 1 })), [0, 1, 1, 0, 1, 1]);
  const lasso = lassoMask(3, 3, [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 0, y: 3 }]);
  assert.equal(lasso[0], 1);
  assert.equal(lasso[8], 0);
});

test("선택 영역을 이동하면 원본은 투명해지고 새 위치에 붙는다", () => {
  const source = { width: 3, height: 1, data: new Uint8ClampedArray([
    255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 0, 0,
  ]) };
  const moved = moveSelection(source, new Uint8Array([1, 0, 0]), 2, 0);
  assert.deepEqual(Array.from(moved.data), [0, 0, 0, 0, 0, 255, 0, 255, 255, 0, 0, 255]);
});

test("선택 픽셀을 뒤집고 회전하고 최근접 확대한다", () => {
  const source = { width: 2, height: 1, data: new Uint8ClampedArray([
    255, 0, 0, 255, 0, 255, 0, 255,
  ]) };
  const content = extractSelection(source, new Uint8Array([1, 1]));
  assert.deepEqual(Array.from(flipSelection(content, true, false).data), [0, 255, 0, 255, 255, 0, 0, 255]);
  const rotated = rotateSelection(content, "clockwise");
  assert.equal(rotated.width, 1);
  assert.equal(rotated.height, 2);
  assert.deepEqual(Array.from(rotated.data), Array.from(source.data));
  assert.deepEqual(Array.from(scaleSelectionNearest(content, 4, 1).data), [
    255, 0, 0, 255, 255, 0, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255,
  ]);
});
