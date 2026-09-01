import type { RGBA, SpriteDocument, SpriteProject } from "./types.ts";

export type PixelChange = { x: number; y: number; rgba: RGBA };
export type EditCommand = { type: "setPixels"; celId: string; pixels: PixelChange[] };
export type UndoableProjectField = "document" | "generationHistory" | "exportSettings";
type ProjectHistoryEntry = {
  fields: readonly UndoableProjectField[];
  before: SpriteProject;
  after: SpriteProject;
};
export type HistorySnapshot = {
  project: SpriteProject;
  undoStack: readonly ProjectHistoryEntry[];
  redoStack: readonly ProjectHistoryEntry[];
  transactionStart?: SpriteProject;
  transactionFields: readonly UndoableProjectField[];
};

export function applyCommand(document: SpriteDocument, command: EditCommand): SpriteDocument {
  const entry = Object.entries(document.cels).find(([, cel]) => cel.id === command.celId);
  if (!entry) throw new Error("편집할 셀을 찾을 수 없습니다.");
  const [key, cel] = entry;
  const layerId = key.slice(key.indexOf(":") + 1);
  if (document.layers.find((layer) => layer.id === layerId)?.locked) throw new Error("잠긴 레이어는 편집할 수 없습니다.");
  const source = document.images[cel.imageId];
  if (!source) throw new Error("편집할 셀 이미지가 없습니다.");
  const pixels = command.pixels.filter(({ x, y }) => {
    const documentX = cel.x + x;
    const documentY = cel.y + y;
    return Number.isInteger(x) && Number.isInteger(y)
      && x >= 0 && y >= 0 && x < source.width && y < source.height
      && documentX >= 0 && documentY >= 0
      && documentX < document.width && documentY < document.height;
  });
  if (pixels.length === 0) return document;

  const data = new Uint8ClampedArray(source.data);
  for (const pixel of pixels) data.set(pixel.rgba, (pixel.y * source.width + pixel.x) * 4);
  if (data.every((channel, index) => channel === source.data[index])) return document;
  const linked = Object.values(document.cels).filter((candidate) => candidate.imageId === cel.imageId).length > 1;
  const imageId = linked ? crypto.randomUUID() : cel.imageId;
  return {
    ...document,
    cels: linked ? { ...document.cels, [key]: { ...cel, imageId } } : document.cels,
    images: { ...document.images, [imageId]: { width: source.width, height: source.height, data } },
  };
}

function restoreFields(
  current: SpriteProject,
  snapshot: SpriteProject,
  fields: readonly UndoableProjectField[],
): SpriteProject {
  let next = current;
  for (const field of fields) {
    if (field === "document") next = { ...next, document: snapshot.document };
    else if (field === "generationHistory") next = { ...next, generationHistory: snapshot.generationHistory };
    else next = { ...next, exportSettings: snapshot.exportSettings };
  }
  return next;
}

export class History {
  private readonly undoStack: ProjectHistoryEntry[] = [];
  private readonly redoStack: ProjectHistoryEntry[] = [];
  private transactionStart?: SpriteProject;
  private readonly transactionFields = new Set<UndoableProjectField>();

  constructor(public project: SpriteProject) {}

  get document(): SpriteDocument { return this.project.document; }

  snapshot(): HistorySnapshot {
    return {
      project: this.project,
      undoStack: this.undoStack.slice(),
      redoStack: this.redoStack.slice(),
      transactionStart: this.transactionStart,
      transactionFields: [...this.transactionFields],
    };
  }

  restore(snapshot: HistorySnapshot): SpriteProject {
    this.project = snapshot.project;
    this.undoStack.splice(0, this.undoStack.length, ...snapshot.undoStack);
    this.redoStack.splice(0, this.redoStack.length, ...snapshot.redoStack);
    this.transactionStart = snapshot.transactionStart;
    this.transactionFields.clear();
    for (const field of snapshot.transactionFields) this.transactionFields.add(field);
    return this.project;
  }

  execute(command: EditCommand): SpriteProject {
    const before = this.document;
    const after = applyCommand(before, command);
    return after === before ? this.project : this.replaceDocument(after);
  }

  replaceDocument(document: SpriteDocument): SpriteProject {
    return this.replaceProject({ ...this.project, document }, ["document"]);
  }

  replaceProject(project: SpriteProject, fields: readonly UndoableProjectField[]): SpriteProject {
    const changedFields = [...new Set(fields)].filter((field) => project[field] !== this.project[field]);
    if (changedFields.length === 0) return this.project;
    if (this.transactionStart) {
      for (const field of changedFields) this.transactionFields.add(field);
    } else {
      this.undoStack.push({ fields: changedFields, before: this.project, after: project });
      this.redoStack.length = 0;
    }
    this.project = project;
    return project;
  }

  commitSteps(documents: readonly SpriteDocument[]): SpriteProject {
    if (this.transactionStart) throw new Error("편집 트랜잭션 중에는 격리 결과를 반영할 수 없습니다.");
    const entries: ProjectHistoryEntry[] = [];
    let current = this.project;
    for (const document of documents) {
      if (document === current.document) continue;
      const next = { ...current, document };
      entries.push({ fields: ["document"], before: current, after: next });
      current = next;
    }
    if (entries.length === 0) return this.project;
    this.undoStack.push(...entries);
    this.redoStack.length = 0;
    this.project = current;
    return current;
  }

  beginTransaction(): void {
    if (this.transactionStart) throw new Error("편집 트랜잭션이 이미 시작되었습니다.");
    this.transactionStart = this.project;
    this.transactionFields.clear();
  }

  commitTransaction(): void {
    if (!this.transactionStart) return;
    const before = this.transactionStart;
    const fields = [...this.transactionFields].filter((field) => this.project[field] !== before[field]);
    if (fields.length > 0) {
      this.undoStack.push({ fields, before, after: this.project });
      this.redoStack.length = 0;
    }
    this.transactionStart = undefined;
    this.transactionFields.clear();
  }

  undo(): SpriteProject {
    if (this.transactionStart) this.commitTransaction();
    const entry = this.undoStack.pop();
    if (!entry) return this.project;
    this.redoStack.push(entry);
    this.project = restoreFields(this.project, entry.before, entry.fields);
    return this.project;
  }

  redo(): SpriteProject {
    const entry = this.redoStack.pop();
    if (!entry) return this.project;
    this.undoStack.push(entry);
    this.project = restoreFields(this.project, entry.after, entry.fields);
    return this.project;
  }
}
