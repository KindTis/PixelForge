import { useEffect, useRef, useState, type FormEvent } from "react";
import type { SpriteProject } from "../core/types.ts";
import { api, completedFrameIndex, decodeProject, encodeProject, failedGenerationJob, generationPayload, generationStatusTitle, pollingErrorGenerationJob, type GenerationJob, type Session } from "./api.ts";
import { EditorWorkspace } from "./editor/EditorWorkspace.tsx";
import { ExportDialog, type ExportResult, type ExportTarget } from "./ExportDialog.tsx";

type ProjectSummary = { id: string; name: string };

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

function NewProject({ token, projects, onOpen, onCreate }: {
  token: string;
  projects: ProjectSummary[];
  onOpen(project: SpriteProject): void;
  onCreate(project: SpriteProject): void;
}) {
  const [name, setName] = useState("새 캐릭터");
  const [size, setSize] = useState(64);
  const [error, setError] = useState("");
  const create = async (event: FormEvent) => {
    event.preventDefault();
    try {
      onCreate(decodeProject(await api<SpriteProject>("/api/projects", token, {
        method: "POST",
        body: JSON.stringify({ name, width: size, height: size }),
      })));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const open = async (id: string) => {
    try {
      onOpen(decodeProject(await api<SpriteProject>(`/api/projects/${id}`)));
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
  const latestProject = useRef<SpriteProject | undefined>(undefined);
  const [frameIndex, setFrameIndex] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [prompt, setPrompt] = useState("칼을 휘두르는 2D 기사 캐릭터, 선명한 실루엣, 제한된 판타지 팔레트");
  const [frameCount, setFrameCount] = useState(8);
  const [columns, setColumns] = useState(4);
  const [job, setJob] = useState<GenerationJob>();
  const [generationStarting, setGenerationStarting] = useState(false);
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
  const generationBusy = generationStarting || job?.status === "running" || job?.status === "awaitingApproval" || job?.status === "cancelling" || job?.status === "finalizing";

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

  const save = async (): Promise<boolean> => {
    if (!session || !project) return false;
    const saving = project;
    try {
      await api<SpriteProject>(`/api/projects/${project.id}`, session.token, {
        method: "PUT",
        body: JSON.stringify(encodeProject(project)),
      });
      const current = latestProject.current === saving;
      if (current) {
        setDirty(false);
        setNotice("프로젝트를 저장했습니다.");
      }
      return current;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    }
  };

  useEffect(() => {
    if (!dirty || !project || !session) return;
    const timer = window.setTimeout(() => {
      const saving = project;
      void api(`/api/projects/${project.id}`, session.token, { method: "PUT", body: JSON.stringify(encodeProject(project)) })
        .then(() => { if (latestProject.current === saving) setDirty(false); })
        .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [dirty, project, session]);

  const poll = async (id: string, projectId: string, requestedFrameId?: string) => {
    for (;;) {
      let next: GenerationJob;
      try {
        next = await api<GenerationJob>(`/api/generations/${id}`);
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        setJob((current) => pollingErrorGenerationJob(current, id, message));
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        continue;
      }
      if (latestProject.current?.id !== projectId) return;
      if (next.status === "completed") {
        if (!next.project) {
          completedFrameIndex(undefined, requestedFrameId, next.frameId);
        } else {
          const completedProject = decodeProject(next.project);
          const selectedFrameIndex = completedFrameIndex(completedProject, requestedFrameId, next.frameId);
          setJob({ ...next, project: completedProject });
          setProject(completedProject);
          setDirty(false);
          setFrameIndex(selectedFrameIndex);
          setNotice(requestedFrameId === undefined ? "생성 결과를 프레임으로 가져와 저장했습니다." : "선택 프레임을 재생성해 저장했습니다.");
        }
        return;
      }
      setJob(next);
      if (next.status === "failed" || next.status === "cancelled") return;
      await new Promise((resolve) => window.setTimeout(resolve, 500));
    }
  };

  const generate = async (frameId?: string) => {
    if (!session || !project) return;
    setError("");
    setNotice("");
    setGenerationStarting(true);
    try {
      if (!(await save())) return;
      const started = await api<GenerationJob>("/api/generations", session.token, {
        method: "POST",
        body: JSON.stringify(generationPayload(project, prompt, frameCount, Math.min(columns, frameCount), reference?.path, frameId)),
      });
      setJob(started);
      void poll(started.id, project.id, frameId).catch((reason) => {
        const message = reason instanceof Error ? reason.message : String(reason);
        setError(message);
        setJob((current) => failedGenerationJob(current, started.id, message));
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setGenerationStarting(false);
    }
  };

  const cancel = async () => {
    if (!session || !job) return;
    await api(`/api/generations/${job.id}`, session.token, { method: "DELETE" });
    setJob({ ...job, status: "cancelled" });
  };

  const approve = async (accept: boolean) => {
    if (!session || !job) return;
    await api("/api/approvals", session.token, { method: "POST", body: JSON.stringify({ jobId: job.id, accept }) });
    setJob({ ...job, status: accept ? "running" : "cancelled", approval: undefined });
  };

  const uploadReference = async (file?: File) => {
    if (!file || !session || !project || generationBusy) return;
    setError("");
    try {
      const result = await api<{ path: string }>("/api/references", session.token, { method: "POST", body: JSON.stringify({ projectId: project.id, pngBase64: await rgbaPngBase64(file) }) });
      setReference({ name: file.name, path: result.path });
      setNotice("참조 이미지를 추가했습니다.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const importSheet = async (file?: File) => {
    if (!file || !session || !project || generationBusy) return;
    setError("");
    try {
      const imported = decodeProject(await api<SpriteProject>("/api/imports", session.token, {
        method: "POST",
        body: JSON.stringify({
          projectId: project.id,
          pngBase64: await rgbaPngBase64(file),
          request: { prompt: `직접 가져오기: ${file.name}`, frameCount, columns: Math.min(columns, frameCount), cellWidth: project.document.width, cellHeight: project.document.height, durationMs: 100 },
        }),
      }));
      setProject(imported);
      setDirty(false);
      setFrameIndex(0);
      setNotice("PNG 시트를 프레임으로 가져왔습니다.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const selectProject = (next: SpriteProject) => {
    setProject(next);
    setJob(undefined);
    setReference(undefined);
    setDirty(false);
    setFrameIndex(0);
    const generatedFrames = next.generationHistory.length ? next.document.frames.length : 8;
    setFrameCount(generatedFrames);
    setColumns(Math.min(next.exportSettings.columns, generatedFrames));
  };

  const leaveProject = async () => {
    if (generationBusy) return;
    if (dirty && !(await save())) return;
    setProject(undefined);
    setJob(undefined);
    setReference(undefined);
  };

  const runExport = async (target: ExportTarget, settings: SpriteProject["exportSettings"]): Promise<ExportResult> => {
    if (!session || !project) throw new Error("프로젝트를 먼저 여세요.");
    const next = { ...project, exportSettings: settings };
    await api(`/api/projects/${project.id}`, session.token, { method: "PUT", body: JSON.stringify(encodeProject(next)) });
    const result = await api<ExportResult>("/api/exports", session.token, { method: "POST", body: JSON.stringify({ projectId: project.id, target, options: settings }) });
    setProject(next);
    setDirty(false);
    return result;
  };

  if (!session) return <main className="loading-screen"><span className="brand-mark">PF</span><p>{error || "작업실을 여는 중…"}</p></main>;
  const account = session.account.account;

  return (
    <main className="app-shell">
      <header className="topbar">
        <button className="brand" type="button" disabled={generationBusy} onClick={() => void leaveProject()} aria-label="프로젝트 선택으로 이동"><span className="brand-mark">PF</span><b>PixelForge</b></button>
        <span className="divider" />
        <strong className="project-name">{project?.name ?? "프로젝트 선택"}</strong>
        <div className="top-actions">
          {account?.type === "chatgpt"
            ? <span className="account"><i />{account.planType || "ChatGPT"} · {account.email}</span>
            : <button type="button" onClick={() => void login()}>ChatGPT 로그인</button>}
          {project && <button type="button" disabled={generationBusy} onClick={() => setShowExport(true)}>내보내기</button>}
          {project && <button type="button" disabled={generationBusy} onClick={() => void save()}>저장 <kbd>Ctrl S</kbd></button>}
        </div>
      </header>

      {!project ? <NewProject token={session.token} projects={projects} onOpen={selectProject} onCreate={(next) => {
        setProjects((current) => [{ id: next.id, name: next.name }, ...current]);
        selectProject(next);
      }} /> : <EditorWorkspace project={project} frameIndex={frameIndex} readOnly={generationBusy} onFrameIndex={setFrameIndex} onChange={(next) => { setProject(next); setDirty(true); }} onSave={() => void save()} saveState={dirty ? "저장 대기" : "저장됨"} onError={setError} generationPanel={
          <section className="generation-panel">
            <div className="panel-title"><span>CODEX FORGE</span><b>{account?.type === "chatgpt" ? "연결됨" : "로그인 필요"}</b></div>
            <form onSubmit={(event) => { event.preventDefault(); void generate(); }}>
              <label>프롬프트<textarea rows={6} disabled={generationBusy} value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label>
              <div className="form-grid">
                <label>프레임<input type="number" min="1" max="256" disabled={generationBusy} value={frameCount} onChange={(event) => setFrameCount(Number(event.target.value))} /></label>
                <label>열<input type="number" min="1" max={frameCount} disabled={generationBusy} value={columns} onChange={(event) => setColumns(Number(event.target.value))} /></label>
              </div>
              <p className="hint">{project.document.width} × {project.document.height}px · 투명 배경 · PNG</p>
              <div className="asset-inputs">
                <label>참조 PNG<input type="file" accept="image/png" disabled={generationBusy} onChange={(event) => void uploadReference(event.target.files?.[0])} /></label>
                <label>시트 가져오기<input type="file" accept="image/png" disabled={generationBusy} onChange={(event) => void importSheet(event.target.files?.[0])} /></label>
              </div>
              {reference && <p className="reference-file"><span>{reference.name}</span><button type="button" disabled={generationBusy} onClick={() => setReference(undefined)}>제거</button></p>}
              <button className="forge-button" type="submit" disabled={!account || generationBusy}>
                <span>{project.generationHistory.length ? "프롬프트로 다시 생성" : "스프라이트 생성"}</span><b>⌘ ↗</b>
              </button>
              <button className="forge-button" type="button" disabled={!account || generationBusy || !project.document.frames[frameIndex]} onClick={() => void generate(project.document.frames[frameIndex]?.id)}>
                <span>선택 프레임 재생성</span><b>⌘ ↗</b>
              </button>
            </form>
            {job && <div className={`job-status ${job.status}`} aria-live="polite">
              <b>{generationStatusTitle(job)}</b>
              <p>{job.error || job.messages?.at(-1) || "캐릭터 일관성과 프레임 격자를 확인하고 있습니다."}</p>
              {job.status === "running" && <button type="button" onClick={() => void cancel()}>생성 취소</button>}
              {job.status === "awaitingApproval" && <div><button type="button" onClick={() => void approve(true)}>허용</button><button type="button" onClick={() => void approve(false)}>거부</button></div>}
            </div>}
            <div className="history">
              <span>생성 이력</span>
              {project.generationHistory.length === 0 ? <p>첫 결과를 만들면 프롬프트 이력이 여기에 남습니다.</p> : [...project.generationHistory].reverse().map((item, index) =>
                <button type="button" key={item.id} onClick={() => setPrompt(item.prompt)}><b>v{project.generationHistory.length - index}</b><span>{item.prompt}</span></button>)}
            </div>
          </section>
        } />}
      {(notice || error || session.account.error) && <div className={`toast ${error || session.account.error ? "error" : ""}`} role="status">{error || session.account.error || notice}</div>}
      {project && showExport && <ExportDialog settings={project.exportSettings} onClose={() => setShowExport(false)} onExport={runExport} />}
    </main>
  );
}
