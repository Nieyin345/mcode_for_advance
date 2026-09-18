/**
 * Declarative capability contracts shared by node types, providers and plugins.
 *
 * A requirement says what a node needs; descriptors say what is actually
 * available on this host. Resolution is deterministic and never executes code.
 */
import { z } from "zod";
import type { NodeRunnerKind } from "./nodeType.js";

export const CAPABILITY_KINDS = [
  "builtin",
  "executor",
  "provider",
  "skill",
  "mcp",
  "plugin",
] as const;
export type CapabilityKind = (typeof CAPABILITY_KINDS)[number];

/**
 * Capability model 的版本号 —— WF-06 / WF-08 的预留位。
 *
 * 工作流 import/export 将来序列化 `requirements` 时带上它;老文档没有 requirements
 * 字段也能读(整棵树都是 optional),所以这里的版本只描述"capability 部分按哪一版
 * 规范解释",不承担整个 workflow schema 的版本职责。现在只定义、不消费 —— 大实现
 * (share/backup/validation)按路线图 WF-06/WF-08 另行展开。
 */
export const CAPABILITY_MODEL_VERSION = 1;

/** zod 形状与 {@link CapabilityRequirement} 一致 —— 节点清单的 `requirements` 与
 *  插件清单的能力声明都引用这一份,避免三处各抄一份 kind 枚举后漂移。 */
export const CapabilityRequirementSchema = z.object({
  kind: z.enum(CAPABILITY_KINDS),
  id: z.string().min(1),
  /** 这个依赖要求具备的细粒度能力(如 provider 的 `mcp` / executor 的 `progress`)。 */
  capabilities: z.array(z.string().min(1)).optional(),
});

/** zod 形状与 {@link CapabilityDescriptor} 的声明面一致 —— 插件清单的
 *  `capabilities[]` 用它(插件声明的是"我提供什么",即 descriptor 语义)。 */
export const CapabilityDeclarationSchema = z.object({
  kind: z.enum(CAPABILITY_KINDS),
  id: z.string().min(1),
  capabilities: z.array(z.string().min(1)).optional(),
  /** 适用范围约束:声明该能力只在哪些节点类型 / 执行方式 / 引擎下可用。 */
  nodeTypes: z.array(z.string().min(1)).optional(),
  runnerKinds: z.array(z.string().min(1)).optional(),
  providers: z.array(z.string().min(1)).optional(),
});

export interface CapabilityRequirement {
  kind: CapabilityKind;
  id: string;
  /** Additional provider/skill features required by this dependency. */
  capabilities?: string[];
}

export interface CapabilityDescriptor {
  kind: CapabilityKind;
  id: string;
  source?: string;
  /** Fine-grained features exposed by the capability. */
  capabilities?: string[];
  /** Optional applicability constraints for skills/plugins. */
  nodeTypes?: string[];
  runnerKinds?: NodeRunnerKind[];
  providers?: string[];
}

export interface CapabilityResolution {
  available: CapabilityRequirement[];
  missing: CapabilityRequirement[];
  incompatible: Array<{
    requirement: CapabilityRequirement;
    descriptor: CapabilityDescriptor;
    missingCapabilities: string[];
  }>;
  ok: boolean;
}

function hasAll(values: readonly string[] | undefined, required: readonly string[]): string[] {
  const set = new Set(values ?? []);
  return required.filter((value) => !set.has(value));
}

function applicable(
  descriptor: CapabilityDescriptor,
  context?: { nodeType?: string; runnerKind?: NodeRunnerKind; providerId?: string },
): boolean {
  if (descriptor.nodeTypes?.length && (!context?.nodeType || !descriptor.nodeTypes.includes(context.nodeType))) {
    return false;
  }
  if (descriptor.runnerKinds?.length && (!context?.runnerKind || !descriptor.runnerKinds.includes(context.runnerKind))) {
    return false;
  }
  if (descriptor.providers?.length && (!context?.providerId || !descriptor.providers.includes(context.providerId))) {
    return false;
  }
  return true;
}

