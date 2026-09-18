/**
 * composer 上方的长期任务状态条 —— LongTaskRunner 在主进程循环续轮时，这里
 * 是用户唯一能看到「还在干活/跑到第几轮/卡在哪」的地方，也是唯一停止入口。
 *
 * 数据是 store 里 `longTaskBySession[sessionId]` 的投映（事实来源是主进程的
 * `longtask.update` 事件流，见 sessionStore.ingestEvent 的 case）。任务结束时
 * 条子**不自动消失** —— done/blocked/maxed/stopped 的结论（尤其 blocked 的
 * 原因）值得留在眼前，直到用户亲手关掉。
 *
 * ⚠️ **桌面专属**：与 LongTaskSegment 同理，只在 Electron 下挂载。
 */
import { useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { IconLoader2, IconPlayerStop, IconRefresh, IconTarget, IconX } from "@renderer/lib/icons.js";
import { api } from "@renderer/lib/api.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import type { LongTaskStatus } from "@contracts/longTask";
import type { MessageId } from "@renderer/lib/i18n/core.js";

/** 终局状态 → 展示色。running 用 accent 主色，done 绿，blocked/maxed 暖警示，stopped 灰。 */
function statusTone(status: LongTaskStatus): { dot: string; label: MessageId } {
  switch (status) {
    case "running":
      return { dot: "text-accent", label: "composer.longtask.running" };
    case "done":
      return { dot: "text-green-600 dark:text-green-400", label: "composer.longtask.status.done" };
    case "blocked":
      return { dot: "text-amber-600 dark:text-amber-400", label: "composer.longtask.status.blocked" };
    case "maxed":
      return { dot: "text-amber-600 dark:text-amber-400", label: "composer.longtask.status.maxed" };
    case "stopped":
      return { dot: "text-content-subtle", label: "composer.longtask.status.stopped" };
  }
}

export function LongTaskBanner({ sessionId }: { sessionId: string }) {
  const { t } = useI18n();
  const task = useSessionStore((s) => s.longTaskBySession[sessionId]);
  const dismiss = useSessionStore((s) => s.dismissLongTask);
  const [stopping, setStopping] = useState(false);

  if (!task) return null;
  const running = task.status === "running";
  const tone = statusTone(task.status);

  const stop = async (): Promise<void> => {
    setStopping(true);
    try {
      await api.longtask.stop({ sessionId });
    } catch {
      // 停不下来多半是 IPC 抖动；turn.done(interrupted) 事件仍会把任务收场。
    } finally {
      setStopping(false);
    }
  };

  return (
    <div
      className={cn(
        "mx-1 mb-1 flex items-center gap-2 rounded-lg border border-edge bg-surface-muted/60 px-2.5 py-1.5 text-[12px]",
      )}
    >
      {/* 状态图标：跑着转圈，结束定格成带色圆点 */}
      <span className="shrink-0">
        {running ? (
          <IconLoader2 size={14} className="animate-spin text-accent" />
        ) : (
          <IconTarget size={14} className={tone.dot} />
        )}
      </span>

      {/* 状态词 + 轮次 */}
      <span className={cn("shrink-0 font-medium", running ? "text-accent" : tone.dot)}>
        {running
          ? t("composer.longtask.banner.round", { n: task.iterations, m: task.maxIterations })
          : t(tone.label)}
      </span>

      {/* 目标（跑着时）或结论说明（结束时）。min-w-0 + truncate 保证长目标不撑破条子 */}
      <span className="min-w-0 flex-1 truncate text-content-muted" title={task.goal}>
        {running ? (
          <span className="inline-flex items-center gap-1">
            <IconRefresh size={11} className="opacity-60" />
            {task.goal}
          </span>
        ) : (
          task.note || task.goal
        )}
      </span>

      {/* 右侧动作：跑着 → 停止；结束 → 关掉条子 */}
      {running ? (
        <button
          type="button"
          onClick={stop}
          disabled={stopping}
          title={t("composer.longtask.banner.stop")}
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-content-muted outline-none select-none transition-colors duration-100 hover:bg-surface hover:text-red-600 dark:hover:text-red-400 disabled:opacity-60"
        >
          <IconPlayerStop size={12} />
          {stopping ? t("composer.longtask.banner.stopping") : t("composer.longtask.banner.stop")}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => dismiss(sessionId)}
          title={t("composer.longtask.banner.dismiss")}
          className="shrink-0 rounded-md p-0.5 text-content-subtle outline-none select-none transition-colors duration-100 hover:bg-surface hover:text-content"
        >
          <IconX size={12} />
        </button>
      )}
    </div>
  );
}
