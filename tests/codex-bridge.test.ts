import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { AI_EDIT_OUTPUT_SCHEMA, AI_EDIT_VERDICT_OUTPUT_SCHEMA } from "../src/core/ai-edit.ts";
import {
  CELL_EDIT_APP_SERVER_ARGS,
  CELL_EDIT_MODEL_SETTINGS,
  CodexBridge,
  cellEditAppServerArgs,
  type CellEditRunRequest,
  type JsonlProcess,
  type RpcMessage,
} from "../src/server/codex-bridge.ts";

const disabledCellEditFeatures = [
  "shell_tool", "unified_exec", "apps", "browser_use", "browser_use_external", "browser_use_full_cdp_access",
  "computer_use", "goals", "hooks", "image_generation", "memories", "multi_agent", "plugins", "plugin_sharing",
  "remote_plugin", "skill_mcp_dependency_install", "skill_search", "tool_suggest", "view_image", "workspace_dependencies",
] as const;

type RestrictedConfig = {
  features: Record<string, boolean>;
  developer_instructions: string;
  project_doc_max_bytes: number;
  web_search: string;
  tools: { web_search: boolean | null; view_image: boolean };
  mcp_servers: Record<string, unknown>;
};

function restrictedConfig(): RestrictedConfig {
  return {
    features: Object.fromEntries(disabledCellEditFeatures.map((feature) => [feature, false])),
    developer_instructions: "",
    project_doc_max_bytes: 0,
    web_search: "disabled",
    tools: { web_search: false, view_image: false },
    mcp_servers: {},
  };
}

class FakeProcess extends EventEmitter implements JsonlProcess {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly messages: RpcMessage[] = [];
  responder?: (message: RpcMessage) => RpcMessage | undefined;
  killed = false;
  private threadNumber = 0;
  private turnNumber = 0;
  readonly stdin = {
    write: (chunk: string) => {
      for (const line of chunk.trim().split("\n")) {
        const message = JSON.parse(line) as RpcMessage;
        this.messages.push(message);
        const response = this.responder?.(message) ?? this.defaultResponse(message);
        if (response) queueMicrotask(() => this.respond(response));
      }
      return true;
    },
  };

  private defaultResponse(message: RpcMessage): RpcMessage | undefined {
    if (message.method === "account/read") return { id: message.id, result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true } };
    if (message.method === "config/read") return { id: message.id, result: { config: restrictedConfig() } };
    if (message.method === "mcpServerStatus/list") return { id: message.id, result: { data: [], nextCursor: null } };
    if (message.method === "app/installed") return { id: message.id, result: { apps: [] } };
    if (message.method === "thread/start") return { id: message.id, result: { thread: { id: `thread-${++this.threadNumber}` } } };
    if (message.method === "turn/start") return { id: message.id, result: { turn: { id: `turn-${++this.turnNumber}` } } };
    return undefined;
  }

  respond(message: RpcMessage, split = false) {
    const line = `${JSON.stringify(message)}\n`;
    if (split) {
      const middle = Math.floor(line.length / 2);
      this.stdout.emit("data", Buffer.from(line.slice(0, middle)));
      this.stdout.emit("data", Buffer.from(line.slice(middle)));
    } else {
      this.stdout.emit("data", Buffer.from(line));
    }
  }

  kill() {
    this.killed = true;
    return true;
  }
}

async function waitForMessage(process: FakeProcess, index: number): Promise<RpcMessage> {
  while (!process.messages[index]) await new Promise<void>((resolve) => setImmediate(resolve));
  return process.messages[index];
}

async function startedBridge(process: FakeProcess): Promise<CodexBridge> {
  const bridge = new CodexBridge(() => process);
  const starting = bridge.start();
  const initialize = await waitForMessage(process, 0);
  process.respond({ id: initialize.id, result: { userAgent: "codex-test" } }, true);
  await starting;
  return bridge;
}

