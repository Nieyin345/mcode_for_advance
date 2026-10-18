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
 *  - G2 编辑往返：docx 生成→apply→再 read 能看到新内容；pptx create→**真编辑**
 *    （`slides apply` addElement）→再 `slides read` 看到新文本；xlsx 从 CSV create→
 *    **真编辑**（`sheet apply` set_cell 写入 TODO）→`sheet check` 纯 Node 读回并
 *    定位到具体单元格 —— 三句都必须经过 `editByKind`（生产 `document.edit` 的
 *    路由函数），不是绕过路由直接调适配层。应用侧 `sheet read` 走 Rust sidecar，
 *    本机无 sidecar 时显式记 `sidecar_unavailable` 并跳过该断言 —— 不算通过也不算
 *    失败，但必须在输出里可见，且要带上具体命令与 CLI 错误码。
 *    **为什么用 editByKind 而不是直调适配层**：`document.edit` 曾经无条件走
 *    `docs apply`（docx 专用），pptx/xlsx 的编辑会报
 *    `conversion_failed: document.xml has no <w:body> element` —— docx 解析器在说
 *    "这不是 docx"，却被当成"文档坏了"透传。路由函数按 `documentKindOf` 分派到
 *    `slides apply` / `sheet apply` 才是真能力；断言打在路由上，退回旧行为才会红。
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
 *  - G4 围栏：所有写路径（docs/slides/sheet apply、convert 输出）指到工作区外 →
 *    refused，且目标文件**确实不存在** / 源文件字节未动。**为什么**：refused 只是
 *    返回值，若进程已经先写了半个文件再拒绝，围栏就是纸的 —— 必须验磁盘事实，
 *    不能只验返回值。
 *  - G5 dry-run 语义：`docs apply --dry-run` 在已存在且可读的 docx 上不改 sha256。
 *    与 G1 同判据，但针对写命令 —— dry-run 说"没写"就必须真没写。
 *  - G6 `expectedRevision` 冲突路径（pptx / xlsx）：版本比较住在 `document.edit`
 *    的**真 handler** 里（不是 `editByKind`），所以这一节用 fakeIpc 取出注册进去
 *    的真函数、配真 sql.js 库与登记过的项目根，调用户动作本身。判据三件：
 *    旧 revision → `conflict` 且回带盘上当前值、**整份字节未动**；用 currentRevision
 *    重试 → 成功且内容真落盘；不带 revision → 按契约兼容语义执行（旧调用方）。
 *  - 反向正控：故意改一个字节，确认 sha256 比较真的能区分（防"两次都读到空/失败、
 *    哈希相等"的假绿）。
 *
 * ⚠️ 需要本机已构建 `genoffice/packages/cli/dist/genoffice.cjs`。bundle 不存在时整套
 * 显式 SKIP 并打印原因（与 `genoffice-cli-smoke` 一致，不静默通过）。
 *
 * Run: scripts/genoffice-format-gates-smoke/run.sh
 */
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** 【G6】写盘前后的"版本"判据 —— **与生产同一算法**（`fileContentVersion`：原始
 *  字节的 sha256）。不在这里另写一份哈希实现：那正是"期望的版本值"与"handler
 *  实际比的值"分家的起点（本套件曾经的假绿形态之一）。 */
async function liveRevision(path: string): Promise<string | null> {
  const { fileContentVersion } = await import("@main/lib/fileVersion.js");
  return fileContentVersion(path);
}

