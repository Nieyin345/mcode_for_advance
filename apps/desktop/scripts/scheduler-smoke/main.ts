/**
 * Headless smoke for 批次 E 的调度器(`main/orchestration/scheduler.ts`)。
 *
 * 方案给批次 E 定的验收是四条:**同列真的并发 / 依赖真的严格 / 失败真的传播 /
 * 取消真的停**。这四条只有在能塞一个假执行器进来的情况下才断言得了 —— 真的跑一遍
 * 会需要 Electron、会话、模型。所以调度器是纯的(`RunPorts` 注入),这里塞一个
 * "记录开始/结束时间戳、可配置延迟与失败"的假执行器。
 *
 * 另外覆盖三件同属这一层的事:
 *   - **前置检查**:类型没装 / 执行方式没实现 / 参数不齐 —— 三种都要**明确失败**,
 *     而且失败要往传播(下游不派发)。
 *   - **提示词拼装**(`composeNodePrompt`):根节点拿用户请求,非根节点拿上游结果。
 *   - **变量与产出**:`{{...}}` 在跑之前解(解不出来就失败),产出里少了几样东西在跑
 *     之后查(少一样也失败)。两件事是同一套"代码说了算"的两头,所以放一起测。
 *   - **收尾**:没跑到的节点不能在 `outcomes` 里缺席(取消 / 图里有环两种)。
 *
 * 真跑一个节点(建隐藏会话、起 turn、把结果变成卡片)在 `runner.ts`,**不在这里** ——
 * 那一层要的是端到端手动验收。
 *
 * Run: scripts/scheduler-smoke/run.sh
 */
import {
  attachmentPathsIn,
  contextKindOfPath,
  contextPurposeOf,
  contextRefOfPath,
  inheritContextLines,
  type ContextLine,
  type ContextLookup,
} from "@main/orchestration/contextInherit.js";
import {
  runWorkflow,
  type BranchChoice,
  type RunPorts,
  type RunReport,
  type RunResume,
  type RunState,
} from "@main/orchestration/scheduler.js";
// 提示词拼装拆到了自己的模块 —— 这里测的就是它的公开接口。
import {
  composeNodePrompt,
  planOf,
  type WorkflowPlan,
} from "@main/orchestration/schedulerPrompt.js";
import { dirname, join, resolve } from "node:path";
import {
  renderTemplate,
  type NodeTemplateScope,
} from "@contracts/nodeTemplate";
import {
  checkOutput,
  describeOutputVars,
  outputExampleOf,
  validateOutputRules,
} from "@contracts/outputConstraint";
import type { WorkflowChoiceOption } from "@contracts/runtime";
import { BRANCH_STOP_CHOICE } from "@contracts/nodeType";
import {
  ASK_EXIT_CHOICE,
  ASK_REPEAT_CHOICE,
  ASK_RUN_CHOICE,
  ASK_SKIP_CHOICE,
} from "@contracts/nodeType";
import type { NodeContextKind, NodeOutcome, NodeTypeManifest } from "@contracts/nodeType";
import type { WorkflowDoc, WorkflowEdge, WorkflowNode } from "@contracts/workflow";

let failures = 0;
let total = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

/* ────────────────────────── fixtures ────────────────────────── */

const AGENT: NodeTypeManifest = {
  id: "mcode.agent",
  manifestVersion: 1,
  name: "子 agent",
  runner: { kind: "prompt" },
  capability: "read",
  params: [
    { key: "instruction", kind: "longtext", label: "指令", required: true },
    // 技能:**约定键**,引擎按名字去 params 里取(见 `NODE_SKILLS_PARAM_KEY`)。
    { key: "skills", kind: "ref", from: "skills", multiple: true, label: "技能" },
    // MCP 服务器 / 插件:同一条约定(见 `NODE_MCP_PARAM_KEY` / `NODE_PLUGINS_PARAM_KEY`)。
    // 这两个和技能并列出现在夹具里,是因为它们在调度器这一层是**同一句话的三个宾语**
    // —— 不填 = 不限制,填了 = 只要这几个。下面那组断言盯的就是这条一致性。
    { key: "mcp", kind: "ref", from: "mcp", multiple: true, label: "MCP 服务器" },
    { key: "plugins", kind: "ref", from: "plugins", multiple: true, label: "插件" },
    // 上下文:**约定键**,候选写死在清单里(所以是 select 而不是 ref)—— 见
    // `NODE_CONTEXT_PARAM_KEY`。
    {
      key: "context",
      kind: "select",
      multiple: true,
      label: "上下文",
      options: [
        { value: "paper", label: "文献" },
        { value: "note", label: "笔记" },
      ],
    },
    { key: "provider", kind: "ref", from: "models", label: "引擎" },
    // 产出:一段大白话的说明 + 一张「变量名 + 示例」的表(见 `@contracts/outputConstraint`)。
    // **夹具里必须真带上它们** —— 变量表只在"清单声明过 outputVars"时才生效,夹具漏了
    // 这一条,下面那些断言测的就是一条真实清单根本不会走的路。
    { key: "outputContract", kind: "longtext", label: "期望产出" },
    { key: "outputVars", kind: "variables", label: "产出变量" },
  ],
};

/** 形状对、但执行没实现的那种(见 `isRunnerImplemented`)。 */
const SHELL: NodeTypeManifest = {
  id: "x.shell",
  manifestVersion: 1,
  name: "跑脚本",
  runner: { kind: "command", entry: "run.sh" },
  capability: "exec",
  params: [],
};

/** 提示词类型,但**没把指令标成必填** —— 校验过得了,拼提示词时才暴露。 */
const LOOSE: NodeTypeManifest = {
  id: "x.loose",
  manifestVersion: 1,
  name: "没指令的提示词节点",
  runner: { kind: "prompt" },
  capability: "read",
  params: [],
};

/** 岔路口:不跑东西,把决定权交给用户(见 `@contracts/nodeType` 的 `branch`)。 */
const BRANCH: NodeTypeManifest = {
  id: "mcode.branch",
  manifestVersion: 1,
  name: "分支",
  runner: { kind: "branch" },
  capability: "read",
  params: [],
};

/**
 * 「对话节点」:也跑一轮模型,但**跑在主对话里**(见 `conversation` 那种执行方式)。
 *
 * 它和 `prompt` 的差别只有一个"在哪儿跑",而**那件事调度器管不着** —— 调度器只负责
 * 把提示词拼好、交给执行器、等产出(见 `orchestration/runner.ts` 的 `runInConversation`)。
 * 这张夹具就是来钉这一条的:它**不能**像 `SHELL` 那样被当成"没实现的执行方式"挡下来。
 */
const CONVERSATION: NodeTypeManifest = {
  id: "mcode.conversation",
  manifestVersion: 1,
  name: "对话节点",
  runner: { kind: "conversation" },
  capability: "read",
  params: [
    { key: "instruction", kind: "longtext", label: "指令", required: true },
    // 「运行前先问我」——**参数驱动的调度行为**,不是新的 `runner.kind`(见
    // `@contracts/nodeType` 的 `NODE_ASK_PARAM_KEY`)。夹具里必须真带上它,不然下面那组
    // 断言测的就是一条真实清单根本走不到的路(参数校验会先把 `askBeforeRun` 拒了)。
    { key: "askBeforeRun", kind: "boolean", label: "运行前先问我" },
    // 「读流程记录」。默认关,但**在环上的节点按开算**(见 `readsRecord`)——
    // "重复上一个任务"要让重跑的那一步看见用户那句意见,靠的就是这个开关的默认值。
    { key: "flowRecord", kind: "boolean", label: "读流程记录" },
  ],
};

const MANIFESTS: Record<string, NodeTypeManifest> = {
  [AGENT.id]: AGENT,
  [SHELL.id]: SHELL,
  [LOOSE.id]: LOOSE,
  [BRANCH.id]: BRANCH,
  [CONVERSATION.id]: CONVERSATION,
};

function node(
  id: string,
  type = AGENT.id,
  instruction = `${id} 做什么`,
  extra: Record<string, unknown> = {},
): WorkflowNode {
  return { id, type, title: id, params: { instruction, ...extra }, position: { x: 0, y: 0 } };
}

/** 一个**分支**节点。它没有参数 —— 出路全在边上(`edge` 的 `label` / `note`)。 */
function branchNode(id: string, title = id): WorkflowNode {
  return { id, type: BRANCH.id, title, params: {}, position: { x: 0, y: 0 } };
}

function edge(from: string, to: string, extra: { label?: string; note?: string } = {}): WorkflowEdge {
  return { id: `e_${from}__${to}`, from, to, ...extra };
}

function docOf(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowDoc {
  return { id: "wf_test", name: "测试流程", nodes, edges, builtin: false, updatedAt: 0 };
}

/**
 * 提示词拼装那几个用例用的迷你流程:**规划 →(查文献、算数据)→ 汇总**。
 *
 * 手写而不是 `planOf(...)` 算出来的:那几条测的是**拼装**,喂进去什么就该渲染出什么。
 * 拿被测代码的另一半去生产它的输入,等于两边一起错也看不出来。`planOf` 自己有单测。
 */
const PLAN: WorkflowPlan = [
  [{ id: "A", title: "规划", isLast: false }],
  [
    { id: "B", title: "查文献", isLast: false },
    { id: "C", title: "算数据", isLast: false },
  ],
  [{ id: "D", title: "汇总", isLast: true }],
];

/* ────────────────────────── harness ────────────────────────── */

interface Call {
  id: string;
  start: number;
  end: number;
  prompt: string;
  /** 这一轮带上的技能允许清单 —— 和 `prompt` 是**两件事**,见 `NodeRunInput.skills`。 */
  skills: string[];
  /** 这一轮能用哪几个 MCP 服务器 / 加载哪几个插件(同上的另两个宾语)。 */
  mcpServerNames: string[];
  pluginNames: string[];
  /** 这一步解算出来的引擎(`provider` 约定键)。 */
  providerId?: string;
}

/** 认 signal 的睡眠:被取消时提前醒,好让"取消"能在测试里真的观察得到。 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    if (signal.aborted) done();
    else signal.addEventListener("abort", done, { once: true });
  });
}

interface Harness {
  ports: RunPorts;
  /** 真正被执行器跑过的节点,带时间戳。**"没被派发"就是在这张表里找不到。** */
  calls: Call[];
  reports: RunReport[];
  executed(): string[];
  /** 调度器为每个节点问过的上下文类目 —— 按发生顺序。 */
  contextAsked: NodeContextKind[][];
  /** 调度器在岔路口问过谁、给了哪些出路 —— 按发生顺序。 */
  choicesAsked: Array<{ nodeId: string; options: WorkflowChoiceOption[] }>;
  /** 调度器**直接给了答案、没问**的那些岔路口(`RunResume.answer`,续跑用的)。
   *  它在 `choicesAsked` 里同样出现 —— 两条断言要分开看:"问了没有"和"端口收到
   *  预置答案没有"是两件事。 */
  presetSeen: Array<{ nodeId: string; edgeId: string }>;
  /** 调度器交出来的运行状态(`RunPorts.snapshot`),按发生顺序。落盘的输入就是它。 */
  snapshots: RunState[];
}

function makePorts(opts: {
  fail?: (id: string) => boolean;
  delayMs?: (id: string) => number;
  manifests?: Record<string, NodeTypeManifest>;
  /** 让"取清单"这一步抛错(清单文件读坏了、宿主实现有 bug)。 */
  manifestThrows?: (id: string) => boolean;
  /** 假的上下文继承:主对话"挂了"哪些资料。默认一条都没有。
   *  返回的是**事实**(见 `ContextLine`)—— 和真端口一个形状,不然下面几条断言测的
   *  就不是用户真正看到的那一段。 */
  contextLines?: (kinds: NodeContextKind[]) => ContextLine[];
  /** 执行器交回来的产出文本。默认一句平淡的 `X 的结果` —— 产出约束那几个用例要的是
   *  "这一步交了一段特定形状的东西"。 */
  summary?: (id: string) => string;
  /** 岔路口:用户在选项里点了哪一条。默认点**第一条**。返回 `edgeId` 是**边**的 id
   *  (`options[i].id`),不是节点 id —— 两条出路通向同一步时它们分得开。 */
  pick?: (nodeId: string, options: WorkflowChoiceOption[]) => BranchChoice;
  /** 岔路口"用户想了多久"。配合 `stopAt` 用来测"挂在岔路口时被取消"。 */
  chooseDelayMs?: number;
  /**
   * 扇出闸:假宿主给的"同时最多几个节点在跑"。不接 = 不限(老行为)。
   *
   * 做成**函数**而不是数,是因为真实实现那一头是"每次派发现读设置" ——
   * 冒烟里也要能模拟"跑到一半把它改小"。
   */
  maxParallel?: () => number;
  /**
   * 每次 `execute` 进场时调一下,返回一个"出场"回调。
   *
   * 测并发上限用的:进一次 +1、出一次 −1,那个峰值就是**同时真在跑的节点数**。
   * 光看"起止时间戳有没有重叠"是不够的 —— 那量的是"窗口交不交叠",而这里要的是
   * **同一瞬间**有几个。
   */
  onExecute?: () => () => void;
  /**
   * 用户**一直不回答** —— 这个 promise 落地之前,那一格就停在那儿。
   *
   * 用它把"应用就是在这个等待里被关掉的"这一瞬**钉死**:等待期间调度器交出来的那份
   * 状态,正是重启之后唯一还在的东西(见 `RunResume`)。按节点 id 决定挂住谁 ——
   * 一张图里通常有两处岔路口,而"第一次运行时断在第二处"才是真会发生的那种。
   */
  hold?: (nodeId: string) => Promise<void> | undefined;
} = {}): Harness {
  const calls: Call[] = [];
  const reports: RunReport[] = [];
  const manifests = opts.manifests ?? MANIFESTS;
  const asked: NodeContextKind[][] = [];
  const askedChoices: Array<{ nodeId: string; options: WorkflowChoiceOption[] }> = [];
  const presetSeen: Array<{ nodeId: string; edgeId: string }> = [];
  const snapshots: RunState[] = [];
  const ports: RunPorts = {
    async manifestOf(typeId) {
      // 拿不到清单就拿类型 id 当判据(只有"哪个节点"这件事在用例里重要)。
      if (opts.manifestThrows?.(typeId)) throw new Error(`清单读不出来:${typeId}`);
      return manifests[typeId];
    },
    // **记下问过什么**:调度器有没有真的按节点的参数去要上下文,只看提示词的最终
    // 样子是看不出来的(节点没选任何类目时提示词里同样不该有那一段)。
    contextLines(kinds) {
      asked.push([...kinds]);
      return opts.contextLines?.(kinds) ?? [];
    },
    async execute(target, _manifest, input) {
      const start = Date.now();
      const leave = opts.onExecute?.();
      await sleep(opts.delayMs?.(target.id) ?? 5, input.signal);
      const end = Date.now();
      leave?.();
      calls.push({
        id: target.id,
        start,
        end,
        prompt: input.prompt,
        skills: input.skills,
        mcpServerNames: input.mcpServerNames,
        pluginNames: input.pluginNames,
        providerId: input.providerId,
      });
      if (input.signal.aborted) return { status: "cancelled", summary: "", error: "被取消" };
      if (opts.fail?.(target.id)) {
        return { status: "failed", summary: "", error: `${target.id} 炸了` };
      }
      return { status: "success", summary: opts.summary?.(target.id) ?? `${target.id} 的结果` };
    },
    /** 假的用户:记下问了什么,然后按 `pick` 点一条(默认第一条)。 */
    async choose(target, options, signal, preset) {
      askedChoices.push({ nodeId: target.id, options });
      // **预置答案:不问,直接用。** 续跑时用户刚在旧卡片上点过(见
      // `RunResume.answer`)—— 再问一遍等于把一次已经做过的决定重做一次。
      if (preset !== undefined) {
        presetSeen.push({ nodeId: target.id, edgeId: preset.edgeId });
        return preset;
      }
      // **一直不回答。** 等待这一刻正是"应用被杀掉"可能发生的地方(见 `hold`)。
      const held = opts.hold?.(target.id);
      if (held) await held;
      // 岔路口的"用户在思考"也要认 signal —— 否则测不了"挂在岔路口时被取消"。
      if ((opts.chooseDelayMs ?? 0) > 0) await sleep(opts.chooseDelayMs ?? 0, signal);
      if (signal.aborted) return { edgeId: "" };
      const pick = opts.pick?.(target.id, options) ?? { edgeId: options[0]?.id ?? "" };
      return pick;
    },
    report(e) {
      reports.push(e);
    },
    // 扇出闸。**只在用例给了才接** —— 不接的话 `RunPorts` 上没有这个键,调度器按
    // "不限"处理,正好也就是加这个字段之前的老行为(见下面那条回归断言)。
    ...(opts.maxParallel ? { maxParallel: opts.maxParallel } : {}),
    snapshot(state) {
      snapshots.push(state);
    },
  };
  return {
    ports,
    calls,
    reports,
    executed: () => calls.map((c) => c.id),
    contextAsked: asked,
    choicesAsked: askedChoices,
    presetSeen,
    snapshots,
  };
}

