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
import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
import { checkPaletteResources } from "./paletteChecks.js";
import { expectedNodePackFiles } from "@main/workflowEngines/nodePackManifest.js";
import { builtinManifestById } from "@main/orchestration/nodeTypes.js";
// 【Q9d】**运行历史要读库**（`nativeRunHistory` 把每次原生运行写进 workflow_runs）。
// 本套跑的是真 Node-RED 子进程 + 真节点包，节点执行完会走那条持久化 —— 没有
// initDb 时它抛 `getDb() called before initDb() resolved`，被 `[warn] 原生运行记录
// 写入失败` 吞掉，而**下游节点的派发会跟着断**（实测 MERGE-2 里只有 trigger 执行，
// 其余 4 个 port 全 0 次）。数据根是 run.sh 给的本套私有 mktemp 目录。
import { initDb } from "@main/store/db.js";
import { ProjectRepo, SessionRepo, WorkflowRepo } from "@main/store/repositories.js";
import { getWorkflow } from "@main/orchestration/library.js";

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

/* ══════════ T79. 原生编辑器资源的独立契约 ══════════ */
checkPaletteResources(check);

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

  // Native trigger input is carried only as a Host lookup key. The renderer
  // never passes DOI/other form fields inside the child node request.
  {
    const port = recordingPort();
    await runAgentNode({
      payload: { untrusted: "not a DOI" },
      mcode: { triggerTicket: "trusted-from-host", runId: "r" },
    }, migratedConfig, port);
    eq("W25 Agent 把上游 Host ticket 传给执行端口", port.calls[0]?.triggerTicket,
      "trusted-from-host");
  }

  // 节点配置直接手填（编辑器里创建、未经迁移器）也能读。
  {
    const port = recordingPort();
    const outcome = await runAgentNode({}, { id: "n1", instruction: "手填指令", capability: "read", outputVar: "结果" }, port);
    eq("★ 编辑器直填的 instruction 生效", port.calls[0]?.instruction, "手填指令");
    eq("★ 编辑器直填的 capability 生效", port.calls[0]?.capability, "read");
    eq("★ outputVar 标注在 msg.mcode 上", (outcome.msg.mcode as { outputVar?: string }).outputVar, "结果");
  }

  // FULL-2: when a migrated node is edited using the native Node-RED
  // palette, top-level properties are the editor's canonical state. Stale
  // x-mcode.params must not silently override the user's saved edits.
  {
    const editorConfig: McodeAgentNodeConfig = {
      id: "native-red-edited",
      instruction: "用户在原生画布的新指令",
      capability: "read",
      outputVar: "new-output",
      "x-mcode": {
        nodeId: "original-mcode-id",
        params: {
          instruction: "旧迁移指令",
          capability: "write",
          outputVar: "old-output",
          "x-unrelated": {keep: true},
        },
      },
    };
    const port = recordingPort();
    const outcome = await runAgentNode({payload:"native-editor"},editorConfig,port);
    eq("★ 原生 Node-RED 编辑器修改 instruction 优先于旧 x-mcode.params",port.calls[0]?.instruction,
      "用户在原生画布的新指令");
    eq("★ 原生编辑器把 write 降为 read 后 Host 不再收到旧 write",port.calls[0]?.capability,"read");
    eq("★ Host params 同步使用原生编辑后的 instruction 而非旧 sidecar",
      port.calls[0]?.params["instruction"],"用户在原生画布的新指令");
    eq("★ Host params 不保留过时的 write 能力",
      port.calls[0]?.params["capability"],"read");
    eq("★ 原生编辑器新的输出变量覆盖旧迁移值",
      (outcome.msg.mcode as {outputVar?:string}).outputVar,"new-output");
    eq("★ 旧 sidecar 的未知附加字段原样保留",
      port.calls[0]?.params["x-unrelated"],{keep:true});
    eq("★ 迁移项目节点身份不因表单编辑变化",port.calls[0]?.nodeId,"original-mcode-id");
    eq("★ 原生用户覆盖配置不回写/篡改旧迁移 metadata",
      (editorConfig["x-mcode"]?.params as Record<string, unknown>)["instruction"],"旧迁移指令");
  }
  {
    const editedBlank=normalizeAgentConfig({
      id:"native-clear",
      instruction:"",
      capability:"invalid",
      outputVar:"",
      "x-mcode": {params: {instruction:"stale",capability:"write",outputVar:"stale-result","custom":13}},
    });
    eq("★ 显式清空原生编辑器指令不能复活旧 sidecar",editedBlank.instruction,"");
    eq("★ 原生权限坏值必须拒用旧 write 并降为 read",editedBlank.capability,"read");
    eq("★ 显式清空输出变量不能复活旧 sidecar",editedBlank.outputVar,null);
    eq("★ 同步传给 Host 的 params 也不再含清空前旧指令",editedBlank.params["instruction"],"");
    eq("★ Host params 对无效权限拒绝保留旧 write",editedBlank.params["capability"],"read");
    check("★ 原生表单清空 outputVar 时 Host params 不复活旧结果",!editedBlank.params["outputVar"]);
    eq("★ 未知原迁移参数依旧保留",editedBlank.params["custom"],13);
  }

  // A cleared editor output variable must not inherit a stale name from upstream msg.mcode.
  {
    const outcome = await runAgentNode(
      { payload: "x", mcode: { runId: "upstream-run", outputVar: "upstream-old", extra: "keep" } },
      { id: "cleared-output", outputVar: "" },
      recordingPort(),
    );
    check("★ 清空 outputVar 不透传上游旧 outputVar",
      !Object.prototype.hasOwnProperty.call(outcome.msg.mcode, "outputVar"));
    eq("★ 清理旧 outputVar 时保留其他 mcode 元数据",
      (outcome.msg.mcode as Record<string, unknown>)["extra"], "keep");
  }

  // 缺 instruction / 类型不对 → 安全默认，不抛。
  {
    const normalized = normalizeAgentConfig({ instruction: 42, capability: "exec", outputVar: 7 } as McodeAgentNodeConfig);
    eq("非法 instruction → 空串", normalized.instruction, "");
    eq("非法 capability → read（保守默认）", normalized.capability, "read");
    eq("非法 outputVar → null", normalized.outputVar, null);
  }

  // A damaged Node-RED flows.json may contain runtime values that do not
  // satisfy the TypeScript interface. Normalization must be total, and an
  // untrusted Host RPC result must not be forwarded as a successful run.
  {
    let damagedThrew = false;
    let normalized: ReturnType<typeof normalizeAgentConfig> | null = null;
    try { normalized = normalizeAgentConfig(null as unknown as McodeAgentNodeConfig); }
    catch { damagedThrew = true; }
    check("★ null Node-RED config uses conservative defaults without throwing",
      !damagedThrew && normalized?.capability === "read" && normalized.instruction === "",normalized);
    const arrayParams = normalizeAgentConfig({
      id: "fixture", "x-mcode": { params: ["forged"] as unknown as Record<string, unknown> },
    });
    check("★ invalid array x-mcode.params never gets forwarded as an argument object",
      !Array.isArray(arrayParams.params) && Object.keys(arrayParams.params).length === 0,arrayParams.params);
    for (const bad of [null, { text: "untrusted", artifacts: null }, { text: 1, artifacts: [] }]) {
      let caught = false;
      try {
        await runAgentNode({}, { id: "runtime-bad" }, { run: async () => bad as never });
      } catch (error) {
        caught = error instanceof Error && /结果|result|artifacts|text|invalid/i.test(error.message);
      }
      check("★ malformed Host Agent RPC result cannot pass as a successful Node-RED message", caught, bad);
    }
  }

  // ARC-006: bad Host artifact metadata must fail closed before a Node-RED
  // success message is published. Optional fields are part of the wire contract.
  {
    const invalidArtifacts: unknown[] = [
      [{ kind: "", uri: "file:///ok" }],
      [{ kind: "file", uri: "" }],
      [{ kind: "file", uri: "file:///ok", name: 12 }],
      [{ kind: "file", uri: "file:///ok", mimeType: ["text/plain"] }],
      [{ kind: "file", uri: "file:///ok", sizeBytes: -1 }],
      [{ kind: "file", uri: "file:///ok", sizeBytes: Number.POSITIVE_INFINITY }],
      [{ kind: "file", uri: "file:///ok", sizeBytes: 1.5 }],
      [{ kind: "file", uri: "file:///ok", callback: () => "unsafe IPC value" }],
      [{ kind: "file", uri: "file:///ok", extra: Symbol("not cloneable") }],
    ];
    for (const artifacts of invalidArtifacts) {
      let rejected = false;
      try { await runAgentNode({}, { id: "artifact-boundary" }, { run: async () =>
        ({ text: "do not send", artifacts }) as never }); }
      catch { rejected = true; }
      check("★ 非法 Host artifact 字段不得作为成功消息发布", rejected, artifacts);
    }
    for (const runId of ["", "  "]) {
      let rejected = false;
      try {
        await runAgentNode({}, { id: "invalid-host-run-id" }, { run: async () => ({
          text: "must reject", artifacts: [], runId,
        }) });
      } catch { rejected = true; }
      check("★ 空白 Host runId 不得作为已签发的真实运行身份", rejected, { runId });
    }
    const accepted = await runAgentNode({}, { id: "artifact-valid" }, { run: async () => ({
      text: "ok", artifacts: [{ kind: "file", uri: "file:///ok", name: "ok.txt", mimeType: "text/plain", sizeBytes: 0 }],
    }) });
    eq("★ 合法 artifact 可保留可选文件元数据",
      (accepted.msg.payload as { artifacts: unknown[] }).artifacts.length, 1);
    const hostResult = {
      text: "original",
      artifacts: [{ kind: "file", uri: "file:///original", name: "before" }],
      runId: "host-run-1",
    };
    const immutable = await runAgentNode({}, { id: "host-result-snapshot" }, { run: async () => hostResult });
    hostResult.text = "changed after Host response";
    hostResult.artifacts[0]!.uri = "file:///mutated";
    hostResult.artifacts[0]!.name = "after";
    const outgoing = immutable.msg.payload as { text: string; artifacts: Array<{ uri: string; name: string }> };
    eq("★ Host port late mutation cannot change emitted text", outgoing.text, "original");
    eq("★ Host port late mutation cannot change emitted artifact URI", outgoing.artifacts[0]?.uri, "file:///original");
    eq("★ Host port late mutation cannot change emitted artifact name", outgoing.artifacts[0]?.name, "before");
  }

  // Node identity is mandatory for a real Host RPC. A malformed flow cannot
  // silently ask the Host to execute a node with no identity.
  {
    let calls = 0;
    let rejected = false;
    try {
      await runAgentNode({}, { id: "" }, { run: async () => { calls++; return { text: "bad", artifacts: [] }; } });
    } catch { rejected = true; }
    check("★ 缺失 Node-RED 节点身份必须在调用 Host 前拒绝", rejected && calls === 0, { rejected, calls });
  }

  // Node-RED may mutate the original msg while the Host RPC is pending. The
  // late result must retain invocation-time metadata, not trust later edits.
  {
    let resolveHost!: (value: { text: string; artifacts: [] }) => void;
    let sawInvocation!: () => void;
    const invoked = new Promise<void>((resolve) => { sawInvocation = resolve; });
    const pendingHost = new Promise<{ text: string; artifacts: [] }>((resolve) => { resolveHost = resolve; });
    const input: Record<string, unknown> = {
      payload: "original", auditTag: "before", mcode: { runId: "orig-run", marker: "before" },
    };
    let hostInput: unknown;
    const resultPromise = runAgentNode(input, { id: "snapshot-node" }, {
      run: async (call) => { hostInput = call.input; sawInvocation(); return pendingHost; },
    });
    await invoked;
    input["auditTag"] = "after";
    input["payload"] = "changed";
    (input["mcode"] as Record<string, unknown>)["marker"] = "after";
    (input["mcode"] as Record<string, unknown>)["forgedGrant"] = true;
    resolveHost({ text: "complete", artifacts: [] });
    const result = await resultPromise;
    eq("★ Host 等待期间上游修改外层消息不影响结果快照", result.msg["auditTag"], "before");
    eq("★ Host 接收到发起时的 payload 而非后续覆盖值", hostInput, "original");
    eq("★ Host 等待期间上游篡改 msg.mcode 不影响回执", (result.msg["mcode"] as Record<string, unknown>)["marker"], "before");
    check("★ Host 等待期间新插入的权限标志不能注入结果",
      !(result.msg["mcode"] as Record<string, unknown>)["forgedGrant"]);
  }

  // Deep JSON-like metadata and params must also be stable while the Host
  // queues work. A shallow spread does not protect nested mutable records.
  {
    let finish!: (value: { text: string; artifacts: [] }) => void;
    let hostCall!: { params: Record<string, unknown> };
    const config: McodeAgentNodeConfig = {
      id: "nested-snapshot", "x-mcode": { params: { options: { access: "before" } } },
    };
    const msg = { mcode: { runId: "r1", lineage: { source: "before" } } };
    const pending = runAgentNode(msg, config, {
      run: async (payload) => {
        hostCall = payload;
        return new Promise<{ text: string; artifacts: [] }>((resolve) => { finish = resolve; });
      },
    });
    (config["x-mcode"]!.params as { options: { access: string } }).options.access = "after";
    msg.mcode.lineage.source = "after";
    finish({ text: "done", artifacts: [] });
    const result = await pending;
    eq("★ 异步等待中旧配置嵌套参数不可篡改 Host 调用",
      (hostCall.params["options"] as { access: string }).access, "before");
    eq("★ 异步等待中嵌套来源元数据不可污染回执",
      ((result.msg["mcode"] as Record<string, unknown>)["lineage"] as { source: string }).source, "before");
  }
  {
    let calls = 0;
    let rejected = false;
    try {
      await runAgentNode({}, { id: "invalid-params", "x-mcode": { params: { bad: () => "not IPC data" } } }, {
        run: async () => { calls++; return { text: "bad", artifacts: [] }; },
      });
    } catch { rejected = true; }
    check("★ 不可传输的函数参数在进入 Host RPC 之前拒绝", rejected && calls === 0, { rejected, calls });
  }

  // The Host's input payload is JSON-like, not a live reference into the
  // mutable Node-RED graph. Snapshot before awaiting transport serialization.
  {
    let finish!: (value: { text: string; artifacts: [] }) => void;
    let receivedInput: unknown;
    const input = { payload: { nested: { instruction: "original" } } };
    const pending = runAgentNode(input, { id: "payload-snapshot" }, {
      run: async (call) => {
        receivedInput = call.input;
        return new Promise<{ text: string; artifacts: [] }>((resolve) => { finish = resolve; });
      },
    });
    input.payload.nested.instruction = "mutated";
    finish({ text: "done", artifacts: [] });
    await pending;
    eq("★ Node-RED 输入嵌套 payload 异步变更不能污染 Host 收到的参数",
      (receivedInput as { nested: { instruction: string } }).nested.instruction, "original");
  }
  {
    let calls = 0;
    let rejected = false;
    try {
      await runAgentNode({ payload: { callback: () => "not JSON" } }, { id: "not-serializable" }, {
        run: async () => { calls++; return { text: "bad", artifacts: [] }; },
      });
    } catch { rejected = true; }
    check("★ 无法复制的非 IPC 数据 payload 必须在 Host 调用前拒绝",
      rejected && calls === 0, { rejected, calls });
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

    // —— 节点关闭后 Host RPC 晚到：旧实例绝不能继续向新 flow 发送结果或错误 ——
    for (const rejectAfterClose of [false, true]) {
      let release!: (value: { text: string; artifacts: [] }) => void;
      let reject!: (reason: Error) => void;
      const pending = new Promise<{ text: string; artifacts: [] }>((resolve, fail) => {
        release = resolve; reject = fail;
      });
      let ctor!: Registered["ctor"];
      registerMcodeAgentNodes({
        nodes: { registerType: (_type, registeredCtor) => { ctor = registeredCtor as Registered["ctor"]; }, createNode: () => {} },
      }, () => ({ run: () => pending }));
      const handlers = new Map<string, (...args: any[]) => void>();
      const instance = {
        on: (event: string, handler: (...args: any[]) => void) => { handlers.set(event, handler); },
        error: (_error: unknown) => { errors++; },
      };
      let sends = 0;
      let dones = 0;
      let errors = 0;
      (ctor as unknown as (this: unknown, config: McodeAgentNodeConfig) => void).call(instance, { id: "closed-node" });
      handlers.get("input")!({}, () => { sends++; }, () => { dones++; });
      handlers.get("close")!();
      eq("★ Agent close 立即完成在途 Node-RED input", dones, 1);
      handlers.get("close")!(); // Node-RED duplicate close is idempotent
      eq("★ Agent 重复 close 不重复调用 done", dones, 1);
      if (rejectAfterClose) reject(new Error("late host failure"));
      else release({ text: "late host success", artifacts: [] });
      await new Promise<void>((resolve) => setImmediate(resolve));
      eq("★ Agent 关闭后 Host 晚到不得向旧 flow 发送", sends, 0);
      eq("★ Agent 关闭时待处理输入必须结算一次 done（不得悬挂部署）", dones, 1);
      eq("★ Agent 关闭后 Host 晚到不得报告旧实例错误", errors, 0);
    }

    // Re-deploy can close several concurrent inputs before any Host reply.
    // Every Node-RED completion must be released once even if one Host call
    // never settles. Late results cannot emit into the replaced flow.
    {
      let ctor!: Registered["ctor"];
      const handlers = new Map<string, (...args: any[]) => void>();
      const deferred: Array<{
        resolve: (value: { text: string; artifacts: [] }) => void;
        reject: (error: Error) => void;
      }> = [];
      const pendingPort = {
        run: () => new Promise<{ text: string; artifacts: [] }>((resolve, reject) => {
          deferred.push({ resolve, reject });
        }),
      };
      registerMcodeAgentNodes({
        nodes: { registerType: (_name, value) => { ctor = value as Registered["ctor"]; }, createNode: () => {} },
      }, () => pendingPort);
      let sends = 0;
      let errors = 0;
      const doneCounts = [0, 0, 0];
      const instance = {
        on: (event: string, handler: (...args: any[]) => void) => { handlers.set(event, handler); },
        error: () => { errors++; },
      };
      (ctor as unknown as (this: unknown, config: McodeAgentNodeConfig) => void).call(instance, { id: "concurrent-close" });
      for (let i = 0; i < 3; i++) {
        handlers.get("input")!({ payload: i }, () => { sends++; },
          (error?: Error) => { if (error === undefined) doneCounts[i]!++; });
      }
      eq("★ close 前真实并行输入都已委托 Host", deferred.length, 3);
      handlers.get("close")!();
      eq("★ close 当场恰好结算三个未完成输入", doneCounts, [1, 1, 1]);
      deferred[0]!.resolve({ text: "late-0", artifacts: [] });
      deferred[1]!.reject(new Error("late-1"));
      // The third deliberately never returns; Node-RED must still finish it.
      await new Promise<void>((resolve) => setImmediate(resolve));
      eq("★ Host 迟到成功/失败都不得重复调用已完成回调", doneCounts, [1, 1, 1]);
      eq("★ close 后不转发任何旧消息", sends, 0);
      eq("★ close 后不报告旧实例错误", errors, 0);
    }

    // A closed node must not start a NEW Host RPC if the old input callback fires.
    {
      let ctor!: Registered["ctor"];
      let hostCalls = 0;
      const handlers = new Map<string, (...args: any[]) => void>();
      registerMcodeAgentNodes({
        nodes: { registerType: (_name, value) => { ctor = value as Registered["ctor"]; }, createNode: () => {} },
      }, () => ({ run: async () => { hostCalls++; return { text: "unexpected", artifacts: [] }; } }));
      const node = { on: (event: string, fn: (...args: any[]) => void) => { handlers.set(event, fn); }, error: () => {} };
      (ctor as unknown as (this: unknown, config: McodeAgentNodeConfig) => void).call(node, { id: "closed-before-input" });
      let sends = 0;
      let dones = 0;
      handlers.get("close")!();
      handlers.get("input")!({ payload: "late" }, () => { sends++; }, (error?: Error) => {
        if (error?.message.includes("关闭")) dones++;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      eq("★ close 后的 input 禁止再启动 Host RPC", hostCalls, 0);
      eq("★ close 后 input 不输出", sends, 0);
      eq("★ close 后 input 必须以一次 done 结束而不是悬挂", dones, 1);
    }

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
    check("★ 原生 Agent 长指令必须能在 textarea 中多行编辑（不裁掉换行）",
      html.includes('<textarea id="node-input-instruction"')
        && !html.includes('<input type="text" id="node-input-instruction"'));
  }
})();

