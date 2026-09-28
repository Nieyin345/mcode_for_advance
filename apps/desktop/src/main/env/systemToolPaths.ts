/**
 * 「装了但不上 PATH」的那几样工具的标准安装位置 —— 检测(`toolchain.ts`)与 agent
 * 的 PATH 重算(`agentEnv.ts`)共用这一份表。
 *
 * ## 为什么从 toolchain.ts 里拆出来
 *
 * `agentEnv` 只要一个同步的纯函数(`systemToolBinDirs`),而 `toolchain.ts` 自从把
 * OnlyOffice 并进工具链,就静态引入了 `onlyoffice/localInstall` 与 `OnlyOfficeBridge`
 * (→ `repositories` → `db` → sql.js、`logger` → electron)。于是只想要一张路径表的
 * `agentEnv`(以及声明「纯函数、没有桩」的 agent-env-smoke)被连坐拉进了整个存储层,
 * smoke 在运行时直接死在 `Dynamic require of "fs"` 上。这里只依赖 node:fs / node:path
 * 与契约里的工具 id 表。
 */
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { ToolchainToolId } from "@contracts/ipc";
import { TOOLCHAIN_TOOL_IDS } from "@contracts/ipc";

/** 某些工具装在 PATH 之外的标准位置。
 *
 *  判据是"这东西会不会自己把目录写进 PATH":LibreOffice 不会(装了也不上 PATH,
 *  所以必须替它找),而 TeX 发行版会(TeX Live 的 `bin/<平台>` 和 MiKTeX 都会自己
 *  注册)—— 所以 latex 不在这里列,它上了 PATH 就能被 findExecutable 找到。
 *  替一个会自动上 PATH 的东西维护一份硬编码路径表,只会在路径变了之后变成谎话。 */
export function knownInstallPaths(tool: ToolchainToolId): string[] {
  if (tool !== "soffice") return [];
  if (process.platform === "win32") {
    return [
      "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
      "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
    ];
  }
  if (process.platform === "darwin") {
    return ["/Applications/LibreOffice.app/Contents/MacOS/soffice"];
  }
  return ["/usr/bin/soffice", "/usr/local/bin/soffice"];
}

/** "装了但不上 PATH"的那些工具,它们所在目录。
 *
 * ## 为什么检测之外还得有这个东西
 *
 * `knownInstallPaths` 让检测**找得到** LibreOffice,但找得到不等于 agent **敲得到**
 * —— LibreOffice 装完不会把自己加进 PATH,而技能里(以及 agent 自己写命令时)敲的
 * 是裸名字 `soffice`。没有这个函数就会进入一种很坑的状态:**面板显示 ✓,agent 的
 * shell 里却 `command not found`** —— 检查通过了、能力没接上,而且界面完全静默。
 *
 * 判据与检测**同源**(复用 `knownInstallPaths`),不另抄一份路径表:分开写的话,
 * 以后改了一处两边就开始互相矛盾。
 *
 * 同步的 —— 它要在 PATH 重算(同步操作)里被调用,不能去跑子进程探测。 */
export function systemToolBinDirs(): string[] {
  const dirs = new Set<string>();
  for (const tool of TOOLCHAIN_TOOL_IDS) {
    for (const file of knownInstallPaths(tool)) {
      if (existsSync(file)) dirs.add(dirname(file));
    }
  }
  return [...dirs];
}
