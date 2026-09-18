/**
 * 节点类型注册表 —— 把三处来源合成一份"当前可用"的清单。
 *
 * ## 三种来源
 *
 * | 来源 | 在哪 | 谁写的 |
 * |---|---|---|
 * | `builtin` | 本文件(代码) | 随应用发布 |
 * | `plugin` | `~/.mcode/plugins/<名>/<版本>/node-types/` | 从市场 / git / zip 装进来的 |
 * | `local` | `<数据根>/workflows/node-types/` | 用户自己写的,或让 AI 写的 |
 *
 * 同名时 **local > plugin > builtin**(见 `@contracts/nodeType` 的 `NODE_TYPE_SOURCE_RANK`)。
 * 但内置类型前缀 `mcode.` 是保留的,所以实际能发生的覆盖是 **local 盖 plugin**。
 *
 * ## 为什么 `plugin` 那条路不用新写任何下载代码
 *
 * 插件系统已经有四路安装(本地目录 / `.zip` / git / 市场)、版本化落盘、安装前审查
 * 对话框、启用状态。节点类型做成插件的一个**组件种类**(清单里加 `nodeTypes` 字段),
 * 这些全都直接继承 —— 见 `contracts/plugin.ts` 与 `plugins/pluginManifest.ts` 的
 * `pluginNodeTypesDirs`。
 *
 * ## 三个刻意的取舍
 *
 * ### 1. 不缓存
 *
 * 每次调用都重新读盘。看着浪费,但节点类型是**几个小文件**,而缓存要么加一个失效
 * 机制(装插件 / 卸插件 / 改文件时清),要么就等着它过期 —— 那是这类代码最典型的
 * bug 来源(用户改完文件,界面还是旧的)。真慢了再加,别提前加。
 *
 * ### 2. 坏的清单**不静默丢弃**
 *
 * 一个格式错的文件如果被悄悄跳过,用户看到的现象是"我写的类型没出现",而没有任何
 * 线索。所以加载器把问题一起返回(见 {@link NodeTypeCatalog.problems}),界面可以
 * 原样显示错误。这和插件市场"坏条目单独跳过并报告"是同一个做法。
 *
 * ### 3. 目录名在这里复述了一遍
 *
 * ⚠️ 本文件**故意不 import `@main/workflows/seed.js` 的 `workflowsRoot()`** ——
 * `ipc/orchestration.ts` 立了一条硬规矩:`main/orchestration/` 与 `main/workflows/`
 * 互不 import(两个"workflow"是两件事)。但节点类型的目录确实落在同一个用户可见的
 * 位置下,所以这里自己拼了一次路径。
 *
 * 这是有意的取舍:**宁可两处各写一次目录名,也不要为了去重把两个概念重新缠在一起。**
 * 目录改名时两处都要改 —— 这是那条规矩的代价,认。
 */

import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import {
  BRANCH_NODE_TYPE_ID,
  DECIDER_MODES,
  DEFAULT_DECIDER_INSTRUCTION,
  DEFAULT_TRIGGER_DEBOUNCE_MS,
  INJECT_MODES,
  INJECT_TARGETS,
  MAIN_NODE_TYPE_ID,
  NODE_ASK_PARAM_KEY,
  NODE_CODE_INPUT_KEY,
  NODE_CODE_LANGUAGE_KEY,
  NODE_CODE_PARAM_KEY,
  NODE_CODE_TIMEOUT_KEY,
  NODE_COMMAND_PARAM_KEY,
  NODE_COMMAND_TIMEOUT_KEY,
  NODE_CONTEXT_KINDS,
  NODE_CONTEXT_PARAM_KEY,
  NODE_CRITERIA_PARAM_KEY,
  NODE_DECIDER_KEY,
  NODE_FLOW_RECORD_PARAM_KEY,
  NODE_INJECT_MODE_KEY,
  NODE_INJECT_TARGET_KEY,
  NODE_MCP_PARAM_KEY,
  NODE_OPTIONS_PARAM_KEY,
  NODE_PLUGINS_PARAM_KEY,
  NODE_PROMPT_PARAM_KEY,
  NODE_PROVIDER_PARAM_KEY,
  NODE_RETURN_PARAM_KEY,
  NODE_SKILLS_PARAM_KEY,
  NODE_TRIGGER_CRON_PARAM_KEY,
  NODE_TRIGGER_DEBOUNCE_PARAM_KEY,
  NODE_TRIGGER_EVENTS_PARAM_KEY,
  NODE_TRIGGER_FILTER_PARAM_KEY,
  NODE_TRIGGER_KIND_PARAM_KEY,
  NODE_TRIGGER_PATHS_PARAM_KEY,
  NODE_TRIGGER_PROJECT_PARAM_KEY,
  NODE_TRIGGER_TASK_PARAM_KEY,
  NODE_TYPE_SOURCE_RANK,
  RESERVED_NODE_TYPE_PREFIX,
  TRIGGER_NODE_TYPE_ID,
  validateNodeTypeManifest,
  type NodeContextKind,
  type NodeParamSpec,
  type NodeTypeCatalog,
  type NodeTypeEntry,
  type NodeTypeManifest,
  type NodeTypeSource,
} from "@contracts/nodeType";
import { dataRoot } from "@main/lib/dataRoot.js";
import { loadLibraryTypes } from "@main/library/kindRegistry.js";
import {
  NODE_OUTPUT_CONTRACT_KEY,
  NODE_OUTPUT_VARS_KEY,
} from "@contracts/outputConstraint";
import { getEnabledPluginNodeTypeSources } from "@main/plugins/pluginManager.js";

/* ── 内置 ── */

/** 内置的"子 agent"节点类型 id。 */
export const NODE_AGENT_TYPE_ID = "mcode.agent";

/**
 * 内置的"对话节点"类型 id —— **在主对话里跑**的那一种(见
 * `@contracts/nodeType` 的 `runner.kind === "conversation"`)。
 *
 * 它和子 agent 的差别**只在"在哪儿跑"**:子 agent 新开一段会话(隔离),它就在用户
 * 自己的对话里说一句。参数表因此分成两组 —— 「这一步靠什么跑」(技能 / MCP / 插件 /
 * 模型 / 引擎)只有子 agent 有,而「进来什么、出去什么」(资料 / 流程记录 / 产出变量 /
 * 并回主对话)两边共用。
 */
