/**
 * Headless smoke for 自动化的两个新节点:**触发器**(`runner.kind === "trigger"`)与
 * **分支的决定权给模型**(`decider: "model"` —— 旧「决策节点」收编成了这种填法,
 * 见 `@contracts/nodeType` 的 `isModelDecider`)。
 *
 * 写法与 `scheduler-smoke` 同一条路:调度器是纯的(`RunPorts` 注入),这里塞一个假执行器。
 * 在这个基础上多验五样(见 `.trae/documents/automation-trigger-and-decision-nodes.md` 第五节):
 *
 *   - **cron**(`@contracts/cron`):解析与匹配。匹配的日期用**本地**构造形式造,而且
 *     "星期几"靠**扫描**挑出来 —— 不把"2026-09-14 是周一"这种事实写死在断言里。
 *   - **parseTriggerSpec**:四种触发方式各自的必填与报错,不认识的事件名要拦。
 *   - **describeTriggerPayload**:每一种载荷的人话版本(列表有上限,截断要说清)。
 *   - **决定权给模型的分支**:合法选项 → 只走选中的那条边,其余连同下游 `unselected`,
 *     汇合点照跑;编一个不存在的名字 → 本步失败、下游 `skipped`;交不出「出路」→ 失败;
 *     没有出边 → 失败;**只含它的环**被 `validateDag` 拒(它不能当环闸门,见
 *     `library.ts` 的 `isLoopGate`)。全程 `ports.choose` 一次都不该被调 —— 模型选
 *     边不经人。
 *   - **触发器**:`entry` 预置的被触发的那个(不再派发),其余触发器连同各自独占的
 *     下游 `unselected`,汇合点照跑;不给 `entry`(把自动化当普通流程跑)时全部
 *     `unselected`("这次不是这个触发器起的")。
 *   - **deriveTrigger**:`trigger` 字段由触发器节点反推(没有 → 字段消失;两个 → 取
 *     文档顺序第一个;有入边 / cron 坏 → 明确报错)。
 *   - **会话**:新建的自动化会话 `kind` 读回来还是 `automation`(四值归一没漏),
 *     `findAutomationByWorkflow` 按工作流找到的也是它。这一条要真库 —— 用
 *     `run-store-smoke` 的那两个 stub(`dataRoot` / `logger`)把数据根指到临时目录,
 *     跑完就删,不碰用户真正的数据。
 *   - **自动化生命周期纯件**(AUTO-05/06/07/09/10):`payloadFactsOf` 的平面事实形状;
 *     `shouldFireThisMinute` 的同分钟去重;`watcherDirsOf` 的目录归并;`AutomationFacts`
 *     的「挂载侧跟着 reload、运行侧只增不改」两条不变量;事件触发对钩子契约
 *     (`HOOK_EVENT_OF` + `createEventSubjects` + glob matcher)的复用。
 *
 * Run: scripts/automation-smoke/run.sh
 */
import { parseCron, cronMatches, type CronSpec } from "@contracts/cron";
import { HOOK_EVENT_OF, matchesAnyGlob } from "@contracts/hook";
import {
  parseTriggerSpec,
  DEFAULT_TRIGGER_DEBOUNCE_MS,
  type NodeOutcome,
  type NodeTypeManifest,
} from "@contracts/nodeType";
import { validateDag } from "@contracts/workflow";
import type { WorkflowDoc, WorkflowEdge, WorkflowNode } from "@contracts/workflow";
import type { WorkflowChoiceOption } from "@contracts/runtime";
import type { Session } from "@contracts/session";
import { createEventSubjects } from "@main/hooks/eventSubjects.js";
import { describeTriggerPayload, payloadFactsOf } from "@main/orchestration/automationPayload.js";
import {
  AutomationFacts,
  automationTriggerKey,
  shouldFireThisMinute,
  triggerSeedOf,
  watcherDirsOf,
} from "@main/orchestration/automationStatus.js";
import { deriveTrigger } from "@main/orchestration/library.js";
import { runWorkflow, type RunPorts, type RunReport, type RunState } from "@main/orchestration/scheduler.js";
import { initDb, getDb } from "@main/store/db.js";
import { ProjectRepo, SessionRepo } from "@main/store/repositories.js";

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
  params: [{ key: "instruction", kind: "longtext", label: "指令", required: true }],
};

/** 分支节点。决定权给模型的那种:跑一轮模型,按它交的「出路」挑一条出边(「出路」
 *  是固定产出,不用声明)。判据是 `isModelDecider` —— 只看清单的话它就是根分支。 */
const BRANCH: NodeTypeManifest = {
  id: "mcode.branch",
  manifestVersion: 1,
  name: "分支",
  runner: { kind: "branch" },
  capability: "read",
  params: [{ key: "instruction", kind: "longtext", label: "分支指令", required: false }],
};

/** 触发器:`parseTriggerSpec` 只看 `runner.kind` 和参数袋,清单参数为空就够了。 */
const TRIGGER: NodeTypeManifest = {
  id: "mcode.trigger",
  manifestVersion: 1,
  name: "触发器",
  runner: { kind: "trigger" },
  capability: "read",
  params: [],
};

const MANIFESTS: Record<string, NodeTypeManifest> = {
  [AGENT.id]: AGENT,
  [BRANCH.id]: BRANCH,
  [TRIGGER.id]: TRIGGER,
};

