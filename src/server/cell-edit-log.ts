import { mkdir, writeFile } from "node:fs/promises";
import type { AiEditRequest, AiEditVerdict } from "../core/ai-edit.ts";
import type { PixelBuffer } from "../core/types.ts";
import { CELL_EDIT_MODEL_SETTINGS } from "./codex-bridge.ts";
import { encodePng } from "./png.ts";
import { resolveInside } from "./project-store.ts";

type CellEditImages = { composite: PixelBuffer; cel: PixelBuffer };

export type CellEditLog = {
  projectRoot: string;
  jobId: string;
  relativeDir: string;
  absoluteDir: string;
  files: string[];
};

export type CellEditAttemptPaths = {
  compositeRelative: string;
  compositeAbsolute: string;
  celRelative: string;
  celAbsolute: string;
};

export type CellEditSummary = {
  jobId: string;
  status: string;
  outcome: "accepted" | "direct" | "quality_failed" | "cancelled" | "technical_error";
  attemptCount: number;
  acceptedAttempt?: number;
  application?: string;
  error?: string;
  files: string[];
};

const LOG_ROOT = "generated/cell-edit-logs";

function pathFor(log: CellEditLog, name: string): { relative: string; absolute: string } {
  const relative = `${log.relativeDir}/${name}`;
  return { relative, absolute: resolveInside(log.projectRoot, relative) };
}

function attemptName(attempt: number): string {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error("시도 번호가 올바르지 않습니다.");
  return String(attempt).padStart(2, "0");
}

export function createCellEditLog(projectRoot: string, jobId: string): CellEditLog {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(jobId)) throw new Error("작업 ID가 올바르지 않습니다.");
  const relativeDir = `${LOG_ROOT}/${jobId}`;
  return {
    projectRoot,
    jobId,
    relativeDir,
    absoluteDir: resolveInside(projectRoot, relativeDir),
    files: [],
  };
}

export async function writeCellEditInitial(log: CellEditLog, request: AiEditRequest, original: CellEditImages): Promise<void> {
  await mkdir(log.absoluteDir, { recursive: true });

  const composite = pathFor(log, "original-composite.png");
  await writeFile(composite.absolute, encodePng(original.composite.width, original.composite.height, original.composite.data));
  log.files.push(composite.relative);

  const cel = pathFor(log, "original-cel.png");
  await writeFile(cel.absolute, encodePng(original.cel.width, original.cel.height, original.cel.data));
  log.files.push(cel.relative);

  const requestPath = pathFor(log, "request.json");
  const requestLog = {
    jobId: log.jobId,
    request,
    model: { name: CELL_EDIT_MODEL_SETTINGS.model, reasoningEffort: CELL_EDIT_MODEL_SETTINGS.reasoningEffort },
  };
  await writeFile(requestPath.absolute, `${JSON.stringify(requestLog, null, 2)}\n`, "utf8");
  log.files.push(requestPath.relative);
}

export async function writeCellEditAttempt(log: CellEditLog, attempt: number, candidate: CellEditImages): Promise<CellEditAttemptPaths> {
  const name = attemptName(attempt);
  const composite = pathFor(log, `attempt-${name}-composite.png`);
  const cel = pathFor(log, `attempt-${name}-cel.png`);
  await writeFile(composite.absolute, encodePng(candidate.composite.width, candidate.composite.height, candidate.composite.data));
  log.files.push(composite.relative);
  await writeFile(cel.absolute, encodePng(candidate.cel.width, candidate.cel.height, candidate.cel.data));
  log.files.push(cel.relative);
  return {
    compositeRelative: composite.relative,
    compositeAbsolute: composite.absolute,
    celRelative: cel.relative,
    celAbsolute: cel.absolute,
  };
}

export async function writeCellEditVerdict(log: CellEditLog, attempt: number, verdict: AiEditVerdict): Promise<string> {
  const path = pathFor(log, `attempt-${attemptName(attempt)}-verdict.json`);
  await writeFile(path.absolute, `${JSON.stringify(verdict, null, 2)}\n`, "utf8");
  log.files.push(path.relative);
  return path.absolute;
}

export async function writeCellEditSummary(log: CellEditLog, summary: CellEditSummary): Promise<void> {
  const path = pathFor(log, "summary.json");
  await writeFile(path.absolute, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  log.files.push(path.relative);
}
