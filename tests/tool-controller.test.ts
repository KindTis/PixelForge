import assert from "node:assert/strict";
import test from "node:test";
import { ToolController, screenToPixel, toolCursorOverlay, type ToolCursorSettings } from "../src/core/tool-controller.ts";

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

test("도구 범위 커서는 실제 한 번의 도장과 같은 문서 픽셀을 반환한다", () => {
  const image = { width: 6, height: 5, data: new Uint8ClampedArray(6 * 5 * 4) };
  const bounds = { documentWidth: 8, documentHeight: 7, celX: 1, celY: 1 };
  const point = { x: 2, y: 2 };
  const selection = new Uint8Array(image.width * image.height).fill(1);
  selection[2 * image.width + 2] = 0;
  const cases: ToolCursorSettings[] = [
    { tool: "pencil", brushSize: 1, brushShape: "square" },
    { tool: "pencil", brushSize: 2, brushShape: "square" },
    { tool: "pencil", brushSize: 2, brushShape: "circle" },
    { tool: "eraser", brushSize: 1, customBrush: [{ x: -1, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 1 }] },
    { tool: "line", brushSize: 1, brushShape: "square", mirrorX: true, mirrorY: true },
    { tool: "rectangle", brushSize: 2, brushShape: "square", selection },
  ];

  for (const settings of cases) {
    const controller = new ToolController({ ...settings, celId: "cel", color: [1, 2, 3, 255] }, image);
    controller.pointerDown(point);
    const actual = controller.pointerUp(point).command!.pixels
      .map(({ x, y }) => `${x + bounds.celX},${y + bounds.celY}`)
      .sort();
    const cursor = toolCursorOverlay(
      { x: point.x + bounds.celX, y: point.y + bounds.celY },
      settings,
      image,
      bounds,
    ).pixels.map(({ x, y }) => `${x},${y}`).sort();
    assert.deepEqual(cursor, actual, JSON.stringify(settings));
  }
});

test("스프레이 커서는 난수 없이 도달 가능한 중심의 도장 합집합을 반환한다", () => {
  const image = { width: 12, height: 12, data: new Uint8ClampedArray(12 * 12 * 4) };
  const settings: ToolCursorSettings = { tool: "spray", brushSize: 1, brushShape: "square" };
  const bounds = { documentWidth: 12, documentHeight: 12, celX: 0, celY: 0 };
  const first = toolCursorOverlay({ x: 5, y: 5 }, settings, image, bounds).pixels;
  const second = toolCursorOverlay({ x: 5, y: 5 }, settings, image, bounds).pixels;

  assert.deepEqual(second, first);
  assert.ok(first.some(({ x, y }) => x === 7 && y === 6));
  assert.ok(!first.some(({ x, y }) => x === 7 && y === 7));
});

test("대상점 도구는 선택·셀·문서 경계를 도구별로 적용한다", () => {
  const image = { width: 2, height: 2, data: new Uint8ClampedArray(2 * 2 * 4) };
  const bounds = { documentWidth: 6, documentHeight: 6, celX: 2, celY: 2 };
  const selection = new Uint8Array([1, 0, 0, 0]);
  const cursor = (tool: ToolCursorSettings["tool"], point: { x: number; y: number }) => toolCursorOverlay(
    point,
    { tool, brushSize: 1, brushShape: "square", selection },
    image,
    bounds,
  ).pixels;

  assert.deepEqual(cursor("fill", { x: 2, y: 2 }), [{ x: 2, y: 2 }]);
  assert.deepEqual(cursor("fill", { x: 3, y: 2 }), []);
  assert.deepEqual(cursor("eyedropper", { x: 0, y: 0 }), []);
  assert.deepEqual(cursor("wand", { x: 0, y: 0 }), []);
  for (const tool of ["gradient", "select", "lasso"] as const) {
    assert.deepEqual(cursor(tool, { x: 0, y: 0 }), [{ x: 0, y: 0 }], tool);
    assert.deepEqual(cursor(tool, { x: -1, y: 0 }), [], tool);
  }
});

test("도장 중심이 문서 밖이어도 편집 가능한 교집합과 셀 축을 반환한다", () => {
  const image = { width: 4, height: 2, data: new Uint8ClampedArray(4 * 2 * 4) };
  const overlay = toolCursorOverlay(
    { x: -1, y: 0 },
    { tool: "pencil", brushSize: 2, brushShape: "square", mirrorX: true, mirrorY: true },
    image,
    { documentWidth: 2, documentHeight: 2, celX: 0, celY: 0 },
  );

  assert.deepEqual(overlay.pixels.map(({ x, y }) => `${x},${y}`).sort(), ["0,0", "0,1"]);
  assert.equal(overlay.mirrorAxisX, 2);
  assert.equal(overlay.mirrorAxisY, 1);
});

test("최대 스프레이는 최종 버퍼 크기에 가까운 작업량으로 범위를 계산한다", () => {
  const image = { width: 2, height: 2, data: new Uint8ClampedArray(2 * 2 * 4) };
  const settings: ToolCursorSettings = { tool: "spray", brushSize: 32, brushShape: "square" };
  const bounds = { documentWidth: 2, documentHeight: 2, celX: 0, celY: 0 };
  const originalFlatMap = Array.prototype.flatMap as (...args: any[]) => any;
  let callbackCalls = 0;
  Array.prototype.flatMap = function (this: unknown[], callback: (...args: any[]) => unknown, ...args: any[]) {
    return originalFlatMap.call(this, (value: unknown, index: number, array: unknown[]) => {
      callbackCalls += 1;
      return callback(value, index, array);
    }, ...args);
  } as typeof Array.prototype.flatMap;

  try {
    const overlay = toolCursorOverlay({ x: 0, y: 0 }, settings, image, bounds);
    assert.deepEqual(overlay.pixels.map(({ x, y }) => `${x},${y}`).sort(), ["0,0", "0,1", "1,0", "1,1"]);
    assert.ok(callbackCalls <= image.width * image.height * 4, `flatMap callback count: ${callbackCalls}`);
  } finally {
    Array.prototype.flatMap = originalFlatMap as typeof Array.prototype.flatMap;
  }
});
