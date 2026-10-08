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
  CONDITION_NODE_TYPE_ID,
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
  NODE_CONDITION_EXPRESSION_KEY,
  NODE_CONTEXT_PARAM_KEY,
  NODE_CRITERIA_PARAM_KEY,
  NODE_DECIDER_KEY,
  NODE_FLOW_RECORD_HELP,
  NODE_FLOW_RECORD_PARAM_KEY,
  NODE_INJECT_MODE_KEY,
  NODE_INJECT_TARGET_KEY,
  NODE_MCP_PARAM_KEY,
  NODE_MODEL_PARAM_KEY,
  NODE_OUTPUT_VARS_HELP,
  NODE_PLUGINS_PARAM_KEY,
  NODE_PROMPT_PARAM_KEY,
  NODE_PROVIDER_PARAM_KEY,
  NODE_RETURN_PARAM_KEY,
  NODE_SKILLS_PARAM_KEY,
  NODE_TRIGGER_CRON_PARAM_KEY,
  NODE_TRIGGER_DEBOUNCE_PARAM_KEY,
  NODE_TRIGGER_ENABLED_PARAM_KEY,
  NODE_TRIGGER_EXCLUDE_PATHS_PARAM_KEY,
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
import { MODULE_CAPABILITY_NODE_TYPE_ID, MODULE_CAPABILITY_RUNNER_KIND } from "@contracts/moduleCapability";
import { dataRoot } from "@main/lib/dataRoot.js";
import { MEMORY_PARAM_KEY } from "@contracts/memory";
import { DEFAULT_LIBRARY_GROUPS } from "@contracts/libraryTypes";
import { loadLibraryGroups } from "@main/library/groupRegistry.js";
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
 * 「资料」下拉的候选 —— **资料库大类的现读**。
 *
 * `docs` / `templates` / 用户自建的大类:开放的、运行时的,读 `loadLibraryGroups`
 * (kind 退役前这里是 `loadLibraryTypes`;独立模版库退役(2026-09-27)前这里还拼着
 * 模版库那五个封闭类目 —— 模版并进统一资料库之后它们就是「模版」大类下的分类,
 * 不再单列)。
 *
 * 名字显示的是**库里的 name**(大类即用户起的名) —— 它是清单的一部分,由库的作者
 * (内置=我们,自定义=用户)写,不走 i18n,和清单里其他 label 同一规则。按 value 去重。
 *
 * ⚠️ **一个候选都没有时退回出厂两组。** 大类表可以被用户清空(`LibrarySection`
 * 的删除只做 `filter`,`parseLibraryGroupsJson` 也认空数组),而这是个 `kind: "select"`
 * 参数 —— `validateNodeTypeManifest` 对"下拉没有选项"是**硬拒绝**,于是整个内置清单
 * 会被丢掉,`loadBuiltin` 把 mcode.main / mcode.agent / mcode.conversation **一起从
 * 注册表里摘出去**(文件头那条"随应用发出去、自己却加载不了的内置类型"正是它)。
 * 退回出厂两组与 `loadLibraryGroups` 自己的兜底同一条规矩:表读不到 = "用户从没动过
 * 大类",而那两种情形本就该给出同一个答案。空表下选中的项本来就是不存在的分类
 * (`inheritContextLines` 按真实库过滤),让下拉至少长得出来,比丢掉三个内置类型强。
 */
function contextOptions(): Array<{ value: string; label: string }> {
  const out: Array<{ value: string; label: string }> = [];
  const seen = new Set<string>();
  const push = (value: string, label: string): void => {
    if (value.length === 0 || seen.has(value)) return;
    seen.add(value);
    out.push({ value, label });
  };
  for (const g of loadLibraryGroups()) push(g.id, g.name);
  if (out.length === 0) for (const g of DEFAULT_LIBRARY_GROUPS) push(g.id, g.name);
  return out;
}

/**
 * 「指令」那段说明 —— **子 agent** 版。
 *
 * ⚠️ **一两句就够。** 这段字是印在控件下面的一行小字,不是文档 —— 长过三行就没人读了,
 * 而它要传达的其实只有两件事:写窄、写完成判据。理由与展开写在
 * `node-types-README.md` 里(那是给要读的人读的地方),模型那一侧由 `usage` 兜着。
 */
const AGENT_INSTRUCTION_HELP =
  "本步骤要完成的事。只描述本步骤;末尾写明「做完的样子」—— 缺了它,模型倾向于在中途停止。";

/**
 * 「指令」那段说明 —— **主代理**版。
 *
 * 它是 `conversation` 跑法(见 {@link MAIN_NODE_TYPE_ID} 那一项),所以这段字说的是
 * 一句**用户会说的话**:同一个对话里已经有全部聊天记录,不必重复交代背景。
 *
 * 而"拆活、别自己做完"那条仍然要写 —— 它一动手,下游就没得干了,这是这套图最容易
 * 踩的坑。
 */
