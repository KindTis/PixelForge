import { parseAiEditResult, type AiEditSettings, type AiEditTarget, type AiSelectionRun, type AiEditResult } from "../../core/ai-edit.ts";
import { History } from "../../core/commands.ts";
import { nearestPaletteColor } from "../../core/palette.ts";
import { celKey, type Cel, type PixelBuffer, type SpriteDocument } from "../../core/types.ts";
import { ToolController } from "./ToolController.ts";

type AiEditorSettings = Omit<AiEditSettings, "selection"> & { selection?: Uint8Array };
export type AiEditExecutionState = AiEditorSettings & { document: SpriteDocument };
export type AiEditApplication = {
  historySteps: SpriteDocument[];
  settings: AiEditorSettings;
  actionCount: number;
};

function validateMask(mask: Uint8Array, image: PixelBuffer): void {
  if (mask.length !== image.width * image.height) throw new Error("선택 마스크 크기가 올바르지 않습니다.");
}

export function selectionRuns(mask: Uint8Array | undefined, image: PixelBuffer, cel: Cel, document: SpriteDocument): AiSelectionRun[] | undefined {
  if (!mask) return undefined;
  validateMask(mask, image);
  const runs: AiSelectionRun[] = [];
  for (let localY = 0; localY < image.height; localY += 1) {
    const y = cel.y + localY;
    if (y < 0 || y >= document.height) continue;
    let startX: number | undefined;
    for (let localX = 0; localX <= image.width; localX += 1) {
      const x = cel.x + localX;
      const selected = localX < image.width && x >= 0 && x < document.width && Boolean(mask[localY * image.width + localX]);
      if (selected && startX === undefined) startX = x;
      if (!selected && startX !== undefined) {
        runs.push({ y, startX, endX: x - 1 });
        startX = undefined;
      }
    }
  }
  return runs;
}

export function selectionOverlay(mask: Uint8Array | undefined, image: PixelBuffer, cel: Cel, document: SpriteDocument): Uint8Array | undefined {
  if (!mask) return undefined;
  validateMask(mask, image);
  const overlay = new Uint8Array(document.width * document.height);
  for (let localY = 0; localY < image.height; localY += 1) {
    const y = cel.y + localY;
    if (y < 0 || y >= document.height) continue;
    for (let localX = 0; localX < image.width; localX += 1) {
      const x = cel.x + localX;
      if (x >= 0 && x < document.width && mask[localY * image.width + localX]) overlay[y * document.width + x] = 1;
    }
  }
  return overlay;
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

export function runAiEdit(state: AiEditExecutionState, target: AiEditTarget, result: AiEditResult): AiEditApplication {
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

    const controller = new ToolController({ ...settings, celId: cel.id }, image);
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

  return { historySteps, settings, actionCount: parsed.actions.length };
}
