/**
 * 工作流运行看板的状态(`workflow.node.*` 事件到界面之间那一段)。
 *
 * ## 为什么单独一个文件,而且只有一份
 *
 * 用户要的是右栏那两样东西 —— **一张小流程图**(跑到哪一格就在哪一格转圈)和
 * **一列分身**(谁在跑、谁跑完了)。两者看的是**同一批事实**,而且都必须在卡片还没画
 * 出来的时候就看见("正在跑"的那一格没有卡片,卡片是收场才有的)。
 *
 * 所以这里是**运行态的汇总点**:事件进来 → 折成"这次运行各节点现在什么样" → 谁订阅
 * 谁读。放进 `sessionStore` 的话,那几个几千行、每次事件都要重建的大表会跟着一起动
 * (而看板上的东西是**另一个维度**的:一张图有几步、每步什么状态,和消息流没关系);
 * 放组件里的话,关掉右栏再打开就什么都不记得了。
 *
 * ## 卡片那条路不受影响
 *
 * 消息流里的进度卡 / 结果卡**照旧**走 `sessionStore` 的 block(`workflow-node-progress`
 * / `workflow-node-result`)。这里不代替它们,只是**多记一份**给看板用 —— 所以删掉这个
 * 文件对话里的东西一样在,删不掉。
 *
 * ## 订阅是常驻的(2026-09-26 改;从前是惰性的)
 *
 * 从前同 `workflowQueued.ts`:第一个订阅者出现才挂 `api.on.claudeEvent`,最后一个退订
 * 就摘。**这是用户说「画布实时进度效果很差」的根因之一**:看板只在右栏开着**且**停在
 * 「流程」页时才挂载(`RightPanel.tsx` 的 `tab === "flow"`),于是图起跑时右栏关着、
 * 或者停在文件 / 终端页,那段时间的事件一条都不收 —— 之后再打开看板,已经在跑、已经
 * 跑完的格子全是灰的,看起来像"图根本没动"。而这些事件不落盘,错过就补不回来。
 *
 * 现在 `App` 启动时调一次 {@link startWorkflowLive},从此常驻、不再摘。代价可以忽略:
 * 过滤只比 `type` 的四个字面量,别的事件进来就走;状态有 `MAX_RUNS` 封顶。
 * 组件照旧经 `useWorkflowLive` 订阅 —— 没调过 `startWorkflowLive` 的环境(手机端、
 * 无头脚本)退回原来的惰性行为,不会更差。
 *
 * ## 这份状态是**临时的**,不是存档
 *
 * 它跟着进程活。应用重启之后看板是空的 —— 但**存档还在**(`workflow_runs` 表,见
 * `runStore.ts`),点开某一步的卡片仍然看得到它的过程和使用量。这里只回答一个问题:
 * **此刻**,这张图的哪几格在转圈。
 */
import { useSyncExternalStore } from "react";
import type { RuntimeEvent, TranscriptBlock, WorkflowChoiceOption } from "@contracts/runtime";
import { api } from "@renderer/lib/api.js";

/** 一步此刻的样子。和消息流里那张卡的状态**不是同一套** —— 这里多了"正在排队"和
 *  "正在跑",那两种恰恰是卡片上永远看不见的(卡片是收场才画的)。 */
export type LiveNodePhase =
  /** 排上了队,还没起跑(并发满了/依赖刚满足)。 */
  | "queued"
  /** 起来了,正在跑。 */
  | "running"
  /** 收场了 —— 具体成没成看 `status`。 */
  | "settled";

/** 收场状态。与 `WorkflowNodeResultEvent["status"]` 同义(见 `@contracts/runtime`)。 */
export type LiveNodeStatus = "success" | "failed" | "skipped" | "unselected" | "cancelled";

