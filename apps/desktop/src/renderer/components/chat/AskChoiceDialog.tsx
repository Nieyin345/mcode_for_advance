/**
 * **跑到某一步之前弹出的那个四选一。**
 *
 * ## 它和岔路口那张卡问的不是同一件事
 *
 * 岔路口问的是"**往哪条路走**" —— 那件事盯着图有用,所以它作为一张卡长在聊天流里
 * (见 `BranchChoiceCard`)。这一问问的是"**这一步现在要不要跑、怎么跑**":用它的指令、
 * 跳过、把上一步重做一遍、还是干脆收工。那件事跟图上的走向无关,是一句当场要说的话
 * —— 所以它**弹在屏幕正中间**。
 *
 * ## 主进程给什么,这里就摆什么
 *
 * 四条选项(以及哪几条要输入框、框里写什么提示)全部来自 `workflow.node.choice` 事件的
 * `options`(见 `@contracts/nodeType` 的 `ASK_CHOICES` 与 `WorkflowChoiceOption.input`)。
 * **这里不写死那四条** —— 主进程可能因为"这一步没有上游"而不给"重复上一个任务",
 * 界面上就该照着不给,而不是摆一个点了会失败的按钮。
 *
 * ## 为什么关了它不算"放弃"
 *
 * Esc / 点外面 / 那个「先放一放」都只是**收起这个框**。聊天流里那张卡还在,点它一样
 * 能选 —— 而那张卡也是应用重启之后唯一认得回来的入口(见 `Block` 里那段)。
 * 所以这里记一个 `dismissed` 就够,不去动那次等待:那一头还在等,而且**本来就该一直
 * 等着**(见 `RunPorts.choose` 的「通知与等待必须同一个调用」)。
 *
 * ⚠️ 也因此**不设"超时自动选一个"** —— 替用户做一个他没做的决定,比多等一会儿糟得多。
 */
import { useEffect, useMemo, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { IconArrowsSplit } from "@renderer/lib/icons.js";
import { Dialog } from "@renderer/components/ui/dialog.js";
import { Button } from "@renderer/components/ui/button.js";
import { api } from "@renderer/lib/api.js";
import { useSessionStore, type Block, type ChatMessage } from "@renderer/stores/sessionStore.js";

type ChoiceBlock = Extract<Block, { kind: "workflow-branch-choice" }>;

/** 稳定的空数组 —— 每次给一个新的 `[]` 会让 zustand 的选择器每次都判成"变了"。 */
const EMPTY: ChatMessage[] = [];

/**
 * 当前**还在等**的那一问(`ask` 那一类,且还没选)。
 *
 * 从后往前找:同时等着的可能有几处(它们互不依赖,见 `RunPorts.choose`),但**最近
 * 一次问的那个**才是用户此刻该看的 —— 弹窗一次只摆一个,先来后到在界面上说不清。
 * 前面那些没关掉之前,它们各自的卡还在聊天流里。
 */
function pendingAskOf(messages: readonly ChatMessage[]): ChoiceBlock | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    for (let j = m.blocks.length - 1; j >= 0; j--) {
      const b = m.blocks[j];
      if (b && b.kind === "workflow-branch-choice" && b.ask === true && b.chosen === undefined) {
        return b;
      }
    }
  }
  return null;
}