function node(
  id: string,
  type = AGENT.id,
  params: Record<string, unknown> = {},
): WorkflowNode {
  return { id, type, title: id, params: { instruction: `${id} 做什么`, ...params }, position: { x: 0, y: 0 } };
}

function edge(from: string, to: string, label?: string): WorkflowEdge {
  return { id: `e_${from}__${to}`, from, to, ...(label !== undefined ? { label } : {}) };
}

function docOf(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowDoc {
  return { id: "wf_test", name: "测试流程", nodes, edges, builtin: false, updatedAt: 0 };
}

/* ────────────────────────── harness ────────────────────────── */

interface Call {
  id: string;
  prompt: string;
}

interface Harness {
  ports: RunPorts;
  calls: Call[];
  reports: RunReport[];
  executed(): string[];
  /** 调度器问过谁(岔路口)—— 模型选的分支**不该**出现在这里(选边不经人)。 */
  choicesAsked: Array<{ nodeId: string; options: WorkflowChoiceOption[] }>;
  /** 调度器交出来的运行状态。**预置的 entry 不经过 `report`**(它没跑,也没有卡片),
   *  所以"被触发的那个成功了"只能从结算表里看。 */
  snapshots: RunState[];
}

function makePorts(opts: {
  manifests?: Record<string, NodeTypeManifest>;
  /** 执行器交回来的产出文本。默认一句平淡的 `X 的结果`。 */
  summary?: (id: string) => string;
} = {}): Harness {
  const calls: Call[] = [];
  const reports: RunReport[] = [];
  const manifests = opts.manifests ?? MANIFESTS;
  const choicesAsked: Array<{ nodeId: string; options: WorkflowChoiceOption[] }> = [];
  const snapshots: RunState[] = [];
  const ports: RunPorts = {
    async manifestOf(typeId) {
      return manifests[typeId];
    },
    contextLines() {
      return [];
    },
    async execute(target, _manifest, input) {
      calls.push({ id: target.id, prompt: input.prompt });
      return { status: "success", summary: opts.summary?.(target.id) ?? `${target.id} 的结果` };
    },
    async choose(target, options) {
      choicesAsked.push({ nodeId: target.id, options });
      return { edgeId: options[0]?.id ?? "" };
    },
    report(e) {
      reports.push(e);
    },
    snapshot(state) {
      snapshots.push(state);
    },
  };
  return { ports, calls, reports, executed: () => calls.map((c) => c.id), choicesAsked, snapshots };
}

function outcomeOf(h: Harness, id: string): NodeOutcome | undefined {
  return h.reports
    .filter((r): r is Extract<RunReport, { kind: "node.settled" }> => r.kind === "node.settled")
    .find((r) => r.node.id === id)?.outcome;
}

const controller = (): AbortController => new AbortController();

/** 2026 年 9 月里**星期 w**(0=周日)的那一天 —— 扫出来,不把日历事实写死。 */
function septemberWeekday(w: number, after = 0): Date {
  const d = new Date(2026, 8, 1 + after);
  while (d.getMonth() === 8 && d.getDay() !== w) d.setDate(d.getDate() + 1);
  return d;
}

/* ────────────────────────── 1. cron ────────────────────────── */

console.log("\ncron · 解析");

{
  const all = parseCron("* * * * *");
  check("`* * * * *` 解得过", all.ok);
  if (all.ok) {
    eq("分钟段是 60 个值", all.spec.minute.values.length, 60);
    check("分钟段是「随便」(参与日/星期的或运算判据)", all.spec.minute.any);
  }

  const range = parseCron("0-30 * * * *");
  check("`0-30` 解得过", range.ok);
  if (range.ok) {
    check("区间含两端", range.spec.minute.values.includes(0) && range.spec.minute.values.includes(30));
    check("区间不含 45", !range.spec.minute.values.includes(45));
  }

  const list = parseCron("0,15,30,45 * * * *");
  check("`0,15,30,45` 是 4 个值", list.ok && list.spec.minute.values.length === 4);

  const step = parseCron("*/15 * * * *");
  check("`*/15` 也是 0,15,30,45", step.ok && step.spec.minute.values.join(",") === "0,15,30,45");

  const ranged = parseCron("9-15/2 * * * *");
  check("`9-15/2` 是 9,11,13,15", ranged.ok && ranged.spec.minute.values.join(",") === "9,11,13,15");

  const sunday7 = parseCron("0 0 1 * 7");
  check("`7` 收成周日 0", sunday7.ok && sunday7.spec.dayOfWeek.values.join(",") === "0");

  const four = parseCron("0 9 * *");
  check("4 段要报错", !four.ok && four.error.includes("5 段"), four);
  const sixty = parseCron("60 * * * *");
  check("分钟 60 越界要报错", !sixty.ok && sixty.error.includes("分钟"), sixty);
  const zero = parseCron("*/0 * * * *");
  check("步长 0 要报错", !zero.ok && zero.error.includes("正整数"), zero);
  const rev = parseCron("5-3 * * * *");
  check("倒着的区间要报错", !rev.ok && rev.error.includes("倒着"), rev);
  const nan = parseCron("a * * * *");
  check("不是数字要报错", !nan.ok && nan.error.includes("不是数字"), nan);
}

console.log("\ncron · 匹配(本地时间)");

{
  const workday9 = parseCron("0 9 * * 1-5");
  check("工作日九点解析得过", workday9.ok);
  if (workday9.ok) {
    const mon = septemberWeekday(1);
    const sun = septemberWeekday(0);
    check("周一 09:00 命中", cronMatches(workday9.spec, new Date(mon.getFullYear(), mon.getMonth(), mon.getDate(), 9, 0)));
    check("周日 09:00 不命中", !cronMatches(workday9.spec, new Date(sun.getFullYear(), sun.getMonth(), sun.getDate(), 9, 0)));
    const ten = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate(), 10, 0);
    check("周一 10:00 不命中", !cronMatches(workday9.spec, ten));
    const half = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate(), 9, 30);
    check("周一 09:30 不命中(整点才响)", !cronMatches(workday9.spec, half));
  }

  const sep1 = parseCron("0 9 1 9 *");
  check("九月一号解析得过", sep1.ok);
  if (sep1.ok) {
    check("9 月 1 日 09:00 命中", cronMatches(sep1.spec, new Date(2026, 8, 1, 9, 0)));
    check("10 月 1 日不命中(月段限了)", !cronMatches(sep1.spec, new Date(2026, 9, 1, 9, 0)));
  }

  // 日与星期都限定 = 或(见 `@contracts/cron` 文件头):1 号**或**周一。
  const either = parseCron("0 9 1 * 1");
  check("`0 9 1 * 1` 解析得过", either.ok);
  if (either.ok) {
    const mon = septemberWeekday(1);
    // 一个**不是 1 号**的周二(从 2 号起扫)—— 1 号本身就是命中日,拿它测"不命中"测不出东西。
    const tue = septemberWeekday(2, 1);
    check("1 号命中(哪怕是周二)", cronMatches(either.spec, new Date(2026, 8, 1, 9, 0)));
    check(
      "周一命中(哪怕是 1 号之外)",
      cronMatches(either.spec, new Date(mon.getFullYear(), mon.getMonth(), mon.getDate(), 9, 0)),
    );
    check(
      "非 1 号的周二不命中",
      !cronMatches(either.spec, new Date(tue.getFullYear(), tue.getMonth(), tue.getDate(), 9, 0)),
    );
  }
}

