import { useRef } from "react";

type PaneResizerProps = {
  /** 拖的是哪条分界线 */
  side: "left" | "right";
  /** 当前宽度（px） */
  value: number;
  min: number;
  max: number;
  /** 拖动方向：左分界向右变宽(+1)，右分界向左变宽(-1) */
  direction: 1 | -1;
  onChange: (next: number) => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  disabled?: boolean;
};

/**
 * 两栏之间的可拖拽分界线。用 pointer events + setPointerCapture，
 * 鼠标移出手柄也不丢事件。视觉上是 <||> 抓手，hover/拖动时高亮。
 */
export function PaneResizer({
  side,
  value,
  min,
  max,
  direction,
  onChange,
  onDragStart,
  onDragEnd,
  disabled
}: PaneResizerProps) {
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  if (disabled) {
    return null;
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { startX: event.clientX, startWidth: value };
    document.body.classList.add("pane-resizing");
    onDragStart?.();
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag) {
      return;
    }
    const delta = (event.clientX - drag.startX) * direction;
    const next = Math.min(max, Math.max(min, Math.round(drag.startWidth + delta)));
    onChange(next);
  }

  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (!dragRef.current) {
      return;
    }
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    document.body.classList.remove("pane-resizing");
    onDragEnd?.();
  }

  return (
    <div
      className={`pane-resizer pane-resizer-${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={side === "left" ? "拖动调整左侧栏宽度" : "拖动调整右侧面板宽度"}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={disabled ? -1 : 0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
          return;
        }
        event.preventDefault();
        const step = event.shiftKey ? 40 : 16;
        const sign = event.key === "ArrowRight" ? 1 : -1;
        onChange(Math.min(max, Math.max(min, value + step * sign * direction)));
      }}
    >
      <span className="pane-resizer-grip" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    </div>
  );
}
