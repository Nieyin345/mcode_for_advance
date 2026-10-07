/**
 * `scheduler-smoke` 系列的**共享夹具与测试台**。
 *
 * ⚠️ 这个目录名以 `-smoke` 结尾,所以 `run-smokes.mjs` 会把它当一套跑 —— 但它**没有**
 * `run.sh`,靠 `main.ts` 触发。它从前是 `main.ts` 的前 438 行:**3566 行单文件**,改一处
 * 要等整套跑完、失败信息也难定位(项目自己的 A5 待办)。现在按主题拆成三套:
 *
 *   - `scheduler-smoke`      核心调度:并发/依赖/失败传播/取消/前置检查/提示词/边界
 *   - `scheduler-data-smoke` 数据:上下文继承/`{{...}}` 变量/产出约束
 *   - `scheduler-flow-smoke` 控制流:岔路口/回头/流程记录/续跑/运行前先问/自动重试
 *
 * 三套各自 import 这一份台子 —— 与 `maint-m28-smoke` import `node-session-smoke/stubs`
 * 同一套做法。**判据是各套断言之和与拆分前一致**(534),不是"看起来拆开了"。
 */
import { ContextLine } from "@main/orchestration/contextInherit.js";
import { BranchChoice, RunPorts, RunReport, RunState } from "@main/orchestration/scheduler.js";
import { WorkflowPlan } from "@main/orchestration/schedulerPrompt.js";
import { resolve } from "node:path";
import { NodeContextKind, NodeOutcome, NodeTypeManifest } from "@contracts/nodeType";
import { WorkflowChoiceOption } from "@contracts/runtime";
import { WorkflowDoc, WorkflowEdge, WorkflowNode } from "@contracts/workflow";

export let failures = 0;
export let total = 0;

export function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

export function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}
/** 三套各自的收尾:打印 `N/N passed`,失败则置退出码。 */
export function summary(): void {
  console.log(`\n${total - failures}/${total} passed`);
  if (failures > 0) process.exit(1);
}


/* ────────────────────────── fixtures ────────────────────────── */

export const AGENT: NodeTypeManifest = {
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
    // `NODE_CONTEXT_PARAM_KEY`。kind 退役后候选是**大类 + 模版类目**(见 `contextOptions`),
    // 这里照那个形状摆:两个大类 + 一个模版类目。
    {
      key: "context",
      kind: "select",
      multiple: true,
      label: "资料",
      options: [
        { value: "docs", label: "文档" },
        { value: "templates", label: "模版库" },
        { value: "latex", label: "latex" },
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
export const SHELL: NodeTypeManifest = {
  id: "x.shell",
  manifestVersion: 1,
  name: "跑脚本",
  runner: { kind: "command", entry: "run.sh" },
  capability: "exec",
  params: [],
};

/** 提示词类型,但**没把指令标成必填** —— 校验过得了,拼提示词时才暴露。 */
export const LOOSE: NodeTypeManifest = {
  id: "x.loose",
  manifestVersion: 1,
  name: "没指令的提示词节点",
  runner: { kind: "prompt" },
  capability: "read",
  params: [],
};

/** 岔路口:不跑东西,把决定权交给用户(见 `@contracts/nodeType` 的 `branch`)。 */
export const BRANCH: NodeTypeManifest = {
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
export const CONVERSATION: NodeTypeManifest = {
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

/**
 * 声明了**自动重试**的类型(见 `@contracts/nodeType` 的 `NodeRetrySchema`)。
 *
 * `backoffMs: 0` —— 冒烟要钉的是"重试了几趟",不是"等了多久";退避那条曲线由下面
 * `retryDelayMs` 的纯函数断言单独量。真等上五秒只会让这套跑得更慢,量不到任何东西。
 */
export const RETRY_AGENT: NodeTypeManifest = {
  ...AGENT,
  id: "mcode.retry-agent",
  name: "会重试的子 agent",
  retry: { maxAttempts: 3, backoffMs: 0 },
};

export const MANIFESTS: Record<string, NodeTypeManifest> = {
  [AGENT.id]: AGENT,
  [RETRY_AGENT.id]: RETRY_AGENT,
  [SHELL.id]: SHELL,
  [LOOSE.id]: LOOSE,
  [BRANCH.id]: BRANCH,
  [CONVERSATION.id]: CONVERSATION,
};

export function node(
  id: string,
  type = AGENT.id,
  instruction = `${id} 做什么`,
  extra: Record<string, unknown> = {},
): WorkflowNode {
  return { id, type, title: id, params: { instruction, ...extra }, position: { x: 0, y: 0 } };
}

/** 一个**分支**节点。它没有参数 —— 出路全在边上(`edge` 的 `label` / `note`)。 */
export function branchNode(id: string, title = id): WorkflowNode {
  return { id, type: BRANCH.id, title, params: {}, position: { x: 0, y: 0 } };
}

export function edge(from: string, to: string, extra: { label?: string; note?: string } = {}): WorkflowEdge {
  return { id: `e_${from}__${to}`, from, to, ...extra };
}

export function docOf(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowDoc {
  return { id: "wf_test", name: "测试流程", nodes, edges, builtin: false, updatedAt: 0 };
}

/**
 * 提示词拼装那几个用例用的迷你流程:**规划 →(查文献、算数据)→ 汇总**。
 *
 * 手写而不是 `planOf(...)` 算出来的:那几条测的是**拼装**,喂进去什么就该渲染出什么。
 * 拿被测代码的另一半去生产它的输入,等于两边一起错也看不出来。`planOf` 自己有单测。
 */
export const PLAN: WorkflowPlan = [
  [{ id: "A", title: "规划", isLast: false }],
  [
    { id: "B", title: "查文献", isLast: false },
    { id: "C", title: "算数据", isLast: false },
  ],
  [{ id: "D", title: "汇总", isLast: true }],
];

/* ────────────────────────── harness ────────────────────────── */

export interface Call {
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
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
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

export interface Harness {
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

export function makePorts(opts: {
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
  /**
   * **这一趟尝试交回什么** —— `attempt` 从 1 起(重试那几条要的正是"第一趟炸、
   * 第二趟成")。返回 `undefined` = 走下面 `fail` / 默认那条老路。
   */
  outcome?: (nodeId: string, attempt: number) => NodeOutcome | undefined;
} = {}): Harness {
  /** 每个节点被派发过几趟(含重试)。`calls` 也数得出来,但 execute 里要当场用。 */
  const attempts = new Map<string, number>();
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
    async manifestDirOf() {
      return undefined;
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
      const attempt = (attempts.get(target.id) ?? 0) + 1;
      attempts.set(target.id, attempt);
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
      // 用例点名的结局优先(见 `outcome`)——重试那几条靠它区分第几趟。
      const scripted = opts.outcome?.(target.id, attempt);
      if (scripted !== undefined) return scripted;
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

export function outcomeOf(h: Harness, id: string): NodeOutcome | undefined {
  return h.reports
    .filter((r): r is Extract<RunReport, { kind: "node.settled" }> => r.kind === "node.settled")
    .find((r) => r.node.id === id)?.outcome;
}

export const controller = (): AbortController => new AbortController();
