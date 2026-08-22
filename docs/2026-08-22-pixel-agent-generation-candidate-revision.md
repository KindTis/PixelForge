# PixelForge 생성 후보 기반 영역 교체 v5.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ChatGPT 로그인과 Codex 내장 `$imagegen`으로 선택 영역 교체 후보를 사용자 시도당 앱 turn 한 번만 시작해 만들고, 격리·검증·미리보기 후 기존 History에 정확히 한 번 적용한다.

**Architecture:** 실패한 `PreToolUse` 호출 gate와 Codex 버전 고정을 제거한다. candidate마다 새 `CodexBridge` 프로세스를 만들고 `generation-candidate` 깊은 모듈이 event 관측, 첫 이미지 완료 직후 종료, timeout/cancel, `imageGeneration.result` 신뢰 경계, 최근접 정규화, strict 병합과 cleanup을 소유한다. 서버는 기존 project generation 경로와 bridge event map을 바꾸지 않고 candidate job과 로그만 연결하며, 클라이언트는 현재 canvas를 원본으로 유지한 채 검증된 preview를 보여주고 사용자 승인 때만 기존 `History.execute()`를 호출한다.

**Tech Stack:** Node.js `>=20.19`, TypeScript 7 strict mode, React 19, Node 내장 `http`·`fs/promises`·`crypto`·`zlib`·`node:test`, 기존 PNG codec와 Codex App Server JSONL, `tsx`; 새 runtime dependency 없음

**Spec:** [생성 후보 기반 영역 교체 수정 설계](../specs/2026-08-22-pixel-agent-generation-candidate-revision-design.md)

## Global Constraints

- 현재 브랜치 `feature/pixel-agent-improvement-v5`, 기준 HEAD `f4dac82`에서 작업한다. 새 worktree를 만들지 않는다.
- 이 계획은 [실패한 2026-08-20 계획](./2026-08-20-pixel-agent-generation-candidate.md)을 대체한다. 기존 계획과 [실행 기록](./2026-08-20-pixel-agent-generation-candidate-execution.md)은 감사 원본으로만 읽고 체크박스를 이어서 실행하지 않는다.
- G3 실제 비용 probe는 3회 상한에 도달했으므로 네 번째 G3 probe를 요청하거나 실행하지 않는다.
- 이 구현 계획의 자동 검증 범위는 fake Codex event, 로컬 PNG, typecheck와 build다. 별도의 실제 Codex/ImageGen smoke, 품질 batch와 GUI smoke는 현재 계획 범위에 추가하지 않는다.
- fake Codex event와 메모리/OS temp PNG만 자동 테스트에 사용한다. 테스트 중 브라우저, 에디터, 로그인 창, 알림과 오디오를 띄우지 않는다.
- PixelForge의 별도 API 키 입력·저장·candidate용 주입, 직접 OpenAI Images API, `codex exec`, 다른 provider와 fallback을 추가하지 않는다. 일반 Codex process의 기존 ambient 환경 상속은 검사하거나 변경하지 않는다.
- candidate 동작을 위해 Codex 버전, hook identity/hash/trust 또는 내부 설정 모양을 allowlist하지 않는다.
- 앱이 보장하는 것은 사용자 시도당 `startGeneration()` 호출 1회와 자동 retry 0회다. 실제 ImageGen start 또는 비용 최대 1회라고 코드, 문서, UI와 로그에 표현하지 않는다.
- 관측된 두 번째 `imageGeneration` start는 이미 시작된 뒤의 사후 방어다. 즉시 결과를 폐기하고 process를 종료하되 호출 전 차단이라고 이름 붙이지 않는다.
- Core 입력은 정확히 128×128 RGBA 문서, `(0, 0)`의 128×128 활성 target image, 보이고 잠기지 않은 활성 layer/cel과 원본 alpha 교집합이 있는 `editableSelection`으로 제한한다.
- 선택 없는 자동 부위 인식, 다른 크기, indexed, 실루엣 확장, non-zero cel offset, 다중 프레임, pose 변경, 전체 재설계, 자동 판정과 자동 재시도는 구현하지 않는다.
- `imageGeneration.result`의 base64, decoded 크기, PNG codec와 inflate 경계를 fail-closed한다. optional `savedPath`와 Codex home artifact에 의존하지 않는다.
- 후보 준비 중 `saveProject`, sprite import, generation history와 `History.execute`는 0회다. 적용 전 stale/replay/hash 검증 뒤에만 `History.execute`를 정확히 한 번 호출한다.
- 기존 Task 1–4 구현을 다시 만들지 않는다. `createAiEditApplication()`, `applyCommand()`, base fingerprint, linked copy-on-write와 기존 History를 재사용한다.
- 변경과 직접 관련된 최소 `tsx --test`와 `tsc --noEmit`만 각 Task에서 실행한다. production build는 마지막 Task에서 한 번 실행한다.
- 각 코드 Task의 GREEN 뒤 commit 전에 `graphify update .`를 실행한다. 표시된 파일만 stage한 다음 `git diff --cached --check`로 실제 commit 대상을 검사한다.
- 사용자 소유 미추적 `RunDev.bat`, `RunStart.bat`, `tests/batch-launchers.test.ts`를 읽기 외에는 건드리거나 stage하지 않는다.
- `docs/`와 `.superpowers/`는 ignored다. 사용자가 명시적으로 `커밋해`라고 지시하지 않은 한 `git add -f`를 사용하지 않는다.
- 사용자 대상 문자열과 문서는 한국어 UTF-8(BOM 없음)으로 작성한다.

---

## Historical Baseline

| 항목 | 확정 상태 | 이 계획의 처리 |
|---|---|---|
| 기존 Task 1–4 | HEAD `f4dac82`까지 완료 | 수정하지 않고 소비 |
| G3 probe | 3회 모두 FAIL, 실제 start 합계 4회, 정상 blocked run 0회 | 재실행 금지, 설계 폐기 |
| G3.13 | 미실행 | 실행하지 않음 |
| 기존 Task 5 이후 | 미착수 | 수정 계약으로 새로 실행 |
| G3 code | 현재 worktree에 미커밋 | Gate G4에서 제거 또는 제한 재사용 |
| 각괄호 전달 | native `shell:false`에서 정상 전달 확인, 최종 원인 아님 | 별도 호환 코드 없음 |

기존 감사 원본의 작성 전 SHA-256은 다음과 같다. 문서 작업이나 구현 중 이 파일을 덮어쓰지 않았는지 최종 확인에 사용한다.

```text
docs/pixel-agent-improvement-plan-v5.md
B19C205B4DACEBFD059082004F5162676B9C2CAAB00F8FF0A3D46F2003735715

docs/superpowers/plans/2026-08-20-pixel-agent-generation-candidate.md
F63612961FFCC2D936FF0E9F163A3DA525EC6414D48880C716695161C1011D19

docs/superpowers/plans/2026-08-20-pixel-agent-generation-candidate-execution.md
9003ABD0ECCF8F53CF18AA2D312CEB400B1BD29E71F578AB14CBF2A8EDC874E3
```

완료된 선행 계약은 다음 파일에서 재사용한다.

- `src/core/ai-edit-application.ts`: fingerprint, document 구조 검증, row-major diff와 replay
- `src/core/commands.ts`: linked target copy-on-write, apply와 undo/redo
- `src/core/ai-edit-runner.ts`: strict validation 전 호출할 기존 `selectionMask()`
- `src/client/editor/ai-edit.ts`: 현재 선택을 document-coordinate run으로 만드는 `selectionRuns()`
- `src/server/cell-edit-log.ts`: 순차 writer와 부분 파일 목록 보존
- `src/server/app.ts`: project lock, job wire, cancel과 late event 경쟁 처리 패턴

## File Structure

| 경로 | 작업 | 책임 |
|---|---|---|
| `package.json`, `package-lock.json` | Modify | G3 전용 `@openai/codex` pin 제거 |
| `scripts/image-generation-call-gate.mjs` | Delete | 실패한 hook gate 제거 |
| `scripts/probe-image-generation-call-gate.ts` | Delete | 비용 probe 제거 |
| `tests/image-generation-call-gate.test.ts` | Delete | 폐기된 gate 테스트 제거 |
| `src/server/codex-bridge.ts` | Modify | G3 hook/resolver 제거, read-only/local-image request와 멱등 close 보존 |
| `tests/codex-bridge.test.ts` | Modify | G3 테스트 제거, generic candidate process 계약 보존 |
| `src/core/ai-edit.ts` | Modify | candidate request/result/failure/disposition 타입 |
| `src/core/resize.ts` | Modify | 기존 최근접 scaler 공개 |
| `src/server/png.ts` | Modify | candidate 전용 decode options |
| `src/server/generation-candidate.ts` | Create | preflight, 격리 session, payload 검증, 병합, audit와 cleanup |
| `src/server/app.ts` | Modify | candidate job, capability latch, route와 terminal 연결 |
| `src/server/index.ts` | Modify | 요청 시점 candidate bridge factory 주입 |
| `src/server/cell-edit-log.ts` | Modify | candidate initial/final/disposition writer |
| `src/client/api.ts` | Modify | wire union, payload와 failure notice |
| `src/client/editor/EditorWorkspace.tsx` | Modify | request capture와 단일 적용 seam |
| `src/client/App.tsx` | Modify | polling, preview와 세 사용자 결정 |
| `src/client/styles.css` | Modify | 최소 preview 스타일 |
| `tests/png.test.ts`, `tests/resize.test.ts`, `tests/generation-candidate.test.ts`, `tests/server.test.ts`, `tests/cell-edit-log.test.ts`, `tests/client-api.test.ts`, `tests/editor-workspace.test.ts` | Modify/Create | 새 실패 양상만 검증 |

코드 조각에서 `fake`, `fixture`, `postCandidate`, `runSequence`처럼 assertion을 준비하는 이름은 표시된 test 파일의 local helper다. `validRun`, `candidateInputAudit`처럼 production 조각에만 나오는 이름은 바로 인접한 규칙을 그대로 구현하는 file-private 함수이며 export하거나 별도 class/interface로 승격하지 않는다. `Interfaces`의 `Consumes`/`Produces`만 파일 간 계약이다.

## 의존 순서

```text
Gate G4: 실패한 G3 제거 + stable bridge baseline
  → Task 1: candidate 타입·PNG·최근접 경계
  → Task 2: 격리 session·strict candidate 깊은 모듈
  → Task 3: 무저장 server job·로그·호환성 격리
  → Task 4: 멱등 disposition
  → Task 5: client preview·단일 적용·명시 재생성
  → Task 6: 교차 경계 검증·build
```

---

### Task G4: 실패한 G3를 제거하고 candidate process에 필요한 최소 bridge 계약만 남긴다

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/server/codex-bridge.ts`
- Modify: `tests/codex-bridge.test.ts`
- Delete: `scripts/image-generation-call-gate.mjs`
- Delete: `scripts/probe-image-generation-call-gate.ts`
- Delete: `tests/image-generation-call-gate.test.ts`

**Interfaces:**

Consumes:

```ts
type GenerationRun = { id: string; threadId: string; turnId: string };
type CodexEvent =
  | { type: "message"; text: string; runId?: string }
  | { type: "result"; runId: string; text: string }
  | { type: "toolAttempt"; runId: string; tool: string }
  | { type: "completed"; runId: string; status: string }
  | { type: "approval"; requestId: number; method: string; params: Record<string, unknown>; runId?: string; threadId?: string }
  | { type: "notification"; method: string; params: Record<string, unknown> }
  | { type: "error"; message: string };
// 현재 PATH의 `codex app-server --listen stdio://` process와 기존 JSONL request/event 전달을 소비한다.
```

Produces:

```ts
export type GenerationRequest = {
  cwd: string;
  prompt: string;
  approvalPolicy?: "on-request" | "never";
  sandbox?: "read-only" | "workspace-write";
  localImagePaths?: readonly string[];
};
```

Preserves:

```ts
export class CodexBridge extends EventEmitter {
  startGeneration(request: GenerationRequest): Promise<GenerationRun>;
  interrupt(runId: string): Promise<void>;
  close(timeoutMs?: number): Promise<void>;
}
```

`createCodexProcess()`는 기준 HEAD의 일반 `codex app-server --listen stdio://` 실행 방식을 복원한다. candidate 때문에 전역 Codex 명령을 project dependency로 바꾸지 않는다.

- [ ] **G4.1 — 3분: 보존할 generic bridge baseline을 먼저 고정한다**

`tests/codex-bridge.test.ts`에서 G3 전용 fixture를 사용하지 않는 `approvalPolicy`와 멱등 close 계약을 먼저 실행한다.

```ts
await bridge.startGeneration({ cwd: "C:/candidate", prompt: "probe", approvalPolicy: "never" });
assert.equal(threadStart.params?.approvalPolicy, "never");

const event = once(bridge, "event");
const params = {
  turnId: "turn-1",
  item: { id: "image-1", type: "imageGeneration", status: "completed", result: "AAAA", savedPath: "C:/ignored.png" },
};
process.stdout.emit("data", `${JSON.stringify({ method: "item/completed", params })}\n`);
assert.deepEqual(await event, [{ type: "notification", method: "item/completed", params }]);

await Promise.all([bridge.close(5), bridge.close(5)]);
assert.equal(process.closeCount, 1);
```

candidate 깊은 모듈이 재사용할 기존 event fallthrough도 한 assertion으로 고정한다. `item/completed`의 non-agent `imageGeneration`은 새 event type을 만들지 않고 `notification`의 원래 `method`와 `params`를 byte-for-byte 유지해야 한다.

Run:

```powershell
& .\node_modules\.bin\tsx.cmd --test --test-name-pattern="승인 요청 없이|imageGeneration 완료|Codex close" tests\codex-bridge.test.ts
```

Expected: 현재 보존 대상 테스트가 PASS한다. 실패하면 cleanup을 시작하지 말고 현재 dirty G3 변경의 회귀를 먼저 고친다.

- [ ] **G4.2 — 5분: hook·claim·version resolver 코드를 외과적으로 제거한다**

`src/server/codex-bridge.ts`에서 다음 항목과 그 전용 helper/import를 제거한다.

```text
GenerationCandidateHookIdentity
GenerationCandidateHookRunMismatch
GENERATION_CANDIDATE_CODEX_VERSION
GENERATION_CANDIDATE_IMAGE_TOOL
GENERATION_CANDIDATE_HOOK_MATCHER
GENERATION_CANDIDATE_DIRECT_ONLY_OVERRIDE
generationCandidateHookOverride
generationCandidateHookTrustOverride
createGenerationCandidateGateStateRoot
removeGenerationCandidateGateStateRoot
verifyGenerationCandidateHook
generationCandidateHookRunMismatch
isGenerationCandidateHookRun
createGenerationCandidateCodex
resolveCodexInstall
codexProcessSpec
```

`CodexBridge` constructor는 다시 process factory 하나만 받는다. `approvalPolicy` 선택과 process identity를 확인하는 async/idempotent `close()`는 candidate 격리에 필요하므로 유지한다.

- [ ] **G4.3 — 4분: read-only와 네 localImage 전달 RED를 쓴다**

같은 fake process에서 마지막 `thread/start`와 `turn/start` request를 선택해 다음을 검사한다. 이 테스트는 현재 `sandbox:"workspace-write"` 고정과 local image 누락 때문에 실패해야 한다.

```ts
const paths = ["original-cel.png", "original-composite.png", "selection-mask.png", "selection-overlay.png"]
  .map((name) => `C:/candidate/${name}`);
await bridge.startGeneration({
  cwd: "C:/candidate",
  prompt: "갑옷을 나무 재질로 바꿔 주세요.",
  approvalPolicy: "never",
  sandbox: "read-only",
  localImagePaths: paths,
});
const threadStart = requests.filter((request) => request.method === "thread/start").at(-1)!;
const turnStart = requests.filter((request) => request.method === "turn/start").at(-1)!;
assert.equal(threadStart.params?.sandbox, "read-only");
assert.deepEqual(turnStart.params?.input, [
  { type: "text", text: "$imagegen 갑옷을 나무 재질로 바꿔 주세요." },
  ...paths.map((path) => ({ type: "localImage", path })),
  { type: "skill", name: "imagegen", path: "C:/skills/imagegen/SKILL.md" },
]);
```

Run:

```powershell
& .\node_modules\.bin\tsx.cmd --test --test-name-pattern="read-only localImage" tests\codex-bridge.test.ts
```

