/**
 * 应用**自管工具**的落点 —— `<userData>/tools/<工具>/<版本>/`。
 *
 * ## 为什么和 `/runtimes` 分开
 *
 * 结构上是同一件事(按需下载、按版本存、解析绝对路径),但不能共用那个根:
 * `runtimeInstaller.listRuntimes` 按固定的 RuntimeAgentId 清单遍历
 * `<userData>/runtimes/`,往里塞一个 `pandoc/` 会变成一个**永远不被列出的孤儿
 * 目录** —— 看着像垃圾,而且 `removeRuntime` 之类按 agent 索引的操作会绕着它走。
 * 两个根,两套清单,各自遍历各自的。
 *
 * ## 纯 node
 *
 * 与 `managedRuntimeRoots.ts` 同一姿态:不引 electron。`main/index.ts` 启动时调
 * `setToolRoot()`,在那之前这里一律返回空 —— 无头验证与 smoke harness 不会因为
 * 没注册而炸。
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ToolchainToolId } from "@contracts/ipc";
import { compareVersions } from "@main/runtimes/managedRuntimeRoots.js";

let toolRoot: string | null = null;

/** main/index.ts 在 userData 确定之后调一次。 */
export function setToolRoot(root: string): void {
  toolRoot = root;
}

export function getToolRoot(): string | null {
  return toolRoot;
}

/** `<工具>` 目录下真实存在的版本子目录,新的在前。 */
export function listToolVersions(tool: ToolchainToolId): string[] {
  if (!toolRoot) return [];
  const dir = join(toolRoot, tool);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const versions: string[] = [];
  for (const entry of entries) {
    try {
      if (!statSync(join(dir, entry)).isDirectory()) continue;
    } catch {
      continue;
    }
    versions.push(entry);
  }
  versions.sort((a, b) => compareVersions(b, a));
  return versions;
}

/** 最新的那个版本目录(不校验里面的可执行文件在不在 —— 那是工具自己的事)。 */
export function newestToolDir(tool: ToolchainToolId): string | null {
  const version = listToolVersions(tool)[0];
  return version ? join(toolRoot!, tool, version) : null;
}

/** Windows 上可执行文件带 .exe。 */
function exeName(base: string): string {
  return process.platform === "win32" ? `${base}.exe` : base;
}

/** 哪些工具是"应用自管"的 —— 能自己下载、自己删、自己能挂上 PATH。
 *  其余几项要么装进用户的解释器(python-deps),要么是系统级安装
 *  (zip / LibreOffice / poppler),没有自管副本。 */
export const MANAGED_TOOLS = ["pandoc", "latex"] as const;

/** 在某个工具的**版本目录**里找出可执行文件;找不到返回 null。
 *
 * 两种布局:
 *   - `pandoc` 平铺 —— 可执行文件就在版本目录根下;
 *   - `latex` 深两层 —— TinyTeX 的可执行文件在 `bin/<平台名>/` 里。而平台子目录
 *     名各发行版不一样(`windows` / `universal-darwin` / `x86_64-linux` /
 *     `aarch64-linux` / `x86_64-linuxmusl` …),所以**不去猜名字**:扫 bin 下面
 *     一层,看哪个目录里真有那个引擎。这样上游改了命名也不会静默失效。
 */
function findExecutableIn(tool: ToolchainToolId, versionDir: string): string | null {
  if (tool === "pandoc") {
    const exe = join(versionDir, exeName("pandoc"));
    return existsSync(exe) ? exe : null;
  }
  if (tool === "latex") {
    const binRoot = join(versionDir, "bin");
    let entries: string[];
    try {
      entries = readdirSync(binRoot);
    } catch {
      return null; // 还没解开 / 解坏了
    }
    for (const entry of entries) {
      const exe = join(binRoot, entry, exeName("xelatex"));
      if (existsSync(exe)) return exe;
    }
    return null;
  }
  return null;
}

/** 自管副本的可执行文件绝对路径;没装 / 装坏了返回 null。 */
export function managedToolExecutable(tool: ToolchainToolId): string | null {
  if (!toolRoot) return null;
  for (const version of listToolVersions(tool)) {
    const exe = findExecutableIn(tool, join(toolRoot, tool, version));
    if (exe) return exe;
  }
  return null;
}

/**
 * 该放进子进程 PATH 的目录 —— 自管工具的**可执行文件所在目录**(不是版本目录:
 * TinyTeX 的在 `bin/<平台>/` 里)。
 *
 * 为什么是 PATH 而不是把绝对路径塞进提示词:技能文档里写的就是 `pandoc ...` /
 * `xelatex ...` 这种裸名字,而且用户自己在应用内终端里敲也一样该能用。加几个
 * 目录到 PATH 是一处改动覆盖所有 spawn 出来的子进程(三个 provider 都是
 * `{...process.env}`,Pi 直接继承)。
 */
export function managedToolBinDirs(): string[] {
  const dirs: string[] = [];
  for (const tool of MANAGED_TOOLS) {
    const exe = managedToolExecutable(tool);
    if (exe) dirs.push(dirname(exe));
  }
  return dirs;
}
