/**
 * Sidebar quick actions — compact full-width entry points near the top of the
 * left navigation, below the window/sidebar controls:
 *
 *   新建会话 — starts a new thread in the active project (primary, accent CTA).
 *   搜索     — opens the unified Ctrl+K search palette.
 *
 * Each button occupies its own row and carries a trailing `<Kbd>` keycap badge
 * (from the UI component library) built from the effective shortcut (user
 * override ?? default), so the hint always matches what the keyboard actually
 * does. "新建会话" is disabled when there is no active project (mirrors the
 * `session.new` command's `available` guard).
 *
 * The actions sit above the Recents / Pinned / Projects navigation stack so
 * the most-used workspace entry points remain visible without scrolling.
 *
 * `showSearch` / `showConnectPhone` drop the matching entries — the mobile
 * drawer hides both: there is no Ctrl+K on a phone, and its visitor is
 * already on the phone.
 */
import { cn } from "@renderer/lib/cn.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import {
  resolveShortcut,
  acceleratorToDisplayTokens,
} from "@renderer/lib/shortcuts.js";
import { IconGitFork, IconPlus, IconSearch } from "@renderer/lib/icons.js";
import { Kbd } from "@renderer/components/ui/index.js";
import { MobileConnectButton } from "@renderer/components/layout/MobileConnectDialog.js";
import { useI18n } from "@renderer/lib/i18n/index.js";

/** Trailing keyboard badge, consistent with the command palette. Subscribes to
 *  overrides so it updates live when the user rebinds in settings. */
function ShortcutBadge({ commandId }: { commandId: string }) {
  const overrides = useSessionStore((s) => s.shortcutOverrides);
  const accel = resolveShortcut(commandId, overrides);
  if (!accel) return null;
  return <Kbd keys={acceleratorToDisplayTokens(accel)} size="xs" />;
}

export function SidebarQuickActions({
  showSearch = true,
  showConnectPhone = true,
  newSessionOverride,
  newSessionOverrideTitle,
}: {
  /** Hide the 搜索 entry (mobile drawer: no keyboard to trigger Ctrl+K). */
  showSearch?: boolean;
  /** Hide the 连接手机 entry (mobile drawer: the visitor is already the phone). */
  showConnectPhone?: boolean;
  /** When set, 新建会话 dispatches here instead of the default
   *  active-project start (stream view scoped to a worktree: spawn the
   *  session in THAT checkout; scoped to a plain project: spawn it under
   *  THAT project). Title flips to the override wording unless
   *  `newSessionOverrideTitle` says otherwise. */
  newSessionOverride?: () => void;
  /** Already-translated tooltip for the override state (defaults to the
   *  worktree wording — the original override case). */
  newSessionOverrideTitle?: string;
} = {}) {
  const { t } = useI18n();
  const startSession = useSessionStore((s) => s.startSession);
  const setCommandPaletteOpen = useSessionStore((s) => s.setCommandPaletteOpen);
  const activeProjectId = useSessionStore((s) => s.activeProjectId);

  const canNewSession = newSessionOverride != null || activeProjectId !== null;

  return (
    <div className="mb-2 flex min-w-0 flex-col gap-1.5" data-sidebar-quick-actions="">
      {/* 新建会话 — 静止态与 hover 都不染品牌色：它只是「能点」，不是
          「正在跑」也不是「被选中」。与下方搜索入口保持同一套中性 hover。 */}
      <button
        type="button"
        data-sidebar-quick-action="new"
        onClick={() => {
          if (newSessionOverride) newSessionOverride();
          else if (canNewSession) void startSession();
        }}
        disabled={!canNewSession}
        aria-label={t("layout.newSession")}
        title={
          newSessionOverride
            ? newSessionOverrideTitle ?? t("layout.newSessionInWorktree")
            : canNewSession
              ? t("layout.newSessionInProject")
              : t("layout.needProject")
        }
        className={cn(
          "flex min-h-10 min-w-0 w-full items-center gap-2.5 rounded-[var(--radius-btn-xs)] px-2.5 py-2 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
          "[font-size:var(--right-panel-font-size)]",
          canNewSession
            ? "text-content-muted hover:bg-surface-hover active:bg-surface-active hover:text-content"
            : "cursor-not-allowed text-content-subtle opacity-50",
        )}
      >
        {newSessionOverride ? (
          <IconGitFork size={16} className="shrink-0" />
        ) : (
          <IconPlus size={16} className="shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate text-left font-medium">{t("layout.newSession")}</span>
        <ShortcutBadge commandId="session.new" />
      </button>

      {/* 搜索 — entry to the unified Ctrl+K palette. Mirrors 新建会话's
          neutral rest + neutral hover so the two read as a matched pair. */}
      {showSearch && (
        <button
          type="button"
          data-sidebar-quick-action="search"
          onClick={() => setCommandPaletteOpen(true)}
          aria-label={t("common.search")}
          title={t("layout.palette.placeholder.all")}
          className={cn(
            "flex min-h-10 min-w-0 w-full items-center gap-2.5 rounded-[var(--radius-btn-xs)] px-2.5 py-2 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
            "[font-size:var(--right-panel-font-size)]",
            "cds-hover-ghost text-content-muted hover:text-content",
          )}
        >
          <IconSearch size={16} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate text-left font-medium">{t("common.search")}</span>
          <ShortcutBadge commandId="command.palette" />
        </button>
      )}

      {/* 连接手机 — LAN pairing (QR + 6-digit code) / remote relay. Rendered
          as a self-contained trigger + dialog so the sidebar just hosts it;
          the button style mirrors 搜索/新建会话 so all three read as a matched
          group of workspace entry points. */}
      {showConnectPhone && <MobileConnectButton />}
    </div>
  );
}
