import assert from "node:assert/strict";
import test from "node:test";
import { addAnimationTag } from "../src/core/animation.ts";
import { createDocument } from "../src/core/document.ts";
import { duplicateFrame } from "../src/core/timeline.ts";
import { exportGodot } from "../src/server/exporters/godot.ts";

test("Godot 묶음은 공유 AtlasTexture를 애니메이션 단계에서 재사용한다", async () => {
  let document = createDocument({ width: 1, height: 1 });
  const idleId = document.frames[0].id;
  document = duplicateFrame(document, idleId);
  const walkId = document.frames[1].id;
  document.frames[0].durationMs = 100;
  document.frames[1].durationMs = 180;
  document = addAnimationTag(document, { name: "idle", frameIds: [idleId], direction: "forward" });
  document = addAnimationTag(document, { name: "walk", frameIds: [walkId], direction: "forward" });

  const files = await exportGodot(document, { columns: 1, padding: 0, margin: 0, trim: false });
  assert.deepEqual(files.map((file) => file.path), ["spritesheet.png", "spritesheet.json", "sprite_frames.tres", "README.md"]);
  const tres = files[2].data as string;
  assert.match(tres, /\[ext_resource type="Texture2D" path="spritesheet\.png" id="1_texture"\]/);
  assert.match(tres, /\[sub_resource type="AtlasTexture" id="AtlasTexture_000"\]/);
  assert.equal((tres.match(/\[sub_resource type="AtlasTexture" id="AtlasTexture_000"\]/g) ?? []).length, 1);
  assert.equal((tres.match(/"texture": SubResource\("AtlasTexture_000"\)/g) ?? []).length, 2);
  assert.match(tres, /"duration": 0\.18/);
  assert.match(tres, /"name": &"idle"/);
  assert.match(tres, /"name": &"walk"/);
  assert.equal((tres.match(/path="spritesheet\.png"/g) ?? []).length, 1);

  const repeated = await exportGodot(document, { columns: 1, padding: 0, margin: 0, trim: false });
  assert.equal(repeated[2].data, tres);
});
