/**
 * 迭代式装配：**跑一次 require，缺什么补什么，直到跑通。**
 *
 * ## 为什么不用「分析闭包 + 一次性复制」
 *
 * 我试过：从入口 BFS 扫 `require()` / `import`，得到 907 个文件。
 * 然后 staging 出来，`require` 它 —— 一个接一个地挂：
 *
 *   `@theia/core` 缺             → 建软链
 *   `@theia/application-package` → dev-packages 被漏掉
 *   `uuid/dist/cjs` 被当 ESM    → 漏了子目录的 package.json
 *   `monaco-editor-core`         → 原生 ESM 树，逐文件追不到
 *   `yargs`                      → `build/index.cjs` 是打包产物，内部动态 require
 *   `y18n`                       → yargs 的传递依赖，闭包根本没走到那一层
 *
 * 每一轮都在补一个启发式规则的洞。**这条路没有尽头** ——
 * 因为「用静态扫描预测运行时需要什么」本质上是在重新实现 Node 的模块解析，
 * 而且做得更差。
 *
 * ## 现在的做法
 *
 * **让 Node 告诉我缺什么。** 循环：
 *   1. 复制闭包（快，覆盖绝大部分）；
 *   2. 试着 require 每个入口；
 *   3. 失败 → 从 `Cannot find module 'X'` / `... imported from '<path>'` 里
 *      解析出缺失的模块，把它（及其所属包的整棵树）补进 staging；
 *   4. 回到 2，直到通过或轮数用尽。
 *
 * 这个循环的正确性不依赖「我有没有想到某种写法」—— 它依赖 Node 自己报错。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { execFileSync } = require("node:child_process");

const HERE = __dirname;
const REPO_ROOT = path.resolve(HERE, "../../..");
const THEIA_ROOT = path.join(REPO_ROOT, "vendor/theia");
// 产物直接落在 `vendor/theia-runtime` —— **这份要进 git**，是「clone 下来扩展就能用」
// 的唯一依赖。`.tmp` 那种临时目录不适合承载一个长期存在的运行时。
//
// `--out=<dir>` 可覆盖（`theia-staging-smoke` 用它做「生成物没过期」比对）。
const argOut = process.argv.find(a => a.startsWith("--out="));
const OUT = argOut
  ? path.resolve(REPO_ROOT, argOut.slice("--out=".length))
  : path.join(REPO_ROOT, "vendor/theia-runtime");

const ENTRIES = [
  "packages/plugin-ext/lib/hosted/node/plugin-host.js",
  "packages/plugin-ext-vscode/lib/node/plugin-vscode-init.js",
];

const MAX_ROUNDS = 40;

const LICENSE_FILES = [
  "LICENSE-EPL",
  "LICENSE-GPL-2.0-ONLY-CLASSPATH-EXCEPTION",
  "LICENSE-MIT.txt",
  "LICENSE-vscode.txt",
  "NOTICE.md",
];

const KEEP_EXTENSIONS = new Set([".js", ".json", ".cjs", ".mjs", ".node", ".wasm", ".mts", ".cts"]);

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function isRuntimeFile(name) {
  if (name.endsWith(".d.ts") || name.endsWith(".d.ts.map") || name.endsWith(".js.map")) return false;
  if (name.startsWith("tsconfig") || name === ".eslintrc.js") return false;
  return KEEP_EXTENSIONS.has(path.extname(name));
}

/** 复制一个目录的运行期文件（跳过 src/test/doc/node_modules）。 */
function copyRuntimeTree(fromDir, toDir, depth = 0) {
  if (depth > 16) return 0;
  let copied = 0;
  let entries;
  try { entries = fs.readdirSync(fromDir, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    const from = path.join(fromDir, entry.name);
    const to = path.join(toDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "src" || entry.name === "test" || entry.name === "doc" || entry.name === ".git") continue;
      if (entry.name === "node_modules") continue;
      copied += copyRuntimeTree(from, to, depth + 1);
      continue;
    }
    if (!isRuntimeFile(entry.name)) continue;
    copyFile(from, to);
    copied++;
  }
  return copied;
}

