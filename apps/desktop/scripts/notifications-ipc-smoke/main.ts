/**
 * Headless smoke for **`main/ipc/notifications.ts`** —— 通知偏好的读写 + 点通知跳会话。
 *
 * ## 为什么单独一套
 *
 * 这个文件零覆盖,而它真正的风险**不在解析参数,在"两处状态会不会走散"**:
 *
 *  - 偏好是**两份**。`notifications.prefs` 既在 settings 表里(重启后要读到),
 *    又在 `NotificationManager` 的内存里(`evaluate()` 每秒都在问它)。写进去必须
 *    **两边都动** —— 漏掉任何一边,用户看到的现象一样但坏法不同:
 *      · 只落盘不更新内存 → 关掉「完成时通知」,**当前这次运行照样弹**,重启才好;
 *      · 只更新内存不落盘 → 这次不弹了,**重启又全弹回来**。
 *    这两条各有一条断言,而且都要**读到真的**:落盘那份从 `SettingRepo.get` 读,
 *    内存那份从 `notificationManager.getPrefs()` 读。只断言 handler 返回的那个对象
 *    没有意义 —— 那是它自己刚构造的,两边都错了它也绿。
 *
 *  - 五个开关是**逐字段抄**的(`prefs` 那个字面量)。少抄一个字段,用户会看到某个
 *    开关一存进去就变 `undefined`。
 *
 *  - 库里的值可能是**坏数据**(老版本、手写设置、写到一半断电)。启动不能炸,
 *    而且要落回"全开"而不是某个字段变假。
 *
 *  - `NOTIFICATION_FOCUS_SESSION` 是"点了系统通知能不能跳过去"的唯一一条路。窗口不在
 *    / 已销毁要能安静地什么也不干;窗口最小化要 **先 `restore` 再 `show` 再 `focus`**
 *    (顺序换了在部分平台上会丢焦点);最后**必须**推一条 `notification:focusSession` ——
 *    推丢了就是"点了没反应"。
 *
 * ## 它怎么骗过 electron
 *
 * 整个 `electron` 包换成记事的桩(见 stubs/electron.ts):`Notification` 只在真的弹
 * 通知时才会被构造 —— 而那正是"当前这次运行弹没弹"的可观测痕迹。窗口对象能喂成
 * 四种形态,`restore`/`show`/`focus` 按顺序记下来。
 *
 * ⚠️ **`NotificationManager` 留真的**(只换它 import 的 `RuntimeManager`)。本套验的
 * 一半就是"内存里那份 prefs",把它换掉等于验桩自己。
 *
 * ## 它不碰用户真正的数据根
 *
 * `dataRoot()` 换成 `$MCODE_SMOKE_DATA_ROOT`(复用 run-store-smoke 的桩,没设就抛),
 * run.sh 用 `mktemp -d` 建目录跑完就删。**这条非有不可**:这一套真写 settings 表,
 * 而 `SettingRepo.set` 内部是 `persist()` —— 一次点击就重写整个 `mcode.db`。
 *
 * Run: scripts/notifications-ipc-smoke/run.sh
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { IpcMain } from "electron";
import type { RuntimeEvent } from "@contracts/runtime";
import type { NotificationPrefs } from "@contracts/ipc";

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

/** 数组/对象比较:内容相同但引用不同时 `Object.is` 是 false。 */
function same(name: string, actual: unknown, expected: unknown): void {
  check(
    name,
    JSON.stringify(actual) === JSON.stringify(expected),
    { actual, expected },
  );
}

const DATA = mkdtempSync(join(tmpdir(), "mcode-notif-ipc-"));
// ⚠️ **必须在 import 之前设。** `@main/lib/dataRoot.js` 那个桩读的就是它,而 db.ts
// 的 `initDb()` 在一个不存在的路径上会**新建一个空库** —— 指错了就是拿空库盖掉用户的
// 聊天记录。桩里没设会抛(不是默默回落),所以漏了这一行是当场炸而不是静默毁数据。
process.env.MCODE_SMOKE_DATA_ROOT = DATA;

/* ──────────────── 0. 脚手架 ──────────────── */

/** `ipcMain` 的记名替身:把 `registerNotificationHandlers` 注册进去的真函数按 channel
 *  收下来。本套只调真的那三个 handler,不复述它们的行为。 */
