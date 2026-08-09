import { celKey, type BlendMode, type PixelBuffer, type RGBA, type SpriteDocument } from "./types.ts";

function blend(source: number, target: number, mode: BlendMode): number {
  if (mode === "multiply") return source * target;
  if (mode === "screen") return 1 - (1 - source) * (1 - target);
  if (mode === "overlay") return target <= 0.5 ? 2 * source * target : 1 - 2 * (1 - source) * (1 - target);
  if (mode === "add") return Math.min(1, source + target);
  return source;
}

export function blendPixel(backdrop: RGBA, source: RGBA, mode: BlendMode, opacity = 1): RGBA {
  const sourceAlpha = source[3] / 255 * Math.max(0, Math.min(1, opacity));
  const targetAlpha = backdrop[3] / 255;
  const outputAlpha = sourceAlpha + targetAlpha * (1 - sourceAlpha);
  if (outputAlpha === 0) return [0, 0, 0, 0];
  const result = [0, 0, 0, Math.round(outputAlpha * 255)];
  for (let channel = 0; channel < 3; channel += 1) {
    const front = source[channel] / 255;
    const back = backdrop[channel] / 255;
    const mixed = (1 - sourceAlpha) * targetAlpha * back
      + (1 - targetAlpha) * sourceAlpha * front
      + sourceAlpha * targetAlpha * blend(front, back, mode);
    result[channel] = Math.round(mixed / outputAlpha * 255);
  }
  return result as unknown as RGBA;
}

export function compositeFrame(document: SpriteDocument, frameId: string): PixelBuffer {
  if (!document.frames.some((frame) => frame.id === frameId)) throw new Error("프레임을 찾을 수 없습니다.");
  const output = new Uint8ClampedArray(document.width * document.height * 4);

  for (const layer of [...document.layers].reverse()) {
    if (!layer.visible) continue;
    const cel = document.cels[celKey(frameId, layer.id)];
    const image = cel ? document.images[cel.imageId] : undefined;
    if (!cel || !image) continue;
    for (let y = 0; y < image.height; y += 1) {
      const targetY = y + cel.y;
      if (targetY < 0 || targetY >= document.height) continue;
      for (let x = 0; x < image.width; x += 1) {
        const targetX = x + cel.x;
        if (targetX < 0 || targetX >= document.width) continue;
        const sourceIndex = (y * image.width + x) * 4;
        const targetIndex = (targetY * document.width + targetX) * 4;
        const sourceAlpha = image.data[sourceIndex + 3] / 255 * cel.opacity * layer.opacity;
        if (sourceAlpha === 0) continue;
        const targetAlpha = output[targetIndex + 3] / 255;
        const outputAlpha = sourceAlpha + targetAlpha * (1 - sourceAlpha);
        for (let channel = 0; channel < 3; channel += 1) {
          const source = image.data[sourceIndex + channel] / 255;
          const target = output[targetIndex + channel] / 255;
          const mixed = (1 - sourceAlpha) * targetAlpha * target
            + (1 - targetAlpha) * sourceAlpha * source
            + sourceAlpha * targetAlpha * blend(source, target, layer.blendMode);
          output[targetIndex + channel] = Math.round(mixed / outputAlpha * 255);
        }
        output[targetIndex + 3] = Math.round(outputAlpha * 255);
      }
    }
  }

  return { width: document.width, height: document.height, data: output };
}
