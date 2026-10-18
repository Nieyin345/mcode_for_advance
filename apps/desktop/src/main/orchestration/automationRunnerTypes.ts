/**
 * **自动化的数据形状与纯判定件** —— `automationRunner.ts` 顶部那一堆东西。
 *
 * 这里只放**不碰 `this`** 的单元（见 `automationRunner.ts` 文件头）：settings 键名常量、
 * 落盘欠账/领取账本/监听条目的接口、以及三个纯函数（`isLastMinutes` /
 * `isUndeliveredDrops` / `existingFilesOf`）。执行器本体（`AutomationRunner` 类）留在
 * `automationRunner.ts`，从本模块 import 回这些名字 —— 搬的是位置，不是行为。
 */

import { existsSync, type FSWatcher } from "node:fs";
import { type FileChangeKind } from "@contracts/hook";
import { type TriggerSpec } from "@contracts/nodeType";
import type { TriggerPayload } from "./automationPayload.js";

/**
 * 定时那一路**多久看一次时钟**。
 *
 * 30 秒是"分钟级 cron"的一个务实取舍:最坏情况晚触发 30 秒,而一秒一跳纯属浪费
 * (`cronMatches` 只到分钟这一位,跳得再密也不会更准)。代价是同一分钟**会看两次**
 * —— 所以 `onTick` 里必须去重,否则「每一分钟都跑」那条表达式会一分钟跑两次。
 */
const TICK_MS = 30_000;

/**
 * 一条文件事件先等这么久,再按触发器自己的合并窗口收口。
 *
 * 为什么除了 `debounceMs` 还要这 300ms:编辑器保存一个文件往往是"写临时文件 → 改名
 * → 更新目录"好几下,而**第一下到达时文件还没写完**。立刻按 `debounceMs` 起跑的话,
 * `debounceMs: 0`(用户明确要求"每次都跑")那条配置会对着半个文件跑一次。
 */
const WATCH_SETTLE_MS = 300;

/**
 * 目录监听**挂失败之后多久再试一次**,以及退避的上限(见 `retryWatchers`,MC-020)。
 *
 * `fs.watch` 失败只有两种原因:目录暂时不在(项目被移走 / 还没建出来),或者平台不
 * 允许。两种都不是永久的 —— 目录回来之后就该**自动复活**,而不是等用户显式重存一次
 * 工作流。退避对齐那根 30 秒的 ticker 起跳、翻倍到 5 分钟封顶:既不会在一根坏目录上
 * 每秒敲,也不会把"目录刚回来"拖到下一次 reload。
 */
const WATCH_RETRY_MIN_MS = 30_000;
const WATCH_RETRY_MAX_MS = 5 * 60_000;

/**
 * 「这一条定时触发器上一次是在哪一分钟跑的」存在这个 settings 键下。
 *
 * ## 为什么必须落盘
 *
 * 这条记忆原本是执行器里一个 Map(`lastMinute`),**应用一关就没了**。而它要挡的那件
 * 事恰恰发生在重启那一下:去重只对「最近这个分钟已经跑过」生效(`shouldFireThisMinute`),
 * 记忆一没,重启后那一跳看到的就是「本分钟没见过」—— 于是**同一分钟里的第二个进程**
 * 又跑一次。症状是「每次开应用,那个「每分钟一次」的自动化就额外多跑一次」,而日志里
 * 两次运行的时间戳只差几秒,看不出是哪来的。
 *
 * ## 为什么存 settings,不是新开一张表
 *
 * 形状是**一张小映射**(`触发器的 key → 分钟序号`),不是"一次运行的存档" —— 与
 * `browser.addressHistory` / `browser.bookmarks` 同一类东西,那两处都走 `SettingRepo`。
 * 开一张新表要动 `store/db.ts`(建表 + 迁移)再加一个 Repo,而换来的只是"能按列查" ——
 * 这里没有任何按列查的需求(每次都是整张读进来、整张写回去)。
 *
 * ⚠️ **`SettingRepo.set` 内部会 `persist()`(重写整个数据库文件)**,所以这张表必须
 * 按分钟变一次才写、值没变就不写 —— 按 tick(30 秒)无条件写就是每天几万次整库重写,
 * 见 `rememberLastMinute`。
 *
 * 键名沿用 `automation.watch.templates` 那种 `automation.` 前缀(按模块分空域),不插进
 * contracts 的 `*_SETTING_KEY` 那一堆 —— 那边是**界面也要读**的偏好项;这一份是执行器
 * 的内部状态,没有第二个读者,放这儿离用它的人最近。
 */
