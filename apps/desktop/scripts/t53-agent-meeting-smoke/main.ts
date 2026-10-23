/**
 * 【T53】**多方会议到底能不能开？** —— 实测现有 `agentMail`,不造新机制。
 *
 * ## 这张卡问的不是"实现",是"已经能用吗"
 *
 * 台账 3.17 记过：SDK 会话**不 spawn teammate**（官方文档原句），所以「多方会议」
 * 走不了 SDK 原生那条路。但 `agentMail` 的一对一通道是宿主自己实现的，与 SDK 无关。
 *
 * 于是真正的问题是：**A 同时问 B 和 C、各自回答、A 综合 —— 这条链现在通不通？**
 *
 * ## 本套件钉什么
 *
 *  1. **并发挂账**：A 在同一条会话里连问 B、C，两条挂账并存、编号不同；
 *  2. **各自回信**：B 按自己的编号回、C 按自己的编号回 —— **各自落到 A 的收件箱，
 *     且不串号**（这是多方会议唯一真正会错的地方：答复对不上提问）；
 *  3. **顺序无关**：先回 C 再回 B，结果一样；
 *  4. **第三、第四方**：再问 D 也成立（不是"只有两个能开会"）；
 *  5. **收件箱完整**：A 一次取走这一批，三份答复都在、各自带着自己的编号；
 *  6. **取走后挂账清零**（MC-032 的销账时机，不能被多方改坏）；
 *  7. **负控**：拿别人的编号回信 → 拒绝，且不吃掉任何挂账。
 *
 * ## 不碰什么
 *
 * 不新增工具、不改 `agentMail.ts`。**这张卡如果全绿，结论就是「不需要实现」**。
 */
import { initDb } from "@main/store/db.js";
import { ProjectRepo, SessionRepo } from "@main/store/repositories.js";
import type { Session } from "@contracts/session";
import {
  clearAgentMail,
  peekAgentMail,
  peekAgentMailBatch,
  recordAsk,
  setDeliveryPort,
  undeliveredCount,
  setMessageWindowMs,
} from "@main/lib/agentMail.js";
import { workflowMcpTools } from "@main/mcp/mcodeServer.js";

let total = 0;
let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  total++;
  if (condition) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail).slice(0, 600)}`}`);
  }
}
const eq = (name: string, actual: unknown, expected: unknown): void =>
  check(name, Object.is(actual, expected), { actual, expected });

/* ──────────────────── 0. 临时库 ──────────────────── */

const PROJECT = "proj_t53";
await initDb();
ProjectRepo.create({
  id: PROJECT, name: "T53 会议", path: "C:/work/t53",
  archived: false, pinnedAt: null, sortOrder: 0, createdAt: 1, updatedAt: 1,
});

let seq = 0;
function mkSession(over: Partial<Session> & { title: string; kind: Session["kind"] }): Session {
  seq += 1;
  const s: Session = {
    id: `t53_${seq}`,
    projectId: PROJECT,
    providerId: "claude-sdk",
    claudeSessionId: null,
    parentSessionId: null,
    nodeId: null,
    status: "idle",
    model: "sonnet",
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
    turnFiles: null,
    usageHistory: null,
    bookmarks: null,
    subagentTranscripts: null,
    createdAt: 1_700_000_000_000 + seq,
    updatedAt: 1_700_000_000_000 + seq,
    ...over,
  };
  SessionRepo.create(s);
  return s;
}

/* ──────────────────── 1. 投递端口（桩，与 agent-mail-smoke 同形） ──────────────────── */

/** 被"图管着"的会话：此时投递只会排队，不会叫醒。 */
const graphBlocked = new Set<string>();
setDeliveryPort({
  isRunning: () => false,
  inject: () => false,
  canWake: (id: string) => !graphBlocked.has(id),
  wake: (id: string) => ({ ok: true, detail: `叫醒 ${id}` }),
  announce: () => undefined,
} as never);

/* ──────────────────── 2. 真调工具 handler ──────────────────── */

