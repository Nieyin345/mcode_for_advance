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
 * - **缺省 = 不禁用**：没有引擎键、或 exclude 是**合法空数组**，都表示该引擎不设限
 *   （保持原生全量）。"没设过"与"明确全启用"都合法且各有其事实（见 MC-071）。
 * - 只持久化**非空**的 exclude；空条目直接删掉，文件里只留用户真实的限制。
 * - 读文件用**严格版本化 Schema**（MC-042）：顶层对象、引擎键闭集、exclude 必须是
 *   合法工具名的字符串数组。坏 JSON / 形状不对 / 非法条目一律判 INVALID ——
 *   **绝不**静默过滤后仍判 VALID（把"想禁用 Bash"读成"不禁用"正是 fail-open）。
 *   INVALID 的处理见 {@link readEngineToolPolicyDetailed}：有 last-good 按恢复值
 *   继续；无备份时执行路径拒绝本轮（{@link resolveEngineExcludedToolsForProvider}）。
 *
 * ## 纯核
 *
 * 不 import electron / db / 任何主进程目录。自带一个小的原子写，避免为 `atomicWrite`
 * 去 import `appContext`（那条链会拖进 electron，无头 smoke 就进不来了）。
 * 文件路径只从 `defaultEngineToolPolicyPath()`（只用 `os.homedir`）来。
 */
import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
  /** INVALID 且成功从 last-good 备份恢复时为 true（备份可以是空策略 = 用户明确全启用，见 MC-071 残余 E1）。 */
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
 * 从**显式文件路径**读策略（纯核）—— 返回**实际应生效的值**（INVALID 时含 last-good
 * 恢复；无恢复时按空策略，即"不设限"的兜底**值**，但那不是把它判成 VALID）。
 *
 * ⚠️ 【MC-071/MC-042】这是**低层**读法，分不清 MISSING / INVALID；要区分三者（并对损坏
 * 配置做保守恢复与显式告警）用 {@link readEngineToolPolicyDetailed}；**执行路径**用
 * {@link resolveEngineExcludedToolsForProviderFile}（它在 INVALID 且无恢复时**拒绝执行**）。
 * 【MC-042】解析用严格 Schema（{@link validateEngineToolPolicy}）：错形（`exclude` 非数组、
 * 引擎表非对象、数组内坏项、未知键、缺 `exclude` 字段）**不再**被静默过滤成空后仍判 VALID。
 */
export function readEngineToolPolicyFile(file: string): EngineToolPolicy {
  return readEngineToolPolicyDetailed(file).policy;
}

/** 给诊断用的 JSON 值类型描述 —— 只报类型（数组 / null / string / …），不把文件内容
 *  抄进错误消息与 UI。 */
function describeJsonValue(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "数组";
  return typeof v;
}

/**
 * 【MC-042】策略文件的**唯一一份严格 Schema** —— 读判别、last-good 恢复、写回自检共用
 * 它（同一份判据，不各写一套）。
 *
 * 为什么必须严格：这份文件表达的是**限制**。「`exclude` 不是数组就当没有」之类的容错
 * 过滤会把「用户想禁用 Bash」静默读成「不禁用」—— fail-open，而且因为顶层仍判成功，
 * last-good 恢复、`POLICY_RECOVERY_REQUIRED` 拒绝、UI 告警三条防线全部被绕过。
 * 所以对每一类错形（引擎表非对象 / `exclude` 非数组 / 数组含非字符串或非法名 / 未知键 /
 * 缺 `exclude` 字段）一律返回 `ok:false` + 可读诊断，**绝不**先过滤再判成功。
 *
 * 合法的三种形态（与读三态配套，见 {@link readEngineToolPolicyDetailed}）：
 *   - 引擎键缺席         = 该引擎没配置过（不设限）；
 *   - `"exclude": []`    = 明确配置空排除（不设限，但同样合法、不误伤）；
 *   - `"exclude": [名…]` = 受限。合法名的去重/排序仍照做（集合语义不变，不丢限制）。
 */
