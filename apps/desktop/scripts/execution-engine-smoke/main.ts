import { ExecutionEngine, createBuiltinExecutionEngine, type ExecutionContext, type NodeExecutor } from "../../src/main/orchestration/executionEngine.js";
import type { NodeOutcome } from "@contracts/nodeType";

const checks: string[] = [];
const ok = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(`FAIL: ${message}`);
  checks.push(message);
};

const context = (kind: string): ExecutionContext => ({
  node: { id: "n1", type: "test.node", title: "Test", params: {}, position: { x: 0, y: 0 } },
  manifest: {
    id: "test.node",
    manifestVersion: 1,
    name: "Test",
    runner: { kind: kind as never },
    capability: "read",
    params: [],
  },
  input: {
    prompt: "hello",
    data: { userInput: "hello", upstreamText: "", upstreamOutputs: {}, upstreamArtifacts: [] },
    skills: [],
    mcpServerNames: [],
    pluginNames: [],
    returnMode: "none",
    signal: new AbortController().signal,
  },
  cwd: ".",
  metadata: { runId: "run_test", sessionId: "session_test", nodeId: "n1" },
});

const engine = new ExecutionEngine();
const executor: NodeExecutor = {
  kind: "test",
  async execute(ctx): Promise<NodeOutcome> {
    ok(ctx.metadata.runId === "run_test", "passes stable run metadata");
    ok(ctx.input.data.userInput === "hello", "passes structured data context");
    return { status: "success", summary: "done" };
  },
};

engine.register(executor);
ok(engine.has("test"), "registry exposes registered executor");
const result = await engine.execute(context("test"));
ok(result.status === "success" && result.summary === "done", "executes registered executor");
ok(result.execution?.executorKind === "test", "records executor kind");
ok((result.execution?.durationMs ?? -1) >= 0, "records execution duration");

let duplicateRejected = false;
try {
  engine.register(executor);
} catch {
  duplicateRejected = true;
}
ok(duplicateRejected, "rejects duplicate executor registration");

const missing = await engine.execute(context("missing"));
ok(missing.status === "failed", "unknown executor fails deterministically");
ok(missing.error === "没有能执行这种节点的执行器:missing", "unknown executor reports its kind (in Chinese, like its sibling node errors)");
ok(missing.execution?.executorKind === "missing", "unknown executor still records metadata");

// —— 兜底执行器:setDefault 之后,注册表没有的 kind 落到它 ——
// 这是"默认怎么跑"(模型轮)进入同一条分派边界的凭据:分派链不需要 kind 分支。
const fallbackEngine = new ExecutionEngine();
const fallbackCalls: string[] = [];
fallbackEngine.setDefault({
  async execute(ctx): Promise<NodeOutcome> {
    fallbackCalls.push(ctx.manifest.runner.kind);
    return { status: "success", summary: `fallback:${ctx.manifest.runner.kind}` };
  },
});
const fell = await fallbackEngine.execute(context("prompt"));
ok(fell.status === "success" && fell.summary === "fallback:prompt", "fallback takes unregistered kinds");
ok(fallbackCalls[0] === "prompt", "fallback receives the requested kind");
ok(fell.execution?.executorKind === "prompt", "fallback still records metadata");
fallbackEngine.register({
  kind: "test",
  async execute(): Promise<NodeOutcome> {
    return { status: "success", summary: "exact" };
  },
});
const exact = await fallbackEngine.execute(context("test"));
ok(exact.summary === "exact", "registered kind wins over fallback");

// —— 内置 code / command 执行器:未配置时那句失败原因必须是中文 ——
// 它画在**失败节点卡片**上(见 runner.ts 的 workflow.node.result),而编排里其它节点错误
// 一律中文。这两处从前写着英文 "Code/Command node is missing execution config",同一件事
// 在 `codeRunner`/`commandRunner` 里却是中文 —— 一处中一处英。
{
  const { CodeExecutor } = await import("../../src/main/orchestration/codeExecutor.js");
  const { CommandExecutor } = await import("../../src/main/orchestration/commandExecutor.js");
  const codeCtx = context("code");
  (codeCtx.input as { code?: unknown }).code = undefined;
  const codeOut = await new CodeExecutor().execute(codeCtx);
  ok(codeOut.status === "failed" && /没有填写/.test(codeOut.error ?? ""), "code 节点未配置 -> 中文失败原因");

  const cmdCtx = context("command");
  (cmdCtx.input as { command?: unknown }).command = undefined;
  const cmdOut = await new CommandExecutor().execute(cmdCtx);
  ok(cmdOut.status === "failed" && /没有填/.test(cmdOut.error ?? ""), "command 节点未配置 -> 中文失败原因");
}

