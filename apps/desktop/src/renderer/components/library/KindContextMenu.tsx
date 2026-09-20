/**
 * 左栏**小类 tab**的右键菜单 —— 新建分类 / 全部显示 / 重命名 / 删除小类(类型)。
 *
 * ## 菜单项顺序 = 层级顺序(三个菜单同一条规矩)
 *
 * 用户定的是「**右键第 N 级 → 新建第 N+1 级**」,所以"往下一级建"排**最前**:
 *
 *   右键大类标题 → 新建小类(GroupContextMenu)
 *   右键小类 tab → 新建**分类**(本菜单第一项)
 *   右键分类行   → 新建**子分类**(CollectionContextMenu)
 *
 * 在 tab 上右键,下一级就是"这个类型下面的第一个分类"。原来这一项挂在**大类**菜单里,
 * 而 tab 上只有改名/删除 —— 用户想建一个分类时会去 tab 上右键(那是他正看着的那一级),
 * 结果找不到入口。
 *
 * ## 「全部显示」—— 从常驻的一行收进菜单里的开关
 *
 * 原来列表最上面**永远挂着一行**「全部文献」(展开就是整个库的条目)。用户的评价是
 * 「太大了,占空间」,要的是"平时列表里只有分类,想看全部时再看"。
 *
 * 于是它变成这一项:打开后**只平铺这一类的全部条目、不画分类那一层**(用户原话
 * 「只显示文件列表,不显示 collection」)。开着的时候菜单项文案换成「只看分类」,
 * 否则用户不知道该怎么回去 —— 一个"打开不了关不上"的开关比没有更糟。
 *
 * 内置类型不可删:菜单项**置灰**并带 tooltip 说明,而不是藏掉 —— 藏掉的话用户
 * 分不清"内置"和"坏了",置灰 + 一句话解释更明白(后端 parseLibraryTypesJson
 * 也会拦,但界面先挡住更体面)。
 *
 * 版式与 `GroupContextMenu` 保持一致(同一个 base-ui Menu + 光标锚点)。
 */
import { Menu } from "@base-ui/react/menu";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useCursorAnchor } from "@renderer/hooks/useCursorAnchor.js";
import { cn } from "@renderer/lib/cn.js";
import { IconFiles, IconMessage, IconPencil, IconPlus, IconTrash } from "@renderer/lib/icons.js";
import { MENU_ITEM_CLASS, MenuDivider, SidebarMenu } from "@renderer/components/sidebar/Sidebar.js";

export interface KindCtxTarget {
  /** 右键落在哪个类型 tab 上。 */
  kind: string;
  x: number;
  y: number;
}

export function KindContextMenu({
  target,
  builtin,
  showAll,
  onClose,
  onNewCollection,
  onToggleShowAll,
  onAttachToChat,
  onRename,
  onDelete,
}: {
  target: KindCtxTarget | null;
  /** 右键的这个类型是不是出厂内置(内置不可删)。 */
  builtin: boolean;
  /** 「全部显示」当前是不是开着(开着就显示「只看分类」)。 */
  showAll: boolean;
  onClose: () => void;
  /** 在**这个 tab 的类型**下面新建一个分类 —— 右键 tab = 建它的下一级。 */
  onNewCollection: () => void;
  /** 切换「全部显示」:只平铺这一类下的**全部条目**,不画分类那一层。 */
  onToggleShowAll: () => void;
  /** 把这一个小类挂进当前对话(附件键 `k:<库>`)。 */
  onAttachToChat: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const anchor = useCursorAnchor(target);
  const lockTitle = t("library.kind.builtinLocked");

  return (
    <SidebarMenu open={!!target} anchor={anchor} onClose={onClose}>
      {/* 「建下一级」排最前 —— 见文件头那段"菜单项顺序就是层级顺序" */}
      <Menu.Item
        onClick={() => {
          onNewCollection();
          onClose();
        }}
        className={MENU_ITEM_CLASS}
      >
        <IconPlus size={12} className="shrink-0" />
        {t("library.collection.new")}
      </Menu.Item>
      {/* 「全部显示」—— 原来它是列表最上面**常驻的一行**(「全部文献」),用户说
          「太大了,占空间」,于是收进这里当开关:要看全部条目时打开,平时列表里
          只有分类。开着的时候那一项要**说得出怎么回去**,所以文案跟着状态换。 */}
      <Menu.Item
        onClick={() => {
          onToggleShowAll();
          onClose();
        }}
        className={MENU_ITEM_CLASS}
      >
        <IconFiles size={12} className="shrink-0" />
        {showAll ? t("library.kind.showCollections") : t("library.kind.showAll")}
      </Menu.Item>
      {/* 挂进当前对话 —— 用户要求「每一级右键都可以选择加入到当前对话」。 */}
      <Menu.Item
        onClick={() => {
          onAttachToChat();
          onClose();
        }}
        className={MENU_ITEM_CLASS}
      >
        <IconMessage size={12} className="shrink-0" />
        {t("library.ctx.attachToChat")}
      </Menu.Item>
      <MenuDivider />
      <Menu.Item
        onClick={() => {
          onRename();
          onClose();
        }}
        className={MENU_ITEM_CLASS}
      >
        <IconPencil size={12} className="shrink-0" />
        {t("library.kind.rename")}
      </Menu.Item>
      <Menu.Item
        disabled={builtin}
        onClick={() => {
          onDelete();
          onClose();
        }}
        className={cn(MENU_ITEM_CLASS, "hover:text-red-500", builtin && "cursor-not-allowed opacity-40")}
      >
        {/* tooltip 挂在内容上而不是菜单项上:置灰项的悬停提示走 span 的 title 就够 */}
        <span className="shrink-0" title={builtin ? lockTitle : undefined}>
          <IconTrash size={12} />
        </span>
        <span className="min-w-0 flex-1 truncate" title={builtin ? lockTitle : undefined}>
          {t("library.kind.delete")}
        </span>
      </Menu.Item>
    </SidebarMenu>
  );
}
