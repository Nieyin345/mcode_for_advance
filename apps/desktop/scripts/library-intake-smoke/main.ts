/**
 * Headless smoke for **「检索结果入库」这条路发不发 `library.item.imported`**。
 *
 * ## 为什么要有这一套
 *
 * 主进程有四条"把东西放进库"的路:
 *
 *   1. 导入本地 PDF(`library/pdfImport.ts`)
 *   2. 导入通用文件/目录(`library/fileImport.ts`)
 *   3. 导入标识符,DOI/arXiv(`library/operations.ts`)
 *   4. **检索结果入库(`ipc/library.ts` 的 `LIBRARY_ADD_ITEMS`)** —— 用户在界面上
 *      最常走的那一条
 *
 * 前三条都发 `library.item.imported`;**第四条漏了**。而那条事件是**两条内置自动化
 * 的触发点**:`wf_auto_download`「导入后排队下载」的触发器把 `events` 参数写成
 * `"library.item.imported"`(`builtins.ts:517`),`wf_auto_convert`「下载后转录」听
 * `"library.item.downloaded"`。钩子与自动化的「事件发生时」触发器也挂在
 * `runtimeManager.subscribe` 上 —— 同一个信号。
 *
 * 漏发的后果**不是报错**,是那两条自动化在最常用的入口上是哑的。而且它演示时看不
 * 出来:`LIBRARY_ADD_ITEMS` 自己顺手调了 `enqueueDownloads`,PDF 照样下得下来。
 * 差别要等用户自己挂一条自动化、或者去看 `wf_auto_convert` 时才显形 —— 那时已经
 * 很难归因了。
 *
 * ## 判据立在"发了几条"上,不是"类型对不对"
 *
 * 这一套的核心是**去重**。重复入库是这条路上最常见的动作(检索面板勾一份已经勾过的
 * 结果、AI 反复把同一篇往库里塞)。每次都发的结果是那几条自动化被同一篇文献反复触发
 * 起跑。同族 `pdfImport.ts:100-102` 对同一件事的判断是"alreadyPresent 的不算,再发
 * 一次会让自动下载重复排队"。
 *
 * 而"已经有 pdfPath"就是"这一篇已经办妥了"的现成信号 —— 下载器只在真的下到 PDF
 * 之后才写它。所以第 2 节(有 PDF → 不发)和第 3 节(没 PDF → 要发)断的是同一个
 * 判据的两侧,两节都得在。
 *
 * ## 下载那一路整个换桩
 *
 * `enqueueDownloads` 会**立刻** `void processDownloadQueue()` —— 也就是说每调一次
 * 入库,真的下载器就跑一次:联网、写库根、失败还按退避重试。所以
 * `stubs/browserManager.ts` 与 `stubs/libraryHttp.ts` 不是省事,是**这套能跑的前提**。
 * 它们一被调用就抛,于是下载必然失败、任务停在 `pending`(下载器不自动重试),断言
 * 能看见一个确定的状态。
 *
 * Run: scripts/library-intake-smoke/run.sh
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcMain } from "electron";

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

function same(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

const DATA = mkdtempSync(join(tmpdir(), "mcode-lib-intake-"));
process.env.MCODE_SMOKE_DATA_ROOT = DATA;

const { initDb } = await import("@main/store/db.js");
const { LibraryRepo, DownloadJobRepo } = await import("@main/store/repositories.js");
const { registerLibraryHandlers } = await import("@main/ipc/library.js");
const { IPC } = await import("@contracts/ipc");
const { externals, resetExternals, importedIds } = await import("./stubs/runtimeManager.js");
const { changedReasons, resetSent } = await import("./stubs/window.js");

/* ──────────────── 0. 把 handler 从注册函数里取出来 ──────────────── */

// 存的是**宽签名**(`...a: unknown[]`),不是 `(event, raw)`。后者过不了
// `fn(null, ...passed)` —— TS 要求展开一个 `unknown[]` 时目标得是 rest 参数。
const handlers = new Map<string, (...a: unknown[]) => unknown>();
const fakeIpc = {
  handle(channel: string, listener: (...a: unknown[]) => unknown): void {
    handlers.set(channel, listener);
  },
} as unknown as IpcMain;

registerLibraryHandlers(fakeIpc);
await initDb();

function handlerFor(channel: string): (raw: unknown) => Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`registerLibraryHandlers 没有注册 ${channel}`);
  return (raw: unknown) => Promise.resolve(fn(null, raw));
}

const addItems = handlerFor(IPC.LIBRARY_ADD_ITEMS);

/** 入库一条的最小形状。**带 DOI** —— 查重那条判据要它。 */
function entry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: "paper", title: "Attention Is All You Need", year: 2017, source: "search", ...over };
}

