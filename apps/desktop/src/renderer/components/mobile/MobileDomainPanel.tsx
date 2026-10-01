/**
 * **「自有域名」页签** —— 手机伴侣的第三条路。
 *
 * 前两条一行没动(用户明确要求保留):
 *   - 「局域网配对」:同一个 Wi-Fi 下直连 `http://<内网 IP>:7331`;
 *   - 「远程访问」:SSH 反向隧道到自己的 VPS。
 *
 * 这一条给已经有域名托管在 Cloudflare 的人:手机伴侣挂在 `m.你的域名` 上,
 * 走的是和 MCP 端点**同一条命名隧道**(一条 cloudflared 进程按 hostname 分流,
 * 不用再开第二条)。所以这里**不另存一份配置** —— 域名存在同一处
 * (`publicMcp.setTunnelConfig` 的 `mobileHostname`),设置页的「远程控制」里也能改,
 * 两边看到的永远是同一个值。
 *
 * ⚠️ 这一页不做配对。手机第一次连上来仍要走**配对码**那道门(`PairingManager`:
 * 验证码 5 分钟过期、错 5 次作废、常数时间比较)。公网暴露之后,那道门就是唯一的门 ——
 * 所以页面上写的是警告,不是提示。
 */
import { useEffect, useState } from "react";
import type { PublicMcpStatus } from "@contracts/customModel";
import { Button, Input } from "@renderer/components/ui/index.js";
import { api } from "@renderer/lib/api.js";
import { copyText } from "@renderer/lib/clipboard.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { IconAlertTriangle, IconCheck, IconCopy } from "@renderer/lib/icons.js";

export function MobileDomainPanel() {
  const { t } = useI18n();
  const [status, setStatus] = useState<PublicMcpStatus | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.publicMcp
      .status()
      .then((s) => {
        if (!alive) return;
        setStatus(s);
        setDraft(s.mobileHostname);
      })
      .catch(() => {
        /* 主进程还没就绪 —— 重开这个对话框再看 */
      });
    return () => {
      alive = false;
    };
  }, []);

  const save = async () => {
    if (!status) return;
    setBusy(true);
    setError(null);
    try {
      // 原样带回其它几项:这条 IPC 存的是**整份**隧道配置,只填一项等于把别的清掉。
      // token 不传 = 沿用已存的那串(见契约上那句注释)。
      const next = await api.publicMcp.setTunnelConfig({
        mode: status.tunnelMode,
        hostname: status.tunnelHostname,
        mobileHostname: draft.trim(),
        fixedPort: status.fixedPort,
      });
      setStatus(next);
      setDraft(next.mobileHostname);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const url = status?.mobileHostname ? `https://${status.mobileHostname}` : "";
  // Cloudflare 那条 ingress 要写的就是这一行。端口取**此刻真在听的那个**,
  // 不是默认值 —— 写错端口的表现是公网连接被拒,而本机一切正常,极难查。
  const ingress = `http://127.0.0.1:${status?.mobilePort || 7331}`;

  return (
    <div className="space-y-3">
      <p className="flex items-start gap-1.5 rounded border border-warning/40 bg-warning/10 px-2.5 py-2 text-xs leading-relaxed text-warning">
        <IconAlertTriangle size={14} className="mt-0.5 shrink-0" />
        <span>{t("layout.domainWarning")}</span>
      </p>

      <div className="space-y-1.5">
        <span className="block text-xs font-medium text-content-muted">
          {t("layout.domainLabel")}
        </span>
        <div className="flex items-center gap-1.5">
          <Input
            value={draft}
            placeholder="m.example.com"
            onChange={(e) => setDraft(e.target.value)}
            className="flex-1"
          />
          <Button variant="outline" size="sm" disabled={busy || !status} onClick={() => void save()}>
            {t("layout.domainSave")}
          </Button>
        </div>
        <p className="text-[0.6875rem] leading-relaxed text-content-subtle">
          {t("layout.domainHint", { ingress })}
        </p>
        {error && <p className="text-[0.6875rem] text-danger">{error}</p>}
      </div>

      {url && (
        <div className="space-y-1.5 rounded border border-edge bg-surface/40 p-2.5">
          <span className="block text-xs font-medium text-content-muted">
            {t("layout.domainUrlLabel")}
          </span>
          <div className="flex items-center gap-1.5">
            <code className="min-w-0 flex-1 truncate rounded bg-surface-muted px-1.5 py-1 font-mono text-[0.6875rem]">
              {url}
            </code>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void copyText(url).then((okay) => {
                  if (!okay) return;
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
            </Button>
          </div>
          <p className="text-[0.6875rem] leading-relaxed text-content-subtle">
            {t("layout.domainPairHint")}
          </p>
        </div>
      )}
    </div>
  );
}

