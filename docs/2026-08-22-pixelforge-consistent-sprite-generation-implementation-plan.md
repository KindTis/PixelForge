# PixelForge 일관적 스프라이트 생성 및 편집 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 로그인된 Codex의 내장 `$imagegen`을 필수 생성 경로로 사용하면서, 캐릭터 정체성·픽셀 스타일·팔레트·위치·동작 일관성을 유지하는 스프라이트 시트 생성과 안전한 셀 편집을 구현한다.

**Architecture:** PixelForge가 `CharacterPack`, `FramePlan`, 품질 지표와 적용 트랜잭션을 소유하고, 이미지 생성 backend는 검증되지 않은 PNG 후보만 반환한다. 전체 시트는 keyframe-first 방식으로 프레임별 생성한 뒤 로컬에서 결정적으로 조립하며, 셀 편집은 `EditScope`, core/halo mask, 인접 프레임과 전체 시트 문맥을 사용한다. Codex ImageGen은 사용자 시도마다 격리된 App Server 프로세스로 실행하고, 설치형 ML은 네트워크가 차단된 선택적 로컬 worker로만 연결한다.

**Tech Stack:** Node.js `>=20.19`, TypeScript 7 strict mode, React 19, Node 내장 `http`·`fs/promises`·`crypto`·`zlib`·`child_process`·`node:test`, 기존 PNG codec와 Codex App Server JSONL, 선택적 Python 3.11+ 로컬 ML worker, `tsx`, Vite 8

**Spec:** [생성 후보 기반 영역 교체 v5.1 수정 명세](./2026-08-22-pixel-agent-generation-candidate-revision-design.md)를 안전한 후보 적용 계층의 기반으로 사용하며, 본 문서의 **제품 계약**이 일관적 시트 생성·셀 편집·로컬 ML 확장 요구를 추가한다. 이 계획은 [기존 v5.1 구현 계획](./2026-08-22-pixel-agent-generation-candidate-revision.md)의 실행 순서를 대체한다.

## 기준 상태

- 작성 기준 공개 브랜치: `main`
- 작성 기준 HEAD: `3d0b09b40bdc911be2a6a038d8d3f5b9addf0b41`
- 현재 필수 원격 생성 경로: ChatGPT 로그인 상태의 Codex 내장 `$imagegen`
- 현재 프로젝트 실행: Node.js `>=20.19`, TypeScript strict, React 19
- 현재 테스트: `tsx --test tests/*.test.ts`
- 기존 일반 생성, 프레임 재생성, tool-action 셀 편집은 회귀 기준선으로 보존한다.

## 제품 계약

### 필수 목표

1. 같은 캐릭터의 각 프레임은 얼굴·신체 비율·의상·무기·장식·팔레트·외곽선·논리 픽셀 크기를 가능한 한 일관되게 유지한다.
2. 시트의 셀 크기, 프레임 수, 프레임 순서, root anchor와 접지 위치는 모델이 아니라 PixelForge 코드가 결정한다.
3. 특정 셀 편집은 사용자의 지시를 반영하면서 요청 범위 밖 픽셀, 다른 셀, 다른 레이어와 허용되지 않은 alpha를 변경하지 않는다.
4. 캐릭터 전체 또는 애니메이션 전체에 적용되어야 하는 요청은 한 셀에만 조용히 적용하지 않고 명시적 `EditScope`로 처리한다.
5. 후보 미리보기 중 프로젝트 저장과 `History` 변경은 0회다. 사용자가 적용할 때만 검증된 command를 한 번 실행한다.
6. 실제 품질 향상은 fake protocol test가 아니라 재현 가능한 benchmark와 사용자 선택 데이터로 평가한다.

### 네트워크·인증 계약

- PixelForge는 API key 입력·저장·주입 기능을 추가하지 않는다.
- 허용되는 원격 서비스는 사용자가 로그인한 Codex가 사용하는 OpenAI 경로뿐이다.
- Hugging Face Inference API, BFL API, Qwen 온라인 API, 외부 prompt-enhancement API와 다른 제3자 온라인 생성·평가 서비스를 호출하지 않는다.
- 설치형 ML 모델의 weight와 dependency 설치는 사용자가 명시적으로 수행한다. PixelForge 런타임은 모델을 자동 다운로드하지 않는다.
- 로컬 ML worker 실행 시 `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`과 worker 전용 network 차단을 적용한다.
- 모델 경로, revision, SHA-256과 license metadata가 없는 로컬 모델은 활성화하지 않는다.

### 생성·비용 계약

- 앱이 보장하는 것은 사용자 명시 시도당 candidate backend 호출 1회와 자동 retry 0회다.
- Codex turn 내부에서 실제 ImageGen이 시작되는 횟수나 비용을 호출 전에 hard cap으로 표현하지 않는다.
- `다시 생성`, `비교 후보 생성`과 batch frame 생성은 각각 별도의 사용자 확인과 audit record를 가진다.
- Codex와 로컬 backend 사이의 자동 fallback은 금지한다. 사용자가 backend 또는 비교 모드를 명시적으로 선택한다.

### 품질 계약

- Hard invariant 실패 후보는 미리보기로 공개하지 않는다.
- DINO 계열 embedding, Codex critic과 기타 ML 점수는 soft warning 또는 후보 ranking에만 사용한다.
- 최종 시트 PNG는 모델 출력이 아니라 검증된 frame candidate를 로컬 assembler가 조립한다.
- 픽셀화, palette normalization, alpha 처리와 anchor 정렬은 revision이 기록되는 결정적 함수로 구현한다.
- 동일 입력·동일 seed·동일 backend revision·동일 postprocess revision은 동일 후보 bytes를 재현할 수 있어야 한다. Codex 자체가 seed 재현을 제공하지 않으면 manifest에 `seed: null`, `reproducible: false`를 명시한다.

## 범위

### 필수 릴리스 범위

- backend-neutral candidate 계약
- Codex 로그인 기반 격리 ImageGen backend
- `CharacterPack`
- `FramePlan`
- keyframe-first frame generation session
- deterministic frame normalization과 sheet assembly
- `cell-local`, `animation-wide`, `character-wide` 편집 범위
- core/halo mask와 alpha policy
- hard/soft 품질 지표
- whole-sheet candidate preview
- benchmark harness
- stale-safe 단일 적용
- 실제 Codex smoke를 위한 명시적 수동 명령

### 선택 설치 범위

- JSONL 기반 로컬 ML worker
- DINOv2 identity soft scorer
- FLUX.2 `[klein] 4B` 로컬 비교 backend

### 초기 구현에서 제외

- 제3자 온라인 inference 서비스
- 자동 model download
- 자동 backend fallback
- 자동 ImageGen retry
- 사용자 확인 없는 Best-of-N 생성
- Qwen 로컬 backend의 제품 기본 탑재
- 캐릭터별 LoRA 자동 학습
- video-to-sprite 자동 생성
- PixelForge 전용 foundation model 학습

Qwen-Image 계열, pose specialist stack, 캐릭터별 LoRA와 video motion proposal은 FLUX 비교 benchmark 이후 별도 계획으로 판단한다.

## 기능 플래그와 롤아웃

```ts
export type GenerationFeatureFlags = {
  consistentSpriteGeneration: boolean;
  generationCandidateEditing: boolean;
  localMlScoring: boolean;
  localFluxBackend: boolean;
};
```

- 새 기능은 기본적으로 `consistentSpriteGeneration=false`, `generationCandidateEditing=false`로 시작한다.
- 단위·통합 테스트와 실제 Codex smoke가 끝난 뒤 개인 개발 설정에서만 활성화한다.
- 품질 rollout gate를 통과하기 전에는 README의 안정 기능 목록에 추가하지 않는다.
- 로컬 ML 플래그는 등록된 모델 manifest와 worker capability probe가 성공한 경우에만 UI에 표시한다.

## File Structure

