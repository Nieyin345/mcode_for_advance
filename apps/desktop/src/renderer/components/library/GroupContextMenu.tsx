/**
 * 左栏**大类标题行**的右键菜单 —— 新建分类 / 重命名 / 删除大类。
 *
 * ## 菜单项的顺序就是"层级顺序",不是随手排的
 *
 * 用户定的规矩是「**右键第 N 级 → 新建第 N+1 级**」:
 *
 *   右键大类标题 → 新建**分类**(本菜单第一项,它建的正是下一级)
 *   右键分类行   → 到头,不往下建(层级只有三级:大类 → 分类 → 条目;
 *                  见 CollectionContextMenu 里撤掉「新建子集合」的那段注释)
 *
 * 所以"往下一级建"永远排在**最前**、"管我自己"(重命名/删除)排后面 —— 两个菜单
 * 都是这个顺序。用户在任一级右键,第一项永远是他最可能想要的那个。
 *
 * ## 这里**没有**「新建大类」—— 那是**同级**动作,入口在整片区域最下面
 *
 * 用户的原话是「留一个加号放在最下面,用来新建第一级」。大类是整片区域的一级、
 * 不属于任何一段,所以它的新建入口只有末尾那一个「+」(见 `LibrarySections`)。
 * 早先这里还挂着一项「新建大类」,与末尾那个「+」是同一件事的两个入口 —— 一个右键
 * 菜单里混进一个"建同级"的项,还会把上面那条"菜单项顺序 = 层级顺序"的规矩搅浑。
 *
 * 删除要走确认 —— 组删了只是"类型变未分组"(左栏隐藏、数据不丢),但界面上少一整段
 * 还是值得让用户想一下。
 *
 * 版式与 `CollectionContextMenu` 保持一致(同一个 base-ui Menu + 光标锚点)。
 */
import { Menu } from "@base-ui/react/menu";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useCursorAnchor } from "@renderer/hooks/useCursorAnchor.js";
import { cn } from "@renderer/lib/cn.js";
import { IconMessage, IconPencil, IconPlus, IconTrash } from "@renderer/lib/icons.js";
import { MENU_ITEM_CLASS, MenuDivider, SidebarMenu } from "@renderer/components/sidebar/Sidebar.js";

export interface GroupCtxTarget {
  x: number;
  y: number;
}

export function GroupContextMenu({
  target,
  onClose,
  onNewCollection,
  onRename,
  onAttachToChat,
  onDelete,
}: {
  target: GroupCtxTarget | null;
  onClose: () => void;
  /** 新建**分类**(下一级)。「右键第 N 级 → 建第 N+1 级」的那一项,永远排第一。 */
  onNewCollection: () => void;
  onRename: () => void;
  /** 把本段挂进当前对话(附件键 `g:<组 id>`)。 */
  onAttachToChat: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  // 虚拟锚点钉在右键坐标上(与分类行菜单同一套)
  const anchor = useCursorAnchor(target);

  return (
    <SidebarMenu open={!!target} anchor={anchor} onClose={onClose}>
      {/* 新建分类 —— 「右键第 N 级 → 新建第 N+1 级」,永远第一项。kind 退役后
          第二级就是分类,这里是它唯一的新建入口(2026-09-26 接回:退役那轮删掉了
          旧入口「新建小类」却没补上这一项,左栏从此建不了第二级 —— creating
          那个输入框一直在,只是没人能把它打开)。 */}
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
      <MenuDivider />
      {/* 挂进当前对话 —— 用户要求「每一级右键都可以选择加入到当前对话」。
          大类是范围的**最外一层**:挂它等于把这个大类下所有小类的资料都给了 AI
          (主进程那边按 `g:<组 id>` 展开清单)。 */}
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
        {t("library.group.rename")}
      </Menu.Item>
      <MenuDivider />
      <Menu.Item
        onClick={() => {
          onDelete();
          onClose();
        }}
        className={cn(MENU_ITEM_CLASS, "hover:text-red-500")}
      >
        <IconTrash size={12} className="shrink-0" />
        {t("library.group.delete")}
      </Menu.Item>
    </SidebarMenu>
  );
}
