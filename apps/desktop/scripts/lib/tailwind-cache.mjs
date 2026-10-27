/**
 * Tailwind 编译的**跨次缓存** —— 被各 UI 套件的 `build.mjs` 用。
 *
 * ## 为什么要缓存
 *
 * 每个起真浏览器的 UI 套件都要编译一次 Tailwind(`spawnSync` 调 tailwindcss CLI),
 * 实测单次约 2.5 秒,而它只是把 `src/renderer/styles.css` 加一组 content glob
 * 编译成 CSS。而**同一套件的输入没变时输出逐字节一致**(已验证)——重复跑(改一处
 * 只跑相关套件、或全量跑第二遍)时这 2.5 秒纯属白等。
 *
 * ## 缓存键 —— ⚠️ 必须包含 content 里的源文件
 *
 * 【UI 重建 2026-10-28】**上一版只哈希 `styles.css` + config + CLI 路径，漏了
 * content glob 里的 `.tsx/.ts`** —— 而 Tailwind 的产出**完全取决于那些源文件里
 * 出现过哪些 class**。于是：
 *
 *   改 Markdown.tsx，把 `px-2 py-1` 换成 `px-0 py-2`
 *   → styles.css 没变 → 缓存键没变 → **直接复用旧 app.css**
 *   → `px-0` / `py-2` 压根没被生成 → 浏览器把它们当不存在的 class
 *   → 拍出来的还是**旧样式**
 *
 * 我自己就撞上了：把表格改成 Claude 的无边框形态、加了
 * `[padding-inline-start:1em]`，重跑基线后量到的仍是旧的 `12px`。那一刻
 * 「改对了但没有视觉效果」和「改错了」在证据上**完全一样**。
 *
 * 这是 CLAUDE.md 第三十四条（采集了≠比对了）的同族：**缓存键采集了输入，
 * 但漏了一个决定输出的输入**。而它的失效形态是**静默复用旧产物**。
 *
 * 现在把 content glob 下所有源文件的内容也哈希进键里。代价是多读几十 MB
 * 文件（实测 ~50ms），换来的是「改了必然重编译」。
 *
 * **不用 mtime** —— 内容哈希才挡得住"改了又改回来"和"checkout 换了时间戳"。
 *
 * ## 输出位置
 *
 * `.tmp/tw-cache/<key>.css`。`.tmp` 已被 git 忽略。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";

const CACHE_DIR = join(process.cwd(), ".tmp", "tw-cache");

/** 递归收集目录下所有匹配后缀的文件（跳过 node_modules / .tmp / dist）。 */
function walkSources(dir, exts, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".tmp" || e.name === "dist" || e.name === ".git") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walkSources(p, exts, out);
    else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

/**
 * 编译(或命中缓存)一份 Tailwind CSS,写到 `outPath`。
 *
 * @param {object} o
 * @param {string} o.cliPath   tailwindcss CLI 入口(各 build.mjs 已解析出)
 * @param {string} o.configPath 已写好的 tailwind.config.cjs 路径
 * @param {string} o.inputCss  输入 styles.css(仓库相对 cwd)
 * @param {string} o.outPath   输出 css 路径(临时构建目录里)
 * @param {string} o.cwd       运行 CLI 的目录(仓库根/apps/desktop)
 * @param {string} [o.contentRoot] content glob 覆盖的根目录（绝对或相对 cwd）。
 *   不传时从 configPath 里读 `content` 数组的第一个 glob 推导。
 * @returns {{ cached: boolean }}
 */
export function buildTailwindCached({ cliPath, configPath, inputCss, outPath, cwd, contentRoot }) {
  const configText = readFileSync(configPath, "utf8");
  const hash = createHash("sha1").update(readFileSync(join(cwd, inputCss))).update(configText).update(cliPath);

  /* content 源文件参与哈希。root 取不到就**显式失败**而不是静默跳过 ——
   * 静默跳过就退回到「改了 .tsx 不重新编译」那个 bug。 */
  let rootDir = contentRoot;
  if (!rootDir) {
    const m = configText.match(/content:\s*(\[[^\]]*\])/);
    if (!m) throw new Error("tailwind-cache: 配置里找不到 content 数组，无法把源文件纳入缓存键");
    const first = JSON.parse(m[1].replace(/'/g, '"'))[0];
    if (typeof first !== "string") throw new Error("tailwind-cache: content[0] 不是字符串");
    rootDir = first.replace(/\/\*\*.*$/, "");
  }
  const absRoot = resolve(cwd, rootDir);
  const sources = walkSources(absRoot, [".tsx", ".ts", ".html", ".jsx", ".js"]).sort();
  if (sources.length === 0) {
    throw new Error(`tailwind-cache: content 根下没有源文件（${absRoot}）—— 缓存键会退化成只看 styles.css`);
  }
  /* ⚠️ **`@import` 进来的 CSS 也要算。** content glob 只覆盖 `.tsx/.ts/...`，
   * 而 `styles.css` 第一行是 `@import "./tokens.cds.css"` —— 生成物里的
   * 整套 `--m-*` token 都从那里来。只哈希 `styles.css` 本体的话，
   * 重新生成 token 后**缓存照样命中**，app.css 用的还是旧值。
   *
   * 实测：`--m-panel-radius` 从 `.625rem` 重新生成为 `.75rem` 之后，
   * 基线读到的仍是 `.625rem` —— 那一刻「token 生成错了」和「缓存没失效」
   * 在证据上完全一样。 */
  const imported = [];
  const seenCss = new Set();
  const collectImports = (cssPath) => {
    if (seenCss.has(cssPath)) return;
    seenCss.add(cssPath);
    let text;
    try { text = readFileSync(cssPath, "utf8"); } catch { return; }
    hash.update(cssPath);
    hash.update(text);
    for (const m of text.matchAll(/@import\s+(?:url\()?["']([^"')]+)["']/g)) {
      const target = resolve(dirname(cssPath), m[1]);
      imported.push(target);
      collectImports(target);
    }
  };
  collectImports(resolve(cwd, inputCss));
  for (const f of sources) {
    hash.update(f);
    hash.update(readFileSync(f));
  }
  const key = hash.digest("hex").slice(0, 16);
  const cacheFile = join(CACHE_DIR, `${key}.css`);

  if (existsSync(cacheFile)) {
    copyFileSync(cacheFile, outPath);
    return { cached: true };
  }

  const r = spawnSync(process.execPath, [cliPath, "-c", configPath, "-i", inputCss, "-o", outPath], {
    cwd, encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(r.stderr || `tailwind exited ${r.status}`);

  // 存缓存(失败不影响本次结果 —— 缓存只是加速)。
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    copyFileSync(outPath, cacheFile);
  } catch { /* ignore */ }
  return { cached: false };
}
