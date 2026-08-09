import assert from "node:assert/strict";
import test from "node:test";
import { convertDocumentToIndexed, indexedToRgba, nearestPaletteColor, quantizeToPalette, removePaletteColor, replaceColor, sameColor } from "../src/core/palette.ts";
import { createDocument } from "../src/core/document.ts";

test("RGBA 픽셀을 가장 가까운 팔레트 인덱스로 바꾸고 복원한다", () => {
  const palette = [[0, 0, 0, 255], [255, 255, 255, 255]] as const;
  const source = { width: 2, height: 1, data: new Uint8ClampedArray([10, 20, 10, 255, 240, 250, 255, 255]) };
  const indices = quantizeToPalette(source, palette);
  assert.deepEqual(Array.from(indices), [0, 1]);
  assert.deepEqual(Array.from(indexedToRgba(indices, 2, 1, palette).data), [0, 0, 0, 255, 255, 255, 255, 255]);
});

test("색상 치환은 선택 마스크를 존중한다", () => {
  const source = { width: 2, height: 1, data: new Uint8ClampedArray([1, 2, 3, 255, 1, 2, 3, 255]) };
  const result = replaceColor(source, [1, 2, 3, 255], [9, 8, 7, 255], new Uint8Array([0, 1]));
  assert.deepEqual(Array.from(result.data), [1, 2, 3, 255, 9, 8, 7, 255]);
});

test("256색을 넘는 팔레트와 사용 중 색상 제거를 거부한다", () => {
  const palette = Array.from({ length: 257 }, () => [0, 0, 0, 255] as const);
  assert.throws(() => quantizeToPalette({ width: 1, height: 1, data: new Uint8ClampedArray(4) }, palette), /256/);
  assert.throws(() => removePaletteColor([[0, 0, 0, 255], [255, 255, 255, 255]], 1, new Uint8Array([1])), /사용 중/);
});

test("인덱스 모드 변환은 투명을 보존하고 모든 픽셀을 팔레트 색으로 제한한다", () => {
  const document = createDocument({ width: 2, height: 1 });
  const image = Object.values(document.images)[0];
  image.data.set([230, 230, 230, 255, 255, 255, 255, 0]);
  const indexed = convertDocumentToIndexed(document);
  assert.equal(indexed.colorMode, "indexed");
  assert.ok(indexed.palette.some((entry) => entry.color[3] === 0));
  assert.deepEqual(Array.from(Object.values(indexed.images)[0].data), [255, 255, 255, 255, 0, 0, 0, 0]);
  assert.deepEqual(nearestPaletteColor([200, 200, 200, 255], indexed.palette.map((entry) => entry.color)), [255, 255, 255, 255]);
});

test("팔레트 색상 비교는 알파 채널을 구분한다", () => {
  assert.equal(sameColor([0, 0, 0, 255], [0, 0, 0, 0]), false);
  assert.equal(sameColor([1, 2, 3, 4], [1, 2, 3, 4]), true);
});
