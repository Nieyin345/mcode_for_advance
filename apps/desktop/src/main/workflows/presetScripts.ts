/**
 * **按需落盘随预设携带的脚本**（【MC-006】）。
 *
 * ## 为什么要有这一层
 *
 * `check_citations.py` 是引用核对脚本,只有"写作"类工作流用得上。从前 `seed.ts` 在
 * **每次启动**把它写进每个用户的数据根 —— 做通用软件开发、数据分析的人都有一份自己
 * 永远不看、也不知道能不能删的学术脚本。台账 MC-006 的定性是"特定场景内容硬编码进
 * 本体"。
 *
 * 现在它随预设走:`resources/presets/scripts/check_citations.py`(由
 * `scripts/preset-scripts-sync --write` 从 `assets.ts` 生成,逐字节核对)。落盘的
 * **触发点**是「用户导入了一份引用它的工作流」—— 不导入就不写。
 *
 * ## 判据
 *
 * - 工作流文本里**真的提到**这个脚本名(按文件名匹配)→ 才落盘(不做模糊猜测);
 * - 落盘走 `seedShippedFiles` 那**同一条**规则(没改过的换新版、改过的不动)——
 *   用户改过的引用核对脚本不能被一次导入覆盖。记录文件与 `seed.ts` 共用一份
 *   (`.mcode-shipped.json`),因为它记的是"scripts/ 下每个文件上次写出去的是哪一版";
 * - 找不到随包脚本(开发目录缺 `resources/presets/scripts/` / 安装包漏了 extraResources)
 *   → 记一条警告并**继续导入**。缺一个可选脚本不该让工作流导入失败 —— 但必须说出来,
 *   否则用户会以为导入完整(硬规矩 3)。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "@main/lib/logger.js";
import { presetRootCandidates, presetRelativePath } from "@main/lib/presetFiles.js";
import { seedShippedFiles } from "@main/workflows/shippedFiles.js";
import { SHIPPED_RECORD_FILE, scriptsDir, workflowsRoot } from "@main/workflows/seed.js";

/** 随预设携带的脚本清单 —— **唯一一份**;`scripts/lib/presetCodegen.ts` 生成这些文件。 */
export const PRESET_BUNDLED_SCRIPTS: readonly { fileName: string; hint: string }[] = [
  { fileName: "check_citations.py", hint: "引用核对(文献写作类工作流用)" },
];

/** 从候选根找 `resources/presets/scripts/<name>`;找不到返回 null。 */
export function resolveBundledScript(
  fileName: string,
  candidates: readonly string[] = presetRootCandidates(),
): string | null {
  const rel = join(presetRelativePath("scripts"), fileName);
  for (const root of candidates) {
    const file = join(root, rel);
    try {
      readFileSync(file);
      return file;
    } catch {
      /* 继续下一个候选 */
    }
  }
  return null;
}

/**
 * 导入一份工作流文本后,把**它引用到的**随预设脚本落盘。返回实际落盘的相对路径
 * (供导入结果告知调用方;没引用/找不到都不抛)。
 *
 * 调用点在 `importWorkflowInto` —— 界面导入、从文件导入、Agent 经 `workflow.import`、
 * 出厂预设导入**四条路**都汇进那一个函数,所以这里只挂一次。
 */
export function materializePresetScriptsFor(workflowText: string): { placed: string[]; missing: string[] } {
  const placed: string[] = [];
  const missing: string[] = [];
  const needed = PRESET_BUNDLED_SCRIPTS.filter((s) => workflowText.includes(s.fileName));
  if (needed.length === 0) return { placed, missing };

  const files: { rel: string; body: string }[] = [];
  for (const script of needed) {
    const src = resolveBundledScript(script.fileName);
    if (src === null) {
      missing.push(script.fileName);
      log.warn(`workflow import: 随包脚本 ${script.fileName}(${script.hint})不在这个安装里 —— 导入照常,但工作流里引用它的那一步会找不到文件`);
      continue;
    }
    try {
      files.push({ rel: `scripts/${script.fileName}`, body: readFileSync(src, "utf8") });
    } catch (err) {
      missing.push(script.fileName);
      log.warn(`workflow import: 读随包脚本 ${src} 失败:${(err as Error).message}`);
    }
  }
  if (files.length === 0) return { placed, missing };

  // 与 `seed.ts` 共用记录文件:判据是"scripts/ 下这个文件上次写出去的是哪一版",
  // 与它属于哪个启动流程无关。改过的用户脚本不会被一次导入覆盖。
  try {
    seedShippedFiles(files, {
      rootDir: workflowsRoot(),
      recordFile: SHIPPED_RECORD_FILE,
      label: "workflow-import",
      executableExts: [".py"],
    });
    for (const f of files) placed.push(f.rel);
  } catch (err) {
    log.warn(`workflow import: 落盘随包脚本失败:${(err as Error).message}`);
  }
  return { placed, missing };
}

/** 诊断:当前候选根解析到的 scripts 目录(冒烟用)。 */
export function bundledScriptsDir(candidates: readonly string[] = presetRootCandidates()): string {
  return candidates.length > 0 ? join(candidates[0], presetRelativePath("scripts")) : scriptsDir();
}
