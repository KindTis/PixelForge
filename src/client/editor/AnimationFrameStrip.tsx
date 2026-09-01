import { useEffect, useRef, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import { compositeFrame } from "../../core/render.ts";
import type { SpriteDocument } from "../../core/types.ts";

export type AnimationFrameStripProps = {
  document: SpriteDocument;
  frameIds: readonly string[];
  activeFrameId: string | null;
  selection: FrameStripSelection;
  disabled: boolean;
  reorderable: boolean;
  onActivate(frameId: string): void;
  onSelection(selection: FrameStripSelection): void;
  onReorder(frameIds: readonly string[], insertBeforeFrameId?: string): void;
};

export type FrameStripSelection = { ids: string[]; anchorId?: string };
export type FrameSelectionAction =
  | { type: "click"; frameId: string; ctrl: boolean; shift: boolean }
  | { type: "all" }
  | { type: "clear" };

export function updateFrameStripSelection(
  order: readonly string[],
  activeFrameId: string | null,
  current: FrameStripSelection,
  action: FrameSelectionAction,
): { activeFrameId: string | null; selection: FrameStripSelection } {
  if (action.type === "all") {
    return { activeFrameId, selection: { ids: [...order], anchorId: current.anchorId } };
  }
  if (action.type === "clear") {
    return { activeFrameId, selection: { ids: [], anchorId: undefined } };
  }
  if (action.shift) {
    const anchor = current.anchorId && order.includes(current.anchorId)
      ? current.anchorId
      : activeFrameId && order.includes(activeFrameId) ? activeFrameId : action.frameId;
    const start = order.indexOf(anchor);
    const end = order.indexOf(action.frameId);
    const ids = order.slice(Math.min(start, end), Math.max(start, end) + 1);
    return { activeFrameId, selection: { ids, anchorId: anchor } };
  }
  if (action.ctrl) {
    const selected = new Set(current.ids);
    if (selected.has(action.frameId)) selected.delete(action.frameId);
    else selected.add(action.frameId);
    return {
      activeFrameId,
      selection: { ids: order.filter((frameId) => selected.has(frameId)), anchorId: action.frameId },
    };
  }
  return {
    activeFrameId: action.frameId,
    selection: { ids: [action.frameId], anchorId: action.frameId },
  };
}

function FrameThumbnail({ document, frameId }: { document: SpriteDocument; frameId: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const context = canvas.current?.getContext("2d");
    if (!canvas.current || !context) return;
    const image = compositeFrame(document, frameId);
    canvas.current.width = image.width;
    canvas.current.height = image.height;
    context.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
  }, [document, frameId]);
  return <canvas ref={canvas} className="pixel-canvas" aria-hidden="true" />;
}

const DRAG_TYPE = "application/x-pixelforge-frame-ids";

export function AnimationFrameStrip({ document, frameIds, activeFrameId, selection, disabled, reorderable, onActivate, onSelection, onReorder }: AnimationFrameStripProps) {
  const updateSelection = (action: FrameSelectionAction) => {
    const next = updateFrameStripSelection(frameIds, activeFrameId, selection, action);
    if (next.activeFrameId && next.activeFrameId !== activeFrameId) onActivate(next.activeFrameId);
    onSelection(next.selection);
  };

  const clickFrame = (event: MouseEvent<HTMLButtonElement>, frameId: string) => {
    event.stopPropagation();
    updateSelection({ type: "click", frameId, ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey });
  };

  const movingFrameIds = (frameId: string) => selection.ids.includes(frameId) ? selection.ids : [frameId];
  const dragStart = (event: DragEvent<HTMLButtonElement>, frameId: string) => {
    event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(movingFrameIds(frameId)));
    event.dataTransfer.effectAllowed = "move";
  };
  const draggedIds = (event: DragEvent): string[] => {
    try {
      const value = JSON.parse(event.dataTransfer.getData(DRAG_TYPE));
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    } catch {
      return [];
    }
  };

  const keydown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      updateSelection({ type: "all" });
    } else if (event.key === "Escape") {
      event.preventDefault();
      updateSelection({ type: "clear" });
    }
  };

  const moveByOne = (frameId: string, direction: -1 | 1) => {
    const moving = movingFrameIds(frameId);
    const indexes = moving.map((id) => frameIds.indexOf(id)).filter((index) => index >= 0);
    const first = Math.min(...indexes);
    const last = Math.max(...indexes);
    if (direction < 0) {
      if (first <= 0) return;
      onReorder(moving, frameIds[first - 1]);
    } else {
      if (last >= frameIds.length - 1) return;
      onReorder(moving, frameIds[last + 2]);
    }
  };

  return <div
    className="animation-frame-strip"
    tabIndex={0}
    aria-label="현재 애니메이션 세트 프레임"
    onClick={(event) => { if (event.target === event.currentTarget) updateSelection({ type: "clear" }); }}
    onKeyDown={keydown}
    onDragOver={(event) => { if (reorderable) event.preventDefault(); }}
    onDrop={(event) => {
      if (!reorderable) return;
      event.preventDefault();
      const ids = draggedIds(event);
      if (ids.length) onReorder(ids);
    }}
  >
    {frameIds.map((frameId, index) => {
      const frame = document.frames.find((candidate) => candidate.id === frameId);
      if (!frame) return null;
      const active = frameId === activeFrameId;
      return <div className="animation-frame-card-shell" key={frameId}>
        <button
          className="animation-frame-card"
          type="button"
          disabled={disabled}
          aria-label={`${index + 1}번 프레임 선택`}
          aria-current={active ? "true" : undefined}
          aria-selected={selection.ids.includes(frameId)}
          draggable={reorderable && !disabled}
          onClick={(event) => clickFrame(event, frameId)}
          onDragStart={(event) => dragStart(event, frameId)}
          onDragOver={(event) => { if (reorderable) event.preventDefault(); }}
          onDrop={(event) => {
            if (!reorderable) return;
            event.preventDefault();
            event.stopPropagation();
            const ids = draggedIds(event);
            if (ids.length) onReorder(ids, frameId);
          }}
        >
          <FrameThumbnail document={document} frameId={frameId} />
          <span>F{String(index + 1).padStart(2, "0")}</span>
          <small>{frame.durationMs}ms</small>
          {active && <em className="visually-hidden">현재 편집 프레임</em>}
        </button>
        {reorderable && <i className="animation-frame-order">
          <button type="button" disabled={disabled || index === 0} aria-label={`${index + 1}번 프레임 앞으로 이동`} onClick={(event) => { event.stopPropagation(); moveByOne(frameId, -1); }}>←</button>
          <button type="button" disabled={disabled || index === frameIds.length - 1} aria-label={`${index + 1}번 프레임 뒤로 이동`} onClick={(event) => { event.stopPropagation(); moveByOne(frameId, 1); }}>→</button>
        </i>}
      </div>;
    })}
  </div>;
}
