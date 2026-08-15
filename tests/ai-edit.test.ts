import assert from "node:assert/strict";
import test from "node:test";
import {
  AI_EDIT_CRITERIA,
  AI_EDIT_OUTPUT_SCHEMA,
  EDITOR_TOOLS,
  hasPixelActions,
  parseAiEditResult,
  parseAiEditVerdict,
  type AiEditRequest,
} from "../src/core/ai-edit.ts";
import { createDocument, createProject } from "../src/core/document.ts";
import { celKey } from "../src/core/types.ts";
import { activeCelFrame, buildAiEditPrompt, validateAiEditRequest } from "../src/server/ai-edit.ts";

const validPoints = {
  pencil: [{ x: 0, y: 0 }],
  eraser: [{ x: 0, y: 0 }],
  line: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
  curve: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
  rectangle: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
  ellipse: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
  polygon: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
  fill: [{ x: 0, y: 0 }],
  gradient: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
  spray: [{ x: 0, y: 0 }],
  eyedropper: [{ x: 0, y: 0 }],
  select: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
  lasso: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 2 }],
  wand: [{ x: 0, y: 0 }],
} as const;

const passingCriteria = AI_EDIT_CRITERIA.map((id) => ({ id, passed: true, reason: "기준을 충족했습니다." }));

test("AI 편집 판정은 다섯 기준과 pass/fail 수정 지시 불변식을 검증한다", () => {
  assert.equal(parseAiEditVerdict({
    verdict: "pass",
    summary: "요청과 스타일을 충족했습니다.",
    criteria: passingCriteria,
    corrections: [],
  }).verdict, "pass");

  assert.throws(() => parseAiEditVerdict({
    verdict: "pass",
    summary: "모순",
    criteria: [{ ...passingCriteria[0], passed: false }, ...passingCriteria.slice(1)],
    corrections: [],
  }), /모든 기준/);

  assert.throws(() => parseAiEditVerdict({
    verdict: "fail",
    summary: "수정 필요",
    criteria: [{ ...passingCriteria[0], passed: false }, ...passingCriteria.slice(1)],
    corrections: [],
  }), /수정 지시/);

  assert.throws(() => parseAiEditVerdict({
    verdict: "fail",
    summary: "잘못된 참조",
    criteria: [{ ...passingCriteria[0], passed: false }, ...passingCriteria.slice(1)],
    corrections: [{ criterion: "preservation", region: "몸통", problem: "문제", requiredChange: "복원" }],
  }), /통과한 기준/);

  assert.throws(() => parseAiEditVerdict({
    verdict: "pass",
    summary: "중복 기준",
    criteria: [passingCriteria[0], passingCriteria[0], ...passingCriteria.slice(2)],
    corrections: [],
  }), /다섯 기준/);
  assert.throws(() => parseAiEditVerdict({
    verdict: "pass",
    summary: "누락 기준",
    criteria: passingCriteria.slice(1),
    corrections: [],
  }), /다섯 기준/);
  assert.throws(() => parseAiEditVerdict({
    verdict: "pass",
    summary: "빈 사유",
    criteria: [{ ...passingCriteria[0], reason: "" }, ...passingCriteria.slice(1)],
    corrections: [],
  }), /reason/);
  assert.throws(() => parseAiEditVerdict({
    verdict: "pass",
    summary: "추가 필드",
    criteria: [{ ...passingCriteria[0], extra: true }, ...passingCriteria.slice(1)],
    corrections: [],
  }), /허용되지 않는 필드/);
  assert.throws(() => parseAiEditVerdict({
    verdict: "pass",
    summary: "알 수 없는 기준",
    criteria: [{ ...passingCriteria[0], id: "unknown" }, ...passingCriteria.slice(1)],
    corrections: [],
  }), /기준/);
  assert.throws(() => parseAiEditVerdict({
    verdict: "fail",
    summary: "실패 기준 없음",
    criteria: passingCriteria,
    corrections: [],
  }), /실패 기준/);
});

