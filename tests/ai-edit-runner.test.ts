import assert from "node:assert/strict";
import test from "node:test";
import type { AiEditTarget, AiToolAction, EditorTool } from "../src/core/ai-edit.ts";
import { applyCommand } from "../src/core/commands.ts";
import { createDocument } from "../src/core/document.ts";
import { moveSelection } from "../src/core/selection.ts";
import { celKey, type SpriteDocument } from "../src/core/types.ts";
import { runAiEdit, runAiEditAttempts, selectionMask, type AiEditExecutionState } from "../src/core/ai-edit-runner.ts";
import { ToolController } from "../src/core/tool-controller.ts";
import { selectionOverlay, selectionRuns } from "../src/client/editor/ai-edit.ts";

const validPoints: Record<EditorTool, Array<{ x: number; y: number }>> = {
  pencil: [{ x: 1, y: 1 }],
  eraser: [{ x: 1, y: 1 }],
  line: [{ x: 0, y: 0 }, { x: 3, y: 3 }],
  curve: [{ x: 0, y: 0 }, { x: 3, y: 3 }],
  rectangle: [{ x: 0, y: 0 }, { x: 3, y: 3 }],
  ellipse: [{ x: 0, y: 0 }, { x: 3, y: 3 }],
  polygon: [{ x: 0, y: 0 }, { x: 3, y: 3 }],
  fill: [{ x: 0, y: 0 }],
  gradient: [{ x: 0, y: 0 }, { x: 3, y: 3 }],
  spray: [{ x: 1, y: 1 }],
  eyedropper: [{ x: 0, y: 0 }],
  select: [{ x: 0, y: 0 }, { x: 2, y: 2 }],
  lasso: [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 0, y: 3 }],
  wand: [{ x: 0, y: 0 }],
};

function targetOf(document: SpriteDocument): AiEditTarget {
  const frameId = document.frames[0].id;
  const layerId = document.layers[0].id;
  return { frameId, layerId, celId: document.cels[celKey(frameId, layerId)].id };
}

function stateOf(document: SpriteDocument): AiEditExecutionState {
  return {
    document,
    tool: "pencil",
    color: [255, 0, 0, 255],
    secondaryColor: [0, 0, 255, 255],
    brushSize: 1,
    brushShape: "square",
    filled: false,
    mirrorX: false,
    mirrorY: false,
  };
}

function imageBytes(document: SpriteDocument, target: AiEditTarget): number[] {
  const cel = document.cels[celKey(target.frameId, target.layerId)];
  return Array.from(document.images[cel.imageId].data);
}

test("AI 실행기는 13개 결정적 도구를 직접 포인터 제스처와 같게 실행한다", () => {
  for (const tool of Object.keys(validPoints) as EditorTool[]) {
    if (tool === "spray") continue;
    const document = createDocument({ width: 4, height: 4 });
    const target = targetOf(document);
    const state = stateOf(document);
    const points = validPoints[tool];
    const image = document.images[document.cels[celKey(target.frameId, target.layerId)].imageId];
    const controller = new ToolController({ ...state, tool, celId: target.celId }, image);
    controller.pointerDown(points[0]);
    for (const point of points.slice(1, -1)) controller.pointerMove(point);
    const direct = controller.pointerUp(points.at(-1)!);
    const directDocument = direct.command ? applyCommand(document, direct.command) : document;

    const application = runAiEdit(state, target, { summary: tool, actions: [{ tool, points }] }, 0);
    const actualDocument = application.historySteps.at(-1) ?? document;
    assert.deepEqual(imageBytes(actualDocument, target), imageBytes(directDocument, target), tool);
    assert.deepEqual(application.settings.selection, direct.selection, tool);
    assert.deepEqual(application.settings.color, direct.color ?? state.color, tool);
  }
});

test("같은 스프레이 동작과 시드는 서버 후보와 재생 결과를 같게 만든다", () => {
  const document = createDocument({ width: 8, height: 8 });
  const target = targetOf(document);
  const result = { summary: "분사", actions: [{ tool: "spray" as const, points: [{ x: 4, y: 4 }], brushSize: 2 }] };
  const first = runAiEdit(stateOf(document), target, result, 0x12345678);
  const second = runAiEdit(stateOf(document), target, result, 0x12345678);

  assert.deepEqual(first.document, second.document);
  assert.deepEqual(first.settings, second.settings);
  assert.equal(first.actionCount, 1);
});

