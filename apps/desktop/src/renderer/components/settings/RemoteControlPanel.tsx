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
import type { PublicMcpStatus, PublicMcpTunnelConfig } from "@contracts/customModel";
import { cn } from "@renderer/lib/cn.js";
import { api } from "@renderer/lib/api.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Button, Input, Select, Switch } from "@renderer/components/ui/index.js";
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

/**
 * **隧道那一段** —— 模式、域名、Tunnel Token、固定端口,外加「交给外面的 AI 支使」那个开关。
 *
 * 为什么挤在这张卡片里而不是单开一页:这几项全都是在回答同一个问题 ——「ChatGPT 该从
 * 哪个地址找到这台机器」。拆到别处,用户要在两个页面之间来回对照域名和端口才填得对。
 *
 * 输入是**本地草稿**,点「保存」才落盘(域名和 token 是一起生效的一套,边打边存会在
 * 打到一半时把隧道配成半截)。所以外面用 `key` 把这个组件绑在已存的配置上:存过一次
 * 之后整块重挂,草稿与真值自然对齐。
 */
function TunnelCard({
  status,
  busy,
  onSave,
}: {
  status: PublicMcpStatus;
  busy: boolean;
  onSave: (config: PublicMcpTunnelConfig) => void;
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState<PublicMcpStatus["tunnelMode"]>(status.tunnelMode);
  const [hostname, setHostname] = useState(status.tunnelHostname);
  const [fixedPort, setFixedPort] = useState(status.fixedPort ? String(status.fixedPort) : "");
  // token **永远从空开始**:已存的那串不回传渲染层(只有尾 4 位的 tokenHint),
  // 留空提交 = 沿用。所以空输入框的意思是"不改",不是"清空"。
  const [token, setToken] = useState("");

  const named = mode === "named";
  const external = mode === "external";
  const needsHostname = named || external;

  return (
    <div className="space-y-2 rounded border border-edge bg-surface/40 p-2.5">
      <div className="space-y-1">
        <span className="block text-[0.7857em] font-medium text-content-muted">
          {t("settings.remoteControl.tunnelModeLabel")}
        </span>
        <Select.Root value={mode} onValueChange={(v) => setMode(v as PublicMcpStatus["tunnelMode"])}>
          <Select.Trigger className="w-full">
            <Select.Value>
              {/* `val` 从 Select 出来是裸 string,直接拼模板串会落在 i18n 键的联合类型外面。
                  收窄回三选一再拼 —— 多这一步,键名写错就还是编译期报错。 */}
              {(val: string) =>
                t(
                  `settings.remoteControl.tunnelMode.${
                    (val === "named" || val === "external" ? val : "quick") as PublicMcpStatus["tunnelMode"]
                  }`,
                )
              }
            </Select.Value>
          </Select.Trigger>
          <Select.Portal>
            <Select.Positioner className="z-50">
              <Select.Popup>
                <Select.List>
                  {(["quick", "named", "external"] as const).map((m) => (
                    <Select.Item key={m} value={m}>
                      <Select.ItemText>{t(`settings.remoteControl.tunnelMode.${m}`)}</Select.ItemText>
                    </Select.Item>
                  ))}
                </Select.List>
              </Select.Popup>
            </Select.Positioner>
          </Select.Portal>
        </Select.Root>
        <p className="text-[0.6428em] leading-relaxed text-content-subtle">
          {t(`settings.remoteControl.tunnelModeHint.${mode}`)}
        </p>
      </div>

      {needsHostname && (
        <>
          <div className="space-y-1">
            <span className="block text-[0.7857em] font-medium text-content-muted">
              {t("settings.remoteControl.hostnameLabel")}
            </span>
            <Input
              value={hostname}
              placeholder="mcp.example.com"
              onChange={(e) => setHostname(e.target.value)}
            />
            <p className="text-[0.6428em] leading-relaxed text-content-subtle">
              {t("settings.remoteControl.hostnameHint")}
            </p>
          </div>
        </>
      )}

      {named && (
        <div className="space-y-1">
          <span className="block text-[0.7857em] font-medium text-content-muted">
            {t("settings.remoteControl.tokenLabel")}
          </span>
          <Input
            type="password"
            value={token}
            placeholder={
              status.tokenHint
                ? t("settings.remoteControl.tokenKeep", { hint: status.tokenHint })
                : t("settings.remoteControl.tokenPlaceholder")
            }
            onChange={(e) => setToken(e.target.value)}
          />
          <p className="text-[0.6428em] leading-relaxed text-content-subtle">
            {t("settings.remoteControl.tokenHint")}
          </p>
          {/* 留空只能表达"沿用";要删掉已存的那串得有个明确的动作。 */}
          {status.tokenHint && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() =>
                onSave({
                  mode,
                  hostname: hostname.trim(),
                  fixedPort: Number(fixedPort) || 0,
                  clearToken: true,
                })
              }
            >
              {t("settings.remoteControl.tokenClear")}
            </Button>
          )}
        </div>
      )}

      <div className="space-y-1">
        <span className="block text-[0.7857em] font-medium text-content-muted">
          {t("settings.remoteControl.fixedPortLabel")}
        </span>
        <Input
          value={fixedPort}
          placeholder="17331"
          inputMode="numeric"
          onChange={(e) => setFixedPort(e.target.value.replace(/[^0-9]/g, ""))}
        />
        <p className="text-[0.6428em] leading-relaxed text-content-subtle">
          {t("settings.remoteControl.fixedPortHint", {
            port: status.port ? String(status.port) : "—",
          })}
        </p>
      </div>

      <Button
        variant="outline"
        size="sm"
        disabled={busy || (needsHostname && !hostname.trim())}
        onClick={() =>
          onSave({
            mode,
            hostname: hostname.trim(),
            fixedPort: Number(fixedPort) || 0,
            token: token.trim(),
          })
        }
      >
        {busy ? <IconLoader2 size={13} className="mr-1 animate-spin" /> : null}
        {t("settings.remoteControl.saveTunnel")}
      </Button>
    </div>
  );
}

