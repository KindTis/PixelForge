import type { PixelBuffer, RGBA, SpriteDocument } from "./types.ts";

function validatePalette(palette: readonly RGBA[]): void {
  if (palette.length < 1 || palette.length > 256) throw new Error("팔레트는 1~256색이어야 합니다.");
}

export function quantizeToPalette(buffer: PixelBuffer, palette: readonly RGBA[]): Uint8Array {
  validatePalette(palette);
  const indices = new Uint8Array(buffer.width * buffer.height);
  for (let pixel = 0; pixel < indices.length; pixel += 1) indices[pixel] = closestIndex(buffer.data.subarray(pixel * 4, pixel * 4 + 4), palette);
  return indices;
}

function closestIndex(color: ArrayLike<number>, palette: readonly RGBA[]): number {
  validatePalette(palette);
  const transparent = color[3] === 0 && palette.some((entry) => entry[3] === 0);
  let closest = 0;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < palette.length; index += 1) {
    if (transparent && palette[index][3] !== 0) continue;
    let distance = 0;
    for (let channel = 0; channel < 4; channel += 1) {
      const difference = color[channel] - palette[index][channel];
      distance += difference * difference;
    }
    if (distance < closestDistance) { closest = index; closestDistance = distance; }
  }
  return closest;
}

export function sameColor(left: ArrayLike<number>, right: ArrayLike<number>): boolean {
  return [0, 1, 2, 3].every((channel) => left[channel] === right[channel]);
}

export function nearestPaletteColor(color: RGBA, palette: readonly RGBA[]): RGBA {
  return palette[closestIndex(color, palette)];
}

export function indexedToRgba(indices: Uint8Array, width: number, height: number, palette: readonly RGBA[]): PixelBuffer {
  validatePalette(palette);
  if (indices.length !== width * height) throw new Error("인덱스 데이터 크기가 올바르지 않습니다.");
  const data = new Uint8ClampedArray(indices.length * 4);
  for (let pixel = 0; pixel < indices.length; pixel += 1) {
    const color = palette[indices[pixel]];
    if (!color) throw new Error("팔레트에 없는 색상 인덱스입니다.");
    data.set(color, pixel * 4);
  }
  return { width, height, data };
}

export function replaceColor(buffer: PixelBuffer, from: RGBA, to: RGBA, mask?: Uint8Array): PixelBuffer {
  if (mask && mask.length !== buffer.width * buffer.height) throw new Error("선택 마스크 크기가 올바르지 않습니다.");
  const data = new Uint8ClampedArray(buffer.data);
  for (let pixel = 0; pixel < buffer.width * buffer.height; pixel += 1) {
    if (mask && !mask[pixel]) continue;
    const offset = pixel * 4;
    if ([0, 1, 2, 3].every((channel) => data[offset + channel] === from[channel])) data.set(to, offset);
  }
  return { ...buffer, data };
}

export function removePaletteColor(palette: readonly RGBA[], index: number, indices: Uint8Array): { palette: RGBA[]; indices: Uint8Array } {
  validatePalette(palette);
  if (!Number.isInteger(index) || !palette[index]) throw new Error("팔레트 색상 인덱스가 올바르지 않습니다.");
  if (indices.includes(index)) throw new Error("사용 중인 팔레트 색상은 제거할 수 없습니다.");
  const nextIndices = new Uint8Array(indices);
  for (let pixel = 0; pixel < nextIndices.length; pixel += 1) if (nextIndices[pixel] > index) nextIndices[pixel] -= 1;
  return { palette: palette.filter((_, paletteIndex) => paletteIndex !== index), indices: nextIndices };
}

export function convertDocumentToIndexed(document: SpriteDocument): SpriteDocument {
  let palette = document.palette;
  if (!palette.some((entry) => entry.color[3] === 0)) {
    if (palette.length === 256) throw new Error("인덱스 모드에는 투명 팔레트 색상이 필요합니다.");
    palette = [...palette, { id: crypto.randomUUID(), name: "투명", color: [0, 0, 0, 0] }];
  }
  const colors = palette.map((entry) => entry.color);
  const images = Object.fromEntries(Object.entries(document.images).map(([id, image]) => [id, indexedToRgba(quantizeToPalette(image, colors), image.width, image.height, colors)]));
  return { ...document, colorMode: "indexed", palette, images };
}
