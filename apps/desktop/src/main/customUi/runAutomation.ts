/**
 * 自定义 UI 的「运行自动化」动作 —— 把右键的目标展开成载荷,交给 `automationRunner`。
 *
 * ## 展开规则
 *
 *   - 条目 → 那一条;
 *   - 分类 / 小类 → 它**和它下面所有子分类**里的条目(去重);
 *   - 大类 → 挂在这个大类下的全部分类里的条目(去重);
 *   - 文件 → 那一个文件(必须在某个已登记项目的目录里)。
 *
 * 回收站里的条目一律不带 —— 用户在分类上右键「跑一下」,指的是这个分类里**还在用**的
 * 东西(同 `manifest.ts` 给 AI 的清单那条筛法)。
 *
 * 条目事实与 `library/broadcast.ts` 发的事件**逐字同形**(itemId / itemTitle /
 * 库内相对的 pdfPath / filePath):同一条自动化被事件叫起来和被右键叫起来,读到的
 * 载荷一模一样,指令里的 `{{trigger.itemId}}` 两边都解得出。
 *
 * 纯的那一半(`collectCollectionIds` / `itemFactsOf` / `isInsideAnyProject`)在 `targets.ts`,
 * 冒烟直接钉(见 `scripts/custom-ui-smoke`)。
 */
import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  CUSTOM_UI_MAX_BATCH,
  type CustomUiRunAutomationInput,
  type CustomUiRunAutomationResult,
  type CustomUiRunTarget,
  type CustomUiWhen,
} from "@contracts/customUi";
import { CollectionRepo, LibraryRepo, ProjectRepo } from "@main/store/repositories.js";
import { trashedItemIds } from "@main/library/trash.js";
import { automationRunner } from "@main/orchestration/automationRunner.js";
import { collectCollectionIds, isInsideAnyProject, itemFactsOf, shouldSkipItem, type ItemFacts } from "./targets.js";

type Expanded =
  | { ok: true; items: ItemFacts[]; skipped: number }
  | { ok: true; files: string[]; skipped: number }
  | { ok: false; error: string };

function expand(target: CustomUiRunTarget, skipWhen: CustomUiWhen | undefined): Expanded {
  if (target.kind === "file") {
    if (!isAbsolute(target.path)) return { ok: false, error: "文件路径必须是绝对路径" };
    const projects = ProjectRepo.list().map((p) => p.path);
    if (!isInsideAnyProject(target.path, projects, process.platform === "win32")) {
      return { ok: false, error: "这个文件不在任何已打开的项目里" };
    }
    if (!existsSync(target.path) || !statSync(target.path).isFile()) {
      return { ok: false, error: "文件不存在(可能刚被移走或删掉)" };
    }
    // skipWhen 对文件目标不适用(requires/extensions 的条目语义在这里没有对应物;
    // matchesWhen 的 file 分支只看扩展名,而"跳过某扩展名的文件"没有真实用例)——
    // 保持简单:文件目标不过滤。
    return { ok: true, files: [target.path], skipped: 0 };
  }
  if (target.kind === "item") {
    const item = LibraryRepo.get(target.itemId);
    if (!item) return { ok: false, error: "这一条已经不在库里了" };
    if (shouldSkipItem(item, skipWhen)) return { ok: true, items: [], skipped: 1 };
    return { ok: true, items: [itemFactsOf(item)], skipped: 0 };
  }
  const all = CollectionRepo.list();
  let roots: string[];
  if (target.kind === "collection") {
    if (!all.some((c) => c.id === target.collectionId)) return { ok: false, error: "这个分类已经不存在了" };
    roots = [target.collectionId];
  } else {
    roots = all.filter((c) => c.groupId === target.groupId && !c.isTrash).map((c) => c.id);
  }
  const trashed = trashedItemIds();
  const seen = new Set<string>();
  const items: ItemFacts[] = [];
  let skipped = 0;
  for (const cid of collectCollectionIds(all, roots)) {
    for (const item of LibraryRepo.listByCollection(cid)) {
      if (trashed.has(item.id) || seen.has(item.id)) continue;
      seen.add(item.id);
      if (shouldSkipItem(item, skipWhen)) {
        skipped++;
        continue;
      }
      items.push(itemFactsOf(item));
    }
  }
  return { ok: true, items, skipped };
}

export async function runCustomUiAutomation(input: CustomUiRunAutomationInput): Promise<CustomUiRunAutomationResult> {
  const expanded = expand(input.target, input.skipWhen);
  if (!expanded.ok) return { ok: false, error: expanded.error };
  const count = "files" in expanded ? expanded.files.length : expanded.items.length;
  const skipped = expanded.skipped;
  if (count === 0) {
    // 全被跳过 ≠ 空范围:如实说清,不让"没东西可跑"读起来像"想法不行"。
    const error = skipped > 0 ? `这 ${skipped} 条都满足跳过条件,无需运行` : "这个范围里没有条目";
    return { ok: false, error, count: 0, skipped };
  }
  if (count > CUSTOM_UI_MAX_BATCH) {
    return {
      ok: false,
      error: `条目太多(${count} 条,一次最多 ${CUSTOM_UI_MAX_BATCH} 条)—— 请在更小的分类上运行,或让自动化自己查库`,
      count,
      skipped,
    };
  }
  if (input.dryRun === true) return { ok: true, count, skipped };
  const res = await automationRunner.runWithTarget(
    input.workflowId,
    input.triggerNodeId,
    "files" in expanded ? { files: expanded.files } : { items: expanded.items },
    input.input,
  );
  return res.ok ? { ok: true, count, skipped } : { ok: false, error: res.error, count, skipped };
}