export interface LiveNode {
  nodeId: string;
  /** 哪一次运行。**每一个节点上各带一份** —— 看板从"某一格"直接就能去重试它,
   *  不用再往上问一次"这是哪次运行里的格"(那条链要穿过 `runs` 的键)。 */
  runId: string;
  /** 节点类型 id(`mcode.agent`)。等宽显示,不翻译。 */
  nodeType: string;
  /** 图上的标题。 */
  title: string;
  phase: LiveNodePhase;
  /** 只在 `settled` 时有。 */
  status?: LiveNodeStatus;
  /** 跑这一步的隐藏子会话,卡片和过程面板靠它取内容。**没跑过的节点没有**。 */
  nodeSessionId?: string;
  /** 收场那一刻的过程快照(见 `sessionStore` 的 `NODE_ARCHIVE_KEEP` 那一段)。
   *
   *  看板的详情面板和消息流里那张卡读的是**同一份**过程,所以这里也得带上它 ——
   *  只认 `nodeSessionId` 的话,过程被容量裁掉之后(或者会话重开之后)点开详情是空的,
   *  而消息流里那张同样的卡却有内容。两处不一致比两处都空更难解释。 */
  nodeTranscript?: TranscriptBlock[];
  /** 这一步**交出了什么**(结果事件的 `summary`,失败时是空的)。
   *
   *  详情面板上"收场时那一句结论"读的就是它。之前那一格读的是 `message`,而
   *  `message` 只跟着 progress 来、收场时被 `patchNode` 清掉 —— 于是那一格**从来没
   *  显示过**(`!live && node.message` 恒假)。产出因此只在消息流那张卡上有,看板里
   *  点开某一步反而看不到它做了什么。 */
  summary?: string;
  /** 失败的原因(结果事件的 `error`)。成功/跳过的节点没有。 */
  error?: string;
  /** 跑起来的时刻(ms)。看板拿它显示"跑了多久"。 */
  startedAt?: number;
  /** 收场的时刻(ms)。 */
  endedAt?: number;
  /** 进度卡上那一行小字 / 百分比。只跟着 `progress` 走。 */
  percent?: number;
  message?: string;
  /** 这一步在等用户拍板(岔路口 / 对话节点的「运行前先问我」)。 */
  awaiting?: boolean;
  /** 等什么 —— 岔路口那一张卡要摆的按钮。 */
  options?: WorkflowChoiceOption[];
  /** `awaiting` 时,这一问是第几轮(回头绕第二圈时是 2)。 */
  attempt?: number;
  /** 这是「运行前先问我」那一问(不是岔路口)。 */
  ask?: boolean;
  /** 用户已经选了什么(`awaiting` 期间为空)。 */
  chosen?: string;
  /** 用户在卡片上补的那句话。 */
  comment?: string;
}

/** 一次运行。 */
export interface LiveRun {
  runId: string;
  sessionId: string;
  workflowId: string;
  /** 第一次见到它的时刻 —— 列表按它倒序(新的在上面)。 */
  startedAt: number;
  /** 最后一次有任何动静的时刻。用来判"这次运行还在动吗"。 */
  touchedAt: number;
  /** 节点 id → 那一步。顺序按**第一次见到**排(也就是派发顺序)。 */
  nodes: Record<string, LiveNode>;
  /** 派发顺序。`Record` 不保证顺序,看板按这个数组走。 */
  order: string[];
}

export interface WorkflowLiveSnapshot {
  /** `runId` → 这次运行。 */
  runs: Record<string, LiveRun>;
  /**
   * 上一次运行**结束**在了哪个节点上,或者停在哪一格等人。
   *
   * 「结束」= 有一步失败/取消,而且此后没有新的派发 —— 那时对话流是停着的,用户要
   * 有人告诉他"问题出在这一步"。看板据此给出一句可点的提示。按 `sessionId` 索引。
   */
  halted: Record<string, { runId: string; nodeId: string; reason: "failed" | "cancelled" | "awaiting" }>;
}

/** 运行态的键:一次运行里,一步。 */
function nodeKey(sessionId: string, runId: string, nodeId: string): string {
  return `${sessionId}\u0000${runId}\u0000${nodeId}`;
}

/** 一份运行最多记多少步。一张图几百个节点是病态输入,不是用法。 */
const MAX_NODES_PER_RUN = 500;
/** 最多留几次运行的现场。用户点开旧卡片时那些卡片自己会画,不靠这里。 */
const MAX_RUNS = 24;

let snapshot: WorkflowLiveSnapshot = { runs: {}, halted: {} };
const listeners = new Set<() => void>();

let unsubscribe: (() => void) | null = null;
/** 钉住了就不摘(见文件头「订阅是常驻的」)。只有 {@link startWorkflowLive} 会置真。 */
let pinned = false;

/** 事件源的形状 —— 就是 `api.on.claudeEvent`。单列一个名字是为了测试能换一个假的进来。 */
type ClaudeEventSource = typeof api.on.claudeEvent;

