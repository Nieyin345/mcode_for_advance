/**
 * O0 —— **判据变异验证**（卡 §4）：对每一条 PASS 断言，证明它真的会红。
 *
 * ## 为什么不用 `--mutation=unconditional-pass`
 *
 * 那个开关把 `assertionStatus` 换成恒 PASS —— 它证明「断言在判」，**不**证明
 * 「判据抓得到部件丢失」。卡 §4 要求的变异作用于**样本文件**：
 *
 *  - 把一个复杂部件**删掉** → 对应项必须红；
 *  - 把部件**换个位置**放回去（内容不变）→ 对应项也必须红（证明比的是语义，
 *    不是存在性）。
 *
 * ## 每个变异体怎么造
 *
 * 全部在**基线样本的副本**上做（`.tmp/o0-mutations/`），不碰套件 fixture、
 * 不碰产品代码。每个格式的变异见 `mutants/`（逐格式一个构造器，全部写 OOXML /
 * 文本 / PDF 字节，不经过任何编辑器）。
 *
 * ## 恢复后 `cmp` 逐字节核对
 *
 * 每个变异体都从 `baselineCopy` 重新拷一份 —— 上一轮变异不会污染下一轮
 *（这是「变异失效形态 #5：状态污染」的防线）。基线文件本身的 sha256 在
 * 开始与结束各取一次，必须一致。
 *
 * 用法（在 `apps/desktop` 下）：
 *   node scripts/o0-format-fidelity-smoke/mutate.mjs
 *   node scripts/o0-format-fidelity-smoke/mutate.mjs --only=docx
 *
 * 退出码：0 = 全部变异按预期变红；1 = 有变异没红（判据失效）；2 = 构造失败。
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const suite = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(suite, "../..");
const repo = resolve(desktop, "../..");
const workRoot = join(repo, ".tmp/o0-mutations");

const args = process.argv.slice(2);
let only = null;
for (const a of args) {
  if (a.startsWith("--only=")) only = a.slice("--only=".length);
  else throw Error(`Unknown option: ${a}`);
}

/* ───────────────────── 1. 从最近一次全绿证据里取基线 ───────────────────── */

/** 最近一次 `o0-format-fidelity-smoke` 的证据根（按目录名时间戳排序）。 */
function latestEvidenceRoot() {
  const root = join(repo, ".tmp/electron-u1");
  const dirs = readdirSync(root).filter((n) => /^\d{4}-\d{2}-\d{2}T/.test(n)).sort();
  if (dirs.length === 0) throw new Error(`没有证据目录：${root}`);
  for (let i = dirs.length - 1; i >= 0; i--) {
    const cand = join(root, dirs[i]);
    if (existsSync(join(cand, "docx-fidelity", "o0", "docx-baseline.json"))) return cand;
  }
  throw new Error(`最近的证据目录里没有 O0 基线：${root}`);
}

function loadBaseline(evidenceRoot, kind) {
  const p = join(evidenceRoot, `${kind}-fidelity`, "o0", `${kind}-baseline.json`);
  if (!existsSync(p)) return null;
  const stored = JSON.parse(readFileSync(p, "utf8"));
  return { fingerprint: stored.fingerprint, baselineCopy: stored.baselineCopy };
}

