import assert from "node:assert/strict";
import test from "node:test";
import { createDocument } from "../src/core/document.ts";
import { addTag, duplicateFrame } from "../src/core/timeline.ts";
import { celKey } from "../src/core/types.ts";
import { exportUnity } from "../src/server/exporters/unity.ts";

test("Unity 묶음은 스프라이트 분할과 AnimationClip 생성 정보를 포함한다", async () => {
  let document = createDocument({ width: 16, height: 12 });
  const cel = document.cels[celKey(document.frames[0].id, document.layers[0].id)];
  document.images[cel.imageId].data.set([255, 255, 255, 255], (3 * 16 + 2) * 4);
  document = duplicateFrame(document, document.frames[0].id);
  document.frames[1].durationMs = 140;
  document = addTag(document, {
    name: "attack",
    fromFrameId: document.frames[0].id,
    toFrameId: document.frames[1].id,
    direction: "reverse",
  });

  const files = await exportUnity(document, {
    columns: 2,
    padding: 0,
    margin: 1,
    trim: true,
    pixelsPerUnit: 32,
    pivot: { x: 0.5, y: 0 },
  });
  assert.deepEqual(files.map((file) => file.path), [
    "spritesheet.png",
    "pixelforge-unity.json",
    "Editor/PixelForgeImporter.cs",
    "README.md",
  ]);
  const metadata = JSON.parse(files[1].data as string);
  assert.equal(metadata.pixelsPerUnit, 32);
  assert.deepEqual(metadata.pivot, { x: 0.5, y: 0 });
  assert.deepEqual(metadata.frames[0].frame, { x: 1, y: 1, w: 1, h: 1 });
  assert.deepEqual(metadata.frames[0].spriteSourceSize, { x: 2, y: 3, w: 1, h: 1 });
  assert.equal(metadata.frames[1].duration, 140);
  assert.deepEqual(metadata.animations[0], {
    name: "attack",
    frames: ["attack_000", "attack_001"],
    direction: "reverse",
  });
  const importer = files[2].data as string;
  assert.match(importer, /AssetPostprocessor/);
  assert.match(importer, /MenuItem\("PixelForge\/Import Selected Bundle"\)/);
  assert.match(importer, /SpriteImportMode\.Multiple/);
  assert.match(importer, /ISpriteEditorDataProvider/);
  assert.match(importer, /dataProvider == null/);
  assert.match(importer, /dataImporter == null/);
  assert.match(importer, /spriteSourceSize/);
  assert.doesNotMatch(importer, /importer\.spritesheet/);
  assert.match(importer, /AnimationUtility\.SetObjectReferenceCurve/);
  assert.ok((files[3].data as string).includes("Unity 프로젝트의 Assets"));
});
