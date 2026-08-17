import type { EditorTool } from "./ai-edit.ts";
import type { EditCommand, PixelChange } from "./commands.ts";
import {
  ellipse,
  floodFill,
  gradient,
  line,
  mirror,
  polygon,
  quadraticCurve,
  rectangle,
  spray,
  stampBrush,
  type Point,
} from "./raster.ts";
import { lassoMask, magicWandMask, rectangleMask } from "./selection.ts";
import type { PixelBuffer, RGBA } from "./types.ts";

export type { EditorTool } from "./ai-edit.ts";

export type ToolSettings = {
  tool: EditorTool;
  celId: string;
  color: RGBA;
  secondaryColor?: RGBA;
  brushSize: number;
  filled?: boolean;
  mirrorX?: boolean;
  mirrorY?: boolean;
  selection?: Uint8Array;
  brushShape?: "square" | "circle";
  customBrush?: Point[];
  random?: () => number;
};

export type ToolCursorSettings = Pick<ToolSettings,
  "tool" | "brushSize" | "brushShape" | "customBrush" | "mirrorX" | "mirrorY" | "selection"
>;
export type ToolCursorBounds = {
  documentWidth: number;
  documentHeight: number;
  celX: number;
  celY: number;
};
export type ToolCursorOverlay = {
  pixels: Point[];
  mirrorAxisX?: number;
  mirrorAxisY?: number;
};

export type ToolResult = { command?: EditCommand; color?: RGBA; selection?: Uint8Array };

export function screenToPixel(clientX: number, clientY: number, bounds: { left: number; top: number }, view: { zoom: number; panX: number; panY: number }): Point {
  return {
    x: Math.floor((clientX - bounds.left - view.panX) / view.zoom),
    y: Math.floor((clientY - bounds.top - view.panY) / view.zoom),
  };
}

function unique(points: Point[]): Point[] {
  return [...new Map(points.map((point) => [`${point.x},${point.y}`, point])).values()];
}

const STAMP_TOOLS = new Set<EditorTool>([
  "pencil", "eraser", "line", "curve", "rectangle", "ellipse", "polygon", "spray",
]);
const DOCUMENT_TARGET_TOOLS = new Set<EditorTool>(["gradient", "select", "lasso"]);
const BUFFER_TARGET_TOOLS = new Set<EditorTool>(["fill", "eyedropper", "wand"]);

function stamp(points: Point[], settings: Pick<ToolSettings, "brushSize" | "brushShape" | "customBrush">): Point[] {
  const centers = unique(points);
  return settings.customBrush?.length
    ? unique(centers.flatMap((point) => settings.customBrush!.map((offset) => ({ x: point.x + offset.x, y: point.y + offset.y }))))
    : stampBrush(centers, settings.brushSize, settings.brushShape);
}

type SprayReachability = { minX: number; minYByX: Int32Array; maxYByX: Int32Array };
type Bounds = { minX: number; maxX: number; minY: number; maxY: number };
type CustomBrushMembership =
  | { kind: "dense"; minX: number; minY: number; width: number; cells: Uint8Array }
  | { kind: "sparse"; columns: Map<number, Set<number>> };
type CustomBrushCache = { bounds: Bounds; integerOffsets: boolean; dense: boolean; membership?: CustomBrushMembership };

// ponytail: EditorWorkspace가 immutable snapshot을 참조 교체하므로 WeakMap 캐시는 GC 가능하고 호출 간 재계산만 줄인다.
const customBrushCache = new WeakMap<Point[], CustomBrushCache>();

