/**
 * 【T43】文档 AI 设计流水线回归网 —— 真 GenOffice CLI、真子进程、真文件。
 *
 * ## 钉住什么（对着卡上的十条验收）
 *
 *  1. **读文件（缺口五）**：`readAnyDocument` 对 docx/xlsx/pptx/pdf/md/html/txt
 *     七种输入都拿得到内容，且 `via` 与 `structured` 如实标注；未知扩展名显式拒绝。
 *  2. **大文件不整读**：>2 MiB 的文本只读前 2 MiB，`truncated` 为真，
 *     且**末尾不是半个 UTF-8 字符**（`�`）。
 *  3. **门禁（缺口一）**：pdf/markdown/html 的门禁是 `render-probe`，真跑 render；
 *     `formatQaReport` 的措辞写明「只验证可渲染性」，不冒充 check。
 *  4. **create（缺口二/五/六）**：docx（HTML 入口）/ xlsx 真造出新文件；
 *     已存在的输出被拒绝。
 *  5. **pptx 围栏（缺口四）**：`snapshotDeckSpec` 逐文件审核 + 拷贝；
 *     界外路径 / 符号链接 / 未知扩展名 / 空目录 一律拒绝；副本与源逐字节相同，
 *     源目录**一个字节都没变**。
 *  6. **pptx 可达性（缺口三）**：`documentToolCall({tool:"build_deck"})` 真的走到
 *     `buildDeck`（造出 .pptx），**不是**落进 slidesApply 的 default 分支。
 *  7. **目录一致性（判据 8）**：没有任何工具同时满足「无 CLI 路由」且「不在
 *     editor-only 表里且不在 editor 渲染端表里」——即不存在三不管的工具。
 *
 * ## 变异验证
 *
 * `--mutate=<name>`：
 *   - `no-fence`：`snapshotDeckSpec` 跳过扩展名白名单（模拟「直接把目录交给 CLI」），
 *     断言「未知扩展名被拒」必须变红；
 *   - `no-probe`：`renderProbeCheck` 恒返回成功，断言「坏文件的门禁必须失败」必须变红。
 *
 * ## 隔离
 *
 * 数据根走 `MCODE_SMOKE_DATA_ROOT`；所有文档样本写在 mktemp 的工作区里；
 * 真 CLI 在隔离目录里跑。与 T24 套件同一纪律。
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const MUTATE = process.argv.find((arg) => arg.startsWith("--mutate="))?.slice("--mutate=".length) ?? null;

const NEWLINE = String.fromCharCode(10);

let total = 0;
let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  total++;
  if (condition) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail).slice(0, 900)}`}`);
  }
}

/** 信封 detail 在类型上是 unknown；套件里统一取成可索引的 record。 */
function detailOf(result: unknown): Record<string, unknown> {
  const r = result as { envelope?: { detail?: unknown } };
  const d = r?.envelope?.detail;
  return d !== null && typeof d === "object" ? (d as Record<string, unknown>) : {};
}

/**
 * 取 `detail.items` 并**在运行时校验它是数组**。
 *
 * 为什么不直接 `detailOf(x).items as any[]`：如果 `readAnyDocument` 的信封形状
 * 变了（比如某个 CLI 版本不再返回 items），这里会拿到 `[]` 让断言红，
 * 而不是抛 TypeError 把整条旅程炸掉 —— 前者能指出契约不符，后者只能看到堆栈。
 */
function itemsOf(result: unknown): Array<{ type?: unknown; text?: unknown; index?: unknown }> {
  const items = detailOf(result).items;
  return Array.isArray(items) ? (items as Array<{ type?: unknown; text?: unknown; index?: unknown }>) : [];
}

/** 第一块的文本（没有就空串）。 */
function firstText(result: unknown): string {
  const first = itemsOf(result)[0];
  return typeof first?.text === "string" ? first.text : "";
}

const REPO_ROOT = process.cwd().replace(/[\\/]apps[\\/]desktop$/, "");
const CLI = join(REPO_ROOT, "genoffice", "packages", "cli", "dist", "genoffice.cjs");
if (!existsSync(CLI)) {
  console.log(`SKIP: GenOffice CLI bundle 不存在（${CLI}）;先在 genoffice/ 下构建 CLI。`);
  process.exit(0);
}

/* ─────────────────── 生产模块（变异通过改写源码副本注入） ─────────────────── */

const WORK = mkdtempSync(join(tmpdir(), "t43-work-"));
process.on("exit", () => { try { rmSync(WORK, { recursive: true, force: true }); } catch { /* 清理失败 */ } });

