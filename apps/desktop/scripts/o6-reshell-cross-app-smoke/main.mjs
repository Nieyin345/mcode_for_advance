/**
 * 【O6】五个编辑器的换壳「一起看」—— 跨 app 判据。
 *
 * ## 为什么需要这一套
 *
 * 五套 `o6-reshell-<format>-smoke` 各自验「我这个 app 换了壳、没换内容」。**它们验不了
 * 一件只有放在一起才看得见的事**：五个 `mcode-theme.css` 覆盖的 token 集合**还一样吗**。
 *
 * 如果明天有人给 sheets 加一个 token 而没给 pdf 加，**两个 app 的 chrome 就分家了**
 * —— 而五套各自的断言都是绿的，因为它们各验各的。
 *
 * ## 判据（不启动 Electron，只读五个主题文件）
 *
 *   1. 五个文件都存在，且都能解析出 `:root` 块
 *   2. ★ 五个 `:root` 覆盖集**逐字相同**（这才是「跨 app 一致」的直接证据）
 *   3. 每个 token 名都在 `tokens.css` 里（规则 A 的跨 app 版）
 *   4. 每个文件都有一行 UA 开关，且**不是** `window.desktop`
 *   5. 每个文件都声明了 `.doc-page` 之类的文档内容钉住 —— **只在需要它的 app 上**
 *      （markdown）；html/pdf/slides/sheets 没有这条，这是**正确的差异**，不是缺陷
 *
 * ## ★ 为什么是「完全相同」而不是「报告差集」
 *
 * cards 里担心的「两个 app 悄悄分家」在写这套的时刻**还没有发生** —— 五个 `:root`
 * 都是同样的 54 个 token。**「报告差集 + 钉住差集大小」在差集为 0 时，
 * 和「断言完全相同」是同一件事，但后者更简单、更直接。**
 *
 * **如果将来它们真的需要不同**（比如某个 app 引入了只有它有的 token），
 * **那时改这条断言并写明理由**——那是一个决定，不是一次漂移。
 *
 * ## 边界（如实）
 *
 * - 只比对 `:root` 块。`:root` 之外的东西（markdown 的 `.doc-page` 钉住、
 *   `[data-theme='dark']` 的暗色值）不在比对范围 —— 它们是各 app 的合法差异。
 * - 不启动 Electron，所以**它不验「token 真的生效」** —— 那是五套各自的工作。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(HERE, "../../../..");
const APPS = ["html", "markdown", "pdf", "slides", "sheets"];

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
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}
/** 取某个 `header { ... }` 块里 `--x: v;` 的名字（不含 `--`）。括号配平。 */
function blockTokens(src, header) {
  const start = src.indexOf(header);
  if (start < 0) return null;
  let depth = 0;
  let end = start;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = src.slice(start, end + 1);
  return new Set([...body.matchAll(/^\s*--([\w-]+)\s*:/gm)].map((m) => m[1]));
}

/* ── 读五个主题文件 ───────────────────────────────────────────────────── */
const themes = {};
for (const app of APPS) {
  const path = join(repoRoot, "genoffice/apps", app, "src/renderer/mcode-theme.css");
  const mainPath = join(repoRoot, "genoffice/apps", app, "src/renderer/main.tsx");
  themes[app] = {
    themePath: path,
    exists: existsSync(path),
    src: existsSync(path) ? stripComments(readFileSync(path, "utf8")) : "",
    mainSrc: existsSync(mainPath) ? stripComments(readFileSync(mainPath, "utf8")) : "",
  };
}

console.log("\n五个主题文件都在");
for (const app of APPS) {
  check(`${app}/mcode-theme.css 存在`, themes[app].exists, themes[app].themePath);
}
if (APPS.some((a) => !themes[a].exists)) {
  console.log(`\no6-reshell-cross-app-smoke: ${total - failures}/${total}（有文件缺失，后续断言无法执行）`);
  process.exit(1);
}

