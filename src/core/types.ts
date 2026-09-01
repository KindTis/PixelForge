export type RGBA = readonly [number, number, number, number];

export type BlendMode = "normal" | "multiply" | "screen" | "overlay" | "add";

export type Frame = {
  id: string;
  durationMs: number;
};

export type Layer = {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  blendMode: BlendMode;
};

export type PixelBuffer = {
  width: number;
  height: number;
  data: Uint8ClampedArray;
};

export type Cel = {
  id: string;
  imageId: string;
  x: number;
  y: number;
  opacity: number;
};

export type AnimationDirection = "forward" | "reverse" | "pingPong";

export type AnimationTag = {
  id: string;
  name: string;
  fromFrameId: string;
  toFrameId: string;
  direction: AnimationDirection;
};

export type PaletteEntry = {
  id: string;
  name: string;
  color: RGBA;
};

export type SpriteDocument = {
  width: number;
  height: number;
  colorMode: "rgba" | "indexed";
  frames: Frame[];
  layers: Layer[];
  cels: Record<string, Cel>;
  images: Record<string, PixelBuffer>;
  palette: PaletteEntry[];
  tags: AnimationTag[];
};

export type GenerationRecord = {
  id: string;
  prompt: string;
  createdAt: string;
  outputPath: string;
  parentId?: string;
};

export type ExportSettings = {
  columns: number;
  padding: number;
  margin: number;
  trim: boolean;
  pixelsPerUnit: number;
  pivot: { x: number; y: number };
};

export type SpriteProject = {
  format: "pixelforge-project";
  version: 1;
  id: string;
  name: string;
  document: SpriteDocument;
  generationHistory: GenerationRecord[];
  exportSettings: ExportSettings;
};

export type CreateDocumentOptions = {
  width: number;
  height: number;
};

export function celKey(frameId: string, layerId: string): string {
  return `${frameId}:${layerId}`;
}
