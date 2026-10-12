/**
 * **远程主机信任面板** —— 首次 SSH 连接陌生主机时的**宿主受信审批入口**(MC-014 / MC-052)。
 *
 * ## 它补的是哪个洞
 *
 * Agent 连一台从没见过的 SSH 主机时,会停在 `PENDING_CONFIRMATION`(不发送任何凭据,
 * 见 `agentRemoteSsh.ts` 的 `hostVerifier`)。可**批准这台主机**的 `grantHostTrust(` 从前
 * **只有定义、没有任何界面入口** —— 于是普通用户在界面上根本没法完成首次授信,SSH 首连
 * 这件事对非技术用户等于用不了。
 *
 * 这一页就是那扇门:它把当前停在"待批准"的候选指纹列出来,让用户**带外核对**后点批准,
 * 主进程受信 IPC 才签发限 `host:port` / fingerprint / user / 版本的授权。
 *
 * ## ⚠️ 这个面板的每一处都在说同一件事:批准 = 把这台主机当成可信
 *
 * 指纹一旦被批准,**凭据(密码 / 私钥)就会发过去**。所以:说明不折叠、指纹**完整显示**
 * (不缩略成前缀)、批准按钮**逐个**给(不给"全部批准")。用户唯一的核对手段是拿这里显示
 * 的指纹去服务器控制台 `ssh-keygen -lf` 或问管理员对一遍 —— 页面上把这句话原样写出来。
 *
 * 读走 `useRpc`(仓库硬规矩 7),写操作显式 `await api.*` 并由本组件自己管 loading。
 */
import { useState } from "react";
import type { AgentSshPendingHost, AgentSshTrustedHost } from "@contracts/ipc";
import { api } from "@renderer/lib/api.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useRpc } from "@renderer/hooks/useRpc.js";
import { useToastStore } from "@renderer/stores/toastStore.js";
import { PanelHeader } from "./PanelHeader.js";
import { SettingsSection } from "./SettingsSection.js";
import { Button, EmptyState, ErrorNote } from "@renderer/components/ui/index.js";
import {
  IconShieldCheck,
  IconShieldLock,
  IconAlertTriangle,
  IconLoader2,
  IconCopy,
  IconCheck,
} from "@renderer/lib/icons.js";
import { copyText } from "@renderer/lib/clipboard.js";