const LAST_MINUTE_SETTING_KEY = "automation.lastMinute";
const SELF_TRIGGER_LIMIT = 10;
const SELF_TRIGGER_COUNT_PREFIX = "automation.selfTriggerCount.";
/**
 * 这条额度**最后一次被花掉**是什么时候(与计数分开存)。
 *
 * ## 为什么要有
 *
 * 从前额度**只有手动运行才清零**。无人值守的夜里一条链把 10 次用完之后,这条自动化
 * 就永久停摆,直到有人早上来点一下 —— 而"不再依赖人看到并点一下"正是整批兜底改动的
 * 出发点(见 `docs/workflow-automation-resilience-20260928.md` 的开头)。循环保护要
 * 挡住的是**紧挨着的连环自触发**,不是"这条自动化这辈子一共回过自己几次"。
 *
 * 所以额度改成**滑动窗口**:离上一次自触发超过 {@link SELF_TRIGGER_WINDOW_MS} 就从头
 * 开始数。真正的死循环在几秒到几分钟内就会把 10 次用光(窗口远没到期),而一天跑两次、
 * 每次回自己一轮的正常自动化再也不会攒成停摆。
 */
const SELF_TRIGGER_AT_PREFIX = "automation.selfTriggerAt.";
/** 自触发额度的滑动窗口。6 小时 = 比任何一次正常运行都长,比"永远"短。 */
const SELF_TRIGGER_WINDOW_MS = 6 * 60 * 60_000;
const SELF_TRIGGER_STOP_REASON = `自身或回环事件触发已达${SELF_TRIGGER_LIMIT}次，自动续跑已停止；请手动运行一次后继续（或等这一段安静下来自动恢复）`;

/**
 * 「上一次还在跑」时攒着的那一批,**多久回头看一次**。
 *
 * 从前写死 1 秒:一次跑几小时的自动化就是几小时里每秒一次 flush,每一次都要读工作流、
 * 查会话表、问活跃状态。指数退避到半分钟封顶 —— 最坏多等 30 秒,而那批本来就在等一个
 * 以小时计的运行。
 */
const BUSY_RETRY_MIN_MS = 1_000;
const BUSY_RETRY_MAX_MS = 30_000;

/**
 * 文件监听**一律不看**的目录名。
 *
 * `fs.watch(dir, { recursive: true })` 盯的是项目根,`node_modules` / `.git` / 构建产物
 * 全在里面:一次 `npm i` 或一次构建就是几万条事件,每条都要对所有文件触发器跑一遍 glob。
 * 与 `lib/walkCache.ts` 跳过生成目录是同一条理由(那边为了快,这边为了不被淹)。
 *
 * ⚠️ 只按**路径段**比,不按前缀 —— `distribution/` 不该被 `dist` 吞掉。
 */
const WATCH_IGNORED_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "out", "target", ".next", ".nuxt", ".turbo", ".cache",
  ".venv", "__pycache__", ".pytest_cache", ".mypy_cache", "coverage", ".idea", ".vscode",
]);

/**
 * 一格攒着的文件路径上限。
 *
 * 删掉的路径**不在收口时立刻剔除**(只在拼载荷时滤掉),好让"改名来回"那种情形下路径还在
 * —— 所以数组会随事件累积。一个长期抖动的目录会让它无限长下去,最后整批塞进提示词。
 * 这个上限把它截到最近若干条:**丢掉多少累加进 `overflowDropped` 并兑现到载荷事实**
 * (ARC-015)—— 截断本身是性能保护,但不得静默假装输入完整。资料库那一侧早就有
 * `CUSTOM_UI_MAX_BATCH = 200` 的对称上限。
 */
const PENDING_FILES_LIMIT = 500;

