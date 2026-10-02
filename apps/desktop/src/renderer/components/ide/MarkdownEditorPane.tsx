/**
 * md 所见即所得编辑面板 —— **Milkdown（Crepe）**。
 *
 * ## 为什么从 MDXEditor 换成它（2026-09-27，用户拍板）
 *
 * 用户要求文档编辑一律**集成优秀的开源项目、不自己写**，并在几个候选里选了 Milkdown：
 * ProseMirror 内核、MIT、插件化，GFM / 数学公式 / 表格 / 代码块（CodeMirror）都是
 * 官方特性。Crepe 是它"装上就能用"的那一层：自带顶部工具栏（TopBar）、浮动工具栏、
 * 斜杠菜单、块拖拽、图片、LaTeX（KaTeX）。
 *
 * ## ⚠️ "没编辑就不写盘"靠的是**用户输入事件**，不是定时器
 *
 * 必须做到：用户打开一篇 md 看一眼、什么都没改就关掉，**文件不能被改动**。
 *
 * Crepe 和 MDXEditor 一样，**挂载时会把 markdown 规范化**（remark 重新 stringify：
 * `-`→`*`、表格补空格、`_`→`\_`），而且 `markdownUpdated` 在创建阶段就会来。所以判据
 * 不能是"和基准比"，而是**真实输入事件**（`keydown` / `beforeinput` / `paste` / `cut` /
 * `drop`）—— 规范化、列表补全、表格重排全是程序改的，**不产生**这些事件。
 * 这套闸门是 MDXEditor 时期实测出来的（打开不动：`writeFile` 调用 **0** 次），换引擎
 * 原样保留。
 *
 * ## 生命周期
 *
 * Crepe 是命令式 API（`new Crepe({root}) → create() → destroy()`），不是 React 组件。
 * 所以它挂在一个 `div` 上、随 `filePath` 重建；`initial` 只在读完文件那一次给它，
 * 之后内容由编辑器自己持有，主动取用 `crepe.getMarkdown()`。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Crepe } from "@milkdown/crepe";
import { editorViewCtx } from "@milkdown/kit/core";
import { TextSelection } from "@milkdown/kit/prose/state";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";
import { api } from "@renderer/lib/api.js";
import { FileConflictError, markdownFileWrites } from "@renderer/lib/markdownFileWrites.js";
import { useDiskPoll } from "@renderer/lib/useDiskPoll.js";
import { isEditingKey, shouldAutosave } from "@renderer/lib/serializedFileWrites.js";
import { useToastStore } from "@renderer/stores/toastStore.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { IconLoader2, IconCheck, IconAlertTriangle } from "@renderer/lib/icons.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { makeQuoteTag } from "@renderer/lib/contentTag.js";
import { basename } from "@renderer/lib/path.js";

export function MarkdownEditorPane({
  filePath,
}: {
  filePath: string;
  projectPath: string | null;
}) {
  const { t } = useI18n();
  // Resolve the visible conversation at click time, not when Crepe is mounted.
  // The side panel may have switched to a different chat/node in the meantime.
  const quoteToCurrent = useCallback((text: string) => {
    if (!text.trim()) return;
    const state = useSessionStore.getState();
    const sessionId = state.activeSideChatId || state.activeSessionId;
    if (!sessionId) {
      useToastStore.getState().push({ kind: "info", title: t("ide.editor.quoteNoOpenChat") });
      return;
    }
    const tag = makeQuoteTag({
      text,
      origin: { kind: "file", filePath, name: basename(filePath) },
    });
    // Shared draft delivery only: no picker, automatic send or conversation switch.
    state.quoteIntoComposer(sessionId, tag);
    window.getSelection()?.removeAllRanges();
    useToastStore.getState().push({
      kind: "info",
      title: t("ide.editor.quoteAdded"),
      sessionId,
    });
  }, [filePath, t]);
  const quoteToCurrentRef = useRef(quoteToCurrent);
  quoteToCurrentRef.current = quoteToCurrent;
  /** 占位和工具栏文案走 ref：换界面语言不该重建编辑器（重建会丢撤销栈）。 */
  const tRef = useRef(t);
  tRef.current = t;
  /** 编辑器实例。挂在 ref 上而不是 state：它不参与渲染，重建时机由 effect 管。 */
  const crepeRef = useRef<Crepe | null>(null);
  /** 外层容器 —— 真实输入事件监听的挂点（见下面那个 effect）。 */
  const rootRef = useRef<HTMLDivElement>(null);
  /** Crepe 的挂载点（与 rootRef 分开：状态浮层也在 rootRef 里，不能让编辑器接管它）。 */
  const mountRef = useRef<HTMLDivElement>(null);
  const [initial, setInitial] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "idle" | "saving" | "saved" | "error">("loading");

  /**
   * 用户到底改没改 —— 判据是**用户输入事件**，不是"和基准不一样"（见文件头）。
   * 基准只用于"改完又改回来了"的判断。
   */
  const baselineRef = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestContentRef = useRef<string | null>(null);
  const queuedContentRef = useRef<string | null>(null);
  const failedContentRef = useRef<string | null>(null);
  const saveVersionRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  /** 用户在本面板里按下过键吗（见 `dirtyRef` 那段注释）。 */
  const userTouchedRef = useRef(false);
  /**
   * **磁盘上**此刻应该是什么 —— 上次读到的原文 / 上次写成功的内容。注意它和
   * `baselineRef` 不是一回事:Crepe 挂载时会把 markdown 规范化,`baselineRef` 是规范化
   * 之后的那份,拿它去和磁盘比永远"不一样"。
   *
   * 用途:(1) 保存前核对 —— 磁盘既不是它、也不是这次要写的,说明 AI 等别人改过,
   * 不能整篇写回去冲掉;(2) 轮询时判断"磁盘变了没有"。
   */
  const diskRef = useRef<string | null>(null);
  /** 发现外部修改、而用户手上又有没存的改动时:暂停自动保存,等用户选。 */
  const [conflict, setConflict] = useState<string | null>(null);
  const conflictRef = useRef<string | null>(null);
  /** 重新载入时要恢复的滚动位置(Crepe 是整个重建的)。 */
  const restoreScrollRef = useRef<number | null>(null);
  /** 内容相同也要强制重建编辑器时递增(载入磁盘版本)。 */
  const [reloadNonce, setReloadNonce] = useState(0);

  /* ── 读文件 ── */
  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setErr(null);
    dirtyRef.current = false;
    baselineRef.current = null;
    userTouchedRef.current = false;
    latestContentRef.current = null;
    diskRef.current = null;
    conflictRef.current = null;
    setConflict(null);
    setInitial(null);
    markdownFileWrites.waitForPending(filePath)
      .then(() => api.file.readFile({ filePath }))
      .then((r) => {
        if (cancelled) return;
        diskRef.current = r.content;
        setInitial(r.content);
        setStatus("idle");
      })
      .catch((e) => {
        if (cancelled) return;
        setErr((e as Error).message);
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  const save = useCallback(
    (content: string, flush = false, force = false) => {
      // 有冲突没解决时不自动写(等用户在横幅上选);关面板时的补存也一样 —— 宁可这次
      // 没存上,也不能把 AI 刚写的内容冲掉。用户点「用我的版本覆盖」走 force。
      if (conflictRef.current !== null && !force) return;
      const version = ++saveVersionRef.current;
      queuedContentRef.current = content;
      failedContentRef.current = null;
      if (!flush && mountedRef.current) {
        setErr(null);
        setStatus("saving");
      }
      // One queue per file outlives this pane: a slow, older write must never
      // finish AFTER a newer one (including a close/switch flush).
      void markdownFileWrites.enqueue(filePath, content, force ? undefined : (diskRef.current ?? undefined)).then(
        () => {
          diskRef.current = content;
          if (version !== saveVersionRef.current) return;
          failedContentRef.current = null;
          if (latestContentRef.current === content) {
            baselineRef.current = content;
            dirtyRef.current = false;
          }
          if (mountedRef.current && latestContentRef.current === content) setStatus("saved");
        },
        (e: unknown) => {
          if (e instanceof FileConflictError) {
            conflictRef.current = e.disk;
            if (mountedRef.current) {
              setConflict(e.disk);
              setStatus("idle");
            } else {
              useToastStore.getState().push({
                kind: "error",
                title: t("ide.editor.externalChangedNotSaved"),
                body: filePath,
              });
            }
            return;
          }
          if (version !== saveVersionRef.current) return;
          failedContentRef.current = content;
          const detail = e instanceof Error ? e.message : String(e);
          if (mountedRef.current) {
            setErr(`${t("library.note.saveFailed")}: ${detail}`);
            setStatus("error");
          } else {
            // The component is gone: its inline status cannot report this.
            useToastStore.getState().push({
              kind: "error",
              title: t("library.note.saveFailed"),
              body: `${filePath}: ${detail}`,
            });
          }
        },
      );
    },
    [filePath, t],
  );

  const onChange = useCallback(
    (next: string) => {
      // ⚠️ 闸门是"用户动过没有"，不是"和基准不一样"（见文件头）。
      if (!userTouchedRef.current) {
        // 顺手把基准追到最新 —— 用户真动手时，"改了没"是拿最后那个稳定值比的
        baselineRef.current = next;
        latestContentRef.current = next;
        return;
      }
      latestContentRef.current = next;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = null;
      // 内容回到基准（用户改完又改回来了）→ 不算脏
      if (!shouldAutosave(true, next, baselineRef.current) && baselineRef.current !== null) {
        dirtyRef.current = false;
        // An older write may already be in flight. Put the baseline AFTER it,
        // otherwise undoing during a slow write leaves the old edit on disk.
        if (queuedContentRef.current !== null && queuedContentRef.current !== next) save(next);
        return;
      }
      dirtyRef.current = true;
      // 防抖：用户可能在连着敲
      saveTimer.current = setTimeout(() => {
        saveTimer.current = null;
        save(next);
      }, 800);
    },
    [save],
  );
  /** 让 Crepe 的监听器永远调到最新的 onChange，而不用为它重建编辑器。 */
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  /** 换成磁盘上的版本(放弃本面板没存的修改),保留滚动位置。 */
  const loadDiskVersion = useCallback((disk: string) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    restoreScrollRef.current = rootRef.current?.scrollTop ?? null;
    diskRef.current = disk;
    conflictRef.current = null;
    setConflict(null);
    dirtyRef.current = false;
    userTouchedRef.current = false;
    baselineRef.current = null;
    latestContentRef.current = null;
    setInitial(disk);
    setReloadNonce((n) => n + 1);
  }, []);

  /** 用户选「用我的版本覆盖」。 */
  const overwriteDisk = useCallback(() => {
    let md = latestContentRef.current;
    try {
      md = crepeRef.current?.getMarkdown() ?? md;
    } catch {
      /* 用最后一次 markdownUpdated 的内容 */
    }
    conflictRef.current = null;
    setConflict(null);
    if (md != null) save(md, false, true);
  }, [save]);

  /**
   * 文件开着时盯磁盘(AI 改这篇文档时最常见)。没改动 → 直接换成新内容;
   * 有没存的改动 → 亮横幅,暂停自动保存,等用户选。
   */
  const diskPollBusyRef = useRef(false);
  const pollDisk = useCallback(
    (path: string) => {
      if (path !== filePath || diskPollBusyRef.current || diskRef.current === null) return;
      if (saveTimer.current || markdownFileWrites.hasPending(path)) return; // 自己的写还没落盘
      diskPollBusyRef.current = true;
      void api.file
        .readFile({ filePath: path })
        .then(({ content: disk }) => {
          if (!mountedRef.current || path !== filePath || markdownFileWrites.hasPending(path) || saveTimer.current) return;
          if (disk === diskRef.current || disk === conflictRef.current) return;
          if (dirtyRef.current) {
            conflictRef.current = disk;
            setConflict(disk);
            return;
          }
          loadDiskVersion(disk);
        })
        .catch(() => {
          /* 读不到 —— 保持当前内容 */
        })
        .finally(() => {
          diskPollBusyRef.current = false;
        });
    },
    [filePath, loadDiskVersion],
  );
  useDiskPoll(initial === null ? null : filePath, pollDisk);

  /* ── 建 / 拆编辑器（随 filePath + 首次读到的内容） ── */
  useEffect(() => {
    if (initial === null) return;
    const host = mountRef.current;
    if (!host) return;
    let disposed = false;
    const crepe = new Crepe({
      root: host,
      defaultValue: initial,
      features: {
        // 顶部常驻工具栏：用户要"点开就能改"，格式按钮得一直看得见，不能只靠选中文字
        // 才浮出来的那条。
        [Crepe.Feature.TopBar]: true,
      },
      featureConfigs: {
        [Crepe.Feature.Toolbar]: {
          buildToolbar: (builder) => {
            builder.addGroup("mcode-context", tRef.current("ide.editor.quoteToCurrent")).addItem("mcode-quote", {
              // A typographic quotation mark: no bespoke SVG or extra icon runtime.
              icon: '<span aria-hidden="true">❞</span>',
              label: tRef.current("ide.editor.quoteToCurrent"),
              active: () => false,
              onRun: (ctx) => {
                if (disposed) return;
                const view = ctx.get(editorViewCtx);
                // ProseMirror retains its last selection after focus moves away.
                // Never quote that stale range when the browser now selects elsewhere.
                const nativeSelection = view.dom.ownerDocument.getSelection();
                if (!nativeSelection || nativeSelection.isCollapsed ||
                    !view.dom.contains(nativeSelection.anchorNode) ||
                    !view.dom.contains(nativeSelection.focusNode)) return;
                const { selection, doc } = view.state;
                if (!(selection instanceof TextSelection) || selection.empty) return;
                const { from, to } = selection;
                const text = doc.textBetween(from, to, "\n\n").trim();
                if (!text) return;
                quoteToCurrentRef.current(text);
              },
            });
          },
        },
        [Crepe.Feature.Placeholder]: {
          text: tRef.current("ide.editor.mdPlaceholder"),
          mode: "doc",
        },
      },
    });
    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, markdown) => {
        if (disposed) return;
        onChangeRef.current(markdown);
      });
    });
    crepeRef.current = crepe;
    void crepe.create().then(
      () => {
        const top = restoreScrollRef.current;
        restoreScrollRef.current = null;
        if (!disposed && top !== null && rootRef.current) rootRef.current.scrollTop = top;
      },
      (e: unknown) => {
        if (disposed) return;
        setErr(e instanceof Error ? e.message : String(e));
        setStatus("error");
      },
    );
    return () => {
      disposed = true;
      crepeRef.current = null;
      void crepe.destroy();
    };
  }, [initial, filePath, reloadNonce]);

  /**
   * **把"用户动过"这件事钉在真实输入事件上。**
   *
   * 挂 `document` 的**捕获阶段**：ProseMirror 在更内层处理输入并可能截停冒泡，
   * 挂在容器上收不到（MDXEditor/Lexical 时期实测过）。判据再加一个 `contains`
   * 检查，免得别处打字把这里也置脏。`beforeinput` 也挂上：输入法上屏走它。
   */
  useEffect(() => {
    const mark = (e: Event) => {
      const el = rootRef.current;
      const t = e.target;
      if (!el || !(t instanceof Node) || !el.contains(t)) return;
      if (e.type === "keydown") {
        if (!isEditingKey(e as KeyboardEvent)) return;
        // 工具栏上的焦点移动不是文字输入。真实编辑还会发 beforeinput/paste/cut/drop。
        if (!(t instanceof Element) || !t.closest('[contenteditable="true"],input,textarea')) return;
      }
      userTouchedRef.current = true;
    };
    const types = ["keydown", "beforeinput", "paste", "cut", "drop"] as const;
    for (const type of types) document.addEventListener(type, mark, true);
    return () => {
      for (const type of types) document.removeEventListener(type, mark, true);
    };
  }, []);

  /**
   * 工具栏按钮（加粗 / 插表格 / 斜杠菜单…）走的是鼠标，不发上面那些键盘事件。
   * 所以 `pointerdown` 落在编辑器**工具栏 / 菜单**里也算"用户动过" —— 但仅限那些
   * 控件，点正文只是移动光标，不算。
   */
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      // Quoting is read-only, even though its button lives in the editor toolbar.
      if (t.closest('[data-toolbar-item="mcode-quote"]')) return;
      if (t.closest("milkdown-toolbar, milkdown-top-bar, milkdown-slash-menu, milkdown-block-handle, .milkdown-table-block, milkdown-latex-inline-edit, milkdown-image-block, milkdown-link-edit"))
        userTouchedRef.current = true;
    };
    el.addEventListener("pointerdown", onPointerDown, true);
    return () => el.removeEventListener("pointerdown", onPointerDown, true);
  }, [initial]);

  // 卸载时把没来得及存的那次补上（**只在真的脏了才存**）
  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (dirtyRef.current && conflictRef.current !== null) {
        // 外部修改的冲突没解决就关了:不写(写了就冲掉 AI 的修改),但要让用户知道
        useToastStore.getState().push({
          kind: "error",
          title: t("ide.editor.externalChangedNotSaved"),
          body: filePath,
        });
      } else if (dirtyRef.current) {
        let md = latestContentRef.current;
        try {
          md = crepeRef.current?.getMarkdown() ?? md;
        } catch {
          /* 编辑器已经拆了，用最后一次 markdownUpdated 里的内容 */
        }
        if (md != null && md !== baselineRef.current &&
            (md !== queuedContentRef.current || failedContentRef.current === md)) save(md, true);
      }
    },
    // `save` 本来就随 `t` 变,补上 `t` 不会多触发
    [filePath, save, t],
  );

  if (err && initial === null) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <span className="text-xs text-red-500">{err}</span>
      </div>
    );
  }
  if (initial === null) {
    return (
      <div className="flex h-full items-center justify-center gap-1.5 text-[11px] text-content-subtle">
        <IconLoader2 size={12} className="animate-spin" />
        {t("common.loading")}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* 状态只在有话说的时候占位置：浮在右上角的一小块，不压一条空栏挤矮编辑区。 */}
      <div ref={rootRef} className="relative min-h-0 flex-1 overflow-auto">
        {(status === "saving" || status === "saved" || (err && status === "error")) && (
          <div className="pointer-events-none absolute right-2 top-2 z-10 flex items-center gap-1 rounded bg-surface/90 px-2 py-0.5 text-[0.7857em] text-content-muted shadow">
            {status === "saving" && (
              <>
                <IconLoader2 size={11} className="animate-spin" />
                {t("common.loading")}
              </>
            )}
            {status === "saved" && (
              <>
                <IconCheck size={11} />
                {t("library.note.saved")}
              </>
            )}
            {err && status === "error" && <span className="text-red-500">{err}</span>}
          </div>
        )}
        {conflict !== null && (
          <div className="sticky top-2 z-20 mx-auto flex w-fit items-center gap-2 rounded-md border border-edge bg-surface px-2.5 py-1 text-[11px] shadow-sm">
            <IconAlertTriangle size={12} className="shrink-0 text-content-muted" />
            <span className="text-content-muted">{t("ide.editor.externalChangedPaused")}</span>
            <button
              type="button"
              onClick={() => loadDiskVersion(conflict)}
              title={t("ide.editor.reloadFromDiskHint")}
              className="rounded px-1.5 py-0.5 text-accent transition-colors hover:bg-surface-hover"
            >
              {t("ide.editor.reloadFromDisk")}
            </button>
            <button
              type="button"
              onClick={overwriteDisk}
              title={t("ide.editor.overwriteDiskHint")}
              className="rounded px-1.5 py-0.5 text-content-muted transition-colors hover:bg-surface-hover"
            >
              {t("ide.editor.overwriteDisk")}
            </button>
          </div>
        )}
        {/* key=filePath：换文件时整棵重挂，Crepe 的 DOM 不会残留到下一篇 */}
        <div key={filePath} ref={mountRef} className="mcode-milkdown h-full min-h-full" />
      </div>
    </div>
  );
}
