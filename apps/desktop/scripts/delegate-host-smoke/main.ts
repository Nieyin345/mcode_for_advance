/**
 * **委派入口(`mcp/delegateHost.ts`)的权限边界 smoke。**
 *
 * `delegateHost.ts` 是委派那条路的**不纯那一半**:它把外部请求翻成"在某个项目里、用某条
 * 专用会话、以某种权限模式起一整轮本机 agent"。纯的那一半(`delegateServer.ts` 的任务表
 * 与 `visibleJob` 的 fail-closed)已由 `mcp-endpoint-smoke` 覆盖;这一套补的是**一直没人
 * 网**的那一半 —— 复审方点名要补的那条。
 *
 * 判据立在**权限边界**上(不是"机制跑通了"):
 *
 *  1. **权限模式**:委派会话建出来必须是 `bypassPermissions`(无人值守时刻弹卡=挂死,
 *     所以免审批是这条功能的定义);而且这个能力只在**开关打开**时才存在。
 *  2. **复用也重新钉**:与「ChatGPT 直连」一字不差的规矩 —— 每次取用都把活着的审批模式
 *     重新钉回 bypass,不能因为用户在界面上改过它就漏。
 *  3. **项目映射**:哪条链接进来就在**那个项目**里跑,不塌回默认项目(塌回=在别的项目
 *     目录里跑,就是跨项目越界)。
 *  4. **可区分的拒绝**:一个项目都没有时委派必须**明确报错**,不是静默起在别处。
 *
 * 每条断言都做过变异验证(撤掉对应实现看它真的红)。夹具会"空过":所以每个场景都先
 * `resetRepositories` 清干净,再把构造的坏条件真的喂进去。
 */
