import assert from "node:assert/strict";
import test from "node:test";
import {
  assertUniqueUnityAnimationClipFileNames,
  conflictingUnityAnimationTagNames,
  frameSequence,
  unityAnimationClipFileName,
} from "../src/core/animation.ts";
import type { AnimationTag } from "../src/core/types.ts";

function tag(direction: AnimationTag["direction"]): AnimationTag {
  return { id: "tag", name: "공격", frameIds: ["a", "c", "b"], direction };
}

test("프레임 시퀀스는 저장된 명시 순서를 사용한다", () => {
  assert.deepEqual(frameSequence(tag("forward")), ["a", "c", "b"]);
  assert.deepEqual(frameSequence(tag("reverse")), ["b", "c", "a"]);
  assert.deepEqual(frameSequence(tag("pingPong")), ["a", "c", "b", "c"]);
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
