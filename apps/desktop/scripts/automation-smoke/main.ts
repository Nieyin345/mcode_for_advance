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
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseCron, cronMatches, type CronSpec } from "@contracts/cron";
import { HOOK_EVENT_OF, eventItemFactKeysOf, eventItemFactsOf, matchesAnyGlob, type HookEvent } from "@contracts/hook";
import { latestFailureOf } from "@contracts/ipc";
import {
  parseTriggerSpec,
  DEFAULT_TRIGGER_DEBOUNCE_MS,
  NODE_TRIGGER_CRON_PARAM_KEY,
  NODE_TRIGGER_DEBOUNCE_PARAM_KEY,
  NODE_TRIGGER_ENABLED_PARAM_KEY,
  NODE_TRIGGER_EVENTS_PARAM_KEY,
  NODE_TRIGGER_KIND_PARAM_KEY,
  NODE_TRIGGER_PATHS_PARAM_KEY,
  NODE_TRIGGER_PROJECT_PARAM_KEY,
  TRIGGER_KINDS,
  triggerEnabledOf,
  triggerFactKeysOf,
  type NodeOutcome,
  type NodeTypeManifest,
  type TriggerKind,
  type TriggerSpec,
} from "@contracts/nodeType";
import { validateDag } from "@contracts/workflow";
import type { WorkflowDoc, WorkflowEdge, WorkflowNode } from "@contracts/workflow";
import type { WorkflowChoiceOption, RuntimeEvent } from "@contracts/runtime";
import type { Session } from "@contracts/session";
import { createEventSubjects } from "@main/hooks/eventSubjects.js";
import { describeTriggerPayload, mergeEventPayload, payloadFactsOf } from "@main/orchestration/automationPayload.js";
import {
  AutomationFacts,
  automationTriggerKey,
  shouldFireThisMinute,
  triggerSeedOf,
  triggerSpecKeyOf,
  watcherDirsOf,
} from "@main/orchestration/automationStatus.js";
import { deriveTrigger, saveWorkflow } from "@main/orchestration/library.js";
import type { AutomationFactsSeed } from "@main/orchestration/automationStatus.js";
import { builtinTriggerManifest } from "@main/orchestration/nodeTypes.js";
import {
  AUTO_CONVERT_WORKFLOW_ID,
  AUTO_DOWNLOAD_WORKFLOW_ID,
  WATCH_WORKFLOW_ID,
  getBuiltinWorkflow,
} from "@main/orchestration/builtins.js";
import { runWorkflow, type RunPorts, type RunReport, type RunState } from "@main/orchestration/scheduler.js";
import { initDb, getDb } from "@main/store/db.js";
import { ProjectRepo, SessionRepo, SettingRepo, WorkflowRepo } from "@main/store/repositories.js";
// ⚠️ **执行器本体**(`automationRunner.ts`)不是纯件:它真开 `fs.watch`、真起会话、
// 真读 settings 表。这一套的后半段(见第 13 节)直接 `new` 它来验「重启后同一分钟不
// 再触发」与「删掉的文件不进载荷」——那两条的实现全在实例状态里,不真跑一遍验不到。
import { automationRunner } from "@main/orchestration/automationRunner.js";
import { resetRuns, runs, runsOfNode } from "./stubs/runner.js";
import { boundSessionIds, runtimeManager } from "./stubs/runtimeManager.js";

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
    // 这些用例里没有第三方自带脚本的节点,清单目录一律缺席。
    async manifestDirOf() {
      return undefined;
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

console.log("\nparseTriggerSpec · 「事件发生时」可以不绑项目");

// ⚠️ 这一条是踩出来的。以前四种触发方式一律要求项目非空,而**内置模板预置不出项目 id**
// (项目 id 是建项目时现生成的 `uid("proj_")`,模板没法知道这台机器上有哪些项目)。
// 于是内置的「下载完自动转 Markdown」**永远挂不上** —— 用户对着一张参数填得好好的触发器等
// 它响,而没有任何地方说得出为什么。
//
// 「事件发生时」不需要工作目录:它要做的事(转录、抽图、送外部工具)都是拿绝对路径去
// 操作库里的文件。另外三种仍要 —— 定时/文件变化是**按目录算**的。
{
  const noProject = { task: "下完了就转" };
  const eventNoProject = parseTriggerSpec(TRIGGER, {
    ...noProject,
    triggerKind: "event",
    events: "library.item.downloaded",
  });
  check(
    "事件触发没绑项目解得过",
    eventNoProject.ok && eventNoProject.spec.kind === "event",
    eventNoProject,
  );
  check(
    "解出来的事件名就是它",
    eventNoProject.ok &&
      eventNoProject.spec.kind === "event" &&
      eventNoProject.spec.events.join(",") === "library.item.downloaded",
    eventNoProject,
  );

  // 另外三种**仍然要项目** —— 放宽是有边界的,不能顺手放开全部。
  const scheduleNoProject = parseTriggerSpec(TRIGGER, {
    ...noProject,
    triggerKind: "schedule",
    cron: "0 9 * * *",
  });
  check(
    "定时没绑项目仍然要拒(它按目录算)",
    !scheduleNoProject.ok && scheduleNoProject.error.includes("在哪个项目里跑"),
    scheduleNoProject,
  );
  const fileNoProject = parseTriggerSpec(TRIGGER, { ...noProject, triggerKind: "file", paths: "*.md" });
  check(
    "文件变化没绑项目仍然要拒",
    !fileNoProject.ok && fileNoProject.error.includes("在哪个项目里跑"),
    fileNoProject,
  );

  // 任务那句话仍然必填 —— 它是被触发时唯一的请求。
  const noTaskEither = parseTriggerSpec(TRIGGER, {
    triggerKind: "event",
    events: "library.item.downloaded",
  });
  check("没绑项目也没写任务 → 仍然拒", !noTaskEither.ok && noTaskEither.error.includes("这次要做什么"), noTaskEither);
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

  // 「这件事是关于哪一条」—— 资料库那两个事件带得出,而**这正是那条内置自动化
  // 赖以知道该转哪一篇的东西**(见 `AUTO_CONVERT_*` 的指令:它让模型看下面这段载荷)。
  eq(
    "事件(带条目:下载完成)",
    describeTriggerPayload({
      kind: "event",
      event: "library.item.downloaded",
      items: [{ itemId: "lib_1", itemKind: "paper", itemTitle: "注意力就是全部", pdfPath: "pdf/ab/cd.pdf" }],
    }),
    "发生了「library.item.downloaded」。\n条目:注意力就是全部(类型 paper,id=lib_1)\nPDF(库内相对路径):pdf/ab/cd.pdf",
  );
  // **合并窗口里进来的几条全都要办。** 下载是并发的,两篇同时下完就落在同一个窗口 ——
  // 只列一条的话,另一篇永远没人转,而且不报错。
  eq(
    "事件(带条目:两条一起下来)",
    describeTriggerPayload({
      kind: "event",
      event: "library.item.downloaded",
      items: [
        { itemId: "lib_1", itemKind: "paper", itemTitle: "第一篇", pdfPath: "pdf/a.pdf" },
        { itemId: "lib_2", itemKind: "paper", itemTitle: "第二篇", pdfPath: "pdf/b.pdf" },
      ],
    }),
    [
      "发生了「library.item.downloaded」。",
      "一共有 2 条,这次都要办:",
      "条目1:第一篇(类型 paper,id=lib_1)",
      "PDF(库内相对路径):pdf/a.pdf",
      "条目2:第二篇(类型 paper,id=lib_2)",
      "PDF(库内相对路径):pdf/b.pdf",
    ].join("\n"),
  );
  // 导入那一下**文件还没下来**,所以没有 `pdfPath` 这一行 —— 有的话就是在骗模型。
  eq(
    "事件(带条目:只有导入)",
    describeTriggerPayload({
      kind: "event",
      event: "library.item.imported",
      items: [{ itemId: "lib_2", itemKind: "note", itemTitle: "随手记" }],
    }),
    "发生了「library.item.imported」。\n条目:随手记(类型 note,id=lib_2)",
  );
  // 缺项不塌成 `undefined` 串进去。
  eq(
    "事件(条目缺标题)",
    describeTriggerPayload({ kind: "event", event: "library.item.imported", items: [{ itemId: "lib_3" }] }),
    "发生了「library.item.imported」。\n条目:(没给标题)(id=lib_3)",
  );
  // 空数组 = 没有条目,不许凭空多出一个空块。
  eq(
    "事件(条目是空数组:不多出空块)",
    describeTriggerPayload({ kind: "event", event: "library.item.imported", items: [] }),
    "发生了「library.item.imported」。",
  );
  // ⚠️ 反例:没有条目那种事件,**渲染结果必须和改之前一模一样** ——
  // 不带条目的路(19 个事件里的 17 个)一点都不能被这条改动碰到。
  eq(
    "事件(无条目时不多出空块)",
    describeTriggerPayload({ kind: "event", event: "tool.use", toolName: "Write", subjects: ["a.md"] }),
    "发生了「tool.use」,工具:Write,涉及:a.md。",
  );
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
    nodeId: null,
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

  // **条目那几项是拍平的**。变量系统认的是平面的 `{{trigger.<key>}}`(`expandTriggerVars`
  // 按字面查一个键),嵌一层的话用户得写 `{{trigger.item.itemId}}`,永远解不出来。
  const itemFacts = payloadFactsOf({
    kind: "event",
    event: "library.item.downloaded",
    items: [{ itemId: "lib_1", itemKind: "paper", itemTitle: "标题", pdfPath: "pdf/a.pdf" }],
  });
  eq("事件:条目那几项拍平在顶层(不是嵌一层 item)", itemFacts.itemId, "lib_1");
  check(
    "事件:四项都在顶层",
    itemFacts.itemKind === "paper" && itemFacts.itemTitle === "标题" && itemFacts.pdfPath === "pdf/a.pdf",
    itemFacts,
  );
  check("事件:没有嵌一层 item 对象", !Object.prototype.hasOwnProperty.call(itemFacts, "item"), Object.keys(itemFacts));
  // 只有一条时不报数(`itemCount` 是给"这次有好几条"用的)。
  check("事件:只有一条时不带 itemCount", itemFacts.itemCount === undefined, itemFacts);
  // 合并窗口里来了两条:单数那几项 take 第一条(数组摊成 `a、b` 对 `{{trigger.itemId}}`
  // 毫无意义),但**必须带上条数** —— 否则模型以为只有一条,少办的那篇永远没人转。
  const multiFacts = payloadFactsOf({
    kind: "event",
    event: "library.item.downloaded",
    items: [
      { itemId: "lib_1", itemTitle: "第一篇" },
      { itemId: "lib_2", itemTitle: "第二篇" },
    ],
  });
  eq("事件:多条时单数项取第一条", multiFacts.itemId, "lib_1");
  eq("事件:多条时报出条数", multiFacts.itemCount, 2);
  // 反例:不带条目的那种事件,一个 item* 键都不许凭空冒出来。
  const noItem = payloadFactsOf({ kind: "event", event: "tool.use", toolName: "Write" });
  check("事件:没条目时不多出 item* 键", !Object.keys(noItem).some((k) => k.startsWith("item")), Object.keys(noItem));
  // 空数组同样不算有条目。
  const emptyItems = payloadFactsOf({ kind: "event", event: "library.item.imported", items: [] });
  check("事件:条目是空数组也不多出 item* 键", !Object.keys(emptyItems).some((k) => k.startsWith("item")), Object.keys(emptyItems));

  // **拷贝语义**:消费方改事实数组,不许动到执行器手里的原载荷。
  const originalFiles = ["x.md"];
  const copy = payloadFactsOf({ kind: "file", files: originalFiles });
  (copy.files as string[]).push("y.md");
  eq("facts 是拷贝,原载荷不受影响", originalFiles.length, 1);
}

/* ── 8b. 「插入变量」列的那几项,这一种触发真的带得出(2026-09-19) ── */

// 界面的「触发器」那一组原来把六个字段**全列**出来,判据只有"图里挂着触发器吗"。于是
// 一个**定时**触发器,菜单里也摆着「涉及哪些对象」—— 点一下插进指令,下次到点必炸:
// `expandTriggerVars` 对取不到的 key 是硬失败(`载荷里没有它,可用的有:…`)。
// 用户点菜单的用意恰恰是"我不想记错名字",结果菜单教了一个一定错的名字。
//
// 下面的**判据不是比对着一张写死的名单**,而是拿 `payloadFactsOf` 现算一份载荷 ——
// 名单写死就只是把同一份错误抄第二遍(`TRIGGER_FIELDS` 那个形状)。真正的不变量是:
// **菜单列的每一项,这一种触发产出的载荷里都真有**。
console.log("\ntriggerFactKeysOf · 菜单列的每一项都得真的取得到");
{
  // 每种触发造一份"最全"的载荷(可选字段都带上),再看候选是不是都在里面。
  // `event` 这一份**必须连着 `item` 一起造** —— 不然下面那条"菜单列的每一项都取得到"
  // 会对着一个结构上取不到条目事实的载荷去验,而 8c 刚把 `itemId` 那几项列进了菜单。
  const richestEvent = payloadFactsOf({
    kind: "event",
    event: "library.item.downloaded",
    toolName: "Write",
    subjects: ["Write"],
    items: [{ itemId: "lib_1", itemKind: "paper", itemTitle: "标题", pdfPath: "pdf/a.pdf" }],
  });
  const richestPayload: Record<TriggerKind, Record<string, unknown>> = {
    manual: payloadFactsOf({ kind: "manual" }) as unknown as Record<string, unknown>,
    schedule: payloadFactsOf({ kind: "schedule", at: 1234 }) as unknown as Record<string, unknown>,
    file: payloadFactsOf({ kind: "file", files: ["a.md"] }) as unknown as Record<string, unknown>,
    event: richestEvent as unknown as Record<string, unknown>,
  };

  for (const kind of TRIGGER_KINDS) {
    // ⚠️ 事件那一种的候选**还取决于听的是哪个事件**(8c),所以这里得拿一个真听得见
    // 条目事实的事件来配 —— 拿 `turn.done` 配的话,菜单只会列事件自己那几项。
    const params =
      kind === "event"
        ? { [NODE_TRIGGER_KIND_PARAM_KEY]: kind, [NODE_TRIGGER_EVENTS_PARAM_KEY]: "library.item.downloaded" }
        : { [NODE_TRIGGER_KIND_PARAM_KEY]: kind };
    const keys = triggerFactKeysOf(params);
    const payload = richestPayload[kind];
    const missing = keys.filter((k) => !Object.prototype.hasOwnProperty.call(payload, k));
    eq(`${kind}:候选都取得到(缺的是 ${missing.join() || "无"})`, missing.length, 0);
  }

  // 定时**不该**列出 `files`/`event` —— 这几个是原来那份名单里多出来的那几项。
  const sched = triggerFactKeysOf({ [NODE_TRIGGER_KIND_PARAM_KEY]: "schedule" });
  check("定时不列 files/event/toolName/subjects", !sched.includes("files") && !sched.includes("event") && !sched.includes("toolName") && !sched.includes("subjects"), sched);
  eq("定时 = kind + at", [...sched].sort().join(","), "at,kind");
  check("文件变化列 files、不列 at", triggerFactKeysOf({ [NODE_TRIGGER_KIND_PARAM_KEY]: "file" }).includes("files") && !triggerFactKeysOf({ [NODE_TRIGGER_KIND_PARAM_KEY]: "file" }).includes("at"));

  // **`manual` 必须并进来。** 「立刻运行一次」对**任何一种**触发器都能点
  // (`automationRunner.runNow`),载荷恒是 `{kind:"manual"}` —— 只按配置那一种算的话,
  // 一个定时自动化手动跑时,菜单会照样摆着「触发时刻」,又炸一次。
  const manualKeys = triggerFactKeysOf({ [NODE_TRIGGER_KIND_PARAM_KEY]: "schedule" });
  check("定时那条也留着 kind(kind 是两种跑法都有的)", manualKeys.includes("kind"), manualKeys);

  // 没配好触发方式 = 只给 `kind`,不猜。
  eq("认不出的触发方式只给 kind", triggerFactKeysOf({}).join(), "kind");
  eq("乱填的触发方式同样只给 kind", triggerFactKeysOf({ [NODE_TRIGGER_KIND_PARAM_KEY]: "nope" }).join(), "kind");

  // 每一种都有 `kind`(手动与自动的共同项),而且都不重复。
  for (const kind of TRIGGER_KINDS) {
    const keys = triggerFactKeysOf({ [NODE_TRIGGER_KIND_PARAM_KEY]: kind });
    check(`${kind}:有 kind 且不重复`, keys.includes("kind") && new Set(keys).size === keys.length, keys);
  }
}

/* ── 8c. 事件那一种还要看"听的是哪几个事件"(2026-09-19) ── */

// 「这件事是关于哪一条」那几项只有**资料库那两个事件**带得出,而听哪些事件写在参数里。
// 所以按种类写死的那张表不够 —— 一个听 `library.item.downloaded` 的触发器,菜单里得摆着
// `itemId`,而一个听 `turn.done` 的**不能**摆(取不到 = 那一步跑不起来)。
//
// 这条不变量直接对着新版内置自动化:`AUTO_CONVERT_*` 的指令里写着"是哪一条见下面那段
// 载荷",而载荷里到底有没有那几项,判据就是这里。
console.log("\ntriggerFactKeysOf · 事件那一种按「听哪个事件」算");
{
  const evt = (events: string): readonly string[] =>
    triggerFactKeysOf({ [NODE_TRIGGER_KIND_PARAM_KEY]: "event", [NODE_TRIGGER_EVENTS_PARAM_KEY]: events });

  const dl = evt("library.item.downloaded");
  check("下载完成:列 itemId/itemTitle/itemKind/pdfPath", ["itemId", "itemTitle", "itemKind", "pdfPath"].every((k) => dl.includes(k)), dl);
  check("下载完成:也留着事件自己那几项", dl.includes("event"), dl);

  const imp = evt("library.item.imported");
  check("导入:列 itemId/itemTitle/itemKind", ["itemId", "itemTitle", "itemKind"].every((k) => imp.includes(k)), imp);
  // ⚠️ **导入那条不该列 `pdfPath`** —— 导入那一下文件还没下来,`eventItemFactsOf` 从
  // `LibraryItemImportedEvent` 里取不到它(那个接口压根没有这个字段)。
  check("导入:不列 pdfPath(那一刻文件还没下来)", !imp.includes("pdfPath"), imp);

  // 听 `turn.done` 这种不带条目的 —— 一项都不该列,否则插进指令必炸。
  const done = evt("turn.done");
  check("一轮结束:不列任何条目事实", !done.some((k) => ["itemId", "itemKind", "itemTitle", "pdfPath"].includes(k)), done);

  // 听多个事件时取**交集**:哪条响是运行时的事,指令只能写"哪条响都取得到"的。
  const both = evt("library.item.imported,library.item.downloaded");
  check("导入+下载:交集 = 只共有的那几项", ["itemId", "itemTitle", "itemKind"].every((k) => both.includes(k)) && !both.includes("pdfPath"), both);

  // 认不出来的事件名不掺和(那一关由 parseTriggerSpec 把整条触发器拒掉)。
  const bogus = evt("library.item.downloaded,nope");
  check("混了不认识的事件名:按认识的那个算", bogus.includes("itemId"), bogus);
  check("一个都不认识:不列条目事实", !evt("nope,alsonope").some((k) => k.startsWith("item")), evt("nope,alsonope"));
  check("没填听哪些事件:不列条目事实", !evt("").some((k) => k.startsWith("item")), evt(""));
}

/* ── 8d. 那几项**真能从事件里取出来**(2026-09-19) ── */

// ⚠️ 这一节是补一个**已经犯过的错**:`eventItemFactsOf` 起初照着键名去事件上搬字段,
// 而事件上那两个字段叫 `kind` / `title`,不叫 `itemKind` / `itemTitle` —— 于是它们
// **永远取不到**,而 `pdfPath` / `itemId` 恰好同名所以看着是好的。
//
// 那种错**测不出来**:8c 只验"表上列着哪几项",载荷里少两行模型照样能干活(只拿到一个
// id),没有任何东西会响。真正能钉住它的是**拿事件本身当夹具** —— 下面每一段都从
// `@contracts/runtime` 那两个接口的**实际字段**出发,而不是我手写的键名。
console.log("\neventItemFactsOf · 拿真事件当夹具(不是手写的键名)");
{
  // 换掉 `itemKind`/`itemTitle` 这两个字段名,下面必红。
  const imported: RuntimeEvent = {
    type: "library.item.imported",
    sessionId: "(system)",
    itemId: "lib_1",
    kind: "paper",
    title: "导入的那一篇",
  } as unknown as RuntimeEvent;
  const importedFacts = eventItemFactsOf(imported);
  eq("导入:id 从 itemId 取得", importedFacts?.itemId, "lib_1");
  eq("导入:类型从 kind 取得(不是 itemKind)", importedFacts?.itemKind, "paper");
  eq("导入:标题从 title 取得(不是 itemTitle)", importedFacts?.itemTitle, "导入的那一篇");
  check("导入:没有 pdfPath 这一项", importedFacts?.pdfPath === undefined, importedFacts);

  const downloaded: RuntimeEvent = {
    type: "library.item.downloaded",
    sessionId: "(system)",
    itemId: "lib_2",
    kind: "paper",
    title: "下完的那一篇",
    pdfPath: "papers/ab/abcdef.pdf",
  } as unknown as RuntimeEvent;
  const dlFacts = eventItemFactsOf(downloaded);
  eq("下载:四项全取到", JSON.stringify(dlFacts), JSON.stringify({
    itemId: "lib_2",
    itemKind: "paper",
    itemTitle: "下完的那一篇",
    pdfPath: "papers/ab/abcdef.pdf",
  }));

  // **表与取法必须对得上**:8c 列出来的每一项,拿真事件都得取得到。这条不变量把
  // "表里加了键、取的时候漏了"这类错钉死在原地 —— 上面那个 bug 正是这个形状。
  for (const [event, sample] of [
    ["library.item.imported", imported],
    ["library.item.downloaded", downloaded],
  ] as const) {
    const promised = eventItemFactKeysOf(event);
    const got = eventItemFactsOf(sample) ?? {};
    const lost = promised.filter((k) => got[k] === undefined);
    eq(`${event}:表上列的都取得到(丢的是 ${lost.join() || "无"})`, lost.length, 0);
  }

  // `pdfPath` 空串当没有 —— 事件的 `pdfPath` 是 `item.pdfPath ?? ""`,而"这篇有 PDF,
  // 路径是空的"对模型是句假话。
  const emptyPath = eventItemFactsOf({
    type: "library.item.downloaded",
    sessionId: "(system)",
    itemId: "lib_3",
    kind: "paper",
    title: "没有路径的那一篇",
    pdfPath: "",
  } as unknown as RuntimeEvent);
  check("下载:空串路径不算有", emptyPath?.pdfPath === undefined, emptyPath);
  eq("下载:其余照样有", emptyPath?.itemId, "lib_3");

  // 不带条目的事件一律 `undefined` —— 不许凭空造。
  eq("别的钩子事件:没有条目事实", eventItemFactsOf({ type: "turn.done", sessionId: "s" } as unknown as RuntimeEvent), undefined);
  eq("不带条目的事实键:空(不是 undefined 串)", eventItemFactKeysOf("turn.done").length, 0);
}

/* ── 8e. 合并窗口里的几条**不会互相顶掉**(2026-09-19) ── */

// ⚠️ 这一节也是补**已经犯过的错**:`pending.event` 起初是直接赋值,而触发器有合并窗口
// (默认 2 秒)—— 下载是并发跑的,两篇同时下完就落在同一个窗口里,于是**后一条静默顶掉
// 前一条**:载荷里只剩一条,模型只转一条,另一篇再也没人管,而且不报错。
//
// 文件那一路(`pending.files` 是 push 的)本来就没这毛病,事件这一路漏了。
//
// 真正能钉住它的是**拿两次事件喂同一个触发器**,再看载荷里是不是两条都在 —— 断言写在
// `automationRunner` 那一侧(真起 timer),而那要起会话;这里验的是**它依赖的那件事**:
// 载荷本身装得下多条、`payloadFactsOf` 也照实报出条数。
console.log("\n事件载荷 · 合并窗口里的多条");
{
  // 渲染:两条都在、条数写明白了。
  const two = describeTriggerPayload({
    kind: "event",
    event: "library.item.downloaded",
    items: [
      { itemId: "lib_1", itemTitle: "第一篇", pdfPath: "pdf/a.pdf" },
      { itemId: "lib_2", itemTitle: "第二篇", pdfPath: "pdf/b.pdf" },
    ],
  });
  check("两条:两个标题都在", two.includes("第一篇") && two.includes("第二篇"), two);
  check("两条:两个 id 都在", two.includes("id=lib_1") && two.includes("id=lib_2"), two);
  check("两条:明说一共几条(不然模型只办一条)", two.includes("一共有 2 条"), two);

  // 平面事实:单数项取第一条,但**条数必须报出来**。
  const facts = payloadFactsOf({
    kind: "event",
    event: "library.item.downloaded",
    items: [{ itemId: "lib_1", itemTitle: "第一篇" }, { itemId: "lib_2", itemTitle: "第二篇" }],
  });
  eq("两条:itemCount 报出 2", facts.itemCount, 2);
  eq("两条:单数的 itemId 取第一条(数组摊成顿号对 {{trigger.itemId}} 没意义)", facts.itemId, "lib_1");

  // 一条时不报数 —— 凭空出现「一共 1 条」会让模型以为还有什么要办。
  const one = payloadFactsOf({ kind: "event", event: "library.item.downloaded", items: [{ itemId: "x" }] });
  check("一条:没有 itemCount", one.itemCount === undefined, one);
}

/* ── 8f. 合并窗口里连着来的两条**都留着**(2026-09-19) ── */

// ⚠️ 这一节补的是**已经犯过的错**,而且是这一整块里最安静的那一个:
// `pending.event` 起初是**直接赋值**。触发器有合并窗口(默认 2 秒),而下载是并发跑的
// —— 两篇论文同时下完,两条事件落在同一个窗口里,于是**后一条静默顶掉前一条**:载荷里
// 只剩一条,模型只转一条,另一篇**再也没人管**,而且一个字都不报。
//
// 文件那一路(`pending.files` 是 push 的)本来就没这毛病,事件这一路漏了 —— 正是"同一件
// 事两条路各自实现"才会有的那种漏。所以这回把攒载荷这段拆成纯函数,在这儿钉死。
console.log("\nmergeEventPayload · 合并窗口里的两条都留着");
{
  const item1 = { itemId: "lib_1", itemTitle: "第一篇", itemKind: "paper" };
  const item2 = { itemId: "lib_2", itemTitle: "第二篇", itemKind: "paper" };

  // 第一条:累加(空 → 一条)。
  const first = mergeEventPayload(undefined, "library.item.downloaded", {}, item1);
  eq("第一条:载荷里一条", first.kind === "event" ? first.items?.length : -1, 1);

  // **第二条必须还在,不能顶掉第一条。** 这一行就是那个 bug 的判据 —— 把它改回
  // `pending.event = {...}` 那种写法,这里必红。
  const second = mergeEventPayload(first, "library.item.downloaded", {}, item2);
  eq("第二条:两条都在(不是顶掉)", second.kind === "event" ? second.items?.length : -1, 2);
  check(
    "第二条:两条各自带自己的 id",
    second.kind === "event" && second.items?.[0]?.itemId === "lib_1" && second.items?.[1]?.itemId === "lib_2",
    second,
  );
  // 顺序照来的先后 —— 模型照着念的顺序该和发生的一致。
  check(
    "第二条:标题也在、顺序照来的先后",
    second.kind === "event" && second.items?.[0]?.itemTitle === "第一篇" && second.items?.[1]?.itemTitle === "第二篇",
    second,
  );

  // 攒起来之后**渲染出来的就是两条**,不是一条。
  const rendered = describeTriggerPayload(second);
  check("攒两条之后渲染出「一共有 2 条」", rendered.includes("一共有 2 条"), rendered);

  // 同一条重复通知(重试 / 两次 finalize)**不该办两遍**。
  const dup = mergeEventPayload(second, "library.item.downloaded", {}, item1);
  eq("同一条重复通知:去重(还是一条)", dup.kind === "event" ? dup.items?.length : -1, 2);

  // 事件名 / 工具名 / 主语是**覆盖**:它们说的是"这是个什么事件",窗口里最后那条为准。
  const withTool = mergeEventPayload(
    mergeEventPayload(undefined, "tool.use", { toolName: "Write", subjects: ["a.md"] }, undefined),
    "tool.use",
    { toolName: "Bash", subjects: ["b.sh"] },
    undefined,
  );
  check(
    "工具名与主语是覆盖(最后一条为准)",
    withTool.kind === "event" && withTool.toolName === "Bash" && withTool.subjects?.join() === "b.sh",
    withTool,
  );
  check("没有条目的那条:载荷上压根没有 items", withTool.kind === "event" && withTool.items === undefined, withTool);

  // 上一条是文件触发(载荷不是 event)**也不会把它的东西串进来**。
  const afterFile = mergeEventPayload({ kind: "file", files: ["x.md"] }, "library.item.downloaded", {}, item2);
  check(
    "上一条不是事件载荷时:干净地重开",
    afterFile.kind === "event" && afterFile.items?.length === 1 && afterFile.items[0]?.itemId === "lib_2",
    afterFile,
  );
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
    enabled: true,
  };
  const broken: Parameters<typeof facts.recordSetup>[0] = {
    workflowId: "wf",
    nodeId: "T2",
    title: "到点跑",
    kind: "schedule",
    enabled: true,
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
    triggerSeedOf({ ...armed, spec: { kind: "file" }, params: {} }),
    "上一次还在跑,这一次触发已跳过",
    600,
  );
  const afterFire = facts.ofWorkflow("wf").find((f) => f.nodeId === "T1");
  eq("lastFireAt 记了", afterFire?.lastFireAt, 500);
  eq("lastError 记了", afterFire?.lastError, "上一次还在跑,这一次触发已跳过");
  eq("blocked 不改 armed", afterFire?.armed, true);

  // watcher 失效 → 重试成功:armed 翻过去再翻回来,**运行史不动**。
  facts.recordSetup(triggerSeedOf({ ...armed, spec: { kind: "file" }, params: {} }), false, "目录监听失效:ENOENT");
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
  facts.recordSetup({ workflowId: "wf2", nodeId: "A", title: "zzz", kind: "manual", enabled: true }, true);
  facts.recordSetup({ workflowId: "wf2", nodeId: "B", title: "aaa", kind: "manual", enabled: true }, true);
  eq("ofWorkflow 只看自己的工作流", facts.ofWorkflow("wf2").length, 2);
  eq("按标题排序", facts.ofWorkflow("wf2").map((f) => f.nodeId).join(","), "B,A");
  eq("all 是全部", facts.all().length, 3);

  // 守望起跑那条 **ad-hoc** 路径:没有经过 buildTriggers 的登记,fired 本身就是登记。
  facts.recordFired({ workflowId: "wf_watch", nodeId: "T", title: "守望入口", kind: "manual", enabled: true }, 700);
  const watch = facts.ofWorkflow("wf_watch")[0];
  check("ad-hoc 起跑即登记(armed + lastFire)", watch?.armed === true && watch?.lastFireAt === 700, watch);

  // 没登记过的触发器被拦截(项目没了),也要记下原因 —— 界面要能回答「它怎么没跑」。
  facts.recordBlocked({ workflowId: "wf_x", nodeId: "T", title: "x", kind: "manual", enabled: true }, "项目不在了", 800);
  eq("未登记的 blocked 也落表", facts.ofWorkflow("wf_x")[0]?.lastError, "项目不在了");

  facts.clear();
  eq("clear 清干净(dispose 用)", facts.all().length, 0);
}