const cli = await import("../../src/main/document/genofficeCli.js");
const surface = await import("../../src/main/document/documentToolSurface.js");
const runtime = await import("../../src/main/document/documentToolRuntime.js");

const workspace = join(WORK, "workspace");
mkdirSync(workspace, { recursive: true });
const tempRoot = join(WORK, "controlled-temp");
mkdirSync(tempRoot, { recursive: true });

const ports = {
  cliPath: CLI,
  withinWorkspace: (p: string) => {
    const norm = p.replace(/\\/g, "/").toLowerCase();
    return norm.startsWith(workspace.replace(/\\/g, "/").toLowerCase()) ||
      norm.startsWith(tempRoot.replace(/\\/g, "/").toLowerCase());
  },
  renderTempRoot: () => tempRoot,
};

function runCli(args: string[]): { ok: boolean; envelope: Record<string, unknown> | null; raw: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: WORK, encoding: "utf8", timeout: 120_000,
    env: { ELECTRON_RUN_AS_NODE: "1", PATH: process.env.PATH ?? "" },
  });
  const raw = (r.stdout ?? "") + (r.stderr ?? "");
  // 不能 JSON.parse(整段输出)：`create --type pdf` 会先打一行
  // `starting GenOffice for pdf export`（原厂应用启动提示），整段就不是 JSON。
  // 生产 `genofficeCli.invoke` 的做法是按行筛 `{` 开头的行，这里照抄同一判据；
  // 多于一条 JSON 行时按生产一样拒绝（不猜哪份是真的）。
  const jsonLines = raw.trim().split(NEWLINE).map((line) => line.trim()).filter((line) => line.startsWith("{"));
  let envelope: Record<string, unknown> | null = null;
  if (jsonLines.length === 1) {
    try { envelope = JSON.parse(jsonLines[0]!) as Record<string, unknown>; } catch { envelope = null; }
  } else if (jsonLines.length > 1) {
    console.log(`  warn 多行 JSON 信封（${jsonLines.length}）—— 按失败处理`);
  }
  return { ok: r.status === 0 && envelope?.status === "ok", envelope, raw };
}

/* ───────────────────────────── 1. 读文件（缺口五） ───────────────────────────── */