const tools = new Map(workflowMcpTools().map((t) => [t.name, t] as const));
function tool(name: string): { handler: (args: never, ctx: { sessionId: string }) => Promise<unknown> } {
  const spec = tools.get(name);
  if (!spec) throw new Error(`工具没注册：${name}`);
  return spec as never;
}
const isErr = (value: unknown): boolean => {
  const r = value as { isError?: boolean } | null;
  return r?.isError === true;
};
const textOf = (value: unknown): string => {
  const r = value as { content?: Array<{ text?: string }> } | null;
  return (r?.content ?? []).map((c) => c.text ?? "").join("");
};
const callTool = async (name: string, args: unknown, sessionId: string): Promise<unknown> =>
  tool(name).handler(args as never, { sessionId });
/** 从工具返回里取编号。 */
const askIdOf = (value: unknown): string => /ask_[a-z0-9_]+/.exec(textOf(value))?.[0] ?? "";

/* ──────────────────── 3. 会议：主持人 + 三名与会者 ──────────────────── */

console.log("\n① 名册：主持人能看到全部与会者");
const chair = mkSession({ kind: "chat", title: "主持" });
const b = mkSession({ kind: "node", title: "评审B", parentSessionId: chair.id, nodeId: "b" });
const c = mkSession({ kind: "node", title: "检索C", parentSessionId: chair.id, nodeId: "c" });
const d = mkSession({ kind: "node", title: "校对D", parentSessionId: chair.id, nodeId: "d" });
{
  const peers = textOf(await callTool("agent_peers", {}, chair.id));
  for (const name of ["评审B", "检索C", "校对D"]) {
    check(`名册里有 ${name}`, peers.includes(name), { peers: peers.slice(0, 300) });
  }
  check("名册里没有自己", !peers.includes("主持"), { peers: peers.slice(0, 300) });
}

console.log("\n② 并发提问：主持人一次问 B 和 C，两条挂账并存");
// 让主持人处于"被图管着"的排队态 —— 这是多方会议最常见的情形（主持人本身是主对话，
// 图正在跑）。排队态下挂账**不会**被投递销掉，正好用来看清多条并存。
graphBlocked.add(chair.id);
const before = undeliveredCount(chair.id);
const askB = await callTool("agent_ask", { to: "评审B", text: "请评审第三章的方法论" }, chair.id);
const askC = await callTool("agent_ask", { to: "检索C", text: "请检索近三年同主题综述" }, chair.id);
const idB = askIdOf(askB);
const idC = askIdOf(askC);
{
  check("问 B 没报错", !isErr(askB), askB);
  check("问 C 没报错", !isErr(askC), askC);
  check("两条都拿到编号", idB !== "" && idC !== "", { idB, idC });
  check("★ 编号不同（不会串号的前提）", idB !== idC, { idB, idC });
  eq("★ 两条挂账并存", undeliveredCount(chair.id) - before, 2);
}

