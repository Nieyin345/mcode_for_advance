/**
 * doc-ops-smoke —— 【MC-069】文档编辑的并发一致性:
 *   - Excel `editExcelRange`:两个对**不重叠**单元格的并发编辑,必须**两个都保留**,
 *     或者其中一个明确 `FILE_VERSION_CONFLICT` —— 绝不能「两边都报成功、其中一个被静默吞掉」。
 *     其中 ★A2 用**两个独立 OS 进程**(node 子进程)并发改同一 Excel,证明互斥已跨进程
 *     (宿主级文件租约),而不是只在进程内的 Map。
 *   - PDF `writePdf`:同一输出路径的两次并发创建,**只能一个成功**,另一个明确 no-clobber
 *     冲突,且最终 PDF 完整可读(唯一创建者的正文)。
 *   - `expectedSha256`:显式的乐观版本契约,不匹配即 `FILE_VERSION_CONFLICT`。
 *
 * 直接驱动生产的 `agentDocumentOps`(与公网/本地工具复用同一份函数),不经过工具表,
 * 以免与并行会话正在改的 `agentTools.ts` 抢文件。
 *
 * 夹具都是本机 tmp 下的**无意义文件**,不碰任何用户文档。
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { editExcelRange, editDocxXml, writePdf } from "@main/mcp/agentDocumentOps.js";

const root = mkdtempSync(path.join(tmpdir(), "mcode-doc-ops-"));
const failures: string[] = [];
let passed = 0;
async function test(name: string, fn: () => unknown): Promise<void> {
  try { await fn(); passed++; console.log("PASS " + name); }
  catch (e) { failures.push(name + ": " + String(e)); console.error("FAIL " + failures.at(-1)); }
}

// ── python 解释器(与生产同一套探测)────────────────────────────────────
let PY: string | undefined;
for (const exe of process.platform === "win32" ? ["python", "py", "python3"] : ["python3", "python"]) {
  const r = spawnSync(exe, ["-c", "import openpyxl,pypdf,PIL;print('ok')"], { encoding: "utf8", timeout: 20000 });
  if (r.status === 0) { PY = exe; break; }
}
assert.ok(PY, "doc-ops-smoke 需要既有 Python + openpyxl + pypdf + Pillow 工具链");

function py(code: string, ...args: string[]): string {
  const r = spawnSync(PY!, ["-X", "utf8", "-c", code, ...args], { encoding: "utf8", timeout: 60000 });
  if (r.status !== 0) throw new Error(`python 失败: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

/** 生成夹具(走同一份 fixtures.py)。 */
{
  const r = spawnSync(PY!, ["-X", "utf8", "scripts/doc-ops-smoke/fixtures.py", root], { encoding: "utf8", timeout: 60000 });
  assert.equal(r.status, 0, `fixtures.py: ${r.stderr || r.stdout}`);
}

const xlsx = path.join(root, "audit.xlsx");
const docx = path.join(root, "doc.docx");
const readCells = (file: string): string =>
  py("from openpyxl import load_workbook;import sys;ws=load_workbook(sys.argv[1]).active;print(str(ws['A1'].value)+'|'+str(ws['B1'].value))", file);

/** 读 A1..D1 四格(跨进程用例的宽读回)。 */
const readCells4 = (file: string): string =>
  py("from openpyxl import load_workbook;import sys;ws=load_workbook(sys.argv[1]).active;print('|'.join(str(ws[f'{c}1'].value) for c in 'ABCD'))", file);

