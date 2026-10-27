/**
 * 从渲染进程内存里抓**已经渲染出来的** SVG path。
 *
 * ## 为什么这条路可能成
 *
 * 图标虽然是编译期组件，但**渲染之后** `<path d="M…">` 会作为真实 DOM 属性
 * 存在于渲染进程的 C++ 节点 + 字符串池里。上一轮抓 `data-cds` 命中 670 次，
 * 说明属性值以字符串形式存在。`d` 属性同理。
 *
 * ## 与上一轮的区别
 *
 * 上一轮抓的是「组件名」（短、可辨认），这一轮抓的是「path 数据」
 * （以 `M` 开头、含数字与空格、长度几十到几千）。判据要严得多，
 * 否则会把任何以 M 开头的 ASCII 串都当成 path。
 *
 * ## 局限
 *
 * 拿不到「这条 path 属于哪个图标名」—— 名字与 path 在内存里不相邻。
 * 所以产出是「一批真实的 path」，配 `icon-names.txt` 的 276 个名字，
 * 形状对得上即可用。
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "../..");
const R = (p) => resolvePath(REPO_ROOT, p);

const dumpPath = R(".tmp/rev/renderer-mem.bin");
if (!existsSync(dumpPath)) {
  console.error("没有转储文件，先跑 dump-renderer-memory.mjs（REDUMP=1）");
  process.exit(1);
}

const buf = readFileSync(dumpPath);
console.error(`读到 ${(buf.length / 1048576).toFixed(0)} MiB`);

/** SVG path 的形状判据 —— 严一点，宁可少收。 */
function looksLikePath(s) {
  if (s.length < 12 || s.length > 8000) return false;
  if (!/^[Mm]/.test(s)) return false;
  // 只允许 path 语法里的字符
  if (!/^[MmLlHhVvCcSsQqTtAaZz0-9eE.,\s+-]+$/.test(s)) return false;
  // 至少要有 6 个数字
  const digits = (s.match(/[0-9]/g) ?? []).length;
  if (digits < 6) return false;
  // 至少要有一个命令字母（除开头 M 外）
  if (!/[LlHhVvCcSsQqTtAaZz]/.test(s.slice(1))) return false;
  return true;
}

const found = new Map();

/** 在两种编码里扫「以 M 开头的连续可打印串」。 */
function scan(enc) {
  const step = enc === "utf16le" ? 2 : 1;
  const len = buf.length;
  let i = 0;
  while (i < len - 12) {
    // 找 'M' 或 'm' 作为起点（utf16le 时高位是 0）
    const isM8 = buf[i] === 0x4d;
    const isM16 = buf[i] === 0x4d && buf[i + 1] === 0x00;
    if (!(enc === "utf8" ? isM8 : isM16)) { i += step; continue; }

    let j = i, chars = [];
    while (j < len) {
      const c = enc === "utf8" ? buf[j] : (buf[j + 1] === 0 ? buf[j] : -1);
      if (c < 0x20 || c > 0x7e) break;
      chars.push(String.fromCharCode(c));
      j += step;
      if (chars.length > 8000) break;
    }
    const s = chars.join("");
    if (looksLikePath(s)) found.set(s, (found.get(s) ?? 0) + 1);
    i = j > i ? j : i + step;
  }
}

scan("utf8");
scan("utf16le");

console.error(`找到 ${found.size} 条疑似 path`);

/* ── 按长度分层输出：短的更可能是图标，长的可能是图表/地图 ── */
const paths = [...found.keys()].sort((a, b) => a.length - b.length);

const buckets = [
  ["短（< 200 字符，图标级）", paths.filter((p) => p.length < 200)],
  ["中（200–800，复杂图标）", paths.filter((p) => p.length >= 200 && p.length < 800)],
  ["长（≥ 800，图表/插图）", paths.filter((p) => p.length >= 800)],
];

let out = `Claude 3.6556.2.0 —— 运行时抓到的 SVG path

来源：渲染进程内存转储（真实渲染过的 DOM 属性）
⚠️ **不知道每条 path 对应哪个图标名** —— 名字与 path 在内存里不相邻。
   配 icon-names.txt 的 276 个名字，按形状对。

共 ${found.size} 条。

`;
for (const [label, list] of buckets) {
  out += `\n${"=".repeat(78)}\n${label}  (${list.length})\n${"=".repeat(78)}\n`;
  for (const p of list.slice(0, 120)) {
    out += `\n<!-- ${p.length} 字符 -->\n<path d="${p}" />\n`;
  }
}

writeFileSync(R(".tmp/rev/svg-paths.txt"), out);
writeFileSync(R(".tmp/rev/svg-paths.json"), JSON.stringify(paths, null, 0));

console.log(`\n短 ${buckets[0][1].length} / 中 ${buckets[1][1].length} / 长 ${buckets[2][1].length}`);
console.log("\n前 5 条：");
for (const p of paths.slice(0, 5)) console.log(`  [${p.length}] ${p.slice(0, 120)}`);
console.log(`\n完整：.tmp/rev/svg-paths.txt`);
