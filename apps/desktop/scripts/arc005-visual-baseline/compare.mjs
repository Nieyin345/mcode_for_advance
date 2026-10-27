/**
 * T01 ARC-005 V4: compare computed tokens (not guessed screenshots) only
 * for families explicitly described in reference matrix §二/§四/§五.
 * Supports optional --out for isolated mutation verification.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const evidence = join(repo, ".tmp/arc005-visual");
const args = process.argv.slice(2);
const output = args.includes("--out") ? resolve(args[args.indexOf("--out")+1] ?? "") : join(evidence, "diff.md");

/** 【UI 重建 2026-10-27】上游参照从**第三方逆向 CSS** 换成**本机 Claude 安装包**。
 *
 *  旧的 `open-claude-ui/code-examples/cds-theme.css` 已废弃：它是对 2.x 的逆向，
 *  其中若干 token 名在真实 3.1623.4.0 里不存在（实测 `--static-sidebar-width`
 *  / `--chat-leading` 都查不到），拿它当基准会得出错误的「一致」结论。
 *
 *  新源：`Claude_<ver>` 的 `ion-dist/assets/v1/` 下最大的那个 .css。
 *  与 `gen-cds-tokens.mjs` 用同一套查找逻辑（PowerShell 查 Appx 拿路径，
 *  因为 WindowsApps 目录不允许列出）。找不到就**显式失败**，不静默跳过比对。
 */
function findClaudeCss() {
  let loc = "";
  try {
    loc = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command",
       "$p = Get-AppxPackage -Name Claude | Sort-Object Version -Descending | Select-Object -First 1; if ($p) { $p.InstallLocation }"],
      { encoding: "utf8", windowsHide: true, timeout: 20000 },
    ).trim();
  } catch (e) {
    throw new Error("查询 Claude 安装位置失败：" + e.message);
  }
  if (!loc) throw new Error("本机没有装 Claude Desktop —— 视觉比对没有参照物，拒绝出结论。");
  const dir = join(loc, "app", "resources", "ion-dist", "assets", "v1");
  if (!existsSync(dir)) throw new Error("找不到 Claude 的 assets/v1：" + dir);
  const css = readdirSync(dir)
    .filter((f) => f.endsWith(".css"))
    .map((f) => ({ f, size: statSync(join(dir, f)).size }))
    .sort((a, b) => b.size - a.size);
  if (!css.length) throw new Error("Claude assets/v1 下没有 .css：" + dir);
  return join(dir, css[0].f);
}

const upstreamPath = findClaudeCss();
const matrixPath = join(repo,"docs/design/claude-code-reference-matrix.md");
const upstreamCss = readFileSync(upstreamPath,"utf8");
const matrix = readFileSync(matrixPath,"utf8");
if (!matrix.includes("## 二、token 对照表") || !matrix.includes("## 五、动效")) throw Error("Reference matrix shape changed; refuse guessing");

/** 本机 Claude 的暗色不是单一块，而是 `@media (prefers-color-scheme:dark)` +
 *  `.dark` + 裸 `@media screen` 三处。这里把**整个文件**当亮色池，
 *  暗色另取一份带暗色标记的片段（宽匹配，宁可多取不漏取）。 */
