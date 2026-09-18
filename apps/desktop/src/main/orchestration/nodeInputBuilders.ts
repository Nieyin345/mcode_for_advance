import type { NodeRunInput, WorkflowChoiceOption, WorkflowDataContext } from "@contracts/runtime";
import { MEMORY_PARAM_KEY } from "@contracts/memory";
import { memorySnapshotFor } from "../memory/retrieval.js";
import { expandTriggerVars, triggerVarCandidates } from "./triggerVars.js";
import {
  DEFAULT_DECIDER_INSTRUCTION,
  NODE_CODE_INPUT_KEY,
  NODE_CODE_LANGUAGE_KEY,
  NODE_CODE_PARAM_KEY,
  NODE_CODE_TIMEOUT_KEY,
  NODE_PROMPT_PARAM_KEY,
  commandOf,
  commandTimeoutOf,
  contextKindsOf,
  isModelDecider,
  mcpServerNamesOf,
  pluginNamesOf,
  providerIdOf,
  returnModeOf,
  skillNamesOf,
  type NodeArtifact,
  type NodeContextKind,
  type NodeTypeManifest,
} from "@contracts/nodeType";
import {
  NODE_OUTPUT_CONTRACT_KEY,
  describeOutputVars,
  outputVarsFor,
} from "@contracts/outputConstraint";
import { composeNodePrompt, decisionSection, type Arrival, type WorkflowPlan } from "./schedulerPrompt.js";
import type { ContextLine } from "./contextInherit.js";

/**
 * 调度器实际派发的那一份输入 = 稳定契约(`NodeRunInput`)+ 宿主侧的中止信号。
 * `signal` 是 host-only 的,不进 contracts(见 `@contracts/runtime` 的文件头)。
 */
export type RunnableNodeInput = NodeRunInput & { signal: AbortSignal };

/* ────────────────────────── 专用 builder(seam)────────────────────────── */

export interface NodeInputBuildContext {
  params: Record<string, unknown>;
  manifest: NodeTypeManifest;
  base: NodeRunInput;
}

export interface NodeInputBuilder {
  readonly kind: string;
  build(context: NodeInputBuildContext): NodeRunInput;
}

/**
 * 按 `runner.kind` 注册的**专用输入 builder**。
 *
 * 这是输入构造的扩展缝:一个新节点类型若不需要"提示词那一套"(模型轮),在这里注册
 * 一个 builder 就够了 —— 调度器与 {@link buildNodeInput} 都不用再加 `kind` 分支。
 * 没有专用 builder 的 kind 一律落进默认的模型轮构造(见下),那是"子代理跑一轮"的
 * 通用形状。
 */
export class NodeInputBuilderRegistry {
  private readonly builders = new Map<string, NodeInputBuilder>();

  register(builder: NodeInputBuilder): this {
    if (this.builders.has(builder.kind)) {
      throw new Error(`Node input builder already registered: ${builder.kind}`);
    }
    this.builders.set(builder.kind, builder);
    return this;
  }

  get(kind: string): NodeInputBuilder | undefined {
    return this.builders.get(kind);
  }
}

function codeInputOf(params: Record<string, unknown>, base: NodeRunInput): NodeRunInput {
  const raw = params[NODE_CODE_INPUT_KEY];
  let input: unknown = raw;
  if (typeof raw === "string" && raw.trim()) {
    try {
      input = JSON.parse(raw);
    } catch {
      input = raw;
    }
  } else {
    input = base.data;
  }
  const code = typeof params[NODE_CODE_PARAM_KEY] === "string" ? params[NODE_CODE_PARAM_KEY] : "";
  const rawLanguage = params[NODE_CODE_LANGUAGE_KEY];
  const language = rawLanguage === "node" || rawLanguage === "shell" || rawLanguage === "powershell"
    ? rawLanguage
    : "python";
  const timeoutMs = typeof params[NODE_CODE_TIMEOUT_KEY] === "number" ? params[NODE_CODE_TIMEOUT_KEY] : 0;
  return { ...base, prompt: "", skills: [], mcpServerNames: [], pluginNames: [], returnMode: "none", code: { code, language, input, timeoutMs } };
}