/**
 * 【MC-091 续·全局背压】**所有**触发器**同时**攒着的条目总数上限。
 *
 * ## 为什么单条的上限不够
 *
 * `PENDING_FILES_LIMIT`(每格文件 500)与 `MAX_EVENT_ITEMS`(每批事件 100)**各自只管**
 * 一条触发器**。几十条自动化被同一条抖动目录 / 事件流一起灌满时,整台机器攒着的条目
 * 总量 = 触发器数 × 单条上限,而这个乘积**没有任何上界** —— 那正是复核点名的「全局
 * 背压」缺口:单条有界不等于整体有界。
 *
 * ## 判据与口径
 *
 * 这一条给整个执行器一张预算:任一条要收**新**条目之前,先问 `admitGlobal`「现在还放得
 * 下吗」。放不下就**不收这一条**,并把丢弃如实记进**恢复游标**(`recordDropped` →
 * `automation.droppedUndelivered`)—— 与单条那一路同一个「丢要报出来」的立场,只是判据
 * 从"这一格满了"升级到"整台机器满了"。取 5000:够容纳十条触发器各自攒满(单条上限
 * 500),又不至于让一台挂着几十条自动化的机器把内存顶穿。
 *
 * ⚠️ 全局这一层**不覆盖**已收进队列的旧条目(那会牵动所有 pending 的重排):它的语义是
 * **背压** —— 触顶之后**新条目不再进来**,而不是"把别处攒着的挤出去"。单条那一路仍是
 * 「丢最早」(`addToFileBacklog` / `mergeEventPayload`),两层各管各的、互不矛盾。
 */
const GLOBAL_PENDING_LIMIT = 5000;


/** 非本轮分钟的历史最多保留60条；本轮分钟记录不受条数限制。
 *  同分钟已触发的 key 是正确性状态，不能按容量淘汰，否则第61条之后的
 *  触发器会在下一次tick/重启后重复运行。保护分钟推进后，旧记录重新受限。 */
const LAST_MINUTE_HISTORY_KEEP = 60;

/** 「错过」结算到哪一分钟(见 `AutomationRunner.readMissedSwept`)。 */
const MISSED_SWEPT_SETTING_KEY = "automation.missedSweptTo";

/**
 * 定时触发的 **durable 领取账本**存在这个 settings 键下(MC-051)。
 *
 * ## 它与 `LAST_MINUTE_SETTING_KEY` 的分工
 *
 * `lastMinute` 回答的是「**这一分钟碰过没有**」—— 一张快速去重表(它的落盘 2026-10-11
 * 已改成派发前同步 durable)。本表回答的是「**这一分钟到底确认完成了没有**」—— 一条
 * 可追踪的领取记录。两者**都要落盘、都在派发前 durable**,但语义不同,不能合一:
 * 去重表按分钟覆盖(同一格翻到新的一分钟就抹掉了旧值),而领取账本要**跨分钟保留**
 * (上一个进程崩在某一分钟的那条 `CLAIMED` 必须留到重启时被恢复看见)。
 *
 * ## 为什么不新开一张表
 *
 * 形状是一张**小映射**(`claimId → {status, minute, at}`),与 `lastMinute` 同一类,
 * 都走 `SettingRepo`。开新表要动 `store/db.ts`(建表 + 迁移)再加一个 Repo,换来的
 * 只是"能按列查" —— 这里没有按列查的需求(整张读、整张写)。
 *
 * ⚠️ 落盘仍走 `SettingRepo.set` + `commitNow` 那一份**唯一**的 durable 通路(判据 `isDurable`),
 * 与 MC-084 的 `DurableOperationLedger` 共用 —— 不另立第二套写盘机制。
 */
const TRIGGER_CLAIMS_SETTING_KEY = "automation.triggerClaims";

/** 已完成的领取最多留多少条(未完成的 `CLAIMED`/`UNCERTAIN` 不受此限,见 `pruneClaims`)。 */
const TRIGGER_CLAIMS_HISTORY_KEEP = 64;

