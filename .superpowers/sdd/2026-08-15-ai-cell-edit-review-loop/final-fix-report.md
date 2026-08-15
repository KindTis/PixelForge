# 최종 Important 1~6 수정 보고서

- Fix base: `e555205c285ecbfc5c2d10f5766ca70b4a2795fc`
- 구현 커밋: `7d834650e09dd4b6f449b52fd3755a7be24d240d`
- 범위: 최종 리뷰의 Important 1~6만 수정했다. 새 의존성, React 테스트 프레임워크, GUI·브라우저·실제 Codex·네트워크는 사용하지 않았다.
- 제외 검증: 지시대로 전체 `npm test`, build, graphify는 실행하지 않았다.

## RED 증거

### 서버 Important 1~4

명령:

```text
npx.cmd tsx --test --test-name-pattern "셀 편집 모델 실행|초기 로그 중 terminal|셀 편집 승인과 도구" tests/server.test.ts
```

구현 전 결과: exit 1, 3개 실패.

- 실행 cwd 검사에서 permanent `generated/cell-edit-logs/<jobId>`와 그 안의 JSON/로그 파일이 노출되었다.
- 초기 로그 deferred test는 `초기 로그 barrier에 진입하지 않았습니다.`로 실패하여 로그 직렬화 seam과 terminal 선점 재검사가 없음을 확인했다.
- 종료된 ignored run의 늦은 approval test는 `종료된 실행의 늦은 승인이 거부되지 않았습니다.`로 실패했다.

### 코어/클라이언트 Important 5~6

명령과 구현 전 결과:

```text
npx.cmd tsx --test --test-name-pattern "문서 경계를 넘는 셀" tests/ai-edit-runner.test.ts
# exit 1, selectionReplayMask가 없어 1개 실패

npx.cmd tsx --test --test-name-pattern "프로젝트 epoch와 작업 소유권" tests/client-api.test.ts
# exit 1, lifetime/ownership helper가 없어 1개 실패
```

## Finding별 수정과 검증

### Important 1 — 제한 cwd 격리

- 변경: 각 편집/판정 실행마다 `generated/cell-edit-runs/run-*`을 만들고 permanent log의 원본/후보 PNG를 `original-composite.png`, `original-cel.png`, `candidate-composite.png`, `candidate-cel.png` 네 파일로 복사한다. 모델에는 이 디렉터리와 네 copied path만 전달한다.
- covering test: `셀 편집 모델 실행 디렉터리에는 복사된 PNG 네 개만 보인다`가 모델 호출 직전에 cwd 목록, 네 path의 dirname, 편집/판정별 디렉터리 분리를 확인한다.
- GREEN: 서버 신규 focused 명령에서 3/3 통과. 최종 server wave에서도 해당 테스트 포함 25/25 통과.
- 경쟁/정리 자기검토: 정상 completion 뒤, 취소/기술 실패의 interrupt 정착 뒤, server close의 terminal 선점 뒤에 run directory를 best-effort로 정리한다. start-in-flight는 `closing`/ownership 재검사 뒤 run을 interrupt하고 정리한다. 정리 실패가 정상 결과를 기술 실패로 바꾸지 않으며 permanent `cell-edit-logs`는 삭제 대상으로 사용하지 않는다.
- 변경 파일: `src/server/app.ts`, `tests/server.test.ts`
- 커밋: `7d834650e09dd4b6f449b52fd3755a7be24d240d`

### Important 2 — in-flight 로그와 terminal summary 직렬화

- 변경: job별 `logTail`에 initial/attempt/verdict/summary를 직렬화했다. `terminalDecision`은 동기로 먼저 선점하고 summary만 선행 write가 정착한 뒤 `writeCellEditSummary`가 실제 `log.files`를 복사한다. 실패한 write 뒤에도 큐가 이어지도록 tail rejection을 정착시킨다.
- covering test: `초기 로그 중 terminal 선점은 성공한 파일을 summary에 포함하고 첫 실행을 막는다`가 initial write를 지연하고 global error를 주입해 성공한 세 파일이 summary에 모두 들어가며 terminal 뒤 파일 목록이 증가하지 않음을 확인한다.
- GREEN: 신규 서버 focused 3/3 통과; 최종 server wave 25/25 통과. `tests/cell-edit-log.test.ts`를 포함한 client/core/log wave 27/27 통과.
- 경쟁 자기검토: terminal 선점은 log wait에 막히지 않는다. 잠금 해제와 terminal 공개는 summary write 뒤이며, summary 실패 시 기존 계약대로 failed/부분 로그 위치를 남긴다.
- 변경 파일: `src/server/app.ts`, `tests/server.test.ts`
- 커밋: `7d834650e09dd4b6f449b52fd3755a7be24d240d`

### Important 3 — 초기 로그 중 terminal 뒤 첫 remote run 차단

- 변경: job identity, project lock owner, running status, terminal 미선점, server 미종료를 한 `currentCellJob` 판정으로 묶었다. initial write 뒤, staging 전/후, remote start 반환 뒤에 재검사하며 POST 응답 전 terminal finalization도 정착시킨다.
- covering test: Important 2와 같은 deferred initial test가 global error 뒤 `codex.cellEdits.length === 0`을 확인한다.
- GREEN: 신규 서버 focused 3/3 및 최종 server wave 25/25 통과.
- 경쟁 자기검토: remote start가 이미 in-flight인 경계에서는 반환 즉시 ignored 처리, interrupt, 전용 디렉터리 정리를 수행하며 후속 phase를 연결하지 않는다. server close도 모든 비terminal 셀 job을 동기로 terminal 선점한다.
- 변경 파일: `src/server/app.ts`, `tests/server.test.ts`
- 커밋: `7d834650e09dd4b6f449b52fd3755a7be24d240d`

