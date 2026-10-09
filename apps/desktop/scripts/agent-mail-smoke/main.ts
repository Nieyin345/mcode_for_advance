import { RUNTIME_FALLBACK_MODELS_SETTING_KEY } from "@contracts/ipc";
import { automationOriginOf } from "@main/orchestration/automationEventOrigin.js";
import type { RuntimeEvent } from "@contracts/runtime";
/**
 * Headless smoke for **代理之间通信** —— `main/lib/agentMail.ts` 那套(名册 / 投递 /
 * 上限 / 挂账)加上 `mcodeServer.ts` 里那三个工具。
 *
 * ## 为什么这是独立一套
 *
 * 这套的判定**全是"谁被允许跟谁说话"**:名册的范围、跨树拒绝、重名拆开、条数上限、
 * 回信的路由。它们错了的样子**都不报错** ——
 *
 *   - 名册范围放大 → 一个对话的代理能叫醒另一个项目的会话(而它以为自己找对了人);
 *   - 重名不拆 → 模型写 `to: "评审"` 投给一个不确定的对象;
 *   - `re` 匹配不精确 → 一段答复投给另一个提问方,两边都以为发对了;
 *   - 上限没了 → 两个代理互发到天荒地老,界面上只是"聊个没完"。
 *
 * 所以这里**真建库、真写会话行、真取名册、真投递**。断言"源码里写着某个字符串"在一个
 * 把函数体清空的实现上照样绿(仓规:断言要测行为,不是文本)。
 *
 * ## 接口都是**真调工具 handler**,不是直接调 helper
 *
 * `agent_peers` / `agent_notify` / `agent_ask` 三条 spec 从 `workflowMcpTools()` 里取出来
 * 调它们的 `handler`。这样"工具表里有没有这条、它的入参形状对不对、它回的话说不说得清"
 * 一并被验到 —— 只调 helper 的话,工具没注册上去也照样绿。
 *
 * ## 投递端口是**真注册的桩**
 *
 * `setDeliveryPort` 按会话 id 回答"在不在跑 / 能不能叫醒",并记下每次 inject / wake。
 * 那是唯一能观察"消息到底怎么进去的"的窗口(真的那侧要起 SDK 子进程)。
 * `canWake` **故意不是常量**:见 `blockGraph()` —— 它要能模拟"图正在跑"。
 *
 * Run: scripts/agent-mail-smoke/run.sh
 */
import { initDb } from "@main/store/db.js";
import { ProjectRepo, SessionRepo, SettingRepo } from "@main/store/repositories.js";
import type { Session } from "@contracts/session";
import type { AgentProvider, StartTurnRequest, TurnHandle, ProviderContext } from "@contracts/provider";
import type { ApiConfig } from "@contracts/customModel";
import {
  MAX_MESSAGES_PER_SESSION,
  deliver,
  clearAgentMail,
  dropAgentMail,
  peekAgentMail,
  peekAgentMailBatch,
  peersOf,
  resolvePeer,
  selfPeerOf,
  recordAsk,
  setDeliveryPort,
  setMessageWindowMs,
  mailNoticeText,
  type MailNotice,
  wakeQueued,
  undeliveredCount,
  unknownPeerMessage,
} from "@main/lib/agentMail.js";
import { AGENT_MAIL_TOOLS, WORKFLOW_READONLY_TOOLS, workflowMcpTools } from "@main/mcp/mcodeServer.js";
import { shouldAutoApprove } from "@main/mcp/toolRules.js";
import { AGENT_MCP_SERVER } from "@main/mcp/agentTools.js";
import { AGENT_ENGINE_MCP_SERVER } from "@main/mcp/agentEngineBridge.js";
import { MCP_WORKFLOW_SERVER } from "@contracts/ipc/mcp";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import { parseIncomingMail, readOutgoingMail, isAgentMailTool } from "@renderer/lib/agentMail.js";
import { providerRegistry } from "@main/providers/registry.js";
import { CustomModelStore } from "@main/lib/secretStore.js";
import { BridgeRegistry } from "@main/providers/bridge/bridgeRegistry.js";
import type { BridgeHandle } from "@main/providers/bridge/bridgeServer.js";
import { mobileEventBus } from "@main/mobile/MobileEventBus.js";

let failures = 0;
let checks = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  checks += 1;
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

/* ──────────────────── 0. 临时库 ──────────────────── */

const PROJECT = "proj_1";
await initDb();
ProjectRepo.create({
  id: PROJECT,
  name: "论文",
  path: "C:/work/paper",
  archived: false,
  pinnedAt: null,
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
});

let seq = 0;
/** 建一条会话行。**形状逐字照 `session-subchat-smoke` 的 `newParent`** —— 少了哪个
 *  NOT NULL 列,库会当场拒(那个坑在那边记着)。 */
