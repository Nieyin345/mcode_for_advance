/**
 * 从 UI 骨架 chunk 里抽「className 字符串」，按组件归类。
 *
 * minified 代码里 className 都是字符串字面量，形如
 *   className:"flex w-full items-center gap-sm rounded-lg px-md ..."
 * 这些就是**真实的布局事实**（CSS 里已经是展开后的原子类，读不出「谁用了哪个」）。
 *
 * 只读文本，不执行。
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

const DIR = "C:/Program Files/WindowsApps/Claude_3.6556.2.0_x64__pzs8sxrjxfjjc/app/resources/ion-dist/assets/v1";
const FILES = [
  "cf74bc599-CRYqipWN.js",   // Entry：EpitaxyTranscriptHost / ChatComposerDock
  "shared-21-R7LldJ05.js",
  "ca2ef848d-ChLvq6yZ.js",
  "cc43287c9-Me-M2ucD.js",
];

/** 抽出所有 `className:"..."` / `className:\`...\`` / `clsx("...")` 里的字符串。 */
function classNames(src) {
  const out = [];
  const re = /className\s*:\s*(?:"([^"]{4,300})"|`([^`]{4,300})`)/g;
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[1] ?? m[2]);
  // Tailwind 的 cn(...)/clsx(...) 里也有裸字符串
  const re2 = /(?:clsx|cn|twMerge|classNames)\(\s*(?:"([^"]{8,300})")/g;
  while ((m = re2.exec(src)) !== null) out.push(m[1]);
  return out;
}

/** 这个类名串「像」什么组件。 */
function classify(c) {
  if (/composer|send|attach|textarea|prompt|editor/i.test(c)) return "输入框";
  if (/sidebar|rail|drawer/i.test(c)) return "侧栏";
  if (/titlebar|drag-region|window-controls/i.test(c)) return "标题栏";
  if (/message|transcript|prose|markdown|turn/i.test(c)) return "消息";
  if (/panel|aside|dock|inspector/i.test(c)) return "面板";
  if (/session|conversation|project|recent|pinned/i.test(c)) return "会话列表";
  return null;
}

const buckets = new Map();
for (const f of FILES) {
  let src;
  try { src = readFileSync(`${DIR}/${f}`, "utf8"); } catch { continue; }
  for (const c of classNames(src)) {
    const k = classify(c);
    if (!k) continue;
    if (!buckets.has(k)) buckets.set(k, new Set());
    // 只留「有几何含义」的：含 w- / h- / px- / py- / gap- / rounded / max-w / min-h
    if (/\b(w-|h-|min-w|max-w|min-h|max-h|px-|py-|p-|gap-|rounded|size-)/.test(c)) {
      buckets.get(k).add(c);
    }
  }
}

let out = "Claude 3.6556.2.0 —— 组件 className（含几何属性）\n";
for (const [k, set] of [...buckets].sort((a, b) => b[1].size - a[1].size)) {
  out += `\n${"=".repeat(72)}\n${k}  (${set.size} 种)\n${"=".repeat(72)}\n`;
  // 按长度排，长的信息多
  for (const c of [...set].sort((a, b) => b.length - a.length).slice(0, 60)) {
    out += `  ${c}\n`;
  }
}
writeFileSync(R(".tmp/rev/classnames.txt"), out);
console.log(out.slice(0, 9000));
