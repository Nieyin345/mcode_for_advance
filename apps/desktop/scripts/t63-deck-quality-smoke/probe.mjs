/**
 * T63 —— **判据探针**（不是断言套件，是给断言用的取证工具）。
 *
 * ## 它解决什么问题
 *
 * T63 要把「PPT 产出质量」固化成断言。写断言之前必须先确认**判据真的能分辨好坏** ——
 * 否则写出来的可能是一条永远为空、永远绿的断言（T24 的 59/59 就是这么漏掉 T40 的）。
 *
 * 本文件用**真实 GenOffice CLI**（`create --spec` → `slides audit` / `slides check`）
 * 造出四种形态的 deck，把每种形态的**真实返回形状**打印出来，供断言引用：
 *
 * | 形态 | 期望 |
 * |---|---|
 * | 干净 deck | `audit.counts.error === 0`、`check.offPalette === []` |
 * | 文字溢出 | `audit.counts.error > 0`，`code === "out_of_bounds"` |
 * | 越界调色板 | `check.offPalette` 含那个越界颜色 |
 * | 页数与 outline 不符 | `check.outline.findings` 里有 `level: "error"` |
 *
 * ## 为什么反向用例是「文字溢出」而不是「出界元素」（实测结论，2026-10-23）
 *
 * 三种看起来都像「出界」的写法，实测行为完全不同：
 *
 *   1. **完全出界**（`x: 1400` 的 400 宽矩形）→ **`create` 阶段就丢弃**，
 *      报 `outside the 1280x720 canvas, dropped`，**根本到不了 audit**；
 *   2. **部分出界**（`x: 1200, w: 400`）→ builder **clamp 回画布**，audit **不报**；
 *   3. **文字溢出**（小盒子 + 大字号长文本）→ builder 把盒子撑高越下边界，
 *      audit **报 `out_of_bounds`**（实测 748px / 556px，取决于文本长度）。
 *
 * 所以「故意写一个超出画布的元素」**不成立** —— 卡上原本那条反向用例已被
 * `2a51f412` 改成文字溢出，本文件的夹具就是那次实测的固化。
 *
 * ## 为什么用 `create --spec` 而不是手改 pptx
 *
 * 手改 pptx 会绕过 builder，测到的就不是「模型写出来的 spec 经过真实构建路径」。
 * 所有夹具都走 `create --spec <dir> --out`，与产品里 `document_tool_call` 的
 * `build_deck` 同一条路径。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/t63-deck-quality-smoke/probe.mjs            # 人读
 * node scripts/t63-deck-quality-smoke/probe.mjs --json     # 机读（断言可解析）
 * ```
 *
 * 退出码：0 = 四种形态都符合上表；1 = 有形态不符（说明判据本身变了，断言要重写）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = resolve(HERE, "../..");
const REPO = resolve(DESKTOP, "../..");
const CLI = join(REPO, "genoffice/packages/cli/dist/genoffice.cjs");

const AS_JSON = process.argv.includes("--json");

/** 跑 CLI，返回 `{ code, json, raw }`。JSON 解析失败时 `json` 为 null。 */
function runCli(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
  });
  const raw = (r.stdout ?? "") + (r.stderr ?? "");
  let json = null;
  try { json = JSON.parse((r.stdout ?? "").trim()); } catch { /* 非 JSON 输出 */ }
  return { code: r.status ?? -1, json, raw };
}

const results = [];
function record(name, ok, observed, note) {
  results.push({ name, ok, observed, note });
  if (!AS_JSON) {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
    if (!ok) console.log(`       observed=${JSON.stringify(observed).slice(0, 700)}`);
  }
}

