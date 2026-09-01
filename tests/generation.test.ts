import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, createProject } from "../src/core/document.ts";
import { compositeFrame } from "../src/core/render.ts";
import { addFrame, addLayer } from "../src/core/timeline.ts";
import { celKey } from "../src/core/types.ts";
import {
  appendAnimationSheet,
  assertAppendAnimationRequest,
  buildAppendAnimationPrompt,
  buildFrameRegenerationPrompt,
  buildSpriteSheetPrompt,
  importRegeneratedFrame,
  importSpriteSheet,
  type AppendAnimationRequest,
  type SpriteSheetRequest,
} from "../src/server/generation.ts";
import { encodePng } from "../src/server/png.ts";

const request: SpriteSheetRequest = {
  prompt: "칼을 휘두르는 기사",
  frameCount: 3,
  columns: 2,
  cellWidth: 1,
  cellHeight: 1,
  durationMs: 80,
};

function setPixel(pixels: Uint8ClampedArray, width: number, x: number, y: number): void {
  const offset = (y * width + x) * 4;
  pixels.set([255, 255, 255, 255], offset);
}

function opaquePixels(data: Uint8ClampedArray, width: number): string[] {
  const result: string[] = [];
  for (let offset = 3; offset < data.length; offset += 4) {
    if (data[offset] > 16) {
      const pixel = (offset - 3) / 4;
      result.push(`${pixel % width},${Math.floor(pixel / width)}`);
    }
  }
  return result;
}

function nonTransparentPixels(data: Uint8ClampedArray, width: number): string[] {
  const result: string[] = [];
  for (let offset = 3; offset < data.length; offset += 4) {
    if (data[offset] > 0) {
      const pixel = (offset - 3) / 4;
      result.push(`${pixel % width},${Math.floor(pixel / width)}`);
    }
  }
  return result;
}

function frameBytes(project: ReturnType<typeof createProject>, frameIndex: number): number[][] {
  const frame = project.document.frames[frameIndex];
  return project.document.layers.map((layer) => {
    const cel = project.document.cels[celKey(frame.id, layer.id)];
    return Array.from(project.document.images[cel.imageId].data);
  });
}

function projectWithThreeFramesAndTwoLayers() {
  let document = createDocument({ width: 4, height: 4 });
  document = addFrame(document);
  document = addFrame(document);
  document = addLayer(document, "효과");
  for (const [index, cel] of Object.values(document.cels).entries()) {
    document.images[cel.imageId].data.fill(index + 1);
  }
  document.tags.push({
    id: crypto.randomUUID(),
    name: "공격",
    frameIds: document.frames.map((frame) => frame.id),
    direction: "forward",
  });
  const project = createProject("기사", document);
  project.generationHistory.push({ id: crypto.randomUUID(), prompt: "기존 생성", createdAt: "2026-08-09T00:00:00.000Z", outputPath: "old.png" });
  return project;
}

function taggedProject() {
  let document = createDocument({ width: 2, height: 1 });
  document = addFrame(document);
  document.tags.push({
    id: crypto.randomUUID(),
    name: "walk",
    frameIds: document.frames.map((frame) => frame.id),
    direction: "forward",
  });
  return createProject("기사", document);
}

function appendRequest(
  project: ReturnType<typeof taggedProject>,
  patch: Partial<AppendAnimationRequest> = {},
): AppendAnimationRequest {
  return {
    name: "attack",
    baseFrameId: project.document.frames[0].id,
    targetLayerId: project.document.layers[0].id,
    direction: "forward",
    prompt: "검 공격",
    frameCount: 2,
    columns: 2,
    cellWidth: project.document.width,
    cellHeight: project.document.height,
    ...patch,
  };
}

