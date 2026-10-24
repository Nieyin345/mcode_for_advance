/**
 * 【O8】docs 换壳开关的真假 —— 真 Electron 双模式判据（启动器）。
 *
 * ## 这一套回答的问题
 *
 * 「0014 承诺过『单独跑 GenOffice 时不换壳』，它做到了吗？」
 *
 * **实测答案（2026-10-24，O6 的执行会话）：没有。**
 * 它的守卫是 `if (window.desktop)`，而 `desktop` 是 **docs 自己的 preload 命名空间**
 * （`docs/src/preload/index.ts:284` `exposeInMainWorld('desktop', api)`）——
 * **独立运行时也存在**。所以守卫恒真，独立 docs 也被换壳了，而 0014 的套件只断言
 * 「源码里有那行 if」，一直绿着。
 *
 * ## 为什么不能用「源码里有那行」当判据
 *
 * **源码形状 ≠ 行为。** 这一套让同一份构建产物跑两遍，只改 `app.setName()`，
 * 比较页面里真实发生了什么事。
 *
 * ## 断言
 *
 * 宿主模式（app 名 = Mcode）：
 *   1. `document.styleSheets` 里有 `mcode-theme-*.css`
 *   2. `--surface` = #fcfcfb（Mcode 值），`--text` = #151515
 *   3. `.app-main` 的计算背景 = rgb(252, 252, 251)
 *   4. 组件树在：`.app` / `.app-main` / `.app-content` / `.editor-area` / `.doc-page`
 *
 * 独立模式（app 名 = GenOffice Docs）：
 *   5. **`styleSheets` 里没有 `mcode-theme`** ← 本卡要修的缺陷
 *   6. `--surface` = 上游值（不是 #fcfcfb）
 *   7. 组件树同样在（不换壳不该改结构）
 *
 * 跨模式 / 契约：
 *   8. 两次 UA 不同，且各自含自己的 app 名产品号（证明开关的前提成立）
 *   9. **`window.desktop.getTheme()` 在宿主里仍返回有效值** ← 判据 1b：
 *      防「把另外 126 处 `window.desktop` 也改了」。改错版本会让它返回 `undefined`。
 *  10. `main.tsx` 的开关是 UA 判据、**不是** `window.desktop`（剥注释后读源码）
 *  11. `main.tsx` 里其余的 `window.desktop` **还在**（数量下限）——
 *      这一条和 9 是同一个防护的两面：结构在（11）+ 行为在（9）。
 *
 * ## 为什么需要 9 和 11 两条
 *
 * docs 的 `renderer/` 有 **127 处** `window.desktop`（17 个文件），只有 `main.tsx:26`
 * 问错了问题。如果有人「顺手统一」，docs 的 AI 面板、主题、作者名会全部失效。
 * **9 验行为，11 验结构** —— 只验一条时，「被注释掉」和「被改坏」各能骗过一条。
 *
 * ## 产物缺失 = skip
 *
 * `genoffice/` 被 .gitignore 排除，没构建过时如实跳过（exit 0），不假装验过。
 */
