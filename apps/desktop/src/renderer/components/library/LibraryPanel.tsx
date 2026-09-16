/**
 * 右栏的文献库面板。
 *
 * ## 为什么是「右栏标签」而不是全屏页面
 *
 * 最初做成全屏覆盖页,把对话整个挤掉了 —— 那不对。Mcode 本来的交互是:
 * **左栏选东西 → 主区继续干活 → 内容显示在右边**(点项目时右边是文件树)。
 * 文献库必须服从同一套模式,所以它是一个 `RightPanelTab`,和 files / git /
 * browser 并列。主区的对话/编辑器完全不受影响。
 *
 * ## 窄面板的布局取舍
 *
 * 右栏只有 ~400px,放不下"列表 + 详情"并排。所以做成**单栏推进**:
 * 列表 →(点某篇)→ 详情 →(返回)→ 列表。检索与导入同理,各自占满整栏。
 * 这是窄栏的常规做法,也避免了在小宽度里塞三栏的拥挤。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Menu } from "@base-ui/react/menu";
import type { LibraryItem, DownloadJob, PdfState, LibraryKind } from "@contracts/library";
import { derivePdfState } from "@contracts/library";
import type { CitationStyle } from "@contracts/citation";
import { LIBRARY_KIND_LABEL } from "@renderer/lib/libraryLabels.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import type { MessageId } from "@renderer/lib/i18n/core.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useLibraryStore } from "@renderer/stores/libraryStore.js";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import {
  IconArrowLeft,
  IconBook,
  IconSearch,
  IconShare,
  IconUpload,
  IconX,
} from "@renderer/lib/icons.js";
import { ItemList } from "./ItemList.js";
import { ItemDetail } from "./ItemDetail.js";
import { MarkdownPreview } from "./MarkdownPreview.js";
import { PdfPreview } from "./PdfPreview.js";
import { NoteEditor } from "./NoteEditor.js";
import { SearchPanel } from "./SearchPanel.js";
import { ImportBar } from "./ImportPanel.js";

/** 详情屏的标签。取值域与 `libraryStore.detailTab` 一致。 */
type DetailTab = "meta" | "preview" | "pdf" | "edit";

/** 面板当前展示哪一屏。窄栏一次只显示一屏。 */
type Screen = { kind: "list" } | { kind: "detail" } | { kind: "search" };
type StatusFilter = "all" | "missingPdf" | "needsLogin";

/** 导出菜单里三个格式的文案 id。写成显式映射而不是 `` `library.export.${style}` ``:
 *  后者靠模板字面量类型去凑 MessageId,改一个键名就会在别处静默失配。 */

const EXPORT_LABEL: Record<CitationStyle, MessageId> = {
  bibtex: "library.export.bibtex",
  gb7714: "library.export.gb7714",
  apa: "library.export.apa",
};

