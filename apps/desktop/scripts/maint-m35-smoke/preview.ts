/** Render the actual FilePreview decision tree without Electron or a DOM. */
import assert from "node:assert/strict";
import type { LibraryItem } from "@contracts/library";
import type { LibraryFileContent } from "@contracts/ipc";
import { FilePreview } from "@renderer/components/library/FilePreview.js";
import { setRenderStates } from "./stubs/react/index.js";
import { PdfPreview } from "./stubs/previewDeps.js";

type Element = { type: unknown; props: { children?: unknown; [key: string]: unknown } };
function find(value: unknown, component: unknown): Element | null {
  if (Array.isArray(value)) return value.map((v) => find(v, component)).find(Boolean) ?? null;
  if (!value || typeof value !== "object" || !("props" in value)) return null;
  const el = value as Element;
  return el.type === component ? el : find(el.props.children, component);
}
const item = { id: "dir-1", title: "Shared papers", filePath: "C:/papers/collection" } as LibraryItem;
const content = { type: "binary", mime: "application/pdf", base64: Buffer.from("%PDF-1.7").toString("base64") } as LibraryFileContent;
// 7 useState calls: relPath, content, error, loading, pdfPath, selection, quote.
function render(rel: string | null) {
  setRenderStates(rel, content, null, false, "C:/papers/collection", null, null);
  const root = FilePreview({ item });
  const pdf = find(root, PdfPreview);
  assert.ok(pdf, "the directory's PDF should render PdfPreview");
  return pdf.props.filePath;
}
assert.equal(render(null), "C:/papers/collection", "a PDF item uses its own entryPath");
assert.equal(render("appendix/supplement.pdf"), "C:/papers/collection/appendix/supplement.pdf",
  "a PDF child must save to its child path, not the directory root");
console.log("PASS M35 nested PDF annotation save target");