/* ══════════ B. 纯逻辑：其余 6 种节点（runXNode 输入/输出形状） ══════════ */
console.log("\nB. 纯逻辑：conversation / branch / trigger / code / module-capability / node-red-call");
{
  const {
    MCODE_NODE_PACK_TYPES,
    MCODE_INTERNAL_NODE_TYPES,
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
  // palette 类型 = 用户可以拖进画布的；`mcode-node-red-call` 已退役到内部清单
  // （见 `MCODE_INTERNAL_NODE_TYPES` 的说明：不给 category = 不进 palette，但
  // 仍完整注册，旧图照常读、照常跑）。这里钉的是 **palette** 那一份。
  eq("★ 节点包 palette 类型 = 5（agent + branch + conversation + module-capability + trigger）", [...MCODE_NODE_PACK_TYPES].sort(), [
    "mcode-agent", "mcode-branch", "mcode-conversation",
    "mcode-module-capability", "mcode-trigger",
  ]);
  // 正控：退役的内部类型**仍在**注册表里。没有这条，"从 palette 移除"就可能悄悄
  // 变成"从注册表移除" —— 那会让旧图里的这种节点变成 unknown，迁移器拒绝整张图。
  eq("★ 内部类型仍完整注册（退役 ≠ 删除）", [...MCODE_INTERNAL_NODE_TYPES].sort(), [
    "mcode-condition-eval", "mcode-node-red-call",
  ]);

  // ★【T96】子进程加载的是预编译的 nodePackBundle.generated.ts，**不是**上面这些
  // TS 源。改了源却没重新生成 bundle 时，节点包跑的是旧快照，而所有行为断言都
  // 还在验旧代码 —— 它们会全绿。实测踩过：变异 mcodeNodeTypes.ts 的 trigger
  // mcode 重建后整套仍 54/54 绿，直到跑了 build/build-node-pack.cjs 才红。
  //
  // 判据：bundle 里注册的类型清单必须和源导出的清单一致。抓的是「加了/删了
  // 类型却忘了重建」；抓不到纯行为漂移（那类由真引擎段的下游证据覆盖）。
  {
    const { MCODE_NODE_PACK_BUNDLE } = await import("@main/workflowEngines/nodePackBundle.generated.js");
    // bundle 是 CJS 字符串，常量被 esbuild 内联；把 **bundle 里每个 `X_NODE_TYPE = "..."`
    // 的实际字面量** 抽出来，和当前源里的同名常量比。只比名字不够 —— 改名、改值
    // 都只体现在等号右边。
    const literalInBundle = new Map<string, string>();
    for (const m of MCODE_NODE_PACK_BUNDLE.matchAll(/(MCODE_[A-Z_]+_NODE_TYPE) = "([^"]+)"/g)) {
      literalInBundle.set(m[1]!, m[2]!);
    }
    const sourceConsts = new Map<string, string>();
    for (const m of readFileSync(join(process.cwd(), "src/main/workflowEngines/mcodeNodeTypes.ts"), "utf8")
      .matchAll(/(MCODE_[A-Z_]+_NODE_TYPE) = "([^"]+)"/g)) {
      sourceConsts.set(m[1]!, m[2]!);
    }
    const mismatched = [...sourceConsts].filter(([name, literal]) => literalInBundle.get(name) !== literal)
      .map(([name, literal]) => ({ name, source: literal, bundle: literalInBundle.get(name) ?? "(缺失)" }));
    eq("★【T96】bundle 里每个节点类型的值与源一致（改了源要跑 build-node-pack.cjs）",
      mismatched, []);
    // 清单本身：bundle 注册的类型集合 = 源导出的类型集合。
    const bundledList = MCODE_NODE_PACK_BUNDLE.match(/var MCODE_NODE_PACK_TYPES = \[([\s\S]*?)\];/);
    const bundledSymbols = (bundledList?.[1] ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
    eq("★【T96】bundle 注册的类型清单条目数与源一致",
      bundledSymbols.length, MCODE_NODE_PACK_TYPES.length);
    // 反向：bundle 里必须真的带着 IPC 传输层，否则节点在真引擎里根本调不到 Host。
    check("★【T96】bundle 里带着 mcode-node-request 传输层",
      MCODE_NODE_PACK_BUNDLE.includes('"mcode-node-request"'));

    /* 【EXT-07】子进程包**不许**拖进宿主那一片。
     *
     * 实测事故：`mcodeNodeTypes.ts` 从 `@contracts/outputConstraint` import 一个常量，
     * esbuild 就把 zod + 整片 contracts（含 `nodeType.ts` 里提到 `RuntimeManager` 的注释）
     * 全打进这个**没有 electron、没有 sql.js** 的子进程包 —— 29 KB → 245 KB。
     * 那条路径在真引擎里会在加载期炸，而类型检查与大部分断言都是绿的。
     *
     * 判据用**体积上限**而不是"某个字符串不存在"：字符串黑名单只能挡住已知的几个名字，
     * 而体积是"有没有整片被拖进来"的直接量。 */
    check("★【EXT-07】standalone CJS 没拖进宿主依赖图（体积 < 120 KB）",
      Buffer.byteLength(MCODE_NODE_PACK_BUNDLE, "utf8") < 120_000,
      Buffer.byteLength(MCODE_NODE_PACK_BUNDLE, "utf8"));
  }

  /* 【EXT-07】`mcodeNodeTypes.ts` 故意把「出路」这个键名**本地写死**（不 import），
   * 为的是不把 zod / contracts 拖进子进程包（见那里的注释）。代价是两处可能漂移 ——
   * 那就得有一条断言钉住它们**是同一个字符串**，否则「分支写出路、下游读不到」只会
   * 等到运行期才暴露。 */
  {
    const { DECIDE_VAR_NAME } = await import("@contracts/outputConstraint");
    const source = readFileSync(join(process.cwd(), "src/main/workflowEngines/mcodeNodeTypes.ts"), "utf8");
    const local = source.match(/const DECIDE_VAR_NAME = "([^"]*)"/);
    eq("★【EXT-07】mcodeNodeTypes 的本地「出路」与 contracts 常量一致",
      local?.[1], DECIDE_VAR_NAME);
  }
  eq("★ HTML 覆盖全部 6 个类型", ["mcode-agent", "mcode-conversation", "mcode-branch", "mcode-trigger", "mcode-module-capability", "mcode-node-red-call"]
    .filter((t) => !allNodeHtml().includes(`data-template-name="${t}"`)), []);
  check("★ 节点统一：mcode-code 已删除（JS→内置 function，其它语言→exec）",
    !(MCODE_NODE_PACK_TYPES as readonly string[]).includes("mcode-code")
    && !allNodeHtml().includes('data-template-name="mcode-code"'));

  // FULL-2 original Node-RED editor is authoritative for all five thin
  // custom Node adapters, not just mcode-agent. Legacy migration params are
  // only a fallback when the user has never edited a native field.
  {
    const branchPayload: { current: {decider?:unknown,params?:Record<string,unknown>} | null }={current:null};
    const branchConfig={...cfg({decider:"user",outputVar:"legacy"},[["left"],["right"]]),
      decider:"model", outputVar:"native-output"};
    await runBranchNode({},branchConfig,{
      decide:async (p)=>{branchPayload.current=p;return {port:0};},
    });
    eq("★ 原生画布 branch.decider 更新覆盖旧用户分支",branchPayload.current?.decider,"model");
    eq("★ Host branch.params 不含旧决策字段",branchPayload.current?.params?.["decider"],"model");

    const eventConfig={...cfg({triggerKind:"file",task:"old-job",cron:"old-cron"}),
      triggerKind:"event",task:"native-job",cron:"native-cron"};
    const nativeTrigger=triggerSubscribePayload(eventConfig);
    eq("★ 原生画布 triggerKind 更新覆盖旧 sidecar",nativeTrigger.triggerKind,"event");
    eq("★ Host trigger task 使用画布当前值",nativeTrigger.params["task"],"native-job");
    eq("★ Host trigger cron 使用画布当前值",nativeTrigger.params["cron"],"native-cron");

    const modulePayload: {current: {moduleId?:unknown,contributionId?:unknown,path?:unknown}|null}={current:null};
    await runModuleCapabilityNode({}, {...cfg({moduleId:"old.module",contributionId:"old",path:"old.txt"}),
      moduleId:"new.module",contributionId:"edited",path:"new.txt"}, {
      run:async p=>{modulePayload.current=p;return {text:"ok",artifacts:[]};},
    });
    /* 【EXT-07】扩展坐标同样要回读 —— 用户在原厂表单里填的扩展/命令 id 只有
     * 经过这一步才进得了 `effectiveParams`，而执行端只认它们。 */
    const extPayload: {current: {extensionId?:unknown,commandId?:unknown}|null}={current:null};
    await runModuleCapabilityNode({}, {...cfg({extensionId:"old.ext",commandId:"old.cmd"}),
      extensionId:"pub.native",commandId:"pub.native.run"}, {
      run:async p=>{extPayload.current=p;return {text:"ok",artifacts:[]};},
    });
    eq("★【EXT-07】原生画布 extensionId 更新对 Host 实际生效",extPayload.current?.extensionId,"pub.native");
    eq("★【EXT-07】原生画布 commandId 更新对 Host 实际生效",extPayload.current?.commandId,"pub.native.run");
    eq("★ 原生画布 moduleId 更新对 Host 实际生效",modulePayload.current?.moduleId,"new.module");
    eq("★ 原生画布 contributionId 更新对 Host 实际生效",modulePayload.current?.contributionId,"edited");
    eq("★ 原生画布 path 更新对 Host 实际生效",modulePayload.current?.path,"new.txt");

    const callPayload: {current: {enginePath?:unknown,engineMethod?:unknown,engineBody?:unknown}|null}={current:null};
    await runNodeRedCallNode({}, {...cfg({enginePath:"/old",engineMethod:"GET",engineBody:"old"}),
      enginePath:"/native",engineMethod:"POST",engineBody:'{"ok":true}'}, {
      run:async p=>{callPayload.current=p;return {text:"ok",artifacts:[]};},
    });
    eq("★ 原生画布 enginePath 更新对 Host 实际生效",callPayload.current?.enginePath,"/native");
    eq("★ 原生画布 engineMethod 更新对 Host 实际生效",callPayload.current?.engineMethod,"POST");
    eq("★ 原生画布 engineBody 更新对 Host 实际生效",callPayload.current?.engineBody,'{"ok":true}');

    const cleared=normalizeAgentConfig({...cfg({moduleId:"old",engineBody:"old",
      triggerKind:"file"}),moduleId:"",engineBody:"",triggerKind:""});
    eq("★ 原生画布清空字段不能复活旧 moduleId",cleared.params["moduleId"],"");
    eq("★ 原生画布清空字段不能复活旧请求 body",cleared.params["engineBody"],"");
    eq("★ 原生画布清空字段不能复活旧 triggerKind",cleared.params["triggerKind"],"");
  }

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
    // 安全旧反例：任意上游可伪造 msg.mcode.branchPort=2，不能替代 Host 的决定。
    let decideAsked = 0;
    const manual = await runBranchNode({ payload: "保持", mcode: { branchPort: 2 } }, cfg({ decider: "user" }, wires), {
      decide: async () => { decideAsked++; return { port: 0 }; },
    });
    eq("★ branch：未经 Host port.decide 的上游 branchPort 不得优先", manual.port, 0);
    eq("★ branch：上游带选择也必须问宿主 port", decideAsked, 1);
    eq("★ branch：上游 payload 原样保留", manual.msg.payload, "保持");
    eq("★ branch：未授权 branchPort 不得传往下一节点", (manual.msg.mcode as { branchPort?: unknown }).branchPort, undefined);
    // 伪造选择与标签不得泄漏下游；拒绝宿主决定时不能借用上游值继续走。
    eq("★ branch：上游 branchLabel 不得当作可信标签", (await runBranchNode({ mcode: { branchLabel: "spoof" } }, cfg({}, wires), { decide: async () => ({ port: 1 }) })).label, undefined);
    let denied: unknown;
    try { await runBranchNode({ mcode: { branchPort: 1 } }, cfg({ decider: "user" }, wires), { decide: async () => { throw Error("host-denied"); } }); }
    catch (error) { denied = error; }
    check("★ branch：宿主拒绝时上游无法指定出口绕过", denied instanceof Error && denied.message === "host-denied");
    // port 决定 + 越界拒绝
    const byPort = await runBranchNode({ payload: 1 }, cfg({ decider: "model" }, wires), {
      decide: async (p) => ({ port: p.portCount - 1, label: "最后一条" }),
    });
    eq("★ branch：port 决定落在端口范围内", byPort.port, 2);
    // 分支注释现在带**身份**（源/目标节点），下游只认「指向自己」的那条
    // （见 `branchContext.ts`）。断言要钉的是"label 与 port 对应正确"，
    // 不是"形状恰好是这两个键"—— 后者会在加字段时无辜变红。
    {
      const branch = (byPort.msg.mcode as { branch?: Record<string, unknown> }).branch;
      eq("★ branch：label 进 msg.mcode.branch", branch?.label, "最后一条");
      eq("★ branch：port 一并带上", branch?.port, 2);
    }
    let invalidPortError: unknown;
    try { await runBranchNode({}, cfg({}, wires), { decide: async () => ({ port: 99 }) }); }
    catch (err) { invalidPortError = err; }
    check("★ branch：越界 port 必须抛错，禁止静默切到第一支",
      invalidPortError instanceof Error && invalidPortError.message.includes("端口"), String(invalidPortError));
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

  // ARC-006: the Host RPC boundary is shared by all custom Node-RED node
  // types, not only mcode-agent. Malformed results must fail before send().
  {
    const badResults = [
      { text: 42, artifacts: [] },
      { text: "ok", artifacts: null },
      { text: "ok", artifacts: [{ kind: "file" }] },
    ];
    for (const invalid of badResults) {
      for (const [type, invoke] of [
        ["conversation", () => runConversationNode({}, cfg({instruction: "safe"}), { run: async () => invalid as never })],
        ["module-capability", () => runModuleCapabilityNode({}, cfg({moduleId: "test"}), { run: async () => invalid as never })],
        ["node-red-call", () => runNodeRedCallNode({}, cfg({enginePath: "/ok"}), { run: async () => invalid as never })],
      ] as const) {
        let denied = false;
        try { await invoke(); } catch (err) {
          denied = err instanceof Error && /invalid|结果|artifacts|text/.test(err.message);
        }
        check("★ " + type + " rejects malformed Host RPC output, never successful downstream payload", denied, {type, invalid});
      }
    }
    for (const malformed of [{ text: "ok", artifacts: [], status: "200" }, { text: "ok", artifacts: [], status: -1 }]) {
      let denied = false;
      try { await runNodeRedCallNode({}, cfg({enginePath: "/ok"}), {run: async () => malformed as never}); }
      catch (err) { denied = err instanceof Error && /invalid|status/.test(err.message); }
      check("★ node-red-call rejects untrusted invalid HTTP status", denied, malformed);
    }
    let badLabelDenied = false;
    try { await runBranchNode({}, cfg({}, [["x"]]), {decide: async () => ({port: 0, label: 42} as never)}); }
    catch (err) { badLabelDenied = err instanceof Error && /label|invalid|无效/.test(err.message); }
    check("★ branch denies non-string Host choice label", badLabelDenied);
  }

  // Upstream msg.mcode is untrusted. If Host node-red-call does not return
  // an HTTP status, forwarding a previously spoofed engineStatus is misleading.
  {
    const incoming = { payload: "request", mcode: { engineStatus: 200, note: "keep" } };
    const out = await runNodeRedCallNode(incoming, cfg({enginePath:"/api"}), {
      run: async () => ({ text: "actual body", artifacts: [] }),
    });
    const meta = out.msg.mcode as Record<string, unknown>;
    check("★ stale upstream HTTP status is not inherited as trusted Host result",
      !Object.hasOwn(meta, "engineStatus"), meta);
    check("★ unrelated metadata preserved on Host result output", meta.note === "keep", meta);
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
  const { ProductionWorkflowEngineRegistry, OwnedNodeRedRuntime } = await import("@main/workflowEngines/registry.js");
  const { createInMemoryExecutorOwnership } = await import("@main/workflowEngines/executorOwnership.js");
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
      { id: "k_agent", type: "mcode.agent", title: "子 agent", params: { instruction: "查资料", sessionId: "s_pack_fixture" }, position: { x: 210, y: 10 } },
      { id: "k_branch", type: "mcode.branch", title: "岔路", params: { decider: "user" }, position: { x: 310, y: 10 } },
      { id: "k_cond", type: "mcode.condition", title: "条件", params: { expression: { logic: "and", rules: [] } }, position: { x: 410, y: 10 } },
      { id: "k_code", type: "mcode.code", title: "代码", params: { code: "print(1)", language: "python" }, position: { x: 510, y: 10 } },
      { id: "k_module", type: "mcode.module-capability", title: "模块", params: { extensionId: "mcode.core", commandId: "mcode.core.fileReport", moduleId: "core.file-report", contributionId: "inspect", path: "a.txt" }, position: { x: 610, y: 10 } },
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
  // 库必须在真引擎跑起来**之前**就绪（见上面 initDb 的说明）。
  await initDb();
  /* 【图必须在库里】`conditionHostPorts` 派发 `module.invoke` 时要向库要这张图，
   * 从它的上游 agent/对话节点推出**授权工作区**（产品设计：模块调用不能凭节点参数
   * 自己声明目录）。本套的图是内存夹具，不写库就得到
   * 「宿主工作流库里没有「wf_all_kinds」」，而症状是该 kind 一次都不出现在 port
   * 调用里 —— 看起来像"节点没被派发"。
   *
   * ⚠️ 必须在 `await initDb()` **之后**：`WorkflowRepo.get/save` 都要真库。 */
  {
    if (WorkflowRepo.get("wf_all_kinds") === null) WorkflowRepo.save(doc as never);
    // 自检走**生产那条读路径**（`getWorkflow` = `WorkflowRepo.get(id)?.doc`），
    // 而不是直接读 repo —— 要验的正是"节点派发时能读到这张图"。
    const after = getWorkflow("wf_all_kinds");
    if (after === null) {
      throw new Error("夹具自检失败：wf_all_kinds 写库之后仍读不到（module 节点会因此被拒）");
    }
    if (after.nodes.length !== doc.nodes.length) {
      throw new Error("夹具自检失败：写库后的节点数与内存图不一致");
    }
  }

  /* 【EXT-07】**扩展命令节点需要一条授权工作区**，而那条工作区是从**上游**的
   * agent/对话节点绑定的会话 → 项目推出来的（见 `conditionHostPorts` 的
   * `workflowProjectPathForNode`）。这是产品设计：模块调用必须落在一个用户授权过
   * 的目录里，不能凭节点参数自己声明。
   *
   * 少了这套夹具，节点会在派发时抛「无法从上游 agent/对话节点确定工作区」，
   * 而症状是**该 kind 一次都没出现在 port 调用里** —— 看起来像"节点没被派发到"。
   */
  const packProjectId = "p_pack_fixture";
  if (ProjectRepo.get(packProjectId) === undefined) {
    const now = Date.now();
    ProjectRepo.create({
      id: packProjectId, name: "节点包夹具项目", path: userDir,
      archived: false, group: null, sortOrder: 0, pinnedAt: null, createdAt: now, updatedAt: now,
    });
  }
  const packSessionId = "s_pack_fixture";
  if (SessionRepo.get(packSessionId) === undefined) {
    const now = Date.now();
    SessionRepo.create({
      id: packSessionId, projectId: packProjectId,
      providerId: "claude-sdk", claudeSessionId: null,
      kind: "chat", parentSessionId: null, nodeId: null,
      title: "节点包夹具会话", status: "idle", model: "", effort: "default",
      permissionMode: "default", workflowId: "default", customModelId: null,
      envMode: "local", worktreePath: null, archived: false, pinnedAt: null,
      contextSnapshot: null, todos: null, subagents: null, planDraft: null,
      turnFiles: null, usageHistory: null, bookmarks: null, subagentTranscripts: null,
      createdAt: now, updatedAt: now,
    });
  }

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
    "      trigger: { subscribe(p, emit) { rec('trigger', p); const timer = setTimeout(function () { emit({ payload: { trigger: { kind: p.triggerKind, at: 1 } }, mcode: { nodeId: p.nodeId, runId: null, condition: true } }); }, 150); return function () { clearTimeout(timer); }; } },",
    "",
    "      moduleCapability: { async run(p) { rec('module-capability', p); return { text: 'module:' + p.moduleId, artifacts: artifact }; } },",
    "      nodeRedCall: { async run(p) { rec('node-red-call', p); return { text: 'nr:' + p.enginePath, artifacts: artifact, status: 200 }; } },",
    "    };",
    "  });",
    "};",
    "",
  ].join("\n");
  // T42: the production registry now installs six managed node sets itself.
  // Do not install the historical all-types fake CJS alongside them: duplicate
  // registration would shadow the actual IPC transport and disable the flow.
  void runnerJs;
  void allNodeHtml;

  const registry = new ProductionWorkflowEngineRegistry();
  const registryDataDir = registry.dataDirOf("node-red");
  eq("★ 生产注册表的引擎数据目录 = 本套私有 dataRoot（不是共享安装树）",
    registryDataDir, privateEngineDir);
  writeFileSync(join(registryDataDir, "engine-trust.json"), JSON.stringify({ trusted: true }), "utf8");
  const launch = registry.launchSpec("node-red");
  check("★ 生产 launchSpec 可用", launch !== null);

  if (launch !== null) {
    const tailBox: { get: (() => string) | null } = { get: null };
    const nativeChildMessages: Record<string, unknown>[] = [];
    const nativeBoardEvents: Record<string, unknown>[] = [];
    const ports = {
      ...defaultEngineRuntimePorts,
      spawn: (spec: Parameters<typeof defaultEngineRuntimePorts.spawn>[0]) => {
        const child = defaultEngineRuntimePorts.spawn(spec);
        tailBox.get = () => child.tailOutput();
        const receive = child.onMessage?.bind(child);
        child.onMessage = (listener) => receive?.((message) => {
          if (message && typeof message === "object"
            && String((message as Record<string, unknown>)["kind"]).startsWith("mcode-native-node-")) {
            nativeChildMessages.push(message as Record<string, unknown>);
          }
          listener(message);
        });
        return child;
      },
    };
    const nativeOwnership = createInMemoryExecutorOwnership();
    // Keep the old exercise's deterministic fake outputs, but inject them at
    // the REAL parent-side NodePackHost (the child always uses process.send).
    const hostServices = {
      execute: async (operation: string, payload: Record<string, unknown>) => {
        const kind = ({
          "agent.run": "agent", "conversation.run": "conversation",
          "branch.decide": "branch", "module.invoke": "module-capability",
          "node-red.call": "node-red-call",
        } as Record<string, string>)[operation] ?? operation;
        appendFileSync(join(userDir, "node-runs.jsonl"), JSON.stringify({ kind, payload }) + "\n");
        const artifacts = [{ kind: "file", uri: "file:///tmp/mcode-node-output.txt", mimeType: "text/plain" }];
        if (operation === "branch.decide") return { port: 0, label: "继续" };
        if (operation === "agent.run") return { text: "agent:" + payload.instruction, artifacts, runId: "run_all_1" };
        if (operation === "conversation.run") return { text: "conv:" + payload.instruction, artifacts };
        if (operation === "module.invoke") return { text: "module:" + payload.moduleId, artifacts };
        return { text: "nr:" + payload.enginePath, artifacts, status: 200 };
      },
      subscribe: (payload: Record<string, unknown>, emit: (msg: Record<string, unknown>) => void) => {
        appendFileSync(join(userDir, "node-runs.jsonl"), JSON.stringify({ kind: "trigger", payload }) + "\n");
        const timer = setTimeout(() => emit({
          payload: { trigger: { kind: payload.triggerKind, at: 1 } },
          mcode: { condition: true },
        }), 150);
        return () => clearTimeout(timer);
      },
    };
    /* 【不传 `lookupDoc`】**生产里它就是 `undefined`**（回落真库 `getWorkflow`），
     * 所以这里也保持不传 —— 传一个内存替身会让 `assertNativeEngineSelection` 那条
     * 只在"有 lookupDoc"时才跑的校验突然生效，走的是生产从不会走的路（实测在那条
     * 路上 `startDeployMirror` 的空指针会炸）。
     *
     * 图必须**在库里**：`conditionHostPorts` 派发 `module.invoke` 时要向库要它，
     * 用来从上游 agent/对话节点推出授权工作区。见下面 `WorkflowRepo.save`。 */
    const runtime = new OwnedNodeRedRuntime("node-red", ports, nativeOwnership, hostServices,
      undefined, undefined, (event) => nativeBoardEvents.push(event as unknown as Record<string, unknown>));
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
      const zhCatalog = await fetch("http://127.0.0.1:" + port +
        "/locales/mcode-node-pack/mcode-agent?lng=zh-CN", { signal: AbortSignal.timeout(8_000) });
      const zhLabels = (await zhCatalog.json()) as { mcode?: { label?: { instruction?: string } } };
      check("★【T42】真 Node-RED 把受管节点包作为独立模块加载并注册中文 i18n",
        zhCatalog.status === 200 && zhLabels.mcode?.label?.instruction === "指令",
        { status: zhCatalog.status, zhLabels });
      // T79: test every real upstream locale endpoint, not just one static file.
      const localizedFiles = expectedNodePackFiles();
      for (const language of ["en-US", "zh-CN"] as const) {
        for (const type of MCODE_NODE_PACK_TYPES) {
          const expected = JSON.parse(localizedFiles["locales/" + language + "/" + type + ".json"]!) as {
            mcode: Record<string, Record<string, string>>;
          };
          const response = await fetch("http://127.0.0.1:" + port +
            "/locales/mcode-node-pack/" + type + "?lng=" + language,
            { signal: AbortSignal.timeout(8_000) });
          const actual = await response.json() as { mcode?: Record<string, Record<string, string>> };
          const mismatch = Object.entries(expected.mcode).flatMap(([section, entries]) =>
            Object.entries(entries).filter(([key, value]) =>
              actual.mcode?.[section]?.[key] !== value)
              .map(([key]) => section + "." + key));
          check("★【T79】真 Node-RED HTTP locale " + type + " " + language + " 全字段一致",
            response.status === 200 && mismatch.length === 0,
            { status: response.status, mismatch });
        }
      }
      const htmlRes = await fetch(`http://127.0.0.1:${port}/nodes`, {
        headers: { ...auth, accept: "text/html" }, signal: AbortSignal.timeout(8_000),
      });
      const paletteHtml = await htmlRes.text();
      /* 【T42 + EXT-07】判据按**类型清单**，不按魔法数字。
       *
       * 从前这里写 `>= 6`：那时 `mcode-node-red-call` 还在 palette 里。它退役到
       * `MCODE_INTERNAL_NODE_TYPES`（不给 category，用户拖不到新的，但**仍完整注册**
       * ——旧图要能读能跑）之后，palette 类型变 5 个、而 HTML 模板仍是 7 个
       * （5 palette + 2 内部）。所以：
       *   - **每个已注册类型都要有模板**（内部节点也要，否则旧图在编辑器里变 unknown）；
       *   - **palette 类型要带 category**，内部类型**不许**带 —— 否则用户能拖到不该拖的。
       * 三条一起，才既不误伤退役又不放过漏注册。 */
      /** 内部类型清单（`mcode-node-red-call` / `mcode-condition-eval`）——
       *  必须在**这个作用域**里再 import 一次：上面那段 IIFE 里的同名绑定到 600 行就结束了。 */
      const { MCODE_INTERNAL_NODE_TYPES: internalTypes } =
        await import("@main/workflowEngines/mcodeNodeTypes.js");
      const paletteHtmlTemplates = (type: string): boolean =>
        paletteHtml.includes(`data-template-name="${type}"`);
      const missingTemplates = [
        ...MCODE_NODE_PACK_TYPES, ...internalTypes,
      ].filter((type) => !paletteHtmlTemplates(type));
      check("★【T42】真 Node-RED 编辑器为**每个已注册类型**返回节点表单",
        htmlRes.status === 200 && missingTemplates.length === 0, { status: htmlRes.status, missingTemplates });
      check("★【T42】palette 分组的图标数覆盖全部 palette 类型",
        (paletteHtml.match(/category: "mcode"/g) ?? []).length >= MCODE_NODE_PACK_TYPES.length
        && (paletteHtml.match(/icon: "font-awesome\//g) ?? []).length >= MCODE_NODE_PACK_TYPES.length,
        {
          status: htmlRes.status,
          palettes: (paletteHtml.match(/category: "mcode"/g) ?? []).length,
          icons: (paletteHtml.match(/icon: "font-awesome\//g) ?? []).length,
          expected: MCODE_NODE_PACK_TYPES.length,
          templateCount: (paletteHtml.match(/data-template-name="mcode-/g) ?? []).length,
        });


      // ② 部署整张迁移流 + 一条原生 HTTP-in 活体探针（同一份部署）。
      const probeTab = { id: "tab_probe_all", type: "tab", label: "probe", disabled: false, info: "", env: [] };
      const probeIn = { id: "in_probe_all", type: "http in", z: "tab_probe_all", url: "/all-kinds", method: "get", upload: false, swaggerDoc: "", x: 100, y: 900, wires: [["out_probe_all"]] };
      const probeOut = { id: "out_probe_all", type: "http response", z: "tab_probe_all", x: 300, y: 900, wires: [] };
      const deployFlows = [...migrated.flow.nodes, probeTab, probeIn, probeOut];
      // Gate D REAL Node-RED: an authenticated Admin deploy cannot skip the
      // parent ownership barrier, yet ordinary deploy works after release.
      check("★ Gate D: legacy mcode owner reserves doc before native Admin deploy",
        nativeOwnership.claim(doc.id, "mcode").ok);
      const deniedDeploy = await fetch(`http://127.0.0.1:${port}/flows`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json", "Node-RED-Deployment-Type": "full", "Node-RED-API-Version": "v2" },
        body: JSON.stringify({ flows: deployFlows }),
        signal: AbortSignal.timeout(15_000),
      });
      check("★ Gate D: REAL authenticated Node-RED HTTP deploy rejects conflicting owner (423)",
        deniedDeploy.status === 423, { status: deniedDeploy.status, text: await deniedDeploy.text() });
      check("★ Gate D: rejected deploy retains legacy owner (no stealing)",
        nativeOwnership.executorOwnerOf(doc.id) === "mcode");
      check("★ Gate D: legacy owner can release before real native deploy",
        nativeOwnership.release(doc.id, "mcode").ok);
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
      if (probeStatus !== 200 || process.env.MCODE_DUMP_TAIL === "1") {
        console.log("  [evidence] engine tail:", (tailBox.get === null ? "(no child)" : tailBox.get()).slice(-4000));
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
      /* 【EXT-07】这个节点的执行坐标换成了扩展命令（`extensionId` + `commandId`）；
       * 旧的 `moduleId`/`contributionId` 在执行端被**显式拒绝**（旧坐标已不再支持）。
       * 判据跟着走新坐标，同时保留一条「旧字段仍被带过去」的正控 —— 参数声明里
       * 它们还在（旧图要能读），只是不再驱动执行。 */
      check("★【MERGE-2】module-capability 收到扩展命令坐标",
        byKind("module-capability")?.extensionId === "mcode.core"
          && byKind("module-capability")?.commandId === "mcode.core.fileReport",
        byKind("module-capability"));
      check("★【MERGE-2】module-capability 仍带着旧 moduleId（旧图可读）",
        byKind("module-capability")?.moduleId === "core.file-report", byKind("module-capability"));
      check("★【MERGE-2】trigger 收到 triggerKind", byKind("trigger")?.triggerKind === "event", byKind("trigger"));

      // T60: Native runtime hook filter must not send mcode-agent/conversation
      // into the parallel board channel: those nodes already use Host ports.
      const mcodeIds = new Set(migrated.flow.nodes.filter((n) => String(n.type).startsWith("mcode-"))
        .map((n) => n.id));
      check("★【T60】Mcode 节点没有经原生 hooks 二次发看板阶段事件",
        !nativeChildMessages.some((m) => mcodeIds.has(String(m["nodeId"]))),
        nativeChildMessages.filter((m) => mcodeIds.has(String(m["nodeId"]))).slice(0, 4));

      // FULL-2 API-level native editor round trip on an actual Node-RED 5.x
      // runtime. This exercises the same /flows serialization the upstream
      // editor uses (not a claim of clicked Electron GUI/U1).
      const nativeRead = await fetch(`http://127.0.0.1:${port}/flows`, {
        headers: { ...auth, "Node-RED-API-Version": "v2", accept: "application/json" },
        signal: AbortSignal.timeout(8_000),
      });
      const nativeBody = await nativeRead.json() as { flows?: Record<string, unknown>[]; rev?: string } | Record<string, unknown>[];
      const nativeNodes = Array.isArray(nativeBody) ? nativeBody : (nativeBody.flows ?? []);
      const editorRev = Array.isArray(nativeBody) ? null : nativeBody.rev;
      check("★【FULL-2】原生 Node-RED v2 /flows 提供可用于冲突检测的 revision",
        typeof editorRev === "string" && editorRev.length > 0, editorRev);
      const storedAgent = nativeNodes.find((n) => n.type === "mcode-agent") as Record<string, unknown> | undefined;
      check("★【FULL-2】真 Node-RED GET /flows 读回原生 mcode-agent 配置",
        nativeRead.status === 200 && storedAgent !== undefined, { status: nativeRead.status, count: nativeNodes.length });
      if (storedAgent !== undefined) {
        const multiLineInstruction = "原生编辑新指令\n第二行：保留换行";
        const editedFlows = nativeNodes.map((n) => n.id === storedAgent.id
          ? { ...n, instruction: multiLineInstruction, capability: "read", outputVar: "nativeResult",
              "x-mcode": {
                ...(n["x-mcode"] as Record<string, unknown> ?? {}),
                params: { ...((n["x-mcode"] as { params?: Record<string, unknown> } | undefined)?.params ?? {}),
                  instruction: "陈旧迁移指令", capability: "write", outputVar: "oldResult" },
              } }
          : n);
        try { rmSync(join(userDir, "node-runs.jsonl"), { force: true }); } catch { /* already absent */ }
        const editedDeploy = await fetch(`http://127.0.0.1:${port}/flows`, {
          method: "POST",
          headers: { ...auth, "content-type": "application/json",
            "Node-RED-Deployment-Type": "full", "Node-RED-API-Version": "v2" },
          body: JSON.stringify({ rev: editorRev, flows: editedFlows }),
          signal: AbortSignal.timeout(15_000),
        });
        check("★【FULL-2】真 Node-RED 接受编辑器表单字段与旧 sidecar 并存的部署",
          editedDeploy.status === 200, editedDeploy.status);
        const afterEditRead = await fetch(`http://127.0.0.1:${port}/flows`, {
          headers: { ...auth, "Node-RED-API-Version": "v2", accept: "application/json" },
          signal: AbortSignal.timeout(8_000),
        });
        const afterEditBody = await afterEditRead.json() as { flows?: Record<string, unknown>[] } | Record<string, unknown>[];
        const afterEditNodes = Array.isArray(afterEditBody) ? afterEditBody : (afterEditBody.flows ?? []);
        const afterEditAgent = afterEditNodes.find((n) => n.id === storedAgent.id);
        check("★【FULL-2】原生 Node-RED 读回保存的新 instruction/capability/outputVar",
          afterEditRead.status === 200 && afterEditAgent?.instruction === multiLineInstruction
            && afterEditAgent?.capability === "read" && afterEditAgent?.outputVar === "nativeResult",
          afterEditAgent);
        if (typeof editorRev === "string" && editorRev.length > 0 && editedDeploy.status === 200) {
          const staleFlows = editedFlows.map((n) => n.id === storedAgent.id
            ? { ...n, instruction: "不应覆盖的新旧冲突值" } : n);
          const staleDeploy = await fetch(`http://127.0.0.1:${port}/flows`, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json",
              "Node-RED-Deployment-Type": "full", "Node-RED-API-Version": "v2" },
            body: JSON.stringify({ rev: editorRev, flows: staleFlows }),
            signal: AbortSignal.timeout(15_000),
          });
          check("★【FULL-2】原生 Node-RED 旧 revision 写入冲突拒绝，不静默覆盖",
            staleDeploy.status === 409, staleDeploy.status);
          const afterConflict = await fetch(`http://127.0.0.1:${port}/flows`, {
            headers: { ...auth, "Node-RED-API-Version": "v2", accept: "application/json" },
            signal: AbortSignal.timeout(8_000),
          });
          const afterConflictBody = await afterConflict.json() as { flows?: Record<string, unknown>[] } | Record<string, unknown>[];
          const keptNodes = Array.isArray(afterConflictBody) ? afterConflictBody : afterConflictBody.flows ?? [];
          check("★【FULL-2】旧 revision 冲突后新指令未被覆写",
            keptNodes.find((n) => n.id === storedAgent.id)?.instruction === multiLineInstruction);
        }
        let postEditCalls: Array<{ kind: string; payload: Record<string, unknown> }> = [];
        const editedDeadline = Date.now() + 10_000;
        while (Date.now() < editedDeadline) {
          try {
            postEditCalls = readFileSync(join(userDir, "node-runs.jsonl"), "utf8")
              .split("\n").filter((s) => s.trim() !== "").map((s) => JSON.parse(s) as { kind: string; payload: Record<string, unknown> });
          } catch { postEditCalls = []; }
          if (postEditCalls.some((c) => c.kind === "agent")) break;
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        const nativeHostAgent = postEditCalls.find((c) => c.kind === "agent")?.payload;
        check("★【FULL-2】真 Node-RED 修改后 Host RPC 优先原生指令而非旧 sidecar",
          nativeHostAgent?.instruction === multiLineInstruction,
          nativeHostAgent);
        check("★【FULL-2】真 Node-RED 修改为 read 后 Host 不复活旧 write",
          nativeHostAgent?.capability === "read" && (nativeHostAgent.params as Record<string, unknown> | undefined)?.capability === "read",
          nativeHostAgent);
      }

      // T60: real upstream inject/debug do not call status() for each input.
      // Verify two visible stages from actual onReceive/onComplete hooks, plus
      // exec's red status, via the *same* production child IPC/Host mapper.
      nativeBoardEvents.length = 0;
      nativeChildMessages.length = 0;
      const nativeTab = "t60_native_tab";
      const nativeDeploy = [
        { id: nativeTab, type: "tab", label: "T60 isolated", disabled: false, info: "", env: [] },
        { id: "t60_inject", type: "inject", z: nativeTab, name: "native inject", props: [{ p: "payload", v: "x", vt: "str" }],
          repeat: "", once: false, x: 100, y: 100, wires: [["t60_debug", "t60_exec"]] },
        { id: "t60_debug", type: "debug", z: nativeTab, name: "native debug", active: true,
          tosidebar: true, complete: "payload", targetType: "msg", x: 240, y: 100, wires: [] },
        { id: "t60_exec", type: "exec", z: nativeTab, name: "native fail", command: "exit 9",
          addpay: false, append: "", useSpawn: "false", x: 240, y: 200, wires: [[], [], []] },
      ];
      const t60DeployResponse = await fetch(`http://127.0.0.1:${port}/flows`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json", "Node-RED-Deployment-Type": "full",
          "Node-RED-API-Version": "v2" },
        body: JSON.stringify({ flows: nativeDeploy }),
        signal: AbortSignal.timeout(15_000),
      });
      check("★【T60】真 Node-RED 原生 inject/debug/exec 已部署（200）",
        t60DeployResponse.status === 200, t60DeployResponse.status);
      // Node-RED's 200 deploy response can precede the new nodes' async
      // start; a 404 during this window is not evidence of a broken hook.
      let injectStatus = 0;
      const injectReadyDeadline = Date.now() + 8000;
      while (Date.now() < injectReadyDeadline) {
        const injected = await fetch(`http://127.0.0.1:${port}/inject/t60_inject`, {
          method: "POST", headers: auth, signal: AbortSignal.timeout(1500),
        }).catch(() => null);
        injectStatus = injected?.status ?? 0;
        if (injectStatus === 200) break;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      check("★【T60】原生 inject API 手动触发一次（200）", injectStatus === 200, injectStatus);
      const telemetryDeadline = Date.now() + 8000;
      while (Date.now() < telemetryDeadline && !["t60_inject", "t60_debug", "t60_exec"].every((id) =>
        nativeBoardEvents.some((event) => event["nodeId"] === id && event["type"] === "workflow.node.result"))) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      for (const nodeId of ["t60_inject", "t60_debug"]) {
        check("★【T60】真实 inject → debug 看板显示 " + nodeId + " 运行及成功收场",
          nativeBoardEvents.some((event) => event["nodeId"] === nodeId && event["type"] === "workflow.node.progress")
          && nativeBoardEvents.some((event) => event["nodeId"] === nodeId && event["type"] === "workflow.node.result"
            && event["status"] === "success"),
          nativeBoardEvents.filter((event) => event["nodeId"] === nodeId));
      }
      check("★【T60】真实 exec 返回非零进程码 → 看板失败（红色）",
        nativeBoardEvents.some((event) => event["nodeId"] === "t60_exec"
          && event["type"] === "workflow.node.result" && event["status"] === "failed"),
        nativeBoardEvents.filter((event) => event["nodeId"] === "t60_exec"));
      check("★【T60】一轮运行每个原生节点仅一条终态事件（不重复计数）",
        ["t60_inject", "t60_debug", "t60_exec"].every((id) =>
          nativeBoardEvents.filter((event) => event["nodeId"] === id
            && event["type"] === "workflow.node.result").length === 1),
        nativeBoardEvents);
      const t60Events = nativeBoardEvents.filter((event) =>
        ["t60_inject", "t60_debug", "t60_exec"].includes(String(event["nodeId"])));
      check("★【T60】宿主仅归属于受信原生 tab，不伪造聊天会话",
        t60Events.length >= 6 && t60Events.every((event) =>
          event["workflowId"] === "@node-red-native:" + nativeTab
          && event["sessionId"] === "@node-red-runboard:@node-red-native:" + nativeTab),
        t60Events);
      console.log("  [T60 probe] native child message histogram:",
        JSON.stringify(nativeChildMessages.reduce<Record<string, number>>((acc, m) => {
          const key = String(m["kind"]) + ":" + String(m["nodeId"]) + ":" + String(m["stage"] ?? m["fill"] ?? "");
          acc[key] = (acc[key] ?? 0) + 1;
          return acc;
        }, {})));
      // The same pure native nodes inside a Mcode-owned tab must be routed
      // into that selected workflow's board, not the standalone tab namespace.
      const taggedDeploy = nativeDeploy.map((node) => node.id === nativeTab
        ? { ...node, "x-mcode": { docId: doc.id } } : node);
      const taggedRes = await fetch(`http://127.0.0.1:${port}/flows`, {
        method: "POST", headers: { ...auth, "content-type": "application/json",
          "Node-RED-Deployment-Type": "full", "Node-RED-API-Version": "v2" },
        body: JSON.stringify({ flows: taggedDeploy }), signal: AbortSignal.timeout(15_000),
      });
      check("★【T60】含原生节点的 Mcode 文档 tab 正常部署", taggedRes.status === 200, taggedRes.status);
      nativeBoardEvents.length = 0;
      const taggedReadyDeadline = Date.now() + 8000;
      let taggedInjected = false;
      while (Date.now() < taggedReadyDeadline) {
        const response = await fetch(`http://127.0.0.1:${port}/inject/t60_inject`, {
          method: "POST", headers: auth, signal: AbortSignal.timeout(1500),
        }).catch(() => null);
        if (response?.status === 200) { taggedInjected = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      const taggedEventsDeadline = Date.now() + 8000;
      while (Date.now() < taggedEventsDeadline && !nativeBoardEvents.some((e) =>
        e["nodeId"] === "t60_debug" && e["type"] === "workflow.node.result")) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      check("★【T60】宿主按已登记的 x-mcode.docId 将原生节点归到选中的工作流看板",
        taggedInjected && nativeBoardEvents.some((e) => e["nodeId"] === "t60_debug"
          && e["type"] === "workflow.node.result" && e["workflowId"] === doc.id
          && e["sessionId"] === "@node-red-runboard:" + doc.id),
        nativeBoardEvents.filter((e) => e["nodeId"] === "t60_debug"));
      const stopped = await runtime.stop(1_000);
      check("★ 真引擎 stop 后状态 stopped、端口清空", stopped.state === "stopped" && stopped.port === null, stopped);
      const restarted = await runtime.start({
        engineId: "node-red",
        dataDir: userDir,
        command: launch.command,
        args: (nextPort, nextDataDir) => launch.args(nextPort, nextDataDir),
        env: { ...(launch.env ?? {}), MCODE_NODE_PACK_USER_DIR: userDir },
        ...(launch.probeIdentity !== undefined ? { probeIdentity: launch.probeIdentity } : {}),
        readyTimeoutMs: 20_000,
      });
      check("★【T42】真 Node-RED 停止再启动成功，受管节点包仍可加载",
        restarted.state === "running" && restarted.port !== null, restarted);
      if (restarted.port !== null) {
        const again = await fetch(`http://127.0.0.1:${restarted.port}/nodes`, {
          headers: { ...auth, accept: "application/json" },
          signal: AbortSignal.timeout(8_000),
        });
        const list = (await again.json()) as Array<{ types?: string[]; err?: unknown }>;
        const typesAgain = new Set(list.flatMap((item) => item.types ?? []));
        check("★【T42】真引擎重启后六节点仍全部存在且加载无错误",
          again.status === 200 && MCODE_NODE_PACK_TYPES.every((type) => typesAgain.has(type))
            && !list.some((entry) => entry.types?.some((type) =>
              (MCODE_NODE_PACK_TYPES as readonly string[]).includes(type)) && entry.err !== undefined),
          { status: again.status, missing: MCODE_NODE_PACK_TYPES.filter((type) => !typesAgain.has(type)) });
      }
      await runtime.stop(1_000);

    } finally {
      try {
        await runtime.stop(1_000);
      } catch {
        /* 已停 */
      }
      try {
        // 【诊断】`MCODE_KEEP_NODE_RUNS=1` 时把真引擎那一轮 port 调用留到 .tmp/ 下：
        // "某个 kind 0 次"这种失败，光看断言输出分不出是"没派发到"还是"派发了但被拒"。
        if (process.env.MCODE_KEEP_NODE_RUNS === "1") {
          cpSync(join(userDir, "node-runs.jsonl"), join(APP_DIR, ".tmp", "node-runs-last.jsonl"), { force: true });
        }
        rmSync(userDir, { recursive: true, force: true });
      } catch {
        /* 清理失败不影响结论 */
      }
    }
  }
}


console.log(`\nmcode-node-pack-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exitCode = 1;
