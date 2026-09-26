/**
 * 工作流画布 —— 中栏那张可以拖动节点、也可以拉线连接的图。
 *
 * ## 布局归谁:坐标是真相,分层只是"整理"
 *
 * 节点的 `position` 是**真相**,拖动直接写回它;{@link autoLayout} 只在两个地方用:
 * 新节点的落点、以及用户按「整理布局」时。
 *
 * 另一条路是"X 永远等于层号、只有 Y 能拖",那样图永远整齐,但拖不动左右、也没法
 * 把某个节点挪开看——而用户要的是"可以拖动的那种"。所以这里选了自由摆放 + 一个
 * 显式的整理按钮,代价是整理前可能有点乱,**由用户决定什么时候整理**。
 *
 * ## 两种指针操作,一套挂载方式
 *
 * 拖卡片是"移动",从卡片**下面**的圆点拖出来是"连一条依赖"。两者都照
 * `layout/Divider.tsx` 的做法:mousedown 时往 `document` 上挂 mousemove/mouseup,
 * 拖的过程中锁住 body 的 cursor 与 userSelect。**不引入 dnd-kit** —— 仓库里
 * `@dnd-kit` 全是 sortable 的一维用法,没有自由二维拖拽的先例,引进来反而要跟既有
 * 约定打架。
 *
 * 与 Divider 不同的是**这里真的会在操作中途被卸载**(设置页的 Escape 会关掉整个
 * 面板),所以那一对监听与 body 样式多了一个卸载时的回收口(见 `dragSessionRef`)。
 * 两种操作共用那一个槽位:同一时刻只可能有一种在跑。
 *
 * 拖动中的位置只放在本地 state(每一帧都改文档会把它一直判成"有改动"),主要**松手时
 * 才写回文档**。坐标被夹在 ≥ 0:负坐标会跑到画布原点左边,而 {@link canvasSize}
 * 只往右下量。
 *
 * ## 连线为什么不用"投放目标"
 *
 * 松手落在哪张卡片上,是拿**指针的画布坐标**去比每张卡片的矩形(`hitTestNode`),
 * 不是靠给卡片挂 dragover。理由有两条:卡片是绝对定位的普通 div,命中判定本来
 * 就是一次矩形比较;而且拖到卡片**边框上**、或者两张卡片挨着的时候,按坐标算还能
 * 补一个外扩量(HIT_PAD),按事件算就只能听天由命。
 *
 * 成环在**拖动过程中**就判(`wouldCycle`),目标卡片当场变红。等到松手才拒绝的话,
 * 用户看到的是一次没有结果的拖拽,还得去别处找原因。
 *
 * ## 回头边绕到旁边的空当去
 *
 * 「这几步再来一轮」那条边是**从下面的节点指回上面的节点**的。它不能走常规那条曲线:
 * 两点在同一列时那条曲线基本就是一根竖线,会把中间那几张卡片从上到下穿个透。所以
 * 这类边统一绕到旁边一条**没东西的竖带**上走(见 `backEdgeLanes`)—— 从两端右边那个
 * 空当起步,被谁挡住就跳到它右边再试。车道的宽度会先算进画布宽度里,不然最外面那条
 * 会画到画布外面。
 *
 * 注意车道是**按每条边自己经过的那条竖带**挑的,不是"整张图的右边" —— 后者只要图里
 * 有一张靠右的卡片,就会把每一条回头边都顶到图外面去绕一大圈。
 */
import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { Menu } from "@base-ui/react/menu";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Button } from "@renderer/components/ui/index.js";
import type { AgentProfile } from "@contracts/agentProfile";
import { MAIN_NODE_TYPE_ID, type NodeTypeCatalog } from "@contracts/nodeType";
import type { WorkflowDoc, WorkflowNode, WorkflowPosition } from "@contracts/workflow";
import { IconArrowsSplit, IconChevronDown, IconPlus, IconRefresh } from "@renderer/lib/icons.js";
import {
  CANVAS_PAD,
  NODE_H,
  NODE_W,
  backEdgeLanes,
  canvasSize,
  edgeMidpoint,
  edgePath,
  hitTestNode,
  type Box,
} from "./workflowLayout.js";
import { wouldCycle } from "./workflowEdit.js";
import { placeEdgeLabels } from "./workflowEdgeLabels.js";
import { isEditableTarget } from "@renderer/lib/shortcuts.js";
import { findNodeType, isLoopGate } from "./workflowView.js";
import { WorkflowNodeCard } from "./WorkflowNodeCard.js";