export const NODE_CONVERSATION_TYPE_ID = "mcode.conversation";

/**
 * 内置的"命令节点"类型 id —— 在本机跑一条 shell 命令的那一种(见
 * `@contracts/nodeType` 的 `runner.kind === "command"` 的 `param` 形状)。
 *
 * 它是自动化里"动手"的那一步:起训练、跑评测、拉日志。跑什么写在节点参数里
 * (`NODE_COMMAND_PARAM_KEY`),命令结束这一步才结束;退出码和输出尾部作为产出交给
 * 下游 —— 要按成败分流,下游接一个决定权给模型的分支看「退出码」。
 */
export const NODE_COMMAND_TYPE_ID = "mcode.command";

/**
 * 「资料」下拉的候选 —— **类型注册表的现读**。
 *
 * 统一资料库之前这里是 `NODE_CONTEXT_KINDS`(内置八类)+ 一张写死的中文名表;现在
 * kind 开放注册(见 `@contracts/libraryTypes` 与 `main/library/kindRegistry`),下拉
 * 直接按注册表出 —— 用户自建的类型,勾资料时就能勾到。`loadLibraryTypes` 带缓存,
 * 清单每次重新生成也不会反复读盘。
 *
 * 名字显示的是**注册表里的 name**(内置类型即出厂中文名) —— 它是清单的一部分,由
 * 注册表作者(内置=我们,自定义=用户)写,不走 i18n,和清单里其他 label 同一规则。
 */
function contextOptions(): Array<{ value: string; label: string }> {
  return loadLibraryTypes().map((t) => ({ value: t.id, label: t.name }));
}

/**
 * 「指令」那段说明 —— **子 agent** 版。
 *
 * ⚠️ **一两句就够。** 这段字是印在控件下面的一行小字,不是文档 —— 长过三行就没人读了,
 * 而它要传达的其实只有两件事:写窄、写完成判据。理由与展开写在
 * `node-types-README.md` 里(那是给要读的人读的地方),模型那一侧由 `usage` 兜着。
 */
const AGENT_INSTRUCTION_HELP =
  "这一步要做什么。**只写这一步**,末尾加一句「做完的样子」—— 少了它,模型容易做一半就停。";

/** 「指令」那段说明 —— **主代理**版。和上面那段是同一件事的两面:子 agent 怕它做多,
 *  主代理怕它做少(自己把活干完了,下游就没得干)。 */
const MAIN_INSTRUCTION_HELP =
  "用户的原话会原样送到这里,所以写「收到之后怎么处理」。**你的职责是拆解与分配**,把活分下去。";

/**
 * 「指令」那段说明 —— **对话节点**版。
 *
 * 三段说明是同一件事的三个面:子 agent 怕它**做多**(它只看得到这一步),主代理怕它
 * **做少**(它离用户最近,容易把活全干完),而对话节点写的是**一句用户会说的话** ——
 * 它就是要被当成用户说的那一句发出去的。
 */
const CONVERSATION_INSTRUCTION_HELP =
  "这一步要说的那句话 —— 它会作为一条用户消息发进主对话。**主对话已经知道的不必重复**。";

/**
 * 「指令」那段说明 —— **分支(模型选)**版。
 *
 * 留空也行:留空时代码用 {@link DEFAULT_DECIDER_INSTRUCTION} 兜底(照着上游结果从选项
 * 里挑一条)。这里写的是**判据** —— "按什么挑",不是"做什么"。
 */
const DECIDER_INSTRUCTION_HELP =
  "选路的判据 —— 看上游的什么、按什么标准挑。留空则只要求它从选项里挑最合适的一条。";

/**
 * 「这一步靠什么跑」那一组 —— 技能 / MCP / 插件 / 模型 / 引擎。
 *
 * **只有隔离节点有这一组。** 它们全都是"给这一步单独配一套环境"的意思,而对话节点跑的
 * 就是主对话那一套,配了也不算数(见下面 `ioParams` 那段:对话节点只取另外一组)。
 */
function capabilityParams(): NodeParamSpec[] {
  return [
    {
      key: NODE_SKILLS_PARAM_KEY,
      kind: "ref",
      from: "skills",
      // 多选:一步用几个技能是正常的(先检索再精读)。
      multiple: true,
      label: "技能",
      help: "这一步可以调用哪些技能。留空 = 不限制。",
    },
    {
      key: NODE_MCP_PARAM_KEY,
      kind: "ref",
      from: "mcp",
      multiple: true,
      label: "MCP 服务器",
      help: "这一步能用哪几个 MCP 服务器。留空 = 不限;少挂一个就少一份工具说明进上下文。",
    },
    {
      key: NODE_PLUGINS_PARAM_KEY,
      kind: "ref",
      from: "plugins",
      multiple: true,
      label: "插件",
      help: "这一步加载哪几个插件。留空 = 全部已启用的。",
    },
    {
      key: "model",
      kind: "ref",
      from: "models",
      label: "模型",
      help: "留空则使用本次对话选定的模型。",
    },
    {
      key: NODE_PROVIDER_PARAM_KEY,
      kind: "ref",
      from: "providers",
      label: "引擎",
      help: "这一步交给哪家引擎执行。留空则与对话保持一致。",
    },
  ];
}

/**
 * 「这一步收到什么 / 交出什么」那一组 —— 资料 / 读流程记录 / 期望产出 / 产出变量 /
 * 回到主对话。
 *
 * **这一组两种节点都有**(隔离的子 agent 与跑在主对话里的对话节点)。它们说的是同一件
 * 事的两端:**进来什么**(资料、流程记录)和**出去什么**(产出、以及跑完并回主对话多少),
 * 而这两件事跟"在哪儿跑"没关系 —— 对话节点同样会收到上游产出、同样可以按一张表交东西。
 */
