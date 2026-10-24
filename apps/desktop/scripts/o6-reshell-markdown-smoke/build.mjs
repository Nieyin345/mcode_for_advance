/**
 * 【O6】Markdown 换壳 —— 真 Electron 双模式判据（启动器）。
 *
 * 判据结构与 `o6-reshell-html-smoke` 相同（同一份构建产物跑两遍：`app.setName("Mcode")`
 * 与 `app.setName("GenOffice Markdown")`，两次都挂原厂 preload），**另加** Markdown
 * 独有的一组：它的**预览纸张** `.doc-page` 与 chrome 共用 `--surface`，所以必须证明
 * 「chrome 换了、正文纸张和墨色没换」。
 *
 * ## 断言分组
 *
 * 宿主模式：主题层加载；`--surface`/`--text`/`--border` = Mcode 值；`.ribbon` 计算背景
 *           = Mcode 表面；字体栈不是 Arial 打头；组件树在。
 * 独立模式：主题层**没**加载；三个 token = 上游值；`.ribbon` 计算背景 = 上游表面；
 *           字体栈仍是 Arial；组件树同样在。
 * 跨模式/契约：两次 UA 各自带自己的产品号；`main.tsx` 用 UA 判据、不是 `window.desktop`。
 * **文档内容（Markdown 特有）**：
 *   - `.doc-page` 的 `background-color` 两次**相同**（预览纸张不被换壳带走）；
 *   - `.doc-page` 内 `--surface` 两次都是上游纸色（钉住生效）；
 *   - `.doc-page` 内 `--text` 两次都是上游墨色；
 *   - 宿主模式下 `.editor-scroll`（画布底，属 chrome）**确实**换成了 Mcode 的 canvas
 *     —— 证明「钉住」没有过度，把整块内容区都锁死。
 * **防漂移**：`mcode-theme.css` 里 `.doc-page` 钉住的每个值与 `tokens.css` 当前值
 *   逐条相等。上游改纸色时这条会红，消息点名是哪个 token 变了（要决定跟不跟）。
 */
import { existsSync, readFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(HERE, "../..");
const repoRoot = resolve(desktop, "../..");
const app = join(repoRoot, "genoffice/apps/markdown");
const rendererIndex = join(app, "out/renderer/index.html");
const preloadPath = join(app, "out/preload/index.js");
const mainSrc = join(app, "src/renderer/main.tsx");
const themeSrcPath = join(app, "src/renderer/mcode-theme.css");
const tokensCss = join(repoRoot, "genoffice/packages/ui/src/tokens.css");

if (!existsSync(rendererIndex) || !existsSync(preloadPath)) {
  console.log(`o6-reshell-markdown-smoke: skip（未构建：${rendererIndex}）`);
  console.log("  先构建：npm run build -w @genoffice/markdown");
  process.exit(0);
}

const MODES = ["Mcode", "GenOffice Markdown"];

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
 * 刻意不剥行尾 `//`：被测那一行里有正则字面量 `/\bMcode\//`，其中的 `//` 不是
 * 注释起点 —— 按「`//` 到行尾都是注释」剥会把它整行吃掉（html 套件踩过，假红）。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

const require = createRequire(join(desktop, "package.json"));
const electron = require("electron");
if (typeof electron !== "string" || !existsSync(electron)) {
  throw Error("Existing installed Electron binary required; no download allowed");
}

mkdirSync(join(desktop, ".tmp"), { recursive: true });
const dir = mkdtempSync(join(desktop, ".tmp/o6-reshell-markdown-"));
const home = join(dir, "home");
const temp = join(dir, "temp");
mkdirSync(home, { recursive: true });
mkdirSync(temp, { recursive: true });

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
const standalone = evidence["GenOffice Markdown"];
if (!hosted || !standalone) {
  console.log(`\no6-reshell-markdown-smoke: ${total - failures}/${total}（两模式证据不齐）`);
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
  "组件树没变：.ribbon / .app-main / .doc-page / .status-bar 都在",
  H.present[".ribbon"] && H.present[".app-main"] && H.present[".doc-page"] && H.present[".status-bar"],
  H.present,
);

/* ── 独立模式 ─────────────────────────────────────────────────────────── */
console.log("\n独立模式（app 名 = GenOffice Markdown，无宿主）");
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
  S.present[".ribbon"] && S.present[".app-main"] && S.present[".doc-page"] && S.present[".status-bar"],
  S.present,
);

