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

// ponytail: 포인터 이동마다 정확한 합집합을 직접 계산한다. 지연이 실측되면 설정별 상대 오프셋을 캐시한다.
function reachableSprayCenters(center: Point, radius: number): Point[] {
  const extent = Math.ceil(radius + 0.5);
  const points: Point[] = [];
  for (let y = -extent; y <= extent; y += 1) {
    for (let x = -extent; x <= extent; x += 1) {
      const nearestX = Math.max(0, Math.abs(x) - 0.5);
      const nearestY = Math.max(0, Math.abs(y) - 0.5);
      if (nearestX * nearestX + nearestY * nearestY <= radius * radius) {
        points.push({ x: center.x + x, y: center.y + y });
      }
    }
  }
  return points;
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
  const centers = settings.tool === "spray" ? reachableSprayCenters(localPoint, radius) : [localPoint];
  const localPixels = mirror(stamp(centers, settings), image.width, image.height, Boolean(settings.mirrorX), Boolean(settings.mirrorY));
  const pixels = unique(localPixels)
    .filter((candidate) => {
      if (!inImage(candidate)) return false;
      if (settings.selection && !settings.selection[candidate.y * image.width + candidate.x]) return false;
      return inDocument({ x: candidate.x + bounds.celX, y: candidate.y + bounds.celY });
    })
    .map(({ x, y }) => ({ x: x + bounds.celX, y: y + bounds.celY }));

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