test("시도 묶음 재생은 한 묶음씩 이어서 실행한 후보와 같다", () => {
  const document = createDocument({ width: 4, height: 4 });
  const target = targetOf(document);
  const attempts = [
    { seed: 1, result: { summary: "첫 편집", actions: [{ tool: "pencil" as const, points: [{ x: 0, y: 0 }] }] } },
    { seed: 2, result: { summary: "재편집", actions: [{ tool: "spray" as const, points: [{ x: 2, y: 2 }] }] } },
  ];
  const replayed = runAiEditAttempts(stateOf(document), target, attempts);
  const first = runAiEdit(stateOf(document), target, attempts[0].result, attempts[0].seed);
  const second = runAiEdit({ ...first.settings, document: first.document }, target, attempts[1].result, attempts[1].seed);

  assert.deepEqual(replayed.document, second.document);
  assert.deepEqual(replayed.settings, second.settings);
  assert.equal(replayed.actionCount, 2);
});

test("인덱스 문서는 동작 색과 최종 편집기 색을 팔레트로 제한한다", () => {
  const document = createDocument({ width: 1, height: 1 });
  document.colorMode = "indexed";
  document.palette = [
    { id: "black", name: "검정", color: [0, 0, 0, 255] },
    { id: "white", name: "흰색", color: [255, 255, 255, 255] },
  ];
  Object.values(document.images)[0].data.set([0, 0, 0, 255]);
  const target = targetOf(document);
  const application = runAiEdit(stateOf(document), target, {
    summary: "indexed",
    actions: [{ tool: "pencil", points: [{ x: 0, y: 0 }], color: [250, 250, 250, 255], secondaryColor: [5, 5, 5, 255] }],
  }, 0);
  assert.deepEqual(application.settings.color, [255, 255, 255, 255]);
  assert.deepEqual(application.settings.secondaryColor, [0, 0, 0, 255]);
  assert.deepEqual(imageBytes(application.historySteps[0], target), [255, 255, 255, 255]);
});

test("기존 선택과 스포이드 상태는 다음 채우기 동작에 전달된다", () => {
  const document = createDocument({ width: 3, height: 1 });
  const target = targetOf(document);
  const image = Object.values(document.images)[0];
  image.data.set([9, 8, 7, 255], 0);
  const state = { ...stateOf(document), selection: new Uint8Array([1, 0, 1]) };
  const application = runAiEdit(state, target, { summary: "전달", actions: [
    { tool: "eyedropper", points: [{ x: 0, y: 0 }] },
    { tool: "fill", points: [{ x: 2, y: 0 }] },
  ] }, 0);
  assert.deepEqual(application.settings.color, [9, 8, 7, 255]);
  assert.deepEqual(imageBytes(application.historySteps[0], target), [9, 8, 7, 255, 0, 0, 0, 0, 9, 8, 7, 255]);
});

test("문서 좌표는 오프셋된 셀의 로컬 좌표로 변환된다", () => {
  const document = createDocument({ width: 5, height: 4 });
  const target = targetOf(document);
  const cel = document.cels[celKey(target.frameId, target.layerId)];
  cel.x = 2;
  cel.y = 1;
  document.images[cel.imageId] = { width: 2, height: 2, data: new Uint8ClampedArray(16) };
  const application = runAiEdit(stateOf(document), target, { summary: "offset", actions: [{ tool: "pencil", points: [{ x: 3, y: 2 }] }] }, 0);
  assert.deepEqual(imageBytes(application.historySteps[0], target).slice(12, 16), [255, 0, 0, 255]);
});

test("요청 당시 사용자 브러시를 상속하고 brushShape 동작에서 해제한다", () => {
  const document = createDocument({ width: 4, height: 1 });
  const target = targetOf(document);
  const state = { ...stateOf(document), customBrush: [{ x: -1, y: 0 }, { x: 0, y: 0 }] };
  const application = runAiEdit(state, target, { summary: "brush", actions: [
    { tool: "pencil", points: [{ x: 1, y: 0 }] },
    { tool: "pencil", points: [{ x: 3, y: 0 }], brushShape: "circle", color: [0, 0, 255, 255] },
  ] }, 0);
  assert.equal(application.historySteps.length, 2);
  assert.equal(application.settings.customBrush, undefined);
  assert.deepEqual(imageBytes(application.historySteps[1], target), [255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 255, 255]);
});