function outcomeOf(h: Harness, id: string): NodeOutcome | undefined {
  return h.reports
    .filter((r): r is Extract<RunReport, { kind: "node.settled" }> => r.kind === "node.settled")
    .find((r) => r.node.id === id)?.outcome;
}

const controller = (): AbortController => new AbortController();

/* ────────────────────── 1. 并发与依赖 ────────────────────── */

console.log("\n并发与依赖");

// A、B 互不依赖(两个根);C 只等 A;D 等 A 和 B。
// 关键:C 只该等 A —— **不该等 B**。所以 B 拖长,C 的开始时间仍然贴着 A 的结束。
const diamond = docOf(
  [node("A"), node("B"), node("C"), node("D")],
  [edge("A", "C"), edge("A", "D"), edge("B", "D")],
);

{
  const h = makePorts({ delayMs: (id) => (id === "A" ? 30 : id === "B" ? 90 : 5) });
  const result = await runWorkflow({
    doc: diamond,
    prompt: "把这件事办了",
    ports: h.ports,
    signal: controller().signal,
  });

  const at = (id: string): Call | undefined => h.calls.find((c) => c.id === id);
  const [a, b, c, d] = ["A", "B", "C", "D"].map(at);

  check("四个节点都跑了", h.calls.length === 4, h.executed());
  check("没有节点被跑两次", new Set(h.executed()).size === 4);
  eq("全成功 → status = success", result.status, "success");

  // 同列(这里就是"互不依赖")真的并发:两个根的时间窗必须重叠。
  check(
    "两个根真的并发(A 与 B 的时间窗重叠)",
    a !== undefined && b !== undefined && a.start < b.end && b.start < a.end,
    { a, b },
  );
  // 依赖真的严格:下游在上游**结束之后**才开始。
  check("C 在 A 结束之后才开始", c !== undefined && a !== undefined && c.start >= a.end, {
    aEnd: a?.end,
    cStart: c?.start,
  });
  // 就绪即派发:C 只等 A,不该被慢的 B 拖住。
  check(
    "C 没有被无关的慢节点 B 拖住(C 在 B 结束前就开跑了)",
    c !== undefined && b !== undefined && c.start < b.end,
    { cStart: c?.start, bEnd: b?.end },
  );
  check(
    "D 在上游里最晚结束的那个之后才开始",
    d !== undefined && a !== undefined && b !== undefined && d.start >= Math.max(a.end, b.end),
    { d },
  );

  const startedCount = h.reports.filter((r) => r.kind === "node.started").length;
  eq("每个节点都报了 started", startedCount, 4);
  eq(
    "每个节点都报了 settled",
    h.reports.filter((r) => r.kind === "node.settled").length,
    4,
  );
}

/* ────────────────── 并发上限(一张图一次能烧几路)──────────────────
 *
 * 一张图跑到某一步时,所有就绪的节点会**同时**起跑,而每个节点是一个独立的隐藏会话 +
 * 一个 CLI 子进程 + 一路模型请求。所以"图有多宽"直接等于"同时烧几路"。
 *
 * 这一节盯两件事:**闸真的起作用**(任意时刻在飞的 ≤ 上限),以及**排队不是失败**
 * (被挡下的那些最后**都跑到了**)—— 第二件同样是重点,只验第一件的话,一个"到上限就
 * 把剩下的丢掉"的实现也能过。
 */

console.log("\n并发上限");

/** 六个互不依赖的根 —— 不限并发的话它们会在同一个 tick 里全部起跑。 */
const wide = docOf(
  ["A", "B", "C", "D", "E", "F"].map((id) => node(id)),
  [],
);

{
  // 上限 2。执行器跑 20ms,期间记一个"同时在跑几个"的峰值。
  let running = 0;
  let peak = 0;
  const h = makePorts({
    delayMs: () => 20,
    maxParallel: () => 2,
    onExecute: () => {
      running += 1;
      peak = Math.max(peak, running);
      return () => {
        running -= 1;
      };
    },
  });
  const result = await runWorkflow({
    doc: wide,
    prompt: "跑六个",
    ports: h.ports,
    signal: controller().signal,
  });

  eq("★ 任意时刻在跑的没超过上限", peak, 2);
  eq("★ 六个最后都跑到了(排队不是失败)", h.calls.length, 6);
  eq("一个都没被跑两次", new Set(h.executed()).size, 6);
  eq("全成功", result.status, "success");
  // 派发顺序是**文档顺序** —— 用户看到的是"按图的先后一批一批来",不是随机。
  eq("头两个是 A、B", h.executed().slice(0, 2).join(","), "A,B");
}

{
  // 上限 ≥ 节点数 = 和今天一模一样(回归)。这一条防的是"加了闸之后把原本并发的弄成串行"。
  let running = 0;
  let peak = 0;
  const h = makePorts({
    delayMs: () => 20,
    maxParallel: () => 99,
    onExecute: () => {
      running += 1;
      peak = Math.max(peak, running);
      return () => {
        running -= 1;
      };
    },
  });
  await runWorkflow({
    doc: wide,
    prompt: "跑六个",
    ports: h.ports,
    signal: controller().signal,
  });
  eq("★ 上限够大时六个一起跑(没有意外串行化)", peak, 6);
}

{
  // ⚠️ **读到一个非法值时不能把图卡死。** 0 / 负数 / NaN 都退回"不限" —— 上限为 0 的话
  // 一个节点都派不出去,而循环会因为"没有在飞的、也没有东西可动"直接退出,现象是
  // "点了运行,什么都没发生"(比多花钱糟得多)。
  for (const bad of [0, -3, Number.NaN]) {
    const h = makePorts({ delayMs: () => 5, maxParallel: () => bad });
    await runWorkflow({
      doc: wide,
      prompt: "跑六个",
      ports: h.ports,
      signal: controller().signal,
    });
    eq(`上限读到 ${String(bad)} 也不卡死(六个都跑了)`, h.calls.length, 6);
  }
}

{
  // 不接 `maxParallel` 这个端口 = 老行为(不限)。这是**向后兼容**那一条:冒烟脚本和
  // 别的宿主实现没接它的时候,一张图照旧全速跑。
  const h = makePorts({ delayMs: () => 5 });
  await runWorkflow({
    doc: wide,
    prompt: "跑六个",
    ports: h.ports,
    signal: controller().signal,
  });
  eq("没接这个端口 = 不限(六个都跑了)", h.calls.length, 6);
}

/* ────────────────────── 2. 失败传播 ────────────────────── */

console.log("\n失败传播");

// A 失败 → C(直接下游)与 E(传递下游)都不该被派发;B 是另一条分支,照常跑完。
const failing = docOf(
  [node("A"), node("B"), node("C"), node("D"), node("E")],
  [edge("A", "C"), edge("C", "E"), edge("B", "D")],
);

{
  const h = makePorts({ fail: (id) => id === "A" });
  const result = await runWorkflow({
    doc: failing,
    prompt: "跑",
    ports: h.ports,
    signal: controller().signal,
  });

  eq("有失败 → status = failed", result.status, "failed");
  eq("失败的节点标 failed", outcomeOf(h, "A")?.status, "failed");
  eq("失败原因来自执行器", outcomeOf(h, "A")?.error, "A 炸了");
  eq("直接下游标 skipped", outcomeOf(h, "C")?.status, "skipped");
  eq("传递下游也标 skipped", outcomeOf(h, "E")?.status, "skipped");
  check(
    "skipped 的原因是「上游没成功」,而且点名是哪一个",
    (outcomeOf(h, "C")?.error ?? "").includes("A"),
    outcomeOf(h, "C")?.error,
  );
  eq("无关分支照常跑完", outcomeOf(h, "D")?.status, "success");

  const ran = h.executed();
  check("被跳过的节点**一次都没被执行**", !ran.includes("C") && !ran.includes("E"), ran);
  eq("只有该跑的两个跑过", ran.length, 3);
  eq("每个节点都有结局(不留空)", result.outcomes.size, 5);
}

/* ────────────────────── 3. 取消 ────────────────────── */

console.log("\n取消");

{
  const abort = controller();
  const chain = docOf([node("A"), node("B")], [edge("A", "B")]);
  const h = makePorts({ delayMs: () => 60 });
  setTimeout(() => abort.abort(), 20);

  const result = await runWorkflow({
    doc: chain,
    prompt: "跑",
    ports: h.ports,
    signal: abort.signal,
  });

  eq("被取消 → status = cancelled", result.status, "cancelled");
  const ran = h.executed();
  check("取消之后没有新的派发(B 没跑过)", !ran.includes("B"), ran);
  eq("没派发到的节点标 cancelled", outcomeOf(h, "B")?.status, "cancelled");
  eq("在飞的那个也收了场", outcomeOf(h, "A")?.status, "cancelled");
  check("每个节点都有结局", result.outcomes.size === 2);
}

/* ────────────────────── 4. 前置检查 ────────────────────── */

console.log("\n前置检查(三种都明确失败,而且往下传播)");

{
  // 类型没装 —— 别人分享来的图会走到这里。
  const h = makePorts();
  const missing = docOf(
    [node("A", "x.ghost"), node("B")],
    [edge("A", "B")],
  );
  await runWorkflow({ doc: missing, prompt: "跑", ports: h.ports, signal: controller().signal });
  eq("类型没装 → failed", outcomeOf(h, "A")?.status, "failed");
  check("失败原因说清是哪个类型", (outcomeOf(h, "A")?.error ?? "").includes("x.ghost"), outcomeOf(h, "A")?.error);
  check("它的下游没有被派发", !h.executed().includes("B"), h.executed());
  eq("下游标 skipped", outcomeOf(h, "B")?.status, "skipped");
}

{
  // 执行方式没实现(`command`)—— 形状在规范里,但调度器不认。
  const h = makePorts();
  await runWorkflow({
    doc: docOf([node("A", SHELL.id)], []),
    prompt: "跑",
    ports: h.ports,
    signal: controller().signal,
  });
  eq("未实现的执行方式 → failed", outcomeOf(h, "A")?.status, "failed");
  check(
    "原因点名是哪种执行方式",
    (outcomeOf(h, "A")?.error ?? "").includes("command"),
    outcomeOf(h, "A")?.error,
  );
  check("没有真的去执行", h.calls.length === 0);
}

{
  // 必填参数没填 —— 存盘时就被拦了,但清单可能在文档存盘之后改过,所以解算前再校验。
  const h = makePorts();
  await runWorkflow({
    doc: docOf([{ ...node("A"), params: {} }], []),
    prompt: "跑",
    ports: h.ports,
    signal: controller().signal,
  });
  eq("必填参数没填 → failed", outcomeOf(h, "A")?.status, "failed");
  check("原因点名是哪个参数", (outcomeOf(h, "A")?.error ?? "").includes("指令"), outcomeOf(h, "A")?.error);
  check("没有真的去执行", h.calls.length === 0);
}

{
  // 提示词节点连指令参数都没声明 —— 校验过得了,拼提示词时才暴露。
  const h = makePorts();
  await runWorkflow({
    doc: docOf([{ ...node("A", LOOSE.id), params: {} }], []),
    prompt: "跑",
    ports: h.ports,
    signal: controller().signal,
  });
  eq("没有指令参数 → failed", outcomeOf(h, "A")?.status, "failed");
  check("失败原因说得出口", (outcomeOf(h, "A")?.error ?? "").includes("instruction"), outcomeOf(h, "A")?.error);
  check("没有真的去执行", h.calls.length === 0);
}

{
  // 取清单那一步自己抛了。**这是"每个节点都必须留下结局"那条不变式的回归用例** ——
  // 没定案的节点会被当成"还没跑"重新派发,那是死循环,而症状是**这个用例根本跑不完**。
  //
  // 判据用的是**类型 id**:端口那一层只知道节点引用了哪个类型,不知道它在图上的 id。
  const h = makePorts({ manifestThrows: (typeId) => typeId === "x.boom" });
  const result = await runWorkflow({
    doc: docOf([node("A", "x.boom"), node("B")], [edge("A", "B")]),
    prompt: "跑",
    ports: h.ports,
    signal: controller().signal,
  });
  eq("取清单抛错 → 那个节点标 failed", outcomeOf(h, "A")?.status, "failed");
  check(
    "抛出来的原因传下来了",
    (outcomeOf(h, "A")?.error ?? "").includes("清单读不出来"),
    outcomeOf(h, "A")?.error,
  );
  check("它的下游没有被派发", !h.executed().includes("B"), h.executed());
  eq("两个节点都有结局", result.outcomes.size, 2);
}

/* ────────────────────── 5. 提示词拼装 ────────────────────── */

console.log("\n提示词拼装");

{
  const root = composeNodePrompt({
    userPrompt: "帮我把这篇论文读懂",
    upstream: "",
    instruction: "先定位原文",
    nodeId: "A",
    plan: PLAN,
  });
  check("根节点拿到用户请求", root.includes("帮我把这篇论文读懂"));
  check("根节点拿到本步指令", root.includes("先定位原文"));
  check("根节点没有「上游」那一段", !root.includes("上游步骤的结果"));

  const downstream = composeNodePrompt({
    userPrompt: "帮我把这篇论文读懂",
    upstream: "### 定位\n找到了 3 篇",
    instruction: "整理成表格",
    nodeId: "D",
    plan: PLAN,
  });
  check("非根节点拿到上游结果", downstream.includes("找到了 3 篇"));
  check("非根节点拿到本步指令", downstream.includes("整理成表格"));
  // 这条是刻意的设计(见 `composeNodePrompt` 的注释):不共享对话记录,token 不随
  // 图的大小膨胀。代价是下游指令必须自足。
  check("非根节点**看不到**用户原话", !downstream.includes("帮我把这篇论文读懂"));

  // **「整条流程」是这一节存在的理由**(见 `planSection`)。节点是各自独立的会话,不给它
  // 看整条流程,第一步就会把整件事干完 —— 用户看到的现象正是"第一个代理全做完了,
  // 后面没东西可传"。
  check("把整条流程列出来了", root.includes("## 流程位置"), root.slice(0, 400));
  check("每一步的名字都在", root.includes("查文献") && root.includes("汇总"), root.slice(0, 400));
  check("标出了自己在哪一格", root.includes("← 你在这里"), root.slice(0, 400));
  check("同层说明它们之间没有先后", root.includes("这几步之间没有先后"), root.slice(0, 400));
  check("而且被按住了:只做「规划」", root.includes("只需完成「规划」这一步"), root.slice(0, 700));
  check("下游节点也看得到整条流程", downstream.includes("查文献"), downstream);
  check("末尾节点知道没人接手", downstream.includes("你负责的是最后一步"), downstream);
  // 末尾节点**不该**被按住 —— 它后面没有人,按住它就是让它别做完。
  check("末尾节点不被按住", !downstream.includes("只需完成「"), downstream);
  check("非根节点知道上游结果在下面", downstream.includes("上游"), downstream);
}

{
  // 技能那一段。**提示词里那一行字和交给提供方的允许清单是两件事**,少一件就是
  // "写了但没用":光有字,模型调不动 Skill 工具;光有清单,模型不知道该用。
  const withSkills = composeNodePrompt({
    userPrompt: "读这篇",
    upstream: "",
    instruction: "先解析原文",
    nodeId: "A",
    plan: PLAN,
    skills: ["pdf", "docx"],
  });
  check("拼出「这一步要用的技能」那一段", withSkills.includes("## 这一步要用的技能"));
  // `/名字` 是输入框里技能药丸的同一种写法 —— 模型认得。
  check(
    "技能写成 /名字",
    withSkills.includes("- /pdf") && withSkills.includes("- /docx"),
    withSkills,
  );
  check(
    "没选技能就不拼那一段",
    !composeNodePrompt({
      userPrompt: "",
      upstream: "",
      instruction: "x",
      nodeId: "A",
      plan: PLAN,
    }).includes("这一步要用的技能"),
  );
}

