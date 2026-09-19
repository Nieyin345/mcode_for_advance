/**
 * `@main/lib/rgSearch.js` 的替身。⚠️ 同 `toolchain.ts`:会被打两次,状态走 `slot`。
 *
 * 真那个 import electron,而且 `resolveRg()` 会真的去 PATH 上找 `rg`、`which()`
 * 起子进程。`rgInstall` 只用它三样:
 *   - `bundledRgPath()` —— 落点(`<userData>/bin/rg.exe`)。**这是本套的安全关键
 *     之一**:真的那个从 `app.getPath("userData")` 现算,也就是用户真实的应用数据
 *     目录。替身让它从 `MCODE_SMOKE_USER_DATA` 派生 —— 不指过去就会往用户的
 *     `%APPDATA%\@mcode\desktop\bin` 里塞一个几 MB 的二进制。
 *   - `resetRgCache()` —— 装成之后调一次,让后续搜索立刻用上新的。
 *   - `installRg()` / `isRgInstalling()` —— 搜索对话框那个「一键装 ripgrep」入口。
 *     本套**只验到 IPC 那一层**(谁在什么时候调它、结果怎么回给渲染端);真的下载
 *     与解包归 `rg-install-smoke`(由另一个代理负责)。
 */
import { join } from "node:path";
import { slot } from "./shared.js";

function userData(): string {
  const dir = process.env.MCODE_SMOKE_USER_DATA;
  if (!dir) throw new Error("MCODE_SMOKE_USER_DATA 没设 —— 这个桩只给无头脚本用,不许回落到用户真实目录");
  return dir;
}

export function bundledRgPath(): string {
  return join(userData(), "bin", process.platform === "win32" ? "rg.exe" : "rg");
}

export function resetRgCache(): void {
  slot.counts.resetRg++;
}

export async function installRg(): Promise<{ ok: boolean; error?: string; path?: string }> {
  slot.counts.installRg++;
  slot.fired.add("installRg");
  return slot.counts.rgInstallResult;
}

export function isRgInstalling(): boolean {
  return false;
}

/** 本套不该走到真正去找 rg 的那条路。 */
export function resolveRg(): never {
  throw new Error("本套不该走到 resolveRg");
}
