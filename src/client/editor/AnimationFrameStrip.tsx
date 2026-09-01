import { useEffect, useRef } from "react";
import { compositeFrame } from "../../core/render.ts";
import type { SpriteDocument } from "../../core/types.ts";

export type AnimationFrameStripProps = {
  document: SpriteDocument;
  frameIds: readonly string[];
  activeFrameId: string | null;
  disabled: boolean;
  onActivate(frameId: string): void;
};

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

export function AnimationFrameStrip({ document, frameIds, activeFrameId, disabled, onActivate }: AnimationFrameStripProps) {
  return <div className="animation-frame-strip">
    {frameIds.map((frameId, index) => {
      const frame = document.frames.find((candidate) => candidate.id === frameId);
      if (!frame) return null;
      const active = frameId === activeFrameId;
      return <button
        className="animation-frame-card"
        type="button"
        disabled={disabled}
        aria-label={`${index + 1}번 프레임 선택`}
        aria-current={active ? "true" : undefined}
        key={frameId}
        onClick={() => onActivate(frameId)}
      >
        <FrameThumbnail document={document} frameId={frameId} />
        <span>F{String(index + 1).padStart(2, "0")}</span>
        <small>{frame.durationMs}ms</small>
        {active && <em className="visually-hidden">현재 편집 프레임</em>}
      </button>;
    })}
  </div>;
}
