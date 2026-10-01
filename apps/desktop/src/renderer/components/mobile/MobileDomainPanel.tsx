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
import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import type { PublicMcpStatus } from "@contracts/customModel";
import { Button, Input } from "@renderer/components/ui/index.js";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { copyText } from "@renderer/lib/clipboard.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { IconAlertTriangle, IconCheck, IconCopy, IconRefresh } from "@renderer/lib/icons.js";

export function MobileDomainPanel() {
  const { t } = useI18n();
  const [status, setStatus] = useState<PublicMcpStatus | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 配对码 + 带 nonce 的二维码。**光打开域名配不上**:手机页要从 `?nonce=` 里拿到这次配对的
  // 一次性 nonce(见 PairingScreen),所以这里和「远程访问」页签一样,按公网域名出一张二维码。
  // 局域网里配过的也不通用 —— 手机浏览器按地址(origin)分开存登录凭据,换了域名就是新设备。
  const [pairingUrl, setPairingUrl] = useState<string | null>(null);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  // 这次配对什么时候过期 —— 验证码 5 分钟就作废,不倒计时、不续期的话,用户照着一张
  // 死码去输,只会看到"验证码错误"。
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    const load = (first: boolean) =>
      api.publicMcp
        .status()
        .then((s) => {
          if (!alive) return;
          setStatus(s);
          // 草稿只在第一次对齐 —— 之后的轮询不能把用户正在输入的内容冲掉。
          if (first) setDraft(s.mobileHostname);
        })
        .catch(() => {
          /* 主进程还没就绪 —— 下一轮再看 */
        });
    void load(true);
    // 隧道状态会自己变(连上、掉线重连、出错),这一页要跟着显示,所以轻量轮询。
    const timer = window.setInterval(() => void load(false), 4000);
    return () => {
      alive = false;
      window.clearInterval(timer);
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

  // 不带 force = 沿用正在进行的那次配对(同一个 nonce/验证码,只是二维码换成公网地址),
  // 不会把「局域网配对」页签上那张码作废;「刷新」才 force 换一组新的。
  const generatePairing = useCallback(async (endpoint: string, force = false) => {
    try {
      const res = await api.mobile.startPairing({ mode: "remote", endpoint, force });
      setPairingUrl(res.pairing.qrUrl);
      setPairingCode(res.pairing.code);
      setExpiresAt(res.pairing.expiresAt);
      setQrDataUrl(
        await QRCode.toDataURL(res.pairing.qrUrl, { margin: 1, width: 200, color: { dark: "#0b0b0c", light: "#ffffff" } }),
      );
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    if (!url) {
      setPairingUrl(null);
      setPairingCode(null);
      setQrDataUrl(null);
      setExpiresAt(null);
      return;
    }
    void generatePairing(url);
  }, [url, generatePairing]);

  // 倒计时 + 过期自动续一张(不带 force:别的页签若已续过,就沿用那一张,码保持一致)。
  useEffect(() => {
    if (!expiresAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);
  const expired = expiresAt !== null && now > expiresAt;
  useEffect(() => {
    if (url && expired) {
      setExpiresAt(null);
      void generatePairing(url);
    }
  }, [url, expired, generatePairing]);
  const remainingSec = expiresAt ? Math.max(0, Math.ceil((expiresAt - now) / 1000)) : 0;
  // Cloudflare 那条 ingress 要写的就是这一行。端口取**此刻真在听的那个**,
  // 不是默认值 —— 写错端口的表现是公网连接被拒,而本机一切正常,极难查。
  const ingress = `http://127.0.0.1:${status?.mobilePort || 7331}`;

  // 手机域名**靠的是那条隧道**:快速隧道下它根本不生效;命名隧道要 Mcode 把 cloudflared
  // 跑起来(那颗按钮在「远程控制」里);外部隧道我们看不见,只能提醒。以前这一页对这些
  // 只字不提 —— 填完域名、扫完码,手机打不开,却看不出是隧道没跑。
  const tunnelNote: { tone: "ok" | "warn" | "info"; text: string } | null = !status?.mobileHostname
    ? null
    : status.tunnelMode === "quick"
      ? { tone: "warn", text: t("layout.domainTunnelQuick") }
      : status.tunnelMode === "external"
        ? { tone: "info", text: t("layout.domainTunnelExternal", { ingress }) }
        : status.tunnelPhase === "ready"
          ? { tone: "ok", text: t("layout.domainTunnelReady") }
          : status.tunnelPhase === "starting" || status.tunnelPhase === "reconnecting"
            ? { tone: "info", text: t("layout.domainTunnelStarting") }
            : status.tunnelPhase === "failed" && status.tunnelError
              ? { tone: "warn", text: t("layout.domainTunnelFailed", { error: status.tunnelError }) }
              : { tone: "warn", text: t("layout.domainTunnelNamedOff") };

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

      {tunnelNote && (
        <p
          className={cn(
            "rounded border px-2.5 py-1.5 text-[0.6875rem] leading-relaxed",
            tunnelNote.tone === "ok" && "border-accent/30 bg-accent/5 text-accent",
            tunnelNote.tone === "warn" && "border-warning/40 bg-warning/10 text-warning",
            tunnelNote.tone === "info" && "border-edge bg-surface/40 text-content-subtle",
          )}
        >
          {tunnelNote.text}
        </p>
      )}

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
              title={t("layout.copyPairingLinkTitle")}
              onClick={() => {
                void copyText(pairingUrl ?? url).then((okay) => {
                  if (!okay) return;
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
            </Button>
          </div>
          {qrDataUrl && (
            <div className="flex items-start gap-3 pt-1">
              <img src={qrDataUrl} alt={t("layout.pairingQr")} className="h-[140px] w-[140px] rounded bg-white p-1" />
              <div className="space-y-1.5">
                <span className="block text-xs font-medium text-content-muted">{t("layout.verifyCode")}</span>
                <code className="block font-mono text-lg tracking-[0.3em]">{pairingCode ?? "------"}</code>
                <span className="block text-[0.6875rem] text-content-subtle">
                  {expiresAt === null || expired
                    ? t("layout.pairingExpired")
                    : t("layout.pairingExpiresIn", {
                        time: `${Math.floor(remainingSec / 60)}:${String(remainingSec % 60).padStart(2, "0")}`,
                      })}
                </span>
                <Button variant="ghost" size="sm" onClick={() => void generatePairing(url, true)}>
                  <IconRefresh size={12} className="mr-1" />
                  {t("layout.refreshQr")}
                </Button>
              </div>
            </div>
          )}
          <p className="text-[0.6875rem] leading-relaxed text-content-subtle">
            {t("layout.domainPairHint")}
          </p>
        </div>
      )}
    </div>
  );
}
