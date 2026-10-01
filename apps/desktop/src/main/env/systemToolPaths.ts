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
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

/** macOS:终端里有、但**从访达/程序坞启动的应用拿不到**的那些 PATH 目录。
 *
 * GUI 应用由 launchd 启动,PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin` —— `/etc/paths`、
 * `/etc/paths.d/*` 是终端里的 `path_helper` 才会读的。于是 Homebrew(`/opt/homebrew/bin`、
 * `/usr/local/bin`)装的 pandoc / python3 / node、MacTeX(`/etc/paths.d/TeX` →
 * `/Library/TeX/texbin`)装的 xelatex,对应用全都"不存在":面板显示没装、agent
 * command not found,用户却明明装了。
 *
 * 照 `path_helper` 的规则拼一份(Homebrew 的 Apple Silicon 目录它不管,`brew shellenv`
 * 会把它放最前,这里同样放前面),只返回**真实存在**的目录;调用方只补 PATH 里还没有的。
 * 从终端启动(PATH 已经齐了)时因此什么都不变。非 macOS 返回空。 */
export function macShellPathDirs(): string[] {
  if (process.platform !== "darwin") return [];
  const out: string[] = [];
  const add = (raw: string): void => {
    const d = raw.trim();
    if (d.startsWith("/") && !out.includes(d) && existsSync(d)) out.push(d);
  };
  const lines = (file: string): string[] => {
    try { return readFileSync(file, "utf8").split("\n"); } catch { return []; }
  };
  for (const d of ["/opt/homebrew/bin", "/opt/homebrew/sbin"]) add(d);
  for (const l of lines("/etc/paths")) add(l);
  let names: string[] = [];
  try { names = readdirSync("/etc/paths.d").sort(); } catch { /* 没有这个目录 */ }
  for (const n of names) for (const l of lines(join("/etc/paths.d", n))) add(l);
  return out;
}
