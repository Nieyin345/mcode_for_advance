import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type PointerEvent, type ReactNode } from "react";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { DndContext, PointerSensor, useDraggable, useSensor, useSensors, type DragEndEvent, type DragMoveEvent } from "@dnd-kit/core";
import { cn } from "@renderer/lib/cn.js";
import { Divider } from "./Divider.js";
import { ModuleViewDock } from "@renderer/components/modules/ModuleContributions.js";
import { shouldMountRightPane } from "./rightPaneKeepAlive.js";
import { dockFlexOrder, PANE_DOCK_MIME, RIGHT_PANE_DRAG_ID, type PaneDock } from "./paneDock.js";
import type { ShellVariant } from "../shell/shellPrefs.js";
import { computeSplitDrag, dockSideAtRect, DEFAULT_PANE_LAYOUT, SPLIT_SNAP_RATIO, type DockSide, type PaneId, type PaneLayout } from "./paneLayout.js";

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
  paneLayout?: PaneLayout;
  onMovePane?: (id: PaneId, side: DockSide, order: number) => void;
  onChangeRightOpen?: (open: boolean) => void;
  /** Bottom-bar terminal node (keep-alive: always mounted). */
  bottomTerminal?: ReactNode;
  /**
   * 【T119】右栏的承载方式。
   *
   * - `"pane"`（默认）：右栏是 flex 里的第三栏 —— 今天的全部行为，`order` 排序、
   *   拖拽停靠、50/50 吸附、宽屏百分比都走这条。
   * - `"drawer"`：右栏**离开 flex 流**，绝对定位贴在右边、浮在对话区之上；
   *   对话区按抽屉宽度**收窄**（`marginRight`），所以**不遮住对话** ——
   *   用户要的是「对话和文件同时看得见」，不是浮层挡住一半。
   *
   * ⚠️ **两种模式下右栏都保持挂载**（`rightEverMounted` 的语义不变）。
   * 卸载会拆掉 `RightPanel` 里的文件树 / Git 扫描状态，而那条规则是
   * `rightPaneKeepAlive.ts` 的核心；drawer 只是换定位，不是换生命周期。
   *
   * ⚠️ drawer 模式下**停靠拖拽不参与**（`order` / `rightDock` / 50/50 吸附都只对
   * pane 有意义）。那套逻辑仍在，见下面的 `isDrawer` 分支。
   */
  rightSurface?: "pane" | "drawer";
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
  /** 【T02】双击 50/50 吸附用：直接设目标像素宽。不传则退化为 delta 路径。 */
  onSetRightWidth?: (px: number) => void;
  /** T23: update placement size live, persist the final release via the existing queue. */
  onSetPaneRightSizePct?: (pct: number, containerWidth: number, persist: boolean) => void;
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
/** Separate dnd-kit grip preserves the existing native drag/keyboard handle. */
function PaneDndHandle({ onStart }: { onStart: (x: number, y: number) => void }) {
  const { t } = useI18n();
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({ id: "mcode-pane-right" });
  return <button ref={setNodeRef} type="button" data-testid="pane-dnd-handle"
    aria-label={t("layout.movePane")} title={t("layout.movePane")}
    {...attributes} {...listeners}
    onPointerDownCapture={(e) => { if (e.button === 0) onStart(e.clientX, e.clientY); }}
    className="absolute right-1 top-9 z-30 h-5 w-5 cursor-grab rounded text-content-muted hover:bg-surface-hover"
    style={{ opacity: isDragging ? 0.5 : 1 }}>⋮</button>;
}

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
  paneLayout = DEFAULT_PANE_LAYOUT,
  onMovePane,
  onChangeRightOpen,
  bottomTerminal,
  bottomTerminalOpen = false,
  rightSurface = "pane",
  leftWidth,
  rightWidth,
  rightWidthPct,
  bottomTerminalHeight,
  onResizeLeft,
  onResizeRight,
  onSetRightWidth,
  onSetPaneRightSizePct,
  onResizeBottomTerminal,
  onResetLeft,
  onResetRight,
  onResetBottomTerminal,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const dndOrigin = useRef({ x: 0, y: 0 });
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const rightPlacement = paneLayout.placements.find(p => p.id === "right");
  const rightAtBottom = rightPlacement?.side === "bottom";
  const bottomShare = rightPlacement?.sizePct ?? 30;
  // Keep live drag previews local; Escape cancels without persisting a write.
  const [splitPreview, setSplitPreview] = useState<number | null>(null);
  const [splitDragging, setSplitDragging] = useState(false);
  const [dndDragging, setDndDragging] = useState(false);
  const paneDragging = splitDragging || dndDragging;
  const splitRef = useRef<{ id: number; x: number; width: number; startRatio: number } | null>(null);
  const splitRightPct = (ratio: number) => 100 * (rightDock === "left" ? ratio : 1 - ratio);
  const restoreSplit = () => {
    const current = splitRef.current;
    if (current) onSetPaneRightSizePct?.(splitRightPct(current.startRatio), current.width, false);
    splitRef.current = null;
    setSplitDragging(false);
    setSplitPreview(null);
  };
  // Pointer geometry is owned by Divider's capture; the parent only translates
  // its pointer stream into a continuously updated, versioned placement.
  const resizeSplitWithDivider = (delta: number) => {
    if (splitRef.current) return; // root capture handles the current pointer
    if (onSetPaneRightSizePct) {
      const width = rootRef.current?.getBoundingClientRect().width ?? 0;
      if (width <= 0) return;
      const start = rightDock === "left" ? (rightPlacement?.sizePct ?? 30) / 100
        : 1 - (rightPlacement?.sizePct ?? 30) / 100;
      const result = computeSplitDrag(start, delta, width);
      if (result.moved) {
        onSetPaneRightSizePct(splitRightPct(result.ratio), width, true);
        if (result.collapsed === rightDock) onChangeRightOpen?.(false);
      }
      return;
    }
    onResizeRight?.(delta);
  };
  const applySplit = (e: PointerEvent<HTMLDivElement>) => {
    const current = splitRef.current;
    if (!current || e.pointerId !== current.id) return;
    const computed = computeSplitDrag(current.startRatio, e.clientX - current.x, current.width);
    if (!computed.moved) return;
    setSplitPreview(current.width * (rightDock === "left" ? computed.ratio : 1 - computed.ratio));
    onSetPaneRightSizePct?.(splitRightPct(computed.ratio), current.width, false);
  };
  const endSplit = (e: PointerEvent<HTMLDivElement>) => {
    const current = splitRef.current;
    if (!current || current.id !== e.pointerId) return;
    splitRef.current = null;
    setSplitDragging(false);
    setSplitPreview(null);
    const computed = computeSplitDrag(current.startRatio, e.clientX - current.x, current.width);
    if (computed.moved) {
      if (onSetPaneRightSizePct) {
        onSetPaneRightSizePct(splitRightPct(computed.ratio), current.width, true);
        if (computed.collapsed === rightDock) onChangeRightOpen?.(false);
      } else {
        if (computed.collapsed === rightDock) onChangeRightOpen?.(false);
        else {
          const initial = current.width * (rightDock === "left" ? current.startRatio : 1-current.startRatio);
          const final = current.width * (rightDock === "left" ? computed.ratio : 1-computed.ratio);
          onResizeRight?.(rightDock === "left" ? final - initial : initial - final);
        }
      }
    }
  };
  useEffect(() => {
    const cancel = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !splitRef.current) return;
      e.preventDefault();
      restoreSplit();
    };
    const blur = () => { restoreSplit(); };
    window.addEventListener("keydown", cancel);
    window.addEventListener("blur", blur);
    return () => { window.removeEventListener("keydown", cancel); window.removeEventListener("blur", blur); };
  }, [rightDock, onSetPaneRightSizePct]);
  const onDockMove = (event: DragMoveEvent) => {
    const b = rootRef.current?.getBoundingClientRect();
    if (b) setDockPreview(dockSideAtRect(dndOrigin.current.x + event.delta.x,
      dndOrigin.current.y + event.delta.y, b.left, b.top, b.width, b.height));
  };
  const onDockEnd = (event: DragEndEvent) => {
    const b = rootRef.current?.getBoundingClientRect();
    if (b && onMovePane) {
      const side = dockSideAtRect(dndOrigin.current.x + event.delta.x,
        dndOrigin.current.y + event.delta.y, b.left, b.top, b.width, b.height);
      if (side) onMovePane("right", side, 0);
    }
    setDockPreview(null);
    setDndDragging(false);
  };
  // Avoid mounting expensive right-panel contents before the user first opens
  // that pane. Thereafter retain the SAME React identity when it is collapsed.
  const [hasOpenedRight, setHasOpenedRight] = useState(rightOpen);
  useEffect(() => {
    if (rightOpen) setHasOpenedRight(true);
  }, [rightOpen]);
  const rightEverMounted = shouldMountRightPane(rightOpen, hasOpenedRight);
  /* 【T119】drawer 模式：右栏离开 flex 流，对话区按它的宽度收窄。
   *
   * 为什么收窄而不是纯浮层：用户要「对话和文件同时看得见」。纯 overlay 会把
   * 对话右半边压在下面 —— 那正是他抱怨的「只能中间显示」换了个形式。
   *
   * 宽度封顶 30%：抽屉是辅助视图，不该把主对话挤到读不了。pane 模式下用户
   * 可以拖到 50%（宽屏模式），那是「专注看文件」的主动选择；drawer 是常驻的
   * 辅助位，30% 是它的默认上限。
   */
  const isDrawer = rightSurface === "drawer";
  const drawerOpenWidth = rightWidthPct !== undefined
    ? `min(${rightWidthPct}%, 30%)`
    : `min(${rightWidth ?? 360}px, 30%)`;
  // Reordering stable flex children avoids remounting Chromium/Monaco/PTY.
  const order = dockFlexOrder(rightDock);
  const [dockPreview, setDockPreview] = useState<DockSide | null>(null);
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
    // drawer 模式没有停靠语义（位置固定在右侧），拖拽停靠的预览与落点都不生效。
    if (rightSurface === "drawer") return;
    if (!rightOpen || (!onChangeRightDock && !onMovePane) ||
        !Array.from(e.dataTransfer.types).includes(PANE_DOCK_MIME)) return;
    const bounds = e.currentTarget.getBoundingClientRect();
    const side = dockSideAtRect(e.clientX, e.clientY, bounds.left, bounds.top, bounds.width, bounds.height);
    if (!side) return;
    e.preventDefault();
    // This is an internal pane drag: consume it before nested chat/editor
    // file-drop handlers can interpret it as a user attachment.
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    setDockPreview((prior) => prior === side ? prior : side);
  };
  const handleDockDrop = (e: DragEvent<HTMLElement>) => {
    if (!rightOpen || (!onChangeRightDock && !onMovePane) ||
        e.dataTransfer.getData(PANE_DOCK_MIME) !== RIGHT_PANE_DRAG_ID) return;
    const bounds = e.currentTarget.getBoundingClientRect();
    const side = dockSideAtRect(e.clientX, e.clientY, bounds.left, bounds.top, bounds.width, bounds.height);
    if (side) {
      e.preventDefault();
      e.stopPropagation();
      if (side === "bottom") onMovePane?.("right", "bottom", 0);
      else if (onChangeRightDock) onChangeRightDock(side);
      else onMovePane?.("right", side, 0);
    }
    setDockPreview(null);
  };
  return (
    <DndContext sensors={sensors} onDragStart={() => setDndDragging(true)} onDragMove={onDockMove} onDragEnd={onDockEnd}
      onDragCancel={() => { setDockPreview(null); setDndDragging(false); }}>
      <div ref={rootRef}
        data-pane-dragging={paneDragging ? "true" : undefined}
        className="relative flex h-full min-h-0 min-w-0 flex-1 flex-wrap"
        style={{ "--pane-bottom-share": `${bottomShare}%` } as CSSProperties}
        onDoubleClickCapture={(e) => {
          if (!(e.target as HTMLElement).closest('[data-divider="vertical"]') || !onResizeRight) return;
          const width = e.currentTarget.getBoundingClientRect().width;
          if (width <= 0) return;
          const target = width * (1 - SPLIT_SNAP_RATIO);
          e.preventDefault(); e.stopPropagation();
          // 【T02】直接设目标宽度，不走 delta：
          // delta 会经 `dockResizeDelta` 与 `adjustRightWidth` 内部各取反一次，
          // 在 rightDock === "left" 时两次抵消错位，吸附落点就不是 50%。
          if (onSetRightWidth) { onSetRightWidth(target); onSetPaneRightSizePct?.(50, width, true); return; }
          const current = rightWidthPct === undefined ? (rightWidth ?? 360) : width * rightWidthPct / 100;
          onResizeRight(rightDock === "left" ? target - current : current - target);
        }}
        onPointerDownCapture={(e) => {
          if (!rightOpen || rightAtBottom || !onResizeRight || !e.isPrimary || e.button !== 0 || e.detail > 1) return;
          const dividers = Array.from(e.currentTarget.querySelectorAll('[data-divider="vertical"]'));
          const target = (e.target as HTMLElement).closest('[data-divider="vertical"]');
          if (!target || target !== dividers[dividers.length - 1]) return;
          const b = e.currentTarget.getBoundingClientRect();
          if (b.width <= 0) return;
          const size = rightWidthPct === undefined ? (rightWidth ?? 360) : b.width * rightWidthPct / 100;
          splitRef.current = { id: e.pointerId, x: e.clientX, width: b.width,
            startRatio: rightDock === "left" ? size / b.width : 1 - size / b.width };
          setSplitDragging(true);
          // Divider captures its own pointer. Do not stop propagation or
          // steal capture from its keyboard/IME-safe interaction owner.
        }}
        onPointerMoveCapture={applySplit}
        onPointerUpCapture={endSplit}
        onPointerCancelCapture={(e) => {
          if (splitRef.current?.id === e.pointerId) restoreSplit();
        }}>
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
        rightAtBottom ? "h-[calc(100%-var(--pane-bottom-share))]" : "h-full",
        variant === "workspace"
          ? (rightDock === "left" ? "rounded-tr-[10px] rounded-br-[10px]" : "rounded-tl-[10px] rounded-bl-[10px]")
          : (rightDock === "left" ? "rounded-tr-3xl rounded-br-3xl" : "rounded-tl-3xl rounded-bl-3xl"),
      )} data-cds-center="" style={{ order: order.center }} onDragOverCapture={handleDockDragOver}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDockPreview(null); }}
        onDropCapture={handleDockDrop}>
        {dockPreview && (
          <div data-testid="pane-dock-preview" data-dock-preview={dockPreview} aria-hidden="true"
            className={cn(
              "pointer-events-none absolute z-50 border-2 border-dashed border-accent bg-accent/10",
              dockPreview === "bottom" ? "bottom-0 h-1/3 w-full" :
                dockPreview === "left" ? "inset-y-0 left-0 w-1/2" : "inset-y-0 right-0 w-1/2",
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
        {bottomTerminal && <div className="max-h-[30vh] shrink-0 overflow-y-auto empty:hidden"><ModuleViewDock location="bottom" /></div>}
      </main>

      {toolbar && <div data-pane-toolbar="" className={cn("flex shrink-0", rightAtBottom ? "h-[calc(100%-var(--pane-bottom-share))]" : "h-full")} style={{ order: order.toolbar }}>{toolbar}</div>}

      {/* 【T119】drawer 模式下不渲染分隔条：抽屉宽度封顶 30%、位置固定在右侧，
          没有可拖的边界。宽度仍可由 store 改（例如后续给一个预设按钮），
          但那不该伪装成一条可拖的分割线。 */}
      {rightOpen && onResizeRight && !rightAtBottom && !isDrawer && (
        <Divider
          orientation="vertical"
          className={rightDock === "left" ? "order-3" : "order-4"}
          onResize={resizeSplitWithDivider}
          onDoubleClick={() => {
            const width = rootRef.current?.getBoundingClientRect().width ?? 0;
            if (width > 0) {
              const current = rightWidthPct === undefined ? (rightWidth ?? 360) : width * rightWidthPct / 100;
              const target = width * (1 - SPLIT_SNAP_RATIO);
              if (onSetRightWidth) { onSetRightWidth(target); onSetPaneRightSizePct?.(50, width, true); }
              else onResizeRight(rightDock === "left" ? target - current : current - target);
            } else onResetRight?.();
          }}
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
          data-right-surface={rightSurface}
          className="flex h-full min-w-0 shrink-0 flex-col overflow-hidden border-t border-edge-panel bg-surface"
          aria-hidden={!rightOpen}
          inert={!rightOpen}
          style={isDrawer ? {
            /* 【T119/T137】drawer：**仍留在 flex 流里**（不是 absolute 浮层）——
               两栏并排，谁也不遮谁。与 pane 的差别：
                 ① `order` **必须给**，而且必须是固定值（见下）；
                 ② 宽度封顶 30%（辅助视图不挤压主对话）；
                 ③ 不受停靠/宽屏的百分比（那些是 pane 的专注模式）。
                 ④ 不参与右侧停靠切换（贴右是它唯一的位置）。

               ⚠️ **`order` 不能省。** 早先这里没有 `order`，注释写的是「固定贴右，
               不参与 DOM 顺序重排」——那个假设是「DOM 顺序本来就是 center 在前」。
               但 center 带 `order: order.center`（= 2），而本 aside 的 order 是默认 0，
               左栏的 order 也是默认 0。于是同为 0 的左栏与右栏按 DOM 顺序排在
               center **之前**，实际渲染成 [左栏][右栏][对话区] —— 抽屉跑到了左边。

               固定为 5：与 pane 模式 `dock === "right"` 时 `order.aside` 的取值一致，
               所以两种模式下右栏都在同一侧；而不随 `rightDock` 变，满足「不参与停靠」。 */
            position: "relative",
            order: 5,
            maxWidth: "30%",
            width: drawerOpenWidth,
            display: rightOpen ? "flex" : "none",
          } : {
            position: "relative",
            order: order.aside,
            // Preserve the stored width across window shrink/restore,
            // but keep the center usable on a very narrow viewport. Include
            // the adjacent toolbar/drag handle in the remaining-width budget.
            maxWidth: "calc(80% - 48px)",
            ...(rightPlacement?.sizePct === 100 ? { maxWidth: "calc(100% - 48px)" } : {}),
            width: splitPreview ?? (rightWidthPct !== undefined ? `${rightWidthPct}%` : rightWidth),
            ...(rightAtBottom ? { width: "100%", maxWidth: "100%", height: `${bottomShare}%`, flexBasis: "100%" } : {}),
            display: rightOpen ? "flex" : "none",
          }}
        >
          {/* drawer 里不给停靠手柄：拖拽换边是 pane 的能力，抽屉只有贴右一种位置。 */}
          {!isDrawer && <PaneDndHandle onStart={(x, y) => { dndOrigin.current = { x, y }; }} />}
          <div className={cn("min-h-0 flex-1 overflow-hidden border-edge-panel/60",
            isDrawer ? "border-l" : (rightDock === "left" ? "border-r" : "border-l"))}
            style={paneDragging ? { pointerEvents: "none" } : undefined}>{right}</div>
          {paneDragging && <div data-pane-iframe-shield="" className="pointer-events-none absolute inset-0 z-50 bg-transparent" aria-hidden="true" />}
        </aside>
      )}
      {paneDragging && <div data-pane-drag-shield="" className="pointer-events-none absolute inset-0 z-40" aria-hidden="true" />}
      </div>
    </DndContext>
  );
}