const cellEditRequest: CellEditRunRequest = {
  cwd: "C:/project/tmp/run",
  prompt: "현재 셀을 편집하세요.",
  originalCompositePath: "C:/project/tmp/run/original-composite.png",
  originalCelPath: "C:/project/tmp/run/original-cel.png",
  candidateCompositePath: "C:/project/tmp/run/candidate-composite.png",
  candidateCelPath: "C:/project/tmp/run/candidate-cel.png",
  outputSchema: AI_EDIT_OUTPUT_SCHEMA,
};

test("분할된 JSONL 초기화 응답을 조립하고 initialized를 보낸다", async () => {
  const process = new FakeProcess();
  await startedBridge(process);

  assert.equal(process.messages[0].method, "initialize");
  assert.deepEqual(process.messages[0].params, {
    clientInfo: { name: "pixelforge", title: "PixelForge", version: "0.1.0" },
    capabilities: { experimentalApi: true, requestAttestation: false },
  });
  assert.equal(process.messages[1].method, "initialized");
});

test("App Server 시작 실패 뒤 요청은 즉시 실패한다", async () => {
  const process = new FakeProcess();
  const bridge = new CodexBridge(() => process);
  const starting = bridge.start();
  await waitForMessage(process, 0);
  process.emit("error", new Error("ENOENT"));

  await assert.rejects(starting, /시작할 수 없습니다/);
  const account = bridge.getAccount();
  const messageCount = process.messages.length;
  bridge.close();
  await assert.rejects(account);
  assert.equal(messageCount, 1);
});

test("ChatGPT 브라우저 로그인만 시작한다", async () => {
  const process = new FakeProcess();
  const bridge = await startedBridge(process);
  const login = bridge.login();
  const request = await waitForMessage(process, 2);
  assert.deepEqual(request.params, { type: "chatgpt", useHostedLoginSuccessPage: true, appBrand: "chatgpt" });
  process.respond({ id: request.id, result: { type: "chatgpt", loginId: "login-1", authUrl: "https://chatgpt.com/login" } });
  assert.equal((await login).authUrl, "https://chatgpt.com/login");
});

test("API 키 계정에서는 생성하지 않는다", async () => {
  const process = new FakeProcess();
  const bridge = await startedBridge(process);
  process.responder = (message) => message.method === "account/read"
    ? { id: message.id, result: { account: { type: "apiKey" }, requiresOpenaiAuth: true } }
    : undefined;

  await assert.rejects(bridge.startGeneration({ cwd: "C:/project", prompt: "공격" }), /ChatGPT 로그인/);
});

test("imagegen 스킬로 스레드와 턴을 시작하고 중단한다", async () => {
  const process = new FakeProcess();
  const bridge = await startedBridge(process);
  const events: unknown[] = [];
  bridge.on("event", (event) => events.push(event));
  process.responder = (message) => {
    if (message.method === "account/read") return { id: message.id, result: { account: { type: "chatgpt", email: "u@example.com", planType: "plus" }, requiresOpenaiAuth: true } };
    if (message.method === "skills/list") return { id: message.id, result: { data: [{ cwd: "C:/project", skills: [{ name: "imagegen", path: "C:/skills/imagegen/SKILL.md", enabled: true }] }] } };
    if (message.method === "thread/start") return { id: message.id, result: { thread: { id: "thread-1", sessionId: "thread-1" } } };
    if (message.method === "turn/start") {
      queueMicrotask(() => process.respond({ id: 99, method: "item/fileChange/requestApproval", params: { threadId: "thread-1", turnId: "turn-1" } }));
      return { id: message.id, result: { turn: { id: "turn-1", status: "inProgress", items: [], error: null } } };
    }
    if (message.method === "turn/interrupt") return { id: message.id, result: {} };
    return undefined;
  };

  const run = await bridge.startGeneration({ cwd: "C:/project", prompt: "8프레임 검 공격" });
  assert.deepEqual(run, { id: "turn-1", threadId: "thread-1", turnId: "turn-1" });
  const thread = process.messages.find((message) => message.method === "thread/start")!;
  assert.deepEqual(thread.params, {
    cwd: "C:/project",
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    serviceName: "pixelforge",
  });
  const turn = process.messages.find((message) => message.method === "turn/start")!;
  assert.deepEqual(turn.params, {
    threadId: "thread-1",
    input: [
      { type: "text", text: "$imagegen 8프레임 검 공격" },
      { type: "skill", name: "imagegen", path: "C:/skills/imagegen/SKILL.md" },
    ],
  });
  assert.deepEqual(events, [{ type: "approval", requestId: 99, method: "item/fileChange/requestApproval", params: { threadId: "thread-1", turnId: "turn-1" }, runId: "turn-1", threadId: "thread-1" }]);

  await bridge.interrupt(run.id);
  assert.deepEqual(process.messages.at(-1)?.params, { threadId: "thread-1", turnId: "turn-1" });
});