const codeInputBuilder: NodeInputBuilder = {
  kind: "code",
  build: ({ params, base }) => codeInputOf(params, base),
};

const commandInputBuilder: NodeInputBuilder = {
  kind: "command",
  build: ({ params, base }) => ({
    ...base,
    prompt: "",
    skills: [],
    mcpServerNames: [],
    pluginNames: [],
    returnMode: "none",
    command: {
      command: commandOf(params),
      timeoutMs: commandTimeoutOf(params),
      ...(base.data.upstreamText.trim() || base.data.upstreamArtifacts.length > 0 || Object.keys(base.data.upstreamOutputs).length > 0
        ? { input: base.data }
        : {}),
    },
  }),
};

export const nodeInputBuilderRegistry = new NodeInputBuilderRegistry()
  .register(codeInputBuilder)
  .register(commandInputBuilder);

/* ────────────────────────── 默认 builder(模型轮)────────────────────────── */

/**
 * 默认(模型轮)输入构造需要的**运行期上下文** —— 专用 builder 不用它(它们只认
 * `params` 与 `base`),只有"子代理跑一轮"这条默认路要:提示词怎么拼、它是不是最后
 * 一步、它从哪条出路来、它要不要读整条流程的记录。
 *
 * 这些值由调度器在**派发那一刻**现算(上游的结局、用户的选择都是刚定下来的),这里
 * 只负责"参数 + 上下文 → `NodeRunInput`"这最后一次翻译。
 */
export interface ModelInputScope {
  userPrompt: string;
  upstream: string;
  upstreamArtifacts: NodeArtifact[];
  upstreamOutputs: Record<string, Record<string, unknown>>;
  /** 这一步是谁 / 整条流程长什么样 —— 「整条流程」那一节的内容。 */
  nodeId: string;
  plan: WorkflowPlan;
  /** 这一步有没有下游。没有的话没人取它的产出变量。 */
  terminal: boolean;
  /** 它是从哪条出路来的(上游有分支节点时才有)。 */
  arrival?: Arrival;
  /** 整条流程的记录(已渲染成整段)。只有开了那个开关的节点才有。 */
  record?: string;
  /** 「运行前先问我」那一次的回答,已渲染成整段。 */
  ask?: string;
  /** **只有决策节点给**:它有哪几条出路(同它的出边)。提示词与结果比对必须同一份名单。 */
  decide?: { options: WorkflowChoiceOption[] };
  contextLines: (kinds: NodeContextKind[]) => ContextLine[];
  /**
   * **这次运行是哪个触发器起的,以及那份载荷的平面事实**(见 `automationPayload.ts` 的
   * `TriggerPayloadFacts`,keys 通常为 `kind` / `at` / `files` / `event` / `toolName` /
   * `subjects`)。由调度层在派发那一刻递进来。
   *
   * 存在时两件事发生(见下):参数里的 `{{trigger.<key>}}` 在这里展开(见
   * {@link expandTriggerVars}),载荷原样放进 `NodeRunInput.data.trigger`(见
   * {@link buildNodeInput})。不给 = 这次运行不是触发器起的 —— 参数里再出现
   * `{{trigger.*}}` 就是明确的失败,而不是解出一个空。
   */
  trigger?: Record<string, unknown>;
}

/** 一个字符串参数的当前值(没有就是空串)。 */
function stringParamOf(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  return typeof value === "string" ? value : "";
}

/* ────────────────────────── 触发器变量(memory / VAR-06)────────────────────────── */

/**
 * `{{trigger.*}}` 的词法、候选名单与展开器住在 `./triggerVars.ts` —— **零依赖叶子模块**
 * (见那边的文件头:scheduler 直接 import 它,不能经由本文件把 memory/electron 拖进
 * 冒烟打包图)。这里 import + re-export:`buildNodeInput` 用 `expandTriggerVars` 做
 * 第二遍兜底展开,老的外部引用(冒烟/渲染端候选)也继续从本模块拿,路径不变。
 */
