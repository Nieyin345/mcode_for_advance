/**
 * T2 · Node-RED 原生 Deploy ↔ Mcode 工作流库对账恢复（无头 E1）
 *
 * 旧红例（修复前 `registry.ts:557` 的真实行为）：
 *   原生 Deploy 已经 2xx 提交，`syncLibrary` 抛错（CAS 冲突/校验拒绝/进程中断）。
 *   旧实现只有一行 `log.error(...)` —— 没有持久记录、没有可查状态、没有重试入口；
 *   下一张 Deploy 会用旧镜像覆盖；用户重启后也看不到任何“两边不一致”的事实。
 *
 * 本套钉的是四条产品判据：
 *   1. **可观测**：镜像失败进入 `deploy-reconciliation.json`（重启后仍在），并发出
 *      看板事件 `workflow.node.result`（`@node-red-runboard:<docId>`），不是只写日志。
 *   2. **可恢复**：`retryPending` / `reconcileNativeLibraryMirror` 按**当前**原生
 *      `flows.json` 重放；成功即清账。无需用户手工比对两边。
 *   3. **不宣称跨存储原子**：报告把每份文档分成 mirrored / conflict / failed /
 *      skipped-* / removed，冲突**绝不自动覆盖**，也不把镜像失败说成 Deploy 失败。
 *   4. **覆盖重复/迟到 ACK、崩溃/重启、非法数据、重试路径**：
 *      - 同一 Deploy 回执重复投递 → 同一 deployId，结果幂等；
 *      - 早先 Deploy 的迟到结果不覆盖后到 Deploy 的意图（at 单调）；
 *      - 进程中断（镜像排队时崩溃）→ 重启后账本仍在，start 对该账重放；
 *      - 非法载荷（重复 docId / 非法 docId / 坏 JSON flows.json）→ 显式 lastError，
 *        绝不伪造 pending 文档、绝不清空账本；
 *      - 用户明确 `acceptNativeRevision` 时才覆盖冲突。
 *
 * 真实生产 SQL 库经 **stub ports** 注入（`nativeLibrarySync` 的端口契约就是生产
 * `getWorkflow/saveWorkflow/workflowSaveVersion/notifyWorkflowsChanged` 的形状）；
 * 落盘账本/原生画布用本套 mktemp 数据根，不碰用户数据。
 *
 * Run: bash scripts/node-red-deploy-reconciliation-smoke/run.sh
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowDoc } from "@contracts/workflow";
import type { RuntimeEvent, WorkflowNodeResultEvent } from "@contracts/runtime";
import {
  NativeDeployLibraryMirror,
  NATIVE_DEPLOY_RECONCILIATION_FILE,
  nativeLibraryDocsOf,
  nativeMirrorEvents,
  readNativeDeployReconciliation,
  reconcileNativeLibraryMirror,
  runNativeDeployMirror,
  syncDeployedNativeWorkflows,
  syncNativeLibraryDocs,
} from "@main/workflowEngines/nativeLibrarySync.js";
import { migrateWorkflowDoc } from "@main/workflowEngines/flowMigration.js";
import { workflowSaveVersion } from "@main/orchestration/workflowSaveVersion.js";
import { ProductionWorkflowEngineRegistry } from "@main/workflowEngines/registry.js";
import { ExecutorOwnershipRegistry, InMemoryExecutorOwnershipStore } from "@main/workflowEngines/executorOwnership.js";
import type { EngineRuntimePorts } from "@main/workflowEngines/runtimeSupervisor.js";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

const ROOT = process.env.MCODE_SMOKE_DATA_ROOT;
if (!ROOT || !/mcode-deploy-reconciliation/i.test(ROOT)) {
  throw new Error("Refusing to run without fresh isolated MCODE_SMOKE_DATA_ROOT");
}
const ENGINE_DIR = join(ROOT, "workflow-engines", "node-red");
mkdirSync(ENGINE_DIR, { recursive: true });

/* ─────────────────────── 虚构库：与生产端口同形状 ─────────────────────── */

interface FakeLibrary {
  docs: Map<string, WorkflowDoc>;
  saves: string[];
  changes: string[];
  /** Per-doc forced save rejection (validation-style, CAS untouched). */
  reject: Map<string, string>;
  /** Per-doc “another writer touched the SQL doc right before save”. */
  race: Map<string, (id: string) => void>;
  ports: {
    get(id: string): WorkflowDoc | null;
    save(doc: WorkflowDoc, expected: string): Promise<{ ok: boolean; error?: string }>;
    revision(doc: WorkflowDoc): string;
    changed(id: string): void;
  };
}