/** 命中目标时把卡片外扩这么多 —— 指针停在边框上是最常见的事。 */
const HIT_PAD = 8;

/** 正在拉的那条连线。坐标全是**画布坐标系**(容器坐标,已含 `CANVAS_PAD`)。 */
interface ConnectDrag {
  fromId: string;
  x: number;
  y: number;
  /** 指针底下那个节点(排除起点自己)。没落在任何卡片上是 null。 */
  targetId: string | null;
  /** 连过去会不会成环 —— 会的话目标卡片标红,松手也不连。 */
  cycle: boolean;
}

export function WorkflowCanvas({
  doc,
  catalog,
  profiles,
  selectedNodeId,
  onSelectNode,
  onMoveNode,
  onAddNode,
  onRelayout,
  onConnect,
  onRemoveEdge,
}: {
  doc: WorkflowDoc;
  catalog: NodeTypeCatalog;
  /** 保存下来的子 agent 配置。菜单里按它们列"直接建一个配好的节点"。 */
  profiles: AgentProfile[];
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
  onMoveNode: (id: string, position: WorkflowPosition) => void;
  /** `profileId` 给了就套用那份档案的参数(见 `addNode`)。 */
  onAddNode: (typeId: string, profileId?: string) => void;
  onRelayout: () => void;
  /** 从 `from` 拉一条依赖到 `to`(`from` 先跑完)。成环的拖拽**不会**走到这里。 */
  onConnect: (from: string, to: string) => void;
  /** 点了画布上那根线 —— 删掉这条依赖。 */
  onRemoveEdge: (edgeId: string) => void;
}) {
  const { t } = useI18n();
  /** 拖动中的位置。**只在松手时写回文档** —— 每一帧都写会让整份图在拖的过程里一直是“脏”的。 */
  const [dragPos, setDragPos] = useState<{ id: string; x: number; y: number } | null>(null);
  const dragPosRef = useRef<{ id: string; x: number; y: number } | null>(null);
  const [connect, setConnect] = useState<ConnectDrag | null>(null);
  /** 松手时要读**最新**的那一帧,而 state 是异步的 —— 和 `dragPosRef` 同一个理由。 */
  const connectRef = useRef<ConnectDrag | null>(null);
  /** 鼠标停在哪条线上(那条线会变红并长出一个删除钮)。 */
  const [hoverEdgeId, setHoverEdgeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [autoFit, setAutoFit] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const selectNode = (id: string | null) => { setSelectedEdgeId(null); onSelectNode(id); };
  const removeSelectedEdge = () => { if (selectedEdgeId) onRemoveEdge(selectedEdgeId); setSelectedEdgeId(null); };
  const removeSelectedRef = useRef(removeSelectedEdge);
  removeSelectedRef.current = removeSelectedEdge;
  useEffect(() => {
    if (!selectedEdgeId) return;
    const listener = (e: KeyboardEvent) => {
      if (!viewportRef.current?.getClientRects().length || isEditableTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); e.stopPropagation(); removeSelectedRef.current(); }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [selectedEdgeId]);
  /** 指针 → 画布坐标的基准。滚动条在内层 div 上,所以减它的 rect 就够了。 */
  const canvasRef = useRef<HTMLDivElement | null>(null);
  /** 正在进行的这次指针操作(拖卡片 / 拉连线)。拖动把监听挂在 `document` 上、还改了
   *  body 的样式,而**组件可能在按住不放的时候被卸载**(设置页那个 Escape 处理器会
   *  关掉整个面板)。卸载时得把这两样都收回来 —— 见下面那个 cleanup-only 的 effect。 */
  const dragSessionRef = useRef<{ stop: () => void } | null>(null);

  useEffect(() => () => dragSessionRef.current?.stop(), []);

  /**
   * 回头边各挑一条车道(见 `backEdgeLanes`)。不这么绕的话,两点在同一列时那条曲线
   * 就是一根竖线,会从中间那几张卡片的底下一直穿上去。
   *
   * 挑车道按**文档里的坐标**算,不按拖动中的临时位置 —— 拖一张卡片不该让别的线当场
   * 换道。同一张图每次算出来都一样(顺序取 `edges` 的先后)。
   */
  const lanes = backEdgeLanes(doc.nodes, doc.edges);

  const baseSize = canvasSize(doc.nodes, [...lanes.values()]);
  const positionOf = (node: WorkflowNode): WorkflowPosition =>
    dragPos?.id === node.id ? { x: dragPos.x, y: dragPos.y } : node.position;
  /** 画布坐标系 → 容器坐标(加四周留白)。 */
  const boxOf = (node: WorkflowNode): Box => {
    const p = positionOf(node);
    return { x: p.x + CANVAS_PAD, y: p.y + CANVAS_PAD, w: NODE_W, h: NODE_H };
  };
  const boxes = new Map(doc.nodes.map((node) => [node.id, boxOf(node)]));
  /** 指针在**容器坐标**里的位置。 */
  const pointOf = (ev: { clientX: number; clientY: number }): { x: number; y: number } => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: (ev.clientX - rect.left) / zoom, y: (ev.clientY - rect.top) / zoom };
  };
  /** 落在这张卡片上算不算数:是哪个节点、连过去会不会成环。 */
  const targetAt = (
    p: { x: number; y: number },
    fromId: string,
  ): { id: string; cycle: boolean } | null => {
    const id = hitTestNode(boxes, p.x, p.y, HIT_PAD);
    // 起点自己不算目标:自环在 `wouldCycle` 里也是环,但"松开时还停在原地"太容易
    // 发生了(手一抖就是一条自环),所以干脆当作没命中。
    if (id === null || id === fromId) return null;
    // **回头是允许的** —— 从分支拉一条线指回前面,就是"这几步再来一轮"。环上有没有
    // 岔路口由 `wouldCycle` 判(见 `@contracts/workflow` 的「回头」)。
    return { id, cycle: wouldCycle(doc, id, fromId, (n) => isLoopGate(catalog, doc, n)) };
  };

  /**
   * 每条边这一帧的几何。**可见线、命中区、那个删除钮共用同一份** —— 各算各的,
   * 手指点和线在改过布局之后就会对不上。
   *
   * 两端有一头指向不存在的节点就不画:存盘校验会拒这种图,但正在编辑的文档可以
   * 短暂处于这个状态(删节点的清理还没跑完 / 别人分享来的坏图)。
   */
  const edgeGeoms = doc.edges.flatMap((edge) => {
    const from = boxes.get(edge.from);
    const to = boxes.get(edge.to);
    if (!from || !to) return [];
    const lane = lanes.get(edge.id);
    return [{ edge, d: edgePath(from, to, lane), mid: edgeMidpoint(from, to, lane) }];
  });

  const labels = placeEdgeLabels(edgeGeoms.map(({ edge, mid }) => ({ id: edge.id, text: edge.label ?? "", x: mid.x, y: mid.y - 6 })), [...boxes.values()]);
  const size = {
    width: Math.max(baseSize.width, ...[...labels.values()].map(l => l.x + l.width / 2 + 12)),
    height: Math.max(baseSize.height, ...[...labels.values()].map(l => l.y + l.height + 12)),
  };
  const fit = () => {
    const view = viewportRef.current;
    if (!view) return;
    setZoom(Math.max(0.25, Math.min(1, (view.clientWidth - 12) / size.width, (view.clientHeight - 12) / size.height)));
  };
  const fitRef = useRef(fit); fitRef.current = fit;
  useEffect(() => {
    if (!autoFit || !viewportRef.current) return;
    fitRef.current();
    const observer = new ResizeObserver(() => fitRef.current());
    observer.observe(viewportRef.current);
    return () => observer.disconnect();
  }, [autoFit, size.width, size.height]);

  const connectFrom = connect ? boxes.get(connect.fromId) : undefined;
  /** 拉线时跟着指针走的那条虚线。目标那端给个 0×0 的盒子 = "连到这一点"。 */
  const previewD =
    connect && connectFrom
      ? edgePath(connectFrom, { x: connect.x, y: connect.y, w: 0, h: 0 })
      : null;

  const startDrag = (node: WorkflowNode) => (event: ReactMouseEvent) => {
    if (event.button !== 0) return; // 右键留给系统菜单
    event.preventDefault();
    selectNode(node.id);

    const startX = event.clientX;
    const startY = event.clientY;
    const origin = node.position;
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";

    const stop = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
      dragSessionRef.current = null;
    };
    const onMove = (ev: MouseEvent) => {
      const next = {
        id: node.id,
        x: Math.max(0, origin.x + (ev.clientX - startX) / zoom),
        y: Math.max(0, origin.y + (ev.clientY - startY) / zoom),
      };
      dragPosRef.current = next;
      setDragPos(next);
    };
    const onUp = () => {
      stop();
      const landed = dragPosRef.current;
      dragPosRef.current = null;
      setDragPos(null);
      // 只写回**真的动了**的那种:点一下选中不该产生一次保存。
      if (landed && landed.id === node.id && (landed.x !== origin.x || landed.y !== origin.y)) {
        onMoveNode(node.id, { x: landed.x, y: landed.y });
      }
    };
    dragSessionRef.current = { stop };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const startConnect = (node: WorkflowNode) => (event: ReactMouseEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    // 卡片自己的 mousedown 是"移动这张卡片"。不拦的话两个都会跑,松手时位置和
    // 连线各写一次文档 —— 而用户只想做一件事。
    event.stopPropagation();
    selectNode(node.id);

    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = "crosshair";
    document.body.style.userSelect = "none";

    const stop = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
      dragSessionRef.current = null;
    };
    const onMove = (ev: MouseEvent) => {
      const p = pointOf(ev);
      const target = targetAt(p, node.id);
      const next: ConnectDrag = {
        fromId: node.id,
        x: p.x,
        y: p.y,
        targetId: target?.id ?? null,
        cycle: target?.cycle ?? false,
      };
      connectRef.current = next;
      setConnect(next);
    };
    const onUp = (ev: MouseEvent) => {
      // 用**松手那一刻**的位置收口,而不是最后一次 mousemove 的那一帧:手快的时候
      // 最后一段是没有事件的,照着旧位置判会连到前一张路过的卡片上。
      onMove(ev);
      const landed = connectRef.current;
      stop();
      connectRef.current = null;
      setConnect(null);
      if (landed?.targetId && !landed.cycle) onConnect(node.id, landed.targetId);
    };
    dragSessionRef.current = { stop };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <WorkflowCanvasToolbar
        catalog={catalog}
        profiles={profiles}
        nodeCount={doc.nodes.length}
        edgeCount={doc.edges.length}
        hasMainNode={doc.nodes.some((n) => n.type === MAIN_NODE_TYPE_ID)}
        onAddNode={onAddNode}
        onRelayout={onRelayout}
      />

      <div className="mb-2 flex flex-wrap items-center gap-1">
        <Button size="sm" variant="ghost" aria-label={t("settings.workflows.zoomOut")} disabled={zoom <= 0.25} onClick={() => { setAutoFit(false); setZoom(z => Math.max(0.25, z - 0.1)); }}>−</Button>
        <output className="text-[0.7143em] tabular-nums text-content-muted">{Math.round(zoom * 100)}%</output>
        <Button size="sm" variant="ghost" aria-label={t("settings.workflows.zoomIn")} disabled={zoom >= 2} onClick={() => { setAutoFit(false); setZoom(z => Math.min(2, z + 0.1)); }}>+</Button>
        <Button size="sm" variant="secondary" onClick={() => { setAutoFit(true); fit(); }}>{t("settings.workflows.fitCanvas")}</Button>
        {selectedEdgeId && <Button size="sm" variant="danger" onClick={removeSelectedEdge}>{t("settings.workflows.deleteEdge")}</Button>}
      </div>
      <div ref={viewportRef} data-workflow-viewport className="min-h-0 flex-1 overflow-auto rounded-md border border-edge bg-surface/40">
        <div style={{ width: size.width * zoom, height: size.height * zoom }}>
        <div
          ref={canvasRef}
          className="relative"
          style={{ width: size.width, height: size.height, transform: `scale(${zoom})`, transformOrigin: "top left" }}
          // 点空白处取消选中。判 target === currentTarget,是因为卡片是子元素
          // (点卡片时事件从卡片冒上来,那时不该当成"点了背景")。
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) selectNode(null);
          }}
        >
          <svg
            className="pointer-events-none absolute left-0 top-0"
            width={size.width}
            height={size.height}
            role="group"
            aria-label={t("settings.workflows.edgeSelect", { name: "" })}
          >
            <defs>
              {/* 箭头:依赖是有方向的,没有箭头就得靠"从上到下"去猜。 */}
              <marker
                id="workflow-edge-arrow"
                viewBox="0 0 8 8"
                refX="7"
                refY="4"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 1 L 7 4 L 0 7 z" style={{ fill: "rgb(var(--edge))" }} />
              </marker>
              {/* 悬停时那条线是红的,箭头不跟着变就会是"红线配灰箭头"。 */}
              <marker
                id="workflow-edge-arrow-hover"
                viewBox="0 0 8 8"
                refX="7"
                refY="4"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 1 L 7 4 L 0 7 z" style={{ fill: "rgb(var(--accent))" }} />
              </marker>
            </defs>

            {edgeGeoms.map(({ edge, d, mid }) => {
              const hovered = edge.id === hoverEdgeId || edge.id === selectedEdgeId;
              return (
                <g
                  key={edge.id}
                  className="cursor-pointer"
                  onMouseEnter={() => setHoverEdgeId(edge.id)}
                  // 只在**还是自己**的时候清:快速划过两条线时,后一条的 enter 可能
                  // 先于前一条的 leave 到达。
                  onMouseLeave={() => setHoverEdgeId((cur) => (cur === edge.id ? null : cur))}
                  role="button"
                  tabIndex={0}
                  aria-pressed={edge.id === selectedEdgeId}
                  aria-label={t("settings.workflows.edgeSelect", { name: edge.label || `${edge.from} → ${edge.to}` })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelectNode(null); setSelectedEdgeId(edge.id); }
                  }}
                  onClick={() => { onSelectNode(null); setSelectedEdgeId(edge.id); }}
                >
                  <title>{t("settings.workflows.edgeRemoveHint")}</title>
                  {/* ⚠️ 颜色只能写主题里**真的有**的那个变量名:未定义的 `var()` 会让
                      `stroke` 变成非法值、回落到初始值 `none` —— 不报错、不警告,只有
                      一条谁也看不见的线。这里曾经写的是 `--edge-panel`,而主题里定义
                      的叫 `--panel-edge`(见 `styles.css`;`edge-panel` 是 Tailwind 的
                      颜色名,不是变量名)。`workflow-view-smoke` 里有一条机械校验盯着
                      这件事。 */}
                  <path
                    d={d}
                    fill="none"
                    strokeWidth={hovered ? 2.5 : 1.5}
                    vectorEffect="non-scaling-stroke"
                    markerEnd={`url(#workflow-edge-arrow${hovered ? "-hover" : ""})`}
                    style={{ stroke: hovered ? "rgb(var(--accent))" : "rgb(var(--edge))" }}
                  />
                  {/* 1.5px 的线太难点,给它一条 12px 宽的透明带当命中区。 */}
                  <path
                    d={d}
                    fill="none"
                    strokeWidth={12}
                    stroke="transparent"
                    style={{ pointerEvents: "stroke" }}
                  />

                </g>
              );
            })}

            {/* 分支节点的**选项名**,贴在线的中点。

                `pointerEvents: "none"` 是必须的:上面那一整组线**整条都是"点一下删掉
                这条依赖"的命中区**(见 `edgeRemoveHint`),让这几个字抢走点击的话,用户
                想看清楚这条是什么、结果把它删了。

                `paintOrder: "stroke"` + 一圈底色描边 = 一个字后面的小块"挖空"。不加的话
                字压在线上,读起来是一团糊的。 */}
            {edgeGeoms.map(({ edge, mid }) => {
              const label = labels.get(edge.id);
              if (!label) return null;
              return <g key={`lbl_${edge.id}`} style={{ pointerEvents: "none" }}>
                <title>{edge.label}</title>
                {(label.x !== mid.x || Math.abs(label.y - (mid.y - 6)) > 1) && <line x1={mid.x} y1={mid.y} x2={label.x} y2={label.y + 3} stroke="rgb(var(--edge))" strokeDasharray="2 3"/>}
                <text x={label.x} y={label.y} textAnchor="middle" style={{ fill: "rgb(var(--content-muted))", stroke: "rgb(var(--surface))", strokeWidth: 3, paintOrder: "stroke", fontSize: 11, pointerEvents: "none", userSelect: "none" }}>
                  {label.text}
                </text>
              </g>;
            })}

            {/* 跟着指针走的那条虚线。画在最后 = 压在所有边之上。 */}
            {previewD && (
              <path
                d={previewD}
                fill="none"
                strokeWidth={2}
                strokeDasharray="5 3"
                vectorEffect="non-scaling-stroke"
                style={{ stroke: connect?.cycle ? "rgb(var(--danger))" : "rgb(var(--accent))" }}
              />
            )}
          </svg>

          {doc.nodes.map((node) => {
            const box = boxes.get(node.id);
            if (!box) return null;
            const hint: "source" | "ok" | "blocked" | null = !connect
              ? null
              : connect.fromId === node.id
                ? "source"
                : connect.targetId === node.id
                  ? connect.cycle
                    ? "blocked"
                    : "ok"
                  : null;
            return (
              <WorkflowNodeCard
                key={node.id}
                node={node}
                entry={findNodeType(catalog.entries, node.type)}
                selected={node.id === selectedNodeId}
                left={box.x}
                top={box.y}
                connecting={connect !== null}
                connectHint={hint}
                onSelect={() => selectNode(node.id)}
                onMouseDown={startDrag(node)}
                onStartConnect={startConnect(node)}
              />
            );
          })}

          {doc.nodes.length === 0 && (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-center">
              <IconArrowsSplit size={26} className="text-content-subtle" />
              <p className="max-w-[280px] text-[0.7857em] leading-relaxed text-content-subtle">
                {t("settings.workflows.canvasEmpty")}
              </p>
            </div>
          )}
        </div>
        </div>
      </div>
    </div>
  );
}

