/**
 * **「自有域名」页签** —— 手机伴侣的第三条路。
 *
 * 前两条一行没动(用户明确要求保留):
 *   - 「局域网配对」:同一个 Wi-Fi 下直连 `http://<内网 IP>:7331`;
 *   - 「远程访问」:SSH 反向隧道到自己的 VPS。
 *
 * 这一条给已经有域名托管在 Cloudflare 的人。**隧道由用户自己在 Cloudflare 配、自己跑**
 * (官方 `cloudflared service install <token>` 装成系统服务),Mcode 不起任何进程 ——
 * 这一页只做三件事:
 *   1. 显示本机地址(`http://127.0.0.1:<手机端口>`),照着填进 Cloudflare 的 public hostname;
 *   2. (可选)记住手机域名,用来出带配对参数的二维码,并定期探测 `https://域名/api/health`
 *      看整条链路通不通;
 *   3. 进门靠配对码或账号密码(下面那张「账号密码登录」卡片)。
 *
 * 和「设置 → 远程控制」(公网 MCP)无关,不需要开启远程控制。
 */
import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import type { MobileTunnelStatus } from "@contracts/mobile";
import { Button, Input } from "@renderer/components/ui/index.js";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { copyText } from "@renderer/lib/clipboard.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { IconAlertTriangle, IconCheck, IconCopy, IconLoader2, IconRefresh } from "@renderer/lib/icons.js";

export function MobileDomainPanel() {
  const { t } = useI18n();
  const [status, setStatus] = useState<MobileTunnelStatus | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedLocal, setCopiedLocal] = useState(false);
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
  // 主进程 / 预加载脚本比渲染层旧(开发模式热更新后没重启)—— 见下面 load 里的注释。
  const stalePreload = typeof api.mobile.getTunnel !== "function";

  useEffect(() => {
    let alive = true;
    // 单调序号:只有最新一次在飞的 `getTunnel` 能写 state。这一页 4s 轮询一次,慢回包
    // (弱网/主进程卡一下)会盖在下一轮已经发出的请求上 —— 没有守卫时先发后回的那次把
    // 新状态盖成旧的(隧道已连上却显示"未连接")。仓库里同类轮询都补了 *Seq 守卫
    // (GitPanel.scanSeqRef / TaskListPanel.refreshSeqRef),这里补齐同一份。
    let seq = 0;
    const load = async (first: boolean) => {
      // ⚠️ 预加载脚本是窗口创建时注入的:开发模式下渲染层热更新到了新代码,而主进程 /
      // preload 还是旧的,`api.mobile.getTunnel` 就不存在。原先这里直接调,同步抛出的
      // TypeError 冲出 useEffect,整个窗口白屏。现在认出来,提示重启。
      if (stalePreload) return;
      const mySeq = ++seq;
      try {
        const s = await api.mobile.getTunnel();
        if (!alive || mySeq !== seq) return;
        setStatus(s);
        // 草稿只在第一次对齐 —— 之后的轮询不能把用户正在输入的内容冲掉。
        if (first) setDraft(s.mode === "off" ? "" : s.hostname);
      } catch {
        /* 主进程还没就绪 —— 下一轮再看 */
      }
    };
    void load(true);
    // 隧道状态会自己变(连上、掉线重连、出错),这一页要跟着显示,所以轻量轮询。
    const timer = window.setInterval(() => void load(false), 4000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [stalePreload]);

  const run = async (fn: () => Promise<MobileTunnelStatus>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await fn();
      setStatus(next);
      return next;
    } catch (err) {
      setError((err as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  };

  // 只存域名:填了 = external(隧道你自己跑,我们只探测),清空 = off。
  // 若之前(老版本)选过「Mcode 跑隧道」,存一次就会把那个进程停掉。
  const save = async () => {
    const host = draft.trim();
    const next = await run(() => api.mobile.setTunnel({ mode: host ? "external" : "off", hostname: host }));
    if (next) setDraft(next.mode === "off" ? "" : next.hostname);
  };

  const url = status && status.mode !== "off" && status.hostname ? `https://${status.hostname}` : "";

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

  // 隧道是你自己跑的,我们只能从公网敲一下 `https://域名/api/health` 看通不通。
  const tunnelNote: { tone: "ok" | "warn" | "info"; text: string } | null = !status || !url
    ? null
    : status.phase === "ready"
      ? { tone: status.note ? "info" : "ok", text: status.note ?? t("layout.domainTunnelExternalOk", { url }) }
      : status.phase === "failed" && status.error
        ? { tone: "warn", text: t("layout.domainTunnelFailed", { error: status.error }) }
        : { tone: "info", text: t("layout.domainTunnelProbing") };

  const savedHost = status && status.mode !== "off" ? status.hostname : "";
  const dirty = !!status && draft.trim() !== savedHost;

  if (stalePreload) {
    return (
      <p className="flex items-start gap-1.5 rounded border border-warning/40 bg-warning/10 px-2.5 py-2 text-xs leading-relaxed text-warning">
        <IconAlertTriangle size={14} className="mt-0.5 shrink-0" />
        <span>{t("layout.domainStalePreload")}</span>
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <p className="flex items-start gap-1.5 rounded border border-warning/40 bg-warning/10 px-2.5 py-2 text-xs leading-relaxed text-warning">
        <IconAlertTriangle size={14} className="mt-0.5 shrink-0" />
        <span>{t("layout.domainWarning")}</span>
      </p>

      <p className="text-[0.6875rem] leading-relaxed text-content-subtle">{t("layout.domainIndependent")}</p>

      <div className="space-y-1.5">
        <span className="block text-xs font-medium text-content-muted">{t("layout.domainLocalLabel")}</span>
        <div className="flex items-center gap-1.5">
          <code className="min-w-0 flex-1 truncate rounded bg-surface-muted px-1.5 py-1 font-mono text-xs">{ingress}</code>
          <Button
            variant="ghost"
            size="sm"
            title={t("layout.domainCopyLocal")}
            onClick={() => {
              void copyText(ingress).then((okay) => {
                if (!okay) return;
                setCopiedLocal(true);
                window.setTimeout(() => setCopiedLocal(false), 1500);
              });
            }}
          >
            {copiedLocal ? <IconCheck size={12} /> : <IconCopy size={12} />}
          </Button>
        </div>
        <p className="text-[0.6875rem] leading-relaxed text-content-subtle">{t("layout.domainLocalHint")}</p>
      </div>

      <div className="space-y-1.5">
        <span className="block text-xs font-medium text-content-muted">{t("layout.domainLabel")}</span>
        <div className="flex items-center gap-1.5">
          <Input
            value={draft}
            placeholder="m.example.com"
            onChange={(e) => setDraft(e.target.value)}
            className="flex-1"
          />
          <Button variant="outline" size="sm" disabled={busy || !status || !dirty} onClick={() => void save()}>
            {busy ? <IconLoader2 size={12} className="mr-1 animate-spin" /> : null}
            {t("layout.domainSave")}
          </Button>
        </div>
        <p className="text-[0.6875rem] leading-relaxed text-content-subtle">{t("layout.domainHint")}</p>
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
