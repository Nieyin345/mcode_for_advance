/**
 * 【UI 重建】**从本机安装的 Claude Desktop 生成 Mcode 的原始 token 层**。
 *
 * ## 来源变更（2026-10-27）
 *
 * 旧版从仓库里的 `open-claude-ui/code-examples/cds-theme.css`（第三方对 2.x 的逆向）
 * 生成。已废弃：那份产物里有若干 token 名在真实 3.1623.4.0 里**不存在**，
 * 且只覆盖 gray + orange 两个色系，而真实产物有 **9 个色系 × 35 档**。
 *
 * 现在直接读用户本机安装的 Claude Desktop 的 CSS 产物：
 *   `%ProgramFiles%\WindowsApps\Claude_<ver>_x64__<hash>\app\resources\ion-dist\assets\v1\*.css`
 *
 * 安装路径与版本号**不写死**——按 Appx 目录通配查找，取版本号最大的一个。
 * 找不到就显式失败（不静默生成半张表）。
 *
 * ## 产出
 *
 * `src/renderer/tokens.cds.css`：
 *   - 全部 `--cds-<系>-<档>` 色阶 → `--m-<系>-<档>`（`"R G B"` 三元组，840 处 alpha 类依赖）
 *   - 几何 / 阴影 / 圆角 token → `--m-*`（值里的上游 var() 逐条映射）
 *
 * ## 用法
 *
 *   node scripts/gen-cds-tokens.mjs                 # 生成
 *   node scripts/gen-cds-tokens.mjs --check         # 只比对，不一致 exit 1
 *   node scripts/gen-cds-tokens.mjs --claude <dir>  # 指定 Claude 安装根目录
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, "..");
const outPath = join(desktop, "src", "renderer", "tokens.cds.css");

const OS = process.env.ProgramFiles || "C:\\Program Files";
const WINDOWS_APPS = join(OS, "WindowsApps");

/** 找到本机安装的 Claude Desktop 的 ion-dist 目录。
 *
 *  `C:\Program Files\WindowsApps` **不允许列出目录**（EPERM），所以不能 scandir。
 *  用 PowerShell 的 `Get-AppxPackage` 拿确切 InstallLocation —— 它只返回路径，
 *  不枚举父目录。多个版本时取最高的。
 */
function findClaudeIonDist() {
  const argIdx = process.argv.indexOf("--claude");
  if (argIdx >= 0 && process.argv[argIdx + 1]) {
    const root = resolve(process.argv[argIdx + 1]);
    const ion = join(root, "app", "resources", "ion-dist");
    if (existsSync(ion)) return ion;
    const ion2 = join(root, "resources", "ion-dist");
    if (existsSync(ion2)) return ion2;
    throw new Error(`指定的 Claude 目录里找不到 ion-dist：${root}`);
  }
  let loc = "";
  try {
    loc = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command",
       "$p = Get-AppxPackage -Name Claude | Sort-Object Version -Descending | Select-Object -First 1; if ($p) { $p.InstallLocation }"],
      { encoding: "utf8", windowsHide: true, timeout: 20000 },
    ).trim();
  } catch (err) {
    throw new Error(`查询 Claude 安装位置失败：${err.message}`);
  }
  if (!loc) {
    throw new Error("本机没有安装 Claude Desktop（Get-AppxPackage -Name Claude 无结果）。" +
      "用 --claude <安装根目录> 指定，或先安装 Claude 桌面端。");
  }
  const ion = join(loc, "app", "resources", "ion-dist");
  if (!existsSync(ion)) throw new Error(`Claude 安装目录里找不到 ion-dist：${ion}`);
  return ion;
}

