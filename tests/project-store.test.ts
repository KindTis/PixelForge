import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDocument, createProject as makeProject } from "../src/core/document.ts";
import { addFrame, addLayer } from "../src/core/timeline.ts";
import { celKey } from "../src/core/types.ts";
import { importRegeneratedFrame } from "../src/server/generation.ts";
import { encodePng } from "../src/server/png.ts";
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

    const legacyJson = JSON.stringify({ version: 1 });
    const manifestPath = join(root, "pixelforge.json");
    await writeFile(manifestPath, legacyJson);
    await assert.rejects(
      loadProject(root),
      /이전 PixelForge 프로젝트 형식.*원본은 변경되지.*새 프로젝트/,
    );
    assert.equal(await readFile(manifestPath, "utf8"), legacyJson);

    await writeFile(manifestPath, JSON.stringify({ format: "pixelforge-project", version: 9 }));
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

test("선택 프레임 재생성 결과를 저장 왕복해 전체 프로젝트를 보존한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixelforge-regenerated-roundtrip-"));
  try {
    let document = createDocument({ width: 2, height: 2 });
    document = addFrame(addFrame(document));
    document = addLayer(document, "효과");
    for (const [index, cel] of Object.values(document.cels).entries()) document.images[cel.imageId].data.fill(index + 1);
    document.tags.push({ id: crypto.randomUUID(), name: "공격", frameIds: document.frames.map((frame) => frame.id), direction: "pingPong" });
    const project = makeProject("기사", document);
    project.generationHistory.push({ id: crypto.randomUUID(), prompt: "기존 생성", createdAt: "2026-08-09T00:00:00.000Z", outputPath: "old.png" });
    const selectedFrame = project.document.frames[1];
    const before = structuredClone(project);
    const regenerated = importRegeneratedFrame(project, encodePng(2, 2, new Uint8ClampedArray([
      255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0,
    ])), { prompt: "검 공격", frameId: selectedFrame.id }, "generated/frame.png");

    await saveProject(root, regenerated);
    const loaded = await loadProject(root);
    assert.deepEqual(loaded, regenerated);
    assert.deepEqual(loaded.document.frames, before.document.frames);
    assert.deepEqual(loaded.document.layers, before.document.layers);
    assert.deepEqual(loaded.document.tags, before.document.tags);
    assert.deepEqual(loaded.document.palette, before.document.palette);
    assert.deepEqual(loaded.generationHistory, before.generationHistory);
    for (const frame of before.document.frames.filter(({ id }) => id !== selectedFrame.id)) {
      for (const layer of before.document.layers) {
        const beforeCel = before.document.cels[celKey(frame.id, layer.id)];
        const loadedCel = loaded.document.cels[celKey(frame.id, layer.id)];
        assert.deepEqual(Array.from(loaded.document.images[loadedCel.imageId].data), Array.from(before.document.images[beforeCel.imageId].data));
      }
    }
    const selectedLayers = loaded.document.layers.map((layer) => loaded.document.images[loaded.document.cels[celKey(selectedFrame.id, layer.id)].imageId].data);
    assert.deepEqual(Array.from(selectedLayers[0]), [
      0, 0, 0, 0, 0, 0, 0, 0,
      255, 255, 255, 255, 255, 255, 255, 255,
    ]);
    assert.deepEqual(Array.from(selectedLayers[1]), new Array(16).fill(0));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
