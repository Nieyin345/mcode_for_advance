/**
 * 右栏那张**小流程图** —— 这张图当前执行到哪一步、产出在节点之间怎么传递。
 *
 * ## 它回答的两个问题
 *
 * 画布(设置 → 工作流)是**编辑**用的:拖、连、选中、改参数。这一张是**看**用的:
 * 一眼看出哪一步在执行、哪几步已完成、哪一步失败。所以它不接拖拽、不摆按钮、不显示
 * 参数 —— 点一下只是"我要看这一格",由调用方决定展开成什么样;右键是"从这一步开始
 * 重跑",同样交给调用方。
 *
 * ## 尺寸:不缩放、不跟栏宽走、块宽按内容定
 *
 * 历史上出现过两种错误做法,记在这里以免重蹈:
 *
 *  1. **等比缩进 `viewBox`(`h-auto w-full`)** —— 侧边栏拉多宽图就多大,而且一缩字
 *     就没了。用户当时的原话是「太大了,也没有任何的信息,就只是一个白框」。
 *  2. **块宽按"剩下的宽度均分"** —— 先算一层摆得下几个,再把可用宽度平分给这几列。
 *     这个算法在窄栏里是**反的**:栏窄 → 一层只摆得下一个 → 那一个把整行宽度全占了
 *     (达到 {@link MAX_BOX_W});栏宽 → 一层摆两个 → 每个只分到一半(降到
 *     {@link MIN_BOX_W})。实测过:栏 140px 时块宽 94、栏 220px 时 170、栏 640px 时 92
 *     —— 栏越窄块越大,正是用户报的那个现象。
 *
 * 现在这一版的三条:
 *
 *  - 高度:默认 {@link FLOW_MAX_H},**用户可以在看板上拖那条横分隔条改**(由调用方把
 *    高度当 prop 传进来),改动后存进设置;
 *  - **不缩放**:节点按 CSS 像素一比一画,字固定 {@link LABEL_PX},永远读得出来;
 *  - 块宽**按内容定**(量标题的估算宽度,夹在上下限之间),**与栏宽无关**;一层排不下
 *    就折到下一行,而不是把块压小 —— 所以栏怎么拖,块都是一个大小。
 *
 * ## 布局按**分层**排,不看 `node.position`
 *
 * 画布上存着用户拖出来的坐标,但那是给画布用的 —— 缩到这个尺寸再按坐标摆,节点会
 * 挤在一起、连线会互相穿过。这里用 `topoLayers`(和自动布局同一个函数)从上往下排、
 * 同层横着并排:图是**从上往下走**的,那是它唯一要表达的结构。每一行**居中**。
 *
 * ## 图上写着名字
 *
 * 每一格写着它的名字(按装得下的宽度截断)。名字取 `LiveNode.title`(现场那份由事件
 * 带过来),没有则退回图上的标题,再退回类型 id。
 *
 * ## 状态怎么表示
 *
 * 颜色 + 记号 + **正在执行的那一格外面套一道转动的弧**。三者都在同一个位置(方框上),
 * 不需要图例解释 —— 一屏里只有一格在转,一眼即可分辨。
 *
 * ## 颜色是 `rgb(var(--x) / a)` 而不是 `var(--x)`
 *
 * 那几个 token 存的是 **"R G B" 三元组**(见 `styles.css`),不是颜色值 —— 直接写
 * `fill="var(--accent)"` 会被当成非法颜色丢掉,方块会变成黑的。所以每处都走
 * `rgb(...)`,和 tailwind 配置里那套 `<alpha-value>` 是同一个道理。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { topoLayers, type WorkflowDoc, type WorkflowNode } from "@contracts/workflow";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import type { LiveNode, LiveRun } from "@renderer/lib/workflowLive.js";

/** 图默认多高。**只是个默认值** —— 用户拖那条横分隔条就能改(见调用方
 *  `WorkflowBoardPanel` 里那一份高度状态)。 */
export const FLOW_MAX_H = 176;
/** 拖动能到的上下限。太低只剩一条缝、看不见图;太高会把下面的卡片列表挤掉。 */
export const FLOW_H_MIN = 72;
export const FLOW_H_MAX = 520;