function ioParams(): NodeParamSpec[] {
  return [
    {
      key: NODE_CONTEXT_PARAM_KEY,
      kind: "select",
      // 多选:一步常常既要文献又要模版(照着别人的格式写自己的内容)。
      multiple: true,
      label: "资料",
      options: contextOptions(),
      help: "这一步要读哪几类资料。只有主对话已经挂载的那几类;没挂载就是没有。",
    },
    {
      key: NODE_FLOW_RECORD_PARAM_KEY,
      kind: "boolean",
      label: "读流程记录",
      help: "打开后读到的是本流程至今每一步的产出,而不只是直接上游。上下文会明显变长,按需打开。",
    },
    {
      key: NODE_OUTPUT_CONTRACT_KEY,
      kind: "longtext",
      label: "期望产出",
      help: "这一步要交出来的东西长什么样。**这段是说明,不强制** —— 会被检查的是下面那张表。",
    },
    {
      key: NODE_OUTPUT_VARS_KEY,
      kind: "variables",
      label: "产出变量",
      help: "这一步要交出来的东西,一样一行。填了下游才能用 `{{某步.变量名}}` 取到。",
    },
  ];
}

/**
 * 「跑完并回主对话多少」—— **只有隔离节点有这一个**。
 *
 * 对话节点不需要它:它本来就在主对话里说那一句,内容和过程天然就在那儿了。给它一个
 * 「不并回」的开关只会让人以为能"说完不留痕",而那是做不到的。
 */
function returnToChatParam(): NodeParamSpec[] {
  return [
    {
      key: NODE_RETURN_PARAM_KEY,
      kind: "select",
      label: "回到主对话",
      options: [
        { value: "none", label: "不并回" },
        { value: "result", label: "只并结果" },
        { value: "full", label: "过程和结果都并" },
      ],
      help: "这一步跑完之后有多少东西并回主对话。并回去的内容下一轮才生效(那个助手那时才看得到)。",
    },
  ];
}

/**
 * 「交出什么」—— **只有「产出变量」这一格**。
 *
 * ⚠️ **别把它和 `ioParams()` 混起来。** `ioParams()` 那一组(资料、读流程记录、
 * 期望产出、产出变量)是给**和模型对话**的节点用的 —— 「资料」要读库、「读流程记录」
 * 要读流程,而 **`code` / `command` 这两种节点既没有模型、也不读库资料和流程记录**,
 * 把它们整组塞过去只会多出两个填了也不生效的控件。
 *
 * 它们真正需要的只有这一格:`code`/`command` 交出来的东西(退出码、stdout、stderr)
 * 是固定的,但**要不要按一张表交东西给下游取**是它们自己的事 —— 和对话节点同一套读法。
 */
function outputVarsParam(): NodeParamSpec[] {
  return [
    {
      key: NODE_OUTPUT_VARS_KEY,
      kind: "variables",
      label: "产出变量",
      help: "这一步要交出来的东西,一样一行。填了下游才能用 `{{某步.变量名}}` 取到。",
    },
  ];
}

/**
 * 两种内置 agent 节点**共用**的参数表 —— 只差「指令」那一段说明。
 *
 * 为什么要共用:主代理和子 agent 能填的东西是**同一套**(技能、模型、引擎、上下文、
 * 产出约定),差别只在"这一步该干什么",而那件事正是 `instruction` 的 help 要讲的。
 * 各抄一份的话,以后加一个参数就要记得改两处,而漏掉的那一处表现是"主代理莫名其妙
 * 少了一个能力" —— 没人会想到是复制粘贴漏了。
 *
 * ⚠️ **`help` 一律一两句。** 它是印在控件下面的一行小字(`ParamField`),不是文档:
 * 四行以上没人读,反而把下面那个真的控件挤到屏幕外。要讲的道理写在
 * `node-types-README.md` 里 —— 那里才是给"想弄明白为什么"的人读的地方。
 */
function agentParams(instructionHelp: string, extra: NodeParamSpec[] = []): NodeParamSpec[] {
  return [
    {
      key: NODE_PROMPT_PARAM_KEY,
      kind: "longtext",
      label: "指令",
      required: true,
      help: instructionHelp,
    },
    ...extra,
    ...capabilityParams(),
    ...ioParams(),
    ...returnToChatParam(),
  ];
}

/**
 * 主对话入口节点的**输入选项** —— 聊天输入框上方那个下拉框的条目表。
 *
 * **只有入口节点有这一格**(见 {@link NODE_OPTIONS_PARAM_KEY} 的文件头):下拉框陪着
 * "用户那句话进图的第一站",子 agent / 决策节点没有这个位置。每行三样 —— 名字是
 * 菜单上显示的字,内容是选中后**插进输入框光标处**的那段(可以在检查器里用「插入变量」
 * 引用上游产出,入口节点没有上游时菜单会给空态提示),解释是**随这次运行进提示词**
 * 的那一句(告诉模型用户选了什么、意味着什么)。
 */
function optionsParam(): NodeParamSpec {
  return {
    key: NODE_OPTIONS_PARAM_KEY,
    kind: "options",
    label: "输入选项",
    help: "配置后,用这张图聊天时输入框上方会出现一个下拉框:选中一项,它的内容插进输入框光标处,解释随这轮运行注入提示词。",
  };
}

/**
 * 主对话入口节点的**固定条件** —— 聊天输入框上方那一排下拉框的条目表。
 *
 * 每行 = 条件名 + 一串候选值(编辑器里一行一个),选中的值随**每次运行最开头**的
 * 提示词注入**一次**、之后不再重复(见 `runner.ts` 的 `startWorkflowRun`),值为
 * 「不限」的条件跳过 —— 这是"一贯的习惯,不要再问"的那套(原话见
 * `main/lib/searchPrefs.ts` 的文件头)。它接过了文献检索写死的那条筛选条:那四个
 * 条件现在是内置检索图主节点上的**预填数据**(见 `builtins.ts`),在这里可以改候选、
 * 加条件、删条件 —— 定义在节点上,界面只是渲染。
 */
function criteriaParam(): NodeParamSpec {
  return {
    key: NODE_CRITERIA_PARAM_KEY,
    kind: "selects",
    label: "固定条件",
    help: "配置后,输入框上方会出现一排下拉框:选中的值随这次运行注入一次,「不限」不注入。",
  };
}

/**
 * 两种内置 agent 节点共用的**用法说明**尾巴 —— 从"每一轮开头代码会告诉你整条流程"
 * 那一段开始。前半段各写各的(主代理讲"你是入口",子 agent 讲"你只是一步")。
 */
