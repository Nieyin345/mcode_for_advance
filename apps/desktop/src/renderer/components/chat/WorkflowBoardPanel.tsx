/**
 * 右栏的**运行看板** —— 上方一张小流程图,下方一列"分身"。
 *
 * ## 它解决的是哪件事
 *
 * 图跑起来之后,对话流里只有**收场了的**那些卡(一步跑完才画一张)。在那之前用户看不到
 * 任何东西:不知道现在跑到第几步、同时有几个在跑、卡在哪一格等人,也不知道哪一步的产出
 * 正在喂给谁。这一页把这三件事摆出来:
 *
 *  1. **小流程图** —— 哪一格在转、哪几格成了、哪一格炸了、数据从哪儿流到哪儿;
 *  2. **分身列表** —— 正在跑的排在最上(带进度和走时),跑完的在下面(整组可折叠);
 *  3. **要你接管的那一格** —— 失败或被取消时顶上顶一条,点一下直接跳到那一步。
 *
 * ## 数据只有一份:主进程发来的事件
 *
 * 全部来自 `workflowLive`(见那个文件的头注)—— 它折的是 `workflow.node.*` 那几条
 * 事件。这里**不重新读库**:事件是"此刻"的真相,而库里那份是"上次存下来"的。两者混用
 * 会出现"看板上说在跑、其实早停了"。
 *
 * ## 图长什么样是另读一次
 *
 * 形状(有哪几步、怎么连的)在 `workflow.get` 里,它不跟事件走 —— 用户在设置里改了图,
 * 这里下次打开才看得到新形状。这是**刻意**的:跑起来的那次运行按的是**当时**那份图,
 * 中途把形状换掉反而会让看板和实际跑的步骤对不上。
 *
 * ## 手机端要包住
 *
 * `api.workflow.get` 在手机端的 web shim 里不存在 —— 访问它会**同步抛**
 * (见 `lib/webApi.ts` 的文件头),所以那个调用包在 try/catch 里。这里少一张图,
 * 但列表照常显示。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { WorkflowDoc } from "@contracts/workflow";
import { cn } from "@renderer/lib/cn.js";
import { api } from "@renderer/lib/api.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useWorkflowLive, dismissSettled, type LiveNode, type LiveRun } from "@renderer/lib/workflowLive.js";
import { useQueuedNode } from "@renderer/lib/workflowQueued.js";
import { Markdown } from "@renderer/components/chat/Markdown.js";
import { MessageBlocks } from "@renderer/components/chat/MessageBlocks.js";
import { mapTranscriptBlock } from "@renderer/components/chat/transcriptBlocks.js";
import { RetryNodeDialog } from "@renderer/components/chat/RetryNodeDialog.js";
import { Button } from "@renderer/components/ui/button.js";
import {
  WorkflowFlowLegend,
  WorkflowFlowMini,
} from "@renderer/components/chat/WorkflowFlowMini.js";
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconChevronDown,
  IconChevronRight,
  IconCircleCheck,
  IconCircleOff,
  IconMessage,
  IconPlayerStop,
  IconRefresh,
  IconRobotFace,
  IconSparkles,
  IconTrash,
  SpinnerIcon,
} from "@renderer/lib/icons.js";

/** 一步在列表里的样子。**四个阶段 + 收场后的五种结论**,都收在这里 —— 每种给一个
 *  图标、一个颜色、一句词,漏了会在界面上显示成空白(所以是 `Record` 而不是几个 if)。 */
const PHASE_META: Record<keyof typeof PHASE_LABEL, { cls: string; spin?: boolean; icon: "check" | "warn" | "off" }> = {
  queued: { cls: "text-content-subtle", icon: "off" },
  running: { cls: "text-accent", spin: true, icon: "off" },
  awaiting: { cls: "text-warning", icon: "warn" },
  success: { cls: "text-accent", icon: "check" },
  failed: { cls: "text-danger", icon: "warn" },
  skipped: { cls: "text-content-subtle", icon: "off" },
  unselected: { cls: "text-content-subtle", icon: "off" },
  cancelled: { cls: "text-content-muted", icon: "off" },
};

