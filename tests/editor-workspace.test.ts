import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { defaultAnimationSelection, type AnimationSelection } from "../src/core/animation.ts";
import { History } from "../src/core/commands.ts";
import { createDocument, createProject } from "../src/core/document.ts";
import { addFrame } from "../src/core/timeline.ts";
import { EditorWorkspace } from "../src/client/editor/EditorWorkspace.tsx";

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

function renderNestedComponents(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(renderNestedComponents);
  if (!node || typeof node !== "object") return node;
  const value = node as ElementNode;
  if (typeof value.type === "function") {
    return renderNestedComponents(value.type(value.props ?? {}));
  }
  return value.props
    ? { ...value, props: { ...value.props, children: renderNestedComponents(value.props.children) } }
    : value;
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
    useRef(initial: unknown) { return { current: refIndex++ === 0 ? canvas : initial }; },
    useState(initial: unknown) { return [initial, () => {}]; },
    useEffect() {},
    useImperativeHandle() {},
  };
  try {
    const element = (EditorWorkspace as unknown as { render: (props: Record<string, unknown>, ref: null) => { props: { children: unknown } } }).render({
      project,
      history: overrides.history ?? new History(project),
      selection: overrides.selection ?? defaultAnimationSelection(project.document),
      readOnly: false,
      onSelection() {},
      onChange() {},
      onSave() {},
      generationPanel: () => null,
      saveState: "저장됨",
      onError() {},
      ...overrides,
    }, null);
    const rendered = renderNestedComponents(element);
    const canvasElement = elements(rendered).find((value) => value.type === "canvas");
    return {
      props: canvasElement?.props as CanvasProps ?? {},
      canvas,
      element: rendered,
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

test("세트 선택은 표시 프레임과 현재 편집 프레임을 함께 바꾼다", () => {
  let document = createDocument({ width: 1, height: 1 });
  for (let index = 0; index < 3; index += 1) document = addFrame(document);
  const ids = document.frames.map((frame) => frame.id);
  const idleId = "idle";
  const walkId = "walk";
  document.tags = [
    { id: idleId, name: "idle", direction: "forward", frameIds: ids.slice(0, 2) },
    { id: walkId, name: "walk", direction: "reverse", frameIds: ids.slice(2) },
  ];
  const project = createProject("기사", document);
  const changes: AnimationSelection[] = [];
  const rendered = workspaceCanvas(project, [], {
    selection: { tagId: idleId, frameId: ids[0] },
    onSelection: (selection: AnimationSelection) => changes.push(selection),
  }).element;
  const walk = elements(rendered).find((node) => node.type === "button" && node.props?.["aria-label"] === "walk 애니메이션 세트 선택");
  assert.ok(walk);
  (walk.props?.onClick as () => void)();
  assert.deepEqual(changes.at(-1), { tagId: walkId, frameId: ids[2] });
  assert.match(renderedText(rendered), /애니메이션 세트/);
  assert.doesNotMatch(renderedText(rendered), /전체 구간 추가|태그/);
});

test("빈 세트와 미분류는 재생 불가 이유와 다음 행동을 표시한다", () => {
  const emptyDocument = createDocument({ width: 1, height: 1 });
  emptyDocument.tags = [{ id: "empty", name: "attack", direction: "forward", frameIds: [] }];
  const emptyProject = createProject("기사", emptyDocument);
  const emptyRendered = workspaceCanvas(emptyProject, [], {
    selection: { tagId: "empty", frameId: null },
  }).element;
  assert.match(renderedText(emptyRendered), /＋로 첫 프레임을 만드세요/);

  const unclassifiedProject = createProject("기사", createDocument({ width: 1, height: 1 }));
  const unclassifiedRendered = workspaceCanvas(unclassifiedProject, [], {
    selection: { tagId: null, frameId: unclassifiedProject.document.frames[0].id },
  }).element;
  assert.match(renderedText(unclassifiedRendered), /프레임을 선택해 새 세트로 등록하거나 CODEX FORGE·PNG 가져오기/);
});
