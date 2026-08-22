# 생성 후보 기반 영역 교체 v5.1 수정 명세

작성일: 2026-08-22  
상태: 검증 결과 반영 완료, 구현 미착수

## 문서 성격과 상속·대체 범위

이 문서는 [Pixel Agent Improvement Plan v5.1](../../pixel-agent-improvement-plan-v5.md)의 생성 후보 기반 영역 교체 기능에 대한 delta 명세다. 기존 [2026-08-20 구현 계획](../plans/2026-08-20-pixel-agent-generation-candidate.md)의 G3 호출 전 차단 설계는 세 번의 실제 검증에서 실패했으므로 폐기한다. 기존 문서는 실패 당시의 감사 원본으로 보존하고 실행하지 않는다.

다음 계약은 그대로 상속한다.

- 완료된 기존 Task 1–4의 base fingerprint, row-major 단일 `EditCommand`, linked copy-on-write, replay 검증과 `History.execute()` 1회 계약
- 정확히 128×128 RGBA인 현재 문서, `(0, 0)`의 128×128 활성 target image, 보이고 잠기지 않은 활성 layer/cel, 원본 alpha와 교집합이 있는 명시적 선택 영역만 지원하는 Core 범위
- App Server가 반환한 생성 PNG payload를 불신하고 base64·크기·codec을 검증한 뒤 전체 이미지를 최근접 보간으로 128×128에 정규화하는 규칙
- 선택 밖 바이트와 전체 target alpha를 보존하고, 미리보기 중 프로젝트 저장과 History 변경을 하지 않으며, 사용자가 적용할 때만 단일 command를 실행하는 규칙
- 자동 재시도 금지와 사용자의 `다시 생성`만 새 사용자 시도로 인정하는 규칙

이 문서가 대체하는 항목은 다음과 같다.

- `PreToolUse` hook, 외부 claim 파일, hook trust/hash/identity 검증
- 특정 Codex 버전 `0.149.0` 고정과 project-local native package resolver
- “사용자 시도 하나당 실제 ImageGen 시작 최대 1회”라는 호출 전 하드캡
- G3 PASS를 제품 코드 구현의 선행 조건으로 둔 의존 순서
- `generation_call_limit`라는 보장형 실패 이름과 실제 호출 수를 상한으로 표현한 품질 검증 계획

감사 근거는 [G3 실행 기록](../plans/2026-08-20-pixel-agent-generation-candidate-execution.md)과 [G3 구현 보고서](../../../.superpowers/sdd/2026-08-20-pixel-agent-generation-candidate/task-G3-report.md)에 남아 있다. 실행 기록은 초기 단계만 포함하므로 최종 판정은 구현 보고서의 마지막 결과를 우선한다.

## 실패 감사 기준선

사용자와 합의한 실제 비용 probe 상한은 총 3회였고 모두 `verdict:"fail"`, `turnStatus:"failed"`, approval request 0회였다. 합계 4회의 실제 ImageGen 시작이 관측됐다.

| 시도 | 실제 시작 | 정상 차단 run | 삭제 시도 필드/실제 관측 | 외부 claim | 최종 관측 |
|---|---:|---:|---|---|---|
| 1차 | 2 | 0 | 보고 필드 `false`/삭제 관측 | 삭제됨 | candidate가 OS temp claim을 삭제한 뒤 두 번째 ImageGen까지 시작 |
| 2차 | 1 | 0 | 확인 | 생존 | 둘째 요청 뒤 정상 `blocked` 증거 없이 probe가 turn 중단 |
| 3차·마지막 | 1 | 0 | 확인 | 생존 | `failureReason:"hook-failed"`, `failureDetail:null`; 둘째 실제 시작은 중단 전 관측되지 않음 |

3차에서 둘째 요청부터 probe 중단까지는 약 1.90초였으므로 설정한 5초 hook timeout은 원인에서 제외됐다. 다만 raw `hook/completed` payload, stderr, 종료 코드와 runner error가 보존되지 않았다. `failureDetail:null`은 identity mismatch가 아니라 hook 실행 상태 실패 분기였고, gate가 `stopped`를 만드는 JSON을 쓰지 않았으므로 가장 좁은 근거 기반 결론은 정상 deny가 runner에서 `failed`로 끝났다는 것이다. 그 하위 원인은 확정할 수 없다.

