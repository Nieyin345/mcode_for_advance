/**
 * 自定义面板(R41)的**显示框**:把用户的 HTML 交给主进程挂到 `mcode-panel://`,
 * 再用一个沙箱 iframe 打开它,并在这里接住面板发来的 `window.mcode` 调用。
 *
 * ## 为什么不直接 srcdoc / blob
 *
 * srcdoc / blob 文档**继承主窗口的 CSP**(打包后是 `script-src 'self'`),用户写的内联脚本
 * 一行都跑不起来。`mcode-panel://` 是主进程注册的协议,响应头里带着**面板自己的** CSP
 * (默认不联网;勾了「允许联网」才放开 https)。
 *
 * ## 隔离
 *
 * - `sandbox="allow-scripts allow-forms allow-modals"`:**没有** `allow-same-origin`
 *   (opaque origin,读不到任何 storage / cookie)、没有 `allow-top-navigation` / `allow-popups`。
 * - 只认 `e.source === 这个 iframe 的 contentWindow` 的消息;回复也只发给它。
 * - 面板能调的方法就是 `panelBridge.ts` 里那张表。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { customUiLabel, templateVarsOf, type CustomUiItem, type CustomUiTarget } from "@contracts/customUi";
import { buildPanelDocument, isPanelMethod, isPanelRequest } from "@contracts/customUiPanel";
import { api } from "@renderer/lib/api.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { isElectron } from "@renderer/lib/platform.js";
import { handlePanelCall, panelContextOf, readPanelTheme, type PanelHost } from "./panelBridge.js";

export interface PanelFrameProps {
  item: CustomUiItem;
  target: CustomUiTarget;
  /** 变了就整页重新加载(「重新加载」按钮)。 */
  reloadKey?: number;
}

/** 主窗口 → 面板的事件(`mcode.on(event, fn)` 收)。 */
function postEvent(frame: HTMLIFrameElement | null, event: string, data: unknown): void {
  try {
    frame?.contentWindow?.postMessage({ __mcode: 1, event, data }, "*");
  } catch {
    /* iframe 还没加载 / 已经卸载 */
  }
}

export function PanelFrame({ item, target, reloadKey = 0 }: PanelFrameProps) {
  const { t, locale } = useI18n();
  const action = item.action.type === "panel" ? item.action : null;
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 消息处理器只注册一次;它要的「当前是哪一项 / 哪个目标」从 ref 里拿最新的。
  const hostRef = useRef<PanelHost | null>(null);
  useLayoutEffect(() => {
    hostRef.current = action ? { item, action, target } : null;
  });

  const enabled = action !== null && isElectron;
  const html = action?.html ?? "";
  const network = action?.network === true;
  const title = customUiLabel(item.label, locale);

  // ── 挂载:HTML → mcode-panel:// 地址(内容寻址,同一份 HTML 地址不变)──
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setError(null);
    const doc = buildPanelDocument(html, { title, locale });
    api.customUi
      .stagePanel({ html: doc, network })
      .then((r) => {
        if (!cancelled) setUrl(r.url);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, html, network, title, locale]);

  // ── 面板 → 主窗口的调用 ──
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const win = frameRef.current?.contentWindow;
      if (!win || e.source !== win) return;
      const data: unknown = e.data;
      if (!isPanelRequest(data)) return;
      const { id, method, params } = data;
      const reply = (msg: { ok: true; result: unknown } | { ok: false; error: string }) => {
        try {
          win.postMessage({ __mcode: 1, id, ...msg }, "*");
        } catch (err) {
          // 结果里有克隆不了的东西 —— 不该发生(都是普通对象),发生了就告诉面板而不是让它一直等。
          try {
            win.postMessage({ __mcode: 1, id, ok: false, error: err instanceof Error ? err.message : String(err) }, "*");
          } catch {
            /* iframe 已经没了 */
          }
        }
      };
      const host = hostRef.current;
      if (!host) {
        reply({ ok: false, error: "panel closed" });
        return;
      }
      if (!isPanelMethod(method)) {
        reply({ ok: false, error: `unknown method: ${method}` });
        return;
      }
      handlePanelCall(host, method, params).then(
        (result) => reply({ ok: true, result: result ?? null }),
        (err: unknown) => reply({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      );
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // 换主题(<html> 的 class / style 变了)→ `theme` 事件。
  useEffect(() => {
    if (!enabled) return;
    let raf = 0;
    const obs = new MutationObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => postEvent(frameRef.current, "theme", readPanelTheme()));
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    return () => {
      obs.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [enabled]);

  // 目标变了(右栏页签跟着当前项目 / 对话走)→ `context` 事件。首次加载时面板自己会 `context()`。
  const varsKey = JSON.stringify(templateVarsOf(target));
  const firstVars = useRef(true);
  useEffect(() => {
    if (firstVars.current) {
      firstVars.current = false;
      return;
    }
    const host = hostRef.current;
    if (host) postEvent(frameRef.current, "context", panelContextOf(host));
  }, [varsKey]);

  if (!isElectron) {
    return <div className="flex h-full items-center justify-center p-4 text-[0.8571em] text-content-subtle">{t("customUi.panel.desktopOnly")}</div>;
  }
  if (action === null) return null;
  if (error !== null) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-[0.8571em] text-danger">
        {t("customUi.panel.loadFailed", { error })}
      </div>
    );
  }
  if (url === null) {
    return <div className="flex h-full items-center justify-center p-4 text-[0.8571em] text-content-subtle">{t("customUi.panel.loading")}</div>;
  }
  return (
    <iframe
      // 同一份 HTML 地址不变:「重新加载」靠换 key 重建 iframe。
      key={`${url}#${reloadKey}`}
      ref={frameRef}
      title={title}
      src={url}
      sandbox="allow-scripts allow-forms allow-modals"
      allow="clipboard-write"
      referrerPolicy="no-referrer"
      className="block h-full w-full border-0 bg-surface"
      data-testid="custom-ui-panel-frame"
    />
  );
}
