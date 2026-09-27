/**
 * MAINT-2026-09 / M23 · 消息流、水合与会话前端状态 —— 独占回归。
 *
 * 场景:`turn.done{reason:"interrupted"}` 的「陈旧事件」守卫。
 *
 * 原守卫只看 `interruptedBySession` 哨兵:哨兵没立就把 interrupted 的 turn.done
 * 整条丢掉。但中断**不只来自本渲染端的停止键**:主进程的轮预算触顶
 * (`RuntimeManager.enforceBudget` → `handle.interrupt()`)、手机端点停
 * (`mobileRpc` → `runtimeManager.interrupt`)、工作流取消,都会让 provider 发出
 * 同一条事件,而桌面这边从未设过哨兵 → 事件被丢 → `runningBySession` 永远为 true:
 * 输入框锁死、「开始·用时」一直在跳、这一轮不落库、排队的提问不出发。
 *
 * 该守卫真正要挡的只有一种情况:**本端**点了停止、late turn.done 还没来、用户已经
 * 编辑重发开了新一轮。所以判据应是「本端是否还欠一条中断收口」,而不是哨兵本身。
 *
 * 与 session-store-smoke 同一套无头加载方式(esbuild + prelude 里的浏览器全局替身),
 * 通过 `useSessionStore.getState().ingestEvent` 这个 IPC 事件流的真实入口驱动。
 * 不启动 Electron、不连数据库、不调模型。
 */
import { setSendTurnStub } from "./prelude.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import type { ChatMessage } from "@renderer/stores/sessionStore.js";
import type { Session } from "@contracts/session";

const PROJECT = "m23-project";
let failures = 0;
let checks = 0;
function eq(name: string, actual: unknown, expected: unknown): void {
  checks++;
  if (Object.is(actual, expected)) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures++;
  console.log(`  FAIL ${name} — ${JSON.stringify({ actual, expected })}`);
}

let seq = 0;
function mkSession(id: string): Session {
  return {
    id, projectId: PROJECT, providerId: "claude-sdk", claudeSessionId: null, kind: "chat",
    parentSessionId: null, nodeId: null, title: id, status: "idle", model: "default",
    effort: "default", permissionMode: "default", workflowId: "default", customModelId: null,
    archived: false, pinnedAt: null, contextSnapshot: null, todos: null, subagents: null,
    planDraft: null, usageHistory: null, turnFiles: null, bookmarks: null,
    subagentTranscripts: null, createdAt: 1, updatedAt: 1 + seq++,
  };
}

/** 把一个会话摆成「一轮正在跑」:有开着的助手消息(turnMeta 无 endedAt)、运行标志为真。 */
function seedRunning(sid: string, startedAt: number): void {
  const sessions = [mkSession(sid)];
  const opener: ChatMessage = {
    id: `a_${sid}`, sessionId: sid, role: "assistant", createdAt: startedAt,
    blocks: [{ kind: "text", text: "正在……" }], turnMeta: { startedAt },
  };
  useSessionStore.setState((s) => ({
    // 店里的模型守卫(resolveSendModel)不放行 "default":夹具用一个具体名字,与 session-store-smoke 一致。
    activeProjectId: PROJECT, activeSessionId: sid, providerId: "claude-sdk", model: "smoke-model",
    sessionsByProject: { ...s.sessionsByProject, [PROJECT]: sessions }, sessions,
    sessionsTotalByProject: { [PROJECT]: 1 }, sessionsHasMoreByProject: { [PROJECT]: false },
    pinnedSessions: [], archivedSessionsByProject: {},
    messagesBySession: { ...s.messagesBySession, [sid]: [opener] },
    runningBySession: { ...s.runningBySession, [sid]: true },
    runningTurnStartedAt: { ...s.runningTurnStartedAt, [sid]: startedAt },
    interruptedBySession: { ...s.interruptedBySession, [sid]: false },
  }));
}
const openTurnEnded = (sid: string): number | undefined =>
  useSessionStore.getState().messagesBySession[sid]?.find((m) => m.id === `a_${sid}`)?.turnMeta?.endedAt;
const running = (sid: string): boolean | undefined => useSessionStore.getState().runningBySession[sid];
const store = useSessionStore;
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

