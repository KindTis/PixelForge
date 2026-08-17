import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { createDocument, createProject } from "../src/core/document.ts";
import { EditorWorkspace } from "../src/client/editor/EditorWorkspace.tsx";

type CanvasProps = Record<string, (event: PointerEventLike) => void>;
type PointerEventLike = {
  button: number;
  clientX: number;
  clientY: number;
  currentTarget: CanvasLike;
  pointerId: number;
  preventDefault(): void;
};
type CanvasLike = {
  width: number;
  height: number;
  clientWidth: number;
  clientHeight: number;
  getBoundingClientRect(): { left: number; top: number };
  getContext(): CanvasRenderingContext2D;
  setPointerCapture(pointerId: number): void;
};

function workspaceCanvas(project: ReturnType<typeof createProject>, captures: number[]): { props: CanvasProps; canvas: CanvasLike } {
  const context = {
    setTransform() {}, clearRect() {}, fillRect() {}, drawImage() {}, putImageData() {},
    strokeRect() {}, setLineDash() {}, save() {}, restore() {}, beginPath() {},
    moveTo() {}, lineTo() {}, stroke() {},
  } as unknown as CanvasRenderingContext2D;
  const canvas: CanvasLike = {
    width: 16, height: 16, clientWidth: 16, clientHeight: 16,
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    getContext: () => context,
    setPointerCapture: () => { captures.push(1); },
  };
  const internals = (React as unknown as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown } })
    .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const previous = internals.H;
  let refIndex = 0;
  internals.H = {
    useRef(initial: unknown) { return { current: refIndex++ === 2 ? canvas : initial }; },
    useState(initial: unknown) { return [initial, () => {}]; },
    useEffect() {},
    useImperativeHandle() {},
  };
  try {
    const element = (EditorWorkspace as unknown as { render: (props: Record<string, unknown>, ref: null) => { props: { children: unknown } } }).render({
      project,
      frameIndex: 0,
      readOnly: false,
      onFrameIndex() {},
      onChange() {},
      onSave() {},
      generationPanel: () => null,
      saveState: "저장됨",
      onError() {},
    }, null);
    const findCanvas = (node: unknown): CanvasProps | undefined => {
      if (!node || typeof node !== "object") return undefined;
      const value = node as { type?: unknown; props?: { children?: unknown } & CanvasProps };
      if (value.type === "canvas") return value.props;
      const children = value.props?.children;
      return Array.isArray(children)
        ? children.map(findCanvas).find(Boolean)
        : findCanvas(children);
    };
    return { props: findCanvas(element) ?? (() => { throw new Error("캔버스를 찾지 못했습니다."); })(), canvas };
  } finally {
    internals.H = previous;
  }
}

function pointerEvent(canvas: CanvasLike): PointerEventLike {
  return { button: 0, clientX: 5, clientY: 5, currentTarget: canvas, pointerId: 1, preventDefault() {} };
}

test("포인터 종료는 부모 갱신 전에도 커밋된 도형 문서를 렌더링한다", () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousImageData = globalThis.ImageData;
  const rendered: Uint8ClampedArray[] = [];
  Object.assign(globalThis, {
    window: { devicePixelRatio: 1 },
    document: { createElement: () => ({ width: 0, height: 0, getContext: () => ({ putImageData: (image: { data: Uint8ClampedArray }) => rendered.push(image.data), fillRect() {} }) }) },
    ImageData: class { constructor(readonly data: Uint8ClampedArray) {} },
  });

  try {
    const project = createProject("테스트", createDocument({ width: 1, height: 1 }));
    const captures: number[] = [];
    const { props, canvas } = workspaceCanvas(project, captures);
    const event = pointerEvent(canvas);
    props.onPointerDown(event);
    props.onPointerUp(event);

    assert.deepEqual(Array.from(rendered.at(-1) ?? []), [20, 22, 26, 255]);
  } finally {
    Object.assign(globalThis, { window: previousWindow, document: previousDocument, ImageData: previousImageData });
  }
});

test("잠긴 레이어는 포인터 편집을 시작하거나 커밋하지 않는다", () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousImageData = globalThis.ImageData;
  Object.assign(globalThis, {
    window: { devicePixelRatio: 1 },
    document: { createElement: () => ({ width: 0, height: 0, getContext: () => ({ putImageData() {}, fillRect() {} }) }) },
    ImageData: class {},
  });
  const project = createProject("테스트", createDocument({ width: 1, height: 1 }));
  project.document.layers[0].locked = true;
  const captures: number[] = [];
  const { props, canvas } = workspaceCanvas(project, captures);
  const event = pointerEvent(canvas);

  try {
    props.onPointerDown(event);
    props.onPointerUp(event);

    assert.deepEqual(captures, []);
  } finally {
    Object.assign(globalThis, { window: previousWindow, document: previousDocument, ImageData: previousImageData });
  }
});
