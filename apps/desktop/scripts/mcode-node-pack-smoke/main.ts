/**
 * 【ARC-006 MERGE-2 第一片】**`mcode-agent` 节点包的无头回归**。
 *
 * ## 两段
 *
 * **A. 纯逻辑（真 node-red 不需要）**：直接调 `runAgentNode` 与注册外壳，钉输入/输出：
 *   - `msg.payload = { text, artifacts }`、`msg.mcode = { nodeId, runId }` 透传；
 *   - instruction / capability / outputVar 从迁移器形状（`x-mcode.params`）与节点配置
 *     两处都能读；未知参数原样交给 port；
 *   - 假 port 被调用**恰好一次**，且收到的 payload 就是上面这些；
 *   - port 抛错 → 外壳 `node.error` + `done(err)`，不静默成功。
 *
 * **B. 真 node-red 5.0.8（未安装 → 显式 SKIP）**：把节点包按 Node-RED 的
 * `<userDir>/nodes/<name>.js` + 同名 `.html` 布局放进去，走**生产 bootstrap**（A 段
 * 同一个 launchSpec）起引擎：
 *   - `GET /nodes`（带宿主令牌）里能看到 `mcode-agent` 类型且无 `err`；
 *   - 迁移器产出的含 `mcode-agent` 的 flow 部署后**整组真的启动**（同流里的原生
 *     HTTP-in 200 —— 与 Gate C 的 missing-types 硬事实形成对照）；
 *   - 节点经 HTTP-in 触发执行一次，下游 HTTP response 回的就是
 *     `{ text, artifacts }`（假 port 的固定产出）；
 *   - 假 port 的执行次数 = 1（经节点自己写进 userDir 的计数文件核对 —— 节点包在引擎
 *     进程里跑，测试进程不能直接看它的内存）。
 *
 * ## 并行隔离（与 node-red-e2e-smoke 可同跑；2026-10-19 修）
 *
 * 两个真引擎套件**不能共享可变状态**。此前本套把 `MCODE_SMOKE_DATA_ROOT` 指到
 * `.tmp/nr-e2e`，并在那里写 `engine-trust.json = {"trusted":true}` —— 而那正是
 * node-red-e2e 用来断言「untrusted / 未审批 flow 不执行」的同一个目录；并行时
 * 对侧固定 78/80（两条红）。现在本套的 dataRoot 是 run.sh 的 **mktemp 私有目录**，
 * 其中 `workflow-engines/node-red/node_modules` 用 **junction** 指向共享安装树
 * （106MB 不复制；`engine-trust.json`/`flows.json`/`bootstrap.cjs`/令牌全部落在
 * 私有目录）。junction 不可用时**回退为整树复制**（慢、占盘，但仍然隔离）——
 * 绝不回退成共享目录。
 *
 * ## 假 port 怎么进引擎进程
 *
 * `run.sh` 把 `mcodeNodePack.ts` 打成 CJS 到 `$OUT/mcodeNodePack.cjs`。套件在临时
 * userDir 的 `nodes/` 下写：
 *   - `mcode-agent.js`：`module.exports = (RED) => { const pack = require('<OUT>/mcodeNodePack.cjs');
 *     pack.registerMcodeAgentNodes(RED, () => fakePort); }` —— 与生产 `RED.nodes.registerType`
 *     完全同一条注册路径；
 *   - `mcode-agent.html`：`pack.agentNodeHtml()` 的原文（Node-RED 只认有同名 .html 的 .js）。
 * 假 port 的 `run()` 把 payload 追加写进 userDir 的 `agent-runs.jsonl`，返回固定产出 ——
 * 生产将来把这一处换成 Host RPC port，其余不动。
 *
 * Run: bash scripts/mcode-node-pack-smoke/run.sh
 */
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MCODE_AGENT_NODE_TYPE,
  agentNodeHtml,
  normalizeAgentConfig,
  registerMcodeAgentNodes,
  runAgentNode,
  type McodeAgentNodeConfig,
  type McodeAgentPort,
  type McodeAgentRunPayload,
  type NodeRedNodeLike,
  type NodeRedRuntimeApi,
} from "@main/workflowEngines/mcodeNodePack.js";
import { migrateWorkflowDoc } from "@main/workflowEngines/flowMigration.js";
import { builtinManifestById } from "@main/orchestration/nodeTypes.js";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

/** 记录式假 port：钉「被调用几次、收到什么」，返回固定产出。 */
function recordingPort(): McodeAgentPort & { calls: McodeAgentRunPayload[] } {
  const calls: McodeAgentRunPayload[] = [];
  return {
    calls,
    async run(payload) {
      calls.push(payload);
      return {
        text: `echo: ${payload.instruction}`,
        artifacts: [{ kind: "file", uri: "file:///tmp/artifact.txt", mimeType: "text/plain" }],
        runId: "run_fake_1",
      };
    },
  };
}

