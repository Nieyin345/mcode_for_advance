/**
 * 【T63】把 PPT **产出质量**固化成回归断言。
 *
 * ## 它补的是哪一块
 *
 * T43 的 57/57 验的是「能读、能造、能围栏、build_deck 可达」——**全部是功能性断言**。
 * T47 的 27/27 验的是「模型拿得到设计规范」。但**没有任何断言在验「产出的东西是不是按
 * 规范做的」**：`slides check` 从没被调用（T43 第 292 行只是断言门禁**名**叫 audit）、
 * `offPalette` / `outline.findings` / `audit` 的 findings 一次都没被断言过。
 *
 * T62（`0c02692e`）手工走完全流程，结论是：**规范不是文档，是检查器**——`offPalette`、
 * Overlap、Text overflow、`outline.findings` 都会当场报。本套件把那条结论**固化成机器断言**。
 *
 * ## 四组，每组都是「正控 + 反向控」配对
 *
 * | 组 | 正控（该为空） | 反向控（该报出来） |
 * |---|---|---|
 * | A 几何审计 | 干净 deck → `audit.counts.error === 0` | 文字溢出 → `code === "out_of_bounds"` |
 * | B 调色板 | 合规页 → `detail.style.offPalette === []` | 越界颜色 `#FF00AA` → 被点名 |
 * | C 大纲一致 | 页与条目一致 → `detail.outline.findings === []` | 页数超出 outline → `level:"error"` |
 * | D 可读回 | 产物 `slides read` 读得回、页数对得上 | 同上那份**溢出的** deck 也要读得回 |
 *
 * **反向控是判别力的证明**：没有它，「正控为空」可能只是检查没跑。
 *
 * ## 反向用例为什么是「文字溢出」而不是「出界元素」（实测，见 `probe.mjs`）
 *
 * - **完全出界**的元素在 `create` 阶段就被丢弃，**到不了 audit**；
 * - **部分出界**会被 clamp 回画布，audit **不报**；
 * - **文字溢出**（小盒子 + 大字号长文本）会被 builder 撑高越界，`audit` 才报
 *   `out_of_bounds`。
 *
 * 卡上最初写的是「故意写一个超出画布的元素」，`2a51f412` 已按实测改正。
 *
 * ## 全部夹具走 `create --spec`
 *
 * 不手改 pptx —— 手改会绕过 builder，测到的就不是「模型写出的 spec 经过真实构建路径」。
 *
 * ## 未覆盖（如实记录）
 *
 * - **留白过度**：T62 发现 `audit` 抓不到「卡片下半截空着」。本套件先不做 D'，
 *   等 E 的 T65（反模式检查器）出来后再定：那时它要么从「记录缺口」变成「验证新检查」，
 *   要么保持记录。
 * - **构图雷同**（内容页/数据页都是「标题 + 一排卡片」）：T62 的发现③，同样无机器判据。
 * - **反模式第 4/6 条**（细竖条、装饰方块）：`slides check` 不实现，只能靠模型自觉。
 *
 * Run: bash scripts/t63-deck-quality-smoke/run.sh
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

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
const section = (t: string): void => { console.log("\n" + t); };

const REPO_ROOT = process.cwd().replace(/[\\/]apps[\\/]desktop$/, "");
const CLI = join(REPO_ROOT, "genoffice", "packages", "cli", "dist", "genoffice.cjs");
if (!existsSync(CLI)) {
  console.log(`SKIP: GenOffice CLI bundle 不存在（${CLI}）;先在 genoffice/ 下构建 CLI。`);
  process.exit(0);
}

/* ─────────────────── 生产模块（用同一个包装，不另写 CLI 调用） ─────────────────── */

const cliMod = await import("../../src/main/document/genofficeCli.js");

const WORK = mkdtempSync(join(tmpdir(), "t63-work-"));
process.on("exit", () => { try { rmSync(WORK, { recursive: true, force: true }); } catch { /* 清理失败 */ } });

const workspace = join(WORK, "workspace");
mkdirSync(workspace, { recursive: true });
const ports = {
  cliPath: CLI,
  withinWorkspace: (p: string): boolean => {
    const norm = p.replace(/\\/g, "/").toLowerCase();
    return norm.startsWith(workspace.replace(/\\/g, "/").toLowerCase());
  },
  renderTempRoot: () => workspace,
} as never;

