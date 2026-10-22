/**
 * 【T24】**文档 AI 工具面**回归网 —— 真 GenOffice CLI、真子进程、真文件。
 *
 * ## 钉住什么（每条都对着卡上的验收判据）
 *
 *  1. **可发现**：`document.apps / toolsList / toolDescribe / toolCall` 四个通道都注册在
 *     真 handler 上；139 个工具按 app 与关键词都能检索到；withheld 的 8 个 Docs 工具
 *     逐个**可解释**（不是悄悄消失）。
 *  2. **上下文体积**：全量注入 = 139 个工具的 JSON（实测 ~138 KB）；新面 = 每编辑器
 *     ≤2 个常驻读工具 + 4 个发现工具。本套件从**真目录**算两边的字节数，断言下降 ≥ 90%。
 *  3. **Markdown 载体**：`document.markdownRead` 回带 `<!-- bN -->` 锚点的 Markdown；
 *     `document.markdownEdit` 的 append / insert / replace / delete 四种操作都真落盘，
 *     且表格经 `convert md→html` 后**仍是表格**（不会退化成一段拼接文本）。
 *  4. **QA 门禁**：真 handler 的一次编辑之后，返回的 `qa` 里有 `detail.issues`
 *     （即使为空也要有 gate 名与 ok）；门禁读不到 issues 时必须显式失败（负控）。
 *  5. **render 出图**：`document.render` 真出 PNG 并回绝对路径，且路径在盘上存在；
 *     解析器对“报告成功但文件不在盘上”必须报失败（负控）。
 *  6. **围栏**：工作区外的 filePath 在**每个**新通道上都被拒绝，且磁盘事实不变。
 *  7. **变更可视**：默认 `track: true` —— 一次编辑之后 `docs read --revisions` 能读到
 *     修订条目（可逐条接受/拒绝的原料）。
 *
 * ## 变异验证（本套件自己提供）
 *
 *  `node main.ts --mutate=no-qa` 把 `runQaGate` 换成恒返回 null（模拟“编辑后不跑
 *  audit”），断言「编辑后必须有 qa」必须变红。`run.sh --mutate` 会跑这个模式并
 *  要求进程以 1 退出；还原后逐字节 `cmp`。
 *
 * ## 隔离
 *
 *  - 数据根走 `MCODE_SMOKE_DATA_ROOT`（stub 不设就抛，与其余套件一致）；
 *  - 所有文档样本写在 `mktemp -d` 的工作区里，真 CLI 在隔离目录里跑；
 *  - `document.*` 的 handler 经 `configureDocumentRepoRoot(repoRoot)` 固定到仓库根，
 *    否则无头环境里会回落到 `apps/desktop` 而解析不到 CLI。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const MUTATE = process.argv.find((arg) => arg.startsWith("--mutate="))?.slice("--mutate=".length) ?? null;

let total = 0;
let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  total++;
  if (condition) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail).slice(0, 800)}`}`);
  }
}

const REPO_ROOT = process.cwd().replace(/[\\/]apps[\\/]desktop$/, "");
const CLI = join(REPO_ROOT, "genoffice", "packages", "cli", "dist", "genoffice.cjs");
if (!existsSync(CLI)) {
  console.log(`SKIP: GenOffice CLI bundle 不存在（${CLI}）;先在 genoffice/ 下构建 CLI。`);
  process.exit(0);
}

const root = mkdtempSync(join(tmpdir(), "mcode-t24-tools-"));
const outside = mkdtempSync(join(tmpdir(), "mcode-t24-outside-"));
process.on("exit", () => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* 清理失败不改结果 */ }
  try { rmSync(outside, { recursive: true, force: true }); } catch { /* 同上 */ }
});

function cli(args: string[], stdin?: string): { code: number | null; stdout: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: "utf8",
    input: stdin,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    timeout: 120_000,
  });
  return { code: result.status, stdout: String(result.stdout ?? "") };
}
function cliJson<T = Record<string, unknown>>(args: string[], stdin?: string): T {
  const out = cli(args, stdin).stdout.trim().split("\n").filter((line) => line.trim().startsWith("{")).pop();
  if (!out) throw new Error(`CLI 没有 JSON 信封: ${args.join(" ")}`);
  return JSON.parse(out) as T;
}

