/**
 * 验收 `.tmp/theia-release`：**这个最小树真的能启动 plugin host 吗。**
 *
 * ## 为什么必须单独验这一步
 *
 * `stage-theia-resources.cjs` 自检「入口文件在不在」—— 那只证明**文件被复制了**，
 * 不证明**它能跑**。本仓库为这个区别栽过：断言测的是「东西存在」，而结论要的是「东西能用」。
 *
 * 闭合方式是**行为判据**：直接从 staging 目录 `require` 那个入口，看它能不能加载。
 * 缺任何传递依赖，`require` 会当场抛出 `Cannot find module`。
 *
 * ## 它不验什么
 *
 * - 不 `fork` 真进程（那需要 Electron 主进程提供的 RPC 通道；`theia-installed-smoke` 验那层）；
 * - 不验 `vscode.*` 的行为（palette / installed 套件验）。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

// __dirname = <repo>/apps/desktop/scripts/theia-staging-smoke → 上溯四层到仓库根
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const STAGE = path.join(REPO_ROOT, ".tmp/theia-release");

let total = 0;
let failed = 0;
function check(label, ok, detail) {
  total++;
  if (!ok) failed++;
  console.log((ok ? "  ok   " : "  FAIL ") + label + (ok || detail === undefined ? "" : `  ${JSON.stringify(detail)}`));
}

console.log("[1] staging 目录存在且是「最小」的");
check("★ .tmp/theia-release 存在", fs.existsSync(STAGE));
if (!fs.existsSync(STAGE)) {
  console.log("\nNOT-COVERED: 全部（staging 未生成，先跑 node apps/desktop/build/stage-theia-resources.cjs）");
  process.exit(1);
}

const THEIA_ROOT = path.join(REPO_ROOT, "vendor/theia");
const sizeOf = dir => {
  let sum = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    sum += e.isDirectory() ? sizeOf(p) : fs.statSync(p).size;
  }
  return sum;
};
const stageBytes = sizeOf(STAGE);
check("★ 小于 60 MiB（不是把整个 1.3 GB 检出塞进来）", stageBytes < 60 * 1024 * 1024, {
  mib: +(stageBytes / 1048576).toFixed(2),
});

check("★ 没有带 src/ 源码树", !fs.existsSync(path.join(STAGE, "packages/plugin-ext/src")));
check("★ 没有带 .d.ts（运行期不需要）", (() => {
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (walk(p)) return true; continue; }
      if (e.name.endsWith(".d.ts")) return true;
    }
    return false;
  };
  return !walk(STAGE);
})());

console.log("[2] 许可文件随分发（EPL-2.0 义务）");
for (const name of ["LICENSE-EPL", "NOTICE.md"]) {
  const p = path.join(STAGE, name);
  check(`★ ${name} 在且非空`, fs.existsSync(p) && fs.statSync(p).size > 0);
}

console.log("[3] ★ 关键：入口能被 Node 真的 require 起来（缺传递依赖会当场抛）");
{
  // ⚠️ **判据是「模块解析全通」，不是「require 没抛任何东西」。**
  //
  // `plugin-host.js` 是进程入口：加载到一半就打印 `PLUGIN_HOST(<pid>) starting instance`，
  // 然后去读 fd 3..7 的 RPC 通道。这里没有那 5 个通道，于是它报
  // `Unsupported fd type: UNKNOWN` 并尝试 `process.exit`。
  //
  // **那恰恰证明依赖齐了** —— 它已经跑进业务逻辑。真正要抓的是这两句：
  //   Cannot find module / ERR_MODULE_NOT_FOUND
  //
  // 第一版把「跑起来了」也当失败，于是在装配**已经正确**的情况下报红。
  const isMissingDep = message =>
    /Cannot find module|ERR_MODULE_NOT_FOUND|is not defined in ES module scope/.test(message);

  for (const rel of [
    "packages/plugin-ext/lib/hosted/node/plugin-host.js",
    "packages/plugin-ext-vscode/lib/node/plugin-vscode-init.js",
  ]) {
    const abs = path.join(STAGE, rel);
    let error = null;
    try {
      // eslint-disable-next-line import/no-dynamic-require
      require(abs);
    } catch (e) {
      error = e;
    }
    const message = error === null ? "" : String(error.message);
    check(`★ ${rel} 的依赖闭包是完整的`, error === null || !isMissingDep(message), {
      message: message.split("\n")[0],
    });
    // 如果它真的跑起来了（报的是通道问题），那是一条**更强的**证据，单独记一笔
    if (error !== null && /Unsupported fd type|process\.exit\(\) and it was prevented/.test(message)) {
      check(`  （更强证据）${path.basename(rel)} 已跑进业务逻辑，只是缺 RPC 通道`, true);
    }
  }
}

console.log("[4] 对照组：从 staging require 的确实不是 vendor 里的那一份");
{
  // 如果 require 悄悄回退到了 vendor/theia，上面第 3 组会因为「跑通了」而绿，
  // 但结论（staging 自足）是假的。所以钉住「解析出的路径在 staging 下」。
  const resolved = require.resolve(path.join(STAGE, "packages/plugin-ext/lib/hosted/node/plugin-host.js"));
  check("★ 解析到的路径在 .tmp/theia-release 下",
    resolved.startsWith(STAGE), { resolved, stage: STAGE });
  check("★ 不在 vendor/theia 下",
    !resolved.startsWith(THEIA_ROOT), { resolved });
}

console.log("\nNOT-COVERED: 真 fork 子进程的 RPC 闭环（theia-installed-smoke / ext-mcode-e2e-smoke 覆盖）；原生模块（node-pty）在打包产物里的加载");
console.log(`theia-staging-smoke: ${total - failed}/${total} 通过`);
if (failed > 0) process.exitCode = 1;