/** `GenofficeResult` 是判别联合：`ok:true` 分支没有 `reason`。取失败原因时用它。 */
function reasonOf(result: unknown): string | undefined {
  const r = result as { reason?: unknown };
  return typeof r.reason === "string" ? r.reason : undefined;
}

/** 信封 detail 统一取成可索引的 record。 */
function detailOf(result: unknown): Record<string, unknown> {
  const r = result as { envelope?: { detail?: unknown } };
  const d = r?.envelope?.detail;
  return d !== null && typeof d === "object" ? (d as Record<string, unknown>) : {};
}
/** 测试夹具落盘（都在隔离 workspace 里）。 */
function writePage(dir: string, name: string, page: unknown): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify(page), "utf8");
  return file;
}
/** 用生产包装造 deck（与 `document_tool_call` 的 build_deck 同一条 `create --spec` 路径）。
 *
 *  ⚠️ `create` **没有**生产包装（`genofficeCli.ts` 只导出 read/check/audit/render 等），
 *  所以这里与 T43 套件用同一做法：直接 spawn CLI。判据的取证（check/audit/read）
 *  仍然走**生产包装**，不会被这里绕开。 */
async function buildDeck(pagesDir: string, out: string, outline?: string) {
  const args = ["create", "--type", "pptx", "--spec", pagesDir, "--out", out, "--json"];
  if (outline !== undefined) args.push("--outline", outline);
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: WORK, encoding: "utf8", timeout: 120_000,
    env: { ELECTRON_RUN_AS_NODE: "1", PATH: process.env.PATH ?? "" },
  });
  const raw = (r.stdout ?? "") + (r.stderr ?? "");
  // 与生产 `genofficeCli.invoke` 同一判据：只取 `{` 开头的行；多于一条按失败处理。
  const jsonLines = raw.trim().split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{"));
  let envelope: Record<string, unknown> | null = null;
  if (jsonLines.length === 1) {
    try { envelope = JSON.parse(jsonLines[0]!) as Record<string, unknown>; } catch { envelope = null; }
  }
  const ok = r.status === 0 && envelope?.status === "ok";
  const reason = typeof envelope?.message === "string" ? envelope.message : (ok ? undefined : raw.slice(0, 400));
  return { ok, envelope, reason, raw };
}

/* ═════════════════════════ A. 几何审计 ═════════════════════════ */

