/**
 * 装配 `vendor/theia-runtime/` —— **一份 clone 下来就能用的 Theia 运行时**。
 *
 * ## 目标
 *
 * `git clone` 之后扩展立刻可用：不跑 `npm install`、不跑 `tsc --build`。
 * 用户的原话：「下载 mcode 之后所有功能都是能用的，不需要额外去做任何事情」。
 *
 * ## 为什么必须自包含、零软链
 *
 * 上游 monorepo 用 `node_modules/@theia/<name>` → `packages/<name>` 的软链。
 * 软链进 git 有三条死路（都实测过）：
 *
 * | 方式 | 结果 |
 * |---|---|
 * | `junction` | 能用，但 Windows **存绝对路径**，换机器全悬空 |
 * | `"dir"` 软链 | Windows 非特权进程无权限创建（实测 0 个成功） |
 * | git 存 junction | git 把它当普通目录**展开**，但展开的是**指向外部的绝对路径** |
 *
 * 所以只能放**真实目录副本**。代价是体积翻倍，换跨平台。
 *
 * ## ★ 最关键的一条：`node_modules/@theia/<name>` 必须来自**本树**的 `packages/`
 *
 * 这是花了最多轮才定位的坑。如果 `node_modules/@theia/core` 是「另一份内容相同的副本」，
 * 或者指向外面的 `packages/core`，症状是：
 *
 * ```
 * 宿主起来了、握手成功、$activateByEvent 也 resolve 了，
 * 但 COMMANDS: []  —— 扩展的 activate() 从未执行，且**没有任何报错**
 * ```
 *
 * 实测对照：
 *  - `node_modules` 整体 junction 到 vendor → `COMMANDS: ["p.cmd"]` ✅
 *  - `@theia/core` junction 到**外部** vendor 的 packages → `[]` ❌
 *  - `@theia/core` junction 到**本树** probe6/packages → `["p.cmd"]` ✅
 *
 * 结论：Theia 在加载扩展时会做**路径一致性**判断，两棵树必须是同一份。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const HERE = __dirname;
const REPO_ROOT = path.resolve(HERE, "../../..");
const THEIA_ROOT = path.join(REPO_ROOT, "vendor/theia");
const OUT = path.join(REPO_ROOT, "vendor/theia-runtime");

const REQUIRED_ENTRIES = [
  "packages/plugin-ext/lib/hosted/node/plugin-host.js",
  "packages/plugin-ext-vscode/lib/node/plugin-vscode-init.js",
];

const LICENSE_FILES = [
  "LICENSE-EPL",
  "LICENSE-GPL-2.0-ONLY-CLASSPATH-EXCEPTION",
  "LICENSE-MIT.txt",
  "LICENSE-vscode.txt",
  "NOTICE.md",
];

const KEEP_EXT = new Set([".js", ".json", ".cjs", ".mjs", ".node", ".wasm"]);

function keepFile(name) {
  if (name.endsWith(".d.ts") || name.endsWith(".d.ts.map") || name.endsWith(".js.map")) return false;
  if (name.startsWith("tsconfig") || name === ".eslintrc.js") return false;
  return KEEP_EXT.has(path.extname(name));
}

/** 递归复制，把软链**解引用成真实内容**（本树内自洽）。
 *  跳过 `.git` / `test` / `doc`；`node_modules` 由调用方决定是否深入。 */