/* ────────────────────────── 2. parseTriggerSpec ────────────────────────── */

console.log("\nparseTriggerSpec · 必填与报错");

/** 触发器参数的底座:项目与任务总在,下面逐项拿掉/改触发方式。 */
const base = { project: "D:\\proj", task: "帮我盯一下" };

{
  const notTrigger = parseTriggerSpec(AGENT, { ...base, triggerKind: "manual" });
  check("不是触发器类型的清单要拒", !notTrigger.ok && notTrigger.error.includes("不是触发器"), notTrigger);

  const noProject = parseTriggerSpec(TRIGGER, { triggerKind: "manual" });
  check("没填「在哪个项目里跑」要拒", !noProject.ok && noProject.error.includes("在哪个项目里跑"), noProject);

  const noTask = parseTriggerSpec(TRIGGER, { project: "D:\\proj" });
  check("没填「这次要做什么」要拒", !noTask.ok && noTask.error.includes("这次要做什么"), noTask);

  const noKind = parseTriggerSpec(TRIGGER, { ...base });
  check("没选「触发方式」要拒", !noKind.ok && noKind.error.includes("触发方式"), noKind);

  const manual = parseTriggerSpec(TRIGGER, { ...base, triggerKind: "manual" });
  check("手动解得过", manual.ok && manual.spec.kind === "manual", manual);
}

console.log("\nparseTriggerSpec · 四种触发方式");

{
  const noCron = parseTriggerSpec(TRIGGER, { ...base, triggerKind: "schedule" });
  check("定时没填表达式要拒", !noCron.ok && noCron.error.includes("表达式"), noCron);

  const badCron = parseTriggerSpec(TRIGGER, { ...base, triggerKind: "schedule", cron: "0 9" });
  check("表达式写坏要拒(错误来自 cron 解析器)", !badCron.ok && badCron.error.includes("5 段"), badCron);

  const okCron = parseTriggerSpec(TRIGGER, { ...base, triggerKind: "schedule", cron: "0 9 * * 1-5" });
  check("定时解得过", okCron.ok && okCron.spec.kind === "schedule");
  check(
    "解出来的就是 cron 的 spec",
    okCron.ok && okCron.spec.kind === "schedule" && (okCron.spec as { cron: CronSpec }).cron.text === "0 9 * * 1-5",
  );

  const noPaths = parseTriggerSpec(TRIGGER, { ...base, triggerKind: "file" });
  check("文件变化没写监听对象要拒", !noPaths.ok && noPaths.error.includes("监听哪些文件"), noPaths);

  const file = parseTriggerSpec(TRIGGER, { ...base, triggerKind: "file", paths: "*.md, src/*.ts" });
  check(
    "文件变化解得过,glob 是两枚",
    file.ok && file.spec.kind === "file" && file.spec.globs.join("|") === "*.md|src/*.ts",
    file,
  );
  check(
    "合并窗口默认 2000ms",
    file.ok && file.spec.kind === "file" && file.spec.debounceMs === DEFAULT_TRIGGER_DEBOUNCE_MS,
  );

  const zeroDebounce = parseTriggerSpec(TRIGGER, { ...base, triggerKind: "file", paths: "*.md", debounceMs: 0 });
  check("合并窗口 0(不合并)也收", zeroDebounce.ok && zeroDebounce.spec.kind === "file" && zeroDebounce.spec.debounceMs === 0);

  const badDebounce = parseTriggerSpec(TRIGGER, { ...base, triggerKind: "file", paths: "*.md", debounceMs: -1 });
  check("负的合并窗口要拒", !badDebounce.ok && badDebounce.error.includes("合并窗口"), badDebounce);

  const noEvents = parseTriggerSpec(TRIGGER, { ...base, triggerKind: "event" });
  check("事件没写听哪些要拒", !noEvents.ok && noEvents.error.includes("听哪些事件"), noEvents);

  const unknown = parseTriggerSpec(TRIGGER, { ...base, triggerKind: "event", events: "turn.dun" });
  check("拼错的事件名要拒(不是安静地永远不响)", !unknown.ok && unknown.error.includes("不认识的事件"), unknown);

  const uselessFilter = parseTriggerSpec(TRIGGER, {
    ...base,
    triggerKind: "event",
    events: "user.message",
    eventFilter: "Write",
  });
  check("筛不动的事件配了筛选要拒", !uselessFilter.ok && uselessFilter.error.includes("可筛"), uselessFilter);

  const filtered = parseTriggerSpec(TRIGGER, {
    ...base,
    triggerKind: "event",
    events: "turn.files",
    eventFilter: "*.md",
  });
  check(
    "可筛的事件配筛选解得过",
    filtered.ok && filtered.spec.kind === "event" && filtered.spec.matcher === "*.md" && filtered.spec.events.join(",") === "turn.files",
    filtered,
  );

  const plain = parseTriggerSpec(TRIGGER, { ...base, triggerKind: "event", events: "turn.done" });
  check("不带筛选也解得过(matcher 空)", plain.ok && plain.spec.kind === "event" && plain.spec.matcher === "");
}