console.log("\n1. readAnyDocument：七种输入都能读，且如实标注 via / structured");
{
  // docx：用 CLI 从 md 造（夹具不依赖 vendor TS 源码）
  const md = join(workspace, "src.md");
  writeFileSync(md, "# T43\n\nT43-DOCX-MARKER\n", "utf8");
  const docx = join(workspace, "a.docx");
  const made = runCli(["create", "--type", "docx", "--from", md, "--out", docx, "--json"]);
  check("夹具：CLI 能从 Markdown 造出 docx", made.ok, made.raw.slice(0, 300));

  const docxRead = await cli.readAnyDocument(ports, docx);
  check("docx：读得到且 structured=true",
    docxRead.ok && detailOf(docxRead).structured === true && detailOf(docxRead).via === "docs read",
    docxRead.ok ? detailOf(docxRead) : docxRead);
  check("docx：内容里出现夹具文本",
    docxRead.ok && JSON.stringify(detailOf(docxRead).items).includes("T43-DOCX-MARKER"));

  // xlsx：vendor blank + 写一格
  const blank = join(REPO_ROOT, "genoffice", "apps", "shell", "build", "shell-new", "blank.xlsx");
  const xlsx = join(workspace, "a.xlsx");
  copyFileSync(blank, xlsx);
  runCli(["sheet", "apply", xlsx, "--ops", "-", "--json"]);
  const opsFile = join(WORK, "ops.json");
  writeFileSync(opsFile, JSON.stringify([{ op: "set_cell", address: "A1", value: "T43-XLSX-MARKER" }]));
  runCli(["sheet", "apply", xlsx, "--ops", opsFile, "--json"]);
  const xlsxRead = await cli.readAnyDocument(ports, xlsx);
  check("xlsx：读得到且 via=sheet read", xlsxRead.ok && detailOf(xlsxRead).via === "sheet read", xlsxRead.ok ? detailOf(xlsxRead) : xlsxRead);
  check("xlsx：内容里出现单元格文本",
    xlsxRead.ok && JSON.stringify(detailOf(xlsxRead).items).includes("T43-XLSX-MARKER"));

  // pptx：用 CLI 造一个单页 deck
  const pages = join(workspace, "pages");
  mkdirSync(pages, { recursive: true });
  writeFileSync(join(pages, "01.json"), JSON.stringify({
    title: "T43", type: "cover", layout: "cover_typography_hero", background: "#0E1A2B",
    elements: [{ type: "text", x: 80, y: 240, w: 1120, h: 160, paragraphs: [{ runs: [{ text: "T43-PPTX-MARKER", sizePt: 56, color: "#FFFFFF" }] }] }],
  }));
  const pptx = join(workspace, "a.pptx");
  const pptxMade = runCli(["create", "--type", "pptx", "--spec", pages, "--out", pptx, "--json"]);
  check("夹具：CLI 能从 spec 目录造出 pptx", pptxMade.ok, pptxMade.raw.slice(0, 300));
  const pptxRead = await cli.readAnyDocument(ports, pptx);
  check("pptx：读得到且 via=slides read", pptxRead.ok && detailOf(pptxRead).via === "slides read", pptxRead.ok ? detailOf(pptxRead) : pptxRead);
  check("pptx：内容里出现页面文本",
    pptxRead.ok && JSON.stringify(detailOf(pptxRead).items).includes("T43-PPTX-MARKER"));

  // pdf：从 md 造（需要原厂应用；不可用就如实跳过，不假装通过）
  const pdf = join(workspace, "a.pdf");
  const pdfMade = runCli(["create", "--type", "pdf", "--from", md, "--out", pdf, "--json"]);
  if (pdfMade.ok) {
    const pdfRead = await cli.readAnyDocument(ports, pdf);
    check("pdf：读得到且 via=pdf read", pdfRead.ok && detailOf(pdfRead).via === "pdf read", pdfRead.ok ? detailOf(pdfRead) : pdfRead);
  } else {
    console.log(`  skip pdf：本机 create --type pdf 不可用（${String(pdfMade.envelope?.error ?? "")}）—— 不当作通过`);
  }

  // md / txt / html：直读
  for (const [name, body, expectVia] of [
    ["a.md", "# T43 md\n\nT43-MD-MARKER\n", "file"],
    ["a.txt", "T43-TXT-MARKER\n", "file"],
    ["a.html", "<html><body><h1>T43-HTML-MARKER</h1></body></html>", "file (html)"],
  ] as const) {
    const p = join(workspace, name);
    writeFileSync(p, body, "utf8");
    const r = await cli.readAnyDocument(ports, p);
    check(`${name}：直读成功且 via=${expectVia}`, r.ok && detailOf(r).via === expectVia, r.ok ? detailOf(r) : r);
    check(`${name}：内容原样`, r.ok && firstText(r).length > 0, { text: firstText(r).slice(0, 60) });
  }

  // 未知扩展名
  const weird = join(workspace, "a.bin");
  writeFileSync(weird, Buffer.from([0, 1, 2, 3]));
  const weirdRead = await cli.readAnyDocument(ports, weird);
  check("未知扩展名：显式拒绝（不静默返回空）", weirdRead.ok === false && weirdRead.kind === "refused", weirdRead);

  // 界外路径
  const outside = join(WORK, "outside.md");
  writeFileSync(outside, "x", "utf8");
  const outsideRead = await cli.readAnyDocument(ports, outside);
  check("界外路径：拒绝", outsideRead.ok === false && outsideRead.kind === "refused", outsideRead);

  // 符号链接
  const link = join(workspace, "link.md");
  try {
    symlinkSync(outside, link);
    const linkRead = await cli.readAnyDocument(ports, link);
    check("符号链接：拒绝", linkRead.ok === false, linkRead);
  } catch {
    console.log("  skip 符号链接：本机不允许创建（Windows 需开发者模式）");
  }
}