/**
 * **多项目并行**那一块:每个项目一条自己的链接(密钥 / 合成会话 / 沙箱各自独立)。
 *
 * 用户原话:"希望能够并行的,可以实现多个项目的同时提供"。默认链接只能指一个项目,
 * 改它就把正在用的对话一起挪走;这里改成**加链接**:A 项目一条、B 项目一条,两边的
 * ChatGPT 对话同时在跑,各在各的目录里。
 */
function ProjectLinksCard({
  status,
  busy,
  copied,
  onCopy,
  run,
}: {
  status: PublicMcpStatus;
  busy: boolean;
  copied: string | null;
  onCopy: (key: string, value: string) => void;
  run: (fn: () => Promise<PublicMcpStatus>) => void;
}) {
  const { t } = useI18n();
  const linked = new Set(status.projectLinks.map((l) => l.projectId));
  const addable = status.availableProjects.filter((p) => !linked.has(p.id));

  return (
    <div className="space-y-1.5 rounded border border-edge bg-surface/40 p-2.5">
      <span className="block text-[0.7857em] font-medium text-content-muted">
        {t("settings.remoteControl.projectLinksTitle")}
      </span>
      <p className="text-[0.6428em] leading-relaxed text-content-subtle">
        {t("settings.remoteControl.projectLinksHint")}
      </p>

      {status.projectLinks.length === 0 && (
        <p className="text-[0.7143em] text-content-subtle">{t("settings.remoteControl.projectLinksEmpty")}</p>
      )}

      {status.projectLinks.map((link) => {
        const url = status.tunnelUrl ? `${status.tunnelUrl}/mcp/${link.secret}` : "";
        return (
          <div key={link.projectId} className="space-y-1 rounded border border-edge/60 p-2">
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-[0.7857em] text-content" title={link.projectPath}>
                {link.projectName || link.projectId}
                {link.missing && (
                  <span className="ml-1 text-danger">{t("settings.remoteControl.projectLinkMissing")}</span>
                )}
              </span>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy || link.missing}
                  onClick={() =>
                    run(() => api.publicMcp.regenerateProjectLinkSecret({ projectId: link.projectId }))
                  }
                >
                  {t("settings.remoteControl.projectLinkRegenerate")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => run(() => api.publicMcp.removeProjectLink({ projectId: link.projectId }))}
                >
                  {t("settings.remoteControl.projectLinkRemove")}
                </Button>
              </div>
            </div>
            {!link.missing && (
              <ValueRow
                label={t("settings.customModels.publicMcpUrlLabel")}
                value={url}
                copied={copied === `link:${link.projectId}`}
                onCopy={() => onCopy(`link:${link.projectId}`, url)}
              />
            )}
            {!link.missing && !url && (
              <p className="text-[0.6428em] text-content-subtle">
                {t("settings.remoteControl.projectLinkUrlPending")}
              </p>
            )}
          </div>
        );
      })}

      {addable.length > 0 && (
        <Select.Root
          value=""
          disabled={busy}
          onValueChange={(v) => {
            const projectId = v as string;
            if (projectId) run(() => api.publicMcp.addProjectLink({ projectId }));
          }}
        >
          <Select.Trigger className="w-full">
            <Select.Value>{() => t("settings.remoteControl.projectLinksAdd")}</Select.Value>
          </Select.Trigger>
          <Select.Portal>
            <Select.Positioner className="z-50">
              <Select.Popup>
                <Select.List>
                  {addable.map((p) => (
                    <Select.Item key={p.id} value={p.id}>
                      <Select.ItemText>{p.name}</Select.ItemText>
                    </Select.Item>
                  ))}
                </Select.List>
              </Select.Popup>
            </Select.Positioner>
          </Select.Portal>
        </Select.Root>
      )}
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
  // `reconnecting` 同理:隧道掉线后在自动重连,不轮询的话按钮会一直转圈到重开页面。
  useEffect(() => {
    if (status?.tunnelPhase !== "starting" && status?.tunnelPhase !== "reconnecting") return;
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
        <TunnelCard
          // 存过之后整块重挂 —— 草稿与真值对齐(见 TunnelCard 文件内那段)。
          key={`${status.tunnelMode}|${status.tunnelHostname}|${status.mobileHostname}|${status.fixedPort}|${status.tokenHint}`}
          status={status}
          busy={busy}
          onSave={(config) => void run(() => api.publicMcp.setTunnelConfig(config))}
        />
      )}

      {status?.enabled && (
        <div className="space-y-1.5 rounded border border-edge bg-surface/40 p-2.5">
          {/* 一键隧道 —— external 模式下 Mcode 不起进程(隧道是用户自己在外面跑的),
              按钮留着只会让人以为"没点所以没通"。 */}
          <div className={cn("flex items-center gap-2", status.tunnelMode === "external" && "hidden")}>
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

          {/* external:Mcode 没有进程可看,状态来自一次真实的公网探测(见 publicMcpSession 的 externalProbeView)。 */}
          {status.tunnelMode === "external" && (status.tunnelPhase === "starting" || status.tunnelPhase === "ready") && (
            <p
              className={cn(
                "flex items-center gap-1 text-[0.7143em]",
                status.tunnelPhase === "ready" ? "text-accent" : "text-content-subtle",
              )}
            >
              {status.tunnelPhase === "starting" && <IconLoader2 size={12} className="animate-spin" />}
              {status.tunnelPhase === "ready"
                ? t("settings.remoteControl.externalReady")
                : t("settings.remoteControl.externalProbing")}
            </p>
          )}

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

          {/* 手动起快速隧道的命令只对 quick 有意义;自有域名模式下显示它只会误导人去另开一条随机隧道。 */}
          {status.tunnelMode === "quick" && (
            <ValueRow
              label={t("settings.customModels.publicMcpTunnelLabel")}
              value={tunnelCmd}
              copied={copied === "cmd"}
              onCopy={() => void copy("cmd", tunnelCmd)}
            />
          )}

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

          {/* ⚠️ 委派 —— 这个开关比上面任何一项都重。措辞是**警告**,不是提示。 */}
          <div className="mt-1.5 space-y-1 rounded border border-danger/30 bg-danger/5 p-2">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-[0.7857em] font-medium text-danger">
                <IconAlertTriangle size={13} className="shrink-0" />
                {t("settings.remoteControl.delegateLabel")}
              </span>
              <Switch
                checked={status.agentDelegate}
                disabled={busy}
                onCheckedChange={(v) =>
                  void run(() =>
                    api.publicMcp.setTunnelConfig({
                      // 开关搭在隧道那条 IPC 上,所以**必须把现有配置原样带回去**,
                      // 否则一次切换会把域名和模式顺手清掉。token 留空 = 沿用。
                      mode: status.tunnelMode,
                      hostname: status.tunnelHostname,
                      fixedPort: status.fixedPort,
                      agentDelegate: v,
                    }),
                  )
                }
                label={t("settings.remoteControl.delegateLabel")}
              />
            </div>
            <p className="text-[0.6428em] leading-relaxed text-danger">
              {t("settings.remoteControl.delegateWarning")}
            </p>
          </div>
        </div>
      )}

      {status?.enabled && (
        <ProjectLinksCard
          status={status}
          busy={busy}
          copied={copied}
          onCopy={(key, value) => void copy(key, value)}
          run={(fn) => void run(fn)}
        />
      )}
    </div>
  );
}
