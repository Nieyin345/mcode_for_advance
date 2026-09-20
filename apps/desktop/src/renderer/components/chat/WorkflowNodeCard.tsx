/**
 * 看板上的一张卡 —— **一步**。
 *
 * ## 一张卡 = 一步,不是"一次运行里的一格 + 库里的一行"
 *
 * 上一版把这两样分成了两栏:"这次运行的现场"(跟着进程存活)和"这些步骤留着会话"
 * (已落库)。同一段对话在两边各出现一次 —— 用户点了上面那行进来,下面那行还写着同一个
 * 名字,而两行点进去是**同一段对话**。所以这一版把它们**按节点 id 合成一张卡**:
 * 现场那份和库里那份说的是同一步,就只应该有一张卡。
 *
 * ## 展开就在原地,不是一个新页面
 *
 * 上一版点一下**整栏换成详情页**(顶上那张图也没了)。这一版是手风琴:卡还在列表里,
 * 原地长出一块 —— 这样"我在整张图的哪一步"这个位置感不会丢。展开之后有三部分:
 *
 *  1. **上下文** —— 这一步说了什么、调了什么工具(还在内存里那份优先,见下);
 *  2. **一个小的输入框** —— 想跟它说什么就写在这里;
 *  3. **两个去处** —— 「跟这一步说」真的发给它那个会话;「放进主对话的输入框」只是
 *     替你把话**放进**主对话的输入框,发不发由你。
 *
 * ## 展开之后看到的是**谁的**上下文 —— 这里有一条真实的缺口
 *
 * 节点会话的转录**不进库**(只有消息流里那张收场卡在收场那一刻拷过一份)。所以:
 *
 * | 这一份 | 上下文从哪儿来 |
 * |---|---|
 * | **现场**(这次运行里的) | 事件推来的那份(`workflowNodeTranscripts`),最新的 |
 * | **库里那一行**(重启之后) | 主对话消息里那张 `workflow-node-result` 卡留的快照 |
 * | 都没有 | **如实说明**,不编造 |
 *
 * 第三条那个"如实说明"是刻意的:放一个点开空空的框,用户会以为内容丢了;写一句
 * "这一步的过程不在内存里了(只留最近执行过的若干步)"又说错了原因(重启之后本来就
 * 没进来过)。所以另给一句 `contextGone`,把"这一步的上下文没有留下来"讲清楚,
 * 并说明**只有正在执行的那几步看得到它说了什么**。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { TranscriptBlock } from "@contracts/runtime";
import { cn } from "@renderer/lib/cn.js";
import { api } from "@renderer/lib/api.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { formatFullTime, formatRelativeTime } from "@renderer/lib/time.js";
import { useSessionStore, type ChatMessage } from "@renderer/stores/sessionStore.js";
import { useQueuedNode } from "@renderer/lib/workflowQueued.js";
import type { LiveNode } from "@renderer/lib/workflowLive.js";
import { Markdown } from "@renderer/components/chat/Markdown.js";
import { MessageBlocks } from "@renderer/components/chat/MessageBlocks.js";
import { mapTranscriptBlock } from "@renderer/components/chat/transcriptBlocks.js";
import { RetryNodeDialog } from "@renderer/components/chat/RetryNodeDialog.js";
import { Button } from "@renderer/components/ui/button.js";
import {
  IconAlertTriangle,
  IconChevronDown,
  IconCircleCheck,
  IconCircleOff,
  IconMessage,
  IconPlayerStop,
  IconRefresh,
  SpinnerIcon,
} from "@renderer/lib/icons.js";

/** 一步在卡上的样子。**现场那份和库里那份合成的结果** —— 两个来源都填进这一个形状,
 *  卡片只认它。 */
