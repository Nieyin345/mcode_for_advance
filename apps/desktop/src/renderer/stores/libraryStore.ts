/**
 * 文献库的全局状态。
 *
 * 单独开一个 store 而不是往 `sessionStore` 里塞:`sessionStore` 已经一万多行,
 * 而文献库与「会话/项目」是**正交**的概念(用户明确要求两者独立),混在一起只会
 * 让两边的语义都变糊。
 *
 * ## 两个「当前库」是不同的事,不要合并
 *
 *   - `activeCollectionId` —— **主区正在看哪个库**(左栏点击的结果)
 *   - `chatCollectionId`   —— **当前对话绑定哪个库**(决定 AI 能读哪些文献)
 *
 * 它们确实不同:用户完全可能一边看 A 库的文献列表,一边在和 AI 聊 B 库的内容。
 * 硬绑成一个字段会逼用户二选一。
 *
 * ## 「文献检索」模式已经搬走了
 *
 * 早先这里有个 `searchMode` 布尔。现在输入框的模式是一整套选择器(默认 / 文献检索 /
 * 文献精读 / 文献写作 / 文献评审 / 代码编辑),它**跟着会话走**,所以归
 * `sessionStore.workflowId` 管,不再是这里的一个全局开关。
 */
import { create } from "zustand";
import type { LibraryCollection, LibraryItem } from "@contracts/library";
import { api } from "@renderer/lib/api.js";

/** 左栏一次最多列多少篇。展开是浏览,不是检索 —— 再多就该去右栏搜了。 */
const TREE_PAGE = 200;

// IPC can return out of order (e.g. an import refresh overtakes an expanded tree
// request). A later request/mutation owns the cache; older responses must not
// paint a previously selected item or a deleted collection back into the UI.
let collectionsRequest = 0;
let itemsRequest = 0;
const latestItemsRequest = new Map<string, number>();
let allItemsRequest = 0;

interface LibraryState {
  /** 全部文献库(Zotero 意义上的 collection)。左栏与选择器共用这一份缓存。 */
  collections: LibraryCollection[];
  /**
   * 当前在哪个大类下（kind 退役后：左栏按大类分段，段内就是分类树）。
   */
  activeGroupId: string | null;
  /** 主区正在展示的库;null 表示没在看任何库(主区回到会话视图)。 */
  activeCollectionId: string | null;
  /** 右栏文献库面板里当前打开的那一篇。左栏点文献也是写这里。 */
  activeItemId: string | null;
  /**
   * 详情屏当前看哪一页:**元数据** / **原文(Markdown)** / **PDF 原文**。
   *
   * 放在 store 而不是面板的局部 state,是因为「打开预览」这个动作
   * 从**左栏的右键菜单**发出 —— 那里碰不到面板的局部状态。两边读写同一份,才不会
   * 出现"菜单说要预览、面板还停在元数据"。
   *
   * ⚠️ 它现在只有 `edit` 还有活着的消费者(笔记条目点开直接落在编辑页)。其余几个值
   * 是**上一版右栏那个 `library` 面板**留下的 —— 那个面板 2026-09-21 已删,右栏改成
   * 了单一「预览」(见 `PreviewPanel`,它不读这一格)。
   */
  detailTab: "meta" | "preview" | "pdf" | "file" | "edit";
  /**
   * **右栏预览**此刻看的是哪一份(2026-09-21)。`null` = 本体。
   *
   * 论文这类记录有两个可看的东西:PDF 原件与 md 转录。用户要的是「点击和双击都显示
   * 这个 PDF 本身」,转录另外从右键看 —— 所以这里用一个显式的字段表达"我现在要看转录",
   * 而不是靠猜条目有什么。
   *
   * 它**与条目同生共死**:换条目(`setActiveItem`)必须清掉它,否则点完 A 的转录再去点
   * B,右栏会显示 B 的 PDF、而菜单那一项还勾着"转录"。
   */
  previewWhich: "pdf" | "md" | null;
  /** 当前对话绑定的库 —— 决定 AI 能读哪些文献。null = 不绑库。 */
  chatCollectionId: string | null;
  /** 首次加载是否已完成(用于区分「空库」与「还没加载」)。 */
  loaded: boolean;