| 경로 | 작업 | 책임 |
|---|---|---|
| `src/core/character-pack.ts` | Create | canonical reference, pixel style, anchor와 palette 계약 |
| `src/core/frame-plan.ts` | Create | animation phase, reference topology와 frame generation plan |
| `src/core/generation-candidate.ts` | Create | backend-neutral request/result/manifest/quality 타입 |
| `src/core/candidate-application.ts` | Create | fingerprint, strict diff, replay와 atomic candidate command |
| `src/core/quality-metrics.ts` | Create | palette·anchor·seam·cluster deterministic metric |
| `src/core/types.ts` | Modify | `SpriteProject`의 optional CharacterPack·generation preference |
| `src/core/commands.ts` | Modify | multi-cel atomic candidate command와 History 적용 |
| `src/server/generation-backend.ts` | Create | `ImageCandidateBackend` interface와 capability |
| `src/server/codex-imagegen-backend.ts` | Create | 사용자 시도별 Codex process와 image event adapter |
| `src/server/codex-planner.ts` | Create | tool-free structured FramePlan·critic turn |
| `src/server/candidate-input-pack.ts` | Create | 역할이 명시된 canonical/sheet/frame/mask/ROI 입력 |
| `src/server/candidate-normalizer.ts` | Create | 정렬, pixel grid 복원, palette/alpha normalization |
| `src/server/generation-candidate.ts` | Create | backend 호출, payload 신뢰 경계, 품질 평가와 cleanup |
| `src/server/generation-session-store.ts` | Create | keyframe-first session의 durable local state |
| `src/server/sprite-generation-session.ts` | Create | frame slot 생성·승인·조립 state machine |
| `src/server/local-ml-worker.ts` | Create | optional offline worker JSONL client |
| `src/server/app.ts` | Modify | character pack, plans, sessions, candidates와 dispositions API |
| `src/server/index.ts` | Modify | Codex backend factory, feature flags와 optional worker 주입 |
| `src/server/codex-bridge.ts` | Modify | ephemeral/read-only/ordered input, structured turn와 async close |
| `src/server/generation.ts` | Modify | legacy prompt 유지, 새 prompt compiler 호출과 local assembly |
| `src/server/png.ts` | Modify | candidate decode options와 strict 구조 검사 |
| `src/server/project-store.ts` | Modify | optional 새 project metadata의 backward-compatible 저장 |
| `src/server/cell-edit-log.ts` | Modify | manifest, quality, input hash와 disposition 기록 |
| `src/client/generation/candidate-state.ts` | Create | start/review/apply/regenerate/discard 순수 상태 머신 |
| `src/client/generation/CandidateReview.tsx` | Create | frame·whole-sheet·diff·warning 비교 UI |
| `src/client/generation/CharacterPackPanel.tsx` | Create | canonical, palette와 anchor 설정 |
| `src/client/generation/FramePlanPanel.tsx` | Create | keyframe plan 검토·수정 UI |
| `src/client/generation/GenerationSessionPanel.tsx` | Create | frame slot 생성·승인·조립 UI |
| `src/client/api.ts` | Modify | 새 wire union과 API helper |
| `src/client/App.tsx` | Modify | project lifetime, shared start claim와 panel 연결 |
| `src/client/editor/EditorWorkspace.tsx` | Modify | selection capture, preview와 atomic command 적용 |
| `src/client/styles.css` | Modify | candidate/plan/session 최소 스타일 |
| `scripts/run-generation-benchmark.ts` | Create | opt-in 실제·fixture benchmark 실행 |
| `scripts/smoke-codex-imagegen.ts` | Create | 명시적 1회 실제 Codex protocol smoke |
| `benchmarks/README.md` | Create | 로컬 benchmark asset 형식과 실행 정책 |
| `benchmarks/tasks.example.json` | Create | 저작권 없는 example task schema |
| `ml-worker/pyproject.toml`, `ml-worker/uv.lock` | Create | optional offline worker dependency boundary와 고정된 Python 환경 |
| `ml-worker/pixelforge_ml_worker/__main__.py` | Create | stdin/stdout JSONL loop |
| `ml-worker/pixelforge_ml_worker/protocol.py` | Create | request/response validation |
| `ml-worker/pixelforge_ml_worker/dinov2_scorer.py` | Create | local identity soft score |
| `ml-worker/pixelforge_ml_worker/flux2_backend.py` | Create | optional local FLUX candidate |
| `ml-worker/README.md` | Create | 수동 model 등록, license와 runtime network 차단 절차 |
| `ml-worker/tests/` | Create | worker protocol과 offline tests |
| `tests/` | Modify/Create | 각 task의 경계·회귀·race·quality 검증 |

## 의존 순서

```text
Task 0 기준선 고정
  → Task 1 domain contracts
  → Task 2 CharacterPack persistence
  → Task 3 deterministic quality harness
  → Task 4 candidate transaction
  → Task 5 Codex backend
  → Task 6 keyframe-first sessions
  → Task 7 consistency-aware cell editing
  → Task 8 client review workflow
  → Task 9 optional DINO worker
  → Task 10 optional FLUX backend
  → Task 11 rollout verification
```

Task 0–8은 Codex-only 필수 경로다. Task 9와 10은 독립적으로 비활성화할 수 있는 선택 기능이며 필수 경로의 테스트와 build를 막지 않는다.

---

### Task 0: 현재 생성·편집 기준선을 고정한다

**Files:**
- Modify: `tests/generation.test.ts`
- Modify: `tests/ai-edit-runner.test.ts`
- Modify: `tests/server.test.ts`
- Modify: `tests/client-api.test.ts`

**Interfaces:**
- Consumes: 현재 `buildSpriteSheetPrompt()`, `buildFrameRegenerationPrompt()`, `runAiEditAttempts()`, `/api/generations`, `/api/edits`
- Produces: 새 경로가 보존해야 하는 regression test 이름과 fixture

- [ ] **0.1 — legacy 전체 시트·프레임 생성 prompt snapshot을 고정한다**

```ts
test("legacy 생성 prompt 계약을 유지한다", () => {
  const prompt = buildSpriteSheetPrompt(request, "C:/output/sheet.png");
  assert.match(prompt, /프레임 크기/);
  assert.match(prompt, /지면 기준점/);
  assert.match(prompt, /투명 배경/);
  assert.match(prompt, /C:\/output\/sheet\.png/);
});
```

- [ ] **0.2 — legacy tool-action 편집의 선택 밖 보존 회귀를 추가한다**

선택 mask 밖 픽셀과 linked cel이 현재 기대대로 유지되는 fixture를 `tests/ai-edit-runner.test.ts`에 추가한다.

- [ ] **0.3 — legacy endpoint wire를 고정한다**

일반 generation completion에 `project`가 존재하고 cell edit completion에 `result.attempts`가 존재하는지 `tests/server.test.ts`와 `tests/client-api.test.ts`에서 검사한다.

- [ ] **0.4 — 기준선 테스트를 실행한다**

```powershell
& .\node_modules\.bin\tsx.cmd --test tests\generation.test.ts tests\ai-edit-runner.test.ts tests\server.test.ts tests\client-api.test.ts
& .\node_modules\.bin\tsc.cmd --noEmit
```

Expected: 모든 기존 경로 PASS, type error 0.

- [ ] **0.5 — commit**

```powershell
git add tests/generation.test.ts tests/ai-edit-runner.test.ts tests/server.test.ts tests/client-api.test.ts
git diff --cached --check
git commit -m "test: lock legacy generation behavior"
```

---

### Task 1: CharacterPack, FramePlan과 candidate 공개 계약을 정의한다

**Files:**
- Create: `src/core/character-pack.ts`
- Create: `src/core/frame-plan.ts`
- Create: `src/core/generation-candidate.ts`
- Create: `tests/character-pack.test.ts`
- Create: `tests/frame-plan.test.ts`
- Create: `tests/generation-candidate-types.test.ts`

**Interfaces:**
- Consumes: `RGBA`, `PixelBuffer`, `AiEditTarget`, `AiSelectionRun`, `EditCommand`
- Produces:

```ts
export type PixelStyleProfile = {
  logicalWidth: number;
  logicalHeight: number;
  palette: readonly RGBA[];
  palettePolicy: "strict" | "extend-limited" | "free";
  maxNewColors: number;
  outlineMode: "none" | "single" | "selective";
  outlineColors: readonly RGBA[];
  shadingBands: number;
  alphaMode: "binary" | "graded";
};

export type CharacterPack = {
  revision: 1;
  canonicalFrameId: string;
  canonicalPngSha256: string;
  referencePaths: {
    canonical: string;
    front?: string;
    side?: string;
    back?: string;
    detailCrops: readonly string[];
  };
  pixelStyle: PixelStyleProfile;
  rootAnchor: { x: number; y: number };
  contactAnchors: readonly { id: string; x: number; y: number }[];
};

export type FramePlan = {
  revision: 1;
  id: string;
  tagId?: string;
  frameCount: number;
  keyframeIndices: readonly number[];
  frames: readonly {
    index: number;
    role: "anticipation" | "contact" | "passing" | "impact" | "recoil" | "recovery" | "loop-transition";
    instruction: string;
    expectedRoot: { x: number; y: number };
    expectedBounds: { x: number; y: number; width: number; height: number };
    referenceFrameIndices: readonly number[];
    poseGuidePath?: string;
  }[];
};

export type EditScope = "cell-local" | "animation-wide" | "character-wide";
export type EditIntent = "pixel-correction" | "appearance-change" | "local-shape-change" | "pose-change";
export type CandidateAlphaPolicy = "preserve" | "allow-erase-in-core" | "allow-expand-in-halo";

export type CandidateManifest = {
  protocolRevision: 1;
  backendId: string;
  backendRevision: string;
  modelId?: string;
  modelRevision?: string;
  modelSha256?: string;
  promptCompilerRevision: number;
  postprocessRevision: number;
  inputHashes: Readonly<Record<string, string>>;
  promptHash: string;
  seed: number | null;
  reproducible: boolean;
};

export type CandidateHardFailureCode =
  | "invalid-payload"
  | "outside-modified"
  | "alpha-policy-violated"
  | "other-target-modified"
  | "replay-mismatch"
  | "frame-bounds-violated";

export type CandidateWarningCode =
  | "palette-drift"
  | "boundary-seam"
  | "isolated-pixels"
  | "anchor-drift"
  | "identity-score-unavailable"
  | "identity-drift";

export type CandidateHardFailure = {
  code: CandidateHardFailureCode;
  summary: string;
  affectedPixels?: number;
};

export type CandidateQualityWarning = {
  code: CandidateWarningCode;
  summary: string;
  value?: number;
  budget?: number;
};

export type CandidateQualityMetrics = {
  changedPixels: number;
  changedCoverage: number;
  outsideChangedBytes: number;
  alphaChangedBytes: number;
  paletteColorCount: number;
  newPaletteColorCount: number;
  meanPaletteDistance: number;
  isolatedPixelCount: number;
  boundaryMismatchPixels: number;
  rootAnchorError: number;
  boundsScaleError: number;
};

export function hashCharacterPack(pack: CharacterPack): string;

export type CandidateQualityReport = {
  hardFailures: readonly CandidateHardFailure[];
  warnings: readonly CandidateQualityWarning[];
  metrics: CandidateQualityMetrics;
  identityScore?: number;
  critic?: {
    verdict: "recommended" | "review" | "poor-fit";
    reasons: readonly string[];
  };
};

export type GenerationFeatureFlags = {
  consistentSpriteGeneration: boolean;
  generationCandidateEditing: boolean;
  localMlScoring: boolean;
  localFluxBackend: boolean;
};
```

- [ ] **1.1 — type와 validation RED를 작성한다**

`revision`, canonical reference, unique keyframe index, palette 범위, frame index 연속성과 alpha policy가 잘못된 fixture를 거부하는 테스트를 작성한다.

```ts
assert.throws(() => validateFramePlan({
  revision: 1,
  id: "walk",
  frameCount: 2,
  keyframeIndices: [0, 0],
  frames: [],
}), /keyframe/);
```

- [ ] **1.2 — exact validator를 구현한다**

`additionalProperties`를 허용하지 않는 수동 validator로 unknown JSON을 검증하고, 배열과 좌표는 deep copy하여 반환한다.

- [ ] **1.3 — candidate discriminated union을 구현한다**

```ts
export type GenerationCandidateRequest =
  | {
      kind: "frame-generation";
      prompt: string;
      framePlanId: string;
      frameIndex: number;
      characterPackHash: string;
    }
  | {
      kind: "cell-edit";
      prompt: string;
      target: AiEditTarget;
      selection: readonly AiSelectionRun[];
      scope: EditScope;
      intent: EditIntent;
      alphaPolicy: CandidateAlphaPolicy;
      seamHaloPixels: 0 | 1 | 2;
      characterPackHash: string;
    };
```

- [ ] **1.4 — tests와 typecheck를 실행한다**

```powershell
& .\node_modules\.bin\tsx.cmd --test tests\character-pack.test.ts tests\frame-plan.test.ts tests\generation-candidate-types.test.ts
& .\node_modules\.bin\tsc.cmd --noEmit
```

- [ ] **1.5 — commit**

```powershell
git add src/core/character-pack.ts src/core/frame-plan.ts src/core/generation-candidate.ts tests/character-pack.test.ts tests/frame-plan.test.ts tests/generation-candidate-types.test.ts
git diff --cached --check
git commit -m "feat: define consistent generation contracts"
```

---

### Task 2: CharacterPack을 프로젝트에 저장하고 검증한다

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/server/project-store.ts`
- Modify: `src/server/app.ts`
- Modify: `src/client/api.ts`
- Create: `tests/character-pack-api.test.ts`
- Modify: `tests/project-store.test.ts`
- Modify: `tests/server.test.ts`

**Interfaces:**
- Consumes: `CharacterPack`, `validateCharacterPack()`
- Produces:

```ts
export type SpriteProject = {
  version: 1;
  id: string;
  name: string;
  document: SpriteDocument;
  generationHistory: GenerationRecord[];
  exportSettings: ExportSettings;
  characterPack?: CharacterPack;
  generationPreferences?: {
    defaultBackend: "codex-imagegen" | "local-flux";
    defaultEditScope: EditScope;
    featureFlags: GenerationFeatureFlags;
  };
};
```

HTTP:

```http
GET /api/projects/:id/character-pack

PUT /api/projects/:id/character-pack
Content-Type: application/json

{
  "characterPack": { "...": "validated CharacterPack without absolute paths" },
  "canonicalPngBase64": "..."
}
```

- [ ] **2.1 — backward compatibility RED를 작성한다**

기존 version 1 프로젝트에 새 필드가 없어도 load되고, 잘못된 CharacterPack이 저장되지 않는지 검사한다.

- [ ] **2.2 — canonical artifact 저장 규칙을 구현한다**

canonical PNG를 `projects/<id>/references/character-pack/canonical.png`에 저장하고 SHA-256을 `CharacterPack.canonicalPngSha256`과 대조한다. 외부 절대 경로는 project JSON에 저장하지 않는다.

- [ ] **2.3 — CharacterPack API를 구현한다**

PUT는 project lock을 획득하고 PNG·document size·canonical frame 존재·palette를 검증한 뒤 `saveProject()`를 한 번 호출한다.

- [ ] **2.4 — client encode/decode를 갱신한다**

`WireProject`가 optional CharacterPack을 byte 변환 없이 그대로 전달하는지 검사한다.

- [ ] **2.5 — tests를 실행한다**

```powershell
& .\node_modules\.bin\tsx.cmd --test tests\project-store.test.ts tests\character-pack-api.test.ts tests\server.test.ts tests\client-api.test.ts
& .\node_modules\.bin\tsc.cmd --noEmit
```

- [ ] **2.6 — commit**

```powershell
git add src/core/types.ts src/server/project-store.ts src/server/app.ts src/client/api.ts tests/project-store.test.ts tests/character-pack-api.test.ts tests/server.test.ts tests/client-api.test.ts
git diff --cached --check
git commit -m "feat: persist character packs"
```

---

### Task 3: 결정적 품질 지표와 benchmark harness를 만든다

**Files:**
- Create: `src/core/quality-metrics.ts`
- Create: `tests/quality-metrics.test.ts`
- Create: `scripts/run-generation-benchmark.ts`
- Create: `benchmarks/README.md`
- Create: `benchmarks/tasks.example.json`
- Modify: `.gitignore`
- Modify: `package.json`

**Interfaces:**
- Produces:

```ts
export type CandidateQualityMetrics = {
  changedPixels: number;
  changedCoverage: number;
  outsideChangedBytes: number;
  alphaChangedBytes: number;
  paletteColorCount: number;
  newPaletteColorCount: number;
  meanPaletteDistance: number;
  isolatedPixelCount: number;
  boundaryMismatchPixels: number;
  rootAnchorError: number;
  boundsScaleError: number;
};

export function evaluateFrameQuality(input: {
  original?: PixelBuffer;
  candidate: PixelBuffer;
  canonicalPalette: readonly RGBA[];
  expectedRoot: { x: number; y: number };
  expectedBounds: { x: number; y: number; width: number; height: number };
  pixelStyle: PixelStyleProfile;
}): CandidateQualityReport;

