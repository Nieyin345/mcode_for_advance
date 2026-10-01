/**
 * 前端 smoke:「这件事没有崩,但用户看到的不是实话」那一类。
 *
 * ## 为什么单独开一套
 *
 * 已有的 41 套验的都是**功能对不对**:函数返回什么、落没落盘、闸门挡没挡住。而用户
 * 报的是另一种毛病 —— 「前端也说不上错,就是不合理呀,一点也不专业」。手上的实例:
 * 一次**失败**的工作流跑完,系统通知弹的是「Agent 已完成本轮任务」。
 *
 * 这句话在代码里一路都"对":`turn.done` 确实发了、`reason` 字段确实有、渲染端的
 * 「运行中」也确实关掉了。**没有一条既有断言会红。** 它就是一句谎话而已。
 *
 * 所以这一套立的判据是:**某个事件到达时,用户会看到的那行字,是不是这件事的实话。**
 * 它测的是**判断**(`NotificationManager.evaluate`),不是渲染 —— 而这也是唯一可行的
 * 切法:主进程拼的那几行字(turn.done / error / 审批 / 提问)整体被一条
 * `win.isFocused()` 挡在门外(前台时界面自己弹 toast),而**同一个 `evaluate` 是
 * 前后台共用的**。也就是说:这条路可以静默地错一整天,而没人会注意到。
 *
 * ## 它怎么骗过 electron
 *
 * `NotificationManager` 直接 `import { Notification } from "electron"`。整个 electron
 * 换成了一个记事的桩(见 stubs/electron.ts):`show()` 把标题正文记下来 —— 于是
 * "弹没弹、弹的什么字"从不可观测变成可断言的。`@main/window.js` 换桩是为了能拨
 * "窗口在不在前台"。
 *
 * ## 它不碰用户真正的数据根
 *
 * `dataRoot()` 换成 `$MCODE_SMOKE_DATA_ROOT`(复用 db-migrate-smoke 的桩),run.sh 用
 * `mktemp -d` 建目录,跑完就删。
 *
 * Run: scripts/frontend-smoke/run.sh
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "@main/store/db.js";
import { ProjectRepo, SessionRepo } from "@main/store/repositories.js";
import type { Session } from "@contracts/session";
import { notificationManager } from "@main/notifications/NotificationManager.js";
import { shown, resetShown } from "./stubs/electron.js";
import { setWindow, resetSent, sent } from "./stubs/window.js";

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

const DATA = mkdtempSync(join(tmpdir(), "mcode-frontend-"));
process.env.MCODE_SMOKE_DATA_ROOT = DATA;

await initDb();

// 会话挂在项目下(sessions.project_id 是外键)。跑不通的话是**在 initDb 之后**、
// 在造第一条会话时就炸 —— 一行断言都到不了。抄的是 automation-smoke 的形状。
ProjectRepo.create({
  id: "p_smoke",
  name: "冒烟",
  path: "D:\\proj",
  archived: false,
  group: null,
  sortOrder: 0,
  pinnedAt: null,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
});

/**
 * 造一条会话。
 *
 * ⚠️ `Session` 的字段一个都不能少:`SessionRepo.create` 是按 `SESSION_COLUMNS` 逐个
 * bind 的,少一个就是 `undefined` 绑进去 —— 有的列 NOT NULL,当场炸;有的不炸,
 * 于是这条会话和用户真跑出来的那条**不一样**,后面所有判据都飘。形状抄的是
 * `automation-smoke` 的 `sessionOf`(那条路也在验会话表)。
 */
function makeSession(id: string, kind: Session["kind"], title: string): string {
  // **幂等。** 每一段都自助地造同一批夹具,重复造会撞 `sessions.id` 的 UNIQUE ——
  // 而那个报错发生在断言之前,看起来像"这一套跑不起来"。已经在了就直接用。
  if (SessionRepo.get(id)) return id;
  const now = 1_700_000_000_000;
  const s: Session = {
    id,
    projectId: "p_smoke",
    providerId: "claude-sdk",
    claudeSessionId: null,
    kind,
    parentSessionId: null,
    nodeId: null,
    title,
    status: "idle",
    model: "smoke-model",
    effort: "default",
    permissionMode: "default",
    workflowId: "wf_smoke",
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
    createdAt: now,
    updatedAt: now,
  };
  SessionRepo.create(s);
  return id;
}

