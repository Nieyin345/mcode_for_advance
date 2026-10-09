import { useEffect, useState } from "react";
import { PANEL_MAX_W } from "./panelWidth.js";
import { api } from "@renderer/lib/api.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Button, ConfirmDialog, ErrorNote, Input, Switch } from "@renderer/components/ui/index.js";
import { PanelHeader } from "./PanelHeader.js";
import { SettingsSection } from "./SettingsSection.js";
import { SettingRow } from "./SettingRow.js";
import {
  BROWSER_DATA_DIR_SETTING_KEY,
  BROWSER_PERSIST_LOGIN_SETTING_KEY,
  BROWSER_SCREENSHOT_DIR_SETTING_KEY,
} from "@contracts/ipc";

/**
 * Browser settings — screenshot directory, browser data directory, sign-in
 * persistence, cache.
 *
 * - Screenshot dir: where the agent's browser_screenshot tool saves PNGs
 *   (bound to `browser.screenshotDir`; the main-process saver reads it on
 *   every save — no store field / no new IPC).
 * - Data dir: where the embedded browser's session data (cookies, form/login
 *   records, localStorage, IndexedDB …) lives. Bound to `browser.dataDir`; the
 *   main process reads it when creating the browser session. Electron caches
 *   Session objects by partition string, so a change only takes effect after
 *   an app restart — the UI says so.
 * - Sign-in persistence: main snapshots all browser cookies into the settings
 *   table (`browser.persistLogin` / `browser.cookieVault`) on a background
 *   timer and before quit, and re-injects them into the session before its
 *   first navigation after a restart. This is needed because Electron ≤ 40
 *   never commits cookies to disk for persistent partitions.
 * - Cache: clears HTTP cache + temporary site storage via `api.browser.clearCache`
 *   (a dedicated IPC into main). Cookies/login state are preserved.
 */
export function SettingsBrowserPanel() {
  const { t } = useI18n();
  return (
    <section className={`mx-auto w-full ${PANEL_MAX_W.form} space-y-4`}>
      <PanelHeader title={t("settings.browser.title")} />

      {/* 存储位置 — 截图目录与数据目录合并为一张卡(两行) */}
      <SettingsSection title={t("settings.browser.sectionStorage")}>
        <ScreenshotDirRow />
        <DataDirRow />
      </SettingsSection>

      <SettingsSection title={t("settings.browser.sectionLogin")}>
        <PersistLoginRow />
      </SettingsSection>

      <CacheSection />
    </section>
  );
}

