﻿import { resolveCapabilities, providerCapabilityIds, describeCapabilityProblems } from "../../../../packages/contracts/src/capability.js";
import type { CapabilityDescriptor, CapabilityRequirement } from "../../../../packages/contracts/src/capability.js";
import { PluginManifestSchema } from "../../../../packages/contracts/src/plugin.js";
import type { AgentProvider } from "../../../../packages/contracts/src/provider.js";
import { validateNodeTypeManifest } from "../../../../packages/contracts/src/nodeType.js";
import {
  checkNodeCapabilities,
  collectCapabilityInventory,
  executorCapabilityDescriptors,
  pluginCapabilityDescriptors,
  requirementsForNode,
} from "../../src/main/orchestration/capabilityResolver.js";

const checks: string[] = [];
const ok = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(`FAIL: ${message}`);
  checks.push(message);
};

/* ── 1. 核心解析:builtin executor + provider + plugin skill(CAP-03/04/06) ── */

const builtinCode: CapabilityDescriptor = {
  kind: "executor", id: "code", source: "mcode",
  capabilities: ["structured-output", "progress", "artifacts"],
};
const claude: CapabilityDescriptor = {
  kind: "provider", id: "claude-sdk",
  capabilities: ["streaming", "mcp", "approval", "resume"],
};
const pluginSkill: CapabilityDescriptor = {
  kind: "skill", id: "academic-research", source: "plugin:research-pack",
  capabilities: ["literature-search"], nodeTypes: ["myorg.research"],
  providers: ["claude-sdk"],
};
const inventory = [builtinCode, claude, pluginSkill];
const requirements: CapabilityRequirement[] = [
  { kind: "executor", id: "code", capabilities: ["progress"] },
  { kind: "provider", id: "claude-sdk", capabilities: ["mcp", "streaming"] },
  { kind: "skill", id: "academic-research", capabilities: ["literature-search"] },
];

const resolved = resolveCapabilities(requirements, inventory, {
  nodeType: "myorg.research", runnerKind: "code", providerId: "claude-sdk",
});
ok(resolved.ok, "builtin executor + provider + plugin skill resolve");
ok(resolved.available.length === 3, "all declared requirements are available");
ok(describeCapabilityProblems(resolved).length === 0, "resolved inventory produces no diagnostics");

const wrongProvider = resolveCapabilities(
  [{ kind: "skill", id: "academic-research", capabilities: ["literature-search"] }],
  inventory, { nodeType: "myorg.research", runnerKind: "prompt", providerId: "pi-sdk" },
);
ok(!wrongProvider.ok && wrongProvider.incompatible.length === 1, "skill/provider incompatibility is diagnosed");
const wrongProviderText = describeCapabilityProblems(wrongProvider).join("\n");
ok(wrongProviderText.includes("技能") && wrongProviderText.includes("仅适用于引擎"), "applicability diagnostic names the kind and the constraint");

const missing = resolveCapabilities(
  [{ kind: "provider", id: "codex-sdk", capabilities: ["streaming"] }], inventory,
);
ok(!missing.ok && missing.missing[0]?.id === "codex-sdk", "missing provider is diagnosed");
const missingText = describeCapabilityProblems(missing).join("\n");
ok(missingText.includes("引擎") && missingText.includes("codex-sdk"), "missing diagnostic names 引擎 + id");

const unsupported = resolveCapabilities(
  [{ kind: "executor", id: "code", capabilities: ["sandbox"] }], inventory,
);
ok(!unsupported.ok, "missing fine-grained capability is diagnosed");
ok(unsupported.incompatible[0]?.missingCapabilities[0] === "sandbox", "diagnostic names missing capability");
ok(describeCapabilityProblems(unsupported)[0]?.includes("sandbox") === true, "fine-grained diagnostic names the capability");

/* ── 2. provider 布尔旗标 → capability ids(CAP-06,老引擎零改动参与) ── */

const flagIds = providerCapabilityIds({
  supportsApproval: true, supportsResume: false, supportsStreaming: true,
  supportsMcp: true, supportsAskUserQuestion: false, supportsInject: true,
});
ok(
  flagIds.includes("streaming") && flagIds.includes("mcp") && flagIds.includes("approval") && flagIds.includes("inject") && !flagIds.includes("resume"),
  "provider boolean flags map to capability ids",
);

/* ── 3. executor 能力映射(CAP-08:第三方 executor 注册即被收编) ── */

const executorDescs = executorCapabilityDescriptors(
  ["code", "command", "myorg.heavy"],
  (kind) => (kind === "code" ? { supportsProgress: true, supportsArtifacts: true } : { supportsCancellation: true }),
);
const codeDesc = executorDescs.find((d) => d.id === "code");
ok(
  codeDesc?.capabilities?.includes("progress") === true && codeDesc.capabilities.includes("artifacts") === true,
  "executor flags map to capability ids",
);
ok(
  executorDescs.find((d) => d.id === "myorg.heavy")?.capabilities?.includes("cancellation") === true,
  "third-party executor kinds join the inventory without special-casing",
);

