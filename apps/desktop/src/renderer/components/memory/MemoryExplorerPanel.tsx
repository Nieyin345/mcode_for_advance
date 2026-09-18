/**
 * 记忆库面板:六类记忆目录(rules / project / preferences / experiences / failures /
 * decisions)的**文件管理器** —— 左栏分类与文件,右栏一个 Markdown 编辑器。
 *
 * ## 数据从哪来
 *
 * `memory.categories` 给类目、`memory.list` 给文件(`MemoryFileMeta`,见
 * `@contracts/memory`)、`memory.read/save/delete` 是三个文件动作。新建的文件在
 * **保存之前只是草稿** —— 列表里没有它,右栏标着「(未保存)」;保存路径限定
 * `${类目}/${名字}.md`,不提供越出类目目录的写法(这里是记忆的编辑器,不是通用
 * 文件管理器)。
 *
 * ## save/delete 的失败不是异常
 *
 * 契约里这两个动作返回 `{ ok, error? }`:`ok: false` 时 `error` 是**给人看的句子**
 * —— 原样摆进顶栏,不二次加工。真异常(通道断了)才走 catch 那条路。
 *
 * ## 读不到怎么办
 *
 * 通道没就绪/读失败:一句错误小字,不弹错(同 `RunHistorySection` 的纪律)。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { MEMORY_CATEGORIES, type MemoryFileMeta } from "@contracts/memory";
import "@renderer/lib/monacoSetup.js";
import Editor from "@monaco-editor/react";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useMonacoTheme } from "@renderer/components/ide/FileEditor.js";
import { Button, ConfirmDialog, Input } from "@renderer/components/ui/index.js";
import { IconDeviceFloppy, IconNotebook, IconPlus, IconTrash } from "@renderer/lib/icons.js";
import { PANEL_MAX_W } from "../settings/panelWidth.js";
import { PanelHeader } from "../settings/PanelHeader.js";

/** 顶栏状态行的一句话。tone 决定颜色:ok 绿、error 红。 */
interface Notice {
  tone: "ok" | "error";
  text: string;
}

/** 路径的最后一段 —— 列表显示名的兜底(title 缺了/空了才用它),全路径进 title。 */
function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

/** 新建文件名的一票否决:空名、带斜杠(想越出类目目录)都不给过。 */
function validDraftName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length > 0 && !/[/\\]/.test(trimmed);
}