test("알림을 UI 이벤트로 정규화한다", async () => {
  const process = new FakeProcess();
  const bridge = await startedBridge(process);
  const events: unknown[] = [];
  bridge.on("event", (event) => events.push(event));

  process.respond({ method: "item/agentMessage/delta", params: { threadId: "t", turnId: "r", itemId: "i", delta: "생성 중" } });
  process.respond({ method: "turn/completed", params: { threadId: "t", turn: { id: "r", status: "completed" } } });

  assert.deepEqual(events, [
    { type: "message", text: "생성 중", runId: "r" },
    { type: "completed", runId: "r", status: "completed" },
  ]);
});

test("셀 편집은 제한 설정을 검사한 뒤 도구 없는 읽기 전용 구조화 턴을 시작한다", async () => {
  const process = new FakeProcess();
  const bridge = await startedBridge(process);
  const run = await bridge.startCellEdit(cellEditRequest);

  assert.deepEqual(run, { id: "turn-1", threadId: "thread-1", turnId: "turn-1" });
  assert.deepEqual(process.messages.map(({ method }) => method).filter(Boolean), [
    "initialize", "initialized", "account/read", "config/read", "mcpServerStatus/list", "app/installed", "thread/start", "turn/start",
  ]);
  assert.deepEqual(CELL_EDIT_APP_SERVER_ARGS, [
    "--disable", "shell_tool",
    "--disable", "unified_exec",
    "--disable", "apps",
    "--disable", "browser_use",
    "--disable", "browser_use_external",
    "--disable", "browser_use_full_cdp_access",
    "--disable", "computer_use",
    "--disable", "goals",
    "--disable", "hooks",
    "--disable", "image_generation",
    "--disable", "memories",
    "--disable", "multi_agent",
    "--disable", "plugins",
    "--disable", "plugin_sharing",
    "--disable", "remote_plugin",
    "--disable", "skill_mcp_dependency_install",
    "--disable", "skill_search",
    "--disable", "tool_suggest",
    "--disable", "view_image",
    "--disable", "workspace_dependencies",
    "-c", 'developer_instructions=""',
    "-c", "project_doc_max_bytes=0",
    "-c", 'web_search="disabled"',
    "-c", "tools.web_search=false",
  ]);
  assert.deepEqual(process.messages.find(({ method }) => method === "config/read")?.params, {});
  assert.deepEqual(process.messages.find(({ method }) => method === "mcpServerStatus/list")?.params, { detail: "toolsAndAuthOnly" });
  assert.deepEqual(process.messages.find(({ method }) => method === "app/installed")?.params, { forceRefresh: true });
  const thread = process.messages.find((message) => message.method === "thread/start")!;
  assert.deepEqual(thread.params, {
    developerInstructions: "편집 에이전트 역할입니다. 제공된 원본과 현재 후보를 기존 픽셀 도구 동작으로 수정하고 JSON만 반환하세요.",
    dynamicTools: [],
  });
  const turn = process.messages.find((message) => message.method === "turn/start")!;
  assert.deepEqual(turn.params, {
    threadId: "thread-1",
    model: CELL_EDIT_MODEL_SETTINGS.model,
    cwd: cellEditRequest.cwd,
    approvalPolicy: "never",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
    input: [
      { type: "text", text: "현재 셀을 편집하세요.", text_elements: [] },
      { type: "localImage", path: cellEditRequest.originalCompositePath },
      { type: "localImage", path: cellEditRequest.originalCelPath },
      { type: "localImage", path: cellEditRequest.candidateCompositePath },
      { type: "localImage", path: cellEditRequest.candidateCelPath },
    ],
    outputSchema: AI_EDIT_OUTPUT_SCHEMA,
  });
  assert.equal("effort" in turn.params!, false);
});