const AGENT_USAGE_TAIL =
  "**每个节点都是独立会话**:它只能看到你写的指令和上游的产出,看不到其他步骤,也看不到用户在别处说过的话 —— 因此指令必须**自足**,写成「把上游给出的三篇文献整理成一张对照表」这样,而不是「把上面的结果整理一下」。" +
  "每一轮开头,代码会告知它**整条流程**:有哪几步、它位于哪一格、后面还有谁(只给名字,不给各步各自的指令)。那份说明由代码从图算出,指令里不必重复。" +
  "上游各步的产出会自动接在指令之前(**被指令点名引用的那几步除外** —— 点了名就只提供那一份)。" +
  "要**引用**上游的产物时,用「插入变量」选取:可以取它的**结果文本**(`{{某步.output}}`)、**状态 / 错误 / 标题**(`.status` / `.error` / `.title`)、它的**配置**(`{{某步.params.某参数}}`),以及它声明过的**产出变量**(`{{某步.变量名}}`)。节点可以写 id,也可以写标题,**只能引用这一步上游的节点**;只有在那一步的「产出变量」里声明过的名字才取得出来。" +
  "**技能**填了,这一步就只允许调用那几个;留空则由模型自行判断。" +
  "**MCP 服务器**与**插件**是同一套读法的另两样(填了就只要那几个,留空不限制),它们省的是**上下文**:" +
  "每多挂一个 MCP 服务器就多一整份工具定义,而模型每次调用都要把上下文重发一遍 —— 所以「这一步用不到浏览器就别给它」这类收窄是真省钱,值得在拆流程时顺手做掉。" +
  "库里那两个服务器(`mcode-library`、`mcode-workflow`)始终挂着,不用写、也写不进去。" +
  "**资料**决定这一步能读到主对话挂载的哪几类材料,没挂载就是没有。交付的是清单文件的路径,并按用途分成两组 —— 文献 / 教材 / 笔记是「**当资料查**」(读其内容),模版是「**当格式仿**」(参照其形式,内容写这一步自己的)。每条前面用方括号标明了**它是什么**(类目 + 整库 / 分类 / 单篇),所以指令里既不必解释那个不透明的 id,也不必再说明「照着模版写」—— 那两组的分工代码已经交代过。" +
  "**读流程记录**打开后,这一步读到的是本流程至今每一步的产出,以及用户在每处分支上做过的选择 —— 而不只是它的直接上游。在环上的步骤默认打开。" +
  "**期望产出**分两层:上面一段平实的说明(不强制)+ 下面那张产出变量表(会被检查)。表里声明了几样,这一步跑完代码就查几样 —— 少一样这一步就**失败**,而不是把一段不完整的东西递给下游、换个地方才出错。" +
  "**填了表,这一步的产出就只有那个对象**(除此之外一个字都不写,内容全写在值里面) —— 那段原文不会摊给用户看,卡片渲染的是解出来的变量。**最后一步例外**:它没有下游、没有人来取那些变量,所以那张表既不发给模型也不检查(填了也不起作用,产出按给人看的样子写即可)。";

/**
 * 随应用发布的节点类型。现在六种:
 *
 * - **主代理**(图的入口,新建的工作流自带一个)与 **子 agent**(一个带独立指令的
 *   步骤)—— 都是"一轮对话里的一个步骤",寿命是一个 turn,**各自新开一段会话**。
 *   两者的**参数完全一样**(见 `agentParams`),差别在语义和用法说明上:入口那个负责
 *   拆,其余那些负责做。
 * - **对话节点** —— 同样跑一轮模型,但**跑在主对话里**(见
 *   `@contracts/nodeType` 的 `runner.kind === "conversation"`)。它不是"另一种子
 *   agent",而是"代替用户说一句话":所以它的参数表里只有「指令」,产出直接留在对话里。
 * - **分支** —— 不跑东西的岔路口,选项就是它的出边。**决定权给谁**由 `decider`
 *   参数说了算:默认 `user`(挂起等用户选,它是环上唯一合法的回头点);`model` 时
 *   跑一轮模型自己选(过去的"决策节点"收编成了这种填法 —— 同一张清单,少一种类型)。
 * - **触发器** —— 一条自动化的**起点**(见 `runner.kind === "trigger"`)。它不跑东西、
 *   也不接上游:它声明"什么情况下起一次运行"。图里没有触发器时,这张图只能手动跑。
 * - **命令** —— 在本机跑一条 shell 命令(见 `runner.kind === "command"` 的 `param`
 *   形状):跑什么写在节点参数里,退出码和输出尾部是它的产出。**没有审批** —— 命令是
 *   画图的人写死的配置,不是跑到一半才问的事;第三方那种自带脚本的 `entry` 形状
 *   仍然没实现(调度器会明确拒绝,见 `isNodeRunnable`)。
 *
 * 前三种是原来"对话模式"里那几步的形态;后三种是"自动化"那一摊的入口、岔路口和手。
 */
