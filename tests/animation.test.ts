import assert from "node:assert/strict";
import test from "node:test";
import { frameSequence } from "../src/core/animation.ts";
import type { AnimationTag, Frame } from "../src/core/types.ts";

const frames: Frame[] = ["a", "b", "c"].map((id) => ({ id, durationMs: 100 }));

function tag(direction: AnimationTag["direction"]): AnimationTag {
  return { id: "tag", name: "공격", fromFrameId: "a", toFrameId: "c", direction };
}

test("핑퐁 태그는 양 끝 프레임을 중복하지 않는다", () => {
  assert.deepEqual(frameSequence(tag("pingPong"), frames), ["a", "b", "c", "b"]);
});

test("역방향 태그는 끝에서 시작까지 재생한다", () => {
  assert.deepEqual(frameSequence(tag("reverse"), frames), ["c", "b", "a"]);
});

test("존재하지 않는 태그 구간은 거부한다", () => {
  assert.throws(
    () => frameSequence({ ...tag("forward"), toFrameId: "missing" }, frames),
    /태그 프레임/,
  );
});
