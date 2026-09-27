/**
 * Dereference pnpm WORKSPACE symlinks that point outside the app dir.
 *
 * electron-builder's asar packager walks node_modules and follows symlinks.
 * pnpm workspaces symlink the workspace package (e.g. @mcode/contracts)
 * to ../../../../packages/contracts, which resolves OUTSIDE apps/desktop and
 * whose path contains no "node_modules" segment. The packager then throws
 * "path must be under appDir" because the real path neither starts with the app
 * dir nor contains node_modules (the two cases getRelativePath allows).
 *
 * Regular .pnpm symlinks are fine - their paths contain "node_modules", which
 * the packager handles. Only workspace packages (under @mcode/) point
 * outside via a packages/ path, so we dereference ONLY those.
 *
 * This script replaces just the @mcode/* symlinks with real directory
 * copies. It's idempotent and leaves native modules (.pnpm symlinks) intact so
 * @electron/rebuild can still rebuild them.
 *
 * Run from apps/desktop: `node build/dereference-workspace-symlinks.cjs`
 */
"use strict";
const { readdirSync, readlinkSync, renameSync, rmSync, lstatSync, cpSync } = require("node:fs");
const { dirname, join, resolve } = require("node:path");

const appDir = resolve(__dirname, "..");
const scopedDir = join(appDir, "node_modules", "@mcode");

let count = 0;
let entries;
try {
  entries = readdirSync(scopedDir);
} catch {
  console.log("[dereference] no @mcode scope in node_modules - nothing to do");
  process.exit(0);
}

for (const name of entries) {
  const full = join(scopedDir, name);
  let st;
  try {
    st = lstatSync(full);
  } catch {
    continue;
  }
  if (!st.isSymbolicLink()) continue;

  let target;
  try {
    target = resolve(dirname(full), readlinkSync(full));
  } catch {
    continue;
  }

  // Only dereference if the symlink resolves outside the app dir. Workspace
  // packages point to ../../../../packages/* (outside); regular deps stay put.
  if (!target.startsWith(appDir)) {
    // 先拷到旁边、再换过去。原来的顺序是「先删链接、再拷贝」:拷贝一旦失败
    // (目标已被清掉、磁盘满、文件被占用),node_modules 里就只剩一个空洞——
    // 而当时只是 warn 且**退 0**,于是 `package` 脚本的 `&&` 链照样走到
    // electron-builder,打出一个缺了工作区包的安装包:装上能启动,用到那块才崩。
    const staging = `${full}.deref-tmp`;
    try {
      rmSync(staging, { recursive: true, force: true });
      cpSync(target, staging, { recursive: true, dereference: true });
      rmSync(full, { recursive: true, force: true });
      renameSync(staging, full);
      count++;
      console.log(`[dereference] ${name}: ${target} -> real copy`);
    } catch (err) {
      rmSync(staging, { recursive: true, force: true });
      console.error(`[dereference] FAILED ${name}: ${target} -> ${err.message}`);
      console.error("[dereference] 打包中止:asar 里会缺这个工作区包。原链接保持原样,修好后重跑。");
      process.exit(1);
    }
  }
}

console.log(`[dereference] replaced ${count} workspace symlink(s) with real copies`);