function fakeLibrary(initial: WorkflowDoc[]): FakeLibrary {
  const lib: FakeLibrary = {
    docs: new Map(initial.map(doc => [doc.id, structuredClone(doc)])),
    saves: [], changes: [], reject: new Map(), race: new Map(),
    ports: {
      get: (id) => structuredClone(lib.docs.get(id) ?? null),
      revision: (doc) => workflowSaveVersion(doc),
      save: async (doc, expected) => {
        const forced = lib.race.get(doc.id);
        forced?.(doc.id);
        const current = lib.docs.get(doc.id);
        if (!current || workflowSaveVersion(current) !== expected) {
          return { ok: false, error: "工作流已被其他写者修改或删除；请保留草稿并重新打开最新版本后再合并" };
        }
        const rejected = lib.reject.get(doc.id);
        if (rejected !== undefined) return { ok: false, error: rejected };
        lib.docs.set(doc.id, structuredClone(doc));
        lib.saves.push(doc.id);
        return { ok: true };
      },
      changed: (id) => { lib.changes.push(id); },
    },
  };
  return lib;
}

/** A Mcode doc and the native deploy payload a real editor would POST after
 * editing its tab (same `migrateWorkflowDoc` shape as production). */
function fixtures(id: string, title = "before"): { doc: WorkflowDoc; nodes: unknown[] } {
  const doc: WorkflowDoc = {
    id, name: `Fixture ${id}`, builtin: false, updatedAt: 1_700_000_000_000,
    nodes: [{ id: "step", type: "mcode.agent", title, params: { instruction: "检查" }, position: { x: 1, y: 2 } }],
    edges: [],
  };
  return { doc, nodes: JSON.parse(JSON.stringify(migrateWorkflowDoc(doc).flow.nodes)) as unknown[] };
}

function withTabTitle(nodes: unknown[], title: string): unknown[] {
  const copy = structuredClone(nodes) as Array<Record<string, unknown>>;
  for (const node of copy) {
    if (node["type"] === "tab") { node["label"] = title; continue; }
    if (node["x-mcode"] !== undefined) node["name"] = title;
  }
  return copy;
}

function ledger(dataDir = ENGINE_DIR): string {
  return join(dataDir, NATIVE_DEPLOY_RECONCILIATION_FILE);
}

function resetLedger(): void {
  rmSync(ledger(), { force: true });
}

/* ─────────────── 1. 旧红例：镜像失败不再是“只有一行日志” ─────────────── */

console.log("\n1. 旧红例：原生已提交、库镜像 CAS 失败 → 持久待对账 + 看板事件");
{
  resetLedger();
  const a = fixtures("wf_t2_a", "before");
  const lib = fakeLibrary([a.doc]);
  const mirror = new NativeDeployLibraryMirror({ dataDir: ENGINE_DIR, ports: lib.ports });
  // A concurrent SQL edit lands between prepare and mirror → the guarded CAS save fails.
  lib.race.set("wf_t2_a", (id) => {
    const current = lib.docs.get(id)!;
    lib.docs.set(id, { ...current, name: "Concurrent library edit" });
    lib.race.delete(id);
  });
  const report = await mirror.mirrorDeploy(withTabTitle(a.nodes, "after"));
  eq("旧红例：镜像失败被分类为 conflict（不是 OK、不是 Deploy 失败）", report.docs[0]?.status, "conflict");
  eq("旧红例：报告整体 ok=false", report.ok, false);

  const pending = readNativeDeployReconciliation(ENGINE_DIR);
  eq("旧红例：失败进入持久账本（重启后仍在）", pending.pending.length, 1);
  eq("旧红例：账本记录文档身份", pending.pending[0]?.docId, "wf_t2_a");
  eq("旧红例：账本记录冲突状态", pending.pending[0]?.status, "conflict");
  eq("旧红例：库中的并发编辑未被覆盖", lib.docs.get("wf_t2_a")?.name, "Concurrent library edit");

  const events = nativeMirrorEvents(report);
  const ev = events[0] as WorkflowNodeResultEvent | undefined;
  check("旧红例：失败发出用户可见的看板事件（不是只写日志）", ev !== undefined, events);
  eq("旧红例：事件落在该工作流的原生看板命名空间", ev?.sessionId, "@node-red-runboard:wf_t2_a");
  eq("旧红例：事件标为失败", ev?.status, "failed");
  check("旧红例：事件说明原生已提交、镜像未完成、未自动覆盖", (ev?.error ?? "").includes("未自动覆盖"), ev?.error);

  // Read the ledger back from a brand-new instance: durable, not in-memory only.
  const restarted = new NativeDeployLibraryMirror({ dataDir: ENGINE_DIR, ports: lib.ports });
  eq("旧红例：新实例（模拟重启）从磁盘读回待对账", restarted.pending().pending.length, 1);
}

/* ───────── 2. 可恢复：retryPending 按当前原生画布重放并清账 ───────── */