/** 一圈内边距。贴着边框的方块看不出边界。 */
const PAD = 6;
/** 一块最少多宽。**低于这个宽度就放不下名字** —— 而"每一步叫什么"正是用户说图里
 *  「没有任何的信息」时指的那样东西。 */
const MIN_BOX_W = 92;
/** 一块最多多宽。名字长到超过这个宽度就截断 —— 再宽下去一层只摆得下一块,而图是
 *  横向铺开的结构。 */
const MAX_BOX_W = 170;
/**
 * 一块的高度。**2026-09-21 从 28 加到 34** —— 名字下面多了一行状态小字（用户：
 * 「流程图信息丰富一点，**不要只是一个名字**」）。
 *
 * 加高的代价是整张图变高（`FLOW_MAX_H` 那一栏能看到的层数少一点），所以没有加更多：
 * 状态小字这一行是**一条就能读完**的（"执行中" / "已完成 2m14s"）。
 */
const BOX_H = 34;
/** 状态小字那一行的字号。比名字小一号，读起来是"名字的补充"而不是第二条标题。 */
const SUB_PX = 8.5;
const GAP_X = 8;
/** 同一层里两行之间的间隔(一层里的节点换行时)。 */
const GAP_Y = 10;
/** 层与层之间。**比同层那档大** —— "一层一层往下走"是这张图要让人一眼看出来的结构,
 *  它靠的就是这个间距差。 */
const LAYER_GAP = 18;
/** 竖向滚动条大概占这么多 —— 布局按"会出滚动条"算宽度,否则滚动条一出现内容就窄了
 *  一个档、重新换行、又不出滚动条了(来回抖)。 */
const SCROLLBAR_ALLOWANCE = 14;
/** 节点上的字号。**固定** —— 这张图不缩放,字就永远是这个大小。 */
const LABEL_PX = 10;
/** 名字左右各留这么多内边距。 */
const PAD_X = 8;
/** 右边留给状态记号的位置。 */
const GLYPH_W = 16;

/** 状态小字的颜色。**跟状态走,不跟色板走** —— 绿=成、红=败、主题色=在跑。 */
function rgbOf(key: string): string {
  if (key === "success") return "rgb(var(--success))";
  if (key === "failed") return "rgb(var(--danger))";
  if (key === "running") return "rgb(var(--accent))";
  return "rgb(var(--content-subtle))";
}

/**
 * 名字下面那行小字：**这一步现在怎么了**（外加上跑了多久）。
 *
 * ## 措辞从哪来
 *
 * 状态词复用 `WorkflowNodeCard` 那一套 `chatStream.workflowStep.*` —— 同一件事
 * （"这一步跑完了"）在图上和卡片上**必须是同一个词**，否则用户得先学会两套说法。
 *
 * ## 耗时只在"看得见起止"时给
 *
 * `startedAt` 与 `endedAt` 两个字段都可能缺（重启后从库里补出来的那几步只有
 * `startedAt`、还没轮到的那些两个都没有）。缺就不给 —— **编一个"0s"比不给更坏**，
 * 它看起来像一个真实的测量值。
 */