/* ── 4. 模拟插件端到端:manifest 声明 → descriptor → inventory → 节点检查(CAP-05) ── */

const pluginManifestCheck = PluginManifestSchema.safeParse({
  name: "research-pack",
  version: "0.1.0",
  capabilities: [
    { kind: "skill", id: "academic-research", capabilities: ["literature-search"], nodeTypes: ["myorg.research"], providers: ["claude-sdk"] },
    { kind: "mcp", id: "scholar-api", capabilities: ["search"] },
  ],
});
ok(pluginManifestCheck.success, "mock plugin manifest with capabilities parses");
if (!pluginManifestCheck.success) throw new Error("unreachable");
const pluginDescs = pluginCapabilityDescriptors("research-pack", pluginManifestCheck.data.capabilities ?? []);
ok(pluginDescs.length === 2, "plugin declarations become descriptors");
ok(pluginDescs.every((d) => d.source === "plugin:research-pack"), "plugin descriptors carry their origin");

const claudeProvider = {
  id: "claude-sdk",
  displayName: "Claude",
  capabilities: { capabilityIds: ["streaming", "mcp", "approval", "resume"] },
} as unknown as AgentProvider;

const fullInventory = collectCapabilityInventory({
  providers: [claudeProvider],
  plugins: [{ name: "research-pack", manifest: pluginManifestCheck.data }],
  executorKinds: ["code"],
  executorCapabilitiesOf: (kind) => (kind === "code" ? { supportsProgress: true, supportsArtifacts: true } : undefined),
});
ok(fullInventory.length >= 4, "inventory combines providers + plugins + executors");

const researchNodeCheck = validateNodeTypeManifest({
  id: "myorg.research",
  manifestVersion: 1,
  name: "Research",
  description: "Runs literature research via an installed plugin skill.",
  runner: { kind: "code", language: "python" },
  capability: "exec",
  params: [
    { key: "skills", kind: "ref", from: "skills", multiple: true, label: "技能" },
    { key: "provider", kind: "ref", from: "providers", label: "引擎" },
  ],
  requirements: [{ kind: "skill", id: "academic-research", capabilities: ["literature-search"] }],
});
ok(researchNodeCheck.ok, "node manifest with requirements validates");
if (!researchNodeCheck.ok) throw new Error("unreachable");

const nodeRequirements = requirementsForNode(
  researchNodeCheck.manifest,
  { skills: ["academic-research"], provider: "claude-sdk" },
  undefined,
  ["code"],
);
ok(
  nodeRequirements.some((r) => r.kind === "executor" && r.id === "code") &&
    nodeRequirements.some((r) => r.kind === "provider" && r.id === "claude-sdk") &&
    nodeRequirements.some((r) => r.kind === "skill" && r.id === "academic-research"),
  "requirements combine manifest declarations + runner + params",
);
const nodeResolution = checkNodeCapabilities(researchNodeCheck.manifest, nodeRequirements, fullInventory);
ok(nodeResolution.ok, "mock plugin node passes capability check end-to-end");

const uninstalled = requirementsForNode(
  researchNodeCheck.manifest,
  { skills: ["academic-research"], provider: "gemini-cli" },
  undefined,
  ["code"],
);
const uninstalledResolution = checkNodeCapabilities(researchNodeCheck.manifest, uninstalled, fullInventory);
ok(!uninstalledResolution.ok && uninstalledResolution.missing.length === 1, "uninstalled provider is caught at node level");
ok(
  describeCapabilityProblems(uninstalledResolution)[0]?.includes("gemini-cli") === true,
  "node-level diagnostic names the missing provider",
);

/* ── 5. executor 需求只给真派发的 runner(branch 不假报缺执行器) ── */

const branchCheck = validateNodeTypeManifest({
  id: "myorg.gateway",
  manifestVersion: 1,
  name: "Gateway",
  runner: { kind: "branch" },
  capability: "read",
  params: [],
});
ok(branchCheck.ok, "branch manifest validates");
if (!branchCheck.ok) throw new Error("unreachable");
const branchRequirements = requirementsForNode(branchCheck.manifest, {}, undefined, ["code"]);
ok(
  !branchRequirements.some((r) => r.kind === "executor"),
  "branch nodes get no executor requirement",
);

/* ── 6. 向后兼容(WF-06/WF-08 预留):无 requirements 的老清单照常可读 ── */

const plainCheck = validateNodeTypeManifest({
  id: "myorg.plain",
  manifestVersion: 1,
  name: "Plain",
  runner: { kind: "prompt" },
  capability: "read",
  params: [],
});
ok(plainCheck.ok, "manifest without requirements stays valid (WF-06 backward compat)");

console.log(`PASS: ${checks.length} checks`);
