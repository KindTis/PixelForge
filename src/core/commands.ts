import type { RGBA, SpriteDocument } from "./types.ts";

export type PixelChange = { x: number; y: number; rgba: RGBA };
export type EditCommand = { type: "setPixels"; celId: string; pixels: PixelChange[] };

export function applyCommand(document: SpriteDocument, command: EditCommand): SpriteDocument {
  const entry = Object.entries(document.cels).find(([, cel]) => cel.id === command.celId);
  if (!entry) throw new Error("편집할 셀을 찾을 수 없습니다.");
  const [key, cel] = entry;
  const layerId = key.slice(key.indexOf(":") + 1);
  if (document.layers.find((layer) => layer.id === layerId)?.locked) throw new Error("잠긴 레이어는 편집할 수 없습니다.");
  const source = document.images[cel.imageId];
  if (!source) throw new Error("편집할 셀 이미지가 없습니다.");
  const pixels = command.pixels.filter(({ x, y }) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < source.width && y < source.height);
  if (pixels.length === 0) return document;

  const linked = Object.values(document.cels).filter((candidate) => candidate.imageId === cel.imageId).length > 1;
  const imageId = linked ? crypto.randomUUID() : cel.imageId;
  const data = new Uint8ClampedArray(source.data);
  for (const pixel of pixels) data.set(pixel.rgba, (pixel.y * source.width + pixel.x) * 4);
  return {
    ...document,
    cels: linked ? { ...document.cels, [key]: { ...cel, imageId } } : document.cels,
    images: { ...document.images, [imageId]: { width: source.width, height: source.height, data } },
  };
}

export class History {
  private readonly undoStack: SpriteDocument[] = [];
  private readonly redoStack: SpriteDocument[] = [];
  private transactionStart?: SpriteDocument;

  constructor(public document: SpriteDocument) {}

  execute(command: EditCommand): SpriteDocument {
    const before = this.document;
    const after = applyCommand(before, command);
    if (after === before) return after;
    if (!this.transactionStart) {
      this.undoStack.push(before);
      this.redoStack.length = 0;
    }
    this.document = after;
    return after;
  }

  replace(document: SpriteDocument): SpriteDocument {
    if (document === this.document) return document;
    if (!this.transactionStart) {
      this.undoStack.push(this.document);
      this.redoStack.length = 0;
    }
    this.document = document;
    return document;
  }

  beginTransaction(): void {
    if (this.transactionStart) throw new Error("편집 트랜잭션이 이미 시작되었습니다.");
    this.transactionStart = this.document;
  }

  commitTransaction(): void {
    if (!this.transactionStart) return;
    if (this.document !== this.transactionStart) {
      this.undoStack.push(this.transactionStart);
      this.redoStack.length = 0;
    }
    this.transactionStart = undefined;
  }

  undo(): SpriteDocument {
    if (this.transactionStart) this.commitTransaction();
    const previous = this.undoStack.pop();
    if (!previous) return this.document;
    this.redoStack.push(this.document);
    this.document = previous;
    return previous;
  }

  redo(): SpriteDocument {
    const next = this.redoStack.pop();
    if (!next) return this.document;
    this.undoStack.push(this.document);
    this.document = next;
    return next;
  }
}
