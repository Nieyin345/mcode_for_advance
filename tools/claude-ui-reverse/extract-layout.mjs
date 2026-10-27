/**
 * 从 Claude 3.6556.2.0 的主 CSS 里抽「布局事实」：
 * 侧栏宽度、标题栏高度、消息区、输入框、右面板 —— 全部按**组件选择器**归类。
 *
 * 不做推断：每条都打印「原始规则」，让值可肉眼核。
 *//**
 * 路径全部相对**仓库根**解析，不依赖调用者的 cwd。
 *
 * ⚠️ 这是踩过的坑：脚本原本用相对路径 `R(".tmp/rev/main.css")`，
 * 从别处调用时就变成「找 <那里>/.tmp/rev/main.css」——
 * 和 CLAUDE.md 里 `run.sh` 在 `cd` 之后还用 `dirname "$0"` 是同一类错误。
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "../..");
const R = (p) => resolvePath(REPO_ROOT, p);

import { readFileSync, writeFileSync } from "node:fs";

const css = readFileSync(R(".tmp/rev/main.css"), "utf8");

/** 把一段 CSS 切成 `sel{body}`。 */
function rules(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const lb = src.indexOf("{", i);
    if (lb < 0) break;
    const sel = src.slice(i, lb).trim();
    let depth = 0, j = lb;
    for (; j < src.length; j++) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}") { depth--; if (depth === 0) break; }
    }
    out.push({ sel, body: src.slice(lb + 1, j) });
    i = j + 1;
  }
  return out;
}

const all = rules(css);

/** 找出「选择器里含某个 data-cds 组件名」的全部规则，打印它们的布局属性。 */
function layoutOf(component, filter = /^(width|min-width|max-width|height|min-height|max-height|padding|padding-inline|padding-block|padding-left|padding-right|padding-top|padding-bottom|margin|margin-inline|margin-block|gap|row-gap|column-gap|border-radius|display|flex|flex-direction|align-items|justify-content|grid-template|inset|top|left|right|bottom|position)$/) {
  const hits = [];
  for (const { sel, body } of all) {
    if (!sel.includes(`data-cds=${component}`) && !sel.includes(`data-cds="${component}"`)) continue;
    // 只取直接命中（选择器最后一段是组件本身，或整个选择器很短）
    const decls = [];
    for (const part of body.split(";")) {
      const m = part.match(/^\s*([\w-]+)\s*:\s*(.+?)\s*$/);
      if (!m) continue;
      if (filter.test(m[1])) decls.push(`${m[1]}: ${m[2]}`);
    }
    if (decls.length) hits.push({ sel: sel.slice(0, 260), decls });
  }
  return hits;
}

function dump(title, component) {
  const hits = layoutOf(component);
  console.log(`\n${"=".repeat(70)}\n${title}  [data-cds=${component}]  ${hits.length} 条规则\n${"=".repeat(70)}`);
  for (const h of hits.slice(0, 40)) {
    console.log(`  ${h.sel}`);
    console.log(`      ${h.decls.join("; ")}`);
  }
}

dump("侧栏 / 页面", "Page");
dump("面板", "Panel");
dump("输入框外壳", "ChatComposerDock");
dump("输入框编辑器", "ChatComposerEditor");
dump("输入框下巴", "ChatComposerChin");
dump("输入框按钮区", "ChatComposerActions");
dump("助手消息", "AssistantMessage");
dump("用户消息", "UserMessage");
dump("消息操作", "MessageActions");
dump("回合状态", "TurnStatus");
dump("工具条", "Toolbar");

// ── 另外：全 CSS 里出现最多的宽度/高度字面量，帮助识别侧栏宽度 ──
const widthCount = new Map();
for (const { body } of all) {
  for (const part of body.split(";")) {
    const m = part.match(/^\s*(width|min-width|max-width)\s*:\s*([\d.]+px)\s*$/);
    if (m) widthCount.set(m[2], (widthCount.get(m[2]) ?? 0) + 1);
  }
}
console.log("\n" + "=".repeat(70));
console.log("最常见的 width 字面量（top 20）");
console.log("=".repeat(70));
for (const [v, n] of [...widthCount].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  console.log(`  ${v.padEnd(12)} ×${n}`);
}

// ── 侧栏专属：搜 288 / 17rem / 18rem 之类 ──
console.log("\n" + "=".repeat(70));
console.log("侧栏候选宽度（含 288 / 17.x rem 的规则）");
console.log("=".repeat(70));
for (const { sel, body } of all) {
  if (/\b(288px|18rem|17\.5rem|17rem)\b/.test(body) && /width/.test(body)) {
    console.log(`  ${sel.slice(0, 200)}`);
    console.log(`      ${body.slice(0, 220)}`);
  }
}