section("A. 几何审计：干净为空 / 文字溢出必须报 out_of_bounds");
{
  // 正控：干净 deck
  const cleanDir = join(workspace, "clean");
  writePage(cleanDir, "01.json", {
    title: "T63 clean", type: "cover", layout: "cover_typography_hero", background: "#0E1A2B",
    elements: [{
      type: "text", x: 80, y: 240, w: 1120, h: 160,
      paragraphs: [{ runs: [{ text: "T63 CLEAN", sizePt: 48, color: "#FFFFFF" }] }],
    }],
  });
  const cleanOut = join(workspace, "clean.pptx");
  const built = await buildDeck(cleanDir, cleanOut);
  check("A0 夹具：干净 deck 造得出来", built.ok === true, reasonOf(built) ?? built.envelope);

  const cleanAudit = await cliMod.slidesAudit(ports, cleanOut);
  const cleanCounts = detailOf(cleanAudit).counts as { error?: number; warning?: number } | undefined;
  check("★ A1 正控：干净 deck 的 audit error 为 0",
    cleanAudit.ok === true && cleanCounts?.error === 0, { counts: cleanCounts, reason: reasonOf(cleanAudit) });

  // 反向控：文字溢出（唯一能让 audit 报的形态 —— 见文件头）
  const overflowDir = join(workspace, "overflow");
  writePage(overflowDir, "01.json", {
    title: "T63 overflow", type: "content", layout: "three_column_cards", background: "#FFFFFF",
    elements: [{
      type: "text", x: 80, y: 60, w: 200, h: 40,
      paragraphs: [{
        runs: [{
          text: "THIS IS A VERY LONG LINE OF TEXT THAT CANNOT POSSIBLY FIT INTO A 200x40 BOX AT ALL IT WILL OVERFLOW FOR SURE AND KEEP GOING AND GOING",
          sizePt: 40, color: "#111111",
        }],
      }],
    }],
  });
  const overflowOut = join(workspace, "overflow.pptx");
  const overflowBuilt = await buildDeck(overflowDir, overflowOut);
  check("A2 夹具：文字溢出的 deck 仍造得出来（不会被丢弃）", overflowBuilt.ok === true, reasonOf(overflowBuilt) ?? overflowBuilt.envelope);

  const overflowAudit = await cliMod.slidesAudit(ports, overflowOut);
  const overDetail = detailOf(overflowAudit);
  const overCounts = overDetail.counts as { error?: number } | undefined;
  const overIssues = Array.isArray(overDetail.issues) ? overDetail.issues as Array<{ code?: unknown; level?: unknown }> : [];
  check("★ A3 反向控：文字溢出必须被 audit 报成 out_of_bounds（判别力证明）",
    overflowAudit.ok === true &&
      (overCounts?.error ?? 0) > 0 &&
      overIssues.some((i) => i.code === "out_of_bounds" && i.level === "error"),
    { counts: overCounts, codes: overIssues.map((i) => i.code) });

  // 对照记录：完全出界的元素在 create 阶段就被丢弃 —— 所以它当不了反向用例
  const oobDir = join(workspace, "oob");
  writePage(oobDir, "01.json", {
    title: "T63 oob", type: "content", layout: "three_column_cards", background: "#FFFFFF",
    elements: [{ type: "shape", shape: "rect", x: 1400, y: 100, w: 400, h: 200, fill: "#1F3A5F" }],
  });
  const oobBuilt = await buildDeck(oobDir, join(workspace, "oob.pptx"));
  check("A4 记录：完全出界的元素在 create 阶段即被丢弃（不是 audit 报的）",
    oobBuilt.ok === false && /outside the 1280x720 canvas|no valid pages/.test(String(oobBuilt.reason ?? "")),
    { ok: oobBuilt.ok, reason: String(oobBuilt.reason ?? "").slice(0, 200) });

  // 对照记录：部分出界会被 clamp，audit 不报 —— 所以「出界元素」不能当反向用例
  const clampDir = join(workspace, "clamped");
  writePage(clampDir, "01.json", {
    title: "T63 clamped", type: "content", layout: "three_column_cards", background: "#FFFFFF",
    elements: [
      { type: "shape", shape: "rect", x: 1200, y: 100, w: 400, h: 200, fill: "#1F3A5F" },
      { type: "text", x: 80, y: 60, w: 800, h: 90,
        paragraphs: [{ runs: [{ text: "Partial", sizePt: 36, color: "#111111" }] }] },
    ],
  });
  const clampedOut = join(workspace, "clamped.pptx");
  const clampedBuilt = await buildDeck(clampDir, clampedOut);
  const clampedAudit = await cliMod.slidesAudit(ports, clampedOut);
  const clampedCounts = detailOf(clampedAudit).counts as { error?: number } | undefined;
  check("A5 记录：部分出界被 builder clamp，audit 报 0 error（所以它也不是反向用例）",
    clampedBuilt.ok === true && clampedCounts?.error === 0,
    { built: clampedBuilt.ok, counts: clampedCounts });
}

/* ═════════════════════════ B. 调色板 ═════════════════════════ */

