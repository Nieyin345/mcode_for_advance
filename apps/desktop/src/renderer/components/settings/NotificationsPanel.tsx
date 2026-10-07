/**
 * Notifications settings panel.
 *
 * Controls the user's notification preferences (NotificationPrefs), persisted
 * via the `notification:setPrefs` IPC. The main-process NotificationManager
 * reads these to decide whether to fire OS notifications; the renderer's
 * in-app toast layer (sessionStore.pushToast) also respects the same prefs
 * indirectly (toasts only fire when the window is focused, at which point OS
 * notifications are suppressed - so the prefs gate the toast content too).
 *
 * Five toggles:
 *  - OS 通知总开关   (osEnabled) - master switch for system notifications
 *  - 阻塞类事件      (blocking)  - approval / question / plan approval
 *  - 回合完成        (turnComplete)
 *  - 错误            (errors)
 *  - 后台任务        (backgroundTasks)
 */
import { useEffect, useMemo, useState } from "react";
import { PANEL_MAX_W } from "./panelWidth.js";
import { api } from "@renderer/lib/api.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import type { NotificationPrefs } from "@contracts/ipc";
import { DEFAULT_NOTIFICATION_PREFS, normalizeNotificationPrefs } from "@contracts/ipc";
import { Input, Switch } from "@renderer/components/ui/index.js";
import { setCachedNotificationPrefs } from "@renderer/lib/notifPrefsCache.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useToastStore } from "@renderer/stores/toastStore.js";
import { PanelHeader } from "./PanelHeader.js";
import { SettingRow } from "./SettingRow.js";
import { SettingsSection } from "./SettingsSection.js";