const PHASE_LABEL: Record<string, MessageId> = {
  queued: "chatStream.workflowStep.queued",
  running: "chatStream.ledgerRunning",
  awaiting: "chatStream.workflowBoard.awaiting",
  success: "chatStream.workflowStep.success",
  failed: "chatStream.workflowStep.failed",
  skipped: "chatStream.workflowStep.skipped",
  unselected: "chatStream.workflowStep.unselected",
  cancelled: "chatStream.workflowStep.cancelled",
};

/** 这一格此刻算哪一档。**`awaiting` 压过一切** —— 在等人的那一格不点一下整张图就停着。 */
function phaseOf(node: LiveNode): keyof typeof PHASE_LABEL {
  if (node.awaiting) return "awaiting";
  if (node.phase === "settled") return node.status ?? "success";
  return node.phase;
}

export function WorkflowBoardPanel() {
  const { t } = useI18n();
  const sessionId = useSessionStore((s) => s.activeSessionId);
  const workflowId = useSessionStore((s) => s.workflowId);
  const live = useWorkflowLive();
  /** 图长什么样。读不到就只画下半部分(提示词型工作流没有节点)。 */
  const [doc, setDoc] = useState<WorkflowDoc | null>(null);
  /** 点开了哪一格 —— 列表行和流程图上的方块都写它。 */
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    setPicked(null);
    if (!workflowId) return;
    void (async () => {
      try {
        const res = await api.workflow.get({ id: workflowId });
        if (!cancelled) setDoc(res.workflow);
      } catch {
        // 手机端 web shim 没有这个命名空间(见文件头)—— 当没有图。
        if (!cancelled) setDoc(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workflowId]);

  /** 这个对话的现场。取**最近一次开始**的那一次 —— 一个对话同时只跑一张图
   *  (`graphRunIntent` 保证了),留"最近"是为了跑完之后还看得见刚才那张图的收场状态。 */
  const run: LiveRun | null = useMemo(() => {
    if (!sessionId) return null;
    let best: LiveRun | null = null;
    for (const r of Object.values(live.runs)) {
      if (r.sessionId !== sessionId) continue;
      if (!best || r.startedAt > best.startedAt) best = r;
    }
    return best;
  }, [live.runs, sessionId]);

  const halted = sessionId ? live.halted[sessionId] : undefined;

  /** 排好序的那些行:**没跑完的排最上**,收场的按派发顺序在下面。稳定排序 —— 同一档
   *  里保持派发顺序,不然每来一条事件列表就跳一下。 */
  const rows = useMemo(() => {
    if (!run) return [];
    return run.order
      .map((id) => run.nodes[id])
      .filter((n): n is LiveNode => n !== undefined)
      .sort((a, b) => (a.phase === "settled" ? 1 : 0) - (b.phase === "settled" ? 1 : 0));
  }, [run]);

  if (!sessionId) {
    return (
      <p className="px-3 py-6 text-center text-xs text-content-subtle">
        {t("sideChat.noMainSession")}
      </p>
    );
  }

  // 详情:点了某一格就进它。**图还在上面** —— 从详情里也看得到自己在整张图的哪儿。
  const pickedNode = picked ? run?.nodes[picked] : undefined;
  if (picked && pickedNode) {
    return (
      <div className="flex h-full flex-col">
        <RenderMini doc={doc} run={run} picked={picked} onPick={setPicked} />
        <NodeDetail sessionId={sessionId} node={pickedNode} onBack={() => setPicked(null)} />
      </div>
    );
  }

  const runningRows = rows.filter((n) => n.phase !== "settled");
  const doneRows = rows.filter((n) => n.phase === "settled");

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-edge bg-surface px-2.5">
        <IconSparkles size={14} className="shrink-0 text-accent" />
        <div className="min-w-0 flex-1 truncate text-xs text-content-muted">
          {doc?.name ?? t("chatStream.workflowBoard.title")}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <RenderMini doc={doc} run={run} picked={null} onPick={setPicked} />

        {/* 顶上那条「要你接管」。**比列表更醒目** —— 图停着的时候,列表里那一行只是
            "失败"两个字,而这条说得清是哪一步、点哪儿。 */}
        {halted && (
          <HaltedBanner
            reason={halted.reason}
            title={run?.nodes[halted.nodeId]?.title || halted.nodeId}
            onOpen={() => setPicked(halted.nodeId)}
          />
        )}

        {rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
            <IconRobotFace size={22} className="text-content-subtle" />
            <p className="text-xs font-medium text-content-muted">
              {t("chatStream.workflowBoard.emptyTitle")}
            </p>
            <p className="text-[11px] leading-relaxed text-content-subtle">
              {t("chatStream.workflowBoard.emptyHint")}
            </p>
          </div>
        ) : (
          <div className="p-1.5">
            {runningRows.length > 0 && (
              <Section
                title={t("chatStream.workflowBoard.runningSection")}
                count={runningRows.length}
              >
                {runningRows.map((n) => (
                  <NodeRow key={n.nodeId} node={n} onOpen={() => setPicked(n.nodeId)} />
                ))}
              </Section>
            )}
            {doneRows.length > 0 && (
              <DoneSection nodes={doneRows} onOpen={(id) => setPicked(id)} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** 上半那张图 + 图例。没有节点(提示词型工作流 / 读不到)就整块不画。 */
function RenderMini({
  doc,
  run,
  picked,
  onPick,
}: {
  doc: WorkflowDoc | null;
  run: LiveRun | null;
  picked: string | null;
  onPick: (id: string) => void;
}) {
  if (doc === null || doc.nodes.length === 0) return null;
  return (
    <div className="shrink-0 border-b border-edge px-2.5 py-2">
      <WorkflowFlowMini doc={doc} run={run} selectedNodeId={picked} onSelectNode={onPick} />
      <WorkflowFlowLegend className="mt-1.5" />
    </div>
  );
}

/** 「跑完的」那一组 —— **整组折起来**,而且**整组清掉**。
 *
 *  清掉的只是看板上的现场(见 `dismissSettled`):那些步骤的卡片、过程、用量一个字节
 *  都不动,往下滚对话仍然看得到每一步做过什么。用户说的是"跑完的可以收起来,也可以直接
 *  清理掉" —— 收是折一下,清理是这一颗。 */
function DoneSection({ nodes, onOpen }: { nodes: LiveNode[]; onOpen: (id: string) => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(true);
  const runId = nodes[0]?.runId;
  return (
    <div className="mt-2">
      <div className="flex items-center gap-1 rounded-md pr-1 hover:bg-surface-hover">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-2 py-1 text-left"
        >
          {open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
          <span className="text-[10px] font-semibold uppercase tracking-wide text-content-subtle">
            {t("chatStream.workflowBoard.doneSection")}
          </span>
          <span className="tabular-nums text-[10px] text-content-subtle">{nodes.length}</span>
        </button>
        {runId !== undefined && (
          <button
            type="button"
            title={t("chatStream.workflowBoard.clearDone")}
            onClick={() => dismissSettled(runId)}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-content-subtle transition-colors hover:text-content"
          >
            <IconTrash size={12} />
          </button>
        )}
      </div>
      {open && (
        <ul className="space-y-0.5">
          {nodes.map((n) => (
            <NodeRow key={n.nodeId} node={n} onOpen={() => onOpen(n.nodeId)} />
          ))}
        </ul>
      )}
    </div>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-1 px-2 pb-1 pt-1">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-content-subtle">
          {title}
        </span>
        <span className="tabular-nums text-[10px] text-content-subtle">{count}</span>
      </div>
      <ul className="space-y-0.5">{children}</ul>
    </div>
  );
}

function NodeRow({ node, onOpen }: { node: LiveNode; onOpen: () => void }) {
  const { t } = useI18n();
  // 「排队中」那一枚 chip。**必须给 `node.runId`** —— `workflowQueued` 的键是
  // `runId\0nodeId`,留空的话永远对不上,这枚 chip 一辈子不亮。`LiveNode` 上带着
  // runId 正是为了这个(见 `workflowLive` 的头注)。
  const queued = useQueuedNode(node.runId, node.nodeId);
  const key = phaseOf(node);
  const meta = PHASE_META[key] ?? PHASE_META.success;
  const elapsed = useElapsed(node);
  const sub = [t(PHASE_LABEL[key] ?? PHASE_LABEL.success), queued ? t("chatStream.workflowStep.queued") : null, elapsed]
    .filter(Boolean)
    .join(" · ");
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        title={node.title || node.nodeType}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-hover"
      >
        <span className={cn("flex h-3.5 w-3.5 shrink-0 items-center justify-center", meta.cls)}>
          {meta.spin ? (
            <SpinnerIcon size={12} className="animate-spin" />
          ) : meta.icon === "check" ? (
            <IconCircleCheck size={12} />
          ) : meta.icon === "warn" ? (
            <IconAlertTriangle size={12} />
          ) : (
            <IconCircleOff size={12} />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs text-content">{node.title || node.nodeType}</span>
          <span className="mt-0.5 block truncate text-[10px] text-content-subtle">{sub}</span>
        </span>
        {node.percent !== undefined && (
          <span className="shrink-0 tabular-nums text-[10px] text-accent">
            {Math.round(node.percent)}%
          </span>
        )}
      </button>
    </li>
  );
}

/** 「跑了多久」。**只有还在跑的那一行才挂定时器** —— 收场了的用 `endedAt - startedAt`
 *  一次算完,一屏几十行每行一个 interval 是白烧。 */
function useElapsed(node: LiveNode): string | null {
  const live = node.phase !== "settled";
  const [, tick] = useState(0);
  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [live]);
  if (node.startedAt === undefined) return null;
  const end = node.endedAt ?? Date.now();
  const sec = Math.max(0, Math.round((end - node.startedAt) / 1000));
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, "0")}s`;
}

/** 顶上那条「这一步要你看看」。三种原因三种话 —— **不能合成一句**:失败要重试、停在
 *  岔路口要选一条、被取消要重跑整张,用户要做的事完全不一样。 */
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

/**
 * 一步的详情:它跑了什么、成没成,以及**接管它的三个动作**。
 *
 * ## 过程是**活着**的
 *
 * 正在跑的那一步,过程跟着事件一段段长出来(`workflow.node.transcript` 推的是全量,
 * 见 `RuntimeManager.publishNodeTranscript`)—— 所以这里不用轮询,订阅到了就是最新的。
 * 这正是"子代理在干嘛"那个诉求的落点:不用等它跑完。
 *
 * ## 接管:结束 / 跟这一步说 / 跟主对话说
 *
 * 这三样来自用户对失败那一步的原话("用户可以选择结束,或者和子节点对话,或者是和主节点
 * 对话")。它们**不新开机制**:
 *
 *  - **结束** = `claude.interrupt`,而主进程那一头对工作流会话本来就走
 *    `cancelWorkflowRun`(停整张图,见 `ipc/claude.ts`)。所以"结束这一步"实际是"停下整张图"
 *    —— 用户看到的是这一步不再往下跑,而那正是他要的;
 *  - **跟这一步说** = 往这个节点会话发一条普通消息。它跑在**自己的隐藏会话**里
 *    (`kind: "node"`),`claude.sendTurn` 对它是一条普通回合,而它的产出会被调度器
 *    照常收走(见 `runner.outcomeOf`)—— 于是"聊完之后它接着干"是天然成立的;
 *  - **跟主对话说** = 把框里那段话塞进主对话的输入框草稿(`composerDraftBySession`),
 *    用户自己按发送。**不替他发** —— 主对话此刻可能正被这张图占着,直接发会被
 *    `graphRunIntent` 拒掉;而且"我先看看再发"本来就是更稳的那一步。
 *
 * ## 重试的判据和卡片**同一条**
 *
 * 消息流里那张卡给的是 `status === "failed" && nodeSessionId`,因为底层是同一个入口
 * (`workflow.retry`)。两处判据不一致的话,会出现"卡片上能点、看板上点不了"这种说不清
 * 的事。
 */
function NodeDetail({
  sessionId,
  node,
  onBack,
}: {
  sessionId: string;
  node: LiveNode;
  onBack: () => void;
}) {
  const { t } = useI18n();
  const rawBlocks = useSessionStore((s) =>
    node.nodeSessionId ? s.workflowNodeTranscripts[node.nodeSessionId] : undefined,
  );
  const blocks = useMemo(() => (rawBlocks ?? []).map(mapTranscriptBlock), [rawBlocks]);
  const [retryOpen, setRetryOpen] = useState(false);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const live = node.phase !== "settled";
  const key = phaseOf(node);
  const meta = PHASE_META[key] ?? PHASE_META.success;
  const canRetry = key === "failed" && node.nodeSessionId !== undefined;
  /** 能接管的是**失败**和**被取消**那两种 —— 跑成功的那一步没什么要接管的。 */
  const canTakeOver = key === "failed" || key === "cancelled";

  // 跟着尾巴走 —— 和子代理那份转录同一个意图(看它在干嘛,不是回头看开头)。
  useEffect(() => {
    if (live) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [blocks, live]);

  /** 跟**这一步**说一句。走的是它自己那个隐藏会话,所以它的产出照常交给调度器。 */
  const talkToNode = async (): Promise<void> => {
    const text = reply.trim();
    const nodeSessionId = node.nodeSessionId;
    if (text.length === 0 || nodeSessionId === undefined || sending) return;
    setSending(true);
    try {
      await api.claude.sendTurn({ sessionId: nodeSessionId, prompt: text });
      setReply("");
      setSent(true);
    } catch {
      // 发不出去(会话已经放掉了 / 主进程拒了)—— 什么都不做,框里那句话留着,
      // 用户能再按一次。这里**不弹错误**:看板的用途是"看着它在干嘛",不是报错台。
    } finally {
      setSending(false);
    }
  };

  /** 跟**主对话**说一句 —— 塞进输入框,不替他发(见函数头那段)。 */
  const talkToParent = (): void => {
    const text = reply.trim();
    if (text.length === 0) return;
    const prev = useSessionStore.getState().composerDraftBySession[sessionId];
    useSessionStore.getState().saveComposerDraft(sessionId, {
      text,
      html: "",
      tags: prev?.tags ?? [],
    });
    setReply("");
    setSent(true);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-edge bg-surface px-2">
        <button
          type="button"
          onClick={onBack}
          title={t("sideChat.backToList")}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-content-muted transition-colors hover:bg-surface-hover hover:text-content"
        >
          <IconArrowLeft size={15} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-content">
            {node.title || node.nodeType}
          </div>
          <div className={cn("flex items-center gap-1 text-[10px]", meta.cls)}>
            <span className="truncate">{t(PHASE_LABEL[key] ?? PHASE_LABEL.success)}</span>
            {node.nodeType && (
              <span className="truncate text-content-subtle">· {node.nodeType}</span>
            )}
          </div>
        </div>
        {canRetry && (
          <button
            type="button"
            onClick={() => setRetryOpen(true)}
            title={t("chatStream.workflowStep.retry")}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-content-muted transition-colors hover:bg-surface-hover hover:text-content"
          >
            <IconRefresh size={14} />
          </button>
        )}
        {/* **结束这一步。** 主进程那一头对工作流会话是"停整张图"(见 `claude.interrupt`),
            所以这不是"只掐这一格" —— 用户要的本来也是"别往下跑了"。 */}
        {live && (
          <button
            type="button"
            onClick={() => void api.claude.interrupt({ sessionId })}
            title={t("chatStream.workflowBoard.takeoverStop")}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-content-muted transition-colors hover:bg-surface-hover hover:text-danger"
          >
            <IconPlayerStop size={14} />
          </button>
        )}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2">
        {/* 在等人的那一格:把选项摊出来(真正的按钮在消息流那张卡上 —— 这里是"我该
            去哪儿点"的说明,不是第二个能点的地方:两处都能点会让"点哪个"变成一个问题)。 */}
        {node.awaiting && node.options && node.options.length > 0 && (
          <div className="mb-2 rounded-md border border-warning/40 bg-warning/5 px-2 py-1.5">
            <p className="text-[11px] leading-relaxed text-warning">
              {node.ask
                ? t("chatStream.workflowBoard.awaitingAsk")
                : t("chatStream.workflowBoard.awaitingHint")}
            </p>
            <ul className="mt-1 space-y-0.5">
              {node.options.map((o) => (
                <li key={o.id} className="text-[11px] text-content-muted">
                  · {o.label}
                  {o.next ? ` → ${o.next}` : ""}
                </li>
              ))}
            </ul>
          </div>
        )}
        {/* 选完之后的回看:这一格里记着用户选了哪条、补了什么话、是第几轮问的。
            `chosen` 是**选项的 label**(`choice` 事件带的是 label,不是 id —— 见
            `workflowLive` 的折叠)。`attempt > 1` 说明这一格绕回头又问过(第二圈),
            顺带把轮数说出来,不然"选过了怎么又问"看起来像 bug。 */}
        {!node.awaiting && node.chosen !== undefined && (
          <div className="mb-2 rounded-md border border-edge bg-surface/60 px-2 py-1.5">
            <p className="text-[11px] leading-relaxed text-content-muted">
              {t("chatStream.workflowBoard.chosen", { label: node.chosen })}
              {node.attempt !== undefined && node.attempt > 1 && (
                <span className="text-content-subtle">
                  {" · "}
                  {t("chatStream.workflowBoard.chosenAttempt", { n: node.attempt })}
                </span>
              )}
            </p>
            {node.comment && (
              <p className="mt-0.5 text-[11px] leading-relaxed text-content-subtle">
                {t("chatStream.workflowBoard.chosenComment", { text: node.comment })}
              </p>
            )}
          </div>
        )}
        {blocks.length === 0 ? (
          <p className="px-1 py-3 text-[11px] leading-relaxed text-content-subtle">
            {live
              ? t("chatStream.workflowBoard.nodeWaiting")
              : t("chatStream.workflowStep.processGone")}
          </p>
        ) : (
          <MessageBlocks blocks={blocks} />
        )}
        {/* 收场时那一句结论。失败的原因往往**不在过程里**(它可能一个字都还没输出就炸了),
            所以单独摆一条。 */}
        {!live && node.message && (
          <div className="mt-2 rounded-md border border-edge bg-surface/60 px-2 py-1.5 text-[11px] leading-relaxed text-content-muted">
            <Markdown>{node.message}</Markdown>
          </div>
        )}
      </div>

      {/* **接管这一步。** 只有失败/被取消的那几种才摆 —— 跑成功的那一步没什么要接管的,
          而摆一排按不了的按钮比不摆更让人困惑。
          「跟这一步说」只在它**真的有过会话**时给(`nodeSessionId` 在):`skipped` /
          `cancelled` 的节点压根没建过会话,发过去没人接。 */}
      {canTakeOver && (
        <div className="shrink-0 border-t border-edge bg-surface px-2.5 py-2">
          <div className="flex items-center gap-1.5">
            <IconMessage size={12} className="shrink-0 text-content-subtle" />
            <span className="text-[10px] font-semibold uppercase tracking-wide text-content-subtle">
              {t("chatStream.workflowBoard.takeover")}
            </span>
            {sent && (
              <span className="text-[10px] text-content-subtle">
                {t("chatStream.workflowBoard.takeoverSent")}
              </span>
            )}
          </div>
          <textarea
            value={reply}
            onChange={(ev) => setReply(ev.target.value)}
            rows={2}
            placeholder={t("chatStream.workflowBoard.takeoverPlaceholder")}
            className="mt-1 w-full resize-y rounded border border-edge bg-surface/60 px-2 py-1 text-[11px] text-content placeholder:text-content-subtle focus:border-accent focus:outline-none"
          />
          <div className="mt-1 flex items-center gap-1.5">
            {node.nodeSessionId !== undefined && (
              <Button
                variant="outline"
                size="sm"
                disabled={reply.trim().length === 0 || sending}
                onClick={() => void talkToNode()}
              >
                {t("chatStream.workflowBoard.talkToNode")}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={reply.trim().length === 0}
              onClick={talkToParent}
            >
              {t("chatStream.workflowBoard.talkToParent")}
            </Button>
          </div>
        </div>
      )}

      {canRetry && (
        <RetryNodeDialog
          open={retryOpen}
          onClose={() => setRetryOpen(false)}
          sessionId={sessionId}
          runId={node.runId}
          nodeId={node.nodeId}
        />
      )}
    </div>
  );
}
