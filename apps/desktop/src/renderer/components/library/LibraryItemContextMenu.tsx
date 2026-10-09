/**
 * 左栏文献行的右键菜单。
 *
 * ## 移动 / 复制 / 移除 —— 全部复用既有的 `assignCollection`
 *
 * 三件事在这套数据模型里都是「集合归属」的加减法,服务端早就支持了,**不需要任何
 * 新接口**:
 *
 *   - **移动** = 从旧集合移除 + 加入新集合
 *   - **复制** = 只加入新集合(一篇可以同时属于多个集合)
 *   - **移除** = 只从旧集合移除(**文献本身不动**,它仍然在「全部文献」里)
 *
 * 移除的语义刻意对齐 Zotero 的 "Remove from Collection":集合是**视图**,不是所有权。
 * 用户不会因为整理分组而丢掉一篇文献 —— 要真删得走「从库中移除」。
 *
 * ## 为什么是「两步」而不是悬停子菜单
 *
 * 一开始用的是 base-ui 的 `Menu.SubmenuRoot` + `openOnHover`。实测有问题:子菜单
 * 弹出时**整个菜单会消失**,根本选不中。原因是根菜单是**受控**的
 * (`open={!!ctxMenu}` + `onOpenChange` 里立刻把状态清成 null)—— 指针从触发项移向
 * 子菜单时会触发一次关闭事件,那一下就把整棵菜单卸载了。
 *
 * 与其去猜 base-ui 内部的悬停/关闭判定,不如换成**点击推进的两步菜单**:点「移动到」
 * 把面板内容换成集合列表(带「← 返回」)。没有悬停、没有子菜单、没有可消失的中间态;
 * 集合多的时候还是一整块可滚动的列表,比子菜单更好点。
 *
 * ## 打开 / 预览走同一条安全通道
 *
 * 路径一律由主进程从库里取(入参只有条目 id),渲染端拼不出任意路径。见
 * `library.revealFile` / `library.openFile` 的说明 —— 那两条就是为了绕开
 * `shell.showItemInFolder` / `shell.openPath` 上「只允许项目根」的围栏。
 */
import { useEffect, useState } from "react";
import { Menu } from "@base-ui/react/menu";
import type { LibraryCollection, LibraryItem } from "@contracts/library";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { api } from "@renderer/lib/api.js";
import { attachToCurrentChat } from "@renderer/lib/attachToChat.js";
import { cn } from "@renderer/lib/cn.js";
import { useCursorAnchor } from "@renderer/hooks/useCursorAnchor.js";
import type { CustomUiTarget } from "@contracts/customUi";
import {
  CustomUiCustomizeItem,
  CustomUiMenuEntries,
  type BuiltinRuntime,
} from "@renderer/components/customUi/CustomUiMenuItems.js";
import { useLibraryStore } from "@renderer/stores/libraryStore.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useToastStore } from "@renderer/stores/toastStore.js";
import {
  IconArrowLeft,
  IconArrowsExchange,
  IconBook,
  IconChevronRight,
  IconFolderOpen,
  IconPencil,
  IconPlus,
  IconTrash,
} from "@renderer/lib/icons.js";

export interface LibraryCtxTarget {
  item: LibraryItem;
  /** 右键落在哪个库上 —— 「从当前文献库移除」移除的就是它。null = 在「全部文献」里右键。 */
  collectionId: string | null;
  /**
   * 右键落在的库是不是**回收站**。
   *
   * 这一个布尔值决定菜单里那个红色项是哪个意思,而两者的后果天差地别:
   *   - 回收站里 → **真正的删除**:数据库行加磁盘上的 PDF / Markdown 一起没;
   *   - 别处     → 只是把它移出这个分组:沦为孤儿后自动落进回收站,**捞得回来**。
   * 少了它,回收站里只剩「从当前文献库移除」—— 那在这里恰好是反的(摘出回收站,
   * 却没删掉),条目会变成界面上再也找不回来的僵尸记录。
   */
  isTrash: boolean;
  x: number;
  y: number;
}

interface Props {
  ctxMenu: LibraryCtxTarget | null;
  collections: LibraryCollection[];
  onClose: () => void;
  /** 归属变了 —— 让左栏把文献缓存刷一遍。 */
  onChanged: () => void;
  /** 改名(三个库通用)。左栏负责摆输入行 —— 那状态归它。 */
  onRename: (item: LibraryItem) => void;
  /** 在回收站里彻底删掉这一条 —— 确认框与调接口都在左栏,这里只报"用户点了"。 */
  onDeleteForever: (item: LibraryItem) => void;
  /**
   * 管这一条的**关联**（2026-09-21）。
   *
   * 用户要把右栏 `library` tab 删掉，并要求关联的入口「**搬到左栏右键**」。
   * 关联天然是"某一条跟谁关联" —— 挂在条目行上比放在全局设置里合语义。
   */
  onManageLinks: (item: LibraryItem) => void;
  /** 这一段所属的大类 —— 自定义项的「只在这些大类里显示」按它判断。 */
  groupId?: string;
}