function fiveFrameWalkProject() {
  let document = createDocument({ width: 2, height: 1 });
  for (let index = 1; index < 5; index += 1) document = addFrame(document);
  document = addLayer(document, "효과");
  document.tags.push({
    id: crypto.randomUUID(),
    name: "walk",
    frameIds: document.frames.map((frame) => frame.id),
    direction: "forward",
  });
  const project = createProject("기사", document);
  project.generationHistory.push({
    id: crypto.randomUUID(),
    prompt: "걷기",
    createdAt: "2026-08-30T00:00:00.000Z",
    outputPath: "generated/walk.png",
  });
  return project;
}

test("생성 프롬프트는 투명 배경, 정확한 격자와 출력 파일을 강제한다", () => {
  const prompt = buildSpriteSheetPrompt({ ...request, referencePath: "C:/project/references/hero.png" }, "C:/project/generated/sheet.png");

  assert.match(prompt, /칼을 휘두르는 기사/);
  assert.match(prompt, /2열 × 2행/);
  assert.match(prompt, /전체 이미지 크기: 2 × 2 픽셀/);
  assert.match(prompt, /투명 배경/);
  assert.match(prompt, /지면 기준점/);
  assert.match(prompt, /제자리 모션/);
  assert.match(prompt, /references\/hero\.png/);
  assert.match(prompt, /C:\/project\/generated\/sheet\.png/);
});

test("추가 애니메이션 프롬프트는 기준 프레임을 제외한 정확한 후속 시트를 요구한다", () => {
  const project = taggedProject();
  const request: AppendAnimationRequest = {
    name: "attack",
    baseFrameId: project.document.frames[0].id,
    targetLayerId: project.document.layers[0].id,
    direction: "reverse",
    prompt: "검 공격",
    frameCount: 3,
    columns: 2,
    cellWidth: project.document.width,
    cellHeight: project.document.height,
  };
  assertAppendAnimationRequest(project, request);
  const prompt = buildAppendAnimationPrompt(request, "generated/job/base.png", "generated/job/animation.png");

  assert.match(prompt, /기준 프레임.*출력 시트에 포함하지/);
  assert.match(prompt, /정확히 3개/);
  assert.match(prompt, /시간상 정방향/);
  assert.match(prompt, /재생 방향.*reverse/);
  assert.match(prompt, /2열 × 2행/);
  assert.match(prompt, /기준 프레임 참조.*base\.png/);
  assert.match(prompt, /투명 배경.*PNG 한 장/);
});

test("추가 애니메이션 사전 검증은 Codex 전에 잘못된 프로젝트 대상을 거부한다", () => {
  const project = taggedProject();
  const valid = appendRequest(project);
  const cases: Array<[Partial<AppendAnimationRequest>, RegExp]> = [
    [{ name: "walk" }, /고유/],
    [{ name: "WALK?" }, /AnimationClip.*충돌/],
    [{ baseFrameId: "missing" }, /기준 프레임/],
    [{ targetLayerId: "missing" }, /대상 레이어/],
    [{ cellWidth: project.document.width + 1 }, /캔버스/],
    [{ direction: "sideways" as AppendAnimationRequest["direction"] }, /재생 방향/],
  ];
  for (const [patch, error] of cases) {
    assert.throws(() => assertAppendAnimationRequest(project, { ...valid, ...patch }), error);
  }

  const missingCel = structuredClone(project);
  delete missingCel.document.cels[celKey(valid.baseFrameId, valid.targetLayerId)];
  assert.throws(() => assertAppendAnimationRequest(missingCel, valid), /대상 레이어 셀/);

  const noTag = structuredClone(project);
  noTag.document.tags = [];
  assert.throws(() => assertAppendAnimationRequest(noTag, valid), /먼저 타임라인/);

  for (const patch of [
    { visible: false },
    { locked: true },
    { blendMode: "multiply" as const },
    { opacity: 0.5 },
  ]) {
    const invalidLayer = structuredClone(project);
    Object.assign(invalidLayer.document.layers[0], patch);
    assert.throws(() => assertAppendAnimationRequest(invalidLayer, valid), /보이고 잠기지 않은/);
  }

  const indexedWithoutTransparency = structuredClone(project);
  indexedWithoutTransparency.document.colorMode = "indexed";
  for (const image of Object.values(indexedWithoutTransparency.document.images)) {
    for (let offset = 0; offset < image.data.length; offset += 4) image.data.set([0, 0, 0, 255], offset);
  }
  assert.throws(() => assertAppendAnimationRequest(indexedWithoutTransparency, valid), /투명 팔레트/);
});

