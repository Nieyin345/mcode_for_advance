"use strict";
/**
 * 【T118】`extraResources` 复制 `.tmp/node-red-release` 时，`electron-builder`
 * **硬编码跳过根的 `node_modules`** —— 任何 filter 都改不了。
 *
 * `app-builder-lib/out/util/filter.js:42-45`：
 *
 * ```js
 * if (relative === "node_modules") {
 *   return false;        // ← 在 minimatchAll 之前，模式不参与
 * }
 * ```
 *
 * 而 `verify-node-red-after-pack.cjs:107` 明确要求产物里 `node_modules/` 存在，
 * 还要拿它的 `hashTree` 与 marker 的 digest 比。**所以打包必然在 afterPack 失败**，
 * 而那时 asar 已经打好了 —— **这才是「这个仓库从来没成功打包过」的真正原因。**
 *
 * ## 做法：源头改名 → 复制 → 产物里改回来
 *
 * 1. `beforePack`：`.tmp/node-red-release/node_modules` → `__mcode_node_modules`
 *    （于是它是个普通目录，`extraResources` 会复制）；
 * 2. `afterPack`：产物里 `resources/node-red/__mcode_node_modules` → `node_modules`
 *    （验证器要这个名字），**然后**把源目录改回去。
 *
 * **改名而不是复制**：暂存目录 134MB，复制一遍几十秒且可能中途失败留下半份。
 * 改名是同盘 rename，原子。
 *
 * **两条路都还原源目录**：成功和失败都要还原，否则 `t88` / `t19` 那些直接读
 * 暂存目录的套件会看到一棵缺 `node_modules` 的树。
 */
const fs = require("node:fs");
const path = require("node:path");

const STAGED = path.resolve(__dirname, "..", ".tmp", "node-red-release");
const ORIGINAL = path.join(STAGED, "node_modules");
const RENAMED = path.join(STAGED, "__mcode_node_modules");
/** 产物里的同名目录（electron-builder 会按 extraResources 的 to: node-red 放）。 */
const PACKED_RENAMED = "resources/node-red/__mcode_node_modules";
const PACKED_ORIGINAL = "resources/node-red/node_modules";

function renameIfPossible(from, to, label) {
  if (!fs.existsSync(from)) {
    if (fs.existsSync(to)) return false; // 已经换过了
    throw new Error(`[T118] ${label}: neither ${from} nor ${to} exists`);
  }
  if (fs.existsSync(to)) {
    throw new Error(`[T118] ${label}: both ${from} and ${to} exist — refusing to guess`);
  }
  fs.renameSync(from, to);
  return true;
}

/** beforePack：把源目录的根 node_modules 改名，让 extraResources 能复制它。 */
async function hideNodeModules() {
  if (!fs.existsSync(STAGED)) return; // 这次不打 node-red
  const changed = renameIfPossible(ORIGINAL, RENAMED, "beforePack");
  console.log(`[T118] beforePack: node_modules ${changed ? "hidden" : "already hidden"}`);
}

/**
 * afterPack 的**第一步**：把产物里的 `__mcode_node_modules` 改成 `node_modules`。
 * 必须在验证器之前跑 —— 它要的是 `node_modules` 这个名字。
 *
 * 找不到产物目录时**不报错**：那是 `MCODE_INCLUDE_*` 关闭、根本没复制的情况，
 * 验证器自己会给出正确的结论（它会报缺资源）。
 */
function restorePackedNodeModules(appOutDir) {
  const packedRenamed = path.join(appOutDir, PACKED_RENAMED);
  const packedOriginal = path.join(appOutDir, PACKED_ORIGINAL);
  if (!fs.existsSync(packedRenamed)) return false;
  renameIfPossible(packedRenamed, packedOriginal, "afterPack(packed)");
  console.log("[T118] afterPack: packed node_modules renamed to node_modules");
  return true;
}

/** afterPack 的**最后一步**：把源目录改回去（无论前面成功与否）。 */
function restoreSourceNodeModules() {
  if (!fs.existsSync(STAGED)) return;
  if (fs.existsSync(RENAMED) && !fs.existsSync(ORIGINAL)) {
    fs.renameSync(RENAMED, ORIGINAL);
    console.log("[T118] afterPack: source node_modules restored");
  }
}

module.exports = { hideNodeModules, restorePackedNodeModules, restoreSourceNodeModules, STAGED, ORIGINAL, RENAMED };
