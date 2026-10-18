/**
 * **mcode-host-mcp 核心(headMcpServer.ts)的无头回归** —— ARC-006 桥 2 的第一片。
 *
 * 覆盖(判据全部立在"调用方看到的结果"上):
 *   1. ★ 工具表就是 `appMcpTools()` 的**同一份**:名字/说明/inputSchema 逐项与
 *      `appToolDescriptors()`(同一套 zod→JSON Schema 转换)深相等;不是另写的表。
 *   2. ★ 未知工具名 → 明确失败(可区分的 `unknown_tool`),异常不穿透、执行器不被调。
 *   3. 参数不合 `inputSchema` → 明确失败(`invalid_arguments`),未声明字段被剥掉。
 *   4. ★ 危险档无审批端口 → fail-closed(`approval_unavailable`),**参数伪造
 *      `approved: true` 也绕不过**;审批端口请求失败同样 fail-closed。
 *   5. 审批拒绝 → `approval_denied` + 用户给的理由,不执行;批准 → 执行器被调一次、参数原样。
 *   6. ★ 安全档无审批端口的行为与 Agent 侧一致(不是猜的:同一条 `invokeAppTool` 真调,
 *      两个方向并排断言 —— 只读都执行、写都拒绝且都不执行审批端口不存在的分支)。
 *   7. 四类失败码两两不同。
 *
 * Run: bash apps/desktop/scripts/host-mcp-server-smoke/run.sh
 */
import assert from "node:assert/strict";
import type { ProviderContext, ApprovalRequest, ProviderApprovalDecision } from "@contracts/provider";
import { appMcpTools, invokeAppTool } from "@main/appControl/tools.js";
import { appToolDescriptors } from "@main/appControl/engineTools.js";
import { clearRpcHandlers, recordRpcHandler } from "@main/appControl/registry.js";
import { setRendererPortForTest } from "@main/appControl/uiBridge.js";
import {
  approvalTierOf,
  createHostMcpServer,
  type HostMcpApprovalPort,
  type HostMcpPorts,
  type HostMcpToolSpec,
} from "@main/mcp/hostMcpServer.js";

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

const textOf = (r: { content: Array<{ type: string; text?: string }> }): string =>
  r.content.map((c) => (c.type === "text" ? c.text ?? "" : "")).join("\n");
const codeOf = (r: { structuredContent?: Record<string, unknown> }): unknown =>
  r.structuredContent?.host_mcp_error;

/* ── 0. 夹具:注入表固定一份快照(与生产装配同一份构造),执行器是记录桩 ── */
const TABLE: ReadonlyArray<HostMcpToolSpec> = appMcpTools();

interface Invocation {
  name: string;
  args: unknown;
  approval: HostMcpApprovalPort | null;
}
function makePorts(): { ports: HostMcpPorts; calls: Invocation[] } {
  const calls: Invocation[] = [];
  return {
    calls,
    ports: {
      // ⚠️ 故意返回**同一个数组引用** —— 如果核心内部复制/筛选/重排工具表,
      // 下面 `server.tools() === TABLE` 会立刻红。
      tools: () => TABLE,
      invoke: async (name, args, approval) => {
        calls.push({ name, args, approval });
        return { content: [{ type: "text", text: `执行桩:${name}` }] };
      },
    },
  };
}

function approvalStub(answer: { approved: boolean; reason?: string }): {
  port: HostMcpApprovalPort;
  seen: Array<{ name: string; args: unknown }>;
} {
  const seen: Array<{ name: string; args: unknown }> = [];
  return {
    seen,
    port: {
      request: async (name, args) => {
        seen.push({ name, args });
        return answer;
      },
    },
  };
}