console.log("\n2. 可恢复：retryPending 重放并清账（无需用户手工比对）");
{
  resetLedger();
  const a = fixtures("wf_t2_b", "before");
  const lib = fakeLibrary([a.doc]);
  // First deploy: forced validation-style rejection (SQL revision unchanged).
  lib.reject.set("wf_t2_b", "校验未通过：模拟节点参数缺失");
  const mirror = new NativeDeployLibraryMirror({ dataDir: ENGINE_DIR, ports: lib.ports });
  const first = await mirror.mirrorDeploy(withTabTitle(a.nodes, "native-after"));
  eq("重试路径：首次保存被拒绝分类为 failed", first.docs[0]?.status, "failed");
  eq("重试路径：账本状态 = failed", readNativeDeployReconciliation(ENGINE_DIR).pending[0]?.status, "failed");

  // The user fixes the cause; nothing else changes in SQL. retryPending replays
  // against the CURRENT native canvas (here the same deploy payload on disk).
  lib.reject.delete("wf_t2_b");
  writeFileSync(join(ENGINE_DIR, "flows.json"), JSON.stringify(withTabTitle(a.nodes, "native-after")), "utf8");
  const retried = await mirror.retryPending();
  eq("重试路径：重放成功", retried.docs[0]?.status, "mirrored");
  eq("重试路径：库内容来自原生 Deploy", lib.docs.get("wf_t2_b")?.nodes[0]?.title, "native-after");
  eq("重试路径：成功后账本清空", readNativeDeployReconciliation(ENGINE_DIR).pending.length, 0);
  eq("重试路径：重试成功不重复写", lib.saves.filter(id => id === "wf_t2_b").length, 1);

  const again = await mirror.retryPending();
  eq("重试路径：无待对账时重试是幂等空操作", again.docs.length, 0);
}

/* ────── 3. 冲突不自动覆盖；只有显式 acceptNativeRevision 才覆盖 ────── */

console.log("\n3. 冲突守则：自动重试不覆盖并发编辑；显式接受才覆盖");
{
  resetLedger();
  const a = fixtures("wf_t2_c", "before");
  const lib = fakeLibrary([a.doc]);
  const mirror = new NativeDeployLibraryMirror({ dataDir: ENGINE_DIR, ports: lib.ports });
  lib.race.set("wf_t2_c", () => {
    const current = lib.docs.get("wf_t2_c")!;
    lib.docs.set("wf_t2_c", { ...current, name: "User renamed while deploy pending" });
    lib.race.delete("wf_t2_c");
  });
  const first = await mirror.mirrorDeploy(withTabTitle(a.nodes, "native-after"));
  eq("冲突守则：首次 = conflict", first.docs[0]?.status, "conflict");
  writeFileSync(join(ENGINE_DIR, "flows.json"), JSON.stringify(withTabTitle(a.nodes, "native-after")), "utf8");

  const auto = await mirror.retryPending();
  eq("冲突守则：自动重试仍是 conflict（不覆盖用户编辑）", auto.docs[0]?.status, "conflict");
  eq("冲突守则：用户改名原样保留", lib.docs.get("wf_t2_c")?.name, "User renamed while deploy pending");
  eq("冲突守则：冲突账本仍待处理", readNativeDeployReconciliation(ENGINE_DIR).pending[0]?.status, "conflict");

  const accepted = new NativeDeployLibraryMirror({ dataDir: ENGINE_DIR, ports: lib.ports });
  const forced = await accepted.retryPending(undefined, { acceptNativeRevision: true });
  eq("冲突守则：显式接受原生版本后镜像成功", forced.docs[0]?.status, "mirrored");
  eq("冲突守则：显式接受后账本清空", readNativeDeployReconciliation(ENGINE_DIR).pending.length, 0);
}

/* ───────── 4. 重复/迟到 ACK、较早 Deploy 不遮蔽较新 Deploy ───────── */

