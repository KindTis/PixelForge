import type { RGBA } from "./types.ts";

export const EDITOR_TOOLS = [
  "pencil", "eraser", "line", "curve", "rectangle", "ellipse", "polygon",
  "fill", "gradient", "spray", "eyedropper", "select", "lasso", "wand",
] as const;

export type EditorTool = typeof EDITOR_TOOLS[number];
export type AiEditTarget = { frameId: string; layerId: string; celId: string };
export type AiSelectionRun = { y: number; startX: number; endX: number };
export type AiEditSettings = {
  tool: EditorTool;
  color: RGBA;
  secondaryColor: RGBA;
  brushSize: number;
  brushShape: "square" | "circle";
  customBrush?: Array<{ x: number; y: number }>;
  filled: boolean;
  mirrorX: boolean;
  mirrorY: boolean;
  selection?: AiSelectionRun[];
};
export type AiEditRequest = { prompt: string; target: AiEditTarget; settings: AiEditSettings };
export type AiToolAction = {
  tool: EditorTool;
  points: Array<{ x: number; y: number }>;
  color?: RGBA;
  secondaryColor?: RGBA;
  brushSize?: number;
  brushShape?: "square" | "circle";
  filled?: boolean;
  mirrorX?: boolean;
  mirrorY?: boolean;
};
export type AiEditResult = { summary: string; actions: AiToolAction[] };
export type AiEditAttempt = { seed: number; result: AiEditResult };
export const AI_EDIT_CRITERIA = [
  "request_fulfillment",
  "pose_and_geometry",
  "replacement_integrity",
  "preservation",
  "pixel_art_consistency",
] as const;
export type AiEditCriterionId = typeof AI_EDIT_CRITERIA[number];
export type AiEditVerdict = {
  verdict: "pass" | "fail";
  summary: string;
  criteria: Array<{ id: AiEditCriterionId; passed: boolean; reason: string }>;
  corrections: Array<{ criterion: AiEditCriterionId; region: string; problem: string; requiredChange: string }>;
};
export type AiEditReadyResult = {
  summary: string;
  attempts: AiEditAttempt[];
  actionCount: number;
  direct: boolean;
  acceptedAttempt?: number;
};

const pointSchema = {
  type: "object",
  additionalProperties: false,
  required: ["x", "y"],
  properties: {
    x: { type: "integer", minimum: 0 },
    y: { type: "integer", minimum: 0 },
  },
} as const;

const colorSchema = {
  type: "array",
  minItems: 4,
  maxItems: 4,
  items: { type: "integer", minimum: 0, maximum: 255 },
} as const;

export const AI_EDIT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "actions"],
  properties: {
    summary: { type: "string" },
    actions: {
      type: "array",
      maxItems: 128,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["tool", "points", "color", "secondaryColor", "brushSize", "brushShape", "filled", "mirrorX", "mirrorY"],
        properties: {
          tool: { type: "string", enum: EDITOR_TOOLS },
          points: { type: "array", minItems: 1, maxItems: 16384, items: pointSchema },
          color: colorSchema,
          secondaryColor: colorSchema,
          brushSize: { type: "integer", minimum: 1, maximum: 32 },
          brushShape: { type: "string", enum: ["square", "circle"] },
          filled: { type: "boolean" },
          mirrorX: { type: "boolean" },
          mirrorY: { type: "boolean" },
        },
      },
    },
  },
} as const;

export const AI_EDIT_VERDICT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "criteria", "corrections"],
  properties: {
    verdict: { type: "string", enum: ["pass", "fail"] },
    summary: { type: "string" },
    criteria: {
      type: "array",
      minItems: AI_EDIT_CRITERIA.length,
      maxItems: AI_EDIT_CRITERIA.length,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "passed", "reason"],
        properties: {
          id: { type: "string", enum: AI_EDIT_CRITERIA },
          passed: { type: "boolean" },
          reason: { type: "string", minLength: 1 },
        },
      },
    },
    corrections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["criterion", "region", "problem", "requiredChange"],
        properties: {
          criterion: { type: "string", enum: AI_EDIT_CRITERIA },
          region: { type: "string" },
          problem: { type: "string" },
          requiredChange: { type: "string" },
        },
      },
    },
  },
} as const;