const MAIN_INSTRUCTION_HELP =
  "收到用户那句话后你首先说的一句。职责是**拆解与分配** —— 把工作派给下游节点,不要自己做完(做完下游就无事可做)。";

/**
 * 「指令」那段说明 —— **对话节点**版。
 *
 * 三段说明是同一件事的三个面:子 agent 怕它**做多**(它只看得到这一步),主代理怕它
 * **做少**(它离用户最近,容易把活全干完),而对话节点写的是**一句用户会说的话** ——
 * 它就是要被当成用户说的那一句发出去的。
 */
const CONVERSATION_INSTRUCTION_HELP =
  "本步骤要说的那句话,它会作为一条用户消息发进主对话。主对话已经掌握的内容不必重复。";

/**
 * 「指令」那段说明 —— **分支(模型选)**版。
 *
 * 留空也行:留空时代码用 {@link DEFAULT_DECIDER_INSTRUCTION} 兜底(照着上游结果从选项
 * 里挑一条)。这里写的是**判据** —— "按什么挑",不是"做什么"。
 */
const DECIDER_INSTRUCTION_HELP =
  "选路的判据:依据上游的哪些内容、按什么标准取舍。留空则只要求模型从选项中选择最合适的一条。";

/**
 * 「这一步靠什么跑」那一组 —— 技能 / MCP / 插件 / 引擎 / 模型。
 *
 * **只有隔离跑法的节点有这一组**(子 agent,以及将来别的 `prompt` 类型)。它们全都是
 * "给这一步单独配一套环境"的意思,而**跑在主对话里的节点**(`mcode.main` 与
 * `mcode.conversation`)用的就是主对话那一套,配了也不算数 —— 它们的那份参数表见
 * `mainParams` / 对话节点自己的清单,两处都刻意不收这一组。
 *
 * ## 「引擎」必须排在「模型」前面
 *
 * 这两格是**级联**的:模型那一格的候选跟着引擎走(见 `NodeParamSpecSchema` 的
 * `fromParam`),而候选是照**已经渲染过的**参数算的 —— 顺序反了就会永远读到"还没选",
 * 列出来的还是全部模型。从前它们就是分开的两个平铺下拉,看着互为副本(用户的说法是
 * 「模型和引擎重合了」)。
 */
function capabilityParams(): NodeParamSpec[] {
  return [
    {
      key: NODE_PROVIDER_PARAM_KEY,
      kind: "ref",
      from: "providers",
      label: "引擎",
      help: "本步骤交由哪个引擎执行。留空则与当前对话一致。下方模型、技能和 MCP 候选按此处的选择收窄。",
    },
    {
      key: NODE_MODEL_PARAM_KEY,
      kind: "ref",
      from: "models",
      fromParam: NODE_PROVIDER_PARAM_KEY,
      label: "模型",
      help: "在「引擎」选定的模型范围内指定一个。留空则由该引擎自行决定。",
    },
    {
      key: NODE_SKILLS_PARAM_KEY,
      kind: "ref",
      from: "skills",
      fromParam: NODE_PROVIDER_PARAM_KEY,
      // 多选:一步用几个技能是正常的(先检索再精读)。
      multiple: true,
      label: "技能",
      help: "限定本步骤可调用的技能。留空即不限制,由模型自行判断。",
    },
    {
      key: NODE_MCP_PARAM_KEY,
      kind: "ref",
      from: "mcp",
      fromParam: NODE_PROVIDER_PARAM_KEY,
      multiple: true,
      label: "MCP 服务器",
      help: "限定本步骤可用的 MCP 服务器。留空即不限制。每增加一个,其全部工具定义都会进入上下文并被反复重发。",
    },
    {
      key: NODE_PLUGINS_PARAM_KEY,
      kind: "ref",
      from: "plugins",
      fromParam: NODE_PROVIDER_PARAM_KEY,
      multiple: true,
      label: "插件",
      help: "限定本步骤加载的插件。留空即加载全部已启用的插件。",
    },
  ];
}

