/**
 * 设置 → 文档编辑（OnlyOffice Document Server）。
 *
 * Office 文档（docx / xlsx / pptx…）在主页面里的可视化编辑由 **OnlyOffice Docs** 提供 ——
 * 它是一个独立服务，得用户在本机装一份（Windows 安装包或 Docker）。这一页只做三件事：
 * 填地址、填 JWT 密钥（DS 7.2+ 默认开着）、测一下通不通。DS 那边要放开"允许请求
 * 私网地址"才能回连到 Mcode，安装步骤见 `docs/onlyoffice.md`（面板里也给了要点）。
 *
 * 读走 `useRpc`（硬规矩 7）；写在按钮的事件处理器里显式 `await api.*`。
 */
import { useCallback, useEffect, useState } from "react";
import type { OnlyOfficeConfig } from "@contracts/ipc";
import { api } from "@renderer/lib/api.js";
import { useRpc } from "@renderer/hooks/useRpc.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Button, Input, Badge, ErrorNote } from "@renderer/components/ui/index.js";
import { IconCheck, IconLoader2, IconPlugConnected } from "@renderer/lib/icons.js";
import { PANEL_MAX_W } from "./panelWidth.js";
import { PanelHeader } from "./PanelHeader.js";
import { SettingsSection } from "./SettingsSection.js";
import { SettingRow } from "./SettingRow.js";
import { OfficeLocalInstallSection } from "./OfficeLocalInstallSection.js";

export function OfficePanel() {
  const { t } = useI18n();
  const { data: saved, refetch: refetchConfig } = useRpc(() => api.onlyoffice.getConfig(), []);
  const [draft, setDraft] = useState<OnlyOfficeConfig | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [probe, setProbe] = useState<
    { state: "idle" } | { state: "probing" } | { state: "done"; ok: boolean; detail: string }
  >({ state: "idle" });

  // 首次拿到持久化配置时灌进草稿；之后草稿归用户
  useEffect(() => {
    if (saved && draft === null) setDraft(saved);
  }, [saved, draft]);

  // 本机安装那一节写完配置后：丢掉草稿、重读（地址 + 密钥都是主进程写的）
  const onLocalApplied = useCallback(() => {
    setDraft(null);
    setSaveState("saved");
    setProbe({ state: "idle" });
    void refetchConfig();
  }, [refetchConfig]);

  const cfg = draft ?? saved ?? { serverUrl: "", jwtSecret: "", callbackHost: "" };
  const dirty = !!saved && !!draft && (
    draft.serverUrl !== saved.serverUrl || draft.jwtSecret !== saved.jwtSecret || draft.callbackHost !== saved.callbackHost
  );

  const save = async () => {
    if (!draft) return;
    setSaveState("saving");
    setSaveErr(null);
    try {
      const next = await api.onlyoffice.setConfig(draft);
      setDraft(next);
      await refetchConfig();
      setSaveState("saved");
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : String(e));
      setSaveState("error");
    }
  };

  const test = async () => {
    // 先存再测：探测读的是主进程里的配置，不是这里的草稿
    if (dirty) await save();
    setProbe({ state: "probing" });
    const r = await api.onlyoffice.status();
    setProbe({
      state: "done",
      ok: r.reachable,
      detail: !r.configured
        ? t("settings.office.notConfigured")
        : r.reachable
          ? t("settings.office.reachable", { url: r.serverUrl })
          : `${t("settings.office.unreachable")}${r.error ? `: ${r.error}` : ""}`,
    });
  };

  return (
    <section className={`mx-auto w-full ${PANEL_MAX_W.form} space-y-4`}>
      <PanelHeader title={t("settings.nav.office")} />

      <OfficeLocalInstallSection onConfigApplied={onLocalApplied} />

      <SettingsSection title={t("settings.office.sectionTitle")} desc={t("settings.office.sectionDesc")}>
        <SettingRow
          title={t("settings.office.serverUrl")}
          desc={t("settings.office.serverUrlDesc")}
          htmlFor="setting-office-url"
        >
          <Input
            id="setting-office-url"
            value={cfg.serverUrl}
            placeholder="http://127.0.0.1:8080"
            onChange={(e) => setDraft({ ...cfg, serverUrl: e.target.value })}
            className="w-full"
          />
        </SettingRow>
        <SettingRow
          title={t("settings.office.jwtSecret")}
          desc={t("settings.office.jwtSecretDesc")}
          htmlFor="setting-office-jwt"
        >
          <Input
            id="setting-office-jwt"
            type="password"
            value={cfg.jwtSecret}
            onChange={(e) => setDraft({ ...cfg, jwtSecret: e.target.value })}
            className="w-full"
          />
        </SettingRow>
        <SettingRow
          title={t("settings.office.callbackHost")}
          desc={t("settings.office.callbackHostDesc")}
          htmlFor="setting-office-host"
        >
          <Input
            id="setting-office-host"
            value={cfg.callbackHost}
            placeholder={t("settings.office.callbackHostPlaceholder")}
            onChange={(e) => setDraft({ ...cfg, callbackHost: e.target.value })}
            className="w-full"
          />
        </SettingRow>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button variant="primary" size="sm" disabled={!dirty || saveState === "saving"} onClick={() => void save()}>
            {saveState === "saving" ? <IconLoader2 size={14} className="animate-spin" /> : <IconCheck size={14} />}
            {t("common.save")}
          </Button>
          <Button size="sm" disabled={!cfg.serverUrl || probe.state === "probing"} onClick={() => void test()}>
            {probe.state === "probing" ? <IconLoader2 size={14} className="animate-spin" /> : <IconPlugConnected size={14} />}
            {t("settings.office.test")}
          </Button>
          {saveState === "saved" && !dirty && (
            <Badge variant="success">{t("settings.office.saved")}</Badge>
          )}
          {probe.state === "done" && (
            <Badge variant={probe.ok ? "success" : "danger"}>{probe.detail}</Badge>
          )}
        </div>
        {saveErr && <ErrorNote>{saveErr}</ErrorNote>}
      </SettingsSection>

      <SettingsSection title={t("settings.office.setupTitle")} desc={t("settings.office.setupDesc")}>
        <ol className="list-decimal space-y-1.5 pl-5 text-[0.8571em] leading-relaxed text-content-muted">
          <li>{t("settings.office.setup1")}</li>
          <li>{t("settings.office.setup2")}</li>
          <li>{t("settings.office.setup3")}</li>
          <li>{t("settings.office.setup4")}</li>
        </ol>
      </SettingsSection>
    </section>
  );
}
