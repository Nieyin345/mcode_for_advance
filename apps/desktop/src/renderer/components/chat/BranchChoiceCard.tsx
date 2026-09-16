/**
 * 对话里那张「岔路口」的卡 —— 图停在这儿,等你选一条路。
 *
 * ## 它和旁边的结果卡**不是一类东西**
 *
 * 结果卡(`WorkflowStepCard`)说的是"这一步已经跑完了";这一张是**活的**:按钮点下去
 * 之前,那次运行**没有结束**,图就停在这个节点上等一个人(见 `@contracts/runtime` 的
 * `WorkflowNodeChoiceEvent` 与调度器的 `RunPorts.choose`)。所以:
 *
 * - 它摆的是**按钮和输入框**,不是产出文本;
 * - 它**只能用一次** —— 选完就变成"你选了 X",不再可点;
 * - 点下去**不开一次新的运行**,而是唤醒一个还活着的运行,图从那儿接着往下跑。
 *
 * ## 为什么点的时候还要带 `runId`
 *
 * 同一个节点在同一张图里每一轮跑的 id 是一样的。只带 `nodeId` 的话,用户在**上一轮那张
 * 旧卡**上点一下,会去唤醒这一轮的等待 —— 而这一轮问的根本不是同一件事。主进程那一头
 * 按 `runId + nodeId` 认(见 `runner.ts` 的 `choiceKey`),这里照抄那两个值。
 *
 * ## 「过期」不是错误
 *
 * `ok: false` 表示没有那样的等待了(那次运行已经跑完 / 被取消)。用户点一张旧卡是
 * 正常会发生的事,**不弹错误框** —— 弹了只会让他以为自己做错了什么。说一句就够。
 */
import { useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { IconArrowsSplit, IconCircleCheck } from "@renderer/lib/icons.js";
import { BRANCH_STOP_CHOICE } from "@contracts/nodeType";
import { api } from "@renderer/lib/api.js";
import { useSessionStore, type Block } from "@renderer/stores/sessionStore.js";

type BranchChoiceBlock = Extract<Block, { kind: "workflow-branch-choice" }>;

export function BranchChoiceCard({ block }: { block: BranchChoiceBlock }) {
  const { t } = useI18n();
  // 卡片渲染在**当前会话**的消息流里,所以会话 id 从 store 拿就够了 —— 不为了这一个
  // 字段把 sessionId 一路透传进 `MessageBlocks`(那是个刻意的纯展示组件)。
  //
  // 万一拿到的不是同一个会话(切换的那一瞬),主进程那边会拒掉(它按 sessionId 核对),
  // 表现成下面那句"这条选择已经不适用了" —— 安全的那一边。
  const sessionId = useSessionStore((s) => s.activeSessionId);
  const [picked, setPicked] = useState("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);

  const chosen = block.chosen;
  const chosenLabel =
    chosen === undefined
      ? undefined
      : chosen === BRANCH_STOP_CHOICE
        ? t("chatStream.workflowChoice.stopped")
        : (block.options.find((o) => o.id === chosen)?.label ?? chosen);
  const pickedOption = block.options.find((o) => o.id === picked);

  /**
   * 把选择发回主进程。`edgeId` 有两种:某条出路的 id,或者「**就到这儿**」那个哨兵
   * (见 `BRANCH_STOP_CHOICE`)—— 后者不指向任何一步,意思是"我不选了,到此为止"。
   *
   * 两条路走的是同一个调用、同一个 promise:主进程那边收到哨兵之后,**所有出路一起
   * 判死**,这次运行自然收场。所以界面上不需要为"停"准备第二条收尾路径。
   */
  const send = async (edgeId: string): Promise<void> => {
    if (sessionId === null || busy) return;
    setBusy(true);
    setStale(false);
    try {
      const text = comment.trim();
      const res = await api.workflow.choose({
        sessionId,
        runId: block.runId,
        nodeId: block.nodeId,
        edgeId,
        ...(text.length > 0 ? { comment: text } : {}),
      });
      if (!res.ok) setStale(true);
      // 成功的话这里**什么都不用做**:主进程会把第二次 `workflow.node.choice` 发回来,
      // store 把这张卡换成"你选了 X"(见 `sessionStore` 里那条分支)。
    } catch {
      setStale(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2 [font-size:var(--chat-fs-sm)]",
        // 还在等的时候边框是强调色 —— 它是这一屏上**唯一需要用户动手**的东西,不该和
        // 旁边那些"已经发生完了"的卡片长成一个样子。
        chosenLabel === undefined ? "border-accent/50 bg-accent/5" : "border-edge bg-surface/40",
      )}
    >
      <div className="flex items-center gap-2">
        <IconArrowsSplit
          size={14}
          className={cn("shrink-0", chosenLabel === undefined ? "text-accent" : "text-content-subtle")}
        />
        <span className="min-w-0 flex-1 truncate text-content">{block.title}</span>
        {/* 回头之后同一个岔路口会有好几张卡(每轮一张)。**没有这个数字的话,一列卡片
            看不出它们是同一个岔路口在不同轮次问的** —— 而"这是第几轮"正是用户此刻
            最需要知道的事(他要判断还改不改)。第一轮不写,那是默认情况。 */}
        {block.attempt > 1 ? (
          <span className="shrink-0 rounded bg-surface-muted px-1 text-[0.9em] text-content-subtle">
            {t("chatStream.workflowChoice.round", { n: block.attempt })}
          </span>
        ) : null}
        <code className="shrink-0 text-[0.9em] text-content-subtle">{block.nodeType}</code>
      </div>

      {chosenLabel === undefined ? (
        <>
          <p className="mt-1 text-content-muted">{t("chatStream.workflowChoice.prompt")}</p>

          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {block.options.map((o) => (
              <button
                key={o.id}
                type="button"
                disabled={busy}
                onClick={() => setPicked(o.id)}
                className={cn(
                  "cursor-pointer rounded border px-2 py-1 transition-colors disabled:cursor-default",
                  picked === o.id
                    ? "border-accent bg-accent/15 text-content"
                    : "border-edge text-content-muted hover:border-accent/50 hover:text-content",
                )}
              >
                {o.label}
                {/* 通向哪一步。只给一个选项名的话,用户不知道点了会发生什么 ——
                    而"会走到哪"恰恰是他做这个决定要的信息。 */}
                <span className="ml-1.5 text-[0.9em] text-content-subtle">→ {o.next}</span>
              </button>
            ))}
          </div>

          {/* 选中那一条的说明。**只显示选中的那条** —— 全摊出来是一堆与当前决定
              无关的话,而用户此刻只需要读他手上这一条。 */}
          {pickedOption?.note !== undefined && (
            <p className="mt-1.5 whitespace-pre-wrap break-words text-content-muted">
              {pickedOption.note}
            </p>
          )}

          <textarea
            value={comment}
            onChange={(ev) => setComment(ev.target.value)}
            disabled={busy}
            rows={2}
            placeholder={t("chatStream.workflowChoice.comment")}
            className="mt-1.5 w-full resize-y rounded border border-edge bg-surface/60 px-2 py-1 text-content placeholder:text-content-subtle focus:border-accent focus:outline-none"
          />

          <div className="mt-1.5 flex items-center gap-2">
            <button
              type="button"
              disabled={picked.length === 0 || busy}
              onClick={() => void send(picked)}
              className={cn(
                "rounded border px-2.5 py-1 transition-colors",
                picked.length === 0 || busy
                  ? "cursor-default border-edge text-content-subtle"
                  : "cursor-pointer border-accent bg-accent/15 text-content hover:bg-accent/25",
              )}
            >
              {t("chatStream.workflowChoice.confirm")}
            </button>
            {/* **每个岔路口都自带的一条出路:不做选择。** 没有它的话,想收工的用户
                得先随便挑一条 —— 而挑哪一条都意味着让某一步真的跑起来。
                它是**界面给的**,不是图上的一条边(见 `BRANCH_STOP_CHOICE`)。 */}
            <button
              type="button"
              disabled={busy}
              onClick={() => void send(BRANCH_STOP_CHOICE)}
              className={cn(
                "rounded px-2 py-1 text-content-subtle transition-colors",
                busy ? "cursor-default" : "cursor-pointer hover:text-content-muted",
              )}
            >
              {t("chatStream.workflowChoice.stop")}
            </button>
            {stale && (
              <span className="text-content-subtle">{t("chatStream.workflowChoice.stale")}</span>
            )}
          </div>
        </>
      ) : (
        <>
          <p className="mt-1 flex items-center gap-1.5 text-content-muted">
            <IconCircleCheck size={13} className="shrink-0 text-accent" />
            {t("chatStream.workflowChoice.chosen", { label: chosenLabel })}
          </p>
          {block.comment !== undefined && block.comment.length > 0 && (
            <p className="mt-0.5 whitespace-pre-wrap break-words text-content-subtle">
              {block.comment}
            </p>
          )}
        </>
      )}
    </div>
  );
}
