/**
 * 工作簿级读取（`readWorkbookSheets` / `readAnyDocument` 的 xlsx 分支）。
 *
 * ## 它证明什么
 *
 * 从前 xlsx 只读**活动的那一张表**，其余工作表既读不到、也不会被记成「没读」——
 * 调用方看到的是一个完整形状的块数组，于是把「只读到一张表」当成「整本读完」。
 *
 * 这套用**假 CLI**（`process.execPath` 跑一个 cjs 桩，与 document-read-smoke 同一
 * 手法）精确控制 `sheet read` 的每一次回包，因此能断言：
 *
 *   1. 非活动工作表**真的被请求**（argv 里出现 `--sheet <name>`）；
 *   2. 每行块带上**自己的表名**，不是全部算在活动表头上；
 *   3. 没读到的表**显式**出现在 `sheetLedger.unreadSheets`，并且 `truncated` 为真；
 *   4. 全部读到时 `unreadSheets` 为空、`truncated` **不出现**（complete 的证据）；
 *   5. 表名清单拿不到时**不猜**表名（`sheetsUnknownReason`），只读活动表。
 *
 * ## 边界（本套件不证明的）
 *
 * - 不跑真 GenOffice CLI（那条路由由 `library-document-index-smoke` 用真 CLI 覆盖）；
 * - 不验证 spreadsheet 内容正确性（只验证「读到了哪些表」这件事的账目）。
 *
 * 印在每次输出里，读日志的人不必翻卡：
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorkbookSheets, readAnyDocument, workbookSheetList } from "../../src/main/document/genofficeCli.js";
import type { GenofficePorts } from "../../src/main/document/genofficeCli.js";

// esbuild 把本文件打包成 ESM；`require` 不一定存在，走 createRequire 更稳。
const require = createRequire(import.meta.url);

console.log("COVERAGE: workbook-level xlsx reading (sheet fan-out + coverage ledger), fake CLI");
console.log("NOT-COVERED: real GenOffice CLI parsing; cell value correctness; row-count truncation semantics beyond the CLI flag");

let total = 0;
let fail = 0;
function ck(label: string, yes: boolean, detail?: unknown): void {
  total += 1;
  if (!yes) fail += 1;
  console.log((yes ? "PASS " : "FAIL ") + label + (yes || detail === undefined ? "" : " :: " + JSON.stringify(detail)));
}

const root = mkdtempSync(join(tmpdir(), "mcode-workbook-"));
// 每本工作簿的「CLI」在收到什么 argv 时回什么包，由这些小表决定。
// 每次调用都把 argv 追加到 log，套件据此断言「到底请求了哪些表」。
const calls: string[][] = [];

/** 造一个假 CLI。`behavior` 决定每种 argv 的回应。 */
function fakeCli(name: string, behavior: {
  sheets?: string[] | null;
  activeSheet?: string;
  rowsFor?: (sheet: string | null) => unknown[][];
  truncatedSheets?: string[];
  failSheets?: string[];
}): string {
  const file = join(root, name);
  const config = JSON.stringify({
    sheets: behavior.sheets === undefined ? null : behavior.sheets,
    activeSheet: behavior.activeSheet ?? null,
    truncatedSheets: behavior.truncatedSheets ?? [],
    failSheets: behavior.failSheets ?? [],
  });
  writeFileSync(file, `
const args = process.argv.slice(2);
const cfg = ${config};
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const has = (name) => args.includes(name);
const sheet = flag("--sheet");
require("node:fs").appendFileSync(${JSON.stringify(join(root, "calls.log"))}, JSON.stringify(args) + "\\n");
function out(value) { process.stdout.write(JSON.stringify(value) + "\\n"); process.exit(0); }
if (has("--stats")) {
  if (!Array.isArray(cfg.sheets)) out({ status: "ok", summary: "no sheet list", detail: { sheet: cfg.activeSheet, stats: { sheets: null } } });
  out({ status: "ok", summary: "stats", detail: {
    sheet: cfg.activeSheet,
    stats: { sheets: cfg.sheets.map((n) => ({ name: n, rows: 1, columns: 1 })) },
    rows: [], formulas: {},
  } });
}
if (sheet && cfg.failSheets.includes(sheet)) out({ status: "error", error: "sheet_unreadable", message: "cannot read " + sheet });
const name = sheet ?? cfg.activeSheet;
out({ status: "ok", summary: "read " + name, detail: {
  sheet: name,
  range: "A1:B2",
  rows: [[name + "_TOKEN", 1], [name + "_SECOND", 2]],
  formulas: {},
  truncated: cfg.truncatedSheets.includes(name),
  rowsShown: 2, rowsTotal: 2,
} });
`);
  return file;
}

