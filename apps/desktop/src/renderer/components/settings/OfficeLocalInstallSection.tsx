/**
 * 设置 → 文档编辑 → **本机安装** 那一节（不走 Docker）。
 *
 * 打开面板就 `detectLocal`：
 *   - 没装         → 「一键下载并安装」（~1 GB 官方安装包 + 一次 UAC）
 *   - 装了没跑     → 提示去 services.msc 起服务 / 重试检测
 *   - 装了在跑     → 「使用这一份」直接把地址+密钥写进配置；私网访问没开再给「修复配置」
 * 安装中每秒轮询 `installProgress`，画下载进度条和阶段文案；done 后重新检测 + 通知父级刷新配置。
 */
import { useEffect, useRef, useState } from "react";
import type { OnlyOfficeInstallProgress } from "@contracts/ipc";
import { api } from "@renderer/lib/api.js";
import { useRpc } from "@renderer/hooks/useRpc.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { Badge, Button, ErrorNote, Input } from "@renderer/components/ui/index.js";
import { IconCheck, IconDownload, IconLoader2, IconRefresh, IconTools } from "@renderer/lib/icons.js";
import { SettingsSection } from "./SettingsSection.js";
import { SettingRow } from "./SettingRow.js";

const ACTIVE_PHASES = new Set(["downloading", "installing", "configuring", "waiting"]);

const PHASE_KEY: Record<OnlyOfficeInstallProgress["phase"], MessageId> = {
  idle: "settings.office.local.phase.idle",
  downloading: "settings.office.local.phase.downloading",
  installing: "settings.office.local.phase.installing",
  configuring: "settings.office.local.phase.configuring",
  waiting: "settings.office.local.phase.waiting",
  done: "settings.office.local.phase.done",
  error: "settings.office.local.phase.error",
  cancelled: "settings.office.local.phase.cancelled",
};

const ERROR_KEY: Record<string, MessageId> = {
  UAC_DENIED: "settings.office.local.err.uac",
  CANCELLED: "settings.office.local.phase.cancelled",
  DS_NOT_RESPONDING: "settings.office.local.err.notResponding",
  ONLYOFFICE_NOT_INSTALLED: "settings.office.local.err.notInstalled",
  ONLYOFFICE_NOT_RUNNING: "settings.office.local.err.notRunning",
  UNSUPPORTED_PLATFORM: "settings.office.local.unsupported",
};

function fmtMB(n: number): string {
  return (n / 1024 / 1024).toFixed(0);
}

