/**
 * Headless smoke for **`main/ipc/hooks.ts`** —— 钩子那五条 RPC 的那一层。
 *
 * ## 为什么单独一套(而不是靠 hooks-smoke / hook-exec-smoke / hook-runner-smoke)
 *
 * 那三套覆盖的是**别的文件**:契约里的匹配与格式、`hooks/store.ts` 的落盘、`runCommand`
 * 的真起进程、`HookRunner` 的事件分发。`ipc/hooks.ts` 自己一行都没被走过
 * (`smokes-for.sh src/main/ipc/hooks.ts` 报"没有套件覆盖它")。而它这一层恰恰有一个别处
 * 测不到的性质:**它是这些能力的唯一入口** —— 设置页的每一颗按钮都落在这五个 channel
 * 上,而这一层写错了(漏一截 raw、少包一层 `{ run }`、忘了 parse、少个 await),表现
 * 全是**用户看得见的那行字**不对。
 *
 * ## 这一层实际在做什么(读出来的,不是任务书里写的)
 *
 * 五条 channel,四条真活:
 *
 *  - `hooks.list` / `hooks.runs` **无参**:handler 收到的 raw 是 `undefined`,所以既不能
 *    接 raw 也不能 parse(契约里明写了这条纪律)。
 *  - `hooks.save` / `hooks.remove`:先 `zod.parse(raw)` 再下到 `store`。这一层是**入参
 *    形状**的唯一关口 —— 坏形状在这里就该炸出来,而不是安静地什么都不做。
 *  - `hooks.test`:**真的执行一条命令**,而给的是**还没存下来的那一份**配置。它不写盘、
 *    不进执行记录环。
 *
 * 前面那一层还有 `ipc/index.ts` 的 `createDbGuardedIpc`(每个 handle 先 `awaitDb()`),
 * 但 `registerHookHandlers` 拿到什么就注册什么 —— 这里造一个**记名替身**收下注册进来的
 * 真函数,验的就是被包进去的那函数本身。
 *
 * ## 钉住的那几件事,以及为什么挑它们
 *
 * 1. **坏配置不许静默跳过。** 这是最容易出事、也是用户最难自查的一种:手改的
 *    `hooks.json` 有一行坏了,如果 `hooks.list` 把它悄悄吞掉,用户看到的是一个**空列表**
 *    —— 他会以为"钩子没了 / 我配了但没生效",而真相在 `problems` 里,没送到他面前。
 * 2. **失败信息要立在用户看到的那行字上。** 设置页把 `res.error` 原样红字显示;存的
 *    时候哪一项不对、读的时候第几条不对,都得说得出。
 * 3. **坏东西显式报出来** —— 存不下去的时候要 `{ok:false, error}` 而不是静默成功。
 * 4. **半截状态。** 写到一半失败(临时文件写不进去)时,盘上必须还是**旧的那一份完整
 *    内容**,不能出现半截文件、也不能把旧的那份弄丢。
 * 5. **入口只有这一条。** 设置页看到的配置和"AI / 自动化"看到的是**同一份文件、同一个
 *    执行者**:`hooks.test` 与真事件走同一个 `hookRunner`,验的正是"用户点的"和
 *    "那边调的"没有各写一份。
 * 6. **顺序。** 列表顺序 = 用户看到的顺序 = 谁先跑的顺序;同 id 覆盖不该挪位置。
 *
 * ## 不碰用户的数据
 *
 * 数据根换成 `mktemp -d`(见 `stubs/dataRoot.ts` 那句"没设就抛")。这一套真的写
 * `hooks.json`、真的起子进程(命令是 `node 那个脚本`)。
 *
 * Run: scripts/hooks-ipc-smoke/run.sh
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcMain } from "electron";
import type { HookSpec } from "@contracts/hook";

/* ────────────────────── 骨架 ────────────────────── */

let failures = 0;
let checks = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  checks += 1;
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

/**
 * ⚠️ **空过的守卫。** 这一套里有好几条断言是"某个**字符串里含**某个词"(比如契约给的
 * 那句拒绝理由里要有"匹配规则")。那种断言在**值为空串 / undefined** 时最容易安静地绿或
 * 安静地红 —— 而更坏的一种是:变异脚本静默没生效(`str.replace` 匹配 0 次),整套跑出
 * 一片绿,看起来像"断言不管用",实际什么都没验。
 *
 * 所以凡是"字符串里含某物"的判据都走这里:`undefined` / 空串 / 空白一律先算红。
 */
function mentions(name: string, text: unknown, needle: string): void {
  const ok = typeof text === "string" && text.trim().length > 0 && text.includes(needle);
  check(name, ok, { text, needle });
}