type AddResult = { items: Array<{ id: string }> };

/* ══════════════════════════════════════════════════════════════════════════
 *  1. 检索入库 → 必须发 `library.item.imported`
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n1. 检索结果入库(用户最常走的那条路)");

resetExternals();
resetSent();

const added = (await addItems({
  items: [entry({ doi: "10.5555/aaa.1", title: "第一篇文章" })],
})) as AddResult;

eq("入库本身成功(前提,不是判据)", added.items.length, 1);
check("★ 返回的条目带着主进程生成的 id(渲染端靠它做后续操作)", Boolean(added.items[0]?.id));

same(
  "★ 发了且只发了一条 `library.item.imported`(漏了 = wf_auto_download 在这条路是哑的)",
  importedIds(),
  [added.items[0]!.id],
);
same(
  "★ 事件的 sessionId 是 `(system)` 哨兵 —— 导入不属于任何对话",
  externals.map((e) => e.sessionId),
  ["(system)"],
);

// 载荷里那三样是自动化脚本唯一能读到的东西。少了 title,用户配的那条自动化
// 就只能报"有条目入库了",说不出是哪一条。
const first = externals[0] as { kind?: string; title?: string } | undefined;
eq("★ 载荷带 title(自动化靠它说清'是哪一条')", first?.title, "第一篇文章");
eq("★ 载荷带 kind(自动机靠它分流论文/教材/笔记)", first?.kind, "paper");

// 入库还得**通知界面**,否则左栏那棵树一直停在旧样子 —— 反向漏掉同样看不见,
// 而且是用户当场就会看到的那种。
eq("★ 同时通知了界面重拉左栏(`library:changed`)", changedReasons.length, 1);

/* ══════════════════════════════════════════════════════════════════════════
 *  2. 同一篇再入库,而它**已经有 PDF** → 一条都不发
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n2. 同一篇再入库一次(检索面板勾已经勾过的结果)");

const itemId = added.items[0]!.id;
// 先把"已经有 PDF"这个前提做出来 —— 否则下面断的是另一个分支(那种情况该发)。
// 注意顺序:setPdf 之后再 reset,免得把 setPdf 自己可能带出来的事件算进来。
LibraryRepo.setPdf(itemId, "papers/aa/bb/hash.pdf", "hash");
resetExternals();
resetSent();

const again = (await addItems({
  items: [entry({ doi: "10.5555/aaa.1", title: "第一篇文章" })],
})) as AddResult;

eq("去重:还是同一条条目(不是新建了一条)", again.items[0]?.id, itemId);
same("★ 已经有 PDF 的条目再入库 → 一条事件都不发", importedIds(), []);
eq("界面还是要通知(用户确实点了一下,左栏该刷新)", changedReasons.length, 1);

/* ══════════════════════════════════════════════════════════════════════════
 *  3. 在库里、但**还没有 PDF** → 要发 —— 那是补下漏掉那个 PDF 的机会
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n3. 同一篇还没下下来的条目,用户又导了一次");

resetExternals();
const retry = (await addItems({
  items: [entry({ doi: "10.5555/bbb.2", title: "第一次没下下来的那篇" })],
})) as AddResult;
same("第一次入库发了事件(前提)", importedIds(), [retry.items[0]!.id]);

resetExternals();
const retry2 = (await addItems({
  items: [entry({ doi: "10.5555/bbb.2", title: "第一次没下下来的那篇" })],
})) as AddResult;

eq("还是同一条(前提)", retry2.items[0]?.id, retry.items[0]!.id);
same(
  "★ 还没有 PDF 的条目再入库**要发** —— 重导同一篇正是补下漏掉那一次的机会",
  importedIds(),
  [retry.items[0]!.id],
);

/* ══════════════════════════════════════════════════════════════════════════
 *  4. 一次入库好几条 → 几条就发几条,一条不落
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n4. 一次入库好几条(检索面板多选)");

resetExternals();
resetSent();

const batch = (await addItems({
  items: [
    entry({ doi: "10.5555/c.1", title: "第一篇" }),
    entry({ doi: "10.5555/c.2", title: "第二篇" }),
    entry({ doi: "10.5555/c.3", title: "第三篇" }),
  ],
})) as AddResult;

eq("三条都入库了(前提)", batch.items.length, 3);
same(
  "★ 三条各发一条事件,id 一条不落(顺序与入库顺序一致)",
  importedIds(),
  batch.items.map((i) => i.id),
);
eq("界面只通知一次(整批一次重拉,不是三条各拉一次)", changedReasons.length, 1);

/* ══════════════════════════════════════════════════════════════════════════
 *  5. `queueDownload: false` —— 关的是"排队",不是"别告诉大家"
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n5. 调用方显式关掉排队下载时");

resetExternals();
const noQueue = (await addItems({
  items: [entry({ doi: "10.5555/d.1", title: "不要自动下载的那篇", queueDownload: false })],
})) as AddResult;

same(
  "★ 事件照样发(事件是给钩子和别的自动化听的,不是下载器的私有信号)",
  importedIds(),
  [noQueue.items[0]!.id],
);
eq("★ 但一条下载任务都没排", DownloadJobRepo.getByItem(noQueue.items[0]!.id), null);

/* ══════════════════════════════════════════════════════════════════════════
 *  6. 排队下载这条老路没被改坏(事件与它是两件事,都要成立)
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n6. 排队下载这条老路");

resetExternals();
const forJob = (await addItems({
  items: [entry({ doi: "10.5555/e.1", title: "要下的那篇" })],
})) as AddResult;

const job = DownloadJobRepo.getByItem(forJob.items[0]!.id);
check("★ 下载任务落库了", job !== null, job);
// ⚠️ 状态是 `pending` 而不是 `running`/`failed`,是**桩把它按住了**的产物:
// `enqueueDownloads` 尾巴上那句 `void processDownloadQueue()` 会真的开跑,而
// `resolvePdfCandidates` 里的 fetchJson 一被调用就抛(见 stubs/libraryHttp.ts),
// 于是这条任务的候选链空掉、下载器给它记一个 `not_found`。**它不重试** —— 所以
// "not_found" 就是这套里"队列确实跑过一轮、而且没跑成"的确定长相。
//
// 这条断言不是"验下载器"(那是 downloader 自己的事),是**前提守卫**:上面的桩要是
// 哪天被别人删了,这里会立刻变成 `done` 或抛出真网络错误,提示本套的前提没了。
check(
  "★ 队列确实跑过一轮(桩把网络按住了 → not_found,不自动重试所以状态是确定的)",
  job?.status === "not_found" || job?.status === "pending",
  job,
);

/* ══════════════════════════════════════════════════════════════════════════
 *  7. 那条事件的名字,与内置自动化触发器听的名字**逐字相同**
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n7. 内置自动化的触发事件名对不对得上");

const { AUTO_DOWNLOAD_WORKFLOW_ID, AUTO_CONVERT_WORKFLOW_ID, BUILTIN_WORKFLOWS } = await import(
  "@main/orchestration/builtins.js"
);
const { NODE_TRIGGER_EVENTS_PARAM_KEY } = await import("@contracts/nodeType");

/**
 * 从内置文档里读某个触发器节点的 `events` 参数。
 *
 * ⚠️ **故意不 import builtins 里那些私有常量**(`AUTO_DOWNLOAD_TRIGGER_NODE_ID`
 * 之类)。要钉的正是"那个**字符串字面量**写的是不是这一个" —— 把常量 import 进来
 * 比较就成了自证:两处一起改错,断言照样绿。走文档结构读出来,才是"用户实际会跑
 * 的那张图里写的是什么"。
 */