function subLabelOf(
  key: string,
  live: { startedAt?: number; endedAt?: number } | undefined,
  t: ReturnType<typeof useI18n>["t"],
): string {
  const word =
    key === "running"
      ? t("chatStream.workflowStep.running")
      : key === "success"
        ? t("chatStream.workflowStep.success")
        : key === "failed"
          ? t("chatStream.workflowStep.failed")
          : key === "queued"
            ? t("chatStream.workflowStep.queued")
            : key === "cancelled"
              ? t("chatStream.workflowStep.cancelled")
              : key === "skipped"
                ? t("chatStream.workflowStep.skipped")
                : key === "unselected"
                  ? t("chatStream.workflowStep.unselected")
                  : "";
  const ms =
    live?.startedAt !== undefined && live.endedAt !== undefined
      ? Math.max(0, live.endedAt - live.startedAt)
      : undefined;
  if (ms === undefined) return word;
  const sec = Math.round(ms / 1000);
  const dur = sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, "0")}s`;
  return word ? `${word} · ${dur}` : dur;
}

/** 一格的样子。**按状态分色,不按类型** —— 站在"看它跑到哪了"这个角度,"这一步成没成"
 *  比"它是什么类型的节点"重要得多(类型由卡片上的小字说)。 */
const PHASE_STYLE: Record<string, { fill: string; stroke: string; dash?: string }> = {
  idle: { fill: "rgb(var(--surface-muted))", stroke: "rgb(var(--edge))" },
  queued: { fill: "rgb(var(--surface-muted))", stroke: "rgb(var(--edge))", dash: "3 2" },
  running: { fill: "rgb(var(--accent) / 0.22)", stroke: "rgb(var(--accent))" },
  success: { fill: "rgb(var(--success) / 0.18)", stroke: "rgb(var(--success))" },
  failed: { fill: "rgb(var(--danger) / 0.2)", stroke: "rgb(var(--danger))" },
  skipped: { fill: "rgb(var(--surface-muted))", stroke: "rgb(var(--edge))", dash: "2 3" },
  unselected: { fill: "rgb(var(--surface-muted))", stroke: "rgb(var(--edge))", dash: "2 3" },
  cancelled: { fill: "rgb(var(--surface-muted))", stroke: "rgb(var(--edge))", dash: "2 3" },
  awaiting: { fill: "rgb(var(--warning) / 0.22)", stroke: "rgb(var(--warning))" },
};

/** 这一格按哪一档上色。
 *
 *  **`awaiting` 压过 `running`** —— "在等你"比"在跑"更该被看见:执行中的那些不必干预,
 *  等待用户的那一步不处理则整张图停在那里。 */
function styleKeyOf(node: LiveNode | undefined): string {
  if (!node) return "idle";
  if (node.awaiting) return "awaiting";
  if (node.phase === "running") return "running";
  if (node.phase === "queued") return "queued";
  if (node.phase === "settled") return node.status ?? "idle";
  return "idle";
}

/** 这几个档的字用醒目的颜色,其余用弱色 —— 灰格里写黑字反而像是"这一格有事"。 */
const LOUD: ReadonlySet<string> = new Set(["running", "awaiting", "success", "failed"]);

/**
 * 量一段文字的估算宽度(像素)。
 *
 * **按估算,不按字数** —— 中日韩字符大约一个字一个字宽,西文只有一半,按字数算的话
 * "Read the file" 会被砍掉一半而中文标题还剩一截空白。估算够用:这里的目标是"别画出
 * 格"、以及"块宽跟着名字走",不是排版。
 */
function textWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += ch.charCodeAt(0) > 0x2e80 ? LABEL_PX : LABEL_PX * 0.56;
  return w;
}

/**
 * 把一个标题截到装得下。
 *
 * 装不下时末尾留一个「…」—— 让用户知道这里还有字(而不是以为这一步就叫这个名字)。
 */
export function fitTitle(text: string, maxPx: number): string {
  if (textWidth(text) <= maxPx) return text;
  let used = 0;
  const out: string[] = [];
  const ellipsis = textWidth("…");
  for (const ch of text) {
    const w = ch.charCodeAt(0) > 0x2e80 ? LABEL_PX : LABEL_PX * 0.56;
    if (used + w + ellipsis > maxPx) return out.length === 0 ? ch + "…" : out.join("") + "…";
    used += w;
    out.push(ch);
  }
  return text;
}

/** 量容器的内宽。图要按它决定一层摆得下几块、要不要折行。 */
function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 分层 → 一行行摆开。
 *
 * ## 块宽按内容定,不按"剩下的宽度均分"
 *
 * 这是这一版的正题(见文件头第 2 条)。每一块先按**自己那个名字**量出一个宽度,夹在
 * {@link MIN_BOX_W}/{@link MAX_BOX_W} 之间;然后贪心地往一行里塞,塞不下就换行。于是
 * 块宽只跟名字有关 —— 栏拉窄只会让它**折成更多行**,不会让块变大。
 *
 * 唯一的例外是**栏比最小块还窄**(可用宽度 < {@link MIN_BOX_W}):那时块被压到可用
 * 宽度,标题截断。这是必要的 —— 不压的话图会横向撑破,而看板是一条窄栏。
 *
 * 同层内保持 `doc.nodes` 的原有次序(不按位置排:用户在画布上把两个并排的步骤左右
 * 对调,不该让缩略图里的次序跟着改变)。每一行**居中**。
 */
function layoutOf(
  doc: WorkflowDoc,
  innerW: number,
): { boxes: Map<string, Box>; width: number; height: number } | null {
  if (doc.nodes.length === 0) return null;
  /**
   * 图本身的宽度 = 栏的内宽 **减掉留给滚动条的那一档**。
   *
   * 为什么不直接取内宽:图一旦装不下就会出现竖向滚动条,滚动条一出现内宽就少十几像素
   * → 重新换行 → 可能又不出滚动条了 → 宽度变回去 …… 反复振荡。预留一档之后,出不出
   * 滚动条看到的可用宽度是**同一个**,这个循环就断了(高度封顶那一条同理)。
   *
   * 预留的是常量,所以图比栏窄一点点 —— 但从头到尾只有一个宽度,而且**不缩放**
   * (SVG 的 width 就是它渲染出来的宽度)。
   */
  const svgW = Math.max(MIN_BOX_W + PAD * 2, Math.round(innerW) - SCROLLBAR_ALLOWANCE);
  const avail = Math.max(MIN_BOX_W, svgW - PAD * 2);

  /**
   * 一块要占多宽。**只跟名字有关**(再被窄栏压一压)。
   *
   * 量的是节点**图上那个标题**,不是现场那份 —— 现场那份(事件带过来的)长度会随运行
   * 变化,拿它定宽的话,图会在执行过程中一次次重新排版。宽度必须是**静态**的。
   */
  const widthOf = (node: WorkflowNode): number => {
    const want = textWidth(node.title || node.type) + PAD_X * 2 + GLYPH_W;
    const capped = Math.min(MAX_BOX_W, Math.max(MIN_BOX_W, Math.ceil(want)));
    return Math.min(capped, avail);
  };

  const layers = topoLayers(doc.nodes, doc.edges);
  const byLayer = new Map<number, WorkflowNode[]>();
  for (const node of doc.nodes) {
    const layer = layers.get(node.id) ?? 0;
    const list = byLayer.get(layer);
    if (list) list.push(node);
    else byLayer.set(layer, [node]);
  }
  const order = [...byLayer.keys()].sort((a, b) => a - b);

  const boxes = new Map<string, Box>();
  /** 每一层切成若干行 —— 先只算"哪几块在同一行",位置留到第二轮。 */
  const rows: Array<{ widths: number[]; nodes: WorkflowNode[]; layer: number }> = [];
  for (const layer of order) {
    let nodes: WorkflowNode[] = [];
    let widths: number[] = [];
    let total = 0;
    for (const node of byLayer.get(layer) ?? []) {
      const w = widthOf(node);
      if (total > 0 && total + GAP_X + w > avail) {
        rows.push({ nodes, widths, layer });
        nodes = [node];
        widths = [w];
        total = w;
      } else {
        nodes.push(node);
        widths.push(w);
        total = total === 0 ? w : total + GAP_X + w;
      }
    }
    if (nodes.length > 0) rows.push({ nodes, widths, layer });
  }
  if (rows.length === 0) return null;

  /** 内容本身占多宽 —— 最宽那一行。SVG 的宽度用它(见 `width` 那条注释)。 */
  const contentW = Math.max(
    MIN_BOX_W + PAD * 2,
    ...rows.map((r) => r.widths.reduce((a, b) => a + b, 0) + GAP_X * (r.widths.length - 1) + PAD * 2),
  );
  /** **SVG 的宽度** —— 内容那么宽,但不超过栏宽减掉滚动条那一档。 */
  const width = Math.round(Math.min(svgW, contentW));

  let y = PAD;
  let prevLayer: number | null = null;
  for (const r of rows) {
    // 层的边界上多留一档 —— "一层一层往下走"靠这个间距差体现。
    if (prevLayer !== null && r.layer !== prevLayer) y += LAYER_GAP;
    prevLayer = r.layer;
    const rowW = r.widths.reduce((a, b) => a + b, 0) + GAP_X * (r.widths.length - 1);
    // **整行居中。** 一行排不满时左右各留一半空白,而不是全部靠左。
    let x = PAD + Math.max(0, (width - PAD * 2 - rowW) / 2);
    r.nodes.forEach((node, i) => {
      const w = r.widths[i] ?? MIN_BOX_W;
      boxes.set(node.id, { x, y, w, h: BOX_H });
      x += w + GAP_X;
    });
    y += BOX_H + GAP_Y;
  }
  return { boxes, width, height: y - GAP_Y + PAD };
}

/** 右键请求:哪一格、在屏幕的哪儿。菜单锚在光标上(和左栏那几个菜单同一套)。 */
export interface FlowContextTarget {
  nodeId: string;
  x: number;
  y: number;
}

export function WorkflowFlowMini({
  doc,
  run,
  selectedNodeId,
  onSelectNode,
  onContextNode,
  maxHeight = FLOW_MAX_H,
}: {
  doc: WorkflowDoc;
  /** 这一次运行的现场。**可以是 null** —— 还没跑过,或者已经不在内存里了;那时画的
   *  是一张"什么都没跑"的图,仍然有用:用户知道这张图有哪几步。 */
  run: LiveRun | null;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
  /** 右键某一格。不给就不响应右键(图上仍可左键选中)。 */
  onContextNode?: (target: FlowContextTarget) => void;
  /** 图框最高多高,由调用方的分隔条决定。装不下就在框里滚动。 */
  maxHeight?: number;
}) {
  const { t } = useI18n();
  const [wrapRef, innerW] = useWidth<HTMLDivElement>();
  /** 宽度还没量到时先按一个窄栏的宽度摆一次(量到之后立刻重算,不会闪)。 */
  const layout = useMemo(() => layoutOf(doc, innerW > 0 ? innerW : 300), [doc, innerW]);

  if (layout === null) return null;

  const { boxes } = layout;
  const edges = doc.edges.flatMap((edge) => {
    const from = boxes.get(edge.from);
    const to = boxes.get(edge.to);
    return !from || !to ? [] : [{ edge, from, to }];
  });

  return (
    <div
      ref={wrapRef}
      className="flex justify-center overflow-y-auto overflow-x-hidden"
      style={{ maxHeight }}
      data-flow-h={maxHeight}
    >
      {/* `justify-center` 把图居中 —— 图本身只有内容那么宽(见 `layoutOf` 的 `width`),
          整栏比它宽的时候那截空白左右平分。 */}
      <svg
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        className="block shrink-0 select-none"
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

        {/* 依赖线。**画在方块之前** —— 线压在方块上会让方块看起来是残缺的。 */}
        {edges.map(({ edge, from, to }) => {
          const x1 = from.x + from.w / 2;
          const y1 = from.y + from.h;
          const x2 = to.x + to.w / 2;
          const y2 = to.y;
          // 回头边(目标在源上面):走这条线自己那一侧的一条弧。直连的话它会从上到下
          // 穿过中间那几格,而那几格恰恰遮住了"它绕回去了"这件事。
          const back = y2 < y1;
          const d = back
            ? `M ${x1} ${y1} C ${x1 + 26} ${y1 + 10}, ${x2 + 26} ${y2 - 10}, ${x2} ${y2}`
            : `M ${x1} ${y1} C ${x1} ${y1 + (y2 - y1) * 0.45}, ${x2} ${y2 - (y2 - y1) * 0.45}, ${x2} ${y2}`;
          // **上游那一步成功,这条线才算"送过去了"** —— 没成功 / 没走这条路,下游拿
          // 不到产出,线就应该是灰的。
          const carried = run?.nodes[edge.from]?.status === "success";
          return (
            <path
              key={edge.id}
              data-edge-id={edge.id}
              data-carried={carried ? "1" : undefined}
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
          const title = live?.title || node.title || node.type;
          const cx = box.x + box.w / 2;
          const cy = box.y + box.h / 2;
          // 左边留内边距,右边留状态记号的位置;剩下的才是字的地方。
          const label = fitTitle(title, box.w - PAD_X * 2 - GLYPH_W);
          /** 名字下面那一行：**状态 + 耗时**（见下面那个 `<text>` 的注释）。 */
          const subLabel = subLabelOf(key, live, t);
          const glyphX = box.x + box.w - PAD_X - 5;
          return (
            <g
              key={node.id}
              onClick={() => onSelectNode(node.id)}
              onContextMenu={
                onContextNode
                  ? (e) => {
                      e.preventDefault();
                      onContextNode({ nodeId: node.id, x: e.clientX, y: e.clientY });
                    }
                  : undefined
              }
              className="cursor-pointer"
              role="button"
              data-node-id={node.id}
            >
              <rect
                x={box.x}
                y={box.y}
                width={box.w}
                height={box.h}
                rx={5}
                data-selected={selected ? "1" : undefined}
                fill={style.fill}
                stroke={selected ? "rgb(var(--accent))" : style.stroke}
                strokeWidth={selected ? 2 : 1.2}
                strokeDasharray={style.dash}
              />
              {/* **正在执行的那一格:方框外面套一道转动的弧。** 这就是用户要的"转圈
                  效果" —— 它压在方框上,一眼看到的不是"这一格有色",而是"这一格在动"。
                  弧绕方框中心旋转(transformOrigin 给中心点),停下就不画。 */}
              {key === "running" && (
                <g
                  data-spinner="1"
                  className="motion-safe:animate-spin"
                  style={{
                    transformOrigin: `${cx}px ${cy}px`,
                    animationDuration: "1.4s",
                  }}
                >
                  <rect
                    x={box.x - 2}
                    y={box.y - 2}
                    width={box.w + 4}
                    height={box.h + 4}
                    rx={7}
                    fill="none"
                    stroke="rgb(var(--accent))"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeDasharray={`${(box.w + box.h) * 0.5} ${(box.w + box.h) * 1.6}`}
                  />
                </g>
              )}
              {/* **节点名。** 这一行是"图上什么都没有"那条抱怨的正解。 */}
              <text
                x={box.x + PAD_X}
                y={box.y + 14}
                fontSize={LABEL_PX}
                fill={LOUD.has(key) ? "rgb(var(--content))" : "rgb(var(--content-subtle))"}
                data-node-label={node.id}
              >
                {label}
              </text>
              {/* **状态那一行小字**（2026-09-21）。用户：「流程图信息丰富一点，不要只是
                  一个名字」。名字回答"这一步是什么"，这一行回答"**它现在怎么了**" ——
                  而后者才是用户盯着这张图时要的东西。
                  ⚠️ 措辞复用 `WorkflowNodeCard` 那一套（`chatStream.workflowStep.*`），
                  不另造一份 —— 同一件事在两个地方两种说法，是这个仓库反复出过的问题。 */}
              <text
                x={box.x + PAD_X}
                y={box.y + BOX_H - 7}
                fontSize={SUB_PX}
                fill={rgbOf(key)}
                data-node-sub={node.id}
              >
                {subLabel}
              </text>
              {/* 状态记号。**小尺寸下形状比颜色可靠** —— 绿和灰在色弱眼里可能是同一
                  种颜色,但有没有那一笔是看得见的。 */}
              {key === "success" && (
                <path
                  d={`M ${glyphX - 5} ${cy} l 3.5 3.5 l 6.5 -7.5`}
                  fill="none"
                  stroke="rgb(var(--success))"
                  strokeWidth={1.8}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )}
              {key === "failed" && (
                <path
                  d={`M ${glyphX - 4} ${cy - 4} l 8 8 M ${glyphX + 4} ${cy - 4} l -8 8`}
                  fill="none"
                  stroke="rgb(var(--danger))"
                  strokeWidth={1.8}
                  strokeLinecap="round"
                />
              )}
              {/* 「在等你」标一个问号 —— 整张图停在这里,必须一眼看出来。 */}
              {key === "awaiting" && (
                <text
                  x={glyphX}
                  y={cy + 4}
                  textAnchor="middle"
                  fontSize={12}
                  fontWeight={700}
                  fill="rgb(var(--warning))"
                >
                  ?
                </text>
              )}
              {/* 排队中:一个空心圆点,与"在执行"那道转动的弧区分开。 */}
              {key === "queued" && (
                <circle
                  cx={glyphX}
                  cy={cy}
                  r={3}
                  fill="none"
                  stroke="rgb(var(--content-subtle))"
                  strokeWidth={1.2}
                />
              )}
              <title>{title}</title>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** 看板上那条横分隔条自己带的类名 —— 调用方和夹具都用它认这一条。 */
export const FLOW_DIVIDER_CLASS = "wf-flow-divider";
