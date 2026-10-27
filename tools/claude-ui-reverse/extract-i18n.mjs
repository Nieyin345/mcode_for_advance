/**
 * 从 en-US.json 里抽出 UI 文案。
 *
 * 这是「界面实际说什么」的唯一可信来源 —— 比从 minified JS 里猜字符串可靠得多。
 * 只挑与**布局骨架**相关的键：侧栏、标题栏、消息、输入框。
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

const j = JSON.parse(readFileSync(R(".tmp/rev/en-US.json"), "utf8"));

console.error(`总键数 ${Object.keys(j).length}`);

/**
 * ⚠️ 键是**混淆 id**（`+/cwsayrqk`），不是语义名 —— 上一版按键名匹配，全部 0 命中。
 * 所以必须按**值**（也就是界面上真正显示的文字）来归类。
 */
const GROUPS = [
  ["侧栏 / 导航", /\b(sidebar|collapse|expand|hide sidebar|show sidebar|drawer|rail)\b/i],
  ["会话 / 项目", /\b(session|conversation|project|recent|pinned|starred|archive)\b/i],
  ["模式切换", /\b(cowork|code mode|switch to|workspace)\b/i],
  ["新建 / 搜索", /\b(new session|new chat|create.*session|search|find)\b/i],
  ["消息", /\b(message|reply|response|turn|assistant|regenerate|retry|copy)\b/i],
  ["输入框", /\b(send|attach|stop|queue|drop.*file|add.*file|what can i help)\b/i],
  ["标题栏", /\b(title ?bar|menu|overflow|minimi[sz]e|maximi[sz]e|close window)\b/i],
  ["面板", /\b(panel|dock|inspector|background task|artifact)\b/i],
  ["设置", /\b(setting|preference|account|sign out|log out|theme|density|text size|font size)\b/i],
];

const hits = new Map();
for (const [g] of GROUPS) hits.set(g, []);

for (const [k, v] of Object.entries(j)) {
  if (typeof v !== "string" || v.length > 160) continue;
  for (const [g, re] of GROUPS) {
    if (re.test(v)) { hits.get(g).push([k, v]); break; }
  }
}

let out = "Claude 3.6556.2.0 —— UI 文案（en-US.json）\n";
for (const [g, arr] of hits) {
  out += `\n${"=".repeat(72)}\n${g}  (${arr.length} 条)\n${"=".repeat(72)}\n`;
  for (const [k, v] of arr.sort((a, b) => a[0].localeCompare(b[0]))) {
    out += `  ${k.padEnd(46)} ${JSON.stringify(v)}\n`;
  }
}
writeFileSync(R(".tmp/rev/i18n-ui.txt"), out);
console.log(out);

/** 同时导出一份「全部键值」的平表，后续核对用。 */
writeFileSync(R(".tmp/rev/i18n-all.json"), JSON.stringify(j, null, 2));
