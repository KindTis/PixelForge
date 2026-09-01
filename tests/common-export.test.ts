import assert from "node:assert/strict";
import test from "node:test";
import { addAnimationTag } from "../src/core/animation.ts";
import { applyCommand } from "../src/core/commands.ts";
import { createDocument } from "../src/core/document.ts";
import { addFrame, duplicateFrame } from "../src/core/timeline.ts";
import { celKey } from "../src/core/types.ts";
import { buildCommon } from "../src/server/exporters/common.ts";

test("공통 아틀라스는 동일 RGBA를 공유하고 편집되면 분리하며 단계 시간은 유지한다", () => {
  const options = { columns: 2, padding: 0, margin: 0, trim: false };
  let document = createDocument({ width: 1, height: 1 });
  const originalId = document.frames[0].id;
  document = duplicateFrame(document, originalId);
  const duplicateId = document.frames[1].id;
  document.frames[0].durationMs = 100;
  document.frames[1].durationMs = 180;
  document = addAnimationTag(document, { name: "idle", direction: "forward", frameIds: [originalId] });
  document = addAnimationTag(document, { name: "walk", direction: "forward", frameIds: [duplicateId] });
  document = addAnimationTag(document, { name: "empty", direction: "forward", frameIds: [] });
  document = addFrame(document);

  const shared = buildCommon(document, options);
  assert.equal(shared.metadata.frames.length, 1);
  assert.deepEqual(shared.metadata.animations.map((animation) => animation.name), ["idle", "walk"]);
  assert.equal(shared.metadata.animations[0].steps[0].sprite, "sprite_000");
  assert.equal(shared.metadata.animations[1].steps[0].sprite, "sprite_000");
  assert.deepEqual(shared.metadata.animations[1].steps[0], { frameId: duplicateId, sprite: "sprite_000", duration: 180 });

  const cel = document.cels[celKey(duplicateId, document.layers[0].id)];
  document = applyCommand(document, { type: "setPixels", celId: cel.id, pixels: [{ x: 0, y: 0, rgba: [1, 2, 3, 255] }] });
  assert.equal(buildCommon(document, options).metadata.frames.length, 2);

  assert.throws(() => buildCommon(createDocument({ width: 1, height: 1 }), options), /내보낼 애니메이션 세트가 없습니다/);
  const emptyOnly = addAnimationTag(createDocument({ width: 1, height: 1 }), { name: "empty", direction: "forward", frameIds: [] });
  assert.throws(() => buildCommon(emptyOnly, options), /내보낼 애니메이션 세트가 없습니다/);
});
