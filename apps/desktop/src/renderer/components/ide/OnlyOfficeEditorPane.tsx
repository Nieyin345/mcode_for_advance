/**
 * Office 文档（docx / xlsx / pptx…）的**可视化编辑**面板 —— OnlyOffice Document Server。
 *
 * ## 分工（见 `@contracts/ipc` 的 `onlyoffice.ts` 文件头）
 *
 * 编辑器本体是 DS 的（`api.js` 在这个 div 里起一个 iframe，Office 级的 UI 全在里面），
 * 这一层只做四件事：
 *   1. `onlyoffice.open` 拿到 config → 加载 `api.js` → `new DocsAPI.DocEditor`；
 *   2. 未配置 / 连不上 / 路径越界时画出**能走的路**（去设置、重试、切只读预览）；
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
import { IconCheck, IconFileTypeDoc, IconLoader2, IconSettings } from "@renderer/lib/icons.js";

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

/** 按 URL 缓存的 api.js 加载器（见文件头"只能加载一次"）。 */
const scriptLoads = new Map<string, Promise<DocsApiGlobal>>();
function loadDocsApi(url: string): Promise<DocsApiGlobal> {
  const cached = scriptLoads.get(url);
  if (cached) return cached;
  const p = new Promise<DocsApiGlobal>((resolve, reject) => {
    if (window.DocsAPI) {
      resolve(window.DocsAPI);
      return;
    }
    const s = document.createElement("script");
    s.src = url;
    s.async = true;
    s.onload = () => {
      if (window.DocsAPI) resolve(window.DocsAPI);
      else reject(new Error("api.js loaded but DocsAPI is missing"));
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

let idSeq = 0;

export function OnlyOfficeEditorPane({
  filePath,
  onSwitchToPreview,
}: {
  filePath: string;
  /** "切到只读预览"那条退路（DS 没配 / 连不上时给用户一个能看的东西）。 */
  onSwitchToPreview?: () => void;
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

  // 读：开会话（硬规矩 7 —— 读走 useRpc）。失败在面板里画，不弹 toast。
  const { data: opened, loading, error: openError, refetch } = useRpc(
    () => api.onlyoffice.open({ filePath }),
    [filePath],
    { toastOnError: false },
  );
  const sessionKey = opened?.ok ? opened.sessionKey ?? null : null;

  /* ── 起编辑器 ── */
  useEffect(() => {
    if (!opened?.ok || !opened.apiScriptUrl || !opened.config) return;
    let disposed = false;
    setBootError(null);
    setReady(false);
    const scriptUrl = opened.apiScriptUrl;
    const config = opened.config;
    void loadDocsApi(scriptUrl)
      .then((DocsAPI) => {
        if (disposed || !hostRef.current) return;
        editorRef.current = new DocsAPI.DocEditor(hostId, {
          ...config,
          events: {
            onAppReady: () => {
              if (!disposed) setReady(true);
            },
            onError: (e: { data?: { errorCode?: number; errorDescription?: string } }) => {
              if (disposed) return;
              const d = e?.data;
              setBootError(d?.errorDescription ?? `Document Server error ${d?.errorCode ?? ""}`.trim());
            },
            // DS 自己会在停止输入后自动存（回调 status 2）；这里只把"有没改"映射到提示。
            onDocumentStateChange: (e: { data?: boolean }) => {
              if (!disposed && e?.data) setSaveHint("idle");
            },
          },
        });
      })
      .catch((err: unknown) => {
        if (!disposed) setBootError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      disposed = true;
      try {
        editorRef.current?.destroyEditor();
      } catch {
        /* DS 在 iframe 已经没了的时候会抛，无所谓 */
      }
      editorRef.current = null;
      if (opened.sessionKey) void api.onlyoffice.close({ sessionKey: opened.sessionKey });
    };
  }, [opened, hostId]);

  /* ── 轮询保存状态：真正的写盘在主进程（DS 回调），这里只能问 ── */
  useEffect(() => {
    if (!sessionKey || !ready) return;
    let stopped = false;
    const tick = async () => {
      try {
        const st = await api.onlyoffice.sessionState({ sessionKey });
        if (stopped) return;
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
  }, [sessionKey, ready]);

  /* ── Ctrl+S → forcesave（DS 的 iframe 里按 Ctrl+S 它自己也会存；这条管的是焦点在外面时） ── */
  const forceSave = useCallback(async () => {
    if (!sessionKey) return;
    setSaveHint("saving");
    const r = await api.onlyoffice.forceSave({ sessionKey });
    if (!r.ok) {
      setSaveErr(r.error ?? null);
      setSaveHint("error");
    }
    // 成功的话轮询会看到 lastSavedAt 变化 → "saved"
  }, [sessionKey]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        const el = hostRef.current;
        if (el && el.contains(document.activeElement)) {
          e.preventDefault();
          void forceSave();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [forceSave]);

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
                {onSwitchToPreview && (
                  <Button size="sm" variant="ghost" onClick={onSwitchToPreview}>
                    {t("ide.office.viewReadonly")}
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
                {onSwitchToPreview && (
                  <Button size="sm" variant="ghost" onClick={onSwitchToPreview}>
                    {t("ide.office.viewReadonly")}
                  </Button>
                )}
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
      {(saveHint === "saving" || saveHint === "saved" || saveHint === "error") && (
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