/* ══════════ A. 纯逻辑：输入/输出形状 ══════════ */
console.log("\nA. 纯逻辑：runAgentNode 输入/输出 + 注册外壳");

await (async () => {
  // 迁移器形状：参数住在 x-mcode.params 里（真引擎部署后的节点就是这个形状）。
  const migratedConfig: McodeAgentNodeConfig = {
    id: "n_n_agent",
    name: "子 agent",
    "x-mcode": {
      nodeId: "n_agent",
      type: "mcode.agent",
      params: { instruction: "查资料", capability: "write", outputVars: [{ name: "摘要" }], "x-custom": 1 },
    },
  };

  // ★ 产出形状 + runId 透传（port 回带的 runId 覆盖输入那份）。
  {
    const port = recordingPort();
    const outcome = await runAgentNode({ payload: { question: "q" }, mcode: { runId: "run_in" } }, migratedConfig, port);
    eq("★ msg.payload = { text, artifacts }", outcome.msg.payload, {
      text: "echo: 查资料",
      artifacts: [{ kind: "file", uri: "file:///tmp/artifact.txt", mimeType: "text/plain" }],
    });
    check("★ msg.mcode 透传 nodeId 与 port 回带的 runId",
      (outcome.msg.mcode as Record<string, unknown>).nodeId === "n_agent"
      && (outcome.msg.mcode as Record<string, unknown>).runId === "run_fake_1",
      outcome.msg.mcode);
    check("★ 输入 msg 的其它字段保留（Node-RED 的 msg 是增量修改）", (outcome.msg as { question?: unknown }).question === undefined
      && JSON.stringify((outcome.msg as { payload?: unknown }).payload) !== JSON.stringify({ question: "q" }));
  }

  // ★ port 收到的 payload：instruction/capability/nodeId/runId/params 全对，且只调一次。
  {
    const port = recordingPort();
    await runAgentNode({ payload: "上游文本", mcode: { runId: "run_in" } }, migratedConfig, port);
    eq("★ 假 port 被调用恰好一次", port.calls.length, 1);
    const call = port.calls[0];
    eq("★ port 收到 instruction（来自 x-mcode.params）", call.instruction, "查资料");
    eq("★ port 收到上游 payload 原文", call.input, "上游文本");
    eq("★ port 收到 capability", call.capability, "write");
    eq("★ port 收到 Mcode nodeId", call.nodeId, "n_agent");
    eq("★ port 收到 runId（输入没有则由 port 回带）", call.runId, "run_in");
    check("★ 未知参数原样交给 port（x-custom）", (call.params as Record<string, unknown>)["x-custom"] === 1, call.params);
  }

  // 节点配置直接手填（编辑器里创建、未经迁移器）也能读。
  {
    const port = recordingPort();
    const outcome = await runAgentNode({}, { id: "n1", instruction: "手填指令", capability: "read", outputVar: "结果" }, port);
    eq("★ 编辑器直填的 instruction 生效", port.calls[0]?.instruction, "手填指令");
    eq("★ 编辑器直填的 capability 生效", port.calls[0]?.capability, "read");
    eq("★ outputVar 标注在 msg.mcode 上", (outcome.msg.mcode as { outputVar?: string }).outputVar, "结果");
  }

  // 缺 instruction / 类型不对 → 安全默认，不抛。
  {
    const normalized = normalizeAgentConfig({ instruction: 42, capability: "exec", outputVar: 7 } as McodeAgentNodeConfig);
    eq("非法 instruction → 空串", normalized.instruction, "");
    eq("非法 capability → read（保守默认）", normalized.capability, "read");
    eq("非法 outputVar → null", normalized.outputVar, null);
  }

  // ★ 注册外壳：假 RED 收到 registerType，input 处理器调 port 并 send/done。
  {
    type Registered = { ctor: new (config: McodeAgentNodeConfig) => NodeRedNodeLike };
    /** 用注册到的 ctor 造一个节点、触发一次 input，收回 send/done/error。
     *  Node-RED 里 ctor 的 `this` 是已带 `on`/`error` 的 Node 实例（util.inherits），
     *  所以这里用一个先具备这些方法的对象调 `ctor.call(...)`，而不是 `new`。 */
    async function trigger(
      ctor: Registered["ctor"],
      config: McodeAgentNodeConfig,
      msg: Record<string, unknown>,
    ): Promise<{ sent: Record<string, unknown> | null; doneError: Error | null; errored: unknown }> {
      let listener: ((m: Record<string, unknown>, s: (x: unknown) => void, d: (e?: Error) => void) => void) | null = null;
      let errored: unknown = null;
      const node = Object.create((ctor as unknown as { prototype: object }).prototype) as Record<string, unknown>;
      node.on = (event: string, l: typeof listener): void => {
        if (event === "input") listener = l;
      };
      node.error = (e: unknown): void => {
        errored = e;
      };
      (ctor as unknown as (this: unknown, c: McodeAgentNodeConfig) => void).call(node, config);
      let sent: Record<string, unknown> | null = null;
      const doneError = await new Promise<Error | null>((resolve) => {
        listener!(msg, (m) => { sent = m as Record<string, unknown>; }, (e) => resolve(e ?? null));
      });
      return { sent, doneError, errored };
    }

    // —— 成功路径 ——
    const registered: Registered[] = [];
    const fakeRed: NodeRedRuntimeApi = {
      nodes: {
        registerType(type, ctor) {
          eq("★ 注册的类型名是 mcode-agent", type, MCODE_AGENT_NODE_TYPE);
          registered.push({ ctor });
        },
        createNode: () => {},
      },
      log: { info: () => {} },
    };
    const port = recordingPort();
    registerMcodeAgentNodes(fakeRed, () => port);
    eq("★ registerType 恰好调用一次", registered.length, 1);

    const ok = await trigger(registered[0]!.ctor, { id: "n2", instruction: "跑一次", capability: "read" }, { payload: "x" });
    eq("★ 外壳 send 的就是 runAgentNode 的产出", (ok.sent as { payload?: unknown } | null)?.payload, {
      text: "echo: 跑一次",
      artifacts: [{ kind: "file", uri: "file:///tmp/artifact.txt", mimeType: "text/plain" }],
    });
    eq("★ 外壳 done 无错误", ok.doneError, null);

    // —— 失败路径：port 抛错 → node.error + done(err)，不静默成功 ——
    const failingRed: NodeRedRuntimeApi = {
      nodes: { registerType: (_t, ctor) => { failingCtor = ctor as Registered["ctor"]; }, createNode: () => {} },
    };
    let failingCtor: Registered["ctor"] | null = null;
    registerMcodeAgentNodes(failingRed, () => ({ run: async () => { throw new Error("port exploded"); } }));
    const failed = await trigger(failingCtor!, { id: "n3", instruction: "会失败" }, {});
    check("★ port 抛错 → done(err)（Catch 节点能接住）",
      failed.doneError instanceof Error && failed.doneError.message === "port exploded", String(failed.doneError));
    check("★ port 抛错 → node.error 也被调用", failed.errored instanceof Error);
  }

  // agentNodeHtml：Node-RED 只认有同名 .html 的 .js，且类型从 data-template-name 提取。
  {
    const html = agentNodeHtml();
    check("★ HTML 注册块含 data-template-name=mcode-agent（Node-RED 的类型发现入口）",
      html.includes(`data-template-name="${MCODE_AGENT_NODE_TYPE}"`));
    check("★ HTML 里有 registerType(\"mcode-agent\") 的编辑器定义", html.includes(`RED.nodes.registerType("${MCODE_AGENT_NODE_TYPE}"`));
    check("★ HTML 的三格参数都在（instruction/capability/outputVar）",
      html.includes('id="node-input-instruction"') && html.includes('id="node-input-capability"') && html.includes('id="node-input-outputVar"'));
  }
})();

