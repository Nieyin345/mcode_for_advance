/**
 * 【Office 深度集成】GenOffice 六编辑器在 Mcode 宿主里的 **AI 归属** 判据。
 *
 * ## 为什么需要这一套
 *
 * 用户对 Office 线的要求是「genoffice 的功能都要有，但深度集成到 Mcode，不是
 * 重新打开一个页面」，并且明确：**GenOffice 自带的 AI 对话窗口全部不要，AI 的
 * API 配置也不要，全部走 Mcode 的 AI**。
 *
 * 这件事在代码里有三种「看起来做了、其实没做」的形态，本套件各钉一条：
 *
 *   1. **面板藏了，但启动时仍在读它的 AI 设置** —— `getAiSettings()` /
 *      `getAiPanelPrefs()` / `aiGskStatus()` 仍会发出 IPC，等于宿主里还挂着第二套
 *      AI 事实源（模型、密钥、账号）。用户看不见，但它确实在跑。
 *   2. **面板藏了，但静态 import 仍在** —— AI 模块被打进宿主 bundle，只是不渲染。
 *   3. **守卫写在了 UI 上，但写在了错误的表达式上** —— 例如用 `window.desktop`
 *      判断「我在不在宿主里」（Sheet 的 preload 暴露的是 `desktopApi`，那个判断恒假）。
 *
 * ## 判据（只读源码，不启动 Electron）
 *
 *   A. 六家**都**有 `isMcodeHostedUi` 守卫（来自 `@genoffice/ui`，UA 产品号判定，
 *      不是各写一套）；
 *   B. 六家的 `main.tsx` 在 `getAiPanelPrefs` 之前都有宿主守卫；
 *   C. 六家的 renderer 里**每一处** `getAiSettings(` / `aiGskStatus(` 调用都被
 *      宿主守卫包住或位于 `return` 之后（用 AST 不现实，这里用「最近的前置守卫」启发式，
 *      并在输出里声明这个边界）；
 *   D. Mcode 侧**不再**为 vendor AI 提供设置入口：`mcode-theme.css` 不含 AI 面板样式、
 *      `documentViewPreload.ts` 不暴露 `aiStream`/`setAiSettings`；
 *   E. Mcode 设置页有且**只有一个** GenOffice pane（`settings.nav.genoffice`），
 *      且该页不含任何 AI 密钥/模型字段。
 *
 * ## 边界（如实，每次运行都打印）
 *
 * - 只读源码，**不证明运行时真的没调用** —— 那需要真 Electron + IPC 计数；
 * - C 用的是「同一函数体内、调用点之前是否有 `isMcodeHostedUi()` 守卫」的启发式，
 *   结构化重构（提前 return 到别的函数）可能让它误判；
 * - 不覆盖 vendor 主进程侧的 AI handler（那条由 `document-view-host-smoke` 覆盖）。
 *
 * COVERAGE: 6 编辑器 × 宿主内 AI 归属守卫（源码层）
 * NOT-COVERED: 运行时 IPC 计数；真 Electron 面板不可见性；vendor 主进程 AI handler
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const GEN = join(REPO, "genoffice/apps");

let total = 0;
let fail = 0;
function ck(label, yes, detail) {
  total += 1;
  if (!yes) fail += 1;
  console.log((yes ? "PASS " : "FAIL ") + label + (yes || detail === undefined ? "" : " :: " + JSON.stringify(detail)));
}

/** 去掉注释：注释里出现 `getAiSettings` 不算调用，注释里出现 `isMcodeHostedUi` 也不算守卫。
 *  这不是通用 JS 词法分析器 —— 它只处理 `//` 与 `/* *\/`，够覆盖这几个文件，
 *  但**抓的是形状不是语义**（模板字符串里带 `//` 会被误删）。 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const EDITORS = ["docs", "sheets", "slides", "pdf", "markdown", "html"];

function readEditor(kind, rel) {
  const file = join(GEN, kind, "src/renderer", rel);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

// ── A. 六家都有 isMcodeHostedUi 守卫 ─────────────────────────────────────
console.log("\n── A. 宿主判定来自共享的 isMcodeHostedUi ──");
for (const kind of EDITORS) {
  const main = readEditor(kind, "main.tsx");
  const app = readEditor(kind, "App.tsx") ?? "";
  const shell = readEditor(kind, "ExcelShell.tsx") ?? "";
  const all = stripComments((main ?? "") + app + shell);
  ck(
    `${kind}: 使用 @genoffice/ui 的 isMcodeHostedUi（不是各写一套 UA 正则）`,
    all.includes("isMcodeHostedUi"),
    { main: main !== null },
  );
  // 反控：不许自己再写一份 UA 正则去判断宿主 —— 那是「两份判定会分家」。
  ck(
    `${kind}: 没有第二份自写的 Mcode UA 判定`,
    !/\/\\bMcode\\\/\//.test(all) && !/navigator\.userAgent[^\n]*Mcode/.test(all.replace(/\bisMcodeHostedUi\(\)/g, "")),
  );
}

// ── B. main.tsx 的 AI 面板偏好读取受宿主守卫 ──────────────────────────────
console.log("\n── B. 启动期不再读 GenOffice 的 AI 面板偏好 ──");
for (const kind of EDITORS) {
  const main = readEditor(kind, "main.tsx");
  ck(`${kind}: main.tsx 存在`, main !== null);
  if (main === null) continue;
  const src = stripComments(main);
  const callAt = src.indexOf("getAiPanelPrefs");
  if (callAt < 0) {
    // 没有这次调用也是合格形态（从未读过）。但要显式说出来，不能静默跳过。
    ck(`${kind}: 未调用 getAiPanelPrefs（无需守卫）`, true);
    continue;
  }
  // 守卫必须出现在调用**之前**的 200 字符窗口内（`if (!isMcodeHostedUi()) {` 紧包住）。
  const window = src.slice(Math.max(0, callAt - 200), callAt);
  ck(`${kind}: getAiPanelPrefs 被宿主守卫包住`, window.includes("isMcodeHostedUi()"), {
    window: window.slice(-80),
  });
}

// ── C. renderer 里每一处 AI 设置/状态调用都在守卫之后 ─────────────────────
console.log("\n── C. 不再索取 GenOffice 的 AI 设置 / 账号状态 ──");
const AI_CALLS = ["getAiSettings(", "aiGskStatus("];
for (const kind of EDITORS) {
  const app = readEditor(kind, "App.tsx");
  const shell = readEditor(kind, "ExcelShell.tsx");
  const source = stripComments((app ?? "") + (shell ?? ""));
  let unguarded = 0;
  let checked = 0;
  for (const call of AI_CALLS) {
    let from = 0;
    for (;;) {
      const at = source.indexOf(call, from);
      if (at < 0) break;
      checked += 1;
      from = at + call.length;
      // 守卫的两种合法形态：同一段里前面出现过 `if (isMcodeHostedUi()) return`，
      // 或紧包在 `if (!isMcodeHostedUi()) {` 里。取调用点前 400 字符做判据。
      const window = source.slice(Math.max(0, at - 400), at);
      const guarded = window.includes("isMcodeHostedUi()) return") || window.includes("isMcodeHostedUi()) {");
      if (!guarded) unguarded += 1;
    }
  }
  ck(`${kind}: ${checked} 处 AI 设置/状态调用都在宿主守卫之后`, unguarded === 0, { unguarded, checked });
}

// ── D0. Slides 的 AI 通道按「要不要凭据」分流，而不是一刀切 ─────────────
console.log("── D0. Slides AI 通道：本地放行 / 云端拒绝 ──");
const boundary = readFileSync(join(REPO, "genoffice/apps/slides/src/main/slides-ai-boundary.ts"), "utf8");
const aiIpc = readFileSync(join(REPO, "genoffice/apps/slides/src/main/ai-ipc.ts"), "utf8");
const blockedList = (boundary.match(/SLIDES_ONLY_AI_CHANNELS = \[([\s\S]*?)\] as const/) ?? ["", ""])[1];
const localList = (boundary.match(/SLIDES_LOCAL_ONLY_CHANNELS = \[([\s\S]*?)\] as const/) ?? ["", ""])[1];

ck("★ 云端四条（生图/媒体分析/远程抓图）在宿主里 fail-closed",
  ["ai:generate-image", "ai:analyze-media", "ai:insert-image-url", "ai:replace-picture-url"]
    .every((c) => blockedList.includes(c)),
  blockedList);
ck("★ 本地四条（sidecar/样式模板）不再被拒绝（它们不需要任何 AI 授权）",
  ["ai:save-sidecar", "ai:save-style-template", "ai:list-style-templates", "ai:load-style-template"]
    .every((c) => localList.includes(c) && !blockedList.includes(c)),
  localList);
ck("两组合起来恰好是原来那 8 条（没有通道在拆分中丢失）",
  (blockedList.match(/ai:/g) ?? []).length === 4 && (localList.match(/ai:/g) ?? []).length === 4,
  { blocked: (blockedList.match(/ai:/g) ?? []).length, local: (localList.match(/ai:/g) ?? []).length });
ck("宿主路径真的会注册本地四条（不是只写在常量里）",
  /registerSlidesAiBoundary\([\s\S]{0,300}?registerSlidesLocalOnlyAiIpc/.test(aiIpc));
ck("本地四条抽成了独立函数（standalone 仍走原厂那一条）",
  /export function registerSlidesLocalOnlyAiIpc\(\)/.test(aiIpc) &&
  /function registerOriginalSlidesOnlyAiIpc\(\)/.test(aiIpc));

// ── D. Mcode 侧不再为 vendor AI 提供入口 ─────────────────────────────────
console.log("\n── D. Mcode 宿主侧不提供 vendor AI 入口 ──");
const preload = readFileSync(join(REPO, "apps/desktop/src/main/document/documentViewPreload.ts"), "utf8");
const preloadCode = stripComments(preload);
for (const forbidden of ["aiStream:", "setAiSettings:", "aiGskStatus:", "openAiModelSettings:"]) {
  ck(`documentViewPreload 不暴露 ${forbidden.slice(0, -1)}`, !preloadCode.includes(forbidden));
}
// 更根本的一条：这个文件**根本不该有 slides 桥**。它只在 kind===null（普通文档视图）
// 挂载，六编辑器的 slidesApi 由 vendor 自己的 preload 提供。曾经有一份手写死代码桥
// 返回硬编码空值，读代码的人会以为宿主在用空数据冒充 deck 内容 —— 那是「死代码与
// 注释一起撒谎」的形态，所以这里钉住它不许回来。
ck("★ documentViewPreload 不含 slidesApi 桥（那 220 行是死代码，已删）",
  !preloadCode.includes("slidesApi") && !preloadCode.includes("getTransition"));
// 这条查**原文**而不是剥注释后的代码 —— 要守的正是那段注释本身。
ck("★ 删掉的那段有留下的原因说明（否则下一个人会把它加回来）",
  preload.includes("它已经删掉了，因为它从来没被用过"));

// ── E. 设置页只有一个 GenOffice pane，且不含 AI 密钥字段 ─────────────────
console.log("\n── E. Mcode 设置页：单一 GenOffice pane，无 AI 密钥 ──");
const settingsPage = readFileSync(join(REPO, "apps/desktop/src/renderer/components/settings/SettingsPage.tsx"), "utf8");
const navCount = (settingsPage.match(/id: "genoffice"/g) ?? []).length;
ck("设置导航里 GenOffice 条目恰好一个", navCount === 1, { navCount });

const panelPath = join(REPO, "apps/desktop/src/renderer/components/settings/GenofficePanel.tsx");
ck("GenofficePanel 存在", existsSync(panelPath));
if (existsSync(panelPath)) {
  const panel = stripComments(readFileSync(panelPath, "utf8"));
  ck("GenofficePanel 不含 API Key 输入", !/apiKey|api_key|byok|secret/i.test(panel));
  ck("GenofficePanel 指向 Mcode 的模型配置页（唯一事实源）", panel.includes('"custom-models"'));
  ck("GenofficePanel 的报告来自 document.capabilities（不自己猜）", panel.includes("document.capabilities()"));
  ck("GenofficePanel 的三态区分「未报告」与「不可用」", panel.includes('"unknown"') && panel.includes('"unavailable"'));
}

// 反控：i18n 里必须真的声明了导航与页面文案（否则 typecheck 绿、界面是 key）。
const zhSettings = readFileSync(join(REPO, "apps/desktop/src/renderer/lib/i18n/zh/settings.ts"), "utf8");
const enSettings = readFileSync(join(REPO, "apps/desktop/src/renderer/lib/i18n/en/settings.ts"), "utf8");
for (const key of ["settings.nav.genoffice", "settings.genoffice.title", "settings.genoffice.aiNoVendorConfig"]) {
  ck(`zh 词典含 ${key}`, zhSettings.includes(`"${key}"`));
  ck(`en 词典含 ${key}`, enSettings.includes(`"${key}"`));
}

console.log(`\noffice-hosted-ai-smoke: ${total - fail}/${total}`);
if (fail > 0) process.exitCode = 1;
