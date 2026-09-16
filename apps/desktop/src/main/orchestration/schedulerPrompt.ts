/**
 * 提示词这一层 —— **一个节点这一轮收到的提示词,长什么样,由这里说了算**。
 *
 * ## 为什么从 scheduler.ts 拆出来
 *
 * 那个文件原来有两件事:一件是**调度**(谁可以跑、什么时候跑、失败怎么传),另一件是
 * **拼提示词**(流程位置怎么摆、上游产出怎么分段、记录怎么渲染)。两件事变更的理由
 * 不一样 —— 前者动是因为调度语义变了,后者动是因为**给模型看的话术**要改。挤在一个
 * 文件里,改一句话术要在两千行的调度逻辑里找位置。
 *
 * ## 依赖只进不出
 *
 * 本模块是**纯的**:输入是图、上游产出、流程记录、资料行,输出是字符串。不碰
 * `RunPorts`、不碰会话、不碰调度状态、不做任何 I/O。scheduler.ts import 本模块,
 * **本模块绝不 import scheduler.ts** —— 需要的数据类型(`PlanStep` / `Arrival` /
 * `AskAnswer` / `FlowRecordEntry`)随函数一起住在这一层,它们本来就是提示词的原料。
 *
 * `findStep` 和 `askSection` 也导出给 scheduler.ts 用:前者是终末节点的判断依据
 * (提示词里说的"你是最后一步"和调度器查产出的行为必须是同一份),后者要用节点标题
 * 渲染"运行前先问我"的回答,而标题只有调度那一层有。
 */
import { topoLayers, nodesWithDownstream, type WorkflowDoc } from "@contracts/workflow";
import type { NodeOutcome } from "@contracts/nodeType";
import { outputValueText } from "@contracts/outputConstraint";
// 资料的**形状**和那几个词来自 `contextInherit`(它是认类目那一端)。这一层只负责
// **怎么摆** —— 不碰库,也不需要知道"哪个 id 属于哪一类"是怎么查出来的。
import {
  KIND_LABEL,
  LEVEL_LABEL,
  contextPurposeOf,
  type ContextLine,
} from "./contextInherit.js";

/* ────────────────────────── 整条流程 ────────────────────────── */

/** 流程里的一步。 */
export interface PlanStep {
  id: string;
  /** 它叫什么(用户起的标题,没起就用类型 id)。 */
  title: string;
  /** 它有没有下游。没有的话,它的产出就是用户最后看到的那个。 */
  isLast: boolean;
}

/**
 * **整条流程**,按执行顺序分层。同一层里的几步是**同时**做的。
 *
 * 这是给模型看的那份"计划":一个节点要知道自己在整件事里的位置,才知道自己该交什么、
 * **不该**交什么。
 */
export type WorkflowPlan = PlanStep[][];

/**
 * 从图上算出这份计划。
 *
 * 分层直接用 `topoLayers`(画布自动布局用的那一份)—— **两处必须是同一个顺序**:
 * 画布上从上到下的层次,和模型读到的"第几步"要是一回事,不然用户在界面上看到的流程
 * 和模型理解的流程对不上。
 */
export function planOf(doc: WorkflowDoc, titleOf: (id: string) => string): WorkflowPlan {
  const layers = topoLayers(doc.nodes, doc.edges);
  // 谁有下游**和界面共用同一个函数**(见 `nodesWithDownstream`):界面拿它提示"后面
  // 没有别的步骤了",这里拿它写"你是最后一步" —— 两处对不上,用户看到的和模型读到的
  // 就是两回事,而且不报错。
  const hasDownstream = nodesWithDownstream(doc);
  const byLayer = new Map<number, PlanStep[]>();
  for (const node of doc.nodes) {
    const at = layers.get(node.id) ?? 0;
    const step: PlanStep = {
      id: node.id,
      title: titleOf(node.id),
      isLast: !hasDownstream.has(node.id),
    };
    const bucket = byLayer.get(at);
    if (bucket) bucket.push(step);
    else byLayer.set(at, [step]);
  }
  return [...byLayer.keys()].sort((a, b) => a - b).map((k) => byLayer.get(k) as PlanStep[]);
}

