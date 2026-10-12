/**
 * 宿主侧的能力解析(主进程)。
 *
 * ⚠️ **这个文件保持纯函数**:不 import 任何带 DB / electron 的模块(见文末的
 * 「装配」一段)。配置阶段与运行前的消费方(调度器前置检查、渲染端检查器)各自把
 * 手头的清单喂进来,解析逻辑与诊断文案全部来自 contracts(`@contracts/capability`),
 * 这里只做"宿主形状 → capability 形状"的翻译,不做第二套判定。
 */
import {
  resolveCapabilities,
  type CapabilityDescriptor,
  type CapabilityRequirement,
  providerCapabilityIds,
} from "@contracts/capability";
import { injectTargetOf, isModelDecider, mcpServerNamesOf, pluginNamesOf, providerIdOf, skillNamesOf, type NodeTypeManifest, type NodeRunnerKind } from "@contracts/nodeType";
import type { WorkflowNode } from "@contracts/workflow";
import type { AgentProvider } from "@contracts/provider";
import type { PluginCapabilityDeclaration, PluginManifest } from "@contracts/plugin";

export interface NodeCapabilityCheckContext {
  nodeType: string;
  runnerKind: NodeRunnerKind;
  providerId?: string;
}

/** provider 的能力清单 → 一份 provider descriptor。优先用显式的
 *  `capabilityIds`(清单化声明),没有则从旧布尔旗标推导 —— 三个内置引擎
 *  (claude / pi / codex)不用改一行代码就能参与能力检查。 */
export function providerCapabilityDescriptor(provider: AgentProvider): CapabilityDescriptor {
  return {
    kind: "provider",
    id: provider.id,
    source: provider.displayName,
    capabilities: provider.capabilities.capabilityIds ?? providerCapabilityIds(provider.capabilities),
  };
}

/** 插件清单里 `capabilities[]` 的每一项 → 一份 descriptor,来源标成
 *  `plugin:<名>` —— 诊断文案里用户能看出"这是哪个插件带来的能力"。 */
export function pluginCapabilityDescriptors(
  pluginName: string,
  declarations: readonly PluginCapabilityDeclaration[],
): CapabilityDescriptor[] {
  return declarations.map((declaration) => ({
    kind: declaration.kind,
    id: declaration.id,
    source: `plugin:${pluginName}`,
    capabilities: declaration.capabilities,
    nodeTypes: declaration.nodeTypes,
    runnerKinds: declaration.runnerKinds as NodeRunnerKind[] | undefined,
    providers: declaration.providers,
  }));
}

/** ExecutorCapabilityFlags —— 结构化地照抄 NodeExecutorRegistry 的
 *  `ExecutorCapabilities`(只取解析需要的那几样)。刻意用结构类型而不是 import:
 *  executor registry 是并行任务 A 的领地,这里只读形状、不建立编译期耦合。 */
export interface ExecutorCapabilityFlags {
  supportsProgress?: boolean;
  supportsCancellation?: boolean;
  supportsArtifacts?: boolean;
  inputKinds?: string[];
  outputKinds?: string[];
}

/** 已注册的 executor kind 集合 → executor descriptors。这是 CAP-08 的扩展缝:
 *  第三方 executor 往 NodeExecutorRegistry 注册,这里照单收编,不需要任何特判。 */
export function executorCapabilityDescriptors(
  kinds: readonly string[],
  capabilitiesOf?: (kind: string) => ExecutorCapabilityFlags | undefined,
): CapabilityDescriptor[] {
  return kinds.map((kind) => {
    const flags = capabilitiesOf?.(kind);
    const capabilities: string[] = [];
    if (flags?.supportsProgress) capabilities.push("progress");
    if (flags?.supportsCancellation) capabilities.push("cancellation");
    if (flags?.supportsArtifacts) capabilities.push("artifacts");
    for (const input of flags?.inputKinds ?? []) capabilities.push(`input:${input}`);
    for (const output of flags?.outputKinds ?? []) capabilities.push(`output:${output}`);
    return { kind: "executor" as const, id: kind, source: "mcode", capabilities };
  });
}

