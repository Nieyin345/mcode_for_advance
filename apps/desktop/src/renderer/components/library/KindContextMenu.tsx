/**
 * 左栏**小类 tab**的右键菜单 —— 新建 / 重命名 / 删除小类(类型)。
 *
 * 管理全部收在左栏(用户要求),tab 就是小类的唯一管理入口。「新建小类」建在
 * **当前段的大类**里,用途(查资料用 / 照着写用)由调用方收输入。
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
import { IconPencil, IconPlus, IconTrash } from "@renderer/lib/icons.js";
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
  onClose,
  onCreate,
  onRename,
  onDelete,
}: {
  target: KindCtxTarget | null;
  /** 右键的这个类型是不是出厂内置(内置不可删)。 */
  builtin: boolean;
  onClose: () => void;
  onCreate: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const anchor = useCursorAnchor(target);
  const lockTitle = t("library.kind.builtinLocked");

  return (
    <SidebarMenu open={!!target} anchor={anchor} onClose={onClose}>
      <Menu.Item
        onClick={() => {
          onCreate();
          onClose();
        }}
        className={MENU_ITEM_CLASS}
      >
        <IconPlus size={12} className="shrink-0" />
        {t("library.kind.new")}
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