/* ──────────── 11a-1. 「最近一次为什么没跑成」不能比「最近一次运行」还旧 ──────────── */

console.log("\nlatestFailureOf · 陈年旧账不能一直挂在界面上");

{
  // `recordFired` 是**只增不改**的(见类头那条不变量):它不会把 `lastError` 清掉。
  // 而重入跳过("上一次还在跑")这种东西,一条**经常**触发的自动化一两天就会攒下一条
  // —— 早先界面无条件显示它,于是那条触发器上永远挂着一行红字,说它"最近一次没跑成",
  // 而它其实一直在跑。用户没法把红字消掉(除非删了重建),只能学会无视它。
  //
  // 判据是**谁的更近**:跑过之后那次失败就成了旧账,不再显示;跑之前那次失败仍然显示
  // (那才是"为什么刚才没响"的答案)。
  const facts = new AutomationFacts();
  const seed: Parameters<typeof facts.recordSetup>[0] = {
    workflowId: "wf_latest",
    nodeId: "T",
    title: "盯文件",
    kind: "file",
    enabled: true,
  };
  facts.recordSetup(seed, true);

  const row = (): ReturnType<typeof facts.ofWorkflow>[number] => facts.ofWorkflow("wf_latest")[0];

  // ① 刚起跑就被跳过:没有 lastFire,失败就是最新的 → 显示。
  facts.recordBlocked(seed, "上一次还在跑,这一次触发已跳过", 1000);
  eq("没跑过时,失败显示出来", latestFailureOf(row()), "上一次还在跑,这一次触发已跳过");

  // ② 后来又真的跑起来了(那次运行结束了)→ 陈年旧账不该再挂在那儿。
  facts.recordFired(seed, 2000);
  eq("跑过之后,旧的那条不再显示", latestFailureOf(row()), undefined);
  check("旧账本身没有被抹掉(只是不显示)", row()?.lastError !== undefined, row()?.lastError);

  // ③ 跑完之后又失败了一次 → 新的那条是**最新**的,该显示。
  facts.recordBlocked(seed, "项目不在了", 3000);
  eq("跑完之后新出的失败照常显示", latestFailureOf(row()), "项目不在了");

  // ④ 同一毫秒也要能判(用 `<` 而不是 `<=` 的话这里会翻车)——
  //    `recordFired` 与 `recordBlocked` 都收调用方给的 `Date.now()`,同毫秒完全可能。
  const tie = new AutomationFacts();
  tie.recordSetup(seed, true);
  tie.recordBlocked({ ...seed, workflowId: "wf_tie" }, "上一次还在跑", 5000);
  tie.recordFired({ ...seed, workflowId: "wf_tie" }, 5000);
  eq(
    "同一毫秒算「跑过了」(不然重入跳过会赖着不走)",
    latestFailureOf(tie.ofWorkflow("wf_tie")[0]),
    undefined,
  );

  // ⑤ 从来没失败过 → 当然没有。
  const clean = new AutomationFacts();
  clean.recordSetup(seed, true);
  clean.recordFired({ ...seed, workflowId: "wf_clean" }, 100);
  eq("没失败过就没有那句", latestFailureOf(clean.ofWorkflow("wf_clean")[0]), undefined);
}

