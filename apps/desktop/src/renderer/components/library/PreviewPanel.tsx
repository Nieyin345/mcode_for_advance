/**
 * 右栏的**预览**标签（2026-09-21）。
 *
 * ## 它替掉了什么
 *
 * 原来右栏有两个标签：「文献库」和「模版库」。那两个面板把**列表 + 检索 + 导入 +
 * 详情**全塞在 400px 宽的栏里，而用户要的分工是：
 *
 *   - **单击**左栏的文件 → 在这里**简单看一眼**（预览）；
 *   - **双击** → 进主页面编辑（那是另一个组件的事，不在这儿）；
 *   - 检索 → Ctrl+K 的「文档」tab；导入 / 转换 / 引用 / 关联 / 文献信息 → 左栏右键。
 *
 * 所以这一栏只剩**一件事**：把用户刚点的那个文件显示出来。
 *
 * ## 看的是哪个文件
 *
 * `libraryStore.activeItemId` —— 左栏单击写它（`openItem`）。**不另开一份状态**：
 * 左栏选中哪一篇、这里就显示哪一篇，两处读同一个字段才不会出现"左栏高亮着 A、
 * 右边显示着 B"。
 *
 * ⚠️ 内容用 `FilePreview`（它已经支持 md / 图片 / pdf / office / 目录）——
 * **不是**中间栏那个 `FileViewer`。那两个是不同的东西：中间那个是"打开来读/改"，
 * 这个是"扫一眼"。
 */
import { useLibraryStore } from "@renderer/stores/libraryStore.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { FilePreview } from "./FilePreview.js";
import { IconFileSearch } from "@renderer/lib/icons.js";

export function PreviewPanel() {
  const { t } = useI18n();
  const activeItemId = useLibraryStore((s) => s.activeItemId);
  const which = useLibraryStore((s) => s.previewWhich);
  const item = useLibraryStore((s) => {
    if (!activeItemId) return null;
    // 两处缓存都找一遍（展开过的分类 / "全部"那一层），谁先有算谁。
    const inCollections = Object.values(s.itemsByCollection)
      .flat()
      .find((i) => i.id === activeItemId);
    if (inCollections) return inCollections;
    // ⚠️ `allItemsByKind` 是 `Partial<Record<…>>` —— 它的值可能是 `undefined`
    // （那个 kind 还没拉过），所以要滤一道再找。
    return (
      Object.values(s.allItemsByKind)
        .flatMap((list) => list ?? [])
        .find((i) => i.id === activeItemId) ?? null
    );
  });

  if (!item) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <IconFileSearch size={22} className="text-content-subtle opacity-60" />
        <div className="text-[12px] leading-relaxed text-content-subtle">
          {t("layout.preview.empty")}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-edge px-2.5 py-1.5">
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-content">
          {item.title}
        </span>
        {/* 正在看转录时标一下 —— 否则"这篇论文怎么不是 PDF"要靠用户自己猜。
            点它切回 PDF 本体（用户要的默认就是本体）。 */}
        {which === "md" && (
          <button
            onClick={() => useLibraryStore.getState().openPreview(item.id)}
            title={t("library.ctx.offerMd")}
            className="shrink-0 rounded px-1.5 py-0.5 text-[0.7857em] text-accent hover:bg-surface-hover"
          >
            {t("library.ctx.viewTranscript")}
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <FilePreview item={item} which={which ?? undefined} />
      </div>
    </div>
  );
}
