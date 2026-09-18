/**
 * 输入框工具栏上的「长任务」段 —— 一个**一次性武装开关**：打开后，下一条发送的
 * 消息会被主进程 LongTaskRunner 当成目标，turn.done 一到就自动续轮，反复执行
 * 直到模型在回复末尾宣布完成（[[TASK_DONE]]）或卡死（[[TASK_BLOCKED: …]]）。
 *
 * ## 为什么是开关而不是面板
 *
 * 它没有自己的配置 —— 目标就是用户接下来敲的那条消息（本来就要发的东西），轮数
 * 上限有默认值。比起一个「填目标再启动」的表单，开关的语义更诚实：**你的下一条
 * 消息就是任务书**。真正需要的反馈（跑到第几轮/卡在哪/怎么停）由 composer 上方
 * 的状态条 {@link LongTaskBanner} 负责，两个组件读的是同一份 store 投映。
 *
 * ## 与「长任务守望」的区别
 *
 * 守望（WatchSegment）是「跑一条 shell 命令，跑完把输出交回会话」—— 一次性的。
 * 这里是「让模型自己带着工具反复干到目标达成」—— 多轮循环。名字相近，机制完全
 * 不同，所以图标和文案都刻意区分（刷新箭头 = 循环）。
 *
 * ⚠️ **桌面专属**：主进程循环器 + IPC 都只在 Electron 里有；整段在
 * `ComposerToolbar` 里用 `isElectron` 门控，手机端不渲染。
 */
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { IconRefresh } from "@renderer/lib/icons.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";

export function LongTaskSegment({
  sessionId,
  layout = "pill",
}: {
  sessionId: string;
  layout?: "pill" | "row";
}) {
  const { t } = useI18n();
  const armed = useSessionStore((s) => !!s.longTaskArmedBySession[sessionId]);
  const task = useSessionStore((s) => s.longTaskBySession[sessionId]);
  const running = task?.status === "running";
  const toggle = useSessionStore((s) => s.toggleLongTaskArmed);

  // 有任务在跑时不允许再武装 —— 循环器一个会话同时只挂一个任务。
  const onClick = () => {
    if (!running) toggle(sessionId);
  };

  const label = running
    ? t("composer.longtask.running")
    : armed
      ? t("composer.longtask.armed")
      : t("composer.longtask.pillLabel");
  const hint = running
    ? t("composer.longtask.banner.round", {
        n: task?.iterations ?? 0,
        m: task?.maxIterations ?? 0,
      })
    : t("composer.longtask.armHint");

  if (layout === "row") {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={running}
        title={hint}
        className="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-[13px] outline-none select-none transition-colors duration-100 text-content-muted hover:bg-surface-muted hover:text-content disabled:opacity-60"
      >
        <span className="flex min-w-0 items-center gap-2">
          <IconRefresh
            size={14}
            className={cn("shrink-0", (armed || running) && "text-accent")}
          />
          <span className="shrink-0 font-medium text-content">{t("composer.longtask.rowLabel")}</span>
        </span>
        <span className={cn("shrink-0 text-[11px]", (armed || running) && "text-accent")}>
          {label}
        </span>
      </button>
    );
  }

  // 药丸段：逐字对齐 WatchSegment 的 pill 触发器（composer-minipill-seg +
  // composer-lblwrap 标签壳 —— 药丸变窄时把文字收掉，只留刷新图标）。
  return (
    <>
      <span className="composer-minipill-mid" aria-hidden />
      <button
        type="button"
        onClick={onClick}
        disabled={running}
        title={hint}
        className={cn(
          "composer-minipill-seg",
          (armed || running) && "text-accent",
        )}
      >
        <span className="shrink-0 opacity-80">
          <IconRefresh size={13} />
        </span>
        <span className="composer-lblwrap">
          <span className="max-w-[72px] truncate">{label}</span>
        </span>
      </button>
    </>
  );
}
