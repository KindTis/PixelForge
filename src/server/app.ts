import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import {
  AI_EDIT_OUTPUT_SCHEMA,
  AI_EDIT_VERDICT_OUTPUT_SCHEMA,
  hasPixelActions,
  parseAiEditResult,
  parseAiEditVerdict,
  type AiEditAttempt,
  type AiEditReadyResult,
  type AiEditRequest,
  type AiEditTarget,
  type AiEditVerdict,
} from "../core/ai-edit.ts";
import { runAiEdit, selectionMask, type AiEditExecutionState } from "../core/ai-edit-runner.ts";
import { createDocument, createProject as makeProject, validateDocument } from "../core/document.ts";
import { compositeFrame } from "../core/render.ts";
import { celKey, type PixelBuffer, type SpriteProject } from "../core/types.ts";
import type { AccountState, CodexBridge, CodexEvent } from "./codex-bridge.ts";
import {
  createCellEditLog,
  writeCellEditAttempt,
  writeCellEditInitial,
  writeCellEditSummary,
  writeCellEditVerdict,
  type CellEditAttemptPaths,
  type CellEditLog,
} from "./cell-edit-log.ts";
import {
  buildFrameRegenerationPrompt,
  buildSpriteSheetPrompt,
  importRegeneratedFrame,
  importSpriteSheet,
  type FrameReferencePaths,
  type FrameRegenerationRequest,
  type SpriteSheetRequest,
} from "./generation.ts";
import { createProject, loadProject, resolveInside, saveProject } from "./project-store.ts";
import { decodePng, encodePng } from "./png.ts";
import { exportProject, type ExportOptions, type ExportTarget } from "./exporters/index.ts";
import { activeCelFrame, buildAiEditPrompt, buildAiEditVerdictPrompt, validateAiEditRequest } from "./ai-edit.ts";

type CodexClient = Pick<CodexBridge, "getAccount" | "login" | "startGeneration" | "startCellEdit" | "startCellEditJudgment" | "interrupt" | "respond"> & {
  on(event: "event", listener: (event: CodexEvent) => void): unknown;
};

type JobStatus = "running" | "awaitingApproval" | "cancelling" | "finalizing" | "completed" | "failed" | "cancelled";
type JobBase = {
  id: string;
  projectId: string;
  runId?: string;
  status: JobStatus;
  messages: string[];
  error?: string;
};
type GenerationJob = JobBase & {
  kind: "generation";
  request: SpriteSheetRequest | FrameRegenerationRequest;
  frameId?: string;
  outputPath: string;
  relativeOutputPath: string;
  approval?: { requestId: number; method: string; params: Record<string, unknown> };
  project?: SpriteProject;
};
type CellEditJob = JobBase & {
  kind: "cellEdit";
  request: AiEditRequest;
  target: AiEditTarget;
  phase: "editing" | "judging";
  attempt: number;
  maxAttempts: number;
  lastVerdict?: AiEditVerdict;
  log: CellEditLog;
  originalProject: SpriteProject;
  candidate: AiEditExecutionState;
  candidatePaths?: CellEditAttemptPaths;
  attempts: AiEditAttempt[];
  hadRejectedPixelCandidate: boolean;
  activeRun?: {
    id: string;
    role: "editing" | "judging";
    resultText?: string;
    resultConflict?: boolean;
    completionClaimed?: boolean;
  };
  terminalDecision?: "finalizing" | "failed" | "cancelled";
  result?: AiEditReadyResult;
};
type Job = GenerationJob | CellEditJob;

export type ServerOptions = {
  projectsRoot: string;
  codex: CodexClient;
  cellEditCodex?: CodexClient;
  staticRoot?: string;
};

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024 * 1024) throw new Error("요청 본문이 너무 큽니다.");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("JSON 요청이 올바르지 않습니다.");
  }
}

function wireProject(project: SpriteProject): unknown {
  const images = Object.fromEntries(Object.entries(project.document.images).map(([id, image]) => [id, {
    ...image,
    data: Array.from(image.data),
  }]));
  return { ...project, document: { ...project.document, images } };
}

function wireJob(job: Job): Record<string, unknown> {
  const base = { id: job.id, kind: job.kind, status: job.status, messages: job.messages, error: job.error };
  if (job.kind === "cellEdit") return {
    ...base,
    target: job.target,
    phase: job.phase,
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
    lastVerdict: job.lastVerdict,
    logPath: job.log.relativeDir,
    result: job.result,
  };
  return {
    ...base,
    frameId: job.frameId,
    approval: job.approval ? { requestId: job.approval.requestId, method: job.approval.method } : undefined,
    project: job.project ? wireProject(job.project) : undefined,
  };
}

