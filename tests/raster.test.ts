import assert from "node:assert/strict";
import test from "node:test";
import {
  ellipse,
  floodFill,
  gradient,
  line,
  mirror,
  polygon,
  quadraticCurve,
  rectangle,
  spray,
  stampBrush,
} from "../src/core/raster.ts";

test("대각선은 끊기지 않은 정수 픽셀을 만든다", () => {
  assert.deepEqual(line({ x: 0, y: 0 }, { x: 3, y: 3 }), [
    { x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 },
  ]);
});

test("사각형과 타원은 외곽 또는 채운 좌표를 만든다", () => {
  assert.equal(rectangle({ x: 0, y: 0 }, { x: 2, y: 2 }, false).length, 8);
  assert.equal(rectangle({ x: 0, y: 0 }, { x: 2, y: 2 }, true).length, 9);
  const oval = ellipse({ x: 0, y: 0 }, { x: 4, y: 2 }, false);
  assert.ok(oval.some(({ x, y }) => x === 0 && y === 1));
  assert.ok(oval.some(({ x, y }) => x === 4 && y === 1));
});

test("곡선과 다각형 채우기는 경계를 포함한다", () => {
  const curve = quadraticCurve({ x: 0, y: 0 }, { x: 2, y: 3 }, { x: 4, y: 0 });
  assert.deepEqual(curve[0], { x: 0, y: 0 });
  assert.deepEqual(curve.at(-1), { x: 4, y: 0 });
  assert.ok(polygon([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 2, y: 4 }], true).some(({ x, y }) => x === 2 && y === 2));
});

test("채우기는 시작점과 연결된 같은 색만 바꾼다", () => {
  const data = new Uint8ClampedArray([
    0, 0, 0, 255, 0, 0, 0, 255, 255, 0, 0, 255,
    0, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255,
  ]);
  const changes = floodFill({ width: 3, height: 2, data }, { x: 0, y: 0 }, [0, 255, 0, 255]);
  assert.deepEqual(changes.map(({ x, y }) => `${x},${y}`).sort(), ["0,0", "0,1", "1,0"]);
  assert.equal(floodFill({ width: 3, height: 2, data }, { x: 0, y: 0 }, [0, 0, 0, 255]).length, 0);
});

test("그라디언트, 스프레이, 브러시와 대칭은 결정적으로 좌표를 만든다", () => {
  const colors = gradient(3, 1, { x: 0, y: 0 }, { x: 2, y: 0 }, [0, 0, 0, 255], [255, 0, 0, 255]);
  assert.deepEqual(colors.map(({ rgba }) => rgba[0]), [0, 128, 255]);
  assert.deepEqual(spray({ x: 3, y: 4 }, 2, 3, () => 0.5), [{ x: 3, y: 4 }]);
  assert.equal(stampBrush([{ x: 1, y: 1 }], 3).length, 9);
  assert.equal(stampBrush([{ x: 1, y: 1 }], 3, "circle").length, 5);
  assert.deepEqual(mirror([{ x: 0, y: 1 }], 3, 3, true, false), [{ x: 0, y: 1 }, { x: 2, y: 1 }]);
});
