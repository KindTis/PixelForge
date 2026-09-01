import assert from "node:assert/strict";
import test from "node:test";
import { addAnimationTag, createAnimationSet } from "../src/core/animation.ts";
import { History, applyCommand } from "../src/core/commands.ts";
import { createDocument, createProject } from "../src/core/document.ts";
import { addFrame } from "../src/core/timeline.ts";
import { celKey } from "../src/core/types.ts";

test("픽셀 변경은 실행 취소와 다시 실행을 왕복한다", () => {
  const document = createDocument({ width: 2, height: 2 });
  const cel = Object.values(document.cels)[0];
  const history = new History(createProject("테스트", document));
  history.execute({ type: "setPixels", celId: cel.id, pixels: [{ x: 1, y: 0, rgba: [255, 0, 0, 255] }] });

  assert.deepEqual(Array.from(history.document.images[history.document.cels[Object.keys(history.document.cels)[0]].imageId].data.slice(4, 8)), [255, 0, 0, 255]);
  history.undo();
  assert.deepEqual(Array.from(Object.values(history.document.images)[0].data.slice(4, 8)), [0, 0, 0, 0]);
  history.redo();
  assert.deepEqual(Array.from(Object.values(history.document.images)[0].data.slice(4, 8)), [255, 0, 0, 255]);
});

test("오프셋된 셀은 문서 안에 놓인 로컬 픽셀만 변경한다", () => {
  const document = createDocument({ width: 3, height: 1 });
  const cel = Object.values(document.cels)[0];
  document.width = 1;
  cel.x = -1;

  const result = applyCommand(document, {
    type: "setPixels",
    celId: cel.id,
    pixels: [
      { x: 0, y: 0, rgba: [1, 1, 1, 255] },
      { x: 1, y: 0, rgba: [2, 2, 2, 255] },
      { x: 2, y: 0, rgba: [3, 3, 3, 255] },
    ],
  });

  assert.deepEqual(Array.from(result.images[cel.imageId].data), [
    0, 0, 0, 0,
    2, 2, 2, 255,
    0, 0, 0, 0,
  ]);
});

test("문서 밖 픽셀만 있는 명령은 문서와 이력을 바꾸지 않는다", () => {
  const document = createDocument({ width: 2, height: 1 });
  const cel = Object.values(document.cels)[0];
  cel.x = 2;

  assert.equal(applyCommand(document, {
    type: "setPixels",
    celId: cel.id,
    pixels: [{ x: 0, y: 0, rgba: [1, 1, 1, 255] }],
  }), document);
});

test("연결 셀을 편집하면 대상 셀만 자동 분리한다", () => {
  let document = createDocument({ width: 1, height: 1 });
  const sourceFrame = document.frames[0];
  const layer = document.layers[0];
  document = addAnimationTag(document, { name: "idle", direction: "forward", frameIds: [sourceFrame.id] });
  const copied = createAnimationSet(document, {
    sourceTagId: document.tags[0].id,
    frameIds: [sourceFrame.id],
    name: "walk",
    direction: "forward",
    mode: "copy",
  });
  const nextFrame = copied.document.frames.find((frame) => frame.id === copied.frameIds[0])!;
  const sourceCel = copied.document.cels[celKey(sourceFrame.id, layer.id)];
  const linkedCel = copied.document.cels[celKey(nextFrame.id, layer.id)];
  assert.equal(linkedCel.imageId, sourceCel.imageId);

  const result = applyCommand(copied.document, { type: "setPixels", celId: linkedCel.id, pixels: [{ x: 0, y: 0, rgba: [1, 2, 3, 255] }] });
  const edited = result.cels[celKey(nextFrame.id, layer.id)];
  assert.notEqual(edited.imageId, sourceCel.imageId);
  assert.deepEqual(Array.from(result.images[edited.imageId].data), [1, 2, 3, 255]);
  assert.deepEqual(Array.from(result.images[sourceCel.imageId].data), [0, 0, 0, 0]);
});

test("잠긴 레이어 편집을 거부하고 트랜잭션을 한 단계로 취소한다", () => {
  const document = createDocument({ width: 2, height: 1 });
  const cel = Object.values(document.cels)[0];
  document.layers[0].locked = true;
  assert.throws(() => applyCommand(document, { type: "setPixels", celId: cel.id, pixels: [{ x: 0, y: 0, rgba: [1, 1, 1, 255] }] }), /잠긴 레이어/);

  document.layers[0].locked = false;
  const history = new History(createProject("테스트", document));
  history.beginTransaction();
  history.execute({ type: "setPixels", celId: cel.id, pixels: [{ x: 0, y: 0, rgba: [1, 1, 1, 255] }] });
  history.execute({ type: "setPixels", celId: cel.id, pixels: [{ x: 1, y: 0, rgba: [2, 2, 2, 255] }] });
  history.commitTransaction();
  history.undo();
  assert.deepEqual(Array.from(Object.values(history.document.images)[0].data), [0, 0, 0, 0, 0, 0, 0, 0]);
});

test("구조 변경도 히스토리 한 단계로 기록한다", () => {
  const document = createDocument({ width: 1, height: 1 });
  const history = new History(createProject("테스트", document));
  const renamed = { ...document, layers: [{ ...document.layers[0], name: "잉크" }] };
  history.replaceDocument(renamed);
  assert.equal(history.document.layers[0].name, "잉크");
  history.undo();
  assert.equal(history.document.layers[0].name, "레이어 1");
});