/** 主样式表：assets/v1 下最大的那份 .css（当前 1.4–1.5 MB，含 1000+ token）。 */
function findMainCss(ionDist) {
  const dir = join(ionDist, "assets", "v1");
  if (!existsSync(dir)) throw new Error(`找不到 assets/v1：${dir}`);
  const css = readdirSync(dir)
    .filter((f) => f.endsWith(".css"))
    .map((f) => ({ f, size: statSync(join(dir, f)).size }))
    .sort((a, b) => b.size - a.size);
  if (css.length === 0) throw new Error(`assets/v1 下没有 .css：${dir}`);
  return join(dir, css[0].f);
}

// ── 解析 ────────────────────────────────────────────────────────────────

/** 极简规则遍历：摊平一层 at-rule，返回 [选择器, 正文, 祖先at规则]。
 *
 *  **必须带 at-rule 上下文**：Claude 的暗色不是 `.dark`，而是
 *  `@media screen and (prefers-color-scheme: dark)` 加 `[data-mode=dark]`。
 *  丢掉祖先会把暗色值和亮色值混成一份，暗色主题就全错。 */
function* iterRules(css) {
  let i = 0, n = css.length, depth = 0, selStart = 0, bodyStart = null, sel = "";
  const atStack = [];
  let pendingAt = "";
  while (i < n) {
    const ch = css[i];
    if (ch === "{") {
      if (depth === 0) {
        sel = css.slice(selStart, i).trim();
        bodyStart = i + 1;
        if (sel.startsWith("@")) {
          pendingAt = atStack.concat([sel]).join(" | ");
        }
      }
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && bodyStart !== null) {
        yield [sel, css.slice(bodyStart, i), pendingAt];
        bodyStart = null;
        selStart = i + 1;
        if (sel.startsWith("@")) pendingAt = "";
      }
    } else if (ch === ";" && depth === 0) {
      selStart = i + 1;
    }
    i++;
  }
}

/** 是不是「默认档」的定义。
 *
 *  Claude 的密度/尺寸档位写成 `:where([data-density=compact], [data-density=compact] *)`
 *  —— 属性在**函数内部**，不在选择器前缀。所以只判断选择器里有没有这些档位标记，
 *  不判断位置。 */
function isAmbientSelector(sel) {
  return !/data-(density|mode|size|text-size)|\.dark\b|@media|@container|@supports/.test(sel);
}

function parseTokens(css) {
  const all = new Map();      // name -> [{ sel, at, value }]
  for (const [sel, body, at] of iterRules(css)) {
    /* 收两类名字：
     *  - `--cds-*`（Claude 的主要命名空间）
     *  - **不带前缀的 `--radius-*` / `--shadow-*`**：Claude 的圆角/阴影档位
     *    用的是裸名（实测 `--radius-sm` / `--radius-md` 存在，`--cds-radius-sm`
     *    不存在）。不收它们会让圆角体系整个缺档。
     * 值必须以 `;` 结尾（`[^;}]+`）—— 见下面 parseTokens 的说明。 */
    const re = /(--(?:cds-[a-z0-9-]+|radius-[a-z0-9-]+))\s*:\s*([^;}]+)/g;
    let m;
    while ((m = re.exec(body)) !== null) {
      const name = m[1];
      const value = m[2].replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").trim();
      if (!value) continue;
      if (!all.has(name)) all.set(name, []);
      all.get(name).push({ sel, at: at || "", value });
    }
  }
  return all;
}

/** 是否暗色作用域。Claude 用四种写法，都要认：
 *  `@media ... prefers-color-scheme:dark`、`[data-mode=dark]`、`.dark`，
 *  以及**裸 `@media screen`** —— Claude 在 `.cds-root` 之后用一层无条件的
 *  `@media screen` 块表达「系统主题」（外层已按亮/暗分别包好）。不带这个判断，
 *  `neutral-900` 的亮色值会被暗色块里的 gray-900 覆盖。 */