2·3차에서 두 번째 실제 시작이 관측되지 않은 사실을 hook이 정상 차단했다는 증거로 해석하지 않는다. 두 시도 모두 성공적인 `blocked` run은 0개였고, probe 자체가 비정상 hook 상태를 보고 turn을 중단했다.

해당 Windows 환경에서는 native `shell:false` argv 전달과 실제 `<session-flags>` key가 확인됐고, 보정 후 2·3차의 setup·삭제 hook 범위에서 identity/trust, 외부 claim 격리와 임시 디렉터리 정리가 확인됐다. 2차의 둘째 ImageGen hook identity는 확정하지 않는다. 별도의 무비용 gate script 단위 테스트에서도 첫 실행은 성공하고 둘째 실행은 제한 오류로 끝났다. 이는 live hook runner의 정상 차단 증거가 아니다. `<`, `>` 전달은 최종 실패 원인이 아니며, 새 설계는 hook 설정 문자열 자체를 사용하지 않으므로 이 문자를 별도로 호환 처리하지 않는다.

합의한 3회 상한에 도달했으므로 네 번째 실제 Codex/ImageGen probe는 이 명세와 구현 계획에 포함하지 않는다.

## 문제와 수정 목표

PixelForge는 사용자가 선택한 활성 셀 영역을 구조·재질 수준으로 교체할 수 있는 생성 후보를 제공해야 한다. 생성 결과는 바로 문서에 쓰지 않고 검증된 preview와 재생 가능한 단일 command로 반환해야 한다.

현재 Codex의 내장 `$imagegen`은 ChatGPT 로그인으로 사용할 수 있고 사용자가 별도의 OpenAI API 키를 제공할 필요가 없다. 반면 App Server가 한 turn 내부의 ImageGen 실제 시작 횟수를 호출 전에 원자적으로 제한하는 공개 계약은 확인되지 않았다. 모델 지시, event 감시와 프로세스 종료는 위험을 줄이지만 이미 시작된 두 번째 호출의 사용량까지 되돌릴 수 없다.

수정 목표는 통제 가능한 경계만 제품 계약으로 삼는 것이다.

- 앱은 한 사용자 시도에서 candidate용 Codex turn을 정확히 한 번만 시작한다.
- 앱은 자동 재시도나 fallback turn을 시작하지 않는다.
- candidate, 일반 generation과 cell edit는 하나의 동기식 시작 claim을 공유한다. claim 획득부터 POST 응답을 기존 job ownership으로 넘기거나 시작이 끝날 때까지 다른 Codex 시작은 project lifetime을 바꾸기 전에 거부한다.
- candidate마다 전용 Codex App Server 프로세스와 전용 작업 디렉터리를 사용한다.
- 첫 `imageGeneration` 완료가 관측되면 추가 작업을 기다리지 않고 turn 중단과 전용 프로세스 종료를 즉시 시작한다.
- 두 번째 `imageGeneration` 시작이 관측되면 결과를 폐기하고 실패 처리한다.
- Codex 시작, 로그인, skill 또는 event 계약이 달라져도 candidate 기능만 실패하거나 현재 서버 세션에서 비활성화되며 일반 생성·셀 편집·편집기 기능은 유지된다.
- 신뢰 경계, 무저장 preview와 단일 History 적용은 모델 동작과 무관하게 결정적으로 검증한다.

## 비목표

