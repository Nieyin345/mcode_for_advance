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
  askBeforeRunOf,
  flowRecordOf,
  isAskChoice,
  isModelDecider,
  isNodeRunnable,
  validateNodeParams,
  type NodeContextKind,
  type NodeOutcome,
  type NodeTypeManifest,
} from "@contracts/nodeType";
import {
  buildForwardAdjacency,
  edgeOptionNameOf,
  isLoopGateNode,
  loopBackEdgesOf,
  nodesOnLoopOf,
  outgoingEdgesOf,
  upstreamClosure,
  workflowNodeRefName,
  type WorkflowDoc,
  type WorkflowEdge,
  type WorkflowNode,
} from "@contracts/workflow";
import { referencedNodeNamesIn, renderTemplate, type NodeTemplateScope } from "@contracts/nodeTemplate";
import type { NodeRunInput as ContractNodeRunInput, WorkflowChoiceOption } from "@contracts/runtime";
export type NodeRunInput = ContractNodeRunInput & { signal: AbortSignal };
import {
  DECIDE_OUTPUT_VAR,
  DECIDE_VAR_NAME,
  checkOutput,
  matchDecisionOption,
  outputValueText,
  type OutputCheck,
  type OutputVar,
  outputVarsOf,
  pickOutputs,
  validateOutputRules,
} from "@contracts/outputConstraint";
// 能力预检(G4/CAP):解析逻辑与诊断文案全部来自 contracts(`@contracts/capability`),
// 需求推导与清单装配的翻译在 `capabilityResolver.ts`(纯函数,可冒烟)。调度器只做
// "派发前对一对"这一件事,不发明第二套判定 —— 见 `capabilityResolver.ts` 文件头。
import { describeCapabilityProblems, type CapabilityDescriptor } from "@contracts/capability";
import { checkNodeCapabilities, requirementsForNode } from "./capabilityResolver.js";
// 资料行的**形状**来自 `contextInherit`(它是认类目那一端):端口把它原样交进来,
// 怎么摆是 `schedulerPrompt.ts` 的事 —— 调度器不碰库,也不需要知道"哪个 id 属于
// 哪一类"是怎么查出来的。
import type { ContextLine } from "./contextInherit.js";

// 提示词这一层拆去了 `schedulerPrompt.ts`(给模型看的东西怎么拼:计划、上游、记录、
// 资料分组)。这里只剩"什么时候需要一份提示词"。依赖保持单向:scheduler →
// schedulerPrompt,反方向不允许 —— 那正是原来两件事挤一个文件里的根源。
import {
  askSection,
  findStep,
  flowRecordSection,
  isRootOf,
  planOf,
  recordBodyOf,
  type WorkflowPlan,
  type Arrival,
  type AskAnswer,
  type FlowRecordEntry,
} from "./schedulerPrompt.js";
// 参数 → `NodeRunInput` 的最后一次翻译在 `nodeInputBuilders.ts`(专用 builder 走
// 注册表,其余落默认的模型轮构造)。调度器只负责在派发那一刻把**运行期上下文**
// (上游结局、用户选择、流程记录)算出来递过去 —— 那些东西只有这一层知道。
import { buildNodeInput } from "./nodeInputBuilders.js";

/* ────────────────────────── 端口 ────────────────────────── */

/**
 * 失败重试时,`askSection` 里那个"用户选了哪一项"的占位标签。
 *
 * 重试没有"在选项里挑一条"这回事 —— 它是用户在失败卡片上按了一个按钮。但
 * `askSection` 的形态(`轮到「X」时,用户选择的是「Y」`)正是我们要说的那句话,
 * 所以给它一个诚实的标签,而不是为此另写一段渲染。
 *
 * 只有**用户写了说明**时这段才会出现(见 `retryNote`):没写说明就没有信息要传达,
 * 提示词里多一句"用户选择的是「再试一次」"只是噪音。
 */
const RETRY_ANSWER_LABEL = "再试一次";

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
  /**
   * 这台机器的**能力清单**(G4/CAP):providers / 已启用插件 / 经 Executor Registry
   * 派发的 executor kinds,由调用方装配好递进来(调度器不认识注册表,与
   * {@link RunPorts.manifestOf} 同一个理由)。做成返回 `Promise` 是因为清单里有
   * 异步来源;返回 `undefined` = **这次跳过预检** —— 端口没给(冒烟脚本的假端口)
   * 或装配失败的那次运行,都不该被预检挡住。
   */
  capabilityInventory?(): Promise<CapabilityPreflight | undefined>;
}

/**
 * 一次能力预检要的两样。`executorKinds` 是"哪些 runner.kind 真的会经 Executor
 * Registry 派发" —— `requirementsForNode` 只给这些 kind 加 executor 需求(prompt /
 * branch / trigger 走的是会话或不跑东西,给它们凭空加执行器需求只会制造假阳性)。
 */
export interface CapabilityPreflight {
  inventory: CapabilityDescriptor[];
  executorKinds: readonly string[];
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
  /**
   * 这次运行**是哪个触发器起的**(见 `runWorkflow` 的 `entry`)。没有就是没有 —— 比如
   * 用户在对话里手动跑的一张图。
   *
   * 它必须落盘:续跑时"这次是哪一条自动化入口起的"仍然成立(触发器节点自己在
   * `outcomes` 里睡着,其余触发器该标 `unselected` 还是照标)。
   *
   * `payload` 是触发器载荷的**事实键值**(G3/VAR-06,键来自 `payloadFactsOf`):
   * 调度器把它递进每个节点的 `data.trigger`,节点参数里的 `{{trigger.<key>}}` 从
   * 这里取。它跟着 entry 一起落盘,续跑时变量才解得出来。
   */
  entry?: { nodeId: string; summary: string; payload?: Record<string, unknown> };
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
  /**
   * **要抹掉重跑的节点** —— 失败那一步,以及它的全部前进后代。
   *
   * ## 为什么是闭包,不是那一步
   *
   * 失败运行落盘的 `outcomes` 是**整张图的完整结局表**:失败那步是 `failed`,它的
   * 下游是 `skipped`(失败会往下传)。`settled` 把它们**全部**灌回来,于是下游留着一个
   * 旧的 `skipped` —— 它既不会被重新派发(`settle` 看到"已经有结局了"),又拿不到新
   * 上游。那是静默不一致:界面上那张卡永远停在"跳过",而没有任何地方说得出为什么。
   *
   * 所以摘的是整个闭包。**展开由调度器自己做**(`voidClosureOf`)—— 它是唯一知道
   * "谁是谁的后代"的地方,调用方只该给出"从哪一步开始重跑"。
   *
   * ## 不给就是老行为
   *
   * 岔路口续跑(`answer`)那条路不带这个字段:它要的是"接着上次跑",不是"重跑一段"。
   * 缺省 = 什么都不抹 —— 与加这个字段之前逐字一致。
   */
  rewind?: readonly string[];
  /**
   * **只给某一步看的一段话** —— 用户写「上次哪里不对」。
   *
   * 重试那一步重跑时,它的提示词是 `instruction` + 上游产出,**用户写的这句话两处
   * 都不在**。所以显式接一条:渲染成「本次执行的前置选择」那一段(与
   * `RunResume.answer` 那一路共用 `askSection`)—— 对模型来说它们说的是同一件事:
   * "用户在这次执行之前拍过一个板"。
   *
   * `nodeId` 不匹配的任何步骤都看不到它:它是**这一步的**说明,不是全局指令。
   */
  note?: { nodeId: string; text: string };
  /** 上次是哪条触发器起的(见 {@link RunState.entry},含 `payload`)。存档里有就以它为准。 */
  entry?: { nodeId: string; summary: string; payload?: Record<string, unknown> };
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
  /**
   * 这一步定案了。`round` 是**它在这次运行里跑过的第几轮**(1 起,见
   * `WorkflowNodeResultEvent.round`)—— 调度器是**唯一**知道这件事的地方
   * (`rounds` 在它的闭包里),不交出来的话渲染端只能靠"同一格又收场了"去猜,
   * 而"同一格收场两次"在续跑、重试、补花费那几条路上都会发生。
   */
  | { kind: "node.settled"; node: WorkflowNode; outcome: NodeOutcome; round: number };

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
 *
 * ⚠️ **`{{trigger.*}}` 由 `renderTemplate` 一次解掉**(2026-09-20),这里不再先跑一遍
 * `expandTriggerVars`。从前是两个展开器接力,**同一个字符串里两种名字空间混着写就废了**:
 * 第一个只认 `{{trigger.*}}`、认不出 `{{检索.年份}}` 所以原样交出去,第二个再把
 * `{{trigger.at}}` 当节点名报「引用不到」。各自都对,拼在一起是一个用不了的写法,
 * 而用户写 `"上游是 {{检索.年份}},这次是 {{trigger.at}} 触发的"` 再自然不过。
 * 载荷进 `scope.trigger`,解算与报错都只有一份实现。
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

/* 节点参数 → `NodeRunInput` 的最后一次翻译在 `nodeInputBuilders.ts`(`buildNodeInput`):
 * 专用 builder(code/command…)走注册表,其余落默认的模型轮构造。上面解算好的
 * `params` 原样递过去 —— 产出回来之后 `withOutputCheck` 查的还是这同一份值。 */

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

