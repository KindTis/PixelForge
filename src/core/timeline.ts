import { validateDocument } from "./document.ts";
import { celKey, type AnimationTag, type SpriteDocument } from "./types.ts";

function copy(document: SpriteDocument): SpriteDocument {
  return structuredClone(document);
}

function cleanImages(document: SpriteDocument): void {
  const used = new Set(Object.values(document.cels).map((cel) => cel.imageId));
  for (const imageId of Object.keys(document.images)) if (!used.has(imageId)) delete document.images[imageId];
}

function frameIndex(document: SpriteDocument, id: string): number {
  const index = document.frames.findIndex((frame) => frame.id === id);
  if (index < 0) throw new Error("프레임을 찾을 수 없습니다.");
  return index;
}

function layerIndex(document: SpriteDocument, id: string): number {
  const index = document.layers.findIndex((layer) => layer.id === id);
  if (index < 0) throw new Error("레이어를 찾을 수 없습니다.");
  return index;
}

function addBlankCel(document: SpriteDocument, frameId: string, layerId: string): void {
  const imageId = crypto.randomUUID();
  document.images[imageId] = { width: document.width, height: document.height, data: new Uint8ClampedArray(document.width * document.height * 4) };
  document.cels[celKey(frameId, layerId)] = { id: crypto.randomUUID(), imageId, x: 0, y: 0, opacity: 1 };
}

export function addFrame(document: SpriteDocument, afterFrameId?: string): SpriteDocument {
  const next = copy(document);
  const index = afterFrameId ? frameIndex(next, afterFrameId) + 1 : next.frames.length;
  const frame = { id: crypto.randomUUID(), durationMs: 100 };
  next.frames.splice(index, 0, frame);
  for (const layer of next.layers) addBlankCel(next, frame.id, layer.id);
  return next;
}

export function duplicateFrame(document: SpriteDocument, id: string): SpriteDocument {
  const next = copy(document);
  const index = frameIndex(next, id);
  const source = next.frames[index];
  const frame = { id: crypto.randomUUID(), durationMs: source.durationMs };
  next.frames.splice(index + 1, 0, frame);
  for (const layer of next.layers) {
    const sourceCel = next.cels[celKey(id, layer.id)];
    if (sourceCel) next.cels[celKey(frame.id, layer.id)] = { ...sourceCel, id: crypto.randomUUID() };
  }
  return next;
}

export function deleteFrame(document: SpriteDocument, id: string): SpriteDocument {
  if (document.frames.length === 1) throw new Error("마지막 프레임은 삭제할 수 없습니다.");
  const next = copy(document);
  const index = frameIndex(next, id);
  next.frames.splice(index, 1);
  for (const layer of next.layers) delete next.cels[celKey(id, layer.id)];
  const replacement = next.frames[Math.min(index, next.frames.length - 1)].id;
  for (const tag of next.tags) {
    if (tag.fromFrameId === id) tag.fromFrameId = replacement;
    if (tag.toFrameId === id) tag.toFrameId = replacement;
  }
  cleanImages(next);
  validateDocument(next);
  return next;
}

export function moveFrame(document: SpriteDocument, id: string, targetIndex: number): SpriteDocument {
  const next = copy(document);
  const index = frameIndex(next, id);
  const destination = Math.max(0, Math.min(next.frames.length - 1, Math.round(targetIndex)));
  const [frame] = next.frames.splice(index, 1);
  next.frames.splice(destination, 0, frame);
  validateDocument(next);
  return next;
}

export function setFrameDuration(document: SpriteDocument, id: string, durationMs: number): SpriteDocument {
  if (!Number.isFinite(durationMs) || durationMs < 1 || durationMs > 60_000) throw new Error("프레임 시간은 1~60000ms여야 합니다.");
  const next = copy(document);
  next.frames[frameIndex(next, id)].durationMs = Math.round(durationMs);
  return next;
}

export function addLayer(document: SpriteDocument, name = `레이어 ${document.layers.length + 1}`): SpriteDocument {
  if (!name.trim()) throw new Error("레이어 이름이 필요합니다.");
  const next = copy(document);
  const layer = { id: crypto.randomUUID(), name: name.trim(), visible: true, locked: false, opacity: 1, blendMode: "normal" as const };
  next.layers.unshift(layer);
  for (const frame of next.frames) addBlankCel(next, frame.id, layer.id);
  return next;
}

