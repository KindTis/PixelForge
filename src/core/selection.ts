import type { PixelBuffer } from "./types.ts";
import type { Point } from "./raster.ts";

export type SelectionContent = PixelBuffer & {
  mask: Uint8Array;
  originX: number;
  originY: number;
};

export function rectangleMask(width: number, height: number, start: Point, end: Point): Uint8Array {
  const mask = new Uint8Array(width * height);
  const left = Math.max(0, Math.min(Math.round(start.x), Math.round(end.x)));
  const right = Math.min(width - 1, Math.max(Math.round(start.x), Math.round(end.x)));
  const top = Math.max(0, Math.min(Math.round(start.y), Math.round(end.y)));
  const bottom = Math.min(height - 1, Math.max(Math.round(start.y), Math.round(end.y)));
  for (let y = top; y <= bottom; y += 1) mask.fill(1, y * width + left, y * width + right + 1);
  return mask;
}

function insidePolygon(point: Point, vertices: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i, i += 1) {
    const a = vertices[i];
    const b = vertices[j];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function lassoMask(width: number, height: number, vertices: Point[]): Uint8Array {
  const mask = new Uint8Array(width * height);
  if (vertices.length < 3) return mask;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) if (insidePolygon({ x: x + 0.5, y: y + 0.5 }, vertices)) mask[y * width + x] = 1;
  }
  return mask;
}

export function magicWandMask(buffer: PixelBuffer, start: Point, tolerance = 0): Uint8Array {
  const mask = new Uint8Array(buffer.width * buffer.height);
  const x = Math.round(start.x);
  const y = Math.round(start.y);
  if (x < 0 || y < 0 || x >= buffer.width || y >= buffer.height) return mask;
  const origin = (y * buffer.width + x) * 4;
  const target = buffer.data.slice(origin, origin + 4);
  const queue = [{ x, y }];
  while (queue.length) {
    const point = queue.pop()!;
    if (point.x < 0 || point.y < 0 || point.x >= buffer.width || point.y >= buffer.height) continue;
    const pixel = point.y * buffer.width + point.x;
    if (mask[pixel]) continue;
    const offset = pixel * 4;
    if ([0, 1, 2, 3].some((channel) => Math.abs(buffer.data[offset + channel] - target[channel]) > tolerance)) continue;
    mask[pixel] = 1;
    queue.push({ x: point.x - 1, y: point.y }, { x: point.x + 1, y: point.y }, { x: point.x, y: point.y - 1 }, { x: point.x, y: point.y + 1 });
  }
  return mask;
}

export function extractSelection(buffer: PixelBuffer, mask: Uint8Array): SelectionContent {
  if (mask.length !== buffer.width * buffer.height) throw new Error("선택 마스크 크기가 올바르지 않습니다.");
  const selected = [...mask.keys()].filter((index) => mask[index]);
  if (selected.length === 0) return { width: 0, height: 0, data: new Uint8ClampedArray(), mask: new Uint8Array(), originX: 0, originY: 0 };
  const xs = selected.map((index) => index % buffer.width);
  const ys = selected.map((index) => Math.floor(index / buffer.width));
  const originX = Math.min(...xs);
  const originY = Math.min(...ys);
  const width = Math.max(...xs) - originX + 1;
  const height = Math.max(...ys) - originY + 1;
  const data = new Uint8ClampedArray(width * height * 4);
  const croppedMask = new Uint8Array(width * height);
  for (const sourcePixel of selected) {
    const sourceX = sourcePixel % buffer.width;
    const sourceY = Math.floor(sourcePixel / buffer.width);
    const targetPixel = (sourceY - originY) * width + sourceX - originX;
    data.set(buffer.data.subarray(sourcePixel * 4, sourcePixel * 4 + 4), targetPixel * 4);
    croppedMask[targetPixel] = 1;
  }
  return { width, height, data, mask: croppedMask, originX, originY };
}

export function pasteSelection(buffer: PixelBuffer, content: SelectionContent, x = content.originX, y = content.originY): PixelBuffer {
  const data = new Uint8ClampedArray(buffer.data);
  for (let sourceY = 0; sourceY < content.height; sourceY += 1) {
    for (let sourceX = 0; sourceX < content.width; sourceX += 1) {
      const sourcePixel = sourceY * content.width + sourceX;
      const targetX = x + sourceX;
      const targetY = y + sourceY;
      if (!content.mask[sourcePixel] || targetX < 0 || targetY < 0 || targetX >= buffer.width || targetY >= buffer.height) continue;
      data.set(content.data.subarray(sourcePixel * 4, sourcePixel * 4 + 4), (targetY * buffer.width + targetX) * 4);
    }
  }
  return { ...buffer, data };
}

export function moveSelection(buffer: PixelBuffer, mask: Uint8Array, dx: number, dy: number): PixelBuffer {
  const content = extractSelection(buffer, mask);
  const data = new Uint8ClampedArray(buffer.data);
  for (let pixel = 0; pixel < mask.length; pixel += 1) if (mask[pixel]) data.fill(0, pixel * 4, pixel * 4 + 4);
  return pasteSelection({ ...buffer, data }, content, content.originX + Math.round(dx), content.originY + Math.round(dy));
}

function transform(content: SelectionContent, width: number, height: number, destination: (x: number, y: number) => Point): SelectionContent {
  const data = new Uint8ClampedArray(width * height * 4);
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < content.height; y += 1) {
    for (let x = 0; x < content.width; x += 1) {
      const target = destination(x, y);
      const sourcePixel = y * content.width + x;
      const targetPixel = target.y * width + target.x;
      data.set(content.data.subarray(sourcePixel * 4, sourcePixel * 4 + 4), targetPixel * 4);
      mask[targetPixel] = content.mask[sourcePixel];
    }
  }
  return { width, height, data, mask, originX: content.originX, originY: content.originY };
}

export function flipSelection(content: SelectionContent, horizontal: boolean, vertical: boolean): SelectionContent {
  return transform(content, content.width, content.height, (x, y) => ({
    x: horizontal ? content.width - x - 1 : x,
    y: vertical ? content.height - y - 1 : y,
  }));
}

export function rotateSelection(content: SelectionContent, direction: "clockwise" | "counterclockwise"): SelectionContent {
  return transform(content, content.height, content.width, (x, y) => direction === "clockwise"
    ? { x: content.height - y - 1, y: x }
    : { x: y, y: content.width - x - 1 });
}

export function scaleSelectionNearest(content: SelectionContent, width: number, height: number): SelectionContent {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error("선택 영역 크기가 올바르지 않습니다.");
  const data = new Uint8ClampedArray(width * height * 4);
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(content.width - 1, Math.floor(x * content.width / width));
      const sourceY = Math.min(content.height - 1, Math.floor(y * content.height / height));
      const sourcePixel = sourceY * content.width + sourceX;
      const targetPixel = y * width + x;
      data.set(content.data.subarray(sourcePixel * 4, sourcePixel * 4 + 4), targetPixel * 4);
      mask[targetPixel] = content.mask[sourcePixel];
    }
  }
  return { width, height, data, mask, originX: content.originX, originY: content.originY };
}
