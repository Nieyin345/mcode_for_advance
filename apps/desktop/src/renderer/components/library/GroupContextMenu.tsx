/**
 * 左栏**大类标题行**的右键菜单 —— 重命名 / 新建 / 删除大类。
 *
 * 用户新的分工:大类的管理(新建/删除/重命名)**全部收在左栏**,设置页只留提示词。
 * 这里就是大类的唯一管理入口。删除要走确认 —— 组删了只是"类型变未分组"(左栏隐藏、
 * 数据不丢),但界面上少一整段还是值得让用户想一下。
 *
 * 版式与 `CollectionContextMenu` 保持一致(同一个 base-ui Menu + 光标锚点)。
 */
import { Menu } from "@base-ui/react/menu";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useCursorAnchor } from "@renderer/hooks/useCursorAnchor.js";
import { cn } from "@renderer/lib/cn.js";
import { IconPencil, IconPlus, IconTrash } from "@renderer/lib/icons.js";
import { MENU_ITEM_CLASS, MenuDivider, SidebarMenu } from "@renderer/components/sidebar/Sidebar.js";

export interface GroupCtxTarget {
  x: number;
  y: number;
}

export function GroupContextMenu({
  target,
  onClose,
  onRename,
  onCreate,
  onDelete,
}: {
  target: GroupCtxTarget | null;
  onClose: () => void;
  onRename: () => void;
  /** 新建一个大类(空组,名字由调用方收输入)。 */
  onCreate: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  // 虚拟锚点钉在右键坐标上(与分类行菜单同一套)
  const anchor = useCursorAnchor(target);

  return (
    <SidebarMenu open={!!target} anchor={anchor} onClose={onClose}>
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
      <Menu.Item
        onClick={() => {
          onCreate();
          onClose();
        }}
        className={MENU_ITEM_CLASS}
      >
        <IconPlus size={12} className="shrink-0" />
        {t("library.group.new")}
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