export function duplicateLayer(document: SpriteDocument, id: string): SpriteDocument {
  const next = copy(document);
  const index = layerIndex(next, id);
  const source = next.layers[index];
  const layer = { ...source, id: crypto.randomUUID(), name: `${source.name} 복사` };
  next.layers.splice(index + 1, 0, layer);
  for (const frame of next.frames) {
    const sourceCel = next.cels[celKey(frame.id, id)];
    if (!sourceCel) continue;
    const sourceImage = next.images[sourceCel.imageId];
    const imageId = crypto.randomUUID();
    next.images[imageId] = { ...sourceImage, data: new Uint8ClampedArray(sourceImage.data) };
    next.cels[celKey(frame.id, layer.id)] = { ...sourceCel, id: crypto.randomUUID(), imageId };
  }
  return next;
}

export function deleteLayer(document: SpriteDocument, id: string): SpriteDocument {
  if (document.layers.length === 1) throw new Error("마지막 레이어는 삭제할 수 없습니다.");
  const next = copy(document);
  next.layers.splice(layerIndex(next, id), 1);
  for (const frame of next.frames) delete next.cels[celKey(frame.id, id)];
  cleanImages(next);
  return next;
}

export function moveLayer(document: SpriteDocument, id: string, targetIndex: number): SpriteDocument {
  const next = copy(document);
  const [layer] = next.layers.splice(layerIndex(next, id), 1);
  next.layers.splice(Math.max(0, Math.min(next.layers.length, Math.round(targetIndex))), 0, layer);
  return next;
}

export function linkCel(document: SpriteDocument, sourceFrameId: string, sourceLayerId: string, targetFrameId: string, targetLayerId: string): SpriteDocument {
  const next = copy(document);
  const source = next.cels[celKey(sourceFrameId, sourceLayerId)];
  const target = next.cels[celKey(targetFrameId, targetLayerId)];
  if (!source || !target) throw new Error("연결할 셀을 찾을 수 없습니다.");
  target.imageId = source.imageId;
  cleanImages(next);
  return next;
}

export function unlinkCel(document: SpriteDocument, frameId: string, layerId: string): SpriteDocument {
  const key = celKey(frameId, layerId);
  const cel = document.cels[key];
  if (!cel) throw new Error("분리할 셀을 찾을 수 없습니다.");
  if (Object.values(document.cels).filter((candidate) => candidate.imageId === cel.imageId).length < 2) return document;
  const next = copy(document);
  const imageId = crypto.randomUUID();
  const source = next.images[cel.imageId];
  next.images[imageId] = { ...source, data: new Uint8ClampedArray(source.data) };
  next.cels[key].imageId = imageId;
  return next;
}

export function addTag(document: SpriteDocument, input: Omit<AnimationTag, "id">): SpriteDocument {
  if (!input.name.trim() || document.tags.some((tag) => tag.name === input.name.trim())) throw new Error("태그 이름은 비어 있지 않고 고유해야 합니다.");
  const next = copy(document);
  next.tags.push({ ...input, id: crypto.randomUUID(), name: input.name.trim() });
  validateDocument(next);
  return next;
}

export function updateTag(document: SpriteDocument, id: string, patch: Partial<Omit<AnimationTag, "id">>): SpriteDocument {
  const next = copy(document);
  const tag = next.tags.find((candidate) => candidate.id === id);
  if (!tag) throw new Error("태그를 찾을 수 없습니다.");
  Object.assign(tag, patch);
  tag.name = tag.name.trim();
  if (!tag.name || next.tags.some((candidate) => candidate.id !== id && candidate.name === tag.name)) throw new Error("태그 이름은 비어 있지 않고 고유해야 합니다.");
  validateDocument(next);
  return next;
}

export function deleteTag(document: SpriteDocument, id: string): SpriteDocument {
  const next = copy(document);
  const index = next.tags.findIndex((tag) => tag.id === id);
  if (index < 0) throw new Error("태그를 찾을 수 없습니다.");
  next.tags.splice(index, 1);
  return next;
}
