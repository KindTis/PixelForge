import assert from "node:assert/strict";
import test from "node:test";
import { AI_EDIT_OUTPUT_SCHEMA, EDITOR_TOOLS, parseAiEditResult, type AiEditRequest } from "../src/core/ai-edit.ts";
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
  assert.match(prompt, /좌상단 \(0, 0\)/);
  assert.match(prompt, /불확실.*빈 actions/s);
  assert.match(prompt, /첫 번째 이미지.*합성/s);
  assert.match(prompt, /두 번째 이미지.*활성 셀/s);
  assert.match(prompt, /파일 쓰기.*명령 실행.*이미지 생성/s);
});