/* ══════════ B. 纯逻辑：其余 6 种节点（runXNode 输入/输出形状） ══════════ */
console.log("\nB. 纯逻辑：conversation / branch / trigger / code / module-capability / node-red-call");
{
  const {
    MCODE_NODE_PACK_TYPES,
    allNodeHtml,
    branchNodeHtml,
    triggerMessage,
    triggerSubscribePayload,
    runConversationNode,
    runBranchNode,
    runModuleCapabilityNode,
    runNodeRedCallNode,
  } = await import("@main/workflowEngines/mcodeNodeTypes.js");

  const cfg = (params: Record<string, unknown>, wires?: string[][]): McodeAgentNodeConfig & { wires?: string[][] } => ({
    id: "n_other",
    "x-mcode": { nodeId: "o1", params },
    ...(wires !== undefined ? { wires } : {}),
  });

  // ★ 7 个类型都在清单里（agent + 其余 6；condition/command 走原生节点，不注册）。
  eq("★ 节点包注册类型 = 6（agent + 其余 5；condition/command/code 用内置）", [...MCODE_NODE_PACK_TYPES].sort(), [
    "mcode-agent", "mcode-branch", "mcode-conversation",
    "mcode-module-capability", "mcode-node-red-call", "mcode-trigger",
  ]);
  eq("★ HTML 覆盖全部 6 个类型", ["mcode-agent", "mcode-conversation", "mcode-branch", "mcode-trigger", "mcode-module-capability", "mcode-node-red-call"]
    .filter((t) => !allNodeHtml().includes(`data-template-name="${t}"`)), []);
  check("★ 节点统一：mcode-code 已删除（JS→内置 function，其它语言→exec）",
    !(MCODE_NODE_PACK_TYPES as readonly string[]).includes("mcode-code")
    && !allNodeHtml().includes('data-template-name="mcode-code"'));

  // ── conversation ──
  {
    const calls: Array<Record<string, unknown>> = [];
    const out = await runConversationNode({ payload: "上句", mcode: { runId: "r1" } }, cfg({ instruction: "聊一句" }), {
      run: async (p) => { calls.push(p as unknown as Record<string, unknown>); return { text: "聊完了", artifacts: [] }; },
    });
    check("★ conversation：port 被调用一次且收到 instruction",
      calls.length === 1 && calls[0]?.instruction === "聊一句", { count: calls.length, calls });
    eq("★ conversation：产出 {text,artifacts}", out.msg.payload, { text: "聊完了", artifacts: [] });
    eq("★ conversation：runId 沿用输入", (out.msg.mcode as Record<string, unknown>).runId, "r1");
  }

  // ── branch ──
  {
    const wires = [["t0"], ["t1"], ["t2"]];
    // 人工点选优先：msg.mcode.branchPort = 2
    let decideAsked = false;
    const manual = await runBranchNode({ payload: "保持", mcode: { branchPort: 2 } }, cfg({ decider: "user" }, wires), {
      decide: async () => { decideAsked = true; return { port: 0 }; },
    });
    eq("★ branch：msg.mcode.branchPort 优先（人工点选）", manual.port, 2);
    check("★ branch：人工点选时不问 port", decideAsked === false);
    eq("★ branch：上游 payload 原样保留", manual.msg.payload, "保持");
    // port 决定 + 越界收缩
    const byPort = await runBranchNode({ payload: 1 }, cfg({ decider: "model" }, wires), {
      decide: async (p) => ({ port: p.portCount - 1, label: "最后一条" }),
    });
    eq("★ branch：port 决定落在端口范围内", byPort.port, 2);
    eq("★ branch：label 进 msg.mcode.branch", (byPort.msg.mcode as { branch?: unknown }).branch, { port: 2, label: "最后一条" });
    const bad = await runBranchNode({}, cfg({}, wires), { decide: async () => ({ port: 99 }) });
    eq("★ branch：port 越界 → 收缩到 0（不丢消息）", bad.port, 0);
    check("★ branch HTML 的 outputs 随 wires 增长", branchNodeHtml().includes("function () { return Math.max(1, (this.wires && this.wires.length) || 1); }"));
  }

  // ── trigger ──
  {
    const msg = triggerMessage({ id: "t", "x-mcode": { nodeId: "tr1", params: { triggerKind: "schedule" } } }, 123);
    eq("★ trigger：无输入仍产出（payload.trigger.kind/at）", msg.payload, { trigger: { kind: "schedule", at: 123 } });
    eq("★ trigger：mcode.nodeId 透传", (msg.mcode as Record<string, unknown>).nodeId, "tr1");
    const sub = triggerSubscribePayload({ id: "t", "x-mcode": { nodeId: "tr1", params: { triggerKind: "file" } } });
    eq("★ trigger：订阅 payload 带 triggerKind", sub.triggerKind, "file");
  }

  // ── module-capability ──
  {
    const calls: Array<Record<string, unknown>> = [];
    await runModuleCapabilityNode({}, cfg({ moduleId: "core.file-report", contributionId: "inspect", path: "a.txt" }), {
      run: async (p) => { calls.push(p as unknown as Record<string, unknown>); return { text: "ok", artifacts: [] }; },
    });
    check("★ module-capability：port 收到 moduleId/contributionId/path",
      calls[0]?.moduleId === "core.file-report" && calls[0]?.contributionId === "inspect" && calls[0]?.path === "a.txt", calls[0]);
  }

  // ── node-red-call ──
  {
    const calls: Array<Record<string, unknown>> = [];
    const out = await runNodeRedCallNode({}, cfg({ enginePath: "/api/x", engineMethod: "POST", engineBody: "{}" }), {
      run: async (p) => { calls.push(p as unknown as Record<string, unknown>); return { text: "resp", artifacts: [], status: 200 }; },
    });
    check("★ node-red-call：port 收到 enginePath/engineMethod/engineBody",
      calls[0]?.enginePath === "/api/x" && calls[0]?.engineMethod === "POST" && calls[0]?.engineBody === "{}", calls[0]);
    eq("★ node-red-call：HTTP 状态进 msg.mcode.engineStatus", (out.msg.mcode as Record<string, unknown>).engineStatus, 200);
  }
}
console.log(`\nmcode-node-pack-smoke(含 6 类型纯逻辑):${total - failures}/${total} 通过`);

