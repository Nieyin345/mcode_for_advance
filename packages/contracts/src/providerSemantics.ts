/**
 * 【ARC-008】三 SDK 的会话/回调语义矩阵 —— 「谁支持什么、失败是什么码」的**唯一可核对事实**。
 *
 * ## 为什么要有这一份
 *
 * Claude / Pi / Codex 的会话能力(恢复、分叉、插话、审批、子任务停止)与它们的失败
 * 错误码**本来散在三个适配器文件里**。散着写有三类会静默漂移的失败面:
 *
 *   ① 某家引擎的真实行为翻转了(比如某天 Pi 支持了分叉),而没有一处能一眼看出
 *      「三家分别支持什么」—— 只能逐个文件读控制流;
 *   ② 界面按**旧的布尔旗标**放行了一个这家做不到的入口(上一批 ARC 切片就踩过
 *      「能力装出来却没人命中」);
 *   ③ 失败时用户拿到的错误码三家各不相同,却没有任何一处把它们列成一张表,于是
 *      宿主只能各自 catch 字符串。
 *
 * 这份矩阵把三者收成**一份声明**:每个引擎 × 每种能力 → 支持/不支持/降级 + 失败码。
 * 它**不是**第二套执行逻辑 —— 它只描述适配器**已经做到的事**,由
 * `provider-context-smoke` 逐格与三个适配器源码字面对账(漂了就红),并由
 * `capabilityResolver.providerCapabilityDescriptor` 当作**能力清单的唯一权威**消费
 * (见那里:优先读这里,读不到才回退适配器的布尔旗标)。
 *
 * ## 与 {@link ProviderCapabilities} 布尔旗标的关系
 *
 * 布尔旗标是**适配器自报**的一句话(`supportsFork: true`),矩阵是**跨引擎的事实表**
 * (谁支持、失败码是什么)。两者**必须一致** —— 一致性由 smoke 钉着,不是靠人记。
 * 矩阵多出来的是布尔的表达能力之外的东西:`onFailure` 里那些**结构化错误码**,以及
 * `degraded`(做得到但不完整)与 `note`(为什么不支持)。
 */
import type { ProviderCapabilities } from "./provider.js";

/** 一种能力的支持程度。`degraded` = 做得到但不完整(界面须如实呈现,不假装等价)。 */
export type ProviderSemanticsSupport = "supported" | "unsupported" | "degraded";

/** 矩阵里一格:某引擎对某能力的支持程度 + 失败时抛/发的结构化错误码 + 一句话说明。 */
export interface ProviderCapabilitySemantics {
  support: ProviderSemanticsSupport;
  /**
   * 该能力**失败时**会出现的结构化错误码(`ctx.emit({type:"error", code})` 或错误对象的
   * `code` 字段)。空数组 = **没有结构化码**(比如 Pi 的恢复失败是直接 `throw new Error`,
   * 调用方只能读 `message`)—— 这不是遗漏,是「这家确实没给码」这一事实本身。
   */
  onFailure?: string[];
  /** 一句话说明(为什么支持/为什么不支持/降级在哪)。面向维护者与界面文案。 */
  note?: string;
}

/**
 * 矩阵的行 —— 与 `providerCapabilityIds` 产出的细粒度能力 id **同名处必须对齐**
 * (approval/resume/streaming/mcp/askUserQuestion/fork/inject/elicitation/customSubagents),
 * 另加 ARC-008 点名的三项(interrupt/stopTask/onResumeOutcome)。前九项会**投影**成能力
 * 清单 id(见 {@link semanticsCapabilityIds});后三项是「事实」,不投影。
 *
 * 顺序即投影顺序(与 `providerCapabilityIds` 的旗标顺序一致,便于对账)。
 */
export const PROVIDER_SEMANTICS_CAPABILITY_IDS = [
  "approval", // = Claude 的 canUseTool / Pi 的 tool_call 守卫 / Codex 的 requestApproval
  "resume",
  "streaming",
  "mcp",
  "askUserQuestion",
  "fork",
  "inject",
  "elicitation",
  "customSubagents",
  "interrupt", // 收掉整轮
  "stopTask", // 只停一个子任务(子代理)
  "onResumeOutcome", // 【ARC-008】如实报出本轮底层会话来源
] as const;