function isDark(entry) {
  const scope = entry.at + " " + entry.sel;
  if (/prefers-color-scheme:\s*dark|data-mode=["']?dark|(^|\s)\.dark\b/.test(scope)) return true;
  // 裸媒体块：只认 `@media screen`（不含 prefers-color-scheme / min-width 等条件）
  return /@media\s+screen\s*(\||$)/.test(scope) && !/prefers-color-scheme|min-width|max-width/.test(scope);
}

/** 取一个 token 的默认（亮色）值：外层、非暗色、非密度作用域里的第一处。 */
function defaultValue(entries) {
  const ambient = entries.find((e) => isAmbientSelector(e.sel) && !isDark(e));
  return (ambient ?? entries.find((e) => !isDark(e)) ?? entries[0]).value;
}

/** 取暗色值：优先 `[data-mode=dark]`（显式），其次 prefers-color-scheme。 */
function darkValue(entries) {
  const explicit = entries.find((e) => /data-mode=["']?dark/.test(e.at + " " + e.sel));
  if (explicit) return explicit.value;
  const mq = entries.find((e) => /prefers-color-scheme:\s*dark/.test(e.at + " " + e.sel));
  return mq ? mq.value : undefined;
}

function hexToTriplet(hex) {
  const h = hex.replace(/^#/, "");
  if (h.length === 3) return `${parseInt(h[0] + h[0], 16)} ${parseInt(h[1] + h[1], 16)} ${parseInt(h[2] + h[2], 16)}`;
  if (h.length === 6) return `${parseInt(h.slice(0, 2), 16)} ${parseInt(h.slice(2, 4), 16)} ${parseInt(h.slice(4, 6), 16)}`;
  if (h.length === 8) return `${parseInt(h.slice(0, 2), 16)} ${parseInt(h.slice(2, 4), 16)} ${parseInt(h.slice(4, 6), 16)}`;
  throw new Error(`不支持的色值：${hex}`);
}

// ── 生成 ────────────────────────────────────────────────────────────────

const ionDist = findClaudeIonDist();
const cssPath = findMainCss(ionDist);
const css = readFileSync(cssPath, "utf8");
const tokens = parseTokens(css);

// 1) 色阶：--cds-<系>-<数字>，值直接是 hex
const RAMP_RE = /^--cds-([a-z]+)-(\d+)$/;
const ramps = new Map();
for (const [name, entries] of tokens) {
  if (!RAMP_RE.test(name)) continue;
  const v = defaultValue(entries);
  if (/^#[0-9a-fA-F]{3,8}$/.test(v)) ramps.set(name, v);
}
if (ramps.size < 200) {
  console.error(`只解析到 ${ramps.size} 个色阶，少于预期（>=200）—— Claude 产物格式可能变了。`);
  process.exit(1);
}

// 2) 几何 / 阴影 / 圆角：名字里带这些词、且值不是纯色阶引用的
const GEOMETRY_HINT = /(radius|shadow|ring|hairline|btn-spring|dur-|ease-|leading|font-size|h-control|icon|gap-|pad-)/;

/** 上游 var() → Mcode 语义名。Mcode 不定义 --cds-*，未映射的会让整条声明静默失效。 */
const VAR_MAP = {
  "--cds-border": "rgb(var(--edge))",
  "--cds-border-strong": "rgb(var(--input-edge))",
  "--cds-shadow-color": "rgba(0, 0, 0, 0.08)",
  // **不要把 --cds-rem-scale 映射成常量**：它在下面自己的 :root 里以
  // `--m-rem-scale: calc(16 / 17)` 导出。映射成 "1" 会让每条
  // `calc(.875rem * var(--cds-rem-scale,1))` 变成 `.875rem` —— 字号比 Claude 大 6%。
  "--cds-radius": "8px",
  "--cds-surface-0": "rgb(var(--surface-muted))",
  "--cds-surface-1": "rgb(var(--surface))",
  "--cds-surface-2": "rgb(var(--surface))",
  "--cds-text-primary": "rgb(var(--content))",
  "--cds-text-secondary": "rgb(var(--content-muted))",
  "--cds-text-muted": "rgb(var(--content-subtle))",
  "--cds-fill-accent": "rgb(var(--accent))",
  "--cds-bg-accent": "rgb(var(--accent) / 0.12)",
};
function remapVars(value, depth = 0) {
  if (depth > 6) return value; // 防御：自引用/超深嵌套
  const once = value
    .replace(/var\((--cds-[a-z0-9-]+)(?:,\s*([^)]*))?\)/g, (_m, name, fallback) => {
      const mapped = VAR_MAP[name];
      if (mapped !== undefined) return mapped;
      // rem-scale / spacing 等基准量已经是 Mcode 自己的变量，改个名指过去。
      if (name === "--cds-rem-scale") return "var(--m-rem-scale)";
      /* 未映射时的兜底**不能是 `initial`**：`initial` 在 `box-shadow` /
       * `hsl(from …)` 里不是合法分量，会让整条声明失效（实测 7 处，
       * 包括 --focus-shadow —— 那是可达性问题）。
       * 用 `transparent` 更安全：它在颜色位置总是合法的，
       * 阴影/描边退化成「看不见」而不是「整条规则被丢弃」。 */
      return fallback !== undefined ? fallback : "transparent";
    })
    // Tailwind v4 风格的 `--color-<系>-<档>`（Claude 部分规则用这套）。
    // 不映射会让整条 color-mix 声明静默失效 —— 与 --edge 三元组那个坑同型。
    .replace(/var\(--color-([a-z]+)-(\d+)\)/g, (_m, hue, step) => `rgb(var(--m-${hue}-${step}))`);
  /* **必须递归**：Claude 大量使用 `var(--a, var(--b))` 这种嵌套兜底
   * （实测 `--cds-ring-color: var(--cds-border-line,var(--cds-border))`）。
   * 只替换一层时，内层 `var(--cds-border)` 会原样留在生成物里 —— 而 Mcode
   * 不定义任何 `--cds-*`，那条声明在浏览器里静默失效。 */
  return once === value ? once : remapVars(once, depth + 1);
}

const geometry = new Map();
for (const [name, entries] of tokens) {
  // 裸名 `--radius-*` 一律算几何（Claude 的圆角档位就是这么命名的）。
  const isBareRadius = /^--radius-/.test(name);
  if (!isBareRadius && !GEOMETRY_HINT.test(name)) continue;
  const v = remapVars(defaultValue(entries));
  if (v.length === 0 || v.length > 400) continue;
  if (/^#[0-9a-fA-F]{3,8}$/.test(v)) continue; // 纯色值不算几何
  geometry.set(name, v);
}

// `--cmp-*` 依赖 `--cds-h-control` / `--cds-h-control--sm` / `--cds-h-control--xs`
// 这几个**尺寸档位**。它们不在 GEOMETRY_HINT 里（名字是 h-control，不是 pad/gap），
// 漏了会让整条 `calc(var(--cds-h-control) - …)` 静默失效。单独收全。
for (const [name, entries] of tokens) {
  if (!/^--cds-h-control(--(xs|sm|lg|xl))?$/.test(name)) continue;
  const v = remapVars(defaultValue(entries));
  if (v && !/^initial$/.test(v) && v.length < 120) geometry.set(name, v);
}

// 3) 语义映射链（--cds-neutral-* / --cds-surface-* / --cds-text-* / --cds-fill-* …）
//    这些的值是 `var(--cds-gray-N)`，亮暗的差别**整个体现在这条链上**：
//    亮色 `--cds-neutral-900: var(--cds-gray-0)`，暗色 `var(--cds-gray-900)`。
//    所以必须把链本身也导出来，并把暗色那份单独放 .dark。
const SEMANTIC_PREFIX = /^--cds-(neutral|surface|text|fill|border|bg|stroke|alpha|role|icon|link|danger|warning|success|info|accent|clay)-/;

function toM(name) {
  // var(--cds-x-N) → var(--m-x-N)：指向我们已经生成的色阶层
  return name.replace(/^--cds-/, "--m-");
}

const semantics = new Map();      // name -> { light, dark? }
for (const [name, entries] of tokens) {
  if (!SEMANTIC_PREFIX.test(name)) continue;
  const light = defaultValue(entries);
  if (!/var\(--cds-[a-z]+-\d+\)/.test(light)) continue; // 只收纯色阶引用
  const dark = darkValue(entries);
  semantics.set(name, {
    light: toM(light.replace(/var\((--cds-[a-z]+-\d+)\)/g, (_m, n) => `var(${toM(n)})`)),
    dark: dark && /var\(--cds-[a-z]+-\d+\)/.test(dark)
      ? toM(dark.replace(/var\((--cds-[a-z]+-\d+)\)/g, (_m, n) => `var(${toM(n)})`))
      : undefined,
  });
}

// 4) 暗色覆写：几何 token 在暗色作用域下的重定义
const darkGeometry = new Map();
for (const [name, entries] of tokens) {
  if (!geometry.has(name)) continue;
  const d = darkValue(entries);
  if (d === undefined) continue;
  const v = remapVars(d);
  if (v !== geometry.get(name)) darkGeometry.set(name, v);
}

// 5) 密度档：Claude 用 `[data-density=compact]` / `[data-density=comfortable]`
//    在 `:where()` 里整体翻转尺寸。默认（:root）就是 comfortable 档，所以只导出
//    compact 那份差异，挂在 `html[data-density="compact"]` 上。
// 5) 密度档：Claude 用 `:where([data-density=compact], …)` 在**组件级**覆盖。
//    它不是一个「整套 token 换一份」，而是逐组件的 Tailwind 变体类
//    （`.compact:gap-sm`、`.compact:[--cds-radius-composer:…]`）。
//    这里把**所有 compact 规则里设置的 --cds-* 变量**收成一份差距表，
//    挂在 `html[data-density="compact"]` 上 —— 比 Claude 的逐组件类稍粗，
//    但覆盖同一批变量，且 Mcode 的组件读的正是这些变量。
const compactTokens = new Map();
for (const [name, entries] of tokens) {
  const c = entries.find((e) => /data-density=compact/.test(e.sel));
  if (!c) continue;
  const v = remapVars(c.value);
  if (v && !/^initial$/.test(v.trim())) compactTokens.set(name, v);
}
// 另外把 Tailwind 的 `--cmp-*`（composer 专用）也收进来，它们是 Mcode 没有的一组。
// comfortable 是默认档 → 进 :root；compact → 进密度覆盖。
//
// **不用 iterRules**：这些选择器里带转义冒号（`.compact\:gap-sm:where(...)`），
// 用规则解析器会在冒号处切错。直接按「选择器片段 + 花括号正文」正则扫描。
function collectCmp(density) {
  const out = new Map();
  // 两轮扫描：一是 `data-density=<档>` 块，二是**不带密度限定的全局 `--cmp-*`**。
  const re = new RegExp(`[^{}]*data-density=${density}[^{}]*\\{([^}]*)\\}`, "g");
  let m;
  while ((m = re.exec(css)) !== null) {
    const body = m[1];
    const varRe = /(--(?:cmp|cds)-[a-z0-9-]+)\s*:\s*([^;]+)/g;
    let v;
    while ((v = varRe.exec(body)) !== null) {
      const val = remapVars(v[2].trim());
      if (val && !/^initial$/.test(val)) out.set(v[1], val);
    }
  }
  if (density === "comfortable") {
    // 全局 `--cmp-*`（不带密度限定）是默认档 —— 它们散在 :root / .cds-root 里，
    // 上面那个按块扫的循环看不到。单独全文扫一遍。
    const g = /(--cmp-[a-z0-9-]+)\s*:\s*([^;]+)/g;
    let v;
    while ((v = g.exec(css)) !== null) {
      if (out.has(v[1])) continue;
      const val = remapVars(v[2].trim());
      if (val && !/^initial$/.test(val)) out.set(v[1], val);
    }
  }
  return out;
}
const comfyCmp = collectCmp("comfortable");
const compactCmp = collectCmp("compact");
for (const [k, v] of compactCmp) compactTokens.set(k, v);

// 基准量（rem-scale / spacing）**从产物里现读**，不硬编码 —— 它们一变，
// 所有字号与间距跟着变，写死就等于把 Claude 的版本钉在这。
function firstRaw(name) {
  const e = tokens.get(name);
  if (e) {
    const v = defaultValue(e);
    if (v && v !== "initial") return v;
  }
  // `--spacing` 这类**不带 --cds- 前缀**的基准量不在 tokens 里，直接扫原文。
  const at = css.indexOf(name + ":");
  if (at < 0) return undefined;
  const rest = css.slice(at + name.length + 1);
  const end = rest.search(/[;}]/);
  return end > 0 ? rest.slice(0, end).trim() : undefined;
}
const baseRemScale = firstRaw("--cds-rem-scale");
const baseSpacing = firstRaw("--spacing");

// ── 输出 ────────────────────────────────────────────────────────────────

const claudeVer = (() => {
  const m = ionDist.match(/Claude_([\d.]+)_x64__/);
  return m ? m[1] : "unknown";
})();
const cssRel = cssPath.split(/[\\/]/).slice(-2).join("/");

const lines = [
  `/* 由 scripts/gen-cds-tokens.mjs 从**本机安装的 Claude Desktop ${claudeVer}** 生成。`,
  ` * 源文件：${cssRel}`,
  " * 不要手改；重跑 `node scripts/gen-cds-tokens.mjs` 即可（Claude 升级后重跑）。",
  " *",
  " * 这些是**原始层**（--m-*），Mcode 的语义 token 在 styles.css 里指过来。",
  ' * 色阶用 "R G B" 三元组，让 Tailwind 的 <alpha-value> 继续工作（840 处 alpha 类）。',
  " */",
  ":root {",
];
for (const [name, hex] of [...ramps].sort(([a], [b]) => (a < b ? -1 : 1))) {
  lines.push(`  ${name.replace(/^--cds-/, "--m-")}: ${hexToTriplet(hex)}; /* ${hex} */`);
}
lines.push("}", "");
lines.push(
  "/* 基准量：从 Claude 产物里**现读**，不硬编码。",
  ` * --cds-rem-scale = ${baseRemScale ?? "(未找到)"} —— 所有字号/圆角/间距都乘它。`,
  " * 它一变，整套尺寸跟着变；写死就等于把这个版本钉住。 */",
  ":root {",
);
if (baseRemScale) lines.push(`  --m-rem-scale: ${baseRemScale};`);
if (baseSpacing) lines.push(`  --spacing: ${baseSpacing};`);
lines.push("}", "");
if (comfyCmp.size > 0) {
  lines.push("/* composer 专用尺寸（Claude 的 --cmp-*，舒适档 = 默认档）。 */", ":root {");
  for (const [name, value] of [...comfyCmp].sort(([a], [b]) => (a < b ? -1 : 1))) {
    lines.push(`  --${name.replace(/^--/, "")}: ${value};`);
  }
  lines.push("}", "");
}
lines.push("/* 几何 / 阴影 / 字号 / 动效（值直接来自 Claude 产物，不转三元组）。 */", ":root {");
for (const [name, value] of [...geometry].sort(([a], [b]) => (a < b ? -1 : 1))) {
  lines.push(`  ${name.replace(/^--cds-/, "--m-")}: ${value};`);
}
lines.push("}", "");
lines.push("/* 语义映射链：值是指向色阶的 var()。亮暗的差别整个体现在这条链上 ——", " * Claude 暗色不是逐个 token 覆盖，而是把 neutral-900 从 gray-0 改成 gray-900。 */", ":root {");
for (const [name, v] of [...semantics].sort(([a], [b]) => (a < b ? -1 : 1))) {
  lines.push(`  ${name.replace(/^--cds-/, "--m-")}: ${v.light};`);
}
lines.push("}", "");
const hasDark = darkGeometry.size > 0 || [...semantics.values()].some((v) => v.dark);
if (hasDark) {
  lines.push("/* 暗色：Claude 在 @media prefers-color-scheme:dark / [data-mode=dark] 下的那套。 */", ".dark {");
  for (const [name, v] of [...semantics].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (v.dark) lines.push(`  ${name.replace(/^--cds-/, "--m-")}: ${v.dark};`);
  }
  for (const [name, value] of [...darkGeometry].sort(([a], [b]) => (a < b ? -1 : 1))) {
    lines.push(`  ${name.replace(/^--cds-/, "--m-")}: ${value};`);
  }
  lines.push("}", "");
}
if (compactTokens.size > 0) {
  lines.push(
    "/* 紧凑密度档：Claude 用 [data-density=compact] 整体翻转尺寸。",
    " * 挂在 html 上（与 Claude 一样是全局开关），不是逐个组件改 class。 */",
    'html[data-density="compact"] {',
  );
  for (const [name, value] of [...compactTokens].sort(([a], [b]) => (a < b ? -1 : 1))) {
    lines.push(`  ${name.replace(/^--cds-/, "--m-")}: ${value};`);
  }
  lines.push("}", "");
}

const output = lines.join("\n");

/* 【硬检查】生成物里**不允许残留 `var(--cds-*)`**。
 *
 * Mcode 不定义任何一个 `--cds-*`（它们只存在于 Claude 的产物里）。残留一个
 * 就意味着那条声明在浏览器里**静默失效** —— 阴影/边框直接消失，而构建、
 * 类型检查、截图都不会报错。2026-10-27 实测 `--m-ring-color: var(--cds-border)`
 * 就是这么漏出来的。
 *
 * 与其逐条追「哪个 token 没进映射」，不如在这里一次性挡住：**宁可让生成脚本
 * 失败，也不要产出一份「看起来正常但某些声明是空的」样式表**。 */
{
  const leftovers = [...output.matchAll(/var\(--cds-[a-z0-9-]+[^)]*\)/g)].map((m) => m[0]);
  if (leftovers.length > 0) {
    const uniq = [...new Set(leftovers)];
    console.error(
      `生成物里还有 ${leftovers.length} 处未解析的上游变量（${uniq.length} 个不同）：\n  ` +
        uniq.slice(0, 12).join("\n  "),
    );
    console.error("\n在 VAR_MAP 里补上映射，或在 GEOMETRY_HINT / SEMANTIC_PREFIX 里收进对应分组。");
    process.exit(1);
  }
}
if (process.argv.includes("--check")) {
  if (!existsSync(outPath)) {
    console.error(`生成物不存在：${outPath}`);
    process.exit(1);
  }
  if (readFileSync(outPath, "utf8") !== output) {
    console.error("tokens.cds.css 与 Claude 产物不一致 —— 重跑 node scripts/gen-cds-tokens.mjs");
    process.exit(1);
  }
  console.log(`tokens.cds.css 与 Claude ${claudeVer} 一致（${ramps.size} 色阶 + ${geometry.size} 几何 + ${darkGeometry.size} 暗色覆写）。`);
} else {
  writeFileSync(outPath, output, "utf8");
  console.log(`Claude ${claudeVer} → ${ramps.size} 色阶 + ${geometry.size} 几何 + ${darkGeometry.size} 暗色覆写`);
  console.log(`wrote ${outPath}`);
}
