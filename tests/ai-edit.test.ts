import assert from "node:assert/strict";
import test from "node:test";
import { AI_EDIT_OUTPUT_SCHEMA, EDITOR_TOOLS, parseAiEditResult } from "../src/core/ai-edit.ts";

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
