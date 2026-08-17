import assert from "node:assert/strict";
import test from "node:test";
import { CanvasRenderer } from "../src/client/editor/CanvasRenderer.ts";
import { createDocument } from "../src/core/document.ts";

test("문서 밖은 작업 영역 배경으로 가리고 문서 경계를 그린다", () => {
  const fillRects: number[][] = [];
  const clearRects: number[][] = [];
  const strokeRects: number[][] = [];
  const context = {
    setTransform() {},
    clearRect(...args: number[]) { clearRects.push(args); },
    fillRect(...args: number[]) { fillRects.push(args); },
    drawImage() {},
    putImageData() {},
    strokeRect(...args: number[]) { strokeRects.push(args); },
    setLineDash() {},
  } as unknown as CanvasRenderingContext2D;
  const canvas = {
    width: 200,
    height: 160,
    clientWidth: 200,
    clientHeight: 160,
    getContext: () => context,
  } as unknown as HTMLCanvasElement;
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousImageData = globalThis.ImageData;
  Object.assign(globalThis, {
    window: { devicePixelRatio: 1 },
    document: { createElement: () => ({ width: 0, height: 0, getContext: () => context }) },
    ImageData: class {},
  });

  try {
    const sprite = createDocument({ width: 10, height: 8 });
    new CanvasRenderer(canvas).render(sprite, {
      frameId: sprite.frames[0].id,
      zoom: 8,
      panX: 60,
      panY: 48,
      showGrid: false,
      onionSkin: false,
      tilePreview: false,
    });

    assert.deepEqual(fillRects, [[0, 0, 200, 160]]);
    assert.deepEqual(clearRects, [[0, 0, 200, 160], [60, 48, 80, 64]]);
    assert.deepEqual(strokeRects, [[60.5, 48.5, 79, 63]]);
  } finally {
    Object.assign(globalThis, {
      window: previousWindow,
      document: previousDocument,
      ImageData: previousImageData,
    });
  }
});

test("도구 커서 외곽선과 셀 대칭축을 확대·이동 좌표에 그린다", () => {
  const strokeRects: Array<{ args: number[]; style: string; width: number }> = [];
  const segments: number[][] = [];
  let start: number[] = [];
  const context = {
    strokeStyle: "",
    lineWidth: 1,
    setTransform() {}, clearRect() {}, fillRect() {}, drawImage() {}, putImageData() {},
    setLineDash() {}, save() {}, restore() {}, beginPath() {}, stroke() {},
    moveTo(x: number, y: number) { start = [x, y]; },
    lineTo(x: number, y: number) { segments.push([...start, x, y]); },
    strokeRect(this: { strokeStyle: string; lineWidth: number }, ...args: number[]) {
      strokeRects.push({ args, style: this.strokeStyle, width: this.lineWidth });
    },
  } as unknown as CanvasRenderingContext2D;
  const canvas = {
    width: 80, height: 80, clientWidth: 80, clientHeight: 80,
    getContext: () => context,
  } as unknown as HTMLCanvasElement;
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousImageData = globalThis.ImageData;
  Object.assign(globalThis, {
    window: { devicePixelRatio: 1 },
    document: { createElement: () => ({ width: 0, height: 0, getContext: () => context }) },
    ImageData: class {},
  });

  try {
    const sprite = createDocument({ width: 4, height: 4 });
    new CanvasRenderer(canvas).render(sprite, {
      frameId: sprite.frames[0].id,
      zoom: 8,
      panX: 10,
      panY: 20,
      showGrid: false,
      onionSkin: false,
      tilePreview: false,
    }, {
      cursor: [{ x: 1, y: 2 }],
      mirrorAxisX: 2,
      mirrorAxisY: 1.5,
    });

    assert.deepEqual(strokeRects.filter(({ args }) => args[0] === 18.5 && args[1] === 36.5), [
      { args: [18.5, 36.5, 7, 7], style: "rgba(0,0,0,.9)", width: 3 },
      { args: [18.5, 36.5, 7, 7], style: "#fff", width: 1 },
    ]);
    assert.deepEqual(segments, [[26, 20, 26, 52], [10, 32, 42, 32]]);
  } finally {
    Object.assign(globalThis, {
      window: previousWindow,
      document: previousDocument,
      ImageData: previousImageData,
    });
  }
});