/* ── 2. ★ 五个 :root 覆盖集逐字相同 ────────────────────────────────────── */
console.log("\n★ 跨 app：五个 :root 覆盖集必须相同");
const roots = {};
for (const app of APPS) roots[app] = blockTokens(themes[app].src, ":root {");
for (const app of APPS) {
  check(`${app} 的 :root 块能解析出来`, roots[app] !== null && roots[app].size > 0);
}

const baseApp = APPS[0];
const base = roots[baseApp];
const diffs = [];
for (const app of APPS.slice(1)) {
  const only = [...(roots[app] ?? [])].filter((t) => !(base ?? new Set()).has(t));
  const missing = [...(base ?? [])].filter((t) => !(roots[app] ?? new Set()).has(t));
  if (only.length || missing.length) {
    diffs.push({ app, onlyHere: only.sort(), missingHere: missing.sort() });
  }
}
check(
  `★ 五个 :root 覆盖集逐字相同（各 ${base?.size ?? 0} 个 token）`,
  diffs.length === 0,
  diffs,
);
console.log(
  `     覆盖集：${(base ? [...base].sort() : []).join(" ")}`,
);

/* ── 3. 每个 token 都在 tokens.css 里（规则 A 的跨 app 版） ────────────── */
console.log("\n★ 规则 A：覆盖集里的每个 token 都来自共享层");
const tokensCssSrc = stripComments(
  readFileSync(join(repoRoot, "genoffice/packages/ui/src/tokens.css"), "utf8"),
);
const shared = new Set([...tokensCssSrc.matchAll(/^\s*--([\w-]+)\s*:/gm)].map((m) => m[1]));
check("tokens.css 解析出了共享 token", shared.size > 0, shared.size);
const privateAll = [...(base ?? [])].filter((t) => !shared.has(t));
check(
  `★ 覆盖集里没有 app 私有的 token（共享层 ${shared.size} 个，覆盖 ${base?.size ?? 0} 个）`,
  privateAll.length === 0,
  privateAll,
);

/* ── 4. 每个文件都用 UA 开关，不是 window.desktop ──────────────────────── */
console.log("\n★ 开关：五个都用 UA 产品号，不用 window.desktop");
for (const app of APPS) {
  const main = themes[app].mainSrc;
  const gateLine = main.split("\n").find((l) => l.includes("mcode-theme.css") && l.includes("import("));
  check(
    `${app}/main.tsx 的开关是 UA 判据（含 Mcode），且不是 window.desktop`,
    gateLine !== undefined &&
      gateLine.includes("navigator.userAgent") &&
      gateLine.includes("Mcode") &&
      // 单词边界：`window.desktopApi` 不该被当成 `window.desktop`。
      !/window\.desktop(?!\w)/.test(main),
    { gateLine, desktopMention: /window\.desktop(?!\w)/.test(main) },
  );
}

/* ── 5. 文档内容钉住只出现在需要它的 app 上 ───────────────────────────── */
console.log("\n★ 文档内容钉住：只出现在需要它的 app 上（这是正确的差异）");
const pinBlocks = {};
for (const app of APPS) pinBlocks[app] = blockTokens(themes[app].src, ".doc-page {");
check(
  "markdown 有 .doc-page 钉住块（它的纸张与 --surface 撞名，必须钉）",
  pinBlocks.markdown !== null,
  pinBlocks.markdown === null ? null : pinBlocks.markdown.size,
);
for (const app of ["html", "pdf", "slides", "sheets"]) {
  check(
    `${app} **没有** .doc-page 钉住块（它的纸色不共享 token，不需要钉）`,
    pinBlocks[app] === null,
    pinBlocks[app] === null ? undefined : [...pinBlocks[app]],
  );
}

console.log(`\no6-reshell-cross-app-smoke: ${total - failures}/${total} 通过`);
process.exit(failures === 0 ? 0 : 1);