test("연결 셀 편집은 대상 셀만 분리한다", () => {
  const document = createDocument({ width: 1, height: 1 });
  const target = targetOf(document);
  const layerId = document.layers[0].id;
  const sourceCel = document.cels[celKey(target.frameId, layerId)];
  const linkedFrame = { id: crypto.randomUUID(), durationMs: 100 };
  document.frames.push(linkedFrame);
  document.cels[celKey(linkedFrame.id, layerId)] = { ...sourceCel, id: crypto.randomUUID() };
  const sourceImage = Array.from(document.images[sourceCel.imageId].data);

  const application = runAiEdit(stateOf(document), target, { summary: "unlink", actions: [{ tool: "pencil", points: [{ x: 0, y: 0 }] }] }, 0);
  const changed = application.historySteps[0];
  assert.notEqual(changed.cels[celKey(target.frameId, layerId)].imageId, sourceCel.imageId);
  assert.equal(changed.cels[celKey(linkedFrame.id, layerId)].imageId, sourceCel.imageId);
  assert.deepEqual(Array.from(changed.images[sourceCel.imageId].data), sourceImage);
});

test("선택 마스크는 셀과 문서 좌표 사이를 오프셋과 경계에 맞춰 변환한다", () => {
  const document = createDocument({ width: 4, height: 3 });
  const target = targetOf(document);
  const cel = document.cels[celKey(target.frameId, target.layerId)];
  cel.x = 1;
  cel.y = 1;
  const image = { width: 2, height: 2, data: new Uint8ClampedArray(16) };
  document.images[cel.imageId] = image;
  const mask = new Uint8Array([1, 1, 0, 1]);

  assert.deepEqual(selectionRuns(mask, image, cel, document), [
    { y: 1, startX: 1, endX: 2 },
    { y: 2, startX: 2, endX: 2 },
  ]);
  const runs = selectionRuns(mask, image, cel, document);
  assert.deepEqual(selectionMask(runs, image, cel, document), mask);
  assert.deepEqual(Array.from(selectionOverlay(mask, image, cel, document)!), [0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0]);
  assert.throws(() => selectionRuns(new Uint8Array(3), image, cel, document), /선택 마스크 크기/);
});

test("오프셋 셀의 새 선택은 로컬 마스크로 그리기를 제한한다", () => {
  const document = createDocument({ width: 4, height: 3 });
  const target = targetOf(document);
  const cel = document.cels[celKey(target.frameId, target.layerId)];
  cel.x = 1;
  cel.y = 1;
  document.images[cel.imageId] = { width: 2, height: 2, data: new Uint8ClampedArray(16) };
  const application = runAiEdit(stateOf(document), target, { summary: "selection", actions: [
    { tool: "select", points: [{ x: 1, y: 1 }, { x: 1, y: 1 }] },
    { tool: "pencil", points: [{ x: 1, y: 1 }, { x: 2, y: 1 }] },
  ] }, 0);
  assert.equal(application.settings.selection?.length, 4);
  assert.deepEqual(imageBytes(application.historySteps[0], target), [255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.doesNotThrow(() => moveSelection(application.historySteps[0].images[application.historySteps[0].cels[celKey(target.frameId, target.layerId)].imageId], application.settings.selection!, 1, 0));
});

test("비픽셀·순변화 동작은 이력을 만들지 않고 실제 변경만 동작별로 남긴다", () => {
  const document = createDocument({ width: 2, height: 1 });
  const target = targetOf(document);
  Object.values(document.images)[0].data.set([255, 0, 0, 255], 0);
  const application = runAiEdit(stateOf(document), target, { summary: "history", actions: [
    { tool: "select", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] },
    { tool: "eyedropper", points: [{ x: 0, y: 0 }] },
    { tool: "pencil", points: [{ x: 0, y: 0 }] },
    { tool: "pencil", points: [{ x: 1, y: 0 }], color: [0, 0, 255, 255] },
    { tool: "pencil", points: [{ x: 0, y: 0 }], color: [0, 255, 0, 255] },
  ] }, 0);
  assert.equal(application.historySteps.length, 2);
});

test("잘못된 후속 동작은 입력 문서와 편집기 상태를 전혀 바꾸지 않는다", () => {
  const document = createDocument({ width: 2, height: 1 });
  const target = targetOf(document);
  const selection = new Uint8Array([1, 0]);
  const state = { ...stateOf(document), selection };
  const before = structuredClone(document);
  const actions = [
    { tool: "pencil", points: [{ x: 0, y: 0 }] },
    { tool: "line", points: [{ x: 0, y: 0 }] },
  ] as unknown as AiToolAction[];

  assert.throws(() => runAiEdit(state, target, { summary: "invalid", actions }, 0), /좌표 수/);
  assert.deepEqual(document, before);
  assert.deepEqual(selection, new Uint8Array([1, 0]));
  assert.equal(state.tool, "pencil");
});