export interface NodeView {
  nodeId: string;
  /** 现场那一趟里才有。**重试要用它**(`workflow.retry` 认的是 runId + nodeId)。 */
  runId?: string;
  /** 这一步此刻在**这次运行**里(而不是只是库里留着会话)。 */
  live: boolean;
  title: string;
  nodeType: string;
  /** 见 {@link PHASE_LABEL} 的键。 */
  phase: string;
  nodeSessionId?: string;
  /** 收场那一刻拷在消息卡上的过程快照。 */
  nodeTranscript?: TranscriptBlock[];
  summary?: string;
  error?: string;
  startedAt?: number;
  endedAt?: number;
  percent?: number;
  awaiting?: boolean;
  options?: LiveNode["options"];
  attempt?: number;
  ask?: boolean;
  chosen?: string;
  comment?: string;
  /** 库里那一行**最后一次动过**的时刻。没有现场信息时,卡片就用它说明"这是什么时候
   *  的" —— 总比一行小字写着"已存下"却不说什么时候好。 */
  storedAt?: number;
}

/** 每种阶段给一个图标、一个颜色 —— 漏了会在界面上显示成空白(所以是 `Record`,
 *  而不是几个 if)。 */
const PHASE_META: Record<
  string,
  { cls: string; spin?: boolean; icon: "check" | "warn" | "off" }
> = {
  queued: { cls: "text-content-subtle", icon: "off" },
  running: { cls: "text-accent", spin: true, icon: "off" },
  awaiting: { cls: "text-warning", icon: "warn" },
  success: { cls: "text-accent", icon: "check" },
  failed: { cls: "text-danger", icon: "warn" },
  skipped: { cls: "text-content-subtle", icon: "off" },
  unselected: { cls: "text-content-subtle", icon: "off" },
  cancelled: { cls: "text-content-muted", icon: "off" },
  idle: { cls: "text-content-subtle", icon: "off" },
};

export const PHASE_LABEL: Record<string, MessageId> = {
  queued: "chatStream.workflowStep.queued",
  running: "chatStream.ledgerRunning",
  awaiting: "chatStream.workflowBoard.awaiting",
  success: "chatStream.workflowStep.success",
  failed: "chatStream.workflowStep.failed",
  skipped: "chatStream.workflowStep.skipped",
  unselected: "chatStream.workflowStep.unselected",
  cancelled: "chatStream.workflowStep.cancelled",
  idle: "chatStream.workflowBoard.notRun",
};

/** 这一格此刻算哪一档。**`awaiting` 压过一切** —— 等待用户的那一格不处理则整张图停住。 */
export function phaseOf(node: LiveNode): string {
  if (node.awaiting) return "awaiting";
  if (node.phase === "settled") return node.status ?? "success";
  return node.phase;
}

/** 「执行了多久」。**只有还在执行的那一张卡才挂定时器** —— 已结束的用 `endedAt - startedAt`
 *  一次算完;一屏几十张卡每张一个 interval 纯属浪费。 */