/**
 * **宿主内置能力**(ARC-006 步①)的声明 —— 「这台机器自带、不来自任何插件」的能力。
 *
 * 与 provider / plugin / executor 三类不同,这一类是**宿主自己实现**的(目前是模块系统的
 * 两个只读文件能力 `core.file.inspect` / `core.file.info`,见 `modules/fileCapabilities.ts`)。
 * 它们的实现住在 `ModuleHost`,所以本文件**不 import 它们**(保持可被 smoke 无 DB 打包),
 * 由装配方把「宿主注册了哪几个能力 id」当**数据**喂进来 —— 与 plugins 那条完全同形。
 *
 * **种类映射**:契约 `CapabilityKind` 只有 `builtin` / `executor` / `provider` / `skill` /
 * `mcp` / `plugin` —— 没有模块系统自己的 `task` / `query`。宿主实现的能力,契约里唯一对得上
 * 的是 **`builtin`**。模块那一层的 `task` / `query` 因此作为**细粒度能力**放进
 * `capabilities`(`module:task` / `module:query`),既不丢信息,也不在契约里另造一个 kind。
 * 执行代码仍旧只在 `ModuleHost` 里跑,这里**只做发现** —— 这正是 ARC-006「统一元数据,
 * 不合并执行引擎」的那条线。
 */
export interface HostCapabilitySource {
  id: string;
  /** 模块系统里这个能力的种类(`task` / `query`),映射成 `capabilities` 里的细粒度标签。 */
  moduleKind: "task" | "query";
  /** 给用户看的来源标签(诊断文案里能看出这是宿主自带的)。 */
  source?: string;
  /** 额外的细粒度能力标签(会与 `module:<moduleKind>` 合并)。 */
  capabilities?: string[];
}

/** 宿主内置能力 → descriptors(契约 kind 一律 `builtin`,模块种类进 capabilities)。 */
export function hostCapabilityDescriptors(
  capabilities: readonly HostCapabilitySource[],
): CapabilityDescriptor[] {
  return capabilities.map((c) => ({
    kind: "builtin" as const,
    id: c.id,
    source: c.source ?? "host",
    capabilities: [`module:${c.moduleKind}`, ...(c.capabilities ?? [])],
  }));
}

/**
 * **宿主注册的内置能力声明**(ARC-006 步①)—— 唯一权威的一份 id / 模块种类清单。
 *
 * 与 `modules/service.ts` 里 `host.register(capability)` 的实际注册**同源**(那里的
 * `fileCapabilities(...)` 产出同两个 id 与 kind)。刻意在这里**只放声明、不放实现**:预检
 * 装配路径不能 import `modules/service`(它会碰 `dataRoot()`,把 DB/electron 拖进来)。
 * 若将来 `fileCapabilities` 增删能力,这里要跟着改 —— 两份名单靠
 * `capability-smoke` 的「喂进目录后查得到」断言钉着,漂了会红。
 */
export const HOST_CAPABILITY_DECLARATIONS: readonly HostCapabilitySource[] = [
  { id: "core.file.inspect", moduleKind: "task", source: "host" },
  { id: "core.file.info", moduleKind: "query", source: "host" },
];

/** 装配一台机器上的能力清单。**所有来源都是参数**:providers 来自 provider 注册表、
 *  executors 来自 NodeExecutorRegistry(`kinds()` + `capabilities()`)、plugins 来自
 *  pluginManager 的已启用清单 —— 这些模块分属其它并行任务的领地,这里只消费它们的
 *  返回值,不 import 它们(保持本文件可被 smoke 无 DB 打包)。 */
export function collectCapabilityInventory(sources: {
  providers?: readonly AgentProvider[];
  plugins?: ReadonlyArray<{ name: string; manifest: PluginManifest; compatibleProviderIds?: string[] }>;
  executorKinds?: readonly string[];
  executorCapabilitiesOf?: (kind: string) => ExecutorCapabilityFlags | undefined;
  /** 【ARC-006 步①】宿主自带的内置能力(见 {@link HostCapabilitySource})。 */
  hostCapabilities?: readonly HostCapabilitySource[];
}): CapabilityDescriptor[] {
  const out: CapabilityDescriptor[] = [];
  for (const provider of sources.providers ?? []) out.push(providerCapabilityDescriptor(provider));
  for (const { name, manifest, compatibleProviderIds } of sources.plugins ?? []) {
    // Selecting a plugin is itself a capability requirement. Most ecosystem
    // manifests do not declare a synthetic `kind: plugin` capability, so add
    // one host descriptor for every enabled plugin instead of falsely marking
    // an otherwise valid plugin as missing. Provider applicability is the same
    // metadata used by the editor's candidate filter.
    const declaresSelf = (manifest.capabilities ?? []).some(
      (declaration) => declaration.kind === "plugin" && declaration.id === name,
    );
    if (!declaresSelf) {
      out.push({
        kind: "plugin",
        id: name,
        source: `plugin:${name}`,
        ...(compatibleProviderIds ? { providers: compatibleProviderIds } : {}),
      });
    }
    out.push(...pluginCapabilityDescriptors(name, manifest.capabilities ?? []));
  }
  out.push(...hostCapabilityDescriptors(sources.hostCapabilities ?? []));
  out.push(...executorCapabilityDescriptors(sources.executorKinds ?? [], sources.executorCapabilitiesOf));
  return out;
}