/* ── 1. ★ 工具表与 appMcpTools() 是同一份(不另写、不筛选、不加工具) ── */
{
  const { ports } = makePorts();
  const server = createHostMcpServer(ports, null);
  check("★ tools() 就是注入的那一份(引用相等,没有复制/重排)", server.tools() === TABLE, server.tools().length);

  const listed = server.listTools();
  const expected = appToolDescriptors();
  check(
    "★ 工具数量与 appMcpTools() 一致",
    listed.length === TABLE.length && TABLE.length === expected.length,
    { listed: listed.length, table: TABLE.length, descriptors: expected.length },
  );
  deepEqual(
    "★ 逐个 name + description + inputSchema 与 appToolDescriptors() 深相等",
    listed,
    expected,
  );
  check(
    "★ 工具名集合与 appMcpTools() 逐一相等(顺序也一致)",
    listed.map((t) => t.name).join(",") === TABLE.map((t) => t.name).join(","),
    listed.map((t) => t.name),
  );
  // 反向:核心没有多出任何“自己的”工具(多一个就是第二张表)。
  check(
    "★ 没有表外工具(核心只投影注入表)",
    listed.every((t) => TABLE.some((s) => s.name === t.name)),
    listed.filter((t) => !TABLE.some((s) => s.name === t.name)).map((t) => t.name),
  );
}

/* ── 2. ★ 未知工具名 → 明确错误,不抛、不执行 ── */
{
  const { ports, calls } = makePorts();
  const server = createHostMcpServer(ports, null);
  for (const name of ["app_not_a_tool", "project_delete", ""]) {
    let r: Awaited<ReturnType<typeof server.callTool>> | undefined;
    let threw: unknown;
    try {
      r = await server.callTool(name, { anything: 1 });
    } catch (err) {
      threw = err;
    }
    check(
      `★ 未知工具名「${name}」→ 明确失败且不抛异常`,
      threw === undefined && r?.isError === true && codeOf(r) === "unknown_tool",
      threw ?? { code: r ? codeOf(r) : "(无结果)", text: r ? textOf(r) : "" },
    );
  }
  check("★ 未知工具名不会到执行器", calls.length === 0, calls);
}

/* ── 3. 参数不合 inputSchema → invalid_arguments;未声明字段被剥掉 ── */
{
  const { ports, calls } = makePorts();
  const server = createHostMcpServer(ports, null);
  const bad = await server.callTool("app_api_call", { not_method: 1 });
  check(
    "参数不合 schema → invalid_arguments 且不执行",
    bad.isError === true && codeOf(bad) === "invalid_arguments" && calls.length === 0,
    { code: codeOf(bad), calls: calls.length },
  );
  const nonObject = await server.callTool("app_api_call", "garbage");
  check(
    "非对象参数 → invalid_arguments(不抛)",
    nonObject.isError === true && codeOf(nonObject) === "invalid_arguments",
    { code: codeOf(nonObject) },
  );

  // 伪造位就算塞进顶层,也会被 zod 剥掉,到不了执行器。
  const forger = approvalStub({ approved: true });
  const s2 = createHostMcpServer(ports, forger.port);
  const ok = await s2.callTool("app_api_call", { method: "setting.get", input: { key: "k" }, approved: true, operation_id: undefined });
  check("合法调用带伪造位仍执行(伪造位不影响判据)", ok.isError !== true, textOf(ok));
  check(
    "★ 未声明字段 approved 被剥掉,执行器收到的参数里没有它",
    calls.length === 1 && !("approved" in (calls[0]!.args as Record<string, unknown>)),
    calls[0]?.args,
  );
}

