import type { NodeRunInput, WorkflowChoiceOption, WorkflowDataContext } from "@contracts/runtime";
import type { WorkflowCapability } from "@contracts/workflow";
import { MEMORY_PARAM_KEY, memorySectionFrom, isMemoryInjectionEnabled, type MemoryInjectionSection } from "@contracts/memory";
import { expandTriggerVars } from "./triggerVars.js";
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
  showsNodeCapability,
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

/**
 * 只读节点（`capability: "read"` → `plan` 权限模式）在提示词里明说的那一句（报告 P3）。
 *
 * 这些节点上任何写类工具都会弹审批 —— 这不只是"多一步确认"：模型如果事先不知道，
 * 很可能**正确判断"该写库"却一头撞上 plan 模式被拒**，退回只读，表象成了"判断对了
 * 却做不了"。把它摆到提示词前面，让模型一开始就按"我只能读"来规划，
 * 该产出「建议怎么做」而不是「动手去做」。
 */
const READ_ONLY_PERMISSION_NOTE =
  "## 这一步的权限\n你这一步是**只读**的：写文件、执行命令这类动作会被拦下要求审批。" +
  "请只做读取与判断，把「建议怎么做」写进产出，不要试图直接改动任何东西。";

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
  build: ({ params, base, manifest }) => ({
    ...base,
    prompt: "",
    skills: [],
    mcpServerNames: [],
    pluginNames: [],
    returnMode: "none",
    command: {
      command: commandOf(params),
      timeoutMs: commandTimeoutOf(params),
      // **`bind` 的值在这里过一手。** 变量展开只发生在调度器交进来的 `params` 上,
      // 而执行器(以及它拼的 argv/env/stdin)读不到那份 —— 把解算后的绑定值随
      // `NodeRunInput` 递过去,执行器才不必回头读存盘原值(那上面还是 `{{...}}` 模板)。
      // 只收**清单真的声明了 bind 的**参数:一张未声明的键混进 argv 等于凭空多一个参数。
      ...boundParamsOf(params, manifest),
      ...(base.data.userInput.trim() || "trigger" in base.data || base.data.upstreamText.trim() || base.data.upstreamArtifacts.length > 0 || Object.keys(base.data.upstreamOutputs).length > 0
        ? { input: base.data }
        : {}),
    },
  }),
};

/** 清单里声明了 `bind` 的参数,取它们**解算后**的值(键 = 参数 key)。
 *
 * **空值按"没填"处理,不送** —— 与 `validateNodeParams` 同一口径(`undefined` /
 * `null` / `""` 都是没填)。否则一个被清空的**可选**文本参数会变成 `--flag ""`,
 * 脚本分不清"用户留空"和"用户没写",而后者才是缺席的语义。`false` / `0` 是**填了**,
 * 照常送。 */
