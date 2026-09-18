/**
 * 右栏那张**小流程图** —— 这张图现在跑到哪儿了。
 *
 * ## 它回答的是"跑到哪了",不是"这张图长什么样"
 *
 * 画布(设置 → 工作流)是**编辑**用的:拖、连、选中、改参数。这一张是**看**用的:
 * 一眼看出哪一格在转圈、哪几格跑完了、哪一格炸了、刚才那一步的产出喂给了谁。
 * 所以它不接拖拽、不摆按钮、不显示参数 —— 点一下只是"我要看这一格的详情",由调用方
 * 决定详情长什么样。
 *
 * ## 坐标用文档里的,不用自动排布
 *
 * 文档里存着用户自己拖出来的位置(`node.position`)。按自动排布重画会让这张图和用户
 * 在画布上认得的形状对不上 —— 而"我认得的那张图"正是这个控件唯一的用处。
 *
 * ## 缩放而不是滚动
 *
 * 右栏只有两三百像素宽,而一张图横着可能有上千像素。所以整张图**等比缩到装得下**
 * (`viewBox` 那套:算一次包围盒,再把所有坐标映射进去)。滚动条在这里没有意义 ——
 * 用户要的是"看全局",不是"在缩略图上找路"。
 *
 * ## 为什么是 SVG
 *
 * 和画布那边**刚好相反** —— 那边节点是 DOM(文字排版交给浏览器)、只有边是 SVG。
 * 这里节点上**一个字都没有**(小到放不下),全是方块和线,所以整张图直接走 SVG,
 * 连缩放都是白送的。
 *
 * ## 颜色是 `rgb(var(--x) / a)` 而不是 `var(--x)`
 *
 * 那几个 token 存的是 **"R G B" 三元组**(见 `styles.css`),不是颜色值 —— 直接写
 * `fill="var(--accent)"` 会被当成非法颜色丢掉,方块会变成黑的。所以每处都走
 * `rgb(...)`,和 tailwind 配置里那套 `<alpha-value>` 是同一个道理。
 */
import { useMemo } from "react";
import { NODE_H, NODE_W, type WorkflowDoc } from "@contracts/workflow";
import { cn } from "@renderer/lib/cn.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import type { LiveNode, LiveRun } from "@renderer/lib/workflowLive.js";

/** 缩略图四周留一点空 —— 贴着边框的方块看不出边界。 */
const GAP = 8;

/** 一格的样子。**按状态分色,不按类型** —— 站在"看它跑到哪了"这个角度,"这一步成没成"
 *  比"它是什么类型的节点"重要得多(类型由下面那行小字和详情面板说)。 */
const PHASE_STYLE: Record<string, { fill: string; stroke: string; dash?: string }> = {
  idle: { fill: "rgb(var(--surface-muted))", stroke: "rgb(var(--edge))" },
  queued: { fill: "rgb(var(--surface-muted))", stroke: "rgb(var(--edge))", dash: "3 2" },
  running: {
    fill: "rgb(var(--accent) / 0.22)",
    stroke: "rgb(var(--accent))",
  },
  success: {
    fill: "rgb(var(--success) / 0.18)",
    stroke: "rgb(var(--success))",
  },
  failed: { fill: "rgb(var(--danger) / 0.2)", stroke: "rgb(var(--danger))" },
  skipped: { fill: "rgb(var(--surface-muted))", stroke: "rgb(var(--edge))", dash: "2 3" },
  unselected: { fill: "rgb(var(--surface-muted))", stroke: "rgb(var(--edge))", dash: "2 3" },
  cancelled: { fill: "rgb(var(--surface-muted))", stroke: "rgb(var(--edge))", dash: "2 3" },
  awaiting: {
    fill: "rgb(var(--warning) / 0.22)",
    stroke: "rgb(var(--warning))",
  },
};

/** 这一格按哪一档上色。
 *
 *  **`awaiting` 压过 `running`** —— "在等你"比"在跑"更该被看见:在跑的那些不用管,
 *  在等人的那些不点一下整张图就停着。 */
