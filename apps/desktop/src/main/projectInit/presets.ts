/**
 * **出厂项目初始化模板** —— `resources/presets/project-init.json` 的读取与导入。
 *
 * ## 为什么它们不在这里播种了(【MC-006】)
 *
 * 从前 `projectInit/shipped.ts` 把「研究项目 / 代码项目 / 论文写作」三份模板**硬编码
 * 在本体里**,再按固定 UUID 在每次新装时**自动播种**进设置表。这违反 README 第零节
 * 结构原则(本体一律通用、不含任何特定场景):一个做通用软件开发或数据分析的用户,
 * 装完应用打开「初始化」就看到一份 `notes/references/experiments` 的研究项目骨架与
 * 「引用核对」约定 —— **他从没要过这些**。
 *
 * 现在它们和出厂工作流走**同一条**分发路径(`resources/presets/` + `extraResources`),
 * 也走**同一种**交互(列出 → 按需导入;导入后就是一条普通模板,可改可删)。
 *
 * ## 为什么导入要复用 `saveProjectInitializer`
 *
 * 那条路已经有一整套判据:上限 200、同名冲突、`ProjectInitDraftSchema`(路径安全、
 * 内容上限、重复路径、记忆路径唯一……)、保存前后的 revision。这里**再写一份**必然
 * 漂 —— 而漂的形态是"预设导进来的模板在界面上编辑就报错"。导入 = 把预设 draft 交给
 * 那个函数,差别只有 id/名字。
 *
 * ## 名字冲突
 *
 * 导入**总是新建**。和库里已有模板重名时,`saveProjectInitializer` 会拒绝(「已存在
 * 同名的初始化命令」)—— 那是**给用户看的动作**,所以这里改成自动加后缀,与出厂
 * 工作流导入 `uniqueWorkflowName` 同一取向:用户点的"导入"不该因为名字撞了而失败。
 */
import { ProjectInitDraftSchema, initNameKey, type ProjectInitDraft } from "@contracts/ipc/projectInit";
import { presetRootCandidates, readPresetJson, parsePresetEntries } from "@main/lib/presetFiles.js";
import {
  listProjectInitializers,
  saveProjectInitializer,
} from "@main/projectInit/service.js";

/** 出厂项目初始化预设的文件名。 */
export const PROJECT_INIT_PRESET_FILE = "project-init.json";

export interface ShippedInitializer {
  /** 出厂清单里的稳定 id(仅用于列表/幂等提示,**不是**模板的存储键)。 */
  id: string;
  draft: ProjectInitDraft;
}

export interface ProjectInitPresetSummary {
  id: string;
  name: string;
  description: string;
  /** 启用 AI 生成说明文件时的文件名(同 `ProjectInitSummary.agentFile`)。 */
  agentFile?: string;
  /** 库里已有同名模板(导入时会自动加后缀)。 */
  sameNameExists: boolean;
}

export interface ProjectInitPresetCatalog {
  health: "ok" | "absent" | "corrupt";
  reason?: string;
  path: string;
  presets: ProjectInitPresetSummary[];
  problems: string[];
}