const BUILTIN_NODE_TYPES: readonly NodeTypeManifest[] = [
  {
    id: MAIN_NODE_TYPE_ID,
    manifestVersion: 1,
    name: "主代理",
    description:
      "用户那句话进到图里的**第一站**:理解要什么、拆成几步、分给下游。一份工作流自带一个,删不掉。",
    icon: "message",
    category: "通用",
    runner: { kind: "prompt" },
    // 与子 agent 同一个默认值,理由见下面那段。主代理通常更需要能读(先看看库里有什么
    // 再决定怎么拆),而写盘该由它在具体某张图上显式声明。
    capability: "read",
    // 只有入口节点带「输入选项」和「固定条件」—— 那两样都长在聊天输入框上方,陪着
    // 图的起点(见 `optionsParam` / `criteriaParam`)。子 agent 与决策节点不传
    // `extra`,参数表保持原样。
    // ⚠️ **getter 惰性求值,不能是顶层求值的属性。** params → agentParams → ioParams →
    // contextOptions → loadLibraryTypes 要读 settings 表(DB):模块 import 期 initDb()
    // 还没 resolve,顶层求值会在启动时炸(getDb() called before initDb() resolved)。
    // getter 把首次读取推迟到 loadNodeTypes() 运行时 —— 那时调用方必已 await 过 Db。
    // 附带的好处:用户自建的类型不再固化在启动快照里,改完注册表下一轮就能勾到。
    get params() {
      return agentParams(MAIN_INSTRUCTION_HELP, [optionsParam(), criteriaParam()]);
    },
    outputs: [{ key: "summary", label: "结果文本", description: "这个步骤的最终输出,会传给下游节点" }],
    usage:
      "**入口节点。** 新建的工作流自带一个,一份图里只有它一个,而且删不掉 —— 用户那句话先到它这儿。它的活是**拆**不是做:把请求分成几步、写清每一步要什么,交给下游的子 agent;要是它自己把整件事做完了,下游就没得干了(这套图最容易踩的坑,所以指令里要写明「把活分给下游」这类话)。它可以接下游(几乎总是有下游,否则这张图就只有它一步,那不如直接跟对话说)。" +
      AGENT_USAGE_TAIL,
  },
  {
    id: NODE_AGENT_TYPE_ID,
    manifestVersion: 1,
    name: "子 agent",
    description: "带独立指令的一个步骤,跑一轮对话。节点之间不共享上下文,上游结果显式传给下游。",
    icon: "message",
    category: "通用",
    runner: { kind: "prompt" },
    // 默认只读。**这是刻意的保守默认**:工作流里多数步骤是查、读、分析,而写盘
    // 是少数需要明确表达的动作。节点上可以覆盖(`WorkflowNode.capability`)——
    // 一个要产出文件的步骤应该显式声明 `write`,而不是继承一个宽松的默认值。
    capability: "read",
    // getter 惰性求值,理由见主代理那段(顶层求值会在 initDb 之前碰 DB)。
    get params() {
      return agentParams(AGENT_INSTRUCTION_HELP);
    },
    outputs: [{ key: "summary", label: "结果文本", description: "这个步骤的最终输出,会传给下游节点" }],
    usage:
      "最通用的节点。一次对话轮次,给它一段指令,它去做。**指令要写窄**(只写这一步,别去干整件事)——" +
      AGENT_USAGE_TAIL,
  },
  {
    id: NODE_CONVERSATION_TYPE_ID,
    manifestVersion: 1,
    name: "对话节点",
    description:
      "**不另开会话**:把指令当成你在主对话里说的一句话发出去,主对话(连同之前聊过的全部内容)回一轮。答案就留在对话里。",
    icon: "message",
    category: "通用",
    runner: { kind: "conversation" },
    // ⚠️ **这一项对它不生效,填 `read` 只是因为清单必须有一个。** 它跑在主对话里,
    // 权限用的是**主对话当前那一套**(见 `@contracts/nodeType` 的 `conversation` 那一段)。
    // 填最保守的值:万一将来有人拿这个字段做了什么,读到的是最不危险的那个。
    capability: "read",
    // getter 惰性求值,理由见主代理那段(数组里的 `...ioParams()` 会在求值时碰 DB)。
    get params(): NodeParamSpec[] {
      return [
      {
        key: NODE_PROMPT_PARAM_KEY,
        kind: "longtext",
        label: "指令",
        required: true,
        help: CONVERSATION_INSTRUCTION_HELP,
      },
      {
        key: NODE_ASK_PARAM_KEY,
        kind: "boolean",
        label: "运行前先问我",
        help: "打开后,跑到这一步会先弹个框问你怎么走:用它的指令 / 跳过 / 重复上一个任务 / 退出流程。",
      },
      {
        key: NODE_INJECT_MODE_KEY,
        kind: "select",
        label: "注入模式",
        options: INJECT_MODES.map((m) => ({
          value: m,
          label: m === "ask" ? "先问一句,等回答" : "自动注入,发完就走",
        })),
        help: "默认等这一轮说完流程再往下走。「自动注入」是替你发一条消息,发完立刻算完成 —— 长任务守望用的就是它。",
      },
      {
        key: NODE_INJECT_TARGET_KEY,
        kind: "select",
        label: "注入到",
        options: INJECT_TARGETS.map((t) => ({
          value: t,
          label: t === "self" ? "本会话(跑这张图的)" : "发起会话(按守望按钮的那条)",
        })),
        help: "默认发进跑这张图的会话。「发起会话」只在用「守望」按钮起跑时有意义;手动跑的自动化没有发起人,这一步会明确失败。",
      },
      // 「进来什么 / 出去什么」那一组和子 agent 完全共用(见 `ioParams`)—— 收到上游产出、
      // 按一张表交东西、声明产出变量给下游取,这几件事跟"在哪儿跑"没有关系。
      //
      // **但「回到主对话」那一个不给它**:它本来就在主对话里,内容和过程天然在那儿。
      ...ioParams(),
      ];
    },
    outputs: [{ key: "summary", label: "结果文本", description: "主对话这一轮说的话,会传给下游节点" }],
    usage:
      "**在主对话里跑的一步。** 它不是子 agent —— 它没有自己的会话,而是**代替你说一句话**:指令原样作为一条用户消息发进当前这个对话,主对话带着全部历史回一轮。所以「这一步靠什么跑」那一组不用配(模型、技能、工具、权限,用的全是主对话当前那一套);**收什么、交什么是配的**,和子 agent 同一套。\n" +
      "  **什么时候用它**:这一步需要用到**之前聊过的东西**。「按刚才定的思路改第三章」「把上面讨论的三条意见落实了」——这类话子 agent 接不住,因为它那段会话里没有你们的聊天记录。\n" +
      "  **什么时候别用它**:这一步是自足的、只需要上游产出就能做完(检索、核对、成稿)。那用子 agent:干净、可以重复跑、一张图分享给别人也照样跑得起来 —— 别人拿到你的图,可没有你那半小时的聊天记录。\n" +
      "  ⚠️ **它的上下文只增不减。** 这一步读过的文件、工具的每一次返回都永久留在这个对话里,后面每一轮都背着它。所以别把长流程里的每一步都设成它。\n" +
      "  ⚠️ **填了产出变量表时,它会在对话里交一段结构化的东西** —— 那段原文不直接给人看,界面上按变量名摊开成一张清单(见 `runner.ts` 的 `runInConversation`)。\n" +
      "  ⚠️ **它在跑的时候这个对话是被占住的**,你插不进话;而且它跑完**不会**让界面显示「这一轮结束了」 —— 那条要等整张图收尾。\n" +
      "  **打开「运行前先问我」之后**,跑到这一步会先弹一个框,四个选项:用这一步的指令(可以补几句话)、跳过这一步、**重复上一个任务**、退出流程。想「跑一步看一眼再决定」就打开它 —— 这是把「拉一个分支节点 + 一根回头的线」那套做法收进了这一步本身。第 4 项(退出)时你在框里写的话,会作为你的**下一条消息**发进这个对话。",
  },
  {
    id: BRANCH_NODE_TYPE_ID,
    manifestVersion: 1,
    name: "分支",
    description:
      "跑到它就在岔路口选一条出路继续,其余几条连同它们的下游一起作废。**选项就是它的出边** —— 从它拉几根线到下一步,每根线写一个选项名。**谁来选**由「决定权」说了算:弹出窗口等你点,或者跑一轮模型按判据自己挑。",
    icon: "split",
    category: "通用",
    runner: { kind: "branch" },
    // 它自己不跑东西(decider=user 时),模型选时跑的那一轮用的是主对话外的一次性派发,
    // 能力这一项两种情况下都没有实际作用。给 `read` 是**最保守的那个值** —— 万一将来
    // 有人给它加参数、或者别的实现拿这个字段做了什么,读到的是最不危险的那个。
    capability: "read",
    // 选项是**边**(见 `@contracts/workflow` 的 `WorkflowEdgeSchema`),不是一张填在
    // 节点上的表 —— 表会有两种真相("填了三个选项、图上只拉了两根线"),而边不会:
    // 每个选项必然通向某一步。节点上只有两样:**决定权给谁**、以及**模型选时的判据**。
    params: [
      {
        key: NODE_DECIDER_KEY,
        kind: "select",
        label: "决定权",
        options: DECIDER_MODES.map((m) => ({
          value: m,
          label: m === "user" ? "弹出窗口,我来选" : "跑一轮模型,它来选",
        })),
        help: "默认等你点。给模型的话它跑一轮自己挑,挑完继续跑 —— 适合「看结果就知道往哪走」的无人值守分流。",
      },
      {
        key: NODE_PROMPT_PARAM_KEY,
        kind: "longtext",
        label: "选路判据",
        help: DECIDER_INSTRUCTION_HELP,
      },
    ],
    usage:
      "**岔路口。** 跑到它就选一条路:选中的那条继续跑,其余的连同它们拖着的**整条支路**一起作废(那些步骤在对话里会标成「没走这条路」,和「上游失败」是两句不同的话)。\n" +
      "  **选项就是它的出边**:从它往下一步拉几根线,每根线就是一个选项。线本身带两样东西 —— `label`(选项名,按钮上显示的字;不填就用目标节点的标题)、`note`(选了这条之后给下一步的一句说明,会拼进那一步的提示词)。\n" +
      "  **「决定权」留默认(我来选)**:运行停在那儿弹一个框,你点哪条走哪条,**还能临时写一句话**拼进下一步。它是环上**唯一合法的回头点**(「再来一轮」的那根回边必须接在它后面)—— 因为环要有人看着才转得动。\n" +
      "  **「决定权」给模型**:它跑一轮 —— 上游产出都在它眼前,判据写在「选路判据」里(留空就只要求它挑最合适的一条)—— 然后从出边里挑一条,**一字不改**地交出「出路」这个变量(下游能 `{{那一步.出路}}` 取到)。交的名字对不上任何一条出边,这一步**失败**,不会随便挑一条。⚠️ 它**不能当环的闸门**:让模型回头,它会一环一环自己转下去,没有人拦得住,只是账单在涨 —— 存盘时就会被拒绝。\n" +
      "  ⚠️ 两条支路**最后可以汇到同一步**(选哪条都会走到「导出」)—— 调度器把没走的那条当**不存在**,所以汇合的那一步照常跑。",
  },
  {
    id: NODE_COMMAND_TYPE_ID,
    manifestVersion: 1,
    name: "命令",
    description:
      "在本机跑一条 shell 命令,跑完才往下走。退出码和输出尾部交给下游 —— 要按成败分流,下游接一个「决定权给模型」的分支看退出码。",
    icon: "terminal",
    category: "自动化",
    runner: { kind: "command" },
    // **这一项是真的生效的**:它真起进程。默认 `exec` —— 命令节点的本职就是动手;
    // 节点上可以覆盖,但一个命令节点改成 `read` 多半是画错了。
    capability: "exec",
    params: [
      {
        key: NODE_COMMAND_PARAM_KEY,
        kind: "text",
        label: "命令",
        required: true,
        help: "要跑的那条命令,在本机 shell 里执行。跑到它就执行,跑完(进程退出)才轮到下一步 —— 结束码是多少都算跑完。",
      },
      {
        key: NODE_COMMAND_TIMEOUT_KEY,
        kind: "number",
        label: "超时(毫秒)",
        help: "跑了这么久还没完就杀掉,这一步按失败算。留空或 0 = 不限时长,等它自己退出。",
      },
      ...outputVarsParam(),
    ],
    outputs: [
      { key: "exitCode", label: "退出码", description: "进程的结束码:0 通常是成功,非 0 通常是出了问题" },
      { key: "stdout", label: "输出尾部", description: "进程打印的最后一段内容(太长只留尾部),出错时先看这里" },
    ],
    usage:
      "**动手的那一步。** 它起一个进程跑你写的那条命令,进程退出这一步才结束 —— 输出按行记着,下游能取到**退出码**和**输出尾部**(太长只留最后几 KB,早前的输出被丢掉,要看全请让命令自己写文件)。\n" +
      "  ⚠️ **非零退出码不算这一步失败。** 命令挂了,这一步照样算跑完(失败的是命令,不是流程 —— 训练脚本退出码 1,你可能正想注入「重试一次」)。要按成败分流:下游接一个**决定权给模型**的分支,判据写「退出码是 0 走成功那条,不是 0 走失败那条」。\n" +
      "  **没有审批**:命令是你画图时写死在这儿的那一条,不是跑到一半才问的事 —— 所以别把不认识的图里的命令节点当成无害的。这一步声明了 `exec` 能力,受工作流权限那一套约束。\n" +
      "  **什么时候用它**:自动化的「手」—— 起训练、跑评测、拉日志、存一次盘。要模型读着结果说话,后面接子 agent;要无人值守地分流,后面接分支(模型选)。",
  },
  {
    id: "mcode.code",
    manifestVersion: 1,
    name: "Code",
    description: "Execute Python, Node.js, Shell or PowerShell code.",
    icon: "code",
    category: "Automation",
    runner: { kind: "code", language: "python" },
    capability: "exec",
    params: [
      { key: NODE_CODE_LANGUAGE_KEY, kind: "select", label: "Language", default: "python", help: "Runtime used to run the code.", options: [{ value: "python", label: "Python" }, { value: "node", label: "Node.js" }, { value: "shell", label: "Shell" }, { value: "powershell", label: "PowerShell" }] },
      { key: NODE_CODE_PARAM_KEY, kind: "longtext", label: "Code", required: true, help: "Program source. Input JSON arrives on stdin." },
      { key: NODE_CODE_INPUT_KEY, kind: "longtext", label: "Input JSON", help: "Optional. Use {{upstream.output}} style templates." },
      { key: NODE_CODE_TIMEOUT_KEY, kind: "number", label: "Timeout (ms)", help: "0 = unlimited." },
      ...outputVarsParam(),
    ],
    outputs: [{ key: "exitCode", label: "Exit code" }, { key: "stdout", label: "Stdout" }, { key: "stderr", label: "Stderr" }],
    usage:
      "General-purpose code execution. Read JSON from stdin; emit @@mcode:result {summary,outputs,artifacts} and @@mcode:progress {percent,message} on stdout. artifacts uses {kind,uri,name?,mimeType?,sizeBytes?} references; bytes stay external.",
  },
  {
    id: TRIGGER_NODE_TYPE_ID,
    manifestVersion: 1,
    name: "触发器",
    description:
      "一条自动化的**起点**:到点了、文件变了、某件事发生了,就按你写的那句话起一次运行。**它没有入边** —— 它是图的开头。",
    icon: "zap",
    category: "自动化",
    runner: { kind: "trigger" },
    // 它自己不跑任何东西(和「分支」一样),所以这一项没有实际作用。给 `read` 是**最保守
    // 的那个值** —— 顺带也让它卡片上不显示能力标签(见 `WorkflowNodeCard` 的
    // `showsCapability`)。
    capability: "read",
    params: [
      {
        key: NODE_TRIGGER_KIND_PARAM_KEY,
        kind: "select",
        label: "触发方式",
        required: true,
        options: [
          { value: "manual", label: "手动运行" },
          { value: "schedule", label: "定时" },
          { value: "file", label: "文件变化" },
          { value: "event", label: "事件发生时" },
        ],
        help: "「手动运行」= 只在列表里点「立刻跑一次」;另外三种是应用开着时自动起。",
      },
      {
        key: NODE_TRIGGER_PROJECT_PARAM_KEY,
        kind: "ref",
        from: "projects",
        label: "在哪个项目里跑",
        required: true,
        // 单值。见 `@contracts/nodeType` 的 `NODE_PARAM_REF_SOURCES` 里 `projects` 那一段:
        // 一次运行只有一个工作目录。
        help: "这次运行的工作目录,以及它的会话挂在哪。触发时问不了你,所以它必须写死在这儿。",
      },
      {
        key: NODE_TRIGGER_TASK_PARAM_KEY,
        kind: "longtext",
        label: "这次要做什么",
        required: true,
        help: "触发时,这句话就是这次运行的**用户请求**(入口节点读到的那一句)。写成一句完整的话。",
      },
      {
        key: NODE_TRIGGER_CRON_PARAM_KEY,
        kind: "text",
        label: "定时表达式",
        help: "只在「定时」时看。5 段:分钟 小时 日 月 星期,如 `0 9 * * 1-5` = 工作日九点。应用没开着不补跑。",
      },
      {
        key: NODE_TRIGGER_PATHS_PARAM_KEY,
        kind: "text",
        label: "监听哪些文件",
        help: "只在「文件变化」时看。逗号分隔,相对项目目录,支持 `*`(如 `*.md, src/**/*.ts`)。",
      },
      {
        key: NODE_TRIGGER_EVENTS_PARAM_KEY,
        kind: "text",
        label: "听哪些事件",
        help: "只在「事件发生时」看。逗号分隔,取值和**钩子**那张表一样(如 `tool.use, turn.done`)。",
      },
      {
        key: NODE_TRIGGER_FILTER_PARAM_KEY,
        kind: "text",
        label: "再筛一层",
        help: "工具名或文件路径,逗号分隔,支持 `*`。只在听的事件带这两样时有用。",
      },
      {
        key: NODE_TRIGGER_DEBOUNCE_PARAM_KEY,
        kind: "number",
        label: "合并窗口(毫秒)",
        default: DEFAULT_TRIGGER_DEBOUNCE_MS,
        help: "这么短的间隔里连着来好几次(存一次盘改了几个文件),合成一次运行。0 = 每次都跑。",
      },
    ],
    usage:
      "**自动化的起点。** 它声明「什么情况下起一次运行」,自己不跑任何东西 —— 触发之后,真正跑的是它下游那几步,而这次运行的**用户请求**就是你写在「这次要做什么」里的那句话(流程的入口节点读到的是它,和别人手打一句话没有区别)。\n" +
      "  ⚠️ **它没有入边**,而且图里**可以有好几个**:每一份图最多有一条自动化记录(会话),几个触发器都指向同一段流程 —— 谁先命中谁起一次运行。\n" +
      "  ⚠️ **没被触发的那些会标成「没走这条路」而不是失败。** 一次运行只有一个起点,其余的自然是没走的那条。所以你的图里没必要为「哪个触发的」写判断逻辑。\n" +
      "  ⚠️ **桌面应用没开着就不会触发**,而且**错过的时间点不会补跑**(早上八点那条,你十点才打开应用,它不会补一次)。所以别拿它当定时任务的唯一保障。\n" +
      "  触发方式和参数是**配对**的:「定时」只看表达式、「文件变化」只看监听哪些文件、「事件发生时」看事件名和筛选 —— 填了不在用的那几个不报错,但也不会生效,所以换触发方式时记得把上一组擦干净。\n" +
      "  **「手动运行」不等于没有自动化**:它不自动起,但列表上那一个「立刻跑一次」按钮走的是同一条路(同样的项目、同样那句话),所以你可以拿它先试一遍再改成定时。",
  },
];