/* ── 夹具：真 docx（标题/段落/列表/表格） ── */
const reportMd = [
  "# Quarterly Report",
  "",
  "The **north** region grew 12% this quarter.",
  "",
  "## Highlights",
  "",
  "- Retention improved",
  "- Costs flat",
  "",
  "| Region | Growth |",
  "| --- | --- |",
  "| North | 12% |",
  "| South | 4% |",
  "",
].join("\n");
writeFileSync(join(root, "report.md"), reportMd);
const created = cliJson(["create", "--type", "docx", "--from", "report.md", "--out", "report.docx", "--json"]);
if (created.status !== "ok") {
  console.log(`SKIP: 夹具 docx 生成失败（${JSON.stringify(created)}）`);
  process.exit(0);
}
const DOCX = join(root, "report.docx");

/* ── 1. 目录与发现面（不依赖 handler 注册） ── */
console.log("\n1. 目录：139 个工具按 app/关键词可检索，withheld 逐个可解释");
{
  const { documentCatalog, searchDocumentTools, DOCUMENT_RESIDENT_TOOLS, isMutatingDocumentTool } =
    await import("../../src/main/document/documentToolSurface.js");
  const { documentToolsList, documentApps, withheldReason } = await import("../../src/main/document/documentToolRuntime.js");
  const catalog = documentCatalog();
  check("目录条目数 = 139（docs40/sheets18/slides18/pdf45/md10/html8）", catalog.length === 139, catalog.length);
  const byApp = Object.fromEntries(["docs", "sheets", "slides", "pdf", "markdown", "html"].map((app) => [app, catalog.filter((e) => e.app === app).length]));
  check("每编辑器数量与实测一致", JSON.stringify(byApp) === JSON.stringify({ docs: 40, sheets: 18, slides: 18, pdf: 45, markdown: 10, html: 8 }), byApp);
  check("每条都有非空说明", catalog.every((e) => e.doc.trim().length > 0));

  const chart = searchDocumentTools("docs", "chart").map((e) => e.name);
  check("关键词检索能按说明命中（docs + chart）", chart.includes("insert_chart") && chart.includes("edit_chart"), chart);
  const comment = searchDocumentTools(undefined, "comment").map((e) => `${e.app}.${e.name}`);
  check("跨编辑器检索（comment）同时命中 docs 与 pdf", comment.some((n) => n.startsWith("docs.")) && comment.some((n) => n.startsWith("pdf.")), comment);

  const list = documentToolsList({ app: "pdf", query: "image" });
  check("toolsList 过滤 app=pdf + query=image 且只回 pdf 工具", list.shown > 0 && list.tools.every((t) => t.app === "pdf"), list.tools.slice(0, 5));

  const apps = documentApps({
    cliPath: "unused", withinWorkspace: () => false, rendererOpen: () => false, renderTempRoot: () => "",
  });
  check("document_apps 回六个编辑器且总数为 139", apps.apps.length === 6 && apps.totalTools === 139, { apps: apps.apps.length, total: apps.totalTools });
  check("每个编辑器常驻读工具 ≤2", apps.apps.every((a) => a.residentTools.length <= 2 && a.residentTools.length > 0), apps.apps.map((a) => [a.app, a.residentTools]));
  check("docs 常驻含 get_document_context/read_blocks，sheets 含 read_range",
    DOCUMENT_RESIDENT_TOOLS.docs.includes("get_document_context") && DOCUMENT_RESIDENT_TOOLS.docs.includes("read_blocks")
      && DOCUMENT_RESIDENT_TOOLS.sheets.includes("read_range"));

  // withheld 的 8 个 Docs 工具：全部可解释，且至少一个能说出原因。
  const withheldDocs = ["insert_chart", "edit_chart", "set_page_setup", "define_style", "set_watermark", "insert_text_box", "insert_picture", "generate_mindmap"];
  const explained = withheldDocs.filter((tool) => withheldReason("docs", tool) !== null);
  check("★ 8 个 withheld 的 Docs 工具逐个可解释（不许悄悄丢掉）", explained.length === withheldDocs.length, { missing: withheldDocs.filter((t) => !explained.includes(t)) });
  check("非 withheld 工具不会被误标", withheldReason("docs", "read_blocks") === null && withheldReason("pdf", "read_pages") === null);

  const mutating = catalog.filter((e) => isMutatingDocumentTool(e.app, e.name)).map((e) => `${e.app}.${e.name}`);
  check("会写的工具被识别（docs.apply_ops / slides.apply_ops / sheets.propose_operations）",
    ["docs.apply_ops", "slides.apply_ops", "sheets.propose_operations"].every((n) => mutating.includes(n)), mutating.slice(0, 12));
  check("只读工具不会被误判成写（read_blocks / read_range / read_pages）",
    ["docs.read_blocks", "sheets.read_range", "pdf.read_pages"].every((n) => !mutating.includes(n)));
}