const handlers = new Map<string, (event: unknown, raw: unknown) => unknown>();
const fakeIpc = {
  handle(channel: string, listener: (event: unknown, raw: unknown) => unknown): void {
    handlers.set(channel, listener);
  },
} as unknown as IpcMain;

const { IPC, NOTIFICATION_PREFS_SETTING_KEY } = await import("@contracts/ipc");
const { registerNotificationHandlers } = await import("@main/ipc/notifications.js");
registerNotificationHandlers(fakeIpc);

const { initDb } = await import("@main/store/db.js");
const { SettingRepo } = await import("@main/store/repositories.js");
const { notificationManager } = await import("@main/notifications/NotificationManager.js");
const { shown, resetShown, constructed, windowCalls, resetWindow, setWindow } = await import(
  "./stubs/electron.js"
);
const { sent, resetSent } = await import("./stubs/window.js");

await initDb();

/** 按 channel 取回注册进去的真 handler。`GET_PREFS` 不带参数、另外两个带,所以这里
 *  是变参 —— 参数个数由调用方决定,不替它们编。 */
function handlerFor(channel: string): (...args: unknown[]) => Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`registerNotificationHandlers 没有注册 ${channel}`);
  return (...args: unknown[]) => Promise.resolve(fn(null, args[0]));
}

const getPrefs = handlerFor(IPC.NOTIFICATION_GET_PREFS);
const setPrefs = handlerFor(IPC.NOTIFICATION_SET_PREFS);
const focusSession = handlerFor(IPC.NOTIFICATION_FOCUS_SESSION);

check("三个 handler 都注册上了", handlers.size === 3, { registered: [...handlers.keys()] });

/** 落盘的那份 —— 从库里读回来,不是从 handler 的返回值里抄。 */
function storedPrefs(): Record<string, unknown> | null {
  const raw = SettingRepo.get(NOTIFICATION_PREFS_SETTING_KEY);
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
}

/** 内存的那份 —— 从 NotificationManager 读回来。 */
function memoryPrefs(): NotificationPrefs {
  return notificationManager.getPrefs();
}

/** 直接问 NotificationManager:这条事件**现在**会不会弹。
 *  走真的那个 `onEvent`(`evaluate` 是私有的),所以这条判据钉的是"用户这一刻会不会
 *  看见一条通知",而不是某个内部字段。 */
const mgrOnEvent = (
  notificationManager as unknown as { onEvent(e: RuntimeEvent): void }
).onEvent.bind(notificationManager);

function wouldNotify(e: RuntimeEvent): boolean {
  const before = shown.length;
  mgrOnEvent(e);
  return shown.length > before;
}

const ALL_OFF: NotificationPrefs = {
  osEnabled: false,
  turnComplete: false,
  errors: false,
  blocking: false,
  backgroundTasks: false,
};

/* ──────────────── 1. 缺字段必须是"默认开" ──────────────── */

console.log("\n缺字段的输入要补成默认开");

{
  // 「老版本渲染端」的形状:一个字段都不带。五个 `.default(true)` 必须全补上。
  const res = (await setPrefs({})) as { prefs: NotificationPrefs };
  same("空对象进来 → 五个字段齐、全是 true", res.prefs, {
    osEnabled: true,
    turnComplete: true,
    errors: true,
    blocking: true,
    backgroundTasks: true,
  });

  // 只带一个字段:其余四个也要在,而不是 `undefined`。
  const partial = (await setPrefs({ osEnabled: false })) as { prefs: NotificationPrefs };
  check(
    "只带 osEnabled 时其余四个仍是 true(不是 undefined)",
    partial.prefs.turnComplete === true &&
      partial.prefs.errors === true &&
      partial.prefs.blocking === true &&
      partial.prefs.backgroundTasks === true,
    partial.prefs,
  );
  eq("带上的那个字段照着用", partial.prefs.osEnabled, false);

  // **落盘的那份也要五个字段。** 手写 `prefs` 字面量少抄一个字段的话,`JSON.stringify`
  // 会把它整个丢掉 —— 重启后那个开关就变回默认,用户的改动"存了但没存住"。
  const stored = storedPrefs();
  eq("落盘的那份 JSON.parse 回来正好五个 key", Object.keys(stored ?? {}).length, 5);
  same("落盘的 key 就是这五个", Object.keys(stored ?? {}).sort(), [
    "backgroundTasks",
    "blocking",
    "errors",
    "osEnabled",
    "turnComplete",
  ]);
  check("落盘那份里没有 undefined 值", Object.values(stored ?? {}).every((v) => v !== undefined), stored);
}

