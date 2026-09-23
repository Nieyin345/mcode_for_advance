/**
 * **远程控制面板** —— 让互联网上的 AI（ChatGPT 的 Connector）操作这台电脑。
 *
 * ## 为什么它自己一个文件、不在"模型配置"里
 *
 * 这块功能原先被塞在 `ClaudeProviderForm` 里 —— 因为网页版模型当初是"一个自定义端点"，
 * 于是"公网 MCP 端点"就跟着挂在了那个表单下面。但它和"配一个模型端点"**是两件完全
 * 不同的事**：那边是"用哪个模型回答问题"，这边是"**把本机的操作权交给一个公网地址**"
 * （读写文件、跑命令、SSH）。用户原话：
 *
 * > 这是从 web 来控制本地电脑，和模型配置里的完全不一样
 *
 * 所以它单独成组件、渲染在模型配置页**右侧那块平时空着的地方**（没选中供应商时的
 * 占位区）—— 那块地方闲着也是闲着，正好放下这个跟"选中哪个供应商"无关的东西。
 *
 * ## ⚠️ 这个面板的每一处都在说同一件事：它有全权限
 *
 * 打开开关 = 拿到链接的人可以在本机为所欲为（**没有审批闸门**，见 `publicMcpServer.ts`
 * 文件头）。所以：警告不折叠、不藏 tooltip；沙箱目录必须让用户**明确选**（默认不是
 * "第一个项目"这种猜的）；密钥可一键换掉（唯一的拉闸手段）。
 */
import { useEffect, useState } from "react";
import type { PublicMcpStatus } from "@contracts/customModel";
import { cn } from "@renderer/lib/cn.js";
import { api } from "@renderer/lib/api.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Button, Select, Switch } from "@renderer/components/ui/index.js";
import {
  IconCopy,
  IconCheck,
  IconLoader2,
  IconPlugConnected,
  IconAlertTriangle,
} from "@renderer/lib/icons.js";
import { copyText } from "@renderer/lib/clipboard.js";

