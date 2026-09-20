import { useSessionStore, EMPTY_USAGE } from "@renderer/stores/sessionStore.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { IconChartBar } from "@renderer/lib/icons.js";
import { ModelDropdown } from "./ModelDropdown.js";
import { EffortChip, PermissionChip } from "./EffortPermissionControl.js";
import { WorkflowDropdown } from "./WorkflowDropdown.js";
import { WatchSegment } from "./WatchSegment.js";
import { LongTaskSegment } from "./LongTaskSegment.js";
import { isElectron } from "@renderer/lib/platform.js";
import { ContextRing } from "./ContextRing.js";
import { AttachMenuButton } from "./AttachMenuButton.js";

/**
 * In-composer session-config controls — the mini pill (prototypes/
 * composer-redesign.html 方案 B, single-pill revision). One implementation,
 * two presentations:
 *
 * - layout="pill" (default): the ONLY inline presentation, rendered at every
 *   composer width. One bordered container whose segments are, in order:
 *   attach "+" → model → effort → permission → context ring. Every segment
 *   is its own trigger opening the very same menus/popovers as before, so
 *   "which model / level / permission" stays readable AND directly clickable
 *   no matter how narrow the card gets; the + and the ring persist through
 *   every tier (the user-facing requirement). `compact` (tier 1, see
 *   useComposerRowFit) collapses the segment labels through animatable grid
 *   shells (`.composer-lblwrap`) — icons + effort level bars + permission
 *   color remain; the ring's % number collapses the same way, the ring
 *   itself stays.
 *
 * - layout="row": the vertical settings list hosted inside the collapsed
 *   hosts' toggle popup ({@link ComposerToolbarToggle} — side-chat panel /
 *   phone shell). Each control becomes a full-width labelled row — field
 *   name on the left, current value on the right — so the whole next-turn
 *   config is scannable at a glance without opening any dropdown, and hit
 *   targets span the panel width. The dropdown menus fly out to the RIGHT of
 *   their row (cascading, like a context menu) so the list itself stays
 *   visible while choosing; on phone-class viewports — where panel + menu
 *   can't sit side by side — they open upward instead (see
 *   useNarrowViewport). The ContextRing closes the list as a read-only
 *   status row behind a top border — it indicates, it doesn't select.
 *
 * NOTE: the SDK picker ({@link ProviderDropdown}) is deliberately NOT part
 * of the pill — it lives directly to the left of the send button in
 * ChatPane, so it stays visible (and locked per-session) regardless of the
 * pill's compactness.
 */
