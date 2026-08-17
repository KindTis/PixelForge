import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type WheelEvent } from "react";
import type { AiEditReadyResult, AiEditRequest, AiEditTarget } from "../../core/ai-edit.ts";
import { applyCommand, History, type EditCommand, type PixelChange } from "../../core/commands.ts";
import { compositeFrame } from "../../core/render.ts";
import { convertDocumentToIndexed, indexedToRgba, nearestPaletteColor, quantizeToPalette, replaceColor, sameColor } from "../../core/palette.ts";
import { resizeCanvas, resizeImage } from "../../core/resize.ts";
import { extractSelection, flipSelection, moveSelection, pasteSelection, rectangleMask, rotateSelection, scaleSelectionNearest, type SelectionContent } from "../../core/selection.ts";
import {
  addFrame,
  addLayer,
  addTag,
  deleteFrame,
  deleteLayer,
  deleteTag,
  duplicateFrame,
  duplicateLayer,
  linkCel,
  moveFrame,
  moveLayer,
  setFrameDuration,
  unlinkCel,
} from "../../core/timeline.ts";
import { celKey, type BlendMode, type RGBA, type SpriteDocument, type SpriteProject } from "../../core/types.ts";
import { runAiEditAttempts, type AiEditorSettings } from "../../core/ai-edit-runner.ts";
import { screenToPixel, ToolController, type EditorTool } from "../../core/tool-controller.ts";
import { CanvasRenderer } from "./CanvasRenderer.ts";
import { selectionOverlay, selectionReplayMask, selectionRuns } from "./ai-edit.ts";
import { ResizeDialog, type ResizeRequest } from "./ResizeDialog.tsx";
import { shortcutAction } from "./shortcuts.ts";

const TOOLS: Array<{ id: EditorTool; icon: string; label: string; key: string }> = [
  { id: "pencil", icon: "✎", label: "연필", key: "B" },
  { id: "eraser", icon: "◇", label: "지우개", key: "E" },
  { id: "line", icon: "╱", label: "직선", key: "L" },
  { id: "curve", icon: "⌒", label: "곡선", key: "C" },
  { id: "rectangle", icon: "□", label: "사각형", key: "R" },
  { id: "ellipse", icon: "○", label: "타원", key: "O" },
  { id: "polygon", icon: "△", label: "다각형", key: "P" },
  { id: "fill", icon: "▰", label: "채우기", key: "G" },
  { id: "gradient", icon: "◩", label: "그라디언트", key: "D" },
  { id: "spray", icon: "⁙", label: "스프레이", key: "A" },
  { id: "eyedropper", icon: "⌁", label: "스포이드", key: "I" },
  { id: "select", icon: "⌗", label: "사각 선택", key: "M" },
  { id: "lasso", icon: "♧", label: "올가미", key: "Q" },
  { id: "wand", icon: "✦", label: "마술봉", key: "W" },
];

