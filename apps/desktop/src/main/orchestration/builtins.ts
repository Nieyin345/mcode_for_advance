import { MEMORY_WORKFLOWS } from "./memoryWorkflows.js";
/**
 * 内置工作流 —— 只剩**按钮后端**那几样:`default`(哨兵)与三份记忆工作流。
 * id 沿用旧值(`default` / `memory-*`)。
 *
 * ## 可选内容不在这里了(2026-10-10 起)
 *
 * 从前这里有**六个对话模式 + 三条自动化**。它们被**摘出去**了 —— release 版不再内置
 * 任何可选内容,一切由用户自建;那七份(检索 / 精读 / 写作 / 评审 / 代码 + 文献导入 +
 * 转 Markdown)变成仓库里的 `resources/presets/workflows.json`,用户按需导入
 * (走已有的 `workflow.import`)。
 *
 * ## 为什么这两样留着
 *
 * - **`default`**:代表"不追加任何流程"。它甚至不需要真有一行 —— `getWorkflow` 找不到
 *   就是空流程,运行语义相同 —— 留着是为了给模式下拉一个恒在的落点。
 * - **`MEMORY_WORKFLOWS`**:记忆助手按钮的后端,同上。
 *
 * 判据:摘的是"用户能在下拉/库里选的内容",留的是"某个按钮点了要用的模板"。
 *
 * **「长任务守望」已移除（2026-10-27）**：它是用户能用工作流或扩展自己搭出来的东西，
 * 做成内置模板反而把一种做法锁死在宿主里。它的模板、IPC、面板与测试夹具同批删除。
 *
 * ## 两种形态
 *
 * - **提示词型**:`prompt` 是一段流程文字,直接注入对话的系统提示词。
 * - **图型**:`nodes` + `edges` 表达流程,由调度器按依赖驱动。
 */

import type { WorkflowDoc } from "@contracts/workflow";
import { BUILTIN_WORKFLOW_IDS, type BuiltinWorkflowId } from "@contracts/runtime";

/** 内置工作流的 id。**直接引用 contracts 那一份,不在这里复制一份。**
 *
 *  ⚠️ 自 2026-10-10 可选内容外置后,这份列表只剩 `default` —— 五个对话模式
 *  (检索/精读/写作/评审/代码)不再内置,用户从 `resources/presets/workflows.json`
 *  导入。选择器改成"列库里真实的流程",不再靠这份列表兜底(见 `WorkflowDropdown`)。 */
export { BUILTIN_WORKFLOW_IDS };
export type { BuiltinWorkflowId };

export function isBuiltinWorkflowId(value: unknown): value is BuiltinWorkflowId {
  return typeof value === "string" && (BUILTIN_WORKFLOW_IDS as readonly string[]).includes(value);
}

/* ── 内置工作流 ── */

/** 内置工作流的**默认版**。用户的修改不入这里 —— 它们存在 `workflows` 表里,
 *  同名 id 的一行覆盖这里的一份;「恢复默认」= 删掉那一行(见 `main/orchestration/`)。 */
export const BUILTIN_WORKFLOWS: readonly WorkflowDoc[] = [
  ...MEMORY_WORKFLOWS,
  {
    id: "default",
    // ⚠️ `name` / `description` 只是**兜底与日志用**。内置工作流在界面上显示的名字
    // 走 i18n(`composer.mode.*`,和原来那个模式下拉是同一组键),这样切语言时
    // 它们跟着变 —— 而用户自建的工作流用的是 `name` 字段(用户自己起的名字不该被翻译)。
    name: "默认",
    description: "不追加任何流程,通用助手。",
    icon: "message",
    // 默认模式**故意没有提示词** —— 它是"什么都不追加"的逃生口,身份片段与文件架构
    // 片段本来就在每一轮里。用空字符串而不是省略字段,是为了让"它有一条空提示词"
    // 和"这个字段没人填"在数据上可区分。
    prompt: "",
    nodes: [],
    edges: [],
    builtin: true,
    updatedAt: 0,
  },
];

/** 按 id 取内置工作流的默认版。 */
export function getBuiltinWorkflow(id: string): WorkflowDoc | undefined {
  return BUILTIN_WORKFLOWS.find((w) => w.id === id);
}