/* ── 4. ★ 危险档没有审批端口 → fail-closed,参数伪造绕不过 ── */
{
  const dangerCases: Array<{ name: string; args: Record<string, unknown>; why: string }> = [
    { name: "app_api_call", args: { method: "project.delete", input: { id: "p1" } }, why: "project.delete=danger" },
    { name: "app_ui", args: { action: "set_pref", key: "permissionMode", value: "bypassPermissions" }, why: "permissionMode=danger" },
  ];
  for (const c of dangerCases) {
    const { ports, calls } = makePorts();
    const server = createHostMcpServer(ports, null);
    const r = await server.callTool(c.name, c.args);
    check(
      `★ 危险档无审批端口 fail-closed(${c.why})`,
      r.isError === true && codeOf(r) === "approval_unavailable" && calls.length === 0 &&
        textOf(r).includes("未执行"),
      { code: codeOf(r), calls: calls.length, text: textOf(r) },
    );
  }
  // ★ 用参数伪造批准:顶层 / input 里各塞一份,都必须仍被拒。
  {
    const { ports, calls } = makePorts();
    const server = createHostMcpServer(ports, null);
    const forged = await server.callTool("app_api_call", {
      method: "project.delete",
      input: { id: "p1", approved: true },
      approved: true,
    });
    check(
      "★ 伪造 approved:true(顶层 + input 内)→ 仍 fail-closed,执行器未被调",
      forged.isError === true && codeOf(forged) === "approval_unavailable" && calls.length === 0,
      { code: codeOf(forged), calls: calls.length },
    );
  }
  // 写档同一条纪律。
  {
    const { ports, calls } = makePorts();
    const server = createHostMcpServer(ports, null);
    const r = await server.callTool("app_api_call", { method: "session.rename", input: { id: "s1", title: "x" } });
    check(
      "写档无审批端口 fail-closed(session.rename)",
      r.isError === true && codeOf(r) === "approval_unavailable" && calls.length === 0,
      { code: codeOf(r), calls: calls.length },
    );
  }
  // 自带工具的写档:app_session_new 在 Agent 侧无条件 gateAppAction("write")。
  {
    const { ports, calls } = makePorts();
    const server = createHostMcpServer(ports, null);
    const r = await server.callTool("app_session_new", { prompt: "hi" });
    check(
      "自带写工具无审批端口 fail-closed(app_session_new)",
      r.isError === true && codeOf(r) === "approval_unavailable" && calls.length === 0,
      { code: codeOf(r), calls: calls.length },
    );
  }
  // 审批端口存在但请求失败(宿主窗口没了 / 桥断了)→ 同样不得放行。
  {
    const { ports, calls } = makePorts();
    const broken: HostMcpApprovalPort = {
      request: async () => {
        throw new Error("主窗口已销毁");
      },
    };
    const server = createHostMcpServer(ports, broken);
    const r = await server.callTool("app_api_call", { method: "project.delete", input: { id: "p1" } });
    check(
      "审批端口请求抛错 → fail-closed,不执行",
      r.isError === true && codeOf(r) === "approval_unavailable" && calls.length === 0,
      { code: codeOf(r), calls: calls.length },
    );
  }
}

/* ── 5. 审批拒绝 / 批准 ── */
{
  const { ports, calls } = makePorts();
  const denial = approvalStub({ approved: false, reason: "这个项目还要用" });
  const server = createHostMcpServer(ports, denial.port);
  const r = await server.callTool("app_api_call", { method: "project.delete", input: { id: "p1" } });
  check(
    "审批拒绝 → approval_denied + 用户理由,不执行",
    r.isError === true && codeOf(r) === "approval_denied" && textOf(r).includes("这个项目还要用") && calls.length === 0,
    { code: codeOf(r), calls: calls.length, text: textOf(r) },
  );
  check(
    "审批请求收到的是校验后的参数(方法名原样)",
    denial.seen.length === 1 && (denial.seen[0]!.args as { method?: string }).method === "project.delete",
    denial.seen,
  );
}
{
  const { ports, calls } = makePorts();
  const granted = approvalStub({ approved: true });
  const server = createHostMcpServer(ports, granted.port);
  const args = { method: "project.delete", input: { id: "p1" } };
  const r = await server.callTool("app_api_call", args);
  check("审批通过 → 执行器被调一次", !r.isError && calls.length === 1, { isError: r.isError, calls: calls.length });
  deepEqual("★ 执行器收到的参数原样(与调用方给的一致)", calls[0]?.args, args);
  check("执行器拿到的就是注入的审批端口", calls[0]?.approval === granted.port);
  check("审批通过 → 结果原样透传", textOf(r) === "执行桩:app_api_call", textOf(r));
}
{
  // 安全档即使有审批端口也不该打扰用户。
  const { ports, calls } = makePorts();
  const watched = approvalStub({ approved: true });
  const server = createHostMcpServer(ports, watched.port);
  const r = await server.callTool("app_api_list", { domain: "project" });
  check(
    "只读工具不问审批(端口在也不调用)",
    !r.isError && watched.seen.length === 0 && calls.length === 1,
    { asked: watched.seen.length },
  );
}

/* ── 6. ★ 安全档无审批端口:与 Agent 侧同一条 invokeAppTool 并排验 ── */
// Agent 侧的"无审批通道":ProviderContext 没有 requestApproval(见 gateAppAction:
// `if (!ctx.requestApproval) return "...没有可用的审批通道..."`)。
const agentCtxNoApproval = {
  getPermissionMode: () => "default",
} as unknown as ProviderContext;

