import { useEffect, useRef, useState } from "react";
import { Menu } from "@base-ui/react/menu";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import {
  IconBook,
  IconChevronRight,
  IconCommand,
  IconFileText,
  IconPhoto,
  IconPlus,
  IconTemplate,
} from "@renderer/lib/icons.js";
import { useSuppressBrowserView } from "@renderer/hooks/useSuppressBrowserView.js";
import { useLibraryStore } from "@renderer/stores/libraryStore.js";

/**
 * Single "+" entry for composer attachments and quick triggers.
 *
 * Replaces the two dedicated icon buttons (paperclip + image) that used to sit
 * side by side at the left of the composer's action row — one button instead of
 * two keeps the row calm. The menu carries:
 *   - attach context files (project file picker)
 *   - add images (OS picker)
 *   - 文献库:open the searchable library picker (see LibraryPicker)
 *   - slash commands: inserts a `/` at the caret, which the composer's
 *     trigger-detection (recomputePicker) turns into the inline command picker
 *     — the exact same flow as typing `/` by hand (see ChatPane's
 *     openSlashCommand).
 *
 * Direct drag-drop / paste onto the composer keeps working independently of
 * this menu, so the extra click only affects the button-initiated path.
 *
 * Built on @base-ui/react Menu like the other composer dropdowns; the popup is
 * portaled to document.body so it isn't clipped by the composer card.
 */
export function AttachMenuButton({
  disabled,
  segment = false,
  onPickFiles,
  onPickImages,
  onPickLibraries,
  onPickTemplates,
  onSlashCommand,
}: {
  disabled: boolean;
  /** Pill-segment presentation: rendered INSIDE the composer mini pill as
   *  its first segment (ComposerToolbar pill layout) — compact square
   *  trigger with the pill's hover language instead of the freestanding
   *  icon-button look. */
  segment?: boolean;
  /** Open the project-file attach picker (same action as the old paperclip). */
  onPickFiles: () => void;
  /** Open the OS image picker (same action as the old photo button). */
  onPickImages: () => void;
  /** 打开文献库选择器。与 onPickFiles 同款:选择器本体挂在 ChatPane 上,
   *  这里只负责发出请求 —— 因为选中结果要落成 composer 的 tag,那状态归 ChatPane。 */
  onPickLibraries: () => void;
  /** 打开模版选择器 —— 与文献库逐字同款(见 TemplatePicker)。 */
  onPickTemplates: () => void;
  /** Insert a `/` trigger into the editor, opening the command picker. */
  onSlashCommand: () => void;
}) {
  const { t } = useI18n();
  // While the menu is open the embedded browser view is suppressed — but only
  // when the portaled popup actually reaches the browser's rect (the ref lets
  // useSuppressBrowserView measure it); otherwise the browser stays visible.
  const [open, setOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  useSuppressBrowserView(open, popupRef);

  // 菜单里那一项右侧显示"当前绑定了哪些库",不展开也知道上下文里有什么。
  const collections = useLibraryStore((s) => s.collections);
  const loadCollections = useLibraryStore((s) => s.loadCollections);
  useEffect(() => {
    if (open) void loadCollections();
  }, [open, loadCollections]);

  return (
    <Menu.Root open={open} onOpenChange={setOpen}>
      <Menu.Trigger
        disabled={disabled}
        className={cn(
          segment
            ? "composer-minipill-seg w-7 justify-center"
            : "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-content-muted transition-all duration-150 ease-out hover:scale-110 hover:bg-accent/10 hover:text-accent active:scale-95",
          "disabled:scale-100 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-content-muted disabled:hover:scale-100",
        )}
        title={t("chat.attachMenu")}
        aria-label={t("chat.attachMenu")}
      >
        <IconPlus size={segment ? 15 : 18} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="top" align="start">
          <Menu.Popup
            ref={popupRef}
            className={cn(
              "z-50 min-w-[200px] origin-bottom-left rounded-lg border border-edge bg-surface py-1.5 shadow-2xl",
              "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
              "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
              "transition-[transform,opacity] duration-100",
            )}
          >
            <Menu.Item
              onClick={onPickFiles}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] outline-none select-none",
                "text-content-muted data-[highlighted]:bg-surface-muted data-[highlighted]:text-content",
              )}
            >
              <IconFileText size={14} className="shrink-0 opacity-80" />
              <span className="font-medium">{t("chat.attachFiles")}</span>
            </Menu.Item>
            <Menu.Item
              onClick={onPickImages}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] outline-none select-none",
                "text-content-muted data-[highlighted]:bg-surface-muted data-[highlighted]:text-content",
              )}
            >
              <IconPhoto size={14} className="shrink-0 opacity-80" />
              <span className="font-medium">{t("chat.addImage")}</span>
            </Menu.Item>

            <div className="my-1 border-t border-edge" />
            {/* 文献库 —— 点开是一个**可搜索的多选选择器**(与「添加上下文文件」
                同款形态)。库会很多,平铺进菜单会把菜单撑爆。 */}
            <Menu.Item
              onClick={onPickLibraries}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] outline-none select-none",
                "text-content-muted data-[highlighted]:bg-surface-muted data-[highlighted]:text-content",
              )}
            >
              <IconBook size={14} className="shrink-0 opacity-80" />
              <span className="font-medium">{t("library.action.addToContext")}</span>
              {collections.length > 0 && (
                <span className="ml-auto shrink-0 text-[11px] tabular-nums text-content-subtle">
                  {collections.length}
                </span>
              )}
              <IconChevronRight size={13} className="shrink-0 opacity-60" />
            </Menu.Item>

            {/* 模版库 —— 与文献库同款的选择器。这里刻意**不显示条数**:模版列表是
                扫盘得来的(文件系统即事实源),为了一个角标在每次打开菜单时扫一遍
                目录不值得;选择器打开时现扫,反而更新鲜。 */}
            <Menu.Item
              onClick={onPickTemplates}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] outline-none select-none",
                "text-content-muted data-[highlighted]:bg-surface-muted data-[highlighted]:text-content",
              )}
            >
              <IconTemplate size={14} className="shrink-0 opacity-80" />
              <span className="font-medium">{t("templates.chat.addToContext")}</span>
              <IconChevronRight size={13} className="ml-auto shrink-0 opacity-60" />
            </Menu.Item>

            <div className="my-1 border-t border-edge" />
            <Menu.Item
              onClick={onSlashCommand}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] outline-none select-none",
                "text-content-muted data-[highlighted]:bg-surface-muted data-[highlighted]:text-content",
              )}
            >
              <IconCommand size={14} className="shrink-0 opacity-80" />
              <span className="font-medium">{t("chat.slashMenu")}</span>
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