export { expandTriggerVars, triggerVarCandidates };

/* ────────────────────────── 记忆注入(MEM-02)────────────────────────── */

/**
 * 「记忆」开关有没有打开。params 是**字符串记录**(界面开关存的就是字符串),开是
 * `"on"` / `"true"`;布尔 `true` 也认 —— AI 代填参数时偶尔会写真布尔。
 */
function memoryEnabled(params: Record<string, unknown>): boolean {
  const value = params[MEMORY_PARAM_KEY];
  return value === true || value === "on" || value === "true";
}

/**
 * 记忆快照 → 拼进提示词的那一节。没开、库是空的都返回**空串** —— 空库不该凭空多一个
 * 只有标题的段落;读不出来(磁盘坏了/权限没了)也当没有 —— 记忆是**辅助**,它坏不能
 * 把这一步拖垮,正文照常跑。
 */
function memorySectionOf(params: Record<string, unknown>): string {
  if (!memoryEnabled(params)) return "";
  try {
    const snapshot = memorySnapshotFor();
    if (snapshot.trim().length === 0) return "";
    return [
      "## 长期记忆",
      "以下是记忆库中的既有记录,与本步相关时可参考;与指令冲突时,以指令为准:",
      "",
      snapshot,
    ].join("\n");
  } catch {
    return "";
  }
}

/**
 * 一个 `runner.kind === "prompt"` 的节点,这一轮要执行的指令从哪个参数来。
 *
 * 约定是 `instruction` 这个键(见 `@contracts/nodeType` 的 `NODE_PROMPT_PARAM_KEY`)。
 * **拿不到就明确失败** —— 一个提示词节点没有提示词,跑它没有意义,而"跑了个空的"
 * 比"报错说清楚"难查一百倍。
 *
 * (内置的 `mcode.agent` 把 `instruction` 声明成必填,所以正常路径下
 * `validateNodeParams` 会先一步拦下;这里兜的是"清单没把它标成必填"的那种清单。)
 */
function instructionOf(params: Record<string, unknown>, manifest: NodeTypeManifest): string {
  const value = params[NODE_PROMPT_PARAM_KEY];
  if (typeof value === "string" && value.trim().length > 0) return value;
  throw new Error(
    `节点类型「${manifest.id}」没有填「${NODE_PROMPT_PARAM_KEY}」参数 —— 提示词节点必须有指令`,
  );
}

/**
 * 把一个节点翻译成执行器要的输入。**"节点参数 → 这一轮怎么跑"只在这里发生一次**
 * (见 `NodeRunInput`)。
 *
 * `params` 是**已经解算过变量**的那一份(由调度器解)。之所以在调用方解、不在这里解:
 * 产出回来之后还要按同一份参数查硬约束(`withOutputCheck`),两处必须是**同一份值**,
 * 各解一次迟早分家。
 *
 * 分派顺序:**专用 builder 优先**,没有才落默认的模型轮 —— 新增一种"不走模型"的
 * 节点 = 在上面注册一个 builder,这里与调度器都不用改一行。
 */