{
  // 参数 → 执行器的那一步(`nodeInputOf`):**执行的这一头也要真的拿到**。
  const h = makePorts();
  await runWorkflow({
    doc: docOf(
      [
        node("A", AGENT.id, "先解析原文", {
          skills: ["pdf"],
          mcp: ["browser", "zotero"],
          plugins: ["mcode-document-skills"],
        }),
        node("B", AGENT.id, "整理"),
      ],
      [edge("A", "B")],
    ),
    prompt: "读这篇",
    ports: h.ports,
    signal: controller().signal,
  });
  const a = h.calls.find((c) => c.id === "A");
  const b = h.calls.find((c) => c.id === "B");
  check("技能的允许清单交给了执行器", (a?.skills ?? []).join(",") === "pdf", a?.skills);
  check("提示词里也有技能那一段", (a?.prompt ?? "").includes("- /pdf"), a?.prompt);
  check("MCP 服务器的允许清单也交给了执行器", (a?.mcpServerNames ?? []).join(",") === "browser,zotero", a?.mcpServerNames);
  check("插件的允许清单也交给了执行器", (a?.pluginNames ?? []).join(",") === "mcode-document-skills", a?.pluginNames);
  // **空数组而不是 undefined**:执行器据此判断"要不要带 skills 上去",让它去猜
  // undefined 和 [] 的区别,就是把契约的细节漏进了实现。
  check("没写技能的节点拿到空数组", Array.isArray(b?.skills) && b.skills.length === 0, b?.skills);
  check("没写技能的节点提示词里没有那一段", !(b?.prompt ?? "").includes("这一步要用的技能"));
  // 三个"可选的东西"必须是同一种读法 —— 少了这一条,以后很容易只给技能做空数组、
  // 另两个漏回 undefined,而"漏回 undefined"在执行器那头正好是**不限制**(全给)。
  check("没写 MCP 的节点也是空数组", Array.isArray(b?.mcpServerNames) && b.mcpServerNames.length === 0, b?.mcpServerNames);
  check("没写插件的节点也是空数组", Array.isArray(b?.pluginNames) && b.pluginNames.length === 0, b?.pluginNames);
  // 脏值(两边带空白、重复)在契约那一头就被滤掉了,执行器拿到的是干净的。
  //
  // ⚠️ **这里只能喂"形状合法但脏"的参数**:`validateNodeParams` 排在前面,混进非字符串
  // 会先被判成"应该是一组名字"、这一步根本跑不到执行器 —— 那是**对的**,存进图里的参数
  // 本来就该是干净的。`nameListOf` 的宽容忍是给"AI 手写的清单"和"别人分享来的图"兜底的,
  // 那几种形状在 `workflow-view-smoke` 里逐个钉过(斜杠项、非字符串、不是数组)。
  const h2 = makePorts();
  await runWorkflow({
    doc: docOf([node("A", AGENT.id, "先解析原文", { mcp: ["  browser  ", "browser"] })], []),
    prompt: "读这篇",
    ports: h2.ports,
    signal: controller().signal,
  });
  check(
    "空白与重复在到执行器之前就清掉了",
    (h2.calls.find((c) => c.id === "A")?.mcpServerNames ?? []).join(",") === "browser",
    h2.calls.find((c) => c.id === "A")?.mcpServerNames,
  );
}

{
  // 拼好的那一份要真的送到执行器手上,而不是只在纯函数里对。
  const h = makePorts();
  await runWorkflow({
    doc: docOf([node("A"), node("B")], [edge("A", "B")]),
    prompt: "用户的请求",
    ports: h.ports,
    signal: controller().signal,
  });
  const a = h.calls.find((c) => c.id === "A");
  const b = h.calls.find((c) => c.id === "B");
  check("根节点那一轮带了用户请求", (a?.prompt ?? "").includes("用户的请求"), a?.prompt);
  check("下游那一轮带了上游结果", (b?.prompt ?? "").includes("A 的结果"), b?.prompt);
  check("下游那一轮没带用户请求", !(b?.prompt ?? "").includes("用户的请求"), b?.prompt);
}

{
  // 「对话节点」**不是**"没实现的执行方式" —— 它和 prompt 一样跑一轮模型,区别只在
  // **在哪儿跑**,而那是执行器的事。调度器该做的和对待 prompt 节点一模一样:拼好提示词、
  // 交给执行器、等产出、按变量表查(它没声明变量表,所以不查)。
  //
  // 为什么值得单钉一条:`isRunnerImplemented` 是一张白名单,新加一种 `runner.kind` 忘
  // 了登记的话,画布上画得出来、存得进去,一跑就被判成"这种执行方式还没实现" —— 而
  // 报错信息听起来像是功能没做,不像是漏登记。
  const h = makePorts();
  await runWorkflow({
    doc: docOf(
      [node("A", AGENT.id, "先查"), node("B", CONVERSATION.id, "按上面的结果写第三章")],
      [edge("A", "B")],
    ),
    prompt: "把这一章写出来",
    ports: h.ports,
    signal: controller().signal,
  });
  eq("对话节点照常派发(没被当成未实现的执行方式)", outcomeOf(h, "B")?.status, "success");
  const b = h.calls.find((c) => c.id === "B");
  check("它也拿得到上游的产出(拼法和其他节点同一条路)", (b?.prompt ?? "").includes("A 的结果"), b?.prompt);
  check("不是根节点就带不到用户那句原话", !(b?.prompt ?? "").includes("把这一章写出来"), b?.prompt);
  check("它的指令在提示词里", (b?.prompt ?? "").includes("按上面的结果写第三章"), b?.prompt);
}

{
  // **调度器真的把位置传下去了吗** —— 上面那几条测的是拼装函数,这几条测的是它有没有
  // 被喂对东西。`planOf` 是自己的单测,这里看的是端到端那一份。
  //
  // 这个夹具叫 diamond,但边是 `A→C、A→D、B→D` —— **两个根**(A 和 B),C 和 D 都收口。
  // 于是分层是:A、B 在第一层,C、D 在第二层(`D` 的上游 A、B 都在第 0 层,所以它是 1)。
  const h = makePorts();
  await runWorkflow({ doc: diamond, prompt: "把这件事办了", ports: h.ports, signal: controller().signal });
  const promptOf = (id: string): string => h.calls.find((c) => c.id === id)?.prompt ?? "";

  check("A 看到自己跟 B 并列", promptOf("A").includes("1. A、B"), promptOf("A").slice(0, 400));
  check("而且标出自己在哪一格", promptOf("A").includes("← 你在这里"), promptOf("A").slice(0, 400));
  check("A 被按住:只做「A」", promptOf("A").includes("只需完成「A」这一步"), promptOf("A"));
  check("C 和 D 在第二层", promptOf("C").includes("2. C、D"), promptOf("C").slice(0, 400));
  check("D 是收口", promptOf("D").includes("你负责的是最后一步"), promptOf("D"));
  check("收口没被按住(后面没人了)", !promptOf("D").includes("只需完成「"), promptOf("D"));
}

console.log("\nplanOf(从图算出来的那份计划)");

{
  const plan = planOf(diamond, (id) => id);
  eq("两层", plan.length, 2);
  eq("第一层是 A、B", plan[0]?.map((s) => s.id).join(","), "A,B");
  eq("第二层是 C、D", plan[1]?.map((s) => s.id).join(","), "C,D");
  eq("A 还有下游", plan[0]?.[0]?.isLast, false);
  eq("C 是收口", plan[1]?.find((s) => s.id === "C")?.isLast, true);
  // **只带名字,不带指令** —— 别人的指令对它没用(白烧 token),而且会引诱它越界
  // (看见"写初稿要写哪几节",它顺手就写了,而我们要的恰恰是它别写)。
  check("计划里没有节点的指令", !JSON.stringify(plan).includes("做什么"), JSON.stringify(plan));
  // 名字取的是**标题**,没起标题才退回类型 id —— 用户在画布上看到的就是这两个之一。
  eq("没起标题时用节点 id", plan[0]?.[1]?.title, "B");
  const titled = planOf(
    { ...diamond, nodes: diamond.nodes.map((n) => (n.id === "A" ? { ...n, title: "规划" } : n)) },
    (id) => (id === "A" ? "规划" : id),
  );
  eq("起了标题就用标题", titled[0]?.[0]?.title, "规划");
}

/* ────────────────────── 6. 边界 ────────────────────── */

console.log("\n边界");

{
  // 空图:一条边都没有,一个节点都没有。不该崩,也不该挂住。
  const h = makePorts();
  const result = await runWorkflow({
    doc: docOf([], []),
    prompt: "跑",
    ports: h.ports,
    signal: controller().signal,
  });
  eq("空图 → success", result.status, "success");
  eq("空图没有节点", result.outcomes.size, 0);
}

{
  // 图里有环:存盘时 `validateDag` 会拦,但真到了这里不能永远挂着。
  const h = makePorts();
  const cyclic = docOf([node("A"), node("B")], [edge("A", "B"), edge("B", "A")]);
  const result = await runWorkflow({
    doc: cyclic,
    prompt: "跑",
    ports: h.ports,
    signal: controller().signal,
  });
  eq("环上的节点有结局(不留空)", result.outcomes.size, 2);
  eq("两个都标 skipped", outcomeOf(h, "A")?.status, "skipped");
}

/* ────────────────────── 上下文继承与引擎 ────────────────────── */

console.log("\n上下文继承(节点选了几类,就去要那几类)");

{
  // 假端口返回的是**真的那种形状**(事实 + 由调度器排版,见 `contextInherit.ts` 的
  // `inheritContextLines`)—— 返回拼好的字符串的话,下面那几条断言测的就不是用户
  // 真正看到的那一段了(而"资料是什么类型、拿来干什么"正是用户提的那两条)。
  const lineOf = (k: NodeContextKind): ContextLine =>
    k === "paper"
      ? { kind: "paper", level: "all", path: "/lib/kind-paper.md" }
      : { kind: "note", level: "item", path: "/lib/kind-note.md" };
  const h = makePorts({ contextLines: (kinds) => kinds.map(lineOf) });
  const doc = docOf([node("A", AGENT.id, "写论文", { context: ["paper", "note"] })], []);
  await runWorkflow({ doc, prompt: "开始", ports: h.ports, signal: controller().signal });

  eq("按节点的参数问了一次", h.contextAsked.length, 1);
  eq("问的正是它选的那两类", h.contextAsked[0]?.join(","), "paper,note");
  const prompt = h.calls[0]?.prompt ?? "";
  check("继承来的资料进了提示词", prompt.includes("- 【文献·整库】@/lib/kind-paper.md"), prompt);
  check("两类都在", prompt.includes("- 【笔记·单篇】@/lib/kind-note.md"), prompt);
  // **两条都是"查资料"那一组**:笔记和文献是同一类用法(都是拿来读内容的),所以不
  // 该冒出"当格式仿"。分组是按用途,不是按库。
  check("两条同属查资料那一组", prompt.includes("**当资料查**"), prompt);
  check("没有模版就不摆「当格式仿」", !prompt.includes("当格式仿"), prompt);
  // 单独一段而不是散在指令里 —— "这一步能读什么"是个可以一眼看完的集合。
  check("单独成一段", prompt.includes("## 这一步可以读的资料"), prompt);
  // **抬头得有出处**:方括号里那两个词(类目 + 层级)是代码算的,不解释一句的话
  // 模型只看见两个没来由的方括号词。见 `composeNodePrompt` 里那段。
  check("说明了方括号是什么", prompt.includes("方括号内是它的类别"), prompt);
  check("指令还是最后一段(资料在它前面)", prompt.trimEnd().endsWith("写论文"), prompt);
}

{
  // **没选类目时也要问一次**(问的是空数组)而且**不产生那一段** —— 一个空标题比没有
  // 更糟:模型会以为"这一步没有资料",而实际情况是"这一步没要求资料"。
  // 假端口按**契约**返回(没要类目就没有行);它不按契约来的话,下面这条断言的就不是
  // 调度器的行为了。
  const h = makePorts({
    contextLines: (kinds) =>
      kinds.length === 0 ? [] : [{ kind: "paper", level: "all", path: "/lib/kind-paper.md" }],
  });
  const doc = docOf([node("A")], []);
  await runWorkflow({ doc, prompt: "开始", ports: h.ports, signal: controller().signal });
  eq("没选类目 → 问的是空数组", h.contextAsked[0]?.length, 0);
  check("没选类目 → 提示词里没有那一段", !(h.calls[0]?.prompt ?? "").includes("可以读的资料"));
}

{
  // 选了、但主对话没挂那一类 → 段不出现。这一条是"继承"与"查找"的分界:节点说了
  // 要文献,而这次对话没有,那这一步就是没有 —— 不会替用户去库里翻。
  const h = makePorts();
  const doc = docOf([node("A", AGENT.id, "写论文", { context: ["paper"] })], []);
  await runWorkflow({ doc, prompt: "开始", ports: h.ports, signal: controller().signal });
  eq("问过了", h.contextAsked[0]?.join(","), "paper");
  check("主对话没挂 → 提示词里没有那一段", !(h.calls[0]?.prompt ?? "").includes("可以读的资料"));
}

{
  // 参数里存了**不认识的类目名**(手改过的图 / AI 写歪了):清单声明了候选,所以
  // 这一类在这一层就被拦下 —— **节点明确失败并说清楚**,而不是把那个值静静丢掉。
  //
  // 这是刻意的:丢掉的话现象是"这一步没有它要的资料",而原因(名字写错了)在任何地方
  // 都看不到。这个仓库一贯的取舍是**错的配置要发出声音**(同 `validateDag` /
  // `instructionOf`)。
  const h = makePorts({
    contextLines: (kinds) =>
      kinds.map((k) => ({ kind: k, level: "all" as const, path: `/lib/kind-${k}.md` })),
  });
  const doc = docOf(
    [node("A", AGENT.id, "写论文", { context: ["paper", "不存在的类目"] })],
    [],
  );
  await runWorkflow({ doc, prompt: "开始", ports: h.ports, signal: controller().signal });
  eq("没被派发", h.contextAsked.length, 0);
  const outcome = outcomeOf(h, "A");
  eq("节点失败", outcome?.status, "failed");
  check("说的是取值不在选项里", outcome?.error?.includes("不在选项里") === true, outcome?.error);
}

console.log("\n引擎解算(约定键 → 输入,执行器不再自己翻 params)");

{
  const h = makePorts();
  const doc = docOf([node("A", AGENT.id, "x", { provider: "codex" })], []);
  await runWorkflow({ doc, prompt: "开始", ports: h.ports, signal: controller().signal });
  eq("引擎解到了输入里", h.calls[0]?.providerId, "codex");
}

{
  const h = makePorts();
  const doc = docOf([node("A", AGENT.id, "x", { provider: "   " })], []);
  await runWorkflow({ doc, prompt: "开始", ports: h.ports, signal: controller().signal });
  eq("只有空白 = 跟着对话走", h.calls[0]?.providerId, undefined);
}

console.log("\ncomposeNodePrompt(上下文那一段)");

{
  const withContext = composeNodePrompt({
    userPrompt: "用户的请求",
    upstream: "",
    instruction: "写论文",
    nodeId: "A",
    plan: PLAN,
    // 两条不同**用途**的:`paper` 是拿来查的,`latex` 是拿来仿的 —— 那一段按这个分组。
    context: [
      { kind: "paper", level: "item", path: "/lib/paper.md" },
      { kind: "latex", level: "category", path: "/lib/latex.md" },
    ],
  });
  check(
    "两条都在,而且带着「是什么」",
    withContext.includes("- 【文献·单篇】@/lib/paper.md") &&
      // **模版那几个抬头带「模版」二字** —— 光写 `【LaTeX·类目】` 有歧义(是那个软件,
      // 还是那一类模版),而且这跟用户在下拉里勾选时看到的词逐字一致(见 `KIND_LABEL`)。
      withContext.includes("- 【LaTeX 模版·类目】@/lib/latex.md"),
    withContext,
  );
  check("说的是「主对话挂了这些」", withContext.includes("以下是主对话中挂载的资料"), withContext);
  // **两类的用法不同,所以分开摆** —— 用户的原话:「模版的话是仿写,借鉴格式这种;
  // 文献、教材、笔记这些是用来查询资料的」。平铺成一个列表的话,模型多半会把模版
  // 当资料读(于是抄了里面的内容),或者把文献当成格式样板。
  check("资料那组说清了是拿来查的", withContext.includes("**当资料查**"), withContext);
  check("模版那组说清了是拿来仿的", withContext.includes("**当格式仿**"), withContext);
  check(
    "模版那组明确说了别搬内容",
    withContext.includes("不要搬用其中的原话"),
    withContext,
  );
  // 分组顺序固定:查资料的在前。跨组不再等于主提示词里的先后 —— 这是分组换来清晰度
  // 的代价(只影响"先看到哪一条")。
  check(
    "查资料那组在前",
    withContext.indexOf("当资料查") < withContext.indexOf("当格式仿"),
    withContext,
  );

  const noContext = composeNodePrompt({
    userPrompt: "用户的请求",
    upstream: "",
    instruction: "写论文",
    nodeId: "A",
    plan: PLAN,
    context: [],
  });
  check("空数组 = 没有那一段", !noContext.includes("可以读的资料"), noContext);
}

console.log("\n附件路径 → 类目(认不出来就什么都不给)");

// 假的两个根 + 两次"按 id 查类目"。**用 `resolve` 而不是写死 `/fake/...`**:Windows 上
// 盘符会被拼进来,而两边都走同一个 `resolve`,比较才成立(被测代码也是这么做的)。
const LIB_ROOT = resolve("/fake/library");
const TPL_ROOT = resolve("/fake/templates");
const LOOKUP: ContextLookup = {
  libraryRoot: LIB_ROOT,
  templatesRoot: TPL_ROOT,
  // 分类和条目的 id 都是**不透明**的(条目的文件名甚至是 sha256)—— 所以只能查,不能猜。
  collectionKind: (id) => (id === "c_我的分类" ? "paper" : undefined),
  itemKind: (id) => (id === "9f8e7d6c" ? "note" : undefined),
};
const libManifest = (name: string): string => join(LIB_ROOT, "collections", name);
const tplManifest = (...parts: string[]): string => join(TPL_ROOT, ".manifests", ...parts);

const kindOf = (path: string): string | null => contextKindOfPath(path, LOOKUP);

