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

export function generationStatusTitle(job: Pick<GenerationJob, "status" | "frameId">): string {
  const titles: Record<GenerationJob["status"], [string, string]> = {
    running: ["Codex가 제작 중입니다", "선택 프레임을 재생성 중입니다"],
    awaitingApproval: ["Codex 승인 필요", "선택 프레임 재생성 승인 필요"],
    cancelling: ["생성을 취소하는 중입니다", "선택 프레임 재생성을 취소하는 중입니다"],
    finalizing: ["결과를 가져오는 중입니다", "선택 프레임 결과를 가져오는 중입니다"],
    completed: ["가져오기 완료", "선택 프레임 가져오기 완료"],
    failed: ["생성 실패", "선택 프레임 재생성 실패"],
    cancelled: ["생성 취소됨", "선택 프레임 재생성 취소됨"],
  };
  return titles[job.status][job.frameId === undefined ? 0 : 1];
}

export function completedFrameIndex(project: SpriteProject | undefined, requestedFrameId?: string, responseFrameId?: string): number {
  if (!project) throw new Error("완료된 생성 결과가 없습니다.");
  if (requestedFrameId === undefined) return 0;
  if (responseFrameId === undefined) throw new Error("선택 프레임 ID가 완료 응답에 없습니다.");
  if (responseFrameId !== requestedFrameId) throw new Error("완료 응답 프레임 ID가 요청과 일치하지 않습니다.");
  const index = project.document.frames.findIndex((frame) => frame.id === requestedFrameId);
  if (index < 0) throw new Error("선택 프레임을 결과 프로젝트에서 찾을 수 없습니다.");
  return index;
}

export function pollingErrorGenerationJob(job: GenerationJob | undefined, id: string, error: string): GenerationJob | undefined {
  if (job?.id !== id || job.status === "completed" || job.status === "failed" || job.status === "cancelled") return job;
  return { ...job, error };
}

export function failedGenerationJob(job: GenerationJob | undefined, id: string, error: string): GenerationJob | undefined {
  return job?.id === id ? { ...job, status: "failed", error } : job;
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
