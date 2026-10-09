/** Render the actual FilePreview decision tree without Electron or a DOM. */
import assert from "node:assert/strict";
import type { LibraryItem } from "@contracts/library";
import type { LibraryFileContent } from "@contracts/ipc";
import { FilePreview } from "@renderer/components/library/FilePreview.js";
import { setRenderStates, setterCalls } from "./stubs/react/index.js";
import { PdfPreview } from "./stubs/previewDeps.js";

type Element = { type: unknown; props: { children?: unknown; [key: string]: unknown } };
function find(value: unknown, component: unknown): Element | null {
  if (Array.isArray(value)) return value.map((v) => find(v, component)).find(Boolean) ?? null;
  if (!value || typeof value !== "object" || !("props" in value)) return null;
  const el = value as Element;
  return el.type === component ? el : find(el.props.children, component);
}
function findWhere(value: unknown, pred: (el: Element) => boolean): Element | null {
  if (Array.isArray(value)) {
    for (const v of value) { const hit = findWhere(v, pred); if (hit) return hit; }
    return null;
  }
  if (!value || typeof value !== "object" || !("props" in value)) return null;
  const el = value as Element;
  if (pred(el)) return el;
  return findWhere(el.props.children, pred);
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

// ── 笔记(mdPath-only 条目)预览必须走 Markdown 渲染,不能当普通文本 ──
//
// 单击一条笔记 → `previewLibraryItem` → 右栏 `PreviewPanel` → 这里,`which` 省略(看本体)。
// 笔记的**本体就是它的 markdown**(没有 pdfPath / filePath)。若 `viewing` 的"本体"那一支
// 不带上 `item.mdPath`,`ext` 会退化成空串,一份 markdown 就被塞进 `<pre>`(用户看到
// 满屏 `#` 与 `*` 的源码)。撤掉这条修复 → 树里出现 `<pre>` → 必红。
function hasPre(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasPre);
  if (!value || typeof value !== "object" || !("props" in value)) return false;
  const el = value as Element;
  return el.type === "pre" || hasPre(el.props.children);
}
function hasText(value: unknown, needle: string): boolean {
  if (typeof value === "string") return value === needle;
  if (Array.isArray(value)) return value.some((v) => hasText(v, needle));
  if (!value || typeof value !== "object" || !("props" in value)) return false;
  const el = value as Element;
  return hasText(el.props.children, needle);
}
const note = { id: "li_note_xyz", title: "My Note", mdPath: "notes/li_note_xyz.md" } as LibraryItem;
const noteText = { type: "text", text: "# 标题\n\n正文 **加粗**" } as LibraryFileContent;
setRenderStates(null, noteText, null, false, undefined, null, null);
const noteTree = FilePreview({ item: note });
assert.ok(!hasPre(noteTree),
  "a note's markdown must render as markdown, not raw source in a <pre>");
console.log("PASS M35 note preview renders markdown (not raw <pre>)");

// ── 空文本文件必须说「是空的」,不能只是一片空白 ──
//
// `FileViewer`(中间栏的孪生)早就守着这一条:"一张白板子和坏了在界面上长得一模一样"。
// 右栏 `FilePreview` 没守 —— 一个 0 字节 / 只有空白的 txt/json 渲染成空 `<pre>`,
// 用户分不清是文件空还是预览坏了。撤掉这条修复 → 树里是空 `<pre>`、没有那句话 → 必红。
const emptyItem = { id: "doc-1", title: "empty", filePath: "C:/docs/empty.txt" } as LibraryItem;
const emptyContent = { type: "text", text: "   \n  " } as LibraryFileContent;
setRenderStates(null, emptyContent, null, false, "C:/docs/empty.txt", null, null);
const emptyTree = FilePreview({ item: emptyItem });
assert.ok(!hasPre(emptyTree), "an empty text file must not render as a blank <pre> (reads as broken)");
assert.ok(hasText(emptyTree, "templates.preview.emptyFile"), "an empty text file must say it is empty");
console.log("PASS M35 empty text file is stated, not a blank pane");

// ── 目录里那颗「返回上级」必须真的只退一级,不能一路弹回根 ──
//
// 这个标签是共享的 `library.file.back`(「返回上级 / Up one level」)。孪生 `FileViewer`
// 就是退一级(`relPath.slice(0, lastIndexOf("/"))`)。右栏 `FilePreview` 从前点它把
// relPath 整个清成 null —— 翻到 `a/b` 里再点「返回上级」会直接跳回条目根,越过了 `a`。
// 撤掉修复 → setRelPath 收到 null → 必红。
const dirItem = { id: "dir-2", title: "Folder", filePath: "C:/papers/folder" } as LibraryItem;
const dirContent = { type: "dir", files: [{ name: "a", isDir: true }] } as LibraryFileContent;
setRenderStates("a/b", dirContent, null, false, "C:/papers/folder", null, null);
setterCalls.length = 0;
const dirTree = FilePreview({ item: dirItem });
const back = findWhere(dirTree, (el) => el.type === "button" && hasText(el.props.children, "library.file.back"));
assert.ok(back, "nested directory shows the up-one-level button");
(back!.props.onClick as () => void)();
assert.deepEqual(setterCalls, ["a"], "「返回上级」must ascend exactly one level, not reset to the root");
console.log("PASS M35 directory back button ascends one level (matches FileViewer)");
