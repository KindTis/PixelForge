import type { AnimationTag, Frame } from "./types.ts";

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