export function NotificationsPanel() {
  const { t } = useI18n();
  const [prefs, setPrefs] = useState<NotificationPrefs>(DEFAULT_NOTIFICATION_PREFS);
  const [loaded, setLoaded] = useState(false);

  // Load prefs on mount.
  useEffect(() => {
    // 读失败也要解锁开关(用默认值):以前没有 catch,一次 IPC 失败整页开关永远是灰的。
    void api.notification
      .getPrefs()
      .then((res) => setPrefs(normalizeNotificationPrefs(res.prefs)))
      .catch((err: unknown) => console.error("notification.getPrefs failed:", err))
      .finally(() => setLoaded(true));
  }, []);

  // Persist a single pref change.
  const update = (patch: Partial<NotificationPrefs>) => {
    const prev = prefs;
    const next = { ...prefs, ...patch };
    setPrefs(next);
    setCachedNotificationPrefs(next);
    // **写失败要把两边都收回去。** 只打日志的话:UI 与渲染端缓存都按新值走了
    // (应用内 toast 立刻按新偏好),而主进程 NotificationManager 仍是旧偏好 ——
    // 用户以为关掉了某类系统通知、实际照旧弹;缓存还被 `primed` 锁住不再重取,
    // 进一步掩盖不一致。回滚 + 弹一条可见错误。
    void api.notification.setPrefs(next).catch((err: unknown) => {
      console.error("notification.setPrefs failed:", err);
      setPrefs(prev);
      setCachedNotificationPrefs(prev);
      useToastStore.getState().push({
        kind: "error",
        title: t("settings.saveFailed"),
        body: err instanceof Error ? err.message : String(err),
      });
    });
  };

  const projects = useSessionStore((s) => s.projects);
  const liveProjects = useMemo(() => projects.filter((p) => !p.archived), [projects]);
  const muted = useMemo(() => new Set(prefs.mutedProjectIds), [prefs.mutedProjectIds]);
  const toggleProject = (id: string, notify: boolean) => {
    const set = new Set(prefs.mutedProjectIds);
    if (notify) set.delete(id);
    else set.add(id);
    update({ mutedProjectIds: [...set] });
  };
  const setQuiet = (patch: Partial<NotificationPrefs["quietHours"]>) =>
    update({ quietHours: { ...prefs.quietHours, ...patch } });

  return (
    <section className={`mx-auto w-full ${PANEL_MAX_W.form} space-y-4`}>
      <PanelHeader title={t("settings.notifications.title")} />

      {/* Single category → one card of toggle rows. */}
      <SettingsSection title={t("settings.notifications.section")}>
        {/* Master OS notification switch */}
        <SettingRow
          title={t("settings.notifications.osTitle")}
          desc={t("settings.notifications.osDesc")}
          htmlFor="setting-notif-os"
        >
          <Switch
            id="setting-notif-os"
            checked={prefs.osEnabled}
            disabled={!loaded}
            onCheckedChange={(v) => update({ osEnabled: v })}
            label={prefs.osEnabled ? t("settings.on") : t("settings.off")}
          />
        </SettingRow>

        {/* Blocking events */}
        <SettingRow
          title={t("settings.notifications.blockingTitle")}
          desc={t("settings.notifications.blockingDesc")}
        >
          <Switch
            checked={prefs.blocking}
            disabled={!loaded}
            onCheckedChange={(v) => update({ blocking: v })}
            label={prefs.blocking ? t("settings.on") : t("settings.off")}
          />
        </SettingRow>

        {/* Turn completion */}
        <SettingRow
          title={t("settings.notifications.turnTitle")}
          desc={t("settings.notifications.turnDesc")}
        >
          <Switch
            checked={prefs.turnComplete}
            disabled={!loaded}
            onCheckedChange={(v) => update({ turnComplete: v })}
            label={prefs.turnComplete ? t("settings.on") : t("settings.off")}
          />
        </SettingRow>

        {/* Errors */}
        <SettingRow
          title={t("settings.notifications.errorsTitle")}
          desc={t("settings.notifications.errorsDesc")}
        >
          <Switch
            checked={prefs.errors}
            disabled={!loaded}
            onCheckedChange={(v) => update({ errors: v })}
            label={prefs.errors ? t("settings.on") : t("settings.off")}
          />
        </SettingRow>

        {/* Background tasks */}
        <SettingRow
          title={t("settings.notifications.backgroundTitle")}
          desc={t("settings.notifications.backgroundDesc")}
        >
          <Switch
            checked={prefs.backgroundTasks}
            disabled={!loaded}
            onCheckedChange={(v) => update({ backgroundTasks: v })}
            label={prefs.backgroundTasks ? t("settings.on") : t("settings.off")}
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={t("settings.notifications.styleSection")}>
        <SettingRow title={t("settings.notifications.soundTitle")} desc={t("settings.notifications.soundDesc")}>
          <Switch
            checked={prefs.sound}
            disabled={!loaded || !prefs.osEnabled}
            onCheckedChange={(v) => update({ sound: v })}
            label={prefs.sound ? t("settings.on") : t("settings.off")}
          />
        </SettingRow>
        <SettingRow title={t("settings.notifications.inAppTitle")} desc={t("settings.notifications.inAppDesc")}>
          <Switch
            checked={prefs.inAppToasts}
            disabled={!loaded}
            onCheckedChange={(v) => update({ inAppToasts: v })}
            label={prefs.inAppToasts ? t("settings.on") : t("settings.off")}
          />
        </SettingRow>
        <SettingRow title={t("settings.notifications.focusedTitle")} desc={t("settings.notifications.focusedDesc")}>
          <Switch
            checked={prefs.alsoWhenFocused}
            disabled={!loaded || !prefs.osEnabled}
            onCheckedChange={(v) => update({ alsoWhenFocused: v })}
            label={prefs.alsoWhenFocused ? t("settings.on") : t("settings.off")}
          />
        </SettingRow>
        <SettingRow title={t("settings.notifications.quietTitle")} desc={t("settings.notifications.quietDesc")}>
          <div className="flex items-center gap-2">
            {prefs.quietHours.enabled && (
              <>
                <Input
                  type="time"
                  value={prefs.quietHours.start}
                  onChange={(e) => {
                    if (/^\d{2}:\d{2}$/.test(e.target.value)) setQuiet({ start: e.target.value });
                  }}
                  className="w-[6.5rem]"
                  aria-label={t("settings.notifications.quietStart")}
                />
                <span className="text-xs text-content-subtle">→</span>
                <Input
                  type="time"
                  value={prefs.quietHours.end}
                  onChange={(e) => {
                    if (/^\d{2}:\d{2}$/.test(e.target.value)) setQuiet({ end: e.target.value });
                  }}
                  className="w-[6.5rem]"
                  aria-label={t("settings.notifications.quietEnd")}
                />
              </>
            )}
            <Switch
              checked={prefs.quietHours.enabled}
              disabled={!loaded}
              onCheckedChange={(v) => setQuiet({ enabled: v })}
              label={prefs.quietHours.enabled ? t("settings.on") : t("settings.off")}
            />
          </div>
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={t("settings.notifications.projectSection")}>
        {liveProjects.length === 0 ? (
          <div className="px-4 py-3 text-xs text-content-subtle">{t("settings.notifications.projectEmpty")}</div>
        ) : (
          liveProjects.map((p) => (
            <SettingRow key={p.id} title={p.name} desc={p.path}>
              <Switch
                checked={!muted.has(p.id)}
                disabled={!loaded}
                onCheckedChange={(v) => toggleProject(p.id, v)}
                label={muted.has(p.id) ? t("settings.notifications.projectMuted") : t("settings.on")}
              />
            </SettingRow>
          ))
        )}
      </SettingsSection>
    </section>
  );
}