function ScreenshotDirRow() {
  const { t } = useI18n();
  const [dir, setDir] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the current setting on mount (panel is freshly mounted per nav
  // switch, so reload its value each time it's shown).
  useEffect(() => {
    setSaved(false);
    void (async () => {
      const { value } = await api.setting.get({ key: BROWSER_SCREENSHOT_DIR_SETTING_KEY });
      setDir(value ?? "");
      setLoaded(true);
    })();
  }, []);

  const pickDir = async () => {
    // 选目录对话框失败要说出来 —— 与 DataRootPanel.move 同一条规矩:裸 `void`
    // 会让 IPC 拒绝落进 unhandled rejection(渲染端没有全局监听),用户点了按钮、
    // 屏幕上一句话没有。接进本行已有的错误出口。
    try {
      const { path } = await api.pickFolder();
      if (path) {
        setDir(path);
        setSaved(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.setting.set({ key: BROWSER_SCREENSHOT_DIR_SETTING_KEY, value: dir.trim() });
      setSaved(true);
    } catch (err) {
      // **失败要说出来** —— 从前只有 try/finally,抛了就静默:用户点「保存」
      // 既看不到「已保存」也看不到错,像按钮坏了。
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingRow
      layout="vertical"
      title={t("settings.browser.screenshotDir")}
      desc={t("settings.browser.screenshotDirDesc")}
    >
      <div className="flex gap-2">
        <Input
          value={dir}
          onChange={(e) => {
            setDir((e.target as HTMLInputElement).value);
            setSaved(false);
          }}
          placeholder={t("settings.browser.screenshotPlaceholder")}
          spellCheck={false}
          disabled={!loaded}
          className="min-w-0 flex-1 font-mono"
        />
        <Button variant="secondary" size="sm" onClick={() => void pickDir()} disabled={!loaded}>
          {t("settings.browser.chooseDir")}
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => void save()}
          disabled={saving || !loaded}
        >
          {saving ? t("settings.saving") : t("common.save")}
        </Button>
      </div>
      {saved && (
        <p className="mt-1 text-[0.7857em] text-accent">{t("settings.browser.savedScreenshot")}</p>
      )}
      {error !== null && (
        <ErrorNote title={t("settings.saveFailed")} className="mt-1">
          {error}
        </ErrorNote>
      )}
    </SettingRow>
  );
}

/** Browser session data directory (cookies / form & login records / local
 *  storage / IndexedDB …). Mirrors ScreenshotDirRow; the main process
 *  reads `browser.dataDir` when creating the browser session partition. */
function DataDirRow() {
  const { t } = useI18n();
  const [dir, setDir] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSaved(false);
    void (async () => {
      const { value } = await api.setting.get({ key: BROWSER_DATA_DIR_SETTING_KEY });
      setDir(value ?? "");
      setLoaded(true);
    })();
  }, []);

  const pickDir = async () => {
    // 与 ScreenshotDirRow / DataRootPanel.move 同一条规矩:选目录失败不能落成
    // unhandled rejection,接进本行已有的错误出口。
    try {
      const { path } = await api.pickFolder();
      if (path) {
        setDir(path);
        setSaved(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.setting.set({ key: BROWSER_DATA_DIR_SETTING_KEY, value: dir.trim() });
      setSaved(true);
    } catch (err) {
      // **失败要说出来** —— 从前只有 try/finally,抛了就静默:用户点「保存」
      // 既看不到「已保存」也看不到错,像按钮坏了。
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingRow
      layout="vertical"
      title={t("settings.browser.dataDir")}
      desc={t("settings.browser.dataDirDesc")}
    >
      <div className="flex gap-2">
        <Input
          value={dir}
          onChange={(e) => {
            setDir((e.target as HTMLInputElement).value);
            setSaved(false);
          }}
          placeholder={t("settings.browser.dataDirPlaceholder")}
          spellCheck={false}
          disabled={!loaded}
          className="min-w-0 flex-1 font-mono"
        />
        <Button variant="secondary" size="sm" onClick={() => void pickDir()} disabled={!loaded}>
          {t("settings.browser.chooseDir")}
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => void save()}
          disabled={saving || !loaded}
        >
          {saving ? t("settings.saving") : t("common.save")}
        </Button>
      </div>
      {saved && (
        <p className="mt-1 text-[0.7857em] text-accent">
          {t("settings.browser.savedDataDir")}
        </p>
      )}
      {error !== null && (
        <ErrorNote title={t("settings.saveFailed")} className="mt-1">
          {error}
        </ErrorNote>
      )}
    </SettingRow>
  );
}

/** Remember sign-in across restarts (browser.persistLogin). Main snapshots
 *  all browser cookies into the settings table on a timer and before quit,
 *  and re-injects them into the browser session before its first navigation —
 *  session cookies from sites where "remember me" was unchecked survive
 *  restarts too. */
function PersistLoginRow() {
  const { t } = useI18n();
  const [enabled, setEnabled] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const { value } = await api.setting.get({ key: BROWSER_PERSIST_LOGIN_SETTING_KEY });
      setEnabled(value !== "0");
      setLoaded(true);
    })();
  }, []);

  const toggle = async (checked: boolean) => {
    setEnabled(checked);
    setError(null);
    try {
      await api.setting.set({
        key: BROWSER_PERSIST_LOGIN_SETTING_KEY,
        value: checked ? "1" : "0",
      });
    } catch (err) {
      // 回弹开关**只是**把界面拨回原样,并没说清"为什么没生效" —— 与同文件另两行
      // (目录保存失败画 ErrorNote)、以及 HooksPanel 开关(失败走 toast)是同一条规矩:
      // 写失败要在看得见的地方报出来,不能只是静默回弹。
      setError(err instanceof Error ? err.message : String(err));
      setEnabled(!checked); // revert the optimistic flip on failure
    }
  };

  return (
    <SettingRow
      layout="horizontal"
      title={t("settings.browser.persistLogin")}
      desc={t("settings.browser.persistLoginDesc")}
      descExtra={
        error !== null ? (
          <ErrorNote title={t("settings.saveFailed")} className="mt-1">
            {error}
          </ErrorNote>
        ) : undefined
      }
    >
      <Switch
        checked={enabled}
        onCheckedChange={(v) => void toggle(v)}
        disabled={!loaded}
        label={t("settings.browser.persistLogin")}
      />
    </SettingRow>
  );
}

/** Clear the browser's HTTP cache + temporary site storage. A danger button
 *  guarded by a ConfirmDialog; cookies & login state are kept, so the user
 *  stays signed in. */
function CacheSection() {
  const { t } = useI18n();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<"ok" | "error" | null>(null);

  const clear = async () => {
    setBusy(true);
    setResult(null);
    try {
      const res = await api.browser.clearCache();
      setResult(res.ok ? "ok" : "error");
    } catch {
      setResult("error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection
      title={t("settings.browser.sectionCache")}
      desc={t("settings.browser.cacheSectionDesc")}
    >
      <SettingRow
        layout="horizontal"
        title={t("settings.browser.clearCache")}
        desc={t("settings.browser.clearCacheDesc")}
      >
        <div className="flex flex-col items-end gap-1">
          <Button
            variant="danger"
            size="sm"
            disabled={busy}
            onClick={() => setConfirmOpen(true)}
          >
            {busy ? t("settings.browser.clearing") : t("settings.browser.clearCache")}
          </Button>
          {result === "ok" && (
            <span className="text-[0.7857em] text-accent">{t("settings.browser.clearOk")}</span>
          )}
          {result === "error" && (
            <span className="text-[0.7857em] text-danger">{t("settings.browser.clearFailed")}</span>
          )}
        </div>
      </SettingRow>
      <ConfirmDialog
        open={confirmOpen}
        title={t("settings.browser.clearConfirmTitle")}
        description={
          <>
            {t("settings.browser.clearConfirmDesc1")}
            <span className="font-medium">{t("settings.browser.clearConfirmKeep")}</span>
            {t("settings.browser.clearConfirmDesc2")}
          </>
        }
        confirmText={t("settings.browser.clear")}
        danger
        onOpenChange={(open) => {
          if (!open) setConfirmOpen(false);
        }}
        onConfirm={() => {
          void clear();
        }}
      />
    </SettingsSection>
  );
}