function emit(next: WorkflowLiveSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

/** 换掉一次运行里的某一步。返回新的 `runs`(没变就原样返回,靠引用相等跳过重渲染)。
 *
 * `phase` **可以不给** —— 那样就沿用上一次那个(`choice` 那条事件改的是"在不在等人",
 * 阶段本身没变;非要它给的话每次都得把当前阶段抄一遍,抄漏一处就是状态回退)。 */
function patchNode(
  runs: Record<string, LiveRun>,
  sessionId: string,
  runId: string,
  workflowId: string,
  nodeId: string,
  patch: Partial<Omit<LiveNode, "nodeId" | "phase">> & {
    nodeType: string;
    title: string;
    phase?: LiveNodePhase;
  },
): Record<string, LiveRun> {
  const now = Date.now();
  const prevRun = runs[runId];
  const created: LiveRun = prevRun ?? {
    runId,
    sessionId,
    workflowId,
    startedAt: now,
    touchedAt: now,
    nodes: {},
    order: [],
  };
  // **四条事件现在都带 `workflowId`**(queued/progress/result/choice,见
  // `@contracts/runtime`)。从前的形状只有 `queued` 带,于是 progress/result 先到的那次
  // 运行只能记空串、等后续带它的事件补上 —— 一个事实在两处口径不一。现在事件自带就
  // 直接用;调用点传 `e.workflowId ?? runs[e.runId]?.workflowId ?? ""`,老/畸形事件
  // (没带)仍走这条兜底。只补空的,不覆盖。
  const run: LiveRun =
    created.workflowId === "" && workflowId !== "" ? { ...created, workflowId } : created;
  const prevNode = run.nodes[nodeId];
  if (prevNode) {
    const merged: LiveNode = { ...prevNode, ...patch, phase: patch.phase ?? prevNode.phase };
    // `awaiting` 只在传了的时候改 —— 否则收场事件会把"在等人"这个事实抹掉。
    if (patch.awaiting === undefined) merged.awaiting = prevNode.awaiting;
    if (patch.options === undefined) merged.options = prevNode.options;
    if (patch.ask === undefined) merged.ask = prevNode.ask;
    if (patch.attempt === undefined) merged.attempt = prevNode.attempt;
    if (patch.chosen === undefined) merged.chosen = prevNode.chosen;
    if (patch.comment === undefined) merged.comment = prevNode.comment;
    // 收场清掉"在等人"和进度 —— 那两样是跑到一半才有的事。
    if (merged.phase === "settled") {
      delete merged.awaiting;
      delete merged.options;
      delete merged.ask;
      delete merged.percent;
      delete merged.message;
    }
    if (patch.startedAt === undefined && prevNode.startedAt !== undefined) {
      merged.startedAt = prevNode.startedAt;
    }
    if (patch.nodeSessionId === undefined && prevNode.nodeSessionId !== undefined) {
      merged.nodeSessionId = prevNode.nodeSessionId;
    }
    // 同 `nodeSessionId`:补充事件(补花费那条不带过程)不该把它抹掉。
    if (patch.nodeTranscript === undefined && prevNode.nodeTranscript !== undefined) {
      merged.nodeTranscript = prevNode.nodeTranscript;
    }
    return {
      ...runs,
      [runId]: {
        ...run,
        touchedAt: now,
        nodes: { ...run.nodes, [nodeId]: merged },
      },
    };
  }
  if (run.order.length >= MAX_NODES_PER_RUN) return runs;
  /** 新的一格:没给阶段的就是刚排队(调用方不给,只可能是"第一次见到它、当时正在
   *  派发"那种情况)。 */
  const fresh: LiveNode = { nodeId, runId, ...patch, phase: patch.phase ?? "queued" };
  return {
    ...runs,
    [runId]: {
      ...run,
      touchedAt: now,
      nodes: { ...run.nodes, [nodeId]: fresh },
      order: [...run.order, nodeId],
    },
  };
}

/**
 * 这个对话现在停在哪儿等人 / 停在哪一步失败上。
 *
 * 判据故意写得**保守**:只有"最后一次运行里有一格在等人"或者"最后一格是失败/取消,
 * 而且这次运行里**每一格都收场了**"时才给。给早了会在图还在往下跑的时候报"卡住了"。
 *
 * 「每一格都收场了」而不是「没有一格在跑」——**排着队的那几格也算没走完**。一次运行里
 * 有一步炸了、但它的下游刚被派发进队列,那一刻图是在动的;只看"有没有在跑"的话,排队
 * 那几格还没起跑,于是会误报"卡在失败的那一步",而用户去看时它已经跑完了。
 */
function haltedOf(runs: Record<string, LiveRun>): WorkflowLiveSnapshot["halted"] {
  const out: WorkflowLiveSnapshot["halted"] = {};
  const latest = new Map<string, LiveRun>();
  for (const run of Object.values(runs)) {
    const prev = latest.get(run.sessionId);
    if (!prev || run.startedAt >= prev.startedAt) latest.set(run.sessionId, run);
  }
  for (const [sessionId, run] of latest) {
    let waiting: string | null = null;
    let lastSettled: LiveNode | null = null;
    let unfinished = false;
    for (const nodeId of run.order) {
      const node = run.nodes[nodeId];
      if (!node) continue;
      if (node.awaiting) waiting = nodeId;
      // `queued` 也算没走完 —— 见函数头注:只看"有没有在跑"会把"刚派发完下游"误报成卡住。
      if (node.phase !== "settled") unfinished = true;
      if (node.phase === "settled") lastSettled = node;
    }
    if (waiting !== null) {
      out[sessionId] = { runId: run.runId, nodeId: waiting, reason: "awaiting" };
      continue;
    }
    // 还在等排队的格子起跑,或者一格都还没有 —— 都不是"停住了"。
    if (unfinished || lastSettled === null) continue;
    if (lastSettled.status === "failed" || lastSettled.status === "cancelled") {
      out[sessionId] = {
        runId: run.runId,
        nodeId: lastSettled.nodeId,
        reason: lastSettled.status,
      };
    }
  }
  return out;
}

function recompute(runs: Record<string, LiveRun>): WorkflowLiveSnapshot {
  return { runs, halted: haltedOf(runs) };
}

/** 只留最近 `MAX_RUNS` 次运行的现场(按最后动静的时刻)。 */
function prune(runs: Record<string, LiveRun>): Record<string, LiveRun> {
  const ids = Object.keys(runs);
  if (ids.length <= MAX_RUNS) return runs;
  ids.sort((a, b) => (runs[a]?.touchedAt ?? 0) - (runs[b]?.touchedAt ?? 0));
  const drop = new Set(ids.slice(0, ids.length - MAX_RUNS));
  const next: Record<string, LiveRun> = {};
  for (const id of ids) if (!drop.has(id)) next[id] = runs[id] as LiveRun;
  return next;
}

function apply(e: RuntimeEvent): void {
  const runs = snapshot.runs;
  switch (e.type) {
    case "workflow.node.queued":
      emit(
        recompute(
          patchNode(runs, e.sessionId, e.runId, e.workflowId, e.nodeId, {
            // 标题要等 progress/result 才带过来 —— 排队那一刻只有 id 三件套。先占个位,
            // 看板拿不到标题时回落成类型 id(同 `nodeTitle` 的做法)。
            nodeType: runs[e.runId]?.nodes[e.nodeId]?.nodeType ?? "",
            title: runs[e.runId]?.nodes[e.nodeId]?.title ?? "",
            phase: "queued",
          }),
        ),
      );
      return;

    case "workflow.node.progress":
      emit(
        recompute(
          patchNode(runs, e.sessionId, e.runId, e.workflowId ?? runs[e.runId]?.workflowId ?? "", e.nodeId, {
            nodeType: e.nodeType,
            title: e.title,
            phase: "running",
            startedAt: runs[e.runId]?.nodes[e.nodeId]?.startedAt ?? Date.now(),
            // 夹到 0..100:**和消息流那张卡同一个上限**(见 `sessionStore` 的
            // `reduceWorkflowNodeProgress`)。不夹的话同一份进度在两处显示成不同的
            // 数,而进度条那边按百分比算宽度,超了会画出格子。
            ...(e.percent !== undefined
              ? { percent: Math.max(0, Math.min(100, e.percent)) }
              : {}),
            ...(e.message ? { message: e.message } : {}),
          }),
        ),
      );
      return;

    case "workflow.node.result":
      emit(
        recompute(
          prune(
            patchNode(runs, e.sessionId, e.runId, e.workflowId ?? runs[e.runId]?.workflowId ?? "", e.nodeId, {
              nodeType: e.nodeType,
              title: e.title,
              phase: "settled",
              status: e.status,
              summary: e.summary,
              ...(e.error ? { error: e.error } : {}),
              endedAt: Date.now(),
              ...(e.nodeSessionId !== undefined ? { nodeSessionId: e.nodeSessionId } : {}),
              // 过程快照跟着结果事件一起到(见 `sessionStore` 与 `@contracts/runtime`
              // 的 `WorkflowNodeResultEvent.transcript`)—— 看板拿它当 `nodeSessionId`
              // 查不到时的退路。
              ...(e.transcript !== undefined && e.transcript.length > 0
                ? { nodeTranscript: e.transcript }
                : {}),
            }),
          ),
        ),
      );
      return;

    case "workflow.node.choice": {
      const settled = e.chosen !== undefined;
      emit(
        recompute(
          patchNode(runs, e.sessionId, e.runId, e.workflowId ?? runs[e.runId]?.workflowId ?? "", e.nodeId, {
            nodeType: e.nodeType,
            title: e.title,
            // **不给 `phase`** —— 选完了不是收场,图从这一格接着往下跑,阶段还是"在跑";
            // 真收场会有它自己的 `result`(分支节点则压根没有那条事件:它的卡就是这一张,
            // 见 `@contracts/runtime`)。
            //
            // 在等的时候才摆选项;选完了就把那一格收掉(用户已经点过了)。`awaiting: false`
            // 要显式给 —— 只"不传"的话 `patchNode` 会沿用上一次那个 `true`,卡片选完了
            // 还一直显示"在等你"。
            ...(settled
              ? { awaiting: false, chosen: e.chosen, ...(e.comment ? { comment: e.comment } : {}) }
              : { awaiting: true, options: e.options }),
            ...(e.attempt !== undefined ? { attempt: e.attempt } : {}),
            ...(e.ask ? { ask: true } : {}),
          }),
        ),
      );
      return;
    }

    default:
      return;
  }
}

function ensureSubscribed(on: ClaudeEventSource = api.on.claudeEvent): void {
  if (unsubscribe !== null) return;
  unsubscribe = on((msg) => {
    const event = msg?.event;
    if (event === undefined) return;
    const type = event.type;
    if (
      type !== "workflow.node.queued" &&
      type !== "workflow.node.progress" &&
      type !== "workflow.node.result" &&
      type !== "workflow.node.choice"
    ) {
      return;
    }
    if (typeof event.sessionId !== "string" || typeof event.runId !== "string") return;
    apply(event);
  });
}

function releaseIfIdle(): void {
  if (pinned || listeners.size > 0 || unsubscribe === null) return;
  unsubscribe();
  unsubscribe = null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  ensureSubscribed();
  return () => {
    listeners.delete(listener);
    releaseIfIdle();
  };
}

/** 整份运行现场。右栏那两样东西都从它读 —— **一个订阅点**,不是两条事件流。 */
export function useWorkflowLive(): WorkflowLiveSnapshot {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot,
  );
}