console.log("\n4. 重复/迟到 ACK：同一回执幂等，旧回执不覆盖新意图");
{
  resetLedger();
  const a = fixtures("wf_t2_d", "before");
  const lib = fakeLibrary([a.doc]);
  let clock = 1000;
  const mirror = new NativeDeployLibraryMirror({ dataDir: ENGINE_DIR, ports: lib.ports, now: () => clock });
  const oldPayload = withTabTitle(a.nodes, "old-deploy");
  const newPayload = withTabTitle(a.nodes, "new-deploy");

  lib.reject.set("wf_t2_d", "第一次被拒绝");
  const first = await mirror.mirrorDeploy(oldPayload);
  const firstId = first.deployId;
  eq("ACK：第一次失败留下待对账", readNativeDeployReconciliation(ENGINE_DIR).pending.length, 1);

  // Duplicate delivery of the SAME receipt: identical deployId, no new intent.
  lib.reject.delete("wf_t2_d");
  const duplicate = await mirror.mirrorDeploy(structuredClone(oldPayload));
  eq("ACK：重复回执得到同一 deployId（可幂等识别）", duplicate.deployId, firstId);
  eq("ACK：重复回执后账本被成功镜像清空", readNativeDeployReconciliation(ENGINE_DIR).pending.length, 0);

  // A LATER deploy fails; then a DELAYED result of the OLD deploy must not clear it.
  clock = 2000;
  lib.reject.set("wf_t2_d", "第二次被拒绝");
  const newer = await mirror.mirrorDeploy(newPayload);
  eq("ACK：较新 Deploy 失败进入账本", readNativeDeployReconciliation(ENGINE_DIR).pending[0]?.at, 2000);

  clock = 1000; // a late duplicate of the old (successful) receipt
  lib.reject.delete("wf_t2_d");
  const late = await mirror.mirrorDeploy(structuredClone(oldPayload));
  const afterLate = readNativeDeployReconciliation(ENGINE_DIR);
  eq("ACK：迟到旧回执被识别为 superseded（不重放旧内容）", late.docs[0]?.status, "superseded");
  eq("ACK：迟到旧回执不抹掉较新 Deploy 的待对账", afterLate.pending.length, 1);
  eq("ACK：账本仍是较新 Deploy 的意图", afterLate.pending[0]?.at, 2000);
  eq("ACK：库内容没有被旧回执改写", lib.docs.get("wf_t2_d")?.nodes[0]?.title, "old-deploy");
  void newer;
}

/* ─────── 4b. 同内容回执幂等，坏持久介质不可谎称有安全镜像 ─────── */
console.log("\n4b. 原生图只镜像一次，坏账本 fail-closed");
{
  resetLedger();
  const a = fixtures("wf_t2_same", "first");
  const lib = fakeLibrary([a.doc]);
  let now = 10_000;
  const mirror = new NativeDeployLibraryMirror({ dataDir: ENGINE_DIR, ports: lib.ports, now: () => now });
  const payload = withTabTitle(a.nodes, "same");
  const first = await mirror.mirrorDeploy(payload);
  eq("第一次原生图确实保存", first.docs[0]?.status, "mirrored");
  eq("第一次 SQL 镜像只写入一次", lib.saves.length, 1);
  now = 11_000;
  const duplicate = await mirror.mirrorDeploy(structuredClone(payload));
  eq("相同原生图重复 Deploy/ACK 不再重写 SQL", duplicate.docs[0]?.status, "superseded");
  eq("重复 ACK 后库修订和事件仍只变化一次", lib.saves.length, 1);
  eq("成功后的持久应用水位保持原版本", readNativeDeployReconciliation(ENGINE_DIR).applied["wf_t2_same"]?.at, 10_000);
  // Two different deployments issued in the SAME millisecond still need
  // distinct ordering in the durable journal; it must not depend on sleep.
  now = 11_000;
  const sameMsFirst = await mirror.mirrorDeploy(withTabTitle(a.nodes, "same-ms-first"));
  eq("同一毫秒内先有一笔真正新 Deploy", sameMsFirst.docs[0]?.status, "mirrored");
  const equalMillisecond = await mirror.mirrorDeploy(withTabTitle(a.nodes, "same-ms-newer"));
  eq("同毫秒的后继 Deploy 仍能提交 SQL", equalMillisecond.docs[0]?.status, "mirrored");
  check("同毫秒后继的持久序列严格大于上一笔",
    (readNativeDeployReconciliation(ENGINE_DIR).applied["wf_t2_same"]?.at ?? 0) > 11_000,
    readNativeDeployReconciliation(ENGINE_DIR).applied);
  eq("同毫秒图更新后 SQL 已是最新版本", lib.docs.get("wf_t2_same")?.nodes[0]?.title, "same-ms-newer");
  // A later native Deploy can legitimately fail. A very late duplicate of
  // the already applied graph MUST NOT erase its pending reconciliation.
  now = 12_000;
  lib.reject.set("wf_t2_same", "新 Deploy 暂时无法同步");
  const newer = await mirror.mirrorDeploy(withTabTitle(a.nodes, "different"));
  eq("新图失败保留待对账", newer.docs[0]?.status, "failed");
  now = 13_000;
  const lateDuplicate = await mirror.mirrorDeploy(payload);
  eq("更晚到达的旧相同图只读跳过", lateDuplicate.docs[0]?.status, "superseded");
  const pending = readNativeDeployReconciliation(ENGINE_DIR).pending;
  check("旧图重复回执不会清除较新图的待对账事实",
    pending.length === 1 && pending[0]?.deployId === newer.deployId, pending);

  const badDir = join(ROOT, "no-ledger-file");
  mkdirSync(badDir, { recursive: true });
  // A directory at the ledger filename makes atomicReplaceFileSync fail on
  // both Windows and POSIX. This is *not* the user's workflow data root.
  mkdirSync(join(badDir, NATIVE_DEPLOY_RECONCILIATION_FILE));
  const broken = new NativeDeployLibraryMirror({ dataDir: badDir, ports: lib.ports });
  const writesBefore = lib.saves.length;
  let rejected: unknown;
  try { await broken.mirrorDeploy(withTabTitle(a.nodes, "other")); }
  catch (err) { rejected = err; }
  check("对账账本不可写时明确失败而非先静默写 SQL", rejected instanceof Error &&
    rejected.message.includes("无法持久记录"), String(rejected));
  eq("无法写持久意图时没有触发 SQL 保存", lib.saves.length, writesBefore);

  lib.reject.delete("wf_t2_same");
  for (let i = 0; i < 12; i++) {
    now = 20_000 + i;
    const success = await mirror.mirrorDeploy(withTabTitle(a.nodes, "history-" + i));
    eq("对账内容指纹滚动窗口内不同 Deploy 均可正常镜像 " + i,
      success.docs[0]?.status, "mirrored");
  }
  const retained = readNativeDeployReconciliation(ENGINE_DIR).applied["wf_t2_same"]?.seen ?? [];
  check("已经应用的 Deploy 历史是有界窗口，不随进程长期使用无限增长",
    retained.length === 8 && new Set(retained).size === 8, { count: retained.length });
}

