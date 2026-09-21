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
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { kindLibraryLabel } from "@renderer/lib/libraryLabels.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useLibraryStore } from "@renderer/stores/libraryStore.js";
import { useFileViewStore, basenameOf } from "@renderer/stores/fileViewStore.js";
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
  IconChevronRight,
  IconFileText,
  IconFiles,
  IconMessage,
  IconPencil,
  IconPlus,
  IconTrash,
  IconX,
} from "@renderer/lib/icons.js";
import { attachToCurrentChat } from "@renderer/lib/attachToChat.js";
import { Dialog } from "@renderer/components/ui/dialog.js";
import { Divider } from "@renderer/components/layout/Divider.js";
import { useToastStore } from "@renderer/stores/toastStore.js";
import { formatCitation, type CitationStyle } from "@contracts/citation";
import { copyText } from "@renderer/lib/clipboard.js";
import {
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
import { DeleteItemsDialog } from "./DeleteItemsDialog.js";
import { ImportBar } from "./ImportPanel.js";
import { ItemLinksDialog, ItemInfoDialog, CollectionInfoDialog } from "./ItemDetail.js";
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
  inline = false,
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
  /**
   * **行内模式** —— 去掉那圈 `px-1 pb-1` 的外边距（2026-09-21）。
   *
   * 这个组件平时是"列表外独立一行"（左边留白、下面留白），而放进 `SectionTabs` 的
   * `trailing` 时，它会成为那一排里的一个**格子** —— 再带一圈外边距就跟旁边的 tab
   * 对不齐了。
   */
  inline?: boolean;
}) {
  return (
    <div className={inline ? undefined : "px-1 pb-1"}>
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
          // ⚠️ **不能是 `w-full`**（2026-09-21）。用户报两件事：「新建的输入框太长」、
          // 「新建小类的位置还是不对」。根因是同一个 —— `w-full` 在 flex 容器里等于
          // **撑满整行**，所以塞进 tab 排（`SectionTabs` 的 `trailing`）时它会独占
          // 一行、把后面的行推下去，看起来"不在那一排里"、而且长得离谱。
          //
          // 改成一个**跟着内容走的行内宽度**：放进 tab 排时它就在最后那个 tab 旁边，
          // 单用（新建大类那种）时也只是一个不长的框。
          // `6rem`：用户说「窄一点，现在太宽了」。分类名通常就几个字。
          "w-[6rem] rounded border bg-surface px-2 py-1 text-xs text-content focus:outline-none",
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
  isLastSection = false,
  trashOnly = false,
  trashItemsOnly = false,
}: {
  /** 本段对应的大类(段名 + 段内哪些类型)。由 `LibrarySections` 按组表传入。 */
  group: LibraryGroupMeta;
  /** 类型注册表(上游拉一次后传下来):tab 名与「全部<类型>」的显示名都取自它。 */
  typeMetas: readonly LibraryTypeMeta[];
  /** 整份大类表 —— 新建/删除大类要在它上面增删,光有本段的 group 不够。 */
  groups: readonly LibraryGroupMeta[];
  /** 大类/小类的任何变更落库后调用:父层重拉组表与注册表,各段立即跟上。 */
  onRefresh: () => void;
  /** 是不是最后一段 —— **回收站只在最后一段画**(整片区域的最底部)。见那处注释。 */
  isLastSection?: boolean;
  /**
   * **只画回收站那一块**，别的一个都不画（2026-09-21）。
   *
   * 回收站要**钉死在左栏最底部**，不跟着上面的列表滚 —— 而滚动容器是 `LeftBar`
   * 那一层的，这个组件管不着。所以把回收站单独挂一次到滚动容器**外面**，
   * 由这个开关切到"只有回收站"那一档。
   *
   * 复用整个组件而不是另写一个，是因为那一行依赖一堆内部状态（展开态、条目缓存、
   * 三个右键菜单、行内改名）—— 另写一份必然漂移。
   */
  trashOnly?: boolean;
  /**
   * **只画回收站里的条目**（2026-09-21）——不画"回收站"那一行。
   *
   * 用户的原话：「回收站**不要折叠**，**直接把文件排列上去**就行了呀」。
   * 所以浮层里不该再有"一个叫回收站的分类行等你点开"，而是**一进去就是那批文件**。
   */
  trashItemsOnly?: boolean;
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
  const setCenterTabFocus = useSessionStore((s) => s.setCenterTabFocus);
  const openFileView = useFileViewStore((s) => s.open);

  /**
   * 「全部显示」开着的那几个 **kind**。
   *
   * 用户要求「右键小类可以选择全部显示」—— 所以它是**每个小类各自**的一个开关,
   * 不是一个全局模式。用 Set 而不是"当前 kind 的布尔值":切到别的 tab 再切回来,
   * 用户刚才打开的那个视图应当还在(他并没有关掉它)。
   *
   * 局部状态,不进 store:与展开态不同,它不跨组件重挂载保留。切左栏模式(树/流)
   * 会重挂载,那时回到"只有分类"的默认视图 —— 最保守的默认,不会让用户回来时
   * 面对一个他忘了自己打开过的模式。
   */
  const [showAllKinds, setShowAllKinds] = useState<ReadonlySet<string>>(new Set());
  /**
   * **整段折起来**(大类这一级自己)。
   *
   * 用户要的是「每一级都能折叠」,大类是最外面那一级 —— 上一版只有行内的折叠箭头,
   * 段头没有,于是库多起来时整片区域只能一直全开着。
   *
   * 局部状态,不进 store:它与「看哪个 kind」一样是"这一段自己现在什么样",
   * 换库/切模式重挂载后回到展开(最保守的默认),不必跨会话记住。
   */
  const [collapsed, setCollapsed] = useState(false);
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
  /** 「文献信息」浮层管的是哪一条（2026-09-21）。null = 关着。 */
  const [infoFor, setInfoFor] = useState<LibraryItem | null>(null);
  /** 「关联」浮层管的是哪一条（2026-09-21）。null = 关着。 */
  const [linksFor, setLinksFor] = useState<LibraryItem | null>(null);
  /** 「分类信息」浮层管的是哪个分类（2026-09-21）—— 导出引用从这里进。null = 关着。 */
  const [collectionInfoFor, setCollectionInfoFor] = useState<LibraryCollection | null>(null);
  /** 「导入到这里」——分类行右键触发，null = 浮层关着（2026-09-21）。 */
  const [importInto, setImportInto] = useState<LibraryCollection | null>(null);
  /** 导入后是否立刻转录。与右栏那条用同一个开关语义（有现成 md 的人要能关掉）。 */
  const [importAutoConvert, setImportAutoConvert] = useState(true);
  /** 正在等用户确认的**彻底删除**（`DeleteItemsDialog` 开着的时候非 null）。
   *  带着 `activeItemId` 是因为删完要清掉可能悬空的选中态 —— 而这个组件在这一刻
   *  已经被重渲染了，不能指望从 `activeItemId` 现读。 */
  const [deleting, setDeleting] = useState<{ ids: string[]; activeItemId: string | null } | null>(null);
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
  const [renamingKind, setRenamingKind] = useState<string | null>(null);
  const [kindDraft, setKindDraft] = useState("");
  const [kindError, setKindError] = useState<string | null>(null);
  /** 菜单动作(删除等)失败时的提示 —— 那时没有输入行可挂,统一显示在段头下方。 */
  const [manageError, setManageError] = useState<string | null>(null);

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

  /**
   * 本段当前这个 kind 的「全部显示」开关状态。
   *
   * 打开它时**顺手拉一次全量条目** —— 那个视图画的就是整个库的条目,不拉的话
   * 第一眼是"加载中"的占位(`allItemsByKind[kind]` 还是 undefined)。与原来那一行
   * 「全部文献」首次展开时做的事逐字一致,只是触发点从"展开"换成"打开开关"。
   */
  const showAll = showAllKinds.has(kind);
  useEffect(() => {
    if (showAll) void loadAllItems(kind);
  }, [showAll, kind, loadAllItems]);

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
  /** 普通分类(`isTrash` 之外的那些)。树只管它们,回收站不参与嵌套。 */
  const liveCollections = useMemo(
    () => kindCollections.filter((c) => !c.isTrash),
    [kindCollections],
  );
  /**
   * 回收站 —— **只在最后一段画**(2026-09-21 改)。
   *
   * ## 为什么不能每段各画各的
   *
   * 原先每段 `kindCollections.filter(isTrash)`,而 `kind` 是**每段各自选中的 tab** ——
   * 同屏两个大类时各画一次;而且回收站落库时带的那个 `kind` 只属于某一个库,切到别的
   * tab 就找不到了。用户读到的现象是"回收站飘忽不定、有时候找不到"。
   *
   * ## 为什么落在最后一段的末尾,而不是提到 `LibrarySections` 外面
   *
   * 这一行要复用本段的一堆内部状态(展开态、条目表、右键菜单、行内改名…),把它抽到
   * 外面等于把那套东西全搬一遍。而**最后一段的末尾就是整片区域的最底部** ——
   * 用户要的「所有回收站统一在一起,放在最底部」,位置上一模一样,代价小得多。
   *
   * `isLastSection` 由 `LibrarySections` 按组表顺序传下来。
   */
  const trashCollections = useMemo(
    () => (isLastSection || trashOnly ? collections.filter((c) => c.isTrash) : []),
    [collections, isLastSection, trashOnly],
  );

  /**
   * 把平的一整份 `kindCollections` 折成**树**:谁在谁下面。
   *
   * 数据库按 `sort_order` 返回平表(`CollectionRepo.list`),`parent_id` 那列从来没被
   * 渲染端读过 —— 于是**子集合建得出来、却画成了同级**(用户报的「三级文档也不能折叠」
   * 就是这个:没有层级,自然也没有可折叠的东西)。这里把层级还原出来。
   *
   * 两件事不能省,否则"分类凭空消失"或者"左栏整个白屏":
   *
   *   - **认不出的父当根**:`parentId` 指向一条不在本列表里的记录(父被删、或者父在
   *     别的 kind 下),那条不能丢 —— 丢了就是用户的东西不见了。挂成根最多是位置不对。
   *   - **防环**:`CollectionRepo.move` 已经挡了成环写入,但渲染端不能把"整棵递归不会
   *     栈溢出"这件事押在别人身上。`seen` 是那道保险(见 renderCollectionRow)。
   */
  const { rootCollections, childrenOf } = useMemo(() => {
    const ids = new Set(liveCollections.map((c) => c.id));
    const childrenOf = new Map<string, LibraryCollection[]>();
    const roots: LibraryCollection[] = [];
    for (const c of liveCollections) {
      const parent = c.parentId ?? null;
      if (!parent || !ids.has(parent)) {
        roots.push(c);
        continue;
      }
      const bucket = childrenOf.get(parent);
      if (bucket) bucket.push(c);
      else childrenOf.set(parent, [c]);
    }
    // 同级里的次序就是 `kindCollections` 的次序(数据库给的 sort_order),push 保序
    return { rootCollections: roots, childrenOf };
  }, [liveCollections]);

  /** 段内的 tab:**按 group.kinds 的顺序**渲染,名字取类型注册表的 name
   *  (用户可改,不走 i18n);组里没这个类型的注册信息时退回 kind 串。 */
  const tabs: ReadonlyArray<SectionTab<LibraryKind>> = useMemo(
    () =>
      group.kinds.map((id) => {
        const meta = typeMetas.find((m) => m.id === id);
        return {
          key: id,
          label: meta?.name ?? id,
          // ⚠️ **排除回收站**（2026-09-21）。它也是一个 collection（它就是「一个叫回收站的
          // collection」，见 `library/trash.ts` 的文件头），不排的话会被算进它那个
          // kind 的数字里 —— 数字虚高 1，而用户数出来的分类数对不上。
          count: collections.reduce(
            (n, c) => (c.kind === id && !c.isTrash ? n + 1 : n),
            0,
          ),
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

  /**
   * 左栏每一行文献尾上那个「N 条关联」的徽标 —— 本段**当前看得见**的那些条目的关联数。
   *
   * ## 为什么只查"看得见的"
   *
   * 用户的抱怨是「文件之间的关联没有体现」:右栏那一份清单只有点开某一篇才看得到,
   * 左栏一排看下去完全不知道哪篇是有关联的。所以要的是**一眼能扫**:有徽标的那几条
   * 就是有关联的。
   *
   * 于是不需要"整个库的关联数"——只把**已经加载出来的**那些条目 id 拼起来问一次。
   * 条目是懒加载的(展开哪个分类拉哪个),所以这一批自然就是"当前展开着的东西",
   * 与用户眼前看到的严格对应。缓存里没有的条目本来也没画出来,不必问。
   *
   * ## 依赖为什么是这两个 id 串
   *
   * `itemsByCollection` / `allItemsByKind` 是对象,直接进依赖数组每次渲染都变。
   * 拼成"有哪些条目 id"的字符串再进依赖,才是"条目集合真的变了"这一个信号 ——
   * 与上面 `collectionIds` 同一个做法。
   */
  const loadedItemIds = useMemo(() => {
    const ids = new Set<string>();
    for (const list of Object.values(itemsByCollection)) for (const it of list) ids.add(it.id);
    for (const list of Object.values(allItemsByKind)) {
      for (const it of list ?? []) ids.add(it.id);
    }
    return [...ids];
  }, [itemsByCollection, allItemsByKind]);
  const loadedItemIdsKey = loadedItemIds.join(",");

  const [linkCounts, setLinkCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    const ids = loadedItemIdsKey ? loadedItemIdsKey.split(",") : [];
    if (ids.length === 0) {
      setLinkCounts({});
      return;
    }
    let cancelled = false;
    void api.library
      .linkCounts({ itemIds: ids })
      .then((res) => {
        // 卸载后回来的响应丢掉 —— 否则会对着已经不在的段写状态
        if (!cancelled) setLinkCounts(res.counts);
      })
      // 拉不到就当没有关联(徽标不画),**不**把错误摆到段头 ——
      // 一个装饰性的数字拉失败,不该盖住用户本来在看的列表
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [loadedItemIdsKey]);

  // 库的内容变了 —— **包括 AI 改的**。
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
    // ⚠️ **点分类不再切右栏**（2026-09-21）。原来切的是「文献库」那个 tab，而它删了。
    // 也不能切到「预览」—— 那是给**某一个文件**的，而这里用户点的是一个分类
    // （可能展开出一列文件）。切过去只会显示上一次预览的那一篇，误导。
    toggleExpanded(id);
  };

  /** 打开某一篇。`collectionId` 为 null(会话流模式)时不动当前选中的库。
   *
   *  ## 2026-09-20 起:点开的**文件**改在中间看
   *
   * 用户的原话是"有一个项目文件的右边页面,点开会在中间页面显示出来,你可以把文件
   * 的编辑走这个路径" —— 右栏腾给对话(要和子代理说话,不能来回切标签),所以
   * 文件预览整体搬到中间。
   *
   * ⚠️ **只有"看文件"的那几页走中间,详情页不走。** 判据是这一篇有没有一个
   * **文件本体**要看:
   *   · `filePath`(统一资料库之后任意文件都能进库) → 中间
   *   · `pdfPath`(文献的 PDF)                     → 中间
   *   · 笔记 / 只有元数据的文献                     → 右栏详情页
   * 分开是对的:中间那块地方是"看东西"的,而元数据/笔记是"改条目"的 —— 和编辑
   * 标签条是同一类东西,留在右栏与它原本的邻居们在一起。
   *
   * 中间打开之后右栏**不再被强行拉出来**(`setRightOpen(true)` 去掉了),但也不再
   * 强行切到 library 标签 —— 用户要的正是"文件在中间的时候,右栏还能跟子代理说话",
   * 所以右栏保持它原来的样子。 */
  /**
   * **单击一行 = 在右栏预览**（2026-09-21 改）。
   *
   * ★ 用户的原话：「**左边栏的文件是点击预览在右边栏，双击才会在中间显示**」。
   * （这一版之前单击就直接把文件甩到中间去了 —— 方向反了。）
   *
   * 右栏那份预览本来就是为"扫一眼"准备的：窄、轻、不打断中间正在干的事。而中间那块
   * 留给"真要读/要改"的时候 —— 那一步归双击（见下面 `openItemInCenter`）。
   */
  const openItem = (item: LibraryItem, collectionId: string | null) => {
    if (collectionId) setActive(collectionId);
    // ★ **点一行 = 看本体**（2026-09-21）。`setActiveItem` 会把 `previewWhich` 清成 null，
    // 于是"上一条在看转录、这一条自己弹回到 PDF"是白拿的 —— 用户要的正是"点击和双击
    // 都显示这个 PDF 本身"，转录只能从右键那一项进。
    setActiveItem(item.id);
    // 同 openCollection:全局 kind 跟着这篇走(右栏按它取显示名与默认行为)
    setActiveKind(item.kind);
    // 笔记点开就是要写/改它,直接落在编辑页;其余落在第一页(元数据 / 概览)
    useLibraryStore.getState().setDetailTab(item.kind === "note" ? "edit" : "meta");
    // **单击 = 预览**（2026-09-21）：把右栏切到「预览」并拉出来。
    // 原来切的是「文献库」那个 tab，而它已经删了（检索去 Ctrl+K、导入/关联/文献信息
    // 去左栏右键）。双击才是进主页面编辑 —— 见 `openItemInCenter`。
    setRightPanelTab("preview");
    setRightOpen(true);
  };

  /**
   * **双击一行 = 在中间打开**（要读它 / 改它）。
   *
   * 有文件本体可看的走中间；**什么都没有**的（只有元数据、也没有转录的论文）中间没
   * 东西可放，仍旧留在右栏 —— 双击它们与单击等效。
   *
   * ⚠️ 「有本体」的判据**必须带上 `mdPath`**（2026-09-21）。老判据是
   * `filePath ?? pdfPath`，而一篇还没下 PDF 的论文恰好两者都空 —— 那时双击就**什么都
   * 不发生**，看起来像坏了。现在它至少能在中间把转录摆出来。
   */
  const openItemInCenter = (item: LibraryItem, collectionId: string | null) => {
    openItem(item, collectionId);
    const ref = item.filePath ?? item.pdfPath ?? item.mdPath ?? null;
    if (ref === null) return;
    openFileView({
      // 看**本体**（通用条目给文件本身、论文给 PDF）；只有转录可看的那些才退到 md ——
      // 与主进程 `entryRootAbsPath` 未指名时的顺序**逐条一致**（本体 → PDF → 转录）。
      source: {
        kind: "library",
        ref: item.id,
        which: item.filePath ?? item.pdfPath ? undefined : "md",
      },
      name: basenameOf(item.filePath ?? item.pdfPath ?? item.mdPath ?? item.title),
    });
    setCenterTabFocus("editor");
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
      // 用途固定 `material` —— 界面不再问（见 `libraryServer.materialKindIds` 那段）。
      { id, name: trimmed, purpose: "material", builtin: false },
    ]);
    if (!ok) return;
    // 归入本段的大类(失败时 saveGroups 自己会把后端的话摆出来)。
    // 即使归组失败也要重拉:类型已经落进注册表,只是"未分组"(左栏不显示、数据在)。
    const grouped = await saveGroups(
      // ⚠️ **插到最前面**（2026-09-21）。用户的原话：「新建的应该**在最上面**」。
      // 原来追加在末尾（`[...g.kinds, id]`），于是新建的小类永远排在最后一个 ——
      // 而它恰恰是用户此刻最想看的那个，得往右扫到头才找得到。
      groups.map((g) => (g.id === group.id ? { ...g, kinds: [id, ...g.kinds] } : g)),
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
    if (!meta) return;
    // ⚠️ **不再挡内置类型**（2026-09-21）。原来这里有一道 `meta.builtin` 的闸，
    // 菜单项置灰 + 这里兜底。用户否掉了：「**都能删，去掉这个限制**」——
    // 他库里那几个内置 tab（论文/教材/笔记）在他看来和自建的一样，
    // 而"内置类型不能删除"这个说法本身就在暗示一套他用不到的出厂概念。
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

  /**
   * 把一个分类挪到另一个父下面(`parentId: null` = 挪到最外层)。
   *
   * ## 失败必须说出来,不能静默不动
   *
   * 主进程那层有两条守卫(重名 / 成环,见 `CollectionRepo.move`),它们拒的时候
   * **界面得知道**:否则用户点了「挪到 XX 下面」、菜单关了、树没变 —— 看起来像
   * 点空了。这里把后端给的那句话原样摆出来(与 `renaming` 那条口径一致:判据以
   * 主进程为准,渲染端不另造一套说法)。
   */
  const moveCollection = async (c: LibraryCollection, parentId: string | null) => {
    setError(null);
    const res = await api.library.moveCollection({ id: c.id, parentId });
    if (!res.ok) {
      setError(res.error ?? t("library.collection.moveFailed"));
      return;
    }
    await loadCollections();
    // 挪到别人下面,却**不展开那个新父级**的话,东西看着像凭空消失了 ——
    // 用户会以为挪丢了。展开新父级是"挪过去"这个动作的自然结果。
    if (parentId && !expandedIds[parentId]) toggleExpanded(parentId);
    // 挪走之后原位置那一行可能还开着:把它收起来,免得新旧两处同时挂着一个空壳
    if (expandedIds[c.id] && c.parentId !== parentId) toggleExpanded(c.id);
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
  /* ── 单条动作（2026-09-21 从右栏 `ItemDetail` 搬来）──
   *
   * 用户要把右栏那个 `library` tab 整个删掉，并要求「**全部堆到左栏右键**」。
   * 这三件是那批里"对单条做事"的部分；它们的实现在主进程没变，只是入口搬了家。
   *
   * 反馈一律走 toast：左栏列表里没有"这一条的状态区"，而转换要花几秒到几十秒 ——
   * 没有反馈的话用户只会以为点了没反应。 */

  /** 转 Markdown（软件自己那套本地抽取）。 */
  const convertItem = async (item: LibraryItem) => {
    try {
      const res = await api.library.convert({ ids: [item.id], force: true });
      useToastStore.getState().push({
        // 没有 `success` 这一档（只有 info / warning / error）—— 成功走 info，
        // 与"转换失败"的 error 在观感上分得开就够了。
        kind: res.converted > 0 ? "info" : "error",
        title: res.converted > 0 ? t("library.convert.done") : (res.failed[0]?.error ?? t("library.convert.failed")),
        body: item.title,
      });
      if (res.converted > 0) await refreshItems();
    } catch (err) {
      useToastStore.getState().push({ kind: "error", title: t("library.convert.failed"), body: (err as Error).message });
    }
  };

  /** 挂上用户已经转录好的 md（不重新转，见 `ItemDetail` 里那段说明）。 */
  const adoptMarkdownFor = async (item: LibraryItem) => {
    const picked = await api.pickFiles({ filters: [{ name: "Markdown", extensions: ["md", "markdown"] }] });
    const path = picked.paths[0];
    if (!path) return;
    try {
      const res = await api.library.adoptMarkdown({ id: item.id, path });
      useToastStore.getState().push({
        kind: res.ok ? "info" : "error",
        title: res.ok ? t("library.convert.adoptDone", { n: res.imageCount }) : (res.error ?? t("library.convert.failed")),
      });
      if (res.ok) await refreshItems();
    } catch (err) {
      useToastStore.getState().push({ kind: "error", title: t("library.convert.failed"), body: (err as Error).message });
    }
  };

  /**
   * 把这一条的引用复制到剪贴板。
   *
   * 用**默认格式**（`formatCitation` 的第二参数不给就走它自己的默认）——右键是一个
   * 一步到位的动作，不该在这儿再弹一个"选哪种格式"。要换格式的去设置（引用格式
   * 是全局偏好，本来也不该按条选）。
   */
  const copyCitationOf = async (item: LibraryItem) => {
    const ok = await copyText(formatCitation(item, "apa"));
    useToastStore.getState().push({
      kind: ok ? "info" : "error",
      title: ok ? t("library.cite.copy") : t("library.convert.failed"),
      body: item.title,
    });
  };

  /**
   * 把一个分类下的条目导出成引用文件（2026-09-21）。
   *
   * 从右栏那条工具条搬来的。落盘位置由主进程定（库根的 `exports/`）——
   * 渲染端不拼路径，与原来那条一样。
   */
  const exportCollection = async (c: LibraryCollection, style: CitationStyle) => {
    try {
      const res = await api.library.exportCitations({ style, collectionId: c.id });
      useToastStore.getState().push({
        kind: res.ok ? "info" : "error",
        title: res.ok ? t("library.export.done", { n: res.count, path: res.path }) : (res.error ?? t("library.export.failed")),
      });
    } catch (err) {
      useToastStore.getState().push({ kind: "error", title: t("library.export.failed"), body: (err as Error).message });
    }
  };

  const deleteForever = async (item: LibraryItem) => {
    // 先摆清单再删（见 `DeleteItemsDialog`）—— 原先这里是 `window.confirm` 一句
    // "确定吗"，而这条操作**不可逆**、还会连带它挂出去的关联与那一包转录产物。
    setDeleting({ ids: [item.id], activeItemId: item.id });
  };

  /** 确认框那边真删完之后：清掉可能悬空的选中态，再重拉列表。 */
  const afterDeleteItems = async (deletedActiveId: string | null) => {
    if (deletedActiveId !== null && activeItemId === deletedActiveId) setActiveItem(null);
    await loadCollections();
    await refreshItems();
  };

  /**
   * 右键菜单里点「下载 PDF」。
   *
   * ## 为什么失败要说一句话,而不是默默把菜单关掉
   *
   * 面板那一侧(`LibraryPanel.handleDownload`)是**乐观**的:它只更新 `jobs` 列表,
   * 而下载任务的进度是靠 `libraryJobChanged` 广播推回来的。左栏**没有**那份状态
   * —— 它是独立的一棵树。所以这里点了之后,用户在左栏能看到的唯一变化,是下载
   * 真下了/真失败时那条广播带来的。中间那几分钟里 "什么都没发生" 是正常的,但
   * **"排都没排上"也长得一模一样** —— 那就分不出来了。
   *
   * 而这条 RPC 确实会失败:条目在别的窗口被删了、库根不可写、参数没通过校验(比如
   * 这是一条笔记 —— 菜单里已经挡掉了,但列表可能是旧的)。所以失败时报出来。
   *
   * ## 为什么进度不在这里显示
   *
   * 左栏是列表,一行放不下一个进度条,而用户真正的疑问是「它到底下没下」。那个
   * 问题由每条文献自己的状态点回答(`derivePdfState`),它挂在 `libraryJobChanged`
   * 上自动刷新 —— 不需要这里再维护一份。
   */
  const downloadOne = async (item: LibraryItem) => {
    setError(null);
    try {
      await api.library.download({ ids: [item.id] });
      // 排队之后立刻拉一次:下载任务可能**同步**就落库了(已有 PDF 会被跳过、
      // 排不上返回的 jobs 里也没有它),而那条 `libraryJobChanged` 广播只在状态
      // **变化**时发 —— 不拉这一次的话,一层没变的状态在界面上要等到下次刷新才出现。
      await refreshItems();
    } catch (err) {
      // `setError` 是左栏顶部那条红色横条 —— 复用现成的那一个,不新造 UI。
      setError(err instanceof Error ? err.message : String(err));
    }
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
          // 双击在**中间**打开（用户：「双击才会在中间显示」）。
          onDoubleClick={() => openItemInCenter(item, collectionId)}
          // 行尾那个「N 条关联」的徽标 —— 用户的抱怨是「文件之间的关联没有体现」:
          // 右栏那份清单要点开某一篇才看得到,左栏扫一遍完全不知道谁有关联。
          // 0 条**不画**(不画"0 条")—— 大多数条目没有关联,每行挂一个 0 会把
          // 少数真正有关联的那几行淹掉,而徽标的意义正是"一眼看出谁有"。
          badge={
            (linkCounts[item.id] ?? 0) > 0
              ? t("library.collection.linkCount", { n: String(linkCounts[item.id]) })
              : undefined
          }
        />
      </li>
    );
  };

  /**
   * 新建 **一级** 分类(段头「+」)的输入框 —— 它不属于任何一个分类,所以不画在树里,
   * 而是和「新建大类」「新建小类」排在一起(见 render 里那一段注释)。
   */
  const creatingRootInput = creating && (
    <MiniInput
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
   * 「全部显示」开着时的列表 —— **只平铺这一类下的全部条目,不画分类那一层**。
   *
   * 用户的要求原话:「我不想要全部的这个标签,太大了,占空间,右键小类可以选择
   * 全部显示,只显示文件列表,不显示 collection」。
   *
   * 上一版它是列表最上面**常驻的一行**「全部文献」,展开看整个库的条目。那一行
   * 有三个问题:每段都占一行、它自己还要能展开(多一次点击)、而且"全部"这个名字
   * 让人以为它是另一个分类。收进右键菜单当开关就没有这些 —— 平时列表里只有分类,
   * 想看全部时才打开。
   *
   * ## 为什么不能干脆删掉这个视图
   *
   * **不属于任何分类的条目只在"全部"里看得见**(导入时没选分类、或刚从分类里移除
   * 的那些)。删掉它,那些条目在左栏里就彻底不存在了 —— 既看不到、也没地方右键它。
   *
   * `collectionId` 传 null:这里本来就不在某个分类的上下文里(条目可能同时在好几个
   * 分类下),与上一版那一行逐字一致。
   */
  const renderShowAllList = () => {
    const items = allItemsByKind[kind];
    return (
      <ul className="space-y-0.5">
        {items === undefined ? (
          <HintRow>…</HintRow>
        ) : items.length === 0 ? (
          <HintRow>{t("library.list.empty")}</HintRow>
        ) : (
          items.map((item) => renderItemRow(item, null))
        )}
      </ul>
    );
  };

  /**
   * 一个分类的行 —— **它下面挂着子分类,子分类下面还挂着子分类**。
   *
   * ## `seen` 那条保险
   *
   * 递归画树,而"数据里不会有环"这件事**不能默认成立**:`CollectionRepo.move` 挡了
   * 成环写入,但那是一份不在这个文件里的保证。一旦真出现环,这里的递归就是无限层 ——
   * React 报 maximum update depth 之前先把浏览器卡死。`seen` 记着**本分支上已经画过的
   * 祖先**,撞上就当场把这条标出来(用户看得见),而不是白屏。
   */
  const renderCollectionRow = (c: LibraryCollection, seen: ReadonlySet<string> = new Set()) => {
    const isActive = c.id === activeId;
    const isExpanded = !!expandedIds[c.id];
    const items = itemsByCollection[c.id];
    const kids = (childrenOf.get(c.id) ?? []).filter((k) => !seen.has(k.id));

    if (renamingId === c.id) return renameInputRow(c);

    /** 展开这一行时画的东西:文献 + **子分类** —— 两者都是"这一行里面有什么"。 */
    const children = (
      <SidebarList nested>
        {items === undefined && kids.length === 0 ? (
          // 还没拉到 —— 给一行占位,避免「空库」和「加载中」看起来一样
          <HintRow>…</HintRow>
        ) : (
          <>
            {items !== undefined &&
              (items.length === 0 && kids.length === 0 ? (
                <HintRow>{t("library.collection.empty")}</HintRow>
              ) : (
                items.map((item) => renderItemRow(item, c.id))
              ))}
            {/* 子分类**跟在文献后面**,并复用同一层缩进 —— 它们和文献都是
                "这个分类里的东西",再套一层缩进会平白多出一级视觉台阶 */}
            {kids.map((k) => renderCollectionRow(k, new Set([...seen, c.id])))}
          </>
        )}
      </SidebarList>
    );

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

        {/* 展开 —— 子列表的缩进/描边与 ProjectNode 展开会话列表时逐字一致。
            没有内容但**有子分类**时也画:箭头点开应当有反应。 */}
        {isExpanded && children}
      </li>
    );
  };

  /**
   * 一个库的行(会话流模式)。
   *
   * 与树模式的区别是**没有折叠箭头**:会话流里一切本来就已经是平的 —— 它在
   * store 里的对应物是「会话卡片也不会展开成消息」。**嵌套的分类在这里也是平的**
   * (子集合不再缩进到父集合下面,和其它库并排),这是模式本身的意思。
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

  // **回收站里的条目**（不含那一行）—— 浮层里用这个（见 `trashItemsOnly`）。
  if (trashItemsOnly) {
    const ids = collections.filter((c) => c.isTrash).map((c) => c.id);
    const items = ids.flatMap((id) => itemsByCollection[id] ?? []);
    if (items.length === 0) {
      return <HintRow>{t("library.trash.empty")}</HintRow>;
    }
    return <SidebarList>{items.map((it) => renderItemRow(it, ids[0] ?? null))}</SidebarList>;
  }

  // **只有回收站**那一档：挂在左栏滚动容器外面，钉死在底部（见 `trashOnly`）。
  // 它不画表头、不画 tab 排、不画树 —— 就是回收站那一行 + 展开后的条目。
  if (trashOnly) {
    return (
      <ul className="space-y-0.5">
        {trashCollections.map((c) => renderCollectionRow(c))}
      </ul>
    );
  }

  return (
    <>
      {/* 表头在最上、组内的类型标签在其下 —— 先有"这是什么"(组名),再有"看哪一类"
          (文献 / 教材 / 笔记…)。反过来会让人先看到一排并列的词、才反应过来它们在
          给什么分类。表头与「项目」表头同款;标题就是**组名**(左栏右键可改)。
          右键表头 = 大类的管理菜单 —— 而且**「新建小类」排在菜单第一项**,这就是
          第二级的唯一入口(见 GroupContextMenu 的文件头)。
          表头右侧**没有「+」**:三级的三个加号全撤了,只留整个区域最下面那一个。
          左侧那个箭头 = **这一级自己折叠**(用户要的「每一级都能折叠」)——
          最外面那一级不能折的话,库多起来时整片区域只能一直全开着。 */}
      <div
        onContextMenu={(e) => {
          e.preventDefault();
          setManageError(null);
          setCtxGroup({ x: e.clientX, y: e.clientY });
        }}
      >
        <SectionHeader
          title={group.name}
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed((v) => !v)}
          expandTitle={t("layout.expand")}
          collapseTitle={t("layout.collapse")}
        />
      </div>

      {/* 折起来之后**整段都收掉**(表头留着)—— tab 排、那一批新建输入行、树、
          右键菜单的锚点全部一起消失。菜单不画在这里也不要紧:合着的段本来就没有
          可右键的行,表头自己那一份还在(它在上面的 div 里,没被包进来)。 */}
      {collapsed ? null : (
        <>
          {/* 组内平级的类型:同一排、同样的入口,只是不能同时展开 ——
          把所有类型的树同时画出来会把左栏撑爆,而用户绝大多数时候只在一个类型里干活。
          点 tab 时同时记进 localKind:activeKind 之后去了别的组,本段仍停在这里。
          右键 tab = 「在这个类型下面新建分类」+ 改名 / 删除(见 KindContextMenu)。 */}
          <SectionTabs
            tabs={tabs}
            active={kind}
            /* 新建小类的输入框**就在这一排的末尾** —— 它即将成为的那个 tab 就在那儿。
               用户原话:「新建一个级别，就在这个级别要出现的位置来设置输入框」。 */
            trailing={
              creatingKind ? (
                <MiniInput
                  inline
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
                />
              ) : renamingKind ? (
                /* 重命名的输入框**和新建同一处** —— 它改的就是这一排里那个 tab，
                   摆在这里用户才知道自己在改哪一个。 */
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
              ) : null
            }
            onChange={(k) => {
              setLocalKind(k);
              setActiveKind(k);
            }}
            onTabContextMenu={(k, e) => {
              setManageError(null);
              setCtxKind({ kind: k, x: e.clientX, y: e.clientY });
            }}
          />

      {/**
       * ── 三级的"新建"输入框,**全在这一带** ──
       *
       * 三个级各有一个「新建」的**菜单入口**,菜单项顺序一律是「先建下一级、再管自己」
       * (见三个 ContextMenu 的文件头)。输入框则各贴各的父级:
       *
       *   三级(分类,段根下) → creatingRootInput —— **在树里**(它即将成为的那一行,
       *                        见下面 `<ul>` 里那处;2026-09-21 从列表外挪进去)
       *   二级(小类)         → 下面的 creatingKind
       *   四级(子分类)       → 树里那一行正下方的 InlineInputRow(必须挨着父行)
       *   一级(大类)         → 不在这里 —— 它是**整片区域的**一级,入口在
       *                        `LibrarySections` 最下面那一行「+」(见那边的注释)
       */}

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

      {/* 菜单动作(删除等)的失败提示 —— 那时没有输入行可挂,统一落在这里 */}
      {manageError && !creatingGroup && !renamingGroup && !creatingKind && !renamingKind && (
        <div className="px-2 pb-1 text-[0.7857em] text-red-500">{manageError}</div>
      )}

      {/* 「全部显示」开着时**只画条目**:连回收站都不画 —— 用户要的是"只显示
          文件列表,不显示 collection",回收站也是一个 collection。 */}
      {showAll ? (
        renderShowAllList()
      ) : (
        <ul className="space-y-0.5">
          {leftBarMode === "stream" ? (
            // 会话流:**一切本来就是平的** —— 嵌套的分类也照样平铺,不分层
            kindCollections.map(renderStreamCollection)
          ) : (
            <>
              {rootCollections.map((c) => renderCollectionRow(c))}
              {/* **新建分类的输入框就在树里**(2026-09-21 挪进来)。
                  用户原话:「选择新建的时候要在对应的位置出现输入框,**现在的情况是
                  位置全部设置在了 collection 列表里面**」（指的是全都堆在列表外面、
                  表头下面那一坨）。它即将成为的那一行就是这里 —— 树的末尾。
                  ⚠️ 它**在回收站之前**:新建出来的是一条普通分类,而回收站永远钉在
                  整棵树的最后。 */}
              {creatingRootInput}
              {/* 回收站**永远在最后** —— 它不参与嵌套(树里只画普通分类),
                  所以由这里统一摆在整棵树的下面。数据库给的行序是任意的
                  (它就是一条普通记录),排序只能在渲染端做。 */}
              {trashCollections.map((c) => renderCollectionRow(c))}
            </>
          )}
        </ul>
      )}
        </>
      )}

      {/* 文献行的右键菜单:移动 / 复制到别的库、从当前库移除(在回收站里则是彻底删除)、
          打开文件夹、打开 md */}
      {/* 「文献信息」——条目行右键触发（元数据 + 引用 + 摘要）。 */}
      <ItemInfoDialog item={infoFor} onOpenChange={(open) => { if (!open) setInfoFor(null); }} />

      {/* 「关联」——条目行右键触发。内容用的是详情页那同一个 `ItemLinks`。 */}
      <ItemLinksDialog
        item={linksFor}
        onOpenChange={(open) => { if (!open) setLinksFor(null); }}
        onChanged={() => void refreshItems()}
      />

      {/* 「分类信息」——分类行右键触发（导出引用从这里进）。 */}
      <CollectionInfoDialog
        collection={collectionInfoFor}
        onOpenChange={(open) => { if (!open) setCollectionInfoFor(null); }}
        onExport={(c, style) => void exportCollection(c, style)}
      />

      {/* 「导入到这里」——在分类行上右键触发。复用右栏那条 `ImportBar`（它本来就收
          `collectionId`，所以"导进哪个分类"不用另写一套）。 */}
      <Dialog.Root open={importInto !== null} onOpenChange={(open) => { if (!open) setImportInto(null); }}>
        <Dialog.Portal>
          <Dialog.Backdrop />
          <Dialog.Popup className="w-[460px] max-w-[92vw] p-4">
            <Dialog.Title>
              {t("library.ctx.importHere")}
              {importInto ? ` · ${importInto.name}` : ""}
            </Dialog.Title>
            {importInto && (
              <div className="mt-3">
                <ImportBar
                  onClose={() => setImportInto(null)}
                  collectionId={importInto.id}
                  kind={importInto.kind}
                  autoConvert={importAutoConvert}
                  onAutoConvertChange={setImportAutoConvert}
                  onImported={() => {
                    void loadCollections();
                    void refreshItems();
                  }}
                />
              </div>
            )}
            <Dialog.Close />
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>

      {/* 彻底删除的确认框 —— 摆出会跟着一起没的关联与转录产物，让用户勾（见那个文件头）。 */}
      <DeleteItemsDialog
        open={deleting !== null}
        ids={deleting?.ids ?? []}
        onOpenChange={(open) => { if (!open) setDeleting(null); }}
        onConfirmed={() => void afterDeleteItems(deleting?.activeItemId ?? null)}
      />

      <LibraryItemContextMenu
        ctxMenu={ctxMenu}
        collections={kindCollections}
        onClose={() => setCtxMenu(null)}
        onChanged={() => void refreshItems()}
        onRename={startItemRename}
        onDeleteForever={(item) => void deleteForever(item)}
        onDownload={(item) => void downloadOne(item)}
        onConvert={(item) => void convertItem(item)}
        onAdoptMarkdown={(item) => void adoptMarkdownFor(item)}
        onCopyCitation={(item) => void copyCitationOf(item)}
        onManageLinks={(item) => setLinksFor(item)}
        onShowInfo={(item) => setInfoFor(item)}
      />

      {/* 分类行的右键菜单:新建子集合 / 新建笔记(仅笔记库)/ 移动到 / 重命名 / 删除 */}
      <CollectionContextMenu
        target={ctxCollection}
        collections={kindCollections}
        onClose={() => setCtxCollection(null)}
        onRename={(c) => startRename(c.id, c.name)}
        onDelete={(c) => void removeCollection(c.id, c.name)}
        onNewNote={startNewNote}
        onImportHere={(c) => setImportInto(c)}
        onExport={(c, style) => void exportCollection(c, style)}
        onShowInfo={(c) => setCollectionInfoFor(c)}
        onMove={(c, parentId) => void moveCollection(c, parentId)}
      />

      {/* 大类标题行的右键菜单 —— 第二级的**唯一**入口就在它的第一项(见 GroupContextMenu
          的文件头:菜单项顺序就是层级顺序)。 */}
      <GroupContextMenu
        target={ctxGroup}
        onClose={() => setCtxGroup(null)}
        onRename={() => {
          setCreatingGroup(false);
          setRenamingGroup(true);
          setGroupDraft(group.name);
          setGroupError(null);
        }}
        onNewKind={() => {
          setCreatingKind(true);
          setNewKindDraft("");
          setKindError(null);
        }}
        // 挂**本段**(整个大类,附件键 `g:<组 id>`)—— 用户要求每一级都能挂。
        // 范围比 `k:<库>` 还大一层:这个大类下所有小类的资料一起给。
        onAttachToChat={() => void attachToCurrentChat(`g:${group.id}`)}
        onDelete={() => void removeGroup()}
      />

      {/* 小类 tab 的右键菜单 —— 第三级的入口 + 全部显示开关 + 改名 / 删除
          (内置类型删除项置灰) */}
      <KindContextMenu
        target={ctxKind}
        // 删小类**不再有"内置"这个限制** —— 见 `removeKind` 里那段。
        builtin={false}
        // 开关的初值取**右键的那个 tab** 的状态,不是"当前显示的 tab" —— 用户看到
        // 的菜单是关于他右击的那一个小类的
        showAll={!!ctxKind && showAllKinds.has(ctxKind.kind)}
        onClose={() => setCtxKind(null)}
        onNewCollection={() => {
          // 建在**右键的那个 tab** 下,不是"当前显示的 tab"下 —— 两者通常一样,
          // 但右键一个没选中的 tab 时就不一样了,而用户的心智是"我点的这个"。
          if (ctxKind?.kind) {
            setLocalKind(ctxKind.kind);
            setActiveKind(ctxKind.kind);
          }
          setCreating(true);
          setError(null);
        }}
        onToggleShowAll={() => {
          const k = ctxKind?.kind;
          if (!k) return;
          // 切到那个 tab 再开关 —— 用户点了这一项就是要看**这个**小类的全部条目,
          // 而列表画的是"当前 kind"。不切的话开关开了、屏幕上还是别的小类,
          // 看着像点了没反应。
          setLocalKind(k);
          setActiveKind(k);
          setShowAllKinds((prev) => {
            const next = new Set(prev);
            if (next.has(k)) next.delete(k);
            else next.add(k);
            return next;
          });
        }}
        // 挂**右键的那个小类**(附件键 `k:<库>`,与原来「全部<类目>」那一行的
        // 悬停气泡同一个键 —— 是同一件事:整个库的索引清单)
        onAttachToChat={() => {
          const k = ctxKind?.kind;
          if (k) void attachToCurrentChat(`k:${k}`);
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
 *
 * ## 底下那一个「+」—— 用户定的入口分工
 *
 * 用户的原话:「你可以参考 windows 的文件系统右键新建,**右键点击第二级新建第三级,
 * 右键第一级新建第二级**,留一个加号放在最下面,用来新建第一级」。
 *
 * 于是三级各归各的入口,**全区域只有这一个「+」**:
 *
 *   新建**第一级**(大类) → 就是最下面这一行(整个资料库区域的末尾)
 *   新建**第二级**(小类) → 右键任一大类的标题(菜单第一项)
 *   新建**第三级**(分类) → 右键任一小类 tab(菜单第一项)
 *   新建**第四级**(子分类)→ 右键任一分类行(菜单第一项)
 *
 * 为什么"就一个「+」"是有道理的,而不是少给了入口:大类是**整片区域**的一级,
 * 它不属于任何一段 —— 把它挂在某一个段的表头上,用户在别的段里就找不到它,
 * 而挂到每个段的表头上就成了"几个段几个加号"。摆在整片区域的末尾,它管的范围
 * 和它所在的位置才是对上的。二级以下的父级到处都有,所以那些用右键"在哪儿点、
 * 建在哪儿"更自然 —— 也就没有可见的「+」了(每个父级旁边都配一个,屏幕上会
 * 全是加号)。
 */
export function LibrarySections() {
  const { t } = useI18n();
  const [groups, setGroups] = useState<readonly LibraryGroupMeta[] | null>(null);
  const [typeMetas, setTypeMetas] = useState<readonly LibraryTypeMeta[]>(BUILTIN_LIBRARY_TYPES);
  /** 底下那个「+」被点开之后的输入态。 */
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [groupError, setGroupError] = useState<string | null>(null);

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

  /**
   * 新建一个大类(整片区域的**第一级**)。
   *
   * 失败时**不关输入框**、把后端那句话摆在下面:新建大类是这个区域内"再分层"
   * 的唯一入口,失败了还把输入吞掉的话,用户只剩"刚才点的那一下没了"这一个观感。
   * 名字的校验在主进程(`groupsSave`),这里不另造一套说法。
   */
  const submitNewGroup = async () => {
    const trimmed = groupName.trim();
    if (!trimmed) {
      setCreatingGroup(false);
      setGroupName("");
      setGroupError(null);
      return;
    }
    const res = await api.library.groupsSave({
      groups: [...groups!, { id: `group-${Date.now().toString(36)}`, name: trimmed, kinds: [] }],
    });
    if (!res.ok) {
      setGroupError(res.error);
      return;
    }
    setCreatingGroup(false);
    setGroupName("");
    setGroupError(null);
    reload();
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
      {groups.map((group, i) => (
        <LibrarySection
          key={group.id}
          group={group}
          typeMetas={typeMetas}
          groups={groups}
          onRefresh={reload}
          // 回收站**不在这里画了** —— 它现在钉在左栏滚动容器外面（见
          // `LibraryTrashRow`），所以这一段就不必再兼管它。
          isLastSection={false}
        />
      ))}

      {/* ── 全区域唯一的「+」:新建**第一级**(大类) —— 见上面的文件头注释 ── */}
      <div className="px-1">
        {creatingGroup ? (
          <MiniInput
            value={groupName}
            onChange={(next) => {
              setGroupName(next);
              if (groupError) setGroupError(null);
            }}
            onSubmit={() => void submitNewGroup()}
            onCancel={() => {
              setCreatingGroup(false);
              setGroupName("");
              setGroupError(null);
            }}
            onBlur={() => void submitNewGroup()}
            placeholder={t("library.group.namePlaceholder")}
            error={groupError}
          />
        ) : (
          <button
            onClick={() => {
              setCreatingGroup(true);
              setGroupName("");
              setGroupError(null);
            }}
            // 与列表行同高同圆角、同样"悬停才给底" —— 它是这一片的**行尾动作**,
            // 不是一条内容,所以文字用字幕色、悬停才提亮成强调色。
            className="flex w-full items-center gap-1 rounded px-1 py-1 text-content-subtle transition-colors hover:bg-surface-hover/60 hover:text-accent [font-size:var(--rp-fs-md)]"
          >
            <IconPlus size={12} className="shrink-0" />
            {t("library.group.new")}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * **钉在左栏最底部的那一个回收站**（2026-09-21）。
 *
 * ## 它是什么样，用户的说法换过三次，最终定在这个形状
 *
 * 最初我说"钉住"，做成了在布局里撑一个 40vh 的滚动区。用户说不对。
 * 然后我做成 `fixed` 的**浮动卡片**（圆角 + 阴影 + 浅色底）—— 用户发来一张截图，
 * 一句话点破：
 *
 *   > 「**不在一个图层，颜色也不一样**，我这么说吧就是**嵌入到现在的左边框里面**，
 *   >  颜色一样，**高度固定**，只不过**不随着左边框滚动**」
 *
 * 所以它**不是浮层**，是左栏里长着的一块：
 *
 *   - **同色**：跟着左栏的底色，不另给 `bg-surface`；
 *   - **同宽**：撑满左栏（不用 `fixed` + 量宽度那一套 —— 那样才需要算坐标）；
 *   - **高度可拖**：不再定死。上面有一条**分界线**（复用 `Divider`），上下拖就能改
 *     它多高 —— 用户后来提的：「别固定高度了，做一个分界线，可以上下拖动」。
 *     默认给个整数（`240`），双击分界线回到默认值（与终端那条同一个做法）。
 *   - **只是不跟着滚**：它挂在 `LeftBar` 的滚动容器**外面**，所以上面那片列表
 *     怎么滚、怎么折叠，这一块都不动。它自己内部滚。
 *
 * ## 为什么不再量坐标
 *
 * 上一版用 `fixed` + `getBoundingClientRect()` 算 left/width/bottom，还因为 `ref`
 * 挂错元素（挂到了内层的名字按钮上）而量出了"名字的宽度"。**嵌进左栏就不需要量**
 * —— 父容器多宽它就多宽，这是布局的自然结果，不是算出来的。
 */
export function LibraryTrashRow() {
  const { t } = useI18n();
  const collections = useLibraryStore((s) => s.collections);
  const loadCollections = useLibraryStore((s) => s.loadCollections);
  const [open, setOpen] = useState(false);
  /**
   * 展开块多高（px）。**可拖**（下面那条分界线），双击回默认。
   *
   * 局部 state 不进 store：它是这一块自己的大小，与"看哪个大类"同一类东西。
   * 范围与终端那条同款思路 —— 太矮了看不见内容、太高了把上面挤没。
   */
  const [height, setHeight] = useState(240);
  /** 拖分界线：它给的是**增量**（正 = 向下），而这是往上长的块，所以要减。 */
  const resize = (deltaPx: number): void => {
    setHeight((h) => Math.min(560, Math.max(80, Math.round(h - deltaPx))));
  };

  useEffect(() => {
    void loadCollections();
  }, [loadCollections]);

  const trash = collections.find((c) => c.isTrash);
  if (!trash) return null;

  const toggle = (): void => {
    if (!open && !useLibraryStore.getState().expandedIds[trash.id]) {
      // **打开即展开**：回收站本身不折叠（用户明说了），所以进来就该看见里面的东西，
      // 而不是再给一行"点一下才展开"。
      useLibraryStore.getState().toggleExpanded(trash.id);
    }
    setOpen((v) => !v);
  };

  return (
    <div className="shrink-0 border-t border-edge">
      {/* ── 展开出来的那一块 ──
          ⚠️ **在那一行的上面**，因为它是向上长出来的。

          高度**可拖**：分界线摆在最上面（向上长的块，线在上沿），`onResize` 拿到的是
          增量，这里换算成高度。双击回默认 240 —— 与终端那条分界线同一个做法。 */}
      {open && (
        <Divider orientation="horizontal" onResize={resize} onDoubleClick={() => setHeight(240)} />
      )}
      {open && (
        <div className="overflow-y-auto overscroll-contain px-2 py-1" style={{ height }}>
          {/* **直接列文件**，不再画"回收站"那一行（用户："直接把文件排列上去就行了"）。 */}
          <LibrarySection
            group={{ id: "__trash__", name: trash.name, kinds: [] }}
            typeMetas={BUILTIN_LIBRARY_TYPES}
            groups={[]}
            onRefresh={() => void loadCollections()}
            trashItemsOnly
          />
        </div>
      )}

      {/* ── 那一行 ──
          只有**名字**可点（用户：「折叠展开是**点那个名字**就可以，而不是点最前面
          那个小标」）—— 所以图标是装饰，装名字的那个 button 管开关。 */}
      <div
        className={cn(
          "flex w-full items-center gap-1.5 px-2 py-1.5 transition-colors [font-size:var(--right-panel-font-size)]",
          open ? "text-content" : "text-content-muted",
        )}
      >
        <IconArchive size={14} className="shrink-0 opacity-70" aria-hidden />
        <button onClick={toggle} className="min-w-0 flex-1 truncate text-left hover:text-content">
          {trash.name}
        </button>
      </div>
    </div>
  );
}