function projectFromWire(value: unknown): SpriteProject {
  if (!value || typeof value !== "object") throw new Error("프로젝트 데이터가 올바르지 않습니다.");
  const project = value as SpriteProject & { document?: { images?: Record<string, PixelBuffer & { data: unknown }> } };
  if (project.version !== 1 || !project.document?.images) throw new Error("프로젝트 데이터가 올바르지 않습니다.");
  const images = Object.fromEntries(Object.entries(project.document.images).map(([id, image]) => {
    if (!Array.isArray(image.data)) throw new Error("픽셀 데이터가 올바르지 않습니다.");
    return [id, { ...image, data: new Uint8ClampedArray(image.data) }];
  }));
  const restored = { ...project, document: { ...project.document, images } } as SpriteProject;
  validateDocument(restored.document);
  return restored;
}

function safeProjectId(value: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(value)) throw new Error("프로젝트 ID가 올바르지 않습니다.");
  return value;
}

function allowedOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  return !origin || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
}

function parseExportOptions(value: unknown): ExportOptions {
  if (!value || typeof value !== "object") throw new Error("내보내기 옵션이 필요합니다.");
  const input = value as Record<string, unknown>;
  const pivot = input.pivot as Record<string, unknown> | undefined;
  const options = {
    columns: Number(input.columns),
    padding: Number(input.padding),
    margin: Number(input.margin),
    trim: input.trim,
    pixelsPerUnit: Number(input.pixelsPerUnit),
    pivot: { x: Number(pivot?.x), y: Number(pivot?.y) },
  };
  if (typeof options.trim !== "boolean" || !Number.isFinite(options.pixelsPerUnit) || options.pixelsPerUnit <= 0
    || options.pivot.x < 0 || options.pivot.x > 1 || options.pivot.y < 0 || options.pivot.y > 1) {
    throw new Error("내보내기 옵션이 올바르지 않습니다.");
  }
  return options as ExportOptions;
}