test("AI 편집 동작은 픽셀 변경 여부를 도구별로 분기한다", () => {
  assert.equal(hasPixelActions([]), false);
  assert.equal(hasPixelActions([{ tool: "eyedropper", points: [{ x: 0, y: 0 }] }]), false);
  assert.equal(hasPixelActions([{ tool: "select", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }]), false);
  assert.equal(hasPixelActions([{ tool: "fill", points: [{ x: 0, y: 0 }] }]), true);
});

test("AI 편집 계약은 현재 편집기의 14개 도구와 빈 동작 결과를 허용한다", () => {
  assert.deepEqual(EDITOR_TOOLS, [
    "pencil", "eraser", "line", "curve", "rectangle", "ellipse", "polygon",
    "fill", "gradient", "spray", "eyedropper", "select", "lasso", "wand",
  ]);
  assert.deepEqual(parseAiEditResult({ summary: "대상을 찾지 못했습니다.", actions: [] }, 16, 16), {
    summary: "대상을 찾지 못했습니다.",
    actions: [],
  });
  assert.equal((AI_EDIT_OUTPUT_SCHEMA as { additionalProperties?: boolean }).additionalProperties, false);
});

test("AI 편집 출력 스키마는 모든 동작 속성을 required로 선언한다", () => {
  const actionSchema = AI_EDIT_OUTPUT_SCHEMA.properties.actions.items;
  assert.deepEqual([...actionSchema.required].sort(), Object.keys(actionSchema.properties).sort());
});

test("AI 편집 결과는 모든 도구의 좌표 수와 선택 설정을 검증한다", () => {
  for (const tool of EDITOR_TOOLS) {
    const result = parseAiEditResult({
      summary: tool,
      actions: [{
        tool,
        points: validPoints[tool],
        color: [1, 2, 3, 4],
        secondaryColor: [5, 6, 7, 8],
        brushSize: 32,
        brushShape: "circle",
        filled: true,
        mirrorX: false,
        mirrorY: true,
      }],
    }, 4, 4);
    assert.equal(result.actions[0].tool, tool);
  }

  assert.throws(() => parseAiEditResult(null, 4, 4), /결과 객체/);
  assert.throws(() => parseAiEditResult({ summary: "" }, 4, 4), /actions/);
  assert.throws(() => parseAiEditResult({ actions: [] }, 4, 4), /summary/);
  assert.throws(() => parseAiEditResult({ summary: "", actions: [], extra: true }, 4, 4), /허용되지 않는 필드/);
  assert.throws(() => parseAiEditResult({ summary: "", actions: [null] }, 4, 4), /동작 객체/);
  assert.throws(() => parseAiEditResult({ summary: "", actions: [{ tool: "fill", points: [{ x: 0, y: 0 }], extra: true }] }, 4, 4), /허용되지 않는 필드/);
  assert.throws(() => parseAiEditResult({ summary: "", actions: [{ tool: "fill", points: [0] }] }, 4, 4), /좌표 객체/);
  assert.throws(() => parseAiEditResult({ summary: "", actions: [{ tool: "fill", points: [{ x: 0, y: 0, z: 0 }] }] }, 4, 4), /허용되지 않는 필드/);
  assert.throws(() => parseAiEditResult({ summary: "", actions: [{ tool: "clone", points: [{ x: 0, y: 0 }] }] }, 4, 4), /지원하지 않는 도구/);
  assert.throws(() => parseAiEditResult({ summary: "", actions: [{ tool: "line", points: [{ x: 0, y: 0 }] }] }, 4, 4), /좌표 수/);
  assert.throws(() => parseAiEditResult({ summary: "", actions: [{ tool: "lasso", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 0 }] }] }, 4, 4), /올가미/);
  assert.throws(() => parseAiEditResult({ summary: "", actions: [{ tool: "fill", points: [{ x: 0.5, y: 0 }] }] }, 4, 4), /정수/);
  assert.throws(() => parseAiEditResult({ summary: "", actions: [{ tool: "fill", points: [{ x: 4, y: 0 }] }] }, 4, 4), /문서 범위/);
  assert.throws(() => parseAiEditResult({ summary: "", actions: [{ tool: "fill", points: [{ x: 0, y: 0 }], brushSize: 0 }] }, 4, 4), /브러시 크기/);
  assert.throws(() => parseAiEditResult({ summary: "", actions: [{ tool: "fill", points: [{ x: 0, y: 0 }], brushSize: 33 }] }, 4, 4), /브러시 크기/);
  assert.throws(() => parseAiEditResult({ summary: "", actions: [{ tool: "fill", points: [{ x: 0, y: 0 }], color: [0, 0, 0, 256] }] }, 4, 4), /RGBA/);
  assert.throws(() => parseAiEditResult({ summary: "", actions: [{ tool: "fill", points: [{ x: 0, y: 0 }], brushShape: "triangle" }] }, 4, 4), /브러시 모양/);
  assert.throws(() => parseAiEditResult({ summary: "", actions: [{ tool: "fill", points: [{ x: 0, y: 0 }], filled: "true" }] }, 4, 4), /불리언/);
});

