import { useCallback, useEffect, useState } from "react";
import { PANEL_MAX_W } from "./panelWidth.js";
import { api } from "@renderer/lib/api.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Badge, Button, ConfirmDialog, ErrorNote, Input, Switch } from "@renderer/components/ui/index.js";
import { useSettingValue } from "@renderer/hooks/useSettingValue.js";
import { PanelHeader } from "./PanelHeader.js";
import { SettingsSection } from "./SettingsSection.js";
import { SettingRow } from "./SettingRow.js";
import {
  BROWSER_DATA_DIR_SETTING_KEY,
  BROWSER_PERSIST_LOGIN_SETTING_KEY,
  BROWSER_SCREENSHOT_DIR_SETTING_KEY,
  type BrowserVaultStatus,
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

export function ScreenshotDirRow() {
  const { t } = useI18n();
  // 【MC-047】读/存生命周期收进共享 hook(与 ShellSection 同一份):读失败显式
  // 报错 + 重试,不再永远灰;目录选择/保存失败接进同一出口。
  const s = useSettingValue(BROWSER_SCREENSHOT_DIR_SETTING_KEY);

  const pickDir = async () => {
    // 选目录对话框失败要说出来 —— 与 DataRootPanel.move 同一条规矩:裸 `void`
    // 会让 IPC 拒绝落进 unhandled rejection(渲染端没有全局监听),用户点了按钮、
    // 屏幕上一句话没有。接进本行已有的错误出口。
    try {
      const { path } = await api.pickFolder();
      if (path) s.setValue(path);
    } catch (err) {
      setPickError(err instanceof Error ? err.message : String(err));
    }
  };
  const [pickError, setPickError] = useState<string | null>(null);
  const errText = s.error ?? pickError;

  return (
    <SettingRow
      layout="vertical"
      title={t("settings.browser.screenshotDir")}
      desc={t("settings.browser.screenshotDirDesc")}
    >
      <div className="flex gap-2">
        <Input
          value={s.value ?? ""}
          onChange={(e) => s.setValue((e.target as HTMLInputElement).value)}
          placeholder={t("settings.browser.screenshotPlaceholder")}
          spellCheck={false}
          disabled={!s.ready}
          className="min-w-0 flex-1 font-mono"
        />
        <Button variant="secondary" size="sm" onClick={() => void pickDir()} disabled={!s.ready}>
          {t("settings.browser.chooseDir")}
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => void s.save()}
          disabled={s.saving || !s.ready}
        >
          {s.saving ? t("settings.saving") : t("common.save")}
        </Button>
      </div>
      {s.saved && (
        <p className="mt-1 text-[0.7857em] text-accent">{t("settings.browser.savedScreenshot")}</p>
      )}
      {errText !== null && (
        <ErrorNote title={t(s.ready ? "settings.saveFailed" : "settings.loadFailed")} className="mt-1">
          {errText}
          {!s.ready && (
            <Button variant="ghost" size={null}
              type="button"
              onClick={s.retry}
              className="ml-2 rounded border border-current px-1.5 py-0.5 text-[0.7857em] font-medium"
            >
              {t("common.retry")}
            </Button>
          )}
        </ErrorNote>
      )}
    </SettingRow>
  );
}

/** Browser session data directory (cookies / form & login records / local
 *  storage / IndexedDB …). Mirrors ScreenshotDirRow; the main process
 *  reads `browser.dataDir` when creating the browser session partition. */
export function DataDirRow() {
  const { t } = useI18n();
  // 【MC-047】同 ScreenshotDirRow:共享 hook + 显式读失败 + 重试。
  const s = useSettingValue(BROWSER_DATA_DIR_SETTING_KEY);
  const [pickError, setPickError] = useState<string | null>(null);

  const pickDir = async () => {
    // 与 ScreenshotDirRow / DataRootPanel.move 同一条规矩:选目录失败不能落成
    // unhandled rejection,接进本行已有的错误出口。
    try {
      const { path } = await api.pickFolder();
      if (path) s.setValue(path);
    } catch (err) {
      setPickError(err instanceof Error ? err.message : String(err));
    }
  };

  const errText = s.error ?? pickError;

  return (
    <SettingRow
      layout="vertical"
      title={t("settings.browser.dataDir")}
      desc={t("settings.browser.dataDirDesc")}
    >
      <div className="flex gap-2">
        <Input
          value={s.value ?? ""}
          onChange={(e) => s.setValue((e.target as HTMLInputElement).value)}
          placeholder={t("settings.browser.dataDirPlaceholder")}
          spellCheck={false}
          disabled={!s.ready}
          className="min-w-0 flex-1 font-mono"
        />
        <Button variant="secondary" size="sm" onClick={() => void pickDir()} disabled={!s.ready}>
          {t("settings.browser.chooseDir")}
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => void s.save()}
          disabled={s.saving || !s.ready}
        >
          {s.saving ? t("settings.saving") : t("common.save")}
        </Button>
      </div>
      {s.saved && (
        <p className="mt-1 text-[0.7857em] text-accent">
          {t("settings.browser.savedDataDir")}
        </p>
      )}
      {errText !== null && (
        <ErrorNote title={t(s.ready ? "settings.saveFailed" : "settings.loadFailed")} className="mt-1">
          {errText}
          {!s.ready && (
            <Button variant="ghost" size={null}
              type="button"
              onClick={s.retry}
              className="ml-2 rounded border border-current px-1.5 py-0.5 text-[0.7857em] font-medium"
            >
              {t("common.retry")}
            </Button>
          )}
        </ErrorNote>
      )}
    </SettingRow>
  );
}