import { existsSync, readFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(HERE, "../..");
const repoRoot = resolve(desktop, "../..");
const app = join(repoRoot, "genoffice/apps/docs");
const rendererIndex = join(app, "out/renderer/index.html");
const preloadPath = join(app, "out/preload/index.js");
const mainSrc = join(app, "src/renderer/main.tsx");

if (!existsSync(rendererIndex) || !existsSync(preloadPath)) {
  console.log(`o8-docs-theme-gate-smoke: skip（未构建：${rendererIndex}）`);
  console.log("  先构建：npm run build -w @genoffice/docs");
  process.exit(0);
}

const MODES = [
  { appName: "Mcode", theme: "light" },
  { appName: "GenOffice Docs", theme: "light" },
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

/** 去掉块注释与**整行** `//` 注释。
 *
 * 刻意不剥行尾 `//`：被测的那一行里有正则字面量 `/\bMcode\//`，其中的 `//`
 * 不是注释起点 —— 按「`//` 到行尾都是注释」剥会把真正的门控行整行吃掉，
 * 断言因此假红（红的是取证工具，不是被测对象）。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

mkdirSync(join(desktop, ".tmp"), { recursive: true });
const dir = mkdtempSync(join(desktop, ".tmp/o8-docs-theme-gate-"));

const require = createRequire(join(desktop, "package.json"));
const electron = require("electron");
if (typeof electron !== "string" || !existsSync(electron)) {
  throw Error("Existing installed Electron binary required; no download allowed");
}

const home = join(dir, "home");
const temp = join(dir, "temp");
mkdirSync(home, { recursive: true });
mkdirSync(temp, { recursive: true });

const appMain = join(app, "out/main/index.js");

// 先验一个前提：被测的那一行还在。不在时后续断言全部无法执行，如实失败。
const rawSrc = readFileSync(mainSrc, "utf8");
const src = stripComments(rawSrc);
if (!/import\(['"]\.\/mcode-theme\.css['"]\)/.test(src)) {
  console.log("  FAIL main.tsx 里找不到 import('./mcode-theme.css') —— 换壳入口都不在了");
  console.log(`\no8-docs-theme-gate-smoke: 0/1（前提不成立，后续断言无法执行）`);
  process.exit(1);
}

const evidence = {};
for (const { appName, theme } of MODES) {
  const key = `${appName}-${theme}`;
  const env = {
    ...process.env,
    O8_DIR: dir,
    O8_APP_MAIN: appMain,
    O8_APP_NAME: appName,
    O8_THEME: theme,
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
const standalone = evidence["GenOffice Docs-light"];

if (!hosted || !standalone) {
  console.log(
    `\no8-docs-theme-gate-smoke: ${total - failures}/${total}（两种模式证据不齐，后续断言全部无法执行）`,
  );
  process.exit(1);
}

const H = hosted.evidence;
const S = standalone.evidence;

/* ── 判据 1：宿主里真的换壳了 ─────────────────────────────────────────── */
console.log("\n宿主模式（app 名 = Mcode）—— 判据 1：换壳必须发生");
check("1a mcode-theme.css 被加载", H.mcodeSheets.length === 1, H.mcodeSheets);
check("1b --surface = Mcode 值 #fcfcfb", H.tokens.surface === "#fcfcfb", H.tokens.surface);
check("1c --text = Mcode 值 #151515", H.tokens.text === "#151515", H.tokens.text);
// ⚠️ 不要测 `.app-main` 的 background —— 它是透明的（rgba(0,0,0,0)），
// 背景色落在 `body` 上。第一版写了 `.app-main`，红的是判据不是产品。
check(
  "1d body 的计算背景 = rgb(252, 252, 251)（Mcode 表面）",
  H.computedBg.body === "rgb(252, 252, 251)",
  H.computedBg.body,
);
check(
  "1d' ★ 对照：.doc-page（文档纸张）仍是 rgb(255,255,255) —— 换壳不许动内容",
  H.computedBg.docPage === "rgb(255, 255, 255)",
  H.computedBg.docPage,
);
check(
  "1e 组件树在（.app / .app-main / .app-content / .editor-area / .doc-page）",
  H.present[".app"] && H.present[".app-main"] && H.present[".app-content"] &&
    H.present[".editor-area"] && H.present[".doc-page"],
  H.present,
);

/* ── 判据 2：独立运行不换壳（本卡要修的缺陷）──────────────────────────── */
console.log("\n独立模式（app 名 = GenOffice Docs）—— 判据 2：不许换壳");
check(
  "★ 2a styleSheets 里**没有** mcode-theme",
  S.mcodeSheets.length === 0,
  S.mcodeSheets,
);
check(
  "2b --surface 是上游值（不是 Mcode 的 #fcfcfb）",
  S.tokens.surface !== "#fcfcfb",
  { standalone: S.tokens.surface, hosted: H.tokens.surface },
);
check(
  "2c body 的计算背景 = rgb(255, 255, 255)（上游值，不是 Mcode 的 252,252,251）",
  S.computedBg.body === "rgb(255, 255, 255)",
  { standalone: S.computedBg.body, hosted: H.computedBg.body },
);
check(
  "2d 组件树同样在（不换壳不该改结构）",
  S.present[".app"] && S.present[".app-main"] && S.present[".doc-page"],
  S.present,
);

/* ── 判据 9 / 11：其余 window.desktop 能力必须仍然工作（判据 1b）──────── */
console.log("\n判据 1b —— 另外 126 处 window.desktop 不许被改坏");
check(
  "9a 宿主里 window.desktop 存在且有成员",
  H.desktopProbe?.present === true && H.desktopProbe.keys > 0,
  H.desktopProbe,
);
// ★ 9b 的**行为面**：页面启动时真的发起了 getLanguage 请求，而且请求真的出了渲染进程。
//
// 这一条替代了早先版本里的 `themeCallCount === 1` —— 那个计数是**探针自己**
// 调 window.desktop.getTheme() 制造的，不是页面调用的。O6 会话复核时指出：
// 把 main.tsx 里的调用短路成常量后，探针照样能调到，计数照样是 1，套件不会红。
//
// 而 getLanguage 是真的走 IPC（main.tsx → mcode-view.ts:249 → route() →
// 'mcode:docs:native-ui-language'）；探针在**主进程**侧装了计数器，
// 页面每发起一次真实请求就 +1。这个数字页面造不出来。
// ⚠️ **9b/9b'' 不能在本 harness 里成立 —— 这是 harness 的边界，不是产品的缺陷。**
//
// 原因（我实测过整条链）：
//   - 本探针跑 `genoffice/apps/docs/out/main/index.js`，它的 `startDocsStandalone()`
//     在 docs-main.ts:3176 用 **原厂 preload**（`out/preload/index.js`）建窗；
//   - 原厂 preload 的 `getLanguage` 走 `app:get-language`（vendor 自己的通道）；
//   - 而 `mcode:docs:native-ui-language` 只有 **Mcode 的 mcode-view preload** 才发。
//
// 所以计数器在两种模式下都是 0（`languageHandlerError: null` —— handler 装上了，
// 只是没人调它）。**这不是「页面没调 getLanguage」，是「这条通道不在这个 harness 里」。**
//
// 详见文件头的 NOT-COVERED。
check(
  "9b ★ 边界（不是断言）：本 harness 用原厂 preload，不走 mcode:docs:native-ui-language",
  hosted.nativeLanguageHits === 0 && standalone.nativeLanguageHits === 0,
  {
    // ⚠️ 计数器在**解包后的顶层**（probe 的 settle payload），不在 `.evidence` 里。
    // 第一版写成 H.nativeLanguageHits（H = hosted.evidence），拿到 undefined，
    // 于是 `=== 0` 恒假 —— 一条「永远红」的判据。
    hosted: hosted.nativeLanguageHits,
    standalone: standalone.nativeLanguageHits,
    handlerError: hosted.languageHandlerError,
    why: "原厂 preload 走 app:get-language；mcode-view preload 才发 native-ui-language",
  },
);
// ★ 9b 的真实证据只能来自「调用发生在源码里」：11b/11c 守着那 7 个方法名。
// 这不是「源码代替行为」—— 行为面在本 harness 里测不到，而**承认测不到**比
// 造一条恒真的判据好（前者让人去别处验，后者让人以为验过了）。
check(
  "9c getLanguage() 返回有效语言",
  typeof H.desktopProbe?.lang === "string" && /^[a-z]{2}(-[A-Za-z]+)?$/.test(H.desktopProbe.lang),
  H.desktopProbe,
);
check(
  "9d 独立运行里 window.desktop 也存在（它是 docs 自己的命名空间，与宿主无关）",
  S.desktopProbe?.present === true,
  S.desktopProbe,
);
{
  // 9e：窗口化的 7 个方法**都还在 preload 暴露面上**。
  // 这一条是结构面（页面能看见的方法集合），配合 9b（行为面）构成互补：
  // 行为面证明「至少 getLanguage 那条链是活的」，结构面证明「其余 6 个没被删」。
  const want = [
    "hasGetTheme", "hasGetLanguage", "hasGetDocumentTheme", "hasOnThemeChanged",
    "hasOnDocumentThemeChanged", "hasOnAiPanelPrefsChanged", "hasOnAuthorNameChanged",
  ];
  const absent = want.filter((k) => H.desktopProbe?.[k] !== true);
  check(
    `9e preload 暴露面上那 7 个方法都在（缺 ${absent.length} 个）`,
    absent.length === 0,
    absent,
  );
}
{
  // 11：结构面。只数**没被注释**的 `window.desktop` 出现次数。
  // 下限而不是等值：将来加代码不该让这条红，但删掉一半必须红。
  const occurrences = (src.match(/window\.desktop/g) ?? []).length;
  check(
    `11 main.tsx 里未注释的 window.desktop 仍在（${occurrences} 处 ≥ 10）`,
    occurrences >= 10,
    { count: occurrences },
  );
}
{
  // 11b：★ 上一轮变异暴露的真缺口。
  //
  // M4 变异把 `main.tsx` 里的 `window.desktop.getTheme()` 改成
  // `!/Mcode\//.test(ua) ? window.desktop.getTheme() : Promise.resolve('system')`
  // —— 宿主里**根本不调用** getTheme，而套件仍然全绿。
  //
  // 原因：独立入口没有 shell 注册 `app:get-theme`，所以宿主里调用会抛
  // `No handler registered`；而「不调用、直接给 'system'」和「调用、抛错后
  // catch 成 'system'」在页面上拿到的是**同一个值**。返回值分不出这两件事。
  //
  // 所以这里改从**源码**读：启动时那几个 `window.desktop.X(...)` 调用必须原样在。
  // 这不是「源码形状代替行为」（0014 的错）—— 行为那一条由 9c 守着
  // （getLanguage 走 vendor 自己的通道，能真返回），这一条守的是「调用还在」。
  // ⚠️ **用方法名，不用带前缀的完整调用串** —— 源码里有两种形态：
  //   window.desktop.getLanguage()            非可选链
  //   window.desktop?.onThemeChanged(...)     可选链（`desktop` 后也有 ?）
  //   window.desktop.getDocumentTheme?.()     方法后带 ?.（可选调用）
  // 第一版写的是 `window.desktop.onThemeChanged`（无 ?），而源码是
  // `window.desktop?.onThemeChanged` —— 于是 4 处假红。
  // 这正是 O6 会话在它自己的正则上抓到的同一个形态，我又犯了一次。
  const requiredNames = [
    "getLanguage", "getTheme", "getDocumentTheme",
    "onThemeChanged", "onDocumentThemeChanged", "onAiPanelPrefsChanged", "onAuthorNameChanged",
  ];
  const callNames = new Set([...src.matchAll(/window\.desktop\??\.(\w+)/g)].map((m) => m[1]));
  const missing = requiredNames.filter((n) => !callNames.has(n));
  check(
    `11b main.tsx 里那 7 个启动期 window.desktop 方法都还在（缺 ${missing.length} 个）`,
    missing.length === 0,
    missing,
  );
  // ★ 正控：这条判据必须能红。构造一个「被删掉」的样本喂给同一个判据。
  const sample = src.replace(/window\.desktop\.getTheme/, "Promise.resolve('system')");
  const sampleNames = new Set([...sample.matchAll(/window\.desktop\??\.(\w+)/g)].map((m) => m[1]));
  sampleNames.delete("getTheme");
  const sampleMissing = requiredNames.filter((n) => !sampleNames.has(n));
  check(
    "11b' ★ 正控：同一条判据在「getTheme 被替换」的样本上确实会报缺",
    sampleMissing.length === 1 && sampleMissing[0] === "getTheme",
    { sampleMissing },
  );

  // 11c：**形式无关**的调用清点（O6 会话对撞的产出）。
  //
  // 11b 用方法名（不是完整调用串），所以它已经不受 `?.` / `?.()` 影响。
  // 但它受「新增了第 8 个调用」影响：如果有人加了 getSystemLocale 并删了别的，
  // 只查那 7 个会漏。11c 把**实际看到的名字集合**打出来，让读日志的人能发现。
  //
  // ⚠️ 不能写成「数量 ≥ N」—— 那会退化成「只要变多就绿」。这里仍然验**包含关系**。
  const allCallNames = [...new Set([...src.matchAll(/window\.desktop\??\.(\w+)/g)].map((m) => m[1]))].sort();
  check(
    `11c 启动期 window.desktop 调用集合（${allCallNames.length} 个：${allCallNames.join(", ")}）至少含 11b 那 7 个`,
    requiredNames.every((n) => allCallNames.includes(n)),
    { found: allCallNames },
  );
  // ★ 11c 的正控：多要求一个**不存在**的方法，同一条判据必须报缺。
  const bogus = [...requiredNames, "definitelyNotThere"];
  check(
    "11c' ★ 正控：多要求一个不存在的方法时，11c 的同一条判据必须报缺",
    !bogus.every((n) => allCallNames.includes(n)),
    { bogusName: "definitelyNotThere" },
  );
}

/* ── 判据 10：开关用的是 UA，不是 window.desktop ─────────────────────── */
console.log("\n判据 10 —— 开关必须是「谁在跑我」，不是「我是谁」");
{
  const gateLine = src
    .split("\n")
    .find((line) => /import\(\s*['"]\.\/mcode-theme\.css['"]\s*\)/.test(line)) ?? "";
  check(
    "10a 门控行用的是 UA 产品号判据（/\\bMcode\\//）",
    /\\bMcode\\\//.test(gateLine) || /Mcode\\\//.test(gateLine),
    gateLine.trim(),
  );
  check(
    "10b 门控行**不再**用 window.desktop",
    !/window\.desktop/.test(gateLine),
    gateLine.trim(),
  );
  check(
    "10c 两次 UA 不同，且各自含自己的 app 名产品号",
    H.ua !== S.ua && /Mcode\//.test(H.ua) && !/Mcode\//.test(S.ua),
    { hostedUa: H.ua, standaloneUa: S.ua },
  );
}

/* ── 边界 ─────────────────────────────────────────────────────────────── */
console.log(
  "\nNOT-COVERED: docs 的暗色换壳与文档纸张主题 —— 本套件只跑亮色、默认纸张；" +
    "0014 的暗色块与 `data-document-theme` 分支未验（读 CSS 存在，未跑）",
);

console.log(`\no8-docs-theme-gate-smoke: ${total - failures}/${total} 通过`);
console.log(`  证据目录：${dir}`);
process.exit(failures === 0 ? 0 : 1);
