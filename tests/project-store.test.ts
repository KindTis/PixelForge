import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDocument, createProject as makeProject } from "../src/core/document.ts";
import { createProject, loadProject, resolveInside, saveProject } from "../src/server/project-store.ts";

test("프로젝트 외부 경로를 거부한다", () => {
  const root = join(tmpdir(), "pixelforge-root");
  assert.throws(() => resolveInside(root, "..\\secret.txt"), /프로젝트 외부/);
  assert.throws(() => resolveInside(root, "../secret.txt"), /프로젝트 외부/);
});

test("프로젝트와 픽셀을 PNG로 저장하고 동일하게 복원한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixelforge-"));
  try {
    const project = makeProject("용사", createDocument({ width: 2, height: 1 }));
    const image = Object.values(project.document.images)[0];
    image.data.set([255, 10, 20, 255, 0, 0, 0, 0]);

    await createProject(root, project);
    assert.deepEqual(await loadProject(root), project);

    const manifest = JSON.parse(await readFile(join(root, "pixelforge.json"), "utf8"));
    assert.equal(manifest.document.images[Object.keys(project.document.images)[0]].file.endsWith(".png"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("손상되거나 지원하지 않는 프로젝트를 구분한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixelforge-"));
  try {
    await writeFile(join(root, "pixelforge.json"), "{");
    await assert.rejects(loadProject(root), /손상/);
    await writeFile(join(root, "pixelforge.json"), JSON.stringify({ version: 9 }));
    await assert.rejects(loadProject(root), /지원하지 않는 프로젝트 버전/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("다시 저장한 프로젝트를 최신 상태로 읽는다", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixelforge-"));
  try {
    const project = makeProject("용사", createDocument({ width: 1, height: 1 }));
    await createProject(root, project);
    project.name = "검사";
    await saveProject(root, project);
    assert.equal((await loadProject(root)).name, "검사");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
