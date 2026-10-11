/**
 * 【MC-057】故障注入 smoke —— Pi `SessionManager.open` 与 Codex `thread/resume`
 * 失败时**绝不能**静默开新底层会话。
 *
 * ## 为什么需要这一套(与 engine-regressions 的 MC-057 那条的区别)
 *
 * engine-regressions-smoke 里的 MC-057 只做**源码不变量**(剥注释后正则匹配 "两处
 * 失败分支必须 throw、Pi 不得再 create、Codex 要求恢复时不得 thread/start")。台账 §21.6
 * 明确指出这**不是**真实异步生命周期证据,要求"用 fake SDK 真正注入 Pi open、Codex
 * thread/resume 拒绝/空回应/正常新会话成功的完整异步生命周期"。
 *
 * 本套件因此**驱动真的 provider 类**(不对生产代码做任何改动):把 SDK 边界(相对
 * import 的 `piSdkLoader` / `CodexAppServerClient` / `mcodeExtension` / `piSkillBridge`
 * / `codexProjectScope` 及裸 specifier 的 Pi SDK)换成假模块,其余保持真实。断言立在
 * **用户看得见的那条失败**上:
 *
 *   - 恢复失败:Pi 的 `startTurn` 直接 reject(用户得到原错误);Codex 的 `done` 解析
 *     但发出一条 `error`(code=CODEX_SDK_ERROR,message 带原错误),**不**新增会话。
 *   - 恢复失败时:`SessionManager.create` / `thread/start` **没有被调用**,
 *     `ctx.onProviderSessionId` **没有被调用**(不持久化新的 providerSessionId),
 *     没有工具被派发。
 *   - 正常 fresh 会话(无 resume id):照常启动,`create`/`thread/start` 被调用、拿到
 *     providerSessionId、回合正常收尾。
 *
 * 任何一条断言在"把修复撤掉"(变异)时必须真的变红 —— 见 run.sh 与提交说明。
 */
import { PiAgentSdkProvider } from "@main/providers/pi-sdk/PiAgentSdkProvider.js";
import { CodexAgentSdkProvider } from "@main/providers/codex-sdk/CodexAgentSdkProvider.js";

/* ── 断言助手(与其它 smoke 同款) ───────────────────────────── */
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

/** 记录宿主收到的所有事件 + onProviderSessionId / onResumeOutcome 调用。 */
function makeCtx() {
  const events: Array<{ type?: string; code?: string; message?: string; reason?: string }> = [];
  const providerSessionIds: string[] = [];
  const dispatchedTools: string[] = [];
  const resumeOutcomes: Array<{ kind?: string }> = [];
  const ctx = {
    emit: (e: unknown) => {
      events.push(e as never);
    },
    onProviderSessionId: (id: string) => {
      providerSessionIds.push(id);
    },
    // 【ARC-008】底层会话来源的显式事实。
    onResumeOutcome: (o: { kind?: string }) => {
      resumeOutcomes.push(o);
    },
    // 审批/提问桥:本套件不进入工具执行,给个会记录调用的桩即可。
    requestApproval: async () => ({ decision: "deny" as const }),
    requestUserInput: async () => ({ answers: [] }),
    requestPlanApproval: async () => ({ decision: "reject" as const }),
    isToolAlwaysAllowed: () => false,
    getPermissionMode: () => "default" as const,
    log: { info() {}, warn() {}, error() {} },
    // 供假扩展记录"是否有工具被派发"(真实扩展不在此跑,派生点靠假 SDK 边界)。
    __dispatchedTools: dispatchedTools,
  };
  return { ctx, events, providerSessionIds, dispatchedTools, resumeOutcomes };
}

const errs = (events: Array<{ type?: string; code?: string; message?: string }>) =>
  events.filter((e) => e.type === "error");

/* ════════════════════ Pi：恢复失败必须明确失败 ════════════════════ */

