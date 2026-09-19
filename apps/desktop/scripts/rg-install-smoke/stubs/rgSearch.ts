/**
 * `@main/lib/rgSearch.js` 的替身 —— 真的那个 `resolveRg()` 里有一句 `which("rg")`,
 * 而 `which()` 走 `execFileSync("where.exe")`。本套要断的是 `rg.status` 怎么反映
 * **安装出来的那份二进制**,而不是"这台机器上恰好有没有 rg",所以把探测结果换成
 * 一个只看磁盘的版本。
 *
 * 三个导出都与真的那三个**同名同形**(`rgInstall` 调 `bundledRgPath` / `resetRgCache`,
 * `ipc/rg` 调 `resolveRg`),所以换掉之后**不改变被测代码的任何一条控制流** —— 只是把
 * "机器上有没有 rg"这个外部事实从环境里挪到了脚本里。
 *
 * ⚠️ 不能让它回落到真的 `which("rg")`:开发机/CI 上装了一个 rg 会让
 * "没装的时候显示未安装" 那条断言随机变红,而那种红跟被测代码无关。
 *
 * ## 为什么是"读环境变量"而不是"写死一个路径"
 *
 * 与 electron 桩同一个理由:安装根是 `run.sh` 的 `mktemp -d`,这里只读那个变量。
 * 没设就抛,绝不回落到任何默认位置。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = process.env.MCODE_SMOKE_INSTALL_ROOT;
if (!root) throw new Error("MCODE_SMOKE_INSTALL_ROOT 没设 —— rgSearch 桩只给无头脚本用");

/** `resetRgCache()` 被调用过几次 —— 「装完之后缓存有没有清掉」是这套的一条判据。 */
let resetCount = 0;

/** 与真的一致:`userData/bin/<rg|rg.exe>`。 */
export function bundledRgPath(): string {
  return join(root as string, "bin", process.platform === "win32" ? "rg.exe" : "rg");
}

export function resetRgCache(): void {
  resetCount += 1;
}

/** **只在磁盘上真有一份时才说"找到了"** —— 不做任何 PATH 探测。这样
 *  "装之前说未安装、装之后说已安装"整条链就只由被测代码 + 真实磁盘状态决定。 */
export function resolveRg(): string | null {
  const bundled = bundledRgPath();
  return existsSync(bundled) ? bundled : null;
}

/** 只给脚本读计数用(桩与脚本在同一份实例里,见 wire.ts 的注释)。 */
export function resetCountNow(): number {
  return resetCount;
}
