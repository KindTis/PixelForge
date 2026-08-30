import assert from "node:assert/strict";
import test from "node:test";
import {
  assertUniqueUnityAnimationClipFileNames,
  conflictingUnityAnimationTagNames,
  frameSequence,
  unityAnimationClipFileName,
} from "../src/core/animation.ts";
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

test("Unity AnimationClip 파일명은 importer 규칙으로 정규화하고 대소문자 없이 충돌한다", () => {
  assert.equal(unityAnimationClipFileName("attack/slash?"), "attack_slash");
  assert.equal(unityAnimationClipFileName("???"), "animation");
  const tags = [{ name: "attack?" }, { name: "ATTACK*" }, { name: "walk" }];
  assert.deepEqual(conflictingUnityAnimationTagNames(tags), ["attack?", "ATTACK*"]);
  assert.throws(
    () => assertUniqueUnityAnimationClipFileNames(tags),
    /attack\?.*ATTACK\*.*충돌하는 태그를 삭제하고 서로 다른 이름으로 다시 추가하세요/,
  );
});