clearRpcHandlers();
const rpcCalls: Record<string, number> = {};
recordRpcHandler("setting:get", async (_e, raw) => {
  rpcCalls["setting:get"] = (rpcCalls["setting:get"] ?? 0) + 1;
  const input = raw as { key?: string };
  return { value: `v:${input.key ?? ""}` };
});
recordRpcHandler("session:rename", async () => {
  rpcCalls["session:rename"] = (rpcCalls["session:rename"] ?? 0) + 1;
  return { session: { id: "s1", title: "x" } };
});

{
  // ① 只读工具:两侧都执行(核心 = 真 invokeAppTool 装配,approval 端口缺失)。
  const ports: HostMcpPorts = {
    tools: () => TABLE,
    invoke: (name, args) => invokeAppTool(name, args, "host-mcp-smoke", agentCtxNoApproval),
  };
  const server = createHostMcpServer(ports, null);
  const viaHost = await server.callTool("app_api_list", { domain: "project" });
  const viaAgent = await invokeAppTool("app_api_list", { domain: "project" }, "host-mcp-smoke", agentCtxNoApproval);
  check(
    "★ 只读工具无审批端口:宿主核心执行成功(与 Agent 侧一致)",
    !viaHost.isError,
    textOf(viaHost),
  );
  check(
    "★ 只读工具:宿主核心与 Agent 侧结果文本一致",
    textOf(viaHost) === textOf(viaAgent),
    { host: textOf(viaHost).slice(0, 80), agent: textOf(viaAgent).slice(0, 80) },
  );

  // ② app_api_call 的只读方法(setting.get):两侧都执行,结果一致。
  const before = rpcCalls["setting:get"] ?? 0;
  const hostRead = await server.callTool("app_api_call", { method: "setting.get", input: { key: "k1" } });
  const agentRead = await invokeAppTool("app_api_call", { method: "setting.get", input: { key: "k1" } }, "host-mcp-smoke", agentCtxNoApproval);
  check(
    "★ app_api_call 只读方法无审批端口:宿主核心执行(与 Agent 侧一致)",
    !hostRead.isError && !agentRead.isError && (rpcCalls["setting:get"] ?? 0) === before + 2,
    { hostError: hostRead.isError, agentError: agentRead.isError, rpc: rpcCalls["setting:get"] },
  );

  // ③ 写方法:两侧都拒绝、两侧都没执行 handler。
  const beforeRename = rpcCalls["session:rename"] ?? 0;
  const hostWrite = await server.callTool("app_api_call", { method: "session.rename", input: { id: "s1", title: "x" } });
  const agentWrite = await invokeAppTool("app_api_call", { method: "session.rename", input: { id: "s1", title: "x" } }, "host-mcp-smoke", agentCtxNoApproval);
  check(
    "★ 写方法无审批通道:宿主核心拒绝(approval_unavailable)",
    hostWrite.isError === true && codeOf(hostWrite) === "approval_unavailable",
    { code: codeOf(hostWrite) },
  );
  check(
    "★ 写方法无审批通道:Agent 侧也拒绝(fail-closed 口径一致)",
    agentWrite.isError === true && textOf(agentWrite).includes("没有可用的审批通道"),
    textOf(agentWrite).slice(0, 160),
  );
  check(
    "★ 写方法:两侧都没有执行 RPC handler",
    (rpcCalls["session:rename"] ?? 0) === beforeRename,
    rpcCalls["session:rename"],
  );

  // ④ 不在目录里的方法:invokeAppTool 在任何副作用之前就明确拒绝 → 两侧都不需要审批。
  const agentUnknown = await invokeAppTool("app_api_call", { method: "deploy.everything" }, "host-mcp-smoke", agentCtxNoApproval);
  check(
    "未知方法在 Agent 侧被拒且与审批无关(先于审批的 methodNotFound,不是审批拒绝)",
    agentUnknown.isError === true && textOf(agentUnknown).includes("没有这个方法") &&
      !textOf(agentUnknown).includes("没有可用的审批通道"),
    textOf(agentUnknown).slice(0, 160),
  );
  const hostUnknown = await server.callTool("app_api_call", { method: "deploy.everything" });
  check(
    "未知方法经宿主核心也不需要审批(与 Agent 侧同档:safe)",
    codeOf(hostUnknown) !== "approval_unavailable",
    { code: codeOf(hostUnknown), text: textOf(hostUnknown).slice(0, 160) },
  );
}

