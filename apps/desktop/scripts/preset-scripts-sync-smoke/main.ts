/**
 * preset-scripts-sync-smoke —— 【MC-008】预设里的 Python 正文**只能来自 `assets.ts`**。
 *
 * ## 它守的是什么（比上一套强在哪）
 *
 * `scripts/shipped-script-copies-smoke`（已删）守的是「两个手维护的副本必须逐字相同」
 * —— 那只是**防漂移**，副本结构还在。台账 MC-008 的系统性修法要的是**消除副本**：
 * `assets.ts` 是唯一可编辑的正文，预设 JSON 里那两段是**生成产物**。
 *
 * 这套的判据因此变成：
 *
 *   - **预设文件 == 生成器（以文件自身为输入）的输出** —— 手改 JSON 里任何一段
 *     Python（或改格式），生成结果就对不上，当场红。这正是「单权威源」的判据；
 *   - **每个目标节点的 `params.code` 逐字节等于 `assets.ts` 常量**（动态求值，
 *     真 import、真 JSON.parse —— 不是文本包含断言）；
 *   - **预设里没有未受管的 Python**：凡是内联成 Python 的 `params.code`，必须正是
 *     映射表里的那两个节点；新塞一段不受管的正文也会红（逼人先登记再生成）；
 *   - **`seed.ts` 与预设引用对齐**：落盘清单不含这两份（没有调用方的落盘副本正是
 *     台账说的孤岛），也不再有 `mineru_transcribe.py`。
 *
 * ## 为什么这里不是 `runner.entry`
 *
 * `entry` 是**节点类型清单**的字段、相对**清单目录**解析；预设节点只有
 * `type`+`params`，而内置类型没有清单目录（`manifestDirOf` 对内置返回 undefined，
 * `resolveEntryScript` 随即拒绝）—— 预设表达不了 entry。command 节点还会把
 * `adoptMarkdown`/`importFiles` 丢掉（那是 `codeExecutor` 的宿主动作）。所以走台账
 * 同条给的另一支：「`params.code` 从权威正文**生成**，禁止人手粘贴」。
 *
 * ## 变异怎么验
 *
 * ① 把 `assets.ts` 的常量改一个字符 → §B 红（预设与常量不再相等），跑 `--write`
 * 后恢复绿 —— 反向证明「改权威源，预设跟着变」；② 手改预设 JSON 一个字符 →
 * §C（生成结果≠文件）与 §B 同时红。两种漂移方向都被盖住。
 *
 * Run: scripts/preset-scripts-sync-smoke/run.sh
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PRESET_SCRIPT_TARGETS,
  applyPresetScripts,
  firstDiff,
  generatePresetText,
  presetFile,
  targetKey,
} from "../lib/presetCodegen.js";
import { MINERU_PY, LIT_IMPORT_PY } from "@main/workflows/assets.js";

let checks = 0;
let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  checks++;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

const file = presetFile();
const source = readFileSync(file, "utf8");
const doc = JSON.parse(source) as { workflows: { id?: string; nodes?: { id?: string; type?: string; params?: Record<string, unknown> }[] }[] };

/* ─────────── §A 映射表与权威常量一致（映射表本身没漂）─────────── */

console.log("\n§A 生成映射表 ↔ assets.ts");
const CONSTANTS: Record<string, string> = { MINERU_PY, LIT_IMPORT_PY };
check("映射表有两项（MINERU + LIT）", PRESET_SCRIPT_TARGETS.length === 2, PRESET_SCRIPT_TARGETS.map(targetKey));
for (const t of PRESET_SCRIPT_TARGETS) {
  check(
    `★ 映射项 ${targetKey(t)} 的 body 是 assets.ts 的 ${t.constantName}（不是另抄一份）`,
    CONSTANTS[t.constantName] === t.body,
    { constant: t.constantName, bodyLength: t.body.length },
  );
}

/* ─────────── §B 预设里每个目标的正文都逐字节等于权威常量 ─────────── */

