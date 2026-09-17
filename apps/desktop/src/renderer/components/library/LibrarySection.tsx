/**
 * 左栏「资料库」的一个**大类**段(「文档」「模版」那种段落),由同文件尾部的
 * `LibrarySections` 按组表循环渲染。
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
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { kindLibraryLabel } from "@renderer/lib/libraryLabels.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useLibraryStore } from "@renderer/stores/libraryStore.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { type LibraryKind } from "@contracts/library";
import {
  BUILTIN_LIBRARY_TYPES,
  DEFAULT_LIBRARY_GROUPS,
  type LibraryGroupMeta,
  type LibraryTypeMeta,
  type LibraryTypePurpose,
} from "@contracts/libraryTypes";
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
import { GroupContextMenu, type GroupCtxTarget } from "./GroupContextMenu.js";
import { KindContextMenu, type KindCtxTarget } from "./KindContextMenu.js";

/**
 * 管理输入行(大类/小类的新建与重命名)—— 与 `InlineInputRow` 同一套手感,但它渲染
 * div:InlineInputRow 是 `<li>`,只能挂在列表里,而这里的输入挂在表头/tab 排下面。
 */
function MiniInput({
  value,
  onChange,
  onSubmit,
  onCancel,
  onBlur,
  placeholder,
  error,
  children,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  /** 失焦也提交(与文献库行内输入同一语义:点别处就是"就改这个")。 */
  onBlur?: () => void;
  placeholder?: string;
  error?: string | null;
  children?: ReactNode;
}) {
  return (
    <div className="px-1 pb-1">
      <input
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmit();
          if (e.key === "Escape") onCancel();
        }}
        {...(onBlur ? { onBlur } : {})}
        placeholder={placeholder}
        className={cn(
          "w-full rounded border bg-surface px-2 py-1 text-xs text-content focus:outline-none",
          error ? "border-red-500" : "border-accent",
        )}
      />
      {children}
      {error && <div className="pt-0.5 text-[0.7143em] text-red-500">{error}</div>}
    </div>
  );
}