/* ──────────────── 2. osEnabled 关掉,其余四个照旧 true ──────────────── */

console.log("\n系统通知总开关不牵连分类开关");

{
  // 用户只是关掉了"弹系统通知",不是关掉了四类事件。其余四个必须如实带着 true
  // 落盘 —— 否则他哪天再打开总开关,会发现分类也被人替他关了。
  const res = (await setPrefs({ osEnabled: false })) as { prefs: NotificationPrefs };
  same("落盘那份里其余四个还是 true", storedPrefs(), {
    osEnabled: false,
    turnComplete: true,
    errors: true,
    blocking: true,
    backgroundTasks: true,
  });
  eq("内存那份也跟着", memoryPrefs().turnComplete, true);
  check("osEnabled=false 的返回值是最先列出来的那个字段", res.prefs.osEnabled === false);
}

/* ──────────────── 3. 两份状态:写进去必须两边都动 ──────────────── */

console.log("\n写进去之后:库里那份和内存那份都得变");

{
  const res = (await setPrefs(ALL_OFF)) as { prefs: NotificationPrefs };

  // ⚠️ 这两条是本套的重点:一条读库、一条读内存。
  //   只读 handler 的返回值等于什么都没验 —— 那个对象是它自己刚构造的。
  same("落盘那份是用户刚设的(重启后读得到)", storedPrefs(), ALL_OFF);
  same("内存那份也是(当前这次运行立刻生效)", memoryPrefs(), ALL_OFF);

  // 内存那份错了会怎样:用户关掉「完成通知」,当前这次运行照样弹。把"当前会不会弹"
  // 钉住 —— 这是唯一能看到这个 bug 的角度。
  setWindow("normal");
  resetShown();
  const turnDoneStub = {
    type: "turn.done",
    sessionId: "s_none",
    reason: "end_turn",
  } as unknown as RuntimeEvent;
  eq("关掉完成通知后,当前的运行时里不再弹", wouldNotify(turnDoneStub), false);

  // 库那份错了会怎样:这次不弹了,重启又全弹回来。这里直接模拟一次重启 ——
  // 从库里重新读(main/index.ts 的启动顺序,见 §5)。
  notificationManager.reloadPrefs();
  same("重读一遍库,内存那份仍是用户设的(重启不会回弹)", memoryPrefs(), ALL_OFF);
}

/* ──────────────── 4. 库里是坏数据时,启动要落回默认而不是炸 ──────────────── */

console.log("\n库里的坏值不能把通知系统带崩");

