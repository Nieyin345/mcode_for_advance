/**
 * MobileConnectDialog — PC-side "connect phone" dialog.
 *
 * Owns the full pairing UX: when opened it asks main for a fresh pairing
 * (QR URL + 6-digit code), renders the QR via `qrcode`, polls the connected-
 * device list, and lets the user revoke a device. The dialog is self-contained
 * and exposes a trigger button the Titlebar renders.
 *
 * Pairing lifecycle:
 *   open → mobile.startPairing() → show QR + code (5-min countdown)
 *   phone scans + enters code → main verifies → device appears in list
 *   close → stop polling (the pending pairing stays alive on the server for
 *   its full TTL — cancelling on close broke the common test flow where the
 *   user reads the code, then switches to the phone to type it).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import { Dialog } from "@renderer/components/ui/index.js";
import { Button } from "@renderer/components/ui/index.js";
import { cn } from "@renderer/lib/cn.js";
import { IconCopy, IconDeviceMobile, IconRefresh, IconTrash, IconWifi, IconWorld, IconWorldWww } from "@renderer/lib/icons.js";
import { api } from "@renderer/lib/api.js";
import { copyText } from "@renderer/lib/clipboard.js";
import { RemoteConnectPanel } from "@renderer/components/mobile/RemoteConnectPanel.js";
import { MobileDomainPanel } from "@renderer/components/mobile/MobileDomainPanel.js";
import { MobileLoginCard } from "@renderer/components/mobile/MobileLoginCard.js";
import type { PairingStartResult, PairedDevice } from "@contracts/mobile";
import type { RelayStatus } from "@contracts/ipc";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useToastStore } from "@renderer/stores/toastStore.js";

/** Self-contained trigger button + dialog, rendered in the left sidebar's quick
 *  actions (below 搜索). The trigger matches the search/new-session button
 *  style; renders its own Dialog.Root so the sidebar only needs
 *  `<MobileConnectButton />`. When remote access (relay) is connected, an
 *  enabled indicator is shown on the right. */
export function MobileConnectButton() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  // Live relay status, so the button can show an "enabled" indicator when
  // remote access is active (connected) even outside the dialog.
  const [relayConnected, setRelayConnected] = useState(false);
  // Number of paired devices that made a request recently (activity window). 
  // Polled periodically — the server's `lastSeenAt` only refreshes on request,
  // so a push event alone wouldn't keep the count fresh.
  const [activeCount, setActiveCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // Seed with current status, then keep in sync via pushed relay:event.
    void api.relay.status().then((s) => {
      if (!cancelled) setRelayConnected(s.state === "connected");
    });
    const unsub = api.on.relayEvent((msg: { status: RelayStatus }) => {
      if (!cancelled) setRelayConnected(msg.status.state === "connected");
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  // Poll the active device count so the button reflects live activity even
  // without any relay events (a paired-but-idle phone slowly ages out of the
  // window).
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const { count } = await api.mobile.getActiveCount();
        if (!cancelled) setActiveCount(count);
      } catch {
        // ignore — server may be down
      }
    };
    void tick();
    const interval = setInterval(() => void tick(), 15_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "flex w-full items-center gap-2 rounded-lg px-1 py-2 transition-colors",
          "[font-size:var(--right-panel-font-size)]",
          "text-content-muted hover:bg-accent/10 hover:text-accent",
          open && "bg-accent/10 text-accent",
        )}
        title={t("layout.connectPhone")}
      >
        <IconDeviceMobile size={16} className="shrink-0" />
        <span className="flex-1 text-left font-medium">{t("layout.connectPhone")}</span>
        {activeCount > 0 && (
          <span
            className="shrink-0 rounded-full bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-accent"
            title={t("layout.activeDevices", { n: activeCount })}
          >
            ×{activeCount}
          </span>
        )}
        {relayConnected && (
          <IconWorld size={14} className="shrink-0 text-accent" title={t("layout.relayConnected")} />
        )}
      </button>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop />
          {/* **固定高度** + 内部滚动(用户要求):切页签、展开表单时弹窗不再忽长忽短。
              标题、页签、底部按钮固定,中间内容区自己出滚动条。90vh 封顶是给矮屏的 ——
              弹窗居中定位,超出视口的部分上下都会被裁掉。 */}
          <Dialog.Popup className="flex h-[min(640px,90vh)] w-[min(420px,92vw)] flex-col p-5">
            <MobileConnectPanel open={open} />
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

