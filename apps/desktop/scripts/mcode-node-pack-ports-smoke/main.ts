/**
 * 【W19】**`nodePackProductionPorts.ts` 的生产端口回归** —— 与 `mcode-node-pack-smoke`
 * 验的是**两个不同的东西**。
 *
 * `mcode-node-pack-smoke`(393 条)把生产端口整个替换成抛错的桩
 * (`productionPortsStub.ts`),所以它证明的是「**节点外壳 + Node-RED 接线**」。
 * 本套反过来:**不换生产端口**,把四个宿主依赖换桩,直接驱动
 * `productionNodePackServices()` 的 `execute` / `subscribe` —— 证明的是
 * 「**生产端口交给宿主什么、拒绝什么**」。
 *
 * ## 覆盖的七类生产逻辑(卡里的表)
 *
 *   A. `chooseBranch` 模型选路的两条 fail-closed + 正控;
 *   B. `runSelectedSession` 的会话/提示词/事件守卫(agent.run / conversation.run);
 *   C. `module.invoke` 的 `projectPath` 强制(安全边界 #3);
 *   D. `node-red.call` 的路径围栏(安全边界 #1,六种拒绝 + 边界正控);
 *   E. `node-red.call` 的部署审批(安全边界 #2,Deny 必拒 + Allow 放行);
 *   F. `chooseBranch` 的真人弹窗(按钮/cancelId/返回码映射/无窗口 fail-closed);
 *   G. `trigger.subscribe` 的 `triggerKind !== "event"` 拒绝 + 事件过滤;
 *   H. 未支持操作拒绝 + 两种 agent 操作的 nodeType。
 *
 * ## 桩的边界(见各 stub 文件头)
 *
 *   - `electron` —— 记录型:弹窗返回值和按钮文案都能验;
 *   - `@main/window.js` —— 可摆「有窗口 / 无窗口 / 窗口已销毁」;
 *   - `@main/claude/RuntimeManager.js` —— 可摆「正常/报错/中断/没有 turn.done/忙」;
 *   - `@main/modules/service.js` —— 记录 `invoke` 收到的 payload。
 *   - **真** `SessionRepo` / `ProjectRepo`(sql.js,数据根是 mktemp 临时目录)。
 *
 * ## 验不了的(明说,不冒充)
 *
 *   - 真人看到弹窗的视觉/焦点/键盘 —— 无头环境给不出;
 *   - 真三引擎 turn 的生命周期 —— 换的是桩,验的是「端口交给引擎什么」;
 *   - 真 Node-RED 的 HTTP 往返与部署副作用 —— fetch 是注入的假实现;
 *   - `Mcode Host project not found` 分支 —— `sessions.project_id` 有外键
 *     (`REFERENCES projects(id) ON DELETE CASCADE`),构造不出「会话在、项目没了」的行。
 *
 * Run: bash scripts/mcode-node-pack-ports-smoke/run.sh
 */
import { initDb } from "@main/store/db.js";
import { ProjectRepo, SessionRepo } from "@main/store/repositories.js";
import { productionNodePackServices } from "@main/workflowEngines/nodePackProductionPorts.js";
import type { NodePackAction } from "@main/workflowEngines/nodePackHost.js";
import type { EngineRuntimeStatus } from "@main/workflowEngines/runtimeSupervisor.js";
import type { RuntimeEvent } from "@contracts/runtime";
import type { Session } from "@contracts/session";
import {
  messageBoxCalls, pushMessageBoxResponse, resetDialog,
} from "./stubs/electron.js";
import { getMainWindow, setMainWindowState } from "./stubs/window.js";
import {
  emitEvent, externalEvents, resetRuntime, scriptNextTurn, sendTurnCalls, setSessionBusy,
} from "./stubs/runtimeManager.js";
import { failNextInvoke, invokeCalls, resetModuleHost, setNextInvokeResult } from "./stubs/moduleService.js";

/* ── 断言助手(与仓库其它 smoke 同款) ── */
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
  check(name, Object.is(actual, expected), { actual, expected });
}
/** 期望抛错:返回实际 message,断言里带上它,失败时能看出是哪条分支的话。 */
async function throws(name: string, fn: () => Promise<unknown>, expectedPhrase: string): Promise<void> {
  try {
    await fn();
    check(name, false, { threw: false, expected: expectedPhrase });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    check(name, message.includes(expectedPhrase), { actual: message, expected: expectedPhrase });
  }
}
/**
 * 正控用:把「本该成功」的调用包起来。
 * **不许让它直接把整套崩掉** —— 若某条拒绝被改成恒真,这里要打出一条 FAIL
 * (「本该成功却抛了」),而不是一条未捕获异常把后面的段全盖掉。
 */
async function attempt<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/* ── 假 fetch:记调用、按队列喂响应 ── */
interface FetchCall { url: string; init: Record<string, unknown> }
const fetchCalls: FetchCall[] = [];
const fetchQueue: Array<{ ok: boolean; status: number; body: string }> = [];
function queueFetch(next: { ok?: boolean; status?: number; body?: string }): void {
  fetchQueue.push({ ok: next.ok ?? true, status: next.status ?? 200, body: next.body ?? "{}" });
}
function resetFetch(): void {
  fetchCalls.length = 0;
  fetchQueue.length = 0;
}
(globalThis as unknown as { fetch: unknown }).fetch = async (url: string, init: Record<string, unknown>) => {
  fetchCalls.push({ url, init });
  const next = fetchQueue.shift();
  if (!next) throw new Error("fetch 被调了但脚本没喂响应 —— queueFetch 少了一次");
  return { ok: next.ok, status: next.status, text: async () => next.body };
};

