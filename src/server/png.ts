import { deflateSync, inflateSync } from "node:zlib";
import type { PixelBuffer } from "../core/types.ts";

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, "ascii");
  const result = Buffer.allocUnsafe(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  name.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8);
  return result;
}

export function encodePng(width: number, height: number, rgba: Uint8ClampedArray): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192) {
    throw new Error("PNG 크기가 올바르지 않습니다.");
  }
  if (rgba.length !== width * height * 4) throw new Error("PNG 픽셀 길이가 올바르지 않습니다.");

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const stride = width * 4;
  const scanlines = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (stride + 1);
    scanlines[row] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(scanlines, row + 1);
  }

  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(scanlines)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function paeth(left: number, up: number, upperLeft: number): number {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const diagonalDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= diagonalDistance) return left;
  if (upDistance <= diagonalDistance) return up;
  return upperLeft;
}

export function decodePng(png: Uint8Array): PixelBuffer {
  const input = Buffer.from(png);
  if (input.length < 8 || !input.subarray(0, 8).equals(SIGNATURE)) throw new Error("PNG 시그니처가 올바르지 않습니다.");

  let offset = 8;
  let width = 0;
  let height = 0;
  const compressed: Buffer[] = [];
  while (offset + 12 <= input.length) {
    const length = input.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > input.length) throw new Error("PNG chunk가 잘렸습니다.");
    const type = input.toString("ascii", offset + 4, offset + 8);
    const data = input.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = input.readUInt32BE(offset + 8 + length);
    if (crc32(input.subarray(offset + 4, offset + 8 + length)) !== expectedCrc) throw new Error("PNG CRC가 올바르지 않습니다.");
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) throw new Error("지원하지 않는 PNG 형식입니다.");
    } else if (type === "IDAT") {
      compressed.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset = end;
  }

  if (width < 1 || height < 1 || width > 8192 || height > 8192 || compressed.length === 0) {
    throw new Error("PNG 헤더가 올바르지 않습니다.");
  }
  const stride = width * 4;
  const raw = inflateSync(Buffer.concat(compressed));
  if (raw.length !== (stride + 1) * height) throw new Error("PNG 픽셀 데이터 길이가 올바르지 않습니다.");
  const output = new Uint8ClampedArray(stride * height);

  for (let y = 0; y < height; y += 1) {
    const sourceRow = y * (stride + 1);
    const targetRow = y * stride;
    const filter = raw[sourceRow];
    if (filter > 4) throw new Error("지원하지 않는 PNG 필터입니다.");
    for (let x = 0; x < stride; x += 1) {
      const value = raw[sourceRow + 1 + x];
      const left = x >= 4 ? output[targetRow + x - 4] : 0;
      const up = y > 0 ? output[targetRow + x - stride] : 0;
      const upperLeft = y > 0 && x >= 4 ? output[targetRow + x - stride - 4] : 0;
      const predictor = filter === 1 ? left
        : filter === 2 ? up
          : filter === 3 ? Math.floor((left + up) / 2)
            : filter === 4 ? paeth(left, up, upperLeft)
              : 0;
      output[targetRow + x] = (value + predictor) & 0xff;
    }
  }

  return { width, height, data: output };
}
