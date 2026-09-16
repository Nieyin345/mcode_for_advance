/**
 * 工作流调度器 —— 把一张 `WorkflowDoc` 按依赖推到底。
 *
 * ## 为什么在主进程,而且为什么是**纯的**
 *
 * "谁可以跑、什么时候跑、失败了怎么办"是确定性逻辑。交给模型既不可靠也没法验证,
 * 所以它归 host。而这里**不 import 任何运行时东西**(不碰 `RuntimeManager`、不碰
 * 会话、不碰事件通道):"怎么跑一个节点"由调用方通过 {@link RunPorts} 注入。
 *
 * 拆开是为了**可验证** —— 这个仓库没有测试框架,验证靠无头脚本,而"同列真的并发 /
 * 依赖真的严格 / 失败真的传播 / 取消真的停"这四条,只有在能塞一个假执行器进来时
 * 才断言得了(见 `scripts/scheduler-smoke`)。真实执行器在 `runner.ts`。
 *
 * ## 推进方式:**就绪即派发**,不是逐层推进
 *
 * 每轮重扫一遍:谁的依赖全都成功了就立刻发出去,不等同一层的其它节点。逐层推进
 * (等整层跑完再下一层)写起来更短,但会让一个慢节点拖住一条本可以更早开始的下游
 * 链 —— 而"同层并行"本来就只是布局的产物(见 `@contracts/workflow` 文件头),
 * 不该被当成调度语义。
 *
 * ## 失败怎么传
 *
 * 一个节点失败(或被执行器标成取消)→ 它的**全部传递下游**标 `skipped`,且**不被
 * 派发**。其余分支照常跑完。不自动重试、不自动跳过 —— 见方案「失败/取消(v1 最小
 * 处理)」。用户重新发一条消息就是重新跑一遍。
 *
 * ## 岔路口:分支节点把决定权交给用户
 *
 * `runner.kind === "branch"` 的节点不跑任何东西 —— 它把这次运行**停在那儿**,问用户
 * 走哪条路(见 {@link RunPorts.choose})。**它的选项就是它的出边**(`WorkflowEdge.
 * label` / `note`),用户选一条,其余几条连同它们拖着的整条支路一起标 `unselected`。
 *
 * ### 「没走」和「失败」必须分开传
 *
 * 这是这块最容易做错、做错了又最难查的一处。分支之后两条支路**常常在同一个汇合点
 * 碰头**(「再来一轮」和「进入查重」最后都走到「导出」),用户选了一条:
 *
 * - 把没走的那条**当失败**传 → 汇合点看到"上游没有成功" → **整步跳过**。用户选了路、
 *   一路跑下来,最后发现最后一步没了,而卡片说的是某一步失败了,那一步其实好好的。
 * - 把没走的那条**当不存在** → 汇合点只等它**真正**的上游 → 照常跑。
 *
 * 所以:标 `unselected`(不是 `skipped`),而就绪判断看的是 {@link liveUpstreamOf}
 * —— **活跃的**上游,不是所有上游。往下游**传**的时候仍然传 `unselected`:"这一步
 * 为什么没跑"得有个说得出口的、而且是真的答案。
 *
 * ⚠️ 改这一段之前先想清楚上面那两行,它们是同一个判断的两端,改一头必坏。
 *
 * ### 分支是**透传**的
 *
 * 一个节点的就绪判断看的是"有效上游全都成功",而**没被选中的出边是死的** —— 所以
 * 分支下游那一步**只能连分支**(再连一条别的上游,那条边是活的,这一步就不管选哪条路
 * 都照跑)。那内容从哪来?**挂在分支身上透传过去**:分支的产出就是它上游那几步的结果
 * 拼起来那一段(见 `chooseOne` 里那段)。
 *
 * 没有这条通路的话,分叉就等于**把东西丢了** —— 「再改一轮」那一步会拿不到稿子。
 *
 * ## 回头:分出去的一条线指回前面
 *
 * 分支的一条出路可以**指回前面某一步**(见 `@contracts/workflow` 的「回头」)。选它 =
 * "这几步再来一轮",用户原话:「他应该是能够回头分的呀 …… 这样就能不断迭代」。
 *
 * 三条规矩,缺一条这个环就转不起来或者停不下来:
 *
 * 1. **回边不是依赖。** `deps` 走 `buildForwardAdjacency` —— 含回边的话,环的入口要等
 *    出口、出口要等入口,一次都转不动(`liveUpstreamOf` 那里同理)。
 * 2. **选中回边 → 抹掉这个环,重新布防**(见 `rewindLoop`)。要抹的不只是环体:这个
 *    分支门后的那些节点在第一轮里被判过死、落了 `unselected` 的结局,不清的话第二轮
 *    用户回心转意选了它们,它们**永远不会跑**。
 * 3. **重跑的那一步要看得见自己上一版。** 它每次跑都是新会话,不记得上一轮;所以那一步
 *    跑完之前,它上一版的产出**还在流程记录里**(换掉那一版发生在它这一轮跑完之后,
 *    见 `appendStep`)。没有这一条,"再改一轮"就退化成"从头再写一遍"。
 *
 * **转飞不了**,因为绕一圈必须经过那个岔路口,而岔路口要用户点一下 —— 这是**结构上**
 * 成立的,不是靠"最多 N 轮"的计数器兜着(那个做法的毛病见 `@contracts/workflow`)。
 *
 * ## 流程记录:节点看见的是"整条流程做过什么",不只是直接上游
 *
 * 每个节点默认只看**直接上游**的产出(便宜、且够用于一条直线)。但**读整条流程的记录**
 * 是节点上的一个开关(`NODE_FLOW_RECORD_PARAM_KEY`),打开之后它看到的是
 * {@link flowRecordSection} 渲染出来的一条日志:这条流程是干什么的、用户最初要什么、
 * 每一步各交了什么、用户在每处岔路口选了什么。
 *
 * 默认值按图的结构给 —— **在环上的节点默认读**(见 `readsRecord`):环是"要迭代"的
 * 唯一信号,而迭代那一步最需要知道"之前做过什么"。
 */
import {
  ASK_EXIT_CHOICE,
  ASK_REPEAT_CHOICE,
  ASK_RUN_CHOICE,
  ASK_SKIP_CHOICE,
  BRANCH_STOP_CHOICE,
  NODE_PROMPT_PARAM_KEY,
  askBeforeRunOf,
  contextKindsOf,
  flowRecordOf,
  isAskChoice,
  isRunnerImplemented,
  mcpServerNamesOf,
  pluginNamesOf,
  providerIdOf,
  returnModeOf,
  skillNamesOf,
  validateNodeParams,
  type NodeContextKind,
  type NodeOutcome,
  type NodeReturnMode,
  type NodeTypeManifest,
} from "@contracts/nodeType";
import {
  buildForwardAdjacency,
  loopBackEdgesOf,
  nodesOnLoopOf,
  outgoingEdgesOf,
  upstreamClosure,
  type WorkflowDoc,
  type WorkflowEdge,
  type WorkflowNode,
} from "@contracts/workflow";
import { referencedNodeNamesIn, renderTemplate, type NodeTemplateScope } from "@contracts/nodeTemplate";
import type { WorkflowChoiceOption } from "@contracts/runtime";
import {
  NODE_OUTPUT_CONTRACT_KEY,
  checkOutput,
  describeOutputVars,
  outputVarsOf,
  pickOutputs,
  validateOutputRules,
} from "@contracts/outputConstraint";
// 资料行的**形状**来自 `contextInherit`(它是认类目那一端):端口把它原样交进来,
// 怎么摆是 `schedulerPrompt.ts` 的事 —— 调度器不碰库,也不需要知道"哪个 id 属于
// 哪一类"是怎么查出来的。
import type { ContextLine } from "./contextInherit.js";

// 提示词这一层拆去了 `schedulerPrompt.ts`(给模型看的东西怎么拼:计划、上游、记录、
// 资料分组)。这里只剩"什么时候需要一份提示词"。依赖保持单向:scheduler →
// schedulerPrompt,反方向不允许 —— 那正是原来两件事挤一个文件里的根源。
import {
  askSection,
  composeNodePrompt,
  findStep,
  flowRecordSection,
  planOf,
  recordBodyOf,
  type Arrival,
  type AskAnswer,
  type FlowRecordEntry,
  type WorkflowPlan,
} from "./schedulerPrompt.js";

/* ────────────────────────── 端口 ────────────────────────── */

/** 交给执行器的一份输入。
 *
 *  **这里是"节点参数 → 这一轮怎么跑"的唯一映射点。** 每加一种影响执行的能力(技能、
 * 记忆、工具白名单……),步骤都是同一个:在 `@contracts/nodeType` 定一个约定键、在这里
 * 加一个字段并在 {@link nodeInputOf} 里取一次、执行器读这个字段。**不要让执行器自己
 * 去 `node.params` 里翻** —— 那等于同一条约定有两个读法,改一处忘一处就分家了。 */
export interface NodeRunInput {
  /** **已经拼好的**这一轮提示词,见 {@link composeNodePrompt}。执行器直接用它,
   *  不再自己拼 —— 拼法(上游结果怎么摆、用户请求给谁)属于调度语义。 */
  prompt: string;
  /** 这一步要用的技能(来自约定键 `skills`,见 `@contracts/nodeType` 的
   *  `NODE_SKILLS_PARAM_KEY`)。空数组 = 不限制。 */
  skills: string[];
  /** 这一步能用哪几个 **MCP 服务器**(约定键 `mcp`)。空数组 = 不限制(全部)。
   *
   *  和 `skills` 并列而不是塞进它:技能是"模型可以调用的东西",MCP 服务器是"整个工具面
   *  有多大" —— 后者决定的是**上下文里躺着多少条工具定义**(见
   *  `@contracts/provider` 的 `StartTurnRequest.mcpServerNames`)。 */
  mcpServerNames: string[];
  /** 这一步加载哪几个**插件**(约定键 `plugins`)。空数组 = 不限制(所有已启用的)。 */
  pluginNames: string[];
  /** 这一步跑完之后**有多少东西并回主对话**(约定键 `returnToChat`)。见
   *  `@contracts/nodeType` 的 `NODE_RETURN_PARAM_KEY` —— 默认 `none`,也就是从前的行为。 */
  returnMode: NodeReturnMode;
  /** 这一步要用的引擎(`provider` 约定键)。`undefined` = 跟着对话走。 */
  providerId?: string;
  /** 取消信号。执行器应当尽快停下来(真实实现里是 interrupt 那个回合)。 */
  signal: AbortSignal;
}

