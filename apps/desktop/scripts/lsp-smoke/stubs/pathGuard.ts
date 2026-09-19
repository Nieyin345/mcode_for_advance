/**
 * `@main/lib/pathGuard.js` 的替身 —— 真的那个 import 了 `store/repositories.js`
 * (项目表 + worktree 根)。
 *
 * 本套只需要它答一件事:「这个工作区路径认不认识」。用真的也行(本套真建了库、
 * 真写了项目行),但这个桩把「哪些根是合法的」变成脚本里一眼能看全的清单,
 * 于是「路径越界被拒」那条断言有一个自己摆上去的、不会被别的数据影响的对手。
 *
 * ⚠️ **不是空实现**:没登记过的路径一律**拒绝**(返回 false / null),这正是真的那个
 * 在有项目之前的默认行为 —— 而「默认放行」会让 §8 那条断言永远绿。
 */
import { resolve } from "node:path";

const known = new Set<string>();

/** 登记一个合法的工作区根(测试用例自己摆)。 */
export function registerWorkspaceRoot(p: string): void {
  known.add(resolve(p));
}

/** 清空登记(本套的收尾守卫会核对它没被误用)。 */
export function setKnownRoots(roots: string[]): void {
  known.clear();
  for (const r of roots) known.add(resolve(r));
}

function within(root: string, abs: string): boolean {
  const r = resolve(root).toLowerCase();
  const a = resolve(abs).toLowerCase();
  if (a === r) return true;
  return a.startsWith(r.endsWith("\\") || r.endsWith("/") ? r : `${r}\\`) || a.startsWith(`${r}/`);
}

export function isKnownWorkspaceRoot(path: string): boolean {
  return [...known].some((r) => within(r, path));
}

export function findContainingWorkspaceRoot(absPath: string): string | null {
  return [...known].find((r) => within(r, absPath)) ?? null;
}

/* 真的那一份还有这几个导出,本套用不到,显式抛而不是静默返回。 */
export function isKnownProjectPath(): never {
  throw new Error("lsp-smoke 的 pathGuard 桩没造 isKnownProjectPath");
}
export function findContainingProject(): never {
  throw new Error("lsp-smoke 的 pathGuard 桩没造 findContainingProject");
}
export function samePath(): never {
  throw new Error("lsp-smoke 的 pathGuard 桩没造 samePath");
}
export function pathWithin(): never {
  throw new Error("lsp-smoke 的 pathGuard 桩没造 pathWithin");
}
