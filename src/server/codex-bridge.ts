import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

export type RpcMessage = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string };
};

export type JsonlProcess = EventEmitter & {
  stdin: { write(chunk: string): boolean };
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill(): boolean;
};

export type AccountState = {
  account: null | {
    type: string;
    email?: string | null;
    planType?: string | null;
  };
  requiresOpenaiAuth: boolean;
};

export type LoginFlow = {
  type: "chatgpt";
  loginId: string;
  authUrl: string;
};

export type GenerationRequest = {
  cwd: string;
  prompt: string;
};

export type CellEditRunRequest = {
  cwd: string;
  prompt: string;
  originalCompositePath: string;
  originalCelPath: string;
  candidateCompositePath: string;
  candidateCelPath: string;
  outputSchema: unknown;
};

export type GenerationRun = {
  id: string;
  threadId: string;
  turnId: string;
};

export type CodexEvent =
  | { type: "message"; text: string; runId?: string }
  | { type: "result"; runId: string; text: string }
  | { type: "toolAttempt"; runId: string; tool: string }
  | { type: "completed"; runId: string; status: string }
  | { type: "approval"; requestId: number; method: string; params: Record<string, unknown>; runId?: string; threadId?: string }
  | { type: "notification"; method: string; params: Record<string, unknown> }
  | { type: "error"; message: string };

type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

type Skill = { name: string; path: string; enabled: boolean };
const FORBIDDEN_CELL_EDIT_ITEMS = new Set(["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "collabAgentToolCall", "subAgentActivity", "webSearch", "sleep", "imageGeneration"]);
const CELL_EDIT_UNAVAILABLE = "설치된 Codex App Server에서 현재 셀 편집을 사용할 수 없습니다.";
const CELL_EDIT_DISABLED_FEATURES = [
  "shell_tool", "unified_exec", "apps", "browser_use", "browser_use_external", "browser_use_full_cdp_access",
  "computer_use", "goals", "hooks", "image_generation", "memories", "multi_agent", "plugins", "plugin_sharing",
  "remote_plugin", "skill_mcp_dependency_install", "skill_search", "tool_suggest", "view_image", "workspace_dependencies",
] as const;

export const CELL_EDIT_APP_SERVER_ARGS = [
  "--strict-config",
  ...CELL_EDIT_DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]),
  "-c", 'developer_instructions=""',
  "-c", "project_doc_max_bytes=0",
  "-c", 'web_search="disabled"',
  "-c", "tools.web_search=false",
  "-c", "tools.view_image=false",
  "-c", "mcp_servers={}",
] as const;

export const CELL_EDIT_MODEL_SETTINGS = {
  model: "gpt-5.6-sol",
  reasoningEffort: "app-server-default",
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createCodexProcess(extraArgs: readonly string[] = []): JsonlProcess {
  const appServerArgs = ["app-server", "--listen", "stdio://", ...extraArgs];
  const command = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "codex";
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", ["codex", ...appServerArgs].join(" ")]
    : appServerArgs;
  return spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  }) as JsonlProcess;
}

export class CodexBridge extends EventEmitter {
  private process?: JsonlProcess;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly runs = new Map<string, GenerationRun>();

  constructor(private readonly processFactory: () => JsonlProcess = createCodexProcess) {
    super();
  }