Expected RED: `sandbox`가 `workspace-write`이거나 input에 `localImage`가 없어 assertion이 실패한다.

- [ ] **G4.4 — 5분: 기준 HEAD process와 최소 request 확장을 GREEN으로 만든다**

기준 HEAD의 일반 process 실행을 복원하고 `startGeneration()`의 기존 기본값을 보존한 채 두 optional field만 소비한다.

```ts
export function createCodexProcess(extraArgs: readonly string[] = []): JsonlProcess {
  const appServerArgs = ["app-server", "--listen", "stdio://", ...extraArgs];
  const command = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "codex";
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", ["codex", ...appServerArgs].join(" ")]
    : appServerArgs;
  return spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }) as JsonlProcess;
}
```

```ts
const thread = await this.request<{ thread: { id: string } }>("thread/start", {
  cwd: request.cwd,
  approvalPolicy: request.approvalPolicy ?? "on-request",
  sandbox: request.sandbox ?? "workspace-write",
  serviceName: "pixelforge",
});
const turn = await this.request<{ turn: { id: string } }>("turn/start", {
  threadId: thread.thread.id,
  input: [
    { type: "text", text: `$imagegen ${request.prompt}` },
    ...(request.localImagePaths ?? []).map((path) => ({ type: "localImage", path })),
    { type: "skill", name: skill.name, path: skill.path },
  ],
});
```

hook TOML이나 session flag key를 argv로 보내지 않으므로 별도 serializer를 남기지 않는다. 기본 request는 계속 `workspace-write`이고 local image가 없다.

- [ ] **G4.5 — 3분: G3 dependency·script·test를 제거한다**

`package.json`과 lock에서 `@openai/codex`를 제거하고 G3 전용 세 파일을 삭제한다. `tests/codex-bridge.test.ts`의 hook, resolver, probe, temp state root 테스트와 전용 fixture/import만 제거한다. generic close와 `approvalPolicy:"never"` 테스트는 남긴다.

Run:

```powershell
rg -n "GenerationCandidateHook|image-generation-call-gate|GENERATION_CANDIDATE_CODEX_VERSION|resolveCodexInstall|@openai/codex" package.json package-lock.json src scripts tests
```

Expected: 검색 결과 0건. `CodexBridge`, `approvalPolicy`와 generic `close`는 이 검색 대상이 아니다.

- [ ] **G4.6 — 5분: bridge 회귀와 typecheck를 통과시킨다**

Run:

```powershell
& .\node_modules\.bin\tsx.cmd --test tests\codex-bridge.test.ts
& .\node_modules\.bin\tsc.cmd --noEmit
```

Expected: 모든 bridge test PASS, type error 0. fake process만 사용하며 실제 Codex process는 시작되지 않는다.

- [ ] **G4.7 — 3분: graph 갱신과 commit**

```powershell
graphify update .
git add package.json package-lock.json src/server/codex-bridge.ts tests/codex-bridge.test.ts
git diff --cached --check
git commit -m "refactor: replace failed generation call gate"
```

Expected: G3 전용 변경만 제거되고 사용자 소유 미추적 파일과 ignored 문서는 stage되지 않는다. 삭제한 G3 script/test 세 파일은 원래 미추적이므로 stage 경로에 넣지 않는다.

---

### Task 1: candidate 공개 타입, PNG 신뢰 경계와 기존 최근접 scaler를 준비한다

**Files:**

- Modify: `src/core/ai-edit.ts`
- Modify: `src/core/resize.ts`
- Modify: `src/server/png.ts`
- Modify: `tests/resize.test.ts`
- Modify: `tests/png.test.ts`
- Create: `tests/generation-candidate.test.ts`

**Interfaces:**

Consumes:

```ts
export type PixelBuffer = { width: number; height: number; data: Uint8ClampedArray };
export type AiEditTarget = { frameId: string; layerId: string; celId: string };
export type AiSelectionRun = { y: number; startX: number; endX: number };
export type EditCommand = { type: "setPixels"; celId: string; pixels: PixelChange[] };
decodePng(png: Uint8Array): PixelBuffer;
resizeImage(document: SpriteDocument, width: number, height: number): SpriteDocument;
```

Produces:

```ts
export type GenerationEditRequest = {
  mode: "generation-candidate";
  prompt: string;
  target: AiEditTarget;
  editableSelection: AiSelectionRun[];
};

export type GenerationCandidateFailureCode =
  | "generation_failed"
  | "generation_protocol_changed"
  | "multiple_generation_detected"
  | "invalid_candidate"
  | "no_effect";

export type GenerationCandidateBlockedFailure = {
  outcome: "blocked";
  code: "unsupported_target" | "empty_selection";
  summary: string;
};

export type GenerationCandidateRuntimeFailure = {
  outcome: "failed";
  code: GenerationCandidateFailureCode;
  summary: string;
};

export type GenerationCandidateFailure =
  | GenerationCandidateBlockedFailure
  | GenerationCandidateRuntimeFailure;

export type GenerationCandidateResult = {
  outcome: "candidate_ready";
  summary: string;
  preview: { mimeType: "image/png"; base64: string };
  candidateTargetHash: string;
  baseFingerprint: AiEditBaseFingerprint;
  command: EditCommand;
};

export const GENERATION_CANDIDATE_DISPOSITIONS = [
  "applied",
  "regenerated",
  "discarded",
  "stale_base",
  "apply_failed",
] as const;
export type GenerationCandidateDisposition = typeof GENERATION_CANDIDATE_DISPOSITIONS[number];

export type PngDecodeOptions = {
  maxInputBytes?: number;
  maxDimension?: number;
  requireSquare?: boolean;
  allowRgb?: boolean;
};

export function decodePng(png: Uint8Array, options?: PngDecodeOptions): PixelBuffer;
export function scalePixelBufferNearest(source: PixelBuffer, width: number, height: number): PixelBuffer;
```

Preserves: options 없는 `decodePng()`는 현재 8192 dimension, non-square 허용, RGBA-only 동작을 유지하고 기존 `resizeImage()`는 공개한 동일 scaler를 호출한다.

- [ ] **1.1 — 4분: discriminated union type RED를 쓴다**

`tests/generation-candidate.test.ts`에 `satisfies` fixture와 `// @ts-expect-error`를 추가한다. `mode`, `editableSelection`, `candidateTargetHash`가 빠진 값과 blocked/runtime code 혼합이 typecheck에서 잡혀야 한다.

```ts
const request = {
  mode: "generation-candidate",
  prompt: "투구를 수정해 주세요.",
  target,
  editableSelection: [{ y: 1, startX: 2, endX: 3 }],
} satisfies GenerationEditRequest;

// @ts-expect-error blocked code는 runtime failure에 들어갈 수 없다.
const invalid: GenerationCandidateRuntimeFailure = { outcome: "failed", code: "empty_selection", summary: "x" };
void request;
void invalid;
```

Run:

```powershell
& .\node_modules\.bin\tsc.cmd --noEmit
```

Expected RED: candidate type export가 없어 실패한다.

- [ ] **1.2 — 3분: 공개 타입을 최소 추가해 type RED를 GREEN으로 만든다**

`src/core/ai-edit.ts`에 명세의 request, blocked/runtime failure, result와 disposition union만 추가한다. runtime failure 이름은 `generation_call_limit`이 아니라 `multiple_generation_detected`를 사용한다.

- [ ] **1.3 — 5분: candidate PNG 형식·상한 RED를 표로 작성한다**

테스트 코드 안의 작은 PNG chunk/CRC helper로 2×2 RGB 성공과 다음 실패를 만든다.

```text
indexed 또는 grayscale
interlace 1
non-square
2049 dimension
손상 CRC 또는 IEND
IEND 뒤 trailing bytes
예상 scanline보다 큰 inflate
maxInputBytes 초과
```

```ts
assert.deepEqual(decodePng(rgbPng(2, 2), { allowRgb: true, requireSquare: true }).data, expectedRgba);
assert.throws(() => decodePng(indexedPng, candidateOptions), /지원하지 않는 PNG 형식/);
assert.throws(() => decodePng(pngWithTrailingByte, candidateOptions), /PNG 구조/);
assert.throws(() => decodePng(oversizedInflatePng, candidateOptions));
```

Run:

```powershell
& .\node_modules\.bin\tsx.cmd --test tests\png.test.ts
```

Expected RED: RGB가 현재 decoder에서 거부되거나 candidate 상한 case가 통과한다.

- [ ] **1.4 — 5분: decoder를 channels-aware로 최소 수정한다**

```ts
if (options?.maxInputBytes !== undefined && png.byteLength > options.maxInputBytes) {
  throw new Error("PNG 입력이 너무 큽니다.");
}
const maxDimension = options?.maxDimension ?? 8192;
const channels = colorType === 2 && options?.allowRgb ? 3 : colorType === 6 ? 4 : 0;
const expected = (width * channels + 1) * height;
const raw = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected });
if (raw.length !== expected) throw new Error("PNG 픽셀 데이터 길이가 올바르지 않습니다.");
```

```ts
if (type === "IHDR") {
  if (sawIhdr || sawIdat || offset !== 8 || data.length !== 13) throw new Error("PNG 구조가 올바르지 않습니다.");
  sawIhdr = true;
} else if (type === "IDAT") {
  if (!sawIhdr || sawIend) throw new Error("PNG 구조가 올바르지 않습니다.");
  sawIdat = true;
} else if (type === "IEND") {
  if (!sawIhdr || !sawIdat || sawIend || data.length !== 0 || end !== input.length) {
    throw new Error("PNG 구조가 올바르지 않습니다.");
  }
  sawIend = true;
}
```

width/height는 `1..maxDimension`이고 `requireSquare`이면 동일해야 한다. IHDR의 bit depth 8, compression/filter 0, interlace 0을 검사한다. unfilter의 left 간격은 `channels`를 사용하고 RGB 결과의 alpha는 255로 채운다. 첫 chunk는 정확히 13-byte `IHDR` 하나, `IHDR`는 `IDAT`보다 앞, `IEND`는 길이 0인 마지막 chunk이고 그 직후 EOF여야 한다. 중복/늦은 `IHDR`, 누락/중복 `IEND`, trailing byte는 거부한다.

- [ ] **1.5 — 3분: 기존 최근접 scaler 공개 RED를 쓴다**

2×2 사분면 RGBA를 4×4로 키워 각 2×2 block이 byte-exact인지 검사한다. target width/height가 0, 소수 또는 4097이면 거부한다.

```ts
const scaled = scalePixelBufferNearest(quadrants2x2, 4, 4);
for (let y = 0; y < 4; y += 1) for (let x = 0; x < 4; x += 1) {
  assert.deepEqual(pixelAt(scaled, x, y), pixelAt(quadrants2x2, Math.floor(x / 2), Math.floor(y / 2)));
}
assert.throws(() => scalePixelBufferNearest(quadrants2x2, 0, 4));
assert.throws(() => scalePixelBufferNearest(quadrants2x2, 4.5, 4));
```

Run:

```powershell
& .\node_modules\.bin\tsx.cmd --test tests\resize.test.ts
```

Expected RED: `scalePixelBufferNearest`가 export되지 않아 test import가 실패한다.

- [ ] **1.6 — 3분: private scaler를 공개해 GREEN으로 만든다**

새 알고리즘을 만들지 않고 기존 `scaleNearest()`를 rename/export하고 공통 `validateSize()`를 호출한다. `resizeImage()`도 같은 함수 이름만 사용한다.

```ts
export function scalePixelBufferNearest(buffer: PixelBuffer, width: number, height: number): PixelBuffer {
  validateSize(width, height);
  if (width === buffer.width && height === buffer.height) return buffer;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const source = (Math.min(buffer.height - 1, Math.floor(y * buffer.height / height)) * buffer.width
      + Math.min(buffer.width - 1, Math.floor(x * buffer.width / width))) * 4;
    data.set(buffer.data.subarray(source, source + 4), (y * width + x) * 4);
  }
  return { width, height, data };
}
```

Run:

```powershell
& .\node_modules\.bin\tsx.cmd --test tests\resize.test.ts tests\png.test.ts
& .\node_modules\.bin\tsc.cmd --noEmit
```

Expected: 두 test 파일 PASS, type error 0. 기존 PNG round-trip과 resize test도 그대로 PASS한다.

- [ ] **1.7 — 3분: graph 갱신과 commit**

```powershell
graphify update .
git add src/core/ai-edit.ts src/core/resize.ts src/server/png.ts tests/resize.test.ts tests/png.test.ts tests/generation-candidate.test.ts
git diff --cached --check
git commit -m "feat: define generation candidate boundaries"
```

---

### Task 2: candidate 격리 session, payload 검증과 strict 병합을 깊은 모듈 하나로 만든다

**Files:**

- Create: `src/server/generation-candidate.ts`
- Modify: `tests/generation-candidate.test.ts`

**Interfaces:**

Produces private bridge seam:

```ts
export type GenerationCandidateCodex = Pick<
  CodexBridge,
  "startGeneration" | "interrupt" | "respond" | "close"
> & {
  on(event: "event", listener: (event: CodexEvent) => void): unknown;
  off(event: "event", listener: (event: CodexEvent) => void): unknown;
};

export type CreateGenerationCandidateCodex = () => Promise<GenerationCandidateCodex>;
```

Consumes:

```ts
selectionMask(
  runs: readonly AiSelectionRun[] | undefined,
  image: PixelBuffer,
  cel: Cel,
  document: SpriteDocument,
): Uint8Array | undefined;
applyCommand(document: SpriteDocument, command: EditCommand): SpriteDocument;
createAiEditApplication(
  original: SpriteDocument,
  candidate: SpriteDocument,
  target: AiEditTarget,
): AiEditApplication | null;
encodePng(width: number, height: number, rgba: Uint8ClampedArray): Buffer;
decodePng(png: Uint8Array, options?: PngDecodeOptions): PixelBuffer;
scalePixelBufferNearest(source: PixelBuffer, width: number, height: number): PixelBuffer;
```

Produces:

```ts
export type GenerationCandidateInputAudit = {
  protocolRevision: 1;
  promptRevision: 1;
  userPrompt: string;
  target: AiEditTarget;
  baseFingerprint: AiEditBaseFingerprint;
  selectionPixels: number;
  inputHashes: {
    originalCel: string;
    originalComposite: string;
    selectionMask: string;
    selectionOverlay: string;
  };
};

export type GenerationCandidateTermination =
  | "candidate_ready"
  | "start_failed"
  | "cancelled"
  | GenerationCandidateFailureCode;

export type GenerationCandidateAudit = {
  termination: GenerationCandidateTermination;
  imageGenerationStartsObserved: number;
  imageGenerationCompletionsObserved: number;
  image?: { decodedBytes: number; sha256: string; width: number; height: number };
  normalizedPng?: Uint8Array;
  previewPng?: Uint8Array;
  changedInsidePixels: number;
  changedOutsideBytes: number;
  alphaDiffBytes: number;
  commandPixels: number;
  replayVerified: boolean;
};

export type GenerationCandidateStartFailure = {
  outcome: "start_failed";
  failure: GenerationCandidateRuntimeFailure & { code: "generation_failed" };
  inputAudit: GenerationCandidateInputAudit;
  audit: GenerationCandidateAudit & { termination: "start_failed" };
};

export type GenerationCandidateFinalization =
  | {
      outcome: "completed";
      result: GenerationCandidateResult;
      audit: GenerationCandidateAudit & { termination: "candidate_ready" };
      disableUntilRestart: false;
    }
  | {
      outcome: "failed";
      failure: GenerationCandidateRuntimeFailure;
      audit: GenerationCandidateAudit;
      disableUntilRestart: boolean;
    }
  | {
      outcome: "cancelled";
      audit: GenerationCandidateAudit & { termination: "cancelled" };
      disableUntilRestart: false;
    };

export type GenerationCandidateRun = {
  outcome: "started";
  inputAudit: GenerationCandidateInputAudit;
  completion: Promise<GenerationCandidateFinalization>;
  cancel(): Promise<void>;
};

export async function startGenerationCandidate(
  input: { document: SpriteDocument; request: unknown },
  createCodex: CreateGenerationCandidateCodex,
  options?: { timeoutMs?: number },
): Promise<GenerationCandidateRun | GenerationCandidateBlockedFailure | GenerationCandidateStartFailure>;
```

별도 filesystem adapter, provider registry와 public base64 validator를 만들지 않는다. raw result 검증은 이 모듈의 private 함수다.

- [ ] **2.1 — 5분: preflight 호출 0 RED를 표로 작성한다**

