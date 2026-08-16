import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { SpriteDocument } from "../../core/types.ts";
import { resolveInside } from "../project-store.ts";
import { exportCommon, type ExportFile, type SheetOptions } from "./common.ts";
import { exportGodot } from "./godot.ts";
import { exportUnity, type UnityOptions } from "./unity.ts";

export type ExportTarget = "common" | "godot" | "unity";
export type ExportOptions = SheetOptions & Pick<UnityOptions, "pixelsPerUnit" | "pivot">;
type BuildExport = (document: SpriteDocument, options: ExportOptions) => Promise<ExportFile[]>;
type ExportTransaction = {
  build?: BuildExport;
  commit?: () => Promise<void>;
};

const exporters: Record<ExportTarget, BuildExport> = {
  common: exportCommon,
  godot: exportGodot,
  unity: exportUnity,
};

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

export async function exportProject(
  target: ExportTarget,
  document: SpriteDocument,
  options: ExportOptions,
  outputRoot: string,
  transaction: ExportTransaction = {},
): Promise<{ outputPath: string; files: string[] }> {
  const build = transaction.build ?? exporters[target];
  if (!build) throw new Error("지원하지 않는 내보내기 대상입니다.");
  const root = resolve(outputRoot);
  await mkdir(root, { recursive: true });
  const outputPath = resolveInside(root, target);
  const temporary = resolveInside(root, `.tmp-${target}-${randomUUID()}`);
  const backup = resolveInside(root, `.backup-${target}-${randomUUID()}`);
  let backedUp = false;
  let installed = false;
  await mkdir(temporary);
  try {
    const files = await build(document, options);
    for (const file of files) {
      const path = resolveInside(temporary, file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.data);
    }
    if (await exists(outputPath)) {
      await rename(outputPath, backup);
      backedUp = true;
    }
    try {
      await rename(temporary, outputPath);
      installed = true;
      await transaction.commit?.();
    } catch (error) {
      try {
        if (installed) await rm(outputPath, { recursive: true, force: true });
        if (backedUp) await rename(backup, outputPath);
      } catch (rollbackError) {
        const paths = backedUp ? `새 대상: ${outputPath}, 백업: ${backup}` : `새 대상: ${outputPath}`;
        throw new AggregateError([error, rollbackError], `내보내기 실패 후 대상 폴더를 복구하지 못했습니다. ${paths}`);
      }
      throw error;
    }
    if (backedUp) await rm(backup, { recursive: true, force: true }).catch(() => undefined);
    return { outputPath, files: files.map((file) => file.path) };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
