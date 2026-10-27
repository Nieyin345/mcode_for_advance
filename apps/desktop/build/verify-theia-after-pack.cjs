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
  const out = context.appOutDir;
  return [
    path.join(out, "resources", "theia"),
    path.join(out, "Contents", "Resources", "theia"),
  ].find(c => fs.existsSync(c)) ?? path.join(out, "resources", "theia");
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

  // ★ 真的 require 一次：缺传递依赖会当场抛。
  const probe = `
    const path = require("node:path");
    const root = ${JSON.stringify(root)};
    const entry = path.join(root, "packages/plugin-ext/lib/hosted/node/plugin-host.js");
    try {
      require(entry);
      console.log("PROBE_OK");
    } catch (error) {
      const message = String(error && error.message);
      // 「跑进业务逻辑」= 依赖齐了（缺 RPC 通道是正常的，那 5 个 fd 由主进程给）
      if (/Unsupported fd type|process\\.exit\\(\\) and it was prevented/.test(message)) {
        console.log("PROBE_OK");
      } else {
        console.error("PROBE_FAIL " + message.split("\\n")[0]);
        process.exit(1);
      }
    }
  `;
  let output = "";
  try {
    output = execFileSync(process.execPath, ["-e", probe], { encoding: "utf8", stdio: "pipe" });
  } catch (error) {
    output = String(error.stdout ?? "") + String(error.stderr ?? "");
    throw new Error(`[verify-theia] 产物里的 Theia 起不来：\n${output}`);
  }
  if (!/PROBE_OK/.test(output)) throw new Error(`[verify-theia] 探针没有报成功：\n${output}`);

  console.log("[verify-theia] ✓ 运行时完整可用");
};