/**
 * 【MC-091 续】**被积压丢弃、但还没交付给任何一次运行**的条目数,存在这个 settings 键下。
 *
 * ## 为什么必须落盘
 *
 * `pending.overflowDropped` / 载荷的 `itemsOverflowDropped` 已经把"这一批丢了几条"兑现到
 * **本次运行**的载荷里 —— 但那份账只在**内存**的 pending 上。几种情形会把它整份弄丢:
 * ① 应用在合并窗口里重启(那一格 pending 没了);② 攒着的那一批因配置改动 / 用户取消 /
 * `dispose` 被作废(见 `apply` / `onEvent` 的取消分支 / `dispose`)—— 这些路都**不派发
 * 运行**,于是"丢了 N 条"这件事**静默消失**,下次运行读到的载荷里既没有条目、也没有截断
 * 事实,模型以为它办的是全部。这正是复核点名的「持久积压 / 恢复游标」缺口。
 *
 * 本表就是那个恢复游标:凡有丢弃就累加并落盘,下一次真正派发的运行把这份欠账**并进它的
 * 载荷事实**(`overflowDropped` / `itemsOverflowDropped`)、随后**清账**(drained);重启后
 * 从盘上读回来接着算。
 *
 * ## 为什么不新开一张表
 *
 * 形状是一张**小映射**(`触发器的 key → {count, at}`),与 `lastMinute` / `triggerClaims`
 * 同一类,都走 `SettingRepo`。开新表要动 `store/db.ts`(建表 + 迁移)再加一个 Repo,换来的
 * 只是"能按列查" —— 这里没有按列查的需求(整张读、整张写)。落盘走 `SettingRepo.set`
 * (**异步** `persist()`,重写整个库文件),故按"值变了才写""每键一条不新增"的规矩落
 * (同 `rememberLastMinute`)——一条抖动的目录只会不停刷新**同一个**键,键数 = 有丢弃的
 * 触发器数,通常个位数。
 *
 * ⚠️ 与「定时去重必须先 durable 才派发」那条红线**不同**:这里不挡任何派发,丢掉一两笔
 * 记账只退化成"重启后可能少报一次丢弃",不会造成重复的外部副作用 —— 所以用 `SettingRepo.set`
 * 的异步落盘即可,不必为了每次 churn 都 fsync 一次。
 */
const DROPPED_SETTING_KEY = "automation.droppedUndelivered";
/** 上面那张表最多留多少条(按最近丢弃时刻修剪)。已交付(drained)的键直接删。 */
const DROPPED_HISTORY_KEEP = 64;

/** 一条「被丢弃、未交付」的欠账。 */
interface UndeliveredDrop {
  /** 累计丢掉了几条(自上一次交付以来)。 */
  count: number;
  /** 最近一次丢弃的时刻(ms),修剪用。 */
  at: number;
}

/**
 * **文件 / 事件触发的「攒着但还没派发」批次标记**(跨崩溃可见性)。
 *
 * ## 它在补哪个洞
 *
 * 文件与事件触发的批次只活在**内存**里(`AutomationRunner.pendingFires`):合并窗口
 * (默认 2 秒)里进程被杀死 / 断电,那一批就**无声消失** —— 既没有 `lastError`,也不在
 * 运行史里,`droppedUndelivered` 只记"因积压超限丢掉的条目",不记"整批没了"。用户唯一
 * 的现象是"我改了文件,自动化没反应",没有任何一处说得出为什么。
 *
 * 现在每次一个新批次开始攒时,往这张表 durable 写一条标记(`{kind,count,at}`);派发
 * 完成 / 明确跳过 / 配置作废时清除。**崩溃重启后**残留的标记就是"上一次有一批没派发"
 * 的证据 —— 启动时按 `uncertain` 语义记进触发器事实(界面可见),`log.warn` 点名,
 * 然后清掉。**绝不自动补投**:补投会造出第二次外部副作用;需要重跑由用户手动运行。
 *
 * ## 形状与落盘
 *
 * 一张小映射(`触发器 key → 标记`),与 `lastMinute` / `triggerClaims` /
 * `droppedUndelivered` 同一类,都走 `SettingRepo`,不另开表。**批次开始时那一次写入
 * 走 `commitNow`(fsync)**,满足"派发前已 durable";之后同一批的计数变化只改内存
 * (一次 fs 事件风暴不该每次整库重写)。清除走普通 `SettingRepo.set`(崩溃在清除的异步
 * 落盘之前 → 标记残留 → 下次启动报"不确定",保守且正确)。
 *
 * 条数上限按最近攒批时刻修剪(同一触发器只占一个键,键数 = 攒过批的触发器数)。
 */