function sha256File(p) {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

/* ───────────────────── 2. 变异构造器（逐格式） ───────────────────── */

const mutants = {
  /**
   * DOCX：
   *  - delete：删掉内层嵌套表；
   *  - relocate：把内层嵌套表挪到外层 B2 格。
   */
  async docx(baselineCopy, outDir) {
    const { buildDocxMutants } = await importFresh("./mutants/docx.mjs");
    return buildDocxMutants(baselineCopy, outDir);
  },
  /** XLSX：delete 条件格式 + 合并；relocate 图表锚点。 */
  async xlsx(baselineCopy, outDir) {
    const { buildXlsxMutants } = await importFresh("./mutants/xlsx.mjs");
    return buildXlsxMutants(baselineCopy, outDir);
  },
  /** PPTX：delete 动画；relocate 备注到另一页；delete 图片。 */
  async pptx(baselineCopy, outDir) {
    const { buildPptxMutants } = await importFresh("./mutants/pptx.mjs");
    return buildPptxMutants(baselineCopy, outDir);
  },
  /** PDF：delete 书签；relocate 书签目的地到第 2 页；delete 批注。 */
  async pdf(baselineCopy, outDir) {
    const { buildPdfMutants } = await importFresh("./mutants/pdf.mjs");
    return buildPdfMutants(baselineCopy, outDir);
  },
  /** Markdown：delete 代码块；relocate 图片引用挪到列表后面。 */
  async markdown(baselineCopy, outDir) {
    const { buildMarkdownMutants } = await importFresh("./mutants/markdown.mjs");
    return buildMarkdownMutants(baselineCopy, outDir);
  },
  /** HTML：delete `<svg>`；relocate 把 `<svg>` 挪到 `<script>` 之后。 */
  async html(baselineCopy, outDir) {
    const { buildHtmlMutants } = await importFresh("./mutants/html.mjs");
    return buildHtmlMutants(baselineCopy, outDir);
  },
};

async function importFresh(rel) {
  return await import(pathToFileURL(join(suite, rel)).href);
}

/* ───────────────────── 3. 跑比对（与旅程同一个指纹实现） ───────────────────── */

/**
 * 与旅程**同一组**指纹选项。基线是用这组 opts 记录的；变异体若用默认 opts 重算，
 * 「放宽掉的 box」会变成一边有一边没有 —— 那是比对口径不一致，不是判据抓到了
 * 东西（实测踩过：三个 pptx 变异体全部误报 slide1/2/3 变红）。
 */
const FINGERPRINT_OPTS = {
  pptx: { pptxAutofitBox: [{ slidePath: "ppt/slides/slide2.xml", name: "TextBox 2" }] },
};

/**
 * 变异体**本身必须是合法文件**：一个「坏到读不出来」的变异体变红，证明的是
 * 「解析器报错」，不是「判据抓到了部件丢失」。这是变异失效形态 #3「改坏了程序，
 * 不是改坏了被验的东西」的变体（实测：早期 xlsx 公式变异造出非法工作簿，
 * 引擎报 XML Error，所有项都『红』了 —— 那种红一文不值）。
 */
function assertMutantReadable(kind, file) {
  if (kind !== "xlsx" && kind !== "docx" && kind !== "pptx") return null;
  const cli = join(repo, "genoffice/packages/cli/dist/genoffice.cjs");
  const sub = kind === "xlsx" ? "sheet" : kind === "docx" ? "docs" : "slides";
  const r = spawnSync(process.execPath, [cli, sub, "read", file, "--json"], {
    encoding: "utf8", timeout: 120_000,
    env: { ELECTRON_RUN_AS_NODE: "1", ...(process.env.PATH ? { PATH: process.env.PATH } : {}) },
  });
  if (r.status !== 0) {
    return `${sub} read 拒绝变异体（exit=${r.status}）：${(r.stdout || r.stderr || "").slice(0, 300)}`;
  }
  return null;
}

async function evaluate(kind, mutantFile, baselineFingerprint) {
  // 用与旅程**同一份** esbuild 出的指纹实现，避免「变异用 A、旅程用 B」。
  const mod = await import(pathToFileURL(join(repo, ".tmp/o0-mutate-build/fidelity.mjs")).href);
  const after = await mod.fingerprint(kind, mutantFile, repo, FINGERPRINT_OPTS[kind]);
  const diff = mod.diffFingerprints(baselineFingerprint, after);
  const bad = diff.entries.filter((e) => e.status !== "same");
  return { ok: diff.ok, bad: bad.map((e) => `${e.status}:${e.id}`) };
}

/* ───────────────────── 4. 主流程 ───────────────────── */

const evidenceRoot = latestEvidenceRoot();
console.log(`O0 mutate: 基线来自 ${evidenceRoot}`);
mkdirSync(workRoot, { recursive: true });

// 变异比对用的指纹实现：从**同一份源码**打一份 CJS/ESM 给 Node 用（旅程里那份
// 在 Electron 主进程的 journeys bundle 里，Node 这边拿不到）。走 esbuild ——
// 与 run.sh 的解析同一套规则：优先 .tmp/esbuild-path 缓存，其次 .pnpm 顶层。
// 生成产物落在 `.tmp/`（被 git 忽略），**不**放到套件源码目录里（`.build/` 会
// 被 `git status` 当成新文件带进提交）。
const buildDir = join(repo, ".tmp/o0-mutate-build");
mkdirSync(buildDir, { recursive: true });
const esbuildPath = resolveEsbuild();
{
  // esbuild 的 --alias 值带 Windows 反斜杠时解析不稳定（实测）；统一正斜杠。
  const fwd = (p) => p.replaceAll("\\", "/");
  // esbuild 的 `bin/esbuild` 是 Node 脚本（不是原生 exe）：Windows 上直接
  // spawnSync 会 ENOENT，必须用 process.execPath 起它。
  const r = spawnSync(process.execPath, [esbuildPath, 
    fwd(join(suite, "fidelity/fingerprint.ts")),
    "--bundle", "--platform=node", "--format=esm",
    "--banner:js=import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
    "--alias:genoffice:jszip=" + fwd(join(repo, "genoffice/node_modules/jszip")),
    "--alias:genoffice:fast-xml-parser=" + fwd(join(repo, "genoffice/node_modules/fast-xml-parser")),
    "--alias:genoffice:pdf-lib=" + fwd(join(repo, "genoffice/node_modules/pdf-lib")),
    "--outfile=" + fwd(join(buildDir, "fidelity.mjs")),
    "--log-level=error",
  ], { cwd: desktop, encoding: "utf8" });
  if (r.status !== 0) {
    console.error(r.stdout, r.stderr);
    throw new Error("mutate: esbuild 打包 fingerprint.ts 失败");
  }
}

function resolveEsbuild() {
  const cached = join(repo, ".tmp/esbuild-path");
  if (existsSync(cached)) {
    const p = readFileSync(cached, "utf8").trim();
    if (p && existsSync(p)) return p;
  }
  const pnpm = join(repo, "node_modules/.pnpm");
  const entries = readdirSync(pnpm).filter((n) => /^esbuild@\d/.test(n)).sort();
  for (let i = entries.length - 1; i >= 0; i--) {
    const bin = join(pnpm, entries[i], "node_modules/esbuild/bin/esbuild");
    if (existsSync(bin)) return bin;
  }
  throw new Error("mutate: 找不到 esbuild（先跑一次 pnpm test:smoke 或设置 MCODE_ESBUILD）");
}

const kinds = only ? [only] : ["docx", "xlsx", "pptx", "pdf", "markdown", "html"];
let failures = 0;
let total = 0;
const table = [];

for (const kind of kinds) {
  const base = loadBaseline(evidenceRoot, kind);
  if (base === null) {
    console.log(`  ${kind}: 没有基线（先跑一次 O0 全量）—— 跳过`);
    failures += 1;
    continue;
  }
  const baseSha = sha256File(base.baselineCopy);
  const outDir = join(workRoot, kind);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const cases = await mutants[kind](base.baselineCopy, outDir);

  for (const c of cases) {
    total += 1;
    const unreadable = assertMutantReadable(kind, c.file);
    if (unreadable !== null) {
      table.push({ kind, mutation: c.mutation, expectation: c.expect.join(","), red: false, hit: [], invalid: unreadable });
      console.log(`  ${kind} [${c.mutation}] 变异体不可读 —— ${unreadable}`);
      failures += 1;
      continue;
    }
    const res = await evaluate(kind, c.file, base.fingerprint);
    const red = !res.ok;
    const expectedIdHit = c.expect.some((id) => res.bad.some((b) => b.endsWith(`:${id}`)));
    table.push({
      kind,
      mutation: c.mutation,
      expectation: c.expect.join(","),
      red,
      hit: res.bad,
      detail: c.detail ?? null,
    });
    console.log(`  ${kind} [${c.mutation}] red=${red} hit=${res.bad.join(" ") || "-"}  (期望 ${c.expect.join(",")})`);
    if (!red || !expectedIdHit) failures += 1;
  }
  // 变异不得污染基线：重读 sha 必须与开始时一致
  const afterSha = sha256File(base.baselineCopy);
  if (afterSha !== baseSha) {
    console.error(`  ${kind}: 基线拷贝被污染（${baseSha} → ${afterSha}）`);
    failures += 1;
  }
}

writeFileSync(join(workRoot, "mutation-report.json"), JSON.stringify({ evidenceRoot, total, failures, table }, null, 2));
console.log(`\nO0 mutate: ${total} 个变异体，${failures === 0 ? "全部按预期变红" : `${failures} 条不符合预期`}`);
console.log(`报告：${join(workRoot, "mutation-report.json")}`);
process.exit(failures === 0 ? 0 : 1);