다음 입력마다 `createCodexCalls === 0`과 code를 확인한다.

| 입력 | 기대 code |
|---|---|
| 127×128 문서/target 또는 data length 불일치 | `unsupported_target` |
| indexed, non-zero cel offset, hidden/locked layer | `unsupported_target` |
| layer/cel opacity 0, target id 불일치 | `unsupported_target` |
| 중복 celId 또는 소유 key 불일치 | `unsupported_target` |
| 비정수·역순·범위 밖 selection run | `unsupported_target` |
| 빈 runs 또는 selection과 원본 alpha 교집합 0 | `empty_selection` |

```ts
for (const { document, request, code } of invalidCases) {
  let createCodexCalls = 0;
  const outcome = await startGenerationCandidate({ document, request }, async () => {
    createCodexCalls += 1;
    return fake;
  });
  assert.equal(outcome.outcome, "blocked");
  assert.equal(outcome.code, code);
  assert.equal(createCodexCalls, 0);
}
```

Run:

```powershell
& .\node_modules\.bin\tsx.cmd --test --test-name-pattern="생성 후보 preflight" tests\generation-candidate.test.ts
```

Expected RED: `startGenerationCandidate`가 없어 module import가 실패한다.

- [ ] **2.2 — 5분: snapshot과 strict preflight를 구현한다**

unknown request의 exact fields, trimmed prompt, target string과 runs를 먼저 검증한다. 모든 run을 검사한 뒤에만 기존 `selectionMask()`를 호출한다. 시작 시점의 `structuredClone(document)` 하나를 이후 입력·fingerprint·병합의 유일한 원본으로 사용한다.

```ts
if (!isExactGenerationRequest(input.request)) return blocked("unsupported_target");
const prompt = input.request.prompt.trim();
if (!prompt || !validTarget(input.document, input.request.target)) return blocked("unsupported_target");
if (!input.request.editableSelection.every((run) => validRun(run, input.document))) {
  return blocked("unsupported_target");
}
const snapshot = structuredClone(input.document);
const cel = snapshot.cels[celKey(input.request.target.frameId, input.request.target.layerId)]!;
const image = snapshot.images[cel.imageId]!;
const mask = selectionMask(input.request.editableSelection, image, cel, snapshot);
if (!mask) return blocked("unsupported_target");
if (!hasEditableOpaquePixel(snapshot, input.request.target, mask)) return blocked("empty_selection");
```

- [ ] **2.3 — 5분: 격리 입력 네 개와 앱 start 1회 RED를 쓴다**

fake bridge의 `startGeneration()` 안에서 cwd entries, local image 순서와 호출 수를 검사한다.

```ts
const names = [
  "original-cel.png",
  "original-composite.png",
  "selection-mask.png",
  "selection-overlay.png",
] as const;
assert.deepEqual((await readdir(request.cwd)).sort(), [...names].sort());
assert.deepEqual(request.localImagePaths?.map((path) => basename(path)), names);
assert.equal(startCalls, 1);
assert.equal(request.approvalPolicy, "never");
assert.equal(request.sandbox, "read-only");
for (const path of request.localImagePaths ?? []) assert.deepEqual(decodePng(await readFile(path)), expectedInput(path));
```

원본 cel/composite는 128×128이다. mask는 선택 픽셀만 white/alpha255이고 overlay는 원본 위 선택을 고정 색으로 표시한다. 파일 쓰기·복사·이동을 지시하는 prompt 문자열이 없는지도 확인한다.

Run:

```powershell
& .\node_modules\.bin\tsx.cmd --test --test-name-pattern="격리 입력|start 1회|시작 실패 cleanup" tests\generation-candidate.test.ts
```

Expected RED: candidate session 구현이 없어 import 또는 격리 입력 assertion이 실패한다.

- [ ] **2.4 — 5분: input, prompt, hash와 start failure cleanup을 구현한다**

네 PNG bytes와 SHA-256을 temp 생성 전에 메모리에서 준비한다. `mkdtemp(join(tmpdir(), "pixelforge-generation-candidate-"))` 뒤 파일을 쓰고 candidate bridge를 만든 다음 listener를 연결하고 `startGeneration()`을 정확히 한 번 호출한다.

```ts
const files = prepareCandidateInputs(snapshot, request, mask);
const inputAudit = candidateInputAudit(snapshot, request, mask, files);
let cwd: string | undefined;
let bridge: GenerationCandidateCodex | undefined;
try {
  cwd = await mkdtemp(join(tmpdir(), "pixelforge-generation-candidate-"));
  const localImagePaths = await writeCandidateInputs(cwd, files);
  bridge = await createCodex();
  bridge.on("event", onEvent);
  const run = await bridge.startGeneration({
    cwd,
    prompt: buildCandidatePrompt(request.prompt),
    approvalPolicy: "never",
    sandbox: "read-only",
    localImagePaths,
  });
  return startedRun(run, inputAudit);
} catch (error) {
  if (bridge) await bridge.close(1_000).catch(() => undefined);
  if (cwd) await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  return startFailure(inputAudit, error);
}
```

prompt에는 네 입력의 의미, 내장 ImageGen 정확히 1회, 전체 정사각 RGB/RGBA, 파일 쓰기·복사·이동과 다른 도구 금지, 완료 후 즉시 종료를 적는다. 이 지시는 호출 상한 증거로 사용하지 않는다.

temp/write/factory/start 중 실패하면 bridge와 cwd를 정리하고 `start_failed/generation_failed`를 반환한다. 자동 재호출하지 않는다.

Run:

```powershell
& .\node_modules\.bin\tsx.cmd --test --test-name-pattern="격리 입력|start 1회|시작 실패 cleanup" tests\generation-candidate.test.ts
```

Expected GREEN: 해당 tests PASS, fake `startGeneration()` 호출 1회, 실제 Codex/ImageGen 실행 0.

- [ ] **2.5 — 5분: early event와 첫 image completion 종료 RED를 쓴다**

FakeCodex가 `startGeneration()` promise를 resolve하기 전에 다음 event를 같은 순서로 emit하게 한다.

```ts
const rawResult = encodePng(128, 128, generated).toString("base64");
fake.beforeStartResolves = () => {
  fake.emit({ type: "toolAttempt", runId: "run-1", tool: "imageGeneration" });
  fake.emit({
    type: "notification",
    method: "item/completed",
    params: {
      turnId: "run-1",
      item: { id: "image-1", type: "imageGeneration", status: "completed", result: rawResult, savedPath: "C:/ignored/not-present.png" },
    },
  });
};
const final = await (await startedCandidate(fake)).completion;
assert.equal(fake.startCalls, 1);
assert.equal(fake.interruptCalls, 1);
assert.deepEqual(fake.closeTimeouts, [1_000]);
assert.equal(final.audit.imageGenerationStartsObserved, 1);
assert.equal(final.audit.imageGenerationCompletionsObserved, 1);
assert.equal(fake.readSavedPathCalls, 0);
```

Run:

```powershell
& .\node_modules\.bin\tsx.cmd --test --test-name-pattern="early event|첫 image completion|delayed close" tests\generation-candidate.test.ts
```

Expected RED: early event queue와 완료 즉시 close가 없어 completion이 끝나지 않는다.

- [ ] **2.6 — 5분: candidate 전용 event loop를 GREEN으로 만든다**

listener는 `startGeneration()` 전 연결하고 run 반환 전 event를 배열에 보관한다. run id를 얻으면 순서대로 drain한다. 일반 event는 같은 run만 처리하되, 전용 bridge에서 `imageGeneration`으로 식별된 completion의 turn/run id 불일치는 무시하지 않고 semantic protocol mismatch로 분류한다. 정확히 `item/completed`이면서 item type이 `imageGeneration`인 event만 image completion 후보로 삼고, 다른 item의 정상적인 interleaving은 무시한다. 첫 image completion의 raw `result`를 지역 변수로만 받아 `stopping_after_image`를 선점하고 `void interrupt(run.id).catch(...)`와 `close(1_000)`을 시작하되 성공은 아직 확정하지 않는다. 양수 timeout은 종료 신호를 즉시 보낸 뒤 실제 비동기 process `close` event를 기다리는 bounded wait다. close 중 도착한 start event도 최종 판정 전에 반영하며, close 완료 시 관측 start가 정확히 1일 때만 payload 검증으로 넘어간다.

```ts
if (event.type === "toolAttempt" && event.runId === run.id && event.tool === "imageGeneration") {
  audit.imageGenerationStartsObserved += 1;
  if (audit.imageGenerationStartsObserved > 1) claimFailure("multiple_generation_detected");
} else if (isImageGenerationCompletion(event)) {
  const item = isRecord(event.params.item) ? event.params.item : undefined;
  if (item?.type === "imageGeneration") audit.imageGenerationCompletionsObserved += 1;
  if (audit.imageGenerationCompletionsObserved > 1) {
    claimFailure("generation_protocol_changed");
  }
  if (phase === "running") {
    phase = "stopping_after_image";
    rawCompletion = event.params;
    void bridge.interrupt(run.id).catch(() => undefined);
    closeAfterImage = bridge.close(1_000);
  }
} else if (event.type === "error" && phase !== "stopping_after_image" && phase !== "cancelling") {
  claimFailure("generation_failed");
}

function isImageGenerationCompletion(
  event: CodexEvent,
): event is Extract<CodexEvent, { type: "notification" }> & {
  method: "item/completed";
  params: { item: Record<string, unknown> & { type: "imageGeneration" } };
} {
  return event.type === "notification"
    && event.method === "item/completed"
    && isRecord(event.params)
    && isRecord(event.params.item)
    && event.params.item.type === "imageGeneration";
}
```

approval은 즉시 `{ decision:"decline" }`으로 응답하고 실패시킨다. `turn/completed`, bridge error와 timeout은 image completion 전이면 `generation_failed`다. self-close가 `failPending()`으로 발생시키는 bridge error는 `stopping_after_image`와 `cancelling`에서만 무시한다. 식별된 `imageGeneration` completion의 wrong/missing run id, status 또는 result type만 stop 이후 semantic payload 검사에서 protocol mismatch가 된다. listener 제거, close와 cwd 정리는 모든 terminal에서 한 promise로 수행한다.

Run:

```powershell
& .\node_modules\.bin\tsx.cmd --test --test-name-pattern="early event|첫 image completion|delayed close" tests\generation-candidate.test.ts
```

Expected GREEN: 해당 tests PASS, 첫 completion 직후 `interrupt()`와 `close(1_000)`이 각각 1회이며 delayed-close fake도 성공한다.

- [ ] **2.7 — 5분: 복수 start·protocol mismatch·timeout·cancel RED를 쓴다**

각 case를 한 번씩 실행한다.

```text
start, start, late image completion → multiple_generation_detected
start, image completion, image completion → generation_protocol_changed + disableUntilRestart
image completion without exactly one preceding start → generation_protocol_changed + disableUntilRestart
wrong/missing turnId, item type 또는 status/result type → generation_protocol_changed + disableUntilRestart
status failed 또는 empty result → generation_failed
turn completed before image completion → generation_failed
approval request → decline 1회 + generation_failed
running 중 bridge error → generation_failed
첫 image 완료 뒤 self-close bridge error → 무시하고 payload 판정
close(1_000) promise reject → generation_failed, result 비공개
25ms timeout → generation_failed
cancel과 late events → cancelled cleanup, result 비공개
```

복수 start case는 `imageGenerationStartsObserved === 2`와 preview 부재를 확인한다. 테스트 이름과 사용자 문구에 `호출 전 차단`, `최대 1회`를 쓰지 않는다.

```ts
const multiple = await runSequence(fake, [started("run-1"), started("run-1"), completedImage("run-1", validBase64)]);
assert.equal(multiple.outcome, "failed");
assert.equal(multiple.failure.code, "multiple_generation_detected");
assert.equal(multiple.audit.imageGenerationStartsObserved, 2);
assert.equal("result" in multiple, false);

const changed = await runSequence(fake, [started("run-1"), completedImage("other-run", validBase64)]);
assert.equal(changed.outcome, "failed");
assert.equal(changed.failure.code, "generation_protocol_changed");
assert.equal(changed.disableUntilRestart, true);

fake.closeError = new Error("close failed");
const closeFailed = await runSequence(fake, [started("run-1"), completedImage("run-1", validBase64)]);
assert.equal(closeFailed.outcome, "failed");
assert.equal(closeFailed.failure.code, "generation_failed");
```

Run:

```powershell
& .\node_modules\.bin\tsx.cmd --test --test-name-pattern="복수 start|protocol mismatch|timeout|cancel" tests\generation-candidate.test.ts
```

Expected RED: terminal 우선순위나 멱등 cleanup이 없어 code, preview 부재 또는 cleanup assertion이 실패한다.

- [ ] **2.8 — 4분: terminal claim과 멱등 cancel/cleanup을 GREEN으로 만든다**

`running → stopping_after_image → terminal` 전이를 한곳에서 관리한다. `stopping_after_image`는 성공 terminal이 아니므로 close 전 복수 start, approval 또는 cancel이 성공보다 우선한다. 그 밖의 terminal reason은 첫 값만 동기 claim한다. `cancel()` 두 번, completion 뒤 cancel과 close error가 같은 cleanup promise를 기다리게 한다. protocol mismatch만 `disableUntilRestart:true`이고 다른 failure는 false다.

`cleanup()`은 listener를 먼저 제거하고 bridge close를 await한 뒤 Windows cwd handle이 풀린 다음 cwd `rm()`을 시도한다. close가 실패해도 `catch` 뒤 `rm()`은 반드시 시도하고, 두 단계의 첫 오류를 마지막에 throw해 아래 `settleWithCleanup()`이 public failure로 변환하게 한다.

fake close는 항상 microtask에서 끝내지 않는다. 한 case는 `setTimeout(..., 10)` 뒤 process close를 emit하고 `closeTimeouts === [1_000]`과 성공을 확인해 실제 비동기 종료를 모사한다. timeout을 0으로 되돌리는 구현은 이 test에서 실패해야 한다.

Run:

```powershell
& .\node_modules\.bin\tsx.cmd --test --test-name-pattern="복수 start|protocol mismatch|timeout|cancel" tests\generation-candidate.test.ts
```

Expected GREEN: 각 terminal code와 latch flag가 표와 일치하고 cleanup은 case당 1회다. close/rm reject도 `completion`을 reject하지 않고 실패 finalization으로 resolve한다.

```ts
const settleWithCleanup = async (
  final: GenerationCandidateFinalization,
): Promise<GenerationCandidateFinalization> => {
  try {
    await cleanup();
    return final;
  } catch {
    if (final.outcome === "failed") return final;
    return {
      outcome: "failed",
      failure: {
        outcome: "failed",
        code: "generation_failed",
        summary: "생성 후보 정리를 완료하지 못했습니다.",
      },
      audit: { ...audit, termination: "generation_failed" },
      disableUntilRestart: false,
    };
  }
};

const finish = (final: GenerationCandidateFinalization): Promise<GenerationCandidateFinalization> => {
  if (!terminal) {
    phase = "terminal";
    terminal = settleWithCleanup(final);
  }
  return terminal;
};
const cancel = async () => {
  if (phase !== "terminal") phase = "cancelling";
  await finish(cancelledFinalization());
};
```

- [ ] **2.9 — 5분: base64와 PNG payload 신뢰 경계 RED를 쓴다**

fake completion의 `result`를 바꿔 다음을 각각 finalization한다.

```text
빈 문자열 → generation_failed
whitespace, URL-safe alphabet, 잘못된 padding, noncanonical base64 → generation_protocol_changed
decoded 예상 크기 16MiB + 1 → Buffer 생성 전 invalid_candidate
canonical base64이지만 비PNG/비정사각/손상/indexed PNG → invalid_candidate
정상 1×1 RGB와 128×128 RGBA → 병합 단계 진입
존재하지 않는 savedPath 동봉 → 읽기/삭제 없이 result만 사용
```

```ts
for (const result of ["AAAA\n", "____", "AAA=AAAA", "A==="]) {
  const final = await completeWithResult(result);
  assert.equal(final.outcome, "failed");
  assert.equal(final.failure.code, "generation_protocol_changed");
  assert.equal(final.disableUntilRestart, true);
}
const overLimit = Buffer.alloc(16 * 1024 * 1024 + 1).toString("base64");
const oversized = await completeWithResult(overLimit);
assert.equal(oversized.outcome, "failed");
assert.equal(oversized.failure.code, "invalid_candidate");
```