export function validateEngineToolPolicy(
  parsed: unknown,
): { ok: true; policy: EngineToolPolicy } | { ok: false; error: string } {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "配置顶层必须是一个对象" };
  }
  const record = parsed as Record<string, unknown>;
  // 引擎键**闭集**。写错键名（如 `"claud"`）若被忽略，用户以为设了限制、实际什么都没设
  // —— 与「坏 exclude 被读成空」是同一族 fail-open，故一并判 INVALID。
  const unknownKeys = Object.keys(record).filter((k) => !(ENGINE_TOOL_ENGINES as readonly string[]).includes(k));
  if (unknownKeys.length > 0) {
    return { ok: false, error: `出现未知的引擎键:${unknownKeys.join("、")}(只支持 ${ENGINE_TOOL_ENGINES.join(" / ")})` };
  }
  const out: EngineToolPolicy = {};
  for (const engine of ENGINE_TOOL_ENGINES) {
    if (!(engine in record)) continue;
    const entry = record[engine];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { ok: false, error: `${engine} 的配置必须是一个对象(实际:${describeJsonValue(entry)})` };
    }
    const extraKeys = Object.keys(entry).filter((k) => k !== "exclude");
    if (extraKeys.length > 0) {
      return { ok: false, error: `${engine} 出现未知字段:${extraKeys.join("、")}(只支持 exclude)` };
    }
    if (!("exclude" in entry)) {
      return { ok: false, error: `${engine} 缺少 exclude 数组(没设置过就别写这个引擎键;明确全启用写 "exclude": [])` };
    }
    const rawExclude = (entry as { exclude: unknown }).exclude;
    if (!Array.isArray(rawExclude)) {
      return { ok: false, error: `${engine}.exclude 必须是字符串数组(实际:${describeJsonValue(rawExclude)})` };
    }
    // 先**逐项**校验（错在哪一项要点名报出）。全项通过后才用唯一的归一化实现
    // `normalizeExclude` 收集 —— 不另抄一份去重/排序规则（硬规矩 2）。
    for (let i = 0; i < rawExclude.length; i += 1) {
      const item = rawExclude[i];
      if (typeof item !== "string") {
        return { ok: false, error: `${engine}.exclude[${i}] 不是字符串(实际:${describeJsonValue(item)})` };
      }
      if (!TOOL_NAME_RE.test(item.trim())) {
        return { ok: false, error: `${engine}.exclude[${i}] 不是合法的工具名:${JSON.stringify(item)}` };
      }
    }
    const exclude = normalizeExclude(rawExclude);
    if (exclude.length > 0) out[engine] = { exclude };
  }
  return { ok: true, policy: out };
}

/** JSON 文本 → 严格 Schema。读路径的唯一入口（解析与判别合一）。 */
function parsePolicyText(raw: string): { ok: true; policy: EngineToolPolicy } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `JSON 解析失败:${err instanceof Error ? err.message : String(err)}` };
  }
  return validateEngineToolPolicy(parsed);
}

/** 与策略文件同目录的「最后一份确认过的策略」备份路径。 */
export function lastGoodEngineToolPolicyPath(file: string): string {
  return `${file}.last-good`;
}

/**
 * 【MC-071 残余 E1】从 last-good 备份读出一份**有效**策略 —— 含**空策略**(用户明确把
 * 某引擎全部启用也是「最近一次成功配置」的一种)。返回:
 *   - `null`:备份不存在或读不出/解析失败(=真的没有可恢复的);
 *   - `{ policy }`:备份合法,`policy` 可为 `{}`(上次提交就是全启用)。
 *
 * ⚠️ 从前这里只在**非空**时返回,于是「用户明确全开 → 主文件又损坏」会从更旧的**非空**
 * 备份错误恢复出早已被用户放开的旧限制。现在空配置也算有效的 last-good。
 */
