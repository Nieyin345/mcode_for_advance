/**
 * `env/toolchain.js` 的桩。
 *
 * ⚠️ 这个文件会被打**两次**(见 `stubs/shared.ts` 的文件头):一次进主 bundle,
 * 一次作为 `--external:./toolchain.js` 的落点单独打成 `.js` 放在 bundle 旁边。
 * 所以状态一律走 `slot`(挂在 globalThis 上),**绝不在这里 `export const counts`**。
 *
 * 真那个要 spawn 十来个探测子进程(每个工具一次 where/which、每个 python 候选一次
 * 导入探测)。本套验的是**安装那一路**,不验检测;而且真的那份会把本机真实的
 * python / pandoc 摸出来,让「选了哪个解释器」变成一台机器一个答案。
 *
 * ⚠️ **`pickPythonForInstall` 返回 null 是这里的默认值,而且必须是。** 真那个会去
 * PATH 上把本机的 python 摸出来,`installPythonDeps` 拿着它跑
 * `python -m pip install <九个包>` —— **那就是真往用户的解释器里装东西**。第一版
 * 忘了换掉这个文件(相对 import 换不了桩),跑到那一段时本机的 python 真被摸出来
 * 了;只是那段断言喂的假 python 名恰好不匹配、没真装到。这里默认 null,等于把这个
 * 风险从「靠运气」变成「结构上不可能」。
 */
import { slot, resetCounts } from "./shared.js";

export { resetCounts };

export async function pickPythonForInstall(): Promise<string | null> {
  slot.counts.pickPython++;
  return slot.counts.pythonForInstall;
}

/** 真的那份是从技能目录里扫出来的九个包。这里留可辨认的三个 —— 断言看的是
 *  「传下去的是这份清单」,不是包里具体有什么。 */
export const PIP_PACKAGES = ["openpyxl", "python-pptx", "markitdown[docx,pptx,xlsx,pdf]"] as const;

export function invalidateToolchainCache(): void {
  slot.counts.invalidate++;
}

export function systemToolBinDirs(): string[] {
  return [];
}

/** 本套不该走到真正的检测(那会 spawn 一堆 where/which)。 */
export function checkToolchain(): never {
  throw new Error("本套不该走到 checkToolchain(检测那一路不在这里验)");
}