/** 读文件 + 逐条过 `ProjectInitDraftSchema`。坏条目进 `problems`,不静默丢。 */
export function readProjectInitPresets(
  candidates: readonly string[] = presetRootCandidates(),
): { catalog: ProjectInitPresetCatalog; drafts: ShippedInitializer[] } {
  const read = readPresetJson(PROJECT_INIT_PRESET_FILE, candidates);
  if (read.health !== "ok") {
    return {
      catalog: { health: read.health, reason: read.reason, path: read.path, presets: [], problems: [] },
      drafts: [],
    };
  }

  const templates = (read.value as { templates?: unknown } | null)?.templates;
  if (!Array.isArray(templates)) {
    return {
      catalog: {
        health: "corrupt",
        reason: "出厂初始化预设的形状不对 —— 缺 `templates` 数组",
        path: read.path,
        presets: [],
        problems: [],
      },
      drafts: [],
    };
  }

  const problems: string[] = [];
  const drafts: ShippedInitializer[] = [];
  const seen = new Set<string>();
  for (const entry of parsePresetEntries(
    templates,
    (value) => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return { ok: false as const, detail: "不是对象" };
      }
      const rec = value as Record<string, unknown>;
      if (typeof rec.id !== "string" || rec.id.length === 0) return { ok: false as const, detail: "缺 id" };
      const draft = ProjectInitDraftSchema.safeParse(rec.draft);
      if (!draft.success) {
        const issues = draft.error.issues;
        const shown = issues.slice(0, 3).map((i) => (i.path.length > 0 ? `${i.path.join(".")}:${i.message}` : i.message));
        const rest = issues.length - shown.length;
        return { ok: false as const, detail: `${shown.join("; ")}${rest > 0 ? `;…(还有 ${rest} 处)` : ""}` };
      }
      return { ok: true as const, value: { id: rec.id, draft: draft.data } };
    },
    "初始化模板",
    problems,
  )) {
    if (seen.has(entry.id)) {
      problems.push(`id「${entry.id}」重复 —— 只保留第一条`);
      continue;
    }
    seen.add(entry.id);
    drafts.push(entry);
  }

  if (drafts.length === 0 && templates.length > 0) {
    return {
      catalog: {
        health: "corrupt",
        reason: `出厂初始化预设里 ${templates.length} 条没有一条解析得出来`,
        path: read.path,
        presets: [],
        problems,
      },
      drafts: [],
    };
  }

  const existing = new Set(listProjectInitializers().templates.map((t) => initNameKey(t.name)));
  return {
    catalog: {
      health: "ok",
      path: read.path,
      presets: drafts.map(({ id, draft }) => ({
        id,
        name: draft.name,
        description: draft.description,
        ...(draft.agentFile?.enabled ? { agentFile: draft.agentFile.filename } : {}),
        sameNameExists: existing.has(initNameKey(draft.name)),
      })),
      problems,
    },
    drafts,
  };
}

/** 名字重了加后缀。判据与 `uniqueWorkflowName` 同形:整个库唯一,不是这一栏。
 *
 *  ⚠️ 后缀只能用 `-N`:名字是**命令的一部分**(`/init-<名字>`),契约的 `INIT_NAME_RE`
 *  只收字母/数字/下划线/连字符 —— 括号和空格会让导入被 schema 拒掉(实测 `研究项目 (2)`)。
 */
function uniqueInitializerName(base: string, taken: ReadonlySet<string>): string {
  const key = (n: string) => initNameKey(n);
  if (!taken.has(key(base))) return base;
  for (let i = 2; i < 1000; i += 1) {
    const suffix = `-${i}`;
    const candidate = `${base.slice(0, 48 - suffix.length)}${suffix}`;
    if (!taken.has(key(candidate))) return candidate;
  }
  throw new Error(`「${base}」的同名模板太多,先清理一些再导入`);
}

/**
 * 按预设 id 导入一份。**永远新建**(不给 id/expectedRevision);重名自动加后缀。
 * 校验/落库全部走 `saveProjectInitializer` —— 共享实现只有一份。
 */
export function importProjectInitPreset(
  presetId: string,
  candidates: readonly string[] = presetRootCandidates(),
): { ok: true; id: string; name: string } | { ok: false; error: string } {
  const { catalog, drafts } = readProjectInitPresets(candidates);
  if (catalog.health !== "ok") return { ok: false, error: catalog.reason ?? "出厂初始化预设不可用" };
  const found = drafts.find((d) => d.id === presetId);
  if (!found) return { ok: false, error: `出厂初始化预设里没有 id 为「${presetId}」的模板` };

  const taken = new Set(listProjectInitializers().templates.map((t) => initNameKey(t.name)));
  const draft: ProjectInitDraft = { ...found.draft, name: uniqueInitializerName(found.draft.name, taken) };
  try {
    const saved = saveProjectInitializer({ draft });
    return { ok: true, id: saved.id, name: saved.name };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
