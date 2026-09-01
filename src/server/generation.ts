import { addAnimationTag, assertUniqueUnityAnimationClipFileNames } from "../core/animation.ts";
import { duplicateFrame, moveFrame } from "../core/timeline.ts";
import type { AnimationDirection, Cel, Frame, Layer, PixelBuffer, RGBA, SpriteProject } from "../core/types.ts";
import { celKey } from "../core/types.ts";
import { validateDocument } from "../core/document.ts";
import { indexedToRgba, quantizeToPalette } from "../core/palette.ts";
import { decodePng } from "./png.ts";

export type SpriteSheetRequest = {
  prompt: string;
  frameCount: number;
  columns: number;
  cellWidth: number;
  cellHeight: number;
  durationMs: number;
  parentId?: string;
  referencePath?: string;
};

export type FrameRegenerationRequest = {
  prompt: string;
  frameId: string;
  parentId?: string;
  referencePath?: string;
};

export type FrameReferencePaths = {
  first: string;
  previous?: string;
  next?: string;
};

export type AppendAnimationRequest = {
  name: string;
  baseFrameId: string;
  targetLayerId: string;
  direction: AnimationDirection;
  prompt: string;
  frameCount: number;
  columns: number;
  cellWidth: number;
  cellHeight: number;
  parentId?: string;
  referencePath?: string;
};

function validateSheetShape(request: Pick<SpriteSheetRequest, "prompt" | "frameCount" | "columns" | "cellWidth" | "cellHeight">): void {
  if (!request.prompt.trim()) throw new Error("생성 프롬프트가 필요합니다.");
  if (!Number.isInteger(request.frameCount) || request.frameCount < 1 || request.frameCount > 256) {
    throw new Error("프레임 수는 1~256 사이의 정수여야 합니다.");
  }
  if (!Number.isInteger(request.columns) || request.columns < 1 || request.columns > request.frameCount) {
    throw new Error("열 수는 프레임 수 이하의 양의 정수여야 합니다.");
  }
  if (!Number.isInteger(request.cellWidth) || !Number.isInteger(request.cellHeight)
    || request.cellWidth < 1 || request.cellHeight < 1
    || request.cellWidth > 4096 || request.cellHeight > 4096) {
    throw new Error("프레임 크기는 1~4096 사이의 정수여야 합니다.");
  }
  const rows = Math.ceil(request.frameCount / request.columns);
  if (request.columns * request.cellWidth > 8192 || rows * request.cellHeight > 8192) {
    throw new Error("전체 시트 크기는 8192픽셀을 넘을 수 없습니다.");
  }
}

function validate(request: SpriteSheetRequest): void {
  validateSheetShape(request);
  if (!Number.isFinite(request.durationMs) || request.durationMs < 1) {
    throw new Error("프레임 시간은 1ms 이상이어야 합니다.");
  }
}

export function assertAppendAnimationRequest(project: SpriteProject, request: AppendAnimationRequest): void {
  validateDocument(project.document);
  validateSheetShape(request);
  const name = request.name.trim();
  if (!name) throw new Error("애니메이션 태그 이름이 필요합니다.");
  if (!(["forward", "reverse", "pingPong"] as const).includes(request.direction)) {
    throw new Error("재생 방향이 올바르지 않습니다.");
  }
  if (project.document.tags.length === 0) {
    throw new Error("먼저 타임라인에서 현재 전체 구간의 애니메이션 태그를 추가하세요.");
  }
  if (project.document.tags.some((tag) => tag.name === name)) {
    throw new Error("애니메이션 태그 이름은 비어 있지 않고 고유해야 합니다.");
  }
  assertUniqueUnityAnimationClipFileNames([...project.document.tags, { name }]);
  if (!project.document.frames.some((frame) => frame.id === request.baseFrameId)) {
    throw new Error("기준 프레임을 찾을 수 없습니다.");
  }
  const layer = project.document.layers.find((candidate) => candidate.id === request.targetLayerId);
  if (!layer) throw new Error("대상 레이어를 찾을 수 없습니다.");
  if (!project.document.cels[celKey(request.baseFrameId, request.targetLayerId)]) {
    throw new Error("기준 프레임의 대상 레이어 셀을 찾을 수 없습니다.");
  }
  if (!layer.visible || layer.locked || layer.blendMode !== "normal" || layer.opacity !== 1) {
    throw new Error("대상 레이어는 보이고 잠기지 않은 normal·불투명도 1 레이어여야 합니다.");
  }
  if (request.cellWidth !== project.document.width || request.cellHeight !== project.document.height) {
    throw new Error("요청 셀 크기가 프로젝트 캔버스와 다릅니다.");
  }
  if (project.document.colorMode === "indexed" && !project.document.palette.some((entry) => entry.color[3] === 0)) {
    throw new Error("인덱스 문서에는 투명 팔레트 색상이 필요합니다.");
  }
}

