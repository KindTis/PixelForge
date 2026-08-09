import type { PixelBuffer, SpriteProject } from "../core/types.ts";

export type WireProject = Omit<SpriteProject, "document"> & {
  document: Omit<SpriteProject["document"], "images"> & {
    images: Record<string, Omit<PixelBuffer, "data"> & { data: number[] }>;
  };
};

export type AccountResponse = {
  account?: { type: string; email?: string | null; planType?: string | null } | null;
  requiresOpenaiAuth?: boolean;
  error?: string;
};

export type Session = { token: string; account: AccountResponse };

export type GenerationJob = {
  id: string;
  frameId?: string;
  status: "running" | "awaitingApproval" | "cancelling" | "finalizing" | "completed" | "failed" | "cancelled";
  messages: string[];
  error?: string;
  approval?: { requestId: number; method: string };
  project?: SpriteProject;
};

export function decodeProject(value: SpriteProject | WireProject): SpriteProject {
  const images = Object.fromEntries(Object.entries(value.document.images).map(([id, image]) => [id, {
    ...image,
    data: new Uint8ClampedArray(image.data as unknown as number[]),
  }]));
  return { ...value, document: { ...value.document, images } };
}

export function encodeProject(value: SpriteProject): WireProject {
  const images = Object.fromEntries(Object.entries(value.document.images).map(([id, image]) => [id, {
    ...image,
    data: Array.from(image.data),
  }]));
  return { ...value, document: { ...value.document, images } };
}

export function generationPayload(project: SpriteProject, prompt: string, frameCount: number, columns: number, referencePath?: string, frameId?: string) {
  return {
    projectId: project.id,
    ...(frameId === undefined ? {} : { frameId }),
    request: {
      prompt,
      frameCount,
      columns,
      cellWidth: project.document.width,
      cellHeight: project.document.height,
      durationMs: 100,
      parentId: project.generationHistory.at(-1)?.id,
      referencePath,
    },
  };
}

export async function api<T>(path: string, token?: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(token ? { "x-pixelforge-token": token } : {}),
      ...init?.headers,
    },
  });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error ?? `요청 실패 (${response.status})`);
  return result;
}
