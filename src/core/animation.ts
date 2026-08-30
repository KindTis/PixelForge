import type { AnimationTag, Frame } from "./types.ts";

const UNITY_INVALID_FILE_NAME_CHARS = /[\u0000-\u001f<>:"\/\\|?*]+/u;

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

export function frameSequence(tag: AnimationTag, frames: Frame[]): string[] {
  const start = frames.findIndex((frame) => frame.id === tag.fromFrameId);
  const end = frames.findIndex((frame) => frame.id === tag.toFrameId);
  if (start < 0 || end < start) throw new Error("태그 프레임 구간이 올바르지 않습니다.");

  const forward = frames.slice(start, end + 1).map((frame) => frame.id);
  if (tag.direction === "reverse") return forward.reverse();
  if (tag.direction === "pingPong" && forward.length > 2) {
    return [...forward, ...forward.slice(1, -1).reverse()];
  }
  return forward;
}
