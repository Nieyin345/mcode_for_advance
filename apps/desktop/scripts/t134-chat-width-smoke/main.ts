/**
 * 【T134】聊天正文 672 / 输入框 768 —— 上游 `max-w-2xl` / `max-w-3xl` 的布线。
 *
 * ## 这张卡改的是**全量默认值**
 *
 * 所有现有用户的正文宽度会从 1024px 变成 672px。用户明确要求过
 * 「claude 什么样子，你就什么样子」，上游 `ChatMessageBubbles.tsx:275` 是
 * `max-w-2xl`（672）、`ChatComposer.tsx:99` 是 `max-w-3xl`（768）。
 *
 * **所以这不是一个「零变化」的布线批次** —— 它有意改变观感。这套守的不是
 * 「像素没变」，而是**两个宽度各自落在正确的值上、且互不相同**。
 *
 * ## 为什么 standard 档要改 fallback
 *
 * `buildUiPrefsCss` 只在「非 standard」时才写 CSS 变量。所以 standard 档的
 * 宽度**只能**由 `ChatPane.tsx` 里的 `var(--chat-max-w, 42rem)` fallback 提供。
 * 改了 `uiPrefs.ts` 的表却不改 fallback，standard 档会静默停在旧值 ——
 * **这是本卡最容易漏的一处**，§3 专门守它。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

let total = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  total++;
  if (!ok) failed++;
  console.log((ok ? "  ok   " : "  FAIL ") + label + (ok || detail === undefined ? "" : `  ${JSON.stringify(detail)}`));
}

const ROOT = process.cwd();
const prefs = readFileSync(join(ROOT, "src/renderer/lib/uiPrefs.ts"), "utf8");
const pane = readFileSync(join(ROOT, "src/renderer/components/chat/ChatPane.tsx"), "utf8");

/** 从 `const NAME: Record<ChatMaxWidth, string> = { ... }` 里读四个值。 */
function readTable(name: string): Record<string, string> | null {
  const re = new RegExp(`const ${name}:\\s*Record<ChatMaxWidth,\\s*string>\\s*=\\s*\\{([\\s\\S]*?)\\n\\};`);
  const m = re.exec(prefs);
  if (!m) return null;
  const body = m[1]!;
  const out: Record<string, string> = {};
  for (const k of ["narrow", "standard", "wide", "full"]) {
    const v = new RegExp(`${k}:\\s*"([^"]+)"`).exec(body);
    if (v) out[k] = v[1]!;
  }
  return out;
}

function remToPx(v: string): number | null {
  const m = /^(\d+(?:\.\d+)?)rem$/.exec(v);
  return m ? Number(m[1]) * 16 : null;
}

console.log("── 一、两张表存在且取值正确 ──");

const chat = readTable("CHAT_MAX_WIDTH_CSS");
const composer = readTable("COMPOSER_MAX_WIDTH_CSS");
check("CHAT_MAX_WIDTH_CSS 存在且四项齐全", !!chat && Object.keys(chat).length === 4, chat);
check("COMPOSER_MAX_WIDTH_CSS 存在且四项齐全", !!composer && Object.keys(composer).length === 4, composer);

if (chat && composer) {
  console.log("\n── 二、★ standard 档 = 上游值 ──");
  check("消息正文 standard = 42rem（672px = 上游 max-w-2xl）",
    remToPx(chat.standard!) === 672, { got: chat.standard, px: remToPx(chat.standard!) });
  check("输入框 standard = 48rem（768px = 上游 max-w-3xl）",
    remToPx(composer.standard!) === 768, { got: composer.standard, px: remToPx(composer.standard!) });
  check("★ 两者 standard 档**不同**（此前共用一个值，差别表达不出来）",
    chat.standard !== composer.standard, { chat: chat.standard, composer: composer.standard });

  console.log("\n── 三、★ full 档两处都必须是 none ──");
  /* 只把消息改成 none 而输入框留着 896，会出现「消息不限宽、输入框还卡着」——
   * 那是变异表第一行模拟的缺陷。 */
  check("消息正文 full = none", chat.full === "none", { got: chat.full });
  check("输入框 full = none", composer.full === "none", { got: composer.full });

  console.log("\n── 四、各自单调递增 ──");
  for (const [name, t] of [["消息正文", chat], ["输入框", composer]] as const) {
    const px = [t.narrow!, t.standard!, t.wide!].map(remToPx);
    const monotone = px.every((v) => v !== null) &&
      px[1]! > px[0]! && px[2]! > px[1]!;
    check(`${name} narrow < standard < wide（${px.join(" < ")}）`, monotone, { px });
  }
}

console.log("\n── 五、★ 分工：7 处消息 + 1 处输入框 ──");
{
  const chatVars = (pane.match(/var\(--chat-max-w/g) || []).length;
  const composerVars = (pane.match(/var\(--composer-max-w/g) || []).length;
  check(`ChatPane 用 --chat-max-w 共 7 处（实际 ${chatVars}）`, chatVars === 7, { chatVars });
  check(`ChatPane 用 --composer-max-w 共 1 处（实际 ${composerVars}）`, composerVars === 1, { composerVars });
}

console.log("\n── 六、★ standard 档的 fallback 必须同步 ──");
{
  /* `buildUiPrefsCss` 在 standard 档**不写 CSS 变量**，所以宽度只由 fallback 决定。
   * 这条守的正是「改了表忘了改 fallback」。 */
  const chatFallbacks = [...pane.matchAll(/var\(--chat-max-w,\s*([\d.]+rem)\)/g)].map((m) => m[1]!);
  const composerFallbacks = [...pane.matchAll(/var\(--composer-max-w,\s*([\d.]+rem)\)/g)].map((m) => m[1]!);

  /* ⚠️ 第一版只断言了「fallback 的值全是 42rem」，**没断言数量是 7** ——
   * 变异「:3164 改回 --chat-max-w」时它仍绿（8 处全是 42rem）。
   * 现在数量与值都钉住。 */
  check(`--chat-max-w 的 fallback 恰好 7 处且全是 42rem（实际 ${chatFallbacks.length} 处）`,
    chatFallbacks.length === 7 && chatFallbacks.every((v) => v === "42rem"),
    { count: chatFallbacks.length, found: [...new Set(chatFallbacks)] });
  check(`--composer-max-w 的 fallback 是 48rem`,
    composerFallbacks.length === 1 && composerFallbacks[0] === "48rem",
    { found: composerFallbacks });

  // 与表交叉核对：fallback 必须等于表里的 standard
  if (chat && composer) {
    check("fallback 42rem === 表里的 standard（改表不改 fallback 会静默失效）",
      chatFallbacks.every((v) => v === chat.standard), { fallback: chatFallbacks[0], table: chat.standard });
    check("composer fallback 48rem === 表里的 standard",
      composerFallbacks[0] === composer.standard, { fallback: composerFallbacks[0], table: composer.standard });
  }
}

console.log("\n── 七、buildUiPrefsCss 两个变量一起写 ──");
check("非 standard 档同时写 --chat-max-w 与 --composer-max-w",
  /--chat-max-w:.*--composer-max-w:/.test(prefs),
  { found: /rules\.push\(`[^`]*chat-max-w[^`]*`\)/.exec(prefs)?.[0]?.slice(0, 120) });

console.log(`\nt134-chat-width-smoke:${total - failed}/${total} 通过`);
process.exit(failed === 0 ? 0 : 1);