  const checked = checkOutputFrom(outcome, vars);
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

/**
 * 按变量表查这一步的产出 —— **原文与运行时产出两处都算命中**。
 *
 * ## 为什么要看 `outcome.outputs`(2026-09-20)
 *
 * 原来只 `checkOutput(outcome.summary, vars)`,而这是**假设了产出一定长在原文里**。
 * 那个假设对模型节点成立(它就交一段文本),对**命令节点不成立**:它的清单把
 * `@@mcode:result` 写成脚本上报结构化产出的正式办法,协议里的 `outputs` 字段就是放
 * 结构化产出的地方,`commandRunner` 也确实把它解到了 `outcome.outputs` 上 ——
 * **可校验读的是 `summary`,读不到**。
 *
 * 结果是**照文档做的脚本反而翻车**:只用协议、值落在 `outputs` 上 → 这一步被自己的
 * 产出表判失败,而把同一个值再 `JSON.stringify` 一遍塞进 `summary` 反而就好了。
 * 差别只在字段落在哪,不在命令做没做对。
 *
 * ## 为什么在这里判、不在执行器里判
 *
 * `vars` 只有调度器手上有(`withOutputCheck` 的入参就是它)。执行器不知道用户要什么,
 * 让它去猜"我这次该不该填 summary"只会把同一条规矩拆成两份。而且这一条对**所有**
 * 执行器都成立:谁往 `outcome.outputs` 里填了齐的那几样,谁就交差了。
 *
 * ## 齐了就不再解析原文
 *
 * `value: undefined` 是刻意的 —— 调用方看到它就**原样返回 outcome**(见上面那句
 * `if (checked.value === undefined) return outcome`)。运行时已经填好的值不该被
 * `pickOutputs` 拿原文里的同名键盖掉:那些值可能来自协议(python 脚本算的),而原文里
 * 那一段可能只是同一个东西的另一种写法。
 */
function checkOutputFrom(outcome: NodeOutcome, vars: readonly OutputVar[]): OutputCheck {
  const outputs = outcome.outputs;
  if (outputs !== undefined && vars.every((v) => v.name in outputs)) {
    return { ok: true };
  }
  return checkOutput(outcome.summary, vars);
}

/**
 * 把一份结局渲染成"它交出来的东西" —— **原文优先,原文空时退回产出**。
 *
 * ## 为什么非这样不可(2026-09-20,和 `checkOutputFrom` 同一个根)
 *
 * 这条流程上有三处都在问同一个问题("这一步交了什么"),而它们**曾经各写一遍**:
 * 流程记录走 `recordBodyOf`(会看产出),而**直接上游那一节**(`upstreamTextOf`)和
 * **岔路口透传**(`carriedTextOf`)只看 `summary`。
 *
 * 对一个只用 `@@mcode:result` 上报、不写 `summary` 的命令节点,后果是**同一个结局在
 * 这三处显示得不一样**:流程记录里有,直接上游那一节里没有。而最要命的一处正是它 ——
 * 一条直线 `A → B` 上,B 的指令里写着"用 A 交出来的年份",它看到的却是一片空白,
 * 于是要么反问、要么自己编一个。
 *
 * ## 为什么是"原文优先"而不是"两个都拼"
 *
 * 原文非空时**一个字节都不改** —— 那是绝大多数节点的形状(模型节点就交一段文本),
 * 老行为必须逐字保住。只有原文是空的、而产出里有东西时,才换成变量表那种
 * `- 名字:值` 的写法(和 `recordBodyOf` 同一种,用 `outputValueText` 同一个转换)。
 *
 * 也因此**不是**把 `outputs` 全倒出来:`commandRunner` 每次都填 `exitCode` / `stdout`,
 * 在提示词里塞一段 `- exitCode:0` 对读的人毫无用处。命令节点那种"交了个对象"的形状,
 * 意义全在下游的 `{{某步.某变量}}` 上,不在这一节里。
 */
function producedTextOf(outcome: NodeOutcome): string {
  const summary = outcome.summary.trim();
  if (summary.length > 0) return summary;
  const outputs = outcome.outputs;
  if (outputs === undefined) return "";
  const lines: string[] = [];
  for (const [name, value] of Object.entries(outputs)) {
    const text = outputValueText(value);
    if (text.length === 0) continue;
    lines.push(`- ${name}:${text}`);
  }
  return lines.join("\n");
}

/* ────────────────────────── 调度 ────────────────────────── */
/**
 * 一次运行要的全部输入。原样从 `runWorkflow` 的参数对象搬过来 —— 一个字段没增没减。
 */
export interface RunArgs {
  doc: WorkflowDoc;
  /** 用户这次发的消息。只注入根节点(见 {@link composeNodePrompt})。 */
  prompt: string;
  ports: RunPorts;
  signal: AbortSignal;
  /** 从上次被打断的地方接着跑。**不给就是全新的一次**(见 {@link RunResume})。 */
  resume?: RunResume;
  /**
   * **这次运行是哪个触发器起的**,以及那份事件载荷的文本。
   *
   * 自动化的一条流程上可以有**多个触发器**(「每天九点」和「文件改了」挂在同一张图上),
   * 一次运行只由其中一个起 —— 其余那些这一次**压根没发生**,所以它们连同各自拖着的那条
   * 支路一起标 `unselected`(不是 `skipped`:没有谁失败)。
   *
   * 做法是**把被触发的那个直接预置进 `outcomes`** —— 于是它不会被派发,而它的下游因为
   * "上游成功了"照常起跑。和续跑(`resume.settled`)是同一套起手式。
   *
   * 不给 = 这次运行不是触发器起的(用户在对话里手动跑一张图)。那时**一个触发器都不预置**,
   * 真被派发到了就明确失败(见 `executeOne`)—— 与其编一个载荷糊过去,不如说清楚。
   *
   * `payload` 是载荷的**事实键值**(G3/VAR-06,见 `automationPayload.ts` 的
   * `payloadFactsOf`):它进 {@link RunState.entry} 一起落盘,并被递进每个节点的
   * `data.trigger`,节点参数里的 `{{trigger.<key>}}` 从这里取。
   */
  entry?: { nodeId: string; summary: string; payload?: Record<string, unknown> };
}
/**
 * **一次运行的内部状态。**
 *
 * 原先这是一个一千多行的 `runWorkflow` 函数：三十来个互相引用的闭包加一堆散落的
 * `Map`，状态全靠词法作用域兜着 —— 看得见的地方只有函数体，改一处要在 1200 行里
 * 找全所有引用。现在它们是这个类的字段与方法：**状态在字段上列得出来，阶段在方法
 * 名上叫得出来**，而 `init()` / `run()` 把「准备」和「推进」分开了。
 *
 * ## 为什么初始化是 `init()` 而不是构造函数
 *
 * 因为取节点清单那一段是**异步**的（`ports.manifestOf`），而构造函数不能 `await`。
 * 更要紧的是顺序：`loopBackIds` / `cycleOf` / `onLoop` 三个都要问 `isBranch`，
 * 而 `isBranch` 读的正是那份清单 —— 清单没填完就算，算出来是错的。所以整段初始化
 * 保持原样、按原来的先后顺序待在 `init()` 里，构造函数只负责把参数收进来。
 *
 * 对外行为一字未变：`runWorkflow` 仍是唯一入口，返回同样的 `RunResult`。
 */
class Run {
  doc!: WorkflowDoc;
  prompt!: string;
  ports!: RunPorts;
  signal!: AbortSignal;
  entry!: { nodeId: string; summary: string; payload?: Record<string, unknown> } | undefined;
  deps!: Map<string, string[]>;
  dependents!: Map<string, string[]>;
  storedTitleOf!: Map<string, string>;
  plan!: WorkflowPlan;
  nodeById!: Map<string, WorkflowNode>;
  loopBackIds!: Set<string>;
  cycleOf!: Map<string, string[]>;
  onLoop!: Set<string>;
  outcomes!: Map<string, NodeOutcome>;
  inflight!: Map<string, Promise<void>>;
  chosen!: Map<string, BranchChoice>;
  lastPick!: Map<string, BranchChoice>;
  record!: FlowRecordEntry[];
  rounds!: Map<string, number>;
  presetChoices!: Map<string, BranchChoice>;
  /** 失败重试时用户写的那句话(见 `RunResume.note`)。不点名就没有。 */
  retryNote!: { nodeId: string; text: string } | undefined;
  awaiting!: Set<string>;
  pendingLoopBack!: string | null;
  manifests!: Map<string, ManifestSlot>;