/** 按 channel 调一条 handler;等一个条件成真为止 —— 事件/进程是异步的,
 *  `onEvent` 刻意不 await(见 `HookRunner` 不变量 1),所以判据只能轮询着等。 */
async function until(what: string, cond: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`等不到:${what}`);
}

const DATA = mkdtempSync(join(tmpdir(), "mcode-hooks-ipc-"));
const WORK = mkdtempSync(join(tmpdir(), "mcode-hooks-ipc-work-"));
process.env.MCODE_SMOKE_DATA_ROOT = DATA;

/* ────────────────────── 0. 把真 handler 收下来 ────────────────────── */

/**
 * `ipcMain` 的**记名替身**(抄 `library-delete-smoke` / `library-trash-smoke` 的办法):
 * 这一层的判据整个住在 handler 的函数体里,而它们从来不是导出符号 —— 唯一拿得到的办法
 * 就是调 `registerHookHandlers`,把注册进来的那批函数按 channel 收下来。
 */
const handlers = new Map<string, (event: unknown, raw: unknown) => unknown>();
const fakeIpc = {
  handle(channel: string, listener: (event: unknown, raw: unknown) => unknown): void {
    handlers.set(channel, listener);
  },
} as unknown as IpcMain;

const { IPC } = await import("@contracts/ipc");
const { registerHookHandlers } = await import("@main/ipc/hooks.js");
const { hooksFilePath, readHooks, saveHook } = await import("@main/hooks/store.js");
const { hookRunner } = await import("@main/hooks/HookRunner.js");

registerHookHandlers(fakeIpc);

const FILE = hooksFilePath();

console.log("\n§0 五个 channel 都接上了");

for (const [name, channel] of [
  ["list", IPC.HOOKS_LIST],
  ["runs", IPC.HOOKS_RUNS],
  ["save", IPC.HOOKS_SAVE],
  ["remove", IPC.HOOKS_REMOVE],
  ["test", IPC.HOOKS_TEST],
] as const) {
  check(`hooks.${name} 注册上了`, handlers.has(channel), channel);
}
eq("正好五条(不多推一条不该有的)", handlers.size, 5);

/**
 * 调一条 channel。**默认 raw 是 `undefined`** —— 那正是"无参 invoke"时 Electron 递进来
 * 的东西(契约里明写了这条,`z.object({}).parse(undefined)` 会 invalid_type)。
 */
function call(channel: string, raw?: unknown): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`注册回来里没有 ${channel}`);
  return Promise.resolve(fn(null, raw));
}

/** 盘上现在是什么(解析后的原始形状)。 */
function onDisk(): { version?: unknown; hooks: Array<Record<string, unknown>> } {
  const raw = JSON.parse(readFileSync(FILE, "utf-8")) as {
    version?: unknown;
    hooks?: Array<Record<string, unknown>>;
  };
  return { version: raw.version, hooks: raw.hooks ?? [] };
}

let idSeq = 0;
const h = (over: Partial<HookSpec> & { name?: string } = {}): HookSpec =>
  ({
    id: `h_ipc_${idSeq++}`,
    name: over.name ?? "冒烟",
    event: "tool.use",
    command: "echo ok",
    enabled: true,
    ...over,
  }) as HookSpec;

/* ────────────────────── 1. 坏配置:报出来,不静默跳过 ────────────────────── */

console.log("\n§1 坏配置:显式报出来,不静默跳过");

rmSync(FILE, { force: true });
const empty = (await call(IPC.HOOKS_LIST)) as { hooks: unknown[]; problems: unknown[] };
eq("文件不在 → 一条钩子都没有", empty.hooks.length, 0);
eq("文件不在 → 不算错误(problems 空)", empty.problems.length, 0);

/* 整份不是 JSON —— 用户手改时最容易踩的那一种。 */
writeFileSync(FILE, "{ 这不是 JSON", "utf-8");
const junk = (await call(IPC.HOOKS_LIST)) as {
  hooks: unknown[];
  problems: Array<{ where: string; error: string }>;
};
eq("坏 JSON → 不抛(设置页打得开)", Array.isArray(junk.hooks), true);
eq("坏 JSON → 一条钩子都不跑", junk.hooks.length, 0);
eq("坏 JSON → **一条 problem 报出来**", junk.problems.length, 1);
// 判据立在用户看到的那行字上:设置页顶上那块 warning 显示的就是 `where` 与 `error`,
// 两样都得让人在文件里找得到毛病。
mentions("problem 说清了是哪个文件", junk.problems[0]?.where, "hooks.json");
mentions("problem 说清了是 JSON 的问题", junk.problems[0]?.error, "JSON");