console.log("\n[1] 主进程/手机端发起的中断:本端没按停止键,turn.done{interrupted} 也必须收口");
{
  const SID = "m23-external-interrupt";
  seedRunning(SID, 1_000);
  const endedAt = 5_000;
  store.getState().ingestEvent({ type: "turn.done", sessionId: SID, reason: "interrupted", endedAt });
  eq("★ 运行标志被清掉(输入框解锁)", running(SID), false);
  eq("★ 这一轮的「开始·用时」被冻结在事件时刻", openTurnEnded(SID), endedAt);
  eq("发送锚点随之清除", store.getState().runningTurnStartedAt[SID], undefined);
}

console.log("\n[2] 本端停止 → 编辑重发 → 旧轮迟到的 interrupted 收口仍须被丢弃(原有守卫不退化)");
await (async () => {
  const SID = "m23-stop-resend-race";
  seedRunning(SID, 1_000);
  setSendTurnStub(async () => ({ session: mkSession(SID) }));
  try {
    await store.getState().interrupt(SID);
    eq("停止后运行标志为假", running(SID), false);
    eq("停止后哨兵已立", store.getState().interruptedBySession[SID], true);
    // 用户在 late turn.done 到达前重发:新一轮开始,哨兵被清。
    eq("重发被接受", await store.getState().sendPrompt("重发一次"), true);
    await flush();
    eq("新一轮运行中", running(SID), true);
    const newAnchor = store.getState().runningTurnStartedAt[SID];
    // 旧轮的 late turn.done 这时才到 —— 它属于已中止的那一轮,不能碰新一轮。
    store.getState().ingestEvent({ type: "turn.done", sessionId: SID, reason: "interrupted", endedAt: Date.now() });
    eq("★ 迟到的旧轮收口被丢弃:新一轮仍在运行", running(SID), true);
    eq("新一轮锚点未被清", store.getState().runningTurnStartedAt[SID], newAnchor);
    // 新一轮正常结束照常收口。
    store.getState().ingestEvent({ type: "turn.done", sessionId: SID, reason: "end_turn", endedAt: Date.now() });
    eq("新一轮正常收口", running(SID), false);
  } finally {
    setSendTurnStub(null);
  }
})();

console.log("\n[3] 本端停止且旧轮已收口 → 新一轮被外部中断:不能再当陈旧事件丢掉");
await (async () => {
  const SID = "m23-owed-cleared";
  seedRunning(SID, 1_000);
  setSendTurnStub(async () => ({ session: mkSession(SID) }));
  try {
    await store.getState().interrupt(SID);
    store.getState().ingestEvent({ type: "turn.done", sessionId: SID, reason: "interrupted", endedAt: 2_000 });
    eq("旧轮 interrupted 收口已处理", running(SID), false);
    eq("新一轮发送", await store.getState().sendPrompt("再来一轮"), true);
    await flush();
    eq("新一轮运行中", running(SID), true);
    // 新一轮被预算/手机端中断 —— 本端不欠任何旧收口,必须处理。
    store.getState().ingestEvent({ type: "turn.done", sessionId: SID, reason: "interrupted", endedAt: Date.now() });
    eq("★ 外部中断的新一轮被收口", running(SID), false);
  } finally {
    setSendTurnStub(null);
  }
})();

console.log("\n[4] 本端停止但旧轮从未收口 → 新一轮正常结束后,欠账清零,再往后的外部中断照常处理");
await (async () => {
  const SID = "m23-owed-expires";
  seedRunning(SID, 1_000);
  setSendTurnStub(async () => ({ session: mkSession(SID) }));
  try {
    await store.getState().interrupt(SID);
    eq("新一轮发送", await store.getState().sendPrompt("第二轮"), true);
    await flush();
    store.getState().ingestEvent({ type: "turn.done", sessionId: SID, reason: "end_turn", endedAt: Date.now() });
    eq("第二轮正常收口", running(SID), false);
    eq("第三轮发送", await store.getState().sendPrompt("第三轮"), true);
    await flush();
    store.getState().ingestEvent({ type: "turn.done", sessionId: SID, reason: "interrupted", endedAt: Date.now() });
    eq("★ 第三轮的外部中断不再被旧欠账误伤", running(SID), false);
  } finally {
    setSendTurnStub(null);
  }
})();

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