/* ── 7. app_ui 分档:只有 set_pref / interrupt_session 会弹卡(与 runUiAction 逐条对齐) ── */
{
  // 界面动作 notify 在 Agent 侧不 gate → 无审批端口也执行。
  setRendererPortForTest({
    executeJavaScript: async () => JSON.stringify({ ok: true, data: { notified: true } }),
  });
  try {
    const ports: HostMcpPorts = {
      tools: () => TABLE,
      invoke: (name, args) => invokeAppTool(name, args, "host-mcp-smoke", agentCtxNoApproval),
    };
    const server = createHostMcpServer(ports, null);
    const notified = await server.callTool("app_ui", { action: "notify", title: "hi" });
    check("app_ui notify 不需要审批(与 Agent 侧一致)", !notified.isError, textOf(notified));

    const setPref = await server.callTool("app_ui", { action: "set_pref", key: "locale", value: "en" });
    check(
      "app_ui set_pref 是写档 → 无端口 fail-closed",
      setPref.isError === true && codeOf(setPref) === "approval_unavailable",
      { code: codeOf(setPref) },
    );
  } finally {
    setRendererPortForTest(null);
  }
}

/* ── 8. 分档函数本身(approvalTierOf)与四类错误码可区分 ── */
{
  check("分档:app_api_call 危险方法 = danger", approvalTierOf("app_api_call", { method: "project.delete" }) === "danger");
  check("分档:app_api_call 写方法 = write", approvalTierOf("app_api_call", { method: "session.rename" }) === "write");
  check("分档:app_api_call 只读方法 = safe", approvalTierOf("app_api_call", { method: "setting.get" }) === "safe");
  check("分档:app_api_call 不开放(blocked)= safe(由执行器直接拒)", approvalTierOf("app_api_call", { method: "customModel.getToken" }) === "safe");
  check("分档:app_api_call 未知方法 = safe(执行器先拒)", approvalTierOf("app_api_call", { method: "deploy.everything" }) === "safe");
  check("分档:app_api_call 通道写法(project:delete)= danger", approvalTierOf("app_api_call", { method: "project:delete" }) === "danger");
  check("分档:app_ui set_pref permissionMode = danger", approvalTierOf("app_ui", { action: "set_pref", key: "permissionMode" }) === "danger");
  check("分档:app_ui set_pref locale = write", approvalTierOf("app_ui", { action: "set_pref", key: "locale" }) === "write");
  check("分档:app_ui interrupt_session = write", approvalTierOf("app_ui", { action: "interrupt_session" }) === "write");
  check("分档:app_ui open_session = safe", approvalTierOf("app_ui", { action: "open_session" }) === "safe");
  check("分档:app_ui_state = safe", approvalTierOf("app_ui_state", {}) === "safe");
  check("分档:app_session_new = write", approvalTierOf("app_session_new", {}) === "write");
  check("分档:app_api_list = safe", approvalTierOf("app_api_list", {}) === "safe");

  const codes = new Set<string>();
  const { ports } = makePorts();
  const server = createHostMcpServer(ports, null);
  const r1 = await server.callTool("app_nope", {});
  const r2 = await server.callTool("app_api_call", {});
  const r3 = await server.callTool("app_api_call", { method: "project.delete" });
  codes.add(String(codeOf(r1)));
  codes.add(String(codeOf(r2)));
  codes.add(String(codeOf(r3)));
  const refusal = await createHostMcpServer(ports, approvalStub({ approved: false }).port)
    .callTool("app_api_call", { method: "project.delete" });
  codes.add(String(codeOf(refusal)));
  check(
    "四类失败码两两不同(unknown_tool / invalid_arguments / approval_unavailable / approval_denied)",
    codes.size === 4,
    [...codes],
  );
}

/* ── 汇总 ── */
console.log("");
if (failures.length > 0) {
  for (const f of failures) console.log(`  FAIL ${f}`);
}
console.log(`host-mcp-server-smoke:${passed}/${passed + failures.length} 通过`);
process.exit(failures.length > 0 ? 1 : 0);
