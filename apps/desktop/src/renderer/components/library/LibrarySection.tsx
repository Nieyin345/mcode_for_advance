/**
 * 左栏的「文献库」分组(界面上叫「文档」)。
 *
 * ## 与「项目」的关系:逐字照抄
 *
 * 用户的明确要求是「项目啥样,它就是啥样」。所以这里的标记**不是"类似项目",
 * 而是直接照抄 LeftBar 里项目段的结构** —— 具体那套观感(选中只提亮文字、底色留给
 * 悬停、展开缩进用左边一条细线、悬停才出现行内按钮)现在收在
 * `components/sidebar/Sidebar.tsx` 里,与「模版」段**共用同一份**。用户对模版的
 * 要求是「和文档一样的样式,一样的功能」,而两份拷贝迟早会各自漂移。
 *
 * ## 层次,以及用户要求的两个固定位置
 *
 *   标签排 文献 / 教材 / 笔记
 *   ──────────────────────────────────────────────
 *   「全部文献」  ← **永远在最上面**
 *   分类(可展开 → 文献)
 *   「回收站」    ← **永远在最下面**(每个库各有一个,见 library/trash.ts)
 *
 * 这个顺序是用户明确定下的:「每个部分都有自己独立的回收站…而且和文档一样要有全部
 * 内容,每一个都要有,然后位置调整一下,全部内容始终在最上面,回收站在最下面」。
 * 回收站的行序在数据库里是任意的(它就是一条普通记录),所以**排序在渲染端做**
 * (见 orderedCollections)—— 靠数据库的返回顺序来保证界面次序是不成立的。
 *
 * ## 图标
 *
 * 「每个都要有图标」:全部 = `IconFiles`、普通分类 = `IconBook`、回收站 =
 * `IconArchive`(它是个"地方"而不是一个"动作",所以不用垃圾桶图标 —— 那是删除按钮
 * 用的)、文献 = `IconFileText`。回收站与普通分类**必须长得不一样**:一个是随时能
 * 打开翻的东西,另一个点进去删就是真的没了。
 *
 * ## 两种呈现,由顶部那个切换图标一起控制
 *
 * 顶部 `LeftBarModeSwitch` 切的是 `leftBarMode`。这个组件跟着它换呈现 ——
 * **不另设控件**:
 *
 *   tree   —— 按库分组:一行一个库,chevron 展开看库里的文献
 *   stream —— 平铺:所有库的文献直接列出来,不分库(对应会话流的「扁平」语义)
 *
 * 展开态与文献缓存都放在 `libraryStore` 里,不在本组件内。这样两种模式之间
 * 切换(组件重挂载)时展开状态不会丢 —— 这正是「一起控制」的落点。
 *
 * ## 点一个库 / 一篇文献做什么
 *
 * 选中它,并把**右侧面板**切到文献库标签(见 LibraryPanel 的说明:不做全屏页,
 * 不挤掉主区的对话)。这与点项目后主区开会话标签是同一套交互模式。
 */
import { useEffect, useMemo, useState } from "react";
import { LIBRARY_KIND_LABEL } from "@renderer/lib/libraryLabels.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useLibraryStore } from "@renderer/stores/libraryStore.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { api } from "@renderer/lib/api.js";
import { LIBRARY_KINDS, type LibraryKind } from "@contracts/library";
import type { LibraryCollection, LibraryItem } from "@contracts/library";
import {
  IconArchive,
  IconBook,
  IconFileText,
  IconFiles,
  IconMessage,
  IconPencil,
  IconPlus,
  IconTrash,
} from "@renderer/lib/icons.js";
import { attachToCurrentChat } from "@renderer/lib/attachToChat.js";
import {
  HeaderAction,
  HintRow,
  InlineInputRow,
  RowAction,
  SectionHeader,
  SectionTabs,
  SidebarList,
  SidebarRow,
  type SectionTab,
} from "@renderer/components/sidebar/Sidebar.js";
import { LibraryItemContextMenu, type LibraryCtxTarget } from "./LibraryItemContextMenu.js";
import { CollectionContextMenu, type CollectionCtxTarget } from "./CollectionContextMenu.js";


