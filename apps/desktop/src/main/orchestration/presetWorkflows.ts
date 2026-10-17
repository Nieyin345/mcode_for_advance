/**
 * **出厂预置工作流** —— `resources/presets/workflows.json` 的运行时读取器。
 *
 * ## 它补的是哪一段(MC-007)
 *
 * 2026-10-10 把五个对话模式 + 两条自动化从 `builtins.ts` 摘出去,落成仓库里的
 * `resources/presets/workflows.json`,注释写着「用户按需导入,走已有的 `workflow.import`」。
 * 但那份文件**没有任何运行时代码读它**:`grep -rn "resources/presets" src` 只命中注释;
 * `electron-builder.yml` 也没有 `extraResources` 把它打进安装包。结果是**内容外置了、
 * 可达路径没给**:release 用户和 Agent 都拿不到这七份,只有开发者 clone 仓库后手动
 * 导文件。
 *
 * 这一份把「出厂内容」做成**可发现的**:主进程读文件 → `workflow.listPresets` 列摘要
 * → `workflow.importPreset` 按 id 导入(导入执行仍走 `importWorkflowInto` 那**同一条**
 * 落库闸门,不另写一份解析/校验/落库)。
 *
 * ## 路径解析:为什么是三个候选,而不是一个
 *
 * | 场景 | 候选 |
 * |---|---|
 * | 打包后(安装包) | `process.resourcesPath/presets/workflows.json`(`extraResources` 铺过去) |
 * | 开发(`pnpm dev`)/ 无头 smoke | `<cwd>/resources/presets/workflows.json` |
 * | 从仓库根跑脚本 | `<cwd>/apps/desktop/resources/presets/workflows.json` |
 *
 * **不用 `__dirname`/`import.meta.url` 拼模块相对路径**:main chunk 是 CJS、无头
 * esbuild bundle 是 ESM,两种模块系统各有一个(且另一个在对面不存在)。进程级的
 * `cwd` 与 `resourcesPath` 两边都在,候选表也就能在两种宿主里跑同一份逻辑 ——
 * smoke 验的就是生产代码本身,不是抄本。
 *
 * 一个都命中不了 → `absent`,**显式返回状态给调用方**,不抛、不静默返回空列表
 * (硬规矩 3:坏东西显式报出来)。渲染端据此说「这个安装包没带出厂预设」。
 *
 * ## 分类与形状:坏条目**逐条**报出来,好的照常可用
 *
 * 文件里每一条都过 `WorkflowDocSchema`(契约是单一事实源,这里不另立一份)。坏条目
 * 进 `problems`,**不静默丢掉** —— 少列一项而什么都不说,正是「内容凭空消失」的形态。
 * 整份 JSON 解析不了才是 `corrupt`(那种情况下一条都用不了)。
 *
 * ## 与 `builtins.ts` 的分工
 *
 * - `builtins.ts`:按钮后端(`default` / `watch` / 记忆工作流),**播种**进表、删不掉语义。
 * - 这份:用户**按需导入**的出厂内容,导进来就是普通行(可改可删)。
 *
 * 两条路都汇进 `saveWorkflow`,不各自维护一套写库逻辑。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WorkflowDocSchema, type WorkflowDoc, type PresetCatalogHealth, type PresetWorkflowSummary } from "@contracts/workflow";

/** 出厂预置在磁盘上的相对路径(相对每个候选根)。 */
const PRESET_RELATIVE_PATH = join("resources", "presets", "workflows.json");

/**
 * 候选根目录(按优先级)。
 *
 * `MCODE_PRESET_ROOT` 是给**打包验证 / 特殊安装布局**留的显式覆盖:设了就**只**用它
 * —— 一个显式指定的位置读不到时报 `absent`,而不是悄悄落到别的候选上装作读到了。
 */
export function presetRootCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const override = env["MCODE_PRESET_ROOT"];
  if (override !== undefined && override.length > 0) return [override];
  const roots: string[] = [];
  if (process.resourcesPath) roots.push(String(process.resourcesPath));
  roots.push(process.cwd());
  roots.push(join(process.cwd(), "apps", "desktop"));
  return roots;
}

/** 解析到**第一个真实存在**的预置文件;都不在返回 null(调用方报 `absent`)。 */
export function resolvePresetFile(candidates: readonly string[] = presetRootCandidates()): string | null {
  for (const root of candidates) {
    const file = join(root, PRESET_RELATIVE_PATH);
    if (existsSync(file)) return file;
  }
  return null;
}

export type { PresetCatalogHealth, PresetWorkflowSummary };

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
export function readPresetCatalog(candidates: readonly string[] = presetRootCandidates()): PresetCatalog {
  const file = resolvePresetFile(candidates);
  if (file === null) {
    return {
      health: "absent",
      reason: `没有找到出厂预置文件(${PRESET_RELATIVE_PATH});试过:${candidates.join("、")}`,
      path: candidates.map((root) => join(root, PRESET_RELATIVE_PATH)).join("、"),
      presets: [],
      problems: [],
    };
  }

  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    return {
      health: "corrupt",
      reason: `出厂预置文件读不出来:${(err as Error).message}`,
      path: file,
      presets: [],
      problems: [],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      health: "corrupt",
      reason: `出厂预置文件不是合法 JSON:${(err as Error).message}`,
      path: file,
      presets: [],
      problems: [],
    };
  }

  if (parsed === null || typeof parsed !== "object" || !Array.isArray((parsed as { workflows?: unknown }).workflows)) {
    return {
      health: "corrupt",
      reason: "出厂预置文件的形状不对 —— 缺 `workflows` 数组",
      path: file,
      presets: [],
      problems: [],
    };
  }

  const entries = (parsed as { workflows: unknown[] }).workflows;
  const presets: PresetWorkflowSummary[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();

  entries.forEach((entry, index) => {
    const shape = WorkflowDocSchema.safeParse(entry);
    if (!shape.success) {
      // 只列前 3 条 issue,但把"还有几条"说出来(与 `importWorkflowDoc` 同一条口径:
      // 少列了东西要显式写一句,否则用户以为改完这几处就好了)。
      const issues = shape.error.issues;
      const shown = issues.slice(0, 3).map((i) => (i.path.length > 0 ? `${i.path.join(".")}:${i.message}` : i.message));
      const rest = issues.length - shown.length;
      problems.push(`第 ${index + 1} 条不是合法的 WorkflowDoc:${shown.join("; ")}${rest > 0 ? `;…(还有 ${rest} 处)` : ""}`);
      return;
    }
    const doc: WorkflowDoc = shape.data;
    if (seen.has(doc.id)) {
      problems.push(`第 ${index + 1} 条的 id「${doc.id}」与前面重复 —— 只保留第一条`);
      return;
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
    });
  });

  // 一条都解析不出来、而且原本确实有内容 → 视为整份坏掉(而不是"空预设" ——
  // 后者会让界面画一个空列表,像是这个版本没带内容)。
  if (presets.length === 0 && entries.length > 0) {
    return {
      health: "corrupt",
      reason: `出厂预置文件里 ${entries.length} 条没有一条解析得出来`,
      path: file,
      presets: [],
      problems,
    };
  }

  return { health: "ok", path: file, presets, problems };
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