console.log("\n§B 预设内联正文 ↔ 权威常量（动态求值）");
for (const t of PRESET_SCRIPT_TARGETS) {
  const wf = doc.workflows.find((w) => w.id === t.workflowId);
  const node = wf?.nodes?.find((n) => n.id === t.nodeId);
  check(`★ ${targetKey(t)} 节点还在`, node !== undefined, wf?.nodes?.map((n) => n.id));
  if (!node) continue;
  const params = node.params ?? {};
  check(`${targetKey(t)} 是 mcode.code`, node.type === "mcode.code", node.type);
  check(`${targetKey(t)} 的 language 是 python`, params.language === "python", params.language);
  const code = typeof params.code === "string" ? params.code : "";
  const diff = firstDiff(code, t.body);
  check(
    `★ ${targetKey(t)} 的 params.code 与 ${t.constantName} 逐字节相同`,
    diff === null,
    diff ?? { codeLength: code.length, constantLength: t.body.length },
  );
}

/* ─────────── §C 磁盘文件 == 生成器（以文件自身为输入）的输出 ─────────── */

console.log("\n§C 预设文件 == 生成结果（手改会被打红）");
{
  let generated: string | null = null;
  let error: string | null = null;
  try {
    generated = generatePresetText(source).text;
  } catch (err) {
    error = (err as Error).message;
  }
  check("生成器能处理当前文件（不缺节点、形状对）", error === null, error);
  if (generated !== null) {
    const diff = firstDiff(source, generated);
    check(
      "★ 磁盘上的预设 == 从它生成的文本（预设是生成产物，不是手维护副本）",
      diff === null,
      diff ?? { actualBytes: source.length, expectedBytes: generated.length },
    );
  }
}

/* ─────────── §D 没有未受管的 Python；坏形状显式报错 ─────────── */

console.log("\n§D 未受管正文 / 生成器的失败路径");
{
  const managed = new Set(PRESET_SCRIPT_TARGETS.map(targetKey));
  const inlinePython: string[] = [];
  for (const wf of doc.workflows) {
    for (const n of wf.nodes ?? []) {
      const params = n.params ?? {};
      const code = params.code;
      if (typeof code === "string" && /python/i.test(code.slice(0, 300))) {
        inlinePython.push(`${wf.id}/${n.id}`);
      }
    }
  }
  const unmanaged = inlinePython.filter((key) => !managed.has(key));
  check(`预设里的内联 Python 全是生成目标（找到 ${inlinePython.length} 段）`, inlinePython.length === managed.size, inlinePython);
  check("★ 没有未受管的 Python 副本（新塞一段要先登记进映射表）", unmanaged.length === 0, unmanaged);

  // 失败路径：目标节点缺失 → 抛错（不能悄悄生成一份"成功"）。
  const broken = JSON.parse(source) as typeof doc;
  broken.workflows = broken.workflows.filter((w) => w.id !== PRESET_SCRIPT_TARGETS[0]!.workflowId);
  let threw = false;
  try {
    applyPresetScripts(broken);
  } catch {
    threw = true;
  }
  check("★ 目标工作流缺失时生成器抛错（不静默跳过）", threw);

  // 失败路径：目标节点类型不对 → 抛错（正文不会被写进不执行它的地方）。
  const wrongType = JSON.parse(source) as typeof doc;
  const wf = wrongType.workflows.find((w) => w.id === PRESET_SCRIPT_TARGETS[0]!.workflowId);
  const node = wf?.nodes?.find((n) => n.id === PRESET_SCRIPT_TARGETS[0]!.nodeId);
  if (node) node.type = "mcode.agent";
  let threwType = false;
  try {
    applyPresetScripts(wrongType);
  } catch {
    threwType = true;
  }
  check("★ 目标节点不是 mcode.code 时生成器抛错", threwType);
}

/* ─────────── §E seed 落盘清单与预设引用对齐（MC-008 修法 3）─────────── */

