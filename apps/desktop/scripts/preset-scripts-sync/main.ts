/**
 * **把 `resources/presets/workflows.json` 里两段 Python 正文从 `assets.ts` 重新生成**（MC-008）。
 *
 * 用法（在 `apps/desktop` 下）：
 *
 *     bash scripts/preset-scripts-sync/run.sh --check   # 只核对，漂移就非零退出（冒烟用这个）
 *     bash scripts/preset-scripts-sync/run.sh --write   # 把权威正文写回预设文件
 *
 * ## 为什么需要它
 *
 * 预设里 `wf_auto_convert` / `wf_auto_download` 的 code 节点各内联着一段 Python，
 * 而权威正文在 `src/main/workflows/assets.ts`。**手改 JSON 里那两段必然漂移** ——
 * 台账 MC-008 的失败反例就是「改了 assets.ts，用户跑的是旧副本」。现在 JSON 只是
 * **生成产物**：改脚本 = 改 assets.ts → 跑 `--write` → 冒烟逐字节核对。
 *
 * 判据与序列化都在 `scripts/lib/presetCodegen.ts`（冒烟与这里共用同一份实现）。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { generatePresetText, firstDiff, presetFile, targetKey, PRESET_BUNDLED_SCRIPTS } from "../lib/presetCodegen.js";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";

const MODE_CHECK = "--check";
const MODE_WRITE = "--write";

function usage(): never {
  console.error("用法: preset-scripts-sync (--check | --write)");
  process.exit(2);
}

const mode = process.argv[2];
if (mode !== MODE_CHECK && mode !== MODE_WRITE) usage();

const file = presetFile();
let source: string;
try {
  source = readFileSync(file, "utf8");
} catch (err) {
  console.error(`读不了预设文件 ${file}: ${(err as Error).message}`);
  process.exit(1);
}

let expected: string;
let applied: { workflowId: string; nodeId: string; constantName: string; changed: boolean }[];
try {
  ({ text: expected, applied } = generatePresetText(source));
} catch (err) {
  // 生成失败（缺节点 / 类型不对 / JSON 坏了）**必须显式失败** —— 悄悄跳过会让
  // 下一次"成功"掩盖预设已经坏掉的事实。
  console.error(`生成失败: ${(err as Error).message}`);
  process.exit(1);
}

/**
 * 【MC-006】随预设携带的脚本文件(如 `check_citations.py`):生成到
 * `resources/presets/scripts/<name>`,与 `assets.ts` 逐字节一致。
 *
 * 它们不是内联正文,而是**文件** —— 用户导入用到它的工作流时才落盘到数据根。
 * 手改 `resources/presets/scripts/` 下的文件同样会被 `--check` 打红,与 JSON 那条
 * 口径一致(权威源只有 `assets.ts`)。
 */
const presetDir = dirname(presetFile());
function bundledScriptPath(fileName: string): string { return join(presetDir, "scripts", fileName); }
function checkBundled(): string[] {
  const drift: string[] = [];
  for (const script of PRESET_BUNDLED_SCRIPTS) {
    const target = bundledScriptPath(script.fileName);
    let actual: string | null = null;
    try { actual = readFileSync(target, "utf8"); } catch { /* missing counts as drift */ }
    if (actual !== script.body) drift.push(script.fileName);
  }
  return drift;
}
function writeBundled(): string[] {
  const written: string[] = [];
  for (const script of PRESET_BUNDLED_SCRIPTS) {
    const target = bundledScriptPath(script.fileName);
    let actual: string | null = null;
    try { actual = readFileSync(target, "utf8"); } catch { /* missing */ }
    if (actual === script.body) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, script.body, "utf8");
    written.push(script.fileName);
  }
  return written;
}

const drifted = applied.filter((a) => a.changed);
const bundledDrift = checkBundled();
if (mode === MODE_CHECK) {
  if (bundledDrift.length > 0) {
    console.error(`preset-scripts-sync: resources/presets/scripts/ 与 assets.ts 不一致:${bundledDrift.join("、")}`);
    console.error("  跑 `bash scripts/preset-scripts-sync/run.sh --write` 重新生成,不要手改。");
    process.exit(1);
  }
  if (expected === source) {
    console.log(
      `preset-scripts-sync: 预设里的 Python 正文与 assets.ts 一致（${applied.map((a) => `${targetKey(a)}=${a.constantName}`).join("、")}）`,
    );
    process.exit(0);
  }
  const diff = firstDiff(source, expected);
  console.error("preset-scripts-sync: 预设里的 Python 正文与 assets.ts 不一致（MC-008）。");
  console.error(`  跑 \`bash scripts/preset-scripts-sync/run.sh --write\` 重新生成，不要手改 JSON。`);
  if (diff) console.error(`  第一处不一致 @${diff.offset}: 文件里 ${diff.actual} / 应为 ${diff.expected}`);
  process.exit(1);
}

if (expected === source) {
  const written = writeBundled();
  console.log(written.length > 0
    ? `preset-scripts-sync: 已重写 resources/presets/scripts/${written.join("、")}`
    : "preset-scripts-sync: 已经是最新，未改文件。");
  process.exit(0);
}
writeFileSync(file, expected, "utf8");
{
  const written = writeBundled();
  if (written.length > 0) console.log(`preset-scripts-sync: 已重写 resources/presets/scripts/${written.join("、")}`);
}
console.log(
  `preset-scripts-sync: 已写回 ${file}（更新了 ${drifted.map((a) => targetKey(a)).join("、") || "仅格式"}）`,
);