eq("整库清单 kind-paper.md → 文献", kindOf(libManifest("kind-paper.md")), "paper");
eq("kind-note.md → 笔记", kindOf(libManifest("kind-note.md")), "note");
// `kind-` 后面不是合法库名 —— 那就是个普通的 md 文件,不是整库清单。
eq("kind-某某.md 认不出来", kindOf(libManifest("kind-某某.md")), null);
// 分类 / 条目靠**查库**。
eq("分类 id → 查出来是文献", kindOf(libManifest("c_我的分类.md")), "paper");
eq("条目 id → 查出来是笔记", kindOf(libManifest("9f8e7d6c.md")), "note");
eq("库里没有的 id → 认不出来", kindOf(libManifest("不认识.md")), null);
// 模版清单的**目录名就是类目**,不用查。
eq("整个类目 latex.md → LaTeX", kindOf(tplManifest("latex.md")), "latex");
eq("单条模版 latex/某模板.md → LaTeX", kindOf(tplManifest("latex", "某模板.md")), "latex");

console.log("\ncontextRefOfPath(类目 + 它占哪一层)");
// **层级也是算出来的**:一个 id 是"分类"还是"单篇",取决于它在哪张表里查到
// (`collectionKind` / `itemKind` 是两次不同的查询),所以这里分得出来。提示词里那个
// `【文献·单篇】` 就是它 —— 少了它,模型拿到一串不透明的 id(条目文件名甚至是
// sha256),只能先读一遍才知道那是一整库还是单独一篇,而它多半会先按上下文猜一个。
const refOf = (path: string): string => {
  const r = contextRefOfPath(path, LOOKUP);
  return r === null ? "null" : `${r.kind}/${r.level}`;
};
eq("整库清单", refOf(libManifest("kind-paper.md")), "paper/all");
eq("分类 id", refOf(libManifest("c_我的分类.md")), "paper/collection");
eq("条目 id", refOf(libManifest("9f8e7d6c.md")), "note/item");
eq("整个模版类目", refOf(tplManifest("latex.md")), "latex/category");
eq("单条模版", refOf(tplManifest("latex", "某模板.md")), "latex/template");
eq("认不出来的照样是 null", refOf(join(LIB_ROOT, "papers", "x.pdf")), "null");

console.log("\ncontextPurposeOf(拿来查,还是拿来仿)");
// 这一个判断决定了资料那一段**怎么分组**(见 `composeNodePrompt` 的
// `renderContextLines`)。判据是**结构上**的:`NodeContextKind` 本来就是
// `LibraryKind | TemplateKind` 两个不相交的集合拼出来的 —— 不是一条要另外维护的规则,
// 而是两个库本来就有的区别(连根目录都不是同一个)。
eq("文献是拿来查的", contextPurposeOf("paper"), "material");
eq("教材是拿来查的", contextPurposeOf("textbook"), "material");
eq("笔记是拿来查的", contextPurposeOf("note"), "material");
eq("LaTeX 模版是拿来仿的", contextPurposeOf("latex"), "format");
eq("Word 模版是拿来仿的", contextPurposeOf("word"), "format");
eq("配图模版也是拿来仿的", contextPurposeOf("image"), "format");
eq("不认识的模版类目 → 认不出来", kindOf(tplManifest("nope.md")), null);
// 不是清单的附件(一篇 PDF 的正文、一张图)不该被当成上下文类目。
eq("库根下的普通文件 → 认不出来", kindOf(join(LIB_ROOT, "papers", "ab", "cd", "abc.pdf")), null);
eq("库和模版之外的文件 → 认不出来", kindOf(join(dirname(LIB_ROOT), "别处", "x.md")), null);

console.log("\nattachmentPathsIn(提示词里那几行 @)");
// 返回的是**路径本身**(不带 `@`)—— `@` 是拼进提示词时才加回去的(见
// `inheritContextLines`),所以这里比的是裸路径。
eq(
  "只取 @ 开头的行",
  attachmentPathsIn("帮我看一下\n@" + libManifest("kind-paper.md") + "\n后面这句不算").join("|"),
  libManifest("kind-paper.md"),
);
// **路径里有空格**(Windows 上 `C:\Users\张 三\...` 很常见)—— 按行取才不会在第一个
// 空格处断掉,而按正则扫全文一定会断。
eq(
  "路径里的空格不会把路径截断",
  attachmentPathsIn("@C:/Users/张 三/library/collections/kind-paper.md").length,
  1,
);
eq("没有附件就是空", attachmentPathsIn("就是一段普通的话").length, 0);
eq("只有一个 @ 的空行不算", attachmentPathsIn("@\n@   ").length, 0);

console.log("\ninheritContextLines(挑出节点要的那几类)");
const PROMPT = [
  "帮我写一篇",
  "",
  `@${libManifest("kind-paper.md")}`,
  `@${libManifest("kind-note.md")}`,
  `@${tplManifest("latex.md")}`,
  `@${libManifest("kind-paper.md")}`, // 挂了两次 —— 只该给一行
].join("\n");

// 交回来的是**事实**(类目 / 层级 / 路径),排版是提示词那一层的事 —— 所以这里比的是
// 事实本身,而不是某一种排版结果(那种断言会在改一个字的时候红,却看不出对错)。
const lineKey = (l: ContextLine): string => `${l.kind}/${l.level}@${l.path}`;
eq(
  "只要文献 → 只有文献那一条",
  inheritContextLines(PROMPT, ["paper"], LOOKUP).map(lineKey).join("|"),
  `paper/all@${libManifest("kind-paper.md")}`,
);
eq(
  "要文献和模版 → 两条,顺序跟着主提示词",
  inheritContextLines(PROMPT, ["paper", "latex"], LOOKUP).map(lineKey).join("|"),
  `paper/all@${libManifest("kind-paper.md")}|latex/category@${tplManifest("latex.md")}`,
);
eq("一个类目都没要 → 一行都不给", inheritContextLines(PROMPT, [], LOOKUP).length, 0);
// 主对话没挂那一类 —— **这一步就是没有**,不会替用户去库里翻。
eq("要了但主对话没挂 → 空", inheritContextLines(PROMPT, ["textbook"], LOOKUP).length, 0);
// 认不出来的路径不该混进来。
eq(
  "认不出来的 @ 行被丢掉",
  inheritContextLines(`@${join(LIB_ROOT, "papers", "x.pdf")}\n@随便什么`, ["paper"], LOOKUP).length,
  0,
);

/* ────────────────────── 变量({{...}}) ────────────────────── */

console.log("\nrenderTemplate(纯函数)");

const TPL_SCOPE: NodeTemplateScope = {
  user: "把这件事办了",
  // 名字集合里 id 和标题**都在**(调用方负责两个都放进去,`upstreamNames` 就是这么做的)。
  upstream: new Set(["A", "检索", "B", "整理"]),
  nodes: [
    {
      id: "A",
      title: "检索",
      outcome: { status: "success", summary: "找到三篇", outputs: { 年份: "2024", stats: { count: 3 } }, artifacts: [{ kind: "file", uri: "D:/work/report.pdf", name: "report.pdf", mimeType: "application/pdf" }] },
      params: { target: "量子", tags: ["a", "b"], n: 3 },
    },
    {
      id: "B",
      title: "整理",
      outcome: { status: "failed", summary: "", error: "超时了" },
      params: {},
    },
    // 图上有、但**不是上游** —— 用来验报错分得开。
    { id: "C", title: "后面那步", params: {} },
  ],
};

const render = (text: string): string => {
  const res = renderTemplate(text, TPL_SCOPE);
  return res.ok ? res.text : `ERR:${res.error}`;
};

eq("{{user}} → 用户这次发的请求", render("按这个做:{{user}}"), "按这个做:把这件事办了");
eq("按 id 引用产出", render("{{A.output}}"), "找到三篇");
eq("按**标题**引用也认", render("{{检索.output}}"), "找到三篇");
eq("不写字段 = 产出", render("{{A}}"), "找到三篇");
eq("status", render("{{B.status}}"), "failed");
eq("error", render("{{B.error}}"), "超时了");
eq("title", render("{{A.title}}"), "检索");
eq("params 取字符串", render("{{A.params.target}}"), "量子");
// 多选那种参数存的是字符串数组 —— `["a","b"]` 直接进提示词很难看,所以用顿号连起来。
eq("params 取数组 → 顿号连起来", render("{{A.params.tags}}"), "a、b");
eq("params 取数字", render("{{A.params.n}}"), "3");
eq("outputs 取嵌套对象", render("{{A.outputs.stats.count}}"), "3");
eq("artifacts 取 URI", render("{{A.artifacts[0].uri}}"), "D:/work/report.pdf");
eq("artifacts 取名称", render("{{A.artifacts[0].name}}"), "report.pdf");
eq("取不存在的参数 = 空串", render("[{{A.params.没有}}]"), "[]");
// 一句话里多处引用。
eq("一句里多处", render("{{检索.output}},目标 {{A.params.target}}"), "找到三篇,目标 量子");
// 没有引用时**原样返回** —— 这一段不该改动任何不含变量的指令。
eq("没有引用就不动它", render("就是一句普通的话 { } 单个花括号"), "就是一句普通的话 { } 单个花括号");

console.log("\nrenderTemplate(写错了要说清楚)");
const err = (text: string): string => {
  const res = renderTemplate(text, TPL_SCOPE);
  return res.ok ? `OK:${res.text}` : res.error;
};

// **图上有、但不是这一步的上游** 和 **图上根本没有** —— 用户要做的事完全不一样
// (改依赖 vs 改名字),所以报错要分得开。
check("引用旁支 → 说清「不是这一步的上游」", err("{{C.output}}").includes("不是这一步的上游"), err("{{C.output}}"));
check("引用不存在的节点 → 说清「图上没有」", err("{{没有这个.output}}").includes("图上没有"), err("{{没有这个.output}}"));
// 引用一个那一步**没定过**的名字 → 把实际有的列出来,用户凭这个就能改对。
check("引用没定过的变量 → 把有的列出来", err("{{A.期刊}}").includes("年份"), err("{{A.期刊}}"));
// 引用一个**根本没填过产出变量**的节点 → 那是另一回事,说清怎么才能有。
check(
  "引用没填过变量的节点 → 说清怎么才有",
  err("{{B.年份}}").includes("还没有产出变量"),
  err("{{B.年份}}"),
);
check("空引用", err("{{}}").includes("空引用"), err("{{}}"));
check("params 后面没写名字", err("{{A.params.}}").includes("参数名"), err("{{A.params.}}"));
// 报错里要带**是哪个参数**写错了 —— 一个节点有好几个文本参数,不说是哪个就得自己找。
check("报错里带上了出错的参数名", err("{{C.output}}").includes("指令"), err("{{C.output}}"));

const ambiguous: NodeTemplateScope = {
  user: "",
  upstream: new Set(["同名的"]),
  nodes: [
    { id: "n1", title: "同名的", outcome: { status: "success", summary: "一" }, params: {} },
    { id: "n2", title: "同名的", outcome: { status: "success", summary: "二" }, params: {} },
  ],
};
const amb = renderTemplate("{{同名的.output}}", ambiguous);
check("标题重名 → 拒", !amb.ok && amb.error.includes("同时是多个节点的标题"), amb);

console.log("\n转义(指令里真要写 {{)");
eq("\\{{ 是字面的 {{", render("用 \\{{变量}} 表示占位"), "用 {{变量}} 表示占位");
eq("转义和真引用可以混着用", render("{{A.output}} 要写成 \\{{output}}"), "找到三篇 要写成 {{output}}");

console.log("\n变量在调度器里真的生效");
{
  // A → B。B 的指令里引用了 A 的产出,而 B 的提示词里应该出现**解算后**的那句话。
  const h = makePorts();
  const doc = docOf(
    [
      node("A", AGENT.id, "去检索"),
      node("B", AGENT.id, "基于 {{A.output}} 写一段"),
    ],
    [edge("A", "B")],
  );
  await runWorkflow({ doc, prompt: "开始", ports: h.ports, signal: controller().signal });

  const bPrompt = h.calls.find((c) => c.id === "B")?.prompt ?? "";
  check("B 的提示词里是 A 的**结果**,不是 {{A.output}}", bPrompt.includes("A 的结果"), bPrompt);
  check("占位符本身不在了", !bPrompt.includes("{{A.output}}"), bPrompt);
}

{
  // 引用了**上游的参数**:B 指令里写 {{A.params.target}}。
  const h = makePorts();
  const doc = docOf(
    [node("A", AGENT.id, "去检索", { target: "量子纠缠" }), node("B", AGENT.id, "目标 {{A.params.target}}")],
    [edge("A", "B")],
  );
  await runWorkflow({ doc, prompt: "开始", ports: h.ports, signal: controller().signal });
  const bPrompt = h.calls.find((c) => c.id === "B")?.prompt ?? "";
  check("上游的参数被引用了进来", bPrompt.includes("量子纠缠"), bPrompt);
}

{
  // 引用一个**不是上游**的节点(node 在同列、甚至可能先跑完)—— 这一步**明确失败**,
  // 而且失败要往下游传(下游不派发)。这是"只认上游"那条规矩在运行时的样子。
  const h = makePorts();
  const doc = docOf(
    [node("A", AGENT.id, "x"), node("B", AGENT.id, "引用 {{A.output}}"), node("C", AGENT.id, "y")],
    [edge("B", "C")],
  );
  await runWorkflow({ doc, prompt: "开始", ports: h.ports, signal: controller().signal });

  const outcomeB = outcomeOf(h, "B");
  eq("B 失败", outcomeB?.status, "failed");
  check("说的是「不是这一步的上游」", outcomeB?.error?.includes("不是这一步的上游") === true, outcomeB?.error);
  // B 根本没被派发出去 —— 参数解算在**跑之前**,所以它连会话都没建。
  check("B 没有被真的执行", !h.executed().includes("B"), h.executed());
  eq("下游 C 被跳过", outcomeOf(h, "C")?.status, "skipped");
  // 同列无关的 A 照常跑完 —— 一个节点配错了不该让整张图停摆。
  eq("无关的 A 照常跑", h.executed().includes("A"), true);
}

/* ────────────────────── 产出变量(硬约束) ────────────────────── */

// 界面上用户填的是「变量名 + 示例」两栏,底下是 JSON —— **这一整段测的就是那两栏真的
// 变成了"跑完会检查的东西"**。见 `@contracts/outputConstraint`。

console.log("\ncheckOutput(纯函数)");

const VARS = [
  { name: "年份", example: "2024" },
  { name: "标题", example: "量子纠缠的实验检验" },
];

{
  // **围栏优先**:模型围着结果说一句话是常态,不是错误。要求"整段一字不差"会把大量
  // 其实没问题的产出判死。
  const fenced = '好的,结果如下:\n```json\n{"年份": "2024", "标题": "量子"}\n```\n希望有帮助';
  const r = checkOutput(fenced, VARS);
  eq("围栏里的东西提得出来", r.ok, true);
  eq("提出来的是对的", r.ok ? (r.value as { 年份: string }).年份 : null, "2024");
}

{
  const bare = '前面一句。\n{"年份": "2024", "标题": "量子"}\n后面一句。';
  eq("没有围栏也能从正文里提", checkOutput(bare, VARS).ok, true);
}

{
  // **引号里的括号不算配平** —— 不按状态走的话 `{"a":"}"}` 会在那个 `}` 上提前收尾,
  // 于是所有含花括号的值都会莫名其妙地"读不出来"。
  const tricky = '{"a": "}", "b": "{\\\\"}';
  const r = checkOutput(tricky, [
    { name: "a", example: "}" },
    { name: "b", example: "{\\" },
  ]);
  eq("引号里的花括号不提前收尾", r.ok, true);
}

{
  // 围栏里那段不是我们要的形状时,要**继续往下找** —— 模型常把解释放进围栏、把结果
  // 放在正文里(或者反过来)。只试第一个候选的话这一条会失败。
  const mixed = '```\n这里是说明\n```\n结果是 {"ok": true}';
  eq("第一段候选不对就试下一段", checkOutput(mixed, [{ name: "ok", example: "true" }]).ok, true);
}

{
  const r = checkOutput("我觉得大概是 2024 年吧", VARS);
  eq("一段散文 → 失败", r.ok, false);
  check("报错说清该交哪几样", !r.ok && r.error.includes("年份") && r.error.includes("标题"), !r.ok && r.error);
  check("它交了什么也带上了", !r.ok && r.error.includes("我觉得大概是"), !r.ok && r.error);
}

{
  const r = checkOutput('{"年份": "2024"}', VARS);
  eq("少了一样 → 失败", r.ok, false);
  check("缺的是哪样说得出来", !r.ok && r.error.includes("标题"), !r.ok && r.error);
  check("不缺的那个不冤枉它", !r.ok && !r.error.includes("年份"), !r.ok && r.error);
  check("还把示例带出来提醒", !r.ok && r.error.includes("量子纠缠"), !r.ok && r.error);
}

{
  eq("交了个数组 → 失败", checkOutput("[1,2]", VARS).ok, false);
  eq("交了个数字 → 失败", checkOutput("42", VARS).ok, false);
}

{
  const r = checkOutput("随便什么", []);
  eq("没填变量就永远过", r.ok, true);
  eq("也不给结构化产出", r.ok ? r.value : "x", undefined);
}

console.log("\nvalidateOutputRules(填得不对要说出来)");

