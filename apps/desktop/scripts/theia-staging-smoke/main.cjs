/**
 * 验 `vendor/theia-runtime` —— **随仓库来的那份运行时**是完整的、能跑的。
 *
 * ## 这套件守的是什么
 *
 * 用户的要求：`git clone` 之后扩展立刻可用，不做任何额外的事。
 * 实现方式是 `vendor/theia-runtime` 入库（零软链）+ `postinstall` 建 junction。
 *
 * 这套件回答三个问题：
 *  1. 入库的那份**结构对不对**（入口在、零软链、许可文件在）；
 *  2. `postinstall` 建的链接**真的能生效**（不是「文件在」而是「能跑」）；
 *  3. 它和 `vendor/theia` 的**内容是否一致**（防它静默过期）。
 *
 * ## ⚠️ 第 3 条为什么重要
 *
 * `theia-runtime` 是从 `vendor/theia` **生成**的。生成物过期不会自己报错 ——
 * 本仓库为此栽过：`apiCatalog.generated.ts` 三个提交没重跑，而它是运行时的
 * `channelIdempotency` 的输入，于是幂等守卫对新增的 RPC 完全不生效。
 *
 * 所以这里比对两棵树的 `packages/` 与 `dev-packages/`（只比运行期会读的
 * `.js` / `.json`），不一致就红。
 *
 * ## 它不验什么
 *
 * - 真 fork 子进程的 RPC 闭环（`theia-installed-smoke` / `ext-mcode-e2e-smoke` 覆盖）；
 * - 打包产物里的加载（`verify-theia-after-pack.cjs` 覆盖）。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

// __dirname = <repo>/apps/desktop/scripts/theia-staging-smoke → 上溯四层到仓库根
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const RUNTIME = path.join(REPO_ROOT, "vendor/theia-runtime");
const SOURCE = path.join(REPO_ROOT, "vendor/theia");

let total = 0;
let failed = 0;
function check(label, ok, detail) {
  total++;
  if (!ok) failed++;
  console.log((ok ? "  ok   " : "  FAIL ") + label + (ok || detail === undefined ? "" : `  ${JSON.stringify(detail)}`));
}

console.log("[1] 入库的运行时结构完整");
check("★ vendor/theia-runtime 存在", fs.existsSync(RUNTIME));
if (!fs.existsSync(RUNTIME)) {
  console.log("\nNOT-COVERED: 全部（runtime 不存在 —— 从 git 恢复：git checkout -- vendor/theia-runtime）");
  process.exit(1);
}

const sizeOf = dir => {
  let sum = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const st = fs.lstatSync(p);
    sum += st.isDirectory() ? sizeOf(p) : st.size;
  }
  return sum;
};
const bytes = sizeOf(RUNTIME);
check("★ 体积在合理区间（10–250 MiB）", bytes > 10 * 1048576 && bytes < 250 * 1048576, {
  mib: +(bytes / 1048576).toFixed(1),
});

for (const rel of [
  "package.json",
  "packages/plugin-ext/lib/hosted/node/plugin-host.js",
  "packages/plugin-ext-vscode/lib/node/plugin-vscode-init.js",
]) {
  check(`★ ${rel} 在`, fs.existsSync(path.join(RUNTIME, rel)));
}
for (const name of ["LICENSE-EPL", "NOTICE.md"]) {
  const p = path.join(RUNTIME, name);
  check(`★ ${name} 在且非空（EPL-2.0 分发义务）`, fs.existsSync(p) && fs.statSync(p).size > 0);
}
// `src/` 里可能有**真实的运行期资源**（不是 TypeScript 源码）。
// 实测 `packages/plugin-ext/src/main/browser/webview/pre/` 下有 host.js / main.js /
// service-worker.js，是 Webview 的运行脚本 —— 整目录跳过会导致扩展静默不激活。
// 所以判据是「没有 .ts 源码」，不是「没有 src 目录」。
{
  const tsFiles = [];
  (function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith(".d.ts")) tsFiles.push(path.relative(RUNTIME, p));
    }
  })(RUNTIME);
  check("★ 没带 TypeScript 源码（运行期不需要）", tsFiles.length === 0, { count: tsFiles.length, sample: tsFiles.slice(0, 3) });
}
check("★ 没带 .d.ts", (() => {
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (walk(p)) return true; continue; }
      if (e.name.endsWith(".d.ts")) return true;
    }
    return false;
  };
  return !walk(RUNTIME);
})());

// 入库版本必须是零软链 —— 软链进 git 跨平台必坏（junction 存绝对路径 / 真符号链接需提权）
function countLinks(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) { n++; continue; }
    if (st.isDirectory()) n += countLinks(p);
  }
  return n;
}
// `node_modules/@theia/*` 在 postinstall 之后**本来**就是 junction，所以要排除这一段
function countLinksExcludingLinked(dir) {
  let n = 0;
  const linkedRoot = path.join(RUNTIME, "node_modules", "@theia");
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) {
      // @theia 下的链接是 postinstall 该建的，不算违规
      if (path.dirname(p) === linkedRoot) continue;
      n++;
      continue;
    }
    if (st.isDirectory()) n += countLinksExcludingLinked(p);
  }
  return n;
}
check("★ 除 postinstall 建的 @theia 链接外，没有别的软链", countLinksExcludingLinked(RUNTIME) === 0);

console.log("[2] postinstall 建的包链接真的生效");
{
  const nmTheia = path.join(RUNTIME, "node_modules", "@theia");
  const hasPluginExt = fs.existsSync(path.join(nmTheia, "plugin-ext"));
  if (!hasPluginExt) {
    console.log("  （链接未建 —— 下面会明确报，这是 `pnpm install` 的 postinstall 干的）");
  }
  check("★ node_modules/@theia/plugin-ext 在（链接已建）", hasPluginExt);
  if (hasPluginExt) {
    // ★ 关键：链接必须指向**本树**，不能指向外部。
    //    指向外部时扩展的 activate() 会静默不执行 —— 宿主起来了、握手成功，
    //    只有命令表是空的。这是本仓库最难查的一个症状。
    let real = null;
    try { real = fs.realpathSync(path.join(nmTheia, "plugin-ext")); } catch { /* 下面红 */ }
    check("★ 链接指向本树的 packages/（不是外部目录）",
      real !== null && real.startsWith(path.join(RUNTIME, "packages")),
      { real, expectedPrefix: path.join(RUNTIME, "packages") });
  }
}

