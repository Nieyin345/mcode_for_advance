/**
 * 「在右栏预览这一条资料」—— 从文献库以外的地方（首屏的「最近加入的资料」）点开一条时用。
 *
 * 语义和左栏文献库**单击一行**完全一样（`LibrarySection.openItem`，2026-09-21 定的：
 * 单击 = 右栏预览，双击 = 中间打开）：选中它、md 落在编辑页其余落在元数据页、右栏切到
 * 「预览」并拉出来。
 *
 * ⚠️ 目前 `LibrarySection.openItem` 里还有一份同样的四步（那个文件在另一路改动手里，
 * 这次没动它）。**那边提交后应改成调用这里**，否则两处会慢慢分叉 —— 已记在
 * `MCode-优化方向.md` 首屏那一行。
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