/** Remember sign-in across restarts (browser.persistLogin). Main snapshots
 *  all browser cookies into the settings table on a timer and before quit,
 *  and re-injects them into the browser session before its first navigation —
 *  session cookies from sites where "remember me" was unchecked survive
 *  restarts too.
 *
 *  【MC-023】保存只走系统钥匙串加密;safeStorage 不可用时不落盘、并在这里
 *  如实写一句原因(从前是静默把凭据明文写进普通 settings 行)。 */
export function PersistLoginRow() {
  const { t } = useI18n();
  // 【MC-047】开关型设置也走同一份读生命周期:未加载成功前开关禁用(不能拿
  // 默认值 true 假装已读),读失败显式报错 + 重试。
  const s = useSettingValue(BROWSER_PERSIST_LOGIN_SETTING_KEY);
  const [error, setError] = useState<string | null>(null);
  const [vault, setVault] = useState<BrowserVaultStatus | null>(null);
  /** 读保管库状态失败的原因。从前 catch 静默吞掉 —— vault 停在 null,
   *  「加密不可用 → 不会保存 Cookie」那条警告也就无从核实(硬规矩 3)。 */
  const [vaultError, setVaultError] = useState<string | null>(null);
  const enabled = s.ready ? s.value !== "0" : true;

  const loadVault = useCallback(async (): Promise<void> => {
    try {
      setVault(await api.browser.vaultStatus());
      setVaultError(null);
    } catch (err) {
      // 状态读不到不阻塞这一行 —— 主区功能(开关)照常可用;但必须说出来:
      // 读不到就无法确认"加密不可用、本次不保存 Cookie"这条警告是否成立。
      setVaultError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (!s.ready) return;
    void loadVault();
  }, [s.ready, loadVault]);

  const toggle = async (checked: boolean) => {
    setError(null);
    // 写失败时 hook 的值不动(未落盘的值不发布)—— 开关从 `s.value` 派生,自动回弹。
    const ok = await s.save(checked ? "1" : "0");
    if (!ok && s.error === null) setError(t("settings.saveFailed"));
    if (ok) void loadVault();
  };

  return (
    <SettingRow
      layout="horizontal"
      title={t("settings.browser.persistLogin")}
      desc={t("settings.browser.persistLoginDesc")}
      descExtra={
        <>
          {/* 【MC-023】加密不可用 → 明确说"已停用持久化 + 为什么",不再静默明文降级。 */}
          {enabled && vault && !vault.encryptionAvailable && (
            <ErrorNote tone="warning" className="mt-1 text-[11px]">{t("settings.browser.vaultEncryptionUnavailable")}</ErrorNote>
          )}
          {/* 【MC-023】保存被拒的**具体原因**(加密抛错/旧明文擦除失败)—— 只有布尔位
              不够:encryptionAvailable=true 而 encryptString 抛错时上面那条不会出现,
              用户却同样没存上 Cookie。原因来自主进程 vaultStatus().lastError。 */}
          {enabled && vault?.lastError && (
            <ErrorNote title={t("settings.browser.vaultSaveFailed")} tone="warning" className="mt-1">
              {vault.lastError}
            </ErrorNote>
          )}
          {/* 【MC-023】这次启动登录态没恢复的原因(密文解不开/内容损坏/全部注入被拒)。
              从前解不开只进日志,界面与"没存过 Cookie"同形 —— 用户只看到莫名其妙要重登。 */}
          {enabled && vault?.restoreError && (
            <ErrorNote title={t("settings.browser.vaultRestoreFailed")} tone="warning" className="mt-1">
              {vault.restoreError}
            </ErrorNote>
          )}
          {/* 保管库状态读不到 → 说清楚(上面那条警告是否成立未知),带重试。
              复用通用的「读取失败 + 原因」形态,不新增文案(这一行同时至多只有
              一条读错误,两种读互斥:设置没读成功时保管库状态根本不发请求)。 */}
          {vaultError !== null && (
            <ErrorNote title={t("settings.loadFailed")} className="mt-1">
              {vaultError}
              <Button variant="ghost" size={null}
                type="button"
                onClick={() => void loadVault()}
                className="ml-2 rounded border border-current px-1.5 py-0.5 text-[0.7857em] font-medium"
              >
                {t("common.retry")}
              </Button>
            </ErrorNote>
          )}
          {vault?.plaintextErased && (
            <div className="mt-1 text-[11px] leading-relaxed text-content-subtle">
              {t("settings.browser.vaultPlaintextErased")}
            </div>
          )}
          {(error ?? s.error) !== null && (
            <ErrorNote title={t(s.ready ? "settings.saveFailed" : "settings.loadFailed")} className="mt-1">
              {error ?? s.error}
              {!s.ready && (
                <Button variant="ghost" size={null}
                  type="button"
                  onClick={s.retry}
                  className="ml-2 rounded border border-current px-1.5 py-0.5 text-[0.7857em] font-medium"
                >
                  {t("common.retry")}
                </Button>
              )}
            </ErrorNote>
          )}
        </>
      }
    >
      <Switch
        checked={enabled}
        onCheckedChange={(v) => void toggle(v)}
        disabled={!s.ready || s.saving}
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
          {result === "ok" && <Badge variant="success">{t("settings.browser.clearOk")}</Badge>}
          {result === "error" && <ErrorNote>{t("settings.browser.clearFailed")}</ErrorNote>}
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