export function ComposerToolbar({
  sessionId,
  layout = "pill",
  compact = false,
  attachDisabled = false,
  onPickFiles,
  onPickImages,
  onPickLibraries,
  onPickTemplates,
  onSlashCommand,
  onNewSubChat,
}: {
  sessionId: string;
  /** Presentation: inline mini pill ("pill") vs vertical settings list
   *  ("row"). */
  layout?: "pill" | "row";
  /** Pill only: collapse segment labels to icons (tier 1). */
  compact?: boolean;
  /** Pill only: forwarded to the attach segment's disabled state (input is
   *  blocked while an approval / question prompt owns the composer). */
  attachDisabled?: boolean;
  /** Pill only: attach-segment actions (same callbacks the standalone
   *  AttachMenuButton took in ChatPane). */
  onPickFiles?: () => void;
  onPickImages?: () => void;
  onPickLibraries?: () => void;
  /** 模版选择器 —— 与文献库并列的第二个「库」(见 TemplatePicker)。 */
  onPickTemplates?: () => void;
  onSlashCommand?: () => void;
  /**
   * 「新建子对话」建好之后的通知 —— **可选,缺省什么都不做**。
   *
   * 只是透传给 {@link AttachMenuButton}:菜单项本身与那个选择器全在那边(`+` 按钮的
   * rect 就是它自己的锚点,不需要宿主给任何东西),所以这里**不做成必填** ——
   * 见 `AttachMenuButton` 上那段:多一个必填的会让 `hasAttach` 判据把整块「+」吃掉。
   * 宿主(如 ChatPane)接上它之后可以做点界面上的事:切到右侧面板、弹个提示。
   */
  onNewSubChat?: (session: { id: string; title: string }) => void;
}) {
  const { t } = useI18n();
  // Context-window snapshot for THIS pane's session. Drives the ring segment
  // (pill) / status row (row layout). Undefined until the first
  // token-usage.updated event arrives (or a persisted snapshot is hydrated
  // from the session row). Reading the pane's own sessionId (not the global
  // activeSessionId) means a backgrounded tab's toolbar no longer
  // re-renders when the foreground tab changes — each toolbar tracks its own
  // session.
  const contextSnapshot = useSessionStore((s) => s.contextSnapshotBySession[sessionId]);
  // Per-session finalized-turn usage records, feeding the ring's history view.
  // `?? EMPTY_USAGE` keeps the selector's return stable across renders (a
  // bare `?? []` would create a new array each time and trip re-renders).
  const usageHistory = useSessionStore((s) => s.usageHistoryBySession[sessionId] ?? EMPTY_USAGE);
  // Pill only: which segments render (a provider may declare no thinking
  // levels or no permission modes — dividers must not dangle around an
  // absent segment).
  const providerId = useSessionStore((s) => s.providerId);
  const providers = useSessionStore((s) => s.providers);
  const caps = providers.find((p) => p.id === providerId)?.capabilities;
  const hasEffort = (caps?.thinkingLevels?.length ?? 0) > 0;
  const hasPerm = (caps?.permissionModes?.length ?? 0) > 0;

  if (layout === "row") {
    return (
      <div className="flex w-72 flex-col items-stretch gap-0.5">
        <ModelDropdown layout="row" />
        <EffortChip layout="row" />
        <PermissionChip layout="row" />
        <WorkflowDropdown layout="row" />
        {/* 长任务守望:把一条命令绑到这个会话上起跑。桌面专属(手机 RPC 白名单
            没有 automation.watch) —— 手机壳里这一行整个不出现。 */}
        {isElectron && <WatchSegment sessionId={sessionId} layout="row" />}
        {/* 长期任务循环:把下一条消息当目标,自动续轮直到模型宣布完成。桌面专属。 */}
        {isElectron && <LongTaskSegment sessionId={sessionId} layout="row" />}
        {contextSnapshot && (
          <div className="mt-1 flex items-center justify-between gap-2 border-t border-edge/60 px-2.5 pt-2">
            <span className="flex items-center gap-2 text-[13px] font-medium text-content-muted">
              <IconChartBar size={14} className="shrink-0 opacity-80" />
              {t("chat.context.rowLabel")}
            </span>
            <ContextRing snapshot={contextSnapshot} history={usageHistory} />
          </div>
        )}
      </div>
    );
  }

  // The mini pill: attach → model → effort → permission → ring, each a
  // separately-clickable segment behind a hairline divider. The attach and
  // ring segments never collapse (the + and the ring must stay visible at
  // every width); labels collapse under `compact` via CSS grid shells keyed
  // off data-compact.
  const hasAttach =
    !!onPickFiles && !!onPickImages && !!onPickLibraries && !!onPickTemplates && !!onSlashCommand;
  return (
    <div className="composer-minipill" data-compact={compact ? "1" : "0"}>
      {hasAttach && (
        <>
          <AttachMenuButton
            segment
            disabled={attachDisabled}
            onPickFiles={onPickFiles}
            onPickImages={onPickImages}
            onPickLibraries={onPickLibraries}
            onPickTemplates={onPickTemplates}
            onSlashCommand={onSlashCommand}
            onNewSubChat={onNewSubChat}
          />
          <span className="composer-minipill-mid" aria-hidden />
        </>
      )}
      <ModelDropdown layout="pill" />
      {/* 工作模式选择器（默认 / 文献检索 / 文献精读 / 文献写作 / 文献评审 / 代码编辑）。
          模式跟着会话走，与模型选择同一套机制；除默认与检索外都会变成系统提示词片段。
          绑哪个文献库仍由「+」菜单里的「文献库」负责 —— 药丸上不重复这个入口。 */}
      <span className="composer-minipill-mid" aria-hidden />
      <WorkflowDropdown layout="pill" />
      {/* 长任务守望(桌面专属):起跑面板里选模板 / 现写命令,把一条长命令绑到当前
          会话上 —— 与上面那个「跟会话走的工作模式」是两回事,它跑在自动化会话里。 */}
      {isElectron && <WatchSegment sessionId={sessionId} layout="pill" />}
      {/* 长期任务循环(桌面专属):武装开关,下一条消息就是任务书。 */}
      {isElectron && <LongTaskSegment sessionId={sessionId} layout="pill" />}
      {hasEffort && (
        <>
          <span className="composer-minipill-mid" aria-hidden />
          <EffortChip layout="pill" />
        </>
      )}
      {hasPerm && (
        <>
          <span className="composer-minipill-mid" aria-hidden />
          <PermissionChip layout="pill" />
        </>
      )}
      {contextSnapshot && (
        <>
          <span className="composer-minipill-mid" aria-hidden />
          <span className="composer-minipill-ringseg">
            <ContextRing snapshot={contextSnapshot} history={usageHistory} />
          </span>
        </>
      )}
    </div>
  );
}
