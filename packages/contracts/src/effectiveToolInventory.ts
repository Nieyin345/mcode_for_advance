/**
 * **EffectiveToolInventory —— 「模型真正会看到的工具」诊断**(MC-100 / MC-101 的第一步)。
 *
 * 台账里两轮复核反复点名的同一步是:「先导出 SDK 真实有效工具名、Schema 字节/token 与
 * 恢复遗留,然后最小化」。这个模块就是那一步的**纯核**:给定一批工具描述符(名字 +
 * 说明 + JSON Schema),算出模型侧真正可见的工具清单、按来源分类、并给出**粗估**的
 * 字符数与 token 数。
 *
 * ## 它是什么,不是什么
 *
 * - **是诊断**:回答「按这套装配输入,模型**会**看到哪些工具、有多大」。它不调任何 SDK、
 *   不读任何 provider 运行态、不改变任何 provider 实际发出去的东西(**只读**——
 *   MC-100/101 要求「不得改变 provider 行为」)。
 * - **不是**最小化本身。真正把工具裁剪下去(按任务筛 ToolProfile)是后续工作;这里只把
 *   「裁剪之前模型看到的是这些」先量化出来,让最小化有可对照的基线。
 * - 保持**纯函数**:只依赖入参,不做 I/O。装配(从哪些生产者取哪些描述符)由主进程那份
 *   `orchestration/effectiveToolInventory.ts` 负责,那里复用各 provider 已有的工具表
 *   (`mcp/*Server.ts` 的 `*McpTools()`、engineBridge 的 `descriptors()`、
 *   Codex `buildDynamicTools`、Pi `registerTool`),**绝不另造一份工具名单**(硬规矩 2)。
 */

/**
 * 工具的**来源**。用于诊断时区分「内置、MCP、动态注入、恢复遗留」四类 ——
 * MC-101 明确要求三引擎结果可解释,所以来源必须是一等字段,不能只给个总数。
 *
 * - `builtin`:**引擎自带**的原生工具(Claude 的 `Bash`/`Read`、Pi 的 `read`/`bash`…),
 *   不由宿主注册。
 * - `mcp:<server>`:经某个 MCP server 暴露的工具(Claude 侧名字形如
 *   `mcp__<server>__<tool>`),`<server>` 是 server 名(如 `mcode-library`)。
 * - `dynamic`:**直接注入**、不走 MCP 的工具(Codex 的 dynamicTools、Pi 的
 *   `registerTool` 扩展工具)。
 * - `resumed-legacy`:**恢复遗留** —— 恢复的线程/会话里**仍然带着**、但本轮已不再
 *   注册的旧工具(典型:Codex 的 dynamicTools 随 rollout 持久化,关掉内建浏览器后
 *   旧线程里 `browser_*` 仍在)。台账点过名:「恢复线程旧工具不能只做派发时拒绝就宣称
 *   已从上下文移除」—— 这类工具在这一格里显式列出,才看得见它们没被移走。
 */
export type EffectiveToolSource = "builtin" | "dynamic" | "resumed-legacy" | `mcp:${string}`;

/** 一个待统计的工具。描述符形状与 engineBridge 的 `EngineToolDescriptor` 一致
 *  (`name` + `description` + `inputSchema`),这样各生产者可以直接喂进来。 */
export interface EffectiveToolInput {
  name: string;
  description?: string;
  /** JSON Schema(`Record<string, unknown>`)。缺席 = 该工具未暴露可统计的 schema。 */
  inputSchema?: unknown;
  source: EffectiveToolSource;
}

export interface EffectiveToolEntry {
  name: string;
  source: EffectiveToolSource;
  /** **JSON Schema 部分**的字符数(`JSON.stringify(inputSchema)` 的长度;无 schema 记 0)。 */
  schemaChars: number;
  /**
   * **整条定义**的字符数 = `name` + `description` + `schemaChars`。
   * 这才是模型侧实际要读进去的体积 —— 名字与说明也占上下文,单算 schema 会低估。
   */
  definitionChars: number;
  /** 粗估 token 数,基准见 {@link CHARS_PER_TOKEN}。 */
  estimatedTokens: number;
}

export interface EffectiveToolSourceSummary {
  count: number;
  schemaChars: number;
  definitionChars: number;
  estimatedTokens: number;
}

export interface EffectiveToolInventory {
  providerId: string;
  /** 按来源聚合(区分内置 / MCP / 动态 / 恢复遗留)—— 每个 `<source>` 一个条目。 */
  bySource: Record<string, EffectiveToolSourceSummary>;
  tools: EffectiveToolEntry[];
  totalSchemaChars: number;
  totalDefinitionChars: number;
  totalEstimatedTokens: number;
  /**
   * 被 `excludeTools` 排除掉的名字(诊断用:证明「被禁的工具确实不在清单里」,
   * 而不是静默消失)。只列**实际命中**过的名字。
   */
  excluded: string[];
  /** 只说事实的注记(如「该引擎原生工具无可枚举清单」)。不参与统计。 */
  notes: string[];
}