/** 把一个具体文件复制到 staging，并补上它向上到包根的所有 package.json（模块类型判据）。 */
function copyOneFile(absFile) {
  const to = path.join(OUT, path.relative(THEIA_ROOT, absFile));
  const existed = fs.existsSync(to);
  if (!existed) copyFile(absFile, to);
  // 祖先 package.json
  let dir = path.dirname(absFile);
  while (dir.startsWith(THEIA_ROOT) && dir !== THEIA_ROOT) {
    const manifest = path.join(dir, "package.json");
    if (fs.existsSync(manifest)) {
      const toManifest = path.join(OUT, path.relative(THEIA_ROOT, manifest));
      if (!fs.existsSync(toManifest)) copyFile(manifest, toManifest);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return existed ? 0 : 1;
}

/** 从 staging 的某个位置 require，看它能不能加载。返回 Error | null。
 *
 * ## ⚠️ 「跑起来了」不是「加载失败」
 *
 * `plugin-host.js` 是**进程入口**：加载到一半就会打印 `PLUGIN_HOST(<pid>) starting
 * instance`，然后去读 fd 3..7 的 RPC 通道。在没有那 5 个通道的环境里（比如这里，
 * 普通 node 进程），它会报 `Unsupported fd type: UNKNOWN` 并试图 `process.exit`。
 *
 * **那恰恰证明模块解析全通了** —— 它已经跑进业务逻辑了。
 * 所以判据必须是「**模块没解析失败**」，不是「require 没抛任何东西」：
 *
 * ```
 * 缺依赖     → Cannot find module / ERR_MODULE_NOT_FOUND   ← 真失败
 * 跑起来了   → Unsupported fd / process.exit                ← 成功
 * ```
 *
 * 第一版把后者也当失败，于是在装配**已经正确**的情况下报错。
 * 这正是「判据的名字比它检查的范围大」：它叫 `tryRequire`，但实际要问的是
 * 「依赖齐了吗」。
 */
function tryRequire(absFile) {
  try {
    const req = createRequire(absFile);
    req(absFile);
    return null;
  } catch (error) {
    const message = String(error && error.message);
    // 「已经跑进业务逻辑」的两种形态：进程入口尝试用真 RPC 通道 / 主动退出
    if (/Unsupported fd type|process\.exit\(\) and it was prevented/.test(message)) return null;
    return error;
  }
}

/** 从错误信息里解析「缺什么」。
 *  两种形态：
 *   - CJS: `Cannot find module 'y18n'` + `Require stack: - <file>`
 *   - ESM: `Cannot find module '<abs>' imported from <file>`
 *  返回 `{ spec, fromFile }` 或 null。 */
function parseMissing(error) {
  const message = String(error && error.message);
  const fromStack = /Require stack:\s*\n\s*-\s*(.+)/.exec(message);
  const fromImport = /imported from (.+?)(?:\n|$)/.exec(message);
  const spec = /Cannot find module '([^']+)'/.exec(message);
  if (!spec) return null;
  const fromFile = (fromStack?.[1] ?? fromImport?.[1] ?? "").trim();
  return { spec: spec[1], fromFile };
}

/** 在 vendor/theia 里解析 spec，返回绝对路径或 null。 */
function resolveInVendor(spec, fromFile) {
  try {
    // fromFile 是 staging 的路径；映射回 vendor 里对应的位置去解析
    const relFrom = fromFile.startsWith(OUT) ? path.relative(OUT, fromFile) : null;
    const vendorFrom = relFrom ? path.join(THEIA_ROOT, relFrom) : path.join(THEIA_ROOT, "packages/core/lib/index.js");
    const req = createRequire(vendorFrom);
    return req.resolve(spec);
  } catch {
    // spec 是绝对路径（ESM 的 imported from 形态）
    if (path.isAbsolute(spec)) {
      const rel = path.relative(OUT, spec);
      if (rel && !rel.startsWith("..")) {
        const vendorPath = path.join(THEIA_ROOT, rel);
        if (fs.existsSync(vendorPath)) return vendorPath;
      }
    }
    return null;
  }
}

/** 一个包名（`@scope/name` / `name`）。 */
function packageNameOf(absFile) {
  const rel = path.relative(THEIA_ROOT, absFile).split(path.sep).join("/");
  const m = /^node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(rel);
  if (m) return m[1];
  const d = /^(dev-packages|packages)\/([^/]+)/.exec(rel);
  if (d) return `@theia/${d[2]}`;
  return null;
}

/** 递归地复制一个 npm 包，**连同它依赖的所有包**。
 *
 * ## 为什么不能只复制「缺的那一个包」
 *
 * 迭代循环会发现 `yargs` 缺 `y18n`，补上 `y18n` 后下一轮发现缺 `cliui`，
 * 再下一轮缺 `string-width`…… 链条可能有十几层。
 * 更糟的是**嵌套的同名包**：`yargs/node_modules/string-width@4` 和顶层
 * `string-width@5` 是两个不同的包，按「包名」去补会补错版本。
 *
 * 所以碰到一个 npm 包，就把它的**整棵依赖子图**一次性带过来 ——
 * 包括它自己 `node_modules/` 下的嵌套依赖（那些才是版本正确的）。
 */