export type ProviderSemanticsCapabilityId = (typeof PROVIDER_SEMANTICS_CAPABILITY_IDS)[number];

export interface ProviderSemanticsMatrix {
  /** 引擎 id —— 与 `AgentProvider.id` / provider 注册表的键一致。 */
  providerId: string;
  capabilities: Record<ProviderSemanticsCapabilityId, ProviderCapabilitySemantics>;
}

/**
 * 【MC-056】引擎在注册表里取不到时抛出的错误码。
 *
 * 不属于任何单一能力 —— 它是**所有能力共用的前置失败**:`ProviderRegistry.getRequired`
 * 在保存的 id 找不到时抛它,绝不回退默认引擎。列在这里,让「失败码」这套事实有唯一的
 * 收口处(适配器内的码见各格 `onFailure`)。
 */
export const PROVIDER_UNAVAILABLE_CODE = "PROVIDER_UNAVAILABLE";

/**
 * 三家内置引擎的语义矩阵。每一格都由**适配器真实控制流**填出(读
 * `providers/{claude,pi,codex}-sdk/*.ts`),并由 smoke 与源码字面对账。
 *
 * ⚠️ 改这里必须同时改对应适配器,否则 `provider-context-smoke` 的「矩阵 × 源码一致」
 * 断言会红 —— 这正是这份矩阵存在的意义:**防止两边各写各的**。
 */
export const PROVIDER_SEMANTICS: Record<string, ProviderSemanticsMatrix> = {
  "claude-sdk": {
    providerId: "claude-sdk",
    capabilities: {
      approval: { support: "supported", note: "canUseTool 回调(toolName→allow/deny)" },
      resume: {
        support: "supported",
        onFailure: ["SDK_ERROR"],
        note: "SDK resume;恢复失败经 error 事件报 SDK_ERROR,适配器本身只报 RESUMED/FRESH_EXPLICIT",
      },
      streaming: { support: "supported", note: "stream_event 逐 token 增量" },
      mcp: { support: "supported", note: "Options.mcpServers + strictMcpConfig" },
      askUserQuestion: { support: "supported", note: "原生 AskUserQuestion 工具" },
      fork: { support: "supported", note: "SDK forkSession:复制会话文件(撤销快照不复制)" },
      inject: { support: "supported", note: "异步用户消息 channel.push(生成中插话)" },
      elicitation: { support: "supported", note: "MCP elicitation → requestUserInput 弹窗" },
      customSubagents: { support: "supported", note: "Options.agents(AgentDefinition)" },
      interrupt: { support: "supported", note: "ac.abort() 收掉整轮" },
      stopTask: { support: "supported", note: "liveQuery.stopTask(认不出返回 false)" },
      onResumeOutcome: {
        support: "supported",
        note: "init 时报 RESUMED / FRESH_EXPLICIT;恢复失败走 error 而非 FAILED",
      },
    },
  },
  "pi-sdk": {
    providerId: "pi-sdk",
    capabilities: {
      approval: { support: "supported", note: "inline extension 的 tool_call 守卫(非 canUseTool 回调)" },
      resume: {
        support: "supported",
        onFailure: [],
        note: "SessionManager.open;失败**抛错**(无结构化码),拒不开新会话",
      },
      streaming: { support: "supported", note: "subscribe() 事件流" },
      mcp: { support: "unsupported", note: "Pi 用 extension,不挂 MCP 服务器" },
      askUserQuestion: { support: "supported", note: "pi.registerTool 的原生 AskUserQuestion" },
      fork: { support: "unsupported", note: "没有 forkSession" },
      inject: { support: "unsupported", note: "轮内没有插话口" },
      elicitation: { support: "unsupported", note: "无 MCP elicitation 通道" },
      customSubagents: { support: "unsupported", note: "无 AgentDefinition 通道" },
      interrupt: { support: "supported", note: "ac.abort() + session.abort()" },
      stopTask: { support: "unsupported", note: "handle 没有 stopTask" },
      onResumeOutcome: { support: "supported", note: "RESUMED / FAILED / FRESH_EXPLICIT" },
    },
  },
  "codex-sdk": {
    providerId: "codex-sdk",
    capabilities: {
      approval: { support: "supported", note: "server→client requestApproval(非 canUseTool)" },
      resume: {
        support: "supported",
        onFailure: ["CODEX_APP_SERVER_EXITED", "CODEX_SDK_ERROR"],
        note: "thread/resume;拒绝或空 id 报 FAILED",
      },
      streaming: { support: "supported", note: "item/agentMessage/delta" },
      mcp: { support: "supported", note: "config.toml [mcp_servers] 物化" },
      askUserQuestion: { support: "supported", note: "dynamicTools ask_user_question" },
      fork: { support: "unsupported", note: "没有 forkSession" },
      inject: { support: "unsupported", note: "轮内没有插话口" },
      elicitation: { support: "supported", note: "item/tool/requestUserInput 桥接" },
      customSubagents: { support: "unsupported", note: "无 AgentDefinition 通道" },
      interrupt: { support: "supported", note: "ac.abort();回合未起时直接 dispose 本轮进程" },
      stopTask: { support: "unsupported", note: "handle 没有 stopTask" },
      onResumeOutcome: { support: "supported", note: "RESUMED / FAILED / FRESH_EXPLICIT" },
    },
  },
};