/* ────────────────── 11a-3. 改了配置,攒着的那一次不该按旧条件跑 ────────────────── */

console.log("\ntriggerSpecKeyOf · 攒着的触发要认得出「这条配置已经改了」");

{
  // `pendingFires` 里可能攒着一次还没到点的触发(合并窗口最长几秒),而用户完全可能
  // 在这几秒里改了触发方式并存盘。`apply()` 只丢掉"触发器没了"的那些 —— 改了 glob /
  // 改了事件名的**不会**被丢掉,于是几秒后它按**旧条件**起一次运行(旧条件正是用户
  // 刚改掉的东西)。签名就是拿来认这个的。

  const fileSpec = (globs: string[], debounceMs = DEFAULT_TRIGGER_DEBOUNCE_MS): TriggerSpec => ({
    kind: "file",
    globs,
    debounceMs,
  });
  const key = triggerSpecKeyOf(fileSpec(["src/*.ts"]));

  // 同一个条件算几遍都一样(纯函数)。
  eq("同一条 spec 算两遍结果一样", triggerSpecKeyOf(fileSpec(["src/*.ts"])), key);
  // 换掉 glob = 用户改的就是这个 → 签名必须变。
  check("换了 glob 签名就变了", triggerSpecKeyOf(fileSpec(["src/*.md"])) !== key);
  // 加一个 glob 也要变(不是"包含关系",是"一模一样")。
  check("多一个 glob 签名也变", triggerSpecKeyOf(fileSpec(["src/*.ts", "*.md"])) !== key);
  // **顺序不同算不算改?** 算 —— 攒着的那次与新的那次不是同一份配置,重跑一遍是最省心
  // 且不会漏的解释(glob 之间是并集,重跑的结果与"按新配置攒"一致)。
  check("顺序变了签名也变(重跑一遍不吃亏)", triggerSpecKeyOf(fileSpec(["a", "b"])) !== triggerSpecKeyOf(fileSpec(["b", "a"])));
  // 合并窗口也是配置的一部分:从 2000 改成 0 是用户在说"别等,每次都跑"。
  check("合并窗口变了签名也变", triggerSpecKeyOf(fileSpec(["src/*.ts"], 0)) !== key);

  // 分隔符不能靠逗号:glob 里本来就有逗号(`a,b` 是"任意一个"的写法见 `splitGlobList`)。
  // 用逗号拼的话 `["a","b"]` 与 `["a,b"]` 会撞成同一个签名 —— 那一改就成了**漏判**。
  check(
    "glob 里的逗号不会把两个不同的配置拼成同一个签名",
    triggerSpecKeyOf(fileSpec(["a", "b"])) !== triggerSpecKeyOf(fileSpec(["a,b"])),
  );

  // 事件那一路:`matcher` 与事件集合都参与判定。
  const ev = (events: HookEvent[], matcher = ""): TriggerSpec => ({
    kind: "event",
    events,
    matcher,
    debounceMs: DEFAULT_TRIGGER_DEBOUNCE_MS,
  });
  check("改了事件集合签名就变", triggerSpecKeyOf(ev(["tool.use"])) !== triggerSpecKeyOf(ev(["tool.result"])));
  check("改了 matcher 签名就变", triggerSpecKeyOf(ev(["tool.use"])) !== triggerSpecKeyOf(ev(["tool.use"], "Write")));
  eq("同一个事件配置算两遍一样", triggerSpecKeyOf(ev(["tool.use"], "Write")), triggerSpecKeyOf(ev(["tool.use"], "Write")));

  // 定时那一路看 cron 文本(解析后的字段就是它的函数,文本变了字段必变)。
  const cronA = (parseCron("0 9 * * *") as { ok: true; spec: CronSpec }).spec;
  const cronB = (parseCron("30 9 * * *") as { ok: true; spec: CronSpec }).spec;
  eq("同一条 cron 签名一样", triggerSpecKeyOf({ kind: "schedule", cron: cronA }), triggerSpecKeyOf({ kind: "schedule", cron: cronA }));
  check("换了 cron 签名就变", triggerSpecKeyOf({ kind: "schedule", cron: cronA }) !== triggerSpecKeyOf({ kind: "schedule", cron: cronB }));

  // 不同的**类型**之间不该撞(改触发方式是最常见的一种"改了配置")。
  const keys = [
    triggerSpecKeyOf({ kind: "manual" }),
    triggerSpecKeyOf({ kind: "schedule", cron: cronA }),
    triggerSpecKeyOf(fileSpec(["src/*.ts"])),
    triggerSpecKeyOf(ev(["tool.use"])),
  ];
  eq("四种触发方式两两不同", new Set(keys).size, 4);
}

