import { useEffect, useState, type DragEvent, type ReactNode } from "react";
import { cn } from "@renderer/lib/cn.js";
import { Divider } from "./Divider.js";
import { shouldMountRightPane } from "./rightPaneKeepAlive.js";
import { dockFlexOrder, dockSideAtPoint, PANE_DOCK_MIME, RIGHT_PANE_DRAG_ID, type PaneDock } from "./paneDock.js";
import type { ShellVariant } from "../shell/shellPrefs.js";

interface Props {
  /** ARC-005: 只影响几何 class，不切换主区组件身份（PTY/编辑器需保活）。 */
  variant?: ShellVariant;
  left: ReactNode;
  center: ReactNode;
  right: ReactNode;
  /** 主区与右栏之间的一列(自定义 UI 的竖向工具栏)。排在右栏**左边**:右栏收起时
   *  右栏整个不渲染,它就自然贴到最右边。它自己的收起/展开由它自己管。 */
  toolbar?: ReactNode;
  leftOpen: boolean;
  rightOpen: boolean;
  rightDock?: PaneDock;
  onChangeRightDock?: (side: PaneDock) => void;
  /** Bottom-bar terminal node (keep-alive: always mounted). */
  bottomTerminal?: ReactNode;
  /** Whether the bottom terminal bar is expanded. When false the bar collapses
   *  to height 0 but stays mounted so PTYs survive — see App.tsx. */
  bottomTerminalOpen?: boolean;
  /** Draggable pane sizes (px) + incremental resize callbacks. Widths come
   *  from the store so they persist; the Divider reports a signed px delta on
   *  each mousemove and the store action clamps + debounces the DB write.
   *  Optional — SettingsPage reuses this shell without drag handles. */
  leftWidth?: number;
  rightWidth?: number;
  /** Wide-panel mode: the right panel's share as a percentage of the layout
   *  row. When set it overrides rightWidth — wide mode keeps the SAME
   *  RightPanel instance in this aside (no unmount/remount) and only
   *  re-shapes it; the onResize/onReset callbacks switch to the wide split's
   *  percentage-based handlers. */
  rightWidthPct?: number;
  bottomTerminalHeight?: number;
  onResizeLeft?: (deltaPx: number) => void;
  onResizeRight?: (deltaPx: number) => void;
  onResizeBottomTerminal?: (deltaPx: number) => void;
  onResetLeft?: () => void;
  onResetRight?: () => void;
  onResetBottomTerminal?: () => void;
}

/** Resizable three-pane shell: left | center | right, with a collapsible
 * bottom terminal bar inside the center pane.
 *
 * Each side pane and the bottom bar have a draggable Divider handle. The
 * widths/height are driven by store state (persisted); the Divider reports
 * an incremental px delta that the store action applies + clamps.
 *
 * The right pane lazily mounts once and stays mounted across collapse/restore
 * so custom panels preserve local state. Its divider only renders while open.
 * The bottom terminal uses keep-alive
 * (always mounted, height collapses to 0) — its divider renders only while
 * expanded.
 *
 * overflow-hidden is preserved on xterm ancestors (FitAddon breaks under a
 * scrolling ancestor) — do not change those to overflow-y-auto. */