export function evaluateCellEditQuality(input: {
  original: PixelBuffer;
  candidate: PixelBuffer;
  coreMask: Uint8Array;
  haloMask: Uint8Array;
  alphaPolicy: CandidateAlphaPolicy;
  canonicalPalette: readonly RGBA[];
}): CandidateQualityReport;
```

- [ ] **3.1 — metric RED를 작성한다**

2×2, 8×8 synthetic buffers로 다음을 고정한다.

```text
outside diff byte 수
alpha diff byte 수
4-connected isolated component 수
core 경계 양쪽의 RGB 불연속 수
palette에 없는 색의 수
alpha bounding box bottom-center root
expected bounds 대비 scale error
```

- [ ] **3.2 — linear RGB palette distance를 구현한다**

sRGB channel을 linear 값으로 변환한 뒤 가장 가까운 canonical color까지의 평균 squared distance를 사용한다. 이 metric은 warning 용도이며 hard failure가 아니다.

- [ ] **3.3 — hard failure와 warning policy를 구현한다**

```ts
if (metrics.outsideChangedBytes > 0) hardFailures.push({ code: "outside-modified", ... });
if (metrics.alphaChangedBytes > 0 && alphaPolicy === "preserve") hardFailures.push({ code: "alpha-policy-violated", ... });
if (metrics.boundaryMismatchPixels > boundaryBudget) warnings.push({ code: "boundary-seam", ... });
```

`boundaryBudget`은 `Math.max(2, Math.ceil(coreBoundaryPixels * 0.05))`로 계산하고 report에 실제 budget을 기록한다.

- [ ] **3.4 — benchmark manifest parser를 구현한다**

```ts
type BenchmarkTask =
  | { id: string; kind: "sheet"; projectPath: string; prompt: string; framePlanPath: string }
  | { id: string; kind: "cell-edit"; projectPath: string; prompt: string; target: AiEditTarget; selectionPath: string };
```

실제 Codex 실행은 반드시 `--allow-codex-imagegen --max-attempts <N>` 두 옵션이 함께 있어야 한다. 옵션이 없으면 fixture와 기존 artifact만 평가한다.

- [ ] **3.5 — 결과 저장 형식을 구현한다**

결과는 Git에서 제외된 `benchmark-results/<runId>/` 아래에 `run.json`, candidate PNG, metrics JSON과 `summary.md`로 남긴다. raw Codex event와 로그인 정보는 저장하지 않는다.

- [ ] **3.6 — tests와 dry-run을 실행한다**

```powershell
& .\node_modules\.bin\tsx.cmd --test tests\quality-metrics.test.ts
& .\node_modules\.bin\tsx.cmd scripts\run-generation-benchmark.ts --manifest benchmarks\tasks.example.json --dry-run
& .\node_modules\.bin\tsc.cmd --noEmit
```

- [ ] **3.7 — commit**

```powershell
git add .gitignore package.json src/core/quality-metrics.ts tests/quality-metrics.test.ts scripts/run-generation-benchmark.ts benchmarks/README.md benchmarks/tasks.example.json
git diff --cached --check
git commit -m "feat: add sprite quality benchmark harness"
```

---

### Task 4: backend-neutral Candidate Transaction Layer를 구현한다

**Files:**
- Create: `src/server/generation-backend.ts`
- Create: `src/server/candidate-input-pack.ts`
- Create: `src/server/candidate-normalizer.ts`
- Create: `src/server/generation-candidate.ts`
- Create: `src/core/candidate-application.ts`
- Modify: `src/core/commands.ts`
- Modify: `src/server/png.ts`
- Modify: `src/server/cell-edit-log.ts`
- Create: `tests/candidate-input-pack.test.ts`
- Create: `tests/candidate-normalizer.test.ts`
- Create: `tests/generation-candidate.test.ts`
- Create: `tests/candidate-application.test.ts`
- Modify: `tests/png.test.ts`
- Modify: `tests/commands.test.ts`

**Interfaces:**
- Produces:

```ts
export type BackendCapabilities = {
  frameGeneration: boolean;
  cellEditing: boolean;
  multiReference: boolean;
  deterministicSeed: boolean;
  localOnly: boolean;
};

export type CandidateInputImage = {
  role: string;
  label: string;
  path: string;
  sha256: string;
  width: number;
  height: number;
};

export type CandidateInputPack = {
  cwd: string;
  images: readonly CandidateInputImage[];
  promptSegments: readonly string[];
};

export type BackendGenerationRequest = {
  operation: "frame-generation" | "cell-edit";
  promptSegments: readonly string[];
  inputImages: readonly CandidateInputImage[];
  width: number;
  height: number;
  seed?: number;
};

export type RawImageCandidate = {
  mimeType: "image/png";
  bytes: Uint8Array;
  manifest: CandidateManifest;
  revisedPrompt?: string;
};

export interface ImageCandidateBackend {
  readonly id: string;
  capabilities(): Promise<BackendCapabilities>;
  generate(request: BackendGenerationRequest, signal: AbortSignal): Promise<RawImageCandidate>;
}

export type CandidateBaseFingerprint = {
  frameId: string;
  layerId: string;
  celId: string;
  imageId: string;
  width: number;
  height: number;
  celHash: string;
  documentStructureHash: string;
};

export function createCandidateBaseFingerprint(
  document: SpriteDocument,
  target: AiEditTarget,
): CandidateBaseFingerprint;

export function applyCandidateCommand(
  document: SpriteDocument,
  command: CandidateCommand,
  expectedBases: readonly CandidateBaseFingerprint[],
  expectedCandidateHashes: readonly string[],
): SpriteDocument;

export type CandidateCommand = {
  type: "candidateBatch";
  commands: readonly EditCommand[];
};

export type CandidateReady = {
  outcome: "candidate-ready";
  targetPreviews: readonly { frameId: string; pngBase64: string }[];
  wholeSheetPreview: { mimeType: "image/png"; base64: string };
  differencePreview: { mimeType: "image/png"; base64: string };
  manifest: CandidateManifest;
  quality: CandidateQualityReport;
  baseFingerprints: readonly CandidateBaseFingerprint[];
  candidateHashes: readonly string[];
  command: CandidateCommand;
};
```

- [ ] **4.1 — backend interface와 fake backend RED를 작성한다**

fake backend가 정확히 한 번 호출되고 abort, failure와 invalid PNG가 project와 History를 바꾸지 않는지 검사한다.

- [ ] **4.2 — candidate PNG trust boundary를 구현한다**

candidate decode는 다음을 fail-closed한다.

```text
standard canonical base64 또는 bytes
16MiB input 상한
1..2048 dimension
정사각 RGB/RGBA
8-bit, non-interlaced
CRC, IHDR/IDAT/IEND 순서
inflate exact length
trailing bytes 0
```

기존 options 없는 `decodePng()` 동작은 유지한다.

- [ ] **4.3 — 입력 pack을 구현한다**

frame generation role:

```text
canonical-character
approved-keyframes
current-pose-guide
previous-keyframe
next-keyframe
palette-strip
anchor-guide
```

cell edit role:

```text
canonical-character
full-sprite-sheet
target-cell
target-composite
previous-frame
next-frame
target-pose-guide
edit-core-mask
seam-halo-mask
palette-strip
enlarged-roi
```

각 item은 `role`, 한국어 label, SHA-256, width, height와 temp path를 가진다. 없는 optional reference는 item 자체를 생략하고 prompt가 존재한다고 주장하지 않는다.

- [ ] **4.4 — deterministic normalizer를 구현한다**

revision 1은 다음 순서로 고정한다.

```text
alpha bounding box 계산
expected root로 integer translation
target bounds를 넘지 않는 uniform integer scale만 허용
source가 논리 해상도의 정수 배율이면 block mode
그 외에는 block median
palettePolicy에 따른 nearest canonical quantization
alpha policy 적용
고립 1px 자동 삭제 금지; warning만 생성
```

normalizer가 임의 crop이나 content hallucination을 수행하지 않게 테스트한다.

- [ ] **4.5 — atomic multi-cel application을 구현한다**

`applyCandidateCommand()`는 모든 command를 snapshot에 replay하고 모든 fingerprint/hash가 일치한 경우에만 새 document를 반환한다. `History.executeCandidate()`는 undo stack에 원본 document를 정확히 한 번 push한다.

- [ ] **4.6 — candidate service를 구현한다**

preflight → input pack → backend call 1회 → PNG validation → normalization → quality hard gate → candidate command/replay → previews → cleanup 순서를 한 모듈이 소유한다. hard failure이면 preview와 command를 반환하지 않는다.

- [ ] **4.7 — 로그를 확장한다**

```text
generated/candidate-logs/<jobId>/
  request.json
  manifest.json
  quality.json
  normalized/
  preview/
  disposition.json
