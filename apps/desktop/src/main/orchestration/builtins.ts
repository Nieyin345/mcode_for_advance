import { MEMORY_WORKFLOWS } from "./memoryWorkflows.js";
/**
 * 内置工作流 —— 只剩**按钮后端**那几样:`default`(哨兵)、「长任务守望」模板、三份记忆
 * 工作流。id 沿用旧值(`default` / `watch` / `memory-*`)。
 *
 * ## 可选内容不在这里了(2026-10-10 起)

 * 从前这里有**六个对话模式 + 三条自动化**。它们被**摘出去**了 —— release 版不再内置
 * 任何可选内容,一切由用户自建;那七份(检索 / 精读 / 写作 / 评审 / 代码 + 文献导入 +
 * 转 Markdown)变成仓库里的 `resources/presets/workflows.json`,用户按需导入
 * (走已有的 `workflow.import`)。
 *
 * ## 为什么这三样留着
 *
 * - **`default`**:代表"不追加任何流程"。它甚至不需要真有一行 —— `getWorkflow` 找不到
 *   就是空流程,运行语义相同 —— 留着是为了给模式下拉一个恒在的落点。
 * - **`watch`**:「守望」按钮按 `WATCH_WORKFLOW_ID` 找这份模板起跑。它是**按钮的后端**,
 *   不是用户可选的内容;摘了按钮就废了。
 * - **`MEMORY_WORKFLOWS`**:记忆助手按钮的后端,同上。
 *
 * 判据:摘的是"用户能在下拉/库里选的内容",留的是"某个按钮点了要用的模板"。
 *
 * ## 两种形态
 *
 * - **提示词型**:`prompt` 是一段流程文字,直接注入对话的系统提示词。
 * - **图型**:`nodes` + `edges` 表达流程,由调度器按依赖驱动。
 */

import {
  autoLayout,
  type WorkflowDoc,
  type WorkflowEdge,
  type WorkflowNode,
} from "@contracts/workflow";
import { BUILTIN_WORKFLOW_IDS, type BuiltinWorkflowId } from "@contracts/runtime";
import {
  NODE_INJECT_MODE_KEY,
  NODE_INJECT_TARGET_KEY,
  NODE_PROMPT_PARAM_KEY,
  NODE_TRIGGER_PROJECT_PARAM_KEY,
  NODE_TRIGGER_TASK_PARAM_KEY,
} from "@contracts/nodeType";

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

/* ── 图型内置工作流的构造 ── */

/** 图型内置工作流的一个节点,坐标先不给。 */
type NodeSpec = Omit<WorkflowNode, "position">;

/**
 * 把一组节点排好版。
 *
 * **坐标现算,不手写。** 手写的那一份会在 `CELL_W` 改掉的那天变成一坨叠在一起的
 * 卡片 —— 而那是纯视觉的坏法,没有任何测试会红,也没人会想到去查内置工作流的坐标。
 * `autoLayout` 本来就是干这个的(画布的「整理布局」和 AI 建的图用的是同一份)。
 */
function graph(nodes: readonly NodeSpec[], edges: readonly WorkflowEdge[]): WorkflowNode[] {
  const placed: WorkflowNode[] = nodes.map((n) => ({ ...n, position: { x: 0, y: 0 } }));
  const at = autoLayout(placed, [...edges]);
  return placed.map((n) => ({ ...n, position: at.get(n.id) ?? n.position }));
}

/** 一条边。id 沿用界面那套约定(`e_<from>__<to>`)—— 用户在画布上改这张图时,
 *  新拉的线和这几条长得一样。 */
function wire(
  from: string,
  to: string,
  extra: { label?: string; note?: string } = {},
): WorkflowEdge {
  return { id: `e_${from}__${to}`, from, to, ...extra };
}


/* ── 长任务守望(图型,内置模板)────────────────────────────── */

/**
 * 守望模板的 id 与**图上三个节点的 id** —— 「守望」按钮起跑时靠它们找到入口、
 * 把这一次的命令与消息填进去(见 `automationRunner.startWatch`)。
 *
 * ⚠️ 它**不在** `BUILTIN_WORKFLOW_IDS` 里:那份列表是**对话模式下拉**的六个,
 * 守望不是一种聊天模式,不该出现在那儿。它只出现在工作流库的「自动化」栏,
 * 以及会话输入区那颗「守望」按钮后面。
 */