function hex(color: RGBA): string {
  return `#${color.slice(0, 3).map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function rgba(value: string): RGBA {
  return [Number.parseInt(value.slice(1, 3), 16), Number.parseInt(value.slice(3, 5), 16), Number.parseInt(value.slice(5, 7), 16), 255];
}

function FrameCanvas({ project, index }: { project: SpriteProject; index: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const frame = project.document.frames[index];
    const context = ref.current?.getContext("2d");
    if (!frame || !context || !ref.current) return;
    const image = compositeFrame(project.document, frame.id);
    ref.current.width = image.width;
    ref.current.height = image.height;
    context.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
  }, [project, index]);
  return <canvas ref={ref} className="pixel-canvas" aria-hidden="true" />;
}

export type EditorWorkspaceHandle = {
  captureAiEditRequest(prompt: string): AiEditRequest;
  applyAiEdit(target: AiEditTarget, result: AiEditReadyResult): {
    actionCount: number;
    summary: string;
    documentChanged: boolean;
    rollback(): void;
  };
};

export type GenerationPanelContext = { hasActiveCel: boolean; activeLayerLocked: boolean };

export const EditorWorkspace = forwardRef<EditorWorkspaceHandle, {
  project: SpriteProject;
  frameIndex: number;
  readOnly: boolean;
  onFrameIndex(index: number): void;
  onChange(project: SpriteProject): void;
  onSave(): void;
  generationPanel(context: GenerationPanelContext): ReactNode;
  saveState: string;
  onError(message: string): void;
}>(function EditorWorkspace({ project, frameIndex, readOnly, onFrameIndex, onChange, onSave, generationPanel, saveState, onError }, ref) {
  const history = useRef(new History(project.document));
  const emitted = useRef<SpriteDocument>(project.document);
  const canvas = useRef<HTMLCanvasElement>(null);
  const controller = useRef<ToolController | undefined>(undefined);
  const clipboard = useRef<SelectionContent | undefined>(undefined);
  const panDrag = useRef<{ x: number; y: number; panX: number; panY: number } | undefined>(undefined);
  const [activeLayerId, setActiveLayerId] = useState(project.document.layers[0].id);
  const [tool, setTool] = useState<EditorTool>("pencil");
  const [color, setColor] = useState<RGBA>([20, 22, 26, 255]);
  const [secondaryColor, setSecondaryColor] = useState<RGBA>([255, 255, 255, 0]);
  const [brushSize, setBrushSize] = useState(1);
  const [brushShape, setBrushShape] = useState<"square" | "circle">("square");
  const [customBrush, setCustomBrush] = useState<Array<{ x: number; y: number }>>();
  const [filled, setFilled] = useState(false);
  const [mirrorX, setMirrorX] = useState(false);
  const [mirrorY, setMirrorY] = useState(false);
  const [selection, setSelection] = useState<Uint8Array>();
  const [zoom, setZoom] = useState(8);
  const [grid, setGrid] = useState(true);
  const [onion, setOnion] = useState(false);
  const [tilePreview, setTilePreview] = useState(false);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [playing, setPlaying] = useState(false);
  const [coordinate, setCoordinate] = useState({ x: 0, y: 0 });
  const [tagName, setTagName] = useState("");
  const [tagDirection, setTagDirection] = useState<"forward" | "reverse" | "pingPong">("forward");
  const [resizeOpen, setResizeOpen] = useState(false);

  useEffect(() => {
    if (project.document !== emitted.current) {
      history.current = new History(project.document);
      emitted.current = project.document;
      setSelection(undefined);
    }
    if (!project.document.layers.some((layer) => layer.id === activeLayerId)) setActiveLayerId(project.document.layers[0].id);
  }, [project.document, activeLayerId]);

  const frame = project.document.frames[Math.min(frameIndex, project.document.frames.length - 1)];
  const activeLayer = project.document.layers.find((layer) => layer.id === activeLayerId);
  const cel = project.document.cels[celKey(frame.id, activeLayerId)];
  const image = cel ? project.document.images[cel.imageId] : undefined;

  const applySettings = (next: AiEditorSettings) => {
    setTool(next.tool);
    setColor(next.color);
    setSecondaryColor(next.secondaryColor);
    setBrushSize(next.brushSize);
    setBrushShape(next.brushShape);
    setCustomBrush(next.customBrush);
    setFilled(next.filled);
    setMirrorX(next.mirrorX);
    setMirrorY(next.mirrorY);
    setSelection(next.selection);
  };

  useImperativeHandle(ref, () => ({
    captureAiEditRequest(prompt) {
      if (!cel || !image) throw new Error("현재 프레임의 활성 셀이 없습니다.");
      if (activeLayer?.locked) throw new Error("잠긴 레이어는 편집할 수 없습니다.");
      return {
        prompt,
        target: { frameId: frame.id, layerId: activeLayerId, celId: cel.id },
        settings: {
          tool, color, secondaryColor, brushSize, brushShape,
          customBrush: customBrush?.map((point) => ({ ...point })),
          filled, mirrorX, mirrorY,
          selection: selectionRuns(selection, image, cel, project.document),
        },
      };
    },
    applyAiEdit(target, result) {
      if (frame.id !== target.frameId || activeLayerId !== target.layerId || cel?.id !== target.celId) {
        throw new Error("AI 편집 대상 프레임, 레이어 또는 셀이 변경되었습니다.");
      }
      if (activeLayer?.locked) throw new Error("잠긴 레이어는 편집할 수 없습니다.");
      const settingsSnapshot: AiEditorSettings = {
        tool, color, secondaryColor, brushSize, brushShape,
        customBrush: customBrush?.map((point) => ({ ...point })),
        filled, mirrorX, mirrorY, selection: selection?.slice(),
      };
      const application = runAiEditAttempts({
        ...settingsSnapshot,
        selection: selectionReplayMask(settingsSnapshot.selection, image!, cel!, history.current.document),
        document: history.current.document,
      }, target, result.attempts);

      const historySnapshot = history.current.snapshot();
      const documentChanged = application.historySteps.length > 0;
      const document = application.historySteps.length
        ? history.current.commitSteps(application.historySteps)
        : history.current.document;
      if (application.actionCount > 0) applySettings(application.settings);
      if (application.historySteps.length) {
        emitted.current = document;
        onChange({ ...project, document });
      }

      let active = true;
      return {
        actionCount: application.actionCount,
        summary: result.summary,
        documentChanged,
        rollback() {
          if (!active) return;
          active = false;
          const restored = history.current.restore(historySnapshot);
          if (application.actionCount > 0) applySettings(settingsSnapshot);
          if (documentChanged) {
            emitted.current = restored;
            onChange({ ...project, document: restored });
          }
        },
      };
    },
  }));

  const emit = (document: SpriteDocument) => {
    if (readOnly) return;
    emitted.current = document;
    onChange({ ...project, document });
  };

  const execute = (command: EditCommand) => {
    if (readOnly) return;
    try {
      const palette = project.document.palette.map((entry) => entry.color);
      const constrained = project.document.colorMode === "indexed"
        ? { ...command, pixels: command.pixels.map((pixel) => ({ ...pixel, rgba: nearestPaletteColor(pixel.rgba, palette) })) }
        : command;
      emit(history.current.execute(constrained));
    } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
  };

  const replace = (transform: (document: SpriteDocument) => SpriteDocument) => {
    if (readOnly) return;
    try { emit(history.current.replace(transform(project.document))); } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
  };

  const applyResize = (request: ResizeRequest) => {
    if (readOnly) return;
    const current = history.current.document;
    const resized = request.mode === "canvas"
      ? resizeCanvas(current, request.width, request.height, request.horizontal, request.vertical)
      : resizeImage(current, request.width, request.height);
    if (resized === current) return;
    emit(history.current.replace(resized));
    setSelection(undefined);
    setPanOffset({ x: 0, y: 0 });
  };

  const undo = () => { if (!readOnly) emit(history.current.undo()); };
  const redo = () => { if (!readOnly) emit(history.current.redo()); };

  const view = () => {
    const element = canvas.current;
    const width = element?.clientWidth ?? 0;
    const height = element?.clientHeight ?? 0;
    return {
      frameId: frame.id,
      zoom,
      panX: Math.round((width - project.document.width * zoom) / 2) + panOffset.x,
      panY: Math.round((height - project.document.height * zoom) / 2) + panOffset.y,
      showGrid: grid,
      onionSkin: onion,
      tilePreview,
    };
  };

  const render = (document = project.document) => {
    const element = canvas.current;
    if (!element) return;
    new CanvasRenderer(element).render(document, view(), {
      selection: image && cel ? selectionOverlay(selection, image, cel, project.document) : undefined,
      mirrorX,
      mirrorY,
    });
  };

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    render();
    const observer = new ResizeObserver(() => render());
    observer.observe(element);
    return () => observer.disconnect();
  }, [project, frameIndex, zoom, grid, onion, tilePreview, panOffset, selection, mirrorX, mirrorY]);

  useEffect(() => {
    if (!playing || project.document.frames.length < 2) return;
    const timer = window.setTimeout(() => onFrameIndex((frameIndex + 1) % project.document.frames.length), frame.durationMs);
    return () => window.clearTimeout(timer);
  }, [playing, frameIndex, frame.durationMs, project.document.frames.length]);

  useEffect(() => {
    if (readOnly) {
      controller.current = undefined;
      setPlaying(false);
      setResizeOpen(false);
    }
  }, [readOnly]);

  const documentPoint = (event: ReactPointerEvent<HTMLCanvasElement>) => screenToPixel(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect(), view());
  const celPoint = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const point = documentPoint(event);
    return { x: point.x - (cel?.x ?? 0), y: point.y - (cel?.y ?? 0) };
  };

  const pointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button === 1) {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      panDrag.current = { x: event.clientX, y: event.clientY, panX: panOffset.x, panY: panOffset.y };
      return;
    }
    if (readOnly) return;
    if (!cel || !image || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    controller.current = new ToolController({ tool, celId: cel.id, color, secondaryColor, brushSize, brushShape, customBrush, filled, mirrorX, mirrorY, selection }, image);
    controller.current.pointerDown(celPoint(event));
  };

  const pointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (panDrag.current) {
      setPanOffset({ x: panDrag.current.panX + event.clientX - panDrag.current.x, y: panDrag.current.panY + event.clientY - panDrag.current.y });
      return;
    }
    const current = documentPoint(event);
    setCoordinate(current);
    const result = readOnly ? undefined : controller.current?.pointerMove({ x: current.x - (cel?.x ?? 0), y: current.y - (cel?.y ?? 0) });
    if (result?.command && !activeLayer?.locked) render(applyCommand(project.document, result.command));
  };

  const pointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (panDrag.current) { panDrag.current = undefined; return; }
    if (readOnly) { controller.current = undefined; return; }
    const result = controller.current?.pointerUp(celPoint(event));
    controller.current = undefined;
    if (result?.color) setColor(result.color);
    if (result?.selection) setSelection(result.selection);
    if (result?.command) execute(result.command);
  };

  const applyBuffer = (next: Uint8ClampedArray) => {
    if (!cel || !image) return;
    if (project.document.colorMode === "indexed") {
      const palette = project.document.palette.map((entry) => entry.color);
      next = indexedToRgba(quantizeToPalette({ ...image, data: next }, palette), image.width, image.height, palette).data;
    }
    const pixels: PixelChange[] = [];
    for (let pixel = 0; pixel < image.width * image.height; pixel += 1) {
      const offset = pixel * 4;
      if ([0, 1, 2, 3].some((channel) => image.data[offset + channel] !== next[offset + channel])) {
        pixels.push({ x: pixel % image.width, y: Math.floor(pixel / image.width), rgba: Array.from(next.slice(offset, offset + 4)) as unknown as RGBA });
      }
    }
    if (pixels.length) execute({ type: "setPixels", celId: cel.id, pixels });
  };

  const clearSelectionPixels = () => {
    if (!selection || !cel || !image) return;
    execute({ type: "setPixels", celId: cel.id, pixels: [...selection.keys()].filter((index) => selection[index]).map((index) => ({ x: index % image.width, y: Math.floor(index / image.width), rgba: [0, 0, 0, 0] })) });
  };

  const copyPixels = () => {
    if (selection && image) clipboard.current = extractSelection(image, selection);
  };

  const pastePixels = () => {
    if (!image || !clipboard.current) return;
    const pasted = pasteSelection(image, clipboard.current);
    applyBuffer(pasted.data);
  };

  const movePixels = (dx: number, dy: number) => {
    if (!selection || !image) return;
    applyBuffer(moveSelection(image, selection, dx, dy).data);
    const moved = new Uint8Array(selection.length);
    for (let index = 0; index < selection.length; index += 1) if (selection[index]) {
      const x = index % image.width + dx;
      const y = Math.floor(index / image.width) + dy;
      if (x >= 0 && y >= 0 && x < image.width && y < image.height) moved[y * image.width + x] = 1;
    }
    setSelection(moved);
  };

  const transformPixels = (kind: "flipX" | "flipY" | "rotate" | "half" | "double") => {
    if (!selection || !image) return;
    const content = extractSelection(image, selection);
    const transformed = kind === "flipX" ? flipSelection(content, true, false)
      : kind === "flipY" ? flipSelection(content, false, true)
        : kind === "rotate" ? rotateSelection(content, "clockwise")
          : scaleSelectionNearest(content, Math.max(1, Math.round(content.width * (kind === "half" ? 0.5 : 2))), Math.max(1, Math.round(content.height * (kind === "half" ? 0.5 : 2))));
    const cleared = new Uint8ClampedArray(image.data);
    for (let index = 0; index < selection.length; index += 1) if (selection[index]) cleared.fill(0, index * 4, index * 4 + 4);
    applyBuffer(pasteSelection({ ...image, data: cleared }, transformed).data);
    setSelection(rectangleMask(image.width, image.height, { x: transformed.originX, y: transformed.originY }, { x: transformed.originX + transformed.width - 1, y: transformed.originY + transformed.height - 1 }));
  };

  const makeCustomBrush = () => {
    if (!selection || !image) return;
    const content = extractSelection(image, selection);
    const centerX = Math.floor(content.width / 2);
    const centerY = Math.floor(content.height / 2);
    setCustomBrush([...content.mask.keys()].filter((index) => content.mask[index]).map((index) => ({ x: index % content.width - centerX, y: Math.floor(index / content.width) - centerY })));
    setTool("pencil");
  };

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const action = shortcutAction(event);
      if (!action) return;
      event.preventDefault();
      if (readOnly) return;
      if (action.startsWith("tool:")) setTool(action.slice(5) as EditorTool);
      else if (action === "undo") undo();
      else if (action === "redo") redo();
      else if (action === "copy") copyPixels();
      else if (action === "cut") { copyPixels(); clearSelectionPixels(); }
      else if (action === "paste") pastePixels();
      else if (action === "delete") clearSelectionPixels();
      else if (action === "move:left") movePixels(-1, 0);
      else if (action === "move:right") movePixels(1, 0);
      else if (action === "move:up") movePixels(0, -1);
      else if (action === "move:down") movePixels(0, 1);
      else if (action === "play") setPlaying((value) => !value);
      else if (action === "brush:smaller") setBrushSize((value) => Math.max(1, value - 1));
      else if (action === "brush:larger") setBrushSize((value) => Math.min(64, value + 1));
      else if (action === "save") onSave();
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  });

  const updateLayer = (layerId: string, patch: Record<string, unknown>) => replace((document) => {
    const next = structuredClone(document);
    Object.assign(next.layers.find((layer) => layer.id === layerId)!, patch);
    return next;
  });

  const addAnimationTag = () => {
    if (readOnly || !tagName.trim()) return;
    replace((document) => addTag(document, { name: tagName, fromFrameId: document.frames[0].id, toFrameId: document.frames.at(-1)!.id, direction: tagDirection }));
    setTagName("");
  };

  const reorderFrame = (id: string, target: number) => {
    const selectedId = frame.id;
    const next = moveFrame(project.document, id, target);
    replace(() => next);
    onFrameIndex(next.frames.findIndex((candidate) => candidate.id === selectedId));
  };

  const changeColorMode = (mode: "rgba" | "indexed") => {
    if (readOnly) return;
    if (mode === "rgba") return replace((document) => ({ ...document, colorMode: mode }));
    try {
      const next = convertDocumentToIndexed(project.document);
      const palette = next.palette.map((entry) => entry.color);
      emit(history.current.replace(next));
      setColor(nearestPaletteColor(color, palette));
      setSecondaryColor(nearestPaletteColor(secondaryColor, palette));
    } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
  };

  const addPaletteColor = () => replace((document) => {
    if (document.palette.some((entry) => sameColor(entry.color, color))) return document;
    if (document.palette.length >= 256) throw new Error("팔레트는 최대 256색입니다.");
    return { ...document, palette: [...document.palette, { id: crypto.randomUUID(), name: `색상 ${document.palette.length + 1}`, color }] };
  });

  const removeCurrentPaletteColor = () => replace((document) => {
    const index = document.palette.findIndex((entry) => sameColor(entry.color, color));
    if (index < 0 || document.palette.length === 1) return document;
    const used = Object.values(document.images).some((buffer) => {
      for (let offset = 0; offset < buffer.data.length; offset += 4) if ([0, 1, 2, 3].every((channel) => buffer.data[offset + channel] === color[channel])) return true;
      return false;
    });
    if (used) throw new Error("사용 중인 팔레트 색상은 제거할 수 없습니다.");
    return { ...document, palette: document.palette.filter((_, paletteIndex) => paletteIndex !== index) };
  });

  const selectedCount = selection?.reduce((sum, value) => sum + value, 0) ?? 0;

  return <>
    <section className="workspace editor-workspace">
      <aside className="tools-panel full-tools">
        <div className="panel-title"><span>도구</span><div><button type="button" onClick={undo} disabled={readOnly} aria-label="실행 취소">↶</button><button type="button" onClick={redo} disabled={readOnly} aria-label="다시 실행">↷</button><b>{TOOLS.find((item) => item.id === tool)?.label}</b></div></div>
        <div className="editor-tools">
          {TOOLS.map((item) => <button className={tool === item.id ? "active" : ""} type="button" key={item.id} disabled={readOnly} onClick={() => setTool(item.id)} aria-label={`${item.label} (${item.key})`} title={`${item.label} · ${item.key}`}><span>{item.icon}</span><small>{item.label}</small></button>)}
        </div>
        <div className="tool-options">
          <label>전경색<input type="color" value={hex(color)} disabled={readOnly} onChange={(event) => { const next = rgba(event.target.value); setColor(project.document.colorMode === "indexed" ? nearestPaletteColor(next, project.document.palette.map((entry) => entry.color)) : next); }} /></label>
          <label>배경색<input type="color" value={hex(secondaryColor)} disabled={readOnly} onChange={(event) => { const next = rgba(event.target.value); setSecondaryColor(project.document.colorMode === "indexed" ? nearestPaletteColor(next, project.document.palette.map((entry) => entry.color)) : next); }} /></label>
          <label>브러시 <output>{brushSize}px</output><input type="range" min="1" max="32" value={brushSize} disabled={readOnly} onChange={(event) => setBrushSize(Number(event.target.value))} /></label>
          <label>브러시 모양<select value={brushShape} disabled={readOnly} onChange={(event) => { setBrushShape(event.target.value as typeof brushShape); setCustomBrush(undefined); }}><option value="square">사각</option><option value="circle">원형</option></select></label>
          <button type="button" onClick={makeCustomBrush} disabled={readOnly || !selection}>선택을 사용자 브러시로</button>
          <div className="option-checks"><label><input type="checkbox" checked={filled} disabled={readOnly} onChange={(event) => setFilled(event.target.checked)} /> 채움</label><label><input type="checkbox" checked={mirrorX} disabled={readOnly} onChange={(event) => setMirrorX(event.target.checked)} /> 좌우 대칭</label><label><input type="checkbox" checked={mirrorY} disabled={readOnly} onChange={(event) => setMirrorY(event.target.checked)} /> 상하 대칭</label></div>
        </div>
        <div className="selection-actions">
          <span>선택 · {selectedCount}px</span>
          <div><button type="button" disabled={readOnly} onClick={copyPixels}>복사</button><button type="button" disabled={readOnly} onClick={() => { copyPixels(); clearSelectionPixels(); }}>잘라내기</button><button type="button" disabled={readOnly} onClick={pastePixels}>붙여넣기</button><button type="button" disabled={readOnly} onClick={clearSelectionPixels}>삭제</button></div>
          <div><button type="button" disabled={readOnly} onClick={() => transformPixels("flipX")}>↔ 뒤집기</button><button type="button" disabled={readOnly} onClick={() => transformPixels("flipY")}>↕ 뒤집기</button><button type="button" disabled={readOnly} onClick={() => transformPixels("rotate")}>↻ 90°</button><button type="button" disabled={readOnly} onClick={() => transformPixels("half")}>½ 축소</button><button type="button" disabled={readOnly} onClick={() => transformPixels("double")}>2× 확대</button><button type="button" disabled={readOnly} onClick={() => setSelection(undefined)}>해제</button></div>
        </div>
      </aside>

      <section className="canvas-stage" aria-label="픽셀 편집 캔버스">
        <div className="stage-meta">
          <span>F{String(frameIndex + 1).padStart(2, "0")} · X {coordinate.x} Y {coordinate.y}</span>
          <div><label><input type="checkbox" checked={onion} onChange={(event) => setOnion(event.target.checked)} /> 어니언</label><label><input type="checkbox" checked={tilePreview} onChange={(event) => setTilePreview(event.target.checked)} /> 타일</label><label><input type="checkbox" checked={grid} onChange={(event) => setGrid(event.target.checked)} /> 격자</label><button type="button" disabled={readOnly} onClick={() => setResizeOpen(true)}>크기 변경</button><button type="button" onClick={() => setZoom((value) => Math.max(1, value - 1))}>−</button><b>{zoom}×</b><button type="button" onClick={() => setZoom((value) => Math.min(32, value + 1))}>+</button></div>
        </div>
        <div className="editor-canvas-wrap">
          <canvas ref={canvas} className="editor-canvas" aria-label="픽셀을 그리는 캔버스" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={() => { controller.current = undefined; panDrag.current = undefined; render(); }} onWheel={(event: WheelEvent<HTMLCanvasElement>) => { event.preventDefault(); setZoom((value) => Math.max(1, Math.min(32, value + (event.deltaY < 0 ? 1 : -1)))); }} />
        </div>
        <div className="playback">
          <button type="button" disabled={readOnly} onClick={() => onFrameIndex(0)} aria-label="처음 프레임">|◀</button>
          <button className="play" type="button" disabled={readOnly} onClick={() => setPlaying((value) => !value)} aria-label={playing ? "정지" : "재생"}>{playing ? "■" : "▶"}</button>
          <span>{frameIndex + 1} / {project.document.frames.length} · {frame.durationMs}ms</span>
        </div>
      </section>

      <aside className="right-dock">
        {generationPanel({ hasActiveCel: Boolean(cel && image), activeLayerLocked: Boolean(activeLayer?.locked) })}
        <section className="layers-panel">
          <div className="panel-title"><span>레이어</span><b>{project.document.layers.length}</b></div>
          <div className="layer-actions"><button type="button" disabled={readOnly} onClick={() => replace((document) => addLayer(document))}>＋</button><button type="button" disabled={readOnly} onClick={() => replace((document) => duplicateLayer(document, activeLayerId))}>복제</button><button type="button" disabled={readOnly} onClick={() => replace((document) => deleteLayer(document, activeLayerId))}>삭제</button><button type="button" disabled={readOnly} onClick={() => replace((document) => moveLayer(document, activeLayerId, Math.max(0, document.layers.findIndex((layer) => layer.id === activeLayerId) - 1)))}>↑</button><button type="button" disabled={readOnly} onClick={() => replace((document) => moveLayer(document, activeLayerId, Math.min(document.layers.length - 1, document.layers.findIndex((layer) => layer.id === activeLayerId) + 1)))}>↓</button><button type="button" disabled={readOnly || frameIndex === 0} onClick={() => replace((document) => linkCel(document, document.frames[frameIndex - 1].id, activeLayerId, frame.id, activeLayerId))}>이전 셀 연결</button><button type="button" disabled={readOnly} onClick={() => replace((document) => unlinkCel(document, frame.id, activeLayerId))}>셀 분리</button></div>
          <div className="layer-list">{project.document.layers.map((layer) => <div className={activeLayerId === layer.id ? "selected" : ""} key={layer.id} aria-disabled={readOnly} onClick={() => { if (!readOnly) setActiveLayerId(layer.id); }}>
            <button type="button" disabled={readOnly} aria-label={layer.visible ? "레이어 숨기기" : "레이어 보이기"} onClick={(event) => { event.stopPropagation(); updateLayer(layer.id, { visible: !layer.visible }); }}>{layer.visible ? "◉" : "○"}</button>
            <input value={layer.name} disabled={readOnly} aria-label="레이어 이름" onChange={(event) => updateLayer(layer.id, { name: event.target.value })} />
            <button type="button" disabled={readOnly} aria-label={layer.locked ? "레이어 잠금 해제" : "레이어 잠금"} onClick={(event) => { event.stopPropagation(); updateLayer(layer.id, { locked: !layer.locked }); }}>{layer.locked ? "▣" : "▢"}</button>
            <input type="range" disabled={readOnly} aria-label="레이어 불투명도" min="0" max="1" step="0.01" value={layer.opacity} onChange={(event) => updateLayer(layer.id, { opacity: Number(event.target.value) })} />
            <select aria-label="레이어 혼합 모드" disabled={readOnly} value={layer.blendMode} onChange={(event) => updateLayer(layer.id, { blendMode: event.target.value as BlendMode })}>{["normal", "multiply", "screen", "overlay", "add"].map((mode) => <option value={mode} key={mode}>{mode}</option>)}</select>
          </div>)}</div>
        </section>
        <section className="palette-panel">
          <div className="panel-title"><span>팔레트</span><b>{project.document.palette.length}/256</b></div>
          <div className="palette-mode"><select aria-label="색상 모드" disabled={readOnly} value={project.document.colorMode} onChange={(event) => changeColorMode(event.target.value as "rgba" | "indexed")}><option value="rgba">RGBA</option><option value="indexed">인덱스</option></select><button type="button" disabled={readOnly} onClick={() => image && applyBuffer(replaceColor(image, secondaryColor, color, selection).data)}>배경색→전경색</button></div>
          <div className="palette-grid">{project.document.palette.map((entry) => <button type="button" key={entry.id} disabled={readOnly} title={entry.name} aria-label={`${entry.name} 선택`} className={sameColor(entry.color, color) ? "selected" : ""} style={{ background: `rgba(${entry.color.join(",")})` }} onClick={() => setColor(entry.color)} />)}<button className="add-color" type="button" disabled={readOnly} aria-label="현재 색상을 팔레트에 추가" onClick={addPaletteColor}>＋</button><button className="add-color" type="button" disabled={readOnly} aria-label="현재 색상을 팔레트에서 제거" onClick={removeCurrentPaletteColor}>−</button></div>
        </section>
      </aside>
    </section>

    <section className="timeline editor-timeline" aria-label="애니메이션 타임라인">
      <div className="timeline-head"><span>타임라인</span><b>{project.document.frames.length} 프레임</b><small>{saveState}</small><div><button type="button" disabled={readOnly} onClick={() => replace((document) => addFrame(document, frame.id))}>＋</button><button type="button" disabled={readOnly} onClick={() => { const next = duplicateFrame(project.document, frame.id); replace(() => next); onFrameIndex(frameIndex + 1); }}>복제</button><button type="button" disabled={readOnly} onClick={() => { if (project.document.frames.length < 2) return; const nextIndex = Math.min(frameIndex, project.document.frames.length - 2); replace((document) => deleteFrame(document, frame.id)); onFrameIndex(nextIndex); }}>삭제</button></div></div>
      <div className="frames">{project.document.frames.map((item, index) => <div className={`frame-card ${index === frameIndex ? "selected" : ""}`} key={item.id}>
        <button className="frame-image" type="button" disabled={readOnly} aria-label={`${index + 1}번 프레임 선택`} onClick={() => onFrameIndex(index)}><FrameCanvas project={project} index={index} /></button>
        <button className="frame-label" type="button" disabled={readOnly} onClick={() => onFrameIndex(index)}>F{String(index + 1).padStart(2, "0")}</button><input aria-label={`${index + 1}번 프레임 시간`} disabled={readOnly} type="number" min="1" max="60000" value={item.durationMs} onChange={(event) => replace((document) => setFrameDuration(document, item.id, Number(event.target.value)))} />
        <i><button type="button" disabled={readOnly} aria-label="프레임 왼쪽 이동" onClick={() => reorderFrame(item.id, index - 1)}>←</button><button type="button" disabled={readOnly} aria-label="프레임 오른쪽 이동" onClick={() => reorderFrame(item.id, index + 1)}>→</button></i>
      </div>)}</div>
      <div className="tag-editor"><span>태그</span><input aria-label="태그 이름" disabled={readOnly} placeholder="예: attack" value={tagName} onChange={(event) => setTagName(event.target.value)} /><select aria-label="태그 재생 방향" disabled={readOnly} value={tagDirection} onChange={(event) => setTagDirection(event.target.value as typeof tagDirection)}><option value="forward">정방향</option><option value="reverse">역방향</option><option value="pingPong">핑퐁</option></select><button type="button" disabled={readOnly} onClick={addAnimationTag}>전체 구간 추가</button>{project.document.tags.map((tag) => <button type="button" className="tag-chip" disabled={readOnly} key={tag.id} onClick={() => replace((document) => deleteTag(document, tag.id))}>{tag.name} ×</button>)}</div>
    </section>
    {resizeOpen && <ResizeDialog initialWidth={project.document.width} initialHeight={project.document.height} onClose={() => setResizeOpen(false)} onApply={applyResize} />}
  </>;
});
