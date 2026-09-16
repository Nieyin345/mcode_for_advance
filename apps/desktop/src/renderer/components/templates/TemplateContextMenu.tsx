/**
 * 左栏**模版行**的右键菜单。
 *
 * ## 与文献行菜单(`LibraryItemContextMenu`)同一套
 *
 * 版式、光标锚点、退场动画都是逐字照抄那边 —— 用户的原话是「模版和文档是同级别的,
 * 只不过给 ai 的提示词不一样,只有这个区别」。所以菜单也照着那边长。
 *
 * 只保留根步骤(没有「移动到 / 复制到」那种两步推进):模版的归属是**类目**,而类目
 * 是固定的五个,由磁盘上的目录决定 —— 不传 kind 就没法定位一条模版(见
 * `contracts/src/templates.ts`)。所以"搬类目"这件事只能靠用户在文件夹里搬,不在这里
 * 假装能做。
 *
 * ## 两种模式:普通 / 回收站
 *
 * 差别只在最下面那一组,而这一组恰好是整个菜单里唯一不可逆的地方:
 *
 *   普通   —— 「删除模版」= **移进回收站**(可逆,与文献库的「从当前文献库移除」同位)
 *   回收站 —— 「还原」回原类目 + 「彻底删除」(目录连文件一起从磁盘上消失)
 *
 * 这与文献库是同一条设计:删除永远先留退路,真正的删除只在回收站里做。少了这个区分,
 * 回收站就没有存在意义 —— 里面那个"删除"会变成又一次"移进回收站"。
 */
import { Menu } from "@base-ui/react/menu";
import type { TemplateEntry } from "@contracts/templates";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { api } from "@renderer/lib/api.js";
import { attachTemplateToCurrentChat } from "@renderer/lib/attachToChat.js";
import { cn } from "@renderer/lib/cn.js";
import { useToastStore } from "@renderer/stores/toastStore.js";
import { useCursorAnchor } from "@renderer/hooks/useCursorAnchor.js";
import {
  IconArrowBackUp,
  IconFolderOpen,
  IconMessage,
  IconPencil,
  IconTrash,
} from "@renderer/lib/icons.js";

export interface TemplateCtxTarget {
  entry: TemplateEntry;
  /** 右键落在回收站里 —— 决定下面那一组是「删除」还是「还原 / 彻底删除」。 */
  inTrash: boolean;
  x: number;
  y: number;
}

interface Props {
  target: TemplateCtxTarget | null;
  onClose: () => void;
  /** 改名 —— 与文献库那边分类行的「重命名」同一个位置、同一套手感。 */
  onRename: (entry: TemplateEntry) => void;
  /** 删除 = 移进回收站(可逆)。确认框与调接口都在左栏那边,这里只报"用户点了"。 */
  onTrash: (entry: TemplateEntry) => void;
  onRestore: (entry: TemplateEntry) => void;
  onPurge: (entry: TemplateEntry) => void;
}

export function TemplateContextMenu({
  target,
  onClose,
  onRename,
  onTrash,
  onRestore,
  onPurge,
}: Props) {
  const { t } = useI18n();
  // 虚拟锚点钉在右键坐标上(与文献行 / 分类行菜单同一套)
  const anchor = useCursorAnchor(target);

  const itemClass = cn(
    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs outline-none select-none",
    "text-content-muted data-[highlighted]:bg-surface-muted",
  );

  const entry = target?.entry;

  /**
   * 在资源管理器里定位这条模版。
   *
   * 失败**必须说出来** —— 设置页那个面板就是这么做的,理由一样:用户很可能已经在
   * 资源管理器里把目录删了,那时"点了没反应"和"功能坏了"分不出来。
   */
  const reveal = async (e: TemplateEntry) => {
    const failed = (body?: string) =>
      useToastStore
        .getState()
        .push({ kind: "error", title: t("settings.templates.openFailed"), body });
    try {
      const res = await api.templates.reveal({ kind: e.kind, dirName: e.dirName });
      if (!res.ok) failed(res.error);
    } catch (err) {
      // 移动端的 web shim 对没有映射的命名空间是同步抛错的,必须接住
      failed(err instanceof Error ? err.message : String(err));
    }
  };

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
              "min-w-[200px] origin-top-left rounded-md border border-edge bg-surface py-1 shadow-2xl",
              "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
              "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
            )}
          >
            {/* 挂到当前对话 —— 与「+ → 模版」共用主进程那一份实现
                (见 templates/store.ts 的 attachTemplateToChat)。回收站里的也照样能挂:
                文献库那边同理,回收站只是一个普通分类,里面的条目照样能挂。 */}
            <Menu.Item
              onClick={() => {
                if (entry) void attachTemplateToCurrentChat(entry.kind, entry.dirName);
                onClose();
              }}
              className={itemClass}
            >
              <IconMessage size={12} className="shrink-0" />
              {t("templates.ctx.attachToChat")}
            </Menu.Item>

            <Menu.Item
              onClick={() => {
                if (entry) void reveal(entry);
                onClose();
              }}
              className={itemClass}
            >
              <IconFolderOpen size={12} className="shrink-0" />
              {t("settings.templates.reveal")}
            </Menu.Item>

            {/* 改名放在「在文件夹中打开」下面、危险操作上面 —— 与文献库那边分类行
                右键菜单的排布一致(那边也是:加入对话 / 新建笔记 / 改名 / 删除)。
                **回收站里不给改名**:那时该做的先是从回收站还原回去,而给一个在
                回收站目录里改名的入口只会让人分不清自己改的是哪一份。 */}
            {!target?.inTrash && (
              <Menu.Item
                onClick={() => {
                  if (entry) onRename(entry);
                  onClose();
                }}
                className={itemClass}
              >
                <IconPencil size={12} className="shrink-0" />
                {t("templates.ctx.rename")}
              </Menu.Item>
            )}

            <div className="my-1 border-t border-edge/60" />
            {target?.inTrash ? (
              <>
                {/* 还原放在彻底删除**上面** —— 这两个挨着,而其中最常用、也最可能是
                    想要的那个是还原(进了回收站多半是想反悔) */}
                <Menu.Item
                  onClick={() => {
                    if (entry) onRestore(entry);
                    onClose();
                  }}
                  className={itemClass}
                >
                  <IconArrowBackUp size={12} className="shrink-0" />
                  {t("templates.ctx.restore")}
                </Menu.Item>
                <Menu.Item
                  onClick={() => {
                    if (entry) onPurge(entry);
                    onClose();
                  }}
                  className={cn(itemClass, "hover:text-red-500")}
                >
                  <IconTrash size={12} className="shrink-0" />
                  {t("templates.ctx.purge")}
                </Menu.Item>
              </>
            ) : (
              <Menu.Item
                onClick={() => {
                  if (entry) onTrash(entry);
                  onClose();
                }}
                className={cn(itemClass, "hover:text-red-500")}
              >
                <IconTrash size={12} className="shrink-0" />
                {t("settings.templates.delete")}
              </Menu.Item>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