  async start(): Promise<void> {
    if (this.process) return;
    this.process = this.processFactory();
    this.process.stdout.on("data", (chunk: Buffer | string) => this.consume(String(chunk)));
    this.process.stderr.on("data", (chunk: Buffer | string) => {
      const message = String(chunk).trim();
      if (message) this.emitEvent({ type: "notification", method: "stderr", params: { message } });
    });
    this.process.on("exit", () => this.disconnect("Codex App Server가 종료되었습니다."));
    this.process.on("error", (error: Error) => this.disconnect(`Codex App Server를 시작할 수 없습니다: ${error.message}`));

    await this.request("initialize", {
      clientInfo: { name: "pixelforge", title: "PixelForge", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.notify("initialized", {});
  }

  async getAccount(): Promise<AccountState> {
    return this.request<AccountState>("account/read", { refreshToken: false });
  }

  async login(): Promise<LoginFlow> {
    return this.request<LoginFlow>("account/login/start", {
      type: "chatgpt",
      useHostedLoginSuccessPage: true,
      appBrand: "chatgpt",
    });
  }

  async startGeneration(request: GenerationRequest): Promise<GenerationRun> {
    await this.requireChatGptAccount();
    const skill = await this.imagegenSkill(request.cwd);
    const thread = await this.request<{ thread: { id: string } }>("thread/start", {
      cwd: request.cwd,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      serviceName: "pixelforge",
    });
    const turn = await this.request<{ turn: { id: string } }>("turn/start", {
      threadId: thread.thread.id,
      input: [
        { type: "text", text: `$imagegen ${request.prompt}` },
        { type: "skill", name: skill.name, path: skill.path },
      ],
    });
    const run = { id: turn.turn.id, threadId: thread.thread.id, turnId: turn.turn.id };
    this.runs.set(run.id, run);
    return run;
  }

  async startCellEdit(request: CellEditRunRequest): Promise<GenerationRun> {
    return this.startCellImageRun(request, "편집 에이전트 역할입니다. 제공된 원본과 현재 후보를 기존 픽셀 도구 동작으로 수정하고 JSON만 반환하세요.");
  }

  async startCellEditJudgment(request: CellEditRunRequest): Promise<GenerationRun> {
    return this.startCellImageRun(request, "독립 판정 에이전트 역할입니다. 제공된 원본과 후보만 고정 기준으로 비교하고 판정 JSON만 반환하세요.");
  }

  private async startCellImageRun(request: CellEditRunRequest, developerInstructions: string): Promise<GenerationRun> {
    await this.requireChatGptAccount();
    await this.verifyCellEditRestrictions();
    try {
      const thread = await this.request<{ thread: { id: string } }>("thread/start", {
        developerInstructions,
        dynamicTools: [],
      });
      const turn = await this.request<{ turn: { id: string } }>("turn/start", {
        threadId: thread.thread.id,
        model: CELL_EDIT_MODEL_SETTINGS.model,
        cwd: request.cwd,
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        input: [
          { type: "text", text: request.prompt, text_elements: [] },
          { type: "localImage", path: request.originalCompositePath },
          { type: "localImage", path: request.originalCelPath },
          { type: "localImage", path: request.candidateCompositePath },
          { type: "localImage", path: request.candidateCelPath },
        ],
        outputSchema: request.outputSchema,
      });
      const run = { id: turn.turn.id, threadId: thread.thread.id, turnId: turn.turn.id };
      this.runs.set(run.id, run);
      return run;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code === -32601 || code === -32602) throw new Error(CELL_EDIT_UNAVAILABLE);
      throw error;
    }
  }

  private async verifyCellEditRestrictions(): Promise<void> {
    try {
      const { config } = await this.request<{ config: unknown }>("config/read", {});
      if (!isRecord(config) || !isRecord(config.features)
        || CELL_EDIT_DISABLED_FEATURES.some((feature) => config.features[feature] !== false)
        || config.developer_instructions !== ""
        || config.project_doc_max_bytes !== 0
        || config.web_search !== "disabled"
        || !isRecord(config.tools)
        || config.tools.web_search !== false
        || config.tools.view_image !== false
        || !isRecord(config.mcp_servers)
        || Object.keys(config.mcp_servers).length > 0) throw new Error(CELL_EDIT_UNAVAILABLE);

      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await this.request<{ data: unknown; nextCursor: unknown }>("mcpServerStatus/list", {
          detail: "toolsAndAuthOnly",
          ...(cursor ? { cursor } : {}),
        });
        const nextCursor = page.nextCursor;
        if (!Array.isArray(page.data) || page.data.length > 0
          || (nextCursor !== null && (typeof nextCursor !== "string" || !nextCursor))) {
          throw new Error(CELL_EDIT_UNAVAILABLE);
        }
        if (typeof nextCursor === "string" && seenCursors.has(nextCursor)) throw new Error(CELL_EDIT_UNAVAILABLE);
        cursor = typeof nextCursor === "string" ? nextCursor : undefined;
        if (cursor) seenCursors.add(cursor);
      } while (cursor);

      const installed = await this.request<{ apps: unknown }>("app/installed", { forceRefresh: true });
      if (!Array.isArray(installed.apps) || installed.apps.some((app) => !isRecord(app) || app.callable === true)) {
        throw new Error(CELL_EDIT_UNAVAILABLE);
      }
    } catch {
      throw new Error(CELL_EDIT_UNAVAILABLE);
    }
  }

  async interrupt(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) throw new Error("실행 중인 생성 작업을 찾을 수 없습니다.");
    await this.request("turn/interrupt", { threadId: run.threadId, turnId: run.turnId });
  }

