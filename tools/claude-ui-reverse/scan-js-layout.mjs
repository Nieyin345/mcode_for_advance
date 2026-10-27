/**
 * 从 Claude 3.6556.2.0 的 JS chunk 里找「布局常量」。
 *
 * 为什么不在 CSS 里找：这份 CSS 是 Tailwind 的**原子类产物**，
 * `w-72` / `h-9` 这些语义类名在 JS 里，CSS 里已经是 `width:18rem`。
 * 所以要读「哪个元素用了什么」，必须读 JS 里的 className。
 *
 * 只读，不执行。搜索关键词：侧栏、标题栏、容器名、消息区。
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

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = "C:/Program Files/WindowsApps/Claude_3.6556.2.0_x64__pzs8sxrjxfjjc/app/resources/ion-dist/assets/v1";

/** 只挑体积大的那些（入口与主界面 chunk）；小的多半是懒加载的次要页。 */
const files = readdirSync(ROOT)
  .filter((f) => f.endsWith(".js"))
  .map((f) => ({ f, size: statSync(join(ROOT, f)).size }))
  .sort((a, b) => b.size - a.size)
  .slice(0, 60);

console.error(`扫最大的 ${files.length} 个 chunk（共 ${(files.reduce((s, x) => s + x.size, 0) / 1048576).toFixed(1)} MiB）`);

/**
 * 在文件里搜一个模式，返回 `命中处前后 N 字符`。
 * 不解析 AST —— 这是 minified 代码，AST 的成本远大于收益，
 * 而我们要的是「字面量长什么样」，不是「语义」。
 */
function grepFile(path, re, ctx = 160, limit = 40) {
  const s = readFileSync(path, "utf8");
  const out = [];
  let m;
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  while ((m = g.exec(s)) !== null && out.length < limit) {
    out.push(s.slice(Math.max(0, m.index - ctx), Math.min(s.length, m.index + m[0].length + ctx)));
  }
  return out;
}

const QUERIES = [
  ["容器命名 container-name", /containerName\s*:\s*["'][\w-]+["']|containerType\s*:/],
  ["侧栏宽度类 w-[…]/w-72", /["'`][^"'`]*\bw-(?:\[[\d.]+(?:px|rem)\]|72|64|80)\b[^"'`]*["'`]/],
  ["侧栏组件名 Sidebar", /[A-Za-z]*Sidebar[A-Za-z]*/],
  ["标题栏 Titlebar", /[A-Za-z]*Titlebar[A-Za-z]*|[A-Za-z]*TitleBar[A-Za-z]*/],
  ["输入框 Composer", /[A-Za-z]*Composer[A-Za-z]*/],
  ["data-cds 字面量", /data-cds["'\]]?\s*[:=]\s*["'][A-Za-z]+["']/],
];

console.log("Claude 3.6556.2.0 —— JS chunk 里的布局线索\n");

for (const [label, re] of QUERIES) {
  console.log(`\n${"=".repeat(72)}\n${label}\n${"=".repeat(72)}`);
  let shown = 0;
  for (const { f } of files) {
    if (shown >= 8) break;
    const hits = grepFile(join(ROOT, f), re, 130, 3);
    if (!hits.length) continue;
    console.log(`\n  ── ${f}`);
    for (const h of hits) {
      console.log(`     …${h.replace(/\s+/g, " ")}…`);
    }
    shown++;
  }
  if (!shown) console.log("  （无命中）");
}
