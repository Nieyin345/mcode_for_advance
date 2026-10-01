import { MemoryTransferPanel } from "./MemoryTransferPanel.js";
/** Settings surface for the scoped MCode memory library and global instructions.
 * Legacy CLI MEMORY.md files are available only through the explicit import flow. */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { MEMORY_CATEGORIES, type MemoryFileMeta } from "@contracts/memory";
import "@renderer/lib/monacoSetup.js";
import Editor from "@monaco-editor/react";
import { api } from "@renderer/lib/api.js";
import { useRpc } from "@renderer/hooks/useRpc.js";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useMonacoTheme } from "@renderer/components/ide/FileEditor.js";
import { Button, ConfirmDialog, ErrorNote, Input } from "@renderer/components/ui/index.js";
import { IconDeviceFloppy, IconNotebook, IconPlus, IconTrash } from "@renderer/lib/icons.js";
import { PANEL_MAX_W } from "../settings/panelWidth.js";
import { PanelHeader } from "../settings/PanelHeader.js";
import { SettingsSection } from "../settings/SettingsSection.js";
import { MemoryMaintenanceReview } from "./MemoryMaintenanceReview.js";

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

const textareaCls =
  "min-h-[180px] w-full resize-y rounded border border-edge bg-surface px-2.5 py-2 font-mono text-[0.8571em] leading-relaxed text-content placeholder:text-content-subtle focus:border-accent focus:outline-none";

/** Renderer-lifetime drafts. Keep the original revision for conflict detection;
 * navigation must never silently turn an unsaved edit into a fresh disk read. */
type RetainedMemoryDraft = { content: string; savedContent: string; revision: string | null };
let memoryDrafts = new Map<string, RetainedMemoryDraft>();
const memoryDraftListeners = new Set<() => void>();
const pendingMemorySaves = new Set<string>();
const getMemoryDrafts = () => memoryDrafts;
const subscribeMemoryDrafts = (listener: () => void) => { memoryDraftListeners.add(listener); return () => { memoryDraftListeners.delete(listener); }; };
function rememberMemoryDraft(path: string, draft: RetainedMemoryDraft | null) {
  memoryDrafts = new Map(memoryDrafts);
  if (draft) memoryDrafts.set(path, draft); else memoryDrafts.delete(path);
  for (const listener of memoryDraftListeners) listener();
}

