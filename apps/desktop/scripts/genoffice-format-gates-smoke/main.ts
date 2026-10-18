/**
 * 【ARC-007】**逐格式门**回归网 —— 真 GenOffice CLI、真子进程、真文件。
 *
 * 与 `genoffice-cli-smoke` 的分工：那套钉的是**适配层本身的机制**（围栏先于起进程、
 * 信封解析、unavailable/failed 分类、一条 md→docx 往返）。这一套不重复它，钉的是
 * **每种格式进门时的语义**：
 *
 *  - G1 打开不重写：对每种能读的格式（docx / pptx，以及 xlsx 的纯 Node 读路径
 *    `sheet check`），read 前后文件 sha256 必须逐字节一致。**为什么**：编辑器/查看器
 *    "打开→不改→关闭"不得改写用户的文件 —— 一次无意的重写会刷新 mtime、破坏外部
 *    同步工具（网盘/版本库）的"未变"判断、触发 OnlyOffice 之类写入方的冲突检测，
 *    甚至让"打开即修复"把用户没同意的格式变更悄悄落盘。这是"只读"两个字的字面
 *    含义，不是实现细节。
 *  - G2 编辑往返：docx 生成→apply→再 read 能看到新内容；pptx create→slides read；
 *    xlsx 从 CSV create→`sheet check` 纯 Node 读回（占位符定位到具体单元格，证明
 *    真解析了内容）；应用侧 `sheet read` 走 Rust sidecar，本机无 sidecar 时显式记
 *    `sidecar_unavailable` 并跳过该断言 —— 不算通过也不算失败，但必须在输出里
 *    可见，且要带上具体命令与 CLI 错误码。
 *
 * ## xlsx 命令依赖矩阵（本套件只覆盖不需要 sidecar 的部分）
 *
 *   纯 Node（JSZip + xlsx-gateway；本机无 sidecar 也能跑，已实测）：
 *     - `create --type xlsx --from <csv|json> [--header]`
 *     - `convert <csv> --to xlsx`
 *     - `sheet check <file>`      ← 本套件用它做 xlsx 的「读一次」与「读回」
 *     - `guide sheets`
 *     - `sheet apply --ops`（单元格/格式/结构类 op；公式缓存、add_pivot 的公式源、
 *       convert_to_values 才会走 sidecar）
 *   需要 Rust xlsx-sidecar（`XLSX_SIDECAR_PATH`，或
 *   `genoffice/apps/sheets/native/xlsx-engine/target/release/xlsx-sidecar`）：
 *     - `sheet read` / `info <xlsx>` / `merge <xlsx>` / `convert <xlsx> --to csv` /
 *       `sheet apply --cells`（先做 workbookSummary）
 *   需要 GenOffice 应用（headless Electron）：
 *     - `convert <xlsx> --to pdf` / `render` / `open`
 *
 *   应用适配层的 `sheetRead` 走 `sheet read`，所以本套件对它保留显式 SKIP（G2），
 *   并打印命令与错误码。`sheet check` 是 CLI 里唯一不依赖 sidecar 的 xlsx 读路径，
 *   它真解析文件内容（JSZip 读 workbook.xml / sheet XML / sharedStrings），不是拿
 *   写路径冒充读路径。
 *  - G3 格式路由拒绝面：`readByKind` 的行为必须与 `documentKindOf` 的判据一致
 *    （md→refused 指向 file.readFile；html→unavailable；未知扩展名→refused），
 *    且每种拒绝理由文本非空。**为什么**：路由的失败必须"说得出为什么"，
 *    静默退化成"反正读不出来"等于把能力缺口藏起来。
 *  - G4 围栏：所有写路径（apply 输出 / convert 输出）指到工作区外 → refused，
 *    且目标文件**确实不存在**。**为什么**：refused 只是返回值，若进程已经先写了
 *    半个文件再拒绝，围栏就是纸的 —— 必须验磁盘事实，不能只验返回值。
 *  - G5 dry-run 语义：`docs apply --dry-run` 在已存在且可读的 docx 上不改 sha256。
 *    与 G1 同判据，但针对写命令 —— dry-run 说"没写"就必须真没写。
 *  - 反向正控：故意改一个字节，确认 sha256 比较真的能区分（防"两次都读到空/失败、
 *    哈希相等"的假绿）。
 *
 * ⚠️ 需要本机已构建 `genoffice/packages/cli/dist/genoffice.cjs`。bundle 不存在时整套
 * 显式 SKIP 并打印原因（与 `genoffice-cli-smoke` 一致，不静默通过）。
 *
 * Run: scripts/genoffice-format-gates-smoke/run.sh
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  convertFile,
  docsApply,
  docsRead,
  resolveGenofficeCliPath,
  sheetRead,
  slidesRead,
  type GenofficeEnvelope,
  type GenofficeResult,
} from "../../src/main/document/genofficeCli.js";
// `documentKindOf` 是纯契约函数（唯一格式判据）。`readByKind` 经 `@main/ipc/document`
// 动态导入（与 genoffice-cli-smoke 同做法）：那条链经 pathGuard 拉进 store/db，
// 静态 import 会让模块装载期就碰数据根；动态导入把装载时机压到真正用到它之前。
import { documentKindOf } from "@contracts/documentKind";

/** 直接驱动 CLI 的 create 子命令（适配层不封装 create，读仍走被测的 read 函数）。 */
function cliCreate(args: string[], stdin?: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [cliPath!, ...args, "--json"], {
    // 与适配层同取向：不继承宿主 env，只给运行所需的 PATH。
    env: { ELECTRON_RUN_AS_NODE: "1", ...(process.env.PATH ? { PATH: process.env.PATH } : {}) },
    ...(stdin !== undefined ? { input: stdin } : {}),
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: r.status, stdout: (r.stdout ?? "").slice(0, 300), stderr: (r.stderr ?? "").slice(0, 300) };
}

