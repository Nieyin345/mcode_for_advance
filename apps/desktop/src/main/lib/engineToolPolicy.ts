/**
 * **按引擎的内置工具禁用策略** —— 让用户决定"某个引擎的某个**内置**工具对模型
 * 可见/可用"，并在三个引擎之间尽量统一。
 *
 * ## 为什么需要它（这是"内置工具难以修改"的正解）
 *
 * 三个引擎各自带一套**内置**工具（Claude 的 Bash/Read/Edit/Glob…、Pi 的 read/write/
 * edit/bash/grep…、Codex 的壳命令）。在此之前，Mcode 只能靠**运行时守卫事后拦** ——
 * Claude 的 `canUseTool`、Pi 的 `tool_call` 事件、Codex 的审批回调。拦是拦住了，但：
 *
 * - 模型**仍然看得见**那个工具，于是反复尝试、报错、绕路；
 * - 没法做"关掉某引擎的原生读取，强制它用我的统一工具"这种干净收敛。
 *
 * 而三家 SDK 其实**都能删**：
 *   - Claude：`Options.disallowedTools`（从模型上下文移除）
 *   - Pi：`Options.excludeTools`（在 `tools` 白名单之后生效）
 *   - Codex：**没有**按名删的入口，只能用沙箱/审批档（`CodexAgentSdkProvider` 里
 *     标注为"不可按名禁用"，UI 据此如实告知用户）。
 *
 * 所以这份策略就是"统一 + 自定义"的落点：**一份清单**，谁被禁、对哪个引擎，都写在这里，
 * 两个能删的引擎各自接 SDK 的对应字段。
 *
 * ## 存储（照抄 `skillEngines` 的取舍）
 *
 * 文件 `~/.mcode/engine-tools.json`：
 *
 *     { "claude": { "exclude": ["Bash"] }, "pi": { "exclude": ["bash", "grep"] } }
 *
 * - **缺省 = 不禁用**：没有引擎键、或 exclude 为空，都表示该引擎不设限（保持原生全量）。
 * - 只持久化**非空**的 exclude；空条目直接删掉，文件里只留用户真实的限制。
 * - 读文件容错：坏 JSON / 非法条目一律按"不禁用"处理 —— 一份坏配置**绝不能**把某个
 *   引擎的工具砍没了。
 *
 * ## 纯核
 *
 * 不 import electron / db / 任何主进程目录。自带一个小的原子写，避免为 `atomicWrite`
 * 去 import `appContext`（那条链会拖进 electron，无头 smoke 就进不来了）。
 * 文件路径只从 `defaultEngineToolPolicyPath()`（只用 `os.homedir`）来。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const ENGINE_TOOL_ENGINES = ["claude", "pi", "codex"] as const;
export type EngineToolEngine = (typeof ENGINE_TOOL_ENGINES)[number];

/** 一个引擎的禁用项。目前只有一个字段：要禁用的工具名列表。 */
export interface EngineToolEntry {
  /** 该引擎**不可用**的内置工具名（exact match，大小写敏感 —— 工具名就是这个大小写）。 */
  exclude: string[];
}

/** 整份策略：引擎 → 条目。引擎键缺席 = 该引擎不设限。 */
export type EngineToolPolicy = Partial<Record<EngineToolEngine, EngineToolEntry>>;

/** 工具名的可接受字符集：内置名是 `Bash`/`read` 这种，也可能带 `mcp__server__tool`
 *  或命名空间分隔符。只挡明显非法的输入（空串、控制字符、路径分隔符）。 */
const TOOL_NAME_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

/** 策略文件：`~/.mcode/engine-tools.json`。 */
export function defaultEngineToolPolicyPath(): string {
  return path.join(homedir(), ".mcode", "engine-tools.json");
}

/** 去重、按名字升序，只留合法名。 */
function normalizeExclude(names: unknown): string[] {
  if (!Array.isArray(names)) return [];
  const seen = new Set<string>();
  for (const n of names) {
    if (typeof n !== "string") continue;
    const t = n.trim();
    if (TOOL_NAME_RE.test(t)) seen.add(t);
  }
  return [...seen].sort();
}

/** 收窄成最小形态：只有非空 exclude 的引擎才留下。`null` = 整份策略为空。 */
function minimizePolicy(policy: EngineToolPolicy): EngineToolPolicy | null {
  const out: EngineToolPolicy = {};
  for (const engine of ENGINE_TOOL_ENGINES) {
    const exclude = normalizeExclude(policy[engine]?.exclude);
    if (exclude.length > 0) out[engine] = { exclude };
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * 从**显式文件路径**读策略（纯核）。任何 IO/解析问题 → 空策略（即哪个引擎都不设限）。
 * 逐引擎丢弃非法条目：exclude 不是数组就当没有；数组里的非法名逐项剔除。
 */
export function readEngineToolPolicyFile(file: string): EngineToolPolicy {
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const out: EngineToolPolicy = {};
  for (const engine of ENGINE_TOOL_ENGINES) {
    const entry = (parsed as Record<string, unknown>)[engine];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const exclude = normalizeExclude((entry as { exclude?: unknown }).exclude);
    if (exclude.length > 0) out[engine] = { exclude };
  }
  return out;
}

/** 读默认路径下的策略。见 {@link readEngineToolPolicyFile}。 */
export function readEngineToolPolicy(): EngineToolPolicy {
  return readEngineToolPolicyFile(defaultEngineToolPolicyPath());
}

/** 原子写（本模块自带的小实现，避免为它去 import `appContext` 拖进 electron）。 */
function atomicWriteJson(file: string, data: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.mcode-tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
  try {
    renameSync(tmp, file);
  } catch {
    // 跨卷 rename 会失败 —— 退回到直接写(与 `appContext.atomicWrite` 同款兜底)。
    writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf-8");
    try {
      renameSync(tmp, file);
    } catch {
      /* 目标已直接写好;残留的 tmp 下次覆盖 */
    }
  }
}

/** 写策略到显式路径（最小形态：只留非空 exclude）。 */
export function writeEngineToolPolicyFile(file: string, policy: EngineToolPolicy): void {
  const minimal = minimizePolicy(policy);
  atomicWriteJson(file, minimal ?? {});
}

/** 写策略到默认路径。 */
export function writeEngineToolPolicy(policy: EngineToolPolicy): void {
  writeEngineToolPolicyFile(defaultEngineToolPolicyPath(), policy);
}

/** 某引擎该禁用的工具名列表（规范、去重、升序）。不设限时返回空数组 ——
 *  调用方据此决定"要不要传 SDK 字段"（空数组 = 不传，保持原生全量）。 */
export function excludedToolsForEngine(policy: EngineToolPolicy, engine: EngineToolEngine): string[] {
  return normalizeExclude(policy[engine]?.exclude);
}

/** 某引擎是否**真的**能按名禁用内置工具。Codex 没有这个入口 —— UI 据此如实告知用户，
 *  不要把"设置了"当成"生效了"。 */
export function engineSupportsToolExclusion(engine: EngineToolEngine): boolean {
  return engine !== "codex";
}