{
  const bad = validateOutputRules(AGENT, { outputVars: [{ name: "", example: "x" }] });
  eq("名字空着 → 拒", bad.ok, false);

  eq(
    "名字重复 → 拒",
    validateOutputRules(AGENT, {
      outputVars: [
        { name: "年份", example: "2024" },
        { name: "年份", example: "2025" },
      ],
    }).ok,
    false,
  );

  const reserved = validateOutputRules(AGENT, { outputVars: [{ name: "output", example: "x" }] });
  eq("起了内置的名字 → 拒", reserved.ok, false);
  check(
    "并说清为什么(下游会取到内置的那个)",
    !reserved.ok && reserved.error.includes("内置"),
    !reserved.ok && reserved.error,
  );

  eq(
    "名字里有花括号 → 拒",
    validateOutputRules(AGENT, { outputVars: [{ name: "a{b", example: "x" }] }).ok,
    false,
  );

  const noExample = validateOutputRules(AGENT, { outputVars: [{ name: "年份", example: "" }] });
  eq("没填示例 → 拒", noExample.ok, false);
  check("说清示例是干什么用的", !noExample.ok && noExample.error.includes("示例"), !noExample.ok && noExample.error);

  eq(
    "填对了 → 过,而且把表带回来",
    validateOutputRules(AGENT, { outputVars: VARS }).ok,
    true,
  );
  eq("什么都不填 → 过", validateOutputRules(AGENT, {}).ok, true);
  // **清单没声明过就不算数**:节点换过类型之后会留下上一个类型的键。不设这道门的话,
  // 一个跟产出无关的节点会突然开始因为"少了一样"而失败。
  eq(
    "清单没声明 outputVars 时,同样的脏参数不算数",
    validateOutputRules(SHELL, { outputVars: [{ name: "output", example: "" }] }).ok,
    true,
  );
}

console.log("\n给模型看的那两段");

{
  const example = outputExampleOf(VARS);
  check("样例里两个名字都在", example.includes("年份") && example.includes("标题"), example);
  check("样例里两个示例也都在", example.includes("2024") && example.includes("量子"), example);
  eq("没填变量就没有样例", outputExampleOf([]), "");

  const desc = describeOutputVars(VARS);
  check("说了照这个形状交", desc.includes(example), desc);
  check("说了会被检查", desc.includes("会被检查"), desc);
  // **硬约束的字面意思:产出只有那个对象,别的什么都不写。** 用户的规定(原话):
  // 「这个节点如果加了硬约束,就不要有除了 json 以外的任何东西了,他的输出全部都是
  // 放在了变量里面,不需要多余的输出」—— 实测里模型交完对象又补了 5 条说明,那 5 条
  // 按这条规矩就是多余的。这三条盯住这句话,别再翻回"正文照常交"那一版。
  check("说了产出就是这个对象", desc.includes("就是这个对象"), desc);
  check("说了别的什么也不要写", desc.includes("不要写任何内容"), desc);
  check("不再让它在正文里另说一遍", !desc.includes("另起一段"), desc);
  eq("没填变量就什么都不说", describeOutputVars([]), "");
  // 用户迟早会看到这一段(提示词是能翻的),所以这里**不该出现 JSON 这个词** ——
  // 界面上从头到尾没教过他这个。见 `@contracts/outputConstraint` 的文件头。
  check("这一段里不出现 JSON 这个词", !desc.includes("JSON"), desc);
}

console.log("\n调度器:产出回来当场查");

{
  const h = makePorts({
    summary: () => '这是结果:\n```json\n{"年份": "2024", "标题": "量子"}\n```',
  });
  // **A 后面得真有一步**:终末节点不查产出变量(见下面「终末节点不发也不查」那一组),
  // 一个孤零零的 A 现在压根不会走到校验这条路上。
  const doc = docOf(
    [node("A", AGENT.id, "找一篇", { outputVars: VARS }), node("B", AGENT.id, "整理")],
    [edge("A", "B")],
  );
  await runWorkflow({ doc, prompt: "开始", ports: h.ports, signal: controller().signal });
  const a = outcomeOf(h, "A");
  eq("交齐了 → 成功", a?.status, "success");
  eq("变量进了产出,下游取得着", (a?.outputs as { 年份?: string } | undefined)?.年份, "2024");
  check("原文照旧留着", a?.summary.includes("```json") === true, a?.summary);
}

{
  // **少一样就失败** —— 而不是把一段不完整的东西递给下游。下游拿到的文本没法知道
  // 这次是不是那个意外,问题会一路传到最下游才暴露,而那时已经看不出是哪一步的。
  const h = makePorts({ summary: () => "我觉得大概是 2024 年吧" });
  const doc = docOf(
    [
      node("A", AGENT.id, "找一篇", { outputVars: VARS }),
      node("B", AGENT.id, "用 {{A.年份}} 做点事"),
    ],
    [edge("A", "B")],
  );
  await runWorkflow({ doc, prompt: "开始", ports: h.ports, signal: controller().signal });

  const a = outcomeOf(h, "A");
  eq("没交齐 → 失败", a?.status, "failed");
  check("说清缺什么", a?.error?.includes("年份") === true, a?.error);
  check("它交了什么也留着", a?.summary === "我觉得大概是 2024 年吧", a?.summary);
  eq("下游被跳过", outcomeOf(h, "B")?.status, "skipped");
}

{
  // 没填变量的节点**不该**平白多出一个空的 `outputs`:那个字段的意思是"它有产出变量",
  // 空对象会让下游的报错说成"有产出但没这个变量",而真相是这一步根本没填过。
  const h = makePorts();
  const doc = docOf([node("A")], []);
  await runWorkflow({ doc, prompt: "开始", ports: h.ports, signal: controller().signal });
  eq("没填变量就没有 outputs", outcomeOf(h, "A")?.outputs, undefined);
}

console.log("\n终末节点:没人取它的变量,那张表就不发也不查");

/** 一条变量就够 —— 这几条测的是"发不发/查不查",不是表怎么渲染。 */
const ONE_VAR = [{ name: "计划", example: "上午学习,中午午睡,晚上运动" }];

{
  // 用户实测报回来的那条:最后一步交出来的东西开头就是一坨 ```{"变量名": "…"}```,
  // 而他要的是「别让我看见 JSON」。机制本身没错(表是**给下游取值**的),错在
  // **没有下游也在发**:没人来取,却逼着模型把交付物写成一个对象。
  const h = makePorts({ summary: () => "上午学习,中午午睡,晚上运动。" });
  const doc = docOf([node("A", AGENT.id, "给我一个计划", { outputVars: ONE_VAR })], []);
  await runWorkflow({ doc, prompt: "开始", ports: h.ports, signal: controller().signal });

  const a = outcomeOf(h, "A");
  eq("交的不是对象也照样成功", a?.status, "success");
  eq("也就没有 outputs", a?.outputs, undefined);
  const prompt = h.calls.find((c) => c.id === "A")?.prompt ?? "";
  check("提示词里没有那张变量表", !prompt.includes("会被检查"), prompt);
  check("也没提会被检查", !prompt.includes("**会被检查**"), prompt);
}

{
  // **同一份参数、同一种产出,只因为后面多了一步就该查。** 这一条和上面那条是一对:
  // 只断言"不查"的话,把校验那条路整个删掉也照样过。
  const h = makePorts({ summary: () => "上午学习,中午午睡,晚上运动。" });
  const doc = docOf(
    [
      node("A", AGENT.id, "给我一个计划", { outputVars: ONE_VAR }),
      node("B", AGENT.id, "整理 {{A.计划}}"),
    ],
    [edge("A", "B")],
  );
  await runWorkflow({ doc, prompt: "开始", ports: h.ports, signal: controller().signal });

  eq("有下游 → 照样查,不交就失败", outcomeOf(h, "A")?.status, "failed");
  const prompt = h.calls.find((c) => c.id === "A")?.prompt ?? "";
  check("有下游 → 表照发", prompt.includes("会被检查"), prompt);
}

{
  // 「期望产出」那段**大白话**是给模型看的说明,不是机器格式 —— 终末节点照发。
  const h = makePorts();
  const doc = docOf(
    [node("A", AGENT.id, "给我一个计划", { outputContract: "列出来一个计划" })],
    [],
  );
  await runWorkflow({ doc, prompt: "开始", ports: h.ports, signal: controller().signal });
  const prompt = h.calls.find((c) => c.id === "A")?.prompt ?? "";
  check("终末节点照样看得到「期望产出」", prompt.includes("列出来一个计划"), prompt);
}

console.log("\n上游结果:点过名的那几步不再整段拼一遍");

/**
 * A 身上有产出变量表,所以它**必须交得出那个变量** —— 交不出这一步就失败、下游被跳过,
 * 断言测的就成了"没跑",而不是"怎么拼的"。所以给它一段带变量的产出,B 才是普通文本。
 */
const upstreamFixture = (): Harness =>
  makePorts({
    summary: (id) =>
      id === "A" ? '```json\n{"计划": "上午学习,中午午睡,晚上运动"}\n```' : `${id} 交出来的整段东西`,
  });

{
  // `{{A.计划}}` 已经把 A 的产出**定点**取进指令了,再整段拼一遍的话,同一份内容会以
  // 两种形状出现在同一段提示词里 —— 白烧一截 token,还逼着模型判断"这两份是不是一回事"。
  const h = upstreamFixture();
  const doc = docOf(
    [node("A", AGENT.id, "找一篇", { outputVars: ONE_VAR }), node("B", AGENT.id, "参考 {{A.计划}} 再写")],
    [edge("A", "B")],
  );
  await runWorkflow({ doc, prompt: "开始", ports: h.ports, signal: controller().signal });

  const prompt = h.calls.find((c) => c.id === "B")?.prompt ?? "";
  check("取到了值", prompt.includes("参考 上午学习,中午午睡,晚上运动 再写"), prompt);
  check("没有「上游步骤的结果」那一段", !prompt.includes("## 上游步骤的结果"), prompt);
  check("上游的整段文本没被拼进来", !prompt.includes('"计划":'), prompt);
  // **也别再说"上游的东西在下面"** —— 下面什么都没有的时候,那是一句把人支到空白上的
  // 指路话,模型会自己编一份"上游结果"出来。这句的判据必须跟着那一段走,不是跟着
  // "图上有上游"走。全被点名时一段都没有,它就一个字都不该出现。
  check("也不说「上游的东西在下面」", !prompt.includes("上游各步的产出见下方"), prompt);
}

{
  // **不带产出的引用不算点名** —— 写 `{{A.params.…}}` 的人要的是那一步的**配置**,
  // 多半还是想看见 A 干了什么。`status` / `error` / `title` 同理。
  const h = upstreamFixture();
  const doc = docOf(
    [
      node("A", AGENT.id, "找一篇"),
      node("B", AGENT.id, "照着 {{A.params.instruction}} 和 {{A.title}} 再来一遍"),
    ],
    [edge("A", "B")],
  );
  await runWorkflow({ doc, prompt: "开始", ports: h.ports, signal: controller().signal });

  const prompt = h.calls.find((c) => c.id === "B")?.prompt ?? "";
  check("上游结果照给", prompt.includes("## 上游步骤的产出"), prompt);
  check("整段文本在", prompt.includes('"计划":'), prompt);
  check("指路那句也在(下面真有东西)", prompt.includes("上游各步的产出见下方"), prompt);
}

{
  // 两个上游、只点名其中一个 → **另一个照给**。这是一条"跳过不等于全跳"的兜底:
  // 写成"有引用就不拼上游"的话,这条会红。
  const h = upstreamFixture();
  const doc = docOf(
    [
      node("A", AGENT.id, "找一篇", { outputVars: ONE_VAR }),
      node("C", AGENT.id, "查数据"),
      node("B", AGENT.id, "参考 {{A.计划}} 再写"),
    ],
    [edge("A", "B"), edge("C", "B")],
  );
  await runWorkflow({ doc, prompt: "开始", ports: h.ports, signal: controller().signal });

  const prompt = h.calls.find((c) => c.id === "B")?.prompt ?? "";
  check("没点名的那个照给", prompt.includes("C 交出来的整段东西"), prompt);
  check("点名的那个不给", !prompt.includes('"计划":'), prompt);
  check("整段那一段还在(给 C 的)", prompt.includes("### C"), prompt);
}

console.log("\n产出变量:模型看得见,下游也取得着");

{
  const h = makePorts({ summary: () => '```json\n{"年份": "2024", "标题": "量子"}\n```' });
  const doc = docOf(
    [
      node("A", AGENT.id, "找一篇", {
        outputVars: VARS,
        outputContract: "给出这篇文章的年份和标题",
      }),
      node("B", AGENT.id, "它发表于 {{A.年份}} 年"),
    ],
    [edge("A", "B")],
  );
  await runWorkflow({ doc, prompt: "开始", ports: h.ports, signal: controller().signal });

  const aPrompt = h.calls.find((c) => c.id === "A")?.prompt ?? "";
  // 大白话的说明和变量表拼出来的样例**在同一节里** —— 拆成两节会让模型以为要满足两组
  // 互不相干的要求。
  check("大白话的说明进了提示词", aPrompt.includes("给出这篇文章的年份和标题"), aPrompt);
  check("变量表的样例也进了提示词", aPrompt.includes('"年份"'), aPrompt);
  check("而且说了会被检查", aPrompt.includes("会被检查"), aPrompt);

  const bPrompt = h.calls.find((c) => c.id === "B")?.prompt ?? "";
  check("下游取到了变量(短写法)", bPrompt.includes("发表于 2024 年"), bPrompt);
}

{
  // 长写法 `outputs.年份` 也认 —— 手写、拷文档过来的人是这么写的。
  const h = makePorts({ summary: () => '{"年份": "2024"}' });
  const doc = docOf(
    [
      node("A", AGENT.id, "找一篇", { outputVars: [{ name: "年份", example: "2024" }] }),
      node("B", AGENT.id, "用 {{A.outputs.年份}}"),
    ],
    [edge("A", "B")],
  );
  await runWorkflow({ doc, prompt: "开始", ports: h.ports, signal: controller().signal });
  const bPrompt = h.calls.find((c) => c.id === "B")?.prompt ?? "";
  check("长写法也解得出来", bPrompt.includes("用 2024"), bPrompt);
}

{
  // 上游**没填变量** → 取不到。报错要**说清下一步改哪儿**(去那一步的产出变量里填上),
  // 而不是只说"取不到"。
  const h = makePorts();
  const doc = docOf([node("A"), node("B", AGENT.id, "用 {{A.年份}}")], [edge("A", "B")]);
  await runWorkflow({ doc, prompt: "开始", ports: h.ports, signal: controller().signal });
  const b = outcomeOf(h, "B");
  eq("B 失败", b?.status, "failed");
  check("说清是「还没有产出变量」", b?.error?.includes("还没有产出变量") === true, b?.error);
  check("并指出了怎么修", b?.error?.includes("产出变量") === true, b?.error);
  check("B 没有被派发", !h.executed().includes("B"), h.executed());
}

{
  // 有产出变量、但没有那个名字 —— 和上面那条**不是一回事**(一个是改上游配置,一个是
  // 改这里的名字),所以话术也要分开。
  //
  // 这里模型**多给了一个 `期刊`** —— 而那一栏没在表里填过。它照样取不到:那张表是一句
  // **承诺**,不是"最好有"的清单。多出来的字段要是也能引用,下游的失败就是随机的
  // (今天跑得通明天跑不通),而图上没有任何地方看得出为什么。
  const h = makePorts({ summary: () => '{"年份": "2024", "期刊": "PRL"}' });
  const doc = docOf(
    [
      node("A", AGENT.id, "找一篇", { outputVars: [{ name: "年份", example: "2024" }] }),
      node("B", AGENT.id, "投在 {{A.期刊}}"),
    ],
    [edge("A", "B")],
  );
  await runWorkflow({ doc, prompt: "开始", ports: h.ports, signal: controller().signal });
  eq("多给的那一个没留下来", (outcomeOf(h, "A")?.outputs as { 期刊?: string } | undefined)?.期刊, undefined);
  const b = outcomeOf(h, "B");
  eq("B 失败", b?.status, "failed");
  check("点了名说没有哪个", b?.error?.includes("期刊") === true, b?.error);
  check("还把有的列出来了", b?.error?.includes("年份") === true, b?.error);
}

/* ────────────────────── 岔路口:选一条路 ────────────────────── */

console.log("\n岔路口");

/**
 * 写作流程的骨架,也是这套语义全部的意义所在:
 *
 *     A ──> F(下一步做什么) ──[再来一轮]──> B ──┐
 *                          └──[进入查重]──> C ──┴──> D(导出)
 *
 * 两条支路**最后汇到同一步**。用户选了一条,另一条连同它的下游一起作废 —— 而 `D`
 * **必须照跑**。
 *
 * ⚠️ 这一条要是错了,现象是"用户选了路、一路跑下来,最后发现最后一步没了",而卡片上
 * 写的还是"上游没有成功" —— 一份**错的原因**,比没有原因难查得多。
 */
const fork = docOf(
  [node("A"), branchNode("F", "下一步做什么"), node("B"), node("C"), node("D")],
  [
    edge("A", "F"),
    edge("F", "B", { label: "再来一轮", note: "在现有稿子上再改一轮。" }),
    edge("F", "C", { label: "进入查重" }),
    edge("B", "D"),
    edge("C", "D"),
  ],
);

