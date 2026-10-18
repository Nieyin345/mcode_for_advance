/**
 * **mcode-host-mcp stdio 传输层 + 回环中继的无头回归** —— ARC-006 桥 2 第二片。
 *
 * 被测:
 *   - `src/main/mcp/hostMcpStdio.ts`   —— NDJSON 帧 / initialize / tools/list / tools/call /
 *     坏 JSON / 未知方法 / stdin 关闭;
 *   - `src/main/mcp/hostMcpRelayServer.ts` —— 主进程侧的回环 HTTP 中继(令牌 + Host 围栏);
 *   - `src/main/mcp/hostMcpMain.ts`    —— 子进程入口:环境变量读中继地址与令牌,真 stdio 子进程。
 *
 * 形状(与生产同一条路):本进程 = "主进程",用真 `createHostMcpServer` 装配核心(工具表是
 * 真 `appMcpTools()`,执行器是记录桩),起回环中继;再真起 stdio 子进程
 * (`process.execPath` + `ELECTRON_RUN_AS_NODE=1`,与 `genoffice mcp` 同形态),
 * 喂 JSON-RPC 帧、断言回应。
 *
 * 覆盖(判据全在"客户端从 stdout 看见什么"上):
 *   1. ★ initialize 协商 / 能力 / serverInfo;
 *   2. ★ tools/list 返回的就是注入的同一份表(name 逐一相等、顺序一致、JSON 深相等);
 *   3. ★ tools/call 安全档经传输层到达执行器,结果文本原样回来;
 *   4. ★ 危险档无审批端口 → 传输层看到的仍是 `approval_unavailable`(不是被吞成成功);
 *   5. ★ 坏 JSON 帧 → JSON-RPC error(-32700)且进程不退(下一条 ping 照常回);
 *   6. ★ 未知方法 → -32601;未知工具 → 结果里带 `unknown_tool`;
 *   7. ★ stdout 只有 JSON 帧(日志全在 stderr);stdin 关闭 → 退出码 0;
 *   8. 中继围栏:错令牌 401、非回环 Host 403、非 /rpc 404。
 *
 * Run: bash apps/desktop/scripts/host-mcp-stdio-smoke/run.sh
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { request as httpRequest } from "node:http";
import { appMcpTools } from "@main/appControl/tools.js";
import { createHostMcpServer, type HostMcpPorts, type HostMcpToolSpec } from "@main/mcp/hostMcpServer.js";
import { startHostMcpRelayServer, type HostMcpRelayHandle } from "@main/mcp/hostMcpRelayServer.js";
import type { ToolResult } from "@main/mcp/sdk.js";

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) passed++;
  else failures.push(`${name}${detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}
function deepEqual(name: string, actual: unknown, expected: unknown): void {
  try {
    assert.deepStrictEqual(actual, expected);
    check(name, true);
  } catch (err) {
    check(name, false, err instanceof Error ? err.message.split("\n").slice(0, 12).join(" ") : err);
  }
}

/* ── 0. 夹具:真工具表 + 记录执行器;核心与生产装配同形(审批端口 = null) ── */
const TABLE: ReadonlyArray<HostMcpToolSpec> = appMcpTools();

interface Invocation {
  name: string;
  args: unknown;
}
const calls: Invocation[] = [];
const ports: HostMcpPorts = {
  tools: () => TABLE,
  invoke: async (name, args): Promise<ToolResult> => {
    calls.push({ name, args });
    return { content: [{ type: "text", text: `relay-stub:${name}` }] };
  },
};
const core = createHostMcpServer(ports, null);

/* ── 1. 主进程侧:回环中继 ── */
const relay: HostMcpRelayHandle = await startHostMcpRelayServer({ core });

/* ── 2. 真 stdio 子进程(Electron-as-Node 形态) ── */
const childEntry: string = process.env.MCODE_HOST_MCP_STDIO_CHILD ?? "";
if (!childEntry) {
  console.error("MCODE_HOST_MCP_STDIO_CHILD 没设 —— 应由 run.sh 指向打包好的 hostMcpMain 产物");
  process.exit(2);
}

interface StdoutEvent {
  line: string;
  parsed?: Record<string, unknown>;
}
const stdoutEvents: StdoutEvent[] = [];
const stderrLines: string[] = [];