/** 起一个**独立 OS 进程**去改同一个 Excel 的某个 range(range.sh 已把 child-writer 打成 mjs)。 */
const childEntry = process.env.MCODE_DOC_OPS_CHILD_ENTRY ?? "";
function spawnExcelWriter(file: string, range: string, value: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve, reject) => {
    assert.ok(childEntry && existsSync(childEntry), `缺少 child-writer 入口(应经 run.sh 设置):${childEntry}`);
    const child = spawn(process.execPath, [childEntry, file, range, value], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", errOut = "";
    child.stdout.on("data", (d: Buffer) => { out += d.toString("utf8"); });
    child.stderr.on("data", (d: Buffer) => { errOut += d.toString("utf8"); });
    child.once("error", reject);
    child.once("close", () => {
      const line = out.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
      try { resolve(JSON.parse(line) as { ok: boolean; error?: string }); }
      catch { resolve({ ok: false, error: `子进程无可解析输出:stdout=${out.trim()} stderr=${errOut.trim()}` }); }
    });
  });
}

/** 【MC-024】起一个**独立 OS 进程**编辑同一份文本文件。 */
const textChildEntry = process.env.MCODE_DOC_OPS_TEXT_CHILD_ENTRY ?? "";
function spawnTextWriter(file: string, marker: string, startAtMs: number): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve, reject) => {
    assert.ok(textChildEntry && existsSync(textChildEntry), `缺少 child-text-writer 入口(应经 run.sh 设置):${textChildEntry}`);
    const child = spawn(process.execPath, [textChildEntry, file, marker, String(startAtMs)], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", errOut = "";
    child.stdout.on("data", (d: Buffer) => { out += d.toString("utf8"); });
    child.stderr.on("data", (d: Buffer) => { errOut += d.toString("utf8"); });
    child.once("error", reject);
    child.once("close", () => {
            const line = out.trim().split(/[\r\n]+/).filter(Boolean).at(-1) ?? "";

      try { resolve(JSON.parse(line) as { ok: boolean; error?: string }); }
      catch { resolve({ ok: false, error: `子进程无可解析输出:stdout=${out.trim()} stderr=${errOut.trim()}` }); }
    });
  });
}