/** 面板当前显示哪一步。 */
type Step = { kind: "root" } | { kind: "pick"; mode: "move" | "copy" };

export function LibraryItemContextMenu({
  ctxMenu,
  collections,
  onClose,
  onChanged,
  onRename,
  onDeleteForever,
  onManageLinks,
  groupId,
}: Props) {
  const { t } = useI18n();
  // 虚拟锚点钉在右键的坐标上;菜单退场动画期间冻结在最后的位置(见 useCursorAnchor)
  const anchor = useCursorAnchor(ctxMenu);
  const [step, setStep] = useState<Step>({ kind: "root" });

  // 每次重新右键都从根步骤开始 —— 否则上一次点到「移动到」再右键会直接落在列表上
  useEffect(() => {
    if (ctxMenu) setStep({ kind: "root" });
  }, [ctxMenu]);

  const item = ctxMenu?.item;
  const itemClass = cn(
    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs outline-none select-none",
    "text-content-muted data-[highlighted]:bg-surface-muted",
  );

  /** 目标库 —— 排除掉「右键所在的那个」:移动/复制到自己身上是无意义的。 */
  const others = collections.filter((c) => c.id !== ctxMenu?.collectionId);

  const done = () => {
    onChanged();
    onClose();
  };

  const moveTo = async (targetId: string) => {
    if (!item) return;
    if (ctxMenu?.collectionId) {
      await api.library.assignCollection({
        collectionId: ctxMenu.collectionId,
        itemIds: [item.id],
        add: false,
      });
    }
    await api.library.assignCollection({ collectionId: targetId, itemIds: [item.id], add: true });
    done();
  };

  const copyTo = async (targetId: string) => {
    if (!item) return;
    await api.library.assignCollection({ collectionId: targetId, itemIds: [item.id], add: true });
    done();
  };

  const removeFrom = async () => {
    if (!item || !ctxMenu?.collectionId) return;
    await api.library.assignCollection({
      collectionId: ctxMenu.collectionId,
      itemIds: [item.id],
      add: false,
    });
    done();
  };

  /** 自定义 UI 看到的目标(模板变量 / 显示条件)。 */
  const uiTarget: CustomUiTarget | null = item
    ? {
        kind: "item",
        groupId,
        item: {
          id: item.id,
          title: item.title,
          abstract: item.abstract,
          url: item.url,
          language: item.language,
          pdfPath: item.pdfPath,
          mdPath: item.mdPath,
          filePath: item.filePath,
        },
      }
    : null;

  /**
   * 内置功能项「点了做什么」。显示与否、先后由自定义 UI 的配置决定;这里给 `undefined`
   * 的项这一刻不画(「采纳 MD」只在有文件的条目上才有意义)。
   */
  const builtins: Record<string, BuiltinRuntime | undefined> = item
    ? {
        // 挂到当前对话 —— 与「+ → 添加文献库到上下文」和 AI 的 library_attach_to_chat
        // 共用主进程那一份实现(见 lib/attachToChat.ts)。
        attachToChat: { run: () => void attachToCurrentChat(`i:${item.id}`) },
        // 「文献信息」「采纳 MD」内置项已退役(2026-09-28,见 registry.ts 那条注释):
        // 信息卡走自定义 view 模板;采纳/转录走自动化 + 自定义 automation 项。
        // ★ **看转录文本**（2026-09-21）。用户:「点击和双击都显示这个 pdf 本身，**右键加一个
        // 功能是能够看这个文件链接的转录**」—— 所以"转录"是显式入口。同时把右栏切到预览,
        // 否则面板正停在文件树上,点了没反应。
        viewTranscript: {
          run: () => {
            useLibraryStore.getState().openPreview(item.id, "md");
            useSessionStore.getState().setRightPanelTab("preview");
            useSessionStore.getState().setRightOpen(true);
          },
          disabled: !item.mdPath,
          label: item.mdPath ? undefined : t("library.ctx.viewTranscriptMissing"),
        },
        openMdExternal: {
          run: () => {
            // 同「在文件夹中打开」:openFile 带原因回 {ok:false},静默的话这一项像没反应。
            void api.library.openFile({ id: item.id, which: "md" }).then((res) => {
              if (!res.ok) {
                useToastStore.getState().push({
                  kind: "error",
                  title: t("library.openExternalFailed"),
                  body: res.error ?? "",
                });
              }
            });
          },
          disabled: !item.mdPath,
        },
        links: { run: () => onManageLinks(item) },
      }
    : {};

  return (
    <Menu.Root
      open={!!ctxMenu}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Menu.Portal>
        <Menu.Positioner anchor={anchor} side="bottom" align="start" className="z-50">
          <Menu.Popup
            className={cn(
              "min-w-[220px] origin-top-left rounded-md border border-edge bg-surface py-1 shadow-2xl",
              "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
              "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
            )}
          >
            {step.kind === "pick" ? (
              /* ── 第二步:选目标库 ── */
              <>
                <Menu.Item
                  closeOnClick={false}
                  onClick={() => setStep({ kind: "root" })}
                  className={cn(itemClass, "font-medium text-content")}
                >
                  <IconArrowLeft size={12} className="shrink-0" />
                  {step.mode === "move" ? t("library.ctx.moveTo") : t("library.ctx.copyTo")}
                </Menu.Item>
                <div className="my-1 border-t border-edge/60" />
                {others.length === 0 ? (
                  <div className="px-3 py-1.5 text-[0.7857em] text-content-subtle">
                    {t("library.ctx.noOtherCollection")}
                  </div>
                ) : (
                  others.map((c) => (
                    <Menu.Item
                      key={c.id}
                      onClick={() => void (step.mode === "move" ? moveTo(c.id) : copyTo(c.id))}
                      className={itemClass}
                    >
                      <IconBook size={12} className="shrink-0" />
                      <span className="truncate">{c.name}</span>
                    </Menu.Item>
                  ))
                )}
              </>
            ) : (
              /* ── 第一步:根菜单 ── */
              <>
                {/* 改名放在最前 —— 标题抓错了(扫描件、文件名当标题)是最常见的一次修 */}
                <Menu.Item
                  onClick={() => {
                    if (item) onRename(item);
                    onClose();
                  }}
                  className={itemClass}
                >
                  <IconPencil size={12} className="shrink-0" />
                  {t("library.collection.rename")}
                </Menu.Item>

                {/* 功能项 —— 显示哪些、排第几、以及用户自己加的项,都按「设置 → 自定义 UI」
                    来(见 components/customUi)。这里只递「内置项点了做什么」。管理项(改名 /
                    移动复制 / 移除删除 / 打开文件夹)是固定的,不在这一段里。 */}
                <CustomUiMenuEntries
                  slot="library.item"
                  target={uiTarget}
                  builtins={builtins}
                  itemClass={itemClass}
                  onClose={onClose}
                />
                <div className="my-1 border-t border-edge/60" />

                <Menu.Item
                  closeOnClick={false}
                  onClick={() => setStep({ kind: "pick", mode: "move" })}
                  className={itemClass}
                >
                  <IconArrowsExchange size={12} className="shrink-0" />
                  {t("library.ctx.moveTo")}
                  <IconChevronRight size={12} className="ml-auto shrink-0 opacity-60" />
                </Menu.Item>
                <Menu.Item
                  closeOnClick={false}
                  onClick={() => setStep({ kind: "pick", mode: "copy" })}
                  className={itemClass}
                >
                  <IconPlus size={12} className="shrink-0" />
                  {t("library.ctx.copyTo")}
                  <IconChevronRight size={12} className="ml-auto shrink-0 opacity-60" />
                </Menu.Item>

                {/* 破坏性操作 —— **同一个位置、同一句"删除",两种完全不同的后果**,
                    所以文案必须把是哪一种说清(见 LibraryCtxTarget.isTrash):
                      在回收站里 → 真删(记录 + 磁盘文件,不可还原)
                      在别处     → 只移出这个分组,条目落进回收站,捞得回来 */}
                {ctxMenu?.isTrash ? (
                  <>
                    <div className="my-1 border-t border-edge/60" />
                    <Menu.Item
                      onClick={() => {
                        if (item) onDeleteForever(item);
                        onClose();
                      }}
                      className={cn(itemClass, "hover:text-red-500")}
                    >
                      <IconTrash size={12} className="shrink-0" />
                      {t("library.ctx.deleteForever")}
                    </Menu.Item>
                  </>
                ) : ctxMenu?.collectionId ? (
                  <>
                    <div className="my-1 border-t border-edge/60" />
                    <Menu.Item onClick={() => void removeFrom()} className={itemClass}>
                      <IconTrash size={12} className="shrink-0" />
                      {t("library.ctx.removeFrom")}
                    </Menu.Item>
                  </>
                ) : null}

                <div className="my-1 border-t border-edge/60" />
                <Menu.Item
                  onClick={() => {
                    // 笔记没有 PDF,要揭的是它自己的 .md —— 不然这一项点了没反应
                    // (主进程会回「还没有 PDF」)。三个库共用这一个菜单,所以按 kind 分。
                    // **失败要说出来**(主进程带原因回 `{ok:false}`) —— 从前是 `void …`
                    // 一丢了事,用户点了「在文件夹中打开」什么也看不到。
                    if (item) {
                      void api.library
                        .revealFile({
                          id: item.id,
                          which: !item.pdfPath && item.mdPath ? "md" : "pdf",
                        })
                        .then((res) => {
                          if (!res.ok) {
                            useToastStore.getState().push({
                              kind: "error",
                              title: t("library.revealFailed"),
                              body: res.error ?? "",
                            });
                          }
                        });
                    }
                    onClose();
                  }}
                  className={itemClass}
                >
                  <IconFolderOpen size={12} className="shrink-0" />
                  {t("library.ctx.openFolder")}
                </Menu.Item>
                <CustomUiCustomizeItem
                  slot="library.item"
                  itemClass={itemClass}
                  onClose={onClose}
                  before={<div className="my-1 border-t border-edge/60" />}
                />
              </>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