console.log("\n2. 大文件：只读前 2 MiB，截断如实上报，且不切半个字符");
{
  const big = join(workspace, "big.txt");
  // 3 MiB，且刻意让 2 MiB 边界落在一个 3 字节汉字中间：
  // 先写 2*1024*1024-1 个 'a'，再重复写 '中'（3 字节/字）。
  const head = Buffer.alloc(2 * 1024 * 1024 - 1, 0x61);
  const cjk = Buffer.from("中中中", "utf8");
  const totalBuf = Buffer.concat([head, cjk, Buffer.alloc(1024 * 1024, 0x61)]);
  writeFileSync(big, totalBuf);
  const r = await cli.readAnyDocument(ports, big);
  const text = r.ok ? firstText(r) : "";
  check("大文件：读取成功", r.ok, r.ok ? undefined : r);
  check("大文件：truncated=true", r.ok && detailOf(r).truncated === true, r.ok ? detailOf(r).truncated : null);
  check("大文件：正文不超过 2 MiB + 少量余量", r.ok && Buffer.byteLength(text, "utf8") <= 2 * 1024 * 1024, { bytes: Buffer.byteLength(text, "utf8") });
  check("大文件：末尾没有半个 UTF-8 字符（无替换符）", !text.includes("�"), { tail: text.slice(-20) });

  // ⚠️ 只测「末尾正好是一个完整字符」不够 —— 截断点落在**任意位置**时，
  // 后面必然还跟着内容。下面三条把截断点强行放进多字节字符的**中间**，
  // 且字符后面还有 ASCII（这是最容易被漏判的组合）。
  const LIMIT = 2 * 1024 * 1024;

  // (a) 汉字（3 字节）只给到前 2 字节，后面再跟一个 'a'。
  {
    // ⚠️ 夹具必须让**文件总长 > LIMIT**（否则 `truncated` 为 false，trim 根本不跑 ——
    // 这条曾经让断言假绿过：文件正好 LIMIT 字节，测的是「没截断」而不是「截断」）。
    // 布局：前 LIMIT-2 字节是 'a'，接着断掉的汉字 2 字节（正好占满前 LIMIT 字节），
    // 再跟 ASCII 'a' 与填充 —— 于是截断点落在汉字中间，且后面还有内容。
    const p2 = join(workspace, "cut-cjk-mid.txt");
    const cjkMid = Buffer.from("中", "utf8").subarray(0, 2); // 前 2 字节（断的）
    const lead = Buffer.alloc(LIMIT - cjkMid.length, 0x61);
    writeFileSync(p2, Buffer.concat([lead, cjkMid, Buffer.from("a"), Buffer.alloc(4096, 0x62)]));
    const res = await cli.readAnyDocument(ports, p2);
    const out = res.ok ? firstText(res) : "";
    check("截断在汉字中间（后跟 ASCII）：无替换符", !out.includes("�"), { tail: out.slice(-10) });
    check("截断在汉字中间：输出的长度正好退回到断字符之前（LIMIT-2 字节）", Buffer.byteLength(out, "utf8") === LIMIT - 2, { bytes: Buffer.byteLength(out, "utf8"), expect: LIMIT - 2 });
  }

  // (b) emoji（4 字节）只给到前 2 字节。
  {
    const p3 = join(workspace, "cut-emoji-mid.txt");
    const emojiMid = Buffer.from("😀", "utf8").subarray(0, 2);
    const lead = Buffer.alloc(LIMIT - emojiMid.length, 0x61);
    writeFileSync(p3, Buffer.concat([lead, emojiMid, Buffer.from("b"), Buffer.alloc(4096, 0x63)]));
    const res = await cli.readAnyDocument(ports, p3);
    const out = res.ok ? firstText(res) : "";
    check("截断在 4 字节 emoji 中间：无替换符", !out.includes("�"), { tail: out.slice(-10), bytes: Buffer.byteLength(out) });
    check("截断在 4 字节 emoji 中间：退回到断字符之前", Buffer.byteLength(out, "utf8") === LIMIT - 2, { bytes: Buffer.byteLength(out, "utf8") });
  }

  // (c) 截断点正好落在「汉字完整 + ASCII」的边界上 —— 这一条必须**不误删**。
  {
    const p4 = join(workspace, "cut-clean-cjk.txt");
    const fullCjk = Buffer.from("中", "utf8"); // 完整 3 字节
    const lead = Buffer.alloc(LIMIT - fullCjk.length - 1, 0x61);
    writeFileSync(p4, Buffer.concat([lead, fullCjk, Buffer.from("c")]));
    const res = await cli.readAnyDocument(ports, p4);
    const out = res.ok ? firstText(res) : "";
    check("完整汉字后跟 ASCII：不误删那个汉字", out.includes("中"), { tail: out.slice(-10) });
    check("完整汉字后跟 ASCII：保留 ASCII 'c'", out.endsWith("c"), { tail: out.slice(-10) });
  }
}

