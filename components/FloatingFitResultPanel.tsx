"use client";

import { type PointerEvent, type ReactNode, type RefObject, useEffect, useRef } from "react";

type PanelPosition = { x: number; y: number };

type FloatingFitResultPanelProps = {
  containerRef: RefObject<HTMLDivElement | null>;
  position: PanelPosition;
  onPositionChange: (position: PanelPosition) => void;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  onClose: () => void;
  children: ReactNode;
};

export function FloatingFitResultPanel({
  containerRef,
  position,
  onPositionChange,
  collapsed,
  onCollapsedChange,
  onClose,
  children,
}: FloatingFitResultPanelProps) {
  const panelRef = useRef<HTMLElement>(null);
  const dragStartRef = useRef<{ pointerId: number; clientX: number; clientY: number; x: number; y: number } | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    const panel = panelRef.current;
    if (!container || !panel) return;

    const keepPanelInBounds = () => {
      const nextPosition = {
        x: Math.min(Math.max(0, position.x), Math.max(0, container.clientWidth - panel.offsetWidth)),
        y: Math.min(Math.max(0, position.y), Math.max(0, container.clientHeight - panel.offsetHeight)),
      };
      if (nextPosition.x !== position.x || nextPosition.y !== position.y) onPositionChange(nextPosition);
    };

    keepPanelInBounds();
    const observer = new ResizeObserver(keepPanelInBounds);
    observer.observe(container);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [containerRef, onPositionChange, position]);

  const movePanel = (clientX: number, clientY: number) => {
    const start = dragStartRef.current;
    const container = containerRef.current;
    const panel = panelRef.current;
    if (!start || !container || !panel) return;

    const maximumX = Math.max(0, container.clientWidth - panel.offsetWidth);
    const maximumY = Math.max(0, container.clientHeight - panel.offsetHeight);
    onPositionChange({
      x: Math.min(maximumX, Math.max(0, start.x + clientX - start.clientX)),
      y: Math.min(maximumY, Math.max(0, start.y + clientY - start.clientY)),
    });
  };

  const beginDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    event.preventDefault();
    event.stopPropagation();
    dragStartRef.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, ...position };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const continueDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (dragStartRef.current?.pointerId !== event.pointerId) return;
    event.preventDefault();
    movePanel(event.clientX, event.clientY);
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (dragStartRef.current?.pointerId !== event.pointerId) return;
    dragStartRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <aside
      ref={panelRef}
      className="absolute z-20 w-[min(17rem,calc(100%-1rem))] overflow-hidden rounded-lg border border-fuchsia-200/35 bg-slate-950/90 text-left shadow-lg shadow-black/35 backdrop-blur-sm"
      style={{ left: position.x, top: position.y }}
      aria-label="擬合結果浮動資訊框"
    >
      <div
        className="flex min-h-8 touch-none cursor-grab items-center justify-between gap-3 border-b border-slate-700/80 bg-slate-900/85 px-2.5 text-xs font-semibold text-fuchsia-100 active:cursor-grabbing"
        onPointerDown={beginDrag}
        onPointerMove={continueDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        title="拖曳移動擬合結果"
      >
        <span>擬合結果</span>
        <span className="flex items-center gap-1">
          <button
            type="button"
            aria-label={collapsed ? "展開擬合結果" : "收合擬合結果"}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onCollapsedChange(!collapsed)}
            className="grid h-6 w-6 place-items-center rounded text-sm leading-none text-slate-200 transition hover:bg-slate-700 hover:text-white"
          >
            {collapsed ? "+" : "−"}
          </button>
          <button
            type="button"
            aria-label="隱藏擬合結果"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={onClose}
            className="grid h-6 w-6 place-items-center rounded text-base leading-none text-slate-300 transition hover:bg-rose-400/20 hover:text-rose-100"
          >
            ×
          </button>
        </span>
      </div>
      {!collapsed && <div className="max-h-64 overflow-auto px-3 py-2.5 text-xs leading-5 text-slate-200">{children}</div>}
    </aside>
  );
}