/* ── 引擎状态与服务的构造 ── */
const RUNNING: EngineRuntimeStatus = {
  state: "running", port: 1880, reason: null, engineId: "node-red", instanceEpoch: "ep-1",
};
let status: EngineRuntimeStatus = { ...RUNNING };
let adminToken: string | undefined = "tok-smoke";
function services(resolveWorkflow?: (tabId: string) => string | null) {
  return productionNodePackServices(() => status, adminToken, resolveWorkflow);
}

/* ── 会话夹具(真库) ── */
const PROJECT_PATH = "D:\\smoke\\project";
const NOW = Date.now();
function makeSession(over: Partial<Session> & { id: string }): Session {
  return {
    projectId: "p_ports",
    providerId: "claude-sdk",
    claudeSessionId: null,
    kind: "chat",
    parentSessionId: null,
    nodeId: null,
    title: "冒烟会话",
    status: "idle",
    model: "",
    effort: "default",
    permissionMode: "default",
    workflowId: "",
    customModelId: null,
    envMode: "local",
    worktreePath: null,
    archived: false,
    pinnedAt: null,
    contextSnapshot: null,
    todos: null,
    subagents: null,
    planDraft: null,
    turnFiles: null,
    usageHistory: null,
    bookmarks: null,
    subagentTranscripts: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

await initDb();
ProjectRepo.create({
  id: "p_ports", name: "冒烟项目", path: PROJECT_PATH, archived: false,
  group: null, sortOrder: 0, pinnedAt: null, createdAt: NOW, updatedAt: NOW,
});
SessionRepo.create(makeSession({ id: "s_chat" }));
SessionRepo.create(makeSession({ id: "s_wt", worktreePath: "D:\\smoke\\wt" }));
SessionRepo.create(makeSession({ id: "s_side", kind: "side" }));
SessionRepo.create(makeSession({ id: "s_automation", kind: "automation" }));
SessionRepo.create(makeSession({ id: "s_web", providerId: "web" }));

/** 摆一轮引擎演出:text deltas + 可选 error + 可选 turn.done。 */
function scriptTurn(opts: {
  sessionId: string;
  text?: string;
  error?: string;
  reason?: "end_turn" | "max_tokens" | "tool_use" | "interrupted" | "error" | null;
}): void {
  scriptNextTurn((emit) => {
    if (opts.text !== undefined) {
      emit({ type: "text.delta", sessionId: opts.sessionId, messageId: "m1", text: opts.text } as RuntimeEvent);
    }
    if (opts.error !== undefined) {
      emit({ type: "error", sessionId: opts.sessionId, message: opts.error } as RuntimeEvent);
    }
    if (opts.reason !== null) {
      emit({ type: "turn.done", sessionId: opts.sessionId, reason: opts.reason ?? "end_turn" } as RuntimeEvent);
    }
  });
}
function resetAll(): void {
  resetRuntime();
  resetDialog();
  resetFetch();
  resetModuleHost();
  setMainWindowState("live");
  status = { ...RUNNING };
  adminToken = "tok-smoke";
}

/* ═════════════════════════ A. chooseBranch:模型选路 ═════════════════════════ */

console.log("\nA · chooseBranch 模型选路:两条 fail-closed + 正控");

{
  const branch = (params: Record<string, unknown>) => services().execute("branch.decide", params);

  for (const [label, portCount] of [
    ["0", 0], ["13", 13], ["2.5", 2.5], ["字符串 \"3\"", "3"],
  ] as Array<[string, unknown]>) {
    resetAll();
    await throws(`portCount ${label} → 拒绝(必须是 1..12 的整数)`,
      () => branch({ portCount, decider: "model", params: { sessionId: "s_chat" } }),
      "Branch portCount invalid");
  }

  resetAll();
  await throws("decider 写了个不认识的词 → 拒绝",
    () => branch({ portCount: 2, decider: "robot", params: { sessionId: "s_chat" } }),
    "Unknown branch decider");

  // 缺 params(`paramsOf` 的第一道):★ 拒绝
  resetAll();
  await throws("缺 params → 拒绝(Node params missing)",
    () => branch({ portCount: 2, decider: "model" }),
    "Node params missing");

  // 模型返回非数字:★ 拒绝
  resetAll();
  scriptTurn({ sessionId: "s_chat", text: "abc" });
  await throws("模型返回 \"abc\" → 拒绝(不是单个数字口)",
    () => branch({ portCount: 3, decider: "model", params: { sessionId: "s_chat" } }),
    "Model branch did not return a single numeric port");

  // 带小数 / 负号 / 前导零都不是合法「单个整数」
  for (const text of ["2.5", "-1", "03"]) {
    resetAll();
    scriptTurn({ sessionId: "s_chat", text });
    await throws(`模型返回 ${JSON.stringify(text)} → 拒绝(不是单个数字口)`,
      () => branch({ portCount: 3, decider: "model", params: { sessionId: "s_chat" } }),
      "Model branch did not return a single numeric port");
  }

  // 越界:`port >= portCount` 的**边界两侧各一条**
  resetAll();
  scriptTurn({ sessionId: "s_chat", text: "5" });
  await throws("模型返回 \"5\" 而 portCount=3 → 拒绝(越界)",
    () => branch({ portCount: 3, decider: "model", params: { sessionId: "s_chat" } }),
    "Model branch port out of range");

  resetAll();
  scriptTurn({ sessionId: "s_chat", text: "3" });
  await throws("模型返回 \"3\" 而 portCount=3 → 拒绝(`>=` 边界,3 不合法)",
    () => branch({ portCount: 3, decider: "model", params: { sessionId: "s_chat" } }),
    "Model branch port out of range");

  // ★ 正控:合法数字必须通过
  resetAll();
  scriptTurn({ sessionId: "s_chat", text: "2\n" });
  const pickedResult = await attempt(() => branch({ portCount: 3, decider: "model", params: { sessionId: "s_chat" } }));
  check("★ 正控:模型返回 \"2\" 没有被拒", pickedResult.ok,
    { error: pickedResult.ok ? undefined : pickedResult.error });
  eq("★ 正控:模型返回 \"2\"(带换行,trim 后)而 portCount=3 → port=2",
    (pickedResult.ok ? pickedResult.value as { port: number } : { port: -1 }).port, 2);
  eq("★ 正控:模型选路只起了一次引擎 turn", sendTurnCalls.length, 1);

  resetAll();
  scriptTurn({ sessionId: "s_chat", text: "0" });
  const zeroResult = await attempt(() => branch({ portCount: 1, decider: "model", params: { sessionId: "s_chat" } }));
  check("★ 正控:portCount=1 时模型返回 \"0\" 没有被拒", zeroResult.ok,
    { error: zeroResult.ok ? undefined : zeroResult.error });
  eq("★ 正控:portCount=1 时模型返回 \"0\" → port=0(下界合法)",
    (zeroResult.ok ? zeroResult.value as { port: number } : { port: -1 }).port, 0);

  // 交给模型的 prompt 形状(端口范围 + 节点上下文 + note 都进去)
  resetAll();
  scriptTurn({ sessionId: "s_chat", text: "1" });
  const promptRun = await attempt(() => branch({
    portCount: 3, decider: "model", input: { q: "ask" },
    params: { sessionId: "s_chat", note: "这是节点备注" },
  }));
  check("模型 prompt 用例本身跑通", promptRun.ok, { error: promptRun.ok ? undefined : promptRun.error });
  const prompt = sendTurnCalls[0]?.input.prompt ?? "";
  check("模型 prompt 里写了合法端口范围 0..2", prompt.includes("integer 0 to 2"), prompt.slice(0, 120));
  check("模型 prompt 里带了节点上下文(input 的 JSON)", prompt.includes("\"q\":\"ask\""), prompt.slice(0, 200));
  check("模型 prompt 里带了节点备注", prompt.includes("这是节点备注"), prompt.slice(0, 200));

  // 模型选路也要过会话校验(它复用 runSelectedSession):缺 sessionId 必须拒
  resetAll();
  await throws("模型选路缺 sessionId → 拒绝(复用 runSelectedSession 的会话守卫)",
    () => branch({ portCount: 2, decider: "model", params: {} }),
    "Mcode sessionId is required");
}

/* ═════════════════════════ B. runSelectedSession 的守卫 ═════════════════════════ */

console.log("\nB · runSelectedSession:会话 / 提示词 / 事件守卫");

{
  const run = (payload: Record<string, unknown>, resolve?: (tabId: string) => string | null) =>
    services(resolve).execute("agent.run", payload);

  resetAll();
  await throws("缺 sessionId → 拒绝",
    () => run({ params: {} }),
    "Mcode sessionId is required");

  resetAll();
  await throws("sessionId 不存在 → 拒绝",
    () => run({ params: { sessionId: "s_nope" } }),
    "Mcode Host session missing or not user-visible");

  resetAll();
  await throws("side 会话(hidden)→ 拒绝",
    () => run({ params: { sessionId: "s_side" } }),
    "Mcode Host session missing or not user-visible");

  resetAll();
  await throws("automation 会话(hidden)→ 拒绝",
    () => run({ params: { sessionId: "s_automation" } }),
    "Mcode Host session missing or not user-visible");

  resetAll();
  await throws("provider 不是三个原生引擎之一 → 拒绝",
    () => run({ params: { sessionId: "s_web" } }),
    "Mcode Host session is not backed by a supported native engine");

  resetAll();
  await throws("instruction / input 都空 → 拒绝",
    () => run({ params: { sessionId: "s_chat" } }),
    "Mcode agent instruction/input is empty");

  resetAll();
  await throws("prompt 超过 30k → 拒绝",
    () => run({ params: { sessionId: "s_chat" }, instruction: "x".repeat(30_001) }),
    "Mcode agent prompt too large");

  // ★ 正控:合法一轮跑通,且交给引擎的 prompt/cwd 是拼好的原文
  resetAll();
  scriptTurn({ sessionId: "s_chat", text: "hello" });
  const resultAttempt = await attempt(() => run({
    params: { sessionId: "s_chat" },
    instruction: "Do X", input: { k: 1 },
    nodeId: "n1", tabId: "tab1", runId: "run-123", nodeTitle: "标题",
  }, (tabId) => (tabId === "tab1" ? "wf_1" : null)));
  check("★ 正控:合法一轮 agent.run 没有被拒绝", resultAttempt.ok,
    { error: resultAttempt.ok ? undefined : resultAttempt.error });
  const result = (resultAttempt.ok ? resultAttempt.value : { text: "", artifacts: [], runId: "" }) as {
    text: string; artifacts: unknown; runId: string;
  };
  eq("★ 正控:返回的 text 是引擎流出的原文", result.text, "hello");
  eq("★ 正控:返回的 runId 用了 payload 给的", result.runId, "run-123");
  eq("★ 正控:artifacts 为空数组", JSON.stringify(result.artifacts), "[]");
  eq("★ 正控:引擎收到 instruction 与 input 拼接的 prompt", sendTurnCalls[0]?.input.prompt, "Do X\n\n{\"k\":1}");
  eq("★ 正控:cwd 落到项目路径(worktreePath 为 null)", sendTurnCalls[0]?.input.cwd, PROJECT_PATH);

  const types = externalEvents.map((e) => (e as { type: string }).type);
  eq("★ 正控:三段阶段事件按 queued → progress → result 发出", types.join(","),
    "workflow.node.queued,workflow.node.progress,workflow.node.result");
  const resultEvent = externalEvents[2] as unknown as Record<string, unknown>;
  eq("result 事件带 workflowId(来自 resolveWorkflow 的绑定)", resultEvent.workflowId, "wf_1");
  eq("result 事件带 nodeId", resultEvent.nodeId, "n1");
  eq("result 事件带 runId", resultEvent.runId, "run-123");
  eq("result 事件带 sessionId", resultEvent.sessionId, "s_chat");
  eq("result 事件 status=success", resultEvent.status, "success");

  // 不可信的 tabId 不能提名工作流:resolveWorkflow 返回 null → 不发阶段事件,
  // payload 里自带的 workflowId 也不被采信
  resetAll();
  scriptTurn({ sessionId: "s_chat", text: "ok" });
  const evilAttempt = await attempt(() => run({
    params: { sessionId: "s_chat" }, instruction: "x",
    nodeId: "n1", tabId: "tab-evil", workflowId: "wf_evil",
  }, () => null));
  check("未知 tabId 只是「不提名工作流」,不是拒绝(turn 照常跑完)", evilAttempt.ok,
    { error: evilAttempt.ok ? undefined : evilAttempt.error });
  eq("未知 tabId → resolveWorkflow 返回 null 时不发阶段事件(sidecar 不能自选 board)", externalEvents.length, 0);

  // worktreePath 优先
  resetAll();
  scriptTurn({ sessionId: "s_wt", text: "ok" });
  const wtAttempt = await attempt(() => run({ params: { sessionId: "s_wt" }, instruction: "y" }));
  check("★ 正控:worktreePath 会话的 turn 跑通", wtAttempt.ok,
    { error: wtAttempt.ok ? undefined : wtAttempt.error });
  eq("★ 正控:cwd 优先用会话的 worktreePath", sendTurnCalls[0]?.input.cwd, "D:\\smoke\\wt");

  // 引擎 error 事件 → 抛 + 一条 failed 的 result
  resetAll();
  scriptTurn({ sessionId: "s_chat", text: "part", error: "boom", reason: "end_turn" });
  await throws("引擎 error 事件 → 抛出该错误",
    () => run({ params: { sessionId: "s_chat" }, instruction: "z", nodeId: "n1", tabId: "t" }, () => "wf_2"),
    "boom");
  const failed = externalEvents.filter((e) => (e as { type: string }).type === "workflow.node.result")
    .pop() as unknown as Record<string, unknown>;
  eq("引擎 error → 最后一条 result 事件 status=failed", failed?.status, "failed");
  eq("failed 事件的 error 是引擎原话", failed?.error, "boom");

  // turn.done 不是 end_turn → 拒
  resetAll();
  scriptTurn({ sessionId: "s_chat", text: "partial", reason: "interrupted" });
  await throws("turn.done(interrupted) → 拒绝(没正常收口)",
    () => run({ params: { sessionId: "s_chat" }, instruction: "z" }),
    "Mcode native engine did not finish normally: interrupted");

  // 根本没有 turn.done → 拒
  resetAll();
  scriptTurn({ sessionId: "s_chat", text: "partial", reason: null });
  await throws("没有 turn.done → 拒绝",
    () => run({ params: { sessionId: "s_chat" }, instruction: "z" }),
    "Mcode native engine did not finish normally: no turn.done");

  // 别家会话的事件不算数:只有 other-session 的 turn.done → 同样「没有收口」
  resetAll();
  scriptNextTurn((emit) => {
    emit({ type: "text.delta", sessionId: "s_other", messageId: "m9", text: "别家的" } as RuntimeEvent);
    emit({ type: "turn.done", sessionId: "s_other", reason: "end_turn" } as RuntimeEvent);
  });
  await throws("别家会话的事件被过滤 → 自己的 turn 仍算没有收口",
    () => run({ params: { sessionId: "s_chat" }, instruction: "z" }),
    "no turn.done");

  // 会话忙(sendTurn 返回 null)→ 拒
  resetAll();
  setSessionBusy(true);
  await throws("会话忙(sendTurn 返回 null)→ 拒绝",
    () => run({ params: { sessionId: "s_chat" }, instruction: "z" }),
    "Mcode session busy; native engine did not accept this turn");

  // 回复超过 MAX_TEXT(256k)→ 拒
  resetAll();
  scriptTurn({ sessionId: "s_chat", text: "x".repeat(300_000) });
  await throws("回复超过 256k → 拒绝(输出上限)",
    () => run({ params: { sessionId: "s_chat" }, instruction: "z" }),
    "Mcode agent response exceeded output limit");

  // conversation.run 走同一个入口,只是 nodeType 不同
  resetAll();
  scriptTurn({ sessionId: "s_chat", text: "ok" });
  const convAttempt = await attempt(() => services(() => "wf_c").execute("conversation.run", {
    params: { sessionId: "s_chat" }, instruction: "c", nodeId: "n2", tabId: "t",
  }));
  check("★ 正控:conversation.run 跑通", convAttempt.ok,
    { error: convAttempt.ok ? undefined : convAttempt.error });
  const progress = externalEvents.find((e) => (e as { type: string }).type === "workflow.node.progress") as unknown as Record<string, unknown>;
  eq("conversation.run 的阶段事件 nodeType=mcode-conversation", progress?.nodeType, "mcode-conversation");
}

/* ═════════════════════════ C. module.invoke 的 projectPath 强制 ═════════════════════════ */

console.log("\nC · module.invoke:projectPath 是 Host 授权的落点,缺了必拒");

{
  const invoke = (payload: Record<string, unknown>) => services().execute("module.invoke", payload);

  resetAll();
  await throws("★ 缺 projectPath → 拒绝(不回退默认目录)",
    () => invoke({ moduleId: "m1", contributionId: "c1", path: "x", params: {} }),
    "Module workflow requires a projectPath bound to its Host grant");
  eq("★ 缺 projectPath 时 ModuleHost 一次都没被调(拒绝发生在授权入口,不是下游)", invokeCalls.length, 0);

  resetAll();
  await throws("projectPath 空串 → 同样拒绝",
    () => invoke({ moduleId: "m1", contributionId: "c1", path: "x", params: { projectPath: "" } }),
    "Module workflow requires a projectPath bound to its Host grant");

  resetAll();
  await throws("projectPath 不是字符串(数字)→ 同样拒绝",
    () => invoke({ moduleId: "m1", contributionId: "c1", path: "x", params: { projectPath: 42 } }),
    "Module workflow requires a projectPath bound to its Host grant");

  // ★ 正控:带上 projectPath 必须原样传进 ModuleHost
  resetAll();
  setNextInvokeResult({ rows: [1, 2] });
  const outResult = await attempt(() => invoke({
    moduleId: "m1", contributionId: "c1", path: "data/x.csv", params: { projectPath: PROJECT_PATH },
  }));
  check("★ 正控:带 projectPath 的 invoke 没有被拒绝", outResult.ok,
    { error: outResult.ok ? undefined : outResult.error });
  eq("★ 正控:ModuleHost 收到绑定的 projectPath", invokeCalls[0]?.resource.projectPath, PROJECT_PATH);
  eq("★ 正控:moduleId 原样透传", invokeCalls[0]?.moduleId, "m1");
  eq("★ 正控:contributionId 原样透传", invokeCalls[0]?.contributionId, "c1");
  eq("★ 正控:resource.path 原样透传", invokeCalls[0]?.resource.path, "data/x.csv");
  eq("★ 正控:结果被 JSON 成 text",
    outResult.ok ? (outResult.value as { text: string }).text : null, JSON.stringify({ rows: [1, 2] }));

  resetAll();
  const first = await attempt(() => invoke({ moduleId: "m1", contributionId: "c1", path: "a", params: { projectPath: PROJECT_PATH } }));
  const second = await attempt(() => invoke({ moduleId: "m1", contributionId: "c1", path: "b", params: { projectPath: PROJECT_PATH } }));
  check("★ 正控:两次合法 invoke 都通过", first.ok && second.ok,
    { first: first.ok ? undefined : first.error, second: second.ok ? undefined : second.error });
  check("每次 invoke 的 requestId 各自新生成(不复用)",
    invokeCalls.length === 2 && invokeCalls[0].requestId !== invokeCalls[1].requestId,
    invokeCalls.map((c) => c.requestId));

  resetAll();
  failNextInvoke("module exploded");
  await throws("ModuleHost 抛错 → 原样上抛(不吞)",
    () => invoke({ moduleId: "m1", contributionId: "c1", path: "a", params: { projectPath: PROJECT_PATH } }),
    "module exploded");
}

/* ═════════════════════════ D. node-red.call 路径围栏(安全边界 #1) ═════════════════════════ */

console.log("\nD · node-red.call:路径围栏六种拒绝 + 边界正控");

{
  const call = (payload: Record<string, unknown>) => services().execute("node-red.call", payload);

  // 引擎不可用的三种入口条件(都 fail-closed)
  resetAll();
  status = { state: "stopped", port: null, reason: "idle", engineId: "node-red" };
  await throws("引擎未运行 → 拒绝", () => call({ engineMethod: "GET", enginePath: "/flows" }),
    "Node-RED Host API unavailable");

  resetAll();
  status = { ...RUNNING, port: null };
  await throws("引擎 running 但 port 为 null → 拒绝", () => call({ engineMethod: "GET", enginePath: "/flows" }),
    "Node-RED Host API unavailable");

  resetAll();
  adminToken = undefined;
  await throws("没有 adminToken → 拒绝", () => call({ engineMethod: "GET", enginePath: "/flows" }),
    "Node-RED Host API unavailable");

  // 方法白名单
  resetAll();
  await throws("方法 HEAD 不在白名单 → 拒绝",
    () => call({ engineMethod: "HEAD", enginePath: "/flows" }),
    "Node-RED Host API method invalid");

  // 六种围栏拒绝 —— 每种都要有一条断言,且都不许走到 fetch
  const fenceCases: Array<[string, string, string]> = [
    ["不以 / 开头", "flows", "Invalid Node-RED API path"],
    ["// 开头(协议相对/主机切换)", "//evil.example/x", "Invalid Node-RED API path"],
    ["含 ..(目录穿越)", "/flows/../settings", "Invalid Node-RED API path"],
    ["含 ?(查询串)", "/flows?x=1", "Invalid Node-RED API path"],
    ["含 #(片段)", "/flows#x", "Invalid Node-RED API path"],
    ["超过 256 字符", "/" + "a".repeat(256), "Invalid Node-RED API path"],
  ];
  for (const [label, path, message] of fenceCases) {
    resetAll();
    await throws(`路径${label} → 拒绝`, () => call({ engineMethod: "GET", enginePath: path }), message);
    eq(`路径${label} → 一次 fetch 都没发`, fetchCalls.length, 0);
  }

  // ★ 正控:合法 GET 原样打到引擎,并且**不**弹审批框
  resetAll();
  queueFetch({ body: "{\"ok\":1}" });
  const gotResult = await attempt(() => call({ engineMethod: "get", enginePath: "/flows" }));
  check("★ 正控:合法 GET /flows 没有被围栏拒绝", gotResult.ok, { error: gotResult.ok ? undefined : gotResult.error });
  const got = gotResult.ok ? gotResult.value as { text: string; status: number } : { text: "", status: 0 };
  eq("★ 正控:合法 GET /flows 返回引擎正文", got.text, "{\"ok\":1}");
  eq("★ 正控:GET 的 URL 是 127.0.0.1:端口 + 原路径", fetchCalls[0]?.url, "http://127.0.0.1:1880/flows");
  eq("★ 正控:GET 的 method 归一成大写 GET", fetchCalls[0]?.init.method, "GET");
  const headers = (fetchCalls[0]?.init.headers ?? {}) as Record<string, string>;
  eq("★ 正控:带 Bearer adminToken", headers.Authorization, "Bearer tok-smoke");
  eq("★ 正控:GET 不带 Content-Type", headers["Content-Type"], undefined);
  eq("★ 正控:GET 不带 body", fetchCalls[0]?.init.body, undefined);
  eq("★ 正控:GET 不弹部署审批", messageBoxCalls.length, 0);
  eq("★ 正控:返回 status 是 HTTP 状态", got.status, 200);

  // 长度边界:恰好 256 通过
  resetAll();
  queueFetch({ body: "long-ok" });
  const exactResult = await attempt(() => call({ engineMethod: "GET", enginePath: "/" + "b".repeat(255) }));
  check("★ 边界:路径恰好 256 字符没有被围栏拒绝", exactResult.ok,
    { error: exactResult.ok ? undefined : exactResult.error });
  eq("★ 边界:路径恰好 256 字符 → 通过(fetch 发出)",
    exactResult.ok ? (exactResult.value as { text: string }).text : null, "long-ok");

  // 非 2xx → 抛,正文截断到 500
  resetAll();
  queueFetch({ ok: false, status: 503, body: "x".repeat(900) });
  let httpMessage = "";
  try {
    await call({ engineMethod: "GET", enginePath: "/flows" });
  } catch (err) {
    httpMessage = err instanceof Error ? err.message : String(err);
  }
  check("引擎返回 503 → 抛 HTTP 状态", httpMessage.includes("Node-RED API HTTP 503:"), httpMessage.slice(0, 60));
  eq("HTTP 错误正文截断到 500 字符", httpMessage.length, "Node-RED API HTTP 503: ".length + 500);

  // 成功正文截断到 MAX_TEXT
  resetAll();
  queueFetch({ body: "y".repeat(300_000) });
  const cappedResult = await attempt(() => call({ engineMethod: "GET", enginePath: "/flows" }));
  check("成功正文按 256k 上限截断", cappedResult.ok
    && (cappedResult.value as { text: string }).text.length === 256_000,
    { error: cappedResult.ok ? undefined : cappedResult.error });
}

/* ═════════════════════════ E. node-red.call 部署审批(安全边界 #2) ═════════════════════════ */

console.log("\nE · node-red.call:非 GET 只许 POST /flows + 真人审批");

{
  const call = (payload: Record<string, unknown>) => services().execute("node-red.call", payload);

  // 不在批准清单里的变更一律拒(且不弹框、不发请求)
  const mutationRejects: Array<[string, string, string]> = [
    ["POST /flow(少个 s)", "POST", "/flow"],
    ["PUT /flows", "PUT", "/flows"],
    ["PATCH /flows", "PATCH", "/flows"],
    ["DELETE /flows", "DELETE", "/flows"],
    ["POST /settings", "POST", "/settings"],
  ];
  for (const [label, method, path] of mutationRejects) {
    resetAll();
    await throws(`${label} → 拒绝(只许 POST /flows)`,
      () => call({ engineMethod: method, enginePath: path }),
      "Node-RED mutations must use an approved Host path");
    eq(`${label} → 不弹审批框`, messageBoxCalls.length, 0);
    eq(`${label} → 一次 fetch 都没发`, fetchCalls.length, 0);
  }

  // ★ 正控:POST /flows + Allow once → 放行
  resetAll();
  pushMessageBoxResponse(1);
  queueFetch({ body: "{\"deployed\":true}" });
  const allowResult = await attempt(() => call({ engineMethod: "post", enginePath: "/flows", engineBody: "{\"flows\":[]}" }));
  check("★ 正控:Allow once 后没有被拒", allowResult.ok,
    { error: allowResult.ok ? undefined : allowResult.error });
  const allowed = (allowResult.ok ? allowResult.value : { text: "" }) as { text: string };
  eq("★ 正控:Allow once 后请求真的发出(返回引擎正文)", allowed.text, "{\"deployed\":true}");
  eq("★ 正控:POST 的 method 归一成大写", fetchCalls[0]?.init.method, "POST");
  const headers = (fetchCalls[0]?.init.headers ?? {}) as Record<string, string>;
  eq("★ 正控:变更请求带 Content-Type", headers["Content-Type"], "application/json");
  eq("★ 正控:变更请求的 body 是 engineBody 原文", fetchCalls[0]?.init.body, "{\"flows\":[]}");
  eq("★ 正控:审批框只弹了一次", messageBoxCalls.length, 1);

  // 审批框的内容:按钮顺序、默认/取消都在 Deny 上(默认放行会是真缺陷)
  const options = messageBoxCalls[0]?.options ?? {};
  eq("审批框 buttons = [Deny, Allow once]", JSON.stringify(options.buttons), JSON.stringify(["Deny", "Allow once"]));
  eq("审批框 defaultId 指向 Deny", options.defaultId, 0);
  eq("审批框 cancelId 指向 Deny", options.cancelId, 0);
  eq("审批框是 warning 型", options.type, "warning");
  eq("审批框 noLink=true(Windows 上不变成控制面板链接)", options.noLink, true);
  eq("审批框挂在主窗口上", messageBoxCalls[0]?.win, getMainWindow());

  // Deny → 拒,且不发请求
  resetAll();
  pushMessageBoxResponse(0);
  await throws("用户点 Deny → 拒绝部署",
    () => call({ engineMethod: "POST", enginePath: "/flows", engineBody: "{}" }),
    "Host rejected Node-RED deployment");
  eq("Deny → 一次 fetch 都没发", fetchCalls.length, 0);

  // 无窗口 / 窗口已销毁 → fail-closed,连框都不弹
  resetAll();
  setMainWindowState("none");
  await throws("没有主窗口 → 拒绝(无人可审批)",
    () => call({ engineMethod: "POST", enginePath: "/flows", engineBody: "{}" }),
    "Host deploy approval UI unavailable");
  eq("没有主窗口 → 不弹框", messageBoxCalls.length, 0);
  eq("没有主窗口 → 一次 fetch 都没发", fetchCalls.length, 0);

  resetAll();
  setMainWindowState("destroyed");
  await throws("主窗口已销毁 → 拒绝",
    () => call({ engineMethod: "POST", enginePath: "/flows", engineBody: "{}" }),
    "Host deploy approval UI unavailable");

  // GET 不走审批(审批只拦变更)
  resetAll();
  queueFetch({ body: "{}" });
  const plainGet = await attempt(() => call({ engineMethod: "GET", enginePath: "/settings" }));
  check("★ 正控:GET /settings 正常发出", plainGet.ok && fetchCalls.length === 1,
    { error: plainGet.ok ? undefined : plainGet.error, fetches: fetchCalls.length });
  eq("★ 正控:GET /settings 不需要部署审批", messageBoxCalls.length, 0);
}

/* ═════════════════════════ F. chooseBranch 真人弹窗 ═════════════════════════ */

console.log("\nF · chooseBranch 真人弹窗:按钮 / cancelId / 返回码映射");

{
  const branch = (payload: Record<string, unknown>) => services().execute("branch.decide", payload);

  // ★ 正控:点 Output 1 → port=1;按钮/默认值形状
  resetAll();
  pushMessageBoxResponse(1);
  const pickedResult = await attempt(() => branch({ portCount: 3, decider: "user", params: { note: "选一个" } }));
  check("★ 正控:真人选路点 Output 1 没有被拒", pickedResult.ok,
    { error: pickedResult.ok ? undefined : pickedResult.error });
  const picked = (pickedResult.ok ? pickedResult.value : { port: -1 }) as { port: number };
  eq("★ 正控:用户点 Output 1 → port=1", picked.port, 1);
  const options = messageBoxCalls[0]?.options ?? {};
  eq("弹窗按钮 = Output 0..2 + Cancel", JSON.stringify(options.buttons),
    JSON.stringify(["Output 0", "Output 1", "Output 2", "Cancel"]));
  eq("弹窗 cancelId 指向 Cancel(下标 = portCount)", options.cancelId, 3);
  eq("弹窗 defaultId 指向 Cancel(默认不选任何出口)", options.defaultId, 3);
  eq("弹窗类型 question", options.type, "question");
  eq("弹窗消息文案", options.message, "Mcode workflow branch needs your decision");
  eq("弹窗 detail 用节点备注", options.detail, "选一个");
  eq("弹窗挂在主窗口上", messageBoxCalls[0]?.win, getMainWindow());
  eq("真人选路不起引擎 turn", sendTurnCalls.length, 0);

  // Cancel(cancelId=portCount)→ 拒
  resetAll();
  pushMessageBoxResponse(3);
  await throws("用户点 Cancel(response = portCount)→ 拒绝",
    () => branch({ portCount: 3, decider: "user", params: {} }),
    "Human branch cancelled");

  // 防御性:response < 0 / 越界 → 同样按取消处理
  resetAll();
  pushMessageBoxResponse(-1);
  await throws("response = -1 → 按取消拒绝",
    () => branch({ portCount: 2, decider: "user", params: {} }),
    "Human branch cancelled");

  resetAll();
  pushMessageBoxResponse(7);
  await throws("response 越界(7 >= portCount=2)→ 按取消拒绝",
    () => branch({ portCount: 2, decider: "user", params: {} }),
    "Human branch cancelled");

  // 空备注 → 默认 detail;超长备注 → 截到 1000
  resetAll();
  pushMessageBoxResponse(0);
  const emptyNote = await attempt(() => branch({ portCount: 2, decider: "user", params: {} }));
  check("空备注的真人选路跑通", emptyNote.ok, { error: emptyNote.ok ? undefined : emptyNote.error });
  eq("空备注 → detail 用默认文案", messageBoxCalls[0]?.options.detail,
    "Choose the Node-RED output port to continue.");

  resetAll();
  pushMessageBoxResponse(0);
  const longNote = await attempt(() => branch({ portCount: 2, decider: "user", params: { note: "n".repeat(1500) } }));
  check("超长备注的真人选路跑通", longNote.ok, { error: longNote.ok ? undefined : longNote.error });
  eq("超长备注 → detail 截断到 1000", (messageBoxCalls[0]?.options.detail as string).length, 1000);

  // 无窗口 / 销毁 → fail-closed,不弹框
  resetAll();
  setMainWindowState("none");
  await throws("没有主窗口 → 拒绝真人选路",
    () => branch({ portCount: 2, decider: "user", params: {} }),
    "Human branch approval unavailable; refusing to choose");
  eq("没有主窗口 → 不弹框", messageBoxCalls.length, 0);

  resetAll();
  setMainWindowState("destroyed");
  await throws("主窗口已销毁 → 拒绝真人选路",
    () => branch({ portCount: 2, decider: "user", params: {} }),
    "Human branch approval unavailable; refusing to choose");

  // decider 缺省 = user(不是 model)
  resetAll();
  pushMessageBoxResponse(0);
  const defaultedResult = await attempt(() => branch({ portCount: 2, params: {} }));
  check("decider 缺省的真人选路跑通", defaultedResult.ok,
    { error: defaultedResult.ok ? undefined : defaultedResult.error });
  eq("decider 缺省走真人弹窗(不是模型)",
    (defaultedResult.ok ? defaultedResult.value as { port: number } : { port: -1 }).port, 0);
}

/* ═════════════════════════ G. trigger.subscribe ═════════════════════════ */

console.log("\nG · trigger.subscribe:只收 event 触发 + 事件过滤");

{
  const subscribe = (payload: Record<string, unknown>, emit: (p: Record<string, unknown>) => void) =>
    services().subscribe(payload, emit);

  resetAll();
  check("triggerKind=schedule → 拒绝",
    (() => { try { subscribe({ triggerKind: "schedule", params: { task: "x" } }, () => {}); return false; }
      catch (err) { return (err as Error).message.includes("Use Node-RED native inject/watch"); } })(),
    "expected throw");

  resetAll();
  check("缺 params.task → 拒绝",
    (() => { try { subscribe({ triggerKind: "event", params: {} }, () => {}); return false; }
      catch (err) { return (err as Error).message.includes("Trigger event type must be specified"); } })(),
    "expected throw");

  resetAll();
  check("task 超过 100 字符 → 拒绝",
    (() => { try { subscribe({ triggerKind: "event", params: { task: "t".repeat(101) } }, () => {}); return false; }
      catch (err) { return (err as Error).message.includes("Trigger event type must be specified"); } })(),
    "expected throw");

  resetAll();
  check("缺 params(非对象)→ 拒绝",
    (() => { try { subscribe({ triggerKind: "event" }, () => {}); return false; }
      catch (err) { return (err as Error).message.includes("Node params missing"); } })(),
    "expected throw");

  // ★ 正控:事件类型匹配才 emit,退订后不再 emit
  resetAll();
  const received: Array<Record<string, unknown>> = [];
  const dispose = subscribe(
    { triggerKind: "event", params: { task: "library.item.imported" } },
    (payload) => received.push(payload),
  );
  eq("★ 正控:subscribe 返回退订句柄", typeof dispose, "function");
  emitEvent({ type: "library.item.imported", sessionId: "s_chat", itemId: "i1", title: "t", pdfPath: "p" } as unknown as RuntimeEvent);
  eq("★ 正控:匹配的事件转成 payload 发出", received.length, 1);
  const body = received[0] as { payload?: { event?: string; sessionId?: string; at?: unknown } };
  eq("★ 正控:payload.event 是事件类型", body.payload?.event, "library.item.imported");
  eq("★ 正控:payload.sessionId 透传", body.payload?.sessionId, "s_chat");
  eq("★ 正控:payload.at 是时间戳", typeof body.payload?.at, "number");

  emitEvent({ type: "turn.done", sessionId: "s_chat", reason: "end_turn" } as RuntimeEvent);
  eq("不匹配的事件不发出", received.length, 1);

  dispose();
  emitEvent({ type: "library.item.imported", sessionId: "s_chat", itemId: "i2", title: "t", pdfPath: "p" } as unknown as RuntimeEvent);
  eq("退订后不再发出", received.length, 1);
}

/* ═════════════════════════ H. 未支持操作 ═════════════════════════ */

console.log("\nH · 未支持的操作");

{
  resetAll();
  await throws("未知 operation → 拒绝",
    () => services().execute("bogus.op" as NodePackAction, { params: {} }),
    "Unsupported Mcode node operation");

  resetAll();
  scriptTurn({ sessionId: "s_chat", text: "ok" });
  const agentAttempt = await attempt(() => services(() => "wf_a").execute("agent.run", { params: { sessionId: "s_chat" }, instruction: "x", nodeId: "n1", tabId: "t" }));
  check("★ 正控:agent.run 跑通", agentAttempt.ok, { error: agentAttempt.ok ? undefined : agentAttempt.error });
  const progress = externalEvents.find((e) => (e as { type: string }).type === "workflow.node.progress") as unknown as Record<string, unknown>;
  eq("agent.run 的阶段事件 nodeType=mcode-agent", progress?.nodeType, "mcode-agent");
  const result = externalEvents.filter((e) => (e as { type: string }).type === "workflow.node.result")
    .pop() as unknown as Record<string, unknown>;
  eq("成功收口时 title 用 nodeTitle(缺省回退 nodeId)", result?.title, "n1");
}

/* ── 汇总 ── */
console.log(`\nmcode-node-pack-ports-smoke:${total - failures}/${total} 通过`);
process.exit(failures ? 1 : 0);
