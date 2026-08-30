import { readFile } from "node:fs/promises";
import { assertUniqueUnityAnimationClipFileNames, unityAnimationClipFileName } from "../../core/animation.ts";
import type { SpriteDocument } from "../../core/types.ts";
import { buildCommon, type ExportFile, type SheetOptions } from "./common.ts";

export type UnityOptions = SheetOptions & {
  pixelsPerUnit: number;
  pivot: { x: number; y: number };
};

export async function exportUnity(document: SpriteDocument, options: UnityOptions): Promise<ExportFile[]> {
  if (!Number.isFinite(options.pixelsPerUnit) || options.pixelsPerUnit <= 0) throw new Error("Pixels Per Unit은 0보다 커야 합니다.");
  if (options.pivot.x < 0 || options.pivot.x > 1 || options.pivot.y < 0 || options.pivot.y > 1) throw new Error("피벗은 0~1 사이여야 합니다.");
  assertUniqueUnityAnimationClipFileNames(document.tags);
  const common = buildCommon(document, options);
  const metadata = {
    texture: "spritesheet.png",
    sheetSize: common.metadata.meta.size,
    pixelsPerUnit: options.pixelsPerUnit,
    pivot: options.pivot,
    frames: common.metadata.frames,
    animations: Object.entries(common.metadata.animations).map(([name, animation]) => ({
      name,
      clipFilename: unityAnimationClipFileName(name),
      ...animation,
    })),
  };
  return [
    { path: "spritesheet.png", data: common.png },
    { path: "pixelforge-unity.json", data: `${JSON.stringify(metadata, null, 2)}\n` },
    { path: "Editor/PixelForgeImporter.cs", data: await readFile(new URL("./PixelForgeImporter.cs.txt", import.meta.url), "utf8") },
    { path: "README.md", data: "# Unity 가져오기\n\n이 폴더 전체를 Unity 프로젝트의 Assets 안에 복사한 뒤 메뉴에서 `PixelForge > Import Selected Bundle`을 실행하세요.\n" },
  ];
}
