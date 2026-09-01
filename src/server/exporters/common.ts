import { compositeFrame } from "../../core/render.ts";
import { layoutSheet, trimBounds, type SheetLayout } from "../../core/sheet-layout.ts";
import type { AnimationDirection, PixelBuffer, SpriteDocument } from "../../core/types.ts";
import { encodePng } from "../png.ts";

export type ExportFile = { path: string; data: string | Uint8Array };
export type SheetOptions = { columns: number; padding: number; margin: number; trim: boolean };

export type CommonMetadata = {
  meta: { app: "PixelForge"; version: 1; image: "spritesheet.png"; size: { w: number; h: number } };
  frames: Array<{
    filename: string;
    frameId: string;
    frame: { x: number; y: number; w: number; h: number };
    rotated: false;
    trimmed: boolean;
    spriteSourceSize: { x: number; y: number; w: number; h: number };
    sourceSize: { w: number; h: number };
    duration: number;
  }>;
  animations: Record<string, { frames: string[]; direction: AnimationDirection }>;
};

export type CommonBundle = { png: Buffer; metadata: CommonMetadata; layout: SheetLayout; buffers: PixelBuffer[] };

function safeName(value: string): string {
  return value.trim().replace(/[^\p{L}\p{N}_-]+/gu, "_") || "animation";
}

export function buildCommon(document: SpriteDocument, options: SheetOptions): CommonBundle {
  const composites = document.frames.map((frame) => compositeFrame(document, frame.id));
  const bounds = composites.map((buffer) => options.trim ? trimBounds(buffer) : { x: 0, y: 0, width: buffer.width, height: buffer.height });
  const layout = layoutSheet(document.frames.map((frame, index) => ({
    id: frame.id,
    width: bounds[index].width,
    height: bounds[index].height,
    sourceX: bounds[index].x,
    sourceY: bounds[index].y,
  })), options);
  if (layout.width > 8192 || layout.height > 8192) throw new Error("내보내기 시트는 8192픽셀을 넘을 수 없습니다.");
  const pixels = new Uint8ClampedArray(layout.width * layout.height * 4);
  for (let index = 0; index < layout.frames.length; index += 1) {
    const target = layout.frames[index];
    const source = composites[index];
    for (let y = 0; y < target.height; y += 1) {
      const sourceOffset = ((target.sourceY + y) * source.width + target.sourceX) * 4;
      const targetOffset = ((target.rect.y + y) * layout.width + target.rect.x) * 4;
      pixels.set(source.data.subarray(sourceOffset, sourceOffset + target.width * 4), targetOffset);
    }
  }

  const filenames = document.frames.map((frame, index) => {
    const tag = document.tags.find((candidate) => candidate.frameIds.includes(frame.id));
    return `${safeName(tag?.name ?? "default")}_${String(index).padStart(3, "0")}`;
  });
  const animations: CommonMetadata["animations"] = {};
  if (document.tags.length) for (const tag of document.tags) {
    animations[tag.name] = {
      frames: tag.frameIds.map((frameId) => filenames[document.frames.findIndex((frame) => frame.id === frameId)]),
      direction: tag.direction,
    };
  } else animations.default = { frames: filenames, direction: "forward" };

  const metadata: CommonMetadata = {
    meta: { app: "PixelForge", version: 1, image: "spritesheet.png", size: { w: layout.width, h: layout.height } },
    frames: layout.frames.map((item, index) => ({
      filename: filenames[index],
      frameId: item.id,
      frame: { x: item.rect.x, y: item.rect.y, w: item.rect.width, h: item.rect.height },
      rotated: false,
      trimmed: item.sourceX !== 0 || item.sourceY !== 0 || item.width !== document.width || item.height !== document.height,
      spriteSourceSize: { x: item.sourceX, y: item.sourceY, w: item.width, h: item.height },
      sourceSize: { w: document.width, h: document.height },
      duration: document.frames[index].durationMs,
    })),
    animations,
  };
  return { png: encodePng(layout.width, layout.height, pixels), metadata, layout, buffers: composites };
}

export async function exportCommon(document: SpriteDocument, options: SheetOptions): Promise<ExportFile[]> {
  const bundle = buildCommon(document, options);
  return [
    { path: "spritesheet.png", data: bundle.png },
    { path: "spritesheet.json", data: `${JSON.stringify(bundle.metadata, null, 2)}\n` },
  ];
}