/** 只读一行（值 + 复制钮）—— 与 `CustomModelsPanel` 的 `BridgeRow` 同形。 */
function ValueRow({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-20 shrink-0 text-[0.7143em] text-content-subtle">{label}</span>
      <code
        className={cn(
          "min-w-0 flex-1 truncate rounded bg-surface-muted px-1.5 py-0.5 font-mono text-[0.7143em] text-content",
          !value && "text-content-subtle",
        )}
        title={value}
      >
        {value || "—"}
      </code>
      <Button variant="ghost" size="sm" disabled={!value} onClick={onCopy} className="shrink-0">
        {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
        <span className="ml-1">
          {copied ? t("settings.customModels.bridgeCopied") : t("settings.customModels.bridgeCopy")}
        </span>
      </Button>
    </div>
  );
}

export function RemoteControlPanel({ onError }: { onError: (msg: string) => void }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<PublicMcpStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.publicMcp
      .status()
      .then((s) => {
        if (alive) setStatus(s);
      })
      .catch(() => {
        /* 主进程还没就绪 —— 下次进来再看 */
      });
    return () => {
      alive = false;
    };
  }, []);

  // 起隧道是异步的（cloudflared 要先跑一段连通性预检），点完那一刻还没好，得轮询等。
  useEffect(() => {
    if (status?.tunnelPhase !== "starting") return;
    const timer = window.setInterval(() => {
      api.publicMcp.status().then(setStatus).catch(() => {});
    }, 2000);
    return () => window.clearInterval(timer);
  }, [status?.tunnelPhase]);

  const run = async (fn: () => Promise<PublicMcpStatus>) => {
    setBusy(true);
    try {
      setStatus(await fn());
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const copy = async (key: string, value: string) => {
    if (await copyText(value)) {
      setCopied(key);
      window.setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    }
  };

  const fullUrl =
    status?.tunnelUrl && status.secret ? `${status.tunnelUrl}/mcp/${status.secret}` : "";
  const tunnelCmd = status?.port
    ? `cloudflared tunnel --url http://127.0.0.1:${status.port}`
    : "";

  return (
    <div className="flex h-full flex-col gap-2.5 overflow-y-auto">
      <div>
        <h2 className="text-[0.9286em] font-medium text-content">
          {t("settings.remoteControl.title")}
        </h2>
        <p className="mt-1 text-[0.7143em] leading-relaxed text-content-subtle">
          {t("settings.remoteControl.desc")}
        </p>
      </div>

      {/* 警告 —— 不折叠、不藏。用户按开关之前就该读到。 */}
      <p className="flex items-start gap-1.5 rounded border border-danger/30 bg-danger/5 px-2 py-1.5 text-[0.7143em] leading-relaxed text-danger">
        <IconAlertTriangle size={14} className="mt-0.5 shrink-0" />
        <span>{t("settings.remoteControl.warning")}</span>
      </p>

      {/* 沙箱目录 —— **必须用户自己选**，不猜。公网来的文件工具只能在这个项目里动。 */}
      <div className="space-y-1">
        <span className="block text-[0.7857em] font-medium text-content-muted">
          {t("settings.remoteControl.sandboxLabel")}
        </span>
        <Select.Root
          value={status?.sandboxProjectId ?? ""}
          onValueChange={(v) => void run(() => api.publicMcp.setProject({ projectId: (v as string) || null }))}
        >
          <Select.Trigger className="w-full">
            <Select.Value>
              {(val: string) =>
                status?.availableProjects.find((p) => p.id === val)?.name ??
                t("settings.remoteControl.sandboxNone")
              }
            </Select.Value>
          </Select.Trigger>
          <Select.Portal>
            <Select.Positioner className="z-50">
              <Select.Popup>
                <Select.List>
                  <Select.Item value="">
                    <Select.ItemText>{t("settings.remoteControl.sandboxNone")}</Select.ItemText>
                  </Select.Item>
                  {(status?.availableProjects ?? []).map((p) => (
                    <Select.Item key={p.id} value={p.id}>
                      <Select.ItemText>{p.name}</Select.ItemText>
                    </Select.Item>
                  ))}
                </Select.List>
              </Select.Popup>
            </Select.Positioner>
          </Select.Portal>
        </Select.Root>
        <p className="text-[0.6428em] leading-relaxed text-content-subtle">
          {status?.sandboxRoot
            ? t("settings.remoteControl.sandboxAt", { path: status.sandboxRoot })
            : t("settings.remoteControl.sandboxHint")}
        </p>
      </div>

      {/* 开关 */}
      <div className="flex items-center justify-between gap-2 rounded border border-edge bg-surface/40 px-2.5 py-2">
        <div className="flex items-center gap-1.5">
          <span className="text-[0.7857em] font-medium text-content-muted">
            {t("settings.remoteControl.toggleLabel")}
          </span>
          <span
            className={cn(
              "rounded px-1.5 py-0.5 text-[0.7143em]",
              status?.enabled ? "bg-warning/15 text-warning" : "bg-surface-muted text-content-subtle",
            )}
          >
            {status?.enabled
              ? t("settings.customModels.publicMcpOn")
              : t("settings.customModels.publicMcpOff")}
          </span>
        </div>
        <Switch
          checked={status?.enabled ?? false}
          disabled={busy}
          onCheckedChange={(v) => void run(() => api.publicMcp.setEnabled({ enabled: v }))}
          label={t("settings.remoteControl.toggleLabel")}
        />
      </div>

      {status?.enabled && (
        <div className="space-y-1.5 rounded border border-edge bg-surface/40 p-2.5">
          {/* 一键隧道 */}
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              // `reconnecting` 也算"在忙" —— 那时隧道正自己连回来,按钮该转圈、不让人重复点。
              disabled={busy || status?.tunnelPhase === "starting" || status?.tunnelPhase === "reconnecting"}
              onClick={() => void run(() =>
                status?.tunnelPhase === "ready"
                  ? api.publicMcp.stopTunnel()
                  : api.publicMcp.startTunnel(),
              )}
            >
              {busy || status?.tunnelPhase === "starting" || status?.tunnelPhase === "reconnecting" ? (
                <IconLoader2 size={13} className="mr-1 animate-spin" />
              ) : (
                <IconPlugConnected size={13} className="mr-1" />
              )}
              {status?.tunnelPhase === "ready"
                ? t("settings.customModels.publicMcpStopTunnel")
                : status?.tunnelPhase === "starting"
                  ? t("settings.customModels.publicMcpTunnelStarting")
                  : status?.tunnelPhase === "reconnecting"
                    ? t("settings.customModels.publicMcpTunnelReconnecting")
                    : t("settings.customModels.publicMcpStartTunnel")}
            </Button>
            {status?.tunnelPhase === "ready" && (
              <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[0.7143em] text-accent">
                {t("settings.customModels.publicMcpTunnelReady")}
              </span>
            )}
          </div>

          {status?.tunnelPhase === "failed" && status.tunnelError && (
            <p className="rounded border border-danger/30 bg-danger/5 px-1.5 py-1 text-[0.6428em] leading-relaxed text-danger">
              {status.tunnelError}
            </p>
          )}

          {fullUrl && (
            <ValueRow
              label={t("settings.customModels.publicMcpUrlLabel")}
              value={fullUrl}
              copied={copied === "url"}
              onCopy={() => void copy("url", fullUrl)}
            />
          )}

          <ValueRow
            label={t("settings.customModels.publicMcpTunnelLabel")}
            value={tunnelCmd}
            copied={copied === "cmd"}
            onCopy={() => void copy("cmd", tunnelCmd)}
          />

          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void run(() => api.publicMcp.regenerateSecret())}
          >
            {busy ? (
              <IconLoader2 size={13} className="mr-1 animate-spin" />
            ) : (
              <IconPlugConnected size={13} className="mr-1" />
            )}
            {t("settings.customModels.publicMcpRegenerate")}
          </Button>
          <p className="text-[0.6428em] leading-relaxed text-content-subtle">
            {t("settings.customModels.publicMcpHint")}
          </p>
        </div>
      )}
    </div>
  );
}