Run:

```powershell
& .\node_modules\.bin\tsx.cmd --test --test-name-pattern="base64|PNG payload" tests\generation-candidate.test.ts
```

Expected RED: canonical/크기 검사가 없어 잘못된 payload가 통과하거나 기대 code와 다르게 끝난다.

- [ ] **2.10 — 5분: canonical base64 decode와 PNG 검증을 구현한다**

validator는 `generation-candidate.ts`의 private 함수 하나로 둔다. 빈 result는 호출 실패로 먼저 분류한다. non-empty result는 standard base64 정규식, 4배수 길이, decoded 예상 크기, decode 후 크기와 canonical re-encode를 순서대로 검사한다. raw string은 helper 밖으로 반환하지 않는다.

```ts
const MAX_RESULT_BYTES = 16 * 1024 * 1024;
const STANDARD_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function decodeImageResult(raw: unknown): { bytes: Buffer; sha256: string } {
  if (typeof raw !== "string" || raw.length === 0 || raw.length % 4 !== 0 || !STANDARD_BASE64.test(raw)) {
    throw candidateError("generation_protocol_changed", "ImageGen 결과 형식이 변경되었습니다.");
  }
  const padding = raw.endsWith("==") ? 2 : raw.endsWith("=") ? 1 : 0;
  const estimatedBytes = raw.length / 4 * 3 - padding;
  if (estimatedBytes > MAX_RESULT_BYTES) throw candidateError("invalid_candidate", "생성 이미지가 너무 큽니다.");
  const bytes = Buffer.from(raw, "base64");
  if (bytes.length > MAX_RESULT_BYTES || bytes.toString("base64") !== raw) {
    throw candidateError("generation_protocol_changed", "ImageGen 결과 형식이 변경되었습니다.");
  }
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}
```

completion parser가 `decodeImageResult(item.result)`를 반환받는 즉시 `rawCompletion = undefined`와 `earlyEvents.length = 0`으로 event 객체 참조를 끊는다. finalization과 audit에는 decoded byte 수/hash, decoded PixelBuffer, normalized/preview만 전달하고 raw result 문자열이나 전체 notification을 넣지 않는다.

candidate options는 다음으로 고정한다.

```ts
decodePng(bytes, {
  maxInputBytes: 16 * 1024 * 1024,
  maxDimension: 2048,
  requireSquare: true,
  allowRgb: true,
});
```

optional `savedPath`와 Codex home artifact는 열기·복사·삭제·로그하지 않는다. decoded bytes를 검사한 뒤 `scalePixelBufferNearest(..., 128, 128)`로만 정규화한다.

Run:

```powershell
& .\node_modules\.bin\tsx.cmd --test --test-name-pattern="base64|PNG payload" tests\generation-candidate.test.ts
```

Expected GREEN: semantic base64 오류는 protocol latch, decoded PNG 오류는 `invalid_candidate`이며 `savedPath` 접근은 0회다.

- [ ] **2.11 — 5분: strict 병합·alpha·row-major RED를 쓴다**

하나의 128×128 fixture에서 선택 안/밖, 원본 alpha 255/127/0, 생성 alpha 255/0을 배치한다. 변경 command 좌표가 row-major·중복 없음·editable subset인지 검사한다. RGB source도 같은 결과여야 한다.

```ts
const final = await completeWithPixels({ original, generated, selection });
assert.equal(final.outcome, "completed");
assert.deepEqual(final.result.command.pixels.map(({ x, y }) => [x, y]), expectedRowMajorCoordinates);
assert.equal(new Set(final.result.command.pixels.map(({ x, y }) => `${x}:${y}`)).size, final.result.command.pixels.length);
assert.equal(final.audit.changedOutsideBytes, 0);
assert.equal(final.audit.alphaDiffBytes, 0);
```

Run:

```powershell
& .\node_modules\.bin\tsx.cmd --test --test-name-pattern="strict 병합|row-major" tests\generation-candidate.test.ts
```

Expected RED: strict 병합 또는 application 재사용이 없어 좌표·alpha·outside assertion이 실패한다.

- [ ] **2.12 — 5분: 기존 command/application으로 GREEN을 만든다**

```ts
for (let y = 0; y < 128; y += 1) for (let x = 0; x < 128; x += 1) {
  const pixel = y * 128 + x;
  const offset = pixel * 4;
  if (!mask[pixel] || original.data[offset + 3] === 0 || normalized.data[offset + 3] === 0) continue;
  const rgba = [
    normalized.data[offset],
    normalized.data[offset + 1],
    normalized.data[offset + 2],
    original.data[offset + 3],
  ] as RGBA;
  if (rgba.some((channel, index) => channel !== original.data[offset + index])) pixels.push({ x, y, rgba });
}
```

변경 0픽셀이면 `no_effect`다. 아니면 provisional `setPixels`를 기존 `applyCommand()`로 적용한 뒤 `createAiEditApplication(original, candidate, target)`을 호출한다. linked copy-on-write, diff, replay와 fingerprint를 다시 구현하지 않는다.

Run:

```powershell
& .\node_modules\.bin\tsx.cmd --test --test-name-pattern="strict 병합|row-major" tests\generation-candidate.test.ts
```

Expected GREEN: row-major 단일 command, outside byte 0, alpha diff 0과 replay 검증이 PASS한다.

- [ ] **2.13 — 5분: preview/hash/audit와 cleanup을 검증한다**

다음을 한 linked와 한 unlinked fixture에서 확인한다.

- 다른 frame/layer/cel bytes 불변
- target alpha 전체 불변
- outside byte diff 0
- preview decode bytes와 command replay target bytes 일치
- `candidateTargetHash`와 candidate fingerprint cel hash 일치
- normalized/preview PNG만 audit에 포함되고 raw base64, decoded raw PNG, `savedPath`는 없음
- success/failure/cancel 후 cwd `ENOENT`

```ts
const preview = decodePng(final.audit.previewPng!);
const replayed = applyCommand(snapshot, final.result.command);
assert.deepEqual(targetBytes(replayed, target), preview.data);
assert.equal(createAiEditBaseFingerprint(replayed, target).celHash, final.result.candidateTargetHash);
assert.deepEqual(final.result.preview, {
  mimeType: "image/png",
  base64: Buffer.from(final.audit.previewPng!).toString("base64"),
});
assert.equal("rawResult" in final.audit, false);
assert.equal("savedPath" in final.audit, false);
await assert.rejects(access(candidateCwd), { code: "ENOENT" });
```

Run:

```powershell
& .\node_modules\.bin\tsx.cmd --test tests\generation-candidate.test.ts tests\resize.test.ts tests\png.test.ts tests\ai-edit-application.test.ts tests\commands.test.ts
& .\node_modules\.bin\tsc.cmd --noEmit
```

Expected: 관련 test PASS, 실제 Codex/ImageGen 실행 0, type error 0.

- [ ] **2.14 — 3분: graph 갱신과 commit**

```powershell
graphify update .
git add src/server/generation-candidate.ts tests/generation-candidate.test.ts
git diff --cached --check
git commit -m "feat: create isolated generation candidates"
```

---

### Task 3: 기존 server에 무저장 candidate job, 로그와 candidate-only 호환성 latch를 연결한다

**Files:**

- Modify: `src/server/index.ts`
- Modify: `src/server/app.ts`
- Modify: `src/server/cell-edit-log.ts`
- Modify: `tests/server.test.ts`
- Modify: `tests/cell-edit-log.test.ts`

Task 3 내부 실행 순서는 의존성 때문에 `3.1 → 3.2 → 3.6 → 3.7 → 3.4(RED) → 3.3+3.5(한 GREEN batch) → 3.8 → 3.9 → 3.10`이다. logger exports를 만든 뒤 route를 연결하고, route와 finalizer는 중간 type error가 남지 않게 같은 GREEN batch에서 구현한다. 아래 배치는 server 계약을 먼저 읽을 수 있게 주제별로 묶은 것이며 숫자순 실행을 뜻하지 않는다.

**Interfaces:**

Produces:

```ts
type ServerLogWriteKind =
  | "initial" | "program" | "execution" | "attempt" | "verdict" | "preview" | "summary"
  | "candidateInitial" | "candidateFinalization";

export type ServerOptions = {
  projectsRoot: string;
  codex: CodexClient;
  cellEditCodex?: CodexClient;
  staticRoot?: string;
  cellEditApplicationTimeoutMs?: number;
  cellEditLogWriteBarrier?: (kind: ServerLogWriteKind) => Promise<void>;
  exportDialogs?: ExportDialogs;
  createGenerationCandidateCodex?: CreateGenerationCandidateCodex;
  generationCandidateTimeoutMs?: number;
};
```

Consumes:

```ts
startGenerationCandidate(
  input: { document: SpriteDocument; request: unknown },
  createCodex: CreateGenerationCandidateCodex,
  options?: { timeoutMs?: number },
): Promise<GenerationCandidateRun | GenerationCandidateBlockedFailure | GenerationCandidateStartFailure>;
createCellEditLog(projectRoot: string, jobId: string): CellEditLog;
// app.ts의 기존 lockProject(), unlockProject(), loadProject(), wireJob()과 send()를 그대로 재사용한다.
```

Produces server-only:

```ts
type ProjectGenerationJob = JobBase & {
  kind: "generation";
  request: SpriteSheetRequest | FrameRegenerationRequest;
  frameId?: string;
  outputPath: string;
  relativeOutputPath: string;
  approval?: { requestId: number; method: string; params: Record<string, unknown> };
  project?: SpriteProject;
};

type GenerationCandidateJob = JobBase & {
  kind: "generation";
  mode: "generation-candidate";
  frameId: string;
  candidateRun?: GenerationCandidateRun;
  inputAudit?: GenerationCandidateInputAudit;
  log: CellEditLog;
  logTail: Promise<void>;
  terminalFinalization?: Promise<void>;
  result?: GenerationCandidateResult;
  failureCode?: GenerationCandidateFailureCode;
  approval?: never;
};

type SharedCodexJob = ProjectGenerationJob | CellEditJob;
type Job = SharedCodexJob | GenerationCandidateJob;

const bridgeForJob = (job: SharedCodexJob): CodexClient => job.kind === "generation" ? codex : cellEditCodex!;
const isGenerationCandidateJob = (job: Job | undefined): job is GenerationCandidateJob =>
  job?.kind === "generation" && "mode" in job && job.mode === "generation-candidate";
const candidateStarts = new Set<Promise<void>>();

const isGenerationCandidateEnvelope = (
  value: unknown,
): value is { projectId?: unknown; request: Record<string, unknown> & { mode: "generation-candidate" } } => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as { request?: unknown };
  return Boolean(candidate.request)
    && typeof candidate.request === "object"
    && !Array.isArray(candidate.request)
    && (candidate.request as { mode?: unknown }).mode === "generation-candidate";
};

const appendCandidateLog = (
  job: GenerationCandidateJob,
  kind: ServerLogWriteKind,
  write: () => Promise<void>,
): Promise<void> => {
  const writing = job.logTail.catch(() => undefined).then(async () => {
    await cellEditLogWriteBarrier?.(kind);
    await write();
  });
  job.logTail = writing;
  return writing;
};

export type GenerationCandidateLogContext = {
  jobId: string;
  projectId: string;
  model: "app-server-default";
};
export function writeGenerationCandidateInitial(
  log: CellEditLog,
  context: GenerationCandidateLogContext,
  inputAudit: GenerationCandidateInputAudit,
): Promise<void>;
export function writeGenerationCandidateFinalization(
  log: CellEditLog,
  finalization: GenerationCandidateFinalization | GenerationCandidateStartFailure,
): Promise<void>;
```

Wire preserves: candidate 응답은 base job fields, `mode`, `frameId`, terminal `result` 또는 `failureCode`만 포함한다. bridge, run, cwd, audit, prompt, raw path, approval과 project는 포함하지 않는다.

- [ ] **3.1 — 5분: mode 분기와 wire RED를 쓴다**

`POST /api/generations`에서 `input.request.mode === "generation-candidate"`를 기존 sheet/frame cast보다 먼저 처리하는 테스트를 추가한다.

```text
factory 없음 또는 capability latch → HTTP 503, lock/job/Codex 0
unsupported_target/empty_selection → HTTP 400, job/Codex 0
start_failed → HTTP 202 failed candidate job, project 없음
started → HTTP 202 running candidate job, project/approval 없음
```

```ts
const unavailable = await postCandidate(serverWithoutFactory, validPayload);
assert.equal(unavailable.status, 503);
assert.equal(factory.calls, 0);

const blocked = await postCandidate(server, unsupportedPayload);
assert.equal(blocked.status, 400);
assert.equal((await blocked.json()).code, "unsupported_target");
assert.equal(factory.calls, 0);

factory.next = chatGptLoginFailure();
const failed = await postCandidate(server, validPayload);
assert.equal(failed.status, 202);
assert.deepEqual(pick(await failed.json(), "status", "failureCode"), {
  status: "failed",
  failureCode: "generation_failed",
});
```

Run:

```powershell
& .\node_modules\.bin\tsx.cmd --test --test-name-pattern="생성 후보" tests\server.test.ts
```

Expected RED: 기존 route가 mode를 일반 sprite-sheet request로 처리한다.

- [ ] **3.2 — 4분: 요청 시점 bridge factory만 production에 주입한다**

`src/server/index.ts`는 persistent candidate bridge를 만들지 않는다.

```ts
createGenerationCandidateCodex: async () => {
  const bridge = new CodexBridge();
  try {
    await bridge.start();
    return bridge;
  } catch (error) {
    await bridge.close(1_000).catch(() => undefined);
    throw error;
  }
},
```

이 factory는 candidate deep module만 호출하고 실패가 server boot를 막지 않는다. 일반 `codex`와 `cellEditCodex` 생성·종료 순서는 변경하지 않는다.

- [ ] **3.3 — 5분: candidate POST와 background completion을 연결한다**

optional factory와 server-local `generationCandidateUnavailable`을 project lock 전에 확인한다. 이후 lock, project load와 `startGenerationCandidate()`을 수행한다.

- blocked는 lock 해제 후 job 없이 400
- start_failed는 failed job을 map에 넣고 lock 해제 후 202
- started는 job을 map에 넣고 initial log write를 claim한 뒤 `run.completion`의 terminal finalization을 background로 연결

deep module이 candidate bridge event를 소유하므로 기존 `runToJob`, `bridgeForJob()`과 shared `handleCodexEvent()`에 candidate bridge를 넣지 않는다. 일반 generation finish branch를 수정하지 않는다.

`candidateStarts`에는 candidate branch의 lock/load/start부터 202/400/503 반환 직전까지를 나타내는 rejection-safe promise를 넣는다. `closing` 확인과 Set 등록 사이에는 `await`가 없으므로 server close가 새 미추적 start를 만들 수 없다. project load 뒤 실제 `startGenerationCandidate()` 직전에도 `closing`을 재검사한다. 클라이언트 socket이 먼저 닫혀도 Set promise는 유지되며 server close가 이를 기다린다.

```ts
if (request.method === "POST" && url.pathname === "/api/generations") {
  const input = await body(request);
  if (isGenerationCandidateEnvelope(input)) {
    if (closing || !createGenerationCandidateCodex || generationCandidateUnavailable) {
      return send(response, 503, { error: "현재 생성 후보 기능을 사용할 수 없습니다." });
    }
    const routeWork = (async () => {
      // 아래 candidate 전용 project id/lock/load/start/finalization 분기를 실행하고 반드시 return한다.
    })();
    const trackedStart = routeWork.then(() => undefined, () => undefined);
    candidateStarts.add(trackedStart);
    try {
      return await routeWork;
    } finally {
      candidateStarts.delete(trackedStart);
    }
  }
  // candidate가 아니면 현재 app.ts의 기존 project generation 본문을 그대로 이어서 실행한다.
}
```