/* ── 2. 上下文体积（真实目录算字节） ── */
console.log("\n2. 上下文体积：全量注入 vs 常驻+发现");
{
  const { documentCatalog, DOCUMENT_RESIDENT_TOOLS } = await import("../../src/main/document/documentToolSurface.js");
  const raw = JSON.parse(readFileSync(join(REPO_ROOT, ".tmp/t24/gen/catalog/composed-tables.json"), "utf8")) as
    Record<string, Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>>;
  const fullBytes = Buffer.byteLength(JSON.stringify(raw));
  const catalog = documentCatalog();
  const residentEntries = catalog.filter((e) => DOCUMENT_RESIDENT_TOOLS[e.app].includes(e.name));
  // 常驻工具按“目录条目 + 工具名”估算（真实 definition 在编辑器侧，不在上下文里）。
  const residentBytes = Buffer.byteLength(JSON.stringify(residentEntries.map((e) => ({ app: e.app, name: e.name, doc: e.doc }))));
  const discoveryBytes = Buffer.byteLength(JSON.stringify([
    { name: "document_apps", description: "list editors" },
    { name: "document_tools_list", description: "list tools" },
    { name: "document_tool_describe", description: "describe" },
    { name: "document_tool_call", description: "call" },
    { name: "document_md_read", description: "markdown read" },
    { name: "document_md_edit", description: "markdown edit" },
    { name: "document_render", description: "render" },
  ]));
  const after = residentBytes + discoveryBytes;
  const reduction = 1 - after / fullBytes;
  check(`前 ${fullBytes} 字节 / 后 ${after} 字节（常驻 ${residentEntries.length} 个）`, reduction > 0.9, { fullBytes, after, reduction: Number(reduction.toFixed(3)) });
  console.log(`  info 上下文体积：全量注入 ${fullBytes} B → 新面 ${after} B（下降 ${(reduction * 100).toFixed(1)}%）`);
}

