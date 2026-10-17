/**
 * md-preview-read-error-smoke — 【ARC-007】Markdown 只读预览的**读取失败**必须说出来，
 * 不能画成一篇空文档。
 *
 * ## 判据从哪来
 *
 * `FileEditor.tsx` 的 `MarkdownPreviewPane` 从前在 `catch` 里 `setContent("")`
 * （源码注释原话 "degrade to empty"）—— IO 失败与"主进程真的回了空串"在屏幕上
 * 长得一模一样。台账 ARC-007 把它记为待证项：入口可达性未核实。现已核实：md 文件
 * 的默认视图是 wysiwyg，但用户显式切到「预览」后 `effectiveMode` 会走这一支
 * （`viewMode === "preview" ? markdown ? "wysiwyg" : "preview"` —— 只在**旧偏好**
 * 被兼容成 wysiwyg；显式点预览时仍进这里），所以这条路径是用户可达的。
 *
 * ## 它怎么跑
 *
 * 真 `MarkdownPreviewPane`（已导出）挂进极小 React 运行时；`api.file.readFile` 换成
 * 可编程替身。断言立在**用户看到的那几行字**上：
 *   - 读失败 → 出现 `ide.editor.readFailed` 与原始错误、以及重试按钮；
 *   - 点重试且这次成功 → 内容出现，错误消失（重试真的重新读）；
 *   - 读成功且内容非空 → 不出现错误（正控，防空过）；
 *   - 读成功但内容为空 → 显示空文档（**不**误报错误）。
 *
 * Run: scripts/md-preview-read-error-smoke/run.sh
 */
import "./prelude.js";
import { __mount, __nodes, __text, __flush } from "./fakeReact.js";
import { __setRead, readCalls } from "./api-stub.js";
import { MarkdownPreviewPane } from "@renderer/components/ide/FileEditor.js";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

type El = { type: unknown; props: Record<string, unknown> };
const FILE = "/workspace/readme.md";

function mount(): void {
  __mount(() => MarkdownPreviewPane({ filePath: FILE, projectPath: "/workspace" }));
}
function buttons(): El[] {
  return (__nodes() as El[]).filter((n) => n.type === "button");
}
function text(): string {
  return __text();
}
/** 预览正文走 `ChunkedMarkdown` 的 `text` prop（子组件在极小运行时里不被调用，
 *  所以正文不会出现在 `__text()` 里）—— 判据取它，与组件的实际合同一致。 */
function previewBody(): string | null {
  const node = (__nodes() as El[]).find(
    (n) => typeof n.type === "function" && (n.type as { name?: string }).name === "ChunkedMarkdown",
  );
  return node === undefined ? null : String(node.props.text ?? "");
}

// ── 1. 读失败：显式错误 + 原文 + 重试 ─────────────────────────────────────
__setRead({ kind: "error", message: "EACCES: permission denied, open '/workspace/readme.md'" });
readCalls.length = 0;
mount();
await __flush();
const failed = text();
check("★ 读失败时面板出现「读取文件失败」", failed.includes("读取文件失败"), failed);
check("★ 读失败时显示原始原因", failed.includes("EACCES") && failed.includes("permission denied"), failed);
check("★ 读失败时给出重试按钮", buttons().some((b) => String(b.props.children).includes("重试")), buttons().map((b) => b.props.children));
check("读失败时**不**显示成空文档（没有「读取文件…」的残留加载态）", !failed.includes("读取文件…"), failed);
check("读失败时确实调用了一次 readFile", readCalls.length === 1, readCalls);

// ── 2. 点重试：这次成功 → 内容出现、错误消失 ────────────────────────────
__setRead({ kind: "ok", content: "hello from disk\n" });
const retry = buttons().find((b) => String(b.props.children).includes("重试"));
check("前提：失败态里找得到重试按钮", Boolean(retry));
if (retry) {
  const onClick = retry.props.onClick as (() => void) | undefined;
  check("重试按钮带 onClick", typeof onClick === "function");
  onClick?.();
  await __flush();
}
const recovered = text();
check("★ 重试成功后正文传给预览", (previewBody() ?? "").includes("hello from disk"), previewBody());
check("★ 重试成功后错误提示消失", !recovered.includes("读取文件失败"), recovered);
check("重试确实重新读了一次", readCalls.length === 2, readCalls);

// ── 3. 正控：一次成功、非空 → 不出现错误 ─────────────────────────────────
__setRead({ kind: "ok", content: "clean read\n" });
readCalls.length = 0;
mount();
await __flush();
const healthy = text();
check("★ 正常读取时不出现错误提示（防空过）", !healthy.includes("读取文件失败"), healthy);
check("正常读取时正文传给预览", (previewBody() ?? "").includes("clean read"), previewBody());

// ── 4. 真正空文件：不误报错误 ────────────────────────────────────────────
__setRead({ kind: "ok", content: "" });
mount();
await __flush();
const empty = text();
check("★ 主进程回空串 → 不误报「读取文件失败」", !empty.includes("读取文件失败"), empty);
check("空文件不出现错误原文", !empty.includes("EACCES"), empty);
check("空文件仍把空正文交给预览（真的空文档）", previewBody() === "", previewBody());

console.log(`\nmd-preview-read-error-smoke: ${total - failures}/${total} 通过`);
if (failures > 0) process.exit(1);
