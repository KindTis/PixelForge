import {
  celKey,
  type CreateDocumentOptions,
  type SpriteDocument,
  type SpriteProject,
} from "./types.ts";
import { validateAnimationTags } from "./animation.ts";

function id(): string {
  return crypto.randomUUID();
}

export function createDocument({ width, height }: CreateDocumentOptions): SpriteDocument {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 4096 || height > 4096) {
    throw new Error("캔버스 크기는 1~4096 사이의 정수여야 합니다.");
  }

  const frameId = id();
  const layerId = id();
  const imageId = id();
  const celId = id();

  return {
    width,
    height,
    colorMode: "rgba",
    frames: [{ id: frameId, durationMs: 100 }],
    layers: [{ id: layerId, name: "레이어 1", visible: true, locked: false, opacity: 1, blendMode: "normal" }],
    cels: {
      [celKey(frameId, layerId)]: { id: celId, imageId, x: 0, y: 0, opacity: 1 },
    },
    images: {
      [imageId]: { width, height, data: new Uint8ClampedArray(width * height * 4) },
    },
    palette: [
      { id: id(), name: "검정", color: [0, 0, 0, 255] },
      { id: id(), name: "흰색", color: [255, 255, 255, 255] },
    ],
    tags: [],
  };
}

export function createProject(name: string, document: SpriteDocument): SpriteProject {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("프로젝트 이름이 필요합니다.");
  validateDocument(document);
  return {
    format: "pixelforge-project",
    version: 1,
    id: id(),
    name: trimmed,
    document,
    generationHistory: [],
    exportSettings: {
      columns: 4,
      padding: 0,
      margin: 0,
      trim: false,
      pixelsPerUnit: 100,
      pivot: { x: 0.5, y: 0.5 },
    },
  };
}

export function renameProject(project: SpriteProject, name: string): SpriteProject {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("프로젝트 이름이 필요합니다.");
  return { ...project, name: trimmed };
}

export function validateDocument(document: SpriteDocument): void {
  if (!Number.isInteger(document.width) || !Number.isInteger(document.height) || document.width < 1 || document.height < 1) {
    throw new Error("잘못된 캔버스 크기입니다.");
  }
  if (document.frames.length === 0) throw new Error("프레임이 하나 이상 필요합니다.");
  if (document.layers.length === 0) throw new Error("레이어가 하나 이상 필요합니다.");
  if (document.palette.length < 1 || document.palette.length > 256 || document.palette.some((entry) => entry.color.length !== 4 || entry.color.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255))) {
    throw new Error("팔레트 색상이 올바르지 않습니다.");
  }

  const frameIds = new Set(document.frames.map((frame) => frame.id));
  const layerIds = new Set(document.layers.map((layer) => layer.id));
  if (frameIds.size !== document.frames.length) throw new Error("프레임 ID가 중복되었습니다.");
  if (layerIds.size !== document.layers.length) throw new Error("레이어 ID가 중복되었습니다.");
  if (document.frames.some((frame) => !Number.isFinite(frame.durationMs) || frame.durationMs < 1)) {
    throw new Error("프레임 시간은 1ms 이상이어야 합니다.");
  }
  if (document.layers.some((layer) => layer.opacity < 0 || layer.opacity > 1)) {
    throw new Error("레이어 불투명도는 0~1이어야 합니다.");
  }

  for (const [key, cel] of Object.entries(document.cels)) {
    const [frameId, layerId] = key.split(":");
    if (!frameIds.has(frameId) || !layerIds.has(layerId)) throw new Error("셀이 존재하지 않는 프레임이나 레이어를 참조합니다.");
    if (!document.images[cel.imageId]) throw new Error("셀 이미지가 없습니다.");
  }

  if (document.colorMode === "indexed") {
    const colors = new Set(document.palette.map((entry) => entry.color.join(",")));
    for (const image of Object.values(document.images)) for (let offset = 0; offset < image.data.length; offset += 4) {
      if (!colors.has(`${image.data[offset]},${image.data[offset + 1]},${image.data[offset + 2]},${image.data[offset + 3]}`)) throw new Error("인덱스 문서에 팔레트 밖 색상이 있습니다.");
    }
  }

  validateAnimationTags(document);
}