test("AI 편집 결과는 동작과 전체 좌표 상한을 적용하고 입력을 변경하지 않는다", () => {
  const point = { x: 0, y: 0 };
  const action = { tool: "pencil", points: [point] };
  assert.throws(() => parseAiEditResult({ summary: "", actions: Array.from({ length: 129 }, () => action) }, 4, 4), /128/);

  const tooManyPoints = Array.from({ length: 129 }, (_, index) => ({ x: index % 4, y: Math.floor(index / 4) % 4 }));
  assert.throws(() => parseAiEditResult({ summary: "", actions: [
    { tool: "pencil", points: tooManyPoints },
    { tool: "pencil", points: tooManyPoints },
  ] }, 4, 4), /전체 좌표/);

  const input = { summary: "유지", actions: [{ tool: "fill", points: [{ x: 0, y: 0 }] }] };
  const before = structuredClone(input);
  parseAiEditResult(input, 4, 4);
  assert.deepEqual(input, before);
});

function editFixture() {
  const document = createDocument({ width: 4, height: 3 });
  const frame = document.frames[0];
  const layer = document.layers[0];
  layer.name = "잉크";
  const cel = document.cels[celKey(frame.id, layer.id)];
  cel.x = 1;
  cel.y = 2;
  document.images[cel.imageId] = {
    width: 2,
    height: 1,
    data: new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]),
  };
  const project = createProject("기사", document);
  const request: AiEditRequest = {
    prompt: "  배경을 정리해 줘  ",
    target: { frameId: frame.id, layerId: layer.id, celId: cel.id },
    settings: {
      tool: "pencil",
      color: [1, 2, 3, 255],
      secondaryColor: [4, 5, 6, 255],
      brushSize: 2,
      brushShape: "circle",
      customBrush: [{ x: -1, y: 0 }, { x: 0, y: 0 }],
      filled: true,
      mirrorX: false,
      mirrorY: true,
      selection: [{ y: 2, startX: 1, endX: 2 }],
    },
  };
  return { project, request, frame, layer, cel };
}

test("활성 셀 참조는 셀 픽셀을 문서 좌표에 정렬한다", () => {
  const { project, request } = editFixture();
  const aligned = activeCelFrame(project.document, request.target);
  assert.equal(aligned.width, 4);
  assert.equal(aligned.height, 3);
  assert.deepEqual(Array.from(aligned.data.slice((2 * 4 + 1) * 4, (2 * 4 + 3) * 4)), [255, 0, 0, 255, 0, 255, 0, 255]);
  assert.equal(aligned.data.reduce((sum, value) => sum + value, 0), 1020);
});

