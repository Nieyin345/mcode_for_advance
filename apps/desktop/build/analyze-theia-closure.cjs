/**
 * 算出 Theia plugin host 在**运行期**真正 require 的闭包，并统计体积。
 *
 * ## 为什么不能手写清单
 *
 * `plugin-ext` 依赖 30 个 `@theia/*` 包，那些包又各自依赖 npm 包。
 * 手写必然漏（漏了的表现是「打包后扩展起不来」，而在开发态永远复现不了）。
 * 所以从**真实入口**出发，用 Node 自己的 require 语义解析。
 *
 * ## 怎么算
 *
 * BFS：从一个入口文件出发，读它的 `require(...)` 字面量，解析成真实路径，再入队。
 *  - `@theia/x` → `vendor/theia/packages/x/...`（monorepo 里的软链）
 *  - 相对路径 → 同目录
 *  - 裸包名 → `node_modules/<name>`
 *
 * 解析不了的不报错，只记进 `external`（原生模块、条件 require 等）。
 *
 * 用法：node build/analyze-theia-closure.cjs [--entry <相对路径>]... [--json]
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const THEIA_ROOT = path.resolve(__dirname, "../../../vendor/theia");

const DEFAULT_ENTRIES = [
  "packages/plugin-ext/lib/hosted/node/plugin-host.js",
  "packages/plugin-ext-vscode/lib/node/plugin-vscode-init.js",
];

/** 只看静态 `require("literal")` 和 `import ... from "literal"` —— 动态拼接的不追。
 *
 * ## 为什么要连 `import` 一起扫
 *
 * 第一版只扫 `require()`。但 `@theia/monaco-editor-core` 的 `esm/` 是一棵
 * **原生 ESM** 树（`import * as arrays from '../../../base/common/arrays.js'`）。
 * 只扫 require 时，它被当成「一个文件」，复制过去之后 `require` 它在运行时
 * 才去 `import` 自己缺失的兄弟文件 —— 报 `ERR_MODULE_NOT_FOUND`，
 * 而堆栈指向的是 monaco 自己的文件。
 */
const REQUIRE_RE = /\brequire\(\s*["']([^"']+)["']\s*\)/g;
const IMPORT_FROM_RE = /\bimport\s+(?:[^"'()]*?\bfrom\s*)?["']([^"']+)["']/g;
const EXPORT_FROM_RE = /\bexport\s+(?:\*|\{[^}]*\})\s+from\s*["']([^"']+)["']/g;

