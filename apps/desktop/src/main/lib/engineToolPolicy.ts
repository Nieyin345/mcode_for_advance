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

/**
 * 【MC-071】读一份策略文件的**三种不同事实** —— 从前它们被压成一个 `{}`,于是
 * 「用户从没设过」和「用户设过、但文件被截断/改坏」长得一模一样,后者会让原本
 * 禁用的工具被**静默重新启用**(fail-open)。
 */
export type EngineToolPolicyStatus = "VALID" | "MISSING" | "INVALID";

export interface EngineToolPolicyRead {
  status: EngineToolPolicyStatus;
  /** 实际应生效的策略。INVALID 时会尽量回退到「最后一份确认过的策略」。 */
  policy: EngineToolPolicy;
  /** INVALID 且成功从 last-good 恢复出非空排除时为 true。 */
  recovered: boolean;
  /** 供 UI 显示的损坏原因(INVALID 时)。 */
  error?: string;
}


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
 *
 * ⚠️ 【MC-071】这是**低层**读法,分不清 MISSING / INVALID;要区分三者(并对损坏配置做
 * 保守恢复)用 {@link readEngineToolPolicyDetailed}。需要"实际生效策略"的调用方也应走那条。
 */
export function readEngineToolPolicyFile(file: string): EngineToolPolicy {
  return readEngineToolPolicyDetailed(file).policy;
}

function parsePolicyText(raw: string): { ok: true; policy: EngineToolPolicy } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `JSON 解析失败:${err instanceof Error ? err.message : String(err)}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "配置不是对象" };
  }
  const out: EngineToolPolicy = {};
  for (const engine of ENGINE_TOOL_ENGINES) {
    const entry = (parsed as Record<string, unknown>)[engine];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const exclude = normalizeExclude((entry as { exclude?: unknown }).exclude);
    if (exclude.length > 0) out[engine] = { exclude };
  }
  return { ok: true, policy: out };
}

/** 与策略文件同目录的「最后一份确认过的策略」备份路径。 */
export function lastGoodEngineToolPolicyPath(file: string): string {
  return `${file}.last-good`;
}

/** 尝试从 last-good 备份读出一份**非空**策略;读不出/为空则 null。 */
function readLastGood(file: string): EngineToolPolicy | null {
  let raw: string;
  try {
    raw = readFileSync(lastGoodEngineToolPolicyPath(file), "utf-8");
  } catch {
    return null;
  }
  const parsed = parsePolicyText(raw);
  if (!parsed.ok) return null;
  return Object.keys(parsed.policy).length > 0 ? parsed.policy : null;
}

/**
 * 【MC-071】读策略并**明确区分** VALID / MISSING / INVALID:
 *   - **MISSING**(文件不存在):全新用户,不设限 —— 保持原生全量,与旧行为一致;
 *   - **VALID**:照常返回;
 *   - **INVALID**(存在但损坏):**不静默 fail-open**。若 last-good 备份里有一份非空策略,
 *     就据它保守恢复(`recovered=true`)—— 一个坏了的文件绝不能把用户原本禁用的工具
 *     静默重新启用;没有备份时按「不设限」但**带 status=INVALID + error** 供 UI 显式告警。
 *
 * 返回的 `policy` 即**实际应生效**的策略,调用方(各 Provider / IPC 快照)都用它。
 */
export function readEngineToolPolicyDetailed(file: string): EngineToolPolicyRead {
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { status: "MISSING", policy: {}, recovered: false };
    // 存在但读不出来(权限等)= 与损坏等价:不能当成"用户没设过"。
    const recovered = readLastGood(file);
    return {
      status: "INVALID",
      policy: recovered ?? {},
      recovered: recovered !== null,
      error: `策略文件不可读:${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const parsed = parsePolicyText(raw);
  if (parsed.ok) return { status: "VALID", policy: parsed.policy, recovered: false };
  const recovered = readLastGood(file);
  return {
    status: "INVALID",
    policy: recovered ?? {},
    recovered: recovered !== null,
    error: parsed.error,
  };
}

/** 读默认路径下的策略(实际生效值,含损坏恢复)。见 {@link readEngineToolPolicyDetailed}。 */
export function readEngineToolPolicy(): EngineToolPolicy {
  return readEngineToolPolicyDetailed(defaultEngineToolPolicyPath()).policy;
}

/** 读默认路径下的策略**并带状态** —— 供需要展示「配置损坏/实际生效状态」的调用方。 */
export function readEngineToolPolicyStatus(): EngineToolPolicyRead {
  return readEngineToolPolicyDetailed(defaultEngineToolPolicyPath());
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
  // 【MC-071】每次成功写入后刷新「最后一份确认过的策略」备份 —— 主文件日后被截断/改坏时,
  // 据它保守恢复,而不是 fail-open。只备份**非空**策略(全启用不需要备份)。
  if (minimal) atomicWriteJson(lastGoodEngineToolPolicyPath(file), minimal);
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
