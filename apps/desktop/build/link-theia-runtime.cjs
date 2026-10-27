/**
 * 把 `vendor/theia-runtime/node_modules/@theia/<name>` 建成指向**本树**
 * `vendor/theia-runtime/packages/<name>` 的 junction。
 *
 * ## 为什么需要这一步
 *
 * Theia 的 monorepo 用 `node_modules/@theia/<name>` → `packages/<name>` 的软链来解析包名。
 * 软链**不能进 git**（Windows 的 junction 存绝对路径、真符号链接要提权），
 * 所以入库的是真实目录，**clone 之后必须重建这些链接**。
 *
 * 这就是 `postinstall` 干的唯一一件事：本地建立 92 个 junction，1 秒钟，不联网。
 *
 * ## ⚠️ 为什么不用「真实目录副本」代替
 *
 * 试过，**不行**。实测（`apps/desktop/scripts/theia-runtime-smoke`）：
 *
 * | `node_modules/@theia/core` 的形态 | 结果 |
 * |---|---|
 * | junction → 本树 `packages/core` | `COMMANDS: ["p.cmd"]` ✅ |
 * | **真实目录副本**（内容字节一致） | `COMMANDS: []` ❌ **没有任何报错** |
 *
 * Theia 在加载扩展时会做路径一致性判断。副本让「同一个包出现在两条不同路径下」，
 * 扩展的 `activate()` 就静默不执行 —— 宿主起来了、握手成功、`$activateByEvent`
 * 也 resolve 了，只有命令表是空的。**这是本仓库最难查的一个症状，别用副本。**
 *
 * ## 权限
 *
 * `junction` 在 Windows 上**不需要管理员权限**（实测通过）；真符号链接
 * （`"dir"`）需要，实测 `EPERM`。所以只用 `"junction"`，不用 `"dir"`。
 *
 * ## 失败时要吵
 *
 * 建不出来就明确报错并退出非零 —— 绝不静默跳过。否则症状是「装好了但扩展不能用」，
 * 而那时没人会想到是这一步没跑。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "../../..");
const RUNTIME = path.join(REPO_ROOT, "vendor/theia-runtime");
const NM_THEIA = path.join(RUNTIME, "node_modules", "@theia");

function main() {
  if (!fs.existsSync(path.join(RUNTIME, "package.json"))) {
    console.error(
      `[theia-runtime] 找不到 ${RUNTIME}。\n` +
      `  它应该随仓库一起来。如果你是 clone 的，先确认 vendor/theia-runtime 存在；\n` +
      `  如果你删过它，从 git 恢复：git checkout -- vendor/theia-runtime`,
    );
    process.exit(1);
  }

  fs.mkdirSync(NM_THEIA, { recursive: true });

  let made = 0, kept = 0, failed = [];

  for (const top of ["packages", "dev-packages"]) {
    const base = path.join(RUNTIME, top);
    if (!fs.existsSync(base)) continue;
    for (const name of fs.readdirSync(base)) {
      const target = path.join(base, name);
      let st;
      try { st = fs.statSync(target); } catch { continue; }
      if (!st.isDirectory()) continue;

      const linkPath = path.join(NM_THEIA, name);

      // 已经是正确的 junction 就跳过（幂等：重复跑 pnpm install 不会出事）
      let existing = null;
      try { existing = fs.lstatSync(linkPath); } catch { /* 不存在 */ }
      if (existing) {
        if (existing.isSymbolicLink()) {
          try { if (fs.realpathSync(linkPath) === fs.realpathSync(target)) { kept++; continue; } }
          catch { /* 悬空链接，重建 */ }
          fs.unlinkSync(linkPath);
        } else {
          // 真实目录副本 —— 正是那个会静默破坏扩展激活的形态，必须换掉
          fs.rmSync(linkPath, { recursive: true, force: true });
        }
      }

      try {
        fs.symlinkSync(target, linkPath, "junction");
        made++;
      } catch (error) {
        failed.push(`${name}: ${error.code ?? error.message}`);
      }
    }
  }

  if (failed.length > 0) {
    console.error(
      `[theia-runtime] ✗ ${failed.length} 个链接没建成，扩展会装不上：\n  ${failed.join("\n  ")}\n` +
      `  junction 在 Windows 上不需要管理员权限；如果你在受限环境里，\n` +
      `  可以在「设置 → 隐私和安全性 → 开发者选项」里打开开发者模式后重试。`,
    );
    process.exit(1);
  }

  console.log(`[theia-runtime] ✓ ${made} 个新建 / ${kept} 个已存在（共 ${made + kept}）`);
}

main();