try {
  // ══════════ A. Excel:并发编辑不重叠单元格 ══════════
  await test("★ Excel 两个不重叠并发编辑:两份修改都在(或之一明确 FILE_VERSION_CONFLICT),绝不静默丢更新", async () => {
    writeFileSync(xlsx, readFileSync(xlsx)); // 确保存在
    const results = await Promise.allSettled([
      editExcelRange({ path: xlsx, range: "Audit!A1:A1", content: [["WRITER_A"]] }),
      editExcelRange({ path: xlsx, range: "Audit!B1:B1", content: [["WRITER_B"]] }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const conflict = results.filter(
      (r) => r.status === "rejected" && /FILE_VERSION_CONFLICT/.test(String((r as PromiseRejectedResult).reason)),
    ).length;
    const cells = readCells(xlsx);
    console.log(`    → ok=${ok} conflict=${conflict} cells=${cells}`);
    // 两种合法结局:(a) 两者都成功且都在;(b) 一个成功一个明确冲突。禁止「两个都成功却只留一个」。
    const bothKept = ok === 2 && cells === "WRITER_A|WRITER_B";
    const oneConflicted = ok === 1 && conflict === 1;
    assert.ok(bothKept || oneConflicted, `并发丢更新:ok=${ok} conflict=${conflict} cells=${cells}`);
    assert.ok(!(ok === 2 && cells !== "WRITER_A|WRITER_B"), `两边都报成功却丢了修改:${cells}`);
  });

  // ══════════ A2. ★ 跨进程 E1:多个独立 OS 进程改同一 Excel 的不同单元格 ══════════
  await test("★ 四个独立 OS 进程改同一 Excel 的不重叠单元格:四份修改必须全部保留(跨进程租约,非仅进程内 Map)", async () => {
    const cross = path.join(root, "cross-process.xlsx");
    // 独立的新夹具(别复用已被 A 段改过的 audit.xlsx),与 fixtures.py 同形状:够大以拉宽读-改-写窗口。
    py([
      "from openpyxl import Workbook;import sys",
      "w=Workbook();ws=w.active;ws.title='Audit'",
      "ws['A1']='ORIGINAL_A';ws['B1']='ORIGINAL_B';ws['C1']='ORIGINAL_C';ws['D1']='ORIGINAL_D'",
      "for r in range(2,2001):",
      " for c in range(1,9): ws.cell(r,c).value=r*c",
      "w.save(sys.argv[1])",
    ].join("\n"), cross);
    assert.equal(readCells4(cross), "ORIGINAL_A|ORIGINAL_B|ORIGINAL_C|ORIGINAL_D");
    // **四个真正独立的 OS 进程**并发:各起一个 node,各自 load_workbook → 改一格 → 写回。
    // 四路比两路把"各进程在提交前都读到同一旧版"的窗口显著放大 —— 进程内锁挡不住跨进程时,
    // 多进程各自的读-改-写会互相覆盖,几乎必然丢更新(变异下实测可靠转红)。
    const results = await Promise.all([
      spawnExcelWriter(cross, "Audit!A1:A1", "PROC_A"),
      spawnExcelWriter(cross, "Audit!B1:B1", "PROC_B"),
      spawnExcelWriter(cross, "Audit!C1:C1", "PROC_C"),
      spawnExcelWriter(cross, "Audit!D1:D1", "PROC_D"),
    ]);
    const okCount = results.filter((r) => r.ok).length;
    const cells = readCells4(cross);
    console.log(`    → ok=${okCount}/4 cells=${cells}${results.some((r) => r.error) ? " errs=" + results.map((r) => r.error ?? "-").join(" ; ") : ""}`);
    // 核心不变量(严格):**四个进程都必须成功,且四格都必须落上**。
    // 这正是跨进程文件租约的效果 —— 它把四路读-改-写**串行化**,谁都读得到最新版,于是四份全保留。
    // 撤掉租约(只剩进程内 Map)时,别的进程读-改-写不再被串行:要么各自在提交前读到同一旧版、
    // 覆盖掉彼此(静默丢更新),要么被提交前版本校验挡下而**丢了本该成功的编辑**(ok<4)——
    // 无论哪种,这条严格断言都必然转红(变异实测)。
    assert.equal(okCount, 4, `跨进程未串行化:只有 ${okCount}/4 个进程成功(应四个都成功)。cells=${cells}`);
    assert.equal(cells, "PROC_A|PROC_B|PROC_C|PROC_D", `跨进程并发丢更新,四格未全部保留:${cells}`);
  });

  // 串行基线:两个编辑按顺序提交,必须在
  await test("Excel 顺序编辑 A1 与 B1:两格都在", async () => {
    await editExcelRange({ path: xlsx, range: "Audit!A1:A1", content: [["SEQ_A"]] });
    await editExcelRange({ path: xlsx, range: "Audit!B1:B1", content: [["SEQ_B"]] });
    assert.equal(readCells(xlsx), "SEQ_A|SEQ_B");
  });

  await test("expectedSha256 不匹配 → FILE_VERSION_CONFLICT(拒绝覆盖)", async () => {
    await assert.rejects(
      () => editExcelRange({ path: xlsx, range: "Audit!A1:A1", content: [["X"]], expectedSha256: "0".repeat(64) }),
      /FILE_VERSION_CONFLICT/,
    );
    assert.equal(readCells(xlsx), "SEQ_A|SEQ_B", "拒绝后文件必须逐字节不动");
  });

  await test("expectedSha256 匹配 → 允许提交", async () => {
    const sha = py("import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest())", xlsx);
    await editExcelRange({ path: xlsx, range: "Audit!A1:A1", content: [["FRESH"]], expectedSha256: sha });
    assert.equal(readCells(xlsx).split("|")[0], "FRESH");
  });

  // ══════════ B. PDF:同路径并发创建 ══════════
  await test("★ PDF 同一输出路径并发创建:只能一个成功,另一个明确冲突,最终 PDF 完整可读", async () => {
    const out = path.join(root, "concurrent.pdf");
    rmSync(out, { force: true });
    const results = await Promise.allSettled([
      writePdf({ outputPath: out, markdown: "# WRITER_A\nConcurrent PDF proof A" }),
      writePdf({ outputPath: out, markdown: "# WRITER_B\nConcurrent PDF proof B" }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const conflict = results.filter(
      (r) => r.status === "rejected" && /已存在/.test(String((r as PromiseRejectedResult).reason)),
    ).length;
    console.log(`    → ok=${ok} conflict=${conflict}`);
    assert.equal(ok, 1, `同路径并发创建应有且仅有一个成功,实际 ok=${ok}`);
    assert.equal(conflict, 1, `另一个应明确 no-clobber 冲突,实际 conflict=${conflict}`);
    // 最终 PDF 必须完整可读(不是半截),且恰含唯一创建者的正文。
    const text = py("from pypdf import PdfReader;import sys;print(len(PdfReader(sys.argv[1]).pages))", out);
    assert.ok(Number(text) >= 1, `最终 PDF 不可读:${text}`);
    const body = readFileSync(out);
    assert.ok(body.length > 0, "最终 PDF 非空");
  });

  await test("PDF 目标已存在 → 明确拒绝(不覆盖)", async () => {
    const out = path.join(root, "exists.pdf");
    await writePdf({ outputPath: out, markdown: "# First" });
    await assert.rejects(() => writePdf({ outputPath: out, markdown: "# Second" }), /已存在/);
  });

  // ══════════ B2. 【MC-069 §34.4 复审红例】渲染期第三方占名:绝不静默销毁 ══════════
  await test("★ PDF 渲染期间第三方写入同名目标:writePdf 应明确冲突且第三方内容原样保留,绝不静默销毁", async () => {
    const out = path.join(root, "thirdparty-race.pdf");
    rmSync(out, { force: true });
    const THIRD_PARTY = "THIRD_PARTY_NEW_FILE_MUST_SURVIVE\n" + "x".repeat(2000);
    let settled = false;
    // 真实生产 writePdf:异步渲染一个完整 PDF(本机实测 4~9 秒),渲染期间 out **不存在**
    // (旧版会在开头用 open('wx') 抢一个 0 字节占位,新版只在最后原子链接)。
    const p = writePdf({ outputPath: out, markdown: "# LEGIT WRITER\nConcurrent body" })
      .then(() => ({ ok: true as const }), (e) => ({ ok: false as const, e }));
    p.finally(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 1500)); // 落在渲染窗口内
    const stillPending = !settled;
    // 第三方在渲染完成之前抢下同名目标(旧版占位在这里会被这个写入覆盖,随后 rename 再覆盖回来)。
    writeFileSync(out, THIRD_PARTY, "utf8");
    const outcome = await p;
    const survived = readFileSync(out).toString("utf8") === THIRD_PARTY;
    console.log(`    → pending=${stillPending} ok=${outcome.ok} survived=${survived}`);
    assert.ok(stillPending, "夹具安排失败:writePdf 在第三方写入前就完成了,没构造出渲染期并发(渲染若变得极快,需调大这里或夹具)");
    // 核心不变量:绝不允许「writePdf 报成功、却把渲染期间第三方写入的内容抹掉」。
    assert.ok(!(outcome.ok && !survived), "writePdf 报成功却销毁了渲染期间第三方写入的内容(第三方内容静默丢失)");
    // 正确结局:硬链接提交撞上已存在的第三方文件(EEXIST)→ 明确冲突,且第三方内容原样保留。
    assert.ok(!outcome.ok, "第三方已在渲染期占名,writePdf 必须明确冲突,不得报成功");
    assert.ok(survived, `第三方内容必须原样保留,实际文件已被改写`);
  });

  await test("PDF 提交成功/失败后不留 staging 残片(仅清理本次自己的临时文件)", async () => {
    const dir = path.join(root, "cleanup");
    await fs.mkdir(dir, { recursive: true });
    const okOut = path.join(dir, "ok.pdf");
    await writePdf({ outputPath: okOut, markdown: "# Cleanup OK" });
    const okLeft = (await fs.readdir(dir)).filter((f) => f.includes(".mcode-") && f.endsWith(".tmp.pdf"));
    assert.deepEqual(okLeft, [], `成功提交后留下 staging 残片:${okLeft.join(",")}`);
    // 失败路径(目标已存在)同样不得留残片。
    const dupOut = path.join(dir, "dup.pdf");
    await writePdf({ outputPath: dupOut, markdown: "# One" });
    await assert.rejects(() => writePdf({ outputPath: dupOut, markdown: "# Two" }), /已存在/);
    const failLeft = (await fs.readdir(dir)).filter((f) => f.includes(".mcode-") && f.endsWith(".tmp.pdf"));
    assert.deepEqual(failLeft, [], `失败后留下 staging 残片:${failLeft.join(",")}`);
  });

  // ══════════ C. DOCX:并发 XML 编辑 ══════════
  await test("DOCX 两个不重叠标记并发编辑:要么都保留,要么其中一个明确 FILE_VERSION_CONFLICT", async () => {
    const results = await Promise.allSettled([
      editDocxXml({ path: docx, oldString: "MARK_A", newString: "EDIT_A" }),
      editDocxXml({ path: docx, oldString: "MARK_B", newString: "EDIT_B" }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const conflict = results.filter(
      (r) => r.status === "rejected" && /FILE_VERSION_CONFLICT|EPERM|匹配/.test(String((r as PromiseRejectedResult).reason)),
    ).length;
    // 关键不变量:成功了几次,文件里就必须有几次改动 —— 不能"报成功却丢"。
    const xml = py(
      "import zipfile,sys;print(zipfile.ZipFile(sys.argv[1]).read('word/document.xml').decode('utf-8'))",
      docx,
    );
    const applied = (["EDIT_A", "EDIT_B"].filter((m) => xml.includes(m))).length;
    console.log(`    → ok=${ok} applied=${applied}`);
    assert.equal(applied, ok, `成功 ${ok} 次但文件里只落了 ${applied} 处改动(静默丢更新)`);
  });
  // ══════════ D.【MC-024】文本文件:两个独立 OS 进程并发读-改-写 ══════════
  await test("★ 文本:两个独立 OS 进程并发读-改-写同一文件 —— 两份标记都在,或之一明确冲突;绝不静默丢更新", async () => {
    const target = path.join(root, "concurrent.txt");
    await fs.writeFile(target, "base\n", "utf8");
    // 两个子进程各自「读全文 → 追加自己一行 → rename」,让它们几乎同时开抢(共同起跑时刻)。
    const startAt = Date.now() + 1200;
    const [a, b] = await Promise.all([
      spawnTextWriter(target, "PROC_A", startAt),
      spawnTextWriter(target, "PROC_B", startAt),
    ]);
    const okCount = [a, b].filter((r) => r.ok).length;
    const conflict = [a, b].filter((r) => !r.ok).length;
    const text = await fs.readFile(target, "utf8");
    const applied = ["PROC_A", "PROC_B"].filter((m) => text.includes(m)).length;
    console.log(`    → ok=${okCount} conflict=${conflict} applied=${applied}`);
    // 宿主级租约下两个读-改-写**串行**:第二个进租约时读到的是第一个写完的新内容,
    // 于是两份都必须成功、标记都必须保留(台账失败反例说"Y 结果丢失",修复后不丢)。
    // 任一失败(冲突)说明串行没做到;报成功却丢标记 = 静默丢更新(更坏)。
    assert.equal(applied, okCount, `成功 ${okCount} 次但文件里只落了 ${applied} 处改动(静默丢更新):${JSON.stringify({ a, b, text })}`);
    assert.equal(okCount, 2, `两个进程没有都成功(租约未把读-改-写串行):${JSON.stringify({ a, b })}`);
    assert.ok(text.includes("PROC_A") && text.includes("PROC_B"), `两份标记没有同时保留:${text}`);
  });

} finally {
  console.log(`\ndoc-ops: ${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
  rmSync(root, { recursive: true, force: true });
}
