﻿import { resolveCapabilities, providerCapabilityIds, describeCapabilityProblems } from "../../../../packages/contracts/src/capability.js";
import type { CapabilityDescriptor, CapabilityRequirement } from "../../../../packages/contracts/src/capability.js";
import {
  PROVIDER_SEMANTICS,
  PROVIDER_SEMANTICS_CAPABILITY_IDS,
  SEMANTICS_PROVIDER_IDS,
  SEMANTICS_INVENTORY_CAPABILITY_IDS,
  semanticsCapabilityIds,
  providerSemanticsOf,
  semanticsFailureCodes,
  type ProviderSemanticsCapabilityId,
} from "../../../../packages/contracts/src/providerSemantics.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PluginManifestSchema, type ComponentDeliveryReport } from "../../../../packages/contracts/src/plugin.js";
import type { AgentProvider } from "../../../../packages/contracts/src/provider.js";
import { validateNodeTypeManifest, type NodeTypeManifest } from "../../../../packages/contracts/src/nodeType.js";
import type { WorkflowNode } from "../../../../packages/contracts/src/workflow.js";
import {
  checkNodeCapabilities,
  collectCapabilityInventory,
  executorCapabilityDescriptors,
  pluginCapabilityDescriptors,
  providerIdsForWorkflowPreflight,
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
const piProvider = {
  id: "pi-sdk",
  displayName: "Pi",
  capabilities: { capabilityIds: ["streaming", "approval", "resume"] },
} as unknown as AgentProvider;

const fullInventory = collectCapabilityInventory({
  providers: [claudeProvider, piProvider],
  plugins: [{
    name: "research-pack",
    manifest: pluginManifestCheck.data,
    compatibleProviderIds: ["claude-sdk"],
  }],
  executorKinds: ["code"],
  executorCapabilitiesOf: (kind) => (kind === "code" ? { supportsProgress: true, supportsArtifacts: true } : undefined),
});
ok(fullInventory.length >= 4, "inventory combines providers + plugins + executors");

/* ── 4b. 【ARC-003】组件级可用性进目录:同一插件对不同引擎的标签不同 ──
 *
 * 目录过去只有 plugin 级的 **ANY** 兼容列表(`providers`),没有**组件级**事实。
 * 承重反例:同一插件对 Claude 收得到 command、对 Pi 收不到 —— 若标签不带 providerId,
 * 就会把「某引擎有」谎报成「都有」(正是台账点名的缺口)。 */
{
  const mixedManifest = PluginManifestSchema.safeParse({ name: "mixed-pack", version: "1.0.0" });
  ok(mixedManifest.success, "ARC-003:测试用 mixed-pack manifest 合法");
  if (!mixedManifest.success) throw new Error("unreachable");
  // 同一插件逐一引擎的交付报告:Claude 收得到 skill+command,Pi 只收得到 skill。
  const mixedReports: ComponentDeliveryReport[] = [
    {
      pluginId: "mixed-pack", version: "1.0.0", providerId: "claude-sdk", pluginEnabled: true,
      entries: [
        { componentId: "skill:0", type: "skill", source: "s", status: "DELIVERED" },
        { componentId: "command:0", type: "command", source: "c", status: "DELIVERED" },
      ],
      allDelivered: true,
    },
    {
      pluginId: "mixed-pack", version: "1.0.0", providerId: "pi-sdk", pluginEnabled: true,
      entries: [
        { componentId: "skill:0", type: "skill", source: "s", status: "DELIVERED" },
        { componentId: "command:0", type: "command", source: "c", status: "INCOMPATIBLE", reason: "命令只有 Claude 引擎投递" },
      ],
      allDelivered: false,
    },
  ];
  const componentInventory = collectCapabilityInventory({
    plugins: [{
      name: "mixed-pack",
      manifest: mixedManifest.data,
      compatibleProviderIds: ["claude-sdk", "pi-sdk"],
      componentReports: mixedReports,
    }],
  });
  const mixedDesc = componentInventory.find((d) => d.kind === "plugin" && d.id === "mixed-pack");
  const mixedCaps = mixedDesc?.capabilities ?? [];
  ok(
    mixedCaps.includes("component:claude-sdk:command:0") && !mixedCaps.includes("component:pi-sdk:command:0"),
    `ARC-003:组件级标签带引擎 —— Claude 有 command:0、Pi 没有(不能只带插件名)(detail: ${JSON.stringify(mixedCaps)})`,
  );
  ok(
    mixedCaps.includes("component:claude-sdk:skill:0") && mixedCaps.includes("component:pi-sdk:skill:0"),
    `ARC-003:两家都收得到 skill:0,标签两家都在(detail: ${JSON.stringify(mixedCaps)})`,
  );
  // 反向:非 DELIVERED 的组件不该产出标签(INCOMPATIBLE 不是"可用")。
  ok(
    !mixedCaps.some((c) => c.startsWith("component:pi-sdk:command:")),
    `ARC-003:Pi 的 command 是 INCOMPATIBLE,不产出可用标签(detail: ${JSON.stringify(mixedCaps)})`,
  );
  // 承重:标签真参与解析 —— 一个「需要 Pi 收 command:0」的需求必须被判不满足。
  const needPiCommand = resolveCapabilities(
    [{ kind: "plugin", id: "mixed-pack", capabilities: ["component:pi-sdk:command:0"] }],
    componentInventory,
    { providerId: "pi-sdk" },
  );
  ok(!needPiCommand.ok, "ARC-003:需要 Pi 收 command 的需求被判不满足(证明标签参与判定,不是摆设)");
  // 同一需求换成 Claude 就满足 —— 证明上一条不是因为"资源根本不在"而空过。
  const needClaudeCommand = resolveCapabilities(
    [{ kind: "plugin", id: "mixed-pack", capabilities: ["component:claude-sdk:command:0"] }],
    componentInventory,
    { providerId: "claude-sdk" },
  );
  ok(needClaudeCommand.ok, "ARC-003:同一 command 需求换 Claude 就满足(对照,证明标签分引擎)");
}

/* 【ARC-006 步①】宿主自带的内置能力也要进目录 —— 让「按 capabilityId 查得到」
 * 不只对插件成立。两个只读文件能力由 ModuleHost 注册(见 modules/fileCapabilities.ts),
 * 这里把它俩当**数据**喂进来(本文件不 import 那个会碰 dataRoot 的 service)。 */
{
  const withHost = collectCapabilityInventory({
    hostCapabilities: [
      { id: "core.file.inspect", moduleKind: "task" },
      { id: "core.file.info", moduleKind: "query", source: "host:modules" },
    ],
  });
  ok(
    withHost.some((d) => d.id === "core.file.inspect" && d.kind === "builtin" && d.source === "host"),
    "host capability:内置能力进目录(kind=builtin),来源标 host",
  );
  ok(
    withHost.some((d) => d.id === "core.file.inspect" && (d.capabilities ?? []).includes("module:task")),
    "host capability:模块种类 task 进 capabilities(契约没有 task/query 这两种 kind)",
  );
  ok(
    withHost.some((d) => d.id === "core.file.info" && (d.capabilities ?? []).includes("module:query") && d.source === "host:modules"),
    "host capability:query 种类进 capabilities,来源可覆盖",
  );
  // 不喂 hostCapabilities → 目录里就不该有它(不凭空造)。
  ok(
    !collectCapabilityInventory({ providers: [claudeProvider] }).some((d) => d.id === "core.file.inspect"),
    "host capability:没喂就不出现(不凭空造宿主能力)",
  );
  // 一个「需要宿主能力」的需求,喂了对应能力后应解析通过 —— 证明目录里那条真能被查到。
  const hostManifestCheck = validateNodeTypeManifest({
    id: "myorg.host",
    manifestVersion: 1,
    name: "Host",
    description: "Needs a host built-in capability.",
    runner: { kind: "code", language: "python" },
    capability: "exec",
    params: [],
  });
  ok(hostManifestCheck.ok, "host capability:测试清单本身合法");
  if (!hostManifestCheck.ok) throw new Error("unreachable");
  const needsHost = checkNodeCapabilities(hostManifestCheck.manifest, [{ kind: "builtin", id: "core.file.inspect" }], withHost);
  ok(needsHost.ok, "host capability:需要宿主能力的节点在喂进目录后解析通过");
  const withoutHost = checkNodeCapabilities(hostManifestCheck.manifest, [{ kind: "builtin", id: "core.file.inspect" }], collectCapabilityInventory({ providers: [claudeProvider] }));
  ok(!withoutHost.ok, "host capability:没喂时同一需求被判缺能力(证明上一条不是空过)");
}

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
const selectedPlugin = requirementsForNode(
  researchNodeCheck.manifest,
  { plugins: ["research-pack"], provider: "claude-sdk" },
  undefined,
  ["code"],
);
ok(
  checkNodeCapabilities(researchNodeCheck.manifest, selectedPlugin, fullInventory).ok,
  "enabled ecosystem plugins get an implicit plugin descriptor",
);
const piPlugin = requirementsForNode(
  researchNodeCheck.manifest,
  { plugins: ["research-pack"], provider: "pi-sdk" },
  undefined,
  ["code"],
);
ok(
  checkNodeCapabilities(researchNodeCheck.manifest, piPlugin, fullInventory).incompatible
    .some((problem) => problem.requirement.kind === "plugin"),
  "plugin provider applicability is rejected before dispatch",
);

const piWithMcp = requirementsForNode(
  researchNodeCheck.manifest,
  { provider: "pi-sdk", mcp: ["scholar-api"] },
  undefined,
  ["code"],
);
const piWithMcpResolution = checkNodeCapabilities(researchNodeCheck.manifest, piWithMcp, fullInventory);
ok(
  !piWithMcpResolution.ok &&
    piWithMcpResolution.incompatible.some((p) =>
      p.requirement.kind === "provider" && p.missingCapabilities.includes("mcp")),
  "Pi + MCP is rejected before dispatch because the provider lacks MCP capability",
);

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

if (!plainCheck.ok) throw new Error("unreachable");

/* ── 7. 健康预检只探测真正消费模型的节点 ── */
const commandCheck = validateNodeTypeManifest({
  id: "myorg.command", manifestVersion: 1, name: "Command",
  runner: { kind: "command" }, capability: "exec", params: [],
});
const conversationCheck = validateNodeTypeManifest({
  id: "myorg.conversation", manifestVersion: 1, name: "Conversation",
  runner: { kind: "conversation" }, capability: "write", params: [],
});
if (!commandCheck.ok || !conversationCheck.ok) throw new Error("health preflight fixtures must validate");
const healthManifests = new Map<string, NodeTypeManifest>([
  [plainCheck.manifest.id, plainCheck.manifest],
  [commandCheck.manifest.id, commandCheck.manifest],
  [conversationCheck.manifest.id, conversationCheck.manifest],
]);
const healthNode = (id: string, type: string, params: Record<string, unknown>): WorkflowNode => ({
  id, type, title: "", params, position: { x: 0, y: 0 },
});
ok(
  providerIdsForWorkflowPreflight(
    [healthNode("command", commandCheck.manifest.id, { provider: "codex-sdk" })],
    healthManifests, "claude-sdk",
  ).length === 0,
  "pure command workflows do not probe the host or an unused provider parameter",
);
ok(
  providerIdsForWorkflowPreflight(
    [healthNode("prompt", plainCheck.manifest.id, { provider: "codex-sdk" })],
    healthManifests, "claude-sdk",
  )[0] === "codex-sdk",
  "prompt workflows probe their explicit provider override",
);
const conversationProviders = providerIdsForWorkflowPreflight([
  healthNode("self", conversationCheck.manifest.id, {}),
  healthNode("origin", conversationCheck.manifest.id, { injectTarget: "origin" }),
], healthManifests, "claude-sdk", "pi-sdk");
ok(
  conversationProviders.includes("claude-sdk") && conversationProviders.includes("pi-sdk"),
  "conversation health targets follow self and origin execution sessions",
);
ok(
  providerIdsForWorkflowPreflight(
    [healthNode("origin", conversationCheck.manifest.id, { injectTarget: "origin" })],
    healthManifests, "claude-sdk",
  ).length === 0,
  "origin conversation without an origin avoids a misleading host health probe",
);

/* ── 8. 【ARC-008】三 SDK 会话/回调语义矩阵:形状 + 与三适配器源码逐格对账 ── */

// 矩阵必须覆盖三个内置引擎,且每行都覆盖全部能力 id(漏一格 = 界面/预检读到 undefined)。
ok(
  SEMANTICS_PROVIDER_IDS.every((id) => PROVIDER_SEMANTICS[id] !== undefined),
  "ARC-008:矩阵含三个内置引擎",
);
ok(
  SEMANTICS_PROVIDER_IDS.every((id) =>
    PROVIDER_SEMANTICS_CAPABILITY_IDS.every(
      (cap) => typeof PROVIDER_SEMANTICS[id].capabilities[cap]?.support === "string",
    ),
  ),
  "ARC-008:每格都有 support(不漏格)",
);
ok(
  Object.keys(PROVIDER_SEMANTICS).length === SEMANTICS_PROVIDER_IDS.length,
  "ARC-008:矩阵不夹带未声明的引擎",
);

// 矩阵 → 能力清单投影:只有 supported 进清单,interrupt/stopTask/onResumeOutcome 不投影。
{
  const pi = semanticsCapabilityIds("pi-sdk");
  ok(
    pi !== undefined && pi.includes("resume") && pi.includes("approval") && !pi.includes("mcp"),
    "ARC-008:Pi 投影出 resume/approval、**不**含 mcp(source 里 supportsMcp:false 的矩阵版)",
  );
  ok(
    pi !== undefined &&
      !pi.includes("interrupt") &&
      !pi.includes("stopTask") &&
      !pi.includes("onResumeOutcome"),
    "ARC-008:interrupt/stopTask/onResumeOutcome 是事实、不投影成清单 id",
  );
  ok(
    pi !== undefined &&
      PROVIDER_SEMANTICS_CAPABILITY_IDS.every(
        (cap) =>
          !SEMANTICS_INVENTORY_CAPABILITY_IDS.has(cap) ||
          pi.includes(cap) === (PROVIDER_SEMANTICS["pi-sdk"].capabilities[cap].support === "supported"),
      ),
    "ARC-008:投影只放 supported 的行",
  );
  ok(semanticsCapabilityIds("no-such-engine") === undefined, "ARC-008:未知引擎投影返回 undefined(调用方回退旗标)");
}

// 失败码事实:Claude 恢复无 FAILED 码、Pi 恢复无结构化码、Codex 有 app-server 码。
ok(
  semanticsFailureCodes("claude-sdk", "resume").includes("SDK_ERROR"),
  "ARC-008:Claude 恢复失败码 = SDK_ERROR",
);
ok(
  semanticsFailureCodes("pi-sdk", "resume").length === 0,
  "ARC-008:Pi 恢复失败**没有**结构化码(如实记 0,不编一个)",
);
ok(
  providerSemanticsOf("codex-sdk")?.capabilities.resume.support === "supported",
  "ARC-008:Codex 支持 thread/resume",
);

// 与三适配器源码逐格对账 —— 矩阵说「支持」的,适配器源码里必须有对应声明/调用;
// 说「不支持」的,源码里必须**没有**。漂了就红。
{
  const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
  const claudeSrc = src("src/main/providers/claude-sdk/ClaudeAgentSdkProvider.ts");
  const piSrc = src("src/main/providers/pi-sdk/PiAgentSdkProvider.ts");
  const codexSrc = src("src/main/providers/codex-sdk/CodexAgentSdkProvider.ts");

  // —— 旗标 ↔ 矩阵一致性(每个内置引擎) ——
  const sourceOf: Record<string, string> = {
    "claude-sdk": claudeSrc,
    "pi-sdk": piSrc,
    "codex-sdk": codexSrc,
  };
  // 能力 id → 适配器里那个布尔旗标在 capability 块里的字面名。
  const flagName: Record<string, string> = {
    approval: "supportsApproval",
    resume: "supportsResume",
    streaming: "supportsStreaming",
    mcp: "supportsMcp",
    askUserQuestion: "supportsAskUserQuestion",
    fork: "supportsFork",
    inject: "supportsInject",
    elicitation: "supportsElicitation",
    customSubagents: "supportsCustomSubagents",
  };
  for (const id of SEMANTICS_PROVIDER_IDS) {
    for (const cap of Object.keys(flagName) as ProviderSemanticsCapabilityId[]) {
      const matrixSays = PROVIDER_SEMANTICS[id].capabilities[cap].support === "supported";
      // 源码里出现 `flag: true` / `flag:true` 即视为适配器声明支持;缺席视为不支持。
      const declared = new RegExp(`${flagName[cap]}:\\s*true`).test(sourceOf[id]);
      ok(
        declared === matrixSays,
        `ARC-008:${id}.${cap} 矩阵(${matrixSays})与源码旗标(${declared})一致`,
      );
    }
  }

  // —— 事实行:与具体控制流对账 ——
  ok(
    PROVIDER_SEMANTICS["claude-sdk"].capabilities.stopTask.support === "supported" === claudeSrc.includes("stopTask:"),
    "ARC-008:Claude stopTask 行与源码(liveQuery.stopTask)一致",
  );
  ok(
    PROVIDER_SEMANTICS["pi-sdk"].capabilities.stopTask.support === "unsupported" && !/(^|\W)stopTask:/m.test(piSrc),
    "ARC-008:Pi 没有 stopTask,矩阵说不支持",
  );
  ok(
    PROVIDER_SEMANTICS["codex-sdk"].capabilities.stopTask.support === "unsupported" && !/(^|\W)stopTask:/m.test(codexSrc),
    "ARC-008:Codex 没有 stopTask,矩阵说不支持",
  );
  ok(
    PROVIDER_SEMANTICS["claude-sdk"].capabilities.inject.support === "supported" === /\binject:\s*\(/.test(claudeSrc),
    "ARC-008:Claude inject 行与源码(inject: (text))一致",
  );
  ok(
    PROVIDER_SEMANTICS["pi-sdk"].capabilities.inject.support === "unsupported" && !/\binject:\s*\(/.test(piSrc),
    "ARC-008:Pi 没有 inject,矩阵说不支持",
  );
  ok(
    PROVIDER_SEMANTICS["claude-sdk"].capabilities.fork.support === "supported" === claudeSrc.includes("async forkSession("),
    "ARC-008:Claude fork 行与源码(async forkSession)一致",
  );
  ok(
    PROVIDER_SEMANTICS["pi-sdk"].capabilities.fork.support === "unsupported" && !piSrc.includes("async forkSession("),
    "ARC-008:Pi 没有 forkSession,矩阵说不支持",
  );
  ok(
    PROVIDER_SEMANTICS["codex-sdk"].capabilities.fork.support === "unsupported" && !codexSrc.includes("async forkSession("),
    "ARC-008:Codex 没有 forkSession,矩阵说不支持",
  );
  // onResumeOutcome:三个引擎都必须如实报(ARC-008 的核心交付)。
  // Claude 那条在它的消息适配器里(init 时发),不在 provider 文件 —— 两家一起查。
  const claudeResumeSrc = claudeSrc + src("src/main/providers/claude-sdk/SdkMessageAdapter.ts");
  const resumeSourceOf: Record<string, string> = {
    "claude-sdk": claudeResumeSrc,
    "pi-sdk": piSrc,
    "codex-sdk": codexSrc,
  };
  for (const [id, s] of Object.entries(resumeSourceOf)) {
    ok(
      PROVIDER_SEMANTICS[id].capabilities.onResumeOutcome.support === "supported" === s.includes("onResumeOutcome"),
      `ARC-008:${id} 报 onResumeOutcome 与矩阵一致`,
    );
  }
  // 失败码事实与源码字面对账:Codex 的 CODEX_APP_SERVER_EXITED / CODEX_SDK_ERROR 必须在源码里。
  for (const code of semanticsFailureCodes("codex-sdk", "resume")) {
    ok(codexSrc.includes(`"${code}"`), `ARC-008:Codex 失败码 ${code} 在源码里`);
  }
  ok(claudeSrc.includes('"SDK_ERROR"'), "ARC-008:Claude 失败码 SDK_ERROR 在源码里");
}

/* ── 9. 【ARC-008】矩阵是生产预检的权威 —— providerCapabilityDescriptor 真的读它 ── */

// 反向判据:造一个**矩阵里有、但布尔旗标会漏报**的引擎。Pi 的矩阵说 mcp 不支持,
// 若 providerCapabilityDescriptor 只读旗标,Pi 的 descriptor 会…… 恰好也一样没有 mcp。
// 要证明「矩阵被读到」,用一个矩阵条目与旗标**故意不一致**的场景不合适(会破坏一致性
// 断言)。改用**正向**:内置引擎走矩阵投影,结果与矩阵 supported 行逐项相等;
// 且一个**矩阵里没有**的第三方引擎回退旗标(缺失即回退,不静默当成空能力)。
{
  const piProvider = { id: "pi-sdk", displayName: "Pi", capabilities: { supportsMcp: true } } as unknown as AgentProvider;
  const coreProvider = { id: "thirdparty-sdk", displayName: "Third", capabilities: { capabilityIds: ["streaming"] } } as unknown as AgentProvider;
  const descriptors = collectCapabilityInventory({ providers: [piProvider, coreProvider] });
  const piDesc = descriptors.find((d) => d.kind === "provider" && d.id === "pi-sdk");
  ok(
    piDesc !== undefined &&
      !(piDesc.capabilities ?? []).includes("mcp") &&
      !(piDesc.capabilities ?? []).includes("fork"),
    "ARC-008:预检清单里 Pi 的 descriptor 用矩阵投影(无 mcp/fork),不看自报旗标",
  );
  const thirdDesc = descriptors.find((d) => d.kind === "provider" && d.id === "thirdparty-sdk");
  ok(
    thirdDesc !== undefined && (thirdDesc.capabilities ?? []).includes("streaming"),
    "ARC-008:矩阵里没有的引擎回退 capabilityIds(不静默当成空能力)",
  );
}

console.log(`PASS: ${checks.length} checks`);