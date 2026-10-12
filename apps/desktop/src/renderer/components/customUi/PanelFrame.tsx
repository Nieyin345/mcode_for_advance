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
import { buildPanelDocument, isPanelMethod, isPanelProbeReply, isPanelRequest, PANEL_PROBE_TIMEOUT_MS, type PanelProbeReply } from "@contracts/customUiPanel";
import { api } from "@renderer/lib/api.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { isElectron } from "@renderer/lib/platform.js";
import { handlePanelCall, panelContextOf, readPanelTheme, type PanelHost } from "./panelBridge.js";
import { registerPanelProbe, type PanelProbeHandle } from "./panelReadback.js";

export interface PanelFrameProps {
  item: CustomUiItem;
  target: CustomUiTarget;
  /** 变了就整页重新加载(「重新加载」按钮)。 */
  reloadKey?: number;
  /** 这个面板在哪儿渲染 —— 决定「读回」时它算不算首选(见 `panelReadback`)。 */
  probeMode?: PanelProbeHandle["mode"];
}

/** 主窗口 → 面板的事件(`mcode.on(event, fn)` 收)。 */
function postEvent(frame: HTMLIFrameElement | null, event: string, data: unknown): void {
  try {
    frame?.contentWindow?.postMessage({ __mcode: 1, event, data }, "*");
  } catch {
    /* iframe 还没加载 / 已经卸载 */
  }
}

