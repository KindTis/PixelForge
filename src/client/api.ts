import type { AiEditReadyResult, AiEditRequest, AiEditTarget } from "../core/ai-edit.ts";
import { conflictingUnityAnimationTagNames, frameSequence } from "../core/animation.ts";
import type { AnimationDirection, Layer, PixelBuffer, SpriteProject } from "../core/types.ts";

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

type JobBase = {
  id: string;
  status: "running" | "awaitingApproval" | "cancelling" | "finalizing" | "completed" | "failed" | "cancelled";
  messages: string[];
  error?: string;
};

export type GenerationJob = JobBase & {
  kind: "generation";
  frameId?: string;
  approval?: { requestId: number; method: string };
  project?: SpriteProject;
};

export type CellEditJob = JobBase & {
  kind: "cellEdit";
  target: AiEditTarget;
  phase: "editing" | "judging";
  attempt: number;
  maxAttempts: number;
  lastVerdict?: string;
  logPath?: string;
  result?: AiEditReadyResult;
};

export type CodexJob = GenerationJob | CellEditJob;
export type ProjectLifetime = { projectId: string; epoch: number };
export type ProjectJobOwnership = ProjectLifetime & { jobId: string };

export type AppendAnimationTarget = {
  name: string;
  baseFrameId: string;
  targetLayerId: string;
  direction: AnimationDirection;
};

export type GenerationTarget =
  | { frameId: string; appendAnimation?: never }
  | { appendAnimation: AppendAnimationTarget; frameId?: never };

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