### Important 4 — ignored run의 늦은 approval 거부

- 변경: run 연결 전 큐에 있던 approval은 `ignoreRun`에서 decline한 뒤 버리고, 이미 ignored인 run에 늦게 온 approval도 즉시 decline한다.
- covering test: `셀 편집 승인과 도구 시도는 즉시 거부·중단하고 실패한다`가 terminal 뒤 request 102를 주입해 decline 응답 1개, terminal 상태 불변, 추가 run 없음까지 확인한다.
- GREEN: 신규 서버 focused 3/3 및 최종 server wave 25/25 통과.
- 경쟁 자기검토: decline은 job 재연결이나 상태 전이를 하지 않는다. terminal 선점 시 run mapping을 먼저 제거하고 ignored 집합에 넣으므로 늦은 event가 새 작업에 적용되지 않는다.
- 변경 파일: `src/server/app.ts`, `tests/server.test.ts`
- 커밋: `7d834650e09dd4b6f449b52fd3755a7be24d240d`

### Important 5 — 문서 밖 cel의 selection replay 일치

- 변경: `selectionReplayMask`가 요청 생성의 `selectionRuns` 결과를 서버와 같은 core `selectionMask`에 직접 전달한다. 최종 apply 입력만 이 normalized mask로 바꾸고 rollback용 raw `settingsSnapshot.selection`은 유지한다.
- covering test: `문서 경계를 넘는 셀도 서버 후보와 클라이언트 재생의 전체 이미지가 같다`가 x=-1인 cel에서 서버 후보와 클라이언트 replay의 전체 cel image bytes를 비교한다.
- GREEN: 신규 core focused 1/1 통과; 최종 client/core/log wave 27/27 통과.
- 수명/복구 자기검토: 새로운 좌표 알고리즘을 복제하지 않고 요청의 runs→core mask mapping을 재사용한다. rollback은 normalized mask가 아닌 사용자 원래 로컬 selection을 복원한다.
- 변경 파일: `src/client/editor/ai-edit.ts`, `src/client/editor/EditorWorkspace.tsx`, `tests/ai-edit-runner.test.ts`
- 커밋: `7d834650e09dd4b6f449b52fd3755a7be24d240d`

### Important 6 — project epoch와 job/application 소유권

- 변경: `{projectId, epoch}` lifetime과 `{projectId, epoch, jobId}` ownership의 순수 match/release helper를 추가했다. App은 epoch ref, active-job owner, application-pending owner를 사용한다. open/create/import/reference/export, save/start/poll/application 관련 await 뒤 소유권을 재검사하고 stale 응답을 무시한다. poll의 정상/오류 terminal 뒤 active owner도 exact-owner 방식으로 해제한다.
- covering test: `프로젝트 epoch와 작업 소유권은 같은 ID의 오래된 응답과 cleanup을 거부한다`가 same-ID/different-epoch, wrong job, stale cleanup, own cleanup 행렬을 확인하며 App이 같은 named helper를 직접 import해 사용한다.
- GREEN: 신규 client focused 1/1 통과; 최종 client/core/log wave 27/27 통과. `npx.cmd tsx -e "import('./src/client/App.tsx')"`도 exit 0.
- 수명 자기검토: 새 lifetime 시작은 이전 active/pending owner를 무효화한다. stale poll의 `finally`는 새 owner를 지울 수 없고, stale rollback은 새 same-ID 문서를 덮지 못한다. dirty 억제는 현재 lifetime과 active job 양쪽이 pending owner와 일치할 때만 적용된다. poll 오류 표시는 owner 해제 전 catch에서 처리하고 finally에서 자기 owner만 해제한다.
- 변경 파일: `src/client/api.ts`, `src/client/App.tsx`, `tests/client-api.test.ts`
- 커밋: `7d834650e09dd4b6f449b52fd3755a7be24d240d`

## 최종 focused 검증

```text
npx.cmd tsx --test --test-name-pattern "<셀 편집 격리·로그·terminal·approval·적용 관련 25개>" tests/server.test.ts
# pass 25, fail 0, duration_ms 4265.1504

npx.cmd tsx --test tests/cell-edit-log.test.ts tests/ai-edit-runner.test.ts tests/client-api.test.ts
# pass 27, fail 0, duration_ms 514.959

npx.cmd tsx -e "import('./src/client/App.tsx')"
# exit 0

git diff --check
# exit 0
```

첫 합본 시도는 `tests/server.test.ts` 전체까지 실행되어 외부 명령 제한 124초에 걸렸고, 성공 판정에 사용하지 않았다. 이후 요구 범위의 관련 server test 25개만 명시적으로 선택한 위 최종 wave는 6.7초에 정상 종료했다.

## 최종 자기검토

- 서버: terminal decision의 동기 선점과 log write 정착 순서를 분리했다. run cwd와 permanent log 소유권도 분리했으며 삭제 helper는 추적한 per-run path만 받는다.
- 클라이언트: 프로젝트 ID만 비교하거나 전역 pending boolean을 쓰는 경로를 제거했다. 동일 ID라도 epoch/job이 다르면 state write, rollback, dirty 억제, cleanup을 수행하지 않는다.
- 단순성: Node 표준 `fs/path`와 기존 순수 mapping을 재사용했고 새 의존성·범위 밖 구조 변경을 추가하지 않았다.