/** Resolve node requirements against a host capability inventory. */
export function resolveCapabilities(
  requirements: readonly CapabilityRequirement[],
  available: readonly CapabilityDescriptor[],
  context?: { nodeType?: string; runnerKind?: NodeRunnerKind; providerId?: string },
): CapabilityResolution {
  const result: CapabilityResolution = {
    available: [],
    missing: [],
    incompatible: [],
    ok: true,
  };

  for (const requirement of requirements) {
    const candidates = available.filter(
      (descriptor) => descriptor.kind === requirement.kind && descriptor.id === requirement.id,
    );
    const descriptor = candidates.find((candidate) => applicable(candidate, context));
    if (!descriptor) {
      const declared = candidates[0];
      if (declared && candidates.some((candidate) => candidate.nodeTypes?.length || candidate.runnerKinds?.length || candidate.providers?.length)) {
        result.incompatible.push({ requirement, descriptor: declared, missingCapabilities: [] });
      } else {
        result.missing.push(requirement);
      }
      result.ok = false;
      continue;
    }
    const missingCapabilities = hasAll(descriptor.capabilities, requirement.capabilities ?? []);
    if (missingCapabilities.length) {
      result.incompatible.push({ requirement, descriptor, missingCapabilities });
      result.ok = false;
      continue;
    }
    result.available.push(requirement);
  }

  return result;
}

/** Convert the legacy boolean provider flags into fine-grained capability ids. */
export function providerCapabilityIds(capabilities: {
  supportsApproval: boolean;
  supportsResume: boolean;
  supportsStreaming: boolean;
  supportsMcp: boolean;
  supportsAskUserQuestion: boolean;
  supportsFork?: boolean;
  supportsInject?: boolean;
  supportsElicitation?: boolean;
  supportsCustomSubagents?: boolean;
}): string[] {
  const ids: string[] = [];
  const flags: Record<string, boolean | undefined> = {
    approval: capabilities.supportsApproval,
    resume: capabilities.supportsResume,
    streaming: capabilities.supportsStreaming,
    mcp: capabilities.supportsMcp,
    askUserQuestion: capabilities.supportsAskUserQuestion,
    fork: capabilities.supportsFork,
    inject: capabilities.supportsInject,
    elicitation: capabilities.supportsElicitation,
    customSubagents: capabilities.supportsCustomSubagents,
  };
  for (const [id, enabled] of Object.entries(flags)) if (enabled) ids.push(id);
  return ids;
}

/** 各 capability kind 的中文标签 —— 诊断文案与界面共用同一份叫法。 */
export const CAPABILITY_KIND_LABELS: Record<CapabilityKind, string> = {
  builtin: "内置依赖",
  executor: "执行器",
  provider: "引擎",
  skill: "技能",
  mcp: "MCP 服务器",
  plugin: "插件",
};

/**
 * 把一次解析结果翻译成**给人看的**问题清单(中文,空数组 = 没问题)。
 *
 * 放在 contracts 是因为**两处要用同一份话术**:配置阶段(检查器把问题标在节点上)与
 * 运行前(调度器拒绝执行时给用户的那句错误)。两处各写一遍,迟早一边说「引擎」一边说
 * 「provider」,用户以为是两个问题。
 *
 * 三类问题、三种说法:
 *  - `missing`:这台机器上根本没有 → 「装好或启用它之后再运行」;
 *  - `incompatible` 且缺细粒度能力 → 点名缺哪些能力;
 *  - `incompatible` 且是适用范围不匹配 → 说清它只适用于什么(节点类型 / 执行方式 / 引擎)。
 */
export function describeCapabilityProblems(
  resolution: CapabilityResolution,
  labels: Partial<Record<CapabilityKind, string>> = {},
): string[] {
  const out: string[] = [];
  const labelOf = (kind: CapabilityKind) => labels[kind] ?? CAPABILITY_KIND_LABELS[kind];
  for (const requirement of resolution.missing) {
    const want = requirement.capabilities?.length
      ? `(要求具备:${requirement.capabilities.join("、")})`
      : "";
    out.push(`缺少${labelOf(requirement.kind)}「${requirement.id}」${want} —— 装好或启用它之后再运行这一步`);
  }
  for (const problem of resolution.incompatible) {
    const label = labelOf(problem.requirement.kind);
    if (problem.missingCapabilities.length > 0) {
      out.push(
        `${label}「${problem.requirement.id}」不支持这一步需要的能力:${problem.missingCapabilities.join("、")}`,
      );
      continue;
    }
    const limits: string[] = [];
    if (problem.descriptor.nodeTypes?.length) limits.push(`仅适用于节点类型 ${problem.descriptor.nodeTypes.join("、")}`);
    if (problem.descriptor.runnerKinds?.length) limits.push(`仅适用于执行方式 ${problem.descriptor.runnerKinds.join("、")}`);
    if (problem.descriptor.providers?.length) limits.push(`仅适用于引擎 ${problem.descriptor.providers.join("、")}`);
    out.push(
      `${label}「${problem.requirement.id}」不适用于这一步${limits.length ? `(${limits.join(";")})` : ""}`,
    );
  }
  return out;
}