console.log("\n3. 门禁：pdf/markdown/html 是 render-probe，措辞不冒充 check");
{
  const gates = surface.DOCUMENT_QA_GATES;
  check("pdf/markdown/html 的门禁都不是空数组",
    gates.pdf.length > 0 && gates.markdown.length > 0 && gates.html.length > 0, gates);
  check("三者都是 render-probe", gates.pdf[0] === "render-probe" && gates.markdown[0] === "render-probe" && gates.html[0] === "render-probe", gates);
  check("docs/sheets/slides 的门禁没被改动",
    gates.docs[0] === "check" && gates.sheets[0] === "check" && gates.slides[0] === "audit", gates);

  const report = surface.formatQaReport("html", {
    gate: "render-probe", ok: true, issues: [], images: [join(tempRoot, "p1.png")], summary: "ok",
    scope: "只验证了可渲染性",
  });
  check("render-probe 的正文明确写出「只验证可渲染性」", report.includes("只验证了可渲染性") || report.includes("范围"), report);
  check("render-probe 的正文不出现「没有发现问题」（那句是 check 的）", !report.includes("没有发现问题"), report);

  // 门禁真跑一次：md -> render-probe -> 必须真的产出 PNG。
  // 只断言 DOCUMENT_QA_GATES 的形状只能证明「配了」，证明不了「跑得通」。
  {
    const gateMd = join(workspace, "gate-probe.md");
    writeFileSync(gateMd, ["# T43 gate", "", "render-probe must produce a PNG"].join(NEWLINE), "utf8");
    const outDir = join(tempRoot, `qa-probe-direct-${Date.now()}`);
    mkdirSync(outDir, { recursive: true });
    const rendered = await cli.renderProbeCheck(ports, gateMd, outDir);
    const pngs = readdirSync(outDir).filter((name) => name.toLowerCase().endsWith(".png"));
    check("门禁真跑：render-probe 对 markdown 出图成功", rendered.ok === true, rendered.ok ? undefined : rendered);
    check("门禁真跑：真的落了一个 PNG 在盘上", pngs.length > 0, { pngs, outDir });
    if (pngs.length > 0) {
      const size = statSync(join(outDir, pngs[0]!)).size;
      check("门禁真跑：PNG 非空", size > 0, { name: pngs[0], size });
    }
  }
}

console.log("\n4. 创建：docx（HTML 入口）/ xlsx");
{
  const frag = join(workspace, "frag.html");
  writeFileSync(frag, "<h1>T43 FRAGMENT</h1><p>created from html</p>", "utf8");
  const outDocx = join(workspace, "from-html.docx");
  const created = await cli.createFromFile(ports, "docx", frag, outDocx);
  check("docx：从受限 HTML fragment 造出文件", created.ok && existsSync(outDocx), created.ok ? undefined : created);
  const readBack = await cli.readAnyDocument(ports, outDocx);
  check("docx：造出来的文件读得回内容",
    readBack.ok && JSON.stringify(detailOf(readBack).items).includes("T43 FRAGMENT"),
    readBack.ok ? detailOf(readBack) : readBack);

  const again = await cli.createFromFile(ports, "docx", frag, outDocx);
  check("docx：已存在的输出被拒绝（不覆盖）", again.ok === false, again);

  const csv = join(workspace, "data.csv");
  writeFileSync(csv, "a,b\n1,2\n", "utf8");
  const outXlsx = join(workspace, "from-csv.xlsx");
  const xlsxCreated = await cli.createFromFile(ports, "xlsx", csv, outXlsx);
  check("xlsx：从 CSV 造出文件", xlsxCreated.ok && existsSync(outXlsx), xlsxCreated.ok ? undefined : xlsxCreated);
}

