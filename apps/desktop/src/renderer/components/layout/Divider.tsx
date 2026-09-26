import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { COL_RESIZE_CURSOR, ROW_RESIZE_CURSOR } from "@renderer/lib/cursors.js";

export interface DividerProps {
  orientation: "vertical" | "horizontal";
  /** Incremental screen-space pixels. Caller owns sign, clamp and persisted size. */
  onResize: (deltaPx: number) => void;
  onDoubleClick?: () => void;
  lineAlign?: "start" | "center" | "end";
  hideLine?: boolean;
  className?: string;
}

/** One keyboard/pointer interaction owner, cleaned on every exit path.
 * Pointer capture keeps drags local even over iframes or outside the handle. */
export function Divider({ orientation, onResize, onDoubleClick, hideLine = false, className }: DividerProps) {
  const { t } = useI18n();
  const vertical = orientation === "vertical";
  const handle = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(50);
  useEffect(() => {
    const element = handle.current;
    const parent = element?.parentElement;
    if (!element || !parent) return;
    const measure = () => {
      const outer = parent.getBoundingClientRect(), own = element.getBoundingClientRect();
      const total = vertical ? outer.width : outer.height;
      if (total > 0) setPosition(Math.round(Math.max(0, Math.min(100, 100 * (vertical ? own.left - outer.left : own.top - outer.top) / total))));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    if (element.previousElementSibling) observer.observe(element.previousElementSibling);
    if (element.nextElementSibling) observer.observe(element.nextElementSibling);
    measure();
    return () => observer.disconnect();
  }, [vertical]);
  const resize = useRef(onResize);
  resize.current = onResize;
  const drag = useRef<{ id: number; previous: number; element: HTMLDivElement; cursor: string; select: string } | null>(null);
  const finish = useCallback(() => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    document.body.style.cursor = current.cursor;
    document.body.style.userSelect = current.select;
    if (current.element.hasPointerCapture(current.id)) current.element.releasePointerCapture(current.id);
  }, []);
  useEffect(() => {
    window.addEventListener("blur", finish);
    return () => { finish(); window.removeEventListener("blur", finish); };
  }, [finish]);

  return (
    <div
      ref={handle}
      role="separator"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={position}
      aria-label={t(vertical ? "common.resizeColumns" : "common.resizeRows")}
      aria-orientation={vertical ? "vertical" : "horizontal"}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing || e.altKey || e.ctrlKey || e.metaKey) return;
        const negative = vertical ? "ArrowLeft" : "ArrowUp";
        const positive = vertical ? "ArrowRight" : "ArrowDown";
        if (e.key === negative || e.key === positive) {
          e.preventDefault(); e.stopPropagation();
          onResize((e.key === positive ? 1 : -1) * (e.shiftKey ? 40 : 10));
        } else if ((e.key === "Enter" || e.key === "Home") && onDoubleClick) {
          e.preventDefault(); onDoubleClick();
        } else if (e.key === "Escape") finish();
      }}
      className={cn("group/divider relative z-10 shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-accent-strong", vertical ? "w-px" : "h-px", className)}
    >
      <div
        onPointerDown={(e) => {
          if (!e.isPrimary || e.button !== 0) return;
          e.preventDefault(); finish();
          e.currentTarget.parentElement?.focus();
          drag.current = { id: e.pointerId, previous: vertical ? e.clientX : e.clientY, element: e.currentTarget, cursor: document.body.style.cursor, select: document.body.style.userSelect };
          e.currentTarget.setPointerCapture(e.pointerId);
          document.body.style.cursor = vertical ? COL_RESIZE_CURSOR : ROW_RESIZE_CURSOR;
          document.body.style.userSelect = "none";
        }}
        onPointerMove={(e) => {
          const current = drag.current;
          if (!current || current.id !== e.pointerId) return;
          const position = vertical ? e.clientX : e.clientY;
          const delta = position - current.previous;
          current.previous = position;
          if (delta) resize.current(delta);
        }}
        onPointerUp={finish}
        onPointerCancel={finish}
        onLostPointerCapture={finish}
        onDoubleClick={onDoubleClick}
        style={{ cursor: vertical ? COL_RESIZE_CURSOR : ROW_RESIZE_CURSOR, touchAction: "none" }}
        className={cn("absolute z-0", vertical ? "inset-y-0 -left-[5px] -right-[5px]" : "inset-x-0 -top-[5px] -bottom-[5px]")}
      />
      {!hideLine && <div className={cn("pointer-events-none absolute inset-0 bg-edge-panel transition-colors group-hover/divider:bg-accent/50 group-active/divider:bg-accent/70", vertical ? "w-px left-0" : "h-px top-0")} />}
    </div>
  );
}