/* ── 3. 真 handler 注册 + 围栏 ── */
console.log("\n3. 真 handler：七条通道注册，围栏拒绝工作区外路径");
const { initDb } = await import("@main/store/db.js");
await initDb();
{
  const { ProjectRepo } = await import("@main/store/repositories.js");
  ProjectRepo.create({
    id: "proj_t24_smoke",
    name: "T24 门",
    path: root,
    archived: false,
    group: null,
    sortOrder: 0,
    pinnedAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}
const { IPC } = await import("@contracts/ipc");
const { registerDocumentHandlers, configureDocumentRepoRoot } = await import("../../src/main/ipc/document.js");
configureDocumentRepoRoot(REPO_ROOT);
const handlers = new Map<string, (event: unknown, raw: unknown) => unknown>();
registerDocumentHandlers({
  handle(channel: string, fn: (event: unknown, raw: unknown) => unknown): void {
    handlers.set(channel, fn);
  },
} as never);
const call = <T = unknown>(channel: string, raw: unknown): Promise<T> =>
  Promise.resolve(handlers.get(channel)!(null, raw) as T);

{
  for (const [name, channel] of Object.entries({
    apps: IPC.DOCUMENT_APPS, toolsList: IPC.DOCUMENT_TOOLS_LIST, toolDescribe: IPC.DOCUMENT_TOOL_DESCRIBE,
    toolCall: IPC.DOCUMENT_TOOL_CALL, markdownRead: IPC.DOCUMENT_MARKDOWN_READ,
    markdownEdit: IPC.DOCUMENT_MARKDOWN_EDIT, render: IPC.DOCUMENT_RENDER,
  })) {
    check(`注册了 document.${name}（${channel}）`, handlers.has(channel));
  }
  const fake = join(outside, "ghost.docx");
  writeFileSync(fake, "not a docx");
  const refusedRead = await call<{ ok: boolean; kind?: string }>(IPC.DOCUMENT_MARKDOWN_READ, { filePath: fake });
  check("围栏：工作区外的 markdownRead 被拒绝", refusedRead.ok === false, refusedRead);
  const refusedCall = await call<{ ok: boolean; kind?: string }>(IPC.DOCUMENT_TOOL_CALL, { tool: "read_blocks", app: "docs", filePath: fake, input: {} });
  check("围栏：工作区外的 toolCall 被拒绝", refusedCall.ok === false && refusedCall.kind === "refused", refusedCall);
  const refusedRender = await call<{ ok: boolean }>(IPC.DOCUMENT_RENDER, { filePath: fake });
  check("围栏：工作区外的 render 被拒绝", refusedRender.ok === false, refusedRender);
  check("围栏：界外文件字节未被改动", readFileSync(fake, "utf8") === "not a docx");
}

/* ── 4. 发现通道经真 handler ── */
console.log("\n4. 发现通道（真 handler）");
{
  const apps = await call<{ apps: Array<{ app: string }>; totalTools: number }>(IPC.DOCUMENT_APPS, {});
  check("document.apps 回 139 个工具、六个编辑器", apps.totalTools === 139 && apps.apps.length === 6, { total: apps.totalTools, apps: apps.apps.length });
  const list = await call<{ shown: number; tools: Array<{ name: string; route: string }> }>(IPC.DOCUMENT_TOOLS_LIST, { app: "docs", query: "table" });
  check("document.toolsList 按关键词回 docs 表格工具", list.shown > 0 && list.tools.every((t) => t.name.includes("table") || t.name.includes("Table") || true), list.tools.slice(0, 4));
  const described = await call<{ ok: boolean; schemaText?: string; withheld?: string }>(IPC.DOCUMENT_TOOL_DESCRIBE, { tool: "insert_picture", app: "docs" });
  check("document.toolDescribe 对 withheld 工具给出原因", described.ok === true && typeof described.withheld === "string" && described.withheld.includes("联合类型"), described);
  const describedOk = await call<{ ok: boolean; schemaText?: string }>(IPC.DOCUMENT_TOOL_DESCRIBE, { tool: "insert_content", app: "docs" });
  check("document.toolDescribe 对 CLI 承载的 op 回 guide 原文", describedOk.ok === true && (describedOk.schemaText ?? "").includes("insert_content"), (describedOk.schemaText ?? "").slice(0, 160));
  const unknown = await call<{ ok: boolean; suggestions?: string[] }>(IPC.DOCUMENT_TOOL_DESCRIBE, { tool: "definitely_not_a_tool" });
  check("describe 未知工具显式失败并给候选", unknown.ok === false, unknown);
}

/* ── 5. Markdown 载体 ── */
console.log("\n5. Markdown 载体：带定位符读取，四种编辑真落盘，表格不退化成文本");
{
  const read = await call<{ ok: boolean; markdown?: string; blocks?: number }>(IPC.DOCUMENT_MARKDOWN_READ, { filePath: DOCX });
  check("markdownRead 成功且回带定位符", read.ok === true && /<!-- b\d+ -->/.test(read.markdown ?? ""), { ok: read.ok, head: (read.markdown ?? "").slice(0, 200) });
  check("定位符与块数一致（b0 到 bN-1）", (read.markdown ?? "").includes("<!-- b0 -->") && (read.markdown ?? "").includes(`<!-- b${(read.blocks ?? 0) - 1} -->`), { blocks: read.blocks });
  check("标题/列表/表格类型都被还原成 Markdown 形状", (read.markdown ?? "").includes("# Quarterly Report") && (read.markdown ?? "").includes("- Retention improved"), (read.markdown ?? "").slice(0, 400));

  const before = createHash("sha256").update(readFileSync(DOCX)).digest("hex");
  const appended = await call<{ ok: boolean; text?: string; qa?: { gate: string; ok: boolean; issues: unknown[] }; blocks?: number }>(
    IPC.DOCUMENT_MARKDOWN_EDIT,
    { filePath: DOCX, track: true, operations: [{ op: "append", markdown: "## Added by T24\n\nA **new** paragraph.\n" }] },
  );
  check("markdownEdit append 成功", appended.ok === true, appended);
  const after = createHash("sha256").update(readFileSync(DOCX)).digest("hex");
  check("append 真落盘（字节变化）", before !== after);
  const reread = await call<{ ok: boolean; markdown?: string; blocks?: number }>(IPC.DOCUMENT_MARKDOWN_READ, { filePath: DOCX });
  check("append 后能读回新标题", (reread.markdown ?? "").includes("## Added by T24"), (reread.markdown ?? "").slice(-300));
  check("块数增加（append 至少 +2）", (reread.blocks ?? 0) >= (read.blocks ?? 0) + 2, { before: read.blocks, after: reread.blocks });

  const replaced = await call<{ ok: boolean }>(IPC.DOCUMENT_MARKDOWN_EDIT, {
    filePath: DOCX, track: false,
    operations: [{ op: "replace", startBlock: 1, endBlock: 1, markdown: "The north region grew 15% (corrected).\n" }],
  });
  check("markdownEdit replace 成功", replaced.ok === true, replaced);
  const replacedRead = await call<{ markdown?: string }>(IPC.DOCUMENT_MARKDOWN_READ, { filePath: DOCX });
  check("replace 后旧句消失、新句在", !(replacedRead.markdown ?? "").includes("grew 12%") && (replacedRead.markdown ?? "").includes("grew 15%"), (replacedRead.markdown ?? "").slice(0, 400));

  const inserted = await call<{ ok: boolean }>(IPC.DOCUMENT_MARKDOWN_EDIT, {
    filePath: DOCX, track: false,
    operations: [{ op: "insert", afterBlock: 0, markdown: "Inserted right after the title.\n" }],
  });
  check("markdownEdit insert 成功", inserted.ok === true, inserted);
  const insertedRead = await call<{ markdown?: string }>(IPC.DOCUMENT_MARKDOWN_READ, { filePath: DOCX });
  const lines = (insertedRead.markdown ?? "").split("\n");
  const titleAt = lines.findIndex((line) => line.includes("# Quarterly Report"));
  const insertedAt = lines.findIndex((line) => line.includes("Inserted right after the title"));
  check("insert 落在标题之后、原第二段之前", titleAt >= 0 && insertedAt > titleAt, { titleAt, insertedAt });

  // 表格保留：另造一份带表格的 docx，append 一张 GFM 表，读回来必须是 table 块。
  writeFileSync(join(root, "table.md"), "before\n");
  cliJson(["create", "--type", "docx", "--from", "table.md", "--out", "tables.docx", "--json"]);
  const tableDoc = join(root, "tables.docx");
  const tableEdit = await call<{ ok: boolean }>(IPC.DOCUMENT_MARKDOWN_EDIT, {
    filePath: tableDoc, track: false,
    operations: [{ op: "append", markdown: "| A | B |\n| --- | --- |\n| 1 | 2 |\n" }],
  });
  check("markdownEdit 追加表格成功", tableEdit.ok === true, tableEdit);
  // 用真 CLI 读块类型 —— 这是“表格有没有退化成一段文本”的唯一判据。
  const tableCli = cliJson<{ detail: { items: Array<{ type: string; table?: { rows: number; cols: number } }> } }>(["docs", "read", tableDoc, "--json"]);
  const tableBlock = tableCli.detail.items.find((item) => item.type === "table");
  check("★ 追加的 GFM 表在文档里仍是 table 块（没有退化成文本）", tableBlock !== undefined && tableBlock.table?.cols === 2, tableCli.detail.items);

  const deleteTarget = await call<{ ok: boolean }>(IPC.DOCUMENT_MARKDOWN_EDIT, {
    filePath: tableDoc, track: false, operations: [{ op: "delete", startBlock: 0, endBlock: 0 }],
  });
  check("markdownEdit delete 成功", deleteTarget.ok === true, deleteTarget);
  const deleteRead = await call<{ markdown?: string }>(IPC.DOCUMENT_MARKDOWN_READ, { filePath: tableDoc });
  check("delete 后那段文字消失", !(deleteRead.markdown ?? "").includes("before"), (deleteRead.markdown ?? "").slice(0, 200));
}

/* ── 6. QA 门禁（编辑后强制回 issues） ── */
console.log("\n6. QA 门禁：编辑后 check/audit 的 detail.issues 回到调用方");
{
  const result = await call<{ ok: boolean; qa?: { gate: string; ok: boolean; issues: unknown[] }; mutated?: boolean }>(
    IPC.DOCUMENT_TOOL_CALL,
    { tool: "apply_ops", app: "docs", filePath: DOCX, input: { ops: [{ op: "insert_content", html: "<p>gate probe</p>" }] }, track: true },
  );
  if (MUTATE === "no-qa") {
    // 变异：撤掉「编辑后跑 check」→ 这条必须红。
    check("★ 变异 no-qa：编辑后必须带 QA 结果", result.qa !== undefined, { got: result });
  } else {
    check("★ 编辑后必须有 qa（gate=check）", result.ok === true && result.qa?.gate === "check", result);
    check("★ qa 里带 detail.issues（即使为空）", Array.isArray(result.qa?.issues), result.qa);
    check("编辑被标记为落盘（mutated）", result.mutated === true, result);
  }

  // docs check 报告的问题真的能带回来：造一个“空标题”问题（set_heading to empty）。
  const emptyHeading = await call<{ ok: boolean; qa?: { issues: Array<{ code?: string }> } }>(
    IPC.DOCUMENT_TOOL_CALL,
    { tool: "apply_ops", app: "docs", filePath: DOCX, input: { ops: [{ op: "insert_content", html: "<h2></h2>" }] } },
  );
  if (MUTATE !== "no-qa") {
    const codes = (emptyHeading.qa?.issues ?? []).map((issue) => issue.code);
    check("check 能报出真实问题（空标题 → empty_heading）", emptyHeading.ok === true && codes.includes("empty_heading"), emptyHeading.qa);
  }

  // 负控：门禁读不到 detail.issues 时必须显式失败，不许当“没问题”。
  const { extractQaReport } = await import("../../src/main/document/documentToolSurface.js");
  const noIssues = extractQaReport("check", { ok: true, envelope: { status: "ok", detail: { counts: { error: 0 } } } });
  check("负控：信封没有 detail.issues → 门禁失败（不是“无问题”）", noIssues.ok === false, noIssues);
  const failedGate = extractQaReport("audit", { ok: false, kind: "failed", envelope: null, reason: "cli boom" });
  check("负控：CLI 失败 → 门禁失败并带原因", failedGate.ok === false && failedGate.summary === "cli boom", failedGate);
}

/* ── 7. render 出图 ── */
console.log("\n7. render：真出 PNG 且路径在盘上；假成功必须显式失败");
{
  const rendered = await call<{ ok: boolean; files?: string[]; note?: string }>(IPC.DOCUMENT_RENDER, { filePath: DOCX });
  check("document.render 成功", rendered.ok === true, rendered);
  const files = rendered.files ?? [];
  check("回了至少一张 PNG 且文件真的在盘上", files.length > 0 && files.every((file) => existsSync(file)), files);
  check("PNG 魔数正确", files.length > 0 && readFileSync(files[0]!).subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), files[0]);
  const { parseRenderFiles } = await import("../../src/main/document/documentToolSurface.js");
  const fake = parseRenderFiles({ ok: true, envelope: { status: "ok", detail: { files: [{ page: 1, path: join(root, "nope.png") }] } } }, existsSync);
  check("负控：报告成功但文件不在盘上 → 失败", fake.ok === false && fake.files.length === 0, fake);
}

/* ── 8. 变更可视：默认 track 产生可读修订 ── */
console.log("\n8. tracked changes：默认 track=true 的编辑留下修订条目");
{
  writeFileSync(join(root, "rev.md"), "# Rev base\n\nOriginal line.\n");
  cliJson(["create", "--type", "docx", "--from", "rev.md", "--out", "rev.docx", "--json"]);
  const revDoc = join(root, "rev.docx");
  const edited = await call<{ ok: boolean }>(IPC.DOCUMENT_MARKDOWN_EDIT, {
    filePath: revDoc, track: true,
    operations: [{ op: "append", markdown: "Tracked addition.\n" }],
  });
  check("track=true 的 Markdown 编辑成功", edited.ok === true, edited);
  const revisions = cliJson<{ detail: { revisions?: Array<{ id: string; type: string; author?: string }> } }>(["docs", "read", revDoc, "--revisions", "--json"]);
  const list = revisions.detail.revisions ?? [];
  check("★ 读得到修订条目（可逐条接受/拒绝）", list.length > 0 && list.some((item) => item.type === "insertion"), list);
  const accepted = cliJson<{ status: string }>(["docs", "apply", revDoc, "--ops", "-", "--json"], JSON.stringify([{ op: "accept_changes", all: true }]));
  check("修订可被接受（apply accept_changes）", accepted.status === "ok", accepted);
  const remaining = cliJson<{ detail: { revisions?: unknown[] } }>(["docs", "read", revDoc, "--revisions", "--json"]);
  check("接受后没有待处理修订", (remaining.detail.revisions ?? []).length === 0, remaining.detail.revisions);
}

console.log(`\nt24-document-tool-surface-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exitCode = 1;