export const WATCH_WORKFLOW_ID = "watch";
export const WATCH_TRIGGER_NODE_ID = "watch-trigger";
export const WATCH_COMMAND_NODE_ID = "watch-command";
export const WATCH_SAY_NODE_ID = "watch-say";

/**
 * 触发器上「这次要做什么」的兜底。用户把模板改到把这句话删了的时候,守望按钮
 * 照这句话起跑 —— 而不是带着一句空请求跑出去。
 */
export const WATCH_DEFAULT_TASK =
  "运行「跑命令」里写的那条命令,等它退出,把退出码与输出尾部交给下一步。";

/**
 * 注入那一步的默认指令。发进发起会话的是**完整的一轮提示词**(命令的退出码、
 * 输出尾部这些上游产出由调度器拼在这句话后面),所以这里只需要把
 * "为什么这条对话里突然冒出一条消息"交代清楚。
 */
export const WATCH_DEFAULT_MESSAGE =
  "守望的命令已经跑完了。下面是这次守望的说明,以及命令的退出码与输出尾部 —— 请接着处理。";

const WATCH_NODES: readonly NodeSpec[] = [
  {
    id: WATCH_TRIGGER_NODE_ID,
    type: "mcode.trigger",
    title: "守望入口",
    params: {
      triggerKind: "manual",
      // ⚠️ **空是故意的**:内置模板没法预知这台机器上有哪些项目。守望按钮起跑时
      // 会把**发起会话的项目**填进来并顺手存一份(见 `automationRunner.startWatch`)
      // —— 所以用过一次之后,这一项就有着落了。在那之前想在库里手工「立刻运行一次」,
      // 先在触发器上把项目填上(存盘那一关本来就要求它非空)。
      [NODE_TRIGGER_PROJECT_PARAM_KEY]: "",
      [NODE_TRIGGER_TASK_PARAM_KEY]: WATCH_DEFAULT_TASK,
    },
  },
  {
    id: WATCH_COMMAND_NODE_ID,
    type: "mcode.command",
    title: "跑命令",
    params: {
      // 面板每次起跑都会填(选的模板或现写的那条),这里只是让图开箱看着是个完整的东西。
      command: "echo done",
      timeoutMs: 0,
    },
  },
  {
    id: WATCH_SAY_NODE_ID,
    type: "mcode.conversation",
    title: "回话",
    params: {
      [NODE_PROMPT_PARAM_KEY]: WATCH_DEFAULT_MESSAGE,
      // 守望的本职:发完就走,发回**发起会话**。想改成发完等一轮回答、或发进跑图的
      // 会话,在节点上改这两个下拉(见 `@contracts/nodeType` 的 INJECT_*)。
      [NODE_INJECT_MODE_KEY]: "auto",
      [NODE_INJECT_TARGET_KEY]: "origin",
    },
  },
];

const WATCH_EDGES: readonly WorkflowEdge[] = [
  wire(WATCH_TRIGGER_NODE_ID, WATCH_COMMAND_NODE_ID),
  wire(WATCH_COMMAND_NODE_ID, WATCH_SAY_NODE_ID),
];


/* ── 内置工作流(六个对话模式 + 两条自动化)── */

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
  {
    // **不是对话模式**(见 WATCH_WORKFLOW_ID 上的说明):它没有 prompt、不出现在
    // 模式下拉里。入口是会话输入区那颗「守望」按钮(D3),以及工作流库的自动化栏。
    id: WATCH_WORKFLOW_ID,
    name: "长任务守望",
    // 会进流程记录的开头(同 search/write 的规矩),写的是这条流程是干什么的。
    description: "跑一条命令,等它退出,把退出码与输出尾部注入发起会话。",
    icon: "eye",
    nodes: graph(WATCH_NODES, WATCH_EDGES),
    edges: [...WATCH_EDGES],
    trigger: "manual",
    builtin: true,
    updatedAt: 0,
  },
];

/** 按 id 取内置工作流的默认版。 */
export function getBuiltinWorkflow(id: string): WorkflowDoc | undefined {
  return BUILTIN_WORKFLOWS.find((w) => w.id === id);
}