/* ────────────────── 11a-2. 重新挂载不该抹掉「它上周跑过」 ────────────────── */

console.log("\nreload 重新登记挂载侧 · 不许动运行侧");

{
  // `buildTriggers` **每一次 reload 都对每条解开的触发器登记一遍**挂载侧(`recordSetup(seed, true)`),
  // 而 reload 触发得很频繁:启动一次、每存一次工作流一次、`reloadAll` 又各来一次。
  // 运行侧那两笔(`lastFireAt` / `lastError`)是**另一个维度**的事实,重新登记挂载不该把它抹掉
  // —— 抹掉之后界面上「最近一次运行」会变回空白,而那条自动化明明上周跑过。
  const facts = new AutomationFacts();
  const seed: Parameters<typeof facts.recordSetup>[0] = {
    workflowId: "wf_rearm",
    nodeId: "T",
    title: "盯文件",
    kind: "file",
    enabled: true,
  };

  facts.recordSetup(seed, true);
  facts.recordFired(seed, 1000);
  eq("跑过之后有 lastFire", facts.ofWorkflow("wf_rearm")[0]?.lastFireAt, 1000);

  // 用户改了个无关的节点 → 存盘 → reload。挂载侧重新登记(还是挂得好好的)。
  facts.recordSetup(seed, true);
  eq("重新挂上不该抹掉「最近一次运行」", facts.ofWorkflow("wf_rearm")[0]?.lastFireAt, 1000);
  eq("重登之后仍然是响着的", facts.ofWorkflow("wf_rearm")[0]?.armed, true);

  // 失败那一侧同理。先记一次「上一次还在跑,跳过了」,再走一次 reload。
  facts.recordBlocked(seed, "上一次还在跑,这一次触发已跳过", 2000);
  facts.recordSetup(seed, true);
  const after = facts.ofWorkflow("wf_rearm")[0];
  eq("重新挂上不该抹掉「最近一次为什么没跑成」", after?.lastError, "上一次还在跑,这一次触发已跳过");
  eq("那句原因的时刻也留着", after?.lastErrorAt, 2000);

  // 对照:`ready: false`(真的挂不上了)**要**当场改掉挂载侧 —— 这条不变量不能被上面那条读丢。
  facts.recordSetup(seed, false, "目录监听失效:ENOENT");
  const broken = facts.ofWorkflow("wf_rearm")[0];
  eq("挂不上时 armed 变 false", broken?.armed, false);
  eq("挂不上时说的是那个原因", broken?.detail, "目录监听失效:ENOENT");
  eq("挂不上也仍然不动运行侧", broken?.lastFireAt, 1000);
}

