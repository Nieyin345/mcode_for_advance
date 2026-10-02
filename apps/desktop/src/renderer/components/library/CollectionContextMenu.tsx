/**
 * 左栏**分类行**的右键菜单。
 *
 * ## 为什么需要它
 *
 * 原先只有文献行有右键菜单,分类行只有"悬停才出现的两个小图标"(重命名 / 删除)。
 * 而用户要的「在笔记库里右键新建笔记」没有地方放 —— 这也是笔记的创建入口只有一个
 * (导入条里那个输入框)的原因。右键菜单把这类"对这个分类做的事"集中到一处:
 * 添加到当前对话 / 新建笔记 / 改父级 / 重命名 / 删除。
 *
 * ## 「新建笔记」只在笔记库里出现
 *
 * 文献库和教材库里的条目是 PDF(导入进来的),没有"就地新建一篇"这回事;笔记是
 * 用户自己写的,才有新建。菜单项按 kind 决定是否出现,而不是给一个点了没用的项。
 *
 * ## 分类是**最后一级** —— 这里没有"再建下一级"
 *
 * 用户定的层次只有三级:大类 → 小类 → 分类。所以这一层的菜单**没有**「新建…」那一项,
 * 它是三个菜单里唯一不"往下建"的。用户的纠正原话:「三级的 collection 还能新建子集合,
 * 那就是四级了,我们只有三级呀」。
 *
 * 于是三个菜单的规矩变成:**能往下建的就把那一项排最前,到头的那个直接开始管自己**。
 *
 * ## 「移动到…」 —— 两步点进的列表,和文献行那个一模一样
 *
 * 改父级(换所属小类 / 挪到另一支下面)是目录树里最常见的整理动作,而原来只能删了
 * 重建(项目自己在 `docs/planning/Status-and-Plan.md` 就是这么记着的:「「移」:改父级 /
 * 换所属类型的入口还没做,只能删了重加」)。
 *
 * 交互刻意**照抄 `LibraryItemContextMenu` 的两步法**(点「移动到」把面板换成集合
 * 列表 + 「← 返回」),不发明第二套:两个菜单在同一个位置、同一个动作,手感必须
 * 一样。那边为什么不用悬停子菜单,见那个文件的注释(base-ui 的受控根菜单会在指针
 * 移向子菜单时把自己卸载掉)。
 *
 * 版式与 `LibraryItemContextMenu` 保持一致(同一个 base-ui Menu + 光标锚点)。
 */
import { useEffect, useState } from "react";
import { Menu } from "@base-ui/react/menu";
import type { LibraryCollection } from "@contracts/library";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { attachToCurrentChat } from "@renderer/lib/attachToChat.js";
import { cn } from "@renderer/lib/cn.js";
import { useCursorAnchor } from "@renderer/hooks/useCursorAnchor.js";
import type { CustomUiSlot, CustomUiTarget } from "@contracts/customUi";
import {
  CustomUiCustomizeItem,
  CustomUiMenuEntries,
  type BuiltinRuntime,
} from "@renderer/components/customUi/CustomUiMenuItems.js";
import {
  IconArrowLeft,
  IconArrowsExchange,
  IconBook,
  IconChevronRight,
  IconDownload,
  IconFileText,
  IconPencil,
  IconPlus,
  IconTrash,
} from "@renderer/lib/icons.js";

export interface CollectionCtxTarget {
  collection: LibraryCollection;
  x: number;
  y: number;
}

