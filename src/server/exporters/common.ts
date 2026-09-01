import { createHash } from "node:crypto";
import { frameSequence } from "../../core/animation.ts";
import { compositeFrame } from "../../core/render.ts";
import { layoutSheet, trimBounds, type SheetLayout } from "../../core/sheet-layout.ts";
import type { AnimationDirection, PixelBuffer, SpriteDocument } from "../../core/types.ts";
import { encodePng } from "../png.ts";

export type ExportFile = { path: string; data: string | Uint8Array };
export type SheetOptions = { columns: number; padding: number; margin: number; trim: boolean };

export type CommonAnimationStep = {
  frameId: string;
  sprite: string;
  duration: number;
};

export type CommonMetadata = {
  meta: { app: "PixelForge"; version: 1; image: "spritesheet.png"; size: { w: number; h: number } };
  frames: Array<{
    filename: string;
    frame: { x: number; y: number; w: number; h: number };
    rotated: false;
    trimmed: boolean;
    spriteSourceSize: { x: number; y: number; w: number; h: number };
    sourceSize: { w: number; h: number };
  }>;
  animations: Array<{
    name: string;
    direction: AnimationDirection;
    steps: CommonAnimationStep[];
  }>;
};

export type CommonBundle = { png: Buffer; metadata: CommonMetadata; layout: SheetLayout; buffers: PixelBuffer[] };

type UniqueSprite = { id: string; buffer: PixelBuffer };

function samePixels(left: PixelBuffer, right: PixelBuffer): boolean {
  return left.width === right.width
    && left.height === right.height
    && left.data.length === right.data.length
    && left.data.every((channel, index) => channel === right.data[index]);
}

function pixelHash(buffer: PixelBuffer): string {
  const dimensions = Buffer.allocUnsafe(8);
  dimensions.writeUInt32LE(buffer.width, 0);
  dimensions.writeUInt32LE(buffer.height, 4);
  return createHash("sha256").update(dimensions).update(buffer.data).digest("hex");
}

export function buildCommon(document: SpriteDocument, options: SheetOptions): CommonBundle {
  const tags = document.tags.filter((tag) => tag.frameIds.length > 0);
  if (tags.length === 0) throw new Error("내보낼 애니메이션 세트가 없습니다.");

  const framesById = new Map(document.frames.map((frame) => [frame.id, frame]));
  const candidates = new Map<string, number[]>();
  const sprites: UniqueSprite[] = [];
  const spriteByFrameId = new Map<string, string>();
  for (const tag of tags) {
    for (const frameId of tag.frameIds) {
      if (spriteByFrameId.has(frameId)) continue;
      const buffer = compositeFrame(document, frameId);
      const hash = pixelHash(buffer);
      const match = (candidates.get(hash) ?? []).find((index) => samePixels(sprites[index].buffer, buffer));
      if (match !== undefined) {
        spriteByFrameId.set(frameId, sprites[match].id);
        continue;
      }
      const id = `sprite_${String(sprites.length).padStart(3, "0")}`;
      spriteByFrameId.set(frameId, id);
      const index = sprites.push({ id, buffer }) - 1;
      candidates.set(hash, [...(candidates.get(hash) ?? []), index]);
    }
  }

  const bounds = sprites.map(({ buffer }) => options.trim ? trimBounds(buffer) : { x: 0, y: 0, width: buffer.width, height: buffer.height });
  const layout = layoutSheet(sprites.map((sprite, index) => ({
    id: sprite.id,
    width: bounds[index].width,
    height: bounds[index].height,
    sourceX: bounds[index].x,
    sourceY: bounds[index].y,
  })), options);
  if (layout.width > 8192 || layout.height > 8192) throw new Error("내보내기 시트는 8192픽셀을 넘을 수 없습니다.");
  const pixels = new Uint8ClampedArray(layout.width * layout.height * 4);
  for (let index = 0; index < layout.frames.length; index += 1) {
    const target = layout.frames[index];
    const source = sprites[index].buffer;
    for (let y = 0; y < target.height; y += 1) {
      const sourceOffset = ((target.sourceY + y) * source.width + target.sourceX) * 4;
      const targetOffset = ((target.rect.y + y) * layout.width + target.rect.x) * 4;
      pixels.set(source.data.subarray(sourceOffset, sourceOffset + target.width * 4), targetOffset);
    }
  }

  const metadata: CommonMetadata = {
    meta: { app: "PixelForge", version: 1, image: "spritesheet.png", size: { w: layout.width, h: layout.height } },
    frames: layout.frames.map((item) => ({
      filename: item.id,
      frame: { x: item.rect.x, y: item.rect.y, w: item.rect.width, h: item.rect.height },
      rotated: false,
      trimmed: item.sourceX !== 0 || item.sourceY !== 0 || item.width !== document.width || item.height !== document.height,
      spriteSourceSize: { x: item.sourceX, y: item.sourceY, w: item.width, h: item.height },
      sourceSize: { w: document.width, h: document.height },
    })),
    animations: tags.map((tag) => ({
      name: tag.name,
      direction: tag.direction,
      steps: frameSequence(tag).map((frameId) => ({
        frameId,
        sprite: spriteByFrameId.get(frameId)!,
        duration: framesById.get(frameId)!.durationMs,
      })),
    })),
  };
  return { png: encodePng(layout.width, layout.height, pixels), metadata, layout, buffers: sprites.map(({ buffer }) => buffer) };
}

export async function exportCommon(document: SpriteDocument, options: SheetOptions): Promise<ExportFile[]> {
  const bundle = buildCommon(document, options);
  return [
    { path: "spritesheet.png", data: bundle.png },
    { path: "spritesheet.json", data: `${JSON.stringify(bundle.metadata, null, 2)}\n` },
  ];
}