```

raw base64, token, email, absolute model path와 raw bridge event를 기록하지 않는다.

- [ ] **4.8 — 관련 tests를 실행한다**

```powershell
& .\node_modules\.bin\tsx.cmd --test tests\png.test.ts tests\candidate-input-pack.test.ts tests\candidate-normalizer.test.ts tests\generation-candidate.test.ts tests\candidate-application.test.ts tests\commands.test.ts
& .\node_modules\.bin\tsc.cmd --noEmit
```

- [ ] **4.9 — commit**

```powershell
git add src/server/generation-backend.ts src/server/candidate-input-pack.ts src/server/candidate-normalizer.ts src/server/generation-candidate.ts src/core/candidate-application.ts src/core/commands.ts src/server/png.ts src/server/cell-edit-log.ts tests/png.test.ts tests/candidate-input-pack.test.ts tests/candidate-normalizer.test.ts tests/generation-candidate.test.ts tests/candidate-application.test.ts tests/commands.test.ts
git diff --cached --check
git commit -m "feat: add candidate transaction layer"
```

---

### Task 5: 로그인된 Codex ImageGen backend를 연결한다

**Files:**
- Modify: `src/server/codex-bridge.ts`
- Create: `src/server/codex-imagegen-backend.ts`
- Create: `src/server/codex-planner.ts`
- Modify: `src/server/index.ts`
- Create: `scripts/smoke-codex-imagegen.ts`
- Modify: `tests/codex-bridge.test.ts`
- Create: `tests/codex-imagegen-backend.test.ts`
- Create: `tests/codex-planner.test.ts`

**Interfaces:**
- Consumes: `ImageCandidateBackend`, `CandidateInputPack`
- Produces:

```ts
export type CodexTurnInput =
  | { type: "text"; text: string }
  | { type: "localImage"; path: string };

export type CodexGenerationRequest = {
  cwd: string;
  ephemeral: true;
  approvalPolicy: "never";
  sandbox: "read-only";
  input: readonly CodexTurnInput[];
};

export type CreateCodexImagegenBackend = () => Promise<ImageCandidateBackend>;

export async function generateFramePlanWithCodex(input: {
  prompt: string;
  characterPack: CharacterPack;
  frameCount: number;
  animationTag?: string;
}): Promise<FramePlan>;
```

- [ ] **5.1 — ordered text/image input RED를 작성한다**

`CodexBridge`가 label text와 `localImage`를 지정 순서 그대로 `turn/start.input`에 전달하는지 fake JSONL process로 검사한다.

- [ ] **5.2 — ephemeral/read-only request와 async close를 구현한다**

`thread/start`에 `ephemeral:true`, `approvalPolicy:"never"`, `sandbox:"read-only"`를 사용하고 candidate용 bridge는 close가 완료될 때까지 실제 process 종료를 기다린다. 일반 generation의 기존 기본값은 유지한다.

- [ ] **5.3 — imageGeneration event adapter를 구현한다**

listener를 turn 시작 전에 연결하고 early event를 queue한다. 첫 valid image completion에서 result를 소유한 뒤 interrupt와 close를 즉시 시작한다. 두 번째 start 관측은 사후 방어로 결과를 폐기하되 호출 전 hard cap이라고 표현하지 않는다.

- [ ] **5.4 — account와 skill capability를 검증한다**

`account/read`의 account type이 `chatgpt`이고 `skills/list`에 enabled `imagegen`이 있을 때만 backend를 생성한다. API key 환경을 읽거나 사용자에게 요구하지 않는다.

- [ ] **5.5 — prompt compiler를 구현한다**

prompt는 다음을 명시한다.

```text
canonical의 캐릭터 정체성과 pixel style 유지
각 입력 이미지의 role
현재 frame role과 expected root/bounds
다른 frame이나 sheet grid를 출력에 포함하지 않음
전체 정사각 RGB/RGBA 후보 한 장
파일 쓰기와 다른 도구 사용 금지
내장 ImageGen 정확히 한 번 요청
완료 뒤 추가 생성 없이 종료
```

이 문구는 모델 지시이며 보안·비용 hard cap 근거로 사용하지 않는다.

- [ ] **5.6 — tool-free Codex planner를 구현한다**

별도 restricted bridge에서 `dynamicTools:[]`, `approvalPolicy:"never"`, read-only와 JSON output schema를 사용한다. FramePlan과 critic JSON은 strict validator를 통과해야 한다. planner 실패는 ImageGen을 자동 시작하지 않는다.

- [ ] **5.7 — 실제 smoke script에 비용 gate를 추가한다**

```powershell
& .\node_modules\.bin\tsx.cmd scripts\smoke-codex-imagegen.ts --allow-codex-imagegen --max-attempts 1
```

두 옵션과 interactive 확인 문자열 `RUN ONE CODEX IMAGEGEN ATTEMPT`가 모두 없으면 종료 코드 2로 실행을 거부한다. script는 project를 변경하지 않고 temp artifact와 protocol summary만 남긴다.

- [ ] **5.8 — fake tests를 실행한다**

```powershell
& .\node_modules\.bin\tsx.cmd --test tests\codex-bridge.test.ts tests\codex-imagegen-backend.test.ts tests\codex-planner.test.ts
& .\node_modules\.bin\tsc.cmd --noEmit
```

자동 test에서는 실제 Codex와 ImageGen을 실행하지 않는다.

- [ ] **5.9 — commit**

```powershell
git add src/server/codex-bridge.ts src/server/codex-imagegen-backend.ts src/server/codex-planner.ts src/server/index.ts scripts/smoke-codex-imagegen.ts tests/codex-bridge.test.ts tests/codex-imagegen-backend.test.ts tests/codex-planner.test.ts
git diff --cached --check
git commit -m "feat: add isolated Codex imagegen backend"
```

---

### Task 6: keyframe-first 스프라이트 생성 session을 구현한다

**Files:**
- Create: `src/server/generation-session-store.ts`
- Create: `src/server/sprite-generation-session.ts`
- Modify: `src/server/generation.ts`
- Modify: `src/server/app.ts`
- Modify: `src/client/api.ts`
- Create: `tests/generation-session-store.test.ts`
- Create: `tests/sprite-generation-session.test.ts`
- Modify: `tests/server.test.ts`
- Modify: `tests/generation.test.ts`

**Interfaces:**
- Produces:

```ts
export type FrameSlotState =
  | { status: "planned" }
  | { status: "generating"; jobId: string }
  | { status: "review"; candidateJobId: string }
  | { status: "approved"; candidateJobId: string; normalizedPngPath: string }
  | { status: "failed"; error: string };

export type FrameSlot = {
  index: number;
  state: FrameSlotState;
};

export type SpriteGenerationSession = {
  revision: 1;
  id: string;
  projectId: string;
  characterPackHash: string;
  framePlan: FramePlan;
  backendId: string;
  slots: readonly FrameSlot[];
  status: "planning" | "keyframes" | "intermediate" | "ready-to-assemble" | "completed" | "cancelled";
  createdAt: string;
  updatedAt: string;
};

export function hashGenerationBase(project: SpriteProject): string;
```

HTTP:

```text
POST /api/projects/:id/frame-plans
POST /api/projects/:id/generation-sessions
GET  /api/generation-sessions/:sessionId
POST /api/generation-sessions/:sessionId/frames/:index/generate
POST /api/generation-sessions/:sessionId/frames/:index/approve
POST /api/generation-sessions/:sessionId/assemble
DELETE /api/generation-sessions/:sessionId
```

- [ ] **6.1 — session state machine RED를 작성한다**

중간 프레임은 모든 required keyframe이 approved일 때만 generate할 수 있고, assemble은 모든 slot이 approved일 때만 가능해야 한다.

- [ ] **6.2 — durable session store를 구현한다**

`projects/<id>/generated/sessions/<sessionId>/session.json`을 temp file + rename으로 원자 저장한다. session JSON에는 absolute path와 raw PNG bytes를 넣지 않는다.

- [ ] **6.3 — star reference policy를 구현한다**

모든 frame input에는 canonical reference를 포함한다. intermediate frame은 승인된 이전·다음 keyframe을 참조하지만 직전 자동 생성 frame만을 identity source로 사용하지 않는다.

- [ ] **6.4 — frame generation route를 구현한다**

각 button action은 candidate backend를 정확히 한 번 호출하고, 결과는 기존 project document에 적용하지 않은 `review` slot으로 남긴다.

- [ ] **6.5 — deterministic sheet assembler를 구현한다**

approved normalized PNG를 frame index 순서로 읽고 exact cell size를 확인한 뒤 SpriteDocument frame/cel/image를 로컬에서 구성한다. frame count, grid와 order를 모델 출력에서 추론하지 않는다.

- [ ] **6.6 — assemble 결과를 적용 전 candidate로 반환한다**

`POST .../assemble`은 project를 저장하지 않고 다음 wire를 반환한다.

```ts
export type GeneratedSheetCandidate = {
  sessionId: string;
  baseProjectHash: string;
  characterPackHash: string;
  project: SpriteProject;
  sheetPreview: { mimeType: "image/png"; base64: string };
};
```

클라이언트는 현재 project hash와 CharacterPack hash를 다시 확인한 뒤 `EditorWorkspaceHandle.applyGeneratedSheet(candidate)`를 호출한다. 이 method는 `history.current.replace(candidate.project.document)`를 정확히 한 번 호출하고 `onChange()`를 한 번 emit한다. stale이면 replace와 save는 0회다.

- [ ] **6.7 — tests를 실행한다**

```powershell
& .\node_modules\.bin\tsx.cmd --test tests\generation-session-store.test.ts tests\sprite-generation-session.test.ts tests\server.test.ts tests\generation.test.ts
& .\node_modules\.bin\tsc.cmd --noEmit
```

- [ ] **6.8 — commit**

```powershell
git add src/server/generation-session-store.ts src/server/sprite-generation-session.ts src/server/generation.ts src/server/app.ts src/client/api.ts tests/generation-session-store.test.ts tests/sprite-generation-session.test.ts tests/server.test.ts tests/generation.test.ts
git diff --cached --check
git commit -m "feat: add keyframe-first sprite generation"
```

---

### Task 7: 일관성 보존 셀 편집과 batch scope를 구현한다

**Files:**
- Modify: `src/server/candidate-input-pack.ts`
- Modify: `src/server/generation-candidate.ts`
- Modify: `src/core/candidate-application.ts`
- Modify: `src/core/commands.ts`
- Modify: `src/server/app.ts`
- Modify: `src/client/editor/ai-edit.ts`
- Modify: `src/client/editor/EditorWorkspace.tsx`
- Create: `tests/edit-scope.test.ts`
- Modify: `tests/generation-candidate.test.ts`
- Modify: `tests/candidate-application.test.ts`
- Modify: `tests/editor-workspace.test.ts`
- Modify: `tests/server.test.ts`

**Interfaces:**
- Produces:

```ts
export type ResolvedEditScope = {
  scope: EditScope;
  frameIds: readonly string[];
  reason: string;
};

