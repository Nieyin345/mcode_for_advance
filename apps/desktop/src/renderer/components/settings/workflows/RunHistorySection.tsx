/**
 * 运行历史面板:后台会话里**一次一次的 run**(带节点数,能展开看节点级信息)。
 *
 * ## 和检查器里那段「自动化状态」是两份不同的读法
 *
 * `AutomationRunSection` 的历史读的是 `automation.runs` —— **从存档折出来的摘要**,
 * 一步一行,适合"上一次跑成什么样"扫一眼。这一栏读的是 `runs.history` —— 后台会话
 * 的 run 记录本身,所以每条带**节点数**(契约定的是轻量摘要,没有节点明细 —— 展开
 * 看 id 全文与收尾时刻)。两份摆在一起,一份答"结果",一份答"过程"。
 *
 * ## 挂载方式与 AutomationRunSection 同一条纪律
 *
 * 全部项目会话 id 来自 `automation.sessions`，每次刷新重新获取并汇总历史。
 * `runs.history` 读不出来就**当没有**:显示一句读不出来的小字,不弹错 —— 右栏是常用
 * 面板,为一条还没就绪的通道常驻红字没有意义(同 `AutomationRunSection` 文件头)。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ComponentType } from "react";
import type { PersistedWorkflowRunLite } from "@contracts/ipc";
import { api } from "@renderer/lib/api.js";
import { loadAutomationHistory } from "@renderer/lib/automationHistory.js";
import { cn } from "@renderer/lib/cn.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import {
  IconAlertTriangle,
  IconChevronDown,
  IconCircleCheck,
  IconCircleOff,
  IconLoader2,
  IconRefresh,
} from "@renderer/lib/icons.js";
import { formatFullTime, formatRelativeTime } from "@renderer/lib/time.js";

// `runs.history` 的行形状就是契约里的 `PersistedWorkflowRunLite`(见 `@contracts/ipc`
// 的 orchestration 域)—— 历史列表只要"跑过几次、成没成、几步",不要整份快照。

/** 一行 run 状态的画法(`AutomationRunStatus` 闭合集合 → 图标/颜色/词条)。
 *  **导出**给 `monitoring/MonitoringPanel` 复用 —— 监控页的 run 状态是同一套词。 */
export const RUN_STATUS_META: Record<string, { Icon: ComponentType<{ size: number; className?: string }>; tone: string; labelKey: MessageId }> = {
  success: { Icon: IconCircleCheck, tone: "text-success", labelKey: "settings.automation.runStatus.success" },
  failed: { Icon: IconAlertTriangle, tone: "text-danger", labelKey: "settings.automation.runStatus.failed" },
  running: { Icon: IconLoader2, tone: "text-accent", labelKey: "settings.automation.runStatus.running" },
  interrupted: { Icon: IconAlertTriangle, tone: "text-warning", labelKey: "settings.automation.runStatus.interrupted" },
  cancelled: { Icon: IconCircleOff, tone: "text-content-muted", labelKey: "settings.automation.runStatus.cancelled" },
};

export function RunHistorySection({ workflowId }: { workflowId: string }) {
  const { t } = useI18n();
  // Ignore stale refreshes after a workflow switch or unmount.
  const refreshVersion = useRef(0);
  const [runs, setRuns] = useState<PersistedWorkflowRunLite[]>([]);
  /** 通道没就绪/读失败的原因。**只占一行小字**,不弹错。 */
  const [error, setError] = useState<string | null>(null);
  /** 展开的是哪一条(runId)。单开:一次只看一条的过程,再点一条就换。 */
  const [expanded, setExpanded] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    const version = ++refreshVersion.current;
    try {
      const rows = await loadAutomationHistory(workflowId, {
        sessions: (input) => api.automation.sessions(input),
        history: (input) => api.runs.history(input),
      });
      if (version !== refreshVersion.current) return;
      setRuns(rows);
      setError(null);
    } catch (err) {
      if (version !== refreshVersion.current) return;
      setRuns([]);
      setError((err as Error).message);
    }
  }, [workflowId]);

  useEffect(() => {
    setRuns([]);
    setExpanded(null);
    void refresh();
    return () => { refreshVersion.current += 1; };
  }, [refresh]);

  return (
    <div className="mt-3 border-t border-edge pt-3">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[0.7857em] font-medium text-content-muted">
          {t("settings.runHistory.title")}
        </span>
        <button
          type="button"
          title={t("settings.automation.refresh")}
          onClick={() => void refresh()}
          className="rounded p-0.5 text-content-subtle transition-colors hover:bg-surface-hover hover:text-content"
        >
          <IconRefresh size={11} />
        </button>
      </div>

      {error !== null && (
        <p className="text-[0.7143em] leading-relaxed text-content-subtle">
          {t("settings.runHistory.loadFailed", { error })}
        </p>
      )}

      {runs.length === 0 ? (
        error === null && (
          <p className="text-[0.7143em] leading-relaxed text-content-subtle">
            {t("settings.runHistory.empty")}
          </p>
        )
      ) : (
        <div className="mt-2 space-y-1.5">
          {runs.map((run) => {
            const meta = RUN_STATUS_META[run.status];
            const open = expanded === run.runId;
            return (
              <div key={run.runId} className="rounded border border-edge bg-surface p-1.5">
                <button
                  type="button"
                  onClick={() => setExpanded(open ? null : run.runId)}
                  className="flex w-full cursor-pointer items-center gap-1.5 text-left text-[0.7143em]"
                >
                  {meta ? (
                    <meta.Icon size={12} className={cn("shrink-0", meta.tone)} />
                  ) : (
                    <IconCircleOff size={12} className="shrink-0 text-content-subtle" />
                  )}
                  <span className={cn("shrink-0 font-medium", meta?.tone ?? "text-content-muted")}>
                    {meta ? t(meta.labelKey) : run.status}
                  </span>
                  {/* 相对时间读起来快,准确时刻进 title(同 AutomationRunSection)。 */}
                  <span className="shrink-0 text-content-subtle" title={formatFullTime(run.createdAt)}>
                    {formatRelativeTime(run.createdAt)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-content-muted">
                    {t("settings.runHistory.nodeCount", { n: run.nodeCount })}
                  </span>
                  <IconChevronDown
                    size={11}
                    className={cn(
                      "shrink-0 text-content-subtle transition-transform",
                      open && "rotate-180",
                    )}
                  />
                </button>
                {/* 契约的行是**轻量摘要**(PersistedWorkflowRunLite),没有节点明细 ——
                    展开能看的就是 id 全文与收尾时刻(列表行上被截断的那些)。 */}
                {open && (
                  <p className="mt-1 border-t border-edge/60 pt-1 text-[0.7143em] leading-relaxed">
                    <code className="text-content-subtle">{run.runId}</code>
                    <span className="text-content-subtle" title={formatFullTime(run.updatedAt)}>
                      {" · "}
                      {formatRelativeTime(run.updatedAt)}
                    </span>
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
