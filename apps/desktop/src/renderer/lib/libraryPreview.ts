/**
 * 「在右栏预览这一条资料」—— 左栏文献库**单击一行**(`LibrarySection.openItem`)和首屏的
 * 「最近加入的资料」共用这一份。
 *
 * 语义和左栏文献库**单击一行**完全一样（`LibrarySection.openItem`，2026-09-21 定的：
 * 单击 = 右栏预览，双击 = 中间打开）：选中它、md 落在编辑页其余落在元数据页、右栏切到
 * 「预览」并拉出来。
 *
 *   - **看本体**：`setActiveItem` 把 `previewWhich` 清成 null，于是"上一条在看转录、这一条
 *     自己弹回到 PDF"是白拿的 —— 用户要的是"点击和双击都显示这个 PDF 本身"，转录只能从
 *     左栏右键「查看转录文本」进。
 *   - md 点开就是要写/改它，落在编辑页；其余落在元数据页（kind 退役后按扩展名判）。
 *   - 右栏切「预览」并拉出来；双击才是进中间编辑（`openItemInCenter`）。
 *
 * 2026-09-26 起 `LibrarySection.openItem` 改成调用这里，原先那边自己抄的一份删掉了。
 */
import type { LibraryItem } from "@contracts/library";
import { useLibraryStore } from "@renderer/stores/libraryStore.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";

export function previewLibraryItem(item: Pick<LibraryItem, "id" | "mdPath" | "filePath">): void {
  const lib = useLibraryStore.getState();
  // `setActiveItem` 顺带把 previewWhich 清成 null —— 看的是本体，不是转录。
  lib.setActiveItem(item.id);
  const isMd = Boolean(item.mdPath?.endsWith(".md") || item.filePath?.endsWith(".md"));
  lib.setDetailTab(isMd ? "edit" : "meta");
  const session = useSessionStore.getState();
  session.setRightPanelTab("preview");
  session.setRightOpen(true);
}
