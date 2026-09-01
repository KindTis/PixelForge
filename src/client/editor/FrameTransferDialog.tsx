import { useState, type FormEvent } from "react";
import type { AnimationDirection, SpriteDocument } from "../../core/types.ts";

export type FrameTransferChoice =
  | { kind: "create"; name: string; direction: AnimationDirection; mode: "copy" | "move" }
  | { kind: "copy" | "move"; targetTagId: string; insertAfterFrameId?: string };

export function FrameTransferDialog({ kind, document, sourceTagId, onClose, onSubmit }: {
  kind: FrameTransferChoice["kind"];
  document: SpriteDocument;
  sourceTagId: string | null;
  onClose(): void;
  onSubmit(choice: FrameTransferChoice): void;
}) {
  const targets = document.tags.filter((tag) => tag.id !== sourceTagId);
  const [name, setName] = useState("");
  const [direction, setDirection] = useState<AnimationDirection>("forward");
  const [mode, setMode] = useState<"copy" | "move">(sourceTagId === null ? "move" : "copy");
  const [targetTagId, setTargetTagId] = useState(targets[0]?.id ?? "");
  const [insertAfterFrameId, setInsertAfterFrameId] = useState("");
  const target = targets.find((tag) => tag.id === targetTagId);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (kind === "create") {
      if (!name.trim()) return;
      onSubmit({ kind, name, direction, mode: sourceTagId === null ? "move" : mode });
    } else if (targetTagId) {
      onSubmit({ kind, targetTagId, insertAfterFrameId: insertAfterFrameId || undefined });
    }
  };

  return <dialog className="frame-transfer-dialog" open aria-label={kind === "create" ? "새 애니메이션 세트 등록" : "프레임 소속 변경"}>
    <form onSubmit={submit}>
      <header><div><span>ANIMATION SET</span><h2>{kind === "create" ? "새 세트로 등록" : kind === "copy" ? "프레임 복제" : "프레임 이동"}</h2></div><button type="button" onClick={onClose} aria-label="닫기">×</button></header>
      {kind === "create" ? <>
        <label>세트 이름<input autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label>재생 방향<select value={direction} onChange={(event) => setDirection(event.target.value as AnimationDirection)}><option value="forward">정방향</option><option value="reverse">역방향</option><option value="pingPong">핑퐁</option></select></label>
        {sourceTagId === null
          ? <p>미분류 프레임은 새 세트로 이동합니다.</p>
          : <fieldset><legend>등록 방식</legend><label><input type="radio" name="mode" value="copy" checked={mode === "copy"} onChange={() => setMode("copy")} /> 복제하여 새 세트 만들기</label><label><input type="radio" name="mode" value="move" checked={mode === "move"} onChange={() => setMode("move")} /> 이동하여 새 세트 만들기</label></fieldset>}
      </> : <>
        <label>대상 세트<select value={targetTagId} onChange={(event) => { setTargetTagId(event.target.value); setInsertAfterFrameId(""); }}>{targets.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}</select></label>
        <label>삽입 위치<select value={insertAfterFrameId} onChange={(event) => setInsertAfterFrameId(event.target.value)}><option value="">세트 맨 뒤</option>{target?.frameIds.map((frameId, index) => <option key={frameId} value={frameId}>F{index + 1} 뒤</option>)}</select></label>
      </>}
      <footer><button type="button" onClick={onClose}>취소</button><button className="primary" type="submit" disabled={kind === "create" ? !name.trim() : !targetTagId}>확인</button></footer>
    </form>
  </dialog>;
}