function copyPackageWithDeps(pkgName, seen = new Set()) {
  if (seen.has(pkgName)) return 0;
  seen.add(pkgName);
  const dir = path.join(THEIA_ROOT, "node_modules", pkgName);
  if (!fs.existsSync(dir)) return 0;
  let n = copyRuntimeTree(dir, path.join(OUT, "node_modules", pkgName));
  const pj = path.join(dir, "package.json");
  if (fs.existsSync(pj)) { copyFile(pj, path.join(OUT, "node_modules", pkgName, "package.json")); n++; }

  // 它自己的嵌套 node_modules：整棵带走（版本由它自己锁定）
  const nested = path.join(dir, "node_modules");
  if (fs.existsSync(nested)) {
    for (const child of fs.readdirSync(nested, { withFileTypes: true })) {
      if (!child.isDirectory()) continue;
      if (child.name.startsWith("@")) {
        for (const scoped of fs.readdirSync(path.join(nested, child.name), { withFileTypes: true })) {
          if (!scoped.isDirectory()) continue;
          n += copyRuntimeTree(
            path.join(nested, child.name, scoped.name),
            path.join(OUT, "node_modules", pkgName, "node_modules", child.name, scoped.name),
          );
        }
      } else {
        n += copyRuntimeTree(
          path.join(nested, child.name),
          path.join(OUT, "node_modules", pkgName, "node_modules", child.name),
        );
      }
    }
  }

  // 它的直接依赖：递归带过来
  let depNames = [];
  try {
    const manifest = JSON.parse(fs.readFileSync(pj, "utf8"));
    depNames = Object.keys(manifest.dependencies ?? {});
  } catch { /* 没有 manifest */ }
  for (const dep of depNames) {
    n += copyPackageWithDeps(dep, seen);
  }
  return n;
}