export function ThreePaneLayout({
  variant = "classic",
  left,
  center,
  right,
  toolbar,
  leftOpen,
  rightOpen,
  rightDock = "right",
  onChangeRightDock,
  bottomTerminal,
  bottomTerminalOpen = false,
  leftWidth,
  rightWidth,
  rightWidthPct,
  bottomTerminalHeight,
  onResizeLeft,
  onResizeRight,
  onResizeBottomTerminal,
  onResetLeft,
  onResetRight,
  onResetBottomTerminal,
}: Props) {
  // Avoid mounting expensive right-panel contents before the user first opens
  // that pane. Thereafter retain the SAME React identity when it is collapsed.
  const [hasOpenedRight, setHasOpenedRight] = useState(rightOpen);
  useEffect(() => {
    if (rightOpen) setHasOpenedRight(true);
  }, [rightOpen]);
  const rightEverMounted = shouldMountRightPane(rightOpen, hasOpenedRight);
  // Reordering stable flex children avoids remounting Chromium/Monaco/PTY.
  const order = dockFlexOrder(rightDock);
  const [dockPreview, setDockPreview] = useState<PaneDock | null>(null);
  // Closing or moving the panel invalidates any outstanding HTML5 drag hover.
  // A lost dragend (e.g. over native WebContentsView) must not strand its ghost.
  useEffect(() => {
    setDockPreview(null);
  }, [rightOpen, rightDock]);
  useEffect(() => {
    const clearPreview = () => setDockPreview(null);
    window.addEventListener("dragend", clearPreview);
    window.addEventListener("drop", clearPreview);
    return () => {
      window.removeEventListener("dragend", clearPreview);
      window.removeEventListener("drop", clearPreview);
    };
  }, []);
  const handleDockDragOver = (e: DragEvent<HTMLElement>) => {
    if (!rightOpen || !onChangeRightDock ||
        !Array.from(e.dataTransfer.types).includes(PANE_DOCK_MIME)) return;
    const bounds = e.currentTarget.getBoundingClientRect();
    const side = dockSideAtPoint(e.clientX, bounds.left, bounds.width);
    if (!side) return;
    e.preventDefault();
    // This is an internal pane drag: consume it before nested chat/editor
    // file-drop handlers can interpret it as a user attachment.
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    setDockPreview((prior) => prior === side ? prior : side);
  };
  const handleDockDrop = (e: DragEvent<HTMLElement>) => {
    if (!rightOpen || !onChangeRightDock ||
        e.dataTransfer.getData(PANE_DOCK_MIME) !== RIGHT_PANE_DRAG_ID) return;
    const bounds = e.currentTarget.getBoundingClientRect();
    const side = dockSideAtPoint(e.clientX, bounds.left, bounds.width);
    if (side) {
      e.preventDefault();
      e.stopPropagation();
      onChangeRightDock(side);
    }
    setDockPreview(null);
  };
  return (
    <>
      {/* Left sidebar — only used by the settings page since the workspace
         moved its full-height sidebar up to App.tsx. Square corners (no
         arcs). bg-surface-muted matches the settings overlay backdrop so the
         nav reads as one continuous block. Its hover/active states use the
         surface-hover family (see LeftBar.tsx), which is clearly visible on
         this muted base. */}
      {leftOpen && (
        <aside
          className="flex h-full shrink-0 flex-col bg-surface-muted"
          style={{ width: leftWidth }}
        >
          <div className="min-h-0 flex-1 overflow-y-auto">{left}</div>
        </aside>
      )}
      {leftOpen && onResizeLeft && (
        <Divider
          orientation="vertical"
          onResize={onResizeLeft}
          onDoubleClick={onResetLeft}
        />
      )}

      {/* Center pane — classic 24px / workspace 10px arcs on the LEFT edge only (top-left at the
         toolbar/sidebar junction, bottom-left at the track below): the muted
         frame shows through both notches against the pane's bg-surface, so
         the arcs read cleanly. overflow-hidden clips the CONTENT to the same
         rounded rect — without it, square children painted into the notches
         (e.g. the session-tabs strip's translucent bg-surface/40 + its
         border-b, or the bottom-terminal bar) read as a faint square corner
         behind the arc. Non-scrolling overflow-hidden is xterm-safe (see the
         note on the right sidebar).
         Stacks the center content above an optional bottom terminal bar. */}
      <main className={cn(
        "relative z-10 flex min-w-0 flex-1 flex-col overflow-hidden border-t border-edge-panel bg-surface",
        variant === "workspace"
          ? (rightDock === "left" ? "rounded-tr-[10px] rounded-br-[10px]" : "rounded-tl-[10px] rounded-bl-[10px]")
          : (rightDock === "left" ? "rounded-tr-3xl rounded-br-3xl" : "rounded-tl-3xl rounded-bl-3xl"),
      )} data-cds-center="" style={{ order: order.center }} onDragOverCapture={handleDockDragOver}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDockPreview(null); }}
        onDropCapture={handleDockDrop}>
        {dockPreview && (
          <div data-testid="pane-dock-preview" data-dock-preview={dockPreview} aria-hidden="true"
            className={cn(
              "pointer-events-none absolute inset-y-0 z-50 w-1/2 border-2 border-dashed border-accent bg-accent/10",
              dockPreview === "left" ? "left-0" : "right-0",
            )} />
        )}
        <div className="min-h-0 flex-1 overflow-hidden">{center}</div>
        {/* Bottom terminal bar — keep-alive: always rendered, height collapses
            to 0 when closed so PTYs/scrollback survive. overflow-hidden clips
            the xterm host at height 0 (xterm FitAddon breaks under a scrolling
            ancestor, but a fixed-height non-scrolling box is fine). */}
        {bottomTerminal && (
          <>
            {bottomTerminalOpen && onResizeBottomTerminal && (
              <Divider
                orientation="horizontal"
                onResize={onResizeBottomTerminal}
                onDoubleClick={onResetBottomTerminal}
              />
            )}
            <div
              className={cn(
                "shrink-0 overflow-hidden border-edge-panel transition-[height] duration-150 ease-out motion-reduce:transition-none",
                bottomTerminalOpen ? "border-t" : "h-0",
              )}
              style={bottomTerminalOpen ? { height: bottomTerminalHeight } : undefined}
              inert={!bottomTerminalOpen}
              aria-hidden={!bottomTerminalOpen}
            >
              {bottomTerminal}
            </div>
          </>
        )}
      </main>

      {toolbar && <div data-pane-toolbar="" className="flex h-full shrink-0" style={{ order: order.toolbar }}>{toolbar}</div>}

      {rightOpen && onResizeRight && (
        <Divider
          orientation="vertical"
          className={rightDock === "left" ? "order-3" : "order-4"}
          onResize={onResizeRight}
          onDoubleClick={onResetRight}
        />
      )}
      {/* Right sidebar — square corners (no arcs; the seam with the center
         pane stays a straight edge). Uses bg-surface (same as center pane) so
         it reads as a continuation of the chat area; the border-l below is
         the divider. overflow-hidden (not overflow-y-auto): Files/Git scroll
         internally, and xterm FitAddon breaks under a scrolling ancestor. */}
      {rightEverMounted && (
        <aside
          data-cds-aside=""
          className="flex h-full min-w-0 shrink-0 flex-col overflow-hidden border-t border-edge-panel bg-surface"
          aria-hidden={!rightOpen}
          inert={!rightOpen}
          style={{
            order: order.aside,
            // Preserve the stored width across window shrink/restore,
            // but keep the center usable on a very narrow viewport. Include
            // the adjacent toolbar/drag handle in the remaining-width budget.
            maxWidth: "calc(80% - 48px)",
            width: rightWidthPct !== undefined ? `${rightWidthPct}%` : rightWidth,
            display: rightOpen ? "flex" : "none",
          }}
        >
          <div className={cn("min-h-0 flex-1 overflow-hidden border-edge-panel/60", rightDock === "left" ? "border-r" : "border-l")}>{right}</div>
        </aside>
      )}
    </>
  );
}