test("안정판 Codex 설정에 tools.view_image가 없어도 비활성 기능을 검사해 셀 편집을 시작한다", async () => {
  const process = new FakeProcess();
  const bridge = await startedBridge(process);
  process.responder = (message) => {
    if (message.method !== "config/read") return undefined;
    const config = restrictedConfig();
    delete (config.tools as Partial<RestrictedConfig["tools"]>).view_image;
    return { id: message.id, result: { config } };
  };

  await bridge.startCellEdit(cellEditRequest);

  assert.equal(process.messages.some(({ method }) => method === "thread/start"), true);
});

test("안정판 Codex의 비활성 MCP 상태와 null 웹 검색 설정으로 셀 편집을 시작한다", async () => {
  const process = new FakeProcess();
  const bridge = await startedBridge(process);
  process.responder = (message) => {
    if (message.method === "config/read") {
      const config = restrictedConfig();
      config.tools.web_search = null;
      config.mcp_servers.example = { enabled: false };
      return { id: message.id, result: { config } };
    }
    if (message.method === "mcpServerStatus/list") return {
      id: message.id,
      result: {
        data: [{ name: "example", serverInfo: null, tools: {}, resources: [], resourceTemplates: [], authStatus: "unsupported" }],
        nextCursor: null,
      },
    };
    return undefined;
  };

  await bridge.startCellEdit(cellEditRequest);

  assert.equal(process.messages.some(({ method }) => method === "thread/start"), true);
});

test("설정된 MCP를 제한 프로세스에서 비활성화하고 안전하지 않은 이름은 거부한다", async () => {
  const process = new FakeProcess();
  const bridge = await startedBridge(process);
  process.responder = (message) => message.method === "config/read"
    ? { id: message.id, result: { config: { mcp_servers: { notion: {}, node_repl: {} } } } }
    : undefined;

  const names = await bridge.configuredMcpServerNames();

  assert.deepEqual(cellEditAppServerArgs(names).slice(-4), [
    "-c", "mcp_servers.notion.enabled=false",
    "-c", "mcp_servers.node_repl.enabled=false",
  ]);
  assert.throws(() => cellEditAppServerArgs(["unsafe.name"]), /셀 편집을 사용할 수 없습니다/);
});

test("셀 편집과 독립 판정은 새 스레드에서 같은 모델의 기본 추론 설정을 사용한다", async () => {
  const process = new FakeProcess();
  const bridge = await startedBridge(process);

  const edit = await bridge.startCellEdit(cellEditRequest);
  const judgment = await bridge.startCellEditJudgment({ ...cellEditRequest, outputSchema: AI_EDIT_VERDICT_OUTPUT_SCHEMA });
  assert.notEqual(edit.threadId, judgment.threadId);

  const threads = process.messages.filter(({ method }) => method === "thread/start");
  assert.equal(threads.length, 2);
  assert.notEqual(threads[0].params?.developerInstructions, threads[1].params?.developerInstructions);
  assert.deepEqual(threads[0].params?.dynamicTools, []);

  const turns = process.messages.filter(({ method }) => method === "turn/start");
  assert.equal(turns[0].params?.model, "gpt-5.6-sol");
  assert.equal(turns[1].params?.model, "gpt-5.6-sol");
  assert.equal("effort" in turns[0].params!, false);
  assert.equal("effort" in turns[1].params!, false);
  assert.equal(turns[0].params?.cwd, cellEditRequest.cwd);
  assert.equal(turns[0].params?.approvalPolicy, "never");
  assert.deepEqual(turns[0].params?.sandboxPolicy, { type: "readOnly", networkAccess: false });
  assert.deepEqual((turns[1].params?.input as unknown[]).slice(1), [
    { type: "localImage", path: cellEditRequest.originalCompositePath },
    { type: "localImage", path: cellEditRequest.originalCelPath },
    { type: "localImage", path: cellEditRequest.candidateCompositePath },
    { type: "localImage", path: cellEditRequest.candidateCelPath },
  ]);
});

