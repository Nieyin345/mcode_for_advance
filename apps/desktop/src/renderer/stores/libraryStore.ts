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
import type { LibraryCollection, LibraryItem, LibraryKind } from "@contracts/library";
import { api } from "@renderer/lib/api.js";

/** 左栏一次最多列多少篇。展开是浏览,不是检索 —— 再多就该去右栏搜了。 */
const TREE_PAGE = 200;

interface LibraryState {
  /** 全部文献库(Zotero 意义上的 collection)。左栏与选择器共用这一份缓存。 */
  collections: LibraryCollection[];
  /**
   * 当前在看哪个库:**论文 / 教材 / 笔记**。三个库是平级的,左栏顶部用一排标签切换,
   * 切换之后下面的分类树与列表都只属于这个库。
   *
   * 为什么不做成"同时画出三棵树":那会把左栏撑成三倍高,而用户绝大多数时候只在
   * 一个库里干活。标签页让三个库仍然**同级**(同一排、同样的入口),又不必同时展开。
   */
  activeKind: LibraryKind;
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
  allItemsByKind: Partial<Record<LibraryKind, LibraryItem[]>>;

  loadCollections: () => Promise<void>;
  /** 新建并返回新库的 id(方便调用方立刻选中它)。建在 activeKind 那个库里。 */
  createCollection: (name: string, parentId?: string | null) => Promise<string | null>;
  setActiveCollection: (id: string | null) => void;
  setActiveKind: (kind: LibraryKind) => void;
  setActiveItem: (id: string | null) => void;
  setDetailTab: (tab: "meta" | "preview" | "pdf" | "file" | "edit") => void;
  /** 打开某一篇的原文预览 —— 左栏右键菜单用。一次写两个字段,避免出现
   *  「选中了新条目、标签还停在旧状态」的中间帧。 */
  openPreview: (id: string, which?: "pdf" | "md") => void;
  setChatCollection: (id: string | null) => void;
  /** 展开/收起某个库;展开时顺带拉一次它的文献列表。 */
  toggleExpanded: (id: string) => void;
  loadCollectionItems: (id: string) => Promise<void>;
  /** 拉某个库的**全部**条目(不限分类),给左树里「全部<库>」那一层的子列表用。 */
  loadAllItems: (kind: LibraryKind) => Promise<void>;
  /** 会话流模式要一次看到所有库的文献 —— 逐个拉。 */
  loadEveryCollectionItems: () => Promise<void>;
  /** 文献增删后让左栏跟上(展开态保留,只刷新内容)。 */
  refreshItems: () => Promise<void>;
}

export const useLibraryStore = create<LibraryState>((set, get) => ({
  collections: [],
  activeKind: "paper",
  activeCollectionId: null,
  activeItemId: null,
  detailTab: "meta",
  previewWhich: null,
  chatCollectionId: null,
  loaded: false,
  expandedIds: {},
  itemsByCollection: {},
  allItemsByKind: {},

  loadCollections: async () => {
    try {
      const res = await api.library.listCollections();
      set({ collections: res.collections, loaded: true });
      // 选中的库可能已被删除 —— 清掉,否则主区会停在一个不存在的库上
      const { activeCollectionId, chatCollectionId } = get();
      const ids = new Set(res.collections.map((c) => c.id));
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
      set({ loaded: true });
    }
  },

  createCollection: async (name, parentId = null) => {
    // 主进程会把名字 trim 后落库,这里也必须按 trim 后的值去匹配新建的那条 ——
    // 否则用户输入带首尾空格时匹配不上,调用方会误判成「创建失败/重名」。
    const trimmed = name.trim();
    try {
      const res = await api.library.createCollection({ name: trimmed, parentId, kind: get().activeKind });
      set({ collections: res.collections });
      // 取**最新**的那条（按 createdAt 倒序）—— 与 sortOrder 无关，
      // 所以新建的排最前还是最后都不影响这里找 id。
      const created = res.collections
        .filter((c) => c.name === trimmed && c.parentId === parentId)
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      return created?.id ?? null;
    } catch {
      return null;
    }
  },

  setActiveCollection: (id) => {
    // 选中的分类属于哪个库,就把标签切到那个库 —— 否则会出现"右栏在看笔记,
    // 左栏高亮着论文库的分类"这种自相矛盾的状态
    const kind = id ? get().collections.find((c) => c.id === id)?.kind : undefined;
    set(kind ? { activeCollectionId: id, activeKind: kind } : { activeCollectionId: id });
  },
  setActiveKind: (kind) =>
    set((s) => {
      // 切库时清掉选中态:旧库的分类在新库里不存在,留着会让右栏停在幽灵条目上
      const stillValid = s.collections.some(
        (c) => c.id === s.activeCollectionId && c.kind === kind,
      );
      return {
        activeKind: kind,
        activeCollectionId: stillValid ? s.activeCollectionId : null,
        activeItemId: stillValid ? s.activeItemId : null,
        // 条目被清掉时"看哪一份"也得跟着清,否则切回来看见的是上一条的转录
        previewWhich: stillValid ? s.previewWhich : null,
      };
    }),
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

  loadCollectionItems: async (id) => {
    try {
      const res = await api.library.list({ collectionId: id, limit: TREE_PAGE });
      set((s) => ({ itemsByCollection: { ...s.itemsByCollection, [id]: res.items } }));
    } catch {
      // 主进程未就绪 —— 保持空列表,不抛
    }
  },

  loadAllItems: async (kind) => {
    try {
      const res = await api.library.list({ kind, limit: TREE_PAGE });
      set((s) => ({ allItemsByKind: { ...s.allItemsByKind, [kind]: res.items } }));
    } catch {
      // 主进程未就绪 —— 保持空,不抛
    }
  },

  loadEveryCollectionItems: async () => {
    // 只拉**当前这个库**的分类 —— 另外两个库的列表用户现在看不见,拉了也是白拉
    const { collections, activeKind, loadCollectionItems } = get();
    await Promise.all(
      collections.filter((c) => c.kind === activeKind).map((c) => loadCollectionItems(c.id)),
    );
  },

  refreshItems: async () => {
    // 只刷新**已经拉过**的库(展开过的,或会话流模式下全量拉过的)。没拉过的
    // 等展开时再拉 —— 否则每来一条下载完成事件都要把整库读一遍。
    const { itemsByCollection, allItemsByKind, loadCollectionItems, loadAllItems } = get();
    await Promise.all([
      ...Object.keys(itemsByCollection).map((id) => loadCollectionItems(id)),
      // 「全部<库>」那一层也只在展开过之后才刷
      ...Object.keys(allItemsByKind).map((k) => loadAllItems(k as LibraryKind)),
    ]);
  },
}));
