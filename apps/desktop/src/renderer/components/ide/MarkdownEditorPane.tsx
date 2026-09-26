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
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";
import { api } from "@renderer/lib/api.js";
import { markdownFileWrites } from "@renderer/lib/markdownFileWrites.js";
import { isEditingKey, shouldAutosave } from "@renderer/lib/serializedFileWrites.js";
import { useToastStore } from "@renderer/stores/toastStore.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { IconLoader2, IconCheck } from "@renderer/lib/icons.js";

export function MarkdownEditorPane({
  filePath,
}: {
  filePath: string;
  projectPath: string | null;
}) {
  const { t } = useI18n();
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

  /* ── 读文件 ── */
  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setErr(null);
    dirtyRef.current = false;
    baselineRef.current = null;
    userTouchedRef.current = false;
    latestContentRef.current = null;
    setInitial(null);
    markdownFileWrites.waitForPending(filePath)
      .then(() => api.file.readFile({ filePath }))
      .then((r) => {
        if (cancelled) return;
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
    (content: string, flush = false) => {
      const version = ++saveVersionRef.current;
      queuedContentRef.current = content;
      failedContentRef.current = null;
      if (!flush && mountedRef.current) {
        setErr(null);
        setStatus("saving");
      }
      // One queue per file outlives this pane: a slow, older write must never
      // finish AFTER a newer one (including a close/switch flush).
      void markdownFileWrites.enqueue(filePath, content).then(
        () => {
          if (version !== saveVersionRef.current) return;
          failedContentRef.current = null;
          if (latestContentRef.current === content) {
            baselineRef.current = content;
            dirtyRef.current = false;
          }
          if (mountedRef.current && latestContentRef.current === content) setStatus("saved");
        },
        (e: unknown) => {
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
        [Crepe.Feature.Placeholder]: {
          text: t("ide.editor.mdPlaceholder"),
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
    void crepe.create().catch((e: unknown) => {
      if (disposed) return;
      setErr(e instanceof Error ? e.message : String(e));
      setStatus("error");
    });
    return () => {
      disposed = true;
      crepeRef.current = null;
      void crepe.destroy();
    };
    // `t` 只影响占位文案，不值得为它重建编辑器（重建会丢撤销栈）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial, filePath]);

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
      if (dirtyRef.current) {
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
    [filePath, save],
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
        {/* key=filePath：换文件时整棵重挂，Crepe 的 DOM 不会残留到下一篇 */}
        <div key={filePath} ref={mountRef} className="mcode-milkdown h-full min-h-full" />
      </div>
    </div>
  );
}