console.log("\n§E seed.ts 落盘清单（静态 + 真跑 ensureWorkflows）");
{
  const seed = readFileSync(join(process.cwd(), "src/main/workflows/seed.ts"), "utf8");
  const shipped = [...seed.matchAll(/rel:\s*"scripts\/([\w.]+\.py)",\s*body:\s*(\w+)/g)].map((m) => ({ file: m[1]!, body: m[2]! }));
  check("seed.ts 的落盘脚本从 assets 常量取正文（没有手写第二份）", shipped.length >= 1, shipped);
  check(
    "★ 落盘清单不含无调用方的 mineru_transcribe.py / lit_import.py（与预设内联对齐）",
    !shipped.some((s) => s.file === "mineru_transcribe.py" || s.file === "lit_import.py"),
    shipped,
  );
  check(
    "★ 落盘清单不含 MINERU_PY / LIT_IMPORT_PY（它们只走预设内联）",
    !shipped.some((s) => s.body === "MINERU_PY" || s.body === "LIT_IMPORT_PY"),
    shipped,
  );
  // 正控：真正有调用方的那两份仍在清单里（防"为了对齐把该落的也删了"）。
  check("library.py 仍落盘（系统提示词指名它）", shipped.some((s) => s.file === "library.py" && s.body === "LIBRARY_PY"), shipped);
  // 【MC-006】check_citations.py **不再**随启动落盘 —— 它是学术场景脚本,改由导入
  // 「写作」类工作流时按需落盘(见 main/workflows/presetScripts.ts)。
  check("★ check_citations.py 不再随启动落盘(MC-006)", !shipped.some((s) => s.file === "check_citations.py"), shipped);

  // **真跑一遍**：判据不是"源码里写着什么"，而是"启动落盘之后盘上有什么"。
  // 数据根由 run.sh 的 MCODE_SMOKE_DATA_ROOT 指向 mktemp 目录（dataRoot 桩）。
  const { ensureWorkflows } = (await import("@main/workflows/seed.js")) as typeof import("@main/workflows/seed.js");
  const { scriptsDir } = (await import("@main/workflows/seed.js")) as typeof import("@main/workflows/seed.js");
  const { existsSync } = await import("node:fs");
  const report = ensureWorkflows();
  check("ensureWorkflows 只写 README + library.py(两个文件)", report.written.length === 2, report);
  check("★ 落盘后 scripts/mineru_transcribe.py 不在盘上（没有调用方的落盘副本已消除）", !existsSync(join(scriptsDir(), "mineru_transcribe.py")), scriptsDir());
  check("★ 落盘后 scripts/lit_import.py 不在盘上", !existsSync(join(scriptsDir(), "lit_import.py")), scriptsDir());
  const libPath = join(scriptsDir(), "library.py");
  check("★ 落盘的 library.py 与 LIBRARY_PY 逐字节相同（正文来自常量）", existsSync(libPath) && readFileSync(libPath, "utf8").replace(/\r\n/g, "\n") === (await import("@main/workflows/assets.js")).LIBRARY_PY, libPath);
}

/* ─────────── §F 随预设携带的脚本文件（MC-006）─────────── */