/* 一条坏、两条好 —— 坏的那条要说得出**是第几条**。 */
writeFileSync(
  FILE,
  JSON.stringify({
    version: 1,
    hooks: [h({ id: "h_ok1", name: "好的" }), { nope: 1 }, h({ id: "h_ok2", name: "也是好的" })],
  }),
  "utf-8",
);
const mixed = (await call(IPC.HOOKS_LIST)) as {
  hooks: HookSpec[];
  problems: Array<{ where: string; error: string }>;
};
eq("一条写坏 → 好的两条照常生效", mixed.hooks.length, 2);
eq("一条写坏 → 那条报出来(不是静默丢弃)", mixed.problems.length, 1);
mentions("坏的那条说得清是第几条(用户能在文件里找到它)", mixed.problems[0]?.where, "第 2 条");
check(
  "而且说了是缺什么",
  (mixed.problems[0]?.error.length ?? 0) > 0,
  mixed.problems[0],
);

/* 空命令 / 空名字 —— 界面拦了一道,但**文件是用户手改的**。 */
writeFileSync(
  FILE,
  JSON.stringify({ version: 1, hooks: [{ ...h(), command: "" }] }),
  "utf-8",
);
const emptyCmd = (await call(IPC.HOOKS_LIST)) as { hooks: unknown[]; problems: unknown[] };
eq("手改出来的空命令 → 不跑", emptyCmd.hooks.length, 0);
eq("手改出来的空命令 → 报出来", emptyCmd.problems.length, 1);

/* 复合事件配了 matcher:契约里 `validateHook` 拒,而 readHooks 走的是同一个判据。 */
writeFileSync(
  FILE,
  JSON.stringify({ version: 1, hooks: [{ ...h(), event: "error", matcher: "Edit" }] }),
  "utf-8",
);
const mismatched = (await call(IPC.HOOKS_LIST)) as {
  hooks: unknown[];
  problems: Array<{ error: string }>;
};
eq("不带主语的事件配了 matcher → 不跑", mismatched.hooks.length, 0);
mentions("不带主语的事件配了 matcher:理由说得清要怎么改", mismatched.problems[0]?.error, "匹配规则");

/* ── 存:坏形状要显式拒,并且**不动盘上那份好的** ── */

/**
 * 用户在设置页上**实际看到的那行字**。
 *
 * 设置页的 `save()`(`HooksPanel.tsx`)是这么写的:
 *
 *     try {
 *       const res = await api.hooks.save({ hook: draft });
 *       if (!res.ok) { setSaveError(res.error ?? t("settings.hooks.saveFailed")); return; }
 *       ...
 *     } catch (err) { setSaveError((err as Error).message); }
 *
 * **两种拒绝走两个分支,落在同一个位置上**:
 *  - `store` 层判出来的(`validateHook` / 写盘失败)→ 返回 `{ok:false, error}` → 显示 `res.error`;
 *  - handler 里 `zod.parse` 抛的 → `ipcRenderer.invoke` 拒 → 显示 `err.message`,而
 *    Electron 会在前面加一句 `Error invoking remote method 'hooks:save':`
 *    (这一点在 `main/lib/sessionFork.ts` 的注释里写着,是同一个形状)。
 *
 * 这里照着那两条分支复述一遍。它**不是"共享实现掰成两半"** —— 它是"用户在屏幕上看到
 * 什么"的一份模型,而这一页的判据只有立在那行字上才拦得住"保存失败,给一句看不懂的红字"。
 * 设置页改了显示方式时,这几十行要跟着改。
 */
