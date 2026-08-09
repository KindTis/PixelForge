import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDocument } from "../src/core/document.ts";
import { exportProject } from "../src/server/exporters/index.ts";

const options = { columns: 1, padding: 0, margin: 0, trim: false, pixelsPerUnit: 100, pivot: { x: 0.5, y: 0.5 } };

test("내보내기는 전부 성공할 때만 기존 대상 폴더를 교체한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixelforge-export-"));
  const target = join(root, "godot");
  await mkdir(target);
  await writeFile(join(target, "old.txt"), "보존");
  try {
    await assert.rejects(
      exportProject("godot", createDocument({ width: 1, height: 1 }), options, root, async () => [
        { path: "new.txt", data: "새 파일" },
        { path: "../escape.txt", data: "실패" },
      ]),
      /외부 경로/,
    );
    assert.equal(await readFile(join(target, "old.txt"), "utf8"), "보존");

    const result = await exportProject("common", createDocument({ width: 1, height: 1 }), options, root);
    assert.deepEqual(result.files, ["spritesheet.png", "spritesheet.json"]);
    assert.equal(JSON.parse(await readFile(join(root, "common", "spritesheet.json"), "utf8")).meta.app, "PixelForge");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
