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
import { mcpServerNamesOf, pluginNamesOf, providerIdOf, skillNamesOf, type NodeTypeManifest, type NodeRunnerKind } from "@contracts/nodeType";
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

/** 装配一台机器上的能力清单。**所有来源都是参数**:providers 来自 provider 注册表、
 *  executors 来自 NodeExecutorRegistry(`kinds()` + `capabilities()`)、plugins 来自
 *  pluginManager 的已启用清单 —— 这些模块分属其它并行任务的领地,这里只消费它们的
 *  返回值,不 import 它们(保持本文件可被 smoke 无 DB 打包)。 */
export function collectCapabilityInventory(sources: {
  providers?: readonly AgentProvider[];
  plugins?: ReadonlyArray<{ name: string; manifest: PluginManifest }>;
  executorKinds?: readonly string[];
  executorCapabilitiesOf?: (kind: string) => ExecutorCapabilityFlags | undefined;
}): CapabilityDescriptor[] {
  const out: CapabilityDescriptor[] = [];
  for (const provider of sources.providers ?? []) out.push(providerCapabilityDescriptor(provider));
  for (const { name, manifest } of sources.plugins ?? []) {
    out.push(...pluginCapabilityDescriptors(name, manifest.capabilities ?? []));
  }
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
  if (selectedProvider) requirements.push({ kind: "provider", id: selectedProvider });
  for (const id of skillNamesOf(params)) requirements.push({ kind: "skill", id });
  for (const id of mcpServerNamesOf(params)) requirements.push({ kind: "mcp", id });
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
