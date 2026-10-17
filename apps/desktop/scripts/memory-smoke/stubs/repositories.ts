/**
 * `@main/store/repositories.js` 的替身 —— 只给出 `groupRegistry` 要的那一个 `SettingRepo`。
 *
 * ## 为什么这一套需要它
 *
 * 场景 5b 要断言的是**真货的参数表**(`nodeTypes.ts` 的内置清单)—— 而 `ioParams()`
 * 那一格「资料」的下拉候选是照着**大类表 + 模版类目**算的(`loadLibraryGroups`),
 * 大类表真身在 settings 表里,于是 `nodeTypes.ts` 会一路 import 到 sql.js 的库上。
 * 无头脚本里 `initDb()` 没跑过,报的是 `getDb() called before initDb() resolved`。
 *
 * 这一套**不需要**真的 settings 表:大类表读不到就退出厂两组(见 `groupRegistry` 里那条
 * 兜底),而出厂那两组正是我们要的那种"资料"下拉。所以给一个内存版,`get` 一律返回 null
 * —— 这跟"用户从没动过大类"逐字一致。
 *
 * ⚠️ **绝不能让真的那个被 import 进来**:真的 `SettingRepo.set` 内部就是 `persist()`,
 * 一次写入就够整份重写用户的 `mcode.db`。给桩是**安全前提**,不只是省事。
 *
 * ## 【MC-041 收尾】`WorkflowRepo` 是后来被迫进来的,不是这一套想验的东西
 *
 * `appControl/tools.ts` 在 MC-041 里加了一句 `import { getWorkflow } from
 * "@main/orchestration/library.js"`(派生工具描述要用工作流声明),于是**任何**打到
 * `appControl/tools` 的 bundle(app-control-smoke、本套件……)都会把 `library.ts`
 * 整份拉进来 —— 而它顶层 `import { SettingRepo, WorkflowRepo }`。这与 `SettingRepo`
 * 当年"被迫进来"是同一件事的又一次发生:本套件与 tools.ts 都不碰 WorkflowRepo 的
 * 内容,给一个内存空表即可(读不到 = 没有自建工作流,正是这台无头机器的事实)。
 *
 * 形状照抄 `mcode-admin-smoke/stubs/repositories.ts` 的 `WorkflowRepo`(那一份被
 * `library.ts` 的 save/list 验过),只保留 `library.ts` 真正会调的四个方法。
 */
import type { WorkflowDoc } from "@contracts/workflow";

export const SettingRepo = {
  get(_key: string): string | null {
    return null;
  },
  getMany(keys: string[]): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    for (const k of keys) out[k] = null;
    return out;
  },
  set(_key: string, _value: string): void {
    // 只读桩:这一套不该有任何东西往 settings 里写。真写了就抛,而不是默默吞掉 ——
    // 那说明被测的那条路比预想的更靠下,得回来看一眼。
    throw new Error("memory-smoke 的 SettingRepo 是只读桩 —— 有东西想往 settings 里写");
  },
};

// ⚠️ **两个会话、两个项目**是有意的(MC-092 真实入口):`isolated-memory-test` → `p_memory`
// (项目 A),`memory-session-b` → `p_other`(项目 B)。只给一个会话,「A 见 A、B 见 B、互不可见」
// 这三条就退化成「A 见 A」一条 —— 跨项目那条断言恒真、测不出隔离。**别的 id 一律 `undefined`**
// (会话身份缺失)—— 真实入口用例靠它验「无可信身份 → 拒,而非降级看全部」。
export const SessionRepo = { get(id: string) {
  if (id === "isolated-memory-test") return { id, projectId: "p_memory", kind: "chat", parentSessionId: null, nodeId: null };
  if (id === "memory-session-b") return { id, projectId: "p_other", kind: "chat", parentSessionId: null, nodeId: null };
  return undefined;
} };
// ⚠️ **两个项目**是有意的:MC-092 的 `memory.manage` list 会把项目清单按可见集合滤过
// (`projects/p_other` 对 p_memory 的会话不可见)—— 只给一个项目,那条过滤断言就恒真、
// 测不出东西。这里给第二个项目当**不可见**的反例。
export const ProjectRepo = { list() { return [
  { id: "p_memory", name: "Memory test", path: "/isolated" },
  { id: "p_other", name: "Other project", path: "/isolated-other" },
]; } };

// ── 【MC-041 收尾】`library.ts` 顶层要的内存空表(见文件头注释)。──
export interface WorkflowRow {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  builtin: boolean;
  doc: WorkflowDoc;
  updatedAt: number;
}

const workflowRows = new Map<string, WorkflowRow>();

/** 读不到 = 这台无头机器没有自建工作流;本套件的断言不落在这张表上。 */
export const WorkflowRepo = {
  list(): WorkflowRow[] {
    return [...workflowRows.values()];
  },
  get(id: string): WorkflowRow | null {
    return workflowRows.get(id) ?? null;
  },
  save(doc: WorkflowDoc): void {
    const existing = workflowRows.get(doc.id);
    workflowRows.set(doc.id, {
      id: doc.id,
      name: doc.name,
      description: doc.description ?? null,
      icon: doc.icon ?? null,
      // 与真表一致:对内置 id 写的这一行就是"覆盖内置"。
      builtin: existing?.builtin ?? false,
      doc,
      updatedAt: doc.updatedAt,
    });
  },
  remove(id: string): void {
    workflowRows.delete(id);
  },
};
