import { withAutomationOrigin } from "@main/orchestration/automationEventOrigin.js";
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
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseCron, cronMatches, type CronSpec } from "@contracts/cron";
import { HOOK_EVENT_OF, eventItemFactKeysOf, eventItemFactsOf, matchesAnyGlob, addToFileBacklog, capOldest, shouldIgnoreWatchPath, isSpecificGlob, classifyFileChange, reconcileFileChangeKind, isWithinWatchRoot, type HookEvent } from "@contracts/hook";
import { enqueueEventEnvelope, settleEventEnvelope, isPendingEnvelope, envelopeTerminal, digestOfPayload } from "@contracts/durableEvent";
import { latestFailureOf, missedNoticeOf } from "@contracts/ipc";
import {
  parseTriggerSpec,
  DEFAULT_TRIGGER_DEBOUNCE_MS,
  NODE_TRIGGER_CRON_PARAM_KEY,
  NODE_TRIGGER_DEBOUNCE_PARAM_KEY,
  NODE_TRIGGER_ENABLED_PARAM_KEY,
  NODE_TRIGGER_EXCLUDE_PATHS_PARAM_KEY,
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
  missedMinutesSince,
  MISSED_SCAN_LIMIT_MINUTES,
  shouldFireThisMinute,
  triggerSeedOf,
  triggerSpecKeyOf,
  watcherDirsOf,
} from "@main/orchestration/automationStatus.js";
import { deriveTrigger, getWorkflow, removeWorkflow, saveWorkflow } from "@main/orchestration/library.js";
import { approveWorkflowRevision, requireWorkflowReview, workflowRevision } from "@main/orchestration/workflowTrust.js";
import type { AutomationFactsSeed } from "@main/orchestration/automationStatus.js";
import { builtinTriggerManifest } from "@main/orchestration/nodeTypes.js";
import {
  WATCH_WORKFLOW_ID,
  WATCH_TRIGGER_NODE_ID,
  getBuiltinWorkflow,
} from "@main/orchestration/builtins.js";

/**
 * 被摘出去的两条自动化(`wf_auto_download` / `wf_auto_convert`)现在住在
 * `resources/presets/workflows.json` —— release 不内置,用户按需导入。这一套仍然要
 * 盯它们图上的东西(脚本正文、边、触发器),所以从那份预置文件读。
 *
 * ⚠️ 读的是**仓库里的预置** —— 摘出去**不等于内容消失**,只是不再随安装包走。这条
 * 路径变了(比如以后预置挪窝),读不到会抛,不会静默跳过一整套断言。
 */
const PRESET_WORKFLOWS: WorkflowDoc[] = (
  JSON.parse(readFileSync(join(process.cwd(), "resources", "presets", "workflows.json"), "utf8")) as {
    workflows: WorkflowDoc[];
  }
).workflows;
const presetById = (id: string): WorkflowDoc | undefined => PRESET_WORKFLOWS.find((w) => w.id === id);
const AUTO_DOWNLOAD_WORKFLOW_ID = "wf_auto_download";
const AUTO_CONVERT_WORKFLOW_ID = "wf_auto_convert";
import { runWorkflow, type RunPorts, type RunReport, type RunState } from "@main/orchestration/scheduler.js";

import {
  claimStatusOfRunOutcome,
  isTerminalClaimStatus,
  isTriggerClaims,
  pendingClaims,
  pruneClaims,
  runOutcomeOfStatus,
  scheduleClaimId,
  triggerKeyOfClaim,
  type TriggerClaim,
} from "@main/orchestration/triggerClaim.js";
import { initDb, getDb } from "@main/store/db.js";
import { CollectionRepo, LibraryRepo, ProjectRepo, SessionRepo, SettingRepo, WorkflowRepo, SYSTEM_AUTOMATION_PROJECT_ID } from "@main/store/repositories.js";
import { resetSuppressCacheForTest, saveSuppress } from "@main/library/suppress.js";
import { suppressNodeKey } from "@contracts/libraryTypes";
// ⚠️ **执行器本体**(`automationRunner.ts`)不是纯件:它真开 `fs.watch`、真起会话、
// 真读 settings 表。这一套的后半段(见第 13 节)直接 `new` 它来验「重启后同一分钟不
// 再触发」与「删掉的文件不进载荷」——那两条的实现全在实例状态里,不真跑一遍验不到。
import { automationRunner } from "@main/orchestration/automationRunner.js";
import {
  InMemoryExecutorOwnershipStore,
  ExecutorOwnershipRegistry,
} from "@main/workflowEngines/executorOwnership.js";
import { resetRuns, runs, runsOfNode, setRunBusy, setRunStatusForNode } from "./stubs/runner.js";
import { failNextExclusiveCreate, disarmExclusiveCreate } from "./stubs/fsSync.js";
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