/* ────────────────────────── 11b. 触发器上的「启用」开关(C3) ────────────────────────── */

console.log("\n触发器的「启用」开关 · 缺席 = 开,关掉的只挡自动、不挡手动");

{
  // ── 契约侧:读法只有一处(`triggerEnabledOf`),缺席 = 开 ──
  eq("参数袋里没有这个键 = 开", triggerEnabledOf({}), true);
  eq("明确写 true = 开", triggerEnabledOf({ [NODE_TRIGGER_ENABLED_PARAM_KEY]: true }), true);
  eq("明确写 false = 关", triggerEnabledOf({ [NODE_TRIGGER_ENABLED_PARAM_KEY]: false }), false);
  // 老存档里那一格可能是什么都可能(当年没有这个键,或者被手改成了字符串)。
  // **只认 `false` 这一个值** —— 认不出来的当开,和缺席同一条路:读成"关"会让一条
  // 本来在响的自动化在升级那一刻静默停摆,那是最难查的一类故障。
  eq("写字符串 false(手改过的存档)= 开", triggerEnabledOf({ [NODE_TRIGGER_ENABLED_PARAM_KEY]: "false" }), true);
  eq("写 null(老存档的默认值)= 开", triggerEnabledOf({ [NODE_TRIGGER_ENABLED_PARAM_KEY]: null }), true);
  eq("写 0 = 开", triggerEnabledOf({ [NODE_TRIGGER_ENABLED_PARAM_KEY]: 0 }), true);

  // ── seed:真相取自参数袋,不另存一份 ──
  const base = { workflowId: "wf", nodeId: "T", title: "盯文件", spec: { kind: "file" } };
  eq("seed 认参数袋", triggerSeedOf({ ...base, params: {} }).enabled, true);
  eq(
    "种子上的 enabled 就是关掉那一格",
    triggerSeedOf({ ...base, params: { [NODE_TRIGGER_ENABLED_PARAM_KEY]: false } }).enabled,
    false,
  );

  // ── 事实表:关掉的**照样进表**,只是换成「你自己关的」那句话 ──
  const facts = new AutomationFacts();
  const off = triggerSeedOf({ ...base, params: { [NODE_TRIGGER_ENABLED_PARAM_KEY]: false } });
  const on = triggerSeedOf({ ...base, nodeId: "T2", params: {} });
  // 第二个参数说的是**执行器那一侧**有没有问题(参数解开了、项目在),这里都说"没有";
  // 用户那一票在 seed 里,由 `recordSetup` 合进去。
  facts.recordSetup(off, true);
  facts.recordSetup(on, true);
  const offRow = facts.ofWorkflow("wf").find((f) => f.nodeId === "T");
  eq("关掉的进表(不是整行消失)", offRow !== undefined, true);
  eq("关掉的 enabled 是 false", offRow?.enabled, false);
  eq("关掉的 armed 也是 false —— 它真的不响", offRow?.armed, false);
  eq(
    "关掉的原因说的是「是你关的」,不是「坏了」",
    offRow?.detail,
    "已关闭(在触发器节点上打开「启用」才会自动响)",
  );
  eq("没关的那条照旧 armed", facts.ofWorkflow("wf").find((f) => f.nodeId === "T2")?.armed, true);

  // ── 手动跑一次关掉的:允许,但**不许**把事实说成"它又自动响着了" ──
  facts.recordFired(off, 900);
  const afterManual = facts.ofWorkflow("wf").find((f) => f.nodeId === "T");
  eq("手动跑过之后 lastFireAt 记了", afterManual?.lastFireAt, 900);
  eq("手动跑一次**不会**把它说成自动响着", afterManual?.armed, false);
  eq("关着的那句话还在", afterManual?.detail, "已关闭(在触发器节点上打开「启用」才会自动响)");

  // ── 三条路都在登记同一条触发器:用户关掉的那句话**说了算** ──
  // 目录监听那条路里外里会报三次(失效:ENOENT / 失效:EPERM / 挂上了),而用户关掉的
  // 那条从头到尾只该有一句话。所以 `detail` 由 `recordSetup` 一处决定,不看调用方。
  facts.recordSetup(off, false, "目录监听失效:ENOENT");
  const whileDown = facts.ofWorkflow("wf").find((f) => f.nodeId === "T");
  check("监听失效也盖不掉「是你关的」", (whileDown?.detail ?? "").startsWith("已关闭"), whileDown?.detail);
  check("监听的原因附在后面(回头开「启用」时会撞上它)", (whileDown?.detail ?? "").includes("ENOENT"), whileDown?.detail);
  facts.recordSetup(off, true);
  eq(
    "监听重试成功之后还是那一句",
    facts.ofWorkflow("wf").find((f) => f.nodeId === "T")?.detail,
    "已关闭(在触发器节点上打开「启用」才会自动响)",
  );
  eq("重试成功也不会把它说成自动响着", facts.ofWorkflow("wf").find((f) => f.nodeId === "T")?.armed, false);

  facts.clear();
}

/* ────────────────────────── 11c. 「启用」在参数表最上面(C3 的界面侧) ────────────────────────── */

console.log("\n触发器的参数表 · 「启用」排在「触发方式」前面");