/** 画布上方那条工具条:添加节点、整理布局、以及一张图的规模。 */
function WorkflowCanvasToolbar({
  catalog,
  profiles,
  nodeCount,
  edgeCount,
  hasMainNode,
  onAddNode,
  onRelayout,
}: {
  catalog: NodeTypeCatalog;
  profiles: AgentProfile[];
  nodeCount: number;
  edgeCount: number;
  /** 图上已经有主代理了。见下面那段过滤。 */
  hasMainNode: boolean;
  onAddNode: (typeId: string, profileId?: string) => void;
  onRelayout: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  // 一份图里只有**一个**主代理(它是入口,新建时就种下了),所以已经有了就不再列它 ——
  // 比让用户点出一个"两个入口"的图、再在别处报错省事。它不会因此看起来"消失了":
  // 画布上那一个一直在,而且删不掉(见 `isProtectedNode`)。
  const menuEntries = hasMainNode
    ? catalog.entries.filter((e) => e.id !== MAIN_NODE_TYPE_ID)
    : catalog.entries;

  // 按类目分组只是为了好找 —— 清单里的 `category` 是给作者用的自由文本,认不出就
  // 归到"其他"(与 `@contracts/nodeType` 的说明一致)。
  const groups = new Map<string, typeof menuEntries>();
  for (const entry of menuEntries) {
    const key = entry.manifest.category ?? "";
    const list = groups.get(key);
    if (list) list.push(entry);
    else groups.set(key, [entry]);
  }

  // 只列**类型还装着的**档案:一份指向已卸载类型的档案点下去只会建出一个跑不了的
  // 节点,不如在这里就不给(它仍然在检查器里可见、可删)。
  const typeIds = new Set(catalog.entries.map((e) => e.id));
  const usableProfiles = profiles.filter((p) => typeIds.has(p.type));

  /** 一条菜单项。三种列表(档案 / 按类型的节点)长得一样,所以只有这一份。 */
  const item = (
    key: string,
    title: string,
    subtitle: string,
    code: string | null,
    onClick: () => void,
  ): ReactNode => (
    <Menu.Item
      key={key}
      onClick={onClick}
      className={cn(
        "flex w-full flex-col gap-0.5 px-3 py-1.5 text-left outline-none select-none",
        "data-[highlighted]:bg-surface-muted",
      )}
    >
      <span className="flex items-center gap-2">
        <span className="text-[0.8571em] font-medium text-content">{title}</span>
        {code !== null && <code className="text-[0.7143em] text-content-subtle">{code}</code>}
      </span>
      {subtitle.length > 0 && (
        <span className="text-[0.7143em] leading-snug text-content-subtle">{subtitle}</span>
      )}
    </Menu.Item>
  );

  const heading = (text: string): ReactNode => (
    <div className="px-3 pb-0.5 pt-1.5 text-[0.7143em] font-medium uppercase tracking-wide text-content-subtle">
      {text}
    </div>
  );

  return (
    <div className="mb-2 flex flex-wrap items-center gap-2">
      <Menu.Root open={open} onOpenChange={setOpen}>
        <Menu.Trigger
          disabled={catalog.entries.length === 0}
          className={cn(
            "flex shrink-0 items-center gap-1 whitespace-nowrap rounded border border-edge bg-surface px-2 py-1 text-[0.7857em] transition-colors",
            "text-content-muted hover:bg-surface-hover/60 hover:text-content",
            "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-surface",
          )}
        >
          <IconPlus size={12} />
          {t("settings.workflows.addNode")}
          <IconChevronDown size={11} className="opacity-70" />
        </Menu.Trigger>
        <Menu.Portal>
          {/* z-50 在 Positioner 上:floating-ui 用 transform 定位,会在 Popup 那层
              造出新的层叠上下文(见 `WorkflowDropdown` 同款注释)。 */}
          <Menu.Positioner side="bottom" align="start" sideOffset={4} className="z-50">
            <Menu.Popup className="max-h-[320px] min-w-[280px] overflow-y-auto rounded-lg border border-edge bg-surface py-1 shadow-2xl">
              {/* 档案排在**类型前面**:这是一个"我想再建一个那样的步骤"的动作,比
                  "我要一种新节点"更常发生,而往下翻才能找到自己存过的东西很烦。 */}
              {usableProfiles.length > 0 && (
                <div>
                  {heading(t("settings.workflows.addFromProfile"))}
                  {usableProfiles.map((profile) =>
                    item(
                      `profile-${profile.id}`,
                      profile.name,
                      profile.description ?? "",
                      profile.type,
                      () => {
                        onAddNode(profile.type, profile.id);
                        setOpen(false);
                      },
                    ),
                  )}
                </div>
              )}
              {[...groups].map(([category, entries]) => (
                <div key={category}>
                  {heading(
                    category.length > 0 ? category : t("settings.workflows.nodeTypeOther"),
                  )}
                  {entries.map((entry) =>
                    item(
                      entry.id,
                      entry.manifest.name,
                      entry.manifest.description ?? "",
                      entry.id,
                      () => {
                        onAddNode(entry.id);
                        setOpen(false);
                      },
                    ),
                  )}
                </div>
              ))}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>

      <Button
        variant="ghost"
        size="sm"
        onClick={onRelayout}
        disabled={nodeCount === 0}
        className="gap-1"
      >
        <IconRefresh size={12} />
        {t("settings.workflows.relayout")}
      </Button>

      <span className="ml-auto text-[0.7143em] tabular-nums text-content-subtle">
        {t("settings.workflows.graphSummary", { nodes: nodeCount, edges: edgeCount })}
      </span>
    </div>
  );
}