test("추가 시트는 기존 상태를 보존하고 기준 연결 복제본과 생성 프레임을 끝에 붙인다", () => {
  const project = fiveFrameWalkProject();
  const before = structuredClone(project);
  const base = project.document.frames[0];
  const target = project.document.layers[0];
  const request = appendRequest(project, {
    name: "attack",
    frameCount: 3,
    columns: 3,
    direction: "forward",
  });
  const pixels = new Uint8ClampedArray(project.document.width * project.document.height * 4 * 3);
  pixels.set([255, 0, 0, 255], 0);
  pixels.set([0, 255, 0, 255], project.document.width * project.document.height * 4);
  pixels.set([0, 0, 255, 255], project.document.width * project.document.height * 8);

  const after = appendAnimationSheet(
    project,
    encodePng(project.document.width * 3, project.document.height, pixels),
    request,
    "generated/animation.png",
  );

  assert.equal(after.document.frames.length, 9);
  assert.deepEqual(after.document.frames.slice(0, 5), before.document.frames);
  assert.deepEqual(after.document.layers, before.document.layers);
  assert.deepEqual(after.document.tags.slice(0, -1), before.document.tags);
  assert.deepEqual(after.document.palette, before.document.palette);
  assert.deepEqual(after.exportSettings, before.exportSettings);
  assert.deepEqual(after.generationHistory.slice(0, -1), before.generationHistory);
  for (const [key, cel] of Object.entries(before.document.cels)) assert.deepEqual(after.document.cels[key], cel);
  for (const [id, image] of Object.entries(before.document.images)) assert.deepEqual(after.document.images[id], image);
  assert.equal(JSON.stringify(project), JSON.stringify(before));

  const clone = after.document.frames[5];
  assert.equal(clone.durationMs, base.durationMs);
  for (const layer of after.document.layers) {
    const sourceCel = before.document.cels[celKey(base.id, layer.id)];
    const clonedCel = after.document.cels[celKey(clone.id, layer.id)];
    if (!sourceCel) assert.equal(clonedCel, undefined);
    else {
      assert.notEqual(clonedCel.id, sourceCel.id);
      assert.equal(clonedCel.imageId, sourceCel.imageId);
    }
  }
  assert.deepEqual(after.document.frames.slice(6).map((frame) => frame.durationMs), [base.durationMs, base.durationMs, base.durationMs]);
  assert.ok(after.document.frames.slice(6).every((frame) => after.document.cels[celKey(frame.id, target.id)]));
  for (const generated of after.document.frames.slice(6)) {
    const blankCel = after.document.cels[celKey(generated.id, after.document.layers[1].id)];
    assert.ok(after.document.images[blankCel.imageId].data.every((channel) => channel === 0));
    assert.ok(compositeFrame(after.document, generated.id).data.some((channel, offset) => offset % 4 === 3 && channel > 0));
  }
  const attack = after.document.tags.at(-1)!;
  assert.deepEqual({
    name: attack.name,
    frameIds: attack.frameIds,
    direction: attack.direction,
  }, {
    name: "attack",
    frameIds: [clone.id, ...after.document.frames.slice(6).map((frame) => frame.id)],
    direction: "forward",
  });
  assert.equal(after.generationHistory.at(-1)?.outputPath, "generated/animation.png");
});