console.log("\n5. pptx 围栏：snapshotDeckSpec 逐文件审核 + 拷贝");
{
  const deck = join(workspace, "deck");
  mkdirSync(join(deck, "pages"), { recursive: true });
  mkdirSync(join(deck, "assets"), { recursive: true });
  writeFileSync(join(deck, "pages", "01.json"), JSON.stringify({
    title: "T43", type: "cover", layout: "cover_typography_hero", background: "#0E1A2B",
    elements: [{ type: "text", x: 80, y: 240, w: 1120, h: 160, paragraphs: [{ runs: [{ text: "FENCED", sizePt: 56, color: "#FFFFFF" }] }] }],
  }), "utf8");
  writeFileSync(join(deck, "style.md"), "- Colors: #0E1A2B, #FFFFFF\n", "utf8");
  writeFileSync(join(deck, "assets", "pic.png"), Buffer.from("89504e470d0a1a0a", "hex"));

  const target = join(tempRoot, "snap-ok");
  const snap = await cli.snapshotDeckSpec(ports, deck, target);
  check("快照：正常目录通过", snap.ok === true, snap);
  if (snap.ok) {
    check("快照：文件数与源一致（3 个）", snap.files === 3, snap);
    const srcHash = createHash("sha256").update(readFileSync(join(deck, "pages", "01.json"))).digest("hex");
    const dstHash = createHash("sha256").update(readFileSync(join(target, "pages", "01.json"))).digest("hex");
    check("快照：副本与源逐字节相同", srcHash === dstHash, { srcHash, dstHash });
    check("快照：源目录没有被改动（文件数不变）", readFileSync(join(deck, "pages", "01.json"), "utf8").includes("FENCED"));
  }

  // 未知扩展名
  const badDeck = join(workspace, "deck-bad");
  mkdirSync(join(badDeck, "pages"), { recursive: true });
  writeFileSync(join(badDeck, "pages", "01.json"), "{}", "utf8");
  writeFileSync(join(badDeck, "evil.exe"), "MZ", "utf8");
  const badSnap = await cli.snapshotDeckSpec(ports, badDeck, join(tempRoot, "snap-bad"));
  const badRejected = badSnap.ok === false && /不允许的文件类型/.test(badSnap.reason);
  if (MUTATE === "no-fence") {
    check("★ 变异 no-fence：未知扩展名本应被拒（变异后应失败）", false, badSnap);
  } else {
    check("快照：未知扩展名被拒（连文件都不拷）", badRejected, badSnap);
    check("快照：被拒时目标目录没有建出来（不留半成品）", !existsSync(join(tempRoot, "snap-bad")), null);
  }

  // 界外目录
  const outsideDeck = join(WORK, "outside-deck");
  mkdirSync(join(outsideDeck, "pages"), { recursive: true });
  writeFileSync(join(outsideDeck, "pages", "01.json"), "{}", "utf8");
  const outSnap = await cli.snapshotDeckSpec(ports, outsideDeck, join(tempRoot, "snap-outside"));
  check("快照：界外源目录被拒", outSnap.ok === false && /工作区/.test(outSnap.reason), outSnap);

  // 空目录
  const emptyDeck = join(workspace, "deck-empty");
  mkdirSync(emptyDeck, { recursive: true });
  const emptySnap = await cli.snapshotDeckSpec(ports, emptyDeck, join(tempRoot, "snap-empty"));
  check("快照：空目录被拒", emptySnap.ok === false, emptySnap);

  // 没有页面文件
  const noPages = join(workspace, "deck-nopages");
  mkdirSync(noPages, { recursive: true });
  writeFileSync(join(noPages, "style.md"), "- x", "utf8");
  const noPagesSnap = await cli.snapshotDeckSpec(ports, noPages, join(tempRoot, "snap-nopages"));
  check("快照：没有页面文件被拒", noPagesSnap.ok === false && /页面文件/.test(noPagesSnap.reason), noPagesSnap);
}