/**
 * 「这一步收到什么 / 交出什么」那一组 —— 资料 / 读流程记录 / 期望产出 / 产出变量 /
 * 回到主对话。
 *
 * **这一组两种节点都有**(隔离的子 agent 与跑在主对话里的对话节点)。它们说的是同一件
 * 事的两端:**进来什么**(资料、流程记录)和**出去什么**(产出、以及跑完并回主对话多少),
 * 而这两件事跟"在哪儿跑"没关系 —— 主代理与对话节点同样会收到上游产出、同样可以按一张
 * 表交东西。
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
      help: "限定本步骤可读取的资料类别,可多选。可选项来自当前对话已挂载的类别;未挂载即无此项。",
    },
    {
      key: NODE_FLOW_RECORD_PARAM_KEY,
      kind: "boolean",
      label: "读流程记录",
      help: NODE_FLOW_RECORD_HELP,
    },
    {
      key: NODE_OUTPUT_CONTRACT_KEY,
      kind: "longtext",
      label: "期望产出",
      help: "描述本步骤应交出的内容及其形式。此段为说明性文字,不作强制校验;实际校验以下方的产出变量表为准。",
    },
    {
      key: NODE_OUTPUT_VARS_KEY,
      kind: "variables",
      label: "产出变量",
      help: NODE_OUTPUT_VARS_HELP,
    },
  ];
}

/**
 * 「注入记忆」—— 把记忆库的一份快照拼在提示词末尾(见 `nodeInputBuilders` 的
 * `memorySectionOf`,MEM-02)。
 *
 * ## 为什么现在才摆出来
 *
 * 读取那一端 2026-09 就写好了(`MEMORY_PARAM_KEY`),但**参数表里从来没有这一格** ——
 * 界面上没有控件,`params` 里也就永远不会有这个键,`memoryEnabled` 恒为 false。
 * 一整条记忆注入**等于不存在**,而且不报错:它只是安静地什么都不做。
 *
 * ## 给谁
 *
 * 给**会走模型那一轮**的三种:子 agent、主代理、对话节点 —— 它们共用
 * `memorySectionOf` 拼出来的那一段(挂在 `buildNodeInput` 的公共返回上)。
 *
 * **不给 `code` / `command`**:那两种节点不走模型,整段 `prompt` 拼好了也没人读,
 * 摆上去就是一个填了不生效的控件 —— 那正是这一格当初被漏掉时犯的同一个错,只是
 * 方向反过来。
 *
 * **不给分支**:它的模型那一轮只做一件事(照判据从几条出路里挑一条),把整本记忆
 * 塞进一个选路问题里既没用、又白白多花一份上下文。
 *
 * ## 一旦打开,每一轮都重发
 *
 * 快照是**按现状取的**(不是建会话时定死),所以你在记忆面板里改一条,下一次跑就
 * 是新的。代价与 MCP 那一格同源:整份快照每一轮都随上下文重发一遍(上限见
 * `memorySnapshotFor` 的 `SNAPSHOT_CAP`)。
 */
function memoryParam(): NodeParamSpec[] {
  return [
    {
      key: MEMORY_PARAM_KEY,
      kind: "boolean",
      label: "本步骤自动附带项目＋全局记忆",
      help: "每次执行按本步骤指令和当前请求检索当前项目＋显式全局记忆，受条数和正文预算限制；不复制主对话历史。关闭只停止自动附带，不禁止按需检索，也不擦除已发送的历史。",
    },
  ];
}

/**
 * 「跑完并回主对话多少」—— **只有隔离跑法的节点有这一个**(子 agent)。
 *
 * 跑在主对话里的那两种不需要它:它们本来就在主对话里说那一句,内容和过程天然就在
 * 那儿了。给它们一个「不并回」的开关只会让人以为能"说完不留痕",而那是做不到的。
 * (主代理那一份表见 `mainParams`,理由同 `capabilityParams`。)
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
      help: "本步骤跑完之后并入主对话的内容量。并回的内容下一轮才生效(那个助手那时才看得到)。",
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
      // 文案与 `ioParams()` 那一格**共用同一个常量**:同一件事在两处各写一遍,迟早会
      // 漂成两句不一样的话,而用户读到的就是两个不同的说法。
      help: NODE_OUTPUT_VARS_HELP,
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
    ...memoryParam(),
    ...returnToChatParam(),
  ];
}

/**
 * **主代理**(`mcode.main`)的参数表 —— 它跑在主对话里(`runner.kind ===
 * "conversation"`),所以这一份是「对话节点那一套 + 入口独有的两格」。
 *
 * 为什么不是 `agentParams(...)`:那一份里有三样东西对跑在主对话里的节点**不生效** ——
 * 技能 / MCP / 插件 / 模型 / 引擎(它用的就是主对话当前那一套,配了也不算数),以及
 * 「回到主对话」(它本来就在主对话里说那一句,内容和过程天然在那儿)。
 *
 * 那些控件**不是被"永久取消"了**:`agentParams` 仍然是它们的家,子 agent 在用。等
 * 「主代理是主对话、子节点跑在图里」这套跑顺了、要把那一组收回给入口节点时,把
 * `...capabilityParams()` / `...returnToChatParam()` 加回下面这一份即可 ——
 * `buildNodeInput` 里那些 `nameListOf(params…)` 读法一个字都不用改。
 * (那也正是这份表当初从 `agentParams` 里拆出来的原因:拆分是机械的,合回去也是。)
 *
 * 剩下的那一格「固定条件」是入口**独有**的 —— 它长在聊天输入框上方,陪着图的起点
 * (见 `criteriaParam`),子 agent 没有这个位置。
 *
 * ⚠️ **「输入选项」(kind: "options")已删**(2026-09-19)。它和「固定条件」本是同一
 * 个位置上的两套东西,而固定条件就是它多一个解释字段的版本 —— 两个并排只会让用户
 * 理解成两种能力。整套机制(参数种类、聊天侧下拉、注入、设置键)一并移除;老存档里
 * 存着的 options 参数条目随"参数里没有声明的键"一起被忽略,不挡存盘。
 */
