/**
 * 右栏的**运行看板** —— 上面一张小流程图,下面一列**这一步的卡**。
 *
 * ## 它解决的是哪件事
 *
 * 图跑起来之后,对话流里只有**已经收场的**那些卡(一步跑完才画一张)。在那之前用户看不到
 * 任何信息:不知道当前执行到第几步、同时有几个在跑、卡在哪一格等人,也不知道哪一步的产出
 * 正在交给谁。这一页把这三件事列出来:
 *
 *  1. **小流程图** —— 哪一步在执行、哪几步已完成、哪一步失败、数据从哪儿流向哪儿;
 *  2. **一步一张卡** —— 执行中的排最上面,已收场的在下面;点开**原地**展开它说过什么、
 *     调了什么工具,想跟它说话就在那里说;
 *  3. **需要用户接管的那一格** —— 失败或被取消时顶部展示一条,点击直接展开那一步。
 *
 * ## 一条数据:现场 + 库里,按节点 id **合成一张卡**(2026-09-20 重做)
 *
 * 上一版是**两栏**:上面"这次运行的现场"(`workflow.node.*` 事件折出来的,跟着进程存活),
 * 下面"这些步骤留着会话"(`session.listNodes` 读回来的,已落盘)。两栏都列了同一批
 * 步骤 —— 而且 `nodeSessionOf` **复用**同一个 `(对话, 节点)` 会话,所以现场那一格和
 * 库里那一行往往指**同一段对话**:用户在上面点进去,下面那行还写着同一个名字。
 *
 * 现在按 `nodeId` 合成**一张卡**:现场那份有就填现场那几项(阶段、进度、耗时),没有就
 * 退回库里那几项(会话 id、上次更新时间)。两条路的**内容**不同,卡片都放得下 ——
 * 见 `WorkflowNodeCard` 文件头那张表。
 *
 * ## 数据只有一份:主进程发来的事件
 *
 * 现场那部分全部来自 `workflowLive`(见那个文件的头注)—— 它折的是 `workflow.node.*`
 * 那几条事件。这里**不重新读库**:事件是"此刻"的真相,而库里那份是"上次存下来"的。
 * 两者混用会出现"看板上说在执行、其实早已停止"。库里那份只在**现场完全没有这一步**时
 * 才补位(重启之后)。
 *
 * ## 图长什么样是另读一次
 *
 * 形状(有哪几步、怎么连的)在 `workflow.get` 里,它不跟事件走 —— 用户在设置里改了图,
 * 这里下次打开才看得到新形状。这是**刻意**的:那次运行按的是**当时**那份图,
 * 中途换掉形状反而会让看板和实际执行的步骤对不上。
 *
 * **读哪张图**看的是**这次运行**的 `workflowId`,没有运行才退回输入框选中的模式
 * (2026-09-26 改,见 `workflowLive.ts` 的 `boardWorkflowIdOf`)。从前只看后者 ——
 * 图跑着时换了药丸、或者跑的是自动化,看板就拿另一张图的格子去对这次运行,整张图灰着。
 *
 * ## 手机端要包住
 *
 * `api.workflow.get` 在手机端的 web shim 里不存在 —— 访问它会**同步抛**
 * (见 `lib/webApi.ts` 的文件头),所以那个调用包在 try/catch 里。这里少一张图,
 * 但列表照常显示。
 */
import { useEffect, useMemo, useState } from "react";
import { Menu } from "@base-ui/react/menu";
import type { WorkflowDoc } from "@contracts/workflow";
import { cn } from "@renderer/lib/cn.js";
import { api } from "@renderer/lib/api.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useCursorAnchor } from "@renderer/hooks/useCursorAnchor.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useToastStore } from "@renderer/stores/toastStore.js";
import { MENU_ITEM_CLASS, SidebarMenu } from "@renderer/components/sidebar/Sidebar.js";
import {
  useWorkflowLive,
  dismissSettled,
  boardWorkflowIdOf,
  type LiveNode,
  type LiveRun,
} from "@renderer/lib/workflowLive.js";
import { Divider } from "@renderer/components/layout/Divider.js";
import { SideChatPanel } from "@renderer/components/chat/SideChatPanel.js";
import {
  FLOW_DIVIDER_CLASS,
  FLOW_H_MAX,
  FLOW_H_MIN,
  FLOW_MAX_H,
  WorkflowFlowMini,
  type FlowContextTarget,
} from "@renderer/components/chat/WorkflowFlowMini.js";
import {
  BoardNodeCard,
  phaseOf,
  type NodeView,
} from "@renderer/components/chat/BoardNodeCard.js";
import {
  IconAlertTriangle,
  IconPlayerPlay,
  IconRobotFace,
  IconSparkles,
  IconTrash,
} from "@renderer/lib/icons.js";
import { UI_WORKFLOW_BOARD_FLOW_HEIGHT_SETTING_KEY } from "@contracts/ipc/settingsSync";