{
  // `parsePrefs` 是 `NotificationManager` 的模块私有函数(没导出),能碰到它的唯一
  // 入口就是 `reloadPrefs()` —— 所以下面每一格都**先把坏值写进库**再 reload。
  // 只在内存里造一个坏对象不叫验证:真正会坏的是上一次写到一半、或者被别的版本写脏的
  // 那一行。而 `parsePrefs` 里的 `{ ...DEFAULTS, ...obj }` 有两个已知挡不住的展开:
  // 字符串会被按字符摊开、字段类型错会原样覆盖。
  //
  // 这两条**是故意的**:它们把 `parsePrefs` 的实际行为钉住,而不是我期望的行为。
  // 真 bug 的判断见本段末尾那两条(会被上层当布尔用)。
  const cases: Array<{ name: string; raw: string }> = [
    { name: "空串", raw: "" },
    { name: "不是 JSON 的串", raw: "not json at all" },
    { name: "JSON 的 null", raw: "null" },
    { name: "JSON 的数字", raw: "123" },
    { name: "JSON 的数组", raw: "[]" },
  ];
  const ALL_ON = {
    osEnabled: true,
    turnComplete: true,
    errors: true,
    blocking: true,
    backgroundTasks: true,
  };
  for (const c of cases) {
    SettingRepo.set(NOTIFICATION_PREFS_SETTING_KEY, c.raw);
    let threw: unknown = null;
    try {
      notificationManager.reloadPrefs();
    } catch (err) {
      threw = err;
    }
    check(
      `${c.name} → 不抛,落回全开`,
      threw === null && JSON.stringify(memoryPrefs()) === JSON.stringify(ALL_ON),
      { threw: threw === null ? null : String(threw), prefs: memoryPrefs() },
    );
  }

  // ⚠️ 这一条钉的是**实际行为,不是期望**。`parsePrefs` 里的 `{ ...DEFAULTS, ...obj }`
  // 对"字段类型错"是挡不住的:`turnComplete: "yes"` 会原样盖掉 `true`。这个值往前走
  // 一步就会被 `NotificationManager.evaluate` 当布尔用(`if (!this.prefs.turnComplete)`),
  // 而 `"yes"` 是真值、`""` 是假值 —— 于是设置面板上那个开关显示"开",实际按"关"
  // (或者反过来)走。**用户看到的是开关行为和面板不一致**,这是真 bug,根因在
  // `NotificationManager.ts` 的 `parsePrefs`(不在本文件,没改)。见套件报告的 §4。
  SettingRepo.set(NOTIFICATION_PREFS_SETTING_KEY, JSON.stringify({ turnComplete: "yes" }));
  notificationManager.reloadPrefs();
  eq('字段类型错会被原样带进来("yes")', memoryPrefs().turnComplete, "yes" as unknown as boolean);

  // 另一头:空串同样是**假值**,弹不弹跟面板显示的对不上。
  SettingRepo.set(NOTIFICATION_PREFS_SETTING_KEY, JSON.stringify({ errors: "" }));
  notificationManager.reloadPrefs();
  setWindow("normal");
  resetShown();
  const errEvt = {
    type: "error",
    sessionId: "s_none",
    message: "炸了",
  } as unknown as RuntimeEvent;
  eq("空串被当假值用 → 报错不弹(面板上那个开关却显示着开)", wouldNotify(errEvt), false);

  // 「JSON 但不是对象」里最阴的一个:字符串会被**按字符展开**成数字下标。
  // 五个开关没事,但内存那份多出三个键。钉住它,是为了下次有人往 prefs 里加字段时
  // 知道这里会漏(加字段后这条会红,提醒他一起处理)。
  SettingRepo.set(NOTIFICATION_PREFS_SETTING_KEY, JSON.stringify("abc"));
  notificationManager.reloadPrefs();
  same(
    "字符串被展开成数字下标(已知形状,加字段时留意)",
    Object.keys(memoryPrefs()).filter((k) => /^\d+$/.test(k)).sort(),
    ["0", "1", "2"],
  );
  check("但五个开关还是全开", memoryPrefs().turnComplete === true && memoryPrefs().errors === true);
}

/* ──────────────── 4b. 读回来的那份是完整的 ──────────────── */

console.log("\n从库里读回来的偏好是完整的一份");

{
  // 用户改过设置、重启之后,`getPrefs` 读的就是这一条路。渲染端拿它当 `Switch` 的
  // `checked` —— 少一个字段,那个开关就是"关了"(undefined 是假值),而不是崩溃,
  // 所以这个问题不会有人报。
  SettingRepo.set(NOTIFICATION_PREFS_SETTING_KEY, JSON.stringify(ALL_OFF));
  notificationManager.reloadPrefs();
  const got = (await getPrefs()) as { prefs: NotificationPrefs };
  same("reload 之后读回来 = 写进去的那份", got.prefs, ALL_OFF);
  eq("五个字段一个不少", Object.keys(got.prefs).length, 5);
  check(
    "每个字段都是布尔(渲染端的 Switch 直接吃它)",
    Object.values(got.prefs).every((v) => typeof v === "boolean"),
    got.prefs,
  );

  // 往返一圈:set 写进去的,get 要能原样读回来。中间那一层是 `JSON.stringify` /
  // `JSON.parse`,任何一侧漏字段都在这儿现形。
  const round = (await setPrefs({ osEnabled: true, turnComplete: false, errors: true, blocking: false, backgroundTasks: true })) as {
    prefs: NotificationPrefs;
  };
  const back = (await getPrefs()) as { prefs: NotificationPrefs };
  same("setPreference 往返一圈不丢字段", back.prefs, round.prefs);
  eq("往返之后 turnComplete 还是关着的", back.prefs.turnComplete, false);
}

