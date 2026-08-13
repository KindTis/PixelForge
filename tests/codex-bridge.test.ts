import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { AI_EDIT_OUTPUT_SCHEMA } from "../src/core/ai-edit.ts";
import { CodexBridge, type JsonlProcess, type RpcMessage } from "../src/server/codex-bridge.ts";

class FakeProcess extends EventEmitter implements JsonlProcess {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly messages: RpcMessage[] = [];
  responder?: (message: RpcMessage) => RpcMessage | undefined;
  killed = false;
  readonly stdin = {
    write: (chunk: string) => {
      for (const line of chunk.trim().split("\n")) {
        const message = JSON.parse(line) as RpcMessage;
        this.messages.push(message);
        const response = this.responder?.(message);
        if (response) queueMicrotask(() => this.respond(response));
      }
      return true;
    },
  };

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

test("셀 편집은 도구 없이 읽기 전용 스레드와 구조화 턴을 시작한다", async () => {
  const process = new FakeProcess();
  const bridge = await startedBridge(process);
  process.responder = (message) => {
    if (message.method === "account/read") return { id: message.id, result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true } };
    if (message.method === "thread/start") return { id: message.id, result: { thread: { id: "thread-edit" } } };
    if (message.method === "turn/start") return { id: message.id, result: { turn: { id: "turn-edit" } } };
    return undefined;
  };

  const run = await bridge.startCellEdit({
    cwd: "C:/project",
    prompt: "현재 셀을 편집하세요.",
    compositePath: "C:/project/tmp/composite.png",
    celPath: "C:/project/tmp/cel.png",
    outputSchema: AI_EDIT_OUTPUT_SCHEMA,
  });

  assert.deepEqual(run, { id: "turn-edit", threadId: "thread-edit", turnId: "turn-edit" });
  const thread = process.messages.find((message) => message.method === "thread/start")!;
  assert.deepEqual(thread.params, {
    cwd: "C:/project",
    approvalPolicy: "never",
    sandbox: "read-only",
    serviceName: "pixelforge",
    developerInstructions: "제공된 텍스트와 두 이미지만 읽고 JSON 최종 응답만 작성하세요. 도구, 명령, 파일 쓰기, 스킬을 사용하지 마세요.",
  });
  const turn = process.messages.find((message) => message.method === "turn/start")!;
  assert.deepEqual(turn.params, {
    threadId: "thread-edit",
    input: [
      { type: "text", text: "현재 셀을 편집하세요.", text_elements: [] },
      { type: "localImage", path: "C:/project/tmp/composite.png" },
      { type: "localImage", path: "C:/project/tmp/cel.png" },
    ],
    outputSchema: AI_EDIT_OUTPUT_SCHEMA,
  });
  assert.equal(process.messages.some((message) => message.method === "skills/list"), false);
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

      await assert.rejects(bridge.startCellEdit({ cwd: "C:/project", prompt: "편집", compositePath: "a.png", celPath: "b.png", outputSchema: {} }), /설치된 Codex App Server에서 현재 셀 편집을 사용할 수 없습니다/);
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
  await assert.rejects(bridge.startCellEdit({ cwd: "C:/project", prompt: "편집", compositePath: "a.png", celPath: "b.png", outputSchema: {} }), /인증 실패/);
});