test("저장 프로젝트의 AI 편집 요청은 대상과 모든 편집 설정을 검증한다", () => {
  const { project, request } = editFixture();
  assert.deepEqual(validateAiEditRequest(project, request), { ...request, prompt: "배경을 정리해 줘" });
  assert.doesNotThrow(() => validateAiEditRequest(project, { ...request, settings: { ...request.settings, customBrush: [{ x: -1, y: 0 }] } }));

  assert.throws(() => validateAiEditRequest(project, { ...request, prompt: " " }), /프롬프트/);
  assert.throws(() => validateAiEditRequest(project, { ...request, target: { ...request.target, frameId: "missing" } }), /프레임/);
  assert.throws(() => validateAiEditRequest(project, { ...request, target: { ...request.target, layerId: "missing" } }), /레이어/);
  assert.throws(() => validateAiEditRequest(project, { ...request, target: { ...request.target, celId: "missing" } }), /셀/);
  project.document.layers[0].locked = true;
  assert.throws(() => validateAiEditRequest(project, request), /잠긴 레이어/);
  project.document.layers[0].locked = false;

  assert.throws(() => validateAiEditRequest(project, { ...request, settings: { ...request.settings, tool: "clone" } }), /도구/);
  assert.throws(() => validateAiEditRequest(project, { ...request, settings: { ...request.settings, color: [0, 0, 0, 256] } }), /RGBA/);
  assert.throws(() => validateAiEditRequest(project, { ...request, settings: { ...request.settings, brushSize: 0 } }), /브러시 크기/);
  assert.throws(() => validateAiEditRequest(project, { ...request, settings: { ...request.settings, brushShape: "triangle" } }), /브러시 모양/);
  assert.throws(() => validateAiEditRequest(project, { ...request, settings: { ...request.settings, mirrorX: "false" } }), /불리언/);
  assert.throws(() => validateAiEditRequest(project, { ...request, settings: { ...request.settings, customBrush: [{ x: -2, y: 0 }] } }), /사용자 브러시/);
  assert.throws(() => validateAiEditRequest(project, { ...request, settings: { ...request.settings, customBrush: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: -1, y: 0 }] } }), /사용자 브러시/);
  assert.throws(() => validateAiEditRequest(project, { ...request, settings: { ...request.settings, selection: [{ y: 3, startX: 0, endX: 0 }] } }), /선택/);
  assert.throws(() => validateAiEditRequest(project, { ...request, settings: { ...request.settings, selection: Array.from({ length: 13 }, () => ({ y: 0, startX: 0, endX: 0 })) } }), /선택/);
});

test("AI 편집 프롬프트는 대상·설정·도구 계약과 금지 동작을 명시한다", () => {
  const { project, request, frame, layer, cel } = editFixture();
  const prompt = buildAiEditPrompt(project, request);
  assert.match(prompt, /배경을 정리해 줘/);
  assert.match(prompt, /4 × 3/);
  assert.match(prompt, new RegExp(`F1.*${frame.id}`));
  assert.match(prompt, new RegExp(`잉크.*${layer.id}`));
  assert.match(prompt, new RegExp(cel.id));
  assert.match(prompt, /pencil/);
  assert.match(prompt, /\[1,2,3,255\]/);
  assert.match(prompt, /\[4,5,6,255\]/);
  assert.match(prompt, /circle/);
  assert.match(prompt, /selection.*startX/s);
  for (const tool of EDITOR_TOOLS) assert.match(prompt, new RegExp(tool));
  assert.match(prompt, /pencil.*eraser.*spray.*1개 이상/);
  assert.match(prompt, /line.*curve.*rectangle.*ellipse.*polygon.*gradient.*select.*정확히 2개/);
  assert.match(prompt, /fill.*eyedropper.*wand.*정확히 1개/);
  assert.match(prompt, /lasso.*서로 다른 좌표 3개 이상.*반복하지/);
  assert.match(prompt, /좌상단 \(0, 0\)/);
  assert.match(prompt, /불확실.*빈 actions/s);
  assert.match(prompt, /첫 번째 이미지.*합성/s);
  assert.match(prompt, /두 번째 이미지.*활성 셀/s);
  assert.match(prompt, /파일 쓰기.*명령 실행.*이미지 생성/s);
});

test("AI 편집 프롬프트는 특정 의상 교체 전략을 강제하지 않는다", () => {
  const { project, request } = editFixture();
  const prompt = buildAiEditPrompt(project, request);

  assert.doesNotMatch(prompt, /골반 회전|새 의상|정면 의상|주름과 명암/);
});
