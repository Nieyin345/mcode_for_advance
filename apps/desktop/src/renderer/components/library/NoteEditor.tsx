/**
 * 右栏:笔记编辑器(应用内直接写 Markdown)。
 *
 * ## 为什么用 Monaco 而不是自己写个 textarea
 *
 * Mcode 里已经有 Monaco(IDE 的编辑器、计划模式都在用),它自带 Markdown 语法高亮、
 * 折叠、查找替换、多光标 —— 这些对"写笔记"都是刚需,自己拿 textarea 造一遍不划算。
 * 而且复用之后**快捷键、主题、字体**跟 IDE 里完全一致,用户不用学第二套。
 *
 * ## 文件是唯一的事实源
 *
 * 保存就是把编辑器内容**写回磁盘上那个 md 文件**(`library.writeNote`)。不搞"存在
 * 数据库里的笔记":用户随时可以在资源管理器里打开那个文件接着改,两边永远是同一份。
 * 代价是保存前的内容只在内存里 —— 所以未保存状态**显式标出来**,并支持 Ctrl/Cmd+S。
 *
 * ## 只对笔记开放
 *
 * 论文/教材的 md 是转录产物,让编辑器直接覆盖它,"转录结果"和"用户改动"就再也分不清。
 * 主进程会校验 kind,这里再隐藏入口(`LibraryPanel` 里只有 note 才有这一页)。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import type { editor } from "monaco-editor";
// Monaco 的 worker 配置必须在任何 <Editor> 挂载之前跑一次(见 monacoSetup.ts)
import "@renderer/lib/monacoSetup.js";
import type { LibraryItem } from "@contracts/library";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { IconCheck, IconLoader2 } from "@renderer/lib/icons.js";
import { useMonacoTheme } from "../ide/FileEditor.js";

export function NoteEditor({ item, onChanged }: { item: LibraryItem; onChanged?: () => void }) {
  const { t } = useI18n();
  const theme = useMonacoTheme();
  /** null = 还没读出来。空串是合法的笔记内容,不能拿它当"没加载"。 */
  const [text, setText] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);

  useEffect(() => {
    let cancelled = false;
    setText(null);
    setDirty(false);
    setError(null);
    // async IIFE:手机端的 web shim 对没映射的命名空间是同步抛错的,
    // 直接挂 .then 会让异常甩出 effect,React 19 会因此整棵卸载
    void (async () => {
      try {
        const res = await api.library.readMarkdown({ id: item.id });
        if (cancelled) return;
        if (!res.ok) setError(res.error ?? t("library.note.readFailed"));
        else setText(res.markdown);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  const save = useCallback(async () => {
    if (text === null || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api.library.writeNote({ id: item.id, text });
      if (!res.ok) {
        setError(res.error ?? t("library.note.saveFailed"));
        return;
      }
      setDirty(false);
      // 标题可能跟着 `# 标题` 变了 —— 让列表重新拉一次,两处显示不会打架
      onChanged?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [item.id, text, saving, onChanged, t]);

  // Ctrl/Cmd+S 保存 —— Monaco 有命令面板,这里按最常见的习惯直接绑上
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [save]);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-xs text-red-500">
        {error}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-edge px-2 py-1">
        <span className="shrink-0 font-mono text-[0.7857em] text-content-subtle">.md</span>
        <span
          className={cn(
            "text-[0.7857em]",
            dirty ? "text-amber-600 dark:text-amber-400" : "text-content-subtle",
          )}
        >
          {dirty ? t("library.note.unsaved") : t("library.note.saved")}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <span className="text-[0.7143em] text-content-subtle">{t("library.note.saveHint")}</span>
          <button
            onClick={() => void save()}
            disabled={!dirty || saving}
            className="inline-flex items-center gap-1 rounded bg-accent px-2 py-0.5 text-[0.7857em] text-white hover:opacity-90 disabled:opacity-40"
          >
            {saving ? (
              <IconLoader2 size={11} className="animate-spin" />
            ) : (
              <IconCheck size={11} />
            )}
            {t("library.note.save")}
          </button>
        </span>
      </div>

      <div className="min-h-0 flex-1">
        {text === null ? (
          <div className="flex h-full items-center justify-center gap-1.5 text-xs text-content-subtle">
            <IconLoader2 size={13} className="animate-spin" />
            {t("common.loading")}
          </div>
        ) : (
          <Editor
            height="100%"
            // path 让 Monaco 按文件记住视图状态(光标位置、折叠),换笔记不会串
            path={`mcode-note://${item.id}.md`}
            language="markdown"
            value={text}
            theme={theme}
            onChange={(value) => {
              setText(value ?? "");
              setDirty(true);
            }}
            onMount={(ed) => {
              editorRef.current = ed;
            }}
            loading={
              <div className="flex h-full items-center justify-center text-[11px] text-content-subtle">
                {t("common.loading")}
              </div>
            }
            options={{
              minimap: { enabled: false },
              fontSize: 12,
              lineNumbers: "on",
              scrollBeyondLastLine: false,
              wordWrap: "on",
              tabSize: 2,
              automaticLayout: true,
              renderWhitespace: "selection",
              scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
            }}
          />
        )}
      </div>
    </div>
  );
}