/**
 * 常驻订阅:应用启动时调一次(`App.tsx`),之后看板开不开、停在哪一页,事件都照记。
 * 见文件头「订阅是常驻的」。重复调用无害(`ensureSubscribed` 自己判重)。
 */
export function startWorkflowLive(): void {
  pinned = true;
  ensureSubscribed();
}

/**
 * 看板该画哪张图:**这次运行实际按的那张优先**,没有(还没跑过 / 现场里没记到)才退回
 * 输入框当前选中的模式。
 *
 * 从前只看后者(`sessionStore.workflowId`)—— 那是"**下一句话**按哪个模式跑"的槽位,
 * 不是"**这次运行**按哪张图"。两者一分叉(图跑着时用户换了药丸,或者是自动化起的运行),
 * 看板就拿 A 图的格子去对 B 图的现场:一格都对不上,整张图灰着,正在跑的那一格根本
 * 不在图上 —— 和"没接通"看起来一模一样。
 */
export function boardWorkflowIdOf(
  run: Pick<LiveRun, "workflowId"> | null,
  selected: string,
): string {
  return run !== null && run.workflowId !== "" ? run.workflowId : selected;
}


/**
 * 把这次运行里**已经收场**的那些格子从看板上抹掉 —— 用户说的"跑完的可以直接清理掉"。
 *
 * ## 抹的是看板上的现场,不是任何存档
 *
 * 那些步骤的卡片、过程、用量全在消息流和 `workflow_runs` 表里,一个字节都不动。这里
 * 清掉的只是"看板此刻还记着它们"这件事 —— 清完之后右栏只剩还在跑的那几格(以及一张
 * 空图),而往下滚对话仍然看得到每一步做过什么。
 *
 * ## 为什么按"抹掉收场的"而不是"抹掉整次运行"
 *
 * 一次运行的收场格和进行格会同时存在(并行的那几步里有一个先跑完)。清掉整次会把正在
 * 跑的那格也从看板上拿掉 —— 而它恰恰是用户此刻唯一还在乎的东西。
 *
 * **一格都不剩时整次运行一起忘掉** —— 留一个空壳的话,看板会显示一张没有任何状态的
 * 图,而那和"这次运行我不管了"是一回事。
 */
