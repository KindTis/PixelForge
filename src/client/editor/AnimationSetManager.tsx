import { useEffect, useState, type KeyboardEvent } from "react";
import {
  addFrameToAnimationGroup,
  animationGroupFrameIds,
  deleteAnimationFrame,
  deleteAnimationSet,
  duplicateFrameInAnimationGroup,
  reconcileAnimationSelection,
  unclassifiedFrameIds,
  updateAnimationSet,
  type AnimationSelection,
} from "../../core/animation.ts";
import type { AnimationDirection, SpriteDocument } from "../../core/types.ts";
import { AnimationFrameStrip } from "./AnimationFrameStrip.tsx";

export type AnimationSetManagerProps = {
  document: SpriteDocument;
  selection: AnimationSelection;
  disabled: boolean;
  saveState: string;
  onSelection(selection: AnimationSelection): void;
  onReplace(document: SpriteDocument, selection?: AnimationSelection): void;
  onError(message: string): void;
};

const DIRECTION_LABEL: Record<AnimationDirection, string> = {
  forward: "→",
  reverse: "←",
  pingPong: "↔",
};

export function AnimationSetManager({ document, selection, disabled, saveState, onSelection, onReplace, onError }: AnimationSetManagerProps) {
  const activeTag = selection.tagId === null
    ? undefined
    : document.tags.find((tag) => tag.id === selection.tagId);
  const frameIds = animationGroupFrameIds(document, activeTag?.id ?? null);
  const [nameDraft, setNameDraft] = useState(activeTag?.name ?? "");

  useEffect(() => setNameDraft(activeTag?.name ?? ""), [activeTag?.id, activeTag?.name]);

  const apply = (transform: () => SpriteDocument, nextSelection?: AnimationSelection) => {
    try {
      onReplace(transform(), nextSelection);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const commitName = () => {
    if (!activeTag || nameDraft.trim() === activeTag.name) return;
    try {
      onReplace(updateAnimationSet(document, activeTag.id, { name: nameDraft }), selection);
    } catch (reason) {
      setNameDraft(activeTag.name);
      onError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const cancelName = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") event.currentTarget.blur();
    else if (event.key === "Escape" && activeTag) {
      event.preventDefault();
      setNameDraft(activeTag.name);
    }
  };

  const changeDirection = (direction: AnimationDirection) => {
    if (!activeTag || direction === activeTag.direction) return;
    apply(() => updateAnimationSet(document, activeTag.id, { direction }), selection);
  };

  const removeSet = () => {
    if (!activeTag || !window.confirm("이 세트를 삭제해도 프레임은 삭제되지 않고 미분류로 이동합니다")) return;
    const released = new Set(activeTag.frameIds);
    try {
      const next = deleteAnimationSet(document, activeTag.id);
      const firstReleased = unclassifiedFrameIds(next).find((frameId) => released.has(frameId)) ?? null;
      onReplace(next, { tagId: null, frameId: firstReleased });
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const addCurrentFrame = () => {
    try {
      const result = addFrameToAnimationGroup(document, selection.tagId, selection.frameId ?? undefined);
      onReplace(result.document, { tagId: selection.tagId, frameId: result.frameId });
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const duplicateCurrentFrame = () => {
    if (!selection.frameId) return;
    try {
      const result = duplicateFrameInAnimationGroup(document, selection.tagId, selection.frameId);
      onReplace(result.document, { tagId: selection.tagId, frameId: result.frameId });
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const removeCurrentFrame = () => {
    if (!selection.frameId || document.frames.length < 2 || !window.confirm("현재 프레임을 삭제할까요?")) return;
    const index = frameIds.indexOf(selection.frameId);
    try {
      const next = deleteAnimationFrame(document, selection.frameId!);
      const remaining = animationGroupFrameIds(next, selection.tagId);
      onReplace(next, { tagId: selection.tagId, frameId: remaining[Math.min(index, remaining.length - 1)] ?? null });
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const chooseSet = (tagId: string | null) => {
    const ids = animationGroupFrameIds(document, tagId);
    onSelection({ tagId, frameId: ids[0] ?? null });
  };

  return <section className="animation-set-manager" aria-label="애니메이션 세트 관리자">
    <aside className="animation-set-list">
      <header><span>애니메이션 세트</span><small>{saveState}</small></header>
      {document.tags.map((tag) => <button
        type="button"
        className={tag.id === selection.tagId ? "active" : ""}
        aria-label={`${tag.name} 애니메이션 세트 선택`}
        aria-pressed={tag.id === selection.tagId}
        disabled={disabled}
        key={tag.id}
        onClick={() => chooseSet(tag.id)}
      ><b>{tag.name}</b><span>{tag.frameIds.length}</span><small>{DIRECTION_LABEL[tag.direction]}</small></button>)}
      <button
        type="button"
        className={selection.tagId === null ? "active" : ""}
        aria-label="미분류 프레임 선택"
        aria-pressed={selection.tagId === null}
        disabled={disabled}
        onClick={() => chooseSet(null)}
      ><b>미분류</b><span>{unclassifiedFrameIds(document).length}</span></button>
    </aside>

    <div className="animation-set-content">
      <header className="animation-set-header">
        {activeTag ? <>
          <label>세트 이름<input aria-label="애니메이션 세트 이름" disabled={disabled} value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} onBlur={commitName} onKeyDown={cancelName} /></label>
          <label>재생 방향<select aria-label="애니메이션 세트 재생 방향" disabled={disabled} value={activeTag.direction} onChange={(event) => changeDirection(event.target.value as AnimationDirection)}><option value="forward">정방향</option><option value="reverse">역방향</option><option value="pingPong">핑퐁</option></select></label>
          <button type="button" disabled={disabled} onClick={removeSet}>세트 삭제</button>
        </> : <h3>미분류</h3>}
        <div className="animation-frame-actions">
          <button type="button" disabled={disabled} onClick={addCurrentFrame}>＋</button>
          <button type="button" disabled={disabled || selection.frameId === null} onClick={duplicateCurrentFrame}>복제</button>
          <button type="button" disabled={disabled || selection.frameId === null || document.frames.length < 2} onClick={removeCurrentFrame}>현재 프레임 삭제</button>
        </div>
      </header>

      {frameIds.length > 0
        ? <AnimationFrameStrip document={document} frameIds={frameIds} activeFrameId={selection.frameId} disabled={disabled} onActivate={(frameId) => onSelection(reconcileAnimationSelection(document, { ...selection, frameId }))} />
        : <p className="animation-empty">＋로 첫 프레임을 만드세요</p>}
      {selection.tagId === null && <p className="animation-guidance">프레임을 선택해 새 세트로 등록하거나 CODEX FORGE·PNG 가져오기에서 세트 이름을 지정하세요</p>}
      {document.frames.length < 2 && selection.frameId !== null && <p className="animation-guidance">마지막 프레임은 삭제할 수 없습니다</p>}
    </div>
  </section>;
}