async function piResumeFailure(): Promise<void> {
  const piFake = (globalThis as { __piFake?: PiFake }).__piFake!;
  piFake.reset("reject");
  const mode = "reject"; // 标注用;Pi 的恢复只有"open 抛错"一种失败形态
  const provider = new PiAgentSdkProvider();
  const { ctx, events, providerSessionIds, resumeOutcomes } = makeCtx();
  const req = {
    sessionId: "pi-s1",
    cwd: process.cwd(),
    prompt: "hi",
    resumeProviderSessionId: "/tmp/mcode-fake/session.jsonl",
  };

  let threw: Error | null = null;
  try {
    const handle = await provider.startTurn(req as never, ctx as never);
    await handle.done;
  } catch (err) {
    threw = err as Error;
  }

  check(`[pi/${mode}] 恢复失败时 startTurn 明确失败(reject)`, threw !== null, {
    threw: threw?.message,
  });
  check(
    `[pi/${mode}] 失败信息带原错误原因(用户看得到为什么)`,
    !!threw && /FAKE open boom/.test(threw.message),
    { message: threw?.message },
  );
  check(`[pi/${mode}] 恢复失败时 onResumeOutcome 报 FAILED(不假装 RESUMED)`, resumeOutcomes.length === 1 && resumeOutcomes[0]?.kind === "FAILED", resumeOutcomes);
  check(`[pi/${mode}] 恢复失败时**没有**开新底层会话(create 未被调用)`, piFake.calls.create === 0, {
    create: piFake.calls.create,
  });
  check(
    `[pi/${mode}] 恢复失败时**没有**创建 agent session(createAgentSession 未被调用)`,
    piFake.calls.createAgentSession === 0,
    { createAgentSession: piFake.calls.createAgentSession },
  );
  check(
    `[pi/${mode}] 恢复失败时**没有**持久化新的 providerSessionId`,
    providerSessionIds.length === 0,
    { providerSessionIds },
  );
  check(
    `[pi/${mode}] 恢复失败时**没有**派发工具`,
    !events.some((e) => e.type === "tool.use"),
    { types: events.map((e) => e.type) },
  );
  // 失败路径不该吐 turn.done(那是"一轮跑完了"的语义)。
  eq(
    `[pi/${mode}] 恢复失败时没有发 turn.done(未假装跑完一轮)`,
    events.some((e) => e.type === "turn.done"),
    false,
  );
}

async function piFreshSession(): Promise<void> {
  const piFake = (globalThis as { __piFake?: PiFake }).__piFake!;
  piFake.reset("ok"); // 无 resume id → 正常新建
  const provider = new PiAgentSdkProvider();
  const { ctx, events, providerSessionIds, resumeOutcomes } = makeCtx();
  const req = { sessionId: "pi-fresh", cwd: process.cwd(), prompt: "hi" };

  const handle = await provider.startTurn(req as never, ctx as never);
  await handle.done;

  eq(`[pi/fresh] 正常新建:SessionManager.create 被调用一次`, piFake.calls.create, 1);
  check(`[pi/fresh] onResumeOutcome 报 FRESH_EXPLICIT(本就全新,不是降级)`, resumeOutcomes.length === 1 && resumeOutcomes[0]?.kind === "FRESH_EXPLICIT", resumeOutcomes);
  eq(`[pi/fresh] 正常新建:createAgentSession 被调用一次`, piFake.calls.createAgentSession, 1);
  check(
    `[pi/fresh] 正常新建:拿到 providerSessionId 并交给宿主持久化`,
    providerSessionIds.length === 1 && providerSessionIds[0] === "/tmp/mcode-fake/pi-session.jsonl",
    { providerSessionIds },
  );
  check(
    `[pi/fresh] 正常新建:回合以 turn.done 收尾`,
    events.some((e) => e.type === "turn.done"),
    { events: events.map((e) => e.type) },
  );
  // 正控:证明"**没有**派发工具"这条断言在该套件的假环境下**能变真** —— fresh 路径
  // 里工具确实被派发(否则失败路径那条就是空过的假绿)。
  check(
    `[pi/fresh] 正控:正常新建路径确实派发了工具(否则失败路径的"无工具"是空过)`,
    events.some((e) => e.type === "tool.use"),
    { events: events.map((e) => e.type) },
  );
  eq(`[pi/fresh] 正常新建:没有错误事件`, errs(events).length, 0);
}

/* ════════════════════ Codex：恢复失败必须明确失败 ════════════════════ */