async function saveAsUser(hook: unknown): Promise<{ ok: boolean; message: string | null }> {
  try {
    const res = (await call(IPC.HOOKS_SAVE, { hook })) as { ok: boolean; error?: string };
    if (res.ok) return { ok: true, message: null };
    return { ok: false, message: res.error ?? "(没有 error —— 面板会显示兜底词条)" };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

/** 这行字读起来像一句给人看的话吗(有中文)。zod 原样吐出来的是英文 + JSON。 */
const looksLikeASentence = (text: string | null): boolean => /[一-龥]/.test(text ?? "");

console.log("\n存不下去的时候");

writeFileSync(FILE, JSON.stringify({ version: 1, hooks: [h({ id: "h_keep", name: "原来的" })] }), "utf-8");

/* ── 第一组:契约层(`HookSpecSchema`)判出来的 ──
 * 这一组 zod 抛在 handler 里。用户**走得到**:超时那一栏的输入框没有下限保护
 * (`onChange` 只挡了 `> 0`,契约的下限是 100),命令那个 textarea 没有 `maxLength`
 * (契约上限 2000)。所以"敲个 50 再按保存"是界面上做得到的一个动作。 */
const saveNarrowTimeout = await saveAsUser(h({ timeoutMs: 50 }));
eq("超时低于契约下限(100):存不下去(不是静默成功)", saveNarrowTimeout.ok, false);
const saveLongCommand = await saveAsUser(h({ command: "x".repeat(2001) }));
eq("命令超过契约上限(2000):存不下去", saveLongCommand.ok, false);
const saveEmptyCmd = await saveAsUser(h({ command: "" }));
eq("空命令:存不下去(不是静默成功)", saveEmptyCmd.ok, false);
const saveEmptyName = await saveAsUser(h({ name: "" }));
eq("空名字:存不下去", saveEmptyName.ok, false);
const saveLongName = await saveAsUser(h({ name: "很长".repeat(40) }));
eq("名字超过契约上限(60):存不下去", saveLongName.ok, false);
// `event` 在契约里是个 enum,所以"多一个空格"这种错**类型系统就拦住了**;这里要验的是
// **运行时**那一道(zod 在 handler 里把任意形状的 raw 判一遍),所以绕开类型。
const saveBadEvent = await saveAsUser({ ...h(), event: "tool.use " });
eq("事件名多一个空格:存不下去(不是被当成另一个事件存下去)", saveBadEvent.ok, false);

/* ⚠️ **现状,不是期望。** 上面这几条拒得对(没有静默跳过),但**理由是一段 zod 的
 * 机器话** —— 真 Electron 里用户在那一行看到的是
 * `Error invoking remote method 'hooks:save': Error: [{"code":"too_small",...}]`。
 * `too_small` / `invalid_enum_value` 是给开发者看的,而这条路是用户清空命令框之后按
 * 保存。修好之后把下面这条改成 `looksLikeASentence(...) === true`(见本套件报告里
 * 那条"没修的问题":同一次拒绝,判在契约层就是 JSON,判在 store 层就是一句中文)。 */
check(
  "⚠️ 现状:契约层拒的时候,给用户的是 zod 的原始 JSON(不是一句中文)",
  !looksLikeASentence(saveEmptyCmd.message) && (saveEmptyCmd.message ?? "").includes("too_small"),
  { message: (saveEmptyCmd.message ?? "").slice(0, 140) },
);

/* ── 第二组:store 层(`validateHook`)判出来的 —— **同一屏上是通顺的中文** ──
 * 同一次"保存一条配错的钩子"的用户动作,换个错法就换了一副面孔,这就是那条问题的形状。 */
const saveMismatched = await saveAsUser(h({ event: "error", matcher: "Edit" }));
eq("不带主语的事件配了 matcher:存不下去", saveMismatched.ok, false);
check(
  "而这一条给的是中文,说得清要怎么改",
  looksLikeASentence(saveMismatched.message) && (saveMismatched.message ?? "").includes("匹配规则"),
  { message: saveMismatched.message },
);

/* 整份形状不对(没给 hook 这个键)—— 用户碰不到,但别让它静默成功。 */
const saveNoHook = await saveAsUser(undefined);
eq("整份形状不对(没给 hook):存不下去", saveNoHook.ok, false);

eq("上面几次失败之后,盘上还是原来那一条", onDisk().hooks.length, 1);
eq("原来那条没被改坏", onDisk().hooks[0]?.name, "原来的");

/* 成功的存档要真的回 `{ok:true}` —— 面板靠它决定显示"已保存"还是那条红字。 */
const savedOk = await saveAsUser(h({ id: "h_fine", name: "没问题的" }));
eq("配得对的存得下去", savedOk.ok, true);
eq("存下去之后盘上有两条", onDisk().hooks.length, 2);
eq("失败过几次也不影响后面存得对", readHooks().problems.length, 0);

/* ── `hooks.remove`:同一条纪律 ── */

/**
 * 删除也和保存一样,有**两条**失败路,而设置页 `remove()` 只把 `catch` 那条显示出来
 * (`await api.hooks.remove(...)` 之后**不看 `res.ok`**),返回的 `{ok:false}` 会被丢掉。
 * 这一层能钉的是"它到底报没报"。
 */
async function removeAsUser(id: unknown): Promise<{ ok: boolean; message: string | null }> {
  try {
    const res = (await call(IPC.HOOKS_REMOVE, { id })) as { ok: boolean; error?: string };
    return { ok: res.ok, message: res.error ?? null };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

let removeEmptyId: unknown = "没抛";
try {
  await call(IPC.HOOKS_REMOVE, { id: "" });
} catch (err) {
  removeEmptyId = (err as Error).message;
}
check("空 id 删除:显式拒(不是「删了个空 id 也算成功」)", removeEmptyId !== "没抛", removeEmptyId);

let removeNoArg: unknown = "没抛";
try {
  await call(IPC.HOOKS_REMOVE);
} catch (err) {
  removeNoArg = (err as Error).message;
}
check("不给参数删除:显式拒", removeNoArg !== "没抛", removeNoArg);

/* 写盘失败的那条路:删除**必须**把它报上去。找不到那条 id 时 `removeHook` 直接返回
 * `{ok:true}`(想要的结局已经在了),所以只有"真要写盘"时才会走到这里 —— 坑还是
 * `hooks.json.tmp` 那个固定名字。 */
rmSync(`${FILE}.tmp`, { recursive: true, force: true });
mkdirSync(`${FILE}.tmp`);
const removeBlocked = await removeAsUser("h_keep");
eq("删的时候写不进去 → 显式报失败(不是静默成功)", removeBlocked.ok, false);
mentions("而且给了原因", removeBlocked.message, "E");
eq("失败之后那条还在盘上(没被「删了一半」)", onDisk().hooks.some((x) => x.id === "h_keep"), true);
rmSync(`${FILE}.tmp`, { recursive: true, force: true });

/* 无参 handler 自己不该 parse —— 契约里明写了 `z.object({}).parse(undefined)` 会炸。 */
let listThrew: unknown = null;
try {
  await call(IPC.HOOKS_LIST);
} catch (err) {
  listThrew = (err as Error).message;
}
eq("hooks.list 不带参数不炸(它不该 parse)", listThrew, null);
let runsThrew: unknown = null;
try {
  await call(IPC.HOOKS_RUNS);
} catch (err) {
  runsThrew = (err as Error).message;
}
eq("hooks.runs 不带参数不炸", runsThrew, null);

/* ────────────────────── 2. 试跑:hooks.test ────────────────────── */

console.log("\n§2 试跑(真的跑一条命令,但不落盘、不进记录环)");

/* 命令写成文件再执行 —— 仓库规矩第 5 条:不写内联 `node -e`。 */
const ECHO = join(WORK, "echo.js");
writeFileSync(
  ECHO,
  [
    `process.stdin.on("data", () => {});`,
    `process.stdin.on("end", () => {`,
    `  console.log("试跑输出 " + process.env.MCODE_EVENT);`,
    `  process.exit(0);`,
    `});`,
  ].join("\n"),
  "utf-8",
);

const beforeDisk = readFileSync(FILE, "utf-8");
const runsBefore = ((await call(IPC.HOOKS_RUNS)) as { runs: unknown[] }).runs.length;

const tested = (await call(IPC.HOOKS_TEST, {
  hook: h({ id: "h_never_saved", name: "还没存的那条", command: `node "${ECHO}"` }),
})) as { run?: { status: string; exitCode?: number; stdout?: string; hookId: string; hookName: string } };
check(
  "试跑给的是 {run:…} 那个外壳(设置页读 res.run,不是直接读结果)",
  tested.run !== undefined,
  tested,
);
eq("试跑跑起来了", tested.run?.status, "ok");
eq("退出码记下来了", tested.run?.exitCode, 0);
check(
  "命令的输出回来了(用户看得出它跑了)",
  (tested.run?.stdout ?? "").includes("试跑输出"),
  tested.run?.stdout,
);
eq("记的是这条还没存下来的钩子", tested.run?.hookId, "h_never_saved");
eq("名字也带上了(记录里能认出是哪条)", tested.run?.hookName, "还没存的那条");

// 试跑"不写盘"是它的契约之一:给的本来就是没存下来的那一份,顺手存下去就等于
// 用户还没按保存,配置先落盘了 —— 而在下一个事件上它就会真的跑起来。
eq("试跑没有把它存下去(盘上一个字没变)", readFileSync(FILE, "utf-8"), beforeDisk);
const runsAfterTest = (await call(IPC.HOOKS_RUNS)) as { runs: Array<{ hookName?: string }> };
check(
  "试跑没进执行记录环(那个环的语义是「真的发生过什么」)",
  !runsAfterTest.runs.some((r) => r.hookName === "还没存的那条"),
  { runs: runsAfterTest.runs.length, before: runsBefore },
);

/* 非零退出、命令不存在、超时 —— 三条失败路各自的样子。 */
const FAIL = join(WORK, "fail.js");
writeFileSync(FAIL, `console.log("before"); process.exit(3);`, "utf-8");
const failed = (await call(IPC.HOOKS_TEST, { hook: h({ command: `node "${FAIL}"` }) })) as {
  run: { status: string; exitCode?: number; error?: string; stdout?: string };
};
eq("非零退出 → failed", failed.run.status, "failed");
eq("退出码记下来了", failed.run.exitCode, 3);
mentions("说了是几号退出码", failed.run.error, "3");
check("挂之前的输出保住了", failed.run.stdout === "before\n", failed.run.stdout);

const missing = (await call(IPC.HOOKS_TEST, {
  hook: h({ command: "mcode-没有这个命令-ipc-smoke" }),
})) as { run: { status: string; error?: string } };
eq("命令不存在 → failed(不是静默 ok)", missing.run.status, "failed");
check("而且给了原因", (missing.run.error?.length ?? 0) > 0, missing.run.error);

const SLEEP = join(WORK, "sleep.js");
writeFileSync(SLEEP, `console.log("卡住之前"); setTimeout(() => {}, 60000);`, "utf-8");
const timedOut = (await call(IPC.HOOKS_TEST, {
  hook: h({ command: `node "${SLEEP}"`, timeoutMs: 700 }),
})) as { run: { status: string; error?: string; stdout?: string } };
eq("挂着不返回 → timeout(不是 failed)", timedOut.run.status, "timeout");
mentions("说了超时多少毫秒", timedOut.run.error, "700");
check(
  "卡住之前打出来的还留着(排错时唯一的现场)",
  timedOut.run.stdout === "卡住之前\n",
  timedOut.run.stdout,
);

/* ── `hooks.test` 的入参也是 zod 过的 ── */
let testBadShape: unknown = "没抛";
try {
  await call(IPC.HOOKS_TEST, { hook: { command: "" } });
} catch (err) {
  testBadShape = (err as Error).message;
}
check("试跑一份形状不对的配置:显式拒(不是拿半份东西去执行)", testBadShape !== "没抛", testBadShape);

// 「试跑」那颗按钮的禁用规则用的是**另一套判据**(`hookDraftProblem`:只看名字/命令非空),
// 它放过了超时越界。所以"超时栏里敲个 50,再按试跑"在界面上是做得到的 —— 那条路
// 一样是 zod 拦下的原始 JSON。这里只钉"它不会拿一份越界的配置去起进程"。
let testBadTimeout: unknown = "没抛";
try {
  await call(IPC.HOOKS_TEST, { hook: h({ timeoutMs: 50 }) });
} catch (err) {
  testBadTimeout = (err as Error).message;
}
check("试跑一份超时越界的配置:显式拒(不会起进程)", testBadTimeout !== "没抛", testBadTimeout);

/* ────────────────────── 3. 全走同一份落盘、同一个执行者 ────────────────────── */

console.log("\n§3 用户点的和那边调的:同一份文件、同一个执行者");

/* 设置页存的,就是自动化 / AI 会读到的那一份 —— 同一个 `hooksFilePath()`,同一个解析。 */
writeFileSync(FILE, JSON.stringify({ version: 1, hooks: [] }), "utf-8");
const saved = (await call(IPC.HOOKS_SAVE, {
  hook: h({ id: "h_shared", name: "界面存的", command: `node "${ECHO}"` }),
})) as { ok: boolean };
eq("存成功", saved.ok, true);
const direct = readHooks();
eq("直接读盘(那边走的就是这条路)看得见它", direct.hooks.length, 1);
eq("内容一致", direct.hooks[0]?.id, "h_shared");
check("文件就在(临时)数据根下", FILE.startsWith(DATA), FILE);

/* 盘上被用户/别的进程改了,`hooks.list` 下一次就该看见 —— 缓存靠 mtime,不该要重启。 */
writeFileSync(
  FILE,
  JSON.stringify({ version: 1, hooks: [h({ id: "h_shared", name: "手改成别的了" })] }),
  "utf-8",
);
const reread = (await call(IPC.HOOKS_LIST)) as { hooks: HookSpec[] };
eq("手改文件之后,列表看到的是新的那一份", reread.hooks[0]?.name, "手改成别的了");

/* ── 端到端:界面上存的那条钩子,真事件来了要跑,而 `hooks.runs` 看得见它 ──
 * 这是这一层唯一能回答的那个问题:「我的钩子到底跑了没有」。前面几套验的是
 * HookRunner / store / runCommand 各自的职责,没有一套从 RPC 这头看到那头。 */
const { initDb } = await import("@main/store/db.js");
const { SessionRepo, ProjectRepo } = await import("@main/store/repositories.js");
const { runtimeManager } = await import("@main/claude/RuntimeManager.js");
/** 桩比真的多两个方法,而 tsc 看到的是**真的**那个类型 —— 从这里转一道手。 */
const rt = runtimeManager as unknown as { emit(e: unknown): void };

await initDb();
const now = Date.now();
ProjectRepo.create({
  id: "p_hooks_ipc",
  name: "钩子 RPC 冒烟",
  path: WORK,
  archived: false,
  group: null,
  sortOrder: 0,
  pinnedAt: null,
  createdAt: now,
  updatedAt: now,
});
const SESSION = "s_hooks_ipc";
SessionRepo.create({
  id: SESSION,
  projectId: "p_hooks_ipc",
  providerId: "claude-sdk",
  claudeSessionId: null,
  kind: "chat",
  parentSessionId: null,
  nodeId: null,
  title: "钩子 RPC 冒烟会话",
  status: "idle",
  model: "",
  effort: "default",
  permissionMode: "default",
  workflowId: "",
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
});

/** 命令跑一次就在这个文件里追加一个字符 —— 数出来的就是"真的跑了几次"。 */
const MARKER = join(WORK, "end-to-end.txt");
const TRIGGER = join(WORK, "trigger.js");
writeFileSync(
  TRIGGER,
  [
    `const fs = require("node:fs");`,
    `let input = "";`,
    `process.stdin.on("data", (c) => { input += c; });`,
    `process.stdin.on("end", () => {`,
    `  fs.appendFileSync(process.argv[2], "x");`,
    `  fs.appendFileSync(process.argv[2] + ".payload", String(process.env.MCODE_EVENT) + "|" + input.length);`,
    `});`,
  ].join("\n"),
  "utf-8",
);
const hits = (): number => (existsSync(MARKER) ? readFileSync(MARKER, "utf-8").length : 0);

const e2e = h({ id: "h_e2e", name: "端到端那条", command: `node "${TRIGGER}" "${MARKER}"` });
writeFileSync(FILE, JSON.stringify({ version: 1, hooks: [e2e] }), "utf-8");
// 先让 `hooks.list` 走一次(界面打开时就会走),确认这条从 RPC 这头看得见。
const listed = (await call(IPC.HOOKS_LIST)) as { hooks: HookSpec[] };
eq("界面上看得见刚存的那条", listed.hooks[0]?.id, "h_e2e");

hookRunner.start();
rt.emit({
  type: "tool.use",
  sessionId: SESSION,
  toolName: "Write",
  toolCallId: "call_e2e",
  input: {},
  requiresApproval: false,
});

await until("真事件把钩子跑起来", () => hits() === 1);
eq("真事件来了,界面上配的那条钩子真的跑了", hits(), 1);

/* ⚠️ 标记文件出现 ≠ 记录已经收口。记录是先以 `status:"running"` 推上去、跑完再原地改的
 * (`HookRunner.runOne` 里那次 `Object.assign`),而子进程退出到 `spawnRun` 把 exit code
 * 收回来之间有一个真实的窗口 —— 设置页此时看到的是「运行中」,那是对的。所以等它收口。 */
type SeenRun = { hookId: string; status: string; sessionId: string; event: string };
const runsAt = async (): Promise<SeenRun[]> =>
  ((await call(IPC.HOOKS_RUNS)) as { runs: SeenRun[] }).runs;
let settled: SeenRun[] = [];
for (let i = 0; i < 400; i++) {
  settled = await runsAt();
  if (settled.some((r) => r.hookId === "h_e2e" && r.status !== "running")) break;
  await new Promise((r) => setTimeout(r, 20));
}
check(
  "`hooks.runs` 看得见这一次,而且收口成了 ok(设置页靠这一条回答「到底跑了没有」)",
  settled.some((r) => r.hookId === "h_e2e" && r.status === "ok"),
  settled,
);
eq("记录里带上了是哪个会话触发的", settled[0]?.sessionId, SESSION);
eq("记录里带上了是哪个事件", settled[0]?.event, "tool.use");
check(
  "命令真的从 stdin 拿到了载荷(不是起个空进程)",
  (readFileSync(`${MARKER}.payload`, "utf-8") || "").startsWith("tool.use|"),
  readFileSync(`${MARKER}.payload`, "utf-8"),
);
// 用户点了「试跑」那颗按钮时走的是**同一个执行者** —— 同一个 `hookRunner`,同一条
// `runHookCommand`。所以试跑跑得出真事件一样的结果(只是不记档)。
const uiTest = (await call(IPC.HOOKS_TEST, { hook: e2e })) as { run: { status: string } };
eq("同一个执行者:试跑也是 ok", uiTest.run.status, "ok");
eq("试跑真的又跑了一次", hits(), 2);

/* ────────────────────── 4. 顺序 ────────────────────── */

console.log("\n§4 顺序 = 设置页里看到的顺序");

writeFileSync(FILE, JSON.stringify({ version: 1, hooks: [] }), "utf-8");
await call(IPC.HOOKS_SAVE, { hook: h({ id: "h_a", name: "第一条" }) });
await call(IPC.HOOKS_SAVE, { hook: h({ id: "h_b", name: "第二条" }) });
await call(IPC.HOOKS_SAVE, { hook: h({ id: "h_c", name: "第三条" }) });
await call(IPC.HOOKS_SAVE, { hook: h({ id: "h_a", name: "改过名的" }) });
const ordered = (await call(IPC.HOOKS_LIST)) as { hooks: HookSpec[] };
eq(
  "新加的排在末尾,覆盖同 id 不挪位置",
  ordered.hooks.map((x) => x.id).join(","),
  "h_a,h_b,h_c",
);
eq("改动生效", ordered.hooks[0]?.name, "改过名的");

/* 同一毫秒里连着存:Runner 那份缓存按 mtimeMs 失效,同一毫秒的第二次写不能把它吞掉。 */
writeFileSync(FILE, JSON.stringify({ version: 1, hooks: [] }), "utf-8");
await call(IPC.HOOKS_SAVE, { hook: h({ id: "h_same1", name: "同一刻第一条" }) });
await call(IPC.HOOKS_SAVE, { hook: h({ id: "h_same2", name: "同一刻第二条" }) });
const backToBack = (await call(IPC.HOOKS_LIST)) as { hooks: HookSpec[] };
eq("同一毫秒里连着存两次,两条都在(不是只留下最后一条)", backToBack.hooks.length, 2);

/* 删:找得到的删得掉;找不到的也算成功(想要的结局已经在了)。 */
const removed = (await call(IPC.HOOKS_REMOVE, { id: "h_same1" })) as { ok: boolean };
eq("删得掉", removed.ok, true);
eq("删完之后剩下那条是 h_same2", onDisk().hooks[0]?.id, "h_same2");
const removedAgain = (await call(IPC.HOOKS_REMOVE, { id: "h_没有这个" })) as { ok: boolean };
eq("删一条不存在的也算成功", removedAgain.ok, true);

/* ────────────────────── 5. 半截状态 ────────────────────── */

console.log("\n§5 写到一半失败:盘上必须还是旧的那一份完整的");

writeFileSync(
  FILE,
  JSON.stringify({ version: 1, hooks: [h({ id: "h_old", name: "盘上原来的" })] }),
  "utf-8",
);
/** 写临时文件那一步失败(把 `hooks.json.tmp` 做成一个目录——它是固定名字)。
 *  这模拟的就是"写盘失败"本身:打开文件失败 / 磁盘满 / 目录权限没了。 */
rmSync(`${FILE}.tmp`, { recursive: true, force: true });
mkdirSync(`${FILE}.tmp`);

const blocked = (await call(IPC.HOOKS_SAVE, {
  hook: h({ id: "h_new", name: "存不进去的那条" }),
})) as { ok: boolean; error?: string };
eq("写不进去 → 显式报失败(不是静默成功)", blocked.ok, false);
check(
  "而且给了原因(不是一句空字符串)",
  (blocked.error?.length ?? 0) > 0,
  blocked.error,
);

const afterFail = readHooks();
eq("失败之后盘上没有多出半截:还是原来那一条", afterFail.hooks.length, 1);
eq("原来那条完好", afterFail.hooks[0]?.id, "h_old");
eq("新来的那条**没有被**写进去", afterFail.hooks.some((x) => x.id === "h_new"), false);
eq("失败的这一次也不算 problem(它是一次的写失败,不是文件坏了)", afterFail.problems.length, 0);

rmSync(`${FILE}.tmp`, { recursive: true, force: true });
const recovered = (await call(IPC.HOOKS_SAVE, { hook: h({ id: "h_new", name: "存得进去的那条" }) })) as {
  ok: boolean;
};
eq("障碍没了之后存得进去(上一次的失败没留下后遗症)", recovered.ok, true);
eq("两条都在了", readHooks().hooks.length, 2);
check("而且没有遗留的临时文件", !existsSync(`${FILE}.tmp`), `${FILE}.tmp`);

/* `hooks.json` 本身坏了(不是 JSON)时保存要能重建 —— 那正是"用户手写崩了"的救法。 */
writeFileSync(FILE, "{ 又坏了", "utf-8");
const rebuild = (await call(IPC.HOOKS_SAVE, { hook: h({ id: "h_fresh", name: "重建" }) })) as {
  ok: boolean;
};
eq("整份坏掉时保存仍然不抛", rebuild.ok, true);
eq("重建出一份干净的", readHooks().hooks.length, 1);
eq("重建的就是刚存的那条", readHooks().hooks[0]?.id, "h_fresh");

/* ────────────────────── 收尾 ────────────────────── */

rmSync(DATA, { recursive: true, force: true });
rmSync(WORK, { recursive: true, force: true });

console.log(`\nhooks-ipc-smoke:${checks - failures}/${checks} 通过`);
process.exit(failures === 0 ? 0 : 1);