export function resolveEditScope(input: {
  requested: EditScope;
  intent: EditIntent;
  document: SpriteDocument;
  target: AiEditTarget;
  tagId?: string;
}): ResolvedEditScope;

export function buildCoreAndHaloMasks(
  selection: readonly AiSelectionRun[],
  width: number,
  height: number,
  haloPixels: 0 | 1 | 2,
): { core: Uint8Array; halo: Uint8Array };
```

- [ ] **7.1 — scope RED를 작성한다**

```text
cell-local → target frame 한 개
animation-wide → target이 속한 tag의 frame 전체
character-wide → document frame 전체
pose-change + character-wide → 명시적 사용자 확인 없이는 거부
```

tag가 겹치는 경우 가장 좁은 containing tag를 선택하고 결과에 tag id를 기록한다.

- [ ] **7.2 — core/halo mask를 구현한다**

halo는 core의 Chebyshev distance `1..haloPixels`만 포함하고 document 밖으로 나가지 않는다. outside는 core와 halo가 모두 0인 영역이다.

- [ ] **7.3 — intent별 merge policy를 구현한다**

```text
pixel-correction → 기존 tool-action 경로 우선
appearance-change + preserve → original alpha 유지
local-shape-change + allow-erase-in-core → core에서 generated alpha threshold 적용
local-shape-change + allow-expand-in-halo → halo에서만 신규 alpha 허용
pose-change → patch merge 금지, frame 전체 candidate 사용
```

alpha threshold는 binary style이면 128, graded style이면 generated alpha 값을 유지한다.

- [ ] **7.4 — whole-sheet quality evaluation을 구현한다**

각 frame 후보를 적용한 임시 document를 합성하고 canonical, 이전·다음 frame과 비교한 quality report를 만든다. outside byte, 다른 frame diff와 command replay는 hard failure다.

- [ ] **7.5 — batch command를 atomic하게 적용한다**

`animation-wide`와 `character-wide`는 모든 frame candidate가 hard validation을 통과해야 하나의 `CandidateCommand`를 공개한다. 하나라도 실패하면 부분 command를 적용하지 않는다.

- [ ] **7.6 — server API를 확장한다**

기존 `/api/generations`의 `mode:"generation-candidate"` 또는 별도 typed route가 `scope`, `intent`, `alphaPolicy`, `seamHaloPixels`를 요구하게 한다. legacy generation request와 구조적으로 구분한다.

- [ ] **7.7 — editor capture/apply를 구현한다**

workspace는 current selection을 document-coordinate runs로 capture하고, apply 전에 active target, layer visibility/lock/opacity, fingerprints, candidate hashes를 재검증한다. 실패 시 History execute 0회다.

- [ ] **7.8 — tests를 실행한다**

```powershell
& .\node_modules\.bin\tsx.cmd --test tests\edit-scope.test.ts tests\generation-candidate.test.ts tests\candidate-application.test.ts tests\editor-workspace.test.ts tests\server.test.ts
& .\node_modules\.bin\tsc.cmd --noEmit
```

- [ ] **7.9 — commit**

```powershell
git add src/server/candidate-input-pack.ts src/server/generation-candidate.ts src/core/candidate-application.ts src/core/commands.ts src/server/app.ts src/client/editor/ai-edit.ts src/client/editor/EditorWorkspace.tsx tests/edit-scope.test.ts tests/generation-candidate.test.ts tests/candidate-application.test.ts tests/editor-workspace.test.ts tests/server.test.ts
git diff --cached --check
git commit -m "feat: preserve consistency across generated edits"
```

---

### Task 8: CharacterPack, FramePlan과 후보 검토 UI를 연결한다

**Files:**
- Create: `src/client/generation/candidate-state.ts`
- Create: `src/client/generation/CandidateReview.tsx`
- Create: `src/client/generation/CharacterPackPanel.tsx`
- Create: `src/client/generation/FramePlanPanel.tsx`
- Create: `src/client/generation/GenerationSessionPanel.tsx`
- Modify: `src/client/App.tsx`
- Modify: `src/client/api.ts`
- Modify: `src/client/styles.css`
- Create: `tests/candidate-state.test.ts`
- Modify: `tests/client-api.test.ts`
- Modify: `tests/editor-workspace.test.ts`

**Interfaces:**
- Produces:

```ts
export type CandidateReviewState =
  | { status: "idle" }
  | { status: "starting"; requestId: string }
  | { status: "running"; jobId: string }
  | { status: "review"; jobId: string; result: CandidateReady; applyBlocked: boolean }
  | { status: "failed"; message: string };

export type EditorWorkspaceHandle = {
  // 기존 method 유지
  applyGeneratedSheet(candidate: GeneratedSheetCandidate):
    | { outcome: "applied" }
    | { outcome: "stale"; error: string };
};

export type CandidateReviewAction =
  | { type: "start"; requestId: string }
  | { type: "started"; jobId: string }
  | { type: "ready"; jobId: string; result: CandidateReady }
  | { type: "apply-failed"; jobId: string; message: string }
  | { type: "clear"; jobId: string }
  | { type: "failed"; message: string };
