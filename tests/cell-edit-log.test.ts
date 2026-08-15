import { deepStrictEqual, ok, rejects, strictEqual, throws } from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AI_EDIT_CRITERIA, type AiEditRequest, type AiEditVerdict } from "../src/core/ai-edit.ts";
import { CELL_EDIT_MODEL_SETTINGS } from "../src/server/codex-bridge.ts";
import { decodePng } from "../src/server/png.ts";
import {
  createCellEditLog,
  writeCellEditAttempt,
  writeCellEditInitial,
  writeCellEditSummary,
  writeCellEditVerdict,
  type CellEditSummary,
} from "../src/server/cell-edit-log.ts";

const request: AiEditRequest = {
  prompt: "배경을 정리해 줘",
  target: { frameId: "frame-1", layerId: "layer-1", celId: "cel-1" },
  settings: {
    tool: "pencil",
    color: [255, 255, 255, 255],
    secondaryColor: [0, 0, 0, 0],
    brushSize: 1,
    brushShape: "square",
    filled: true,
    mirrorX: false,
    mirrorY: false,
  },
};

const original = {
  composite: { width: 1, height: 1, data: new Uint8ClampedArray([1, 2, 3, 255]) },
  cel: { width: 1, height: 1, data: new Uint8ClampedArray([4, 5, 6, 255]) },
};

const candidate = {
  composite: { width: 1, height: 1, data: new Uint8ClampedArray([7, 8, 9, 255]) },
  cel: { width: 1, height: 1, data: new Uint8ClampedArray([10, 11, 12, 255]) },
};

const verdict: AiEditVerdict = {
  verdict: "pass",
  summary: "합격",
  criteria: AI_EDIT_CRITERIA.map((id) => ({ id, passed: true, reason: "충족" })),
  corrections: [],
};

test("단계별 셀 편집 로그가 PNG·JSON과 슬래시 상대 경로를 영구 기록한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixelforge-cell-edit-log-"));
  try {
    const jobId = "job-123";
    const log = createCellEditLog(root, jobId);
    await writeCellEditInitial(log, request, original);

    strictEqual(log.relativeDir, `generated/cell-edit-logs/${jobId}`);
    strictEqual(log.absoluteDir, join(root, "generated", "cell-edit-logs", jobId));
    deepStrictEqual(log.files, [
      `${log.relativeDir}/original-composite.png`,
      `${log.relativeDir}/original-cel.png`,
      `${log.relativeDir}/request.json`,
    ]);
    const requestLog = JSON.parse(await readFile(join(log.absoluteDir, "request.json"), "utf8"));
    deepStrictEqual(requestLog.request, request);
    strictEqual(requestLog.jobId, jobId);
    deepStrictEqual(requestLog.model, {
      name: CELL_EDIT_MODEL_SETTINGS.model,
      reasoningEffort: CELL_EDIT_MODEL_SETTINGS.reasoningEffort,
    });
    ok(!Buffer.from(await readFile(join(log.absoluteDir, "request.json"))).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])));

    const paths = await writeCellEditAttempt(log, 1, candidate);
    strictEqual(paths.compositeRelative, `${log.relativeDir}/attempt-01-composite.png`);
    strictEqual(paths.celRelative, `${log.relativeDir}/attempt-01-cel.png`);
    deepStrictEqual(decodePng(await readFile(paths.compositeAbsolute)).data, candidate.composite.data);
    deepStrictEqual(decodePng(await readFile(paths.celAbsolute)).data, candidate.cel.data);
    await writeCellEditVerdict(log, 1, verdict);
    const summary: CellEditSummary = {
      jobId,
      status: "completed",
      outcome: "accepted",
      attemptCount: 1,
      acceptedAttempt: 1,
      application: "applied",
      files: [...log.files, `${log.relativeDir}/attempt-01-verdict.json`],
    };
    await writeCellEditSummary(log, summary);
    deepStrictEqual(JSON.parse(await readFile(join(log.absoluteDir, "summary.json"), "utf8")), summary);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("직접 완료는 시도 파일을 만들지 않고 잘못된 job ID를 거부한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixelforge-cell-edit-log-"));
  try {
    throws(() => createCellEditLog(root, "../outside"), /작업 ID/);
    throws(() => createCellEditLog(root, "nested/job"), /작업 ID/);
    const log = createCellEditLog(root, "direct-job");
    await writeCellEditInitial(log, request, original);
    strictEqual(log.files.length, 3);
    await rejects(readFile(join(log.absoluteDir, "attempt-01-composite.png")), { code: "ENOENT" });
    await rejects(readFile(join(log.absoluteDir, "attempt-01-verdict.json")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("시도 기록 실패 시 이미 성공한 파일과 부분 로그 위치를 보존한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixelforge-cell-edit-log-"));
  try {
    const log = createCellEditLog(root, "partial-job");
    await writeCellEditInitial(log, request, original);
    await mkdir(join(log.absoluteDir, "attempt-01-composite.png"));
    await rejects(writeCellEditAttempt(log, 1, candidate));
    ok((await readFile(join(log.absoluteDir, "original-composite.png")).then((file) => file.length)) > 0);
    ok((await readFile(join(log.absoluteDir, "original-cel.png")).then((file) => file.length)) > 0);
    strictEqual(JSON.parse(await readFile(join(log.absoluteDir, "request.json"), "utf8")).jobId, "partial-job");
    deepStrictEqual(log.files, [
      `${log.relativeDir}/original-composite.png`,
      `${log.relativeDir}/original-cel.png`,
      `${log.relativeDir}/request.json`,
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
