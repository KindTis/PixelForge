import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { addAnimationTag } from "../src/core/animation.ts";
import { createDocument } from "../src/core/document.ts";
import { exportProject } from "../src/server/exporters/index.ts";

const options = { columns: 1, padding: 0, margin: 0, trim: false, pixelsPerUnit: 100, pivot: { x: 0.5, y: 0.5 } };

function exportableDocument() {
  const document = createDocument({ width: 1, height: 1 });
  return addAnimationTag(document, { name: "idle", direction: "forward", frameIds: [document.frames[0].id] });
}

test("내보내기는 전부 성공할 때만 기존 대상 폴더를 교체한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixelforge-export-"));
  const target = join(root, "godot");
  await mkdir(target);
  await writeFile(join(target, "old.txt"), "보존");
  try {
    await assert.rejects(
      exportProject("godot", exportableDocument(), options, root, {
        build: async () => [
          { path: "new.txt", data: "새 파일" },
          { path: "../escape.txt", data: "실패" },
        ],
      }),
      /외부 경로/,
    );
    assert.equal(await readFile(join(target, "old.txt"), "utf8"), "보존");

    const result = await exportProject("common", exportableDocument(), options, root);
    assert.deepEqual(result.files, ["spritesheet.png", "spritesheet.json"]);
    assert.equal(JSON.parse(await readFile(join(root, "common", "spritesheet.json"), "utf8")).meta.app, "PixelForge");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("프로젝트 저장 실패는 새 대상을 제거하고 기존 대상 폴더를 복구한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixelforge-export-commit-"));
  const target = join(root, "common");
  const project = exportableDocument();
  const failCommit = { commit: async () => { throw new Error("프로젝트 저장 실패"); } };
  await mkdir(target);
  await writeFile(join(target, "old.txt"), "보존");

  try {
    await assert.rejects(exportProject("common", project, options, root, failCommit), /프로젝트 저장 실패/);
    assert.equal(await readFile(join(target, "old.txt"), "utf8"), "보존");
    assert.deepEqual(await readdir(root), ["common"]);

    await rm(target, { recursive: true, force: true });
    await assert.rejects(exportProject("common", project, options, root, failCommit), /프로젝트 저장 실패/);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("대상 폴더 복구 실패는 원인과 복구 경로를 함께 보고한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixelforge-export-rollback-"));
  const target = join(root, "common");
  await mkdir(target);
  await writeFile(join(target, "old.txt"), "보존");

  try {
    await assert.rejects(
      exportProject("common", exportableDocument(), options, root, {
        commit: async () => {
          const backup = (await readdir(root)).find((entry) => entry.startsWith(".backup-common-"));
          assert.ok(backup);
          await rm(join(root, backup), { recursive: true, force: true });
          throw new Error("프로젝트 저장 실패");
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.length, 2);
        assert.match(error.message, /대상 폴더를 복구하지 못했습니다/);
        assert.equal(error.message.includes(target), true);
        assert.match(error.message, /\.backup-common-/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
