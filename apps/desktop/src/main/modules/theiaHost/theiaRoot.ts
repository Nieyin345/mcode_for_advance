/**
 * 唯一一处「Theia 运行时在哪」的判定。
 *
 * ## 为什么抽出来
 *
 * 在这之前有**两处**各自维护一份候选表（`ipc/theiaPreview.ts`、`ipc/theiaInstalled.ts`），
 * 两份都只看 `process.cwd()` 和工作区相对路径 —— 等于**只支持开发态**。
 * 打包后的 app 里 `cwd` 是用户的任意目录，那份候选表永远命中不了。
 *
 * 这个仓库为「同一个值有多处表示」栽过：`10dbb0ce` 修「三处里两处不一致」，
 * 自己又引入了第三处。所以这里只留一份，两边都 import 它。
 *
 * ## 候选顺序
 *
 * 1. `MCODE_THEIA_ROOT` —— 显式覆盖（CI / 排查时用）；
 * 2. `<resourcesPath>/theia` —— **打包后**的位置（`electron-builder.yml` 的 extraResources）；
 * 3. `<cwd>/vendor/theia`、`<cwd>/../../vendor/theia` —— **开发态**（从仓库根或 apps/desktop 起）。
 *
 * ## 判定标准是「两个入口文件都在」
 *
 * 只查 `plugin-host.js` 不够：只有 host 没有 vscode init 桥时，扩展能起但 `vscode.*`
 * 全不可用，症状是「装了没反应」而不是「报错」。两个都查才 fail 得早。
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

/** 一个 Theia 检出要被判定为「可运行」，这两个文件必须都在。 */
const REQUIRED_ENTRIES = [
  "packages/plugin-ext/lib/hosted/node/plugin-host.js",
  "packages/plugin-ext-vscode/lib/node/plugin-vscode-init.js",
] as const;

function isBuiltTheiaRoot(root: string): boolean {
  return REQUIRED_ENTRIES.every(relative => {
    try { return existsSync(join(root, relative)); }
    catch { return false; }
  });
}

/** 打包后的资源目录。开发态没有 `resourcesPath`，返回 undefined。 */
function packagedRoot(): string | undefined {
  // 惰性取 —— 这个模块会被无头 smoke 打包，顶层 `import { app } from "electron"`
  // 会让 ESM bundle 报 ERR_AMBIGUOUS_MODULE_SYNTAX（本仓库踩过一次）。
  try {
    const electron = require("electron") as { app?: { isPackaged?: boolean } } | undefined;
    if (electron?.app?.isPackaged !== true) return undefined;
    const resourcesPath = (process as { resourcesPath?: string }).resourcesPath;
    return typeof resourcesPath === "string" ? join(resourcesPath, "theia") : undefined;
  } catch {
    return undefined;
  }
}

/** 按优先级返回全部候选（未过滤存在性）—— 给错误信息用，让用户看得到试过哪些。 */
export function theiaRootCandidates(explicit?: string): string[] {
  return [
    explicit,
    process.env.MCODE_THEIA_ROOT,
    packagedRoot(),
    resolve(process.cwd(), "vendor/theia"),
    resolve(process.cwd(), "../../vendor/theia"),
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
}

/** 找第一个真的建好的 Theia 检出。找不到就抛，并且**把试过的路径都列出来** ——
 *  「它到底在哪找过」是这类错误最难自查的部分。 */
export function resolveTheiaRoot(explicit?: string, purpose = "Theia 扩展运行时"): string {
  const candidates = theiaRootCandidates(explicit);
  const found = candidates.find(isBuiltTheiaRoot);
  if (found) return found;
  throw Error(
    `${purpose}需要一个构建好的 Theia 检出（含 plugin-ext 与 plugin-ext-vscode），` +
    `以下位置都没有：${candidates.join(" | ")}。` +
    (packagedRoot() ? "（本次是打包运行，应在 <resources>/theia）" : "（开发态请按 vendor/README.md 构建 vendor/theia）"),
  );
}