/**
 * 一个节点的能力需求清单:清单显式声明的 `requirements` + 从 runner/params 推导的部分。
 *
 * 推导规则(与 `NodeRunInput` 已有的 skills / mcpServerNames / pluginNames / providerId
 * 字段一一对应,不发明第二套读法):
 *  - `executor`:**只有 runner.kind 真的经由 Executor Registry 派发时才加** —— 即
 *    caller 传入的 `executorKinds` 里有它。branch / trigger 不跑任何东西,prompt /
 *    conversation 走的是会话而不是 executor;给它们凭空加 executor 需求,只会制造
 *    "明明能跑却说缺执行器"的假阳性。
 *  - `provider`:节点参数显式选了引擎(或 caller 指定)才加;留空跟对话走,无需检查。
 *  - `skill` / `mcp` / `plugin`:参数里**非空**的名字列表(空 = 不限制,不是"都不许用")。
 */
export function requirementsForNode(
  manifest: NodeTypeManifest,
  params: Record<string, unknown>,
  providerId?: string,
  executorKinds?: readonly string[],
): CapabilityRequirement[] {
  const requirements: CapabilityRequirement[] = [...((manifest.requirements ?? []) as CapabilityRequirement[])];
  if (executorKinds?.includes(manifest.runner.kind)) {
    requirements.push({ kind: "executor", id: manifest.runner.kind });
  }
  const selectedProvider = providerId ?? providerIdOf(params);
  const mcpServerNames = mcpServerNamesOf(params);
  // A present MCP server is not enough: the selected provider must be able to
  // mount MCP at all. This makes Pi + MCP fail during capability validation
  // instead of silently reaching a provider that intentionally ignores MCP.
  if (selectedProvider) requirements.push({
    kind: "provider",
    id: selectedProvider,
    ...(mcpServerNames.length > 0 ? { capabilities: ["mcp"] } : {}),
  });
  for (const id of skillNamesOf(params)) requirements.push({ kind: "skill", id });
  for (const id of mcpServerNames) requirements.push({ kind: "mcp", id });
  for (const id of pluginNamesOf(params)) requirements.push({ kind: "plugin", id });
  return requirements;
}

/** 解析一个节点的能力需求。`context` 缺的维度从清单与需求自身补:节点类型 id、
 *  执行方式取自清单;`providerId` 缺省时取需求清单里选定的那个引擎 —— 节点参数里
 *  选了 `claude-sdk`,带 `providers: ["claude-sdk"]` 约束的技能就必须按这个引擎来判
 *  适用性,否则"参数明明选对了却报不适用"是最冤枉的一种假阳性。 */
export function checkNodeCapabilities(
  manifest: NodeTypeManifest,
  requirements: readonly CapabilityRequirement[],
  inventory: readonly CapabilityDescriptor[],
  context?: Partial<NodeCapabilityCheckContext>,
) {
  return resolveCapabilities(requirements, inventory, {
    nodeType: context?.nodeType ?? manifest.id,
    runnerKind: context?.runnerKind ?? manifest.runner.kind,
    providerId: context?.providerId ?? requirements.find((r) => r.kind === "provider")?.id,
  });
}

/** Return only providers that can execute model turns in this graph. */
export function providerIdsForWorkflowPreflight(
  nodes: readonly WorkflowNode[],
  manifests: ReadonlyMap<string, NodeTypeManifest>,
  sessionProviderId: string,
  originProviderId?: string,
): string[] {
  const ids = new Set<string>();
  for (const node of nodes) {
    const manifest = manifests.get(node.type);
    if (!manifest) continue;
    if (manifest.runner.kind === "prompt" || isModelDecider(manifest, node.params)) {
      ids.add(providerIdOf(node.params) ?? sessionProviderId);
      continue;
    }
    if (manifest.runner.kind !== "conversation") continue;
    if (injectTargetOf(node.params) === "origin") {
      if (originProviderId) ids.add(originProviderId);
    } else {
      ids.add(sessionProviderId);
    }
  }
  return [...ids];
}