/* ── 跨模式 / 契约 ────────────────────────────────────────────────────── */
console.log("\n跨模式与源码契约");
check(
  "两次 UA 不同，且各自含自己的 app 名产品号（开关前提成立）",
  H.ua !== S.ua && /\bMcode\//.test(H.ua) && /\bGenOfficeMarkdown\//.test(S.ua),
  { hosted: H.ua, standalone: S.ua },
);

const mainText = stripComments(readFileSync(mainSrc, "utf8"));
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

/* ── ★ 文档内容：预览纸张和正文墨色（Markdown 特有） ────────────────── */
console.log("\n文档内容（预览纸张不被换壳带走）");
check(
  ".doc-page 的 background-color 两次完全相同（纸张是文档内容）",
  H.computedBg.docPage !== null && H.computedBg.docPage === S.computedBg.docPage,
  { hosted: H.computedBg.docPage, standalone: S.computedBg.docPage },
);
check(
  ".doc-page 内 --surface = 上游纸色（宿主里也钉住）",
  H.tokens.docPage.surface === S.tokens.docPage.surface && H.tokens.docPage.surface === "#ffffff",
  { hosted: H.tokens.docPage.surface, standalone: S.tokens.docPage.surface },
);
check(
  ".doc-page 内 --text = 上游墨色（宿主里也钉住）",
  H.tokens.docPage.text === S.tokens.docPage.text && H.tokens.docPage.text === "#242424",
  { hosted: H.tokens.docPage.text, standalone: S.tokens.docPage.text },
);
check(
  "★ 对照：宿主里 .editor-scroll（画布底，属 chrome）**确实**换成了 Mcode canvas",
  H.computedBg.editorScroll !== null && H.computedBg.editorScroll !== S.computedBg.editorScroll &&
    H.computedBg.editorScroll === "rgb(240, 239, 236)",
  { hosted: H.computedBg.editorScroll, standalone: S.computedBg.editorScroll },
);

/* ── 边界：不碰文档语义 / 品牌色 ─────────────────────────────────────── */
console.log("\n边界（主题层内容）");
const themeSrc = stripComments(readFileSync(themeSrcPath, "utf8"));
const rawColorLines = themeSrc
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\(/.test(l))
  .filter((l) => !/^--[\w-]+\s*:/.test(l));
check("主题层没有在规则里内联裸色值（GenOffice CI 的硬规则）", rawColorLines.length === 0, rawColorLines.slice(0, 3));
check("不覆盖 --accent 家族（各 app 的品牌色）", !/--accent(-dark|-soft)?\s*:/.test(themeSrc));
check("不覆盖 --word-blue", !/--word-blue\s*:/.test(themeSrc));
check("不覆盖 --md-*（正文排版语义：链接/代码/引用/表格头/图表底）", !/^\s*--md-[\w-]+\s*:/m.test(themeSrc));
check("不覆盖 --mdt-*（纸张主题调色板）", !/^\s*--mdt-[\w-]+\s*:/m.test(themeSrc));
check("不覆盖 --redact-*（脱敏标记语义色）", !/^\s*--redact-[\w-]+\s*:/m.test(themeSrc));
check("不覆盖 --search-hit-* 与 --docs-revision-bar（文档语义标记）",
  !/^\s*--search-hit[\w-]*\s*:/m.test(themeSrc) && !/^\s*--docs-revision-bar\s*:/m.test(themeSrc));