/** 矩阵里被认作「能力清单 id」的那几行(与 `providerCapabilityIds` 的旗标同名)。
 *  interrupt / stopTask / onResumeOutcome 是事实,不投影成清单 id。 */
export const SEMANTICS_INVENTORY_CAPABILITY_IDS: ReadonlySet<string> = new Set([
  "approval",
  "resume",
  "streaming",
  "mcp",
  "askUserQuestion",
  "fork",
  "inject",
  "elicitation",
  "customSubagents",
]);

/** 取某引擎的矩阵,取不到返回 `undefined`。 */
export function providerSemanticsOf(providerId: string): ProviderSemanticsMatrix | undefined {
  return PROVIDER_SEMANTICS[providerId];
}

/**
 * **矩阵 → 能力清单 id 的投影** —— 供能力解析把「这台引擎支持什么」喂给 `CapabilityDescriptor`。
 *
 * 只有 `support === "supported"` 的行进清单(`degraded` 不算:它做得到但不完整,放进
 * 清单会让「缺能力」假阳性 —— 到底是能力缺失还是降级,由调用方按语义单独处理)。
 *
 * 返回 `undefined` = **这家引擎没有矩阵条目**(比如第三方自定义引擎)—— 调用方据此
 * 回退到适配器自报的布尔旗标,**不把「没有矩阵」当成「什么都不会」**。
 */
export function semanticsCapabilityIds(providerId: string): string[] | undefined {
  const matrix = PROVIDER_SEMANTICS[providerId];
  if (!matrix) return undefined;
  const ids: string[] = [];
  for (const id of PROVIDER_SEMANTICS_CAPABILITY_IDS) {
    if (!SEMANTICS_INVENTORY_CAPABILITY_IDS.has(id)) continue;
    if (matrix.capabilities[id].support === "supported") ids.push(id);
  }
  return ids;
}

/** 某引擎某能力失败时的结构化错误码(空数组 = 无结构化码)。 */
export function semanticsFailureCodes(
  providerId: string,
  capability: ProviderSemanticsCapabilityId,
): string[] {
  return PROVIDER_SEMANTICS[providerId]?.capabilities[capability].onFailure ?? [];
}

/** 三个内置引擎的 id 清单 —— 与 {@link PROVIDER_SEMANTICS} 的键同源。 */
export const SEMANTICS_PROVIDER_IDS = ["claude-sdk", "pi-sdk", "codex-sdk"] as const;

/** 把矩阵的一格与适配器自报的布尔旗标对账用 —— `undefined` 旗标视为 false。 */
export function matrixAgreesWithFlag(
  matrix: ProviderSemanticsMatrix,
  capability: ProviderSemanticsCapabilityId,
  flag: boolean | undefined,
): boolean {
  const supported = matrix.capabilities[capability].support === "supported";
  return supported === (flag === true);
}

/** 供 smoke 类型检查用:矩阵行覆盖了 `ProviderCapabilities` 里的每一个可选布尔能力。 */
export type _MatrixCoversProviderBooleanCapabilities = keyof Pick<
  ProviderCapabilities,
  | "supportsApproval"
  | "supportsResume"
  | "supportsStreaming"
  | "supportsMcp"
  | "supportsAskUserQuestion"
  | "supportsFork"
  | "supportsInject"
  | "supportsElicitation"
  | "supportsCustomSubagents"
>;
