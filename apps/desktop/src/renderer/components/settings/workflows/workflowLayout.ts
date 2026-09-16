/**
 * 画布的几何 —— 全是纯函数:不 import React、不碰 `api`、不读 i18n。
 *
 * ## 为什么尺寸写死而不是量 DOM
 *
 * 卡片高度固定(一行标题 + 一行摘要,都是单行截断),所以"同层对齐"是一次算术,
 * 不需要等布局完成再测量。去量 DOM 会把布局变成一件异步的事 —— 首帧先画错位置、
 * 量完再跳一下,而拖动时每一帧都要量。写死之后 {@link autoLayout} 是纯函数,可以
 * 在 `scripts/workflow-view-smoke` 里直接断言。
 *
 * ## 坐标的约定
 *
 * 所有坐标都是**画布坐标系**的左上角,不是屏幕坐标。原点在左上,`CANVAS_PAD` 是
 * 四周留白。拖动被**夹在 ≥ 0**(见 `WorkflowCanvas`),所以坐标不会变负 ——
 * {@link canvasSize} 因此只需要往右下量。
 */
import {
  CELL_H,
  CELL_W,
  NODE_H,
  NODE_W,
  topoLayers,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowPosition,
} from "@contracts/workflow";

// 卡片尺寸与 {@link autoLayout} **定义在 contracts** —— 主进程也要用同一份给"AI 建出来的
// 图"排坐标(见那边的注释)。这里原样转出去,是因为画布和冒烟脚本一直从本模块取它们。
export { autoLayout, LAYER_GAP, NODE_H, NODE_W, SIBLING_GAP } from "@contracts/workflow";

/** 画布四周留白:节点贴着边不好拖,也看不出图的边界在哪。 */
export const CANVAS_PAD = 32;
/** 空画布的最小尺寸:一个没有内容的 div 高度是 0,既没有落点也没有滚动条。 */
export const MIN_CANVAS_W = 520;
export const MIN_CANVAS_H = 260;

/**
 * **回头边**(目标在源上面的那种)绕行用的车道。
 *
 * 回头边不能走常规那条曲线:上下两点在同一列时,那条曲线基本就是一根竖线,会把中间
 * 那几张卡片从上到下穿个透。所以它要绕到旁边一条**没东西的竖带**上去上行 ——
 * 挑哪条竖带见 {@link backEdgeLanes}。
 *
 * `LANE_INSET` 是车道离它左边那张卡片留多少。一开始是按"整张图最右边那张卡片再往外"
 * 挑的,真跑起来看太靠外了:图里只要有一张靠右的卡片(比如另一条支路的终点),这条线
 * 就被顶到整张图外面去绕一大圈 —— 明明它只需要从旁边那一列空当过去。
 */
export const LANE_INSET = 12;
export const LANE_GAP = 12;
/** 拐上车道之前先往下走这么远,拐下来之后再往上收这么远 —— 贴着卡片角会打结。 */
const LANE_STUB = 18;
/** 车道拐弯的圆角半径(实际会按各段长度再夹一次)。 */
const LANE_CORNER = 8;
/** 找空当时的扫描上界 —— 免得写坏的输入让循环跑很久。 */
const LANE_SCAN = 64;

/** 一块矩形。节点与 {@link firstFreeSlot} 的候选位置共用。 */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 节点在画布坐标系里占的那块。只给 {@link firstFreeSlot} 用 —— 画布那边算的是
 *  **容器坐标**(还要加 `CANVAS_PAD`),不是这个。 */
