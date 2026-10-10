/**
 * MobileSettingsSheet — the minimal settings surface of the web (phone) shell.
 *
 * The desktop SettingsPage (language servers, models, shortcuts, …) is
 * Electron-bound; the phone gets the essentials instead: theme, the
 * center-pane display mode, the server it is paired with, and unpairing.
 * Rendered as a bottom sheet over the chat.
 */
import { useEffect, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { api } from "@renderer/lib/api.js";
import { applyThemeClass } from "@renderer/lib/theme.js";
import { clearAuth } from "@renderer/lib/webApi.js";
import { useToastStore } from "@renderer/stores/toastStore.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import type { ThemeName } from "@contracts/theme";
import type { DisplayMode } from "@contracts/ipc";
import {
  IconX,
  IconSun,
  IconMoon,
  IconDeviceDesktop,
  IconUnlink,
  IconLink,
  IconSquare,
  IconStack2,
} from "@renderer/lib/icons.js";

const THEME_OPTIONS: Array<{ value: ThemeName; labelKey: MessageId; icon: typeof IconSun }> = [
  { value: "system", labelKey: "settings.appearance.themeSystem", icon: IconDeviceDesktop },
  { value: "light", labelKey: "settings.appearance.themeLight", icon: IconSun },
  { value: "dark", labelKey: "settings.appearance.themeDark", icon: IconMoon },
];

/** Same two options (and dictionary keys) as the desktop GeneralPanel's
 *  selector. The value is per-device: the web shell keeps it in this
 *  browser's localStorage (see `@contracts/ipc/settingsSync`), so the phone's
 *  choice never flips the desktop's layout and vice versa. */
const DISPLAY_MODE_OPTIONS: Array<{
  value: DisplayMode;
  labelKey: MessageId;
  icon: typeof IconSun;
}> = [
  { value: "single", labelKey: "settings.general.displayModeSingle", icon: IconSquare },
  { value: "tabs", labelKey: "settings.general.displayModeTabs", icon: IconStack2 },
];

export function MobileSettingsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [theme, setTheme] = useState<ThemeName>("system");
  const [unpairConfirm, setUnpairConfirm] = useState(false);
  const { t } = useI18n();
  const displayMode = useSessionStore((s) => s.displayMode);
  const setDisplayMode = useSessionStore((s) => s.setDisplayMode);

  useEffect(() => {
    if (!open) return;
    void api.theme.get().then((s) => setTheme(s.theme)).catch(() => {
      // ignore — keep the default
    });
  }, [open]);

  if (!open) return null;

  const pickTheme = (next: ThemeName) => {
    setTheme(next);
    // **落盘失败要说出来。** 上面那句 `setTheme(next)` 已经乐观改了卡片外观;
    // 写盘那步静默的话,用户以为换好了,下次打开又弹回旧主题 —— 与桌面端
    // `uiPrefs.persist` / `sessionStore` 那批外观 setter 同一条规矩。
    void api.theme
      .set({ theme: next })
      .then((s) => {
        applyThemeClass(s.effective);
      })
      .catch((err: unknown) => {
        useToastStore.getState().push({
          kind: "error",
          title: t("mobile.settings.themeChangeFailed"),
          body: err instanceof Error ? err.message : String(err),
        });
      });
  };

  const unpair = () => {
    clearAuth();
    // Back to the pairing gate (full reload keeps the module state clean).
    window.location.reload();
  };

  return (
    <div className="fixed inset-0 z-50">
      {/* Backdrop — tap to dismiss. */}
      <button
        type="button"
        aria-label={t("mobile.settings.close")}
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
      />
      <div className="absolute inset-x-0 bottom-0 flex max-h-[85vh] flex-col gap-4 overflow-y-auto rounded-t-2xl border-t border-edge bg-surface-muted p-4 pb-6 text-content">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">{t("layout.settings")}</h2>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-content-muted hover:bg-surface-hover"
          >
            <IconX size={16} />
          </button>
        </div>

        {/* Theme */}
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-content-muted">
            {t("settings.appearance.title")}
          </span>
          <div className="grid grid-cols-3 gap-2">
            {THEME_OPTIONS.map((opt) => {
              const Icon = opt.icon;
              const active = theme === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => pickTheme(opt.value)}
                  className={cn(
                    "flex h-16 flex-col items-center justify-center gap-1 rounded-xl border text-xs",
                    active
                      ? "border-accent bg-accent/10 text-accent"
                      : "border-edge bg-surface/50 text-content-muted hover:bg-surface-hover",
                  )}
                >
                  <Icon size={18} />
                  {t(opt.labelKey)}
                </button>
              );
            })}
          </div>
        </div>

        {/* Display mode — per-device center-pane pref (not synced). On the phone
            it gates the SessionTabs strip above the chat (tabs) vs.
            drawer-only session switching (single). */}
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-content-muted">
            {t("settings.general.displayMode")}
          </span>
          <div className="grid grid-cols-2 gap-2">
            {DISPLAY_MODE_OPTIONS.map((opt) => {
              const Icon = opt.icon;
              const active = displayMode === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => void setDisplayMode(opt.value)}
                  className={cn(
                    "flex h-16 flex-col items-center justify-center gap-1 rounded-xl border text-xs",
                    active
                      ? "border-accent bg-accent/10 text-accent"
                      : "border-edge bg-surface/50 text-content-muted hover:bg-surface-hover",
                  )}
                >
                  <Icon size={18} />
                  {t(opt.labelKey)}
                </button>
              );
            })}
          </div>
          <p className="text-[11px] leading-relaxed text-content-subtle">
            {t("settings.mobile.displayModeHint")}
          </p>
        </div>

        {/* Server */}
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-content-muted">
            {t("mobile.settings.connection")}
          </span>
          <div className="flex items-center gap-2 rounded-xl border border-edge bg-surface/50 px-3 py-2.5 text-xs text-content-muted">
            <IconLink size={14} className="shrink-0" />
            <span className="truncate">
              {t("mobile.settings.connectedTo", {
                origin: window.location.origin || t("mobile.settings.unknownServer"),
              })}
            </span>
          </div>
          {unpairConfirm ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={unpair}
                className="flex h-8 flex-1 items-center justify-center rounded-lg bg-danger px-3 text-xs font-medium text-surface"
              >
                {t("mobile.settings.confirmUnpair")}
              </button>
              <button
                type="button"
                onClick={() => setUnpairConfirm(false)}
                className="flex h-8 flex-1 items-center justify-center rounded-lg border border-edge px-3 text-xs text-content-muted"
              >
                {t("common.cancel")}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setUnpairConfirm(true)}
              className="flex h-9 items-center justify-center gap-1.5 rounded-lg border border-edge px-3 text-xs text-danger hover:bg-surface-hover"
            >
              <IconUnlink size={14} />
              {t("mobile.settings.unpair")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