function MobileConnectPanel({ open }: { open: boolean }) {
  const { t } = useI18n();
  // ⚠️ 这里只是**多一个页签**:局域网直连与 SSH 反向隧道两条老路一行没动(用户明确要求
  // 保留)。「自有域名」是第三条并列的路,不是替代品 —— 没有域名的人照旧走前两条。
  const [tab, setTab] = useState<"lan" | "remote" | "domain">("lan");
  const [pairing, setPairing] = useState<PairingStartResult | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [devices, setDevices] = useState<PairedDevice[]>([]);
  const [status, setStatus] = useState<{ running: boolean; endpoint: string; lanIp: string | null; lanIps: string[] } | null>(null);
  const [now, setNow] = useState(Date.now());
  const [copied, setCopied] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // 最近一次手动选的网卡 IP —— 切回「局域网」页签重新对齐配对时沿用它,而不是回到自动检测那个。
  const lastHost = useRef<string | undefined>(undefined);
  const beginPairing = useCallback(async (host?: string, force = false) => {
    if (host !== undefined) lastHost.current = host;
    try {
      const res = await api.mobile.startPairing(
        host !== undefined || force ? { host, force } : undefined,
      );
      setPairing(res.pairing);
      const dataUrl = await QRCode.toDataURL(res.pairing.qrUrl, {
        margin: 1,
        width: 220,
        color: { dark: "#0b0b0c", light: "#ffffff" },
      });
      setQrDataUrl(dataUrl);
    } catch (err) {
      console.error("startPairing failed", err);
    }
  }, []);

  /** Regenerate the pairing using a specific LAN IP (when the phone can't reach
   *  the auto-detected one). */
  const rebindEndpoint = useCallback(
    (ip: string) => {
      void beginPairing(ip);
    },
    [beginPairing],
  );

  /** Copy the pairing link (QR content) to the clipboard — the PC-testing path
   *  that doesn't need a phone to decode the QR. Uses the shared copyText
   *  helper (execCommand fallback) so the copy still lands when the clipboard
   *  API is unavailable/denied; the "已复制" feedback only shows on success. */
  const copyPairingLink = useCallback(async () => {
    if (!pairing) return;
    const ok = await copyText(pairing.qrUrl);
    if (ok) setCopied(true);
    else console.error("copy pairing link failed");
  }, [pairing]);

  // Auto-reset the "已复制" feedback after 2s.
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  const refreshDevices = useCallback(async () => {
    try {
      const [d, s] = await Promise.all([api.mobile.listDevices(), api.mobile.getStatus()]);
      setDevices(d.devices);
      setStatus({ running: s.running, endpoint: s.endpoint, lanIp: s.lanIp, lanIps: s.lanIps });
    } catch {
      // ignore — non-fatal
    }
  }, []);

  // On open: start a pairing + load devices/status. The pending pairing stays
  // alive on the server for its full TTL (5 min) even after the dialog closes
  // (see header). Closing just stops polling + clears local UI state.
  useEffect(() => {
    if (!open) {
      setPairing(null);
      setQrDataUrl(null);
      if (pollTimer.current) clearInterval(pollTimer.current);
      return;
    }
    void beginPairing();
    void refreshDevices();
    // Poll device list every 3s while open (so a freshly-paired phone appears).
    pollTimer.current = setInterval(() => {
      void refreshDevices();
    }, 3000);
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, [open, beginPairing, refreshDevices]);

  // 1s ticker for the countdown + auto-refresh pairing when expired.
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [open]);

  // 三个页签共用**同一个**待配对(主进程 PairingManager 只留一个)。在另外两页点过「刷新」
  // 会换掉它,这一页手里的码就作废了却还在倒计时。所以切回来时按当前待配对重新取一次
  // (不带 force = 沿用,不会把别的页签刚生成的码作废)。
  const firstTab = useRef(true);
  useEffect(() => {
    if (firstTab.current) {
      firstTab.current = false;
      return;
    }
    if (open && tab === "lan") void beginPairing(lastHost.current);
  }, [tab, open, beginPairing]);

  const expired = pairing ? now > pairing.expiresAt : false;
  useEffect(() => {
    if (open && pairing && expired) {
      // Auto-renew once expired so the user doesn't have to click.
      void beginPairing(lastHost.current);
    }
  }, [open, pairing, expired, beginPairing]);

  const remainingSec = useMemo(() => {
    if (!pairing) return 0;
    return Math.max(0, Math.ceil((pairing.expiresAt - now) / 1000));
  }, [pairing, now]);

  const handleRevoke = useCallback(
    async (deviceId: string) => {
      try {
        await api.mobile.revokeDevice({ deviceId });
        await refreshDevices();
      } catch (err) {
        // **失败要说出来。** 这是用户主动踢一台手机(安全动作),而 `mobile.revokeDevice`
        // 会抛(zod 失败 / 主进程 IO 失败)—— 从前只 `console.error`,于是那台手机
        // 还连着、用户却以为断了。走 toast(本处没有别的错误位)。
        console.error("revoke failed", err);
        useToastStore.getState().push({
          kind: "error",
          title: t("layout.revokeDeviceFailed"),
          body: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [refreshDevices, t],
  );

  const serverDown = status && !status.running;

  return (
    <>
      <Dialog.Title>{t("layout.connectPhone")}</Dialog.Title>
      <Dialog.Description>{t("layout.connectPhoneDesc")}</Dialog.Description>
      <Dialog.Close />

      {/* Mode tabs */}
      <div className="mt-3 flex shrink-0 gap-1 border-b border-edge">
        <button
          type="button"
          onClick={() => setTab("lan")}
          className={cn(
            "flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-xs font-medium transition-colors",
            tab === "lan"
              ? "border-accent text-accent"
              : "border-transparent text-content-muted hover:text-content",
          )}
        >
          <IconWifi size={14} />
          {t("layout.pairLan")}
        </button>
        <button
          type="button"
          onClick={() => setTab("remote")}
          className={cn(
            "flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-xs font-medium transition-colors",
            tab === "remote"
              ? "border-accent text-accent"
              : "border-transparent text-content-muted hover:text-content",
          )}
        >
          <IconWorld size={14} />
          {t("layout.remoteAccess")}
        </button>
        <button
          type="button"
          onClick={() => setTab("domain")}
          className={cn(
            "flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-xs font-medium transition-colors",
            tab === "domain"
              ? "border-accent text-accent"
              : "border-transparent text-content-muted hover:text-content",
          )}
        >
          <IconWorldWww size={14} />
          {t("layout.pairDomain")}
        </button>
      </div>

      {/* 中间内容区:唯一会滚动的地方(-mr-2 pr-2 给滚动条留位,不挤内容)。 */}
      <div className="-mr-2 min-h-0 flex-1 overflow-y-auto pr-2">
      {/* 自有域名 */}
      {tab === "domain" ? (
        <div className="mt-4">
          <MobileDomainPanel />
        </div>
      ) : /* Remote mode */ tab === "remote" ? (
        <div className="mt-4">
          <RemoteConnectPanel />
        </div>
      ) : (
        <>
          {serverDown && (
            <div className="mt-3 rounded border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
              {t("layout.mobileServerDown")}
            </div>
          )}

          <div className="mt-4 flex gap-4">
            <div className="flex flex-col items-center gap-2">
              <div className="rounded-lg border border-edge bg-white p-2">
                {qrDataUrl ? (
                  <img src={qrDataUrl} alt={t("layout.pairingQr")} className="h-[180px] w-[180px]" />
                ) : (
                  <div className="flex h-[180px] w-[180px] items-center justify-center text-xs text-content-subtle">
                    {t("layout.generating")}
                  </div>
                )}
              </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void beginPairing(undefined, true)}
              className="flex items-center gap-1 text-xs text-content-muted hover:text-content"
            >
              <IconRefresh size={12} /> {t("layout.refreshQr")}
            </button>
            <button
              type="button"
              onClick={() => void copyPairingLink()}
              disabled={!pairing}
              className="flex items-center gap-1 text-xs text-content-muted hover:text-content disabled:opacity-40"
              title={t("layout.copyPairingLinkTitle")}
            >
              <IconCopy size={12} /> {copied ? t("common.copied") : t("layout.copyLink")}
            </button>
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="text-xs text-content-muted">{t("layout.verifyCode")}</div>
          <div className="mt-1 font-mono text-3xl font-bold tracking-[0.3em] text-content">
            {pairing ? pairing.code : "------"}
          </div>
          <div className="mt-1 text-[11px] text-content-subtle">
            {pairing
              ? expired
                ? t("layout.pairingExpired")
                : t("layout.pairingExpiresIn", {
                    time: `${Math.floor(remainingSec / 60)}:${String(remainingSec % 60).padStart(2, "0")}`,
                  })
              : ""}
          </div>
          {status?.endpoint && (
            <div className="mt-3 text-[11px] text-content-subtle">
              {t("layout.lanAddress")}
              <span className="font-mono">{status.endpoint}</span>
            </div>
          )}
          {/* When auto-detection has alternatives, surface them so the user can
              pick the right interface if the phone can't reach the chosen one
              (common with multi-NIC machines / VMs). */}
          {status && status.lanIps.length > 1 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {status.lanIps
                .filter((ip) => status.endpoint.indexOf(ip) < 0)
                .map((ip) => (
                  <button
                    key={ip}
                    type="button"
                    onClick={() => void rebindEndpoint(ip)}
                    className="rounded border border-edge px-1.5 py-0.5 font-mono text-[10px] text-content-subtle hover:bg-surface-hover hover:text-content"
                    title={t("layout.regenerateWithIp", { ip })}
                  >
                    {ip}
                  </button>
                ))}
            </div>
          )}
          <div className="mt-1 text-[11px] text-content-subtle">
            {t("layout.lanHint")}
          </div>
        </div>
      </div>
        </>
      )}

      {/* 账号密码登录:三个标签页共用(任一地址都能用账号密码登录)。 */}
      <MobileLoginCard />

      <div className="mt-5">
        <div className="mb-2 text-xs font-medium text-content-muted">
          {t("layout.connectedDevices", { n: devices.length })}
        </div>
        {devices.length === 0 ? (
          <div className="rounded border border-dashed border-edge px-3 py-3 text-center text-xs text-content-subtle">
            {t("layout.noDevices")}
          </div>
        ) : (
          <ul className="space-y-1.5">
            {devices.map((d) => (
              <li
                key={d.deviceId}
                className="flex items-center gap-2 rounded border border-edge bg-surface-muted px-3 py-2"
              >
                <IconDeviceMobile size={16} className="shrink-0 text-content-muted" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-content">{d.name}</div>
                  <div className="text-[11px] text-content-subtle">
                    {t("layout.pairedAt", { time: new Date(d.pairedAt).toLocaleString() })}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void handleRevoke(d.deviceId)}
                  className="rounded p-1 text-content-subtle hover:bg-surface-hover hover:text-danger"
                  title={t("layout.revokeDevice")}
                >
                  <IconTrash size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      </div>

      <div className="mt-3 flex shrink-0 justify-end">
        <Button variant="ghost" onClick={() => void refreshDevices()}>
          {t("layout.refreshDevices")}
        </Button>
      </div>
    </>
  );
}