test("셀 편집은 MCP 상태의 모든 빈 페이지를 검사한다", async () => {
  const process = new FakeProcess();
  const bridge = await startedBridge(process);
  process.responder = (message) => message.method === "mcpServerStatus/list"
    ? { id: message.id, result: message.params?.cursor ? { data: [], nextCursor: null } : { data: [], nextCursor: "next" } }
    : undefined;

  await bridge.startCellEdit(cellEditRequest);
  const pages = process.messages.filter(({ method }) => method === "mcpServerStatus/list");
  assert.deepEqual(pages.map(({ params }) => params), [
    { detail: "toolsAndAuthOnly" },
    { detail: "toolsAndAuthOnly", cursor: "next" },
  ]);
});

test("셀 편집은 반복된 MCP 페이지 cursor를 즉시 기능 불가로 거부한다", async () => {
  const process = new FakeProcess();
  const bridge = await startedBridge(process);
  let pageCount = 0;
  process.responder = (message) => {
    if (message.method !== "mcpServerStatus/list") return undefined;
    pageCount += 1;
    return { id: message.id, result: { data: [], nextCursor: pageCount < 3 ? "same" : null } };
  };

  await assert.rejects(bridge.startCellEdit(cellEditRequest), /설치된 Codex App Server에서 현재 셀 편집을 사용할 수 없습니다/);
  assert.equal(pageCount, 2);
  assert.equal(process.messages.some(({ method }) => method === "thread/start"), false);
});

test("셀 편집 사전 검사가 불완전하거나 제한 설정이 다르면 thread 시작 전에 거부한다", async () => {
  const configCase = (name: string, mutate: (config: RestrictedConfig) => void) => ({
    name,
    responder(message: RpcMessage): RpcMessage | undefined {
      if (message.method !== "config/read") return undefined;
      const config = restrictedConfig();
      mutate(config);
      return { id: message.id, result: { config } };
    },
  });
  const cases = [
    ...disabledCellEditFeatures.map((feature) => configCase(`${feature} 활성`, (config) => { config.features[feature] = true; })),
    configCase("개발자 지시 허용", (config) => { config.developer_instructions = "추가 지시"; }),
    configCase("프로젝트 지시 허용", (config) => { config.project_doc_max_bytes = 1; }),
    configCase("웹 검색 활성", (config) => { config.web_search = "live"; }),
    configCase("도구 웹 검색 활성", (config) => { config.tools.web_search = true; }),
    configCase("이미지 보기 활성", (config) => { config.tools.view_image = true; }),
    configCase("활성 MCP 설정 존재", (config) => { config.mcp_servers.example = { enabled: true }; }),
    {
      name: "설정 응답 누락",
      responder: (message: RpcMessage) => message.method === "config/read" ? { id: message.id, result: { config: {} } } : undefined,
    },
    {
      name: "실행 중 MCP 존재",
      responder: (message: RpcMessage) => message.method === "mcpServerStatus/list"
        ? { id: message.id, result: { data: [{ name: "example", serverInfo: { name: "example" }, tools: { tool: {} }, resources: [], resourceTemplates: [], authStatus: "unsupported" }], nextCursor: null } }
        : undefined,
    },
    {
      name: "호출 가능한 앱 존재",
      responder: (message: RpcMessage) => message.method === "app/installed"
        ? { id: message.id, result: { apps: [{ id: "example", callable: true }] } }
        : undefined,
    },
    ...["config/read", "mcpServerStatus/list", "app/installed"].flatMap((method) => [-32601, -32602].map((code) => ({
      name: `${method} ${code}`,
      responder: (message: RpcMessage) => message.method === method ? { id: message.id, error: { code, message: "unsupported" } } : undefined,
    }))),
  ];

  for (const failure of cases) {
    const process = new FakeProcess();
    const bridge = await startedBridge(process);
    process.responder = failure.responder;
    await assert.rejects(bridge.startCellEdit(cellEditRequest), /설치된 Codex App Server에서 현재 셀 편집을 사용할 수 없습니다/, failure.name);
    assert.equal(process.messages.some(({ method }) => method === "thread/start"), false, failure.name);
    bridge.close();
  }
});