export function AskChoiceDialog() {
  const { t } = useI18n();
  const sessionId = useSessionStore((s) => s.activeSessionId);
  const messages = useSessionStore((s) =>
    s.activeSessionId === null ? EMPTY : (s.messagesBySession[s.activeSessionId] ?? EMPTY),
  );
  const pending = useMemo(() => pendingAskOf(messages), [messages]);

  /** 哪一问被"先放一放"收起来了。**按 runId:nodeId:attempt 认** —— 换一问就该重新弹。 */
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [picked, setPicked] = useState("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);

  const key =
    pending === null ? null : `${pending.runId}:${pending.nodeId}:${pending.attempt}`;

  // 换了一问(或者选完了)就把上一问的选择清掉 —— 不然上一问选的那条会原样留在下面,
  // 用户一按确认就把一个不属于这一问的答案发了出去。
  useEffect(() => {
    setPicked("");
    setComment("");
    setStale(false);
  }, [key]);

  const open = pending !== null && dismissed !== key;
  const chosenOption = pending?.options.find((o) => o.id === picked);

  const send = async (): Promise<void> => {
    if (pending === null || sessionId === null || busy || picked.length === 0) return;
    setBusy(true);
    setStale(false);
    try {
      const text = comment.trim();
      const res = await api.workflow.choose({
        sessionId,
        runId: pending.runId,
        nodeId: pending.nodeId,
        edgeId: picked,
        ...(text.length > 0 ? { comment: text } : {}),
      });
      // 成功的话**什么都不用做**:主进程会把第二次 `workflow.node.choice` 发回来,
      // store 把那张卡换成"你选了 X",下面那个 `pending` 于是变成 null,弹窗自己关掉。
      if (!res.ok) setStale(true);
    } catch {
      setStale(true);
    } finally {
      setBusy(false);
    }
  };

  if (pending === null) return null;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && key !== null) setDismissed(key);
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup
          className="w-[440px] max-w-[90vw] p-4"
          // Enter 提交要手写(base-ui 只管 Esc)。**带上 Ctrl/Cmd**:下面那个 textarea
          // 里回车应该是换行,直接抢会把"写两句话"这件事弄坏。
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void send();
            }
          }}
        >
          <div className="flex items-center gap-2">
            <IconArrowsSplit size={15} className="shrink-0 text-accent" />
            <Dialog.Title className="min-w-0 flex-1 truncate">
              {t("chatStream.workflowAsk.title")}
            </Dialog.Title>
            {/* 回头之后同一个节点会被问好几轮。没有这个数字的话,用户看不出"这是又一轮"
                (和 `BranchChoiceCard` 右上角那个小标同一个意思)。 */}
            {pending.attempt > 1 ? (
              <span className="shrink-0 rounded bg-surface-muted px-1 text-[11px] text-content-subtle">
                {t("chatStream.workflowChoice.round", { n: pending.attempt })}
              </span>
            ) : null}
          </div>
          <Dialog.Description className="mt-1">
            {t("chatStream.workflowAsk.desc", { title: pending.title })}
          </Dialog.Description>

          {/* ★ 四条选项。**一条一行**,不并排 —— 每一条下面可能挂一个输入框,并排会挤成
              一坨;而且它们要读的话比"选哪条路"长得多(`next` 那句在说"点了会发生什么")。 */}
          <div className="mt-3 flex flex-col gap-1.5">
            {pending.options.map((o) => (
              <button
                key={o.id}
                type="button"
                disabled={busy}
                onClick={() => setPicked(o.id)}
                className={cn(
                  "cursor-pointer rounded border px-2.5 py-1.5 text-left transition-colors disabled:cursor-default",
                  picked === o.id
                    ? "border-accent bg-accent/15 text-content"
                    : "border-edge text-content-muted hover:border-accent/50 hover:text-content",
                )}
              >
                <div className="text-content">{o.label}</div>
                {/* 点了会发生什么。只给一个选项名的话,用户得猜 —— 而这四条彼此差别很大
                    (跑 / 不跑 / 往回退 / 收工),猜错的代价不是重来一次那么小。 */}
                <div className="mt-0.5 text-[11px] text-content-subtle">{o.next}</div>
              </button>
            ))}
          </div>

          {/* 输入框**只在那一条要的时候出现**(见 `WorkflowChoiceOption.input`):
              "跳过"什么都不用填,摆一个框只会让人以为必须写点什么。 */}
          {chosenOption?.input !== undefined && (
            <textarea
              value={comment}
              onChange={(ev) => setComment(ev.target.value)}
              disabled={busy}
              rows={3}
              autoFocus
              placeholder={chosenOption.input}
              className="mt-2 w-full resize-y rounded border border-edge bg-surface/60 px-2 py-1 text-xs text-content placeholder:text-content-subtle focus:border-accent focus:outline-none"
            />
          )}

          <div className="mt-3 flex items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              disabled={picked.length === 0 || busy}
              onClick={() => void send()}
            >
              {t("chatStream.workflowAsk.confirm")}
            </Button>
            {/* 收起这个框 —— **不是放弃**。聊天流里那张卡还在,点它一样能选。 */}
            <button
              type="button"
              disabled={busy}
              onClick={() => key !== null && setDismissed(key)}
              className={cn(
                "rounded px-2 py-1 text-xs text-content-subtle transition-colors",
                busy ? "cursor-default" : "cursor-pointer hover:text-content-muted",
              )}
            >
              {t("chatStream.workflowAsk.dismiss")}
            </button>
            {stale && (
              <span className="text-xs text-content-subtle">
                {t("chatStream.workflowChoice.stale")}
              </span>
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
