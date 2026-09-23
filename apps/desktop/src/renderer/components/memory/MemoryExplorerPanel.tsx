/**
 * **记忆**页:三节,前两节是"喂给引擎的长期信息",第三节是引擎自己那份记忆。
 *
 * ## 一、二节:记忆库(六类目录的文件管理器)
 *
 * 六类记忆目录(rules / project / preferences / experiences / failures /
 * decisions)的**文件管理器** —— 左栏分类与文件,右栏一个 Markdown 编辑器。
 *
 * ## 三节:全局指令(2026-09-20 从「上下文」页搬来的)
 *
 * 三引擎共用的常驻指令。编辑的是数据根下的事实源
 * (`<dataRoot>/context/instructions.md`),保存即物化(Claude → `~/.mcode/CLAUDE.md`;
 * Codex/Pi 走各自的会话启动组装链)。主进程的物化逻辑见 `main/lib/appContext.ts`。
 *
 * ## 四节:项目记忆(同一处搬来)
 *
 * **引擎自己那份** `MEMORY.md`(按项目一份)的编辑器。它与上面那六类
 * **不是同一批文件**:那六类是 Mcode 记忆库里的,这一份是引擎 CLI 的原生记忆。
 * 两节挨着摆是因为用户要的是"合成一页",但各自的标题里都说清了是哪个。
 *
 * 「上下文」那一页的第三节「工具占用」**没有被搬**:它是按引擎静态枚举的估算,
 * 第三方 MCP 连上之前拿不到工具清单所以只列一行 —— 用户判定它不需要,随那一页
 * 一起删了。`api.tools.usage` 那条通道还在(契约层没动),只是没了界面入口。
 *
 * ## 数据从哪来
 *
 * `memory.categories` 给类目、`memory.list` 给文件(`MemoryFileMeta`)、
 * `memory.read/save/delete` 是三个文件动作。新建的文件在**保存之前只是草稿** ——
 * 列表里没有它,右栏标着「(未保存)」;保存路径限定 `${类目}/${名字}.md`,
 * 不提供越出类目目录的写法(这里是记忆的编辑器,不是通用文件管理器)。
 *
 * ## save/delete 的失败不是异常
 *
 * 契约里这几个动作返回 `{ ok, error? }`:`ok: false` 时 `error` 是**给人看的句子**
 * —— 原样摆进顶栏,不二次加工。真异常(通道断了)才走 catch 那条路。
 *
 * ## 读不到怎么办
 *
 * 通道没就绪/读失败:一句错误小字,不弹错(同 `RunHistorySection` 的纪律)。
 * 第一二节读不到时**类目照样摆出来**(它们是契约里的常量),只由那句小字交代。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MEMORY_CATEGORIES, type MemoryFileMeta } from "@contracts/memory";
import "@renderer/lib/monacoSetup.js";
import Editor from "@monaco-editor/react";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useMonacoTheme } from "@renderer/components/ide/FileEditor.js";
import { Button, ConfirmDialog, Input } from "@renderer/components/ui/index.js";
import { IconDeviceFloppy, IconNotebook, IconPlus, IconTrash, IconLoader2 } from "@renderer/lib/icons.js";
import { PANEL_MAX_W } from "../settings/panelWidth.js";
import { PanelHeader } from "../settings/PanelHeader.js";
import { SettingsSection } from "../settings/SettingsSection.js";
import type { ContextMemoryDir } from "@contracts/ipc";

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

/** 多行文本框的样式。**从 `ContextPanel` 原样搬来的** —— 那两节搬过来之后
 *  它是唯一的用处,所以跟着走,而不是留在那个已经删掉的文件里。 */
const textareaCls =
  "min-h-[180px] w-full resize-y rounded border border-edge bg-surface px-2.5 py-2 font-mono text-[0.8571em] leading-relaxed text-content placeholder:text-content-subtle focus:border-accent focus:outline-none";