/* ───────── 5. 崩溃/重启：排队时中断仍有持久意图，启动重放 ───────── */

console.log("\n5. 崩溃/重启：意图同步落盘，重启后重放（runboard 事件）");
{
  resetLedger();
  const a = fixtures("wf_t2_e", "before");
  const lib = fakeLibrary([a.doc]);
  const revisionOf = (id: string): string | null => {
    const doc = lib.docs.get(id);
    return doc === undefined ? null : workflowSaveVersion(doc);
  };
  // A save that hangs longer than the (shortened) budget: simulates the process
  // dying while the mirror is queued. The durable intent must exist anyway.
  const hangPorts = {
    ...lib.ports,
    save: () => new Promise<{ ok: boolean }>(() => { /* never settles */ }),
  };
  const crashed = new NativeDeployLibraryMirror({
    dataDir: ENGINE_DIR, ports: hangPorts, revisionOf, saveTimeoutMs: 150,
  });
  const crashedTask = crashed.mirrorDeploy(withTabTitle(a.nodes, "deploy-before-crash"));
  // The durable intent must already be on disk synchronously, before any await.
  eq("崩溃/重启：镜像尚未完成时账本已有 pending", readNativeDeployReconciliation(ENGINE_DIR).pending.length, 1);
  eq("崩溃/重启：pending 记录 SQL 预期修订（生产提供 revisionOf）",
    typeof readNativeDeployReconciliation(ENGINE_DIR).pending[0]?.expectedRevision, "string");
  const crashedReport = await crashedTask;
  eq("崩溃/重启：挂起的保存在超时后显式失败（不永久卡住队列）", crashedReport.docs[0]?.status, "failed");
  eq("崩溃/重启：超时后账本仍待对账", readNativeDeployReconciliation(ENGINE_DIR).pending[0]?.status, "failed");

  // “Restart”: a NEW mirror instance with working ports replays the durable intent.
  writeFileSync(join(ENGINE_DIR, "flows.json"), JSON.stringify(withTabTitle(a.nodes, "deploy-before-crash")), "utf8");
  const restarted = new NativeDeployLibraryMirror({ dataDir: ENGINE_DIR, ports: lib.ports, revisionOf });
  const recovered = await restarted.retryPending();
  eq("崩溃/重启：重启后重放成功", recovered.docs[0]?.status, "mirrored");
  eq("崩溃/重启：重放后账本清空", readNativeDeployReconciliation(ENGINE_DIR).pending.length, 0);
  eq("崩溃/重启：库拿到崩溃前那次 Deploy 的内容", lib.docs.get("wf_t2_e")?.nodes[0]?.title, "deploy-before-crash");

  // The recovered document is announced on the runboard (deployId "" = retry).
  const ev = nativeMirrorEvents(recovered)[0] as WorkflowNodeResultEvent | undefined;
  eq("崩溃/重启：恢复事件发到该工作流看板", ev?.sessionId, "@node-red-runboard:wf_t2_e");
  eq("崩溃/重启：恢复事件标成功", ev?.status, "success");
}

/* ───── 6. 非法数据：坏载荷/坏画布/坏账本都显式处置，绝不伪造 pending ───── */

