/**
 * 这套 smoke 的**共享状态槽** —— 单独一个模块,存在的理由只有一个:
 *
 * ## 为什么状态不能直接 `export const counts = {...}`
 *
 * `toolInstall.ts` 里那两条 import 是**相对路径**:
 *
 *     import { getToolRoot, MANAGED_TOOLS } from "./managedToolRoots.js";
 *     import { invalidateToolchainCache, pickPythonForInstall, PIP_PACKAGES } from "./toolchain.js";
 *     import { applyAgentEnvironment } from "./agentEnv.js";
 *
 * 而 esbuild 的 `--alias:` **不收相对路径的名字**(报 `Invalid alias name: "./toolchain.js"`)。
 * 唯一的办法是把它们整条外置(`--external:./toolchain.js`),再单独打一份同名桩放到
 * bundle 旁边。**于是那个桩在磁盘上有两份**:一份被 esbuild 打进了主 bundle(因为
 * main.ts 也 import 它),一份是外置的那个 .js 文件。被测代码用的是后者,断言读的
 * 是前者 —— 两份模块实例,状态互不相干。
 *
 * 把状态**挂在 globalThis 上**,两份实例就指向同一个对象:先求值的那一份建、
 * 后求值的那一份取到已有的。这不是"风格",是这一层转发唯一能工作的方式。
 *
 * ⚠️ 同一条坑在别的套件里也踩过(`archiver-installer-smoke` 的文件头写了「两层转发
 * 是为了让脚本与主 bundle 看见同一份状态」)—— 这里用的是同一个思路的另一种实现。
 */
export interface SharedCounts {
  /** `stubs/toolchain.ts` 的 `invalidateToolchainCache` 被调了几次。 */
  invalidate: number;
  /** `stubs/toolchain.ts` 的 `pickPythonForInstall` 被调了几次。 */
  pickPython: number;
  /** `stubs/agentEnv.ts` 的 `applyAgentEnvironment` 被调了几次。 */
  applyEnv: number;
  /** `stubs/rgSearch.ts` 的 `resetRgCache` 被调了几次。 */
  resetRg: number;
  /** `stubs/rgSearch.ts` 的 `installRg` 被调了几次。 */
  installRg: number;
  /** `stubs/rgSearch.ts` 的 `installRg` 该怎么回。 */
  rgInstallResult: { ok: boolean; error?: string; path?: string };
  /** `pickPythonForInstall` 该回哪个解释器。null = 找不到。 */
  pythonForInstall: string | null;
}

interface Slot {
  counts: SharedCounts;
  /** 一条命令/一个正则被命中过没有 —— 死夹具守卫用。 */
  fired: Set<string>;
}

const g = globalThis as unknown as { __updaterToolsSmoke?: Slot };

function freshCounts(): SharedCounts {
  return {
    invalidate: 0,
    pickPython: 0,
    applyEnv: 0,
    resetRg: 0,
    installRg: 0,
    rgInstallResult: { ok: true, path: "C:\\fake\\bin\\rg.exe" },
    pythonForInstall: null,
  };
}

/** 本套的唯一状态槽。两份模块实例经 `globalThis` 拿到同一个对象。 */
export const slot: Slot = (g.__updaterToolsSmoke ??= { counts: freshCounts(), fired: new Set<string>() });

/** 把计数清零但**保留对象身份**(不能换对象,否则外置那份还指着旧的)。 */
export function resetCounts(): void {
  Object.assign(slot.counts, freshCounts());
}