  /**
   * 左栏里哪些库被展开了。
   *
   * 放在 store 而不是组件里,和 `sessionStore` 的 `expandedProjects` 同一套机制。
   * 这一点是「切换图标一起控制」的关键:树模式与会话流模式挂载的是同一个
   * LibrarySection,展开态、文献缓存在两种模式之间共享,不会一切换就丢。
   */
  expandedIds: Record<string, boolean>;
  /** 每个库的文献缓存。展开时才拉,避免一进应用就把整库读进内存。 */
  itemsByCollection: Record<string, LibraryItem[]>;
  /**
   * 「全部<库>」这一层展开时要显示的条目(**整个库**,不限分类)。按库缓存。
   *
   * 为什么必须有它:左树原来只画"分类里的条目",于是**不属于任何分类的条目在左栏里
   * 完全不存在** —— 用户看得到它(右栏),却没法右键它、也就移动不了(用户报的正是这个)。
   */
  /** 「全部显示」时拿的条目缓存（全库口径）。 */
  allItems: LibraryItem[] | null;
  /** 全库条目**总数**(主进程 `library.list` 的 `total`)。`allItems` 只取前
   *  {@link TREE_PAGE} 条,`total > allItems.length` 时"全部显示"视图要如实写一句
   *  "还有 N 条" —— 否则孤儿条目(不属于任何分类、只在"全部"里看得见)会被静默漏掉。 */
  allItemsTotal: number;

  loadCollections: () => Promise<void>;
  /** 新建并返回 id。归属必须来自触发新建的那个大类，不能沿用上次选中分类的大类。 */
  createCollection: (name: string, groupId: string, parentId?: string | null) => Promise<string | null>;
  setActiveCollection: (id: string | null) => void;
  setActiveItem: (id: string | null) => void;
  setDetailTab: (tab: "meta" | "preview" | "pdf" | "file" | "edit") => void;
  /** 打开某一篇的原文预览 —— 左栏右键菜单用。一次写两个字段,避免出现
   *  「选中了新条目、标签还停在旧状态」的中间帧。 */
  openPreview: (id: string, which?: "pdf" | "md") => void;
  setChatCollection: (id: string | null) => void;
  /** 展开/收起某个库;展开时顺带拉一次它的文献列表。 */
  toggleExpanded: (id: string) => void;
  /** **确保**某个库是展开的(已是展开态则不动)。与 `toggleExpanded` 的区别:那个是"翻转",
   *  这个在 `submitNewNote` 那类"先展开、再走 openCollection(内部又翻转一次)"的地方才安全
   *  —— 两次翻转会抵消,库反而**收起**,用户看不到刚建的那篇。 */
  expandCollection: (id: string) => void;
  loadCollectionItems: (id: string) => Promise<void>;
  /** 拉全库条目（「全部显示」用）。 */
  loadAllItems: () => Promise<void>;
  /** 会话流模式要一次看到所有库的文献 —— 逐个拉。 */
  loadEveryCollectionItems: () => Promise<void>;
  /** 文献增删后让左栏跟上(展开态保留,只刷新内容)。 */
  refreshItems: () => Promise<void>;
}

