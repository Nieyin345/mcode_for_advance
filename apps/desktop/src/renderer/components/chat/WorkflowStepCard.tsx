/**
 * 对话里那张「工作流的一步跑完了」的卡片。
 *
 * ## 为什么是一张卡,不是一条消息
 *
 * 图上的每一步跑在**自己的隐藏子会话**里(`kind: "node"`),它的输出不是这个对话的
 * assistant 回复。把它伪装成回复会破坏"一轮里最后那条 assistant 消息"这条配对规则
 * (用量结算、本轮统计行都挂在上面),所以走的是和 `plan.update` / `compact.result`
 * 同一条路:**事件 → 卡片**。见 `@contracts/runtime` 的 `WorkflowNodeResultEvent`。
 *
 * ## 长相
 *
 * 一行说清"哪一步、什么类型、成没成",下面接这一步的产出。产出可能很长(它就是那个
 * 子 agent 的最终回答),而一张图可能有好几步 —— 全摊开会把对话刷得看不见别的,
 * 所以长的默认折起来,点标题那一行展开。
 *
 * ## 声明了产出变量的那一步,产出**不是一段文本**
 *
 * 那一步的产出是一个对象,内容全在变量里(见 `describeOutputVars`:有硬约束就别写别的
 * 东西)。把那段原文摊给用户看,摊出来的正好是他说过不要看的那一坨 —— 所以这里
 * **逐项渲染变量**:一行名字,下面接它的值(走 Markdown,和正文同一种渲染)。
 *
 * 提出来的值用 `checkOutput` —— **和调度器校验产出用的是同一个解析器**,所以卡片上
 * 显示的就是下游拿到的那一份,不会出现"界面说交齐了、下游说少一样"这种两套说法。
 */
import { useMemo, useState } from "react";
import { api } from "@renderer/lib/api.js";
import {
  IconAlertTriangle,
  IconChevronDown,
  IconCircleCheck,
  IconCircleOff,
  IconDatabase,
  IconFile,
  IconFolder,
  IconRefresh,
} from "@renderer/lib/icons.js";
import { cn } from "@renderer/lib/cn.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { useSessionStore, type Block } from "@renderer/stores/sessionStore.js";
import { useQueuedNode } from "@renderer/lib/workflowQueued.js";
import { fmtCost, fmtTokens } from "@renderer/lib/contextWindow.js";
import { Markdown } from "./Markdown.js";
import { MessageBlocks } from "./MessageBlocks.js";
import { mapTranscriptBlock } from "./transcriptBlocks.js";
import { outputRowsOf } from "./outputRows.js";
import { Button } from "@renderer/components/ui/button.js";
import { RetryNodeDialog } from "./RetryNodeDialog.js";

type WorkflowStepBlock = Extract<Block, { kind: "workflow-node-result" }>;

/** 超过这个长度就折起来。**数字本身不重要** —— 它只是"一眼能扫过去"的量级,
 *  真正的判据是"比这长的东西摊开之后会把这一屏占满"。 */
const COLLAPSE_AT = 400;

/** 一步的耗时怎么摆:不满一秒给毫秒,往上给秒。够用就好 —— 这是卡片上的一行小字,
 *  不是计时器。引擎没报(负数/NaN)时摆个破折号,不摆 0。 */
function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

const STATUS: Record<
  WorkflowStepBlock["status"],
  { icon: typeof IconCircleCheck; tone: string; labelKey: MessageId }
> = {
  success: {
    icon: IconCircleCheck,
    tone: "text-accent",
    labelKey: "chatStream.workflowStep.success",
  },
  failed: {
    icon: IconAlertTriangle,
    tone: "text-danger",
    labelKey: "chatStream.workflowStep.failed",
  },
  // "没跑"和"跑了但被取消"都用同一个图标:两者对用户的区别只在那句话上。
  skipped: {
    icon: IconCircleOff,
    tone: "text-content-subtle",
    labelKey: "chatStream.workflowStep.skipped",
  },
  // **和 skipped 分开是这张卡上最要紧的一件事。** 两者都是"没跑",但一句说的是
  // "上游炸了",另一句说的是"你自己在岔路口选了别的路" —— 混用的话,用户会在选完路
  // 之后看到另一条支路写着"失败",然后去翻一个**根本没跑过**的节点的日志。
  unselected: {
    icon: IconCircleOff,
    tone: "text-content-subtle",
    labelKey: "chatStream.workflowStep.unselected",
  },
  cancelled: {
    icon: IconCircleOff,
    tone: "text-content-muted",
    labelKey: "chatStream.workflowStep.cancelled",
  },
};

