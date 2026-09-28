/**
 * 自定义 UI「运行自动化」里**不碰库、不碰磁盘**的那一半 —— 单独成文件,冒烟直接 import
 * (见 `scripts/custom-ui-smoke`)。调用方是同目录的 `runAutomation.ts`。
 */
import { resolve, sep } from "node:path";
import { matchesWhen, type CustomUiWhen } from "@contracts/customUi";
import type { LibraryCollection, LibraryItem } from "@contracts/library";

/** 一条条目的载荷事实(与 `emitItemImported` 同形)。 */
export type ItemFacts = { itemId: string; itemTitle: string; pdfPath?: string; filePath?: string };

export function itemFactsOf(item: LibraryItem): ItemFacts {
  return {
    itemId: item.id,
    itemTitle: item.title,
    ...(item.pdfPath ? { pdfPath: item.pdfPath } : {}),
    ...(item.filePath ? { filePath: item.filePath } : {}),
  };
}

/**
 * 这一条条目要不要被 `skipWhen` 跳过(automation 动作的批量过滤,见
 * `@contracts/customUi`)。**满足条件 = 跳过**:手动转录配 `{ requires: "markdown" }`
 * 时,已有转录的条目在这里被滤掉。复用 `matchesWhen` —— 菜单显隐与批量过滤是
 * 同一套条件语义,不另造一份。
 */
export function shouldSkipItem(item: LibraryItem, skipWhen: CustomUiWhen | undefined): boolean {
  if (!skipWhen) return false;
  return matchesWhen(skipWhen, {
    kind: "item",
    item: {
      id: item.id,
      title: item.title,
      ...(item.pdfPath ? { pdfPath: item.pdfPath } : {}),
      ...(item.mdPath ? { mdPath: item.mdPath } : {}),
      ...(item.filePath ? { filePath: item.filePath } : {}),
    },
  });
}

/**
 * 从这些根分类出发,把**自己 + 全部后代**的 id 收齐。带环保护:历史数据里真出现
 * parent 指来指去的环,也只是每个 id 收一次,不会死循环。
 */
export function collectCollectionIds(
  all: readonly Pick<LibraryCollection, "id" | "parentId">[],
  roots: readonly string[],
): string[] {
  const children = new Map<string, string[]>();
  for (const c of all) {
    if (c.parentId === null) continue;
    const list = children.get(c.parentId) ?? [];
    list.push(c.id);
    children.set(c.parentId, list);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    for (const k of children.get(id) ?? []) stack.push(k);
  }
  return out;
}

/** 路径在不在某个项目目录里(Windows 上不分大小写)。 */
export function isInsideAnyProject(path: string, projectPaths: readonly string[], win32: boolean): boolean {
  const norm = (p: string): string => {
    const r = resolve(p);
    return win32 ? r.toLowerCase() : r;
  };
  const target = norm(path);
  return projectPaths.some((root) => {
    const r = norm(root);
    const withSep = r.endsWith(sep) ? r : r + sep;
    return target.startsWith(withSep);
  });
}