/** 调度器要问外面的六件事。真实实现在 `runner.ts`,冒烟脚本塞的是假的。 */
export interface RunPorts {
  /** 拿一个节点类型的清单。没有 = 这个类型没装(别人分享来的图会走到这里)。 */
  manifestOf(typeId: string): Promise<NodeTypeManifest | undefined>;
  /**
   * 这一步要继承的上下文 —— 从发起这次运行的那条消息里,挑出这几类的资料
   * (见 `@contracts/nodeType` 的 `NODE_CONTEXT_PARAM_KEY`)。
   *
   * 做成端口而不是在这里直接算,是因为"一条 `@路径` 属于哪个类目"要查库(分类和条目的
   * id 都是不透明的)。调度器**不认识仓库**,那是 `runner.ts` 那边的事
   * (见 `contextInherit.ts`)。
   *
   * 交回来的是**事实**(类目 / 层级 / 路径),不是拼好的行 —— 怎么摆是提示词这一层的
   * 事(见 `composeNodePrompt` 里 {@link renderContextLines} 那段)。
   */
  contextLines(kinds: NodeContextKind[]): ContextLine[];
  /** 真跑一个节点,直到它的回合结束。**前置检查(类型在不在、执行方式实现没有、
   *  参数齐不齐)在调度器这一层做掉了** —— 执行器只管跑。 */
  execute(node: WorkflowNode, manifest: NodeTypeManifest, input: NodeRunInput): Promise<NodeOutcome>;
  /**
   * 问用户走哪条路 —— **它会一直等,等到他点了为止**。
   *
   * ## 为什么"通知"和"等待"是同一个调用
   *
   * 因为挂起的定义就是"这次运行停在这儿等一个回答"。拆成两个调用(先 report 再等)
   * 会多出一个中间态:通知发出去了但没人等(用户点了没人接),或者有人在等而界面上
   * 没有按钮(永远等不到)。两种都是死锁,而且都不报错 —— 图就那么停着。
   *
   * ## 取消时必须落地
   *
   * `signal` 一响,这个 promise **必须** settle(返回什么都行,调用方会检查
   * `signal.aborted`)。不落地的话那次运行永远收不了尾:`runs` 里那条记录清不掉,
   * 用户从此在这个对话里发什么都只会得到"这个工作流还在跑"。
   *
   * ## `preset`:答案已经有了,别再问
   *
   * 续跑时用户刚在**那张旧卡片**上点了一下(见 {@link RunResume.answer}),答案就在
   * 手里。这一支**不要等、也不要再摆一张"等你选"的卡** —— 他刚刚已经点过了。
   * 唯一还要做的是把"选完了"那一下补上:否则界面上那张卡会永远停在按钮状态。
   */
  choose(
    node: WorkflowNode,
    options: WorkflowChoiceOption[],
    signal: AbortSignal,
    preset?: BranchChoice,
  ): Promise<BranchChoice>;
  /** 节点起跑/定案。真实实现把它变成对话里的一张卡片。 */
  report(e: RunReport): void;
  /**
   * **同时最多几个节点在跑。** 不给 = 不限(老行为)。
   *
   * 做成一个**函数**而不是一个数,是因为它要**每次派发时现读**:用户可能在图跑到一半时
   * 去设置里改小它。真实实现那一头读的是 `SettingRepo`(见 `AutoArchiver` 同一个做法),
   * 调度器不认识设置存哪儿。
   *
   * 到了上限的那些节点**排队等**,不是失败 —— 主循环本来就是"重扫到没有东西可动为止",
   * 下一个节点一收场它们就会被重新轮到(见下面派发那一段)。
   */
  maxParallel?(): number;
  /**
   * 这次运行**跑到哪儿了**变了一下。落不落盘、写到哪儿,由调用方决定 —— 调度器
   * 不知道磁盘,也不该知道(与 {@link RunPorts.execute} 同一个理由)。
   *
   * 只在**状态真的变了**的那几个时刻调:某一步定案、停在岔路口。**不是每来一个
   * token 一次** —— 真实实现那一头一次写盘就是重写整个数据库文件(见 `runner.ts`)。
   */
  snapshot?(state: RunState): void;
}

/**
 * 一次运行**跑到哪儿了** —— 把它写下来,重启之后就能接着跑。
 *
 * ## 为什么是这五样
 *
 * 因为要回答的是"**还有什么没做**",不是"上次结果长什么样"。
 *
 *  - {@link RunState.record}:流程记录本身。环上的节点等下重跑时要看得见自己上一版
 *    (见 `appendStep`),而它每次都跑在新会话里 —— 不带着走就等于没有。
 *  - {@link RunState.rounds}:每一步跑过几次。重跑时"第 N 轮"要接着数。
 *  - {@link RunState.picks}:已经定下来的岔路口选择。**它是"没走的那条路仍然算没走"
 *    的唯一凭据** —— 少了它,续跑之后每一条出边都会被当成活的,没被选中的支路会被
 *    一并派发(见 `edgeLive`)。
 *  - {@link RunState.outcomes}:每个节点的结局。**续跑时它就是"已经定过案的那些"**
 *    (见 {@link RunResume.settled});而且下游取 `{{某步.某变量}}` 要的是里面的
 *    `outputs` —— 那个东西除了这里没有第二处留着。
 *  - {@link RunState.awaiting}:**正停在哪几格**等人。**重启之后"用户点的是哪一处"
 *    就靠它认**(见 `WorkflowRunRepo.resumableFor`)。
 *
 *    ⚠️ 它是一个**列表**而不是一个节点:两处岔路口可以**同时**就绪(它们互不依赖),
 *    于是两条都在等人(见 `runner.ts` 的 `PendingChoice`)。只记最后一个的话,用户点
 *    **先停下的那一处**,会得到一句"这条选择已经不适用了" —— 而他明明正看着那张卡。
 */
export interface RunState {
  record: FlowRecordEntry[];
  rounds: [string, number][];
  picks: [string, BranchChoice][];
  outcomes: [string, NodeOutcome][];
  /** 正在等用户拍板的那些节点。一个都没在等就是空数组。 */
  awaiting: string[];
}

/**
 * 从上次被打断的地方接着跑。
 *
 * ## 已经定过案的一律不重跑 —— **两种都算**
 *
 * 成功的不重跑是显然的(重跑一遍又贵又可能给出不一样的结果)。**"失败 / 没走这条路 /
 * 上游炸了"也一样不重跑**,这一条不那么显然,但两条理由都成立:
 *
 *  - **它们已经是定案了。** 续跑要的是"接着往下走",不是"把判过的再判一遍"。重判
 *    `unselected` 会在对话里**再发一张一样的卡**(调度器每定案一次就 `report` 一次),
 *    而用户看到的是"我没做什么,它怎么又说了一遍某某没走这条路"。
 *  - **重试是另一件事。** 一个节点真的失败了,用户要的是"重跑这一步"(见路线图),
 *    而那是**针对那一步**的动作,不该藏在"接着上次跑"底下 —— 一次续跑顺手重跑一堆
 *    失败节点,是用户没要的。
 *
 * 所以真正会重跑的只有一种:**跑到一半被打断的那个**。它压根没有结局 —— 进程死的时候
 * 它还没定案 —— 于是它是唯一一个"没做过"的。
 *
 * ## 记录**不清**,往下接着攒
 *
 * 记录是"发生过什么"的日志,而"发生过"这件事不因为进程死过就不成立。重跑的那一步
 * 尤其需要它:它看见自己上一版才谈得上"按用户说的改"(见 `appendStep`)。
 */
export interface RunResume {
  record: readonly FlowRecordEntry[];
  rounds: readonly (readonly [string, number])[];
  picks: readonly (readonly [string, BranchChoice])[];
  /** 上次已经定案的那些节点 → 它们的结局。见上面那条。 */
  settled: readonly (readonly [string, NodeOutcome])[];
  /** 用户刚点的那一下。**只对这一处生效一次** —— 回头之后同一个岔路口要重新问。 */
  answer?: { nodeId: string; choice: BranchChoice };
}

/** 用户在分支节点上做的选择。 */
export interface BranchChoice {
  /** 选中的那条**边**的 id。 */
  edgeId: string;
  /** 他顺手写的一句话。会拼进下一步的提示词(见 {@link Arrival.comment})。 */
  comment?: string;
}

/**
 * 一个类型的清单在**开跑前**取好的样子。`manifest` 缺席有两种意思,而且要说清是哪一种:
 *
 * - **没有 `error`** = 这台机器上没装这个类型(一份别人分享来的图会走到这里);
 * - **有 `error`** = 取的时候抛了(清单文件读坏了、宿主实现有 bug)。
 */
interface ManifestSlot {
  manifest?: NodeTypeManifest;
  error?: string;
}

export type RunReport =
  | { kind: "node.started"; node: WorkflowNode }
  | { kind: "node.settled"; node: WorkflowNode; outcome: NodeOutcome };

export interface RunResult {
  /** 全成功 = success;有失败 = failed;被取消 = cancelled。
   *  `skipped` 不算失败(它是失败的下游,`failed` 那条已经说清原因了)。 */
  status: "success" | "failed" | "cancelled";
  /** 每个节点的结局,按节点 id。取消时没跑到的那些是 `cancelled`。
   *
   *  **续跑时它是全量**:上次已经成功的那些也在里面(它们是从 {@link RunResume.done}
   *  进来的)。调用方据此知道"整张图现在是什么状态",而不只是"这一趟跑了什么"。 */
  outcomes: Map<string, NodeOutcome>;
  /** 收尾那一刻的 {@link RunState}。**调用方拿它落盘** —— 不给的话,这次运行做过
   *  什么又只活在内存里了(那正是这个字段存在的理由)。 */
  state: RunState;
}

