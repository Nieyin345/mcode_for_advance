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
  IconUserStar,
} from "@renderer/lib/icons.js";
import { useSuppressBrowserView } from "@renderer/hooks/useSuppressBrowserView.js";
import { useLibraryStore } from "@renderer/stores/libraryStore.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { NewSubChatPicker, type SubChatChoice } from "./NewSubChatPicker.js";

/**
 * Single "+" entry for composer attachments and quick triggers.
 *
 * Replaces the two dedicated icon buttons (paperclip + image) that used to sit
 * side by side at the left of the composer's action row — one button instead of
 * two keeps the row calm. The menu carries:
 *   - attach context files (project file picker)
 *   - add images (OS picker)
 *   - 文献库:open the searchable library picker (see LibraryPicker)
 *   - 新建子对话:create a child conversation under the CURRENT session — 空白 /
 *     一份代理档案 / 档案+记忆 (see NewSubChatPicker). The picker itself lives
 *     HERE, not in ChatPane: it is this menu item that knows where it was
 *     clicked (the trigger's own rect is the anchor), and the store action it
 *     calls needs nothing from the composer.
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
  onSlashCommand,
  onNewSubChat,
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
  /** Insert a `/` trigger into the editor, opening the command picker. */
  onSlashCommand: () => void;
  /**
   * 「新建子对话」。
   *
   * **可选、缺省什么都不做** —— 这是刻意留给宿主的一个口子:菜单项本身**总是渲染**
   * (选择器与建会话的逻辑全在本组件里,不需要宿主提供任何东西),这个回调只是给宿主
   * 一个"事后知道了"的机会(比如切到右侧面板、弹个 toast)。缺省传 undefined 时,点了
   * 一样能建出对话来 —— 不会出现"菜单里有这一项但点了没反应"。
   *
   * ⚠️ **别把它做成必填**:`ComposerToolbar` 的 `hasAttach` 判的是另外四个回调全在,
   * 多一个必填的就会让没有它的那些宿主(行式设置列表、手机壳)整块「+」消失。
   */
  onNewSubChat?: (session: { id: string; title: string }) => void;
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

  // 「新建子对话」的选择器。锚点用**这个触发按钮自己的 rect** —— 于是 ChatPane 不必
  // 再传一个 `attachAnchorRef` 进来(别的选择器都要,是因为它们的锚点归 ChatPane 管;
  // 这一个的锚点就在这儿,拿了就走)。
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [pickerAnchor, setPickerAnchor] = useState<DOMRect | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const createSubChat = useSessionStore((s) => s.createSubChat);
  /** 建失败的原因 —— 「点了没反应」是这里最坏的表现,所以必须显示出来。 */
  const [createError, setCreateError] = useState<string | null>(null);

  const openSubChatPicker = () => {
    setCreateError(null);
    setPickerAnchor(triggerRef.current?.getBoundingClientRect() ?? null);
    setPickerOpen(true);
  };

  const onSubChatPick = (choice: SubChatChoice) => {
    void (async () => {
      try {
        const session = await createSubChat({
          profile: choice.profile ? { id: choice.profile.id, name: choice.profile.name } : null,
          memory: choice.memory,
        });
        // null = 守卫拦下了(没主会话 / 没配模型,后者自己会弹配置窗)——
        // 那不是错误,不显示红字。
        if (session) onNewSubChat?.({ id: session.id, title: session.title });
      } catch (err) {
        setCreateError(t("chat.newSubChat.createFailed", { error: (err as Error).message }));
      }
    })();
  };

  return (
    <>
      <Menu.Root open={open} onOpenChange={setOpen}>
        <Menu.Trigger
          ref={triggerRef}
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

              {/* 新建子对话 —— 开在当前会话下面,不进左栏(与右侧问答页签同一批东西,
                  只是从这儿开也能开、而且能带一份角色档案)。**与上面那些不同**:上面
                  那些是把内容**加进这条消息**,这一项是**另开一个对话** —— 所以它自己
                  隔一条分隔线,免得和"往输入框里加东西"混在一起。 */}
              <div className="my-1 border-t border-edge" />
              <Menu.Item
                onClick={openSubChatPicker}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] outline-none select-none",
                  "text-content-muted data-[highlighted]:bg-surface-muted data-[highlighted]:text-content",
                )}
              >
                <IconUserStar size={14} className="shrink-0 opacity-80" />
                <span className="font-medium">{t("chat.newSubChat")}</span>
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

      <NewSubChatPicker
        open={pickerOpen}
        anchorRect={pickerAnchor}
        onPick={onSubChatPick}
        onClose={() => setPickerOpen(false)}
      />

      {/* 建失败的红字。用 fixed 贴在锚点上方 —— 与选择器同一个位置语言,
          并且**不会**被输入框的布局挤动。 */}
      {createError && (
        <div
          className="fixed z-[70] max-w-[420px] rounded-lg border border-red-500/40 bg-surface px-3 py-2 text-[12px] text-red-500 shadow-xl"
          style={{
            left: pickerAnchor?.left ?? 16,
            top: Math.max(8, (pickerAnchor?.top ?? 40) - 8),
            transform: "translateY(-100%)",
          }}
        >
          {createError}
        </div>
      )}
    </>
  );
}
