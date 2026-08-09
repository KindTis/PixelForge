import assert from "node:assert/strict";
import test from "node:test";
import { decodePng, encodePng } from "../src/server/png.ts";

test("RGBA 픽셀을 PNG로 인코딩하고 동일하게 복원한다", () => {
  const data = new Uint8ClampedArray([
    255, 0, 0, 255,
    0, 0, 0, 0,
  ]);

  const png = encodePng(2, 1, data);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const decoded = decodePng(png);
  assert.equal(decoded.width, 2);
  assert.equal(decoded.height, 1);
  assert.deepEqual([...decoded.data], [...data]);
});

test("PNG가 아닌 데이터는 거부한다", () => {
  assert.throws(() => decodePng(Buffer.from("not png")), /PNG 시그니처/);
});