function boundParamsOf(
  params: Record<string, unknown>,
  manifest: NodeTypeManifest,
): { boundParams?: Record<string, unknown> } {
  const bound: Record<string, unknown> = {};
  let any = false;
  for (const spec of manifest.params) {
    if (spec.bind === undefined) continue;
    if (!(spec.key in params)) continue;
    const value = params[spec.key];
    if (value === undefined || value === null || value === "") continue;
    bound[spec.key] = value;
    any = true;
  }
  // 没声明任何绑定 → 字段不出现(与 `input` / `engineRequest` 同一条"缺席 = 没有"的读法)。
  return any ? { boundParams: bound } : {};
}

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
  memorySnapshot?: (query?: string) => string;
  userPrompt: string;
  upstream: string;
  upstreamArtifacts: NodeArtifact[];
  upstreamOutputs: Record<string, Record<string, unknown>>;
  /** 这一步是谁 / 整条流程长什么样 —— 「整条流程」那一节的内容。 */
  nodeId: string;
  plan: WorkflowPlan;
  /** 这一步的权限档位(`node.capability ?? manifest.capability`)。`read` → plan 模式,
   *  写类工具弹审批。用来在提示词里**明说**这一步是只读的(报告 P3)。 */
  capability?: WorkflowCapability;
  /**
   * **这次的固定条件,整节已经渲染好**(报告 P1)。入口节点打开「把固定条件传给下游」
   * 时,调度层给**每个非根节点**都递一份;关着 / 一个条件都没填 → 空(不发这一节)。
   *
   * 为什么整节递进来而不是在这儿现渲染:渲染要用工作流 id 去查候选现读那一支,那是
   * 主进程的知识;而且它必须和根节点那次注入说的是同一句话(同一个 `nodeCriteriaPrompt`),
   * 两处各渲染一遍迟早分家。
   */
  criteriaNote?: string;
  /** 工作流级的追加框架说明(`WorkflowDoc.frameworkNote`)。见 `composeNodePrompt`。 */
  frameworkNote?: string;
  /**
   * **这一步是不是这张图的根**(`plan` 的第 0 层,也就是"用户那句话进来的那一格")。
   *
   * 只有一处在读它:根节点的提示词里带着**用户的请求**那一段(见 `composeNodePrompt`),
   * 所以它不是"一句用户会说的话",回主对话时不该再回声一遍(见
   * `NodeRunInput.echoUserMessage`)。判据取自计划分层,与 `composeNodePrompt` 里那个
   * `isRoot` 是**同一个事实的两次读** —— 两处必须一起算,不然会出现"提示词里没带用户
   * 那句话、却也没回声"或者反过来的错配。
   */
  root: boolean;
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
 * `{{trigger.*}}` 的词法与展开器住在 `./triggerVars.ts` —— **零依赖叶子模块**
 * (见那边的文件头:scheduler 直接 import 它,不能经由本文件把 memory/electron 拖进
 * 冒烟打包图)。这里 import + re-export:`buildNodeInput` 用 `expandTriggerVars` 做
 * 第二遍兜底展开,老的外部引用继续从本模块拿,路径不变。
 *
 * ⚠️ **候选名单不在那边了**(2026-09-19)。原来这里还导出一个 `triggerVarCandidates`,
 * 说是"渲染端的「插入变量」用它拼触发器那一组" —— **那句话从来不是真的**:渲染端够不到
 * `@main`(它 import 不到这个模块),那边自己抄了一份六个字段的名单,于是定时触发器里也
 * 摆着「涉及哪些对象」,点一下插进指令、下次到点必炸。现在候选按**触发方式**算,判据在
 * `@contracts/nodeType` 的 `triggerFactKeysOf`(渲染端够得到契约层),那个导出没人用了,
 * 删掉。
 */
export { expandTriggerVars };

/* ────────────────────────── 记忆注入(MEM-02)────────────────────────── */

/**
 * 「记忆」开关有没有打开。params 是**字符串记录**(界面开关存的就是字符串),开是
 * `"on"` / `"true"`;布尔 `true` 也认 —— AI 代填参数时偶尔会写真布尔。
 */
function memoryEnabled(params: Record<string, unknown>): boolean {
  return isMemoryInjectionEnabled(params[MEMORY_PARAM_KEY]);
}

/**
 * 记忆快照 → 拼进提示词的那一节。没开、库是空的都返回**空串** —— 空库不该凭空多一个
 * 只有标题的段落;读不出来(磁盘坏了/权限没了)也当没有 —— 记忆是**辅助**,它坏不能
 * 把这一步拖垮,正文照常跑。
 *
 * ⚠️ **拼装那一段搬去了 `@contracts/memory` 的 `memorySectionFrom`**(2026-09-20):
 * 「档案+记忆」建出来的子对话也要拼同一节(在 `lib/sessionStart.ts`),两处各写一遍的话
 * 会有两种叫法、两种措辞。这里保留"开关怎么判 + 读不出来怎么办"这一半 —— 那一半是
 * **节点参数**的语义,不是共享的拼装规则。纯拼装那一半在契约层。
 */
