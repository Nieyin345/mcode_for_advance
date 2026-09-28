/**
 * ONLYOFFICE Document Server 的连接配置 —— 挂在「设置 → 内核 → 文档工具链」里
 * ONLYOFFICE 那一行下面。
 *
 * ## 为什么这块要存在
 *
 * 那一行的「安装」只覆盖一条路:Windows + 官方安装包。DS 装在 Docker 里、装在
 * 局域网另一台机器上、或者根本不是 Windows —— 这三种情况下地址与密钥没有任何
 * 入口可填,Office 可视化编辑就永远是灰的(主进程的 `onlyoffice.setConfig` 一直
 * 都在,只是没人调)。
 *
 * ## 但默认不该让用户填
 *
 * 所以顺序是**先自动、后手动**:面板一挂载就 `detectLocal()`,本机那份跑着就把
 * 地址与密钥直接写进配置(密钥从 DS 自己的 `config\local.json` 读,用户不用手抄),
 * 展开表单只是给「我要改」和「Docker/远程」这两种人的。
 *
 * 检测判据不在这里重写:`onlyoffice.detectLocal` 直通主进程 `localInstall.ts` 的
 * `detectLocal()` —— 与工具链那一行的绿点、安装流程的收尾同一个真相源。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Button, Input } from "@renderer/components/ui/index.js";
import type { OnlyOfficeConfig } from "@contracts/ipc";
import { IconCheck, IconLoader2, IconSettings } from "@renderer/lib/icons.js";

const EMPTY: OnlyOfficeConfig = { serverUrl: "", jwtSecret: "", callbackHost: "" };

/** 地址是不是指向本机（判断「这份配置是我们自己写的」用）。 */
function isLoopback(serverUrl: string): boolean {
  try {
    const h = new URL(serverUrl).hostname.toLowerCase();
    return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
  } catch {
    return false;
  }
}

type Note = { kind: "ok" | "warn" | "error"; text: string } | null;
type Busy = "idle" | "detecting" | "saving";