export function generationPayload(
  project: SpriteProject,
  prompt: string,
  frameCount: number,
  columns: number,
  referencePath?: string,
  target?: GenerationTarget,
) {
  return {
    projectId: project.id,
    ...target,
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

export function isInitialBlankProject(project: SpriteProject): boolean {
  return project.generationHistory.length === 0
    && project.document.frames.length === 1
    && project.document.tags.length === 0
    && Object.values(project.document.images).every((image) =>
      image.data.every((channel, index) => index % 4 !== 3 || channel === 0));
}

export function appendAnimationIssue(
  project: SpriteProject,
  prompt: string,
  nameInput: string,
  activeLayer: Layer | undefined,
  hasActiveCel: boolean,
): string | undefined {
  const name = nameInput.trim();
  if (!prompt.trim()) return "생성 프롬프트가 필요합니다.";
  if (!name) return "애니메이션 태그 이름이 필요합니다.";
  if (project.document.tags.length === 0) {
    return "먼저 타임라인에서 현재 전체 구간의 애니메이션 태그를 추가하세요.";
  }
  if (project.document.tags.some((tag) => tag.name === name)) {
    return "애니메이션 태그 이름은 비어 있지 않고 고유해야 합니다.";
  }
  const conflicts = conflictingUnityAnimationTagNames([...project.document.tags, { name }]);
  if (conflicts.length) {
    return `Unity AnimationClip 파일명이 충돌합니다: ${conflicts.join(", ")}. 충돌하는 태그를 삭제하고 서로 다른 이름으로 다시 추가하세요.`;
  }
  if (!hasActiveCel) return "현재 프레임의 활성 셀이 필요합니다.";
  if (!activeLayer?.visible || activeLayer.locked || activeLayer.blendMode !== "normal" || activeLayer.opacity !== 1) {
    return "대상 레이어는 보이고 잠기지 않은 normal·불투명도 1 레이어여야 합니다.";
  }
  return undefined;
}

export function cellEditPayload(projectId: string, request: AiEditRequest): { projectId: string; request: AiEditRequest } {
  return { projectId, request };
}

export function codexJobStatusTitle(job: Pick<GenerationJob, "kind" | "status" | "frameId"> | Pick<CellEditJob, "kind" | "status" | "phase" | "attempt" | "maxAttempts">): string {
  if (job.kind === "cellEdit") return {
    running: `현재 셀 편집 · ${job.attempt}/${job.maxAttempts} · ${job.phase === "judging" ? "판정 중" : "편집 중"}`,
    awaitingApproval: "현재 셀 편집 승인 거부 중",
    cancelling: "현재 셀 편집 취소 중",
    finalizing: "현재 셀 편집 · 적용 확인 중",
    completed: "현재 셀 편집 준비 완료",
    failed: "현재 셀 편집 실패",
    cancelled: "현재 셀 편집 취소됨",
  }[job.status];
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

export function cellEditCompletionNotice(result: AiEditReadyResult, actionCount: number): string {
  if (result.direct) return "판정 없이 선택·스포이드 동작을 적용했습니다.";
  if (result.acceptedAttempt === undefined) throw new Error("완료 응답에 합격 회차가 없습니다.");
  return `동작 ${actionCount}개 적용 · ${result.acceptedAttempt}회차 판정 합격 · 완료`;
}

export function cellEditApplicationDisposition(
  job: CellEditJob,
  deadline: number,
  now: number,
): "pending" | "completed" | "rollback" {
  if (job.status === "completed") return "completed";
  if (job.status === "failed" || (deadline > 0 && now >= deadline)) return "rollback";
  return "pending";
}

export function cellEditApplicationRequestTimeout(deadline: number, now: number): number | undefined {
  return deadline > 0 ? Math.max(0, deadline - now) : undefined;
}

export function projectLifetimeMatches(current: ProjectLifetime | undefined, expected: ProjectLifetime): boolean {
  return current?.projectId === expected.projectId && current.epoch === expected.epoch;
}

function sameProjectJobOwnership(current: ProjectJobOwnership | undefined, expected: ProjectJobOwnership): boolean {
  return projectLifetimeMatches(current, expected) && current?.jobId === expected.jobId;
}

export function projectJobOwnershipMatches(
  currentProject: ProjectLifetime | undefined,
  activeJob: ProjectJobOwnership | undefined,
  expected: ProjectJobOwnership,
): boolean {
  return projectLifetimeMatches(currentProject, expected) && sameProjectJobOwnership(activeJob, expected);
}

export function releaseProjectJobOwnership(
  current: ProjectJobOwnership | undefined,
  owner: ProjectJobOwnership,
): ProjectJobOwnership | undefined {
  return sameProjectJobOwnership(current, owner) ? undefined : current;
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

export function completedGenerationSelection(
  project: SpriteProject | undefined,
  target?: GenerationTarget,
  responseFrameId?: string,
) {
  if (target?.appendAnimation) {
    if (!project) throw new Error("완료된 생성 결과가 없습니다.");
    const tag = project.document.tags.find((candidate) => candidate.name === target.appendAnimation.name.trim());
    if (!tag) throw new Error("완료 결과에서 추가된 애니메이션 태그를 찾을 수 없습니다.");
    const firstId = frameSequence(tag)[0];
    return {
      frameIndex: project.document.frames.findIndex((frame) => frame.id === firstId),
      tag,
      frameCount: tag.frameIds.length,
    };
  }
  const requestedFrameId = target?.frameId;
  return {
    frameIndex: completedFrameIndex(project, requestedFrameId, responseFrameId),
    tag: undefined,
    frameCount: undefined,
  };
}

export function pollingErrorCodexJob(job: CodexJob | undefined, id: string, error: string): CodexJob | undefined {
  if (job?.id !== id || job.status === "completed" || job.status === "failed" || job.status === "cancelled") return job;
  return { ...job, error };
}

export function isRetryablePollingError(error: unknown): boolean {
  return !(error instanceof Error && error.cause instanceof Response);
}

export function failedCodexJob(job: CodexJob | undefined, id: string, error: string): CodexJob | undefined {
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
  if (!response.ok) {
    const result = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(result.error ?? `요청 실패 (${response.status})`, { cause: response });
  }
  return await response.json() as T;
}