/* ──────────────── 5. 启动顺序:getPrefs 读的是哪一份 ──────────────── */

console.log("\n启动那一刻,设置面板拿到的是库里的还是默认值");

{
  // 这一条查实的是**模块级默认值和库里的值可能不是一回事**。两边默认恰好一样,
  // 所以只要有一个时点没读库,就永远看不出来。
  const manager = notificationManager as unknown as { started: boolean };

  // 先造一个"库里的值 != 默认值"的世界 —— 这正是用户改过设置之后的样子。
  //
  // ⚠️ **`start()` 之前绝不能先 `reloadPrefs()` 一次。** 早先这里顺手 reload 了一下,
  // 结果 `start()` 里那句读库变成多余的 —— 把它删掉这条照样绿(变异验证当场抓到,
  // 报的是"一条都没红")。用户重启那条路是 **`start()` 直接读库**,中间没有别人
  // 替他读过,所以这里要照那个形状来。
  SettingRepo.set(NOTIFICATION_PREFS_SETTING_KEY, JSON.stringify(ALL_OFF));
  same("库里那份已经是全关(用户改过了)", storedPrefs(), ALL_OFF);

  // `start()` 之前:内存里还是模块级默认值(全开)—— 两边默认恰好一样,所以
  // "有没有读过库"从这里看不出来。这一条只是把那段真实行为记下来。
  check("start() 的幂等开关一开始是关的", manager.started === false);

  notificationManager.start();
  check("start() 之后开关是开的(不会二次订阅)", manager.started === true);

  // ⚠️ 关键:start() 会把库里的值读进内存(`reloadPrefs()`)。删掉那一句,这条立刻红
  // —— 这正是题目里第 5 条那个怀疑的形状:内存停在模块级默认值上,而两边默认恰好
  // 一样,所以在"库里的值 = 默认值"时永远看不出来。
  same("start() 之后内存那份 = 库里的那份(不是默认值)", memoryPrefs(), ALL_OFF);

  // 生产里的顺序(`main/index.ts` 241~248):`awaitDb()` → `start()`。所以只要 db 就绪,
  // 这一条就成立;唯一不成立的是"db 没就绪"——而 IPC 那条路自带 `awaitDb()` 闸门
  // (见 `ipc/index.ts` 的 `createDbGuardedIpc`),两条路一起把时间窗关掉了。
  // 也就是说:这个怀疑在生产里**不会**发生,证据就是这两条路径 + 下面这条断言。
  const got = (await getPrefs()) as { prefs: NotificationPrefs };
  same("设置面板打开时读到的是用户改过的值", got.prefs, ALL_OFF);

  SettingRepo.set(NOTIFICATION_PREFS_SETTING_KEY, JSON.stringify({
    osEnabled: true,
    turnComplete: true,
    errors: true,
    blocking: true,
    backgroundTasks: true,
  }));
  notificationManager.reloadPrefs();
}

/* ──────────────── 6. 点通知跳会话:窗口那一条路 ──────────────── */

console.log("\n点通知之后窗口怎么被拉起来");