/* ══════════ C. 真 node-red 5.0.8：7 类型全链 ══════════ */
console.log("\nC. 真引擎：7 类型全部注册 → 全 runner.kind 迁移流启动 → 各节点执行一次");

const APP_DIR = process.cwd();
const NR_ROOT = process.env.MCODE_NR_E2E_ROOT ?? join(APP_DIR, ".tmp", "nr-e2e");
const INSTALLED = join(NR_ROOT, "workflow-engines", "node-red");
const NODE_RED_PKG = join(INSTALLED, "node_modules", "node-red", "package.json");
const PACK_BUNDLE = join(process.env.MCODE_NODE_PACK_TEST_ROOT ?? ".", "mcodeNodePack.cjs");
const TYPES_BUNDLE = join(process.env.MCODE_NODE_PACK_TEST_ROOT ?? ".", "mcodeNodeTypes.cjs");

if (!existsSync(NODE_RED_PKG) || !existsSync(PACK_BUNDLE) || !existsSync(TYPES_BUNDLE)) {
  console.log("SKIP: 未安装 node-red（或节点包 bundle 缺失）—— 真引擎段整套跳过（不是失败）。");
  console.log(`  期望 node-red: ${NODE_RED_PKG}`);
  console.log(`  期望节点包: ${PACK_BUNDLE} / ${TYPES_BUNDLE}`);
} else {
  const { ProductionWorkflowEngineRegistry } = await import("@main/workflowEngines/registry.js");
  const { EngineRuntime, defaultEngineRuntimePorts } = await import("@main/workflowEngines/runtimeSupervisor.js");
  const { MCODE_NODE_PACK_TYPES, allNodeHtml } = await import("@main/workflowEngines/mcodeNodeTypes.js");

  // 类型清单：真内置清单（迁移器看到的就是生产注册表看到的那份）。
  const types = new Map<string, ReturnType<typeof builtinManifestById> & object>();
  for (const id of [
    "mcode.main", "mcode.agent", "mcode.conversation", "mcode.branch", "mcode.condition",
    "mcode.trigger", "mcode.command", "mcode.code", "mcode.module-capability", "mcode.node-red",
  ]) {
    const manifest = builtinManifestById(id);
    if (manifest !== undefined) types.set(id, manifest);
  }

  // 含**全部 7 种 runner.kind** 的迁移图：
  //   trigger → conversation → agent → branch(两出口)
  //     ├─ 出口0 → condition(true) → code → module-capability
  //     └─ 出口1 → command(exec) → node-red-call
  // branch 的出口由 trigger 的假 port 注入 msg.mcode.branchPort=0。
  const doc = {
    id: "wf_all_kinds",
    name: "7 种 runner.kind 全链",
    builtin: false,
    updatedAt: 1_760_000_000_000,
    nodes: [
      { id: "k_trigger", type: "mcode.trigger", title: "触发", params: { triggerKind: "event", task: "跑一遍" }, position: { x: 10, y: 10 } },
      { id: "k_conv", type: "mcode.conversation", title: "对话", params: { instruction: "聊一句" }, position: { x: 110, y: 10 } },
      { id: "k_agent", type: "mcode.agent", title: "子 agent", params: { instruction: "查资料" }, position: { x: 210, y: 10 } },
      { id: "k_branch", type: "mcode.branch", title: "岔路", params: { decider: "user" }, position: { x: 310, y: 10 } },
      { id: "k_cond", type: "mcode.condition", title: "条件", params: { expression: { logic: "and", rules: [] } }, position: { x: 410, y: 10 } },
      { id: "k_code", type: "mcode.code", title: "代码", params: { code: "print(1)", language: "python" }, position: { x: 510, y: 10 } },
      { id: "k_module", type: "mcode.module-capability", title: "模块", params: { moduleId: "core.file-report", contributionId: "inspect", path: "a.txt" }, position: { x: 610, y: 10 } },
      { id: "k_cmd", type: "mcode.command", title: "命令", params: { command: "echo hi" }, position: { x: 410, y: 110 } },
      { id: "k_nr", type: "mcode.node-red", title: "NR 调用", params: { enginePath: "/api/x", engineMethod: "POST", engineBody: "{}" }, position: { x: 510, y: 110 } },
    ],
    edges: [
      { id: "ke1", from: "k_trigger", to: "k_conv" },
      { id: "ke2", from: "k_conv", to: "k_agent" },
      { id: "ke3", from: "k_agent", to: "k_branch" },
      { id: "ke4", from: "k_branch", to: "k_cond", label: "继续" },
      { id: "ke5", from: "k_branch", to: "k_cmd", label: "停" },
      { id: "ke6", from: "k_cond", to: "k_code", label: "true" },
      { id: "ke7", from: "k_cond", to: "k_module", label: "false" },
      { id: "ke8", from: "k_code", to: "k_module" },
      { id: "ke9", from: "k_cmd", to: "k_nr" },
    ],
  } as unknown as Parameters<typeof migrateWorkflowDoc>[0];
  const migrated = migrateWorkflowDoc(doc, { types });
  const migratedTypes = new Set(migrated.flow.nodes.map((n) => n.type));
  check("★【MERGE-2】迁移产物覆盖 7 种 runner.kind（4 个 mcode-* + 原生 inject/switch/exec）",
    ["mcode-conversation", "mcode-agent", "mcode-branch", "switch", "mcode-trigger", "exec", "mcode-module-capability", "mcode-node-red-call"]
      .every((t) => migratedTypes.has(t)), [...migratedTypes]);
  check("★【节点统一】迁移产物里不再出现 mcode-code（非 JS 语言走内置 exec）",
    !migratedTypes.has("mcode-code"), [...migratedTypes]);
  const codeNode = migrated.flow.nodes.find((n) => n["x-mcode"]?.nodeId === "k_code");
  check("★【节点统一】code(python) → 内置 exec + 解释器前缀",
    codeNode?.type === "exec" && String((codeNode as { command?: unknown }).command).startsWith("python -c "),
    { type: codeNode?.type, command: (codeNode as { command?: unknown } | undefined)?.command });
  // 条件节点（原生 switch）必须**两个输出口**并接上 true/false 两条边：只给一个口时
  // else 分支的消息会被 Node-RED 直接丢弃（真引擎实测，2026-10-19）。
  const switchNode = migrated.flow.nodes.find((n) => n.type === "switch");
  check("★【MERGE-2】condition → switch 有 true/false 两个输出口",
    switchNode?.wires?.length === 2 && switchNode.wires.every((w) => w.length === 1),
    switchNode?.wires);
  const switchRules = (switchNode as unknown as { rules?: Array<{ t?: string }> } | undefined)?.rules;
  check("★【MERGE-2】switch 带最小可执行规则（msg.mcode.condition → true/else 两口）",
    Array.isArray(switchRules) && switchRules.map((r) => r.t).join(",") === "true,else",
    switchRules);

  // 临时 userDir：节点包 = 一个 js + 一个 html。
  const userDir = mkdtempSync(join(tmpdir(), "mcode-node-pack-user-"));

  // ── 并行隔离（与 node-red-e2e-smoke 可同跑）──
  // 本套的数据根是 run.sh 用 mktemp 建的**私有目录**（MCODE_SMOKE_DATA_ROOT），
  // 不再借用 node-red-e2e 的 `.tmp/nr-e2e`（那边在同目录断言 engine-trust.json
  // = untrusted，并行时会被本套写入的 {"trusted":true} 踩红 —— 实测 78/80）。
  // 生产注册表的安装检查只看 `<dataDir>/node_modules/node-red/package.json`，所以
  // 把 `node_modules` 用 **junction** 指向共享安装树：106MB 不复制，而 flows.json /
  // engine-trust.json / bootstrap.cjs / .engine-admin-token 全落在本套私有目录。
  // junction 不可用 → 回退为整树复制（慢、占盘，但**绝不**回退成共享目录）。
  const sharedEngineRoot = process.env.MCODE_NODE_PACK_SHARED_ENGINE_ROOT
    ?? process.env.MCODE_NR_E2E_ROOT
    ?? join(APP_DIR, ".tmp", "nr-e2e");
  const sharedNodeModules = join(sharedEngineRoot, "workflow-engines", "node-red", "node_modules");
  const privateDataRoot = process.env.MCODE_SMOKE_DATA_ROOT ?? "";
  const privateEngineDir = privateDataRoot === "" ? "" : join(privateDataRoot, "workflow-engines", "node-red");
  let linkMode: "junction" | "copied" | "none" = "none";
  if (privateEngineDir !== "") {
    mkdirSync(privateEngineDir, { recursive: true });
    const linkPath = join(privateEngineDir, "node_modules");
    if (!existsSync(linkPath)) {
      try {
        // Windows junction：不需要管理员权限、不复制内容；Node 的 rmSync/rm -rf
        // 都不会跟随它删掉目标（实测）。
        symlinkSync(sharedNodeModules, linkPath, "junction");
        linkMode = "junction";
      } catch {
        // 回退：整树复制（代价：每次跑约 106MB 的 IO；仍然隔离，不共享可变状态）。
        cpSync(sharedNodeModules, linkPath, { recursive: true });
        linkMode = "copied";
      }
    } else {
      linkMode = lstatSync(linkPath).isSymbolicLink() ? "junction" : "copied";
    }
  }
  check("★ 真引擎数据目录与 node-red-e2e 隔离（私有 dataRoot + junction/复制共享安装树）",
    privateDataRoot !== "" && privateEngineDir !== sharedEngineRoot && linkMode !== "none",
    { privateDataRoot, sharedEngineRoot, linkMode });
  check("★ engine-trust.json 落私有目录（不写 node-red-e2e 的安装树）",
    privateEngineDir === "" || !privateEngineDir.startsWith(join(sharedEngineRoot, "workflow-engines")),
    { privateEngineDir, sharedEngineRoot });
  const nodesDir = join(userDir, "nodes");
  mkdirSync(nodesDir, { recursive: true });
  const runnerJs = [
    "// 测试注入的注册外壳：与生产完全同一条 RED.nodes.registerType 路径。",
    "const pack = require(" + JSON.stringify(TYPES_BUNDLE) + ");",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const userDir = process.env.MCODE_NODE_PACK_USER_DIR || '';",
    "function rec(name, payload) {",
    "  try { fs.appendFileSync(path.join(userDir, 'node-runs.jsonl'), JSON.stringify({ kind: name, payload }) + '\\n'); } catch (e) {}",
    "}",
    "const artifact = [{ kind: 'file', uri: 'file:///tmp/mcode-node-output.txt', mimeType: 'text/plain' }];",
    "module.exports = function (RED) {",
    "  pack.registerMcodeNodePack(RED, function () {",
    "    return {",
    "      agent: { async run(p) { rec('agent', p); return { text: 'agent:' + p.instruction, artifacts: artifact, runId: 'run_all_1' }; } },",
    "      conversation: { async run(p) { rec('conversation', p); return { text: 'conv:' + p.instruction, artifacts: artifact }; } },",
    "      branch: { async decide(p) { rec('branch', p); return { port: 0, label: '继续' }; } },",
    "      trigger: { subscribe(p, emit) { rec('trigger', p); setTimeout(function () { emit({ payload: { trigger: { kind: p.triggerKind, at: 1 } }, mcode: { nodeId: p.nodeId, runId: null, condition: true } }); }, 150); } },",
    "",
    "      moduleCapability: { async run(p) { rec('module-capability', p); return { text: 'module:' + p.moduleId, artifacts: artifact }; } },",
    "      nodeRedCall: { async run(p) { rec('node-red-call', p); return { text: 'nr:' + p.enginePath, artifacts: artifact, status: 200 }; } },",
    "    };",
    "  });",
    "};",
    "",
  ].join("\n");
  writeFileSync(join(nodesDir, "mcode-node-pack.js"), runnerJs, "utf8");
  writeFileSync(join(nodesDir, "mcode-node-pack.html"), allNodeHtml(), "utf8");

  const registry = new ProductionWorkflowEngineRegistry();
  const registryDataDir = registry.dataDirOf("node-red");
  eq("★ 生产注册表的引擎数据目录 = 本套私有 dataRoot（不是共享安装树）",
    registryDataDir, privateEngineDir);
  writeFileSync(join(registryDataDir, "engine-trust.json"), JSON.stringify({ trusted: true }), "utf8");
  const launch = registry.launchSpec("node-red");
  check("★ 生产 launchSpec 可用", launch !== null);

  if (launch !== null) {
    const tailBox: { get: (() => string) | null } = { get: null };
    const ports = {
      ...defaultEngineRuntimePorts,
      spawn: (spec: Parameters<typeof defaultEngineRuntimePorts.spawn>[0]) => {
        const child = defaultEngineRuntimePorts.spawn(spec);
        tailBox.get = () => child.tailOutput();
        return child;
      },
    };
    const runtime = new EngineRuntime("node-red", ports);
    try {
      const status = await runtime.start({
        engineId: "node-red",
        dataDir: userDir,
        command: launch.command,
        args: (port, dataDir) => launch.args(port, dataDir),
        env: { ...(launch.env ?? {}), MCODE_NODE_PACK_USER_DIR: userDir },
        ...(launch.probeIdentity !== undefined ? { probeIdentity: launch.probeIdentity } : {}),
        readyTimeoutMs: 20_000,
      });
      check("★ 真引擎经生产路径就绪", status.state === "running" && status.port !== null, status);
      const port = status.port ?? 0;
      const token = launch.env?.MCODE_ENGINE_ADMIN_TOKEN ?? "";
      const auth = { authorization: `Bearer ${token}` };

      // ① GET /nodes：7 个 mcode-* 类型全部注册且无 err。
      const nodesRes = await fetch(`http://127.0.0.1:${port}/nodes`, {
        headers: { ...auth, accept: "application/json" },
        signal: AbortSignal.timeout(8_000),
      });
      const nodeList = (await nodesRes.json()) as Array<{ types?: string[]; err?: string }>;
      const registeredTypes = new Set(nodeList.flatMap((n) => n.types ?? []));
      check("★【MERGE-2】GET /nodes 里 7 个 mcode-* 类型全部注册",
        nodesRes.status === 200 && MCODE_NODE_PACK_TYPES.every((t) => registeredTypes.has(t)),
        { status: nodesRes.status, missing: MCODE_NODE_PACK_TYPES.filter((t) => !registeredTypes.has(t)), types: [...registeredTypes] });
      const packEntries = nodeList.filter((n) => n.types?.some((t) => (MCODE_NODE_PACK_TYPES as readonly string[]).includes(t)));
      check("★【MERGE-2】7 个类型都没有加载错误（err 缺席）",
        packEntries.every((n) => n.err === undefined), packEntries.map((n) => n.err));

      // ② 部署整张迁移流 + 一条原生 HTTP-in 活体探针（同一份部署）。
      const probeTab = { id: "tab_probe_all", type: "tab", label: "probe", disabled: false, info: "", env: [] };
      const probeIn = { id: "in_probe_all", type: "http in", z: "tab_probe_all", url: "/all-kinds", method: "get", upload: false, swaggerDoc: "", x: 100, y: 900, wires: [["out_probe_all"]] };
      const probeOut = { id: "out_probe_all", type: "http response", z: "tab_probe_all", x: 300, y: 900, wires: [] };
      const deployFlows = [...migrated.flow.nodes, probeTab, probeIn, probeOut];
      try {
        rmSync(join(userDir, "node-runs.jsonl"), { force: true });
      } catch {
        /* 不存在 */
      }
      const deploy = await fetch(`http://127.0.0.1:${port}/flows`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json", "Node-RED-Deployment-Type": "full", "Node-RED-API-Version": "v2" },
        body: JSON.stringify({ flows: deployFlows }),
        signal: AbortSignal.timeout(15_000),
      });
      check("★【MERGE-2】含全部 7 种 runner.kind 的迁移流部署成功（200）", deploy.status === 200, deploy.status);

      // ③ HTTP-in 真的 200：missing-types 闸不再触发（对照 Gate C 的 404）。
      let probeStatus = 0;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const r = await fetch(`http://127.0.0.1:${port}/api/all-kinds`, { signal: AbortSignal.timeout(2_000) }).catch(() => null);
        probeStatus = r?.status ?? 0;
        if (probeStatus === 200) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (probeStatus !== 200) {
        console.log("  [evidence] engine tail:", (tailBox.get === null ? "(no child)" : tailBox.get()).slice(-2000));
      }
      check("★【MERGE-2】迁移流整组真的启动（HTTP-in 200；missing-types 闸不再触发）", probeStatus === 200, { probeStatus });

      // ④ 各节点执行一次（trigger 自动 emit → conversation → agent → branch →
      //    condition → code → module-capability；exec/switch 是原生节点不记 port）。
      const expectedKinds = ["trigger", "conversation", "agent", "branch", "module-capability"];
      let calls: Array<{ kind: string; payload: Record<string, unknown> }> = [];
      const callsDeadline = Date.now() + 10_000;
      while (Date.now() < callsDeadline) {
        try {
          calls = readFileSync(join(userDir, "node-runs.jsonl"), "utf8")
            .split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as { kind: string; payload: Record<string, unknown> });
        } catch {
          calls = [];
        }
        if (expectedKinds.every((k) => calls.some((c) => c.kind === k))) break;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      const kindCounts = new Map<string, number>();
      for (const c of calls) kindCounts.set(c.kind, (kindCounts.get(c.kind) ?? 0) + 1);
      eq("★【MERGE-2】5 个经 port 的节点各执行一次（trigger/conversation/agent/branch/module-capability）",
        expectedKinds.map((k) => [k, kindCounts.get(k) ?? 0]), expectedKinds.map((k) => [k, 1]));
      check("★【MERGE-2】exec / switch 是原生节点（不经过 port；node-red-call 因 branch 选 0 未走到）",
        !calls.some((c) => c.kind === "node-red-call"), [...kindCounts.keys()]);
      const byKind = (k: string): Record<string, unknown> | undefined => calls.find((c) => c.kind === k)?.payload;
      check("★【MERGE-2】conversation 收到 instruction", byKind("conversation")?.instruction === "聊一句", byKind("conversation"));
      check("★【MERGE-2】agent 收到 instruction", byKind("agent")?.instruction === "查资料", byKind("agent"));
      check("★【MERGE-2】branch 收到端口数 = 2", byKind("branch")?.portCount === 2, byKind("branch"));
      check("★【MERGE-2】module-capability 收到 moduleId", byKind("module-capability")?.moduleId === "core.file-report", byKind("module-capability"));
      check("★【MERGE-2】trigger 收到 triggerKind", byKind("trigger")?.triggerKind === "event", byKind("trigger"));

      const stopped = await runtime.stop(1_000);
      check("★ 真引擎 stop 后状态 stopped、端口清空", stopped.state === "stopped" && stopped.port === null, stopped);
    } finally {
      try {
        await runtime.stop(1_000);
      } catch {
        /* 已停 */
      }
      try {
        rmSync(userDir, { recursive: true, force: true });
      } catch {
        /* 清理失败不影响结论 */
      }
    }
  }
}


console.log(`\nmcode-node-pack-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exitCode = 1;
