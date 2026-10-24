/**
 * 【T132】聊天区不得用硬抄的 em 系数代替 `--chat-fs-*` 变量。
 *
 * ## 缺陷是什么（用浏览器实测过，不是推的）
 *
 * `text-[0.8571em]` 与 `var(--chat-fs-xs)` 表面上等价（`--chat-fs-xs` 就是
 * `calc(var(--chat-font-size) * 0.8571)`），但 **`em` 相对的是父元素字号，
 * 不是 `--chat-font-size`**。
 *
 * `--chat-font-size` 由 `appearance.ts` 写在 `<html>` 上，**没有写进任何
 * 元素的 font-size**（聊天根的 `[data-chat-root]` 不设字号；只有消息气泡用
 * `[font-size:var(--chat-font-size)]`）。
 *
 * 实测（Chromium，body 取浏览器默认 16px）：
 *
 *   --chat-font-size: 14px → text-[0.8571em] = 13.71px   var(--chat-fs-xs) = 12.00px
 *   --chat-font-size: 20px → text-[0.8571em] = 13.71px   var(--chat-fs-xs) = 17.14px
 *                             ^^^^^^^^^ 纹丝不动           ^^^^^^^^^ 跟着变
 *
 * **两个结论**：
 *   1. 用户在设置里调「对话字号」，em 写法的那部分**完全不动**；
 *   2. 即便在默认 14px 下，两者也**本来就不相等**（13.71 vs 12.00）。
 *
 * ## 范围说明（这条很重要，别把判据用到不该用的地方）
 *
 * **面板（`components/settings/` 等）里的 em 是有效的** —— `SettingsPage.tsx:345/420`
 * 与 `TurnFlowPanel.tsx:234/306` 显式设了 `style={{ fontSize: "var(--right-panel-font-size)" }}`，
 * 所以那里的 `em` 相对的就是面板字号，是正确写法。
 *
 * **本套只守聊天区。** 把判据扩到全仓会误伤 300+ 处正确用法。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

let total = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  total++;
  if (!ok) failed++;
  console.log((ok ? "  ok   " : "  FAIL ") + label + (ok || detail === undefined ? "" : `  ${JSON.stringify(detail)}`));
}

const ROOT = process.cwd();
const CHAT = resolve(ROOT, "src/renderer/components/chat");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : n.endsWith(".tsx") ? [p] : [];
  });
}

/* 三档「有直接对应变量」的 em 系数。其余系数（0.7143 / 0.6428 / 0.9 / 0.85 …）
 * 在 `--chat-fs-*` 里没有对应项，**不在这套的判据里** —— 它们需要单独判断
 * （0.7143em = 10px、0.6428em = 9px，都小于 xxs 的 11px）。 */
const MAPPED: Record<string, string> = {
  "0.7857em": "--chat-fs-xxs",
  "0.8571em": "--chat-fs-xs",
  "0.9286em": "--chat-fs-sm",
};

console.log("── 一、聊天区不再有硬抄 em ──");

const chatFiles = walk(CHAT);
const offenders: string[] = [];
for (const f of chatFiles) {
  const src = readFileSync(f, "utf8");
  for (const em of Object.keys(MAPPED)) {
    const n = src.split(`text-[${em}]`).length - 1;
    if (n > 0) offenders.push(`${relative(ROOT, f).split("\\").join("/")}: ${em} × ${n}`);
  }
}
check(`聊天区 0 处硬抄 em（扫了 ${chatFiles.length} 个 tsx）`, offenders.length === 0, offenders);

console.log("\n── 二、改成了变量写法（不是删掉了事） ──");

/* ⚠️ 这一节第一版是坏的：只断言「三个变量在聊天区都被用过」。
 *
 * 变异「删掉一处 [font-size:var(--chat-fs-xxs)]」时它**全绿** —— 因为别处还有
 * 14 处在用它。**判据分不清「换成了变量」和「删掉了声明」。**
 *
 * 所以改成**计数守恒**：迁移前这三档的 em 是 293/88/11 处（合计 392，聊天区占 7），
 * 迁移后聊天区的 `var(--chat-fs-*)` **相关声明数只增不减**。
 * 这里用「至少 N 处」而不是精确值，因为后续按区域迁移会继续增加 —— 但**下限**
 * 保证没有把声明删光。
 *
 * 分母：聊天区迁移前有 7 处 em（1×xxs + 2×xs + 4×xxs —— 见 T132 回写）。
 * 下限取 7，因为那 7 处必须全部落成变量声明。 */
