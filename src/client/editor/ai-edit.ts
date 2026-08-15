import type { AiSelectionRun } from "../../core/ai-edit.ts";
import { selectionMask } from "../../core/ai-edit-runner.ts";
import type { Cel, PixelBuffer, SpriteDocument } from "../../core/types.ts";

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

export function selectionReplayMask(mask: Uint8Array | undefined, image: PixelBuffer, cel: Cel, document: SpriteDocument): Uint8Array | undefined {
  return selectionMask(selectionRuns(mask, image, cel, document), image, cel, document);
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