export function buildSpriteSheetPrompt(request: SpriteSheetRequest, outputPath: string): string {
  validate(request);
  if (!outputPath.trim()) throw new Error("출력 파일 경로가 필요합니다.");
  const rows = Math.ceil(request.frameCount / request.columns);
  const anchorX = Math.floor(request.cellWidth / 2);
  const anchorY = request.cellHeight - Math.max(1, Math.round(request.cellHeight / 8));
  return [
    request.prompt.trim(),
    request.referencePath ? `캐릭터 외형과 팔레트는 다음 참조 이미지를 따르세요: ${request.referencePath}` : "",
    `캐릭터 스프라이트 시트를 ${request.frameCount}프레임, ${request.columns}열 × ${rows}행으로 제작하세요.`,
    `각 프레임 크기: ${request.cellWidth} × ${request.cellHeight} 픽셀. 전체 이미지 크기: ${request.columns * request.cellWidth} × ${rows * request.cellHeight} 픽셀.`,
    "모든 프레임에서 캐릭터 비율, 카메라, 조명, 팔레트를 일관되게 유지하고 셀 경계가 겹치지 않게 하세요.",
    `모든 프레임의 지면 기준점과 하체 중심을 각 셀의 x=${anchorX}, y=${anchorY} 픽셀에 고정하고, 카메라 이동이나 루트 이동 없는 제자리 모션으로 만드세요.`,
    "투명 배경의 픽셀 아트 PNG 한 장만 만들고, 빈 셀은 완전히 투명하게 두세요.",
    `결과를 반드시 다음 경로에 저장하세요: ${outputPath}`,
  ].filter(Boolean).join("\n");
}

export function buildAppendAnimationPrompt(
  request: AppendAnimationRequest,
  baseReferencePath: string,
  outputPath: string,
): string {
  validateSheetShape(request);
  if (!request.name.trim()) throw new Error("애니메이션 태그 이름이 필요합니다.");
  if (!(["forward", "reverse", "pingPong"] as const).includes(request.direction)) {
    throw new Error("재생 방향이 올바르지 않습니다.");
  }
  if (!baseReferencePath.trim()) throw new Error("기준 프레임 참조 경로가 필요합니다.");
  if (!outputPath.trim()) throw new Error("출력 파일 경로가 필요합니다.");
  const rows = Math.ceil(request.frameCount / request.columns);
  const anchorX = Math.floor(request.cellWidth / 2);
  const anchorY = request.cellHeight - Math.max(1, Math.round(request.cellHeight / 8));
  return [
    request.prompt.trim(),
    `기준 프레임 참조: ${baseReferencePath}`,
    request.referencePath ? `외형 보조 참조: ${request.referencePath}` : "",
    "기준 프레임은 출력 시트에 포함하지 마세요.",
    `기준 프레임 직후의 후속 동작 프레임을 정확히 ${request.frameCount}개, ${request.columns}열 × ${rows}행으로 만드세요.`,
    `각 프레임 크기: ${request.cellWidth} × ${request.cellHeight} 픽셀. 전체 이미지 크기: ${request.columns * request.cellWidth} × ${rows * request.cellHeight} 픽셀.`,
    `프레임은 시간상 정방향으로 배치하세요. 재생 방향 ${request.direction}은 생성 순서가 아니라 재생과 내보내기 의미입니다.`,
    "기준 프레임의 캐릭터 외형, 팔레트, 비율, 카메라를 유지하세요.",
    `지면 기준점과 하체 중심을 각 셀의 x=${anchorX}, y=${anchorY} 픽셀에 고정하세요.`,
    "투명 배경의 픽셀 아트 PNG 한 장만 만드세요.",
    `결과를 반드시 다음 경로에 저장하세요: ${outputPath}`,
  ].filter(Boolean).join("\n");
}