// —— 【MC-075】settle 钩子报错不得翻转已成功的执行 / 不得逃出 ——
// 从前 start/execute/settle 共用一个 try:settle(成功) 一抛就落进 catch,再拿**失败**结果
// 调一次 settle,把已提交(副作用已落)的节点反向标成 failed;settle 若再抛,异常还逃出引擎。
{
  const settleEngine = new ExecutionEngine();
  let commitCount = 0;
  const settleCalls: string[] = [];
  settleEngine.register({
    kind: "test",
    async execute(): Promise<NodeOutcome> {
      commitCount += 1; // 业务已提交(副作用落定)
      return { status: "success", summary: "done" };
    },
    async settle(_ctx, outcome): Promise<void> {
      settleCalls.push(outcome.status);
      // 第一次(成功结果)抛,第二次(若被错误地当失败收尾)不抛 —— 复现"翻转"路径。
      if (outcome.status === "success" && settleCalls.length === 1) throw new Error("notify failure");
    },
  });
  let settled: NodeOutcome | undefined;
  let escaped: unknown;
  try {
    settled = await settleEngine.execute(context("test"));
  } catch (err) {
    escaped = err;
  }
  ok(escaped === undefined, "★ settle 抛错不逃出执行引擎(返回 NodeOutcome)");
  ok(settled?.status === "success", `★ settle 抛错不得把已成功的执行翻转成失败(实际 ${settled?.status})`);
  ok(commitCount === 1, "★ 业务只提交一次");
  ok(settleCalls.length === 1 && settleCalls[0] === "success", `★ settle 只被调用一次且带**真实**结果(实际 ${JSON.stringify(settleCalls)})`);
  ok(/收尾钩子报错/.test(settled?.summary ?? ""), "★ settle 的错作为告警进 summary(用户可见)");

  // settle 始终抛错:业务成功仍报成功,引擎不抛。
  const alwaysEngine = new ExecutionEngine();
  alwaysEngine.register({
    kind: "test",
    async execute(): Promise<NodeOutcome> {
      return { status: "success", summary: "done" };
    },
    async settle(): Promise<void> {
      throw new Error("notify offline");
    },
  });
  let alwaysOut: NodeOutcome | undefined;
  let alwaysEscaped: unknown;
  try {
    alwaysOut = await alwaysEngine.execute(context("test"));
  } catch (err) {
    alwaysEscaped = err;
  }
  ok(alwaysEscaped === undefined, "★ settle 始终抛错也不逃出引擎");
  ok(alwaysOut?.status === "success", "★ settle 始终抛错,业务成功仍是 success");

  // 业务本身失败(start/execute 抛):settle 收到**失败**结果,且 settle 再抛也不逃出。
  const failEngine = new ExecutionEngine();
  const failSettle: string[] = [];
  failEngine.register({
    kind: "test",
    async execute(): Promise<NodeOutcome> {
      throw new Error("boom");
    },
    async settle(_ctx, outcome): Promise<void> {
      failSettle.push(outcome.status);
      throw new Error("cleanup failed");
    },
  });
  let failOut: NodeOutcome | undefined;
  let failEscaped: unknown;
  try {
    failOut = await failEngine.execute(context("test"));
  } catch (err) {
    failEscaped = err;
  }
  ok(failEscaped === undefined, "★ execute 抛错 + settle 抛错都不逃出引擎");
  ok(failOut?.status === "failed" && /boom/.test(failOut.error ?? ""), "★ 业务失败的根因保留");
  ok(failSettle.length === 1 && failSettle[0] === "failed", `★ 失败路径 settle 也只调一次且带失败结果(实际 ${JSON.stringify(failSettle)})`);
}

