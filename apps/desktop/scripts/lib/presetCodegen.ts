/**
 * **预设工作流里两段 Python 正文的唯一生成器**（MC-008，2026-10-17）。
 *
 * ## 它解决的是什么
 *
 * `resources/presets/workflows.json` 里有两个 `mcode.code` 节点带着**整段 Python**：
 *
 *   - `wf_auto_convert` / `auto-convert-code`   ← `assets.ts` 的 `MINERU_PY`
 *   - `wf_auto_download` / `auto-download-collect` ← `assets.ts` 的 `LIT_IMPORT_PY`
 *
 * 从前这两段是**手维护的第二份正文**：改 `assets.ts` 忘了同步 JSON，用户导入预设后
 * 跑的是旧版，而没有任何东西会红（台账 MC-008 的失败反例）。现在：
 *
 *   1. **可编辑的权威只有 `assets.ts` 一处**；
 *   2. JSON 里那两段由本模块**生成**（CLI 见 `scripts/preset-scripts-sync/`），
 *      `scripts/preset-scripts-sync-smoke` 逐字节核对 —— **手改 JSON 里的正文会被打红**；
 *   3. `seed.ts` 不再落盘这两份脚本（没有调用方的落盘文件只是让人误判"哪份在跑"）。
 *
 * ## 为什么不是 `runner.entry`
 *
 * 台账修法 2 的首选是让预设节点用 `runner.entry` 引用落盘脚本。读实现后确认**预设
 * 表达不了**：`entry` 是**节点类型清单**上的字段（`NodeRunnerSchema`，contracts 的
 * `nodeType.ts`），解析基准是**清单文件所在目录**（`entryRunner.ts` 的
 * `resolveEntryScript`）；内置类型没有清单目录（`runner.ts` 的 `manifestDirOf` 对
 * 内置返回 undefined，`resolveEntryScript` 随即返回 null），而预设节点只有
 * `type` + `params`（`WorkflowNodeSchema`），不能自带清单。且 command 节点的语义与
 * 这两步相反（非零退出码不算失败），也不走 `applyHostActions`（`adoptMarkdown` /
 * `importFiles` 会**静默不执行**）。所以走台账同条给出的另一支：「让预设节点
 * `params.code` 从权威正文**生成**（构建期填充），禁止人手粘贴」。
 *
 * ## 判据（谁都能重跑）
 *
 * - `applyPresetScripts`：只改这两个节点的 `params.code`，别的一个字节不动；目标
 *   缺失 / 类型不是 `mcode.code` / 语言不是 python → **抛错**（坏东西显式报出来）。
 * - `generatePresetText`：`JSON.parse` → 替换 → `JSON.stringify(…, 2) + "\n"`。这个
 *   序列化与仓库里那份文件**逐字节**一致（已实测 39349 bytes round-trip），所以
 *   「生成结果 == 磁盘文件」是一条可断言的等式，而不是格式之争。
 */
import { join } from "node:path";
import { LIT_IMPORT_PY, MINERU_PY } from "@main/workflows/assets.js";

/** 预置文件相对 `apps/desktop` 的路径。 */
export const PRESET_RELATIVE_PATH = "resources/presets/workflows.json";

export function presetFile(cwd: string = process.cwd()): string {
  return join(cwd, PRESET_RELATIVE_PATH);
}

/** 一个「JSON 里的正文 ← assets 常量」的映射。 */
export interface PresetScriptTarget {
  readonly workflowId: string;
  readonly nodeId: string;
  readonly constantName: "MINERU_PY" | "LIT_IMPORT_PY";
  readonly body: string;
}

/**
 * 唯一的映射表。**想再往预设内联一段 Python，先加到这里** —— 否则
 * `preset-scripts-sync-smoke` 的「预设里每段 Python 都是生成结果」会打红。
 */
export const PRESET_SCRIPT_TARGETS: readonly PresetScriptTarget[] = [
  { workflowId: "wf_auto_convert", nodeId: "auto-convert-code", constantName: "MINERU_PY", body: MINERU_PY },
  { workflowId: "wf_auto_download", nodeId: "auto-download-collect", constantName: "LIT_IMPORT_PY", body: LIT_IMPORT_PY },
];

export interface AppliedPresetScript {
  workflowId: string;
  nodeId: string;
  constantName: string;
  /** 原来那段与权威正文是否不同（`--write` 用它报告"真的改了哪段"）。 */
  changed: boolean;
}

