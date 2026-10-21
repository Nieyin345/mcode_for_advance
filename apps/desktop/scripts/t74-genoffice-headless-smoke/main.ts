import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createFromFile, mergeTemplate, renderPdfPages, docsRead, resolveGenofficeCliPath } from "../../src/main/document/genofficeCli.js";

const hash = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
let good = 0, bad = 0;
function check(name: string, yes: boolean, extra?: unknown): void {
  if (yes) { good++; console.log("  ok " + name); }
  else { bad++; console.log("  FAIL " + name + " " + JSON.stringify(extra)); }
}
const repo = resolve(process.cwd(), "../..");
const cliPath = resolveGenofficeCliPath(repo);
if (!cliPath) {
  console.log("SKIP T74: vendor CLI bundle absent; real file validation unavailable");
  process.exitCode = 1;
} else {
  const root = mkdtempSync(join(tmpdir(), "mcode-t74-headless-"));
  const outside = mkdtempSync(join(tmpdir(), "mcode-t74-external-"));
  const ports = { cliPath, withinWorkspace: (p: string) => p === root || p.startsWith(root + "\\") || p.startsWith(root + "/") };
  const absent = { ...ports, cliPath: join(root, "missing.cjs") };
  try {
    const html = join(root, "template.html");
    const orig = "<h1>Hello {{name}}</h1><p>Order {{order}}</p>";
    writeFileSync(html, orig);
    const sourceHash = hash(html);
    const created = join(root, "template.docx");
    const createdResult = await createFromFile(ports, "docx", html, created);
    check("create docx via upstream CLI", createdResult.ok && existsSync(created), createdResult);
    if (existsSync(created)) {
      const cliEnv = { ELECTRON_RUN_AS_NODE: "1", PATH: process.env.PATH ?? "" };
      const selection = spawnSync(process.execPath, [cliPath, "selection", created, "--json"], { env: cliEnv, encoding: "utf8", timeout: 15000 });
      check("selection needs live GUI and returns app_unavailable, not fabricated headless success",
        selection.status === 4 && selection.stdout.includes('"app_unavailable"'), { exit: selection.status, out: selection.stdout.slice(0, 300) });
      const txn = spawnSync(process.execPath, [cliPath, "txn", "--json"], { env: cliEnv, encoding: "utf8", timeout: 15000 });
      check("txn is not a registered top-level CLI command",
        txn.status === 1 && txn.stdout.includes('"unknown_command"'), { exit: txn.status, out: txn.stdout.slice(0, 300) });
      const readable = await docsRead(ports, created, { full: true });
      check("created docx reopened by independent read", readable.ok && JSON.stringify(readable.envelope).includes("{{name}}"), readable);
      check("source never modified by create", hash(html) === sourceHash);
      const duplicated = await createFromFile(ports, "docx", html, created);
      check("same output refused without CAS/force", !duplicated.ok && duplicated.kind === "refused", duplicated);
      const before = hash(created);
      const merged = join(root, "merged.docx");
      const mergedResult = await mergeTemplate(ports, created, { name: "Ada", order: 42 }, merged);
      check("merge into a new file via upstream CLI", mergedResult.ok && existsSync(merged), mergedResult);
      if (existsSync(merged)) {
        const reopened = await docsRead(ports, merged, { full: true });
        check("merge independently reopened and substitutions visible", reopened.ok && JSON.stringify(reopened.envelope).includes("Ada") && JSON.stringify(reopened.envelope).includes("42"), reopened);
        check("merge preserves template original bytes", hash(created) === before);
        const repeat = await mergeTemplate(ports, created, { name: "Bob" }, merged);
        check("merge refuses existing output", !repeat.ok && repeat.kind === "refused", repeat);
      }
      const unresolved = await mergeTemplate(ports, created, { name: "Ada" }, join(root, "strict-missing.docx"));
      check("strict default refuses unresolved placeholders without output", !unresolved.ok && !existsSync(join(root, "strict-missing.docx")), unresolved);
    }
    const csv = join(root, "table.csv");
    const workbook = join(root, "table.xlsx");
    writeFileSync(csv, "label,count\nT74-test,23\n");
    const csvBefore = hash(csv);
    const book = await createFromFile(ports, "xlsx", csv, workbook, { header: true });
    check("create xlsx from bounded CSV with vendor CLI", book.ok && existsSync(workbook), book);
    if (existsSync(workbook)) {
      check("CSV input unchanged", hash(csv) === csvBefore);
      const read = spawnSync(process.execPath, [cliPath, "sheet", "check", workbook, "--json"], {
        env: { ELECTRON_RUN_AS_NODE: "1", PATH: process.env.PATH ?? "" }, encoding: "utf8", timeout: 60000,
      });
      check("independent upstream sheet check accepts created xlsx", read.status === 0 && read.stdout.includes('"status":"ok"'), { status: read.status, stdout: read.stdout.slice(0, 250), stderr: read.stderr.slice(0, 250) });
    }

    // Negative cases: the port must refuse BEFORE checking the missing CLI.
    const cases = [
      ["outside input", () => createFromFile(absent, "docx", join(outside, "outside.html"), join(root, "outside.docx"))],
      ["outside output", () => createFromFile(absent, "docx", html, join(outside, "external.docx"))],
      ["relative input", () => createFromFile(absent, "docx", "relative.html", join(root, "relative.docx"))],
      ["merge outside template", () => mergeTemplate(absent, join(outside, "template.docx"), { x: 1 }, join(root, "outside-merge.docx"))],
      ["merge outside output", () => mergeTemplate(absent, created, { x: 1 }, join(outside, "external.docx"))],
      ["render outside source", () => renderPdfPages(absent, join(outside, "external.pdf"), join(root, "png"))],
      ["render outside dir", () => renderPdfPages(absent, join(root, "fake.pdf"), join(outside, "png"))],
    ] as const;
    for (const [name, call] of cases) {
      const result = await call();
      check(name + " refused before child", !result.ok && result.kind === "refused", result);
    }
    check("no outside write by rejected calls", !existsSync(join(outside, "external.docx")) && !existsSync(join(outside, "png")));

    try {
      const link = join(root, "escape");
      symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
      const linked = await createFromFile(absent, "docx", html, join(link, "evil.docx"));
      check("symlink/junction escape refused", !linked.ok && linked.kind === "refused", linked);
      const linkedMerge = await mergeTemplate(absent, join(link, "template.docx"), { x: 1 }, join(root, "link.docx"));
      check("symlink/junction read escape refused", !linkedMerge.ok && linkedMerge.kind === "refused", linkedMerge);
      const linkedRender = await renderPdfPages(absent, join(root, "fake.pdf"), join(link, "png"));
      check("symlink/junction render escape refused", !linkedRender.ok && linkedRender.kind === "refused", linkedRender);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EPERM") throw e;
      console.log("  SKIP symlink: OS policy forbids junction");
    }
    const noCli = await createFromFile(absent, "docx", html, join(root, "no-cli.docx"));
    check("missing vendor classified unavailable", !noCli.ok && noCli.kind === "unavailable", noCli);
    check("missing vendor cannot write", !existsSync(join(root, "no-cli.docx")));

    const broken = join(root, "broken.docx");
    writeFileSync(broken, "invalid zip");
    const invalid = await mergeTemplate(ports, broken, { name: "x" }, join(root, "broken-out.docx"));
    check("damaged template fails without output", !invalid.ok && !existsSync(join(root, "broken-out.docx")), invalid);

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    const cancelled = await createFromFile(ports, "docx", html, join(root, "cancelled.docx"), { signal: alreadyAborted.signal });
    check("pre-aborted request never commits output", !cancelled.ok && !existsSync(join(root, "cancelled.docx")), cancelled);

    const badKind = await createFromFile(absent, "pptx" as "docx", html, join(root, "no-pptx.pptx"));
    check("unsupported create type explicit refused", !badKind.ok && badKind.kind === "refused", badKind);
    const malicious = await mergeTemplate(absent, created, { value: BigInt(42) }, join(root, "invalid-data.docx"));
    check("non-JSON merge data refuses before spawn", !malicious.ok && malicious.kind === "refused", malicious);
    const invalidExt = await createFromFile(absent, "docx", csv, join(root, "wrong.docx"));
    check("unsupported source extension refused", !invalidExt.ok && invalidExt.kind === "refused", invalidExt);

    // Real one-page PDF fixture (PDFium read + PNG magic header if the bundled runtime is available).
    const pdf = join(root, "simple.pdf");
    const stream = "BT /F1 12 Tf 40 50 Td (T74) Tj ET";
    const objs = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
      "<< /Length " + stream.length + " >>\nstream\n" + stream + "\nendstream",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];
    let body = "%PDF-1.4\n";
    const positions = [0];
    for (let i = 0; i < objs.length; i++) { positions.push(Buffer.byteLength(body)); body += (i + 1) + " 0 obj\n" + objs[i] + "\nendobj\n"; }
    const xref = Buffer.byteLength(body);
    body += "xref\n0 " + (objs.length + 1) + "\n0000000000 65535 f \n";
    for (const pos of positions.slice(1)) body += String(pos).padStart(10, "0") + " 00000 n \n";
    body += "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n" + xref + "\n%%EOF\n";
    writeFileSync(pdf, body);
    const pdfBefore = hash(pdf);
    const renderDir = join(root, "rendered");
    const rendered = await renderPdfPages(ports, pdf, renderDir, { scale: 1 });
    if (rendered.ok) {
      const png = join(renderDir, "simple-01.png");
      check("vendor PDF render creates real PNG", existsSync(png) && readFileSync(png).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), rendered);
      check("independent PNG magic and original PDF bytes", hash(pdf) === pdfBefore);
      const collision = await renderPdfPages(absent, pdf, renderDir);
      check("existing render directory refused before child", !collision.ok && collision.kind === "refused", collision);
    } else {
      console.log("  unsupported/render: " + JSON.stringify(rendered));
      check("renderer resource absence is reported instead of fabricated success", rendered.kind === "unavailable", rendered);
    }
    check("no unrelated payload output on failures", !existsSync(join(root, "invalid-data.docx")) && !existsSync(join(root, "wrong.docx")));
    console.log("T74 headless operations: " + good + "/" + (good + bad) + " passed; failed=" + bad);
    process.exitCode = bad ? 1 : 0;
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
}