```ts
if (closing) {
  unlockProject(project.id, jobId);
  return send(response, 503, { error: "서버가 종료되어 생성 후보를 시작하지 않았습니다." });
}
const started = await startGenerationCandidate(
  { document: project.document, request: input.request },
  createGenerationCandidateCodex,
  { timeoutMs: generationCandidateTimeoutMs },
);
if (closing) {
  if (started.outcome === "started") {
    await started.cancel();
    await started.completion;
  }
  unlockProject(project.id, jobId);
  return send(response, 503, { error: "서버가 종료되어 생성 후보를 시작하지 않았습니다." });
}
if (started.outcome === "blocked") {
  unlockProject(project.id, jobId);
  return send(response, 400, started);
}
const job: GenerationCandidateJob = {
  id: jobId,
  kind: "generation",
  mode: "generation-candidate",
  projectId: project.id,
  frameId: started.inputAudit.target.frameId,
  status: "running",
  messages: [],
  log: createCellEditLog(root, jobId),
  logTail: Promise.resolve(),
  inputAudit: started.inputAudit,
};
jobs.set(job.id, job);
const logContext: GenerationCandidateLogContext = {
  jobId: job.id,
  projectId: job.projectId,
  model: "app-server-default",
};
if (started.outcome === "start_failed") {
  job.terminalFinalization = (async () => {
    await appendCandidateLog(job, "candidateInitial", () =>
      writeGenerationCandidateInitial(job.log, logContext, started.inputAudit))
      .catch((error) => console.error("생성 후보 입력 로그를 기록하지 못했습니다.", error));
    await appendCandidateLog(job, "candidateFinalization", () =>
      writeGenerationCandidateFinalization(job.log, started))
      .catch((error) => console.error("생성 후보 시작 실패 로그를 기록하지 못했습니다.", error));
    job.failureCode = started.failure.code;
    job.error = started.failure.summary;
    job.status = "failed";
    job.inputAudit = undefined;
    unlockProject(project.id, job.id);
  })();
  await job.terminalFinalization;
} else {
  job.candidateRun = started;
  void appendCandidateLog(job, "candidateInitial", () =>
    writeGenerationCandidateInitial(job.log, logContext, started.inputAudit))
    .catch((error) => console.error("생성 후보 입력 로그를 기록하지 못했습니다.", error));
  void started.completion.then((final) => finalizeCandidateJob(job, final));
}
return send(response, 202, wireJob(job));
```

`ProjectGenerationJob`, `finishGeneration()`, `applyApproval()`은 project generation만 받고 `bridgeForJob()`, `connectRun()`과 기존 `interruptJob()`은 `SharedCodexJob`만 받게 좁힌다. candidate DELETE와 server close는 이 helper들을 호출하기 전에 candidate 전용 stop/finalization으로 분기한다. `wireJob()`은 `cellEdit` 분기보다 먼저 candidate를 검사해 base fields, `mode`, `frameId`, terminal `result` 또는 `failureCode`만 반환한다.

shared handler는 기존 `!job`의 ignored-run/early-event queue 블록을 그대로 둔 뒤 한 guard로 candidate를 제외한다. 이 guard를 `!job` 처리와 합치면 일반 generation/cell-edit의 start 반환 전 event가 유실되므로 금지한다. bridge error의 전체 job loop도 `bridgeForJob()` 호출 전에 candidate를 건너뛴다. `/api/approvals`는 job 조회 직후 candidate에 409를 반환하고 `applyApproval()`을 호출하지 않는다.

```ts
const job = jobId === undefined ? undefined : jobs.get(jobId);
if (!job) {
  if (ignoredRuns.get(bridge)?.has(runId)) {
    if (event.type === "approval") bridge.respond(event.requestId, { decision: "decline" });
    return;
  }
  const bridgeEvents = earlyEvents.get(bridge) ?? new Map<string, CodexEvent[]>();
  earlyEvents.set(bridge, bridgeEvents);
  const queued = bridgeEvents.get(runId) ?? [];
  queued.push(event);
  bridgeEvents.set(runId, queued);
  return;
}
if (isGenerationCandidateJob(job)) return;

for (const job of jobs.values()) {
  if (isGenerationCandidateJob(job) || bridgeForJob(job) !== bridge) continue;
  // 기존 shared bridge error 처리
}

// /api/approvals의 기존 !approval/!runId guard보다 먼저 둔다.
if (!job || job.kind !== "generation") {
  return send(response, 404, { error: "승인 요청을 찾을 수 없습니다." });
}
if (isGenerationCandidateJob(job)) {
  return send(response, 409, { error: "생성 후보는 승인 요청을 처리하지 않습니다." });
}
if (!job.approval || !job.runId) {
  return send(response, 404, { error: "승인 요청을 찾을 수 없습니다." });
}
```

기존 `DELETE /api/(generations|edits)/:id`에서는 candidate가 `runId`를 갖지 않으므로 `!job.runId` 404 guard보다 먼저 분기한다. terminal/finalizing candidate는 409, 실제 running candidate만 deep module cancel과 server finalization을 끝까지 기다린 뒤 200 wire를 반환한다.

```ts
if (!job || job.kind !== expectedKind) {
  return send(response, 404, { error: "작업을 찾을 수 없습니다." });
}
if (isGenerationCandidateJob(job)) {
  if (job.status !== "running" || job.terminalFinalization) {
    return send(response, 409, { error: "이미 종료 중이거나 종료된 작업입니다." });
  }
  await stopCandidateJob(job);
  return send(response, 200, wireJob(job));
}
if (!job.runId) return send(response, 404, { error: "작업을 찾을 수 없습니다." });
// 아래 기존 project generation/cell-edit DELETE 본문은 그대로 유지한다.
```

- [ ] **3.4 — 5분: 성공 무저장과 terminal 경쟁 RED를 쓴다**

FakeCodex로 유효 payload completion을 보낸 뒤 다음을 확인한다.

```text
status completed + candidate_ready
저장된 project manifest/image bytes 불변
generationHistory 불변
wire project/approval/cwd/audit 없음
candidate cwd ENOENT
lock 해제
```

같은 fixture에서 cancel, server close, late completion, late approval, timeout과 invalid output을 각각 한 번 검사한다. 모두 result 비공개, project 불변, cleanup과 lock 해제를 확인한다.

별도 close-during-start case는 `createCodex()` 또는 `startGeneration()` promise를 보류한 상태에서 `server.close()`를 호출한 뒤 promise를 해제한다. route가 start await 직후 `closing`을 재검사해 started run을 cancel하고 cwd/lock을 정리한 뒤에야 native close callback이 끝나야 한다. 재검사와 `jobs.set()` 사이에는 `await`를 두지 않아 close가 그 사이를 끼어들 수 없게 한다.

```ts
const before = await readPersistedProjectSnapshot(projectRoot);
const response = await postCandidate(server, validPayload);
fake.completeImage(validPngBase64);
const job = await waitForJob(response, "completed");
assert.equal(job.result.outcome, "candidate_ready");
assert.equal("project" in job, false);
assert.equal("approval" in job, false);
assert.deepEqual(await readPersistedProjectSnapshot(projectRoot), before);
assert.deepEqual((await loadProject(projectRoot)).generationHistory, originalHistory);
assert.equal((await saveSameProject(server, project)).status, 200);
```

Run:

```powershell
& .\node_modules\.bin\tsx.cmd --test --test-name-pattern="후보 무저장|terminal 경쟁|server close" tests\server.test.ts
```

Expected RED: candidate route/finalization이 없어 status, 무저장, lock 또는 close callback assertion이 실패한다.

- [ ] **3.5 — 5분: 단일 terminal finalization을 구현한다**

candidate job의 `terminalFinalization`을 첫 terminal 진입에서 동기 claim한다. protocol latch는 log await보다 먼저 동기 설정해 느린 writer 중 새 candidate가 시작되는 경쟁을 막는다. completion 결과는 로그 시도가 끝난 뒤 finalizer 안에서 직접 공개한다.

```ts
const finalizeCandidateJob = (job: GenerationCandidateJob, final: GenerationCandidateFinalization) => {
  if (job.terminalFinalization) return job.terminalFinalization;
  if (final.disableUntilRestart) generationCandidateUnavailable = true;
  const finalizing = (async () => {
    try {
      await appendCandidateLog(job, "candidateFinalization", () =>
        writeGenerationCandidateFinalization(job.log, final)).catch((error) =>
          console.error("생성 후보 최종 로그를 기록하지 못했습니다.", error));
      if (final.outcome === "completed") {
        job.result = final.result;
        job.status = "completed";
      } else if (final.outcome === "failed") {
        job.failureCode = final.failure.code;
        job.error = final.failure.summary;
        job.status = "failed";
      } else {
        job.status = "cancelled";
      }
    } finally {
      job.candidateRun = undefined;
      job.inputAudit = undefined;
      unlockProject(job.projectId, job.id);
    }
  })();
  job.terminalFinalization = finalizing;
  return finalizing;
};
```

`appendCandidateLog()`은 이전 write가 reject해도 다음 write를 실행하도록 `job.logTail`에 rejection continuation을 둔다. final log 실패는 server error로만 기록하고 위 inline status/result 공개를 계속 실행한다. terminal 뒤에는 `candidateRun`과 `inputAudit` 참조를 제거해 bridge closure와 binary audit가 job map 수명만큼 남지 않게 한다. 이를 위해 internal job의 두 field는 `GenerationCandidateRun | undefined`, `GenerationCandidateInputAudit | undefined`로 선언하되 생성 시에는 항상 채운다. late promise/event가 result나 lock을 다시 바꾸지 못하게 object identity와 terminal claim을 확인한다.

candidate DELETE와 server close는 실행 중 run을 지역 변수로 capture한 뒤 `cancel()`, `completion`, `finalizeCandidateJob()`을 차례로 await하는 같은 helper를 사용한다. server close는 native close를 즉시 시작하되 callback/test 완료는 native close와 모든 candidate finalization이 모두 끝난 뒤로 미룬다.

```ts
const stopCandidateJob = async (job: GenerationCandidateJob): Promise<void> => {
  const run = job.candidateRun;
  if (!run) {
    await job.terminalFinalization;
    return;
  }
  await run.cancel();
  await finalizeCandidateJob(job, await run.completion);
};

let candidateShutdown: Promise<void> = Promise.resolve();
const beginServerClose = (): Promise<void> => {
  if (closing) return candidateShutdown;
  closing = true;
  // 기존 export controller abort와 cell-edit fail을 그대로 실행한다.
  const candidates = [...jobs.values()].filter(isGenerationCandidateJob);
  const starts = [...candidateStarts];
  candidateShutdown = Promise.all([
    ...candidates.map((job) => stopCandidateJob(job)),
    ...starts,
  ]).then(() => undefined);
  return candidateShutdown;
};

const closeServer = server.close.bind(server);
server.close = ((callback?: (error?: Error) => void) => {
  const shutdown = beginServerClose();
  let nativeError: Error | undefined;
  const nativeClosed = new Promise<void>((resolveClose) => {
    closeServer((error) => { nativeError = error; resolveClose(); });
  });
  void Promise.all([nativeClosed, shutdown]).then(
    () => callback?.(nativeError),
    (error) => callback?.(error instanceof Error ? error : new Error(String(error))),
  );
  return server;
}) as typeof server.close;
server.on("close", () => { void beginServerClose(); });
```

Run:

```powershell
& .\node_modules\.bin\tsx.cmd --test --test-name-pattern="후보 무저장|terminal 경쟁|server close" tests\server.test.ts
```

Expected GREEN: terminal 공개·lock 해제는 log 시도 뒤 한 번만 일어나고 server close callback은 native close와 candidate finalization 뒤 한 번 호출된다.

- [ ] **3.6 — 5분: candidate 로그 RED를 쓴다**

성공 job은 다음만 남겨야 한다.

```text
request.json
candidate-normalized.png
candidate-preview.png
candidate.json
```

실패 job은 실제 단계까지 생성된 파일과 `candidate.json`만 남긴다. `request.json`에는 trimmed prompt, target, fingerprint, selection count와 input hashes를 기록한다. `candidate.json`에는 관측 start/completion 수, termination, failure code와 audit 수치를 기록한다. raw base64, decoded raw PNG, `savedPath`와 bridge event 원문은 없어야 한다.

```ts
assert.deepEqual((await readdir(log.absoluteDir)).sort(), [
  "candidate-normalized.png",
  "candidate-preview.png",
  "candidate.json",
  "request.json",
]);
const logged = await readFile(join(log.absoluteDir, "candidate.json"), "utf8");
assert.equal(logged.includes(rawResult), false);
assert.equal(logged.includes("savedPath"), false);
assert.equal(JSON.parse(logged).imageGenerationStartsObserved, 1);
```

Run:

```powershell
& .\node_modules\.bin\tsx.cmd --test --test-name-pattern="생성 후보 로그" tests\cell-edit-log.test.ts
```

Expected RED: candidate writer가 없어 파일 목록 또는 민감 데이터 부재 assertion이 실패한다.

- [ ] **3.7 — 5분: 기존 순차 logger를 initial/final writer로만 확장한다**

```ts
export type GenerationCandidateLogContext = {
  jobId: string;
  projectId: string;
  model: "app-server-default";
};

export function writeGenerationCandidateInitial(
  log: CellEditLog,
  context: GenerationCandidateLogContext,
  inputAudit: GenerationCandidateInputAudit,
): Promise<void>;

export function writeGenerationCandidateFinalization(
  log: CellEditLog,
  finalization: GenerationCandidateFinalization | GenerationCandidateStartFailure,
): Promise<void>;
```

```ts
export async function writeGenerationCandidateInitial(log, context, inputAudit) {
  await mkdir(log.absoluteDir, { recursive: true });
  const target = pathFor(log, "request.json");
  await writeFile(target.absolute, `${JSON.stringify({ ...context, ...inputAudit }, null, 2)}\n`, "utf8");
  log.files.push(target.relative);
}

export async function writeGenerationCandidateFinalization(log, finalization) {
  const { normalizedPng, previewPng, ...audit } = finalization.audit;
  if (normalizedPng) await writeLoggedBytes(log, "candidate-normalized.png", normalizedPng);
  if (finalization.outcome === "completed" && previewPng) {
    await writeLoggedBytes(log, "candidate-preview.png", previewPng);
  }
  const failureCode = finalization.outcome === "failed" || finalization.outcome === "start_failed"
    ? finalization.failure.code
    : undefined;
  await writeLoggedJson(log, "candidate.json", {
    jobId: log.jobId,
    outcome: finalization.outcome,
    failureCode,
    ...audit,
    files: [...log.files],
  });
}
```

기존 `CellEditLog`, 순차 write와 partial file list 패턴을 재사용한다. 별도 repository/logger class를 만들지 않는다. initial writer는 `request.json`, final writer는 안전하게 고른 audit field와 normalized/preview PNG만 쓴다. finalization 객체 전체를 `JSON.stringify()`하지 않는다. preflight blocked에는 job과 log를 만들지 않는다. candidate 로그 실패는 공개 candidate 결과를 바꾸지 않으며 server error 로그만 남긴다. disposition writer는 Task 4에서 추가한다.

Run:

```powershell
& .\node_modules\.bin\tsx.cmd --test --test-name-pattern="생성 후보 로그" tests\cell-edit-log.test.ts
```

Expected GREEN: 단계별 파일만 남고 raw base64, raw event와 `savedPath` 문자열은 기록되지 않는다.

- [ ] **3.8 — 4분: protocol mismatch가 candidate만 비활성화하는지 검증한다**

첫 job을 `generation_protocol_changed`로 끝낸 뒤 두 번째 candidate POST가 factory, temp, lock 없이 503인지 확인한다. 같은 server에서 일반 generation endpoint와 cell-edit test fixture는 기존 bridge를 계속 호출할 수 있어야 한다. Codex version 문자열은 test fixture에 넣지 않는다.

```ts
const first = await postCandidate(server, validPayload);
assert.equal(first.status, 202);
fake.completeWithProtocolMismatch();
assert.equal((await postCandidate(server, validPayload)).status, 503);
assert.equal((await getCandidateJob(server, candidateId)).status, "failed");

const runningCandidate = await postCandidate(freshServer, validPayload);
sharedCodex.emit({ type: "error", message: "shared failure" });
assert.equal((await getJob(freshServer, runningCandidate.id)).status, "running");
candidateCodex.emit({ type: "error", message: "candidate failure" });
assert.equal((await getJob(freshServer, ordinaryGenerationId)).status, "running");
assert.equal((await getJob(freshServer, cellEditId)).status, "running");
```

별도 fixture에서는 candidate가 running일 때 shared `codex` error가 candidate를 실패시키지 않는지, candidate bridge error가 일반 generation/cell-edit 상태를 바꾸지 않는지 확인한다.

Run:

```powershell
& .\node_modules\.bin\tsx.cmd --test --test-name-pattern="candidate 호환성 격리|shared bridge 격리" tests\server.test.ts
```

Expected: protocol mismatch 확정 직후 다음 candidate만 503이고 일반 generation/cell-edit fixture는 계속 running 또는 정상 완료한다.