{
  // 用户点**第一条**(再来一轮)。
  const h = makePorts({ pick: (_id, options) => ({ edgeId: options[0]?.id ?? "" }) });
  const result = await runWorkflow({
    doc: fork,
    prompt: "写一篇论文",
    ports: h.ports,
    signal: controller().signal,
  });

  eq("分支节点问了一次", h.choicesAsked.length, 1);
  eq("问的是 F", h.choicesAsked[0]?.nodeId, "F");
  eq("给了两条出路", h.choicesAsked[0]?.options.length, 2);
  eq("选项名来自边上的 label", h.choicesAsked[0]?.options[0]?.label, "再来一轮");
  // 按钮下面要显示"这条通向哪一步" —— 只给一个选项名,用户不知道点了会发生什么。
  eq("出路带着它的目标节点标题", h.choicesAsked[0]?.options[0]?.next, "B");

  check("选中的 B 跑了", h.executed().includes("B"), h.executed());
  check("没选的 C 没跑", !h.executed().includes("C"), h.executed());

  eq("C 是 unselected,不是 skipped", outcomeOf(h, "C")?.status, "unselected");
  eq("★ 汇合点 D 照跑(没走的那条路没有把它拖下水)", outcomeOf(h, "D")?.status, "success");
  eq("unselected 不算失败", result.status, "success");

  // 分支节点**不补结果卡**:它的卡就是那张选择卡,而且上面已经写着"你选了 X"了
  // (见调度器 `settle` 里那条)。补一张的话同一个节点会出现两张卡,一张是空的。
  eq("★ 分支节点不补结果卡", outcomeOf(h, "F"), undefined);

  // 用户选了什么、那条边上的说明、他自己临时写的话 —— 三样都该进下一步的提示词。
  const b = h.calls.find((c) => c.id === "B")?.prompt ?? "";
  check("B 的提示词里有「用户选了一条路」那一段", b.includes("## 本次执行的前置选择"), b.slice(0, 120));
  check("说了用户选的是哪一项", b.includes("「再来一轮」"), b.slice(0, 200));
  check("带上了边上的说明(note)", b.includes("在现有稿子上再改一轮"), b.slice(0, 300));
  // 没写就没有那一句 —— 不能凭空多一行"他另外说了一句:"
  check("用户没临时说话就不出现那一句", !b.includes("用户补充说明:"));

  // **分支是透传的** —— 岔路口不换你手上的行李。
  //
  // B 只能连分支(它再连一条别的上游,那条边是活的,它就不管选哪条路都照跑了),
  // 所以上游的内容只能挂在分支身上过来。没有这条通路,「再改一轮」那一步就得凭一句
  // 话重写一篇它没读过的稿子 —— 分叉等于把东西丢了。
  check("★ B 拿得到上游(A)的内容", b.includes("A 的结果"), b);
  check("那段还是原样,没多套一层分支的标题", !b.includes("### 下一步做什么"), b);
}

{
  // 反过来点**第二条**(进入查重)。B 那一支作废,D 照样得跑。
  const h = makePorts({ pick: (_id, options) => ({ edgeId: options[1]?.id ?? "" }) });
  const result = await runWorkflow({
    doc: fork,
    prompt: "写一篇论文",
    ports: h.ports,
    signal: controller().signal,
  });

  check("选中的 C 跑了", h.executed().includes("C"), h.executed());
  check("没选的 B 没跑", !h.executed().includes("B"), h.executed());
  eq("B 是 unselected", outcomeOf(h, "B")?.status, "unselected");
  eq("★ 换一条路,D 照样跑", outcomeOf(h, "D")?.status, "success");
  eq("还是 success", result.status, "success");

  const c = h.calls.find((x) => x.id === "C")?.prompt ?? "";
  check("C 也拿到了那一段", c.includes("## 本次执行的前置选择"));
  check("C 看到的是「进入查重」", c.includes("「进入查重」"));
  check("C 不该看到 B 那条边的说明", !c.includes("在现有稿子上再改一轮"));
}

{
  // 用户在选择时临时写的一句话。**这是"断点"真正的用法**:不只是点一下,还要说
  // "第三章太啰嗦"这种只对这一次成立的话。
  const h = makePorts({
    pick: (_id, options) => ({ edgeId: options[0]?.id ?? "", comment: "第三章太啰嗦,删掉一半" }),
  });
  await runWorkflow({ doc: fork, prompt: "写一篇论文", ports: h.ports, signal: controller().signal });
  const b = h.calls.find((c) => c.id === "B")?.prompt ?? "";
  check("用户临时写的那句话进了下一步的提示词", b.includes("第三章太啰嗦,删掉一半"), b.slice(0, 400));
}

{
  // **没填 label 就用目标节点的标题。** 一根说不出名字的线对用户没有意义,而"通向谁"
  // 至少说明了它会走到哪 —— 比一个空按钮强。
  const bare = docOf(
    [branchNode("F"), node("写作"), node("查重")],
    [edge("F", "写作"), edge("F", "查重")],
  );
  const h = makePorts();
  await runWorkflow({ doc: bare, prompt: "开始", ports: h.ports, signal: controller().signal });
  eq("没填 label 时用目标节点的标题", h.choicesAsked[0]?.options[0]?.label, "写作");
  eq("第二条同理", h.choicesAsked[0]?.options[1]?.label, "查重");
}

/**
 * **「没走」会沿着链条往下传。**
 *
 *     F(岔路口) ──[改]──> B ──> B2 ──┐
 *                └──[查重]──> C ─────┴──> D
 *
 * 选「查重」之后 B 和 **B2** 都得是 `unselected`,而 D 得上游里有一个是 unselected、
 * 另一个是**成功** —— 这种"混合"是最容易写错的一处:只要"有一个不是成功"就跳过的话,
 * D 会被整步作废,而现象是**最后一步凭空消失**。
 */
{
  const deep = docOf(
    [branchNode("F", "下一步"), node("B"), node("B2"), node("C"), node("D")],
    [
      edge("F", "B", { label: "改" }),
      edge("F", "C", { label: "查重" }),
      edge("B", "B2"),
      edge("B2", "D"),
      edge("C", "D"),
    ],
  );
  const h = makePorts({ pick: (_id, options) => ({ edgeId: options[1]?.id ?? "" }) });
  const result = await runWorkflow({
    doc: deep,
    prompt: "开始",
    ports: h.ports,
    signal: controller().signal,
  });

  eq("B 没走", outcomeOf(h, "B")?.status, "unselected");
  eq("★ B 的下游 B2 也没走(传递)", outcomeOf(h, "B2")?.status, "unselected");
  eq("★ 汇合点 D 的上游一半没走、一半成功 —— 它照跑", outcomeOf(h, "D")?.status, "success");
  eq("整次运行还是 success", result.status, "success");
  check("D 真的被执行了", h.executed().includes("D"), h.executed());
}

{
  // **引用一个"这次没走"的上游。**
  //
  // 失败是对的 —— 那一步确实没有产出。但**话必须说对**:不拦的话它会掉进 `readVar`
  // 里那句"去那一步的产出变量里把 X 填上",而那句建议在这里是**错的**(补什么都没用,
  // 那条路这次压根没走)。用户会跑去改一个根本没跑的节点,然后发现改了还是报一样的错。
  const h = makePorts({ pick: (_id, options) => ({ edgeId: options[1]?.id ?? "" }) });
  await runWorkflow({
    doc: docOf(
      [branchNode("F"), node("B"), node("C"), node("D", AGENT.id, "用 {{B.初稿}}")],
      [
        edge("F", "B", { label: "改" }),
        edge("F", "C", { label: "查重" }),
        edge("B", "D"),
        edge("C", "D"),
      ],
    ),
    prompt: "开始",
    ports: h.ports,
    signal: controller().signal,
  });
  const d = outcomeOf(h, "D");
  eq("D 失败了(它点名要的东西这次没有)", d?.status, "failed");
  check("说的是「没有走这条路」", d?.error?.includes("没有走这条路") === true, d?.error);
  check(
    "不甩那句「去填产出变量」(在这儿是错的建议)",
    (d?.error ?? "").includes("产出变量里把") === false,
    d?.error,
  );
}

{
  // 但**元信息那几种照给** —— `{{B.status}}` 取到 `unselected` 恰恰是它该有的样子
  // (有人就是要拿它判断"那条路走没走")。拦掉的话这种写法就没法用了。
  const h = makePorts({ pick: (_id, options) => ({ edgeId: options[1]?.id ?? "" }) });
  await runWorkflow({
    doc: docOf(
      [branchNode("F"), node("B"), node("C"), node("D", AGENT.id, "上一步的状态是 {{B.status}}")],
      [
        edge("F", "B", { label: "改" }),
        edge("F", "C", { label: "查重" }),
        edge("B", "D"),
        edge("C", "D"),
      ],
    ),
    prompt: "开始",
    ports: h.ports,
    signal: controller().signal,
  });
  eq("D 跑起来了", outcomeOf(h, "D")?.status, "success");
  check(
    "status 解出来是 unselected",
    h.calls.find((c) => c.id === "D")?.prompt.includes("unselected") === true,
    h.calls.find((c) => c.id === "D")?.prompt.slice(0, 300),
  );
}

{
  // **「就到这儿」** —— 界面自带的那个选项,不是图上的一条边(见 `BRANCH_STOP_CHOICE`)。
  //
  // 它落地的方式很干净:存进 `chosen` 的是一个**谁也匹配不上的 id**,于是这个分支的
  // 每一条出边都判死,下游整片标 `unselected`,这次运行自然收场 —— 调度器里**没有**
  // 第二个"停止"分支要维护,也就不会有第二种收场方式和它对不上。
  const h = makePorts({ pick: () => ({ edgeId: BRANCH_STOP_CHOICE }) });
  const result = await runWorkflow({
    doc: fork,
    prompt: "写一篇论文",
    ports: h.ports,
    signal: controller().signal,
  });

  eq("问过岔路口", h.choicesAsked.length, 1);
  check("除了 A,一个节点都没跑", h.executed().filter((x) => x !== "A").length === 0, h.executed());
  eq("B 是 unselected", outcomeOf(h, "B")?.status, "unselected");
  eq("C 也是 unselected", outcomeOf(h, "C")?.status, "unselected");
  eq("汇合点 D 也没跑(两条路都没走)", outcomeOf(h, "D")?.status, "unselected");
  // **不是失败。** 用户自己按的停止,卡片上不该出现"某一步失败了"那种话。
  eq("整次运行是 success", result.status, "success");
  eq("分支节点自己成功了", result.outcomes.get("F")?.status, "success");
}

{
  // **真失败还是要和"没走"分开。** 上游炸了 → `skipped`,文案说"没有成功";这和
  // "你自己选了别的路"是两句不同的话,混用会让用户去翻一个根本没跑的节点的日志。
  const h = makePorts({ fail: (id) => id === "A" });
  const result = await runWorkflow({
    doc: docOf([node("A"), node("B")], [edge("A", "B")]),
    prompt: "开始",
    ports: h.ports,
    signal: controller().signal,
  });
  eq("上游失败 → 下游是 skipped", outcomeOf(h, "B")?.status, "skipped");
  check("文案说的是「没有成功」", outcomeOf(h, "B")?.error?.includes("没有成功") === true, outcomeOf(h, "B")?.error);
  eq("有失败 → status = failed", result.status, "failed");
  check("下游没被派发", !h.executed().includes("B"), h.executed());
}

{
  // 一根出路都没有的岔路口是**坏图**:图会永远停在那儿,而用户看到的只是一张没有
  // 按钮的卡片。要明确失败,并且说清怎么修。
  const h = makePorts();
  await runWorkflow({
    doc: docOf([branchNode("F", "断了的分支")], []),
    prompt: "开始",
    ports: h.ports,
    signal: controller().signal,
  });
  eq("没有出路 → failed", outcomeOf(h, "F")?.status, "failed");
  check("说清怎么修", outcomeOf(h, "F")?.error?.includes("拉几根线") === true, outcomeOf(h, "F")?.error);
}

{
  // **挂在岔路口时被取消。** 这条只在真实现里才有意义(那里是一个真的 promise),
  // 但调度器这一头必须做到:取消之后这个节点**定案成 cancelled**,而且下游一个都不
  // 派发 —— 不定案的话它会永远停在"没跑",而 `RunResult` 里的收尾逻辑会把它当成
  // "图里有环"报出来。
  const ctl = controller();
  const h = makePorts({ chooseDelayMs: 80 });
  const pending = runWorkflow({
    doc: fork,
    prompt: "写一篇论文",
    ports: h.ports,
    signal: ctl.signal,
  });
  setTimeout(() => ctl.abort(), 30);
  const result = await pending;

  eq("取消 → status = cancelled", result.status, "cancelled");
  check("确实问过岔路口", h.choicesAsked.length === 1, h.choicesAsked.length);
  check("下游一个都没跑", !h.executed().includes("B") && !h.executed().includes("C"), h.executed());
  // 没跑到的节点不能缺席(否则渲染端会一直等一个永不到来的结果)。
  check("B 有结局", outcomeOf(h, "B") !== undefined);
  eq("F 是 cancelled,不是「图里有环」", outcomeOf(h, "F")?.status, "cancelled");
}

/* ────────────────────── 回头 ────────────────────── */

console.log("\n回头:分出去的一条线指回前面");

/** `A → D(成稿) → F(稿子怎么样)`;`F` 的一条出路指回 `D`,另一条通向 `G(定稿)`。 */
function loopDoc(): WorkflowDoc {
  return docOf(
    [node("A"), node("D", AGENT.id, "写初稿"), branchNode("F", "稿子怎么样"), node("G")],
    [
      edge("A", "D"),
      edge("D", "F"),
      edge("F", "D", { label: "再改一轮", note: "只改他提到的地方" }),
      edge("F", "G", { label: "就这样，定稿" }),
    ],
  );
}

const runsOf = (h: Harness, id: string): Call[] => h.calls.filter((c) => c.id === id);

{
  // 用户前两轮点「再改一轮」,第三轮点「定稿」—— 迭代两轮之后收工。
  let asked = 0;
  const h = makePorts({
    pick: (_nodeId, options) => {
      asked += 1;
      const want = asked <= 2 ? "再改一轮" : "就这样，定稿";
      const hit = options.find((o) => o.label === want) ?? options[0];
      return { edgeId: hit?.id ?? "", comment: `第 ${asked} 次意见` };
    },
  });

  const result = await runWorkflow({
    doc: loopDoc(),
    prompt: "写一篇引言",
    ports: h.ports,
    signal: controller().signal,
  });

  eq("跑完了,而且成功", result.status, "success");
  eq("环里那一步真的重跑了(成稿跑了三轮)", runsOf(h, "D").length, 3);
  eq("岔路口一次不落地问了三次", h.choicesAsked.length, 3);
  // ★ 这两条是"回卷只抹环体"的钉子。抹多了的话 `A` 会白跑两遍(它和这个环无关,
  //   而重跑它可能很贵 —— 检索、跑脚本都在这一步之后被白白重复)。
  eq("★ 环外的节点只跑一次", runsOf(h, "A").length, 1);
  eq("环的出口跑了一次", runsOf(h, "G").length, 1);

  const d1 = runsOf(h, "D")[0]?.prompt ?? "";
  const d2 = runsOf(h, "D")[1]?.prompt ?? "";
  const d3 = runsOf(h, "D")[2]?.prompt ?? "";
  // ★ 这一条是整件事的意义所在:没有它,"再改一轮"就是"从头再写一遍"。
  //
  //   第二轮拿到的是**整条流程的记录**(见 `flowRecordSection`):开头写着这条流程是
  //   干什么的、用户最初要什么,然后是各步的产出 —— 其中 `### D` 那一条就是它自己
  //   上一版(环体在重跑时**只清"谁跑过了",不清记录**,见 `rewindLoop`)。
  check("★ 第二轮看得到整条流程的记录", d2.includes("## 流程记录"), d2.slice(0, 400));
  check("记录的开头写着这条流程是什么", d2.includes("**本流程**:测试流程"), d2.slice(0, 400));
  check("也知道用户最初要的是什么", d2.includes("**用户最初的要求**:写一篇引言"));
  check("★ 而且自己上一版就在记录里", d2.includes("### D\nD 的结果"), d2.slice(0, 600));
  // 第一轮**也有**记录 —— A 已经跑完了,记录里就有它。要紧的是**没有它自己**:
  // 一个节点不该在自己的输入里看到自己的产出(那会是它还没交的东西)。
  check("第一轮也有记录(前面的 A 已经跑完)", d1.includes("## 流程记录"), d1.slice(0, 400));
  check("★ 但记录里没有它自己", !d1.includes("### D"), d1.slice(0, 600));
  // ★ 用户写的那句话挂在**选择**上,而回头会把 `chosen` 清掉 —— 所以这条钉的是
  //   `lastPick` 那一份:清掉了的话,"第三章太啰嗦"就丢了。
  check("★ 重跑时仍然知道用户点了哪条路", d2.includes("再改一轮"), d2.slice(0, 400));
  check("★ 也知道他当时写了什么", d2.includes("第 1 次意见"));
  // ★ **用户的历次意见一条都不删** —— 与"每一步只留最新一版"正相反。理由是它们是
  //   历史,而历史是迭代里唯一不会过期的信息:第三轮该知道第一轮否掉过什么,否则它会
  //   照着自己的想法再犯一次。
  check(
    "★ 第三轮同时看得见前两次的意见",
    d3.includes("第 1 次意见") && d3.includes("第 2 次意见"),
    d3.slice(0, 800),
  );
  // 而**产出**只留最新一版 —— 第三轮记录里的 D 是它第二轮交的那份,第一版已被换掉。
  // 这条同时钉住"记录不会随轮数线性膨胀":第几轮都好,D 只有一条。
  eq("★ 记录里的产出只留最新一版(D 只出现一次)", d3.split("### D").length - 1, 1);
  check("而且那一条标着是第几轮", d3.includes("### D(第 2 轮)"), d3.slice(0, 800));

  // 岔路口选了之后**不补结果卡**(它的卡就是那张选择卡)—— 回头那两轮同样不补。
  const cards = h.reports.filter((r) => r.kind === "node.settled" && r.node.id === "F");
  eq("岔路口一张结果卡都不发", cards.length, 0);
  eq("岔路口起了三次(证明真的重新派发了)", h.reports.filter((r) => r.kind === "node.started" && r.node.id === "F").length, 3);
  // 每一轮的产出都留一张卡 —— 迭代了几轮,对话里就看得见几版(这是有意的:
  // 用户要能回头翻"上一次那版长什么样")。
  eq("成稿留下三张结果卡", h.reports.filter((r) => r.kind === "node.settled" && r.node.id === "D").length, 3);
}