export function buildNodeInput(
  params: Record<string, unknown>,
  manifest: NodeTypeManifest,
  scope: ModelInputScope,
  signal: AbortSignal,
): RunnableNodeInput {
  // **触发器变量先解**。解算必须发生在任何参数消费之前 —— 技能名、上下文类目、产出
  // 约束都可能写在 `{{trigger.*}}` 里,而"哪些参数是解过的"如果有两种答案,迟早分家
  // (同 `scheduler.expandParams` 那句话,那是上游变量的同一条规矩)。
  // `scope.trigger` 不健康(不是对象)就当没有 —— 载荷来自后台执行器,坏一份不该拖垮派发。
  const trigger =
    scope.trigger !== null && typeof scope.trigger === "object" && !Array.isArray(scope.trigger)
      ? (scope.trigger as Record<string, unknown>)
      : undefined;
  const expanded = expandTriggerVars(params, trigger);
  const skills = skillNamesOf(expanded);
  const mcpServerNames = mcpServerNamesOf(expanded);
  const pluginNames = pluginNamesOf(expanded);
  const providerId = providerIdOf(expanded);
  const returnMode = returnModeOf(expanded);
  const context = scope.contextLines(contextKindsOf(expanded));
  /**
   * 触发器载荷原样进 `data`。本地交叉类型而不是直接改 `WorkflowDataContext`:载荷字段
   * 落在 runtime 契约那边的归属(R 侧),这里先按「多带一个键」的形状给 —— 契约补上
   * `trigger?` 字段后,这一行一个字都不用改。
   */
  type DataWithTrigger = WorkflowDataContext & { trigger?: Record<string, unknown> };
  const data: DataWithTrigger = {
    userInput: scope.userPrompt,
    upstreamText: scope.upstream,
    upstreamOutputs: scope.upstreamOutputs,
    upstreamArtifacts: scope.upstreamArtifacts,
    ...(trigger !== undefined ? { trigger } : {}),
  };
  const base: NodeRunInput = {
    prompt: "",
    data,
    skills,
    mcpServerNames,
    pluginNames,
    returnMode,
    ...(providerId !== undefined ? { providerId } : {}),
  };

  const specializedBuilder = nodeInputBuilderRegistry.get(manifest.runner.kind);
  if (specializedBuilder) {
    return { ...specializedBuilder.build({ params: expanded, manifest, base }), signal };
  }

  // **决策节点的「出路」是从这儿进变量表的**(见 `outputVarsFor`)。不给 options 的话
  // 它不追加 —— 一条出边都没有的图,那一步该失败在"没有出路"上,而不是逼它交一个
  // 交不出来的值。
  const vars = outputVarsFor(
    manifest,
    expanded,
    (scope.decide?.options ?? []).map((o) => o.label),
  );
  // **「选路判据」留空的模型选分支是合法的** —— 兜底用缺省文案(见
  // `DEFAULT_DECIDER_INSTRUCTION`)。其他节点留空指令仍然是错误,`instructionOf` 会抛。
  const instructionRaw = expanded[NODE_PROMPT_PARAM_KEY];
  const instruction =
    typeof instructionRaw === "string" && instructionRaw.trim().length > 0
      ? instructionRaw
      : isModelDecider(manifest, expanded)
        ? DEFAULT_DECIDER_INSTRUCTION
        : instructionOf(expanded, manifest);
  // **记忆注入(MEM-02)**:开关开了才取快照,库空/读不动都安静地不出现这一节。
  // 拼装方式与 context 一致 —— 一节 `##` 标题 + 正文,追加在整个提示词末尾
  // (背景材料在读顺序的最后,不挤占"指令/产出要求"之间的既有顺序)。
  const memorySection = memorySectionOf(expanded);
  const prompt = composeNodePrompt({
    userPrompt: scope.userPrompt,
    upstream: scope.upstream,
    instruction,
    nodeId: scope.nodeId,
    plan: scope.plan,
    skills,
    context,
    ...(scope.arrival ? { arrival: scope.arrival } : {}),
    ...(scope.record ? { record: scope.record } : {}),
    ...(scope.ask ? { ask: scope.ask } : {}),
    ...(scope.decide ? { decision: decisionSection(scope.decide.options) } : {}),
    outputContract: stringParamOf(expanded, NODE_OUTPUT_CONTRACT_KEY),
    // **终末节点不发变量表**(调度器那边的 `withOutputCheck` 同一条规矩的另一端)。
    outputVars: scope.terminal ? "" : describeOutputVars(vars),
  });
  return {
    prompt: memorySection.length > 0 ? `${prompt}\n\n${memorySection}` : prompt,
    data,
    skills,
    mcpServerNames,
    pluginNames,
    returnMode,
    ...(providerId !== undefined ? { providerId } : {}),
    signal,
  };
}
