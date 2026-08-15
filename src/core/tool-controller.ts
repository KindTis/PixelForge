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

  pointerMove(point: Point): void {
    if (!this.last) return;
    const current = { x: Math.round(point.x), y: Math.round(point.y) };
    this.path.push(...line(this.last, current));
    this.last = current;
  }

  pointerUp(point: Point): ToolResult {
    if (!this.start) return {};
    const end = { x: Math.round(point.x), y: Math.round(point.y) };
    const start = this.start;
    this.pointerMove(end);
    this.start = undefined;
    this.last = undefined;

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
      points = this.settings.customBrush?.length
        ? unique(points.flatMap((point) => this.settings.customBrush!.map((offset) => ({ x: point.x + offset.x, y: point.y + offset.y }))))
        : stampBrush(unique(points), this.settings.brushSize, this.settings.brushShape);
      points = mirror(points, this.image.width, this.image.height, Boolean(this.settings.mirrorX), Boolean(this.settings.mirrorY));
      const rgba: RGBA = this.settings.tool === "eraser" ? [0, 0, 0, 0] : this.settings.color;
      pixels = points.map(({ x, y }) => ({ x, y, rgba }));
    }
    if (this.settings.selection) pixels = pixels.filter(({ x, y }) => x >= 0 && y >= 0 && x < this.image.width && y < this.image.height && this.settings.selection![y * this.image.width + x]);
    return { command: { type: "setPixels", celId: this.settings.celId, pixels } };
  }
}