/* ────────────────────────── 参数翻译 ────────────────────────── */

/**
 * 这一步能引用哪些**名字** —— 上游传递闭包里的节点,id 与标题都算。
 *
 * 闭包本身在 `@contracts/workflow` 的 `upstreamClosure`(检查器的「插入变量」列候选
 * 用的是同一份 —— 两处各写一遍的话,迟早出现"菜单里选得到、跑起来说不是上游")。
 */
function upstreamNames(
  deps: Map<string, string[]>,
  titleOf: (id: string) => string,
  nodeId: string,
): Set<string> {
  // 引用时可以写 id 也可以写标题 —— 两个都进集合,`renderTemplate` 那边再决定用哪个。
  const names = new Set<string>();
  for (const id of upstreamClosure(deps, nodeId)) {
    names.add(id);
    const title = titleOf(id).trim();
    if (title.length > 0) names.add(title);
  }
  return names;
}

/**
 * 把节点**字符串参数**里的 `{{...}}` 解算掉(见 `@contracts/nodeTemplate`)。
 *
 * 只动字符串:数组(技能那种多选)、数字、开关都不是文本,往里插值没有意义。
 *
 * 解不出来就**抛**,由 `executeOne` 兜成这个节点的失败 —— 和 `instructionOf` 同一条
 * 路。理由也一样:原样留着的话,模型会看见一句带 `{{...}}` 的指令,然后自己脑补一个
 * 值填进去,而那个值来自它的想象。
 */
function expandParams(
  node: WorkflowNode,
  manifest: NodeTypeManifest,
  scope: NodeTemplateScope,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...node.params };
  for (const [key, value] of Object.entries(node.params)) {
    if (typeof value !== "string") continue;
    // 报错要报**界面上那个名字**(「指令」),不是 `instruction` —— 用户看的是前者。
    const spec = manifest.params.find((p) => p.key === key);
    const where = spec ? `参数「${spec.label}」` : `参数 ${key}`;
    const result = renderTemplate(value, scope, where);
    if (!result.ok) throw new Error(result.error);
    out[key] = result.text;
  }
  return out;
}

/**
 * 这一步**点名引用**了哪些上游节点(见 `referencedNodeNamesIn`)。
 *
 * 两个"扫哪儿"和别处对齐,不对齐就会出现"解算认了这处引用、去重不认"这种半吊子:
 *  - 扫的是**存下来的原始参数**,不是解算后的 —— 解算把 `{{...}}` 换成值之后,就再也
 *    看不出引用过谁了;
 *  - 只扫**字符串参数**,和 {@link expandParams} 同一范围 —— 只有字符串里能插引用。
 */
function referencedNodeNames(node: WorkflowNode): Set<string> {
  const names = new Set<string>();
  for (const value of Object.values(node.params)) {
    if (typeof value !== "string") continue;
    for (const name of referencedNodeNamesIn(value)) names.add(name);
  }
  return names;
}

/**
 * 把一个节点翻译成执行器要的输入。**"节点参数 → 这一轮怎么跑"只在这里发生一次**
 * (见 {@link NodeRunInput})。
 *
 * `params` 是**已经解算过变量**的那一份(由 `executeOne` 解,见 {@link expandParams})。
 * 之所以在调用方解、不在这里解:产出回来之后还要按同一份参数查硬约束
 * (见 {@link withOutputCheck}),两处必须是**同一份值**,各解一次迟早分家。
 */
function nodeInputOf(
  params: Record<string, unknown>,
  manifest: NodeTypeManifest,
  ctx: {
    userPrompt: string;
    upstream: string;
    /** 这一步是谁 / 整条流程长什么样 —— 「整条流程」那一节的内容,见 {@link planSection}。 */
    nodeId: string;
    plan: WorkflowPlan;
    /** 这一步有没有下游(见 {@link PlanStep.isLast})。没有的话没人取它的产出变量。 */
    terminal: boolean;
    /** 它是从哪条出路来的(上游有分支节点时才有)。见 {@link Arrival}。 */
    arrival?: Arrival;
    /** 整条流程的记录(已渲染成整段)。只有开了那个开关的节点才有 —— 见
     *  `NODE_FLOW_RECORD_PARAM_KEY`,以及 {@link flowRecordSection}。 */
    record?: string;
    /** 「运行前先问我」那一次的回答,已渲染成整段。见 {@link askSection}。 */
    ask?: string;
    contextLines: (kinds: NodeContextKind[]) => ContextLine[];
  },
  signal: AbortSignal,
): NodeRunInput {
  const skills = skillNamesOf(params);
  const mcpServerNames = mcpServerNamesOf(params);
  const pluginNames = pluginNamesOf(params);
  const providerId = providerIdOf(params);
  const returnMode = returnModeOf(params);
  const context = ctx.contextLines(contextKindsOf(params));
  const vars = outputVarsOf(manifest, params);
  return {
    prompt: composeNodePrompt({
      userPrompt: ctx.userPrompt,
      upstream: ctx.upstream,
      instruction: instructionOf(params, manifest),
      nodeId: ctx.nodeId,
      plan: ctx.plan,
      skills,
      context,
      ...(ctx.arrival ? { arrival: ctx.arrival } : {}),
      ...(ctx.record ? { record: ctx.record } : {}),
      ...(ctx.ask ? { ask: ctx.ask } : {}),
      outputContract: stringParamOf(params, NODE_OUTPUT_CONTRACT_KEY),
      // **终末节点不发变量表**(见 {@link withOutputCheck})。
      outputVars: ctx.terminal ? "" : describeOutputVars(vars),
    }),
    skills,
    mcpServerNames,
    pluginNames,
    returnMode,
    ...(providerId !== undefined ? { providerId } : {}),
    signal,
  };
}

/** 一个字符串参数的当前值(没有就是空串)。 */
function stringParamOf(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  return typeof value === "string" ? value : "";
}

/**
 * 产出回来了,**当场按变量表查一遍**(见 `@contracts/outputConstraint`)。
 *
 * 为什么在调度器这一层、而不是在执行器里:
 *
 *  - **所有节点都得查**,不管它是子 agent 还是以后的脚本节点 —— 这是"统一接口"的
 *    另一半(前半是 `NodeOutcome` 本身);
 *  - 调度器是**定案**的地方。在执行器里失败的话,`runner.ts` 要自己把 outcome 从
 *    success 改成 failed,而"谁有权改结局"有两处就迟早对不上;
 *  - 它是纯的,所以冒烟脚本能塞个假执行器、让节点吐一段少了几样的文本,直接断言
 *    "这一步失败了"(真跑一遍模型做不到这件事)。
 *
 * **失败/取消的节点不查** —— 它已经有一个更要紧的原因要报,再叠一条"少了一样"只会
 * 把真正的原因埋掉。
 *
 * ## 终末节点**不查**(`terminal`)
 *
 * 产出变量表是**给下游取值的**(`{{某步.某变量}}`),没有下游就没人取 —— 所以
 * {@link nodeInputOf} 那边也不再把它发进提示词。两边必须同时做:只发不查,模型白写;
 * 只查不发,这一步会以一个"少了一样"的理由失败,而它压根没被要求过。
 *
 * 为什么非这样不可(实测出来的):`describeOutputVars` 给模型的是一段 ``` 包着的
 * `{"变量名": "示例"}` 再加一句「别用别的话把它包起来」—— 模型**照做**了,于是最后
 * 一步交出来的东西就是这一坨 JSON(实测 657 字的产出里 358 字是它),而用户明确要求过
 * 「别让我看见 JSON」。**"词不出现"是守住了,形状没守住**,而用户看见的是形状。
 *
 * ⚠️ 以后做"节点结果回灌给主代理"(路线图第 ③ 项)时要**回来改这一条**:那一天终末
 * 节点的产出会有人取,变量表就得重新发。
 */
function withOutputCheck(
  manifest: NodeTypeManifest,
  params: Record<string, unknown>,
  outcome: NodeOutcome,
  terminal: boolean,
): NodeOutcome {
  if (outcome.status !== "success") return outcome;
  if (terminal) return outcome;
  const vars = outputVarsOf(manifest, params);
  if (vars.length === 0) return outcome;

  const checked = checkOutput(outcome.summary, vars);
  if (!checked.ok) {
    // **留一个 failed,不抛。** 抛会走到 `executeOne` 的 catch 里,那条路是给"宿主
    // 实现有 bug"用的,而这里是一个正常的、说得清的结局。
    return {
      status: "failed",
      // 原文留着 —— 界面上要看得出它到底交了什么,不然用户没法判断该改约束还是改指令。
      summary: outcome.summary,
      error: checked.error,
    };
  }
  if (checked.value === undefined) return outcome;
  // 解出来的东西留下来:下游的 `{{某步.某变量}}` 取的就是它。**这是产出变量真正的
  // 回报** —— 没有它,那张表只是"更好看的一段文本"。
  return { ...outcome, outputs: { ...(outcome.outputs ?? {}), ...pickOutputs(checked.value, vars) } };
}

/* ────────────────────────── 调度 ────────────────────────── */

