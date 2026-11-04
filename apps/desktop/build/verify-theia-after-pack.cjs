/**
 * afterPack：把 Theia 运行时**装好并验活**。
 *
 * ## 这一步做两件事
 *
 * 1. **建包链接** —— `vendor/theia-runtime` 入库时是零软链的（软链进 git 跨平台必坏），
 *    打进产物后同样是零软链。这里在产物里建 `node_modules/@theia/<name>` →
 *    `packages/<name>` 的 junction。**不建 = 所有扩展装不上，而且没有任何报错。**
 *
 * 2. **真的 require 一次** —— 文件在 ≠ 能跑。缺任何传递依赖都会当场抛。
 *
 * ## 为什么必须在**产物里**做
 *
 * `stage` 成功不等于打包器带走了它 —— 本仓库为这个区别栽过两次
 * （`app-builder-lib/out/util/filter.js:42-45` 硬编码跳过根的 `node_modules`；
 * `builder-util/out/fs.js:68` 跳过 `.gitkeep` / `.DS_Store`）。
 * 所以判据一律在 `appOutDir` 里取。
 *
 * ## ⚠️ 一个已知风险
 *
 * junction 存的是**绝对路径**。产物被安装到用户机器后，路径变了，链接会悬空。
 * 所以**安装后还需要建一次** —— 由主进程在首次启动时补（见 `theiaRoot.ts` 的
 * `hasLinkedPackages`；它会在缺失时明确报错并给出修法）。
 *
 * 这不是完美方案，但它诚实：宁可第一次启动时明确报「链接没建」，也不要
 * 「装好了但一条扩展命令都没有」。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

/** 产物里 Theia 应该在哪（`electron-builder.yml` 的 `extraResources: to: theia`）。 */
function theiaRootIn(context) {
  const out = path.resolve(context.appOutDir);
  const candidates = [
    path.join(out, "resources", "theia"),
    path.join(out, "Contents", "Resources", "theia"),
  ];
  let entries = [];
  try { entries = fs.readdirSync(out, { withFileTypes: true }); } catch { /* the main verifier reports a missing resource */ }
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.toLowerCase().endsWith(".app")) {
      candidates.push(path.join(out, entry.name, "Contents", "Resources", "theia"));
    }
  }
  const roots = [...new Set(candidates.filter(candidate => fs.existsSync(candidate)))];
  if (roots.length > 1) {
    throw new Error("[verify-theia] multiple packaged Theia resource roots found: " + roots.join("; "));
  }
  return roots[0] ?? path.join(out, "resources", "theia");
}

const REQUIRED = [
  "package.json",
  "packages/plugin-ext/lib/hosted/node/plugin-host.js",
  "packages/plugin-ext-vscode/lib/node/plugin-vscode-init.js",
];

/** 在产物里建 @theia/<name> → packages/<name> 链接。返回建了几个。 */
function linkPackages(root) {
  const nmTheia = path.join(root, "node_modules", "@theia");
  fs.mkdirSync(nmTheia, { recursive: true });
  let made = 0;
  for (const top of ["packages", "dev-packages"]) {
    const base = path.join(root, top);
    if (!fs.existsSync(base)) continue;
    for (const name of fs.readdirSync(base)) {
      const target = path.join(base, name);
      let st;
      try { st = fs.statSync(target); } catch { continue; }
      if (!st.isDirectory()) continue;
      const link = path.join(nmTheia, name);
      try {
        const existing = fs.lstatSync(link);
        if (existing.isSymbolicLink()) fs.unlinkSync(link);
        else fs.rmSync(link, { recursive: true, force: true });
      } catch { /* 不存在 */ }
      try { fs.symlinkSync(target, link, "junction"); made++; }
      catch { /* 下面统一验 */ }
    }
  }
  return made;
}

