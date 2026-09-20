/**
 * 左栏**模版里那个文件行**的右键菜单。
 *
 * ## 与文献行菜单同一套
 *
 * 用户的要求是「模版每个 collection 下面的文件也要能够右键,和文档一样」。文献行那份
 * 菜单里能做的,在这里能做的对应关系是:
 *
 *   预览原文(应用内)   → 应用内预览 —— 读正文显示在**中间**(见 `FileViewer`)
 *   在文件夹中打开      → 同一条(定位到这条模版的目录,文件就在里头)
 *   用外部编辑器打开    → 用外部程序打开 —— Word / PPT / PDF 只能这么看
 *
 * **没有**「移动到 / 复制到」:文件的归属由它所在的目录决定,搬文件是资源管理器的事,
 * 与模版行菜单里不提供"搬类目"是同一个理由。
 *
 * 也没有「添加到当前对话」:对话里挂的是**一条模版**(一份清单,里面本来就列全了这套
 * 文件连同正文)。挂单个文件是另一件事 —— 那该走输入框的「+」或直接把文件拖进去。
 */
import { Menu } from "@base-ui/react/menu";
import type { TemplateEntry } from "@contracts/templates";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { useToastStore } from "@renderer/stores/toastStore.js";
import { useCursorAnchor } from "@renderer/hooks/useCursorAnchor.js";
import { IconExternalLink, IconFileText, IconFolderOpen } from "@renderer/lib/icons.js";

export interface TemplateFileCtxTarget {
  entry: TemplateEntry;
  /** 相对条目目录的路径 —— 与 `TemplateFile.relPath` 逐字一致。 */
  relPath: string;
  x: number;
  y: number;
}

interface Props {
  target: TemplateFileCtxTarget | null;
  onClose: () => void;
  /** 应用内预览 —— 切右栏标签那一步在左栏那边做,这里只报"用户点了"。 */
  onPreview: (entry: TemplateEntry, relPath: string) => void;
}

export function TemplateFileContextMenu({ target, onClose, onPreview }: Props) {
  const { t } = useI18n();
  const anchor = useCursorAnchor(target);

  const itemClass = cn(
    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs outline-none select-none",
    "text-content-muted data-[highlighted]:bg-surface-muted",
  );

  const entry = target?.entry;
  const relPath = target?.relPath;

  const report = (body?: string) =>
    useToastStore
      .getState()
      .push({ kind: "error", title: t("templates.preview.actionFailed"), body });

  /** 在这条模版的目录里定位。失败要说出来 —— 用户可能已经在资源管理器里动过它。 */
  const reveal = async (e: TemplateEntry) => {
    try {
      const res = await api.templates.reveal({ kind: e.kind, dirName: e.dirName });
      if (!res.ok) report(res.error);
    } catch (err) {
      report(err instanceof Error ? err.message : String(err));
    }
  };

  const openExternal = async (e: TemplateEntry, rel: string) => {
    try {
      const res = await api.templates.openFile({ kind: e.kind, dirName: e.dirName, relPath: rel });
      if (!res.ok) report(res.error);
    } catch (err) {
      report(err instanceof Error ? err.message : String(err));
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
            <Menu.Item
              onClick={() => {
                if (entry && relPath) onPreview(entry, relPath);
                onClose();
              }}
              className={itemClass}
            >
              <IconFileText size={12} className="shrink-0" />
              {t("templates.ctx.preview")}
            </Menu.Item>

            <div className="my-1 border-t border-edge/60" />
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
            <Menu.Item
              onClick={() => {
                if (entry && relPath) void openExternal(entry, relPath);
                onClose();
              }}
              className={itemClass}
            >
              <IconExternalLink size={12} className="shrink-0" />
              {t("templates.ctx.openExternal")}
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