test("순변화 없는 픽셀 명령은 문서와 이력을 바꾸지 않는다", () => {
  const original = createDocument({ width: 1, height: 1 });
  const layer = original.layers[0];
  const sourceFrame = original.frames[0];
  const cel = Object.values(original.cels)[0];
  const linkedFrame = { id: crypto.randomUUID(), durationMs: 100 };
  original.frames.push(linkedFrame);
  original.cels[celKey(linkedFrame.id, layer.id)] = { ...cel, id: crypto.randomUUID() };
  const history = new History(createProject("테스트", original));

  assert.equal(history.execute({ type: "setPixels", celId: cel.id, pixels: [{ x: 0, y: 0, rgba: [0, 0, 0, 0] }] }).document, original);
  assert.equal(history.undo().document, original);
  assert.equal(history.document.cels[celKey(sourceFrame.id, layer.id)].imageId, cel.imageId);
  assert.equal(history.document.cels[celKey(linkedFrame.id, layer.id)].imageId, cel.imageId);
});

test("격리된 문서 단계는 픽셀 동작별 undo와 redo로 합쳐진다", () => {
  const original = createDocument({ width: 2, height: 1 });
  const cel = Object.values(original.cels)[0];
  const first = applyCommand(original, { type: "setPixels", celId: cel.id, pixels: [{ x: 0, y: 0, rgba: [1, 1, 1, 255] }] });
  const second = applyCommand(first, { type: "setPixels", celId: cel.id, pixels: [{ x: 1, y: 0, rgba: [2, 2, 2, 255] }] });
  const history = new History(createProject("테스트", original));

  history.commitSteps([first, second]);
  assert.equal(history.document, second);
  assert.equal(history.undo().document, first);
  assert.equal(history.undo().document, original);
  assert.equal(history.redo().document, first);
  assert.equal(history.redo().document, second);
});

test("빈 격리 단계는 redo를 보존하고 새 단계는 redo를 지운다", () => {
  const original = createDocument({ width: 1, height: 1 });
  const cel = Object.values(original.cels)[0];
  const first = applyCommand(original, { type: "setPixels", celId: cel.id, pixels: [{ x: 0, y: 0, rgba: [1, 1, 1, 255] }] });
  const second = applyCommand(original, { type: "setPixels", celId: cel.id, pixels: [{ x: 0, y: 0, rgba: [2, 2, 2, 255] }] });
  const history = new History(createProject("테스트", original));

  history.replaceDocument(first);
  history.undo();
  assert.equal(history.commitSteps([]).document, original);
  assert.equal(history.redo().document, first);
  history.undo();
  history.commitSteps([second]);
  assert.equal(history.redo().document, second);
});

test("편집 트랜잭션 중에는 격리 단계를 합치지 않는다", () => {
  const original = createDocument({ width: 1, height: 1 });
  const history = new History(createProject("테스트", original));
  history.beginTransaction();
  assert.throws(() => history.commitSteps([structuredClone(original)]), /편집 트랜잭션 중/);
});

test("History 스냅샷 복원은 AI 적용 문서와 undo/redo 변경을 함께 되돌린다", () => {
  const original = createDocument({ width: 2, height: 1 });
  const celId = Object.values(original.cels)[0].id;
  const history = new History(createProject("테스트", original));
  const beforeAi = history.execute({ type: "setPixels", celId, pixels: [{ x: 0, y: 0, rgba: [1, 2, 3, 255] }] }).document;
  const snapshot = history.snapshot();
  history.commitSteps([applyCommand(beforeAi, { type: "setPixels", celId, pixels: [{ x: 1, y: 0, rgba: [4, 5, 6, 255] }] })]);

  assert.equal(history.restore(snapshot).document, beforeAi);
  assert.equal(history.undo().document, original);
  assert.equal(history.redo().document, beforeAi);
});

test("전체 생성 이력은 문서·생성 기록·열 수를 한 단계로 왕복한다", () => {
  const before = createProject("기사", createDocument({ width: 1, height: 1 }));
  const after = structuredClone(before);
  after.document = addFrame(after.document);
  after.generationHistory.push({ id: "gen", prompt: "걷기", createdAt: "2026-08-31T00:00:00.000Z", outputPath: "generated/sheet.png" });
  after.exportSettings.columns = 2;
  const history = new History(before);
  history.replaceProject(after, ["document", "generationHistory", "exportSettings"]);

  assert.deepEqual(history.undo(), before);
  assert.deepEqual(history.redo(), after);
});

test("문서 전용 이력은 기존 생성 기록과 내보내기 설정을 유지한다", () => {
  const before = createProject("기사", createDocument({ width: 1, height: 1 }));
  before.generationHistory.push({
    id: "existing",
    prompt: "기존 생성",
    createdAt: "2026-08-30T00:00:00.000Z",
    outputPath: "generated/existing.png",
  });
  before.exportSettings.columns = 3;
  const history = new History(before);
  history.replaceDocument(addFrame(before.document));
  history.project = { ...history.project, name: "검사" };

  const undone = history.undo();
  assert.equal(undone.name, "검사");
  assert.deepEqual(undone.generationHistory, before.generationHistory);
  assert.deepEqual(undone.exportSettings, before.exportSettings);
});
