import { Menu } from "@base-ui/react/menu";
import { useCursorAnchor } from "@renderer/hooks/useCursorAnchor.js";
import { IconStack2, IconX } from "@renderer/lib/icons.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import type { SessionTabCloseMode } from "./sessionTabContextActions.js";

/** Same cursor-anchored, controlled Base UI menu convention as file tabs.
 * Session tab close only removes the tab — it never destroys an Agent session.
 * The caller is the sole owner of original store actions and close guards. */
export function SessionTabContextMenu({
  ctxMenu,
  tabCount,
  onClose,
  onCloseSessions,
}: {
  ctxMenu: { id: string; x: number; y: number } | null;
  tabCount: number;
  onClose: () => void;
  onCloseSessions: (id: string, mode: SessionTabCloseMode) => void;
}) {
  const { t } = useI18n();
  const anchor = useCursorAnchor(ctxMenu);
  const select = (mode: SessionTabCloseMode) => {
    if (ctxMenu?.id) onCloseSessions(ctxMenu.id, mode);
  };
  const itemClass =
    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-content-muted outline-none select-none data-[highlighted]:bg-surface-muted data-[disabled]:opacity-40";
  return (
    <Menu.Root open={!!ctxMenu} onOpenChange={(open) => { if (!open) onClose(); }}>
      <Menu.Portal>
        <Menu.Positioner anchor={anchor} side="bottom" align="start" sideOffset={4}>
          <Menu.Popup className="z-50 min-w-[176px] rounded-[var(--radius-btn-xs)] border border-edge bg-surface py-1 shadow-[var(--shadow-popover)]">
            <Menu.Item className={itemClass} onClick={() => select("one")}>
              <IconX size={14} aria-hidden className="shrink-0" />
              <span>{t("common.close")}</span>
            </Menu.Item>
            <Menu.Item className={itemClass} disabled={tabCount <= 1} onClick={() => select("others")}>
              <IconX size={14} aria-hidden className="shrink-0 opacity-60" />
              <span>{t("ide.editor.closeOthers")}</span>
            </Menu.Item>
            <Menu.Separator className="my-1 h-px bg-edge" />
            <Menu.Item className={itemClass} onClick={() => select("all")}>
              <IconStack2 size={14} aria-hidden className="shrink-0" />
              <span>{t("ide.editor.closeAll")}</span>
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