function memorySectionOf(
  params: Record<string, unknown>, snapshot: ((query?: string) => string) | undefined, query: string,
): MemoryInjectionSection {
  if (!memoryEnabled(params)) return { source: "workflow", state: "off", text: "" };
  if (!snapshot) return { source: "workflow", state: "unavailable", text: "" };
  try {
    const text = memorySectionFrom(snapshot(query));
    return { source: "workflow", state: text ? "included" : "empty", text };
  } catch (err) {
    return { source: "workflow", state: "error", text: "", error: (err instanceof Error ? err.message : String(err)).slice(0, 500) };
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
  // **参数到这里时 `{{...}}` 已经全解完了**(调度器的 `expandParams`,那一步是
  // **唯一**解参数的地方)。从前这里还要再跑一遍 `expandTriggerVars` 兜底 —— 兜底本身
  // 没害处(它是幂等的),但它把"哪个名字空间谁负责"这件事说成了两句不同的话:那句注释
  // 写着「触发器变量先解」,而真解它的地方在调度器,`{{trigger.*}}` 只是 `{{...}}` 的
  // 一种(见 `@contracts/nodeTemplate` 的 `resolveOne`)。两处都宣称自己解,改的时候
  // 就会只改一处。2026-09-20 收成一处。
  //
  // `scope.trigger` 那一格没删是**另一件事**:除了解参数,它还要把**载荷原样**放进
  // `data.trigger` 给节点自己读(下面那个 `DataWithTrigger`)。
  const expanded = params;
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
   *
   * 它**只服务这一件事**(参数解算在调度器那边已经做完了)。`scope.trigger` 不健康
   * (不是对象)就当没有 —— 载荷来自后台执行器,坏一份不该拖垮派发。
   */
  const trigger =
    scope.trigger !== null && typeof scope.trigger === "object" && !Array.isArray(scope.trigger)
      ? (scope.trigger as Record<string, unknown>)
      : undefined;
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
  // Resolve relevance for this step, not just the original workflow request.
  // Do not forward arbitrary upstream transcripts or let text choose project authority.
  const memoryQuery = `${instruction.trim().slice(0, 1200)}\n${scope.userPrompt.trim().slice(0, 800)}`;
  const memoryInjection = memorySectionOf(expanded, scope.memorySnapshot, memoryQuery);
  const memorySection = memoryInjection.text;
  const prompt = composeNodePrompt({
    userPrompt: scope.userPrompt,
    upstream: scope.upstream,
    instruction,
    nodeId: scope.nodeId,
    plan: scope.plan,
    ...(scope.frameworkNote !== undefined ? { frameworkNote: scope.frameworkNote } : {}),
    skills,
    context,
    ...(scope.arrival ? { arrival: scope.arrival } : {}),
    ...(scope.record ? { record: scope.record } : {}),
    ...(scope.ask ? { ask: scope.ask } : {}),
    ...(scope.decide ? { decision: decisionSection(scope.decide.options) } : {}),
    outputContract: stringParamOf(expanded, NODE_OUTPUT_CONTRACT_KEY),
    // **终末节点不发变量表**(调度器那边的 `withOutputCheck` 同一条规矩的另一端)。
    outputVars: scope.terminal ? "" : describeOutputVars(vars),
    // 只读节点写明权限(报告 P3) —— 让模型知道这一步写不了,别做到一半才发现。
    // ⚠️ **只在 capability 真的算数时才发**:它只对 `runner.kind === "prompt"` 生效
    // (见 `showsNodeCapability`) —— 命令 / 代码节点的"能力"旋钮根本不接权限,
    // 对它们说"你是只读"是假话。命令/代码节点的权限说明另有出处(commandRunner 里
    // 明说"没有审批"),不在这里。
    ...(scope.capability === "read" && showsNodeCapability(manifest)
      ? { permissionNote: READ_ONLY_PERMISSION_NOTE }
      : {}),
    // 固定条件往下传(报告 P1)—— 只有入口节点开了那个开关、且这次真填了条件才有。
    // 摆在同一层:都是"这次运行的权威前提",必须先于各步的指令读到。
    ...(scope.criteriaNote !== undefined && scope.criteriaNote.trim().length > 0
      ? { criteriaNote: scope.criteriaNote }
      : {}),
  });
  return {
    prompt: memorySection.length > 0 ? `${prompt}\n\n${memorySection}` : prompt,
    memoryInjection,
    data,
    skills,
    mcpServerNames,
    pluginNames,
    returnMode,
    // **入口节点不回这一步的指令。** 图上只有它一个是不隔离的入口:用户那句话先到
    // 它这儿,而上面拼出来的 `prompt` 里除了那句话还有脚手架(流程位置、上游产出、
    // 产出要求)。那一段**只发给模型**,不进聊天框 —— 用户打的那句原话由
    // `startWorkflowRun` 回声(见 `NodeRunInput.echoUserMessage`)。
    //
    // 放在**这条返回**上、不是那个共享的 `base` 上,是因为读它的只有 `conversation`
    // 那一个跑法(`runInConversation`)—— 而 `prompt` 是在这条路上才拼出来的。专用
    // builder(code / command)提前返回,它们拿到的是 `base`,也就没有这个字段。
    //
    // 判据用 `scope.root` 而不是节点类型 id:真正决定"该不该回声"的是**这一格拿到的
    // 提示词是不是用户自己说的话**,而那个事实在调度器算出根节点时就定了 —— 下游的
    // 对话节点拿到的 `prompt` 就是它自己的指令(一句人话),照旧回声。等哪一天有别的
    // 入口类型,这一行一个字都不用改。
    ...(scope.root ? { echoUserMessage: false } : {}),
    ...(providerId !== undefined ? { providerId } : {}),
    signal,
  };
}