function copyTree(from, to, opts = {}) {
  const { skipNodeModules = false, skipSource = false } = opts;
  let n = 0;
  fs.mkdirSync(to, { recursive: true });
  let entries;
  try { entries = fs.readdirSync(from, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const s = path.join(from, e.name);
    const d = path.join(to, e.name);
    let st;
    try { st = fs.lstatSync(s); } catch { continue; }
    if (st.isSymbolicLink()) {
      // 解引用：把软链指向的真实内容复制过来
      let real;
      try { real = fs.realpathSync(s); } catch { continue; }
      let rst;
      try { rst = fs.statSync(real); } catch { continue; }
      if (rst.isDirectory()) n += copyTree(real, d, opts);
      else if (keepFile(e.name)) { fs.copyFileSync(real, d); n++; }
      continue;
    }
    if (st.isDirectory()) {
      if (e.name === ".git" || e.name === "test" || e.name === "doc") continue;
      if (skipNodeModules && e.name === "node_modules") continue;
      if (skipSource && e.name === "src") continue;
      n += copyTree(s, d, opts);
      continue;
    }
    if (!keepFile(e.name)) continue;
    fs.mkdirSync(path.dirname(d), { recursive: true });
    fs.copyFileSync(s, d);
    n++;
  }
  return n;
}

function main() {
  for (const rel of REQUIRED_ENTRIES) {
    if (!fs.existsSync(path.join(THEIA_ROOT, rel))) {
      console.error(
        `✗ vendor/theia 没构建好（缺 ${rel}）。\n` +
        `  按 vendor/README.md 构建一次再重跑。\n` +
        `  注意：vendor/theia-runtime 已入库，**正常 clone 不需要跑本脚本**。`,
      );
      process.exit(2);
    }
  }

  console.log(`① 清空 ${path.relative(REPO_ROOT, OUT)}…`);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  console.log("② 根清单与许可…");
  fs.copyFileSync(path.join(THEIA_ROOT, "package.json"), path.join(OUT, "package.json"));
  for (const name of LICENSE_FILES) {
    const f = path.join(THEIA_ROOT, name);
    if (fs.existsSync(f)) fs.copyFileSync(f, path.join(OUT, name));
  }
  const readme = path.join(THEIA_ROOT, "README.md");
  if (fs.existsSync(readme)) fs.copyFileSync(readme, path.join(OUT, "README.md"));

  // ── packages/ 与 dev-packages/：整份复制（这是「本树」的定义）──
  console.log("③ 复制 packages/ 与 dev-packages/…");
  let pkgFiles = 0;
  pkgFiles += copyTree(path.join(THEIA_ROOT, "packages"), path.join(OUT, "packages"));
  pkgFiles += copyTree(path.join(THEIA_ROOT, "dev-packages"), path.join(OUT, "dev-packages"));
  console.log(`   ${pkgFiles} 个文件`);

  // ── ★ node_modules/@theia/<name> 从**本树**复制（不是从 vendor 再读一遍）──
  //
  // 这是核心：必须复制 OUT/packages/<name>，不能复制 THEIA_ROOT/packages/<name>，
  // 否则两份内容一旦有任何差异，Theia 的路径一致性判断就会静默失败。
  console.log("④ node_modules/@theia/ 从本树 packages/ 复制…");
  let nmTheia = 0;
  for (const top of ["packages", "dev-packages"]) {
    const base = path.join(OUT, top);
    if (!fs.existsSync(base)) continue;
    for (const name of fs.readdirSync(base)) {
      const src = path.join(base, name);
      if (!fs.statSync(src).isDirectory()) continue;
      nmTheia += copyTree(src, path.join(OUT, "node_modules", "@theia", name));
    }
  }
  // 只在 vendor/node_modules 里的 @theia 包（如 monaco-editor-core）也从本树外复制一次
  const nmTheiaDir = path.join(THEIA_ROOT, "node_modules", "@theia");
  const inPackages = new Set(fs.readdirSync(path.join(OUT, "packages")));
  const inDev = new Set(fs.existsSync(path.join(OUT, "dev-packages")) ? fs.readdirSync(path.join(OUT, "dev-packages")) : []);
  for (const name of fs.readdirSync(nmTheiaDir)) {
    if (inPackages.has(name) || inDev.has(name)) continue;
    nmTheia += copyTree(path.join(nmTheiaDir, name), path.join(OUT, "node_modules", "@theia", name));
  }
  console.log(`   ${nmTheia} 个文件`);

  // ── npm 依赖：只带**运行时真正需要**的 ──
  //
  // 全量复制 vendor 的 node_modules 是 1.1 GB（含 tsc / webpack / playwright / nx
  // 等构建工具）。运行期只需要一个小得多的集合：
  //   ① require 闭包（从两个真实入口追出来的 113 个）；
  //   ② 各 @theia 包 `package.json` 里声明的 dependencies（269 个）。
  // 取并集。
  console.log("⑤ npm 依赖…");
  const wanted = new Set();
  // ① 闭包
  try {
    const { execFileSync } = require("node:child_process");
    const closure = JSON.parse(execFileSync(
      process.execPath,
      [path.join(HERE, "analyze-theia-closure.cjs"), "--json"],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    ));
    for (const { name } of closure.packages) {
      if (name.startsWith("npm:")) wanted.add(name.slice(4));
    }
  } catch { /* 闭包分析失败时退化为② */ }
  // ② 各包的 dependencies
  for (const top of ["packages", "dev-packages"]) {
    const base = path.join(OUT, top);
    if (!fs.existsSync(base)) continue;
    for (const name of fs.readdirSync(base)) {
      const pj = path.join(base, name, "package.json");
      if (!fs.existsSync(pj)) continue;
      try {
        const j = JSON.parse(fs.readFileSync(pj, "utf8"));
        for (const d of Object.keys(j.dependencies ?? {})) {
          if (!d.startsWith("@theia/")) wanted.add(d);
        }
      } catch { /* 跳过坏清单 */ }
    }
  }
  let npmFiles = 0;
  const copiedNpm = new Set();
  for (const name of wanted) {
    if (copiedNpm.has(name)) continue;
    copiedNpm.add(name);
    const s = path.join(THEIA_ROOT, "node_modules", name);
    if (!fs.existsSync(s)) continue;
    npmFiles += copyTree(s, path.join(OUT, "node_modules", name));
  }
  // 兜底：把 `node_modules/.bin` 之外的**顶层**目录里，名字出现在 wanted 的已覆盖；
  // 剩下没被 wanted 覆盖但被间接依赖的，由迭代自检补（见 ⑥）。
  console.log(`   ${copiedNpm.size} 个包 / ${npmFiles} 个文件`);

  // ── ⑥ 迭代自检：跑 require，缺什么补什么（在临时 junction 环境里）──
  //
  // 静态推导（闭包 + 清单）会漏。**让 Node 自己报缺什么**，比枚举可靠。
  // 这里临时建 junction 让 @theia/* 能用，检完就拆（入库版本保持零软链）。
  console.log("⑥ 迭代补齐依赖…");
  {
    const { createRequire } = require("node:module");
    const nmTheia = path.join(OUT, "node_modules", "@theia");
    const tempLinks = [];
    // 临时：把 @theia/* 建成 junction 指回本树 packages（只为了能 require）
    for (const top of ["packages", "dev-packages"]) {
      const base = path.join(OUT, top);
      if (!fs.existsSync(base)) continue;
      for (const name of fs.readdirSync(base)) {
        const src = path.join(base, name);
        if (!fs.statSync(src).isDirectory()) continue;
        const dst = path.join(nmTheia, name);
        fs.rmSync(dst, { recursive: true, force: true });
        try { fs.symlinkSync(src, dst, "junction"); tempLinks.push(dst); } catch { /* 跳过 */ }
      }
    }
    try {
      const req = createRequire(path.join(OUT, "package.json"));
      const fixed = new Set();
      for (let round = 0; round < 40; round++) {
        let progressed = false, lastError = null;
        for (const rel of ["@theia/plugin-ext/lib/hosted/node/plugin-host.js",
                           "@theia/plugin-ext-vscode/lib/node/plugin-vscode-init.js"]) {
          let err = null;
          try { req(rel); } catch (e) { err = e; }
          if (!err) continue;
          lastError = err;
          const m = /Cannot find module '([^']+)'/.exec(String(err.message));
          if (!m) continue;
          const spec = m[1];
          if (fixed.has(spec)) continue;
          fixed.add(spec);
          let pkgName = null;
          const fromPath = /[\\/]node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(spec);
          if (fromPath) pkgName = fromPath[1].replace(/\\/g, "/");
          else if (!spec.startsWith(".") && !path.isAbsolute(spec)) {
            const parts = spec.split("/");
            pkgName = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
          }
          if (!pkgName || pkgName.startsWith("@theia/")) continue;
          const s = path.join(THEIA_ROOT, "node_modules", pkgName);
          if (!fs.existsSync(s)) continue;
          const n = copyTree(s, path.join(OUT, "node_modules", pkgName));
          if (n > 0) { console.log(`   + ${pkgName}`); progressed = true; }
        }
        if (lastError === null) { console.log(`   ${round} 轮后依赖齐全`); break; }
        if (!progressed) { console.log(`   ⚠ 仍有缺失：${String(lastError.message).split("\n")[0].slice(0, 120)}`); break; }
      }
    } finally {
      // 拆掉临时 junction —— 入库版本必须零软链
      for (const l of tempLinks) { try { fs.unlinkSync(l); } catch { /* ignore */ } }
    }
  }

  // ── ⑦ 自检 ──
  console.log("⑦ 自检…");
  let bad = 0;
  for (const rel of REQUIRED_ENTRIES) {
    if (fs.existsSync(path.join(OUT, rel))) console.log(`   ✓ ${rel}`);
    else { console.error(`   ✗ 缺 ${rel}`); bad++; }
  }
  let links = 0;
  (function count(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      let st; try { st = fs.lstatSync(p); } catch { continue; }
      if (st.isSymbolicLink()) links++;
      else if (st.isDirectory()) count(p);
    }
  })(OUT);
  if (links > 0) { console.error(`   ✗ ${links} 个软链（进 git 后跨平台会失效）`); bad++; }
  else console.log("   ✓ 零软链");
  if (bad > 0) process.exit(1);

  const bytes = (function size(d) {
    let sum = 0;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const st = fs.lstatSync(p);
      sum += st.isDirectory() ? size(p) : st.size;
    }
    return sum;
  })(OUT);
  console.log(`\n✓ ${path.relative(REPO_ROOT, OUT)} 就绪：${(bytes / 1048576).toFixed(1)} MiB`);
}

main();
