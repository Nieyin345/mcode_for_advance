/**
 * mobile-sync-smoke — 手机网页壳一侧的跨端同步(见 run.sh 文件头)。
 *
 * Run: scripts/mobile-sync-smoke/run.sh
 */
import { server, callsOf, storage } from "./prelude.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import type { ChatMessage } from "@renderer/stores/sessionStore.js";
import { api } from "@renderer/lib/api.js";
import type { MessageRecord, Project, Session } from "@contracts/session";

let failures = 0;
let checks = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  checks++;
  if (cond) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures++;
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const st = () => useSessionStore.getState();

function mkProject(id: string, over: Partial<Project> = {}): Project {
  return { id, name: id, path: `/w/${id}`, archived: false, pinnedAt: null, sortOrder: 0, createdAt: 1, updatedAt: 1, ...over };
}

function mkSession(id: string, projectId: string): Session {
  return {
    id,
    projectId,
    providerId: "claude-sdk",
    claudeSessionId: null,
    kind: "chat",
    parentSessionId: null,
    nodeId: null,
    title: id,
    status: "idle",
    model: "default",
    effort: "default",
    permissionMode: "default",
    workflowId: "default",
    customModelId: null,
    archived: false,
    pinnedAt: null,
    contextSnapshot: null,
    todos: null,
    subagents: null,
    planDraft: null,
    usageHistory: null,
    turnFiles: null,
    bookmarks: null,
    subagentTranscripts: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function msg(id: string, sessionId: string, createdAt: number, text: string, role: "user" | "assistant" = "assistant"): ChatMessage {
  return { id, sessionId, role, blocks: [{ kind: "text", text }], createdAt } as ChatMessage;
}

function rec(id: string, sessionId: string, createdAt: number, text: string): MessageRecord {
  return { id, sessionId, role: "assistant", content: { blocks: [{ kind: "text", text }] }, createdAt };
}

function textsOf(sid: string): string[] {
  return (st().messagesBySession[sid] ?? []).map((m) =>
    m.blocks.map((b) => (b.kind === "text" ? b.text : "")).join(""),
  );
}

function snapshot(running: string[], desktopAttached?: boolean): void {
  st().ingestEvent({
    type: "session.runningSnapshot",
    sessionId: "",
    running,
    ...(desktopAttached === undefined ? {} : { desktopAttached }),
  });
}

// ── 1. 设备本地键进 localStorage,共享键走 RPC ─────────────────────────────
console.log("\n[1] webApi:设备本地 / 共享设置分流");
{
  server.calls.length = 0;
  await api.setting.set({ key: "ui.displayMode", value: "tabs" });
  await api.setting.set({ key: "ui.lastSessionId", value: "s_phone" });
  eq("设备本地键不发 RPC", callsOf("setting:set").length, 0);
  eq("写进了这台浏览器的 localStorage", storage.get("mcode-web-setting:ui.displayMode"), "tabs");
  await api.setting.set({ key: "ui.accentColor", value: "1 2 3" });
  eq("共享键照常走 RPC", callsOf("setting:set").length, 1);
  eq("写到了桌面那份设置表", server.settings["ui.accentColor"], "1 2 3");

  server.settings["ui.displayMode"] = "single"; // 桌面自己的值
  server.settings["ui.locale"] = "en";
  server.calls.length = 0;
  const many = await api.setting.getMany({ keys: ["ui.displayMode", "ui.locale", "ui.lastSessionId"] });
  eq("getMany:设备本地键读本机值(不是桌面的)", many["ui.displayMode"], "tabs");
  eq("getMany:共享键读桌面的", many["ui.locale"], "en");
  eq("getMany:上次打开的会话是本机的", many["ui.lastSessionId"], "s_phone");
  const sent = callsOf("setting:getMany")[0] as { keys: string[] } | undefined;
  eq("发给桌面的只有共享键", sent?.keys, ["ui.locale"]);
  const one = await api.setting.get({ key: "ui.displayMode" });
  eq("get 设备本地键同样读本机", one.value, "tabs");
}

// ── 2. setting.changed 当场套用 ────────────────────────────────────────────
console.log("\n[2] setting.changed → store");
{
  const apply = (key: string, value: string) =>
    st().ingestEvent({ type: "setting.changed", sessionId: "", key, value });
  apply("ui.locale", "en");
  eq("语言切到 en", st().locale, "en");
  eq("<html lang> 跟着变", (globalThis as unknown as { document: { documentElement: { lang: string } } }).document.documentElement.lang, "en");
  apply("ui.locale", "fr");
  eq("非法语言值被忽略", st().locale, "en");
  apply("ui.accentColor", "10 20 30");
  eq("强调色套用", st().accentColor, "10 20 30");
  apply("ui.accentColor", "");
  eq("清空强调色 → 回到主题默认(null)", st().accentColor, null);
  apply("workflow.maxParallel", "999");
  check("并行上限按 init 同一规则夹取", st().workflowMaxParallel < 999, st().workflowMaxParallel);
  apply("project.colors", JSON.stringify({ p1: "#ff0000", bad: 3 }));
  eq("项目颜色:非字符串值丢掉", st().projectColors, { p1: "#ff0000" });
  apply("ui.customCommandsByProject", JSON.stringify({ p1: [{ id: "c", name: "n", command: "ls" }, { id: 1 }] }));
  eq("自定义命令:坏条目丢掉", st().customCommandsByProject, { p1: [{ id: "c", name: "n", command: "ls" }] });
  apply("ui.shortcuts", "{not json");
  check("坏 JSON 不炸、不改原值", typeof st().shortcutOverrides === "object");
  apply("session.worktreeDefault", "wt-branch");
  eq("新会话默认环境套用", st().envChoice, "wt-branch");
  apply("agent.outputStyle", "");
  eq("输出风格清空 → null", st().outputStyle, null);
  const before = st().displayMode;
  apply("ui.displayMode", before === "tabs" ? "single" : "tabs");
  eq("设备本地键即便收到也不套用", st().displayMode, before);
}

// ── 3. 谁来落库:desktopAttached ───────────────────────────────────────────
console.log("\n[3] 回合消息落库:桌面在 → 手机不写");
{
  const SID = "s_turn";
  const seedTurn = () =>
    useSessionStore.setState((s) => ({
      messagesBySession: { ...s.messagesBySession, [SID]: [msg("a1", SID, 10, "partial")] },
      runningBySession: { ...s.runningBySession, [SID]: true },
    }));

  snapshot([SID], true);
  seedTurn();
  server.calls.length = 0;
  st().ingestEvent({ type: "turn.done", sessionId: SID, reason: "end_turn", endedAt: Date.now() });
  await tick();
  eq("桌面在:turn.done 不写库", callsOf("session:upsertMessages").length, 0);

  snapshot([SID], false);
  seedTurn();
  server.calls.length = 0;
  st().ingestEvent({ type: "turn.done", sessionId: SID, reason: "end_turn", endedAt: Date.now() });
  await tick();
  eq("桌面不在:turn.done 由手机写", callsOf("session:upsertMessages").length, 1);

  snapshot([SID]);
  seedTurn();
  server.calls.length = 0;
  st().ingestEvent({ type: "turn.done", sessionId: SID, reason: "end_turn", endedAt: Date.now() });
  await tick();
  eq("老主进程(快照不带字段):沿用旧行为,手机写", callsOf("session:upsertMessages").length, 1);

  // 中断收尾同理。
  snapshot([SID], true);
  seedTurn();
  server.calls.length = 0;
  await st().interrupt(SID);
  await tick();
  eq("桌面在:点停止也不写库(桌面收到迟到的 turn.done 会写)", callsOf("session:upsertMessages").length, 0);

  // 用户自己发出去的那条照常由手机写 —— 那不是事件推出来的。
  snapshot([], false);
}

// ── 4. projects.changed:差异合并 ──────────────────────────────────────────
console.log("\n[4] projects.changed → 差异合并");
{
  const s1 = mkSession("s1", "p1");
  const s2 = mkSession("s2", "p2");
  useSessionStore.setState({
    projects: [mkProject("p1"), mkProject("p2")],
    sessionsByProject: { p1: [s1], p2: [s2] },
    sessionsTotalByProject: { p1: 1, p2: 1 },
    sessionsHasMoreByProject: { p1: false, p2: false },
    archivedSessionsByProject: {},
    activeProjectId: "p2",
    sessions: [s2],
    activeSessionId: "s2",
    openTabs: ["s1", "s2"],
  });
  // 另一端:p1 改了名,p2 被删,新建了 p3(里面已有一条会话)。
  server.projects = [mkProject("p1", { name: "改过的名字" }), mkProject("p3")];
  server.sessionsByProject = { p1: [s1], p3: [mkSession("s3", "p3")] };
  st().ingestEvent({ type: "projects.changed", sessionId: "" });
  for (let i = 0; i < 20 && st().projects.some((p) => p.id === "p2"); i++) await tick(5);
  eq("项目列表换成服务端那份", st().projects.map((p) => p.id), ["p1", "p3"]);
  eq("改名跟过来了", st().projects[0]?.name, "改过的名字");
  check("被删项目的会话桶清掉", st().sessionsByProject.p2 === undefined);
  eq("被删项目的标签清掉", st().openTabs.includes("s2"), false);
  check("当前项目被删 → 换到别的项目", st().activeProjectId !== "p2", st().activeProjectId);
  eq("新项目补上了会话列表", (st().sessionsByProject.p3 ?? []).map((s) => s.id), ["s3"]);

  // 本端新建的回声:桶已经在了,不覆盖。
  useSessionStore.setState((s) => ({ sessionsByProject: { ...s.sessionsByProject, p4: [] }, projects: [...s.projects, mkProject("p4")] }));
  server.projects = [...server.projects, mkProject("p4")];
  server.sessionsByProject.p4 = [mkSession("s4", "p4")];
  await st().refreshProjects();
  eq("已有的桶不被回声覆盖", (st().sessionsByProject.p4 ?? []).length, 0);
  eq("回声不会让项目出现两行", st().projects.filter((p) => p.id === "p4").length, 1);
}

// ── 5. 断线补齐:库为准 ────────────────────────────────────────────────────
console.log("\n[5] resyncSessionMessages / resyncAfterReconnect");
{
  const SID = "s_gap";
  // 手里:一条上翻加载过的老消息 + 断线时缺了一截的 a2 + 客户端 id 的重复卡片。
  useSessionStore.setState((s) => ({
    messagesBySession: {
      ...s.messagesBySession,
      [SID]: [msg("old", SID, 1, "很早的"), msg("a2", SID, 20, "缺一截"), msg("files_123", SID, 21, "重复卡片")],
    },
    runningBySession: { ...s.runningBySession, [SID]: false },
    historyLoadedBySession: { ...s.historyLoadedBySession, [SID]: true },
  }));
  server.messages[SID] = [rec("a1", SID, 10, "第一条"), rec("a2", SID, 20, "完整的第二条")];
  await st().resyncSessionMessages(SID);
  eq("库为准,只留比这一页更早的老消息", textsOf(SID), ["很早的", "第一条", "完整的第二条"]);

  // 库里是空的 → 不清空手里的。
  const EMPTY_SID = "s_empty";
  useSessionStore.setState((s) => ({ messagesBySession: { ...s.messagesBySession, [EMPTY_SID]: [msg("x", EMPTY_SID, 1, "留着")] } }));
  server.messages[EMPTY_SID] = [];
  await st().resyncSessionMessages(EMPTY_SID);
  eq("库里没有 → 保留手里的", textsOf(EMPTY_SID), ["留着"]);

  // 重连:在跑的会话先不动,等它 turn.done 之后再拉。
  const RUN = "s_run";
  useSessionStore.setState((s) => ({
    messagesBySession: { ...s.messagesBySession, [RUN]: [msg("r1", RUN, 5, "流到一半")] },
  }));
  server.messages[RUN] = [rec("r1", RUN, 5, "完整的回复")];
  snapshot([RUN], true);
  server.messages[SID] = [rec("a1", SID, 10, "第一条"), rec("a2", SID, 20, "完整的第二条"), rec("a3", SID, 30, "断线期间的新回复")];
  await st().resyncAfterReconnect();
  eq("不在跑的会话立刻补齐", textsOf(SID).at(-1), "断线期间的新回复");
  eq("在跑的会话先不动", textsOf(RUN), ["流到一半"]);
  st().ingestEvent({ type: "turn.done", sessionId: RUN, reason: "end_turn", endedAt: Date.now() });
  await tick(1700);
  eq("它收尾之后从库里重拉", textsOf(RUN), ["完整的回复"]);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
process.exit(0);