/**
 * 跑一条 **纯 Node** 的 xlsx CLI 命令并解析 `--json` 信封。
 *
 * 为什么不用适配层：适配层只封装了 `sheet read`（需要 sidecar）；`sheet check` /
 * `create` 这类纯 Node 子命令没有封装，且本任务不改适配层。这里与 `cliCreate`
 * 同一条调用口径（不继承宿主 env），只是把信封解析出来供断言。
 *
 * `stdout` 在解析失败时保留原文，便于在 FAIL 里看到 CLI 到底说了什么。
 */
function cliJson(args: string[], stdin?: string): {
  status: number | null;
  envelope: GenofficeEnvelope | null;
  raw: string;
} {
  const r = spawnSync(process.execPath, [cliPath!, ...args, "--json"], {
    env: { ELECTRON_RUN_AS_NODE: "1", ...(process.env.PATH ? { PATH: process.env.PATH } : {}) },
    ...(stdin !== undefined ? { input: stdin } : {}),
    encoding: "utf8",
    timeout: 60_000,
  });
  const out = r.stdout ?? "";
  const line = out.trim().split("\n").filter((l) => l.trim().startsWith("{")).pop();
  let envelope: GenofficeEnvelope | null = null;
  if (line !== undefined) {
    try { envelope = JSON.parse(line) as GenofficeEnvelope; } catch { /* raw 里能看到 */ }
  }
  return { status: r.status, envelope, raw: out.slice(0, 400) };
}

let failures = 0;
let total = 0;
/** 显式跳过（不算通过也不算失败，但必须出现在收尾输出里）。 */
const skipped: string[] = [];

function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}
function skip(name: string, reason: string): void {
  skipped.push(`${name}（${reason}）`);
  console.log(`  SKIP ${name} — ${reason}`);
}
function section(t: string): void { console.log("\n" + t); }

/** 文件原始字节的 sha256。读失败直接抛 —— "读不到"不能被当成"哈希相等"。 */
function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** 断言结果的通用形状：ok===false 且 kind 命中，reason 非空。 */
function refusalOf(r: GenofficeResult): { kind: string; reason: string } | null {
  if (r.ok) return null;
  const reason = typeof r.reason === "string" ? r.reason.trim() : "";
  return { kind: r.kind, reason };
}

