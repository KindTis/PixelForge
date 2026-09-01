import { useEffect, useRef, useState, type FormEvent } from "react";
import { UNCLASSIFIED_NAME } from "../core/animation.ts";
import type { AnimationDirection, PngImportDestination } from "../core/types.ts";

export function ImportSpriteSheetDialog({ fileName, initialName, initialDirection, onClose, onConfirm }: {
  fileName: string;
  initialName: string;
  initialDirection: AnimationDirection;
  onClose(): void;
  onConfirm(destination: PngImportDestination): Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [kind, setKind] = useState<PngImportDestination["kind"]>("set");
  const [name, setName] = useState(initialName);
  const [direction, setDirection] = useState(initialDirection);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { dialog.current?.showModal(); }, []);

  const nameIssue = !name.trim()
    ? "애니메이션 세트 이름이 필요합니다."
    : name.trim() === UNCLASSIFIED_NAME ? "미분류는 예약 이름입니다." : "";
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || (kind === "set" && nameIssue)) return;
    setBusy(true);
    setError("");
    try {
      await onConfirm(kind === "set"
        ? { kind: "set", animationSet: { name: name.trim(), direction } }
        : { kind: "unclassified" });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  };

  return <dialog
    ref={dialog}
    className="import-sheet-dialog"
    aria-labelledby="import-sheet-title"
    onCancel={(event) => {
      if (busy) event.preventDefault();
      else onClose();
    }}
  >
    <form onSubmit={submit} aria-busy={busy}>
      <header>
        <div><span>PNG SPRITE SHEET</span><h2 id="import-sheet-title">시트 가져오기</h2></div>
        <button type="button" onClick={onClose} disabled={busy} aria-label="닫기">×</button>
      </header>
      <p className="import-file">{fileName}</p>
      <fieldset className="import-destinations">
        <legend>가져온 프레임 분류</legend>
        <label className={kind === "set" ? "selected" : ""}>
          <input type="radio" name="import-destination" checked={kind === "set"} onChange={() => setKind("set")} />
          <b>이름 있는 세트로 등록</b>
        </label>
        <label className={kind === "unclassified" ? "selected" : ""}>
          <input type="radio" name="import-destination" checked={kind === "unclassified"} onChange={() => setKind("unclassified")} />
          <b>미분류 프레임으로 가져오기</b>
        </label>
      </fieldset>
      {kind === "set" ? <div className="import-set-fields">
        <label>애니메이션 이름<input autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label>재생 방향<select value={direction} onChange={(event) => setDirection(event.target.value as AnimationDirection)}><option value="forward">정방향</option><option value="reverse">역방향</option><option value="pingPong">핑퐁</option></select></label>
        {nameIssue && <p className="error" role="status">{nameIssue}</p>}
      </div> : <p className="import-warning">이 프레임은 애니메이션 미리보기와 내보내기에서 제외됩니다</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <footer>
        <button type="button" onClick={onClose} disabled={busy}>취소</button>
        <button className="primary" type="submit" disabled={busy || (kind === "set" && Boolean(nameIssue))}>{busy ? "가져오는 중…" : "프레임 교체 후 가져오기"}</button>
      </footer>
    </form>
  </dialog>;
}