console.log("\n§F resources/presets/scripts/");
{
  const { readFileSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { PRESET_BUNDLED_SCRIPTS } = await import("../lib/presetCodegen.js");
  const { CHECK_CITATIONS_PY } = await import("@main/workflows/assets.js");
  check("映射表至少有一项", PRESET_BUNDLED_SCRIPTS.length >= 1, PRESET_BUNDLED_SCRIPTS.map((s) => s.fileName));
  for (const script of PRESET_BUNDLED_SCRIPTS) {
    const file = join(process.cwd(), "resources", "presets", "scripts", script.fileName);
    check(`磁盘上的 ${script.fileName} 存在`, existsSync(file), file);
    check(
      `★ 磁盘上的 ${script.fileName} 与 assets.ts 逐字节一致（禁止手改）`,
      existsSync(file) && readFileSync(file, "utf8") === script.body,
      file,
    );
  }
  // 生产侧那张表与生成侧那张表**指的是同一批文件**（两边各写一份会漂）。
  const prod = readFileSync(join(process.cwd(), "src/main/workflows/presetScripts.ts"), "utf8");
  for (const script of PRESET_BUNDLED_SCRIPTS) {
    check(`生产落盘清单里也提到 ${script.fileName}`, prod.includes(`"${script.fileName}"`), script.fileName);
  }
  check("随包脚本正文来自 assets 常量（不是另一份手写）", CHECK_CITATIONS_PY.includes("#!/usr/bin/env python3"));
}

/* ─────────── §G 打包布局解析（MC-007 复核补漏）─────────── */

console.log("\n§G 预置文件在「打包布局」下也能解析");
{
  // 打包态的形状:`extraResources` 把 `resources/presets/*` 铺到 `<resourcesPath>/presets/`,
  // **没有**再套一层 `resources/`。用一个临时根**真的造出**这种布局,断言通用解析器
  // 找得到 —— 从前它对每个根都拼 `resources/presets/…`,打包态一律 absent。
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: joinPath } = await import("node:path");
  const { resolvePresetFile, readPresetJson, presetPathCandidatesIn } = await import("@main/lib/presetFiles.js");
  const root = mkdtempSync(joinPath(tmpdir(), "mcode-preset-packed-"));
  try {
    mkdirSync(joinPath(root, "presets"), { recursive: true });
    writeFileSync(joinPath(root, "presets", "workflows.json"), JSON.stringify({ workflows: [] }), "utf8");
    check(
      "★ 打包布局(root/presets/file)能被解析到",
      resolvePresetFile("workflows.json", [root]) === joinPath(root, "presets", "workflows.json"),
      resolvePresetFile("workflows.json", [root]),
    );
    const read = readPresetJson("workflows.json", [root]);
    check("★ 打包布局读得回合法 JSON(health=ok)", read.health === "ok", read);
    mkdirSync(joinPath(root, "resources", "presets"), { recursive: true });
    writeFileSync(joinPath(root, "resources", "presets", "workflows.json"), JSON.stringify({ workflows: [{ id: "dev" }] }), "utf8");
    const picked = readPresetJson("workflows.json", [root]);
    check(
      "★ 两种布局同时存在时优先开发布局(不改变开发态行为)",
      picked.health === "ok" && JSON.stringify(picked).includes('"id":"dev"'),
      picked,
    );
    const missing = readPresetJson("nope.json", [root]);
    check("★ absent 文案列出两种布局的真实路径", missing.health === "absent" && missing.path.includes(joinPath(root, "presets", "nope.json")) && missing.path.includes(joinPath(root, "resources", "presets", "nope.json")), missing);
    check("presetPathCandidatesIn 给出两种布局", presetPathCandidatesIn(root, "x.json").length === 2);
    const real = readPresetJson("workflows.json");
    check("开发态:真仓库的资源目录仍解析得到 workflows.json", real.health === "ok", real);

    // MC-007 后续路径保全：读取器是导出函数，未来的调用方未必只传当前的
    // workflows.json 常量，非法 basename 或目录链接不能把“出厂”变成任意文件读取。
    writeFileSync(joinPath(root, "secrets.json"), JSON.stringify({ marker: "OUTSIDE-PRESETS" }), "utf8");
    const traversal = readPresetJson("../secrets.json", [root]);
    check("★ 非法 .. 文件名显式拒绝，不回传安装根下的任意 JSON",
      traversal.health === "corrupt" && !JSON.stringify(traversal).includes("OUTSIDE-PRESETS"), traversal);
    check("★ resolvePresetFile 遇非法文件名不返回越界路径",
      resolvePresetFile("../secrets.json", [root]) === null);

    const linkRoot = joinPath(root, "link-root");
    const outside = joinPath(root, "outside-asset-dir");
    mkdirSync(joinPath(linkRoot, "resources"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(joinPath(outside, "workflows.json"), JSON.stringify({ marker: "JUNCTION-SECRET" }), "utf8");
    const redirected = joinPath(linkRoot, "resources", "presets");
    let linkMade = false;
    try {
      const { symlinkSync, lstatSync, rmdirSync, unlinkSync, readFileSync } = await import("node:fs");
      try { symlinkSync(outside, redirected, process.platform === "win32" ? "junction" : "dir"); linkMade = true; }
      catch (err) { console.log("  SKIP junction 创建被 OS 拒绝", (err as Error).message); }
      if (linkMade) {
        check("★ OS 确有真实的目录重解析点，防止假夹具通过", lstatSync(redirected).isSymbolicLink());
        const escaped = readPresetJson("workflows.json", [linkRoot]);
        check("★ 出厂预置目录被 junction 换到外部时返回损坏态，不跟随读取",
          escaped.health === "corrupt" && !JSON.stringify(escaped).includes("JUNCTION-SECRET"), escaped);
        check("★ 越界的符号链接路径不给成功解析器",
          resolvePresetFile("workflows.json", [linkRoot]) === null);
        check("★ 外部 JSON 字节不变", readFileSync(joinPath(outside, "workflows.json"), "utf8").includes("JUNCTION-SECRET"));
        if (process.platform === "win32") rmdirSync(redirected); else unlinkSync(redirected);
        linkMade = false;
      }
    } finally {
      if (linkMade) {
        const { rmdirSync, unlinkSync } = await import("node:fs");
        if (process.platform === "win32") rmdirSync(redirected); else unlinkSync(redirected);
      }
    }

  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(`\npreset-scripts-sync-smoke: ${checks - failures}/${checks} 通过`);
if (failures > 0) process.exit(1);