export function OfficeLocalInstallSection({ onConfigApplied }: { onConfigApplied: () => void }) {
  const { t } = useI18n();
  const { data: local, loading: detecting, refetch: redetect } = useRpc(() => api.onlyoffice.detectLocal(), []);
  const { data: initialProgress } = useRpc(() => api.onlyoffice.installProgress(), []);
  const [progress, setProgress] = useState<OnlyOfficeInstallProgress | null>(null);
  const [port, setPort] = useState("8080");
  const [applyErr, setApplyErr] = useState<string | null>(null);
  const cur = progress ?? initialProgress ?? null;
  const active = !!cur && ACTIVE_PHASES.has(cur.phase);
  const prevPhase = useRef<string | null>(null);

  // 安装进行中：每秒轮询（设置页关了再开也能接上，状态在主进程）
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      void api.onlyoffice.installProgress().then(setProgress);
    }, 1000);
    return () => clearInterval(id);
  }, [active]);

  // 跑完（done / error）→ 重新检测；done 还要让父级重读配置（applyLocal 已经写进去了）
  useEffect(() => {
    if (!cur) return;
    if (prevPhase.current && prevPhase.current !== cur.phase && !ACTIVE_PHASES.has(cur.phase)) {
      void redetect();
      if (cur.phase === "done") onConfigApplied();
    }
    prevPhase.current = cur.phase;
  }, [cur, redetect, onConfigApplied]);

  const install = async () => {
    setApplyErr(null);
    const p = Number(port) || 8080;
    setProgress(await api.onlyoffice.installLocal({ port: p }));
  };
  const configure = async () => {
    setApplyErr(null);
    setProgress(await api.onlyoffice.configureLocal());
  };
  const useThis = async () => {
    setApplyErr(null);
    try {
      await api.onlyoffice.applyLocal();
      onConfigApplied();
      await redetect();
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      const key = Object.keys(ERROR_KEY).find((k) => m.includes(k));
      setApplyErr(key ? t(ERROR_KEY[key]!) : m);
    }
  };

  if (local && !local.supported) {
    return (
      <SettingsSection title={t("settings.office.local.title")} desc={t("settings.office.local.unsupported")}>
        <div />
      </SettingsSection>
    );
  }

  const status = detecting
    ? { tone: "neutral" as const, text: t("settings.office.local.detecting") }
    : !local?.installed
      ? { tone: "neutral" as const, text: t("settings.office.local.notInstalled") }
      : local.serviceState === "running" && local.port
        ? { tone: "success" as const, text: t("settings.office.local.running", { port: local.port }) }
        : { tone: "warning" as const, text: t("settings.office.local.installedNotRunning") };

  const errText = (p: OnlyOfficeInstallProgress) => {
    if (!p.message) return t(PHASE_KEY[p.phase]);
    const key = Object.keys(ERROR_KEY).find((k) => p.message!.includes(k));
    return key ? t(ERROR_KEY[key]!) : `${t(PHASE_KEY.error)}: ${p.message}`;
  };

  return (
    <SettingsSection title={t("settings.office.local.title")} desc={t("settings.office.local.desc")}>
      <SettingRow
        title={t("settings.office.local.status")}
        desc={
          local?.installed
            ? [local.installDir, local.version ? `v${local.version}` : null].filter(Boolean).join(" · ")
            : t("settings.office.local.statusDesc")
        }
      >
        <div className="flex items-center gap-2">
          <Badge variant={status.tone}>{status.text}</Badge>
          <Button size="icon" variant="ghost" title={t("settings.office.local.redetect")} disabled={detecting} onClick={() => void redetect()}>
            <IconRefresh size={13} className={detecting ? "animate-spin" : undefined} />
          </Button>
        </div>
      </SettingRow>

      {/* 没装：一键安装 */}
      {!detecting && local && !local.installed && !active && (
        <SettingRow title={t("settings.office.local.port")} desc={t("settings.office.local.portDesc")} htmlFor="setting-office-local-port">
          <div className="flex items-center gap-2">
            <Input id="setting-office-local-port" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} className="w-24" />
            <Button variant="primary" size="sm" onClick={() => void install()}>
              <IconDownload size={14} />
              {t("settings.office.local.install")}
            </Button>
          </div>
        </SettingRow>
      )}

      {/* 装了：用这一份 / 修配置 */}
      {!detecting && local?.installed && !active && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button variant="primary" size="sm" disabled={!local.suggestedServerUrl} onClick={() => void useThis()}>
            <IconCheck size={14} />
            {t("settings.office.local.useThis")}
          </Button>
          {local.privateIpAllowed === false && (
            <Button size="sm" onClick={() => void configure()}>
              <IconTools size={14} />
              {t("settings.office.local.repair")}
            </Button>
          )}
          {local.privateIpAllowed === false && (
            <span className="text-[0.8571em] text-content-subtle">{t("settings.office.local.repairHint")}</span>
          )}
        </div>
      )}

      {/* 进度 */}
      {cur && cur.phase !== "idle" && (
        <div className="space-y-1.5 pt-1">
          <div className="flex items-center gap-2 text-[0.8571em]">
            {active ? <IconLoader2 size={13} className="animate-spin" /> : cur.phase === "done" ? <IconCheck size={13} className="text-success" /> : null}
            <span className={cur.phase === "error" ? "text-danger" : "text-content-muted"}>
              {cur.phase === "error" || cur.phase === "cancelled" ? errText(cur) : t(PHASE_KEY[cur.phase])}
              {cur.phase === "downloading" && cur.totalBytes
                ? ` ${fmtMB(cur.receivedBytes)} / ${fmtMB(cur.totalBytes)} MB`
                : cur.phase === "downloading"
                  ? ` ${fmtMB(cur.receivedBytes)} MB`
                  : ""}
            </span>
            {cur.phase === "downloading" && (
              <Button size="sm" variant="ghost" onClick={() => void api.onlyoffice.cancelInstall().then(setProgress)}>
                {t("common.cancel")}
              </Button>
            )}
            {(cur.phase === "error" || cur.phase === "cancelled") && !local?.installed && (
              <Button size="sm" onClick={() => void install()}>{t("common.retry")}</Button>
            )}
          </div>
          {cur.phase === "downloading" && cur.totalBytes ? (
            <div className="h-1.5 w-full overflow-hidden rounded bg-surface-muted">
              <div className="h-full bg-accent transition-[width]" style={{ width: `${Math.min(100, (cur.receivedBytes / cur.totalBytes) * 100)}%` }} />
            </div>
          ) : active ? (
            <div className="h-1.5 w-full overflow-hidden rounded bg-surface-muted">
              <div className="h-full w-1/3 animate-pulse bg-accent/60" />
            </div>
          ) : null}
          {cur.phase === "installing" && (
            <p className="text-[0.8571em] text-content-subtle">{t("settings.office.local.uacHint")}</p>
          )}
        </div>
      )}
      {applyErr && <ErrorNote>{applyErr}</ErrorNote>}
    </SettingsSection>
  );
}