export function buildFrameRegenerationPrompt(
  project: SpriteProject,
  request: FrameRegenerationRequest,
  references: FrameReferencePaths,
  outputPath: string,
): string {
  if (!request.prompt.trim()) throw new Error("생성 프롬프트가 필요합니다.");
  if (!outputPath.trim()) throw new Error("출력 파일 경로가 필요합니다.");
  if (!references.first.trim()) throw new Error("첫 프레임 참조 경로가 필요합니다.");

  const { frames, tags } = project.document;
  const frameIndex = frames.findIndex((frame) => frame.id === request.frameId);
  if (frameIndex < 0) throw new Error("선택한 프레임을 찾을 수 없습니다.");

  const tag = tags.find((candidate) => candidate.frameIds.includes(request.frameId));
  const rangeFrameIds = tag?.frameIds ?? frames.map((frame) => frame.id);
  const rangeIndex = rangeFrameIds.indexOf(request.frameId);
  const progress = rangeFrameIds.length === 1 ? 100 : (rangeIndex / (rangeFrameIds.length - 1)) * 100;
  const anchorX = Math.floor(project.document.width / 2);
  const anchorY = project.document.height - Math.max(1, Math.round(project.document.height / 8));

  return [
    request.prompt.trim(),
    request.referencePath ? `캐릭터 외형과 팔레트는 다음 참조 이미지를 따르세요: ${request.referencePath}` : "",
    `선택 프레임: ${frameIndex + 1}/${frames.length}`,
    `애니메이션 태그: ${tag?.name ?? "전체 구간"}`,
    `재생 방향: ${tag?.direction ?? "forward"}`,
    `진행률: ${progress.toFixed(1)}%`,
    "원 프롬프트, 타임라인 위치와 역할별 참조를 함께 해석해 현재 동작 단계를 준비·타격·후속·복귀 중 하나로 먼저 판단하세요.",
    "첫 프레임 참조는 캐릭터 외형·팔레트·크기·카메라의 기준으로, 이전·다음 참조는 앞뒤 동작 연결의 기준으로 사용하고, 선택적 참조가 없는 경계에서는 존재하는 참조만 사용하세요.",
    `첫 프레임 참조: ${references.first}`,
    references.previous?.trim() ? `이전 프레임 참조: ${references.previous}` : "",
    references.next?.trim() ? `다음 프레임 참조: ${references.next}` : "",
    `정확한 캔버스 크기: ${project.document.width} × ${project.document.height} 픽셀. 투명 배경의 픽셀 아트 한 프레임만 만드세요.`,
    `지면 기준점과 하체 중심을 각 프레임의 x=${anchorX}, y=${anchorY} 픽셀에 고정하세요.`,
    `결과를 반드시 다음 경로에 저장하세요: ${outputPath}`,
  ].filter(Boolean).join("\n");
}

function alignFrame(data: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
  const rowCounts = new Uint32Array(height);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let contentMinX = width;
  let contentMinY = height;
  let contentMaxX = -1;
  let contentMaxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha === 0) continue;
      contentMinX = Math.min(contentMinX, x);
      contentMinY = Math.min(contentMinY, y);
      contentMaxX = Math.max(contentMaxX, x);
      contentMaxY = Math.max(contentMaxY, y);
      if (alpha <= 16) continue;
      rowCounts[y] += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxY < 0) return data;

  const minimumGroundPixels = Math.max(2, Math.ceil(width * 0.02));
  let groundY = maxY;
  while (groundY > minY && rowCounts[groundY] < minimumGroundPixels) groundY -= 1;
  const lowerTop = Math.max(minY, groundY - Math.max(1, Math.round(height * 0.35)));
  const lowerColumns = new Uint32Array(width);
  let lowerPixelCount = 0;
  for (let y = lowerTop; y <= groundY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if (data[(y * width + x) * 4 + 3] <= 16) continue;
      lowerColumns[x] += 1;
      lowerPixelCount += 1;
    }
  }
  const middlePixel = Math.floor((lowerPixelCount - 1) / 2);
  let anchorX = minX;
  let pixelsSeen = 0;
  for (; anchorX <= maxX; anchorX += 1) {
    pixelsSeen += lowerColumns[anchorX];
    if (pixelsSeen > middlePixel) break;
  }
  const targetX = Math.floor(width / 2);
  const targetY = height - Math.max(1, Math.round(height / 8));
  const offsetX = Math.max(-contentMinX, Math.min(width - 1 - contentMaxX, targetX - anchorX));
  const offsetY = Math.max(-contentMinY, Math.min(height - 1 - contentMaxY, targetY - groundY));
  if (offsetX === 0 && offsetY === 0) return data;

  const aligned = new Uint8ClampedArray(data.length);
  for (let y = 0; y < height; y += 1) {
    const targetYPosition = y + offsetY;
    if (targetYPosition < 0 || targetYPosition >= height) continue;
    for (let x = 0; x < width; x += 1) {
      const targetXPosition = x + offsetX;
      if (targetXPosition < 0 || targetXPosition >= width) continue;
      const source = (y * width + x) * 4;
      const target = (targetYPosition * width + targetXPosition) * 4;
      aligned.set(data.subarray(source, source + 4), target);
    }
  }
  return aligned;
}

