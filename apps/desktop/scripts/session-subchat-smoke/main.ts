/**
 * Headless smoke for **「新建子对话」那三档**(`main/lib/sessionStart.ts` 的 side 那一段
 * + `main/lib/sessionAgentProfile.ts` + `main/store/repositories.ts` 的
 * `findFreshSideByParent` + `main/lib/pendingBackflow.ts` 的记忆挂载)。
 *
 * ## 它验的是什么
 *
 * 这一层有四件事**只有真的建一次、真的读回来、真的读磁盘上那份档案文件**才验得了,
 * 而且每一件错了都"看着像对":
 *
 *  1. **三档确实是三档。** 「空白」没有任何指令;「档案」有指令、不注记忆;「档案+记忆」
 *     两者都有。**把它们合并成两档**(最常见:认为"不带记忆的档案"就是空白)在界面上
 *     完全看不出来 —— 用户挑的是一份档案,拿到的是一个什么都不是的对话。
 *  2. **复用要看角色对不对得上。** 三档共用 `kind="side"`、共用同一个空壳判据,不按角色
 *     收窄的话,点「档案甲」会拿到上一次点「空白」留下的那个壳。而那个壳**长得一模一样**
 *     (建完就打开了),用户只会发现"它不是那个角色" —— 没有任何报错。
 *  3. **档案是快照,不是引用。** 建会话那一刻抄一份到会话行上。只存 id、每轮回档案里现取
 *     的写法也能跑,差别要到"用户改了档案"那一天才显示出来,而那时上下文已经连续了好几轮。
 *  4. **记忆只挂一次,而且不带 `## 长期记忆` 那个小节标题。** 标题由 `backflowPrompt`
 *     统一加 —— 两边各加一个就是两层标题。复用时空壳上已经躺着的那份不能挂第二遍。
 *
 * ## 每个场景一个干净的父会话
 *
 * 复用判据是**按父会话**查的(同一个父下面"还没发言的空壳"只有一个会被复用),所以
 * 场景之间共用父会话时,前一个场景留下的空壳会变成后一个场景的复用对象 —— 于是断言
 * 到底在验什么就说不清了。这里每个场景**自带一个父会话**(`newParent()`),互不干扰。
 *
 * ## 它不碰用户真正的数据根
 *
 * `dataRoot()` 换成 `$MCODE_SMOKE_DATA_ROOT`(见 `stubs/dataRoot.ts`),那是 run.sh 用
 * `mktemp -d` 建的目录,跑完就删。**不是 `~/Mcode`** —— 这一点很要紧,因为 `initDb()`
 * 在路径不存在时会**新建一个空库**。
 *
 * 档案目录(`<数据根>/workflows/agents/`)与记忆目录(`<数据根>/memory/`)都**是真的**:
 * 本套要验的恰好就是"主进程有没有真去磁盘上读那份档案、真去读记忆库"。
 *
 * ## 换桩的边界(读了那条链之后才切的)
 *
 *   - `dataRoot` / `logger` —— 真的那两个 import electron;
 *   - `RuntimeManager` —— 真的那个一 `bindSession` 就把三个引擎实现全拉起来;
 *   - `sessionSync` —— 真的那个要往 webContents 推事件。
 * 其余全是真的:**真 sqlite 库**、真的 `sessionStart`、真的 `agentProfiles`、
 * 真的 `sessionAgentProfile`、真的 `memory/retrieval`、真的 `pendingBackflow`。
 *
 * Run: scripts/session-subchat-smoke/run.sh
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { initDb } from "@main/store/db.js";
import { MessageRepo, ProjectRepo, SessionRepo } from "@main/store/repositories.js";
import { createOrReuseSession } from "@main/lib/sessionStart.js";
import { agentProfilesDir } from "@main/orchestration/agentProfiles.js";
import { saveMemoryFile, readMemoryFile, deleteMemoryFile } from "@main/memory/store.js";
import { backflowPrompt, peekBackflow, queueBackflow, pendingBackflowPrompt } from "@main/lib/pendingBackflow.js";
import { resolveAgentPrompt } from "@main/orchestration/prompt.js";
import { bound } from "./stubs/runtimeManager.js";
import { broadcastIds } from "./stubs/sessionSync.js";
import { StartSessionSchema, type StartSessionInput } from "@contracts/ipc";
import type { Session } from "@contracts/session";

let failures = 0;
let total = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  total += 1;
  if (cond) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

/* ── 夹具 ─────────────────────────────────────────────────────────────── */