function customBrushMetadata(customBrush: Point[]): CustomBrushCache {
  const cached = customBrushCache.get(customBrush);
  if (cached) return cached;
  let integerOffsets = true;
  const bounds = customBrush.reduce((current, point) => {
    integerOffsets = integerOffsets && Number.isInteger(point.x) && Number.isInteger(point.y);
    return {
      minX: Math.min(current.minX, point.x),
      maxX: Math.max(current.maxX, point.x),
      minY: Math.min(current.minY, point.y),
      maxY: Math.max(current.maxY, point.y),
    };
  }, { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
  const brushWidth = bounds.maxX - bounds.minX + 1;
  const brushHeight = bounds.maxY - bounds.minY + 1;
  const metadata = { bounds, integerOffsets, dense: integerOffsets && brushWidth * brushHeight <= customBrush.length * 2 };
  customBrushCache.set(customBrush, metadata);
  return metadata;
}

function customBrushMembership(customBrush: Point[], metadata: CustomBrushCache): CustomBrushMembership {
  if (metadata.membership) return metadata.membership;
  if (!metadata.dense) {
    const columns = new Map<number, Set<number>>();
    for (const offset of customBrush) {
      let rows = columns.get(offset.x);
      if (!rows) {
        rows = new Set<number>();
        columns.set(offset.x, rows);
      }
      rows.add(offset.y);
    }
    metadata.membership = { kind: "sparse", columns };
    return metadata.membership;
  }
  const minX = metadata.bounds.minX;
  const minY = metadata.bounds.minY;
  const width = metadata.bounds.maxX - minX + 1;
  const height = metadata.bounds.maxY - minY + 1;
  const cells = new Uint8Array(width * height);
  for (const offset of customBrush) cells[(offset.y - minY) * width + offset.x - minX] = 1;
  metadata.membership = { kind: "dense", minX, minY, width, cells };
  return metadata.membership;
}

function stampBounds(settings: Pick<ToolSettings, "brushSize" | "brushShape" | "customBrush">): Bounds {
  if (settings.customBrush?.length) {
    return customBrushMetadata(settings.customBrush).bounds;
  }
  const diameter = Math.max(1, Math.round(settings.brushSize));
  const before = Math.floor((diameter - 1) / 2);
  const after = diameter - before - 1;
  return { minX: -before, maxX: after, minY: -before, maxY: after };
}

function transformBounds(bounds: Bounds, width: number, height: number, horizontal: boolean, vertical: boolean): Bounds {
  return {
    minX: horizontal ? width - bounds.maxX - 1 : bounds.minX,
    maxX: horizontal ? width - bounds.minX - 1 : bounds.maxX,
    minY: vertical ? height - bounds.maxY - 1 : bounds.minY,
    maxY: vertical ? height - bounds.minY - 1 : bounds.maxY,
  };
}

function mirrorRegions(bounds: Bounds, width: number, height: number, horizontal: boolean, vertical: boolean): Bounds[] {
  const regions = [bounds];
  if (horizontal) regions.push(transformBounds(bounds, width, height, true, false));
  if (vertical) regions.push(transformBounds(bounds, width, height, false, true));
  if (horizontal && vertical) regions.push(transformBounds(bounds, width, height, true, true));
  return regions;
}

function reachableSprayCenterCount(reachability: SprayReachability): number {
  let count = 0;
  for (let column = 0; column < reachability.minYByX.length; column += 1) {
    const minY = reachability.minYByX[column];
    const maxY = reachability.maxYByX[column];
    if (minY <= maxY) count += maxY - minY + 1;
  }
  return count;
}

function clippedBoundsArea(bounds: Bounds, minX: number, maxX: number, minY: number, maxY: number): number {
  const clippedMinX = Math.max(minX, Math.ceil(bounds.minX));
  const clippedMaxX = Math.min(maxX, Math.floor(bounds.maxX) + 1);
  const clippedMinY = Math.max(minY, Math.ceil(bounds.minY));
  const clippedMaxY = Math.min(maxY, Math.floor(bounds.maxY) + 1);
  return Math.max(0, clippedMaxX - clippedMinX) * Math.max(0, clippedMaxY - clippedMinY);
}

function shouldScatterCustomBrush(
  customBrush: Point[],
  reachability: SprayReachability,
  footprint: Bounds,
  image: { width: number; height: number },
  clipMinX: number,
  clipMaxX: number,
  clipMinY: number,
  clipMaxY: number,
  mirrorX: boolean,
  mirrorY: boolean,
): boolean {
  const metadata = customBrushMetadata(customBrush);
  if (!metadata.integerOffsets) return true;
  const scanArea = mirrorRegions(footprint, image.width, image.height, mirrorX, mirrorY)
    .reduce((total, region) => total + clippedBoundsArea(region, clipMinX, clipMaxX, clipMinY, clipMaxY), 0);
  const reachableCenters = reachableSprayCenterCount(reachability);
  const scanWork = scanArea * reachableCenters;
  const mirrorCount = 1 + (mirrorX ? 1 : 0) + (mirrorY ? 1 : 0) + (mirrorX && mirrorY ? 1 : 0);
  const scatterWork = reachableCenters * customBrush.length * mirrorCount;
  return scatterWork < scanWork;
}

// ponytail: 중심 객체×브러시 픽셀을 만들지 않고 열별 구간으로 압축한다. 더 빠른 캐시는 실측될 때만 검토한다.
function reachableSprayColumns(center: Point, radius: number): SprayReachability {
  const extent = Math.ceil(radius + 0.5);
  const width = extent * 2 + 1;
  const minYByX = new Int32Array(width).fill(2 ** 31 - 1);
  const maxYByX = new Int32Array(width).fill(-(2 ** 31));
  for (let y = -extent; y <= extent; y += 1) {
    for (let x = -extent; x <= extent; x += 1) {
      const nearestX = Math.max(0, Math.abs(x) - 0.5);
      const nearestY = Math.max(0, Math.abs(y) - 0.5);
      if (nearestX * nearestX + nearestY * nearestY <= radius * radius) {
        const column = x + extent;
        minYByX[column] = Math.min(minYByX[column], center.y + y);
        maxYByX[column] = Math.max(maxYByX[column], center.y + y);
      }
    }
  }
  return { minX: center.x - extent, minYByX, maxYByX };
}

function reachableSprayColumn(
  reachability: SprayReachability,
  x: number,
  minY: number,
  maxY: number,
): boolean {
  const column = x - reachability.minX;
  if (column < 0 || column >= reachability.minYByX.length) return false;
  return reachability.minYByX[column] <= maxY && reachability.maxYByX[column] >= minY;
}

function sprayStampContains(
  x: number,
  y: number,
  settings: Pick<ToolSettings, "brushSize" | "brushShape" | "customBrush">,
  reachability: SprayReachability,
  customMembership?: CustomBrushMembership,
): boolean {
  if (customMembership) {
    for (let column = 0; column < reachability.minYByX.length; column += 1) {
      const centerX = reachability.minX + column;
      const minY = reachability.minYByX[column];
      const maxY = reachability.maxYByX[column];
      for (let centerY = minY; centerY <= maxY; centerY += 1) {
        const offsetX = x - centerX;
        const offsetY = y - centerY;
        if (customMembership.kind === "sparse") {
          if (customMembership.columns.get(offsetX)?.has(offsetY)) return true;
          continue;
        }
        const cellX = offsetX - customMembership.minX;
        const cellY = offsetY - customMembership.minY;
        if (cellX >= 0 && cellY >= 0
          && cellX < customMembership.width
          && cellY * customMembership.width + cellX < customMembership.cells.length
          && customMembership.cells[cellY * customMembership.width + cellX]) return true;
      }
    }
    return false;
  }

  const diameter = Math.max(1, Math.round(settings.brushSize));
  const before = Math.floor((diameter - 1) / 2);
  const after = diameter - before - 1;
  if (settings.brushShape !== "circle") {
    for (let offsetX = -before; offsetX <= after; offsetX += 1) {
      if (reachableSprayColumn(reachability, x - offsetX, y - after, y + before)) return true;
    }
    return false;
  }

  const radiusSquared = ((diameter - 1) / 2) ** 2;
  for (let offsetX = -before; offsetX <= after; offsetX += 1) {
    const remaining = radiusSquared - offsetX ** 2;
    if (remaining < 0) continue;
    const offsetY = Math.floor(Math.sqrt(remaining));
    if (reachableSprayColumn(reachability, x - offsetX, y - offsetY, y + offsetY)) return true;
  }
  return false;
}

export function toolCursorOverlay(
  point: Point,
  settings: ToolCursorSettings,
  image: PixelBuffer,
  bounds: ToolCursorBounds,
): ToolCursorOverlay {
  const documentPoint = { x: Math.round(point.x), y: Math.round(point.y) };
  const localPoint = { x: documentPoint.x - bounds.celX, y: documentPoint.y - bounds.celY };
  const inDocument = ({ x, y }: Point) => x >= 0 && y >= 0 && x < bounds.documentWidth && y < bounds.documentHeight;
  const inImage = ({ x, y }: Point) => x >= 0 && y >= 0 && x < image.width && y < image.height;

  if (DOCUMENT_TARGET_TOOLS.has(settings.tool)) {
    return { pixels: inDocument(documentPoint) ? [documentPoint] : [] };
  }

  if (BUFFER_TARGET_TOOLS.has(settings.tool)) {
    const selected = settings.tool !== "fill" || !settings.selection
      || Boolean(settings.selection[localPoint.y * image.width + localPoint.x]);
    return { pixels: inDocument(documentPoint) && inImage(localPoint) && selected ? [documentPoint] : [] };
  }

  if (!STAMP_TOOLS.has(settings.tool)) return { pixels: [] };
  const radius = Math.max(1, settings.brushSize * 2);
  const offsetBounds = stampBounds(settings);
  const sprayExtent = settings.tool === "spray" ? Math.ceil(radius + 0.5) : 0;
  const footprint = {
    minX: localPoint.x + offsetBounds.minX - sprayExtent,
    maxX: localPoint.x + offsetBounds.maxX + sprayExtent,
    minY: localPoint.y + offsetBounds.minY - sprayExtent,
    maxY: localPoint.y + offsetBounds.maxY + sprayExtent,
  };
  const clipMinX = Math.max(0, -bounds.celX);
  const clipMaxX = Math.min(image.width, bounds.documentWidth - bounds.celX);
  const clipMinY = Math.max(0, -bounds.celY);
  const clipMaxY = Math.min(image.height, bounds.documentHeight - bounds.celY);
  const pixels: Point[] = [];
  if (settings.tool === "spray") {
    const reachability = reachableSprayColumns(localPoint, radius);
    const seen = new Set<number>();
    const mirrorX = Boolean(settings.mirrorX);
    const mirrorY = Boolean(settings.mirrorY);
    const customBrush = settings.customBrush ?? [];
    const scatterCustomBrush = customBrush?.length
      ? shouldScatterCustomBrush(customBrush, reachability, footprint, image, clipMinX, clipMaxX, clipMinY, clipMaxY, mirrorX, mirrorY)
      : false;
    if (scatterCustomBrush) {
      const add = (x: number, y: number) => {
        if (x < clipMinX || y < clipMinY || x >= clipMaxX || y >= clipMaxY) return;
        const index = y * image.width + x;
        if (seen.has(index)) return;
        seen.add(index);
        if (settings.selection && !settings.selection[index]) return;
        pixels.push({ x: x + bounds.celX, y: y + bounds.celY });
      };
      for (let column = 0; column < reachability.minYByX.length; column += 1) {
        const centerX = reachability.minX + column;
        const minY = reachability.minYByX[column];
        const maxY = reachability.maxYByX[column];
        for (let centerY = minY; centerY <= maxY; centerY += 1) {
          for (const offset of customBrush) {
            const x = centerX + offset.x;
            const y = centerY + offset.y;
            add(x, y);
            if (mirrorX) add(image.width - x - 1, y);
            if (mirrorY) add(x, image.height - y - 1);
            if (mirrorX && mirrorY) add(image.width - x - 1, image.height - y - 1);
          }
        }
      }
    } else {
      const customMembership = customBrush.length
        ? customBrushMembership(customBrush, customBrushMetadata(customBrush))
        : undefined;
      const stamped = (x: number, y: number) => sprayStampContains(x, y, settings, reachability, customMembership);
      for (const region of mirrorRegions(footprint, image.width, image.height, mirrorX, mirrorY)) {
        const regionMinX = Math.max(clipMinX, Math.ceil(region.minX));
        const regionMaxX = Math.min(clipMaxX, Math.floor(region.maxX) + 1);
        const regionMinY = Math.max(clipMinY, Math.ceil(region.minY));
        const regionMaxY = Math.min(clipMaxY, Math.floor(region.maxY) + 1);
        for (let y = regionMinY; y < regionMaxY; y += 1) {
          for (let x = regionMinX; x < regionMaxX; x += 1) {
            const index = y * image.width + x;
            if (seen.has(index)) continue;
            seen.add(index);
            if (settings.selection && !settings.selection[index]) continue;
            if (!stamped(x, y)
              && (!mirrorX || !stamped(image.width - x - 1, y))
              && (!mirrorY || !stamped(x, image.height - y - 1))
              && (!(mirrorX && mirrorY) || !stamped(image.width - x - 1, image.height - y - 1))) continue;
            pixels.push({ x: x + bounds.celX, y: y + bounds.celY });
          }
        }
      }
    }
  } else {
    const localPixels = mirror(stamp([localPoint], settings), image.width, image.height, Boolean(settings.mirrorX), Boolean(settings.mirrorY));
    pixels.push(...unique(localPixels)
      .filter((candidate) => {
        if (!inImage(candidate)) return false;
        if (settings.selection && !settings.selection[candidate.y * image.width + candidate.x]) return false;
        return inDocument({ x: candidate.x + bounds.celX, y: candidate.y + bounds.celY });
      })
      .map(({ x, y }) => ({ x: x + bounds.celX, y: y + bounds.celY })));
  }

  return {
    pixels,
    ...(pixels.length && settings.mirrorX ? { mirrorAxisX: bounds.celX + image.width / 2 } : {}),
    ...(pixels.length && settings.mirrorY ? { mirrorAxisY: bounds.celY + image.height / 2 } : {}),
  };
}

export class ToolController {
  private start?: Point;
  private last?: Point;
  private path: Point[] = [];

  constructor(private readonly settings: ToolSettings, private readonly image: PixelBuffer) {}

  pointerDown(point: Point): void {
    this.start = { x: Math.round(point.x), y: Math.round(point.y) };
    this.last = this.start;
    this.path = [this.start];
  }

  pointerMove(point: Point): ToolResult {
    if (!this.last) return {};
    const current = { x: Math.round(point.x), y: Math.round(point.y) };
    this.path.push(...line(this.last, current));
    this.last = current;
    return this.result(current);
  }

  pointerUp(point: Point): ToolResult {
    if (!this.start) return {};
    const end = { x: Math.round(point.x), y: Math.round(point.y) };
    const result = this.pointerMove(end);
    this.start = undefined;
    this.last = undefined;
    return result;
  }

  private result(end: Point): ToolResult {
    if (!this.start) return {};
    const start = this.start;
    if (this.settings.tool === "eyedropper") {
      if (end.x < 0 || end.y < 0 || end.x >= this.image.width || end.y >= this.image.height) return {};
      const offset = (end.y * this.image.width + end.x) * 4;
      return { color: Array.from(this.image.data.slice(offset, offset + 4)) as unknown as RGBA };
    }
    if (this.settings.tool === "select") return { selection: rectangleMask(this.image.width, this.image.height, start, end) };
    if (this.settings.tool === "lasso") return { selection: lassoMask(this.image.width, this.image.height, unique(this.path)) };
    if (this.settings.tool === "wand") return { selection: magicWandMask(this.image, end) };

    let pixels: PixelChange[];
    if (this.settings.tool === "fill") {
      pixels = floodFill(this.image, end, this.settings.color, this.settings.selection);
    } else if (this.settings.tool === "gradient") {
      pixels = gradient(this.image.width, this.image.height, start, end, this.settings.color, this.settings.secondaryColor ?? [0, 0, 0, 0]);
    } else {
      let points = this.settings.tool === "pencil" || this.settings.tool === "eraser" ? this.path
        : this.settings.tool === "line" ? line(start, end)
          : this.settings.tool === "curve" ? quadraticCurve(start, { x: start.x, y: end.y }, end)
            : this.settings.tool === "rectangle" ? rectangle(start, end, this.settings.filled)
              : this.settings.tool === "ellipse" ? ellipse(start, end, this.settings.filled)
                : this.settings.tool === "polygon" ? polygon([start, { x: start.x, y: end.y }, end], this.settings.filled)
                  : unique(this.path.flatMap((point) => spray(point, Math.max(1, this.settings.brushSize * 2), Math.max(8, this.settings.brushSize * 8), this.settings.random)));
      points = stamp(points, this.settings);
      points = mirror(points, this.image.width, this.image.height, Boolean(this.settings.mirrorX), Boolean(this.settings.mirrorY));
      const rgba: RGBA = this.settings.tool === "eraser" ? [0, 0, 0, 0] : this.settings.color;
      pixels = points.map(({ x, y }) => ({ x, y, rgba }));
    }
    if (this.settings.selection) pixels = pixels.filter(({ x, y }) => x >= 0 && y >= 0 && x < this.image.width && y < this.image.height && this.settings.selection![y * this.image.width + x]);
    return { command: { type: "setPixels", celId: this.settings.celId, pixels } };
  }
}