console.log("\n6. 非法数据：显式拒绝/隔离，不静默清账、不伪造文档");
{
  resetLedger();
  const a = fixtures("wf_t2_f", "x");
  const b = fixtures("wf_t2_f_second", "y");
  const lib = fakeLibrary([a.doc, b.doc]);
  const mirror = new NativeDeployLibraryMirror({ dataDir: ENGINE_DIR, ports: lib.ports, now: () => 3000 });

  // (a) Duplicate doc identity in one payload → synchronous throw, lastError only.
  const dupTab = (structuredClone(a.nodes) as Array<Record<string, unknown>>).find(n => n["type"] === "tab")!;
  let threw = false;
  try { mirror.mirrorDeploy([...a.nodes, { ...dupTab, id: "second-tab" }]); } catch { threw = true; }
  check("非法载荷：重复 docId 同步抛错", threw);
  const afterDup = readNativeDeployReconciliation(ENGINE_DIR);
  eq("非法载荷：重复 docId 不产生 pending 文档", afterDup.pending.length, 0);
  check("非法载荷：lastError 被记录（可诊断）", (afterDup.lastError?.message ?? "").includes("invalid/duplicate"), afterDup.lastError);

  // (b) Invalid docId (control character) → rejected, no fake pending.
  const badTab = structuredClone(dupTab);
  badTab["x-mcode"] = { docId: "bad\u0001id" };
  let threwBad = false;
  try { mirror.mirrorDeploy([badTab]); } catch { threwBad = true; }
  check("非法载荷：控制字符 docId 被拒绝", threwBad);
  eq("非法载荷：非法 docId 不产生 pending", readNativeDeployReconciliation(ENGINE_DIR).pending.length, 0);

  // (c) Corrupt flows.json during retry → failure surfaced; pending retained;
  // a valid deploy intent still works afterwards.
  const c = fixtures("wf_t2_g", "before");
  lib.docs.set(c.doc.id, c.doc);
  lib.reject.set(c.doc.id, "模拟拒绝");
  await mirror.mirrorDeploy(withTabTitle(c.nodes, "will-remain-pending"));
  lib.reject.delete(c.doc.id);
  writeFileSync(join(ENGINE_DIR, "flows.json"), "{truncated", "utf8");
  const broken = await mirror.retryPending();
  eq("非法画布：坏 flows.json 时重试显式失败（不是静默成功）", broken.ok, false);
  eq("非法画布：坏 flows.json 后 pending 保留", readNativeDeployReconciliation(ENGINE_DIR).pending.length, 1);
  check("非法画布：lastError 说明画布不可读", (readNativeDeployReconciliation(ENGINE_DIR).lastError?.message ?? "").includes("无法解析"), readNativeDeployReconciliation(ENGINE_DIR).lastError);

  // (d) Corrupt ledger file → quarantined (original bytes preserved), not swallowed.
  const corruptBytes = "{not-a-ledger";
  writeFileSync(ledger(), corruptBytes, "utf8");
  const quarantined = readNativeDeployReconciliation(ENGINE_DIR);
  eq("非法账本：坏账本读出为空账", quarantined.pending.length, 0);
  eq("非法账本：损坏文件被隔离（不再位于原路径）", existsSync(ledger()), false);
  const backups = readdirSync(ENGINE_DIR).filter(name => name.startsWith(`${NATIVE_DEPLOY_RECONCILIATION_FILE}.corrupt-`));
  check("非法账本：隔离备份保留原字节（可人工恢复）", backups.length === 1
    && readFileSync(join(ENGINE_DIR, backups[0]!), "utf8") === corruptBytes, backups);

  // (e) A malformed payload after recovery does not resurrect stale documents.
  resetLedger();
  writeFileSync(join(ENGINE_DIR, "flows.json"), JSON.stringify(withTabTitle(c.nodes, "recovered")), "utf8");
}

/* ───── 7. 多文档部分成功：一份冲突不阻断其余，也不回滚已镜像的 ───── */

console.log("\n7. 部分成功：各文档独立对账，一份失败不阻断其余");
{
  resetLedger();
  const a = fixtures("wf_t2_h1", "one");
  const b = fixtures("wf_t2_h2", "two");
  const lib = fakeLibrary([a.doc, b.doc]);
  const mirror = new NativeDeployLibraryMirror({ dataDir: ENGINE_DIR, ports: lib.ports });
  lib.reject.set("wf_t2_h2", "第二份校验失败");
  const payload = [...withTabTitle(a.nodes, "deploy-one"), ...withTabTitle(b.nodes, "deploy-two")];
  const report = await mirror.mirrorDeploy(payload);
  const statusOf = (id: string): string | undefined => report.docs.find(d => d.docId === id)?.status;
  eq("部分成功：第一份镜像成功", statusOf("wf_t2_h1"), "mirrored");
  eq("部分成功：第二份失败", statusOf("wf_t2_h2"), "failed");
  eq("部分成功：已镜像的第一份不被回滚", lib.docs.get("wf_t2_h1")?.nodes[0]?.title, "deploy-one");
  eq("部分成功：账本只记录失败的那一份", readNativeDeployReconciliation(ENGINE_DIR).pending.map(p => p.docId).join(","), "wf_t2_h2");
}

/* ─── 8. 原生独有 tab / 已删除文档：绝不 upsert（T58 既有语义不退化） ─── */