const PENDING_BATCH_SETTING_KEY = "automation.pendingBatches";
/** 上面那张表最多留多少条(按最近攒批时刻修剪)。 */
const PENDING_BATCH_HISTORY_KEEP = 64;

/** 一条「攒着还没派发」的批次标记。`count` 是攒批那一刻的条目数(至少这么多)。 */
interface PendingBatchMark {
  kind: "file" | "event";
  count: number;
  /** 批次开始攒的时刻(ms),修剪用。 */
  at: number;
}

/** 节点清单的短缓存窗口(见 `AutomationRunner.loadTypes`)。 */
const TYPES_CACHE_TTL_MS = 5_000;

/**
 * 落盘那份能读的判据。读不回来**不抛**,当空表 —— 见 `readLastMinutes`。
 */
function isLastMinutes(raw: unknown): raw is Record<string, number> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  return Object.entries(raw).every(
    ([key, value]) => key.length > 0 && typeof value === "number" && Number.isFinite(value),
  );
}

/**
 * 【MC-091 续】落盘那份「被丢弃、未交付」欠账能读的判据。读不回来**不抛**,当空表 ——
 * 见 `readDroppedUndelivered`。每条是 `{count, at}`(`count` 是正整数,`at` 是有限数)。
 */
function isUndeliveredDrops(raw: unknown): raw is Record<string, UndeliveredDrop> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  return Object.entries(raw).every(([key, value]) => {
    if (key.length === 0 || typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const rec = value as { count?: unknown; at?: unknown };
    return typeof rec.count === "number" && Number.isFinite(rec.count) && rec.count > 0 &&
      typeof rec.at === "number" && Number.isFinite(rec.at);
  });
}

/**
 * 落盘那份**待派发批次标记**能读的判据。读不回来**不抛**,当空表 —— 同
 * `isUndeliveredDrops` 的立场(坏一格不该让执行器起不来;代价只是少报一次
 * 「上次有一批没派发」)。
 */
function isPendingBatchMarks(raw: unknown): raw is Record<string, PendingBatchMark> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  return Object.entries(raw).every(([key, value]) => {
    if (key.length === 0 || typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const rec = value as { kind?: unknown; count?: unknown; at?: unknown };
    return (rec.kind === "file" || rec.kind === "event") &&
      typeof rec.count === "number" && Number.isFinite(rec.count) && rec.count >= 0 &&
      typeof rec.at === "number" && Number.isFinite(rec.at);
  });
}

/**
 * 文件触发那一路:一个**刚被创建、还没来得及写完**的文件不该被当成"不存在"。
 *
 * 症状(问题 2):`fs.watch` 的 `rename` 事件同时覆盖新建与删除,载荷里于是可能带着一个
 * **已经被删掉的路径**,模型拿着它去读,得到"文件不存在";而它本该去办的是这一批里
 * 别的文件 —— 一个不存在的路径不会让运行失败,只是**悄悄少办一件事**。
 *
 * ## 取舍:判"此刻在不在",不判"这个事件是新建还是删"
 *
 * 不判方向是因为 `fs.watch` 给不出方向 —— `rename` 对新建、删除、改名一律是
 * `"rename"`。而"文件此刻在不在"是这件事里唯一确定的事实。
 *
 * 为什么不误伤**刚创建、还没来得及写完**的那个:文件节点在创建那一刻就存在了(写内容
 * 发生在后面),所以 `existsSync` 当场是 true,不会被丢掉。真正会漏掉的只有"创建后在
 * 合并窗口内又被删掉"的那种 —— 而那种本来就不该跑。
 *
 * ## 为什么问两遍(事件到达时 + flush 前)
 *
 * 两边管的是不同的缝:
 *
 *  - **事件到达时**(`onFsChange`)决定"这一次要不要攒起来"。拦在这里,一次纯删除不会
 *    攒出一次**空载荷**的运行(模型被叫起来却没有任何要办的事)。
 *  - **flush 前**(`rearm`)管攒着的那几秒里被删掉的路径 —— 那期间文件可能又没了,
 *    而载荷是按 flush 那一刻现拼的。
 *
 * 代价(明说):一个文件被删除到 flush 之间的删除事件**不会**让已经攒着的那一次取消,
 * 它只是从载荷里消失 —— 如果整批都这样,这次运行带着空载荷照跑。要更严就得在"攒着的
 * 那几秒里全空了"时把这一次整个丢掉,那会让"新建 + 改动"变成"删掉一半"的正常批被吞。
 */
