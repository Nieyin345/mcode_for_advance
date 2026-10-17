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
  console.log(`tokens.cds.css 与上游一致(${ramps.size} 个色阶)。`);
} else {
  writeFileSync(outPath, output, "utf8");
  console.log(`wrote ${ramps.size} ramps → ${outPath}`);
}
