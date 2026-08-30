import assert from "node:assert/strict";
import test from "node:test";
import { createDocument } from "../src/core/document.ts";
import { addTag, duplicateFrame } from "../src/core/timeline.ts";
import { celKey } from "../src/core/types.ts";
import { exportCommon } from "../src/server/exporters/common.ts";
import { decodePng } from "../src/server/png.ts";

test("공통 묶음은 PNG와 프레임·태그 JSON을 보존한다", async () => {
  let document = createDocument({ width: 2, height: 1 });
  const frame = document.frames[0];
  const layer = document.layers[0];
  document.images[document.cels[celKey(frame.id, layer.id)].imageId].data.set([255, 0, 0, 255, 0, 0, 0, 0]);
  document = duplicateFrame(document, frame.id);
  document.frames[1].durationMs = 180;
  document = duplicateFrame(document, document.frames[1].id);
  document = duplicateFrame(document, document.frames[2].id);
  document = addTag(document, { name: "walk", fromFrameId: document.frames[0].id, toFrameId: document.frames[1].id, direction: "pingPong" });
  document = addTag(document, { name: "attack", fromFrameId: document.frames[2].id, toFrameId: document.frames[3].id, direction: "forward" });

  const files = await exportCommon(document, { columns: 2, padding: 1, margin: 1, trim: true });
  assert.deepEqual(files.map((file) => file.path), ["spritesheet.png", "spritesheet.json"]);
  const png = decodePng(files[0].data as Uint8Array);
  assert.deepEqual({ width: png.width, height: png.height }, { width: 5, height: 5 });
  const metadata = JSON.parse(files[1].data as string);
  assert.equal(metadata.frames[0].filename, "walk_000");
  assert.deepEqual(metadata.frames[0].frame, { x: 1, y: 1, w: 1, h: 1 });
  assert.deepEqual(metadata.frames[0].spriteSourceSize, { x: 0, y: 0, w: 1, h: 1 });
  assert.deepEqual(metadata.frames[0].sourceSize, { w: 2, h: 1 });
  assert.equal(metadata.frames[1].duration, 180);
  assert.deepEqual(Object.keys(metadata.animations), ["walk", "attack"]);
  assert.deepEqual(metadata.animations.walk.frames, ["walk_000", "walk_001"]);
  assert.deepEqual(metadata.animations.attack.frames, ["attack_002", "attack_003"]);
  assert.ok((files[1].data as string).endsWith("\n"));

  document.tags[0].name = "attack?";
  document.tags[1].name = "ATTACK*";
  const legacyFiles = await exportCommon(document, { columns: 2, padding: 1, margin: 1, trim: true });
  const legacyMetadata = JSON.parse(legacyFiles[1].data as string);
  assert.deepEqual(Object.keys(legacyMetadata.animations), ["attack?", "ATTACK*"]);
});