function existingFilesOf(files: readonly string[]): string[] {
  return files.filter((file) => existsSync(file));
}

/** 一条自动化的**触发条件(已解好)** —— 执行器要的全部信息。 */
interface LoadedTrigger {
  workflowId: string;
  /** Execution-affecting revision from the document used to build this trigger. */
  workflowRevision: string;
  /** 工作流的名字,只用于给后台会话起个能给排查看的标题。 */
  workflowName: string;
  /** 触发器节点的 id —— 它同时是 `entry.nodeId`(这次运行从哪一格起)。 */
  nodeId: string;
  /** 给日志看的名字(节点标题 > 清单名)。 */
  title: string;
  spec: TriggerSpec;
  projectId: string;
  /** 这次运行的工作目录。**每次触发都从项目表读**,所以项目被移走了会当场发现。 */
  cwd: string;
  /** 「这次要做什么」—— 整次运行的用户请求。 */
  task: string;
  /**
   * 触发器节点上的**完整参数袋**。只为 `triggerSeedOf` 登记事实时读「启用」那一格
   * (`NODE_TRIGGER_ENABLED_PARAM_KEY`)—— 它按**键**读,所以这里存一份比再拆一个
   * 布尔字段更省事:事实那边的 `enabled` 与下面 `disarmed` 于是永远不会漂。
   *
   * ad-hoc 那条路(守望入口)不在图上、没有参数袋,给空对象 —— 缺席即开,
   * 与它本来就在响的事实一致。
   */
  params: Record<string, unknown>;
  /**
   * 用户在图上**关掉了**这条触发器(见 `NODE_TRIGGER_ENABLED_PARAM_KEY`)。
   *
   * 关掉的照样进这张表、照样登记事实 —— 界面上要看得见"有这一条,是你关的",
   * 而不是整行消失(那和"触发器没了"分不清)。只是**自动那三条路不派发它**。
   */
  disarmed: boolean;
}

/** 攒着还没跑的那一次。文件连着变、事件连着来时,同一格只留一个计时器。 */
interface PendingFire {
  trigger: LoadedTrigger;
  timer: ReturnType<typeof setTimeout> | null;
  /** 已经按 glob 筛过的文件(绝对路径)。只有文件那一路会往里放。 */
  files: string[];
  /**
   * 【ARC-015①】这一格攒着期间每个路径的**结构化变更方向**(`path → kind`,last-write-wins)。
   *
   * 与 `files` 是两份不同的东西:`files` 只装得下"存在、要办"的文件,一次 `deleted`
   * 在那份列表里**没有位置** —— 所以方向单独攒在这里,收口时经二次 stat 再对一遍
   * (见 {@link reconcileFileChangeKind}),作为 `payload.changes` 交给模型。
   */
  changes: Map<string, FileChangeKind>;
  /**
   * 【ARC-015】这一格攒着期间**因积压超限被丢掉**的路径条数(累加,见 `addToFileBacklog`)。
   *
   * 上限保护本身要保留(一条抖动的目录不能无限占内存/塞爆提示词),但**丢了几条必须
   * 兑现到载荷事实**里 —— 否则模型把这份被截断的列表当成全部,少办的那些永远没人办、
   * 也不报错。未丢时是 0,载荷里就不出现这个键。
   *
   * 【MC-091 续】**与落盘欠账表(`automation.droppedUndelivered`)并存**:这一份是**当前
   * 这一批**的计数(载荷按它现拼,冒烟也直接看它);落盘那份是**跨批 / 跨重启**的恢复游标
   * (派发时以它为准并入载荷、随后清账 —— 见 {@link drainDroppedUndelivered})。两者在同
   * 一批里数值相同(同一次丢弃各记一笔),所以派发时用落盘的绝对值覆盖不会重复计。
   */
  overflowDropped: number;
  /** 最后一条事件载荷(事件那一路用;文件那一路的载荷在 flush 时现拼)。 */
  event?: TriggerPayload;
  /** Internal provenance, never inferred from model-supplied payload fields. */
  selfOrigin?: boolean;
  /** Preserve external data independently if the self budget runs out while queued. */
  externalEvent?: TriggerPayload;
  /** Ancestors captured when events arrive, not re-read after debounce/retry. */
  eventChain?: readonly string[];
  externalChain?: readonly string[];
  /** 「上一次还在跑」时的回看间隔,指数退避(见 {@link BUSY_RETRY_MIN_MS})。 */
  busyRetryMs?: number;
  /** 这一格是否已往 `automation.pendingBatches` 写过崩溃可见性标记(每格只写一次)。 */
  batchMarked?: boolean;
}

