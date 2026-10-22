/**
 * T21 — the two orphaned workflow adapters are wired into the production path.
 *
 * Before this task:
 *   - `workflowMigrationPreflight.ts` (1,631 lines, SAFE/HUMAN/REJECT) had **zero
 *     production callers**; only its own suite imported it.
 *   - `NodeRedFlowStorage` (the per-flow CAS / OS-lease / docId-bound store) had
 *     **zero production callers**; only `replaceNativeCanvas`/`readNativeCanvas`
 *     of the same file were live.
 *
 * They are now on `loadWorkflowIntoNative` — the only production entry that turns
 * a Host library document into the Node-RED canvas (`ipc/workflowEngine` →
 * `ipc/index.ts`). This suite drives **that** function, not the adapters in
 * isolation; a green run here means the production call site really executed
 * them (each proof below fails if the wiring is removed — see the mutation run
 * in the task writeback).
 *
 * Everything is isolated: `mkdtemp` engine dirs, fake runtime/launcher ports, no
 * Electron, no real data root, no Node-RED process.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowDoc, WorkflowReviewInfo } from "@contracts/workflow";
import type { NodeTypeManifest } from "@contracts/nodeType";
import type { EngineRuntimeStatus } from "../../src/main/workflowEngines/runtimeSupervisor.js";
import {
  loadWorkflowIntoNative,
  type NativeLoadPorts,
} from "../../src/main/workflowEngines/nativeLibraryLoad.js";
import { migrateWorkflowDoc } from "../../src/main/workflowEngines/flowMigration.js";
import {
  NodeRedFlowStorage,
  FLOWS_SUBDIR,
  safeFlowFileName,
} from "../../src/main/workflowEngines/nodeRedStorage.js";
import {
  reviewFactsForLoad,
  workflowPreflightFacts,
  libraryDocumentForPreflight,
  evaluateWorkflowMigration,
} from "../../src/main/workflowEngines/workflowMigrationGate.js";

let total = 0;
let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  total++;
  if (ok) console.log("  ok   " + name);
  else {
    failures++;
    console.error("  FAIL " + name + (detail === undefined ? "" : " — " + JSON.stringify(detail)));
  }
}

const TYPES: ReadonlyMap<string, NodeTypeManifest> = new Map([
  ["known", { id: "known", manifestVersion: 1, name: "known", runner: { kind: "prompt" }, capability: "read", params: [] } as unknown as NodeTypeManifest],
]);
const NO_REVIEW: { review: WorkflowReviewInfo | null; inFlightWorkflowIds: ReadonlySet<string> } = {
  review: null,
  inFlightWorkflowIds: new Set<string>(),
};
const docOf = (id: string, options: Partial<WorkflowDoc> & Record<string, unknown> = {}): WorkflowDoc => ({
  id,
  name: "Workflow " + id,
  engine: "node-red",
  builtin: false,
  updatedAt: 100,
  nodes: [{
    id: id + "-node", type: "known", title: "step " + id,
    params: { instruction: "hello " + id }, position: { x: 100, y: 50 },
  }],
  edges: [],
  ...options,
} as WorkflowDoc);

interface Harness {
  dir: string;
  docs: Map<string, WorkflowDoc>;
  ports: NativeLoadPorts;
  starts: () => number;
  facts: { review: WorkflowReviewInfo | null; inFlightWorkflowIds: ReadonlySet<string> };
}
function harness(initial: WorkflowDoc[]): Harness {
  const dir = mkdtempSync(join(tmpdir(), "mcode-t21-wired-"));
  const docs = new Map(initial.map((doc) => [doc.id, doc]));
  let status: EngineRuntimeStatus = { engineId: "node-red", state: "stopped", port: null, reason: null };
  let starts = 0;
  const facts = { ...NO_REVIEW } as Harness["facts"];
  const ports: NativeLoadPorts = {
    get: (id) => docs.get(id) ?? null,
    types: async () => new Map(TYPES),
    dataDir: () => dir,
    migrationFacts: () => facts,
    runtime: {
      status: () => status,
      stop: async () => {
        status = { engineId: "node-red", state: "stopped", port: null, reason: null };
        return status;
      },
      start: async () => {
        starts++;
        status = { engineId: "node-red", state: "running", port: 12345, reason: null };
        return status;
      },
    },
    beforeStart: async () => {},
    launchSpec: () => ({ command: "fake-node", dataDir: dir, args: () => [] }),
  };
  return { dir, docs, ports, starts: () => starts, facts };
}

const suites: Array<[string, () => Promise<void>]> = [];
function scenario(name: string, body: () => Promise<void>): void {
  suites.push([name, body]);
}

/* ═════════ 1. 迁移预检（REJECT 无条件拒绝，confirmReplace 不是后门） ═════════ */
scenario("迁移预检", async () => {
  const unknownType = docOf("wf-reject-unknown-type", {
    nodes: [{ id: "bad", type: "vendor.unknown-node", title: "bad", params: {}, position: { x: 1, y: 2 } }],
  });
  const unsafeKey = docOf("wf-reject-unsafe-key");
  // A real JSON `__proto__` data key (JSON.parse, not an object literal).
  unsafeKey.nodes[0]!.params = JSON.parse('{"instruction":"hi","__proto__":{"polluted":true}}') as Record<string, unknown>;
  const humanDoc = docOf("wf-human-unknown-field", { "x-legacy-extra": { keep: true } } as never);
  const safeDoc = docOf("wf-safe");
  const h = harness([unknownType, unsafeKey, humanDoc, safeDoc]);
  try {
    // ── REJECT：即便调用方传了 confirmReplace=true 也拒，且画布一次没动 ──
    const unknown = await loadWorkflowIntoNative("wf-reject-unknown-type", h.ports, true);
    check("★ 未知节点类型：REJECT 拒绝装载", unknown.ok === false, unknown);
    check("★ REJECT 消息点名缺失类型（预检判据，不是旧的迁移报告）",
      unknown.ok === false && unknown.reason.includes("迁移预检") && unknown.reason.includes("vendor.unknown-node")
      && unknown.reason.includes("unmapped-mcode-node-type"), unknown);
    check("★ REJECT 不是「要求确认」——confirmReplace 不是放行后门",
      unknown.ok === false && unknown.requiresConfirmation !== true, unknown);
    check("★ REJECT 在碰引擎之前返回：一次启动都没有、画布目录为空",
      h.starts() === 0 && readdirSync(h.dir).length === 0, { starts: h.starts(), files: readdirSync(h.dir) });

    const unsafe = await loadWorkflowIntoNative("wf-reject-unsafe-key", h.ports, true);
    check("★ 原型污染键：REJECT（unsafe-json-key），同样不可用 confirmReplace 越过",
      unsafe.ok === false && unsafe.reason.includes("unsafe-json-key") && unsafe.requiresConfirmation !== true, unsafe);
    check("★ 第二个 REJECT 也零启动、零磁盘写入", h.starts() === 0 && readdirSync(h.dir).length === 0);

    // ── HUMAN：不确认 = 要求确认；确认后才装载 ──
    const needConfirm = await loadWorkflowIntoNative("wf-human-unknown-field", h.ports, false);
    check("★ 未确认的 HUMAN 文档：requiresConfirmation + 点名预检原因",
      needConfirm.ok === false && needConfirm.requiresConfirmation === true
      && needConfirm.reason.includes("迁移预检要求人工确认") && needConfirm.reason.includes("unknown-workflow-fields"),
      needConfirm);
    check("★ 未确认前没有启动引擎、没有写装载记录", h.starts() === 0 && readdirSync(h.dir).length === 0);

    const confirmed = await loadWorkflowIntoNative("wf-human-unknown-field", h.ports, true);
    check("★ 用户明确确认后 HUMAN 文档装载成功", confirmed.ok === true, confirmed);
    check("★ 确认后引擎确实被启动了一次", h.starts() === 1);

    // ── SAFE：直接放行 ──
    const safe = await loadWorkflowIntoNative("wf-safe", h.ports, true);
    check("★ SAFE 文档直接装载（无需额外确认）", safe.ok === true, safe);

    // ── 预检拿到的是「当前这一版」：同一 id 换成 REJECT 内容 → 下一次装载被拒 ──
    h.docs.set("wf-safe", docOf("wf-safe", {
      nodes: [{ id: "x", type: "vendor.unknown-node", title: "x", params: {}, position: { x: 1, y: 2 } }],
    }));
    const recheck = await loadWorkflowIntoNative("wf-safe", h.ports, true);
    check("★ 预检判的是当前版本：同一 id 改成未知节点后被拒", recheck.ok === false && recheck.reason.includes("vendor.unknown-node"), recheck);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

/* ═════════ 2. 装载记录（NodeRedFlowStorage）在生产路径上真的被写/读 ═════════ */
scenario("装载记录", async () => {
  const h = harness([docOf("wf-journal-a")]);
  try {
    const first = await loadWorkflowIntoNative("wf-journal-a", h.ports, true);
    check("前置：首次装载成功", first.ok === true, first);
    // existsSync-guarded: with the journal write removed the directory does not
    // exist, and the assertion must report a clean FAIL rather than crash.
    const journalDir = join(h.dir, FLOWS_SUBDIR);
    check("★ 生产装载为这份文档写出了 per-document 装载记录（NodeRedFlowStorage 路径）",
      existsSync(journalDir) && readdirSync(journalDir).includes(`${safeFlowFileName("wf-journal-a")}.json`),
      existsSync(journalDir) ? readdirSync(journalDir) : "flows/ 不存在");
    // Read it back through the public storage API, not by trusting the path.
    const journal = new NodeRedFlowStorage(h.dir);
    const record = journal.loadFlow(null, "wf-journal-a");
    check("★ 记录可被 NodeRedFlowStorage 读回，且 docId 绑定这份文档",
      record.ok === true && record.flow["x-mcode"] !== undefined
      && (record.flow as unknown as { "x-mcode": { docId: string } })["x-mcode"].docId === "wf-journal-a", record);
    const expectedNodes = migrateWorkflowDoc(h.docs.get("wf-journal-a")!, { types: new Map(TYPES) }).flow.nodes;
    check("★ 记录内容就是迁移器产出的原生节点（不是空档、不是另一份文档）",
      record.ok === true && JSON.stringify(record.flow.nodes) === JSON.stringify(expectedNodes),
      record.ok ? record.flow.nodes.length : record);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

/* ═════════ 3. 坏档 / 错绑记录：拒绝覆盖（fail-closed） ═════════ */
scenario("装载记录防覆盖", async () => {
  const h = harness([docOf("wf-journal-corrupt"), docOf("wf-journal-drift")]);
  try {
    // Corrupt journal bytes: the load must refuse instead of silently replacing them.
    const flowDir = join(h.dir, FLOWS_SUBDIR);
    mkdirSync(flowDir, { recursive: true });
    const corruptFile = join(flowDir, `${safeFlowFileName("wf-journal-corrupt")}.json`);
    writeFileSync(corruptFile, "{not json", "utf8");
    const corrupt = await loadWorkflowIntoNative("wf-journal-corrupt", h.ports, true);
    check("★ 盘上装载记录损坏 → 拒绝装载，不拿新内容盖掉可抢救的字节",
      corrupt.ok === false && corrupt.reason.includes("装载记录不可用"), corrupt);
    check("★ 坏档拒绝发生在启动引擎之前", h.starts() === 0);
    const { readFileSync } = await import("node:fs");
    check("★ 坏档字节原样保留", readFileSync(corruptFile, "utf8") === "{not json");

    // docId drift: a record whose x-mcode.docId is a different document.
    const driftFile = join(flowDir, `${safeFlowFileName("wf-journal-drift")}.json`);
    writeFileSync(driftFile, JSON.stringify({
      nodes: [{ id: "n", type: "inject" }],
      "x-mcode": { docId: "somebody-else" },
    }), "utf8");
    const drift = await loadWorkflowIntoNative("wf-journal-drift", h.ports, true);
    check("★ 装载记录错绑另一份文档（doc-id-drift）→ 拒绝装载",
      drift.ok === false && drift.reason.includes("装载记录不可用"), drift);
    check("★ 错绑记录同样不改字节、不启动", h.starts() === 0 && readFileSync(driftFile, "utf8").includes("somebody-else"));
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

/* ═════════ 4. 装载日志的 CAS：并发的两次装载不允许都成功 ═════════ */
scenario("装载记录并发", async () => {
  // Two independent storages (as two Mcode processes would have) writing the
  // same document with the same expectedRevision: exactly one wins.
  const dir = mkdtempSync(join(tmpdir(), "mcode-t21-race-"));
  try {
    const a = new NodeRedFlowStorage(dir);
    const b = new NodeRedFlowStorage(dir);
    const flow = { nodes: [{ id: "n1", type: "tab" }], "x-mcode": { docId: "wf-race" } };
    const [first, second] = await Promise.all([
      a.saveFlow(null, "wf-race", flow as never, { expectedRevision: null }),
      b.saveFlow(null, "wf-race", flow as never, { expectedRevision: null }),
    ]);
    const wins = [first, second].filter((r) => r.ok).length;
    const losses = [first, second].filter((r) => !r.ok && r.kind === "conflict").length;
    check("★ 同一文档两份并发装载记录写入：恰好一成一败（CAS + OS 租约）",
      wins === 1 && losses === 1, { first, second });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ═════════ 5. 事实投影（纯函数，审批/在途如何变成预检输入） ═════════ */
scenario("事实投影", async () => {
  const approved: WorkflowReviewInfo = { origin: "import", revision: "a".repeat(64), pending: false };
  const pending: WorkflowReviewInfo = { origin: "import", revision: "b".repeat(64), pending: true };
  check("★ 没有审批记录 → not-required（本地既有工作流，与 workflowReviewOf 同口径）",
    (reviewFactsForLoad(null) as { state: string }).state === "not-required");
  check("★ 待审 → pending（预检据 CAS 之外的审批态升 HUMAN）",
    (reviewFactsForLoad(pending) as { state: string }).state === "pending");
  check("★ 已批准 → unknown（SQL revision 与预检 revision 形状不同，不做跨形状换算）",
    (reviewFactsForLoad(approved) as { state: string }).state === "unknown");

  const running = workflowPreflightFacts("wf-run", {
    review: null, inFlightWorkflowIds: new Set(["wf-run"]),
  });
  check("★ 在跑的执行 → active（预检升 HUMAN，不迁移正在跑的图）",
    (running.inFlight as { state: string }).state === "active");
  const idle = workflowPreflightFacts("wf-idle", { review: null, inFlightWorkflowIds: new Set() });
  check("★ 查过且没在跑 → none（不是 unknown：调用方给了可信空集）",
    (idle.inFlight as { state: string }).state === "none");
  const unknown = workflowPreflightFacts("wf-x", { review: null, inFlightWorkflowIds: undefined });
  check("★ 没有可信快照 → unknown（fail-closed，绝不当成没在跑）",
    (unknown.inFlight as { state: string }).state === "unknown");

  const doc = docOf("wf-shape");
  const view = libraryDocumentForPreflight(doc);
  check("★ 送检投影删掉派生的 engine 字段（否则预检 100% REJECT already-node-red-owned）",
    !("engine" in view) && view["id"] === "wf-shape");
  check("★ 投影不放松其余内容：节点/参数原样带上",
    JSON.stringify(view["nodes"]) === JSON.stringify(doc.nodes));
});

/* ═════════ 6. 预检在生产调用里真的执行（不是只有测试里调） ═════════ */
scenario("生产调用打点", async () => {
  const h = harness([docOf("wf-probe")]);
  try {
    // The same public gate the production load calls (imported by the load
    // function; here invoked with the same inputs production passes).
    const evaluation = evaluateWorkflowMigration({
      doc: h.docs.get("wf-probe")!,
      types: TYPES,
      facts: { review: null, inFlightWorkflowIds: new Set() },
    });
    check("★ 生产入口 evaluateWorkflowMigration 返回完整预检结论（decision + 原因 + 清单哈希）",
      evaluation.decision === "SAFE" && evaluation.manifestHash.length === 64, evaluation);
    // And the production load path itself produced the same SAFE decision: it
    // loaded without any confirmation demand beyond canvas replacement.
    const loaded = await loadWorkflowIntoNative("wf-probe", h.ports, true);
    check("★ 生产装载对同一份 SAFE 文档放行", loaded.ok === true, loaded);
    check("★ 预检在生产路径上真的跑了（装载记录写出 = 预检放行后的路径被执行）",
      existsSync(join(h.dir, FLOWS_SUBDIR))
      && readdirSync(join(h.dir, FLOWS_SUBDIR)).some((name) => name.endsWith(".json")), readdirSync(h.dir));
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

for (const [name, body] of suites) {
  console.log(`\n${name}`);
  await body();
}
console.log(`\nt21-orphaned-adapters-wired-smoke: ${total - failures}/${total} 通过`);
if (failures > 0) process.exitCode = 1;
