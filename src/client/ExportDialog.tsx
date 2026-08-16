import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ExportSettings } from "../core/types.ts";

export type ExportTarget = "common" | "godot" | "unity";
export type ExportResult = { outputPath: string; files: string[] };
export type ExportResponse = { status: "cancelled" } | ({ status: "completed" } & ExportResult);

export function ExportDialog({ settings: initial, onClose, onExport }: {
  settings: ExportSettings;
  onClose(): void;
  onExport(target: ExportTarget, settings: ExportSettings): Promise<ExportResult | undefined>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const submitButton = useRef<HTMLButtonElement>(null);
  const [target, setTarget] = useState<ExportTarget>("godot");
  const [settings, setSettings] = useState(initial);
  const [result, setResult] = useState<ExportResult>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    setResult(undefined);
    try {
      const next = await onExport(target, settings);
      if (next) setResult(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
      window.requestAnimationFrame(() => submitButton.current?.focus());
    }
  };
  const number = (key: "columns" | "padding" | "margin" | "pixelsPerUnit", value: number) => setSettings({ ...settings, [key]: value });

  return <dialog
    ref={dialog}
    className="export-dialog"
    aria-labelledby="export-title"
    onCancel={(event) => {
      if (busy) event.preventDefault();
      else onClose();
    }}
  >
    <form onSubmit={submit} aria-busy={busy}>
      <header><div><span>ENGINE DELIVERY</span><h2 id="export-title">게임 엔진으로 내보내기</h2></div><button type="button" onClick={onClose} disabled={busy} aria-label="닫기">×</button></header>
      <fieldset className="export-targets">
        <legend>대상</legend>
        {(["common", "godot", "unity"] as const).map((value) => <label key={value} className={target === value ? "selected" : ""}>
          <input type="radio" name="target" value={value} checked={target === value} onChange={() => { setTarget(value); setResult(undefined); }} />
          <b>{value === "common" ? "PNG + JSON" : value === "godot" ? "Godot 4" : "Unity"}</b>
          <small>{value === "common" ? "범용 시트" : value === "godot" ? "SpriteFrames" : "Sprite + Clips"}</small>
        </label>)}
      </fieldset>
      <div className="export-grid">
        <label>열 수<input type="number" min="1" max="256" value={settings.columns} onChange={(event) => number("columns", Number(event.target.value))} /></label>
        <label>패딩<input type="number" min="0" max="128" value={settings.padding} onChange={(event) => number("padding", Number(event.target.value))} /></label>
        <label>여백<input type="number" min="0" max="128" value={settings.margin} onChange={(event) => number("margin", Number(event.target.value))} /></label>
        <label>Pixels Per Unit<input type="number" min="1" max="4096" disabled={target !== "unity"} value={settings.pixelsPerUnit} onChange={(event) => number("pixelsPerUnit", Number(event.target.value))} /></label>
        <label>피벗 X<input type="number" min="0" max="1" step="0.05" disabled={target !== "unity"} value={settings.pivot.x} onChange={(event) => setSettings({ ...settings, pivot: { ...settings.pivot, x: Number(event.target.value) } })} /></label>
        <label>피벗 Y<input type="number" min="0" max="1" step="0.05" disabled={target !== "unity"} value={settings.pivot.y} onChange={(event) => setSettings({ ...settings, pivot: { ...settings.pivot, y: Number(event.target.value) } })} /></label>
      </div>
      <label className="trim-option"><input type="checkbox" checked={settings.trim} onChange={(event) => setSettings({ ...settings, trim: event.target.checked })} /> 투명 여백 자르기</label>
      <p className="export-hint" role="status" aria-live="polite">
        {busy ? "내보내기 요청을 처리하는 중입니다." : "모든 애니메이션 태그와 프레임 시간이 함께 기록됩니다."}
      </p>
      {result && <section className="export-result" aria-live="polite"><b>내보내기 완료</b><code>{result.outputPath}</code><ul>{result.files.map((file) => <li key={file}>{file}</li>)}</ul></section>}
      {error && <p className="error" role="alert">{error}</p>}
      <footer><button type="button" onClick={onClose} disabled={busy}>닫기</button><button ref={submitButton} className="primary" type="submit" disabled={busy}>{busy ? "내보내는 중…" : `${target === "common" ? "범용" : target === "godot" ? "Godot" : "Unity"} 묶음 만들기`}</button></footer>
    </form>
  </dialog>;
}
