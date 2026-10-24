/**
 * 【O6】HTML 换壳 —— 真 Electron 双模式判据（启动器）。
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
 * **原厂 preload**，只把 `app.setName()` 分别设成 `Mcode` 与 `GenOffice HTML` ——
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
 * 独立模式（app 名 = GenOffice HTML）：
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
const app = join(repoRoot, "genoffice/apps/html");
const rendererIndex = join(app, "out/renderer/index.html");
const preloadPath = join(app, "out/preload/index.js");
const mainSrc = join(app, "src/renderer/main.tsx");

if (!existsSync(rendererIndex) || !existsSync(preloadPath)) {
  console.log(`o6-reshell-html-smoke: skip（未构建：${rendererIndex}）`);
  console.log("  先构建：npm run build -w @genoffice/html");
  process.exit(0);
}

const MODES = ["Mcode", "GenOffice HTML"];

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
const dir = mkdtempSync(join(desktop, ".tmp/o6-reshell-html-"));

const require = createRequire(join(desktop, "package.json"));
const electron = require("electron");
if (typeof electron !== "string" || !existsSync(electron)) {
  throw Error("Existing installed Electron binary required; no download allowed");
}

const home = join(dir, "home");
const temp = join(dir, "temp");
mkdirSync(home, { recursive: true });
mkdirSync(temp, { recursive: true });

// 探针直接跑 vendor 自己的独立入口（见 probe.cjs 文件头）：没有构建步骤 ——
// 它不 import 任何 vendor 源码模块，因此不需要 esbuild，也不会把 html2docx 的
// 浏览器 bundle 拖进来。
const appMain = join(app, "out/main/index.js");

const evidence = {};
for (const appName of MODES) {
  const env = {
    ...process.env,
    O6_DIR: dir,
    O6_APP_MAIN: appMain,
    O6_APP_NAME: appName,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(dir, `userData-${appName.replace(/\s+/g, "-")}`),
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
  writeFileSync(join(dir, `run-${appName.replace(/\s+/g, "-")}.log`), output);
  if (run.status !== 0) {
    console.log(`  FAIL 探针在「${appName}」模式下没跑完（exit=${run.status}）`);
    failures++;
    total++;
    console.log(output.split("\n").slice(-12).join("\n"));
    continue;
  }
  const file = join(dir, `evidence-${appName.replace(/\s+/g, "-")}.json`);
  if (!existsSync(file)) {
    console.log(`  FAIL 探针在「${appName}」模式下没有写出证据文件`);
    failures++;
    total++;
    continue;
  }
  evidence[appName] = JSON.parse(readFileSync(file, "utf8"));
}

const hosted = evidence["Mcode"];
const standalone = evidence["GenOffice HTML"];

if (!hosted || !standalone) {
  console.log(`\no6-reshell-html-smoke: ${total - failures}/${total}（两模式证据不齐，后续断言全部无法执行）`);
  process.exit(1);
}

const H = hosted.evidence;
const S = standalone.evidence;

/* ── 宿主模式 ─────────────────────────────────────────────────────────── */
console.log("\n宿主模式（app 名 = Mcode）");
check("mcode-theme.css 被加载", H.mcodeSheets.length === 1, H.mcodeSheets);
check("--surface = Mcode 值 #fcfcfb", H.tokens.surface === "#fcfcfb", H.tokens.surface);
check("--text = Mcode 值 #151515", H.tokens.text === "#151515", H.tokens.text);
check("--border = Mcode 值 #e1e0d9", H.tokens.border === "#e1e0d9", H.tokens.border);
check(
  ".ribbon 计算背景 = Mcode 表面 rgb(252, 252, 251)",
  H.computedBg.ribbon === "rgb(252, 252, 251)",
  H.computedBg.ribbon,
);
check("--gs-font-sans 首项 = -apple-system（不是 Arial）",
  H.tokens.gsFontSans === "-apple-system", H.tokens.gsFontSans);
check(
  "组件树没变：.ribbon / .app-main / .pane-preview / .status-bar 都在",
  H.present[".ribbon"] && H.present[".app-main"] && H.present[".pane-preview"] && H.present[".status-bar"],
  H.present,
);

/* ── 独立模式 ─────────────────────────────────────────────────────────── */
console.log("\n独立模式（app 名 = GenOffice HTML，无宿主）");
check("mcode-theme.css **没有**被加载（不换壳）", S.mcodeSheets.length === 0, S.mcodeSheets);
check("--surface = 上游值 #ffffff", S.tokens.surface === "#ffffff", S.tokens.surface);
check("--text = 上游值 #242424", S.tokens.text === "#242424", S.tokens.text);
check(
  ".ribbon 计算背景 = 上游表面 rgb(255, 255, 255)",
  S.computedBg.ribbon === "rgb(255, 255, 255)",
  S.computedBg.ribbon,
);
check("--gs-font-sans 仍是上游 Arial 打头", /^'?Arial/i.test(S.tokens.gsFontSans), S.tokens.gsFontSans);
check(
  "组件树同样在（换壳不改结构）",
  S.present[".ribbon"] && S.present[".app-main"] && S.present[".pane-preview"] && S.present[".status-bar"],
  S.present,
);

/* ── 跨模式 / 契约 ────────────────────────────────────────────────────── */
console.log("\n跨模式与源码契约");
check(
  "两次 UA 不同，且各自含自己的 app 名产品号（开关前提成立）",
  H.ua !== S.ua && /\bMcode\//.test(H.ua) && /\bGenOfficeHTML\//.test(S.ua),
  { hosted: H.ua, standalone: S.ua },
);
check(
  "文档内容底 --preview-page-bg 两次都是 #ffffff（预览内容不许换）",
  H.tokens.previewPageBg === "#ffffff" && S.tokens.previewPageBg === "#ffffff",
  { hosted: H.tokens.previewPageBg, standalone: S.tokens.previewPageBg },
);
check(
  "预览面板背景两次都不被 chrome token 带走（.preview-host 计算值）",
  H.computedBg.previewHost === S.computedBg.previewHost,
  { hosted: H.computedBg.previewHost, standalone: S.computedBg.previewHost },
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
    !mainText.includes("window.desktop"),
  { gateLine, mentionsDesktop: mainText.includes("window.desktop") },
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
check("不覆盖 --preview-page-bg（预览内容的底）", !/--preview-page-bg\s*:/.test(themeSrc));
check("不覆盖 --hx-* 族（HTML app 的语义色：AI 改动/错误/焦点）", !/--hx-[\w-]+\s*:/.test(themeSrc));
check("不覆盖 --cm-* 族（CodeMirror 语法高亮语义色）", !/--cm-[\w-]+\s*:/.test(themeSrc));
check("不覆盖 --search-hit-* 与 --docs-revision-bar（文档语义标记）",
  !/--search-hit[\w-]*\s*:/.test(themeSrc) && !/--docs-revision-bar\s*:/.test(themeSrc));
check("不覆盖 --surface-2（上游从未定义，定义了会改掉回退行为）", !/--surface-2\s*:/.test(themeSrc));

console.log(`\no6-reshell-html-smoke: ${total - failures}/${total} 通过`);
console.log(`  证据目录：${dir}`);
process.exit(failures === 0 ? 0 : 1);