test("인덱스 추가 프레임은 기존 팔레트로 양자화하고 다른 레이어를 투명색으로 채운다", () => {
  const project = fiveFrameWalkProject();
  const transparent = [10, 20, 30, 0] as const;
  project.document.colorMode = "indexed";
  project.document.palette.push({ id: crypto.randomUUID(), name: "투명", color: transparent });
  for (const image of Object.values(project.document.images)) {
    for (let offset = 0; offset < image.data.length; offset += 4) image.data.set(transparent, offset);
  }
  const request = appendRequest(project, { frameCount: 1, columns: 1 });
  const png = encodePng(2, 1, new Uint8ClampedArray([250, 250, 250, 255, 0, 0, 0, 0]));

  const after = appendAnimationSheet(project, png, request, "generated/animation.png");
  const generated = after.document.frames.at(-1)!;
  const blankCel = after.document.cels[celKey(generated.id, after.document.layers[1].id)];
  assert.deepEqual(Array.from(after.document.images[blankCel.imageId].data), [...transparent, ...transparent]);
  const palette = new Set(after.document.palette.map((entry) => entry.color.join(",")));
  for (const layer of after.document.layers) {
    const cel = after.document.cels[celKey(generated.id, layer.id)];
    const data = after.document.images[cel.imageId].data;
    for (let offset = 0; offset < data.length; offset += 4) {
      assert.ok(palette.has(Array.from(data.subarray(offset, offset + 4)).join(",")));
    }
  }
});

test("잘못된 추가 시트는 입력 프로젝트를 변경하지 않는다", () => {
  const project = fiveFrameWalkProject();
  const before = JSON.stringify(project);
  assert.throws(
    () => appendAnimationSheet(
      project,
      encodePng(1, 1, new Uint8ClampedArray(4)),
      appendRequest(project),
      "generated/animation.png",
    ),
    /격자/,
  );
  assert.equal(JSON.stringify(project), before);
});

test("선택 프레임 프롬프트는 태그 진행률과 역할별 참조를 포함한다", () => {
  const document = createDocument({ width: 32, height: 32 });
  document.frames.push(
    { id: crypto.randomUUID(), durationMs: 100 },
    { id: crypto.randomUUID(), durationMs: 100 },
    { id: crypto.randomUUID(), durationMs: 100 },
  );
  document.tags.push({
    id: crypto.randomUUID(),
    name: "attack",
    frameIds: document.frames.slice(0, 4).map((frame) => frame.id),
    direction: "reverse",
  });
  const project = createProject("기사", document);
  const prompt = buildFrameRegenerationPrompt(project, {
    prompt: "검 공격",
    frameId: project.document.frames[2].id,
  }, {
    first: "C:/project/generated/job/first.png",
    previous: "C:/project/generated/job/previous.png",
    next: "C:/project/generated/job/next.png",
  }, "C:/project/generated/job/frame.png");

  assert.match(prompt, /선택 프레임: 3\/4/);
  assert.match(prompt, /애니메이션 태그: attack/);
  assert.match(prompt, /재생 방향: reverse/);
  assert.match(prompt, /진행률: 66\.7%/);
  assert.match(prompt, /준비·타격·후속·복귀/);
  assert.match(prompt, /첫 프레임 참조.*first\.png/);
  assert.match(prompt, /이전 프레임 참조.*previous\.png/);
  assert.match(prompt, /다음 프레임 참조.*next\.png/);
  assert.match(prompt, /투명 배경/);
  assert.match(prompt, /지면 기준점/);
});

test("선택 프레임 진행률은 부분 태그 구간 안에서 계산한다", () => {
  const document = createDocument({ width: 8, height: 8 });
  document.frames.push(
    { id: crypto.randomUUID(), durationMs: 100 },
    { id: crypto.randomUUID(), durationMs: 100 },
    { id: crypto.randomUUID(), durationMs: 100 },
    { id: crypto.randomUUID(), durationMs: 100 },
  );
  document.tags.push({
    id: crypto.randomUUID(),
    name: "attack",
    frameIds: document.frames.slice(1, 4).map((frame) => frame.id),
    direction: "forward",
  });
  const project = createProject("기사", document);
  const promptFor = (frameId: string) => buildFrameRegenerationPrompt(
    project,
    { prompt: "검 공격", frameId },
    { first: "first.png" },
    "frame.png",
  );

  assert.match(promptFor(document.frames[1].id), /진행률: 0\.0%/);
  assert.match(promptFor(document.frames[3].id), /진행률: 100\.0%/);
  document.tags[0].frameIds = [document.frames[2].id];
  assert.match(promptFor(document.frames[2].id), /진행률: 100\.0%/);
});