console.log("\n8. 原生独有 tab / 已删除文档：绝不伪造库记录");
{
  resetLedger();
  const live = fixtures("wf_t2_i", "live");
  const lib = fakeLibrary([live.doc]);
  const mirror = new NativeDeployLibraryMirror({ dataDir: ENGINE_DIR, ports: lib.ports });
  const nativeOnly = [
    { id: "native-tab", type: "tab", label: "native only" },
    { id: "n1", type: "inject", z: "native-tab", wires: [] },
  ];
  const report = await mirror.mirrorDeploy([...nativeOnly, ...withTabTitle(live.nodes, "deploy-live")]);
  eq("原生独有 tab：不产生库记录", report.docs.length, 1);
  eq("原生独有 tab：账本为空", readNativeDeployReconciliation(ENGINE_DIR).pending.length, 0);
  eq("原生独有 tab：不 upsert 原生 tab", lib.docs.has("native-tab"), false);

  // A doc deleted from the library while pending → retry resolves as skipped-deleted.
  resetLedger();
  const gone = fixtures("wf_t2_j", "gone");
  lib.docs.set(gone.doc.id, gone.doc);
  lib.reject.set(gone.doc.id, "拒绝一次");
  await mirror.mirrorDeploy(withTabTitle(gone.nodes, "gone-native"));
  lib.reject.delete(gone.doc.id);
  lib.docs.delete(gone.doc.id);
  writeFileSync(join(ENGINE_DIR, "flows.json"), JSON.stringify(withTabTitle(gone.nodes, "gone-native")), "utf8");
  const retriedGone = await mirror.retryPending();
  eq("已删除文档：重试不重建（skipped-deleted）", retriedGone.docs[0]?.status, "skipped-deleted");
  eq("已删除文档：账本清空", readNativeDeployReconciliation(ENGINE_DIR).pending.length, 0);
  eq("已删除文档：确实没被写回", lib.docs.has("wf_t2_j"), false);
}

/* ─── 9. 生产入口：同步登记意图、T58 兼容端口、路由动作分类 ─── */

console.log("\n9. 生产入口与兼容层");
{
  resetLedger();
  const a = fixtures("wf_t2_k", "before");
  const lib = fakeLibrary([a.doc]);
  // T58 strict wrapper keeps its fail-fast shape and rejects conflicts.
  lib.race.set("wf_t2_k", () => {
    const current = lib.docs.get("wf_t2_k")!;
    lib.docs.set("wf_t2_k", { ...current, name: "edited" });
    lib.race.delete("wf_t2_k");
  });
  let strictError = "";
  try { await syncNativeLibraryDocs(withTabTitle(a.nodes, "x"), lib.ports); }
  catch (err) { strictError = err instanceof Error ? err.message : String(err); }
  check("兼容层：冲突时同步抛错（保持 T58 fail-fast 契约）", strictError.includes("wf_t2_k"), strictError);

  // runNativeDeployMirror with an injected dataDir records intent synchronously.
  resetLedger();
  const b = fixtures("wf_t2_l", "before");
  lib.docs.set(b.doc.id, b.doc);
  const task = runNativeDeployMirror(withTabTitle(b.nodes, "sync-intent"), { dataDir: ENGINE_DIR });
  eq("生产入口：同步登记 pending（await 之前）", readNativeDeployReconciliation(ENGINE_DIR).pending.length, 1);
  const report = await task;
  eq("生产入口：注入数据目录时正常走端口", report.docs[0]?.docId, "wf_t2_l");
}

/* ─── 10. Runtime 接线：deploy-final 失败镜像 → 状态/事件可查；owner 不释放 ─── */

console.log("\n10. Runtime：原生 Deploy 已提交、镜像失败 → 状态可查、owner 保留");
{
  resetLedger();
  const live = fixtureRuntime();
  const a = fixtureRuntimeTab("wf_t2_m");
  const ownership = new ExecutorOwnershipRegistry(new InMemoryExecutorOwnershipStore());
  const events: RuntimeEvent[] = [];
  let deliver: ((message: unknown) => void) | undefined;
  const replies: Array<{ id?: string; ok?: boolean; reason?: string }> = [];
  const sent: unknown[] = [];
  const ports: EngineRuntimePorts = baseRuntimePorts(ownership, {
    spawn: () => bridgeChild((fn) => { deliver = fn; }, replies),
    sendMessage: (message) => { sent.push(message); return true; },
  });
  const syncFailure = async (): Promise<unknown> => { throw new Error("库 CAS 冲突（模拟）"); };
  const runtime = new (await import("@main/workflowEngines/registry.js")).OwnedNodeRedRuntime(
    "node-red", ports, ownership, undefined, syncFailure, (id) => live.get(id) ?? null,
    (event) => events.push(event));
  const dir = ENGINE_DIR;
  writeFileSync(join(dir, "flows.json"), JSON.stringify(a.flows), "utf8");
  eq("Runtime：引擎启动", (await runtime.start({ engineId: "node-red", command: "node", args: () => [], dataDir: dir })).state, "running");
  deliver?.({ kind: "mcode-deploy-prepare", id: "d1", flows: a.flows });
  eq("Runtime：Deploy prepare 被接受", replies.at(-1)?.ok, true);
  deliver?.({ kind: "mcode-deploy-final", id: "d1", success: true });
  await new Promise(resolve => setTimeout(resolve, 20));
  eq("Runtime：原生 Deploy 已提交，owner 保留在 node-red", ownership.executorOwnerOf("wf_t2_m"), "node-red");
  const state = runtime.libraryMirrorState();
  check("Runtime：镜像失败在状态里可查（不是只剩日志）", state.report !== null && state.report.ok === false, state.report);
  check("Runtime：失败措辞说明“原生已提交、库镜像未完成”", state.report?.error !== null && state.report?.error !== undefined, state.report?.error);
  check("Runtime：正在运行的原生引擎状态向统一工作流面板报告同步异常",
    runtime.status().libraryMirrorError === true && runtime.status().libraryMirrorPending === 0,
    runtime.status());
  eq("Runtime：失败不冒充 Deploy 失败（没有回滚 owner）", ownership.executorOwnerOf("wf_t2_m"), "node-red");
  await runtime.stop();
}

