/**
 * `LibrarySection` 的**同类段**（从 `LibrarySection.tsx` 拆出）。
 *
 * 尾部三段：空组兜底 `NewGroupFallback`、`LibrarySections`（按组表循环，内部渲染
 * `LibrarySection` 本体）、`LibraryTrashRow`（回收站行）。主文件只留正体
 * `LibrarySection` 与它用到的 `MiniInput`。**纯搬迁，函数体逐字节一致。**
 */
import { useEffect, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useLibraryStore } from "@renderer/stores/libraryStore.js";
import { api } from "@renderer/lib/api.js";
import { DEFAULT_LIBRARY_GROUPS, type LibraryGroupMeta } from "@contracts/libraryTypes";
import { IconArchive, IconPlus } from "@renderer/lib/icons.js";
import { Divider } from "@renderer/components/layout/Divider.js";
import { InlineInputRow, SectionTabs } from "@renderer/components/sidebar/Sidebar.js";
import { LibrarySection, MiniInput } from "./LibrarySection.js";

/**
 * 一个大类都没有时(全被删光)的兜底:至少给一个「新建大类」的入口。
 * 不然组删完整个区域消失,用户就再也没有办法在左栏重新分层了。
 */
export function NewGroupFallback({ onCreate }: { onCreate: (name: string) => void }) {
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
          if (e.key === "Enter" && !(e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229)) submit();
        }}
        onBlur={submit}
        placeholder={t("library.group.namePlaceholder")}
        className="w-full rounded border border-accent bg-surface px-2 py-1 text-code text-content placeholder:text-content-subtle focus:outline-none"
      />
      <div className="pt-1 text-[0.7857em] text-content-subtle">{t("library.group.emptyHint")}</div>
    </div>
  );
}

/**
 * 左栏的整个「资料库」区域:**一段一个大类**,按组表循环渲染 LibrarySection。
 *
 * 组表来自主进程(`groupsGet`;出厂两组「文档 / 模版」,左栏右键可增删改)。
 * 旧的独立模版段已并进组里 —— 它那五类数据由主进程启动时自动
 * 迁移进统一库(标记 `library.templatesMigrated`),那个组件已删除(2026-09-24)。
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
  /** 底下那个「+」被点开之后的输入态。 */
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [groupError, setGroupError] = useState<string | null>(null);

  useEffect(() => {
    void api.library
      .groupsGet({})
      .then((res) => setGroups(res.groups))
      .catch(() => setGroups(DEFAULT_LIBRARY_GROUPS));
  }, []);

  /** 左栏管理操作落库后的重拉:各段即时跟上。 */
  const reload = () => {
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
      groups: [...groups!, { id: `group-${Date.now().toString(36)}`, name: trimmed }],
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
            .groupsSave({ groups: [{ id: `group-${Date.now().toString(36)}`, name }] })
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
            className="flex w-full items-center gap-1 rounded px-1 py-1 text-content-subtle transition-colors hover:bg-surface-hover/60 hover:text-content [font-size:var(--rp-fs-md)]"
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
            group={{ id: "__trash__", name: trash.name }}
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