/* ────────────────────────── 3. describeTriggerPayload ────────────────────────── */

console.log("\ndescribeTriggerPayload · 载荷的人话版本");

{
  eq("手动", describeTriggerPayload({ kind: "manual" }), "手动运行了一次。");

  const at = new Date(2026, 8, 16, 9, 0).getTime();
  const p = (n: number): string => String(n).padStart(2, "0");
  const d = new Date(at);
  const expectedAt = `到点了:${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}。`;
  eq("定时(本地时间,不是 UTC)", describeTriggerPayload({ kind: "schedule", at }), expectedAt);

  eq("文件(空的)", describeTriggerPayload({ kind: "file", files: [] }), "监听的文件有变化。");
  const churn = Array.from({ length: 22 }, (_, i) => `f${i}.md`);
  const capped = describeTriggerPayload({ kind: "file", files: churn });
  check("文件(截到 20 项)", capped.split("\n").length === 22, capped);
  check("截断有交代(还剩 2 个)", capped.includes("还有 2 个没列出来"), capped);
  check("第 21 个不出现", !capped.includes("f20"), capped);

  eq(
    "事件(带工具名与主语)",
    describeTriggerPayload({ kind: "event", event: "tool.use", toolName: "Write", subjects: ["a.md", "b.md"] }),
    "发生了「tool.use」,工具:Write,涉及:a.md、b.md。",
  );
  eq("事件(什么都不带)", describeTriggerPayload({ kind: "event", event: "turn.done" }), "发生了「turn.done」。");
  const many = describeTriggerPayload({ kind: "event", event: "turn.files", subjects: churn });
  check("事件的主语也截断", many.includes("…(还有 2 项)"), many);
}

/* ────────────────────────── 4. 决定权给模型的分支 ────────────────────────── */

console.log("\n模型选的分支 · 自己挑路(不经用户)");

/** 分支(决定权给模型)→(查文献、算数据)→ 汇合。出路 = 出边的 label。 */
function decideDoc(): WorkflowDoc {
  return docOf(
    [node("D", BRANCH.id, { decider: "model" }), node("L"), node("R"), node("M")],
    [edge("D", "L", "查文献"), edge("D", "R", "算数据"), edge("L", "M"), edge("R", "M")],
  );
}

{
  const h = makePorts({
    summary: (id) => (id === "D" ? '{"出路":"算数据"}' : `${id} 的结果`),
  });
  const result = await runWorkflow({ doc: decideDoc(), prompt: "跑", ports: h.ports, signal: controller().signal });

  eq("全图收在 success", result.status, "success");
  eq("被选的边、汇合点跑了,决策那步也跑了", h.executed().sort().join(","), "D,M,R");
  eq("没选的那条没跑", h.executed().includes("L"), false);
  eq("没走的那条是 unselected", outcomeOf(h, "L")?.status, "unselected");
  eq("汇合点照跑(忽略 unselected 来路)", outcomeOf(h, "M")?.status, "success");
  eq("「出路」写进了产出(下游可引用)", outcomeOf(h, "D")?.outputs?.["出路"], "算数据");
  eq("模型选边全程没问过用户", h.choicesAsked.length, 0);
  const dCall = h.calls.find((c) => c.id === "D");
  check("提示词里要它交「出路」", dCall !== undefined && dCall.prompt.includes("出路"));
  check("提示词里列了全部选项", dCall !== undefined && dCall.prompt.includes("查文献") && dCall.prompt.includes("算数据"));
}

console.log("\n模型选的分支 · 按目标标题匹配(去空白、大小写不敏感)");