test("선택 프레임 프롬프트는 동작 단계를 먼저 판단하고 참조별 역할을 구분한다", () => {
  const project = createProject("기사", createDocument({ width: 8, height: 8 }));
  const prompt = buildFrameRegenerationPrompt(project, {
    prompt: "검 공격",
    frameId: project.document.frames[0].id,
  }, {
    first: "first.png",
    previous: "previous.png",
    next: "next.png",
  }, "frame.png");

  assert.match(prompt, /원 프롬프트.*타임라인 위치.*역할별 참조.*함께 해석.*준비·타격·후속·복귀.*먼저 판단/);
  assert.match(prompt, /첫 프레임 참조.*캐릭터 외형·팔레트·크기·카메라.*기준/);
  assert.match(prompt, /이전·다음 참조.*앞뒤 동작 연결.*기준/);
  assert.match(prompt, /선택적 참조가 없는 경계.*존재하는 참조만 사용/);
});

test("선택 프레임 프롬프트는 전달된 참조 역할만 포함한다", () => {
  const project = createProject("기사", createDocument({ width: 8, height: 8 }));
  const prompt = buildFrameRegenerationPrompt(project, {
    prompt: "대기",
    frameId: project.document.frames[0].id,
  }, { first: "first.png" }, "frame.png");

  assert.match(prompt, /첫 프레임 참조.*first\.png/);
  assert.doesNotMatch(prompt, /이전 프레임 참조/);
  assert.doesNotMatch(prompt, /다음 프레임 참조/);
});

test("첫 프레임과 마지막 프레임은 가능한 역할별 참조만 포함한다", () => {
  const document = createDocument({ width: 8, height: 8 });
  document.frames.push({ id: crypto.randomUUID(), durationMs: 100 });
  const project = createProject("기사", document);

  const firstPrompt = buildFrameRegenerationPrompt(project, {
    prompt: "시작",
    frameId: project.document.frames[0].id,
  }, { first: "first.png", next: "next.png" }, "first-frame.png");
  assert.match(firstPrompt, /첫 프레임 참조.*first\.png/);
  assert.match(firstPrompt, /다음 프레임 참조.*next\.png/);
  assert.doesNotMatch(firstPrompt, /이전 프레임 참조/);

  const lastPrompt = buildFrameRegenerationPrompt(project, {
    prompt: "끝",
    frameId: project.document.frames[1].id,
  }, { first: "first.png", previous: "previous.png" }, "last-frame.png");
  assert.match(lastPrompt, /첫 프레임 참조.*first\.png/);
  assert.match(lastPrompt, /이전 프레임 참조.*previous\.png/);
  assert.doesNotMatch(lastPrompt, /다음 프레임 참조/);
});

test("공백인 선택 참조 경로는 프롬프트에 포함하지 않는다", () => {
  const project = createProject("기사", createDocument({ width: 8, height: 8 }));
  const prompt = buildFrameRegenerationPrompt(project, {
    prompt: "대기",
    frameId: project.document.frames[0].id,
  }, { first: "first.png", previous: " ", next: "\t" }, "frame.png");

  assert.doesNotMatch(prompt, /이전 프레임 참조/);
  assert.doesNotMatch(prompt, /다음 프레임 참조/);
});

test("잘못된 생성 요청을 거부한다", () => {
  assert.throws(
    () => buildSpriteSheetPrompt({ ...request, frameCount: 0 }, "sheet.png"),
    /프레임 수/,
  );
  assert.throws(
    () => buildSpriteSheetPrompt({ ...request, prompt: " " }, "sheet.png"),
    /프롬프트/,
  );
});