function makeClient(child: ChildProcessWithoutNullStreams) {
  const pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  let nextId = 1;
  let buf = "";

  child.stdout.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let idx = buf.indexOf("\n");
    while (idx >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      idx = buf.indexOf("\n");
      if (!line.trim()) continue;
      const event: StdoutEvent = { line };
      try {
        event.parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        /* 非 JSON 的 stdout 行留给断言去判红 */
      }
      stdoutEvents.push(event);
      const id = event.parsed?.id;
      if (typeof id === "number" && pending.has(id)) {
        const p = pending.get(id)!;
        pending.delete(id);
        clearTimeout(p.timer);
        p.resolve(event.parsed!);
      }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrLines.push(...chunk.toString("utf8").split(/\r?\n/).filter(Boolean));
  });

  const write = (obj: unknown): void => {
    child.stdin.write(JSON.stringify(obj) + "\n");
  };
  const writeRaw = (line: string): void => {
    child.stdin.write(line + "\n");
  };

  return {
    request(method: string, params: unknown, timeoutMs = 15_000): Promise<Record<string, unknown>> {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} 超过 ${timeoutMs}ms 没有回应`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        write({ jsonrpc: "2.0", id, method, params });
      });
    },
    notify(method: string): void {
      write({ jsonrpc: "2.0", method, params: {} });
    },
    writeRaw,
    /** 客户端直接收场:关闭 stdin(与引擎退出时同一件事)。 */
    endInput(): void {
      child.stdin.end();
    },
  };
}

const env: NodeJS.ProcessEnv = {
  ELECTRON_RUN_AS_NODE: "1",
  MCODE_HOST_MCP_RELAY_URL: relay.url,
  MCODE_HOST_MCP_RELAY_TOKEN: relay.token,
  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
  ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
  ...(process.env.TMP ? { TMP: process.env.TMP } : {}),
};

function withChild(
  relayEnv: { url: string; token: string },
  fn: (child: ChildProcessWithoutNullStreams, exit: Promise<number | null>) => Promise<void>,
): Promise<void> {
  return new Promise<void>((resolveOuter) => {
    // `stdio` 三元组必须写死成 tuple,否则 TS 在 spawn 的多个重载之间解析出 never。
    const child = spawn(process.execPath, [childEntry], {
      stdio: ["pipe", "pipe", "pipe"] as const,
      windowsHide: true,
      env: { ...env, MCODE_HOST_MCP_RELAY_URL: relayEnv.url, MCODE_HOST_MCP_RELAY_TOKEN: relayEnv.token },
    });
    const exit = new Promise<number | null>((resolve) => {
      child.once("exit", (code) => resolve(code));
      child.once("error", () => resolve(null));
    });
    fn(child, exit).then(
      () => resolveOuter(),
      (err: unknown) => {
        failures.push(`子进程会话抛错 — ${err instanceof Error ? err.message : String(err)}`);
        resolveOuter();
      },
    );
  });
}

try {
  await withChild(relay, async (child, exit) => {
    const client = makeClient(child);

    /* ── 1. ★ initialize:版本协商 / 能力 / serverInfo ── */
    const init = await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "host-mcp-stdio-smoke", version: "1.0" },
    });
    const initResult = init.result as Record<string, unknown> | undefined;
    check(
      "★ initialize → serverInfo.name = mcode-host-mcp",
      (initResult?.serverInfo as { name?: string } | undefined)?.name === "mcode-host-mcp",
      initResult?.serverInfo,
    );
    check(
      "★ initialize → 回同一协议版本 2025-06-18",
      initResult?.protocolVersion === "2025-06-18",
      initResult?.protocolVersion,
    );
    check(
      "★ initialize → 能力只声明 tools(listChanged=false)",
      JSON.stringify(initResult?.capabilities) === JSON.stringify({ tools: { listChanged: false } }),
      initResult?.capabilities,
    );
    client.notify("notifications/initialized");

    const initOld = await client.request("initialize", { protocolVersion: "1999-01-01", capabilities: {} });
    check(
      "initialize:客户端报不认识的版本 → 回我们最新的那版(协商规则)",
      (initOld.result as { protocolVersion?: string } | undefined)?.protocolVersion === "2025-06-18",
      (initOld.result as { protocolVersion?: string } | undefined)?.protocolVersion,
    );

    /* ── 2. ★ tools/list = 注入的同一份表 ── */
    const list = await client.request("tools/list", {});
    const tools = (list.result as { tools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> } | undefined)?.tools ?? [];
    check(
      "★ tools/list 工具数量与 appMcpTools() 一致",
      tools.length === TABLE.length && TABLE.length > 0,
      { transported: tools.length, table: TABLE.length },
    );
    check(
      "★ tools/list 的名字序列与 appMcpTools() 逐一相等(顺序一致)",
      tools.map((t) => t.name).join(",") === TABLE.map((t) => t.name).join(","),
      { transported: tools.map((t) => t.name), table: TABLE.map((t) => t.name) },
    );
    deepEqual(
      "★ tools/list 整份描述 JSON 深相等(跨进程没有第二张表、没有被改写)",
      tools,
      JSON.parse(JSON.stringify(core.listTools())) as unknown,
    );
    check(
      "★ tools/list 的每个工具都带 description + inputSchema(投影完整)",
      tools.every((t) => typeof t.description === "string" && t.description.length > 0 && t.inputSchema !== null && typeof t.inputSchema === "object"),
      tools.filter((t) => !t.description).map((t) => t.name),
    );

    /* ── 3. ★ tools/call 安全档:经传输层到达执行器,结果原样回来 ── */
    const beforeSafe = calls.length;
    const safe = await client.request("tools/call", { name: "app_api_list", arguments: { domain: "project" } });
    const safeResult = safe.result as { content?: Array<{ type: string; text?: string }>; isError?: boolean } | undefined;
    check(
      "★ 安全档 tools/call 执行成功(结果文本原样跨进程回来)",
      safeResult?.isError !== true && safeResult?.content?.[0]?.text === "relay-stub:app_api_list",
      safeResult,
    );
    check(
      "★ 执行器被调一次,名字与参数经中继原样到达",
      calls.length === beforeSafe + 1 && calls[calls.length - 1]!.name === "app_api_list" &&
        (calls[calls.length - 1]!.args as { domain?: string }).domain === "project",
      calls[calls.length - 1],
    );

    /* ── 4. ★ 危险档无审批端口 → 传输层看到的仍是 approval_unavailable ── */
    const beforeDanger = calls.length;
    const danger = await client.request("tools/call", {
      name: "app_api_call",
      arguments: { method: "project.delete", input: { id: "p1" } },
    });
    const dangerResult = danger.result as
      | { isError?: boolean; structuredContent?: { host_mcp_error?: string }; content?: Array<{ text?: string }> }
      | undefined;
    check(
      "★ 危险档无审批端口:传输层返回的仍是 approval_unavailable(没被吞成成功)",
      dangerResult?.isError === true && dangerResult?.structuredContent?.host_mcp_error === "approval_unavailable",
      dangerResult,
    );
    check(
      "★ 危险档:执行器没被调(失败发生在核心,不是中继)",
      calls.length === beforeDanger,
      calls.length - beforeDanger,
    );
    check(
      "★ 危险档的拒绝理由跨传输层可见(fail-closed 文案没有丢)",
      (dangerResult?.content?.[0]?.text ?? "").includes("未执行"),
      dangerResult?.content?.[0]?.text,
    );

    /* ── 5. ★ 坏 JSON 帧 → JSON-RPC error,且进程不退 ── */
    client.writeRaw("this is not json");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const parseErrorLine = stdoutEvents.find((e) => (e.parsed?.error as { code?: number } | undefined)?.code === -32700);
    check(
      "★ 坏 JSON 帧 → JSON-RPC error -32700(id=null)",
      parseErrorLine !== undefined && parseErrorLine.parsed?.id === null,
      parseErrorLine?.line,
    );
    const alive = await client.request("ping", {});
    check(
      "★ 坏帧之后进程不退:下一条 ping 照常回应",
      JSON.stringify(alive.result) === "{}" && alive.id !== undefined,
      alive,
    );

    /* ── 6. ★ 未知方法 → -32601;未知工具 → 结果带 unknown_tool ── */
    const unknown = await client.request("resources/list", {});
    check(
      "★ 未知方法 → JSON-RPC error -32601",
      (unknown.error as { code?: number } | undefined)?.code === -32601,
      unknown.error,
    );
    const unknownTool = await client.request("tools/call", { name: "app_not_a_tool", arguments: {} });
    const unknownToolResult = unknownTool.result as
      | { isError?: boolean; structuredContent?: { host_mcp_error?: string } }
      | undefined;
    check(
      "★ 未知工具 → 失败结果带 unknown_tool(不是协议错,模型看得见)",
      unknownToolResult?.isError === true && unknownToolResult?.structuredContent?.host_mcp_error === "unknown_tool",
      unknownToolResult,
    );
    const missingName = await client.request("tools/call", { arguments: {} });
    check(
      "tools/call 缺工具名 → -32602",
      (missingName.error as { code?: number } | undefined)?.code === -32602,
      missingName.error,
    );

    /* ── 7. ★ stdout 只有 JSON 帧;日志全在 stderr ── */
    check(
      "★ stdout 每一行都是合法 JSON(没有日志污染协议通道)",
      stdoutEvents.length > 0 && stdoutEvents.every((e) => e.parsed !== undefined),
      stdoutEvents.filter((e) => !e.parsed).map((e) => e.line.slice(0, 120)),
    );
    check(
      "★ stderr 里有传输层日志(日志去了 stderr)",
      stderrLines.some((line) => line.includes("[mcode-host-mcp]")),
      stderrLines.slice(0, 3),
    );

    /* ── 8. ★ stdin 关闭 → 正常退出 0 ── */
    client.endInput();
    const code = await exit;
    check("★ stdin 关闭 → 子进程退出码 0", code === 0, { code });
  });

  /* ── 9. 中继围栏:错令牌 / 非回环 Host / 非 /rpc(不依赖子进程,直接打端点) ── */
  // 注意:这一组必须在 `relay.close()`(finally)之前跑。
  const callRelay = (opts: { token?: string; host?: string; path?: string }): Promise<{ status: number; body: unknown }> =>
    new Promise((resolve, reject) => {
      const url = new URL(relay.url);
      const req = httpRequest(
        {
          hostname: url.hostname,
          port: url.port,
          path: opts.path ?? "/rpc",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(opts.host ? { Host: opts.host } : {}),
            ...(opts.token !== undefined ? { Authorization: `Bearer ${opts.token}` } : {}),
          },
        },
        (res) => {
          let raw = "";
          res.setEncoding("utf8");
          res.on("data", (c: string) => (raw += c));
          res.on("end", () => {
            let body: unknown = raw;
            try {
              body = JSON.parse(raw);
            } catch {
              /* 原样返回 */
            }
            resolve({ status: res.statusCode ?? 0, body });
          });
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ op: "list" }));
    });

  const good = await callRelay({ token: relay.token });
  check(
    "中继:正确令牌 → 200 + 同一份工具表",
    good.status === 200 &&
      (good.body as { ok?: boolean; tools?: unknown[] }).ok === true &&
      (good.body as { tools?: unknown[] }).tools?.length === TABLE.length,
    good,
  );
  const badToken = await callRelay({ token: "0".repeat(64) });
  check("中继:错令牌 → 401(不执行任何工具)", badToken.status === 401, badToken);
  const noToken = await callRelay({});
  check("中继:无令牌 → 401", noToken.status === 401, noToken);
  const rebind = await callRelay({ token: relay.token, host: "evil.example" });
  check("★ 中继:非回环 Host 头 → 403(防 DNS 重绑定)", rebind.status === 403, rebind);
  const wrongPath = await callRelay({ token: relay.token, path: "/mcp" });
  check("中继:非 /rpc 路径 → 404", wrongPath.status === 404, wrongPath);
} finally {
  await relay.close();
}

/* ── 9b. ★ 审批回弹:宿主侧审批端口批准 / 拒绝,都跨传输层走通 ──
 *
 * 生产装配的形状(RuntimeManager.webToolGate 那一份,见报告):审批端口在**宿主**一侧,
 * 核心 `createHostMcpServer(corePorts, approvalPort)` 在调用执行器之前完成分档与审批;
 * 子进程/传输层只转发,永远看不到决策细节,也无法伪造。
 *
 * 这里用一个"宿主 UI 替身"当审批端口:它模拟用户在审批卡上点。危险档批准 → 执行器被调;
 * 拒绝 → 客户端收到 approval_denied + 用户理由,执行器不被调。
 */
{
  const approvalSeen: Array<{ name: string; args: unknown }> = [];
  const approvalCalls: Invocation[] = [];
  let answer: { approved: boolean; reason?: string } = { approved: true };

  const approvalCore = createHostMcpServer(
    {
      tools: () => TABLE,
      invoke: async (name, args): Promise<ToolResult> => {
        approvalCalls.push({ name, args });
        return { content: [{ type: "text", text: `approval-stub:${name}` }] };
      },
    },
    {
      // 宿主 UI 替身:真实装配在这里走 RuntimeManager.webToolGate(sessionId).requestApproval
      // (ApprovalBridge 的 approval.request 事件 → 界面审批卡 → claude:approve → resolve)。
      request: async (name, args) => {
        approvalSeen.push({ name, args });
        return answer;
      },
    },
  );
  const approvalRelay = await startHostMcpRelayServer({ core: approvalCore });
  try {
    await withChild(approvalRelay, async (child, exit) => {
      const client = makeClient(child);
      await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {} });

      // ① 批准:危险档执行器被调一次,结果跨传输层回来。
      const approved = await client.request("tools/call", {
        name: "app_api_call",
        arguments: { method: "project.delete", input: { id: "p1" } },
      });
      const approvedResult = approved.result as { isError?: boolean; content?: Array<{ text?: string }> } | undefined;
      check(
        "★ 审批回弹(批准):危险档经宿主审批端口放行,执行器被调一次",
        approvedResult?.isError !== true && approvalCalls.length === 1 &&
          approvedResult?.content?.[0]?.text === "approval-stub:app_api_call",
        { isError: approvedResult?.isError, calls: approvalCalls.length, text: approvedResult?.content?.[0]?.text },
      );
      check(
        "★ 审批回弹:宿主审批端口收到的是(工具名, 校验后的参数),传输层碰不到决策",
        approvalSeen.length === 1 && approvalSeen[0]!.name === "app_api_call" &&
          (approvalSeen[0]!.args as { method?: string }).method === "project.delete",
        approvalSeen,
      );

      // ② 拒绝:客户端收到 approval_denied + 用户理由,执行器不再被调。
      answer = { approved: false, reason: "这个项目还要用" };
      const denied = await client.request("tools/call", {
        name: "app_api_call",
        arguments: { method: "project.delete", input: { id: "p1" } },
      });
      const deniedResult = denied.result as
        | { isError?: boolean; structuredContent?: { host_mcp_error?: string }; content?: Array<{ text?: string }> }
        | undefined;
      check(
        "★ 审批回弹(拒绝):approval_denied + 用户理由跨传输层可见",
        deniedResult?.isError === true &&
          deniedResult?.structuredContent?.host_mcp_error === "approval_denied" &&
          (deniedResult?.content?.[0]?.text ?? "").includes("这个项目还要用"),
        deniedResult,
      );
      check(
        "★ 审批回弹(拒绝):执行器没有被调",
        approvalCalls.length === 1,
        approvalCalls.length,
      );

      client.endInput();
      const code = await exit;
      check("★ 审批会话:stdin 关闭 → 退出码 0", code === 0, { code });
    });
  } finally {
    await approvalRelay.close();
  }
}

/* ── 10. 子进程入口缺环境变量 → 拒绝启动(exit 2,不静默起一个空 server) ── */
{
  const code = await new Promise<number | null>((resolve) => {
    const child = spawn(process.execPath, [childEntry], {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      env: { ELECTRON_RUN_AS_NODE: "1", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
    });
    child.once("exit", (c) => resolve(c));
    child.once("error", () => resolve(null));
  });
  check("入口:缺中继环境变量 → exit 2(拒绝启动)", code === 2, { code });
}

/* ── 汇总 ── */
console.log("");
if (failures.length > 0) {
  for (const f of failures) console.log(`  FAIL ${f}`);
}
console.log(`host-mcp-stdio-smoke:${passed}/${passed + failures.length} 通过`);
process.exit(failures.length > 0 ? 1 : 0);
