import { compositeFrame } from "../../core/render.ts";
import type { Point } from "../../core/raster.ts";
import type { PixelBuffer, SpriteDocument } from "../../core/types.ts";

export type CanvasView = {
  frameId: string;
  zoom: number;
  panX: number;
  panY: number;
  showGrid: boolean;
  onionSkin: boolean;
  tilePreview: boolean;
};

export type CanvasOverlay = {
  selection?: Uint8Array;
  cursor?: readonly Point[];
  mirrorAxisX?: number;
  mirrorAxisY?: number;
};

export class CanvasRenderer {
  constructor(private readonly canvas: HTMLCanvasElement) {}

  render(sprite: SpriteDocument, view: CanvasView, overlay: CanvasOverlay = {}): void {
    const ratio = window.devicePixelRatio || 1;
    const width = this.canvas.clientWidth || this.canvas.width;
    const height = this.canvas.clientHeight || this.canvas.height;
    if (this.canvas.width !== width * ratio || this.canvas.height !== height * ratio) {
      this.canvas.width = width * ratio;
      this.canvas.height = height * ratio;
    }
    const context = this.canvas.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.imageSmoothingEnabled = false;

    context.fillStyle = "#14181c";
    context.fillRect(0, 0, width, height);
    context.clearRect(view.panX, view.panY, sprite.width * view.zoom, sprite.height * view.zoom);

    const frameIndex = sprite.frames.findIndex((frame) => frame.id === view.frameId);
    const current = compositeFrame(sprite, view.frameId);
    if (view.tilePreview) for (let y = -1; y <= 1; y += 1) for (let x = -1; x <= 1; x += 1) {
      if (x || y) this.drawBuffer(context, current, { ...view, panX: view.panX + x * sprite.width * view.zoom, panY: view.panY + y * sprite.height * view.zoom }, 0.3);
    }
    if (view.onionSkin && frameIndex > 0) this.drawBuffer(context, compositeFrame(sprite, sprite.frames[frameIndex - 1].id), view, 0.18, "#ff5577");
    if (view.onionSkin && frameIndex < sprite.frames.length - 1) this.drawBuffer(context, compositeFrame(sprite, sprite.frames[frameIndex + 1].id), view, 0.18, "#55bbee");
    this.drawBuffer(context, current, view, 1);

    if (view.showGrid && view.zoom >= 8) {
      context.beginPath();
      context.strokeStyle = "rgba(15,18,20,.26)";
      context.lineWidth = 1;
      for (let x = 0; x <= sprite.width; x += 1) { context.moveTo(view.panX + x * view.zoom + 0.5, view.panY); context.lineTo(view.panX + x * view.zoom + 0.5, view.panY + sprite.height * view.zoom); }
      for (let y = 0; y <= sprite.height; y += 1) { context.moveTo(view.panX, view.panY + y * view.zoom + 0.5); context.lineTo(view.panX + sprite.width * view.zoom, view.panY + y * view.zoom + 0.5); }
      context.stroke();
    }

    context.strokeStyle = "rgba(233,229,218,.82)";
    context.lineWidth = 1;
    context.setLineDash([]);
    context.strokeRect(view.panX + 0.5, view.panY + 0.5, sprite.width * view.zoom - 1, sprite.height * view.zoom - 1);

    if (overlay.selection) {
      context.save();
      context.strokeStyle = "#fff";
      context.setLineDash([3, 3]);
      for (let pixel = 0; pixel < overlay.selection.length; pixel += 1) if (overlay.selection[pixel]) {
        const x = pixel % sprite.width;
        const y = Math.floor(pixel / sprite.width);
        context.strokeRect(view.panX + x * view.zoom, view.panY + y * view.zoom, view.zoom, view.zoom);
      }
      context.restore();
    }
    if (overlay.cursor?.length) {
      context.save();
      context.setLineDash([]);
      for (const [lineWidth, strokeStyle] of [[3, "rgba(0,0,0,.9)"], [1, "#fff"]] as const) {
        context.lineWidth = lineWidth;
        context.strokeStyle = strokeStyle;
        for (const { x, y } of overlay.cursor) {
          context.strokeRect(
            view.panX + x * view.zoom + 0.5,
            view.panY + y * view.zoom + 0.5,
            Math.max(1, view.zoom - 1),
            Math.max(1, view.zoom - 1),
          );
        }
      }
      context.restore();
    }
    if (overlay.mirrorAxisX !== undefined || overlay.mirrorAxisY !== undefined) {
      context.save();
      context.strokeStyle = "#ffad3d";
      context.lineWidth = 1;
      context.setLineDash([5, 5]);
      if (overlay.mirrorAxisX !== undefined) {
        const x = view.panX + overlay.mirrorAxisX * view.zoom;
        context.beginPath();
        context.moveTo(x, view.panY);
        context.lineTo(x, view.panY + sprite.height * view.zoom);
        context.stroke();
      }
      if (overlay.mirrorAxisY !== undefined) {
        const y = view.panY + overlay.mirrorAxisY * view.zoom;
        context.beginPath();
        context.moveTo(view.panX, y);
        context.lineTo(view.panX + sprite.width * view.zoom, y);
        context.stroke();
      }
      context.restore();
    }
  }

  private drawBuffer(context: CanvasRenderingContext2D, buffer: PixelBuffer, view: CanvasView, alpha: number, tint?: string): void {
    const source = document.createElement("canvas");
    source.width = buffer.width;
    source.height = buffer.height;
    const sourceContext = source.getContext("2d")!;
    sourceContext.putImageData(new ImageData(new Uint8ClampedArray(buffer.data), buffer.width, buffer.height), 0, 0);
    if (tint) {
      sourceContext.globalCompositeOperation = "source-atop";
      sourceContext.fillStyle = tint;
      sourceContext.fillRect(0, 0, source.width, source.height);
    }
    context.globalAlpha = alpha;
    context.drawImage(source, view.panX, view.panY, buffer.width * view.zoom, buffer.height * view.zoom);
    context.globalAlpha = 1;
  }
}