import {
  PUBLIC_MCP_AGENT_DELEGATE_SETTING_KEY,
  PUBLIC_MCP_DELEGATE_SESSIONS_SETTING_KEY,
  PUBLIC_MCP_PROJECT_ID_SETTING_KEY,
  PUBLIC_MCP_PROJECT_LINKS_SETTING_KEY,
  PUBLIC_MCP_SESSION_ID_SETTING_KEY,
} from "@contracts/ipc/settings";
import { __resetDelegateJobs, delegateAvailable, delegateMcpTools } from "@main/mcp/delegateServer.js";
import { initAgentDelegate } from "../../src/main/mcp/delegateHost.js";
import { publicMcpSandboxRoot } from "../../src/main/providers/bridge/publicMcpSession.js";
import { resetRepositories, SessionRepo, SettingRepo, sessionsOf } from "./stubs/repositories.js";
import {
  __bound,
  __emit,
  __pins,
  __resetRuntime,
  __setBusy,
  __setOnSend,
  __turns,
} from "./stubs/runtimeManager.js";

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
async function rejects(name: string, fn: () => Promise<unknown>): Promise<string> {
  total++;
  try {
    await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ok   ${name}`);
    return msg;
  }
  console.log(`  FAIL ${name} — 期望拒绝,却成功返回`);
  return "";
}

const tick = () => new Promise((r) => setTimeout(r, 5));
const textOf = (out: unknown) =>
  (out as { content: Array<{ text?: string }> }).content.map((c) => c.text ?? "").join("\n");
const jobIdOf = (text: string) => /任务号 (job_[0-9a-f]+)/.exec(text)?.[1] ?? "";
/** 一条链接的 secret 至少要 32 字符,给足 64。 */
const SECRET = "a".repeat(64);

/** 驱动 `mcode_agent_start`(直驱 handler,绕过 webToolHost 那道会话闸)。 */
async function startOn(callerSessionId: string, prompt = "do it"): Promise<string> {
  const start = delegateMcpTools().find((s) => s.name === "mcode_agent_start")!;
  return textOf(await start.handler({ prompt }, { sessionId: callerSessionId }));
}
/** 取一次结果(带短等待,让后台 runTurn 收场)。 */
async function resultOf(jobId: string, caller: string): Promise<string> {
  await tick();
  const result = delegateMcpTools().find((s) => s.name === "mcode_agent_result")!;
  return textOf(await result.handler({ job_id: jobId, wait_seconds: 1 }, { sessionId: caller }));
}

console.log("delegate host smoke");

// 装配一次(wiring 的闭包绑定在 stub 上;后续 reset 只清数据,不动接线)。
initAgentDelegate();

/* ── 1. 开关闸:关着时那组工具**连报都不报**,免审批能力根本不存在 ─────────── */
{
  resetRepositories([{ id: "p-a", name: "Alpha", path: "/tmp/alpha", archived: false }]);
  __resetRuntime();
  __resetDelegateJobs();
  SettingRepo.set(PUBLIC_MCP_AGENT_DELEGATE_SETTING_KEY, "0");
  eq("开关关着:委派不可用", delegateAvailable(), false);
  eq("开关关着:工具表里没有委派工具(不报=不在攻击面上)", delegateMcpTools().length, 0);
  SettingRepo.set(PUBLIC_MCP_AGENT_DELEGATE_SETTING_KEY, "1");
  eq("开关打开:委派可用", delegateAvailable(), true);
  eq(
    "开关打开:报出三件委派工具",
    delegateMcpTools().map((s) => s.name).join(","),
    "mcode_agent_start,mcode_agent_result,mcode_agent_cancel",
  );
}

/* ── 2. 权限模式:委派会话必须落在 bypass 档,且只有它一条 ───────────────────── */
await (async () => {
  resetRepositories([{ id: "p-a", name: "Alpha", path: "/tmp/alpha", archived: false }]);
  __resetRuntime();
  __resetDelegateJobs();
  SettingRepo.set(PUBLIC_MCP_AGENT_DELEGATE_SETTING_KEY, "1");
  SettingRepo.set(PUBLIC_MCP_SESSION_ID_SETTING_KEY, "chatgpt-sess");
  SettingRepo.set(PUBLIC_MCP_PROJECT_ID_SETTING_KEY, "p-a");

  await startOn("chatgpt-sess");
  const created = sessionsOf();
  eq("委派建出恰好一条会话", created.length, 1);
  const del = created[0]!;
  eq("★ 委派会话的权限模式是 bypass(免审批是它的定义)", del.permissionMode, "bypassPermissions");
  eq("★ 委派会话绑在发起链接的项目里(默认链接 → 选中的项目)", del.projectId, "p-a");
  eq("委派会话的工作目录 = 项目目录", __turns()[0]?.cwd, "/tmp/alpha");
  eq("委派会话标题点名项目(默认项目用固定名)", del.title, "外部 AI 委派");
  check("★ 委派会话与「ChatGPT 直连」是两条(审计面分得开)", del.id !== "chatgpt-sess", {
    delegate: del.id,
    synthetic: SettingRepo.get(PUBLIC_MCP_SESSION_ID_SETTING_KEY),
  });
  // 委派会话不被误当成公网合成会话去套沙箱根(那条边界只属于 ChatGPT 直连那条)。
  eq("委派会话不被误当作公网合成会话套沙箱", publicMcpSandboxRoot(del.id), null);
})();

/* ── 3. 项目映射:哪条链接进来就在哪个项目里跑 ─────────────────────────────── */
await (async () => {
  resetRepositories([
    { id: "p-a", name: "Alpha", path: "/tmp/alpha", archived: false },
    { id: "p-b", name: "Beta", path: "/tmp/beta", archived: false },
  ]);
  __resetRuntime();
  __resetDelegateJobs();
  SettingRepo.set(PUBLIC_MCP_AGENT_DELEGATE_SETTING_KEY, "1");
  SettingRepo.set(PUBLIC_MCP_PROJECT_ID_SETTING_KEY, "p-a"); // 默认项目管理 A
  SettingRepo.set(
    PUBLIC_MCP_PROJECT_LINKS_SETTING_KEY,
    JSON.stringify([{ projectId: "p-b", secret: SECRET, sessionId: "linkB" }]),
  );

  await startOn("linkB", "b work");
  await startOn("linkB", "b work again"); // 同项目复用
  const afterB = sessionsOf();
  eq("★ 链接 B 的委派只建了一条会话(同项目复用)", afterB.length, 1);
  eq("★ 链接 B 的委派落在 B 的项目(Beta),不塌回默认的 A", afterB[0]!.projectId, "p-b");
  eq("★ 链接 B 的委派工作目录是 B 的目录", __turns().at(-1)?.cwd, "/tmp/beta");
  eq("项目链接的委派会话标题点名项目", afterB[0]!.title, "外部 AI 委派 · Beta");

  // 再加一条链接(A):不同项目必须各建各的会话,不共用。
  SettingRepo.set(
    PUBLIC_MCP_PROJECT_LINKS_SETTING_KEY,
    JSON.stringify([
      { projectId: "p-b", secret: SECRET, sessionId: "linkB" },
      { projectId: "p-a", secret: SECRET, sessionId: "linkA" },
    ]),
  );
  await startOn("linkA", "a work");
  const afterA = sessionsOf();
  eq("★ 两条链接各建一条会话(不共用)", afterA.length, 2);
  const delA = afterA.find((s) => s.projectId === "p-a");
  const delB = afterA.find((s) => s.projectId === "p-b");
  check(
    "★ 两条委派会话 id 不同",
    Boolean(delA && delB && delA.id !== delB.id),
    { a: delA?.id ?? null, b: delB?.id ?? null },
  );
  eq("A 的委派工作目录是 A 的目录", __turns().at(-1)?.cwd, "/tmp/alpha");
})();

/* ── 4. 复用委派会话时**重新钉 bypass**(模式不可覆盖)────────────────────── *
 * 与「ChatGPT 直连」那条一字不差的规矩:那条每次取用都重钉。只在**建**的时候钉一次的
 * 话,用户在界面上把这条会话改成 dontAsk/default 后,下一次委派会弹卡挂死(外面只看得到
 * running)或静默被拒 —— 文件头承诺的免审批就漏了。 */
await (async () => {
  resetRepositories([{ id: "p-a", name: "Alpha", path: "/tmp/alpha", archived: false }]);
  __resetRuntime();
  __resetDelegateJobs();
  SettingRepo.set(PUBLIC_MCP_AGENT_DELEGATE_SETTING_KEY, "1");
  SettingRepo.set(PUBLIC_MCP_SESSION_ID_SETTING_KEY, "chatgpt-sess");
  SettingRepo.set(PUBLIC_MCP_PROJECT_ID_SETTING_KEY, "p-a");

  await startOn("chatgpt-sess"); // 建出委派会话
  const del = sessionsOf()[0]!;
  // 模拟"用户在界面上把这条会话的模式改了":行里落成 dontAsk。
  del.permissionMode = "dontAsk";
  __resetRuntime(); // 清 pin 记录:只看**这一次复用**有没有重新钉(也会清 bound/turns)
  await startOn("chatgpt-sess");
  eq("复用委派会话时不重建(仍是同一条)", sessionsOf().length, 1);
  check(
    "★ 复用已存在的委派会话时把审批模式重新钉回 bypass(不可覆盖)",
    __pins().includes(`${del.id}:bypassPermissions`),
    { pins: __pins() },
  );
})();

/* ── 5. 可区分的拒绝:一个项目都没有时必须明确报错 ─────────────────────────── */
await (async () => {
  resetRepositories([]); // 一个项目都没有
  __resetRuntime();
  __resetDelegateJobs();
  SettingRepo.set(PUBLIC_MCP_AGENT_DELEGATE_SETTING_KEY, "1");
  SettingRepo.set(PUBLIC_MCP_SESSION_ID_SETTING_KEY, "chatgpt-sess");
  const msg = await rejects("★ 一个项目都没有时委派被拒(可区分,不是静默)", () => startOn("chatgpt-sess"));
  check("★ 拒绝理由点名了原因(需要一个项目)", msg.includes("需要一个项目"), msg);
})();

/* ── 6. 会话行"错位"时重建:项目的委派会话指向别项目,必须重建 ───────────────── */
await (async () => {
  resetRepositories([{ id: "p-a", name: "Alpha", path: "/tmp/alpha", archived: false }]);
  __resetRuntime();
  __resetDelegateJobs();
  SettingRepo.set(PUBLIC_MCP_AGENT_DELEGATE_SETTING_KEY, "1");
  SettingRepo.set(PUBLIC_MCP_SESSION_ID_SETTING_KEY, "chatgpt-sess");
  SettingRepo.set(PUBLIC_MCP_PROJECT_ID_SETTING_KEY, "p-a");
  SessionRepo.create({ id: "sess_stale", projectId: "p-old", permissionMode: "bypassPermissions" });
  SettingRepo.set(PUBLIC_MCP_DELEGATE_SESSIONS_SETTING_KEY, JSON.stringify({ "p-a": "sess_stale" }));
  await startOn("chatgpt-sess");
  const created = sessionsOf().filter((s) => s.id !== "sess_stale");
  eq("★ 会话绑错项目时重建一条(不用旧项目的会话)", created.length, 1);
  eq("★ 新会话绑在正确的项目", created[0]?.projectId ?? null, "p-a");
})();

/* ── 7. runTurn 接线:订阅早于 sendTurn、错误如实回报、审批提示写给外面 ───────── */
await (async () => {
  resetRepositories([{ id: "p-a", name: "Alpha", path: "/tmp/alpha", archived: false }]);
  __resetRuntime();
  __resetDelegateJobs();
  SettingRepo.set(PUBLIC_MCP_AGENT_DELEGATE_SETTING_KEY, "1");
  SettingRepo.set(PUBLIC_MCP_SESSION_ID_SETTING_KEY, "chatgpt-sess");
  SettingRepo.set(PUBLIC_MCP_PROJECT_ID_SETTING_KEY, "p-a");

  // (a) 订阅必须早于 sendTurn:stub 在 sendTurn **执行期间**同步派发一段文字。
  __setOnSend((session) => {
    __emit({ type: "text.delta", sessionId: session.id, text: "第一句" });
  });
  const t1 = await startOn("chatgpt-sess", "run a");
  const res1 = await resultOf(jobIdOf(t1), "chatgpt-sess");
  check("★ sendTurn 期间发出的文字被收进来(订阅挂在了它之前)", res1.includes("第一句"), res1);

  // (b) error 事件 → 这一轮收场成 failed,错误如实回报(不静默)。
  __resetDelegateJobs();
  SettingRepo.set(PUBLIC_MCP_DELEGATE_SESSIONS_SETTING_KEY, JSON.stringify({}));
  __setOnSend((session) => {
    __emit({ type: "text.delta", sessionId: session.id, text: "部分" });
    __emit({ type: "error", sessionId: session.id, message: "boom" });
  });
  const t2 = await startOn("chatgpt-sess", "run b");
  const res2 = await resultOf(jobIdOf(t2), "chatgpt-sess");
  check("★ error 事件让这一轮报 failed", res2.includes("状态:failed"), res2);
  check("★ 错误信息如实回报(不静默)", res2.includes("boom"), res2);

  // (c) approval.request → 把"在等用户在桌面端批准"写进进展里(外面才看得懂为什么停)。
  __resetDelegateJobs();
  SettingRepo.set(PUBLIC_MCP_DELEGATE_SESSIONS_SETTING_KEY, JSON.stringify({}));
  __setOnSend((session) => {
    __emit({ type: "approval.request", sessionId: session.id, toolName: "agent_bash" });
  });
  const t3 = await startOn("chatgpt-sess", "run c");
  const res3 = await resultOf(jobIdOf(t3), "chatgpt-sess");
  check("★ 审批请求写成外面看得懂的进展", res3.includes("等待用户在 Mcode 桌面端批准:agent_bash"), res3);
})();

/* ── 8. busy 闸:同一条会话忙着时新的委派被拒(不排队、不叠轮)────────────────── */
await (async () => {
  resetRepositories([{ id: "p-a", name: "Alpha", path: "/tmp/alpha", archived: false }]);
  __resetRuntime();
  __resetDelegateJobs();
  SettingRepo.set(PUBLIC_MCP_AGENT_DELEGATE_SETTING_KEY, "1");
  SettingRepo.set(PUBLIC_MCP_SESSION_ID_SETTING_KEY, "chatgpt-sess");
  SettingRepo.set(PUBLIC_MCP_PROJECT_ID_SETTING_KEY, "p-a");
  __setOnSend(null); // sendTurn 立刻收场
  await startOn("chatgpt-sess");
  const sid = sessionsOf()[0]!.id;
  __setBusy(sid, true);
  const second = await startOn("chatgpt-sess");
  check("★ 会话正忙时新的委派被拒(报 busy,不排队)", second.includes("busy"), second);
})();

/* ── 9. 委派确实把活发到了它自己那条会话上(bind + turn 都落在会话 id 上)─────── */
await (async () => {
  resetRepositories([{ id: "p-a", name: "Alpha", path: "/tmp/alpha", archived: false }]);
  __resetRuntime();
  __resetDelegateJobs();
  SettingRepo.set(PUBLIC_MCP_AGENT_DELEGATE_SETTING_KEY, "1");
  SettingRepo.set(PUBLIC_MCP_SESSION_ID_SETTING_KEY, "chatgpt-sess");
  SettingRepo.set(PUBLIC_MCP_PROJECT_ID_SETTING_KEY, "p-a");
  await startOn("chatgpt-sess", "具体任务");
  const sid = sessionsOf()[0]!.id;
  check("★ 委派会话建出来后被绑进运行时", __bound().includes(sid), { bound: __bound(), sid });
  eq("★ 那一轮发到委派会话上、带着任务与项目目录", `${__turns()[0]?.sessionId}|${__turns()[0]?.prompt}|${__turns()[0]?.cwd}`, `${sid}|具体任务|/tmp/alpha`);
})();

console.log(`delegate host smoke: ${total - failures}/${total} 通过`);
if (failures > 0) process.exitCode = 1;