export function PanelFrame({ item, target, reloadKey = 0, probeMode = "float" }: PanelFrameProps) {
  const { t, locale } = useI18n();
  const action = item.action.type === "panel" ? item.action : null;
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const enabled = action !== null && isElectron;
  const html = action?.html ?? "";
  const network = action?.network === true;
  const title = customUiLabel(item.label, locale);

  /**
   * **文档身份**(决定面板 iframe 里装着哪一版内容的那几样:HTML / 网络 / 标题 / 语言)。
   * 只有它变了才需要重新 stage —— 纯 `target` 变化(切项目 / 换天)不在此列,那走的是
   * 下面的 `context` 事件,不该触发整页重载。
   */
  const stageKey = `${title}\n${network ? "1" : "0"}\n${locale}\n${html}`;
  /**
   * 此刻**当前**该是的那一版(每次渲染同步刷新)。它和下面的 `liveKey` 一比,就知道
   * 现在这个 iframe 里的内容是不是最新的 —— 这个判断在**渲染期**就成立,不等 effect,
   * 于是"改了 html、但 stage 还没跑/还没回来"这整段过渡期,旧面板都被判作废。
   */
  const currentKey = useRef(stageKey);
  currentKey.current = stageKey;
  /**
   * iframe 里**活着**的那一版。`null` = 没有哪一代是活的:首次还没成功,或正在从旧内容
   * 换到新内容,或换版失败停在错误上。**只有它 === `currentKey.current`** 时,面板发来的
   * 调用才放行 —— 旧版本顶着新 `hostRef`(新 action / item / target)继续发命令,就是靠
   * 这一条挡下的。
   */
  const liveKey = useRef<string | null>(null);
  /** 失败视图上点「重试」把它 +1,重跑下面的 stage effect(失败后能再试,而不是卡死)。 */
  const [retryKey, setRetryKey] = useState(0);
  /** 是否成功挂过一代 —— 只用来区分过渡文案(首次「正在加载」vs 换版「正在载入新版本」)。 */
  const stagedOnce = useRef(false);

  // 消息处理器只注册一次;它要的「当前是哪一项 / 哪个目标」从 ref 里拿最新的。
  const hostRef = useRef<PanelHost | null>(null);
  useLayoutEffect(() => {
    hostRef.current = action ? { item, action, target } : null;
  });

  // 「读回」(报告 E10):在飞的一次性 probe,按 probeId 配对。回话由上面那个消息
  // 处理器接(消息处理器只注册一次,得能拿到最新的 pending,所以用 ref)。
  const pendingProbes = useRef<Map<string, { resolve: (r: PanelProbeReply) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>>(new Map());
  const probeSeq = useRef(0);
  const probe = (): Promise<PanelProbeReply> => {
    return new Promise<PanelProbeReply>((resolve, reject) => {
      const win = frameRef.current?.contentWindow;
      if (!win) {
        reject(new Error("panel not mounted"));
        return;
      }
      const probeId = `pb${++probeSeq.current}`;
      const timer = setTimeout(() => {
        pendingProbes.current.delete(probeId);
        reject(new Error("panel did not answer"));
      }, PANEL_PROBE_TIMEOUT_MS);
      pendingProbes.current.set(probeId, { resolve, reject, timer });
      try {
        // 与 `context` / `theme` 事件同一条路:面板 SDK 认 `{__mcode:1, event, data}`。
        win.postMessage({ __mcode: 1, event: "probe", data: { probeId } }, "*");
      } catch (err) {
        window.clearTimeout(timer);
        pendingProbes.current.delete(probeId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  };

  // 量这个面板 iframe **此刻在窗口里的屏幕矩形**(报告 Q1 截图诉求)—— 由宿主来量:面板
  // 自己(沙箱 iframe 内)读不到它在窗口里的位置。`getBoundingClientRect` 已是相对视口的
  // 坐标,与 `capturePage(rect)` 同一套(CSS px == DIP,全仓无 zoomFactor)。拿不到 iframe
  // (还没挂上 / 已卸载)返回 null,调用方**如实报错**,不返回假矩形。
  const rect = (): { x: number; y: number; width: number; height: number } | null => {
    const el = frameRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };

  // 挂载即把「读回」能力登记进注册表(agent 经 app_ui read_panel 找到它);卸载注销。
  useEffect(() => {
    if (!enabled) return;
    const off = registerPanelProbe({ itemId: item.id, label: title, mode: probeMode, probe, rect });
    return off;
    // `probe` / `rect` 每次渲染都是新引用,但它们只是薄薄一层、读的是 ref —— 不必进依赖;
    // 登记表要的是"这一项在哪里"。item.id / probeMode 变了才需要重登记。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, item.id, probeMode, title]);

  // ── 换版:HTML → mcode-panel:// 地址(内容寻址,同一份 HTML 地址不变)──
  //
  // 这一段的关键是**在整段过渡期里把旧面板判作废**。文档字节(`stageKey`)一变:
  //   - `currentKey.current` 在渲染期就变成了新值;
  //   - `liveKey.current` 仍是旧值,于是 `liveKey !== currentKey` → 面板调用一律被拒,
  //     这条判断在**渲染期**成立,连"effect 还没跑"的那一帧都盖住;
  //   - `setUrl(null)` 把旧 iframe 从树上摘掉(连旧版本自己也停);
  //   - stage 成功前不设 `liveKey`;成功后设成**这一代**的 key。失败则 `liveKey` 留在
  //     旧值(或 null),界面停在错误 + 重试,旧 iframe 不复活。
  // stage 回来得晚也覆盖不了更新一代:比 `currentKey.current` 是不是自己这一代的 key。
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const stageDoc = buildPanelDocument(html, { title, locale });
    const key = stageKey;
    setUrl(null);
    setError(null);
    api.customUi
      .stagePanel({ html: stageDoc, network })
      .then((r) => {
        // 这一代已经过时(又改了 HTML / 被换掉)→ 不落任何状态。
        if (cancelled || currentKey.current !== key) return;
        stagedOnce.current = true;
        liveKey.current = key;
        setUrl(r.url);
      })
      .catch((err: unknown) => {
        if (cancelled || currentKey.current !== key) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
    // effect 依赖 `stageKey`(= title/network/locale/html 的去重串)+ retryKey;它们
    // 没变就不会重跑 —— 纯 target 变化不进这里。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, stageKey, retryKey]);

  // ── 面板 → 主窗口的调用 ──
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const win = frameRef.current?.contentWindow;
      if (!win || e.source !== win) return;
      // 这一版**还没挂稳定**(首次加载中 / 正从旧内容换到新内容 / 换版失败):旧 iframe
      // 里那一版已作废,不许拿新 hostRef 的 action / item / target 继续发命令。判据在
      // 渲染期就成立(`currentKey` 每次渲染同步刷新),连 stage 还没发起的那一帧都挡住。
      if (liveKey.current === null || liveKey.current !== currentKey.current) {
        const d: unknown = e.data;
        if (isPanelRequest(d)) {
          try {
            win.postMessage({ __mcode: 1, id: d.id, ok: false, error: "panel closed" }, "*");
          } catch {
            /* iframe 已经没了 */
          }
        }
        return;
      }
      const data: unknown = e.data;
      // 「读回」的回话(报告 E10):面板自己读了 DOM 回过来。先于请求那条分支认。
      if (isPanelProbeReply(data)) {
        const p = pendingProbes.current.get(data.probe);
        if (p) {
          pendingProbes.current.delete(data.probe);
          window.clearTimeout(p.timer);
          p.resolve(data);
        }
        return;
      }
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
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-[0.8571em] text-danger">
        <span>{t("customUi.panel.loadFailed", { error })}</span>
        {/* 换版失败要能再试一次 —— 旧 iframe 已作废,不给退路用户就只剩关掉重开。 */}
        <button
          type="button"
          onClick={() => setRetryKey((k) => k + 1)}
          className="rounded border border-edge px-2 py-0.5 text-content-muted transition-colors hover:bg-surface-hover"
        >
          {t("customUi.panel.retry")}
        </button>
      </div>
    );
  }
  if (url === null) {
    // 成功挂过一版、现在 url 又变 null = 正从旧内容换到新内容 —— 明确说"载入新版本",
    // 而不是含糊的首次加载;此间旧 iframe 已摘掉、它的调用也被判作废。
    return (
      <div className="flex h-full items-center justify-center p-4 text-[0.8571em] text-content-subtle">
        {stagedOnce.current ? t("customUi.panel.loadingNew") : t("customUi.panel.loading")}
      </div>
    );
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
