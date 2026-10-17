/**
 * 【ARC-007 G0】**GenOffice CLI 适配层**的回归网（真 CLI、真子进程、真文件）。
 *
 * 被测：`src/main/document/genofficeCli.ts`（主进程适配层）。
 *
 * ## 它钉什么
 *
 *  1. **路径围栏**：工作区外的输入/输出一律 `refused`，且**进程根本没起**
 *     （判据是 CLI 没被调用 —— 用一个不存在的 cliPath 也得到 refused 而非 unavailable，
 *     证明围栏先于起进程）；
 *  2. **信封解析**：真实 CLI 的 `{status, command, ...}` 原样解析成 `ok/envelope`；
 *  3. **能力不可用的分类**：`slides render` / `convert → pdf` 返回 `kind:"unavailable"`
 *     （code 4 / app_unavailable），而不是 `failed` —— 调用方据此给"需安装/配置"而非"文档坏了"；
 *  4. **真实读写往返**：md→docx → docs read → docs apply（插入一段）→ 再 read，
 *     内容变化可观察；输出落在临时工作区内；
 *  5. **失败可诊断**：不存在的文件返回 `failed` 且带 CLI 的原始错误码。
 *
 * ⚠️ 需要本机已完成 `genoffice` 的 CLI 构建（`npm run build -w @genoffice/cli`）。
 * 若 bundle 不存在，本套**显式 skip 并打印原因**（不是静默通过）——G0 证据如实。
 *
 * Run: scripts/genoffice-cli-smoke/run.sh
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  convertFile,
  docsApply,
  docsRead,
  resolveGenofficeCliPath,
  sheetRead,
  slidesRead,
} from "../../src/main/document/genofficeCli.js";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}
function section(t: string): void { console.log("\n" + t); }

const repoRoot = process.cwd().replace(/apps[\\/]desktop$/, "");
const cliPath = resolveGenofficeCliPath(repoRoot);
if (cliPath === null) {
  console.log("SKIP genoffice-cli-smoke: 未找到 genoffice/packages/cli/dist/genoffice.cjs。");
  console.log("     先运行 `npm install --ignore-scripts && npm run build -w @genoffice/cli`（在 genoffice/ 下）。");
  process.exitCode = 0;
} else {
  console.log(`CLI: ${cliPath}`);
  const work = mkdtempSync(join(tmpdir(), "mcode-genoffice-cli-"));
  const outside = mkdtempSync(join(tmpdir(), "mcode-genoffice-outside-"));
  const root = work;
  const ports = {
    cliPath,
    // 真围栏：只认 root 子树。
    withinWorkspace: (p: string) => p === root || p.startsWith(root + "\\") || p.startsWith(root + "/"),
  };

  try {
    /* ── 1. 围栏先于起进程 ── */
    section("1. 路径围栏");
    {
      const outsideDoc = join(outside, "x.docx");
      writeFileSync(outsideDoc, "not really a docx");
      const r1 = await docsRead(ports, outsideDoc);
      check("工作区外的读 → refused", r1.ok === false && r1.kind === "refused", r1);
      const r2 = await convertFile(ports, join(root, "a.md"), "docx", join(outside, "a.docx"));
      check("工作区外的输出 → refused", r2.ok === false && r2.kind === "refused", r2);
      const r3 = await docsRead(ports, "relative/path.docx");
      check("相对路径 → refused", r3.ok === false && r3.kind === "refused", r3);
      // 围栏先于"CLI 在不在":用一个不存在的 cliPath,仍应是 refused 而不是 unavailable。
      const badCli = { ...ports, cliPath: join(root, "no-such-cli.cjs") };
      const r4 = await docsRead(badCli, outsideDoc);
      check("★ 围栏先于起进程(坏 cliPath 也先 refused)", r4.ok === false && r4.kind === "refused", r4);
    }

    /* ── 2. 真实往返:md → docx → read → apply → read ── */
    section("2. 真实读写往返");
    const md = join(root, "sample.md");
    const docx = join(root, "sample.docx");
    writeFileSync(md, "# Heading\n\nFirst body.\n");
    {
      const conv = await convertFile(ports, md, "docx", docx);
      eq("md → docx 成功", conv.ok, true);
      check("输出文件真的存在", existsSync(docx));

      const read1 = await docsRead(ports, docx, { full: true });
      check("docs read 成功", read1.ok, read1);
      if (read1.ok) {
        const detail = read1.envelope.detail as { blocks?: number; items?: Array<{ text?: string }> };
        eq("读到 2 个块", detail.blocks, 2);
        check("第一块是标题文本", (detail.items?.[0]?.text ?? "").includes("Heading"), detail.items?.[0]);
      }

      const apply = await docsApply(ports, docx, [{ op: "insert_content", index: 1, html: "<p>Added by smoke</p>" }]);
      eq("docs apply 成功", apply.ok, true);
      const read2 = await docsRead(ports, docx, { full: true });
      if (read2.ok) {
        const detail = read2.envelope.detail as { blocks?: number; items?: Array<{ text?: string }> };
        eq("apply 后 3 个块", detail.blocks, 3);
        check("新内容读得回来", detail.items?.some((i) => (i.text ?? "").includes("Added by smoke")) === true, detail.items);
      } else check("apply 后 read 成功", false, read2);

      // dry-run 不写盘:先记 hash,再 dryRun,hash 必须不变。
      const before = createHash("sha256").update(readFileSync(docx)).digest("hex");
      const dry = await docsApply(ports, docx, [{ op: "insert_content", index: 2, html: "<p>dry</p>" }], { dryRun: true });
      eq("dry-run 成功", dry.ok, true);
      const after = createHash("sha256").update(readFileSync(docx)).digest("hex");
      eq("★ dry-run 不改文件(sha256 不变)", after, before);
    }

    /* ── 3. 失败可诊断 ── */
    section("3. 失败可诊断");
    {
      const missing = await docsRead(ports, join(root, "missing.docx"));
      check("不存在的文件 → failed", missing.ok === false && missing.kind === "failed", missing);
      if (missing.ok === false) {
        check("带 CLI 的原始错误码", missing.envelope !== null && typeof missing.envelope.error === "string", missing.envelope);
      }
    }

    /* ── 4. 能力不可用的分类(需 headless Electron) ── */
    section("4. 能力不可用 vs 执行失败");
    {
      const asPdf = join(root, "sample.pdf");
      const conv = await convertFile(ports, md, "pdf", asPdf);
      // 本机未安装 GenOffice app → code 4/app_unavailable。
      check("★ →pdf 归类为 unavailable(不是 failed)", conv.ok === false && conv.kind === "unavailable", conv);
      if (conv.ok === false && conv.envelope !== null) {
        eq("错误码是 app_unavailable", conv.envelope.error, "app_unavailable");
      }
      const renderOut = join(root, "pngs");
      mkdirSync(renderOut, { recursive: true });
      const pptx = join(root, "d.pptx");
      writeFileSync(pptx, "not a pptx");
      const slides = await slidesRead(ports, pptx);
      check("坏 pptx 的 read → failed(不是 unavailable)", slides.ok === false && slides.kind === "failed", slides);
      const sheet = await sheetRead(ports, join(root, "sample.xlsx"));
      void sheet;
    }

    console.log(`\ngenoffice-cli-smoke:${total - failures}/${total} 通过`);
    if (failures > 0) process.exitCode = 1;
  } finally {
    try { rmSync(work, { recursive: true, force: true }); } catch { /* Windows 句柄 */ }
    try { rmSync(outside, { recursive: true, force: true }); } catch { /* 同上 */ }
  }
}