const repoRoot = process.cwd().replace(/apps[\\/]desktop$/, "");
const cliPath = resolveGenofficeCliPath(repoRoot);
if (cliPath === null) {
  console.log("SKIP genoffice-format-gates-smoke: 未找到 genoffice/packages/cli/dist/genoffice.cjs。");
  console.log("     先运行 `npm install --ignore-scripts && npm run build -w @genoffice/cli`（在 genoffice/ 下）。");
  process.exitCode = 0;
} else {
  console.log(`CLI: ${cliPath}`);
  const work = mkdtempSync(join(tmpdir(), "mcode-genoffice-gates-"));
  const outside = mkdtempSync(join(tmpdir(), "mcode-genoffice-gates-outside-"));
  const root = work;
  const ports = {
    cliPath,
    // 真围栏：只认 root 子树（与生产 `findContainingWorkspaceRoot` 同取向的业务桩）。
    withinWorkspace: (p: string) => p === root || p.startsWith(root + "\\") || p.startsWith(root + "/"),
  };

  try {
    /* ══════════ G1 打开不重写 ══════════
     * 对每种 CLI 能读的格式：生成样本 → read → 前后 sha256 必须一致。
     * 判据是**文件字节**，不是返回值 —— read 成功但顺手重写了文件同样是违约。 */
    section("G1 打开不重写（读前后 sha256 逐字节一致）");
    const docx = join(root, "g1.docx");
    const pptx = join(root, "g1.pptx");
    {
      const md = join(root, "g1.md");
      writeFileSync(md, "# Heading\n\nBody text.\n");
      const conv = await convertFile(ports, md, "docx", docx);
      check("前置：md→docx 样本生成成功", conv.ok, conv);

      // pptx：create 空白 deck（一页），无需 --spec 的复杂夹具；CLI 要求 --ops（空数组即可）。
      // CLI 适配层没有 create 封装（不在本次改动面），这里直接调 CLI 造样本；
      // 读仍走被测的 slidesRead。
      const created = cliCreate(["create", "--type", "pptx", "--ops", "-", "--out", pptx], "[]");
      const createdOk = created.status === 0 && existsSync(pptx);
      check("前置：pptx 样本生成成功（create）", createdOk, created);

      if (createdOk) {
        const before = sha256(docx);
        const r1 = await docsRead(ports, docx, { full: true });
        const after = sha256(docx);
        check("G1 docx：docs read 成功（否则下面的哈希比较没有意义）", r1.ok, r1);
        eq("G1 docx：打开→不改→关闭后文件 sha256 不变", after, before);
        if (after !== before) console.log(`       前后哈希:${before.slice(0, 12)}… → ${after.slice(0, 12)}…`);

        const pBefore = sha256(pptx);
        const r2 = await slidesRead(ports, pptx);
        const pAfter = sha256(pptx);
        check("G1 pptx：slides read 成功（否则下面的哈希比较没有意义）", r2.ok, r2);
        eq("G1 pptx：打开→不改→关闭后文件 sha256 不变", pAfter, pBefore);
        if (pAfter !== pBefore) console.log(`       前后哈希:${pBefore.slice(0, 12)}… → ${pAfter.slice(0, 12)}…`);

        /* ── xlsx：应用侧 `sheet read` 需要 Rust sidecar，但 CLI 的 `sheet check`
         * 是纯 Node 的读路径（JSZip 解析 workbook.xml / sheet XML / sharedStrings，
         * 不 spawn sidecar）。用它对「打开不重写」做同判据断言；read 是否成功由
         * `detail.checks` 的 8 项检查存在来证明 —— 空信封也算"成功"会变成假绿。 */
        const xlsx = join(root, "g1.xlsx");
        // 样本里放一个 TODO，让 check 有真实 finding 可报：证明它真读了单元格文本，
        // 而不是只把 zip 打开、什么都没解析就返回空 issues。
        const xlsxJson = join(root, "g1-xlsx.json");
        writeFileSync(xlsxJson, JSON.stringify([
          ["name", "qty"],
          ["widget", 3],
          ["TODO", 4],
        ]));
        const xCreated = cliCreate(["create", "--type", "xlsx", "--from", xlsxJson, "--out", xlsx]);
        const xCreatedOk = xCreated.status === 0 && existsSync(xlsx);
        check("前置：xlsx 样本生成成功（create --from json，纯 JS）", xCreatedOk, xCreated);
        if (xCreatedOk) {
          const xBefore = sha256(xlsx);
          const check1 = cliJson(["sheet", "check", xlsx]);
          const xAfter = sha256(xlsx);
          const checks = (check1.envelope?.detail as { checks?: unknown[] } | undefined)?.checks;
          // read 成功的判据：status ok 且 8 项检查都报了（说明 checkWorkbook 真跑完）。
          check(
            "G1 xlsx：sheet check 读取成功（返回完整检查清单）",
            check1.status === 0 && check1.envelope?.status === "ok" && Array.isArray(checks) && checks.length >= 8,
            check1.envelope ?? check1.raw,
          );
          // 内容真的被解析：TODO 文本被定位到具体单元格（A3）。
          const issues = (check1.envelope?.detail as { issues?: Array<{ code?: string; cell?: string }> } | undefined)?.issues ?? [];
          check(
            "G1 xlsx：check 真解析了单元格内容（TODO 定位到 A3）",
            issues.some((i) => i.code === "placeholder_left" && i.cell === "A3"),
            issues,
          );
          eq("G1 xlsx：打开→不改→关闭后文件 sha256 不变（sheet check 纯 Node 读）", xAfter, xBefore);
          if (xAfter !== xBefore) console.log(`       前后哈希:${xBefore.slice(0, 12)}… → ${xAfter.slice(0, 12)}…`);
        } else {
          skip("G1 xlsx", "样本生成失败，无法验证读不重写");
        }
      } else {
        skip("G1 docx/pptx", "样本生成失败，无法验证读不重写");
      }
    }

    /* ══════════ G2 编辑往返 ══════════ */
    section("G2 编辑往返（生成→编辑/读→再看得到）");
    {
      // docx：md→docx 生成 → apply 插入一段 → 再 read 必须看到。
      const docx2 = join(root, "g2.docx");
      const md2 = join(root, "g2.md");
      writeFileSync(md2, "# Title\n\nOriginal.\n");
      const conv = await convertFile(ports, md2, "docx", docx2);
      check("G2 docx：md→docx 生成成功", conv.ok, conv);
      const apply = await docsApply(ports, docx2, [{ op: "insert_content", index: 1, html: "<p>G2 inserted</p>" }]);
      check("G2 docx：docs apply 插入成功", apply.ok, apply);
      const reread = await docsRead(ports, docx2, { full: true });
      check("G2 docx：apply 后再 read 成功", reread.ok, reread);
      if (reread.ok) {
        const detail = reread.envelope.detail as { blocks?: number; items?: Array<{ text?: string }> };
        check(
          "G2 docx：再 read 看得到 apply 插入的内容",
          detail.items?.some((i) => (i.text ?? "").includes("G2 inserted")) === true,
          detail.items,
        );
      }

      // pptx：create 生成 → slides read 成功（读回页数）。
      const pptx2 = join(root, "g2.pptx");
      const created = cliCreate(["create", "--type", "pptx", "--ops", "-", "--out", pptx2], "[]");
      check("G2 pptx：create 生成成功", created.status === 0 && existsSync(pptx2), created);
      const sread = await slidesRead(ports, pptx2);
      check("G2 pptx：create 后 slides read 成功", sread.ok, sread);
      if (sread.ok) {
        const detail = sread.envelope.detail as { slides?: number };
        check("G2 pptx：读回至少 1 页", (detail.slides ?? 0) >= 1, detail);
      }

      // xlsx：CSV→xlsx（create，纯 JS）→ 读回。
      // 两条读路径分开断言：
      //  a) 纯 Node 的 `sheet check`：读回内容必须看得到表头/单元格文本 —— 这条
      //     本机就能跑，是 xlsx 往返的真实判据。
      //  b) 应用侧 `sheet read`（适配层 sheetRead）：走 Rust sidecar，本机无 sidecar
      //     时显式 SKIP，并打印具体命令与 CLI 错误码（不是一句"缺件"了事）。
      const xlsx = join(root, "g2.xlsx");
      const csv = join(root, "g2.csv");
      writeFileSync(csv, "name,qty\nwidget,3\nTODO,9\n");
      const xCreated = cliCreate(["create", "--type", "xlsx", "--from", csv, "--out", xlsx]);
      check("G2 xlsx：从 CSV create 成功", xCreated.status === 0 && existsSync(xlsx), xCreated);
      if (xCreated.status === 0 && existsSync(xlsx)) {
        const xc = cliJson(["sheet", "check", xlsx]);
        const xIssues = (xc.envelope?.detail as { issues?: Array<{ code?: string; cell?: string }> } | undefined)?.issues ?? [];
        check(
          "G2 xlsx：sheet check 读回成功（CSV 生成的单元格被真解析）",
          xc.status === 0 && xc.envelope?.status === "ok" && Array.isArray((xc.envelope.detail as { checks?: unknown[] }).checks),
          xc.envelope ?? xc.raw,
        );
        check(
          "G2 xlsx：读回内容看得到 CSV 里的文本（TODO → A3）",
          xIssues.some((i) => i.code === "placeholder_left" && i.cell === "A3"),
          xIssues,
        );
      }

      const xread = await sheetRead(ports, xlsx);
      if (xread.ok) {
        const detail = xread.envelope.detail as { rows?: unknown[][] };
        check("G2 xlsx：sheet read 成功且第一行含表头", JSON.stringify(detail.rows?.[0] ?? []).includes("name"), detail.rows?.[0]);
      } else if (xread.kind === "unavailable") {
        // 【显式跳过】本机没构建 Rust xlsx-sidecar（XLSX_SIDECAR_PATH 未设 / 仓库内无 target/release 产物）。
        // 这不是"通过"（读取路径根本没跑到），也不是"失败"（能力缺件是已知边界）——
        // 必须在输出里可见，防止把 SKIP 统计成绿。把具体命令、错误码与 hint 打全，
        // 便于区分「本机缺件」与「代码没做」：error=conversion_failed + hint 指到
        // XLSX_SIDECAR_PATH = 环境缺件（sidecar 源码在 apps/sheets/native/xlsx-engine，
        // 本机无 cargo 构建）。
        const env = xread.envelope;
        skip(
          "G2 xlsx：适配层 sheet read 读回",
          `sidecar_unavailable — 命令 \`sheet read ${xlsx} --json\`，code=${String(env?.code)} error=${String(env?.error)} message=${xread.reason}`,
        );
      } else {
        check("G2 xlsx：sheet read 成功", false, xread);
      }
    }

    /* ══════════ G3 格式路由拒绝面 ══════════
     * `readByKind` 的每种拒绝必须与 `documentKindOf` 一致，且理由文本非空。 */
    section("G3 格式路由拒绝面（行为 == documentKindOf，理由非空）");
    {
      // 动态导入（见文件头 import 注释）：这条链经 pathGuard 拉进 store/db。
      const { readByKind } = await import("../../src/main/ipc/document.js");
      // md → refused，且理由指向文件读取通道。
      const notesMd = join(root, "g3.md");
      writeFileSync(notesMd, "# notes\n");
      eq("G3 前置：documentKindOf(.md) 是 markdown", documentKindOf(notesMd), "markdown");
      const mdRead = await readByKind(ports, notesMd, {});
      const mdRefusal = refusalOf(mdRead);
      check("G3 md：readByKind → refused（不假装结构读）", mdRefusal?.kind === "refused", mdRead);
      check("G3 md：拒绝理由指向 file.readFile", (mdRefusal?.reason ?? "").includes("file.readFile"), mdRefusal?.reason);

      // html → unavailable，理由说明需要应用渲染器。
      const page = join(root, "g3.html");
      writeFileSync(page, "<h1>x</h1>\n");
      eq("G3 前置：documentKindOf(.html) 是 html", documentKindOf(page), "html");
      const htmlRead = await readByKind(ports, page, {});
      const htmlRefusal = refusalOf(htmlRead);
      check("G3 html：readByKind → unavailable（需要应用渲染器）", htmlRefusal?.kind === "unavailable", htmlRead);
      check("G3 html：拒绝理由提到渲染器/应用", (htmlRefusal?.reason ?? "").includes("渲染器"), htmlRefusal?.reason);

      // 未知扩展名 → refused（没有结构读路由，不猜格式）。
      // 注：`documentKindOf` 对**认不出的扩展名**返回 "text"（按文本读），只有**无扩展名**
      // 才返回 "unknown" —— 两者都该被 readByKind 拒绝，且拒绝理由要带上实际 kind。
      const weird = join(root, "g3.zzz");
      writeFileSync(weird, "????\n");
      eq("G3 前置：documentKindOf(.zzz) 是 text（认不出 → 按文本读）", documentKindOf(weird), "text");
      const weirdRead = await readByKind(ports, weird, {});
      const weirdRefusal = refusalOf(weirdRead);
      check("G3 未知扩展名：readByKind → refused（不猜格式）", weirdRefusal?.kind === "refused", weirdRead);
      check("G3 未知扩展名：拒绝理由非空且带实际 kind", (weirdRefusal?.reason ?? "").includes("documentKind=text"), weirdRefusal?.reason);

      const bare = join(root, "g3-noext");
      writeFileSync(bare, "bare\n");
      eq("G3 前置：documentKindOf(无扩展名) 是 unknown", documentKindOf(bare), "unknown");
      const bareRead = await readByKind(ports, bare, {});
      const bareRefusal = refusalOf(bareRead);
      check("G3 无扩展名：readByKind → refused", bareRefusal?.kind === "refused", bareRead);
      check("G3 无扩展名：拒绝理由非空且带实际 kind", (bareRefusal?.reason ?? "").includes("documentKind=unknown"), bareRefusal?.reason);

      // 拒绝理由必须每种都非空 —— 空串等于"没说为什么"。
      check(
        "G3 全部拒绝理由文本非空",
        [mdRefusal, htmlRefusal, weirdRefusal, bareRefusal].every((x) => x !== null && x.reason.length > 0),
        { mdRefusal, htmlRefusal, weirdRefusal, bareRefusal },
      );
    }

    /* ══════════ G4 围栏（写路径） ══════════
     * 输出指到工作区外 → refused，且目标**确实不存在**（验磁盘事实）。 */
    section("G4 围栏：写路径（apply 输出 / convert 输出）");
    {
      // convert 输出在工作区外。
      const src = join(root, "g4-src.md");
      writeFileSync(src, "# g4\n");
      const outsideOut = join(outside, "escape.docx");
      const conv = await convertFile(ports, src, "docx", outsideOut);
      const convRefusal = refusalOf(conv);
      check("G4 convert：工作区外输出 → refused", convRefusal?.kind === "refused", conv);
      check("G4 convert：围栏拒绝理由非空", (convRefusal?.reason ?? "").length > 0, convRefusal?.reason);
      check("G4 convert：围栏拒绝后工作区外目标确实不存在", !existsSync(outsideOut));

      // docx 的 apply 输出口径：适配层 `docsApply` 是原地写（无 out 参数），
      // 所以"写路径指到工作区外"在本层表现为**源文件本身在工作区外** → refused。
      // 同时验 CLI 原生 `--out` 路由经同一围栏：适配层没有暴露它，这里用
      // convert 的 out 围栏与 docsApply 的文件围栏共同覆盖"所有写入口"。
      const outsideDocx = join(outside, "outside.docx");
      writeFileSync(outsideDocx, "not a docx");
      const apply = await docsApply(ports, outsideDocx, [{ op: "insert_content", index: 0, html: "<p>x</p>" }]);
      const applyRefusal = refusalOf(apply);
      check("G4 apply：工作区外文件 → refused", applyRefusal?.kind === "refused", apply);
      check("G4 apply：围栏拒绝理由非空", (applyRefusal?.reason ?? "").length > 0, applyRefusal?.reason);

      // 且围栏先于起进程：坏 cliPath 也应是 refused（工作区外路径先被拒）。
      const badCli = { ...ports, cliPath: join(root, "no-such-cli.cjs") };
      const early = await convertFile(badCli, src, "docx", join(outside, "early.docx"));
      const earlyRefusal = refusalOf(early);
      check("G4 ★ 围栏先于起进程（坏 cliPath 仍先 refused）", earlyRefusal?.kind === "refused", early);
      check("G4 ★ 围栏先于起进程时目标也不存在", !existsSync(join(outside, "early.docx")));
    }

    /* ══════════ G5 dry-run 语义 ══════════ */
    section("G5 docs apply --dry-run 不改 sha256");
    {
      // 与 G1 同判据，但针对**写命令**：dry-run 声称"没写"，就必须逐字节没写。
      const g5 = join(root, "g5.docx");
      const g5md = join(root, "g5.md");
      writeFileSync(g5md, "# Dry\n\nBody.\n");
      const conv = await convertFile(ports, g5md, "docx", g5);
      check("G5 前置：样本文档生成成功", conv.ok && existsSync(g5), conv);
      if (conv.ok && existsSync(g5)) {
        // 先确认文件确实可读（干跑的前提是"已存在且可读"，不是对坏文件干跑）。
        const readable = await docsRead(ports, g5);
        check("G5 前置：样本文档可读", readable.ok, readable);
        const before = sha256(g5);
        const dry = await docsApply(ports, g5, [{ op: "insert_content", index: 1, html: "<p>dry</p>" }], { dryRun: true });
        check("G5 docs apply --dry-run 成功", dry.ok, dry);
        const after = sha256(g5);
        eq("G5 ★ dry-run 不改文件（sha256 不变）", after, before);
      } else {
        skip("G5 dry-run", "样本生成失败");
      }
    }

    /* ══════════ 反向正控：sha256 断言本身能区分 ══════════ */
    section("反向正控（防哈希断言自己失效）");
    {
      const probe = join(root, "g1.docx"); // 用 G1 的样本
      if (!existsSync(probe)) {
        skip("反向正控", "G1 样本不存在");
      } else {
        const before = sha256(probe);
        // 只改**一个字节**：读入 → 翻转最后一个字节 → 写回。
        const bytes = readFileSync(probe);
        const mutated = Buffer.from(bytes);
        mutated[mutated.length - 1] = mutated[mutated.length - 1] ^ 0xff;
        writeFileSync(probe, mutated);
        const changed = sha256(probe);
        check("★ 反向正控：单字节变更后 sha256 必然不同（断言真的能区分）", changed !== before, {
          before: before.slice(0, 12), changed: changed.slice(0, 12),
        });
        // 还原（把原字节写回），保持后续/重跑不自相矛盾。
        writeFileSync(probe, bytes);
        eq("反向正控：还原后 sha256 回到原值", sha256(probe), before);
      }
    }

    console.log(`\ngenoffice-format-gates-smoke:${total - failures}/${total} 通过`);
    if (skipped.length > 0) {
      console.log(`显式跳过 ${skipped.length} 项（不算通过、不算失败）：`);
      for (const s of skipped) console.log(`  - ${s}`);
    }
    if (failures > 0) process.exitCode = 1;
  } finally {
    try { rmSync(work, { recursive: true, force: true }); } catch { /* Windows 句柄 */ }
    try { rmSync(outside, { recursive: true, force: true }); } catch { /* 同上 */ }
  }
}