const ALL_PREFS = {
  osEnabled: true,
  turnComplete: true,
  errors: true,
  blocking: true,
  backgroundTasks: true,
  // R39 新增的几项:声音 / 应用内提示 / 前台也弹 / 按项目静音 / 免打扰时段
  sound: true,
  inAppToasts: true,
  alsoWhenFocused: false,
  mutedProjectIds: [] as string[],
  quietHours: { enabled: false, start: "22:00", end: "08:00" },
};

/* ──────────────── 架子 ──────────────── */

/**
 * 跑一遍"某个事件到达时会怎样",返回真的 show 出去的那条(没有则 null)。
 *
 * **每次都先把窗口拨到后台** —— 那正是"要不要弹系统通知"这个问题只在后台才成立的原因
 * (`onEvent` 头两行:前台时界面自己弹 toast,这条整个不走)。前台那条单独在最后验。
 *
 * ⚠️ 走的是 `notificationManager.onEvent` 的原样入口。它是 private,但这里**故意**
 * 用 `as never` 撬开而不是另写一个测试专用导出:测试入口和线上入口一旦分家,验的就
 * 不是用户走的那条路了。
 */
function notifyVia(e: unknown): { title: string; body: string } | null {
  resetShown();
  resetSent();
  (notificationManager as unknown as { onEvent: (e: unknown) => void }).onEvent(e);
  return shown[0] ?? null;
}

/** 一个极简的 turn.done。字段只给这条判断真读得到的。 */
const turnDone = (sessionId: string, reason: string): unknown => ({
  type: "turn.done",
  sessionId,
  reason,
  endedAt: 0,
});

const errorEvent = (sessionId: string, message: string): unknown => ({
  type: "error",
  sessionId,
  message,
});

/* ──────────────── 1. 失败的那一轮,不能报成"已完成" ──────────────── */

console.log("\n失败的那一轮");

// **这一条是整件事的起点。** 用户离开电脑,一次工作流跑失败了,回来看到 OS 弹的
// 「Agent 已完成本轮任务」—— 那是他手上唯一的信号,而它是反的。
//
// 工作流收口发的是 `turn.done reason:"error"`(见 `orchestration/runner.ts` 里
// `settled` 那一段)。它曾经一路掉到下面那句写死的文案上。
{
  const s = { id: makeSession("s_chat", "chat", "冒烟会话") };
  setWindow({ alive: true, focused: false, minimized: false });

  const onError = notifyVia(turnDone(s.id, "error"));
  check("reason=error 时不会弹「已完成本轮任务」", onError === null || !onError.body.includes("已完成"), onError);

  // 而真正在跑完的那一轮,那句话是**对的** —— 别把闸门关过头,顺手钉住。
  const onEnd = notifyVia(turnDone(s.id, "end_turn"));
  check("reason=end_turn 照常弹", onEnd !== null, onEnd);
  check("而且说的就是完成", onEnd?.body.includes("已完成") === true, onEnd);

  // `max_tokens` 是"被长度截断了" —— 回合确实收场(不是失败),但任务不能报成已完成。
  // 照常通知,只是要告诉用户检查结果,而不是给出成功结论。
  const onMax = notifyVia(turnDone(s.id, "max_tokens"));
  check("reason=max_tokens 也照弹", onMax !== null, onMax);
  check("长度截断通知说清楚截断风险", onMax?.title.includes("截断") === true, onMax);
  check("长度截断不误报任务已完成", onMax?.body.includes("已完成") === false, onMax);
}

/* ──────────────── 2. 失败的那条信息,不能因为上面那道闸门一起消失 ──────────────── */

console.log("\n失败的信息还得在");

// **这是第 1 段的反面,而且是它唯一可能出错的地方。** 让 `turn.done reason:"error"`
// 闭嘴有两种做法:一种是"这一轮不弹了"(对,失败由 `error` 事件去说),另一种是
// "整条路都别弹了"(错 —— 失败会变成一声不响)。
//
// 所以这里钉的是:**同一件事上,必须恰好有一条通知,不多也不少。** 用户一次失败收到
// 两条通知是把一个错换成了另一个错。
{
  const s = { id: makeSession("s_chat", "chat", "冒烟会话") };
  setWindow({ alive: true, focused: false, minimized: false });

  // 三家引擎与工作流收口都是**成对**发的:先 `error`,再 `turn.done reason:"error"`。
  const pair: Array<{ title: string; body: string } | null> = [];
  resetShown();
  (notificationManager as unknown as { onEvent: (e: unknown) => void }).onEvent(
    errorEvent(s.id, "调度器抛出:节点 C 失败"),
  );
  pair.push(shown[0] ?? null);
  (notificationManager as unknown as { onEvent: (e: unknown) => void }).onEvent(turnDone(s.id, "error"));
  pair.push(shown[1] ?? null);

  eq("成对的两个事件只弹一条通知", shown.length, 1);
  check("弹的是「发生错误」那条", pair[0]?.title.includes("错误") === true, pair);
  check("正文带着那句话", pair[0]?.body.includes("节点 C 失败") === true, pair[0]);
}

