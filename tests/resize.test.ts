import assert from "node:assert/strict";
import test from "node:test";
import { History } from "../src/core/commands.ts";
import { createDocument } from "../src/core/document.ts";
import { resizeCanvas, resizeImage } from "../src/core/resize.ts";
import { addFrame, addLayer, duplicateFrame } from "../src/core/timeline.ts";

test("캔버스 크기는 모든 셀을 기준점만큼 이동하고 픽셀 버퍼를 보존한다", () => {
  let document = createDocument({ width: 3, height: 2 });
  document = addFrame(document);
  document = addLayer(document);
  const images = document.images;

  const resized = resizeCanvas(document, 7, 6, "center", "end");

  assert.deepEqual([resized.width, resized.height], [7, 6]);
  assert.deepEqual(Object.values(resized.cels).map(({ x, y }) => [x, y]), Array(4).fill([2, 4]));
  assert.equal(resized.images, images);
  assert.deepEqual([document.width, document.height], [3, 2]);
});

test("이미지 크기는 연결 셀을 유지하며 모든 픽셀과 위치를 최근접 확대한다", () => {
  let document = createDocument({ width: 2, height: 2 });
  const linkedImageId = Object.values(document.cels)[0].imageId;
  document.images[linkedImageId].data.set([
    255, 0, 0, 255, 0, 255, 0, 255,
    0, 0, 255, 255, 0, 0, 0, 0,
  ]);
  document = duplicateFrame(document, document.frames[0].id);
  document = addLayer(document);
  for (const cel of Object.values(document.cels)) { cel.x = 1; cel.y = 1; }

  const history = new History(document);
  const resized = history.replace(resizeImage(document, 4, 6));
  const linkedKeys = document.frames.map((frame) => `${frame.id}:${document.layers[1].id}`);
  const image = resized.images[linkedImageId];
  const pixel = (x: number, y: number) => Array.from(image.data.slice((y * image.width + x) * 4, (y * image.width + x + 1) * 4));

  assert.deepEqual([resized.width, resized.height], [4, 6]);
  assert.equal(linkedKeys.every((key) => resized.cels[key].imageId === linkedImageId), true);
  assert.equal(Object.values(resized.images).every(({ width, height }) => width === 4 && height === 6), true);
  assert.equal(Object.values(resized.cels).every(({ x, y }) => x === 2 && y === 3), true);
  assert.deepEqual([pixel(0, 0), pixel(1, 2), pixel(2, 2), pixel(0, 3)], [
    [255, 0, 0, 255], [255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255],
  ]);
  assert.equal(history.undo(), document);
  assert.equal(history.redo(), resized);
});

test("크기는 1~4096 정수만 허용하고 같은 크기는 원본을 재사용한다", () => {
  const document = createDocument({ width: 2, height: 2 });

  assert.equal(resizeCanvas(document, 2, 2, "start", "start"), document);
  assert.equal(resizeImage(document, 2, 2), document);
  assert.throws(() => resizeCanvas(document, 0, 2, "start", "start"), /1~4096/);
  assert.throws(() => resizeImage(document, 2.5, 2), /1~4096/);
});
