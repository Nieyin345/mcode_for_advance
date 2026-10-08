/**
 * 「点一个分支行该 checkout 什么」—— `ProjectBranchIndicator` 与 `GitRepoCard`
 * 两个切换器共用的一份判据。
 *
 * ## 规则
 *
 * - 已经是当前分支 → 什么都不做;
 * - **远端分支**(`origin/foo`)→ 取短名 `foo`;本地已有同名分支就直接切它,
 *   没有就**建一条跟踪分支**(`newBranch` = 短名);
 * - 本地分支 / tag → 直接按名字切。
 *
 * ## 为什么单开一个文件
 *
 * 这段逻辑从前在两个组件的 `BranchGroup.handleClick` 里**各写一份**(ProjectBranchIndicator
 * 那份的注释就写着"Mirrors GitRepoCard's helper")。远端分支的短名解析一旦在一处改动
 * (比如改成取最后一段而不是第一段后的全部),另一处就跟不上 —— 用户在两个入口点同一个
 * 远端分支会得到两种结果。
 */
import type { GitBranchInfo } from "@contracts/ipc";

/** 远端分支 `origin/foo` 的短名 `foo`。不含 `/` 时原样返回。 */
export function remoteShortName(name: string): string {
  return name.includes("/") ? name.slice(name.indexOf("/") + 1) : name;
}

/** 把一次分支行点击翻译成一次 `onCheckout` 调用(或什么都不做)。 */
export function checkoutArgsFor(
  branch: GitBranchInfo,
  localNames: ReadonlySet<string>,
): { branch: string; newBranch?: string } | null {
  if (branch.current) return null;
  if (branch.type === "remote") {
    const shortName = remoteShortName(branch.name);
    // 本地已有同名分支 → 直接切它;没有 → 建跟踪分支。
    return localNames.has(shortName)
      ? { branch: shortName }
      : { branch: branch.name, newBranch: shortName };
  }
  return { branch: branch.name };
}