function useElapsed(node: NodeView): string | null {
  const ticking = node.live && node.phase !== "settled";
  const [, tick] = useState(0);
  useEffect(() => {
    if (!ticking) return;
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [ticking]);
  if (node.startedAt === undefined) return null;
  const end = node.endedAt ?? Date.now();
  const sec = Math.max(0, Math.round((end - node.startedAt) / 1000));
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, "0")}s`;
}

/**
 * 「这一步是什么时候的」。
 *
 * 库里那一行没人替它说时间,而**不说时间的后果是"分不清这是刚才那趟还是上周的"** ——
 * 用户要判断"我现在接着聊还有没有意义",第一眼要的就是这个。
 *
 * 所以给**相对时间**(「3 小时前」),不是 `01-01 08:00`:
 *
 *  - 相对时间回答的是"多久以前",正好是用户脑子里那个问题;
 *  - 绝对时间要读两个数字再做减法,而且夹在一行小字里第一眼只是一串噪声 ——
 *    上一版就是 `01-01 08:00`,它既费地方又没人读得出那是"多早以前"。
 *
 * 完整时刻挂在 hover 的 `title` 上(和 Git 面板那份同一个做法,见 `lib/time.ts`)。
 */
function storedAgo(ms: number): string {
  return formatRelativeTime(ms);
}

export function WorkflowNodeCard({
  node,
  sessionId,
  expanded,
  onToggle,
  onStopGraph,
}: {
  node: NodeView;
  /** 主对话(「放进主对话的输入框」落草稿用的是它)。 */
  sessionId: string;
  expanded: boolean;
  onToggle: () => void;
  /** 停下整张图。**只有现场那几张卡给** —— 库里那一行没有活着的图可停。 */
  onStopGraph: () => void;
}) {
  const { t } = useI18n();
  const queued = useQueuedNode(node.runId ?? "", node.nodeId);
  const meta = PHASE_META[node.phase] ?? PHASE_META.idle;
  const elapsed = useElapsed(node);
  const [retryOpen, setRetryOpen] = useState(false);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const label = t(PHASE_LABEL[node.phase] ?? PHASE_LABEL.idle);
  /**
   * 第二行小字:**状态以外的那些补充** —— 排队中 / 耗时 / 多久以前。
   *
   * ⚠️ **状态词不在这里,类型 id 也不在这里。**
   *
   *  - 状态词挪到了**卡片最右边那一列**(和进度、折叠箭头同一列)。左边那颗图标也按
   *    同一档上色,但图标只是"形状",要读懂"已完成 / 失败"还是得看词 —— 而它原来混在
   *    这行灰字里当第一个词,一屏卡扫过去得逐张去读。移到右边之后所有卡的这一列竖直
   *    对齐,而且**按档上色**(见 `meta.cls`),红的那一格是扫出来的。
   *
   *  - 类型 id 挪到了**这一行的开头**,做成等宽的一小片。上一版是把它接在这一行中文小字
   *    的末尾(`没在跑 · 58 年前  mcode.agent`),而这一行的宽度**取决于前半句有多长**
   *    —— 于是同一列卡里这个等宽小片一张一个位置,谁也对不齐,看着就像几片浮在半空的
   *    补丁。现在它固定在这一行的最左边,所有卡对齐;小字跟在它右边,变长变短都不动它。
   *
   *    类型 id **不翻译**(和消息流那张卡、画布上的卡片一致):作者在 README 里读到的
   *    就是 `mcode.agent` 这个字面量。库里那一行没有类型(节点类型是图上的属性,
   *    不是会话的属性),那时这一片不画。
   *
   * 两样都空(库里那一行、又没有时间)时这一行整个不画 —— 空的一行只会把卡撑高。
   */
  const sub = [
    queued ? t("chatStream.workflowStep.queued") : null,
    elapsed,
    elapsed === null && node.storedAt !== undefined ? storedAgo(node.storedAt) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  /** 整张卡的 hover 提示给**准确时刻** —— 相对时间答的是"多久以前",真要核对是哪一趟
   *  时还得有准确那个(和 Git 面板同一个做法,见 `lib/time.ts`)。 */
  const subTitle =
    node.storedAt !== undefined ? formatFullTime(node.storedAt) : node.title || node.nodeType;

  const canRetry = node.phase === "failed" && node.live && node.runId !== undefined;
  const canTalk = node.nodeSessionId !== undefined;
  const canStop = node.live && (node.phase === "running" || node.phase === "queued");

  /** 跟**这一步**说一句。走的是它自己那个隐藏会话,所以它的产出照常交给调度器。 */
  const talkToNode = async (): Promise<void> => {
    const text = reply.trim();
    const target = node.nodeSessionId;
    if (text.length === 0 || target === undefined || sending) return;
    setSending(true);
    try {
      await api.claude.sendTurn({ sessionId: target, prompt: text });
      setReply("");
      setSent(true);
    } catch {
      // 发不出去(会话已经释放 / 主进程拒绝了)—— 不做别的,框里那句话留着,
      // 用户能再按一次。这里**不弹错误**:看板的用途是"看它此刻在做什么",不是报错台。
    } finally {
      setSending(false);
    }
  };

  /** 跟**主对话**说一句 —— 放进输入框,不替用户发送。主对话此刻可能正被这张图占用,
   *  直接发会被 `graphRunIntent` 拒掉;而且"我先看看再发"本来就是更稳妥的一步。 */
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

  const Icon =
    meta.icon === "check"
      ? IconCircleCheck
      : meta.icon === "warn"
        ? IconAlertTriangle
        : IconCircleOff;

  return (
    <li
      className={cn(
        "group overflow-hidden rounded-lg border transition-colors",
        expanded
          ? "border-accent/60 bg-surface shadow-sm"
          : "border-edge bg-surface/50 hover:border-edge-input hover:bg-surface",
      )}
    >
      {/* **整张卡的头就是那个点击区**(点开就在原地展开)。重试和"停下这张图"是两颗小
          图标,摆在右边 —— 它们不展开也该按得到。
          ⚠️ 图标那一列平时是**隐形的**(`opacity-0`,悬停或展开才显形):一屏十几张卡里,
          每张都描着两颗按钮,整列看起来就像一排工具箱而不是一份流程。
          用 `opacity` 而不是"藏起来" —— 位置一直在,鼠标划过去的时候卡头不会因为
          多出两颗按钮而重新排版(那一下抖动比按钮本身更扎眼)。 */}
      <div className="flex items-stretch">
        <button
          type="button"
          onClick={onToggle}
          title={subTitle}
          data-node-card={node.nodeId}
          className="flex min-w-0 flex-1 items-start gap-2 px-2.5 py-2 text-left"
        >
          <span
            className={cn(
              "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center",
              meta.cls,
            )}
          >
            {meta.spin ? <SpinnerIcon size={13} className="animate-spin" /> : <Icon size={13} />}
          </span>
          {/* 标题一行、下面一小行。**标题给足一行的宽度** —— 上一版把标题和状态挤在
              同一个 flex 行里,长标题一截断,剩下的空间还空着。 */}
          <span className="min-w-0 flex-1">
            <span
              className={cn(
                "block truncate text-[13px] leading-5",
                node.phase === "idle" ? "text-content-muted" : "font-medium text-content",
              )}
            >
              {node.title || node.nodeType}
            </span>
            {/* 底下这一行**可能有、也可能没有**(见 `sub` 那段注释)—— 两样都空就不画,
                省得一列卡里有几张平白高出一行。 */}
            {(node.nodeType || sub) && (
              <span className="mt-0.5 flex items-center gap-1.5 text-[10px] leading-4 text-content-subtle">
                {/* 类型 id **等宽、不翻译**,固定在这一行的**最左边** —— 所有卡对齐。
                    接在中文小字末尾的话,它的位置会随前半句长短一张一变。 */}
                {node.nodeType && (
                  <code className="shrink-0 rounded bg-surface-muted px-1 font-mono text-[9px] text-content-subtle">
                    {node.nodeType}
                  </code>
                )}
                <span className="truncate">{sub}</span>
              </span>
            )}
          </span>
          {/* 右边那一列:**状态词 —— 进度 —— 箭头**。三样都 `shrink-0` 且右对齐,所以
              一屏卡扫下来它们是同一条竖线。状态词**按档上色**(和左边那颗图标同一档),
              "哪一张失败"就是扫出来的。 */}
          <span className="flex shrink-0 items-center gap-1.5 self-start pt-px">
            {node.percent !== undefined && node.live && (
              <span className="tabular-nums text-[10px] leading-5 font-medium text-accent">
                {Math.round(node.percent)}%
              </span>
            )}
            <span className={cn("text-[10px] leading-5", meta.cls)}>{label}</span>
            <IconChevronDown
              size={13}
              className={cn(
                "text-content-subtle transition-transform",
                expanded && "rotate-180",
              )}
            />
          </span>
        </button>
        {/* 那两颗动作图标。**悬停或展开时才显形** —— 见上面那条注释。 */}
        <div
          className={cn(
            "flex shrink-0 items-center gap-0.5 pr-1.5 transition-opacity",
            expanded ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100",
          )}
        >
          {canRetry && (
            <button
              type="button"
              onClick={() => setRetryOpen(true)}
              title={t("chatStream.workflowStep.retry")}
              className="flex h-6 w-6 items-center justify-center rounded-md text-content-muted transition-colors hover:bg-surface-hover hover:text-content"
            >
              <IconRefresh size={13} />
            </button>
          )}
          {canStop && (
            <button
              type="button"
              onClick={onStopGraph}
              title={t("chatStream.workflowBoard.takeoverStop")}
              className="flex h-6 w-6 items-center justify-center rounded-md text-content-muted transition-colors hover:bg-surface-hover hover:text-danger"
            >
              <IconPlayerStop size={13} />
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <NodeBody
          node={node}
          sessionId={sessionId}
          label={label}
          metaCls={meta.cls}
          canTalk={canTalk}
          reply={reply}
          onReply={setReply}
          sending={sending}
          sent={sent}
          onTalkToNode={() => void talkToNode()}
          onTalkToParent={talkToParent}
        />
      )}

      {canRetry && node.runId !== undefined && (
        <RetryNodeDialog
          open={retryOpen}
          onClose={() => setRetryOpen(false)}
          sessionId={sessionId}
          runId={node.runId}
          nodeId={node.nodeId}
        />
      )}
    </li>
  );
}

/**
 * 展开的那一块:上下文 + 一个输入框 + 两个去处。
 *
 * 上下文按**三条路**取,顺序是固定的(与消息流里那张卡同一条规矩 —— 两边判断不一致
 * 的话,同一步在看板里有过程、在卡片上没有,用户没法解释):
 *
 *  1. 现场在内存里的那份(`workflowNodeTranscripts`,跟着事件增长,最新);
 *  2. 收场那一刻拷下来的快照(`nodeTranscript`);
 *  3. 主对话里那张卡留的存档(库里那一行走这条 —— **见文件头那张表**);
 *  4. 都没有 → 如实说明。
 *
 * 第 3 条只在展开时才去扫主对话的消息(它是一趟遍历),收起时不扫。
 */
function NodeBody({
  node,
  sessionId,
  label,
  metaCls,
  canTalk,
  reply,
  onReply,
  sending,
  sent,
  onTalkToNode,
  onTalkToParent,
}: {
  node: NodeView;
  sessionId: string;
  label: string;
  metaCls: string;
  canTalk: boolean;
  reply: string;
  onReply: (v: string) => void;
  sending: boolean;
  sent: boolean;
  onTalkToNode: () => void;
  onTalkToParent: () => void;
}) {
  const { t } = useI18n();
  const nodeSessionId = node.nodeSessionId;
  /**
   * ⚠️ **「在执行」和「在这一趟里」是两件事,不能混。** `node.live` 说的是"这一步属于
   * 这次运行"(结束之后也还是 `true`),而这里要问的是"它**此刻还在动**吗" —— 产出、结论、
   * 跟随末尾滚动,都只对**已结束的**有意义。
   *
   * 混用过一次,症状是:一步结束了、结论也拿到了,卡片上却一个字都不显示(因为
   * `!node.live` 是假的)—— 看起来像"产出没传过来",而其实是判据选错了。
   */
  const streaming =
    node.phase === "running" || node.phase === "queued" || node.phase === "awaiting";
  // ⚠️ 选择器里那次遍历是 O(消息数) —— 只有**展开着、而且手上没有过程**时才做。
  const needArchive = node.nodeTranscript === undefined && !streaming && nodeSessionId !== undefined;
  const liveBlocks = useSessionStore((s) =>
    nodeSessionId ? s.workflowNodeTranscripts[nodeSessionId] : undefined,
  );
  const archived = useSessionStore((s) =>
    needArchive ? findArchivedTranscript(s.messagesBySession[sessionId], node.nodeId, nodeSessionId) : undefined,
  );
  const source = liveBlocks ?? node.nodeTranscript;
  const blocks = useMemo(() => (source ?? []).map(mapTranscriptBlock), [source]);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 跟随末尾滚动 —— 看它此刻在做什么,而不是回头翻开头的部分。
  useEffect(() => {
    if (streaming) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [blocks, streaming]);

  return (
    <div className="border-t border-edge/60">
      <div className="flex items-center gap-1.5 px-2.5 pt-1.5">
        <span className={cn("text-[10px]", metaCls)}>{label}</span>
        {node.nodeType && (
          <span className="text-[10px] text-content-subtle">· {node.nodeType}</span>
        )}
      </div>

      <div ref={scrollRef} className="max-h-64 overflow-y-auto px-2.5 py-1.5">
        {/* 在等人的那一格:把选项摊出来(真正的按钮在消息流那张卡上 —— 这里是"我该
            去哪儿点"的说明,不是第二个能点的地方)。 */}
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
        {/* 选完之后的回看:这一格里记着用户选了哪条、补了什么话、是第几轮问的。 */}
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
          <p className="py-1 text-[11px] leading-relaxed text-content-subtle">
            {/* 三句话,不是两句:"正在执行但还没开口" / "执行过但上下文没留下来" / "根本
                没建过会话"。中间那句是**这一版新写的** —— 库里那一行确实可能一点
                上下文都没有,而写"过程丢了"会把原因说错(见文件头那张表)。 */}
            {streaming
              ? t("chatStream.workflowBoard.nodeWaiting")
              : t(
                  node.nodeSessionId
                    ? "chatStream.workflowBoard.contextGone"
                    : "chatStream.workflowStep.noTranscript",
                )}
          </p>
        ) : (
          <MessageBlocks blocks={blocks} />
        )}

        {/* 结束时那两句结论。`summary` 是它交出的产出,`error` 是它为什么没交出来 ——
            失败时两个都可能非空(执行到一半才失败),两段都要显示。 */}
        {!streaming && node.error && (
          <div className="mt-2 rounded-md border border-danger/40 bg-danger/5 px-2 py-1.5 text-[11px] leading-relaxed text-danger">
            <Markdown>{node.error}</Markdown>
          </div>
        )}
        {!streaming && node.summary && (
          <div className="mt-2 rounded-md border border-edge bg-surface/60 px-2 py-1.5 text-[11px] leading-relaxed text-content-muted">
            <Markdown>{node.summary}</Markdown>
          </div>
        )}
      </div>

      {/* **跟这一步说。** 判据是**它真有过会话**(`nodeSessionId` 在),不是"它失败了" ——
          成功的那一步照样能叫它修改,那正是"不断迭代"应有的样子。反过来 `skipped` /
          `unselected` 那两种根本没建过会话,显示出来是发给一个没人接的地方。 */}
      {canTalk && (
        <div className="border-t border-edge/60 px-2.5 py-1.5">
          <div className="flex items-center gap-1.5">
            <IconMessage size={11} className="shrink-0 text-content-subtle" />
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
            onChange={(ev) => onReply(ev.target.value)}
            rows={2}
            placeholder={t("chatStream.workflowBoard.takeoverPlaceholder")}
            className="mt-1 w-full resize-y rounded border border-edge bg-surface/60 px-2 py-1 text-[11px] text-content placeholder:text-content-subtle focus:border-accent focus:outline-none"
          />
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              disabled={reply.trim().length === 0 || sending}
              onClick={onTalkToNode}
            >
              {t("chatStream.workflowBoard.talkToNode")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={reply.trim().length === 0}
              onClick={onTalkToParent}
            >
              {t("chatStream.workflowBoard.talkToParent")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 主对话里**这张卡留下的过程存档**。
 *
 * 库里那一行(重启之后的节点会话)自己不带过程 —— 节点转录不进库。但主对话的消息流里
 * 那张结束卡是落盘的,而它在结束那一刻把过程**拷了一份**进去(`NODE_ARCHIVE_KEEP`)。
 * 所以按会话 id 对上那张卡,就能把"上次这一步说过什么"找回来。
 *
 * ⚠️ **认的是 `nodeSessionId`,不是 `nodeId`** —— 节点 id 在图改过之后会重复(同一格
 * 执行第二轮),而会话 id 才是那一段对话本身。只有在会话 id 缺失时才退回节点 id。
 *
 * 同一格执行过好几轮时取**最后**一份(倒序扫描,先命中的就是最近的)。
 */
export function findArchivedTranscript(
  messages: readonly ChatMessage[] | undefined,
  nodeId: string,
  nodeSessionId: string | undefined,
): TranscriptBlock[] | undefined {
  if (!messages) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    for (let j = m.blocks.length - 1; j >= 0; j--) {
      const b = m.blocks[j];
      if (b?.kind !== "workflow-node-result") continue;
      if (nodeSessionId !== undefined ? b.nodeSessionId !== nodeSessionId : b.nodeId !== nodeId)
        continue;
      if (b.nodeTranscript && b.nodeTranscript.length > 0) return b.nodeTranscript;
    }
  }
  return undefined;
}
