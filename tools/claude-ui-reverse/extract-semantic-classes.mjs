/**
 * 抽「命名的样式类」—— 这些不是 Tailwind 通用类，是 Claude 自己定义的语义类。
 *
 * 为什么要单独抽：`shadow-composer` / `rounded-card` / `bg-surface-3` 这类
 * 在 JS 里当字符串用，但它们的**真实值**只在 CSS 里。直接读 JS 只能看到名字。
 *
 * 覆盖：shadow-* / bg-* / rounded-* / text-* / border-* / fill-*
 * 只收「这条规则里出现的属性不含 var(--tw-*) 之外的语义值」的，即真正定义值的。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { evalLength, deref } from "./resolve-class.mjs";

const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "../..");
const R = (p) => resolvePath(REPO_ROOT, p);
const CSS = readFileSync(R(".tmp/rev/main.css"), "utf8");

/** 语义类名的前缀。 */
const PREFIXES = [
  "shadow-", "bg-", "rounded-", "text-", "border-", "fill-", "ring-",
  "font-", "leading-", "tracking-", "size-", "w-", "h-", "max-w-", "min-w-",
  "max-h-", "min-h-", "p-", "px-", "py-", "pt-", "pb-", "ps-", "pe-",
  "m-", "mx-", "my-", "mt-", "mb-", "ms-", "me-", "gap-",
];

/** 这些前缀后面跟 `-` 再跟「任意值」的是 Tailwind 生成的原子类，跳过（量太大）。 */
const isAtomic = (cls) => /^-?\[|\\\[|^-?[a-z]+-\d+$|^-?[a-z]+-\[/.test(cls);

/** 扫所有 `.xxx{…}` 规则。 */
function rules() {
  const out = [];
  const re = /\.((?:\\.|[^\s{,:>+~[\]()])+)\{/g;
  let m;
  while ((m = re.exec(CSS)) !== null) {
    let depth = 0, j = m.index + m[0].length - 1;
    for (; j < CSS.length; j++) {
      if (CSS[j] === "{") depth++;
      else if (CSS[j] === "}") { depth--; if (depth === 0) break; }
    }
    out.push({
      cls: m[1].replace(/\\(.)/g, "$1"),
      body: CSS.slice(m.index + m[0].length, j),
    });
  }
  return out;
}

/** 从 rule body 里挑出「真正定义值」的属性。 */
function meaningful(body) {
  const keep = [];
  for (const part of body.split(";")) {
    const mm = part.match(/^\s*([\w-]+)\s*:\s*(.+?)\s*$/);
    if (!mm) continue;
    const [, prop, raw] = mm;
    if (prop.startsWith("--tw-")) {
      // 只在 --tw-shadow 里存真值，其余 --tw-* 是中间变量
      if (prop === "--tw-shadow") keep.push([prop, raw]);
      continue;
    }
    if (/^(box-shadow|background-color|color|border-radius|border-color|font-size|line-height|gap|padding|margin|width|height|max-width|min-width|max-height|min-height|outline|ring)/.test(prop)) {
      keep.push([prop, raw]);
    }
  }
  return keep;
}

const all = rules();
const table = new Map();

for (const { cls, body } of all) {
  if (!PREFIXES.some((p) => cls.startsWith(p))) continue;
  if (isAtomic(cls)) continue;
  if (cls.length > 60) continue;
  const k = meaningful(body);
  if (!k.length) continue;
  if (!table.has(cls)) table.set(cls, k);
}

/* ── 输出 ── */
let out = `Claude 3.6556.2.0 —— 语义样式类（不是 Tailwind 原子类）

这些是 Claude 自己定义的类名（\`shadow-composer\` / \`rounded-card\` / \`bg-surface-3\` …）。
JS 里只出现名字，**真实值在这里**。var() 已解引用。

`;

const groups = new Map([
  ["阴影 shadow-*", (c) => c.startsWith("shadow-")],
  ["圆角 rounded-*", (c) => c.startsWith("rounded-")],
  ["底色 bg-*", (c) => c.startsWith("bg-")],
  ["文字 text-*", (c) => c.startsWith("text-")],
  ["边框 border-*", (c) => c.startsWith("border-")],
  ["环 ring-*", (c) => c.startsWith("ring-")],
  ["字体 font-*", (c) => c.startsWith("font-")],
  ["其他", () => true],
]);

for (const [name, test] of groups) {
  const rows = [...table].filter(([cls]) => test(cls)).sort(([a], [b]) => a.localeCompare(b));
  if (!rows.length) continue;
  out += `\n${"=".repeat(78)}\n${name}  (${rows.length})\n${"=".repeat(78)}\n`;
  for (const [cls, decls] of rows.slice(0, 120)) {
    const parts = decls.map(([p, v]) => {
      const { raw, px } = evalLength(v);
      const shown = px != null ? `${px.toFixed(2)}px` : raw;
      return `${p === "--tw-shadow" ? "shadow" : p}: ${shown}`;
    });
    out += `  .${cls}\n      ${parts.join(";\n      ")}\n`;
  }
}

writeFileSync(R(".tmp/rev/semantic-classes.txt"), out);
console.log(out.slice(0, 9000));
console.log(`\n…完整：.tmp/rev/semantic-classes.txt（${table.size} 个类）`);
