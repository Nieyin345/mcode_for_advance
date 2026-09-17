/**
 * 左栏**分类行**的右键菜单。
 *
 * ## 为什么需要它
 *
 * 原先只有文献行有右键菜单,分类行只有"悬停才出现的两个小图标"(重命名 / 删除)。
 * 而用户要的「在笔记库里右键新建笔记」没有地方放 —— 这也是笔记的创建入口只有一个
 * (导入条里那个输入框)的原因。右键菜单把这类"对这个分类做的事"集中到一处:
 * 添加到当前对话 / 新建笔记 / 新建子集合 / 重命名 / 删除。
 *
 * ## 「新建笔记」只在笔记库里出现
 *
 * 文献库和教材库里的条目是 PDF(导入进来的),没有"就地新建一篇"这回事;笔记是
 * 用户自己写的,才有新建。菜单项按 kind 决定是否出现,而不是给一个点了没用的项。
 *
 * ## 「新建子集合」
 *
 * 统一资料库支持嵌套(parentId),但树行上原来只有建根集合的「+」(在段头上)。
 * 建在某个分类**下面**的入口就落在这里 —— 右键哪个分类,新集合就建到它下面。
 *
 * 版式与 `LibraryItemContextMenu` 保持一致(同一个 base-ui Menu + 光标锚点)。
 */
import { Menu } from "@base-ui/react/menu";
import type { LibraryCollection } from "@contracts/library";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { attachToCurrentChat } from "@renderer/lib/attachToChat.js";
import { cn } from "@renderer/lib/cn.js";
import { useCursorAnchor } from "@renderer/hooks/useCursorAnchor.js";
import { IconFileText, IconMessage, IconPencil, IconPlus, IconTrash } from "@renderer/lib/icons.js";

export interface CollectionCtxTarget {
  collection: LibraryCollection;
  x: number;
  y: number;
}

export function CollectionContextMenu({
  target,
  onClose,
  onRename,
  onDelete,
  onNewNote,
  onNewSubcollection,
}: {
  target: CollectionCtxTarget | null;
  onClose: () => void;
  onRename: (c: LibraryCollection) => void;
  onDelete: (c: LibraryCollection) => void;
  /** 新建一篇笔记并归入这个分类。只在笔记库里用得上。 */
  onNewNote: (c: LibraryCollection) => void;
  /** 在这个分类下面新建一个子集合。 */
  onNewSubcollection: (c: LibraryCollection) => void;
}) {
  const { t } = useI18n();
  // 虚拟锚点钉在右键坐标上(与文献行菜单同一套)
  const anchor = useCursorAnchor(target);

  const itemClass = cn(
    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs outline-none select-none",
    "text-content-muted data-[highlighted]:bg-surface-muted",
  );

  const c = target?.collection;

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
            {/* 挂到当前对话 —— 整段流程与「+ → 添加文献库到上下文」共用主进程那一份
                实现(见 lib/attachToChat.ts),所以挂出来的是同一个 chip、同一份清单。 */}
            <Menu.Item
              onClick={() => {
                if (c) void attachToCurrentChat(`c:${c.id}`);
                onClose();
              }}
              className={itemClass}
            >
              <IconMessage size={12} className="shrink-0" />
              {t("library.ctx.attachToChat")}
            </Menu.Item>
            <div className="my-1 border-t border-edge/60" />

            {c?.kind === "note" && (
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

            {/* 建在它下面 —— 右键谁就建到谁下面,输入行会挂在那行的正下方 */}
            {c && (
              <Menu.Item
                onClick={() => {
                  onNewSubcollection(c);
                  onClose();
                }}
                className={itemClass}
              >
                <IconPlus size={12} className="shrink-0" />
                {t("library.collection.newSub")}
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
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