  stateOf = (): RunState => ({
    record: [...this.record],
    rounds: [...this.rounds],
    picks: [...this.chosen],
    outcomes: [...this.outcomes],
    awaiting: [...this.awaiting],
    // 只有真有 entry 时才带上这个键 —— 老是塞一个 `entry: undefined` 的话,存档里
    // 会多出一串空字段,而读的人分不清"没有触发器"和"这个字段没写"。
    ...(this.entry !== undefined ? { entry: this.entry } : {}),
  });

  publish = (): void => this.ports.snapshot?.(this.stateOf());

  titleOf = (id: string): string => {
    const node = this.doc.nodes.find((n) => n.id === id);
    if (!node) return id;
    return workflowNodeRefName(node);
  };

  manifestOfCached = (typeId: string): NodeTypeManifest | undefined =>
    this.manifests.get(typeId)?.manifest;

  isBranch = (id: string): boolean => {
    const node = this.nodeById.get(id);
    return node !== undefined && this.manifestOfCached(node.type)?.runner.kind === "branch";
  };

  /**
   * 这个节点**拦不拦得住一次回头** —— 环的闸门。`isBranch` 只是候补那一半。
   *
   * ⚠️ **和存盘校验、画布上是同一个判据**(`@contracts/workflow` 的 `isLoopGateNode`)。
   * 原来这里传的**就是 `isBranch`**,也就是只问了"它是不是分支" —— 于是一张全靠模型选的
   * 环在这里被当成"有闸门":回边照收,而模型会在环里**一环一环自己转下去**,一次都不过
   * 人手。存盘校验本来会拦住那种图,但这层的注释自己写着"真出现了要**说出来**而不是让它
   * 卡死" —— 那就更不能把它当成一张能停下来的环。
   */
  isLoopGate = (id: string): boolean =>
    isLoopGateNode(this.isBranch, (want) => this.nodeById.get(want)?.params, id);

  isTrigger = (id: string): boolean => {
    const node = this.nodeById.get(id);
    return node !== undefined && this.manifestOfCached(node.type)?.runner.kind === "trigger";
  };

  isModelDeciderNode = (id: string): boolean => {
    const node = this.nodeById.get(id);
    if (node === undefined) return false;
    const manifest = this.manifestOfCached(node.type);
    return manifest !== undefined && isModelDecider(manifest, node.params);
  };

  isAskBeforeRun = (id: string): boolean => {
    const node = this.nodeById.get(id);
    if (node === undefined) return false;
    const manifest = this.manifestOfCached(node.type);
    return manifest?.runner.kind === "conversation" && askBeforeRunOf(node.params);
  };

  readsRecord = (node: WorkflowNode): boolean =>
    this.record.length > 0 && (flowRecordOf(node.params) ?? this.onLoop.has(node.id));

  forwardDescendantsOf = (id: string): string[] => {
    const seen = new Set<string>();
    const stack = [...(this.dependents.get(id) ?? [])];
    while (stack.length > 0) {
      const at = stack.pop() as string;
      if (seen.has(at)) continue;
      seen.add(at);
      stack.push(...(this.dependents.get(at) ?? []));
    }
    return [...seen];
  };

  voidClosureOf = (ids: Iterable<string>): void => {
    for (const id of ids) {
      for (const each of [id, ...this.forwardDescendantsOf(id)]) this.outcomes.delete(each);
    }
  };

  rewindLoop = (fromId: string, marker: string): void => {
    // **「运行前先问我」选了「重复上一个任务」。** 它不是一条画在图上的回边(见
    // `@contracts/nodeType` 的 `ASK_CHOICES`),所以没有 `cycleOf` 可查 —— 要抹的是
    // **上一步及其全部后续**,而"上一步"就是这一步的有效上游。
    //
    // 抹完之后**这一步自己也没有结局**(它在上游的后代闭包里),于是等上一步重新跑完、
    // 这里会**再问一次** —— 那正是用户要的"重复完成之后依旧在这个对话节点"。
    if (marker === ASK_REPEAT_CHOICE) {
      this.voidClosureOf(this.effectiveUpstreamOf(fromId));
      return;
    }
    const cycle = this.cycleOf.get(marker);
    if (cycle === undefined) return;
    this.voidClosureOf([...cycle, fromId]);
    this.chosen.delete(fromId);
  };

  appendStep = (node: WorkflowNode, outcome: NodeOutcome): void => {
    const round = (this.rounds.get(node.id) ?? 0) + 1;
    this.rounds.set(node.id, round);
    const at = this.record.findIndex((e) => e.kind === "step" && e.nodeId === node.id);
    if (at >= 0) this.record.splice(at, 1);
    this.record.push({
      kind: "step",
      nodeId: node.id,
      title: this.titleOf(node.id),
      round,
      body: recordBodyOf(outcome),
    });
  };

  choosesEdge = (id: string): boolean => this.isBranch(id);

  edgeLive = (edge: WorkflowEdge): boolean => {
    if (!this.choosesEdge(edge.from)) return true;
    const pick = this.chosen.get(edge.from);
    return pick === undefined || pick.edgeId === edge.id;
  };

  liveUpstreamOf = (nodeId: string): string[] =>
    this.doc.edges
      .filter((e) => e.to === nodeId && !this.loopBackIds.has(e.id) && this.edgeLive(e))
      .map((e) => e.from);

  effectiveUpstreamOf = (nodeId: string): string[] =>
    this.liveUpstreamOf(nodeId).filter((up) => this.outcomes.get(up)?.status !== "unselected");

  edgeLabelOf = (edge: WorkflowEdge): string =>
    edgeOptionNameOf(edge, this.doc, workflowNodeRefName);

  branchOptionsOf = (nodeId: string): WorkflowChoiceOption[] =>
    outgoingEdgesOf(this.doc, nodeId).map((e) => {
      const note = (e.note ?? "").trim();
      return {
        id: e.id,
        label: this.edgeLabelOf(e),
        ...(note.length > 0 ? { note } : {}),
        next: this.titleOf(e.to),
      };
    });

  arrivalOf = (nodeId: string): Arrival | undefined => {
    for (const edge of this.doc.edges) {
      if (edge.to !== nodeId || !this.choosesEdge(edge.from)) continue;
      const pick = this.lastPick.get(edge.from);
      if (pick === undefined || pick.edgeId !== edge.id) continue;
      return {
        from: this.titleOf(edge.from),
        label: this.edgeLabelOf(edge),
        note: (edge.note ?? "").trim(),
        comment: (pick.comment ?? "").trim(),
        // **这条出路是谁定的。** 模型选的分支没有"他临时补的那句话"(`comment` 恒为
        // 空),而且下一步看到的措辞必须换个说法 —— 见 `Arrival.by`。
        by: this.isModelDeciderNode(edge.from) ? "agent" : "user",
      };
    }
    return undefined;
  };

  cutByOf = (nodeId: string): string[] => {
    const names: string[] = [];
    for (const edge of this.doc.edges) {
      if (edge.to !== nodeId || this.edgeLive(edge)) continue;
      const name = this.titleOf(edge.from);
      if (!names.includes(name)) names.push(name);
    }
    return names;
  };

  labelUpstreamText = (upId: string, summary: string): string =>
    this.isBranch(upId) ? summary : `### ${this.titleOf(upId)}\n${summary}`;

  carriedTextOf = (nodeId: string): string => {
    const parts: string[] = [];
    for (const up of this.deps.get(nodeId) ?? []) {
      const outcome = this.outcomes.get(up);
      if (outcome?.status !== "success") continue;
      const body = producedTextOf(outcome);
      if (body.length === 0) continue;
      parts.push(this.labelUpstreamText(up, body));
    }
    return parts.join("\n\n");
  };

