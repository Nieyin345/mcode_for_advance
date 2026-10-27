/**
 * O2 —— 用仓库**已安装的 esbuild** 打一小段 TS（不新增依赖）。
 *
 * 为什么需要它：`save-paths.ts` 要能在**不启动 Electron** 的前提下被
 * `run.mjs`（普通 Node ESM）直接执行 —— 而它是 TS。仓库里所有 smoke 都用
 * esbuild 做这一步；这里直接复用 `node_modules/.pnpm` 里那一份，与
 * `electron-u1/build.mjs` 的解析方式同源（`readdirSync` 取最新 `esbuild@`）。
 */
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/* 【2026-10-27 修复】**绝对不能**用 `process.cwd()` 算仓库根。
 *
 * 从前这里是 `resolve(process.cwd(), "../../node_modules/.pnpm")` —— 它假定
 * 调用方的工作目录正好是 `apps/desktop/scripts/o2-conflict-u1-smoke`。而
 * `run.sh` 会 `cd` 到 `apps/desktop` 再调本文件，于是 `../..` 落到了
 * `work_space/`（不是仓库根），报：
 *
 *     ENOENT: no such file or directory, scandir 'D:\...\work_space\node_modules\.pnpm'
 *
 * 症状看起来像"环境没装依赖"，实际是**算错了根**。仓库里其它套件（如
 * `electron-u1/build.mjs:42-44`）都是从**模块自身位置**推：
 *
 *     const suite   = dirname(fileURLToPath(import.meta.url));
 *     const desktop = resolve(suite, "../..");
 *     const repo    = resolve(desktop, "../..");
 *
 * 照抄它 —— 这样不论从哪个目录调用都能找到同一份 esbuild。 */
const suite = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(suite, "../..");
const repo = resolve(desktop, "../..");

/** 解析已安装的 esbuild（与 `electron-u1/build.mjs` 的 `pkgPath` 同一做法）。 */
async function loadEsbuild() {
  const pnpm = resolve(repo, "node_modules/.pnpm");
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