const darkStart = (() => {
  const i = upstreamCss.search(/@media[^{]*prefers-color-scheme:\s*dark|\[data-mode=["']?dark/);
  return i < 0 ? upstreamCss.length : i;
})();
const rootCss = upstreamCss.slice(0, darkStart);
const darkCss = upstreamCss.slice(darkStart);
const getVar = (css,k) => {
  const lines = css.match(new RegExp("(?:^|\\n)\\s*"+k.replaceAll("-","\\-")+"\\s*:\\s*([^;]+);","m"));
  return lines?.[1]?.trim() ?? null;
};
const fromUpstream = (key,theme,depth=0) => {
  if (depth>8) return "CYCLE";
  const raw = (theme==="dark" ? getVar(darkCss,key) : null) ?? getVar(rootCss,key);
  if (raw == null) return "(上游未定义)";
  return raw.replace(/var\((--[a-z0-9-]+)(?:,[^)]*)?\)/g, (_m, dep) => fromUpstream(dep,theme,depth+1)).trim();
};
const normalizeColor = v => {
  const s=String(v??"").trim().toLowerCase();
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/.test(s)) {
    return s.length===4 ? '#'+[...s.slice(1)].map(c=>c+c).join('') : s;
  }
  let p = s.match(/^([\d.]+)\s+([\d.]+)\s+([\d.]+)$/) ?? s.match(/^rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/);
  if(p) return '#'+[1,2,3].map(i=>Math.round(Number(p[i])).toString(16).padStart(2,'0')).join('');
  return s.replace(/\s+/g,'').replace(/^0ms$/,'0s');
};
const expected = {
  light: {
    "--surface": ["#fcfcfb","--cds-surface-1","一致"],
    "--surface-muted": ["#f9f9f7","--cds-surface-0","一致"],
    "--surface-hover": ["#f0efec","--cds-fill-ghost-hover","已知差异（矩阵已登记，理由见矩阵）"],
    "--content": ["#151515","--cds-text-primary","一致"],
    "--content-muted": ["#52514e","--cds-text-secondary","已知差异（矩阵已登记，理由见矩阵）"],
    "--content-subtle": ["#6d6b67","--cds-text-muted","已知差异（矩阵已登记，理由见矩阵）"],
    // 【T141】`--edge` 的登记值是 **R G B 三元组**（`styles.css:181` 存的就是 `217 217 216`），
    // 不是十六进制 —— 所以这里也写成三元组，让 `normalized` 两边同一形态比较。
    //
    // 【为什么以前是 `#c3c2b7`】那是 T121（`b736c814`，2026-10-24 14:58）之前的值。
    // 那次提交按「既要在画布上看得见、又要和 `--surface-hover` 分得开」重定了这一档，
    // 但没有同步更新本题和参考矩阵的登记值 —— 于是 51 格（17 场景 × 亮/暗/窄）全部
    // 报「未登记差异」。**51 条其实是同一个根因在两个明度上的重复计数，不是 51 个问题。**
    "--edge": ["217 217 216","--cds-border","已知差异（矩阵已登记，理由见矩阵）"],
  },
  dark: {
    "--surface": ["#151515","--cds-surface-1","一致"],
    /* 【UI 重建 2026-10-27】暗色 `--surface-muted` 从 `#20201f`（32 32 31）
     * 改成 `--m-surface-0` = `--m-gray-900` = `11 11 11`。
     *
     * 这不是「调深一点」，是**层级方向变了**：Claude 的暗色里侧栏轨道比内容区
     * 更深（轨道 gray-900 → 画布 gray-850 → 卡片 gray-830 → 浮层 gray-800），
     * 而旧值把 muted 放在画布**上面**（更亮），方向是反的。
     * 亮色侧也是同一套对称关系（`--surface-muted` → `--m-gray-20`，比画布 gray-10 深）。 */
    "--surface-muted": ["11 11 11","--cds-surface-0","已知差异（矩阵已登记，理由见矩阵）"],
    "--surface-hover": ["#2c2c2a","--cds-fill-ghost-hover","已知差异（矩阵已登记，理由见矩阵）"],
    "--content": ["#f9f9f7","--cds-text-primary","已知差异（矩阵已登记，理由见矩阵）"],
    "--content-muted": ["#b4b3a8","--cds-text-secondary","已知差异（矩阵已登记，理由见矩阵）"],
    "--content-subtle": ["#97958d","--cds-text-muted","已知差异（矩阵已登记，理由见矩阵）"],
    "--edge": ["63 63 63","--cds-border","已知差异（矩阵已登记，理由见矩阵）"],
  },
};
/* 【UI 重建 2026-10-27】**三个半径的登记值换成真实计算值。**
 *
 * 矩阵里原来写 panel=10px / composer=20px / bubble≈12px，并在同一行注明了
 * 成因：「生成器把 `--cds-rem-scale` 钉为 1」——那是个**已知缺陷**。
 * 现在 `gen-cds-tokens.mjs` 已按本机 Claude 产物产出 `rem-scale = 16/17`，
 * 所以真实值是：
 *
 *   panel    = .625rem  × 16/17 = 9.4118px
 *   composer = .875rem  × 16/17 = 13.1765px
 *   bubble   = 8px + .25rem × 16/17 = 11.7647px
 *
 * ⚠️ 这不是「向实现低头」—— 是**矩阵的旧数字建立在被修掉的前提上**。
 * 上游 Claude 的 panel radius 就是 .625rem，乘上它自己的 rem-scale 得到 9.41px。
 * 「10px」是 rem-scale 被钉成 1 时的产物。
 *
 * 判据侧同时补了 `evalLength`（见 `normalized`）：原来只认 `Npx`/`Nrem`，
 * 读不懂 `calc(.625rem * calc(16 / 17))`，于是这 3 个 token × 57 格
 * 全部报「未登记差异」—— 那是**判据看不懂写法**，不是值不对。 */
const geometry = {
  "--radius-panel":["9.4118px","--cds-panel-radius","一致"],
  "--composer-radius":["13.1765px","--cds-radius-composer","一致"],
  "--radius-bubble":["11.7647px","--cds-message-bubble-radius","一致"],
  "--radius-control":["4px","--radius-sm","一致"],
  "--radius-btn-xs":["6px","--cds-radius-btn-xs","一致"],
  "--radius-btn-md":["8px","--cds-radius-btn-md","一致"],
  "--radius-dialog":["16px","--cds-radius-dialog","一致"],
  "--radius-code":["12px","--cds-radius-code","一致"],
};
const motion = {
  "--dur-fast":["60ms","60ms","一致"],
  "--dur-snap":["120ms","120ms","一致"],
  "--dur-base":["200ms","200ms","一致"],
  "--dur-sheet":["300ms","300ms","一致"],
  "--dur-slow":["450ms","450ms","一致"],
  "--ease-out":["cubic-bezier(0,0,.2,1)","--cds-ease-out","已知差异（矩阵已登记，理由见矩阵）"],
  "--ease-snap":["cubic-bezier(.32,.72,0,1)","--cds-ease-snap","一致"],
  "--ease-overshoot":["cubic-bezier(.34,1.3,.64,1)","--cds-ease-overshoot","一致"],
};

// 【T149】正文排版：根 token 表看不到 `.chat-md` 的**计算值**。
//
// `--chat-md-leading` / `--chat-font-size` 是变量，但变量被谁读、读到多高，
// 只有 `measured` 知道。而这个文件此前**只比 `snapshot.tokens`**，从不读
// `measured` —— 于是任何正文排版改动（字号、行高、字重）在输出里都不可见。
//
// T147 是最直接的证据：行高 21.75px → 24.375px，PNG 变了、diff.md 一个字段没变。
//
// 这里登记的是**期望的计算值**，不是 token 值。改动正文排版时同步改这里；
// 改了而不同步，会出现「未登记差异」—— 那是想要的行为（它拦住了静默变化）。
const measuredChecks = {
  /* 【UI 重建 2026-10-27】正文排版换成 Claude 的真值。
   *
   * 原登记：15px / 24.375px（= 15 × 1.625），依据上游
   * `ChatMessageBubbles.tsx:361` 的 `text-[15px] leading-relaxed`。
   *
   * 现在：**13.176px / 18.8232px** —— 本机 Claude **3.6556.2.0** 的
   * `.epitaxy-root .epitaxy-transcript-typography`：
   *
   *   --chat-body:    calc(.875rem * var(--cds-rem-scale,1));   → 13.176px
   *   --chat-leading: 1.4286;
   *   font-size:      var(--chat-body);
   *   line-height:    var(--chat-leading);
   *
   * ## 为什么不是 12.24 / 18.82（上一版登记值）
   *
   * 上一版有两处错，而且**互相抵消**，所以行高看起来对：
   *
   *   | | 字号 | × 行高比 | = 行高 |
   *   |---|---|---|---|
   *   | 上一版 | 12.24（基础层 body） | 1.5378（= 18.82/12.24） | 18.82 |
   *   | **正确** | **13.176（comfortable 层 body）** | **1.4286（--chat-leading）** | **18.82** |
   *
   * 两个因子各错 7%，乘起来一样。**行高一致不能证明字号正确** —— 这是
   * CLAUDE.md 第二十八条「代理指标」的镜像：乘积相同 ≠ 因子相同。
   *
   * 依据：`tools/claude-ui-reverse/tokens-out.txt`（comfortable 层 body = 13.176）
   * + 上游 CSS 里 `--chat-leading:1.4286` 的**消费点**
   * （`line-height:var(--chat-leading,var(--cds-leading-body))`）。
   *
   * ⚠️ 这一格是**判据能看见正文排版**的唯一途径（T149）。改字号/行高必须
   * 同步改这里 —— 不同步就会报「未登记差异」，那是想要的拦截。
   * 这次就是被它拦住的：改完 styles.css 之后 9 格报 `13.176px ≠ 12.24px`。 */
  "chat-body": {
    fontSize: "13.176px",
    lineHeight: "18.8232px",
  },
};
/**
 * 求值 `calc()` / `Npx` / `Nrem` 表达式，返回像素数字；求不出返回 null。
 *
 * 【UI 重建 2026-10-27】**这是个判据能力问题，不是数字变了。**
 * 半径 token 现在写成 `calc(.625rem * calc(16 / 17))`（Claude 的 rem-scale
 * 体系），而旧版 `normalized()` 只认 `Npx` / `Nrem`，外加一条写死的
 * `calc(8px + calc(.25rem * 1))` 特例。于是 205 条「未登记差异」全部来自
 * **判据读不懂被测值的写法** —— token 本身是对的（.625rem × 16/17 ≈ 10px，
 * 与矩阵登记的 10px 完全一致）。
 *
 * 只支持 px / rem / 数字 / 四则运算 / 括号 / 嵌套 calc。**遇到认不出的单位
 * （%、em、vw）返回 null**，让调用方按「无法比较」处理 —— 不猜。
 */
function evalLength(s) {
  if (!s) return null;
  let e = String(s).trim().replace(/\s+/g, "");
  /* ⚠️ 只剥「包住整个表达式」的那层 calc 是不够的：内层的 `calc(16 / 17)`
   * 夹在乘法中间，`wrapsAll` 判 false 就停了，整个表达式求不出值。
   * 所以剥完外层之后，把剩下所有 `calc(` 一律换成 `(` —— **`(` 与 `calc(` 在
   * 纯四则运算里语义相同**，这里没有 `min()` / `clamp()` 之类的成员，所以安全。 */
  const outer = /^calc\((.*)\)$/i.exec(e);
  if (outer) e = outer[1];
  e = e.replace(/calc\(/gi, "(");
  // 颜色三元组（`252 252 251`）没有运算符，不能当算式求值 —— 否则会算成 252252251。
  if (!/[()+\-*/]/.test(e)) {
    const single = /^(\d*\.?\d+)(px|rem)?$/i.exec(e);
    if (!single) return null;
    return /^rem$/i.test(single[2] ?? "") ? Number(single[1]) * 16 : Number(single[1]);
  }
  // 词法：数字(带单位) 或 运算符/括号。有认不出的字符就放弃。
  const toks = e.match(/(\d*\.?\d+)(px|rem)?|[()+\-*/]|[a-z%]+/gi);
  if (!toks || toks.join("") !== e) return null;
  if (toks.some((t) => /^[a-z%]+$/i.test(t) && !/^(px|rem)$/i.test(t))) return null;
  let p = 0;
  function factor() {
    const t = toks[p];
    if (t === undefined) return null;
    if (t === "(") { p++; const v = expr(); if (toks[p] !== ")") return null; p++; return v; }
    const n = /^(\d*\.?\d+)(px|rem)?$/i.exec(t);
    if (!n) return null;
    p++;
    return /^rem$/i.test(n[2] ?? "") ? Number(n[1]) * 16 : Number(n[1]);
  }
  function term() {
    let v = factor();
    while (v !== null && (toks[p] === "*" || toks[p] === "/")) {
      const op = toks[p++]; const r = factor();
      if (r === null) return null;
      if (op === "/" && r === 0) return null;
      v = op === "*" ? v * r : v / r;
    }
    return v;
  }
  function expr() {
    let v = term();
    while (v !== null && (toks[p] === "+" || toks[p] === "-")) {
      const op = toks[p++]; const r = term();
      if (r === null) return null;
      v = op === "+" ? v + r : v - r;
    }
    return v;
  }
  const out = expr();
  return out !== null && p === toks.length ? out : null;
}

function normalized(v) {
  const s = String(v ?? "").trim().replace(/\s+/g, "");
  // 长度类先统一求值成像素（含 calc / rem / px）。求不出才走颜色/原串。
  if (/^(calc\(|[\d.]+(px|rem)$)/i.test(s)) {
    const px = evalLength(s);
    if (px !== null) return px.toFixed(4) + "px";
  }
  // 低版本没有 calc 包装的裸 rem/px 也走同一条路（保留原行为）
  const rem = s.match(/^([\d.]+)rem$/);
  if (rem) return (Number(rem[1]) * 16) + "px";
  return normalizeColor(v).replace(/0\.(\d+)/g,'.$1').replace(/\s/g,'').toLowerCase();
}
const manifest = JSON.parse(readFileSync(join(evidence,"manifest.json"),"utf8"));
// 【T141】期望格数从 probe.ts 写的 expected.json 读，不在这里写死。
// 以前是 `!== 39`，而场景加到 51 之后它必然抛错 —— 门禁从此一次都没跑成。
const expectedCells = JSON.parse(readFileSync(join(evidence,"expected.json"),"utf8")).cells;
if (!Number.isInteger(expectedCells)) throw Error("expected.json is missing a numeric cells field");
if (manifest.length !== expectedCells) throw Error(`${expectedCells} grid cells required; got ${manifest.length}`);
const fileRows=[];
let unknown=0, known=0, equal=0, missing=0;
const seen=new Set();
for(const row of manifest) {
  if(seen.has(row.file)) throw Error("Duplicate snapshot "+row.file);
  seen.add(row.file);
  const path=join(evidence,row.file+".json");
  if(!existsSync(path)) throw Error("Missing JSON / data-missing marker: "+row.file);
  const sample=JSON.parse(readFileSync(path,"utf8"));
  const mode=row.condition==="dark"?"dark":"light";
  const state=row.status==="CAPTURED"?"实拍":"data-missing: "+(sample["data-missing"]||row.reason||"未说明");
  if (row.status==="DATA_MISSING") missing++;
  fileRows.push(`| ${row.title} | ${row.condition} | ${state.replaceAll("|","/")} | ${sample.snapshot?.viewport?.width ?? "无"}×${sample.snapshot?.viewport?.height ?? "无"} |`);
  for(const [key,[reference,upstreamVar,judgment]] of Object.entries({...expected[mode],...geometry,...motion})) {
    // Geometry: the workspace shell can intentionally override composer radius
    // (documented in §十一). Only the token at root is checked here.
    const actual=sample.snapshot?.tokens?.[key];
    if (!actual) {
      // Matrix marks missing roles as known gaps. Report the absence, do not
      // invent a "computed" value or a comparison from an absent variable.
      fileRows.push(`| ↳ ${key} | ${row.condition} | data-missing: 未定义计算样式 | — |`);
      continue;
    }
    const upstreamValue=upstreamVar.startsWith("--")?fromUpstream(upstreamVar,mode):upstreamVar;
    const agree=normalized(actual)===normalized(reference);
    const verdict=agree?judgment:"未登记差异";
    if(!agree)unknown++;else if(judgment.startsWith("已知"))known++;else equal++;
    fileRows.push(`| ↳ ${key} | Mcode=${actual.replaceAll("|","/")} | 上游=${upstreamValue.replaceAll("|","/")}；矩阵判定=${judgment}；实测=${agree?"与矩阵登记相符":"偏离矩阵登记 "+reference} | ${verdict} |`);
  }

  // 【T149】正文排版：比 `snapshot.measured` 里 `.chat-md` 的**计算值**。
  //
  // 「没量到」和「量到了但没问题」必须分得开：场景里没有正文（空态/设置页/
  // 纯面板）时选择器落空，这里**显式写 present: false**，计入 known 而不是
  // 静默跳过 —— 否则「一半格子没量」会看起来和「全都对」一模一样。
  const measured = Array.isArray(sample.snapshot?.measured) ? sample.snapshot.measured : [];
  for (const [name, want] of Object.entries(measuredChecks)) {
    const hit = measured.find((m) => m?.name === name);
    if (!hit) {
      unknown++;
      fileRows.push(`| ↳ measured:${name} | ${row.condition} | 探针未产出这一项 | 未登记差异 |`);
      continue;
    }
    if (!hit.present) {
      // 显式缺席：该场景本来就没有正文。不算差异，但要在表里看得见。
      known++;
      fileRows.push(`| ↳ measured:${name} | ${row.condition} | 本场景无正文（present=false）| 已知（场景不适用）|`);
      continue;
    }
    for (const [field, expectedValue] of Object.entries(want)) {
      const actualValue = hit[field];
      /* 【UI 重建 2026-10-27】**像素类字段用容差比，不用字符串相等。**
       *
       * 浏览器的 `lineHeight` 计算值是舍入后的浮点数：12.24 × 1.5378 = 18.8227，
       * 而登记的期望是 18.82（三位小数）。字符串相等会把 0.0027px 的差别
       * 报成「未登记差异」—— 那不是值错了，是**判据把舍入当成了变化**。
       *
       * 容差取 0.01px：比任何有意义的排版变化小两个数量级（最小的一档
       * 字号差是 0.5px），又足以吸收浏览器的小数舍入。
       * 非像素字段（颜色、圆角等）仍然走字符串相等。 */
      const ok = String(actualValue ?? "").trim() === expectedValue ||
        (() => {
          const a = /^(-?[\d.]+)px$/.exec(String(actualValue ?? "").trim());
          const b = /^(-?[\d.]+)px$/.exec(String(expectedValue).trim());
          return a !== null && b !== null && Math.abs(Number(a[1]) - Number(b[1])) <= 0.01;
        })();
      if (!ok) unknown++; else equal++;
      fileRows.push(`| ↳ measured:${name}.${field} | Mcode=${String(actualValue ?? "(缺失)").replaceAll("|","/")} | 期望=${expectedValue} | ${ok ? "一致" : "未登记差异"} |`);
    }
  }
}
const lines=[
 "# ARC-005 V4：Electron 计算样式逐项比对",
 "",
 /* 【UI 重建 2026-10-27】标题原来写「上游为 open-claude-ui/...（第三方逆向产物）」——
  * 那句话与代码**自相矛盾**：`findClaudeCss()` 读的是本机安装的 Claude
  * 3.1623.4.0，而 open-claude-ui 目录已经删了。**读报告的人只会看标题**，
  * 会以为这次比对还是拿第三方 2.x 的逆向当基准 —— 那是错的，而且会让
  * 「比对通过」这件事看起来不可信。 */
 "参考：docs/design/claude-code-reference-matrix.md §二/四/五；上游为本机安装的 Claude Desktop（`ion-dist/assets/v1/*.css`，由 `findClaudeCss()` 现场定位；找不到会显式失败）。第三方 `open-claude-ui` 已删除，不再作为基准。",
 "仅判上述已经登记的 surface/content/edge、圆角、动效；差异按矩阵原有判断，不以像素等值代替语义关系。",
 "root token 与窗口实际可见元素的 getComputedStyle 分别存于同名 JSON：snapshot.tokens 和 snapshot.measured（含尺寸、字号、行高、背景、颜色、圆角、padding）。",
 "【T149】正文排版另比对 `measured`：`chat-body` 取 `.chat-md` 的**计算值**（字号/行高）。root token 表看不到它 —— `--chat-md-leading` 是变量，被谁读、读到多高只有计算值知道。本场景没有正文时显式记 present=false。",
 "",
 `总格数：${expectedCells}；有图：${manifest.length-missing}；data-missing：${missing}。比较条目：一致 ${equal}、已知差异 ${known}、未登记差异 ${unknown}。`,
 "",
 "| 屏幕 / token | 条件或 Mcode 实测 | 上游值 / 矩阵判定 / 本次实测 | 结论 |",
 "|---|---|---|---|",
 ...fileRows,
 "",
 "### 取证限制",
 "",
 "- 只表示 Mcode 隔离真 Electron 中的计算样式。Claude Desktop 用户安装版本没有对应截图，不能宣称视觉逐屏一致。",
 "- data-missing 行未拍图；该格仅保留采样、探针原因与未覆盖条件。不会以其他状态截图替代。",
 "- 暗色 edge 若后续 token 表登记值变更，必须先复核矩阵，再修改比较器的登记期望。",
];
writeFileSync(output,lines.join("\n")+"\n");
console.log(JSON.stringify({output,grid:manifest.length,expected:expectedCells,captured:manifest.length-missing,missing,equal,known,unregistered:unknown}));
if(unknown) process.exitCode=2;
