import type { PixelBuffer, SpriteDocument } from "./types.ts";

export type ResizeAnchor = "start" | "center" | "end";

function validateSize(width: number, height: number): void {
  if (![width, height].every((value) => Number.isInteger(value) && value >= 1 && value <= 4096)) {
    throw new Error("크기는 1~4096 사이의 정수여야 합니다.");
  }
}

function anchorOffset(change: number, anchor: ResizeAnchor): number {
  return anchor === "start" ? 0 : anchor === "center" ? Math.trunc(change / 2) : change;
}

export function resizeCanvas(
  document: SpriteDocument,
  width: number,
  height: number,
  horizontal: ResizeAnchor,
  vertical: ResizeAnchor,
): SpriteDocument {
  validateSize(width, height);
  if (width === document.width && height === document.height) return document;
  const x = anchorOffset(width - document.width, horizontal);
  const y = anchorOffset(height - document.height, vertical);
  return {
    ...document,
    width,
    height,
    cels: Object.fromEntries(Object.entries(document.cels).map(([key, cel]) => [key, { ...cel, x: cel.x + x, y: cel.y + y }])),
  };
}

function scaleNearest(buffer: PixelBuffer, width: number, height: number): PixelBuffer {
  if (width > 4096 || height > 4096) throw new Error("변경 후 셀 이미지 크기는 4096픽셀을 넘을 수 없습니다.");
  if (width === buffer.width && height === buffer.height) return buffer;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const source = (Math.min(buffer.height - 1, Math.floor(y * buffer.height / height)) * buffer.width
      + Math.min(buffer.width - 1, Math.floor(x * buffer.width / width))) * 4;
    data.set(buffer.data.subarray(source, source + 4), (y * width + x) * 4);
  }
  return { width, height, data };
}

export function resizeImage(document: SpriteDocument, width: number, height: number): SpriteDocument {
  validateSize(width, height);
  if (width === document.width && height === document.height) return document;
  const xScale = width / document.width;
  const yScale = height / document.height;
  return {
    ...document,
    width,
    height,
    images: Object.fromEntries(Object.entries(document.images).map(([id, image]) => [id, scaleNearest(
      image,
      Math.max(1, Math.round(image.width * xScale)),
      Math.max(1, Math.round(image.height * yScale)),
    )])),
    cels: Object.fromEntries(Object.entries(document.cels).map(([key, cel]) => [key, {
      ...cel,
      x: Math.round(cel.x * xScale),
      y: Math.round(cel.y * yScale),
    }])),
  };
}
