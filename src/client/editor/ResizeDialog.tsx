import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ResizeAnchor } from "../../core/resize.ts";

export type ResizeRequest = {
  mode: "canvas";
  width: number;
  height: number;
  horizontal: ResizeAnchor;
  vertical: ResizeAnchor;
} | {
  mode: "image";
  width: number;
  height: number;
};

const ANCHORS: Array<{ horizontal: ResizeAnchor; vertical: ResizeAnchor; label: string; icon: string }> = [
  { horizontal: "start", vertical: "start", label: "왼쪽 위", icon: "↖" },
  { horizontal: "center", vertical: "start", label: "위", icon: "↑" },
  { horizontal: "end", vertical: "start", label: "오른쪽 위", icon: "↗" },
  { horizontal: "start", vertical: "center", label: "왼쪽", icon: "←" },
  { horizontal: "center", vertical: "center", label: "가운데", icon: "•" },
  { horizontal: "end", vertical: "center", label: "오른쪽", icon: "→" },
  { horizontal: "start", vertical: "end", label: "왼쪽 아래", icon: "↙" },
  { horizontal: "center", vertical: "end", label: "아래", icon: "↓" },
  { horizontal: "end", vertical: "end", label: "오른쪽 아래", icon: "↘" },
];

export function ResizeDialog({ initialWidth, initialHeight, onClose, onApply }: {
  initialWidth: number;
  initialHeight: number;
  onClose(): void;
  onApply(request: ResizeRequest): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [mode, setMode] = useState<"canvas" | "image">("canvas");
  const [width, setWidth] = useState(initialWidth);
  const [height, setHeight] = useState(initialHeight);
  const [locked, setLocked] = useState(true);
  const [horizontal, setHorizontal] = useState<ResizeAnchor>("center");
  const [vertical, setVertical] = useState<ResizeAnchor>("center");
  const [error, setError] = useState("");
  useEffect(() => { dialog.current?.showModal(); }, []);

  const selectMode = (next: typeof mode) => {
    setMode(next);
    setWidth(initialWidth);
    setHeight(initialHeight);
    setError("");
  };
  const changeWidth = (value: number) => {
    setWidth(value);
    if (mode === "image" && locked) setHeight(Math.max(1, Math.round(value * initialHeight / initialWidth)));
  };
  const changeHeight = (value: number) => {
    setHeight(value);
    if (mode === "image" && locked) setWidth(Math.max(1, Math.round(value * initialWidth / initialHeight)));
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (![width, height].every((value) => Number.isInteger(value) && value >= 1 && value <= 4096)) {
      setError("크기는 1~4096 사이의 정수여야 합니다.");
      return;
    }
    try {
      onApply(mode === "canvas" ? { mode, width, height, horizontal, vertical } : { mode, width, height });
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return <dialog ref={dialog} className="export-dialog resize-dialog" aria-labelledby="resize-title" onCancel={onClose}>
    <form onSubmit={submit}>
      <header><div><span>DOCUMENT SIZE</span><h2 id="resize-title">크기 변경</h2></div><button type="button" onClick={onClose} aria-label="닫기">×</button></header>
      <div className="resize-modes" role="group" aria-label="크기 변경 방식">
        <button type="button" className={mode === "canvas" ? "selected" : ""} aria-pressed={mode === "canvas"} onClick={() => selectMode("canvas")}><b>캔버스 크기</b><small>픽셀 크기 유지</small></button>
        <button type="button" className={mode === "image" ? "selected" : ""} aria-pressed={mode === "image"} onClick={() => selectMode("image")}><b>이미지 크기</b><small>모든 픽셀 확대·축소</small></button>
      </div>
      <p className="resize-current">현재 크기 <b>{initialWidth} × {initialHeight}px</b></p>
      <div className="resize-size-grid">
        <label>너비<input type="number" min="1" max="4096" value={width} onChange={(event) => changeWidth(Number(event.target.value))} /></label>
        <label>높이<input type="number" min="1" max="4096" value={height} onChange={(event) => changeHeight(Number(event.target.value))} /></label>
      </div>
      {mode === "canvas" ? <fieldset className="resize-anchor">
        <legend>기준점</legend>
        <div>{ANCHORS.map((anchor) => <button
          type="button"
          key={`${anchor.horizontal}-${anchor.vertical}`}
          className={horizontal === anchor.horizontal && vertical === anchor.vertical ? "selected" : ""}
          aria-label={anchor.label}
          aria-pressed={horizontal === anchor.horizontal && vertical === anchor.vertical}
          onClick={() => { setHorizontal(anchor.horizontal); setVertical(anchor.vertical); }}
        >{anchor.icon}</button>)}</div>
        <small>축소해 가려진 픽셀은 삭제되지 않습니다.</small>
      </fieldset> : <label className="resize-lock"><input type="checkbox" checked={locked} onChange={(event) => setLocked(event.target.checked)} /> 가로·세로 비율 유지</label>}
      {error && <p className="error" role="alert">{error}</p>}
      <footer><button type="button" onClick={onClose}>취소</button><button className="primary" type="submit">크기 적용</button></footer>
    </form>
  </dialog>;
}