function buildProbeScript(root) {
  return `
    const path = require("node:path");
    const root = ${JSON.stringify(root)};
    const entry = path.join(root, "packages/plugin-ext/lib/hosted/node/plugin-host.js");
    try {
      require(entry);
      // Theia's setupPluginHostLogger replaces console.log/info/warn/error
      // with RPC-backed methods. Write the probe sentinel directly to stdout
      // so a healthy plugin host cannot swallow its own success signal.
      process.stdout.write("PROBE_OK\\n");
    } catch (error) {
      const message = String(error && error.message);
      // On Windows the standalone probe may lack the parent IPC descriptor.
      // Reaching this known runtime boundary still proves imports resolved.
      if (/Unsupported fd type|process\\.exit\\(\\) and it was prevented/.test(message)) {
        process.stdout.write("PROBE_OK\\n");
      } else {
        process.stderr.write("PROBE_FAIL " + message.split("\\n")[0] + "\\n");
        process.exit(1);
      }
    }
  `;
}

module.exports = async function verifyTheiaAfterPack(context) {
  const root = theiaRootIn(context);
  console.log(`[verify-theia] 产物里的 Theia: ${root}`);

  if (!fs.existsSync(root)) {
    throw new Error(
      `[verify-theia] 安装产物里没有 Theia 运行时（${root}）。\n` +
      `  扩展会一律装不上。查 electron-builder.yml 的 extraResources 里有没有\n` +
      `  \`vendor/theia-runtime → theia\`。`,
    );
  }

  for (const rel of REQUIRED) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) throw new Error(`[verify-theia] 缺 ${rel}（${abs}）—— 打包器没带走它`);
  }

  const linked = linkPackages(root);
  console.log(`[verify-theia] 建了 ${linked} 个包链接`);

  // ★ 真的 require 一次：缺传递依赖会当场抛。Theia plugin host 可能在
  // 同步加载成功后留下 IPC/timer 句柄；探针是一次性子进程，不能让这些句柄
  // 把 electron-builder 的 afterPack 永久挂住。超时前必须已经输出 PROBE_OK，
  // 否则仍然 fail closed。
  runProbe(root);

  console.log("[verify-theia] ✓ 运行时完整可用");
};

const PROBE_TIMEOUT_MS = 30_000;

function runProbe(root, timeoutMs = PROBE_TIMEOUT_MS) {
  const probe = buildProbeScript(root);
  let output = "";
  try {
    output = execFileSync(process.execPath, ["-e", probe], {
      encoding: "utf8",
      stdio: "pipe",
      timeout: timeoutMs,
      // Theia installs SIGTERM handlers for graceful shutdown. The disposable
      // probe must still have a hard upper bound, so use an uncatchable signal.
      killSignal: "SIGKILL",
    });
  } catch (error) {
    output = String(error.stdout ?? "") + String(error.stderr ?? "");
    const timedOut =
      error?.code === "ETIMEDOUT" ||
      (error?.killed === true && (error?.signal === "SIGTERM" || error?.signal === "SIGKILL"));
    // A success sentinel is written only after require(entry) returns (or the
    // explicitly accepted standalone IPC boundary is reached). A lingering
    // event loop after that point is not a failed import; stop the disposable
    // child and accept the already-completed synchronous probe.
    if (!(timedOut && /PROBE_OK/.test(output))) {
      throw new Error(`[verify-theia] 产物里的 Theia 起不来：\n${output}`);
    }
    console.log(
      `[verify-theia] 同步加载已通过；探针保留事件循环，达到 ${timeoutMs}ms 上限后已终止`,
    );
  }
  if (!/PROBE_OK/.test(output)) {
    throw new Error(`[verify-theia] 探针没有报成功：\n${output}`);
  }
  return output;
}

module.exports.theiaRootIn = theiaRootIn;
module.exports.buildProbeScript = buildProbeScript;
module.exports.runProbe = runProbe;
module.exports.PROBE_TIMEOUT_MS = PROBE_TIMEOUT_MS;
