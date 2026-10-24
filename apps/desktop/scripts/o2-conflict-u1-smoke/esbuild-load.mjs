/**
 * O2 —— 用仓库**已安装的 esbuild** 打一小段 TS（不新增依赖）。
 *
 * 为什么需要它：`save-paths.ts` 要能在**不启动 Electron** 的前提下被
 * `run.mjs`（普通 Node ESM）直接执行 —— 而它是 TS。仓库里所有 smoke 都用
 * esbuild 做这一步；这里直接复用 `node_modules/.pnpm` 里那一份，与
 * `electron-u1/build.mjs` 的解析方式同源（`readdirSync` 取最新 `esbuild@`）。
 */
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** 解析已安装的 esbuild（与 `electron-u1/build.mjs` 的 `pkgPath` 同一做法）。 */
async function loadEsbuild() {
  const pnpm = resolve(process.cwd(), "../../node_modules/.pnpm");
  const dir = readdirSync(pnpm).filter((n) => n.startsWith("esbuild@")).sort().at(-1);
  if (!dir) throw new Error(`O2: 找不到已安装的 esbuild（${pnpm}）`);
  const entry = join(pnpm, dir, "node_modules/esbuild/lib/main.js");
  const mod = await import(pathToFileURL(entry).href);
  return mod.build ?? mod.default.build;
}

/** 把 `entry`（TS）打成 CJS，返回产物绝对路径。**异步**：`await buildTs(...)`。 */
export async function buildTs(entry, outfile) {
  const build = await loadEsbuild();
  if (typeof build !== "function") throw new Error("O2: esbuild 入口没有 .build");
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "error",
  });
  return outfile;
}
