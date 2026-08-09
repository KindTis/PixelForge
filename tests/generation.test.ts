import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, createProject } from "../src/core/document.ts";
import { buildSpriteSheetPrompt, importSpriteSheet, type SpriteSheetRequest } from "../src/server/generation.ts";
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