function mainParams(): NodeParamSpec[] {
  return [
    {
      key: NODE_PROMPT_PARAM_KEY,
      kind: "longtext",
      label: "指令",
      required: true,
      help: MAIN_INSTRUCTION_HELP,
    },
    criteriaParam(),
    ...ioParams(),
    ...memoryParam(),
  ];
}

/**
 * 主对话入口节点的**固定条件** —— 聊天输入框上方那一排下拉框的条目表。
 *
 * 每行 = 条件名 + 一串候选值(编辑器里一行一个)+ 一句可选的解释,选中的值随**那次
 * 对话第一轮**的提示词注入**一次**、之后它已经在上下文里不再重复(见 `runner.ts` 的
 * `startWorkflowRun`),值为「不限」的条件跳过 —— 这是"一贯的习惯,不要再问"的那套
 * (原话见 `main/lib/searchPrefs.ts` 的文件头)。任何工作流的主节点都可以在这里声明
 * 自己的条件:改候选、加条件、删条件 —— 定义在节点上,界面只是渲染。
 */
function criteriaParam(): NodeParamSpec {
  return {
    key: NODE_CRITERIA_PARAM_KEY,
    kind: "selects",
    label: "固定条件",
    help: "配置后,输入框上方出现一排下拉框:选中值随对话第一轮注入一次,「不限」不注入。",
  };
}

/**
 * 两种内置 agent 节点共用的**用法说明**尾巴 —— 从"每一轮开头代码会告诉你整条流程"
 * 那一段开始。前半段各写各的(主代理讲"你是入口",子 agent 讲"你只是一步")。
 *
 * ⚠️ **第一句必须两种跑法都成立。** 这条尾巴同时接在 `mcode.main`(跑在主对话里,
 * 看得见全部聊天记录)和 `mcode.agent`(**另开一段独立会话**,什么都看不见)后面 ——
 * 所以它说的是"**另开一段会话的那种**"看不见别的步骤,而不是"每个节点"。
 * 写成后者,主代理的说明就跟它自己那段"你跑在主对话里"自相矛盾。
 */
