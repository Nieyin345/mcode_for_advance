/**
 * afterPack：验 Theia 运行时**真的进了安装产物**。
 *
 * ## 为什么必须有这一步
 *
 * `stage-theia-resources.cjs` 只是把文件摆到 `.tmp/theia-release`。
 * **摆好了不等于打包器带走了它** —— 本仓库为这个区别栽过两次：
 *
 *  - `app-builder-lib/out/util/filter.js:42-45` 硬编码跳过根的 `node_modules`；
 *  - `builder-util/out/fs.js:68` 硬编码跳过 `.gitkeep` 与 `.DS_Store`。
 *
 * 两处都是「配置写了但打包器不认」，报错指向下游症状而不是那两行。
 * 所以这里**在产物里查**，不在源目录查。
 *
 * ## 判据是「能不能 require」，不是「文件在不在」
 *
 * 和 `theia-staging-smoke` 同一条纪律：文件复制了 ≠ 能跑。
 * 这里用子进程真的 require 一次入口 —— 缺任何传递依赖都会当场抛。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

/** 产物里 Theia 应该在哪（`electron-builder.yml` 的 `extraResources: to: theia`）。 */
function theiaRootIn(context) {
  const resources = context.appOutDir;
  // mac: <app>/Contents/Resources；win/linux: <appOutDir>/resources
  const candidates = [
    path.join(resources, "resources", "theia"),
    path.join(resources, "Contents", "Resources", "theia"),
  ];
  return candidates.find(c => fs.existsSync(c)) ?? candidates[0];
}

const REQUIRED = [
  "package.json", // host.ts 用它判断「这是不是一个真的 Theia 检出」
  "packages/plugin-ext/lib/hosted/node/plugin-host.js",
  "packages/plugin-ext-vscode/lib/node/plugin-vscode-init.js",
];

module.exports = async function verifyTheiaAfterPack(context) {
  const root = theiaRootIn(context);
  console.log(`[verify-theia] 产物里的 Theia: ${root}`);

  if (!fs.existsSync(root)) {
    throw new Error(
      `[verify-theia] 安装产物里没有 Theia 运行时（${root}）。\n` +
      `  扩展会一律装不上（theia-root-missing）。\n` +
      `  查 electron-builder.yml 的 extraResources 里有没有 \`.tmp/theia-release → theia\`，\n` +
      `  以及 package 脚本有没有跑 \`stage-theia-resources.cjs\`。`,
    );
  }

  for (const rel of REQUIRED) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) {
      throw new Error(`[verify-theia] 缺 ${rel}（${abs}）—— 打包器没带走它`);
    }
  }

  // ★ 真的 require 一次：缺传递依赖会当场抛。
  // 用子进程而不是本进程 require —— afterPack 跑在 electron-builder 的进程里，
  // 在这里污染模块缓存不安全。
  const probe = `
    const path = require("node:path");
    const root = ${JSON.stringify(root)};
    const entry = path.join(root, "packages/plugin-ext/lib/hosted/node/plugin-host.js");
    try {
      require(entry);
      console.log("PROBE_OK");
    } catch (error) {
      const message = String(error && error.message);
      // 「跑进业务逻辑」= 依赖齐了（见 stage-theia-resources.cjs 里 tryRequire 的注释）
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
  if (!/PROBE_OK/.test(output)) {
    throw new Error(`[verify-theia] 探针没有报成功：\n${output}`);
  }

  const size = (function walk(dir) {
    let sum = 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      sum += e.isDirectory() ? walk(p) : fs.statSync(p).size;
    }
    return sum;
  })(root);
  console.log(`[verify-theia] ✓ 运行时完整可用（${(size / 1048576).toFixed(2)} MiB）`);
};