function main() {
  if (!fs.existsSync(path.join(THEIA_ROOT, "packages/plugin-ext/lib/hosted/node/plugin-host.js"))) {
    console.error("✗ vendor/theia 没构建好。按 vendor/README.md 构建后重跑。");
    process.exit(2);
  }

  console.log("① 计算 require 闭包（作为起点）…");
  let copied = 0;
  try {
    const closureJson = execFileSync(
      process.execPath,
      [path.join(HERE, "analyze-theia-closure.cjs"), "--json"],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    const closure = JSON.parse(closureJson);
    console.log(`   起点 ${closure.followedFiles} 个文件 / ${(closure.followedBytes / 1048576).toFixed(2)} MiB`);
    fs.rmSync(OUT, { recursive: true, force: true });
    fs.mkdirSync(OUT, { recursive: true });
    for (const rel of closure.followedFilesList ?? []) {
      const from = path.join(THEIA_ROOT, rel);
      if (fs.existsSync(from)) copied += copyOneFile(from);
    }
  } catch (error) {
    console.log(`   闭包分析失败（${error.message.split("\n")[0]}），从空目录开始，靠迭代补齐`);
    fs.rmSync(OUT, { recursive: true, force: true });
    fs.mkdirSync(OUT, { recursive: true });
  }

  console.log("② 建 @theia/* 软链…");
  {
    const nmTheia = path.join(OUT, "node_modules", "@theia");
    fs.mkdirSync(nmTheia, { recursive: true });
    let linked = 0;
    for (const top of ["packages", "dev-packages"]) {
      const base = path.join(OUT, top);
      if (!fs.existsSync(base)) continue;
      for (const name of fs.readdirSync(base)) {
        const target = path.join(base, name);
        if (!fs.statSync(target).isDirectory()) continue;
        const linkPath = path.join(nmTheia, name);
        if (fs.existsSync(linkPath)) continue;
        try {
          // ⚠️ 必须用 `"dir"` 而不是 `"junction"`。
          // Windows 的 junction 会**把目标强制解析成绝对路径**（Node 的已知行为），
          // 于是一棵为 A 机器装配的产物搬到 B 机器后所有软链全部悬空。
          // 我们这份产物要**入 git** 给别人 clone，绝对路径必炸。
          fs.symlinkSync(path.relative(nmTheia, target), linkPath, "dir");
          linked++;
        } catch { /* 已存在 */ }
      }
    }
    console.log(`   ${linked} 个软链`);
  }

  console.log("③ 迭代补齐：跑一次 require，缺什么补什么…");
  const fixed = new Set();
  let round = 0;
  let allOk = false;
  for (; round < MAX_ROUNDS; round++) {
    let progressed = false;
    let lastError = null;
    for (const rel of ENTRIES) {
      const abs = path.join(OUT, rel);
      if (!fs.existsSync(abs)) { lastError = new Error(`入口缺失: ${rel}`); continue; }
      const error = tryRequire(abs);
      if (!error) continue;
      lastError = error;
      const missing = parseMissing(error);
      if (!missing || !missing.fromFile) continue;
      const resolved = resolveInVendor(missing.spec, missing.fromFile);
      if (!resolved) {
        console.log(`   ? 解析不到 ${missing.spec}（来自 ${path.relative(OUT, missing.fromFile)}）—— 可能是可选依赖`);
        continue;
      }
      // ⚠️ 去重 key 用**解析后的真实路径**，不是包名 ——
      // `yargs/node_modules/string-width@4` 和顶层 `string-width@5` 是两个不同的包，
      // 按包名去重会把后者当成「已经补过」，于是循环卡死在一句 `Cannot find module` 上。
      const dedupeKey = resolved;
      if (fixed.has(dedupeKey)) continue;
      fixed.add(dedupeKey);
      const pkg = packageNameOf(resolved);
      if (pkg && pkg.startsWith("@theia/")) {
        // @theia 包：整包（lib/ 树不大）
        const shortName = pkg.slice("@theia/".length);
        for (const top of ["packages", "dev-packages"]) {
          const dir = path.join(THEIA_ROOT, top, shortName);
          if (!fs.existsSync(dir)) continue;
          copied += copyRuntimeTree(dir, path.join(OUT, top, shortName));
          // package.json 必须补
          const pj = path.join(dir, "package.json");
          if (fs.existsSync(pj)) copyFile(pj, path.join(OUT, top, shortName, "package.json"));
          // 软链
          const nmTheia = path.join(OUT, "node_modules", "@theia");
          const linkPath = path.join(nmTheia, shortName);
          if (!fs.existsSync(linkPath)) {
            try { fs.symlinkSync(path.relative(nmTheia, path.join(OUT, top, shortName)), linkPath, "dir"); } catch { /* ignore */ }
          }
          break;
        }
        console.log(`   + @theia/${shortName}（整包）`);
      } else if (pkg) {
        // npm 包：**连同它的全部依赖子图**（含嵌套 node_modules 与传递依赖）。
        // 只补「缺的那一个」会让循环跑十几轮，而且嵌套同名包会补错版本。
        const n = copyPackageWithDeps(pkg);
        copied += n;
        console.log(`   + ${pkg}（含依赖子图，${n} 个文件）`);
      } else {
        copied += copyOneFile(resolved);
      }
      progressed = true;
    }
    if (lastError === null) { allOk = true; break; }
    if (!progressed) break;
  }
  console.log(`   ${round} 轮后${allOk ? "通过" : "仍有失败"}`);

  console.log("④ 补许可文件与根清单…");
  for (const name of LICENSE_FILES) {
    const from = path.join(THEIA_ROOT, name);
    if (fs.existsSync(from)) copyFile(from, path.join(OUT, name));
  }
  const readme = path.join(THEIA_ROOT, "README.md");
  if (fs.existsSync(readme)) copyFile(readme, path.join(OUT, "README.md"));
  // ⚠️ 上游 monorepo 根的 `package.json` 是**运行时判据**，不是装饰：
  // `host.ts` 的 `loadTheiaModules()` 用它判断「这是不是一个真的 Theia 检出」，
  // 缺了会抛 `theia-root-missing`。第一版没带，于是 staging 能 require 但起不了宿主。
  const rootManifest = path.join(THEIA_ROOT, "package.json");
  if (fs.existsSync(rootManifest)) copyFile(rootManifest, path.join(OUT, "package.json"));
  else { console.error("   ✗ vendor/theia/package.json 不存在"); process.exit(1); }

  console.log("⑤ 最终自检…");
  let bad = 0;
  for (const rel of ENTRIES) {
    const error = tryRequire(path.join(OUT, rel));
    if (error) {
      console.error(`   ✗ ${rel}: ${String(error.message).split("\n")[0]}`);
      bad++;
    } else {
      console.log(`   ✓ ${rel}`);
    }
  }
  if (bad > 0) {
    console.error("\n✗ 装配失败：staging 跑不起来（打包会产出一个装不进扩展的 app）");
    process.exit(1);
  }

  const totalBytes = (function size(dir) {
    let sum = 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) sum += size(p);
      else sum += fs.statSync(p).size;
    }
    return sum;
  })(OUT);
  console.log(`\n✓ ${path.relative(REPO_ROOT, OUT)} 就绪：${(totalBytes / 1048576).toFixed(2)} MiB（复制 ${copied} 个文件）`);
}

main();