export function createPixelForgeServer({ projectsRoot, codex, cellEditCodex, staticRoot }: ServerOptions) {
  const token = randomBytes(24).toString("base64url");
  const jobs = new Map<string, Job>();
  const runToJob = new Map<CodexClient, Map<string, string>>();
  const earlyEvents = new Map<CodexClient, Map<string, CodexEvent[]>>();
  const ignoredRuns = new Map<CodexClient, Set<string>>();
  const projectLocks = new Map<string, string>();

  const bridgeForJob = (job: Job): CodexClient => job.kind === "generation" ? codex : cellEditCodex!;

  const lockProject = (projectId: string, owner: string): boolean => {
    if (projectLocks.has(projectId)) return false;
    projectLocks.set(projectId, owner);
    return true;
  };

  const unlockProject = (projectId: string, owner: string): void => {
    if (projectLocks.get(projectId) === owner) projectLocks.delete(projectId);
  };

  const ignoreRun = (bridge: CodexClient, runId: string): void => {
    runToJob.get(bridge)?.delete(runId);
    earlyEvents.get(bridge)?.delete(runId);
    const ignored = ignoredRuns.get(bridge) ?? new Set<string>();
    ignoredRuns.set(bridge, ignored);
    ignored.add(runId);
  };

  const applyApproval = (job: GenerationJob, approval: NonNullable<GenerationJob["approval"]>): boolean => {
    if (job.status !== "running") return false;
    job.status = "awaitingApproval";
    job.approval = approval;
    return true;
  };

  const interruptJob = async (job: Job): Promise<void> => {
    if (job.kind === "cellEdit") {
      let interrupted = false;
      const runId = job.activeRun?.id ?? job.runId!;
      ignoreRun(bridgeForJob(job), runId);
      try {
        await bridgeForJob(job).interrupt(runId);
        interrupted = true;
        await writeCellEditSummary(job.log, {
          jobId: job.id,
          status: "cancelled",
          outcome: "cancelled",
          attemptCount: job.attempts.length,
          files: job.log.files,
        });
        job.activeRun = undefined;
        job.status = "cancelled";
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const message = interrupted ? `AI 편집 취소 로그 기록에 실패했습니다: ${detail}` : `Codex 편집 취소에 실패했습니다: ${detail}`;
        job.terminalDecision = "failed";
        job.error = message;
        try {
          await writeCellEditSummary(job.log, {
            jobId: job.id,
            status: "failed",
            outcome: "technical_error",
            attemptCount: job.attempts.length,
            error: message,
            files: job.log.files,
          });
        } catch {
          job.error = `${message} 부분 로그: ${job.log.relativeDir}`;
        }
        job.activeRun = undefined;
        job.status = "failed";
        throw error;
      } finally {
        unlockProject(job.projectId, job.id);
      }
      return;
    }
    try {
      await bridgeForJob(job).interrupt(job.runId!);
      job.status = "cancelled";
    } catch (error) {
      job.status = "failed";
      job.error = `Codex 생성 취소에 실패했습니다: ${error instanceof Error ? error.message : String(error)}`;
      throw error;
    } finally {
      unlockProject(job.projectId, job.id);
    }
  };

  const failCellJob = (job: CellEditJob, message: string, partialLog = false): Promise<void> => {
    if (job.terminalDecision || (job.status !== "running" && job.status !== "awaitingApproval")) return Promise.resolve();
    job.terminalDecision = "failed";
    const runId = job.activeRun?.id;
    if (runId) ignoreRun(bridgeForJob(job), runId);
    job.activeRun = undefined;
    job.error = partialLog ? `${message} 부분 로그: ${job.log.relativeDir}` : message;
    if (runId) void bridgeForJob(job).interrupt(runId).catch(() => undefined);
    return (async () => {
      try {
        await writeCellEditSummary(job.log, {
          jobId: job.id,
          status: "failed",
          outcome: "technical_error",
          attemptCount: job.attempts.length,
          error: job.error,
          files: job.log.files,
        });
      } catch {
        if (!job.error!.includes(`부분 로그: ${job.log.relativeDir}`)) job.error += ` 부분 로그: ${job.log.relativeDir}`;
      }
      job.status = "failed";
      unlockProject(job.projectId, job.id);
    })();
  };

  const currentCellRun = (job: CellEditJob, activeRun: NonNullable<CellEditJob["activeRun"]>): boolean => (
    job.status === "running" && !job.terminalDecision && job.activeRun === activeRun
  );

  const enterFinalizing = async (
    job: CellEditJob,
    result: AiEditReadyResult,
    outcome: "accepted" | "direct",
  ): Promise<void> => {
    if (job.terminalDecision) return;
    job.terminalDecision = "finalizing";
    if (job.activeRun) ignoreRun(bridgeForJob(job), job.activeRun.id);
    job.activeRun = undefined;
    try {
      await writeCellEditSummary(job.log, {
        jobId: job.id,
        status: "finalizing",
        outcome,
        attemptCount: job.attempts.length,
        acceptedAttempt: result.acceptedAttempt,
        files: job.log.files,
      });
      job.result = result;
      job.status = "finalizing";
    } catch (error) {
      job.terminalDecision = "failed";
      job.error = `${error instanceof Error ? error.message : String(error)} 부분 로그: ${job.log.relativeDir}`;
      job.status = "failed";
      unlockProject(job.projectId, job.id);
    }
  };

  const finishQualityFailure = async (job: CellEditJob): Promise<void> => {
    if (job.terminalDecision) return;
    const message = `${job.maxAttempts}회 판정이 모두 불합격했습니다.`;
    job.terminalDecision = "failed";
    if (job.activeRun) ignoreRun(bridgeForJob(job), job.activeRun.id);
    job.activeRun = undefined;
    try {
      await writeCellEditSummary(job.log, {
        jobId: job.id,
        status: "failed",
        outcome: "quality_failed",
        attemptCount: job.attempts.length,
        error: message,
        files: job.log.files,
      });
      job.error = message;
    } catch (error) {
      job.error = `${error instanceof Error ? error.message : String(error)} 부분 로그: ${job.log.relativeDir}`;
    }
    job.status = "failed";
    unlockProject(job.projectId, job.id);
  };

  const startEditing = async (job: CellEditJob, owner?: NonNullable<CellEditJob["activeRun"]>): Promise<void> => {
    const originalCompositePath = join(job.log.absoluteDir, "original-composite.png");
    const originalCelPath = join(job.log.absoluteDir, "original-cel.png");
    const run = await cellEditCodex!.startCellEdit({
      cwd: job.log.absoluteDir,
      prompt: buildAiEditPrompt(job.originalProject, job.request, { attempt: job.attempt, previousVerdict: job.lastVerdict }),
      originalCompositePath,
      originalCelPath,
      candidateCompositePath: job.candidatePaths?.compositeAbsolute ?? originalCompositePath,
      candidateCelPath: job.candidatePaths?.celAbsolute ?? originalCelPath,
      outputSchema: AI_EDIT_OUTPUT_SCHEMA,
    });
    if ((owner && !currentCellRun(job, owner)) || (!owner && (job.status !== "running" || !!job.terminalDecision))) {
      ignoreRun(cellEditCodex!, run.id);
      void cellEditCodex!.interrupt(run.id).catch(() => undefined);
      return;
    }
    job.phase = "editing";
    connectRun(job, cellEditCodex!, run.id, "editing");
  };

  const startJudgment = async (
    job: CellEditJob,
    paths: CellEditAttemptPaths,
    owner: NonNullable<CellEditJob["activeRun"]>,
  ): Promise<void> => {
    const run = await cellEditCodex!.startCellEditJudgment({
      cwd: job.log.absoluteDir,
      prompt: buildAiEditVerdictPrompt(job.request),
      originalCompositePath: join(job.log.absoluteDir, "original-composite.png"),
      originalCelPath: join(job.log.absoluteDir, "original-cel.png"),
      candidateCompositePath: paths.compositeAbsolute,
      candidateCelPath: paths.celAbsolute,
      outputSchema: AI_EDIT_VERDICT_OUTPUT_SCHEMA,
    });
    if (!currentCellRun(job, owner)) {
      ignoreRun(cellEditCodex!, run.id);
      void cellEditCodex!.interrupt(run.id).catch(() => undefined);
      return;
    }
    job.phase = "judging";
    connectRun(job, cellEditCodex!, run.id, "judging");
  };

  const finishCellRun = async (job: CellEditJob, runId: string, status: string): Promise<void> => {
    const activeRun = job.activeRun;
    if (!activeRun || activeRun.id !== runId || !currentCellRun(job, activeRun) || activeRun.completionClaimed) return;
    activeRun.completionClaimed = true;
    try {
      if (status !== "completed") throw new Error(`Codex ${activeRun.role === "editing" ? "편집" : "판정"}이 ${status} 상태로 끝났습니다.`);
      if (activeRun.resultConflict) throw new Error(`서로 다른 AI 편집 ${activeRun.role === "editing" ? "최종 응답" : "판정 응답"}이 둘 이상입니다.`);
      if (activeRun.resultText === undefined) throw new Error(`AI 편집 ${activeRun.role === "editing" ? "최종 응답" : "판정 응답"}이 없습니다.`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(activeRun.resultText);
      } catch {
        throw new Error(`AI 편집 ${activeRun.role === "editing" ? "결과" : "판정"} JSON이 올바르지 않습니다.`);
      }

      if (activeRun.role === "editing") {
        const result = parseAiEditResult(parsed, job.originalProject.document.width, job.originalProject.document.height);
        const seed = randomBytes(4).readUInt32LE(0);
        const application = runAiEdit(job.candidate, job.target, result, seed);
        job.attempts.push({ seed, result });
        job.candidate = { document: application.document, ...application.settings };
        const direct = job.attempt === 1
          && !job.hadRejectedPixelCandidate
          && result.actions.length > 0
          && !hasPixelActions(result.actions);
        if (direct) {
          await enterFinalizing(job, {
            summary: result.summary,
            attempts: job.attempts,
            actionCount: application.actionCount,
            direct: true,
          }, "direct");
          return;
        }

        let paths: CellEditAttemptPaths;
        try {
          paths = await writeCellEditAttempt(job.log, job.attempt, {
            composite: compositeFrame(application.document, job.target.frameId),
            cel: activeCelFrame(application.document, job.target),
          });
        } catch (error) {
          await failCellJob(job, error instanceof Error ? error.message : String(error), true);
          return;
        }
        if (!currentCellRun(job, activeRun)) return;
        job.candidatePaths = paths;
        try {
          await startJudgment(job, paths, activeRun);
        } catch (error) {
          if (currentCellRun(job, activeRun)) await failCellJob(job, error instanceof Error ? error.message : String(error));
        }
        return;
      }

      const verdict = parseAiEditVerdict(parsed);
      try {
        await writeCellEditVerdict(job.log, job.attempt, verdict);
      } catch (error) {
        await failCellJob(job, error instanceof Error ? error.message : String(error), true);
        return;
      }
      if (!currentCellRun(job, activeRun)) return;
      if (verdict.verdict === "pass") {
        await enterFinalizing(job, {
          summary: job.attempts.at(-1)!.result.summary,
          attempts: job.attempts,
          actionCount: job.attempts.reduce((count, attempt) => count + attempt.result.actions.length, 0),
          direct: false,
          acceptedAttempt: job.attempt,
        }, "accepted");
        return;
      }

      job.lastVerdict = verdict;
      job.hadRejectedPixelCandidate ||= hasPixelActions(job.attempts.at(-1)!.result.actions);
      if (job.attempt >= job.maxAttempts) {
        await finishQualityFailure(job);
        return;
      }
      job.attempt += 1;
      try {
        await startEditing(job, activeRun);
      } catch (error) {
        if (currentCellRun(job, activeRun)) await failCellJob(job, error instanceof Error ? error.message : String(error));
      }
    } catch (error) {
      if (currentCellRun(job, activeRun)) await failCellJob(job, error instanceof Error ? error.message : String(error));
    }
  };

  const finishGeneration = async (job: GenerationJob, runId: string, status: string): Promise<void> => {
    if ((job.status !== "running" && job.status !== "awaitingApproval") || job.runId !== runId) return;
    job.status = "finalizing";
    let failure: unknown;
    try {
      if (status !== "completed") throw new Error(`Codex 생성이 ${status} 상태로 끝났습니다.`);
      const root = resolveInside(projectsRoot, safeProjectId(job.projectId));
      const project = await loadProject(root);
      let png: Buffer;
      try {
        png = await readFile(job.outputPath);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        const message = job.messages.join("").trim();
        throw new Error(`Codex가 결과 이미지를 생성하지 않았습니다.${message ? ` ${message}` : ""}`);
      }
      job.project = job.frameId !== undefined
        ? importRegeneratedFrame(project, png, job.request as FrameRegenerationRequest, job.relativeOutputPath)
        : importSpriteSheet(project, png, job.request as SpriteSheetRequest, job.relativeOutputPath);
      await saveProject(root, job.project);
    } catch (error) {
      failure = error;
    } finally {
      unlockProject(job.projectId, job.id);
    }
    if (failure) {
      job.status = "failed";
      job.error = failure instanceof Error ? failure.message : String(failure);
    } else {
      job.status = "completed";
    }
  };

  const finish = async (bridge: CodexClient, runId: string, status: string): Promise<void> => {
    const jobId = runToJob.get(bridge)?.get(runId);
    if (!jobId) return;
    const job = jobs.get(jobId);
    if (!job) return;
    if (job.kind === "cellEdit") await finishCellRun(job, runId, status);
    else await finishGeneration(job, runId, status);
  };

  const handleCodexEvent = (bridge: CodexClient, event: CodexEvent): void => {
    if (event.type === "error") {
      for (const job of jobs.values()) if (job.status === "running" || job.status === "awaitingApproval" || job.status === "cancelling") {
        if (bridgeForJob(job) !== bridge) continue;
        if (job.kind === "cellEdit") void failCellJob(job, event.message);
        else {
          job.status = "failed";
          job.approval = undefined;
          job.error = event.message;
          unlockProject(job.projectId, job.id);
        }
      }
      return;
    }
    const runId = "runId" in event ? event.runId : undefined;
    if (!runId) {
      if (event.type === "approval") bridge.respond(event.requestId, { decision: "decline" });
      return;
    }
    const jobId = runToJob.get(bridge)?.get(runId);
    const job = jobId ? jobs.get(jobId) : undefined;
    if (!job) {
      if (ignoredRuns.get(bridge)?.has(runId)) return;
      const bridgeEvents = earlyEvents.get(bridge) ?? new Map<string, CodexEvent[]>();
      earlyEvents.set(bridge, bridgeEvents);
      const queued = bridgeEvents.get(runId) ?? [];
      queued.push(event);
      bridgeEvents.set(runId, queued);
      return;
    }
    const currentCellEvent = job.kind === "cellEdit"
      && job.status === "running"
      && !job.terminalDecision
      && job.activeRun?.id === runId
      && !job.activeRun.completionClaimed;
    if (event.type === "completed") void finish(bridge, runId, event.status);
    else if (event.type === "message") {
      if (job.kind === "cellEdit" && !currentCellEvent) return;
      if (event.text.trim()) job.messages.push(event.text);
    } else if (event.type === "result") {
      if (!currentCellEvent || job.kind !== "cellEdit" || job.activeRun!.completionClaimed) return;
      if (job.activeRun!.resultText === undefined) job.activeRun!.resultText = event.text;
      else if (job.activeRun!.resultText !== event.text) job.activeRun!.resultConflict = true;
    } else if (event.type === "toolAttempt") {
      if (job.kind === "cellEdit" && currentCellEvent) void failCellJob(job, `AI 편집 중 금지된 도구 실행을 시도했습니다: ${event.tool}`);
    } else if (event.type === "approval") {
      const approval = { requestId: event.requestId, method: event.method, params: event.params };
      if (job.kind === "cellEdit") {
        bridge.respond(event.requestId, { decision: "decline" });
        if (currentCellEvent) void failCellJob(job, "AI 편집 작업이 도구 실행 승인을 요청했습니다.");
      } else if (!applyApproval(job, approval)) {
        bridge.respond(event.requestId, { decision: "decline" });
      }
    }
  };

  const connectRun = (job: Job, bridge: CodexClient, runId: string, role?: "editing" | "judging"): void => {
    const bridgeRuns = runToJob.get(bridge) ?? new Map<string, string>();
    runToJob.set(bridge, bridgeRuns);
    if (job.kind === "cellEdit") {
      if (!role) throw new Error("AI 셀 편집 실행 역할이 필요합니다.");
      if (job.activeRun) ignoreRun(bridge, job.activeRun.id);
      job.activeRun = { id: runId, role };
    }
    ignoredRuns.get(bridge)?.delete(runId);
    job.runId = runId;
    bridgeRuns.set(runId, job.id);
    const bridgeEvents = earlyEvents.get(bridge);
    const queued = bridgeEvents?.get(runId) ?? [];
    bridgeEvents?.delete(runId);
    for (const event of queued) handleCodexEvent(bridge, event);
  };

  codex.on("event", (event) => handleCodexEvent(codex, event));
  if (cellEditCodex && cellEditCodex !== codex) cellEditCodex.on("event", (event) => handleCodexEvent(cellEditCodex, event));

  return createServer(async (request, response) => {
    try {
      if (!allowedOrigin(request)) return send(response, 403, { error: "로컬 앱에서만 요청할 수 있습니다." });
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const mutation = request.method !== "GET" && request.method !== "HEAD";
      if (url.pathname.startsWith("/api/") && mutation && request.headers["x-pixelforge-token"] !== token) {
        return send(response, 403, { error: "세션 토큰이 올바르지 않습니다." });
      }

      if (request.method === "GET" && url.pathname === "/api/session") {
        let account: AccountState | { error: string };
        try {
          account = await codex.getAccount();
        } catch (error) {
          account = { error: error instanceof Error ? error.message : String(error) };
        }
        return send(response, 200, { token, account });
      }

      if (request.method === "POST" && url.pathname === "/api/login") {
        return send(response, 200, await codex.login());
      }

      if (request.method === "GET" && url.pathname === "/api/projects") {
        await mkdir(projectsRoot, { recursive: true });
        const projects = [];
        for (const entry of await readdir(projectsRoot, { withFileTypes: true })) {
          if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/i.test(entry.name)) continue;
          try {
            const project = await loadProject(join(projectsRoot, entry.name));
            projects.push({ id: project.id, name: project.name });
          } catch { /* 손상된 폴더는 열 때 상세 오류를 표시한다. */ }
        }
        return send(response, 200, { projects });
      }

      if (request.method === "POST" && url.pathname === "/api/projects") {
        const input = await body(request) as { name?: unknown; width?: unknown; height?: unknown };
        const project = makeProject(String(input.name ?? ""), createDocument({ width: Number(input.width), height: Number(input.height) }));
        await createProject(resolveInside(projectsRoot, project.id), project);
        return send(response, 201, wireProject(project));
      }

      const projectMatch = url.pathname.match(/^\/api\/projects\/([0-9a-f-]{36})$/i);
      if (projectMatch && request.method === "GET") {
        return send(response, 200, wireProject(await loadProject(resolveInside(projectsRoot, safeProjectId(projectMatch[1])))));
      }
      if (projectMatch && request.method === "PUT") {
        const project = projectFromWire(await body(request));
        if (project.id !== projectMatch[1]) throw new Error("프로젝트 ID가 일치하지 않습니다.");
        const operationId = randomUUID();
        if (!lockProject(project.id, operationId)) {
          return send(response, 409, { error: "프로젝트가 다른 작업에서 사용 중입니다." });
        }
        try {
          await saveProject(resolveInside(projectsRoot, safeProjectId(project.id)), project);
          return send(response, 200, wireProject(project));
        } finally {
          unlockProject(project.id, operationId);
        }
      }

      if (request.method === "POST" && url.pathname === "/api/references") {
        const input = await body(request) as { projectId?: unknown; pngBase64?: unknown };
        const projectId = safeProjectId(String(input.projectId ?? ""));
        const root = resolveInside(projectsRoot, projectId);
        await loadProject(root);
        if (typeof input.pngBase64 !== "string") throw new Error("참조 PNG가 필요합니다.");
        const png = Buffer.from(input.pngBase64, "base64");
        decodePng(png);
        const relativePath = `references/${randomUUID()}.png`;
        const path = resolveInside(root, relativePath);
        await mkdir(resolve(path, ".."), { recursive: true });
        await writeFile(path, png);
        return send(response, 201, { path: relativePath });
      }

      if (request.method === "POST" && url.pathname === "/api/imports") {
        const input = await body(request) as { projectId?: unknown; pngBase64?: unknown; request?: SpriteSheetRequest };
        const projectId = safeProjectId(String(input.projectId ?? ""));
        const operationId = randomUUID();
        if (!lockProject(projectId, operationId)) return send(response, 409, { error: "프로젝트가 다른 작업에서 사용 중입니다." });
        try {
          const root = resolveInside(projectsRoot, projectId);
          const project = await loadProject(root);
          if (typeof input.pngBase64 !== "string") throw new Error("가져올 PNG가 필요합니다.");
          const png = Buffer.from(input.pngBase64, "base64");
          const relativePath = `imports/${randomUUID()}/sheet.png`;
          const path = resolveInside(root, relativePath);
          const imported = importSpriteSheet(project, png, input.request as SpriteSheetRequest, relativePath);
          await mkdir(resolve(path, ".."), { recursive: true });
          await writeFile(path, png);
          await saveProject(root, imported);
          return send(response, 200, wireProject(imported));
        } finally {
          unlockProject(projectId, operationId);
        }
      }

      if (request.method === "POST" && url.pathname === "/api/exports") {
        const input = await body(request) as { projectId?: unknown; target?: unknown; options?: unknown };
        const projectId = safeProjectId(String(input.projectId ?? ""));
        const target = String(input.target ?? "") as ExportTarget;
        if (!(["common", "godot", "unity"] as string[]).includes(target)) throw new Error("지원하지 않는 내보내기 대상입니다.");
        const operationId = randomUUID();
        if (!lockProject(projectId, operationId)) return send(response, 409, { error: "프로젝트가 다른 작업에서 사용 중입니다." });
        try {
          const root = resolveInside(projectsRoot, projectId);
          const project = await loadProject(root);
          const options = parseExportOptions(input.options);
          const result = await exportProject(target, project.document, options, resolveInside(root, "exports"));
          project.exportSettings = options;
          await saveProject(root, project);
          return send(response, 201, result);
        } finally {
          unlockProject(projectId, operationId);
        }
      }

      if (request.method === "POST" && url.pathname === "/api/generations") {
        const input = await body(request) as { projectId?: unknown; frameId?: unknown; request?: SpriteSheetRequest };
        const projectId = safeProjectId(String(input.projectId ?? ""));
        const generationRequest = { ...input.request } as SpriteSheetRequest;
        if (input.frameId !== undefined && typeof input.frameId !== "string") throw new Error("프레임 ID는 문자열이어야 합니다.");
        const frameId = input.frameId;
        const jobId = randomUUID();
        if (!lockProject(projectId, jobId)) return send(response, 409, { error: "이미 생성 중인 프로젝트입니다." });
        try {
          const root = resolveInside(projectsRoot, projectId);
          const project = await loadProject(root);
          if (generationRequest.referencePath) {
            const reference = resolveInside(root, generationRequest.referencePath);
            if (!(await stat(reference)).isFile()) throw new Error("참조 이미지를 찾을 수 없습니다.");
            generationRequest.referencePath = reference;
          }
          const relativeOutputPath = `generated/${jobId}/${frameId !== undefined ? "frame.png" : "sheet.png"}`;
          const outputPath = resolveInside(root, relativeOutputPath);
          await mkdir(resolve(outputPath, ".."), { recursive: true });
          let prompt: string;
          let jobRequest: SpriteSheetRequest | FrameRegenerationRequest = generationRequest;
          if (frameId !== undefined) {
            const frameIndex = project.document.frames.findIndex((frame) => frame.id === frameId);
            if (frameIndex < 0) throw new Error("선택한 프레임을 찾을 수 없습니다.");
            const referencePaths: FrameReferencePaths = {
              first: resolveInside(root, `generated/${jobId}/first.png`),
              previous: frameIndex > 0 ? resolveInside(root, `generated/${jobId}/previous.png`) : undefined,
              next: frameIndex < project.document.frames.length - 1 ? resolveInside(root, `generated/${jobId}/next.png`) : undefined,
            };
            const referenceFrames = [
              { path: referencePaths.first, frameId: project.document.frames[0].id },
              ...(referencePaths.previous ? [{ path: referencePaths.previous, frameId: project.document.frames[frameIndex - 1].id }] : []),
              ...(referencePaths.next ? [{ path: referencePaths.next, frameId: project.document.frames[frameIndex + 1].id }] : []),
            ];
            for (const reference of referenceFrames) {
              const image = compositeFrame(project.document, reference.frameId);
              await writeFile(reference.path, encodePng(image.width, image.height, image.data));
            }
            jobRequest = {
              prompt: generationRequest.prompt,
              frameId,
              parentId: generationRequest.parentId,
              referencePath: generationRequest.referencePath,
            };
            prompt = buildFrameRegenerationPrompt(project, jobRequest, referencePaths, outputPath);
          } else {
            prompt = buildSpriteSheetPrompt(generationRequest, outputPath);
          }
          const job: GenerationJob = { id: jobId, kind: "generation", projectId, request: jobRequest, frameId, outputPath, relativeOutputPath, status: "running", messages: [] };
          jobs.set(jobId, job);
          const run = await codex.startGeneration({ cwd: root, prompt });
          connectRun(job, codex, run.id);
          return send(response, 202, wireJob(job));
        } catch (error) {
          jobs.delete(jobId);
          unlockProject(projectId, jobId);
          throw error;
        }
      }

      if (request.method === "POST" && url.pathname === "/api/edits") {
        if (!cellEditCodex) throw new Error("설치된 Codex App Server에서 현재 셀 편집을 사용할 수 없습니다.");
        const input = await body(request) as { projectId?: unknown; request?: unknown };
        const projectId = safeProjectId(String(input.projectId ?? ""));
        const jobId = randomUUID();
        if (!lockProject(projectId, jobId)) return send(response, 409, { error: "이미 Codex 작업 중인 프로젝트입니다." });
        let job: CellEditJob | undefined;
        let initialWritten = false;
        try {
          const root = resolveInside(projectsRoot, projectId);
          const project = await loadProject(root);
          const editRequest = validateAiEditRequest(project, input.request);
          const composite = compositeFrame(project.document, editRequest.target.frameId);
          const celFrame = activeCelFrame(project.document, editRequest.target);
          const targetCel = project.document.cels[celKey(editRequest.target.frameId, editRequest.target.layerId)]!;
          const targetImage = project.document.images[targetCel.imageId]!;
          const { selection, ...settings } = editRequest.settings;
          const log = createCellEditLog(root, jobId);
          job = {
            id: jobId,
            kind: "cellEdit",
            projectId,
            request: editRequest,
            target: editRequest.target,
            phase: "editing",
            attempt: 1,
            maxAttempts: 6,
            log,
            originalProject: project,
            candidate: {
              document: structuredClone(project.document),
              ...structuredClone(settings),
              selection: selectionMask(selection, targetImage, targetCel, project.document),
            },
            attempts: [],
            hadRejectedPixelCandidate: false,
            status: "running",
            messages: [],
          };
          jobs.set(jobId, job);
          await writeCellEditInitial(log, editRequest, { composite, cel: celFrame });
          initialWritten = true;
          await startEditing(job);
          return send(response, 202, wireJob(job));
        } catch (error) {
          if (!job) {
            unlockProject(projectId, jobId);
            throw error;
          }
          await failCellJob(job, error instanceof Error ? error.message : String(error), !initialWritten);
          return send(response, 202, wireJob(job));
        }
      }

      const jobMatch = url.pathname.match(/^\/api\/(generations|edits)\/([0-9a-f-]{36})$/i);
      if (jobMatch && request.method === "GET") {
        const job = jobs.get(jobMatch[2]);
        const expectedKind = jobMatch[1] === "edits" ? "cellEdit" : "generation";
        if (!job || job.kind !== expectedKind) return send(response, 404, { error: "작업을 찾을 수 없습니다." });
        return send(response, 200, wireJob(job));
      }
      if (jobMatch && request.method === "DELETE") {
        const job = jobs.get(jobMatch[2]);
        const expectedKind = jobMatch[1] === "edits" ? "cellEdit" : "generation";
        if (!job?.runId || job.kind !== expectedKind) return send(response, 404, { error: "작업을 찾을 수 없습니다." });
        if (job.status === "finalizing" || (job.kind === "cellEdit" && job.terminalDecision === "finalizing")) {
          return send(response, 409, { error: "이미 적용 준비가 시작되어 취소할 수 없습니다." });
        }
        if (job.kind === "cellEdit" && job.activeRun?.completionClaimed) {
          return send(response, 409, { error: "이미 완료 처리가 시작되어 취소할 수 없습니다." });
        }
        if (job.status !== "running" && job.status !== "awaitingApproval") return send(response, 409, { error: "이미 종료 중이거나 종료된 작업입니다." });
        if (job.kind === "generation" && job.approval) bridgeForJob(job).respond(job.approval.requestId, { decision: "decline" });
        if (job.kind === "generation") job.approval = undefined;
        job.status = "cancelling";
        if (job.kind === "cellEdit") job.terminalDecision = "cancelled";
        await interruptJob(job);
        return send(response, 200, wireJob(job));
      }

      if (request.method === "POST" && url.pathname === "/api/approvals") {
        const input = await body(request) as { jobId?: unknown; accept?: unknown };
        const job = jobs.get(String(input.jobId ?? ""));
        if (!job || job.kind !== "generation" || !job.approval || !job.runId) return send(response, 404, { error: "승인 요청을 찾을 수 없습니다." });
        const approval = job.approval;
        job.approval = undefined;
        if (input.accept === true) {
          job.status = "running";
          bridgeForJob(job).respond(approval.requestId, { decision: "accept" });
        } else {
          job.status = "cancelling";
          bridgeForJob(job).respond(approval.requestId, { decision: "decline" });
          await interruptJob(job);
        }
        return send(response, 200, { status: job.status });
      }

      if (url.pathname.startsWith("/api/")) return send(response, 404, { error: "API 경로를 찾을 수 없습니다." });
      if (!staticRoot) return send(response, 404, { error: "웹앱 빌드를 찾을 수 없습니다." });
      const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      let file = resolveInside(staticRoot, requested);
      try {
        if (!(await stat(file)).isFile()) throw new Error();
      } catch {
        file = resolveInside(staticRoot, "index.html");
      }
      const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" }[extname(file)] ?? "application/octet-stream";
      response.writeHead(200, { "content-type": `${mime}; charset=utf-8` });
      response.end(await readFile(file));
    } catch (error) {
      send(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}