function nodeBox(node: WorkflowNode): Box {
  return { x: node.position.x, y: node.position.y, w: NODE_W, h: NODE_H };
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** 找空位时最多扫几列几行 —— 一个上界,免得写坏的输入让循环跑很久。 */
const SCAN_COLS = 8;
const SCAN_ROWS = 64;

/**
 * 给新节点找一个不与任何现有节点重叠的落点。
 *
 * **先往右铺,铺满了再往下一行**(行优先)。这是刻意的:流程是**从上往下**走的,所以
 * "新的一步"该落在下面那一行;横着铺满一行(同层的并列步骤)再往下,和人的读图顺序一致。
 * 画布本来就自适应内容尺寸、外面能滚,往下长多少都放得下。
 */
export function firstFreeSlot(nodes: WorkflowNode[]): WorkflowPosition {
  const taken = nodes.map(nodeBox);
  for (let row = 0; row < SCAN_ROWS; row++) {
    for (let col = 0; col < SCAN_COLS; col++) {
      const candidate: Box = { x: col * CELL_W, y: row * CELL_H, w: NODE_W, h: NODE_H };
      if (!taken.some((box) => overlaps(box, candidate))) {
        return { x: candidate.x, y: candidate.y };
      }
    }
  }
  // 上界用尽(理论上要 512 个节点才会到)。重叠也比返回一个会飞出画布的坐标强。
  return { x: 0, y: 0 };
}

/** 全部卡片在**容器坐标**里的右边缘。没有卡片时就是左边的留白。 */
export function contentRight(nodes: WorkflowNode[]): number {
  let right = 0;
  for (const node of nodes) {
    right = Math.max(right, node.position.x + NODE_W);
  }
  return right + CANVAS_PAD;
}

/**
 * 给每一条**回头边**挑一条车道(容器坐标里的横坐标),返回 `edgeId → x`。
 *
 * ## 挑的是"这条线自己要经过的那条竖带",不是整张图的右边
 *
 * 一条回头边从源的下边出去、上行到目标的上边进来,它只**经过**那么一条竖着的带子
 * (纵向从目标的上边一直到底边那条横线)。所以只需要在那条带子里找一个**没有卡片横跨**
 * 的空当就行 —— 从两端右边那个空当起步(同层的兄弟之间本来就留了 `SIBLING_GAP`),
 * 被谁挡住就跳到它右边再试。
 *
 * 按"整张图的右边缘再往外"挑是错的,而且错得很显眼:图里只要有一张靠右的卡片(比如
 * 另一条支路的终点),**每一条**回头边都会被顶到整张图外面去绕一大圈,哪怕它只需要从
 * 旁边那一列过去。用户的原话:「这个线有点太靠外了」。
 *
 * ## 多条回头边各占一条
 *
 * 已经占掉的车道当成障碍,后来的从它右边 `LANE_GAP` 处继续找 —— 两条回头边叠在一条
 * 线上就分不清哪条是哪条了。顺序取 `edges` 里出现的先后,同一张图每次算出来都一样。
 *
 * 写成纯函数是为了能在 `scripts/workflow-view-smoke` 里直接断言"车道确实落在空当里、
 * 而且没有一张卡片横跨它" —— 这两条是这件事全部的难点,靠看是看不出来的。
 */
export function backEdgeLanes(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
): Map<string, number> {
  const boxes = nodes.map((node) => ({
    x: node.position.x + CANVAS_PAD,
    y: node.position.y + CANVAS_PAD,
    w: NODE_W,
    h: NODE_H,
  }));
  const boxOf = new Map(nodes.map((node, i) => [node.id, boxes[i]]));
  const out = new Map<string, number>();
  const taken: number[] = [];

  for (const edge of edges) {
    const from = boxOf.get(edge.from);
    const to = boxOf.get(edge.to);
    if (!from || !to || !isBackEdge(from, to)) continue;
    // 这条线纵向要占的那一段(含两端各 `LANE_STUB` 的出头)。横跨这一段任何一处的
    // 卡片,都是这条线的障碍。
    const top = to.y - LANE_STUB;
    const bottom = from.y + from.h + LANE_STUB;
    const blocks = boxes.filter((b) => b.y < bottom && top < b.y + b.h);

    // 从两端右边起步 —— 那里本来就是空当(节点之间至少有 `SIBLING_GAP`)。
    let x = Math.max(from.x + from.w, to.x + to.w) + LANE_INSET;
    for (let guard = 0; guard < LANE_SCAN; guard++) {
      const inCard = blocks.find((b) => x >= b.x && x < b.x + b.w);
      if (inCard) {
        x = inCard.x + inCard.w + LANE_INSET;
        continue;
      }
      const clash = taken.find((t) => Math.abs(t - x) < LANE_GAP);
      if (clash !== undefined) {
        x = clash + LANE_GAP;
        continue;
      }
      break;
    }
    out.set(edge.id, x);
    taken.push(x);
  }
  return out;
}

/**
 * 装得下全部节点(含四周留白)的画布尺寸。坐标不为负,所以只往右下量。
 *
 * `lanes` 是全部回头边的车道横坐标 —— 车道可能比所有卡片都靠右(它绕的那条带上正好
 * 有张卡片的时候),所以宽度要取"内容右边缘"和"最外面那条车道"里更靠右的那个,再留
 * 一圈和另外三边一样宽的留白。不先把宽度留出来的话,最外面那条会画到画布外(画布就是
 * 那个固定尺寸的 div,超出去的部分既不显示也滚不到)。不给就是空数组 —— 没有回头边的
 * 图,宽度与以前逐像素相同。
 */
export function canvasSize(
  nodes: WorkflowNode[],
  lanes: readonly number[] = [],
): { width: number; height: number } {
  let bottom = 0;
  for (const node of nodes) {
    bottom = Math.max(bottom, node.position.y + NODE_H);
  }
  const right = lanes.length > 0 ? Math.max(contentRight(nodes), ...lanes) : contentRight(nodes);
  return {
    width: Math.max(MIN_CANVAS_W, right + CANVAS_PAD),
    height: Math.max(MIN_CANVAS_H, bottom + CANVAS_PAD * 2),
  };
}

/**
 * 这条边是不是**回头边** —— 目标整个在源的上面。
 *
 * 判据只看纵向:层号大的一律排在下面(见 {@link autoLayout}),所以"往回流"在几何上
 * 就是"往上指"。同层之间的边不算(它们没有上下之分,常规那条曲线画得出来)。
 */
export function isBackEdge(from: Box, to: Box): boolean {
  return to.y < from.y;
}

/**
 * 一条依赖边的 SVG 路径。
 *
 * **常规边**:从 `from` 的**下边中点**,到 `to` 的**上边中点**,三次贝塞尔。
 *
 * 控制点**垂直外推** —— 出线先往下走、入线从上面进来。流程是从上往下走的,这样哪怕
 * 目标在源的左边或右边,曲线也是"先出去再拐",不会横穿中间的卡片。外推量取两点垂直
 * 距的一半但不小于 28px:两个节点被拖到重叠位置(或者并排的兄弟之间连线)时,曲线仍然
 * 有可见的弧度而不是退化成一条直线。
 *
 * **回头边**(传了 `lane`):从源的下边出去 → 拐到右边的车道上行 → 从目标的上边进去。
 * 三个直角都倒成圆角。**必须给车道**,见 {@link laneX}:不给的话两点在同一列时曲线
 * 就是一根竖线,会一路穿过中间那几张卡片。
 *
 * 目标那端传一个**宽高为 0 的盒子**就是"连到某个点" —— 拉连线时的预览曲线走的就是
 * 这条路径(`x2/y2` 直接落在那一点上),不另写一份曲线算法。
 */
export function edgePath(from: Box, to: Box, lane?: number): string {
  const x1 = from.x + from.w / 2;
  const y1 = from.y + from.h;
  const x2 = to.x + to.w / 2;
  const y2 = to.y;
  if (lane === undefined) {
    const bend = Math.max(28, Math.abs(y2 - y1) * 0.45);
    return `M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`;
  }
  // 出去先下沉到 `out` 这条横线上,收回来时停在 `back` 那条横线上 —— 两条都落在层与层
  // 之间的空当里(层间距 68,这里用 18),不会压在卡片角上。
  const out = y1 + LANE_STUB;
  const back = y2 - LANE_STUB;
  // 圆角不能大过任何一段的一半,否则倒角会互相吃掉、路径自己打结。
  const r = Math.min(
    LANE_CORNER,
    LANE_STUB / 2,
    (lane - x1) / 2,
    (lane - x2) / 2,
    (out - back) / 4,
  );
  return [
    `M ${x1} ${y1}`,
    `L ${x1} ${out - r}`,
    `Q ${x1} ${out} ${x1 + r} ${out}`,
    `L ${lane - r} ${out}`,
    `Q ${lane} ${out} ${lane} ${out - r}`,
    `L ${lane} ${back + r}`,
    `Q ${lane} ${back} ${lane - r} ${back}`,
    `L ${x2 + r} ${back}`,
    `Q ${x2} ${back} ${x2} ${back + r}`,
    `L ${x2} ${y2}`,
  ].join(" ");
}

/**
 * 一条边的中点,用来放"删掉这条依赖"那个小圆钮。
 *
 * **常规边**:不用真去算曲线 —— 上面那两个控制点是把两端垂直外推同一个 `bend`,代入
 * 三阶伯恩斯坦多项式之后,含 `bend` 的两项系数相同、符号相反,在 t=0.5 处正好抵消,
 * 于是 B(0.5) 恰好等于两端点的中点。所以取平均即可 —— 以后改外推规则也不会让这个
 * 按钮跑偏。
 *
 * **回头边**:落在那段垂直的车道上。按曲线长度算中点也可以(那条路是第一段 18 + 上行
 * + 最后一段 18),但按钮的位置是给眼睛找的,不是给数学找的 —— 车道正中间最好认。
 */
export function edgeMidpoint(from: Box, to: Box, lane?: number): { x: number; y: number } {
  if (lane !== undefined) {
    return { x: lane, y: (from.y + from.h + to.y) / 2 };
  }
  return {
    x: (from.x + from.w / 2 + to.x + to.w / 2) / 2,
    y: (from.y + from.h + to.y) / 2,
  };
}

/**
 * 命中测试:哪个节点压在这个点上。`pad` 把每张卡片向外撑一圈,拖连线时"放到边上"
 * 也算数(指针停在卡片边框上是最容易发生的事)。
 *
 * 取**最后一个**命中的 —— `Map` 按插入序遍历,而插入顺序就是 `nodes` 的顺序,
 * 也就是绘制顺序,所以最后一个就是最上面那张。
 */
export function hitTestNode(
  boxes: Map<string, Box>,
  x: number,
  y: number,
  pad = 0,
): string | null {
  let hit: string | null = null;
  for (const [id, b] of boxes) {
    if (x >= b.x - pad && x <= b.x + b.w + pad && y >= b.y - pad && y <= b.y + b.h + pad) {
      hit = id;
    }
  }
  return hit;
}
