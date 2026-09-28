/**
 * PDF 阅读器入口 —— **懒加载外壳**。
 *
 * 真正的实现（EmbedPDF + pdfium 胶水，超过 1MB）在 `PdfPreviewImpl.tsx`，原文件
 * 整体搬了过去，引擎选型和「三件必须做对的事」的说明都在那里。这一层只做一件事：
 * 真的要显示 PDF 时才去加载那一大块，好让它不压在首屏上（perf 待办，见
 * docs/perf-slimming-20260928.md）。
 *
 * 三个调用点（`FileViewer`、`FilePreview`、`FileEditor` 的预览档）照旧静态
 * `import { PdfPreview } from "./PdfPreview.js"`，props 一个字都没变。
 */
import { lazy, Suspense, type ComponentProps } from "react";
import type { PdfPreview as PdfPreviewImpl } from "./PdfPreviewImpl.js";

const Impl = lazy(() => import("./PdfPreviewImpl.js").then((m) => ({ default: m.PdfPreview })));

export type PdfPreviewProps = ComponentProps<typeof PdfPreviewImpl>;

export function PdfPreview(props: PdfPreviewProps) {
  return (
    <Suspense fallback={null}>
      <Impl {...props} />
    </Suspense>
  );
}
