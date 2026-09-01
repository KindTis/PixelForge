import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { validateDocument } from "../core/document.ts";
import type { PixelBuffer, SpriteProject } from "../core/types.ts";
import { decodePng, encodePng } from "./png.ts";

type StoredImage = { width: number; height: number; file: string };
type StoredProject = Omit<SpriteProject, "document"> & {
  document: Omit<SpriteProject["document"], "images"> & { images: Record<string, StoredImage> };
};

export function resolveInside(root: string, relativePath: string): string {
  if (isAbsolute(relativePath)) throw new Error("프로젝트 외부 경로는 사용할 수 없습니다.");
  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, relativePath);
  const fromRoot = relative(resolvedRoot, target);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error("프로젝트 외부 경로는 사용할 수 없습니다.");
  }
  return target;
}

function imageFileName(id: string): string {
  return `${Buffer.from(id, "utf8").toString("base64url")}.png`;
}

async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, data);
  await rename(temporary, path);
}

function storedProject(project: SpriteProject): StoredProject {
  const images = Object.fromEntries(Object.entries(project.document.images).map(([id, image]) => [id, {
    width: image.width,
    height: image.height,
    file: `cels/${imageFileName(id)}`,
  }]));
  return {
    ...project,
    document: { ...project.document, images },
  };
}

export async function saveProject(root: string, project: SpriteProject): Promise<void> {
  validateDocument(project.document);
  const manifest = storedProject(project);
  for (const [id, image] of Object.entries(project.document.images)) {
    const path = resolveInside(root, manifest.document.images[id].file);
    await writeAtomic(path, encodePng(image.width, image.height, image.data));
  }
  await writeAtomic(resolveInside(root, "pixelforge.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

export async function createProject(root: string, project: SpriteProject): Promise<void> {
  await mkdir(resolve(root), { recursive: true });
  await saveProject(root, project);
}

function parseManifest(source: string): StoredProject {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("프로젝트 파일이 손상되었습니다.");
  }
  if (!value || typeof value !== "object") throw new Error("프로젝트 파일이 손상되었습니다.");
  const header = value as { format?: unknown; version?: unknown };
  if (header.format === undefined) {
    throw new Error("이전 PixelForge 프로젝트 형식은 지원하지 않습니다. 원본은 변경되지 않았습니다. 새 프로젝트를 만들어 주세요.");
  }
  if (header.format !== "pixelforge-project") throw new Error("지원하지 않는 프로젝트 형식입니다.");
  if (header.version !== 1) throw new Error("지원하지 않는 프로젝트 버전입니다.");
  const project = value as StoredProject;
  if (!project.document || !project.document.images || typeof project.name !== "string") {
    throw new Error("프로젝트 파일이 손상되었습니다.");
  }
  return project;
}

export async function loadProject(root: string): Promise<SpriteProject> {
  const manifest = parseManifest(await readFile(resolveInside(root, "pixelforge.json"), "utf8"));
  const images: Record<string, PixelBuffer> = {};
  for (const [id, stored] of Object.entries(manifest.document.images)) {
    const decoded = decodePng(await readFile(resolveInside(root, stored.file)));
    if (decoded.width !== stored.width || decoded.height !== stored.height) throw new Error("셀 이미지 크기가 프로젝트와 다릅니다.");
    images[id] = decoded;
  }
  const project: SpriteProject = {
    ...manifest,
    document: { ...manifest.document, images },
  };
  validateDocument(project.document);
  return project;
}
