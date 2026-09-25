/**
 * Headless smoke for **PDF 状态的两套判据**(`lib/pdfState.ts`)。
 *
 * ## 为什么单独一套
 *
 * `PdfState` 是「这条文献的 PDF 到底怎么样」在界面上的**唯一**说法:列表里那个
 * 小徽章、详情页那个按钮、以及「缺 PDF / 需要登录」两个筛选档,全都从它推出来。
 *
 * 而它有两份实现,分别写在两个包里、由两拨人读:
 *
 *   - `@contracts/library` 的 `derivePdfState` —— 渲染端拿条目 + 任务算;
 *   - `store/repositories.ts` 的 `pdfStateClause` —— 主进程拼 SQL 筛。
 *
 * 两份**必须给出同一个答案**。这一套就是拿来钉这件事的:同一组条目 + 任务,一边
 * 走 TS、一边走真 SQL,逐条比对。
 *
 * ## 它逮住过什么
 *
 * `not_found`(五个源都翻过、确实没有开放版本)原先被 `derivePdfState` 折进
 * `failed`,于是界面上只说得出「下载失败」—— 而那句话把用户引向一个没用的动作:
 * 重试。i18n 里「找不到来源」那句写好了,一直没人读得出来。
 *
 * ⚠️ 只测 TS 那一侧是**测不出这个**的:折叠成 failed 的两边都自洽,只有把两套
 * 判据放在同一张表上比,或者断言"这个状态有自己的一句话",才会红。
 *
 * ## 安全前提
 *
 * 真 sql.js 库(见 stubs/dataRoot.ts「没设就抛」)。`DownloadJobRepo.enqueue`
 * 内部就是 `persist()`,而 `persist` 重写整个 `mcode.db` —— 指错地方就是拿空库
 * 盖掉用户的聊天记录。所以数据根走 `MCODE_SMOKE_DATA_ROOT`,由 run.sh 指到 mktemp。
 *
 * Run: scripts/pdf-state-smoke/run.sh
 */
import type { LibraryItem, DownloadJob } from "@contracts/library";

let failures = 0;
let total = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  total += 1;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

/** 数组要按内容比 —— `Object.is` 比数组恒假,用它会让每一条都"红",而那种红
 *  读起来像"判据真不一致",实际只是断言写错了(`.eq` 的坑之一)。 */
function eqList(name: string, actual: readonly string[], expected: readonly string[]): void {
  const a = [...actual].sort();
  const b = [...expected].sort();
  check(name, JSON.stringify(a) === JSON.stringify(b), { actual: a, expected: b });
}

// ── 数据根必须在 import 被测模块**之前**设好(run.sh 里已 export,这里只核对) ──
if (!process.env.MCODE_SMOKE_DATA_ROOT) {
  console.error("MCODE_SMOKE_DATA_ROOT 没设 —— 这套会写库,拒绝跑。见 run.sh。");
  process.exit(2);
}

const { initDb } = await import("@main/store/db.js");
const { LibraryRepo, DownloadJobRepo } = await import("@main/store/repositories.js");
const { derivePdfState } = await import("@contracts/library");
const { PDF_STATE_ORDER } = await import("@main/lib/pdfState.js");

await initDb();

/** 建一条条目并把它推到某个任务状态上。`job: null` = 这条根本没有任务行。 */
function mk(
  id: string,
  pdfRelPath: string | null,
  job: DownloadJob["status"] | null,
  error?: string,
): LibraryItem {
  const item = LibraryRepo.upsert({ id, title: `t-${id}`, doi: `10.1/${id}` });
  if (pdfRelPath) LibraryRepo.setPdf(item.id, pdfRelPath, "sha-" + id);
  if (job) {
    DownloadJobRepo.enqueue(item.id);
    DownloadJobRepo.setStatus(item.id, job, error, job !== "pending");
  }
  return LibraryRepo.get(item.id)!;
}

// ══════════════════════════════════════════════════════════════════════
// §1 TS 侧:`derivePdfState` 对每一种任务状态都给出**自己的**答案
// ══════════════════════════════════════════════════════════════════════

console.log("\n§1 derivePdfState(渲染端那一份)");

const TS_TABLE: Array<[DownloadJob["status"] | null, string]> = [
  [null, "none"],
  ["pending", "queued"],
  ["running", "downloading"],
  ["needs_login", "needs_login"],
  ["not_found", "not_found"],
  ["rate_limited", "failed"],
  ["failed", "failed"],
  ["done", "none"], // 任务说完成了但没文件 —— 文件被外部删了,当没有,让用户重下
];

