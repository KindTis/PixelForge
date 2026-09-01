import assert from "node:assert/strict";
import test from "node:test";
import { addAnimationTag } from "../src/core/animation.ts";
import { createDocument } from "../src/core/document.ts";
import { duplicateFrame } from "../src/core/timeline.ts";
import { exportUnity } from "../src/server/exporters/unity.ts";

test("Unity 묶음은 공유 스프라이트를 한 번만 분할하고 단계별 시간을 사용한다", async () => {
  let document = createDocument({ width: 1, height: 1 });
  const idleId = document.frames[0].id;
  document = duplicateFrame(document, idleId);
  const walkId = document.frames[1].id;
  document.frames[0].durationMs = 100;
  document.frames[1].durationMs = 180;
  document = addAnimationTag(document, { name: "idle", frameIds: [idleId], direction: "forward" });
  document = addAnimationTag(document, { name: "walk", frameIds: [walkId], direction: "forward" });

  const files = await exportUnity(document, {
    columns: 1,
    padding: 0,
    margin: 0,
    trim: false,
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
  assert.equal(metadata.frames.length, 1);
  assert.deepEqual(metadata.animations[0].steps, [{ frameId: idleId, sprite: "sprite_000", duration: 100 }]);
  assert.deepEqual(metadata.animations[1].steps, [{ frameId: walkId, sprite: "sprite_000", duration: 180 }]);
  assert.deepEqual(
    metadata.animations.map(({ name, clipFilename }: { name: string; clipFilename: string }) => ({ name, clipFilename })),
    [{ name: "idle", clipFilename: "idle" }, { name: "walk", clipFilename: "walk" }],
  );
  assert.equal(files.filter((file) => file.path === "spritesheet.png").length, 1);
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
  assert.match(importer, /animation\.clipFilename/);
  assert.match(importer, /class AnimationStep/);
  assert.match(importer, /step\.sprite/);
  assert.match(importer, /step\.duration/);
  assert.doesNotMatch(importer, /Expand\(animation\)/);
  assert.doesNotMatch(importer, /GetInvalidFileNameChars/);
  assert.ok((files[3].data as string).includes("Unity 프로젝트의 Assets"));
});

test("Unity 내보내기는 충돌한 AnimationClip 파일명을 파일 생성 전에 거부한다", async () => {
  let document = createDocument({ width: 1, height: 1 });
  document = duplicateFrame(document, document.frames[0].id);
  document.tags = [
    { id: "attack-a", name: "attack?", frameIds: [document.frames[0].id], direction: "forward" },
    { id: "attack-b", name: "ATTACK*", frameIds: [document.frames[1].id], direction: "forward" },
  ];

  await assert.rejects(
    exportUnity(document, {
      columns: 2,
      padding: 0,
      margin: 0,
      trim: false,
      pixelsPerUnit: 32,
      pivot: { x: 0.5, y: 0 },
    }),
    /attack\?.*ATTACK\*.*충돌하는 태그를 삭제하고 서로 다른 이름으로 다시 추가하세요/,
  );
});
