import { useEffect, useRef, useState, type FormEvent } from "react";
import type { AnimationDirection, SpriteProject } from "../core/types.ts";
import { renameProject } from "../core/document.ts";
import { api, appendAnimationIssue, cellEditApplicationDisposition, cellEditApplicationRequestTimeout, cellEditCompletionNotice, cellEditPayload, codexJobStatusTitle, completedGenerationSelection, decodeProject, encodeProject, failedCodexJob, generationPayload, isInitialBlankProject, isRetryablePollingError, pollingErrorCodexJob, projectJobOwnershipMatches, projectLifetimeMatches, releaseProjectJobOwnership, type CellEditJob, type CodexJob, type GenerationJob, type GenerationTarget, type ProjectJobOwnership, type ProjectLifetime, type Session } from "./api.ts";
import { EditorWorkspace, type EditorWorkspaceHandle } from "./editor/EditorWorkspace.tsx";
import { ExportDialog, type ExportResponse, type ExportResult, type ExportTarget } from "./ExportDialog.tsx";

type ProjectSummary = { id: string; name: string };
const CELL_EDIT_UNAVAILABLE = "설치된 Codex App Server에서 현재 셀 편집을 사용할 수 없습니다.";

async function rgbaPngBase64(file: File): Promise<string> {
  const image = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  canvas.getContext("2d")!.drawImage(image, 0, 0);
  image.close();
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("PNG를 변환할 수 없습니다.")), "image/png"));
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(new Error("PNG를 읽을 수 없습니다."));
    reader.readAsDataURL(blob);
  });
}