/**
 * **估算基准**:每 token 按 {@link CHARS_PER_TOKEN} 个字符折算。
 *
 * 这是**粗估,不是真实分词器** —— 拉丁文本约 4 字符/token 是常见经验值,而 CJK 更接近
 * 1–1.5 字符/token,所以描述里带中文时真实 token 会**更高**。值仅用于①同口径横向比较
 * (哪个引擎/哪个来源更大)、②量级判断。**刻意不编一个精确数字**:要精确得跑真分词器,
 * 那是另一回事(见 remaining)。
 *
 * 单调查性:定义字符数越多,`estimatedTokens` 只增不减(`Math.ceil` 单调),
 * 所以「schema 变大 → token 估计不小于」恒成立(冒烟钉住)。
 */
export const CHARS_PER_TOKEN = 4;

function definitionCharsOf(input: EffectiveToolInput): { schemaChars: number; definitionChars: number } {
  let schemaChars = 0;
  if (input.inputSchema !== undefined) {
    try {
      schemaChars = JSON.stringify(input.inputSchema)?.length ?? 0;
    } catch {
      // 循环引用等无法序列化的 schema:如实记 0,不假装量到了(诊断不静默)。
      schemaChars = 0;
    }
  }
  const definitionChars = input.name.length + (input.description?.length ?? 0) + schemaChars;
  return { schemaChars, definitionChars };
}

/** 单条工具的 token 粗估(见 {@link CHARS_PER_TOKEN})。公开导出,便于调用方单独核算。 */
export function estimateToolTokens(input: EffectiveToolInput): number {
  const { definitionChars } = definitionCharsOf(input);
  return Math.ceil(definitionChars / CHARS_PER_TOKEN);
}

/**
 * 计算有效工具清单。**纯函数**。
 *
 * - `tools` + `resumedLegacyTools` 合并统计;**按名字去重,先到先得** —— 传入顺序里
 *   「本轮真正注册的」排在「恢复遗留的」之前,于是当前注册会覆盖同名的遗留项(不在上下文
 *   里重复计两次)。
 * - `excludeTools` 里的名字被剔除,并记进 `excluded`(只记实际命中的)。
 * - 输出顺序稳定:按 `source` 再按 `name` 排序,保证同一输入两次调用逐字节一致。
 */
export function buildEffectiveToolInventory(input: {
  providerId: string;
  tools: readonly EffectiveToolInput[];
  /** 本轮被禁用(从模型上下文移除)的工具名(引擎工具策略,见 `lib/engineToolPolicy.ts`)。 */
  excludeTools?: readonly string[];
  /** 恢复遗留的工具(见 {@link EffectiveToolSource} 的 `resumed-legacy`)。 */
  resumedLegacyTools?: readonly EffectiveToolInput[];
  /** 额外注记(只说事实)。 */
  notes?: readonly string[];
}): EffectiveToolInventory {
  const exclude = new Set(input.excludeTools ?? []);
  const seen = new Set<string>();
  const entries: EffectiveToolEntry[] = [];
  const excluded: string[] = [];

  const consume = (tool: EffectiveToolInput): void => {
    if (exclude.has(tool.name)) {
      if (!excluded.includes(tool.name)) excluded.push(tool.name);
      return;
    }
    if (seen.has(tool.name)) return; // 先到先得:同名以第一条(当前注册)为准
    seen.add(tool.name);
    const { schemaChars, definitionChars } = definitionCharsOf(tool);
    entries.push({
      name: tool.name,
      source: tool.source,
      schemaChars,
      definitionChars,
      estimatedTokens: Math.ceil(definitionChars / CHARS_PER_TOKEN),
    });
  };

  for (const tool of input.tools) consume(tool);
  for (const tool of input.resumedLegacyTools ?? []) consume(tool);

  entries.sort((a, b) => (a.source === b.source ? a.name.localeCompare(b.name) : a.source.localeCompare(b.source)));

  const bySource: Record<string, EffectiveToolSourceSummary> = {};
  const totals = { schemaChars: 0, definitionChars: 0, estimatedTokens: 0 };
  for (const entry of entries) {
    const bucket = (bySource[entry.source] ??= { count: 0, schemaChars: 0, definitionChars: 0, estimatedTokens: 0 });
    bucket.count += 1;
    bucket.schemaChars += entry.schemaChars;
    bucket.definitionChars += entry.definitionChars;
    bucket.estimatedTokens += entry.estimatedTokens;
    totals.schemaChars += entry.schemaChars;
    totals.definitionChars += entry.definitionChars;
    totals.estimatedTokens += entry.estimatedTokens;
  }

  return {
    providerId: input.providerId,
    bySource,
    tools: entries,
    totalSchemaChars: totals.schemaChars,
    totalDefinitionChars: totals.definitionChars,
    totalEstimatedTokens: totals.estimatedTokens,
    excluded,
    notes: [...(input.notes ?? [])],
  };
}

/** 便捷:把两批工具合并后按名字去重(供装配方在构造 {@link EffectiveToolInput} 列表前用)。 */
export function dedupeToolInputs(tools: readonly EffectiveToolInput[]): EffectiveToolInput[] {
  const seen = new Set<string>();
  const out: EffectiveToolInput[] = [];
  for (const tool of tools) {
    if (seen.has(tool.name)) continue;
    seen.add(tool.name);
    out.push(tool);
  }
  return out;
}