test("스프라이트 시트를 프레임과 생성 이력으로 가져온다", () => {
  const project = createProject("기사", createDocument({ width: 4, height: 4 }));
  const pixels = new Uint8ClampedArray([
    255, 0, 0, 255,
    0, 255, 0, 255,
    0, 0, 255, 255,
    0, 0, 0, 0,
  ]);

  const imported = importSpriteSheet(project, encodePng(2, 2, pixels), request, "generated/sheet.png");

  assert.equal(imported.document.width, 1);
  assert.equal(imported.document.height, 1);
  assert.equal(imported.document.frames.length, 3);
  assert.deepEqual(imported.document.frames.map((frame) => frame.durationMs), [80, 80, 80]);
  assert.deepEqual(
    imported.document.frames.map((frame) => {
      const cel = imported.document.cels[`${frame.id}:${imported.document.layers[0].id}`];
      return Array.from(imported.document.images[cel.imageId].data);
    }),
    [
      [255, 0, 0, 255],
      [0, 255, 0, 255],
      [0, 0, 255, 255],
    ],
  );
  assert.equal(imported.generationHistory.at(-1)?.prompt, request.prompt);
  assert.equal(imported.generationHistory.at(-1)?.outputPath, "generated/sheet.png");
  assert.equal(imported.exportSettings.columns, 2);
});

test("가져온 캐릭터 프레임의 지면과 하체 기준점을 정렬한다", () => {
  const alignmentRequest = { ...request, frameCount: 2, columns: 2, cellWidth: 8, cellHeight: 8 };
  const pixels = new Uint8ClampedArray(16 * 8 * 4);
  for (const [x, y] of [[1, 2], [2, 2], [1, 3], [2, 3]]) setPixel(pixels, 16, x, y);
  for (const [x, y] of [[13, 5], [14, 5], [13, 6], [14, 6]]) setPixel(pixels, 16, x, y);

  const imported = importSpriteSheet(
    createProject("기사", createDocument({ width: 8, height: 8 })),
    encodePng(16, 8, pixels),
    alignmentRequest,
    "generated/sheet.png",
  );
  const positions = imported.document.frames.map((frame) => {
    const cel = imported.document.cels[`${frame.id}:${imported.document.layers[0].id}`];
    return opaquePixels(imported.document.images[cel.imageId].data, 8);
  });

  assert.deepEqual(positions, [
    ["4,6", "5,6", "4,7", "5,7"],
    ["4,6", "5,6", "4,7", "5,7"],
  ]);
});

test("기준점 정렬은 경계 픽셀과 빈 프레임을 보존한다", () => {
  const alignmentRequest = { ...request, frameCount: 2, columns: 2, cellWidth: 8, cellHeight: 8 };
  const pixels = new Uint8ClampedArray(16 * 8 * 4);
  setPixel(pixels, 16, 7, 0);
  pixels[(7 * 4) + 3] = 1;
  for (const [x, y] of [[1, 2], [2, 2], [1, 3], [2, 3]]) setPixel(pixels, 16, x, y);

  const imported = importSpriteSheet(
    createProject("기사", createDocument({ width: 8, height: 8 })),
    encodePng(16, 8, pixels),
    alignmentRequest,
    "generated/sheet.png",
  );
  const [filledFrame, emptyFrame] = imported.document.frames;
  const layerId = imported.document.layers[0].id;
  const filledCel = imported.document.cels[`${filledFrame.id}:${layerId}`];
  const emptyCel = imported.document.cels[`${emptyFrame.id}:${layerId}`];
  const filled = nonTransparentPixels(imported.document.images[filledCel.imageId].data, 8);

  assert.equal(filled.length, 5);
  assert.ok(filled.some((position) => position.startsWith("7,")));
  assert.ok(filled.some((position) => position.endsWith(",7")));
  assert.deepEqual(opaquePixels(imported.document.images[emptyCel.imageId].data, 8), []);
});

test("시트 크기가 격자와 다르면 가져오기를 거부한다", () => {
  const project = createProject("기사", createDocument({ width: 1, height: 1 }));
  assert.throws(
    () => importSpriteSheet(project, encodePng(1, 1, new Uint8ClampedArray(4)), request, "sheet.png"),
    /시트 크기/,
  );
});

