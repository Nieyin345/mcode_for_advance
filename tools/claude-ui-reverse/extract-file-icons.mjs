/**
 * 抽文件类型图标（Phosphor Icons）。
 *
 * ## 为什么这个能成，别的图标不能
 *
 * Claude 的 UI 图标是**编译期组件**（`y(Re,{name:"ArrowReturn"})`），
 * 名字→path 的表在 minify 后与名字分离，静态拼不回来。
 *
 * 但**文件类型图标**（PDF / DOC / ZIP / CSV …）走的是另一条路：
 * `vendor-icons-BplZ6UOJ.js` 里是**完整的 Phosphor React 源码**，
 * 每个图标一个组件，`d` 就在组件体内，`displayName` 也在。
 *
 * 所以这个文件能**完整抽出来**，而 UI 图标不能。
 *
 * ## Phosphor 的识别依据（都已验证）
 *
 *   - `viewBox:"0 0 256 256"`（Phosphor 特有）
 *   - `IconBase` + `weights` Map（regular / bold / fill / duotone …）
 *   - 每个组件有 `displayName:"XxxIcon"`
 *   - 默认 `weight:"regular"`, `size:"1em"`, `color:"currentColor"`
 *
 * Phosphor Icons 是 **MIT 许可**，可以自由使用。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "../..");
const R = (p) => resolvePath(REPO_ROOT, p);
const ASSETS =
  "C:/Program Files/WindowsApps/Claude_3.6556.2.0_x64__pzs8sxrjxfjjc/app/resources/ion-dist/assets/v1";

const src = readFileSync(`${ASSETS}/vendor-icons-BplZ6UOJ.js`, "utf8");

/**
 * 每个图标组件形如：
 *   var L=new Map([["regular",r(e,null,r("path",{d:"M…"}))],["light",…]]),
 *       R=n((e,t)=>r(o,{ref:t,...e,weights:L}));
 *   R.displayName="CodeIcon";var z=R
 *
 * 所以：找到 `new Map([[...]])` 块 → 取其中的 `["regular", ... d:"…" ]` → 再找它后面
 * 最近的 `displayName="XxxIcon"`。
 */
const icons = new Map();

// ⚠️ 上一版用「两个右方括号 + 右圆括号」做终点，遇到权重 Map 内部嵌套的
// 同名片段就提前截断 —— 12 个图标只抽到 6 个。
// 现在改成：从 `new Map([` 开始，非贪婪到 `])` 且后面紧跟逗号。
for (const m of src.matchAll(/new Map\(\[([\s\S]{50,20000}?)\]\)(?=,)/g)) {
  const block = m[1];
  // 这一块里各种权重的 d
  const weights = [];
  for (const w of block.matchAll(/\["(\w+)",[\s\S]*?d:\s*"([^"]{20,4000})"/g)) {
    weights.push({ weight: w[1], d: w[2] });
  }
  if (!weights.length) continue;

  // 往后找最近的 displayName
  const after = src.slice(m.index + m[0].length, m.index + m[0].length + 400);
  const dn = after.match(/displayName\s*=\s*"([A-Za-z0-9]+)"/);
  if (!dn) continue;

  const name = dn[1];
  if (icons.has(name)) continue;
  const regular = weights.find((w) => w.weight === "regular") ?? weights[0];
  icons.set(name, { name, d: regular.d, weights: weights.map((w) => w.weight) });
}

/* ── 输出 ── */
let out = `Claude 3.6556.2.0 —— 文件类型图标（Phosphor Icons, MIT）

来源：ion-dist/assets/v1/vendor-icons-BplZ6UOJ.js
这是 **Phosphor React** 的完整源码，图标 path 与 displayName 都在组件体内，
所以能完整抽出来（UI 图标不能 —— 那是编译期组件）。

共 ${icons.size} 个。
`;

for (const [name, { d, weights }] of [...icons].sort(([a], [b]) => a.localeCompare(b))) {
  out += `\n${"=".repeat(74)}\n${name}   (weights: ${weights.join(" / ")})\n${"=".repeat(74)}\n`;
  out += `<svg viewBox="0 0 256 256" width="1em" height="1em" fill="currentColor" aria-hidden="true">\n  <path d="${d}" />\n</svg>\n`;
}

writeFileSync(R(".tmp/rev/file-icons.txt"), out);
writeFileSync(R(".tmp/rev/file-icons.json"), JSON.stringify(
  Object.fromEntries([...icons].map(([k, v]) => [k, v])), null, 2));

console.log(`抽出 ${icons.size} 个文件类型图标：`);
for (const [name, { weights }] of [...icons].sort(([a], [b]) => a.localeCompare(b))) {
  console.log(`  ${name.padEnd(20)} weights=${weights.join(",")}`);
}
console.log(`\n完整：.tmp/rev/file-icons.txt`);