function readLastGood(file: string): { policy: EngineToolPolicy } | null {
  let raw: string;
  try {
    raw = readFileSync(lastGoodEngineToolPolicyPath(file), "utf-8");
  } catch {
    return null;
  }
  const parsed = parsePolicyText(raw);
  if (!parsed.ok) return null;
  return { policy: parsed.policy };
}

/**
 * 【MC-071】读策略并**明确区分** VALID / MISSING / INVALID:
 *   - **MISSING**(文件不存在):全新用户,不设限 —— 保持原生全量,与旧行为一致;
 *   - **VALID**:照常返回;
 *   - **INVALID**(存在但损坏):**不静默 fail-open**。若 last-good 备份里有一份**有效**
 *     策略(含"用户明确全启用"那份空策略),就据它保守恢复(`recovered=true`)—— 一个坏了的
 *     文件绝不能把用户原本禁用的工具静默重新启用,也不能恢复到**比最后一次提交更旧**的配置;
 *     没有备份时按「不设限」但**带 status=INVALID + error** 供 UI 显式告警。
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
      policy: recovered ? recovered.policy : {},
      recovered: recovered !== null,
      error: `策略文件不可读:${err instanceof Error ? err.message : String(err)}`,
    };
  }
  // 【MC-071 残余 E1】空文件(0 字节 / 纯空白) = 「从没写过配置的首次启动」,按 MISSING
  // 处理(不设限),而不是当成损坏 —— 一个刚开始用的用户其空文件被 `JSON.parse` 判坏、又
  // 在 Provider 侧被当成 INVALID 拒绝执行,会把正常首次启动也一并挡死。但若**存在**可信
  // last-good,则空文件更可能是主配置被**截断**(用户曾在应用里设过限制),按损坏走恢复,
  // 绝不把原本禁用的工具重新启用。区分「从没设过」与「曾设过又被截空」。
  if (raw.trim() === "") {
    const recoveredEmpty = readLastGood(file);
    if (!recoveredEmpty) return { status: "MISSING", policy: {}, recovered: false };
    return {
      status: "INVALID",
      policy: recoveredEmpty.policy,
      recovered: true,
      error: "策略文件为空(疑被截断),已从 last-good 恢复",
    };
  }
  const parsed = parsePolicyText(raw);
  if (parsed.ok) return { status: "VALID", policy: parsed.policy, recovered: false };
  const recovered = readLastGood(file);
  return {
    status: "INVALID",
    policy: recovered ? recovered.policy : {},
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

/**
 * 【MC-071 残余 E1】「读策略状态」与「执行授权」**同源**的入口 —— Provider 在**实际绑定
 * 工具之前**走这条,而不是各自 `excludedToolsForEngine(readEngineToolPolicy(), engine)`。
 *
 * 为什么不能只用 {@link readEngineToolPolicy}:那条把 INVALID(存在但损坏)**压成**策略值,
 * 「用户从没设过(不设限)」与「读不出来(拿不到原禁用)」长得一模一样。于是一个**没有
 * last-good 备份**的旧版/迁移用户,主文件一损坏就退化成**空排除表** —— 原本被用户禁用的
 * Bash/Edit 被**静默重新启用**(fail-open,与 MC-083 预算是同一类费用/风险边界)。
 *
 * 取舍(与 MC-083 同一取舍):INVALID 且**无可信备份**时,不返回空排除表,而是**抛错拒绝
 * 本轮自动执行**并给出可操作的人话;有 last-good 时按恢复值继续(不回归)。MISSING(从没
 * 设过)与 VALID 照常不设限 / 照常生效。抛出的错误带 `POLICY_RECOVERY_REQUIRED` 标记,
 * 供上层识别为「需要用户明确恢复/确认」。
 */
export function resolveEngineExcludedToolsForProvider(engine: EngineToolEngine): string[] {
  return resolveEngineExcludedToolsForProviderFile(defaultEngineToolPolicyPath(), engine);
}