function triggerEventsOf(workflowId: string): string[] {
  const doc = BUILTIN_WORKFLOWS.find((d) => d.id === workflowId);
  if (!doc) return [];
  return doc.nodes
    .filter((n) => n.type === "mcode.trigger")
    .map((n) => String((n.params as Record<string, unknown>)[NODE_TRIGGER_EVENTS_PARAM_KEY] ?? ""));
}

same(
  "★ `wf_auto_download` 听的就是 `library.item.imported` —— 与上面发出去的那条同名",
  triggerEventsOf(AUTO_DOWNLOAD_WORKFLOW_ID),
  ["library.item.imported"],
);
same(
  "`wf_auto_convert` 听 `library.item.downloaded`(它等的是文件真下来,不是导入)",
  triggerEventsOf(AUTO_CONVERT_WORKFLOW_ID),
  ["library.item.downloaded"],
);

// 这两条事件名必须**不同**。写成同一个的话,"导入后转录"会在文件还不存在时就扑空
// —— `broadcast.ts` 的注释专门记了这件事。
check(
  "★ 两条事件的类型串不同(合成一条会让转录扑空)",
  triggerEventsOf(AUTO_DOWNLOAD_WORKFLOW_ID)[0] !== triggerEventsOf(AUTO_CONVERT_WORKFLOW_ID)[0],
);

/* ── 尾声 ── */

rmSync(DATA, { recursive: true, force: true });

console.log(`\nlibrary-intake-smoke:${checks - failures}/${checks} 通过`);
if (failures > 0) process.exit(1);
