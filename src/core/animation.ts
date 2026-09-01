import { addFrame, deleteFrame, duplicateFrame } from "./timeline.ts";
import type { AnimationDirection, AnimationTag, SpriteDocument } from "./types.ts";

const UNITY_INVALID_FILE_NAME_CHARS = /[\u0000-\u001f<>:"\/\\|?*]+/u;
export const UNCLASSIFIED_NAME = "미분류";

export function unityAnimationClipFileName(name: string): string {
  const filename = name.split(UNITY_INVALID_FILE_NAME_CHARS).filter(Boolean).join("_");
  return filename || "animation";
}

export function conflictingUnityAnimationTagNames(tags: readonly Pick<AnimationTag, "name">[]): string[] {
  const namesByFile = new Map<string, string[]>();
  for (const tag of tags) {
    const key = unityAnimationClipFileName(tag.name).toLowerCase();
    namesByFile.set(key, [...(namesByFile.get(key) ?? []), tag.name]);
  }
  return [...namesByFile.values()].filter((names) => names.length > 1).flat();
}

export function assertUniqueUnityAnimationClipFileNames(tags: readonly Pick<AnimationTag, "name">[]): void {
  const conflicts = conflictingUnityAnimationTagNames(tags);
  if (conflicts.length) {
    throw new Error(`Unity AnimationClip 파일명이 충돌합니다: ${conflicts.join(", ")}. 충돌하는 태그를 삭제하고 서로 다른 이름으로 다시 추가하세요.`);
  }
}

export function frameSequence(tag: AnimationTag): string[] {
  const forward = [...tag.frameIds];
  if (tag.direction === "reverse") return forward.reverse();
  if (tag.direction === "pingPong" && forward.length > 2) {
    return [...forward, ...forward.slice(1, -1).reverse()];
  }
  return forward;
}

export function validateAnimationTags(document: SpriteDocument): void {
  const frameIds = new Set(document.frames.map((frame) => frame.id));
  const tagIds = new Set<string>();
  const names = new Set<string>();
  const owned = new Set<string>();
  for (const tag of document.tags) {
    if (tagIds.has(tag.id)) throw new Error("애니메이션 세트 ID가 중복되었습니다.");
    tagIds.add(tag.id);
    const name = tag.name.trim();
    if (!name) throw new Error("애니메이션 세트 이름이 필요합니다.");
    if (name === UNCLASSIFIED_NAME) {
      throw new Error("미분류는 세트에 속하지 않은 프레임을 표시하는 예약 이름입니다.");
    }
    if (names.has(name)) throw new Error(`애니메이션 세트 이름이 중복되었습니다: ${name}`);
    names.add(name);
    if (!( ["forward", "reverse", "pingPong"] as const).includes(tag.direction)) {
      throw new Error("재생 방향이 올바르지 않습니다.");
    }
    const local = new Set<string>();
    for (const frameId of tag.frameIds) {
      if (!frameIds.has(frameId)) {
        throw new Error(`애니메이션 세트가 존재하지 않는 프레임을 참조합니다: ${frameId}`);
      }
      if (local.has(frameId)) throw new Error(`한 애니메이션 세트에 같은 프레임이 두 번 있습니다: ${frameId}`);
      if (owned.has(frameId)) throw new Error(`프레임이 둘 이상의 세트에 속합니다: ${frameId}`);
      local.add(frameId);
      owned.add(frameId);
    }
  }
  assertUniqueUnityAnimationClipFileNames(document.tags);
}

export function addAnimationTag(document: SpriteDocument, input: Omit<AnimationTag, "id">): SpriteDocument {
  const next = structuredClone(document);
  next.tags.push({
    ...input,
    id: crypto.randomUUID(),
    name: input.name.trim(),
    frameIds: [...input.frameIds],
  });
  validateAnimationTags(next);
  return next;
}

export type AnimationSelection = { tagId: string | null; frameId: string | null };

export type EditingFrameContext = {
  tagId: string | null;
  frameIds: string[];
  index: number;
  position: number;
  total: number;
  firstFrameId: string;
  previousFrameId?: string;
  nextFrameId?: string;
  name: string;
  direction: AnimationDirection;
};

export type FrameMembershipResult = {
  document: SpriteDocument;
  tagId: string;
  frameIds: string[];
};

export type FrameMembershipMode = "copy" | "move";

function animationTag(document: SpriteDocument, tagId: string): AnimationTag {
  const tag = document.tags.find((candidate) => candidate.id === tagId);
  if (!tag) throw new Error("애니메이션 세트를 찾을 수 없습니다.");
  return tag;
}

function selectedFrameIds(
  document: SpriteDocument,
  sourceTagId: string | null,
  frameIds: readonly string[],
): string[] {
  if (frameIds.length === 0) throw new Error("선택한 프레임이 없습니다.");
  const requested = new Set(frameIds);
  if (requested.size !== frameIds.length) throw new Error("같은 프레임을 두 번 선택할 수 없습니다.");
  const order = animationGroupFrameIds(document, sourceTagId);
  if (frameIds.some((frameId) => !order.includes(frameId))) {
    throw new Error("선택한 프레임이 원본 애니메이션 그룹에 없습니다.");
  }
  return order.filter((frameId) => requested.has(frameId));
}

function duplicateSelectedFrames(
  document: SpriteDocument,
  frameIds: readonly string[],
): { document: SpriteDocument; frameIds: string[] } {
  let next = document;
  const duplicates: string[] = [];
  for (const frameId of frameIds) {
    next = duplicateFrame(next, frameId);
    const sourceIndex = next.frames.findIndex((frame) => frame.id === frameId);
    duplicates.push(next.frames[sourceIndex + 1].id);
  }
  return { document: next, frameIds: duplicates };
}

export function unclassifiedFrameIds(document: SpriteDocument): string[] {
  const owned = new Set(document.tags.flatMap((tag) => tag.frameIds));
  return document.frames.map((frame) => frame.id).filter((frameId) => !owned.has(frameId));
}

export function animationGroupFrameIds(document: SpriteDocument, tagId: string | null): string[] {
  if (tagId === null) return unclassifiedFrameIds(document);
  return [...animationTag(document, tagId).frameIds];
}

export function defaultAnimationSelection(document: SpriteDocument): AnimationSelection {
  const firstTag = document.tags[0];
  if (firstTag) return { tagId: firstTag.id, frameId: firstTag.frameIds[0] ?? null };
  return { tagId: null, frameId: unclassifiedFrameIds(document)[0] ?? null };
}

export function editingFrameContext(document: SpriteDocument, frameId: string): EditingFrameContext {
  if (!document.frames.some((frame) => frame.id === frameId)) {
    throw new Error("선택한 프레임을 찾을 수 없습니다.");
  }
  const tag = document.tags.find((candidate) => candidate.frameIds.includes(frameId));
  const frameIds = tag ? [...tag.frameIds] : unclassifiedFrameIds(document);
  const index = frameIds.indexOf(frameId);
  if (index < 0) throw new Error("선택한 프레임이 활성 그룹에 없습니다.");
  return {
    tagId: tag?.id ?? null,
    frameIds,
    index,
    position: index + 1,
    total: frameIds.length,
    firstFrameId: frameIds[0],
    previousFrameId: frameIds[index - 1],
    nextFrameId: frameIds[index + 1],
    name: tag?.name ?? UNCLASSIFIED_NAME,
    direction: tag?.direction ?? "forward",
  };
}

export function reconcileAnimationSelection(
  document: SpriteDocument,
  preferred: AnimationSelection,
): AnimationSelection {
  if (preferred.frameId && document.frames.some((frame) => frame.id === preferred.frameId)) {
    const owner = document.tags.find((tag) => tag.frameIds.includes(preferred.frameId!));
    return { tagId: owner?.id ?? null, frameId: preferred.frameId };
  }
  if (preferred.tagId === null) {
    return { tagId: null, frameId: unclassifiedFrameIds(document)[0] ?? null };
  }
  const tag = document.tags.find((candidate) => candidate.id === preferred.tagId);
  return tag
    ? { tagId: tag.id, frameId: tag.frameIds[0] ?? null }
    : defaultAnimationSelection(document);
}

export function updateAnimationSet(
  document: SpriteDocument,
  tagId: string,
  patch: Partial<Pick<AnimationTag, "name" | "direction">>,
): SpriteDocument {
  const next = structuredClone(document);
  const tag = animationTag(next, tagId);
  if (patch.name !== undefined) tag.name = patch.name.trim();
  if (patch.direction !== undefined) tag.direction = patch.direction;
  validateAnimationTags(next);
  return next;
}

export function deleteAnimationSet(document: SpriteDocument, tagId: string): SpriteDocument {
  const next = structuredClone(document);
  const index = next.tags.findIndex((tag) => tag.id === tagId);
  if (index < 0) throw new Error("애니메이션 세트를 찾을 수 없습니다.");
  next.tags.splice(index, 1);
  validateAnimationTags(next);
  return next;
}

export function reorderAnimationSets(
  document: SpriteDocument,
  tagId: string,
  insertBeforeTagId?: string,
): SpriteDocument {
  const sourceIndex = document.tags.findIndex((tag) => tag.id === tagId);
  if (sourceIndex < 0) throw new Error("애니메이션 세트를 찾을 수 없습니다.");
  if (insertBeforeTagId === tagId) return document;
  if (insertBeforeTagId !== undefined && !document.tags.some((tag) => tag.id === insertBeforeTagId)) {
    throw new Error("삽입 기준 애니메이션 세트를 찾을 수 없습니다.");
  }
  const next = structuredClone(document);
  const [tag] = next.tags.splice(sourceIndex, 1);
  const targetIndex = insertBeforeTagId === undefined
    ? next.tags.length
    : next.tags.findIndex((candidate) => candidate.id === insertBeforeTagId);
  next.tags.splice(targetIndex, 0, tag);
  validateAnimationTags(next);
  return next;
}

export function reorderAnimationFrames(
  document: SpriteDocument,
  tagId: string,
  frameIds: readonly string[],
  insertBeforeFrameId?: string,
): SpriteDocument {
  const selected = selectedFrameIds(document, tagId, frameIds);
  const tag = animationTag(document, tagId);
  if (insertBeforeFrameId !== undefined && !tag.frameIds.includes(insertBeforeFrameId)) {
    throw new Error("삽입 기준 프레임을 대상 세트에서 찾을 수 없습니다.");
  }
  if (insertBeforeFrameId !== undefined && selected.includes(insertBeforeFrameId)) return document;
  const selectedSet = new Set(selected);
  const remaining = tag.frameIds.filter((frameId) => !selectedSet.has(frameId));
  const targetIndex = insertBeforeFrameId === undefined
    ? remaining.length
    : remaining.indexOf(insertBeforeFrameId);
  remaining.splice(targetIndex, 0, ...selected);
  const next = structuredClone(document);
  animationTag(next, tagId).frameIds = remaining;
  validateAnimationTags(next);
  return next;
}

export function createAnimationSet(document: SpriteDocument, input: {
  sourceTagId: string | null;
  frameIds: readonly string[];
  name: string;
  direction: AnimationDirection;
  mode: FrameMembershipMode;
}): FrameMembershipResult {
  if (input.sourceTagId === null && input.mode === "copy") {
    throw new Error("미분류 프레임은 이동하여 새 세트로 등록해야 합니다.");
  }
  const selected = selectedFrameIds(document, input.sourceTagId, input.frameIds);
  let next = document;
  let resultFrameIds = selected;
  if (input.mode === "copy") {
    const duplicated = duplicateSelectedFrames(next, selected);
    next = duplicated.document;
    resultFrameIds = duplicated.frameIds;
  } else if (input.sourceTagId !== null) {
    next = structuredClone(next);
    const selectedSet = new Set(selected);
    animationTag(next, input.sourceTagId).frameIds = animationTag(next, input.sourceTagId).frameIds
      .filter((frameId) => !selectedSet.has(frameId));
  }
  if (next === document) next = structuredClone(document);
  const tagId = crypto.randomUUID();
  next.tags.push({
    id: tagId,
    name: input.name.trim(),
    direction: input.direction,
    frameIds: [...resultFrameIds],
  });
  validateAnimationTags(next);
  return { document: next, tagId, frameIds: [...resultFrameIds] };
}

export function transferAnimationFrames(document: SpriteDocument, input: {
  sourceTagId: string | null;
  targetTagId: string;
  frameIds: readonly string[];
  insertAfterFrameId?: string;
  mode: FrameMembershipMode;
}): FrameMembershipResult {
  if (input.sourceTagId === input.targetTagId) {
    throw new Error("원본과 대상 애니메이션 세트가 같습니다.");
  }
  const target = animationTag(document, input.targetTagId);
  if (input.insertAfterFrameId !== undefined && !target.frameIds.includes(input.insertAfterFrameId)) {
    throw new Error("삽입 기준 프레임을 대상 세트에서 찾을 수 없습니다.");
  }
  const selected = selectedFrameIds(document, input.sourceTagId, input.frameIds);
  let next = document;
  let resultFrameIds = selected;
  if (input.mode === "copy") {
    const duplicated = duplicateSelectedFrames(next, selected);
    next = duplicated.document;
    resultFrameIds = duplicated.frameIds;
  } else if (input.sourceTagId !== null) {
    next = structuredClone(next);
    const selectedSet = new Set(selected);
    animationTag(next, input.sourceTagId).frameIds = animationTag(next, input.sourceTagId).frameIds
      .filter((frameId) => !selectedSet.has(frameId));
  }
  if (next === document) next = structuredClone(document);
  const nextTarget = animationTag(next, input.targetTagId);
  const targetIndex = input.insertAfterFrameId === undefined
    ? nextTarget.frameIds.length
    : nextTarget.frameIds.indexOf(input.insertAfterFrameId) + 1;
  nextTarget.frameIds.splice(targetIndex, 0, ...resultFrameIds);
  validateAnimationTags(next);
  return { document: next, tagId: input.targetTagId, frameIds: [...resultFrameIds] };
}

export function addFrameToAnimationGroup(
  document: SpriteDocument,
  tagId: string | null,
  afterFrameId?: string,
): { document: SpriteDocument; frameId: string } {
  const group = animationGroupFrameIds(document, tagId);
  if (afterFrameId !== undefined && !group.includes(afterFrameId)) {
    throw new Error("삽입 기준 프레임이 활성 그룹에 없습니다.");
  }
  const next = addFrame(document, afterFrameId);
  const frameId = afterFrameId === undefined
    ? next.frames.at(-1)!.id
    : next.frames[next.frames.findIndex((frame) => frame.id === afterFrameId) + 1].id;
  if (tagId !== null) {
    const tag = animationTag(next, tagId);
    const insertIndex = afterFrameId === undefined ? tag.frameIds.length : tag.frameIds.indexOf(afterFrameId) + 1;
    tag.frameIds.splice(insertIndex, 0, frameId);
  }
  validateAnimationTags(next);
  return { document: next, frameId };
}

export function duplicateFrameInAnimationGroup(
  document: SpriteDocument,
  tagId: string | null,
  frameId: string,
): { document: SpriteDocument; frameId: string } {
  const group = animationGroupFrameIds(document, tagId);
  if (!group.includes(frameId)) throw new Error("복제할 프레임이 활성 그룹에 없습니다.");
  const next = duplicateFrame(document, frameId);
  const duplicateId = next.frames[next.frames.findIndex((frame) => frame.id === frameId) + 1].id;
  if (tagId !== null) {
    const tag = animationTag(next, tagId);
    tag.frameIds.splice(tag.frameIds.indexOf(frameId) + 1, 0, duplicateId);
  }
  validateAnimationTags(next);
  return { document: next, frameId: duplicateId };
}

export function deleteAnimationFrame(document: SpriteDocument, frameId: string): SpriteDocument {
  const next = structuredClone(document);
  for (const tag of next.tags) tag.frameIds = tag.frameIds.filter((candidate) => candidate !== frameId);
  const deleted = deleteFrame(next, frameId);
  validateAnimationTags(deleted);
  return deleted;
}