function recordOf(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${what}不是对象`);
  }
  return value as Record<string, unknown>;
}

/**
 * 把预置文档深拷贝一份，把两个目标节点的 `params.code` 换成权威正文。
 *
 * **只碰这两个节点的这一段字符串**。目标找不到 / 形状不对一律抛错 —— 生成器
 * 悄悄跳过的话，下一次「生成成功」的日志会掩盖「预设已经坏了」。
 */
export function applyPresetScripts(doc: unknown): { doc: unknown; applied: AppliedPresetScript[] } {
  // 深拷贝：调用方（冒烟）拿原文档做对照，不能被就地改掉。JSON 文档用 JSON 往返即可。
  const clone: unknown = JSON.parse(JSON.stringify(doc));
  const root = recordOf(clone, "预置文件顶层");
  const workflows = root.workflows;
  if (!Array.isArray(workflows)) throw new Error("预置文件里没有 workflows 数组");
  const applied: AppliedPresetScript[] = [];

  for (const target of PRESET_SCRIPT_TARGETS) {
    const wfRaw = workflows.find((w) => {
      const rec = w && typeof w === "object" && !Array.isArray(w) ? (w as Record<string, unknown>) : undefined;
      return rec?.id === target.workflowId;
    });
    if (wfRaw === undefined) throw new Error(`预置文件里找不到工作流「${target.workflowId}」`);
    const wf = recordOf(wfRaw, `工作流「${target.workflowId}」`);
    const nodes = wf.nodes;
    if (!Array.isArray(nodes)) throw new Error(`工作流「${target.workflowId}」没有 nodes 数组`);
    const nodeRaw = nodes.find((n) => {
      const rec = n && typeof n === "object" && !Array.isArray(n) ? (n as Record<string, unknown>) : undefined;
      return rec?.id === target.nodeId;
    });
    if (nodeRaw === undefined) {
      throw new Error(`工作流「${target.workflowId}」里找不到节点「${target.nodeId}」`);
    }
    const node = recordOf(nodeRaw, `节点「${target.nodeId}」`);
    // 判据不是"有个 code 字段"，而是"这一步确实是跑 Python 的 code 节点" ——
    // 否则生成器会把正文写进一个根本不会执行它的地方，而表面上一切成功。
    if (node.type !== "mcode.code") {
      throw new Error(`节点「${target.nodeId}」不是 mcode.code（type=${String(node.type)}），拒绝写入正文`);
    }
    const params = recordOf(node.params, `节点「${target.nodeId}」的 params`);
    if (params.language !== "python") {
      throw new Error(`节点「${target.nodeId}」的 language 不是 python（${String(params.language)}），拒绝写入正文`);
    }
    const before = params.code;
    params.code = target.body;
    applied.push({
      workflowId: target.workflowId,
      nodeId: target.nodeId,
      constantName: target.constantName,
      changed: before !== target.body,
    });
  }
  return { doc: clone, applied };
}

/** 与仓库里那份文件一致的序列化（2 空格缩进 + 末尾换行；非 ASCII 原样保留）。 */
export function serializePreset(doc: unknown): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** 从预置文件的**当前文本**生成应落的文本。解析失败抛错（不静默当空文档）。 */
export function generatePresetText(sourceText: string): { text: string; applied: AppliedPresetScript[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sourceText);
  } catch (err) {
    throw new Error(`预置文件不是合法 JSON：${(err as Error).message}`);
  }
  const { doc, applied } = applyPresetScripts(parsed);
  return { text: serializePreset(doc), applied };
}

export interface TextDiff {
  offset: number;
  actual: string;
  expected: string;
}

/** 第一处不一致的偏移和两侧片段 —— 给红断言一句能查的话（不然只有"俩字符串不等"）。 */
export function firstDiff(actual: string, expected: string): TextDiff | null {
  if (actual === expected) return null;
  const max = Math.min(actual.length, expected.length);
  let i = 0;
  while (i < max && actual[i] === expected[i]) i += 1;
  const start = Math.max(0, i - 40);
  return {
    offset: i,
    actual: JSON.stringify(actual.slice(start, i + 80)),
    expected: JSON.stringify(expected.slice(start, i + 80)),
  };
}

/** 目标节点的集合身份，形如 `wf_auto_convert/auto-convert-code`（断言与报错共用）。 */
export function targetKey(t: { workflowId: string; nodeId: string }): string {
  return `${t.workflowId}/${t.nodeId}`;
}