{
  const h = makePorts({ summary: (id) => (id === "D" ? '{"出路":" y "}' : `${id} 的结果`) });
  const doc = docOf(
    [node("D", BRANCH.id, { decider: "model" }), node("X"), node("Y"), node("M")],
    [edge("D", "X"), edge("D", "Y"), edge("X", "M"), edge("Y", "M")],
  );
  await runWorkflow({ doc, prompt: "跑", ports: h.ports, signal: controller().signal });
  eq("边上没写 label 就拿目标标题比", h.executed().sort().join(","), "D,M,Y");
  eq("带空格的小写也对得上", outcomeOf(h, "D")?.outputs?.["出路"], "Y");
}

console.log("\n模型选的分支 · 编了一个不存在的名字");

{
  const h = makePorts({ summary: (id) => (id === "D" ? '{"出路":"不存在"}' : `${id} 的结果`) });
  const result = await runWorkflow({ doc: decideDoc(), prompt: "跑", ports: h.ports, signal: controller().signal });

  eq("决策这一步失败", outcomeOf(h, "D")?.status, "failed");
  const err = outcomeOf(h, "D")?.error ?? "";
  check("错误说清它交了什么、可选的是哪些", err.includes("没有走成任何一条路") && err.includes("查文献") && err.includes("算数据"), err);
  eq("下游整片 skipped", [outcomeOf(h, "L")?.status, outcomeOf(h, "R")?.status, outcomeOf(h, "M")?.status].join(","), "skipped,skipped,skipped");
  eq("全图收在 failed", result.status, "failed");
}

console.log("\n模型选的分支 · 交不出「出路」");

{
  const notJson = makePorts({ summary: (id) => (id === "D" ? "我觉得应该继续查重环节" : `${id} 的结果`) });
  await runWorkflow({ doc: decideDoc(), prompt: "跑", ports: notJson.ports, signal: controller().signal });
  check(
    "自由发挥的一段话要失败,错误里点名「出路」",
    outcomeOf(notJson, "D")?.status === "failed" && (outcomeOf(notJson, "D")?.error ?? "").includes("出路"),
    outcomeOf(notJson, "D")?.error,
  );

  const missingKey = makePorts({ summary: (id) => (id === "D" ? '{"标题":"x"}' : `${id} 的结果`) });
  await runWorkflow({ doc: decideDoc(), prompt: "跑", ports: missingKey.ports, signal: controller().signal });
  check(
    "交了个对象但没有「出路」也要失败",
    outcomeOf(missingKey, "D")?.status === "failed" && (outcomeOf(missingKey, "D")?.error ?? "").includes("出路"),
    outcomeOf(missingKey, "D")?.error,
  );
  eq("两种都拦住了下游", outcomeOf(missingKey, "M")?.status, "skipped");
}

console.log("\n模型选的分支 · 没有出边");

{
  const h = makePorts({ summary: (id) => (id === "D" ? '{"出路":"哪都不去"}' : `${id} 的结果`) });
  const doc = docOf([node("D", BRANCH.id, { decider: "model" })], []);
  await runWorkflow({ doc, prompt: "跑", ports: h.ports, signal: controller().signal });
  const err = outcomeOf(h, "D")?.error ?? "";
  check(
    "一根出路都没有要失败,并告诉用户怎么修",
    outcomeOf(h, "D")?.status === "failed" && err.includes("拉几根线"),
    err,
  );
}

console.log("\n模型选的分支 · 不是环的闸门");

{
  // 库里存盘时的判据(见 `library.ts` 的 `isLoopGate`):只有"决定权给用户"的分支
  // 能当闸门。模型选的分支自己判完自己转,没有人拦得住 —— 它当闸门的环在这里就该
  // 被拒,而不是跑起来停不下来。判据照库里那行原样搬过来,钉住"排除的是模型选"。
  const isGate = (doc: WorkflowDoc) => (id: string): boolean => {
    const gate = doc.nodes.find((n) => n.id === id);
    return gate !== undefined && gate.type === BRANCH.id && gate.params["decider"] !== "model";
  };
  const modelLoop = docOf(
    [node("D1", BRANCH.id, { decider: "model" }), node("D2", BRANCH.id, { decider: "model" })],
    [edge("D1", "D2"), edge("D2", "D1")],
  );
  const gate = validateDag(modelLoop.nodes, modelLoop.edges, { isLoopGate: isGate(modelLoop) });
  check("只含模型选分支的环被拒", !gate.ok && gate.error.includes("环"), gate);

  // 同一张图,决定权还给用户:它**是**合法的环闸门,要放行。
  const userLoop = docOf(
    [node("U1", BRANCH.id), node("U2", BRANCH.id)],
    [edge("U1", "U2"), edge("U2", "U1")],
  );
  const okGate = validateDag(userLoop.nodes, userLoop.edges, { isLoopGate: isGate(userLoop) });
  check("用户选的分支当闸门的环放行", okGate.ok, okGate);
}

/* ────────────────────────── 5. 触发器 ────────────────────────── */

console.log("\n触发器 · entry 预置,其余 unselected");

/** 两个触发器各拖一条支路,汇到同一个主代理。 */
function triggerDoc(): WorkflowDoc {
  return docOf(
    [node("T1", TRIGGER.id), node("T2", TRIGGER.id), node("A"), node("B"), node("M")],
    [edge("T1", "A"), edge("T2", "B"), edge("A", "M"), edge("B", "M")],
  );
}

