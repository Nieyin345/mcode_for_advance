/**
 * 【O6】Sheets 换壳 —— 真 Electron 双模式判据（启动器）。
 *
 * ## 这一套回答的问题
 *
 * 「宿主里的 HTML 编辑器，chrome 真的换成了 Mcode 的配色；而单独跑 GenOffice 时
 * 保持它自己的视觉。」—— O6 卡 3.1 的四条硬判据，**全部在真 Electron 里跑**。
 *
 * ## 为什么不能用「源码里有那行」当判据
 *
 * 0014（docs 的换壳）就栽在这里：它只断言源码里有 `if (window.desktop)`，而
 * `window.desktop` 是 docs 自己的 preload 命名空间，独立运行时也存在 —— 守卫对它
 * 声称要防的场景**根本没生效**，而套件是绿的（2026-10-24 真 Electron 实测）。
 * 所以本套件**让同一份构建产物跑两遍**，比较页面里真实发生了什么事。
 *
 * ## 开关的判据
 *
 * `main.tsx` 用 UA 里的 `app.getName()` 产品号（`/\bMcode\//`）。本启动器两次都挂
 * **原厂 preload**，只把 `app.setName()` 分别设成 `Mcode` 与 `GenOffice PDF` ——
 * 这正是宿主与独立运行两种真实形态，而 UA 的差异不可能来自 preload。
 *
 * ## 断言（两种模式各 4 条，再加 3 条跨模式/契约）
 *
 * 宿主模式（app 名 = Mcode）：
 *   1. `document.styleSheets` 里有 `mcode-theme-*.css`
 *   2. `--surface` 计算值 = #fcfcfb（Mcode 值），`--text` = #151515
 *   3. `.ribbon` 的 `background-color` 计算值 = rgb(252, 252, 251)
 *   4. 组件树在：`.ribbon` / `.app-main` / `.pane-preview` / `.status-bar`
 *
 * 独立模式（app 名 = GenOffice PDF）：
 *   5. `styleSheets` 里**没有** `mcode-theme`
 *   6. `--surface` = #ffffff（上游值），`--text` = #242424
 *   7. `.ribbon` 的 `background-color` = rgb(255, 255, 255)
 *   8. 组件树同样在（换壳没改结构，不换壳也没改）
 *
 * 跨模式 / 契约：
 *   9. 两次 UA 不同，且各自含自己的 app 名产品号（证明开关的前提成立）
 *  10. 文档内容底 `--preview-page-bg` 两次都是 #ffffff（预览 iframe 的底不许换）
 *  11. `main.tsx` 的开关是 UA 判据、**不是** `window.desktop`（剥注释后读源码）
 *
 * ## 产物缺失 = skip
 *
 * `genoffice/` 被 .gitignore 排除，没构建过时如实跳过（exit 0），不假装验过。
 */
