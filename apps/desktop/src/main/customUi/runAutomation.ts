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
import { allTrashCollectionIds, trashedItemIds } from "@main/library/trash.js";
import { loadLibraryGroups } from "@main/library/groupRegistry.js";
import { automationRunner } from "@main/orchestration/automationRunner.js";
import { retiredGraphError } from "@main/workflowEngines/workflowEngineSelection.js";
import { getWorkflow } from "@main/orchestration/library.js";
import { effectiveWorkflowEngine } from "@main/workflowEngines/workflowEngineSelection.js";
import { payloadFactsOf, type TriggerPayload } from "@main/orchestration/automationPayload.js";
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
    // `existsSync` 与 `statSync` 之间文件可能刚好被移走 —— `statSync` 那时会抛,
    // 而抛出去的是一段栈信息,用户在 toast 里读到的不是人话。当"不在了"处理。
    try {
      if (!existsSync(target.path) || !statSync(target.path).isFile()) {
        return { ok: false, error: "文件不存在(可能刚被移走或删掉)" };
      }
    } catch {
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
    // 文件头写着「回收站里的条目一律不带」—— 分类那条路两层都筛了(见下),条目这条路
    // 从前只查 `LibraryRepo.get` + `shouldSkipItem`,漏了回收站。条目不是软删(回收站
    // 只是集合归属,见 `trash.ts`),`get` 照旧把它捞回来,于是右键回收站里的一条就能
    // 对着已被删的东西跑自动化 —— 与同文件的不变量和兄弟路径都相悖。
    if (trashedItemIds().has(item.id)) {
      return { ok: false, error: "这一条在回收站里,先还原再运行" };
    }
    if (shouldSkipItem(item, skipWhen)) return { ok: true, items: [], skipped: 1 };
    return { ok: true, items: [itemFactsOf(item)], skipped: 0 };
  }
  const all = CollectionRepo.list();
  // 「哪个分类是回收站」的唯一判据在 `trash.ts`(`allTrashCollectionIds`)。**不能读
  // `c.isTrash`** —— `CollectionRepo.list()` 里那一格恒为 `false`(回收站标记由
  // `ipc/library.ts` 那层 `markTrashCollections` 事后贴,见 `rowToCollection` 的注释),
  // 于是读它等于"回收站分类"这道筛子永远不生效:用户在回收站上右键,回收站里的条目
  // 会被当成"还在用"的一批带进自动化。
  const trashIds = new Set(allTrashCollectionIds());
  let roots: string[];
  if (target.kind === "collection") {
    if (!all.some((c) => c.id === target.collectionId)) return { ok: false, error: "这个分类已经不存在了" };
    roots = [target.collectionId];
  } else {
    // 分类那条路要查"分类还在不在",大类这条同理要查**大类还在不在** —— 否则一个被删掉的
    // 大类(或过时的右键菜单)会一路走到下面 `roots` 为空,报成「这个范围里没有条目」,
    // 而用户真正的问题是"这个大类没了"。两句话指的不是一回事。
    if (!loadLibraryGroups().some((g) => g.id === target.groupId)) {
      return { ok: false, error: "这个大类已经不存在了" };
    }
    roots = all.filter((c) => c.groupId === target.groupId && !trashIds.has(c.id)).map((c) => c.id);
  }
  const trashed = trashedItemIds();
  const seen = new Set<string>();
  const items: ItemFacts[] = [];
  let skipped = 0;
  // **回收站分类不进这一批。** 根那一层已经按回收站筛过(大类那条路),但后代里
  // 照样可能挂着回收站分类 —— 条目那一层有 `trashedItemIds` 兜着,分类这一层从前没有,
  // 于是"这个分类里还在用的东西"这句话在两层上说的不是同一件事。
  for (const cid of collectCollectionIds(all, roots)) {
    if (trashIds.has(cid)) continue;
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

/**
 * 「只定位、不展开」那一种(`targetMode: "context"`,见 `@contracts/customUi`)。
 *
 * 右键的分类是**落点**不是批次:载荷里只带分类 id 和运行前输入,一条条目都不带。
 * 这条路**不数条目、不比 expectCount、不受 `CUSTOM_UI_MAX_BATCH` 约束** —— 那三样
 * 问的都是"这次要对多少条现有条目办事",而这里的答案恒为零。
 *
 * ⚠️ 空分类**必须放行**:往新建的空分类里导文献正是这条路最典型的用法。走 `scope`
 * 那条的话它会被「这个范围里没有条目」挡死(2026-09-28 修的就是这个)。
 */
function usesNativeEngine(workflowId: string): boolean {
  const doc = getWorkflow(workflowId);
  return doc !== null && effectiveWorkflowEngine(doc) === "node-red";
}

async function dispatchNativeInput(input: CustomUiRunAutomationInput, facts: TriggerPayload): Promise<CustomUiRunAutomationResult> {
  // Lazy import: legacy automation calls do not initialize Node-RED runtime.
  const { workflowEngineRegistry, OwnedNodeRedRuntime } = await import("@main/workflowEngines/registry.js");
  const runtime = workflowEngineRegistry.get("node-red");
  if (!(runtime instanceof OwnedNodeRedRuntime)) return { ok: false, error: "Node-RED 原生执行器不可用" };
  try {
    runtime.nativeManualTarget(input.workflowId, input.triggerNodeId);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (input.dryRun === true) return { ok: true };
  return runtime.runNativeManual(input.workflowId, input.triggerNodeId,
    { ...payloadFactsOf(facts) } as Record<string, unknown>);
}

async function runInContext(input: CustomUiRunAutomationInput): Promise<CustomUiRunAutomationResult> {
  const target = input.target;
  if (target.kind !== "collection") {
    // 大类没有唯一落点(它下面挂着好几个分类),条目和文件不是"地方"。如实说,
    // 别挑一个猜出来的分类替用户做主。
    return { ok: false, error: "这一项要在具体的分类(或小类)上右键运行" };
  }
  const collection = CollectionRepo.list().find((c) => c.id === target.collectionId);
  if (!collection) return { ok: false, error: "这个分类已经不存在了" };
  // 同 `expand`:判据是 `allTrashCollectionIds`,不是恒为 false 的 `c.isTrash`。
  if (allTrashCollectionIds().includes(collection.id)) return { ok: false, error: "回收站不能作为落点" };
  if (usesNativeEngine(input.workflowId)) {
    const result = await dispatchNativeInput(input, {
      kind: "event", event: "library.item.imported", collectionId: target.collectionId,
      ...(input.input === undefined ? {} : { input: input.input }),
    });
    return { ...result, count: 0, skipped: 0 };
  }
  if (input.dryRun === true) return { ok: true, count: 0, skipped: 0 };
  // 【Q5】非原生图 = 还挂在旧执行器上的用户图，已退场。与手动运行、钩子动作、
  // 自动化手动跑给**同一句**可照做的拒绝 —— 而不是让它落到旧 runner 里去撞一个
  // 更含糊的错误。
  return { ok: false, error: retiredGraphError(getWorkflow(input.workflowId)?.name ?? input.workflowId), count: 0, skipped: 0 };
}

export async function runCustomUiAutomation(input: CustomUiRunAutomationInput): Promise<CustomUiRunAutomationResult> {
  if (input.targetMode === "context") return runInContext(input);
  const expanded = expand(input.target, input.skipWhen);
  if (!expanded.ok) return { ok: false, error: expanded.error };
  const count = "files" in expanded ? expanded.files.length : expanded.items.length;
  const skipped = expanded.skipped;
  if (count === 0) {
    // 全被跳过 ≠ 空范围:如实说清,不让"没东西可跑"读起来像"想法不行"。
    const error = skipped > 0 ? `这 ${skipped} 条都满足跳过条件,无需运行` : "这个范围里没有条目";
    return { ok: false, error, count: 0, skipped };
  }
  // 用户是对着**确认框上那个数字**点的头(见 `expectCount`)。两次展开之间库变了的话,
  // 这一次带的就不是他同意的那一批 —— 整次拒绝,比默默按新的数量开工强。
  if (input.expectCount !== undefined && input.dryRun !== true && input.expectCount !== count) {
    return {
      ok: false,
      error: `这个范围在你确认之后变了(确认时 ${input.expectCount} 条,现在 ${count} 条)—— 请重新右键运行一次`,
      count,
      skipped,
    };
  }
  if (count > CUSTOM_UI_MAX_BATCH) {
    return {
      ok: false,
      error: `条目太多(${count} 条,一次最多 ${CUSTOM_UI_MAX_BATCH} 条)—— 请在更小的分类上运行,或让自动化自己查库`,
      count,
      skipped,
    };
  }
  if (usesNativeEngine(input.workflowId)) {
    const trigger: TriggerPayload = "files" in expanded
      ? { kind: "file", files: expanded.files, ...(input.input === undefined ? {} : { input: input.input }) }
      : { kind: "event", event: "library.item.imported", items: expanded.items,
        ...(input.input === undefined ? {} : { input: input.input }) };
    const result = await dispatchNativeInput(input, trigger);
    return { ...result, count, skipped };
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
