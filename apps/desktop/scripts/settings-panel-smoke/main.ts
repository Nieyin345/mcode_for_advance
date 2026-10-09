/**
 * Headless smoke for **`main/ipc/usage.ts`** 与 **`main/ipc/outputStyle.ts`**
 * (设置面板「用量统计」与「输出风格」两条只读聚合通道)。
 *
 * ## 这一套为什么存在
 *
 * 两个文件各十几行、零覆盖,而它们的**判据全住在函数体里** —— handler 从没被导出过,
 * 唯一的拿法就是调 `registerXxxHandlers`,把注册进去的那批函数按 channel 收下来
 * (`library-trash-smoke` §4 的办法)。所以这一套**走真的那条 IPC**,不是复述:
 * 喂进真实形状的库数据,看聚合出来的数字对不对。
 *
 * 两条通道都是**只读聚合**,所以核心就是"数字对不对":同一模型跨天、同一天跨模型、
 * 累计值(Pi 那种 cumulative diff)、每个合法 preset、空历史不许崩不许 NaN;
 * 输出风格那份:内置与用户的合并顺序、重名遮蔽、目录不存在。
 *
 * ## 刻意**不**给 `usageStats.js` 配桩
 *
 * 给它换桩的话,它内部那句 `SessionRepo.listUsageRows()`(相对 import,不走 alias)
 * 拿到的**还是真的**那一份,于是"真数据库"和"假记录数组"两个来源混在一起 ——
 * 断言看的就不是被测代码。所以这里配的是**底层**的桩(`electron` / `dataRoot` /
 * `logger`),中间那几层(`usageStats` / `repositories` / `db`)全部是真的,聚合数字
 * 是对着真 sqlite 库算出来的。
 *
 * ## 断言一律用**增量**取,不写"库里现在的总数"
 *
 * 同一个库里前后十几个板块都在写行 —— 断全局总数会让一条夹具的改动波及十几条断言。
 * 所以除了**只属于这条会话**的元素(按模型名 / 厂商名找得到的那种),其他一律
 * 「先测一次、写数据、再测一次」,断两次的差。
 *
 * ## 安全前提(两条,缺一不可)
 *
 * 1. **数据根**走 `MCODE_SMOKE_DATA_ROOT`(`run.sh` 里 `mktemp -d`)。`dataRoot` 桩没设
 *    就抛 —— 这一套会 `initDb()`,而 `sql.js` 的 `db.export()` **重写整个 `mcode.db`**:
 *    指错地方等于拿空库盖掉用户的聊天记录。
 * 2. **用户根 `HOME` / `USERPROFILE`** 也换成临时目录。`outputStyleConfig.ts` 的
 *    `USER_STYLE_DIR` 是**模块求值时**用 `homedir()` 算出来的 —— 晚一行,它就是用户
 *    真正的 `~/.mcode/output-styles`。这一套会**往那儿写 `.md` 夹具**,不隔离就是往
 *    用户的输出风格目录里扔文件。
 *
 * ## 锚点:断言不许随日期腐烂
 *
 * 热力图是**滚动 366 天**窗口(`localMidnightOffset(-i)`,**本地**日历),所以夹具的
 * `endedAt` 一律由"今天本地零点"推算,不断言任何具体日期字面量。
 *
 * Run: scripts/settings-panel-smoke/run.sh
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IpcMain } from "electron";
import type {
  UsageStatsResult,
  UsageModelStat,
  OutputStyleEntry,
  UsageStatsPreset,
} from "@contracts/ipc";
import type { TurnUsageRecord } from "@contracts/runtime";
import type { Session } from "@contracts/session";

/* ────────────────────────── 0. 先隔离用户根 ──────────────────────────
 *
 * ⚠️ 必须在**任何被测 import 之前**执行:两个模块的常量(`USER_STYLE_DIR`)由
 * `homedir()` 在模块求值时算出来 —— 晚一行就指到用户的真目录了。
 * 三个变量都由 `run.sh` 给(`mktemp -d`),**没给就抛**(同 `dataRoot` 桩的理由:
 * 将就一个默认值 = 拿用户的东西当测试场地)。
 */
