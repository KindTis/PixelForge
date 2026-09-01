import type { AnimationTag, SpriteDocument } from "./types.ts";

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