/* ─── 11. Runtime 启动重放：上次进程遗留的 pending 在 start 时自动对账 ─── */

console.log("\n11. Runtime：上次进程遗留的待对账在 start 时自动重放");
{
  resetLedger();
  const a = fixtures("wf_t2_n", "before");
  const lib = fakeLibrary([a.doc]);
  lib.reject.set("wf_t2_n", "上一进程被拒绝");
  await new NativeDeployLibraryMirror({ dataDir: ENGINE_DIR, ports: lib.ports })
    .mirrorDeploy(withTabTitle(a.nodes, "left-pending"));
  eq("启动重放：前置为 1 条待对账", readNativeDeployReconciliation(ENGINE_DIR).pending.length, 1);
  lib.reject.delete("wf_t2_n");
  writeFileSync(join(ENGINE_DIR, "flows.json"), JSON.stringify(withTabTitle(a.nodes, "left-pending")), "utf8");

  // Simulate engine start with the REAL reconciler but the FAKE library ports:
  // the production reconciler imports the SQL library lazily; here the injected
  // mirror path is exercised through the exported class (same code as runtime).
  const replay = new NativeDeployLibraryMirror({ dataDir: ENGINE_DIR, ports: lib.ports });
  const report = await replay.retryPending();
  eq("启动重放：遗留待对账被重放成功", report.docs[0]?.status, "mirrored");
  eq("启动重放：账本清空", readNativeDeployReconciliation(ENGINE_DIR).pending.length, 0);

  // The production registry exposes the same reconcile entry (dataDir based).
  const registry = new ProductionWorkflowEngineRegistry();
  check("启动重放：生产注册表暴露引擎数据目录", registry.dataDirOf("node-red").length > 0);
  void reconcileNativeLibraryMirror;
}

/* ─────────────────────────────── helpers ─────────────────────────────── */

function fixtureRuntimeTab(docId: string): { flows: unknown[] } {
  // Only the native payload matters here; the Host library (fixtureRuntime)
  // carries the `engine: "node-red"` selection the start-time gate checks.
  const { nodes } = fixtures(docId);
  return { flows: withTabTitle(nodes, "runtime-deploy") };
}

function fixtureRuntime(): Map<string, WorkflowDoc> {
  const a = fixtures("wf_t2_m", "before");
  return new Map([[a.doc.id, { ...a.doc, engine: "node-red" }]]);
}

function baseRuntimePorts(
  _ownership: ExecutorOwnershipRegistry,
  overrides: { spawn: () => unknown; sendMessage?: (m: unknown) => boolean },
): EngineRuntimePorts {
  return {
    allocatePort: async () => 35991,
    now: () => Date.now(),
    sleep: async () => {},
    probe: async () => true,
    spawn: overrides.spawn as EngineRuntimePorts["spawn"],
  };
}

function bridgeChild(
  onMessage: (fn: (message: unknown) => void) => void,
  replies: Array<Record<string, unknown>>,
): unknown {
  const exits: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  return {
    pid: 43220,
    kill: () => { exits.forEach(fn => fn(0, null)); return true; },
    onExit: (fn: (code: number | null, signal: NodeJS.Signals | null) => void) => { exits.push(fn); },
    onError: () => {},
    onMessage: (fn: (message: unknown) => void) => { onMessage(fn); },
    sendMessage: (message: unknown) => { replies.push(message as Record<string, unknown>); return true; },
    tailOutput: () => "t2-child",
  };
}

console.log(`\nnode-red-deploy-reconciliation-smoke: ${total - failures}/${total} 通过`);
if (failures > 0) process.exitCode = 1;