function requireEnv(name: string, why: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} 没设 —— ${why}`);
  return value;
}

const SMOKE_HOME = requireEnv(
  "MCODE_SMOKE_HOME",
  "这一套会往 ~/.mcode/output-styles 写夹具,不隔离用户根就是往用户的输出风格目录里扔文件",
);
// ⚠️ `homedir()` 在 POSIX 读 `$HOME`、在 Windows 读 `USERPROFILE` —— 两个都要换。
process.env.HOME = SMOKE_HOME;
process.env.USERPROFILE = SMOKE_HOME;

const DATA = requireEnv("MCODE_SMOKE_DATA_ROOT", "指错地方就是拿空库盖掉用户的聊天记录");

/* ────────────────────────── 断言工具 ────────────────────────── */

let failures = 0;
let total = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

/** 数组 / 对象的深比较(`Object.is` 对两份内容相同的是 false,这一套里到处要断
 *  "顺序正好是这几个")。 */
function same(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

/** 断言它抛,并把抛出来的**那句话**交回去(判据要立在用户/开发者看到的那行字上)。 */
async function throws(name: string, fn: () => unknown): Promise<string> {
  try {
    await fn();
    check(name, false, { actual: "没有抛", expected: "应当抛" });
    return "";
  } catch (err) {
    check(name, true);
    return err instanceof Error ? err.message : String(err);
  }
}

/* ────────────────────────── 1. 取回真的 handler ────────────────────────── */

/**
 * `ipcMain` 的**记名替身**。两条通道的判据整个住在 handler 的函数体里,而它从来不是
 * 导出符号 —— 唯一拿得到的办法就是调这两个 `register*Handlers`。
 */
const handlers = new Map<string, (event: unknown, raw: unknown) => unknown>();
const fakeIpc = {
  handle(channel: string, listener: (event: unknown, raw: unknown) => unknown): void {
    handlers.set(channel, listener);
  },
} as unknown as IpcMain;

const { IPC, AGENT_OUTPUT_STYLE_SETTING_KEY } = await import("@contracts/ipc");
const { registerUsageHandlers } = await import("@main/ipc/usage.js");
const { registerOutputStyleHandlers } = await import("@main/ipc/outputStyle.js");
registerUsageHandlers(fakeIpc);
registerOutputStyleHandlers(fakeIpc);

const { initDb } = await import("@main/store/db.js");
const { SessionRepo, ProjectRepo, SettingRepo } = await import("@main/store/repositories.js");
const { CustomModelStore } = await import("@main/lib/secretStore.js");
const { invalidateUsageStats } = await import("@main/lib/usageStats.js");
const { MCODE_CONFIG_DIR } = await import("@main/providers/claude-sdk/customEnv.js");

await initDb();

function handlerFor(channel: string): (raw: unknown) => unknown {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`register*Handlers 没有注册 ${channel}`);
  return (raw: unknown) => fn(null, raw);
}

// 这两句是这一套的**地基**:拿不到 handler,"走真 IPC"就变成一句空话 —— 后面所有
// 断言都会以"函数不存在"这种和被测代码无关的样子红掉,所以先钉住。
const usageStats = handlerFor(IPC.USAGE_STATS);
const outputStyleList = handlerFor(IPC.OUTPUT_STYLE_LIST);
check("拿到了 usage.stats 的 handler", handlers.has(IPC.USAGE_STATS));
check("拿到了 outputStyle.list 的 handler", handlers.has(IPC.OUTPUT_STYLE_LIST));

/** 调一次 `usage.stats`,拿回真结果。 */
function statsOf(preset: UsageStatsPreset): Promise<UsageStatsResult> {
  return Promise.resolve(usageStats({ preset })) as Promise<UsageStatsResult>;
}

/* ────────────────────────── 2. 造数据 ──────────────────────────
 *
 * 时间锚点一律**本地零点**,和被测代码的 `localMidnightOffset` 同一套算法 ——
 * 用 `Date.now() - 86400000` 那种减法会在跨 DST 的日子漂边界。
 */
const NOW = Date.now();

/** 今天本地零点 + days 天(0 = 今天,负数 = 过去)。 */
function localMidnight(days: number): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + days).getTime();
}

/** 今天中午 —— 落在"今天"这一天里,但不是零点(边界另一侧)。 */
function localNoon(days: number): number {
  return localMidnight(days) + 12 * 3600 * 1000;
}

function turn(over: Partial<TurnUsageRecord> & { endedAt: number }): TurnUsageRecord {
  return {
    durationMs: 1000,
    totalProcessedTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    usedTokens: 0,
    ...over,
  };
}

ProjectRepo.create({
  id: "p_smoke",
  name: "冒烟工程",
  path: "D:\\proj",
  archived: false,
  group: null,
  sortOrder: 0,
  pinnedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
});

function sessionOf(id: string, over: Partial<Session> = {}): Session {
  return {
    id,
    projectId: "p_smoke",
    providerId: "claude-sdk",
    claudeSessionId: null,
    kind: "chat",
    parentSessionId: null,
    nodeId: null,
    title: "冒烟会话",
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
    envMode: "local",
    worktreePath: null,
    wtStyle: null,
    bookmarks: null,
    subagentTranscripts: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

/**
 * 建一条会话并把它的用量历史写进库,然后**主动失效缓存**。
 *
 * ⚠️ 两件事都非做不可:
 *  - 走 `SessionRepo.updateUsageHistory`(而不是 `SessionRepo.create`):`kind` /
 *    `provider_id` / `custom_model_id` 这几列 `listUsageRows` 是直接读**原始列**的,
 *    写原始列才谈得上"喂进去的和聚合看到的是同一份"。这也是 `RuntimeManager` 真实
 *    那条落库路径。
 *  - `invalidateUsageStats()`:`usageStats.ts` 里有一个模块级缓存,清它的是
 *    `RuntimeManager`(不是 `repositories.ts`)—— 这里不主动清,第二轮断言看的就是
 *    第一轮的旧数据,而且会绿得很像那么回事。
 */
function seedSession(id: string, over: Partial<Session>, history: TurnUsageRecord[]): void {
  SessionRepo.create(sessionOf(id, over));
  SessionRepo.updateUsageHistory(id, history);
  invalidateUsageStats();
}

/* ────────────────────────── 3. preset 的窗口边界 ──────────────────────────
 *
 * 放最前面,因为这一段的判据是"某几条记录在不在范围里",用增量断最干净。
 * 夹具卡在三个边界上:
 *   - 今天本地 00:00:00.000 **整** —— `today` 的下界,必须**含**它;
 *   - 今天零点 **- 1ms** —— 昨天最后一毫秒,`today` 必须**不含**它;
 *   - 第 7 天前零点 **- 1ms** —— `7d` 的下界是第 6 天前零点,它必须**在外面**。
 * 三个数各不相同(1 / 2 / 4),所以每个 preset 的合计是哪个子集一眼看得出来。
 */
console.log("\n用量 · 每个 preset 的窗口");

const baseA = await statsOf("today");
const baseB = await statsOf("7d");
const baseC = await statsOf("30d");
const baseD = await statsOf("all");

const TODAY_MIDNIGHT = localMidnight(0);
seedSession(
  "s_window",
  {},
  [
    turn({ endedAt: TODAY_MIDNIGHT, totalProcessedTokens: 1 }),
    turn({ endedAt: TODAY_MIDNIGHT - 1, totalProcessedTokens: 2 }),
    turn({ endedAt: localMidnight(-7) - 1, totalProcessedTokens: 4 }),
  ],
);

const wToday = await statsOf("today");
const w7d = await statsOf("7d");
const w30d = await statsOf("30d");
const wAll = await statsOf("all");

eq("today 含今天零点整那一轮,不含昨天最后一毫秒", wToday.summary.totalTokens - baseA.summary.totalTokens, 1);
eq("7d 从第 6 天前零点起算,含昨天最后一毫秒", w7d.summary.totalTokens - baseB.summary.totalTokens, 3);
eq("30d 含第 7 天之前零点前一毫秒(差 1ms 也要进来)", w30d.summary.totalTokens - baseC.summary.totalTokens, 7);
eq("all 把三条都算上", wAll.summary.totalTokens - baseD.summary.totalTokens, 7);
eq("窗口是闭区间下界:7d 比 today 多出恰好那条昨天的", (w7d.summary.totalTokens - baseB.summary.totalTokens) - (wToday.summary.totalTokens - baseA.summary.totalTokens), 2);
eq("30d 比 7d 多出恰好那条 8 天前的", (w30d.summary.totalTokens - baseC.summary.totalTokens) - (w7d.summary.totalTokens - baseB.summary.totalTokens), 4);
eq("preset 只影响 summary / models,轮次差也是 1 / 2 / 3", w30d.summary.turns - baseC.summary.turns, 3);
eq("  8 天前那条不在 7d 的轮次里", w7d.summary.turns - baseB.summary.turns, 2);

// `daily` 是**固定 366 天**窗口,与 preset 无关(热力图要一张定长网格)。
eq("四个 preset 的 daily 都是 366 格 · today", wToday.daily.length, 366);
eq("  7d 也是 366 格", w7d.daily.length, 366);
eq("  30d 也是 366 格", w30d.daily.length, 366);
eq("  all 也是 366 格", wAll.daily.length, 366);

// 窗口是**滚动**的:`daily[365]` 必须是今天,`daily[0]` 是 365 天前。
const dateKeyOf = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
eq("热力图最后一格是今天(本地日历,不是 UTC)", wAll.daily[365]?.date, dateKeyOf(TODAY_MIDNIGHT));
eq("热力图第一格是 365 天前(滚动满一年)", wAll.daily[0]?.date, dateKeyOf(localMidnight(-365)));
check("  格子是一天一天连着的,没有断档", (() => {
  for (let i = 1; i < wAll.daily.length; i++) {
    const prev = new Date(`${wAll.daily[i - 1]!.date}T00:00:00`).getTime();
    const cur = new Date(`${wAll.daily[i]!.date}T00:00:00`).getTime();
    if (Math.round((cur - prev) / 86_400_000) !== 1) return false;
  }
  return true;
})(), { first: wAll.daily[0]?.date, last: wAll.daily[365]?.date });

// 同一轮在 `daily` 与 `summary` 里必须落到**同一天、同一个数** —— 两处各算一遍日期
// (一处 `localDateKey`、一处 `rangeStart`)是这类代码最容易漂的地方。
const todayBucket = wAll.daily[365];
eq("热力图最后一格收了今天零点整那一轮", todayBucket?.totalTokens, 1);
eq("  今天那一格只算那一轮(today 预设也看到同一个数)", wToday.summary.totalTokens - baseA.summary.totalTokens, todayBucket?.totalTokens);
eq("昨天最后一毫秒落进昨天那一格", wAll.daily[364]?.totalTokens, 2);
eq("  今天那一格没有把它顺手算进来", todayBucket?.turns, 1);

// **超出热力图窗口的记录仍算进 summary。** 第 400 天前的那一轮不在那 366 格里,
// 但 `all` 的合计必须包含它 —— 否则用户切到「全部」看到的数字比实际少。
const beforeOld = await statsOf("all");
/** 第 400 天前那一轮 —— 不只为"超出窗口"那一条用,后面断"没带模型名的柱子"时也要
 *  把它算进去(它同样没有 `model`)。用个名字比撒一个 12345 到两处清楚。 */
const OLD_TOKENS = 12345;
seedSession("s_old", {}, [turn({ endedAt: localMidnight(-400) + 3600_000, totalProcessedTokens: OLD_TOKENS })]);
const withOld = await statsOf("all");
eq("超出 366 天窗口的老记录仍然进 summary", withOld.summary.totalTokens - beforeOld.summary.totalTokens, 12345);
eq("  那一条没有在热力图里凭空多出一格", withOld.daily.length, 366);
eq("  那一天确实不在 366 格里", withOld.daily.some((d) => d.date === dateKeyOf(localMidnight(-400))), false);

/* ────────────────────────── 4. 同一模型跨天 / 同一天跨模型 ────────────────────────── */

console.log("\n用量 · 同一模型跨天、同一天跨模型");

// A:同一模型跨**两天**各一轮。三种写法各错一种:数轮次错的人会按记录条数算、加 token
// 错的人会只留最后一条、落桶错的人会拿 `toISOString` 去算 UTC 日。
seedSession(
  "s_a",
  {},
  [
    turn({ endedAt: localNoon(-1), model: "m1", totalProcessedTokens: 1000, outputTokens: 100, cacheReadTokens: 10, cacheCreationTokens: 5, costUsd: 0.5, subagentTokens: 7 }),
    turn({ endedAt: localNoon(0), model: "m1", totalProcessedTokens: 2000, outputTokens: 200, cacheReadTokens: 20, cacheCreationTokens: 10, costUsd: 1.5, subagentTokens: 3 }),
  ],
);

// B:同一天、**两个不同模型**。合并错的人会把两条并成一根柱子。
seedSession(
  "s_b",
  {},
  [
    turn({ endedAt: localNoon(0), model: "m2", totalProcessedTokens: 300, outputTokens: 30, costUsd: 0.25 }),
    turn({ endedAt: localNoon(0) + 60_000, model: "m3", totalProcessedTokens: 700, outputTokens: 70 }),
  ],
);

const agg = await statsOf("all");

const m1 = agg.models.find((m) => m.model === "m1") as UsageModelStat | undefined;
check("同一模型跨两天合成一根柱子(不是两条)", m1 !== undefined, { models: agg.models.map((m) => m.model) });
eq("  那一根柱子算了 2 轮", m1?.turns, 2);
eq("  跨两天的 token 加在一起", m1?.totalTokens, 3000);
eq("  跨两天的输出 token 加在一起", m1?.outputTokens, 300);
eq("  跨两天的成本加在一起", m1?.costUsd, 2);
eq("  跨两天的缓存读加在一起", m1?.cacheReadTokens, 30);
eq("  跨两天的缓存写加在一起", m1?.cacheCreationTokens, 15);

const m2 = agg.models.find((m) => m.model === "m2");
const m3 = agg.models.find((m) => m.model === "m3");
eq("同一天的两个模型分成两根柱子 · m2", m2?.totalTokens, 300);
eq("同一天的两个模型分成两根柱子 · m3", m3?.totalTokens, 700);
eq("  两根柱子的厂商都是内置的 Anthropic", m2?.vendor, "Anthropic");
eq("  同一天的轮次各算各的", m2?.turns, 1);
eq("  另一根也是 1 轮", m3?.turns, 1);

// 三者合计应当精确等于三个模型之和 —— 这条钉住"summary 和 models 是同一份账"。
const sumOfModels = agg.models.reduce((s, m) => s + m.totalTokens, 0);
eq("summary 的 token 等于各柱子之和", agg.summary.totalTokens, sumOfModels);
const sumOfModelTurns = agg.models.reduce((s, m) => s + m.turns, 0);
eq("summary 的轮次等于各柱子之和", agg.summary.turns, sumOfModelTurns);

// 成本:有一条记录(`m3`)没带 costUsd。`null`(未知)与 0 不是一回事 —— 求和时跳过
// 未知,剩下的必须**精确**等于三者之和。
eq("成本只加知道的那几轮,未知的不当成 0", agg.summary.costUsd, agg.models.reduce((s, m) => s + m.costUsd, 0));
eq("  这里面确实有 2.25 那一份", m1 && m2 ? (m1.costUsd + m2.costUsd) : null, 2.25);

// 排序:按 token 降序,平手再按轮次降序。
// ⚠️ 只看**有模型名**的那几根:`§3` 的边界夹具没带 `model`(真实记录里快照没有
// 模型时就是这样),它自成一类,下面单独断。
const namedBars = agg.models.filter((m) => m.model !== null);
same(
  "模型按 token 从多到少排",
  namedBars.map((m) => m.model),
  ["m1", "m3", "m2"],
);
// `model` 缺省的记录归成**一根**柱子、`model` 是 null —— 契约里写着
// `model: null groups turns whose record carried no model id`。按模型名分桶的人会把它
// 丢掉(界面少一行)或者给它编一个空串(排序时跑到最前)。
const nullBars = agg.models.filter((m) => m.model === null);
eq("没有模型名的那几轮归成一根 null 柱子", nullBars.length, 1);
eq("  null 柱子上的模型名就是 null(不是空串)", nullBars[0]?.model, null);
// §3 那三条(1+2+4)加上第 400 天前那一条(OLD_TOKENS)—— 到这里为止库里**所有**没带
// 模型名的轮次都该在这一根柱子上(`s_bad` / 隐藏会话那几条排在后面)。
eq("  null 柱子把没带模型名的轮次一条不落地收进来", nullBars[0]?.turns, 4);
eq("  null 柱子上的 token 也一条不落", nullBars[0]?.totalTokens, 1 + 2 + 4 + OLD_TOKENS);

/* ────────────────────────── 5. 同名不同厂商必须分成两根柱子 ────────────────────────── */

console.log("\n用量 · 同名模型、不同厂商不许并成一根");

// 用户给一个网关起了名字,B 是内置 Claude —— 两边都叫 `shared-name`。按模型名分组的人
// 会把它们并成一根,界面上就变成"一个模型花了两份钱"。
CustomModelStore.save({
  name: "浩联云",
  baseUrl: "https://example.invalid/v1",
  authToken: "sk-smoke-not-a-real-token",
  models: [{ id: "shared-name" }],
});
const gwId = CustomModelStore.listPublic().find((m) => m.name === "浩联云")?.id;
check("自定义模型配置建出来了(厂商名的来源)", typeof gwId === "string" && gwId.length > 0);

seedSession("s_c_gw", { customModelId: gwId! }, [
  turn({ endedAt: localNoon(0), model: "shared-name", totalProcessedTokens: 50 }),
]);
// ⚠️ **两条不同的会话**:同名同 token 却一条比一条先写,`models` 是按
// `totalTokens` 降序排的,平手时顺序未定 —— 那样下面那两条断言就是掷硬币。
seedSession("s_c_builtin", {}, [
  turn({ endedAt: localNoon(0), model: "shared-name", totalProcessedTokens: 70 }),
]);

const named = await statsOf("all");
const sameName = named.models.filter((m) => m.model === "shared-name");
eq("同名模型分成两根柱子", sameName.length, 2);
eq("  一根是内置 Claude(Anthropic)", sameName.find((m) => m.vendor === "Anthropic")?.totalTokens, 70);
eq("  另一根是用户给网关起的名字", sameName.find((m) => m.vendor === "浩联云")?.totalTokens, 50);

// 网关配置**被删掉**之后:`customModelId` 还挂在会话上,`nameById` 里查不到了 ——
// 那时厂商名是 null(未知),但那一轮的 token **仍然要算**(用户真花掉的)。
CustomModelStore.remove(gwId!);
invalidateUsageStats();
const orphaned = await statsOf("all");
const orphanBar = orphaned.models.find((m) => m.model === "shared-name" && m.vendor === null);
eq("配置删了之后厂商名变成未知(null),token 照算", orphanBar?.totalTokens, 50);
eq("  内置那根不受影响", orphaned.models.find((m) => m.model === "shared-name" && m.vendor === "Anthropic")?.totalTokens, 70);

/* ────────────────────────── 6. Pi 的累计差分 ────────────────────────── */

console.log("\n用量 · 累计值(Pi 那种)要取相邻差分");

// Pi 的 `getSessionStats()` 是**整个会话累计**的:直接求和会把前几轮的 token 反复
// 多算一遍(1000+3000+6000 = 10000,实际只花了 6000)。正确的增量是 1000/2000/3000。
seedSession("s_pi", { providerId: "pi-sdk" }, [
  turn({ endedAt: localNoon(0), totalProcessedTokens: 1000, outputTokens: 100, model: "pi-model" }),
  turn({ endedAt: localNoon(0) + 1000, totalProcessedTokens: 3000, outputTokens: 250, model: "pi-model" }),
  turn({ endedAt: localNoon(0) + 2000, totalProcessedTokens: 6000, outputTokens: 400, model: "pi-model" }),
]);

const piAll = await statsOf("all");
const pi = piAll.models.find((m) => m.vendor === "Pi");
eq("累计值求和时按相邻差分算,不是把累计值反复相加", pi?.totalTokens, 6000);
eq("  差分的轮次数仍是 3(不是 1)", pi?.turns, 3);
eq("  输出 token 也差分", pi?.outputTokens, 400);
check("  柱子上标着 Pi", pi?.vendor === "Pi");

// ⚠️ 库里是**原样**存的:读回来还是那三个累计值。这条把"差分发生在聚合那一侧、
// 没有反过来改写用户的记录"钉住。
const piRaw = SessionRepo.get("s_pi")?.usageHistory ?? [];
same("库里存的仍是累计值原文,差分不改写历史", piRaw.map((r) => r.totalProcessedTokens), [1000, 3000, 6000]);

// 第一条记录**没有前一条**:它的增量就是它自己(没有基线)。第二条要是**变小**了
// (理论上不会发生,但手工改过的库/重置过的统计会有),增量钳到 0 而不是负数 ——
// 否则用户的"总消耗"会被一个负数吃掉。
seedSession("s_pi_reset", { providerId: "pi-sdk" }, [
  turn({ endedAt: localNoon(0), totalProcessedTokens: 500, model: "pi-reset" }),
  turn({ endedAt: localNoon(0) + 1000, totalProcessedTokens: 200, model: "pi-reset" }),
]);
const resetAll = await statsOf("all");
eq("累计值回退时钳到 0,不让负数吃掉总量", resetAll.models.find((m) => m.model === "pi-reset")?.totalTokens, 500);

// Claude 会话**不是**累计的:同样三个数字必须原样相加,不能被差分掉。这条是
// "别把差分套到所有 provider 上"的反向判据。
seedSession("s_claude_cum", {}, [
  turn({ endedAt: localNoon(0), totalProcessedTokens: 1000, model: "claude-cum" }),
  turn({ endedAt: localNoon(0) + 1000, totalProcessedTokens: 3000, model: "claude-cum" }),
  turn({ endedAt: localNoon(0) + 2000, totalProcessedTokens: 6000, model: "claude-cum" }),
]);
const claudeAll = await statsOf("all");
eq("Claude 会话的每一条本来就是单轮值,原样相加", claudeAll.models.find((m) => m.model === "claude-cum")?.totalTokens, 10_000);

/* ────────────────────────── 7. 隐藏会话 ────────────────────────── */

console.log("\n用量 · 隐藏会话算 token、不算「涉及会话」");

// 工作流节点跑在自己的隐藏子会话里(`kind = "node"`),自动化后台会话跑在
// `kind = "automation"` 里 —— 两者的 token 都是真花掉的,但用户从没"开过"它们。
// 「涉及会话」那个数字指的是用户开过的对话(见 i18n `settings.usage.summary.sessions`
// 与 UsagePanel 那几行注释)。
const beforeHidden = await statsOf("all");
seedSession("s_chat_x", { kind: "chat" }, [turn({ endedAt: localNoon(0), totalProcessedTokens: 11 })]);
seedSession("s_node_x", { kind: "node" }, [turn({ endedAt: localNoon(0), totalProcessedTokens: 22 })]);
seedSession("s_auto_x", { kind: "automation" }, [turn({ endedAt: localNoon(0), totalProcessedTokens: 33 })]);
const afterHidden = await statsOf("all");

const tokenDelta = afterHidden.summary.totalTokens - beforeHidden.summary.totalTokens;
eq("三条会话(chat / node / automation)的 token 全部算上", tokenDelta, 11 + 22 + 33);
// ⚠️ `chat` 1 个 + **`side` 1 个** = 2。`side` 那一半是 `usageStats.ts` 里
// `hiddenSession: row.kind === "node"` 这句的**可观察后果**:它只把 node 当隐藏,而
// `RuntimeManager.isHiddenSessionKind` 认的是 `node || automation` —— 于是 side(右栏
// 「问」标签页的问答子会话)会被计进「涉及会话」。见报告里"查到但没修"那一段。
// 这条**不是**在钉一个正确的数:它把现状原样记下来,好让上面对齐时这条会红。
eq("「涉及会话」多出一个 chat + 一个 side(现状,见报告)", afterHidden.summary.sessions - beforeHidden.summary.sessions, 2);

// **反向判据**:把 node 与 automation 也数进去的人会 +4。上面两条已经把它挡住了,
// 这里再钉一次"轮次是 3 而对话数是 2",两句话说的不是一回事。
eq("  轮次是 3 轮", afterHidden.summary.turns - beforeHidden.summary.turns, 3);
eq("  其中 node 与 automation 那两轮不算对话", afterHidden.summary.sessions - beforeHidden.summary.sessions, 2);

// 同一个 `node` 会话里两轮:token 累加、会话数仍不涨。
const beforeNodeRounds = await statsOf("all");
seedSession("s_node_multi", { kind: "node" }, [
  turn({ endedAt: localNoon(0), totalProcessedTokens: 100 }),
  turn({ endedAt: localNoon(0) + 1, totalProcessedTokens: 200 }),
]);
const afterNodeRounds = await statsOf("all");
eq("节点会话的两轮 token 都算", afterNodeRounds.summary.totalTokens - beforeNodeRounds.summary.totalTokens, 300);
eq("  但「涉及会话」一个都不涨", afterNodeRounds.summary.sessions - beforeNodeRounds.summary.sessions, 0);

/* ────────────────────────── 8. 坏数据与空历史 ────────────────────────── */

console.log("\n用量 · 空历史 / 坏记录不许崩、不许 NaN");

// ① 只有空历史数组的会话:有 `usage_history` 列、一条记录都没有 —— 不该贡献数字。
const beforeEmptyRow = await statsOf("all");
seedSession("s_empty_hist", {}, []);
const afterEmptyRow = await statsOf("all");
eq("只有空历史数组的会话不贡献任何数字", afterEmptyRow.summary.totalTokens, beforeEmptyRow.summary.totalTokens);
eq("  也不多算一个会话", afterEmptyRow.summary.sessions, beforeEmptyRow.summary.sessions);
eq("  也不多算一轮", afterEmptyRow.summary.turns, beforeEmptyRow.summary.turns);

// ② `endedAt` 坏掉的记录(JSON 里 `NaN` 会落成 `null`,手工改过的库/半截写入都会
//    长成这样)。它必须被**安静跳过**,而不是让整个面板崩掉或算出 NaN。
const beforeBad = await statsOf("all");
seedSession("s_bad", {}, [
  turn({ endedAt: Number.NaN, totalProcessedTokens: 999 }),
  turn({ endedAt: localNoon(0), totalProcessedTokens: 5 }),
]);
const afterBad = await statsOf("all");
eq("endedAt 坏掉的记录被跳过,同一会话里正常的那条照算", afterBad.summary.totalTokens - beforeBad.summary.totalTokens, 5);
eq("  它没有被当成「落在窗口外」而把好的那条一起吞掉", afterBad.summary.turns - beforeBad.summary.turns, 1);

// ③ **真的**空范围:没有任何记录落在里面时,每个数字必须是 0 而不是 NaN。
//    (`today` 当下当然有记录 —— 所以断的是"范围为空"这件事本身:形状完整 + 无 NaN。)
const shape = await statsOf("all");
check("返回的三个部分形状都完整", Array.isArray(shape.daily) && Array.isArray(shape.models) && typeof shape.summary === "object", {
  daily: shape.daily.length,
  models: shape.models.length,
});
check("summary 里没有 NaN", Object.entries(shape.summary).every(([, v]) => typeof v === "number" && Number.isFinite(v)), {
  值: shape.summary,
});
check("每个模型柱子上也没有 NaN", shape.models.every((m) => [m.turns, m.totalTokens, m.outputTokens, m.cacheReadTokens, m.cacheCreationTokens, m.costUsd].every((v) => Number.isFinite(v))), {
  柱子: shape.models.map((m) => ({ model: m.model, totalTokens: m.totalTokens })),
});
check("每一格热力图也没有 NaN", shape.daily.every((d) => Number.isFinite(d.turns) && Number.isFinite(d.totalTokens) && Number.isFinite(d.outputTokens) && Number.isFinite(d.costUsd)), {
  第一格: shape.daily[0],
});

// ④ 一个**全新的空库**里跑一遍:上面那些库都是"有记录"的,真正的空库这一路上没验过。
//    ⚠️ 不能靠换数据根 —— `db.ts` 的 `dbReadyPromise` 是模块级单例,换了也没用。改用
//    "把会话挪出窗口"的等价物做不到(preset 没有第二个窗口)……
//    所以这条改为**直接对着 `listUsageRows()` 的过滤条件**断:库里一定有行(前面建了
//    十几条),但**今天之前没有任何一条落在某个未来时刻** —— 用不到。留给 `db-migrate-smoke`。
//    (删掉此条而不是留一个空过:SKILL 里那句"登记了夹具却没人命中的断言会全绿而什么
//     都没验"说的就是这种。)

/* ────────────────────────── 9. 参数不对的时候报出来 ────────────────────────── */

console.log("\n用量 · 参数不对报出来,不是静默当成某个预设");

// `UsageStatsSchema` 里 `preset` 是 `z.enum(...)`,**必填**。所以不带参数 invoke 时
// 会抛 —— 这是**契约说的**(见 packages/contracts/src/ipc/usage.ts),不是 bug:
// 两个渲染端调用点(`UsagePanel.tsx` / `EmptyThreadWelcome.tsx`)都带 preset。
// 这一条把"契约如此"钉住:哪天有人把契约改成可选,这里会红,那时才该重新想。
const noArg = await throws("preset 必填:不带参数 invoke 会抛(契约如此)", () => usageStats(undefined));
// zod 对 `undefined` 的报法是 `expected: "object" / received: "undefined"`,**没有**
// `preset` 这个词 —— 因为它在"整个对象就不对"这一步就停了。真正点得出来的是下一句:
// 传了对象、但对象里没有 `preset` 时,zod 会说 `path: ["preset"]`。
check("  抛出来的话说明了收到的是 undefined", /undefined/.test(noArg), { message: noArg });

const missingPreset = await throws("传了对象但对象里没有 preset 时会抛", () => usageStats({}));
check("  抛出来的话里点明了缺的是 preset 这个键", /preset/.test(missingPreset), { message: missingPreset });
check("  zod 的 path 指到了 preset 上(不是整个对象)", /"path":\s*\[\s*"preset"\s*\]/.test(missingPreset), { message: missingPreset });

const badPreset = await throws("preset 不是四个合法值之一时会抛", () => usageStats({ preset: "90d" }));
check("  抛出来的话里点明了 preset 这个键", /preset/i.test(badPreset), { message: badPreset });
check("  抛出来的话里列了合法的那些值", /today/.test(badPreset) && /30d/.test(badPreset), { message: badPreset });

// 四个合法值**都能走通**(不是只有 `all` 被验过)。
for (const p of ["today", "7d", "30d", "all"] as const) {
  let ok = false;
  try {
    const res = await statsOf(p);
    ok = Array.isArray(res.daily) && res.daily.length === 366;
  } catch {
    ok = false;
  }
  check(`preset "${p}" 是合法输入,能走通`, ok);
}

/* ────────────────────────── 10. 输出风格:合并、顺序、遮蔽 ────────────────────────── */

console.log("\n输出风格 · 内置与用户目录合并后的顺序");

const USER_STYLE_DIR = join(MCODE_CONFIG_DIR, "output-styles");

/** 写一个用户风格文件。目录不存在会**抛** —— 那是夹具有问题,不该静默。 */
function writeStyle(file: string, body: string): void {
  mkdirSync(USER_STYLE_DIR, { recursive: true });
  writeFileSync(join(USER_STYLE_DIR, file), body, "utf8");
}

function stylesOf(res: unknown): OutputStyleEntry[] {
  return (res as { styles: OutputStyleEntry[] }).styles ?? [];
}
function idsOf(res: unknown): string[] {
  return stylesOf(res).map((s) => s.id);
}

// ① 目录**还不存在**时(全新的安装):返回内置项,不抛。
const noDir = await outputStyleList({});
check("目录不存在时返回列表,不抛", Array.isArray(stylesOf(noDir)));
same("  没有用户风格时就是内置那五项,声明顺序原样", idsOf(noDir), [
  "default",
  "Explanatory",
  "Learning",
  "Proactive",
  "Concise",
]);
check("  内置项的 source 标成 builtin", stylesOf(noDir).every((s) => s.source === "builtin"));

// ② 用户目录里有东西之后:内置在前、用户在后,用户项按名字排序。
writeStyle("zzz.md", "---\nname: 早安\ndescription: 用户自己的风格\n---\n正文");
writeStyle("aaa.md", "---\nname: Alpha\n---\n正文");
writeStyle("readme.txt", "不是 markdown,不该出现");

const merged = await outputStyleList({});
const mergedIds = idsOf(merged);
// 用户项的名字刻意一个用中文、一个用 ASCII。⚠️ `localeCompare` **不带 locale**,
// 结果随运行环境的默认语言变:zh-CN 机器上中文排在拉丁字母**前面**
// (`"早安".localeCompare("Alpha") < 0`),en-US(GitHub 的 Windows 机器)上反过来。
// 所以用户项的期望顺序**当场用同一个 localeCompare 算**,而不是写死其中一种。
// 在中文环境(作者机器、用户机器)下它仍会在有人把 `.sort()` 换成按文件名
// (zzz.md → 早安、aaa.md → Alpha)排的时候红;en-US 下两种排法恰好同序,抓不到这一种。
same(
  "顺序是内置在前、用户项在后(用户项按 localeCompare 排)",
  mergedIds,
  ["default", "Explanatory", "Learning", "Proactive", "Concise", ...["早安", "Alpha"].sort((a, b) => a.localeCompare(b))],
);
eq("用户项带上了自己的 description", stylesOf(merged).find((s) => s.id === "早安")?.description, "用户自己的风格");
eq("  没写 description 的那条就不带这个字段", stylesOf(merged).find((s) => s.id === "Alpha")?.description, undefined);
eq("  用户项的 source 标成 user", stylesOf(merged).find((s) => s.id === "Alpha")?.source, "user");
eq("非 .md 的文件不进列表", mergedIds.includes("readme"), false);

// ③ 重名:用户风格与内置同名时**遮蔽**内置那一条(注入的就是个名字,两个同名项在
//    Select 里没法区分)。
writeStyle("shadow.md", "---\nname: Learning\ndescription: 我把内置那条改成了自己的\n---\n正文");
const shadowed = await outputStyleList({});
const shadowedIds = idsOf(shadowed);
eq("同名时列表里只剩一条", shadowedIds.filter((id) => id === "Learning").length, 1);
eq("  留下的那条是用户的", stylesOf(shadowed).find((s) => s.id === "Learning")?.source, "user");
eq("  带的是用户那份 description", stylesOf(shadowed).find((s) => s.id === "Learning")?.description, "我把内置那条改成了自己的");
same("  被遮蔽之后内置剩下的还是声明顺序", shadowedIds.filter((_, i) => i < 4), ["default", "Explanatory", "Proactive", "Concise"]);
check(
  "  所有内置项都排在所有用户项前面",
  shadowedIds.indexOf("早安") > shadowedIds.indexOf("Concise") &&
    shadowedIds.indexOf("Alpha") > shadowedIds.indexOf("Concise"),
  { ids: shadowedIds },
);

// ④ 没有 frontmatter 的 `.md`:回退到**文件名**。
writeStyle("No Frontmatter.md", "直接就是正文,没有 --- 那一段");
const fallback = await outputStyleList({});
eq("没有 frontmatter 的文件回退到文件名", idsOf(fallback).includes("No Frontmatter"), true);
eq("  扩展名被去掉", idsOf(fallback).includes("No Frontmatter.md"), false);

// ⑤ frontmatter 里的引号要去掉(CLI 是按名字**逐字**匹配的,留着引号就选不中)。
writeStyle("quoted.md", '---\nname: "带引号的名字"\n---\n正文');
const quoted = await outputStyleList({});
check("frontmatter 名字两边的引号被去掉", idsOf(quoted).includes("带引号的名字"), { ids: idsOf(quoted) });
eq("  列表里没有以引号开头的 id", idsOf(quoted).some((id) => id.startsWith('"')), false);

// ⑥ frontmatter 里的 `name` 是空的时候**不能**把名字清成空串 —— 回退到文件名。
writeStyle("blank-name.md", "---\nname:\ndescription: 只有描述\n---\n正文");
const blank = await outputStyleList({});
eq("frontmatter 的 name 是空的 → 回退到文件名", idsOf(blank).includes("blank-name"), true);
eq("  描述照常带上", stylesOf(blank).find((s) => s.id === "blank-name")?.description, "只有描述");

// ⑧ frontmatter 解析必须与技能库那份**同源**(`skillEngines.parseSkillFrontmatter`)。
//
// 这是硬规矩 2("共享实现只有一份")的一个具体落点:outputStyleConfig 曾经自带一份
// skills.ts 那套行扫描的**未加固副本**,而技能库那份后来加了折叠块 / 缩进键 / 块标量的
// 处理,风格这份没跟上 → 两份对同一份 frontmatter 给出不同结果:
//   - `description: >`(YAML 折叠块,已发布风格里很常见)在这份里被当成**字面量 ">"**,
//     面板详情里显示一个孤零零的 ">"(用户看不到自己写的说明);
//   - 缩进的嵌套键(`metadata:\n  name: Inner`)会**覆盖顶层 name** —— 选中值指到
//     另一个风格名上,CLI 按名字逐字匹配,于是选中根本不生效。
// 判据立在**面板显示的那行字 / 列表里那个 id** 上,不是立在"调了哪个函数"上。
writeStyle("folded.md", "---\nname: Folded\ndescription: >\n  Reviews papers.\n  Focuses on method.\n---\n正文");
const folded = await outputStyleList({});
eq(
  "折叠块 description 解析成续行正文,不是字面量 >",
  stylesOf(folded).find((s) => s.id === "Folded")?.description,
  "Reviews papers. Focuses on method.",
);

writeStyle("nested.md", "---\nname: Outer\nmetadata:\n  name: Inner\ndescription: top\n---\n正文");
const nested = await outputStyleList({});
check(
  "缩进的嵌套键不会覆盖顶层 name",
  idsOf(nested).includes("Outer") && !idsOf(nested).includes("Inner"),
  { ids: idsOf(nested) },
);
eq("  顶层 description 照常解析", stylesOf(nested).find((s) => s.id === "Outer")?.description, "top");

// ⑦ 目录里有一个**与 .md 同名的子目录**:读它会 EISDIR,但不能让整份列表崩掉。
mkdirSync(join(USER_STYLE_DIR, "adir.md"), { recursive: true });
const withDir = await outputStyleList({});
check("同名的子目录不把整份列表搞崩", Array.isArray(stylesOf(withDir)) && idsOf(withDir).length >= 5, {
  count: idsOf(withDir).length,
});

/* ────────────────────────── 11. 输出风格:无参调用 ────────────────────────── */

console.log("\n输出风格 · 不带参数 invoke 不许抛");

// ⚠️ 本仓库有过一个真 bug 就是「空 schema 的 `z.object({})` 不接受 `undefined`,面板一
// 打开就报 `invalid_type … received "undefined"`」。这一条专门钉住它:无参调用时 handler
// 收到的是 `undefined`,必须照常返回列表(`outputStyle.ts` 里那句 `?? {}` 就是干这个的)。
const noArgs = await outputStyleList(undefined);
check("不带参数 invoke 不抛,照常返回列表", Array.isArray(stylesOf(noArgs)) && stylesOf(noArgs).length > 0, {
  styles: idsOf(noArgs),
});

// `null` 与 `undefined` 是**两种不同的输入**(preload 传什么就是什么),两个都要能接。
const nullArgs = await outputStyleList(null);
check("传 null 也不抛(空 schema 两边都得接住)", stylesOf(nullArgs).length > 0);

// 多传一个没人认的键:zod 对空 object schema 的默认行为是**剥掉**它而不是报错。
// 这条断的是"渲染端多塞了个字段时面板不会整个打不开"。
const extraKey = await outputStyleList({ whatever: 1 });
check("多传一个没人认的键不会让面板打不开", stylesOf(extraKey).length > 0);

/* ────────────────────────── 12. 两条通道都只读 ────────────────────────── */

console.log("\n两条通道都只读");

// 输出风格这条通路**只读**:它不该顺手把选择写进设置表(选择是另一条通道
// `setting.set` 的事)。调用一圈之后那个键必须还是**没写过**,而不是空串 ——
// `SettingRepo.get` 对不存在的键返回 `null`,写了个空串才会返回 `""`。
eq("调了一圈没往设置表里写输出风格的选择", SettingRepo.get(AGENT_OUTPUT_STYLE_SETTING_KEY), null);
// 而且它也没把用户目录里的文件删掉/改名 —— 那份目录还是刚才写的那几个。
const stillOnDisk = stylesOf(await outputStyleList({})).filter((s) => s.source === "user").map((s) => s.id);
eq("  用户写进去的那几个风格都还在(没有被顺手改写)", stillOnDisk.includes("早安"), true);

/* ────────────────────────── 13. 渲染端加载的旧回包竞态守卫 ────────────────────────── */

console.log("\n渲染端的旧回包竞态");

// ★ `UsagePanel` 切换预设(今天/7天/30天/全部)时会 `await api.usage.stats({preset})`。
//   按钮虽 `disabled={loading}`,但从点击到重渲染之间有一小段窗口能再点一次 —— 两个
//   in-flight 请求按完成先后写 state 的话,后回的那次会盖掉先用那个,面板显示的是
//   **上一次预设**的数据(与按钮高亮对不上)。仓库里同类加载都补了请求序号守卫
//   (GitPanel 的 scanSeqRef / GitHistoryView 的 commitsSeqRef / libraryStore 的
//   openItemSeqRef),这里判据钉在**源码**上(组件本身跑不进无头,只能这样守)。
{
  const { readFileSync } = await import("node:fs");
  const usagePanel = readFileSync(join(process.cwd(), "src/renderer/components/settings/UsagePanel.tsx"), "utf8");
  // 两件都要有:①每次调用**自增**序号(只检查"有个 ref"会假绿 —— 光删自增那一行,
  // 回包核对那句还在,断言照样绿);②回包时比对。
  check(
    "★ UsagePanel 加载有 *Seq 守卫(每次自增 + 回包核对)",
    /const seq = \+\+loadSeqRef\.current;/.test(usagePanel) && usagePanel.includes("seq !== loadSeqRef.current"),
    usagePanel.match(/loadSeqRef[^\n]*/g),
  );

  // ★ **画在面板上的错误文案必须是中文。** `RuntimePolicyPanel` 的两个 `decode*` 抛出的
  //   句子会经 `read.error.message` 原样渲染进 `ErrorNote`(不是内部诊断),而它们从前是
  //   英文("Invalid turn budget configuration" / "Invalid fallback model configuration")。
  //   `SkillsPanel` 的 `sourceQuery` 抛错同理经 `readError` 画出来。判据钉源码上。
  const runtimePolicy = readFileSync(join(process.cwd(), "src/renderer/components/settings/RuntimePolicyPanel.tsx"), "utf8");
  const englishThrows = (runtimePolicy.match(/throw new Error\("[A-Z][a-z]+ /g) ?? []).length;
  check("★ RuntimePolicyPanel 的 decode 错误文案是中文(它画在面板 ErrorNote 上)", englishThrows === 0, runtimePolicy.match(/throw new Error\("[^"]*"/g));
  const skillsPanel = readFileSync(join(process.cwd(), "src/renderer/components/settings/SkillsPanel.tsx"), "utf8");
  check(
    "★ SkillsPanel 的 sourceQuery 错误文案是中文(它经 readError 画出来)",
    !/throw new Error\("[A-Z][a-z]+ /.test(skillsPanel),
    skillsPanel.match(/throw new Error\("[^"]*"/g),
  );
  // ★ `localStorage.getItem("mcode.skills.leftW")` 跑在 `useState` 初始化器里 —— 读抛
  //   (`SecurityError`:存储被禁用 / 嵌入式上下文)会让整块面板渲染不出来(白屏)。同文件的
  //   `expanded` 那条同款读取**早就 guard 了**,这条曾漏 —— 判据:那一行必须在 `try` 里。
  check(
    "★ SkillsPanel 读 localStorage 的 leftW 有 try 守卫(存储被禁时不白屏)",
    /try \{[^}]*localStorage\.getItem\("mcode\.skills\.leftW"\)/s.test(skillsPanel),
    skillsPanel.match(/localStorage\.getItem\([^)]*\)/g),
  );
}

/* ────────────────────────── 14. 钩子面板:写盘失败的出口 ────────────────────────── */

console.log("\n钩子面板的写盘失败出口");

// ★ `hooks:save` / `hooks:remove` 写盘失败时回 `{ok:false, error}`（`main/hooks/store.ts`
//   的 `commitHooks` → `writeRaw`：临时文件写不进去 / 改名失败 / 数据根只读）。设置页里
//   有**三处**调它们，其中 `save()`（编辑器里那颗保存按钮）一直有 `if (!res.ok)` 出口，
//   而列表上的**开关** `toggleEnabled`（乐观拨过去 + 重拉）与 `remove`（确认删除后）
//   **从前不看返回值** —— 用户点了、开关弹回原位 / 那条还在，屏幕上却一句话没有（"点了没
//   反应"那一类）。判据钉源码：这两条都必须在拿到结果后检查 `res.ok` 并报错，且
//   `toggleEnabled` 的错误要挂在**始终可见**的 toast 通道上（没选中任何一条时编辑器不渲染，
//   `saveError` 没地方显示）。
{
  const { readFileSync } = await import("node:fs");
  const hooksPanel = readFileSync(join(process.cwd(), "src/renderer/components/settings/HooksPanel.tsx"), "utf8");
  const code = hooksPanel.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

  // `remove`：拿到的回包必须检查 ok，失败时写进保存错误（编辑器仍开着，可见）。
  check(
    "★ 钩子 remove 检查 {ok:false} 并报错(从前不看返回值,删失败静默)",
    /const res = await api\.hooks\.remove\(\{[^}]*\}\);\s*if \(!res\.ok\)\s*\{\s*setSaveError\(/.test(code),
    code.match(/api\.hooks\.remove\([^\n]*/g),
  );

  // `toggleEnabled`：拿到的回包必须检查 ok，失败时走 toast（列表行上、编辑器可能没开）。
  check(
    "★ 钩子开关 toggleEnabled 检查 {ok:false} 并走 toast 报错(从前开关静默弹回)",
    /const res = await api\.hooks\.save\(\{ hook: next \}\);\s*if \(!res\.ok\)\s*\{\s*useToastStore\.getState\(\)\.push\(/.test(code),
    code.match(/api\.hooks\.save\(\{ hook: next \}\)/g),
  );
  check(
    "★ 钩子开关使用了 toast 通道(错误在列表上始终可见)",
    code.includes("useToastStore.getState().push("),
    "",
  );
}

/* ────────────────────────── 收尾 ────────────────────────── */

console.log(`\nsettings-panel-smoke:${total - failures}/${total} 通过`);
process.exit(failures === 0 ? 0 : 1);