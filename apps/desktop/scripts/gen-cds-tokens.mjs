/**
 * 【ARC-005 V0】**从 open-claude-ui 的 CDS 令牌生成 Mcode 的原始色阶层**。
 *
 * ## 为什么用脚本而不是手抄
 *
 * `open-claude-ui/code-examples/cds-theme.css`（MIT）是上游 reverse-engineered 的
 * 生产令牌表：35 阶灰度 + 35 阶陶土橙 + 表面阶梯 + 发丝边。Mcode 的 `styles.css`
 * 用的是 `"R G B"` 三元组（840 处 alpha 类依赖这种写法）。两边接起来需要：
 *
 *   上游 `#rrggbb` → 三元组 → 写进 `tokens.cds.css` 的 `--m-*` 原始层。
 *
 * 手抄 70 个色值必然漂；脚本从上游 CSS 里**逐条解析**，并且：
 *  - 上游文件缺失时**显式失败**（不静默生成半张表）；
 *  - 生成结果带上游文件名与色值数量，便于对账；
 *  - `--check` 模式只比对不写，CI/套件据此钉住"生成物与上游一致"。
 *
 * ## 用在哪
 *
 * `styles.css` 在 `:root` 里把现有语义 token（`--surface` / `--content` / …）
 * **重指**到这些原始层（语义名不变，840 处 class 用法零改动）。`.dark` 同理。
 *
 * 用法：
 *   node scripts/gen-cds-tokens.mjs            # 生成 src/renderer/tokens.cds.css
 *   node scripts/gen-cds-tokens.mjs --check    # 只比对，不一致 exit 1
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, "..");
const repo = resolve(desktop, "../..");
const upstreamPath = join(repo, "open-claude-ui", "code-examples", "cds-theme.css");
const outPath = join(desktop, "src", "renderer", "tokens.cds.css");

/** 只取上游里**直接给出 hex** 的原始色阶（gray / orange / clay / 表面阶梯里
 *  用 var() 的不取 —— 那些是语义层，Mcode 有自己的语义名）。 */
const RAMP_PREFIXES = ["--cds-gray-", "--cds-orange-"];

/** 几何/阴影类 token：上游给的是 px/rem/阴影串，Mcode 直接消费(不去三元组化)。
 *  只取**与主题无关**的那些；明暗分叉的语义 token 留在 styles.css。 */
const GEOMETRY_KEYS = [
  "--radius-xs", "--radius-sm", "--radius-md", "--radius-lg",
  "--radius-xl", "--radius-2xl", "--radius-3xl",
  "--cds-panel-radius", "--cds-radius-composer",
  "--cds-message-bubble-radius", "--cds-message-bubble-radius-meeting",
  "--cds-radius-pill",
  "--cds-shadow-sm", "--cds-shadow-md", "--cds-shadow-lg", "--cds-shadow-popover",
  "--cds-shadow-composer", "--cds-shadow-composer-hover", "--cds-shadow-composer-focus",
  "--cds-ring-hairline", "--cds-ring-inner", "--cds-ring-outer",
];

function parseGeometry(css) {
  const out = new Map();
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // 多行值(阴影串跨行):按 `key:` 起、到匹配的分号止。
  for (const key of GEOMETRY_KEYS) {
    const re = new RegExp(`^\\s*${escapeRe(key)}\\s*:([\\s\\S]*?);`, "m");
    const m = re.exec(css);
    if (!m) continue;
    const value = m[1].replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").trim();
    if (value.length > 0 && value.length < 400) out.set(key, value);
  }
  return out;
}

