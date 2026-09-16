/**
 * 左栏「模版」段的缓存。
 *
 * ## 为什么要有 store,而不是像 TemplatesPanel 那样 `useState`
 *
 * 左栏在两套外壳里各挂一次(`LeftBar` 树模式 / `StreamSidebar` 会话流模式,由顶部那个
 * 切换图标决定),切一次就整个重挂载 —— 展开态和列表留在组件里会被清空。文献库当年就是
 * 因为这个把 `expandedIds` 提到 store 里的(见 libraryStore 顶部的说明),模版照办。
 *
 * ## 一句话:它和文献库那套是**同一个东西**,只是内容不同
 *
 * 用户的原话是「模版和文档是同级别的,只不过给 ai 的提示词不一样,只有这个区别。
 * 文档部分的做法是每个部分都有自己独立的回收站…模版也应该这么做」。所以这里的形状
 * 刻意与 `libraryStore` 对齐:类目 = 那边的"库"(标签切换),模版 = 那边的"分类"
 * (可展开、有 hover 操作、能右键、删除先进回收站),模版里的文件 = 那边的"文献"。
 * 左栏那段列表的层次也照抄:
 *
 *   「全部<类目>」在最上面 → 这个类目下的模版 → 「回收站」在最下面
 *   (模版行与「全部」**同级**,和文献库那边「分类」与「全部文献」的关系一字不差)
 *
 * 三个类目各有**自己的**回收站(主进程那边是 `<类目>/回收站/` 目录),删东西同样是
 * **两步**:先移进回收站(可逆),在回收站里删才是真删。
 *
 * ## 为什么一次拉全部类目 + 回收站
 *
 * 每个标签上都要显示条数(与文献库 文献 / 教材 / 笔记 三个标签逐字同款),回收站行
 * 也要显示各自那个类目里有几条 —— 所以无论当前在看哪个,五个类目和它们的回收站都得
 * 知道有几个。模版库是文件系统,一次列全就是一趟目录扫描 —— 比"先拉计数再拉列表"
 * 两条路简单。代价是每条模版都会 stat 一遍里面的文件(`listTemplates` 就是这么实现
 * 的),大模版库首次加载要几百毫秒;之后切标签是纯内存操作。
 *
 * ## 两条入口怎么保持一致
 *
 * 模版有两个入口:左栏这一段、设置 → 数据位置 → 模版库。各自有缓存,而磁盘是事实源
 * —— 所以主进程在增删改时发一条 `templates:changed`,这里订阅它重拉一次(与文献库
 * 订阅 `library:changed` 是同一条路子)。本 store 自己的增删则拿主进程返回的新列表
 * 就地替换,省一次全量扫描。
 */
import { create } from "zustand";
import type { TemplateEntry, TemplateKind } from "@contracts/templates";
import type { TemplateFileRefInput } from "@contracts/ipc";
import { api } from "@renderer/lib/api.js";

/** 预览哪个文件 —— 与主进程 `TEMPLATES_READ_FILE` 的入参同一形状。 */
type TemplateFileRef = TemplateFileRefInput;

