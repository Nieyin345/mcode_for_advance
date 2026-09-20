/**
 * Headless smoke for **把一段对话复制成新的一段**(`main/lib/sessionFork.ts`)。
 *
 * ## 它验的是什么
 *
 * 这一层有四件事**只有真的建一次、真的读回来**才验得了,而且每一件错了都"看着像对":
 *
 *  1. **消息 id 必须重编。** 照抄会撞主键(两行同 id),而撞主键的表现是复制直接失败 —
 *     或者更糟:某一边的 ID 生成恰好不同,于是两条记录指向同一段内容,删一条另一条跟着
 *     变。断言的是"内容一样、id 全不一样"。
 *  2. **新会话的引擎侧 id 必须是新复制出来的那一个**,不是源那一个。写错的话两个会话
 *     抢着写同一个会话文件 —— 而这件事在界面上完全看不出来,直到某一天两边的历史串了。
 *  3. **顺序不能反**:先在引擎那边复制上下文,再建行。反了的话引擎报错时,库里会留下
 *     一段看起来有历史、模型那边却是空的对话。断言的是"失败之后库里一条新行都没有"。
 *  4. **用量记录不能带过来。** 那是这一段对话自己的账;带过来的话新对话一打开就顶着
 *     一笔它没花过的钱。
 *
 * 引擎那一侧是假的(见 `stubs/providerRegistry.ts`):这里验的是**调用方**有没有把
 * 对的参数交出去、拿到了之后有没有做对事。真正复制会话文件那一步在 SDK 里,不属于
 * 这个仓库。
 *
 * ## 它不碰用户真正的数据根
 *
 * `dataRoot()` 换成 `$MCODE_SMOKE_DATA_ROOT`(见 `stubs/`),那是 run.sh 用 `mktemp -d`
 * 建的目录,跑完就删。**不是 `~/Mcode`** —— 这一点很要紧,因为 `initDb()` 在路径不存在
 * 时会**新建一个空库**。
 *
 * Run: scripts/session-fork-smoke/run.sh
 */
import { initDb } from "@main/store/db.js";
import { ProjectRepo, SessionRepo, MessageRepo } from "@main/store/repositories.js";
import { forkSession } from "@main/lib/sessionFork.js";
import { setFakeProvider, type FakeProvider } from "./stubs/providerRegistry.js";
import { broadcastIds } from "./stubs/sessionSync.js";
import type { MessageRecord, Session } from "@contracts/session";

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

const PROJECT = "p_fork";
const PROJECT_PATH = "C:/work/paper";

