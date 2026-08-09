import type { PixelBuffer } from "./types.ts";

export type SheetFrameInput = {
  id: string;
  width: number;
  height: number;
  sourceX: number;
  sourceY: number;
};

export type SheetFrameLayout = SheetFrameInput & {
  rect: { x: number; y: number; width: number; height: number };
};

export type SheetLayout = { width: number; height: number; frames: SheetFrameLayout[] };

export function trimBounds(buffer: PixelBuffer): { x: number; y: number; width: number; height: number } {
  let left = buffer.width;
  let top = buffer.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < buffer.height; y += 1) {
    for (let x = 0; x < buffer.width; x += 1) if (buffer.data[(y * buffer.width + x) * 4 + 3]) {
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  return right < 0 ? { x: 0, y: 0, width: 1, height: 1 } : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

export function layoutSheet(inputs: SheetFrameInput[], options: { columns: number; padding: number; margin: number }): SheetLayout {
  if (inputs.length === 0) throw new Error("내보낼 프레임이 없습니다.");
  if (!Number.isInteger(options.columns) || options.columns < 1 || !Number.isInteger(options.padding) || options.padding < 0 || !Number.isInteger(options.margin) || options.margin < 0) {
    throw new Error("시트 배치 옵션이 올바르지 않습니다.");
  }
  const frames: SheetFrameLayout[] = [];
  let y = options.margin;
  let width = 0;
  for (let rowStart = 0; rowStart < inputs.length; rowStart += options.columns) {
    const row = inputs.slice(rowStart, rowStart + options.columns);
    const rowHeight = Math.max(...row.map((frame) => frame.height));
    let x = options.margin;
    for (const frame of row) {
      if (!Number.isInteger(frame.width) || !Number.isInteger(frame.height) || frame.width < 1 || frame.height < 1) throw new Error("프레임 크기가 올바르지 않습니다.");
      frames.push({ ...frame, rect: { x, y, width: frame.width, height: frame.height } });
      x += frame.width + options.padding;
    }
    width = Math.max(width, x - options.padding + options.margin);
    y += rowHeight + options.padding;
  }
  return { width, height: y - options.padding + options.margin, frames };
}