interface TemplateState {
  /** 五个类目的模版(不含回收站)。同类目内按目录 mtime 倒序。 */
  entries: TemplateEntry[];
  /** 回收站里的模版。`kind` 是它**原来**属于的类目 —— 还原要用。 */
  trashed: TemplateEntry[];
  /**
   * 正在看哪个"页"。**只有五个类目,回收站不是页** —— 每个类目各有一个回收站行,
   * 挂在那个类目的列表最下面(与文献库三个库各有一个回收站分类逐字同款:
   * 「每个部分都有自己独立的回收站」+「回收站在最下面」)。
   *
   * 放在 store 里而不是组件里 —— 与文献库的 `activeKind` 同一个理由:切「树 / 会话流」
   * 时组件会重挂载,留在组件里会被重置回默认值。
   */
  activeTab: TemplateKind;
  /** 拉过一次没有(不管成没成)。用来区分"还没拉"和"拉了但是空的"。 */
  loaded: boolean;
  /** 拉失败(移动端、或后端异常)。左栏要如实说,不能显示成"这个类目还没有模版"。 */
  failed: boolean;
  /** 哪些模版是展开的。键由 `templateAttachKey(kind, dirName)`(contracts)生成。 */
  expanded: Record<string, boolean>;
  /**
   * 「全部<类目>」那一行展开着没有。按类目记,**默认收起**。
   *
   * 与文献库那一段的「全部文献」完全一致(用户的要求是两段"得一样"):它是这一段的
   * 根节点 —— 展开看"这一类目下的全部文件",收起时下面同样列得出模版。
   */
  expandedAll: Partial<Record<TemplateKind, boolean>>;
  /** 回收站行是否展开。默认**收起** —— 它平时不该占位置,是用户主动去看的东西。 */
  expandedTrash: Partial<Record<TemplateKind, boolean>>;
  /**
   * 正在**应用内预览**的那个文件(左栏文件行点出来的)。
   *
   * 放 store 而不是组件里,理由和上面几条一样:左栏在两套外壳里各挂一次,而预览
   * 面板在右栏 —— 它们不是同一棵子树,只能靠 store 传递"现在看的是哪个文件"。
   */
  previewFile: TemplateFileRef | null;
  load: () => Promise<void>;
  setActiveTab: (tab: TemplateKind) => void;
  toggle: (key: string) => void;
  /** 展开 / 收起「全部<类目>」那一行。 */
  toggleAll: (kind: TemplateKind) => void;
  /** 收起 / 展开这个类目的回收站行。 */
  toggleTrash: (kind: TemplateKind) => void;
  /** 打开预览。调用方负责把右栏切到「模版」标签。 */
  openFile: (entry: TemplateEntry, relPath: string) => void;
  closePreview: () => void;
  /** 新建。成功时把该类目的列表就地换成主进程返回的那一份,不用整体重扫。 */
  add: (
    kind: TemplateKind,
    name: string,
    sourcePaths: string[],
  ) => Promise<{ ok: boolean; error?: string }>;
  /**
   * 改名 —— 改的是**磁盘上那个目录**(这个库的约定:目录名即显示名)。
   *
   * 与文献库改分类名是同一件事的两个形态,所以左栏那两段的行尾按钮与右键菜单里
   * 都有它。`ok:false` 是正常结果(重名 / 目录已经不在了),调用方把 error 显示出来
   * 并让输入框留着 —— 让用户能直接改,而不是关掉再点一次。
   */
  rename: (
    entry: TemplateEntry,
    name: string,
  ) => Promise<{ ok: boolean; error?: string; dirName?: string }>;
  /** 删除 = **移进回收站**(可逆)。 */
  trash: (entry: TemplateEntry) => Promise<void>;
  /** 从回收站还原回原来的类目。目标被占用时返回 ok:false(不覆盖)。 */
  restore: (entry: TemplateEntry) => Promise<{ ok: boolean; error?: string }>;
  /** 从回收站**彻底删除** —— 不可还原。 */
  purge: (entry: TemplateEntry) => Promise<{ ok: boolean; error?: string }>;
}

/** 把某个类目的列表换成新的一份 —— `add` / `remove` 的返回都只含那一个类目。 */
function replaceKind(
  all: TemplateEntry[],
  kind: TemplateKind,
  next: TemplateEntry[],
): TemplateEntry[] {
  return [...all.filter((e) => e.kind !== kind), ...next];
}