  respond(requestId: number, result: unknown): void {
    this.write({ id: requestId, result });
  }

  close(): void {
    this.process?.kill();
    this.process = undefined;
    this.failPending("Codex 연결이 닫혔습니다.");
  }

  private async requireChatGptAccount(): Promise<void> {
    const account = await this.getAccount();
    if (account.account?.type !== "chatgpt") throw new Error("개인 구독을 사용하려면 ChatGPT 로그인이 필요합니다.");
  }

  private async imagegenSkill(cwd: string): Promise<Skill> {
    const result = await this.request<{ data: Array<{ cwd: string; skills: Skill[] }> }>("skills/list", {
      cwds: [cwd],
      forceReload: false,
    });
    const skill = result.data.flatMap((entry) => entry.skills).find((candidate) => candidate.name === "imagegen" && candidate.enabled);
    if (!skill?.path) throw new Error("활성화된 imagegen 스킬을 찾을 수 없습니다.");
    return skill;
  }

  private request<T = Record<string, never>>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 요청 시간이 초과되었습니다.`));
      }, 60_000);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.write({ method, params });
  }

  private write(message: RpcMessage): void {
    if (!this.process) throw new Error("Codex App Server가 시작되지 않았습니다.");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) {
        try {
          this.handle(JSON.parse(line) as RpcMessage);
        } catch (error) {
          this.emitEvent({ type: "error", message: `Codex 응답을 읽을 수 없습니다: ${error instanceof Error ? error.message : String(error)}` });
        }
      }
      newline = this.buffer.indexOf("\n");
    }
  }

  private handle(message: RpcMessage): void {
    if (message.id !== undefined && ("result" in message || message.error)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        const error = new Error(message.error.message ?? "Codex 요청에 실패했습니다.") as Error & { code?: number };
        error.code = message.error.code;
        pending.reject(error);
      }
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      const params = message.params ?? {};
      this.emitEvent({
        type: "approval",
        requestId: message.id,
        method: message.method,
        params,
        runId: typeof params.turnId === "string" ? params.turnId : undefined,
        threadId: typeof params.threadId === "string" ? params.threadId : undefined,
      });
      return;
    }
    if (!message.method) return;
    const params = message.params ?? {};
    if (message.method === "item/agentMessage/delta") {
      this.emitEvent({ type: "message", text: String(params.delta ?? ""), runId: typeof params.turnId === "string" ? params.turnId : undefined });
      return;
    }
    if (message.method === "item/completed") {
      const item = params.item as { type?: string; text?: string; phase?: string | null } | undefined;
      if (item?.type === "agentMessage" && item.phase !== "commentary" && typeof item.text === "string" && typeof params.turnId === "string") {
        this.emitEvent({ type: "result", runId: params.turnId, text: item.text });
      }
      return;
    }
    if (message.method === "item/started") {
      const item = params.item as { type?: string } | undefined;
      if (item?.type && FORBIDDEN_CELL_EDIT_ITEMS.has(item.type) && typeof params.turnId === "string") {
        this.emitEvent({ type: "toolAttempt", runId: params.turnId, tool: item.type });
      }
      return;
    }
    if (message.method === "turn/completed") {
      const turn = params.turn as { id?: string; status?: string } | undefined;
      if (turn?.id) {
        this.emitEvent({ type: "completed", runId: turn.id, status: turn.status ?? "completed" });
        this.runs.delete(turn.id);
        return;
      }
    }
    this.emitEvent({ type: "notification", method: message.method, params });
  }

  private emitEvent(event: CodexEvent): void {
    this.emit("event", event);
  }

  private failPending(message: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pending.clear();
    this.emitEvent({ type: "error", message });
  }

  private disconnect(message: string): void {
    this.process = undefined;
    this.failPending(message);
  }
}