/**
 * 「整条流程」—— 这一节**每一轮都发给每一个节点**,所以它要短。
 *
 * ## 为什么把整条流程都告诉它
 *
 * 只写"你上面有 2 步、下面有 1 步"信息量太少:节点知道自己是第几步,却不知道**别人
 * 在干什么**。而"我后面那一步叫「写初稿」"这件事,直接决定了它这一轮该怎么交东西 ——
 * 知道下游要写初稿,它就不会去写正文;只知道"后面还有一步",它没法定这个判断。
 *
 * ## 只给**名字**,不给各自的指令
 *
 * 两步都是刻意的:
 *
 *  - **别人的指令对它没用**,那是别人的活,说了只是白烧 token(指令可能很长);
 *  - 更要紧的是,**说了会引诱它越界** —— 看见"写初稿"要写哪些章节,它顺手就写了,
 *    而我们要的恰恰是它别写。
 *
 * ## 位置按**层**给,不按线性序号
 *
 * 同一层里的几步**之间没有先后**(这不是"大概同时",是能证的:一层的定义就是"上游层
 * 的最大值 + 1",所以同层的两个节点之间不可能有路径)。拉成一条"1、2、3"会撒一个谎
 * ——好像它们排着队。所以并列的写成一行,并说明它们之间没有先后。
 */
function planSection(plan: WorkflowPlan, nodeId: string, hasUpstreamText: boolean): string {
  const total = plan.reduce((n, layer) => n + layer.length, 0);
  if (total <= 1) {
    // 只有一步:没有"位置"可言,别硬凑一段。
    return "## 流程位置\n本流程只有一步,即你负责的这一步。";
  }

  const mine = findStep(plan, nodeId);
  const lines: string[] = [
    "## 流程位置",
    `本流程共 ${total} 步,每一步由一名独立的助手完成,彼此之间不共享上下文。你负责其中一步:`,
    "",
  ];
  plan.forEach((layer, i) => {
    const names = layer.map((s) => s.title).join("、");
    const parallel = layer.length > 1 ? "(这几步之间没有先后)" : "";
    const here = layer.some((s) => s.id === nodeId) ? " ← 你在这里" : "";
    lines.push(`${i + 1}. ${names}${parallel}${here}`);
  });
  lines.push("");

  const myIndex = plan.findIndex((layer) => layer.some((s) => s.id === nodeId));
  // ⚠️ **两个条件缺一不可。** 这句是一句**指路的话**("在下方"),下面真有那一段它才
  // 成立。`myIndex > 0` 只说明"图上有上游",而**上游那一段可能压根没拼** —— 指令里
  // 点名引用过的那几步会被跳过(见 `referencedNodeNamesIn`),全被点名时就一段都没有。
  // 那时这句话会把模型支到一片空白上,而它多半会自己编一份"上游产出"出来。
  if (myIndex > 0 && hasUpstreamText) {
    lines.push("上游各步的产出见下方。");
  }
  if (mine?.isLast === true) {
    lines.push(
      "你负责的是最后一步:你的产出即用户最终看到的结果。写到用户可以直接使用为止,无需为下游留任何东西。",
    );
  } else {
    lines.push(
      `本次你只需完成「${mine?.title ?? nodeId}」这一步。其余步骤由其他助手承担 —— ` +
        "代它们完成不会提升最终结果的质量,只会使同一部分内容被重复产出。",
    );
  }
  return lines.join("\n");
}

