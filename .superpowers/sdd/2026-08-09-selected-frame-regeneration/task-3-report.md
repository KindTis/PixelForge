# Task 3 구현 보고서

## 상태

완료. 기존 `POST /api/generations`에 선택적 최상위 `frameId`를 통합했으며 새 엔드포인트나 상태 전이는 추가하지 않았다.

## RED / GREEN

- RED: `npx.cmd tsx --test tests/server.test.ts`
  - 기존 서버가 `frameId`를 무시해 전체 시트 프롬프트를 생성함을 확인했다.
  - 결과: 4개 중 2개 실패. 초기 작업 응답의 `frameId`가 `undefined`였고 첫 프레임 참조 문맥이 없었다.
- 자체 검토 RED: `npx.cmd tsx --test tests/server.test.ts`
  - 빈 `frameId`가 전체 시트 생성으로 폴백하는 문제를 확인했다.
  - 결과: 5개 중 1개 실패, HTTP 202(예상 400).
- GREEN: `npx.cmd tsx --test tests/server.test.ts`
  - 결과: 5/5 통과.
- 전체 검증: `npm.cmd test`
  - 결과: 86/86 통과.
- 빌드: `npm.cmd run build`
  - 결과: TypeScript 검사와 Vite 프로덕션 빌드 성공.

## 변경 파일

- `src/server/app.ts`
  - `Job`에 선택적 `frameId`와 단일 프레임 요청 타입을 통합했다.
  - 저장 프로젝트의 선택 프레임을 확인하고 작업 폴더에 역할별 합성 PNG를 기록한다.
  - 완료 시 `frameId` 존재 여부로 단일 프레임 교체와 기존 전체 시트 import를 분기한다.
- `tests/server.test.ts`
  - 실제 HTTP 서버와 실제 저장 프로젝트를 사용하는 통합 테스트 4개를 추가했다.
  - 참조 PNG 바이트, 프롬프트 문맥, 선택 프레임만 교체, 첫·마지막 경계, 잘못된 결과·취소 무변경, 빈 `frameId` 거부를 검증한다.
- `.superpowers/sdd/2026-08-09-selected-frame-regeneration/task-3-report.md`
  - RED/GREEN 증거, 검증 결과와 자체 검토를 기록했다.

## 자체 검토

- 기존 GET/DELETE/approval/poll/lock 상태 전이를 변경하지 않았다.
- 사용자 `referencePath`는 기존 `resolveInside`와 파일 검사 후 추가 프롬프트 참조로 전달한다.
- 첫 프레임과 이전 프레임이 같아도 `first.png`와 `previous.png`를 별도 경로에 기록한다.
- 결과 PNG를 import 함수에서 완전히 검증한 뒤 `saveProject`를 한 번만 호출한다.
- 실패·취소 경로는 `saveProject`를 호출하지 않으며 저장 프로젝트 동일성을 통합 테스트로 확인했다.
- 선택하지 않은 프레임 픽셀과 프레임·레이어·태그·팔레트·기존 이력 보존을 확인했다.

## 우려

없음. 생성 실패나 취소 뒤 작업 폴더의 참조 PNG가 남는 동작은 기존 생성 산출물 보존 정책과 같으며 저장 프로젝트 상태에는 영향을 주지 않는다.

## 수정 라운드 1: `frameId` 런타임 타입 검증

- 발견: `String(input.frameId)` 강제 변환 때문에 실제 프레임 UUID 하나를 담은 배열도 유효한 선택 요청으로 수락됐다.
- covering test: `배열 frameId는 문자열 선택으로 변환하지 않고 거부한다`
- RED: `npx.cmd tsx --test tests/server.test.ts`
  - 결과: 6개 중 1개 실패. 배열 `frameId` 요청이 HTTP 202를 반환했다(예상 400).
- 수정: `frameId`가 `undefined`도 문자열도 아니면 `프레임 ID는 문자열이어야 합니다.` 오류로 즉시 거부하고, 강제 문자열 변환을 제거했다.
- GREEN: `npx.cmd tsx --test tests/server.test.ts`
  - 결과: 6/6 통과.
- 전체 검증: `npm.cmd test` 87/87 통과, `npm.cmd run build` 성공.