{
  const focusPayload = (sid: string) => ({ sessionId: sid });

  // ① 没有窗口(`getMainWindow()` 返回 null)。
  setWindow("none");
  resetWindow();
  resetSent();
  check("没有窗口时 handler 返回的是一个 promise(渲染端 invoke 才拿得到应答)",
    typeof (focusSession(focusPayload("s_focus")) as Promise<unknown>).then === "function");
  let threw: unknown = null;
  try {
    await focusSession(focusPayload("s_focus"));
  } catch (err) {
    threw = err;
  }
  eq("没有窗口时不抛", threw, null);
  eq("没有窗口时一个窗口动作都没做", windowCalls.length, 0);
  eq("没有窗口时不推事件(推了界面也收不到)", sent.length, 0);

  // ② 窗口已经销毁。
  setWindow("destroyed");
  resetWindow();
  resetSent();
  threw = null;
  try {
    await focusSession(focusPayload("s_focus"));
  } catch (err) {
    threw = err;
  }
  eq("窗口已销毁时不抛", threw, null);
  eq("已销毁的窗口不该被 show/focus", windowCalls.length, 0);
  eq("已销毁的窗口不推事件", sent.length, 0);

  // ③ 正常窗口:show + focus,顺序不能换。
  setWindow("normal");
  resetWindow();
  resetSent();
  await focusSession(focusPayload("s_focus"));
  same("正常窗口:先 show 再 focus", windowCalls, ["show", "focus"]);
  eq("正常窗口推了一条事件", sent.length, 1);
  eq(
    "推的频道是 notification:focusSession",
    sent[0]?.channel,
    IPC.NOTIFICATION_FOCUS_SESSION,
  );
  eq(
    "载荷里的 sessionId 和入参一致(渲染端靠它跳会话)",
    (sent[0]?.payload as { sessionId?: string })?.sessionId,
    "s_focus",
  );

  // ④ 最小化的窗口:**先 restore 再 show 再 focus**。顺序错了光看"三个都调过"发现不了。
  setWindow("minimized");
  resetWindow();
  resetSent();
  await focusSession(focusPayload("s_min"));
  same("最小化的窗口:restore → show → focus(顺序不能换)", windowCalls, [
    "restore",
    "show",
    "focus",
  ]);
  eq("最小化的窗口也推事件", sent.length, 1);
  eq(
    "推的还是入参那个会话",
    (sent[0]?.payload as { sessionId?: string })?.sessionId,
    "s_min",
  );

  // ⑤ 入参本身:缺 sessionId 要被 schema 挡住(silent 落成一个空字符串的话,渲染端
  //    会去跳一个不存在的会话 —— 看起来就是"点了没反应")。
  let schemaThrew = false;
  try {
    await focusSession({});
  } catch (err) {
    schemaThrew = err instanceof z.ZodError;
  }
  check("缺 sessionId 的入参被 schema 挡住", schemaThrew);
}

/* ──────────────── 7. focus 这条路不该顺手弹通知 ──────────────── */

console.log("\nfocus 只该推事件,不该弹");

{
  setWindow("normal");
  resetSent();
  resetShown();
  await focusSession({ sessionId: "s_quiet" });
  eq("推了事件", sent.length, 1);
  eq("没有弹任何一条系统通知", constructed, 0);
  eq("也没有真的 show 出去", shown.length, 0);
}

/* ──────────────── 8. 用户设完之后,那一刻真的不弹了 ──────────────── */

console.log("\n设完之后这一刻的行为");

{
  // §3 只看了"内存里那个字段是不是 false"。这里再往前走一步:**用户按下开关之后,
  // 同一次运行里,那条通知就不该弹了**。
  //
  // ⚠️ 顺序上有个坑:§5 的 `start()` 把事件观察者挂上了,而 §6 收尾时窗口是
  // "normal"(`isFocused() === false`)—— 前台那条闸门不会挡住它。所以这一步确实
  // 走到了真的 `evaluate` + `showNotification`。
  setWindow("normal");
  resetShown();
  const turnDoneEvt = {
    type: "turn.done",
    sessionId: "s_live",
    reason: "end_turn",
  } as unknown as RuntimeEvent;

  await setPrefs(ALL_OFF);
  eq("五类全关之后:完成不弹", wouldNotify(turnDoneEvt), false);
  eq("一条都没构造出来", constructed, 0);

  // 总开关单独关,其余四个照常 —— 判断照算,只是最后那道 `osEnabled` 闸门不放行。
  await setPrefs({
    osEnabled: false,
    turnComplete: true,
    errors: true,
    blocking: true,
    backgroundTasks: true,
  });
  resetShown();
  eq("只关总开关:完成也不弹", wouldNotify(turnDoneEvt), false);

  // 再打开,应该弹了 —— 这条同时证明上面的"不弹"是偏好起的作用,不是别的东西挡的。
  await setPrefs({
    osEnabled: true,
    turnComplete: true,
    errors: true,
    blocking: true,
    backgroundTasks: true,
  });
  resetShown();
  eq("再打开:又弹了(证明上面是被偏好挡住的)", wouldNotify(turnDoneEvt), true);
}

/* ──────────────── 收尾 ──────────────── */

rmSync(DATA, { recursive: true, force: true });

console.log(`\nnotifications-ipc-smoke:${checks - failures}/${checks} 通过`);
if (failures > 0) process.exit(1);