export async function runWorkflow(args: {
  doc: WorkflowDoc;
  /** 用户这次发的消息。只注入根节点(见 {@link composeNodePrompt})。 */
  prompt: string;
  ports: RunPorts;
  signal: AbortSignal;
  /** 从上次被打断的地方接着跑。**不给就是全新的一次**(见 {@link RunResume})。 */
  resume?: RunResume;
}): Promise<RunResult> {
  const { doc, prompt, ports, signal } = args;
  const resumed = args.resume;
  /** 上游邻接表。**不自己走一遍 `edges`** —— `buildForwardAdjacency` 是"谁依赖谁"的
   *  唯一来源(见 `@contracts/workflow`),和渲染端的勾选框用的是同一份。
   *
   *  ⚠️ 这里要的是**不含回边**的那一份。回边在结构上从环的出口指回入口,当成"上游"会
   *  让环的入口等出口、出口等入口 —— 环一次都转不起来(`buildForwardAdjacency` 的
   *  注释里有完整的理由)。回边由下面的 `loopBackIn` 单独接。 */
  const forward = buildForwardAdjacency(doc.nodes, doc.edges);
  const deps = forward.deps;
  const dependents = forward.dependents;
  // **续跑时从上次的结局起手** —— 上次已经定案的那些不重跑,而且不重判(见
  // `RunResume.settled`)。
  const outcomes = new Map<string, NodeOutcome>(resumed?.settled ?? []);
  const inflight = new Map<string, Promise<void>>();
  /** 分支节点 → 用户选的那条出边(以及他临时写的那句话)。没跑到 / 没选的分支不在里面。
   *
   *  **回头时会被清掉**(见 `rewindLoop`):重新布防之后,这个分支的每一条出路又都
   *  回到了"还没决定"的状态。
   *
   *  ⚠️ **续跑时它是从上一次的存档里恢复的**,不是空手起家 —— 少了它,分支的每一条
   *  出边都会被当成活的,上次没走的那条支路会被一并派发(见 `edgeLive`)。 */
  const chosen = new Map<string, BranchChoice>(resumed?.picks ?? []);
  /**
   * 分支节点 → 用户**上一次**选的那条出路。回卷时不跟着清 —— "这一步是从哪条路来的"
   * 要一直说得出来。
   *
   * 为什么不能直接读 `chosen`:回头那一下会把它清掉(不然这个分支的其它出路会被立刻
   * 判死,而它们恰恰是下一轮要用的)。于是环体里那一步重跑时,`chosen` 里已经没有它的
   * 来路了 —— 用户的意见(「第三章太啰嗦」)就丢了,而那是他**特意打上去的**。
   */
  const lastPick = new Map<string, BranchChoice>(resumed?.picks ?? []);
  /**
   * **这条流程到此刻为止的经过**,按完成的先后排列。见 {@link FlowRecordEntry}。
   *
   * 它是「读整条流程的记录」那个开关背后的东西 —— 谁读由 {@link readsRecord} 决定。
   * 没开这个开关的图里它照样在攒(攒的成本是一个数组,不花一分 token),只是没人读。
   *
   * **续跑时从存档接上**:记录是"发生过什么"的日志,而"发生过"这件事不因为进程
   * 死过就不成立。重跑的那一步尤其需要它 —— 它看见自己上一版才谈得上"按用户说的改"。
   */
  const record: FlowRecordEntry[] = [...(resumed?.record ?? [])];
  /** 节点 id → 这一步跑过几次。回头绕第二圈时是 2。续跑时接着数。 */
  const rounds = new Map<string, number>(resumed?.rounds ?? []);
  /**
   * 刚选中的那条回边 —— 环体还没抹,因为**分支自己的结局要先落定**({@link settle}
   * 是唯一记录结局的地方,抹环得在它之后)。为 null 表示这一轮没有回头。
   */
  let pendingLoopBack: string | null = null;
  /**
   * 已经知道答案的岔路口 —— 续跑时用户刚在旧卡片上点的那一下(见
   * {@link RunResume.answer})。**只生效一次**:进 `chooseOne` 时取走,回头之后同一个
   * 岔路口要重新问。
   */
  const presetChoices = new Map<string, BranchChoice>(
    resumed?.answer ? [[resumed.answer.nodeId, resumed.answer.choice]] : [],
  );
  /**
   * 正在等用户拍板的那些节点。**是集合不是单个** —— 两处岔路口可以同时就绪(它们
   * 互不依赖),于是两条都在等人。见 {@link RunState.awaiting}。
   */
  const awaiting = new Set<string>();

  /** 此刻的运行状态。落盘由调用方做,见 {@link RunPorts.snapshot}。 */
  const stateOf = (): RunState => ({
    record: [...record],
    rounds: [...rounds],
    picks: [...chosen],
    outcomes: [...outcomes],
    awaiting: [...awaiting],
  });
  const publish = (): void => ports.snapshot?.(stateOf());

  const titleOf = (id: string): string => {
    const node = doc.nodes.find((n) => n.id === id);
    if (!node) return id;
    return node.title.trim().length > 0 ? node.title : node.type;
  };

  /** **存下来的**标题(不拿类型 id 兜底)。判"有没有被点名引用"要用这一份 ——
   *  引用的写法认的是**存下来的标题**,`findNode` 那边也一样。 */
  const storedTitleOf = new Map(doc.nodes.map((n) => [n.id, n.title.trim()]));

  /** **整条流程**(给模型看的那份计划)。一次性算好 —— 它只取决于图,和跑不跑完无关。 */
  const plan = planOf(doc, titleOf);

  /**
   * 每个**类型**的清单,**开跑前一次取完**。
   *
   * 为什么不能在派发时现取(别处都是现取的):"这一步是不是分支"要在**同步的**调度
   * 循环里判断 —— 第 1 步的传播和第 2 步的派发都靠它 —— 而 `ports.manifestOf` 是
   * 异步的。同一个类型只取一次,所以多出来的开销是"节点类型的种数",不是节点数。
   *
   * ⚠️ **取的时候抛了也不能让它冒出去**。原来那次调用在 `executeOne` 的 try 里面,
   * 一个读坏了的清单文件只让**引用它的那些节点**失败;挪到这儿之后如果不接住,它会
   * 掀掉整张图 —— 而"一个节点炸了不往上抛"是这一层的既有规矩。所以错误存下来,
   * 派发到那个节点时再报。
   */
  const manifests = new Map<string, ManifestSlot>();
  for (const node of doc.nodes) {
    if (manifests.has(node.type)) continue;
    try {
      manifests.set(node.type, { manifest: await ports.manifestOf(node.type) });
    } catch (err) {
      manifests.set(node.type, { error: (err as Error).message });
    }
  }
  const manifestOfCached = (typeId: string): NodeTypeManifest | undefined =>
    manifests.get(typeId)?.manifest;
  const nodeById = new Map(doc.nodes.map((n) => [n.id, n]));
  if (signal.aborted) return cancelledRun(stateOf());

  /**
   * 这个节点是不是**分支** —— 看清单的 `runner.kind`,**不是**看类型 id。
   *
   * 第三方可以随插件带自己的分支类型进来,而它的行为必须和内置那个一模一样:挂起、
   * 等用户、作废其余支路是**调度器**的能力,不是某份清单的特权。认 id 的话,别人的
   * 分支节点会退化成一个什么都不做的普通节点,而图上一点提示都没有。
   */
  const isBranch = (id: string): boolean => {
    const node = nodeById.get(id);
    return node !== undefined && manifestOfCached(node.type)?.runner.kind === "branch";
  };

  /**
   * 这个节点**跑之前要先问用户一句**(节点上的「运行前先问我」开关)。
   *
   * 两样都要看:清单的执行方式**仍然是 `conversation`**(这个开关不改变"怎么跑",只加
   * 一句"跑不跑、怎么跑"),以及那个参数为真。只看参数的话,别的类型(包括将来第三方
   * 带来的)误填一个同名键就会被卷进来。
   *
   * 见 `@contracts/nodeType` 的 `NODE_ASK_PARAM_KEY`。
   */
  const isAskBeforeRun = (id: string): boolean => {
    const node = nodeById.get(id);
    if (node === undefined) return false;
    const manifest = manifestOfCached(node.type);
    return manifest?.runner.kind === "conversation" && askBeforeRunOf(node.params);
  };

  /**
   * **算数的回边** —— 环上有一个岔路口的那些。
   *
   * 一条回边算不算数,取决于**它的环上有没有闸门**,而不是"它是不是回边"。没有闸门的
   * 环是坏图(存盘时 `validateDag` 就拒了),但它真到了这里也不能当成回边放行 —— 那样
   * 它会被**当成一条直线跑一遍**,而用户画的明明是个死循环。让它继续当普通依赖,它就
   * 会走到收尾那句「依赖没有满足(图里是不是有环?)」—— 那才是用户需要看到的话。
   */
  const loopBack = loopBackEdgesOf(doc.nodes, doc.edges, isBranch);
  const loopBackIds = new Set(loopBack.map((b) => b.edge.id));
  /** 回边的 id → 它闭出来的那个环(环上的全部节点)。见 `@contracts/workflow`。 */
  const cycleOf = new Map(loopBack.map((b) => [b.edge.id, b.cycle]));

  /**
   * 图上**在环里**的那些节点 —— 给"要不要读流程记录"当默认值用。
   *
   * 判据来自 `@contracts/workflow`,因为**检查器要显示同一个答案**:那边画的是那个开关
   * 的默认态。两处各算一遍的话,会出现"界面上显示关着、实际按开着跑",而那不报错。
   */
  const onLoop = nodesOnLoopOf(doc.nodes, doc.edges, isBranch);

  /**
   * 这一步要不要读整条流程的记录。
   *
   * **节点上显式写了的以它为准**(`undefined` = 没表过态);没表态的按图的结构给 ——
   * **在环上的默认读**。理由:环是"要迭代"的唯一信号,而迭代那一步最需要知道"之前
   * 做过什么";默认给上,用户就不必先知道有这么个开关存在。
   *
   * **记录还是空的时候一律不给**:那时它只有两行表头,摆出来是纯噪音 —— 根节点就属于
   * 这一种(它前面什么都没有)。
   */
  const readsRecord = (node: WorkflowNode): boolean =>
    record.length > 0 && (flowRecordOf(node.params) ?? onLoop.has(node.id));

  /** 从 `id` 出发、沿**前进边**能到的全部节点(不含 `id` 自己)。 */
  const forwardDescendantsOf = (id: string): string[] => {
    const seen = new Set<string>();
    const stack = [...(dependents.get(id) ?? [])];
    while (stack.length > 0) {
      const at = stack.pop() as string;
      if (seen.has(at)) continue;
      seen.add(at);
      stack.push(...(dependents.get(at) ?? []));
    }
    return [...seen];
  };

  /**
   * **回头了:把这个环抹掉,重新来一轮。**
   *
   * 用户在岔路口选了那条指回前面的出路(用户的说法:「回头分」)。要做两件事:
   *
   * 1. **环体上每一步的结局清掉** —— 它们要再跑一遍;
   * 2. **分支自己的选择清掉** —— 它要再问一次。不清的话它那些没被选中的出路仍然是死的,
   *    而下一轮恰恰要用它们。
   *
   * ## 记录**不清**
   *
   * 清的是"谁跑过了"({@link outcomes}),不是"发生过什么"({@link record})。回头恰恰
   * 是记录里最要紧的一段,而且重跑那一步**必须看得见自己上一版** —— 换掉那条记录发生在
   * 它这一轮跑完之后(见 `appendStep`),所以它开跑时上一版还在记录里,「按用户说的改」
   * 才知道改的是哪一版。
   *
   * ## 清的范围为什么还要带上"分支门后的那些"
   *
   * 光清环体不够。分支的其它出路在第一轮里会被判死,拖着它们后面整片标 `unselected`
   * 并**留下结局** —— 而已经留下结局的节点不会再被派发。于是用户第二轮回心转意选了
   * 「定稿」,那一步**永远不会跑**,卡片上写着"没走这条路"而用户刚刚才点了它。
   *
   * 所以:这个分支**做出的决定所影响到的全部节点**都要回到未决状态。环体是其中一部分,
   * 分支门前门后所有的都是。
   *
   * ⚠️ **必须在 `chooseOne` 里做**,不能等分支 settle 之后补 —— 中间隔着调度循环的第 1
   * 步,那一步会把门后那些节点标成 `unselected` 并落下结局。
   */
  /**
   * **把一批节点作废:它们自己,加上它们的全部前进后代,一起回到未定案状态。**
   *
   * ⚠️ **必须带上后代,不能只删点名的那个。** 只删自己的话,下游留着一条旧的 `success`
   * 结局 —— 它既不会被重新派发(主循环那两道闸看的就是"`outcomes` 里有没有它"),又拿不到
   * 新的上游文本。于是它带着一份**自相矛盾**的东西往下走,而且不报错。主循环第 1 步里
   * 「还有有效上游没定案就不能下结论」那段注释,防的是同一件事的另一端。
   */
  const voidClosureOf = (ids: Iterable<string>): void => {
    for (const id of ids) {
      for (const each of [id, ...forwardDescendantsOf(id)]) outcomes.delete(each);
    }
  };

  const rewindLoop = (fromId: string, marker: string): void => {
    // **「运行前先问我」选了「重复上一个任务」。** 它不是一条画在图上的回边(见
    // `@contracts/nodeType` 的 `ASK_CHOICES`),所以没有 `cycleOf` 可查 —— 要抹的是
    // **上一步及其全部后续**,而"上一步"就是这一步的有效上游。
    //
    // 抹完之后**这一步自己也没有结局**(它在上游的后代闭包里),于是等上一步重新跑完、
    // 这里会**再问一次** —— 那正是用户要的"重复完成之后依旧在这个对话节点"。
    if (marker === ASK_REPEAT_CHOICE) {
      voidClosureOf(effectiveUpstreamOf(fromId));
      return;
    }
    const cycle = cycleOf.get(marker);
    if (cycle === undefined) return;
    voidClosureOf([...cycle, fromId]);
    chosen.delete(fromId);
  };

  /**
   * 某一步跑完了,把它的产出记进流程记录。
   *
   * **同一个节点只留最新一版。** 回头重跑时,旧的那条被换掉,新的一条排到末尾 ——
   *
   *  - 换掉:记录是给下一个助手看的,它要的是"现在长什么样",不是"历来的每一版";
   *    留着旧版会让记录**随轮数线性膨胀**,跑到第十轮就没人受得了。
   *  - 排到末尾:位次是**完成的先后**。迭代本来就是"回到前面那一步、再往前",第二版排在
   *    它自己第二次跑完的位置才对得上时间线 —— 插回原位的话,"我在第一版之后被要求改了
   *    第三章"这个关系就读不出来了。
   *
   * 用户历次的选择**不在这里**,它们各是一条独立的条目,永远不会被换掉(见 `chooseOne`)。
   */
  const appendStep = (node: WorkflowNode, outcome: NodeOutcome): void => {
    const round = (rounds.get(node.id) ?? 0) + 1;
    rounds.set(node.id, round);
    const at = record.findIndex((e) => e.kind === "step" && e.nodeId === node.id);
    if (at >= 0) record.splice(at, 1);
    record.push({
      kind: "step",
      nodeId: node.id,
      title: titleOf(node.id),
      round,
      body: recordBodyOf(outcome),
    });
  };

  /**
   * 一条边**通不通**。
   *
   * 非分支节点的出边永远是通的(它就是一条依赖)。**分支节点只"激活"用户选中的那一条**
   * —— 其余几条连同它们拖着的整条支路一起作废(见下面第 1 步的传播)。
   *
   * 还没选(`chosen` 里没有)时返回 `true`:那时分支节点自己还没定案,它的下游本来
   * 就不会被派发(就绪要求"上游全都成功")。这个返回值只在**分支已经选完**之后才承重。
   */
  const edgeLive = (edge: WorkflowEdge): boolean => {
    if (!isBranch(edge.from)) return true;
    const pick = chosen.get(edge.from);
    return pick === undefined || pick.edgeId === edge.id;
  };

  /**
   * 一个节点的**活跃上游** —— 没走的那条路**不算它的上游**,回头那条也不算。
   *
   * 这是整件事最要紧的一行。分支之后两条支路常常在同一个汇合点碰头(`「再来一轮」`
   * 和 `「进入查重」`最后都走到`「导出」`),用户选了一条,另一条被标 `unselected` ——
   * 如果就绪判断还按**所有**上游算,那个汇合点会因为"写作③ 没有成功"而整步跳过,而
   * 现象是**用户选了路、跑到最后发现最后一步没了**。失败会传染是应该的;"没走"不该。
   *
   * **回边也不是来路**:它是"回到前面去"的指令,不是"我依赖前面那个结果"。含进来的话
   * 环的入口会等出口(见 `rewindLoop`)。
   */
  const liveUpstreamOf = (nodeId: string): string[] =>
    doc.edges
      .filter((e) => e.to === nodeId && !loopBackIds.has(e.id) && edgeLive(e))
      .map((e) => e.from);

  /**
   * 一个节点的**有效上游** —— 既要那条路真的通({@link liveUpstreamOf}),也要那个
   * 上游**自己走了**。
   *
   * ⚠️ **第二半是最容易漏的一处,漏了就是个很难查的 bug。** 「没走」会**沿着链条往下
   * 传**(B 没走 → 只依赖 B 的 B2 也没走),而传下去的 `unselected` 必须和"这条边根本
   * 不存在"一样被忽略掉。
   *
   * 只按 `live` 判断的话:汇合点 D 的上游是 [B2(`unselected`), C(**成功**)],而
   * "有一个不是成功"会把 D 整步跳过 —— 现象正是**用户选了路、一路跑下来,最后一步没了**。
   * 一处成功就该让 D 跑起来:C 那条路确实走到了它。
   */
  const effectiveUpstreamOf = (nodeId: string): string[] =>
    liveUpstreamOf(nodeId).filter((up) => outcomes.get(up)?.status !== "unselected");

  /** 一条出路叫什么。**没填 label 就用目标节点的标题** —— 一根说不出名字的线对用户
   *  没有意义,而"通向谁"至少说明了它会走到哪。 */
  const edgeLabelOf = (edge: WorkflowEdge): string =>
    (edge.label ?? "").trim() || titleOf(edge.to);

  /** 一个分支节点的出路(就是它的出边,顺序即文档顺序)。 */
  const branchOptionsOf = (nodeId: string): WorkflowChoiceOption[] =>
    outgoingEdgesOf(doc, nodeId).map((e) => {
      const note = (e.note ?? "").trim();
      return {
        id: e.id,
        label: edgeLabelOf(e),
        ...(note.length > 0 ? { note } : {}),
        next: titleOf(e.to),
      };
    });

  /**
   * 这一步是从哪条出路来的(上游是分支节点、且那条边正是他选的那条时才有)。
   *
   * 读的是 {@link lastPick} 而不是 {@link chosen}:回头那一下会把 `chosen` 清掉,而
   * 重跑的那一步**恰恰最需要知道自己是打哪儿来的** —— 用户的意见就挂在那个选择上。
   * 读 `chosen` 的话,「再改一轮」重跑时那一段会整个消失,而那一步看起来就像是被凭空
   * 又跑了一遍(模型只能猜"为什么又是我")。
   */
  const arrivalOf = (nodeId: string): Arrival | undefined => {
    for (const edge of doc.edges) {
      if (edge.to !== nodeId || !isBranch(edge.from)) continue;
      const pick = lastPick.get(edge.from);
      if (pick === undefined || pick.edgeId !== edge.id) continue;
      return {
        from: titleOf(edge.from),
        label: edgeLabelOf(edge),
        note: (edge.note ?? "").trim(),
        comment: (pick.comment ?? "").trim(),
      };
    }
    return undefined;
  };

  /** 一条边被哪几个分支节点挡掉了(报错时要说清是谁挡的)。 */
  const cutByOf = (nodeId: string): string[] => {
    const names: string[] = [];
    for (const edge of doc.edges) {
      if (edge.to !== nodeId || edgeLive(edge)) continue;
      const name = titleOf(edge.from);
      if (!names.includes(name)) names.push(name);
    }
    return names;
  };

  /**
   * 一段上游结果该怎么摆。**来自分支节点的那一段不加标题** —— 它是透传的,内容本来
   * 就是它上游那几步的(各自带着自己的标题,见 {@link chooseOne})。再套一层
   * `### 下一步做什么` 会把别人写的稿子挂到一个岔路口名下。
   */
  const labelUpstreamText = (upId: string, summary: string): string =>
    isBranch(upId) ? summary : `### ${titleOf(upId)}\n${summary}`;

  /**
   * 分支节点**替它上游把话带过去**的那一段。见 {@link chooseOne}。
   *
   * 和 {@link upstreamTextOf} 同一个形状(只取成功且有话说的、`### 标题` 分段),差别
   * 只有一处:这里**没有"被点名就跳过"那一步** —— 分支节点身上没有指令,也就不可能
   * 引用谁。
   */
  const carriedTextOf = (nodeId: string): string => {
    const parts: string[] = [];
    for (const up of deps.get(nodeId) ?? []) {
      const outcome = outcomes.get(up);
      if (outcome?.status !== "success") continue;
      const summary = outcome.summary.trim();
      if (summary.length === 0) continue;
      parts.push(labelUpstreamText(up, summary));
    }
    return parts.join("\n\n");
  };

  const settle = (node: WorkflowNode, outcome: NodeOutcome): void => {
    outcomes.set(node.id, outcome);
    const branch = isBranch(node.id);
    // **回头:刚落的这个结局要抹掉。**
    //
    // 顺序是被逼出来的:抹环得在**分支自己落定之后**(见 `rewindLoop`),而这里是唯一
    // 记录结局的地方。抹完之后这个分支**没有结局** —— 那正是"再来一轮"的意思:它要等
    // 环体重新跑完、再问用户一次。这一刻它没有结论可报,所以这里不再往下走。
    //
    // **开了「运行前先问我」的对话节点走同一条路**:它选了"重复上一个任务"时,刚落的
    // 就是自己的结局,而它接下来要做的正是"等上一步重跑完、再问一次"。判据里放进它,
    // 是因为这两件事**必须是同一个时机**——晚一步就会被上面刚落的结局盖住。
    if ((branch || isAskBeforeRun(node.id)) && outcome.status === "success") {
      const back = pendingLoopBack;
      pendingLoopBack = null;
      if (back !== null) {
        rewindLoop(node.id, back);
        // 抹环改的是"谁跑过了",那是别人重跑与否的依据 —— 得立刻写出去。
        publish();
        return;
      }
    }
    // **分支节点选完之后不再补一张结果卡。** 它的卡片就是那张选择卡,而且上面已经
    // 写着"你选了 X"了(见 `@contracts/runtime` 的 `WorkflowNodeChoiceEvent`)——
    // 再发一张的话,同一个节点在对话里会出现两张卡,其中一张是空的。
    //
    // 这里只管"选成功了"那一种:失败(没有出路 / 选了个不存在的)和 unselected
    // 都**照常发卡** —— 那几种情况下用户需要知道这一步出了什么事。
    if (branch && outcome.status === "success") {
      publish();
      return;
    }
    // 记进流程记录。**只有成功才记** —— 失败、没走这条路、取消都没有"产出"可言,记一条
    // 空的会让后面的助手以为这一步做过并交了东西。(跑过、但确实没交出文本的**要**记,
    // 那一条在 `flowRecordSection` 里会写成"(这一步没有产出文本)"。)
    if (outcome.status === "success") appendStep(node, outcome);
    ports.report({ kind: "node.settled", node, outcome });
    publish();
  };

  /**
   * 上游结果拼成的一段。按依赖顺序,只取**成功且有话说**的那些。
   *
   * `referenced` 里点过名的上游**跳过**。理由见 `referencedNodeNamesIn` 的文件头:
   * 那几步的产出已经被变量引用定点取进指令里了,再整段拼一遍的话,同一份内容会以
   * **两种形状**(干净的值 + 原始全文)在同一段提示词里出现两遍 —— 白烧一截 token,
   * 还让模型得自己判断"这两份是不是一回事"。
   *
   * 这是**互斥的两种取法**,不是"两个都有":点名了就是"我要这个",没点名才是默认整段给。
   */
  const upstreamTextOf = (node: WorkflowNode, referenced: ReadonlySet<string>): string => {
    const parts: string[] = [];
    for (const up of deps.get(node.id) ?? []) {
      if (referenced.has(up)) continue;
      const upTitle = storedTitleOf.get(up) ?? "";
      if (upTitle.length > 0 && referenced.has(upTitle)) continue;
      const outcome = outcomes.get(up);
      if (outcome?.status !== "success") continue;
      const summary = outcome.summary.trim();
      if (summary.length === 0) continue;
      parts.push(labelUpstreamText(up, summary));
    }
    return parts.join("\n\n");
  };

  /**
   * 问用户这一处岔路口怎么走 —— **连同"停下来了"这个事实一起写出去**。
   *
   * ## 为什么落盘要发生在**问之前**
   *
   * 因为用户可能**永远不回答**:他去吃饭了、去睡了、直接把应用关了。"这次运行正停在
   * 哪几格"是重启之后唯一能把那次点击接回来的东西(见 `WorkflowRunRepo.resumableFor`),
   * 而它只在**等待期间**成立 —— 问完、拿到答案,那一格就从 `awaiting` 里出去了。
   *
   * 所以顺序不能反:先把状态写出去,再挂起。
   *
   * ## 手里已经有答案时
   *
   * 续跑时用户刚在旧卡片上点过(见 {@link RunResume.answer})—— 那就不必**停**在这儿,
   * 但**照样要走端口那一次调用**:端口除了"问",还负责把"你选了 X"补到界面上那张卡
   * (见 `RunPorts.choose` 的 `preset`)。在调度器这一层把它拦下来的话,那张卡会永远
   * 停在按钮状态,而用户明明已经点过了。
   *
   * 所以这里只少做两件事:不进 `awaiting`、不落盘(状态没变)。答案**用完即弃** ——
   * 回头之后同一个岔路口要重新问,而那时用户要面对的是新一轮,不是这一下。
   */
  const askUser = async (
    node: WorkflowNode,
    options: WorkflowChoiceOption[],
  ): Promise<BranchChoice> => {
    const preset = presetChoices.get(node.id);
    presetChoices.delete(node.id);
    if (preset === undefined) {
      awaiting.add(node.id);
      publish();
    }
    const pick = await ports.choose(node, options, signal, preset);
    awaiting.delete(node.id);
    return pick;
  };

  /**
   * 分支节点:把决定权交给用户。
   *
   * 它**不建会话、不烧 token** —— 只是让这次运行停在这儿。选完之后 `chosen` 里有它,
   * 上下游的活性判断(见 `edgeLive`)从此按那一条算。
   *
   * ## 没有出路是**坏图**,要明确失败
   *
   * 一个岔路口一根线都没有,图会永远停在那儿,而用户看到的只是一张没有按钮的卡片 ——
   * 那种"什么都不发生"最难查。所以直接失败,并在话里说清怎么修。
   */
  const chooseOne = async (node: WorkflowNode): Promise<NodeOutcome> => {
    const options = branchOptionsOf(node.id);
    if (options.length === 0) {
      return {
        status: "failed",
        summary: "",
        error: "这是个分支节点,但一根出路都没有 —— 从它往下一步拉几根线,每根线就是一个选项",
      };
    }
    const pick = await askUser(node, options);
    // 取消和"选完了"都会让上面那个 promise 落地(端口那一头必须保证这件事),
    // 所以先看取消 —— 取消时那个 `pick` 是没有意义的。
    if (signal.aborted) return cancelled();
    // 「**就到这儿**」(见 `BRANCH_STOP_CHOICE`)。它是界面给的,不是图上的一条边 ——
    // 所以它不在 `options` 里,要单独放行。
    //
    // 放行之后**什么都不用做**:`chosen` 里存的是一个谁也匹配不上的 id,于是这个分支的
    // **每一条出边都判死**,下游整片标 `unselected`,这次运行自然收场(没有节点可派发
    // 了,调度循环就退出来了)。不去特判"停"这个状态 —— 特判就有第二种收场方式,而
    // 两种收场方式迟早会长得不一样。
    const stopped = pick.edgeId === BRANCH_STOP_CHOICE;
    if (!stopped && !options.some((o) => o.id === pick.edgeId)) {
      return { status: "failed", summary: "", error: "选的那条出路不在这个分支上" };
    }
    chosen.set(node.id, pick);
    // 另外存一份**不跟着回卷清掉**的 —— 环体重跑时,"这一步是从哪条路来的"还要说得出
    // 来(见 `arrivalOf`)。
    lastPick.set(node.id, pick);
    // **用户这次的决定进流程记录。** 它不在任何一步的产出里,而"用户先后要求过什么"
    // 恰恰是迭代型流程里最值钱的信息 —— 少了它,第三轮的写作只看得见第二版稿子,却不
    // 知道第一轮为什么被否掉。见 `FlowRecordEntry` 的 `user` 那一支。
    //
    // 与"每一步只留最新一版"不同:**历次决定一条都不删**。它们是历史,而历史正是迭代
    // 里唯一不会过期的部分。
    //
    // 「就到这儿」(以及取消)没有对应的出路,**不记** —— 那次运行到此为止,没有下一个
    // 助手会读到它。
    const picked = options.find((o) => o.id === pick.edgeId);
    if (picked !== undefined) {
      record.push({
        kind: "user",
        from: titleOf(node.id),
        label: picked.label,
        note: (picked.note ?? "").trim(),
        comment: (pick.comment ?? "").trim(),
      });
    }
    // **回头**:选的这条指回前面。环体由 `settle` 在落定之后抹(见那里和 `rewindLoop`
    // 的注释 —— 抹早了会被刚落的结局盖回去)。
    if (loopBackIds.has(pick.edgeId)) pendingLoopBack = pick.edgeId;
    // ## 它是**透传**的:岔路口不换你手上的行李
    //
    // 产出 = 上游那几步的结果拼起来那一段。**这不是可有可无的** —— 它是分支下游
    // 唯一能看见上游内容的通路。
    //
    // 为什么:一个节点的就绪判断看的是"**有效上游**全都成功",而分支的**没被选中的
    // 出边是死的**。所以分支下游那一步**只能连分支**(再连一条别的上游,那条边是活的,
    // 这一步就会不管选哪条路都照跑 —— 见 `effectiveUpstreamOf`)。
    //
    // 于是不给这条通路的话,「再改一轮」那一步就得**凭一句话重写一篇它没读过的稿子**。
    // 把内容挂在分支上透传过去,分叉就只是"换条路",不是"把东西丢了"。
    return { status: "success", summary: carriedTextOf(node.id) };
  };

  /**
   * **跑这一步之前先问用户一句** —— 节点上开了「运行前先问我」才有这一次。
   *
   * ## 四个选项是代码给的,不是图上的边
   *
   * 和 {@link chooseOne} 最像,也最不一样:那边选项就是出边,这边选项是**固定的四条**
   * (见 `@contracts/nodeType` 的 `ASK_CHOICES`)。它们进同一套挂起 / 落盘 / 续跑的机器
   * —— `askUser` 只认"几个选项 + 一个可选补充",不关心选项打哪儿来。
   *
   * ## 返回值为什么是个联合
   *
   * - `{ outcome }`:这一问已经把节点定案了(跳过 / 退出 / 去重跑上一步),调用方直接拿它
   *   当结局,不必再往下跑。
   * - `{ answer }`:照常跑这一步,而用户在框里补的那句话要接进提示词(见 {@link askSection})。
   */
  const askOne = async (
    node: WorkflowNode,
  ): Promise<{ outcome: NodeOutcome } | { answer: AskAnswer }> => {
    const options = askOptionsOf(node);
    const pick = await askUser(node, options);
    if (signal.aborted) return { outcome: cancelled() };
    // 「**就到这儿**」(见 `BRANCH_STOP_CHOICE`)。聊天流里那张卡也摆着这个按钮 ——
    // 它是**每个等待处通用**的一条出路,不因为这一问换了种问法就消失。在这一问里它
    // 就是"退出流程,但不留话"(带不带那句话的区别而已)。
    if (pick.edgeId === BRANCH_STOP_CHOICE) {
      return { outcome: unselected("你退出了这次流程") };
    }
    if (!isAskChoice(pick.edgeId)) {
      return {
        outcome: { status: "failed", summary: "", error: "选的那一项不在这一次的选项里" },
      };
    }
    const comment = (pick.comment ?? "").trim();
    const label = options.find((o) => o.id === pick.edgeId)?.label ?? "";

    // **跳过**:这一步不跑,但不是因为它坏了。标 `unselected` 而不是 `skipped`,是
    // 刻意的 —— 两者对下游的传播完全不同:"没走这条路"会被下游的汇合点忽略掉,而
    // "上游失败了"会把下游一起拖死(`effectiveUpstreamOf` / 主循环第 1 步)。
    if (pick.edgeId === ASK_SKIP_CHOICE) return { outcome: unselected("你选择跳过这一步") };

    // **退出流程**:走的是和"跳过"同一套传播 —— 下游整片标 `unselected`,没有可以派发
    // 的节点了,调度循环自然收场。**不特判"停"这个状态**(和分支的「就到这儿」同一条
    // 理由:特判就有第二种收场方式,而两种迟早会长得不一样)。
    //
    // 用户填的那段字怎么发进主对话**不在这里** —— 调度器碰不到运行时,那一步在
    // `runner.ts` 的 `choose` 端口里顺手接走(见那里的 `ASK_EXIT_CHOICE`)。
    if (pick.edgeId === ASK_EXIT_CHOICE) return { outcome: unselected("你退出了这次流程") };

    // **重复上一个任务**。
    if (pick.edgeId === ASK_REPEAT_CHOICE) {
      // ★ **先把用户这句话记进流程记录。** 重跑的那一步要靠它知道"哪里不对" ——
      // 不记的话,用户写的那段字会**当着面丢掉**:它既不在任何一步的产出里,也不在
      // 提问的那张卡之后(那张卡属于这个节点,而重跑的是上游)。
      //
      // 记在 `record` 而不是挂在哪个节点上,是因为"用户先后要求过什么"本来就是这一节
      // 存在的理由(同 `chooseOne` 里那条)。
      record.push({
        kind: "user",
        from: titleOf(node.id),
        label,
        note: "",
        comment,
      });
      // 被作废重跑的那些节点,**这一轮起按"在环上"对待** —— 环上的步骤默认读流程记录
      // (见 `readsRecord`),而它们恰恰最需要看见刚记下的那一条。
      //
      // 这张图里其实没有环(这个选项不是画出来的边),所以那个默认值补不上,得在这里
      // 显式加。只加这一次,之后节点上要是明确关掉了读记录,照样以它为准。
      for (const up of effectiveUpstreamOf(node.id)) {
        onLoop.add(up);
        for (const d of forwardDescendantsOf(up)) onLoop.add(d);
      }
      // 抹的时机交给 `settle`(见那里的注释:抹早了会被刚落的结局盖回去)。
      // 这里返回的结局只是"落一下再抹掉"的过场,`summary` 沿用岔路口那套透传。
      pendingLoopBack = ASK_REPEAT_CHOICE;
      return { outcome: { status: "success", summary: carriedTextOf(node.id) } };
    }

    // **用这一步的指令**:补的那句话进提示词,照常跑。
    return { answer: { label, comment } };
  };

  /**
   * 「运行前先问我」那四条的文案。
   *
   * **没有上游就不给"重复上一个任务"** —— "上一步"根本不存在,摆一个点了会失败的
   * 按钮比不摆更糟。其余三条任何情况下都成立。
   */
  const askOptionsOf = (node: WorkflowNode): WorkflowChoiceOption[] => {
    const ups = effectiveUpstreamOf(node.id);
    return [
      {
        id: ASK_RUN_CHOICE,
        label: "用这一步的指令",
        input: "还想补充什么?可以留空",
        next: "照常跑这一步",
      },
      { id: ASK_SKIP_CHOICE, label: "跳过", next: "这一步不跑,直接进下一个节点" },
      ...(ups.length > 0
        ? [
            {
              id: ASK_REPEAT_CHOICE,
              label: "重复上一个任务",
              input: "哪里不对?说清楚要改什么",
              next: `重跑「${ups.map((id) => titleOf(id)).join("、")}」,跑完回到这一步再问你`,
            },
          ]
        : []),
      {
        id: ASK_EXIT_CHOICE,
        label: "退出流程",
        input: "退出之后想说什么?这段会发进主对话",
        next: "这次流程到此为止",
      },
    ];
  };

  const executeOne = async (node: WorkflowNode): Promise<NodeOutcome> => {
    // ⚠️ **整个函数体在 try 里**,不只是 `ports.execute` 那一段。取清单、校验参数
    // 都可能抛(清单文件读坏了、宿主实现有 bug),而**一个抛出去的节点不会定案** ——
    // 调度器会把它当成"还没跑"再派发一次,那就是死循环。
    try {
      if (signal.aborted) return cancelled();
      // 类型没装 / 执行方式没实现 / 参数不齐 —— 三种都**明确失败**,不静默跳过
      // (见 `@contracts/nodeType` 的 `isRunnerImplemented` 注释)。
      // 清单是开跑前取的,取不到有两种,话要分开说:**没装这个类型**(别人分享来的图)
      // 和**清单文件坏了**(读的时候抛了)。
      const slot = manifests.get(node.type);
      if (slot?.error !== undefined) {
        return { status: "failed", summary: "", error: slot.error };
      }
      const manifest = slot?.manifest;
      if (!manifest) {
        return { status: "failed", summary: "", error: `节点类型「${node.type}」没有安装` };
      }
      if (!isRunnerImplemented(manifest.runner.kind)) {
        return {
          status: "failed",
          summary: "",
          error: `执行方式「${manifest.runner.kind}」还没有实现`,
        };
      }
      // **分支走另一条路**:它没有参数要验(选项在边上,见 `WorkflowEdgeSchema`)、
      // 没有产出要查、也不建会话。放在参数校验前面,是因为那一整段对它都不成立。
      if (manifest.runner.kind === "branch") return await chooseOne(node);
      // **解算前再校验一次**:清单可能在这份文档存盘之后改过,老节点身上还带着
      // 旧参数(见 `validateNodeParams` 的注释)。
      const check = validateNodeParams(manifest, node.params);
      if (!check.ok) return { status: "failed", summary: "", error: check.error };
      // 产出约束本身有没有矛盾(选了数组又填必备字段……)。**和上面那条一样,在派发
      // 之前查**:矛盾的配置不会报错,它只会让某一步跑完之后以一个看不懂的理由失败。
      const rulesCheck = validateOutputRules(manifest, node.params);
      if (!rulesCheck.ok) return { status: "failed", summary: "", error: rulesCheck.error };
      if (signal.aborted) return cancelled();

      // **开了「运行前先问我」的对话节点:先问一句,再决定要不要跑、怎么跑。**
      //
      // 位置选在**参数校验之后**:一个参数填错的节点该直接骂它填错了,而不是先把用户
      // 拽过来问一遍"要不要跳过"—— 那个问题对一张配坏了的图没有意义。
      //
      // 问出来的四种回答见 `askOne`。只有"用这一步的指令"会落回下面这条路,其余的
      // 都在那里直接定案了。
      let askAnswer: AskAnswer | undefined;
      if (manifest.runner.kind === "conversation" && askBeforeRunOf(node.params)) {
        const asked = await askOne(node);
        if ("outcome" in asked) return asked.outcome;
        askAnswer = asked.answer;
        if (signal.aborted) return cancelled();
      }

      // 这一步能引用什么。**每次派发时现算** —— 上游的结局和参数在这之前才刚定下来
      // (同一列里别的节点可能还在跑),提前算会拿到半张图。
      const scope: NodeTemplateScope = {
        user: prompt,
        upstream: upstreamNames(deps, titleOf, node.id),
        nodes: doc.nodes.map((n) => {
          const outcome = outcomes.get(n.id);
          return {
            id: n.id,
            title: n.title,
            params: n.params,
            ...(outcome ? { outcome } : {}),
          };
        }),
      };

      // 先解变量,后面每一步都看解算后的参数 —— 技能名、上下文类目、产出约束都可能
      // 写在变量里(虽然少见),而"哪几个参数是解算过的"如果有两种答案,迟早分家。
      // 解不出来会抛,由下面那层的 catch 兜成这个节点的失败。
      // **引用要在解算前扫**(见 `referencedNodeNames`),解算完就看不出引过谁了。
      const referenced = referencedNodeNames(node);
      const params = expandParams(node, manifest, scope);

      // 这一步是不是**终末**(没有下游)。它决定两件事:产出变量表发不发(见
      // {@link withOutputCheck})和产出要不要按变量表查。**和 `planSection` 用的是
      // 同一个 `isLast`** —— 提示词里说的"你是最后一步"和这里的行为必须是一回事。
      const terminal = findStep(plan, node.id)?.isLast === true;
      // 它是从哪条出路来的。**每次派发时现算** —— 用户可能刚在上一轮选完,而
      // `chosen` 是在那之后才写进去的。
      const arrival = arrivalOf(node.id);
      // **这一步读不读整条流程的记录**(见 `readsRecord`)。读的话,记录**替代**「上游
      // 步骤的产出」—— 记录里本来就含着上游那几段;而"用户刚才选了什么"也已经作为一条
      // 记录躺在日志里了,所以那一段 `arrival` 也一并省掉(见 `composeNodePrompt`)。
      //
      // **在派发这一刻现算**,不是开跑前算一次:记录是随着别的节点跑完长出来的,而这个
      // 节点可能是在循环的第二圈才被派发的 —— 那一刻它该看到的东西比第一圈多。
      const flowRecord = readsRecord(node)
        ? flowRecordSection({
            name: doc.name,
            description: doc.description ?? "",
            userPrompt: prompt,
            entries: record,
          })
        : undefined;

      const outcome = await ports.execute(
        node,
        manifest,
        nodeInputOf(
          params,
          manifest,
          {
            userPrompt: prompt,
            upstream: upstreamTextOf(node, referenced),
            nodeId: node.id,
            plan,
            terminal,
            ...(arrival ? { arrival } : {}),
            ...(flowRecord !== undefined ? { record: flowRecord } : {}),
            // 「运行前先问我」那一次的回答。**渲染在这儿而不是 `composeNodePrompt` 里**,
            // 是因为那一段要用节点的标题,而标题只有这一层有(`titleOf`)。
            ...(askAnswer !== undefined
              ? { ask: askSection(titleOf(node.id), askAnswer) }
              : {}),
            contextLines: ports.contextLines,
          },
          signal,
        ),
      );
      // 产出回来,按**同一份**参数查硬约束。
      return withOutputCheck(manifest, params, outcome, terminal);
    } catch (err) {
      // 执行器自己抛了 = 这个节点失败。**不往上抛** —— 一个节点炸掉不该让整张图
      // 停摆,它的下游会因为依赖不满足而跳过。
      return { status: "failed", summary: "", error: (err as Error).message };
    }
  };

  const start = (node: WorkflowNode): void => {
    ports.report({ kind: "node.started", node });
    const run = (async (): Promise<void> => {
      try {
        settle(node, await executeOne(node));
      } catch (err) {
        // 上面两层都不该抛;真抛了也必须**留下一个结局** —— 没定案的节点会被调度器
        // 当成"还没跑"重新派发。这里只补一个失败的结局,不改变已经定下的那个。
        if (!outcomes.has(node.id)) {
          settle(node, { status: "failed", summary: "", error: (err as Error).message });
        }
      } finally {
        inflight.delete(node.id);
      }
    })();
    inflight.set(node.id, run);
  };

  for (;;) {
    if (signal.aborted) break;

    // 1. 把**走不到**的标掉。两种:来路被别的选择挡掉了(`unselected`),或者上游真的
    //    失败了(`skipped`)。**每轮都要重扫** —— 标掉一步可能让它的下游也走不到,而
    //    那是下一轮的事。
    let moved = false;
    for (const node of doc.nodes) {
      if (outcomes.has(node.id) || inflight.has(node.id)) continue;
      const all = deps.get(node.id) ?? [];
      if (all.length === 0) continue; // 根节点没有"来路"可言,永远走得到。
      // **一条有效来路都没有** = 这一步不在用户走的那条路上。两种来源在这里合流了:
      // 边被分支挡掉了,或者来路上的那个节点自己就没走(见 `effectiveUpstreamOf`)。
      const effective = effectiveUpstreamOf(node.id);
      if (effective.length === 0) {
        const cutBy = cutByOf(node.id);
        settle(
          node,
          unselected(
            cutBy.length > 0
              ? `「${cutBy.join("、")}」没有选中这条路`
              : "来路都没有走这条路",
          ),
        );
        moved = true;
        continue;
      }
      // **还有有效上游没定案就不能下结论**:它可能成功,那这一步就该跑。
      const settled = effective.filter((up) => outcomes.has(up));
      if (settled.length < effective.length) continue;
      // 走到这里说明**有效上游全都定案了、而且至少有一个不是成功**。剩下那种"全是
      // `unselected`"的情况上面已经被 `effective.length === 0` 拦掉了 —— 所以这里是
      // 实实在在的失败,不是"没走"。
      const broken = settled.filter((up) => outcomes.get(up)?.status !== "success");
      if (broken.length === 0) continue;
      settle(node, {
        status: "skipped",
        summary: "",
        error: `上游「${titleOf(broken[0] as string)}」没有成功`,
      });
      moved = true;
    }

    // 2. 就绪即派发。**看的是有效上游** —— 没走的那条路不算数,于是"没走"不会把下游的
    //    汇合点也拖下水(那是 `unselected` 和 `skipped` 最要紧的差别)。
    //
    // **到了并发上限就停手,剩下的下一轮再说。** 这一步是这张图花钱最多的地方:每个
    // 节点是一个独立的隐藏会话 + 一个 CLI 子进程 + 一路模型请求,而这些请求**同时**
    // 打出去。一张 20 个并列节点的图不限并发就是 20 路一起烧 —— 所以这里要有个闸。
    //
    // 排队**不是失败**:主循环是 `for(;;)` 重扫,任何一个在飞的节点一收场,这一轮又会
    // 从 `doc.nodes` 开头重新扫一遍,没轮到的自然被派出去。顺序是文档顺序,所以"谁先
    // 轮上"是确定的(不是随机的),用户看到的是"按图的先后一批一批来"。
    //
    // ⚠️ **每次派发现读** `maxParallel()` —— 用户可能正开着设置页把它改小。读到的若是
    // 个非法值(0 / 负数 / NaN),退回"不限":宁可多花钱,也不要让图**卡死在那儿**
    // (上限为 0 的话一个节点都派不出去,而循环会因为 `inflight` 空 + 没有东西可动而
    // 直接退出,现象是"点了运行,什么都没发生")。
    const limit = ports.maxParallel?.() ?? Infinity;
    const cap = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : Infinity;
    for (const node of doc.nodes) {
      if (inflight.size >= cap) break;
      if (outcomes.has(node.id) || inflight.has(node.id)) continue;
      const effective = effectiveUpstreamOf(node.id);
      if (effective.every((up) => outcomes.get(up)?.status === "success")) start(node);
    }

    if (inflight.size > 0) {
      // 等**任意一个**落地再重扫 —— 不是等这一批全跑完。差一个慢节点不该拖住
      // 它下游那条链的开始时间。
      await Promise.race(inflight.values());
      continue;
    }
    if (!moved) break;
  }

  // 取消之后在飞的那几个也要等回来:它们会带着 cancelled 收场(执行器收到 signal
  // 之后应当尽快停),不等的话它们的结果会晚于 `RunResult` 落到 `outcomes` 上。
  while (inflight.size > 0) await Promise.race(inflight.values());

  // 剩下的两种可能:被取消了,或者图里有环(那些节点永远等不到依赖就绪)。
  // 后者不该出现(`validateDag` 在存盘时就拦了),但真出现了要**说出来**而不是
  // 让它们永远停在"没跑"上。
  for (const node of doc.nodes) {
    if (outcomes.has(node.id)) continue;
    settle(node, cancelledOrStuck(signal.aborted));
  }

  const list = [...outcomes.values()];
  const status = signal.aborted
    ? "cancelled"
    : list.some((o) => o.status === "failed")
      ? "failed"
      : "success";
  // **收尾这一下也要写出去。** 它把 `awaiting` 收成 `null`(上一句已经把它清了)、
  // 把最后一次抹环/定案的结果带上 —— 少了它,最后一次变动只活在内存里,而进程随时
  // 可能死。横竖只有一次,便宜。
  publish();
  return { status, outcomes, state: stateOf() };
}