```

- [ ] **8.1 — reducer RED를 작성한다**

same-tick duplicate start, stale job event, double apply, apply failure 뒤 재적용과 old job completion을 순수 reducer에서 거부한다.

- [ ] **8.2 — CharacterPack panel을 구현한다**

canonical frame 선택, palette policy, outline mode, root anchor와 contact anchor를 편집하고 저장 전 preview를 제공한다.

- [ ] **8.3 — FramePlan panel을 구현한다**

Codex가 제안한 plan을 바로 실행하지 않고 keyframe index, frame role, instruction, expected root/bounds를 사용자가 수정·승인하게 한다.

- [ ] **8.4 — GenerationSession panel을 구현한다**

keyframe slot을 먼저 표시하고 승인되지 않은 intermediate generate button을 비활성화한다. 각 생성 버튼 옆에 Codex 사용량 사용 가능성을 표시한다.

- [ ] **8.5 — CandidateReview를 구현한다**

다음 네 view를 제공한다.

```text
원본 frame 또는 sheet
후보 frame 또는 sheet
pixel diff
quality warnings와 hard metric summary
```

이미지는 `image-rendering: pixelated`로 표시하고 1×와 8× 확대를 전환한다.

- [ ] **8.6 — 사용자 결정을 연결한다**

`적용`, `다시 생성`, `폐기`를 ref 기반 동기 claim으로 한 번만 처리한다. `다시 생성`은 current document·selection·CharacterPack을 다시 capture하고 old candidate를 입력으로 사용하지 않는다.

- [ ] **8.7 — project lifetime guard를 연결한다**

candidate review 중 project open/create/select/leave, 일반 generation, cell edit와 import는 handler 첫 mutation 전에 정상 return한다. canvas edit와 save/export 허용 여부는 review UI에 명시하고, canvas edit가 발생하면 apply가 stale로 실패해야 한다.

- [ ] **8.8 — tests와 build를 실행한다**

```powershell
& .\node_modules\.bin\tsx.cmd --test tests\candidate-state.test.ts tests\client-api.test.ts tests\editor-workspace.test.ts
& .\node_modules\.bin\tsc.cmd --noEmit
npm.cmd run build
```

- [ ] **8.9 — commit**

```powershell
git add src/client/generation/candidate-state.ts src/client/generation/CandidateReview.tsx src/client/generation/CharacterPackPanel.tsx src/client/generation/FramePlanPanel.tsx src/client/generation/GenerationSessionPanel.tsx src/client/App.tsx src/client/api.ts src/client/styles.css tests/candidate-state.test.ts tests/client-api.test.ts tests/editor-workspace.test.ts
git diff --cached --check
git commit -m "feat: add consistent generation review workflow"
```

---

### Task 9: 선택형 offline DINOv2 identity scorer를 추가한다

**Files:**
- Create: `src/server/local-ml-worker.ts`
- Create: `ml-worker/pyproject.toml`
- Create: `ml-worker/uv.lock`
- Create: `ml-worker/README.md`
- Create: `ml-worker/pixelforge_ml_worker/__init__.py`
- Create: `ml-worker/pixelforge_ml_worker/__main__.py`
- Create: `ml-worker/pixelforge_ml_worker/protocol.py`
- Create: `ml-worker/pixelforge_ml_worker/dinov2_scorer.py`
- Create: `ml-worker/tests/test_protocol.py`
- Create: `ml-worker/tests/test_offline.py`
- Create: `tests/local-ml-worker.test.ts`
- Modify: `src/server/index.ts`
- Modify: `src/server/generation-candidate.ts`
- Modify: `package.json`

**Interfaces:**
- Produces JSONL:

```json
{"id":"1","method":"capabilities","params":{}}
{"id":"2","method":"identity/score","params":{"referencePath":"...","candidatePath":"..."}}
```

Response:

```json
{"id":"2","result":{"score":0.0,"modelId":"dinov2-vits14","modelRevision":"...","modelSha256":"..."}}
```

- [ ] **9.1 — Node fake worker RED를 작성한다**

request id matching, stdout partial line, timeout, malformed JSON, worker exit와 cancel을 검사한다.

- [ ] **9.2 — Python protocol loop를 구현한다**

protocol은 허용된 method와 job temp directory 안의 absolute file만 받는다. project root, URL, socket과 arbitrary Python module 이름을 받지 않는다.

- [ ] **9.3 — model registry를 구현한다**

worker는 `PIXELFORGE_MODEL_HOME/models.json`에서 다음을 읽는다.

```json
{
  "dinov2-vits14": {
    "path": "D:/PixelForgeModels/dinov2_vits14.pth",
    "codePath": "D:/PixelForgeModels/dinov2-repository",
    "revision": "registered-local",
    "sha256": "<64 lowercase hex>",
    "license": "Apache-2.0"
  }
}
```

file hash가 다르면 capability에서 unavailable을 반환한다. `dinov2_scorer.py`는 `torch.hub.load(codePath, "dinov2_vits14", source="local", pretrained=false)`로 architecture를 만들고 등록된 state dict만 로드한다. 앱과 worker는 weight 또는 source repository를 다운로드하지 않는다.

- [ ] **9.4 — offline process 환경을 구현한다**

Node spawn environment:

```ts
{
  HF_HUB_OFFLINE: "1",
  TRANSFORMERS_OFFLINE: "1",
  NO_PROXY: "*",
  PIXELFORGE_MODEL_HOME: configuredModelHome,
}
```

worker에는 job temp directory만 전달한다. 방화벽 또는 network-disabled container 적용 방법은 `benchmarks/README.md`가 아니라 별도 `ml-worker/README.md`에 기록한다.

- [ ] **9.5 — DINO score를 soft metric으로 연결한다**

score unavailable, timeout 또는 model failure는 candidate hard failure로 만들지 않고 `identity-score-unavailable` warning을 추가한다.

- [ ] **9.6 — tests를 실행한다**

```powershell
& .\node_modules\.bin\tsx.cmd --test tests\local-ml-worker.test.ts tests\generation-candidate.test.ts
Push-Location ml-worker
python -m unittest discover -s tests
Pop-Location
& .\node_modules\.bin\tsc.cmd --noEmit
```

Python이나 model이 설치되지 않은 기본 환경에서도 Node build와 tests는 fake worker로 PASS해야 한다. Python worker 개발 환경에서는 `uv sync --frozen`으로 `uv.lock`을 사용하고 위 Python test를 실행한다.

- [ ] **9.7 — commit**

```powershell
git add src/server/local-ml-worker.ts src/server/index.ts src/server/generation-candidate.ts ml-worker package.json tests/local-ml-worker.test.ts
git diff --cached --check
git commit -m "feat: add offline identity scoring worker"
```

---

### Task 10: 선택형 FLUX.2 `[klein] 4B` 로컬 비교 backend를 추가한다

**Files:**
- Create: `ml-worker/pixelforge_ml_worker/flux2_backend.py`
- Create: `ml-worker/tests/test_flux2_contract.py`
- Modify: `ml-worker/pixelforge_ml_worker/protocol.py`
- Modify: `src/server/local-ml-worker.ts`
- Modify: `src/server/index.ts`
- Modify: `src/client/api.ts`
- Modify: `src/client/generation/GenerationSessionPanel.tsx`
- Modify: `src/client/generation/CandidateReview.tsx`
- Modify: `scripts/run-generation-benchmark.ts`
- Modify: `tests/local-ml-worker.test.ts`
- Modify: `tests/client-api.test.ts`

**Interfaces:**
- Adds worker method:

```json
{
  "id":"3",
  "method":"candidate/generate",
  "params":{
    "backendId":"flux2-klein-4b",
    "prompt":"...",
    "inputImages":[{"role":"canonical-character","path":"..."}],
    "width":512,
    "height":512,
    "seed":123456789
  }
}
```

- [ ] **10.1 — capability와 missing model RED를 작성한다**

등록되지 않은 FLUX profile은 UI와 backend 목록에서 숨기고 Codex path에 영향을 주지 않는다.

- [ ] **10.2 — local model manifest를 검증한다**

default 허용 profile은 Apache-2.0인 `FLUX.2 [klein] 4B`로 제한한다. model id, revision, SHA-256, local path와 license가 정확히 일치해야 한다.

- [ ] **10.3 — offline generation adapter를 구현한다**

worker가 참조 이미지를 local path에서 읽고 결과 PNG bytes를 job temp directory에 기록한다. HTTP request와 remote text encoder 사용을 금지한다.

- [ ] **10.4 — compare mode를 명시적으로 구현한다**

사용자가 `Codex와 로컬 후보 비교`를 누른 경우에만 두 개의 독립 시도를 시작한다. 각 시도는 별도 job, manifest와 사용량 안내를 가지며 한 backend 실패 시 다른 결과를 자동 적용하지 않는다.

- [ ] **10.5 — benchmark backend를 추가한다**

동일 task, 동일 input pack과 가능한 경우 동일 seed set으로 Codex와 FLUX 결과를 평가한다. Codex의 seed가 unavailable이면 manifest에서 분리하고 pairwise 사용자 평가에 사용한다.

- [ ] **10.6 — tests를 실행한다**

```powershell
& .\node_modules\.bin\tsx.cmd --test tests\local-ml-worker.test.ts tests\client-api.test.ts
Push-Location ml-worker
python -m unittest discover -s tests -p "test_flux2_contract.py"
Pop-Location
& .\node_modules\.bin\tsc.cmd --noEmit
npm.cmd run build
```

실제 FLUX weight가 없는 test에서는 fake pipeline을 사용하고 model load를 실행하지 않는다.

- [ ] **10.7 — commit**

```powershell
git add ml-worker/pixelforge_ml_worker/flux2_backend.py ml-worker/pixelforge_ml_worker/protocol.py ml-worker/tests/test_flux2_contract.py src/server/local-ml-worker.ts src/server/index.ts src/client/api.ts src/client/generation/GenerationSessionPanel.tsx src/client/generation/CandidateReview.tsx scripts/run-generation-benchmark.ts tests/local-ml-worker.test.ts tests/client-api.test.ts
git diff --cached --check
git commit -m "feat: add optional local FLUX backend"
```

---

### Task 11: 수용 기준, 실제 smoke와 rollout gate를 검증한다

**Files:**
- Verify: 모든 Task 0–10 파일
- Modify: `README.md`
- Modify: `benchmarks/README.md`
- Create: `docs/consistent-generation-user-guide.md`
- Modify/Create: 가장 가까운 회귀 test만

**Interfaces:**
- Consumes: 모든 public contract, benchmark result와 feature flags
- Produces: experimental rollout 판단과 정확한 검증 기록

- [ ] **11.1 — 전체 자동 test와 build를 실행한다**

```powershell
npm.cmd test
& .\node_modules\.bin\tsc.cmd --noEmit
npm.cmd run build
git diff --check
```

Expected: exit 0, 실제 Codex/ImageGen과 local model load 0회.

- [ ] **11.2 — 금지 경로를 정적 검사한다**

```powershell
rg -n "OPENAI_API_KEY|sk-proj|api\.bfl|huggingface\.co/api|dashscope|Qwen.*API|automatic fallback" src scripts ml-worker
```

Expected: API key 입력·외부 inference 호출 코드 0건. 문서의 공식 출처 URL은 검색 대상에서 제외한다.

- [ ] **11.3 — 실제 Codex smoke를 한 번 명시적으로 실행한다**

사용자가 로그인 상태와 Codex 사용량 사용을 확인한 뒤에만 실행한다.

```powershell
& .\node_modules\.bin\tsx.cmd scripts\smoke-codex-imagegen.ts --allow-codex-imagegen --max-attempts 1
```

검증 항목:

```text
ChatGPT account 확인
enabled imagegen skill
ephemeral thread start
ordered text/localImage input
image result 수신
candidate process 종료
temp directory cleanup
project/History 변경 0
```

실패하면 feature flag를 활성화하지 않고 protocol summary를 보존한다.

- [ ] **11.4 — Codex-only 품질 benchmark를 실행한다**

최소 dataset:

```text
시트 생성 24 task
cell-local 편집 20 task
animation-wide 편집 10 task
character-wide 편집 10 task
32/64/128px와 인간형·비인간형 포함
```

각 실제 시도는 manifest와 사용자의 명시 승인 아래 실행한다.

- [ ] **11.5 — rollout gate를 판정한다**

experimental flag 활성 조건:

```text
hard invariant pass 100%
셀 편집 outside byte diff 0
허용되지 않은 alpha diff 0
frame count/cell size 위반 0
median root anchor error ≤ 1 logical pixel
legacy 대비 blind pairwise 사용자 선호 ≥ 60%
cell edit 후보 적용 또는 재생성 선택률 기록 100%
모든 폐기 후보에 reject reason 존재
```

60% 선호를 충족하지 못해도 구현은 유지할 수 있으나 feature flag는 기본 off로 둔다.

- [ ] **11.6 — optional local backend를 별도 판정한다**

DINO와 FLUX는 Codex-only gate를 대체하지 않는다. local backend는 다음을 모두 만족할 때만 UI 기본 옵션에 노출한다.

```text
offline capability probe 성공
model SHA와 license 검증 성공
worker network 차단 확인
Codex-only 대비 hard invariant 비열화 0
선호 또는 latency 중 하나의 명확한 개선
```

- [ ] **11.7 — 사용자 문서를 작성한다**

가이드에는 다음을 명시한다.

```text
Codex 로그인 요구
API key 불필요
OpenAI 외 제3자 온라인 서비스 미사용
새 후보/다시 생성의 Codex 사용량 가능성
CharacterPack과 FramePlan 사용법
EditScope 선택법
로컬 모델은 선택 설치이며 런타임 offline
candidate warning은 자동 품질 보장이 아님
```

- [ ] **11.8 — 최종 commit**

```powershell
git add README.md benchmarks/README.md docs/consistent-generation-user-guide.md
git diff --cached --check
git commit -m "docs: document consistent generation workflow"
```

빈 코드 변경을 만들지 않는다. Task 11 검증 중 코드 수정이 필요하면 가장 가까운 Task의 test와 파일을 함께 수정하고 별도 fix commit을 만든다.

---

## 수용 기준 추적표

| 기준 | 구현 Task |
|---|---|
| 기존 generation/cell edit 회귀 방지 | Task 0 |
| CharacterPack과 canonical identity | Task 1, 2 |
| FramePlan과 keyframe-first workflow | Task 1, 6 |
| 결정적 quality metric과 benchmark | Task 3 |
| backend-neutral candidate transaction | Task 4 |
| API key 없는 Codex 로그인 ImageGen | Task 5 |
| 사용자 시도당 backend 호출 1회·자동 retry 0 | Task 4, 5, 8 |
| 최종 sheet local assembly | Task 6 |
| EditScope와 whole-sheet consistency | Task 7 |
| preview 중 project/History 불변 | Task 4, 7, 8 |
| stale-safe atomic apply | Task 4, 7 |
| 후보 비교·diff·warning UI | Task 8 |
| 제3자 온라인 inference 0 | Global Constraints, Task 11 |
| optional offline DINO scorer | Task 9 |
| optional offline FLUX backend | Task 10 |
| 실제 smoke와 품질 rollout gate | Task 11 |

## 실제 생성 검증 정책

- 기본 `npm test`와 build는 실제 Codex, ImageGen, DINO와 FLUX를 실행하지 않는다.
- 실제 Codex ImageGen은 사용자 확인 문자열과 `--max-attempts`가 있는 smoke/benchmark 명령에서만 실행한다.
- benchmark runner는 실제 시도마다 job id, backend, prompt hash, input hashes와 outcome을 기록한다.
- benchmark 결과가 없으면 “일관성 품질 개선 완료”를 주장하지 않는다.
- DINO/critic 점수만으로 후보를 자동 적용하거나 자동 폐기하지 않는다.
- 실제 모델의 품질, Codex 내부 호출 횟수와 향후 protocol 호환성을 코드 test만으로 보장한다고 표현하지 않는다.

## 구현 중단 기준

- 기존 일반 generation 또는 tool-action cell edit 회귀 → 다음 Task로 진행하지 않는다.
- 후보 미리보기 전에 project bytes 또는 History 변경 → Candidate Transaction Task 미완료.
- backend가 사용자 동의 없이 retry/fallback → 해당 backend 비활성.
- hard invariant 실패 후보에 preview 또는 command 존재 → 품질 경계 미완료.
- batch scope에서 일부 frame만 적용 → atomic application 미완료.
- local worker가 network access 또는 project root access를 요구 → local ML Task 중단.
- model SHA/license를 검증할 수 없음 → 해당 local backend 등록 거부.
- 실제 Codex smoke 미실행 또는 실패 → Codex feature flag 기본 off 유지.
- 품질 rollout gate 미달 → 기능은 experimental 상태 유지.

## Qwen·LoRA·video 후속 판단 조건

다음 조건을 모두 만족한 뒤에만 별도 계획을 작성한다.

1. Codex-only와 FLUX benchmark가 동일 harness에서 완료됐다.
2. 실패 사유 중 `wrong_identity`, `wrong_pose` 또는 `character-wide drift`가 전체 폐기의 25% 이상이다.
3. 현재 backend의 prompt·normalizer 변경으로 해당 실패가 개선되지 않았다.
4. 로컬 GPU와 저장 공간이 추가 model을 수용한다.
5. model license, offline inference와 weight hash 등록 절차가 확정됐다.

Qwen local editing, IP-Adapter/ControlNet/BrushNet, 캐릭터별 LoRA와 video motion proposal은 위 조건을 근거로 각각 독립 계획을 작성한다.

## 공식 참고 자료

- OpenAI Codex: https://github.com/openai/codex
- Codex App Server protocol: https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
- FLUX.2 official inference: https://github.com/black-forest-labs/flux2
- DINOv2 official repository: https://github.com/facebookresearch/dinov2
- Qwen-Image official repository: https://github.com/QwenLM/Qwen-Image

## 구현 작업자 인수인계

1. Task 0부터 순서대로 실행하고 각 Task의 RED가 기대 이유로 실패하는지 확인한다.
2. 기존 v5.1 candidate 구현 계획의 체크박스를 병행 실행하지 않는다. 안전 요구는 본 계획 Task 4와 5에 흡수되어 있다.
3. 새 runtime dependency를 main Node process에 추가하기보다 pure TypeScript 또는 optional worker에 격리한다.
4. Codex ImageGen과 local model 실제 실행은 자동 test에서 금지한다.
5. 매 commit은 표시된 파일만 stage하고 `git diff --cached --check`를 통과시킨다.
6. 실제 smoke, benchmark와 남은 비보장 사항을 완료 보고에 정확히 기록한다.