- 실제 ImageGen 시작 횟수의 호출 전 하드캡 또는 비용 상한 보장
- 직접 OpenAI Images API, API 키 입력·저장, `codex exec` 또는 다른 생성 공급자 fallback
- 일반 Codex process가 상속하는 호스트 ambient 환경의 API-key 변수 검사·제거
- Codex 버전 문자열, 내부 hook key/hash, trust 상태나 비공개 설정 구조에 맞춘 호환 테이블
- 모델이 추가 생성을 요청하기 전에 그 의도를 완전히 예측하는 것
- 네 번째 G3 probe 또는 구현 과정의 실제 모델/ImageGen 자동 테스트
- 32/64/96px, indexed 문서, non-zero cel offset, 실루엣 확장, 자동 부위 인식, 다중 프레임, pose 변경과 전체 재설계
- 자동 품질 판정, 자동 재생성, 사용자 설정형 retry 횟수

실제 호출 전 하드캡이 다시 필수 요구가 되면 이 자동 candidate 경로는 활성화하지 않는다. 그 요구는 호출 수를 직접 통제하는 별도 backend 계약이 먼저 확보될 때만 다시 설계한다.

## 검토한 구조

### 선택: 시도별 격리 프로세스와 완료 즉시 종료

각 candidate 요청이 새 `CodexBridge`를 만들고 ChatGPT 계정과 활성 `imagegen` skill을 확인한 뒤 `$imagegen` turn 하나를 시작한다. 원본 cel·합성본·selection mask·overlay는 App Server의 `localImage` 입력으로 직접 전달한다. candidate 깊은 모듈이 event, timeout, cancel, 생성 결과 payload 검증과 프로세스 정리를 모두 소유한다. 첫 이미지 생성 완료 event에서 PNG base64를 확보한 뒤 전용 프로세스를 종료하므로 기존 일반 생성이나 셀 편집 bridge에는 영향을 주지 않는다.

이 구조는 내부 Codex 버전을 고정하지 않고 기존 `startGeneration()` 계약을 재사용한다. 실패 범위가 candidate job 하나로 한정되고, fake event sequence로 제품 상태와 정리를 비용 없이 검증할 수 있다.

### 제외: `PreToolUse` 호출 gate 보강

세 번의 실제 probe에서 정상 `blocked` run을 한 번도 입증하지 못했다. Codex 0.149의 hook runner 일부 실패가 fail-open일 수 있어 더 많은 key, hash, path와 version 검사를 추가해도 절대 상한이 되지 않는다. 이미 합의한 probe 상한도 소진했으므로 제외한다.

### 제외: 직접 Images API

호스트가 API 요청 수를 직접 제어할 수 있다는 장점은 있지만, 사용자가 별도 API 키와 과금 경로 없이 내장 `$imagegen`을 사용한다는 확정 요구와 충돌한다.

### 제외: 공급자 추상화

현재 제품은 내장 `$imagegen` 한 경로만 필요하다. 단일 구현을 위한 provider interface, registry나 fallback chain은 만들지 않는다. 테스트 seam은 시도마다 전용 bridge를 만드는 함수 하나로 제한한다.

## 인증·사용량 계약

- 인증은 기존 `account/read` 결과의 ChatGPT 계정만 허용한다.
- `skills/list`에서 enabled `imagegen`을 찾고 기존 `$imagegen` turn input을 사용한다.
- PixelForge UI와 server는 API 키를 요청·읽기·저장하거나 candidate용 값으로 주입하지 않는다.
- 일반 Codex 자식 프로세스는 기존 동작대로 호스트 프로세스의 ambient 환경을 상속한다. PixelForge는 그 환경의 API-key 변수를 검사하거나 변경하지 않는다.
- 별도 Images API를 호출하지 않는다.
- 내장 `$imagegen`은 Codex 사용량 한도에 포함될 수 있다. “API 키 불필요”는 무료, 오프라인 또는 무제한을 뜻하지 않는다.
- 앱이 보장하는 단위는 사용자 시도당 `startGeneration()` 호출 1회와 자동 retry 0회다. turn 내부 실제 도구 시작 수는 관측값이지 상한이 아니다.