const root = mkdtempSync(join(tmpdir(), "mcode-t63-probe-"));
try {
  if (!AS_JSON) console.log(`T63 probe workspace: ${root}\n`);

  // ── 夹具 A：干净 deck（正控） ──
  const cleanDir = join(root, "clean");
  mkdirSync(join(cleanDir, "pages"), { recursive: true });
  writeFileSync(join(cleanDir, "pages", "01.json"), JSON.stringify({
    title: "T63 clean", type: "cover", layout: "cover_typography_hero", background: "#0E1A2B",
    elements: [{
      type: "text", x: 80, y: 240, w: 1120, h: 160,
      paragraphs: [{ runs: [{ text: "T63 CLEAN", sizePt: 48, color: "#FFFFFF" }] }],
    }],
  }));
  const cleanOut = join(root, "clean.pptx");
  const built = runCli(["create", "--type", "pptx", "--spec", join(cleanDir, "pages"), "--out", cleanOut, "--json"]);
  record("夹具：干净 deck 能被 create 造出来", built.code === 0 && built.json?.status === "ok", built.json ?? built.raw.slice(0, 400));

  const cleanAudit = runCli(["slides", "audit", cleanOut, "--json"]);
  record(
    "正控：干净 deck 的 audit errors=0",
    cleanAudit.json?.detail?.counts?.error === 0,
    cleanAudit.json?.detail?.counts ?? cleanAudit.raw.slice(0, 400),
  );

  // ── 夹具 B：文字溢出（反向控 —— 唯一能让 audit 报的形态） ──
  const overflowDir = join(root, "overflow");
  mkdirSync(join(overflowDir, "pages"), { recursive: true });
  writeFileSync(join(overflowDir, "pages", "01.json"), JSON.stringify({
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
  }));
  const overflowOut = join(root, "overflow.pptx");
  const overflowBuilt = runCli(["create", "--type", "pptx", "--spec", join(overflowDir, "pages"), "--out", overflowOut, "--json"]);
  record("夹具：文字溢出 deck 仍能被 create 造出来（不被丢弃）",
    overflowBuilt.code === 0, overflowBuilt.json?.status ?? overflowBuilt.raw.slice(0, 400));

  const overflowAudit = runCli(["slides", "audit", overflowOut, "--json"]);
  const overIssues = overflowAudit.json?.detail?.issues ?? [];
  record(
    "★ 反向控：文字溢出必须被 audit 报成 out_of_bounds",
    (overflowAudit.json?.detail?.counts?.error ?? 0) > 0 &&
      overIssues.some((i) => i.code === "out_of_bounds" && i.level === "error"),
    { counts: overflowAudit.json?.detail?.counts, issues: overIssues.map((i) => ({ code: i.code, level: i.level, message: String(i.message).slice(0, 80) })) },
  );

  // ── 对照：完全出界会被 create 丢弃（证明「出界元素」不能当反向用例） ──
  const oobDir = join(root, "oob");
  mkdirSync(join(oobDir, "pages"), { recursive: true });
  writeFileSync(join(oobDir, "pages", "01.json"), JSON.stringify({
    title: "T63 oob", type: "content", layout: "three_column_cards", background: "#FFFFFF",
    elements: [{ type: "shape", shape: "rect", x: 1400, y: 100, w: 400, h: 200, fill: "#1F3A5F" }],
  }));
  const oobBuilt = runCli(["create", "--type", "pptx", "--spec", join(oobDir, "pages"), "--out", join(root, "oob.pptx"), "--json"]);
  record(
    "记录：完全出界的元素在 create 阶段就被丢弃（所以它当不了反向用例）",
    oobBuilt.code !== 0 && /outside the 1280x720 canvas|no valid pages/.test(oobBuilt.raw),
    { code: oobBuilt.code, message: String(oobBuilt.json?.message ?? oobBuilt.raw).slice(0, 200) },
  );

  // ── 夹具 C：调色板（正控 + 反向控） ──
  const palDir = join(root, "palette");
  mkdirSync(join(palDir, "pages"), { recursive: true });
  writeFileSync(join(palDir, "style.md"),
    "# Style\n- Colors: text `#111111`, accent `#1F3A5F`, background `#FFFFFF`\n"
    + "- Fonts: title Helvetica, body Helvetica\n- Overall style: minimal\n");
  writeFileSync(join(palDir, "outline.json"), JSON.stringify({
    topic: "T63", core_hook: "A 40% drop", pages: [
      { title: "T63 palette", type: "cover", layout: "cover_typography_hero", brief: "B", image_queries: [] },
    ],
  }));
  const pageOnPalette = {
    title: "T63 palette", type: "cover", layout: "cover_typography_hero", background: "#FFFFFF",
    elements: [{ type: "text", x: 80, y: 240, w: 1120, h: 160,
      paragraphs: [{ runs: [{ text: "T63 palette", sizePt: 48, color: "#111111" }] }] }],
  };
  writeFileSync(join(palDir, "pages", "01.json"), JSON.stringify(pageOnPalette));

  const onPalette = runCli(["slides", "check", join(palDir, "pages", "01.json"), "--json"]);
  record(
    "正控：合规调色板的 offPalette 为空",
    Array.isArray(onPalette.json?.detail?.style?.offPalette) && onPalette.json.detail.style.offPalette.length === 0,
    onPalette.json?.detail?.style ?? onPalette.raw.slice(0, 400),
  );

  // 反向控：把文字色换成 style.md 没定义的颜色（同一份 spec，只改一个字段）
  const offPage = JSON.parse(JSON.stringify(pageOnPalette));
  offPage.elements[0].paragraphs[0].runs[0].color = "#FF00AA";
  writeFileSync(join(palDir, "pages", "01.json"), JSON.stringify(offPage));
  const offPalette = runCli(["slides", "check", join(palDir, "pages", "01.json"), "--json"]);
  const offColors = offPalette.json?.detail?.style?.offPalette ?? [];
  record(
    "★ 反向控：越界颜色必须出现在 offPalette 里",
    offColors.includes("#FF00AA"),
    { offPalette: offColors, status: offPalette.json?.status },
  );

  // ── 夹具 D：outline 一致性（正控 + 反向控） ──
  writeFileSync(join(palDir, "pages", "01.json"), JSON.stringify(pageOnPalette));
  const inOutline = runCli(["slides", "check", join(palDir, "pages", "01.json"), "--json"]);
  record(
    "正控：页与 outline 条目一致时 findings 为空",
    Array.isArray(inOutline.json?.detail?.outline?.findings) && inOutline.json.detail.outline.findings.length === 0,
    inOutline.json?.detail?.outline ?? inOutline.raw.slice(0, 400),
  );

  // 反向控：多写一页（outline 只有 1 条）→ 第 2 页没有对应条目
  writeFileSync(join(palDir, "pages", "02.json"), JSON.stringify({ ...pageOnPalette, title: "T63 palette 2" }));
  const extraPage = runCli(["slides", "check", join(palDir, "pages", "02.json"), "--json"]);
  const findings = extraPage.json?.detail?.outline?.findings ?? [];
  record(
    "★ 反向控：页数超出 outline 时必须报 error",
    findings.some((f) => f.level === "error"),
    { findings: findings.map((f) => ({ level: f.level, message: String(f.message).slice(0, 90) })), status: extraPage.json?.status },
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
if (AS_JSON) {
  console.log(JSON.stringify({ results, failed: failed.length }, null, 2));
} else {
  console.log(`\nt63 probe: ${results.length - failed.length}/${results.length} 形态符合预期`);
}
if (failed.length > 0) {
  if (!AS_JSON) console.error(`不符预期的形态：${failed.map((f) => f.name).join(" / ")}`);
  process.exitCode = 1;
}