// A second Node process reopens the same isolated database. No in-memory
// runner/counter state survives from the main suite into this branch.
if (process.argv.includes("--verify-self-budget")) {
  await initDb();
  const workflowId = SettingRepo.get("smoke.selfTriggerWorkflow");
  if (workflowId === null) throw new Error("Missing self-budget restart fixture");
  const key = `automation.selfTriggerCount.${workflowId}`;
  const nodeId = "t_self_busy_data";
  const session = SessionRepo.findAutomationByWorkflow(workflowId);
  if (session === undefined) throw new Error("Missing self-budget session");
  eq("新进程从磁盘读回已耗尽的额度", SettingRepo.get(key), "10");
  await automationRunner.start();
  check("新进程在收到事件之前就显示保存的暂停原因", automationRunner.statusOf(workflowId)[0]?.lastError?.includes("手动") === true);
  const crossRaw = SettingRepo.get("smoke.crossWorkflowChain");
  if (crossRaw === null) throw new Error("Missing cross-workflow restart fixture");
  const cross = JSON.parse(crossRaw) as { workflowId: string; sessionId: string; nodeId: string };
  runtimeManager.emit({ type: "library.item.downloaded", sessionId: cross.sessionId, itemId: "restart-cross", title: "restart-cross", pdfPath: "restart-cross.pdf" } as unknown as RuntimeEvent);
  await new Promise((r) => setTimeout(r, 50));
  eq("新进程恢复跨工作流来源链并阻止已耗尽的回环", runsOfNode(cross.nodeId).length, 0);
  check("新进程跨图回环停止原因可见", automationRunner.statusOf(cross.workflowId)[0]?.lastError?.includes("手动") === true);
  resetRuns();
  const emit = (): void => runtimeManager.emit({ type: "library.item.downloaded", sessionId: session.id, itemId: "restart-self", title: "restart-self", pdfPath: "restart-self.pdf" } as unknown as RuntimeEvent);
  try {
    emit(); await new Promise((r) => setTimeout(r, 50));
    eq("新进程不会因自身事件重新获得十轮额度", runsOfNode(nodeId).length, 0);
    check("新进程阻止时也显示手动恢复原因", automationRunner.statusOf(workflowId)[0]?.lastError?.includes("手动") === true);
    eq("新进程中用户仍可手动恢复", (await automationRunner.runNow(workflowId, nodeId)).ok, true);
    eq("新进程手动恢复后额度归零", SettingRepo.get(key), "0");
    emit(); await new Promise((r) => setTimeout(r, 50));
    eq("新进程恢复后允许自触发一轮", runsOfNode(nodeId).length, 2);
    eq("新进程恢复后重新从一计数", SettingRepo.get(key), "1");
  } finally { automationRunner.dispose(); }
  await new Promise<void>((resolve) => setImmediate(resolve));
  console.log(`self-budget-restart:${total - failures}/${total} 通过`);
  process.exit(failures > 0 ? 1 : 0);
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
  const fileWithExcludes = parseTriggerSpec(TRIGGER, {
    ...base,
    triggerKind: "file",
    paths: "*.md",
    [NODE_TRIGGER_EXCLUDE_PATHS_PARAM_KEY]: "generated/**, dist/**",
  });
  check(
    "文件变化可选排除 glob 会被解析并保留",
    fileWithExcludes.ok && fileWithExcludes.spec.kind === "file" &&
      fileWithExcludes.spec.excludeGlobs.join("|") === "generated/**|dist/**",
    fileWithExcludes,
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
      items: [{ itemId: "lib_1", itemTitle: "注意力就是全部", pdfPath: "pdf/ab/cd.pdf" }],
    }),
    "发生了「library.item.downloaded」。\n条目:注意力就是全部(id=lib_1)\nPDF(库内相对路径):pdf/ab/cd.pdf",
  );
  // **合并窗口里进来的几条全都要办。** 下载是并发的,两篇同时下完就落在同一个窗口 ——
  // 只列一条的话,另一篇永远没人转,而且不报错。
  eq(
    "事件(带条目:两条一起下来)",
    describeTriggerPayload({
      kind: "event",
      event: "library.item.downloaded",
      items: [
        { itemId: "lib_1", itemTitle: "第一篇", pdfPath: "pdf/a.pdf" },
        { itemId: "lib_2", itemTitle: "第二篇", pdfPath: "pdf/b.pdf" },
      ],
    }),
    [
      "发生了「library.item.downloaded」。",
      "一共有 2 条,这次都要办:",
      "条目1:第一篇(id=lib_1)",
      "PDF(库内相对路径):pdf/a.pdf",
      "条目2:第二篇(id=lib_2)",
      "PDF(库内相对路径):pdf/b.pdf",
    ].join("\n"),
  );
  // 导入那一下**文件还没下来**,所以没有 `pdfPath` 这一行 —— 有的话就是在骗模型。
  eq(
    "事件(带条目:只有导入)",
    describeTriggerPayload({
      kind: "event",
      event: "library.item.imported",
      items: [{ itemId: "lib_2", itemTitle: "随手记" }],
    }),
    "发生了「library.item.imported」。\n条目:随手记(id=lib_2)",
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
    items: [{ itemId: "lib_1", itemTitle: "标题", pdfPath: "pdf/a.pdf" }],
  });
  eq("事件:条目那几项拍平在顶层(不是嵌一层 item)", itemFacts.itemId, "lib_1");
  check(
    "事件:四项都在顶层",
    itemFacts.itemTitle === "标题" && itemFacts.pdfPath === "pdf/a.pdf",
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
    items: [{ itemId: "lib_1", itemTitle: "标题", pdfPath: "pdf/a.pdf" }],
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
  check("下载完成:列 itemId/itemTitle/pdfPath", ["itemId", "itemTitle", "pdfPath"].every((k) => dl.includes(k)), dl);
  check("下载完成:也留着事件自己那几项", dl.includes("event"), dl);

  const imp = evt("library.item.imported");
  check("导入:列 itemId/itemTitle", ["itemId", "itemTitle"].every((k) => imp.includes(k)), imp);
  // ⚠️ **导入那条不该列 `pdfPath`** —— 导入那一下文件还没下来,`eventItemFactsOf` 从
  // `LibraryItemImportedEvent` 里取不到它(那个接口压根没有这个字段)。
  check("导入:不列 pdfPath(那一刻文件还没下来)", !imp.includes("pdfPath"), imp);

  // 听 `turn.done` 这种不带条目的 —— 一项都不该列,否则插进指令必炸。
  const done = evt("turn.done");
  check("一轮结束:不列任何条目事实", !done.some((k) => ["itemId", "itemTitle", "pdfPath"].includes(k)), done);

  // 听多个事件时取**交集**:哪条响是运行时的事,指令只能写"哪条响都取得到"的。
  const both = evt("library.item.imported,library.item.downloaded");
  check("导入+下载:交集 = 只共有的那几项", ["itemId", "itemTitle"].every((k) => both.includes(k)) && !both.includes("pdfPath"), both);

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
  // 事件上条目就叫 `title`(不是 `itemTitle`)—— 换掉这个字段名,下面必红。
  const imported: RuntimeEvent = {
    type: "library.item.imported",
    sessionId: "(system)",
    itemId: "lib_1",
    title: "导入的那一篇",
  } as unknown as RuntimeEvent;
  const importedFacts = eventItemFactsOf(imported);
  eq("导入:id 从 itemId 取得", importedFacts?.itemId, "lib_1");
  eq("导入:标题从 title 取得(不是 itemTitle)", importedFacts?.itemTitle, "导入的那一篇");
  check("导入:没有 pdfPath 这一项", importedFacts?.pdfPath === undefined, importedFacts);

  const downloaded: RuntimeEvent = {
    type: "library.item.downloaded",
    sessionId: "(system)",
    itemId: "lib_2",
    title: "下完的那一篇",
    pdfPath: "papers/ab/abcdef.pdf",
  } as unknown as RuntimeEvent;
  const dlFacts = eventItemFactsOf(downloaded);
  eq("下载:三项全取到", JSON.stringify(dlFacts), JSON.stringify({
    itemId: "lib_2",
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
  const item1 = { itemId: "lib_1", itemTitle: "第一篇" };
  const item2 = { itemId: "lib_2", itemTitle: "第二篇" };

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

console.log("\n【MC-091】合并窗口的事件条目有容量上限(不再只涨不落)");
{
  /* 从前 `mergeEventPayload` 只 push 不设上限 —— 一条持续吐**不同** itemId 的事件流会让
   * `items` 只涨不落(台账实测 1500 个唯一 itemId → 保留 1500),而这份载荷要整个进
   * `data.trigger` 与运行历史。这里灌 250 个唯一 itemId,断言:条目停在 100 的上限、
   * 丢的 150 条**如实记进 `itemsOverflowDropped`**、并**兑现到人话与载荷事实**里。 */
  const MAX = 100;
  const TOTAL = 250;
  let payload = mergeEventPayload(undefined, "library.item.downloaded", {}, { itemId: "seed" });
  for (let i = 0; i < TOTAL; i += 1) {
    payload = mergeEventPayload(payload, "library.item.downloaded", {}, { itemId: `lib_${i}`, itemTitle: `第 ${i} 篇` });
  }
  // seed + TOTAL 条 = TOTAL+1;上限 100 → 丢 TOTAL+1-100 = 151。
  const dropped = TOTAL + 1 - MAX;
  eq("★ 条目数停在上限(不再只涨不落)", payload.kind === "event" ? payload.items?.length : -1, MAX);
  eq("★ 丢的条数如实记在 itemsOverflowDropped", payload.kind === "event" ? payload.itemsOverflowDropped : -1, dropped);
  check(
    "★ 留下的是**最近**那批(丢的是最早的)",
    payload.kind === "event" && payload.items?.[payload.items.length - 1]?.itemId === `lib_${TOTAL - 1}`,
    payload.kind === "event" ? payload.items?.slice(-2) : payload,
  );
  // 去重仍在:重复最后那条唯一 itemId 不增加条目、也不增加丢弃计数。
  const dupLast = mergeEventPayload(payload, "library.item.downloaded", {}, { itemId: `lib_${TOTAL - 1}` });
  eq("重复的那条不增加条目(去重仍生效)", dupLast.kind === "event" ? dupLast.items?.length : -1, MAX);
  eq("重复不虚增丢弃计数", dupLast.kind === "event" ? dupLast.itemsOverflowDropped : -1, dropped);
  // 人话里明说"不是全部"。
  const said = describeTriggerPayload(payload);
  check("人话里明说还有多少条没带上", said.includes(`${dropped} 条`) && said.includes("不是全部"), said.slice(-120));
  // 载荷事实带给代码节点。
  const facts = payloadFactsOf(payload);
  eq("★ 载荷事实里带上 itemsOverflowDropped", facts.itemsOverflowDropped, dropped);
  // 没丢时不带这个键(同 overflowDropped/itemCount 口径)。
  const small = mergeEventPayload(undefined, "library.item.downloaded", {}, { itemId: "only" });
  check("没截断时不带 itemsOverflowDropped 键", small.kind === "event" && small.itemsOverflowDropped === undefined, small);
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

/* ────────────── 11a-2b. 错过的定时:不补跑,但必须看得见 ────────────── */

console.log("\nmissedMinutesSince · 关机那几天本该响几次");

{
  // 「每天九点」。用一个只认小时分钟的假 matcher —— 这几条要钉的是**数数那段**
  // (窗口两头怎么取、没有基准时怎么办、回看封多久),不是 cron 解析(那边自己有测)。
  const nineAm = (at: Date): boolean => at.getHours() === 9 && at.getMinutes() === 0;
  const minuteOf = (iso: string): number => Math.floor(new Date(iso).getTime() / 60_000);

  eq(
    "从来没跑过 = 一次都不数(没有基准时凭空说「错过了」只会吓人)",
    missedMinutesSince(undefined, minuteOf("2026-03-05T10:00:00"), nineAm).count,
    0,
  );

  // 3 月 1 日九点跑过,现在是 3 月 5 日十点 → 2、3、4、5 日那四个九点都错过了。
  const four = missedMinutesSince(
    minuteOf("2026-03-01T09:00:00"),
    minuteOf("2026-03-05T10:00:00"),
    nineAm,
  );
  eq("关机四天 = 错过四次", four.count, 4);
  eq("最近那一次就是 3 月 5 日九点", four.lastAt, minuteOf("2026-03-05T09:00:00") * 60_000);

  // 两头都不数:起点那一分钟自己跑过了,终点那一分钟归 `onTick` 管(它马上会看到)。
  eq(
    "起点那一分钟不重复计(它自己跑过了)",
    missedMinutesSince(minuteOf("2026-03-01T09:00:00"), minuteOf("2026-03-01T09:01:00"), nineAm).count,
    0,
  );
  eq(
    "当前这一分钟不算错过(onTick 马上就会看它)",
    missedMinutesSince(minuteOf("2026-03-01T08:00:00"), minuteOf("2026-03-01T09:00:00"), nineAm).count,
    0,
  );

  // 回看封顶:一台搁置半年的机器不该逐分钟扫二十多万次,而「错过 180 次」和
  // 「错过 4000 次」对用户是同一句话。
  const everyMinute = (): boolean => true;
  const now = minuteOf("2026-03-05T10:00:00");
  eq(
    "回看窗口封在 7 天",
    missedMinutesSince(now - 400_000, now, everyMinute).count,
    MISSED_SCAN_LIMIT_MINUTES,
  );
}

console.log("\nrecordMissed · 只记账,不碰挂载侧,跑成一次就清零");

{
  const facts = new AutomationFacts();
  const seed: AutomationFactsSeed = {
    workflowId: "wf_missed",
    nodeId: "T",
    title: "每天九点",
    kind: "schedule",
    enabled: true,
  };
  // 挂载侧先坏着 —— 下面要验它不被这一笔改写。
  facts.recordSetup(seed, false, "项目不在了");
  const row = (): ReturnType<typeof facts.ofWorkflow>[number] => facts.ofWorkflow("wf_missed")[0];

  facts.recordMissed(seed, 3, 1_000);
  eq("错过三次记下来了", row()?.missedCount, 3);
  eq("界面该显示这个数", missedNoticeOf(row()), 3);
  // **错过不是坏了**:它挂得好好的(或坏着),这一笔一个字都不该改挂载侧。
  eq("不碰 armed", row()?.armed, false);
  eq("不碰 detail(那句话是挂载侧的)", row()?.detail, "项目不在了");
  eq("也不冒充一次失败", row()?.lastError, undefined);

  // 醒一次数一段 —— 累加,不是覆盖。
  facts.recordMissed(seed, 2, 2_000);
  eq("再睡一觉醒来是累加", row()?.missedCount, 5);

  // 真的跑成一次 → 这笔账翻篇(它说的是「自上一次成功以来」)。
  facts.recordFired(seed, 3_000);
  eq("跑成之后清零", row()?.missedCount, undefined);
  eq("界面上那行也跟着消失", missedNoticeOf(row()), 0);

  // 0 次不留痕(sweep 每次都会调,没错过的时候不该在事实表里留一个 0)。
  const quiet = new AutomationFacts();
  quiet.recordSetup({ ...seed, workflowId: "wf_quiet" }, true);
  quiet.recordMissed({ ...seed, workflowId: "wf_quiet" }, 0, 1_000);
  eq("一次都没错过时不写任何东西", quiet.ofWorkflow("wf_quiet")[0]?.missedCount, undefined);

  // 第二道保险:事实是从 IPC 过来的外部数据,跑得比错过更近时那行就不该再显示。
  eq(
    "跑得更近时不显示(哪怕计数还在)",
    missedNoticeOf({
      key: "k", workflowId: "w", nodeId: "n", title: "t", kind: "schedule",
      armed: true, missedCount: 4, lastMissedAt: 1_000, lastFireAt: 2_000,
    }),
    0,
  );
}

/* ────────────────── 11a-3. 改了配置,攒着的那一次不该按旧条件跑 ────────────────── */

console.log("\ntriggerSpecKeyOf · 攒着的触发要认得出「这条配置已经改了」");

{
  // `pendingFires` 里可能攒着一次还没到点的触发(合并窗口最长几秒),而用户完全可能
  // 在这几秒里改了触发方式并存盘。`apply()` 只丢掉"触发器没了"的那些 —— 改了 glob /
  // 改了事件名的**不会**被丢掉,于是几秒后它按**旧条件**起一次运行(旧条件正是用户
  // 刚改掉的东西)。签名就是拿来认这个的。

  const fileSpec = (globs: string[], debounceMs = DEFAULT_TRIGGER_DEBOUNCE_MS): Extract<TriggerSpec, { kind: "file" }> => ({
    kind: "file",
    globs,
    excludeGlobs: [],
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
  check(
    "改了排除 glob 签名也变",
    triggerSpecKeyOf({ ...fileSpec(["src/*.ts"]), excludeGlobs: ["generated/**"] }) !== key,
  );

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
  //
  // 这两条自动化**已从内置摘出**(2026-10-10,release 不内置、用户按需导入),所以
  // 从**预置文件**读 —— 内容没消失,只是换了住处。判据不变:预置里的图必须过存盘那一关。
  for (const [id, what] of [
    [AUTO_DOWNLOAD_WORKFLOW_ID, "导入后取原文"],
    [AUTO_CONVERT_WORKFLOW_ID, "下载完自动转 Markdown"],
  ] as const) {
    const doc = presetById(id);
    check(`预置工作流「${what}」还在 presets/workflows.json 里`, doc !== undefined, id);
    if (!doc) continue;
    // `deriveTrigger` 就是**存盘那一关**跑的那个函数 —— 它拒了就说明这份预置图在界面上
    // 一存就报错;它过了才谈得上"能跑"。
    const derived = deriveTrigger(doc, types);
    check(`「${what}」的触发器解得开`, derived.ok, derived.ok ? undefined : derived.error);
    if (!derived.ok) continue;
    // 触发器节点在 → `trigger` 字段必须被反推出来(反推不出来 = 它在列表里会被分错栏)。
    eq(`「${what}」的 trigger 字段反推出来了`, derived.doc.trigger !== undefined, true);
  }

  check("内置工作流「守望」还在", getBuiltinWorkflow(WATCH_WORKFLOW_ID) !== undefined);

  // 本地导入与后续下载都由配置的自动化接手；无本地文件的占位项由脚本跳过。
  const convertDoc = presetById(AUTO_CONVERT_WORKFLOW_ID);
  const convertTrigger = convertDoc?.nodes.find((n) => n.type === "mcode.trigger");
  const events = String(convertTrigger?.params[NODE_TRIGGER_EVENTS_PARAM_KEY] ?? "");
  eq("在线转录监听文件导入与下载完成", events, "library.item.imported,library.item.downloaded");
  check("在线转录的触发器默认开着(自动转录靠它)", triggerEnabledOf(convertTrigger?.params ?? {}), convertTrigger?.params);
  // 「文献导入」**只手动跑**(2026-09-30):正门是右键表单(`runWithTarget` 不看开关),
  // 开着的话每导入一个文件就空跑一次 —— 连它自己收进库的文件也会再叫醒它。
  const importTrigger = presetById(AUTO_DOWNLOAD_WORKFLOW_ID)?.nodes.find((n) => n.type === "mcode.trigger");
  eq("「文献导入」的触发器默认关着(不监听导入事件)", importTrigger?.params[NODE_TRIGGER_ENABLED_PARAM_KEY], false);
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

/* ────────── 12a. 转录那条自动化的**两段结构**(2026-09-28)────────── */

// 「下载完自动转 Markdown」从「一条指令让模型自己挑工具」改成了**固定的两步**:
//
//     触发 → code 节点(调 MinerU 的在线 API,并报出要挂回哪几条)
//
// 为什么不能只留一条指令:转录是**确定性**的事,而"模型会选对工具"不是 —— 它可能挑
// 本地 `library_convert`(扫描件抽不出正文)、可能挑一个不存在的工具、可能干脆跳过。
// 用户要的是"下完就转",那不该经过一次判断。
//
// **挂回那一步的子代理 2026-09-28 去掉了**:同样的理由 —— 「把这份 md 挂到那个条目上」
// 也是确定性的事,让模型来做只会漏挂、挂错、还费钱,而漏挂不报错。现在脚本在
// `outputs.adoptMarkdown` 里报「这几条要挂回」,由**主进程**调 `adoptMarkdownFile`
// (见 `orchestration/adoptFromCode.ts`)—— 写库仍然只发生在主进程,因为库的底是
// sql.js,子进程写 `mcode.db` 会把整个库覆盖掉。
console.log("\n「下载完自动转 Markdown」· 触发 → code(MinerU + 报出挂回)");

{
  const doc = presetById(AUTO_CONVERT_WORKFLOW_ID);
  const codeNode = doc?.nodes.find((n) => n.type === "mcode.code");
  const agentNode = doc?.nodes.find((n) => n.type === "mcode.agent");

  check("★ 中间那一步是 code 节点(不是又一条指令)", codeNode !== undefined, doc?.nodes.map((n) => n.type));
  // ⚠️ 这一条是**反着盯**的:挂回不许再退回子代理。退回去的表现是转录照跑、挂回
  // 时灵时不灵(模型漏一条不报错),而图看起来完全正常。
  check("★ 不再有子代理那一步(挂回由宿主执行)", agentNode === undefined, doc?.nodes.map((n) => n.type));

  if (doc) {
    // **两步连成一条线**:触发→code。少这条边,整条自动化就不会动。
    const edges = new Set((doc.edges ?? []).map((e) => `${e.from}->${e.to}`));
    const trigger = doc.nodes.find((n) => n.type === "mcode.trigger");
    check(
      "★ 触发 → code 有线",
      trigger !== undefined && codeNode !== undefined && edges.has(`${trigger.id}->${codeNode.id}`),
      [...edges],
    );
    eq("★ 图上就这两个节点", doc.nodes.length, 2);
  }

  if (codeNode) {
    eq("★ code 节点是 python", codeNode.params["language"], "python");
    const code = String(codeNode.params["code"] ?? "");
    // 正文必须是**真的代码**,而不是一句"请调用 MinerU"。这几个是它的判据所在:
    check("★ 正文里调 MinerU 的批量上传接口", code.includes("/api/v4/file-urls/batch"), code.slice(0, 200));
    check("★ 正文里读 MINERU_TOKEN(不硬编码 token)", code.includes("MINERU_TOKEN"), "");
    // ⚠️ **不许把 token 写死在图里** —— 那份图会被存进库、被分享、被导出。
    check("★ 没有把 token 硬编码进代码", !/Bearer\s+[A-Za-z0-9_-]{20,}/.test(code), "");
    check("★ 正文打的是 code 节点的协议行", code.includes("@@mcode:result"), "");
    // 多条一起下来时**一条都不许漏**(下载是并发跑的,触发器有合并窗口)。
    check("★ 正文按 items 逐条办(不是只取第一条)", code.includes('get("items")'), "");
    // 挂回的**入口**:这一项没了,转录照样绿,但没有一条会被挂回去。
    check("★ 正文报出 adoptMarkdown(挂回交给宿主)", code.includes("adoptMarkdown"), "");
    // token 现在有两条路:脚本顶上那一行,或环境变量。两条都要在。
    check("★ 脚本里留了填 token 的位置", code.includes("TOKEN_INLINE"), "");
    const timeout = Number(codeNode.params["timeoutMs"] ?? 0);
    check("★ 给了足够长的超时(转录要等)", timeout >= 10 * 60 * 1000, timeout);
  }

}

/* ────────── 12b. 指令说的东西,载荷里得真有(2026-09-24)────────── */

// 这一段钉的是**指令与载荷对不上**这一类错:两条内置自动化的指令是**给模型看的合同**
// —— 它说"载荷里有 X",模型就去找 X。合同写了一个不存在的字段,模型的反应是去别处找
// (查"最新导入的"、自己猜一个),而那正是这两条指令当初特意要消灭的行为。
//
// kind 退役那一轮正是这个形状:事件上的 `kind` 字段删了,而两条指令还写着"载荷里有类型"。
// 当时**没有任何一条断言会红** —— 指令是字符串,载荷是另一处拼的,中间没人对过账。
//
// 这里不验"源码里有没有某个字符串",而是**拿真事件喂进真的载荷函数**,再拿指令去对照
// 载荷的实际形状。
console.log("\n内置自动化的指令 ↔ 载荷(拿真事件对账)");

{
  /** 真事件,字段照 `@contracts/runtime` 的两个接口写。 */
  const imported: RuntimeEvent = {
    type: "library.item.imported",
    sessionId: "(system)",
    itemId: "li_a1",
    title: "导入的那一篇",
  } as unknown as RuntimeEvent;
  const downloaded: RuntimeEvent = {
    type: "library.item.downloaded",
    sessionId: "(system)",
    itemId: "li_b2",
    title: "下完的那一篇",
    pdfPath: "papers/ab/cd/abc.pdf",
  } as unknown as RuntimeEvent;

  const dlText = describeTriggerPayload({
    kind: "event",
    event: "library.item.downloaded",
    items: [eventItemFactsOf(downloaded)!],
  });
  const impText = describeTriggerPayload({
    kind: "event",
    event: "library.item.imported",
    items: [eventItemFactsOf(imported)!],
  });

  // ★ 载荷里**没有**"类型"这回事了 —— 而两条指令从前都说有。谁把那个词加回指令里,
  // 这两条会红。
  check("★ 下载载荷不提「类型」", !dlText.includes("类型"), dlText);
  check("★ 导入载荷不提「类型」", !impText.includes("类型"), impText);

  const instrOf = (id: string): string => {
    const agent = presetById(id)?.nodes.find((n) => n.type === "mcode.agent");
    return String(agent?.params["instruction"] ?? "");
  };
  const dlInstr = instrOf(AUTO_DOWNLOAD_WORKFLOW_ID);
  const cvInstr = instrOf(AUTO_CONVERT_WORKFLOW_ID);
  // ⚠️ **只有下载那条还有指令**。转录那条 2026-09-28 去掉了子代理(挂回改由宿主
  // 执行,见 12a),整张图上一个 `mcode.agent` 都没有 —— 所以这里不能再要求它有指令,
  // 反过来要求它**没有**:那一步要是又冒出个代理,说明挂回退回了模型那条路。
  check("下载那条内置图的指令取到了", dlInstr.length > 0, dlInstr.length);
  check("★ 转录那条内置图不带指令(没有子代理)", cvInstr.length === 0, cvInstr);
  check("★ 下载指令不再提「类型」(载荷里没那个字段了)", !dlInstr.includes("类型"), dlInstr);

  // 指令让模型去读「条目:」那几行 —— 那个抬头在载荷里得真存在,否则模型照着一句
  // 空指认去翻,翻不到就只能自己猜。
  check("指令指认的「条目:」抬头上载荷里真有", dlText.includes("条目:"), dlText);

  // 指令点名的 MCP 工具**真的注册着**吗(名字打错 = 那一步永远调不动,而失败发生在
  // 无人值守的后台运行里)—— 那一条在 `library-mcp-smoke` 里验:本套打包
  // `libraryServer` 会把 ssh2 的原生模块(`cpu-features.node`)拖进来,为一条断言给整套
  // 加一圈桩不划算。这里只断"指令里写着那几个名字",两半各在自己拿得到证据的地方。
  const talkedAbout = dlInstr + "\n" + cvInstr;
  // ⚠️ 只剩**下载那条**点名工具了。转录那条一路退场:2026-09-24 调 MinerU 移进 code
  // 节点的代码,2026-09-28 连挂回也不再由模型调 `library_adopt_markdown` —— 宿主读
  // 脚本报的 `outputs.adoptMarkdown` 直接办(断言在 12a 那一段)。
  // 下载那条点名的是 `library_attach_pdf`(2026-09-27 起软件自己不下载,外部工具下完
  // 靠它交回库);`library_download` 已随学术功能退役。
  for (const tool of ["library_attach_pdf"]) {
    check(`指令点名了 ${tool}`, talkedAbout.includes(tool), tool);
  }
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
    startWatch(args: { originSessionId: string; command?: string }): Promise<{ ok: boolean; error?: string }>;
    activeWatchOf(originSessionId: string): boolean;
    statusOf(workflowId: string): Array<{ lastError?: string; droppedUndelivered?: number }>;
    lastMinute: Map<string, number>;
    pendingFires: Map<string, { files: string[]; changes?: Map<string, string>; busyRetryMs?: number; overflowDropped?: number }>;
    /** 【MC-091 续】落盘的「被丢弃、未交付」欠账表(恢复游标)。 */
    droppedUndelivered: Map<string, { count: number; at: number }>;
    /** 【MC-091 续·全局背压】此刻所有触发器攒着的条目总数(私有方法,冒烟按接口取)。 */
    pendingItemsHeld(): number;
    /** 【MC-091 续·启动竞态】读盘那份欠账表(私有方法,验证「并入而非覆盖」)。 */
    readDroppedUndelivered(): Map<string, { count: number; at: number }>;
    runNow(workflowId: string, triggerNodeId: string): Promise<{ ok: boolean; error?: string }>;
    onTick(): void;
    onFsChange(dir: string, filename: string | null, eventType?: string | null): void;
    start(): Promise<void>;
    reloadAll(): Promise<void>;
    dispose(): void;
    /** 第三个参是 `protectedMinute`(实现的默认值 = 当前分钟);测试显式传,好把
     *  "当前分钟"与要灌的历史分钟分开。 */
    rememberLastMinute(key: string, minute: number | null, protectedMinute?: number): void;
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

  /**
   * 与 {@link withClock} 同一条,但等 `fn()` 的 promise 落地。
   *
   * ⚠️ **`start()` 现在会当场 tick 一次(MC-021)。** 于是那些"冻结时钟跑某一分钟"
   * 的用例必须先**把时钟冻住再 start** —— 否则启动那一跳落在**真实当前分钟**上,而
   * 触发器 `* * * * *` 什么分钟都命中,平白多出一次运行,后面所有按分钟算的计数全错位。
   */
  async function withClockAsync<T>(ms: number, fn: () => Promise<T>): Promise<T> {
    const Real = Date;
    const Frozen = function (...args: unknown[]): Date {
      if (args.length === 0) return new Real(ms);
      return new (Real as unknown as new (...a: unknown[]) => Date)(...args);
    };
    (Frozen as unknown as { now: () => number }).now = () => ms;
    (globalThis as unknown as { Date: typeof Date }).Date = Frozen as unknown as typeof Date;
    try {
      return await fn();
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

  /** 【MC-091 续】落盘的「被丢弃、未交付」欠账表 —— 恢复游标。 */
  const DROPPED_KEY = "automation.droppedUndelivered";
  const droppedOnDisk = (): Record<string, { count: number; at: number }> => {
    const raw = SettingRepo.get(DROPPED_KEY);
    return raw === null || raw.length === 0 ? {} : (JSON.parse(raw) as Record<string, { count: number; at: number }>);
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

    // ⚠️ **`start()` 现在会当场 tick 一次(MC-021)。** 所以先把时钟冻在要测的那一分钟
    // 再 start —— 启动那一跳就落在本分钟上,成为"本分钟的第一次";否则它会落在**真实
    // 当前分钟**上,而 `* * * * *` 什么分钟都命中,平白多出一次运行,后面按分钟算的
    // 计数全错位。
    const minute = 1_000_000; // 冻结的那一分钟(毫秒 = minute * 60_000)
    const at = minute * 60_000;
    const runner = await withClockAsync(at, () => startRunner());

    // **同一分钟内再 tick 两次** —— ticker 30 秒一跳,同一分钟真的会被看两次(见 TICK_MS
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

    const restartMinute = 2_000_000;
    const restartAt = restartMinute * 60_000;
    // 同样:冻在 restartMinute 再 start,启动那一跳就是"这一分钟跑过一次"。
    const revived = await withClockAsync(restartAt, () => startRunner());
    const beforeRestart2 = runsOfNode(nodeId).length;
    eq("重启前:这一分钟跑过一次", beforeRestart2, 3);
    revived.dispose();

    // **再起一个进程**(磁盘上那张表就是唯一的记忆)。这一跳若还是"本分钟没见过",
    // 就会多起一次运行 —— 那正是"每次开应用那个每分钟的自动化多跑一次"的症状。
    const second = await withClockAsync(restartAt + 10_000, () => startRunner());
    withClock(restartAt + 10_000, () => second.onTick());
    eq("重启之后同一分钟不再触发", runsOfNode(nodeId).length, 3);
    second.dispose();
  }

  /* ── ①b 非当前分钟的历史仍有上限，清理不妨碍后续分钟调度 ── */
  {
    resetRuns();
    SettingRepo.set(LAST_MINUTE_KEY, "{}");
    const wf = "wf_trim", nodeId = "t1";
    makeAutomation({ workflowId: wf, nodeId, params: {
      [NODE_TRIGGER_KIND_PARAM_KEY]: "schedule",
      [NODE_TRIGGER_CRON_PARAM_KEY]: EVERY_MINUTE,
      task: "旧记录回收不影响下一次调度",
    } });
    const base = 5_000_000;
    // 冻在 base+1000 再 start,让启动那一跳也落在同一条"逻辑时间线"上 —— 这一节用
    // 的是 `base+1000` 那个分钟,启动 tick 若落真实当前分钟会额外多跑一次。
    const runner = (await withClockAsync((base + 1000) * 60_000, () => startRunner())) as RunnerInternals & {
      rememberLastMinute(key: string, minute: number | null): void;
    };
    try {
      // ⚠️ `start()` 现在会当场 tick 一次(MC-021),叠在 base+1000 上,于是起手时这张表
      // **已经有一条**(本分钟内这条触发器的去重记录)。这一节验的是**历史修剪**,只有
      // **非当前分钟**的那些参与 60 条预算,所以按 protected 那一格把当前分钟的行排除出去再数。
      const protectedMinute = base + 1000;
      withClock((base + 1000) * 60_000, () => {
        for (let i = 1; i <= 65; i++) runner.rememberLastMinute(`wf_trim:t${i}`, base + i, protectedMinute);
      });
      const disk = onDisk();
      eq(
        "非当前分钟的历史只保留60条",
        Object.keys(disk).filter((k) => disk[k] !== protectedMinute).length,
        60,
      );
      check("淘汰最旧的历史记录", !runner.lastMinute.has("wf_trim:t1") && !runner.lastMinute.has("wf_trim:t5") && runner.lastMinute.has("wf_trim:t6"), [...runner.lastMinute.keys()]);
      eq("最新历史记录仍在", disk["wf_trim:t65"], base + 65);
      // 旧记录回收之后,新的一分钟里这条触发器照常调度。
      resetRuns();
      withClock((base + 1001) * 60_000, () => runner.onTick());
      eq("旧记录回收不阻止后续分钟正常调度", runsOfNode(nodeId).length, 1);
    } finally { runner.dispose(); }
  }

  /* ── ①c 盘上的定时去重表损坏时，启动不断，但定时派发必须 fail-closed ── */

  {
    // 保留用户原始损坏字节，而不是把 bad JSON 当空表写回并重放。
    // 主执行器可以启动以便用户修复，其定时调度不可产生外部副作用。
    resetRuns();
    const wf = nextId();
    const nodeId = "t_badjson";
    makeAutomation({
      workflowId: wf,
      nodeId,
      params: {
        [NODE_TRIGGER_KIND_PARAM_KEY]: "schedule",
        [NODE_TRIGGER_CRON_PARAM_KEY]: EVERY_MINUTE,
        task: "坏表需要报告并阻止定时副作用",
      },
    });

    // ① 不是合法 JSON。
    SettingRepo.set(LAST_MINUTE_KEY, "{ 这不是 json");

    // ⚠️ **`start()` 必须包起来**:这一句验的正是"坏表不该把 `start()` 炸掉"。不包的话,
    // 实现一旦退回"直接抛",整个冒烟文件会以一个未捕获的 `SyntaxError` 结束(退出码 1,
    // 一条 FAIL 都打不出来)—— 那种形状看不出是哪条断言在红,也就谈不上"确认红"。包成
    // 一个可判的失败,红的时候才有 `FAIL 坏 JSON:不当成抛错…` 这一行。
    const at = 3_000_000 * 60_000;
    // start() 会立刻 tick；损坏后那一次也必须被拒绝。
    const bad = await withClockAsync(at, () => startRunner()).then(
      (r) => ({ runner: r, error: null as string | null }),
      (err: unknown) => ({ runner: null, error: (err as Error).message }),
    );
    check(
      "坏 JSON:应用可启动以供检查，但不自动派发",
      bad.error === null,
      bad.error ?? "没抛",
    );
    if (bad.runner !== null) {
      const r1 = bad.runner;
      check("坏 JSON:内存里没有被伪造的新去重记录", r1.lastMinute.size === 0, [...r1.lastMinute.entries()]);
      withClock(at, () => r1.onTick());
      eq(
        "坏 JSON 之后拒绝定时派发，而不是执行一次",
        runsOfNode(nodeId).length,
        0,
      );
      r1.dispose();
    } else {
      // 抛了就没法接着往后验 —— 把后面两条也各记一条红,免得"少跑了"看起来像"没红"。
      check("坏 JSON:实例可启动供用户修复", false, "start() 抛了,拿不到实例");
      check("坏 JSON 之后拒绝定时派发", false, "同上");
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
      check(`坏形状(${what}):不创建虚假的去重记录`, r.lastMinute.size === 0, [...r.lastMinute.entries()]);
      eq(`坏形状(${what}):原始字节保留`, SettingRepo.get(LAST_MINUTE_KEY), bad);
      r.dispose();
    }

    // ③ 对照:一份**形状对**的表照常读回来(别把 fail-closed 写成"一律丢")。
    // 注意 `start()` 的启动 tick 会为 `* * * * *` 写下本分钟一条,所以只断言 `wf_ok:t`
    // 那条被读了回来,而不是整张表的大小。
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
        [NODE_TRIGGER_EXCLUDE_PATHS_PARAM_KEY]: "automation-generated.md",
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

    // 有明确排除配置的自动化产物不触发自己；普通匹配文件仍应照常触发。
    const generated = join(PROJ_DIR, "automation-generated.md");
    writeFileSync(generated, "# 自动化产物");
    runner.onFsChange(PROJ_DIR, "automation-generated.md");
    eq("命中排除 glob 的自动化产物不进入待触发队列", runner.pendingFires.get(pendingKey)?.files.length ?? 0, 0);
    await sleep(FLUSH_SLACK_MS);
    eq("排除的自动化产物不派发运行", runsOfNode(nodeId).length, 0);
    resetRuns();

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
    // 【MC-022】攒着的那批收口时**全都不在了** → 这一次**根本不跑**(从前是照跑一次
    // 空载荷,叫模型白跑一趟、白花钱)。所以这里断言的是"没有这次运行",而不是
    // "运行照跑、只是载荷空"。
    eq("收口时整批都不在了 → 这一次不跑(不再空载荷唤醒模型)", fired.length, 0);
    check(
      "而且没有哪次运行的载荷里带着那个已删文件",
      !runs.some((r) => JSON.stringify(r.entry?.payload ?? {}).includes("vanishes-later")),
      fired.map((r) => r.entry?.payload),
    );

    /* ── ②c 攒着的文件超过上限 → 显式报出丢了多少(不是静默截断) ── */

    // 一条抖动的目录把积压队列顶到 `PENDING_FILES_LIMIT`(500)之上。**上限保护本身要
    // 保留**(队列不能无限长),但**丢了必须说出来** —— 从前只是 `log.warn`,载荷里是
    // 一份不完整列表却没有任何消费方收得到"这次输入被截断了"的事实(ARC-015 剩余项②)。
    // 这里灌 502 个真存在的 `.md`,断言:队列恰好停在 500、超出的 2 条记进
    // `overflowDropped`,并**兑现到载荷事实**里。
    const wf3 = nextId();
    const nodeId3 = "t_overflow";
    makeAutomation({
      workflowId: wf3,
      nodeId: nodeId3,
      params: {
        [NODE_TRIGGER_KIND_PARAM_KEY]: "file",
        [NODE_TRIGGER_PATHS_PARAM_KEY]: "*.md",
        [NODE_TRIGGER_DEBOUNCE_PARAM_KEY]: 0,
        task: "这批文件太多时也要如实说",
      },
    });
    await runner.reloadAll();

    const overflowKey = `${wf3}:${nodeId3}`;
    const LIMIT = 500;
    const EXTRA = 2;
    for (let i = 0; i < LIMIT + EXTRA; i += 1) {
      const name = `churn-${String(i).padStart(4, "0")}.md`;
      writeFileSync(join(PROJ_DIR, name), `# ${i}`);
      runner.onFsChange(PROJ_DIR, name);
    }
    const pending3 = runner.pendingFires.get(overflowKey);
    eq("超限后队列恰好停在上限", pending3?.files.length ?? -1, LIMIT);
    eq("超出的条数记进 overflowDropped", pending3?.overflowDropped ?? -1, EXTRA);
    check("留下的是最近的那批(丢的是最早的)", pending3?.files.includes(join(PROJ_DIR, `churn-${String(LIMIT + EXTRA - 1).padStart(4, "0")}.md`)) === true, pending3?.files.slice(0, 2));

    await sleep(FLUSH_SLACK_MS);
    const overflowRun = runsOfNode(nodeId3);
    // 真实 `fs.watch` 可能让收口再往后推一点(见下),所以只断言**至少起了一次** ——
    // 本片要证的是"超限也照跑 + 载荷如实报截断",不是精确的运行次数。
    check("超限的这一批照常起一次运行(不因超限丢掉整批)", overflowRun.length >= 1, overflowRun.length);
    // ⚠️ 载荷里那个数**只断言下界**。这个项目目录挂的是**真的 `fs.watch`**,而我刚写的
    // 502 个文件会产生**真实 `rename` 事件**,在收口那 300ms 里把已被挤掉的早期文件
    // 又送一遍 `onFsChange` —— 于是"丢的条数"会**再多几条**,而具体多几取决于平台事件
    // 时序(不稳定)。下界 `>= EXTRA` 已经能区分修复:没接线时这个键**根本不出现**
    // (`undefined >= 2` 为假,真红)。队列层那个精确数在上面已经断言过了(纯函数层
    // 的 number 也是精确的)。
    check(
      "载荷事实里带上了丢的条数(下界)",
      (overflowRun[0]?.entry?.payload?.overflowDropped as number | undefined) !== undefined
        && (overflowRun[0]?.entry?.payload?.overflowDropped as number) >= EXTRA,
      overflowRun[0]?.entry?.payload,
    );
    eq("载荷里交给模型的文件数恰好是队列上限", (overflowRun[0]?.entry?.payload?.files as string[] | undefined)?.length, LIMIT);
    check(
      "载荷里交给模型的仍是最近那批(不含被丢的最早文件)",
      (overflowRun[0]?.entry?.payload?.files as string[] | undefined)?.includes(
        join(PROJ_DIR, `churn-${String(LIMIT + EXTRA - 1).padStart(4, "0")}.md`),
      ) === true,
      overflowRun[0]?.entry?.payload?.files,
    );

    /* ── ②d 结构化变更:改动 / 新建 / 删除各得诚实方向(ARC-015①) ── */

    // 从前 `onFsChange` 只拿文件名、判"此刻在不在",删除/改名方向**根本没有地方说** ——
    // 模型看到 `files` 时看不出"这个文件被删了"。这里造一次**改动 + 新建 + 删除**同批,
    // 断言 `payload.changes` 里方向如实(modified/created/deleted),且事件类型为 "change"
    // 的那条被认成 modified、`fs.watch` 的 rename 合事件靠"见没见过"分辨 created/deleted。
    const wf4 = nextId();
    const nodeId4 = "t_changes";
    makeAutomation({
      workflowId: wf4,
      nodeId: nodeId4,
      params: {
        [NODE_TRIGGER_KIND_PARAM_KEY]: "file",
        [NODE_TRIGGER_PATHS_PARAM_KEY]: "*.md",
        [NODE_TRIGGER_DEBOUNCE_PARAM_KEY]: 0,
        task: "看变更方向",
      },
    });
    await runner.reloadAll();

    const kept = join(PROJ_DIR, "change-kept.md");
    writeFileSync(kept, "# 已存在");
    // 先攒下"见过"它(用 rename,第一次见 → created),这一步只为了让 `seenBefore` 为真。
    runner.onFsChange(PROJ_DIR, "change-kept.md", "rename");
    // 再报一次 "change"(内容改了)→ 此刻在 → modified。
    runner.onFsChange(PROJ_DIR, "change-kept.md", "change");
    // 新建一个(rename + 在 + 没见过 → created)。
    const freshFile = join(PROJ_DIR, "change-fresh.md");
    writeFileSync(freshFile, "# 新来");
    runner.onFsChange(PROJ_DIR, "change-fresh.md", "rename");
    // 删除一个已见过的(先攒下,再删,再报 rename → deleted)。
    const doomed2 = join(PROJ_DIR, "change-doomed.md");
    writeFileSync(doomed2, "# 待删");
    runner.onFsChange(PROJ_DIR, "change-doomed.md", "rename");
    rmSync(doomed2, { force: true });
    runner.onFsChange(PROJ_DIR, "change-doomed.md", "rename");

    // ⚠️ 这一段**没 await**(同步跑完),所以此刻盘上真的 `fs.watch` 还没来得及插话 ——
    // pending 里的方向是纯由上面几次显式事件合成出来的,**精确可断言**。
    const pend4 = runner.pendingFires.get(`${wf4}:${nodeId4}`);
    eq("方向:改动记成 modified", pend4?.changes?.get(kept), "modified");
    eq("方向:新建记成 created", pend4?.changes?.get(freshFile), "created");
    eq("方向:删除记成 deleted", pend4?.changes?.get(doomed2), "deleted");

    await sleep(FLUSH_SLACK_MS);
    const changeRun = runsOfNode(nodeId4);
    check("带方向的这一批照常起一次运行", changeRun.length >= 1, changeRun.length);
    const changes = changeRun[0]?.entry?.payload?.changes as { path: string; kind: string }[] | undefined;
    check("载荷里带上了 changes", Array.isArray(changes) && changes.length >= 3, changes);
    // 删除方向**稳**(一旦 deleted,后续真实事件只会继续报 deleted:不在 + 见过)。改动/新建
    // 那两个在收口那 300ms 里可能被真实 `fs.watch` 事件重写成 `unknown`(rename + 在 + 见过),
    // 那本身也是**诚实**的 —— 所以这两个在载荷层只断言"方向在合法集合里",精确判据由上面的
    // pending 层与纯函数层承担。
    eq("载荷:deleted 方向如实(删除的路径不在 files 里,但方向在)", changes?.find((c) => c.path === doomed2)?.kind, "deleted");
    const HONEST = new Set(["created", "modified", "deleted", "renamed", "unknown"]);
    check("载荷:每个方向都在诚实集合里", (changes ?? []).every((c) => HONEST.has(c.kind)), changes);
    check("载荷:kept 与 fresh 都有方向", changes?.some((c) => c.path === kept) === true && changes?.some((c) => c.path === freshFile) === true, changes);
    // ⚠️ 删除的路径**不**进 `files`(那份只装"存在、要办"的)—— 但它必须在 `changes` 里。
    check("删除的路径不在 files 里", (changeRun[0]?.entry?.payload?.files as string[] | undefined)?.includes(doomed2) !== true, changeRun[0]?.entry?.payload?.files);
    // `changes` 不进「插入变量」菜单(它是数组套对象,`{{trigger.changes}}` 解不出来)。
    check("changes 不进插入变量菜单", !triggerFactKeysOf({ [NODE_TRIGGER_KIND_PARAM_KEY]: "file" }).includes("changes"));

    /* ── ②e 收口前又没了 → 方向降级成 deleted(二次 stat 校正) ── */

    const wf5 = nextId();
    const nodeId5 = "t_reconcile";
    makeAutomation({
      workflowId: wf5,
      nodeId: nodeId5,
      params: {
        [NODE_TRIGGER_KIND_PARAM_KEY]: "file",
        [NODE_TRIGGER_PATHS_PARAM_KEY]: "*.md",
        [NODE_TRIGGER_DEBOUNCE_PARAM_KEY]: 500,
        task: "收口前删了要改口",
      },
    });
    await runner.reloadAll();

    // 有存活文件保证"这一次真会跑"(纯删除批不唤醒,见 MC-022);被删的那个只是方向要改口。
    const survivor = join(PROJ_DIR, "reconcile-survivor.md");
    writeFileSync(survivor, "# 留着");
    runner.onFsChange(PROJ_DIR, "reconcile-survivor.md", "change");
    const vanish = join(PROJ_DIR, "reconcile-vanish.md");
    writeFileSync(vanish, "# 待会儿没了");
    runner.onFsChange(PROJ_DIR, "reconcile-vanish.md", "change"); // 此刻在 → modified
    eq("收口前:方向还是 modified", runner.pendingFires.get(`${wf5}:${nodeId5}`)?.changes?.get(vanish), "modified");
    // 攒着的那几秒里删掉它 —— 收口二次 stat 应把它从 modified 降级成 deleted。
    rmSync(vanish, { force: true });
    await sleep(FLUSH_SLACK_MS);

    const recRun = runsOfNode(nodeId5);
    check("二次 stat:存活文件仍起一次运行", recRun.length >= 1, recRun.length);
    const recChanges = recRun[0]?.entry?.payload?.changes as { path: string; kind: string }[] | undefined;
    eq("二次 stat:收口前删掉的被降级成 deleted", recChanges?.find((c) => c.path === vanish)?.kind, "deleted");
    check("二次 stat:存活的不是 deleted", recChanges?.find((c) => c.path === survivor)?.kind !== "deleted", recChanges?.find((c) => c.path === survivor));

    /* ── ②f 越界路径:上跳的 filename 不得进入任何触发器的 pending(ARC-015③) ── */

    // 一条泛化 glob(`**/*.md`)本会命中任何 `.md` —— 包括一条 `../escaped.md` 事件经
    // `join(dir, …)` 归约后落在**根之外**的路径。越界防线要把它挡在触发器循环之前:
    // pending 里**一格都不该**为它建立。同时在根内塞一个真的,证明这道闸门**只**挡越界的
    // 那些(不是把整条事件流误杀)。
    const wf6 = nextId();
    const nodeId6 = "t_escape";
    makeAutomation({
      workflowId: wf6,
      nodeId: nodeId6,
      params: {
        [NODE_TRIGGER_KIND_PARAM_KEY]: "file",
        [NODE_TRIGGER_PATHS_PARAM_KEY]: "**/*.md",
        [NODE_TRIGGER_DEBOUNCE_PARAM_KEY]: 10_000, // 长窗口:断言期间不会被 flush 掉
        task: "越界事件不该被看到",
      },
    });
    await runner.reloadAll();

    const escapeKey = `${wf6}:${nodeId6}`;
    // ⚠️ 越界目标必须**真实存在** —— 否则那道 `!present && !seenBefore → continue` 会
    // 顺手把它滤掉,断言就**不承重**了(撤掉防线也照绿)。这里在 PROJ_DIR 的**上一级**
    // 真写一个 `.md`(在监听根之外,`fs.watch` 不会为它产生事件),再报一条上跳的
    // `filename` —— `join` 归约后正是这个文件。只有越界防线能挡住它。
    const escaped = join(PROJ_DIR, "..", "escaped-real.md");
    writeFileSync(escaped, "# 根外");
    check("越界目标是真文件(否则断言不承重)", existsSync(escaped), escaped);
    runner.onFsChange(PROJ_DIR, "..\\escaped-real.md", "rename");
    const afterEscape = runner.pendingFires.get(escapeKey);
    check("越界 filename 不进 pending(一格都不建)", afterEscape === undefined, afterEscape?.files);
    // 根内的一个真文件必须照常进 —— 证明挡的是越界,不是整条流。
    writeFileSync(join(PROJ_DIR, "in-root.md"), "# 根内");
    runner.onFsChange(PROJ_DIR, "in-root.md", "rename");
    const afterInside = runner.pendingFires.get(escapeKey);
    check("根内文件照常进 pending", afterInside?.files.includes(join(PROJ_DIR, "in-root.md")) === true, afterInside?.files);

    runner.dispose();
  }

  /* ── ③ 导入的图未审查:注册、派发、手动触发和改图后撤权 ── */
  {
    resetRuns();
    const wf = nextId();
    const nodeId = "t_untrusted";
    makeAutomation({
      workflowId: wf,
      nodeId,
      params: {
        [NODE_TRIGGER_KIND_PARAM_KEY]: "schedule",
        [NODE_TRIGGER_CRON_PARAM_KEY]: "* * * * *",
        task: "只有批准才能执行",
      },
    });
    requireWorkflowReview(wf, "import");
    const runner = await startRunner();
    withClock(3_000_000 * 60_000, () => runner.onTick());
    eq("未审查的定时图不注册也不派发", runsOfNode(nodeId).length, 0);
    const denied = await runner.runNow(wf, nodeId);
    check("手动触发也不能绕过审查", !denied.ok && denied.error?.includes("尚未审查") === true, denied);

    const doc = getWorkflow(wf)!;
    check("审核当前存盘版本才放行", approveWorkflowRevision(doc, workflowRevision(doc)).ok);
    await runner.reloadAll();
    withClock(3_000_001 * 60_000, () => runner.onTick());
    eq("批准后同一图的定时触发器可运行", runsOfNode(nodeId).length, 1);

    // Deliberately do NOT reload: a timer captured before the edit must be
    // checked again at dispatch, not just when the trigger was registered.
    WorkflowRepo.save({
      ...doc,
      nodes: doc.nodes.map((n) => ({ ...n, params: { ...n.params, task: "现在做另一件事" } })),
    });
    withClock(3_000_002 * 60_000, () => runner.onTick());
    eq("已注册定时器也不能派发未经重审的新图", runsOfNode(nodeId).length, 1);
    const revoked = await runner.runNow(wf, nodeId);
    check("同 id 改图后手动触发也撤权", !revoked.ok && revoked.error?.includes("尚未审查") === true, revoked);
    runner.dispose();
  }

  /* ── ③b 批准后被**同图重存**（revision 不变，但审批被撤销）—— 已在闸门里的
   *      事件触发批次必须在派发那一刻重新问一次授权，不能按"挂载时批准过"放行。
   *
   * 这一条钉的是与 ③ 不同的缺口面:③ 改的是**内容**(revision 变了);这里内容一字
   * 不改、revision 不变,变的只有"用户是否还批准这一版"。`fire()` 的设计是两道独立
   * 判定(先 `workflowReviewError`,再 revision 比较),所以撤销审批必须由**第一道**
   * 拦住 —— 只靠 revision 比较的话,守卫会把"同图重存"当成上一轮同一份,直接派发。 */
  {
    resetRuns();
    SettingRepo.set(LAST_MINUTE_KEY, "{}");
    const wf = nextId();
    const nodeId = "t_revoked_between_arm_and_fire";
    const params = {
      [NODE_TRIGGER_KIND_PARAM_KEY]: "event",
      [NODE_TRIGGER_EVENTS_PARAM_KEY]: "library.item.downloaded",
      // 0 窗口同上一条 stale-revision 用例:事件同步攒进 pending,定时器要等当前
      // 同步块跑完才执行 —— 撤销审批发生在这中间,派发那一刻必须重新问一次。
      [NODE_TRIGGER_DEBOUNCE_PARAM_KEY]: 0,
      task: "审批撤销后不该再有人被叫起来",
    };
    makeAutomation({ workflowId: wf, nodeId, params });
    requireWorkflowReview(wf, "ai");
    const approvedDoc = getWorkflow(wf)!;
    check("夹具:批准当前版本", approveWorkflowRevision(approvedDoc, workflowRevision(approvedDoc)).ok);
    const runner = await startRunner();
    try {
      const emit = (): void => runtimeManager.emit({
        type: "library.item.downloaded",
        sessionId: "revoke-between-arm-source",
        itemId: "revoke-between-arm-item",
        title: "撤销审批前下载的条目",
        pdfPath: "papers/revoke-between-arm.pdf",
      } as unknown as RuntimeEvent);
      emit();
      eq("夹具:事件已攒进合并窗口(触发器是挂着的)", runner.pendingFires.has(`${wf}:${nodeId}`), true);

      // 审批被撤销(相当于"同 id 又进了待审状态"),但**图本身一个字没改**。
      // 不走 saveWorkflow 也行 —— 标记写入方就是 `requireWorkflowReview`。
      requireWorkflowReview(wf, "ai");
      await sleep(50);
      eq("★ 已挂载的事件触发在审批撤销后不派发", runsOfNode(nodeId).length, 0);
      check(
        "撤销原因对用户可见(不是静默丢弃)",
        runner.statusOf(wf)[0]?.lastError?.includes("尚未审查") === true,
        runner.statusOf(wf),
      );

      // 正控:重新批准**同一份图**后,新的触发照常放行(证明挡的是审批而不是整条流)。
      const again = getWorkflow(wf)!;
      check("正控:重新批准同一版本", approveWorkflowRevision(again, workflowRevision(again)).ok);
      await runner.reloadAll();
      emit();
      await sleep(60);
      eq("正控:重新批准后事件触发照常运行", runsOfNode(nodeId).length, 1);
    } finally { runner.dispose(); }
  }


  /* ── 生命周期回归:关闭不是暂存,换项目不能复用旧项目的事件 ── */
  {
    resetRuns();
    SettingRepo.set(LAST_MINUTE_KEY, "{}");
    const wf = nextId();
    const nodeId = "t_disabled_schedule";
    const params = {
      [NODE_TRIGGER_KIND_PARAM_KEY]: "schedule",
      [NODE_TRIGGER_CRON_PARAM_KEY]: EVERY_MINUTE,
      [NODE_TRIGGER_ENABLED_PARAM_KEY]: false,
      task: "关闭不消费定时名额",
    };
    makeAutomation({ workflowId: wf, nodeId, params });
    const runner = await startRunner();
    const minute = 8_000_000;
    try {
      withClock(minute * 60_000, () => runner.onTick());
      eq("关闭的定时器不运行", runsOfNode(nodeId).length, 0);
      eq("关闭的定时器不占用本分钟去重记录", runner.lastMinute.has(`${wf}:${nodeId}`), false);
      const manual = await runner.runNow(wf, nodeId);
      eq("关闭状态仍允许明确的手动运行", manual.ok, true);
      resetRuns();
      makeAutomation({ workflowId: wf, nodeId, params: { ...params, [NODE_TRIGGER_ENABLED_PARAM_KEY]: true } });
      await runner.reloadAll();
      withClock(minute * 60_000, () => runner.onTick());
      eq("同一分钟启用后能正常触发", runsOfNode(nodeId).length, 1);
      WorkflowRepo.save({ ...getWorkflow(wf)!, nodes: [], edges: [] });
      await runner.reloadAll();
      eq("删除触发器清除内存去重记录", runner.lastMinute.has(`${wf}:${nodeId}`), false);
      eq("删除触发器也清除持久化去重记录", Object.hasOwn(onDisk(), `${wf}:${nodeId}`), false);
    } finally { runner.dispose(); }
  }

  {
    resetRuns();
    const wf = nextId();
    const nodeId = "t_disabled_event";
    const params = {
      [NODE_TRIGGER_KIND_PARAM_KEY]: "event",
      [NODE_TRIGGER_EVENTS_PARAM_KEY]: "turn.done",
      [NODE_TRIGGER_DEBOUNCE_PARAM_KEY]: 10_000,
      [NODE_TRIGGER_ENABLED_PARAM_KEY]: false,
      task: "只接收启用期间的事件",
    };
    makeAutomation({ workflowId: wf, nodeId, params });
    const runner = await startRunner();
    const emit = (): void => runtimeManager.emit({
      type: "turn.done", sessionId: "disabled-event-source", endedAt: Date.now(), reason: "end_turn",
    });
    try {
      emit();
      eq("关闭期间不攒事件", runner.pendingFires.has(`${wf}:${nodeId}`), false);
      makeAutomation({ workflowId: wf, nodeId, params: { ...params, [NODE_TRIGGER_ENABLED_PARAM_KEY]: true } });
      await runner.reloadAll();
      emit();
      eq("启用期间事件进入合并窗口", runner.pendingFires.has(`${wf}:${nodeId}`), true);
      makeAutomation({ workflowId: wf, nodeId, params });
      await runner.reloadAll();
      eq("关闭时立即丢弃未派发事件", runner.pendingFires.has(`${wf}:${nodeId}`), false);
      makeAutomation({ workflowId: wf, nodeId, params: { ...params, [NODE_TRIGGER_ENABLED_PARAM_KEY]: true } });
      await runner.reloadAll();
      eq("重新启用不会恢复旧事件", runner.pendingFires.has(`${wf}:${nodeId}`), false);
    } finally { runner.dispose(); }
  }

  /* A debounced event must not run the previously loaded graph revision. */
  {
    resetRuns();
    const wf = nextId(), nodeId = "t_stale_revision";
    const params = {
      [NODE_TRIGGER_KIND_PARAM_KEY]: "event",
      [NODE_TRIGGER_EVENTS_PARAM_KEY]: "library.item.downloaded",
      [NODE_TRIGGER_DEBOUNCE_PARAM_KEY]: 0,
      task: "旧任务",
    };
    makeAutomation({ workflowId: wf, nodeId, params });
    const runner = await startRunner();
    const emit = (): void => runtimeManager.emit({
      type: "library.item.downloaded",
      sessionId: "stale-config-source",
      itemId: "stale-config-item",
      title: "更新中的条目",
      pdfPath: "papers/stale-config.pdf",
    } as unknown as RuntimeEvent);
    try {
      emit();
      const saved = getWorkflow(wf)!;
      WorkflowRepo.save({
        ...saved,
        nodes: saved.nodes.map((n) => ({
          ...n,
          params: { ...n.params, task: "更新后的任务" },
        })),
      });
      await sleep(50);
      eq("工作流变更后，旧版防抖事件不启动", runsOfNode(nodeId).length, 0);
      check(
        "丢弃旧版事件的原因可见",
        runner.statusOf(wf)[0]?.lastError?.includes("工作流已修改") === true,
        runner.statusOf(wf),
      );

      await runner.reloadAll();
      emit();
      await sleep(50);
      eq("重载后新事件正常运行", runsOfNode(nodeId).length, 1);
      check("重载后运行使用新任务", runsOfNode(nodeId)[0]?.prompt?.includes("更新后的任务") === true);
    } finally { runner.dispose(); }
  }

  {
    const wf = nextId();
    const nodeId = "t_project_switch";
    const file = "project-switch-only.md";
    const params = {
      [NODE_TRIGGER_KIND_PARAM_KEY]: "file",
      [NODE_TRIGGER_PATHS_PARAM_KEY]: file,
      [NODE_TRIGGER_DEBOUNCE_PARAM_KEY]: 10_000,
      task: "事件必须属于这次运行的项目",
    };
    makeAutomation({ workflowId: wf, nodeId, params });
    writeFileSync(join(PROJ_DIR, file), "fixture");
    const runner = await startRunner();
    try {
      runner.onFsChange(PROJ_DIR, file);
      eq("项目 A 的文件事件已攒下", runner.pendingFires.has(`${wf}:${nodeId}`), true);
      const projectB = PROJ_ID + "_switch";
      const dirB = join(process.env.MCODE_SMOKE_DATA_ROOT!, "project-switch-B");
      mkdirSync(dirB, { recursive: true });
      ProjectRepo.create({ ...ProjectRepo.get(PROJ_ID)!, id: projectB, path: dirB });
      makeAutomation({ workflowId: wf, nodeId, params: { ...params, [NODE_TRIGGER_PROJECT_PARAM_KEY]: projectB } });
      await runner.reloadAll();
      eq("切换项目后不把 A 的事件交给 B", runner.pendingFires.has(`${wf}:${nodeId}`), false);
    } finally { runner.dispose(); }
  }


  /* ── 忙时文件/条目事件保留一批，不并发、不吞掉、不无限重跑同一批 ── */
  {
    resetRuns();
    const wf = nextId(), nodeId = "t_busy_items";
    const params = {
      [NODE_TRIGGER_KIND_PARAM_KEY]: "event",
      [NODE_TRIGGER_EVENTS_PARAM_KEY]: "library.item.downloaded",
      [NODE_TRIGGER_DEBOUNCE_PARAM_KEY]: 0,
      task: "逐篇处理，不漏条目",
    };
    makeAutomation({ workflowId: wf, nodeId, params });
    const runner = await startRunner();
    await runner.runNow(wf, nodeId);
    const sessionId = runsOfNode(nodeId)[0]!.sessionId;
    const emit = (id: string): void => runtimeManager.emit({
      type: "library.item.downloaded", sessionId: "(system)", itemId: id, title: id, pdfPath: `papers/${id}.pdf`,
    } as unknown as RuntimeEvent);
    setRunBusy(sessionId, true);
    try {
      emit("queued-a"); await sleep(80);
      eq("忙时条目事件保留待处理批次", runner.pendingFires.has(`${wf}:${nodeId}`), true);
      eq("忙时不会开启第二轮", runsOfNode(nodeId).length, 1);
      emit("queued-b"); emit("queued-a"); await sleep(80);
      const manual = await runner.runNow(wf, nodeId);
      eq("显式手动点击忙时仍报忙，不暗中排队", manual.ok, false);
      setRunBusy(sessionId, false); await sleep(1300);
      const batch = runsOfNode(nodeId);
      eq("空闲后只补跑合并的一批", batch.length, 2);
      const items = batch[1]?.entry?.payload?.items as Array<{ itemId?: string }> | undefined;
      eq("跨忙碌窗口的两篇都交给下一轮，重复通知去重", items?.map(i => i.itemId).sort().join(","), "queued-a,queued-b");
      eq("交付后不遗留重试计时器", runner.pendingFires.has(`${wf}:${nodeId}`), false);

      setRunBusy(sessionId, true); emit("cancel-me"); await sleep(80);
      eq("取消前确实有待处理事件", runner.pendingFires.has(`${wf}:${nodeId}`), true);
      runtimeManager.emit({ type: "turn.done", sessionId, reason: "interrupted", endedAt: Date.now() });
      eq("用户取消自动化时清除待处理事件", runner.pendingFires.has(`${wf}:${nodeId}`), false);
      setRunBusy(sessionId, false); await sleep(1100);
      eq("取消后不会被旧队列自动重启", runsOfNode(nodeId).length, 2);

      setRunBusy(sessionId, true); emit("disable-me"); await sleep(80);
      makeAutomation({ workflowId: wf, nodeId, params: { ...params, [NODE_TRIGGER_ENABLED_PARAM_KEY]: false } });
      await runner.reloadAll();
      eq("关闭也清掉忙时积压", runner.pendingFires.has(`${wf}:${nodeId}`), false);
    } finally { setRunBusy(sessionId, false); runner.dispose(); }
  }
  {
    resetRuns();
    const wf = nextId(), nodeId = "t_busy_files";
    makeAutomation({ workflowId: wf, nodeId, params: {
      [NODE_TRIGGER_KIND_PARAM_KEY]: "file", [NODE_TRIGGER_PATHS_PARAM_KEY]: "busy-*.md",
      [NODE_TRIGGER_DEBOUNCE_PARAM_KEY]: 0, task: "处理忙时所有文件",
    } });
    const runner = await startRunner();
    await runner.runNow(wf, nodeId);
    const sessionId = runsOfNode(nodeId)[0]!.sessionId;
    setRunBusy(sessionId, true);
    try {
      writeFileSync(join(PROJ_DIR, "busy-a.md"), "a"); runner.onFsChange(PROJ_DIR, "busy-a.md");
      await sleep(600);
      eq("忙时文件批次不丢失", runner.pendingFires.has(`${wf}:${nodeId}`), true);
      writeFileSync(join(PROJ_DIR, "busy-b.md"), "b"); runner.onFsChange(PROJ_DIR, "busy-b.md");
      await sleep(600);
      setRunBusy(sessionId, false); await sleep(1300);
      eq("文件批次在空闲后只执行一次", runsOfNode(nodeId).length, 2);
      const files = runsOfNode(nodeId)[1]?.entry?.payload?.files as string[] | undefined;
      check("跨窗口积压的两个文件都在", files?.includes(join(PROJ_DIR,"busy-a.md")) === true && files?.includes(join(PROJ_DIR,"busy-b.md")) === true, files);
    } finally { setRunBusy(sessionId, false); runner.dispose(); }
  }
  /* ── 【MC-091】忙时跨窗口重排队**也要走上限**(不是只有正常收集那一侧有界) ──
   *
   * 从前忙时分支是一句裸的 `pending.files = [...new Set([...pending.files, ...payload.files])]`
   * —— **绕过了 `PENDING_FILES_LIMIT`**。工作流跑很久(几十分钟)期间多个忙窗口串联聚合,
   * 每次把上一批整批并回来,队列可无界增长(而正常收集那一侧明明有 500 的上限)。
   * 这里让第一个忙窗口就攒爆 500,后续窗口再灌 —— 断言忙时重排队后的队列**仍停在上限**,
   * 且**这次挤掉的条数累加进 `overflowDropped`**(不是静默丢)。
   */
  {
    resetRuns();
    const wf = nextId(), nodeId = "t_busy_files_cap";
    makeAutomation({ workflowId: wf, nodeId, params: {
      [NODE_TRIGGER_KIND_PARAM_KEY]: "file", [NODE_TRIGGER_PATHS_PARAM_KEY]: "cap-*.md",
      [NODE_TRIGGER_DEBOUNCE_PARAM_KEY]: 0, task: "忙时攒太多也要有界",
    } });
    const runner = await startRunner();
    await runner.runNow(wf, nodeId);
    const sessionId = runsOfNode(nodeId)[0]!.sessionId;
    const key = `${wf}:${nodeId}`;
    const LIMIT = 500;
    setRunBusy(sessionId, true);
    try {
      // 第一个忙窗口:灌 502 个 → 队列停在 500、`overflowDropped`=2。
      for (let i = 0; i < LIMIT + 2; i += 1) {
        const name = `cap-${String(i).padStart(4, "0")}.md`;
        writeFileSync(join(PROJ_DIR, name), `# ${i}`);
        runner.onFsChange(PROJ_DIR, name);
      }
      await sleep(600);
      const p1 = runner.pendingFires.get(key);
      eq("第一个忙窗口就按上限收口", p1?.files.length ?? -1, LIMIT);
      // ⚠️ 只断言**下界** —— 项目目录挂真 `fs.watch`,刚写的 502 个文件会产生真实
      // `rename` 事件,把已被挤掉的早期文件又送一遍,丢的条数会再多几条(平台时序不稳)。
      // 下界已能区分修复:旧代码根本不应用上限,`files.length` 会 > LIMIT(上一条就红)。
      check("第一个忙窗口记下丢的条数(下界)", (p1?.overflowDropped ?? 0) >= 2, p1?.overflowDropped);

      // 后续忙窗口:再灌 50 个**新**路径 —— 旧代码会把它们整批并上去 → 队列变 550;
      // 修复后 `mergeFileBacklog` 应用同一上限 → 队列仍 500,且这 50 条算挤掉、累加进计数。
      for (let i = 0; i < 50; i += 1) {
        const name = `cap-late-${String(i).padStart(4, "0")}.md`;
        writeFileSync(join(PROJ_DIR, name), `# late ${i}`);
        runner.onFsChange(PROJ_DIR, name);
      }
      await sleep(600);
      const p2 = runner.pendingFires.get(key);
      eq("★ 忙时跨窗口重排队后队列仍停在上限(不再无界增长)", p2?.files.length ?? -1, LIMIT);
      check("★ 后续窗口挤掉的 50 条也累加进 overflowDropped(不静默丢)", (p2?.overflowDropped ?? 0) >= 52, p2?.overflowDropped);

      setRunBusy(sessionId, false); await sleep(1300);
      // 收口的这一批:交给模型的文件数仍恰好是上限,且载荷如实报截断。
      const files2 = runsOfNode(nodeId)[1]?.entry?.payload?.files as string[] | undefined;
      eq("交出去的文件数仍是上限", files2?.length ?? -1, LIMIT);
      check("载荷事实带上了忙时累计丢的条数", ((runsOfNode(nodeId)[1]?.entry?.payload?.overflowDropped as number | undefined) ?? 0) >= 52, runsOfNode(nodeId)[1]?.entry?.payload?.overflowDropped);
    } finally { setRunBusy(sessionId, false); runner.dispose(); }
  }

  /* ── 【MC-091 续】积压丢弃的**持久恢复游标**(`automation.droppedUndelivered`) ──
   *
   * `pending.overflowDropped` 只活在**内存**的 pending 上:应用在合并窗口里重启、或攒着
   * 的那一批被配置改动 / 用户取消作废时,它整份消失 —— "丢了几条"静默没了。修复把这些
   * 丢弃**落盘**成一张欠账表(`触发器 key → {count, at}`),下一次真正**派发**的运行把它
   * 并进载荷事实、随后清账;事实表那一栏(界面)也读得到。这里分三段验:
   *
   *  1. **落盘**:一批文件 churn 丢了几条 → 盘上出现欠账、数量对得上、没有丢时不落键。
   *  2. **不在派发前被清**:忙时重排队(没真的派发)不清账;真的派发那一次把欠账并进载荷。
   *  3. **跨重启交付**:攒了欠账 → `dispose` → 新 runner `start()` 读回 → 下一次派发把
   *     "上次丢的"并进载荷、账清零。
   */
  {
    resetRuns();
    SettingRepo.set(DROPPED_KEY, "{}"); // 场景干净起步(表跨场景活着)
    const wf = nextId(), nodeId = "t_dropped_cursor";
    makeAutomation({ workflowId: wf, nodeId, params: {
      [NODE_TRIGGER_KIND_PARAM_KEY]: "file", [NODE_TRIGGER_PATHS_PARAM_KEY]: "cur-*.md",
      [NODE_TRIGGER_DEBOUNCE_PARAM_KEY]: 0, task: "丢弃要有可恢复的账",
    } });
    const key = `${wf}:${nodeId}`;
    const LIMIT = 500;
    let runner = await startRunner();
    await runner.runNow(wf, nodeId); // 起一次,让后台会话存在(下一条 runNow 会被判忙)
    const busySession = runsOfNode(nodeId)[0]!.sessionId;
    const flushTick = (): void => (runner as unknown as { onTick(): void }).onTick();

    // ---- ① 忙时攒爆:丢弃落盘,**忙时重排队不清账** ----
    // 先把会话置忙,合并窗口收口时 `fire` 走忙时分支(只重排队、不派发)—— 这一路**不能**
    // 清掉欠账;等解忙后真的派发那一次才把钱并进载荷、清账。
    setRunBusy(busySession, true);
    try {
      // 真实 fs.watch 会额外送一些 rename 事件,所以计数只断言**下界**。
      for (let i = 0; i < LIMIT + 2; i += 1) {
        const name = `cur-${String(i).padStart(4, "0")}.md`;
        writeFileSync(join(PROJ_DIR, name), `# ${i}`);
        runner.onFsChange(PROJ_DIR, name);
      }
      await sleep(1000); // 越过合并窗口,忙时分支重排一次
      check("丢弃记进了内存欠账表", (runner.droppedUndelivered.get(key)?.count ?? 0) >= 2, runner.droppedUndelivered.get(key));
      check("★ 忙时重排队不清掉欠账(那一批还没交付)", (runner.droppedUndelivered.get(key)?.count ?? 0) >= 2, runner.droppedUndelivered.get(key));
      flushTick(); // 等价于 30 秒节流到点,强制冲刷
      check("★ 丢弃落进了 settings(恢复游标)", (droppedOnDisk()[key]?.count ?? 0) >= 2, droppedOnDisk());
      check("事实栏读出未交付丢弃", (runner.statusOf(wf)[0]?.droppedUndelivered ?? 0) >= 2, runner.statusOf(wf));
    } finally { setRunBusy(busySession, false); }
    // 解忙后等到真的派发 —— 那次运行把欠账并进载荷、随后清账(忙时退避最多到 2000ms)。
    await sleep(3500);
    const delivered = runsOfNode(nodeId).at(-1);
    check(
      "★ 真的派发那一次:欠账并进了载荷事实",
      ((delivered?.entry?.payload?.overflowDropped as number | undefined) ?? 0) >= 2,
      delivered?.entry?.payload,
    );
    eq("派发后欠账清零(内存)", runner.droppedUndelivered.get(key)?.count ?? 0, 0);
    flushTick();
    check("派发后欠账从盘上清掉", (droppedOnDisk()[key]?.count ?? 0) === 0, droppedOnDisk()[key]);
    runner.dispose();

    // ---- ② 跨重启交付:攒欠账 → dispose(合并窗口里重启)→ 新 runner 读回 → 派发并进载荷 ----
    resetRuns();
    runner = await startRunner();
    await runner.runNow(wf, nodeId); // 建后台会话(它的 session id 也就此固定)
    const session2 = runsOfNode(nodeId).at(-1)!.sessionId;
    setRunBusy(session2, true);
    for (let i = 0; i < LIMIT + 2; i += 1) {
      const name = `cur-r2-${String(i).padStart(4, "0")}.md`;
      writeFileSync(join(PROJ_DIR, name), `# ${i}`);
      runner.onFsChange(PROJ_DIR, name);
    }
    runner.dispose(); // 强制冲刷欠账到盘(模拟"应用在合并窗口里被杀")
    setRunBusy(session2, false); // 桩的忙集是模块级、跨 runner 活着,复位后再起新 runner
    const persisted = droppedOnDisk()[key]?.count ?? 0;
    check("★ 重启前欠账已落盘(dispose 强制冲刷)", persisted >= 2, droppedOnDisk()[key]);

    // 新进程读回 —— 起点处 `start()` 会把这张表读进来。
    runner = await startRunner();
    check("★ 新 runner 从盘上读回了欠账(恢复游标)", (runner.droppedUndelivered.get(key)?.count ?? 0) >= 2, runner.droppedUndelivered.get(key));
    // 让这条**文件**触发器再来一次收口(欠账只由数据承载的文件 / 事件载荷交付,不塞给手动)——
    // 那次 `fire` 把上次欠的账并进载荷、随后清账。
    const beforeDispatch = runsOfNode(nodeId).length;
    writeFileSync(join(PROJ_DIR, "cur-restart.md"), "# 重启后的新变化");
    runner.onFsChange(PROJ_DIR, "cur-restart.md");
    await sleep(FLUSH_SLACK_MS);
    const lastRun = runsOfNode(nodeId).at(-1);
    check("重启后确实又派发了一次", runsOfNode(nodeId).length > beforeDispatch, runsOfNode(nodeId).length);
    check("★ 重启后的派发把上次欠的账并进载荷", ((lastRun?.entry?.payload?.overflowDropped as number | undefined) ?? 0) >= 2, lastRun?.entry?.payload);
    eq("重启后派发完毕欠账清零", runner.droppedUndelivered.get(key)?.count ?? 0, 0);
    runner.dispose();
  }

  /* ── 【MC-091 续·E2】清账**晚于**真正派发 —— 派发路上抛错时欠账必须原样留着 ──
   *
   * 上面三段验的是"账记得对、并得进载荷、跨重启读得回",但都建立在"这次运行真的派发了"
   * 之上。复核点名的 E2 窗口是:清账写在 `runtimeManager.bindSession` / `SettingRepo.set
   * (EVENT_CHAIN_PREFIX + ...)` / 建 `startWorkflowRun` **之前** —— 那几步任意一步抛,
   * `fire` 走 catch 返回 `{ok:false}`,而这笔欠账**已经被清掉了**,那两条丢弃就永久静默
   * 丢了(盘上也清了)。修复把 drain 挪到 `startWorkflowRun(...).finally(settleClaim)` 之后。
   *
   * 造法:让 `SettingRepo.set` 对**本次会话的 EVENT_CHAIN 键**抛一次 —— 那正是 fire 里
   * 载荷已并、账未清的那两步之间。`buildTriggers` 的 reload 不写这个键,所以只有派发那一次
   * 命中。断言:运行没派发 + 内存账还在 + 盘上账还在(不是"跑绿算完",是它真没被吞)。
   */
  {
    resetRuns();
    SettingRepo.set(DROPPED_KEY, "{}");
    const wf = nextId(), nodeId = "t_drop_predispatch_fail";
    makeAutomation({ workflowId: wf, nodeId, params: {
      [NODE_TRIGGER_KIND_PARAM_KEY]: "file", [NODE_TRIGGER_PATHS_PARAM_KEY]: "e2-*.md",
      [NODE_TRIGGER_DEBOUNCE_PARAM_KEY]: 0, task: "派发前抛错不能吞掉欠账",
    } });
    const key = `${wf}:${nodeId}`;
    const runner = await startRunner();
    await runner.runNow(wf, nodeId); // 建后台会话(随后按它的 id 精确注入)
    const sessionId = runsOfNode(nodeId)[0]!.sessionId;
    const chainKey = `automation.eventChain.${sessionId}`;
    const flushTick = (): void => (runner as unknown as { onTick(): void }).onTick();

    // 攒一笔欠账(忙时重排队那条路只进账、不派发)。
    setRunBusy(sessionId, true);
    for (let i = 0; i < 502; i += 1) {
      const name = `e2-${String(i).padStart(4, "0")}.md`;
      writeFileSync(join(PROJ_DIR, name), `# ${i}`);
      runner.onFsChange(PROJ_DIR, name);
    }
    await sleep(1000); // 越过合并窗口 → 忙时分支重排
    const owed = runner.droppedUndelivered.get(key)?.count ?? 0;
    check("E2 场景先攒出一笔欠账", owed >= 1, runner.droppedUndelivered.get(key));
    flushTick();
    setRunBusy(sessionId, false);

    // 解忙 → 等它真的派发,但这次派发会在 EVENT_CHAIN 那一步抛。
    const before = runsOfNode(nodeId).length;
    const originalSet = SettingRepo.set;
    SettingRepo.set = (k, value) => {
      if (k === chainKey) throw new Error("injected dispatch-phase write failure");
      return originalSet.call(SettingRepo, k, value);
    };
    try {
      await sleep(3500); // 覆盖忙时退避(最多 2000ms)+ 合并窗口
      eq("E2 派发确实失败了(没有新运行)", runsOfNode(nodeId).length, before);
      eq("★ E2 派发前抛错时内存欠账还在(没被提前清)", runner.droppedUndelivered.get(key)?.count ?? 0, owed);
      check("★ E2 账没从盘上被提前清掉", (droppedOnDisk()[key]?.count ?? 0) >= owed, droppedOnDisk()[key]);
    } finally {
      SettingRepo.set = originalSet;
      runner.dispose();
    }
  }

  /* ── 【MC-091 续·全局背压】整台机器攒着的条目**总量**也有上界(不是只有单条那一路有界) ──
   *
   * `PENDING_FILES_LIMIT`(每格文件 500)与 `MAX_EVENT_ITEMS`(每批事件 100)**各自只管**
   * 一条触发器:几十条自动化被同一条抖动目录一起灌满时,总量 = 触发器数 × 单条上限,而这个
   * 乘积**没有任何上界**。修复给整个执行器一张预算(`GLOBAL_PENDING_LIMIT = 5000`):任一条
   * 要收**新**条目之前先问「现在还放得下吗」,放不下就**不收这一条**,并把丢弃如实记进
   * **恢复游标**(不是静默丢)。
   *
   * 造法:(a) **独立项目目录** —— 前面的用例都在共享的 `PROJ_DIR` 里,残留的 `*.md` / `**`
   * 触发器会和本用例的触发器一起攒(整场实测峰值 ~3500),把全局预算搅浑;这里单开一个目录,
   * 残留触发器(`cwd` 不匹配)一条都不会被喂到,于是攒着的总量**只**来自本用例。
   * (b) 12 条触发器 × 460 个文件 = 5520 > 5000,而**每条只 460 < 500**(单条一路一次都不丢)
   * —— 唯一被触发的就是全局那一层。
   * 判据:①攒着的总量停在上限(不再等于 5520);②触顶后的丢弃**如实记了账**(> 0)。
   * 撤掉全局闸门,①②各会红(量变 5520、账变 0),精确复现「单条有界、整体无界」。
   */
  {
    resetRuns();
    SettingRepo.set(DROPPED_KEY, "{}");
    const GLOBAL_LIMIT = 5000; // 实现里那个私有常量(故意不 import,理由见 FLUSH_SLACK_MS)
    const TRIGGERS = 12;
    const FILES = 460; // 12 × 460 = 5520 > 5000;每条 460 < 500(不触发单条上限)
    const gpProjectId = "p_global_bp";
    const gpDir = join(process.env.MCODE_SMOKE_DATA_ROOT!, "global-bp-project");
    mkdirSync(gpDir, { recursive: true });
    ProjectRepo.create({ ...ProjectRepo.get(PROJ_ID)!, id: gpProjectId, path: gpDir });
    const nodeId = "t_global_backpressure";
    for (let t = 0; t < TRIGGERS; t += 1) {
      makeAutomation({ workflowId: nextId(), nodeId, params: {
        [NODE_TRIGGER_PROJECT_PARAM_KEY]: gpProjectId,
        [NODE_TRIGGER_KIND_PARAM_KEY]: "file", [NODE_TRIGGER_PATHS_PARAM_KEY]: "gg-*.md",
        // 合并窗口开得极大 —— 攒着的那几格整场都不收口,好让总量**只涨不落**,量得出上界。
        [NODE_TRIGGER_DEBOUNCE_PARAM_KEY]: 3_600_000, task: "全局背压要有上界",
      } });
    }
    const runner = await startRunner();
    try {
      for (let i = 0; i < FILES; i += 1) {
        const name = `gg-${String(i).padStart(4, "0")}.md`;
        writeFileSync(join(gpDir, name), `# ${i}`);
        // 一次 onFsChange 会把这一条喂给**本用例的每一条**文件触发器(同目录同 glob);
        // 残留触发器 `cwd` 不匹配,一条都不会被喂到。
        runner.onFsChange(gpDir, name);
      }
      const held = runner.pendingItemsHeld();
      check("★ 全局背压:所有触发器攒着的条目总数不超过全局上限", held <= GLOBAL_LIMIT, held);
      // 没有全局闸门时 held 会是 12×460=5520(每条都够不着单条上限,单条一路一次都不丢),
      // 所以这一条正是全局那一层独有的可观察量。
      const owed = [...runner.droppedUndelivered.values()].reduce((n, d) => n + d.count, 0);
      check("★ 全局背压:触顶后新条目不再进来,丢弃如实记账(不静默)", owed > 0, owed);
    } finally {
      runner.dispose();
      SettingRepo.set(DROPPED_KEY, "{}"); // 别把这一场的欠账留给后续场景
    }
  }

  /* ── 【MC-091 续·全局背压·事件那一路】一条吐不同 itemId 的事件流 × 多条触发器,总量同样有界 ──
   *
   * 台账原话点名的是「事件批 `mergeEventPayload` 将所有不同 itemId 的条目无界放大」。单条
   * 那一路已经有 `MAX_EVENT_ITEMS = 100` 的每批上限,但**几十条事件触发器**同时被同一股事件流
   * 喂饱时,总量仍是 触发器数 × 100 —— 那正是全局这一层要兜的。这里 60 条事件触发器(每条
   * 各自攒满 100)总量 6000 > 5000;`mergeEventInto` 向 `admitGlobal` 要额度,额度用尽后
   * **新条目不再进任何一格**,并把丢弃如实记进恢复游标。
   *
   * 注意事件**不按项目目录过滤**(触发器订的是事件名),所以这里不假装隔离:残留的事件触发器
   * 会一起攒(推高了 held),但那只会让"总量触顶"这件事更早发生,两条判据(≤上限、账 > 0)
   * 依旧成立且仍能判别修复 —— 没有全局闸门时 held 会是**所有**匹配触发器 × 100 的乘积。
   */
  {
    resetRuns();
    SettingRepo.set(DROPPED_KEY, "{}");
    const GLOBAL_LIMIT = 5000; // 同实现里那个私有常量
    const TRIGGERS = 60;
    const ITEMS = 150; // 每条各自能攒到 100 的上限;60×100=6000 > 5000
    const nodeId = "t_global_bp_event";
    for (let t = 0; t < TRIGGERS; t += 1) {
      makeAutomation({ workflowId: nextId(), nodeId, params: {
        [NODE_TRIGGER_KIND_PARAM_KEY]: "event",
        [NODE_TRIGGER_EVENTS_PARAM_KEY]: "library.item.downloaded",
        // 合并窗口极大 —— 攒着的那几格整场都不收口,好让总量**只涨不落**。
        [NODE_TRIGGER_DEBOUNCE_PARAM_KEY]: 3_600_000, task: "事件那一路的全局背压",
      } });
    }
    const runner = await startRunner();
    const emit = (itemId: string): void => runtimeManager.emit({
      type: "library.item.downloaded", sessionId: "(system)", itemId, title: itemId, pdfPath: `g/${itemId}.pdf`,
    } as unknown as RuntimeEvent);
    try {
      for (let i = 0; i < ITEMS; i += 1) emit(`bpg_${i}`);
      const held = runner.pendingItemsHeld();
      check("★ 全局背压(事件):所有触发器攒着的事件条目总数不超过全局上限", held <= GLOBAL_LIMIT, held);
      const owed = [...runner.droppedUndelivered.values()].reduce((n, d) => n + d.count, 0);
      check("★ 全局背压(事件):触顶后新条目不再进来,丢弃如实记账(不静默)", owed > 0, owed);
    } finally {
      runner.dispose();
      SettingRepo.set(DROPPED_KEY, "{}");
    }
  }

  /* ── 【MC-091 续·启动竞态】读盘那份欠账表必须**并入**内存,不能覆盖 ──
   *
   * 现在 `start()` 把三张跨重启的表读回来**放在订阅事件之前**(见那里的「启动竞态」注释),
   * 但更硬的一层保险在 `readDroppedUndelivered` 自己:它把盘上的历史欠账与**内存里已经有
   * 的**(启动窗口里记下的)那一笔**相加**,而不是整份覆盖。这里直接钉住这条语义:内存有 5、
   * 盘上有 3、同键 → 读回来是 8(两笔都还没交付);覆盖式的写法会得到 3(内存那笔被吃掉)。
   */
  {
    resetRuns();
    SettingRepo.set(DROPPED_KEY, "{}");
    const runner = await startRunner();
    try {
      const key = `${nextId()}:t_e3_merge`;
      // 盘上:历史欠账 3 条。
      SettingRepo.set(DROPPED_KEY, JSON.stringify({ [key]: { count: 3, at: 1000 } }));
      // 内存:模拟"启动窗口里已经记下的一笔"5 条(先于这次读盘)。
      runner.droppedUndelivered.set(key, { count: 5, at: 2000 });
      const merged = runner.readDroppedUndelivered();
      eq("★ 读盘并入内存(不覆盖):两笔未交付欠账相加", merged.get(key)?.count, 8);
    } finally {
      runner.dispose();
      SettingRepo.set(DROPPED_KEY, "{}");
    }
  }

  /* ── 忙时回看间隔按指数退避增长(不是每秒重扫一遍) ──
   *
   * `BUSY_RETRY_MIN_MS` 那段注释白纸黑字写着"指数退避到半分钟封顶",而它的实现靠
   * `PendingFire.busyRetryMs` 在**同一条 pending** 上累乘。可 `rearm` 的计时器回调
   * **先删掉**那一格(`pendingFires.delete`)再调 `fire()` —— 于是 `fire` 的忙时分支
   * 走 `pendingOf` 建的是**全新**的一格,`busyRetryMs` 每次都被重置成 undefined,
   * 回看间隔永远停在 1 秒:一次跑几小时的自动化仍然每秒一遍"读工作流 + 查会话 +
   * 问活跃",而那正是退避要挡掉的东西。 */
  {
    resetRuns();
    const wf = nextId(), nodeId = "t_busy_backoff";
    makeAutomation({ workflowId: wf, nodeId, params: {
      [NODE_TRIGGER_KIND_PARAM_KEY]: "file", [NODE_TRIGGER_PATHS_PARAM_KEY]: "backoff-*.md",
      [NODE_TRIGGER_DEBOUNCE_PARAM_KEY]: 0, task: "忙时回看间隔要退避",
    } });
    const runner = await startRunner();
    await runner.runNow(wf, nodeId);
    const sessionId = runsOfNode(nodeId)[0]!.sessionId;
    const key = `${wf}:${nodeId}`;
    setRunBusy(sessionId, true);
    try {
      writeFileSync(join(PROJ_DIR, "backoff-a.md"), "a");
      runner.onFsChange(PROJ_DIR, "backoff-a.md");
      // 第一次忙时回看:合并窗口(WATCH_SETTLE_MS=300)+ 下限(1000)之后。
      await sleep(600);
      const first = runner.pendingFires.get(key)?.busyRetryMs;
      eq("忙时第一批:第一次回看间隔是下限", first, 1000);
      // 再等一轮 —— 修复后退避该翻倍;坏的那份每次重置回 1000。
      await sleep(1100);
      const second = runner.pendingFires.get(key)?.busyRetryMs;
      check("忙时回看间隔按指数退避增长(第二轮比第一轮长)", (second ?? 0) > (first ?? 0), { first, second });
      eq("退避期间那一批仍然攒着,没丢", runner.pendingFires.get(key)?.files.length, 1);
    } finally { setRunBusy(sessionId, false); runner.dispose(); }
  }


  /* Project changes must not resume a provider conversation from another project. */
  {
    resetRuns();
    const wf = nextId(), nodeId = "t_project_identity";
    const projectB = PROJ_ID + "_identity_B";
    const dirB = join(process.env.MCODE_SMOKE_DATA_ROOT!, "identity-B");
    mkdirSync(dirB, { recursive: true });
    ProjectRepo.create({ ...ProjectRepo.get(PROJ_ID)!, id: projectB, path: dirB });
    const params = { [NODE_TRIGGER_KIND_PARAM_KEY]: "event", [NODE_TRIGGER_EVENTS_PARAM_KEY]: "library.item.downloaded", task: "隔离项目上下文" };
    makeAutomation({ workflowId: wf, nodeId, params });
    const runner = await startRunner();
    let a = "", b = "";
    const switchTo = async (projectId: string): Promise<void> => {
      makeAutomation({ workflowId: wf, nodeId, params: { ...params, [NODE_TRIGGER_PROJECT_PARAM_KEY]: projectId } });
      await runner.reloadAll();
    };
    try {
      eq("A 首次运行成功", (await runner.runNow(wf, nodeId)).ok, true);
      a = runsOfNode(nodeId).at(-1)!.sessionId;
      await runner.runNow(wf, nodeId);
      eq("A 内重复运行复用会话", runsOfNode(nodeId).at(-1)?.sessionId, a);
      await switchTo(projectB);
      setRunBusy(a, true);
      eq("切换 B 不绕过仍在 A 运行的工作流", (await runner.runNow(wf, nodeId)).ok, false);
      eq("忙时没有多派发运行", runsOfNode(nodeId).length, 2);
      setRunBusy(a, false);
      await runner.runNow(wf, nodeId);
      b = runsOfNode(nodeId).at(-1)!.sessionId;
      check("B 不继承 A 的提供方会话和节点上下文", b !== a, {a,b});
      eq("B 会话项目归属正确", SessionRepo.get(b)?.projectId, projectB);
      eq("B 实际工作目录正确", runsOfNode(nodeId).at(-1)?.cwd, dirB);
      eq("A 历史会话没有被改写归属", SessionRepo.get(a)?.projectId, PROJ_ID);
      await switchTo(PROJ_ID);
      await runner.runNow(wf, nodeId);
      eq("切回 A 认回原会话", runsOfNode(nodeId).at(-1)?.sessionId, a);
      await switchTo("");
      await runner.runNow(wf, nodeId);
      const system = runsOfNode(nodeId).at(-1)!.sessionId;
      eq("无项目事件归入系统项目而非借用 A", SessionRepo.get(system)?.projectId, SYSTEM_AUTOMATION_PROJECT_ID);
      check("系统会话独立于 A/B", system !== a && system !== b, system);
      // 不是 process.cwd():打包后那是 `/` 或安装目录(见 automationRunner)。
      eq("无项目事件使用用户主目录", runsOfNode(nodeId).at(-1)?.cwd, (await import("node:os")).homedir());
      await runner.runNow(wf, nodeId);
      eq("无项目重复运行复用系统会话", runsOfNode(nodeId).at(-1)?.sessionId, system);
      // 老版本把 process.cwd() 存进了系统项目;复用会话(不新建)也得校正过来。
      ProjectRepo.setSystemAutomationPath("/stale-legacy-cwd");
      await runner.runNow(wf, nodeId);
      eq("复用系统会话时校正老版本存坏的路径", ProjectRepo.get(SYSTEM_AUTOMATION_PROJECT_ID)?.path, (await import("node:os")).homedir());
      eq("校正路径不换会话", runsOfNode(nodeId).at(-1)?.sessionId, system);
      await switchTo(projectB);
      await runner.runNow(wf, nodeId);
      eq("离开系统项目后认回 B 的会话", runsOfNode(nodeId).at(-1)?.sessionId, b);

      // An idle newer row must not hide a still-running older row.
      SessionRepo.create({ ...SessionRepo.get(a)!, id: "s_project_identity_newer", projectId: PROJ_ID, updatedAt: Date.now() + 99999 });
      setRunBusy(a, true);
      eq("最新会话空闲也不能掩盖旧项目运行", (await runner.runNow(wf, nodeId)).ok, false);
      setRunBusy(a, false);

      WorkflowRepo.save(getBuiltinWorkflow(WATCH_WORKFLOW_ID)!);
      const originA = "s_watch_origin_A", originB = "s_watch_origin_B";
      SessionRepo.create({ ...SessionRepo.get(a)!, id: originA, kind: "chat", workflowId: "", parentSessionId: null });
      SessionRepo.create({ ...SessionRepo.get(b)!, id: originB, projectId: projectB, kind: "chat", workflowId: "", parentSessionId: null });
      eq("A 守望启动", (await runner.startWatch({ originSessionId: originA, command: "echo A" })).ok, true);
      const watchA = runs.at(-1)!.sessionId;
      setRunBusy(watchA, true);
      try {
        SessionRepo.create({ ...SessionRepo.get(watchA)!, id: "s_watch_newer_idle", projectId: PROJ_ID, parentSessionId: null, updatedAt: Date.now() + 99999 });
        const before = JSON.stringify(getWorkflow(WATCH_WORKFLOW_ID));
        eq("旧项目守望仍运行时拒绝 B", (await runner.startWatch({ originSessionId: originB, command: "echo B" })).ok, false);
        eq("拒绝 B 前不改写守望模板", JSON.stringify(getWorkflow(WATCH_WORKFLOW_ID)), before);
        eq("拒绝 B 不改写 A 的发起会话", SessionRepo.get(watchA)?.parentSessionId, originA);
        eq("A 面板仍能看到守望正在运行", runner.activeWatchOf(originA), true);
      } finally { setRunBusy(watchA, false); }
      eq("A 结束后 B 守望可启动", (await runner.startWatch({ originSessionId: originB, command: "echo B" })).ok, true);
      const watchB = runs.at(-1)!.sessionId;
      check("跨项目守望使用不同后台会话", watchA !== watchB, {watchA,watchB});
      eq("B 守望项目归属", SessionRepo.get(watchB)?.projectId, projectB);
      eq("B 守望发起会话", SessionRepo.get(watchB)?.parentSessionId, originB);
      eq("B 守望工作目录", runs.at(-1)?.cwd, dirB);
      await runner.reloadAll();
      eq("普通手动入口可在守望完成后起跑", (await runner.runNow(WATCH_WORKFLOW_ID, WATCH_TRIGGER_NODE_ID)).ok, true);
      eq("普通手动入口不沿用上一次守望发起人", SessionRepo.get(runs.at(-1)!.sessionId)?.parentSessionId, null);

    } finally { setRunBusy(a, false); setRunBusy(b, false); runner.dispose(); }
  }


  /* Self-origin event runs share a workflow-wide, persisted ten-run budget. */
  {
    resetRuns();
    const wf = nextId(), nodeId = "t_self_budget";
    const key = `automation.selfTriggerCount.${wf}`;
    const params = { [NODE_TRIGGER_KIND_PARAM_KEY]: "event", [NODE_TRIGGER_EVENTS_PARAM_KEY]: "turn.done", [NODE_TRIGGER_DEBOUNCE_PARAM_KEY]: 0, task: "有限自动续跑" };
    makeAutomation({ workflowId: wf, nodeId, params });
    let runner = await startRunner();
    let sessionId = "";
    const emit = (id: string, reason: "end_turn" | "interrupted" = "end_turn"): void => runtimeManager.emit({ type: "turn.done", sessionId: id, reason, endedAt: Date.now() });
    try {
      await runner.runNow(wf, nodeId);
      sessionId = runsOfNode(nodeId)[0]!.sessionId;
      for (let i = 0; i < 5; i++) emit(sessionId);
      await sleep(50);
      eq("同窗口多条自身事件只派发一轮", runsOfNode(nodeId).length, 2);
      eq("合并事件只消耗一份额度", SettingRepo.get(key), "1");
      SessionRepo.create({ ...SessionRepo.get(sessionId)!, id: "s_self_child", kind: "node", parentSessionId: sessionId });
      SessionRepo.create({ ...SessionRepo.get(sessionId)!, id: "s_self_nested", kind: "side", parentSessionId: "s_self_child" });
      for (let i = 0; i < 9; i++) { emit(i % 2 ? "s_self_child" : "s_self_nested"); await sleep(30); }
      eq("所属节点/嵌套侧会话共同累计十轮自触发", runsOfNode(nodeId).length, 11);
      eq("十轮预算已保存", SettingRepo.get(key), "10");
      emit(sessionId); await sleep(40);
      eq("第十一轮自身事件不再启动", runsOfNode(nodeId).length, 11);
      check("停止原因向用户说明上限和手动恢复", runner.statusOf(wf)[0]?.lastError?.includes("10") === true && runner.statusOf(wf)[0]?.lastError?.includes("手动") === true, runner.statusOf(wf));
      const otherProjectId = wf + "_other_project";
      ProjectRepo.create({ ...ProjectRepo.get(PROJ_ID)!, id: otherProjectId });
      SessionRepo.create({ ...SessionRepo.get(sessionId)!, id: "s_self_other_project", projectId: otherProjectId });
      emit("s_self_other_project"); await sleep(30);
      eq("同工作流其他项目的后台会话共享上限", runsOfNode(nodeId).length, 11);
      SessionRepo.create({ ...SessionRepo.get(sessionId)!, id: "s_self_external_chat", kind: "chat", parentSessionId: null });
      emit("s_self_external_chat"); emit(sessionId); await sleep(40);
      eq("同一图的普通聊天事件仍属外部且不被阻断自身事件污染", runsOfNode(nodeId).length, 12);
      eq("外部事件不会偷偷重置自触发额度", SettingRepo.get(key), "10");
      setRunBusy(sessionId, true);
      eq("忙时手动点击被拒绝", (await runner.runNow(wf, nodeId)).ok, false);
      eq("被拒绝的手动点击不重置额度", SettingRepo.get(key), "10");
      setRunBusy(sessionId, false);
      await runner.reloadAll(); emit(sessionId); await sleep(40);
      eq("重载配置不会绕过上限", runsOfNode(nodeId).length, 12);
      runner.dispose(); runner = await startRunner();
      emit(sessionId); await sleep(40);
      eq("重建执行器不会绕过保存的上限", runsOfNode(nodeId).length, 12);
      eq("明确手动运行可恢复", (await runner.runNow(wf, nodeId)).ok, true);
      eq("手动运行重置自触发计数", SettingRepo.get(key), "0");
      runtimeManager.holdTurnEnd(sessionId); emit(sessionId); await sleep(30); runtimeManager.releaseTurnEnd(sessionId);
      eq("内部被扣住的完成事件不消耗额度", SettingRepo.get(key), "0");
      emit(sessionId); await sleep(40);
      eq("手动恢复后可再次自触发", runsOfNode(nodeId).length, 14);
      eq("恢复后从第一轮重新计数", SettingRepo.get(key), "1");
      emit(sessionId); emit(sessionId, "interrupted"); await sleep(40);
      eq("取消清除待派发自身事件", runsOfNode(nodeId).length, 14);
      eq("取消不自动重置额度", SettingRepo.get(key), "1");
      emit(sessionId);
      makeAutomation({ workflowId: wf, nodeId, params: { ...params, [NODE_TRIGGER_ENABLED_PARAM_KEY]: false } });
      await runner.reloadAll(); await sleep(30);
      eq("禁用清掉待派发自身事件", runsOfNode(nodeId).length, 14);
      makeAutomation({ workflowId: wf, nodeId, params }); await runner.reloadAll();
      eq("重新启用不重置计数", SettingRepo.get(key), "1");

      const saved = getWorkflow(wf)!;
      WorkflowRepo.save({ ...saved, nodes: [...saved.nodes, { ...saved.nodes[0]!, id: "t_self_budget_other" }] });
      await runner.reloadAll();
      SettingRepo.set(key, "9");
      const before = runs.filter(r => r.sessionId === sessionId).length;
      emit(sessionId); await sleep(50);
      eq("两个触发器争最后一份额度也最多派发一次", runs.filter(r => r.sessionId === sessionId).length - before, 1);
      eq("额度属于工作流而非某个触发器", SettingRepo.get(key), "10");
      WorkflowRepo.save(saved); await runner.reloadAll();

      SettingRepo.set(key, "invalid");
      const prior = runsOfNode(nodeId).length;
      emit(sessionId); await sleep(30);
      eq("计数损坏时保守阻止自触发", runsOfNode(nodeId).length, prior);
      eq("手动运行能恢复损坏的计数", (await runner.runNow(wf, nodeId)).ok, true);
      eq("损坏计数被明确手动重置", SettingRepo.get(key), "0");
      const originalSet = SettingRepo.set;
      SettingRepo.set = (k, value) => { if (k === key) throw new Error("injected self-budget write failure"); return originalSet.call(SettingRepo, k, value); };
      try { emit(sessionId); await sleep(40); }
      finally { SettingRepo.set = originalSet; }
      eq("计数写入失败不派发自触发运行", runsOfNode(nodeId).length, prior + 1);
    } finally { setRunBusy(sessionId, false); runtimeManager.releaseTurnEnd(sessionId); runner.dispose(); }
  }

  {
    resetRuns();
    const wf = nextId(), nodeId = "t_self_busy_data";
    const key = `automation.selfTriggerCount.${wf}`;
    makeAutomation({ workflowId: wf, nodeId, params: {
      [NODE_TRIGGER_KIND_PARAM_KEY]: "event", [NODE_TRIGGER_EVENTS_PARAM_KEY]: "library.item.downloaded", [NODE_TRIGGER_DEBOUNCE_PARAM_KEY]: 0, task: "忙时保持自触发来源",
    } });
    const runner = await startRunner();
    let sessionId = "";
    const emit = (source: string, itemId: string): void => runtimeManager.emit({ type: "library.item.downloaded", sessionId: source, itemId, title: itemId, pdfPath: `${itemId}.pdf` } as unknown as RuntimeEvent);
    try {
      await runner.runNow(wf, nodeId); sessionId = runsOfNode(nodeId)[0]!.sessionId;
      SettingRepo.set(key, "9"); setRunBusy(sessionId, true);
      emit(sessionId, "self-item"); await sleep(80);
      eq("忙时重试尚未消耗自触发额度", SettingRepo.get(key), "9");
      setRunBusy(sessionId, false); await sleep(1200);
      eq("空闲后合并数据派发一次", runsOfNode(nodeId).length, 2);
      eq("忙时重试保留自身来源并消耗最后一份额度", SettingRepo.get(key), "10");
      emit(sessionId, "blocked-item"); await sleep(50);
      eq("达到上限的自身数据事件不再启动", runsOfNode(nodeId).length, 2);
      eq("被阻止的自身事件不留下重试定时器", runner.pendingFires.has(`${wf}:${nodeId}`), false);
      emit("(system)", "external-item"); emit(sessionId, "blocked-item"); await sleep(50);
      eq("系统资料库事件仍能独立触发", runsOfNode(nodeId).length, 3);
      eq("阻止的自身条目不混入外部载荷", (runsOfNode(nodeId).at(-1)?.entry?.payload?.items as unknown[] | undefined)?.length, 1);
      await runner.runNow(wf, nodeId);
      emit(sessionId, "mixed-self"); emit("(system)", "mixed-external"); await sleep(50);
      eq("含自身和外部条目的混合批次仍计入额度", SettingRepo.get(key), "1");
      eq("未达到上限的混合批次不丢失条目", (runsOfNode(nodeId).at(-1)?.entry?.payload?.items as unknown[] | undefined)?.length, 2);
      SettingRepo.set(key, "9"); setRunBusy(sessionId, true);
      emit(sessionId, "waiting-self"); await sleep(80);
      const beforeRetry = runsOfNode(nodeId).length;
      SettingRepo.set(key, "10"); // Another trigger spends the last unit while this one waits.
      setRunBusy(sessionId, false); await sleep(1200);
      eq("等待期间额度耗尽时重试不得启动", runsOfNode(nodeId).length, beforeRetry);
      eq("额度耗尽后的重试批次被清理", runner.pendingFires.has(`${wf}:${nodeId}`), false);
      SettingRepo.set(key, "9"); setRunBusy(sessionId, true);
      emit(sessionId, "race-self"); emit("(system)", "race-external"); await sleep(80);
      const beforeMixedRetry = runsOfNode(nodeId).length;
      SettingRepo.set(key, "10"); setRunBusy(sessionId, false); await sleep(1200);
      eq("混合批次等待期间额度耗尽也不能吞掉外部条目", runsOfNode(nodeId).length, beforeMixedRetry + 1);
      eq("耗尽额度后只派发混合批次的外部部分", runsOfNode(nodeId).at(-1)?.entry?.payload?.itemId, "race-external");
      eq("外部部分派发不改变已耗尽计数", SettingRepo.get(key), "10");
      SettingRepo.set("smoke.selfTriggerWorkflow", wf);

    } finally { setRunBusy(sessionId, false); runner.dispose(); }
  }

  /* 事件触发器**没写 `project` 键**时不许被静默丢掉(2026-10-09)。`parseTriggerSpec` 对
   * 「事件发生时」故意允许缺项目(退回宿主目录),但它不会把缺的键补成空串 —— 而
   * `buildTriggers` 从前要求 `typeof projectId === "string"`,于是这种自动化命中 `continue`:
   * 不入 entries、不 log.warn、也不记 setup 事实,`automation:statusAll` 里连一行"为什么没挂上"
   * 都没有。用户看到一条参数填得好好的自动化永远不响、无迹可循(内置模板正是没写 project 的那种)。 */
  {
    resetRuns();
    const wf = nextId(), nodeId = "t_event_no_project";
    makeAutomation({ workflowId: wf, nodeId, params: {
      // 用 undefined 覆盖 `makeAutomation` 预置的 project —— 等价于"这个触发器没写 project 键"。
      [NODE_TRIGGER_PROJECT_PARAM_KEY]: undefined,
      [NODE_TRIGGER_KIND_PARAM_KEY]: "event",
      [NODE_TRIGGER_EVENTS_PARAM_KEY]: "library.item.downloaded",
      [NODE_TRIGGER_DEBOUNCE_PARAM_KEY]: 0,
      task: "没写项目的也要挂上",
    } });
    const runner = await startRunner();
    try {
      // ★ 进了事实表(挂上了)—— 静默丢弃时 `statusOf` 是空的。
      const status = runner.statusOf(wf);
      check("★ 没写 project 的事件触发器仍然进了事实表(不是静默丢弃)", status.length > 0, status);
      check("★ 也没被记成「没挂上」", !(status[0]?.lastError ?? "").length, status);
      // ★ 真的会响。
      runtimeManager.emit({ type: "library.item.downloaded", sessionId: "(system)", itemId: "no-proj", title: "no-proj", pdfPath: "no-proj.pdf" } as unknown as RuntimeEvent);
      await sleep(50);
      eq("★ 它真的被事件触发了(不是挂了却不响)", runsOfNode(nodeId).length, 1);
    } finally { runner.dispose(); }
  }

  /* 屏蔽只管给 AI 看的,不管自动化(2026-09-26 用户定的规矩)。屏蔽了 pdf,要的正是「只给
   * 模型看转录后的 md」—— 自动化不下载、不转录,那份 md 就永远不会有。同一天早些时候这里
   * 加过「被屏蔽的条目不触发」,与这条规矩正相反;这一段钉住它别再回来。 */
  {
    resetRuns();
    const wf = nextId(), nodeId = "t_suppressed_item";
    makeAutomation({ workflowId: wf, nodeId, params: {
      [NODE_TRIGGER_KIND_PARAM_KEY]: "event", [NODE_TRIGGER_EVENTS_PARAM_KEY]: "library.item.downloaded", [NODE_TRIGGER_DEBOUNCE_PARAM_KEY]: 0, task: "被屏蔽的条目也照常处理",
    } });
    const runner = await startRunner();
    const hidden = LibraryRepo.upsert({ title: "机密报告" });
    const visible = LibraryRepo.upsert({ title: "公开论文" });
    const secret = CollectionRepo.create("机密");
    CollectionRepo.assign(secret.id, [hidden.id], true);
    resetSuppressCacheForTest();
    saveSuppress({ nodes: [suppressNodeKey("collection", secret.id)], extensions: [".pdf"] });
    const emit = (itemId: string, title: string): void => runtimeManager.emit({ type: "library.item.downloaded", sessionId: "(system)", itemId, title, pdfPath: `${itemId}.pdf` } as unknown as RuntimeEvent);
    try {
      emit(hidden.id, hidden.title); emit(visible.id, visible.title); await sleep(50);
      eq("★ 被屏蔽的条目下载完照样触发(与同批的一起跑一次)", runsOfNode(nodeId).length, 1);
      const items = runsOfNode(nodeId).at(-1)?.entry?.payload?.items as Array<{ itemId?: string }> | undefined;
      check("★ 载荷里被屏蔽的那条也在", items?.length === 2 && items.some((i) => i.itemId === hidden.id), items);
      check("没有记成「被屏蔽跳过」", !(runner.statusOf(wf)[0]?.lastError ?? "").includes("屏蔽"), runner.statusOf(wf));
    } finally {
      saveSuppress({ nodes: [], extensions: [] });
      runner.dispose();
    }
  }


  /* Cross-workflow return edges consume the existing budget, not ordinary A -> B traffic. */
  {
    resetRuns();
    const a = nextId(), b = nextId(), nodeA = "t_cycle_A", nodeB = "t_cycle_B";
    const params = { [NODE_TRIGGER_KIND_PARAM_KEY]: "event", [NODE_TRIGGER_DEBOUNCE_PARAM_KEY]: 0, task: "跟踪工作流事件链" };
    makeAutomation({ workflowId: a, nodeId: nodeA, params: { ...params, [NODE_TRIGGER_EVENTS_PARAM_KEY]: "library.item.downloaded" } });
    makeAutomation({ workflowId: b, nodeId: nodeB, params: { ...params, [NODE_TRIGGER_EVENTS_PARAM_KEY]: "library.item.imported" } });
    const runner = await startRunner();
    const count = (wf: string): number => Number(SettingRepo.get(`automation.selfTriggerCount.${wf}`) ?? "0");
    const chainKey = (id: string): string => `automation.eventChain.${id}`;
    const chain = (id: string): string[] | undefined => {
      try { return (JSON.parse(SettingRepo.get(chainKey(id)) ?? "null") as { workflowIds?: string[] } | null)?.workflowIds; }
      catch { return undefined; }
    };
    const emit = (id: string, event: "library.item.imported" | "library.item.downloaded", itemId = "cycle-item"): void => runtimeManager.emit({ type: event, sessionId: id, itemId, title: itemId, pdfPath: `${itemId}.pdf` } as unknown as RuntimeEvent);
    let sa = "", sb = "";
    try {
      await runner.runNow(a, nodeA); sa = runsOfNode(nodeA).at(-1)!.sessionId;
      eq("手动起跑建立新的来源链根", JSON.stringify(chain(sa)), JSON.stringify([a]));
      for (let i = 0; i < 15; i++) { emit(sa, "library.item.imported"); await sleep(30); }
      sb = runsOfNode(nodeB).at(-1)!.sessionId;
      eq("正常A到B单向链超过十次仍可运行", runsOfNode(nodeB).length, 15);
      eq("正常单向链不消耗B的循环额度", count(b), 0);
      eq("B记住上游A而不只记直接来源", JSON.stringify(chain(sb)), JSON.stringify([a, b]));
      emit(sb, "library.item.downloaded"); await sleep(40);
      eq("B返回A时识别为回环", count(a), 1);
      for (let i = 0; i < 9; i++) {
        emit(sa, "library.item.imported"); await sleep(30);
        emit(sb, "library.item.downloaded"); await sleep(30);
      }
      emit(sa, "library.item.imported"); await sleep(30);
      eq("跨工作流回环累计A的十次额度", count(a), 10);
      eq("跨工作流回环也累计B的十次额度", count(b), 10);
      const beforeA = runsOfNode(nodeA).length, beforeB = runsOfNode(nodeB).length;
      emit(sb, "library.item.downloaded"); emit(sa, "library.item.imported"); await sleep(40);
      eq("达到上限后B不能再次启动A", runsOfNode(nodeA).length, beforeA);
      eq("达到上限后A不能再次启动B", runsOfNode(nodeB).length, beforeB);
      SessionRepo.create({ ...SessionRepo.get(sb)!, id: "s_cycle_B_node", kind: "node", parentSessionId: sb });
      emit("s_cycle_B_node", "library.item.downloaded"); await sleep(30);
      eq("B的节点会话不能绕过跨图回环保护", runsOfNode(nodeA).length, beforeA);
      emit("(system)", "library.item.downloaded", "new-root"); await sleep(40);
      eq("真正独立的外部事件仍允许启动A", runsOfNode(nodeA).length, beforeA + 1);
      eq("独立外部事件重建来源链而不继承旧祖先", JSON.stringify(chain(sa)), JSON.stringify([a]));
      eq("独立外部事件不重置循环额度", count(a), 10);
      emit(sa, "library.item.imported"); await sleep(40);
      eq("暂停循环后合法A到B新链仍可运行", runsOfNode(nodeB).length, beforeB + 1);

      // A mixed queued batch must not pass discarded cyclic ancestry to its external part.
      SettingRepo.set(`automation.selfTriggerCount.${a}`, "9"); setRunBusy(sa, true);
      emit(sb, "library.item.downloaded", "cycle-part"); emit("(system)", "library.item.downloaded", "external-part"); await sleep(80);
      SettingRepo.set(`automation.selfTriggerCount.${a}`, "10"); setRunBusy(sa, false); await sleep(1200);
      eq("循环额度耗尽后混合批次只派发外部条目", runsOfNode(nodeA).at(-1)?.entry?.payload?.itemId, "external-part");
      eq("混合批次退化为外部时也移除循环来源链", JSON.stringify(chain(sa)), JSON.stringify([a]));

      await runner.runNow(a, nodeA);
      SettingRepo.set(chainKey(sb), "{broken");
      const beforeBad = runsOfNode(nodeA).length;
      emit(sb, "library.item.downloaded"); await sleep(40);
      eq("已识别自动化的来源链损坏时不当作独立外部事件", runsOfNode(nodeA).length, beforeBad);
      check("来源链损坏给出可读原因", runner.statusOf(a)[0]?.lastError?.includes("来源链") === true, runner.statusOf(a));
      await runner.runNow(b, nodeB);
      eq("明确手动运行修复来源链", JSON.stringify(chain(sb)), JSON.stringify([b]));
      const tooLong = [...Array.from({length:63}, (_, i) => `ancestor_${i}`), b];
      SettingRepo.set(chainKey(sb), JSON.stringify({ version: 1, workflowIds: tooLong }));
      emit(sb, "library.item.downloaded"); await sleep(30);
      eq("超过64个不同工作流的链不继续扩张", runsOfNode(nodeA).length, beforeBad);
      check("链长上限原因可见", runner.statusOf(a)[0]?.lastError?.includes("64") === true, runner.statusOf(a));
      emit("(system)", "library.item.downloaded", "not-contaminated"); emit(sb, "library.item.downloaded", "too-long"); await sleep(40);
      eq("超长链不污染正常外部载荷", runsOfNode(nodeA).at(-1)?.entry?.payload?.itemId, "not-contaminated");

      await runner.runNow(a, nodeA);
      emit(sa, "library.item.imported"); await sleep(40);
      const c = nextId(), nodeC = "t_cycle_C";
      makeAutomation({ workflowId: c, nodeId: nodeC, params: { ...params, [NODE_TRIGGER_EVENTS_PARAM_KEY]: "turn.done" } });
      await runner.reloadAll();
      runtimeManager.emit({ type: "turn.done", sessionId: sb, reason: "end_turn", endedAt: Date.now() });
      await sleep(40);
      const sc = runsOfNode(nodeC).at(-1)!.sessionId;
      eq("三工作流链保留全部祖先", JSON.stringify(chain(sc)), JSON.stringify([a, b, c]));
      emit(sc, "library.item.downloaded"); await sleep(40);
      eq("A到B到C再回A同样消耗回环额度", count(a), 1);
      check("回到A后仍保留C以识别后续回环", chain(sa)?.includes(c) === true, chain(sa));
      SettingRepo.set(`automation.selfTriggerCount.${a}`, "10");
      SettingRepo.set("smoke.crossWorkflowChain", JSON.stringify({ workflowId: a, sessionId: sb, nodeId: nodeA }));
    } finally { setRunBusy(sa, false); runner.dispose(); }
  }

  /* An automation -> ordinary chat -> automation return is still a cycle. */
  {
    resetRuns();
    const wf = nextId(), nodeId = "t_injected_chat_return";
    makeAutomation({ workflowId: wf, nodeId, params: {
      [NODE_TRIGGER_KIND_PARAM_KEY]: "event", [NODE_TRIGGER_EVENTS_PARAM_KEY]: "turn.done", [NODE_TRIGGER_DEBOUNCE_PARAM_KEY]: 0, task: "注入普通聊天后的回环",
    } });
    const runner = await startRunner();
    const key = `automation.selfTriggerCount.${wf}`;
    try {
      await runner.runNow(wf, nodeId);
      const rootId = runsOfNode(nodeId)[0]!.sessionId;
      const chatId = `${rootId}_ordinary_chat`;
      SessionRepo.create({ ...SessionRepo.get(rootId)!, id: chatId, kind: "chat", parentSessionId: null });
      const injectedReply = withAutomationOrigin(e => runtimeManager.emit(e), { workflowIds: [wf] });
      for (let i = 0; i < 12; i++) {
        injectedReply({ type: "turn.done", sessionId: chatId, reason: "end_turn" });
        await sleep(30);
      }
      eq("普通聊天返回不能绕过十次回环额度", SettingRepo.get(key), "10");
      eq("十次注入返回后不再自动续跑", runsOfNode(nodeId).length, 11);
      check("注入返回达上限的原因可见", runner.statusOf(wf)[0]?.lastError?.includes("手动") === true);
      runtimeManager.emit({ type: "turn.done", sessionId: chatId, reason: "end_turn" });
      await sleep(30);
      eq("同一普通聊天的真实用户轮仍可独立触发", runsOfNode(nodeId).length, 12);
      eq("真实用户事件不偷偷重置回环额度", SettingRepo.get(key), "10");
      await runner.runNow(wf, nodeId);
      injectedReply({ type: "turn.done", sessionId: chatId, reason: "end_turn" });
      await sleep(30);
      eq("手动重置后注入返回可重新消费额度", SettingRepo.get(key), "1");
      SettingRepo.set(`automation.eventChain.${rootId}`, "broken-after-dispatch");
      injectedReply({ type: "turn.done", sessionId: rootId, reason: "end_turn" });
      await sleep(30);
      eq("已捕获的轮次来源不依赖后来覆盖的会话记录", SettingRepo.get(key), "2");
    } finally { runner.dispose(); }
  }

  /* More than 60 distinct workflows must not evict each other's same-minute keys. */
  {
    resetRuns();
    SettingRepo.set(LAST_MINUTE_KEY, "{}");
    const count = 72;
    const ids = Array.from({ length: count }, (_, i) => ({ workflowId: nextId(), nodeId: `t_bulk_schedule_${i}` }));
    const nodes = new Set(ids.map((v) => v.nodeId));
    const batchRuns = (): number => runs.filter((r) => nodes.has(r.entry?.nodeId ?? "")).length;
    for (const id of ids) makeAutomation({ ...id, params: {
      [NODE_TRIGGER_KIND_PARAM_KEY]: "schedule",
      [NODE_TRIGGER_CRON_PARAM_KEY]: EVERY_MINUTE,
      task: "同分钟至多一次派发",
    } });
    type Writable = RunnerInternals & { rememberLastMinute(key: string, minute: number | null): void };
    // ⚠️ 冻在 `minute` 再 start:`start()` 现在会当场 tick 一次(MC-021),72 条
    // `* * * * *` 会在启动那一刻全跑掉——若不冻住时钟,那一跳落在**真实当前分钟**上,
    // 于是这批触发器被真实分钟和 `minute` 各派发一次,后面所有计数翻倍。
    const minute = Math.floor(Date.now() / 60_000) + 10;
    let runner = await withClockAsync(minute * 60_000, () => startRunner()) as Writable;
    const allRemembered = (): boolean => ids.every(({workflowId,nodeId}) => runner.lastMinute.get(`${workflowId}:${nodeId}`) === minute);
    const allSaved = (): boolean => { const rows = onDisk(); return ids.every(({workflowId,nodeId}) => rows[`${workflowId}:${nodeId}`] === minute); };
    try {
      withClock(minute * 60_000, () => {
        // new Date() captures the tick's minute; Date.now() then observes a
        // later minute, simulating a large dispatch batch crossing the boundary.
        Date.now = () => (minute + 1) * 60_000;
        runner.onTick();
      });
      eq("72条独立定时自动化首次全部派发", batchRuns(), count);
      check("批次处理跨分钟仍保留tick捕获分钟的全部72条记录", allRemembered(), runner.lastMinute.size);
      check("72条本分钟记录全部保存", allSaved(), Object.keys(onDisk()).length);

      let writes = 0;
      const originalSet = SettingRepo.set;
      SettingRepo.set = (key, value) => { if (key === LAST_MINUTE_KEY) writes++; return originalSet.call(SettingRepo, key, value); };
      try { withClock(minute * 60_000 + 20_000, () => runner.onTick()); }
      finally { SettingRepo.set = originalSet; }
      eq("同分钟再次tick不重复派发任何任务", batchRuns(), count);
      eq("同分钟重复tick不重写去重表", writes, 0);

      withClock(minute * 60_000 + 25_000, () => {
        for (let i = 0; i < 80; i++) runner.rememberLastMinute(`retired:${i}`, minute - 1 - i);
      });
      check("历史清理不会挤掉本分钟记录", allRemembered() && allSaved(), runner.lastMinute.size);
      eq("额外历史记录仍限制为60条", [...runner.lastMinute.values()].filter((v) => v !== minute).length, 60);
      withClock(minute * 60_000 + 26_000, () => runner.rememberLastMinute("retired:0", null));
      eq("删除历史记录立即落盘", onDisk()["retired:0"], undefined);
      check("删除记录触发的写入也保留全部本分钟记录", allRemembered() && allSaved(), runner.lastMinute.size);

      runner.dispose();
      // 重启也要冻在 `minute`:`start()` 的启动 tick 会看本分钟,而 72 条的 `minute`
      // 去重记录刚从盘上恢复 —— 冻在同一分钟才会命中去重、不重复派发(这正是本节要验的)。
      runner = await withClockAsync(minute * 60_000, () => startRunner()) as Writable;
      check("重建执行器从settings恢复全部72条去重记录", allRemembered(), runner.lastMinute.size);
      withClock(minute * 60_000 + 40_000, () => runner.onTick());
      eq("重建执行器后同分钟不再派发", batchRuns(), count);
      withClock((minute + 1) * 60_000, () => runner.onTick());
      eq("下一分钟72条全部可以正常派发", batchRuns(), count * 2);
      withClock((minute + 1) * 60_000 + 20_000, () => runner.onTick());
      eq("下一分钟再次tick仍无重复", batchRuns(), count * 2);
      check("每个触发器两个分钟各一次", ids.every(({nodeId}) => runsOfNode(nodeId).length === 2), batchRuns());

      withClock((minute + 2) * 60_000, () => runner.rememberLastMinute("maintenance:current", minute + 2));
      eq("跨分钟后过期大批记录恢复60条历史上限", [...runner.lastMinute.values()].filter((v) => v !== minute + 2).length, 60);
      eq("清理后的保存表等于当前1条加历史60条", Object.keys(onDisk()).length, 61);
      check("最终内存与settings内容一致", JSON.stringify([...runner.lastMinute].sort()) === JSON.stringify(Object.entries(onDisk()).sort()), runner.lastMinute.size);
    } finally { runner.dispose(); }
  }

  /* ── MC-020 目录监听挂失败后有上限地自主重挂 ──
   *
   * 从前 `watcher === null` 只有 reload 会补挂,而 30 秒的 onTick 只看定时那一类 ——
   * 目录一坏(初始不存在 / 监听出错被关),不显式 reload 就**永远不响**。这条钉的是
   * "ticker 会给没挂上的目录排一次**有上限**的重挂,而不是每秒敲或永不重试"。 */
  {
    resetRuns();
    // 让这条自动化的**项目目录不存在** —— 监听就会挂失败,走进重挂那条路。
    const ghostPath = join(PROJ_DIR, "ghost-project-dir-does-not-exist");
    const ghostId = `proj_ghost_${Math.random().toString(36).slice(2, 7)}`;
    const now = Date.now();
    ProjectRepo.create({ id: ghostId, name: "幽灵项目", path: ghostPath, archived: false, group: null, sortOrder: 0, pinnedAt: null, createdAt: now, updatedAt: now });
    const wf = nextId();
    const nodeId = "t_watchretry";
    makeAutomation({ workflowId: wf, nodeId, params: {
      [NODE_TRIGGER_KIND_PARAM_KEY]: "file",
      [NODE_TRIGGER_PROJECT_PARAM_KEY]: ghostId,
      [NODE_TRIGGER_PATHS_PARAM_KEY]: "**",
      [NODE_TRIGGER_DEBOUNCE_PARAM_KEY]: 0,
      task: "目录回来之后该复活",
    } });
    const runner = await startRunner();
    try {
      const internals = runner as RunnerInternals & { watchers: Map<string, { watcher: unknown; nextRetryAt?: number; retryMs?: number }> };
      const entry = internals.watchers.get(ghostPath);
      check("不存在的目录也建了监听条目(不是静默消失)", entry !== undefined, [...internals.watchers.keys()]);
      if (entry !== undefined) {
        check("挂失败后条目记了退避时间(会自己再试)", typeof entry.nextRetryAt === "number", entry);
        check("退避间隔从下限起(≥30 秒,不是高频轮询)", (entry.retryMs ?? 0) >= 30_000, entry.retryMs);
        // 关键不变量:退避**到点之前**不动手。
        const before = entry.nextRetryAt!;
        withClock(before - 1000, () => (runner as unknown as { retryWatchers(): void }).retryWatchers());
        check("退避没到点 → 不重挂(不每秒敲)", internals.watchers.get(ghostPath)?.nextRetryAt === before, internals.watchers.get(ghostPath));

        /* ★ 恢复半边(台账要的"目录恢复→自动重挂"):目录**真的出现**后再到点,
         * ticker 必须把 watcher 挂回来 —— 而不是等到 reload/重启。从前只有 reload
         * 会补挂,目录修好后文件触发器长期不响。这里先造出目录,把时钟推到到点之后,
         * 跑 `retryWatchers`,断言 watcher 从 null 变成活对象、退避状态被清掉。 */
        check("恢复前:watcher 是 null(确实没挂上)", internals.watchers.get(ghostPath)?.watcher === null, internals.watchers.get(ghostPath)?.watcher);
        mkdirSync(ghostPath, { recursive: true });
        withClock(before + 1000, () => (runner as unknown as { retryWatchers(): void }).retryWatchers());
        const recovered = internals.watchers.get(ghostPath);
        check("★ 目录恢复且退避到点 → ticker 把 watcher **挂回来了**(不靠 reload)", recovered?.watcher !== null && recovered?.watcher !== undefined, recovered?.watcher);
        check("★ 挂回后清掉退避状态(不再有待重试)", recovered?.nextRetryAt === undefined && recovered?.retryMs === undefined, recovered);
      }
    } finally { runner.dispose(); }
  }

  /* ── MC-051 定时派发前必须先把去重记录**同步落盘** ──
   *
   * 从前 onTick 先 `rememberLastMinute`(走 SettingRepo.set 的**异步** persist、还吞错)再立刻
   * `fire` —— "记下了"与"落盘了"之间有个窗口:应用若在这窗口里被杀/断电,重启后表里没有
   * 这一分钟,启动即 tick(MC-021)会对本分钟**再跑一次**,而对有外部副作用的自动化那是重复执行。
   * 现在派发前先过 `rememberLastMinuteDurable`(同步 `commitNow()` 的结构化结果,判据
   * `isDurable`),非 durable 就跳过这次触发。(完整版 durable claim/dispatch ledger 是台账
   * MC-051 建议的后续架构改造;ARC-005 切片把这两处的落盘语义从旧的「失败即抛」收敛到统一判据。)
   *
   * 这里钉的是**接线**(无头里让 SettingRepo/persist 真失败很牵强):派发那一条必须被
   * `rememberLastMinuteDurable` 的返回值守着。撤掉那个 `if (!...)` 即红。
   * (`ARC-005` 另有行为级红例:注入 `commitNow()` 失败 → 断言内存行被一起还原,见下面那节。)*/
  {
    const src = readFileSync(join(process.cwd(), "src/main/orchestration/automationRunner.ts"), "utf8");
    check(
      "★ MC-051:定时派发前的去重记录是**同步落盘**的(rememberLastMinuteDurable)",
      /rememberLastMinuteDurable\s*\(/.test(src) && /commitNow\s*\(/.test(src) && /isDurable\s*\(/.test(src),
    );
    check(
      "★ MC-051:该落盘失败即**跳过这次触发**(用返回值守着,不是照常 fire)",
      /if\s*\(\s*!\s*this\.rememberLastMinuteDurable\(/.test(src),
    );
  }

  /* ── MC-051 durable trigger-claim ledger(领取→执行→完成)──
   *
   * 去重表(`automation.lastMinute`)回答的是"这一分钟碰过没有";它**当场**就把这一格记成
   * "跑过",哪怕后面 `fire` 根本没派发出去(项目没了 / 上一次还在跑 / 起跑抛错)。真正
   * **可追踪的领取**是 `automation.triggerClaims`:派发前 durable 写一条 `CLAIMED`,运行
   * 收尾 durable 结算成 `SUCCEEDED`。崩溃点上残留的 `CLAIMED` 由 `recoverIncompleteClaims`
   * 认出来 —— **不重复执行**,也不静默丢弃,而是报成一次"上一次的运行结果不确定"。
   *
   * 这里钉的是**行为**(真起执行器 + 真 settings,复用同目录那份临时库):撤掉 onTick 里
   * 的领取块或 `recoverIncompleteClaims`,下面几条会真红。 */
  {
    const CLAIMS_KEY = "automation.triggerClaims";
    const diskClaims = (): Record<string, { status?: string; minute?: number }> => {
      const raw = SettingRepo.get(CLAIMS_KEY);
      return raw === null || raw.length === 0 ? {} : (JSON.parse(raw) as Record<string, { status?: string; minute?: number }>);
    };

    // -- 纯件:领取键 / 形状 / 待恢复挑选 / 修剪 --
    eq("MC-051:领取键按触发器+分钟生成", scheduleClaimId("wf_x:t1", 5), "wf_x:t1@5");
    eq("MC-051:领取键能还原回触发器", triggerKeyOfClaim("wf_x:t1@5"), "wf_x:t1");
    check("MC-051:没有 @ 分钟后缀就不是领取键", triggerKeyOfClaim("wf_x:t1") === null);
    check(
      "MC-051:合法领取表认得出来",
      isTriggerClaims({ "a@1": { status: "CLAIMED", minute: 1, at: 2 }, "b@1": { status: "SUCCEEDED", minute: 1, at: 2 } }),
    );
    check("MC-051:坏状态(拼错)整张表不认", !isTriggerClaims({ "a@1": { status: "NOPE", minute: 1, at: 2 } }));
    check("MC-051:坏形状(值是字符串)整张表不认", !isTriggerClaims({ "a@1": "CLAIMED" }));
    // 【MC-091 E3】`FAILED` 是合法的第四态(业务失败终态)。
    check("MC-091 E3:FAILED 是合法领取态", isTriggerClaims({ "f@1": { status: "FAILED", minute: 1, at: 2 } }));
    const sampleClaims: Map<string, TriggerClaim> = new Map([
      ["a@1", { status: "CLAIMED", minute: 1, at: 1 }],
      ["b@1", { status: "SUCCEEDED", minute: 1, at: 1 }],
      ["c@1", { status: "UNCERTAIN", minute: 1, at: 1 }],
      ["d@1", { status: "FAILED", minute: 1, at: 1 }],
    ]);
    eq("MC-051:待恢复只挑 CLAIMED(SUCCEEDED/FAILED/UNCERTAIN 都是终态)", pendingClaims(sampleClaims).join(","), "a@1");

    // -- 【MC-091 E3】SUCCEEDED 语义 = 下游业务成功(三态映射:成功/失败/不确定)--
    eq("MC-091 E3:success → 成功", runOutcomeOfStatus("success"), "success");
    eq("MC-091 E3:failed → 失败", runOutcomeOfStatus("failed"), "failed");
    eq("MC-091 E3:★ cancelled → 不确定(绝不假装成功)", runOutcomeOfStatus("cancelled"), "uncertain");
    eq("MC-091 E3:★ 拿不到结果(null)→ 不确定(不假装成功)", runOutcomeOfStatus(null), "uncertain");
    eq("MC-091 E3:★ 拿不到结果(undefined)→ 不确定", runOutcomeOfStatus(undefined), "uncertain");
    eq("MC-091 E3:success → 领取终态 SUCCEEDED", claimStatusOfRunOutcome("success"), "SUCCEEDED");
    eq("MC-091 E3:failed → 领取终态 FAILED", claimStatusOfRunOutcome("failed"), "FAILED");
    eq("MC-091 E3:uncertain → 领取终态 UNCERTAIN", claimStatusOfRunOutcome("uncertain"), "UNCERTAIN");
    check("MC-091 E3:CLAIMED 是唯一非终态", !isTerminalClaimStatus("CLAIMED") && isTerminalClaimStatus("SUCCEEDED") && isTerminalClaimStatus("FAILED") && isTerminalClaimStatus("UNCERTAIN"));
    check(
      "MC-091 E3:修剪也保留 FAILED/UNCERTAIN(不只 CLAIMED)",
      (() => {
        const m: Map<string, TriggerClaim> = new Map();
        m.set("fail@1", { status: "FAILED", minute: 1, at: 1 });
        m.set("unc@1", { status: "UNCERTAIN", minute: 1, at: 1 });
        for (let i = 0; i < 100; i++) m.set(`done@${i}`, { status: "SUCCEEDED", minute: 1, at: i });
        const kept = pruneClaims(m, 10);
        return kept.has("fail@1") && kept.has("unc@1") && [...kept.values()].filter((c) => c.status === "SUCCEEDED").length === 10;
      })(),
    );
    check(
      "MC-051:修剪保留未完成、只封顶已完成",
      (() => {
        const m: Map<string, TriggerClaim> = new Map();
        m.set("pend@1", { status: "CLAIMED", minute: 1, at: 1 });
        for (let i = 0; i < 100; i++) m.set(`done@${i}`, { status: "SUCCEEDED", minute: 1, at: i });
        const kept = pruneClaims(m, 10);
        return kept.has("pend@1") && [...kept.values()].filter((c) => c.status === "SUCCEEDED").length === 10;
      })(),
    );

    // -- 行为①:派发 durable 写 CLAIMED,运行收尾 durable 结算 SUCCEEDED --
    resetRuns();
    SettingRepo.set(LAST_MINUTE_KEY, "{}");
    SettingRepo.set(CLAIMS_KEY, "{}");
    const wfS = nextId(), nodeIdS = "t_claim_settle";
    makeAutomation({ workflowId: wfS, nodeId: nodeIdS, params: {
      [NODE_TRIGGER_KIND_PARAM_KEY]: "schedule",
      [NODE_TRIGGER_CRON_PARAM_KEY]: EVERY_MINUTE,
      task: "领取后收尾结算",
    } });
    const keyS = `${wfS}:${nodeIdS}`;
    const minuteS = 20_000_000;
    const settleRunner = await withClockAsync(minuteS * 60_000, () => startRunner());
    await sleep(20); // 等运行 promise 的 .finally 结算落地
    eq("MC-051:派发后盘上的领取结算是 SUCCEEDED(不是只有去重表)", diskClaims()[`${keyS}@${minuteS}`]?.status, "SUCCEEDED");
    eq("MC-051:领取带着它对应的分钟", diskClaims()[`${keyS}@${minuteS}`]?.minute, minuteS);
    eq("MC-051:本分钟只起一次运行", runsOfNode(nodeIdS).length, 1);
    settleRunner.dispose();

    // -- 【MC-091 E3】行为:下游业务失败 → 领取落 FAILED(不再冒充 SUCCEEDED)--
    resetRuns();
    SettingRepo.set(LAST_MINUTE_KEY, "{}");
    SettingRepo.set(CLAIMS_KEY, "{}");
    const wfFail = nextId(), nodeIdFail = "t_claim_failout";
    makeAutomation({ workflowId: wfFail, nodeId: nodeIdFail, params: {
      [NODE_TRIGGER_KIND_PARAM_KEY]: "schedule",
      [NODE_TRIGGER_CRON_PARAM_KEY]: EVERY_MINUTE,
      task: "下游业务失败",
    } });
    const keyFail = `${wfFail}:${nodeIdFail}`;
    const minuteFail = 30_000_000;
    setRunStatusForNode(nodeIdFail, "failed"); // 这一次运行以 failed 收尾
    const failRunner = await withClockAsync(minuteFail * 60_000, () => startRunner());
    await sleep(20);
    eq("★ MC-091 E3:下游业务失败 → 领取落 FAILED(不是 SUCCEEDED)", diskClaims()[`${keyFail}@${minuteFail}`]?.status, "FAILED");
    check(
      "★ MC-091 E3:界面看得见「上一次失败」",
      (failRunner.statusOf(wfFail)[0]?.lastError ?? "").includes("执行失败") === true,
      failRunner.statusOf(wfFail),
    );
    failRunner.dispose();

    // -- 【MC-091 E3】行为:运行被取消 → 领取落 UNCERTAIN(既不成功也不失败)--
    resetRuns();
    SettingRepo.set(LAST_MINUTE_KEY, "{}");
    SettingRepo.set(CLAIMS_KEY, "{}");
    const wfCancel = nextId(), nodeIdCancel = "t_claim_cancelout";
    makeAutomation({ workflowId: wfCancel, nodeId: nodeIdCancel, params: {
      [NODE_TRIGGER_KIND_PARAM_KEY]: "schedule",
      [NODE_TRIGGER_CRON_PARAM_KEY]: EVERY_MINUTE,
      task: "运行被取消",
    } });
    const keyCancel = `${wfCancel}:${nodeIdCancel}`;
    const minuteCancel = 31_000_000;
    setRunStatusForNode(nodeIdCancel, "cancelled");
    const cancelRunner = await withClockAsync(minuteCancel * 60_000, () => startRunner());
    await sleep(20);
    eq("★ MC-091 E3:运行取消 → 领取落 UNCERTAIN(不假装成功)", diskClaims()[`${keyCancel}@${minuteCancel}`]?.status, "UNCERTAIN");
    check(
      "★ MC-091 E3:界面看得见「上一次被取消」",
      (cancelRunner.statusOf(wfCancel)[0]?.lastError ?? "").includes("取消") === true,
      cancelRunner.statusOf(wfCancel),
    );
    cancelRunner.dispose();

    // -- 行为②:同一分钟多条触发器,各自生成一条独立领取(台账验收矩阵②)--
    // 这一批只 3 条,远在 64 条已完成封顶之下,所以领取能稳定读回。判据:*键互不相同*
    // (不是"共用一条"),且派发那一刻都是 `CLAIMED`(未完成)。
    // ⚠️ 三条**分属三个工作流**:`makeAutomation` 按 workflowId 覆盖存,同一 id 连存三次
    // 只剩最后一个节点(见它的实现)—— 用一个工作流挂三个触发器要直接构造多节点图。
    resetRuns();
    SettingRepo.set(CLAIMS_KEY, "{}");
    const minuteM = 23_000_000;
    const multiRuns = [
      { workflowId: nextId(), nodeId: "t_multi_a" },
      { workflowId: nextId(), nodeId: "t_multi_b" },
      { workflowId: nextId(), nodeId: "t_multi_c" },
    ];
    for (const r of multiRuns) {
      makeAutomation({ workflowId: r.workflowId, nodeId: r.nodeId, params: {
        [NODE_TRIGGER_KIND_PARAM_KEY]: "schedule",
        [NODE_TRIGGER_CRON_PARAM_KEY]: EVERY_MINUTE,
        task: "同一分钟各领一条",
      } });
    }
    const multiRunner = await withClockAsync((minuteM - 1) * 60_000, () => startRunner());
    resetRuns();
    withClock(minuteM * 60_000, () => multiRunner.onTick());
    const multiClaims = diskClaims();
    const multiKeys = multiRuns.map((r) => scheduleClaimId(`${r.workflowId}:${r.nodeId}`, minuteM));
    eq("MC-051:同一分钟三条触发器各有一条独立领取", multiKeys.filter((k) => multiClaims[k] !== undefined).length, 3);
    check("MC-051:三条领取键互不相同(不是共用一条)", new Set(multiKeys).size === multiKeys.length);
    check("MC-051:派发那一刻三条都是未完成(CLAIMED)", multiKeys.every((k) => multiClaims[k]?.status === "CLAIMED"), multiKeys.map((k) => multiClaims[k]));
    eq("MC-051:三条触发器都各起了一次运行", multiRuns.reduce((n, r) => n + runsOfNode(r.nodeId).length, 0), 3);
    multiRunner.dispose();

    // -- 行为③:崩在"领取后、结算前" → 重启不重复执行,残留 CLAIMED 处置成 UNCERTAIN --
    resetRuns();
    const wfC = nextId(), nodeIdC = "t_claim_crash";
    makeAutomation({ workflowId: wfC, nodeId: nodeIdC, params: {
      [NODE_TRIGGER_KIND_PARAM_KEY]: "schedule",
      [NODE_TRIGGER_CRON_PARAM_KEY]: EVERY_MINUTE,
      task: "崩在领取中",
    } });
    const keyC = `${wfC}:${nodeIdC}`;
    const minuteC = 21_000_000;
    // 精确复刻崩溃后磁盘上的样子:去重表记过这一分钟 + 领取账本一条仍是 CLAIMED(没有 SUCCEEDED)。
    SettingRepo.set(LAST_MINUTE_KEY, JSON.stringify({ [keyC]: minuteC }));
    SettingRepo.set(CLAIMS_KEY, JSON.stringify({ [`${keyC}@${minuteC}`]: { status: "CLAIMED", minute: minuteC, at: minuteC * 60_000 } }));
    const revived = await withClockAsync(minuteC * 60_000, () => startRunner());
    withClock(minuteC * 60_000, () => revived.onTick());
    eq("MC-051:重启后崩在领取中的那一分钟不重复执行", runsOfNode(nodeIdC).length, 0);
    eq("MC-051:盘上残留的 CLAIMED 被处置成 UNCERTAIN(不再每次重启反复报)", diskClaims()[`${keyC}@${minuteC}`]?.status, "UNCERTAIN");
    check(
      "MC-051:界面看得见「上一次结果不确定」",
      (revived.statusOf(wfC)[0]?.lastError ?? "").includes("不重复执行") === true,
      revived.statusOf(wfC),
    );
    withClock(minuteC * 60_000, () => revived.onTick());
    eq("MC-051:处置之后同一分钟仍不执行", runsOfNode(nodeIdC).length, 0);
    withClock((minuteC + 1) * 60_000, () => revived.onTick());
    eq("MC-051:下一分钟照常派发(闸门没关过头)", runsOfNode(nodeIdC).length, 1);
    revived.dispose();

    // -- 行为③:领取落盘失败 → 拒绝派发(与去重同一条红线)--
    resetRuns();
    const wfF = nextId(), nodeIdF = "t_claim_fail";
    makeAutomation({ workflowId: wfF, nodeId: nodeIdF, params: {
      [NODE_TRIGGER_KIND_PARAM_KEY]: "schedule",
      [NODE_TRIGGER_CRON_PARAM_KEY]: EVERY_MINUTE,
      task: "领取写不进去就别跑",
    } });
    const minuteF = 22_000_000;
    const failing = await withClockAsync((minuteF - 1) * 60_000, () => startRunner());
    resetRuns(); // 上一分钟那一跳不算这次要看的
    const origSet = SettingRepo.set;
    SettingRepo.set = (k, v) => {
      if (k === CLAIMS_KEY) throw new Error("injected claim write failure");
      return origSet.call(SettingRepo, k, v);
    };
    try {
      withClock(minuteF * 60_000, () => failing.onTick());
    } finally { SettingRepo.set = origSet; }
    eq("MC-051:领取落盘失败时不派发", runsOfNode(nodeIdF).length, 0);
    check(
      "MC-051:拒绝原因可见",
      (failing.statusOf(wfF)[0]?.lastError ?? "").includes("领取记录没能落盘") === true,
      failing.statusOf(wfF),
    );
    failing.dispose();
  }

  /* ── 事件去重与重放:持久化「已执行集合」必须参与派发判定 ──
   *
   * 去重表 `automation.lastMinute` 会丢(坏 JSON 当空表 / 历史修剪 / 用户搬库),
   * 系统时钟也可能回拨到同一分钟。而**领取账本**(`automation.triggerClaims`)里
   * `workflowId:nodeId@minute` 已是终态 = 这一分钟**确实执行过**。只查 lastMinute 的
   * 实现会把它当"本分钟没见过"照常派发 —— 同一事件键第二次副作用。
   * 修复后派发前先查账本终态:命中即跳过,原因记进事实(界面可见),账本不被改写。
   */
  {
    const claimsOnDisk = (): Record<string, { status?: string }> => {
      const raw = SettingRepo.get("automation.triggerClaims");
      return raw === null || raw.length === 0 ? {} : (JSON.parse(raw) as Record<string, { status?: string }>);
    };
    resetRuns();
    SettingRepo.set(LAST_MINUTE_KEY, "{}");
    SettingRepo.set("automation.triggerClaims", "{}");
    const wfR = nextId(), nodeIdR = "t_claim_replay";
    makeAutomation({ workflowId: wfR, nodeId: nodeIdR, params: {
      [NODE_TRIGGER_KIND_PARAM_KEY]: "schedule",
      [NODE_TRIGGER_CRON_PARAM_KEY]: EVERY_MINUTE,
      task: "同一事件键不许重放",
    } });
    const keyR = `${wfR}:${nodeIdR}`;
    const minuteR = 40_000_000;
    // 盘上事实:这一分钟已经执行过(终态 SUCCEEDED),但去重表没了(丢失/修剪/时钟回拨)。
    SettingRepo.set("automation.triggerClaims", JSON.stringify({
      [`${keyR}@${minuteR}`]: { status: "SUCCEEDED", minute: minuteR, at: minuteR * 60_000 },
    }));
    const replayRunner = await withClockAsync(minuteR * 60_000, () => startRunner());
    withClock(minuteR * 60_000, () => replayRunner.onTick());
    eq("★ 同一事件键不重放(持久化领取账本是判据,不只看 lastMinute)", runsOfNode(nodeIdR).length, 0);
    check(
      "★ 跳过原因对用户可见(不是静默丢弃)",
      (replayRunner.statusOf(wfR)[0]?.lastError ?? "").includes("已经执行过") === true,
      replayRunner.statusOf(wfR),
    );
    eq("★ 账本终态不被重放路径改写", claimsOnDisk()[`${keyR}@${minuteR}`]?.status, "SUCCEEDED");

    // 正控:下一分钟是一个**新**事件键,同一 tick 连看两次也只执行一次(健康路径不回归)。
    withClock((minuteR + 1) * 60_000, () => {
      replayRunner.onTick();
      replayRunner.onTick();
    });
    eq("正控:下一分钟照常执行且同一 tick 两次仍只一次", runsOfNode(nodeIdR).length, 1);
    replayRunner.dispose();
  }

  /* ── ARC-006/MC-091:损坏的 durable trigger-claim 不能静默当空表重跑 ──
   *
   * 模拟此前崩溃留下无法解析的领取记录。旧 readTriggerClaims() 把它转成空 Map，
   * 然后启动第一次 onTick 就往同一 SettingRepo 行写入新 CLAIMED/SUCCEEDED，
   * 擦掉原始损坏证据，还可能重复外部副作用。
   */
  {
    resetRuns();
    const key = "automation.triggerClaims";
    const damaged = '{"wf:tick@1122":{"status":"CLAIMED","minute":1122';
    SettingRepo.set(LAST_MINUTE_KEY, "{}");
    SettingRepo.set(key, damaged);
    const wf = nextId(), node = "t_claim_corrupt_lock";
    makeAutomation({ workflowId: wf, nodeId: node, params: {
      [NODE_TRIGGER_KIND_PARAM_KEY]: "schedule",
      [NODE_TRIGGER_CRON_PARAM_KEY]: EVERY_MINUTE,
      task: "损坏账本不可重新派发",
    } });
    const minute = 50_000_000;
    const brokenRunner = await withClockAsync(minute * 60_000, () => startRunner());
    withClock(minute * 60_000, () => brokenRunner.onTick());
    eq("★ 损坏领取账本不得派发新自动化", runsOfNode(node).length, 0);
    eq("★ 损坏领取账本原始字节必须保留", SettingRepo.get(key), damaged);
    eq("★ 损坏领取账本不得先改去重表", SettingRepo.get(LAST_MINUTE_KEY), "{}");
    check("★ 损坏领取账本的拒绝原因需在自动化事实可见",
      (brokenRunner.statusOf(wf)[0]?.lastError ?? "").includes("领取账本损坏"), brokenRunner.statusOf(wf));
    brokenRunner.dispose();
    // 显式由人工修复原始存档后，新实例恢复正常派发。
    resetRuns();
    SettingRepo.set(key, "{}");
    SettingRepo.set(LAST_MINUTE_KEY, "{}");
    const cleanRunner = await withClockAsync((minute + 1) * 60_000, () => startRunner());
    await sleep(20);
    eq("正控:人工恢复健康账本后新的触发可执行", runsOfNode(node).length, 1);
    const liveDamaged = '{"unsafe-live-claim":';
    SettingRepo.set(key, liveDamaged);
    const priorRunCount = runsOfNode(node).length;
    withClock((minute + 2) * 60_000, () => cleanRunner.onTick());
    eq("★ 运行时领取账本被写坏后拒绝新派发", runsOfNode(node).length, priorRunCount);
    eq("★ 运行时领取账本损坏原文不被覆盖", SettingRepo.get(key), liveDamaged);
    cleanRunner.dispose();
    SettingRepo.set(key, "{}");
    SettingRepo.set(LAST_MINUTE_KEY, "{}");
    // 活跃进程读过有效领取后，另一个写入者可以删除整行，或将其
    // 替换成合法但丢掉所有历史的 {}。两者均不能当作首次安装重跑。
    for (const tamperKind of ["deleted", "valid-but-erased"] as const) {
      resetRuns();
      SettingRepo.set(key, "{}");
      SettingRepo.set(LAST_MINUTE_KEY, "{}");
      const startMinute = minute + (tamperKind === "deleted" ? 3 : 6);
      const active = await withClockAsync(startMinute * 60_000, () => startRunner());
      await sleep(20);
      const ran = runsOfNode(node).length;
      check(`前置:${tamperKind} 例在破坏账本前确实运行`, ran === 1, runsOfNode(node));
      if (tamperKind === "deleted") SettingRepo.delete(key);
      else SettingRepo.set(key, "{}");
      const expectedRaw = tamperKind === "deleted" ? null : "{}";
      withClock((startMinute + 1) * 60_000, () => active.onTick());
      eq(`★ ${tamperKind}:有效历史被移走后不得重发`, runsOfNode(node).length, ran);
      eq(`★ ${tamperKind}:原始现场不应被新领取覆盖`, SettingRepo.get(key), expectedRaw);
      check(`★ ${tamperKind}:用户事实应表明领取账本不一致`,
        (active.statusOf(wf)[0]?.lastError ?? "").includes("领取账本"), active.statusOf(wf));
      active.dispose();
    }
    SettingRepo.set(key, "{}");
    SettingRepo.set(LAST_MINUTE_KEY, "{}");
  }

    // 另一张派发前耐久去重表 lastMinute 若坏掉，不能静默当空账：
    // 即使 durable 领取账本当前健康且为空，也不得执行并覆盖坏原件。
    for (const corruptionPhase of ["startup", "live"] as const) {
      resetRuns();
      const scheduleKey = "automation.triggerClaims";
      const damagedLastMinute = '{"wf:step":';
      SettingRepo.set(scheduleKey, "{}");
      SettingRepo.set(LAST_MINUTE_KEY, corruptionPhase === "startup" ? damagedLastMinute : "{}");
      const wf = nextId(), node = "t_last_minute_corrupt_" + corruptionPhase;
      makeAutomation({ workflowId: wf, nodeId: node, params: {
        [NODE_TRIGGER_KIND_PARAM_KEY]: "schedule",
        [NODE_TRIGGER_CRON_PARAM_KEY]: EVERY_MINUTE,
        task: "去重账本损坏不能重复外部执行",
      } });
      const checkMinute = 50_001_000 + (corruptionPhase === "startup" ? 10 : 20);
      const runner = await withClockAsync(checkMinute * 60_000, () => startRunner());
      if (corruptionPhase === "live") {
        await sleep(20);
        const baseRuns = runsOfNode(node).length;
        check("正控:运行期间变坏前确实运行", baseRuns === 1);
        SettingRepo.set(LAST_MINUTE_KEY, damagedLastMinute);
        withClock((checkMinute + 1) * 60_000, () => runner.onTick());
        eq("★ 运行中去重账本损坏不能重新派发", runsOfNode(node).length, baseRuns);
      } else {
        withClock(checkMinute * 60_000, () => runner.onTick());
        eq("★ 启动时去重账本损坏不能派发", runsOfNode(node).length, 0);
      }
      eq("★ 损坏的 lastMinute 原字节必须保留", SettingRepo.get(LAST_MINUTE_KEY), damagedLastMinute);
      check("★ lastMinute 错误须在事实里可见",
        (runner.statusOf(wf)[0]?.lastError ?? "").includes("去重账本"), runner.statusOf(wf));
      runner.dispose();
      SettingRepo.set(scheduleKey, "{}");
      SettingRepo.set(LAST_MINUTE_KEY, "{}");
    }

    // 即便仍是合法 JSON，若另一 writer 删掉/清空已派发分钟，
    // 当前进程的内存去重快照也不能被偷偷重置。
    for (const tamper of ["deleted", "erased-valid-json"] as const) {
      resetRuns();
      SettingRepo.set("automation.triggerClaims", "{}");
      SettingRepo.set(LAST_MINUTE_KEY, "{}");
      const wf = nextId(), node = "t_last_minute_lost_" + tamper;
      makeAutomation({ workflowId: wf, nodeId: node, params: {
        [NODE_TRIGGER_KIND_PARAM_KEY]: "schedule",
        [NODE_TRIGGER_CRON_PARAM_KEY]: EVERY_MINUTE,
        task: "已记去重历史被清空不可重发",
      } });
      const m = 50_002_000 + (tamper === "deleted" ? 0 : 3);
      const runner = await withClockAsync(m * 60_000, () => startRunner());
      await sleep(20);
      const before = runsOfNode(node).length;
      eq("正控:lastMinute 丢失前已成功触发", before, 1);
      if (tamper === "deleted") SettingRepo.delete(LAST_MINUTE_KEY);
      else SettingRepo.set(LAST_MINUTE_KEY, "{}");
      const damagedRaw = tamper === "deleted" ? null : "{}";
      withClock((m + 1) * 60_000, () => runner.onTick());
      eq(`★ ${tamper}:去重历史丢失后不得再发`, runsOfNode(node).length, before);
      eq(`★ ${tamper}:去重历史丢失原始现场保全`, SettingRepo.get(LAST_MINUTE_KEY), damagedRaw);
      check(`★ ${tamper}:拒派发原因在事实可见`,
        (runner.statusOf(wf)[0]?.lastError ?? "").includes("去重账本"), runner.statusOf(wf));
      runner.dispose();
    }
    SettingRepo.set(LAST_MINUTE_KEY, "{}");
    SettingRepo.set("automation.triggerClaims", "{}");

  /* ── 文件监听:编辑器式保存(写临时文件再 rename)只触发一次 ──
   *
   * 真实 `fs.watch` 对一次原子保存会连发多条事件(临时文件的 rename/change、最终
   * 文件的 rename,实测同一毫秒簇)。WATCH_SETTLE_MS + 合并窗口必须把它们收成**一批**:
   * 一次保存 = 一次运行,而不是每个平台事件各跑一遍。
   */
  {
    resetRuns();
    const wfA = nextId(), nodeIdA = "t_atomic_save";
    makeAutomation({ workflowId: wfA, nodeId: nodeIdA, params: {
      [NODE_TRIGGER_KIND_PARAM_KEY]: "file",
      [NODE_TRIGGER_PATHS_PARAM_KEY]: "*.md",
      [NODE_TRIGGER_DEBOUNCE_PARAM_KEY]: 0,
      task: "一次保存只办一次",
    } });
    const atomicRunner = await startRunner();
    try {
      const tmp = join(PROJ_DIR, "atomic-save.md.tmp");
      const dest = join(PROJ_DIR, "atomic-save.md");
      writeFileSync(tmp, "# v1");
      renameSync(tmp, dest);
      await sleep(FLUSH_SLACK_MS + 400);
      eq("★ 一次编辑器式保存只产生一次运行", runsOfNode(nodeIdA).length, 1);
      const payloadFiles = runsOfNode(nodeIdA)[0]?.entry?.payload?.files as string[] | undefined;
      check("载荷里是最终文件(临时文件不在里面)", payloadFiles?.includes(dest) === true && payloadFiles?.includes(tmp) !== true, payloadFiles);
    } finally { atomicRunner.dispose(); }
  }

  /* ── 文件 / 事件触发的批次跨崩溃:残留标记可见、不补投、派发后清除 ──
   *
   * 批次只活在内存 `pendingFires` 里;合并窗口里进程被杀,那一批无声消失。修复后
   * 批次开始攒时 durable 写一条 `automation.pendingBatches` 标记,派发/明确放弃时清除;
   * 重启发现残留 = 「有一批没派发」,记进事实(界面可见)、不自动补投。
   */
  {
    const BATCH_KEY = "automation.pendingBatches";
    const batchesOnDisk = (): Record<string, { kind?: string; count?: number; at?: number }> => {
      const raw = SettingRepo.get(BATCH_KEY);
      return raw === null || raw.length === 0 ? {} : (JSON.parse(raw) as Record<string, { kind?: string; count?: number; at?: number }>);
    };

    // -- ① 崩溃残留:盘上已有标记(模拟上一进程攒着批被杀),新进程启动 --never dispatch--
    resetRuns();
    const wfB = nextId(), nodeIdB = "t_batch_crash";
    makeAutomation({ workflowId: wfB, nodeId: nodeIdB, params: {
      [NODE_TRIGGER_KIND_PARAM_KEY]: "file",
      [NODE_TRIGGER_PATHS_PARAM_KEY]: "*.md",
      [NODE_TRIGGER_DEBOUNCE_PARAM_KEY]: 10_000, // 长窗口:断言期间不会被收口
      task: "崩在合并窗口里",
    } });
    const keyB = `${wfB}:${nodeIdB}`;
    SettingRepo.set(BATCH_KEY, JSON.stringify({ [keyB]: { kind: "file", count: 3, at: 1_000 } }));
    const crashedRunner = await startRunner();
    try {
      const factsB = crashedRunner.statusOf(wfB);
      check(
        "★ 崩溃残留的批次标记 → 重启后可见「有一批触发未确定是否已执行」",
        (factsB[0]?.lastError ?? "").includes("未确认是否已派发") === true,
        factsB,
      );
      eq("★ 不自动补投(派发计数为 0)", runsOfNode(nodeIdB).length, 0);
      check("★ 残留标记被消费掉(不重复报)", batchesOnDisk()[keyB] === undefined, batchesOnDisk());
      // 同一 tick 再跑两次也不补投。
      crashedRunner.onTick();
      crashedRunner.onTick();
      eq("★ 重启后同一标记不会因 ticker 变成补投", runsOfNode(nodeIdB).length, 0);
    } finally { crashedRunner.dispose(); }

    // -- ② 正常派发完成后标记被清除(防空过:下一批不受影响)--
    resetRuns();
    SettingRepo.set(BATCH_KEY, "{}");
    const wfC2 = nextId(), nodeIdC2 = "t_batch_clear";
    makeAutomation({ workflowId: wfC2, nodeId: nodeIdC2, params: {
      [NODE_TRIGGER_KIND_PARAM_KEY]: "file",
      [NODE_TRIGGER_PATHS_PARAM_KEY]: "*.md",
      [NODE_TRIGGER_DEBOUNCE_PARAM_KEY]: 0,
      task: "攒完就派发",
    } });
    const keyC2 = `${wfC2}:${nodeIdC2}`;
    const clearRunner = await startRunner();
    try {
      const f1 = join(PROJ_DIR, "batch-clear-1.md");
      writeFileSync(f1, "# 一");
      clearRunner.onFsChange(PROJ_DIR, "batch-clear-1.md");
      // 攒着时标记在盘上(durable,派发前就有)。
      check("★ 批次攒着时标记已在盘上(派发前 durable)",
        batchesOnDisk()[keyC2]?.kind === "file" && (batchesOnDisk()[keyC2]?.count ?? 0) >= 1,
        batchesOnDisk());
      await sleep(FLUSH_SLACK_MS);
      eq("正常派发发生", runsOfNode(nodeIdC2).length, 1);
      check("★ 派发完成后标记被清除(下一批不受影响)", batchesOnDisk()[keyC2] === undefined, batchesOnDisk());

      // 下一批照常:标记重新写、派发后再次清除。
      const f2 = join(PROJ_DIR, "batch-clear-2.md");
      writeFileSync(f2, "# 二");
      clearRunner.onFsChange(PROJ_DIR, "batch-clear-2.md");
      check("下一批重新写标记", batchesOnDisk()[keyC2] !== undefined, batchesOnDisk());
      await sleep(FLUSH_SLACK_MS);
      eq("下一批照常派发", runsOfNode(nodeIdC2).length, 2);
      check("下一批派发后标记再次清除", batchesOnDisk()[keyC2] === undefined, batchesOnDisk());
    } finally { clearRunner.dispose(); }

    // -- ③ 明确放弃(配置改动作废)清除标记,不报成崩溃残留 --
    resetRuns();
    SettingRepo.set(BATCH_KEY, "{}");
    const wfD = nextId(), nodeIdD = "t_batch_discard";
    makeAutomation({ workflowId: wfD, nodeId: nodeIdD, params: {
      [NODE_TRIGGER_KIND_PARAM_KEY]: "file",
      [NODE_TRIGGER_PATHS_PARAM_KEY]: "*.md",
      [NODE_TRIGGER_DEBOUNCE_PARAM_KEY]: 10_000,
      task: "改配置作废",
    } });
    const keyD = `${wfD}:${nodeIdD}`;
    const discardRunner = await startRunner();
    try {
      writeFileSync(join(PROJ_DIR, "batch-discard.md"), "# 改配置前");
      discardRunner.onFsChange(PROJ_DIR, "batch-discard.md");
      check("夹具:攒着时标记在", batchesOnDisk()[keyD] !== undefined, batchesOnDisk());
      // 改配置(合并窗口 → 0)并 reload:旧批次按签名作废。
      makeAutomation({ workflowId: wfD, nodeId: nodeIdD, params: {
        [NODE_TRIGGER_KIND_PARAM_KEY]: "file",
        [NODE_TRIGGER_PATHS_PARAM_KEY]: "*.md",
        [NODE_TRIGGER_DEBOUNCE_PARAM_KEY]: 0,
        task: "改配置作废",
      } });
      await discardRunner.reloadAll();
      check("★ 配置改动作废的批次清掉标记(不报成崩溃残留)", batchesOnDisk()[keyD] === undefined, batchesOnDisk());
    } finally { discardRunner.dispose(); }

    // -- ④ 坏标记 fail-open(读不回来当空,不挡启动)且不误报 --
    SettingRepo.set(BATCH_KEY, "{ 这不是 json");
    const badRunner = await startRunner();
    try {
      check("坏批次标记:启动不抛、不误报", badRunner.statusOf(wfD).length >= 0);
    } finally { badRunner.dispose(); }
    SettingRepo.set(BATCH_KEY, "{}");
  }

  /* ── 【ARC-005】非 durable 的落盘**不许留幻影行**(边界迁移)—─
   *
   * `rememberLastMinuteDurable` / `writeTriggerClaimDurable` 落盘走的是「`SettingRepo.set`
   * (改 **sql.js 内存表**)→ fsync」两步,**不是原子**。修复前:fsync 失败那一步用
   * `persistNowOrThrow()`(失败即抛),catch 里**只回滚 JS 的 Map**,内存表里那一行**仍是
   * 新值** —— 而 `commitNow` 的失败又给后台 `persist()` 排了退避重试,于是**下一次成功落盘
   * 会把调用方以为没写成的值冲上磁盘**(下次重启读回一个幻影领取 / 幻影去重分钟)。
   * 这正是 ARC-005 判据「内存提交成功 / 磁盘稳定保存是两种事实」+ 台账禁止的"以 false 冒充
   * 完全回滚欺骗调用者"。
   *
   * 这里用与 `settings-import-backup-smoke` 同源的注入(`.persist-` 排他创建失败让那一次
   * `commitNow()` 返回 `APPLIED_NOT_DURABLE`)在无头里真失败一次,断言**内存行被一起还原**。
   * 撤掉 `rollbackSettingRow` 这两条即红。 */
  {
    const TRIGGER_CLAIMS_KEY = "automation.triggerClaims";
    const wfH = nextId(), nodeIdH = "t_durable_rollback";
    // 不 start():这两个方法是纯"实例 Map + SettingRepo",直接调即可(避免启动即 tick)。
    // 它们是私有方法 —— 用与上文 §MC-051 同一条"拿真类的实例、按内部表面调"的手法。
    type DurableSurface = RunnerInternals & {
      triggerClaims: Map<string, TriggerClaim>;
      writeTriggerClaimDurable(claimId: string, claim: TriggerClaim): boolean;
      rememberLastMinuteDurable(key: string, minute: number, protectedMinute: number): boolean;
    };
    const r = newRunner() as DurableSurface;

    // ---- 领取账本 ----
    SettingRepo.set(TRIGGER_CLAIMS_KEY, "{}");
    const claimIdH = scheduleClaimId(`${wfH}:${nodeIdH}`, 999_001);
    failNextExclusiveCreate();
    let claimOk: boolean;
    try {
      claimOk = r.writeTriggerClaimDurable(claimIdH, { status: "CLAIMED", minute: 999_001, at: Date.now() });
    } finally { disarmExclusiveCreate(); }
    eq("ARC-005:领取落盘失败 → 返回 false(拒绝派发)", claimOk, false);
    eq("ARC-005:领取落盘失败 → **内存表那一行也还原**(不留幻影领取)", SettingRepo.get(TRIGGER_CLAIMS_KEY), "{}");
    check("ARC-005:领取落盘失败 → JS Map 里的那一格也还原", !r.triggerClaims.has(claimIdH), [...r.triggerClaims.keys()]);
    // 故障解除 → 重试成功,这一次才真的落定。
    eq("ARC-005:领取故障解除后重试成功", r.writeTriggerClaimDurable(claimIdH, { status: "CLAIMED", minute: 999_001, at: Date.now() }), true);
    check("ARC-005:重试成功后内存表才有这一条", (SettingRepo.get(TRIGGER_CLAIMS_KEY) ?? "").includes(claimIdH), SettingRepo.get(TRIGGER_CLAIMS_KEY));

    // ---- 定时去重表 ----
    SettingRepo.set(LAST_MINUTE_KEY, "{}");
    const keyH = `${wfH}:${nodeIdH}`;
    failNextExclusiveCreate();
    let minuteOk: boolean;
    try {
      minuteOk = r.rememberLastMinuteDurable(keyH, 999_002, 999_002);
    } finally { disarmExclusiveCreate(); }
    eq("ARC-005:去重记录落盘失败 → 返回 false(跳过这次触发)", minuteOk, false);
    eq("ARC-005:去重记录落盘失败 → **内存表那一行也还原**(不留幻影分钟)", SettingRepo.get(LAST_MINUTE_KEY), "{}");
    check("ARC-005:去重记录落盘失败 → JS Map 里的那一格也还原", !r.lastMinute.has(keyH), [...r.lastMinute.keys()]);
    eq("ARC-005:去重记录故障解除后重试成功", r.rememberLastMinuteDurable(keyH, 999_002, 999_002), true);
    check("ARC-005:重试成功后内存表才有这一格", (SettingRepo.get(LAST_MINUTE_KEY) ?? "").includes(keyH), SettingRepo.get(LAST_MINUTE_KEY));
  }

  /* ── 【MC-091 续·故障注入①】恢复游标(`automation.droppedUndelivered`)落盘失败 ──
   *
   * 上面几节验了欠账"记得对、并得进载荷、跨重启读得回",但**没有一处让这张表的落盘
   * 真失败过**。复核点名的正是这条异常路径:存储此刻坏了、`SettingRepo.set` 抛错时,
   * 恢复游标的行为必须成立 ——
   *
   *  - **不能静默丢**:那一次 `flushDroppedUndelivered` 抛错被 catch(只记日志),但
   *    `recordDropped` 记在**内存**里的那笔欠账必须原样留着(`droppedDirty` 保持 true),
   *    下一跳补落 —— 而不是把内存表清掉、让这笔丢弃随进程消失;
   *  - **不能写成半截**:失败的那一次磁盘上不该出现半份表(要么是旧值,要么空,绝不是
   *    "内存清空后的空表"把旧账覆盖没)。
   *
   * 造法:文件触发器合并窗口开得极大(整场不收口),喂爆单条 500 上限 → 超出的进恢复
   * 游标(内存脏);注入 `SettingRepo.set` 对 `DROPPED_KEY` 抛错 → 跑一跳 `onTick`
   * (等价 30 秒节流到点)→ flush 抛。断言内存账仍在、盘上没被写成空表;解除注入后再跑
   * 一跳 → 补落盘;dispose 后新 runner `start()` → 从盘上读回。撤掉 catch 里的"保留内存 +
   * 保持脏"语义(改成失败即清内存),内存账那条会真红。 */
  {
    resetRuns();
    SettingRepo.set(DROPPED_KEY, "{}");
    const wf = nextId(), nodeId = "t_dropped_flush_fail";
    makeAutomation({ workflowId: wf, nodeId, params: {
      [NODE_TRIGGER_KIND_PARAM_KEY]: "file", [NODE_TRIGGER_PATHS_PARAM_KEY]: "ff-*.md",
      // 合并窗口极大 —— 这一格整场都不收口,好让欠账**只进不交付**,专注验落盘那一步。
      [NODE_TRIGGER_DEBOUNCE_PARAM_KEY]: 3_600_000, task: "游标落盘失败不能静默丢",
    } });
    const key = `${wf}:${nodeId}`;
    const runner = await startRunner();
    const flushTick = (): void => (runner as unknown as { onTick(): void }).onTick();
    try {
      // 攒出一笔未交付欠账:单条上限 500,喂 504 条 → 超出的进恢复游标(内存标脏)。
      for (let i = 0; i < 504; i += 1) {
        const name = `ff-${String(i).padStart(4, "0")}.md`;
        writeFileSync(join(PROJ_DIR, name), `# ${i}`);
        runner.onFsChange(PROJ_DIR, name);
      }
      const owed = runner.droppedUndelivered.get(key)?.count ?? 0;
      check("★ 故障注入①:注入前先攒出一笔未交付欠账", owed >= 1, runner.droppedUndelivered.get(key));

      // 注入:游标那一次落盘抛错(模拟存储此刻坏了)。
      const origSet = SettingRepo.set;
      SettingRepo.set = (k, v) => {
        if (k === DROPPED_KEY) throw new Error("injected dropped-ledger write failure");
        return origSet.call(SettingRepo, k, v);
      };
      try {
        flushTick(); // 节流到点 → flush 抛,被 catch 吞成一行日志
        eq("★ 故障注入①:落盘失败后内存欠账**原样留着**(没被静默丢)", runner.droppedUndelivered.get(key)?.count ?? 0, owed);
        check("★ 故障注入①:落盘失败后盘上没写出这一笔(不是被清空的假象)", droppedOnDisk()[key] === undefined, droppedOnDisk());
      } finally { SettingRepo.set = origSet; }

      // 存储修好 → 下一跳补落。
      flushTick();
      check("★ 故障注入①:存储修好后下一跳把欠账补落盘(没丢)", (droppedOnDisk()[key]?.count ?? 0) >= owed, droppedOnDisk()[key]);
      runner.dispose();

      // 跨重启还能读回 —— 这才是"恢复游标"这个词的兑现。
      const revived = await startRunner();
      check("★ 故障注入①:重启后从盘上读回这笔欠账(恢复游标真的可恢复)", (revived.droppedUndelivered.get(key)?.count ?? 0) >= owed, revived.droppedUndelivered.get(key));
      revived.dispose();
    } finally { SettingRepo.set(DROPPED_KEY, "{}"); }
  }

  /* ── 【MC-091 续·故障注入②】领取**结算**落盘失败:不留幻影终态、补偿回 CLAIMED ──
   *
   * `ARC-005` 那一节注入的是**第一笔**写(`CLAIMED`,`prev === undefined`)的失败,断言
   * JS Map 那一格被删、盘上仍空。这里补的是**另一半**异常路径:派发已经 durable 写好
   * `CLAIMED` 之后,**收尾结算**(写终态 `SUCCEEDED`)**落盘失败**时的补偿语义 ——
   *
   *  - **不留幻影**:内存里那格必须回滚成**先前那个值**(`CLAIMED`),而不是停在
   *    `SUCCEEDED`(`rollbackTriggerClaim(claimId, prev)` 的 `prev !== undefined` 分支);
   *  - **盘上也不能被冲成 `SUCCEEDED`** —— 否则下一次成功落盘会把内存里的假终态盖上磁盘,
   *    重启时读到一条"成功"的领取,而那次运行的结果其实并没被 durable 确认;
   *  - 账目退回 `CLAIMED` 后,它仍是**待恢复**:重启时 `recoverIncompleteClaims` 会把它
   *    处置成 `UNCERTAIN`(不重复执行)—— 这正是"落盘失败**不重复执行**、也不假装成功"。
   *
   * 造法同 `ARC-005`:拿真类的实例、按内部表面直接调(`start()` 会顺带 tick,不想被它
   * 搅),用 `failNextExclusiveCreate()` 让那一次 `commitNow()` 返回非 durable。撤掉
   * `rollbackTriggerClaim` 那条,内存/盘上的 `CLAIMED` 两条断言各会真红(停在幻影
   * `SUCCEEDED`)。 */
  {
    const CLAIMS_KEY = "automation.triggerClaims";
    type SettleSurface = RunnerInternals & {
      triggerClaims: Map<string, TriggerClaim>;
      writeTriggerClaimDurable(claimId: string, claim: TriggerClaim): boolean;
    };
    const r = newRunner() as SettleSurface;
    SettingRepo.set(CLAIMS_KEY, "{}");
    const claimId = scheduleClaimId(`${nextId()}:t_settle_fail`, 999_777);
    // 派发那一刻:CLAIMED durable 落定(第一笔写,成功)。
    eq("故障注入②:派发前 CLAIMED 先 durable 落定", r.writeTriggerClaimDurable(claimId, { status: "CLAIMED", minute: 999_777, at: Date.now() }), true);
    // 收尾结算这一步落盘失败(commitNow 返回 APPLIED_NOT_DURABLE)。
    failNextExclusiveCreate();
    let settled: boolean;
    try {
      settled = r.writeTriggerClaimDurable(claimId, { status: "SUCCEEDED", minute: 999_777, at: Date.now() });
    } finally { disarmExclusiveCreate(); }
    eq("故障注入②:结算落盘失败 → 返回 false(调用方不把这次当成功)", settled, false);
    eq("★ 故障注入②:结算失败后**内存**回滚成 CLAIMED(不留幻影成功)", r.triggerClaims.get(claimId)?.status, "CLAIMED");
    eq("★ 故障注入②:结算失败后**盘上**仍是 CLAIMED(没被冲成假成功)", (JSON.parse(SettingRepo.get(CLAIMS_KEY) ?? "{}") as Record<string, { status?: string }>)[claimId]?.status, "CLAIMED");
    check("★ 故障注入②:退回 CLAIMED 后它仍是待恢复(重启不会重复执行,而是处置成不确定)", pendingClaims(r.triggerClaims).includes(claimId), pendingClaims(r.triggerClaims));
    // 故障解除 → 结算重试成功,这一次才真的落定 SUCCEEDED。
    eq("故障注入②:故障解除后结算重试成功", r.writeTriggerClaimDurable(claimId, { status: "SUCCEEDED", minute: 999_777, at: Date.now() }), true);
    eq("故障注入②:重试成功后盘上才是 SUCCEEDED", (JSON.parse(SettingRepo.get(CLAIMS_KEY) ?? "{}") as Record<string, { status?: string }>)[claimId]?.status, "SUCCEEDED");
  }

  /* ── 收尾:这一节的实例都 dispose 了,别让 timer / watcher 挂着 ── */
}

/* ────────────────────────── 收尾 ────────────────────────── */
// Optional generic-document paths survive extraction and batching without
// becoming falsely guaranteed variables for metadata-only imports.
{
  const item = eventItemFactsOf({ type: "library.item.imported", sessionId: "(system)", itemId: "local-file", title: "Local document", filePath: "files/report.docx", pdfPath: "pdf/report.pdf" } as RuntimeEvent);
  eq("可选的普通文件路径仍会传入事件事实", item?.filePath, "files/report.docx");
  eq("已有 PDF 的本地导入仍保留 PDF 路径", item?.pdfPath, "pdf/report.pdf");
  const facts = payloadFactsOf(mergeEventPayload(undefined, "library.item.imported", {}, item));
  eq("可选路径传到触发器载荷", facts.filePath, "files/report.docx");
}


/* ── 【ARC-015】积压超限:丢是允许的,假装没丢不允许(剩余项②) ── */
console.log("\n【ARC-015】文件积压超限 → 显式 OVERFLOW(不是静默丢弃)");
{
  // 不超限:原样收进,不丢。
  const under = addToFileBacklog(["a"], "b", 5);
  check("未超限:收进队列 + 不丢", under.backlog.join() === "a,b" && under.dropped === 0, under);

  // 已存在:不重复收,也不丢。
  const dup = addToFileBacklog(["a", "b"], "a", 5);
  check("已在队列里:不重复收、不丢", dup.backlog.join() === "a,b" && dup.dropped === 0, dup);

  // **恰好到上限不丢**(边界:limit=3,已有 2,再来 1 → 长度 3,不丢)。
  const exact = addToFileBacklog(["a", "b"], "c", 3);
  check("恰好到上限不丢(dropped=0)", exact.backlog.length === 3 && exact.dropped === 0, exact);

  // 越一格:丢最早的那一条,dropped 报出条数。
  const over = addToFileBacklog(["a", "b", "c"], "d", 3);
  check("越一格:丢最早的一条 + 报出 1", over.backlog.join() === "b,c,d" && over.dropped === 1, over);

  // 丢**最早**的,不是最近的 —— 留下的是最近发生的(与从前 `shift()` 取舍一致)。
  const over2 = addToFileBacklog(["a", "b", "c", "d"], "e", 3);
  check("超限丢最早:留下最近三条", over2.backlog.join() === "c,d,e" && over2.dropped === 2, over2);

  // 纯:不改原数组(调用方按返回值替换)。
  const src = ["a", "b", "c"];
  addToFileBacklog(src, "d", 3);
  check("纯函数:不改原队列", src.join() === "a,b,c", src);

  // 极端上限:limit<=0 时队列恒空,整条都算丢(不静默扩成无限)。
  const zero = addToFileBacklog([], "x", 0);
  check("上限 0:整条被丢且报出", zero.backlog.length === 0 && zero.dropped === 1, zero);
}

/* ── 【MC-091】统一截断原语 `capOldest`:超限丢最早、如实报数,几处共用唯一一份 ── */
console.log("\n【MC-091】统一截断原语 capOldest(唯一一份:丢最早 + 如实计数)");
{
  // 未超限:原样保留、不丢。
  const under = capOldest(["a", "b"], 5);
  check("未超限:全留 + 不丢", under.kept.join() === "a,b" && under.dropped === 0, under);
  // 恰好到上限不丢。
  const exact = capOldest(["a", "b", "c"], 3);
  check("恰好到上限不丢", exact.kept.join() === "a,b,c" && exact.dropped === 0, exact);
  // 越一格:丢最早的一条、报出 1,留下最近那批。
  const over = capOldest(["a", "b", "c", "d"], 3);
  check("越一格:丢最早 + 报出 1", over.kept.join() === "b,c,d" && over.dropped === 1, over);
  // 超多格:一次丢多格(留下最近 limit 条)。
  const many = capOldest(["a", "b", "c", "d", "e"], 2);
  check("超多格:一次丢够 + 报出准确条数", many.kept.join() === "d,e" && many.dropped === 3, many);
  // 纯:不改原数组(调用方按返回值替换)。
  const src = ["a", "b", "c"];
  capOldest(src, 2);
  check("纯函数:不改原数组", src.join() === "a,b,c", src);
  // 极端上限:limit<=0 时全丢、条数如实。
  const zero = capOldest(["a", "b"], 0);
  check("上限 0:全丢 + 报出 2", zero.kept.length === 0 && zero.dropped === 2, zero);
  // 空数组:不丢。
  const empty = capOldest([], 3);
  check("空数组:不丢", empty.kept.length === 0 && empty.dropped === 0, empty);
  // ★ 承重:同一份判据既是 `addToFileBacklog` 也是 `mergeEventPayload` 的上限来源 ——
  //   文件名把"唯一一份"钉死(将来谁再各写一套,这条断言会因 import 消失而红)。
  check("★ capOldest 与 addToFileBacklog 同源(超限结果一致:丢最早、报数同)", (() => {
    const viaCap = capOldest(["a", "b", "c"], 2);
    const viaBacklog = addToFileBacklog(["a", "b"], "c", 2);
    return viaCap.kept.join() === viaBacklog.backlog.join() && viaCap.dropped === viaBacklog.dropped;
  })());
}

{
  // 载荷事实:没丢时**不给** overflowDropped 键(同 itemCount 的口径)。
  const clean = payloadFactsOf({ kind: "file", files: ["a.md"] });
  check("facts:未截断不带 overflowDropped", !Object.prototype.hasOwnProperty.call(clean, "overflowDropped"), Object.keys(clean));
  // 真丢了才带,且是丢的条数。
  const dropped = payloadFactsOf({ kind: "file", files: ["a.md"], overflowDropped: 7 });
  eq("facts:截断时带 overflowDropped=丢的条数", dropped.overflowDropped, 7);
  // 0 视同没丢(防御:调用方不该传 0,但 0 不该冒出一个恒假的键)。
  const zeroFact = payloadFactsOf({ kind: "file", files: ["a.md"], overflowDropped: 0 });
  check("facts:overflowDropped=0 不给键", !Object.prototype.hasOwnProperty.call(zeroFact, "overflowDropped"), Object.keys(zeroFact));

  // 人话描述:**明说输入不完整**,别让模型把被截断的列表当成全部。
  const cappedText = describeTriggerPayload({ kind: "file", files: ["a.md", "b.md"], overflowDropped: 3 });
  check("描述:截断时明说输入不完整", cappedText.includes("3") && cappedText.includes("不是全部"), cappedText);
  const noDropText = describeTriggerPayload({ kind: "file", files: ["a.md"] });
  check("描述:没截断时不提截断", !noDropText.includes("截断"), noDropText);
}

/* ── 【ARC-015】文件监听的默认忽略目录:纯函数矩阵 ── */
console.log("\n【ARC-015】文件监听默认忽略目录的 policy");
{
  const d = (p: string, globs: string[], pol: "SAFE_DEFAULT" | "EXPLICIT_OVERRIDE") => shouldIgnoreWatchPath(p, globs, pol);
  check("SAFE_DEFAULT:dist 下的路径被忽略", d("dist/bundle.js", ["dist/*.js"], "SAFE_DEFAULT") === true);
  check("SAFE_DEFAULT:node_modules 下的被忽略", d("node_modules/x/i.js", ["**"], "SAFE_DEFAULT") === true);
  check("正常路径(src/*.ts)不忽略", d("src/a.ts", ["src/*.ts"], "SAFE_DEFAULT") === false);
  check("EXPLICIT_OVERRIDE:dist/*.js 明确命中 → 不忽略", d("dist/bundle.js", ["dist/*.js"], "EXPLICIT_OVERRIDE") === false);
  check("EXPLICIT_OVERRIDE:build/report.json 命中 → 不忽略", d("build/report.json", ["build/report.json"], "EXPLICIT_OVERRIDE") === false);
  check("EXPLICIT_OVERRIDE:** 不解保护 dist", d("dist/bundle.js", ["**"], "EXPLICIT_OVERRIDE") === true);
  check("EXPLICIT_OVERRIDE:只写目录名 dist 不解保护", d("dist/bundle.js", ["dist"], "EXPLICIT_OVERRIDE") === true);
  check("isSpecificGlob:** 不具体", isSpecificGlob("**") === false);
  check("isSpecificGlob:dist/*.js 具体", isSpecificGlob("dist/*.js") === true);
  check("isSpecificGlob:build/report.json 具体", isSpecificGlob("build/report.json") === true);
}

/* ── 【ARC-015①】结构化 FileChange:方向由「事件类型 + 此刻在不在 + 之前见没见过」合成 ── */
console.log("\n【ARC-015①】结构化 FileChange 方向(classifyFileChange)");
{
  const c = classifyFileChange;
  // 内容变了 + 此刻在 → 改动。
  eq("change + 在 → modified", c("change", true, false), "modified");
  eq("change + 在(之前见过) → modified", c("change", true, true), "modified");
  // change + 不在:矛盾(边写边被删)→ 不假装,unknown。
  eq("change + 不在 → unknown(矛盾不猜)", c("change", false, true), "unknown");

  // rename 是新建/删除/改名的合事件 —— 方向靠"在不在 + 之前见没见过"。
  eq("rename + 在 + 没见过 → created", c("rename", true, false), "created");
  // ⚠️ rename + 在 + 之前见过 → **不**谎报 created(它会诱使模型以为这是全新文件),标 unknown。
  eq("rename + 在 + 见过 → unknown(改名源未知,不谎报 created)", c("rename", true, true), "unknown");
  eq("rename + 不在 + 见过 → deleted", c("rename", false, true), "deleted");
  // rename + 不在 + 没见过:转瞬即逝的临时文件 → unknown(不硬塞成 deleted)。
  eq("rename + 不在 + 没见过 → unknown", c("rename", false, false), "unknown");

  // 平台不给类型(null)时同 rename 处理。
  eq("null 类型 + 在 + 没见过 → created", c(null, true, false), "created");
  eq("null 类型 + 不在 + 见过 → deleted", c(null, false, true), "deleted");

  // **从不返回 renamed** —— fs.watch 给不出另一端,这一档是声明保留(见台账 ARC-015④)。
  for (const et of ["change", "rename", null]) {
    for (const ex of [true, false]) {
      for (const sb of [true, false]) {
        check(`classify 结果不是 renamed(${et}/${ex}/${sb})`, c(et, ex, sb) !== "renamed", c(et, ex, sb));
      }
    }
  }
}

console.log("\n【ARC-015①】收口二次 stat 校正(reconcileFileChangeKind)");
{
  const r = reconcileFileChangeKind;
  // 说"还在"的路径,收口时又没了 → 降级成 deleted(否则模型去读一个不存在的文件)。
  eq("created 但收口时没了 → deleted", r("created", false), "deleted");
  eq("modified 但收口时没了 → deleted", r("modified", false), "deleted");
  // 还在 → 原样。
  eq("created 且还在 → created", r("created", true), "created");
  eq("modified 且还在 → modified", r("modified", true), "modified");
  // deleted / unknown 本就不保证存在,不必再问方向。
  eq("deleted 不受 existsNow 影响", r("deleted", true), "deleted");
  eq("unknown 不受 existsNow 影响", r("unknown", false), "unknown");
}

/* ── 【ARC-015③】越界防线:一条文件事件解析后必须仍在被监听根之内 ── */
console.log("\n【ARC-015③】越界防线:事件路径不得逃出监听根(isWithinWatchRoot)");
{
  const w = isWithinWatchRoot;
  const ROOT = "D:\\proj";
  // 根内(含等于根)都放行。
  check("根内文件放行", w("D:\\proj\\a.md", ROOT) === true);
  check("根内子目录放行", w("D:\\proj\\sub\\a.md", ROOT) === true);
  check("等于根本身放行(filename 缺失那条用 dir)", w(ROOT, ROOT) === true);
  check("根内子目录前缀(非路径分隔)不算越界误判", w("D:\\proj2\\a.md", ROOT) === false);
  // 分隔符混用也要归一后再判。
  check("正斜杠写法等价放行", w("D:/proj/sub/a.md", ROOT) === true);
  // 越界:上跳、被绝对路径替换、上跳多级。
  check(".. 上跳一级越界", w("D:\\secret.md", ROOT) === false);
  check("../ 相对写法越界", w("D:\\proj\\..\\secret.md", ROOT) === false);
  check("上跳多级越界", w("D:\\..\\secret.md", ROOT) === false);
  // 根目录为空 = 不限制(没有根可比,不误判成越界)。
  check("空根不限制", w("D:\\anything\\x.md", "") === true);
  // 尾斜杠的根也认。
  check("根带尾斜杠仍放行根内", w("D:\\proj\\a.md", "D:\\proj\\") === true);
}

{
  // 载荷事实:有方向才给 changes 键(同 overflowDropped/itemCount 口径)。
  const none = payloadFactsOf({ kind: "file", files: ["a.md"] });
  check("facts:没方向不带 changes", !Object.prototype.hasOwnProperty.call(none, "changes"), Object.keys(none));
  const empty = payloadFactsOf({ kind: "file", files: ["a.md"], changes: [] });
  check("facts:changes 空数组不给键", !Object.prototype.hasOwnProperty.call(empty, "changes"), Object.keys(empty));
  const withDir = payloadFactsOf({
    kind: "file",
    files: ["a.md"],
    changes: [{ path: "a.md", kind: "created" }, { path: "b.md", kind: "deleted" }],
  });
  check("facts:有方向时带 changes(全都在)", withDir.changes?.length === 2, withDir.changes);
  eq("facts:changes 里保留了 deleted 方向", withDir.changes?.find((x) => x.path === "b.md")?.kind, "deleted");
  // 深拷:改事实里的对象不动原载荷。
  const origChanges = [{ path: "a.md", kind: "created" } as const];
  const factCopy = payloadFactsOf({ kind: "file", files: ["a.md"], changes: origChanges });
  (factCopy.changes as { path: string; kind: string }[])[0].kind = "deleted";
  eq("facts:changes 是深拷(原载荷不受影响)", origChanges[0].kind, "created");

  // 人话描述:把**方向**说清楚,`unknown` 老实说看不出方向。
  const dirText = describeTriggerPayload({
    kind: "file",
    files: ["a.md"],
    changes: [{ path: "b.md", kind: "deleted" }, { path: "c.md", kind: "unknown" }],
  });
  check("描述:列出删除方向", dirText.includes("删除:b.md"), dirText);
  check("描述:unknown 老实说看不出方向", dirText.includes("看不出方向") && dirText.includes("c.md"), dirText);
  // created/modified 不重复列(files 那段已经说了"文件变了")。
  const onlyMod = describeTriggerPayload({
    kind: "file",
    files: ["a.md"],
    changes: [{ path: "a.md", kind: "modified" }],
  });
  check("描述:只有 modified 时不另起方向段", !onlyMod.includes("另有变更"), onlyMod);
}

/* ── 【ARC-015④】DurableEventEnvelope:事件先落一份可查的封装,再投递 ── */
console.log("\n【ARC-015④】DurableEventEnvelope 抽象(接 ARC-007/005 的形状)");
{
  // **只记指纹,不拷 payload。** 两份键序不同、内容相同的载荷得到**同一个**摘要;
  // 内容不同则不同 —— 这是"封装记的是引用不是正文"的可测落点。
  eq("digest:键序不同、内容相同 → 同一摘要",
    digestOfPayload({ a: 1, b: [2, 3] }), digestOfPayload({ b: [2, 3], a: 1 }));
  check("digest:内容不同 → 摘要不同",
    digestOfPayload({ a: 1 }) !== digestOfPayload({ a: 2 }));
  check("digest:带 fnv1a: 前缀(自足,不引 crypto)",
    digestOfPayload({ a: 1 }).startsWith("fnv1a:"), digestOfPayload({ a: 1 }));

  // **接收**:登记一条 ENQUEUED 的封装。attempt 从 0 起,正文不落进封装。
  const rec = enqueueEventEnvelope({
    eventId: "evt_1", triggerKey: "wf:n1", kind: "file",
    payload: { kind: "file", files: ["a.md", "b.md"] }, sceneId: "scene_x", at: 1000,
  });
  eq("接收:状态是 ENQUEUED", rec.status, "ENQUEUED");
  eq("接收:attempt 从 0 起", rec.envelope.attempt, 0);
  eq("接收:记下载荷指纹(不是正文)",
    rec.envelope.payloadDigest, digestOfPayload({ kind: "file", files: ["a.md", "b.md"] }));
  check("接收:封装里**没有**载荷正文字段",
    !Object.prototype.hasOwnProperty.call(rec.envelope, "files")
      && !Object.prototype.hasOwnProperty.call(rec.envelope, "payload"),
    Object.keys(rec.envelope));
  eq("接收:sceneId 如实带上", rec.envelope.sceneId, "scene_x");
  check("接收:是待投递(非终态)", isPendingEnvelope(rec) && !envelopeTerminal(rec));

  // **sceneId 缺省 → 不给键**(同 overflowDropped/changes 的口径:别多一个恒空可选字段)。
  const noScene = enqueueEventEnvelope({ eventId: "evt_2", triggerKey: "wf:n1", kind: "schedule", payload: { kind: "schedule", at: 0 }, at: 0 });
  check("接收:缺省 sceneId 时不给键", !Object.prototype.hasOwnProperty.call(noScene.envelope, "sceneId"), Object.keys(noScene.envelope));

  // **结算:投递成功 → 终态 DELIVERED**,attempt 记一次,并清掉上次的失败原因。
  const failedOnce = settleEventEnvelope(
    enqueueEventEnvelope({ eventId: "evt_3", triggerKey: "wf:n2", kind: "event", payload: { kind: "event", event: "turn.done" }, at: 0 }),
    { outcome: "failed", error: "暂时挂了", retryBudget: 3 }, 10,
  );
  eq("结算:未到预算的失败 → 留在 ENQUEUED(待重投)", failedOnce.status, "ENQUEUED");
  eq("结算:失败记一次 attempt", failedOnce.envelope.attempt, 1);
  eq("结算:失败留下 lastError(可查)", failedOnce.envelope.lastError, "暂时挂了");
  const done = settleEventEnvelope(failedOnce, { outcome: "delivered" }, 20);
  eq("结算:投成 → 终态 DELIVERED", done.status, "DELIVERED");
  eq("结算:投成再记一次 attempt", done.envelope.attempt, 2);
  check("结算:投成清掉上次的 lastError(不拿旧账说这次也没成)",
    !Object.prototype.hasOwnProperty.call(done.envelope, "lastError"), done.envelope);
  check("结算:DELIVERED 是终态", envelopeTerminal(done));

  // **纪律 1:终态不可复活。** 已 DELIVERED 的再结算,原样返回(不改状态、不改 attempt)。
  const resurrect = settleEventEnvelope(done, { outcome: "failed", error: "迟到的失败", retryBudget: 9 }, 30);
  eq("终态不可复活:DELIVERED 再结算仍是 DELIVERED", resurrect.status, "DELIVERED");
  eq("终态不可复活:attempt 不再变", resurrect.envelope.attempt, 2);
  eq("终态不可复活:updatedAt 不动", resurrect.updatedAt, done.updatedAt);

  // **纪律 2:失败到预算才落终态。** budget=2 时第 2 次失败才 FAILED。
  let r = enqueueEventEnvelope({ eventId: "evt_4", triggerKey: "wf:n3", kind: "file", payload: { kind: "file", files: [] }, at: 0 });
  r = settleEventEnvelope(r, { outcome: "failed", error: "e1", retryBudget: 2 }, 1);
  eq("预算 2:第 1 次失败仍 ENQUEUED", r.status, "ENQUEUED");
  r = settleEventEnvelope(r, { outcome: "failed", error: "e2", retryBudget: 2 }, 2);
  eq("预算 2:第 2 次失败 → 终态 FAILED", r.status, "FAILED");
  eq("预算 2:最后一次失败原因如实", r.envelope.lastError, "e2");
  // retryBudget 省略 = 1:一次就死(不无限重试)。
  const oneShot = settleEventEnvelope(enqueueEventEnvelope({ eventId: "evt_5", triggerKey: "wf:n4", kind: "file", payload: { kind: "file", files: [] }, at: 0 }), { outcome: "failed", error: "only" }, 5);
  eq("预算缺省=1:一次失败即终态 FAILED", oneShot.status, "FAILED");

  // **纪律 3:UNCERTAIN 绝不自动重投。** 落终态,attempt 记一次,原因可查。
  const unc = settleEventEnvelope(
    enqueueEventEnvelope({ eventId: "evt_6", triggerKey: "wf:n5", kind: "event", payload: { kind: "event", event: "turn.done" }, at: 0 }),
    { outcome: "uncertain", error: "外部动作可能已发生" }, 7,
  );
  eq("UNCERTAIN 是终态(不自动重投)", unc.status, "UNCERTAIN");
  check("UNCERTAIN 是终态", envelopeTerminal(unc) && !isPendingEnvelope(unc));
  eq("UNCERTAIN 记一次 attempt", unc.envelope.attempt, 1);
  eq("UNCERTAIN 留下原因", unc.envelope.lastError, "外部动作可能已发生");
  // 已 UNCERTAIN 的再结算(哪怕报 delivered)也**不复活** —— 不盲发第二次。
  const uncAgain = settleEventEnvelope(unc, { outcome: "delivered" }, 8);
  eq("UNCERTAIN 不可被后续结算翻盘", uncAgain.status, "UNCERTAIN");
  eq("UNCERTAIN 翻盘不改 attempt", uncAgain.envelope.attempt, 1);

  // 纯:结算返回**新的** record,不改入参那一份(调用方持有旧的仍能读原样)。
  const before = enqueueEventEnvelope({ eventId: "evt_7", triggerKey: "wf:n6", kind: "file", payload: { kind: "file", files: [] }, at: 0 });
  const after = settleEventEnvelope(before, { outcome: "delivered" }, 1);
  eq("结算:不改入参那一份(原仍是 ENQUEUED)", before.status, "ENQUEUED");
  eq("结算:返回的是新状态", after.status, "DELIVERED");
}

/* ══════════ MERGE-3 第二刀：executor owner 接进自动化起跑 ══════════ */
console.log("\nMERGE-3 · executor owner：同一 flow 只能一端执行（自动化侧）");
{
  interface OwnershipSurface {
    setExecutorOwnership(registry: ExecutorOwnershipRegistry | null): void;
    runNow(workflowId: string, triggerNodeId: string): Promise<{ ok: boolean; error?: string }>;
    start(): Promise<void>;
    dispose(): void;
    statusOf(workflowId: string): Array<{ lastError?: string; detail?: string }>;
  }
  const RunnerCtor = Object.getPrototypeOf(automationRunner).constructor as new () => OwnershipSurface;

  // 独立工作流 id（不与 §13 的场景共用）。
  let oseq = 0;
  const nextOwnershipId = (): string => `wf_owner_${(oseq += 1)}`;
  const PROJ_DIR_OWNERSHIP = join(process.env.MCODE_SMOKE_DATA_ROOT ?? ".", "owner-project");
  mkdirSync(PROJ_DIR_OWNERSHIP, { recursive: true });
  const OWNER_PROJ_ID = "p_owner";
  if (ProjectRepo.get(OWNER_PROJ_ID) === undefined) {
    const now = Date.now();
    ProjectRepo.create({
      id: OWNER_PROJ_ID, name: "owner 冒烟项目", path: PROJ_DIR_OWNERSHIP,
      archived: false, group: null, sortOrder: 0, pinnedAt: null, createdAt: now, updatedAt: now,
    });
  }

  const makeOwnerAutomation = (workflowId: string, nodeId: string): void => {
    WorkflowRepo.save({
      id: workflowId,
      name: `owner 冒烟 ${workflowId}`,
      builtin: false,
      updatedAt: Date.now(),
      nodes: [{
        id: nodeId,
        type: "mcode.trigger",
        title: "触发器",
        params: {
          [NODE_TRIGGER_PROJECT_PARAM_KEY]: OWNER_PROJ_ID,
          [NODE_TRIGGER_KIND_PARAM_KEY]: "manual",
          task: "owner 用例",
        },
        position: { x: 0, y: 0 },
      }],
      edges: [],
    });
  };

  // ★ 正常情况：没有另一端登记 → claim 成功、触发器照常启动。
  {
    const wf = nextOwnershipId();
    makeOwnerAutomation(wf, "t_own_ok");
    const store = new InMemoryExecutorOwnershipStore();
    const registry = new ExecutorOwnershipRegistry(store);
    const r = new RunnerCtor();
    r.setExecutorOwnership(registry);
    resetRuns();
    try {
      await r.start();
      const out = await r.runNow(wf, "t_own_ok");
      check("★ 无冲突：claim 成功且触发器照常启动", out.ok === true && runsOfNode("t_own_ok").length === 1, { out, runs: runsOfNode("t_own_ok").length });
      eq("★ 启动后该 flow 登记为 mcode 拥有", registry.executorOwnerOf(wf), "mcode");
    } finally {
      r.dispose();
    }
    eq("★ dispose 后释放（executorOwnerOf 回 null）", registry.executorOwnerOf(wf), null);
  }

  // ★ 已被 node-red 拥有 → 触发器不启动且诊断可读。
  {
    const wf = nextOwnershipId();
    makeOwnerAutomation(wf, "t_own_conflict");
    const store = new InMemoryExecutorOwnershipStore();
    const registry = new ExecutorOwnershipRegistry(store);
    registry.claim(wf, "node-red", { reason: "迁移产物已部署给引擎" });
    const r = new RunnerCtor();
    r.setExecutorOwnership(registry);
    resetRuns();
    try {
      await r.start();
      const out = await r.runNow(wf, "t_own_conflict");
      check("★ node-red 拥有 → 触发器不启动", out.ok === false && runsOfNode("t_own_conflict").length === 0, { out, runs: runsOfNode("t_own_conflict").length });
      check("★ 诊断可读且点名 node-red", (out.error ?? "").includes("node-red") && (out.error ?? "").includes("未启动"), out.error);
      eq("★ 冲突不覆盖：owner 仍是 node-red", registry.executorOwnerOf(wf), "node-red");
      const status = r.statusOf(wf);
      check("★ 可见诊断落进 status（statusOf 的 lastError 带原因）",
        status.some((s) => (s.lastError ?? "").includes("node-red")), status);
    } finally {
      r.dispose();
    }
    eq("★ dispose 不会偷走 node-red 的登记", registry.executorOwnerOf(wf), "node-red");
  }

  // ★ 停止后 release、可再次 claim（模拟"切换 owner"的合法路径）。
  {
    const wf = nextOwnershipId();
    makeOwnerAutomation(wf, "t_own_switch");
    const store = new InMemoryExecutorOwnershipStore();
    const registry = new ExecutorOwnershipRegistry(store);
    const r1 = new RunnerCtor();
    r1.setExecutorOwnership(registry);
    resetRuns();
    try {
      await r1.start();
      await r1.runNow(wf, "t_own_switch");
      eq("★ 第一次运行：mcode 拥有", registry.executorOwnerOf(wf), "mcode");
    } finally {
      r1.dispose();
    }
    eq("★ 停止后 release：executorOwnerOf 回 null", registry.executorOwnerOf(wf), null);
    // 另一端（node-red）此时可以登记。
    const nodeRedClaim = registry.claim(wf, "node-red", { reason: "切换" });
    check("★ 释放后 node-red 可登记", nodeRedClaim.ok === true, nodeRedClaim);
    // 再切回 mcode：先由 node-red 释放，再让 mcode 运行。
    eq("★ node-red 释放成功", registry.release(wf, "node-red").ok, true);
    const r2 = new RunnerCtor();
    r2.setExecutorOwnership(registry);
    resetRuns();
    try {
      await r2.start();
      const out = await r2.runNow(wf, "t_own_switch");
      check("★ 释放后可再次被 mcode claim 并运行", out.ok === true && runsOfNode("t_own_switch").length === 1, out);
      eq("★ 再次拥有", registry.executorOwnerOf(wf), "mcode");
    } finally {
      r2.dispose();
    }
    eq("★ 二次 dispose 后再次释放", registry.executorOwnerOf(wf), null);
  }

  // ★ 默认行为不变：不注入 ownership 时（内存版注册表）始终成功。
  {
    const wf = nextOwnershipId();
    makeOwnerAutomation(wf, "t_own_default");
    const r = new RunnerCtor(); // 不调 setExecutorOwnership
    resetRuns();
    try {
      await r.start();
      const out = await r.runNow(wf, "t_own_default");
      check("★ 默认内存注册表：现存用户没有任何另一端登记 → 触发器照常启动", out.ok === true && runsOfNode("t_own_default").length === 1, out);
    } finally {
      r.dispose();
    }
  }

  // ★ 工作流被删/不再是自动化 → apply 释放（不经 dispose）。
  {
    const wf = nextOwnershipId();
    makeOwnerAutomation(wf, "t_own_removed");
    const store = new InMemoryExecutorOwnershipStore();
    const registry = new ExecutorOwnershipRegistry(store);
    const r = new RunnerCtor();
    r.setExecutorOwnership(registry);
    resetRuns();
    try {
      await r.start();
      await r.runNow(wf, "t_own_removed");
      eq("前置：mcode 拥有", registry.executorOwnerOf(wf), "mcode");
      // 删掉工作流 → reloadAll 看到它不再是自动化 → apply 里 release。
      removeWorkflow(wf);
      await (r as unknown as { reloadAll(): Promise<void> }).reloadAll();
      eq("★ 工作流被删 → apply 释放所有权（另一端可接手）", registry.executorOwnerOf(wf), null);
    } finally {
      r.dispose();
    }
  }
}

console.log(`\nautomation-smoke(含 MERGE-3 owner):${total - failures}/${total} 通过`);

console.log(`\nautomation-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exit(1);
