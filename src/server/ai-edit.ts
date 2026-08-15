import { AI_EDIT_CRITERIA, EDITOR_TOOLS, type AiEditRequest, type AiEditSettings, type AiEditTarget, type AiEditVerdict, type EditorTool } from "../core/ai-edit.ts";
import { celKey, type Cel, type PixelBuffer, type RGBA, type SpriteDocument, type SpriteProject } from "../core/types.ts";

const requestFields = new Set(["prompt", "target", "settings"]);
const targetFields = new Set(["frameId", "layerId", "celId"]);
const settingsFields = new Set(["tool", "color", "secondaryColor", "brushSize", "brushShape", "customBrush", "filled", "mirrorX", "mirrorY", "selection"]);
const pointFields = new Set(["x", "y"]);
const selectionFields = new Set(["y", "startX", "endX"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectExtraFields(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error(`${label}에 허용되지 않는 필드가 있습니다.`);
}

function parseColor(value: unknown): RGBA {
  if (!Array.isArray(value) || value.length !== 4 || value.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)) {
    throw new Error("색상은 0~255 정수 네 개의 RGBA여야 합니다.");
  }
  return value as unknown as RGBA;
}

function resolveTarget(document: SpriteDocument, target: AiEditTarget, rejectLocked = false): { cel: Cel; image: PixelBuffer } {
  if (!document.frames.some(({ id }) => id === target.frameId)) throw new Error("선택한 프레임을 찾을 수 없습니다.");
  const layer = document.layers.find(({ id }) => id === target.layerId);
  if (!layer) throw new Error("활성 레이어를 찾을 수 없습니다.");
  if (rejectLocked && layer.locked) throw new Error("잠긴 레이어는 편집할 수 없습니다.");
  const cel = document.cels[celKey(target.frameId, target.layerId)];
  if (!cel || cel.id !== target.celId) throw new Error("활성 셀을 찾을 수 없거나 대상 셀이 변경되었습니다.");
  const image = document.images[cel.imageId];
  if (!image) throw new Error("활성 셀 이미지가 없습니다.");
  return { cel, image };
}

export function activeCelFrame(document: SpriteDocument, target: AiEditTarget): PixelBuffer {
  const { cel, image } = resolveTarget(document, target);
  const data = new Uint8ClampedArray(document.width * document.height * 4);
  for (let y = 0; y < image.height; y += 1) {
    const targetY = cel.y + y;
    if (targetY < 0 || targetY >= document.height) continue;
    for (let x = 0; x < image.width; x += 1) {
      const targetX = cel.x + x;
      if (targetX < 0 || targetX >= document.width) continue;
      const source = (y * image.width + x) * 4;
      data.set(image.data.subarray(source, source + 4), (targetY * document.width + targetX) * 4);
    }
  }
  return { width: document.width, height: document.height, data };
}

export function validateAiEditRequest(project: SpriteProject, value: unknown): AiEditRequest {
  if (!isObject(value)) throw new Error("AI 편집 요청 객체가 필요합니다.");
  rejectExtraFields(value, requestFields, "AI 편집 요청");
  if (typeof value.prompt !== "string" || !value.prompt.trim()) throw new Error("AI 편집 프롬프트가 필요합니다.");
  if (!isObject(value.target)) throw new Error("AI 편집 대상이 필요합니다.");
  rejectExtraFields(value.target, targetFields, "AI 편집 대상");
  for (const key of targetFields) if (typeof value.target[key] !== "string" || !value.target[key]) throw new Error(`AI 편집 대상 ${key}가 필요합니다.`);
  const target = value.target as AiEditTarget;
  const { image } = resolveTarget(project.document, target, true);

  if (!isObject(value.settings)) throw new Error("AI 편집 설정이 필요합니다.");
  rejectExtraFields(value.settings, settingsFields, "AI 편집 설정");
  const raw = value.settings;
  if (typeof raw.tool !== "string" || !EDITOR_TOOLS.includes(raw.tool as EditorTool)) throw new Error("지원하지 않는 도구입니다.");
  if (!Number.isInteger(raw.brushSize) || (raw.brushSize as number) < 1 || (raw.brushSize as number) > 32) throw new Error("브러시 크기는 1~32 정수여야 합니다.");
  if (raw.brushShape !== "square" && raw.brushShape !== "circle") throw new Error("브러시 모양은 square 또는 circle이어야 합니다.");
  for (const key of ["filled", "mirrorX", "mirrorY"] as const) if (typeof raw[key] !== "boolean") throw new Error(`${key}는 불리언이어야 합니다.`);

  let customBrush: AiEditSettings["customBrush"];
  if ("customBrush" in raw) {
    if (!Array.isArray(raw.customBrush) || raw.customBrush.length > image.width * image.height) throw new Error("사용자 브러시 좌표 수가 올바르지 않습니다.");
    customBrush = raw.customBrush.map((value) => {
      if (!isObject(value)) throw new Error("사용자 브러시 좌표가 올바르지 않습니다.");
      rejectExtraFields(value, pointFields, "사용자 브러시 좌표");
      if (!Number.isInteger(value.x) || !Number.isInteger(value.y)
        || (value.x as number) <= -image.width || (value.x as number) >= image.width
        || (value.y as number) <= -image.height || (value.y as number) >= image.height) {
        throw new Error("사용자 브러시 좌표가 이미지 범위를 벗어났습니다.");
      }
      return { x: value.x as number, y: value.y as number };
    });
  }

  let selection: AiEditSettings["selection"];
  if ("selection" in raw) {
    if (!Array.isArray(raw.selection) || raw.selection.length > project.document.width * project.document.height) throw new Error("선택 범위 수가 올바르지 않습니다.");
    selection = raw.selection.map((value) => {
      if (!isObject(value)) throw new Error("선택 범위가 올바르지 않습니다.");
      rejectExtraFields(value, selectionFields, "선택 범위");
      if (!Number.isInteger(value.y) || !Number.isInteger(value.startX) || !Number.isInteger(value.endX)
        || (value.y as number) < 0 || (value.y as number) >= project.document.height
        || (value.startX as number) < 0 || (value.startX as number) > (value.endX as number)
        || (value.endX as number) >= project.document.width) throw new Error("선택 범위가 문서 범위를 벗어났습니다.");
      return { y: value.y as number, startX: value.startX as number, endX: value.endX as number };
    });
  }

  const settings: AiEditSettings = {
    tool: raw.tool as EditorTool,
    color: parseColor(raw.color),
    secondaryColor: parseColor(raw.secondaryColor),
    brushSize: raw.brushSize as number,
    brushShape: raw.brushShape,
    filled: raw.filled as boolean,
    mirrorX: raw.mirrorX as boolean,
    mirrorY: raw.mirrorY as boolean,
  };
  if (customBrush !== undefined) settings.customBrush = customBrush;
  if (selection !== undefined) settings.selection = selection;
  return { prompt: value.prompt.trim(), target: { ...target }, settings };
}

export function buildAiEditPrompt(project: SpriteProject, value: AiEditRequest, context: { attempt: number; previousVerdict?: AiEditVerdict }): string {
  const request = validateAiEditRequest(project, value);
  const frameIndex = project.document.frames.findIndex(({ id }) => id === request.target.frameId);
  const layer = project.document.layers.find(({ id }) => id === request.target.layerId)!;
  return [
    `사용자 지시: ${request.prompt}`,
    `문서 크기: ${project.document.width} × ${project.document.height} 픽셀`,
    `대상 프레임: F${frameIndex + 1} (${request.target.frameId})`,
    `활성 레이어: ${layer.name} (${layer.id})`,
    `활성 셀 ID: ${request.target.celId}`,
    `편집 시도: ${context.attempt}/6`,
    `현재 편집기 settings: ${JSON.stringify(request.settings)}`,
    `사용 가능한 도구: ${EDITOR_TOOLS.join(", ")}`,
    "points 좌표 수: pencil, eraser, spray는 1개 이상; line, curve, rectangle, ellipse, polygon, gradient, select는 정확히 2개; fill, eyedropper, wand는 정확히 1개; lasso는 서로 다른 좌표 3개 이상이며 첫 좌표를 끝에 반복하지 마세요.",
    "모든 좌표는 문서 좌상단 (0, 0)을 기준으로 한 정수 좌표입니다.",
    "첫 번째와 두 번째 이미지는 변경 전 원본의 합성 결과와 문서 좌표에 정렬한 활성 셀입니다.",
    "세 번째와 네 번째 이미지는 현재 후보의 합성 결과와 문서 좌표에 정렬한 활성 셀입니다.",
    "원본을 기준으로 요청 범위 밖 픽셀을 유지하면서 기존 도구의 제스처로 직전 후보의 현재 셀 하나만 수정할 actions를 작성하세요.",
    ...(context.previousVerdict ? ["직전 판정 피드백:", JSON.stringify(context.previousVerdict)] : []),
    "대상이 불확실하면 이유를 summary에 쓰고 빈 actions를 반환하세요.",
    "파일 쓰기, 명령 실행, 이미지 생성, 도구 또는 스킬 호출을 하지 마세요.",
    "출력 스키마에 맞는 JSON 최종 응답만 작성하세요.",
  ].join("\n");
}

export function buildAiEditVerdictPrompt(request: AiEditRequest): string {
  return [
    `사용자 지시: ${request.prompt.trim()}`,
    "첫 번째와 두 번째 이미지는 원본의 합성 결과와 활성 셀입니다.",
    "세 번째와 네 번째 이미지는 후보의 합성 결과와 활성 셀입니다.",
    "원본과 후보만 비교하여 다음 다섯 기준을 각각 판정하세요:",
    `${AI_EDIT_CRITERIA[0]}: 사용자 지시를 빠짐없이 충족했는지 판정합니다.`,
    `${AI_EDIT_CRITERIA[1]}: 요청한 자세 변경의 방향·관절·실루엣이 정확한지 판정합니다.`,
    `${AI_EDIT_CRITERIA[2]}: 교체 요청은 기존 대상의 잔재 없이 교체되었는지 판정합니다. 요청이 투명화이거나 교체가 아닌 경우에는 그 사실을 reason에 명시하고 통과 처리합니다.`,
    `${AI_EDIT_CRITERIA[3]}: 요청 범위 밖의 형태·색상·투명도·픽셀이 원본대로 보존되었는지 판정합니다.`,
    `${AI_EDIT_CRITERIA[4]}: 후보가 원본의 픽셀 아트 해상도·팔레트·가장자리 표현과 일치하는지 판정합니다.`,
    "pass는 다섯 기준이 모두 passed=true이고 corrections가 비어 있을 때만 가능합니다.",
    "fail은 하나 이상의 기준이 passed=false이고 각 실패 기준에 구체적인 corrections가 있을 때만 가능합니다.",
    "요청한 자세 변경은 정확성과 범위를 함께 확인하고, 범위 밖 요소는 원본과 같아야 합니다.",
    "출력 스키마에 맞는 판정 JSON 최종 응답만 작성하세요.",
  ].join("\n");
}