/* ── ★ 防漂移：钉住值 == tokens.css 当前值 ───────────────────────────── */
console.log("\n防漂移（钉住值必须等于上游 tokens.css）");
const tokensSrc = stripComments(readFileSync(tokensCss, "utf8"));
/** 取 tokens.css 某个块的 `--name: value;` 表（header 形如 `:root {`）。 */
function tokenBlock(header) {
  const start = tokensSrc.indexOf(header);
  if (start < 0) return null;
  const end = tokensSrc.indexOf("\n}", start);
  if (end < 0) return null;
  const table = {};
  for (const line of tokensSrc.slice(start, end).split("\n")) {
    const m = /^\s*(--[\w-]+)\s*:\s*(.+?);\s*$/.exec(line);
    if (m) table[m[1]] = m[2].trim();
  }
  return table;
}
/** 取主题文件某段（从 header 到下一个顶层 `}`）里 `--name: value;` 表。 */
function themeBlock(header) {
  const start = themeSrc.indexOf(header);
  if (start < 0) return null;
  // 取到括号配平为止
  let depth = 0;
  let i = start;
  let started = false;
  for (; i < themeSrc.length; i++) {
    if (themeSrc[i] === "{") {
      depth++;
      started = true;
    } else if (themeSrc[i] === "}") {
      depth--;
      if (started && depth === 0) break;
    }
  }
  const body = themeSrc.slice(start, i + 1);
  const table = {};
  for (const line of body.split("\n")) {
    const m = /^\s*(--[\w-]+)\s*:\s*(.+?);\s*$/.exec(line);
    if (m) table[m[1]] = m[2].trim();
  }
  return table;
}

const lightUpstream = tokenBlock(":root {");
const darkUpstream = tokenBlock("[data-theme='dark'] {");
const lightPinned = themeBlock(".doc-page {");
const darkPinned = themeBlock("[data-theme='dark'] .doc-page {");

check("tokens.css 的亮/暗两个块都能解析出来", lightUpstream !== null && darkUpstream !== null);
check("主题层的 .doc-page 亮/暗两个钉住块都能解析出来", lightPinned !== null && darkPinned !== null);

const drift = [];
if (lightUpstream && lightPinned) {
  for (const [name, value] of Object.entries(lightPinned)) {
    const upstream = lightUpstream[name];
    if (upstream === undefined) {
      drift.push(
        `${name}: 钉住了 tokens.css 里**不存在**的 token（上游删了或改名了）。` +
          `先确认它现在叫什么，再决定钉住值的去处 —— 别直接删，正文会失去约束`,
      );
    } else if (upstream !== value) {
      drift.push(
        `${name}: 上游改了纸张/墨色（tokens.css 现在是 ${upstream}，这里钉住的是 ${value}）。` +
          `要跟就改这里的钉住值；不跟就写明理由 —— 这是个决定，不是一次对齐`,
      );
    }
  }
}
if (darkUpstream && darkPinned) {
  for (const [name, value] of Object.entries(darkPinned)) {
    const upstream = darkUpstream[name];
    if (upstream === undefined) {
      drift.push(
        `dark ${name}: 钉住了 tokens.css 的暗色块里**不存在**的 token（上游删了或改名了）。` +
          `先确认它现在叫什么，再决定钉住值的去处`,
      );
    } else if (upstream !== value) {
      drift.push(
        `dark ${name}: 上游改了暗色纸张/墨色（tokens.css 现在是 ${upstream}，这里钉住的是 ${value}）。` +
          `要跟就改这里的钉住值；不跟就写明理由`,
      );
    }
  }
}
check(
  `钉住的每个值都等于 tokens.css 当前值（${Object.keys(lightPinned ?? {}).length} 亮 + ${Object.keys(darkPinned ?? {}).length} 暗）`,
  drift.length === 0,
  drift.slice(0, 8),
);

console.log(`\no6-reshell-markdown-smoke: ${total - failures}/${total} 通过`);
console.log(`  证据目录：${dir}`);
process.exit(failures === 0 ? 0 : 1);
