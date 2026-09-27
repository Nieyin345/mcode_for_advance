/**
 * M29 维护套件 —— 自动化事实状态与来源身份冻结。
 *
 * ## §1(红→绿)`AutomationFacts.recordFired` 不许改写挂载侧事实
 *
 * `automationStatus.ts` 类头写着两条不变量,其中一条是:**挂载侧(`armed`/`detail`)
 * 跟着 reload 走,运行侧(`lastFire`/`lastError`)跟着运行走**。它防的是"一次 reload
 * 抹掉运行史";而**反过来那一半**从前没人钉:`recordFired`(运行侧的一笔)把
 * `armed` 立成 `seed.enabled`、把 `detail` 清掉 —— 也就是**一次运行改写了挂载侧**。
 *
 * 症状:一条文件触发器的目录监听已经失效(`recordSetup(seed, false, "目录监听失效")`,
 * 界面正确地显示「没挂上 + 原因」)。用户点一次「立刻运行一次」(手动允许照跑),
 * `fire()` 里的 `recordFired` 这一笔把事实翻成 `armed: true`、`detail: undefined` ——
 * 界面从此说它**响着**,失效原因消失。用户等一个永远不会响的触发器,而"为什么"
 * 已经被这笔清掉了。参数解不开、项目不在了的挂载失败同理。
 *
 * ## §2 来源身份冻结(automationEventOrigin)
 *
 * 「来源身份冻结」是查栏点名的检查项:每个 provider 回合的来源链拍成**不可变快照**,
 * 事后改不动、伪造不了。这里对纯函数面直接断言(快照冻结、坏链拒绝、事件克隆、
 * 会话级兜底链的读法),把这条承诺钉在单元层 —— automation-smoke 只在执行器行为层
 * 绕着验过它。
 *
 * 只用 fixture(临时数据根),不触任何真实服务。
 *
 * Run: scripts/maint-m29-smoke/run.sh
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "mcode-maint-m29-"));
const DATA = join(TMP, "data");
mkdirSync(DATA, { recursive: true });
process.env.MCODE_SMOKE_DATA_ROOT = DATA;

const { AutomationFacts, TRIGGER_DISABLED_DETAIL } = await import("@main/orchestration/automationStatus.js");
const {
  snapshotAutomationOrigin,
  withAutomationOrigin,
  automationOriginOf,
  inheritAutomationOrigin,
  readAutomationEventChain,
  EVENT_CHAIN_PREFIX,
  EVENT_CHAIN_LIMIT,
} = await import("@main/orchestration/automationEventOrigin.js");
const { initDb } = await import("@main/store/db.js");
const { SettingRepo } = await import("@main/store/repositories.js");
type RuntimeEvent = import("@contracts/runtime").RuntimeEvent;

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  checks += 1;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}
function throws(name: string, fn: () => unknown, needle: string): void {
  try {
    fn();
    check(name, false, "没抛");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    check(name, msg.includes(needle), msg);
  }
}

await initDb();

/* ──────────── 1. recordFired 不许改写挂载侧(armed / detail) ──────────── */

console.log("\n1. 挂载坏着的触发器,手动跑一次不等于修好了");
{
  const facts = new AutomationFacts();
  const seed = { workflowId: "wf_m29", nodeId: "T1", title: "盯文件", kind: "file" as const, enabled: true };

  // 目录监听失效 —— 挂载侧记下坏状态与原因。
  facts.recordSetup(seed, false, "目录监听失效:ENOENT");
  const broken = facts.ofWorkflow("wf_m29")[0];
  eq("失效后 armed=false(前提)", broken?.armed, false);
  eq("失效原因在(前提)", broken?.detail, "目录监听失效:ENOENT");

  // 用户点「立刻运行一次」→ fire() 里 recordFired 这一笔。运行侧照记,挂载侧不许动。
  facts.recordFired(seed, 12345);
  const after = facts.ofWorkflow("wf_m29")[0];
  eq("lastFireAt 记了(运行侧照记)", after?.lastFireAt, 12345);
  eq("★ armed 不许被这一笔翻成 true(监听还是死的)", after?.armed, false);
  eq("★ 失效原因不许被这一笔清掉", after?.detail, "目录监听失效:ENOENT");

  // 之后 reload 重试成功 → 挂载侧由 recordSetup 翻回来;运行史不动。
  facts.recordSetup(seed, true);
  const up = facts.ofWorkflow("wf_m29")[0];
  eq("重新挂上后 armed 回 true(挂载侧只归 recordSetup 管)", up?.armed, true);
  eq("detail 清掉", up?.detail, undefined);
  eq("运行史还在", up?.lastFireAt, 12345);
}

console.log("\n1a. 原有语义不回退:健康的、ad-hoc 的、关掉的");
{
  const facts = new AutomationFacts();

  // 健康的:fired 之后照旧响着。
  const healthy = { workflowId: "wf_ok", nodeId: "T", title: "到点跑", kind: "schedule" as const, enabled: true };
  facts.recordSetup(healthy, true);
  facts.recordFired(healthy, 500);
  const ok = facts.ofWorkflow("wf_ok")[0];
  check("健康触发器 fired 之后 armed 仍是 true", ok?.armed === true && ok?.detail === undefined, ok);

  // ad-hoc(守望):没登记过,fired 本身就是登记 —— armed 跟用户那一票。
  facts.recordFired({ workflowId: "wf_watch", nodeId: "T", title: "守望入口", kind: "manual", enabled: true }, 700);
  const watch = facts.ofWorkflow("wf_watch")[0];
  check("ad-hoc 起跑即登记(armed + lastFire)", watch?.armed === true && watch?.lastFireAt === 700, watch);

  // 用户关掉的:手动跑一次不代表它从此自动响 —— armed 仍 false,「是你关的」那句还在。
  const off = { workflowId: "wf_off", nodeId: "T", title: "关掉的", kind: "file" as const, enabled: false };
  facts.recordSetup(off, true);
  facts.recordFired(off, 900);
  const stillOff = facts.ofWorkflow("wf_off")[0];
  eq("关掉的 fired 之后 armed 仍是 false", stillOff?.armed, false);
  eq("「是你关的」那句还在", stillOff?.detail, TRIGGER_DISABLED_DETAIL);
  eq("运行史照记", stillOff?.lastFireAt, 900);
}