const allChat = chatFiles.map((f) => readFileSync(f, "utf8")).join("\n");
let declCount = 0;
for (const v of ["--chat-fs-xxs", "--chat-fs-xs", "--chat-fs-sm"]) {
  const n = allChat.split(`[font-size:var(${v})]`).length - 1;
  declCount += n;
  check(`聊天区使用 [font-size:var(${v})]（${n} 处）`, n > 0, { n });
}
check(`★ 声明总数 ≥ 7（迁移的 7 处没有变成「删掉」）`, declCount >= 7, { declCount });

/* ⚠️ 上面那条「总数 ≥ 7」**抓不到「删掉其中一处」**：总数 53，删一处还有 52。
 *
 * 这条钉的是**逐文件的下限** —— T132 迁移过的那 4 个文件，每个都必须**仍然**
 * 有它的字号声明。变异「删掉 SearchFilterBar 里那处 var(--chat-fs-xxs)」会红，
 * 因为那个文件的计数会从 3 掉到 2。
 *
 * 这是「按出口数守」而不是「按总量守」——总量守恒允许内部搬移。 */
const MIGRATED_FILES: Record<string, number> = {
  "ChunkedMarkdown.tsx": 1,
  "EmptyThreadWelcome.tsx": 2,
  "SearchFilterBar.tsx": 3,
  "WorkflowBoardPanel.tsx": 1,
};
for (const [name, min] of Object.entries(MIGRATED_FILES)) {
  const src = readFileSync(join(CHAT, name), "utf8");
  let n = 0;
  for (const v of ["--chat-fs-xxs", "--chat-fs-xs", "--chat-fs-sm"]) {
    n += src.split(`[font-size:var(${v})]`).length - 1;
  }
  check(`★ ${name} 仍有 ${min} 处字号声明（逐文件下限，不是总量）`, n >= min, { n, min });
}

console.log("\n── 三、变量定义仍然存在（防止上游把档位改名） ──");

const css = readFileSync(resolve(ROOT, "src/renderer/styles.css"), "utf8");
for (const [em, v] of Object.entries(MAPPED)) {
  check(`${v} 在 styles.css 里定义`, new RegExp(`--${v.replace("--", "")}:\\s*calc\\(var\\(--chat-font-size\\)`).test(css), { v });
}

console.log("\n── 四、★ 负控：面板里的 em 不该被同一条判据误伤 ──");

/* 面板显式设了 fontSize，所以那里的 em 是正确的。这条断言守的是
 * 「有人把判据扩到全仓」这件事 —— 如果扩了，settings 那 301 处会被改成
 * var(--chat-fs-*)，那里会**跟着对话字号变而不是面板字号变**，是新的缺陷。 */
const settingsPage = readFileSync(resolve(ROOT, "src/renderer/components/settings/SettingsPage.tsx"), "utf8");
check("负控：SettingsPage 仍然显式设 style fontSize=var(--right-panel-font-size)",
  /fontSize:\s*"var\(--right-panel-font-size\)"/.test(settingsPage),
  { found: settingsPage.match(/fontSize:[^,}]*/g) });

/* 面板里的 em 应该还在（我们**没有**去改它们）—— 如果这里变成 0，
 * 说明有人把判据扩到了 settings，那会破坏面板字号。 */
function countEm(dir: string): number {
  let n = 0;
  for (const f of walk(dir)) {
    const s = readFileSync(f, "utf8");
    for (const em of Object.keys(MAPPED)) n += s.split(`text-[${em}]`).length - 1;
  }
  return n;
}
const settingsEm = countEm(resolve(ROOT, "src/renderer/components/settings"));
check(`负控：settings 里的 em 仍然保留（${settingsEm} 处，没被误改）`, settingsEm > 200, { settingsEm });

console.log(`\nt132-chat-em-smoke:${total - failed}/${total} 通过`);
process.exit(failed === 0 ? 0 : 1);

function resolve(root: string, p: string): string {
  return join(root, p);
}
