/**
 * ⚠️ **这个脚本失败了，保留是为了说明为什么静态拿不到图标。**
 *
 * 实测：只捞到 32 个，且全是误报 ——
 *   `GyMMMd` / `yMd` 是**日期格式串**，`d` / `d2` 是**变量名**，
 *   真正想找的 `ArrowReturn` / `StopCircle` / `Attachment` 一个都没命中。
 *
 * 原因是图标是**编译期组件**：调用点写作 `y(Re,{name:"ArrowReturn",size:"sm"})`，
 * 而 `Re` 是一个按名字查表的组件，表本身在别的 chunk 里且被 minify 改名。
 * 静态提取需要 AST 级追踪，而 minified bundle 没有可靠的符号边界。
 *
 * **结论：图标必须跑起来从 DOM 里抓，或者照着截图重画。**
 *
 * 原始意图（已失效）：
 * 抽图标：Claude 用的是内联 SVG，path 直接写在 JS 里。
 *
 * 形态通常是 `y(Re,{name:"ArrowReturn",size:"sm"})` + 一个图标名→path 的表，
 * 或者直接 `d:"M…"` 的 <path>。
 *
 * 本脚本只做一件事：把 `<path d="…">` 的字符串按**邻近的图标名**归类，
 * 输出成可以直接抄进 Mcode 的 SVG。
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "../..");
const R = (p) => resolvePath(REPO_ROOT, p);
const ASSETS =
  "C:/Program Files/WindowsApps/Claude_3.6556.2.0_x64__pzs8sxrjxfjjc/app/resources/ion-dist/assets/v1";

const files = readdirSync(ASSETS).filter((f) => f.endsWith(".js"))
  .map((f) => ({ f, size: statSync(join(ASSETS, f)).size }))
  .sort((a, b) => b.size - a.size);

/** 图标名 → { d, viewBox, file }。后出现的覆盖先出现的（同名图标通常一致）。 */
const icons = new Map();

/**
 * 两种形态都收：
 *   1. `{name:"X", d:"M…"}` 或 `X={d:"M…"}`
 *   2. `<path d="M…"/>` 前面附近有 `name:"X"` 或 `"X":`
 */
for (const { f } of files) {
  let src;
  try { src = readFileSync(join(ASSETS, f), "utf8"); } catch { continue; }

  // 形态 A：d:"…" 且同名对象里有 name:"…" 或紧邻一个标识符
  for (const m of src.matchAll(/(\w{1,30})\s*[:=]\s*\{[^{}]{0,120}?d\s*:\s*"([Mm][^"]{20,4000})"/g)) {
    const name = m[1];
    if (icons.has(name)) continue;
    icons.set(name, { d: m[2], viewBox: "0 0 16 16", file: f });
  }
  // 形态 B：name:"X" 与 d:"…" 同一对象内（顺序任意）
  for (const m of src.matchAll(/\{[^{}]{0,300}?name\s*:\s*"([A-Z][\w]{2,40})"[^{}]{0,300}?d\s*:\s*"([Mm][^"]{20,4000})"/g)) {
    const [, name, d] = m;
    if (!icons.has(name)) icons.set(name, { d, viewBox: "0 0 16 16", file: f });
  }
  for (const m of src.matchAll(/\{[^{}]{0,300}?d\s*:\s*"([Mm][^"]{20,4000})"[^{}]{0,300}?name\s*:\s*"([A-Z][\w]{2,40})"/g)) {
    const [, d, name] = m;
    if (!icons.has(name)) icons.set(name, { d, viewBox: "0 0 16 16", file: f });
  }
}

/* ── 输出 ── */
let out = `Claude 3.6556.2.0 —— 内联 SVG 图标

⚠️ 这是**静态提取**：从 JS 字符串里捞 path。
   图标名取自邻近的 \`name:"X"\` 或对象键，**可能有个别错配**。
   用之前建议在真机上对一眼。

共 ${icons.size} 个。
`;

const names = [...icons.keys()].sort();
for (const n of names) {
  const { d, viewBox } = icons.get(n);
  out += `\n<!-- ${n} -->\n<svg viewBox="${viewBox}" width="16" height="16" fill="none" aria-hidden="true">\n  <path d="${d}" />\n</svg>\n`;
}

writeFileSync(R(".tmp/rev/icons.txt"), out);
writeFileSync(R(".tmp/rev/icons.json"), JSON.stringify(
  Object.fromEntries(names.map((n) => [n, icons.get(n)])), null, 2));

console.log(`提取到 ${icons.size} 个图标`);
console.log(names.slice(0, 80).join("  "));
console.log(`\n…完整：.tmp/rev/icons.txt`);