// —— 【ARC-006 桥 1】第三方引擎执行器:只在引擎可用时注册 ——
// 三个判据来自同一句需求:"清单里不出现永远跑不了的 kind"。
//   1. 没装/没起来 → 注册表不含 node-red;
//   2. 起来了 → 含,且状态是**派发时现读**(注册后引擎停掉,节点报"去启动引擎");
//   3. 静态白名单(IMPLEMENTED_RUNNER_KINDS / isNodeRunnable)永远不含 node-red ——
//      它是可选能力,清单/画布据此标"跑不了"。
{
  const { setWorkflowEngineStatusPort, NODE_RED_ENGINE_ID_FOR_TEST, nodeRedKind } = await (async () => {
    const mod = await import("../../src/main/orchestration/executionEngine.js");
    const red = await import("../../src/main/orchestration/nodeRedExecutor.js");
    return {
      setWorkflowEngineStatusPort: mod.setWorkflowEngineStatusPort,
      NODE_RED_ENGINE_ID_FOR_TEST: red.NODE_RED_ENGINE_ID,
      nodeRedKind: red.NODE_RED_RUNNER_KIND,
    };
  })();
  const status = (state: "stopped" | "starting" | "running" | "failed", port: number | null) =>
    ({ engineId: NODE_RED_ENGINE_ID_FOR_TEST, state, port, reason: state === "failed" ? "boom" : null });

  try {
    // 1a. 状态口没装(装配前 / 无头环境)—— fail-closed,不注册。
    setWorkflowEngineStatusPort(null);
    ok(!createBuiltinExecutionEngine().has(nodeRedKind), "★ 引擎状态口未装时注册表不含 node-red(不出现永远跑不了的 kind)");

    // 1b. 装了但引擎没起来 —— 同样不注册。
    setWorkflowEngineStatusPort(() => status("stopped", null));
    ok(!createBuiltinExecutionEngine().has(nodeRedKind), "★ 引擎 stopped 时注册表不含 node-red");
    setWorkflowEngineStatusPort(() => status("starting", 3527));
    ok(!createBuiltinExecutionEngine().has(nodeRedKind), "★ 引擎 starting 时注册表不含 node-red(端口有了也不算可用)");
    setWorkflowEngineStatusPort(() => status("failed", null));
    ok(!createBuiltinExecutionEngine().has(nodeRedKind), "★ 引擎 failed 时注册表不含 node-red");
    // running 但端口为 null —— "可用"必须**同时**要求 running 与端口(执行器要靠端口拼 URL)。
    setWorkflowEngineStatusPort(() => status("running", null));
    ok(!createBuiltinExecutionEngine().has(nodeRedKind), "★ running 但端口为 null 时也不含 node-red");
    setWorkflowEngineStatusPort(() => null);
    ok(!createBuiltinExecutionEngine().has(nodeRedKind), "未知引擎 id(状态口回 null)时不含 node-red");

    // 2a. 引擎 running 且有端口 → 注册。
    let live: { state: "running" | "stopped"; port: number | null } = { state: "running", port: 3527 };
    setWorkflowEngineStatusPort(() => ({ engineId: NODE_RED_ENGINE_ID_FOR_TEST, ...live, reason: null }));
    const engine = createBuiltinExecutionEngine();
    ok(engine.has(nodeRedKind), "★ 引擎 running 时注册表含 node-red");
    // 原有内置执行器一个不少(条件注册不能顶掉它们)。
    ok(engine.has("command") && engine.has("code") && engine.has("module-capability"), "★ 引擎可用时原有的 command/code/module-capability 仍在");

    // 2b. 注册之后引擎停掉:执行节点**现读**状态,报的是"去启动引擎"而不是
    // "没有能执行这种节点的执行器" —— 后者会让用户以为图配错了。
    live = { state: "stopped", port: null };
    const redCtx = context(nodeRedKind);
    (redCtx.node as { params: Record<string, unknown> }).params = { enginePath: "/api/flow" };
    (redCtx.input as { engineRequest?: unknown }).engineRequest = { path: "/api/flow", method: "POST", body: null };
    const redOut = await engine.execute(redCtx);
    ok(redOut.status === "failed", "★ 注册后引擎停掉 → 节点 failed(不是掉进模型兜底)");
    ok(redOut.retryable === false, "★ 引擎未运行不可重试(重跑同一输入不会变)");
    ok(/启动/.test(redOut.error ?? ""), `★ 原因说清要启动引擎(实际 ${redOut.error ?? ""})`);

    // 2c. 反方向:引擎此刻 running → **真的发到回环端口并成功**。起一个真 HTTP
    // 服务(端口由 OS 给),证明执行器读的是**执行时**的状态口,而不是注册那一刻
    // 的快照 —— 拍快照会让引擎在注册之后才起来的节点永远失败。
    {
      const { createServer } = await import("node:http");
      const server = createServer((req, res) => {
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ path: req.url, method: req.method, body }));
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      const realPort = typeof address === "object" && address !== null ? address.port : 0;
      try {
        setWorkflowEngineStatusPort(() => ({ engineId: NODE_RED_ENGINE_ID_FOR_TEST, state: "running", port: realPort, reason: null }));
        const liveEngine = createBuiltinExecutionEngine();
        const liveCtx = context(nodeRedKind);
        (liveCtx.node as { params: Record<string, unknown> }).params = { enginePath: "/api/flow" };
        (liveCtx.input as { engineRequest?: unknown }).engineRequest = { path: "/api/flow", method: "POST", body: '{"a":1}' };
        const liveOut = await liveEngine.execute(liveCtx);
        ok(realPort > 0, "前置:真回环服务拿到了端口");
        ok(liveOut.status === "success", `★ 注册后引擎 running → 经真 HTTP 成功(实际 ${liveOut.status}${liveOut.error ? " — " + liveOut.error : ""})`);
        ok((liveOut.outputs?.status as number) === 200, "★ 响应状态进入 outputs");
        ok((liveOut.outputs?.body as { path?: string } | undefined)?.path === "/api/flow", "★ 引擎真的收到了请求路径");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }

    // 3. 静态层:node-red **不在** IMPLEMENTED_RUNNER_KINDS,isNodeRunnable 恒 false。
    const { IMPLEMENTED_RUNNER_KINDS, isRunnerImplemented, isNodeRunnable, renderNodeTypeCatalog } =
      await import("@contracts/nodeType");
    ok(!(IMPLEMENTED_RUNNER_KINDS as readonly string[]).includes(nodeRedKind),
      "★ node-red 不在 IMPLEMENTED_RUNNER_KINDS(它是可选能力,不是静态可跑)");
    ok(!isRunnerImplemented(nodeRedKind as never), "★ isRunnerImplemented(node-red) 保持 false");
    // 一份声明 node-red 的清单(形状借用内置清单;眼下契约还不认这个 kind,所以
    // 用对象字面量而不是过 schema —— 这条钉的是**判据**,不是某份具体清单)。
    const redManifest = {
      id: "mcode.node-red", manifestVersion: 1, name: "Node-RED 引擎", runner: { kind: nodeRedKind },
      capability: "read", params: [],
    } as unknown as import("@contracts/nodeType").NodeTypeManifest;
    ok(!isNodeRunnable(redManifest), "★ 清单声明 node-red 时 isNodeRunnable 为 false(画布/检查器据此标跑不了)");
    const catalogText = renderNodeTypeCatalog([{ id: redManifest.id, source: "plugin", from: "test", manifest: redManifest }]);
    ok(catalogText.includes("跑不了"), `★ 节点目录如实标出该类型跑不了(实际:${catalogText.split("\n").pop()})`);

    // 界面那条路:卡片/类型页的"跑不了"徽标必须读**同一个** isNodeRunnable ——
    // 本切片不允许改渲染端,所以钉判据来源(而不是另写一份 kind 名单):只要两边
    // 读同一份答案,isNodeRunnable=false 的类型在界面上就会被标出来。
    {
      const { readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const card = readFileSync(join(process.cwd(), "src/renderer/components/settings/workflows/WorkflowNodeCard.tsx"), "utf8");
      const types = readFileSync(join(process.cwd(), "src/renderer/components/settings/workflows/NodeTypesView.tsx"), "utf8");
      ok(/deadRunner\s*=\s*entry\s*\?\s*!isNodeRunnable\(entry\.manifest\)/.test(card) &&
        /const runnable = isNodeRunnable\(m\)/.test(types),
      "★ 画布卡片与节点类型页的「跑不了」都读 isNodeRunnable(与调度器同一份答案)");
    }
  } finally {
    setWorkflowEngineStatusPort(null);
  }

  // 4. 生产装配确实把状态口接上了 —— 否则条件注册永远不会发生(功能静默缺席)。
  {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const bootstrap = readFileSync(join(process.cwd(), "src/main/index.ts"), "utf8");
    ok(/setWorkflowEngineStatusPort\(\(engineId\)\s*=>\s*workflowEngineRegistry\.statusOf\(engineId\)\)/.test(bootstrap),
      "★ main/index.ts 装配时把引擎状态查询口接上(否则 node-red 执行器永远不会注册)");
  }

  // 5. **变量展开要作用到 engineBody**:调度器把解算后的参数交给 buildInput,而
  //    执行器读的是 `input.engineRequest`(存盘原值 `node.params` 只做回落)。
  //    没有这个 builder 时,node-red 节点会先落进默认模型轮构造、在"指令必填"处炸,
  //    根本走不到执行器;而且即便走到了,`engineBody` 里的 `{{上游.字段}}` 也不会生效。
  {
    const { buildNodeInput } = await import("../../src/main/orchestration/nodeInputBuilders.js");
    const { nodeRedExecutor } = await import("../../src/main/orchestration/nodeRedExecutor.js");
    const redManifest = {
      id: "mcode.node-red", manifestVersion: 1, name: "Node-RED 引擎", runner: { kind: nodeRedKind },
      capability: "read", params: [],
    } as unknown as import("@contracts/nodeType").NodeTypeManifest;
    const scope = {
      userPrompt: "", upstream: "", upstreamArtifacts: [], upstreamOutputs: {},
      nodeId: "n1", plan: { steps: [] } as never, root: false, terminal: true,
      contextLines: () => [],
    };
    // 调度器交来的 params 是 `expandParams` 解算**之后**的(见 scheduler.executeOne)。
    const expanded = {
      enginePath: "/api/flow",
      engineMethod: "POST",
      engineBody: '{"q":"已替换的上游值"}',
    };
    const built = buildNodeInput(expanded, redManifest, scope as never, new AbortController().signal);
    ok(built.engineRequest?.body === expanded.engineBody,
      `★ 解算后的 engineBody 进入 input.engineRequest(实际 ${JSON.stringify(built.engineRequest?.body)})`);
    ok(built.prompt === "" && built.returnMode === "none",
      "★ node-red 节点不走模型轮构造(不产生提示词、不回主对话)");

    // 执行器**优先**读 engineRequest,不被存盘原值覆盖。
    let sent: { url: string; body: string | null } | null = null;
    const exec = nodeRedExecutor({
      engine: { status: () => ({ engineId: NODE_RED_ENGINE_ID_FOR_TEST, state: "running", port: 3527, reason: null }) },
      fetch: async (req) => {
        sent = { url: req.url, body: req.body };
        return { status: 200, text: "{}", truncated: false };
      },
    });
    const out = await exec.execute({
      node: { params: { enginePath: "/stale", engineBody: "存盘原值" } },
      input: { ...built, signal: new AbortController().signal },
    } as never);
    ok(out.status === "success", `★ 执行器带 builder 产物运行时成功(实际 ${out.status})`);
    ok(sent !== null && (sent as { url: string }).url.endsWith("/api/flow") &&
      (sent as { body: string | null }).body === expanded.engineBody,
    `★ 请求使用解算后的值而不是 node.params 的存盘原值(实际 ${JSON.stringify(sent)})`);
  }
}

// —— `NodeParamSpec.bind` 的消费点与显式拒绝 ——
// 上一片实测确认:bind 在契约里完整声明、README 教给插件作者,但主进程没有任何消费点。
// 现在两条路各自钉住:
//   1. **清单自带脚本**(runner.entry):commandExecutor 把 boundParams 按清单声明顺序
//      拼成 bindings 交给 entryRunner。这里起一个**真的 node 子进程**把 argv/env/stdin
//      原样打回来 —— 断言看的是"脚本真的收到了什么",不是中间对象(中间那一层在
//      entry-runner-smoke 里用假 spawn 钉过,两层各管一件事)。
//   2. **命令写在参数里**(entry 缺省):没有 argv 数组可绑 —— 声明了 bind 就必须
//      **明确失败**,不能静默忽略(否则插件作者按文档写的 bind 会一声不吭地被扔掉)。
{
  const { CommandExecutor } = await import("../../src/main/orchestration/commandExecutor.js");
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const pluginDir = mkdtempSync(join(tmpdir(), "mcode-bind-smoke-"));
  mkdirSync(pluginDir, { recursive: true });
  // 脚本把**它自己收到的**三样东西打回来:argv(去掉 node 与脚本路径)、环境变量、stdin。
  writeFileSync(
    join(pluginDir, "bound.mjs"),
    [
      'let stdin = "";',
      'process.stdin.on("data", (c) => { stdin += c; });',
      'process.stdin.on("end", () => {',
      '  console.log(JSON.stringify({ argv: process.argv.slice(2), token: process.env.MCODE_TOKEN ?? null, stdin }));',
      "});",
      "",
    ].join("\n"),
    "utf8",
  );

  try {
    const scriptManifest = {
      id: "testorg.bound-script",
      manifestVersion: 1,
      name: "Bound script",
      runner: { kind: "command", entry: "./bound.mjs", interpreter: "node" },
      capability: "read",
      params: [
        { key: "input", kind: "file", label: "输入文件", bind: { kind: "arg", flag: "--input" } },
        { key: "count", kind: "number", label: "条数", bind: { kind: "arg" } },
        { key: "token", kind: "text", label: "令牌", bind: { kind: "env", name: "MCODE_TOKEN" } },
        { key: "payload", kind: "longtext", label: "载荷", bind: { kind: "stdin" } },
        // 没声明 bind 的参数:值不进 argv/env —— 断言它**没有**混进来。
        { key: "note", kind: "text", label: "备注" },
        // 绑了但清空的可选参数:按"没填"处理,不发 `--opt ""`(与 validateNodeParams 同口径)。
        { key: "optional", kind: "text", label: "可选", bind: { kind: "arg", flag: "--opt" } },
      ],
    } as import("@contracts/nodeType").NodeTypeManifest;
    const scriptCtx = context("command");
    scriptCtx.manifest = scriptManifest;
    scriptCtx.manifestDir = pluginDir;
    (scriptCtx.input as { command?: unknown }).command = {
      command: "",
      timeoutMs: 0,
      // 解算后的绑定值(调度器的 `{{...}}` 从这里过) —— 键 = 参数 key。
      boundParams: { input: "a b.txt", count: 3, token: "s3cret", payload: "line1", note: "未声明" },
    };
    const scriptOut = await new CommandExecutor().execute(scriptCtx);
    ok(scriptOut.status === "success", `★ 带 bind 的 entry 脚本跑通(实际 ${scriptOut.status}${scriptOut.error ? " — " + scriptOut.error : ""})`);
    let seen: { argv?: string[]; token?: string | null; stdin?: string } = {};
    try {
      seen = JSON.parse(String((scriptOut.outputs as { stdout?: string })?.stdout ?? ""));
    } catch {
      /* 下面三条会带着原始输出一起红,比这里再抛一句更有用 */
    }
    ok(
      JSON.stringify(seen.argv) === JSON.stringify(["--input", "a b.txt", "3"]),
      `★ arg 绑定按清单声明顺序拼成独立参数、未声明 bind 的参数不进 argv(实际 ${JSON.stringify(seen.argv)} — 原始输出 ${JSON.stringify((scriptOut.outputs as { stdout?: string })?.stdout)})`,
    );
    ok(seen.token === "s3cret", `★ env 绑定真的进了子进程的环境(实际 ${JSON.stringify(seen.token)})`);
    ok(seen.stdin === "line1", `★ stdin 绑定真的写进了子进程的 stdin(实际 ${JSON.stringify(seen.stdin)})`);

    // ★ 值从**输入构造那一层**来:调度器解算后的参数进 `commandInputBuilder`,只有
    //   清单**声明了 bind** 的参数进 `input.command.boundParams`。执行器读它,而不是
    //   回头读 `node.params`(那上面还是 `{{...}}` 存盘原值)。
    const { buildNodeInput } = await import("../../src/main/orchestration/nodeInputBuilders.js");
    const builtScope = {
      userPrompt: "", upstream: "", upstreamArtifacts: [], upstreamOutputs: {},
      nodeId: "n1", plan: { steps: [] } as never, root: false, terminal: true,
      contextLines: () => [],
    };
    const built = buildNodeInput(
      // 解算后的值(`{{...}}` 已经换掉了);`optional` 是绑了但被清空的可选参数。
      { command: "", input: "a b.txt", count: 3, token: "s3cret", payload: "line1", note: "未声明", optional: "" },
      scriptManifest,
      builtScope as never,
      new AbortController().signal,
    );
    ok(
      JSON.stringify(built.command?.boundParams) === JSON.stringify({ input: "a b.txt", count: 3, token: "s3cret", payload: "line1" }),
      `★ 解算后的绑定值进入 input.command.boundParams,未声明 bind 的参数不混进来(实际 ${JSON.stringify(built.command?.boundParams)})`,
    );
    ok(
      !("optional" in (built.command?.boundParams ?? {})),
      `★ 绑了但清空的可选参数按"没填"处理(不发 --opt "";实际 ${JSON.stringify(built.command?.boundParams)})`,
    );

    // ★ 命令写在参数里 + 清单声明了 bind = 明确失败,**不是**静默忽略。
    const paramManifest = {
      id: "testorg.bound-shell",
      manifestVersion: 1,
      name: "Bound shell",
      runner: { kind: "command" },
      capability: "exec",
      params: [
        { key: "command", kind: "text", label: "命令", required: true },
        { key: "input", kind: "file", label: "输入文件", bind: { kind: "arg", flag: "--input" } },
      ],
    } as import("@contracts/nodeType").NodeTypeManifest;
    const paramCtx = context("command");
    paramCtx.manifest = paramManifest;
    // 命令是一条**存在不了**的二进制:真去 spawn 的话错误会说"命令起不来";
    // 拿到 bind 那句 = 在起进程之前就被拒了。
    (paramCtx.input as { command?: unknown }).command = {
      command: "mcode-no-such-binary-for-bind-smoke",
      timeoutMs: 0,
      boundParams: { input: "a.txt" },
    };
    const paramOut = await new CommandExecutor().execute(paramCtx);
    ok(paramOut.status === "failed", `★ 壳命令 + bind → 明确失败(实际 ${paramOut.status})`);
    ok(/bind/.test(paramOut.error ?? "") && /entry/.test(paramOut.error ?? ""), `★ 错误说清 bind 只对 entry 脚本生效(实际 ${paramOut.error ?? ""})`);
    ok(!/起不来/.test(paramOut.error ?? ""), "★ 明确失败发生在起进程之前(不是跑了再把值扔掉)");

    // ★ 对照:同一形状的清单**没声明 bind** → 照常落到命令执行那条路(拒绝只针对
    //   "声明了但落不了地")。shell 起不来不存在的命令时退出码非零 —— 而命令节点的
    //   规矩是**非零不算失败**,所以这里断言的是"跑完了、给了退出码",反证 bind 那道
    //   闸没有误伤普通命令节点(它要是在闸上被拦,状态会是 failed 且错误提 bind)。
    const plainManifest = {
      ...paramManifest,
      id: "testorg.plain-shell",
      params: paramManifest.params.filter((p) => p.bind === undefined),
    } as import("@contracts/nodeType").NodeTypeManifest;
    const plainCtx = context("command");
    plainCtx.manifest = plainManifest;
    (plainCtx.input as { command?: unknown }).command = { command: "mcode-no-such-binary-for-bind-smoke", timeoutMs: 0 };
    const plainOut = await new CommandExecutor().execute(plainCtx);
    ok(
      plainOut.status === "success" && typeof (plainOut.outputs as { exitCode?: unknown })?.exitCode === "number" && !(plainOut.error ?? "").includes("bind"),
      `★ 没声明 bind 的壳命令照常走命令执行那条路(实际 ${plainOut.status} — ${plainOut.error ?? JSON.stringify(plainOut.outputs)})`,
    );
  } finally {
    try {
      rmSync(pluginDir, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响结论 */
    }
  }
}

console.log(`PASS: ${checks.length} checks`);