import assert from "node:assert/strict";
import test from "node:test";
import { ToolController, screenToPixel } from "../src/core/tool-controller.ts";

const blank = { width: 4, height: 4, data: new Uint8ClampedArray(4 * 4 * 4) };

test("확대와 이동을 적용한 화면 좌표를 정수 픽셀로 바꾼다", () => {
  assert.deepEqual(screenToPixel(24, 40, { left: 0, top: 0 }, { zoom: 8, panX: 16, panY: 24 }), { x: 1, y: 2 });
});

test("연필 드래그는 끊김 없는 한 픽셀 명령을 반환한다", () => {
  const controller = new ToolController({ tool: "pencil", celId: "cel", color: [255, 0, 0, 255], brushSize: 1 }, blank);
  controller.pointerDown({ x: 0, y: 0 });
  controller.pointerMove({ x: 3, y: 3 });
  const result = controller.pointerUp({ x: 3, y: 3 });
  assert.equal(result.command?.type, "setPixels");
  assert.deepEqual(result.command?.pixels.map(({ x, y }) => ({ x, y })), [
    { x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 },
  ]);
});

test("직선 드래그는 놓기 전에 프리뷰 명령을 반환한다", () => {
  const controller = new ToolController({ tool: "line", celId: "cel", color: [255, 0, 0, 255], brushSize: 1 }, blank);
  controller.pointerDown({ x: 0, y: 0 });
  const preview = controller.pointerMove({ x: 3, y: 3 });
  assert.deepEqual(preview, {
    command: {
      type: "setPixels",
      celId: "cel",
      pixels: [
        { x: 0, y: 0, rgba: [255, 0, 0, 255] },
        { x: 1, y: 1, rgba: [255, 0, 0, 255] },
        { x: 2, y: 2, rgba: [255, 0, 0, 255] },
        { x: 3, y: 3, rgba: [255, 0, 0, 255] },
      ],
    },
  });
});

test("채우기, 스포이드와 선택 도구가 각 결과를 반환한다", () => {
  const fill = new ToolController({ tool: "fill", celId: "cel", color: [1, 2, 3, 255], brushSize: 1 }, blank);
  fill.pointerDown({ x: 0, y: 0 });
  assert.equal(fill.pointerUp({ x: 0, y: 0 }).command?.pixels.length, 16);

  const colored = { ...blank, data: new Uint8ClampedArray(blank.data) };
  colored.data.set([9, 8, 7, 255], 4);
  const picker = new ToolController({ tool: "eyedropper", celId: "cel", color: [0, 0, 0, 255], brushSize: 1 }, colored);
  picker.pointerDown({ x: 1, y: 0 });
  assert.deepEqual(picker.pointerUp({ x: 1, y: 0 }).color, [9, 8, 7, 255]);

  const select = new ToolController({ tool: "select", celId: "cel", color: [0, 0, 0, 255], brushSize: 1 }, blank);
  select.pointerDown({ x: 1, y: 1 });
  assert.equal(select.pointerUp({ x: 2, y: 2 }).selection?.reduce((sum, value) => sum + value, 0), 4);
});

test("대칭 연필은 반대편 픽셀을 중복 없이 포함한다", () => {
  const controller = new ToolController({ tool: "pencil", celId: "cel", color: [1, 1, 1, 255], brushSize: 1, mirrorX: true }, blank);
  controller.pointerDown({ x: 0, y: 1 });
  const points = controller.pointerUp({ x: 0, y: 1 }).command?.pixels.map(({ x, y }) => `${x},${y}`).sort();
  assert.deepEqual(points, ["0,1", "3,1"]);
});

test("올가미와 사용자 브러시를 드래그에 적용한다", () => {
  const lasso = new ToolController({ tool: "lasso", celId: "cel", color: [1, 1, 1, 255], brushSize: 1 }, blank);
  lasso.pointerDown({ x: 0, y: 0 });
  lasso.pointerMove({ x: 3, y: 0 });
  lasso.pointerMove({ x: 0, y: 3 });
  assert.ok((lasso.pointerUp({ x: 0, y: 0 }).selection?.reduce((sum, value) => sum + value, 0) ?? 0) > 0);

  const brush = new ToolController({ tool: "pencil", celId: "cel", color: [1, 1, 1, 255], brushSize: 1, customBrush: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }, blank);
  brush.pointerDown({ x: 1, y: 1 });
  assert.deepEqual(brush.pointerUp({ x: 1, y: 1 }).command?.pixels.map(({ x, y }) => `${x},${y}`).sort(), ["1,1", "2,1"]);
});

test("스프레이는 드래그 경로 전체에 분사한다", () => {
  const controller = new ToolController({ tool: "spray", celId: "cel", color: [1, 1, 1, 255], brushSize: 1, random: () => 0.5 }, blank);
  controller.pointerDown({ x: 0, y: 0 });
  const pixels = controller.pointerUp({ x: 3, y: 0 }).command?.pixels.map(({ x, y }) => `${x},${y}`).sort();
  assert.deepEqual(pixels, ["0,0", "1,0", "2,0", "3,0"]);
});