{
  // **回头之后走另一条出路。** 这条钉的是"分支的其它出路要重新可选" —— 第一轮没被
  // 选中那条如果留着一个 `unselected` 的结局,第二轮用户回心转意点它,它**永远不会跑**,
  // 而卡片上写着"没走这条路",用户刚刚才点了它。
  let asked = 0;
  const h = makePorts({
    pick: (_nodeId, options) => {
      asked += 1;
      const want = asked <= 1 ? "再改一轮" : "就这样，定稿";
      const hit = options.find((o) => o.label === want) ?? options[0];
      return { edgeId: hit?.id ?? "" };
    },
  });

  const result = await runWorkflow({
    doc: loopDoc(),
    prompt: "写一篇引言",
    ports: h.ports,
    signal: controller().signal,
  });

  eq("绕一圈之后选了另一条 → 成功", result.status, "success");
  eq("★ 第一条出路走完之后另一条还走得通", runsOf(h, "G").length, 1);
  eq("成稿跑了两轮", runsOf(h, "D").length, 2);
}

{
  // **回头之后点「就到这儿」。** 停下来不是失败(同非环的那种情形,见 `BRANCH_STOP_CHOICE`)。
  let asked = 0;
  const h = makePorts({
    pick: (_nodeId, options) => {
      asked += 1;
      if (asked === 1) {
        const again = options.find((o) => o.label === "再改一轮");
        return { edgeId: again?.id ?? "" };
      }
      return { edgeId: BRANCH_STOP_CHOICE };
    },
  });

  const result = await runWorkflow({
    doc: loopDoc(),
    prompt: "写一篇引言",
    ports: h.ports,
    signal: controller().signal,
  });

  eq("停在环里 → 这次运行仍然算成功", result.status, "success");
  eq("成稿跑了两轮就停下了", runsOf(h, "D").length, 2);
  eq("定稿一次都没跑", runsOf(h, "G").length, 0);
  eq("★ 出口是「没走这条路」,不是「失败」", outcomeOf(h, "G")?.status, "unselected");
}

{
  // **环上没有岔路口** —— 坏图。存盘时 `validateDag` 会拒,但真到了调度器这一层,
  // 它不能被当成一条直线悄悄跑一遍(用户画的明明是个死循环),也不能永远挂着。
  const h = makePorts();
  const result = await runWorkflow({
    doc: docOf([node("A"), node("B")], [edge("A", "B"), edge("B", "A")]),
    prompt: "跑",
    ports: h.ports,
    signal: controller().signal,
  });
  eq("没闸门的环:两个都有结局(不留空)", result.outcomes.size, 2);
  check(
    "而且说的是实话(不是「失败」,是「依赖没满足」)",
    outcomeOf(h, "A")?.error?.includes("环") === true,
    outcomeOf(h, "A")?.error,
  );
}

/* ────────────────────── 「读流程记录」那个开关 ────────────────────── */

console.log("\n读流程记录:默认按图的结构,拨过之后归用户");

{
  // `undefined` 和 `false` 必须分得开(见 `flowRecordOf`):前者是"没表过态",该跟着
  // "这个节点在不在环上"走;后者是用户**明确关掉**的,不该被默认值覆盖回去。
  //
  // 所以这一组把两种情形**对着摆**:环上但关了,环外但开了。
  let asked = 0;
  const h = makePorts({
    pick: (_nodeId, options) => {
      asked += 1;
      const want = asked <= 1 ? "再改一轮" : "就这样，定稿";
      const hit = options.find((o) => o.label === want) ?? options[0];
      return { edgeId: hit?.id ?? "" };
    },
  });
  const doc = docOf(
    [
      node("A"),
      // 在环上 —— 默认该读,但这里**明确关掉**。
      node("D", AGENT.id, "写初稿", { flowRecord: false }),
      branchNode("F", "稿子怎么样"),
      // 不在环上 —— 默认该关,但这里**明确打开**。
      node("G", AGENT.id, "G 做什么", { flowRecord: true }),
    ],
    [
      edge("A", "D"),
      edge("D", "F"),
      edge("F", "D", { label: "再改一轮" }),
      edge("F", "G", { label: "就这样，定稿" }),
    ],
  );
  await runWorkflow({ doc, prompt: "写一篇引言", ports: h.ports, signal: controller().signal });

  const runs = (id: string): Call[] => h.calls.filter((c) => c.id === id);
  const d2 = runs("D")[1]?.prompt ?? "";
  const g = runs("G")[0]?.prompt ?? "";
  check("★ 环上、但明确关掉 → 不读记录", !d2.includes("## 流程记录"), d2.slice(0, 300));
  check("退回普通的那种:只给上游产出", d2.includes("## 上游步骤的产出"), d2.slice(0, 400));
  check("★ 不在环上、但明确打开 → 读记录", g.includes("## 流程记录"), g.slice(0, 300));
  check("记录里含它前面那几步的产出", g.includes("### D"), g.slice(0, 600));
}

/* ────────────────────── 续跑 ────────────────────── */

console.log("\n续跑:进程死过一次之后,接着上次断掉的地方往下跑");