export function WorkflowStepCard({ block }: { block: WorkflowStepBlock }) {
  const { t } = useI18n();
  // 重试要带 sessionId(见 `workflow.retry`)。取当前会话 —— 卡片本来就是它这一轮里的。
  const sessionId = useSessionStore((s) => s.activeSessionId);
  const providerName = useSessionStore((s) =>
    block.providerId
      ? s.providers.find((provider) => provider.id === block.providerId)?.displayName ?? block.providerId
      : undefined,
  );
  const [open, setOpen] = useState(false);
  const [openProcess, setOpenProcess] = useState(false);
  // 「排队中」chip:节点进队没起跑的那段时间(见 `workflowQueued.ts`)。收场卡出现时
  // 队列事实多半已经摘掉 —— 留这个口子是为了排队→起跑的瞬间两张卡不会各说各的。
  const queued = useQueuedNode(block.runId, block.nodeId);
  /** 失败卡片上那个「再试一次」窗口的开关。**按卡片持有** —— 两张失败卡各弹各的。 */
  const [retryOpen, setRetryOpen] = useState(false);

  /**
   * 这一步**跑的过程** —— 它在那个隐藏子会话里搜了什么、调了哪些工具、中间说了什么。
   *
   * 两条路,**活的优先**:`workflowNodeTranscripts` 里那份是跟着事件长的(最新),
   * 查不到就退回卡片自己带的那份快照(`nodeTranscript`,收场那一刻拷进去的)。
   * 后者管两种情况:过程被容量裁掉了,以及**会话重开之后**(内存里那份是空的,而卡片
   * 是落盘的)。
   *
   * 取不到只有一种情况,而且是正常的:节点压根没跑(skipped / cancelled,
   * `nodeSessionId` 缺席,也就没有过程可拷)。
   */
  const rawProcess = useSessionStore((s) =>
    block.nodeSessionId ? s.workflowNodeTranscripts[block.nodeSessionId] : undefined,
  );
  const source = rawProcess ?? block.nodeTranscript;
  const process = useMemo(() => (source ?? []).map(mapTranscriptBlock), [source]);

  const status = STATUS[block.status];
  const Icon = status.icon;
  const summary = block.summary.trim();

  /**
   * 声明过产出变量的话,把值逐项提出来(**提不出就退回原文** —— 产出没按规矩交、
   * 或者本来就是失败的那一步,那时用户恰恰需要看见它到底交了什么东西)。
   */
  const outputs = useMemo(
    () => outputRowsOf(block.summary, block.outputKeys),
    [block.outputKeys, block.summary],
  );

  // 折起来的判据:有变量就按"有没有哪一项太长",没有就按整段文本的长度。两边的阈值
  // 是同一个 —— 用户在两种卡片上感到"这一屏被占满了"的地方是同一处。
  const collapsible = outputs
    ? outputs.some((v) => v.text.length > COLLAPSE_AT)
    : summary.length > COLLAPSE_AT;
  const shown = collapsible && !open ? `${summary.slice(0, COLLAPSE_AT)}…` : summary;
  const empty = summary.length === 0 && !block.error && (outputs?.length ?? 0) === 0;

  return (
    <div
      className={cn(
        "rounded-md border bg-surface/40 px-3 py-2 [font-size:var(--chat-fs-sm)]",
        block.status === "failed" ? "border-danger/40" : "border-edge",
      )}
    >
      <button
        type="button"
        // 折起来的时候整行可点;不折的时候没有可点的东西,别给一个假按钮。
        disabled={!collapsible}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex w-full items-center gap-2 text-left",
          collapsible && "cursor-pointer",
        )}
      >
        <Icon size={14} className={cn("shrink-0", status.tone)} />
        <span className="min-w-0 flex-1 truncate text-content">{block.title}</span>
        {/* 类型 id 等宽、不翻译 —— 与画布上的卡片一致(作者在 README 里读到的就是它)。 */}
        <code className="shrink-0 text-[0.9em] text-content-subtle">{block.nodeType}</code>
        {queued && (
          <span className="shrink-0 rounded bg-surface-muted px-1.5 py-0.5 text-[0.85em] text-content-muted">
            {t("chatStream.workflowStep.queued")}
          </span>
        )}
        <span className={cn("shrink-0", status.tone)}>{t(status.labelKey)}</span>
        {collapsible && (
          <IconChevronDown
            size={12}
            className={cn(
              "shrink-0 text-content-subtle transition-transform",
              open && "rotate-180",
            )}
          />
        )}
      </button>

      {/* 失败的原因**不折起来** —— 它就是用户此刻唯一需要看到的东西。 */}
      {block.error && (
        <p className="mt-1 whitespace-pre-wrap break-words text-danger">{block.error}</p>
      )}
      {/* **「再试一次」** —— 从这一步接着往下跑(见 `RetryNodeDialog`)。
          ⚠️ 判据是"这一步跑在自己的会话里"(`nodeSessionId` 在),**不是 `nodeType`** ——
          类型是插件可扩展的,拿它当判据迟早漏掉别人写的节点。而**对话节点**跑在主对话里
          (没有独立的 `nodeSessionId`),它"失败"多半是主对话正忙,重试没有意义 ——
          用户确认过这个按钮只给子 agent 节点。 */}
      {block.status === "failed" && block.nodeSessionId && sessionId && (
        <div className="mt-2">
          <Button variant="outline" size="sm" onClick={() => setRetryOpen(true)}>
            <IconRefresh size={12} />
            {t("chatStream.workflowStep.retry")}
          </Button>
        </div>
      )}
      {retryOpen && sessionId && (
        <RetryNodeDialog
          open={retryOpen}
          onClose={() => setRetryOpen(false)}
          sessionId={sessionId}
          runId={block.runId}
          nodeId={block.nodeId}
        />
      )}
      {/* 声明了产出变量的那一步:**逐项摆变量**,不摆原文(原文就是那头一个对象,
          摊出来正是用户说过不要看的那一坨)。名字在上、值在下,和"一步一张卡"同一种
          读法:先看它叫什么,再看它是什么。 */}
      {outputs ? (
        <div className="mt-1 space-y-1.5">
          {outputs.map((v) => {
            const cut = collapsible && !open && v.text.length > COLLAPSE_AT;
            return (
              <div key={v.name}>
                <div className="text-[0.9em] text-content-subtle">{v.name}</div>
                <div className="text-content-muted">
                  <Markdown>{cut ? `${v.text.slice(0, COLLAPSE_AT)}…` : v.text}</Markdown>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        shown && (
          <div className="mt-1 text-content-muted">
            <Markdown>{shown}</Markdown>
          </div>
        )
      )}
      {empty && (
        <p className="mt-1 text-content-subtle">{t("chatStream.workflowStep.empty")}</p>
      )}

      {/* Persist the actual execution choice on the result card. This is the
          only reliable answer after a node/provider setting changes later. */}
      {providerName && (
        <p className="mt-1 text-[0.9em] text-content-subtle">
          {t("chatStream.workflowStep.engine", {
            provider: providerName,
            model: block.model || "default",
          })}
        </p>
      )}

      {/* **这一步跑在哪种执行器上、跑了多久。**(`NodeExecutionRecord`,结果事件本来
          就带着 —— 之前没人展示。)回答"哪一步最慢"时,这是卡片上的第一手数字。 */}
      {block.execution && (
        <p className="mt-1 text-[0.9em] tabular-nums text-content-subtle">
          {t("chatStream.workflowStep.execution", {
            kind: block.execution.executorKind,
            duration: fmtDuration(block.execution.durationMs),
          })}
        </p>
      )}

      {/* **这一步花了多少。** 一个节点是一个独立的隐藏会话,真的烧 token —— 而它在左栏
          不出现、用量页里也只汇成一个总数。不给这一行的话,"哪一步最贵"就完全看不见。
          ⚠️ 它**多半是过几秒才出现的**(用量要等那个回合结算,见 block 上 `usage` 的
          注释),所以这里不能写"没有就是不花钱"。 */}
      {block.usage && (
        <p className="mt-1 text-[0.9em] tabular-nums text-content-subtle">
          {t("chatStream.workflowStep.usage", {
            tokens: fmtTokens(block.usage.totalTokens),
            cost: fmtCost(block.usage.costUsd),
          })}
        </p>
      )}

      {/* 看这一步交出了哪些**外部产物** —— 它们不在 `summary` 里(契约只允许引用,
          见 `@contracts/nodeType` 的 `NodeArtifact`:字节留在外面,卡片上摆的是稳定
          引用)。三种 kind 各有各的看法:file / directory 给「打开」(用系统默认应用 /
          文件管理器),`data` 没有本地路径可开,只把引用摆出来。 */}
      {block.artifacts && block.artifacts.length > 0 && (
        <div className="mt-2 border-t border-edge/60 pt-2">
          <div className="mb-1 flex items-center gap-1.5 text-[0.9em] text-content-subtle">
            <IconFile size={13} />
            <span>{t("chatStream.workflowStep.artifacts")}</span>
          </div>
          <div className="space-y-1">
            {block.artifacts.map((artifact, index) => {
              const localPath = artifact.uri.replace(/^file:\/\//, "");
              const ArtifactIcon = artifact.kind === "directory" ? IconFolder : artifact.kind === "data" ? IconDatabase : IconFile;
              const openable =
                (artifact.kind === "file" || artifact.kind === "directory") &&
                (/^[A-Za-z]:[\\/]/.test(localPath) || localPath.startsWith("/"));
              return (
                <div key={`${artifact.uri}:${index}`} className="flex min-w-0 items-center gap-2 text-[0.85em]">
                  <ArtifactIcon size={13} className="shrink-0 text-content-subtle" />
                  <span className="min-w-0 flex-1 truncate" title={artifact.uri}>
                    {artifact.name ?? artifact.uri}
                    {artifact.sizeBytes !== undefined && (
                      <span className="ml-1 text-content-muted">({artifact.sizeBytes.toLocaleString()} B)</span>
                    )}
                  </span>
                  {openable && (
                    <button
                      type="button"
                      className="shrink-0 rounded border border-edge px-1.5 py-0.5 text-content-subtle hover:bg-surface-hover hover:text-content"
                      onClick={() =>
                        void (artifact.kind === "directory"
                          ? api.shell.openPath({ path: localPath })
                          : api.shell.openFile({ path: localPath }))
                      }
                    >
                      {t("chatStream.workflowStep.open")}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {/* 入口的条件是「**有过程可看**」,不是「有会话 id」:节点没跑过(skipped /
          unselected / cancelled)时两样都没有,一个有会话 id 但过程还没攒到的节点
          也暂时没东西可看。之前按 `nodeSessionId` 判,那两处都点开是空的。 */}
      {(process.length > 0 || block.nodeSessionId) && (
        <>
          <button
            type="button"
            onClick={() => setOpenProcess((v) => !v)}
            className="mt-1.5 flex cursor-pointer items-center gap-1 text-content-subtle transition-colors hover:text-content-muted"
          >
            <IconChevronDown
              size={12}
              className={cn("transition-transform", openProcess && "rotate-180")}
            />
            {t("chatStream.workflowStep.process")}
            {process.length > 0 && (
              <span className="text-[0.9em]">· {t("chatStream.workflowStep.processSteps", { n: process.length })}</span>
            )}
          </button>
          {openProcess &&
            (process.length > 0 ? (
              // 只读 —— `MessageBlocks` 是纯展示组件(没有输入框、没有发送路径),这一步
              // 是模型在跑、用户在看。与侧栏那个子代理查看器同一条路。
              <div className="mt-1 border-l border-edge pl-2">
                <MessageBlocks blocks={process} />
              </div>
            ) : (
              <p className="mt-1 pl-4 text-content-subtle">
                {t(
                  block.nodeSessionId
                    ? "chatStream.workflowStep.processGone"
                    : "chatStream.workflowStep.noTranscript",
                )}
              </p>
            ))}
        </>
      )}
    </div>
  );
}