function extractSheetFrame(
  sheet: PixelBuffer,
  index: number,
  request: Pick<SpriteSheetRequest, "columns" | "cellWidth" | "cellHeight">,
): PixelBuffer {
  const data = new Uint8ClampedArray(request.cellWidth * request.cellHeight * 4);
  const originX = (index % request.columns) * request.cellWidth;
  const originY = Math.floor(index / request.columns) * request.cellHeight;
  for (let y = 0; y < request.cellHeight; y += 1) {
    const source = ((originY + y) * sheet.width + originX) * 4;
    data.set(sheet.data.subarray(source, source + request.cellWidth * 4), y * request.cellWidth * 4);
  }
  return {
    width: request.cellWidth,
    height: request.cellHeight,
    data: alignFrame(data, request.cellWidth, request.cellHeight),
  };
}

function transparentFrame(width: number, height: number, color?: RGBA): PixelBuffer {
  const data = new Uint8ClampedArray(width * height * 4);
  if (color) for (let offset = 0; offset < data.length; offset += 4) data.set(color, offset);
  return { width, height, data };
}

function offsetFrame(data: Uint8ClampedArray, width: number, height: number, x: number, y: number): Uint8ClampedArray {
  if (x === 0 && y === 0) return data;
  const offset = new Uint8ClampedArray(data.length);
  for (let sourceY = 0; sourceY < height; sourceY += 1) {
    for (let sourceX = 0; sourceX < width; sourceX += 1) {
      const source = (sourceY * width + sourceX) * 4;
      const targetX = sourceX - x;
      const targetY = sourceY - y;
      if (targetX < 0 || targetX >= width || targetY < 0 || targetY >= height) {
        if (data[source + 3] > 0) throw new Error("셀 오프셋 보정으로 픽셀이 캔버스 경계를 벗어납니다.");
        continue;
      }
      offset.set(data.subarray(source, source + 4), (targetY * width + targetX) * 4);
    }
  }
  return offset;
}

export function importSpriteSheet(
  project: SpriteProject,
  png: Uint8Array,
  request: SpriteSheetRequest,
  outputPath: string,
): SpriteProject {
  validate(request);
  const sheet = decodePng(png);
  const rows = Math.ceil(request.frameCount / request.columns);
  if (sheet.width !== request.columns * request.cellWidth || sheet.height !== rows * request.cellHeight) {
    throw new Error("생성된 시트 크기가 요청한 격자와 다릅니다.");
  }

  const layer: Layer = {
    id: crypto.randomUUID(),
    name: "생성 결과",
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: "normal",
  };
  const frames: Frame[] = [];
  const cels: Record<string, Cel> = {};
  const images: Record<string, PixelBuffer> = {};

  for (let index = 0; index < request.frameCount; index += 1) {
    const frame: Frame = { id: crypto.randomUUID(), durationMs: request.durationMs };
    const imageId = crypto.randomUUID();
    frames.push(frame);
    images[imageId] = extractSheetFrame(sheet, index, request);
    cels[celKey(frame.id, layer.id)] = { id: crypto.randomUUID(), imageId, x: 0, y: 0, opacity: 1 };
  }

  return {
    ...project,
    document: {
      width: request.cellWidth,
      height: request.cellHeight,
      colorMode: "rgba",
      frames,
      layers: [layer],
      cels,
      images,
      palette: project.document.palette,
      tags: [],
    },
    generationHistory: [...project.generationHistory, {
      id: crypto.randomUUID(),
      prompt: request.prompt.trim(),
      createdAt: new Date().toISOString(),
      outputPath,
      parentId: request.parentId,
    }],
    exportSettings: { ...project.exportSettings, columns: request.columns },
  };
}

