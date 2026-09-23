/**
 * md 所见即所得编辑面板（MDXEditor）。
 *
 * ## 为什么用它（用户 2026-09-21 拍板）
 *
 * 拿真语料实测过 158 个 md：**内容一个字不丢**，变的只是源码排版
 * （`-` → `*`、表格列宽重新对齐、`_` → `\_`）。用户看过数据说"没事，就用这个"。
 * 细节见 `.tmp/md-rt/` 那套往返验证台。
 *
 * ## ⚠️ "没编辑就不写盘"靠的是**用户输入事件**，不是定时器
 *
 * 必须做到：用户打开一篇 md 看一眼、什么都没改就关掉，**文件不能被改动**。
 *
 * 我第一版用"等 120ms 取个基准，和它比" —— **实测不成立**。MDXEditor 挂载后
 * 规范化 markdown 是**异步分批**的（先渲染、再补表格、再补列表），基准早早就
 * 跟不上了，于是打开什么都不做，`writeFile` 已经被调了一次（整篇被重排写回）。
 *
 * 现在把闸门钉在**真实输入事件**上（`keydown` / `beforeinput` / `paste` / `cut` /
 * `drop`）：规范化、列表补全、表格重排全是程序改的，**不产生**这些事件。
 *
 * 实测那一次（没改任何东西、只是打开）: `writeFile` 调用次数 **0**。
 *
 * ## 两个必须知道的坑（都踩过）
 *
 * 1. **挂载时 `onChange` 不会带"用户编辑"来** —— 但**会**带规范化来，而且是多次。
 *    所以要主动取内容得用 `ref.current.getMarkdown()`。
 * 2. **别拿"和基准逐字符相等"当判据**（上面那段）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  MDXEditor,
  type MDXEditorMethods,
  headingsPlugin,
  listsPlugin,
  quotePlugin,
  thematicBreakPlugin,
  markdownShortcutPlugin,
  tablePlugin,
  codeBlockPlugin,
  codeMirrorPlugin,
  frontmatterPlugin,
  linkPlugin,
  linkDialogPlugin,
  imagePlugin,
  jsxPlugin,
  diffSourcePlugin,
  toolbarPlugin,
  UndoRedo,
  BoldItalicUnderlineToggles,
  BlockTypeSelect,
  CreateLink,
  InsertTable,
  InsertThematicBreak,
  Separator,
  ListsToggle,
  InsertCodeBlock,
  InsertImage,
} from "@mdxeditor/editor";
import "@mdxeditor/editor/style.css";
import { api } from "@renderer/lib/api.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { cn } from "@renderer/lib/cn.js";
import { IconLoader2, IconCheck } from "@renderer/lib/icons.js";

export function MarkdownEditorPane({
  filePath,
  projectPath,
}: {
  filePath: string;
  projectPath: string | null;
}) {
  const { t } = useI18n();
  const ref = useRef<MDXEditorMethods>(null);
  /** 外层容器 —— 真实输入事件监听的挂点（见下面那个 effect）。 */
  const rootRef = useRef<HTMLDivElement>(null);
  const [initial, setInitial] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "idle" | "saving" | "saved" | "error">("loading");

  /**
   * 用户到底改没改。
   *
   * ## 为什么不能只靠"和基准比"
   *
   * MDXEditor **一挂载就把 markdown 规范化**（`-`→`*`、表格补空格…），而那个规范化
   * 是**异步分批**发生的：先渲染、再补表格、再补列表。所以：
   *
   *  - 只等 120ms 就去取基准 → 拿到的是**半规范化**的内容；
   *  - 之后编辑器补完剩下的规范化 → `onChange` 带着**不同的**内容来了 → 被判成
   *    "用户改的" → **整篇被写回**。
   *
   * 实测就是这个结果：打开什么都不做，`writeFile` 已经被调了一次。
   *
   * ## 改法：不猜时机，只认"用户真的动过"
   *
   * 判据换成**用户输入事件** —— 键盘、粘贴、剪切、拖放。规范化全是程序改的，
   * 一个真实输入事件都不产生，所以它永远进不了 `dirtyRef`。
   *
   * 这样基准晚到也没关系（下面那个 effect 会随 `onChange` 不断刷新它），
   * 而且**程序性重排永远不触发写盘**。
   */
  const baselineRef = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 用户在本面板里按下过键吗（见 `dirtyRef` 那段注释）。 */
  const userTouchedRef = useRef(false);

  /* ── 读文件 ── */
  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setErr(null);
    dirtyRef.current = false;
    baselineRef.current = null;
    api.file
      .readFile({ filePath })
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

  /**
   * 挂载之后，把编辑器**规范化后的**内容记成基准。
   *
   * ⚠️ 这个 effect **不能**单独承担"没编辑就不写盘"（试过，不成立：规范化是异步
   * 分批的，基准早早就跟不上了）。它只负责一件事：让"用户改了没"在**用户真的
   * 动过之后**判断得准。真正的闸门是 `userTouchedRef`。
   */
  useEffect(() => {
    if (initial === null) return;
    const timer = setTimeout(() => {
      try {
        baselineRef.current = ref.current?.getMarkdown() ?? initial;
      } catch {
        baselineRef.current = initial;
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [initial]);

  const save = useCallback(
    async (content: string) => {
      setStatus("saving");
      try {
        const r = await api.file.writeFile({ filePath, content });
        setStatus(r.ok === false ? "error" : "saved");
        if (r.ok === false) setErr(t("library.note.saveFailed"));
      } catch (e) {
        setErr((e as Error).message);
        setStatus("error");
      }
    },
    [filePath, projectPath, t],
  );

  const onChange = useCallback(
    (next: string) => {
      /**
       * ⚠️ **闸门是"用户动过没有"，不是"和基准不一样"。**
       *
       * MDXEditor 挂载后会把整篇 markdown 规范化（`-`→`*`、表格补空格…），
       * 那个过程会**多次**调 `onChange`，内容和基准随时在变 —— 用"和基准比"挡不住
       * （实测：只等 120ms 取基准，仍然会被判成"用户改了"，打开就写盘一次）。
       *
       * 规范化全是程序改的，**不产生任何真实输入事件**。所以判据换成事件。
       */
      if (!userTouchedRef.current) {
        // 顺手把基准追到最新 —— 这样用户真动手时，"改了没"是拿最后那个稳定值比的
        baselineRef.current = next;
        return;
      }
      // 内容回到基准（用户改完又改回来了）→ 不算脏
      if (baselineRef.current !== null && next === baselineRef.current) {
        dirtyRef.current = false;
        return;
      }
      dirtyRef.current = true;
      // 防抖：用户可能在连着敲
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => void save(next), 800);
    },
    [save],
  );

  /**
   * **把"用户动过"这件事钉在真实输入事件上。**
   *
   * ## ⚠️ 必须挂在 `document` 上，不能在容器上挂
   *
   * 第一版挂在 `rootRef` 容器上（捕获阶段），**实测收不到** —— MDXEditor/Lexical
   * 自己在更内层就处理掉并 `stopPropagation` 了。表现是：字确实进了正文
   * （`innerText` 里有），但 `onChange` 没来、保存也没触发 —— 用户改了却存不下去。
   *
   * 挂 `document` 的**捕获阶段**，事件还没进编辑器就路过我们这儿，谁都挡不住。
   * 判据再加一个 `contains` 检查，免得别处打字把这里也置脏。
   *
   * `beforeinput` 也挂上：软键盘、输入法上屏走它，不一定有 keydown。
   */
  useEffect(() => {
    const mark = (e: Event) => {
      const el = rootRef.current;
      const t = e.target;
      if (el && t instanceof Node && el.contains(t)) userTouchedRef.current = true;
    };
    const types = ["keydown", "beforeinput", "paste", "cut", "drop"] as const;
    for (const type of types) document.addEventListener(type, mark, true);
    return () => {
      for (const type of types) document.removeEventListener(type, mark, true);
    };
  }, []);

  // 卸载时把没来得及存的那次补上（**只在真的脏了才存**）
  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (dirtyRef.current) {
        try {
          const md = ref.current?.getMarkdown();
          if (md != null && md !== baselineRef.current) void api.file.writeFile({ filePath, content: md });
        } catch {
          /* 编辑器已经拆了，拿不到就算了 */
        }
      }
    },
    [filePath],
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
      {/*
        ⚠️ 这里**没有**空状态条 —— 状态只在有话说的时候占位置。
        MDXEditor 的工具栏自带撤销/格式控件；再压一条只显示"已保存"的空栏，
        净效果只是把编辑区挤矮一截。所以状态做成**浮在右上角**的一小块。
      */}
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
        <MDXEditor
          ref={ref}
          markdown={initial}
          onChange={onChange}
          contentEditableClassName="mcode-mdx-content"
          plugins={[
            headingsPlugin(),
            listsPlugin(),
            quotePlugin(),
            thematicBreakPlugin(),
            tablePlugin(),
            codeBlockPlugin({ defaultCodeBlockLanguage: "" }),
            codeMirrorPlugin({
              codeBlockLanguages: {
                "": "Text",
                js: "JavaScript",
                jsx: "JSX",
                ts: "TypeScript",
                tsx: "TSX",
                py: "Python",
                bash: "Bash",
                sh: "Bash",
                json: "JSON",
                yaml: "YAML",
                md: "Markdown",
                css: "CSS",
                html: "HTML",
              },
            }),
            frontmatterPlugin(),
            linkPlugin(),
            linkDialogPlugin(),
            imagePlugin(),
            jsxPlugin(),
            // 源码 / diff 那两档也留着 —— 用户想看原文时不用切走
            diffSourcePlugin({ viewMode: "rich-text" }),
            markdownShortcutPlugin(),
            toolbarPlugin({
              toolbarContents: () => (
                <>
                  <UndoRedo />
                  <Separator />
                  <BoldItalicUnderlineToggles />
                  <Separator />
                  <BlockTypeSelect />
                  <ListsToggle />
                  <Separator />
                  <CreateLink />
                  <InsertImage />
                  <InsertTable />
                  <InsertCodeBlock />
                  <InsertThematicBreak />
                </>
              ),
            }),
          ]}
        />
      </div>
    </div>
  );
}
