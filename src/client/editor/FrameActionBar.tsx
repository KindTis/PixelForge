export type FrameActionBarProps = {
  selectedCount: number;
  hasTransferTarget: boolean;
  disabled: boolean;
  onCreate(): void;
  onCopy(): void;
  onMove(): void;
};

export function FrameActionBar({ selectedCount, hasTransferTarget, disabled, onCreate, onCopy, onMove }: FrameActionBarProps) {
  const hasSelection = selectedCount > 0;
  const transferDisabled = disabled || !hasSelection || !hasTransferTarget;
  return <div className="frame-action-bar">
    <span>{hasSelection ? `${selectedCount}개 프레임 선택` : "선택된 프레임 없음"}</span>
    <button type="button" disabled={disabled || !hasSelection} onClick={onCreate}>새 세트로 등록</button>
    <button type="button" disabled={transferDisabled} onClick={onCopy}>복제하여 보내기</button>
    <button type="button" disabled={transferDisabled} onClick={onMove}>이동</button>
    {hasSelection && !hasTransferTarget && <small>먼저 다른 세트를 만드세요</small>}
  </div>;
}