{
  const h = makePorts();
  const result = await runWorkflow({
    doc: triggerDoc(),
    prompt: "跑",
    ports: h.ports,
    signal: controller().signal,
    entry: { nodeId: "T1", summary: "有文件变了:a.md" },
  });

  eq("全图收在 success", result.status, "success");
  eq("两个触发器都没被派发", h.executed().join(","), "A,M");
  // **预置不经过 `report`**(它没跑,也没有卡片),所以"被触发的那个成功了"在结算表里:
  const settled = Object.fromEntries(h.snapshots[h.snapshots.length - 1]?.outcomes ?? []);
  eq("被触发的那个预置成功", settled["T1"]?.status, "success");
  eq("载荷文本就是它的产出摘要", settled["T1"]?.summary, "有文件变了:a.md");
  eq("另一个触发器这次压根没发生", outcomeOf(h, "T2")?.status, "unselected");
  eq("它独占的支路跟着作废", outcomeOf(h, "B")?.status, "unselected");
  eq("汇合点照跑", outcomeOf(h, "M")?.status, "success");
  eq("预置不编产出(载荷不是变量)", settled["T1"]?.outputs, undefined);
}

console.log("\n触发器 · 不给 entry(把自动化当普通流程跑)");

{
  const h = makePorts();
  await runWorkflow({ doc: triggerDoc(), prompt: "跑", ports: h.ports, signal: controller().signal });

  check(
    "两个触发器都标成「这次不是这个触发器起的」",
    outcomeOf(h, "T1")?.status === "unselected" &&
      outcomeOf(h, "T2")?.status === "unselected" &&
      (outcomeOf(h, "T1")?.error ?? "").includes("这次不是这个触发器起的"),
    [outcomeOf(h, "T1"), outcomeOf(h, "T2")],
  );
  eq("下游整片跟着作废", [outcomeOf(h, "A")?.status, outcomeOf(h, "B")?.status, outcomeOf(h, "M")?.status].join(","), "unselected,unselected,unselected");
  eq("执行器一次都没被调", h.executed().length, 0);
}

/* ────────────────────────── 6. deriveTrigger ────────────────────────── */

console.log("\nderiveTrigger · trigger 字段由触发器节点反推");

{
  const types = new Map(Object.entries(MANIFESTS));

  const plain = deriveTrigger(docOf([node("A")], []), types);
  check("没有触发器、本来也没有字段 → 原样", plain.ok && !("trigger" in plain.doc), plain);

  const cleared = deriveTrigger({ ...docOf([node("A")], []), trigger: "schedule" }, types);
  check("触发器删掉了 → 字段跟着消失", cleared.ok && !("trigger" in cleared.doc), cleared);

  const scheduled = deriveTrigger(
    docOf(
      [
        node("T1", TRIGGER.id, { triggerKind: "schedule", cron: "0 9 * * 1-5", project: "D:\\proj", task: "盯一下" }),
        node("T2", TRIGGER.id, { triggerKind: "file", paths: "*.md", project: "D:\\proj", task: "盯一下" }),
        node("A"),
      ],
      [edge("T1", "A"), edge("T2", "A")],
    ),
    types,
  );
  check("两个触发器取文档顺序第一个", scheduled.ok && scheduled.doc.trigger === "schedule", scheduled);

  const filed = deriveTrigger(
    docOf([node("T", TRIGGER.id, { triggerKind: "file", paths: "*.md", project: "D:\\proj", task: "盯一下" })], []),
    types,
  );
  check("文件触发反推出 file", filed.ok && filed.doc.trigger === "file", filed);

  const upstreamed = deriveTrigger(
    docOf([node("A"), node("T", TRIGGER.id, { triggerKind: "manual", project: "D:\\proj", task: "盯一下" })], [edge("A", "T")]),
    types,
  );
  check("触发器有上游要拒", !upstreamed.ok && upstreamed.error.includes("上游"), upstreamed);

  const badCron = deriveTrigger(
    docOf([node("T", TRIGGER.id, { triggerKind: "schedule", cron: "0 9", project: "D:\\proj", task: "盯一下" })], []),
    types,
  );
  check("cron 写坏要拒,错误指到那个节点", !badCron.ok && badCron.error.includes("触发器"), badCron);
}

/* ────────────────────────── 7. 会话:kind 读回 ────────────────────────── */

console.log("\n会话 · 自动化会话的 kind 归一");