/* ── 目录 ── */

/** 用户自写的节点类型目录。见文件头「目录名在这里复述了一遍」。 */
export function localNodeTypesDir(): string {
  return path.join(dataRoot(), "workflows", "node-types");
}

/* ── 加载 ── */

/** 一份加载结果。形状定义在 contracts(`NodeTypeCatalog`)—— 它是
 *  `workflow.nodeTypes` 的返回类型,渲染端要用同一个,不能在这边另立一份。 */

/**
 * 把内置的那几份清单过一遍校验器,合成一个加载结果。
 *
 * 出问题的内置类型**不进清单**(和一个坏了的插件清单一样),但会作为 `problems` 冒到
 * 界面上 —— 安静地少一种节点类型,是这个问题最难查的表现形式。
 */
function loadBuiltin(manifests: readonly NodeTypeManifest[]): NodeTypeCatalog {
  const out: NodeTypeCatalog = { entries: [], problems: [] };
  for (const raw of manifests) {
    const check = validateNodeTypeManifest(raw);
    if (!check.ok) {
      out.problems.push({ file: `内置类型 ${raw.id}`, error: check.error });
      continue;
    }
    out.entries.push({ id: check.manifest.id, source: "builtin", from: "mcode", manifest: check.manifest });
  }
  return out;
}