export function MemoryExplorerPanel() {
  const { t } = useI18n();
  const theme = useMonacoTheme();
  const [categories, setCategories] = useState<string[]>([]);
  const [files, setFiles] = useState<MemoryFileMeta[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** 当前打开的文件(全路径)。null = 没打开(右栏给引导语)。 */
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  /** 新建草稿。非 null 时右栏整个换成起名表单 —— 保存之前不落盘。 */
  const [draft, setDraft] = useState<{ category: string; name: string } | null>(null);
  /** 等待确认删除的文件(全路径)。ConfirmDialog 的目标。 */
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [cats, listRes] = await Promise.all([api.memory.categories(), api.memory.list({})]);
      setCategories(cats);
      setFiles(listRes.files);
      setLoadError(null);
    } catch (err) {
      // 类目是**契约里的常量**(固定六类),通道断了也照摆 —— 目录架子不塌,
      // 每一类下面"读不出来"由 loadError 那句小字交代。
      setCategories([...MEMORY_CATEGORIES]);
      setLoadError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** 读一个文件进编辑器。读失败:右栏给空内容 + 一句红字,不让面板崩。 */
  const open = useCallback(
    async (path: string): Promise<void> => {
      setDraft(null);
      setSelected(path);
      setNotice(null);
      try {
        const res = await api.memory.read({ path });
        setContent(res.content);
        setSavedContent(res.content);
      } catch (err) {
        setContent("");
        setSavedContent("");
        setNotice({
          tone: "error",
          text: t("memory.readFailed", { error: (err as Error).message }),
        });
      }
    },
    [t],
  );

  /** 保存一个文件。成功与否都**在顶栏一句话**,不弹框 —— 保存是高频动作。 */
  const save = useCallback(
    async (path: string, body: string): Promise<boolean> => {
      try {
        const res = await api.memory.save({ path, content: body });
        if (res.ok) {
          setSavedContent(body);
          setNotice({ tone: "ok", text: t("memory.saved") });
          return true;
        }
        // ok: false 不是异常 —— error 是主进程写给人看的句子,原样摆。
        setNotice({ tone: "error", text: res.error ?? t("common.error") });
        return false;
      } catch (err) {
        setNotice({
          tone: "error",
          text: t("memory.saveFailed", { error: (err as Error).message }),
        });
        return false;
      }
    },
    [t],
  );

  /** 新建:保存成功才进列表(路径限定 `${类目}/${名字}.md`)。 */
  const createDraft = useCallback(async (): Promise<void> => {
    if (draft === null || !validDraftName(draft.name)) return;
    const path = `${draft.category}/${draft.name.trim()}.md`;
    // 存不下去(重名等)就留在草稿态 —— 顶栏有失败的原因,改个名字再试。
    const ok = await save(path, "");
    if (!ok) return;
    setDraft(null);
    setContent("");
    setSavedContent("");
    setSelected(path);
    void load();
  }, [draft, save, load]);

  const remove = useCallback(
    async (path: string): Promise<void> => {
      try {
        const res = await api.memory.delete({ path });
        if (!res.ok) {
          setNotice({ tone: "error", text: res.error ?? t("common.error") });
          return;
        }
        if (selected === path) {
          setSelected(null);
          setContent("");
          setSavedContent("");
        }
        setNotice(null);
        void load();
      } catch (err) {
        setNotice({
          tone: "error",
          text: t("memory.deleteFailed", { error: (err as Error).message }),
        });
      }
    },
    [selected, load, t],
  );

  /** 按类目归组的文件(`category` 是主进程给的,目录即类目)。 */
  const byCategory = useMemo(() => {
    const map = new Map<string, MemoryFileMeta[]>();
    for (const f of files) {
      const bucket = map.get(f.category);
      if (bucket) bucket.push(f);
      else map.set(f.category, [f]);
    }
    return map;
  }, [files]);

  const dirty = selected !== null && content !== savedContent;

  return (
    <section className={`mx-auto flex h-full w-full ${PANEL_MAX_W.canvas} flex-col`}>
      <PanelHeader title={t("settings.nav.memory")} icon={IconNotebook} />

      {loadError !== null && (
        <div className="mb-3 rounded border border-danger/40 bg-danger/5 px-3 py-2 text-[0.7857em] text-danger">
          {t("memory.loadFailed", { error: loadError })}
        </div>
      )}

      <div className="flex min-h-0 flex-1 gap-3">
        {/* ───────── 左栏:分类 + 文件列表 ───────── */}
        <div className="w-56 shrink-0 overflow-y-auto rounded border border-edge bg-surface">
          {categories.length === 0 ? (
            <p className="p-3 text-[0.7143em] leading-relaxed text-content-subtle">
              {t("memory.pickHint")}
            </p>
          ) : (
            categories.map((cat) => {
              const list = byCategory.get(cat) ?? [];
              return (
                <div key={cat} className="border-b border-edge/60 last:border-b-0">
                  <div className="flex items-center justify-between gap-1 px-2 pt-1.5">
                    <code className="text-[0.7143em] font-medium text-content-muted">{cat}</code>
                    <button
                      type="button"
                      title={t("memory.newFile")}
                      onClick={() => {
                        setDraft({ category: cat, name: "" });
                        setSelected(null);
                        setNotice(null);
                      }}
                      className="rounded p-0.5 text-content-subtle transition-colors hover:bg-surface-hover hover:text-content"
                    >
                      <IconPlus size={11} />
                    </button>
                  </div>
                  {list.length === 0 ? (
                    <p className="px-2 pb-1.5 text-[0.7143em] text-content-subtle">
                      {t("memory.categoryEmpty")}
                    </p>
                  ) : (
                    <div className="pb-1.5">
                      {list.map((f) => (
                        <button
                          key={f.path}
                          type="button"
                          title={f.path}
                          onClick={() => void open(f.path)}
                          className={cn(
                            "block w-full truncate px-2 py-1 text-left text-[0.7857em] transition-colors",
                            selected === f.path && draft === null
                              ? "bg-surface-hover text-content"
                              : "text-content-muted hover:bg-surface-hover/60 hover:text-content",
                          )}
                        >
                          {f.title.trim() !== "" ? f.title : basename(f.path)}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* ───────── 右栏:编辑器 / 草稿表单 / 引导语 ───────── */}
        <div className="flex min-w-0 flex-1 flex-col rounded border border-edge bg-surface">
          {draft !== null ? (
            // 新建草稿:起个名字,保存之前**不落盘**(列表里没有它)。
            <div className="flex flex-1 flex-col items-start gap-2 p-4">
              <div className="text-[0.7857em] font-medium text-content-muted">
                {t("memory.newFile")}
                <code className="ml-2 text-[0.85em] font-normal text-content-subtle">
                  {draft.category}/
                </code>
              </div>
              <Input
                type="text"
                value={draft.name}
                spellCheck={false}
                autoFocus
                placeholder={t("memory.fileNamePlaceholder")}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                className="w-64"
              />
              {!validDraftName(draft.name) && (
                <p className="text-[0.7143em] leading-relaxed text-danger">
                  {t("memory.fileNameInvalid")}
                </p>
              )}
              <div className="mt-1 flex gap-1">
                <Button
                  size="sm"
                  variant="primary"
                  disabled={!validDraftName(draft.name)}
                  onClick={() => void createDraft()}
                >
                  {t("common.save")}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setDraft(null)}>
                  {t("common.cancel")}
                </Button>
              </div>
            </div>
          ) : selected === null ? (
            <div className="flex flex-1 items-center justify-center text-[0.7857em] text-content-subtle">
              {t("memory.pickHint")}
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 border-b border-edge px-3 py-1.5">
                <code className="min-w-0 flex-1 truncate text-[0.7143em] text-content-subtle">
                  {selected}
                </code>
                {dirty && (
                  <span className="shrink-0 text-[0.7143em] text-warning">{t("memory.dirty")}</span>
                )}
                {notice !== null && (
                  <span
                    className={cn(
                      "min-w-0 shrink truncate text-[0.7143em]",
                      notice.tone === "ok" ? "text-success" : "text-danger",
                    )}
                  >
                    {notice.text}
                  </span>
                )}
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void save(selected, content)}
                  className="shrink-0 gap-1"
                >
                  <IconDeviceFloppy size={12} />
                  {t("common.save")}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setDeleteTarget(selected)}
                  className="shrink-0 gap-1"
                >
                  <IconTrash size={12} />
                  {t("common.delete")}
                </Button>
              </div>
              <div className="min-h-0 flex-1">
                <Editor
                  language="markdown"
                  theme={theme}
                  value={content}
                  onChange={(value) => setContent(value ?? "")}
                  loading={
                    <div className="p-3 text-[0.7143em] text-content-subtle">
                      {t("common.loading")}
                    </div>
                  }
                  options={{
                    minimap: { enabled: false },
                    fontSize: 13,
                    wordWrap: "on",
                    scrollBeyondLastLine: false,
                    automaticLayout: true,
                  }}
                />
              </div>
            </>
          )}
        </div>
      </div>

      {/* 删除带确认(danger):记忆文件删了就没了,不能让一个顺手点的按钮干这件事。 */}
      <ConfirmDialog
        open={deleteTarget !== null}
        danger
        title={t("memory.deleteTitle", { name: deleteTarget !== null ? basename(deleteTarget) : "" })}
        description={t("memory.deleteDesc")}
        confirmText={t("common.delete")}
        onOpenChange={(o) => {
          if (!o) setDeleteTarget(null);
        }}
        onConfirm={() => {
          const path = deleteTarget;
          setDeleteTarget(null);
          if (path !== null) void remove(path);
        }}
      />
    </section>
  );
}