export function dismissSettled(runId: string): void {
  const run = snapshot.runs[runId];
  if (run === undefined) return;
  const keep = run.order.filter((id) => run.nodes[id]?.phase !== "settled");
  let runs: Record<string, LiveRun>;
  if (keep.length === 0) {
    const { [runId]: _dropped, ...rest } = snapshot.runs;
    runs = rest;
  } else {
    const nodes: Record<string, LiveNode> = {};
    for (const id of keep) {
      const node = run.nodes[id];
      if (node) nodes[id] = node;
    }
    runs = { ...snapshot.runs, [runId]: { ...run, nodes, order: keep } };
  }
  emit(recompute(runs));
}

/** 测试用:把状态清回初始(冒烟脚本里每个用例之间要隔离)。 */
export function __resetWorkflowLive(): void {
  snapshot = { runs: {}, halted: {} };
}

/**
 * 测试用:把一条事件直接喂进折叠器,返回折叠之后的那份现场。
 *
 * **为什么不能靠真的订阅**:无头脚本用 `react-dom/server` 渲染,而
 * `useSyncExternalStore` 是在 **effect** 里订阅的 —— SSR 不跑 effect,于是
 * `api.on.claudeEvent` 永远不会被挂上,一条事件也进不来。这里绕开"事件从 IPC 来"
 * 那一层,直接验**折叠规则本身**(阶段流转、`awaiting` 的存与清、收场清进度、裁剪、
 * 停在哪儿等人)—— 那才是这个文件里会长出 bug 的部分。
 */
