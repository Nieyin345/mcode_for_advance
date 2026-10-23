/**
 * Office 文档（docx / xlsx / pptx…）的**可视化编辑**面板 —— OnlyOffice Document Server。
 *
 * ## 分工（见 `@contracts/ipc` 的 `onlyoffice.ts` 文件头）
 *
 * 编辑器本体是 DS 的（`api.js` 在这个 div 里起一个 iframe，Office 级的 UI 全在里面），
 * 这一层只做四件事：
 *   1. `onlyoffice.open` 拿到 config → 加载 `api.js` → `new DocsAPI.DocEditor`；
 *   2. 未配置 / 连不上 / 路径越界时提供去设置或重试的入口；
 *   3. Ctrl+S → `onlyoffice.forceSave`；轮询 `sessionState` 画"已保存 / 保存失败"
 *      （真正的写盘发生在主进程收到 DS 回调时，不在这个进程里）；
 *   4. 卸载时 `destroyEditor()` + `onlyoffice.close`。
 *
 * ## ⚠️ 两个坑
 *
 *  - `api.js` **只能加载一次**：它挂全局 `DocsAPI`，重复插 `<script>` 会报错。用模块级
 *    Promise 缓存；换了 serverUrl 就按新 URL 再缓存一份（key 是 URL）。
 *  - DS 的 iframe 要一个**有高度**的容器。父级塌了就是一条 0 高的空白（与 PDF 那边
 *    同一类坑），所以最外层 `h-full`，挂载点 `absolute inset-0`。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@renderer/lib/api.js";
import { useRpc } from "@renderer/hooks/useRpc.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { Button, EmptyState, ErrorNote, LoadingNote } from "@renderer/components/ui/index.js";
import { IconAlertTriangle, IconCheck, IconFileTypeDoc, IconLoader2, IconSettings } from "@renderer/lib/icons.js";
import { basename } from "@renderer/lib/path.js";

/* ── DS 的全局 API（它没有类型包，这里只声明用到的那几个） ── */
interface DocEditorInstance {
  destroyEditor: () => void;
}
interface DocsApiGlobal {
  DocEditor: new (
    elementId: string,
    config: Record<string, unknown>,
  ) => DocEditorInstance;
}
declare global {
  interface Window {
    DocsAPI?: DocsApiGlobal;
  }
}

/**
 * 【MC-056】`window.DocsAPI` 是**哪一台** Document Server 注册的。
 *
 * `api.js` 是单例:它把 `DocsAPI` 挂到 window 上,**先装的赢** —— 后插一个不同服务器
 * 的 api.js 也不会把全局换成新的(厂商脚本只在自己没定义过时注册)。所以"看见
 * `window.DocsAPI` 就直接用"在**第一次**是对的,在**切换服务器之后**就是把 A 的 SDK
 * 配上 B 的会话 config —— 台账 MC-056 的实测(`requestedServer=B,returnedServer=A`)。
 *
 * 修法是把来源记下来、拿它和本次请求比:
 *   - 同源 → 复用(重复打开同一台服务器不再下载);
 *   - 不同源 → **拒绝**并明说先重启。诚实地说,这一条是 fail-closed 而不是"热切换":
 *     全局是单例、旧 iframe/DocEditor 还在用旧 SDK,能可靠换掉的只有"重新加载整个
 *     渲染进程"。假装已经换成 B 只会把加载/保存失败推迟到用户点保存那一刻。
 */
// #region docsapi-loader
let docsApiOrigin: string | null = null;
/** 报错里给用户看的服务器身份 —— 只取 origin,不带路径/查询(可能含令牌)。 */
function originOf(url: string): string {
  try {
    return new URL(url, window.location.href).origin;
  } catch {
    return url;
  }
}

/** 我们在**全局对象本身**上做的来源标记。
 *
 *  为什么不能只靠模块级 `docsApiOrigin`:模块状态活不过 HMR/重新初始化,而厂商脚本
 *  只注册一次全局 —— 重载后我们会看到一个"来源未知"的全局。台账 MC-056 的复核
 *  反例正是这一支:来源未知时按"就是本次请求的那台"接受,等于把 A 的 SDK 冒充成 B。
 *  把来源钉在**全局对象**上,标记与全局同生共死:模块重载后仍可核对;外部注入的
 *  全局没有标记 → 无法证明来源 → fail-closed(宁可报错要求重启,也不混用)。 */