const PROJECT = "p_sub";

/* 档案文件直接手写 —— 本套要验的是**主进程怎么读它**,而不是界面怎么存它。
   格式由 `@contracts/agentProfile` 的 schema 定,这里照它写。 */
interface ProfileSpec {
  id: string;
  name: string;
  instruction?: string;
  /** 覆盖默认的 type —— 用来验"这不是给对话用的档案"。 */
  type?: string;
  /** 故意写成非法的 JSON 文本(用于"档案坏了"那一条)。 */
  rawText?: string;
}

function writeProfile(spec: ProfileSpec): void {
  const dir = agentProfilesDir();
  mkdirSync(dir, { recursive: true });
  const body =
    spec.rawText ??
    JSON.stringify(
      {
        version: 1,
        id: spec.id,
        name: spec.name,
        type: spec.type ?? "mcode.agent",
        params: { instruction: spec.instruction ?? "" },
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
      },
      null,
      2,
    );
  writeFileSync(path.join(dir, `${spec.id}.json`), body, "utf-8");
}

function removeProfile(id: string): void {
  rmSync(path.join(agentProfilesDir(), `${id}.json`), { force: true });
}

const PROFILE_A = "p_reader";
const PROFILE_B = "p_tester";
const INSTR_A = "你是一位读论文的助手,回答一律先给结论。";
const INSTR_B = "你是一位写测试的助手,回答一律先给失败用例。";

let parentSeq = 0;