공식 사용 방식은 [OpenAI Learn — Image generation](https://learn.chatgpt.com/docs/image-generation)을 기준으로 한다. 문서에는 `$imagegen`을 통한 내장 skill 사용과 더 큰 programmatic 작업을 위한 별도 API 경로가 구분되어 있다.

## 지원 입력과 preflight

요청 형태는 다음과 같다.

```ts
export type GenerationEditRequest = {
  mode: "generation-candidate";
  prompt: string;
  target: AiEditTarget;
  editableSelection: AiSelectionRun[];
};
```

Codex 프로세스나 임시 디렉터리를 만들기 전에 다음을 모두 확인한다.

- request는 알려진 필드만 가진 record이며 `mode`가 정확하다.
- `prompt.trim()`이 비어 있지 않다.
- 문서와 target image가 정확히 128×128 RGBA이고 data length가 일치한다.
- target의 frame/layer/cel/image 소유 관계가 유일하고 cel offset은 `(0, 0)`이다.
- layer는 보이고 잠기지 않았으며 layer/cel opacity는 0보다 크다.
- 각 selection run의 좌표는 정수이고 문서 안에 있으며 `startX <= endX`다.
- `selection && originalTargetAlpha > 0`인 픽셀이 하나 이상이다.

지원하지 않는 target은 `blocked/unsupported_target`, 유효 교집합이 없는 선택은 `blocked/empty_selection`으로 끝난다. 이 두 결과에서는 candidate bridge 생성과 `startGeneration()` 호출이 모두 0회다.

## 격리 생성 계약

한 사용자 시도의 작업 디렉터리는 `mkdtemp()`로 만들고 다음 입력 PNG만 기록한다.

```text
original-cel.png
original-composite.png
selection-mask.png
selection-overlay.png
```

네 경로는 `turn/start`의 `localImage` 항목으로 전달한다. 별도 `instructions.txt`와 workspace output 파일은 만들지 않는다. prompt는 다음 행위를 명시한다.

- 제공된 원본, 선택 mask와 overlay를 참고한다.
- 내장 ImageGen을 정확히 한 번만 실행한다.
- 전체 정사각 RGB 또는 RGBA 이미지를 생성한다.
- 파일 쓰기·복사·이동과 다른 도구를 사용하지 않는다.
- 생성 완료 뒤 추가 생성이나 자동 재시도 없이 종료한다.

이 지시는 모델 행동 규칙이며 보안 경계나 호출 전 하드캡으로 간주하지 않는다.

Codex App Server 0.149의 `imageGeneration` 완료 item은 `status`, PNG base64인 `result`와 optional `savedPath`를 포함한다. PixelForge는 `result`만 사용하고 `savedPath`와 `$CODEX_HOME/generated_images` 파일에 의존하거나 이를 삭제하지 않는다. 이 필드는 버전 allowlist가 아니라 현재 확인된 semantic contract이며, 이후 Codex가 호환되지 않는 shape를 보내면 아래 `generation_protocol_changed`로 격리한다. item과 turn input shape의 근거는 OpenAI Codex `rust-v0.149.0`의 [App Server protocol](https://github.com/openai/codex/blob/rust-v0.149.0/codex-rs/app-server/README.md)과 [ImageGenerationItem](https://github.com/openai/codex/blob/rust-v0.149.0/codex-rs/protocol/src/items.rs)이며, standalone `$imagegen`의 `b64_json`을 완료 item `result`로 전달하는 직접 근거는 [image-generation tool 구현](https://github.com/openai/codex/blob/rust-v0.149.0/codex-rs/ext/image-generation/src/tool.rs)이다.

candidate bridge listener는 `startGeneration()` 전에 연결하고, 반환 전에 도착한 event를 run id가 정해질 때까지 순서대로 보관한다. 다음 규칙을 적용한다.

1. `startGeneration({ cwd, prompt, approvalPolicy:"never", sandbox:"read-only", localImagePaths })`를 정확히 한 번 호출한다.
2. 모든 approval request는 즉시 decline하고 candidate를 실패시킨다.
3. 첫 `item/started`의 `imageGeneration`을 관측 수 1로 기록한다.
4. 첫 `item/completed`의 `imageGeneration`은 `status === "completed"`, standard base64 `result`와 정확히 같은 run id여야 한다. 유효하면 raw result를 메모리에서 한 번 소유하고 `stopping_after_image` 단계를 선점한 뒤 `interrupt()`를 best-effort로 요청하고 `close(1_000)`으로 즉시 종료 절차를 시작한다. 양수 timeout은 종료 신호를 늦추는 대기 시간이 아니라 각 graceful/terminate/force 단계에서 실제 비동기 `close` event를 받을 bounded wait다. 이 시점에는 성공을 공개하지 않는다.
5. process close가 끝날 때까지 listener를 유지한다. 그 전에 두 번째 `imageGeneration` start가 관측되면 `multiple_generation_detected`, 두 번째 completion이 관측되면 `generation_protocol_changed`로 확정하고 raw result와 preview를 폐기한다. 관측 start와 completion이 각각 정확히 1이고 payload·PNG·병합 검증까지 끝난 뒤에만 성공을 확정한다.
6. image completion 전 turn 종료, App Server error, timeout, failed status 또는 빈 result는 `generation_failed`다.
7. `item/completed`가 `imageGeneration`으로 식별됐지만 예상한 run id/status/result 관계가 없거나 non-empty raw result가 standard base64가 아닌 경우는 `generation_protocol_changed`다. 다른 item의 정상적인 interleaving은 무시한다. image start 뒤 인식 가능한 image completion 없이 turn이 끝난 경우는 호출 실패인 `generation_failed`로 두며 capability latch를 걸지 않는다. protocol mismatch가 확정되면 현재 PixelForge 서버 세션의 이후 candidate 요청은 503으로 거부하지만 다른 기능은 계속 동작한다.
8. cancel, 실패, 성공과 server close 모두 같은 멱등 정리 경로를 사용한다.

두 번째 start 감지는 사후 방어다. 감지된 두 번째 생성은 이미 사용량에 반영될 수 있으며, 감지되지 않은 내부 재호출이 없다고 증명하지 않는다.

## 공개 결과와 상태

```ts
export type GenerationCandidateFailureCode =
  | "generation_failed"
  | "generation_protocol_changed"
  | "multiple_generation_detected"
  | "invalid_candidate"
  | "no_effect";

export type GenerationCandidateResult = {
  outcome: "candidate_ready";
  summary: string;
  preview: { mimeType: "image/png"; base64: string };
  candidateTargetHash: string;
  baseFingerprint: AiEditBaseFingerprint;
  command: EditCommand;
};

export type GenerationCandidateDisposition =
  | "applied"
  | "regenerated"
  | "discarded"
  | "stale_base"
  | "apply_failed";
```

서버 job은 기존 `kind:"generation"`을 유지하고 `mode:"generation-candidate"`로 project generation과 구분한다. candidate wire에는 cwd, raw path, prompt, audit, bridge, `approval`과 `project`를 포함하지 않는다. 성공한 job에만 `result`, 실패한 job에만 `failureCode`가 존재한다.

상태 흐름은 다음과 같다.

```text
preflight blocked → HTTP 400, job 없음
candidate session unavailable → HTTP 503, job 없음
start failed → failed job
running → completed(candidate_ready)
running → failed(runtime failure)
running → cancelled
```

`generation_protocol_changed`가 한 번 확정되면 현재 PixelForge 서버 세션에서 candidate capability만 unavailable로 latch한다. 앱 재시작은 새 Codex 설치에 대해 다시 시도할 수 있는 명시적 경계다. Codex 버전 문자열을 allowlist로 검사하지 않는다.

## 생성 payload 신뢰 경계와 strict 병합

`imageGeneration.result`는 외부 프로세스가 보낸 신뢰할 수 없는 입력이다.

- `typeof result === "string"`, standard base64 alphabet·padding·canonical re-encode를 확인한다.
- base64 문자열 길이에서 계산한 decoded 상한이 16MiB를 넘으면 `Buffer` 할당 전에 거부한다.
- decoded bytes도 16MiB 이하여야 하며 SHA-256을 계산한 뒤 raw base64 string 참조를 즉시 버린다.
- candidate decoder만 1..2048 정사각, 8-bit, non-interlaced RGB/RGBA를 허용한다.
- indexed, grayscale, 손상된 CRC/chunk, 과도한 inflate와 trailing bytes를 거부한다.
- RGB는 alpha 255인 RGBA로 바꾸고 전체 정사각 이미지만 최근접 보간으로 128×128에 맞춘다.
- crop, content detection, anchor 이동과 정렬 휴리스틱은 사용하지 않는다.

병합 가능 픽셀은 `selection && originalTargetAlpha > 0 && generatedAlpha > 0`이다. 해당 픽셀의 RGB만 생성 결과로 바꾸고 alpha는 원본을 유지한다. 선택 밖, 원본 투명 픽셀과 생성 투명 픽셀은 원본 RGBA를 그대로 둔다.

변경 픽셀이 없으면 `no_effect`다. 변경이 있으면 기존 `applyCommand()`와 `createAiEditApplication()`을 사용해 candidate document, linked copy-on-write, row-major command, replay와 fingerprint를 검증한다. 다른 병합 엔진이나 History 구현을 만들지 않는다.

## preview와 사용자 결정

candidate 준비 완료는 프로젝트 적용 완료가 아니다.

- 서버는 candidate 결과를 project manifest/image에 쓰는 `saveProject()`, sprite import와 generation history 갱신을 하지 않는다. 요청 직전 클라이언트가 현재 사용자 편집을 저장하는 기존 save-before-Codex 동작은 별도다.
- 클라이언트는 현재 canvas를 원본으로 유지하고 검증된 target PNG만 pixelated preview로 표시한다.
- preview 중 `History.execute()`는 0회다.
- `적용`은 현재 활성 target과 base fingerprint를 다시 확인하고 command를 사전 replay한 뒤 target hash가 일치할 때만 `History.execute()`를 정확히 한 번 호출한다.
- stale base는 `stale_base`, 잠금·가시성·opacity 또는 replay/hash 문제는 `apply_failed`다. 두 경우 모두 History는 0회다.
- `다시 생성`은 현재 document, target과 selection을 다시 capture하고 새 독립 사용자 시도를 시작한다. 자동 retry가 아니다.
- 완료 후보의 `취소`는 preview만 버리고 DELETE, History와 ImageGen 호출을 하지 않는다.
- 완료 후보를 검토하는 동안 project open/create/select/leave, 일반 generation, cell edit와 import handler는 안내 오류를 표시하고 정상 반환한다. 이벤트 호출부가 `void handler()`여도 rejected Promise를 만들지 않는다.

UI는 candidate 시작과 `다시 생성`이 Codex 사용량을 사용할 수 있음을 안내한다. 추가 생성이 관측되면 결과가 폐기되지만 이미 시작된 사용량은 발생할 수 있다는 사실을 비용 상한 표현 없이 알린다.

## 로그와 정리

기존 `CellEditLog`의 순차 writer와 부분 실패 보존 패턴을 재사용한다. candidate attempt에는 필요한 정보만 남긴다.

```text
generated/cell-edit-logs/<jobId>/
  request.json
  candidate-normalized.png   # decode 성공 뒤만
  candidate-preview.png      # candidate_ready일 때만
  candidate.json
  disposition.json           # 첫 사용자 결정이 기록됐을 때만
```

`request.json`에는 protocol/prompt revision, target, base fingerprint, selection pixel 수와 네 input PNG hash를 기록한다. `candidate.json`에는 관측한 `imageGeneration` 시작·완료 수, termination, failure code, PNG/audit 수치와 기록된 파일 목록을 둔다. raw base64, optional `savedPath`, raw 생성 PNG와 bridge event 원문은 장기 보존하지 않는다.

로그 실패는 candidate 결과나 이미 끝난 로컬 적용을 rollback하지 않는다. disposition은 위 다섯 문자열만 허용하고 그 밖의 값은 claim 전에 400이다. 유효한 첫 값 하나를 동기 claim하며 같은 값 재요청은 멱등, 다른 값은 409다.

임시 cwd와 전용 bridge는 start 실패, timeout, approval, 복수 start, invalid PNG, no-effect, 성공, cancel과 server close에서 모두 정리한다. server close는 job 등록 전의 in-flight candidate start도 추적해 cancel·정리가 끝날 때까지 close 완료를 공개하지 않는다. 정리는 멱등이며 late event가 job, project 또는 History를 되살리지 못한다.

## 오류·중단·복구 계약

| 조건 | 공개 결과 | 사용자 복구 | 다른 기능 영향 |
|---|---|---|---|
| 지원하지 않는 target | `blocked/unsupported_target` | 지원 target/문서 사용 | 없음 |
| 빈 editable selection | `blocked/empty_selection` | 선택 조정 | 없음 |
| ChatGPT 미로그인 또는 imagegen 비활성 | HTTP 202 failed job의 `generation_failed` | 로그인/skill 활성화 뒤 명시 재시도 | 없음 |
| candidate factory 미주입 또는 protocol latch | HTTP 503, job 없음 | 앱 구성 확인 또는 재시작 | candidate만 비활성 |
| Codex 시작·turn·timeout 오류 | `generation_failed` | 명시 재시도 | 없음 |
| 식별된 image completion의 개수/run/status/result 의미 계약 불일치 | `generation_protocol_changed`, 이후 candidate 503 | 앱 재시작 또는 호환 버전 확인 | candidate만 비활성 |
| 두 번째 시작 관측 | `multiple_generation_detected` | 결과 폐기 후 사용자가 판단 | 없음; 이미 시작된 사용량 가능 |
| non-empty result의 base64 alphabet/padding/canonical 계약 불일치 | `generation_protocol_changed`, 이후 candidate 503 | 앱 재시작 또는 호환 버전 확인 | candidate만 비활성 |
| canonical base64의 decoded 크기·PNG codec/구조 검사 실패 | `invalid_candidate` | 명시 재생성 | 없음 |
| 유효 변경 0 | `no_effect` | prompt/selection 조정 | 없음 |
| stale 또는 적용 검증 실패 | disposition 기록, History 0 | 현재 상태로 새 후보 생성 또는 취소 | 없음 |
| 허용 목록 밖 disposition body | HTTP 400, claim/log 0 | 올바른 UI 요청 사용 | 없음 |

candidate 호환 실패를 해결하기 위해 앱 시작을 막거나 일반 bridge를 후보 fallback으로 사용하지 않는다. 사용자 전역 Codex 설정, trust 상태와 home 디렉터리 파일을 생성·수정·삭제하지 않는다. Codex 자체가 만든 generated image artifact가 있더라도 PixelForge가 정리하지 않는다.

## 수용 기준

1. G3 hook script, probe, 관련 테스트, hook/trust/version resolver와 `@openai/codex@0.149.0` pin이 제품 변경에서 제거된다.
2. 기존 일반 generation과 cell-edit의 Codex process 시작 방식은 기준 HEAD 동작을 유지한다.
3. candidate는 ChatGPT 로그인과 enabled `imagegen` skill을 사용한다. PixelForge의 별도 API 키 입력·저장·주입과 직접 Images API 경로는 없다.
4. 유효 사용자 시도 하나에서 앱의 candidate `startGeneration()` 호출은 정확히 1회이고 자동 retry는 0회다.
5. candidate마다 별도 bridge/process를 사용하고 첫 이미지 완료, 모든 terminal, cancel과 server close에서 정리된다.
6. 첫 이미지 완료 뒤 즉시 중단·종료를 시작하고 관측된 두 번째 start는 `multiple_generation_detected`로 결과를 폐기한다. 이를 호출 전 하드캡으로 표현하지 않는다.
7. 식별된 image completion의 개수/run/status/result 또는 non-empty base64 의미 계약 불일치는 `generation_protocol_changed`로 candidate만 현재 서버 세션에서 비활성화한다.
8. invalid preflight는 bridge 생성과 turn 시작 0회이며, raw base64와 PNG는 모든 신뢰 검사를 통과해야 한다.
9. strict 병합 뒤 선택 밖 바이트와 target alpha diff가 0이고 기존 application replay가 성공해야만 preview를 공개한다.
10. candidate 결과를 project manifest/image에 쓰는 서버 저장과 preview 중 History 변경은 0회이고, 유효 적용에서만 `History.execute()`가 정확히 1회다.
11. candidate, 일반 generation과 cell edit의 시작 handler가 같은 동기식 claim을 사용한다. 같은 tick의 candidate↔일반 generation/cell edit 교차 시작은 POST가 하나뿐이고 거부된 경로는 project lifetime을 바꾸지 않는다.
12. 유효 선택이 있는 generation panel의 `선택 영역 생성 교체` 버튼이 최초 시도를 시작한다. 다시 생성은 명시적 새 사용자 시도이고 완료 취소는 ImageGen과 History를 호출하지 않는다.
13. 완료 후보 검토 중 lifetime/job을 바꾸는 handler는 사용자 안내 뒤 정상 반환하며 처리되지 않은 Promise rejection을 만들지 않는다.
14. 로그·disposition 실패와 late event가 완료 결과, project와 History를 변경하지 않는다.
15. 자동 검증은 fake Codex/event와 로컬 PNG fixture만 사용하며 실제 Codex turn, ImageGen, GUI와 브라우저를 실행하지 않는다.
16. 관련 단위 테스트, TypeScript typecheck, production build, `git diff --check`와 staged commit 대상의 `git diff --cached --check`가 통과한다.

## 구현 영향 범위

예상 변경은 다음 파일로 제한한다.

- G3 잔여 제거: `package.json`, `package-lock.json`, `src/server/codex-bridge.ts`, `tests/codex-bridge.test.ts`, G3 전용 script/test 세 파일
- Core/type 재사용: `src/core/ai-edit.ts`, `src/core/resize.ts`
- 신뢰 경계와 깊은 모듈: `src/server/png.ts`, `src/server/generation-candidate.ts`
- 서버 연결과 로그: `src/server/index.ts`, `src/server/app.ts`, `src/server/cell-edit-log.ts`
- 클라이언트 review/apply: `src/client/api.ts`, `src/client/App.tsx`, `src/client/editor/EditorWorkspace.tsx`, `src/client/styles.css`
- 테스트: `tests/codex-bridge.test.ts`, `tests/png.test.ts`, `tests/resize.test.ts`, `tests/generation-candidate.test.ts`, `tests/server.test.ts`, `tests/cell-edit-log.test.ts`, `tests/client-api.test.ts`, `tests/editor-workspace.test.ts`와 재사용하는 기존 core 회귀 테스트

새 runtime dependency, provider abstraction, hook 설정 파일과 별도 daemon은 추가하지 않는다.

## 검증 제외와 후속 조건

네 번째 G3 비용 probe는 합의한 상한에 따라 금지한다. 이와 별개로 이 수정 계획의 자동 검증 범위는 fake Codex event, 로컬 PNG, typecheck와 build로 정했으므로 실제 Codex/ImageGen smoke나 품질 batch를 구현 완료 판정에 포함하지 않는다.

따라서 이 문서만으로 unpinned/global Codex process가 실제 환경에서 시작되는지, ChatGPT account와 `skills/list`가 통과하는지, 실제 `imageGeneration` event의 이름·순서·필드가 계속 일치하는지, 실제 `$imagegen`이 usable PNG result를 반환하는지, 모델 품질과 실제 도구 호출 상한을 주장하지 않는다. G3의 project-local 0.149 전용 실행 증거를 G4 이후 generic process의 호환성 증거로 이전하지 않는다.

향후 실제 품질 평가는 이 계획의 자동 단계나 완료 조건이 아니다. 별도 정책이 생기더라도 각 실행을 명시적 사용자 시도로 기록해야 하며, 실행 횟수를 실제 ImageGen 비용 상한으로 표현해서는 안 된다.

## 미결정 항목

없음.