  settle = (node: WorkflowNode, outcome: NodeOutcome): void => {
    this.outcomes.set(node.id, outcome);
    const branch = this.isBranch(node.id);
    // **回头:刚落的这个结局要抹掉。**
    //
    // 顺序是被逼出来的:抹环得在**分支自己落定之后**(见 `rewindLoop`),而这里是唯一
    // 记录结局的地方。抹完之后这个分支**没有结局** —— 那正是"再来一轮"的意思:它要等
    // 环体重新跑完、再问用户一次。这一刻它没有结论可报,所以这里不再往下走。
    //
    // **开了「运行前先问我」的对话节点走同一条路**:它选了"重复上一个任务"时,刚落的
    // 就是自己的结局,而它接下来要做的正是"等上一步重跑完、再问一次"。判据里放进它,
    // 是因为这两件事**必须是同一个时机**——晚一步就会被上面刚落的结局盖住。
    if ((branch || this.isAskBeforeRun(node.id)) && outcome.status === "success") {
      const back = this.pendingLoopBack;
      this.pendingLoopBack = null;
      if (back !== null) {
        this.rewindLoop(node.id, back);
        // 抹环改的是"谁跑过了",那是别人重跑与否的依据 —— 得立刻写出去。
        this.publish();
        return;
      }
    }
    // **分支节点选完之后不再补一张结果卡。** 它的卡片就是那张选择卡,而且上面已经
    // 写着"你选了 X"了(见 `@contracts/runtime` 的 `WorkflowNodeChoiceEvent`)——
    // 再发一张的话,同一个节点在对话里会出现两张卡,其中一张是空的。
    //
    // 这里只管"选成功了"那一种:失败(没有出路 / 选了个不存在的)和 unselected
    // 都**照常发卡** —— 那几种情况下用户需要知道这一步出了什么事。
    //
    // ⚠️ **决定权给模型的分支不吃这一条**:它真跑了一轮(和从前的决策节点一样),用户
    // 没见过什么选择卡,它的结局(含「出路」产出)得照常上报/落流程记录 —— 吞掉的话
    // 运行历史里这一步是空的,下游也取不到 `{{那一步.出路}}`。
    if (branch && !this.isModelDeciderNode(node.id) && outcome.status === "success") {
      this.publish();
      return;
    }
    // 记进流程记录。**只有成功才记** —— 失败、没走这条路、取消都没有"产出"可言,记一条
    // 空的会让后面的助手以为这一步做过并交了东西。(跑过、但确实没交出文本的**要**记,
    // 那一条在 `flowRecordSection` 里会写成"(这一步没有产出文本)"。)
    if (outcome.status === "success") this.appendStep(node, outcome);
    // 轮次取的是 `appendStep` 刚写下的那个数;失败/没走这条路的不进流程记录,
    // 也就没有轮次 —— 那些**本来就不该有第二张卡**(同一轮里它只会定案一次),
    // 报 1 即可。
    this.ports.report({
      kind: "node.settled",
      node,
      outcome,
      round: this.rounds.get(node.id) ?? 1,
    });
    this.publish();
  };

  upstreamTextOf = (node: WorkflowNode, referenced: ReadonlySet<string>): string => {
    const parts: string[] = [];
    for (const up of this.deps.get(node.id) ?? []) {
      if (referenced.has(up)) continue;
      const upTitle = this.storedTitleOf.get(up) ?? "";
      if (upTitle.length > 0 && referenced.has(upTitle)) continue;
      const outcome = this.outcomes.get(up);
      if (outcome?.status !== "success") continue;
      const body = producedTextOf(outcome);
      if (body.length === 0) continue;
      parts.push(this.labelUpstreamText(up, body));
    }
    return parts.join("\n\n");
  };

  askUser = async (
    node: WorkflowNode,
    options: WorkflowChoiceOption[],
  ): Promise<BranchChoice> => {
    const preset = this.presetChoices.get(node.id);
    this.presetChoices.delete(node.id);
    if (preset === undefined) {
      this.awaiting.add(node.id);
      this.publish();
    }
    const pick = await this.ports.choose(node, options, this.signal, preset);
    this.awaiting.delete(node.id);
    return pick;
  };

  chooseOne = async (node: WorkflowNode): Promise<NodeOutcome> => {
    const options = this.branchOptionsOf(node.id);
    if (options.length === 0) {
      return {
        status: "failed",
        summary: "",
        error: "这是个分支节点,但一根出路都没有 —— 从它往下一步拉几根线,每根线就是一个选项",
      };
    }
    const pick = await this.askUser(node, options);
    // 取消和"选完了"都会让上面那个 promise 落地(端口那一头必须保证这件事),
    // 所以先看取消 —— 取消时那个 `pick` 是没有意义的。
    if (this.signal.aborted) return cancelled();
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
    this.chosen.set(node.id, pick);
    // 另外存一份**不跟着回卷清掉**的 —— 环体重跑时,"这一步是从哪条路来的"还要说得出
    // 来(见 `arrivalOf`)。
    this.lastPick.set(node.id, pick);
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
      this.record.push({
        kind: "user",
        from: this.titleOf(node.id),
        label: picked.label,
        note: (picked.note ?? "").trim(),
        comment: (pick.comment ?? "").trim(),
      });
    }
    // **回头**:选的这条指回前面。环体由 `settle` 在落定之后抹(见那里和 `rewindLoop`
    // 的注释 —— 抹早了会被刚落的结局盖回去)。
    if (this.loopBackIds.has(pick.edgeId)) this.pendingLoopBack = pick.edgeId;
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
    return { status: "success", summary: this.carriedTextOf(node.id) };
  };

  applyDecision = (
    node: WorkflowNode,
    options: readonly WorkflowChoiceOption[],
    checked: NodeOutcome,
  ): NodeOutcome => {
    // 失败/取消/`unselected` 直接放行 —— 该报的原因已经报过了。⚠️ **这一步不能在
    // `chosen` 里留东西**:留着的话它的出边会被当成"选过了",下游**全都跑起来**,而
    // 这一次的运行其实是失败的(正确的传播是下游 `skipped`)。
    if (checked.status !== "success") return checked;
    if (options.length === 0) {
      return {
        status: "failed",
        summary: checked.summary,
        error: "这个岔路口的决定权在模型,但一根出路都没有 —— 从它往下一步拉几根线,每根线就是一个选项",
      };
    }
    const parsed = checkOutput(checked.summary, [DECIDE_OUTPUT_VAR]);
    if (!parsed.ok) return { status: "failed", summary: checked.summary, error: parsed.error };
    const raw = (parsed.value as Record<string, unknown>)[DECIDE_VAR_NAME];
    const text = typeof raw === "string" ? raw : outputValueText(raw);
    const label = matchDecisionOption(
      text,
      options.map((o) => ({ label: o.label, title: o.next ?? "" })),
    );
    if (label === undefined) {
      return {
        status: "failed",
        summary: checked.summary,
        // 报错要**给出全部可选的名字** —— 这是用户照着改提示词/改边名唯一需要的东西。
        error: `这一步没有走成任何一条路:它交的「${DECIDE_VAR_NAME}」是「${text.trim()}」,而这次可选的只有 ${options
          .map((o) => `「${o.label}」`)
          .join("、")}`,
      };
    }
    // 同名的边取文档顺序第一条 —— 确定性(选项名本来就该是唯一的,重复是用户的疏忽)。
    const picked = options.find((o) => o.label === label) ?? (options[0] as WorkflowChoiceOption);
    const pick: BranchChoice = { edgeId: picked.id };
    this.chosen.set(node.id, pick);
    this.lastPick.set(node.id, pick);
    // **它自己判的那一条进流程记录**,和用户的选择并列但**分开记**(见
    // `FlowRecordEntry` 的 `decision` 那一支):下一个助手读到的是"某一步自己判的",
    // 不是"用户选的" —— 措辞混了,它就会去揣摩一个根本不存在的人的意图。
    this.record.push({
      kind: "decision",
      from: this.titleOf(node.id),
      label: picked.label,
      note: (picked.note ?? "").trim(),
    });
    // 产出里补上「出路」:下游可以 `{{那一步.出路}}` 取到它判了哪条路。
    return {
      ...checked,
      outputs: { ...(checked.outputs ?? {}), [DECIDE_VAR_NAME]: picked.label },
    };
  };

  askOne = async (
    node: WorkflowNode,
  ): Promise<{ outcome: NodeOutcome } | { answer: AskAnswer }> => {
    const options = this.askOptionsOf(node);
    const pick = await this.askUser(node, options);
    if (this.signal.aborted) return { outcome: cancelled() };
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
      this.record.push({
        kind: "user",
        from: this.titleOf(node.id),
        label,
        note: "",
        comment,
      });
      // 被作废重跑的那些节点,**这一轮起按"在环上"对待** —— 环上的步骤默认读流程记录
      // (见 `readsRecord`),而它们恰恰最需要看见刚记下的那一条。
      //
      // 这张图里其实没有环(这个选项不是画出来的边),所以那个默认值补不上,得在这里
      // 显式加。只加这一次,之后节点上要是明确关掉了读记录,照样以它为准。
      for (const up of this.effectiveUpstreamOf(node.id)) {
        this.onLoop.add(up);
        for (const d of this.forwardDescendantsOf(up)) this.onLoop.add(d);
      }
      // 抹的时机交给 `settle`(见那里的注释:抹早了会被刚落的结局盖回去)。
      // 这里返回的结局只是"落一下再抹掉"的过场,`summary` 沿用岔路口那套透传。
      this.pendingLoopBack = ASK_REPEAT_CHOICE;
      return { outcome: { status: "success", summary: this.carriedTextOf(node.id) } };
    }