/** 这一步在流程里的哪一格。找不到返回 undefined(不该发生:`planOf` 是拿同一份图算的)。 */
export function findStep(plan: WorkflowPlan, nodeId: string): PlanStep | undefined {
  for (const layer of plan) {
    const hit = layer.find((s) => s.id === nodeId);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * `## 这一步可以读的资料` 那一段的正文 —— **按"拿来干什么"分两组**。
 *
 * 文献/教材/笔记和模版是**两种东西**,不是同一个集合的两种颜色:
 *
 * - **查资料**:事实、方法、数据在里面,用它是**从里面找东西**;
 * - **仿格式**:要的是**样子** —— 排版、章节结构、措辞口吻,照着它写,内容写这一步自己的。
 *
 * 平铺成一个列表摆出去,模型多半会把模版当资料读(于是抄了里面的内容),或者把一篇
 * 文献当成格式样板。用户提这条时说的就是这两句话:「模版的话是仿写,借鉴格式这种;
 * 文献、教材、笔记这些是用来查询资料的」—— 所以**每一组都带一句"它是拿来干什么的"**,
 * 而不是只给个类目名让模型自己猜。
 *
 * 一组里没有东西时那一组整个不出现(只勾了模版的节点不该看见"当资料查"这几个字)。
 * 组内的顺序就是 {@link inheritContextLines} 给的顺序(跟着主提示词),组与组之间按
 * 固定次序 —— **跨组的先后不再等于主提示词里的先后**,这是分组换来清晰度的代价,
 * 而且它只影响"先看到哪一条",不影响拿到什么。
 */
function renderContextLines(lines: readonly ContextLine[]): string {
  const groups: ReadonlyArray<{ purpose: "material" | "format"; head: string }> = [
    {
      purpose: "material",
      head: "**当资料查** —— 读取其内容,事实、方法、数据均在其中:",
    },
    {
      purpose: "format",
      head:
        "**当格式仿** —— 参照其形式(排版、章节划分、措辞口吻)," +
        "内容写这一步自己的,不要搬用其中的原话:",
    },
  ];
  const out: string[] = [];
  for (const group of groups) {
    const mine = lines.filter((l) => contextPurposeOf(l.kind) === group.purpose);
    if (mine.length === 0) continue;
    out.push(group.head);
    for (const line of mine) {
      out.push(`- 【${KIND_LABEL[line.kind]}·${LEVEL_LABEL[line.level]}】@${line.path}`);
    }
    out.push("");
  }
  return out.join("\n").trimEnd();
}

/**
 * 这一步是**从哪条出路来的** —— 只有它的上游里有分支节点时才有。
 *
 * 这是"选项带一句附言"那条设计的落点:同一个节点可以从几条不同的路走到(「再来一轮」
 * 和「大改」最后都进「写作②」),而它该怎么做,取决于**用户刚才选的是哪一条**。
 *
 * ## 为什么不给节点配"按入边分"的多套指令
 *
 * 那是个更直接的方案:指令那一栏做成下拉框,每条入边一套。没这么做,有三个理由:
 *
 * 1. **一个格子两套指令,"这一步是什么"就模糊了。** 点开「写作②」看见两个指令框,
 *    得先想"这次是从哪条路来的"才知道该改哪个。
 * 2. **维度会打架。** 指令按入边分,而上游结果按节点分 —— 现在是两套维度。它们能
 *    对上,只是因为每个节点只有一条**活跃**入边(见 `liveUpstreamOf`);一旦真有两条
 *    活跃入边,上游拼接也得跟着分叉,复杂度是乘起来的。
 * 3. **差别大到值得配两套指令的时候,那本来就是两个节点。** 图上看得见,各自的产出也
 *    分开,排查时不会混。
 *
 * 所以差异由**边上那句话**补(见 `@contracts/workflow` 的 `WorkflowEdgeSchema` 的
 * `note`),再加用户在选择时临时写的那一句。两者都短,而"这一步要做什么"仍然只有一份,
 * 写在节点的指令里。
 */
export interface Arrival {
  /** 那个岔路口叫什么(分支节点的标题)。 */
  from: string;
  /** 用户点的那一项叫什么。 */
  label: string;
  /** 画图时写在那条边上的话(对这条路上的每一步都成立)。 */
  note: string;
  /** 用户在选择时临时写的那句话(只对这一次成立)。 */
  comment: string;
}

/**
 * `## 这一步之前,用户选了一条路` 那一段。
 *
 * 摆在**指令前面、和「上游步骤的结果」挨着** —— 它和"上游给了什么"是同一类东西:
 * 这一步开工之前就成立的事实。而**不拼进指令里**:指令是用户写的文本,运行时往里塞
 * 东西会让"我写的"和"它实际收到的"对不上(同 `MAIN_DEFAULT_INSTRUCTION` 那条 ——
 * 宁可让模型自己判,也不静默改写用户的字)。
 *
 * 三样东西的详略是刻意的:选了什么(一句)、那个选项的作者说明(画图时就写好的)、
 * 用户此刻临时说的(只对这一次成立)。第三样常常没有,没有就整句不出现。
 */
function arrivalSection(arrival: Arrival): string {
  const lines = [
    "## 本次执行的前置选择",
    `上一处分支「${arrival.from}」中,用户选择的是「${arrival.label}」。`,
  ];
  if (arrival.note.length > 0) lines.push(arrival.note);
  if (arrival.comment.length > 0) lines.push(`用户补充说明:${arrival.comment}`);
  return lines.join("\n");
}

/**
 * 节点上那个「运行前先问我」得到的回答。见 `@contracts/nodeType` 的 `NODE_ASK_PARAM_KEY`。
 *
 * 只有 `ASK_RUN_CHOICE`("用这一步的指令")会走到提示词里 —— 另外三条都不跑这一步
 * (`skip` / `exit` 标成"没走这条路",`repeat` 去重跑上一步了),没有提示词可言。
 * 所以它渲染的措辞是**这一步自己**被问了,而不是 {@link arrivalSection} 那种"上一处
 * 分支"。两段共用同一个标题:对模型来说,它们说的是同一件事 —— "用户在这次执行之前
 * 拍过一个板"。
 */
export interface AskAnswer {
  /** 用户点的那一项叫什么(界面上的字)。 */
  label: string;
  /** 他在框里补的话。空串 = 没写。 */
  comment: string;
}

/** 渲染成「本次执行的前置选择」那一段。标题要用节点名,所以由调度那一层调。 */
export function askSection(nodeTitle: string, answer: AskAnswer): string {
  const lines = [
    "## 本次执行的前置选择",
    `轮到「${nodeTitle}」时,用户选择的是「${answer.label}」。`,
  ];
  if (answer.comment.length > 0) lines.push(`用户补充说明:${answer.comment}`);
  return lines.join("\n");
}

/**
 * 流程记录里的一条。
 *
 * 两种条目,按**谁做了这件事**分:某一步的产出,或者用户在岔路口做的一次决定。后者
 * 必须单独成条 —— 它不在任何一步的产出里,而"用户先后要求过什么"恰恰是迭代型流程
 * 里最值钱的信息(见 {@link flowRecordSection})。
 */
export type FlowRecordEntry =
  | {
      kind: "step";
      /** 哪个节点。回头重跑时靠它认出"上一次那条"并换掉(见 `appendStep`)。 */
      nodeId: string;
      /** 图上的标题(用户起的那个)。 */
      title: string;
      /** 这一步第几次跑。回头绕第二圈时是 2 —— 不标的话,同一节出现两次会像重复。 */
      round: number;
      /** 它交出来的东西。见 {@link recordBodyOf}。 */
      body: string;
    }
  | {
      kind: "user";
      /** 那处分支叫什么。 */
      from: string;
      /** 用户点的那条出路叫什么。 */
      label: string;
      /** 画图时写在那条边上的说明(对这条路上的每一步都成立)。 */
      note: string;
      /** 他当时另外写的那句话(只对这一次成立)。 */
      comment: string;
    };

/**
 * 流程记录里,**某一步的那一段**该怎么写。
 *
 * 分两种,判据是这一步**有没有声明产出变量**(见 `@contracts/outputConstraint`):
 *
 * - **声明了**(「核对引用」交了 `可引文献` / `没核到的`)→ **按变量名展开**:每个变量
 *   一行,`- 名字:值`。**丢掉 JSON 的花括号和引号** —— 那是给机器读的形状,而读这段的
 *   是模型;更要紧的是,展开之后它读到的词和它自己指令里写的词**一模一样**(指令说
 *   "只引「可引文献」里那几条",它看到的就是 `- 可引文献:…`),对得上。
 * - **没声明**(「成稿」交的就是正文)→ **整段照给**。它交什么就是什么,不加工。
 *
 * 两种都不会丢内容:变量之外的话仍在那一步的 `summary` 里,只是不进记录 —— 记录要的是
 * **产出**,不是过程。
 */
export function recordBodyOf(outcome: NodeOutcome): string {
  const outputs = outcome.outputs;
  const names = outputs === undefined ? [] : Object.keys(outputs);
  if (names.length === 0) return outcome.summary;
  const lines: string[] = [];
  for (const name of names) {
    const value = outputs?.[name];
    // 值是数组/对象的原样 `JSON.stringify` —— 记录是散文式的日志,但**结构化状态该
    // 保持结构**(同 Anthropic 那条"状态用结构化格式、进度用散文")。转换收口在
    // outputConstraint.outputValueText(runner 的变量卡片用同一条规则)。
    const text = outputValueText(value);
    if (text.length === 0) continue;
    lines.push(`- ${name}:${text}`);
  }
  return lines.length > 0 ? lines.join("\n") : outcome.summary;
}

/**
 * `## 流程记录` 整段 —— **这条流程做到哪儿了,只此一处**。
 *
 * ## 它是什么
 *
 * 一条按**完成的先后**排列的日志,两份内容:
 *
 *  1. **开头是这条流程本身** —— 它叫什么、是干什么的、用户最初要的是什么。缺了它,
 *     记录就只是一串产出,而读的人(下一个助手)不知道它们**凑在一起是为了什么**;
 *  2. **然后是每一步的产出**,以及用户在每处岔路口做的选择。
 *
 * ## 为什么是散文式的日志,不是一张表
 *
 * 参照 Anthropic 的提示工程指引:**状态数据用结构化格式,进度用散文**。这里要的是
 * "事情发生的经过",而经过天然是按先后叙述的 —— 排成一个 JSON 数组不会更清楚,只会
 * 把标点和引号也一起塞进上下文。
 *
 * ## 为什么开头那两行非有不可
 *
 * 流程记录**替代**了「上游步骤的产出」那一段(见 `composeNodePrompt`):节点不再只看到
 * 直接上游,而是看到全程。全程的代价是**没有边界** —— 一串产出看不出它属于哪件事。
 * 开头两行就是那条边界。
 */
export function flowRecordSection(args: {
  name: string;
  description: string;
  userPrompt: string;
  entries: readonly FlowRecordEntry[];
}): string {
  const lines: string[] = ["## 流程记录"];
  const name = args.name.trim();
  const description = args.description.trim();
  if (name.length > 0 && description.length > 0) {
    lines.push(`**本流程**:${name} —— ${description}`);
  } else if (name.length > 0 || description.length > 0) {
    lines.push(`**本流程**:${name || description}`);
  }
  if (args.userPrompt.trim().length > 0) {
    lines.push(`**用户最初的要求**:${args.userPrompt.trim()}`);
  }
  if (args.entries.length > 0) {
    lines.push("", "以下是本流程至今各步骤的产出,按完成的先后排列。");
  }
  for (const entry of args.entries) {
    lines.push("");
    if (entry.kind === "user") {
      lines.push("### 用户的选择");
      lines.push(`在「${entry.from}」处选择「${entry.label}」。`);
      if (entry.note.length > 0) lines.push(entry.note);
      if (entry.comment.length > 0) lines.push(`用户补充说明:${entry.comment}`);
      continue;
    }
    lines.push(entry.round > 1 ? `### ${entry.title}(第 ${entry.round} 轮)` : `### ${entry.title}`);
    // **跑过但没交东西的步骤也要留一行。** 记录是"发生了什么的日志",缺一条比多一行
    // 更误导:后来的助手会以为这一步没做过 —— 而它可能正是"为什么某样东西不存在"的原因。
    lines.push(entry.body.trim().length > 0 ? entry.body.trim() : "(这一步没有产出文本)");
  }
  return lines.join("\n");
}

/**
 * 一个节点这一轮到底看到什么。**这是"节点间怎么传值"的全部规则**,单独提出来
 * 是为了让它可断言(见冒烟)。
 *
 * - **根节点**(没有上游)拿的是**用户这次发的请求** + 本步指令;
 * - **非根节点**拿的是**上游结果** + 本步指令。
 *
 * 非根节点**看不到用户原话** —— 这是刻意的,也是参照物 wisp 的设计:子任务之间不
 * 共享对话记录,依赖结果显式传递。好处是 token 不随图的大小线性膨胀(这个功能存在
 * 的理由之一就是省 token);代价是**非根节点的指令必须自足** —— 它不能写"根据上面的
 * 问题",因为"上面的问题"不在它的上下文里。这条写进了节点类型的 README。
 *
 * ## 「整条流程」这一段为什么非有不可
 *
 * 图上每个节点都是**各自独立的会话**,互相看不见。于是最常发生的一种跑法是:第一步
 * 收到"用户要一篇综述"+"让我生成计划",它**把整篇综述写完了** —— 因为从它的角度看,
 * 用户就是要一篇综述,而"生成计划"像是句补充说明。下游于是拿到一份成品,没活可干,
 * 用户看到的现象是"第一步就把活干完了,后面没传下去"。
 *
 * 这不是模型不听话,是**它不知道自己在一条流程里**。"整条流程长什么样"是**只有代码
 * 知道**的事实(图在数据库里),所以必须由代码告诉它 —— 让它从上下文里猜是猜不出来的
 * (见 `@contracts/nodeTemplate` 文件头那条"能代码做就别让模型判断")。
 */
export function composeNodePrompt(args: {
  userPrompt: string;
  upstream: string;
  instruction: string;
  /** 这一步是谁 —— 用它去 {@link WorkflowPlan} 里找自己的位置。 */
  nodeId: string;
  /** **整条流程**。见 {@link planOf} 与 {@link planSection}。 */
  plan: WorkflowPlan;
  skills?: string[];
  /** **已经筛好的**资料(见 {@link ContextLine})。渲染成 `## 这一步可以读的资料` 那一段。 */
  context?: readonly ContextLine[];
  /** 这一步是从哪条出路来的(上游有分支节点时才有)。见 {@link Arrival}。 */
  arrival?: Arrival;
  /**
   * **「运行前先问我」那一次的回答**,已经渲染好的一段(见 {@link askSection})。
   *
   * ⚠️ **和 `arrival` 不一样,读了记录也照样给。** 记进流程记录的只有"重复上一个任务"
   * 那一次(它是给**重跑的那一步**看的,见 `askOne`);而"用这一步的指令"是**这一次执行
   * 怎么跑**的说明,哪一次都得摆在这儿。
   */
  ask?: string;
  /**
   * **整条流程的记录**(已经渲染好的整段,见 {@link flowRecordSection})。
   *
   * 给了它就**替代** `upstream`:记录里本来就含着上游那几段的产出,两段都给就是同一份
   * 内容出现两遍。谁给谁不给由节点上那个开关决定 —— 见 `NODE_FLOW_RECORD_PARAM_KEY`。
   */
  record?: string;
  /** 「这一步要产出什么」的**文字说明**(软约束,见 `@contracts/outputConstraint`)。 */
  outputContract?: string;
  /** 「这一步要产出什么」的**变量表**(硬约束,已经渲染成给模型看的样例;空串 = 没有)。 */
  outputVars?: string;
}): string {
  // 第 0 层就是根:有上游的节点一定在 ≥1 层(层 = 上游层最大值 + 1)。
  const isRoot = args.plan.findIndex((layer) => layer.some((s) => s.id === args.nodeId)) === 0;
  const sections: string[] = [];
  const record = (args.record ?? "").trim();
  const hasRecord = record.length > 0;
  // **这一步手上到底有没有"上游的东西"** —— 位置那一节里那句指路的话得跟着它走
  // (见 `planSection` 里那个判断)。读了记录的话,记录本身就是那份东西。
  const hasUpstreamText = hasRecord || args.upstream.trim().length > 0;
  // **放在最前面**:它是这一整段话的读法说明。摆在后面的话,模型已经先读过"用户要
  // 一篇综述"了,那时再告诉它"你只负责第一步"是往回拽,效果差得多。
  sections.push(planSection(args.plan, args.nodeId, hasUpstreamText));
  if (isRoot && args.userPrompt.trim().length > 0) {
    sections.push(`## 用户的请求\n${args.userPrompt.trim()}`);
  }
  // 用户刚才在岔路口选了什么。**在产出前面** —— 先知道"为什么轮到我了",再看"我手上
  // 有什么",最后才是"我要做什么"。
  //
  // ⚠️ **读了记录就不再有这一段**:那次选择已经作为一条日志写在记录里了(见
  // `FlowRecordEntry` 的 `user` 那一支)。两处都写就是同一件事说两遍,而记录里那一份
  // 还带着"这是第几轮"的上下文。
  if (args.arrival && !hasRecord) sections.push(arrivalSection(args.arrival));
  // 「运行前先问我」那一次的回答。紧挨着 `arrival` —— 对模型来说它们是同一类东西
  // ("开跑之前用户拍了个板"),连标题都是同一个。**但这一条读了记录也照样给**,理由见
  // `composeNodePrompt` 的参数说明。
  if (args.ask !== undefined && args.ask.length > 0) sections.push(args.ask);
  if (hasRecord) {
    sections.push(record);
  } else if (hasUpstreamText) {
    sections.push(`## 上游步骤的产出\n${args.upstream.trim()}`);
  }
  if ((args.skills?.length ?? 0) > 0) {
    // 写成 `/名字` —— 和输入框里那种技能药丸同一种写法,模型认得。**这只是提示**:
    // 真正让技能可用的是随这一轮发下去的允许清单(`StartTurnRequest.skills`),光有
    // 这几行字,模型照样调不动 Skill 工具。两件事都要做,少一件就是"写了但没用"。
    sections.push(
      `## 这一步要用的技能\n${(args.skills ?? []).map((s) => `- /${s}`).join("\n")}`,
    );
  }
  if ((args.context?.length ?? 0) > 0) {
    sections.push(
      "## 这一步可以读的资料\n以下是主对话中挂载的资料。方括号内是它的类别," +
        "`@` 之后是它的清单文件路径 —— 用读文件的工具打开,清单中列出具体条目及各自的路径:\n\n" +
        renderContextLines(args.context ?? []),
    );
  }
  sections.push(args.instruction.trim());
  // 产出要求放在**指令之后** —— 它是"做完这件事之后该交什么",顺着读下来才是那个
  // 顺序。两段(文字的说明 + 变量表拼出来的样例)合成**一节**:它们说的是同一件事,
  // 拆成两节会让模型以为要满足两组互不相干的要求。
  const outputParts = [
    (args.outputContract ?? "").trim(),
    (args.outputVars ?? "").trim(),
  ].filter((s) => s.length > 0);
  if (outputParts.length > 0) {
    sections.push(`## 这一步要产出什么\n${outputParts.join("\n\n")}`);
  }
  return sections.join("\n\n");
}