export function LibraryPanel() {
  const { t } = useI18n();
  const activeCollectionId = useLibraryStore((s) => s.activeCollectionId);
  const activeKind = useLibraryStore((s) => s.activeKind);
  const collections = useLibraryStore((s) => s.collections);
  const loadCollections = useLibraryStore((s) => s.loadCollections);
  const setActiveCollection = useLibraryStore((s) => s.setActiveCollection);
  const setRightPanelTab = useSessionStore((s) => s.setRightPanelTab);
  const refreshItems = useLibraryStore((s) => s.refreshItems);

  const [items, setItems] = useState<LibraryItem[]>([]);
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [screen, setScreen] = useState<Screen>({ kind: "list" });
  // 选中的那一篇放在 store 里,不在组件内。左栏的文献列表点一下就写这个字段,
  // 面板跟着切到详情 —— 状态只有一份,两边不会各说各话。
  const activeId = useLibraryStore((s) => s.activeItemId);
  const setActiveId = useLibraryStore((s) => s.setActiveItem);
  const detailTab = useLibraryStore((s) => s.detailTab);
  const setDetailTab = useLibraryStore((s) => s.setDetailTab);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [busy, setBusy] = useState(false);
  /** 导入条是否展开 —— 内嵌在列表上方,不再是一个独立整屏。 */
  const [importOpen, setImportOpen] = useState(false);
  /** 导入 PDF 后是否立刻转录。**已经有现成 md 的人要能关掉它**,否则白花一次额度。 */
  const [autoConvert, setAutoConvert] = useState(true);
  /** 有 PDF 正被拖到面板上(只用于给视觉反馈)。 */
  const [dragOver, setDragOver] = useState(false);
  /** 拖入导入的结果回报。 */
  const [dropMsg, setDropMsg] = useState<string | null>(null);
  /** 导出引用的结果回报 —— 成功要说清导了多少条、落在哪个文件。 */
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  /** 上一次导出的格式。「打开所在文件夹」那条路要重放同一个格式:
   *  主进程的 reveal 是挂在导出上的(它不接受任意路径),所以只能重导一次 ——
   *  同名同内容,覆盖写,结果一致。用错格式的话会凭空多出一个 .bib 文件。 */
  const [lastExportStyle, setLastExportStyle] = useState<CitationStyle>("bibtex");

  const activeCollection = collections.find((c) => c.id === activeCollectionId) ?? null;

  const refresh = useCallback(async () => {
    const [listRes, jobRes] = await Promise.all([
      api.library.list({
        collectionId: activeCollectionId ?? undefined,
        // 没有选中分类时按**当前这个库**列(论文库的「全部」不该混进教材和笔记)
        kind: activeKind,
        query: query.trim() || undefined,
        limit: 500,
      }),
      api.library.jobs(),
    ]);
    setItems(listRes.items);
    setJobs(jobRes.jobs);
    setSelectedIds((prev) => prev.filter((id) => listRes.items.some((i) => i.id === id)));
    // 选中的那篇可能已经不在这个库里了(换了库、被移除)—— 清掉,别停在幽灵条目上
    const curItem = useLibraryStore.getState().activeItemId;
    if (curItem && !listRes.items.some((i) => i.id === curItem)) setActiveId(null);
  }, [activeCollectionId, activeKind, query]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * 换库 / 换分类时把筛选条件清掉。
   *
   * 不清的话,上一处视图留下的筛选会**静默**把新视图的东西全挡掉 —— 例如 PDF 状态芯片
   * 停在「未下载 PDF」时切到教材库,而有 PDF 的教材就被滤没了,界面上只剩一个空列表,
   * 看起来像"我的东西不见了"(用户已经报过好几次这类)。
   */
  useEffect(() => {
    setStatus("all");
    setQuery("");
    setSelectedIds([]);
  }, [activeKind, activeCollectionId]);

  // 左栏的文献列表点了某一篇 → 面板跟着切到详情。选中态在 store 里,
  // 所以这里是「跟随」而不是「各存一份」。
  useEffect(() => {
    if (activeId) setScreen({ kind: "detail" });
  }, [activeId]);

  useEffect(() => {
    void loadCollections();
    // 文献检索的固定条件也在这里读一次 —— 它和分类树一样属于"应用起来就该就位"的
    // 状态,而且筛选条可能在用户从没打开过这个面板时就显示了。
    void useLibraryStore.getState().loadSearchPrefs();
  }, [loadCollections]);

  // 下载状态推送:终态时重拉,拿回真实 pdfPath
  useEffect(() => {
    const off = window.api?.on?.libraryJobChanged?.((msg) => {
      setJobs((prev) => [
        { id: "", itemId: msg.itemId, status: msg.status, attempts: 0, error: msg.error,
          createdAt: 0, updatedAt: Date.now() },
        ...prev.filter((j) => j.itemId !== msg.itemId),
      ]);
      if (msg.status === "done") void refresh();
    });
    return off;
  }, [refresh]);

  /**
   * 库的内容变了 → 重拉这一屏。
   *
   * **左栏的操作必须立刻反映到右栏**,而两者是两个组件、各有一份列表(这一屏的
   * `items` 是它自己的 state,不是 store)。少了这条订阅,用户在左栏改名/删除、
   * 或者 AI 走 MCP 工具改了元数据,右栏会一直显示旧的那一份 —— 用户的原话是
   * 「左边框的操作要和右边的预览要实时同步」。
   *
   * 主进程在每次改动后都会广播 `library:changed`(见 `library/trash.ts` 与
   * `ipc/library.ts`),所以这里只需要重新拉一次;`refresh` 是 useCallback,
   * 依赖变了它会自己重订阅。
   */
  useEffect(() => {
    const off = window.api?.on?.libraryChanged?.(() => void refresh());
    return off;
  }, [refresh]);

  const jobByItem = useMemo(() => {
    const m = new Map<string, DownloadJob>();
    for (const j of jobs) if (!m.has(j.itemId)) m.set(j.itemId, j);
    return m;
  }, [jobs]);

  const pdfStateOf = useCallback(
    (item: LibraryItem): PdfState => derivePdfState(item, jobByItem.get(item.id) ?? null),
    [jobByItem],
  );

  const visibleItems = useMemo(() => {
    if (status === "all") return items;
    const want = status === "missingPdf" ? "none" : "needs_login";
    return items.filter((i) => pdfStateOf(i) === want);
  }, [items, status, pdfStateOf]);

  /** 被筛选条件挡住、没显示出来的条数 —— 用它把"空列表"和"被挡住"区分开。 */
  const hiddenByFilter = items.length - visibleItems.length;

  const needsLoginCount = useMemo(
    () => items.filter((i) => pdfStateOf(i) === "needs_login").length,
    [items, pdfStateOf],
  );

  const activeItem = items.find((i) => i.id === activeId) ?? null;

  /**
   * 详情页的标签,按库分档(见文件顶部对三档的说明)。
   *
   * `detailTab` 存在 store 里(左栏右键"预览原文"要能远程切页),所以它可能是**上一个
   * 条目**留下的值 —— 比如刚看完论文(PDF 页)再点开一篇笔记,PDF 这一页不在笔记的
   * 档里。这里做一次回退,不合法就落到本档的第一页。
   */
  const tabs: readonly DetailTab[] = useMemo(() => {
    if (!activeItem) return ["meta"];
    const base: readonly DetailTab[] =
      activeItem.kind === "note" ? ["edit", "preview"] : ["meta", "preview", "pdf"];
    return base.filter((tab) => tab !== "pdf" || Boolean(activeItem.pdfPath));
  }, [activeItem]);
  const shownTab: DetailTab = tabs.includes(detailTab) ? detailTab : (tabs[0] ?? "meta");

  const handleDownload = useCallback(async (ids: string[], force = false) => {
    if (ids.length === 0) return;
    setBusy(true);
    try {
      const res = await api.library.download({ ids, force });
      setJobs(res.jobs);
    } finally {
      setBusy(false);
    }
  }, []);

  /**
   * 导出引用格式。
   *
   * 范围是**当前正在看的库**(没选库就是全库)—— 和面板上显示的列表范围一致,
   * 所见即所导。落盘位置由主进程决定(库根的 `exports/`),渲染端不拼路径。
   */
  const runExport = useCallback(
    async (style: CitationStyle, reveal = false) => {
      setBusy(true);
      setExportMsg(null);
      if (!reveal) setLastExportStyle(style);
      try {
        const res = await api.library.exportCitations({
          style,
          collectionId: activeCollectionId ?? undefined,
          reveal,
        });
        if (!res.ok) {
          setExportMsg(res.error ?? t("library.export.failed"));
          return;
        }
        // reveal 那一步失败时 ok 仍为 true —— 分开说,别让用户以为导出也失败了
        setExportMsg(
          res.error
            ? t("library.export.revealFailed", { msg: res.error })
            : t("library.export.done", { n: res.count, path: res.path }),
        );
      } catch (err) {
        setExportMsg((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [activeCollectionId, t],
  );

  const handleRemove = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return;
    // 这是**真正的删除**(数据库行 + 磁盘上的 PDF / Markdown),没有回收站兜底 ——
    // 所以必须确认。只是不想让它们待在当前分组的话,走右键的「从当前文献库移除」,
    // 那条会把文献收进回收站。
    if (!window.confirm(t("library.action.removeConfirm", { n: ids.length }))) return;
    setBusy(true);
    try {
      // `deleteFiles: true` **不能漏** —— 契约里这个开关默认 false(只删记录),漏掉的
      // 后果是界面上条目消失了、PDF 和 Markdown 却永远躺在磁盘上,而且再也认不出是
      // 谁的。确认框里明明白白写着文件也会被删,行为就得跟上。
      const res = await api.library.deleteItems({ ids, deleteFiles: true });
      setItems(res.items);
      setSelectedIds([]);
      setActiveId(null);
      await loadCollections();
      await refreshItems();
    } finally {
      setBusy(false);
    }
  }, [loadCollections, refreshItems, t]);

  /**
   * 从资源管理器拖 PDF 进来就导入。
   *
   * 路径只能靠 preload 的 `getPathForFile` —— **Electron 32 起 `File.path` 被移除了**。
   * 非 PDF 直接忽略:往面板上拖一个文件夹不该报错,只是没反应。
   */
  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => window.api?.getPathForFile?.(f) ?? "")
      .filter((p) => p.toLowerCase().endsWith(".pdf"));
    if (paths.length === 0) return;
    setBusy(true);
    setDropMsg(null);
    try {
      const res = await api.library.importFiles({
        paths,
        collectionIds: activeCollectionId ? [activeCollectionId] : undefined,
        // 拖进来的 PDF 归**当前正在看的那个库**(在教材标签下拖,就该进教材库),
        // 转录与否跟导入条上那个勾选保持一致 —— 两处行为不一样会让人以为丢文件了
        kind: activeKind,
        convert: autoConvert,
      });
      const parts = [t("library.import.pdfResult", { added: res.added, skipped: res.skipped })];
      if (res.converted.failed > 0) {
        parts.push(t("library.import.convertFailed", { n: res.converted.failed }));
      }
      if (res.errors.length > 0) parts.push(t("library.import.pdfErrors", { n: res.errors.length }));
      setDropMsg(parts.join(" · "));
      await refresh();
      await loadCollections();
      await refreshItems();
    } finally {
      setBusy(false);
    }
  };

  /** 拖入时覆盖在列表上的提示 —— 不然用户不知道松手会发生什么。 */
  const dropOverlay = dragOver && (
    <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-md border-2 border-dashed border-accent bg-surface/90">
      <span className="text-xs font-medium text-accent">{t("library.import.dropHere")}</span>
    </div>
  );

  // ── 检索 / 导入(占满整栏) ──
  if (screen.kind === "search") {
    return (
      <SearchPanel
        onClose={() => setScreen({ kind: "list" })}
        collectionId={activeCollectionId}
        onAdded={async () => {
          await refresh();
          await loadCollections();
          // 左栏那份缓存也要跟上 —— 否则新入库的文献要等下次展开才出现在树里
          await refreshItems();
        }}
      />
    );
  }
  // ── 详情(占满整栏,带返回) ──
  if (screen.kind === "detail" && activeItem) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-edge px-3 py-2">
          <button
            onClick={() => setScreen({ kind: "list" })}
            className="shrink-0 rounded p-1 text-content-muted hover:bg-surface-hover hover:text-content"
          >
            <IconArrowLeft size={14} />
          </button>
          {/* 详情 / 原文 / PDF —— 三页并排放在同一屏里。用户看一篇文献就是在这三者
              之间来回切(看引用格式 → 翻原文核对 → 看 PDF 原图),所以不做成三个入口。
              PDF 那一页只在真的有 PDF 时出现(笔记库的条目就没有)。 */}
          <div className="flex min-w-0 flex-1 items-center gap-0.5">
            {tabs.map((tab) => (
                <button
                  key={tab}
                  onClick={() => setDetailTab(tab)}
                  className={cn(
                    "rounded px-1.5 py-1 text-xs transition-colors",
                    detailTab === tab
                      ? "bg-surface-hover font-medium text-content"
                      : "text-content-subtle hover:bg-surface-hover/60 hover:text-content",
                  )}
                >
                  {tab === "meta"
                    ? // 教材那一页里只剩"PDF 状态 + 转换 + 笔记",叫元数据就不准了
                      activeItem.kind === "textbook"
                      ? t("library.detail.overview")
                      : t("library.detail.meta")
                    : tab === "preview"
                      ? t("library.detail.preview")
                      : tab === "pdf"
                        ? t("library.detail.pdf")
                        : t("library.note.edit")}
                </button>
              ))}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          {shownTab === "edit" && activeItem.kind === "note" ? (
            <NoteEditor item={activeItem} onChanged={() => void refresh()} />
          ) : shownTab === "pdf" && activeItem.pdfPath ? (
            <PdfPreview item={activeItem} />
          ) : shownTab === "preview" ? (
            <MarkdownPreview item={activeItem} />
          ) : (
            <ItemDetail
              item={activeItem}
              job={jobByItem.get(activeItem.id) ?? null}
              pdfState={pdfStateOf(activeItem)}
              onDownload={(id, force) => void handleDownload([id], force)}
              onChanged={() => void refresh()}
            />
          )}
        </div>
      </div>
    );
  }

  // ── 列表(默认屏) ──
  const chips: Array<{ key: StatusFilter; label: string; count?: number }> = [
    { key: "all", label: t("library.view.all") },
    { key: "missingPdf", label: t("library.view.missingPdf") },
    { key: "needsLogin", label: t("library.view.needsLogin"), count: needsLoginCount },
  ];

  return (
    <div
      className={cn("relative flex h-full flex-col", dragOver && "ring-2 ring-inset ring-accent")}
      onDragOver={(e) => {
        // 只对「拖进来的是文件」给反馈 —— 应用内部拖拽(从文件树拖会话之类)不该亮
        if (!Array.from(e.dataTransfer.types).includes("Files")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        // 在子元素之间移动也会触发 dragleave —— 只有真正离开面板才熄灭
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDragOver(false);
      }}
      onDrop={(e) => void handleDrop(e)}
    >
      {importOpen && (
        <ImportBar
          onClose={() => setImportOpen(false)}
          collectionId={activeCollectionId}
          kind={activeKind}
          autoConvert={autoConvert}
          onAutoConvertChange={setAutoConvert}
          onImported={async () => {
            await refresh();
            await loadCollections();
            await refreshItems();
          }}
        />
      )}
      {/* 库名 + 操作。库名来自左栏的选择;这里也给一个下拉,方便不离开右栏就切换。 */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-edge px-3 py-2">
        <IconBook size={14} className="shrink-0 text-accent" />
        <select
          value={activeCollectionId ?? ""}
          onChange={(e) => setActiveCollection(e.target.value || null)}
          className="min-w-0 flex-1 cursor-pointer truncate rounded border border-transparent bg-transparent px-1 py-0.5 text-xs font-medium text-content hover:border-edge focus:border-accent focus:outline-none"
        >
          {/* 「全部」= 不限定分类,仍然限定在**当前这个库**里。放在第一项,它是默认视图。 */}
          <option value="">{t("library.view.allInKind", { kind: t(LIBRARY_KIND_LABEL[activeKind]) })}</option>
          {collections
            .filter((c) => c.kind === activeKind)
            .map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <span className="shrink-0 text-[0.7857em] tabular-nums text-content-subtle">
          {items.length}
        </span>
        <button
          onClick={() => setScreen({ kind: "search" })}
          title={t("library.action.search")}
          className="shrink-0 rounded p-1 text-content-muted hover:bg-surface-hover hover:text-content"
        >
          <IconSearch size={14} />
        </button>
        {/* 导入带文字标签 —— 原来是个光秃秃的图标,用户找不到入口(实际发生过)。 */}
        <button
          onClick={() => setImportOpen(true)}
          title={t("library.action.import")}
          className="flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-[0.7857em] text-content-muted hover:bg-surface-hover hover:text-content"
        >
          <IconUpload size={13} />
          {t("library.action.import")}
        </button>
        {/* 导出引用 —— 三种格式放一个菜单里。做成图标按钮:工具栏只有 400px 宽,
            两个中文文字标签会把它挤爆,而导入比导出用得多,标签留给导入。 */}
        <Menu.Root>
          <Menu.Trigger
            title={t("library.export.label")}
            aria-label={t("library.export.label")}
            className="flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-[0.7857em] text-content-muted hover:bg-surface-hover hover:text-content"
          >
            <IconShare size={13} />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner side="bottom" align="end" className="z-50">
              <Menu.Popup className="min-w-[200px] rounded-lg border border-edge bg-surface py-1 shadow-2xl">
                <div className="px-3 py-1 text-[0.7143em] uppercase tracking-wider text-content-subtle">
                  {t("library.export.label")}
                </div>
                {(["bibtex", "gb7714", "apa"] as const).map((style) => (
                  <Menu.Item
                    key={style}
                    onClick={() => void runExport(style)}
                    className="flex w-full items-center px-3 py-1.5 text-left text-xs text-content-muted outline-none select-none data-[highlighted]:bg-surface-muted data-[highlighted]:text-content"
                  >
                    {t(EXPORT_LABEL[style])}
                  </Menu.Item>
                ))}
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
        {/* 关掉文献库 = 回到文件树,和浏览器标签的关闭逻辑一致 */}
        <button
          onClick={() => setRightPanelTab("files")}
          title={t("library.collection.cancel")}
          className="shrink-0 rounded p-1 text-content-subtle hover:bg-surface-hover hover:text-content"
        >
          <IconX size={14} />
        </button>
      </div>

      {dropOverlay}

      {dropMsg && (
        <div className="shrink-0 border-b border-edge bg-surface-hover/40 px-3 py-1.5 text-[0.7857em] text-content-muted">
          {dropMsg}
        </div>
      )}

      {exportMsg && (
        <div className="flex shrink-0 items-start gap-1.5 border-b border-edge bg-surface-hover/40 px-3 py-1.5 text-[0.7857em] text-content-muted">
          <span className="min-w-0 flex-1 break-all">{exportMsg}</span>
          {/* 导出的文件在库根的 exports/ 下 —— 给一个直接打开所在文件夹的入口,
              否则用户得自己按路径找过去 */}
          <button
            onClick={() => void runExport(lastExportStyle, true)}
            className="shrink-0 rounded px-1 text-content-subtle hover:bg-surface-hover hover:text-content"
            title={t("library.export.openFolder")}
          >
            {t("library.export.openFolder")}
          </button>
          <button
            onClick={() => setExportMsg(null)}
            className="shrink-0 rounded p-0.5 text-content-subtle hover:bg-surface-hover hover:text-content"
            title={t("common.close")}
          >
            <IconX size={11} />
          </button>
        </div>
      )}

      <div className="flex shrink-0 items-center gap-2 border-b border-edge px-3 py-1.5">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("library.list.searchPlaceholder")}
          className="min-w-0 flex-1 rounded border border-edge bg-surface px-2 py-1 text-xs text-content placeholder:text-content-subtle focus:border-accent focus:outline-none"
        />
      </div>

      {/* 状态筛选是给 PDF 用的 —— 笔记库里整排都是「缺 PDF」,没有意义 */}
      {activeKind !== "note" && (
      <div className="flex shrink-0 items-center gap-1 border-b border-edge px-3 py-1">
        {chips.map((c) => (
          <button
            key={c.key}
            onClick={() => setStatus(c.key)}
            className={cn(
              "rounded-full px-1.5 py-0.5 text-[0.7143em] transition-colors",
              status === c.key
                ? "bg-surface-hover font-medium text-content"
                : "text-content-subtle hover:bg-surface-hover hover:text-content",
            )}
          >
            {c.label}
            {c.count ? <span className="ml-1 tabular-nums opacity-70">{c.count}</span> : null}
          </button>
        ))}
      </div>
      )}

      {selectedIds.length > 0 && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-edge bg-surface-hover/60 px-3 py-1.5">
          <span className="text-[0.7857em] text-content-muted">
            {t("library.list.selected", { n: selectedIds.length })}
          </span>
          <button
            disabled={busy}
            onClick={() => void handleDownload(selectedIds)}
            className="rounded border border-edge px-1.5 py-0.5 text-[0.7857em] text-content-muted hover:bg-surface-hover hover:text-content disabled:opacity-50"
          >
            {t("library.action.download")}
          </button>
          <button
            disabled={busy}
            onClick={() => void handleRemove(selectedIds)}
            className="rounded border border-edge px-1.5 py-0.5 text-[0.7857em] text-content-muted hover:bg-surface-hover hover:text-content disabled:opacity-50"
          >
            {t("library.action.removeFromLibrary")}
          </button>
        </div>
      )}

      {/* 被挡住时说清楚 —— 空列表和"被筛选挡住"长得一模一样,而后者能自己解决 */}
      {hiddenByFilter > 0 && visibleItems.length === 0 && (
        <div className="flex shrink-0 items-center gap-2 border-b border-edge bg-amber-500/10 px-3 py-1.5 text-[0.7857em] text-amber-700 dark:text-amber-400">
          <span className="min-w-0 flex-1">
            {t("library.list.filteredOut", { n: hiddenByFilter })}
          </span>
          <button
            onClick={() => {
              setStatus("all");
              setQuery("");
            }}
            className="shrink-0 rounded border border-amber-500/40 px-2 py-0.5 hover:bg-amber-500/10"
          >
            {t("library.list.clearFilters")}
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <ItemList
          kind={activeKind}
          items={visibleItems}
          pdfStateOf={pdfStateOf}
          activeId={activeId}
          selectedIds={selectedIds}
          onActivate={(id) => {
            setActiveId(id);
            setScreen({ kind: "detail" });
          }}
          onToggleSelect={(id) =>
            setSelectedIds((prev) =>
              prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
            )
          }
          onSelectAll={(ids) => setSelectedIds(ids)}
          onImport={() => setImportOpen(true)}
          onSearch={() => setScreen({ kind: "search" })}
          // 只有在看某个分类时才给"回全部"的出口
          onShowAll={activeCollectionId ? () => setActiveCollection(null) : undefined}
        />
      </div>
    </div>
  );
}