- [ ] **3.9 — 5분: server/log 회귀를 통과시킨다**

Run:

```powershell
& .\node_modules\.bin\tsx.cmd --test tests\server.test.ts tests\cell-edit-log.test.ts
& .\node_modules\.bin\tsc.cmd --noEmit
```

Expected: server/log tests PASS, 실제 Codex/ImageGen 0, type error 0.

- [ ] **3.10 — 3분: graph 갱신과 commit**

```powershell
graphify update .
git add src/server/index.ts src/server/app.ts src/server/cell-edit-log.ts tests/server.test.ts tests/cell-edit-log.test.ts
git diff --cached --check
git commit -m "feat: add generation candidate jobs"
```

---

### Task 4: 완료 candidate의 첫 disposition 하나를 멱등 로그로 기록한다

**Files:**

- Modify: `src/server/app.ts`
- Modify: `src/server/cell-edit-log.ts`
- Modify: `tests/server.test.ts`
- Modify: `tests/cell-edit-log.test.ts`

**Interfaces:**

Consumes:

```ts
// Task 3의 GenerationCandidateJob 전체 타입에서 mode/status/result/log/logTail을 소비한다.
declare const GENERATION_CANDIDATE_DISPOSITIONS: readonly [
  "applied", "regenerated", "discarded", "stale_base", "apply_failed",
];
appendCandidateLog(
  job: GenerationCandidateJob,
  kind: ServerLogWriteKind,
  write: () => Promise<void>,
): Promise<void>;
```

Produces:

```http
POST /api/generations/:id/disposition
Content-Type: application/json

{ "disposition": "applied" | "regenerated" | "discarded" | "stale_base" | "apply_failed" }
```

성공 응답은 `200 { disposition }`이고 candidate job status/result/project lock은 바꾸지 않는다.

Server-only additions:

```ts
type GenerationCandidateJob = {
  disposition?: GenerationCandidateDisposition;
  dispositionWrite?: Promise<void>;
};

// Task 3의 기존 barrier parameter union 끝에 이 단계에서만 추가한다.
type ServerLogWriteKind =
  | "initial" | "program" | "execution" | "attempt" | "verdict" | "preview" | "summary"
  | "candidateInitial" | "candidateFinalization" | "candidateDisposition";

export function writeGenerationCandidateDisposition(
  log: CellEditLog,
  disposition: GenerationCandidateDisposition,
): Promise<void>;
```

writer는 기존 private `pathFor()`와 `writeFile()`을 재사용해 `disposition.json`에 `{ jobId: log.jobId, disposition }`만 기록하고 성공한 뒤 `log.files`에 한 번 추가한다.

- [ ] **4.1 — 5분: 완료 candidate 전용·동시 멱등 RED를 쓴다**

같은 disposition을 순차·동시에 두 번 보내면 둘 다 200이고 `disposition.json`은 한 번만 기록되어야 한다. 다른 값은 409다. 존재하지 않거나 일반 generation/cell-edit id는 404, running/failed/cancelled candidate 또는 result 없는 completed candidate는 409이며 파일을 만들지 않는다.

`null`, 숫자, 빈 문자열과 allowlist 밖 문자열은 job 조회·claim보다 먼저 400이고 writer 호출 0회여야 한다.

```ts
const [left, right] = await Promise.all([
  postDisposition(server, candidateId, "applied"),
  postDisposition(server, candidateId, "applied"),
]);
assert.equal(left.status, 200);
assert.equal(right.status, 200);
assert.equal(dispositionWrites, 1);
assert.equal((await postDisposition(server, candidateId, "discarded")).status, 409);
assert.equal((await postDisposition(server, ordinaryGenerationId, "applied")).status, 404);
assert.equal((await postDisposition(server, runningCandidateId, "discarded")).status, 409);
for (const invalid of [null, 1, "", "unknown"]) {
  assert.equal((await postRawDisposition(server, candidateId, invalid)).status, 400);
}
assert.equal(dispositionWrites, 1);
```

Run:

```powershell
& .\node_modules\.bin\tsx.cmd --test --test-name-pattern="후보 disposition" tests\server.test.ts tests\cell-edit-log.test.ts
```

Expected RED: route가 없어 404가 반환된다.

- [ ] **4.2 — 5분: sync claim과 단일 writer promise를 구현한다**

```ts
const input = await body(request) as { disposition?: unknown };
if (typeof input.disposition !== "string"
  || !GENERATION_CANDIDATE_DISPOSITIONS.includes(input.disposition as GenerationCandidateDisposition)) {
  return send(response, 400, { error: "후보 결정 값이 올바르지 않습니다." });
}
const disposition = input.disposition as GenerationCandidateDisposition;

if (job.disposition && job.disposition !== disposition) {
  return send(response, 409, { error: "이미 다른 후보 결정을 기록했습니다." });
}
let writing = job.dispositionWrite;
if (!writing) {
  job.disposition = disposition;
  writing = appendCandidateLog(job, "candidateDisposition", () =>
    writeGenerationCandidateDisposition(job.log, disposition));
  job.dispositionWrite = writing;
}
try {
  await writing;
} catch {
  if (job.dispositionWrite === writing) job.dispositionWrite = undefined;
  return send(response, 500, { error: "후보 결정을 기록하지 못했습니다." });
}
return send(response, 200, { disposition: job.disposition });
```

첫 값을 await 전에 claim한다. 같은 값은 같은 promise를 같은 `try/catch` 안에서 await하므로 최초 요청과 follower 모두 writer failure에 500을 반환한다. writer가 실패해도 `job.disposition`은 유지하고 실패한 `dispositionWrite`만 identity guard로 비운다. 따라서 같은 값은 재시도할 수 있지만 다른 값은 계속 409다. 완료 job과 result는 변경하지 않는다.

- [ ] **4.3 — 4분: 로그 실패 독립성과 회귀를 통과시킨다**

writer failure POST는 정확히 500을 반환하지만 subsequent GET은 같은 completed result를 반환해야 한다. 같은 값 재시도 성공 뒤 파일은 하나여야 한다. rollback API와 disposition 상태 머신을 추가하지 않는다.

```ts
barrier.rejectOnce("candidateDisposition");
assert.equal((await postDisposition(server, candidateId, "applied")).status, 500);
assert.equal((await getJob(server, candidateId)).result.outcome, "candidate_ready");
assert.equal((await postDisposition(server, candidateId, "discarded")).status, 409);
assert.equal((await postDisposition(server, candidateId, "applied")).status, 200);
assert.equal((await readdir(logDir)).filter((name) => name === "disposition.json").length, 1);
```

Run:

```powershell
& .\node_modules\.bin\tsx.cmd --test tests\server.test.ts tests\cell-edit-log.test.ts
& .\node_modules\.bin\tsc.cmd --noEmit
```

Expected: 두 test 파일 PASS, type error 0.

- [ ] **4.4 — 3분: graph 갱신과 commit**

```powershell
graphify update .
git add src/server/app.ts src/server/cell-edit-log.ts tests/server.test.ts tests/cell-edit-log.test.ts
git diff --cached --check
git commit -m "feat: record generation candidate decisions"
```

---

### Task 5: 클라이언트에서 후보를 비교하고 stale-safe 단일 command로 적용한다

**Files:**

- Modify: `src/client/api.ts`
- Modify: `src/client/editor/EditorWorkspace.tsx`
- Modify: `src/client/App.tsx`
- Modify: `src/client/styles.css`
- Modify: `tests/client-api.test.ts`
- Modify: `tests/editor-workspace.test.ts`

**Interfaces:**

Consumes:

```ts
decodeProject(value: SpriteProject | WireProject): SpriteProject;
completedFrameIndex(
  project: SpriteProject | undefined,
  requestedFrameId?: string,
  responseFrameId?: string,
): number;
selectionRuns(
  mask: Uint8Array | undefined,
  image: PixelBuffer,
  cel: Cel,
  document: SpriteDocument,
): AiSelectionRun[] | undefined;
createAiEditBaseFingerprint(document: SpriteDocument, target: AiEditTarget): AiEditBaseFingerprint;
assertAiEditApplicationBase(document: SpriteDocument, application: AiEditApplication): void;
applyCommand(document: SpriteDocument, command: EditCommand): SpriteDocument;
projectLifetimeMatches(current: ProjectLifetime | undefined, expected: ProjectLifetime): boolean;
projectJobOwnershipMatches(
  currentProject: ProjectLifetime | undefined,
  activeJob: ProjectJobOwnership | undefined,
  expected: ProjectJobOwnership,
): boolean;
releaseProjectJobOwnership(
  current: ProjectJobOwnership | undefined,
  owner: ProjectJobOwnership,
): ProjectJobOwnership | undefined;
// 현재 App.tsx local 함수: poll(started, ownership, requestedFrameId?): Promise<void>
```

Produces:

```ts
type GenerationCandidateState =
  | { status: "completed"; result: GenerationCandidateResult; failureCode?: never }
  | { status: "failed"; result?: never; failureCode: GenerationCandidateFailureCode }
  | { status: Exclude<JobBase["status"], "completed" | "failed">; result?: never; failureCode?: never };

export type GenerationCandidateJob = Omit<JobBase, "status"> & {
  kind: "generation";
  mode: "generation-candidate";
  frameId: string;
  approval?: never;
  project?: never;
} & GenerationCandidateState;

export type GenerationJob = JobBase & {
  kind: "generation";
  mode?: never;
  frameId?: string;
  approval?: { requestId: number; method: string };
  project?: SpriteProject | WireProject;
};

export function isGenerationCandidateJob(job: CodexJob | undefined): job is GenerationCandidateJob;
export function generationCandidatePayload(
  projectId: string,
  request: GenerationEditRequest,
): { projectId: string; request: GenerationEditRequest };
export function completedGeneration(
  job: GenerationJob | GenerationCandidateJob,
  requestedFrameId?: string,
):
  | { kind: "candidate"; result: GenerationCandidateResult }
  | { kind: "project"; project: SpriteProject; frameIndex: number }
  | undefined;
export function generationCandidateFailureNotice(code: GenerationCandidateFailureCode): string;
export type GenerationCandidatePollDecision =
  | { kind: "continue"; keepOwnership: true }
  | { kind: "review"; keepOwnership: true; result: GenerationCandidateResult }
  | { kind: "failed"; keepOwnership: false; message: string }
  | { kind: "cancelled"; keepOwnership: false };
export function generationCandidatePollDecision(
  started: GenerationCandidateJob,
  next: CodexJob,
): GenerationCandidatePollDecision;
export function claimCodexStart(
  claim: { current: boolean },
  activeJob: ProjectJobOwnership | undefined,
): boolean;
export function failedCodexJob(
  job: GenerationJob | CellEditJob | undefined,
  id: string,
  error: string,
): GenerationJob | CellEditJob | undefined;

// App.tsx local 함수의 수정 후 서명
// poll(started, ownership, requestedFrameId?): Promise<"candidate_review" | void>

export type EditorWorkspaceHandle = {
  captureAiEditRequest(prompt: string): AiEditRequest;
  applyAiEdit(target: AiEditTarget, result: AiEditReadyResult): {
    summary: string;
    documentChanged: boolean;
    rollback(): void;
  };
  captureGenerationCandidateRequest(prompt: string): GenerationEditRequest;
  applyGenerationCandidate(result: GenerationCandidateResult):
    | { disposition: "applied"; summary: string; documentChanged: boolean }
    | { disposition: "stale_base" | "apply_failed"; error: string };
};

export type GenerationPanelContext = {
  hasActiveCel: boolean;
  activeLayerLocked: boolean;
  hasSelection: boolean;
};
```

기존 `GenerationJob`에는 `mode?: never`만 더해 candidate와 구분하고 `CodexJob` union에 `GenerationCandidateJob`을 추가한다. 기존 project generation completion, cell-edit 적용, project lifetime과 History interface를 유지한다.

- [ ] **5.1 — 5분: client wire/payload/failure notice RED를 쓴다**

`generationCandidatePayload(projectId, request)`가 `{ projectId, request }`만 반환하고 candidate completed가 project 없이 decode되는지 검사한다. 기존 project completion fixture는 실제 wire와 같이 image `data: number[]`를 사용하고, `completedGeneration()`이 이를 `decodeProject()`한 뒤 frame id를 검증하는지 확인한다. 한 helper에서 두 variant를 구분한다.

```ts
assert.deepEqual(generationCandidatePayload("project-1", candidateRequest), {
  projectId: "project-1",
  request: candidateRequest,
});
assert.deepEqual(completedGeneration(completedCandidate), {
  kind: "candidate",
  result: completedCandidate.result,
});
assert.deepEqual(completedGeneration(completedProjectGeneration, requestedFrameId), {
  kind: "project",
  project: decodeProject(completedProjectGeneration.project!),
  frameIndex: 2,
});
assert.throws(() => completedGeneration(mismatchedFrameGeneration, requestedFrameId), /프레임 ID/);

const sharedStartClaim = { current: false };
assert.equal(claimCodexStart(sharedStartClaim, undefined), true);  // candidate 획득
assert.equal(claimCodexStart(sharedStartClaim, undefined), false); // 같은 tick의 ordinary 시작 거부
sharedStartClaim.current = false;
assert.equal(claimCodexStart(sharedStartClaim, activeOwnership), false);

assert.deepEqual(generationCandidatePollDecision(runningCandidate, completedCandidate), {
  kind: "review",
  keepOwnership: true,
  result: completedCandidate.result,
});
assert.deepEqual(generationCandidatePollDecision(runningCandidate, failedCandidate), {
  kind: "failed",
  keepOwnership: false,
  message: generationCandidateFailureNotice(failedCandidate.failureCode),
});
assert.throws(() => generationCandidatePollDecision(runningCandidate, completedProjectGeneration), /작업 모드/);
```

failure notice는 다음 행동을 명시한다.

| code | 안내 핵심 |
|---|---|
| `generation_failed` | 생성 실패, 사용자가 명시적으로 다시 시도 |
| `generation_protocol_changed` | 현재 Codex와 candidate 호환 불가, 다른 편집 기능 사용 |
| `multiple_generation_detected` | 추가 생성 시작 감지로 결과 폐기, 이미 시작된 사용량 가능 |
| `invalid_candidate` | 안전 검사 실패, 명시 재생성 |
| `no_effect` | selection 또는 prompt 조정 |

Run:

```powershell
& .\node_modules\.bin\tsx.cmd --test tests\client-api.test.ts
```

Expected RED: candidate wire/helper가 없어 compile 또는 assertion이 실패한다.

- [ ] **5.2 — 4분: client candidate union과 helper를 GREEN으로 만든다**

```ts
export function isGenerationCandidateJob(job: CodexJob | undefined): job is GenerationCandidateJob {
  return job?.kind === "generation" && "mode" in job && job.mode === "generation-candidate";
}

export function generationCandidatePayload(projectId: string, request: GenerationEditRequest) {
  return { projectId, request };
}

export function completedGeneration(job: GenerationJob | GenerationCandidateJob, requestedFrameId?: string) {
  if (job.status !== "completed") return undefined;
  if (isGenerationCandidateJob(job)) return { kind: "candidate" as const, result: job.result };
  if (!job.project) throw new Error("완료된 생성 결과가 없습니다.");
  const project = decodeProject(job.project);
  return {
    kind: "project" as const,
    project,
    frameIndex: completedFrameIndex(project, requestedFrameId, job.frameId),
  };
}

export function generationCandidatePollDecision(
  started: GenerationCandidateJob,
  next: CodexJob,
): GenerationCandidatePollDecision {
  if (next.id !== started.id || !isGenerationCandidateJob(next)) {
    throw new Error("작업 모드가 요청과 일치하지 않습니다.");
  }
  if (next.status === "completed") return { kind: "review", keepOwnership: true, result: next.result };
  if (next.status === "failed") {
    return { kind: "failed", keepOwnership: false, message: generationCandidateFailureNotice(next.failureCode) };
  }
  if (next.status === "cancelled") return { kind: "cancelled", keepOwnership: false };
  return { kind: "continue", keepOwnership: true };
}

export function claimCodexStart(
  claim: { current: boolean },
  activeJob: ProjectJobOwnership | undefined,
): boolean {
  if (claim.current || activeJob) return false;
  claim.current = true;
  return true;
}
```