/** 读一个 `.json` 清单文件。读不成 / 格式不对都返回错误字符串,不抛。 */
function readManifestFile(file: string): { manifest: NodeTypeManifest } | { error: string } {
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch (err) {
    return { error: `读不了:${(err as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { error: `不是合法的 JSON:${(err as Error).message}` };
  }
  const check = validateNodeTypeManifest(parsed);
  return check.ok ? { manifest: check.manifest } : { error: check.error };
}

/**
 * 扫一个目录下的 `*.json`。
 *
 * 只认 `.json` —— 不支持 `.ts`/`.js` 之类的可执行清单。理由:这个目录里的内容是
 * **用户可写、可从外部下载**的,让它可以被 import 就等于让一个数据文件变成任意代码
 * 执行。脚本要走 `runner.entry` 那条明路,那里至少有能力的声明与审批。
 */
function loadDir(dir: string, source: NodeTypeSource, from: string): NodeTypeCatalog {
  const out: NodeTypeCatalog = { entries: [], problems: [] };
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    // 目录不存在是**正常情况**(没人写过自定义节点),不是问题。
    return out;
  }
  for (const name of names.filter((n) => n.toLowerCase().endsWith(".json")).sort()) {
    const file = path.join(dir, name);
    const result = readManifestFile(file);
    if ("error" in result) {
      out.problems.push({ file, error: result.error });
      continue;
    }
    // `mcode.` 是内置的命名空间。**这一条不能放进 `validateNodeTypeManifest`** ——
    // 内置类型自己就叫 `mcode.agent`,放进去它自己第一个过不了。校验器只认形状,
    // "谁有资格用这个前缀"是**来源**的问题,只有这里知道。
    if (source !== "builtin" && result.manifest.id.startsWith(RESERVED_NODE_TYPE_PREFIX)) {
      out.problems.push({
        file,
        error: `\`${RESERVED_NODE_TYPE_PREFIX}\` 是内置类型的保留前缀,第三方不能用`,
      });
      continue;
    }
    out.entries.push({ id: result.manifest.id, source, from, manifest: result.manifest });
  }
  return out;
}