/* ──────────────── 3. 用户自己设的开关,关掉就是关掉 ──────────────── */

console.log("\n偏好开关");

// 「静默地少弹一条」在设置页上看起来和"没有通知"一模一样,所以关掉时**必须是零**,
// 而不是"少一条"。这里顺手把四条路各关一次 —— 它们是各自独立的开关,共用一个
// `prefs` 对象,最容易被一次改动串掉。
{
  const s = { id: makeSession("s_chat", "chat", "冒烟会话") };
  setWindow({ alive: true, focused: false, minimized: false });

  notificationManager.setPrefs({ ...ALL_PREFS, turnComplete: false });
  eq("turnComplete 关掉 → 完成不弹", notifyVia(turnDone(s.id, "end_turn")), null);

  notificationManager.setPrefs({ ...ALL_PREFS, errors: false });
  eq("errors 关掉 → 报错不弹", notifyVia(errorEvent(s.id, "炸了")), null);

  notificationManager.setPrefs({ ...ALL_PREFS, blocking: false });
  eq(
    "blocking 关掉 → 审批不弹",
    notifyVia({ type: "approval.request", sessionId: s.id, toolName: "shell" }),
    null,
  );

  // `osEnabled` 是总闸:它挡在 `showNotification` 里,所以**判断照算、只是不 show**。
  // 用 turnComplete 那条正常路验它。
  notificationManager.setPrefs({ ...ALL_PREFS, osEnabled: false });
  eq("osEnabled 关掉 → 什么都不弹(总闸)", notifyVia(turnDone(s.id, "end_turn")), null);

  notificationManager.setPrefs({ ...ALL_PREFS });
  check("恢复默认之后又弹了", notifyVia(turnDone(s.id, "end_turn")) !== null);
}

/* ──────────────── 4. 用户正在看着的时候,不该被系统通知打断 ──────────────── */

console.log("\n前台不打扰");

// 界面自己有 toast 层。窗口在前台时再弹一条 OS 通知是重复打扰 —— 这条闸门在
// `onEvent` 的头两行,是**所有**通知的必经之路,被改坏的话表现是"用起来有点烦"
// (没人会去报 bug)。
{
  const s = { id: makeSession("s_chat", "chat", "冒烟会话") };

  setWindow({ alive: true, focused: true, minimized: false });
  eq("窗口在前台 → 不弹", notifyVia(turnDone(s.id, "end_turn")), null);

  // **最小化是例外**:`isFocused()` 在最小化时可能仍是 true,所以那个条件是
  // `focused && !minimized`。最小化了就是要弹。
  setWindow({ alive: true, focused: true, minimized: true });
  check("最小化了 → 照弹", notifyVia(turnDone(s.id, "end_turn")) !== null);

  setWindow({ alive: true, focused: false, minimized: false });
  check("窗口不在前台 → 弹", notifyVia(turnDone(s.id, "end_turn")) !== null);

  // 窗口没了(退出中)不该炸。
  setWindow({ alive: false });
  eq("窗口已经销毁 → 不弹也不炸", notifyVia(turnDone(s.id, "end_turn")), null);
  setWindow({ alive: true });
}

/* ──────────────── 5. 那几句写死的字,是用户唯一看到的东西 ──────────────── */

console.log("\n文案本身");

