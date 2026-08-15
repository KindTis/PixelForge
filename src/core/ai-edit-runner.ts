import { parseAiEditResult, type AiEditAttempt, type AiEditResult, type AiEditSettings, type AiEditTarget, type AiSelectionRun } from "./ai-edit.ts";
import { History } from "./commands.ts";
import { nearestPaletteColor } from "./palette.ts";
import { ToolController } from "./tool-controller.ts";
import { celKey, type Cel, type PixelBuffer, type SpriteDocument } from "./types.ts";

export type AiEditorSettings = Omit<AiEditSettings, "selection"> & { selection?: Uint8Array };
export type AiEditExecutionState = AiEditorSettings & { document: SpriteDocument };
export type AiEditApplication = {
  document: SpriteDocument;
  historySteps: SpriteDocument[];
  settings: AiEditorSettings;
  actionCount: number;
};

function seededRandom(seed: number): () => number {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) throw new Error("AI 편집 시드는 32비트 부호 없는 정수여야 합니다.");
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

function targetCel(document: SpriteDocument, target: AiEditTarget): { cel: Cel; image: PixelBuffer } {
  const layer = document.layers.find(({ id }) => id === target.layerId);
  if (!document.frames.some(({ id }) => id === target.frameId) || !layer) throw new Error("AI 편집 대상을 찾을 수 없습니다.");
  if (layer.locked) throw new Error("잠긴 레이어는 편집할 수 없습니다.");
  const cel = document.cels[celKey(target.frameId, target.layerId)];
  if (!cel || cel.id !== target.celId) throw new Error("AI 편집 대상 셀이 변경되었습니다.");
  const image = document.images[cel.imageId];
  if (!image) throw new Error("AI 편집 대상 이미지가 없습니다.");
  return { cel, image };
}

export function runAiEdit(state: AiEditExecutionState, target: AiEditTarget, result: AiEditResult, seed: number): AiEditApplication {
  const parsed = parseAiEditResult(result, state.document.width, state.document.height);
  targetCel(state.document, target);

  const temporary = new History(structuredClone(state.document));
  const settings: AiEditorSettings = {
    tool: state.tool,
    color: state.color,
    secondaryColor: state.secondaryColor,
    brushSize: state.brushSize,
    brushShape: state.brushShape,
    customBrush: state.customBrush?.map((point) => ({ ...point })),
    filled: state.filled,
    mirrorX: state.mirrorX,
    mirrorY: state.mirrorY,
    selection: state.selection?.slice(),
  };
  const random = seededRandom(seed);
  const historySteps: SpriteDocument[] = [];

  for (const action of parsed.actions) {
    const { cel, image } = targetCel(temporary.document, target);
    settings.tool = action.tool;
    const palette = temporary.document.palette.map((entry) => entry.color);
    const editColor = (color: typeof settings.color) => temporary.document.colorMode === "indexed" ? nearestPaletteColor(color, palette) : color;
    if (action.color !== undefined) settings.color = editColor(action.color);
    if (action.secondaryColor !== undefined) settings.secondaryColor = editColor(action.secondaryColor);
    if (action.brushSize !== undefined) settings.brushSize = action.brushSize;
    if (action.brushShape !== undefined) {
      settings.brushShape = action.brushShape;
      settings.customBrush = undefined;
    }
    if (action.filled !== undefined) settings.filled = action.filled;
    if (action.mirrorX !== undefined) settings.mirrorX = action.mirrorX;
    if (action.mirrorY !== undefined) settings.mirrorY = action.mirrorY;

    const controller = new ToolController({ ...settings, celId: cel.id, random }, image);
    const points = action.points.map(({ x, y }) => ({ x: x - cel.x, y: y - cel.y }));
    controller.pointerDown(points[0]);
    for (const point of points.slice(1, -1)) controller.pointerMove(point);
    const toolResult = controller.pointerUp(points.at(-1)!);

    if (toolResult.command) {
      const before = temporary.document;
      const command = before.colorMode === "indexed"
        ? { ...toolResult.command, pixels: toolResult.command.pixels.map((pixel) => ({ ...pixel, rgba: nearestPaletteColor(pixel.rgba, palette) })) }
        : toolResult.command;
      const after = temporary.execute(command);
      if (after !== before) historySteps.push(after);
    }
    if (toolResult.color) settings.color = toolResult.color;
    if (toolResult.selection) settings.selection = toolResult.selection;
  }

  return { document: temporary.document, historySteps, settings, actionCount: parsed.actions.length };
}

export function runAiEditAttempts(state: AiEditExecutionState, target: AiEditTarget, attempts: readonly AiEditAttempt[]): AiEditApplication {
  let document = state.document;
  let settings: AiEditorSettings = {
    tool: state.tool,
    color: state.color,
    secondaryColor: state.secondaryColor,
    brushSize: state.brushSize,
    brushShape: state.brushShape,
    customBrush: state.customBrush?.map((point) => ({ ...point })),
    filled: state.filled,
    mirrorX: state.mirrorX,
    mirrorY: state.mirrorY,
    selection: state.selection?.slice(),
  };
  const historySteps: SpriteDocument[] = [];
  let actionCount = 0;
  for (const attempt of attempts) {
    const next = runAiEdit({ ...settings, document }, target, attempt.result, attempt.seed);
    document = next.document;
    settings = next.settings;
    historySteps.push(...next.historySteps);
    actionCount += next.actionCount;
  }
  return { document, settings, historySteps, actionCount };
}

export function selectionMask(
  runs: readonly AiSelectionRun[] | undefined,
  image: PixelBuffer,
  cel: Cel,
  document: SpriteDocument,
): Uint8Array | undefined {
  if (runs === undefined) return undefined;
  const mask = new Uint8Array(image.width * image.height);
  for (const run of runs) {
    if (run.y < 0 || run.y >= document.height) throw new Error("선택 범위가 문서 범위를 벗어났습니다.");
    const localY = run.y - cel.y;
    if (localY < 0 || localY >= image.height) continue;
    for (let x = run.startX; x <= run.endX; x += 1) {
      const localX = x - cel.x;
      if (localX >= 0 && localX < image.width) mask[localY * image.width + localX] = 1;
    }
  }
  return mask;
}