/** 一行只读指纹(完整显示 + 复制钮;不截断,用户靠它带外核对)。 */
function FingerprintLine({ fingerprint }: { fingerprint: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-16 shrink-0 text-[0.7143em] text-content-subtle">
        {t("settings.agentSsh.fingerprintLabel")}
      </span>
      <code
        className="min-w-0 flex-1 select-all break-all rounded bg-surface-muted px-1.5 py-0.5 font-mono text-[0.7143em] text-content"
        title={fingerprint}
      >
        {fingerprint || "—"}
      </code>
      <Button
        variant="ghost"
        size="sm"
        disabled={!fingerprint}
        className="shrink-0"
        onClick={() =>
          void copyText(fingerprint).then((ok) => {
            if (!ok) return;
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
      </Button>
    </div>
  );
}

/** 待批准的一张卡:host:port + 完整指纹 + 带外核对说明 + 批准按钮。 */
function PendingCard({
  host,
  busy,
  onDecision,
}: {
  host: AgentSshPendingHost;
  busy: boolean;
  onDecision: (approve: boolean) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="space-y-2 rounded border border-warning/40 bg-warning/5 p-2.5">
      <div className="flex items-start gap-1.5">
        <IconAlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[0.7857em] text-content" title={host.hostPort}>
            {host.hostPort}
          </div>
          <div className="truncate text-[0.6428em] text-content-subtle">
            {t("settings.agentSsh.usernameLabel")}: {host.username}
          </div>
        </div>
      </div>
      <FingerprintLine fingerprint={host.fingerprint} />
      {/* 「请与服务器带外核对」这句**不缩进、不折叠** —— 它是用户判断"批不批"的唯一依据。 */}
      <p className="text-[0.6428em] leading-relaxed text-content-subtle">
        {t("settings.agentSsh.verifyHint")}
      </p>
      {host.lastError && (
        <p className="rounded bg-danger/10 px-1.5 py-1 text-[0.6428em] leading-relaxed text-danger">
          {host.lastError}
        </p>
      )}
      <div className="flex items-center gap-1.5">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => onDecision(true)}>
          {busy ? <IconLoader2 size={13} className="mr-1 animate-spin" /> : <IconShieldCheck size={13} className="mr-1" />}
          {t("settings.agentSsh.approve")}
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => onDecision(false)}>
          {t("settings.agentSsh.reject")}
        </Button>
      </div>
    </div>
  );
}

/** 已信任主机的一行(带撤销)。 */
function TrustedRow({
  host,
  busy,
  onRevoke,
}: {
  host: AgentSshTrustedHost;
  busy: boolean;
  onRevoke: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="space-y-1.5 rounded border border-edge bg-surface/40 p-2">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate font-mono text-[0.7857em] text-content" title={host.hostPort}>
          {host.hostPort}
        </span>
        <Button variant="ghost" size="sm" disabled={busy} className="shrink-0" onClick={onRevoke}>
          {busy ? <IconLoader2 size={12} className="mr-1 animate-spin" /> : null}
          {t("settings.agentSsh.revoke")}
        </Button>
      </div>
      <FingerprintLine fingerprint={host.fingerprint} />
      <p className="text-[0.6428em] text-content-subtle">
        {t("settings.agentSsh.approvedAt", { when: new Date(host.approvedAt).toLocaleString() })}
      </p>
    </div>
  );
}

export function AgentSshTrustPanel() {
  const { t } = useI18n();
  const { data, loading, error, refetch } = useRpc(() => api.agentSsh.list({}), [], { toastOnError: false });
  const [busyKey, setBusyKey] = useState<string | null>(null);
  /** 写操作失败走共享 toast(读失败由上面的 ErrorNote 内联显示)。 */
  const report = (msg: string) =>
    useToastStore.getState().push({ kind: "error", title: t("store.toast.errorOccurred"), body: msg });

  const approve = async (host: AgentSshPendingHost) => {
    setBusyKey(host.hostPort);
    try {
      const res = await api.agentSsh.approveHost({ hostPort: host.hostPort, fingerprint: host.fingerprint });
      if (!res.ok) report(res.error ?? t("settings.agentSsh.approveFailed"));
      await refetch();
    } catch (err) {
      report((err as Error).message);
    } finally {
      setBusyKey(null);
    }
  };

  // 拒绝:把候选从待批准列表里去掉即可 —— 不写成"永不信任"(那会让用户以后没法再批),
  // 只是这一次不批。下一次该主机再来时仍会出现在候选里。
  const reject = async (host: AgentSshPendingHost) => {
    setBusyKey(host.hostPort);
    try {
      await api.agentSsh.revokeHost({ hostPort: host.hostPort });
      await refetch();
    } catch (err) {
      report((err as Error).message);
    } finally {
      setBusyKey(null);
    }
  };

  const revoke = async (host: AgentSshTrustedHost) => {
    setBusyKey(host.hostPort);
    try {
      const res = await api.agentSsh.revokeHost({ hostPort: host.hostPort });
      if (!res.ok) report(res.error ?? t("settings.agentSsh.revokeFailed"));
      await refetch();
    } catch (err) {
      report((err as Error).message);
    } finally {
      setBusyKey(null);
    }
  };

  const pending = data?.pending ?? [];
  const trusted = data?.trusted ?? [];

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto">
      <PanelHeader
        title={t("settings.agentSsh.title")}
        icon={IconShieldLock}
        hint={t("settings.agentSsh.desc")}
      />

      {error && (
        <ErrorNote action={<Button size="sm" variant="ghost" onClick={() => void refetch()}>{t("common.retry")}</Button>}>
          {error.message}
        </ErrorNote>
      )}

      {data?.storeInvalid && (
        <ErrorNote tone="warning" icon={IconAlertTriangle}>
          {t("settings.agentSsh.storeInvalid")}
        </ErrorNote>
      )}

      {/* 警告 —— 不折叠、不藏。用户点「批准」之前就该读到。 */}
      <p className="flex items-start gap-1.5 rounded border border-danger/30 bg-danger/5 px-2 py-1.5 text-[0.7143em] leading-relaxed text-danger">
        <IconAlertTriangle size={14} className="mt-0.5 shrink-0" />
        <span>{t("settings.agentSsh.warning")}</span>
      </p>

      <SettingsSection title={t("settings.agentSsh.pendingTitle")}>
        {loading && pending.length === 0 ? (
          <p className="flex items-center gap-1.5 text-[0.7143em] text-content-subtle">
            <IconLoader2 size={13} className="animate-spin" />
            {t("common.loading")}
          </p>
        ) : pending.length === 0 ? (
          <EmptyState icon={IconShieldLock} title={t("settings.agentSsh.pendingEmpty")} desc={t("settings.agentSsh.pendingEmptyDesc")} />
        ) : (
          <div className="space-y-2">
            {pending.map((h) => (
              <PendingCard
                key={h.hostPort}
                host={h}
                busy={busyKey === h.hostPort}
                onDecision={(approveIt) => void (approveIt ? approve(h) : reject(h))}
              />
            ))}
          </div>
        )}
      </SettingsSection>

      <SettingsSection title={t("settings.agentSsh.trustedTitle")}>
        {trusted.length === 0 ? (
          <p className="text-[0.7143em] text-content-subtle">{t("settings.agentSsh.trustedEmpty")}</p>
        ) : (
          <div className="space-y-2">
            {trusted.map((h) => (
              <TrustedRow key={h.hostPort} host={h} busy={busyKey === h.hostPort} onRevoke={() => void revoke(h)} />
            ))}
          </div>
        )}
      </SettingsSection>
    </div>
  );
}