export function LibrarySection({
  group,
  typeMetas,
  groups,
  onRefresh,
}: {
  /** 本段对应的大类(段名 + 段内哪些类型)。由 `LibrarySections` 按组表传入。 */
  group: LibraryGroupMeta;
  /** 类型注册表(上游拉一次后传下来):tab 名与「全部<类型>」的显示名都取自它。 */
  typeMetas: readonly LibraryTypeMeta[];
  /** 整份大类表 —— 新建/删除大类要在它上面增删,光有本段的 group 不够。 */
  groups: readonly LibraryGroupMeta[];
  /** 大类/小类的任何变更落库后调用:父层重拉组表与注册表,各段立即跟上。 */
  onRefresh: () => void;
}) {
  const { locale, t } = useI18n();
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

  // ── 大类 / 小类的管理(用户要求:管理操作全部在左栏,设置页只留提示词)──
  /** 大类标题行的右键菜单(坐标)。 */
  const [ctxGroup, setCtxGroup] = useState<GroupCtxTarget | null>(null);
  /** 小类 tab 的右键菜单(坐标 + 落在哪个类型上)。 */
  const [ctxKind, setCtxKind] = useState<KindCtxTarget | null>(null);
  /** 大类的新建 / 重命名输入。同时只有一个。 */
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [renamingGroup, setRenamingGroup] = useState(false);
  const [groupDraft, setGroupDraft] = useState("");
  const [groupError, setGroupError] = useState<string | null>(null);
  /** 小类的新建 / 重命名输入。新建要多一步:选用途(查资料用 / 照着写用)。 */
  const [creatingKind, setCreatingKind] = useState(false);
  const [newKindDraft, setNewKindDraft] = useState("");
  const [newKindPurpose, setNewKindPurpose] = useState<LibraryTypePurpose>("material");
  const [renamingKind, setRenamingKind] = useState<string | null>(null);
  const [kindDraft, setKindDraft] = useState("");
  const [kindError, setKindError] = useState<string | null>(null);
  /** 菜单动作(删除等)失败时的提示 —— 那时没有输入行可挂,统一显示在段头下方。 */
  const [manageError, setManageError] = useState<string | null>(null);
  /** 正在哪个分类下新建**子集合**(分类 id)+ 输入中的名字。 */
  const [creatingChildIn, setCreatingChildIn] = useState<string | null>(null);
  const [childName, setChildName] = useState("");

  useEffect(() => {
    void loadCollections();
  }, [loadCollections]);

  /**
   * 本段当前生效的 kind。全局 activeKind 只有一个,而段有多个 —— 它落在哪个组,
   * 哪个组就显示它;其余各段**各自记住**用户上次在本段点过的类型(点 tab 时记下),
   * 没记过就退回本组第一个。这样几段并排各显各的内容,不会互相抢、也不会跟着
   * 别段的选中跳。
   */
  const [localKind, setLocalKind] = useState<string | null>(null);
  const kind = group.kinds.includes(activeKind)
    ? activeKind
    : localKind && group.kinds.includes(localKind)
      ? localKind
      : (group.kinds[0] ?? "");

  // 换库时收起「全部」那一层 —— 换了个库,上一层的展开态没有意义
  useEffect(() => {
    setAllOpen(false);
  }, [kind]);

  /** 当前这个类型(论文 / 教材 / 笔记…)的分类。每类各有各的树,只画选中的那个。 */
  const kindCollections = useMemo(
    () => collections.filter((c) => c.kind === kind),
    [collections, kind],
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

  /** 段内的 tab:**按 group.kinds 的顺序**渲染,名字取类型注册表的 name
   *  (用户可改,不走 i18n);组里没这个类型的注册信息时退回 kind 串。 */
  const tabs: ReadonlyArray<SectionTab<LibraryKind>> = useMemo(
    () =>
      group.kinds.map((id) => {
        const meta = typeMetas.find((m) => m.id === id);
        return {
          key: id,
          label: meta?.name ?? id,
          count: collections.reduce((n, c) => (c.kind === id ? n + 1 : n), 0),
        };
      }),
    [group.kinds, typeMetas, collections],
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
    // 全局 activeKind 跟着落到本段的 kind 上:右栏(LibraryPanel)按它决定
    // 新建笔记的默认类型、搜索范围等 —— 看着哪段的库,全局就该停在哪个类型。
    setActiveKind(kind);
    setActive(id);
    setRightPanelTab("library");
    setRightOpen(true);
    toggleExpanded(id);
  };

  /** 打开某一篇。`collectionId` 为 null(会话流模式)时不动当前选中的库。 */
  const openItem = (item: LibraryItem, collectionId: string | null) => {
    if (collectionId) setActive(collectionId);
    setActiveItem(item.id);
    // 同 openCollection:全局 kind 跟着这篇走(右栏按它取显示名与默认行为)
    setActiveKind(item.kind);
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

  /* ── 大类(组)管理:新建 / 重命名 / 删除,全走 groupsSave 整表替换 ──
     即时生效:保存成功立刻 onRefresh(父层重拉组表与注册表),不跳设置页。 */

  /** 组表整表保存。失败把后端 error 原文摆出来(判据以它为准,不另造一套说法)。 */
  const saveGroups = async (next: readonly LibraryGroupMeta[]): Promise<boolean> => {
    const res = await api.library.groupsSave({ groups: next });
    if (!res.ok) {
      setManageError(res.error);
      return false;
    }
    onRefresh();
    return true;
  };

  /** 类型注册表整表保存(小类的新建 / 重命名 / 删除都要它)。 */
  const saveTypes = async (next: readonly LibraryTypeMeta[]): Promise<boolean> => {
    const res = await api.library.typesSave({ types: next });
    if (!res.ok) {
      setManageError(res.error);
      return false;
    }
    return true;
  };

  const submitNewGroup = async () => {
    const trimmed = groupDraft.trim();
    setCreatingGroup(false);
    setGroupDraft("");
    if (!trimmed) return;
    // id 现场生成(小写连字符,与设置页旧做法同一招);名字用用户给的那份
    await saveGroups([...groups, { id: `group-${Date.now().toString(36)}`, name: trimmed, kinds: [] }]);
  };

  const submitRenameGroup = async () => {
    const trimmed = groupDraft.trim();
    setRenamingGroup(false);
    setGroupDraft("");
    if (!trimmed || trimmed === group.name) return;
    await saveGroups(groups.map((g) => (g.id === group.id ? { ...g, name: trimmed } : g)));
  };

  const removeGroup = async () => {
    if (!window.confirm(t("library.group.deleteConfirm", { name: group.name }))) return;
    // 组删了,组里的类型只是变回"未分组"(左栏隐藏、数据不删)—— 所以只动组表
    await saveGroups(groups.filter((g) => g.id !== group.id));
  };

  /* ── 小类(类型)管理:新建 / 重命名 / 删除。
     变更走 typesSave + groupsSave 两次保存:先类型后组 —— 组保存失败时类型仍在
     (只是未分组、左栏不显示),反过来则会留下指向不存在类型的空引用。 ── */

  const submitNewKind = async () => {
    const trimmed = newKindDraft.trim();
    setCreatingKind(false);
    setNewKindDraft("");
    if (!trimmed) return;
    const id = `type-${Date.now().toString(36)}`;
    const ok = await saveTypes([
      ...typeMetas.map((m) => ({ ...m })),
      { id, name: trimmed, purpose: newKindPurpose, builtin: false },
    ]);
    if (!ok) return;
    // 归入本段的大类(失败时 saveGroups 自己会把后端的话摆出来)。
    // 即使归组失败也要重拉:类型已经落进注册表,只是"未分组"(左栏不显示、数据在)。
    const grouped = await saveGroups(
      groups.map((g) => (g.id === group.id ? { ...g, kinds: [...g.kinds, id] } : g)),
    );
    if (!grouped) onRefresh();
    // 切到新建的小类,让用户立刻看到它
    setLocalKind(id);
    setActiveKind(id);
  };

  const submitRenameKind = async () => {
    const id = renamingKind;
    const trimmed = kindDraft.trim();
    setRenamingKind(null);
    setKindDraft("");
    if (!id || !trimmed || trimmed === (typeMetas.find((m) => m.id === id)?.name ?? "")) return;
    await saveTypes(typeMetas.map((m) => (m.id === id ? { ...m, name: trimmed } : m)));
    onRefresh();
  };

  const removeKind = async (id: string) => {
    const meta = typeMetas.find((m) => m.id === id);
    // 内置类型不可删 —— 菜单项已置灰,这里再挡一道(防绕过 UI 的调用)
    if (!meta || meta.builtin) return;
    if (!window.confirm(t("library.kind.deleteConfirm", { name: meta.name }))) return;
    const ok = await saveTypes(typeMetas.filter((m) => m.id !== id).map((m) => ({ ...m })));
    if (!ok) return;
    // 组表里挂着它的引用一并清掉,否则要等主进程下次合并校验才被过滤掉
    const grouped = await saveGroups(
      groups.map((g) => ({ ...g, kinds: g.kinds.filter((k) => k !== id) })),
    );
    if (!grouped) onRefresh();
    if (kind === id) setLocalKind(null);
  };

  /* ── 子集合:右键分类 → 在它下面新建 ── */

  const startNewChild = (c: LibraryCollection) => {
    setCreatingChildIn(c.id);
    setChildName("");
    setError(null);
  };

  const submitNewChild = async (c: LibraryCollection) => {
    const trimmed = childName.trim();
    if (!trimmed) {
      setCreatingChildIn(null);
      setChildName("");
      setError(null);
      return;
    }
    if (nameTaken(trimmed)) {
      // 保持输入框打开并提示,与新建根集合同一套手感
      setError(t("library.collection.duplicateName"));
      return;
    }
    try {
      // 直接走 api 而不是 store 的 createCollection:那边按全局 activeKind 落库,
      // 而子集合必须跟父集合同一个 kind —— 右键谁,建到谁下面、进谁的库。
      const res = await api.library.createCollection({ name: trimmed, parentId: c.id, kind: c.kind });
      await loadCollections();
      setCreatingChildIn(null);
      setChildName("");
      setError(null);
      // 与 store 同一个找法:同名同父里取最新的那条就是刚建的
      const created = res.collections
        .filter((x) => x.name === trimmed && x.parentId === c.id)
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      if (created) openCollection(created.id);
    } catch {
      setError(t("library.collection.createFailed"));
    }
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
    const items = allItemsByKind[kind];
    // 「全部<类型>」的名字同样按注册表来(自定义类拿不到 i18n key,退 kind 也能认)
    const label = t("library.view.allInKind", {
      kind: kindLibraryLabel(kind, typeMetas, locale),
    });
    const openAll = () => {
      setAllOpen(true);
      // 展开时才拉整个库的条目(没展开过就不拉 —— 与分类的懒加载一致)
      if (!allItemsByKind[kind]) void loadAllItems(kind);
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
            if (next && !allItemsByKind[kind]) void loadAllItems(kind);
          }}
          expandTitle={t("layout.expand")}
          collapseTitle={t("layout.collapse")}
          onClick={() => {
            // 点名字 = 选中它 + **切换展开态** —— 与分类行逐字一致(那边是
            // toggleExpanded)。上一版只写了"没展开就展开",于是点第二下什么都不发生。
            setActiveKind(kind);
            setActive(null);
            setRightPanelTab("library");
            setRightOpen(true);
            if (allOpen) setAllOpen(false);
            else openAll();
          }}
          // 悬停那个气泡把**整个库**挂进当前对话 —— 与「全部<类目>」那一行
          // 逐字同款。附件键是 `k:<库>`,对应的清单是一份索引(库里有什么),
          // 与挂一个分类(`c:<id>`,那个分类里有什么)是同一个机制的两个范围。
          actions={
            <RowAction
              title={t("library.ctx.attachToChat")}
              onClick={(e) => {
                e.stopPropagation();
                void attachToCurrentChat(`k:${kind}`);
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

        {/* 新建子集合的起名行 —— 同样挂在这行下面:右键谁,就建到谁下面 */}
        {creatingChildIn === c.id && (
          <InlineInputRow
            value={childName}
            onChange={setChildName}
            onSubmit={() => void submitNewChild(c)}
            onCancel={() => {
              setCreatingChildIn(null);
              setChildName("");
              setError(null);
            }}
            onBlur={() => void submitNewChild(c)}
            placeholder={t("library.collection.namePlaceholder")}
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
        {/* 子集合的起名行 —— 流模式没有层级可展开,但它照样建得出来(挂在行下) */}
        {creatingChildIn === c.id && (
          <InlineInputRow
            value={childName}
            onChange={setChildName}
            onSubmit={() => void submitNewChild(c)}
            onCancel={() => {
              setCreatingChildIn(null);
              setChildName("");
              setError(null);
            }}
            onBlur={() => void submitNewChild(c)}
            placeholder={t("library.collection.namePlaceholder")}
            error={error}
          />
        )}
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
      {/* 表头在最上、组内的类型标签在其下 —— 先有"这是什么"(组名),再有"看哪一类"
          (文献 / 教材 / 笔记…)。反过来会让人先看到一排并列的词、才反应过来它们在
          给什么分类。表头与「项目」表头同款;标题就是**组名**(左栏右键可改)。
          右键表头 = 大类的管理菜单(重命名 / 新建 / 删除)—— 管理全在左栏。 */}
      <div
        onContextMenu={(e) => {
          e.preventDefault();
          setManageError(null);
          setCtxGroup({ x: e.clientX, y: e.clientY });
        }}
      >
        <SectionHeader
          title={group.name}
          action={
            <HeaderAction
              title={t("library.collection.new")}
              onClick={() => {
                // 新建落在**本段当前**的 kind 上 —— store 的 createCollection 读的是
                // 全局 activeKind,而本段在兜底态时两者可能不一致,先对齐再开输入行。
                if (kind) setActiveKind(kind);
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
      </div>

      {/* 组内平级的类型:同一排、同样的入口,只是不能同时展开 ——
          把所有类型的树同时画出来会把左栏撑爆,而用户绝大多数时候只在一个类型里干活。
          点 tab 时同时记进 localKind:activeKind 之后去了别的组,本段仍停在这里。
          右键 tab = 小类的管理菜单(新建 / 重命名 / 删除)。 */}
      <SectionTabs
        tabs={tabs}
        active={kind}
        onChange={(k) => {
          setLocalKind(k);
          setActiveKind(k);
        }}
        onTabContextMenu={(k, e) => {
          setManageError(null);
          setCtxKind({ kind: k, x: e.clientX, y: e.clientY });
        }}
      />

      {/* 大类的新建 / 重命名输入 —— 菜单触发后就地摆一行(与集合行内输入同一套手感) */}
      {(creatingGroup || renamingGroup) && (
        <MiniInput
          value={groupDraft}
          onChange={(next) => {
            setGroupDraft(next);
            if (groupError) setGroupError(null);
          }}
          onSubmit={() => void (creatingGroup ? submitNewGroup() : submitRenameGroup())}
          onCancel={() => {
            setCreatingGroup(false);
            setRenamingGroup(false);
            setGroupDraft("");
            setGroupError(null);
          }}
          onBlur={() => void (creatingGroup ? submitNewGroup() : submitRenameGroup())}
          placeholder={t("library.group.namePlaceholder")}
          error={groupError}
        />
      )}

      {/* 小类的新建输入:名字 + 用途二选一 ——
          查资料用(material)= 给 AI 读的资料;照着写用(format)= 让 AI 照着写的格式。 */}
      {creatingKind && (
        <MiniInput
          value={newKindDraft}
          onChange={(next) => {
            setNewKindDraft(next);
            if (kindError) setKindError(null);
          }}
          onSubmit={() => void submitNewKind()}
          onCancel={() => {
            setCreatingKind(false);
            setNewKindDraft("");
            setKindError(null);
          }}
          onBlur={() => void submitNewKind()}
          placeholder={t("library.kind.namePlaceholder")}
          error={kindError}
        >
          <div className="flex gap-1 pt-1 pl-4">
            {(["material", "format"] as const).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setNewKindPurpose(p)}
                className={cn(
                  "rounded border px-1.5 py-0.5 text-[0.7857em] transition-colors",
                  newKindPurpose === p
                    ? "border-accent bg-surface-hover text-accent"
                    : "border-edge text-content-subtle hover:text-content",
                )}
              >
                {p === "material"
                  ? t("library.kind.purpose.material")
                  : t("library.kind.purpose.format")}
              </button>
            ))}
          </div>
        </MiniInput>
      )}

      {/* 小类的重命名输入 */}
      {renamingKind && (
        <MiniInput
          value={kindDraft}
          onChange={(next) => {
            setKindDraft(next);
            if (kindError) setKindError(null);
          }}
          onSubmit={() => void submitRenameKind()}
          onCancel={() => {
            setRenamingKind(null);
            setKindDraft("");
            setKindError(null);
          }}
          onBlur={() => void submitRenameKind()}
          placeholder={t("library.kind.namePlaceholder")}
          error={kindError}
        />
      )}

      {/* 菜单动作(删除等)的失败提示 —— 那时没有输入行可挂,统一落在这里 */}
      {manageError && !creatingGroup && !renamingGroup && !creatingKind && !renamingKind && (
        <div className="px-2 pb-1 text-[0.7857em] text-red-500">{manageError}</div>
      )}

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

      {/* 分类行的右键菜单:新建子集合 / 新建笔记(仅笔记库)/ 重命名 / 删除 */}
      <CollectionContextMenu
        target={ctxCollection}
        onClose={() => setCtxCollection(null)}
        onRename={(c) => startRename(c.id, c.name)}
        onDelete={(c) => void removeCollection(c.id, c.name)}
        onNewNote={startNewNote}
        onNewSubcollection={startNewChild}
      />

      {/* 大类标题行的右键菜单:重命名 / 新建 / 删除大类(管理全在左栏) */}
      <GroupContextMenu
        target={ctxGroup}
        onClose={() => setCtxGroup(null)}
        onRename={() => {
          setCreatingGroup(false);
          setRenamingGroup(true);
          setGroupDraft(group.name);
          setGroupError(null);
        }}
        onCreate={() => {
          setRenamingGroup(false);
          setCreatingGroup(true);
          setGroupDraft("");
          setGroupError(null);
        }}
        onDelete={() => void removeGroup()}
      />

      {/* 小类 tab 的右键菜单:新建 / 重命名 / 删除(内置类型删除项置灰) */}
      <KindContextMenu
        target={ctxKind}
        builtin={!!typeMetas.find((m) => m.id === ctxKind?.kind)?.builtin}
        onClose={() => setCtxKind(null)}
        onCreate={() => {
          setCreatingKind(true);
          setNewKindDraft("");
          setNewKindPurpose("material");
          setKindError(null);
        }}
        onRename={() => {
          const meta = typeMetas.find((m) => m.id === ctxKind?.kind);
          if (!meta) return;
          setRenamingKind(meta.id);
          setKindDraft(meta.name);
          setKindError(null);
        }}
        onDelete={() => {
          const id = ctxKind?.kind;
          if (id) void removeKind(id);
        }}
      />
    </>
  );
}

/**
 * 一个大类都没有时(全被删光)的兜底:至少给一个「新建大类」的入口。
 * 不然组删完整个区域消失,用户就再也没有办法在左栏重新分层了。
 */
function NewGroupFallback({ onCreate }: { onCreate: (name: string) => void }) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onCreate(trimmed);
    setName("");
  };
  return (
    <div className="px-1 py-2">
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
        onBlur={submit}
        placeholder={t("library.group.namePlaceholder")}
        className="w-full rounded border border-accent bg-surface px-2 py-1 text-xs text-content placeholder:text-content-subtle focus:outline-none"
      />
      <div className="pt-1 text-[0.7857em] text-content-subtle">{t("library.group.emptyHint")}</div>
    </div>
  );
}

/**
 * 左栏的整个「资料库」区域:**一段一个大类**,按组表循环渲染 LibrarySection。
 *
 * 组表来自主进程(`groupsGet`;出厂两组「文档 / 模版」,左栏右键可增删改)。
 * 旧的独立模版段(TemplateSection)已并进组里 —— 它那五类数据由主进程启动时自动
 * 迁移进统一库(标记 `library.templatesMigrated`),组件文件保留但不再挂载。
 *
 * 类型注册表在这里拉**一次**、往下传:各段共用一份,不必每段自己发请求。
 * 左栏的管理操作(大类/小类的新建删除改名)落库后回调 `reload` 重拉两份表,
 * 所有段即时跟上。groupsGet 失败时退回出厂两组 —— 与类型注册表同一个兜底思路:
 * 闪一下默认值比整段消失好。一个组都没有(全被删光)就给新建入口兜底。
 */
export function LibrarySections() {
  const [groups, setGroups] = useState<readonly LibraryGroupMeta[] | null>(null);
  const [typeMetas, setTypeMetas] = useState<readonly LibraryTypeMeta[]>(BUILTIN_LIBRARY_TYPES);

  useEffect(() => {
    void api.library
      .typesGet({})
      .then((res) => setTypeMetas(res.types))
      .catch(() => {});
    void api.library
      .groupsGet({})
      .then((res) => setGroups(res.groups))
      .catch(() => setGroups(DEFAULT_LIBRARY_GROUPS));
  }, []);

  /** 左栏管理操作落库后的重拉:组表 + 类型注册表一起,各段即时跟上。 */
  const reload = () => {
    void api.library
      .typesGet({})
      .then((res) => setTypeMetas(res.types))
      .catch(() => {});
    void api.library
      .groupsGet({})
      .then((res) => setGroups(res.groups))
      .catch(() => {});
  };

  // 还没拉到组表:先不画(一帧空白),避免闪一个错误的空状态
  if (!groups) return null;
  if (groups.length === 0) {
    return (
      <NewGroupFallback
        onCreate={(name) => {
          void api.library
            .groupsSave({ groups: [{ id: `group-${Date.now().toString(36)}`, name, kinds: [] }] })
            .then((res) => {
              if (res.ok) reload();
            });
        }}
      />
    );
  }
  return (
    <div className="space-y-3">
      {groups.map((group) => (
        <LibrarySection
          key={group.id}
          group={group}
          typeMetas={typeMetas}
          groups={groups}
          onRefresh={reload}
        />
      ))}
    </div>
  );
}
