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
  MAIN_NODE_TYPE_ID,
  NODE_ASK_PARAM_KEY,
  NODE_CONTEXT_KINDS,
  NODE_CONTEXT_PARAM_KEY,
  NODE_FLOW_RECORD_PARAM_KEY,
  NODE_MCP_PARAM_KEY,
  NODE_PLUGINS_PARAM_KEY,
  NODE_PROMPT_PARAM_KEY,
  NODE_PROVIDER_PARAM_KEY,
  NODE_RETURN_PARAM_KEY,
  NODE_SKILLS_PARAM_KEY,
  NODE_TYPE_SOURCE_RANK,
  RESERVED_NODE_TYPE_PREFIX,
  validateNodeTypeManifest,
  type NodeContextKind,
  type NodeParamSpec,
  type NodeTypeCatalog,
  type NodeTypeEntry,
  type NodeTypeManifest,
  type NodeTypeSource,
} from "@contracts/nodeType";
import { dataRoot } from "@main/lib/dataRoot.js";
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
 * 上下文类目的中文名。**放在这里而不是 i18n** —— 它是**清单的一部分**(和参数的
 * `label` 一样由清单作者写),不是界面文案:一份第三方清单里同样会带中文名,而界面上
 * 显示的是清单写的那一份。
 */
const CONTEXT_LABEL_ZH: Record<NodeContextKind, string> = {
  paper: "文献",
  textbook: "教材",
  note: "笔记",
  ppt: "PPT 模版",
  latex: "LaTeX 模版",
  word: "Word 模版",
  code: "代码模版",
  image: "配图模版",
};

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
      options: NODE_CONTEXT_KINDS.map((kind) => ({ value: kind, label: CONTEXT_LABEL_ZH[kind] })),
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
function agentParams(instructionHelp: string): NodeParamSpec[] {
  return [
    {
      key: "instruction",
      kind: "longtext",
      label: "指令",
      required: true,
      help: instructionHelp,
    },
    ...capabilityParams(),
    ...ioParams(),
    ...returnToChatParam(),
  ];
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
 * 随应用发布的节点类型。现在四种:
 *
 * - **主代理**(图的入口,新建的工作流自带一个)与 **子 agent**(一个带独立指令的
 *   步骤)—— 都是"一轮对话里的一个步骤",寿命是一个 turn,**各自新开一段会话**。
 *   两者的**参数完全一样**(见 `agentParams`),差别在语义和用法说明上:入口那个负责
 *   拆,其余那些负责做。
 * - **对话节点** —— 同样跑一轮模型,但**跑在主对话里**(见
 *   `@contracts/nodeType` 的 `runner.kind === "conversation"`)。它不是"另一种子
 *   agent",而是"代替用户说一句话":所以它的参数表里只有「指令」,产出直接留在对话里。
 * - **分支** —— 不跑模型,只把决定权交给用户(见 `@contracts/nodeType` 的
 *   `runner.kind` 那个 `branch` 变体)。它是这四种里唯一**寿命不止一个 turn** 的:
 *   它让这次运行停在那儿等人,等到为止。
 *
 * 前三种是原来"对话模式"里那几步的形态。
 *
 * ⚠️ **这里没有 `command`(跑本地脚本)类型,不是忘了。** 执行方式在
 * `@contracts/nodeType` 里已经定义好了形状(`runner: { kind: "command" }`),但
 * 真正跑起一个第三方脚本需要一整套还不存在的东西:统一的进程执行抽象(仓库里现在
 * 是 22 处各写各的 `spawn`)、`exec` 能力的实施、长跑进程的存活与重连。那是"自动化"
 * 那个功能自己的一摊,不属于这里。
 *
 * 所以现在只发这四种内置类型;**第三方带来的 `command` 节点能画、能存,但跑之前会被
 * 明确拒绝**(`isRunnerImplemented`),而不是假装跑过。
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
    params: agentParams(MAIN_INSTRUCTION_HELP),
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
    params: agentParams(AGENT_INSTRUCTION_HELP),
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
    params: [
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
      // 「进来什么 / 出去什么」那一组和子 agent 完全共用(见 `ioParams`)—— 收到上游产出、
      // 按一张表交东西、声明产出变量给下游取,这几件事跟"在哪儿跑"没有关系。
      //
      // **但「回到主对话」那一个不给它**:它本来就在主对话里,内容和过程天然在那儿。
      ...ioParams(),
    ],
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
      "跑到它就把决定权交给你:选一条出路继续,其余几条连同它们的下游一起作废。**选项就是它的出边** —— 从它拉几根线到下一步,每根线写一个选项名。",
    icon: "split",
    category: "通用",
    runner: { kind: "branch" },
    // 它什么都不跑,所以能力这一项没有实际作用。给 `read` 是**最保守的那个值** ——
    // 万一将来有人给它加参数、或者别的实现拿这个字段做了什么,读到的是最不危险的那个。
    capability: "read",
    // **没有参数。** 选项是**边**(见 `@contracts/workflow` 的 `WorkflowEdgeSchema`),
    // 不是一张填在节点上的表 —— 表会有两种真相("填了三个选项、图上只拉了两根线"),
    // 而边不会:每个选项必然通向某一步。
    params: [],
    usage:
      "**岔路口。** 跑到它就停下来问用户走哪条路,选中的那条继续跑,其余的连同它们拖着的**整条支路**一起作废(那些步骤在对话里会标成「没走这条路」,和「上游失败」是两句不同的话)。\n" +
      "  **选项就是它的出边**:从它往下一步拉几根线,每根线就是一个选项。线本身带两样东西 —— `label`(选项名,按钮上显示的字;不填就用目标节点的标题)、`note`(选了这条之后给下一步的一句说明,会拼进那一步的提示词)。\n" +
      "  拿它做什么:一轮一轮的迭代(「再来一轮」还是「定稿,进查重」)、几条做法里挑一条、让人在关键处拍板。**用户还能在选择时临时写一句话**,那句话也会拼进下一步。\n" +
      "  ⚠️ 两条支路**最后可以汇到同一步**(用户选哪条都会走到「导出」)—— 调度器把没走的那条当**不存在**,所以汇合的那一步照常跑。",
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