import { existsSync, readdirSync, readFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(HERE, "../..");
const repoRoot = resolve(desktop, "../..");
const app = join(repoRoot, "genoffice/apps/sheets");
const rendererIndex = join(app, "out/renderer/index.html");
const preloadPath = join(app, "out/preload/index.js");
const mainSrc = join(app, "src/renderer/main.tsx");

if (!existsSync(rendererIndex) || !existsSync(preloadPath)) {
  console.log(`o6-reshell-sheets-smoke: skip（未构建：${rendererIndex}）`);
  console.log("  先构建：npx electron-vite build (in apps/sheets; 跳过 cargo)");
  process.exit(0);
}

// 四种模式：宿主/独立 × 亮/暗。暗色不是「顺手多跑一组」——GenOffice 的工具栏
// 在暗色下才是最容易露馅的地方，而亮色全绿、暗色没生效是这一族改动最常见的失败。
const MODES = [
  { appName: "Mcode", theme: "light" },
  { appName: "GenOffice Sheets", theme: "light" },
  { appName: "Mcode", theme: "dark" },
  { appName: "GenOffice Sheets", theme: "dark" },
];

let total = 0;
let failures = 0;
function check(name, cond, detail) {
  total++;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

/** 去掉 `/* *\/` 块注释与**整行** `//` 注释。
 *
 * 刻意不剥行尾 `//`：被测的那一行里有正则字面量 `/\bMcode\//`，其中的 `//`
 * 不是注释起点 —— 早先按「`//` 到行尾都是注释」剥，把真正的门控行整行吃掉了，
 * 断言因此假红（红的是取证工具，不是被测对象）。整行注释足以覆盖本仓库的写法。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

const pnpm = resolve(desktop, "../../node_modules/.pnpm");
void pnpm;
mkdirSync(join(desktop, ".tmp"), { recursive: true });
const dir = mkdtempSync(join(desktop, ".tmp/o6-reshell-sheets-"));

const require = createRequire(join(desktop, "package.json"));
const electron = require("electron");
if (typeof electron !== "string" || !existsSync(electron)) {
  throw Error("Existing installed Electron binary required; no download allowed");
}

const home = join(dir, "home");
const temp = join(dir, "temp");
mkdirSync(home, { recursive: true });
mkdirSync(temp, { recursive: true });

// 探针直接跑 vendor 自己的独立入口（见 probe.cjs 文件头）：没有构建步骤。
//
// Slides 不需要 fixture：`startSlidesStandalone()` 在没有 .pptx argv 时，渲染端会自己
// 调 `window.slidesApi.newBlank(FIT_WIDTH)` 开一份**空 deck**（App.tsx:1231），
// 外壳（ribbon / 缩略图栏 / 状态栏）照样渲染。PDF 不一样 —— 它的 ribbon 只在打开
// 文档后才出现，所以那套要造一份最小 PDF。
const appMain = join(app, "out/main/index.js");

const evidence = {};
for (const { appName, theme } of MODES) {
  const key = `${appName}-${theme}`;
  const env = {
    ...process.env,
    O6_DIR: dir,
    O6_APP_MAIN: appMain,
    O6_APP_NAME: appName,
    O6_THEME: theme,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(dir, `userData-${key.replace(/\s+/g, "-")}`),
    LOCALAPPDATA: join(dir, "localAppData"),
    TEMP: temp,
    TMP: temp,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(electron, [join(HERE, "probe.cjs")], {
    cwd: app,
    env,
    encoding: "utf8",
    timeout: 180000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const output = (run.stdout ?? "") + (run.stderr ?? "");
  writeFileSync(join(dir, `run-${key.replace(/\s+/g, "-")}.log`), output);
  if (run.status !== 0) {
    console.log(`  FAIL 探针在「${key}」模式下没跑完（exit=${run.status}）`);
    failures++;
    total++;
    console.log(output.split("\n").slice(-12).join("\n"));
    continue;
  }
  const file = join(dir, `evidence-${key.replace(/\s+/g, "-")}.json`);
  if (!existsSync(file)) {
    console.log(`  FAIL 探针在「${key}」模式下没有写出证据文件`);
    failures++;
    total++;
    continue;
  }
  evidence[key] = JSON.parse(readFileSync(file, "utf8"));
}

const hosted = evidence["Mcode-light"];
const standalone = evidence["GenOffice Sheets-light"];
const hostedDark = evidence["Mcode-dark"];
const standaloneDark = evidence["GenOffice Sheets-dark"];

if (!hosted || !standalone || !hostedDark || !standaloneDark) {
  console.log(
    `\no6-reshell-sheets-smoke: ${total - failures}/${total}（四种模式证据不齐，后续断言全部无法执行）`,
  );
  process.exit(1);
}

const H = hosted.evidence;
const S = standalone.evidence;
const HD = hostedDark.evidence;
const SD = standaloneDark.evidence;

/* ── 宿主要求的四种模式都真的走到了预期的明暗 ──────────────────────── */
console.log("\n暗色是否真的生效（先验前提，再验换壳）");
check(
  "★ 前提：独立模式暗色下 --surface = 上游暗色 #1e1e1e（nativeTheme 真的传导了）",
  SD.tokens.surface === "#1e1e1e",
  { dark: SD.tokens.surface, light: S.tokens.surface },
);
check(
  "★ 前提：四种模式下两两不同（亮≠暗，否则暗色断言是空的）",
  H.tokens.surface !== HD.tokens.surface && S.tokens.surface !== SD.tokens.surface,
  {
    hostedLight: H.tokens.surface,
    hostedDark: HD.tokens.surface,
    standaloneLight: S.tokens.surface,
    standaloneDark: SD.tokens.surface,
  },
);

/* ── 宿主模式 ─────────────────────────────────────────────────────────── */
console.log("\n宿主模式（app 名 = Mcode）");
check("mcode-theme.css 被加载", H.mcodeSheets.length === 1, H.mcodeSheets);
check("--surface = Mcode 值 #fcfcfb", H.tokens.surface === "#fcfcfb", H.tokens.surface);
check("--text = Mcode 值 #151515", H.tokens.text === "#151515", H.tokens.text);
check("--border = Mcode 值 #e1e0d9", H.tokens.border === "#e1e0d9", H.tokens.border);
check(
  ".ribbon 计算背景 = Mcode --surface rgb(252, 252, 251)",
  H.computedBg.ribbon === "rgb(252, 252, 251)",
  H.computedBg.ribbon,
);
check("--gs-font-sans 首项 = -apple-system（不是 Arial）",
  H.tokens.gsFontSans === "-apple-system", H.tokens.gsFontSans);
check(
  // sheets 没有 .app 容器（ExcelShell 直接渲染 .ribbon + .sheet-body）；
  // 核心 DOM 用 ribbon + 网格容器 + 状态栏 + 名字框那排按钮。
  "组件树没变：.ribbon / #univer-container / .status-bar / .qa-btn 都在",
  H.present[".ribbon"] && H.present["#univer-container"] && H.present[".status-bar"] && H.present[".qa-btn"],
  H.present,
);

/* ── 独立模式 ─────────────────────────────────────────────────────────── */
console.log("\n独立模式（app 名 = GenOffice PDF，无宿主）");
check("mcode-theme.css **没有**被加载（不换壳）", S.mcodeSheets.length === 0, S.mcodeSheets);
check("--surface = 上游值 #ffffff", S.tokens.surface === "#ffffff", S.tokens.surface);
check("--text = 上游值 #242424", S.tokens.text === "#242424", S.tokens.text);
check(
  ".ribbon 计算背景 = 上游 --surface rgb(255, 255, 255)",
  S.computedBg.ribbon === "rgb(255, 255, 255)",
  S.computedBg.ribbon,
);
check("--gs-font-sans 仍是上游 Arial 打头", /^'?Arial/i.test(S.tokens.gsFontSans), S.tokens.gsFontSans);
check(
  "组件树同样在（换壳不改结构）",
  S.present[".ribbon"] && S.present["#univer-container"] && S.present[".status-bar"] && S.present[".qa-btn"],
  S.present,
);

/* ── 暗色：宿主换壳 / 独立不换壳 ──────────────────────────────────────── */
console.log("\n暗色（宿主换壳 / 独立不换壳）");
check("宿主暗色：mcode-theme.css 被加载", HD.mcodeSheets.length === 1, HD.mcodeSheets);
check("宿主暗色：--surface = Mcode 暗色值 #151515", HD.tokens.surface === "#151515", HD.tokens.surface);
check("宿主暗色：--text = Mcode 暗色值 #f9f9f7", HD.tokens.text === "#f9f9f7", HD.tokens.text);
check(
  // PDF 的 ribbon 用 --chrome-bg（styles.css:204），不是 --surface —— 断言要跟着
  // 被测对象实际读的 token 走，否则红的是断言不是代码。
  // sheets 的 .ribbon 用 --surface（styles.css 的 .ribbon 规则），不像 pdf/slides 用 --chrome-bg。
  "宿主暗色：.ribbon 计算背景 = Mcode 暗色 --surface rgb(21, 21, 21)",
  HD.computedBg.ribbon === "rgb(21, 21, 21)",
  HD.computedBg.ribbon,
);
check("独立暗色：mcode-theme.css **没有**被加载", SD.mcodeSheets.length === 0, SD.mcodeSheets);
check("独立暗色：--text = 上游暗色 #e4e4e4", SD.tokens.text === "#e4e4e4", SD.tokens.text);
check(
  "独立暗色：.ribbon 计算背景 = 上游暗色 --surface rgb(30, 30, 30)",
  SD.computedBg.ribbon === "rgb(30, 30, 30)",
  SD.computedBg.ribbon,
);
check(
  "★ 对照：宿主暗色的 .ribbon **不等于**独立暗色（暗色下也真的换了壳）",
  HD.computedBg.ribbon !== SD.computedBg.ribbon,
  { hosted: HD.computedBg.ribbon, standalone: SD.computedBg.ribbon },
);
check(
  "★ 暗色下单元格纸张 --sheets-paper 仍是上游 #ffffff（纸张是内容，且它不在覆盖集里）",
  HD.paperToken === SD.paperToken && SD.paperToken === "#ffffff",
  { hosted: HD.paperToken, standalone: SD.paperToken },
);

/* ── 跨模式 / 契约 ────────────────────────────────────────────────────── */
console.log("\n跨模式与源码契约");
check(
  "两次 UA 不同，且各自含自己的 app 名产品号（开关前提成立）",
  H.ua !== S.ua && /\bMcode\//.test(H.ua) && /\bGenOfficeSheets\//.test(S.ua),
  { hosted: H.ua, standalone: S.ua },
);
check(
  "★ 单元格纸张 --sheets-paper 两次都是上游 #ffffff（纸张是文档内容）",
  H.paperToken === S.paperToken && S.paperToken === "#ffffff",
  { hosted: H.paperToken, standalone: S.paperToken },
);

const mainText = stripComments(readFileSync(mainSrc, "utf8"));
// 判据写成「普通子串 + 反例」，不用正则：正则里的 `/` 转义在 JS 字符串与正则字面量
// 之间折两次，曾经让这条断言本身编译失败（不是被测对象失败）。
const GATE_FRAGMENT = "test(navigator.userAgent)) import('./mcode-theme.css')";
const gateLine = mainText.split("\n").find((l) => l.includes("mcode-theme.css") && l.includes("import("));
check(
  "main.tsx 的开关是 UA 判据（含 Mcode 产品号），且不是 window.desktop",
  gateLine !== undefined &&
    gateLine.includes("navigator.userAgent") &&
    gateLine.includes("Mcode") &&
    gateLine.includes(GATE_FRAGMENT) &&
    // ⚠️ 不能用 includes("window.desktop")：sheets 的 preload 暴露的是
    // `window.desktopApi`，子串匹配会把它误判成 docs 那个 `window.desktop`。
    // 按**单词边界**判断：`window.desktop` 后面不能紧跟标识符字符。
    !/window\.desktop(?!\w)/.test(mainText),
  { gateLine, mentionsDesktop: /window\.desktop(?!\w)/.test(mainText) },
);

/* ── 边界：不碰文档内容 / 语义色 / 品牌色 ────────────────────────────── */
console.log("\n边界（主题层内容）");
const themeSrc = stripComments(readFileSync(join(app, "src/renderer/mcode-theme.css"), "utf8"));
const rawColorLines = themeSrc
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\(/.test(l))
  .filter((l) => !/^--[\w-]+\s*:/.test(l));
check("主题层没有在规则里内联裸色值（GenOffice CI 的硬规则）", rawColorLines.length === 0, rawColorLines.slice(0, 3));
check("不覆盖 --accent 家族（各 app 的品牌色）", !/--accent(-dark|-soft)?\s*:/.test(themeSrc));
check("不覆盖 --word-blue", !/--word-blue\s*:/.test(themeSrc));
check("不覆盖 --sheets-paper（单元格纸张是文档内容）", !/--sheets-paper\s*:/.test(themeSrc));
check("不覆盖 --sheets-chart-* 与 --chart-*（图表配色与标签是文档数据）",
  !/--sheets-chart-[\w-]+\s*:/.test(themeSrc) && !/--chart-[\w-]+\s*:/.test(themeSrc));
check("不覆盖 --sheets-pie-label-*（饼图标签）", !/--sheets-pie-label-[\w-]+\s*:/.test(themeSrc));
check("不覆盖 --sheets-shape-*（形状填充/描边是文档内容）",
  !/--sheets-shape-[\w-]+\s*:/.test(themeSrc));
check("不覆盖 --sheets-excel-blue / --excel-green*（Excel 的语义蓝/绿）",
  !/--sheets-excel-[\w-]+\s*:/.test(themeSrc) && !/--excel-green[\w-]*\s*:/.test(themeSrc));
check("不覆盖 --sheets-content-danger / --sheets-validation-*（内容危险态与数据验证提示）",
  !/--sheets-content-danger\s*:/.test(themeSrc) && !/--sheets-validation-[\w-]+\s*:/.test(themeSrc));
check("不覆盖 --univer-primary-600（Univer 自己的主题色）", !/--univer-[\w-]+\s*:/.test(themeSrc));
check("不覆盖 --sheets-statusbar-* / --sheets-scroll-thumb / --sheets-focus-ring / --sheets-shadow-*"
  + "（app 私有 chrome：chrome 一致性靠共享层，规则 A）",
  !/--sheets-statusbar-[\w-]+\s*:/.test(themeSrc) &&
    !/--sheets-scroll-thumb\s*:/.test(themeSrc) &&
    !/--sheets-focus-ring[\w-]*\s*:/.test(themeSrc) &&
    !/--sheets-shadow-[\w-]+\s*:/.test(themeSrc));
check("不覆盖 --search-hit-* 与 --docs-revision-bar（文档语义标记）",
  !/--search-hit[\w-]*\s*:/.test(themeSrc) && !/--docs-revision-bar\s*:/.test(themeSrc));

/* ── ★ 通用规则：覆盖的每个 token 必须来自共享 token 层 ───────────────────
 *
 * 「换壳 = 换共享 token，app 私有 token 一律不动。」这条比「覆盖 54 个 chrome token」
 * 更准确 —— 它解释了**为什么是这 54 个**：不是因为它们看起来像 chrome，是因为它们
 * 在共享层里。app 私有的 chrome 色（`--sheets-statusbar-bg` 等）改了会让 pdf 和另外五家
 * 的菜单/状态栏分家，而一致性只能靠共享层保证。
 *
 * 反例（docs 的 0014）：它的 `--docs-statusbar-bg: #f3f4f6` 在换壳后**仍是原值** ——
 * 已经发生的事情与这条规则一致。
 */
const tokensCssPath = join(repoRoot, "genoffice/packages/ui/src/tokens.css");
const tokensSrc = stripComments(readFileSync(tokensCssPath, "utf8"));
const sharedNames = new Set(
  [...tokensSrc.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((m) => m[1]),
);
// 一条 token 会在亮色 / 暗色 / system-dark 三块里各声明一次，所以「声明行数」约是
// 「不同 token 数」的三倍。两个数都是真的，但报出去时必须说清单位 ——
// 「覆盖了 152 个 token」在共享层只有 65 个的前提下是不可能的事，
// 而一个不可能的数字会被仔细的人当 bug 查、被不仔细的人当「覆盖面很广」。
const overriddenNames = [...themeSrc.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((m) => m[1]);
const overriddenUnique = [...new Set(overriddenNames)];
const privateOnes = overriddenNames.filter((name) => !sharedNames.has(name));

// ★ 正控：解析确实拿到了 token。没有它，正则一旦失效 → 空数组 →
// 下面那条 `privateOnes.length === 0` 恒真（「从不报」的判据是最危险的形态）。
// 取 40 不钉 54：上游增删 token 时这条不该无辜变红，但「误删一大半」必须红。
check(
  `★ 正控：确实解析到了被覆盖的 token（${overriddenUnique.length} 个，要求 ≥ 40）`,
  overriddenUnique.length >= 40,
  overriddenUnique.slice(0, 5),
);
check(
  `覆盖的每个 token 都来自 tokens.css（共享层 ${sharedNames.size} 个；本文件覆盖 ${overriddenUnique.length} 个不同 token / ${overriddenNames.length} 条声明：亮+暗+system-dark）`,
  privateOnes.length === 0,
  privateOnes.slice(0, 8),
);

/* ── ★ 覆盖集里「本 app 不消费」的 token（如实记账，不是缺陷） ──────────
 *
 * 覆盖集是**跨六家统一的 54 个** —— 同一套值才让 chrome 看起来是同一个产品。
 * 代价是某个 app 可能不读其中几个。sheets 的例子：`--chrome-bg` 在本 app 的
 * renderer CSS 与共享 UI CSS 里**零消费者**（pdf/slides 的 ribbon 读它，sheets 的读
 * `--surface`）。覆盖它无害但无用；不覆盖它会让覆盖集与另外五家分叉。
 *
 * 这条断言**不判对错**，只把事实打印出来，并钉住「无消费者的数量不会悄悄涨」——
 * 涨了说明覆盖集里混进了本 app 根本用不到的东西，那时该问的是「是不是抄错了集」。
 */
const rendererCss = ["styles.css", "markdown-themes.css"]
  .map((f) => {
    const path = join(app, "src/renderer", f);
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  })
  .join("\n");
const sharedUiCss = readdirSync(join(repoRoot, "genoffice/packages/ui/src"))
  .filter((f) => f.endsWith(".css") && f !== "tokens.css")
  .map((f) => readFileSync(join(repoRoot, "genoffice/packages/ui/src", f), "utf8"))
  .join("\n");
const consumed = new Set(
  [...(rendererCss + sharedUiCss).matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]),
);
const unconsumed = overriddenUnique.filter((name) => !consumed.has(name));
console.log(
  `
覆盖集里本 app 不消费的 token（${unconsumed.length}）: ${unconsumed.join(" ") || "(无)"}`,
);
check(
  `★ 覆盖集里「本 app 零消费者」的 token 不超过 20 个（现 ${unconsumed.length}：${unconsumed.slice(0, 6).join(" ")}${unconsumed.length > 6 ? " …" : ""}）`,
  unconsumed.length <= 20,
  unconsumed,
);

// NOT-COVERED 前缀让「这条线还差什么」能被 grep 汇总 —— 自由文本的「我没验 X」
// 三个月后没人找得到。
console.log(
  "NOT-COVERED: sheets 网格（Univer canvas）的明暗 —— 本套件只验 CSS chrome；" +
    "网格由上游 darkMode 布尔驱动（App.tsx:1736 注释明说它不吃 CSS token），" +
    "那是文档内容、不属换壳范围（读代码得出，非实测）",
);

console.log(`\no6-reshell-sheets-smoke: ${total - failures}/${total} 通过`);
console.log(`  证据目录：${dir}`);
process.exit(failures === 0 ? 0 : 1);