/* ──────────── 2. 来源身份冻结(automationEventOrigin) ──────────── */

console.log("\n2. snapshotAutomationOrigin · 快照不可变、坏链拒收");
{
  const ids = ["wf_a", "wf_b"];
  const snap = snapshotAutomationOrigin({ workflowIds: ids });
  check("快照对象被冻结", snap !== undefined && Object.isFrozen(snap) && Object.isFrozen(snap.workflowIds), snap);
  // 事后改源数组,快照不跟着变 —— 这就是「冻结」的意义:回合起跑之后没人改得动来源。
  ids.push("wf_evil");
  eq("★ 源数组事后被改,快照不变", snap?.workflowIds.join(","), "wf_a,wf_b");
  check("快照数组本身推不进东西", (() => {
    try { (snap?.workflowIds as string[]).push("x"); return false; } catch { return true; }
  })(), snap?.workflowIds);

  eq("undefined 原样过(不是链的运行没有来源)", snapshotAutomationOrigin(undefined), undefined);
  throws("空链拒收", () => snapshotAutomationOrigin({ workflowIds: [] }), "损坏");
  throws("重复 id 拒收", () => snapshotAutomationOrigin({ workflowIds: ["a", "a"] }), "损坏");
  throws("非字符串拒收", () => snapshotAutomationOrigin({ workflowIds: ["a", 3 as unknown as string] }), "损坏");
  throws(
    `超过 ${EVENT_CHAIN_LIMIT} 拒收`,
    () => snapshotAutomationOrigin({ workflowIds: Array.from({ length: EVENT_CHAIN_LIMIT + 1 }, (_, i) => `w${i}`) }),
    "损坏",
  );
}

console.log("\n2a. withAutomationOrigin · 每个事件一份克隆,来源只有宿主读得到");
{
  const emitted: RuntimeEvent[] = [];
  const origin = { workflowIds: ["wf_root"] };
  const emit = withAutomationOrigin((e) => emitted.push(e), origin);
  const source = { type: "turn.done", sessionId: "s1", reason: "end_turn", endedAt: 1 } as unknown as RuntimeEvent;
  emit(source);
  eq("发出去一条", emitted.length, 1);
  check("发出的是克隆,不是原对象(SDK 会复用事件对象)", emitted[0] !== source, undefined);
  eq("克隆上的来源读得到", automationOriginOf(emitted[0]!)?.workflowIds.join(","), "wf_root");
  eq("原对象上没有来源(旁人拿不到、也伪造不上)", automationOriginOf(source), undefined);
  // 捕获发生在包装那一刻:事后改 origin 数组,后续事件的来源也不变。
  origin.workflowIds.push("wf_evil");
  emit(source);
  eq("★ 事后改来源数组,后续事件仍是捕获时那份", automationOriginOf(emitted[1]!)?.workflowIds.join(","), "wf_root");

  // 宿主打时间戳/换目标时用 inherit 保真 —— 复制的是同一份冻结快照。
  const retargeted = { ...source, sessionId: "s2" } as RuntimeEvent;
  inheritAutomationOrigin(emitted[0]!, retargeted);
  eq("inherit 带过去了", automationOriginOf(retargeted)?.workflowIds.join(","), "wf_root");

  // 没来源的包装:照发,不挂东西。
  const bare: RuntimeEvent[] = [];
  withAutomationOrigin((e) => bare.push(e), undefined)(source);
  eq("无来源的事件不带 origin", automationOriginOf(bare[0]!), undefined);
}

console.log("\n2b. readAutomationEventChain · 会话级兜底链的读法");
{
  const source = { id: "sess_m29", workflowId: "wf_m29" };
  eq("没存过 = 退回 [自己的 workflowId]", readAutomationEventChain(source).join(","), "wf_m29");

  SettingRepo.set(EVENT_CHAIN_PREFIX + source.id, JSON.stringify({ version: 1, workflowIds: ["wf_up", "wf_m29"] }));
  eq("存过的链原样读回", readAutomationEventChain(source).join(","), "wf_up,wf_m29");
  const first = readAutomationEventChain(source);
  first.push("wf_evil");
  eq("读回的是拷贝,改了不污染下一次", readAutomationEventChain(source).join(","), "wf_up,wf_m29");

  SettingRepo.set(EVENT_CHAIN_PREFIX + source.id, JSON.stringify({ version: 1, workflowIds: ["wf_other"] }));
  throws("链里不含自己的 workflowId = 损坏,拒绝", () => readAutomationEventChain(source), "损坏");
  SettingRepo.set(EVENT_CHAIN_PREFIX + source.id, JSON.stringify({ version: 2, workflowIds: ["wf_m29"] }));
  throws("版本不认识 = 损坏,拒绝", () => readAutomationEventChain(source), "损坏");
  SettingRepo.set(EVENT_CHAIN_PREFIX + source.id, JSON.stringify({ version: 1, workflowIds: ["wf_m29", "wf_m29"] }));
  throws("重复 id = 损坏,拒绝", () => readAutomationEventChain(source), "损坏");
}

/* ──────────── 收尾 ──────────── */

rmSync(TMP, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
