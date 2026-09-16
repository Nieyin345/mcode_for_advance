/**
 * 内置插件 —— **随应用一起发布**的插件，不需要安装、不需要启用、不能卸载。
 *
 * ## 为什么是"插件"而不是往 `~/.mcode/skills/` 拷一份
 *
 * 三个 provider 都走同一条投递链（见 pluginManager.ts 顶部的说明）：
 * Claude 收 `options.plugins`、Codex 收 `skills/extraRoots/set`、Pi 收
 * `additionalSkillPaths`。这条链已经在跑、已经被测过，把一个内置目录喂进去，
 * 三家全都自动拿到 —— 而"启动时把文件拷进用户目录"是另一套机制：它会
 * 污染用户目录、在用户删掉后又被悄悄重建、还要自己处理版本更新。
 * **用已有的那条链，不新造一条。**
 *
 * 目录本身就是一个标准插件（`.claude-plugin/plugin.json` + `skills/`），
 * 由 `electron-builder.yml` 的 `extraResources` 放到打包后的
 * `<resources>/builtin-skills`；开发态则在 `<appRoot>/resources/builtin-skills`。
 *
 * ## 为什么找不到就当没有，而不是报错
 *
 * 这个目录是**构建产物的一部分**。开发时它一定在（在源码树里），打包后靠
 * electron-builder 搬过去。万一某次构建漏了它，正确的表现是"内置技能不见了、
 * 但应用照常能跑"，而不是整个应用起不来 —— 文档技能是加分项，不是命脉。
 * 所以这里所有失败路径都返回空数组，只留一行 warn 日志。
 *
 * ## 许可
 *
 * 里面的四个技能来自 Anthropic 官方（source-available，**非开源、不可再分发**）。
 * 详见 `resources/builtin-skills/NOTICE.md` —— 如果这个项目要公开发布，
 * 先读那一节。
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginManifest } from "@contracts/ipc";
import { findPluginManifest } from "./pluginManifest.js";

/** 内置插件的名字（也是 `plugin.json` 里的 `name`）。 */
export const BUILTIN_PLUGIN_NAME = "mcode-document-skills";

/** electron-builder 把 `resources/builtin-skills` 放到哪儿的目录名。 */
const BUILTIN_DIR_NAME = "builtin-skills";

/** 一个内置插件的记录 —— 字段与 `pluginManager.EnabledPlugin` 同构
 *  （多一个恒为 true 的 `builtin`），所以可以直接混进那条投递链。
 *  刻意不从 pluginManager 引类型：那边要 import 本模块，引回来就成了环。 */
export interface BuiltinPlugin {
  name: string;
  rootDir: string;
  manifest: PluginManifest;
  hasHooks: boolean;
  builtin: true;
}

/** 从本模块的位置往上找源码树里的那个目录。
 *
 *  主进程被 electron-vite 打成 `out/main/index.js`，所以从它往上两级就是
 *  `apps/desktop`，`resources/builtin-skills` 就在那儿。 */
function devCandidate(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return join(here, "..", "..", "resources", BUILTIN_DIR_NAME);
  } catch {
    return "";
  }
}

/** 打包态与开发态的候选路径，按可信度排序。
 *
 *  打包态优先：`process.resourcesPath` 是 Electron 给的权威位置，
 *  而源码树目录在打包产物里根本不存在（`files` 只收 `out/**`），
 *  所以两者不会同时命中，顺序只是为了"万一都在时选对的那个"。 */
function candidateRoots(): string[] {
  const out: string[] = [];
  if (process.resourcesPath) out.push(join(process.resourcesPath, BUILTIN_DIR_NAME));
  const dev = devCandidate();
  if (dev) out.push(dev);
  // 兜底：从 cwd 猜（`apps/desktop` 或仓库根都有可能 —— 取决于是谁把进程拉起来的）
  out.push(join(process.cwd(), "resources", BUILTIN_DIR_NAME));
  out.push(join(process.cwd(), "apps", "desktop", "resources", BUILTIN_DIR_NAME));
  return out;
}

/** 记一次就行 —— 这个路径在进程生命周期内不会变，而 `getEnabledPlugins()`
 *  是**每轮对话**都要调的，没必要每轮去探四次文件系统。 */
let cachedRoot: string | null | undefined;

/** 内置插件目录的绝对路径；找不到返回 null。 */
export function builtinPluginRoot(): string | null {
  if (cachedRoot !== undefined) return cachedRoot;
  cachedRoot = null;
  for (const candidate of candidateRoots()) {
    // 认"目录里有清单"而不只是"目录存在" —— 一个空的同名目录不该被当成
    // 找到（那样会静默地把内置技能变成 0 个，而不是走日志那条路）
    const manifest = findPluginManifest(candidate);
    if (manifest) {
      cachedRoot = candidate;
      break;
    }
  }
  return cachedRoot;
}

/**
 * 内置插件记录（0 或 1 条）。
 *
 * 返回数组而不是单条，是为了让调用点用 `...getBuiltinPlugins()` 展开 ——
 * 以后要加第二个内置插件（比如期刊分区、文献检索）时不用改任何调用点。
 */
export function getBuiltinPlugins(): BuiltinPlugin[] {
  const root = builtinPluginRoot();
  if (!root) return [];
  try {
    const resolved = findPluginManifest(root);
    if (!resolved) return [];
    return [
      {
        name: resolved.manifest.name,
        rootDir: root,
        manifest: resolved.manifest,
        // 内置插件不带 hooks。写死 false 而不是去 summarizeComponents 扫一遍：
        // 它是随应用发布的固定内容，扫出来的结果每轮都一样，没必要每轮读盘
        // （而且 v1 本来就不执行插件 hooks）。
        hasHooks: false,
        builtin: true,
      },
    ];
  } catch {
    return [];
  }
}

/** 这个插件名是不是内置的 —— UI 用它来禁止卸载/禁用。 */
export function isBuiltinPluginName(name: string): boolean {
  return name === BUILTIN_PLUGIN_NAME;
}

/** 这个路径是不是内置插件的技能根（`<root>/skills`）—— 技能列表用它来
 *  区分"内置"与"用户装的插件"。比较的是解析后的绝对路径。 */
export function isBuiltinSkillsRoot(absPath: string): boolean {
  const root = builtinPluginRoot();
  if (!root) return false;
  const prefix = join(root, "skills");
  const a = absPath.replace(/[\\/]+$/, "").toLowerCase();
  const b = prefix.replace(/[\\/]+$/, "").toLowerCase();
  return a === b || a.startsWith(b + (b.includes("\\") ? "\\" : "/"));
}

/** 仅供无头验证用：清掉路径缓存，让下一次调用重新探测。 */
export function resetBuiltinPluginCache(): void {
  cachedRoot = undefined;
}