/** 图那一块的高度存在哪个 setting 键下。和右栏宽度用同一个做法:面板自己的一个
 *  小偏好,不值得单开一个设置页。键本身住在 contracts —— 它在「跟着屏幕走」的表里
 *  (手机上拖的高度不改桌面的,见 `@contracts/ipc/settingsSync`)。 */
const FLOW_HEIGHT_SETTING_KEY = UI_WORKFLOW_BOARD_FLOW_HEIGHT_SETTING_KEY;

/**
 * 现场那一格 → 卡片要的形状。
 *
 * 标题取 `LiveNode.title`(事件带过来的 —— 图上改了名它跟着变),没有则退回节点类型 id。
 */
function viewOfLive(node: LiveNode): NodeView {
  return {
    nodeId: node.nodeId,
    runId: node.runId,
    live: true,
    title: node.title || node.nodeType,
    nodeType: node.nodeType,
    phase: phaseOf(node),
    nodeSessionId: node.nodeSessionId,
    nodeTranscript: node.nodeTranscript,
    summary: node.summary,
    error: node.error,
    startedAt: node.startedAt,
    endedAt: node.endedAt,
    percent: node.percent,
    awaiting: node.awaiting,
    options: node.options,
    attempt: node.attempt,
    ask: node.ask,
    chosen: node.chosen,
    comment: node.comment,
  };
}

/**
 * 库里那一行 → 卡片要的形状。**它没在执行**,所以阶段是 `idle`、没有产出、没有耗时。
 * 这几项**如实留空**,不编造:编一个"成功"出来,用户会以为那次运行成功了。
 *
 * 标题取图上那一步的名字(`nodeId` 去图里查,查不到退回会话行自己的标题 —— 图改过名
 * 或者那一步后来被删了,就只剩它了)。`node_type` 会话行上**没有**这一列:节点类型是
 * 图上的属性,不是会话的属性,所以这里也不编造。
 */
function viewOfStored(
  s: { id: string; nodeId: string | null; title: string; updatedAt: number },
  doc: WorkflowDoc | null,
): NodeView {
  const node = s.nodeId ? doc?.nodes.find((n) => n.id === s.nodeId) : undefined;
  return {
    nodeId: s.nodeId ?? s.id,
    live: false,
    title: node?.title || s.title,
    nodeType: node?.type ?? "",
    phase: "idle",
    nodeSessionId: s.id,
    storedAt: s.updatedAt,
  };
}