section("B. 调色板：合规为空 / 越界颜色必须被点名");
{
  const palDir = join(workspace, "palette");
  mkdirSync(palDir, { recursive: true });
  writeFileSync(join(palDir, "style.md"),
    "# Style\n- Colors: text `#111111`, accent `#1F3A5F`, background `#FFFFFF`\n"
    + "- Fonts: title Helvetica, body Helvetica\n- Overall style: minimal\n", "utf8");
  writeFileSync(join(palDir, "outline.json"), JSON.stringify({
    topic: "T63", core_hook: "A 40% drop", pages: [
      { title: "T63 palette", type: "cover", layout: "cover_typography_hero", brief: "B", image_queries: [] },
    ],
  }), "utf8");

  const onPalettePage = {
    title: "T63 palette", type: "cover", layout: "cover_typography_hero", background: "#FFFFFF",
    elements: [{ type: "text", x: 80, y: 240, w: 1120, h: 160,
      paragraphs: [{ runs: [{ text: "T63 palette", sizePt: 48, color: "#111111" }] }] }],
  };
  const pageFile = writePage(join(palDir, "pages"), "01.json", onPalettePage);

  const onPalette = await cliMod.slidesCheck(ports, pageFile);
  const onStyle = detailOf(onPalette).style as { offPalette?: unknown } | null | undefined;
  check("★ B1 正控：合规调色板的 offPalette 为空",
    onPalette.ok === true && Array.isArray(onStyle?.offPalette) && (onStyle!.offPalette as unknown[]).length === 0,
    { style: onStyle, reason: reasonOf(onPalette) });

  // 反向控：只改一个颜色字段（同一份 spec）
  const offPage = JSON.parse(JSON.stringify(onPalettePage));
  offPage.elements[0].paragraphs[0].runs[0].color = "#FF00AA";
  writePage(join(palDir, "pages"), "01.json", offPage);

  const offResult = await cliMod.slidesCheck(ports, pageFile);
  const offStyle = detailOf(offResult).style as { offPalette?: unknown } | null | undefined;
  const offColors = Array.isArray(offStyle?.offPalette) ? offStyle!.offPalette as string[] : [];
  check("★ B2 反向控：越界颜色 #FF00AA 必须出现在 offPalette（判别力证明）",
    offColors.includes("#FF00AA"), { offPalette: offColors });

  // 还原，避免影响 C 组
  writePage(join(palDir, "pages"), "01.json", onPalettePage);
}

/* ═════════════════════════ C. 大纲一致性 ═════════════════════════ */

section("C. 大纲一致性：一致为空 / 页数超出必须报 error");
{
  const ccDir = join(workspace, "outline");
  mkdirSync(ccDir, { recursive: true });
  writeFileSync(join(ccDir, "style.md"),
    "# Style\n- Colors: text `#111111`, background `#FFFFFF`\n- Fonts: title Helvetica\n", "utf8");
  writeFileSync(join(ccDir, "outline.json"), JSON.stringify({
    topic: "T63", core_hook: "A 40% drop", pages: [
      { title: "T63 outline", type: "cover", layout: "cover_typography_hero", brief: "B", image_queries: [] },
    ],
  }), "utf8");

  const page = {
    title: "T63 outline", type: "cover", layout: "cover_typography_hero", background: "#FFFFFF",
    elements: [{ type: "text", x: 80, y: 240, w: 1120, h: 160,
      paragraphs: [{ runs: [{ text: "T63 outline", sizePt: 48, color: "#111111" }] }] }],
  };
  const p1 = writePage(join(ccDir, "pages"), "01.json", page);
  const ok = await cliMod.slidesCheck(ports, p1);
  const okOutline = detailOf(ok).outline as { findings?: unknown } | null | undefined;
  check("★ C1 正控：页与 outline 条目一致时 findings 为空",
    ok.ok === true && Array.isArray(okOutline?.findings) && (okOutline!.findings as unknown[]).length === 0,
    { outline: okOutline, reason: reasonOf(ok) });

  // 反向控：多写一页（outline 只有 1 条）
  const p2 = writePage(join(ccDir, "pages"), "02.json", { ...page, title: "T63 outline 2" });
  const extra = await cliMod.slidesCheck(ports, p2);
  const extraOutline = detailOf(extra).outline as { findings?: unknown } | null | undefined;
  const findings = Array.isArray(extraOutline?.findings) ? extraOutline!.findings as Array<{ level?: unknown }> : [];
  check("★ C2 反向控：页数超出 outline 必须报 error（判别力证明）",
    findings.some((f) => f.level === "error"), { findings, ok: extra.ok });

  // 反向控 2：标题与 outline 条目不一致。
  // ⚠️ 必须给第 2 页**也写一条 outline 条目**，否则会先撞上「no outline entry」，
  // 测到的就不是标题一致性本身（第一次跑就踩了这个：夹具缺条目 → 断言红在别的原因上）。
  writeFileSync(join(ccDir, "outline.json"), JSON.stringify({
    topic: "T63", core_hook: "A 40% drop", pages: [
      { title: "T63 outline", type: "cover", layout: "cover_typography_hero", brief: "B", image_queries: [] },
      { title: "T63 outline 2", type: "content", layout: "three_column_cards", brief: "B", image_queries: [] },
    ],
  }), "utf8");
  writePage(join(ccDir, "pages"), "02.json", { ...page, title: "DIFFERENT TITLE", type: "content", layout: "three_column_cards" });
  const titleMismatch = await cliMod.slidesCheck(ports, p2);
  const tmFindings = (detailOf(titleMismatch).outline as { findings?: Array<{ level?: string; message?: string }> } | null)
    ?.findings ?? [];
  check("★ C3 反向控：页面标题与 outline 不一致必须报出来（判别力证明）",
    tmFindings.some((f) => f.level === "error" && /title/i.test(String(f.message ?? ""))),
    { findings: tmFindings.map((f) => ({ level: f.level, message: String(f.message).slice(0, 90) })) });
}