/** 每个场景一个自己的父会话 —— 见文件头"每个场景一个干净的父会话"。 */
function newParent(): string {
  parentSeq += 1;
  const id = `sess_parent_${parentSeq}`;
  const now = 1_700_000_000_000 + parentSeq;
  SessionRepo.create({
    id,
    projectId: PROJECT,
    providerId: "claude-sdk",
    claudeSessionId: null,
    kind: "chat",
    parentSessionId: null,
    nodeId: null,
    title: `主对话 ${parentSeq}`,
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
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

/**
 * 建一个子会话 —— **走 `StartSessionSchema.parse`**,与两个真的入口
 * (`ipc/claude.ts` / `mobile/mobileRpc.ts`)逐字同一条路。
 *
 * 少了这一步,那些 `.default(...)`(effort / permissionMode / kind)就不会生效,于是
 * 这一套验的就不是"用户点下去之后会发生什么",而是"一个手写对象会发生什么" ——
 * 实测第一次就是这么挂的(`NOT NULL constraint failed: sessions.effort`)。
 */
function call(parent: string, over: Partial<StartSessionInput> = {}): {
  session: Session;
  reused: boolean;
} {
  const input = StartSessionSchema.parse({
    projectId: PROJECT,
    kind: "side",
    parentSessionId: parent,
    ...over,
  });
  return createOrReuseSession(input, "desktop");
}

/** 建一个「空白」子对话。 */
function blank(parent: string): Session {
  return call(parent).session;
}

/** 落一条消息(把空壳变成"用过了的壳")。 */
function useUp(sessionId: string): void {
  MessageRepo.replaceAll(sessionId, [
    {
      id: `m_${sessionId}`,
      sessionId,
      role: "user",
      content: [{ type: "text", text: "问一句" }],
      createdAt: Date.now(),
    },
  ]);
}

/** 这个父会话下现在有几个 side 会话(断言"没有多建"靠它)。 */
const sideCount = (parent: string): number => SessionRepo.listSideByParent(parent).length;

function threwFrom(fn: () => unknown): string {
  try {
    fn();
    return "";
  } catch (err) {
    return (err as Error).message;
  }
}

/* ── 跑 ───────────────────────────────────────────────────────────────── */

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

writeProfile({ id: PROFILE_A, name: "读论文的", instruction: INSTR_A });
writeProfile({ id: PROFILE_B, name: "写测试的", instruction: INSTR_B });
saveMemoryFile({ path: "global/rules/引用规范.md", content: "引用一律用 APA。", title: "引用规范" });

/* ── 1. 「空白」那一档 ─────────────────────────────────────────────────── */

console.log("\n第一档「空白」:纯对话,什么角色都不是");
{
  const parent = newParent();
  const s = blank(parent);
  eq("kind 是 side", s.kind, "side");
  eq("挂在父会话下面", s.parentSessionId, parent);
  eq("标题还是占位符", s.title, "Quick ask");
  // 这一条是「空白」的定义:没有任何指令。写成 `{id:'',name:'',instruction:''}`
  // 之类"空角色"也是错的 —— 那是"有一个没用的角色",不是"没有角色"。
  eq("没有角色快照", s.agentProfile ?? null, null);
  eq("没有东西排进记忆队列", peekBackflow(s.id), "");
  eq("绑定到运行时了", bound.includes(s.id), true);
}

/* ── 2. 「档案」那一档 ─────────────────────────────────────────────────── */

console.log("\n第二档「档案」:有指令,**不**注记忆");
{
  const parent = newParent();
  const s = call(parent, { agentProfileId: PROFILE_A }).session;
  check("档案真的被读出来了", !!s.agentProfile, s.agentProfile ?? null);
  eq("记的是哪一份档案", s.agentProfile?.id, PROFILE_A);
  eq("指令原文抄进来了", s.agentProfile?.instruction, INSTR_A);
  eq("名字也抄了(档案改名不影响它)", s.agentProfile?.name, "读论文的");
  // ⚠️ 标题必须**不是**占位符:占位符会被第一条消息那 40 个字覆盖掉,而用户挑的是
  // "它叫这个、它是这个角色"。这一条同时是下面「复用」那几段的前提。
  eq("标题用档案名,不是 Quick ask", s.title, "读论文的");
  eq("没勾记忆就是没记忆", peekBackflow(s.id), "");
  // 「空白」和「不带记忆的档案」是两件事 —— 这一组断言就是那句话本身。
  check("它和「空白」不是一回事(有指令)", (s.agentProfile?.instruction ?? "").length > 0);
  eq("每轮都能取到角色提示词", resolveAgentPrompt(s.agentProfile), INSTR_A);
}

/* ── 3. 「档案 + 记忆」那一档 ──────────────────────────────────────────── */

console.log("\n第三档「档案+记忆」:有指令,而且第一轮带一份记忆快照");
{
  const parent = newParent();
  const s = call(parent, { agentProfileId: PROFILE_B, memory: true }).session;
  eq("角色是对的", s.agentProfile?.id, PROFILE_B);
  const queued = peekBackflow(s.id);
  check("记忆挂上去了", queued.length > 0, queued);
  check("挂的是记忆正文", queued.includes("引用一律用 APA"), queued);
  // 快照是**原样**的记忆,不带小节标题 —— 拼接由 `backflowPrompt` 一处做。
  // 两边各加一个的话,模型会看到两层标题(`memorySectionFrom` 那个 `## 长期记忆`
  // 是**节点**那条路的拼法,见 `nodeInputBuilders`:节点每轮重取、自己拼)。
  eq("没带 `## 长期记忆` 小节标题", queued.includes("## 长期记忆"), false);
  const composed = backflowPrompt(queued);
  check("拼接那一层加了说明头", composed.includes("## 背景:用户刚才跑的工作流"), composed.slice(0, 80));
  // 「只加一层」的判据:记忆正文在最终提示词里**只出现一次**,而且它前面只有一个标题。
  eq("记忆正文只出现一次", composed.split("引用一律用 APA").length - 1, 1);
  eq("整段里只有一个标题行", (composed.match(/^## /gm) ?? []).length, 1);
  check("带上了「这不是用户刚说的话」那句说明", composed.includes("不是用户刚说的话"));
  eq("角色提示词每轮都能取到", resolveAgentPrompt(s.agentProfile), INSTR_B);
}

/* ── 4. 复用 ───────────────────────────────────────────────────────────── */

console.log("\n复用:同一个角色复用同一个空壳");
{
  const parent = newParent();
  const first = call(parent, { agentProfileId: PROFILE_A }).session;
  const second = call(parent, { agentProfileId: PROFILE_A });
  eq("点第二下拿到的是同一个会话", second.session.id, first.id);
  eq("标成复用了", second.reused, true);
  eq("没有多建一行", sideCount(parent), 1);
}

console.log("\n复用不能跨角色 —— 本套最要紧的一组");
{
  const parent = newParent();
  // ① 空壳在,点「档案甲」**不该**拿到它(点「空白」留下的壳没有角色)。
  const blankShell = blank(parent);
  const prof = call(parent, { agentProfileId: PROFILE_A }).session;
  check("点「档案甲」没拿到「空白」留下的那个壳", prof.id !== blankShell.id, {
    blank: blankShell.id,
    prof: prof.id,
  });
  eq("它确实有角色", prof.agentProfile?.id, PROFILE_A);
  eq("于是多了一行(宁可多,也不要一个错的)", sideCount(parent), 2);

  // ② 反过来:档案甲的壳在,点「空白」也不该拿到它。
  const empty2 = blank(parent);
  eq("点「空白」复用回原来那个空白壳", empty2.id, blankShell.id);
  check("而它确实没有角色(没被档案甲那个壳带偏)", empty2.id !== prof.id);
  eq("它没有角色", empty2.agentProfile ?? null, null);

  // ③ 两份不同的档案之间同样不复用。
  const bShell = call(parent, { agentProfileId: PROFILE_B }).session;
  check("「档案乙」没拿到「档案甲」的壳", bShell.id !== prof.id, {
    a: prof.id,
    b: bShell.id,
  });
  eq("乙那个壳里记的是乙那份指令", bShell.agentProfile?.instruction, INSTR_B);
}

/* ── 4b. 复用判据不能被 LIKE 通配符骗到 ───────────────────────────────────── */

/**
 * `findFreshSideByParent` 用 `agent_profile LIKE '%"id":"<id>"%'` 认「上一次为这份
 * 档案开的那个空壳」。而**档案 id 的字符集里 `_` 是 LIKE 的单字符通配符** ——
 * 方法自己的注释却写着"`[a-z0-9_]` 塞不进 LIKE 的通配符"(那是错的:每个 id 都以
 * `p_` 开头,`_` 必然出现)。
 *
 * 症状:两个 id 只在某个 `_` 的位置上不同时,搜甲会匹配到乙的空壳。`sessionStart`
 * 那边的 `sameProfile` 拿**精确 id** 再判一次,于是不会把乙的角色错给甲 —— 但
 * `findFresh...` 只回**最近的那一个**,乙的壳更新时它会先返回乙、被 `sameProfile`
 * 拒掉,然后在甲**明明有空壳**的情况下**再建一个**。那正是这个函数存在的意义
 * ("别每点一次堆一个空壳")失效。
 *
 * 这里造一对真会互撞的 id:`p_p_one` 的 LIKE 模式 `p?p?one` 逐字命中 `p_paone`。
 */
{
  const parent = newParent();
  const ID_A = "p_paone"; // 甲:LIKI 模式 `p_p?one` 命中不了它,但反向会被命中
  const ID_B = "p_p_one"; // 乙:模式 `p?p?one` 会误命中甲的 id
  writeProfile({ id: ID_A, name: "甲档案", instruction: "我是甲。" });
  writeProfile({ id: ID_B, name: "乙档案", instruction: "我是乙。" });

  const shellB = call(parent, { agentProfileId: ID_B }).session;
  // 隔开一点,保证甲的壳 updated_at 更大(被查的那个"最近的那一个")。
  await new Promise((r) => setTimeout(r, 8));
  const shellA = call(parent, { agentProfileId: ID_A }).session;
  eq("先各建了一个空壳", sideCount(parent), 2);

  // 甲更近,而乙的模式会误命中甲 —— 修复前这里返回甲。
  eq("★ findFreshSideByParent 按精确 id 命中乙(不被甲的通配符骗走)",
    SessionRepo.findFreshSideByParent(parent, ID_B)?.id, shellB.id);

  const again = call(parent, { agentProfileId: ID_B });
  eq("★ 点乙复用的是乙那个壳", again.session.id, shellB.id);
  eq("没有在乙明明有空壳时又堆一个", sideCount(parent), 2);
  eq("标成复用了", again.reused, true);
  eq("甲的壳原样在", SessionRepo.get(shellA.id)?.id, shellA.id);
  removeProfile(ID_A);
  removeProfile(ID_B);
}

console.log("\n用过了的壳不再复用(判据是「有没有消息」,不是标题)");
{
  const parent = newParent();
  const shell = call(parent, { agentProfileId: PROFILE_A }).session;
  useUp(shell.id);
  const next = call(parent, { agentProfileId: PROFILE_A }).session;
  check("发过言的会话不会被当成空壳", next.id !== shell.id, { used: shell.id, next: next.id });
  eq("又多了一行", sideCount(parent), 2);
}

/* ── 5. 复用时不重复挂记忆 ─────────────────────────────────────────────── */

console.log("\n「档案+记忆」连点两下:第一轮里只能有一份记忆");
{
  const parent = newParent();
  const first = call(parent, { agentProfileId: PROFILE_B, memory: true }).session;
  const queuedOnce = peekBackflow(first.id);
  check("第一下就挂上了", queuedOnce.length > 0);
  // 空壳上那份**还没被取走**(没有过回合 = 没人 clear),这一次走的是复用那条路。
  const second = call(parent, { agentProfileId: PROFILE_B, memory: true });
  eq("复用了同一个壳", second.session.id, first.id);
  const queuedTwice = peekBackflow(second.session.id);
  eq("队列里还是一份(不是两份叠起来)", queuedTwice, queuedOnce);
  eq("正文只出现一次", queuedTwice.split("引用一律用 APA").length - 1, 1);
}

console.log("\n复用时用户改过记忆:以**现在**这份为准");
{
  const parent = newParent();
  const shell = call(parent, { agentProfileId: PROFILE_B, memory: true }).session;
  saveMemoryFile({ path: "global/rules/引用规范.md", expectedRevision: readMemoryFile("global/rules/引用规范.md").revision, content: "引用一律用 APA 第七版。", title: "引用规范" });
  const again = call(parent, { agentProfileId: PROFILE_B, memory: true }).session;
  eq("还是同一个壳", again.id, shell.id);
  const queued = peekBackflow(again.id);
  check("换成了新的那份", queued.includes("第七版"), queued);
  eq("旧的那份没留着(不是叠上去)", queued.split("引用一律用 APA").length - 1, 1);
  // 复原,免得影响别的场景。
  saveMemoryFile({ path: "global/rules/引用规范.md", expectedRevision: readMemoryFile("global/rules/引用规范.md").revision, content: "引用一律用 APA。", title: "引用规范" });
}

console.log("\n分层记忆：复用只替换自己的快照，不污染工作流产物");
{
  const parent = newParent();
  const shell = call(parent, { agentProfileId: PROFILE_B, memory: true }).session;
  queueBackflow(shell.id, "independent-workflow-evidence");
  const again = call(parent, { agentProfileId: PROFILE_B, memory: false }).session;
  eq("关闭记忆仍复用空会话", again.id, shell.id);
  check("撤销快照后只格式化工作流层", !pendingBackflowPrompt(shell.id).includes("创建时的记忆快照"));
  eq("关闭记忆撤销待注入快照但保留工作流产物", peekBackflow(shell.id), "independent-workflow-evidence");
}
{
  const parent = newParent();
  const shell = call(parent, { agentProfileId: PROFILE_B, memory: true }).session;
  check("创建快照的提示不冒充工作流产物", pendingBackflowPrompt(shell.id).includes("子代理创建时的记忆快照") && !pendingBackflowPrompt(shell.id).includes("用户刚才跑的工作流"));
  queueBackflow(shell.id, "keep-other-layer");
  call(parent, { agentProfileId: PROFILE_B, memory: true });
  check("刷新记忆不清掉其他层待办", peekBackflow(shell.id).includes("keep-other-layer"));
  eq("刷新后同一快照仍只有一份", peekBackflow(shell.id).split("引用一律用 APA").length - 1, 1);
}
{
  const parent = newParent();
  const shell = call(parent, { agentProfileId: PROFILE_B, memory: true }).session;
  deleteMemoryFile("global/rules/引用规范.md", readMemoryFile("global/rules/引用规范.md").revision);
  call(parent, { agentProfileId: PROFILE_B, memory: true });
  eq("当前记忆库已空时撤销旧快照", peekBackflow(shell.id), "");
  saveMemoryFile({ path: "global/rules/引用规范.md", content: "引用一律用 APA。", title: "引用规范" });
}

/* ── 6. 读不到档案时:明确失败,而且一行都不留 ────────────────────────── */

console.log("\n档案读不到时:抛错,不建任何一行");
{
  const parent = newParent();
  const before = sideCount(parent);

  let threw = threwFrom(() => call(parent, { agentProfileId: "p_not_here" }));
  check("文件不在了,错误冒到调用方(没被吞掉)", threw.includes("p_not_here"), threw);
  eq("库里没有多出会话", sideCount(parent), before);

  // 类型不对的档案(给别的节点类型用的)同样拒掉。
  writeProfile({ id: "p_wrong_kind", name: "给别的东西用的", instruction: "随便", type: "mcode.code" });
  threw = threwFrom(() => call(parent, { agentProfileId: "p_wrong_kind" }));
  check("说清了它当不了对话的角色", threw.includes("当不了对话的角色"), threw);
  eq("同样没有多出会话", sideCount(parent), before);

  // 格式坏掉的档案文件。
  writeProfile({ id: "p_broken", name: "坏的", rawText: "{ 这不是 JSON" });
  threw = threwFrom(() => call(parent, { agentProfileId: "p_broken" }));
  check("坏文件也明确失败", threw.includes("档案读不了"), threw);
  eq("还是没有多出会话", sideCount(parent), before);

  // 没填指令的档案:一个没有角色提示词的"角色"没有意义,建出来就是个骗人的壳。
  writeProfile({ id: "p_silent", name: "没填指令的", instruction: "   " });
  threw = threwFrom(() => call(parent, { agentProfileId: "p_silent" }));
  check("空指令的档案被拒", threw.includes("没填指令"), threw);
  eq("依旧没有多出会话", sideCount(parent), before);
}

/* ── 7. 「删掉档案」不影响已经开出去的对话 ─────────────────────────────── */

console.log("\n档案被删之后:已经开出去的对话活得下去(快照的意义)");
{
  const parent = newParent();
  const live = call(parent, { agentProfileId: PROFILE_A }).session;
  removeProfile(PROFILE_A);

  const reread = SessionRepo.get(live.id) as Session;
  eq("会话行还在", reread.id, live.id);
  eq("指令原文还在(不是个认不出的 id)", reread.agentProfile?.instruction, INSTR_A);
  eq("每轮还能取到角色提示词", resolveAgentPrompt(reread.agentProfile), INSTR_A);
  // 而**新**建的那个确实建不出来 —— 快照让老的活着,不是让删掉的档案还能用。
  const threw = threwFrom(() => call(newParent(), { agentProfileId: PROFILE_A }));
  check("但新开一个就建不出来了", threw.includes("档案不在了"), threw);

  writeProfile({ id: PROFILE_A, name: "读论文的", instruction: INSTR_A });
}

/* ── 8. 子对话不广播、不进主列表 ───────────────────────────────────────── */

console.log("\n子对话不广播、不进左栏(左栏那些查询钉的是 kind='chat')");
{
  const parent = newParent();
  const before = broadcastIds.length;
  const s = call(parent, { agentProfileId: PROFILE_B }).session;
  eq("建子对话没有广播 session.changed", broadcastIds.length, before);
  eq("不在主列表里", SessionRepo.listByProject(PROJECT, {}).some((x) => x.id === s.id), false);
  eq("但在它父会话的 side 列表里", sideCount(parent), 1);
  eq("列表里就是它", SessionRepo.listSideByParent(parent)[0]?.id, s.id);
}

/* ── 9. 手机端那条路也吃同一套语义 ─────────────────────────────────────── */

console.log("\n手机端走同一个函数(共享实现只有一份)");
{
  const parent = newParent();
  const input = StartSessionSchema.parse({
    projectId: PROJECT,
    kind: "side",
    parentSessionId: parent,
    agentProfileId: PROFILE_B,
  });
  const first = createOrReuseSession(input, "mobile");
  const second = createOrReuseSession(input, "mobile");
  eq("手机端也复用同一个壳", second.session.id, first.session.id);
  eq("没有因为来路不同就多建一行", sideCount(parent), 1);
  eq("角色一样在那", second.session.agentProfile?.id, PROFILE_B);
}

/* ── 10. 老调用方(右侧问答页签的「新对话」)行为一字不变 ───────────────── */

console.log("\n右侧问答页签那条路:不传档案 = 「空白」,照旧复用空壳");
{
  const parent = newParent();
  const input = StartSessionSchema.parse({
    projectId: PROJECT,
    kind: "side",
    parentSessionId: parent,
  });
  const a = createOrReuseSession(input, "desktop");
  const b = createOrReuseSession(input, "desktop");
  eq("复用", b.session.id, a.session.id);
  eq("没有多建", sideCount(parent), 1);
  eq("拿到的确实没有角色", b.session.agentProfile ?? null, null);
  eq("标题照旧是占位符", b.session.title, "Quick ask");
}

console.log("\n档案编号:path traversal 一律拒");
{
  // 档案文件名即 id,拼路径时**必须先过字符集校验** —— `path.join` 不拒 `..`,裸 join 会
  // 拼出目录外的路径。这里挡两层:契约 schema(IPC 入口)与 loader(导出的函数,纵深防御)。
  let schemaRejected = false;
  try {
    StartSessionSchema.parse({ projectId: PROJECT, kind: "side", parentSessionId: "x", agentProfileId: "../../../etc/passwd" });
  } catch { schemaRejected = true; }
  check("★ 契约 schema 拒绝带 ../ 的 agentProfileId(IPC 入口)", schemaRejected);

  const { loadAgentProfileForSession } = await import("@main/lib/sessionAgentProfile.js");
  // 判据钉在**拒绝的理由**上,不只是"失败了" —— 没有那道守卫时,它也会返回 {ok:false}
  // (只是理由是"档案不在了"或解析失败),那样"ok===false"根本分不出挡没挡。
  const traversal = loadAgentProfileForSession("../../../etc/passwd", agentProfilesDir());
  check(
    "★ loader 独立再挡一次(导出的函数不押调用方都记得校验)",
    traversal.ok === false && traversal.error.includes("档案编号不合法"),
    traversal,
  );
  const okId = loadAgentProfileForSession("p_not_there_at_all", agentProfilesDir());
  check("对照:合法形状的编号照常走'档案不在了'那条路", okId.ok === false && okId.error.includes("档案不在了"), okId);
}

console.log(`\n${total - failures}/${total} 通过`);
if (failures > 0) {
  console.log(`${failures} 条失败`);
  process.exit(1);
}
