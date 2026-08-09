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

export type GenerationRun = {
  id: string;
  threadId: string;
  turnId: string;
};

export type CodexEvent =
  | { type: "message"; text: string; runId?: string }
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

function defaultProcessFactory(): JsonlProcess {
  const command = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "codex";
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", "codex app-server --listen stdio://"]
    : ["app-server", "--listen", "stdio://"];
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

  constructor(private readonly processFactory: () => JsonlProcess = defaultProcessFactory) {
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
    const account = await this.getAccount();
    if (account.account?.type !== "chatgpt") {
      throw new Error("개인 구독을 사용하려면 ChatGPT 로그인이 필요합니다.");
    }
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
      if (message.error) pending.reject(new Error(message.error.message ?? "Codex 요청에 실패했습니다."));
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