function cancelled(): NodeOutcome {
  return { status: "cancelled", summary: "", error: "运行被取消" };
}

/**
 * **没走这条路。** 和 `skipped` 是两句不同的话 —— 见 `@contracts/nodeType` 的
 * `NodeOutcomeStatus`:`skipped` 是"上游炸了",`unselected` 是"用户在岔路口选了别的路"。
 *
 * 混起来的代价是**一句错的原因**:用户自己选的路,卡片却告诉他某一步失败了,他会去翻
 * 一个根本没跑的节点的日志,而那里什么也没有。
 */
function unselected(error: string): NodeOutcome {
  return { status: "unselected", summary: "", error };
}

/** 还没派发任何东西就被取消了(取清单那几秒里用户按了停止)。没有任何节点定案,
 *  所以不返回 `outcomes` —— 一个都没跑,也就没有卡片要收。 */
function cancelledRun(state: RunState): RunResult {
  return { status: "cancelled", outcomes: new Map(), state };
}

function cancelledOrStuck(aborted: boolean): NodeOutcome {
  return aborted
    ? cancelled()
    : { status: "skipped", summary: "", error: "依赖没有满足(图里是不是有环?)" };
}

/**
 * 一个 `runner.kind === "prompt"` 的节点,这一轮要执行的指令从哪个参数来。
 *
 * 约定是 `instruction` 这个键(见 `@contracts/nodeType` 的 `NODE_PROMPT_PARAM_KEY`)。
 * **拿不到就明确失败** —— 一个提示词节点没有提示词,跑它没有意义,而"跑了个空的"
 * 比"报错说清楚"难查一百倍。
 *
 * (内置的 `mcode.agent` 把 `instruction` 声明成必填,所以正常路径下
 * `validateNodeParams` 会先一步拦下;这里兜的是"清单没把它标成必填"的那种清单。)
 */
function instructionOf(params: Record<string, unknown>, manifest: NodeTypeManifest): string {
  const value = params[NODE_PROMPT_PARAM_KEY];
  if (typeof value === "string" && value.trim().length > 0) return value;
  throw new Error(
    `节点类型「${manifest.id}」没有填「${NODE_PROMPT_PARAM_KEY}」参数 —— 提示词节点必须有指令`,
  );
}
