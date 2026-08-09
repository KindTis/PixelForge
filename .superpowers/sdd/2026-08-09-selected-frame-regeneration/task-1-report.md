# Task 1 구현 보고서

## 구현 내용

- `buildFrameRegenerationPrompt`와 `FrameRegenerationRequest`, `FrameReferencePaths`를 추가했다.
- 선택 프레임 인덱스, 가장 짧은 포함 애니메이션 태그, 재생 방향, 문서 기준 진행률을 계산한다.
- 태그가 없으면 전체 구간과 `forward`를 사용한다.
- 캔버스 크기, 투명 배경, 지면 기준점, 역할별 참조 경로, 결과 경로를 한국어 프롬프트에 포함한다.
- 빈 프롬프트·출력 경로·첫 참조 경로와 존재하지 않는 프레임을 검증한다.

## 변경 파일

- `src/server/generation.ts`
- `tests/generation.test.ts`

## RED

명령:

```text
npx.cmd tsx --test tests/generation.test.ts
```

핵심 실패 출력:

```text
SyntaxError: The requested module '../src/server/generation.ts' does not provide an export named 'buildFrameRegenerationPrompt'
```

실패 이유: 계약 함수가 아직 구현·export되지 않았기 때문이다.

## GREEN

- `npx.cmd tsx --test tests/generation.test.ts` → 8 tests, 8 pass, 0 fail
- `npm.cmd test` → 72 tests, 72 pass, 0 fail
- `npm.cmd run build` → `tsc --noEmit` 및 Vite build 성공

## 자체 검토 및 우려

- 변경은 지정된 두 소스/테스트 파일에 한정했다.
- 프로젝트 문서나 선택하지 않은 프레임을 변경하지 않으며, 생성 이력·상태 머신도 추가하지 않았다.
- `parentId`는 후속 생성 흐름에서 사용할 계약 필드이므로 이 프롬프트 빌더에서는 소비하지 않는다.
- 현재 태그 선택은 태그 수가 적은 편집기 문서를 전제로 한 선형 탐색이며, 대규모 태그 성능이 필요해질 때만 인덱싱을 검토한다.

## 수정 라운드 1

### 변경 내용

- 2프레임 프로젝트에서 첫 프레임은 `first`·`next`만, 마지막 프레임은 `first`·`previous`만 포함하고 반대 역할은 제외하는 테스트를 추가했다.
- `previous`·`next`가 공백이면 참조 역할을 프롬프트에 포함하지 않도록 `trim()` 검사로 수정했다.

### TDD 검증

RED 명령:

```text
npx.cmd tsx --test tests/generation.test.ts
```

핵심 실패: `공백인 선택 참조 경로는 프롬프트에 포함하지 않는다` 테스트가 실패했고, 출력에 `이전 프레임 참조:  ` 및 `다음 프레임 참조:`가 포함됐다.

GREEN 명령 및 결과:

- `npx.cmd tsx --test tests/generation.test.ts` → 10 tests, 10 pass, 0 fail
- `npm.cmd test` → 74 tests, 74 pass, 0 fail