const workbookPath = join(root, "book.xlsx");
writeFileSync(workbookPath, "synthetic workbook placeholder");
const ports = (cliPath: string): GenofficePorts => ({ cliPath, withinWorkspace: (p) => p.startsWith(root) });

function readCalls(): string[][] {
  try {
    return readFileSync(join(root, "calls.log"), "utf8").trim().split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
  } catch {
    return [];
  }
}

try {
  // ── 1. 三张表：活动表 + 两张非活动表都要读到 ──────────────────────────
  rmSync(join(root, "calls.log"), { force: true });
  const multi = fakeCli("multi.cjs", { sheets: ["Summary", "Detail", "Notes"], activeSheet: "Summary" });
  const book = await readWorkbookSheets(ports(multi), workbookPath);
  ck("工作簿级读取成功", book.ok === true, book);
  if (book.ok) {
    ck("★ 非活动工作表也被请求（argv 出现 --sheet Detail / --sheet Notes）",
      readCalls().some((a) => a.includes("--sheet") && a[a.indexOf("--sheet") + 1] === "Detail") &&
      readCalls().some((a) => a.includes("--sheet") && a[a.indexOf("--sheet") + 1] === "Notes"),
      readCalls());
    ck("★ 三张表的内容都进了块数组", book.items.length === 6, book.items.length);
    ck("每行块带自己的表名（不是全算在活动表头上）",
      JSON.stringify(book.items).includes("[sheet Detail] Detail_TOKEN") &&
      JSON.stringify(book.items).includes("[sheet Notes] Notes_TOKEN"));
    ck("读到的表按读取顺序记账", JSON.stringify(book.ledger.readSheets) === JSON.stringify(["Summary", "Detail", "Notes"]), book.ledger);
    ck("全读到时 unreadSheets 为空", book.ledger.unreadSheets.length === 0, book.ledger);
    ck("活动表取自第一张读到的表", book.ledger.activeSheet === "Summary", book.ledger.activeSheet);
  }

  // ── 2. 表太多：补读上限之外的表必须显式记为未读 ──────────────────────
  rmSync(join(root, "calls.log"), { force: true });
  const many = fakeCli("many.cjs", {
    sheets: ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10"],
    activeSheet: "S1",
  });
  const capped = await readWorkbookSheets(ports(many), workbookPath);
  ck("超上限的工作簿仍然读取成功", capped.ok === true, capped);
  if (capped.ok) {
    ck("★ 超过补读上限的表显式记为未读，不静默丢弃",
      capped.ledger.unreadSheets.length > 0, capped.ledger);
    ck("未读表 + 已读表 = 全部表", capped.ledger.readSheets.length + capped.ledger.unreadSheets.length === 10, capped.ledger);
    ck("每一行仍带表名", capped.items.every((item) => /^\[sheet S\d+\]/.test((item as { text?: string }).text ?? "")), capped.items.slice(0, 2));
  }

  // ── 3. 单表失败不吞掉整本 ────────────────────────────────────────────
  rmSync(join(root, "calls.log"), { force: true });
  const broken = fakeCli("broken.cjs", { sheets: ["A", "B", "C"], activeSheet: "A", failSheets: ["B"] });
  const partialBook = await readWorkbookSheets(ports(broken), workbookPath);
  ck("一张表读失败时整本仍然成功", partialBook.ok === true, partialBook);
  if (partialBook.ok) {
    ck("★ 读失败的表出现在 unreadSheets 里", partialBook.ledger.unreadSheets.includes("B"), partialBook.ledger);
    ck("其余表仍然读到了", partialBook.ledger.readSheets.includes("A") && partialBook.ledger.readSheets.includes("C"), partialBook.ledger);
  }

  // ── 4. 表名清单拿不到：不猜表名，只读活动表 ──────────────────────────
  rmSync(join(root, "calls.log"), { force: true });
  const noList = fakeCli("nolist.cjs", { sheets: null, activeSheet: "OnlyKnown" });
  const noListBook = await readWorkbookSheets(ports(noList), workbookPath);
  ck("拿不到表名清单时仍读到活动表", noListBook.ok === true, noListBook);
  if (noListBook.ok) {
    ck("★ 缺清单时给出原因，而不是假装整本读完",
      typeof noListBook.ledger.sheetsUnknownReason === "string" && noListBook.ledger.sheetsUnknownReason.length > 0,
      noListBook.ledger);
    ck("没猜出任何表名", noListBook.ledger.sheets.length === 0, noListBook.ledger);
    ck("只读了活动表", JSON.stringify(noListBook.ledger.readSheets) === JSON.stringify(["OnlyKnown"]), noListBook.ledger);
  }

  // ── 5. 行被截断的表要记账 ────────────────────────────────────────────
  rmSync(join(root, "calls.log"), { force: true });
  const longSheet = fakeCli("long.cjs", { sheets: ["Big"], activeSheet: "Big", truncatedSheets: ["Big"] });
  const longBook = await readWorkbookSheets(ports(longSheet), workbookPath);
  ck("行被截断的表进入 truncatedSheets",
    longBook.ok === true && longBook.ledger.truncatedSheets.includes("Big"), longBook);

  // ── 6. readAnyDocument 的 xlsx 分支把账目与 truncated 一起交出去 ──────
  rmSync(join(root, "calls.log"), { force: true });
  const viaAny = fakeCli("any.cjs", { sheets: ["First", "Second"], activeSheet: "First" });
  const read = await readAnyDocument(ports(viaAny), workbookPath);
  ck("readAnyDocument 读到 xlsx", read.ok === true, read);
  if (read.ok) {
    const detail = read.envelope.detail as {
      via?: unknown; structured?: unknown; truncated?: unknown; items?: unknown[];
      sheetLedger?: { readSheets?: string[]; unreadSheets?: string[] };
    };
    ck("信封标出 via=sheet read 且非结构读", detail.via === "sheet read" && detail.structured === false, detail.via);
    ck("★ 账目随信封一起交给调用方", Array.isArray(detail.sheetLedger?.readSheets) && detail.sheetLedger!.readSheets!.length === 2, detail.sheetLedger);
    ck("全读到时信封不带 truncated", detail.truncated === undefined, detail.truncated);
    ck("块数组包含两张表的内容", (detail.items ?? []).length === 4, (detail.items ?? []).length);
  }

  // ── 7. 没读完时信封必须带 truncated（下游 coverage 判据共用这个信号）──
  const manyAny = fakeCli("manyany.cjs", {
    sheets: ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9"],
    activeSheet: "S1",
  });
  const partialRead = await readAnyDocument(ports(manyAny), workbookPath);
  ck("★ 没读完时信封带 truncated=true",
    partialRead.ok === true && (partialRead.envelope.detail as { truncated?: unknown }).truncated === true, partialRead);

  // ── 8. workbookSheetList 只回表名，不读内容 ──────────────────────────
  rmSync(join(root, "calls.log"), { force: true });
  const lister = fakeCli("lister.cjs", { sheets: ["Alpha", "Beta"], activeSheet: "Alpha" });
  const names = await workbookSheetList(ports(lister), workbookPath);
  ck("workbookSheetList 返回全部表名", JSON.stringify(names) === JSON.stringify(["Alpha", "Beta"]), names);
  ck("取表名只需要一次 --stats 调用", readCalls().length === 1 && readCalls()[0]!.includes("--stats"), readCalls());
  const noNames = await workbookSheetList(ports(fakeCli("nolist2.cjs", { sheets: null, activeSheet: "X" })), workbookPath);
  ck("拿不到清单时回 null（不编造空表以外的结构）", noNames === null, noNames);

  // ── 9. pptx 讲稿备注：不能整段丢掉 ────────────────────────────────────
  // 备注在页对象的 `notes` 字段上（不是 elements），早期版本只取 elements，
  // 于是备注被静默丢弃而输出看起来完全正常 —— 这里钉住它真的进来了。
  const deckCli = join(root, "deck.cjs");
  writeFileSync(deckCli, `
const args = process.argv.slice(2);
const out = (v) => { process.stdout.write(JSON.stringify(v) + "\\n"); process.exit(0); };
out({ status: "ok", summary: "deck", detail: { pages: [
  { index: 0, elements: [{ type: "text", text: "SLIDE_ONE_TITLE" }], notes: "SPEAKER_NOTE_ONE" },
  { index: 1, elements: [{ type: "text", text: "SLIDE_TWO_TITLE" }] },
] } });
`);
  const deckPath = join(root, "deck.pptx");
  writeFileSync(deckPath, "synthetic deck placeholder");
  const deckRead = await readAnyDocument(ports(deckCli), deckPath);
  ck("pptx 读取成功", deckRead.ok === true, deckRead);
  if (deckRead.ok) {
    const items = ((deckRead.envelope.detail as { items?: unknown[] }).items ?? []) as Array<{ type?: string; text?: string }>;
    ck("★ 演讲者备注进入块数组（不再被静默丢弃）",
      items.some((b) => b.type === "notes" && (b.text ?? "").includes("SPEAKER_NOTE_ONE")), items);
    ck("备注块带同一页码，可与正文互相对应",
      items.some((b) => b.type === "notes" && (b.text ?? "").includes("[slide 1 notes]")), items);
    ck("没有备注的页不产生空备注块", items.filter((b) => b.type === "notes").length === 1, items);
    ck("页正文仍然完整", items.some((b) => (b.text ?? "").includes("SLIDE_TWO_TITLE")), items);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`workbook-sheets-smoke: ${total - fail}/${total}`);
if (fail > 0) process.exitCode = 1;