function parseRamps(css) {
  const ramp = new Map();
  for (const line of css.split("\n")) {
    const m = /^\s*(--cds-[a-z]+-\d+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/.exec(line);
    if (!m) continue;
    if (!RAMP_PREFIXES.some((p) => m[1].startsWith(p))) continue;
    ramp.set(m[1], m[2].toLowerCase());
  }
  return ramp;
}

function hexToTriplet(hex) {
  const h = hex.slice(1);
  if (h.length === 3) {
    return `${parseInt(h[0] + h[0], 16)} ${parseInt(h[1] + h[1], 16)} ${parseInt(h[2] + h[2], 16)}`;
  }
  if (h.length === 6) {
    return `${parseInt(h.slice(0, 2), 16)} ${parseInt(h.slice(2, 4), 16)} ${parseInt(h.slice(4, 6), 16)}`;
  }
  throw new Error(`不支持的色值:${hex}`);
}

if (!existsSync(upstreamPath)) {
  console.error(`缺少上游令牌文件:${upstreamPath}`);
  console.error("open-claude-ui 应克隆到仓库根（gitignore 内），见 ARC-005 计划。");
  process.exit(1);
}
const upstream = readFileSync(upstreamPath, "utf8");
const ramps = parseRamps(upstream);
const geometry = parseGeometry(upstream);
if (ramps.size < 60) {
  console.error(`只解析到 ${ramps.size} 个色阶，少于预期（>=60）—— 上游格式可能变了。`);
  process.exit(1);
}

const lines = [
  "/* 由 scripts/gen-cds-tokens.mjs 从 open-claude-ui/code-examples/cds-theme.css 生成。",
  " * 上游：MIT，Caho1/open-claude-ui（基于 REA 对 Claude 桌面端的逆向）。",
  " * 不要手改；改上游或生成器，然后重跑。",
  " *",
  " * 这些是**原始色阶**（--m-*），Mcode 的语义 token 在 styles.css 里指过来。",
  " * 用 \"R G B\" 三元组是为了让 Tailwind 的 <alpha-value> 继续工作（840 处 alpha 类）。",
  " */",
  ":root {",
];
for (const [name, hex] of [...ramps].sort(([a], [b]) => (a < b ? -1 : 1))) {
  const mname = name.replace(/^--cds-/, "--m-");
  lines.push(`  ${mname}: ${hexToTriplet(hex)}; /* ${hex} */`);
}
lines.push("}", "");
lines.push("/* 几何 / 阴影(与主题无关;值直接来自上游,不转三元组)。 */", ":root {");
/** 上游几何值里引用的语义变量 → Mcode 的语义名（Mcode 不定义 --cds-*）。
 *  未映射的 var 会让整条阴影静默失效，所以这里必须逐条对齐。
 *  注意：Mcode 的 --edge / --input-edge 存的是 "R G B" 三元组（840 处 alpha
 *  类依赖这种写法），裸写进 box-shadow 会展开成 "195 194 183" —— 计算值阶段
 *  整条声明失效、阴影静默消失，所以这里必须包一层 rgb()。 */
const VAR_MAP = {
  "--cds-border": "rgb(var(--edge))",
  "--cds-border-strong": "rgb(var(--input-edge))",
  "--cds-shadow-color": "rgba(0, 0, 0, 0.08)",
  "--cds-rem-scale": "1",
  "--cds-radius": "8px",
};
function remapVars(value) {
  return value.replace(/var\((--cds-[a-z-]+)(?:,\s*([^)]*))?\)/g, (_m, name, fallback) => {
    const mapped = VAR_MAP[name];
    if (mapped !== undefined) return mapped;
    return fallback !== undefined ? fallback : "initial";
  });
}
for (const [name, value] of [...geometry].sort(([a], [b]) => (a < b ? -1 : 1))) {
  lines.push(`  ${name.replace(/^--cds-/, "--m-")}: ${remapVars(value)};`);
}
lines.push("}", "");

const output = lines.join("\n");
if (process.argv.includes("--check")) {
  if (!existsSync(outPath)) {
    console.error(`生成物不存在:${outPath}`);
    process.exit(1);
  }
  const current = readFileSync(outPath, "utf8");
  if (current !== output) {
    console.error("tokens.cds.css 与上游不一致 —— 重跑 node scripts/gen-cds-tokens.mjs");
    process.exit(1);
  }
  console.log(`tokens.cds.css 与上游一致(${ramps.size} 个色阶 + ${geometry.size} 个几何/阴影)。`);
} else {
  writeFileSync(outPath, output, "utf8");
  console.log(`wrote ${ramps.size} ramps + ${geometry.size} geometry tokens → ${outPath}`);
}