/**
 * {@link resolveEngineExcludedToolsForProvider} 的显式路径版 —— 供回归套件用隔离临时文件
 * 直接驱动**同一套判定**(不碰真实 `~/.mcode`)。生产调用走上面那条(默认路径)。
 */
export function resolveEngineExcludedToolsForProviderFile(file: string, engine: EngineToolEngine): string[] {
  const read = readEngineToolPolicyDetailed(file);
  if (read.status === "INVALID" && !read.recovered) {
    throw new Error(
      `POLICY_RECOVERY_REQUIRED:工具禁用配置损坏且无备份,已拒绝执行以免把原本禁用的工具重新启用` +
        `(${engine},${read.error ?? "配置无效"})。请在 设置 → 引擎工具 里重新确认禁用列表。`,
    );
  }
  return excludedToolsForEngine(read.policy, engine);
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

/**
 * 【MC-042】覆写前保全：当前文件**读不懂**（JSON 坏 / 形状错）时，先把原始字节备份成
 * `<文件>.corrupt-<时间戳>.bak` 再写 —— 与 `hooks.json` 的「备份并重建」同一条纪律：
 * 显式保存可以把配置修好，但**绝不静默销毁**读不懂的原始字节（那份字节里很可能就是
 * 用户手写的、本应用解析不了但人可以读回来的限制）。备份不成功就拒绝写入。
 *
 * 正常文件（VALID）与空文件（没有可保全的字节）直接放行；不存在/读不出来的情况把
 * 写入错误交给 {@link atomicWriteJson} 照常报出。
 */
function preserveCorruptOriginalBeforeOverwrite(file: string): void {
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch {
    return; // 不存在或读不出：没有可保全的成功读取的字节。
  }
  if (raw.trim() === "") return; // 空文件：没有内容可保全(空文件若因 last-good 判 INVALID,其"内容"也为空)。
  if (parsePolicyText(raw).ok) return; // 当前是 VALID：正常覆写，不堆备份垃圾。
  const backupPath = `${file}.corrupt-${Date.now()}.bak`;
  try {
    copyFileSync(file, backupPath);
  } catch (err) {
    throw new Error(
      `工具禁用配置已损坏,且无法把原始字节备份到 ${backupPath}:${err instanceof Error ? err.message : String(err)}` +
        ` —— 已拒绝覆盖,以免静默销毁读不懂的原始内容。`,
    );
  }
}

/** 写策略到显式路径（最小形态：只留非空 exclude）。 */
export function writeEngineToolPolicyFile(file: string, policy: EngineToolPolicy): void {
  const minimal = minimizePolicy(policy);
  const value = minimal ?? {};
  // 【MC-042】写前自检：**同一份严格 Schema** 也判写侧 —— 写不出一份读得懂的文件
  // （例如将来 minimizePolicy 变更引入未知形状），宁可当场抛错，也不让盘上出现
  // 一份"写成功、读却是 INVALID"的静默漂移。
  const check = validateEngineToolPolicy(value);
  if (!check.ok) throw new Error(`拒绝写入读不懂的工具禁用策略:${check.error}`);
  // 【MC-042】覆写前保全损坏原件（见上）。用户从设置页显式保存是既定恢复路径
  // （POLICY_RECOVERY_REQUIRED 的拒绝语就指向它），保存允许、但原始字节先备份。
  preserveCorruptOriginalBeforeOverwrite(file);
  atomicWriteJson(file, value);
  // 【MC-071 / 残余 E1】每次成功写入后刷新「最后一份确认过的策略」备份 —— **包括用户明确
  // 全启用(空策略)那一次**。从前只在 `minimal` 非空时刷新,于是「先有限制 → 用户明确全开
  // → 主文件又损坏」会从更旧的**非空**备份错误恢复出用户早已放开的旧限制。空配置也是
  // 一次合法提交,必须成为新的 last-good。
  atomicWriteJson(lastGoodEngineToolPolicyPath(file), value);
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