function readRequires(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { requires: [], dynamic: 0 };
  }
  // 剥掉注释再扫 —— 否则注释里的示例代码会被当成真依赖
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");
  const requires = [];
  let dynamic = 0;
  let m;
  for (const re of [REQUIRE_RE, IMPORT_FROM_RE, EXPORT_FROM_RE]) {
    re.lastIndex = 0;
    while ((m = re.exec(stripped)) !== null) {
      const spec = m[1];
      if (!spec.startsWith(".") && !spec.startsWith("@") && !/^[a-z@]/.test(spec)) continue;
      if (!requires.includes(spec)) requires.push(spec);
    }
  }
  // 粗略统计动态 require（require(x) / require(`...`））—— 它们不会被上面的正则命中
  const dynamicRe = /\brequire\(\s*(?!["'])/g;
  while ((m = dynamicRe.exec(stripped)) !== null) dynamic++;
  return { requires, dynamic };
}

/**
 * 用 Node **自己的**解析器解析 specifier。
 *
 * ⚠️ 第一版手写了规则（`@theia/x` → `packages/x/lib`），结果漏掉了
 * `@theia/core/shared/inversify` 这类「包根下有 shared/ 目录」的路径 ——
 * 递归在 `@theia/core` 处就断了，于是 43 个外部模块解不出来、
 * 只跟到 310 个文件。这正是「用自己写的更弱的东西去替代真工具」那个形态。
 *
 * `require.resolve` 带 `paths` 参数时，就会按 Node 的真实语义找
 * （含 `main`、`index.js`、`node_modules` 上溯）—— 没有第二套规则。
 */
function resolveSpecifier(spec, fromFile) {
  try {
    return require.resolve(spec, { paths: [path.dirname(fromFile), THEIA_ROOT] });
  } catch {
    return null;
  }
}

function isInsideTheia(file) {
  return file.startsWith(THEIA_ROOT);
}

function packageOf(file) {
  const rel = path.relative(THEIA_ROOT, file);
  const parts = rel.split(path.sep);
  if (parts[0] === "packages" && parts.length > 2) return `@theia/${parts[1]}`;
  // ⚠️ `dev-packages/` 也是 @theia 包 —— `@theia/application-package` 住在这里，
  // 而 `@theia/core` 的 `lib/common/index.js` 直接 require 它的
  // `lib/environment`。第一版只认 `packages/`，于是它被归成 `other:dev-packages`，
  // staging 时不复制，`require` 当场 `Cannot find module`。
  if (parts[0] === "dev-packages" && parts.length > 2) return `@theia/${parts[1]}`;
  if (parts[0] === "node_modules") {
    const start = parts[1].startsWith("@") ? 1 : 0;
    const name = parts.slice(1, start + 2).join("/");
    return `npm:${name}`;
  }
  return `other:${parts[0]}`;
}

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const entries = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--entry" && args[i + 1]) entries.push(args[i + 1]);
  }
  const start = entries.length > 0 ? entries : DEFAULT_ENTRIES;

  const seen = new Set();
  const queue = [];
  const external = new Set();
  let dynamicTotal = 0;

  for (const e of start) {
    const abs = path.join(THEIA_ROOT, e);
    if (!fs.existsSync(abs)) {
      console.error(`入口不存在: ${abs}`);
      process.exit(2);
    }
    queue.push(abs);
    seen.add(abs);
  }

  while (queue.length > 0) {
    const file = queue.shift();
    if (!isInsideTheia(file)) continue;
    if (!file.endsWith(".js")) continue; // .json / .node 不追
    const { requires, dynamic } = readRequires(file);
    dynamicTotal += dynamic;
    for (const spec of requires) {
      // 只追 @theia/* 与相对路径；裸 npm 包按包名整体算（不逐个文件追，太慢且没必要）
      const resolved = resolveSpecifier(spec, file);
      if (!resolved) {
        if (!spec.startsWith(".")) external.add(spec);
        continue;
      }
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      // npm 包也要逐文件追 —— 否则算出来的体积只是入口文件，装不下真实依赖。
      // 但**不追 .node / .json**（原生二进制按所属包整体计，另算）。
      if (resolved.endsWith(".node") || resolved.endsWith(".json")) continue;
      queue.push(resolved);
    }
  }

  const byPackage = new Map();
  let bytes = 0;
  for (const file of seen) {
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    bytes += st.size;
    const pkg = packageOf(file);
    byPackage.set(pkg, (byPackage.get(pkg) ?? 0) + st.size);
  }

  const result = {
    entries: start,
    followedFiles: seen.size,
    // 相对 THEIA_ROOT 的精确文件列表 —— `stage-theia-resources.cjs` 按它逐个复制，
    // 而不是按包整目录复制（后者会把 src/、doc/、测试一起带进去）。
    followedFilesList: [...seen].map(f => path.relative(THEIA_ROOT, f).split(path.sep).join("/")),
    followedBytes: bytes,
    dynamicRequires: dynamicTotal,
    packages: [...byPackage.entries()].sort((a, b) => b[1] - a[1]).map(([name, size]) => ({ name, size })),
    unresolvedExternal: [...external].sort(),
  };

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`入口: ${start.join(", ")}`);
  console.log(`跟到的文件: ${seen.size}（${(bytes / 1024 / 1024).toFixed(1)} MiB）`);
  console.log(`动态 require（不追踪）: ${dynamicTotal}`);
  console.log("\n按包：");
  for (const { name, size } of result.packages) {
    console.log(`  ${(size / 1024).toFixed(0).padStart(7)} KiB  ${name}`);
  }
  console.log(`\n解析不了的外部模块（${external.size}）:`);
  for (const e of result.unresolvedExternal) console.log(`  ${e}`);
}

main();