test("재생성은 선택 프레임 픽셀만 교체하고 나머지 프로젝트 상태를 보존한다", () => {
  const project = projectWithThreeFramesAndTwoLayers();
  const before = structuredClone(project);
  const selectedFrame = project.document.frames[1];
  const selectedCels = project.document.layers.map((layer) => project.document.cels[celKey(selectedFrame.id, layer.id)]);
  const png = encodePng(4, 4, new Uint8ClampedArray([
    255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ]));

  const after = importRegeneratedFrame(project, png, { prompt: "검 공격", frameId: selectedFrame.id }, "generated/frame.png");

  assert.deepEqual(after.document.frames, before.document.frames);
  assert.deepEqual(after.document.layers, before.document.layers);
  assert.deepEqual(after.document.tags, before.document.tags);
  assert.deepEqual(after.generationHistory, before.generationHistory);
  assert.deepEqual(frameBytes(after, 0), frameBytes(before, 0));
  assert.deepEqual(frameBytes(after, 2), frameBytes(before, 2));
  assert.deepEqual(
    project.document.layers.map((layer) => {
      const cel = after.document.cels[celKey(selectedFrame.id, layer.id)];
      return { id: cel.id, x: cel.x, y: cel.y, opacity: cel.opacity };
    }),
    selectedCels.map(({ id, x, y, opacity }) => ({ id, x, y, opacity })),
  );
  assert.ok(project.document.layers.every((layer, index) => after.document.cels[celKey(selectedFrame.id, layer.id)].imageId !== selectedCels[index].imageId));
  assert.deepEqual(Array.from(after.document.images[after.document.cels[celKey(selectedFrame.id, project.document.layers[1].id)].imageId].data), new Array(64).fill(0));
  assert.deepEqual(Array.from(compositeFrame(after.document, selectedFrame.id).data), [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255,
  ]);
});

test("재생성은 연결된 다음 프레임 셀을 새 이미지 ID로 분리한다", () => {
  let document = createDocument({ width: 4, height: 4 });
  document = addFrame(document);
  document = addFrame(document);
  const layer = document.layers[0];
  const selected = document.frames[1];
  const next = document.frames[2];
  const selectedCel = document.cels[celKey(selected.id, layer.id)];
  const nextCel = document.cels[celKey(next.id, layer.id)];
  nextCel.imageId = selectedCel.imageId;
  document.images[selectedCel.imageId].data.set([9, 8, 7, 255]);
  const project = createProject("기사", document);
  const nextBefore = Array.from(project.document.images[nextCel.imageId].data);

  const after = importRegeneratedFrame(project, encodePng(4, 4, new Uint8ClampedArray(64)), { prompt: "대기", frameId: selected.id }, "generated/frame.png");

  const afterSelected = after.document.cels[celKey(selected.id, layer.id)];
  const afterNext = after.document.cels[celKey(next.id, layer.id)];
  assert.notEqual(afterSelected.imageId, afterNext.imageId);
  assert.deepEqual(Array.from(after.document.images[afterNext.imageId].data), nextBefore);
});

test("잘못된 재생성 PNG는 입력 프로젝트를 변경하지 않는다", () => {
  const project = projectWithThreeFramesAndTwoLayers();
  const before = JSON.stringify(project);

  assert.throws(
    () => importRegeneratedFrame(project, encodePng(3, 4, new Uint8ClampedArray(48)), { prompt: "검 공격", frameId: project.document.frames[1].id }, "generated/frame.png"),
    /크기/,
  );
  assert.equal(JSON.stringify(project), before);
});