/** 等某个条件成立。轮询而不是固定 `sleep(毫秒)` —— 后者在慢机器上会假失败。 */
async function until(cond: () => boolean, why: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`等不到:${why}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** 把调度器交出来的一份状态包成续跑要的输入 —— 落盘那一头做的就是这件事。 */
function resumeFrom(
  state: RunState,
  answer?: { nodeId: string; choice: BranchChoice },
): RunResume {
  return {
    record: state.record,
    rounds: state.rounds,
    picks: state.picks,
    settled: state.outcomes,
    ...(answer ? { answer } : {}),
  };
}

const roundOf = (state: RunState, id: string): number | undefined =>
  state.rounds.find(([n]) => n === id)?.[1];

/** `RunState.outcomes` 是 `[id, NodeOutcome][]`(落盘友好),不是 Map —— 读的时候包一层。 */
const settledOf = (state: RunState, id: string): NodeOutcome | undefined =>
  state.outcomes.find(([n]) => n === id)?.[1];

{
  // ── 第一次运行:停在「稿子怎么样」那一刻,应用被关掉了 ──
  const doc = loopDoc();
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const h1 = makePorts({ hold: (id) => (id === "F" ? held : undefined) });
  const ac1 = controller();
  const first = runWorkflow({
    doc,
    prompt: "写一篇引言",
    ports: h1.ports,
    signal: ac1.signal,
  });

  await until(() => h1.snapshots.some((s) => s.awaiting.includes("F")), "调度器停在岔路口上");
  // **应用就是在这一刻被关掉的。** 磁盘上留下的就是这一份(见 `runStore`)。
  const parked = h1.snapshots.filter((s) => s.awaiting.includes("F")).at(-1) as RunState;

  eq("★ 停在哪一格里写着", parked.awaiting.join(","), "F");
  eq(
    "那一刻它前面的两步都已经定案",
    parked.outcomes.filter(([, o]) => o.status === "success").length,
    2,
  );
  check(
    "流程记录也在里面(第一步的产出)",
    parked.record.some((e) => e.kind === "step" && e.nodeId === "A"),
    parked.record,
  );
  eq("还没定下来的岔路口,选择表是空的", parked.picks.length, 0);

  // 进程没了:取消 + 放行那次等待(现实中这两件事是一起发生的)。
  ac1.abort();
  release();
  await first;

  // ── 重启之后:用户在那张旧卡片上点了「再改一轮」,顺手写了句话 ──
  const h2 = makePorts({
    pick: (_id, options) => ({
      // 续跑补的那一下之后,岔路口会因为**回头**再问一次 —— 那时收工。
      edgeId: options.find((o) => o.label === "就这样，定稿")?.id ?? "",
    }),
  });
  const second = await runWorkflow({
    doc,
    prompt: "写一篇引言",
    ports: h2.ports,
    signal: controller().signal,
    resume: resumeFrom(parked, {
      nodeId: "F",
      choice: { edgeId: "e_F__D", comment: "第三章删一半" },
    }),
  });

  eq("接着跑完了", second.status, "success");
  // ★ 这是整件事的意义:上次跑过的那两步**一步都没重跑**。
  eq("★ 已经定过案的步骤一步都不重跑", h2.executed().filter((id) => id === "A").length, 0);
  // ★ 而回头那一下**是**要重跑的 —— 它正是"再改一轮"。
  eq("★ 回头的目标重跑了一次", h2.executed().filter((id) => id === "D").length, 1);
  eq("★ 后面那一步也跑到了", h2.executed().filter((id) => id === "G").length, 1);
  // 预置答案不是"跳过问用户",而是"问的那一下已经发生过了" —— 端口照样收到一次调用,
  // 只是带着答案(它要据此把界面上那张卡**原地**改成"你选了 X")。
  eq("预置的答案交给了端口,没有另外再问", h2.presetSeen.length, 1);
  eq("用的就是用户点的那条出路", h2.presetSeen[0]?.edgeId, "e_F__D");
  eq("★ 那个岔路口后来又真问了一次(回头)", h2.choicesAsked.length, 2);
  // 轮次要接着数 —— 从 1 重来的话,记录里会出现两条"第 1 轮"。
  eq("★ 回头那一轮的轮次接着数", roundOf(second.state, "D"), 2);
  // 记录里 D 还是只有一条(**换掉**旧的,不是追加),而且轮次接着数。
  const dStep = second.state.record.find((e) => e.kind === "step" && e.nodeId === "D");
  eq(
    "记录里 D 还是只有一条(换掉旧的,不是追加)",
    second.state.record.filter((e) => e.kind === "step" && e.nodeId === "D").length,
    1,
  );
  eq("而且它标着第 2 轮", dStep?.kind === "step" ? dStep.round : undefined, 2);

  const d2 = h2.calls.find((c) => c.id === "D")?.prompt ?? "";
  // 用户那句话要跟着走 —— 否则"按他说的改"就不知道改哪儿。
  check("★ 用户在选择时写的那句话传下去了", d2.includes("第三章删一半"), d2.slice(0, 600));
  check("记录里也留着那次选择", d2.includes("### 用户的选择"), d2.slice(0, 900));
  // ★ 而且它看得见**自己上一版** —— 没有这一条,"再改一轮"就退化成"从头再写一遍"。
  check("★ 重跑时看得见自己上一版", d2.includes("### D\nD 的结果"), d2.slice(0, 900));
}

/**
 * 两处岔路口、**互不依赖**的那个形状 —— 于是一条运行里两条都在等人(见
 * `RunState.awaiting`:它是列表不是单个,就是为了这一种)。
 */
function twoForksDoc(): WorkflowDoc {
  return docOf(
    [
      node("A"),
      branchNode("F", "先选一个"),
      node("B"),
      node("C"),
      branchNode("H", "再选一个"),
      node("X"),
      node("Y"),
    ],
    [
      edge("A", "F"),
      edge("F", "B", { label: "走 B", note: "按 B 那条路走" }),
      edge("F", "C", { label: "走 C" }),
      edge("A", "H"),
      edge("H", "X", { label: "走 X" }),
      edge("H", "Y", { label: "走 Y" }),
    ],
  );
}

{
  // A ─┬→ F(岔路口)─┬[走 B]→ B
  //    │            └[走 C]→ C
  //    └→ H(岔路口)─┬[走 X]→ X
  //                 └[走 Y]→ Y
  //
  // 用户在第一处点了「走 B」,第二处一直没点,然后应用被关了。
  const doc = twoForksDoc();
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const h1 = makePorts({
    pick: (_id, options) => ({ edgeId: options.find((o) => o.label === "走 B")?.id ?? "" }),
    hold: (id) => (id === "H" ? held : undefined),
    // B 慢一点,好让它**停在半路**上 —— 那一刻它还没有结局,所以重启之后它会重跑。
    delayMs: (id) => (id === "B" ? 3000 : 5),
  });
  const ac1 = controller();
  const first = runWorkflow({ doc, prompt: "跑", ports: h1.ports, signal: ac1.signal });

  const parkedAt = (s: RunState): boolean =>
    s.awaiting.includes("H") &&
    s.outcomes.some(([id, o]) => id === "C" && o.status === "unselected");
  await until(() => h1.snapshots.some(parkedAt), "第一处选完、第二处停着");
  const parked = h1.snapshots.filter(parkedAt).at(-1) as RunState;

  eq("★ 两处岔路口,只有一处还在等", parked.awaiting.join(","), "H");
  eq("★ 第一处选过的那条路记在存档里", parked.picks.length, 1);
  check(
    "★ 跑到一半的 B 没有结局(所以它不是「已定案」)",
    !parked.outcomes.some(([id]) => id === "B"),
  );

  ac1.abort();
  release();
  await first;

  // ── 重启之后,用户点了「走 X」──
  const h2 = makePorts({});
  const second = await runWorkflow({
    doc,
    prompt: "跑",
    ports: h2.ports,
    signal: controller().signal,
    resume: resumeFrom(parked, { nodeId: "H", choice: { edgeId: "e_H__X" } }),
  });

  eq("只派发了该派发的两个", [...h2.executed()].sort().join(","), "B,X");
  eq("★ 第一处岔路口没有被重新问一遍", h2.choicesAsked.length, 1);
  eq("★ 「没走这条路」仍然算没走", second.outcomes.get("C")?.status, "unselected");
  eq("这次选的另一条,两边同样判死", second.outcomes.get("Y")?.status, "unselected");
  eq("收尾是成功的", second.status, "success");

  // ★ 这一条钉的是**存档里的 `picks` 必须恢复**。
  //
  //   B 是"跑到一半被打断"的那一个,所以它会重跑;而它上一轮是从「走 B」那条路上来
  //   的。恢复的是 `lastPick`(见 `rewindLoop` 那段注释:回头会清 `chosen`,而
  //   "这一步是从哪条路来的"要一直说得出来),B 的提示词里才有那一段。
  const b = h2.calls.find((c) => c.id === "B")?.prompt ?? "";
  check(
    "★ 重跑的 B 知道自己上一轮是从哪条路来的",
    b.includes("## 本次执行的前置选择"),
    b.slice(0, 600),
  );
  check("而且那条路上的说明跟着一起回来了", b.includes("按 B 那条路走"), b.slice(0, 800));

  // ── 反证:同一份存档,**不恢复 picks** 会怎样 ──
  //   两处只差这一个字段,所以上面那两条不是"碰巧对"。
  const h3 = makePorts({});
  await runWorkflow({
    doc,
    prompt: "跑",
    ports: h3.ports,
    signal: controller().signal,
    resume: { ...resumeFrom(parked, { nodeId: "H", choice: { edgeId: "e_H__X" } }), picks: [] },
  });
  const b3 = h3.calls.find((c) => c.id === "B")?.prompt ?? "";
  check(
    "★ 少了 picks,重跑的那一步就不知道自己是从哪条路来的",
    !b3.includes("按 B 那条路走"),
    b3.slice(0, 600),
  );
}

/* ────────────── 「运行前先问我」(对话节点上的开关) ──────────────
 *
 * 跑到开了这个开关的对话节点时,先把决定权交给用户,四选一:
 *
 *   | 选项 | 之后 |
 *   |---|---|
 *   | 用这一步的指令 | 照常跑,用户在框里补的话接进提示词 |
 *   | 跳过 | 这一步不跑,`unselected` 往下传 |
 *   | 重复上一个任务 | 上一步连同它的后续作废重跑,**跑完回到这一步再问一次** |
 *   | 退出流程 | 整张图收场 |
 *
 * 四条**都不是图上的边** —— 它们是代码给的哨兵(见 `ASK_CHOICES`)。所以这一节要盯的
 * 是:它们确实影响了调度,而且没把既有的那套(结局传播、回卷、流程记录)弄坏。
 */

/** A →(问)B → C。B 是那个开了"先问我"的对话节点。 */
function askDoc(on = true): WorkflowDoc {
  return docOf(
    [
      node("A"),
      node("B", CONVERSATION.id, "按上面的结果写第三章", on ? { askBeforeRun: true } : {}),
      node("C"),
    ],
    [edge("A", "B"), edge("B", "C")],
  );
}

const askOption = (options: WorkflowChoiceOption[], id: string): string =>
  options.find((o) => o.id === id)?.id ?? "";

console.log("\n运行前先问我");

{
  // ── 用这一步的指令(+ 补充说明)──
  const h = makePorts({
    pick: (_id, options) => ({ edgeId: askOption(options, ASK_RUN_CHOICE), comment: "只改第三节" }),
  });
  const result = await runWorkflow({
    doc: askDoc(),
    prompt: "写一篇论文",
    ports: h.ports,
    signal: controller().signal,
  });

  eq("问了一次", h.choicesAsked.length, 1);
  eq("问的是那一步", h.choicesAsked[0]?.nodeId, "B");
  eq("四个选项", h.choicesAsked[0]?.options.length, 4);
  // 四个哨兵。**一条边都匹配不上** —— 那正是它们能表达"这条路不是图上的路"的原因。
  eq(
    "四个选项就是那四条",
    h.choicesAsked[0]?.options.map((o) => o.id).join(","),
    [ASK_RUN_CHOICE, ASK_SKIP_CHOICE, ASK_REPEAT_CHOICE, ASK_EXIT_CHOICE].join(","),
  );
  // 界面靠这一位决定"弹窗还是卡片"(见 `WorkflowNodeChoiceEvent.ask`)。
  // ⚠️ 它**不是** `runner.kind === "branch"` 那种判断 —— 那一位说的是"代码打算怎么
  // 处理它",不是"它是谁"。
  check("选项里带着输入框提示", h.choicesAsked[0]?.options[0]?.input !== undefined);

  check("B 照常跑了", h.executed().includes("B"), h.executed());
  check("C 也跑了", h.executed().includes("C"), h.executed());
  eq("整张图成功", result.status, "success");

  const b = h.calls.find((c) => c.id === "B")?.prompt ?? "";
  check("提示词里有「前置选择」那一段", b.includes("## 本次执行的前置选择"), b.slice(0, 200));
  check("说了用户选的是哪一项", b.includes("用这一步的指令"), b.slice(0, 300));
  check("★ 用户补的那句话进去了", b.includes("只改第三节"), b.slice(0, 400));
  check("节点自己的指令还在", b.includes("按上面的结果写第三章"));
}

{
  // ── 跳过 ──
  // 标 `unselected` 而**不是** `skipped`:两者对下游的传播完全不同 —— "没走这条路"
  // 会被下游的汇合点忽略掉,而"上游失败了"会把下游一起拖死。
  const h = makePorts({ pick: (_id, options) => ({ edgeId: askOption(options, ASK_SKIP_CHOICE) }) });
  const result = await runWorkflow({
    doc: askDoc(),
    prompt: "写一篇论文",
    ports: h.ports,
    signal: controller().signal,
  });

  check("B 没跑", !h.executed().includes("B"), h.executed());
  eq("★ B 是 unselected,不是 skipped", outcomeOf(h, "B")?.status, "unselected");
  check("C 也没跑(它的来路没走)", !h.executed().includes("C"), h.executed());
  eq("★ C 也是 unselected,不是 skipped", outcomeOf(h, "C")?.status, "unselected");
  eq("跳过不是失败", result.status, "success");
}

{
  // ── 退出流程 ──
  // 收场方式和分支的「就到这儿」**一模一样**:下游整片 `unselected`,没有可派发的节点,
  // 循环自然退出。**不特判"停"这个状态** —— 特判就有第二种收场方式。
  //
  // (用户那段字会由 `runner.ts` 发进主对话。那一半要真会话,在端到端里验,不在这儿。)
  const h = makePorts({
    pick: (_id, options) => ({
      edgeId: askOption(options, ASK_EXIT_CHOICE),
      comment: "算了,我先自己看看",
    }),
  });
  const result = await runWorkflow({
    doc: askDoc(),
    prompt: "写一篇论文",
    ports: h.ports,
    signal: controller().signal,
  });

  check("B 没跑", !h.executed().includes("B"), h.executed());
  eq("B 是 unselected", outcomeOf(h, "B")?.status, "unselected");
  check("★ 后面的 C 一起收场了", !h.executed().includes("C"), h.executed());
  eq("退出不是失败", result.status, "success");
}

{
  // ── ★ 重复上一个任务 ──
  //
  // 这一条是整个功能的重头:上一步**连同它的后续作废重跑**,跑完**回到这一步再问一次**。
  // 机制上它走的是分支回卷那条通路(`pendingLoopBack` → `settle` → `rewindLoop`),只是
  // 标记不是一条边、而是 `ASK_REPEAT_CHOICE` 这个哨兵。
  //
  // 三件必须一起成立,少一件这个选项就是坏的:
  //   1. 上一步真的重跑了(不是跳过去);
  //   2. 重跑完之后**又问了一次**(不是一路往下走);
  //   3. 用户那句"哪里不对"**看得见** —— 否则他写的那段字当着面丢掉。
  let round = 0;
  const h = makePorts({
    pick: (_id, options) => {
      round += 1;
      return round === 1
        ? { edgeId: askOption(options, ASK_REPEAT_CHOICE), comment: "第三节论据不够,重写" }
        : { edgeId: askOption(options, ASK_RUN_CHOICE) };
    },
  });
  const result = await runWorkflow({
    doc: askDoc(),
    prompt: "写一篇论文",
    ports: h.ports,
    signal: controller().signal,
  });

  eq("★ 问了两次(重复完回到同一个节点)", h.choicesAsked.length, 2);
  eq("两次问的是同一个节点", h.choicesAsked[1]?.nodeId, "B");
  eq("★ A 重跑了一遍(一共两次)", h.executed().filter((x) => x === "A").length, 2);
  eq("B 只在第二轮真跑了", h.executed().filter((x) => x === "B").length, 1);
  check("C 照跑", h.executed().includes("C"), h.executed());
  eq("整张图成功", result.status, "success");
  // 轮次**接着数**,不回退 —— "这一步第几次跑"是记录里"第 N 轮"那个数字的来源。
  eq("★ A 的轮次是 2", roundOf(h.snapshots[h.snapshots.length - 1] as RunState, "A"), 2);

  // ★ 重跑那一步的提示词里必须有用户那句意见。它走的是**流程记录**那条通路
  // (不落在任何一步的产出里,见 `askOne` 里那段),所以这里连着验两件事。
  const a2 = h.calls.filter((c) => c.id === "A")[1]?.prompt ?? "";
  check("★ 重跑的 A 读得到流程记录", a2.includes("## 流程记录"), a2.slice(0, 300));
  check("★ 用户那句「哪里不对」看得见", a2.includes("第三节论据不够,重写"), a2);
  check("记录里说了那是用户在谁那儿选的", a2.includes("B"), a2);
}

{
  // **没有上游就不给"重复上一个任务"** —— "上一步"根本不存在,摆一个点了会失败的
  // 按钮比不摆更糟。这也是为什么那四条**由主进程给出**、界面照着摆,而不是界面写死。
  const h = makePorts({ pick: (_id, options) => ({ edgeId: options[0]?.id ?? "" }) });
  await runWorkflow({
    doc: docOf([node("B", CONVERSATION.id, "自己跑", { askBeforeRun: true })], []),
    prompt: "随便",
    ports: h.ports,
    signal: controller().signal,
  });
  eq("三个选项", h.choicesAsked[0]?.options.length, 3);
  check(
    "★ 没有「重复上一个任务」",
    !h.choicesAsked[0]?.options.some((o) => o.id === ASK_REPEAT_CHOICE),
    h.choicesAsked[0]?.options.map((o) => o.id),
  );
}

{
  // **没开这个开关就不问** —— 默认行为一个字没变。这一条是给"新功能别把老图弄坏"兜底的。
  const h = makePorts({});
  await runWorkflow({
    doc: askDoc(false),
    prompt: "写一篇论文",
    ports: h.ports,
    signal: controller().signal,
  });
  eq("没问", h.choicesAsked.length, 0);
  check("B 照常跑", h.executed().includes("B"), h.executed());
}

{
  // ── 续跑:应用关掉之后点那张旧卡 ──
  //
  // 挂起那套东西(落盘、重启、按 `runId + nodeId` 认回来)是**原样复用**的,所以这里
  // 验的是"复用没接歪":`awaiting` 里有它、用存档接得回来、接回来之后**不再问一遍**。
  const parkedController = controller();
  const parked = makePorts({ hold: (id) => (id === "B" ? new Promise<void>(() => {}) : undefined) });
  void runWorkflow({
    doc: askDoc(),
    prompt: "写一篇论文",
    ports: parked.ports,
    signal: parkedController.signal,
  });
  // 等到它真的停在那一问上(等待池是同步写进 snapshot 的)。
  await new Promise((r) => setTimeout(r, 20));
  const state = parked.snapshots[parked.snapshots.length - 1] as RunState;
  check("★ 停着等人时记着是哪一格", (state.awaiting ?? []).includes("B"), state.awaiting);

  // 接回来:带上"用户点了跳过"这个答案。
  const h = makePorts({});
  const resumedResult = await runWorkflow({
    doc: askDoc(),
    prompt: "写一篇论文",
    ports: h.ports,
    signal: controller().signal,
    resume: resumeFrom(state, { nodeId: "B", choice: { edgeId: ASK_SKIP_CHOICE } }),
  });
  // ⚠️ **不能断言"端口没被调用"** —— 它一定会被调用,这是设计:通知与等待必须是同一个
  // 调用(见 `RunPorts.choose`),预置答案只是让那个 promise 立刻就落地。真正该验的是
  // **它没有进等待池** —— 那才是界面上"又挂起了一次"的判据。
  check(
    "★ 接回来之后没进等待池(没有第二次挂起)",
    !h.snapshots.some((s) => (s.awaiting ?? []).includes("B")),
    h.snapshots.map((s) => s.awaiting),
  );
  eq("★ 预置的那个答案被端口收到了", h.presetSeen.length, 1);
  eq("收到的是跳过", h.presetSeen[0]?.edgeId, ASK_SKIP_CHOICE);
  eq("B 按跳过定案", outcomeOf(h, "B")?.status, "unselected");
  check("A 不重跑(它的结局在存档里)", !h.executed().includes("A"), h.executed());
  eq("收场成功", resumedResult.status, "success");

  // 把那次挂着的运行收掉,免得它一直挂在等待池里。
  parkedController.abort();
  await new Promise((r) => setTimeout(r, 20));
}

console.log("\n失败重试:只重跑失败那步 + 它的下游");

/**
 * 「第 8 步炸了」那个形状:A → B → C → D,其中 B 失败。
 *
 * 用户在一张**失败**的卡片上点「再试一次」、写一句话 —— 要的是:
 * 前面成功的步骤(A)**一步不重做**,而失败那一步**连同它的全部下游**(C、D)重跑。
 *
 * 这就是 §一 那条 `rewind` 存在的理由:失败运行落盘的 `outcomes` 是**整张图的完整
 * 结局表**,`settled` 会把它们全灌回去 —— 只摘 B 的话,C、D 留着上一轮的结局,
 * 既不会被重新派发、又拿不到新上游(静默不一致)。
 */
function chainDoc(): WorkflowDoc {
  return docOf(
    [node("A"), node("B"), node("C"), node("D")],
    [edge("A", "B"), edge("B", "C"), edge("C", "D")],
  );
}

{
  // ── 第一次:B 失败。整张图以 failed 收场 ──
  const doc = chainDoc();
  const h1 = makePorts({ fail: (id) => id === "B" });
  const first = await runWorkflow({
    doc,
    prompt: "跑一条链",
    ports: h1.ports,
    signal: controller().signal,
  });

  eq("★ 第一步失败,整张图就是 failed", first.status, "failed");
  eq("只有 A、B 跑过", h1.executed().join(","), "A,B");
  eq("B 定案成 failed", outcomeOf(h1, "B")?.status, "failed");
  // ⚠️ 失败的下游是 `skipped`(不是"缺席")—— 它得有个说得出口的答案。
  eq("C 被标成 skipped", outcomeOf(h1, "C")?.status, "skipped");
  eq("D 也是 skipped", outcomeOf(h1, "D")?.status, "skipped");

  // ── 用户点了「再试一次」,还写了一句"上次哪里不对" ──
  const h2 = makePorts({});
  const second = await runWorkflow({
    doc,
    prompt: "跑一条链",
    ports: h2.ports,
    signal: controller().signal,
    resume: {
      record: first.state.record,
      rounds: first.state.rounds,
      picks: first.state.picks,
      settled: first.state.outcomes,
      rewind: ["B"],
      note: { nodeId: "B", text: "别联网了，用本地那份" },
    },
  });

  eq("★ 重跑之后整张图不再是 failed", second.status, "success");
  // ★ 这是整件事的意义:前面成功的那一步**没重跑** —— 它的钱没白花。
  check("★ 成功的上游一步都不重做", !h2.executed().includes("A"), h2.executed());
  // ★ 而失败那一步**确实**重跑了。
  eq("★ 失败那一步重跑了", h2.executed().filter((id) => id === "B").length, 1);
  // ★ 它的下游也要重跑 —— 上游变了,下游拿到的输入就变了。
  eq("★ 下游 C 也重跑", h2.executed().filter((id) => id === "C").length, 1);
  eq("★ 再下游 D 也重跑", h2.executed().filter((id) => id === "D").length, 1);
  eq("B 这次成功了", outcomeOf(h2, "B")?.status, "success");
  eq("C 也定案了(不是留着旧的 skipped)", outcomeOf(h2, "C")?.status, "success");

  // ★ 那句话**只给被点名的节点看**。
  const bPrompt = h2.calls.find((c) => c.id === "B")?.prompt ?? "";
  check("★ 用户写的那句话进了失败那一步的提示词", bPrompt.includes("别联网了，用本地那份"), bPrompt.slice(0, 600));
  check("而且是以「本次执行的前置选择」那一段的形态", bPrompt.includes("本次执行的前置选择"), bPrompt.slice(0, 600));
  // 别的步骤看不到 —— 它是"这一步的"说明,不是全局指令。
  for (const other of ["A", "C", "D"]) {
    const p = h2.calls.find((c) => c.id === other)?.prompt ?? "";
    check(`★ 别的步骤看不到那句话(${other})`, !p.includes("别联网了"), p.slice(0, 300));
  }
}

{
  // ── 摘的必须是**整个闭包**,不只是失败那一步 ──
  //
  // 只摘 B 的话:C、D 留着一个旧的 `skipped`,`settle` 当初标的那一句还在。它们
  // 既不会被重新派发(上游 B 重新跑完之前不就绪),而等 B 跑完之后 —— 关键就在这 ——
  // `settle` 看到的是"已经有结局了"还是"没有"?答:旧结局会**挡住**新的派发。
  // 所以这里正面断言:重跑之后 C、D 的结局是**新的 success**,而不是旧的 skipped。
  const doc = chainDoc();
  const h1 = makePorts({ fail: (id) => id === "B" });
  const first = await runWorkflow({ doc, prompt: "x", ports: h1.ports, signal: controller().signal });

  const h2 = makePorts({});
  const second = await runWorkflow({
    doc,
    prompt: "x",
    ports: h2.ports,
    signal: controller().signal,
    resume: {
      record: first.state.record,
      rounds: first.state.rounds,
      picks: first.state.picks,
      settled: first.state.outcomes,
      rewind: ["B"],
    },
  });

  eq("★ C 的新结局是 success(不是旧的 skipped)", settledOf(second.state, "C")?.status, "success");
  eq("★ D 的新结局也是 success", settledOf(second.state, "D")?.status, "success");
  // 不在闭包里的 A 保留原结局(它是从 `settled` 进来的,没被抹)。
  eq("★ 闭包外的 A 保留原结局", settledOf(second.state, "A")?.status, "success");
  check("★ 而 A 没有被重新执行过", !h2.executed().includes("A"), h2.executed());
}

{
  // ── 不给 `rewind` 时,行为与今天**逐字一致**(老存档的回归)──
  //
  // 岔路口续跑那条路(见上面那几段)走的就是"只有 settled、没有 rewind"的老形状。
  // 这里正面钉一下:那种调用不该抹掉任何结局。
  const doc = chainDoc();
  const h1 = makePorts({ fail: (id) => id === "B" });
  const first = await runWorkflow({ doc, prompt: "x", ports: h1.ports, signal: controller().signal });

  const h2 = makePorts({});
  const second = await runWorkflow({
    doc,
    prompt: "x",
    ports: h2.ports,
    signal: controller().signal,
    // 老形状:record / rounds / picks / settled,没有 rewind。
    resume: {
      record: first.state.record,
      rounds: first.state.rounds,
      picks: first.state.picks,
      settled: first.state.outcomes,
    },
  });

  eq("老形状下整张图仍然 failed(失败没被抹掉)", second.status, "failed");
  eq("一个节点都没重跑", h2.executed().length, 0);
  eq("B 还是 failed", settledOf(second.state, "B")?.status, "failed");
}

console.log(`\n${total - failures}/${total} passed`);
if (failures > 0) process.exit(1);