console.log("\n③ 各自回信：按自己的编号回，不串号");
{
  // **先回 C，再回 B** —— 顺序与提问顺序相反，专门盯"按顺序猜人"的实现错误。
  const backC = await callTool("agent_notify", { to: chair.id, re: idC, text: "C 的检索结果：共 12 篇" }, c.id);
  check("C 回信没报错", !isErr(backC), backC);
  const backB = await callTool("agent_notify", { to: chair.id, re: idB, text: "B 的评审意见：方法一节偏薄" }, b.id);
  check("B 回信没报错", !isErr(backB), backB);

  const inbox = peekAgentMail(chair.id);
  check("★ 主持人的收件箱里有 C 的答复", inbox.includes("C 的检索结果：共 12 篇"), { inbox: inbox.slice(0, 500) });
  check("★ 主持人的收件箱里有 B 的答复", inbox.includes("B 的评审意见：方法一节偏薄"), { inbox: inbox.slice(0, 500) });
  check("★ C 的答复带着 C 的编号", inbox.includes(idC), { idC });
  check("★ B 的答复带着 B 的编号", inbox.includes(idB), { idB });
  // 串号的正确判据：**每一条答复段自己带的编号**必须是它对应的那个提问编号。
  // 不能拿「C 的段落之后是否出现 B 的编号」来判 —— 收件箱是连续投递的流，C 的答复后面
  // 本来就是 B 的整段（实测踩到：那条断言红，红的是断言自己）。
  const segments = inbox.split("## 另一名代理给你捎了一句话").filter((seg) => seg.trim() !== "");
  const idByText = (marker: string): string => {
    const seg = segments.find((item) => item.includes(marker));
    return /ask_[a-z0-9_]+/.exec(seg ?? "")?.[0] ?? "";
  };
  check("★ C 那段带的正是 C 的编号", idByText("C 的检索结果") === idC, { got: idByText("C 的检索结果"), want: idC });
  check("★ B 那段带的正是 B 的编号", idByText("B 的评审意见") === idB, { got: idByText("B 的评审意见"), want: idB });
  check("★ 两条答复不在同一段里（没有粘连）",
    segments.filter((seg) => seg.includes("C 的检索结果")).length === 1
      && segments.filter((seg) => seg.includes("B 的评审意见")).length === 1,
    { segmentCount: segments.length });
}

console.log('\n④ 第三方加入：会议不是「只有两个能开」');
{
  const askD = await callTool("agent_ask", { to: "校对D", text: "请校对术语一致性" }, chair.id);
  const idD = askIdOf(askD);
  check("问 D 没报错", !isErr(askD), askD);
  check("D 拿到独立编号", idD !== "" && idD !== idB && idD !== idC, { idD, idB, idC });
  const backD = await callTool("agent_notify", { to: chair.id, re: idD, text: "D 的校对结果：3 处不一致" }, d.id);
  check("D 回信没报错", !isErr(backD), backD);
  const inbox = peekAgentMail(chair.id);
  check("★ 三份答复同时在场", inbox.includes("C 的检索结果") && inbox.includes("B 的评审意见") && inbox.includes("D 的校对结果"),
    { inbox: inbox.slice(0, 600) });
}

console.log("\n⑤ 一次取走：三份答复都在，取走后挂账清零");
{
  const batch = peekAgentMailBatch(chair.id);
  check("这一批非空", batch.text.length > 0, { len: batch.text.length });
  clearAgentMail(chair.id, batch.through);
  eq("★ 取走后挂账清零（多方没有破坏 MC-032 的销账时机）", undeliveredCount(chair.id), 0);
  check("★ 取走后收件箱也空了", peekAgentMail(chair.id).trim() === "", { rest: peekAgentMail(chair.id).slice(0, 200) });
}

console.log("\n⑥ 负控：拿别人的编号回信 → 拒绝，且不吃挂账");
{
  const askB2 = await callTool("agent_ask", { to: "评审B", text: "第二轮：请复核修改后的章节" }, chair.id);
  const idB2 = askIdOf(askB2);
  check("第二轮提问拿到编号", idB2 !== "", askB2);
  const asksBefore = undeliveredCount(chair.id);

  // C 拿 B 的编号回 —— 编号存在，但 C 不是被问的那一方。
  const forged = await callTool("agent_notify", { to: chair.id, re: idB2, text: "C 冒充 B 的回答" }, c.id);
  check("★ 伪造回信被拒（或至少不当作 B 的答复）", isErr(forged) || !peekAgentMail(chair.id).includes("冒充"), {
    forged: textOf(forged).slice(0, 200),
  });
  eq("★ 被拒后挂账没被吃掉", undeliveredCount(chair.id), asksBefore);

  // 假编号
  const bogus = await callTool("agent_notify", { to: chair.id, re: "ask_不存在", text: "随便回" }, b.id);
  check("★ 假编号被拒", isErr(bogus), bogus);
  eq("★ 假编号也没吃挂账", undeliveredCount(chair.id), asksBefore);
}

console.log(`\nt53-agent-meeting-smoke:${total - failures}/${total} 通过`);
process.exit(failures === 0 ? 0 : 1);