const resultFields = new Set(["summary", "actions"]);
const actionFields = new Set(["tool", "points", "color", "secondaryColor", "brushSize", "brushShape", "filled", "mirrorX", "mirrorY"]);
const pointFields = new Set(["x", "y"]);
const exactTwoTools = new Set<EditorTool>(["line", "curve", "rectangle", "ellipse", "polygon", "gradient", "select"]);
const exactOneTools = new Set<EditorTool>(["fill", "eyedropper", "wand"]);
const verdictFields = new Set(["verdict", "summary", "criteria", "corrections"]);
const criterionFields = new Set(["id", "passed", "reason"]);
const correctionFields = new Set(["criterion", "region", "problem", "requiredChange"]);
const NON_PIXEL_TOOLS = new Set<EditorTool>(["eyedropper", "select", "lasso", "wand"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectExtraFields(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error(`${label}에 허용되지 않는 필드가 있습니다.`);
}

function parseColor(value: unknown, label: string): RGBA {
  if (!Array.isArray(value) || value.length !== 4 || value.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)) {
    throw new Error(`${label}는 0~255 정수 네 개의 RGBA여야 합니다.`);
  }
  return value as unknown as RGBA;
}

function parseOptionalBoolean(action: Record<string, unknown>, key: "filled" | "mirrorX" | "mirrorY"): boolean | undefined {
  if (!(key in action)) return undefined;
  if (typeof action[key] !== "boolean") throw new Error(`${key}는 불리언이어야 합니다.`);
  return action[key];
}

export function parseAiEditResult(value: unknown, width: number, height: number): AiEditResult {
  if (!isObject(value)) throw new Error("AI 편집 결과 객체가 필요합니다.");
  rejectExtraFields(value, resultFields, "AI 편집 결과");
  if (typeof value.summary !== "string") throw new Error("AI 편집 결과의 summary가 필요합니다.");
  if (!Array.isArray(value.actions)) throw new Error("AI 편집 결과의 actions 배열이 필요합니다.");
  if (value.actions.length > 128) throw new Error("AI 편집 동작은 최대 128개까지 허용됩니다.");

  const coordinateLimit = Math.max(256, Math.min(width * height * 4, 16384));
  let coordinateCount = 0;
  const actions = value.actions.map((rawAction): AiToolAction => {
    if (!isObject(rawAction)) throw new Error("AI 편집 동작 객체가 필요합니다.");
    rejectExtraFields(rawAction, actionFields, "AI 편집 동작");
    if (typeof rawAction.tool !== "string" || !EDITOR_TOOLS.includes(rawAction.tool as EditorTool)) throw new Error("지원하지 않는 도구입니다.");
    if (!Array.isArray(rawAction.points)) throw new Error("도구 좌표 배열이 필요합니다.");

    const tool = rawAction.tool as EditorTool;
    const points = rawAction.points.map((rawPoint) => {
      if (!isObject(rawPoint)) throw new Error("좌표 객체가 필요합니다.");
      rejectExtraFields(rawPoint, pointFields, "좌표");
      if (!Number.isInteger(rawPoint.x) || !Number.isInteger(rawPoint.y)) throw new Error("좌표는 정수여야 합니다.");
      const x = rawPoint.x as number;
      const y = rawPoint.y as number;
      if (x < 0 || y < 0 || x >= width || y >= height) throw new Error("좌표가 문서 범위를 벗어났습니다.");
      return { x, y };
    });
    coordinateCount += points.length;

    if ((exactTwoTools.has(tool) && points.length !== 2)
      || (exactOneTools.has(tool) && points.length !== 1)
      || ((tool === "pencil" || tool === "eraser" || tool === "spray") && points.length < 1)) {
      throw new Error(`${tool} 도구의 좌표 수가 올바르지 않습니다.`);
    }
    if (tool === "lasso") {
      const unique = new Set(points.map(({ x, y }) => `${x},${y}`));
      if (unique.size < 3 || (points[0]?.x === points.at(-1)?.x && points[0]?.y === points.at(-1)?.y)) {
        throw new Error("올가미는 서로 다른 좌표 세 개 이상이어야 하며 첫 점과 마지막 점이 달라야 합니다.");
      }
    }

    const action: AiToolAction = { tool, points };
    if ("color" in rawAction) action.color = parseColor(rawAction.color, "color");
    if ("secondaryColor" in rawAction) action.secondaryColor = parseColor(rawAction.secondaryColor, "secondaryColor");
    if ("brushSize" in rawAction) {
      if (!Number.isInteger(rawAction.brushSize) || (rawAction.brushSize as number) < 1 || (rawAction.brushSize as number) > 32) throw new Error("브러시 크기는 1~32 정수여야 합니다.");
      action.brushSize = rawAction.brushSize as number;
    }
    if ("brushShape" in rawAction) {
      if (rawAction.brushShape !== "square" && rawAction.brushShape !== "circle") throw new Error("브러시 모양은 square 또는 circle이어야 합니다.");
      action.brushShape = rawAction.brushShape;
    }
    for (const key of ["filled", "mirrorX", "mirrorY"] as const) {
      const parsed = parseOptionalBoolean(rawAction, key);
      if (parsed !== undefined) action[key] = parsed;
    }
    return action;
  });

  if (coordinateCount > coordinateLimit) throw new Error(`전체 좌표 수는 ${coordinateLimit}개 이하여야 합니다.`);
  return { summary: value.summary, actions };
}

export function parseAiEditVerdict(value: unknown): AiEditVerdict {
  if (!isObject(value)) throw new Error("AI 편집 판정 객체가 필요합니다.");
  rejectExtraFields(value, verdictFields, "AI 편집 판정");
  if (value.verdict !== "pass" && value.verdict !== "fail") throw new Error("AI 편집 판정의 verdict가 필요합니다.");
  if (typeof value.summary !== "string") throw new Error("AI 편집 판정의 summary가 필요합니다.");
  if (!Array.isArray(value.criteria) || value.criteria.length !== AI_EDIT_CRITERIA.length) {
    throw new Error("판정 criteria에는 다섯 기준이 각각 한 번씩 필요합니다.");
  }
  if (!Array.isArray(value.corrections)) throw new Error("AI 편집 판정의 corrections 배열이 필요합니다.");

  const criteria = value.criteria.map((rawCriterion): AiEditVerdict["criteria"][number] => {
    if (!isObject(rawCriterion)) throw new Error("판정 기준 객체가 필요합니다.");
    rejectExtraFields(rawCriterion, criterionFields, "판정 기준");
    if (typeof rawCriterion.id !== "string" || !AI_EDIT_CRITERIA.includes(rawCriterion.id as AiEditCriterionId)) {
      throw new Error("알 수 없는 판정 기준입니다.");
    }
    if (typeof rawCriterion.passed !== "boolean") throw new Error("판정 기준의 passed가 필요합니다.");
    if (typeof rawCriterion.reason !== "string" || !rawCriterion.reason.trim()) throw new Error("판정 기준의 reason이 필요합니다.");
    return { id: rawCriterion.id as AiEditCriterionId, passed: rawCriterion.passed, reason: rawCriterion.reason };
  });
  const ids = criteria.map(({ id }) => id);
  if (new Set(ids).size !== AI_EDIT_CRITERIA.length || AI_EDIT_CRITERIA.some((id) => !ids.includes(id))) {
    throw new Error("판정 criteria에는 다섯 기준이 각각 한 번씩 필요합니다.");
  }

  const corrections = value.corrections.map((rawCorrection): AiEditVerdict["corrections"][number] => {
    if (!isObject(rawCorrection)) throw new Error("수정 지시 객체가 필요합니다.");
    rejectExtraFields(rawCorrection, correctionFields, "수정 지시");
    if (typeof rawCorrection.criterion !== "string" || !AI_EDIT_CRITERIA.includes(rawCorrection.criterion as AiEditCriterionId)) {
      throw new Error("알 수 없는 수정 기준입니다.");
    }
    for (const key of ["region", "problem", "requiredChange"] as const) {
      if (typeof rawCorrection[key] !== "string") throw new Error(`수정 지시의 ${key}가 필요합니다.`);
    }
    return {
      criterion: rawCorrection.criterion as AiEditCriterionId,
      region: rawCorrection.region as string,
      problem: rawCorrection.problem as string,
      requiredChange: rawCorrection.requiredChange as string,
    };
  });

  const failed = new Set(criteria.filter(({ passed }) => !passed).map(({ id }) => id));
  if (value.verdict === "pass") {
    if (failed.size > 0 || corrections.length > 0) {
      throw new Error("pass 판정은 모든 기준을 통과하고 수정 지시가 없어야 합니다.");
    }
  } else {
    if (failed.size === 0) throw new Error("fail 판정에는 실패 기준이 필요합니다.");
    for (const correction of corrections) {
      if (!failed.has(correction.criterion)) throw new Error("수정 지시는 통과한 기준을 참조할 수 없습니다.");
    }
    for (const id of failed) {
      if (!corrections.some(({ criterion }) => criterion === id)) {
        throw new Error(`실패 기준 ${id}의 수정 지시가 필요합니다.`);
      }
    }
  }
  return { verdict: value.verdict, summary: value.summary, criteria, corrections };
}

export function hasPixelActions(actions: readonly AiToolAction[]): boolean {
  return actions.some(({ tool }) => !NON_PIXEL_TOOLS.has(tool));
}