export function OnlyOfficeConfigCard({ onReload }: { onReload: () => Promise<void> }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [cfg, setCfg] = useState<OnlyOfficeConfig>(EMPTY);
  const [busy, setBusy] = useState<Busy>("idle");
  const [note, setNote] = useState<Note>(null);
  /** 自动填写只做一次 —— 它会写配置,不能跟着每次重渲染跑。 */
  const autoTried = useRef(false);

  /**
   * 探本机安装 → 写进配置。
   *
   * `silent` = 挂载时那一次:没检测到本机 DS 是**常态**(Docker / 远程 / 还没装),
   * 不该在面板上留一行红字;用户自己点「自动填写」时才需要知道结果。
   */
  const autoFill = useCallback(async (silent: boolean): Promise<void> => {
    setBusy("detecting");
    try {
      const d = await api.onlyoffice.detectLocal();
      if (!d.installed || !d.suggestedServerUrl) {
        if (!silent) {
          setNote({
            kind: "warn",
            text: d.installed
              ? t("settings.toolchain.onlyoffice.detectedNotRunning")
              : t("settings.toolchain.onlyoffice.notDetected"),
          });
        }
        return;
      }
      const saved = await api.onlyoffice.setConfig({
        serverUrl: d.suggestedServerUrl,
        // DS 关掉 token 校验时留空;开着就必须与它 local.json 里的 inbox 密钥一致
        jwtSecret: d.tokenEnabled === false ? "" : (d.jwtSecret ?? ""),
        // 本机 DS 的回连主机名由主进程推断(127.0.0.1),留空即可
        callbackHost: "",
      });
      setCfg(saved);
      setNote({ kind: "ok", text: t("settings.toolchain.onlyoffice.autoFilled", { url: saved.serverUrl }) });
      await onReload();
    } catch (err) {
      // 手机端的 web shim 没有这个命名空间 —— 同步抛错也在这里被吃掉
      if (!silent) setNote({ kind: "error", text: (err as Error).message });
    } finally {
      setBusy("idle");
    }
  }, [onReload, t]);

  useEffect(() => {
    let dead = false;
    void (async () => {
      let current: OnlyOfficeConfig;
      try {
        current = await api.onlyoffice.getConfig();
      } catch {
        return; // 没有这个通道的宿主:整块不显示任何东西
      }
      if (dead) return;
      setCfg(current);
      if (autoTried.current) return;
      // 没配过 → 替用户配好。已经配过的绝不覆盖(他可能填的是 Docker 地址)。
      //
      // 例外是**本机地址 + 空密钥**这一种:它不是用户的选择,而是一次失败的自动
      // 配置留下的残骸(历史上 local.json 的 BOM 让密钥读成了 null)。这种配置
      // 打开任何文档都是 -20「令牌格式不正确」,而面板上什么都看不出来 ——
      // 遇到就重探一次,把密钥补回去。Docker / 远程地址不在此列,不碰。
      const brokenLocal = isLoopback(current.serverUrl) && !current.jwtSecret;
      if (current.serverUrl && !brokenLocal) return;
      autoTried.current = true;
      await autoFill(true);
    })();
    return () => {
      dead = true;
    };
  }, [autoFill]);

  /** 保存 + 立刻探一次 `/healthcheck`,把「填完了到底通不通」当场说清楚。 */
  const saveAndTest = async (): Promise<void> => {
    setBusy("saving");
    setNote(null);
    try {
      const saved = await api.onlyoffice.setConfig(cfg);
      setCfg(saved);
      const st = await api.onlyoffice.status();
      setNote(
        st.reachable
          ? { kind: "ok", text: t("settings.toolchain.onlyoffice.reachable") }
          : { kind: "warn", text: t("settings.toolchain.onlyoffice.unreachable", { error: st.error ?? "" }) },
      );
      await onReload();
    } catch (err) {
      setNote({ kind: "error", text: (err as Error).message });
    } finally {
      setBusy("idle");
    }
  };

  const field = (
    label: string,
    value: string,
    onChange: (v: string) => void,
    opts: { placeholder?: string; password?: boolean; hint?: string } = {},
  ) => (
    <label className="block">
      <span className="text-[0.7857em] text-content-subtle">{label}</span>
      <Input
        className="mt-0.5"
        type={opts.password ? "password" : "text"}
        value={value}
        placeholder={opts.placeholder}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
      {opts.hint && (
        <span className="mt-0.5 block text-[0.7143em] leading-relaxed text-content-subtle">{opts.hint}</span>
      )}
    </label>
  );

  return (
    <div className="mt-1.5">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" className="h-6 gap-1 px-1.5" onClick={() => setOpen((v) => !v)}>
          <IconSettings size={12} />
          {open ? t("settings.toolchain.onlyoffice.hide") : t("settings.toolchain.onlyoffice.configure")}
        </Button>
        {busy === "detecting" && !open && <IconLoader2 size={12} className="animate-spin text-content-subtle" />}
        {!open && cfg.serverUrl && (
          <span className="truncate font-mono text-[0.7143em] text-content-subtle" title={cfg.serverUrl}>
            {cfg.serverUrl}
          </span>
        )}
      </div>

      {note && (
        <div
          className={cn(
            "mt-1 flex items-start gap-1 text-[0.7857em] leading-relaxed",
            note.kind === "ok" ? "text-success" : note.kind === "warn" ? "text-warning" : "text-danger",
          )}
        >
          {note.kind === "ok" && <IconCheck size={12} className="mt-0.5 shrink-0" />}
          <span className="min-w-0 break-all">{note.text}</span>
        </div>
      )}

      {open && (
        <div className="mt-1.5 space-y-2 rounded border border-edge bg-surface-hover/40 p-2.5">
          {field(
            t("settings.toolchain.onlyoffice.serverUrl"),
            cfg.serverUrl,
            (v) => setCfg((c) => ({ ...c, serverUrl: v })),
            { placeholder: "http://127.0.0.1:8080" },
          )}
          {field(
            t("settings.toolchain.onlyoffice.jwtSecret"),
            cfg.jwtSecret,
            (v) => setCfg((c) => ({ ...c, jwtSecret: v })),
            { password: true, hint: t("settings.toolchain.onlyoffice.jwtHint") },
          )}
          {field(
            t("settings.toolchain.onlyoffice.callbackHost"),
            cfg.callbackHost,
            (v) => setCfg((c) => ({ ...c, callbackHost: v })),
            {
              placeholder: t("settings.toolchain.onlyoffice.callbackAuto"),
              hint: t("settings.toolchain.onlyoffice.callbackHint"),
            },
          )}
          <div className="flex items-center gap-1.5 pt-0.5">
            <Button size="sm" disabled={busy !== "idle"} onClick={() => void saveAndTest()} className="gap-1">
              {busy === "saving" && <IconLoader2 size={12} className="animate-spin" />}
              {t("settings.toolchain.onlyoffice.saveAndTest")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy !== "idle"}
              onClick={() => void autoFill(false)}
              className="gap-1"
            >
              {busy === "detecting" && <IconLoader2 size={12} className="animate-spin" />}
              {t("settings.toolchain.onlyoffice.autoFill")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