export function LibrarySection() {
  const { t } = useI18n();
  const collections = useLibraryStore((s) => s.collections);
  const activeKind = useLibraryStore((s) => s.activeKind);
  const setActiveKind = useLibraryStore((s) => s.setActiveKind);
  const activeId = useLibraryStore((s) => s.activeCollectionId);
  const activeItemId = useLibraryStore((s) => s.activeItemId);
  const setActive = useLibraryStore((s) => s.setActiveCollection);
  const setActiveItem = useLibraryStore((s) => s.setActiveItem);
  const createCollection = useLibraryStore((s) => s.createCollection);
  const loadCollections = useLibraryStore((s) => s.loadCollections);
  const expandedIds = useLibraryStore((s) => s.expandedIds);
  const toggleExpanded = useLibraryStore((s) => s.toggleExpanded);
  const itemsByCollection = useLibraryStore((s) => s.itemsByCollection);
  const allItemsByKind = useLibraryStore((s) => s.allItemsByKind);
  const loadAllItems = useLibraryStore((s) => s.loadAllItems);
  const loadEveryCollectionItems = useLibraryStore((s) => s.loadEveryCollectionItems);
  const refreshItems = useLibraryStore((s) => s.refreshItems);
  const leftBarMode = useSessionStore((s) => s.leftBarMode);
  const setRightPanelTab = useSessionStore((s) => s.setRightPanelTab);
  const setRightOpen = useSessionStore((s) => s.setRightOpen);

  /** 「全部<库>」这一层是否展开。局部状态即可 —— 它不跨库共享,切库时收起也符合预期。 */
  const [allOpen, setAllOpen] = useState(false);
  /** 正在新建(输入框态)。 */
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  /** 正在重命名的库 id + 输入框内容。同时只有一个。 */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  /** 重名提示(新建与重命名共用一处显示)。 */
  const [error, setError] = useState<string | null>(null);
  /** 文献行的右键菜单目标(坐标 + 那一篇 + 右键落在哪个库上)。 */
  const [ctxMenu, setCtxMenu] = useState<LibraryCtxTarget | null>(null);
  /** 分类行的右键菜单目标(新建笔记 / 重命名 / 删除)。 */
  const [ctxCollection, setCtxCollection] = useState<CollectionCtxTarget | null>(null);
  /** 正在改名的**条目** id + 输入中的标题(三个库通用;分类改名是另一套)。 */
  const [renamingItemId, setRenamingItemId] = useState<string | null>(null);
  const [itemTitleDraft, setItemTitleDraft] = useState("");
  /** 正在哪个分类下新建笔记(分类 id)+ 输入中的标题。同时只有一个。 */
  const [namingNoteIn, setNamingNoteIn] = useState<string | null>(null);
  const [noteName, setNoteName] = useState("");

  useEffect(() => {
    void loadCollections();
  }, [loadCollections]);

  // 换库时收起「全部」那一层 —— 换了个库,上一层的展开态没有意义
  useEffect(() => {
    setAllOpen(false);
  }, [activeKind]);

  /** 当前这个库(论文 / 教材 / 笔记)的分类。三个库各有各的树,只画选中的那个。 */
  const kindCollections = useMemo(
    () => collections.filter((c) => c.kind === activeKind),
    [collections, activeKind],
  );
  /**
   * 回收站的集合 id。
   *
   * 在**回收站里**删东西是真正的删除(数据库行 + 磁盘文件),在别处删只是移出分组
   * —— 两者相差一个"能不能还原",所以右键菜单必须知道自己在哪儿。`isTrash` 由主进程
   * 标上(用户自己建一个叫「回收站」的分类也算),渲染端不去猜名字。
   */
  const trashIds = useMemo(
    () => new Set(kindCollections.filter((c) => c.isTrash).map((c) => c.id)),
    [kindCollections],
  );
  /**
   * 分类的**渲染顺序**:普通分类在前,回收站永远在最后。
   *
   * 用户的原话是「全部内容始终在最上面,回收站在最下面」。全部那一行本来就是写死的
   * 第一条,而回收站在数据库里只是一条普通记录 —— 它的位置由返回顺序决定,不做这一步
   * 就会随建库时间飘(用户报的正是这个)。
   */
  const orderedCollections = useMemo(() => {
    const live = kindCollections.filter((c) => !c.isTrash);
    const trash = kindCollections.filter((c) => c.isTrash);
    return [...live, ...trash];
  }, [kindCollections]);

  /** 每个库各有几个分类 —— 标签上显示,用户不用点进去就知道那边有没有东西。 */
  const tabs: ReadonlyArray<SectionTab<LibraryKind>> = useMemo(
    () =>
      LIBRARY_KINDS.map((k) => ({
        key: k,
        label: t(LIBRARY_KIND_LABEL[k]),
        count: collections.reduce((n, c) => (c.kind === k ? n + 1 : n), 0),
      })),
    [collections, t],
  );

  // 会话流模式一次要列出所有库的文献,所以进模式(以及库增删)时全量拉一次。
  // 树模式不拉全量 —— 展开哪个库才拉哪个。
  const collectionIds = kindCollections.map((c) => c.id).join(",");
  useEffect(() => {
    if (leftBarMode === "stream") void loadEveryCollectionItems();
  }, [leftBarMode, collectionIds, loadEveryCollectionItems]);

  // 文献增删(检索入库、导入、下载完成)之后左栏要跟上。展开态保留,只换内容。
  useEffect(() => {
    const off = window.api?.on?.libraryJobChanged?.(() => {
      void refreshItems();
    });
    return off;
  }, [refreshItems]);

  /**
   * 库的内容变了 —— **包括 AI 改的**。
   *
   * 用户自己在界面上操作时,缓存本来就是对的(是他点出来的);AI 走 MCP 工具改的是
   * 主进程里那份真相,渲染端的缓存不会自己知道。少了这条广播,AI 建好的分类在左栏
   * 里根本不出现,用户会以为它没干活 —— 用户的原话是「他对文件系统的操作要和用户
   * 在 ui 的操作一样」。
   *
   * 分类树和条目列表都要重拉:AI 可能新建了一个分类(树变了),也可能只是往现有
   * 分类里塞了东西(树没变、内容变了)。**右栏那棵也是** —— 它订阅同一条广播
   * (见 LibraryPanel),所以左栏改名、AI 改元数据都会立刻反映到正在看的那一篇上。
   */
  useEffect(() => {
    const off = window.api?.on?.libraryChanged?.(() => {
      const s = useLibraryStore.getState();
      void s.loadCollections();
      void s.refreshItems();
    });
    return off;
  }, []);

  /**
   * 点一个分类:选中它(右栏切到文献库标签)**并切换展开态**。
   *
   * 展开是"用户点它就是想看里面的东西"的自然结果;但**再点一次要合上** ——
   * 只展开不收合的话,左栏会越点越满,用户没有收起来的办法(箭头能收,但点名字
   * 两次却越展越开,是反直觉的)。
   *
   * toggleExpanded 里带着"没缓存才拉"的逻辑,所以展开时不需要额外请求。
   */
  const openCollection = (id: string) => {
    setActive(id);
    setRightPanelTab("library");
    setRightOpen(true);
    toggleExpanded(id);
  };

  /** 打开某一篇。`collectionId` 为 null(会话流模式)时不动当前选中的库。 */
  const openItem = (item: LibraryItem, collectionId: string | null) => {
    if (collectionId) setActive(collectionId);
    setActiveItem(item.id);
    // 笔记点开就是要写/改它,直接落在编辑页;其余落在第一页(元数据 / 概览)
    useLibraryStore.getState().setDetailTab(item.kind === "note" ? "edit" : "meta");
    setRightPanelTab("library");
    setRightOpen(true);
  };

  /**
   * 名字是否与**别的**库重复。
   *
   * 判据与主进程的 `CollectionRepo.isNameTaken` 保持一致(去首尾空白 + 忽略大小写),
   * 且是**全局**判重而非同层 —— 库名会出现在上下文 chip、右栏标题、选择器里,
   * 那些地方只显示名字,重名就分不出来了。
   *
   * `exceptId` 用于重命名:改成自己原来的名字不算冲突。
   */
  const nameTaken = (candidate: string, exceptId?: string): boolean => {
    const norm = candidate.trim().toLowerCase();
    return (
      norm.length > 0 &&
      kindCollections.some((c) => c.id !== exceptId && c.name.trim().toLowerCase() === norm)
    );
  };

  const submitNew = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setCreating(false);
      setError(null);
      return;
    }
    if (nameTaken(trimmed)) {
      // 保持输入框打开并提示,让用户直接改 —— 关掉再让他重新点一次「+」很烦
      setError(t("library.collection.duplicateName"));
      return;
    }
    const id = await createCollection(trimmed);
    if (!id) {
      // 理论上渲染端已经挡掉了;走到这里说明并发创建或绕过了 UI
      setError(t("library.collection.duplicateName"));
      return;
    }
    setName("");
    setCreating(false);
    setError(null);
    openCollection(id);
  };

  const startRename = (id: string, current: string) => {
    setRenamingId(id);
    setRenameValue(current);
    setError(null);
  };

  const submitRename = async () => {
    const id = renamingId;
    if (!id) return;
    const trimmed = renameValue.trim();
    const original = kindCollections.find((c) => c.id === id)?.name ?? "";
    // 没改动 / 清空 → 当作放弃,不算错误
    if (!trimmed || trimmed === original) {
      setRenamingId(null);
      setError(null);
      return;
    }
    if (nameTaken(trimmed, id)) {
      setError(t("library.collection.duplicateName"));
      return;
    }
    const res = await api.library.renameCollection({ id, name: trimmed });
    // 主进程那层还有一道守卫(防绕过 UI 的调用)。它拒了要如实提示,
    // 而不是当作成功 —— 否则用户以为改名了,实际没动。
    if (!res.ok) {
      setError(t("library.collection.duplicateName"));
      return;
    }
    await loadCollections();
    setRenamingId(null);
    setError(null);
  };

  /** 右键「新建笔记」→ 先在这个分类下摆一个输入行让用户起名(与新建分类同一套)。 */
  const startNewNote = (c: LibraryCollection) => {
    setNamingNoteIn(c.id);
    setNoteName("");
    setError(null);
  };

  /**
   * 起好名 → 建笔记 → **展开它所在的分类并重新拉条目**,然后打开编辑器。
   *
   * 两处都不能省:
   *   - 不展开/不重拉,左栏就看不到这篇新笔记(用户报的正是这个);
   *   - 不打开编辑器,用户还得再点一次 —— 而右键新建的意图就是"现在就要写"。
   */
  const submitNewNote = async (c: LibraryCollection) => {
    const title = noteName.trim();
    if (!title) {
      setNamingNoteIn(null);
      setNoteName("");
      return;
    }
    const res = await api.library.createNote({ title, collectionIds: [c.id] });
    setNamingNoteIn(null);
    setNoteName("");
    if (!res.item) return;

    // 先展开(展开本身会拉一次),再补一次 —— 两次都留着:展开是"以后看得到",
    // 补拉是"现在就有",中间可能撞上并发,重拉一次代价极小。
    if (!expandedIds[c.id]) toggleExpanded(c.id);
    await useLibraryStore.getState().loadCollectionItems(c.id);
    openCollection(c.id);
    const store = useLibraryStore.getState();
    store.setActiveItem(res.item.id);
    store.setDetailTab("edit");
  };

  const removeCollection = async (id: string, name: string) => {
    if (!window.confirm(t("library.collection.deleteConfirm", { name }))) return;
    await api.library.deleteCollection({ id });
    // 被删的正好是当前选中的 → 清掉选中,否则右栏会停在一个不存在的库上
    if (activeId === id) setActive(null);
    await loadCollections();
  };

  /**
   * 在回收站里**彻底删掉一条** —— 数据库行加磁盘上的 PDF / Markdown,不可还原。
   *
   * 这正是"回收站"三个字的意思:别处删只是把条目移出分组(沦为孤儿后自动落回来,
   * 捞得回来),在这儿删才是真的没了。所以 `deleteFiles: true` 不能漏 —— 契约里那个
   * 开关默认 false(只删记录),漏掉的话界面上条目消失了、PDF 却永远躺在磁盘上,
   * 而且再也认不出是谁的。
   *
   * 与 `removeCollection` 一样,删完要清掉可能悬空的选中态,再重拉列表。
   */
  const deleteForever = async (item: LibraryItem) => {
    if (!window.confirm(t("library.ctx.deleteForeverConfirm", { title: item.title }))) return;
    await api.library.deleteItems({ ids: [item.id], deleteFiles: true });
    // 删掉的可能正是右栏正在看的那一篇 —— 不清掉的话右栏会停在一个不存在的条目上
    if (activeItemId === item.id) setActiveItem(null);
    await loadCollections();
    await refreshItems();
  };

  /** 开始改一个条目的名字(右键菜单里点「重命名」)。 */
  const startItemRename = (item: LibraryItem) => {
    setRenamingItemId(item.id);
    setItemTitleDraft(item.title);
    setError(null);
  };

  /**
   * 提交改名。改的是**显示标题**,磁盘上的文件名不动 —— 文件名(尤其笔记的)按条目
   * id 命名,跟着标题变会让库内所有引用一起漂,而用户看到名字变了就够了。
   */
  const submitItemRename = async () => {
    const id = renamingItemId;
    if (!id) return;
    const title = itemTitleDraft.trim();
    setRenamingItemId(null);
    setItemTitleDraft("");
    if (!title) return;
    const res = await api.library.renameItem({ id, title });
    if (!res.item) {
      setError(t("library.itemNote.loadFailed"));
      return;
    }
    await refreshItems();
  };

  /** 一篇文献的行。树模式嵌在分类下面,会话流模式平铺 —— 两处共用这一个。 */
  const renderItemRow = (item: LibraryItem, collectionId: string | null) => {
    // 改名态:整行换成输入框(与分类改名的输入行同一套手感)
    if (renamingItemId === item.id) {
      return (
        <InlineInputRow
          key={item.id}
          value={itemTitleDraft}
          onChange={setItemTitleDraft}
          onSubmit={() => void submitItemRename()}
          onCancel={() => {
            setRenamingItemId(null);
            setItemTitleDraft("");
          }}
          onBlur={() => void submitItemRename()}
        />
      );
    }
    return (
      <li
        key={item.id}
        // 右键落在整行上(不只是文字),和会话行的手感一致
        onContextMenu={(e) => {
          e.preventDefault();
          setCtxMenu({
            item,
            collectionId,
            isTrash: !!collectionId && trashIds.has(collectionId),
            x: e.clientX,
            y: e.clientY,
          });
        }}
      >
        <SidebarRow
          icon={<IconFileText size={12} className="shrink-0" />}
          label={item.title}
          active={item.id === activeItemId ? "fill" : false}
          onClick={() => openItem(item, collectionId)}
        />
      </li>
    );
  };

  /** 「+ 新建」的输入行。两种模式共用 —— 都挂在列表末尾。 */
  const creatingRow = creating && (
    <InlineInputRow
      value={name}
      onChange={(next) => {
        setName(next);
        // 用户一开始改就把上次的重名提示清掉,否则红字会一直挂着
        if (error) setError(null);
      }}
      onSubmit={() => void submitNew()}
      onCancel={() => {
        setCreating(false);
        setName("");
        setError(null);
      }}
      onBlur={() => void submitNew()}
      placeholder={t("library.collection.namePlaceholder")}
      error={error}
    />
  );

  /** 重命名的输入行。树 / 会话流两种模式共用。 */
  const renameInputRow = (c: LibraryCollection) => (
    <InlineInputRow
      key={c.id}
      value={renameValue}
      onChange={(next) => {
        setRenameValue(next);
        if (error) setError(null);
      }}
      onSubmit={() => void submitRename()}
      onCancel={() => {
        setRenamingId(null);
        setError(null);
      }}
      onBlur={() => void submitRename()}
      error={error}
    />
  );

  /**
   * 「全部<库>」这一行 —— 树的**根节点**,而且**永远在最上面**。
   *
   * 少了它会出一个很实在的问题:**不属于任何分类的条目在左栏里根本不存在**。
   * 左栏只画分类下的条目,而条目可以不属于任何分类(导入时没选分类、或刚从分类里
   * 移除)。用户于是既看不到它、也没地方右键它(移动/复制都在右键菜单里)。
   *
   * 选中它 = 不限分类(`collectionId = null`),与右栏下拉框里那个「全部」是同一个
   * 视图 —— Zotero 也是把「My Library」放在树的顶上。
   */
  const renderAllRow = () => {
    const on = activeId === null;
    const items = allItemsByKind[activeKind];
    const label = t("library.view.allInKind", { kind: t(LIBRARY_KIND_LABEL[activeKind]) });
    const openAll = () => {
      setAllOpen(true);
      // 展开时才拉整个库的条目(没展开过就不拉 —— 与分类的懒加载一致)
      if (!allItemsByKind[activeKind]) void loadAllItems(activeKind);
    };
    return (
      <li>
        <SidebarRow
          icon={<IconFiles size={14} className="shrink-0" />}
          label={label}
          title={label}
          active={on ? "fill" : false}
          expanded={allOpen}
          onToggleExpand={() => {
            const next = !allOpen;
            setAllOpen(next);
            if (next && !allItemsByKind[activeKind]) void loadAllItems(activeKind);
          }}
          expandTitle={t("layout.expand")}
          collapseTitle={t("layout.collapse")}
          onClick={() => {
            // 点名字 = 选中它 + **切换展开态** —— 与分类行逐字一致(那边是
            // toggleExpanded)。上一版只写了"没展开就展开",于是点第二下什么都不发生。
            setActive(null);
            setRightPanelTab("library");
            setRightOpen(true);
            if (allOpen) setAllOpen(false);
            else openAll();
          }}
          // 悬停那个气泡把**整个库**挂进当前对话 —— 与模版段的「全部<类目>」那一行
          // 逐字同款。附件键是 `k:<库>`,对应的清单是一份索引(库里有什么),
          // 与挂一个分类(`c:<id>`,那个分类里有什么)是同一个机制的两个范围。
          actions={
            <RowAction
              title={t("library.ctx.attachToChat")}
              onClick={(e) => {
                e.stopPropagation();
                void attachToCurrentChat(`k:${activeKind}`);
              }}
            >
              <IconMessage size={12} />
            </RowAction>
          }
        />

        {/* 子列表:整个库的条目(不限分类)——
            **不属于任何分类的条目只有在这里才看得到、才右键得到**(移动/复制在右键菜单里)。 */}
        {allOpen && (
          <SidebarList nested>
            {items === undefined ? (
              <HintRow>…</HintRow>
            ) : items.length === 0 ? (
              <HintRow>{t("library.list.empty")}</HintRow>
            ) : (
              items.map((item) => renderItemRow(item, null))
            )}
          </SidebarList>
        )}
      </li>
    );
  };

  const renderCollectionRow = (c: LibraryCollection) => {
    const isActive = c.id === activeId;
    const isExpanded = !!expandedIds[c.id];
    const items = itemsByCollection[c.id];

    if (renamingId === c.id) return renameInputRow(c);

    return (
      <li key={c.id}>
        <SidebarRow
          // 回收站与普通分类**必须长得不一样** —— 一个是随时能翻的地方,另一个
          // 点进去删就是真的没了
          icon={
            c.isTrash ? (
              <IconArchive size={14} className="shrink-0" />
            ) : (
              <IconBook size={14} className="shrink-0" />
            )
          }
          label={c.name}
          title={c.name}
          // 选中**不铺底色**,只把文字/图标提亮成强调色;底色只在悬停时出现。
          // 之前选中就铺 `bg-surface-hover` 而且它不会消失,看起来像一块甩不掉的
          // 深色块(用户原话:"阴影加重,鼠标移走应该消失")。项目行没有这个观感,
          // 是因为它的"选中"条件很窄(项目被激活 **且** 它自己没有活跃会话),
          // 平时根本不亮 —— 所以按项目的手感来:轻指示 + 悬停才给底。
          active={isActive ? "accent" : false}
          expanded={isExpanded}
          onToggleExpand={() => toggleExpanded(c.id)}
          expandTitle={t("layout.expand")}
          collapseTitle={t("layout.collapse")}
          onClick={() => openCollection(c.id)}
          onContextMenu={(e) => {
            // 分类行没有别的右键用途,直接接管(与文献行同一个做法)
            e.preventDefault();
            setCtxCollection({ collection: c, x: e.clientX, y: e.clientY });
          }}
          // 行尾三件:加入对话 / 重命名 / 删除 —— 与模版段那边**同一组**
          //(模版行也是这三个,顺序一样:能做什么、叫什么、不要了)。
          actions={
            <>
              <RowAction
                title={t("library.ctx.attachToChat")}
                onClick={(e) => {
                  e.stopPropagation();
                  void attachToCurrentChat(`c:${c.id}`);
                }}
              >
                <IconMessage size={12} />
              </RowAction>
              <RowAction
                title={t("library.collection.rename")}
                onClick={(e) => {
                  e.stopPropagation();
                  startRename(c.id, c.name);
                }}
              >
                <IconPencil size={12} />
              </RowAction>
              <RowAction
                title={t("library.collection.delete")}
                danger
                onClick={(e) => {
                  e.stopPropagation();
                  void removeCollection(c.id, c.name);
                }}
              >
                <IconTrash size={12} />
              </RowAction>
            </>
          }
        />

        {/* 新建笔记的起名行 —— 挂在这个分类下面,用户一眼看得出笔记建到哪去 */}
        {namingNoteIn === c.id && (
          <InlineInputRow
            value={noteName}
            onChange={setNoteName}
            onSubmit={() => void submitNewNote(c)}
            onCancel={() => {
              setNamingNoteIn(null);
              setNoteName("");
            }}
            onBlur={() => void submitNewNote(c)}
            placeholder={t("library.note.placeholder")}
            error={error}
          />
        )}

        {/* 展开 —— 子列表的缩进/描边与 ProjectNode 展开会话列表时逐字一致 */}
        {isExpanded && (
          <SidebarList nested>
            {items === undefined ? (
              // 还没拉到 —— 给一行占位,避免「空库」和「加载中」看起来一样
              <HintRow>…</HintRow>
            ) : items.length === 0 ? (
              <HintRow>{t("library.collection.empty")}</HintRow>
            ) : (
              items.map((item) => renderItemRow(item, c.id))
            )}
          </SidebarList>
        )}
      </li>
    );
  };

  /**
   * 一个库的行(会话流模式)。
   *
   * 与树模式的区别是**没有折叠箭头**:会话流里一切本来就已经是平的 —— 它在
   * store 里的对应物是「会话卡片也不会展开成消息」。
   *
   * 但库本身**永远可见**,文献直接跟在库名下面。这一条是硬要求:早先的版本在
   * 这个模式下只列文献、不列库,结果一条文献都没有时整个「文献库」段是空的,
   * 用户会以为自己的库没了。
   */
  const renderStreamCollection = (c: LibraryCollection) => {
    if (renamingId === c.id) return renameInputRow(c);
    const items = itemsByCollection[c.id];
    return (
      <li key={c.id}>
        <SidebarRow
          icon={
            c.isTrash ? (
              <IconArchive size={14} className="shrink-0" />
            ) : (
              <IconBook size={14} className="shrink-0" />
            )
          }
          label={c.name}
          title={c.name}
          // 同树模式:选中只提亮文字,底色留给悬停
          active={c.id === activeId ? "accent" : false}
          onClick={() => openCollection(c.id)}
          onContextMenu={(e) => {
            e.preventDefault();
            setCtxCollection({ collection: c, x: e.clientX, y: e.clientY });
          }}
          actions={
            <>
              <RowAction
                title={t("library.ctx.attachToChat")}
                onClick={(e) => {
                  e.stopPropagation();
                  void attachToCurrentChat(`c:${c.id}`);
                }}
              >
                <IconMessage size={12} />
              </RowAction>
              <RowAction
                title={t("library.collection.rename")}
                onClick={(e) => {
                  e.stopPropagation();
                  startRename(c.id, c.name);
                }}
              >
                <IconPencil size={12} />
              </RowAction>
              <RowAction
                title={t("library.collection.delete")}
                danger
                onClick={(e) => {
                  e.stopPropagation();
                  void removeCollection(c.id, c.name);
                }}
              >
                <IconTrash size={12} />
              </RowAction>
            </>
          }
        />
        {/* 缩进与树模式一致,但不画左边那条竖线 —— 竖线是「层级」的记号,
            流模式里没有层级。 */}
        {items && items.length > 0 && (
          <SidebarList nested border={false}>
            {items.map((item) => renderItemRow(item, c.id))}
          </SidebarList>
        )}
      </li>
    );
  };

  return (
    <>
      {/* 表头在最上、三个库的标签在其下 —— 先有"这是什么"(文档),再有"看哪一类"
          (文献 / 教材 / 笔记)。反过来会让人先看到三个并列的词、才反应过来它们在
          给什么分类。表头与「项目」表头同款。 */}
      <SectionHeader
        title={t("library.docs.title")}
        action={
          <HeaderAction
            title={t("library.collection.new")}
            onClick={() => {
              setCreating(true);
              setError(null);
            }}
          >
            {/* **常显**,不像项目段那样"悬停才出现"。
                项目段的表头右侧还有一组常显的视图切换图标,所以"这里有点东西"是有暗示的;
                这里的右侧**只有这一个按钮**,一隐藏就整块看不见 —— 用户报的就是"没有新建
                collection 了"。 */}
            <IconPlus size={12} />
          </HeaderAction>
        }
      />

      {/* 三个平级的库:文献 / 教材 / 笔记。同一排、同样的入口,只是不能同时展开 ——
          把三棵树同时画出来会把左栏撑成三倍高,而用户绝大多数时候只在一个库里干活。 */}
      <SectionTabs tabs={tabs} active={activeKind} onChange={setActiveKind} />

      <ul className="space-y-0.5">
        {renderAllRow()}
        {leftBarMode === "stream"
          ? orderedCollections.map(renderStreamCollection)
          : orderedCollections.map(renderCollectionRow)}
        {creatingRow}
      </ul>

      {/* 文献行的右键菜单:移动 / 复制到别的库、从当前库移除(在回收站里则是彻底删除)、
          打开文件夹、打开 md */}
      <LibraryItemContextMenu
        ctxMenu={ctxMenu}
        collections={kindCollections}
        onClose={() => setCtxMenu(null)}
        onChanged={() => void refreshItems()}
        onRename={startItemRename}
        onDeleteForever={(item) => void deleteForever(item)}
      />

      {/* 分类行的右键菜单:新建笔记(仅笔记库)/ 重命名 / 删除 */}
      <CollectionContextMenu
        target={ctxCollection}
        onClose={() => setCtxCollection(null)}
        onRename={(c) => startRename(c.id, c.name)}
        onDelete={(c) => void removeCollection(c.id, c.name)}
        onNewNote={startNewNote}
      />
    </>
  );
}