const AGENT_USAGE_TAIL =
  "**另开一段会话的那种节点(子 agent)是隔离的**:它只能看到你写的指令和上游的产出,看不到其他步骤,也看不到用户在别处说过的话 —— 因此指令必须**自足**,写成「把上游给出的三篇文献整理成一张对照表」这样,而不是「把上面的结果整理一下」;而跑在主对话里的节点(入口、对话节点)看得见全部聊天,可以写「按刚才定的思路改」。" +
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
 * - **主代理**(图的入口,新建的工作流自带一个)与 **对话节点** —— 都**跑在主对话
 *   里**(`runner.kind === "conversation"`):把指令当成一条用户消息发进当前对话,主对话
 *   带着全部历史回一轮,产出直接留在那儿。主代理是那张图的入口(它的指令写"收到之后
 *   怎么拆"),对话节点是流程中段"需要用到之前聊过的东西"的那一步。
 * - **子 agent** —— 一轮对话里的一个步骤,寿命是一个 turn,**新开一段会话**:隔离、
 *   可重复跑、图能分享给别人。参数比上面两种多一组「这一步靠什么跑」(技能 / MCP /
 *   插件 / 模型 / 引擎)和「回到主对话」。
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
 * 前三种是原来"对话模式"里那几步的形态 —— 其中**主代理与对话节点跑在主对话里**,
 * 只有子 agent 另开会话;后三种是"自动化"那一摊的入口、岔路口和手。
 */
/**
 * 内置的"触发器"节点类型(见下方 `BUILTIN_NODE_TYPES` 里那一项)。
 *
 * 导出**只为一件事**:冒烟要能断言它参数表的顺序 —— 「启用」必须排在「触发方式」前面。
 * 理由见那一项的注释。
 */
export function builtinTriggerManifest(): NodeTypeManifest {
  const found = BUILTIN_NODE_TYPES.find((m) => m.id === TRIGGER_NODE_TYPE_ID);
  if (found === undefined) throw new Error("内置节点清单里没有触发器 —— 上面那张表被改坏了");
  return found;
}

/**
 * 内置的"命令"节点类型(见下方 `BUILTIN_NODE_TYPES` 里那一项)。
 *
 * 导出**只为一件事**:冒烟要能对着**真的那一份**断言两件事 —— 它的 `usage` 里不再
 * 留着"受工作流权限约束"那句已经在实现里落空的话(它跟 `showsNodeCapability` 的
 * 结论必须说同一件事),以及它的参数表里确实有「产出变量」这一格(下游 `{{那一步.某变量}}`
 * 能不能取到值,取决于用户填不填这张表 —— 所以那一格在不在是**用户可见的契约**)。
 * 手抄一份进夹具测的是抄本,抄本会跟真货漂开;这两条偏偏都只在真货上才有意义。
 */
export function builtinCommandManifest(): NodeTypeManifest {
  const found = BUILTIN_NODE_TYPES.find((m) => m.id === NODE_COMMAND_TYPE_ID);
  if (found === undefined) throw new Error("内置节点清单里没有命令 —— 上面那张表被改坏了");
  return found;
}

/**
 * 按 id 取一份内置节点类型 —— 冒烟要对着**真货**断言参数表时用它。
 *
 * ## 为什么不能只导出那两份 `builtin*Manifest()`
 *
 * 那两份是"某一个具体类型"的专用出口,各自配着自己的理由。而**参数表这类东西是
 * 会随内置类型增删而移动的**:每加一种要断言的类型就再写一个 `builtinXxxManifest()`,
 * 出口数量跟着节点类型数量长 —— 而它们做的事**一模一样**。
 *
 * 这里给的是那一个动作本身。返回 `undefined` 而不是抛:调用方(冒烟)要断言的恰恰是
 * "这一格在不在",它拿到 `undefined` 时自己说得出更好的话。
 */
export function builtinManifestById(id: string): NodeTypeManifest | undefined {
  return BUILTIN_NODE_TYPES.find((m) => m.id === id);
}

const BUILTIN_NODE_TYPES: readonly NodeTypeManifest[] = [
  {
    id: MAIN_NODE_TYPE_ID,
    manifestVersion: 1,
    name: "主代理",
    description:
      "即主对话本身。用户那句话先到这里,主对话带着此前的全部上下文回一轮,并把工作拆解给下游。每份工作流自带一个,不可删除。",
    icon: "message",
    category: "通用",
    // **入口跑在主对话里**(`conversation`),不是一段隔离的会话。
    //
    // 理由只有一个:它**就是用户正在说话的那个对话框**。隔离跑法(旧行为)下,用户
    // 那句话被回声进聊天框、同时又被送进一段他看不见的会话,主对话那边一个字都没接
    // 到 —— 他看着自己的话挂在那儿没人理,而"跟他说话的那个助手"被晾在一边。轮到
    // 下一步要问点什么时,那一步也问不到他。
    //
    // 跑在主对话里之后,`runInConversation` 会**扣住**这一轮的收口(`turn.done`)和
    // 逐字流(声明了产出变量时),整张图跑完才由收尾补一条 —— 所以界面上不会中途冒出
    // "回合完成"(见 `runner.ts` 的 `runInConversation`)。
    runner: { kind: "conversation" },
    // ⚠️ **这一项对它不生效,填 `read` 只是因为清单必须有一个**(同对话节点):
    // 它跑在主对话里,权限用的是**主对话当前那一套**。
    capability: "read",
    // 只有入口节点带「固定条件」—— 它长在聊天输入框上方,陪着图的起点(见
    // `criteriaParam`)。子 agent 不传 `extra`,参数表保持原样。
    //
    // ⚠️ **getter 惰性求值,不能是顶层求值的属性。** params → mainParams → ioParams →
    // contextOptions → loadLibraryTypes 要读 settings 表(DB):模块 import 期 initDb()
    // 还没 resolve,顶层求值会在启动时炸(getDb() called before initDb() resolved)。
    // getter 把首次读取推迟到 loadNodeTypes() 运行时 —— 那时调用方必已 await 过 Db。
    // 附带的好处:用户自建的类型不再固化在启动快照里,改完注册表下一轮就能勾到。
    get params() {
      return mainParams();
    },
    outputs: [{ key: "summary", label: "结果文本", description: "主对话这一轮说的话,会传给下游节点" }],
    usage:
      "**入口节点 —— 它跑在主对话里。** 新建的工作流自带一个,一份图里只有它一个,而且删不掉:用户选了这张图,那段对话的第一句就是发给它的。\n" +
      "  **它不是一段独立的会话**:它的指令作为一条用户消息发进当前这个对话,主对话(连同之前聊过的全部内容)回一轮 —— 所以「这一步靠什么跑」那一组不用配(模型、技能、MCP、插件、引擎、权限,用的全是主对话当前那一套)。**收什么、交什么是配的**,和子 agent 同一套。\n" +
      "  **它的活是拆不是做**:把请求分成几步、写清每一步要什么,交给下游的子 agent;要是它自己把整件事做完了,下游就没得干了(这套图最容易踩的坑,所以指令里要写明「把活分给下游」这类话)。它几乎总是有下游 —— 只有它一步的图,不如直接在对话里说。\n" +
      "  ⚠️ **跑这一轮的时候用户插不进话**,而且它跑完**不会**让界面显示「这一轮结束了」 —— 那条要等整张图收尾。\n" +
      "  ⚠️ **它的上下文只增不减。** 这一步读过的文件、工具的每一次返回,都永久留在这个对话里,后面每一轮都背着它。" +
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
    /**
     * **只有子 agent 默认开自动重试。** 三次,退避用默认值(5 秒起、每次乘三)。
     *
     * 为什么是它、而且只有它:
     *  - 它是**一段独立会话**,重跑一次不会在用户的对话里多出一条消息 —— 对话节点
     *    和主代理跑在主对话上,重试的每一轮都会留下痕迹,那是用户自己的聊天记录。
     *  - 它**没有本机副作用的既成事实**:命令 / 代码节点可能已经写了半个文件、起过
     *    一个进程,重跑是把副作用做第二遍,那必须由写图的人自己决定(在清单里显式声明)。
     *  - 它是**最常用的那一格**,而它撞上的失败绝大多数是瞬时的:限流、网络抖动、
     *    引擎临时 503、被看门狗判死的卡死回合。这些正是"等一会儿再来一次就好了"。
     *
     * 只有 `shouldRetryOutcome` 认可的失败才真的会重试 —— 指令写错、产出不合约束这些
     * 一次都不会多跑。
     */
    retry: { maxAttempts: 3 },
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
      "不另开会话:把指令当作你在主对话里说的一句话发出去,主对话(连同此前的全部上下文)回一轮。答案留在对话里。",
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
        help: "打开后,运行到本步骤时先询问你的意见:采用它的指令(可补充若干句)、跳过本步骤、重复上一个任务、退出流程。",
      },
      {
        key: NODE_INJECT_MODE_KEY,
        kind: "select",
        label: "注入模式",
        options: INJECT_MODES.map((m) => ({
          value: m,
          label: m === "ask" ? "先问一句,等回答" : "自动注入,发完就走",
        })),
        help: "默认等这一轮说完,流程再往下走。「自动注入」是替用户发一条消息,发完立即算完成 —— 长任务守望用的就是它。",
      },
      {
        key: NODE_INJECT_TARGET_KEY,
        kind: "select",
        label: "注入到",
        options: INJECT_TARGETS.map((t) => ({
          value: t,
          label: t === "self" ? "本会话(跑这张图的)" : "发起会话(按守望按钮的那条)",
        })),
        help: "默认发进运行这张图的会话。「发起会话」只在用「守望」按钮起跑时成立;手动运行的自动化没有发起人,本步骤会明确失败。",
      },
      // 「进来什么 / 出去什么」那一组和子 agent 完全共用(见 `ioParams`)—— 收到上游产出、
      // 按一张表交东西、声明产出变量给下游取,这几件事跟"在哪儿跑"没有关系。
      //
      // **但「回到主对话」那一个不给它**:它本来就在主对话里,内容和过程天然在那儿。
      ...ioParams(),
      // 记忆这一格**给它**:它虽然跑在主对话里,但那一段提示词是**当场拼的**
      // (`buildNodeInput` 对 `conversation` 跑法照样走公共那条返回),所以开关是
      // 真生效的 —— 跟「回到主对话」那种"本来就在那儿、配了不算数"不是一回事。
      ...memoryParam(),
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
      "运行到此处即在岔路口选择一条出路继续,其余几条连同它们的下游一并作废。选项即它的出边 —— 从它向下游拉若干根线,每根线写一个选项名。由谁选择取决于「决定权」:弹出窗口等你点选,或由模型按判据自行判断。",
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
        help: "默认等你点选。给模型则它自跑一轮自行挑选,选完继续 —— 适用于「看结果就知道往哪走」的无人值守分流。",
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
    id: CONDITION_NODE_TYPE_ID,
    manifestVersion: 1,
    name: "条件",
    description: "用上游变量的 exists / equal / contains 规则自动选 true 或 false 出路。支持 AND / OR；只读数据,不调用模型,不执行代码。",
    icon: "split",
    category: "通用",
    runner: { kind: "condition" },
    capability: "read",
    params: [{
      key: NODE_CONDITION_EXPRESSION_KEY,
      kind: "conditions",
      label: "真假条件",
      required: true,
      default: { logic: "and", rules: [{ ref: "", op: "exists" }] },
      help: "选择 AND/OR,逐条挑上游变量与 exists / equal / contains；比较值只是文本,不会作为代码执行。",
    }],
    outputs: [
      { key: "summary", label: "上游结果", description: "原样传给选中的下一步" },
      { key: "result", label: "真假判定" },
      { key: "branch", label: "出路", description: "true 或 false" },
    ],
    usage:
      "**声明式条件节点。** 填 expression: { logic: 'and' | 'or', rules: [{ ref: '{{上游.字段}}', op: 'exists' | 'equal' | 'contains', value: '字面文本' }] }；exists 不填 value，另外两种必须填字符串。" +
      "出边恰好两条,标签分别写 true 和 false；命中走 true,不命中走 false。没走的支路标 unselected,汇合点照常跑。" +
      "不需要也不会调用模型、eval 或启动命令；没有值时 exists 为 false,但引用不存在/不在上游会失败。自动条件不能充当环上的人工闸门。",
  },
  {
    id: NODE_COMMAND_TYPE_ID,
    manifestVersion: 1,
    name: "命令",
    description:
      "在本机执行一条 shell 命令,进程退出后才继续。退出码与输出尾部交给下游 —— 要按成败分流,下游接一个「决定权给模型」的分支,依据退出码判断。",
    icon: "terminal",
    category: "自动化",
    runner: { kind: "command" },
    // ⚠️ **这一项对它不生效,填 `exec` 只是因为清单必须有一个。** 它起的是**进程**,
    // 而进程没有"权限模式"这回事 —— 这一步能做什么由命令里写的那一条决定,改这个
    // 下拉框改不动它(见 `@contracts/nodeType` 的 `showsNodeCapability`,那张表把
    // `command` 和 `code` 一并归到"不管")。填 `exec` 是**如实描述它多半会干什么**,
    // 不是承诺;界面上也正因如此不给它摆那个控件 —— 摆一个不生效的框等于承诺一件
    // 做不到的事。
    capability: "exec",
    params: [
      {
        key: NODE_COMMAND_PARAM_KEY,
        kind: "text",
        label: "命令",
        required: true,
        help: "在本机 shell 中执行的命令。运行到本步骤即执行,进程退出后才轮到下一步 —— 结束码是多少都算跑完。",
      },
      {
        key: NODE_COMMAND_TIMEOUT_KEY,
        kind: "number",
        label: "超时(毫秒)",
        help: "超过此时长仍未结束则终止,本步骤按失败计。留空或 0 = 不限时长,等它自行退出。",
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
      "  **没有审批,「能力」那一项也管不着它。** 命令是你画图时写死在这儿的那一条,不是跑到一半才问的事;而起的是**进程** —— 进程没有「权限模式」这回事,`exec` 那一项只是清单为了形状完整而声明的(见 `@contracts/nodeType` 的 `showsNodeCapability`),把它改成别的也改不动这条命令能做什么。**所以别把不认识的图里的命令节点当成无害的**:上面写的那条命令会在你的机器上原样跑起来,没人会先问你一句。\n" +
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
      // `fromParam` 让编辑器按上面那一格选的运行时高亮(见 `NodeParamSpecSchema.fromParam`)——
      // ⚠️ 语言那一条**必须排在它前面**,值是从已渲染过的参数里读的。
      { key: NODE_CODE_PARAM_KEY, kind: "code", fromParam: NODE_CODE_LANGUAGE_KEY, label: "Code", required: true, help: "Program source. Input JSON arrives on stdin." },
      { key: NODE_CODE_INPUT_KEY, kind: "longtext", label: "Input JSON", help: "Optional. Use {{upstream.output}} style templates." },
      { key: NODE_CODE_TIMEOUT_KEY, kind: "number", label: "Timeout (ms)", help: "0 = unlimited." },
      ...outputVarsParam(),
    ],
    outputs: [{ key: "exitCode", label: "Exit code" }, { key: "stdout", label: "Stdout" }, { key: "stderr", label: "Stderr" }],
    usage:
      "General-purpose code execution. Read JSON from stdin; emit @@mcode:result {summary,outputs,artifacts} and @@mcode:progress {percent,message} on stdout. artifacts uses {kind,uri,name?,mimeType?,sizeBytes?} references; bytes stay external.",
  },
  {
    id: MODULE_CAPABILITY_NODE_TYPE_ID,
    manifestVersion: 1,
    name: "模块能力调用 / Module capability",
    description: "调用真实内置模块的只读文件能力；不运行用户导入模块。 / Invoke a built-in read-only file capability, not an imported user module.",
    icon: "puzzle",
    category: "自动化 / Automation",
    runner: { kind: MODULE_CAPABILITY_RUNNER_KIND },
    capability: "read",
    params: [
      { key: "moduleId", kind: "text", label: "模块 / Module", required: true,
        help: "宿主目录中的内置模块。Builtin module from the host catalog." },
      { key: "contributionId", kind: "text", label: "贡献 / Contribution", required: true,
        help: "所选模块的只读贡献。Read-only contribution of the selected module." },
      { key: "path", kind: "text", label: "文件路径 / File path", required: true,
        help: "工作区内的文件路径，支持变量。File path in run workspace; templates allowed." },
    ],
    // Manifest outputs describe referenceable fields, not mandatory output rules.
    outputs: [
      { key: "bytes", label: "字节数 / Bytes", description: "inspect / info" },
      { key: "sha256", label: "SHA-256", description: "仅 inspect / inspect only" },
      { key: "modifiedAt", label: "修改时间 / Modified at", description: "仅 info，Unix 毫秒 / info only, Unix milliseconds" },
    ],
    usage: "Only moduleId, contributionId and path are editable. Select a host-published workflow target. " +
      "core.file-report / inspect returns bytes and sha256; info returns bytes and modifiedAt. " +
      "The host supplies workspace and request identity, rejects user modules and real-path escapes, and owns cancellation/timeouts. " +
      "No shell, model, caller-provided trusted/projectPath/requestId, or automatic restart recovery. " +
      "Downstream nodes can reference {{File inspection.bytes}} (or sha256 for inspect, modifiedAt for info).",
  },
  {
    id: TRIGGER_NODE_TYPE_ID,
    manifestVersion: 1,
    name: "触发器",
    description:
      "一条自动化的起点:到点、文件变化、或事件发生时,按写定的那句话起一次运行。它没有入边 —— 它是图的开头。",
    icon: "zap",
    category: "自动化",
    runner: { kind: "trigger" },
    // 它自己不跑任何东西(和「分支」一样),所以这一项没有实际作用。给 `read` 是**最保守
    // 的那个值** —— 顺带也让它卡片上不显示能力标签(见 `WorkflowNodeCard` 的
    // `showsCapability`)。
    capability: "read",
    params: [
      // **「启用」排在「触发方式」前面。** 不是随手放的:一个关掉的触发器,下面那些
      // 「触发方式 / cron / 目录」填得再全也不会响 —— 开关摆在最上面,用户扫一眼就知道
      // 症结在哪。反过来放的话,得先把一整屏参数看完才发现根因在最底下。
      {
        key: NODE_TRIGGER_ENABLED_PARAM_KEY,
        kind: "boolean",
        label: "启用",
        default: true,
        help: "关掉之后这条触发器不响,但留在图里、参数原样保留 —— 调试图的时候先让它安静一会儿用这个。**手动「立刻运行一次」不受它影响。**",
      },
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
        help: "「手动运行」只在列表里点「立刻跑一次」;另外三种在应用开着时自动触发。",
      },
      {
        key: NODE_PROVIDER_PARAM_KEY,
        kind: "ref",
        from: "providers",
        label: "无人值守引擎",
        help: "没有发起对话的定时、文件和事件触发使用这个引擎。留空才回退应用默认引擎；从对话启动的守望仍优先继承那个对话。",
      },
      {
        key: NODE_MODEL_PARAM_KEY,
        kind: "ref",
        from: "models",
        fromParam: NODE_PROVIDER_PARAM_KEY,
        label: "无人值守模型",
        help: "无人值守运行的宿主模型。留空由上面的引擎选择默认模型；节点自己显式指定的模型仍优先。",
      },
      {
        key: NODE_TRIGGER_PROJECT_PARAM_KEY,
        kind: "ref",
        from: "projects",
        label: "在哪个项目里跑",
        // ⚠️ **不是必填** —— 「事件发生时」那一路不需要工作目录(它要做的事都是拿绝对
        // 路径去操作库里的文件),而**内置模板预置不出项目 id**(项目 id 是建项目时现
        // 生成的),所以必填的话内置自动化永远挂不上。留空时退回宿主目录。
        // 定时 / 文件变化仍然要填:`parseTriggerSpec` 会当场拒。
        // 单值。见 `@contracts/nodeType` 的 `NODE_PARAM_REF_SOURCES` 里 `projects` 那一段:
        // 一次运行只有一个工作目录。
        help: "本次运行的工作目录,以及它的会话挂载位置。定时与文件变化必须填(它们按目录算);「事件发生时」可以留空,留空时在宿主目录里跑。",
      },
      {
        key: NODE_TRIGGER_TASK_PARAM_KEY,
        kind: "longtext",
        label: "这次要做什么",
        required: true,
        help: "触发时,这句话即本次运行的用户请求(入口节点读到的那一句)。写成一句完整的话。",
      },
      {
        key: NODE_TRIGGER_CRON_PARAM_KEY,
        kind: "text",
        label: "定时表达式",
        help: "仅在「定时」时生效。5 段:分 时 日 月 周,如 `0 9 * * 1-5` = 工作日九点。应用没开着时不补跑。",
      },
      {
        key: NODE_TRIGGER_PATHS_PARAM_KEY,
        kind: "text",
        label: "监听哪些文件",
        help: "仅在「文件变化」时生效。逗号分隔,相对项目目录,支持 `*`(如 `*.md, src/**/*.ts`)。",
      },
      {
        key: NODE_TRIGGER_EXCLUDE_PATHS_PARAM_KEY,
        kind: "text",
        label: "排除哪些文件",
        help: "可选。仅在「文件变化」时生效。逗号分隔,相对项目目录,支持 `*`(如 `dist/**, generated/**`)；匹配的文件变化不会触发。",
      },
      {
        key: NODE_TRIGGER_EVENTS_PARAM_KEY,
        kind: "text",
        label: "听哪些事件",
        help: "仅在「事件发生时」生效。逗号分隔,取值与钩子那张表一致(如 `tool.use, turn.done`)。",
      },
      {
        key: NODE_TRIGGER_FILTER_PARAM_KEY,
        kind: "text",
        label: "再筛一层",
        help: "工具名或文件路径,逗号分隔,支持 `*`。仅在所听事件带这两样时有意义。",
      },
      {
        key: NODE_TRIGGER_DEBOUNCE_PARAM_KEY,
        kind: "number",
        label: "合并窗口(毫秒)",
        default: DEFAULT_TRIGGER_DEBOUNCE_MS,
        help: "在此间隔内连续多次变化(存一次盘改动了若干文件)合并为一次运行。0 = 每次都跑。",
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
    out.entries.push({ id: result.manifest.id, source, from, manifest: result.manifest, manifestDir: dir });
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