{
  await initDb();
  const now = Date.now();
  ProjectRepo.create({
    id: "p_smoke",
    name: "冒烟",
    path: "D:\\proj",
    archived: false,
    group: null,
    sortOrder: 0,
    pinnedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  const sessionOf = (id: string, kind: Session["kind"]): Session => ({
    id,
    projectId: "p_smoke",
    providerId: "claude-sdk",
    claudeSessionId: null,
    kind,
    parentSessionId: null,
    title: "冒烟会话",
    status: "idle",
    model: "",
    effort: "default",
    permissionMode: "default",
    // 两条**同一个** workflowId:找的时候只该摸到 automation 那条(见 `findAutomationByWorkflow`)。
    workflowId: "wf_auto",
    customModelId: null,
    envMode: "local",
    worktreePath: null,
    archived: false,
    pinnedAt: null,
    contextSnapshot: null,
    todos: null,
    subagents: null,
    planDraft: null,
    turnFiles: null,
    usageHistory: null,
    bookmarks: null,
    subagentTranscripts: null,
    createdAt: now,
    updatedAt: now,
  });
  SessionRepo.create(sessionOf("s_auto", "automation"));
  SessionRepo.create(sessionOf("s_chat", "chat"));

  eq("automation 存进去读回来还是 automation", SessionRepo.get("s_auto")?.kind, "automation");
  eq(
    "findAutomationByWorkflow 找到的是自动化那条",
    SessionRepo.findAutomationByWorkflow("wf_auto")?.id,
    "s_auto",
  );
  getDb().run("UPDATE sessions SET kind = 'weird' WHERE id = 's_chat'");
  eq("不认识的 kind 归一成 chat(不进左栏的秘密)", SessionRepo.get("s_chat")?.kind, "chat");
}

/* ────────────────────────── 8. 载荷的结构化事实(AUTO-10) ────────────────────────── */

console.log("\npayloadFactsOf · 载荷的平面事实形状(给变量系统 VAR-06 消费)");

{
  eq("手动 = 只有 kind", JSON.stringify(payloadFactsOf({ kind: "manual" })), JSON.stringify({ kind: "manual" }));
  eq("定时带 at", JSON.stringify(payloadFactsOf({ kind: "schedule", at: 1234 })), JSON.stringify({ kind: "schedule", at: 1234 }));

  const fileFacts = payloadFactsOf({ kind: "file", files: ["D:\\proj\\a.md"] });
  check("文件带 files", fileFacts.kind === "file" && fileFacts.files?.join() === "D:\\proj\\a.md", fileFacts);

  const eventFacts = payloadFactsOf({ kind: "event", event: "tool.use", toolName: "Write", subjects: ["Write"] });
  check(
    "事件带 event/toolName/subjects",
    eventFacts.event === "tool.use" && eventFacts.toolName === "Write" && eventFacts.subjects?.join() === "Write",
    eventFacts,
  );
  const bareEvent = payloadFactsOf({ kind: "event", event: "turn.done" });
  check("可选字段没有就不出现", bareEvent.toolName === undefined && bareEvent.subjects === undefined, bareEvent);

  // **拷贝语义**:消费方改事实数组,不许动到执行器手里的原载荷。
  const originalFiles = ["x.md"];
  const copy = payloadFactsOf({ kind: "file", files: originalFiles });
  (copy.files as string[]).push("y.md");
  eq("facts 是拷贝,原载荷不受影响", originalFiles.length, 1);
}

/* ────────────────────────── 9. 定时:同一分钟只跑一次(AUTO-05) ────────────────────────── */

console.log("\nshouldFireThisMinute · 30 秒 ticker 的同分钟去重");

{
  check("这一分钟第一次看:跑", shouldFireThisMinute(undefined, 1000));
  check("同一分钟第二次看(30 秒后那一跳):不跑", !shouldFireThisMinute(1000, 1000));
  check("下一分钟:跑", shouldFireThisMinute(1000, 1001));
  check("不是刚跑过的那一分钟:跑(去重只对「刚跑过」生效)", shouldFireThisMinute(1002, 1001));
}

/* ────────────────────────── 10. 文件:监听目录归并(AUTO-06) ────────────────────────── */

console.log("\nwatcherDirsOf · 每个目录一个 watcher");

{
  const triggers = [
    { spec: { kind: "file" }, cwd: "D:\\proj" },
    { spec: { kind: "file" }, cwd: "D:\\proj" }, // 一条自动化两个文件触发器,同一目录
    { spec: { kind: "file" }, cwd: "D:\\other" }, // 另一条自动化盯另一个目录
    { spec: { kind: "schedule" }, cwd: "D:\\proj" }, // 定时不开 watcher
    { spec: { kind: "event" }, cwd: "D:\\proj" }, // 事件也不开
  ];
  eq("文件触发器的目录去重,其余不开", watcherDirsOf(triggers).join("|"), "D:\\proj|D:\\other");
  eq("没有文件触发器 = 不开任何一个", watcherDirsOf([{ spec: { kind: "manual" }, cwd: "D:\\proj" }]).join("|"), "");
}

/* ────────────────────────── 11. 事实状态(AUTO-09) ────────────────────────── */

console.log("\nAutomationFacts · 挂载侧跟着 reload、运行侧只增不改");

{
  const facts = new AutomationFacts();
  const armed: Parameters<typeof facts.recordSetup>[0] = {
    workflowId: "wf",
    nodeId: "T1",
    title: "盯文件",
    kind: "file",
  };
  const broken: Parameters<typeof facts.recordSetup>[0] = {
    workflowId: "wf",
    nodeId: "T2",
    title: "到点跑",
    kind: "schedule",
  };

  facts.recordSetup(armed, true);
  facts.recordSetup(broken, false, "「在哪个项目里跑」没填 —— 触发器要知道它该在哪个目录里工作");

  const listed = facts.ofWorkflow("wf");
  eq("挂上的、挂不上的都在(挂不上不是消失)", listed.length, 2);
  const t1 = listed.find((f) => f.nodeId === "T1");
  const t2 = listed.find((f) => f.nodeId === "T2");
  eq("挂上的 armed", t1?.armed, true);
  eq("挂不上的带着原因", t2?.detail, "「在哪个项目里跑」没填 —— 触发器要知道它该在哪个目录里工作");

  // 运行侧:fired 记 lastFireAt;blocked 记 lastError。**blocked 不许把 armed 抹掉** ——
  // 重入跳过是「这次没跑」,不是「这条触发器坏了」。
  facts.recordFired(armed, 500);
  facts.recordBlocked(
    triggerSeedOf({ ...armed, spec: { kind: "file" } }),
    "上一次还在跑,这一次触发已跳过",
    600,
  );
  const afterFire = facts.ofWorkflow("wf").find((f) => f.nodeId === "T1");
  eq("lastFireAt 记了", afterFire?.lastFireAt, 500);
  eq("lastError 记了", afterFire?.lastError, "上一次还在跑,这一次触发已跳过");
  eq("blocked 不改 armed", afterFire?.armed, true);

  // watcher 失效 → 重试成功:armed 翻过去再翻回来,**运行史不动**。
  facts.recordSetup(triggerSeedOf({ ...armed, spec: { kind: "file" } }), false, "目录监听失效:ENOENT");
  const down = facts.ofWorkflow("wf").find((f) => f.nodeId === "T1");
  eq("失效后 armed 翻 false", down?.armed, false);
  eq("失效原因可读", down?.detail, "目录监听失效:ENOENT");
  eq("失效不抹运行史", down?.lastFireAt, 500);
  facts.recordSetup(armed, true);
  const up = facts.ofWorkflow("wf").find((f) => f.nodeId === "T1");
  eq("重新挂上后 armed 回 true", up?.armed, true);
  eq("重新挂上后 detail 清掉", up?.detail, undefined);
  eq("运行史还在", up?.lastFireAt, 500);

  // retain:触发器从图上删掉,事实跟着走;同工作流里别的触发器不受牵连。
  facts.retainWorkflow("wf", new Set([automationTriggerKey(broken)]));
  eq("删掉的触发器事实清了", facts.ofWorkflow("wf").map((f) => f.nodeId).join(","), "T2");

  // 工作流之间隔离;界面顺序按标题稳定排序。
  facts.recordSetup({ workflowId: "wf2", nodeId: "A", title: "zzz", kind: "manual" }, true);
  facts.recordSetup({ workflowId: "wf2", nodeId: "B", title: "aaa", kind: "manual" }, true);
  eq("ofWorkflow 只看自己的工作流", facts.ofWorkflow("wf2").length, 2);
  eq("按标题排序", facts.ofWorkflow("wf2").map((f) => f.nodeId).join(","), "B,A");
  eq("all 是全部", facts.all().length, 3);

  // 守望起跑那条 **ad-hoc** 路径:没有经过 buildTriggers 的登记,fired 本身就是登记。
  facts.recordFired({ workflowId: "wf_watch", nodeId: "T", title: "守望入口", kind: "manual" }, 700);
  const watch = facts.ofWorkflow("wf_watch")[0];
  check("ad-hoc 起跑即登记(armed + lastFire)", watch?.armed === true && watch?.lastFireAt === 700, watch);

  // 没登记过的触发器被拦截(项目没了),也要记下原因 —— 界面要能回答「它怎么没跑」。
  facts.recordBlocked({ workflowId: "wf_x", nodeId: "T", title: "x", kind: "manual" }, "项目不在了", 800);
  eq("未登记的 blocked 也落表", facts.ofWorkflow("wf_x")[0]?.lastError, "项目不在了");

  facts.clear();
  eq("clear 清干净(dispose 用)", facts.all().length, 0);
}

/* ────────────────────────── 12. 事件触发复用钩子契约(AUTO-07) ────────────────────────── */

console.log("\n事件触发 · HOOK_EVENT_OF + 事件主语与钩子同源");

{
  const subjects = createEventSubjects();

  const use = subjects.of(
    { type: "tool.use", sessionId: "s", toolCallId: "tc1", toolName: "Write", input: {}, requiresApproval: false },
    "D:\\proj",
  );
  eq("tool.use 映射成钩子事件名", HOOK_EVENT_OF["tool.use"], "tool.use");
  eq("tool.use 的主语是工具名", use.toolName, "Write");
  check("matcher 用钩子同一份 glob 匹配工具名", matchesAnyGlob("Wri*, Edit", [use.toolName ?? ""]));

  const result = subjects.of(
    { type: "tool.result", sessionId: "s", toolCallId: "tc1", isError: false, content: "" },
    "D:\\proj",
  );
  eq("tool.result 回查到工具名(靠刚才那次 tool.use,与钩子共用这份状态)", result.toolName, "Write");

  const files = subjects.of(
    {
      type: "turn.files",
      sessionId: "s",
      files: [{ filePath: "D:\\proj\\notes\\a.md", kind: "modified", adds: 1, dels: 0, before: "" }],
    },
    "D:\\proj",
  );
  eq("turn.files 映射成钩子事件名", HOOK_EVENT_OF["turn.files"], "turn.files");
  check("主语含相对路径(相对项目目录)", (files.subjects ?? []).includes("notes/a.md"));
  check("路径 matcher 用钩子同一份 glob 命中", matchesAnyGlob("*.md", files.subjects ?? []));

  // 触发器**没有自己的一套事件表**:太吵的事件与钩子一样,被故意挡在外面。
  eq("text.delta 故意不暴露(与钩子同一张表)", HOOK_EVENT_OF["text.delta"], null);
}

/* ────────────────────────── 收尾 ────────────────────────── */

console.log(`\nautomation-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exit(1);