`generationCandidateFailureNotice()`는 위 표의 다섯 code를 exhaustive `switch`로 반환한다. `codexJobStatusTitle()`도 candidate mode를 먼저 분기해 일반 frame regeneration 문구로 잘못 표시하지 않게 한다. `failedCodexJob()`은 ordinary `GenerationJob | CellEditJob`만 받아 transport error가 candidate wire의 필수 `failureCode`를 위조하지 못하게 한다. 기존 setter 호출부는 candidate guard 뒤에만 이 helper를 호출한다. 별도 wire decoder class는 만들지 않는다.

```ts
setJob((current) => isGenerationCandidateJob(current)
  ? current
  : failedCodexJob(current, started.id, message));
```

- [ ] **5.3 — 4분: selection capture RED를 쓴다**

기존 imperative ref fixture를 재사용한다. selection이 없거나 mask가 모두 0이면 안내 오류를 내고, 유효 selection은 기존 `selectionRuns()`의 document-coordinate runs, 현재 target, trimmed prompt와 explicit mode를 반환해야 한다.

`GenerationPanelContext`에는 `hasSelection` boolean 하나만 추가한다. 새 선택 도구나 자동 부위 인식은 만들지 않는다.

```ts
assert.throws(() => handle.captureGenerationCandidateRequest("교체"), /선택 영역/);
fixture.select([{ x: 2, y: 3 }, { x: 3, y: 3 }]);
assert.deepEqual(handle.captureGenerationCandidateRequest("  나무 갑옷  "), {
  mode: "generation-candidate",
  prompt: "나무 갑옷",
  target: { frameId, layerId, celId },
  editableSelection: [{ y: 3, startX: 2, endX: 3 }],
});
assert.equal(latestPanelContext.hasSelection, true);
```

Run:

```powershell
& .\node_modules\.bin\tsx.cmd --test --test-name-pattern="생성 후보 selection capture" tests\editor-workspace.test.ts
```

Expected RED: handle method와 `hasSelection`이 없어 typecheck 또는 assertion이 실패한다.

- [ ] **5.4 — 4분: 기존 selection helper로 capture를 GREEN으로 만든다**

```ts
captureGenerationCandidateRequest(prompt) {
  if (!cel || !image) throw new Error("현재 프레임의 활성 셀이 없습니다.");
  const editableSelection = selectionRuns(selection, image, cel, project.document);
  if (!editableSelection?.length) throw new Error("먼저 교체할 영역을 선택해 주세요.");
  const trimmed = prompt.trim();
  if (!trimmed) throw new Error("생성 요청을 입력해 주세요.");
  return {
    mode: "generation-candidate",
    prompt: trimmed,
    target: { frameId: frame.id, layerId: activeLayerId, celId: cel.id },
    editableSelection,
  };
}
```

`generationPanel()`에는 `hasSelection: Boolean(selection?.some(Boolean))`을 전달한다. 서버 preflight가 authoritative하므로 이 단계에서 별도 문서 validator를 복제하지 않는다.

Run:

```powershell
& .\node_modules\.bin\tsx.cmd --test --test-name-pattern="생성 후보 selection capture" tests\editor-workspace.test.ts
```

Expected GREEN: selection 없음/빈 prompt가 거부되고 유효 selection은 document-coordinate runs로 반환된다.

- [ ] **5.5 — 5분: stale/replay/hash/History RED를 쓴다**

기존 workspace History spy로 다음을 확인한다.

```text
base fingerprint 변경 → stale_base, execute 0
target frame/layer/cel 소실 또는 활성 target 전환 → stale_base, execute 0
target layer hidden/locked 또는 opacity 0 → apply_failed, execute 0
command replay target hash 불일치 → apply_failed, execute 0
유효 result → applied, execute 정확히 1, target bytes가 preview와 일치
```

```ts
const stale = handle.applyGenerationCandidate(resultWithOldFingerprint);
assert.equal(stale.disposition, "stale_base");
assert.equal(history.executeCalls, 0);

const forged = handle.applyGenerationCandidate({ ...result, candidateTargetHash: "forged" });
assert.equal(forged.disposition, "apply_failed");
assert.equal(history.executeCalls, 0);

const applied = handle.applyGenerationCandidate(result);
assert.equal(applied.disposition, "applied");
assert.equal(history.executeCalls, 1);
assert.deepEqual(targetBytes(history.current.document, target), decodePngBase64(result.preview.base64).data);
```

Run:

```powershell
& .\node_modules\.bin\tsx.cmd --test --test-name-pattern="생성 후보 적용" tests\editor-workspace.test.ts
```

Expected RED: candidate apply seam이 없어 compile되거나 stale/hash/History count assertion이 실패한다.

- [ ] **5.6 — 5분: 기존 application/fingerprint 경로로 적용을 구현한다**

```ts
const target = {
  frameId: result.baseFingerprint.frameId,
  layerId: result.baseFingerprint.layerId,
  celId: result.baseFingerprint.celId,
};
if (frame.id !== target.frameId || activeLayerId !== target.layerId || cel?.id !== target.celId) {
  return { disposition: "stale_base", error: "후보를 만든 대상이 변경되었습니다." };
}
try {
  assertAiEditApplicationBase(history.current.document, result);
} catch (error) {
  return { disposition: "stale_base", error: error instanceof Error ? error.message : String(error) };
}
if (!activeLayer?.visible || activeLayer.locked || activeLayer.opacity <= 0 || cel.opacity <= 0) {
  return { disposition: "apply_failed", error: "현재 레이어 또는 셀에는 후보를 적용할 수 없습니다." };
}
let replayed: SpriteDocument;
try {
  replayed = applyCommand(history.current.document, result.command);
} catch (error) {
  return { disposition: "apply_failed", error: error instanceof Error ? error.message : String(error) };
}
if (createAiEditBaseFingerprint(replayed, target).celHash !== result.candidateTargetHash) {
  return { disposition: "apply_failed", error: "후보 재생 결과가 미리보기와 다릅니다." };
}
const before = history.current.document;
const document = history.current.execute(result.command);
emitted.current = document;
onChange({ ...project, document });
return { disposition: "applied", summary: result.summary, documentChanged: document !== before };
```

검증 전 editor state를 바꾸지 않는다. 기존 `applyAiEdit()`를 candidate용으로 리팩터링하지 않고 새 seam에서 기존 helper를 재사용한다.

Run:

```powershell
& .\node_modules\.bin\tsx.cmd --test --test-name-pattern="생성 후보 적용" tests\editor-workspace.test.ts
```

Expected GREEN: 모든 실패 case에서 execute 0, 유효 case에서 execute 1과 preview target byte 일치.

- [ ] **5.7 — 5분: App polling과 preview를 project completion보다 먼저 연결한다**

`선택 영역 생성 교체`는 workspace request capture와 기존 save-before-Codex 뒤 candidate POST를 한다. polling에서 completed candidate는 project decode/교체를 하지 않고 job result를 review source로 유지한다.

```ts
const codexStartInFlight = useRef(false);

const startGenerationCandidateFromCurrentWorkspace = async () => {
  const workspace = editor.current;
  if (!session || !project || !workspace) return;
  if (!claimCodexStart(codexStartInFlight, activeJobOwnership.current)) {
    setError("현재 Codex 작업 또는 생성 후보 결정을 먼저 마쳐 주세요.");
    return;
  }
  try {
    const lifetime = beginProjectLifetime(project.id);
    setError("");
    setNotice("");
    setStartingKind("generation");
    const request = workspace.captureGenerationCandidateRequest(prompt);
    if (!await save(lifetime) || !projectLifetimeMatches(projectLifetime.current, lifetime)) return;
    const next = await api<GenerationCandidateJob>("/api/generations", session.token, {
      method: "POST",
      body: JSON.stringify(generationCandidatePayload(project.id, request)),
    });
    if (!projectLifetimeMatches(projectLifetime.current, lifetime)) {
      await api(`/api/generations/${next.id}`, session.token, { method: "DELETE" }).catch(() => undefined);
      return;
    }
    const ownership = { ...lifetime, jobId: next.id };
    activeJobOwnership.current = ownership;
    candidateClaim.current = undefined;
    setCandidateApplyBlocked(false);
    setJob(next);
    setStartingKind(undefined);
    let keepCandidateReview = false;
    void poll(next, ownership)
      .then((outcome) => { keepCandidateReview = outcome === "candidate_review"; })
      .catch(async (reason) => {
        if (!projectJobOwnershipMatches(projectLifetime.current, activeJobOwnership.current, ownership)) return;
        await api(`/api/generations/${next.id}`, session.token, { method: "DELETE" }).catch(() => undefined);
        const message = reason instanceof Error ? reason.message : String(reason);
        setError(message);
        setJob((current) => current?.id === next.id ? undefined : current);
      })
      .finally(() => {
        if (!keepCandidateReview) {
          activeJobOwnership.current = releaseProjectJobOwnership(activeJobOwnership.current, ownership);
        }
      });
  } catch (reason) {
    setError(reason instanceof Error ? reason.message : String(reason));
  } finally {
    codexStartInFlight.current = false;
    setStartingKind(undefined);
  }
};
```

`codexStartInFlight`는 App 전체에서 `useRef(false)` 하나만 둔다. candidate 전용 ref를 만들지 않는다. `generate()`, `editCurrentCell()`과 `startGenerationCandidateFromCurrentWorkspace()`가 모두 `beginProjectLifetime()`보다 먼저 같은 `claimCodexStart(codexStartInFlight, activeJobOwnership.current)`를 호출한다. 획득 실패는 같은 안내를 표시하고 정상 반환한다. claim 다음 문장은 반드시 `try`이고, `beginProjectLifetime()`, state setter, capture, save, POST와 ownership handoff를 포함한 모든 post-claim 문장을 그 `try/finally` 안에 둔다. 모든 early return과 throw에서 `codexStartInFlight.current = false`를 실행한다. 특히 `editCurrentCell()`의 request capture도 이 `try/finally` 안으로 옮겨 lifetime/capture 실패가 claim을 남기지 않게 한다. POST가 반환되면 먼저 기존 `activeJobOwnership`을 동기 설정하고, 그 뒤 finally가 start claim을 해제한다. 그러므로 React state가 반영되기 전 candidate↔일반 generation/cell edit 교차 호출도 하나만 진입하고, handoff 뒤 running/review는 기존 ownership이 막는다. `다시 생성`은 old review ownership을 동기 해제한 뒤 같은 함수를 호출하므로 명시적 새 시도는 허용된다.

ordinary handler에 추가할 경계는 다음 모양으로 제한한다. 기존 body와 polling은 바꾸지 않는다.

```ts
if (!claimCodexStart(codexStartInFlight, activeJobOwnership.current)) {
  setError("현재 Codex 작업 또는 생성 후보 결정을 먼저 마쳐 주세요.");
  return;
}
try {
  const lifetime = beginProjectLifetime(project.id);
  // 기존 capture/save/POST와 activeJobOwnership handoff
} finally {
  codexStartInFlight.current = false;
  // 기존 startingKind 정리
}
```

preview는 현재 canvas를 원본으로 두고 `data:image/png;base64,` target 이미지를 `image-rendering:pixelated`로 표시한다. alt는 `선택 영역 생성 후보`, 안내는 `현재 캔버스와 적용 예정 후보를 비교하세요.`다. 버튼은 `적용`, `다시 생성`, `취소`다.

기존 generation panel의 `현재 셀 편집` 다음에 최초 진입 버튼을 둔다. 이 버튼만 새 candidate 시작 함수의 첫 사용자 진입점이고 `다시 생성`은 같은 함수를 호출하는 두 번째 명시 진입점이다.

```tsx
<button
  className="forge-button"
  type="button"
  disabled={account?.type !== "chatgpt" || !prompt.trim() || !hasActiveCel
    || activeLayerLocked || !hasSelection || codexBusy || Boolean(candidateReview)}
  onClick={() => void startGenerationCandidateFromCurrentWorkspace()}
>
  <span>선택 영역 생성 교체</span><b>⌘ ↗</b>
</button>
```

버튼 인접 안내는 다음 의미를 포함한다.

```text
새 후보와 다시 생성은 Codex 사용량을 사용할 수 있습니다.
앱은 자동 재시도하지 않으며, 추가 생성이 감지되면 결과를 폐기하지만 이미 시작된 사용량은 발생할 수 있습니다.
```

poll loop의 기존 `kind` 확인 직후 candidate mode 일치와 terminal을 먼저 처리한다.

```ts
if (isGenerationCandidateJob(next) !== isGenerationCandidateJob(started)) {
  throw new Error("작업 모드가 요청과 일치하지 않습니다.");
}
if (isGenerationCandidateJob(started)) {
  const decision = generationCandidatePollDecision(started, next);
  setJob(next);
  if (decision.kind === "review") return "candidate_review" as const;
  if (decision.kind === "failed") {
    setError(decision.message);
    return;
  }
  if (decision.kind === "cancelled") return;
  await new Promise((resolve) => window.setTimeout(resolve, 500));
  continue;
}
if (next.kind === "generation" && next.status === "completed") {
  const completed = completedGeneration(next, requestedFrameId);
  if (completed?.kind === "project") {
    setJob({ ...next, project: completed.project });
    beginProjectLifetime(completed.project.id);
    setCurrentProject(completed.project);
    setDirty(false);
    setFrameIndex(completed.frameIndex);
    setNotice(requestedFrameId === undefined
      ? "생성 결과를 프레임으로 가져와 저장했습니다."
      : "선택 프레임을 재생성해 저장했습니다.");
  }
  return;
}
```

render에서는 completed candidate만 review로 노출한다.

```tsx
const candidateReview = isGenerationCandidateJob(job) && job.status === "completed" ? job : undefined;

{candidateReview && <section className="generation-candidate-review">
  <img
    src={`data:${candidateReview.result.preview.mimeType};base64,${candidateReview.result.preview.base64}`}
    alt="선택 영역 생성 후보"
  />
  <p>현재 캔버스와 적용 예정 후보를 비교하세요.</p>
  <button type="button" onClick={applyCandidate}>적용</button>
  <button type="button" onClick={regenerateCandidate}>다시 생성</button>
  <button type="button" onClick={discardCandidate}>취소</button>
</section>}
```

Run:

```powershell
& .\node_modules\.bin\tsx.cmd --test tests\client-api.test.ts tests\editor-workspace.test.ts
rg -n '선택 영역 생성 교체|onClick=\{\(\) => void startGenerationCandidateFromCurrentWorkspace\(\)\}' src\client\App.tsx
```

Expected: tests PASS이고 `rg`는 같은 최초 진입 button block의 label/onClick 두 줄을 찾는다. candidate completion은 project를 decode/교체하지 않고 ownership을 유지한다. ordinary completion은 wire project를 decode하고 기존 lifetime, dirty, frame와 notice 갱신을 보존한다.

- [ ] **5.8 — 5분: 세 사용자 결정을 동기 claim으로 연결한다**

- `적용`: job/ownership id 확인 → 동기 claim → workspace 적용 1회 → 로컬 job clear/release → disposition best-effort
- 첫 `stale_base`/`apply_failed`: History 0, preview 유지, 적용 버튼 영구 비활성 → 해당 disposition 한 번 기록
- `다시 생성`: 기존 최종 disposition이 없으면 old job에 `regenerated`를 best-effort 기록하고, review를 clear/release한 뒤 현재 document/target/selection을 재capture해 새 사용자 시도 시작; old candidate를 입력으로 사용하지 않음
- `취소`: review clear/release 뒤 `discarded` best-effort; DELETE, History와 ImageGen 0

같은 tick double click은 React state가 아니라 ref의 `{ jobId, disposition }` 동기 claim으로 막는다. disposition 실패는 로컬 적용을 rollback하지 않는다.

