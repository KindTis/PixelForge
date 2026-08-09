import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { createDocument, createProject as makeProject, validateDocument } from "../core/document.ts";
import { compositeFrame } from "../core/render.ts";
import type { PixelBuffer, SpriteProject } from "../core/types.ts";
import type { AccountState, CodexBridge, CodexEvent } from "./codex-bridge.ts";
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

type CodexClient = Pick<CodexBridge, "getAccount" | "login" | "startGeneration" | "interrupt" | "respond"> & {
  on(event: "event", listener: (event: CodexEvent) => void): unknown;
};

type Job = {
  id: string;
  projectId: string;
  request: SpriteSheetRequest | FrameRegenerationRequest;
  frameId?: string;
  outputPath: string;
  relativeOutputPath: string;
  runId?: string;
  status: "running" | "awaitingApproval" | "cancelling" | "finalizing" | "completed" | "failed" | "cancelled";
  messages: string[];
  approval?: { requestId: number; method: string; params: Record<string, unknown> };
  error?: string;
  project?: SpriteProject;
};

export type ServerOptions = {
  projectsRoot: string;
  codex: CodexClient;
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

export function createPixelForgeServer({ projectsRoot, codex, staticRoot }: ServerOptions) {
  const token = randomBytes(24).toString("base64url");
  const jobs = new Map<string, Job>();
  const runToJob = new Map<string, string>();
  const earlyCompletions = new Map<string, string>();
  const earlyApprovals = new Map<string, NonNullable<Job["approval"]>>();
  const projectLocks = new Map<string, string>();

  const lockProject = (projectId: string, owner: string): boolean => {
    if (projectLocks.has(projectId)) return false;
    projectLocks.set(projectId, owner);
    return true;
  };

  const unlockProject = (projectId: string, owner: string): void => {
    if (projectLocks.get(projectId) === owner) projectLocks.delete(projectId);
  };

  const applyApproval = (job: Job, approval: NonNullable<Job["approval"]>): boolean => {
    if (job.status !== "running") return false;
    job.status = "awaitingApproval";
    job.approval = approval;
    return true;
  };

  const interruptJob = async (job: Job): Promise<void> => {
    try {
      await codex.interrupt(job.runId!);
      job.status = "cancelled";
    } catch (error) {
      job.status = "failed";
      job.error = `Codex 생성 취소에 실패했습니다: ${error instanceof Error ? error.message : String(error)}`;
      throw error;
    } finally {
      unlockProject(job.projectId, job.id);
    }
  };

  const finish = async (runId: string, status: string): Promise<void> => {
    const jobId = runToJob.get(runId);
    if (!jobId) {
      earlyCompletions.set(runId, status);
      return;
    }
    const job = jobs.get(jobId);
    if (!job || (job.status !== "running" && job.status !== "awaitingApproval")) return;
    if (status !== "completed") {
      job.status = "failed";
      job.error = `Codex 생성이 ${status} 상태로 끝났습니다.`;
      unlockProject(job.projectId, job.id);
      return;
    }
    job.status = "finalizing";
    try {
      const root = resolveInside(projectsRoot, safeProjectId(job.projectId));
      const project = await loadProject(root);
      const png = await readFile(job.outputPath);
      job.project = job.frameId !== undefined
        ? importRegeneratedFrame(project, png, job.request as FrameRegenerationRequest, job.relativeOutputPath)
        : importSpriteSheet(project, png, job.request as SpriteSheetRequest, job.relativeOutputPath);
      await saveProject(root, job.project);
      job.status = "completed";
    } catch (error) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
    } finally {
      unlockProject(job.projectId, job.id);
    }
  };

  codex.on("event", (event: CodexEvent) => {
    if (event.type === "completed") void finish(event.runId, event.status);
    else if (event.type === "message") {
      const job = event.runId ? jobs.get(runToJob.get(event.runId) ?? "") : undefined;
      if (job && event.text.trim()) job.messages.push(event.text);
    } else if (event.type === "approval") {
      const approval = { requestId: event.requestId, method: event.method, params: event.params };
      const jobId = event.runId ? runToJob.get(event.runId) : undefined;
      const job = jobId ? jobs.get(jobId) : undefined;
      if (job) {
        if (!applyApproval(job, approval)) codex.respond(event.requestId, { decision: "decline" });
      } else if (event.runId) earlyApprovals.set(event.runId, approval);
      else codex.respond(event.requestId, { decision: "decline" });
    } else if (event.type === "error") {
      for (const job of jobs.values()) if (job.status === "running" || job.status === "awaitingApproval" || job.status === "cancelling") {
        job.status = "failed";
        job.approval = undefined;
        job.error = event.message;
        unlockProject(job.projectId, job.id);
      }
    }
  });

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
          const job: Job = { id: jobId, projectId, request: jobRequest, frameId, outputPath, relativeOutputPath, status: "running", messages: [] };
          jobs.set(jobId, job);
          const run = await codex.startGeneration({ cwd: root, prompt });
          job.runId = run.id;
          runToJob.set(run.id, jobId);
          const earlyApproval = earlyApprovals.get(run.id);
          if (earlyApproval) {
            earlyApprovals.delete(run.id);
            applyApproval(job, earlyApproval);
          }
          const early = earlyCompletions.get(run.id);
          if (early) {
            earlyCompletions.delete(run.id);
            void finish(run.id, early);
          }
          return send(response, 202, { id: jobId, status: job.status, frameId });
        } catch (error) {
          jobs.delete(jobId);
          unlockProject(projectId, jobId);
          throw error;
        }
      }

      const generationMatch = url.pathname.match(/^\/api\/generations\/([0-9a-f-]{36})$/i);
      if (generationMatch && request.method === "GET") {
        const job = jobs.get(generationMatch[1]);
        if (!job) return send(response, 404, { error: "생성 작업을 찾을 수 없습니다." });
        return send(response, 200, { ...job, outputPath: undefined, project: job.project ? wireProject(job.project) : undefined });
      }
      if (generationMatch && request.method === "DELETE") {
        const job = jobs.get(generationMatch[1]);
        if (!job?.runId) return send(response, 404, { error: "생성 작업을 찾을 수 없습니다." });
        if (job.status !== "running" && job.status !== "awaitingApproval") return send(response, 409, { error: "이미 종료 중이거나 종료된 생성 작업입니다." });
        if (job.approval) codex.respond(job.approval.requestId, { decision: "decline" });
        job.approval = undefined;
        job.status = "cancelling";
        await interruptJob(job);
        return send(response, 200, { status: job.status });
      }

      if (request.method === "POST" && url.pathname === "/api/approvals") {
        const input = await body(request) as { jobId?: unknown; accept?: unknown };
        const job = jobs.get(String(input.jobId ?? ""));
        if (!job?.approval || !job.runId) return send(response, 404, { error: "승인 요청을 찾을 수 없습니다." });
        const approval = job.approval;
        job.approval = undefined;
        if (input.accept === true) {
          job.status = "running";
          codex.respond(approval.requestId, { decision: "accept" });
        } else {
          job.status = "cancelling";
          codex.respond(approval.requestId, { decision: "decline" });
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