test("셀 편집 최종 메시지와 금지 도구 시작을 별도 이벤트로 정규화한다", async () => {
  const process = new FakeProcess();
  const bridge = await startedBridge(process);
  const events: unknown[] = [];
  bridge.on("event", (event) => events.push(event));

  process.respond({ method: "item/agentMessage/delta", params: { threadId: "thread-edit", turnId: "turn-edit", delta: "분석 중" } });
  process.respond({ method: "item/completed", params: { threadId: "thread-edit", turnId: "turn-edit", item: { type: "agentMessage", text: "중간", phase: "commentary" } } });
  process.respond({ method: "item/completed", params: { threadId: "thread-edit", turnId: "turn-edit", item: { type: "agentMessage", text: '{"summary":"완료","actions":[]}', phase: "final_answer" } } });
  for (const type of ["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "collabAgentToolCall", "subAgentActivity", "webSearch", "sleep", "imageGeneration"]) {
    process.respond({ method: "item/started", params: { threadId: "thread-edit", turnId: "turn-edit", item: { type } } });
  }
  for (const type of ["imageView", "userMessage", "agentMessage", "reasoning", "contextCompaction"]) {
    process.respond({ method: "item/started", params: { threadId: "thread-edit", turnId: "turn-edit", item: { type } } });
  }

  assert.deepEqual(events[0], { type: "message", text: "분석 중", runId: "turn-edit" });
  assert.deepEqual(events[1], { type: "result", runId: "turn-edit", text: '{"summary":"완료","actions":[]}' });
  assert.deepEqual(events.slice(2), ["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "collabAgentToolCall", "subAgentActivity", "webSearch", "sleep", "imageGeneration"].map((tool) => ({
    type: "toolAttempt", runId: "turn-edit", tool,
  })));
});

test("셀 편집 구조화 시작 계약을 지원하지 않는 App Server는 기능 불가로 구분한다", async () => {
  for (const failingMethod of ["thread/start", "turn/start"]) {
    for (const code of [-32601, -32602]) {
      const process = new FakeProcess();
      const bridge = await startedBridge(process);
      process.responder = (message) => {
        if (message.method === "account/read") return { id: message.id, result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true } };
        if (message.method === "thread/start" && failingMethod !== "thread/start") return { id: message.id, result: { thread: { id: "thread-edit" } } };
        if (message.method === failingMethod) return { id: message.id, error: { code, message: "unsupported" } };
        return undefined;
      };

      await assert.rejects(bridge.startCellEdit({ ...cellEditRequest, cwd: "C:/project", prompt: "편집", outputSchema: {} }), /설치된 Codex App Server에서 현재 셀 편집을 사용할 수 없습니다/);
      assert.equal(process.messages.some((message) => message.method === "skills/list"), false);
      bridge.close();
    }
  }

  const process = new FakeProcess();
  const bridge = await startedBridge(process);
  process.responder = (message) => message.method === "account/read"
    ? { id: message.id, result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true } }
    : message.method === "thread/start"
      ? { id: message.id, error: { code: -32000, message: "인증 실패" } }
      : undefined;
  await assert.rejects(bridge.startCellEdit({ ...cellEditRequest, cwd: "C:/project", prompt: "편집", outputSchema: {} }), /인증 실패/);
});
