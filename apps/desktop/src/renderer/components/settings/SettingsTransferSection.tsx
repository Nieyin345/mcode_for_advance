/**
 * 设置 → 通用 →「备份与迁移」:设置导出到文件 / 从文件导入(R39)。
 *
 * 对话框和读写都在主进程(`ipc/settingsTransfer.ts`);这里只是两颗按钮和结果提示。
 * 不含 API Key / 令牌 / 密码 / 本机状态 —— 规则见 `main/settings/settingsTransfer.ts`。
 * 手机端(web 传输)没有文件对话框,整张卡片不显示。
 */
import { useState } from "react";
import { api } from "@renderer/lib/api.js";
import { isElectron } from "@renderer/lib/platform.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Button } from "@renderer/components/ui/index.js";
import { SettingRow } from "./SettingRow.js";
import { SettingsSection } from "./SettingsSection.js";

type Status = { kind: "ok" | "error"; text: string } | null;

export function SettingsTransferSection() {
  const { t } = useI18n();
  const [busy, setBusy] = useState<"export" | "import" | null>(null);
  const [status, setStatus] = useState<Status>(null);

  if (!isElectron) return null;

  const doExport = async () => {
    setBusy("export");
    setStatus(null);
    try {
      const res = await api.setting.exportToFile();
      if (res.ok) setStatus({ kind: "ok", text: t("settings.transfer.exported", { n: res.count, path: res.path }) });
      else if (!res.canceled) setStatus({ kind: "error", text: res.error ?? t("settings.transfer.failed") });
    } catch (err) {
      setStatus({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const doImport = async () => {
    setBusy("import");
    setStatus(null);
    try {
      const res = await api.setting.importFromFile();
      if (res.ok) {
        const base = t("settings.transfer.imported", { n: res.count, m: res.skipped });
        setStatus({
          kind: "ok",
          text: res.backupPath ? `${base}\n${t("settings.transfer.backupAt", { path: res.backupPath })}` : base,
        });
      } else if (!res.canceled) setStatus({ kind: "error", text: res.error ?? t("settings.transfer.failed") });
    } catch (err) {
      setStatus({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <SettingsSection title={t("settings.transfer.title")} desc={t("settings.transfer.desc")}>
      <SettingRow title={t("settings.transfer.exportTitle")} desc={t("settings.transfer.exportDesc")}>
        <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void doExport()}>
          {busy === "export" ? t("settings.transfer.working") : t("settings.transfer.exportBtn")}
        </Button>
      </SettingRow>
      <SettingRow title={t("settings.transfer.importTitle")} desc={t("settings.transfer.importDesc")}>
        <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void doImport()}>
          {busy === "import" ? t("settings.transfer.working") : t("settings.transfer.importBtn")}
        </Button>
      </SettingRow>
      {status && (
        <div
          className={`px-4 py-2.5 text-[0.7857em] ${
            status.kind === "ok" ? "text-content-muted" : "text-danger"
          }`}
        >
          <span className="whitespace-pre-wrap break-all">{status.text}</span>
        </div>
      )}
    </SettingsSection>
  );
}
