/**
 * **出厂预置工作流** —— `resources/presets/workflows.json` 的域读取器。
 *
 * 路径解析、文件级三态在 `@main/lib/presetFiles`(与项目初始化预设共用那一层);
 * 这里只做**工作流域**的那一半:每条过 `WorkflowDocSchema`、摘要、按 id 取完整文档。
 *
 * 导入执行仍走 `importWorkflowInto` 那**同一条**落库闸门(解析/校验/落库不重复)。
 */
import { readFileSync } from "node:fs";
import { WorkflowDocSchema, type WorkflowDoc, type PresetCatalogHealth, type PresetWorkflowSummary } from "@contracts/workflow";
import {
  parsePresetEntries,
  presetRootCandidates,
  readPresetJson,
  resolvePresetFile,
} from "@main/lib/presetFiles.js";

/** 出厂预置工作流文件的文件名 —— 与 `resources/presets/` 下那份一致。 */
export const WORKFLOW_PRESET_FILE = "workflows.json";

export type { PresetCatalogHealth, PresetWorkflowSummary };
/** 候选根/文件解析属于共用层;从本域再导出一份,调用方(IPC/冒烟)不必同时 import 两处。 */
export { presetRootCandidates, resolvePresetFile } from "@main/lib/presetFiles.js";

export interface PresetCatalog {
  health: PresetCatalogHealth;
  /** `health !== "ok"` 时**非空**:给人和界面看的原因。 */
  reason?: string;
  /** 命中的文件(诊断用)。`absent` 时是尝试过的根目录列表。 */
  path: string;
  presets: PresetWorkflowSummary[];
  /** 逐条问题(坏条目、重复 id)。`health: "ok"` 时也可能非空 —— 其余条目照常可用。 */
  problems: string[];
}

/** 读文件的那一半 —— 只依赖文件系统,不碰 DB。
 *
 *  `sameNameExists` 恒为 false:它需要库里的名字表,由 IPC handler 补
 *  (`decoratePresetCatalog`)。纯函数与 DB 解耦,smoke 才能直接断言分类逻辑。 */
/**
 * 【AUTO-03】这份预设导入后**要不要用户先做一步**。
 *
 * 判据来自迁移器（`flowMigration.ts`）的 MERGE-0 未决项，但这里**只报能提前
 * 说清楚的那两种** —— 其余未决项要等真的部署才知道，提前猜会误导。
 *
 *   - conversation / mcode.main → 主对话身份要人填会话 ID（MERGE-0 #1）；
 *   - code（非 node 语言）→ 语言面不等价（MERGE-0 #3）。
 *
 * 返回 undefined = 不需要用户做额外动作。
 */
function needsStepOf(doc: WorkflowDoc): string | undefined {
  const kinds = new Set(doc.nodes.map((node) => node.type));
  if (kinds.has("mcode.main") || kinds.has("mcode.conversation")) {
    return "部署前要在 mcode-conversation 节点里填一个现有可见会话 ID（主对话身份不能自动推断）";
  }
  if (kinds.has("mcode.code")) {
    return "代码节点需要人工确认：非 node 语言在 Node-RED 侧不等价";
  }
  return undefined;
}

export function readPresetCatalog(candidates: readonly string[] = presetRootCandidates()): PresetCatalog {
  const read = readPresetJson(WORKFLOW_PRESET_FILE, candidates);
  if (read.health !== "ok") {
    return { health: read.health, reason: read.reason, path: read.path, presets: [], problems: [] };
  }

  const workflows = (read.value as { workflows?: unknown } | null)?.workflows;
  if (!Array.isArray(workflows)) {
    return {
      health: "corrupt",
      reason: "出厂预置文件的形状不对 —— 缺 `workflows` 数组",
      path: read.path,
      presets: [],
      problems: [],
    };
  }

  const problems: string[] = [];
  const seen = new Set<string>();
  const presets: PresetWorkflowSummary[] = [];
  for (const doc of parsePresetEntries(
    workflows,
    (value) => {
      const shape = WorkflowDocSchema.safeParse(value);
      if (shape.success) return { ok: true as const, value: shape.data };
      const issues = shape.error.issues;
      const shown = issues.slice(0, 3).map((i) => (i.path.length > 0 ? `${i.path.join(".")}:${i.message}` : i.message));
      const rest = issues.length - shown.length;
      return { ok: false as const, detail: `${shown.join("; ")}${rest > 0 ? `;…(还有 ${rest} 处)` : ""}` };
    },
    "WorkflowDoc",
    problems,
  )) {
    if (seen.has(doc.id)) {
      problems.push(`id「${doc.id}」重复 —— 只保留第一条`);
      continue;
    }
    seen.add(doc.id);
    presets.push({
      id: doc.id,
      name: doc.name,
      ...(doc.description ? { description: doc.description } : {}),
      ...(doc.icon ? { icon: doc.icon } : {}),
      kind: doc.nodes.length > 0 ? "graph" : "prompt",
      ...(doc.trigger ? { trigger: doc.trigger } : {}),
      nodeCount: doc.nodes.length,
      sameNameExists: false,
      ...(doc.engine !== undefined ? { engine: doc.engine } : {}),
      ...(needsStepOf(doc) !== undefined ? { needsStep: needsStepOf(doc) } : {}),
    });
  }

  // 一条都解析不出来、而且原本确实有内容 → 视为整份坏掉(而不是"空预设" ——
  // 后者会让界面画一个空列表,像是这个版本没带内容)。
  if (presets.length === 0 && workflows.length > 0) {
    return {
      health: "corrupt",
      reason: `出厂预置文件里 ${workflows.length} 条没有一条解析得出来`,
      path: read.path,
      presets: [],
      problems,
    };
  }

  return { health: "ok", path: read.path, presets, problems };
}

/** 按 id 取**完整**预置文档(导入用)。找不到/id 重复时返回 null —— 调用方报错。 */
export function readPresetWorkflow(
  presetId: string,
  candidates: readonly string[] = presetRootCandidates(),
): { doc: WorkflowDoc; fileName: string } | { error: string } {
  const catalog = readPresetCatalog(candidates);
  if (catalog.health !== "ok") {
    return { error: catalog.reason ?? "出厂预置不可用" };
  }
  const file = catalog.path;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return { error: `出厂预置文件读不出来:${(err as Error).message}` };
  }
  const entries = (parsed as { workflows?: unknown[] }).workflows ?? [];
  for (const entry of entries) {
    const shape = WorkflowDocSchema.safeParse(entry);
    if (!shape.success) continue;
    if (shape.data.id === presetId) return { doc: shape.data, fileName: file };
  }
  return { error: `出厂预设里没有 id 为「${presetId}」的工作流` };
}

/** 把「库里已有同名」补进摘要(需要 DB 的那一半,IPC handler 调它)。 */
export function decoratePresetCatalog(catalog: PresetCatalog, existingNames: readonly string[]): PresetCatalog {
  const names = new Set(existingNames);
  return {
    ...catalog,
    presets: catalog.presets.map((p) => ({ ...p, sameNameExists: names.has(p.name) })),
  };
}

/** 仅供诊断:当前解析到的预置文件。 */
export function currentPresetFile(candidates: readonly string[] = presetRootCandidates()): string | null {
  return resolvePresetFile(WORKFLOW_PRESET_FILE, candidates);
}