export const useTemplateStore = create<TemplateState>((set, get) => ({
  entries: [],
  trashed: [],
  // 默认落在论文 LaTeX 上 —— 用户的模版绝大多数是论文相关的那几套,与设置页
  // 「模版库」面板的默认值也一致(TemplatesPanel 的 useState 初值也是 latex)
  activeTab: "latex",
  loaded: false,
  failed: false,
  expanded: {},
  expandedAll: {},
  expandedTrash: {},
  previewFile: null,

  load: async () => {
    try {
      // 两个列表一起拉:类目标签上要显示条数,回收站标签上也要 —— 少一个,那个标签
      // 就会在用户没丢过东西时显示成"空",而它其实只是还没拉
      const [list, trash] = await Promise.all([
        api.templates.list({}),
        api.templates.trashList(),
      ]);
      set({ entries: list.entries, trashed: trash.trashed, loaded: true, failed: false });
    } catch {
      // 移动端的 web shim 在访问 `api.templates` 那一下就同步抛错(整个命名空间没映射),
      // 所以这里包住的是整句、不是只有 await 那一段 —— 少了它,失败会逃出 effect 把
      // React 19 的整棵树带下去(见 webApi 顶部与 TemplatePicker 的同一处说明)。
      set({ loaded: true, failed: true });
    }
  },

  toggle: (key) => set((s) => ({ expanded: { ...s.expanded, [key]: !s.expanded[key] } })),

  toggleAll: (kind) =>
    set((s) => ({ expandedAll: { ...s.expandedAll, [kind]: !s.expandedAll[kind] } })),

  toggleTrash: (kind) =>
    set((s) => ({ expandedTrash: { ...s.expandedTrash, [kind]: !s.expandedTrash[kind] } })),

  setActiveTab: (tab) => set({ activeTab: tab }),

  openFile: (entry, relPath) =>
    set({ previewFile: { kind: entry.kind, dirName: entry.dirName, relPath } }),

  closePreview: () => set({ previewFile: null }),

  add: async (kind, name, sourcePaths) => {
    try {
      const res = await api.templates.add({ kind, name, sourcePaths });
      set((s) => ({ entries: replaceKind(s.entries, kind, res.entries) }));
      return { ok: true };
    } catch (err) {
      // 重名、复制失败都要如实回给调用方显示 —— 静默什么都不发生是最糟的
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },

  rename: async (entry, name) => {
    try {
      const res = await api.templates.rename({
        kind: entry.kind,
        dirName: entry.dirName,
        name,
      });
      set((s) => ({
        entries: replaceKind(s.entries, entry.kind, res.entries),
        // 被改名的可能正是右栏在预览的那一条 —— 键里的目录名跟着换,否则面板会拿
        // 旧名字去读文件,读不到(那条错误信息还看不懂)
        previewFile:
          s.previewFile &&
          s.previewFile.kind === entry.kind &&
          s.previewFile.dirName === entry.dirName
            ? { ...s.previewFile, dirName: res.dirName ?? entry.dirName }
            : s.previewFile,
      }));
      return { ok: res.ok, error: res.error, dirName: res.dirName };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },

  trash: async (entry) => {
    try {
      const res = await api.templates.trash({ kind: entry.kind, dirName: entry.dirName });
      set((s) => ({ entries: replaceKind(s.entries, entry.kind, res.entries), trashed: res.trashed }));
    } catch {
      // 删失败(目录已经被人从磁盘上删了、权限不够)—— 重拉一次,把真实状态显示出来
      await get().load();
    }
  },

  restore: async (entry) => {
    try {
      const res = await api.templates.restore({ kind: entry.kind, dirName: entry.dirName });
      set((s) => ({ entries: replaceKind(s.entries, entry.kind, res.entries), trashed: res.trashed }));
      return { ok: res.ok, error: res.error };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },

  purge: async (entry) => {
    try {
      const res = await api.templates.purge({ kind: entry.kind, dirName: entry.dirName });
      set((s) => ({
        entries: replaceKind(s.entries, entry.kind, res.entries),
        trashed: res.trashed,
        // 被删掉的可能正是右栏正在预览的那一条 —— 文件已经没了,预览收掉,
        // 否则面板会停在一个读不到的文件上(那条错误信息还看不懂)
        previewFile:
          s.previewFile &&
          s.previewFile.kind === entry.kind &&
          s.previewFile.dirName === entry.dirName
            ? null
            : s.previewFile,
      }));
      return { ok: res.ok, error: res.error };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
}));