    // **用这一步的指令**:补的那句话进提示词,照常跑。
    return { answer: { label, comment } };
  };

  askOptionsOf = (node: WorkflowNode): WorkflowChoiceOption[] => {
    const ups = this.effectiveUpstreamOf(node.id);
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
              next: `重跑「${ups.map((id) => this.titleOf(id)).join("、")}」,跑完回到这一步再问你`,
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

  executeOne = async (node: WorkflowNode): Promise<NodeOutcome> => {
    // ⚠️ **整个函数体在 try 里**,不只是 `ports.execute` 那一段。取清单、校验参数
    // 都可能抛(清单文件读坏了、宿主实现有 bug),而**一个抛出去的节点不会定案** ——
    // 调度器会把它当成"还没跑"再派发一次,那就是死循环。
    try {
      if (this.signal.aborted) return cancelled();
      // 类型没装 / 跑不起来 / 参数不齐 —— 都**明确失败**,不静默跳过
      // (见 `@contracts/nodeType` 的 `isNodeRunnable` 注释)。
      // 清单是开跑前取的,取不到有两种,话要分开说:**没装这个类型**(别人分享来的图)
      // 和**清单文件坏了**(读的时候抛了)。
      const slot = this.manifests.get(node.type);
      if (slot?.error !== undefined) {
        return { status: "failed", summary: "", error: slot.error };
      }
      const manifest = slot?.manifest;
      if (!manifest) {
        return { status: "failed", summary: "", error: `节点类型「${node.type}」没有安装` };
      }
      if (!isNodeRunnable(manifest)) {
        return {
          status: "failed",
          summary: "",
          error:
            manifest.runner.kind === "command" && manifest.runner.entry !== undefined
              ? "脚本型命令节点(command 自带 runner.entry)还没有实现 —— 把脚本要干的活写进「命令」参数里就能跑"
              : `执行方式「${manifest.runner.kind}」还没有实现`,
        };
      }
      // **触发器自己不跑东西。** 正常路径下走不到这里:被触发的那个由 `entry` 预置了
      // 结局,其余的在主循环第 1 步就标了 `unselected`。真派发到它说明**这次运行没有
      // 说清是哪个触发器起的**(比如把一条自动化当普通工作流跑),或者图被手改坏了
      // —— 两种情况都该明确失败,而不是让它"跑一个什么都不做的节点"糊过去。
      if (manifest.runner.kind === "trigger") {
        return {
          status: "failed",
          summary: "",
          error:
            "「触发器」是这条自动化的起点,它自己不跑东西 —— 这次运行要说清是哪一个触发器起的",
        };
      }
      // **分支走两条路,决定权说了算**:决定权给用户(默认)就挂起等人 —— 它没有参数
      // 要验(选项在边上,见 `WorkflowEdgeSchema`)、没有产出要查、也不建会话,那一整段
      // 对它都不成立。**决定权给模型**的不进这个岔:它和别的步骤一样往下走参数校验
      // (分支清单现在有「决定权」「选路判据」两个参数,判据还允许留空 —— 兜底在
      // `nodeInputOf` 里),再落到模型轮那条路上。
      if (manifest.runner.kind === "branch" && !this.isModelDeciderNode(node.id)) {
        return await this.chooseOne(node);
      }
      // **解算前再校验一次**:清单可能在这份文档存盘之后改过,老节点身上还带着
      // 旧参数(见 `validateNodeParams` 的注释)。
      const check = validateNodeParams(manifest, node.params);
      if (!check.ok) return { status: "failed", summary: "", error: check.error };
      // 产出约束本身有没有矛盾(选了数组又填必备字段……)。**和上面那条一样,在派发
      // 之前查**:矛盾的配置不会报错,它只会让某一步跑完之后以一个看不懂的理由失败。
      const rulesCheck = validateOutputRules(manifest, node.params);
      if (!rulesCheck.ok) return { status: "failed", summary: "", error: rulesCheck.error };
      if (this.signal.aborted) return cancelled();

      // **开了「运行前先问我」的对话节点:先问一句,再决定要不要跑、怎么跑。**
      //
      // 位置选在**参数校验之后**:一个参数填错的节点该直接骂它填错了,而不是先把用户
      // 拽过来问一遍"要不要跳过"—— 那个问题对一张配坏了的图没有意义。
      //
      // 问出来的四种回答见 `askOne`。只有"用这一步的指令"会落回下面这条路,其余的
      // 都在那里直接定案了。
      let askAnswer: AskAnswer | undefined;
      if (manifest.runner.kind === "conversation" && askBeforeRunOf(node.params)) {
        const asked = await this.askOne(node);
        if ("outcome" in asked) return asked.outcome;
        askAnswer = asked.answer;
        if (this.signal.aborted) return cancelled();
      }

      /**
       * **失败重试时用户写的那句话** —— 只给被点名的那一步看(见 `RunResume.note`)。
       *
       * 与上面的 `askAnswer` 共用「本次执行的前置选择」那一段的渲染(见下面 `inputScope`
       * 里那个三元):对模型来说它们说的是同一件事 —— "用户在这次执行之前拍过一个板"。
       *
       * 两者**不会同时出现在一步上**:`ask` 只对对话节点生效,而重试按钮只给子 agent
       * 节点(用户定的)。真撞上了也不冲突 —— 提示词里那一段会带上后写的那一份,而
       * "哪一步被点名了"本来就只有一个答案。
       */
      const retryNote =
        this.retryNote !== undefined && this.retryNote.nodeId === node.id
          ? this.retryNote.text
          : undefined;

      // 这一步能引用什么。**每次派发时现算** —— 上游的结局和参数在这之前才刚定下来
      // (同一列里别的节点可能还在跑),提前算会拿到半张图。
      //
      // `trigger` 是**这次触发载荷的平面事实**(自动化起跑时随 entry 进来,见
      // `automationRunner` 的 `payloadFactsOf`),没被触发器起就是 `undefined`。
      // 它与上游那两张表**不是一回事** —— `{{trigger.*}}` 解在 `renderTemplate` 里
      // (见那边 `resolveOne` 的第一段),所以这里把它挂在 scope 上而不是塞进 nodes。
      const scope: NodeTemplateScope = {
        user: this.prompt,
        upstream: upstreamNames(this.deps, this.titleOf, node.id),
        nodes: this.doc.nodes.map((n) => {
          const outcome = this.outcomes.get(n.id);
          return {
            id: n.id,
            title: n.title,
            params: n.params,
            ...(outcome ? { outcome, artifacts: outcome.artifacts } : {}),
          };
        }),
        ...(this.entry?.payload !== undefined ? { trigger: this.entry.payload } : {}),
      };

      // 先解变量,后面每一步都看解算后的参数 —— 技能名、上下文类目、产出约束都可能
      // 写在变量里(虽然少见),而"哪几个参数是解算过的"如果有两种答案,迟早分家。
      // 解不出来会抛,由下面那层的 catch 兜成这个节点的失败。
      // **引用要在解算前扫**(见 `referencedNodeNames`),解算完就看不出引过谁了。
      const referenced = referencedNodeNames(node);
      const params = expandParams(node, manifest, scope);

      // **能力预检(G4/CAP):派发前的最后一道闸。** 需求 = 清单声明的 requirements +
      // 参数推导(选了引擎 / 技能 / 插件 / 执行器),清单 = 调用方装配的这台机器的
      // descriptor。端口缺席(冒烟的假端口)或装配失败 → **整个跳过** —— 预检是闸门,
      // 不是新的故障源。有阻断性问题时按**现有的失败语义**定案(不新增节点状态),
      // 它的下游会照常标 `skipped`,原因就写在这句错误里。
      //
      // ⚠️ skill / mcp 两类这一轮**不查**:宿主侧还没有"全部可用技能 / MCP"的可靠
      // 清单来源(项目级技能是异步拿、MCP 宿主侧清单缺失),拿一份不完整的清单去对,
      // 会把"选了技能"误判成"缺技能" —— 误伤比漏检难看得多。清单来源补齐后再放开。
      if (this.ports.capabilityInventory !== undefined) {
        const preflight = await this.ports.capabilityInventory().catch(() => undefined);
        if (preflight !== undefined) {
          const requirements = requirementsForNode(manifest, params, undefined, preflight.executorKinds).filter(
            (r) => r.kind !== "skill" && r.kind !== "mcp",
          );
          const problems = describeCapabilityProblems(
            checkNodeCapabilities(manifest, requirements, preflight.inventory),
          );
          if (problems.length > 0) {
            return { status: "failed", summary: "", error: problems.join(";") };
          }
        }
      }

      // 这一步是不是**终末**(没有下游)。它决定两件事:产出变量表发不发(见
      // {@link withOutputCheck})和产出要不要按变量表查。**和 `planSection` 用的是
      // 同一个 `isLast`** —— 提示词里说的"你是最后一步"和这里的行为必须是一回事。
      const terminal = findStep(this.plan, node.id)?.isLast === true;
      // 它是从哪条出路来的。**每次派发时现算** —— 用户可能刚在上一轮选完,而
      // `chosen` 是在那之后才写进去的。
      const arrival = this.arrivalOf(node.id);
      // **这一步读不读整条流程的记录**(见 `readsRecord`)。读的话,记录**替代**「上游
      // 步骤的产出」—— 记录里本来就含着上游那几段;而"用户刚才选了什么"也已经作为一条
      // 记录躺在日志里了,所以那一段 `arrival` 也一并省掉(见 `composeNodePrompt`)。
      //
      // **在派发这一刻现算**,不是开跑前算一次:记录是随着别的节点跑完长出来的,而这个
      // 节点可能是在循环的第二圈才被派发的 —— 那一刻它该看到的东西比第一圈多。
      const flowRecord = this.readsRecord(node)
        ? flowRecordSection({
            name: this.doc.name,
            description: this.doc.description ?? "",
            userPrompt: this.prompt,
            entries: this.record,
          })
        : undefined;

      // **模型选的分支有哪几条出路** —— 现算,而且**只算一次**:提示词里要它交出
      // 「出路」(见 `decisionSection`)、产出回来又要拿这个值去比对(见 `applyDecision`),
      // 两处必须是同一份名单(否则报错里列的名字和提示词里给的可能不是一套)。
      const decideOptions = this.isModelDeciderNode(node.id) ? this.branchOptionsOf(node.id) : [];

      // 名字叫 `inputScope`(而不是和上面模板解算的 `scope` 重名):上面那个是
      // **变量解算**的词表(NodeTemplateScope),这个是**输入构造**的上下文
      // (ModelInputScope 的形状)。两种 scope 一个块里都活着,重名会互相吃掉。
      const inputScope = {
        userPrompt: this.prompt,
        upstream: this.upstreamTextOf(node, referenced),
        upstreamArtifacts: (this.deps.get(node.id) ?? []).flatMap((up) => this.outcomes.get(up)?.artifacts ?? []),
        upstreamOutputs: Object.fromEntries(
          (this.deps.get(node.id) ?? [])
            .map((up) => [up, this.outcomes.get(up)?.outputs] as const)
            .filter((e): e is readonly [string, Record<string, unknown>] => e[1] !== undefined),
        ),
        nodeId: node.id,
        plan: this.plan,
        // **这一格是不是根**(用户那句话进来的那一格)。提示词那一层用它决定要不要
        // 带「用户的请求」,输入构造那一层用它决定回主对话时**不回声这条指令**
        // (`NodeRunInput.echoUserMessage`)—— 两处读的是同一个判据(见 `isRootOf`)。
        root: isRootOf(this.plan, node.id),
        terminal,
        ...(arrival ? { arrival } : {}),
        ...(flowRecord !== undefined ? { record: flowRecord } : {}),
        // 「运行前先问我」那一次的回答,或者失败重试时用户写的那句话。**渲染在这儿
        // 而不是 `composeNodePrompt` 里**,是因为那一段要用节点的标题,而标题只有这一层
        // 有(`titleOf`)。
        //
        // 两条来源、同一段形态:`askAnswer` 说的是"这一步被问过、用户选了什么",
        // `retryNote` 说的是"这一步上次炸了、用户说这次该注意什么"。对模型来说都是
        // 「用户在这次执行之前拍过一个板」—— 所以共用 `askSection`。
        ...(askAnswer !== undefined
          ? { ask: askSection(this.titleOf(node.id), askAnswer) }
          : retryNote !== undefined
            ? {
                ask: askSection(this.titleOf(node.id), {
                  label: RETRY_ANSWER_LABEL,
                  comment: retryNote,
                }),
              }
            : {}),
        ...(this.isModelDeciderNode(node.id) ? { decide: { options: decideOptions } } : {}),
        contextLines: this.ports.contextLines,
      };
      // **触发器载荷进变量(G3/VAR-06)**:自动化起跑时随 `entry` 带来的事实
      // (kind / at / files / event / toolName / subjects)从这里递给输入构造层。
      // 用交叉类型注入而不是改 `ModelInputScope` 的签名 —— 那个类型归
      // `nodeInputBuilders.ts`(并行任务 M)所有;它把 `trigger?: Record<string, unknown>`
      // 加进 `ModelInputScope` 之后,这个注入自动从"额外字段"变成正式字段,两边互不阻塞。
      if (this.entry?.payload !== undefined) {
        (inputScope as typeof inputScope & { trigger?: Record<string, unknown> }).trigger = this.entry.payload;
      }
      const outcome = await this.ports.execute(
        node,
        manifest,
        buildNodeInput(params, manifest, inputScope, this.signal),
      );
      // 产出回来,按**同一份**参数查硬约束。
      const checked = withOutputCheck(manifest, params, outcome, terminal);
      // **模型选的分支还要再走一步**:它得自己挑一条出边(见 `applyDecision`)。放在
      // 产出检查**之后** —— 一个连产出都没交齐的节点,去问"它选了哪条路"没有意义。
      if (!this.isModelDeciderNode(node.id)) return checked;
      return this.applyDecision(node, decideOptions, checked);
    } catch (err) {
      // 执行器自己抛了 = 这个节点失败。**不往上抛** —— 一个节点炸掉不该让整张图
      // 停摆,它的下游会因为依赖不满足而跳过。
      return { status: "failed", summary: "", error: (err as Error).message };
    }
  };

  start = (node: WorkflowNode): void => {
    this.ports.report({ kind: "node.started", node });
    const run = (async (): Promise<void> => {
      try {
        this.settle(node, await this.executeOne(node));
      } catch (err) {
        // 上面两层都不该抛;真抛了也必须**留下一个结局** —— 没定案的节点会被调度器
        // 当成"还没跑"重新派发。这里只补一个失败的结局,不改变已经定下的那个。
        if (!this.outcomes.has(node.id)) {
          this.settle(node, { status: "failed", summary: "", error: (err as Error).message });
        }
      } finally {
        this.inflight.delete(node.id);
      }
    })();
    this.inflight.set(node.id, run);
  };
/**
 * **把这次运行备好** —— 取清单、算依赖、恢复存档。
 *
 * 返回 `false` = 还没开始派发就被取消了（用户在取清单那几秒里按了停止）。
 * 那时一个节点都没定案，调用方照原样返回一个「什么都没跑」的取消结果。
 */
  async init(args: RunArgs): Promise<boolean> {
  this.doc = args.doc;
  this.prompt = args.prompt;
  this.ports = args.ports;
  this.signal = args.signal;
  const resumed = args.resume;
  // **续跑时以存档为准**:那次运行是哪个触发器起的,不会因为进程重启就换个说法。
  this.entry = resumed?.entry ?? args.entry;

  const entry = this.entry;

  /** 上游邻接表。**不自己走一遍 `edges`** —— `buildForwardAdjacency` 是"谁依赖谁"的
   *  唯一来源(见 `@contracts/workflow`),和渲染端的勾选框用的是同一份。
   *
   *  ⚠️ 这里要的是**不含回边**的那一份。回边在结构上从环的出口指回入口,当成"上游"会
   *  让环的入口等出口、出口等入口 —— 环一次都转不起来(`buildForwardAdjacency` 的
   *  注释里有完整的理由)。回边由下面的 `loopBackIn` 单独接。 */
  const forward = buildForwardAdjacency(this.doc.nodes, this.doc.edges);
  this.deps = forward.deps;
  this.dependents = forward.dependents;
  // **续跑时从上次的结局起手** —— 上次已经定案的那些不重跑,而且不重判(见
  // `RunResume.settled`)。
  this.outcomes = new Map<string, NodeOutcome>(resumed?.settled ?? []);
  /**
   * **失败重试:把要重跑的那些从结局表里抹掉。**
   *
   * 抹的**不是一个节点,是一整个闭包** —— `rewind` 给的是"从哪一步开始重跑",展开成
   * "它 + 它的全部前进后代"由 `voidClosureOf` 做(它是唯一知道"谁是谁的后代"的地方)。
   *
   * 只抹那一步的话,下游会留着上一轮的 `skipped`:失败会往下传,而那个 `skipped` 是
   * **结局表里真实存在的一项** —— 于是下游既不会被重新派发(它已经有结局了),又拿不到
   * 新上游。图会停在那儿,而屏幕上看不出任何原因。
   *
   * 顺序:在**预置触发器**之前。重跑集合里若含触发器那一步,抹掉之后下面会把它重新
   * 预置成成功(它自己不跑东西,但"它发生了"这件事仍然成立)。
   */
  if (resumed?.rewind !== undefined && resumed.rewind.length > 0) {
    this.voidClosureOf(resumed.rewind);
  }
  // **被触发的那个触发器:预置一个成功结局。** 它自己不跑东西,但它**发生了** —— 于是
  // 它的下游照常起跑(就绪判断看的是"上游成功了")。预置而不是"特判放行",是因为下游
  // 还有第二个问题要答案:"我上游交了什么" —— 那就是这次的事件载荷(见 `entry.summary`)。
  //
  // 结局里**不写 outputs**:载荷是给人/给模型读的一段描述,不是可以 `{{...}}` 取的变量。
  //
  // 只在图里真有这个节点、而且它还没定案时才预置(续跑时它已经在 `settled` 里了)。
  if (
    entry !== undefined &&
    this.doc.nodes.some((n) => n.id === entry.nodeId) &&
    !this.outcomes.has(entry.nodeId)
  ) {
    this.outcomes.set(entry.nodeId, { status: "success", summary: entry.summary });
  }
  this.inflight = new Map<string, Promise<void>>();
  /** 分支节点 → 用户选的那条出边(以及他临时写的那句话)。没跑到 / 没选的分支不在里面。
   *
   *  **回头时会被清掉**(见 `rewindLoop`):重新布防之后,这个分支的每一条出路又都
   *  回到了"还没决定"的状态。
   *
   *  ⚠️ **续跑时它是从上一次的存档里恢复的**,不是空手起家 —— 少了它,分支的每一条
   *  出边都会被当成活的,上次没走的那条支路会被一并派发(见 `edgeLive`)。 */
  this.chosen = new Map<string, BranchChoice>(resumed?.picks ?? []);
  /**
   * 分支节点 → 用户**上一次**选的那条出路。回卷时不跟着清 —— "这一步是从哪条路来的"
   * 要一直说得出来。
   *
   * 为什么不能直接读 `chosen`:回头那一下会把它清掉(不然这个分支的其它出路会被立刻
   * 判死,而它们恰恰是下一轮要用的)。于是环体里那一步重跑时,`chosen` 里已经没有它的
   * 来路了 —— 用户的意见(「第三章太啰嗦」)就丢了,而那是他**特意打上去的**。
   */
  this.lastPick = new Map<string, BranchChoice>(resumed?.picks ?? []);
  /**
   * **这条流程到此刻为止的经过**,按完成的先后排列。见 {@link FlowRecordEntry}。
   *
   * 它是「读整条流程的记录」那个开关背后的东西 —— 谁读由 {@link readsRecord} 决定。
   * 没开这个开关的图里它照样在攒(攒的成本是一个数组,不花一分 token),只是没人读。
   *
   * **续跑时从存档接上**:记录是"发生过什么"的日志,而"发生过"这件事不因为进程
   * 死过就不成立。重跑的那一步尤其需要它 —— 它看见自己上一版才谈得上"按用户说的改"。
   */
  this.record = [...(resumed?.record ?? [])];
  /** 节点 id → 这一步跑过几次。回头绕第二圈时是 2。续跑时接着数。 */
  this.rounds = new Map<string, number>(resumed?.rounds ?? []);
  /**
   * 刚选中的那条回边 —— 环体还没抹,因为**分支自己的结局要先落定**({@link settle}
   * 是唯一记录结局的地方,抹环得在它之后)。为 null 表示这一轮没有回头。
   */
  this.pendingLoopBack = null;
  /**
   * 已经知道答案的岔路口 —— 续跑时用户刚在旧卡片上点的那一下(见
   * {@link RunResume.answer})。**只生效一次**:进 `chooseOne` 时取走,回头之后同一个
   * 岔路口要重新问。
   */
  this.presetChoices = new Map<string, BranchChoice>(
    resumed?.answer ? [[resumed.answer.nodeId, resumed.answer.choice]] : [],
  );
  /** 失败重试时用户写的那句话。**不是一次性的** —— 被点名的那一步每跑一次都该看到它
   *  (它在环里的话会跑不止一次),所以不做"取走"那一套(对比 `presetChoices`)。 */
  this.retryNote = resumed?.note;
  /**
   * 正在等用户拍板的那些节点。**是集合不是单个** —— 两处岔路口可以同时就绪(它们
   * 互不依赖),于是两条都在等人。见 {@link RunState.awaiting}。
   */
  this.awaiting = new Set<string>();

  /** 此刻的运行状态。落盘由调用方做,见 {@link RunPorts.snapshot}。 */


  /** **存下来的**标题(不拿类型 id 兜底)。判"有没有被点名引用"要用这一份 ——
   *  引用的写法认的是**存下来的标题**,`findNode` 那边也一样。 */
  this.storedTitleOf = new Map(this.doc.nodes.map((n) => [n.id, n.title.trim()]));

  /** **整条流程**(给模型看的那份计划)。一次性算好 —— 它只取决于图,和跑不跑完无关。 */
  this.plan = planOf(this.doc, this.titleOf);

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
  this.manifests = new Map<string, ManifestSlot>();
  for (const node of this.doc.nodes) {
    if (this.manifests.has(node.type)) continue;
    try {
      this.manifests.set(node.type, { manifest: await this.ports.manifestOf(node.type) });
    } catch (err) {
      this.manifests.set(node.type, { error: (err as Error).message });
    }
  }
  this.nodeById = new Map(this.doc.nodes.map((n) => [n.id, n]));
  if (this.signal.aborted) return false;

  /**
   * 这个节点是不是**分支** —— 看清单的 `runner.kind`,**不是**看类型 id。
   *
   * 第三方可以随插件带自己的分支类型进来,而它的行为必须和内置那个一模一样:挂起、
   * 等用户、作废其余支路是**调度器**的能力,不是某份清单的特权。认 id 的话,别人的
   * 分支节点会退化成一个什么都不做的普通节点,而图上一点提示都没有。
   */

  /**
   * 这个节点是不是**触发器** —— 同样只看 `runner.kind`。
   *
   * 触发器是图的**起点**:它不跑模型、不建会话,只声明"什么情况下起一次运行"。真正的
   * 监听在 `automationRunner.ts`,而**一次运行只由一个触发器起**(见 `runWorkflow` 的
   * `entry`):其余那些触发器这一次连"没走这条路"都算不上 —— 它们是另一条自动化入口,
   * 所以标 `unselected`(见主循环第 1 步)。
   */

  /**
   * 这个分支节点是不是**决定权给了模型** —— 分支的一种填法:真跑一轮模型,跑完按它
   * 自己交出来的「出路」选一条出边(见 `applyDecision`)。
   *
   * 过去的"决策节点"收编成了这种填法(见 `@contracts/nodeType` 的 `isModelDecider`),
   * 所以判据读的是**同一个函数**:「分支 + decider=model」。️ **它和 {@link isBranch}
   * 是包含关系,不是互斥** —— 模型选的分支也是分支。但"等用户"那一半只属于
   * decider=user 的那种:模型选**不能当环的闸门**(它会自己转下去),环闸门、挂起、
   * 回卷那些判定现在必须把这一层剥出来看清。
   */

  /**
   * 这个节点**跑之前要先问用户一句**(节点上的「运行前先问我」开关)。
   *
   * 两样都要看:清单的执行方式**仍然是 `conversation`**(这个开关不改变"怎么跑",只加
   * 一句"跑不跑、怎么跑"),以及那个参数为真。只看参数的话,别的类型(包括将来第三方
   * 带来的)误填一个同名键就会被卷进来。
   *
   * 见 `@contracts/nodeType` 的 `NODE_ASK_PARAM_KEY`。
   */

  /**
   * **算数的回边** —— 环上有一个岔路口的那些。
   *
   * 一条回边算不算数,取决于**它的环上有没有闸门**,而不是"它是不是回边"。没有闸门的
   * 环是坏图(存盘时 `validateDag` 就拒了),但它真到了这里也不能当成回边放行 —— 那样
   * 它会被**当成一条直线跑一遍**,而用户画的明明是个死循环。让它继续当普通依赖,它就
   * 会走到收尾那句「依赖没有满足(图里是不是有环?)」—— 那才是用户需要看到的话。
   */
  const loopBack = loopBackEdgesOf(this.doc.nodes, this.doc.edges, this.isLoopGate);
  this.loopBackIds = new Set(loopBack.map((b) => b.edge.id));
  /** 回边的 id → 它闭出来的那个环(环上的全部节点)。见 `@contracts/workflow`。 */
  this.cycleOf = new Map(loopBack.map((b) => [b.edge.id, b.cycle]));

  /**
   * 图上**在环里**的那些节点 —— 给"要不要读流程记录"当默认值用。
   *
   * 判据来自 `@contracts/workflow`,因为**检查器要显示同一个答案**:那边画的是那个开关
   * 的默认态。两处各算一遍的话,会出现"界面上显示关着、实际按开着跑",而那不报错。
   */
  this.onLoop = nodesOnLoopOf(this.doc.nodes, this.doc.edges, this.isLoopGate);

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

  /** 从 `id` 出发、沿**前进边**能到的全部节点(不含 `id` 自己)。 */

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

  /**
   * 这个节点**要在自己的出边里挑一条** —— 就是分支节点。
   *
   * 过去这里写的是 `isBranch(id) || isDecide(id)`:决策节点曾经是独立的一种。现在它
   * 收编成了分支的一种填法(决定权给模型,见 {@link isModelDeciderNode}),判"挑不挑路"
   * 只剩一个来源 —— **分支**。用户挑和模型挑共有这一半:选项就是出边、挑中的那条算活、
   * 其余连同它们的下游一起作废;分开的那一半是"谁来挑"和"能不能当环的闸门"
   * (见 {@link isBranch} / {@link isModelDeciderNode})。
   */

  /**
   * 一条边**通不通**。
   *
   * 非分支/决策节点的出边永远是通的(它就是一条依赖)。**挑路的节点只"激活"它选中的
   * 那一条** —— 其余几条连同它们拖着的整条支路一起作废(见下面第 1 步的传播)。
   *
   * 还没选(`chosen` 里没有)时返回 `true`:那时这个节点自己还没定案,它的下游本来
   * 就不会被派发(就绪要求"上游全都成功")。这个返回值只在**它已经选完**之后才承重。
   */

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

  /** 一条出路叫什么。**没填 label 就用目标节点的标题** —— 一根说不出名字的线对用户
   *  没有意义,而"通向谁"至少说明了它会走到哪。 */

  /** 一个分支节点的出路(就是它的出边,顺序即文档顺序)。 */

  /**
   * 这一步是从哪条出路来的(上游是分支节点、且那条边正是他选的那条时才有)。
   *
   * 读的是 {@link lastPick} 而不是 {@link chosen}:回头那一下会把 `chosen` 清掉,而
   * 重跑的那一步**恰恰最需要知道自己是打哪儿来的** —— 用户的意见就挂在那个选择上。
   * 读 `chosen` 的话,「再改一轮」重跑时那一段会整个消失,而那一步看起来就像是被凭空
   * 又跑了一遍(模型只能猜"为什么又是我")。
   */

  /** 一条边被哪几个分支节点挡掉了(报错时要说清是谁挡的)。 */

  /**
   * 一段上游结果该怎么摆。**来自分支节点的那一段不加标题** —— 它是透传的,内容本来
   * 就是它上游那几步的(各自带着自己的标题,见 {@link chooseOne})。再套一层
   * `### 下一步做什么` 会把别人写的稿子挂到一个岔路口名下。
   */

  /**
   * 分支节点**替它上游把话带过去**的那一段。见 {@link chooseOne}。
   *
   * 和 {@link upstreamTextOf} 同一个形状(只取成功且有话说的、`### 标题` 分段),差别
   * 只有一处:这里**没有"被点名就跳过"那一步** —— 分支节点身上没有指令,也就不可能
   * 引用谁。
   */


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

  /**
   * **模型选的分支:跑完了,自己挑一条出边。**
   *
   * ## 它与 {@link chooseOne} 的关系
   *
   * 前半段完全不同(那边是挂起等用户,这边是真跑了一轮模型),**后半段一模一样**:
   * 选项就是出边、挑中的那条 `chosen` 记下来、其余连同下游一起作废、进流程记录。所以
   * 两处共用同一套机器(`branchOptionsOf` / `edgeLive` / `lastPick`),而不是各写一遍
   * —— 各写一遍的话,"没走的那条路"在两条路径上的传播迟早会长得不一样。
   *
   * ## 走向必须是**可校验的**,不能是"它说想去哪"
   *
   * 它交出来的「出路」要**一字不改**地对上某条出边的名字(先比选项名、再比目标节点标题,
   * 去空白、大小写不敏感 —— 见 `matchDecisionOption`)。对不上就是这一步**失败**:含糊
   * 的走向比一个明确的失败危险得多,后者当场看得见,前者要等下游全跑偏才暴露。
   *
   * ## 它**不**透传上游(和"决定权给我"的分支相反)
   *
   * 那种分支是"岔路口",它没跑过任何东西,所以产出只能是上游那几段拼起来带过去(否则
   * 分叉就等于把东西丢了)。而模型选的**真跑了一轮**:产出就是它自己交的那一份 ——
   * 上游内容它读得到,要不要往下带由它写在产出变量里决定。
   *
   * ## 它**不是环的闸门**
   *
   * 所以这里不碰 `pendingLoopBack`:环上必须有用户拍板的分支节点(决定权给用户那种)。
   * 一张环只有模型选的分支的图,在存盘时就被 `validateDag` 拒了(见 `library.ts` 的
   * `isLoopGate`),真跑到这里也只会以"依赖没有满足(图里是不是有环?)"收场。
   */

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

  /**
   * 「运行前先问我」那四条的文案。
   *
   * **没有上游就不给"重复上一个任务"** —— "上一步"根本不存在,摆一个点了会失败的
   * 按钮比不摆更糟。其余三条任何情况下都成立。
   */


    return true;
  }

/** 主循环：**就绪即派发**，直到没有东西可动。 */
  async run(args: RunArgs): Promise<RunResult> {
    if (!(await this.init(args))) return cancelledRun(this.stateOf());
  for (;;) {
    if (this.signal.aborted) break;

    // 1. 把**走不到**的标掉。两种:来路被别的选择挡掉了(`unselected`),或者上游真的
    //    失败了(`skipped`)。**每轮都要重扫** —— 标掉一步可能让它的下游也走不到,而
    //    那是下一轮的事。
    let moved = false;
    for (const node of this.doc.nodes) {
      if (this.outcomes.has(node.id) || this.inflight.has(node.id)) continue;
      // **这次不是它起的那个触发器:没走这条路。**
      //
      // 一条自动化可以挂好几个触发器(「每天九点」和「文件改了」),一次运行只由其中一个
      // 起。其余那些这一次**压根没发生** —— 标 `unselected` 而不是 `skipped`:没有谁失败,
      // 而两者的传播完全不同(见 `@contracts/nodeType` 的 `NodeOutcomeStatus`)。它独自拖着
      // 的那条支路会跟着作废,而汇合点因为 `effectiveUpstreamOf` 会忽略 `unselected`,照常跑。
      //
      // 被触发的那个开跑前就预置了结局(见 `entry`),所以它在上面那一句 `continue` 里。
      if (this.isTrigger(node.id) && node.id !== this.entry?.nodeId) {
        this.settle(node, unselected("这次不是这个触发器起的"));
        moved = true;
        continue;
      }
      const all = this.deps.get(node.id) ?? [];
      if (all.length === 0) continue; // 根节点没有"来路"可言,永远走得到。
      // **一条有效来路都没有** = 这一步不在用户走的那条路上。两种来源在这里合流了:
      // 边被分支挡掉了,或者来路上的那个节点自己就没走(见 `effectiveUpstreamOf`)。
      const effective = this.effectiveUpstreamOf(node.id);
      if (effective.length === 0) {
        const cutBy = this.cutByOf(node.id);
        this.settle(
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
      const settled = effective.filter((up) => this.outcomes.has(up));
      if (settled.length < effective.length) continue;
      // 走到这里说明**有效上游全都定案了、而且至少有一个不是成功**。剩下那种"全是
      // `unselected`"的情况上面已经被 `effective.length === 0` 拦掉了 —— 所以这里是
      // 实实在在的失败,不是"没走"。
      const broken = settled.filter((up) => this.outcomes.get(up)?.status !== "success");
      if (broken.length === 0) continue;
      this.settle(node, {
        status: "skipped",
        summary: "",
        error: `上游「${this.titleOf(broken[0] as string)}」没有成功`,
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
    const limit = this.ports.maxParallel?.() ?? Infinity;
    const cap = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : Infinity;
    for (const node of this.doc.nodes) {
      if (this.inflight.size >= cap) break;
      if (this.outcomes.has(node.id) || this.inflight.has(node.id)) continue;
      const effective = this.effectiveUpstreamOf(node.id);
      if (effective.every((up) => this.outcomes.get(up)?.status === "success")) this.start(node);
    }

    if (this.inflight.size > 0) {
      // 等**任意一个**落地再重扫 —— 不是等这一批全跑完。差一个慢节点不该拖住
      // 它下游那条链的开始时间。
      await Promise.race(this.inflight.values());
      continue;
    }
    if (!moved) break;
  }

  // 取消之后在飞的那几个也要等回来:它们会带着 cancelled 收场(执行器收到 signal
  // 之后应当尽快停),不等的话它们的结果会晚于 `RunResult` 落到 `outcomes` 上。
  while (this.inflight.size > 0) await Promise.race(this.inflight.values());

  // 剩下的两种可能:被取消了,或者图里有环(那些节点永远等不到依赖就绪)。
  // 后者不该出现(`validateDag` 在存盘时就拦了),但真出现了要**说出来**而不是
  // 让它们永远停在"没跑"上。
  for (const node of this.doc.nodes) {
    if (this.outcomes.has(node.id)) continue;
    this.settle(node, cancelledOrStuck(this.signal.aborted));
  }

  const list = [...this.outcomes.values()];
  const status = this.signal.aborted
    ? "cancelled"
    : list.some((o) => o.status === "failed")
      ? "failed"
      : "success";
  // **收尾这一下也要写出去。** 它把 `awaiting` 收成 `null`(上一句已经把它清了)、
  // 把最后一次抹环/定案的结果带上 —— 少了它,最后一次变动只活在内存里,而进程随时
  // 可能死。横竖只有一次,便宜。
  this.publish();
  return { status, outcomes: this.outcomes, state: this.stateOf() };
  }
}

/** 跑一张图 —— **唯一入口**，后面的活全在 {@link Run} 里。 */
export async function runWorkflow(args: RunArgs): Promise<RunResult> {
  return new Run().run(args);
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