export function WorkflowBoardPanel() {
  const { t } = useI18n();
  const sessionId = useSessionStore((s) => s.activeSessionId);
  const workflowId = useSessionStore((s) => s.workflowId);
  const live = useWorkflowLive();
  /** 图长什么样。读不到就只画下半部分(提示词型工作流没有节点)。 */
  const [doc, setDoc] = useState<WorkflowDoc | null>(null);
  /** 展开了哪一张卡 —— **一次只开一张**(手风琴):展开的卡会把列表推下去,同时展开几张
   *  的话"我刚点的是哪张"又要靠找。 */
  const [openId, setOpenId] = useState<string | null>(null);
  /** 选中一条会话（子对话 / 节点会话都走它）—— 见下面 `onPick` 那段。 */
  const selectSideChat = useSessionStore((s) => s.selectSideChat);

  /**
   * **点流程图上一格 = 同时打开下面那条对话**（2026-09-21，用户要求）。
   *
   * ## 为什么不是"只选中"
   *
   * 从前点一格只是把它选中、展开它那张**步骤卡**。而步骤卡已经删了（下面换成了对话
   * 列表，见那一段注释）—— 所以"选中"不再有受体，点下去什么都不会发生。
   *
   * 图上每一格背后本来就是**一条会话**（`live.nodes[id].nodeSessionId`），而下面那个
   * 列表正是列它们的。所以点一格最自然的语义就是"**打开这一格的会话**"——
   * 用户的原话：「可以点击上面的工作流节点就能**同时打开下面的对话窗口**」。
   *
   * ⚠️ **选中态和打开会话是两件事，都要做**：`setOpenId` 让图上那一格高亮（看得出
   * "我现在在看谁"），`selectSideChat` 让下半部分切到那条会话。只做后者的话图上是
   * 灰的，用户分不清自己点的是哪一格。
   *
   * 没跑过的格子**没有会话**（`nodeSessionId` 缺席）—— 那时只选中，不切面板。
   */
  const pickNode = (nodeId: string): void => {
    setOpenId((prev) => (prev === nodeId ? null : nodeId));
    const nodeSessionId = run?.nodes[nodeId]?.nodeSessionId;
    if (nodeSessionId) void selectSideChat(nodeSessionId);
  };
  /** 库里**还留着会话**的那几步(见 `viewOfStored`)。
   *
   *  看板上半部分的现场跟着进程存活,重启即空 —— 而节点会话是落库的。这一份就是那个
   *  落差:没有它,"跟这一步接着说"只在没关过软件的期间成立。 */
  const [stored, setStored] = useState<
    Array<{ id: string; nodeId: string | null; title: string; updatedAt: number }>
  >([]);
  /** 图上那一块拖成多高了。**存在设置里**,下次打开还是上次拖到的高度。 */
  const [flowH, setFlowH] = useState(FLOW_MAX_H);
  /** 右键点了哪一格(以及点在屏幕的哪一点)。`null` = 菜单关着。 */
  const [ctxNode, setCtxNode] = useState<FlowContextTarget | null>(null);

  // 读回上次拖到的高度。读不到就用默认值 —— 第一次打开、或者这条设置还没写过。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.setting.get({ key: FLOW_HEIGHT_SETTING_KEY });
        const n = res.value === null ? NaN : Number(res.value);
        if (!cancelled && Number.isFinite(n)) {
          setFlowH(Math.min(FLOW_H_MAX, Math.max(FLOW_H_MIN, Math.round(n))));
        }
      } catch {
        // 手机端 web shim 没有这个命名空间 —— 用默认高度即可,不必打扰用户。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** 拖分隔条:夹在上下限之间,**立刻**写进设置。
   *
   *  为什么每次都写而不是松手再写:`Divider` 报的是增量,拖动结束没有回调。每次写一条
   *  设置的开销很低(主进程里就是一个 upsert),而漏写最后一次的话用户拉到的位置下次就
   *  丢了 —— 那比多写几十次严重得多。 */
  const resizeFlow = (delta: number): void => {
    setFlowH((prev) => {
      const next = Math.min(FLOW_H_MAX, Math.max(FLOW_H_MIN, prev + delta));
      if (next !== prev) {
        void api.setting
          .set({ key: FLOW_HEIGHT_SETTING_KEY, value: String(next) })
          .catch(() => {});
      }
      return next;
    });
  };

  /** 双击分隔条 → 还原默认高度(同时把设置里的值也改回去)。 */
  const resetFlowH = (): void => {
    setFlowH(FLOW_MAX_H);
    void api.setting
      .set({ key: FLOW_HEIGHT_SETTING_KEY, value: String(FLOW_MAX_H) })
      .catch(() => {});
  };

  /** 这个对话的现场。取**最近一次开始**的那一次 —— 一个对话同时只跑一张图
   *  (`graphRunIntent` 保证了),留"最近"是为了执行完之后还看得见刚才那张图的收场状态。 */
  const run: LiveRun | null = useMemo(() => {
    if (!sessionId) return null;
    let best: LiveRun | null = null;
    for (const r of Object.values(live.runs)) {
      if (r.sessionId !== sessionId) continue;
      if (!best || r.startedAt > best.startedAt) best = r;
    }
    return best;
  }, [live.runs, sessionId]);

  /** 画哪张图:这次运行按的那张优先(见文件头「图长什么样是另读一次」)。 */
  const boardWorkflowId = boardWorkflowIdOf(run, workflowId);

  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    setOpenId(null);
    if (!boardWorkflowId) return;
    void (async () => {
      try {
        const res = await api.workflow.get({ id: boardWorkflowId });
        if (!cancelled) setDoc(res.workflow);
      } catch {
        // 手机端 web shim 没有这个命名空间(见文件头)—— 当没有图。
        if (!cancelled) setDoc(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [boardWorkflowId]);

  const halted = sessionId ? live.halted[sessionId] : undefined;

  /*
   * 库里还留着会话的那几步。**按对话读,不跟图走** —— 换过图之后老那几步的会话也还在,
   * 而它们恰恰是"我以前跟这一步聊过"的那一栏;按当前图过滤会把它们凭空抹掉。
   *
   * ⚠️ 这里包 try/catch —— 少一块列表,不该让整棵 React 树卸载(手机端尤其)。
   *
   * 依赖里带上 `run`:一次运行收场之后新建的节点会话要立刻出现,否则用户得关掉右栏
   * 再打开才看得到刚执行过的那一步。
   */
  useEffect(() => {
    let cancelled = false;
    if (!sessionId) {
      setStored([]);
      return;
    }
    void (async () => {
      try {
        const res = await api.session.listNodes({ sessionId });
        if (!cancelled) setStored(res.sessions);
      } catch {
        if (!cancelled) setStored([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, run]);

  /**
   * 现场的那些格子,**没结束的排最上面**。稳定排序 —— 同一档里保持派发顺序,否则每来
   * 一条事件列表就会跳动。
   */
  const liveRows = useMemo(() => {
    if (!run) return [];
    return run.order
      .map((id) => run.nodes[id])
      .filter((n): n is LiveNode => n !== undefined)
      .sort((a, b) => (a.phase === "settled" ? 1 : 0) - (b.phase === "settled" ? 1 : 0));
  }, [run]);

  /**
   * **合成一张卡:** 先按现场那一趟的顺序排列,库里那些**现场没有的**接在后面。
   *
   * 库里那些为什么要按 `nodeId` 去重而不是按会话 id:现场格子可能还没有 `nodeSessionId`
   * (排队中 / 正在执行但还没落会话),那时按会话 id 去不掉重,同一格会出现两张。节点 id 才
   * 是"这一步"的身份 —— 会话 id 是"它这次执行在哪个会话里"。
   */
  const cards = useMemo<NodeView[]>(() => {
    const out = liveRows.map(viewOfLive);
    const seen = new Set(out.map((n) => n.nodeId));
    for (const s of stored) {
      const view = viewOfStored(s, doc);
      if (seen.has(view.nodeId)) continue;
      seen.add(view.nodeId);
      out.push(view);
    }
    return out;
  }, [liveRows, stored, doc]);

  const doneCards = cards.filter((c) => c.live && c.phase !== "running" && c.phase !== "queued" && c.phase !== "awaiting");

  if (!sessionId) {
    return (
      <p className="px-3 py-6 text-center text-xs text-content-subtle">
        {t("sideChat.noMainSession")}
      </p>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-edge bg-surface px-2.5">
        <IconSparkles size={14} className="shrink-0 text-accent" />
        <div className="min-w-0 flex-1 truncate text-xs text-content-muted">
          {doc?.name ?? t("chatStream.workflowBoard.title")}
        </div>
      </div>

      {/* **上半：工作流图**。它自己滚（图可能比这一块高），**不跟下面那块一起滚** ——
          用户要的是"上面是图、下面是列表"两块，不是一整条长页面。 */}
      <div className="shrink-0 overflow-y-auto">
        <RenderMini
          doc={doc}
          run={run}
          picked={openId}
          onPick={pickNode}
          height={flowH}
          onResize={resizeFlow}
          onResetHeight={resetFlowH}
          onContextNode={setCtxNode}
        />
      </div>

      {/* 兜底：这一步没跑起来 / 停在等人 —— 那一行仍然要看得见。 */}
      {halted && (
        <div className="shrink-0">
          <HaltedBanner
            reason={halted.reason}
            title={run?.nodes[halted.nodeId]?.title || halted.nodeId}
            onOpen={() => setOpenId(halted.nodeId)}
          />
        </div>
      )}

      {/* **下半：对话列表 / 那条对话的完整侧边**（2026-09-21 改）。
          ——
          从前进这里的是**工作流步骤卡**（每一格一张）。用户要求换成**对话列表**：
          「上面是工作流图片，下面是代理列表」—— 同一批东西（图上每一格就是一个子代理
          的会话），只是换个说法看：图回答"跑到第几步"，列表回答"跟他说话"。

          直接把 `SideChatPanel` 整个嵌进来，而不是照它再写一份 —— 那个面板已经是
          "列表 ⇄ 用 `ChatPane` 展开一条"的完整两态实现，正是用户要复用的那一套
          （「对话展开的样式就是之前的子对话页面的展开的样子，你直接复用」）。

          ## ⚠️ 两个坑（第一版都踩了）

          1. **它必须和上图平级，不能塞进图那个滚动容器里。** 塞进去的话它自己的
             `flex-1` / `overflow-y-auto` 全部失效 —— 它跟着图的滚动条一起滚，
             而没有自己的高度。
          2. **它展开一条对话时是"整个面板 return 掉"**（见 `SideChatPanel` 的
             `view === "chat"` 那一支）。所以下面这一块要有自己的高度预算
             （`flex-1`），上面那块（`shrink-0`）才不会被顶掉 —— 用户的原话是
             「显示一个完整的侧边，**但是上面的工作流还是保留的**」。
      */}
      <div className="min-h-0 flex-1 border-t border-edge">
        <SideChatPanel />
      </div>

      <FlowNodeMenu
        target={ctxNode}
        run={run}
        sessionId={sessionId}
        onClose={() => setCtxNode(null)}
        onOpenCard={(nodeId) => setOpenId(nodeId)}
      />
    </div>
  );
}

/**
 * 图上右键某一格的菜单。
 *
 * ## 只有一项:「从这一步开始跑」
 *
 * 走的是**已有的那条后端路径** `workflow.retry`。契约里写明了它有两种入口 —— 失败卡片
 * 上的「再试一次」、以及「图上挑一步说『从这儿往下走』」 —— 判据与执行路径完全一样,
 * 区别只是带不带那句 note(见 `WorkflowRetrySchema` 的注释)。所以这里不需要新契约、
 * 也不需要碰主进程。
 *
 * ## 什么时候置灰
 *
 * 只有**这次运行还在现场**的节点才带 `runId`,而 `workflow.retry` 需要它。重启之后从库
 * 里读回来的那些卡片没有 `runId`(`runs.history` 只给轻量摘要,不含每一步的产出)——
 * 那时菜单项置灰并说明原因,而不是点下去什么都不发生。
 */
function FlowNodeMenu({
  target,
  run,
  sessionId,
  onClose,
  onOpenCard,
}: {
  target: FlowContextTarget | null;
  run: LiveRun | null;
  sessionId: string | null;
  onClose: () => void;
  onOpenCard: (nodeId: string) => void;
}) {
  const { t } = useI18n();
  const anchor = useCursorAnchor(target);
  const node = target && run ? run.nodes[target.nodeId] : undefined;
  const runId = node?.runId;
  const canRun = !!target && !!sessionId && !!runId;

  const startFrom = (): void => {
    if (!target || !sessionId || !runId) return;
    // 先展开那一张卡:整张图跑起来之后,用户要看的正是这一步 —— 不展开的话他得自己
    // 在列表里再找一遍。
    onOpenCard(target.nodeId);
    onClose();
    void (async () => {
      try {
        // `note` 不给:契约里写明了主进程只在"这一步上次真的失败过"时才用它,而
        // 从图上挑起点时用户并没有写过(见 `WorkflowRetrySchema`)。
        const res = await api.workflow.retry({ sessionId, runId, nodeId: target.nodeId });
        if (!res.ok) {
          // `ok: false` **不是异常**(那次运行已经收尾 / 正有运行在跑)—— 但不说话的话
          // 用户点了没有反应,只能以为它坏了。给一句能读懂的提示。
          useToastStore.getState().push({
            kind: "warning",
            title: t("chatStream.workflowBoard.runFromHereFailed"),
            ...(res.error ? { body: res.error } : {}),
            sessionId,
          });
        }
      } catch (err) {
        useToastStore.getState().push({
          kind: "error",
          title: t("chatStream.workflowBoard.runFromHereFailed"),
          body: err instanceof Error ? err.message : String(err),
          sessionId,
        });
      }
    })();
  };

  return (
    <SidebarMenu open={target !== null} anchor={anchor} onClose={onClose} minWidth={180}>
      <Menu.Item
        disabled={!canRun}
        onClick={startFrom}
        className={cn(MENU_ITEM_CLASS, !canRun && "cursor-not-allowed opacity-40")}
      >
        <IconPlayerPlay size={12} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate" title={canRun ? undefined : t("chatStream.workflowBoard.runFromHereStale")}>
          {t("chatStream.workflowBoard.runFromHere")}
        </span>
      </Menu.Item>
    </SidebarMenu>
  );
}

/**
 * 上半那张图 + 它与卡片列表之间那条**可上下拖的横分隔条**。没有节点(提示词型工作流 /
 * 读不到)就整块不画。
 *
 * ## 图能拖多高,记在设置里
 *
 * 用户要的是"图小一点",但小到什么程度因人而异 —— 图复杂的时候想拉大看全,只看一眼
 * 状态的时候想拉小。所以给一条分隔条,拖完存进 setting(和右栏的宽度同一个做法),
 * 下次打开还是上次拖到的高度。双击还原默认。
 *
 * ## 为什么高度是**给到图那个框**上,而不是给这块容器
 *
 * 图自己那一份 `overflow-y-auto` 才是"装不下就滚动"的地方 —— 把高度给到它,滚的是图,
 * 而不是连图带空白一起滚。容器只管"这一块占多高"。
 */
function RenderMini({
  doc,
  run,
  picked,
  onPick,
  height,
  onResize,
  onResetHeight,
  onContextNode,
}: {
  doc: WorkflowDoc | null;
  run: LiveRun | null;
  picked: string | null;
  onPick: (id: string) => void;
  height: number;
  onResize: (delta: number) => void;
  onResetHeight: () => void;
  onContextNode: (target: FlowContextTarget) => void;
}) {
  const { t } = useI18n();
  if (doc === null || doc.nodes.length === 0) return null;
  return (
    <div className="shrink-0">
      <div className="px-2.5 py-2">
        <WorkflowFlowMini
          doc={doc}
          run={run}
          selectedNodeId={picked}
          onSelectNode={onPick}
          onContextNode={onContextNode}
          maxHeight={height}
        />
      </div>
      {/* 那条分隔条。**双击还原** —— 拖偏了不用去猜默认值是多少。`hideLine={false}`
          给一条看得见的细线:它同时表达"图到这儿为止"和"这里可拖"两层意思。

          ⚠️ **上一条「上下拖，调流程图的高度（双击还原）」的提示行删掉了**（2026-09-21，
          用户：「直接删掉，就一条线分割开就行」）—— 那条线自己已经说明了"这里分开"，
          再挂一行小字只是在图下面多一条要读的东西。 */}
      <Divider
        orientation="horizontal"
        onResize={onResize}
        onDoubleClick={onResetHeight}
        className={FLOW_DIVIDER_CLASS}
      />
    </div>
  );
}

/** 顶上那条「这一步需要用户处理」。三种原因三种文案 —— **不能合并成一句**:失败要重试、
 *  停在岔路口要选一条、被取消要重跑整张图,用户要做的事完全不同。 */
function HaltedBanner({
  reason,
  title,
  onOpen,
}: {
  reason: "failed" | "cancelled" | "awaiting";
  title: string;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  const tone =
    reason === "failed"
      ? "border-danger/40 bg-danger/5 text-danger"
      : reason === "awaiting"
        ? "border-warning/40 bg-warning/5 text-warning"
        : "border-edge bg-surface-muted text-content-muted";
  const label =
    reason === "failed"
      ? t("chatStream.workflowBoard.haltedFailed", { title })
      : reason === "awaiting"
        ? t("chatStream.workflowBoard.haltedAwaiting", { title })
        : t("chatStream.workflowBoard.haltedCancelled", { title });
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "mx-2.5 mt-2 flex w-[calc(100%-1.25rem)] items-start gap-1.5 rounded-md border px-2 py-1.5 text-left text-[11px] leading-relaxed transition-colors hover:brightness-110",
        tone,
      )}
    >
      <IconAlertTriangle size={12} className="mt-0.5 shrink-0" />
      <span className="min-w-0 flex-1">{label}</span>
    </button>
  );
}