{
  const manifest = builtinTriggerManifest();
  const keys = manifest.params.map((p) => p.key);
  eq("第一格就是「启用」", keys[0], NODE_TRIGGER_ENABLED_PARAM_KEY);
  // 顺序不是审美问题:关掉的触发器,下面那些参数填得再全也不会响。开关摆在最上面,
  // 症状一眼可见;摆最下面的话得把一整屏看完才发现根因。
  check(
    "「启用」在「触发方式」之前",
    keys.indexOf(NODE_TRIGGER_ENABLED_PARAM_KEY) < keys.indexOf(NODE_TRIGGER_KIND_PARAM_KEY),
    keys,
  );
  const enableParam = manifest.params[0];
  eq("是勾选框(不是开关控件 —— 没有那种 kind)", enableParam?.kind, "boolean");
  // 默认**开**:新拖一个触发器节点出来就该是响的,否则用户会以为它坏了。
  eq("默认开着", enableParam?.default, true);
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

  // ⚠️ **一次事件只能取一次事实。** `factsOf` 对 `tool.result` 是回查即消费的,而
  // `automationRunner.onEvent` 是对**每条触发器**各算一次主语的(每条的项目目录不同,
  // 路径主语要按各自的算)。早先它在循环里对每条触发器各调一次有状态的 `of()`,于是
  // 第一条触发器把工具名取走,后面几条拿到空 —— `matchesAnyGlob` 对空主语返回 false,
  // 那几条带 matcher 的触发器**安静地不响**(两条盯同一个工具的触发器只有第一条会跑)。
  // 现在事实取一次、主语那半是纯的,所以下面这样问几遍都对。
  {
    // ⚠️ **新起一个实例、新的 toolCallId。** 上面那个 `subjects` 已经把 `tc1` 消费掉了
    // —— 拿它再问一遍等于在验证"消费过了就没有",而这条要验的恰恰相反。
    const es = createEventSubjects();
    const TC = "tc_purity";
    es.factsOf({
      type: "tool.use",
      sessionId: "s",
      toolCallId: TC,
      toolName: "Write",
      input: {},
      requiresApproval: false,
    } satisfies RuntimeEvent);
    const res = {
      type: "tool.result",
      sessionId: "s",
      toolCallId: TC,
      isError: false,
      content: "",
    } satisfies RuntimeEvent;
    const facts = es.factsOf(res);
    eq("事实取一次:工具名在", facts.toolName, "Write");
    const first = es.subjectsOf(res, "D:\\projA", facts.toolName);
    const second = es.subjectsOf(res, "D:\\projB", facts.toolName);
    eq("第一条触发器算出的主语", (first ?? []).join(), "Write");
    eq("第二条触发器算出的主语也一样(纯的,不会被前一条消费掉)", (second ?? []).join(), "Write");
    check("两条都能匹配上 matcher", matchesAnyGlob("Write", first ?? []) && matchesAnyGlob("Write", second ?? []));
  }
}

/* ────────────── 12. 内置自动化真的能武装起来 ────────────── */

console.log("\n内置自动化 · 参数解得开、项目留空也挂得上");

{
  // 这一节钉的是一个**已经发生过**的故障,而且它当初是静默的:内置模板预置不出项目 id
  // (项目 id 是建项目时现生成的 `uid("proj_")`),而 `parseTriggerSpec` 曾经对**每一种**
  // 触发方式都要求项目非空 —— 于是两条内置自动化一条也挂不上,界面上却参数填得好好的,
  // 没有任何地方说得出为什么。**这条断言就是那次故障的哨兵。**
  const types = new Map<string, NodeTypeManifest>([
    [TRIGGER.id, builtinTriggerManifest()],
    [AGENT.id, AGENT],
  ]);

  // ⚠️ **守望不在这一轮里**,而这不是漏了:它的触发器**故意**是"项目没填"的
  // (见 `WATCH_NODES` 那段注释)—— 起跑时由 `startWatch` 把发起会话的项目写进去,
  // 在那之前它本来就该是"挂不上"的。硬把它塞进来只会逼着模板去编一个项目 id。
  for (const [id, what] of [
    [AUTO_DOWNLOAD_WORKFLOW_ID, "导入后自动下载"],
    [AUTO_CONVERT_WORKFLOW_ID, "下载完自动转 Markdown"],
  ] as const) {
    const doc = getBuiltinWorkflow(id);
    check(`内置工作流「${what}」还在`, doc !== undefined, id);
    if (!doc) continue;
    // `deriveTrigger` 就是**存盘那一关**跑的那个函数 —— 它拒了就说明这份内置图在界面上
    // 一存就报错;它过了才谈得上"能跑"。
    const derived = deriveTrigger(doc, types);
    check(`「${what}」的触发器解得开`, derived.ok, derived.ok ? undefined : derived.error);
    if (!derived.ok) continue;
    // 触发器节点在 → `trigger` 字段必须被反推出来(反推不出来 = 它在列表里会被分错栏)。
    eq(`「${what}」的 trigger 字段反推出来了`, derived.doc.trigger !== undefined, true);
  }

  check("内置工作流「守望」还在", getBuiltinWorkflow(WATCH_WORKFLOW_ID) !== undefined);

  // 「下载完自动转 Markdown」听的是**下载完成**那个事件,不是导入 —— 导入那一下文件还没下来,
  // 挂错了的话这条自动化永远转不出东西,而且不报错。
  const convertDoc = getBuiltinWorkflow(AUTO_CONVERT_WORKFLOW_ID);
  const convertTrigger = convertDoc?.nodes.find((n) => n.type === "mcode.trigger");
  const events = String(convertTrigger?.params[NODE_TRIGGER_EVENTS_PARAM_KEY] ?? "");
  eq("「下载完自动转 Markdown」听的是 library.item.downloaded", events, "library.item.downloaded");
  // 项目**故意留空** —— 它做的事(转录、挂回库)拿的都是绝对路径,不需要工作目录。
  // 「没绑项目」在这个仓里**一直**是空串这一个编码(守望那块也是),`buildTriggers`
  // 就是看它长度是不是 0 决定跳不跳查表。所以判据是"等于空串",不是"字段不存在"。
  //
  // 哪天有人"顺手"给它填个项目,这一条会红:内置模板预置不出项目 id(项目 id 是建
  // 项目时现生成的 `uid("proj_")`),填了反而挂不上 —— 就是这次修掉的那个故障。
  eq(
    "「下载完自动转 Markdown」没绑项目(空串 = 没绑)",
    String(convertTrigger?.params[NODE_TRIGGER_PROJECT_PARAM_KEY] ?? "x"),
    "",
  );

  // 纯件那一侧:一条**没绑项目**的事件触发器,挂载登记应当是"响着"的。
  // 这是上一条的另一半 —— 参数解得开还不够,`buildTriggers` 那一关也得放它过去。
  const facts = new AutomationFacts();
  const seed: AutomationFactsSeed = {
    workflowId: AUTO_CONVERT_WORKFLOW_ID,
    nodeId: "auto-convert-trigger",
    title: "下载完成触发",
    kind: "event",
    enabled: true,
  };
  facts.recordSetup(seed, true);
  eq("没绑项目的事件触发器登记成「响着」", facts.ofWorkflow(AUTO_CONVERT_WORKFLOW_ID)[0]?.armed, true);
  eq("而且没有 detail(不是坏掉了)", facts.ofWorkflow(AUTO_CONVERT_WORKFLOW_ID)[0]?.detail, undefined);
}

/* ────────── 13. 后台执行器本体的两条回归网(2026-09-20)────────── */

/**
 * 前 12 节验的全是**纯件**(`cron` / `parseTriggerSpec` / `automationStatus` /
 * `mergeEventPayload` / 调度器)。`automationRunner.ts` 那个**真的会跑起来的执行器**
 * 一直没有任何断言守着 —— 本套 268 条一条都不碰它。
 *
 * 这一节补上其中两处的回归网(两处都是最近修好、当时用一次性探针验完就删掉的):
 *
 *  - **① 定时触发器重启后重复触发**:去重记忆以前是进程里的 Map,重启就没了。
 *  - **② 文件触发器把已删除的文件名交给模型**:`fs.watch` 的 `rename` 对新建 / 删除 /
 *    改名一律报 `"rename"`(判不了方向),现在改判"此刻在不在"。
 *
 * ## 为什么要 `new` 一个真的执行器
 *
 * 这两条的实现全在实例状态里(`lastMinute` 这张表、`pendingFires` 那一格),而它们
 * **不存在于任何纯函数里** —— `shouldFireThisMinute` 只是那条规则的一半,另一半是
 * 执行器持有 / 落盘 / 修剪这张表的方式。所以这里拿真的类 `new` 实例(单例在
 * `automationRunner.ts` 末尾,`main/index.ts` 也是 `new` 出来用的),只把会话与引擎
 * 那一侧换成桩(见 `stubs/runner.ts`)。
 *
 * ## 时钟与数据根
 *
 *  - **时钟**:定时那一节的判据是"哪一分钟",真拿 `new Date()` 跑会随机器时刻漂移
 *    (跨分钟的那一瞬断言会翻)。所以每次 `onTick` 都把 `Date` 冻结在**指定的那一分钟**
 *    上(本地构造,同 `@contracts/cron` 文件头那条规矩)。
 *  - **数据根**:`lastMinute` 落盘走 `SettingRepo.set` → `persist()`,那是**重写整个
 *    `mcode.db`**。所以整套跑在一个 `mktemp -d` 出来的临时目录里(由 `run.sh` 的
 *    `MCODE_SMOKE_DATA_ROOT` 指过来),绝不碰用户的真库。
 */