async function codexResumeFailure(mode: "reject" | "empty"): Promise<void> {
  const cx = (globalThis as { __codexFake?: CodexFake }).__codexFake!;
  cx.reset(mode);
  const provider = new CodexAgentSdkProvider();
  const { ctx, events, providerSessionIds, resumeOutcomes } = makeCtx();
  const req = {
    sessionId: "cx-s1",
    cwd: process.cwd(),
    prompt: "hi",
    resumeProviderSessionId: "thread-persisted-123",
  };

  const handle = await provider.startTurn(req as never, ctx as never);
  await handle.done; // 生产代码在 done 内部 catch 并发 error,故 resolve 而非 reject

  const errorEvents = errs(events);
  check(`[codex/${mode}] onResumeOutcome 报 FAILED`, resumeOutcomes.length === 1 && resumeOutcomes[0]?.kind === "FAILED", resumeOutcomes);
  check(
    `[codex/${mode}] 恢复失败时发出结构化 error 事件(code=CODEX_SDK_ERROR)`,
    errorEvents.length === 1 && errorEvents[0]!.code === "CODEX_SDK_ERROR",
    { errorEvents },
  );
  check(
    `[codex/${mode}] 失败信息带原错误原因(用户看得到为什么)`,
    !!errorEvents[0]?.message && /无法恢复/.test(errorEvents[0]!.message!),
    { message: errorEvents[0]?.message },
  );
  if (mode === "reject") {
    // 只有 resume 的 **catch** 分支才复用原 SDK 错误文本 —— 把 catch 退回"只 warn",
    // 这里就会落到空 id 守卫的文案上,本断言随之变红(证明它钉的是 catch 那一支)。
    check(
      `[codex/reject] 失败信息复用原 SDK 错误(证明是 catch 分支在抛,而非空 id 守卫兜底)`,
      !!errorEvents[0]?.message && /FAKE resume boom/.test(errorEvents[0]!.message!),
      { message: errorEvents[0]?.message },
    );
  }
  check(
    `[codex/${mode}] 恢复失败时**没有**开新线程(thread/start 未被调用)`,
    !cx.calls.includes("thread/start"),
    { calls: cx.calls },
  );
  check(
    `[codex/${mode}] 恢复失败时**没有**发起回合(turn/start 未被调用)`,
    !cx.calls.includes("turn/start"),
    { calls: cx.calls },
  );
  check(
    `[codex/${mode}] 恢复失败时**没有**持久化新的 providerSessionId`,
    providerSessionIds.length === 0,
    { providerSessionIds },
  );
  check(
    `[codex/${mode}] 恢复失败时**没有**派发工具`,
    cx.toolsDispatched === 0,
    { toolsDispatched: cx.toolsDispatched },
  );
}
async function codexFreshSession(): Promise<void> {
  const cx = (globalThis as { __codexFake?: CodexFake }).__codexFake!;
  cx.reset("ok");
  const provider = new CodexAgentSdkProvider();
  const { ctx, events, providerSessionIds, resumeOutcomes } = makeCtx();
  const req = { sessionId: "cx-fresh", cwd: process.cwd(), prompt: "hi" };

  const handle = await provider.startTurn(req as never, ctx as never);
  await handle.done;

  check(`[codex/fresh] onResumeOutcome 报 FRESH_EXPLICIT`, resumeOutcomes.length === 1 && resumeOutcomes[0]?.kind === "FRESH_EXPLICIT", resumeOutcomes);
  check(`[codex/fresh] 正常新建:thread/start 被调用一次`, cx.calls.filter((c) => c === "thread/start").length === 1, {
    calls: cx.calls,
  });
  check(`[codex/fresh] 正常新建:没有发起 thread/resume`, !cx.calls.includes("thread/resume"), {
    calls: cx.calls,
  });
  check(
    `[codex/fresh] 正常新建:拿到 providerSessionId 并交给宿主持久化`,
    providerSessionIds.length === 1 && providerSessionIds[0] === "new-thread",
    { providerSessionIds },
  );
  check(
    `[codex/fresh] 正常新建:回合发起了 turn/start`,
    cx.calls.includes("turn/start"),
    { calls: cx.calls },
  );
  // 正控:证明"**没有**派发工具"这条断言在该套件的假环境下能变真。
  check(
    `[codex/fresh] 正控:正常新建路径确实派发了动态工具(否则失败路径的"无工具"是空过)`,
    cx.toolsDispatched > 0,
    { toolsDispatched: cx.toolsDispatched },
  );
  eq(`[codex/fresh] 正常新建:没有错误事件`, errs(events).length, 0);
}

/* ── 假边界接口(实现见 stubs/piSdk.ts 与 run.sh 铺到 bundle 旁的 .js) ── */
interface PiFake {
  calls: { create: number; createAgentSession: number; toolsDispatched: number };
  reset(mode: "ok" | "reject" | "empty"): void;
}
interface CodexFake {
  calls: string[];
  toolsDispatched: number;
  reset(mode: "ok" | "reject" | "empty"): void;
}

async function main(): Promise<void> {
  console.log("resume-fault-smoke 【MC-057】");
  console.log("— Pi SessionManager.open 失败 —");
  await piResumeFailure();
  console.log("— Pi 正常 fresh 会话 —");
  await piFreshSession();
  console.log("— Codex thread/resume 失败 —");
  await codexResumeFailure("reject");
  console.log("— Codex thread/resume 返回空 id —");
  await codexResumeFailure("empty");
  console.log("— Codex 正常 fresh 会话 —");
  await codexFreshSession();

  console.log(`resume-fault-smoke:${total - failures}/${total} 通过`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("smoke crashed:", err);
  process.exitCode = 1;
});