export function MemoryExplorerPanel() {
  const { t } = useI18n();
  const theme = useMonacoTheme();
  const [scope, setScope] = useState("");
  const projects = useRpc(() => api.memory.manage({ action: "list" }), []);
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
  const [deleteTarget, setDeleteTarget] = useState<{ path: string; revision: string } | null>(null);
  const [revision, setRevision] = useState<string | null>(null);
  const retainedDrafts = useSyncExternalStore(subscribeMemoryDrafts, getMemoryDrafts);
  // A save begun in a previous mount can finish while this editor is open.
  // Only update its baseline/revision; newer typed text remains untouched.
  useEffect(() => {
    const kept = selected === null ? undefined : retainedDrafts.get(selected);
    if (kept) { setSavedContent(kept.savedContent); setRevision(kept.revision); }
  }, [retainedDrafts, selected]);
  const editEpoch = useRef(0);
  const [readRequest, setReadRequest] = useState<{ path: string; epoch: number } | null>(null);
  const [mutating, setMutating] = useState(false);
  const mutationPending = useRef(false);
  /** 只在用户主动打开时扫描；不会定时或后台自动清理。 */
  const [reviewOpen, setReviewOpen] = useState(false);
  const [view, setView] = useState<"library" | "instructions" | "import">("library");

  /* Global instructions are always-on requirements, not remembered facts. */
  const [instructions, setInstructions] = useState("");
  const [instrLoading, setInstrLoading] = useState(true);
  const [instrSaving, setInstrSaving] = useState(false);
  const [instrError, setInstrError] = useState<string | null>(null);
  const [instrSaved, setInstrSaved] = useState(false);
  const [instrWarnings, setInstrWarnings] = useState<string[]>([]);

  const loadContext = useCallback(async (): Promise<void> => {
    setInstrLoading(true);
    try {
      const res = await api.context.get({});
      setInstructions(res.content);
      setInstrError(null);
    } catch (err) {
      setInstrError((err as Error).message);
    } finally {
      setInstrLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadContext();
  }, [loadContext]);

  const saveInstructions = async (): Promise<void> => {
    setInstrError(null);
    setInstrSaving(true);
    try {
      const res = await api.context.save({ content: instructions });
      if (!res.ok) {
        setInstrError(res.error ?? t("settings.saveFailed"));
        return;
      }
      setInstrWarnings(res.warnings ?? []);
      setInstrSaved(true);
    } catch (err) {
      setInstrError((err as Error).message);
    } finally {
      setInstrSaving(false);
    }
  };

  const listQuery = useRpc(async () => {
    const [cats, res] = await Promise.all([api.memory.categories(), api.memory.list({})]);
    return { cats, files: res.files };
  }, [], { toastOnError: false });
  const load = listQuery.refetch;
  useEffect(() => {
    if (listQuery.data) { setCategories(listQuery.data.cats); setFiles(listQuery.data.files); setLoadError(null); }
    if (listQuery.error) { setCategories([...MEMORY_CATEGORIES]); setLoadError(listQuery.error.message); }
  }, [listQuery.data, listQuery.error]);

  const appliedRead = useRef<unknown>(undefined);
  const readQuery = useRpc(async () => {
    const request = readRequest!;
    return { ...await api.memory.read({ path: request.path }), ...request };
  }, [readRequest], { enabled: readRequest !== null, toastOnError: false });
  useEffect(() => {
    const result = readQuery.data;
    if (result && appliedRead.current !== result && result.epoch === editEpoch.current && !readQuery.loading && !readQuery.error) {
      appliedRead.current = result;
      setContent(result.content); setSavedContent(result.content); setRevision(result.revision);
    }
    if (readRequest?.epoch === editEpoch.current && readQuery.error && !readQuery.loading) {
      setNotice({ tone: "error", text: t("memory.readFailed", { error: readQuery.error.message }) });
    }
  }, [readQuery.data, readQuery.loading, readQuery.error, readRequest, t]);

  /**
   * 记忆库在**别处**被改了 → 重拉列表。
   *
   * 这个面板不是唯一的写者:AI 通过 `memory_write` / `memory_forget` 那两个 MCP 工具
   * 直接写数据根下的 `.md`(`main/mcp/memoryServer.ts`)。少了这条订阅,模型刚记下
   * 一条、用户切过来却看不见 —— 他会以为"它根本没记住",而这功能的价值恰恰在于
   * "我不用再说第二遍"。
   *
   * 复用 `library:changed` 那条通道(主进程那边 `main/memory/broadcast.ts` 解释了
   * 为什么不新开一条):它报的就是"数据根下的内容变了"。
   *
   * ⚠️ **重拉前先确认用户没在编辑。** 这个面板的右栏是一个带草稿的编辑器
   * (`dirty` 那条判断),而 `load()` 会重设 `files`/`categories` —— 用户在左栏选中的
   * 那一条如果正好被 AI 删掉了,`selected` 就指向一个不存在的路径。所以:
   * 脏草稿时**跳过这次刷新**,等他自己保存/切走之后自然会重拉。
   */
  useEffect(() => {
    const off = window.api?.on?.libraryChanged?.(() => {
      if (dirtyRef.current) return;
      void load();
    });
    return off;
  }, [load]);

  /** A selection epoch prevents late reads/mutations from replacing another file's draft. */
  const open = useCallback((path: string): void => {
    const epoch = ++editEpoch.current;
    setDraft(null); setSelected(path); setNotice(null);
    const kept = memoryDrafts.get(path);
    if (kept && kept.content !== kept.savedContent) {
      setContent(kept.content); setSavedContent(kept.savedContent); setRevision(kept.revision);
      setReadRequest(null);
    } else {
      if (kept) rememberMemoryDraft(path, null);
      setContent(""); setSavedContent(""); setRevision(null);
      setReadRequest({ path, epoch });
    }
  }, []);

  const save = useCallback(async (path: string, body: string, expectedRevision: string | null, pinned?: boolean): Promise<string | null> => {
    if (mutationPending.current || pendingMemorySaves.has(path)) return null;
    pendingMemorySaves.add(path);
    mutationPending.current = true; setMutating(true);
    const epoch = editEpoch.current;
    try {
      const res = await api.memory.save({ path, content: body, expectedRevision, ...(pinned === undefined ? {} : { pinned }) });
      if (res.ok && res.revision) {
        const kept = memoryDrafts.get(path);
        if (kept) rememberMemoryDraft(path, { ...kept, savedContent: body, revision: res.revision });
        if (editEpoch.current === epoch) {
          setSavedContent(body); setRevision(res.revision);
          setNotice({ tone: "ok", text: t("memory.saved") });
        }
        void load();
        return res.revision;
      }
      if (editEpoch.current === epoch) setNotice({ tone: "error", text: res.code === "conflict" ? t("memory.conflict") : res.error ?? t("common.error") });
      return null;
    } catch (err) {
      if (editEpoch.current === epoch) setNotice({ tone: "error", text: t("memory.saveFailed", { error: (err as Error).message }) });
      return null;
    } finally {
      pendingMemorySaves.delete(path);
      mutationPending.current = false; setMutating(false);
      const kept = memoryDrafts.get(path);
      if (kept) rememberMemoryDraft(path, kept);
    }
  }, [load, t]);

  const createDraft = useCallback(async (): Promise<void> => {
    if (draft === null || !validDraftName(draft.name)) return;
    if (!scope) return;
    const path = `${scope}/${draft.category}/${draft.name.trim()}.md`;
    const epoch = editEpoch.current;
    const created = await save(path, "", null); // Explicit create-only, even for a same-name collision.
    if (created === null || editEpoch.current !== epoch) return;
    setDraft(null); setContent(""); setSavedContent(""); setSelected(path); setRevision(created);
  }, [scope, draft, save]);

  const remove = useCallback(async (target: { path: string; revision: string }): Promise<void> => {
    if (mutationPending.current) return;
    mutationPending.current = true; setMutating(true);
    const epoch = editEpoch.current;
    try {
      // The revision was captured BEFORE confirmation, never re-read at delete time.
      const res = await api.memory.delete({ path: target.path, expectedRevision: target.revision });
      if (!res.ok) {
        if (editEpoch.current === epoch) setNotice({ tone: "error", text: res.code === "conflict" ? t("memory.conflict") : res.error ?? t("common.error") });
        return;
      }
      rememberMemoryDraft(target.path, null);
      if (editEpoch.current === epoch && selected === target.path) {
        editEpoch.current++;
        setReadRequest(null); setSelected(null); setRevision(null); setContent(""); setSavedContent(""); setNotice(null);
      }
      void load();
    } catch (err) {
      if (editEpoch.current === epoch) setNotice({ tone: "error", text: t("memory.deleteFailed", { error: (err as Error).message }) });
    } finally { mutationPending.current = false; setMutating(false); }
  }, [selected, load, t]);

  /** 按类目归组的文件(`category` 是主进程给的,目录即类目)。 */
  const byCategory = useMemo(() => {
    const map = new Map<string, MemoryFileMeta[]>();
    for (const f of files) {
      if (scope && !f.path.startsWith(scope + "/")) continue;
      const bucket = map.get(f.category);
      if (bucket) bucket.push(f);
      else map.set(f.category, [f]);
    }
    return map;
  }, [files, scope]);

  const dirty = selected !== null && content !== savedContent;
  /** 所有保留着未保存草稿的文件 —— 草稿跨文件切换/面板卸载保留，整理面板必须一并避开。 */
  const unsavedDraftPaths = useMemo(
    () => [...retainedDrafts].filter(([, d]) => d.content !== d.savedContent).map(([path]) => path),
    [retainedDrafts],
  );
  /**
   * 上面那个 `dirty` 的**引用版** —— 只给"库在别处被改了"那条订阅用。
   *
   * 订阅的回调是**挂一次、跑很久**的闭包,直接读 `dirty` 会读到一个陈旧的布尔值。
   * 而这个 ref 每次渲染都跟着更新,回调里读到的永远是当下那个。
   */
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const navigation = (
    <div className={`mx-auto my-3 flex w-full flex-wrap gap-1 rounded-lg bg-surface-subtle p-1 ${PANEL_MAX_W.form}`}>
      {(["library", "instructions", "import"] as const).map((item) => (
        <Button key={item} size="sm" variant={view === item ? "secondary" : "ghost"} onClick={() => setView(item)}>
          {t(`memory.tab.${item}`)}
        </Button>
      ))}
    </div>
  );

  // 项目初始化已移到独立的设置页「项目初始化」(settings/ProjectInitPanel)。
  if (view === "instructions") return (
    <section className={`mx-auto h-full w-full overflow-y-auto ${PANEL_MAX_W.form}`}>
      <PanelHeader title={t("settings.nav.memory")} icon={IconNotebook} />
      {navigation}
      <SettingsSection title={t("settings.context.instructionsSection")} desc={t("settings.context.instructionsDesc")}>
        <div className="px-4 py-3">
          {instrError !== null && <ErrorNote className="mb-2">{instrError}</ErrorNote>}
          {instrLoading ? <p className="py-6 text-sm text-content-subtle">{t("common.loading")}</p> : <>
            <textarea value={instructions} onChange={(e) => { setInstructions(e.target.value); setInstrSaved(false); }}
              placeholder={t("settings.context.instructionsPlaceholder")} className={textareaCls} spellCheck={false} />
            {instrWarnings.length > 0 && <div className="mt-2 rounded border border-warning/40 bg-warning/5 px-3 py-2 text-sm text-warning">{instrWarnings.join("\n")}</div>}
            <div className="mt-3 flex items-center gap-2">
              <Button variant="primary" size="sm" onClick={() => void saveInstructions()} disabled={instrSaving}>{t("settings.context.save")}</Button>
              {instrSaved && <span className="text-sm text-success">{t("settings.context.saved")}</span>}
            </div>
          </>}
        </div>
      </SettingsSection>
    </section>
  );

  if (view === "import") return (
    <section className={`mx-auto h-full w-full overflow-y-auto ${PANEL_MAX_W.form}`}>
      <PanelHeader title={t("settings.nav.memory")} icon={IconNotebook} />
      {navigation}
      <MemoryTransferPanel />
    </section>
  );

  // 与另外两个 tab 同一档宽度(form)。这里原来写的是 canvas(1152px),切到
  // 「全局指令 / 导入与恢复」(form,768px)时整页宽度跳 384px —— 用户报的
  // 「第一个 tab 宽度和其他的不一致」就是它。panelWidth.ts 的规矩本来就是:
  // canvas 只给**正文里有可拖画布**的页(工作流/自动化,那有放不下节点的硬
  // 计算),记忆库是列表+编辑器,没有画布,归 form 档。(2026-09-26)
  return (
    <section className={`mx-auto flex h-full w-full ${PANEL_MAX_W.form} flex-col`}>
      <PanelHeader title={t("settings.nav.memory")} icon={IconNotebook} action={
        <Button size="sm" variant="secondary" onClick={() => setReviewOpen((open) => !open)}>
          {t(reviewOpen ? "memory.reviewClose" : "memory.reviewOpen")}
        </Button>
      } />
      {navigation}
      <div className="mb-3 rounded border border-edge bg-surface-subtle/50 p-2.5 text-xs leading-relaxed text-content-muted">
        {t("memory.scopeBanner")}
      </div>
      <label className="mb-3 flex items-center gap-2 text-sm text-content-muted">{t("memory.scope")}
        <select value={scope} onChange={e => setScope(e.target.value)} className="rounded border border-edge bg-surface px-2 py-1.5 text-content">
          <option value="">{t("memory.allScopes")}</option>
          <option value="global">{t("memory.globalScope")}</option>
          {projects.data?.projects?.map(p => <option key={p.id} value={`projects/${p.id}`}>{p.name}</option>)}
        </select>
      </label>
      {reviewOpen && <MemoryMaintenanceReview
        dirty={dirty || draft !== null}
        unsavedPaths={unsavedDraftPaths}
        onOpen={(path) => { void open(path); }}
        onDeleted={(paths) => {
          if (selected !== null && paths.includes(selected)) {
            setSelected(null);
            setContent("");
            setSavedContent("");
          }
          void load();
        }}
      />}

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
                        editEpoch.current++; setReadRequest(null); setRevision(null);
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
                  {scope || t("memory.destination")}/{draft.category}/
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
              {notice?.tone === "error" && <ErrorNote>{notice.text}</ErrorNote>}
              <div className="mt-1 flex gap-1">
                <Button
                  size="sm"
                  variant="primary"
                  disabled={mutating || !scope || !validDraftName(draft.name)}
                  onClick={() => void createDraft()}
                >
                  {t("common.save")}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => { editEpoch.current++; setDraft(null); }}>
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
                <Button size="sm" disabled={mutating || dirty || !revision} onClick={() => {
                  if (!revision) return;
                  const epoch = editEpoch.current;
                  void save(selected, content, revision, !files.find(f => f.path === selected)?.pinned).then(next => { if (next && editEpoch.current === epoch) setRevision(next); });
                }}>{files.find(f => f.path === selected)?.pinned ? t("memory.unpin") : t("memory.pin")}</Button>
                {dirty && (
                  <span className="shrink-0 text-[0.7143em] text-warning">{t("memory.dirty")}</span>
                )}
                {notice !== null && (
                  <span
                    title={notice.text}
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
                  disabled={mutating || revision === null || pendingMemorySaves.has(selected)}
                  onClick={() => void save(selected, content, revision)}
                  className="shrink-0 gap-1"
                >
                  <IconDeviceFloppy size={12} />
                  {t("common.save")}
                </Button>
                <Button size="sm" disabled={!dirty || mutating || pendingMemorySaves.has(selected)} onClick={() => {
                  rememberMemoryDraft(selected, null);
                  open(selected);
                }}>{t("common.discardChanges")}</Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={mutating || revision === null || pendingMemorySaves.has(selected)}
                  onClick={() => { if (revision) setDeleteTarget({ path: selected, revision }); }}
                  className="shrink-0 gap-1"
                >
                  <IconTrash size={12} />
                  {t("common.delete")}
                </Button>
              </div>
              <div className="min-h-0 flex-1">
                <Editor
                  key={selected}
                  language="markdown"
                  theme={theme}
                  value={content}
                  onChange={(value) => {
                    const next = value ?? "";
                    setContent(next);
                    const current = memoryDrafts.get(selected);
                    rememberMemoryDraft(selected, { content: next, savedContent: current?.savedContent ?? savedContent, revision: current?.revision ?? revision });
                  }}
                  loading={
                    <div className="p-3 text-[0.7143em] text-content-subtle">
                      {t("common.loading")}
                    </div>
                  }
                  options={{
                    readOnly: revision === null,
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
        title={t("memory.deleteTitle", { name: deleteTarget !== null ? basename(deleteTarget.path) : "" })}
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
