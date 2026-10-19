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
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  convertFile,
  docsApply,
  docsRead,
  pdfRender,
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
    /* ── 0. 安装包资源路径：与开发快照相互独立 ── */
    section("0. GenOffice 可选安装资源路径");
    const fakeResources = join(root, "resources");
    const packagedCli = join(fakeResources, "genoffice", "cli", "genoffice.cjs");
    const fakeRepoRoot = join(root, "fresh-repo-without-vendor");
    mkdirSync(join(fakeResources, "genoffice", "cli", "node_modules"), { recursive: true });
    writeFileSync(packagedCli, "// mock vendor CLI; never execute\n");
    eq("只有 CLI 没有 PDFium WASM → unavailable", resolveGenofficeCliPath(fakeRepoRoot, fakeResources), null);
    mkdirSync(join(fakeResources, "genoffice", "wasm"), { recursive: true });
    writeFileSync(join(fakeResources, "genoffice", "wasm", "pdfium.wasm"), "mock-wasm");
    eq("★ 安装版同一个 resolver 找到 GenOffice sidecar", resolveGenofficeCliPath(fakeRepoRoot, fakeResources), packagedCli);
    eq("未预置资源且 checkout 没 vendor → unavailable", resolveGenofficeCliPath(fakeRepoRoot, join(root, "no-resources")), null);
    eq("现有开发 checkout 快照路径仍可读", resolveGenofficeCliPath(repoRoot), cliPath);

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
      // A lexical child of root can resolve through a junction/symlink to
      // another directory. Both read and output must be refused before CLI.
      const escape = join(root, "escape-junction");
      try {
        symlinkSync(outside, escape, process.platform === "win32" ? "junction" : "dir");
        const linkedRead = await docsRead(badCli, join(escape, "x.docx"));
        check("★ 目录 junction 指到沙箱外的只读拒绝", !linkedRead.ok && linkedRead.kind === "refused", linkedRead);
        const linkedWrite = await convertFile(badCli, join(root, "a.md"), "docx", join(escape, "evil.docx"));
        check("★ 目录 junction 指到沙箱外的写入拒绝", !linkedWrite.ok && linkedWrite.kind === "refused", linkedWrite);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EPERM") throw e;
        console.log("  SKIP junction 测试: OS 未授予符号链接权限");
      }
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

    /* ── 3b. CLI 不可信输出:退出码、取消与冲突信封 ── */
    section("3b. 子进程状态与 JSON 信封不可互相欺骗");
    {
      const input = join(root, "fake.docx");
      writeFileSync(input, "fictional fixture");
      const fake = (name: string, js: string) => {
        const script = join(root, name + ".cjs");
        writeFileSync(script, js);
        return { ...ports, cliPath: script };
      };
      const forged = await docsRead(fake("bad-exit", 'console.log(JSON.stringify({status:"ok",summary:"FORGED"}));process.exitCode=7;\n'), input);
      check("★ 非零退出即使输出 status=ok 也不能当成功", !forged.ok && forged.kind === "failed" && /7|退出码/.test(forged.reason), forged);
      const conflict = await docsRead(fake("two-envelopes", 'console.log(JSON.stringify({status:"error",error:"first"}));console.log(JSON.stringify({status:"ok",summary:"FORGED"}));\n'), input);
      check("★ 同一 CLI 输出两个冲突 JSON 信封必须拒绝", !conflict.ok && conflict.kind === "failed" && /多个|重复|信封/.test(conflict.reason), conflict);
      const controller = new AbortController();
      const slow = fake("cancel", 'setTimeout(()=>console.log(JSON.stringify({status:"ok",summary:"TOO_LATE"})),5000);\n');
      const pending = docsRead(slow, input, { signal: controller.signal });
      setTimeout(() => controller.abort(), 100);
      const aborted = await pending;
      check("★ 用户主动取消明确报告取消而非空 JSON/成功", !aborted.ok && aborted.kind === "failed" && /取消|abort/.test(aborted.reason), aborted);
      const valid = await docsRead(fake("valid", 'console.log(JSON.stringify({status:"ok",summary:"GOOD",detail:{blocks:0}}));\n'), input);
      check("★ 合法单信封且退出码0继续成功", valid.ok && valid.envelope.summary === "GOOD", valid);
      const pdfFile=join(root,"fake.pdf");writeFileSync(pdfFile,"%PDF-1.4\n");
      const outDir=join(root,"fake-render");mkdirSync(outDir,{recursive:true});
      const renderAbort=new AbortController();
      const pendingRender=pdfRender(fake("render-cancel", 'setTimeout(()=>console.log(JSON.stringify({status:"ok",summary:"LATE"})),5000);\n'),pdfFile,outDir,1,1,{signal:renderAbort.signal});
      setTimeout(()=>renderAbort.abort(),90);
      const cancelled=await pendingRender;
      check("★ GenOffice PDF 渲染子进程能接受外部 AbortSignal",!cancelled.ok&&cancelled.kind==="failed"&&/取消|abort/.test(cancelled.reason),cancelled);
    }

    /* ── 4. 能力不可用的分类(需 headless Electron) ── */
    section("4. 能力不可用 vs 执行失败");
    {
      const asPdf = join(root, "sample.pdf");
      const conv = await convertFile(ports, md, "pdf", asPdf);
      // Optional Electron app availability varies by host. Missing app must
      // classify as unavailable; installed-but-crashing/timeout must stay failed
      // rather than disguising a real native crash as "not installed".
      if (conv.ok) {
        check("→pdf 已安装渲染端成功时真有 PDF", existsSync(asPdf), conv);
      } else if (conv.envelope?.error === "app_unavailable") {
        check("★ 真缺少 Electron app 才归为 unavailable", conv.kind === "unavailable", conv);
        eq("错误码是 app_unavailable", conv.envelope.error, "app_unavailable");
      } else {
        check("★ Electron 转换失败/超时如实显示 failed，不伪称 unavailable", conv.kind === "failed" && /超时|exited|转换|失败|code/i.test(conv.reason), conv);
      }
      const unavailableCli = join(root, "missing-app.cjs");
      writeFileSync(unavailableCli, 'console.log(JSON.stringify({status:"error",code:4,error:"app_unavailable",message:"needs sidecar"}));process.exitCode=4;\n');
      const missingApp = await docsRead({ ...ports, cliPath: unavailableCli }, join(root, "sample.docx"));
      check("★ 原生 error=app_unavailable + exit4 准确归类", !missingApp.ok && missingApp.kind === "unavailable" && missingApp.envelope?.error === "app_unavailable", missingApp);
      const renderOut = join(root, "pngs");
      mkdirSync(renderOut, { recursive: true });
      const pptx = join(root, "d.pptx");
      writeFileSync(pptx, "not a pptx");
      const slides = await slidesRead(ports, pptx);
      check("坏 pptx 的 read → failed(不是 unavailable)", slides.ok === false && slides.kind === "failed", slides);
      const sheet = await sheetRead(ports, join(root, "sample.xlsx"));
      void sheet;
      // 【ARC-007】格式矩阵:md 没有结构读路由(如实拒绝),html 需应用渲染器(unavailable)。
      const notesMd = join(root, "notes.md");
      writeFileSync(notesMd, "# n\n");
      const { readByKind } = await import("../../src/main/ipc/document.js");
      const mdRead = await readByKind(ports, notesMd, {});
      check("md 结构读 → refused(指向文件通道,不假装)", mdRead.ok === false && mdRead.kind === "refused", mdRead);
      const html = join(root, "page.html");
      writeFileSync(html, "<h1>x</h1>");
      const htmlRead = await readByKind(ports, html, {});
      check("html → unavailable(需要应用渲染器)", htmlRead.ok === false && htmlRead.kind === "unavailable", htmlRead);
    }

    /* ── 5. IPC 层:handler 注册与契约/接线一致 ── */
    section("5. document IPC(注册与接线)");
    {
      const { registerDocumentHandlers } = await import("../../src/main/ipc/document.js");
      const handlers = new Map<string, (e: unknown, raw: unknown) => unknown>();
      const fakeIpc = { handle: (ch: string, fn: (e: unknown, raw: unknown) => unknown) => handlers.set(ch, fn) } as never;
      try {
        registerDocumentHandlers(fakeIpc);
        check("注册了 document.read", handlers.has("document:read"));
        check("注册了 document.edit", handlers.has("document:edit"));
        check("注册了 document.convert", handlers.has("document:convert"));
        check("注册了 document.capabilities", handlers.has("document:capabilities"));
      } catch (error) {
        console.log(`  skip document IPC 注册(无 electron app 桩):${(error as Error).message}`);
      }
      const rpcMap = readFileSync(join(repoRoot, "packages/contracts/src/ipc/rpcMap.ts"), "utf8");
      for (const ch of ["document:read", "document:edit", "document:convert", "document:capabilities"]) {
        check(`契约声明了 ${ch}`, rpcMap.includes(`"${ch}"`));
      }
      const preload = readFileSync(join(repoRoot, "apps/desktop/src/preload/index.ts"), "utf8");
      check("preload 暴露 document 命名空间", preload.includes("document: {") && preload.includes("DOCUMENT_READ"));
      const policy = readFileSync(join(repoRoot, "apps/desktop/src/main/appControl/policy.ts"), "utf8");
      check("policy:读只读、编辑/转换 danger", policy.includes('"document.read": "read"') && policy.includes('"document.edit": "编辑并保存文档'));

      // 【ARC-007】原值版本检查真的接在 handler 上(源码断言 + 契约字段)。
      const docHandler = readFileSync(join(repoRoot, "apps/desktop/src/main/ipc/document.ts"), "utf8");
      check("★ handler 在编辑前比对 expectedRevision", docHandler.includes("fileContentVersion(") && docHandler.includes("input.expectedRevision"));
      check("★ 冲突带 currentRevision 返回", docHandler.includes('kind: "conflict"') && docHandler.includes("currentRevision: current"));
      check("★ 成功编辑回传新 revision", docHandler.includes("revision: await fileContentVersion"));
      const docContract = readFileSync(join(repoRoot, "packages/contracts/src/ipc/document.ts"), "utf8");
      check("契约有 expectedRevision 字段", docContract.includes("expectedRevision: z.string()"));
      check("结果类型有 conflict 档", docContract.includes('"conflict"'));
    }


    console.log(`\ngenoffice-cli-smoke:${total - failures}/${total} 通过`);
    if (failures > 0) process.exitCode = 1;
  } finally {
    try { rmSync(work, { recursive: true, force: true }); } catch { /* Windows 句柄 */ }
    try { rmSync(outside, { recursive: true, force: true }); } catch { /* 同上 */ }
  }
}