/* ═════════════════════════ D. 产物可读回 ═════════════════════════ */

section("D. 产物可读回：页数与 outline 一致，且读得回文本");
{
  const dDir = join(workspace, "readback");
  mkdirSync(dDir, { recursive: true });
  writeFileSync(join(dDir, "outline.json"), JSON.stringify({
    topic: "T63", core_hook: "A 40% drop", pages: [
      { title: "P1", type: "cover", layout: "cover_typography_hero", brief: "B", image_queries: [] },
      { title: "P2", type: "content", layout: "three_column_cards", brief: "B", image_queries: [] },
    ],
  }), "utf8");
  writePage(join(dDir, "pages"), "01.json", {
    title: "P1", type: "cover", layout: "cover_typography_hero", background: "#0E1A2B",
    elements: [{ type: "text", x: 80, y: 240, w: 1120, h: 160,
      paragraphs: [{ runs: [{ text: "T63 READBACK ONE", sizePt: 48, color: "#FFFFFF" }] }] }],
  });
  writePage(join(dDir, "pages"), "02.json", {
    title: "P2", type: "content", layout: "three_column_cards", background: "#FFFFFF",
    elements: [{ type: "text", x: 80, y: 60, w: 800, h: 120,
      paragraphs: [{ runs: [{ text: "T63 READBACK TWO", sizePt: 36, color: "#111111" }] }] }],
  });
  const out = join(workspace, "readback.pptx");
  const built = await buildDeck(join(dDir, "pages"), out, join(dDir, "outline.json"));
  check("★ D1 正控：两页 deck 造得出来且 build 不报 page/outline 不符",
    built.ok === true, reasonOf(built) ?? built.envelope);

  const read = await cliMod.slidesRead(ports, out);
  const readDetail = detailOf(read);
  // ⚠️ `detail.slides` 是**页数（数字）**，页面数组在 `detail.pages`。
  // 第一次把 `slides` 当数组读，拿到 0 条而假红 —— 真实形状见 `slides read --json`。
  const slideCount = typeof readDetail.slides === "number" ? readDetail.slides : null;
  const pages = Array.isArray(readDetail.pages) ? readDetail.pages as unknown[] : [];
  const readText = JSON.stringify(readDetail);
  check("★ D2 正控：产物读得回，页数与 outline 一致",
    read.ok === true && slideCount === 2 && pages.length === 2,
    { slideCount, pages: pages.length, reason: reasonOf(read) });
  check("★ D3 正控：两页的文本都读得回",
    readText.includes("T63 READBACK ONE") && readText.includes("T63 READBACK TWO"),
    { sample: readText.slice(0, 200) });

  // 反向对照：**溢出的** deck 也必须读得回 —— 证明「读回」与「质量」是两条独立判据
  const overflowRead = await cliMod.slidesRead(ports, join(workspace, "overflow.pptx"));
  const overflowText = JSON.stringify(detailOf(overflowRead));
  check("★ D4 对照：「有几何缺陷」不影响「读得回」（两条判据独立）",
    overflowRead.ok === true && overflowText.includes("THIS IS A VERY LONG LINE"),
    { ok: overflowRead.ok, reason: reasonOf(overflowRead) });
}

console.log(`\nt63-deck-quality-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exitCode = 1;