export function __applyWorkflowLiveEvent(e: RuntimeEvent): WorkflowLiveSnapshot {
  apply(e);
  return snapshot;
}

/** 测试用:读当前那份现场(不喂事件)。`dismissSettled` 那类不经过事件的写入要靠它验。 */
export function __workflowLiveSnapshot(): WorkflowLiveSnapshot {
  return snapshot;
}

/**
 * 测试用:同 {@link startWorkflowLive},但事件源由调用方给 —— 无头脚本里 `api` 是桩,
 * 挂不上真的事件流。返回一个拆除函数:摘掉事件源、清回"没订阅、没钉住",用例之间隔离。
 */
export function __startWorkflowLiveWith(on: ClaudeEventSource): () => void {
  pinned = true;
  ensureSubscribed(on);
  return () => {
    pinned = false;
    unsubscribe?.();
    unsubscribe = null;
  };
}

/** 测试用:走一遍"最后一个组件退订了"那条路,返回此刻事件源是否还挂着。 */
export function __releaseWorkflowLiveIfIdle(): boolean {
  releaseIfIdle();
  return unsubscribe !== null;
}


/** Select a continuation ID without importing persisted outcomes into live state. */
export function boardContinuationRunId(
  run: LiveRun | null,
  history: readonly import("@contracts/ipc").PersistedWorkflowRunLite[],
  sessionId: string | null,
  workflowId: string | null,
): string | undefined {
  if (!sessionId || !workflowId) return undefined;
  if (run?.sessionId === sessionId && run.workflowId === workflowId) return run.runId;
  // useRpc retains its previous data during key changes. Never reuse another
  // session's row, or jump over its latest run to an older, different graph.
  const latest = history.filter((row) => row.sessionId === sessionId)
    .reduce<import("@contracts/ipc").PersistedWorkflowRunLite | undefined>(
      (best, row) => !best || row.createdAt > best.createdAt ? row : best, undefined);
  return latest?.workflowId === workflowId ? latest.runId : undefined;
}