```ts
type CandidateClaim = { jobId: string; disposition: GenerationCandidateDisposition | "applying" };
const candidateClaim = useRef<CandidateClaim>();

const reportCandidateDisposition = (jobId: string, disposition: GenerationCandidateDisposition) =>
  api(`/api/generations/${jobId}/disposition`, session?.token, {
    method: "POST",
    body: JSON.stringify({ disposition }),
  }).catch(() => setNotice("후보 결정 로그를 기록하지 못했지만 편집 결과는 유지됩니다."));

const claimCandidate = (jobId: string, disposition: CandidateClaim["disposition"]): boolean => {
  if (candidateClaim.current?.jobId === jobId) return false;
  candidateClaim.current = { jobId, disposition };
  return true;
};

const clearCandidateReview = (jobId: string) => {
  setJob((current) => current?.id === jobId ? undefined : current);
  const owner = activeJobOwnership.current;
  if (owner?.jobId === jobId) activeJobOwnership.current = releaseProjectJobOwnership(owner, owner);
};

const applyCandidate = () => {
  if (!candidateReview || !projectLifetime.current
    || !projectJobOwnershipMatches(projectLifetime.current, activeJobOwnership.current, {
      ...projectLifetime.current,
      jobId: candidateReview.id,
    })
    || !claimCandidate(candidateReview.id, "applying")) return;
  const applied = editor.current?.applyGenerationCandidate(candidateReview.result)
    ?? { disposition: "apply_failed" as const, error: "편집기를 사용할 수 없습니다." };
  candidateClaim.current = { jobId: candidateReview.id, disposition: applied.disposition };
  void reportCandidateDisposition(candidateReview.id, applied.disposition);
  if (applied.disposition === "applied") clearCandidateReview(candidateReview.id);
  else {
    setCandidateApplyBlocked(true);
    setError(applied.error);
  }
};

const regenerateCandidate = () => {
  if (!candidateReview) return;
  const prior = candidateClaim.current?.jobId === candidateReview.id ? candidateClaim.current : undefined;
  if (prior && prior.disposition !== "stale_base" && prior.disposition !== "apply_failed") return;
  if (!prior) {
    candidateClaim.current = { jobId: candidateReview.id, disposition: "regenerated" };
    void reportCandidateDisposition(candidateReview.id, "regenerated");
  }
  clearCandidateReview(candidateReview.id);
  void startGenerationCandidateFromCurrentWorkspace();
};

const discardCandidate = () => {
  if (!candidateReview) return;
  const prior = candidateClaim.current?.jobId === candidateReview.id ? candidateClaim.current : undefined;
  if (prior && prior.disposition !== "stale_base" && prior.disposition !== "apply_failed") return;
  if (!prior) {
    candidateClaim.current = { jobId: candidateReview.id, disposition: "discarded" };
    void reportCandidateDisposition(candidateReview.id, "discarded");
  }
  clearCandidateReview(candidateReview.id);
};
```

`다시 생성`과 `취소`도 ref를 먼저 claim한다. 이미 `stale_base`/`apply_failed`가 claim된 old job에는 `regenerated`/`discarded`를 두 번째로 POST하지 않는다. `regenerated` POST의 성공을 기다리지 않고 현재 상태 capture와 새 POST를 진행한다.

Run:

```powershell
& .\node_modules\.bin\tsc.cmd --noEmit
```

Expected: candidate exact union, polling outcome과 claim handler type error 0. 같은-tick 중복 호출 차단은 위 ref claim을 diff에서 대조한다.

- [ ] **5.9 — 4분: review 중 action guard와 기존 generation 회귀를 대조한다**

candidate review 중 project open/create/select/leave, 일반 generation, cell edit와 import처럼 lifetime/job을 바꾸는 진입점은 button disabled와 handler guard 둘 다로 막는다. save/export와 canvas 편집은 허용한다. 일반 project generation completed가 기존 project/frame 교체 경로를 그대로 타는지 API test로 확인한다.

React renderer, Playwright와 브라우저 E2E는 추가하지 않는다. App wiring은 diff에서 다음을 직접 대조한다.

```text
candidate branch의 setCurrentProject 0
preview 전 workspace apply 0
apply failure 뒤 execute 0과 Apply 재진입 차단
다시 생성의 현재 selection 재capture
완료 취소의 DELETE 0
candidate POST 뒤 stale lifetime이면 DELETE 1회
같은 tick candidate 시작 두 번 호출 시 POST 1회
같은 tick candidate↔일반 generation/cell edit 교차 시작은 양방향 모두 POST 합계 1회, 거부 경로의 beginProjectLifetime 0회
review ownership을 해제하지 않은 직접 새 candidate 시작은 POST 0회
candidate completed review 동안 ownership 유지, failed/cancelled/transport error에서는 해제
ordinary project completion은 wire `number[]`를 `decodeProject()`한 뒤 교체
최초 `선택 영역 생성 교체` button의 onClick이 start 함수에 직접 연결
```

```ts
const candidateReviewActive = isGenerationCandidateJob(job) && job.status === "completed";
const blockDuringCandidateReview = (): boolean => {
  if (!candidateReviewActive) return false;
  setError("생성 후보를 적용, 다시 생성 또는 취소한 뒤 진행해 주세요.");
  return true;
};

// lifetime/job을 바꾸는 각 handler에서 beginProjectLifetime이나 다른 mutation 전에
if (blockDuringCandidateReview()) return;
```

이 guard를 project open/create/select/leave, 일반 generation, cell edit와 import handler에서 입력 존재 확인 직후, `beginProjectLifetime()`이나 다른 mutation 전에 재사용한다. `throw`하지 않으므로 현재의 `void generate()`, `void editCurrentCell()`, `void importSheet()`, `void leaveProject()` 호출부에서도 rejected Promise가 생기지 않는다. 버튼 disabled만 믿지 않는다. save/export와 canvas edit handler에는 이 guard를 넣지 않는다.

현재 `selectProject(next, lifetime = beginProjectLifetime(next.id))`의 default parameter는 함수 본문보다 먼저 평가되므로 그대로 두지 않는다. 아래처럼 optional parameter로 바꾸고 guard가 통과한 뒤에만 fallback lifetime을 만든다. 이후 본문은 `selectedLifetime`을 기존 `lifetime` 자리에 사용한다.

```ts
const selectProject = (next: SpriteProject, lifetime?: ProjectLifetime) => {
  if (blockDuringCandidateReview()) return;
  const selectedLifetime = lifetime ?? beginProjectLifetime(next.id);
  projectLifetime.current = selectedLifetime;
  // 기존 selectProject body
};
```

Run:

```powershell
& .\node_modules\.bin\tsx.cmd --test tests\client-api.test.ts tests\editor-workspace.test.ts
```

Expected: ordinary generation/workspace 회귀 PASS. App diff의 8개 항목이 모두 충족되고 GUI/브라우저 실행 0.

- [ ] **5.10 — 5분: client 회귀와 typecheck를 통과시킨다**

Run:

```powershell
& .\node_modules\.bin\tsx.cmd --test tests\client-api.test.ts tests\editor-workspace.test.ts
& .\node_modules\.bin\tsc.cmd --noEmit
```

Expected: 두 test 파일 PASS, type error 0, GUI/브라우저 실행 0.

- [ ] **5.11 — 3분: graph 갱신과 commit**

```powershell
graphify update .
git add src/client/api.ts src/client/App.tsx src/client/editor/EditorWorkspace.tsx src/client/styles.css tests/client-api.test.ts tests/editor-workspace.test.ts
git diff --cached --check
git commit -m "feat: review and apply generation candidates"
```

---

### Task 6: 수용 기준의 교차 경계를 비용 없이 검증하고 production build를 실행한다

**Files:**

- Verify: `package.json`
- Verify: `package-lock.json`
- Verify: `src/core/ai-edit.ts`
- Verify: `src/core/resize.ts`
- Verify: `src/server/png.ts`
- Verify: `src/server/codex-bridge.ts`
- Verify: `src/server/generation-candidate.ts`
- Verify: `src/server/index.ts`
- Verify: `src/server/app.ts`
- Verify: `src/server/cell-edit-log.ts`
- Verify: `src/client/api.ts`
- Verify: `src/client/App.tsx`
- Verify: `src/client/editor/EditorWorkspace.tsx`
- Verify: `src/client/styles.css`
- Verify: `tests/codex-bridge.test.ts`, `tests/png.test.ts`, `tests/resize.test.ts`, `tests/generation-candidate.test.ts`, `tests/ai-edit-application.test.ts`, `tests/commands.test.ts`, `tests/cell-edit-log.test.ts`, `tests/server.test.ts`, `tests/client-api.test.ts`, `tests/editor-workspace.test.ts`

새 통합 harness나 실제 model fixture를 만들지 않는다.

**Interfaces:**

Consumes:

- 수정 명세의 수용 기준 1–14
- Gate G4와 Task 1–5가 남긴 tests, type contracts, graph와 staged diff
- Historical Baseline의 세 SHA-256 감사 값

Verifies: 수정 명세의 수용 기준 1–14. 실제 ImageGen 품질과 호출 전 hard cap은 이 Task의 검증 대상이 아니다.

- [ ] **6.1 — 5분: 자동 증거와 diff 검토를 대조한다**

| 불변식 | 자동 증거 | diff 검토 |
|---|---|---|
| G3 hook/version pin 0 | `rg`, bridge tests | package/lock에 G3 dependency 없음 |
| 앱 start 1회·자동 retry 0 | generation-candidate fake | App의 `다시 생성`만 새 POST |
| 첫 image 완료 즉시 close | generation-candidate fake | `close(1_000)`이 비terminal stopping state claim 뒤 호출되고 delayed-close fake가 성공함 |
| 관측된 복수 start 결과 폐기 | generation-candidate fake | 호출 전 상한 표현 없음 |
| base64 preallocation·canonical·savedPath 비의존 | generation-candidate fake | raw base64/event 로그 0 |
| protocol mismatch candidate-only latch | server test | 일반 generation/cell-edit path 불변 |
| RGB/RGBA·크기·inflate 경계 | PNG test | legacy decoder default 불변 |
| strict selection/alpha/linked replay | generation-candidate + 기존 core tests | 새 병합 엔진 없음 |
| 무저장 preview·cancel/late cleanup | server test | candidate branch save/import 0 |
| stale/hash/History 0→1 | workspace test | App가 preview 전 apply 0 |
| disposition 멱등·로그 독립 | server/log tests | report failure rollback 0 |
| 최초 시작·현재 selection 재생성·완료 취소 | API/workspace test + `rg` + diff | start button 연결, old candidate 재사용/DELETE 0 |
| Codex 시작 교차 경쟁·review guard | client API helper + App diff | 세 시작 handler가 shared claim 사용, review guard는 error+return |

빈 증거가 있으면 새 framework보다 가장 가까운 기존 test에 assertion 하나만 추가한다.

- [ ] **6.2 — 5분: 관련 test 묶음을 한 번 실행한다**

```powershell
& .\node_modules\.bin\tsx.cmd --test tests\codex-bridge.test.ts tests\png.test.ts tests\resize.test.ts tests\generation-candidate.test.ts tests\ai-edit-application.test.ts tests\commands.test.ts tests\cell-edit-log.test.ts tests\server.test.ts tests\client-api.test.ts tests\editor-workspace.test.ts
& .\node_modules\.bin\tsc.cmd --noEmit
```

Expected: 관련 tests 전부 PASS, type error 0. 실제 Codex process, ChatGPT 로그인과 ImageGen 실행 0.

- [ ] **6.3 — 5분: production build를 한 번 실행한다**

```powershell
npm.cmd run build
```

Expected: exit 0. `dist/` write 외에 GUI와 브라우저를 띄우지 않는다. 실패하면 해당 Task의 최소 test로 돌아가 수정한 뒤 이 단계만 다시 실행한다.

- [ ] **6.4 — 4분: 감사 원본, graph와 branch 상태를 확인한다**

```powershell
Get-FileHash docs/pixel-agent-improvement-plan-v5.md -Algorithm SHA256
Get-FileHash docs/superpowers/plans/2026-08-20-pixel-agent-generation-candidate.md -Algorithm SHA256
Get-FileHash docs/superpowers/plans/2026-08-20-pixel-agent-generation-candidate-execution.md -Algorithm SHA256
graphify update .
git diff --check
git diff --cached --check
git status --short --branch
```

Expected: 세 hash가 Historical Baseline 값과 일치한다. G3 전용 파일과 dependency가 없고 사용자 소유 미추적 파일은 그대로다. `graphify-out/`과 ignored 문서는 stage하지 않는다.

- [ ] **6.5 — 3분: 수용 기준 추적을 최종 review한다**

다음 검색은 모두 0건이어야 한다.

```powershell
rg -n "generation_call_limit|호출 전 차단|실제 ImageGen 최대|@openai/codex|GenerationCandidateHook" src tests package.json package-lock.json
rg -n '선택 영역 생성 교체|onClick=\{\(\) => void startGenerationCandidateFromCurrentWorkspace\(\)\}' src\client\App.tsx
```

첫 검색은 0건, 둘째 검색은 최초 진입 button의 label/onClick 두 줄이어야 한다. 사용량 안내의 `이미 시작된 사용량은 발생할 수 있습니다`는 제거 대상이 아니다. 최종 commit은 Task 6에서 새 코드 수정이 있을 때만 만들고, verify-only면 빈 commit을 만들지 않는다.

---

## 실제 Codex/ImageGen 검증 정책

네 번째 G3 실제 비용 probe는 합의한 3회 상한이 소진됐으므로 금지한다. 이와 별개로 이번 구현 계획의 범위는 fake event가 증명하는 앱 경계, 로컬 trust-boundary 테스트, typecheck와 build로 확정했으므로 실제 Codex turn, `$imagegen`, API 호출과 품질 batch를 완료 조건에 넣지 않는다.

따라서 완료 보고에서 다음을 주장하지 않는다.

- G4 이후 unpinned/global `codex` process가 실제 사용자 환경에서 시작된다.
- 실제 ChatGPT account 확인과 `skills/list`가 통과한다.
- 실제 `imageGeneration` event 이름·순서·필드가 알려진 semantic contract와 계속 같다.
- 실제 `$imagegen`이 사용할 수 있는 PNG payload를 반환한다.
- 실제 모델이 한 번의 생성만 수행했다.
- 추가 생성이 호출 전에 차단된다.
- 사용자 시도당 비용이 최대 한 번이다.
- 생성 품질이 출시 기준을 통과했다.

## 실행 중단 기준

- cleanup 뒤 G3 hook/version pin 검색 결과가 남음 → Task 1 시작 금지
- 일반 generation 또는 cell-edit bridge 회귀 → candidate 구현 중단, Gate G4로 복귀
- fake에서 `startGeneration()` 2회 또는 자동 retry 관측 → 해당 Task 미완료
- 두 번째 start 관측 뒤 result/preview가 공개됨 → 해당 Task 미완료
- protocol mismatch가 server boot나 일반 기능을 막음 → server Task 미완료
- base64 canonical/decoded 크기/PNG decode 또는 replay 하나라도 fail-open → result/preview 비공개, deep module Task 미완료
- preview 시 project bytes 또는 History가 변경됨 → server/client Task 미완료
- 실제 Codex/ImageGen을 요구하는 검증만 남음 → 자동 실행하지 않고 이 계획의 수용 범위 밖으로 기록

## 수용 기준 추적표

| 명세 기준 | 구현 Task |
|---|---|
| G3 hook·pin 제거, 일반 bridge 보존 | G4 |
| ChatGPT `$imagegen`, 앱 turn 1회, 자동 retry 0 | G4, Task 2 |
| 시도별 process, 첫 완료 종료, 복수 start 사후 실패 | Task 2 |
| protocol mismatch candidate-only 격리 | Task 2, Task 3 |
| preflight 호출 0 | Task 2 |
| PNG 신뢰 경계·정규화 | Task 1, Task 2 |
| strict 병합·alpha·replay | Task 2 |
| 무저장 job·cancel·late cleanup | Task 3 |
| 로그와 멱등 disposition | Task 3, Task 4 |
| preview·stale·History 0→1 | Task 5 |
| 최초 시작 button·명시 재생성·완료 취소 | Task 5 |
| 비용 없는 자동 검증과 build | Task 6 |

## 구현 작업자 인수인계

1. 기존 G3 체크박스나 probe를 재개하지 말고 Gate G4부터 순서대로 실행한다.
2. 현재 dirty worktree의 G3 변경과 사용자 미추적 파일을 먼저 구분한다. 사용자 파일은 수정·stage하지 않는다.
3. 각 RED가 명시한 이유로 실패하는지 확인한 뒤 가장 작은 GREEN만 작성한다.
4. candidate lifecycle은 `generation-candidate.ts` 안에 둔다. candidate bridge를 기존 shared server event map에 넣거나 provider abstraction을 만들지 않는다.
5. Codex version, hook 또는 실제 비용 hard cap을 다시 도입하지 않는다.
6. 각 commit은 표시된 파일만 stage한다. ignored 문서, `.superpowers`, `graphify-out/`과 사용자 파일을 `git add -f`하지 않는다.
7. 완료 보고에는 실행한 정확한 test/build 명령과 결과, 실제 Codex/ImageGen 실행 0회, 남은 비보장 사항을 함께 적는다.