export function appendAnimationSheet(
  project: SpriteProject,
  png: Uint8Array,
  request: AppendAnimationRequest,
  outputPath: string,
): SpriteProject {
  assertAppendAnimationRequest(project, request);
  if (!outputPath.trim()) throw new Error("출력 파일 경로가 필요합니다.");
  const sheet = decodePng(png);
  const rows = Math.ceil(request.frameCount / request.columns);
  if (sheet.width !== request.columns * request.cellWidth || sheet.height !== rows * request.cellHeight) {
    throw new Error("생성된 시트 크기가 요청한 격자와 다릅니다.");
  }

  const baseIndex = project.document.frames.findIndex((frame) => frame.id === request.baseFrameId);
  let document = duplicateFrame(project.document, request.baseFrameId);
  const baseCloneId = document.frames[baseIndex + 1].id;
  document = moveFrame(document, baseCloneId, document.frames.length - 1);
  const durationMs = project.document.frames[baseIndex].durationMs;
  const palette = document.palette.map((entry) => entry.color);
  const transparent = palette.find((color) => color[3] === 0);

  for (let index = 0; index < request.frameCount; index += 1) {
    const frame: Frame = { id: crypto.randomUUID(), durationMs };
    document.frames.push(frame);
    for (const layer of document.layers) {
      const imageId = crypto.randomUUID();
      const rgba = layer.id === request.targetLayerId
        ? extractSheetFrame(sheet, index, request)
        : transparentFrame(request.cellWidth, request.cellHeight, document.colorMode === "indexed" ? transparent : undefined);
      document.images[imageId] = document.colorMode === "indexed"
        ? indexedToRgba(quantizeToPalette(rgba, palette), rgba.width, rgba.height, palette)
        : rgba;
      document.cels[celKey(frame.id, layer.id)] = {
        id: crypto.randomUUID(),
        imageId,
        x: 0,
        y: 0,
        opacity: 1,
      };
    }
  }

  document = addAnimationTag(document, {
    name: request.name,
    frameIds: [baseCloneId, ...document.frames.slice(-request.frameCount).map((frame) => frame.id)],
    direction: request.direction,
  });
  return {
    ...project,
    document,
    generationHistory: [...project.generationHistory, {
      id: crypto.randomUUID(),
      prompt: request.prompt.trim(),
      createdAt: new Date().toISOString(),
      outputPath,
      parentId: request.parentId,
    }],
  };
}

export function importRegeneratedFrame(
  project: SpriteProject,
  png: Uint8Array,
  request: FrameRegenerationRequest,
  outputPath: string,
): SpriteProject {
  if (!request.prompt.trim()) throw new Error("생성 프롬프트가 필요합니다.");
  if (!outputPath.trim()) throw new Error("출력 파일 경로가 필요합니다.");
  validateDocument(project.document);
  const frame = project.document.frames.find((candidate) => candidate.id === request.frameId);
  if (!frame) throw new Error("선택한 프레임을 찾을 수 없습니다.");
  const generated = decodePng(png);
  if (generated.width !== project.document.width || generated.height !== project.document.height) {
    throw new Error("생성된 프레임 크기가 캔버스와 다릅니다.");
  }

  const cels = project.document.layers
    .map((layer) => ({ layer, cel: project.document.cels[celKey(frame.id, layer.id)] }))
    .filter((candidate): candidate is { layer: Layer; cel: Cel } => Boolean(candidate.cel));
  const output = cels.find(({ layer, cel }) => layer.visible && layer.blendMode === "normal" && layer.opacity === 1 && cel.opacity === 1) ?? cels[0];
  if (!output) throw new Error("선택한 프레임에 셀이 없습니다.");

  const palette = project.document.palette.map((entry) => entry.color);
  if (project.document.colorMode === "indexed" && !palette.some((color) => color[3] === 0)) {
    throw new Error("인덱스 문서에는 투명 팔레트 색상이 필요합니다.");
  }
  const aligned = offsetFrame(alignFrame(generated.data, generated.width, generated.height), generated.width, generated.height, output.cel.x, output.cel.y);

  const next = structuredClone(project);
  const result = next.document.colorMode === "indexed"
    ? indexedToRgba(quantizeToPalette({ width: generated.width, height: generated.height, data: aligned }, palette), generated.width, generated.height, palette)
    : { width: generated.width, height: generated.height, data: aligned };
  const blank = new Uint8ClampedArray(result.data.length);
  if (next.document.colorMode === "indexed") {
    const transparent = palette.find((color) => color[3] === 0)!;
    for (let offset = 0; offset < blank.length; offset += 4) blank.set(transparent, offset);
  }
  const replacedImageIds = new Set(cels.map(({ cel }) => cel.imageId));

  for (const { layer, cel } of cels) {
    const imageId = crypto.randomUUID();
    next.document.cels[celKey(frame.id, layer.id)].imageId = imageId;
    next.document.images[imageId] = {
      width: generated.width,
      height: generated.height,
      data: cel.id === output.cel.id ? result.data : new Uint8ClampedArray(blank),
    };
  }
  for (const imageId of replacedImageIds) {
    if (!Object.values(next.document.cels).some((cel) => cel.imageId === imageId)) delete next.document.images[imageId];
  }
  validateDocument(next.document);
  return next;
}
