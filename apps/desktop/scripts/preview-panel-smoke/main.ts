/**
 * preview-panel-smoke — 右栏预览顶栏那个按钮的**文字与它做的事对不上**。
 *
 * ## 盯的是什么
 *
 * `PreviewPanel` 顶栏的按钮只在**正在看转录**时画（`which === "md"`）。它的动作是
 * **切回 PDF 本体**（`openPreview(item.id)`，注释逐字写着「点它切回 PDF 本体」），
 * 它的 `title` 也是“回到 PDF 原件”（`library.ctx.offerMd`）—— 而它当时印出来的
 * **可见文字**却是 `library.ctx.viewTranscript`（“查看转录文本”）。
 *
 * 用户此刻**已经在看转录**，按钮却说“查看转录文本”；点下去那一刻它又切成 PDF ——
 * 文字和动作正好是反的。这是把右键菜单里**另一个方向**那一项的标签（“看转录”）
 * 错贴到了“回 PDF”的按钮上。
 *
 * ## 判据
 *
 * 装载真正的 `PreviewPanel`，把活动条目置成一篇「正在看转录」，从树里取那个按钮：
 *
 *   ① 它的可见文字必须是 `library.ctx.offerMd`（“回到 PDF 原件”）——
 *      写死 `viewTranscript` 时这条**必红**；
 *   ② 它的 `title` 同样必须是 `library.ctx.offerMd`（现状本来就对，防回归）；
 *   ③ 点它 → `openPreview(item.id)`（无 which，即回本体）恰好一次（正控：
 *      证明这个按钮确实是“回本体”，文字理应描述这件事）。
 *
 * ## 它怎么跑
 *
 * esbuild `--alias:react=` 换成极小 hooks 运行时（组件源码原样跑）；`FilePreview`、
 * `libraryStore`、`i18n`、图标全部换桩。不起浏览器、不写盘。
 *
 * Run: scripts/preview-panel-smoke/run.sh
 */
import "./prelude.js";
import { __mount, __nodes } from "./fakeReact.js";
import { __setState, __openPreviewCalls, __resetCalls } from "./libraryStoreStub.js";
import type { LibraryItem } from "@contracts/library";
import { PreviewPanel } from "@renderer/components/library/PreviewPanel.js";

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  checks++;
  if (cond) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures++;
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

type El = { type: unknown; props: Record<string, unknown> };

const item = { id: "item-1", title: "一篇论文", entryMode: "attached" } as LibraryItem;

/** 树里那个「切回 PDF 本体」的顶栏按钮：按 title 认（它就是 offerMd）。 */
function offerButton(): El | null {
  return (
    (__nodes().find(
      (n) => n.type === "button" && n.props.title === "library.ctx.offerMd",
    ) as El | undefined) ?? null
  );
}

function mountWith(which: "pdf" | "md" | null): void {
  __setState({
    activeItemId: item.id,
    previewWhich: which,
    itemsByCollection: {},
    allItems: [item],
  });
  __resetCalls();
  __mount(() => PreviewPanel());
}

// ── 正在看转录:按钮该说的是“回 PDF 原件” ──
mountWith("md");
const btn = offerButton();
check("看转录时画出“回 PDF”按钮", btn !== null, __nodes().map((n) => n.type));

if (btn) {
  // ① 可见文字 —— 修复的核心断言（撤掉修复后必红）。
  check(
    "★ 按钮文字是“回到 PDF 原件”(library.ctx.offerMd)",
    btn.props.children === "library.ctx.offerMd",
    btn.props.children,
  );
  // ② title 与动作同向（现状本来就对，防被人一起改反）。
  check("按钮 title 也是 library.ctx.offerMd", btn.props.title === "library.ctx.offerMd", btn.props.title);
  // ③ 正控：点它确实是回本体（给 openPreview 不带 which）。
  (btn.props.onClick as () => void)();
  const calls = __openPreviewCalls();
  check(
    "点它调 openPreview(item.id) 恰好一次、且不带 which(回本体)",
    calls.length === 1 && calls[0].id === item.id && calls[0].which === undefined,
    calls,
  );
}

// ── 看本体时：那颗按钮不该出现 ──
mountWith(null);
check("看本体时不画那颗按钮", offerButton() === null, __nodes().map((n) => n.type));

console.log(`\npreview-panel-smoke:${checks - failures}/${checks} 通过`);
if (failures > 0) process.exitCode = 1;