test("투명 팔레트가 있는 인덱스 문서는 재생성 픽셀을 기존 팔레트로 양자화한다", () => {
  const document = createDocument({ width: 4, height: 4 });
  document.colorMode = "indexed";
  document.palette.push({ id: crypto.randomUUID(), name: "투명", color: [0, 0, 0, 0] });
  const project = createProject("기사", document);
  const palette = structuredClone(project.document.palette);
  const png = encodePng(4, 4, new Uint8ClampedArray([
    250, 250, 250, 255, 250, 250, 250, 255, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ]));

  const after = importRegeneratedFrame(project, png, { prompt: "검 공격", frameId: document.frames[0].id }, "generated/frame.png");

  assert.deepEqual(after.document.palette, palette);
  assert.deepEqual(Array.from(compositeFrame(after.document, document.frames[0].id).data), [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255,
  ]);
});

test("투명 팔레트가 없는 인덱스 문서 재생성은 입력을 변경하지 않고 거부한다", () => {
  const document = createDocument({ width: 4, height: 4 });
  document.colorMode = "indexed";
  document.images[Object.keys(document.images)[0]].data.fill(255);
  const project = createProject("기사", document);
  const before = JSON.stringify(project);

  assert.throws(
    () => importRegeneratedFrame(project, encodePng(4, 4, new Uint8ClampedArray(64)), { prompt: "검 공격", frameId: document.frames[0].id }, "generated/frame.png"),
    /투명.*팔레트/,
  );
  assert.equal(JSON.stringify(project), before);
});

test("셀 오프셋이 있어도 재생성 합성 결과의 기준점은 유지한다", () => {
  const document = createDocument({ width: 4, height: 4 });
  const cel = document.cels[celKey(document.frames[0].id, document.layers[0].id)];
  cel.x = 1;
  const project = createProject("기사", document);
  const png = encodePng(4, 4, new Uint8ClampedArray([
    255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ]));

  const after = importRegeneratedFrame(project, png, { prompt: "검 공격", frameId: document.frames[0].id }, "generated/frame.png");

  assert.equal(after.document.cels[celKey(document.frames[0].id, document.layers[0].id)].x, 1);
  assert.deepEqual(Array.from(compositeFrame(after.document, document.frames[0].id).data), [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255,
  ]);
});

test("셀 오프셋 역이동이 경계를 넘으면 재생성은 입력을 변경하지 않고 거부한다", () => {
  const document = createDocument({ width: 4, height: 4 });
  document.cels[celKey(document.frames[0].id, document.layers[0].id)].x = -1;
  const project = createProject("기사", document);
  const before = JSON.stringify(project);
  const png = encodePng(4, 4, new Uint8ClampedArray([
    255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ]));

  assert.throws(
    () => importRegeneratedFrame(project, png, { prompt: "검 공격", frameId: document.frames[0].id }, "generated/frame.png"),
    /경계/,
  );
  assert.equal(JSON.stringify(project), before);
});

test("임의 RGB 투명 팔레트의 다중 레이어 인덱스 문서는 투명 배경을 유지하며 재생성한다", () => {
  let document = createDocument({ width: 4, height: 4 });
  document = addLayer(document, "효과");
  document.colorMode = "indexed";
  const transparent = [10, 20, 30, 0] as const;
  document.palette.push({ id: crypto.randomUUID(), name: "투명", color: transparent });
  for (const image of Object.values(document.images)) {
    for (let offset = 0; offset < image.data.length; offset += 4) image.data.set(transparent, offset);
  }
  const project = createProject("기사", document);
  const palette = structuredClone(project.document.palette);
  const frame = document.frames[0];
  const png = encodePng(4, 4, new Uint8ClampedArray([
    250, 250, 250, 255, 250, 250, 250, 255, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ]));

  const after = importRegeneratedFrame(project, png, { prompt: "검 공격", frameId: frame.id }, "generated/frame.png");

  const blankLayer = after.document.layers[1];
  const blankCel = after.document.cels[celKey(frame.id, blankLayer.id)];
  assert.deepEqual(after.document.palette, palette);
  assert.deepEqual(Array.from(after.document.images[blankCel.imageId].data), Array.from({ length: 16 }, () => transparent).flat());
  assert.deepEqual(Array.from(compositeFrame(after.document, frame.id).data), [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255,
  ]);
});