export const useLibraryStore = create<LibraryState>((set, get) => ({
  collections: [],
  activeGroupId: null,
  activeCollectionId: null,
  activeItemId: null,
  detailTab: "meta",
  previewWhich: null,
  chatCollectionId: null,
  loaded: false,
  expandedIds: {},
  itemsByCollection: {},
  allItems: null,
  allItemsTotal: 0,

  loadCollections: async () => {
    const request = ++collectionsRequest;
    try {
      const res = await api.library.listCollections();
      if (request !== collectionsRequest) return;
      set({ collections: res.collections, loaded: true });
      // 选中的库可能已被删除 —— 清掉,否则主区会停在一个不存在的库上
      const { activeCollectionId, chatCollectionId } = get();
      const ids = new Set(res.collections.map((c) => c.id));
      for (const id of latestItemsRequest.keys()) {
        if (!ids.has(id)) latestItemsRequest.delete(id);
      }
      if (activeCollectionId && !ids.has(activeCollectionId)) set({ activeCollectionId: null });
      if (chatCollectionId && !ids.has(chatCollectionId)) set({ chatCollectionId: null });
      // 同理,被删掉的库的文献缓存也一并丢掉,免得它留在左栏里
      const cache = get().itemsByCollection;
      const stale = Object.keys(cache).filter((id) => !ids.has(id));
      if (stale.length > 0) {
        const next = { ...cache };
        for (const id of stale) delete next[id];
        set({ itemsByCollection: next });
      }
    } catch {
      // 库还没建好(首次启动)或主进程未就绪 —— 保持空列表,不抛
      if (request === collectionsRequest) set({ loaded: true });
    }
  },

  createCollection: async (name, groupId, parentId = null) => {
    // 主进程会把名字 trim 后落库,这里也必须按 trim 后的值去匹配新建的那条 ——
    // 否则用户输入带首尾空格时匹配不上,调用方会误判成「创建失败/重名」。
    const trimmed = name.trim();
    const res = await api.library.createCollection({ name: trimmed, parentId, groupId });
    // A listing started before this mutation is no longer authoritative.
    ++collectionsRequest;
    set({ collections: res.collections, loaded: true });
    // 取本次**目标大类**下最新的那条；别把其他大类的同名项误认成新建成功。
    const created = res.collections
      .filter((c) => c.name === trimmed && c.parentId === parentId && c.groupId === groupId)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    return created?.id ?? null;
  },

  setActiveCollection: (id) => {
    // 选中分类时顺带记住它挂着的大类 —— 大类是现在唯一的分段维度。
    const groupId = id ? get().collections.find((c) => c.id === id)?.groupId : undefined;
    set({ activeCollectionId: id, ...(groupId ? { activeGroupId: groupId } : {}) });
  },
  setActiveItem: (id) => set({ activeItemId: id, previewWhich: null }),
  setDetailTab: (tab) => set({ detailTab: tab }),
  openPreview: (id, which) =>
    set({ activeItemId: id, previewWhich: which ?? null, detailTab: "preview" }),
  setChatCollection: (id) => set({ chatCollectionId: id }),

  toggleExpanded: (id) => {
    const next = !get().expandedIds[id];
    set((s) => ({ expandedIds: { ...s.expandedIds, [id]: next } }));
    // 只在没缓存时拉。收起不清缓存 —— 再展开应当是即时的。
    if (next && !get().itemsByCollection[id]) void get().loadCollectionItems(id);
  },

  expandCollection: (id) => {
    if (get().expandedIds[id]) return; // 已是展开态:什么都不做(这正是与 toggle 的区别)
    set((s) => ({ expandedIds: { ...s.expandedIds, [id]: true } }));
    if (!get().itemsByCollection[id]) void get().loadCollectionItems(id);
  },

  loadCollectionItems: async (id) => {
    const request = ++itemsRequest;
    latestItemsRequest.set(id, request);
    try {
      const res = await api.library.list({ collectionId: id, limit: TREE_PAGE });
      if (latestItemsRequest.get(id) !== request) return;
      if (get().loaded && !get().collections.some((c) => c.id === id)) return;
      set((s) => ({ itemsByCollection: { ...s.itemsByCollection, [id]: res.items } }));
    } catch {
      // 主进程未就绪 —— 保持空列表,不抛
    }
  },

  loadAllItems: async () => {
    const request = ++allItemsRequest;
    try {
      const res = await api.library.list({ limit: TREE_PAGE });
      if (request === allItemsRequest) set({ allItems: res.items, allItemsTotal: res.total });
    } catch {
      // 主进程未就绪 —— 保持空,不抛
    }
  },

  loadEveryCollectionItems: async () => {
    const { collections, loadCollectionItems } = get();
    await Promise.all(collections.map((c) => loadCollectionItems(c.id)));
  },

  refreshItems: async () => {
    // 只刷新**已经拉过**的（展开过的，或「全部显示」开过的）。没拉过的等展开时再拉。
    const { itemsByCollection, allItems, loadCollectionItems, loadAllItems } = get();
    await Promise.all([
      ...Object.keys(itemsByCollection).map((id) => loadCollectionItems(id)),
      ...(allItems ? [loadAllItems()] : []),
    ]);
  },
}));
