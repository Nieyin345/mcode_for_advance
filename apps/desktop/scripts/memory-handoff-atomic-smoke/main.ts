/**
 * memory-handoff-atomic-smoke —— 【MC-025】记忆助手交接的 job、源索引、目标指针
 * 必须**原子发表**:崩溃打断时不许留下任何半边状态。
 *
 * ## 判据立在用户可观察的不变式上,不是立在"调没调 setMany"上
 *
 * 台账的失败反例是两条具体状态:
 *   1. "job 行落盘了、源索引没写" → 重启后 `listAssistantJobs` 不列它 —— **不可见 job**,
 *      占着一行永不回收的设置(设置表每写一次都要重写整个库文件);
 *   2. "job 已 queued、目标指针没写" → `pendingAssistantHandoff` 只按指针读 —— 材料石沉大海。
 * 修复后同一动作要么整体可见、要么保持旧状态可重试。所以断言直接读**磁盘**:
 * 重启后的新进程里,按 `memory.assistant.job.` 前缀逐行扫,任何"来源对得上、索引却列不出来"
 * 的行都算红;任何"queued 却没有指针"的包都算红。
 *
 * ## 故障怎么注入(见 stubs/repositories.ts)
 *
 * 桩把 `SettingRepo.set` / `setMany` 包了一层:命中武装前缀时,先 `flushDb()` 把当前
 * 内存态**落盘**(模拟"前一次写已经 durable"),再 `process.exit(9)`(模拟进程中止)。
 * 旧代码(两次 set)在第二次写点死,第一次已落盘 → 重启可见半边状态;修复后的单事务
 * 在事务开始前死,一个字节都没写 → 重启无任何中间态。**同一把武装对两种实现各自
 * 死在自己的写点上** —— 这正是变异验证的判据来源。
 *
 * ## 六趟(见 run.sh)
 *
 * `seed`(建会话、备好 ready 包、验撤回协议)→ `crash-create` / `crash-queue`(各武装
 * 一处写点、等 exit(9))→ `verify-restart`(新进程读盘验不变式 + 重试正控 + 两目标并发)
 * → `crash-consume` → `verify-consume`(新进程:指针不悬挂在终结态、同一包可重投)。
 *
 * ## 安全前提
 *
 * 真的建库、真写行 —— 数据根走 `MCODE_SMOKE_DATA_ROOT`(mktemp -d,桩里没设就抛),
 * 跑完即删。指错地方等于拿空库盖掉用户的聊天记录。
 */
import { readFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { Project, Session } from "@contracts/session";
import type { MemoryAssistantJob } from "@contracts/memoryAssistant";

let failures = 0;
let total = 0;
/** 用 `fs.writeSync` 直写 fd 1:崩溃趟 `process.exit(9)` 会截断 stdout 管道里**异步**
 *  排队的 `console.log` —— 断言行必须当场落盘,不然红绿都看不见。 */
function emit(line: string): void {
  writeSync(1, line + "\n");
}
function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) emit(`  ok   ${name}`);
  else {
    failures++;
    emit(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}
function eq(name: string, actual: unknown, expected: unknown): void { check(name, Object.is(actual, expected), { actual, expected }); }
function throws(label: string, run: () => unknown): void {
  let failed = false;
  try { run(); } catch { failed = true; }
  check(label, failed);
}
function finish(pass: string): never {
  emit(`\nmemory-handoff-atomic-smoke(${pass}):${total - failures}/${total} 通过`);
  process.exit(failures > 0 ? 1 : 0);
}

const DATA = process.env.MCODE_SMOKE_DATA_ROOT;
if (!DATA) throw new Error("MCODE_SMOKE_DATA_ROOT unset — run via run.sh");
const FIXTURE = join(DATA, "mc025-fixture.json");
const pass = process.argv[2] ?? "";

const { initDb, flushDb } = await import("@main/store/db.js");
// ⚠️ 这个 specifier 被 run.sh 的 --alias 换成 `stubs/repositories.ts`;桩 `export *`
// 真模块,所以这里拿到的 SessionRepo/ProjectRepo 仍是真货。
const { SessionRepo, ProjectRepo, SettingRepo } = await import("@main/store/repositories.js");
const { armWriteFault } = await import("./stubs/repositories.js");
const store = await import("@main/memory/assistantStore.js");

await initDb();

const PROJECT_ID = "p_mc025";
const SOURCE = "s_mc025_source";
const T1 = "s_mc025_target1";
const T2 = "s_mc025_target2";
const T3 = "s_mc025_target3";
const targetKeyOf = (id: string): string => `memory.assistant.target.${id}`;
const JOB_PREFIX = "memory.assistant.job.";

function mkProject(): Project {
  const now = 1_700_000_000_000;
  return { id: PROJECT_ID, name: "MC-025 夹具", path: DATA!, archived: false, group: null, sortOrder: 0, pinnedAt: null, createdAt: now, updatedAt: now };
}
function mkSession(id: string): Session {
  const now = 1_700_000_000_000;
  return {
    id, projectId: PROJECT_ID, providerId: "claude-sdk", claudeSessionId: null, kind: "chat",
    parentSessionId: null, nodeId: null, title: id, status: "idle", model: "sonnet", effort: "default",
    permissionMode: "default", workflowId: "default", customModelId: null, envMode: "local", worktreePath: null,
    archived: false, pinnedAt: null, contextSnapshot: null, todos: null, subagents: null, planDraft: null,
    turnFiles: null, usageHistory: null, bookmarks: null, subagentTranscripts: null, createdAt: now, updatedAt: now,
  };
}
let workerSeq = 0;
function readyJob(): MemoryAssistantJob {
  const job = store.createAssistantJob(SOURCE, PROJECT_ID, `worker-mc025-${++workerSeq}`, "checkpoint");
  store.saveAssistantJob({ ...job, status: "ready", result: "目标、已验证进度、下一步" });
  return job;
}
interface Fixture { sourceId: string; jobA: string; cancelledJob: string }
function readFixture(): Fixture { return JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture; }

/** 扫出"来源对得上、索引却列不出来"的 job 行 —— 台账红例的不可见 job。坏行(JSON 坏)
 *  不归本套件管(MC-052 有专网),跳过。 */
function invisibleJobs(sourceId: string): string[] {
  const listed = new Set(store.listAssistantJobs(sourceId).map((j) => j.id));
  const out: string[] = [];
  for (const k of SettingRepo.keysWithPrefix(JOB_PREFIX)) {
    const raw = SettingRepo.get(k);
    if (!raw) continue;
    let parsed: { id?: unknown; sourceSessionId?: unknown };
    try { parsed = JSON.parse(raw) as typeof parsed; } catch { continue; }
    if (parsed.sourceSessionId === sourceId && typeof parsed.id === "string" && !listed.has(parsed.id)) out.push(parsed.id);
  }
  return out;
}

if (pass === "seed") {
  console.log("【MC-025】第一趟:建会话 + 备好 ready 包 + 无崩溃的撤回协议");
  ProjectRepo.create(mkProject());
  for (const id of [SOURCE, T1, T2, T3]) SessionRepo.create(mkSession(id));

  const a = readyJob();
  check("seed:ready 包已索引可见", store.listAssistantJobs(SOURCE).some((j) => j.id === a.id));

  // 撤回协议(无崩溃路径):排入队列后撤回 —— job 终结与指针清理同一事务,不留悬挂指针。
  const c = readyJob();
  store.queueAssistantHandoff(c.id, SOURCE, T3);
  eq("撤回前:T3 能看到待接收包", store.pendingAssistantHandoff(T3)?.id, c.id);
  store.cancelAssistantJob(store.readAssistantJob(c.id)!);
  eq("★ 撤回后指针立即清空(不留悬挂)", SettingRepo.get(targetKeyOf(T3)), "");
  eq("撤回后 T3 读不到待接收包", store.pendingAssistantHandoff(T3), null);
  eq("撤回后 job 状态为 cancelled", store.readAssistantJob(c.id)?.status, "cancelled");

  writeFileSync(FIXTURE, JSON.stringify({ sourceId: SOURCE, jobA: a.id, cancelledJob: c.id } satisfies Fixture));
  flushDb();
  finish(pass);
} else if (pass === "crash-create") {
  console.log("【MC-025】第二趟:武装源索引写点,创建任务时崩溃(期望 exit 9)");
  const f = readFixture();
  check("夹具在位", typeof f.sourceId === "string" && f.sourceId === SOURCE);
  if (failures > 0) process.exit(1);
  armWriteFault("exit", "memory.assistant.source.");
  try {
    store.createAssistantJob(f.sourceId, PROJECT_ID, "worker-crash-create", "checkpoint");
  } catch (e) {
    emit(`  FAIL 创建在故障注入之前抛错(说明红的原因不是崩溃):${String(e)}`);
    process.exit(1);
  }
  emit("  FAIL 故障注入没有触发 —— 创建路径没经过被武装的写点(包装被绕过?)");
  process.exit(1);
} else if (pass === "crash-queue") {
  console.log("【MC-025】第三趟:武装目标指针写点,转交任务时崩溃(期望 exit 9)");
  const f = readFixture();
  const before = store.readAssistantJob(f.jobA);
  check("夹具包在位且为 ready", before?.status === "ready", before?.status);
  if (failures > 0) process.exit(1);
  armWriteFault("exit", "memory.assistant.target.");
  try {
    store.queueAssistantHandoff(f.jobA, f.sourceId, T1);
  } catch (e) {
    emit(`  FAIL 转交在故障注入之前抛错:${String(e)}`);
    process.exit(1);
  }
  emit("  FAIL 故障注入没有触发 —— 转交路径没经过被武装的写点");
  process.exit(1);
} else if (pass === "verify-restart") {
  console.log("【MC-025】第四趟:新进程读盘 —— 崩溃不留半边状态、重试可整体成功");
  const f = readFixture();

  // ① 不可见 job:第一条红例。旧代码在 crash-create 后这里会扫出 1 条。
  const orphans = invisibleJobs(f.sourceId);
  eq("★ 重启后没有'行在、索引列不出'的不可见 job", orphans.length, 0);
  // ② 半发表的转交:第二条红例。旧代码在 crash-queue 后 A 是 queued 但指针为空。
  const a = store.readAssistantJob(f.jobA);
  check("★ 重启后交接包要么整体没写(ready)、要么整体写全(queued)", a?.status === "ready" || a?.status === "queued", a?.status);
  const pointerT1 = SettingRepo.get(targetKeyOf(T1));
  check("中断的转交没有留下半个指针", !pointerT1, pointerT1);
  check("queued 与指针同生(spec:queued ⟺ 指针可见)", (a?.status === "queued") === Boolean(pointerT1), { status: a?.status, pointer: pointerT1 });

  // ③ 正控:旧状态可重试,重试后整体可见(台账验收的"保持旧状态并可重试")。
  store.queueAssistantHandoff(f.jobA, f.sourceId, T1);
  eq("★ 中断的转交重启后可重试并整体可见", store.pendingAssistantHandoff(T1)?.id, f.jobA);

  // ④ 两目标并发:各自持有各自的包,互不串。
  const b = readyJob();
  store.queueAssistantHandoff(b.id, f.sourceId, T2);
  check("两个目标各自持有各自的包", store.pendingAssistantHandoff(T1)?.id === f.jobA && store.pendingAssistantHandoff(T2)?.id === b.id,
    { t1: store.pendingAssistantHandoff(T1)?.id, t2: store.pendingAssistantHandoff(T2)?.id });
  // ⑤ 一份材料不会出现在两个目标(第二个接收者面)。
  throws("同一包不能同时排给第二个目标", () => store.queueAssistantHandoff(f.jobA, f.sourceId, T2));
  // ⑥ 一个目标不会有两个待接收包。
  const d = readyJob();
  throws("目标已有待接收包时不能再塞一份", () => store.queueAssistantHandoff(d.id, f.sourceId, T1));
  // ⑦ 撤回结果跨重启保持(seed 趟撤掉的那份)。
  eq("撤回状态跨重启持久", store.readAssistantJob(f.cancelledJob)?.status, "cancelled");
  eq("撤回清掉的指针跨重启仍为空", SettingRepo.get(targetKeyOf(T3)), "");
  eq("撤回清掉的指针跨重启仍清(读口)", store.pendingAssistantHandoff(T3), null);

  flushDb();
  finish(pass);
} else if (pass === "crash-consume") {
  console.log("【MC-025】第五趟:武装指针清理写点,消费回执时崩溃(期望 exit 9)");
  const f = readFixture();
  eq("夹具包已排给 T1(verify-restart 重试过)", store.pendingAssistantHandoff(T1)?.id, f.jobA);
  if (failures > 0) process.exit(1);
  armWriteFault("exit", "memory.assistant.target.");
  try {
    store.consumeAssistantHandoff(T1, f.jobA);
  } catch (e) {
    emit(`  FAIL 消费在故障注入之前抛错:${String(e)}`);
    process.exit(1);
  }
  emit("  FAIL 故障注入没有触发 —— 消费路径没经过被武装的写点");
  process.exit(1);
} else if (pass === "verify-consume") {
  console.log("【MC-025】第六趟:新进程 —— 指针不悬挂在终结态、中断的消费可重试");
  const f = readFixture();
  const raw = SettingRepo.get(targetKeyOf(T1));
  const a = store.readAssistantJob(f.jobA);

  // ① 不变式:指针要么为空、要么指向一个**仍可投递**的包。旧代码在 crash-consume 后
  //    留下"job 已 consumed、指针还在"的悬挂态 —— 这条当场红。
  check("★ 重启后指针不悬挂在终结态(consumed/expired/cancelled 必须已清)",
    !raw || (a !== null && a.status === "queued"), { pointer: raw, status: a?.status });
  // ② 中断的消费保持旧状态:同一包仍可投递(不会被吞掉,也不会重复注入)。
  eq("★ 崩溃中断的消费:重启后同一包仍可投递(保持旧状态)", store.pendingAssistantHandoff(T1)?.id, f.jobA);

  // ③ 重试消费 —— 整体成功。
  store.consumeAssistantHandoff(T1, f.jobA);
  eq("重试消费后指针清空", SettingRepo.get(targetKeyOf(T1)), "");
  const consumed = store.readAssistantJob(f.jobA);
  check("重试消费后 job 终结且正文被清", consumed?.status === "consumed" && consumed.result === "", { status: consumed?.status, result: consumed?.result });
  eq("消费后不再注入", store.pendingAssistantHandoff(T1), null);
  // ④ 重复消费幂等;已消费包不能重新投递(重复注入面)。
  store.consumeAssistantHandoff(T1, f.jobA);
  eq("重复消费是幂等 no-op", SettingRepo.get(targetKeyOf(T1)), "");
  throws("已消费包不能重新投递", () => store.queueAssistantHandoff(f.jobA, f.sourceId, T1));

  flushDb();
  finish(pass);
} else {
  emit(`未知趟名:${pass}(用法: seed | crash-create | crash-queue | verify-restart | crash-consume | verify-consume)`);
  process.exit(2);
}
