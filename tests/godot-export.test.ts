import assert from "node:assert/strict";
import test from "node:test";
import { addAnimationTag } from "../src/core/animation.ts";
import { createDocument } from "../src/core/document.ts";
import { duplicateFrame, setFrameDuration } from "../src/core/timeline.ts";
import { celKey } from "../src/core/types.ts";
import { exportGodot } from "../src/server/exporters/godot.ts";

test("Godot 묶음은 AtlasTexture와 태그 재생 순서를 보존한다", async () => {
  let document = createDocument({ width: 8, height: 8 });
  const cel = document.cels[celKey(document.frames[0].id, document.layers[0].id)];
  document.images[cel.imageId].data.set([255, 0, 0, 255], (3 * 8 + 2) * 4);
  document = duplicateFrame(document, document.frames[0].id);
  document = duplicateFrame(document, document.frames[1].id);
  document = duplicateFrame(document, document.frames[2].id);
  document = setFrameDuration(document, document.frames[1].id, 180);
  document = addAnimationTag(document, {
    name: "walk",
    frameIds: document.frames.slice(0, 2).map((frame) => frame.id),
    direction: "forward",
  });
  document = addAnimationTag(document, {
    name: "attack",
    frameIds: document.frames.slice(2).map((frame) => frame.id),
    direction: "reverse",
  });

  const files = await exportGodot(document, { columns: 2, padding: 1, margin: 0, trim: true });
  assert.deepEqual(files.map((file) => file.path), ["spritesheet.png", "spritesheet.json", "sprite_frames.tres", "README.md"]);
  const tres = files[2].data as string;
  assert.match(tres, /\[ext_resource type="Texture2D" path="spritesheet\.png" id="1_texture"\]/);
  assert.match(tres, /\[sub_resource type="AtlasTexture" id="AtlasTexture_000"\]/);
  assert.match(tres, /region = Rect2\(0, 0, 1, 1\)/);
  assert.match(tres, /margin = Rect2\(2, 3, 7, 7\)/);
  assert.match(tres, /"duration": 0\.18/);
  assert.match(tres, /"name": &"walk"/);
  assert.match(tres, /"name": &"attack"/);
  assert.equal((tres.match(/path="spritesheet\.png"/g) ?? []).length, 1);

  const repeated = await exportGodot(document, { columns: 2, padding: 1, margin: 0, trim: true });
  assert.equal(repeated[2].data, tres);
});