export function CollectionContextMenu({
  target,
  collections,
  onClose,
  onRename,
  onDelete,
  onNewSub,
  onNewNote,
  onImportHere,
  onShowInfo,
  onMove,
  groupId,
}: {
  target: CollectionCtxTarget | null;
  /** 同一个 kind 下的全部集合 —— 「移动到」那一屏列的就是它们(去掉自己与自己的子树)。 */
  collections: readonly LibraryCollection[];
  onClose: () => void;
  onRename: (c: LibraryCollection) => void;
  onDelete: (c: LibraryCollection) => void;
  /**
   * 新建**子分类**(第三级)。「右键第 N 级 → 新建第 N+1 级」的那一项,永远排第一。
   *
   * ## 决策变更史(两次相反的要求,语境不同,别再撤回去)
   *
   * kind 时代这里挂过「新建子集合」,用户撤掉它的原话是「三级的 collection 还能新建
   * 子集合,那就是四级了,我们只有三级呀」—— 那时 大类→小类→分类 已经三层。
   * kind 退役(bcd3a2e)把整棵树塌掉一层,2026-09-28 用户要求「回到之前的那种」:
   * 恢复 大类 → 分类 → 子分类 → 条目 四级。所以这一项**只在根分类上显示**
   * (子分类不再往下建,四级封顶 —— 与自定义 UI 的两个 collection 挂载位对齐)。
   */
  onNewSub: (c: LibraryCollection) => void;
  /** 新建一篇笔记并归入这个分类。只在笔记库里用得上。 */
  onNewNote: (c: LibraryCollection) => void;
  /**
   * **导入到这里** —— 导进来的东西直接归这个分类（2026-09-21）。
   *
   * 用户的原话：「关于 f，**导入的功能放到左侧这个栏里面，collection 右键导入**」。
   * 原来只有右栏那个「导入」条，而且它跟着"当前选中的分类"走 —— 用户得先在左栏
   * 点对分类、再去右栏点导入。在分类行上直接右键，是"我要往这里放东西"最直白的说法。
   */
  onImportHere: (c: LibraryCollection) => void;
  /**
   * 打开**「分类信息」卡片**（2026-09-21）。
   *
   * ★ 用户：「现在右键 collection 会有论文信息的导出……**这里的导出放进弹出的卡片里面**」。
   *
   * 导出（这件"对整批做事"的动作）从菜单里搬进卡片，菜单里只留一个入口。卡片里同时
   * 摆出这个分类有多少条 —— 导之前先知道会导出多少，比导完看 toast 好。
   */
  onShowInfo: (c: LibraryCollection) => void;
  /** 把它挪到另一个父下面(`parentId: null` = 挪到最外层)。 */
  onMove: (c: LibraryCollection, parentId: string | null) => void;
  /** 这一段所属的大类 —— 自定义项的「只在这些大类里显示」按它判断。 */
  groupId?: string;
}) {
  const { t } = useI18n();
  // 虚拟锚点钉在右键坐标上(与文献行菜单同一套)
  const anchor = useCursorAnchor(target);
  const [picking, setPicking] = useState(false);

  // 每次重新右键都从根步骤开始 —— 否则上一次点到「移动到」再右键会直接落在列表上
  useEffect(() => {
    if (target) setPicking(false);
  }, [target]);

  const itemClass = cn(
    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs outline-none select-none",
    "text-content-muted data-[highlighted]:bg-surface-muted",
  );

  const c = target?.collection;

  /**
   * 候选落点 —— 去掉自己,以及**自己在自己下面**的那些(移进去就成环了)。
   *
   * 主进程的 `CollectionRepo.move` 会拒(那是硬底线),但**菜单里根本不该出现**
   * 一个点了必然报错的项 —— 那和"点了没反应"是同一种体验。所以这里先把它们挑掉,
   * 判据与主进程同一条:沿祖先链往上走,走到头都碰不到自己才算数。
   */
  const candidates = (() => {
    if (!c) return [];
    const byId = new Map(collections.map((x) => [x.id, x]));
    const isSelfOrDescendant = (x: LibraryCollection): boolean => {
      let cur: LibraryCollection | undefined = x;
      let guard = 0;
      while (cur && guard++ < 10_000) {
        if (cur.id === c.id) return true;
        cur = cur.parentId ? byId.get(cur.parentId) : undefined;
      }
      return false;
    };
    return collections.filter((x) => !isSelfOrDescendant(x));
  })();

  const c2 = c;

  /**
   * 小类和分类是**两个挂载位**(用户要求四级右键各是各的列表):大类下直挂的根分类是
   * 「小类」(第二级),挂在别的分类下面的是「分类」(第三级)。同一个菜单组件,按
   * `parentId` 分流到不同的配置上。
   */
  const slot: CustomUiSlot = c?.parentId ? "library.collection" : "library.subcategory";
  const uiTarget: CustomUiTarget | null = c
    ? {
        kind: "collection",
        level: c.parentId ? "collection" : "subcategory",
        groupId: c.groupId ?? groupId,
        collection: { id: c.id, name: c.name },
      }
    : null;
  /** 内置功能项「点了做什么」;显示与否、先后按自定义 UI 的配置。 */
  const builtins: Record<string, BuiltinRuntime | undefined> = c
    ? {
        // 挂到当前对话 —— 整段流程与「+ → 添加文献库到上下文」共用主进程那一份
        // 实现(见 lib/attachToChat.ts),所以挂出来的是同一个 chip、同一份清单。
        attachToChat: { run: () => void attachToCurrentChat(`c:${c.id}`) },
        // 「分类信息」卡片(条目数)。从前那三种引用格式的导出也在卡片里,
        // 随 2026-09-27 学术功能的清理退役。
        info: { run: () => onShowInfo(c) },
      }
    : {};

  return (
    <Menu.Root
      open={!!target}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Menu.Portal>
        <Menu.Positioner anchor={anchor} side="bottom" align="start" className="z-50">
          <Menu.Popup
            className={cn(
              "min-w-[190px] origin-top-left rounded-md border border-edge bg-surface py-1 shadow-2xl",
              "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
              "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
            )}
          >
            {picking ? (
              /* ── 第二步:选它挪到谁下面(与文献行菜单的两步法逐字同款) ── */
              <>
                <Menu.Item
                  closeOnClick={false}
                  onClick={() => setPicking(false)}
                  className={cn(itemClass, "font-medium text-content")}
                >
                  <IconArrowLeft size={12} className="shrink-0" />
                  {t("library.collection.moveTo")}
                </Menu.Item>
                <div className="my-1 border-t border-edge/60" />
                {/* 挪到最外层 —— 它也是一条**真实存在**的去处,不给这一项的话
                    一个已经在第二层的子集合就再也回不到根上了。 */}
                <Menu.Item
                  onClick={() => {
                    if (c2) onMove(c2, null);
                    onClose();
                  }}
                  className={itemClass}
                >
                  <IconBook size={12} className="shrink-0" />
                  {t("library.collection.moveToTop")}
                </Menu.Item>
                {candidates.map((x) => (
                  <Menu.Item
                    key={x.id}
                    onClick={() => {
                      if (c2) onMove(c2, x.id);
                      onClose();
                    }}
                    className={itemClass}
                  >
                    <IconBook size={12} className="shrink-0" />
                    <span className="truncate">{x.name}</span>
                  </Menu.Item>
                ))}
              </>
            ) : (
              <>
                {/* 新建子分类 —— 「右键第 N 级 → 建第 N+1 级」,永远第一项(见 onNewSub
                    的决策注释)。只在根分类上;回收站不建。 */}
                {c && !c.parentId && !c.isTrash && (
                  <>
                    <Menu.Item
                      onClick={() => {
                        onNewSub(c);
                        onClose();
                      }}
                      className={itemClass}
                    >
                      <IconPlus size={12} className="shrink-0" />
                      {/* 用户术语:小类(第二级,parentId=null)下建的是「分类」(第三级) */}
                      {t("library.collection.new")}
                    </Menu.Item>
                    <div className="my-1 border-t border-edge/60" />
                  </>
                )}
                {/* 功能项 —— 按「设置 → 自定义 UI」里这个挂载位的配置画。 */}
                <CustomUiMenuEntries
                  slot={slot}
                  target={uiTarget}
                  builtins={builtins}
                  itemClass={itemClass}
                  onClose={onClose}
                  after={<div className="my-1 border-t border-edge/60" />}
                />

                {/* 导入到这里 —— 三个库都该有（不限笔记库）。 */}
                <Menu.Item
                  onClick={() => {
                    if (c) onImportHere(c);
                    onClose();
                  }}
                  className={itemClass}
                >
                  <IconDownload size={12} className="shrink-0" />
                  {t("library.ctx.importHere")}
                </Menu.Item>

                {/* （kind 退役：任何分类都能新建 md 笔记） */}
                {c && (
                  <>
                    <Menu.Item
                      onClick={() => {
                        onNewNote(c);
                        onClose();
                      }}
                      className={itemClass}
                    >
                      <IconFileText size={12} className="shrink-0" />
                      {t("library.ctx.newNote")}
                    </Menu.Item>
                    <div className="my-1 border-t border-edge/60" />
                  </>
                )}

                {/* 「新建子分类」在菜单最上面(2026-09-28 接回,决策变更史见 onNewSub
                    的注释 —— kind 退役塌了一层之后,用户要求恢复四级)。 */}

                {/* 挪走 —— 进第二步(点开才列落点,不然一个长列表会把这菜单撑爆) */}
                {c && (
                  <Menu.Item
                    closeOnClick={false}
                    onClick={() => setPicking(true)}
                    className={itemClass}
                  >
                    <IconArrowsExchange size={12} className="shrink-0" />
                    {t("library.collection.moveTo")}
                    <IconChevronRight size={12} className="ml-auto shrink-0 opacity-60" />
                  </Menu.Item>
                )}

                <Menu.Item
                  onClick={() => {
                    if (c) onRename(c);
                    onClose();
                  }}
                  className={itemClass}
                >
                  <IconPencil size={12} className="shrink-0" />
                  {t("library.collection.rename")}
                </Menu.Item>
                <Menu.Item
                  onClick={() => {
                    if (c) onDelete(c);
                    onClose();
                  }}
                  className={cn(itemClass, "hover:text-red-500")}
                >
                  <IconTrash size={12} className="shrink-0" />
                  {t("library.collection.delete")}
                </Menu.Item>
                <CustomUiCustomizeItem
                  slot={slot}
                  itemClass={itemClass}
                  onClose={onClose}
                  before={<div className="my-1 border-t border-edge/60" />}
                />
              </>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