function mkSession(over: Partial<Session> = {}): Session {
  const now = 1_700_000_000_000;
  return {
    id: "s_src",
    projectId: PROJECT,
    providerId: "claude-sdk",
    claudeSessionId: "cli-source",
    kind: "chat",
    parentSessionId: null,
    nodeId: null,
    title: "引言怎么写",
    status: "idle",
    model: "sonnet",
    effort: "high",
    permissionMode: "acceptEdits",
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
    envMode: "local",
    worktreePath: null,
    wtStyle: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

function mkMessage(id: string, sessionId: string, text: string, at: number): MessageRecord {
  return { id, sessionId, role: "user", content: [{ type: "text", text }], createdAt: at };
}

/** 一个记得住自己被怎么调的假引擎,默认成功。 */
function fakeClaude(over: Partial<FakeProvider> = {}): FakeProvider {
  const provider: FakeProvider = {
    id: "claude-sdk",
    calls: [],
    forkSession: async (providerSessionId, opts) => {
      provider.calls.push({ providerSessionId, ...opts });
      return "cli-fork";
    },
    ...over,
  };
  setFakeProvider(provider);
  return provider;
}

/* ── 跑 ───────────────────────────────────────────────────────────────── */

await initDb();

/** 这个项目下一共有几段对话 —— "失败时库里一条新行都不留"靠它。 */
const countSessions = (): number => SessionRepo.listByProject(PROJECT, {}).length;

ProjectRepo.create({
  id: PROJECT,
  name: "论文",
  path: PROJECT_PATH,
  archived: false,
  pinnedAt: null,
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
});

const TEXT_A = "帮我写引言";
const TEXT_B = "先看看这两篇";

function seedSource(over: Partial<Session> = {}): void {
  SessionRepo.create(mkSession(over));
  MessageRepo.replaceAll("s_src", [
    mkMessage("m1", "s_src", TEXT_A, 10),
    mkMessage("m2", "s_src", TEXT_B, 20),
  ]);
}

seedSource();
const provider = fakeClaude();

console.log("\n复制一份对话(成功那条路)");
const fork = await forkSession("s_src", "引言怎么写 副本");
const source = SessionRepo.get("s_src") as Session;

eq("返回的是新的一段", fork.id === "s_src", false);
check("id 有自己的一串", fork.id.startsWith("sess_"), fork.id);
eq("标题用的是调用方给的那个", fork.title, "引言怎么写 副本");
eq("落在同一个项目", fork.projectId, PROJECT);
eq("引擎侧换成了新复制出来的那一段", fork.claudeSessionId, "cli-fork");
check("没有把源的引擎侧 id 抄过来", fork.claudeSessionId !== "cli-source");
check("源那段自己的 id 没被改动", source.claudeSessionId === "cli-source");

console.log("\n引擎收到的是对的那几样");
eq("调了一次", provider.calls.length, 1);
eq("引擎侧会话 id 取自源", provider.calls[0]?.providerSessionId, "cli-source");
eq("目录给的是项目路径", provider.calls[0]?.cwd, PROJECT_PATH);
eq("标题一并交出去(引擎那边也记一份)", provider.calls[0]?.title, "引言怎么写 副本");

console.log("\n配置照抄,但有两样刻意不带");
eq("模型照抄", fork.model, "sonnet");
eq("思考档照抄", fork.effort, "high");
eq("权限模式照抄", fork.permissionMode, "acceptEdits");
eq("归档状态清掉", fork.archived, false);
eq("钉住清掉", fork.pinnedAt, null);
eq("用量记录不带过来", fork.usageHistory, null);

console.log("\n消息抄过去了 —— 内容一样、id 全不一样");
const srcMsgs = MessageRepo.listBySession("s_src").messages;
const forkMsgs = MessageRepo.listBySession(fork.id).messages;
eq("条数一样", forkMsgs.length, srcMsgs.length);
eq("顺序一样", forkMsgs.map((m) => JSON.stringify(m.content)).join("|"), srcMsgs.map((m) => JSON.stringify(m.content)).join("|"));
eq("指向新会话", forkMsgs.every((m) => m.sessionId === fork.id), true);
eq("没有一条沿用源的 id", forkMsgs.some((m) => srcMsgs.some((s) => s.id === m.id)), false);
eq("源那两条一条没少", srcMsgs.length, 2);
// 少了一条就是"内容一样"那句在骗人 —— 这里逐条对一遍正文。
eq("第一条正文一样", JSON.stringify(forkMsgs[0]?.content), JSON.stringify(srcMsgs[0]?.content));
eq("第二条正文一样", JSON.stringify(forkMsgs[1]?.content), JSON.stringify(srcMsgs[1]?.content));

console.log("\n新会话真的广播出去了(不广播它不会出现在左栏)");
eq("广播了新会话", broadcastIds.includes(fork.id), true);

console.log("\n两边之后各走各的");
SessionRepo.delete(fork.id);
eq("删掉副本之后源还在", SessionRepo.get("s_src")?.id, "s_src");
eq("源的消息也还在", MessageRepo.listBySession("s_src").messages.length, 2);

console.log("\n引擎报错时一条新行都不留(顺序不能反)");
{
  const before = countSessions();
  const msgsBefore = MessageRepo.listBySession("s_src").messages.length;
  let threw = "";
  fakeClaude({
    forkSession: async () => {
      throw new Error("会话文件不在了");
    },
  });
  try {
    await forkSession("s_src", "不该建出来的一份");
  } catch (err) {
    threw = (err as Error).message;
  }
  check("错误冒到调用方(不是被吞掉)", threw.includes("会话文件不在了"), threw);
  eq("库里没有多出会话", countSessions(), before);
  eq("源的消息也没被动", MessageRepo.listBySession("s_src").messages.length, msgsBefore);
}

console.log("\n引擎不支持复制时,明确拒绝而不是建一个空壳");
{
  const before = countSessions();
  fakeClaude({ forkSession: undefined });
  let threw = "";
  try {
    await forkSession("s_src", "不该建出来的一份");
  } catch (err) {
    threw = (err as Error).message;
  }
  check("说清了是引擎不支持", threw.includes("claude-sdk") && threw.includes("不支持"), threw);
  eq("同样没有多出会话", countSessions(), before);
}

console.log("\n还没发过言的会话:没上下文可分,但照样复制得出来");
{
  fakeClaude();
  SessionRepo.create(mkSession({ id: "s_empty", claudeSessionId: null, title: "还没开始" }));
  MessageRepo.replaceAll("s_empty", []);
  const provider2 = fakeClaude();
  const copy = await forkSession("s_empty", "还没开始 副本");
  eq("没有去调引擎", provider2.calls.length, 0);
  eq("引擎侧 id 是空的(它确实还没有)", copy.claudeSessionId, null);
  eq("消息也是空的", MessageRepo.listBySession(copy.id).messages.length, 0);
}

console.log("\n工作树会话:引擎要拿到工作树那个目录,不是项目根");
{
  const provider3 = fakeClaude();
  SessionRepo.create(
    mkSession({
      id: "s_wt",
      claudeSessionId: "cli-wt",
      envMode: "worktree",
      worktreePath: "C:/work/paper/.wt/one",
    }),
  );
  MessageRepo.replaceAll("s_wt", [mkMessage("m9", "s_wt", "在那里改", 30)]);
  const copy = await forkSession("s_wt", "工作树 副本");
  eq("引擎拿到的是工作树目录", provider3.calls[0]?.cwd, "C:/work/paper/.wt/one");
  // 副本跟着源落在同一个工作树里 —— 两边看到的文件是同一份,这正是"一模一样的一段"。
  eq("副本也绑在同一个工作树", copy.worktreePath, "C:/work/paper/.wt/one");
  eq("环境的意图也照抄", copy.envMode, "worktree");
}

console.log("\n找不着的源对话");
{
  let threw = "";
  try {
    await forkSession("s_nope", "x");
  } catch (err) {
    threw = (err as Error).message;
  }
  check("明确报错", threw.includes("s_nope"), threw);
}

console.log(`\n${total - failures}/${total} 通过`);
if (failures > 0) {
  console.log(`${failures} 条失败`);
  process.exit(1);
}
