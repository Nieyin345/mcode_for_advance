/**
 * 把 Tailwind 类名解成**计算后的 px 值**。
 *
 * 为什么需要这一步：
 *   JS 里只有 `className:"flex w-72 items-center gap-sm …"`，
 *   而「`w-72` 到底是多宽」取决于 Tailwind 的 spacing 基准。
 *   这份 CSS 里已经能看到 `w-72` 被编成什么（`.w-72{width:…}`），
 *   所以直接**从 CSS 反查**，比自己假设 spacing=4px 可靠。
 *
 * 用法：`resolveClass("w-72")` → `{ prop:"width", value:"288px" }`
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "../..");
const R = (p) => resolvePath(REPO_ROOT, p);

const CSS = readFileSync(R(".tmp/rev/main.css"), "utf8");

/** CSS 里 `.<escaped-name>{…}` 的映射。Tailwind 的类名会把特殊字符转义。 */
let classMap = null;

/** 把 Tailwind 类名转成它在这份 CSS 里的选择器写法（转义 `[ ] . / : % #` 等）。 */
function escapeTailwind(cls) {
  // Tailwind 用 `\` 转义特殊字符，并把 `.` `%` 等写成 `\.` `\%`
  return cls.replace(/[.[\]()/%#:,!<>*+~='"^$|{}\\]/g, (c) => "\\" + c);
}

function buildMap() {
  classMap = new Map();
  // 扫 `.xxx{` 与 `.xxx:hover{` 这类，取**第一个**普通规则（不带伪类/变体）
  const re = /\.((?:\\.|[^\s{,:>+~[\]()])+)\{/g;
  let m;
  while ((m = re.exec(CSS)) !== null) {
    const raw = m[1];
    // 还原转义
    const cls = raw.replace(/\\(.)/g, "$1");
    // 取这条规则的 body
    let depth = 0, j = m.index + m[0].length - 1;
    for (; j < CSS.length; j++) {
      if (CSS[j] === "{") depth++;
      else if (CSS[j] === "}") { depth--; if (depth === 0) break; }
    }
    const body = CSS.slice(m.index + m[0].length, j);
    if (!classMap.has(cls)) classMap.set(cls, body);
  }
  return classMap;
}

const PROPS = ["width", "min-width", "max-width", "height", "min-height", "max-height",
  "padding", "padding-inline", "padding-block", "padding-left", "padding-right",
  "padding-top", "padding-bottom", "margin", "margin-inline", "margin-block",
  "gap", "row-gap", "column-gap", "border-radius", "font-size", "line-height",
  "inset", "top", "left", "right", "bottom", "flex", "flex-basis", "z-index"];

/** 解析一条 rule body 里我们关心的属性。 */
function declsOf(body) {
  const out = {};
  for (const part of body.split(";")) {
    const mm = part.match(/^\s*([\w-]+)\s*:\s*(.+?)\s*$/);
    if (mm && PROPS.includes(mm[1])) out[mm[1]] = mm[2];
  }
  return out;
}

/**
 * `w-72` → `{ width: "18rem" }`（CSS 里的原值）。
 * 找不到就返回 null —— **不要猜**。
 */
export function resolveClass(cls) {
  if (!classMap) buildMap();
  // 1) 直接命中
  let body = classMap.get(cls);
  // 2) Tailwind 的任意值类 `w-[18rem]` 在 CSS 里是 `.w-\[18rem\]`
  if (!body) {
    body = classMap.get(cls.replace(/\s+/g, "_"));
  }
  if (!body) return null;
  const d = declsOf(body);
  return Object.keys(d).length ? d : null;
}

/** 把 CSS 长度值折算成 px（rem / em 按 16px 基准，百分比原样返回）。 */
export function toPx(v, base = 16) {
  if (v == null) return null;
  const s = String(v).trim();
  let m = s.match(/^(-?[\d.]+)px$/); if (m) return Number(m[1]);
  m = s.match(/^(-?[\d.]+)rem$/); if (m) return Number(m[1]) * 16;
  m = s.match(/^(-?[\d.]+)em$/); if (m) return Number(m[1]) * base;
  m = s.match(/^(-?[\d.]+)$/); if (m) return Number(m[1]);
  return null;   // 百分比 / calc / var 不折算，原样保留给调用方
}

/* ═══════════════════════════════════════════════════════════════
 * 全局变量基座
 *
 * 只从两个地方取，**不猜**：
 *   `:root,:host`         → Tailwind 自己的基座（--spacing / --radius / --text-*）
 *   `.cds-root`           → CDS 的 cds 变量
 * 两者都按亮色取（尺寸不分主题）。
 * ═══════════════════════════════════════════════════════════════ */
let GLOBALS = null;

function buildGlobals() {
  GLOBALS = {};
  // 扫 `selector{--name:value;…}`
  const re = /([^{}]+)\{((?:[^{}]|\([^()]*\))*)\}/g;
  let m;
  while ((m = re.exec(CSS)) !== null) {
    const sel = m[1].trim();
    // 只认「全局基座」两个选择器（逗号分隔的任一段）
    const segs = sel.split(",").map((x) => x.trim());
    const isRoot = segs.some((x) => x === ":root" || x === ":host" || x === ":where(:root,:host)" || x === ":where(:root, :host)");
    const isCds = segs.some((x) => x === ".cds-root");
    if (!isRoot && !isCds) continue;
    const body = m[2];
    const pre = /--[\w-]+\s*:/.test(body);
    if (!pre) continue;
    for (const part of body.split(";")) {
      const mm = part.match(/^\s*(--[\w-]+)\s*:\s*(.+?)\s*$/);
      if (!mm) continue;
      // 后写的覆盖先写的（与 CSS 级联同向）
      GLOBALS[mm[1]] = mm[2];
    }
  }
  // `--cds-rem-scale` 只在 Apple 专属 @supports 里声明；Windows 上未定义，取 1。
  // 详见 extract-tokens.mjs 的 resolveScale 注释 —— 写 16/17 会让每一项小 6%。
  return GLOBALS;
}

/** 递归解 var()，用全局基座；解不开原样返回。 */
export function deref(value, depth = 0) {
  if (value == null) return null;
  if (!GLOBALS) buildGlobals();
  let s = String(value);
  if (depth > 12) return s;

  // rem-scale 先换成裸数值，避免造出嵌套 calc。
  // ⚠️ 1 而不是 16/17 —— 那个值只存在于 Apple 专属 @supports 里（见文件头）。
  s = s.replace(/var\(\s*--cds-rem-scale\s*(?:,\s*[^()]*(?:\([^()]*\)[^()]*)*)?\)/g, "1");

  s = s.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/g, (_, n, fb) => {
    const v = GLOBALS[n];
    return v !== undefined && v !== "" ? v : (fb ?? "");
  });
  if (/var\(\s*--/.test(s)) return deref(s, depth + 1);
  return s;
}

/**
 * `calc(var(--spacing) * 72)` → `18rem` → `288px`
 *
 * 只处理**两种**形状：`calc(A * B)` 与 `calc(A / B)`，操作数是裸数值或长度。
 * 其余（min/max/clamp/百分比）原样返回 —— **宁可留原式，也不猜**。
 */
export function evalLength(expr, base = 16) {
  const d = deref(expr);
  if (d == null) return { raw: expr, px: null };

  const direct = toPx(d, base);
  if (direct != null) return { raw: d, px: direct };

  // calc(X * N) / calc(X / N)
  const m = d.match(/^calc\(\s*(.+?)\s*([*/])\s*(.+?)\s*\)$/);
  if (m) {
    const a = toPx(m[1], base), b = toPx(m[3], base);
    if (a != null && b != null) {
      const v = m[2] === "*" ? a * b : (b === 0 ? null : a / b);
      if (v != null) return { raw: d, px: v };
    }
    // 一侧是裸数（如 calc(16 / 17)）
    const na = Number(m[1]), nb = Number(m[3]);
    if (Number.isFinite(na) && Number.isFinite(nb) && m[2] === "/" && nb !== 0) {
      return { raw: d, px: na / nb };
    }
  }
  return { raw: d, px: null };
}

/** 一条类名串里，所有能解出几何的类。 */
export function geometryOf(classString) {
  const out = [];
  for (const cls of String(classString).split(/\s+/).filter(Boolean)) {
    const d = resolveClass(cls);
    if (!d) continue;
    const px = {};
    const raw = {};
    for (const [k, v] of Object.entries(d)) {
      const r = evalLength(v);
      px[k] = r.px ?? r.raw;
      raw[k] = r.raw;
    }
    out.push({ cls, decls: d, deref: raw, px });
  }
  return out;
}

// 直接跑时的自检
if (process.argv[1] && process.argv[1].endsWith("resolve-class.mjs")) {
  buildMap();
  console.error(`类名映射 ${classMap.size} 条`);
  for (const t of ["w-72", "w-64", "w-80", "h-9", "h-10", "gap-sm", "gap-md", "p-lg", "px-md", "py-sm",
    "size-icon", "rounded-lg", "text-body", "text-prose", "w-[280px]", "max-w-[480px]"]) {
    const d = resolveClass(t);
    if (!d) { console.log(`  ${t.padEnd(16)} （类名不在 CSS 里）`); continue; }
    const px = Object.fromEntries(Object.entries(d).map(([k, v]) => {
      const r = evalLength(v);
      return [k, r.px == null ? r.raw : `${r.px.toFixed(2)}px`];
    }));
    console.log(`  ${t.padEnd(16)} → ${JSON.stringify(px)}`);
  }
}