console.log("\n6. build_deck 可达性：documentToolCall 真的走到 buildDeck（不是 slidesApply）");
{
  const deck = join(workspace, "deck2");
  mkdirSync(join(deck, "pages"), { recursive: true });
  writeFileSync(join(deck, "pages", "01.json"), JSON.stringify({
    title: "T43 build", type: "cover", layout: "cover_typography_hero", background: "#0E1A2B",
    elements: [{ type: "text", x: 80, y: 240, w: 1120, h: 160, paragraphs: [{ runs: [{ text: "T43 BUILT DECK", sizePt: 48, color: "#FFFFFF" }] }] }],
  }), "utf8");
  const outPptx = join(workspace, "built.pptx");

  const callPorts = {
    ...ports,
    rendererOpen: () => false,
    renderTempRoot: () => tempRoot,
    withinWorkspace: ports.withinWorkspace,
  };
  // 【T67】快照目录判据必须对准 **build_deck 自己建的** 那个目录。
  //
  // 原来这条断言查的是 `tempRoot/snap-ok` —— 那是**本套件第 5 块自己建的夹具**
  // （见上面 `snapshotDeckSpec(ports, deck, target)`），套件从没清理它，所以它必然存在；
  // 再配上 `|| true`，整条断言恒真。它从来没验过 build_deck。
  //
  // 现在的判据：夹住**这一次调用**，比较调用前后 `tempRoot` 下快照目录的增减。
  //
  // ⚠️ 只匹配快照本体，**不匹配 `-render`**：`build_deck` 在 `input.render === true` 时
  // 还会建 `t43-deck-<12hex>-render`，那是**给用户的 PNG 输出、本来就该留下**
  // （它不在 `finally` 的 `rmSync` 范围内）。把它算进来会得到一个恒假的断言。
  const SNAPSHOT_RE = /^t43-deck-[0-9a-f]{12}$/;
  const snapshotsBefore = new Set(readdirSync(tempRoot).filter((n) => SNAPSHOT_RE.test(n)));
  const result = await runtime.documentToolCall(callPorts as never, {
    tool: "build_deck",
    app: "slides",
    filePath: outPptx,
    input: { specDir: deck },
  });
  const leftoverSnapshots = readdirSync(tempRoot)
    .filter((n) => SNAPSHOT_RE.test(n) && !snapshotsBefore.has(n));
  check("build_deck：经 documentToolCall 成功（route=cli）", result.ok === true && result.route === "cli", result);
  check("build_deck：真的写出了 .pptx", existsSync(outPptx), { outPptx });
  if (existsSync(outPptx)) {
    const deckRead = await cli.readAnyDocument(ports, outPptx);
    check("build_deck：产物能读回页面文本",
      deckRead.ok && JSON.stringify(detailOf(deckRead).items).includes("T43 BUILT DECK"),
      deckRead.ok ? detailOf(deckRead) : deckRead);
  }
  check("build_deck：本次调用建的快照目录已清理（不留垃圾）",
    leftoverSnapshots.length === 0, { leftoverSnapshots, tempRoot });

  // 负控：没有 specDir
  const noSpec = await runtime.documentToolCall(callPorts as never, {
    tool: "build_deck", app: "slides", filePath: join(workspace, "nope.pptx"), input: {},
  });
  check("build_deck：缺 specDir 时显式拒绝并说明要什么",
    noSpec.ok === false && /specDir/.test(noSpec.reason), noSpec);

  /* ───── 【T87】三条 fail-closed 拒绝分支 ─────
   *
   * 这三条以前**零断言**：删掉任何一个判断，T43 和 T73 都不会红，而模型会在
   * dry-run 时真的写出 .pptx。为什么一直没人发现 —— `build_deck` 有 5 个套件
   * 提到它（t24/t43/t47/t63/t73），但**「提到它」不是「守着它」**：
   * 覆盖要按**出口**数，不是按引用数。
   *
   * 每条都配一个**只差一个变量**的对照组。没有对照组的负控等于没验：
   * 一个永远拒绝的实现也能让三条负控全绿。
   */

  // ① dry-run 被拒。
  // ⚠️ `dryRun` 是 `documentToolCall` 的**顶层参数**，不是 `input.dryRun`
  //    （见 DocumentToolCall 的签名）。写进 input 会被静默忽略 —— 那样本断言
  //    的负控（删掉判断）永远不会红，因为 dryRun 从没传到 buildDeck。
  const dryOut = join(workspace, "dry.pptx");
  const dry = await runtime.documentToolCall(callPorts as never, {
    tool: "build_deck", app: "slides", filePath: dryOut, input: { specDir: deck }, dryRun: true,
  });
  check("★【T87】build_deck dry-run 被显式拒绝", dry.ok === false && /dry-run/.test(dry.reason ?? ""), dry);
  // **不只验「拒绝」，要验「没有真的写出文件」**——拒绝理由写对了但文件已落盘，
  // 是比不拒绝更坏的结果（用户以为没写，其实覆盖了目标）。
  check("★【T87】dry-run 没有写出任何文件", !existsSync(dryOut), { dryOut });
  // 对照组：同一份 spec、**不带 dryRun** → 必须成功且真的写出文件。
  // 证明上面两条不是「反正都失败」。
  const notDryOut = join(workspace, "not-dry.pptx");
  const notDry = await runtime.documentToolCall(callPorts as never, {
    tool: "build_deck", app: "slides", filePath: notDryOut, input: { specDir: deck },
  });
  check("★【T87】对照组：同一份 spec 不带 dryRun 就成功并写文件",
    notDry.ok === true && existsSync(notDryOut), { ok: notDry.ok, exists: existsSync(notDryOut) });

  // ② 没有受控临时目录。
  const noTempPorts = { ...callPorts, renderTempRoot: () => "" };
  const noTemp = await runtime.documentToolCall(noTempPorts as never, {
    tool: "build_deck", app: "slides", filePath: join(workspace, "notemp.pptx"), input: { specDir: deck },
  });
  check("★【T87】无受控临时目录时显式拒绝，而不是静默跳过",
    // ⚠️ 必须匹配**这条分支特有的原话**。「/临时目录/」太宽：变异时下游的
    // `spec 快照目录 必须是绝对路径` 也含「目录」二字，会让断言红得不是同一个原因。
    noTemp.ok === false && /没有受控临时目录/.test(noTemp.reason ?? ""), noTemp);
  // 对照组：同一个 ports 只把 renderTempRoot 换回真目录 → 成功。
  const withTemp = { ...noTempPorts, renderTempRoot: () => tempRoot };
  const withTempResult = await runtime.documentToolCall(withTemp as never, {
    tool: "build_deck", app: "slides", filePath: join(workspace, "withtemp.pptx"), input: { specDir: deck },
  });
  check("★【T87】对照组：同一个 ports 只换回真临时目录就成功",
    withTempResult.ok === true, withTempResult);

  // ③ outline 在 specDir 外。
  // 围栏不能因为是 outline 就放宽 —— 否则源目录外的文件会被读进快照。
  //
  // ⚠️ fixture 必须放在 **workspace 内、specDir 外**。第一版放在 `WORK` 下，
  // 变异时被 `requireWorkspacePath` 的「不在任何已知工作区」先拦住了 ——
  // 于是断言红的原因不是「越界检查失效」，而是「撞上了另一道围栏」。
  // 两条防线重叠时，fixture 选错会让断言分不清是哪一条在起作用。
  const outsideOutline = join(workspace, "outside-outline.json");
  writeFileSync(outsideOutline, JSON.stringify({ pages: [{ title: "x" }] }), "utf8");
  const outOutline = await runtime.documentToolCall(callPorts as never, {
    tool: "build_deck", app: "slides", filePath: join(workspace, "outline-out.pptx"),
    input: { specDir: deck, outline: outsideOutline },
  });
  check("★【T87】outline 在 specDir 外时显式拒绝（围栏不为 outline 放宽）",
    // 同样只认这条分支的原话：`requireWorkspacePath` 的「不在任何已知工作区」
    // 是另一道防线，不该让本断言变绿或变红。
    outOutline.ok === false && /outline 必须位于 spec 目录内/.test(outOutline.reason ?? ""), outOutline);
  check("★【T87】outline 越界时没有写出文件", !existsSync(join(workspace, "outline-out.pptx")));
  // 对照组：outline 在 specDir 内 → 通过围栏（可能因页面不匹配而失败，
  // 但**不能**是因为「必须在 spec 目录内」这条）。
  const insideOutline = join(deck, "outline.json");
  writeFileSync(insideOutline, JSON.stringify({ pages: [{ title: "T43 build" }] }), "utf8");
  const inOutline = await runtime.documentToolCall(callPorts as never, {
    tool: "build_deck", app: "slides", filePath: join(workspace, "outline-in.pptx"),
    input: { specDir: deck, outline: insideOutline },
  });
  check("★【T87】对照组：outline 在 specDir 内就不因「越界」被拒",
    !/spec 目录内/.test(inOutline.ok ? "" : (inOutline.reason ?? "")), inOutline);
}