const ORIGIN_MARKER = "__mcodeDocsApiOrigin";

function markOrigin(global: DocsApiGlobal, origin: string): void {
  try {
    (global as unknown as Record<string, unknown>)[ORIGIN_MARKER] = origin;
  } catch {
    // 冻结对象:标记写不进去也没关系 —— 读回来是 undefined,一律按"无法证明来源"处理。
  }
}

function markedOriginOf(global: DocsApiGlobal): string | null {
  const v = (global as unknown as Record<string, unknown>)[ORIGIN_MARKER];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** 按 URL 缓存的 api.js 加载器(见文件头"只能加载一次")。 */
const scriptLoads = new Map<string, Promise<DocsApiGlobal>>();
function loadDocsApi(url: string): Promise<DocsApiGlobal> {
  const cached = scriptLoads.get(url);
  if (cached) return cached;
  const requestedOrigin = originOf(url);
  const p = new Promise<DocsApiGlobal>((resolve, reject) => {
    if (window.DocsAPI) {
      // 页面里已有全局:先核对**可验证的**来源,再决定用不用。
      //   1. 全局带标记且与本次请求同源 → 用它(同源重复打开 / HMR 后重载);
      //   2. 全局带标记但不同源 → 拒绝(单例全局无法原地替换);
      //   3. 全局**没有标记** → 来源无法证明(外部注入 / 旧版本加载器残留)。
      //      台账明确要求这一支 fail-closed:不能假定它来自本次请求的服务器。
      const known = markedOriginOf(window.DocsAPI) ?? docsApiOrigin;
      if (known === null) {
        reject(new Error(
          `Cannot verify which Document Server the loaded OnlyOffice SDK belongs to ` +
          `(requested ${requestedOrigin}). The vendor script installs a single global that cannot be ` +
          "swapped in place — restart Mcode to load the requested server.",
        ));
        return;
      }
      if (known !== requestedOrigin) {
        reject(new Error(
          `OnlyOffice SDK was loaded from ${known}, but this document asks for ${requestedOrigin}. ` +
          "The vendor script installs a single global and cannot be swapped in place — restart Mcode before using the new Document Server.",
        ));
        return;
      }
      resolve(window.DocsAPI);
      return;
    }
    const s = document.createElement("script");
    s.src = url;
    s.async = true;
    s.onload = () => {
      if (window.DocsAPI) {
        docsApiOrigin = requestedOrigin;
        // 标记钉在全局上(见 ORIGIN_MARKER):模块重载后仍能核对来源。
        markOrigin(window.DocsAPI, requestedOrigin);
        resolve(window.DocsAPI);
      } else reject(new Error("api.js loaded but DocsAPI is missing"));
    };
    s.onerror = () => {
      scriptLoads.delete(url);
      s.remove();
      reject(new Error(`failed to load ${url}`));
    };
    document.head.appendChild(s);
  });
  scriptLoads.set(url, p);
  return p;
}

/** 测试用:重置模块级 SDK 身份(生产不调用)。 */
export function __resetDocsApiOriginForTest(): void {
  docsApiOrigin = null;
  scriptLoads.clear();
}
// #endregion docsapi-loader

let idSeq = 0;

export function OnlyOfficeEditorPane({
  filePath,
  readOnly = false,
  deviceType = "desktop",
  onUseGenofficeView,
}: {
  filePath: string;
  readOnly?: boolean;
  deviceType?: "desktop" | "mobile";
  /**
   * 【T101】「用 GenOffice 打开」的出路 —— **只在调用方确认这条路真的能走通时才传**。
   *
   * `undefined` = 这个文件没有 GenOffice 原生编辑器对端，`notConfigured` 分支
   * 就只画「打开设置」。**不传而不是传了再禁用**：一个永远点不动的按钮比没有更糟
   * （CLAUDE.md 规矩十二「假门禁」的同型 —— 看起来是条路，实际不是）。
   *
   * 判据在调用方（`FileEditor`）：要同时满足 ① GenOffice CLI 就绪 ② 这个扩展名
   * 在 `genofficeAppForPath` 里有路由 ③ 对应的 `hosts.*` 能力为真。
   * 光看 `isOnlyOfficeSupportedPath` 不够 —— OnlyOffice 认 `.docm/.dotx/.xltx/`
   * `.pptm/.potx`，而 GenOffice 只认 `docx|odt|ott` 等（`contracts/genofficeFileRoute.ts`）。
   */
  onUseGenofficeView?: () => void;
}) {
  const { t } = useI18n();
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);
  const hostRef = useRef<HTMLDivElement>(null);
  /** 每个面板一个稳定的 DOM id —— DocEditor 按 id 找容器。 */
  const [hostId] = useState(() => `onlyoffice-host-${++idSeq}`);
  const editorRef = useRef<DocEditorInstance | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [saveHint, setSaveHint] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const lastSavedRef = useRef<number | null>(null);
  /** 磁盘上的文件在编辑器开着时被别人(多半是 AI)改过 —— 主进程每 2 秒报一次。 */
  const [external, setExternal] = useState(false);
  /** 外部修改后用户的保存被另存到的冲突副本(原文件没被覆盖)。 */
  const [conflictCopy, setConflictCopy] = useState<string | null>(null);
  /** 这个编辑器里用户动过没有:没动过的,外部一改就直接重新载入。 */
  const editedRef = useRef(false);
  /**
   * `t` 走 ref：起编辑器那个 effect 的清理会 `destroyEditor()` + `onlyoffice.close`。
   * 若把 `t` 放进依赖，切一次界面语言就会销毁编辑器（未落盘的改动跟着没了），再用
   * **同一份已关闭的会话** config 起一个新的 —— 令牌已失效，之后的保存全部失败。
   */
  const tRef = useRef(t);
  tRef.current = t;

  // 读：开会话（硬规矩 7 —— 读走 useRpc）。失败在面板里画，不弹 toast。
  const { data: opened, loading, error: openError, refetch } = useRpc(
    () => api.onlyoffice.open({
      filePath,
      mode: readOnly ? "view" : "edit",
      deviceType,
    }),
    [filePath, readOnly, deviceType],
    { toastOnError: false },
  );
  const sessionKey = opened?.ok ? opened.sessionKey ?? null : null;

  /* ── 起编辑器 ── */
  useEffect(() => {
    if (!opened?.ok || !opened.apiScriptUrl || !opened.config) return;
    let disposed = false;
    let documentSettled = false;
    setBootError(null);
    setReady(false);
    const documentLoadTimer = window.setTimeout(() => {
      if (disposed || documentSettled) return;
      documentSettled = true;
      setBootError(tRef.current("ide.office.documentLoadTimeout"));
    }, 20_000);
    const scriptUrl = opened.apiScriptUrl;
    const config = opened.config;
    void loadDocsApi(scriptUrl)
      .then((DocsAPI) => {
        if (disposed || !hostRef.current) return;
        editorRef.current = new DocsAPI.DocEditor(hostId, {
          ...config,
          events: {
            onAppReady: () => {
              console.info("[onlyoffice] 应用壳已就绪，等待文档加载");
            },
            onDocumentReady: () => {
              if (disposed) return;
              documentSettled = true;
              window.clearTimeout(documentLoadTimer);
              setBootError(null);
              setReady(true);
            },
            onError: (e: { data?: { errorCode?: number; errorDescription?: string } }) => {
              if (disposed) return;
              documentSettled = true;
              window.clearTimeout(documentLoadTimer);
              const d = e?.data;
              setBootError(d?.errorDescription ?? `Document Server error ${d?.errorCode ?? ""}`.trim());
            },
            // DS 自己会在停止输入后自动存（回调 status 2）；这里只把"有没改"映射到提示。
            onDocumentStateChange: (e: { data?: boolean }) => {
              if (!disposed && !readOnly && e?.data) {
                editedRef.current = true;
                setSaveHint("idle");
              }
            },
          },
        });
      })
      .catch((err: unknown) => {
        if (!disposed) {
          documentSettled = true;
          window.clearTimeout(documentLoadTimer);
          setBootError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      disposed = true;
      window.clearTimeout(documentLoadTimer);
      try {
        editorRef.current?.destroyEditor();
      } catch {
        /* DS 在 iframe 已经没了的时候会抛，无所谓 */
      }
      editorRef.current = null;
      if (opened.sessionKey) {
        // 卸载路径,没人能接这个错;只记一笔,别变成未处理的 rejection。
        api.onlyoffice.close({ sessionKey: opened.sessionKey }).catch((err: unknown) => {
          console.warn("onlyoffice.close failed:", err);
        });
      }
    };
  }, [opened, hostId, readOnly]);

  /**
   * 重新载入磁盘上的版本。主进程发现文件被外部改过就不再复用旧会话(DS 按 key 缓存
   * 着旧内容),这次 open 会拿到新会话;旧编辑器在 effect 清理里销毁,它若还有没落盘的
   * 改动,DS 的最终回调会落到冲突副本,不会盖掉新内容。
   */
  const reloadFromDisk = useCallback(() => {
    editedRef.current = false;
    lastSavedRef.current = null;
    setExternal(false);
    setConflictCopy(null);
    setSaveHint("idle");
    void refetch();
  }, [refetch]);
  const reloadRef = useRef(reloadFromDisk);
  useEffect(() => {
    reloadRef.current = reloadFromDisk;
  }, [reloadFromDisk]);

  /* ── 轮询保存状态：真正的写盘在主进程（DS 回调），这里只能问 ── */
  useEffect(() => {
    if (!sessionKey || !ready || readOnly) return;
    let stopped = false;
    const tick = async () => {
      try {
        const st = await api.onlyoffice.sessionState({ sessionKey });
        if (stopped) return;
        if (st.conflictCopyPath) setConflictCopy(st.conflictCopyPath);
        if (st.externalChange && !editedRef.current && !st.conflictCopyPath) {
          // 用户没动过这份文档:直接换成磁盘上的新内容
          stopped = true;
          reloadRef.current();
          return;
        }
        setExternal(Boolean(st.externalChange));
        if (st.lastError) {
          setSaveErr(st.lastError);
          setSaveHint("error");
        } else if (st.lastSavedAt && st.lastSavedAt !== lastSavedRef.current) {
          lastSavedRef.current = st.lastSavedAt;
          setSaveErr(null);
          setSaveHint("saved");
        }
      } catch {
        /* 主进程在退出 —— 下一拍就停了 */
      }
    };
    const timer = setInterval(() => void tick(), 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [sessionKey, ready, readOnly]);

  /* ── Ctrl+S → forcesave（DS 的 iframe 里按 Ctrl+S 它自己也会存；这条管的是焦点在外面时） ── */
  const forceSave = useCallback(async () => {
    if (!sessionKey || readOnly) return;
    setSaveHint("saving");
    const r = await api.onlyoffice.forceSave({ sessionKey });
    if (!r.ok) {
      setSaveErr(r.error ?? null);
      setSaveHint("error");
    }
    // 成功的话轮询会看到 lastSavedAt 变化 → "saved"
  }, [sessionKey, readOnly]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!readOnly && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        const el = hostRef.current;
        if (el && el.contains(document.activeElement)) {
          e.preventDefault();
          void forceSave();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [forceSave, readOnly]);

  /* ── 状态分支 ── */
  if (loading && !opened) {
    return <LoadingNote className="h-full justify-center" label={t("ide.office.opening")} />;
  }
  if (openError || (opened && !opened.ok)) {
    const notConfigured = opened?.notConfigured === true;
    return (
      <div className="flex h-full flex-col items-center justify-center overflow-auto p-4">
        {notConfigured ? (
          <EmptyState
            icon={IconFileTypeDoc}
            title={t("ide.office.notConfigured")}
            desc={t("ide.office.notConfiguredDesc")}
            action={
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={() => setSettingsOpen(true, "office")}>
                  <IconSettings size={14} />
                  {t("ide.office.openSettings")}
                </Button>
                {/* 【T101】第二条路：GenOffice 原生编辑器。只有调用方确认
                    「这个文件真的能切过去」时才出现（见 prop 注释）——
                    没装 Document Server 的用户不该只剩「去装一个服务器」。 */}
                {onUseGenofficeView !== undefined && (
                  <Button size="sm" variant="primary" onClick={onUseGenofficeView}>
                    {t("ide.office.useGenofficeView")}
                  </Button>
                )}
              </div>
            }
          />
        ) : (
          <ErrorNote
            title={t("ide.office.openFailed")}
            action={
              <div className="flex items-center gap-2">
                <Button size="sm" variant="ghost" onClick={() => void refetch()}>
                  {t("common.retry")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setSettingsOpen(true, "office")}>
                  {t("ide.office.openSettings")}
                </Button>
              </div>
            }
          >
            {openError?.message ?? opened?.error}
          </ErrorNote>
        )}
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {/* 保存状态：浮在右上角，与 md 编辑器同一手感；DS 自己的顶栏在 iframe 里，不挡 */}
      {!readOnly && (saveHint === "saving" || saveHint === "saved" || saveHint === "error") && (
        <div className="pointer-events-none absolute right-2 top-2 z-10 flex items-center gap-1 rounded bg-surface/90 px-2 py-0.5 text-[0.7857em] text-content-muted shadow">
          {saveHint === "saving" && (
            <>
              <IconLoader2 size={11} className="animate-spin" />
              {t("ide.editor.saving")}
            </>
          )}
          {saveHint === "saved" && (
            <>
              <IconCheck size={11} />
              {t("ide.editor.savedToast")}
            </>
          )}
          {saveHint === "error" && (
            <span className="text-red-500">
              {t("ide.editor.saveFailed")}
              {saveErr ? `: ${saveErr}` : ""}
            </span>
          )}
        </div>
      )}
      {!readOnly && (external || conflictCopy) && (
        <div className="absolute left-1/2 top-2 z-10 flex max-w-[90%] -translate-x-1/2 items-center gap-2 rounded-md border border-edge bg-surface px-2.5 py-1 text-[11px] shadow-sm">
          <IconAlertTriangle size={12} className="shrink-0 text-content-muted" />
          <span className="min-w-0 truncate text-content-muted" title={conflictCopy ?? undefined}>
            {conflictCopy
              ? t("ide.office.savedToConflictCopy", { name: basename(conflictCopy) })
              : t("ide.office.externalChanged")}
          </span>
          <button
            type="button"
            onClick={reloadFromDisk}
            title={t("ide.editor.reloadFromDiskHint")}
            className="shrink-0 rounded px-1.5 py-0.5 text-accent transition-colors hover:bg-surface-hover"
          >
            {t("ide.editor.reloadFromDisk")}
          </button>
        </div>
      )}
      {bootError && (
        <div className="absolute inset-x-0 top-0 z-10 p-2">
          <ErrorNote
            title={t("ide.office.openFailed")}
            action={
              <div className="flex items-center gap-2">
                <Button size="sm" variant="ghost" onClick={() => void refetch()}>
                  {t("common.retry")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setSettingsOpen(true, "office")}>
                  {t("ide.office.openSettings")}
                </Button>
              </div>
            }
          >
            {bootError}
          </ErrorNote>
        </div>
      )}
      {!ready && !bootError && (
        <div className="pointer-events-none absolute inset-0 z-[5] flex items-center justify-center bg-surface/60">
          <LoadingNote label={t("ide.office.loadingEditor")} />
        </div>
      )}
      {/* DS 会把这个 div **替换**成它的 iframe —— 所以外面再包一层做定位 */}
      <div ref={hostRef} className="absolute inset-0 min-h-0">
        <div id={hostId} className="h-full w-full" />
      </div>
    </div>
  );
}