/** `updatedAt` 的短日期(列表行宽有限,精确到天足够)。同 `ContextPanel` 那份。 */
function fmtDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
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

  /* ── 全局指令(2026-09-20 从「上下文」页搬来的) ──
   *
   * 它和下面那六类记忆是**两批不同的文件**:这一节编辑的是数据根下
   * `context/instructions.md`,保存后物化到三个引擎各自的常驻指令文件
   * (见 `main/lib/appContext.ts`);下面那六类是 `memory/<类目>/*.md`。
   * 摆在同一页是因为它们是同一件事的两半(喂给引擎的长期信息),而用户
   * 要的是"记忆和上下文合成一页"。 */
  const [instructions, setInstructions] = useState("");
  const [instrLoading, setInstrLoading] = useState(true);
  const [instrSaving, setInstrSaving] = useState(false);
  const [instrError, setInstrError] = useState<string | null>(null);
  const [instrSaved, setInstrSaved] = useState(false);
  const [instrWarnings, setInstrWarnings] = useState<string[]>([]);

  /* ── 项目记忆(同一处搬来) ──
   *
   * 这是**引擎自己那份** `MEMORY.md`(按项目一份),与下面六类目录里的文件不同 ——
   * 那些是 Mcode 自己的记忆库。两者名字像,文件不是一批。 */
  const [ctxDirs, setCtxDirs] = useState<ContextMemoryDir[]>([]);
  const [ctxSelected, setCtxSelected] = useState<ContextMemoryDir | null>(null);
  const [ctxMemory, setCtxMemory] = useState("");
  const [ctxLoading, setCtxLoading] = useState(false);
  const [ctxSaving, setCtxSaving] = useState(false);
  const [ctxError, setCtxError] = useState<string | null>(null);
  const [ctxSaved, setCtxSaved] = useState(false);

  const loadContext = useCallback(async (): Promise<void> => {
    setInstrLoading(true);
    try {
      const [res, mem] = await Promise.all([api.context.get({}), api.context.memoriesList({})]);
      setInstructions(res.content);
      setCtxDirs(mem.dirs);
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

  // 列表刷新后,选中的那条可能已经没了(引擎清掉了那个项目)—— 清选中的。
  useEffect(() => {
    if (ctxSelected && !ctxDirs.some((d) => d.slug === ctxSelected.slug)) setCtxSelected(null);
  }, [ctxDirs, ctxSelected]);

  const pickCtxDir = async (dir: ContextMemoryDir): Promise<void> => {
    setCtxSelected(dir);
    setCtxError(null);
    setCtxSaved(false);
    setCtxLoading(true);
    try {
      const { content } = await api.context.memoryGet({ slug: dir.slug });
      setCtxMemory(content);
    } catch (err) {
      setCtxError((err as Error).message);
    } finally {
      setCtxLoading(false);
    }
  };

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

  const saveCtxMemory = async (): Promise<void> => {
    if (!ctxSelected) return;
    setCtxError(null);
    setCtxSaving(true);
    try {
      const res = await api.context.memorySave({ slug: ctxSelected.slug, content: ctxMemory });
      if (!res.ok) {
        setCtxError(res.error ?? t("settings.saveFailed"));
        return;
      }
      setCtxSaved(true);
      // 顺手刷新左列的「更新于」时间戳
      const { dirs: fresh } = await api.context.memoriesList({});
      setCtxDirs(fresh);
    } catch (err) {
      setCtxError((err as Error).message);
    } finally {
      setCtxSaving(false);
    }
  };

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
  /**
   * 上面那个 `dirty` 的**引用版** —— 只给"库在别处被改了"那条订阅用。
   *
   * 订阅的回调是**挂一次、跑很久**的闭包,直接读 `dirty` 会读到一个陈旧的布尔值。
   * 而这个 ref 每次渲染都跟着更新,回调里读到的永远是当下那个。
   */
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

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

      {/* ───────── 全局指令 ─────────
          2026-09-20 从「上下文」页整节搬来(那一页删了)。位置在**记忆库之下** ——
          它是"给所有会话的常驻要求",比单条记忆更靠外一层,摆在后面读起来是
          从具体到一般。 */}
      <SettingsSection
        title={t("settings.context.instructionsSection")}
        desc={t("settings.context.instructionsDesc")}
      >
        <div className="px-4 py-2.5">
          {instrError !== null && (
            <div className="mb-2 rounded border border-danger/40 bg-danger/5 px-3 py-2 text-[0.7857em] text-danger">
              {instrError}
            </div>
          )}
          {instrLoading ? (
            <div className="flex items-center justify-center gap-2 py-6 text-[0.7857em] text-content-subtle">
              <IconLoader2 size={14} className="animate-spin" />
              {t("common.loading")}
            </div>
          ) : (
            <>
              <textarea
                value={instructions}
                onChange={(e) => {
                  setInstructions(e.target.value);
                  setInstrSaved(false);
                }}
                placeholder={t("settings.context.instructionsPlaceholder")}
                className={textareaCls}
                spellCheck={false}
              />
              {instrWarnings.length > 0 && (
                <div className="mt-2 rounded border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-[0.7857em] leading-relaxed text-amber-500">
                  {instrWarnings.join("\n")}
                </div>
              )}
              <div className="mt-2 flex items-center gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void saveInstructions()}
                  disabled={instrSaving}
                >
                  {t("settings.context.save")}
                </Button>
                {instrSaved && (
                  <span className="text-[0.7857em] text-emerald-500">
                    {t("settings.context.saved")}
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      </SettingsSection>

      {/* ───────── 项目记忆 ─────────
          ⚠️ 与上面那六类**不是同一批文件**:这一节编辑的是引擎自己那份
          `MEMORY.md`(按项目一份),上面管的是 Mcode 记忆库里六个类目的文件。
          两节挨着摆是因为用户要的是"合成一页",但标题里各说各的,别混。 */}
      <SettingsSection
        title={t("settings.context.memoriesSection")}
        desc={t("settings.context.memoriesDesc")}
      >
        <div className="flex gap-3 px-4 py-2.5">
          {/* 左列:项目清单 */}
          <div className="w-56 shrink-0 space-y-0.5">
            {ctxDirs.length === 0 ? (
              <p className="px-1 py-3 text-[0.7143em] leading-relaxed text-content-subtle">
                {t("settings.context.memoriesEmpty")}
              </p>
            ) : (
              ctxDirs.map((d) => (
                <button
                  key={d.slug}
                  onClick={() => void pickCtxDir(d)}
                  className={cn(
                    "w-full rounded px-2 py-1.5 text-left transition-colors",
                    ctxSelected?.slug === d.slug
                      ? "bg-accent/10 text-content"
                      : "text-content-muted hover:bg-surface-hover",
                  )}
                >
                  <span className="block truncate text-[0.8571em]" title={d.slug}>
                    {d.label}
                  </span>
                  {d.updatedAt !== null && (
                    <span className="block text-[10px] text-content-subtle">
                      {t("settings.context.updatedAt")} {fmtDate(d.updatedAt)}
                    </span>
                  )}
                </button>
              ))
            )}
          </div>
          {/* 右列:MEMORY.md 编辑器 */}
          <div className="min-w-0 flex-1">
            {!ctxSelected ? (
              <p className="py-3 text-[0.7857em] text-content-subtle">
                {t("settings.context.noMemorySelected")}
              </p>
            ) : ctxLoading ? (
              <div className="flex items-center justify-center gap-2 py-6 text-[0.7857em] text-content-subtle">
                <IconLoader2 size={14} className="animate-spin" />
                {t("common.loading")}
              </div>
            ) : (
              <>
                <textarea
                  value={ctxMemory}
                  onChange={(e) => {
                    setCtxMemory(e.target.value);
                    setCtxSaved(false);
                  }}
                  className={cn(textareaCls, "min-h-[220px]")}
                  spellCheck={false}
                />
                {ctxError !== null && (
                  <p className="mt-1 text-[0.7857em] text-danger">{ctxError}</p>
                )}
                <div className="mt-2 flex items-center gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => void saveCtxMemory()}
                    disabled={ctxSaving}
                  >
                    {t("settings.context.saveMemory")}
                  </Button>
                  {ctxSaved && (
                    <span className="text-[0.7857em] text-emerald-500">
                      {t("settings.context.saved")}
                    </span>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </SettingsSection>
    </section>
  );
}
