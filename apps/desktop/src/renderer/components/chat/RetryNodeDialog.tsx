/**
 * **失败卡片上那个「再试一次」按下去之后弹的窗口。**
 *
 * ## 为什么要写一句话,而不是直接重跑
 *
 * 用户的原话是「失败的卡片上开一个窗口,写个方案,从失败那一步接着往下跑」。**不自动
 * 重试**是刻意的:上一次为什么炸,多半只有用户知道(API 额度、网络、某份文件不在、
 * 指令理解错了)。不说一句就重跑,等于把同一件事原样再撞一遍 —— 大概率还是失败,
 * 而这一趟是要花钱的。
 *
 * 写的那句话**只给失败的那一步看**(见 `RunResume.note`),所以窗口里要说清这一点:
 * 用户可能以为它在给整张图下指令。
 *
 * ## 与 `AskChoiceDialog` 的区别
 *
 * 那个是"图停在岔路口等你拍板",弹窗自己从消息流里找待办(全局);这个是**某一张卡上
 * 的一个动作**,由那张卡持有开关与状态 —— 两张失败卡各弹各的,互不干扰。
 *
 * 窗口可以**只按确认、不写字**(`note` 是可选的):"我知道为什么,直接再跑一次"也是
 * 一种正当的用法。
 */
import { useEffect, useState } from "react";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { IconRefresh } from "@renderer/lib/icons.js";
import { Dialog } from "@renderer/components/ui/dialog.js";
import { Button } from "@renderer/components/ui/button.js";
import { api } from "@renderer/lib/api.js";

interface Props {
  open: boolean;
  onClose: () => void;
  sessionId: string;
  /** 那次运行。卡片上有(`workflow-node-result` 的 block 带着)。 */
  runId: string;
  /** 失败的那一步。 */
  nodeId: string;
  onDone?: () => void;
}

/**
 * 点确认时发出去的那个载荷。**抽成纯函数**是为了能直接验它 —— 对话框内部
 * (base-ui 的 Portal)在无头环境里渲染不出来,而这里有两处**光看界面看不出来**的规矩:
 *
 *  - **没写字时 `note` 这个字段整个不发**(而不是发一个空串)。空串会让主进程那边
 *    以为用户写了点什么,而它渲染进提示词就是一句空话。
 *  - **前后空白要去掉** —— 用户敲了个回车再写,不该让提示词里多一行缩进。
 */
export function retryPayload(args: {
  sessionId: string;
  runId: string;
  nodeId: string;
  note: string;
}): { sessionId: string; runId: string; nodeId: string; note?: string } {
  const text = args.note.trim();
  return {
    sessionId: args.sessionId,
    runId: args.runId,
    nodeId: args.nodeId,
    ...(text.length > 0 ? { note: text } : {}),
  };
}

export function RetryNodeDialog({ open, onClose, sessionId, runId, nodeId, onDone }: Props) {
  const { t } = useI18n();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  /** 主进程回了 `ok: false` —— 卡片过期了,或者这个对话正有运行在跑。 */
  const [stale, setStale] = useState<string | null>(null);

  // 每次打开都从空白起 —— 上一张卡写的话留在框里,用户按确认就会把它发给**另一步**。
  useEffect(() => {
    if (open) {
      setNote("");
      setStale(null);
    }
  }, [open, runId, nodeId]);

  const send = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setStale(null);
    try {
      const res = await api.workflow.retry(
        retryPayload({ sessionId, runId, nodeId, note }),
      );
      if (!res.ok) {
        setStale(res.error ?? t("chatStream.workflowRetry.stale"));
        return;
      }
      onDone?.();
      onClose();
    } catch {
      setStale(t("chatStream.workflowRetry.stale"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup
          className="w-[440px] max-w-[90vw] p-4"
          // Enter 提交要手写(base-ui 只管 Esc)。**带上 Ctrl/Cmd** —— 下面那个 textarea
          // 里回车该是换行(同 `AskChoiceDialog`)。
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void send();
            }
          }}
        >
          <div className="flex items-center gap-2">
            <IconRefresh size={15} className="shrink-0 text-accent" />
            <Dialog.Title className="min-w-0 flex-1 truncate">
              {t("chatStream.workflowRetry.title")}
            </Dialog.Title>
          </div>
          {/* 说清重跑范围 —— 用户会想知道"前面跑过的会不会白花"。 */}
          <Dialog.Description className="mt-1">
            {t("chatStream.workflowRetry.desc")}
          </Dialog.Description>

          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={busy}
            rows={4}
            autoFocus
            placeholder={t("chatStream.workflowRetry.ph")}
            className="mt-3 w-full resize-y rounded border border-edge bg-surface/60 px-2 py-1 text-xs leading-relaxed text-content placeholder:text-content-subtle focus:border-accent focus:outline-none"
          />
          {/* 这句话的收件人**只有失败的那一步** —— 不说的话,用户会以为它在给整张图下指令。 */}
          <p className="mt-1 text-[11px] leading-relaxed text-content-subtle">
            {t("chatStream.workflowRetry.scope")}
          </p>

          {stale && (
            <p className="mt-2 text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
              {stale}
            </p>
          )}

          <div className="mt-3 flex items-center gap-2">
            <Button variant="primary" size="sm" disabled={busy} onClick={() => void send()}>
              {t("chatStream.workflowRetry.confirm")}
            </Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={onClose}>
              {t("common.cancel")}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
