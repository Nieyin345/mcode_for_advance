/**
 * 【T39】GenOffice Docs 换壳产物校验 —— 不启动 Electron,只读构建产物与源码。
 *
 * 钉住四件事,任何一条被撤掉都必须变红:
 *   1. **Mcode 主题层真的进了产物**:`mcode-theme-*.css` 存在于 `out/renderer/assets`,
 *      且含 Mcode 的 CDS 色值(`#fcfcfb` / `#151515`)与陶土橙(`#c96442`)。
 *   2. **它是条件加载的**:产物 JS 里出现 `window.desktop` 守卫,**且** `index.html`
 *      没有直接 `<link>` 这个 CSS —— 独立运行的 GenOffice 必须保持自己的 Word 视觉。
 *   3. **边界没越**:只在**自定义属性定义行**写色值(GenOffice CI 的硬规则),
 *      不覆盖 `--accent*`(各 app 的品牌色归各 app),不覆盖 Word 语义色
 *      (`--docs-revision-bar` / `--search-hit-*`)。
 *   4. **编辑内核零改动**:`Ribbon.tsx` / `editor/` / 文档模型的字节与 pinned HEAD
 *      一致 —— 换壳不许碰内核。这条用 `git -C genoffice status` 判。
 *
 * 为什么要单独一套:换壳是**纯视觉**改动,断言必须立在"产物长什么样"上,
 * 而不是"源码里有没有那句话"。T65 那次就是在源码正则上栽的(逻辑已抽走)。
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const suite = dirname(fileURLToPath(import.meta.url));
const repo = resolve(suite, "../../../..");
const docs = join(repo, "genoffice/apps/docs");
const assets = join(docs, "out/renderer/assets");
const themeSrc = join(docs, "src/renderer/mcode-theme.css");
const mainSrc = join(docs, "src/renderer/main.tsx");

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

if (!existsSync(assets)) {
  console.log("  FAIL 产物目录不存在(apps/docs/out/renderer/assets)—— 先按 T25 重建 vendor");
  console.log("mcode-docs-reshell-smoke: 0/1");
  process.exit(1);
}

/* ── 1. 主题层真的进了产物 ────────────────────────────────────────────── */
console.log("\n主题层进产物");
const themeFiles = readdirSync(assets).filter((f) => /^mcode-theme-.*\.css$/.test(f));
check("产物里有 mcode-theme 的独立 CSS chunk", themeFiles.length === 1, themeFiles);
const themeCss = themeFiles[0] ? readFileSync(join(assets, themeFiles[0]), "utf8") : "";
check("主题层含 Mcode 亮色表面(#fcfcfb)", /--surface:\s*#fcfcfb/i.test(themeCss));
check("主题层含 Mcode 暗色表面(#151515)", /--surface:\s*#151515/i.test(themeCss));
check("主题层含 Mcode 陶土橙(--color-ai-action)", /--color-ai-action:\s*#c96442/i.test(themeCss));
check("主题层含 Mcode 的系统 sans 栈(不是 Arial 打头)",
  /--gs-font-sans:\s*[^;]*-apple-system/i.test(themeCss));
check("主题层覆盖了 ribbon 依赖的表面阶梯(--chrome-bg)", /--chrome-bg:\s*#/i.test(themeCss));
check("主题层覆盖了 ribbon 依赖的悬停态(--hover / --bg-hover)",
  /--hover:\s*#/i.test(themeCss) && /--bg-hover:\s*#/i.test(themeCss));

/* ── 2. 条件加载:独立运行不受影响 ────────────────────────────────────── */
console.log("\n条件加载(独立运行必须是 Word 视觉)");
const indexHtml = readFileSync(join(docs, "out/renderer/index.html"), "utf8");
check("index.html **没有**直接 link 主题层(否则独立运行也被换壳)",
  !indexHtml.includes("mcode-theme"), indexHtml.match(/<link[^>]*>/g));
const jsFiles = readdirSync(assets).filter((f) => /^index-.*\.js$/.test(f));
const bundle = jsFiles[0] ? readFileSync(join(assets, jsFiles[0]), "utf8") : "";
check("生产 bundle 用 window.desktop 守卫包住主题层加载",
  /if\s*\(\s*window\.desktop\s*\)\s*__vitePreload\(/.test(bundle),
  bundle.match(/if\s*\(\s*window\.desktop\s*\)[^;]{0,60}/)?.[0]);
check("bundle 里引用了主题层 chunk", /mcode-theme-[A-Za-z0-9_-]+\.css/.test(bundle));

/* ── 3. 边界:只写 token 定义行,不碰品牌色与 Word 语义色 ─────────────── */
console.log("\n边界");
const srcCss = readFileSync(themeSrc, "utf8");
// GenOffice CI 的规则:色值只允许出现在 `--x: <value>;` 这种定义行。
const rawColorLines = srcCss
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\(/.test(l))
  .filter((l) => !/^--[\w-]+\s*:/.test(l))
  .filter((l) => !/^(\/\*|\*)/.test(l));
check("主题层没有在规则里内联裸色值(GenOffice CI 的硬规则)",
  rawColorLines.length === 0, rawColorLines.slice(0, 3));
check("主题层不覆盖 --accent 家族(各 app 的品牌色归各 app)", !/--accent(-dark|-soft)?\s*:/.test(srcCss));
check("主题层不覆盖 --word-blue(同上)", !/--word-blue/.test(srcCss));
check("主题层不覆盖 Word 的修订条颜色", !/^\s*--docs-revision-bar\s*:/m.test(srcCss));
check("主题层不覆盖查找命中色(Word 语义)", !/^\s*--search-hit/m.test(srcCss));

/* ── 4. 编辑内核零改动 ────────────────────────────────────────────────── */
console.log("\n编辑内核零改动");
const status = spawnSync("git", ["-C", join(repo, "genoffice"), "status", "--porcelain"], {
  encoding: "utf8",
});
const dirty = (status.stdout ?? "")
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean);
// 允许改的:主题层(CSS)、main.tsx 的接线。其余任何改动都是越界。
const allowed = [
  /^\?\?\s+apps\/docs\/src\/renderer\/mcode-theme\.css$/,
  /^M\s+apps\/docs\/src\/renderer\/main\.tsx$/,
];
const unexpected = dirty.filter((line) => !allowed.some((re) => re.test(line)));
check("genoffice 工作树除主题层与 main.tsx 接线外无改动(编辑内核未动)",
  unexpected.length === 0, unexpected.slice(0, 5));
check("main.tsx 只在 window.desktop 为真时才加载主题层",
  /if\s*\(\s*window\.desktop\s*\)\s*import\(\s*['"]\.\/mcode-theme\.css['"]\s*\)/.test(
    readFileSync(mainSrc, "utf8"),
  ));

console.log(`\nmcode-docs-reshell-smoke: ${total - failures}/${total} 通过`);
process.exit(failures === 0 ? 0 : 1);