function mkSession(over: Partial<Session> & { title: string; kind: Session["kind"] }): Session {
  seq += 1;
  const s: Session = {
    id: `sess_${seq}`,
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

/* ──────────────────── 1. 投递端口(桩) ──────────────────── */

console.log("\n① 运行时的真实唤醒闸门:图跑着时主对话和节点都不能被叫醒");
{
  const main = mkSession({ kind: "chat", title: "图的主对话" });
  const node = mkSession({ kind: "node", title: "图的节点", parentSessionId: main.id, nodeId: "guard" });
  const side = mkSession({ kind: "side", title: "独立子对话", parentSessionId: main.id });
  const orphan = mkSession({ kind: "node", title: "失联节点" });

  // 闸门未接到调度器时,不能靠“图不存在”的猜测起一轮:会打乱真实图的 turn.done。
  runtimeManager.registerRunGuard(null);
  eq("★ 主对话:未注册闸门则保守排队", runtimeManager.canWakeSession(main.id), false);
  eq("★ 节点:未注册闸门则保守排队", runtimeManager.canWakeSession(node.id), false);
  eq("没有父对话的节点不能唤醒", runtimeManager.canWakeSession(orphan.id), false);
  eq("没有对应会话不能唤醒", runtimeManager.canWakeSession("does_not_exist"), false);
  eq("独立子对话不受图闸门影响", runtimeManager.canWakeSession(side.id), true);

  const activeRoots = new Set([main.id]);
  runtimeManager.registerRunGuard((id) => activeRoots.has(id));
  eq("★ 图在跑:主对话也必须排队", runtimeManager.canWakeSession(main.id), false);
  eq("★ 图在跑:节点按父对话 id 排队", runtimeManager.canWakeSession(node.id), false);
  eq("图在跑:独立子对话还能唤醒", runtimeManager.canWakeSession(side.id), true);
  // bind 真正的运行时,只把 sendTurn 换成计数桩:否则旧实现会真的起 SDK 回合。
  // 这样“直接 wake 被图挡住”不能靠“根本没有运行时”误打误撞通过。
  const sendTurn = runtimeManager.sendTurn;
  let attempted = 0;
  runtimeManager.sendTurn = async () => { attempted += 1; return null; };
  try {
    runtimeManager.bindSession(main);
    eq("★ 直接调用 wake 也不能绕过图闸门", runtimeManager.wakeSession(main.id, "不要插队"), false);
    eq("★ 图挡住时没偷偷起一轮", attempted, 0);
    runtimeManager.dispose(main.id);
    activeRoots.delete(main.id);
    eq("图收尾:主对话又能唤醒", runtimeManager.canWakeSession(main.id), true);
    eq("图收尾:节点又能唤醒", runtimeManager.canWakeSession(node.id), true);
    eq("★ 运行时未绑定不能假装已叫醒", runtimeManager.wakeSession(node.id, "还没绑定"), false);
    eq("★ 未绑定时没偷偷起一轮", attempted, 0);
  } finally {
    runtimeManager.dispose(main.id);
    runtimeManager.sendTurn = sendTurn;
    runtimeManager.registerRunGuard(null);
  }
}

/** 这些会话"此刻在跑"。 */
const running = new Set<string>();
/** 这些会话"有一张图正管着它" —— 见 `blockGraph`。 */
const graphBlocked = new Set<string>();
/** 记下每一次 inject / wake,断言看它。 */
const injected: Array<{ sessionId: string; text: string }> = [];
const woken: Array<{ sessionId: string; text: string }> = [];
/** 记下每一次"画给用户看"(announce)。 */
const announced: Array<{ sessionId: string; notice: MailNotice }> = [];
/** `inject` 该不该成功(模拟引擎不支持插话的 Pi / Codex)。 */
let injectWorks = true;

setDeliveryPort({
  isRunning: (id) => running.has(id),
  inject: (id, text) => {
    if (!injectWorks) return false;
    injected.push({ sessionId: id, text });
    return true;
  },
  canWake: (id) => !graphBlocked.has(id),
  wake: (id, text) => {
    // 假引擎立刻成功启动:模拟 RuntimeManager 的收件箱回执。
    const batch = peekAgentMailBatch(id);
    woken.push({ sessionId: id, text: [text, batch.text].filter(Boolean).join("\n") });
    clearAgentMail(id, batch.through);
    return true;
  },
  announce: (id, notice) => { announced.push({ sessionId: id, notice }); },
});

/* ──────────────────── 2. 取工具 ──────────────────── */

const specs = new Map(workflowMcpTools().map((s) => [s.name, s]));
const peersTool = specs.get("agent_peers");
const notifyTool = specs.get("agent_notify");
const askTool = specs.get("agent_ask");
if (!peersTool || !notifyTool || !askTool) throw new Error("三个工具没注册进 workflowMcpTools()");

/** 按工具名调它的 handler。**入参形状已经由 zod 校验过**(生产路径由 SDK/webToolHost
 *  按 `inputSchema` 校),这里直接喂。 */
async function callTool(name: string, args: Record<string, unknown>, sessionId: string): Promise<string> {
  const spec = specs.get(name);
  if (!spec) throw new Error(`没有工具 ${name}`);
  const r = (await spec.handler(args as never, { sessionId })) as {
    content: Array<{ text?: string }>;
    isError?: boolean;
  };
  return (r.content[0]?.text ?? "") + (r.isError === true ? "\u0000ERR" : "");
}

const isErr = (s: string): boolean => s.endsWith("\u0000ERR");

/* ──────────────────── 3. 名册 ──────────────────── */

console.log("\n① 名册:一棵树,从哪一格看都一致,而且不含自己");
{
  const main = mkSession({ kind: "chat", title: "写第四章" });
  const n1 = mkSession({ kind: "node", title: "检索", parentSessionId: main.id, nodeId: "n_seek" });
  const n2 = mkSession({ kind: "node", title: "成稿", parentSessionId: main.id, nodeId: "n_write" });
  mkSession({ kind: "side", title: "随手问", parentSessionId: main.id });

  const fromMain = peersOf(main.id).map((p) => p.name);
  const fromNode = peersOf(n1.id).map((p) => p.name);

  eq("从主对话看:三个 peer", fromMain.length, 3);
  check("★ 从主对话看不含自己(自己永远不在名册里)", !fromMain.includes("主对话"), fromMain);
  check("含两个节点", fromMain.includes("检索") && fromMain.includes("成稿"), fromMain);
  check("含子对话", fromMain.includes("随手问"), fromMain);
  eq("从节点看:也是三个", fromNode.length, 3);
  check("★ 从节点看不含自己", !fromNode.includes("检索"), fromNode);
  check("★ 从节点看能看见主对话", fromNode.includes("主对话"), fromNode);

  /* ── 中途加的子代理必须立刻在名册里 ──
   *
   * 用户会在工作流跑的过程中自己再添一个。开跑那一刻冻结一份名册的话,新加的那个就
   * 不在,而它恰恰是最该能被找到的。这一条钉的是"现查",不是"缓存"。 */
  mkSession({ kind: "node", title: "审稿", parentSessionId: main.id, nodeId: "n_rev" });
  const after = peersOf(n1.id).map((p) => p.name);
  eq("★ 中途加的在名册里(现查,不是缓存)", after.length, 4);
  check("★ 新加那个真在里面", after.includes("审稿"), after);

  /* ── 重名要拆开 ──
   *
   * 用户复制了一格,两个都叫「评审」。名册给两个同名条目的话,模型写 `to: "评审"` 投给谁
   * 是不确定的 —— 而它不会知道,只会以为发对了。 */
  const dup1 = mkSession({ kind: "node", title: "评审", parentSessionId: main.id, nodeId: "d1" });
  const dup2 = mkSession({ kind: "node", title: "评审", parentSessionId: main.id, nodeId: "d2" });
  const names = peersOf(main.id).map((p) => p.name);
  eq("★ 重名被拆开(名字仍然唯一)", new Set(names).size, names.length);
  eq("★ 正主保持原名", names.filter((n) => n === "评审").length, 1);
  check("★ 后来者带上 id", names.some((n) => n.startsWith("评审(")), names);
  check("两个都还在名册里", names.includes("评审") && names.some((n) => n.startsWith("评审(")), names);
  // 拆开之后两个都投得到 —— 这是"拆开"真正的目的。
  check("两个都投得到", resolvePeer(main.id, dup1.id) !== undefined && resolvePeer(main.id, dup2.id) !== undefined);

  /* ── 别的对话底下的不在名册里 ── */
  const otherMain = mkSession({ kind: "chat", title: "另一个对话" });
  mkSession({ kind: "node", title: "别人的节点", parentSessionId: otherMain.id, nodeId: "on" });
  const here = peersOf(main.id).map((p) => p.name);
  check("★ 另一个对话的节点不在名册里", !here.includes("别人的节点"), here);
  check("★ 另一个对话也不在", !here.includes("另一个对话"), here);

  console.log("\n② 寻址:名字和 id 都认,名册外的明确拒");
  const byName = resolvePeer(main.id, "检索");
  eq("按名字找得到", byName?.id, n1.id);
  const byId = resolvePeer(main.id, n2.id);
  eq("按 id 找得到", byId?.name, "成稿");
  eq("名册外 → undefined", resolvePeer(main.id, "查无此人"), undefined);
  check("★ 拒的话里带了现在有谁", unknownPeerMessage(main.id, "查无此人").includes("检索"), unknownPeerMessage(main.id, "查无此人"));
  check("★ 拒的话里带了那个错名字", unknownPeerMessage(main.id, "查无此人").includes("查无此人"));

  console.log("\n③ 跨树发送:拒绝,而且说清是名册的问题");
  const cross = await callTool("agent_notify", { to: "别人的节点", text: "在吗" }, main.id);
  check("★ 跨树发送被拒", isErr(cross), cross);
  check("★ 说清了名册上没有", cross.includes("名册上没有"), cross);
}

/* ──────────────────── 4. 投递三档 ──────────────────── */

console.log("\n④ 投递:对方在跑 → 插播;空闲且图没管着 → 叫醒;图在管 → 排队");
{
  const main = mkSession({ kind: "chat", title: "主对话 A" });
  const busy = mkSession({ kind: "node", title: "忙的节点", parentSessionId: main.id, nodeId: "b" });
  const idle = mkSession({ kind: "node", title: "闲的节点", parentSessionId: main.id, nodeId: "i" });
  const held = mkSession({ kind: "node", title: "图管着的", parentSessionId: main.id, nodeId: "h" });
  const self = selfPeerOf(main.id);

  // ① 在跑 → 插播
  running.add(busy.id);
  const r1 = deliver(peerOrThrow(main.id, "忙的节点"), {
    fromName: self.name,
    fromId: self.id,
    kind: "notify",
    text: "这句要插进去",
  });
  eq("★ 在跑 → injected", r1.outcome, "injected");
  eq("★ 插播真的调了 inject", injected.at(-1)?.sessionId, busy.id);
  check("★ 插播的内容带着发信人", injected.at(-1)?.text.includes(self.name) === true, injected.at(-1)?.text);
  eq("★ 插播的信画给了用户看(收件会话)", announced.at(-1)?.sessionId, busy.id);
  eq("…标明是插播", announced.at(-1)?.notice.outcome, "injected");
  check("…展示文字带发信人和正文", (() => {
    const n = announced.at(-1)?.notice;
    const s = n ? mailNoticeText(n) : "";
    return s.includes(self.name) && s.includes("这句要插进去") && s.includes("消息");
  })(), announced.at(-1));
  // 渲染层把这段文字拆回「谁发的 / 哪一种 / 正文」画成信件卡 —— 两边的格式必须对得上。
  {
    const n = announced.at(-1)!.notice;
    const p = parseIncomingMail(mailNoticeText(n));
    eq("★ 渲染层拆得出发信人", p.from, self.name);
    eq("…拆得出种类", p.what, "notify");
    eq("…插播的不算排队", p.queued, false);
    eq("…正文原样", p.text, n.text);
    const ask = parseIncomingMail(mailNoticeText({ ...n, kind: "ask", text: "第一行\n\n第二段" }));
    eq("…提问 + 多段正文也拆得开", JSON.stringify([ask.what, ask.text]), JSON.stringify(["ask", "第一行\n\n第二段"]));
    eq("…回信认得出", parseIncomingMail(mailNoticeText({ ...n, re: "ask_1" })).what, "reply");
    eq("…排队的认得出", parseIncomingMail(mailNoticeText({ ...n, outcome: "queued" })).queued, true);
    check("…发信工具三家引擎的名字都认", ["mcp__mcode-workflow__agent_notify", "mcp__mcode__agent_ask"].every(isAgentMailTool) && !isAgentMailTool("mcp__mcode-workflow__agent_peers"));
    eq("…发信参数读得出", JSON.stringify(readOutgoingMail("mcp__x__agent_notify", { to: "评审", text: "好了", re: "ask_9" })), JSON.stringify({ kind: "notify", to: "评审", text: "好了", re: "ask_9" }));
  }
  running.delete(busy.id);

  // ② 空闲 + 图没管着 → 叫醒
  const r2 = deliver(peerOrThrow(main.id, "闲的节点"), {
    fromName: self.name,
    fromId: self.id,
    kind: "notify",
    text: "叫醒它",
  });
  eq("★ 空闲且无图 → woke", r2.outcome, "woke");
  eq("★ 叫醒真的调了 wake", woken.at(-1)?.sessionId, idle.id);
  eq("★ 叫醒没走收件箱", peekAgentMail(idle.id), "");
  eq("★ 叫醒的信也画给用户看", announced.at(-1)?.sessionId, idle.id);
  eq("…标明是叫醒", announced.at(-1)?.notice.outcome, "woke");

  // ③ 空闲但图正管着 → 排队(替它起一轮会废掉一步产出)
  graphBlocked.add(held.id);
  const r3 = deliver(peerOrThrow(main.id, "图管着的"), {
    fromName: self.name,
    fromId: self.id,
    kind: "notify",
    text: "这条得排队",
  });
  eq("★ 图在管 → queued", r3.outcome, "queued");
  check("★ 排进收件箱了", peekAgentMail(held.id).includes("这条得排队"), peekAgentMail(held.id));
  check("★ 排队时没有偷偷叫醒", !woken.some((w) => w.sessionId === held.id), woken);
  graphBlocked.delete(held.id);

  // ④ 引擎不支持插话(Pi / Codex)→ 退回收件箱,而不是丢
  running.add(busy.id);
  injectWorks = false;
  const r4 = deliver(peerOrThrow(main.id, "忙的节点"), {
    fromName: self.name,
    fromId: self.id,
    kind: "notify",
    text: "插不进去就得存着",
  });
  eq("★ 插不进去 → 退回收件箱", r4.outcome, "queued");
  check("★ 那条真在收件箱里(没丢)", peekAgentMail(busy.id).includes("插不进去就得存着"), peekAgentMail(busy.id));
  injectWorks = true;
  running.delete(busy.id);

  console.log("\n⑤ 收件箱:peek 不动队列,清了才没");
  // ⚠️ 顺序要紧:先读一次存下来,再做"清掉"的断言 —— 读在清之后的话,那两条断的是
  // 空字符串,而它们会**因为队列已经空了**而绿(不是因为内容对)。这正是仓规里
  // "断言因为错的理由绿"那一档。
  const before = peekAgentMail(busy.id);
  check("★ peek 两次内容一样(没被取走)", before.length > 0 && peekAgentMail(busy.id) === before, before.slice(0, 120));
  check("★ peek 带抬头(别让收到的人去回复这段)", before.includes("别的代理"), before.slice(0, 200));
  dropAgentMail(busy.id);
  eq("★ 清掉之后就没了", peekAgentMail(busy.id), "");

  console.log("\n⑥ 条数上限:撞上了要如实说,而且真挡住");
  const flood = peerOrThrow(main.id, "图管着的");
  graphBlocked.add(held.id);
  let last = { outcome: "", detail: "" };
  for (let i = 0; i < MAX_MESSAGES_PER_SESSION + 1; i += 1) {
    last = deliver(flood, { fromName: self.name, fromId: self.id, kind: "notify", text: `第 ${i} 条` });
  }
  eq("★ 超过上限 → failed", last.outcome, "failed");
  check("★ 被挡下的那条不画给用户看(没送到)", announced.at(-1)?.notice.text !== `第 ${MAX_MESSAGES_PER_SESSION} 条`, announced.at(-1));
  check("★ 排队的信画出来时说明了还没送到", announced.at(-1)?.notice.outcome === "queued" && mailNoticeText(announced.at(-1)!.notice).includes("排队"), announced.at(-1));
  check("★ 说清了是上限", last.detail.includes("上限"), last.detail);
  check("★ 说清了多半是在兜圈子", last.detail.includes("兜圈"), last.detail);
  // 对照组:没到上限的那些**确实送到了** —— 没有它,上面两条可能只因"它什么都拒"而绿。
  dropAgentMail(held.id);
  const control = deliver(flood, { fromName: self.name, fromId: self.id, kind: "notify", text: "清完再来一条" });
  eq("（对照组）清掉计数之后又能送了", control.outcome, "queued");

  /* ── ★ 窗口过了会自己恢复 ──
   *
   * 这一条钉的是**一个真犯过的错**:早先这里是个终生计数,只在 `dropAgentMail` 里清 ——
   * 而生产代码**从不调它**。于是会话收满 24 条之后,在**整个进程生命周期**里再也收不到
   * 任何代理消息,而且表现是静默的(工具照常返回,只是每次都 failed)。长时间跑的工作流
   * 必然撞上。
   *
   * 把窗口调短就能测到"时间到了自然过期"这条路 —— 那正是生产走的那条。
   *
   * ⚠️ **不睡觉,也不靠"等 30 毫秒"** —— 那两种都会 flaky(填充 25 条本身可能就超过窗口,
   * 于是中间滚了窗、永远撞不上限;设成 1ms 又可能因为填充发生在同一毫秒而没过期)。
   *
   * 改成:先用一个**长**窗口把这一窗填满(填充那 25 次耗时远小于它),再把窗口设成
   * **0** —— 下一个 `windowOf` 里 `now - since >= 0` 恒真,那一窗必须过期。
   *
   * 而这一手**对"终生计数"那种实现毫无作用**(它压根不看窗口)—— 所以真正要挡的那个
   * 变异会在这里红。这正是这一条要的。
   */
  setMessageWindowMs(10_000);
  dropAgentMail(held.id); // 清掉计数与收件箱(但不动窗口机制本身)
  let capped = { outcome: "", detail: "" };
  for (let i = 0; i < MAX_MESSAGES_PER_SESSION + 1; i += 1) {
    capped = deliver(flood, { fromName: self.name, fromId: self.id, kind: "notify", text: `窗内第 ${i} 条` });
  }
  eq("★ 窗内照样撞上限", capped.outcome, "failed");
  setMessageWindowMs(0); // 等价于"时间过去了"
  const afterWindow = deliver(flood, { fromName: self.name, fromId: self.id, kind: "notify", text: "窗口过了" });
  check("★ 窗口过了它会自己恢复(不是永久聋)", afterWindow.outcome !== "failed", afterWindow);
  setMessageWindowMs(null);
  graphBlocked.delete(held.id);
}

/* ──────────────────── 5. 询问 / 回信 ──────────────────── */

console.log("\n⑦ 询问:记账、发出去、立刻返回(不阻塞)");
{
  const main = mkSession({ kind: "chat", title: "主对话 B" });
  const expert = mkSession({ kind: "node", title: "专家", parentSessionId: main.id, nodeId: "e" });
  graphBlocked.add(expert.id); // 让它排队,好观察挂账
  // ⚠️ **主对话也要在图的"管着"名单里。** 真实现里,图正在跑的时候它自己的主对话
  // 也被 `runs.has(mainId)` 挡着(`runner.ts` 注册的那个谓词就是按主对话 id 查的)——
  // 这里必须照做,否则回信会被"叫醒"掉,而那和真机行为不一样。
  graphBlocked.add(main.id);

  const out = await callTool("agent_ask", { to: "专家", text: "引用该用哪套?" }, main.id);
  check("★ 立刻返回了(不是错误)", !isErr(out), out);
  check("★ 给了编号 ask_", out.includes("ask_"), out);
  check("★ 明说了不用等", out.includes("不用等"), out);
  eq("★ 挂账记下了 1 条", undeliveredCount(main.id), 1);
  const askId = /ask_[a-z0-9_]+/.exec(out)?.[0] ?? "";
  check("★ 编号能取出来", askId.length > 4, out);

  console.log("\n⑧ 回信:按 re 精确路由,送回给提问方");
  const back = await callTool("agent_notify", { to: main.id, re: askId, text: "用 APA。" }, expert.id);
  check("回信没报错", !isErr(back), back);
  check("★ 说清是送回给提问方", back.includes("答复已送回"), back);
  eq("★ 挂账销掉了", undeliveredCount(main.id), 0);
  const got = peekAgentMail(main.id);
  check("★ 答复真送到了提问方的收件箱", got.includes("用 APA。"), got);
  check("★ 答复里标了是回信", got.includes(askId), got);

  console.log("\n⑨ 编号对不上 → 如实报错,绝不猜");
  // ⚠️ **先摆两条并存的挂账再测"对不上"。** 只测一条是不行的:队列里只有一个候选时,
  // "按 id 精确查"和"随便挑一条"给出同样的答案 —— 那两条断言会**因为错的原因绿**
  // (实测:把 `takeAsk` 改成 `asks[0]`,只有一条挂账时整套照样 71/71)。
  // 所以这里同时挂两条,再拿一个**都不匹配**的编号去回 —— 宽松匹配会挑中其中一条。
  const outA = await callTool("agent_ask", { to: "专家", text: "问题甲" }, main.id);
  const askA = /ask_[a-z0-9_]+/.exec(outA)?.[0] ?? "";
  const outB = await callTool("agent_ask", { to: "专家", text: "问题乙" }, main.id);
  const askB = /ask_[a-z0-9_]+/.exec(outB)?.[0] ?? "";
  check("两条挂账并存", askA !== "" && askB !== "" && askA !== askB, { askA, askB });

  const bogus = await callTool("agent_notify", { to: main.id, re: "ask_不存在", text: "随便回一句" }, expert.id);
  check("★ 假编号被拒", isErr(bogus), bogus);
  check("★ 说清了找不到编号", bogus.includes("没找到编号"), bogus);
  check("★ 提醒了别发错人", bogus.includes("发错人"), bogus);
  check("★ 两条挂账都没被假回信吃掉", undeliveredCount(main.id) === 2, undeliveredCount(main.id));

  // 再用**真编号**回一条,确认它路由到的正是那一条(而不是另一条)。
  const real = await callTool("agent_notify", { to: main.id, re: askA, text: "甲的回答" }, expert.id);
  check("真编号回得进去", !isErr(real), real);
  eq("★ 只销掉那一条", undeliveredCount(main.id), 1);
  const rcv = peekAgentMail(main.id);
  check("★ 答复落在提问方", rcv.includes("甲的回答"), rcv);
  check("★ 答复里带着那个真编号", rcv.includes(askA), rcv.slice(0, 300));
  check("★ 另一条的编号没被误标", !rcv.includes(askB), rcv.slice(0, 300));

  console.log("\n⑩ 挂账落盘:重启之后还在");
  const out2 = await callTool("agent_ask", { to: "专家", text: "第二个问题" }, main.id);
  const askId2 = /ask_[a-z0-9_]+/.exec(out2)?.[0] ?? "";
  const persisted = SettingRepo.get("agentMail.pendingAsks") ?? "";
  check("★ 挂账写进了设置表(不是只在内存)", persisted.includes(askId2), persisted.slice(0, 200));
  check("★ 落盘的形状带提问方与问题原文", persisted.includes(main.id) && persisted.includes("第二个问题"), persisted.slice(0, 300));

  /* ── ★ 挂账有上限:不能无界增长 ──
   *
   * 它是**落盘**的(整份 JSON 重写),而每条未答的提问占一行。A 问 B、B 问 A 这种来回会
   * 一直堆下去 —— 没有谁会自动清掉那些永远等不到答复的。这条钉的是"堆到某个数就封顶"。 */
  // ⚠️ **直接调 `recordAsk`,不走工具那条路。**
  //
  // 走 `agent_ask` 是测不成的:每条 ask 都要**投递**给同一个目标,而"每会话一窗 24 条"
  // 那道闸门会先挡住 —— 之后的 `agent_ask` 投不出去就把自己的挂账撤掉了(那是对的),
  // 于是挂账永远攒不到 50。实测第一版就是这样:只攒到 22,而那时"<=50"和"没封顶"给出
  // 同样的答案,断言**因为错的原因绿**。
  //
  // 这里要验的是**挂账自己的上限**,所以直接把它灌满。
  for (let i = 0; i < 120; i += 1) {
    recordAsk({
      fromSessionId: main.id,
      fromName: "主对话",
      toSessionId: expert.id,
      question: `灌第 ${i} 条`,
    });
  }
  const asks = JSON.parse(SettingRepo.get("agentMail.pendingAsks") ?? "[]") as Array<{ question?: string }>;
  eq("★ 挂账被封顶在 50(不是无界增长)", asks.length, 50);
  check("★ 留下的是最近那些(最早的被挤出去了)", asks.some((a) => a.question === "灌第 119 条"), asks.slice(-2));
  check("★ 最早那条确实被挤出去了", !asks.some((a) => a.question === "灌第 0 条"), asks.slice(0, 2));

  /* ── ★ 删会话要把落盘的挂账也收掉 ──
   *
   * 收件箱是内存态的,`dropAgentMail` 一直清它;但挂账写在设置键里,从前只清内存 ——
   * 会话一删,它名下(作提问方或回答方)的挂账行永远留着:没人会来销账,还越攒越多,
   * 而设置表每写一次都要重写整个 `mcode.db`。判据立在**表里还剩没剩这个会话的行**上。 */
  const beforeDrop = JSON.parse(SettingRepo.get("agentMail.pendingAsks") ?? "[]") as Array<{ fromSessionId?: string; toSessionId?: string }>;
  check("前置:删之前表里有这个会话的挂账", beforeDrop.some((a) => a.fromSessionId === main.id), beforeDrop.length);
  dropAgentMail(main.id);
  const afterDrop = JSON.parse(SettingRepo.get("agentMail.pendingAsks") ?? "[]") as Array<{ fromSessionId?: string; toSessionId?: string }>;
  check(
    "★ 删会话后:它作为提问方的挂账行被清掉了(不再只增不减)",
    !afterDrop.some((a) => a.fromSessionId === main.id || a.toSessionId === main.id),
    { before: beforeDrop.length, after: afterDrop.length },
  );

  graphBlocked.delete(expert.id);
  graphBlocked.delete(main.id);
  dropAgentMail(main.id);
}

/* ──────────────────── 5½. 回信只能由收信方发送，失败不能吞掉挂账 ──────────── */

console.log("\n⑩½ 回信身份:同一棵树里的旁观代理不能冒充收信方");
{
  const main = mkSession({ kind: "chat", title: "回信身份" });
  const expert = mkSession({ kind: "node", title: "收信的专家", parentSessionId: main.id, nodeId: "intended" });
  const bystander = mkSession({ kind: "node", title: "旁观的专家", parentSessionId: main.id, nodeId: "bystander" });
  graphBlocked.add(main.id);
  graphBlocked.add(expert.id);

  const sent = await callTool("agent_ask", { to: expert.id, text: "只有你能答这题" }, main.id);
  const askId = /ask_[a-z0-9_]+/.exec(sent)?.[0] ?? "";
  check("前置:问题确实发出并拿到编号", !isErr(sent) && askId !== "", sent);
  eq("前置:这条提问还挂着", undeliveredCount(main.id), 1);

  const forged = await callTool("agent_notify", { to: main.id, re: askId, text: "冒充的答复" }, bystander.id);
  check("★ 不是收信方就不能拿编号冒充回信", isErr(forged), forged);
  eq("★ 冒充失败不销掉挂账", undeliveredCount(main.id), 1);
  check("★ 冒充内容没进提问方收件箱", !peekAgentMail(main.id).includes("冒充的答复"));

  const real = await callTool("agent_notify", { to: main.id, re: askId, text: "真正的答复" }, expert.id);
  check("★ 收信方仍能用原编号回信", !isErr(real), real);
  eq("★ 真回信成功后才销账", undeliveredCount(main.id), 0);
  check("★ 真回信被带进提问方收件箱", peekAgentMail(main.id).includes("真正的答复"));
  graphBlocked.delete(main.id);
  graphBlocked.delete(expert.id);
  dropAgentMail(main.id);
  dropAgentMail(expert.id);
}

console.log("\n⑩¾ 回信被限流:拒绝投递后仍可用同一编号重试");
{
  const main = mkSession({ kind: "chat", title: "被限流的提问方" });
  const expert = mkSession({ kind: "node", title: "回答方", parentSessionId: main.id, nodeId: "respondent" });
  graphBlocked.add(main.id);
  graphBlocked.add(expert.id);
  const sent = await callTool("agent_ask", { to: expert.id, text: "等候可重试的答复" }, main.id);
  const askId = /ask_[a-z0-9_]+/.exec(sent)?.[0] ?? "";
  check("前置:限流前的问题确实发出", !isErr(sent) && askId !== "", sent);
  const target = peerOrThrow(expert.id, main.id);
  const self = selfPeerOf(expert.id);
  for (let i = 0; i < MAX_MESSAGES_PER_SESSION; i += 1) {
    const r = deliver(target, { fromId: self.id, fromName: self.name, kind: "notify", text: `填充 ${i}` });
    check(`前置:第 ${i + 1} 条填充成功`, r.outcome === "queued", r);
  }
  const blocked = await callTool("agent_notify", { to: main.id, re: askId, text: "可重试的答复" }, expert.id);
  check("★ 限流时如实拒绝回信", isErr(blocked) && blocked.includes("上限"), blocked);
  eq("★ 回信没投进去就不能销账", undeliveredCount(main.id), 1);
  check("★ 被拒的正文没有进收件箱", !peekAgentMail(main.id).includes("可重试的答复"));

  setMessageWindowMs(0); // 只让下一次投递自然过窗，避免等待十分钟
  const retried = await callTool("agent_notify", { to: main.id, re: askId, text: "可重试的答复" }, expert.id);
  check("★ 过窗后同一个编号可以重新回信", !isErr(retried), retried);
  eq("★ 成功投递之后再销账", undeliveredCount(main.id), 0);
  check("★ 重新投递的正文确实送达", peekAgentMail(main.id).includes("可重试的答复"));
  setMessageWindowMs(null);
  graphBlocked.delete(main.id);
  graphBlocked.delete(expert.id);
  dropAgentMail(main.id);
  dropAgentMail(expert.id);
}

/* ──────────────────── 6½. 坏数据不许把主进程弄崩 ──────────────────── */

console.log("\n⑩½ 父链成环 → 当作没有根,而不是无限递归崩掉");
{
  // 一条自引用的坏行。真数据里不该出现,但(换个手改坏的库、将来某个写坏迁移)**可能**
  // 出现,而那时 `rootOf` 会一直转下去 —— 表现是主进程栈溢出崩掉,不是一句报错。
  const loop = mkSession({ kind: "node", title: "自指的", nodeId: "loop" });
  const db = (await import("@main/store/db.js")).getDb();
  db.run("UPDATE sessions SET parent_session_id = ? WHERE id = ?", [loop.id, loop.id]);
  let peers: unknown[] | string = "(没走到)";
  try {
    peers = peersOf(loop.id);
  } catch (err) {
    peers = `抛了: ${(err as Error).message}`;
  }
  check("★ 环上取名册没抛、也没卡死", Array.isArray(peers), peers);
  eq("★ 环上当作没有根 → 空名册", Array.isArray(peers) ? peers.length : -1, 0);
}

/* ──────────────────── 6. 看得见 / 能干预 / 公网门控 ──────────────────── */

console.log("\n⑪ 信封:说清谁发的(否则回不了信)");
{
  const main = mkSession({ kind: "chat", title: "主对话 C" });
  const other = mkSession({ kind: "side", title: "侧栏", parentSessionId: main.id });
  const self = selfPeerOf(main.id);
  const r = deliver(peerOrThrow(main.id, "侧栏"), {
    fromName: self.name,
    fromId: self.id,
    kind: "notify",
    text: "正文",
  });
  eq("送到(叫醒那条路)", r.outcome, "woke");
  const body = woken.at(-1)?.text ?? "";
  check("★ 信封里有发信人的名字", body.includes(self.name), body);
  check("★ 信封里有发信人的 id", body.includes(self.id), body);
  eq("自己的名字是「主对话」", self.name, "主对话");
  dropAgentMail(other.id);
}

console.log("\n⑫ 能干预:写工具弹审批卡,只读工具免问");
{
  const full = (n: string): string => `mcp__${MCP_WORKFLOW_SERVER}__${n}`;
  eq("★ agent_notify 在默认档要弹卡", shouldAutoApprove("default", full("agent_notify")), false);
  eq("★ agent_ask 在默认档要弹卡", shouldAutoApprove("default", full("agent_ask")), false);
  eq("★ agent_peers 是只读,免问", shouldAutoApprove("default", full("agent_peers")), true);
  check("★ agent_peers 登记在只读集合里", WORKFLOW_READONLY_TOOLS.has("agent_peers"));
  check("★ 两个有副作用的没混进只读集合", !WORKFLOW_READONLY_TOOLS.has("agent_notify") && !WORKFLOW_READONLY_TOOLS.has("agent_ask"));
}

console.log("\n⑫b 桥给三引擎的 agent 只读工具,也要按**它真正注册的 server 名**免问");
{
  // 这三个工具(agent_read_document / agent_read_image / agent_context)在 toolRules 的
  // 只读索引里,本该"任何权限模式都不需要审批"—— 但索引是按 `AGENT_MCP_SERVER`("mcode-agent")
  // 建的键,而 Claude 实际注册的 server 名是 `AGENT_ENGINE_MCP_SERVER`("mcode-agent-tools")。
  // 于是 SDK 报出来的 `mcp__mcode-agent-tools__agent_read_document` 拆出来的 server 名
  // 在索引里查不到 → 表里"任何权限模式都不需要审批"落空,default 档每读一份 PDF 都弹卡,
  // dontAsk 档**直接拒**。断言用**真正注册的那个 server 名**拼出工具全名,判定必须放行。
  const namespaced = (server: string, tool: string): string => `mcp__${server}__${tool}`;
  eq(
    "★ default 档读 PDF 不弹卡(server 名要和注册时一致)",
    shouldAutoApprove("default", namespaced(AGENT_ENGINE_MCP_SERVER, "agent_read_document")),
    true,
  );
  eq(
    "★ default 档读图片不弹卡",
    shouldAutoApprove("default", namespaced(AGENT_ENGINE_MCP_SERVER, "agent_read_image")),
    true,
  );
  eq(
    "★ default 档问项目概况不弹卡",
    shouldAutoApprove("default", namespaced(AGENT_ENGINE_MCP_SERVER, "agent_context")),
    true,
  );
  // 只读索引按 server 名建键,两边不一致时这条会红 —— 这正是上面三条红的根因。
  eq(
    "★ 索引里那个 server 名就是 registered 的那个",
    shouldAutoApprove("default", namespaced(AGENT_MCP_SERVER, "agent_read_document")),
    true,
  );
}

console.log("\n⑬ 公网门控:三个工具一条都不许上");
{
  const pub = new Set(workflowMcpTools({ includeSessionLogs: false }).map((s) => s.name));
  for (const n of AGENT_MAIL_TOOLS) {
    check(`★ 公网表里没有 ${n}`, !pub.has(n), [...pub].filter((x) => x.startsWith("agent_")));
  }
  const local = new Set(workflowMcpTools().map((s) => s.name));
  for (const n of AGENT_MAIL_TOOLS) {
    check(`（对照）本机表里有 ${n}`, local.has(n));
  }
}

console.log("\n⑭ 图收尾唤醒:收件箱不重复注入,启动期间新信不丢也不抢跑");
{
  const providerId = "mail-smoke-deferred";
  const requests: StartTurnRequest[] = [];
  const startResolvers: Array<(handle: TurnHandle) => void> = [];
  // 真走 RuntimeManager.sendTurn,只把 SDK 换成可控的假引擎:启动卡在
  // provider.startTurn 的 await 处,测试在那期间送来第二封信。
  providerRegistry.register({
    id: providerId,
    displayName: "Deferred smoke provider",
    capabilities: {
      supportsApproval: false,
      supportsResume: false,
      supportsStreaming: false,
      supportsMcp: false,
      supportsAskUserQuestion: false,
    },
    startTurn: (req) => {
      requests.push(req);
      return new Promise<TurnHandle>((resolve) => startResolvers.push(resolve));
    },
    listCommands: async () => ({ supported: false, commands: [] }),
  } satisfies AgentProvider);
  const main = mkSession({ kind: "chat", title: "延迟启动的主对话" });
  const node = mkSession({ kind: "node", title: "延迟启动的节点", parentSessionId: main.id, nodeId: "deferred", providerId });
  const activeRoots = new Set([main.id]);
  runtimeManager.bindSession(node);
  runtimeManager.registerRunGuard((id) => activeRoots.has(id));
  setDeliveryPort({
    isRunning: (id) => runtimeManager.isRunning(id),
    inject: (id, text) => runtimeManager.injectMessage(id, text),
    canWake: (id) => runtimeManager.canWakeSession(id),
    wake: (id, text) => runtimeManager.wakeSession(id, text),
  });
  const peer = peerOrThrow(main.id, node.id);
  const env = (text: string) => ({ fromName: "主对话", fromId: main.id, kind: "notify" as const, text });
  try {
    eq("前置:图管着节点时第一封信排队", deliver(peer, env("旧信唯一标记")).outcome, "queued");
    const waiting = peekAgentMail(node.id);
    check("前置:旧信已在收件箱", waiting.includes("旧信唯一标记"));
    activeRoots.delete(main.id);
    eq("前置:图收尾后节点被叫醒", wakeQueued([{ session: node, text: waiting }]).join(","), node.id);
    eq("前置:假引擎开始一轮但还未返回句柄", requests.length, 1);
    eq("★ 旧信在真正发给引擎的提示词里只出现一次", (requests[0]?.prompt.match(/旧信唯一标记/g) ?? []).length, 1);

    const arriving = deliver(peer, env("新信唯一标记"));
    eq("★ 启动未完成时第二封信排队,不能再起一轮", arriving.outcome, "queued");
    check("★ 排队说明也要包含正在启动这一种原因", arriving.detail.includes("启动"), arriving.detail);
    eq("★ 不会并行启动第二轮", requests.length, 1);
    check("前置:新信确实进入收件箱", peekAgentMail(node.id).includes("新信唯一标记"));

    const handle: TurnHandle = { done: new Promise<void>(() => {}), interrupt: () => {}, isRunning: () => true };
    for (const resolve of startResolvers) resolve(handle);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const after = peekAgentMail(node.id);
    check("★ 旧信已进本轮,从收件箱清掉", !after.includes("旧信唯一标记"), after);
    check("★ 启动期间才来的新信仍在收件箱", after.includes("新信唯一标记"), after);

    // 自定义模型还有一个更早的 await:BridgeRegistry.acquire。启动闸必须从
    // sendTurn 入口就占住,不能只在 provider.startTurn 前占。
    const bridged = mkSession({
      kind: "node", title: "桥等待中的节点", parentSessionId: main.id,
      nodeId: "bridge-deferred", providerId, customModelId: "smoke-bridge",
    });
    const cfg: ApiConfig = {
      baseUrl: "https://example.invalid", authToken: "smoke-token", authMode: "auth_token",
      protocol: "openai", selectedModel: "smoke-model", models: [{ id: "smoke-model" }],
      disableNonEssentialTraffic: true,
    };
    const fakeBridge: BridgeHandle = {
      localUrl: "http://127.0.0.1:42345", routeToken: "smoke",
      onStatus: () => () => {}, close: () => {},
    };
    const resolveConfig = CustomModelStore.resolveApiConfig;
    const acquireBridge = BridgeRegistry.acquire;
    let resumeBridge: ((handle: BridgeHandle) => void) | undefined;
    runtimeManager.bindSession(bridged);
    try {
      CustomModelStore.resolveApiConfig = () => cfg;
      BridgeRegistry.acquire = () => new Promise<BridgeHandle>((resolve) => { resumeBridge = resolve; });
      const starting = runtimeManager.sendTurn(bridged, { prompt: "等待桥", cwd: "C:/work/paper" });
      check("前置:请求确实停在翻译桥", resumeBridge !== undefined);
      eq("★ 翻译桥等待期间也不能再叫醒这个会话", runtimeManager.canWakeSession(bridged.id), false);
      if (!resumeBridge) throw new Error("smoke: fake bridge was not acquired");
      resumeBridge(fakeBridge);
      await new Promise<void>((resolve) => setImmediate(resolve));
      eq("桥返回后才启动引擎", requests.length, 2);
      startResolvers.at(-1)?.(handle);
      await starting;
    } finally {
      CustomModelStore.resolveApiConfig = resolveConfig;
      BridgeRegistry.acquire = acquireBridge;
      runtimeManager.dispose(bridged.id);
    }
  } finally {
    runtimeManager.dispose(node.id);
    runtimeManager.registerRunGuard(null);
    setDeliveryPort(null);
    dropAgentMail(node.id);
  }
}

console.log("\n⑮ 自定义模型配置失效:不能改投默认端点,错误要到客户端");
{
  const providerId = "invalid-custom-model-smoke";
  const started: StartTurnRequest[] = [];
  providerRegistry.register({
    id: providerId,
    displayName: "Invalid-config smoke provider",
    capabilities: {
      supportsApproval: false, supportsResume: false, supportsStreaming: false,
      supportsMcp: false, supportsAskUserQuestion: false,
    },
    startTurn: async (req) => {
      started.push(req);
      return { done: new Promise<void>(() => {}), interrupt: () => {}, isRunning: () => true };
    },
    listCommands: async () => ({ supported: false, commands: [] }),
  } satisfies AgentProvider);
  const broken = mkSession({
    kind: "chat", title: "配置已删除", providerId,
    customModelId: "deleted-config-smoke", model: "custom-only-model",
  });
  SessionRepo.updateStatus(broken.id, "running");
  runtimeManager.bindSession(broken);
  runtimeManager.registerRunGuard(() => false);
  const mobileErrors: string[] = [];
  const mobileOrder: string[] = [];
  const off = mobileEventBus.subscribe((e) => {
    if (e.sessionId !== broken.id) return;
    if (e.type === "user.message" || e.type === "error") mobileOrder.push(e.type);
    if (e.type === "error") mobileErrors.push(e.message);
  });
  try {
    let error: unknown;
    try {
      await runtimeManager.sendTurn(broken, {
        prompt: "不要转发到默认端点", cwd: "C:/work/paper",
        userMessage: {
          id: `u_${broken.id}`, createdAt: Date.now(),
          blocks: [{ kind: "text", text: "不要转发到默认端点" }],
        },
      });
    } catch (err) {
      error = err;
    }
    check("★ 请求明确失败(IPC/RPC 可以反馈)", error instanceof Error && error.message.includes("自定义模型"), error);
    eq("★ 不能启动默认端点上的模型", started.length, 0);
    check("★ 错误说明配置已不存在", mobileErrors[0]?.includes("已删除") === true, mobileErrors);
    check("★ 错误告知本次未回退默认端点", mobileErrors[0]?.includes("未发送到默认端点") === true, mobileErrors);
    eq("★ 错误事件发往移动端/界面", mobileErrors.length, 1);
    eq("★ 跨设备先看见原话,再看见错误", mobileOrder.join(","), "user.message,error");
    eq("★ 持久化状态不再留在 running", SessionRepo.get(broken.id)?.status, "errored");
    eq("★ 失败后释放启动闸,可修好配置再试", runtimeManager.canWakeSession(broken.id), true);

    // 用真实 CustomModelStore + 临时 settings 验另外两种失效,不只 mock
    // resolveApiConfig。界面设置不允许空模型,但老数据/人工修改可能留下空列表。
    const withToken = CustomModelStore.save({
      name: "smoke-密钥遗失", baseUrl: "https://example.invalid", authToken: "smoke-secret",
      models: [{ id: "smoke-model" }],
    }).find((cfg) => cfg.name === "smoke-密钥遗失")!;
    const withoutModels = CustomModelStore.save({
      name: "smoke-无模型", baseUrl: "https://example.invalid", authToken: "smoke-secret",
      models: [],
    }).find((cfg) => cfg.name === "smoke-无模型")!;
    const keysBefore = SettingRepo.get("customModelKeys");
    const tokenMissing = mkSession({ kind: "chat", title: "密钥遗失", providerId, customModelId: withToken.id, model: "smoke-model" });
    const modelMissing = mkSession({ kind: "chat", title: "模型遗失", providerId, customModelId: withoutModels.id, model: "smoke-model" });
    try {
      const keys = JSON.parse(keysBefore ?? "{}") as Record<string, string>;
      delete keys[withToken.id];
      SettingRepo.set("customModelKeys", JSON.stringify(keys));
      for (const [session, reason] of [
        [tokenMissing, "密钥缺失或无法解密"], [modelMissing, "没有配置可用模型"],
      ] as const) {
        SessionRepo.updateStatus(session.id, "running");
        runtimeManager.bindSession(session);
        const errors: string[] = [];
        const unlisten = mobileEventBus.subscribe((e) => {
          if (e.sessionId === session.id && e.type === "error") errors.push(e.message);
        });
        try {
          let rejected = false;
          try { await runtimeManager.sendTurn(session, { prompt: "不要误发", cwd: "C:/work/paper" }); }
          catch { rejected = true; }
          check(`★ ${reason}:请求失败`, rejected);
          check(`★ ${reason}:准确告知客户端`, errors[0]?.includes(reason) === true, errors);
          eq(`★ ${reason}:状态收口`, SessionRepo.get(session.id)?.status, "errored");
          eq(`★ ${reason}:没有启动默认端点`, started.length, 0);
          check(`★ ${reason}:错误不泄漏凭据`, errors.every((text) => !text.includes("smoke-secret")));
        } finally {
          unlisten();
          if (session !== tokenMissing) runtimeManager.dispose(session.id);
        }
      }
      // 密钥修复后沿同一会话重试,确实走回自定义端点,不是永远卡死。
      SettingRepo.set("customModelKeys", keysBefore ?? "{}");
      await runtimeManager.sendTurn(tokenMissing, { prompt: "修好后重试", cwd: "C:/work/paper" });
      eq("★ 修复密钥后可以重新启动提供方", started.length, 1);
      eq("★ 重试仍使用选定的自定义端点", started[0]?.apiConfig?.baseUrl, "https://example.invalid");

      // 手工改坏配置文件时解析函数也可能直接抛(而不返回 undefined)。
      // 依旧要 fail-closed、收口状态、把安全的解释送往界面,不透出内部异常。
      const malformed = mkSession({ kind: "chat", title: "异常配置", providerId, customModelId: "malformed-config-smoke" });
      SessionRepo.updateStatus(malformed.id, "running");
      runtimeManager.bindSession(malformed);
      const resolveConfig = CustomModelStore.resolveApiConfig;
      const emitted: string[] = [];
      const unlisten = mobileEventBus.subscribe((e) => {
        if (e.sessionId === malformed.id && e.type === "error") emitted.push(e.message);
      });
      try {
        CustomModelStore.resolveApiConfig = () => { throw new Error("private-token-in-parser-error"); };
        let rejected: unknown;
        try { await runtimeManager.sendTurn(malformed, { prompt: "坏记录", cwd: "C:/work/paper" }); }
        catch (err) { rejected = err; }
        check("★ 解析异常明确失败,不传内部错误", rejected instanceof Error &&
          rejected.message.includes("配置已删除") && !rejected.message.includes("private-token"), rejected);
        check("★ 解析异常也发错误事件", emitted.length === 1 && !emitted[0]?.includes("private-token"), emitted);
        eq("★ 解析异常状态不留在 running", SessionRepo.get(malformed.id)?.status, "errored");
        eq("★ 解析异常不启动默认端点", started.length, 1);
      } finally {
        CustomModelStore.resolveApiConfig = resolveConfig;
        unlisten();
        runtimeManager.dispose(malformed.id);
      }
    } finally {
      SettingRepo.set("customModelKeys", keysBefore ?? "{}");
      CustomModelStore.remove(withToken.id);
      CustomModelStore.remove(withoutModels.id);
      runtimeManager.dispose(tokenMissing.id);
      runtimeManager.dispose(modelMissing.id);
    }
  } finally {
    off();
    runtimeManager.dispose(broken.id);
    runtimeManager.registerRunGuard(null);
  }
}

console.log("\n⑯ 直接叫醒:配置失效要退回收件箱,启动失败也不能丢信");
{
  const providerId = "wake-mail-failure-smoke";
  let failNextStart = true;
  const requests: StartTurnRequest[] = [];
  providerRegistry.register({
    id: providerId, displayName: "Wake-mail failure smoke",
    capabilities: {
      supportsApproval: false, supportsResume: false, supportsStreaming: false,
      supportsMcp: false, supportsAskUserQuestion: false,
    },
    startTurn: async (req) => {
      requests.push(req);
      if (failNextStart) { failNextStart = false; throw new Error("provider startup failed"); }
      return { done: new Promise<void>(() => {}), interrupt: () => {}, isRunning: () => true };
    },
    listCommands: async () => ({ supported: false, commands: [] }),
  } satisfies AgentProvider);
  const main = mkSession({ kind: "chat", title: "代理投递源", providerId });
  const bad = mkSession({
    kind: "node", title: "配置已删除的接收者", parentSessionId: main.id, nodeId: "bad-node", providerId,
    customModelId: "missing-config-for-wake", model: "smoke-model",
  });
  const flaky = mkSession({
    kind: "node", title: "引擎第一次起不来", parentSessionId: main.id, nodeId: "flaky-node", providerId,
    model: "smoke-model",
  });
  runtimeManager.bindSession(bad);
  runtimeManager.bindSession(flaky);
  runtimeManager.registerRunGuard(() => false);
  setDeliveryPort({
    isRunning: (id) => runtimeManager.isRunning(id),
    inject: (id, text) => runtimeManager.injectMessage(id, text),
    canWake: (id) => runtimeManager.canWakeSession(id),
    wake: (id, text) => runtimeManager.wakeSession(id, text),
  });
  const send = (to: Session, text: string) => deliver(peerOrThrow(main.id, to.id), {
    fromName: "主对话", fromId: main.id, kind: "notify", text,
  });
  const errors: string[] = [];
  const unlisten = mobileEventBus.subscribe((e) => {
    if (e.sessionId === main.id && e.type === "workflow.node.transcript" && e.nodeSessionId === bad.id) {
      errors.push(e.blocks.filter((block) => block.kind === "text").map((block) => block.text).join("\n"));
    }
  });
  try {
    const invalidDelivery = send(bad, "失效配置下的信");
    eq("★ 无效模型的直接叫醒如实报 queued", invalidDelivery.outcome, "queued");
    check("★ 发信代理也知道要检查模型配置", invalidDelivery.detail.includes("模型配置"), invalidDelivery.detail);
    check("★ 无效模型的信确实存下", peekAgentMail(bad.id).includes("失效配置下的信"));
    check("★ 隐藏节点的错误经父对话转录同步到桌面/手机", errors[0]?.includes("已删除") === true, errors);
    eq("★ 叫醒失败的会话标记 errored", SessionRepo.get(bad.id)?.status, "errored");
    eq("★ 无效模型不能碰提供方", requests.length, 0);

    eq("启动请求先发出", send(flaky, "启动失败也要保留的信").outcome, "woke");
    await new Promise<void>((resolve) => setImmediate(resolve));
    eq("第一次确实尝试启动", requests.length, 1);
    eq("★ 第一次的请求只带一次信", (requests[0]?.prompt.match(/启动失败也要保留的信/g) ?? []).length, 1);
    check("★ 启动失败后信还在收件箱", peekAgentMail(flaky.id).includes("启动失败也要保留的信"));
    eq("失败后可重试叫醒", runtimeManager.wakeSession(flaky.id, "请处理刚收到的代理消息。"), true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    eq("重试真的再次启动", requests.length, 2);
    eq("★ 重试的请求也只带一次信", (requests[1]?.prompt.match(/启动失败也要保留的信/g) ?? []).length, 1);
    eq("★ 成功启动后才确认收件箱", peekAgentMail(flaky.id), "");
  } finally {
    unlisten();
    setDeliveryPort(null);
    runtimeManager.registerRunGuard(null);
    runtimeManager.dispose(bad.id);
    runtimeManager.dispose(flaky.id);
    dropAgentMail(bad.id);
    dropAgentMail(flaky.id);
  }
}

/* Real RuntimeManager + controllable provider: turn-local injection ancestry. */
{
  const contexts: ProviderContext[] = [];
  const finishes: Array<() => void> = [];
  const requestedModels: Array<string | undefined> = [];
  const providerId = "origin-smoke-provider";
  providerRegistry.register({
    id: providerId, displayName: "Origin fixture",
    capabilities: { supportsApproval: false, supportsResume: false, supportsStreaming: true, supportsMcp: false, supportsAskUserQuestion: false },
    startTurn: async (req, ctx) => {
      contexts.push(ctx);
      requestedModels.push(req.model);
      let running = true, resolve!: () => void;
      const done = new Promise<void>(r => { resolve = r; });
      const finish = (): void => { running = false; resolve(); };
      finishes.push(finish);
      ctx.emit({ type: "tool.use", sessionId: req.sessionId, toolCallId: "during-start", toolName: "Read", input: {}, requiresApproval: false });
      return { done, interrupt: finish, isRunning: () => running };
    },
    listCommands: async () => ({ supported: false, commands: [] }),
  } satisfies AgentProvider);
  const chat = mkSession({ kind: "chat", title: "注入与用户轮次隔离", providerId });
  runtimeManager.bindSession(chat);
  const events: RuntimeEvent[] = [];
  const off = runtimeManager.subscribe(e => { events.push(e); });
  const origin = { workflowIds: ["origin-A", "origin-B"] };
  const input = { prompt: "自动化注入", cwd: "C:/work/paper", automationOrigin: origin,
    userMessage: { id: "injected-message", createdAt: Date.now(), blocks: [] } };
  try {
    await runtimeManager.sendTurn(chat, input);
    eq("真实运行时的注入回显保留来源", automationOriginOf(events.find(e => e.type === "user.message")!)?.workflowIds.join(","), "origin-A,origin-B");
    eq("提供方启动期间的同步事件也保留来源", automationOriginOf(events.find(e => e.type === "tool.use")!)?.workflowIds.join(","), "origin-A,origin-B");
    origin.workflowIds.push("mutated-after-start");
    contexts[0]!.emit({ type: "turn.done", sessionId: chat.id, reason: "end_turn" });
    eq("补齐完成时间戳后来源不丢失", automationOriginOf(events.at(-1)!)?.workflowIds.join(","), "origin-A,origin-B");
    check("来源标记不作为字段发给界面", !JSON.stringify(events.at(-1)).includes("origin-A"));
    finishes[0]!();
    await runtimeManager.sendTurn(chat, { prompt: "用户正常发言", cwd: "C:/work/paper" });
    contexts[1]!.emit({ type: "turn.done", sessionId: chat.id, reason: "end_turn" });
    eq("后续用户轮次不会继承自动化标记", automationOriginOf(events.at(-1)!), undefined);
    contexts[0]!.emit({ type: "tool.result", sessionId: chat.id, toolCallId: "late-old", isError: false, content: "late" });
    eq("上一注入轮迟到事件仍属于原来源", automationOriginOf(events.at(-1)!)?.workflowIds.join(","), "origin-A,origin-B");
    contexts[1]!.emit({ type: "tool.result", sessionId: chat.id, toolCallId: "normal-new", isError: false, content: "normal" });
    eq("迟到事件不污染新用户轮次", automationOriginOf(events.at(-1)!), undefined);
    const forged = { type: "turn.done", sessionId: chat.id, reason: "end_turn", automationOrigin: { workflowIds: ["forged"] } } as RuntimeEvent;
    contexts[1]!.emit(forged);
    eq("普通事件字段不能伪造可信来源", automationOriginOf(events.at(-1)!), undefined);
    const beforeBusy = contexts.length;
    eq("忙时另一注入被拒绝", await runtimeManager.sendTurn(chat, { prompt: "busy", cwd: "C:/work/paper", automationOrigin: { workflowIds: ["rejected"] } }), null);
    eq("忙时请求没有更换提供方上下文", contexts.length, beforeBusy);
    const node = mkSession({ kind: "node", title: "改道来源测试", providerId, parentSessionId: chat.id, nodeId: "origin-node" });
    runtimeManager.bindSession(node);
    runtimeManager.setInteractiveProxy(node.id, chat.id);
    try {
      await runtimeManager.sendTurn(node, { prompt: "node", cwd: "C:/work/paper", automationOrigin: { workflowIds: ["node-origin"] } });
      const approval = contexts.at(-1)!.requestApproval!({ requestId: "origin-approval", toolName: "Write", input: {} });
      eq("交互事件确实改道到父会话", events.at(-1)?.sessionId, chat.id);
      eq("交互事件对象改写后仍保留来源", automationOriginOf(events.at(-1)!)?.workflowIds.join(","), "node-origin");
      runtimeManager.resolveApproval("origin-approval", false); await approval;
      const question = contexts.at(-1)!.requestUserInput!({ requestId: "origin-question", questions: [] });
      eq("提供方调用宿主提问回调也保留来源", automationOriginOf(events.at(-1)!)?.workflowIds.join(","), "node-origin");
      runtimeManager.resolveUserInput("origin-question", {}); await question;
      const plan = contexts.at(-1)!.requestPlanApproval!({ requestId: "origin-plan", plan: "fixture" });
      eq("提供方调用宿主计划审批也保留来源", automationOriginOf(events.at(-1)!)?.workflowIds.join(","), "node-origin");
      runtimeManager.resolvePlanApproval("origin-plan", { approved: false }); await plan;
    } finally { finishes.at(-1)!(); runtimeManager.dispose(node.id); }

    const retry = mkSession({ kind: "chat", title: "失败回退来源测试", providerId, workflowId: "" });
    runtimeManager.bindSession(retry);
    const savedFallback = SettingRepo.get(RUNTIME_FALLBACK_MODELS_SETTING_KEY);
    SettingRepo.set(RUNTIME_FALLBACK_MODELS_SETTING_KEY, JSON.stringify(["haiku"]));
    try {
      await runtimeManager.sendTurn(retry, { prompt: "injected fallback", cwd: "C:/work/paper", automationOrigin: { workflowIds: ["retry-origin"] } });
      const failedContext = contexts.at(-1)!;
      const countBeforeRetry = contexts.length;
      finishes.at(-1)!();
      failedContext.emit({ type: "turn.done", sessionId: retry.id, reason: "error" });
      for (let i = 0; i < 50 && contexts.length === countBeforeRetry; i++) await new Promise(r => setTimeout(r, 20));
      eq("真实运行时确实执行一次模型回退", contexts.length, countBeforeRetry + 1);
      contexts.at(-1)!.emit({ type: "turn.done", sessionId: retry.id, reason: "end_turn" });
      eq("失败回退回复仍属于原自动化链", automationOriginOf(events.at(-1)!)?.workflowIds.join(","), "retry-origin");
    } finally {
      finishes.at(-1)!(); runtimeManager.dispose(retry.id);
      SettingRepo.set(RUNTIME_FALLBACK_MODELS_SETTING_KEY, savedFallback ?? "[]");
    }

    // Codex 的真实顺序:先发 turn.done{error},再 await flushFinal()(文件快照 I/O),
    // 之后 handle 才 isRunning()=false。回退重发必须等失败那一轮收尾,不能被
    // 「already running」静默吞掉,也不能把回退模型残留给下一轮。
    const late = mkSession({ kind: "chat", title: "回退等待收尾测试", providerId, workflowId: "" });
    runtimeManager.bindSession(late);
    const savedFallbackLate = SettingRepo.get(RUNTIME_FALLBACK_MODELS_SETTING_KEY);
    SettingRepo.set(RUNTIME_FALLBACK_MODELS_SETTING_KEY, JSON.stringify(["haiku"]));
    try {
      await runtimeManager.sendTurn(late, { prompt: "late finish", cwd: "C:/work/paper" });
      const failedContext = contexts.at(-1)!;
      const failedFinish = finishes.at(-1)!;
      const countBeforeRetry = contexts.length;
      failedContext.emit({ type: "turn.done", sessionId: late.id, reason: "error" });
      await new Promise(r => setTimeout(r, 80));
      eq("turn.done 先于收尾时回退不抢跑", contexts.length, countBeforeRetry);
      failedFinish();
      for (let i = 0; i < 50 && contexts.length === countBeforeRetry; i++) await new Promise(r => setTimeout(r, 20));
      eq("失败一轮收尾后执行回退重发", contexts.length, countBeforeRetry + 1);
      eq("回退重发使用链上的下一个模型", requestedModels.at(-1), "haiku");
      contexts.at(-1)!.emit({ type: "turn.done", sessionId: late.id, reason: "end_turn" });
      finishes.at(-1)!();
      await new Promise(r => setTimeout(r, 0));
      await runtimeManager.sendTurn(late, { prompt: "next manual turn", cwd: "C:/work/paper" });
      eq("回退之后的手动发送回到会话自己的模型", requestedModels.at(-1), late.model !== "default" ? late.model : undefined);
    } finally {
      finishes.at(-1)!(); runtimeManager.dispose(late.id);
      SettingRepo.set(RUNTIME_FALLBACK_MODELS_SETTING_KEY, savedFallbackLate ?? "[]");
    }

    // 渲染端收到 turn.done 就回到空闲、排队消息立刻发来;此时引擎可能还在收尾。
    // sendTurn 要等收尾而不是返回 null(返回 null 时 IPC 会拒绝,消息不发)。
    const queued = mkSession({ kind: "chat", title: "收尾期间发送测试", providerId, workflowId: "" });
    runtimeManager.bindSession(queued);
    try {
      await runtimeManager.sendTurn(queued, { prompt: "first", cwd: "C:/work/paper" });
      const firstFinish = finishes.at(-1)!;
      const beforeBusy = contexts.length;
      eq("真正运行中(未发 turn.done)的发送立即拒绝", await runtimeManager.sendTurn(queued, { prompt: "busy", cwd: "C:/work/paper" }), null);
      eq("被拒绝的发送没有启动新回合", contexts.length, beforeBusy);
      contexts.at(-1)!.emit({ type: "turn.done", sessionId: queued.id, reason: "end_turn" });
      const pending = runtimeManager.sendTurn(queued, { prompt: "queued after done", cwd: "C:/work/paper" });
      await new Promise(r => setTimeout(r, 40));
      eq("收尾未完成时不抢跑", contexts.length, beforeBusy);
      firstFinish();
      const secondHandle = await pending;
      eq("收尾完成后排队消息正常启动", secondHandle !== null && contexts.length === beforeBusy + 1, true);
    } finally {
      finishes.at(-1)!(); runtimeManager.dispose(queued.id);
    }

  } finally { finishes.forEach(f => f()); off(); runtimeManager.dispose(chat.id); }
}

function peerOrThrow(sessionId: string, name: string) {
  const p = resolvePeer(sessionId, name);
  if (!p) throw new Error(`名册上没有 ${name}`);
  return p;
}

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
