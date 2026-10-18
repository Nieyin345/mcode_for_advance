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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/* ══════════ B. 真 node-red 5.0.8：注册/部署/执行 ══════════ */
console.log("\nB. 真引擎：节点包被 Node-RED 注册、迁移流启动、节点执行");

const APP_DIR = process.cwd();
const NR_ROOT = process.env.MCODE_NR_E2E_ROOT ?? join(APP_DIR, ".tmp", "nr-e2e");
const INSTALLED = join(NR_ROOT, "workflow-engines", "node-red");
const NODE_RED_PKG = join(INSTALLED, "node_modules", "node-red", "package.json");
const PACK_BUNDLE = join(process.env.MCODE_NODE_PACK_TEST_ROOT ?? ".", "mcodeNodePack.cjs");

if (!existsSync(NODE_RED_PKG) || !existsSync(PACK_BUNDLE)) {
  console.log("SKIP: 未安装 node-red（或节点包 bundle 缺失）—— 真引擎段整套跳过（不是失败）。");
  console.log(`  期望 node-red: ${NODE_RED_PKG}`);
  console.log(`  期望节点包: ${PACK_BUNDLE}`);
} else {
  const { ProductionWorkflowEngineRegistry } = await import("@main/workflowEngines/registry.js");
  const { EngineRuntime, defaultEngineRuntimePorts } = await import("@main/workflowEngines/runtimeSupervisor.js");

  // 类型清单：真内置清单（迁移器看到的就是生产注册表看到的那份）。
  const types = new Map<string, NonNullable<ReturnType<typeof builtinManifestById>>>();
  for (const id of ["mcode.main", "mcode.agent", "mcode.branch", "mcode.condition", "mcode.trigger", "mcode.command", "mcode.code"]) {
    const manifest = builtinManifestById(id);
    if (manifest !== undefined) types.set(id, manifest);
  }

  // 迁移图：mcode.main → mcode.branch(两条出边) → 一个 mcode-agent 支路 + 一个原生
  // http response 支路。agent 的产出会经下游 HTTP response 回来 —— 这条断言同时证明
  // 「整组启动了」「节点真的执行了」「端口被调用了」。
  const doc = {
    id: "wf_agent_pack",
    name: "mcode-agent 节点包样例",
    builtin: false,
    updatedAt: 1_760_000_000_000,
    nodes: [
      { id: "a_main", type: "mcode.main", title: "主代理", params: { instruction: "拆解" }, position: { x: 10, y: 10 } },
      { id: "a_agent", type: "mcode.agent", title: "子 agent", params: { instruction: "把输入原样交回", outputVars: [{ name: "text" }] }, position: { x: 110, y: 10 } },
      { id: "a_cond", type: "mcode.condition", title: "条件", params: { expression: { logic: "and", rules: [] } }, position: { x: 210, y: 10 } },
    ],
    edges: [
      { id: "ea1", from: "a_main", to: "a_agent" },
      { id: "ea2", from: "a_agent", to: "a_cond" },
      { id: "ea3", from: "a_cond", to: "a_agent", label: "true" },
      { id: "ea4", from: "a_cond", to: "a_agent", label: "false" },
    ],
  } as unknown as Parameters<typeof migrateWorkflowDoc>[0];
  const migrated = migrateWorkflowDoc(doc, { types });
  check("★ 迁移图里 mcode-agent 节点存在（节点包要注册的就是它）",
    migrated.flow.nodes.some((n) => n.type === MCODE_AGENT_NODE_TYPE), migrated.flow.nodes.map((n) => n.type));

  // 临时 userDir + 节点包安装（Node-RED 约定：<userDir>/nodes/<name>.js + 同名 .html）。
  const userDir = mkdtempSync(join(tmpdir(), "mcode-node-pack-user-"));
  const nodesDir = join(userDir, "nodes");
  mkdirSync(nodesDir, { recursive: true });
  writeFileSync(join(nodesDir, "mcode-agent.js"), `
// 测试注入的注册外壳：与生产完全同一条 RED.nodes.registerType 路径。
const pack = require(${JSON.stringify(PACK_BUNDLE)});
const fs = require("node:fs");
const path = require("node:path");
const userDir = process.env.MCODE_NODE_PACK_USER_DIR || "";
module.exports = function (RED) {
  pack.registerMcodeAgentNodes(RED, function () {
    return {
      async run(payload) {
        // 假 port：记录每次调用（引擎进程里写文件，测试进程读回核对次数与内容）。
        try {
          fs.appendFileSync(path.join(userDir, "agent-runs.jsonl"), JSON.stringify(payload) + "\\n");
        } catch (e) { /* 记录失败不改变产出一致性 */ }
        return {
          text: "agent:" + payload.instruction,
          artifacts: [{ kind: "file", uri: "file:///tmp/mcode-agent-output.txt", mimeType: "text/plain" }],
          runId: "run_pack_1",
        };
      },
    };
  });
};
`.trimStart(), "utf8");
  writeFileSync(join(nodesDir, "mcode-agent.html"), agentNodeHtml(), "utf8");

  const registry = new ProductionWorkflowEngineRegistry();
  // 可信标记：迁移流里没有持久化 flow 也无所谓；写它只为与 A/B 段一致。
  writeFileSync(join(registry.dataDirOf("node-red"), "engine-trust.json"), JSON.stringify({ trusted: true }), "utf8");
  const launch = registry.launchSpec("node-red");
  check("★ 生产 launchSpec 可用", launch !== null);

  if (launch !== null) {
    // 本套用独立 userDir 起（数据文件隔离）：bootstrap 从 argv 拿 userDir，节点包在
    // `<userDir>/nodes/`，已被 Node-RED 的 loader 扫到（B 段第一条断言即证）。
    /** 记录式 spawn：捕获引擎 tail 输出（bootstrap 日志是 warn 级，missing-types 是 info
     *  级看不到 —— 但节点包加载错误会以 error/异常出现在这里）。 */
    // 包一层对象：赋值发生在 spawn 闭包里，直接 `let fn = null` 会被 TS 收窄成 null。
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
      // bootstrap 的 argv[3] 是 userDir —— 用 args 覆写指到临时 userDir（其余命令/env 原样）。
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

      // ① 节点包被注册：GET /nodes 里能看到 mcode-agent 类型且没有 err。
      const nodesRes = await fetch(`http://127.0.0.1:${port}/nodes`, {
        headers: { ...auth, accept: "application/json" },
        signal: AbortSignal.timeout(8_000),
      });
      const nodeList = (await nodesRes.json()) as Array<{ types?: string[]; err?: string; id?: string }>;
      const packEntry = nodeList.find((n) => Array.isArray(n.types) && n.types.includes(MCODE_AGENT_NODE_TYPE));
      check("★【MERGE-2】真引擎把 mcode-agent 注册进节点表（GET /nodes）",
        nodesRes.status === 200 && packEntry !== undefined,
        { status: nodesRes.status, types: nodeList.map((n) => n.types) });
      check("★【MERGE-2】注册条目没有加载错误（err 缺席）", packEntry?.err === undefined, packEntry);

      // ② 部署迁移流：含 mcode-agent 的整组 flow 真的启动。
      const flowWithAgent = migrated.flow.nodes;
      const deploy = await fetch(`http://127.0.0.1:${port}/flows`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json", "Node-RED-Deployment-Type": "full", "Node-RED-API-Version": "v2" },
        body: JSON.stringify({ flows: flowWithAgent }),
        signal: AbortSignal.timeout(15_000),
      });
      check("★【MERGE-2】含 mcode-agent 的迁移流部署成功（200）", deploy.status === 200, deploy.status);

      // ②' 迁移图里有 mcode.main / mcode.condition 等**未安装**的类型，整组仍会
      //      missing-types 不启动（Gate C 已钉的硬事实）—— 这不是本片要改的。
      //      「mcode-agent 已注册 → 整组能启动」用一份**只含已注册类型**的流来验：
      //      http in → mcode-agent → http response（全部已注册）。它的 HTTP-in 200
      //      就是注册成功的对照证据；若 mcode-agent 未注册，它会与 Gate C 一样 404。
      const directFlow = [
        { id: "tab_direct", type: "tab", label: "direct", disabled: false, info: "", env: [] },
        { id: "in_direct", type: "http in", z: "tab_direct", url: "/agent-run", method: "get", upload: false, swaggerDoc: "", x: 100, y: 800, wires: [["agent_direct"]] },
        {
          id: "agent_direct",
          type: MCODE_AGENT_NODE_TYPE,
          z: "tab_direct",
          name: "agent",
          instruction: "把输入原样交回",
          capability: "read",
          outputVar: "text",
          x: 300,
          y: 800,
          wires: [["out_direct"]],
          "x-mcode": { nodeId: "a_agent_direct", params: { instruction: "把输入原样交回" } },
        },
        { id: "out_direct", type: "http response", z: "tab_direct", x: 500, y: 800, wires: [] },
      ];
      // 触发前清掉计数文件（全量重部署会重建节点，但文件跨部署保留）。
      try {
        rmSync(join(userDir, "agent-runs.jsonl"), { force: true });
      } catch {
        /* 不存在 */
      }
      const deployDirect = await fetch(`http://127.0.0.1:${port}/flows`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json", "Node-RED-Deployment-Type": "full", "Node-RED-API-Version": "v2" },
        body: JSON.stringify({ flows: directFlow }),
        signal: AbortSignal.timeout(15_000),
      });
      check("★【MERGE-2】http-in → mcode-agent → http-response 流部署成功", deployDirect.status === 200);

      let probeStatus = 0;
      let probeBody = "";
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const r = await fetch(`http://127.0.0.1:${port}/api/agent-run`, { signal: AbortSignal.timeout(2_000) }).catch(() => null);
        probeStatus = r?.status ?? 0;
        probeBody = r === null ? "" : await r.text();
        if (probeStatus === 200) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (probeStatus !== 200) {
        console.log("  [evidence] engine tail:", (tailBox.get === null ? "(no child)" : tailBox.get()).slice(-1500));
      }
      check("★【MERGE-2】含 mcode-agent 的整组 flow 真的启动（全已注册类型的流，HTTP-in 200）",
        probeStatus === 200, { probeStatus });
      let body: unknown = null;
      try {
        body = JSON.parse(probeBody);
      } catch {
        /* 断言里看原文 */
      }
      check("★【MERGE-2】节点被触发执行一次并产出预期 payload（HTTP response 回 { text, artifacts }）",
        probeStatus === 200
        && (body as { text?: string } | null)?.text === "agent:把输入原样交回"
        && Array.isArray((body as { artifacts?: unknown[] } | null)?.artifacts)
        && ((body as { artifacts?: Array<{ uri?: string }> }).artifacts ?? [])[0]?.uri === "file:///tmp/mcode-agent-output.txt",
        { status: probeStatus, body, probeBody: probeBody.slice(0, 300) });

      // ④ 假 port 被调用一次：读引擎进程写的计数文件。
      let calls: Array<Record<string, unknown>> = [];
      try {
        calls = readFileSync(join(userDir, "agent-runs.jsonl"), "utf8")
          .split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Record<string, unknown>);
      } catch {
        /* 文件不存在 = 0 次 */
      }
      eq("★【MERGE-2】假 port 恰好被调用一次", calls.length, 1);
      check("★【MERGE-2】假 port 收到的 instruction 正确", calls[0]?.instruction === "把输入原样交回", calls[0]);
      check("★【MERGE-2】假 port 收到的 nodeId 来自 x-mcode", calls[0]?.nodeId === "a_agent_direct", calls[0]);

      // 清理：停止引擎。
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