/* ── 注册表 ── */

/**
 * 当前可用的全部节点类型,以及读不进来的那些。
 *
 * 按来源优先级合并(高覆盖低)。**同名覆盖是正常的、不报错** —— 用户用自己的实现顶掉
 * 一个插件或内置的类型,是这个机制本来就该支持的事。
 */
export async function loadNodeTypes(): Promise<NodeTypeCatalog> {
  const byId = new Map<string, NodeTypeEntry>();
  const problems: NodeTypeCatalog["problems"] = [];

  const take = (catalog: NodeTypeCatalog): void => {
    for (const entry of catalog.entries) {
      const prev = byId.get(entry.id);
      if (!prev || NODE_TYPE_SOURCE_RANK[entry.source] >= NODE_TYPE_SOURCE_RANK[prev.source]) {
        byId.set(entry.id, entry);
      }
    }
    problems.push(...catalog.problems);
  };

  // 从低到高:内置 → 插件 → 本地。顺序即优先级,后面的盖前面的。
  //
  // 内置这一份**也过校验器**,尽管它是代码、TS 已经挡掉了大部分形状错误。TS 挡不住的
  // 正是"形状对但不成立"的那几条(下拉没有选项、参数键重复、`multiple` 写在文本参数
  // 上),而它们全都是让节点跑不起来、或者让表单长歪的错误 —— 一个随应用发布出去、
  // 自己却加载不了的内置类型,是这套机制里最难查的一种坏法。
  take(
    loadBuiltin(BUILTIN_NODE_TYPES),
  );

  for (const source of await getEnabledPluginNodeTypeSources()) {
    // 内置插件带的东西按 `builtin` 记 —— 它随应用发版,和代码里那份是一个性质,
    // 不该被另一个第三方插件顶掉(用户自己的 `local` 仍然盖得过它)。
    take(loadDir(source.rootDir, source.builtin ? "builtin" : "plugin", source.name));
  }

  const localDir = localNodeTypesDir();
  take(loadDir(localDir, "local", "workflows/node-types"));

  return { entries: [...byId.values()], problems };
}

/** 取一个节点类型。找不到返回 undefined —— **调用方必须处理这种情况**:一份别处
 *  分享来的工作流,在这台机器上可能引用了没装的类型。 */
export async function getNodeType(id: string): Promise<NodeTypeEntry | undefined> {
  return (await loadNodeTypes()).entries.find((e) => e.id === id);
}