/** 一次手动运行的结论。IPC 那一路要把它变成给用户看的一句话。 */
export type AutomationRunResult = { ok: true } | { ok: false; error: string };

/** 一个项目目录的监听 `fs.watch` 只开一个,多个触发器共享。
 *  `watcher === null` 就是"这个目录上现在没挂上"——`rebuildWatchers` 据此每次 reload
 *  重试(目录回来了就该复活)。(曾有个 `watchOk` 字段,注释写着"不可用时不再反复重试",
 *  但它只被写过、从没被读过,重试一直按 `watcher === null` 走 —— 是死状态,删。)
 *
 *  ## 挂失败后的自主重试(MC-020)
 *
 *  从前 `watcher === null` 只有 `rebuildWatchers` 会去补挂,而它只由 reload/reloadAll
 *  调 —— 30 秒的 `onTick` 只看定时那一类。于是目录一坏(初始不存在 / 监听出错被关),
 *  在没有显式 reload 的情况下**永远是 null**:用户把目录建回来,那条文件触发器也再不响。
 *  现在 ticker 里会按 {@link retryWatchers} 有上限地退避重挂,`nextRetryAt` / `retryMs`
 *  就记着下一次该在什么时候、隔多久再试。`watcher !== null` 时这两个字段必然缺席。 */
interface WatcherEntry {
  watcher: FSWatcher | null;
  /** 下一次该在什么毫秒(墙钟)重试挂这个目录。挂了/停用就清掉。 */
  nextRetryAt?: number;
  /** 当前退避间隔(毫秒)。从 {@link WATCH_RETRY_MIN_MS} 起翻倍、封顶。 */
  retryMs?: number;
}

export {
  TICK_MS,
  WATCH_SETTLE_MS,
  WATCH_RETRY_MIN_MS,
  WATCH_RETRY_MAX_MS,
  LAST_MINUTE_SETTING_KEY,
  SELF_TRIGGER_LIMIT,
  SELF_TRIGGER_COUNT_PREFIX,
  SELF_TRIGGER_AT_PREFIX,
  SELF_TRIGGER_WINDOW_MS,
  SELF_TRIGGER_STOP_REASON,
  BUSY_RETRY_MIN_MS,
  BUSY_RETRY_MAX_MS,
  WATCH_IGNORED_DIRS,
  PENDING_FILES_LIMIT,
  GLOBAL_PENDING_LIMIT,
  LAST_MINUTE_HISTORY_KEEP,
  MISSED_SWEPT_SETTING_KEY,
  TRIGGER_CLAIMS_SETTING_KEY,
  TRIGGER_CLAIMS_HISTORY_KEEP,
  DROPPED_SETTING_KEY,
  DROPPED_HISTORY_KEEP,
  PENDING_BATCH_SETTING_KEY,
  PENDING_BATCH_HISTORY_KEEP,
  TYPES_CACHE_TTL_MS,
  isLastMinutes,
  isUndeliveredDrops,
  isPendingBatchMarks,
  existingFilesOf,
};
export type {
  LoadedTrigger,
  PendingFire,
  UndeliveredDrop,
  PendingBatchMark,
  WatcherEntry,
};
