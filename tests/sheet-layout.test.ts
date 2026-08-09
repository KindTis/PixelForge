import assert from "node:assert/strict";
import test from "node:test";
import { layoutSheet, trimBounds } from "../src/core/sheet-layout.ts";

test("4열 시트는 padding과 margin을 포함한다", () => {
  const layout = layoutSheet(Array.from({ length: 5 }, (_, index) => ({ id: String(index), width: 32, height: 32, sourceX: 0, sourceY: 0 })), { columns: 4, padding: 2, margin: 1 });
  assert.deepEqual(layout.frames[4].rect, { x: 1, y: 35, width: 32, height: 32 });
  assert.deepEqual({ width: layout.width, height: layout.height }, { width: 136, height: 68 });
});

test("투명 영역 경계를 자르고 완전 투명 프레임은 1×1로 둔다", () => {
  const data = new Uint8ClampedArray(4 * 3 * 4);
  data.set([1, 2, 3, 255], (1 * 4 + 2) * 4);
  assert.deepEqual(trimBounds({ width: 4, height: 3, data }), { x: 2, y: 1, width: 1, height: 1 });
  assert.deepEqual(trimBounds({ width: 2, height: 2, data: new Uint8ClampedArray(16) }), { x: 0, y: 0, width: 1, height: 1 });
});

test("가변 크기 프레임은 행 높이와 최대 너비로 배치한다", () => {
  const layout = layoutSheet([
    { id: "a", width: 2, height: 3, sourceX: 0, sourceY: 0 },
    { id: "b", width: 4, height: 1, sourceX: 1, sourceY: 2 },
    { id: "c", width: 1, height: 2, sourceX: 0, sourceY: 0 },
  ], { columns: 2, padding: 1, margin: 0 });
  assert.deepEqual(layout.frames.map((frame) => frame.rect), [
    { x: 0, y: 0, width: 2, height: 3 },
    { x: 3, y: 0, width: 4, height: 1 },
    { x: 0, y: 4, width: 1, height: 2 },
  ]);
  assert.deepEqual({ width: layout.width, height: layout.height }, { width: 7, height: 6 });
});