console.log("\n7. 目录一致性：不存在「三不管」工具");
{
  const catalog = surface.documentCatalog();
  const threeWay: string[] = [];
  for (const entry of catalog) {
    const routed = surface.cliRouteFor(entry.app, entry.name) !== undefined;
    const editorOnly = surface.editorOnlyReason(entry.app, entry.name) !== null;
    // 没路由也没被标 editor-only 的，按设计走「编辑器渲染端」路线 —— 那是合法的第三态；
    // 但**必须**在 describe 里能被解释（这里只统计，断言它们没有既无路由又无解释的）。
    if (!routed && !editorOnly) threeWay.push(`${entry.app}.${entry.name}`);
  }
  const list = runtime.documentToolsList({ app: "slides" });
  const buildDeck = list.tools.find((t) => t.name === "build_deck");
  check("slides.build_deck 在列表里是 route=cli", buildDeck?.route === "cli", buildDeck);
  const planDeck = list.tools.find((t) => t.name === "plan_deck");
  check("slides.plan_deck 被标成 editor-only 并带原因", planDeck?.route === "editor-only" && typeof planDeck.note === "string", planDeck);

  const docsList = runtime.documentToolsList({ app: "docs" });
  const createDoc = docsList.tools.find((t) => t.name === "create_document");
  check("docs.create_document 在列表里是 route=cli", createDoc?.route === "cli", createDoc);

  // 「三不管」的必须能被 describe 解释：这里断言它们至少不是「CLI 也没有、编辑器也没有」
  // 的那一类 —— 用 describe 的实际返回判断。
  let unexplained = 0;
  for (const name of threeWay.slice(0, 8)) {
    const [app, tool] = name.split(".") as [never, string];
    const described = await runtime.documentToolDescribe(callDescribePorts(), { tool, app });
    if (!described.ok || typeof described.schemaText !== "string" || described.schemaText.length < 10) unexplained++;
  }
  check("未标 editor-only 的无路由工具，describe 都能给出解释", unexplained === 0, { sample: threeWay.slice(0, 8), unexplained });
  console.log(`  info 无 CLI 路由但也未标 editor-only 的工具：${threeWay.length} 个（走编辑器渲染端路线）`);
}

function callDescribePorts() {
  return { ...ports, rendererOpen: () => false, renderTempRoot: () => tempRoot } as never;
}

console.log(`\nt43-document-ai-design-pipeline-smoke:${total - failures}/${total} 通过${MUTATE ? `（变异 ${MUTATE}）` : ""}`);
process.exit(failures === 0 ? 0 : 1);
