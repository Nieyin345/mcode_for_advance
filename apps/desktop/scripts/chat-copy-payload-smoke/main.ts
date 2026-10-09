/**
 * chat-copy-payload-smoke — 消息气泡「复制」得到的文本必须**逐字等于**真正发给模型的那份。
 *
 * ## 盯的是什么
 *
 * 同一段提示词（用户打的字 + 各种附件块）在仓库里被**拼两遍**，服务于两件事：
 *
 *  - `composePromptWithTags`（`lib/contentTag.ts`）—— **真正发给模型的那份**；
 *  - `blocksToText`（`components/chat/MessageRow.tsx`）—— 消息气泡「复制」按钮重建的那份。
 *
 * 两份必须**逐字一致**，否则用户复制出来的东西 ≠ 实际发出去的东西。它们已经漂过两次：
 *
 *  1. **粘贴块的全局序号**（2026-10-09 修过一次）：composer 那支带
 *     `--- pasted content N (...) ---`，气泡那支漏了序号。那次修正只堵了 `paste` 这一支。
 *  2. **file / quote 两种附件**：composer 把 file/library 发成**一行 `@path`**、引用
 *     （quote）**原样发出**（content 自带「user's quote(…)+ source」抬头，见
 *     `makeQuoteTag`）；而气泡那支把**每一个**附件都塞进 `pasteBlock` —— 于是一份被
 *     引用的文件复制出来变成 "--- pasted content N (...) ---\n@路径\n--- end ---"，
 *     与真正发出的一行 `@路径` 对不上。这是本套要钉住的漂移。
 *
 * ## 判据
 *
 * 立在**两份实现的字节相等**上：同一批 tag 走 `composePromptWithTags("", tags)`
 * 与走 `blocksToText(对应 attachment 块)` 必须得到**同一串**。撤掉修复（`file` /
 * `quote` 两支回退成 `pasteBlock`）时，"逐字相等"那几条转红。
 *
 * ## 它怎么跑
 *
 * esbuild 打包真 `MessageRow.tsx` + 真 `contentTag.ts`；`@renderer/lib/monacoSetup.js`
 * 换空壳；prelude 提供 `window`/`document`（sessionStore→api.ts 求值要用）。不起浏览器、
 * 不写盘。
 *
 * Run: scripts/chat-copy-payload-smoke/run.sh
 */
import "../../scripts/renderer-pure-smoke/prelude.js";
import { blocksToText } from "@renderer/components/chat/MessageRow.js";
import {
  composePromptWithTags,
  makeContentTag,
  makeFileTag,
  makeQuoteTag,
  pasteBlock,
  type ContentTag,
} from "@renderer/lib/contentTag.js";
import type { Block } from "@renderer/stores/sessionStore.js";

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

/** tag → 它在已发送消息里对应的 attachment 块（与 ChatPane.composeSendAttachments
 *  同一条映射：file/library → "file"，quote → "quote"，其余 → "paste"）。 */
function blockOf(tag: ContentTag): Block {
  return {
    kind: "attachment",
    preview: tag.preview,
    content: tag.content,
    attachmentKind:
      tag.kind === "file" || tag.kind === "library"
        ? "file"
        : tag.kind === "quote"
          ? "quote"
          : "paste",
    filePath: tag.filePath,
  };
}

// 三种附件各来一个，另加第二个粘贴块（序号才显形）。
const fileTag = makeFileTag("D:/proj/src/index.ts");
const paste1 = makeContentTag("第一段被粘贴的正文");
const quoteTag = makeQuoteTag({
  text: "这段是我从别处摘来的",
  origin: { kind: "file", filePath: "D:/proj/notes.md", name: "notes.md", lines: { start: 3, end: 5 } },
});
const paste2 = makeContentTag("第二段被粘贴的正文");

const tags: ContentTag[] = [fileTag, paste1, quoteTag, paste2];
const blocks: Block[] = tags.map(blockOf);

// ── 1. 复制文本 == 发送文本（本套的核心判据）──────────────────────────
{
  // composer 把 tag 块拼在 typed text 之后；这里没有 typed text，所以整串就是 tag 块。
  const sent = composePromptWithTags("", tags);
  const copied = blocksToText(blocks);
  check("★ 「复制」得到的文本逐字等于「发给模型」的那份", copied === sent, { copied, sent });
}

// ── 2. 每一支各钉一条（红了能一眼看出是哪一支漂了）────────────────────
{
  const copiedFile = blocksToText([blockOf(fileTag)]);
  check("★ file 附件复制成原样的 @路径（不包分隔块）", copiedFile === fileTag.content, copiedFile);
  check("…且不是 pasteBlock 包出来的", copiedFile !== pasteBlock(1, fileTag.content), copiedFile);

  const copiedQuote = blocksToText([blockOf(quoteTag)]);
  check("★ quote 附件复制成原样的引用块（自带抬头，不再包一层）", copiedQuote === quoteTag.content, copiedQuote);
  check("…且不是 pasteBlock 包出来的", copiedQuote !== pasteBlock(1, quoteTag.content), copiedQuote);

  const copiedPaste = blocksToText([blockOf(paste1)]);
  check("★ paste 附件仍走带序号的分隔块 pasteBlock(1, …)", copiedPaste === pasteBlock(1, paste1.content), copiedPaste);
}

// ── 3. 序号只数 paste，file / quote 不占号（否则两个粘贴块的序号会错位）──
{
  // tags 顺序是 [file, paste, quote, paste] → 粘贴块应是第 1、2 个。
  const copied = blocksToText(blocks);
  check("★ 第一个粘贴块序号为 1（file 不占号）", copied.includes(pasteBlock(1, paste1.content)), copied);
  check("★ 第二个粘贴块序号为 2（quote 不占号）", copied.includes(pasteBlock(2, paste2.content)), copied);
  check("…不存在把 file 包成 pasteBlock 的痕迹", !copied.includes("pasted content 1 (") || copied.includes(pasteBlock(1, paste1.content)), copied);
}

// ── 4. text / thinking 两支不受影响（回归护栏）──────────────────────────
{
  const textOnly = blocksToText([
    { kind: "text", text: "用户打的字" } as Block,
    { kind: "thinking", text: "  我在想  " } as Block,
  ]);
  check("text → 原样；thinking → 引用行", textOnly === "用户打的字\n\n> 我在想", textOnly);
}

console.log(`\nchat-copy-payload-smoke:${checks - failures}/${checks} 通过`);
if (failures > 0) process.exitCode = 1;