/** 【G6】`document.edit` 的真 handler 形状（只取本套用得到的字段）。 */
type EditWireResult = {
  ok: boolean;
  kind?: string;
  reason?: string;
  revision?: string | null;
  currentRevision?: string | null;
  command?: string;
};

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
      // `editByKind` 是生产 `document.edit` 的路由函数（见文件头「为什么用 editByKind」）。
      // 动态导入理由同 G3 的 readByKind：这条链经 pathGuard 拉进 store/db。
      const { editByKind } = await import("../../src/main/ipc/document.js");

      // docx：md→docx 生成 → apply 插入一段 → 再 read 必须看到。
      const docx2 = join(root, "g2.docx");
      const md2 = join(root, "g2.md");
      writeFileSync(md2, "# Title\n\nOriginal.\n");
      const conv = await convertFile(ports, md2, "docx", docx2);
      check("G2 docx：md→docx 生成成功", conv.ok, conv);
      const apply = await editByKind(ports, docx2, [{ op: "insert_content", index: 1, html: "<p>G2 inserted</p>" }], {});
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

      // pptx：create 生成空白 deck → **真编辑**（addElement 一个带文本的文本框）→
      // slides read 必须看得到这段文本。判据是"编辑前读不到、编辑后读得到"，
      // 不是"read 成功" —— 空白 deck 的 read 本来就成功，只断 read 等于没验编辑。
      const pptx2 = join(root, "g2.pptx");
      const created = cliCreate(["create", "--type", "pptx", "--ops", "-", "--out", pptx2], "[]");
      check("G2 pptx：create 生成成功", created.status === 0 && existsSync(pptx2), created);
      if (created.status === 0 && existsSync(pptx2)) {
        const beforeEdit = await slidesRead(ports, pptx2);
        const beforeHas = beforeEdit.ok
          && (beforeEdit.envelope.detail as { pages?: Array<{ elements?: Array<{ text?: string }> }> }).pages
            ?.some((pg) => (pg.elements ?? []).some((el) => (el.text ?? "").includes("G2EDITED-pptx"))) === true;
        check("G2 pptx：编辑前读不到编辑文本（判据能区分改动）", beforeEdit.ok && beforeHas === false, beforeEdit);

        const added = await editByKind(ports, pptx2, [{
          op: "addElement",
          target: { slide: 0 },
          kind: "textbox",
          offset: { x: 914400, y: 914400, cx: 3000000, cy: 600000 },
          paragraphs: [{ runs: [{ text: "G2EDITED-pptx" }] }],
        }], {});
        check("G2 pptx：editByKind → slides apply 成功（不是 docs apply）", added.ok, added);
        if (added.ok) {
          check(
            "G2 pptx：apply 走的是 slides 命令（envelope.command 判据）",
            (added.envelope.command ?? "") === "slides",
            added.envelope,
          );
        }
        const sread = await slidesRead(ports, pptx2);
        check("G2 pptx：apply 后 slides read 成功", sread.ok, sread);
        if (sread.ok) {
          const detail = sread.envelope.detail as {
            slides?: number;
            pages?: Array<{ elements?: Array<{ text?: string }> }>;
          };
          check("G2 pptx：读回至少 1 页", (detail.slides ?? 0) >= 1, detail);
          check(
            "G2 pptx ★ 再 read 看得到 apply 插入的文本（真编辑往返）",
            detail.pages?.some((pg) => (pg.elements ?? []).some((el) => (el.text ?? "").includes("G2EDITED-pptx"))) === true,
            detail.pages,
          );
        }
      }

      // xlsx：CSV→xlsx（create，纯 JS）→ **真编辑**（set_cell 往 D9 写 TODO）→
      // sheet check 读回且 placeholder 定位到 D9 —— check 的 8 项检查会真解析
      // workbook.xml/sharedStrings，用"新写入的 TODO 出现在新坐标"同时证明:
      // (a) 编辑真的落盘；(b) 读路径真解析了编辑后的内容。
      // 两条读路径分开断言：
      //  a) 纯 Node 的 `sheet check`：这条本机就能跑，是 xlsx 往返的真实判据。
      //  b) 应用侧 `sheet read`（适配层 sheetRead）：走 Rust sidecar，本机无 sidecar
      //     时显式 SKIP，并打印具体命令与 CLI 错误码（不是一句"缺件"了事）。
      const xlsx = join(root, "g2.xlsx");
      const csv = join(root, "g2.csv");
      writeFileSync(csv, "name,qty\nwidget,3\nTODO,9\n");
      const xCreated = cliCreate(["create", "--type", "xlsx", "--from", csv, "--out", xlsx]);
      check("G2 xlsx：从 CSV create 成功", xCreated.status === 0 && existsSync(xlsx), xCreated);
      if (xCreated.status === 0 && existsSync(xlsx)) {
        type SheetIssue = { code?: string; cell?: string; context?: string };
        const xc = cliJson(["sheet", "check", xlsx]);
        const xIssues = (xc.envelope?.detail as { issues?: SheetIssue[] } | undefined)?.issues ?? [];
        const placeholderContext = (issues: SheetIssue[]): string =>
          issues.filter((i) => i.code === "placeholder_left").map((i) => i.context ?? "").join(" | ");
        check(
          "G2 xlsx：sheet check 读回成功（CSV 生成的单元格被真解析）",
          xc.status === 0 && xc.envelope?.status === "ok" && Array.isArray((xc.envelope.detail as { checks?: unknown[] }).checks),
          xc.envelope ?? xc.raw,
        );
        check(
          "G2 xlsx：编辑前占位符只在 A3（D9 还没有，判据能区分编辑前后）",
          placeholderContext(xIssues).includes("A3") && !placeholderContext(xIssues).includes("D9"),
          xIssues,
        );

        // 真编辑：在 D9 写一个 TODO —— 新坐标是"这次编辑造出来的"，不是 CSV 自带的。
        // 判据必须能区分"编辑前 A3 有 TODO / 编辑后 D9 也有 TODO"，否则 read 恒报
        // A3 的 TODO 会让假绿通过。同一条 issue 会把多个单元格聚合进 context
        // （cell 字段只留第一个），所以判据看 context 全文。
        const xEdit = await editByKind(ports, xlsx, [{ op: "set_cell", address: "D9", value: "TODO" }], {});
        check("G2 xlsx：editByKind → sheet apply 成功（不是 docs apply）", xEdit.ok, xEdit);
        if (xEdit.ok) {
          check(
            "G2 xlsx：apply 走的是 sheet 命令（envelope.command 判据）",
            (xEdit.envelope.command ?? "") === "sheet",
            xEdit.envelope,
          );
        }
        const xc2 = cliJson(["sheet", "check", xlsx]);
        const xIssues2 = (xc2.envelope?.detail as { issues?: SheetIssue[] } | undefined)?.issues ?? [];
        check(
          "G2 xlsx ★ 编辑后再 check 看得到新单元格（D9 落盘，真编辑往返）",
          xc2.status === 0 && placeholderContext(xIssues2).includes("D9"),
          xIssues2,
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

    /* ── G2 md：Markdown 往返（纯 Node，实测可无损）──────────────────────────
     * 台账 ARC-007 要求逐格式过门。Markdown 之前只在 G3 里验了"没有结构读路由",
     * 没验**往返**。实测 `convert md→docx` 与 `convert docx→md` 都是纯 Node,
     * 且标题/粗体/列表能原样回来 —— 这条路真实可用,值得钉住。 */
    section("G2md Markdown 往返（md → docx → md）");
    {
      const mdIn = join(root, "roundtrip.md");
      const docxMid = join(root, "roundtrip.docx");
      const mdBack = join(root, "roundtrip-back.md");
      writeFileSync(mdIn, ["# Title", "", "Hello **world**.", "", "- a", "- b", ""].join(String.fromCharCode(10)), "utf8");
      const fwd = await convertFile(ports, mdIn, "docx", docxMid);
      eq("md → docx 成功", fwd.ok, true);
      check("中间产物 docx 存在", existsSync(docxMid));
      if (fwd.ok) {
        const back = await convertFile(ports, docxMid, "md", mdBack);
        eq("docx → md 成功", back.ok, true);
        if (back.ok) {
          const text = readFileSync(mdBack, "utf8");
          check("★ 往返后标题仍在", text.includes("# Title"), text.slice(0, 80));
          check("★ 往返后粗体标记仍在", text.includes("**world**"), text.slice(0, 160));
          check("★ 往返后列表项仍在", text.includes("- a") && text.includes("- b"), text.slice(0, 200));
        }
      }
      // 反向:输入文件在工作区外 → 转换必须先拒(围栏也适用于 md 输入)。
      const outsideMd = join(outside, "nope.md");
      writeFileSync(outsideMd, "# x" + String.fromCharCode(10), "utf8");
      const refused = await convertFile(ports, outsideMd, "docx", join(root, "nope.docx"));
      check("★ md 输入在工作区外 → refused", refused.ok === false && refused.kind === "refused", refused);
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

      /* ── 编辑路由的负向面：editByKind 与 readByKind 同一张判据表 ──
       * 只验"读会被拒"不够：编辑是写路径，若它对 md/html 也放行，CLI 会拿到
       * 一份它不认识的格式再报 docx 内部错误 —— 拒绝必须发生在路由层。 */
      const { editByKind } = await import("../../src/main/ipc/document.js");
      const mdEdit = await editByKind(ports, notesMd, [{ op: "insert_content", index: 0, html: "<p>x</p>" }], {});
      const mdEditRefusal = refusalOf(mdEdit);
      check("G3 md：editByKind → refused（不假装结构化编辑）", mdEditRefusal?.kind === "refused", mdEdit);
      check("G3 md 编辑：拒绝理由指向编辑器/文件通道", /编辑器|file\.writeFile/.test(mdEditRefusal?.reason ?? ""), mdEditRefusal?.reason);
      const htmlEdit = await editByKind(ports, page, [{ op: "x" }], {});
      const htmlEditRefusal = refusalOf(htmlEdit);
      check("G3 html：editByKind → unavailable（需要应用渲染器）", htmlEditRefusal?.kind === "unavailable", htmlEdit);
      const weirdEdit = await editByKind(ports, weird, [{ op: "x" }], {});
      const weirdEditRefusal = refusalOf(weirdEdit);
      check("G3 未知扩展名：editByKind → refused", weirdEditRefusal?.kind === "refused", weirdEdit);
      check(
        "G3 编辑路由拒绝理由文本非空",
        [mdEditRefusal, htmlEditRefusal, weirdEditRefusal].every((x) => x !== null && x.reason.length > 0),
        { mdEditRefusal, htmlEditRefusal, weirdEditRefusal },
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

      /* ── 编辑路由的三个写口共用同一道围栏 ──
       * slides apply / sheet apply 是这轮新接的写路径；它们与 docs apply 一样
       * 是**原地写**，判据因此是"源文件在工作区外 → refused 且源字节一字节未动"。
       * 只验返回值不够：若进程先写了再拒，围栏就是纸的。
       *
       * ⚠️ 界外夹具必须是**合法**的 pptx/xlsx（先在工作区内造好再复制出去）。
       * 用垃圾字节当夹具时，撤掉围栏后 CLI 也会因解析失败而不写盘 —— 那样
       * "字节未动"恒真，断言区分不了"围栏挡住"与"文件本来就读不了"（变异实测
       * 抓过这条假绿：撤围栏后字节断言仍然绿）。 */
      const { editByKind } = await import("../../src/main/ipc/document.js");
      const outsidePptx = join(outside, "outside.pptx");
      const outsideXlsx = join(outside, "outside.xlsx");
      const fixturePptx = join(root, "g4-fixture.pptx");
      const fixtureXlsx = join(root, "g4-fixture.xlsx");
      const fixtureCsv = join(root, "g4-fixture.csv");
      writeFileSync(fixtureCsv, "name,qty\nwidget,3\n");
      const madePptx = cliCreate(["create", "--type", "pptx", "--ops", "-", "--out", fixturePptx], "[]");
      const madeXlsx = cliCreate(["create", "--type", "xlsx", "--from", fixtureCsv, "--out", fixtureXlsx]);
      const viableFixtures = madePptx.status === 0 && existsSync(fixturePptx) && madeXlsx.status === 0 && existsSync(fixtureXlsx);
      if (viableFixtures) {
        copyFileSync(fixturePptx, outsidePptx);
        copyFileSync(fixtureXlsx, outsideXlsx);
        const pptxBytes = readFileSync(outsidePptx);
        const xlsxBytes = readFileSync(outsideXlsx);
        const pptxEdit = await editByKind(ports, outsidePptx, [{
          op: "addElement", target: { slide: 0 }, kind: "textbox",
          offset: { x: 0, y: 0, cx: 914400, cy: 457200 },
          paragraphs: [{ runs: [{ text: "leak" }] }],
        }], {});
        check("G4 slides apply：工作区外文件 → refused", refusalOf(pptxEdit)?.kind === "refused", pptxEdit);
        const xlsxEdit = await editByKind(ports, outsideXlsx, [{ op: "set_cell", address: "A1", value: "leak" }], {});
        check("G4 sheet apply：工作区外文件 → refused", refusalOf(xlsxEdit)?.kind === "refused", xlsxEdit);
        eq("G4 slides apply：拒绝后工作区外文件字节未动", sha256(outsidePptx), createHash("sha256").update(pptxBytes).digest("hex"));
        eq("G4 sheet apply：拒绝后工作区外文件字节未动", sha256(outsideXlsx), createHash("sha256").update(xlsxBytes).digest("hex"));
        // 反向正控：同一份合法夹具在**工作区内**用同一 op 能真写成功，
        // 证明"字节未动"不是"这个 op 本来就写不了"。
        const inPptx = join(root, "g4-inside.pptx");
        copyFileSync(fixturePptx, inPptx);
        const inOk = await editByKind(ports, inPptx, [{
          op: "addElement", target: { slide: 0 }, kind: "textbox",
          offset: { x: 0, y: 0, cx: 914400, cy: 457200 },
          paragraphs: [{ runs: [{ text: "inside" }] }],
        }], {});
        check("G4 反向正控：同一 op 在工作区内真写入成功", inOk.ok && sha256(inPptx) !== createHash("sha256").update(pptxBytes).digest("hex"), inOk);
      } else {
        skip("G4 slides/sheet apply 围栏", "合法夹具生成失败");
      }
    }

    /* ══════════ G5 dry-run 语义 ══════════ */
    section("G5 dry-run 语义（docs / slides / sheet 三条写命令都不改 sha256）");
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

      // slides apply --dry-run：与上面同一判据，覆盖这轮新接的 pptx 写口。
      const { editByKind } = await import("../../src/main/ipc/document.js");
      const g5pptx = join(root, "g5.pptx");
      const g5pCreated = cliCreate(["create", "--type", "pptx", "--ops", "-", "--out", g5pptx], "[]");
      if (g5pCreated.status === 0 && existsSync(g5pptx)) {
        const pBefore = sha256(g5pptx);
        const pDry = await editByKind(ports, g5pptx, [{
          op: "addElement", target: { slide: 0 }, kind: "textbox",
          offset: { x: 0, y: 0, cx: 914400, cy: 457200 },
          paragraphs: [{ runs: [{ text: "dry" }] }],
        }], { dryRun: true });
        check("G5 slides apply --dry-run 成功", pDry.ok, pDry);
        eq("G5 ★ slides dry-run 不改文件（sha256 不变）", sha256(g5pptx), pBefore);
      } else {
        skip("G5 slides dry-run", "pptx 样本生成失败");
      }

      // sheet apply --dry-run：同上，覆盖 xlsx 写口。
      const g5xlsx = join(root, "g5.xlsx");
      const g5csv = join(root, "g5.csv");
      writeFileSync(g5csv, "name,qty\nwidget,3\n");
      const g5xCreated = cliCreate(["create", "--type", "xlsx", "--from", g5csv, "--out", g5xlsx]);
      if (g5xCreated.status === 0 && existsSync(g5xlsx)) {
        const xBefore = sha256(g5xlsx);
        const xDry = await editByKind(ports, g5xlsx, [{ op: "set_cell", address: "E5", value: "dry" }], { dryRun: true });
        check("G5 sheet apply --dry-run 成功", xDry.ok, xDry);
        eq("G5 ★ sheet dry-run 不改文件（sha256 不变）", sha256(g5xlsx), xBefore);
      } else {
        skip("G5 sheet dry-run", "xlsx 样本生成失败");
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

    /* ══════════ G6 expectedRevision 冲突路径（pptx / xlsx） ══════════
     * 版本比较住在 `document.edit` 的 **handler 函数体**里，`editByKind`（路由层）
     * 看不到 `expectedRevision` —— 只调路由层永远验不到冲突分支。所以这里按
     * `library-trash-smoke` 的办法取**注册进 fakeIpc 的真函数**，调用用户动作本身。
     *
     * 为什么要登记项目根：生产围栏走 `findContainingWorkspaceRoot`（真 pathGuard），
     * 不是本套 G1–G5 用的业务桩 `ports.withinWorkspace`。不登记的话 `document.edit`
     * 会在围栏处 refused，冲突分支根本到不了（断言"拒绝"会假绿）。 */
    section("G6 expectedRevision 冲突路径（document.edit 真 handler；pptx / xlsx）");
    {
      const { ProjectRepo } = await import("@main/store/repositories.js");
      const { initDb } = await import("@main/store/db.js");
      await initDb();
      ProjectRepo.create({
        id: "proj_g6_smoke",
        name: "G6 门",
        path: root,
        archived: false,
        group: null,
        sortOrder: 0,
        pinnedAt: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const { IPC } = await import("@contracts/ipc");
      const { registerDocumentHandlers, configureDocumentRepoRoot, editByKind } = await import("../../src/main/ipc/document.js");
      // `registerDocumentHandlers` 在注册时现解析仓库根：无头环境里 `require("electron")`
      // 拿不到 appPath，会回落到 `process.cwd()`（= apps/desktop），于是
      // `resolveGenofficeCliPath(apps/desktop)` 为 null、每条 edit 都回 unavailable ——
      // 冲突分支根本跑不到。生产装配不需要这个注入，测试按模块自带的注入口固定它。
      configureDocumentRepoRoot(repoRoot);
      const editHandlers = new Map<string, (event: unknown, raw: unknown) => unknown>();
      registerDocumentHandlers({
        handle(channel: string, fn: (event: unknown, raw: unknown) => unknown): void {
          editHandlers.set(channel, fn);
        },
      } as never);
      const editHandler = editHandlers.get(IPC.DOCUMENT_EDIT);
      check("G6 ★ 拿到了 document.edit 的真 handler（不是路由层复印件）", editHandler !== undefined);
      /** 调真 handler（与 preload 之后的主进程入口同一段代码）。 */
      const callEdit = (raw: unknown): Promise<EditWireResult> =>
        Promise.resolve(editHandler!(null, raw) as EditWireResult);

      const { findContainingWorkspaceRoot } = await import("@main/lib/pathGuard.js");
      check(
        "G6 前置：真 pathGuard 认得登记的项目根（围栏放行夹具目录）",
        findContainingWorkspaceRoot(root) !== null,
      );

      /** 外部内容的 sha256（不必落盘就能比）。 */
      const sha256Buf = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");

      /**
       * 一条格式的完整冲突往返。
       *  - `make()` 造样本（写完即返回）；`external` 是"外部编辑器写的另一份内容"
       *    （合法文件字节，直接写盘，模拟另一个窗口/程序）。
       *  - `once` / `again` 是两次**不同**的合法编辑：重试必须真落盘；不带 revision
       *    的第三次编辑用 `again`，否则同一 op 重复应用可能产生相同字节，"写了盘"
       *    的断言就会假红。
       *  - `verifyLanded(file, marker)` 做**内容层**读回（不只是字节变了）。
       *
       * 判据全落在**磁盘事实**上：冲突时整份字节必须还是外部那份；成功时字节必须
       * 变、且内容/新版本都读得回来。
       */
      const conflictRoundtrip = async (
        label: string,
        ext: "pptx" | "xlsx",
        make: () => void,
        once: unknown[],
        again: unknown[],
        external: Buffer,
        verifyLanded: (file: string, marker: string) => Promise<{ landed: boolean; detail: unknown }>,
      ): Promise<void> => {
        const file = join(root, `g6.${ext}`);
        make();
        const rev0 = await liveRevision(file);
        check(`${label} 前置：样本生成且版本可读`, existsSync(file) && rev0 !== null, { rev0 });

        // 外部改文件：直接写字节（不经过 Mcode 的写路径 —— 这才是"别处改动"）。
        writeFileSync(file, external);
        const revExternal = await liveRevision(file);
        check(`${label} 前置：外部改动后版本确实变了（判据能区分）`, revExternal !== null && revExternal !== rev0, { rev0, revExternal });

        // ① 带旧 revision → conflict；currentRevision 是盘上当前值；盘上仍是外部内容。
        const stale = await callEdit({ filePath: file, ops: once, expectedRevision: rev0 });
        check(`${label} ① 旧 revision 编辑 → conflict（不执行）`, stale.ok === false && stale.kind === "conflict", stale);
        check(`${label} ① 冲突回带的 currentRevision 是盘上当前值`, stale.currentRevision === revExternal, {
          actual: stale.currentRevision, expected: revExternal,
        });
        eq(`${label} ① 冲突后盘上仍是外部内容（整份字节未动）`, sha256(file), sha256Buf(external));

        // ② 用 currentRevision 重试 → 成功且内容落盘。
        const retried = await callEdit({ filePath: file, ops: once, expectedRevision: revExternal });
        check(`${label} ② 用 currentRevision 重试 → 成功`, retried.ok === true, retried);
        const revAfter = await liveRevision(file);
        check(`${label} ② 成功后回传的 revision 是盘上新值`, revAfter !== null && retried.revision === revAfter, {
          actual: retried.revision, expected: revAfter,
        });
        check(`${label} ② 成功后盘上版本不再等于外部版本（真写盘）`, revAfter !== revExternal, { revExternal, revAfter });
        const landed = await verifyLanded(file, "G6");
        check(`${label} ② 读回看得到这次编辑的内容（内容真落盘）`, landed.landed, landed.detail);

        // ③ 不带 revision → 与契约兼容语义一致：整份执行（旧调用方不带版本仍可用）。
        //    这是实现现有且写进契约注释的行为（`expectedRevision` 可选 = 兼容取舍），
        //    不是"漏检" —— 断言钉住它；将来若改成"必须带"，要先改契约与调用方，这里会红。
        const beforeNoRev = sha256(file);
        const noRev = await callEdit({ filePath: file, ops: again });
        check(`${label} ③ 不带 revision 的编辑按兼容语义执行（成功）`, noRev.ok === true, noRev);
        check(`${label} ③ 不带 revision 的编辑确实写了盘`, sha256(file) !== beforeNoRev);
        const landedNoRev = await verifyLanded(file, "G6-NOREV");
        check(`${label} ③ 不带 revision 的编辑内容也落盘`, landedNoRev.landed, landedNoRev.detail);
      };

      /* ── pptx ──
       * 夹具：G2 已证明可被 `slides apply` 写的那份 create 产物；"外部内容"是另一份
       * **合法** pptx（也加过一个元素，保证字节与样本不同），而不是垃圾字节 —— 垃圾
       * 字节会让 CLI 无论冲突分支走没走都失败，断言就区分不了"冲突挡住"与"文件坏了"。
       * 读回用 `slidesRead`：只要编辑真落盘，标记文本必须出现在 pages 里。 */
      {
        const pptxExternalPath = join(root, "g6-external.pptx");
        const madeExternal = cliCreate(["create", "--type", "pptx", "--ops", "-", "--out", pptxExternalPath], "[]");
        check("G6 pptx 前置：外部内容样本（另一份合法 deck）生成成功", madeExternal.status === 0 && existsSync(pptxExternalPath), madeExternal);
        if (madeExternal.status === 0 && existsSync(pptxExternalPath)) {
          const extEdit = await editByKind(ports, pptxExternalPath, [{
            op: "addElement", target: { slide: 0 }, kind: "textbox",
            offset: { x: 0, y: 0, cx: 914400, cy: 457200 },
            paragraphs: [{ runs: [{ text: "EXTERNAL-pptx" }] }],
          }], {});
          check("G6 pptx 前置：外部内容样本真被改写过（字节与空白 deck 不同）", extEdit.ok, extEdit);
          const externalBytes = readFileSync(pptxExternalPath);
          await conflictRoundtrip(
            "G6 pptx",
            "pptx",
            () => {
              const made = cliCreate(["create", "--type", "pptx", "--ops", "-", "--out", join(root, "g6.pptx")], "[]");
              check("G6 pptx 前置：样本 deck 生成成功", made.status === 0, made);
            },
            [{
              op: "addElement", target: { slide: 0 }, kind: "textbox",
              offset: { x: 914400, y: 914400, cx: 3000000, cy: 600000 },
              paragraphs: [{ runs: [{ text: "G6-pptx" }] }],
            }],
            [{
              op: "addElement", target: { slide: 0 }, kind: "textbox",
              offset: { x: 914400, y: 1828800, cx: 3000000, cy: 600000 },
              paragraphs: [{ runs: [{ text: "G6-NOREV-pptx" }] }],
            }],
            externalBytes,
            async (file, marker) => {
              const r = await slidesRead(ports, file);
              const pages = r.ok
                ? (r.envelope.detail as { pages?: Array<{ elements?: Array<{ text?: string }> }> }).pages
                : undefined;
              return {
                landed: pages?.some((pg) => (pg.elements ?? []).some((el) => (el.text ?? "").includes(marker))) === true,
                detail: r.ok ? pages : r,
              };
            },
          );
        } else {
          skip("G6 pptx revision 冲突", "外部内容样本生成失败");
        }
      }

      /* ── xlsx ──
       * 全部走纯 Node 路径：`sheet apply` 写、`sheet check` 读回（本机无 sidecar 时
       * `sheet read` 不可用，见 G2 的 SKIP 说明）。内容层标记用 **TODO 占位符**：
       * `sheet check` 的 `placeholder_left` issue 会把命中单元格地址聚合进 context，
       * 编辑把 TODO 写进一个新坐标（D9 / E11），读回时该坐标必须出现在 context 里 ——
       * 与 G2 的判据同款，且"编辑前没有 D9/E11、编辑后有"能区分真假落盘。 */
      {
        const xlsxExternalPath = join(root, "g6-external.xlsx");
        const externalJson = join(root, "g6-external.json");
        writeFileSync(externalJson, JSON.stringify([["name", "qty"], ["external", 1]]));
        const madeExternal = cliCreate(["create", "--type", "xlsx", "--from", externalJson, "--out", xlsxExternalPath]);
        check("G6 xlsx 前置：外部内容样本生成成功", madeExternal.status === 0 && existsSync(xlsxExternalPath), madeExternal);
        if (madeExternal.status === 0 && existsSync(xlsxExternalPath)) {
          const externalBytes = readFileSync(xlsxExternalPath);
          await conflictRoundtrip(
            "G6 xlsx",
            "xlsx",
            () => {
              const sampleJson = join(root, "g6.json");
              writeFileSync(sampleJson, JSON.stringify([["name", "qty"], ["widget", 3]]));
              const made = cliCreate(["create", "--type", "xlsx", "--from", sampleJson, "--out", join(root, "g6.xlsx")]);
              check("G6 xlsx 前置：样本工作簿生成成功", made.status === 0, made);
            },
            [{ op: "set_cell", address: "D9", value: "TODO" }],
            [{ op: "set_cell", address: "E11", value: "TODO" }],
            externalBytes,
            async (file, marker) => {
              const r = cliJson(["sheet", "check", file]);
              const issues = (r.envelope?.detail as { issues?: Array<{ code?: string; cell?: string; context?: string }> } | undefined)?.issues ?? [];
              const context = issues.filter((i) => i.code === "placeholder_left").map((i) => i.context ?? "").join(" | ");
              // 标记坐标按本轮 op 定：once → D9，again → E11。
              const located = marker === "G6-NOREV" ? context.includes("E11") : context.includes("D9");
              return {
                landed: r.status === 0 && r.envelope?.status === "ok" && located,
                detail: issues,
              };
            },
          );
        } else {
          skip("G6 xlsx revision 冲突", "外部内容样本生成失败");
        }
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
