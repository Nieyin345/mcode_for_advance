/**
 * Agent 浏览器**目标解析与本地文件围栏**的纯逻辑 —— 从 `agentBrowserTools.ts` 里
 * 抽出来,单独一份零 BrowserManager 依赖的模块,好让无头 smoke 直接验它(MC-043 /
 * MC-044)。
 *
 * ## 为什么单独一份
 *
 * 两件事都只依赖**已算好的输入**(浏览器视图清单 / 一个 URL 字符串),而不依赖
 * `BrowserManager` 的 electron 面:
 *
 *   1. `resolveBrowserTarget` —— 给定活着的视图与"当前目标"指针,决定一次无 browserId
 *      的调用该落到哪一个视图。**按项目隔离**:会话带着自己的 projectPath 来时,只在
 *      本项目的视图里挑,并拒绝跨项目的显式 browserId(MC-043)。
 *   2. `fileUrlWorkspaceError` —— `file://` 导航必须落在已知工作区内,复用 agent 文件
 *      工具同一道 `findContainingWorkspaceRoot` 围栏(MC-044)。
 *
 * 抽出来之后 `agentBrowserTools.ts` 只是这两个函数的**调用方**,而回归套件可以把
 * 浏览器视图清单当作普通数组喂进来,不必起 Electron / 真 WebContentsView。
 */
import { fileURLToPath } from "node:url";
import { findContainingWorkspaceRoot } from "@main/lib/pathGuard.js";

/** 目标解析要用到的视图清单(只取两项 —— 其余字段解析用不到)。 */
export interface BrowserTargetInfo {
  browserId: string;
  projectPath: string;
}

export type TargetResolution =
  | { ok: true; browserId: string }
  | { ok: false; reason: string };

/**
 * Decide which browser view a (possibly browserId-less) agent call targets.
 *
 * 顺序(带 projectPath 时):显式 browserId(校验属于本项目)→ 本项目的活动视图 →
 * 本项目第一个活视图 → no-live-browser。**永远不落到别的项目的视图上**。
 *
 * 不带 projectPath 时(老调用方 / 还没被改造的 provider 路径):显式 browserId →
 * 全局活动视图 → 第一个活视图 —— 与改造前逐字一致,不把老路改坏。
 *
 * @param activeGlobal     全局"当前目标"指针(`activeBrowserId`)
 * @param activeForProject 该项目的"当前目标"指针(`activeByProject.get(projectPath)`)
 */
export function resolveBrowserTarget(
  infos: BrowserTargetInfo[],
  opts: {
    browserId?: string;
    projectPath?: string;
    activeGlobal?: string | null;
    activeForProject?: string | null;
  },
): TargetResolution {
  const { browserId, projectPath, activeGlobal, activeForProject } = opts;
  const inProject = projectPath ? infos.filter((i) => i.projectPath === projectPath) : infos;

  if (browserId) {
    const info = infos.find((i) => i.browserId === browserId);
    if (!info) return { ok: false, reason: `browserId "${browserId}" 不存在或已关闭` };
    if (projectPath && info.projectPath !== projectPath) {
      return {
        ok: false,
        reason: `browserId "${browserId}" 属于另一个项目,不能跨项目操作;请只操作本项目(${projectPath})内的浏览器视图。`,
      };
    }
    return { ok: true, browserId };
  }

  if (projectPath) {
    if (activeForProject && inProject.some((i) => i.browserId === activeForProject)) {
      return { ok: true, browserId: activeForProject };
    }
    if (inProject.length > 0) return { ok: true, browserId: inProject[0].browserId };
    return { ok: false, reason: "no-live-browser" };
  }

  if (activeGlobal && infos.some((i) => i.browserId === activeGlobal)) {
    return { ok: true, browserId: activeGlobal };
  }
  if (infos.length > 0) return { ok: true, browserId: infos[0].browserId };
  return { ok: false, reason: "no-live-browser" };
}

/**
 * `file://` 导航的工作区围栏(MC-044)。
 *
 * `browser_navigate` 收任意 `file://`,于是 agent 能读它叫得出名字的任意本地文件 ——
 * 绕过了 agent **文件工具**那条"必须在项目根内"的护栏。渲染本地页面仍有正当用途
 * (预览构建产物、打开的 PDF),所以保留这条能力,但把它**收进同一道围栏**
 * (`findContainingWorkspaceRoot` —— 项目 ∪ 会话工作树 ∪ 资料库/模版库),而不是另写一份。
 *
 * 非 `file:` URL(http/https)返回 null(它们不受路径约束)。返回**字符串**表示拒绝,
 * 那句话正是 agent 看到的原因 —— 判据立在它上面。
 */
export function fileUrlWorkspaceError(url: string): string | null {
  if (!/^file:\/\//i.test(url)) return null;
  let absPath: string;
  try {
    absPath = fileURLToPath(url);
  } catch {
    return "无法解析这个 file:// 路径";
  }
  if (!findContainingWorkspaceRoot(absPath)) {
    return (
      "拒绝:file:// 只能读取项目(或会话工作树 / 资料库)目录内的本地文件," +
      `该路径不在任何已知工作区内:${absPath}`
    );
  }
  return null;
}