function styleKeyOf(node: LiveNode | undefined): string {
  if (!node) return "idle";
  if (node.awaiting) return "awaiting";
  if (node.phase === "running") return "running";
  if (node.phase === "queued") return "queued";
  if (node.phase === "settled") return node.status ?? "idle";
  return "idle";
}

export function WorkflowFlowMini({
  doc,
  run,
  selectedNodeId,
  onSelectNode,
}: {
  doc: WorkflowDoc;
  /** 这一次运行的现场。**可以是 null** —— 还没跑过,或者已经不在内存里了;那时画的
   *  是一张"什么都没跑"的图,仍然有用:用户知道这张图有哪几步。 */
  run: LiveRun | null;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
}) {
  /** 包围盒 + 映射。**只按 `doc.nodes` 算** —— 运行状态不影响几何,所以拖动/缩放
   *  不会因为某一步跑完而抖一下。 */
  const layout = useMemo(() => {
    if (doc.nodes.length === 0) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of doc.nodes) {
      minX = Math.min(minX, node.position.x);
      minY = Math.min(minY, node.position.y);
      maxX = Math.max(maxX, node.position.x + NODE_W);
      maxY = Math.max(maxY, node.position.y + NODE_H);
    }
    const shift = (x: number, y: number) => ({ x: x - minX + GAP, y: y - minY + GAP });
    const box = (node: { position: { x: number; y: number } }) => {
      const p = shift(node.position.x, node.position.y);
      return { x: p.x, y: p.y, w: NODE_W, h: NODE_H };
    };
    return {
      width: Math.max(1, maxX - minX) + GAP * 2,
      height: Math.max(1, maxY - minY) + GAP * 2,
      box,
    };
  }, [doc.nodes]);

  if (layout === null) return null;

  const boxes = new Map(doc.nodes.map((node) => [node.id, layout.box(node)]));
  const edges = doc.edges.flatMap((edge) => {
    const from = boxes.get(edge.from);
    const to = boxes.get(edge.to);
    return !from || !to ? [] : [{ edge, from, to }];
  });

  return (
    <svg
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      className="block h-auto w-full select-none"
      role="img"
      aria-label={doc.name}
    >
      <defs>
        {/* 两个箭头各配一条线的颜色 —— SVG 的 marker **不继承**描边色。 */}
        <marker
          id="wf-mini-arrow"
          viewBox="0 0 6 6"
          refX="5"
          refY="3"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 6 3 L 0 6 z" fill="rgb(var(--edge))" />
        </marker>
        <marker
          id="wf-mini-arrow-on"
          viewBox="0 0 6 6"
          refX="5"
          refY="3"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 6 3 L 0 6 z" fill="rgb(var(--accent))" />
        </marker>
      </defs>

      {/* 依赖线。**画在方块之前** —— 线压在方块上会让方块看起来是破的。 */}
      {edges.map(({ edge, from, to }) => {
        const x1 = from.x + from.w / 2;
        const y1 = from.y + from.h;
        const x2 = to.x + to.w / 2;
        const y2 = to.y;
        // 回头边(目标在源上面):走旁边一条弧。直连的话它会从上到下穿过中间那几格。
        const back = y2 < y1;
        const d = back
          ? `M ${x1} ${y1} C ${x1 + 26} ${y1 + 10}, ${x2 + 26} ${y2 - 10}, ${x2} ${y2}`
          : `M ${x1} ${y1} C ${x1} ${y1 + (y2 - y1) * 0.45}, ${x2} ${y2 - (y2 - y1) * 0.45}, ${x2} ${y2}`;
        // **源那一步跑成了,这条线才算"送过去了"** —— 没跑成 / 没走这条路,下游拿
        // 不到东西,线就该是灰的。这是这张图上唯一表达"数据往哪儿流"的信号。
        const carried = run?.nodes[edge.from]?.status === "success";
        return (
          <path
            key={edge.id}
            d={d}
            fill="none"
            strokeWidth={carried ? 1.6 : 1}
            stroke={carried ? "rgb(var(--accent))" : "rgb(var(--edge))"}
            strokeDasharray={back ? "4 2" : undefined}
            markerEnd={carried ? "url(#wf-mini-arrow-on)" : "url(#wf-mini-arrow)"}
            opacity={carried ? 0.95 : 0.6}
          />
        );
      })}

      {doc.nodes.map((node) => {
        const box = boxes.get(node.id);
        if (!box) return null;
        const live = run?.nodes[node.id];
        const key = styleKeyOf(live);
        const style = PHASE_STYLE[key] ?? PHASE_STYLE.idle;
        const selected = node.id === selectedNodeId;
        const cx = box.x + box.w / 2;
        const cy = box.y + box.h / 2;
        return (
          <g
            key={node.id}
            onClick={() => onSelectNode(node.id)}
            className="cursor-pointer"
            role="button"
          >
            <rect
              x={box.x}
              y={box.y}
              width={box.w}
              height={box.h}
              rx={5}
              fill={style.fill}
              stroke={selected ? "rgb(var(--accent))" : style.stroke}
              strokeWidth={selected ? 2 : 1.2}
              strokeDasharray={style.dash}
            />
            {/* 正在跑的那一格:套一圈**跳动的**虚线。
                转圈(改 dashoffset)在这个尺寸下几乎看不出来,而 `animate-pulse` 是
                现成的、在两个主题下都读得出来 —— 一眼扫过去就知道是这一格。 */}
            {key === "running" && (
              <rect
                x={box.x}
                y={box.y}
                width={box.w}
                height={box.h}
                rx={5}
                fill="none"
                stroke="rgb(var(--accent))"
                strokeWidth={2}
                strokeDasharray="6 5"
                className="motion-safe:animate-pulse"
              />
            )}
            {/* 成功了打一个勾。**小尺寸下勾比"绿色"可靠** —— 绿和灰在色弱眼里可能
                是一回事,但有没有那一笔是看得见的。 */}
            {key === "success" && (
              <path
                d={`M ${cx - 6} ${cy} l 4 4 l 8 -9`}
                fill="none"
                stroke="rgb(var(--success))"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}
            {key === "failed" && (
              <path
                d={`M ${cx - 5} ${cy - 5} l 10 10 M ${cx + 5} ${cy - 5} l -10 10`}
                fill="none"
                stroke="rgb(var(--danger))"
                strokeWidth={2}
                strokeLinecap="round"
              />
            )}
            {/* 「在等你」点一个问号 —— 整张图停在这儿,得一眼看出来。 */}
            {key === "awaiting" && (
              <text
                x={cx}
                y={cy + 5}
                textAnchor="middle"
                fontSize={15}
                fontWeight={700}
                fill="rgb(var(--warning))"
              >
                ?
              </text>
            )}
            <title>{live?.title || node.title || node.type}</title>
          </g>
        );
      })}
    </svg>
  );
}

/** 小流程图下面的那条图例。**四档,不是八档** —— 用户要区分的是"跑完了 / 在跑 /
 *  在等你 / 出事了",`skipped` 与 `cancelled` 的区别在详情里看。词走 i18n(这文件
 *  本来不引 `useI18n`,图例是唯一有字的地方)。 */
export function WorkflowFlowLegend({ className }: { className?: string }) {
  const { t } = useI18n();
  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-1", className)}>
      <LegendDot className="bg-success" label={t("chatStream.workflowBoard.legendDone")} />
      <LegendDot className="bg-accent" label={t("chatStream.workflowBoard.legendRunning")} />
      <LegendDot className="bg-warning" label={t("chatStream.workflowBoard.legendAwaiting")} />
      <LegendDot className="bg-danger" label={t("chatStream.workflowBoard.legendFailed")} />
    </div>
  );
}

function LegendDot({
  className,
  label,
}: {
  className: string;
  label: MessageId | string;
}) {
  return (
    <span className="flex items-center gap-1 text-[0.7143em] text-content-subtle">
      <span aria-hidden className={cn("h-2 w-2 rounded-[2px]", className)} />
      {label}
    </span>
  );
}
