import type { PixelChange } from "./commands.ts";
import type { PixelBuffer, RGBA } from "./types.ts";

export type Point = { x: number; y: number };

function unique(points: Point[]): Point[] {
  return [...new Map(points.map((point) => [`${point.x},${point.y}`, point])).values()];
}

export function line(start: Point, end: Point): Point[] {
  let x = Math.round(start.x);
  let y = Math.round(start.y);
  const targetX = Math.round(end.x);
  const targetY = Math.round(end.y);
  const dx = Math.abs(targetX - x);
  const dy = -Math.abs(targetY - y);
  const stepX = x < targetX ? 1 : -1;
  const stepY = y < targetY ? 1 : -1;
  let error = dx + dy;
  const points: Point[] = [];
  for (;;) {
    points.push({ x, y });
    if (x === targetX && y === targetY) return points;
    const twice = error * 2;
    if (twice >= dy) { error += dy; x += stepX; }
    if (twice <= dx) { error += dx; y += stepY; }
  }
}

export function rectangle(start: Point, end: Point, filled = false): Point[] {
  const left = Math.min(Math.round(start.x), Math.round(end.x));
  const right = Math.max(Math.round(start.x), Math.round(end.x));
  const top = Math.min(Math.round(start.y), Math.round(end.y));
  const bottom = Math.max(Math.round(start.y), Math.round(end.y));
  const points: Point[] = [];
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      if (filled || x === left || x === right || y === top || y === bottom) points.push({ x, y });
    }
  }
  return points;
}

export function ellipse(start: Point, end: Point, filled = false): Point[] {
  const left = Math.min(Math.round(start.x), Math.round(end.x));
  const right = Math.max(Math.round(start.x), Math.round(end.x));
  const top = Math.min(Math.round(start.y), Math.round(end.y));
  const bottom = Math.max(Math.round(start.y), Math.round(end.y));
  const centerX = (left + right) / 2;
  const centerY = (top + bottom) / 2;
  const radiusX = Math.max((right - left) / 2, 0.5);
  const radiusY = Math.max((bottom - top) / 2, 0.5);
  const inside = (x: number, y: number) => ((x - centerX) / radiusX) ** 2 + ((y - centerY) / radiusY) ** 2 <= 1.000001;
  const points: Point[] = [];
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      if (inside(x, y) && (filled || !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1))) points.push({ x, y });
    }
  }
  return points;
}

export function quadraticCurve(start: Point, control: Point, end: Point): Point[] {
  const steps = Math.max(1, Math.ceil(Math.hypot(control.x - start.x, control.y - start.y) + Math.hypot(end.x - control.x, end.y - control.y)));
  const points: Point[] = [];
  let previous = { x: Math.round(start.x), y: Math.round(start.y) };
  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps;
    const inverse = 1 - t;
    const current = {
      x: Math.round(inverse * inverse * start.x + 2 * inverse * t * control.x + t * t * end.x),
      y: Math.round(inverse * inverse * start.y + 2 * inverse * t * control.y + t * t * end.y),
    };
    points.push(...line(previous, current));
    previous = current;
  }
  return unique(points);
}

function pointInPolygon(point: Point, points: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const a = points[i];
    const b = points[j];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function polygon(vertices: Point[], filled = false): Point[] {
  if (vertices.length < 2) return vertices;
  const outline = vertices.flatMap((vertex, index) => line(vertex, vertices[(index + 1) % vertices.length]));
  if (!filled || vertices.length < 3) return unique(outline);
  const minX = Math.floor(Math.min(...vertices.map(({ x }) => x)));
  const maxX = Math.ceil(Math.max(...vertices.map(({ x }) => x)));
  const minY = Math.floor(Math.min(...vertices.map(({ y }) => y)));
  const maxY = Math.ceil(Math.max(...vertices.map(({ y }) => y)));
  const fill: Point[] = [];
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if (pointInPolygon({ x: x + 0.5, y: y + 0.5 }, vertices)) fill.push({ x, y });
    }
  }
  return unique([...outline, ...fill]);
}

function sameColor(data: Uint8ClampedArray, index: number, color: RGBA): boolean {
  return data[index] === color[0] && data[index + 1] === color[1] && data[index + 2] === color[2] && data[index + 3] === color[3];
}

export function floodFill(buffer: PixelBuffer, start: Point, rgba: RGBA, mask?: Uint8Array): PixelChange[] {
  const x = Math.round(start.x);
  const y = Math.round(start.y);
  if (x < 0 || y < 0 || x >= buffer.width || y >= buffer.height) return [];
  const startIndex = (y * buffer.width + x) * 4;
  const target = Array.from(buffer.data.slice(startIndex, startIndex + 4)) as unknown as RGBA;
  if (target.every((channel, index) => channel === rgba[index])) return [];
  const queue: Point[] = [{ x, y }];
  const visited = new Uint8Array(buffer.width * buffer.height);
  const changes: PixelChange[] = [];
  while (queue.length) {
    const point = queue.pop()!;
    if (point.x < 0 || point.y < 0 || point.x >= buffer.width || point.y >= buffer.height) continue;
    const pixel = point.y * buffer.width + point.x;
    if (visited[pixel] || (mask && !mask[pixel]) || !sameColor(buffer.data, pixel * 4, target)) continue;
    visited[pixel] = 1;
    changes.push({ ...point, rgba });
    queue.push({ x: point.x - 1, y: point.y }, { x: point.x + 1, y: point.y }, { x: point.x, y: point.y - 1 }, { x: point.x, y: point.y + 1 });
  }
  return changes;
}

export function gradient(width: number, height: number, start: Point, end: Point, from: RGBA, to: RGBA): PixelChange[] {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy || 1;
  const result: PixelChange[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const amount = Math.max(0, Math.min(1, ((x - start.x) * dx + (y - start.y) * dy) / lengthSquared));
      result.push({ x, y, rgba: from.map((channel, index) => Math.round(channel + (to[index] - channel) * amount)) as unknown as RGBA });
    }
  }
  return result;
}

export function spray(center: Point, radius: number, count: number, random: () => number = Math.random): Point[] {
  const points: Point[] = [];
  for (let index = 0; index < count; index += 1) {
    const dx = (random() * 2 - 1) * radius;
    const dy = (random() * 2 - 1) * radius;
    if (dx * dx + dy * dy <= radius * radius) points.push({ x: Math.round(center.x + dx), y: Math.round(center.y + dy) });
  }
  return unique(points);
}

export function stampBrush(points: Point[], size: number, shape: "square" | "circle" = "square"): Point[] {
  const diameter = Math.max(1, Math.round(size));
  const before = Math.floor((diameter - 1) / 2);
  const after = diameter - before - 1;
  const stamped = points.flatMap((point) => rectangle({ x: point.x - before, y: point.y - before }, { x: point.x + after, y: point.y + after }, true)
    .filter((candidate) => shape === "square" || (candidate.x - point.x) ** 2 + (candidate.y - point.y) ** 2 <= ((diameter - 1) / 2) ** 2));
  return unique(stamped);
}

export function mirror(points: Point[], width: number, height: number, horizontal: boolean, vertical: boolean): Point[] {
  const result = [...points];
  for (const point of points) {
    if (horizontal) result.push({ x: width - point.x - 1, y: point.y });
    if (vertical) result.push({ x: point.x, y: height - point.y - 1 });
    if (horizontal && vertical) result.push({ x: width - point.x - 1, y: height - point.y - 1 });
  }
  return unique(result);
}
