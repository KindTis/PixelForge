import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { createDocument, createProject } from "../src/core/document.ts";
import { duplicateFrame } from "../src/core/timeline.ts";
import { celKey } from "../src/core/types.ts";
import { EditorWorkspace, type GenerationPanelContext } from "../src/client/editor/EditorWorkspace.tsx";

type CanvasProps = Record<string, (event: PointerEventLike) => void>;
type ElementNode = { type?: unknown; props?: Record<string, unknown> & { children?: unknown } };
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

function elements(node: unknown): ElementNode[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object") return [];
  const value = node as ElementNode;
  const children = value.props?.children;
  return [value, ...(Array.isArray(children) ? children : [children]).flatMap(elements)];
}

function renderedText(node: unknown): string {
  if (Array.isArray(node)) return node.map(renderedText).join(" ");
  if (typeof node === "string") return node;
  if (!node || typeof node !== "object") return "";
  const children = (node as ElementNode).props?.children;
  return (Array.isArray(children) ? children : [children]).map(renderedText).join(" ");
}

function workspaceCanvas(
  project: ReturnType<typeof createProject>,
  captures: number[],
  overrides: Record<string, unknown> = {},
): { props: CanvasProps; canvas: CanvasLike; element: unknown } {
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
      selectedAnimationTagId: undefined,
      onSelectedAnimationTagId() {},
      onChange() {},
      onSave() {},
      generationPanel: () => null,
      saveState: "저장됨",
      onError() {},
      ...overrides,
    }, null);
    const canvasElement = elements(element).find((value) => value.type === "canvas");
    return {
      props: canvasElement?.props as CanvasProps ?? (() => { throw new Error("캔버스를 찾지 못했습니다."); })(),
      canvas,
      element,
    };
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

test("태그 선택은 aria-pressed와 재생 첫 프레임을 갱신하고 삭제는 전체 범위로 돌아간다", () => {
  let document = createDocument({ width: 1, height: 1 });
  document = duplicateFrame(document, document.frames[0].id);
  const layer = document.layers[0];
  document.cels[celKey(document.frames[1].id, layer.id)].imageId = document.cels[celKey(document.frames[0].id, layer.id)].imageId;
  const tagId = crypto.randomUUID();
  document.tags.push({
    id: tagId,
    name: "attack",
    fromFrameId: document.frames[0].id,
    toFrameId: document.frames[1].id,
    direction: "reverse",
  });
  const project = createProject("기사", document);
  const selected: Array<string | undefined> = [];
  const frameIndexes: number[] = [];
  const rendered = workspaceCanvas(project, [], {
    selectedAnimationTagId: undefined,
    onSelectedAnimationTagId: (id: string | undefined) => selected.push(id),
    onFrameIndex: (index: number) => frameIndexes.push(index),
  }).element;
  const attack = elements(rendered).find((value) => value.type === "button" && value.props?.children === "attack");
  assert.ok(attack);
  assert.equal(attack.props?.["aria-pressed"], false);
  (attack.props?.onClick as () => void)();
  assert.deepEqual(Array.from(selected), [tagId]);
  assert.deepEqual(frameIndexes, [1]);
  assert.match(renderedText(rendered), /연결된 셀 · 편집하면 현재 레이어의 셀만 자동 분리됩니다/);

  const selectedRendered = workspaceCanvas(project, [], {
    selectedAnimationTagId: tagId,
    onSelectedAnimationTagId: (id: string | undefined) => selected.push(id),
    onFrameIndex: (index: number) => frameIndexes.push(index),
  }).element;
  const remove = elements(selectedRendered).find((value) => value.type === "button"
    && value.props?.["aria-label"] === "attack 애니메이션 태그 삭제");
  assert.ok(remove);
  (remove.props?.onClick as () => void)();
  assert.equal(selected.at(-1), undefined);

  let context: GenerationPanelContext | undefined;
  workspaceCanvas(project, [], {
    generationPanel: (value: GenerationPanelContext) => { context = value; return null; },
  });
  assert.deepEqual(context, {
    activeFrameId: project.document.frames[0].id,
    activeFrameNumber: 1,
    activeLayer: project.document.layers[0],
    hasActiveCel: true,
  });
});