console.log("\nAutomationRunner · 定时去重跨重启(①)+ 删掉的文件不进载荷(②)");

{
  /** 执行器的内部表面 —— 这两条断言要按"哪一分钟"与"攒着什么"看,而它们都不是公开 API。 */
  interface RunnerInternals {
    lastMinute: Map<string, number>;
    pendingFires: Map<string, { files: string[] }>;
    onTick(): void;
    onFsChange(dir: string, filename: string | null): void;
    start(): Promise<void>;
    reloadAll(): Promise<void>;
    dispose(): void;
  }
  // 单例是由同一个类 `new` 出来的,只是没导出那个类。拿到原型上的构造器 = 拿到类本身
  // (这样被测的是**真实的那个类**,不是另抄一份)。
  const RunnerCtor = Object.getPrototypeOf(automationRunner).constructor as new () => RunnerInternals;

  const newRunner = (): RunnerInternals => new RunnerCtor();

  /** 把 `Date` 冻结在这一刻(毫秒),跑完 `fn` 再装回去。见上面那段注释。 */
  function withClock<T>(ms: number, fn: () => T): T {
    const Real = Date;
    const Frozen = function (...args: unknown[]): Date {
      if (args.length === 0) return new Real(ms);
      return new (Real as unknown as new (...a: unknown[]) => Date)(...args);
    };
    (Frozen as unknown as { now: () => number }).now = () => ms;
    (globalThis as unknown as { Date: typeof Date }).Date = Frozen as unknown as typeof Date;
    try {
      return fn();
    } finally {
      (globalThis as unknown as { Date: typeof Date }).Date = Real;
    }
  }

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  /**
   * 文件事件从到达算起、到真的 flush,要等的**上限**。
   *
   * 实现里是 `WATCH_SETTLE_MS + trigger.spec.debounceMs`(`automationRunner` 里那个
   * 300ms 的常量,故意没导出),而本套**不 import 它**:这里要的是"等得比它久"这个
   * 粗量,不是那个精确值。抄一个常量进断言的话,实现一改这个数就会变成偶发红 —— 而
   * 偶发红是最没人信的一种断言。给足余量,只用于"别在还没到点时就断言"。
   */
  const FLUSH_SLACK_MS = 900;

  const LAST_MINUTE_KEY = "automation.lastMinute";
  /** 读盘上那张表(执行器的私有格式:JSON 小映射)。 */
  const onDisk = (): Record<string, unknown> => {
    const raw = SettingRepo.get(LAST_MINUTE_KEY);
    return raw === null || raw.length === 0 ? {} : (JSON.parse(raw) as Record<string, unknown>);
  };

  /** 每个场景一个工作流 id + 项目 id,互不干扰(表是按 `workflowId:nodeId` 索引的)。 */
  let seq = 0;
  const nextId = (): string => `wf_runner_${(seq += 1)}`;
  const PROJ_ID = "p_runner";
  const PROJ_DIR = join(process.env.MCODE_SMOKE_DATA_ROOT ?? ".", "watched-project");
  mkdirSync(PROJ_DIR, { recursive: true });

  /** 建一条自动化存进库里:`spec` 决定它是哪种触发器。 */
  const makeAutomation = (args: {
    workflowId: string;
    nodeId: string;
    params: Record<string, unknown>;
  }): void => {
    WorkflowRepo.save({
      id: args.workflowId,
      name: `执行器冒烟 ${args.workflowId}`,
      builtin: false,
      updatedAt: Date.now(),
      nodes: [
        {
          id: args.nodeId,
          type: "mcode.trigger",
          title: "触发器",
          params: {
            [NODE_TRIGGER_PROJECT_PARAM_KEY]: PROJ_ID,
            ...args.params,
          },
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
    });
  };

  /** 起一个执行器(`start()` 会把库里的触发器全解一遍、把落盘的去重表读回来)。 */
  const startRunner = async (): Promise<RunnerInternals> => {
    const r = newRunner();
    await r.start();
    return r;
  };

  await initDb();
  if (ProjectRepo.get(PROJ_ID) === undefined) {
    const now = Date.now();
    ProjectRepo.create({
      id: PROJ_ID,
      name: "执行器冒烟项目",
      path: PROJ_DIR,
      archived: false,
      group: null,
      sortOrder: 0,
      pinnedAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }
  // 数据根是临时目录,但**上一个场景留下的 settings 行**会跨场景活着 —— 场景一那一段
  // 刻意要看到它,别的地方则各自用新工作流 id,互不影响。

  /* ── ① 定时:同一分钟 tick 两次只跑一次 ── */

  // 语法上写死一个"每分钟都命中"的表达式,时刻由冻结的时钟来控制(见 `withClock`)。
  const EVERY_MINUTE = "* * * * *";

  {
    resetRuns();
    const wf = nextId();
    const nodeId = "t_sched";
    makeAutomation({
      workflowId: wf,
      nodeId,
      params: {
        [NODE_TRIGGER_KIND_PARAM_KEY]: "schedule",
        [NODE_TRIGGER_CRON_PARAM_KEY]: EVERY_MINUTE,
        task: "到点了跑一次",
      },
    });

    const runner = await startRunner();
    const minute = 1_000_000; // 冻结的那一分钟(毫秒 = minute * 60_000)
    const at = minute * 60_000;

    // **同一分钟内 tick 两次** —— ticker 30 秒一跳,同一分钟真的会被看两次(见 TICK_MS
    // 的注释)。不去重的话「每分钟一次」会变成一分钟两次。
    withClock(at, () => runner.onTick());
    withClock(at + 20_000, () => runner.onTick());

    eq("同一分钟 tick 两次,只起一次运行", runsOfNode(nodeId).length, 1);
    eq("第一次那一跳真的起跑了(不是闸门关过头)", runs.length, 1);
    eq("载荷是「到点了」那一种", runs[0]?.entry?.payload?.kind, "schedule");
    eq("去重记忆落在盘上(不是进程里的 Map)", onDisk()[`${wf}:${nodeId}`], minute);

    // 下一分钟照常跑(去重只管"刚跑过的那一分钟"那一格)。
    withClock((minute + 1) * 60_000, () => runner.onTick());
    eq("下一分钟照跑", runsOfNode(nodeId).length, 2);
    eq("盘上那一格跟着翻到新的一分钟", onDisk()[`${wf}:${nodeId}`], minute + 1);

    runner.dispose();

    /* ── 重启:新建一个实例(进程重开),同一分钟**不再**触发 ── */

    const revived = await startRunner();
    const restartMinute = 2_000_000;
    const restartAt = restartMinute * 60_000;
    // 先在新实例的正常时钟下补一次「这一分钟跑过」——用冻结时钟把它钉在 restartMinute。
    withClock(restartAt, () => revived.onTick());
    const beforeRestart2 = runsOfNode(nodeId).length;
    eq("重启前:这一分钟跑过一次", beforeRestart2, 3);
    revived.dispose();

    // **再起一个进程**(磁盘上那张表就是唯一的记忆)。这一跳若还是"本分钟没见过",
    // 就会多起一次运行 —— 那正是"每次开应用那个每分钟的自动化多跑一次"的症状。
    const second = await startRunner();
    withClock(restartAt + 10_000, () => second.onTick());
    eq("重启之后同一分钟不再触发", runsOfNode(nodeId).length, 3);
    second.dispose();
  }

  /* ── ①b 上限:超过 60 条时滚掉最老的,而且**内存里也看不到** ── */

  {
    resetRuns();

    // 先把盘上那张表清空 —— 也把内存清空(`startRunner` 从盘上读回)。前面场景留下的
    // 那几条 key 分钟序号大得多,不清的话"滚掉的是哪几条"就由它们决定了;这一节要的是
    // **我塞进去的 65 条**这个确定的形状。
    SettingRepo.set(LAST_MINUTE_KEY, "{}");

    // 真挂一条定时自动化:下面要验的不只是"表里有几条",而是**被滚掉的那条还起不起得来**
    // —— 那需要一个真在 `all()` 里、cron 命中的触发器。
    const wf = "wf_trim";
    const nodeId = "t1";
    makeAutomation({
      workflowId: wf,
      nodeId,
      params: {
        [NODE_TRIGGER_KIND_PARAM_KEY]: "schedule",
        [NODE_TRIGGER_CRON_PARAM_KEY]: EVERY_MINUTE,
        task: "被滚掉之后还该能跑",
      },
    });

    // 这一节要直接调私有的写入口(上限是 60 条,建 61 条自动化再各跑一遍太绕)。
    interface WithWrite {
      lastMinute: Map<string, number>;
      rememberLastMinute(key: string, minute: number | null): void;
    }
    const runner = (await startRunner()) as unknown as RunnerInternals & WithWrite;
    eq("起手读回的是空表(盘上那份刚清过)", runner.lastMinute.size, 0);

    // 65 条,分钟序号递增 —— 越晚跑的越新。抬到 5_000_000 之上:前面场景留下的序号到
    // 2_000_010 为止,这样"谁被滚掉"只由这一节决定。
    const base = 5_000_000;
    for (let i = 1; i <= 65; i += 1) runner.rememberLastMinute(`wf_trim:t${i}`, base + i);

    eq("盘上留的是上限条数", Object.keys(onDisk()).length, 60);
    eq("内存里也只剩 60 条(不是盘上少了、内存还留着)", runner.lastMinute.size, 60);
    // **被滚掉的是最久没跑过的那几条**(分钟序号最小的那五条)。
    check(
      "滚掉的是最久没跑过的那几条",
      !runner.lastMinute.has("wf_trim:t1") &&
        !runner.lastMinute.has("wf_trim:t5") &&
        runner.lastMinute.has("wf_trim:t6") &&
        runner.lastMinute.has("wf_trim:t65"),
      [...runner.lastMinute.keys()].slice(0, 3),
    );
    check(
      "最新那一条还在(去重靠它)",
      onDisk()["wf_trim:t65"] === base + 65,
      onDisk()["wf_trim:t65"],
    );

    // ⚠️ **这一条是那个 bug 的形状,而且必须是"跑起来看得见"的那一种。**
    //
    // 被滚掉的 key 若只在盘上消失、内存里还挡着,下一次**同分钟**的那一条就会被它吞掉
    // (判去重读的是内存那一份 `this.lastMinute.get(key)`,见 `onTick`)—— 症状是明明
    // 在跑着的定时自动化**再也不响**。所以判据不能写成"表里还在不在那个 key":那样
    // `rememberLastMinute` 里那句无条件 `set` 会替它挡过去(写什么都过,断言是假的),
    // 必须**真的 tick 一下,看那一分钟还起不起来**。
    withClock((base + 1) * 60_000, () => runner.onTick());
    eq("被滚掉的 key 真的不在内存里了(同一个分钟还能再跑起来)", runsOfNode(nodeId).length, 1);
    runner.dispose();
  }

  /* ── ①c 盘上的表坏了不抛,按「什么都没记」处理 ── */

  {
    // 与 `SettingRepo` 那边的降级口径一致(见 `loadWatchTemplates`:setting 是用户数据,
    // 可能被手改坏 —— 坏的丢掉、按空处理,不让整个面板挂掉)。这里的口径是
    // `readLastMinutes`:读不回来当空表,退化成"重启后可能多跑一次"。
    resetRuns();
    const wf = nextId();
    const nodeId = "t_badjson";
    makeAutomation({
      workflowId: wf,
      nodeId,
      params: {
        [NODE_TRIGGER_KIND_PARAM_KEY]: "schedule",
        [NODE_TRIGGER_CRON_PARAM_KEY]: EVERY_MINUTE,
        task: "坏表也要能起",
      },
    });

    // ① 不是合法 JSON。
    SettingRepo.set(LAST_MINUTE_KEY, "{ 这不是 json");

    // ⚠️ **`start()` 必须包起来**:这一句验的正是"坏表不该把 `start()` 炸掉"。不包的话,
    // 实现一旦退回"直接抛",整个冒烟文件会以一个未捕获的 `SyntaxError` 结束(退出码 1,
    // 一条 FAIL 都打不出来)—— 那种形状看不出是哪条断言在红,也就谈不上"确认红"。包成
    // 一个可判的失败,红的时候才有 `FAIL 坏 JSON:不当成抛错…` 这一行。
    const bad = await startRunner().then(
      (r) => ({ runner: r, error: null as string | null }),
      (err: unknown) => ({ runner: null, error: (err as Error).message }),
    );
    check(
      "坏 JSON:不当成抛错(表读不回来就按空的走)",
      bad.error === null,
      bad.error ?? "没抛",
    );
    if (bad.runner !== null) {
      const r1 = bad.runner;
      eq("坏 JSON:当空表(这条触发器照挂上)", r1.lastMinute.size, 0);
      const at = 3_000_000 * 60_000;
      withClock(at, () => r1.onTick());
      eq(
        "坏 JSON 之后照常触发(退化成「重启后可能多跑一次」,但不静默停摆)",
        runsOfNode(nodeId).length,
        1,
      );
      r1.dispose();
    } else {
      // 抛了就没法接着往后验 —— 把后面两条也各记一条红,免得"少跑了"看起来像"没红"。
      check("坏 JSON:当空表(这条触发器照挂上)", false, "start() 抛了,拿不到实例");
      check("坏 JSON 之后照常触发(退化成「重启后可能多跑一次」,但不静默停摆)", false, "同上");
    }

    // ② 是合法 JSON,但形状不对(数组 / 值是字符串 / 值是 NaN)。
    for (const [what, bad] of [
      ["数组", "[1,2,3]"],
      ["值是字符串", '{"a":"100"}'],
      ["值是 null", '{"a":null}'],
      ["是一个字符串", '"nope"'],
    ] as const) {
      SettingRepo.set(LAST_MINUTE_KEY, bad);
      const r = await startRunner();
      eq(`坏形状(${what}):当空表,不抛`, r.lastMinute.size, 0);
      r.dispose();
    }

    // ③ 对照:一份**形状对**的表照常读回来(别把降级写成"一律丢")。
    SettingRepo.set(LAST_MINUTE_KEY, JSON.stringify({ "wf_ok:t": 42 }));
    const r3 = await startRunner();
    eq("形状对的表照常读回来", r3.lastMinute.get("wf_ok:t"), 42);
    r3.dispose();
  }

  /* ── ② 文件:事件到达时路径已经不在了 → 不攒 ── */

  {
    resetRuns();
    const wf = nextId();
    const nodeId = "t_filedel";
    makeAutomation({
      workflowId: wf,
      nodeId,
      params: {
        [NODE_TRIGGER_KIND_PARAM_KEY]: "file",
        [NODE_TRIGGER_PATHS_PARAM_KEY]: "*.md",
        // 合并窗口压到最小,免得断言要等两秒。
        [NODE_TRIGGER_DEBOUNCE_PARAM_KEY]: 0,
        task: "有文件变了就看看",
      },
    });

    const runner = await startRunner();
    const pendingKey = `${wf}:${nodeId}`;

    // `fs.watch` 的 `rename` 对**删除**也是 `"rename"`(判不了方向),于是删掉的路径
    // 从前照样进载荷 —— 模型拿着它去读,得到"文件不存在",而它本该去办这一批里别的
    // 文件(**悄悄少办一件事**)。
    const gone = join(PROJ_DIR, "already-deleted.md");
    rmSync(gone, { force: true });
    runner.onFsChange(PROJ_DIR, "already-deleted.md");
    eq("事件到达时已经不在的路径:不攒", runner.pendingFires.get(pendingKey)?.files.length ?? 0, 0);

    // ⚠️ 等到**真的越过那两个窗口**再断言"没攒" —— 只等几十毫秒的话,这条断言在
    // "还没来得及攒"时也会通过,那它证明不了任何事。窗口 = `WATCH_SETTLE_MS`(300)
    // + 这条触发器的 `debounceMs`(这里写 0)。
    await sleep(FLUSH_SLACK_MS);
    eq("而且不会攒出一次空载荷的运行", runsOfNode(nodeId).length, 0);

    // 对照:真新建的文件照常攒(别把闸门关过头)。
    const real = join(PROJ_DIR, "brand-new.md");
    writeFileSync(real, "# 新写的");
    runner.onFsChange(PROJ_DIR, "brand-new.md");
    eq("真新建的文件照常攒", runner.pendingFires.get(pendingKey)?.files.length ?? 0, 1);
    check("攒的是它的绝对路径", runner.pendingFires.get(pendingKey)?.files[0] === real, runner.pendingFires.get(pendingKey)?.files);

    await sleep(FLUSH_SLACK_MS);
    eq("照常起一次运行", runsOfNode(nodeId).length, 1);
    check(
      "载荷里交给模型的就是那个真文件",
      (runsOfNode(nodeId)[0]?.entry?.payload?.files as string[] | undefined)?.includes(real) === true,
      runsOfNode(nodeId)[0]?.entry?.payload,
    );

    /* ── ②b 攒着的那几秒里被删掉 → flush 时不交给模型 ── */

    // 事件到达时文件在(所以攒下了),但**还没到 flush** 就被删了 —— 那一段由
    // `rearm` 里的 `existingFilesOf` 管(两边管的是不同的缝,见 `automationRunner`
    // 那段注释)。这里把合并窗口放长,好在那中间把文件删掉。
    const wf2 = nextId();
    const nodeId2 = "t_flushdel";
    makeAutomation({
      workflowId: wf2,
      nodeId: nodeId2,
      params: {
        [NODE_TRIGGER_KIND_PARAM_KEY]: "file",
        [NODE_TRIGGER_PATHS_PARAM_KEY]: "*.md",
        [NODE_TRIGGER_DEBOUNCE_PARAM_KEY]: 400,
        task: "攒着的这批",
      },
    });
    await runner.reloadAll();

    const doomed = join(PROJ_DIR, "vanishes-later.md");
    writeFileSync(doomed, "# 待会儿就没了");
    runner.onFsChange(PROJ_DIR, "vanishes-later.md");
    eq("到达时它还在,所以攒下了", runner.pendingFires.get(`${wf2}:${nodeId2}`)?.files.length ?? 0, 1);

    // 攒着的那几秒里它被删了(`WATCH_SETTLE_MS` + `debounceMs` 都还没到)。
    rmSync(doomed, { force: true });
    await sleep(700); // 越过 300(settle)+ 400(debounce)

    const fired = runsOfNode(nodeId2);
    eq("flush 时不再把它交给模型", (fired[0]?.entry?.payload?.files as string[] | undefined)?.length ?? -1, 0);
    check(
      "那一次运行照跑,只是载荷里没有它(取舍见注释:不因此取消整批)",
      fired.length === 1 && !JSON.stringify(fired[0]?.entry?.payload ?? {}).includes("vanishes-later"),
      fired[0]?.entry?.payload,
    );

    runner.dispose();
  }

  /* ── 收尾:这一节的实例都 dispose 了,别让 timer / watcher 挂着 ── */
}

/* ────────────────────────── 收尾 ────────────────────────── */
console.log(`\nautomation-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exit(1);