for (const [status, want] of TS_TABLE) {
  const got = derivePdfState({ pdfPath: undefined }, status ? { status } : null);
  eq(`没有 PDF + ${status ?? "无任务"} → ${want}`, got, want);
}

// 有文件就一律 ready —— 不管任务停在哪个状态(可能是手动导入的,或下完又失败重试过)
for (const [status] of TS_TABLE) {
  const got = derivePdfState({ pdfPath: "papers/aa/bb/x.pdf" }, status ? { status } : null);
  eq(`有 PDF + ${status ?? "无任务"} → ready`, got, "ready");
}

// ══════════════════════════════════════════════════════════════════════
// §2 两套判据必须一致 —— 同一组数据,TS 算一遍、SQL 筛一遍,逐条比
// ══════════════════════════════════════════════════════════════════════

console.log("\n§2 两套判据(NOT_FOUND 分开之后)");

const FIXTURES: Array<[string, DownloadJob["status"] | null, string | null]> = [
  ["a-none", null, null],
  ["a-pending", "pending", null],
  ["a-running", "running", null],
  ["a-needslogin", "needs_login", null],
  ["a-notfound", "not_found", null],
  ["a-ratelimited", "rate_limited", null],
  ["a-failed", "failed", null],
  ["a-done", "done", null],
  ["b-ready", null, "papers/b-ready.pdf"],
];

const items = FIXTURES.map(([id, st, pdf]) => mk(id, pdf, st, st === "failed" ? "connection reset" : undefined));

for (const state of PDF_STATE_ORDER) {
  const byTs = items.filter((i) => derivePdfState(i, DownloadJobRepo.getByItem(i.id)) === state);
  const bySql = LibraryRepo.list({ pdfState: state, limit: 100 }).items;

  eqList(
    `「${state}」TS 与 SQL 选出同一批`,
    byTs.map((i) => i.id),
    bySql.map((i) => i.id),
  );
}

// 每个夹具都必须被**某一档**选中。少了这一条,"两套都漏掉同一种状态"会被
// 上面那组比对判成通过 —— 两边都空,字符串相等。
const covered = new Set<string>();
for (const state of PDF_STATE_ORDER) {
  for (const i of LibraryRepo.list({ pdfState: state, limit: 100 }).items) covered.add(i.id);
}
eqList(
  "★ 每条夹具都至少落进一档(不然「两套一致地漏掉」也会判通过)",
  FIXTURES.map(([id]) => id).filter((id) => !covered.has(id)),
  [],
);

// ══════════════════════════════════════════════════════════════════════
// §3 两套的**分档**本身 —— 每一条都点着名说它落哪一档
// ══════════════════════════════════════════════════════════════════════

console.log("\n§3 分档");

const EXPECT: Record<string, string> = {
  "a-none": "none",
  "a-pending": "queued",
  "a-running": "downloading",
  "a-needslogin": "needs_login",
  "a-notfound": "not_found",
  "a-ratelimited": "failed",
  "a-failed": "failed",
  "a-done": "none",
  "b-ready": "ready",
};
for (const it of items) {
  const got = derivePdfState(it, DownloadJobRepo.getByItem(it.id));
  eq(`夹具 ${it.id}`, got, EXPECT[it.id]);
}

// ★ 这一条是这次改动本身:`not_found` 与 `rate_limited` 的任务状态不同,
//   界面上就该是两句不同的话。折回 failed 的话这里立刻红。
check(
  "★ not_found 不被折进 failed(它俩的任务状态本来就不同)",
  derivePdfState({ pdfPath: undefined }, { status: "not_found" }) !==
    derivePdfState({ pdfPath: undefined }, { status: "rate_limited" }),
  {
    notFound: derivePdfState({ pdfPath: undefined }, { status: "not_found" }),
    rateLimited: derivePdfState({ pdfPath: undefined }, { status: "rate_limited" }),
  },
);

// ══════════════════════════════════════════════════════════════════════
// §4 失败原因要能传出来(详情页显示的就是它)
// ══════════════════════════════════════════════════════════════════════

console.log("\n§4 失败原因");

const j = DownloadJobRepo.getByItem("a-failed");
eq("任务上留着给用户看的原因", j?.error, "connection reset");

// ══════════════════════════════════════════════════════════════════════

console.log("");
if (failures > 0) console.log(`${failures} 条失败`);
console.log(`pdf-state-smoke:${total - failures}/${total} 通过`);
process.exit(failures > 0 ? 1 : 0);