function NewProject({ projects, onOpen, onCreate }: {
  projects: ProjectSummary[];
  onOpen(id: string): Promise<void>;
  onCreate(name: string, size: number): Promise<void>;
}) {
  const [name, setName] = useState("새 캐릭터");
  const [size, setSize] = useState(64);
  const [error, setError] = useState("");
  const create = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await onCreate(name, size);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const open = async (id: string) => {
    try {
      await onOpen(id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <section className="start-screen">
      <div className="start-copy">
        <span className="eyebrow">LOCAL SPRITE WORKSHOP</span>
        <h2>아이디어를<br />움직이는 픽셀로.</h2>
        <p>ChatGPT 구독으로 Codex에 생성시키고, 프레임을 직접 다듬어 게임 엔진으로 보냅니다.</p>
      </div>
      <form className="new-project" onSubmit={create}>
        <h3>새 캐릭터</h3>
        <label>프로젝트 이름<input value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label>프레임 크기
          <select value={size} onChange={(event) => setSize(Number(event.target.value))}>
            {[16, 32, 48, 64, 96, 128].map((value) => <option key={value} value={value}>{value} × {value}</option>)}
          </select>
        </label>
        <button className="primary" type="submit">프로젝트 만들기</button>
        {error && <p className="error" role="alert">{error}</p>}
        {projects.length > 0 && <div className="recent-projects">
          <span>최근 프로젝트</span>
          {projects.map((project) => <button type="button" key={project.id} onClick={() => void open(project.id)}>{project.name}<b>열기</b></button>)}
        </div>}
      </form>
    </section>
  );
}

export function App() {
  const [session, setSession] = useState<Session>();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [project, setProject] = useState<SpriteProject>();
  const [projectNameDraft, setProjectNameDraft] = useState<string>();
  const latestProject = useRef<SpriteProject | undefined>(undefined);
  const projectEpoch = useRef(0);
  const projectLifetime = useRef<ProjectLifetime | undefined>(undefined);
  const activeJobOwnership = useRef<ProjectJobOwnership | undefined>(undefined);
  const editor = useRef<EditorWorkspaceHandle>(null);
  const [frameIndex, setFrameIndex] = useState(0);
  const [selectedAnimationTagId, setSelectedAnimationTagId] = useState<string>();
  const [dirty, setDirty] = useState(false);
  const [prompt, setPrompt] = useState("칼을 휘두르는 2D 기사 캐릭터, 선명한 실루엣, 제한된 판타지 팔레트");
  const [frameCount, setFrameCount] = useState(8);
  const [columns, setColumns] = useState(4);
  const [generationMode, setGenerationMode] = useState<"sheet" | "append">("sheet");
  const [animationName, setAnimationName] = useState("");
  const [animationDirection, setAnimationDirection] = useState<AnimationDirection>("forward");
  const [job, setJob] = useState<CodexJob>();
  const [startingKind, setStartingKind] = useState<"generation" | "cellEdit" | "import">();
  const cellEditCancelRequested = useRef(false);
  const cellEditApplicationPending = useRef<ProjectJobOwnership | undefined>(undefined);
  const [cellEditUnavailable, setCellEditUnavailable] = useState("");
  const [reference, setReference] = useState<{ name: string; path: string }>();
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [showExport, setShowExport] = useState(false);

  useEffect(() => {
    void Promise.all([
      api<Session>("/api/session"),
      api<{ projects: ProjectSummary[] }>("/api/projects"),
    ]).then(([nextSession, list]) => {
      setSession(nextSession);
      setProjects(list.projects);
    }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, []);

  latestProject.current = project;
  const codexBusy = Boolean(startingKind) || job?.status === "running" || job?.status === "awaitingApproval" || job?.status === "cancelling" || job?.status === "finalizing";

  const setCurrentProject = (next: SpriteProject | undefined) => {
    latestProject.current = next;
    setProject(next);
  };

  const commitProjectName = () => {
    if (!project || projectNameDraft === undefined) return;
    try {
      const renamed = renameProject(project, projectNameDraft);
      setProjectNameDraft(undefined);
      if (renamed.name === project.name) return;
      setCurrentProject(renamed);
      setProjects((current) => current.map((item) => item.id === renamed.id ? { ...item, name: renamed.name } : item));
      setDirty(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const beginProjectLifetime = (projectId: string): ProjectLifetime => {
    const next = { projectId, epoch: ++projectEpoch.current };
    projectLifetime.current = next;
    activeJobOwnership.current = undefined;
    cellEditApplicationPending.current = undefined;
    return next;
  };

  const login = async () => {
    if (!session) return;
    try {
      const result = await api<{ authUrl: string }>("/api/login", session.token, { method: "POST" });
      window.open(result.authUrl, "_blank", "noopener,noreferrer");
      setNotice("브라우저에서 ChatGPT 로그인을 마친 뒤 상태를 새로고침하세요.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const save = async (lifetime = projectLifetime.current): Promise<boolean> => {
    if (!session || !project || !lifetime) return false;
    const saving = project;
    try {
      await api<SpriteProject>(`/api/projects/${project.id}`, session.token, {
        method: "PUT",
        body: JSON.stringify(encodeProject(project)),
      });
      const current = latestProject.current === saving && projectLifetimeMatches(projectLifetime.current, lifetime);
      if (current) {
        setDirty(false);
        setNotice("프로젝트를 저장했습니다.");
      }
      return current;
    } catch (reason) {
      if (projectLifetimeMatches(projectLifetime.current, lifetime)) setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    }
  };

  useEffect(() => {
    if (!dirty || !project || !session) return;
    const lifetime = projectLifetime.current;
    if (!lifetime) return;
    const timer = window.setTimeout(() => {
      const saving = project;
      void api(`/api/projects/${project.id}`, session.token, { method: "PUT", body: JSON.stringify(encodeProject(project)) })
        .then(() => { if (latestProject.current === saving && projectLifetimeMatches(projectLifetime.current, lifetime)) setDirty(false); })
        .catch((reason) => { if (projectLifetimeMatches(projectLifetime.current, lifetime)) setError(reason instanceof Error ? reason.message : String(reason)); });
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [dirty, project, session]);

  const cancelCellEdit = async (id: string, ownership?: ProjectJobOwnership) => {
    if (!session) return;
    try {
      await api<CellEditJob>(`/api/edits/${id}`, session.token, { method: "DELETE" });
    } catch (reason) {
      const response = reason instanceof Error && reason.cause instanceof Response ? reason.cause : undefined;
      if (response?.status === 409 && ownership
        && projectJobOwnershipMatches(projectLifetime.current, activeJobOwnership.current, ownership)) {
        cellEditCancelRequested.current = false;
      }
    }
  };

  const poll = async (started: CodexJob, ownership: ProjectJobOwnership, target?: GenerationTarget) => {
    let applied: ReturnType<EditorWorkspaceHandle["applyAiEdit"]> | undefined;
    let applicationError = "";
    let applicationDeadline = 0;
    let applicationCompleted = false;
    const current = () => projectJobOwnershipMatches(projectLifetime.current, activeJobOwnership.current, ownership);

    try {
      for (;;) {
        if (!current()) return;
        let next: CodexJob;
        try {
          const collection = started.kind === "generation" ? "generations" : "edits";
          const requestTimeout = cellEditApplicationRequestTimeout(applicationDeadline, Date.now());
          next = await api<CodexJob>(`/api/${collection}/${started.id}`, undefined, requestTimeout === undefined
            ? undefined
            : { signal: AbortSignal.timeout(requestTimeout) });
        } catch (reason) {
          if (!current()) return;
          if (!isRetryablePollingError(reason)) throw reason;
          const message = reason instanceof Error ? reason.message : String(reason);
          setJob((current) => pollingErrorCodexJob(current, started.id, message));
          if (started.kind === "cellEdit" && applicationDeadline > 0
            && cellEditApplicationDisposition({ ...started, status: "finalizing" }, applicationDeadline, Date.now()) === "rollback") {
            const timeout = "적용 확인 시간이 초과되어 원본 셀을 유지했습니다.";
            applied?.rollback();
            cellEditApplicationPending.current = releaseProjectJobOwnership(cellEditApplicationPending.current, ownership);
            setDirty(false);
            setJob((current) => failedCodexJob(current, started.id, timeout));
            setError(timeout);
            return;
          }
          await new Promise((resolve) => window.setTimeout(resolve, 500));
          continue;
        }
        if (!current()) return;
        if (next.kind !== started.kind) throw new Error("작업 종류가 요청과 일치하지 않습니다.");
        if (next.kind === "cellEdit" && cellEditCancelRequested.current) {
          if (next.status === "running" || next.status === "awaitingApproval") {
            await cancelCellEdit(next.id, ownership);
            if (!current()) return;
          }
          else if (next.status === "finalizing" || next.status === "completed" || next.status === "failed" || next.status === "cancelled") cellEditCancelRequested.current = false;
        }

        if (next.kind === "cellEdit" && next.status === "finalizing") {
          if (!next.result || !editor.current) throw new Error("적용 대기 중인 현재 셀 편집 결과가 없습니다.");
          if (applicationDeadline === 0) applicationDeadline = Date.now() + 60_000;
          if (!applied && !applicationError) {
            cellEditApplicationPending.current = ownership;
            try {
              applied = editor.current.applyAiEdit(next.target, next.result);
            } catch (reason) {
              applicationError = reason instanceof Error ? reason.message : String(reason);
              cellEditApplicationPending.current = releaseProjectJobOwnership(cellEditApplicationPending.current, ownership);
            }
          }
          try {
            const requestTimeout = cellEditApplicationRequestTimeout(applicationDeadline, Date.now());
            next = await api<CellEditJob>(`/api/edits/${next.id}/application`, session!.token, {
              method: "POST",
              body: JSON.stringify(applicationError
                ? { outcome: "failed", error: applicationError }
                : { outcome: "applied" }),
              signal: requestTimeout === undefined ? undefined : AbortSignal.timeout(requestTimeout),
            });
          } catch (reason) {
            if (!current()) return;
            if (!isRetryablePollingError(reason)) throw reason;
          }
          if (!current()) return;
        }

        setJob(next);

        if (next.kind === "cellEdit") {
          const disposition = cellEditApplicationDisposition(next, applicationDeadline, Date.now());
          if (disposition === "completed") {
            if (!next.result) throw new Error("완료된 현재 셀 편집 결과가 없습니다.");
            const completionNotice = cellEditCompletionNotice(next.result, applied?.actionCount ?? next.result.actionCount);
            applicationCompleted = true;
            cellEditApplicationPending.current = releaseProjectJobOwnership(cellEditApplicationPending.current, ownership);
            if (applied?.documentChanged) setDirty(true);
            setNotice(completionNotice);
            return;
          }
          if (disposition === "rollback") {
            applied?.rollback();
            cellEditApplicationPending.current = releaseProjectJobOwnership(cellEditApplicationPending.current, ownership);
            setDirty(false);
            if (next.status !== "failed") {
              const timeout = "적용 확인 시간이 초과되어 원본 셀을 유지했습니다.";
              setJob(failedCodexJob(next, next.id, timeout));
              setError(timeout);
            }
            return;
          }
        }

        if (next.kind === "generation" && next.status === "completed") {
          if (!next.project) {
            completedGenerationSelection(undefined, target, next.frameId);
          } else {
            const completedProject = decodeProject(next.project);
            const selection = completedGenerationSelection(completedProject, target, next.frameId);
            setJob({ ...next, project: completedProject });
            beginProjectLifetime(completedProject.id);
            setCurrentProject(completedProject);
            setDirty(false);
            setFrameIndex(selection.frameIndex);
            if (selection.tag) setSelectedAnimationTagId(selection.tag.id);
            else if (!target) setSelectedAnimationTagId(undefined);
            setNotice(selection.tag
              ? `${selection.tag.name} 애니메이션 ${selection.frameCount}프레임을 추가했습니다.`
              : target && "frameId" in target
                ? "선택 프레임을 재생성해 저장했습니다."
                : "생성 결과를 프레임으로 가져와 저장했습니다.");
          }
          return;
        }
        if (next.status === "failed" || next.status === "cancelled") return;
        await new Promise((resolve) => window.setTimeout(resolve, 500));
      }
    } finally {
      if (!applicationCompleted && current()) {
        applied?.rollback();
        if (applied) setDirty(false);
      }
      cellEditApplicationPending.current = releaseProjectJobOwnership(cellEditApplicationPending.current, ownership);
    }
  };

  const generate = async (target?: GenerationTarget) => {
    if (!session || !project) return;
    if (!target && !isInitialBlankProject(project)
      && !window.confirm("기존 프레임과 애니메이션 태그를 모두 교체합니다. 전체 시트를 다시 생성할까요?")) return;
    const lifetime = beginProjectLifetime(project.id);
    setError("");
    setNotice("");
    setStartingKind("generation");
    try {
      if (!(await save(lifetime)) || !projectLifetimeMatches(projectLifetime.current, lifetime)) return;
      const started = await api<GenerationJob>("/api/generations", session.token, {
        method: "POST",
        body: JSON.stringify(generationPayload(project, prompt, frameCount, Math.min(columns, frameCount), reference?.path, target)),
      });
      if (!projectLifetimeMatches(projectLifetime.current, lifetime)) {
        await api(`/api/generations/${started.id}`, session.token, { method: "DELETE" }).catch(() => undefined);
        return;
      }
      const ownership = { ...lifetime, jobId: started.id };
      activeJobOwnership.current = ownership;
      setJob(started);
      setStartingKind(undefined);
      void poll(started, ownership, target)
        .catch((reason) => {
          if (!projectJobOwnershipMatches(projectLifetime.current, activeJobOwnership.current, ownership)) return;
          const message = reason instanceof Error ? reason.message : String(reason);
          setError(message);
          setJob((current) => failedCodexJob(current, started.id, message));
        })
        .finally(() => {
          activeJobOwnership.current = releaseProjectJobOwnership(activeJobOwnership.current, ownership);
        });
    } catch (reason) {
      if (projectLifetimeMatches(projectLifetime.current, lifetime)) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (projectLifetimeMatches(projectLifetime.current, lifetime)) {
        setStartingKind((current) => current === "generation" ? undefined : current);
      }
    }
  };

  const editCurrentCell = async () => {
    if (!session || !project || !editor.current) return;
    const lifetime = beginProjectLifetime(project.id);
    setError("");
    setNotice("");
    let request;
    try {
      request = editor.current.captureAiEditRequest(prompt);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return;
    }
    let started: CellEditJob | undefined;
    cellEditCancelRequested.current = false;
    setStartingKind("cellEdit");
    try {
      if (!(await save(lifetime)) || !projectLifetimeMatches(projectLifetime.current, lifetime) || cellEditCancelRequested.current) return;
      started = await api<CellEditJob>("/api/edits", session.token, {
        method: "POST",
        body: JSON.stringify(cellEditPayload(project.id, request)),
      });
      if (!projectLifetimeMatches(projectLifetime.current, lifetime)) {
        await cancelCellEdit(started.id);
        return;
      }
      const ownership = { ...lifetime, jobId: started.id };
      activeJobOwnership.current = ownership;
      setJob(started);
      if (cellEditCancelRequested.current) {
        await cancelCellEdit(started.id, ownership);
        if (!projectJobOwnershipMatches(projectLifetime.current, activeJobOwnership.current, ownership)) return;
      }
      setStartingKind(undefined);
      void poll(started, ownership)
        .catch((reason) => {
          if (!projectJobOwnershipMatches(projectLifetime.current, activeJobOwnership.current, ownership)) return;
          const message = reason instanceof Error ? reason.message : String(reason);
          setError(message);
          setJob((current) => failedCodexJob(current, started!.id, message));
        })
        .finally(() => {
          activeJobOwnership.current = releaseProjectJobOwnership(activeJobOwnership.current, ownership);
        });
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      if (projectLifetimeMatches(projectLifetime.current, lifetime)) {
        if (message === CELL_EDIT_UNAVAILABLE) setCellEditUnavailable(message);
        setError(message);
      }
    } finally {
      if (!started && projectLifetimeMatches(projectLifetime.current, lifetime)) cellEditCancelRequested.current = false;
      if (projectLifetimeMatches(projectLifetime.current, lifetime)) {
        setStartingKind((current) => current === "cellEdit" ? undefined : current);
      }
    }
  };

  const cancel = async () => {
    if (!session) return;
    if (startingKind === "cellEdit") {
      cellEditCancelRequested.current = true;
      return;
    }
    if (!job) return;
    if (job.kind === "cellEdit") {
      cellEditCancelRequested.current = true;
      await cancelCellEdit(job.id, activeJobOwnership.current);
      return;
    }
    const ownership = activeJobOwnership.current;
    if (!ownership || ownership.jobId !== job.id || !projectJobOwnershipMatches(projectLifetime.current, ownership, ownership)) return;
    try {
      const cancelled = await api<GenerationJob>(`/api/generations/${job.id}`, session.token, { method: "DELETE" });
      if (projectJobOwnershipMatches(projectLifetime.current, activeJobOwnership.current, ownership)) setJob(cancelled);
    } catch (reason) {
      if (projectJobOwnershipMatches(projectLifetime.current, activeJobOwnership.current, ownership)) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    }
  };

  const approve = async (accept: boolean) => {
    if (!session || !job || job.kind !== "generation") return;
    const ownership = activeJobOwnership.current;
    if (!ownership || ownership.jobId !== job.id || !projectJobOwnershipMatches(projectLifetime.current, ownership, ownership)) return;
    await api("/api/approvals", session.token, { method: "POST", body: JSON.stringify({ jobId: job.id, accept }) });
    if (projectJobOwnershipMatches(projectLifetime.current, activeJobOwnership.current, ownership)) {
      setJob({ ...job, status: accept ? "running" : "cancelled", approval: undefined });
    }
  };

  const uploadReference = async (file?: File) => {
    if (!file || !session || !project || codexBusy) return;
    const lifetime = projectLifetime.current;
    if (!lifetime) return;
    setError("");
    try {
      const pngBase64 = await rgbaPngBase64(file);
      if (!projectLifetimeMatches(projectLifetime.current, lifetime)) return;
      const result = await api<{ path: string }>("/api/references", session.token, { method: "POST", body: JSON.stringify({ projectId: project.id, pngBase64 }) });
      if (!projectLifetimeMatches(projectLifetime.current, lifetime)) return;
      setReference({ name: file.name, path: result.path });
      setNotice("참조 이미지를 추가했습니다.");
    } catch (reason) {
      if (projectLifetimeMatches(projectLifetime.current, lifetime)) setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const importSheet = async (file?: File) => {
    if (!file || !session || !project || codexBusy) return;
    const lifetime = beginProjectLifetime(project.id);
    setStartingKind("import");
    setError("");
    try {
      const pngBase64 = await rgbaPngBase64(file);
      if (!projectLifetimeMatches(projectLifetime.current, lifetime)) return;
      const imported = decodeProject(await api<SpriteProject>("/api/imports", session.token, {
        method: "POST",
        body: JSON.stringify({
          projectId: project.id,
          pngBase64,
          request: { prompt: `직접 가져오기: ${file.name}`, frameCount, columns: Math.min(columns, frameCount), cellWidth: project.document.width, cellHeight: project.document.height, durationMs: 100 },
        }),
      }));
      if (!projectLifetimeMatches(projectLifetime.current, lifetime)) return;
      setCurrentProject(imported);
      setDirty(false);
      setFrameIndex(0);
      setSelectedAnimationTagId(undefined);
      setNotice("PNG 시트를 프레임으로 가져왔습니다.");
    } catch (reason) {
      if (projectLifetimeMatches(projectLifetime.current, lifetime)) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (projectLifetimeMatches(projectLifetime.current, lifetime)) {
        setStartingKind((current) => current === "import" ? undefined : current);
      }
    }
  };

  const selectProject = (next: SpriteProject, lifetime = beginProjectLifetime(next.id)) => {
    projectLifetime.current = lifetime;
    activeJobOwnership.current = undefined;
    cellEditApplicationPending.current = undefined;
    cellEditCancelRequested.current = false;
    setCurrentProject(next);
    setProjectNameDraft(undefined);
    setStartingKind(undefined);
    setJob(undefined);
    setReference(undefined);
    setDirty(false);
    setFrameIndex(0);
    setSelectedAnimationTagId(undefined);
    const generatedFrames = next.generationHistory.length ? next.document.frames.length : 8;
    setFrameCount(generatedFrames);
    setColumns(Math.min(next.exportSettings.columns, generatedFrames));
  };

  const openProject = async (id: string) => {
    const lifetime = beginProjectLifetime(id);
    try {
      const opened = decodeProject(await api<SpriteProject>(`/api/projects/${id}`));
      if (projectLifetimeMatches(projectLifetime.current, lifetime)) selectProject(opened, lifetime);
    } catch (reason) {
      if (projectLifetimeMatches(projectLifetime.current, lifetime)) throw reason;
    }
  };

  const createNewProject = async (name: string, size: number) => {
    if (!session) return;
    const lifetime = beginProjectLifetime("new-project");
    try {
      const created = decodeProject(await api<SpriteProject>("/api/projects", session.token, {
        method: "POST",
        body: JSON.stringify({ name, width: size, height: size }),
      }));
      if (!projectLifetimeMatches(projectLifetime.current, lifetime)) return;
      setProjects((current) => [{ id: created.id, name: created.name }, ...current]);
      selectProject(created);
    } catch (reason) {
      if (projectLifetimeMatches(projectLifetime.current, lifetime)) throw reason;
    }
  };

  const leaveProject = async () => {
    if (codexBusy) return;
    const lifetime = projectLifetime.current;
    if (!lifetime || (dirty && !(await save(lifetime))) || !projectLifetimeMatches(projectLifetime.current, lifetime)) return;
    projectEpoch.current += 1;
    projectLifetime.current = undefined;
    activeJobOwnership.current = undefined;
    cellEditApplicationPending.current = undefined;
    setCurrentProject(undefined);
    setJob(undefined);
    setReference(undefined);
  };

  const runExport = async (
    target: ExportTarget,
    settings: SpriteProject["exportSettings"],
  ): Promise<ExportResult | undefined> => {
    if (!session || !project) throw new Error("프로젝트를 먼저 여세요.");
    const lifetime = projectLifetime.current;
    if (!lifetime) throw new Error("프로젝트를 먼저 여세요.");
    const exporting = project;
    const current = () => latestProject.current === exporting && projectLifetimeMatches(projectLifetime.current, lifetime);
    const response = await api<ExportResponse>("/api/exports", session.token, {
      method: "POST",
      body: JSON.stringify({
        projectId: project.id,
        project: encodeProject(project),
        target,
        options: settings,
      }),
    });
    if (response.status === "cancelled") return undefined;
    if (!current()) throw new Error("프로젝트가 변경되어 내보내기 결과를 반영하지 않았습니다.");
    setCurrentProject({ ...project, exportSettings: settings });
    setDirty(false);
    return response;
  };

  if (!session) return <main className="loading-screen"><span className="brand-mark">PF</span><p>{error || "작업실을 여는 중…"}</p></main>;
  const account = session.account.account;
  const startingCellEdit = startingKind === "cellEdit";

  return (
    <main className="app-shell">
      <header className="topbar">
        <button className="brand" type="button" disabled={codexBusy} onClick={() => void leaveProject()} aria-label="프로젝트 선택으로 이동"><span className="brand-mark">PF</span><b>PixelForge</b></button>
        <span className="divider" />
        {project ? projectNameDraft === undefined
          ? <button className="project-name" type="button" disabled={codexBusy} aria-label="프로젝트 이름 변경" onClick={() => setProjectNameDraft(project.name)}>{project.name}</button>
          : <input className="project-name" autoFocus disabled={codexBusy} aria-label="프로젝트 이름" value={projectNameDraft} onChange={(event) => setProjectNameDraft(event.target.value)} onBlur={commitProjectName} onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") setProjectNameDraft(undefined);
            }} />
          : <strong className="project-name">프로젝트 선택</strong>}
        <div className="top-actions">
          {account?.type === "chatgpt"
            ? <span className="account"><i />{account.planType || "ChatGPT"} · {account.email}</span>
            : <button type="button" onClick={() => void login()}>ChatGPT 로그인</button>}
          {project && <button type="button" disabled={codexBusy} onClick={() => setShowExport(true)}>내보내기</button>}
          {project && <button type="button" disabled={codexBusy} onClick={() => void save()}>저장 <kbd>Ctrl S</kbd></button>}
        </div>
      </header>

      {!project ? <NewProject projects={projects} onOpen={openProject} onCreate={createNewProject} /> : <EditorWorkspace ref={editor} project={project} frameIndex={frameIndex} readOnly={codexBusy} onFrameIndex={setFrameIndex} selectedAnimationTagId={selectedAnimationTagId} onSelectedAnimationTagId={setSelectedAnimationTagId} onChange={(next) => {
        setCurrentProject(next);
        const pending = cellEditApplicationPending.current;
        if (!pending || !projectJobOwnershipMatches(projectLifetime.current, activeJobOwnership.current, pending)) setDirty(true);
      }} onSave={() => void save()} saveState={dirty ? "저장 대기" : "저장됨"} onError={setError} generationPanel={({ activeFrameId, activeFrameNumber, activeLayer, hasActiveCel }) => {
        const name = animationName.trim();
        const issue = appendAnimationIssue(project, prompt, name, activeLayer, hasActiveCel);
        const appendDisabled = account?.type !== "chatgpt" || codexBusy || Boolean(issue);
        return <section className="generation-panel">
            <div className="panel-title"><span>CODEX FORGE</span><b>{account?.type === "chatgpt" ? "연결됨" : "로그인 필요"}</b></div>
            <form onSubmit={(event) => { event.preventDefault(); if (generationMode === "sheet") void generate(); }}>
              <label className="generation-mode">생성 방식<select disabled={codexBusy} value={generationMode} onChange={(event) => setGenerationMode(event.target.value as "sheet" | "append")}><option value="sheet">전체 시트</option><option value="append">추가 애니메이션</option></select></label>
              <label>프롬프트<textarea rows={6} disabled={codexBusy} value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label>
              <div className="form-grid">
                <label>{generationMode === "append" ? "추가 생성 프레임 수 (기준 제외)" : "총 프레임 수"}<input type="number" min="1" max="256" disabled={codexBusy} value={frameCount} onChange={(event) => setFrameCount(Number(event.target.value))} /></label>
                <label>열<input type="number" min="1" max={frameCount} disabled={codexBusy} value={columns} onChange={(event) => setColumns(Number(event.target.value))} /></label>
              </div>
              {generationMode === "append" && <>
                <div className="form-grid append-fields">
                  <label>애니메이션 이름<input disabled={codexBusy} value={animationName} onChange={(event) => setAnimationName(event.target.value)} /></label>
                  <label>재생 방향<select disabled={codexBusy} value={animationDirection} onChange={(event) => setAnimationDirection(event.target.value as AnimationDirection)}><option value="forward">정방향</option><option value="reverse">역방향</option><option value="pingPong">핑퐁</option></select></label>
                </div>
                <p className="hint append-context">현재 기준 F{activeFrameNumber} · 대상 레이어 {activeLayer?.name ?? "없음"}</p>
                {issue && <p className="error append-issue" role="status">{issue}</p>}
              </>}
              <p className="hint">{project.document.width} × {project.document.height}px · 투명 배경 · PNG</p>
              <div className="asset-inputs">
                <label>참조 PNG<input type="file" accept="image/png" disabled={codexBusy} onChange={(event) => void uploadReference(event.target.files?.[0])} /></label>
                <label>시트 가져오기<input type="file" accept="image/png" disabled={codexBusy} onChange={(event) => void importSheet(event.target.files?.[0])} /></label>
              </div>
              {reference && <p className="reference-file"><span>{reference.name}</span><button type="button" disabled={codexBusy} onClick={() => setReference(undefined)}>제거</button></p>}
              {generationMode === "append"
                ? <button className="forge-button" type="button" disabled={appendDisabled} onClick={() => void generate({ appendAnimation: {
                    name,
                    baseFrameId: activeFrameId,
                    targetLayerId: activeLayer!.id,
                    direction: animationDirection,
                  } })}><span>애니메이션 추가</span><b>⌘ ↗</b></button>
                : <button className="forge-button" type="submit" disabled={!account || codexBusy}>
                    <span>{isInitialBlankProject(project) ? "스프라이트 생성" : "전체 시트 다시 생성"}</span><b>⌘ ↗</b>
                  </button>}
              <button className="forge-button" type="button" disabled={!account || codexBusy || !project.document.frames[frameIndex]} onClick={() => void generate({ frameId: project.document.frames[frameIndex].id })}>
                <span>선택 프레임 재생성</span><b>⌘ ↗</b>
              </button>
              <button className="forge-button" type="button" disabled={account?.type !== "chatgpt" || !prompt.trim() || !hasActiveCel || activeLayer?.locked || codexBusy || Boolean(cellEditUnavailable)} onClick={() => void editCurrentCell()}>
                <span>현재 셀 편집</span><b>⌘ ↗</b>
              </button>
              <p className="hint cell-edit-scope">현재 프레임의 활성 레이어 셀 하나만 편집합니다.</p>
              {cellEditUnavailable && <p className="error" role="status">{cellEditUnavailable}</p>}
            </form>
            {(startingCellEdit || job) && <div className={`job-status ${startingCellEdit ? "running" : job!.status}`} aria-live="polite">
              <b>{startingCellEdit ? "현재 셀 편집 시작 중" : codexJobStatusTitle(job!)}</b>
              <p>{startingCellEdit
                ? "프로젝트를 저장하고 현재 셀 편집을 시작하고 있습니다."
                : job!.error || job!.messages?.at(-1) || (job!.kind === "cellEdit" ? "현재 셀에 적용할 도구 동작을 구성하고 있습니다." : "캐릭터 일관성과 프레임 격자를 확인하고 있습니다.")}</p>
              {job?.kind === "cellEdit" && job.lastVerdict && <p>{job.lastVerdict}</p>}
              {job?.kind === "cellEdit" && job.logPath && <p>로그: {job.logPath}</p>}
              {startingCellEdit && <button type="button" onClick={() => void cancel()}>편집 취소</button>}
              {!startingCellEdit && job!.kind === "cellEdit" && (job!.status === "running" || job!.status === "awaitingApproval") && <button type="button" onClick={() => void cancel()}>편집 취소</button>}
              {!startingCellEdit && job!.kind === "generation" && job!.status === "running" && <button type="button" onClick={() => void cancel()}>생성 취소</button>}
              {!startingCellEdit && job!.kind === "generation" && job!.status === "awaitingApproval" && <div><button type="button" onClick={() => void approve(true)}>허용</button><button type="button" onClick={() => void approve(false)}>거부</button></div>}
            </div>}
            <div className="history">
              <span>생성 이력</span>
              {project.generationHistory.length === 0 ? <p>첫 결과를 만들면 프롬프트 이력이 여기에 남습니다.</p> : [...project.generationHistory].reverse().map((item, index) =>
                <button type="button" disabled={codexBusy} key={item.id} onClick={() => setPrompt(item.prompt)}><b>v{project.generationHistory.length - index}</b><span>{item.prompt}</span></button>)}
            </div>
          </section>;
      }} />}
      {(notice || error || session.account.error) && <div className={`toast ${error || session.account.error ? "error" : ""}`} role="status">{error || session.account.error || notice}</div>}
      {project && showExport && <ExportDialog settings={project.exportSettings} onClose={() => setShowExport(false)} onExport={runExport} />}
    </main>
  );
}