// 这四句是整个主进程里**唯几处直给用户看的中文**(别处都走 i18n,但渲染端词典在
// renderer 里、主进程够不着 —— 所以这里是刻意写死的,见文件头的说明)。
//
// 写死的东西没人管就会漂:`reason` 加了一个新取值、某条路换了标题,这里不会有人知道,
// 因为**它没有类型约束也没有回归网**。所以钉住当前的样子 —— 不是为了禁止改,而是
// 为了让"改了口径"这件事必须是一次**有意的**改动。
{
  const s = { id: makeSession("s_chat", "chat", "冒烟会话") };
  setWindow({ alive: true, focused: false, minimized: false });
  notificationManager.setPrefs({ ...ALL_PREFS });

  const approval = notifyVia({ type: "approval.request", sessionId: s.id, toolName: "shell" });
  eq("审批的标题", approval?.title, "需要审批工具调用");

  const ask = notifyVia({
    type: "question.ask",
    sessionId: s.id,
    questions: [{ question: "要跑哪个脚本?" }],
  });
  eq("提问的标题", ask?.title, "Agent 有问题要问你");
  check("提问的正文带上第一个问题", ask?.body.includes("要跑哪个脚本?") === true, ask);

  const plan = notifyVia({ type: "plan.approval_request", sessionId: s.id });
  eq("计划待审批的标题", plan?.title, "计划待审批");

  const err = notifyVia(errorEvent(s.id, "某个错"));
  eq("报错的标题", err?.title, "发生错误");
  eq("报错的正文带上那句话", err?.body, "冒烟会话: 某个错");

  const done = notifyVia(turnDone(s.id, "end_turn"));
  eq("完成的标题", done?.title, "回合完成");
  eq("完成的正文", done?.body, "冒烟会话: Agent 已完成本轮任务");

  // 会话查不到时(和删除抢了一下)不能炸,退回一个通用词。
  const ghost = notifyVia(turnDone("sess-没有这个", "end_turn"));
  eq("会话不在库里 → 用兜底词", ghost?.body, "会话: Agent 已完成本轮任务");
}

/* ──────────────── 6. 工作流节点是隐藏会话,不该打扰用户 ──────────────── */

console.log("\n隐藏会话");

// 一次工作流运行会给**每个节点**开一个会话。用户既看不见它们、也管不着它们 ——
// 跑完一个十节点的图弹十条通知,那不叫提醒,叫刷屏。
{
  const node = { id: makeSession("s_node", "node", "节点会话") };
  setWindow({ alive: true, focused: false, minimized: false });
  notificationManager.setPrefs({ ...ALL_PREFS });

  eq("节点会话跑完 → 不弹", notifyVia(turnDone(node.id, "end_turn")), null);
  eq("节点会话报错 → 不弹(已由调度器变成对话里的一张卡)", notifyVia(errorEvent(node.id, "炸了")), null);

  // ⚠️ 但**审批与提问照弹** —— 那两类在主进程里已经被改写成父对话的事件
  // (`setInteractiveProxy`),节点卡在等人时用户必须收到通知,否则图会一直停在
  // 那里等一个没人知道的答复。这一条是上面那个"不打扰"最容易误伤的邻居。
  check(
    "节点会话要审批 → 照弹",
    notifyVia({ type: "approval.request", sessionId: node.id, toolName: "shell" }) !== null,
  );
  check(
    "节点会话要提问 → 照弹",
    notifyVia({ type: "question.ask", sessionId: node.id, questions: [{ question: "选哪个?" }] }) !== null,
  );
}

/* ──────────────── 7. 没人管得着的事件,不该有动静 ──────────────── */

console.log("\n其余事件");

// `evaluate` 的兜底是 `return null`。这一条看着像废话,**但它正是新加一个事件类型时
// 最容易踩的坑**:漏写分支不会报错,只会安静地掉进兜底 —— 或者更糟,掉进上面某个
// 判据的 `else`。把"不认识的一律不响"钉住。
{
  const s = { id: makeSession("s_chat", "chat", "冒烟会话") };
  setWindow({ alive: true, focused: false, minimized: false });
  notificationManager.setPrefs({ ...ALL_PREFS });

  // 用户自己按的停止 —— 他知道自己刚干了什么,不该再收到一条"你的回合结束了"。
  eq("reason=interrupted → 不弹", notifyVia(turnDone(s.id, "interrupted")), null);
  // `tool_use` 是中间态(模型还要接着干活),不是收场。
  eq("reason=tool_use → 不弹", notifyVia(turnDone(s.id, "tool_use")), null);

  // 后台子代理:只有"跑着 → 跑完了"那一下值得说,而且说一次。
  const running = { type: "subagent.update", sessionId: s.id, agents: [{ taskId: "t1", status: "running" }] };
  const finished = { type: "subagent.update", sessionId: s.id, agents: [{ taskId: "t1", status: "completed" }] };
  eq("子代理刚开始跑 → 不弹", notifyVia(running), null);
  check("子代理跑完 → 弹", notifyVia(finished) !== null);
  eq("同一条不会弹第二次", notifyVia(finished), null);
}

/* ──────────────── 收尾 ──────────────── */

rmSync(DATA, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