console.log("[3] ★ 入口能被真的 require（缺传递依赖会当场抛）");
{
  const isMissingDep = m =>
    /Cannot find module|ERR_MODULE_NOT_FOUND|is not defined in ES module scope/.test(m);
  for (const rel of [
    "packages/plugin-ext/lib/hosted/node/plugin-host.js",
    "packages/plugin-ext-vscode/lib/node/plugin-vscode-init.js",
  ]) {
    const abs = path.join(RUNTIME, rel);
    let error = null;
    try {
      const req = createRequire(path.join(RUNTIME, "package.json"));
      req(abs);
    } catch (e) { error = e; }
    const message = error === null ? "" : String(error.message);
    check(`★ ${rel} 的依赖闭包完整`, error === null || !isMissingDep(message), {
      message: message.split("\n")[0],
    });
    if (error !== null && /Unsupported fd type|process\.exit\(\) and it was prevented/.test(message)) {
      check(`  （更强证据）${path.basename(rel)} 已跑进业务逻辑，只是缺 RPC 通道`, true);
    }
  }
}

console.log("[4] 和 vendor/theia 的内容一致（防静默过期）");
{
  if (!fs.existsSync(SOURCE)) {
    console.log("  skip  vendor/theia 不在（A′ 模式，正常 clone 没有它）—— 无法比对");
  } else {
    // 只比运行期会读的类型
    const keep = n => /\.(js|json|cjs|mjs|node|wasm)$/.test(n) &&
      !n.endsWith(".d.ts") && !n.endsWith(".js.map") && !n.startsWith("tsconfig") && n !== ".eslintrc.js";
    // runtime **刻意不带** test/ 与 doc/ 目录（运行期不读，带上是纯体积）
    const skipDir = p => p.split("/").some(seg => seg === "test" || seg === "doc");
    const list = (root, sub) => {
      const out = new Map();
      const walk = d => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          const st = fs.lstatSync(p);
          if (st.isSymbolicLink()) continue;
          if (st.isDirectory()) { if (e.name !== "node_modules" || !sub) walk(p); continue; }
          const rel = path.relative(root, p).split(path.sep).join("/");
          if (keep(e.name) && !skipDir(rel)) out.set(rel, st.size);
        }
      };
      const base = path.join(root, sub);
      if (fs.existsSync(base)) walk(base);
      return out;
    };
    let mismatches = 0, samples = [];
    for (const sub of ["packages", "dev-packages"]) {
      // 只比**有 lib/ 的包** —— runtime 刻意不带未构建的包（它们没有运行期内容，
      // 带 package.json 也只是噪音）。这不是「过期」，是设计。
      const builtInSource = new Set(
        fs.existsSync(path.join(SOURCE, sub))
          ? fs.readdirSync(path.join(SOURCE, sub)).filter(n => fs.existsSync(path.join(SOURCE, sub, n, "lib")))
          : [],
      );
      const listFiltered = (root) => {
        const m = list(root, sub);
        const out = new Map();
        for (const [k, v] of m) {
          const pkg = k.split("/")[1];
          if (builtInSource.has(pkg)) out.set(k, v);
        }
        return out;
      };
      const a = listFiltered(SOURCE);
      const b = listFiltered(RUNTIME);
      for (const [k, v] of a) {
        if (!b.has(k)) { mismatches++; if (samples.length < 5) samples.push(`缺 ${k}`); }
        else if (b.get(k) !== v) { mismatches++; if (samples.length < 5) samples.push(`大小不同 ${k}`); }
      }
    }
    check("★ 运行期文件与 vendor/theia 一致（不一致就重跑 stage-theia-runtime.cjs）",
      mismatches === 0, { mismatches, samples });
  }
}

console.log("\nNOT-COVERED: 真 fork 子进程的 RPC 闭环（theia-installed-smoke / ext-mcode-e2e-smoke 覆盖）；打包产物里的加载（verify-theia-after-pack.cjs 覆盖）");
console.log(`theia-staging-smoke: ${total - failed}/${total} 通过`);
if (failed > 0) process.exitCode = 1;
