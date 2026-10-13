/**
 * **按引擎装配「模型会看到的工具」清单**(MC-100 / MC-101 诊断层,主进程)。
 *
 * 纯核在契约 `@contracts/effectiveToolInventory`(算字符 / token / 按来源聚合)。这里只做
 * 「从**各 provider 已有的**工具表里取描述符 → 翻成纯核要的 {@link EffectiveToolInput}」,
 * **绝不另造一份工具名单**(硬规矩 2:共享实现只有一份)。
 *
 * ## 它不改变任何 provider 行为(MC-100/101 的硬约束)
 *
 * 这个模块**只读**:它调用各生产者现成的构造函数(`libraryMcpTools()`、
 * `workflowEngineBridge.descriptors()`、Codex 的 `buildDynamicTools`…)**取值做统计**,
 * 不修改任何开关、不往任何 SDK 注册、不返回被 provider 消费的东西。Provider 该发什么还发
 * 什么 —— 这里回答的只是「按这套装配输入,模型**会**看到哪些、有多大」。
 *
 * ## 为什么放在主进程而不是契约
 *
 * 契约层不能 import 主进程的工具表(那些拖着 zod、DB、各 server 的构造)。契约那份是
 * **算法**(怎么算 token),这份是**装配**(从哪取描述符)。分开后契约那半能被任何引擎 /
 * 渲染端复用,主进程这半能直接吃三家的真实工具表。
 */
import {
  buildEffectiveToolInventory,
  type EffectiveToolEntry,
  type EffectiveToolInput,
  type EffectiveToolInventory,
  type EffectiveToolSource,
} from "@contracts/effectiveToolInventory";
import type { EngineToolEngineId } from "@contracts/ipc/engineTools";

import { agentToolDescriptors } from "@main/mcp/agentEngineBridge.js";
import { workflowEngineBridge } from "@main/mcp/workflowEngineTools.js";
import { memoryToolDescriptors } from "@main/memory/engineTools.js";
import { libraryToolDescriptors } from "@main/library/engineTools.js";
import { appToolDescriptors } from "@main/appControl/engineTools.js";
import { BROWSER_TOOL_SPECS } from "@main/browser/agentBrowserTools.js";
import { buildDynamicTools } from "@main/providers/codex-sdk/CodexAgentSdkProvider.js";
// 权威的「某引擎有哪些内置工具」清单(与设置面板「引擎工具」页同一份,见
// `ipc/engineTools.ts`)。刻意 import 而不是另抄:两处各写一份,改名时必漂。
import { KNOWN_BUILTIN_TOOLS } from "@main/ipc/engineTools.js";

/** 一个 host 内置/动态工具描述符 → 纯核输入。名字与 schema 原样保留。 */
function toInput(
  tool: { name: string; description?: string; inputSchema?: unknown },
  source: EffectiveToolSource,
): EffectiveToolInput {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema, source };
}

/** 宿主经进程内 MCP 注册给 **Claude** 的 server(`<server>` 是契约里的固定名)。 */
export interface ClaudeMcpInventoryInput {
  browserEnabled: boolean;
  /** 用户级 `.claude.json` / 项目 `.mcp.json` / 插件带来的 MCP server —— 它们的工具表在
   *  **SDK 侧**(二进制去连上才列表),宿主这里枚举不到,只能记下 server 名并在 notes 里
   *  如实标注「工具数未知」。 */
  unenumerableServerNames?: readonly string[];
  /** 引擎工具策略里被禁用的名字(见 `lib/engineToolPolicy.ts`)。 */
  excluded?: readonly string[];
}

/**
 * Claude 侧的有效工具清单。
 *
 * 名字用**模型实际看到**的形态:`mcp__<server>__<tool>`(SDK 就是这么把 MCP 工具暴露给
 * canUseTool 与模型的);内置工具用裸名(Claude Code 自身的 `Bash` / `Read`…)。
 *
 * ⚠️ **内置那份是近似**:`KNOWN_BUILTIN_TOOLS.claude` 是静态常见清单(见该常量注释),
 * 不是 SDK 权威枚举 —— 所以内置来源整体标一条 note,不当成精确值。
 */
export function claudeEffectiveToolInventory(input: ClaudeMcpInventoryInput): EffectiveToolInventory {
  const mcp = (server: string, tool: { name: string; description?: string; inputSchema?: unknown }): EffectiveToolInput =>
    toInput({ ...tool, name: `mcp__${server}__${tool.name}` }, `mcp:${server}` as EffectiveToolSource);

  const tools: EffectiveToolInput[] = [
    ...KNOWN_BUILTIN_TOOLS.claude.map((name) => ({ name, source: "builtin" as const })),
    // 骨干 server —— 与 ClaudeAgentSdkProvider 里 options.mcpServers 无条件挂的那几个同源。
    // 描述符取**同一份**生产者(Pi/Codex 桥用的那张表),不另抄工具名。
    ...libraryToolDescriptors().map((t) => mcp("mcode-library", t)),
    ...workflowEngineBridge.descriptors().map((t) => mcp("mcode-workflow", t)),
    ...memoryToolDescriptors().map((t) => mcp("mcode-memory", t)),
    ...appToolDescriptors().map((t) => mcp("mcode-app", t)),
    ...agentToolDescriptors().map((t) => mcp("mcode-agent-tools", t)),
  ];
  if (input.browserEnabled) {
    for (const spec of Object.values(BROWSER_TOOL_SPECS)) {
      tools.push(mcp("mcode-browser", { name: spec.name, description: spec.description }));
    }
  }

  const notes: string[] = [
    "Claude 内置工具名取自 KNOWN_BUILTIN_TOOLS(静态常见清单,非 SDK 权威枚举)。",
  ];
  if (input.browserEnabled) notes.push("含内建浏览器 server(mcode-browser):browserEnabled=true。");
  for (const server of input.unenumerableServerNames ?? []) {
    notes.push(`MCP server「${server}」的工具表在 SDK 侧(二进制连上才列表),宿主未计数。`);
  }

  return buildEffectiveToolInventory({
    providerId: "claude-sdk",
    tools,
    excludeTools: input.excluded,
    notes,
  });
}

/** Codex 侧:dynamicTools(`buildDynamicTools`)+ 恢复遗留。 */
export function codexEffectiveToolInventory(input: {
  browserEnabled: boolean;
  /** 恢复的线程仍带着、本轮已不再注册的旧工具(典型:关掉浏览器后旧 rollout 里的
   *  `browser_*`)。台账点名这一格必须显式可见。 */
  resumedLegacyTools?: readonly EffectiveToolInput[];
  excluded?: readonly string[];
}): EffectiveToolInventory {
  const dynamic = buildDynamicTools(input.browserEnabled);
  return buildEffectiveToolInventory({
    providerId: "codex-sdk",
    tools: dynamic.map((t) => {
      const rec = t as { name: string; description?: string; inputSchema?: unknown };
      return { name: rec.name, description: rec.description, inputSchema: rec.inputSchema, source: "dynamic" as const };
    }),
    excludeTools: input.excluded,
    resumedLegacyTools: input.resumedLegacyTools,
    notes: [
      "Codex 无按名禁用内置工具的入口(excludeTools 对 Codex 不适用);动态工具随 rollout 持久化。",
    ],
  });
}

/** Pi 侧:扩展 `registerTool` 注册的工具 + 内置。 */
export function piEffectiveToolInventory(input: {
  browserEnabled: boolean;
  excluded?: readonly string[];
}): EffectiveToolInventory {
  const tools: EffectiveToolInput[] = [
    ...KNOWN_BUILTIN_TOOLS.pi.map((name) => ({ name, source: "builtin" as const })),
    ...memoryToolDescriptors().map((t) => toInput(t, "dynamic")),
    ...appToolDescriptors().map((t) => toInput(t, "dynamic")),
    ...libraryToolDescriptors().map((t) => toInput(t, "dynamic")),
    ...workflowEngineBridge.descriptors().map((t) => toInput(t, "dynamic")),
    ...agentToolDescriptors().map((t) => toInput(t, "dynamic")),
    // Pi 的计划 / 提问工具由内联 Extension 注册(mcodeExtension.ts);schema 内联在那里,
    // 这里只按名计入并注明,不另抄一份 schema(见 notes)。
    { name: "AskUserQuestion", source: "dynamic" },
    { name: "EnterPlanMode", source: "dynamic" },
    { name: "ExitPlanMode", source: "dynamic" },
  ];
  if (input.browserEnabled) {
    for (const spec of Object.values(BROWSER_TOOL_SPECS)) {
      tools.push({ name: spec.name, description: spec.description, source: "dynamic" });
    }
  }
  return buildEffectiveToolInventory({
    providerId: "pi-sdk",
    tools,
    excludeTools: input.excluded,
    notes: [
      "Pi 的 AskUserQuestion / EnterPlanMode / ExitPlanMode schema 内联在 mcodeExtension.ts,本诊断不重复采计 schema 字节。",
      "Pi 内置工具名取自 KNOWN_BUILTIN_TOOLS(静态常见清单,非 SDK 权威枚举)。",
    ],
  });
}

/**
 * 按引擎分派 —— 三引擎同一入口,回 {@link EffectiveToolInventory}。
 * `opts` 对每个引擎取各自需要的字段(其余忽略)。
 */
export function buildEngineToolInventory(
  engine: EngineToolEngineId,
  opts: {
    browserEnabled: boolean;
    excluded?: readonly string[];
    unenumerableServerNames?: readonly string[];
    resumedLegacyTools?: readonly EffectiveToolInput[];
  },
): EffectiveToolInventory {
  switch (engine) {
    case "claude":
      return claudeEffectiveToolInventory({
        browserEnabled: opts.browserEnabled,
        unenumerableServerNames: opts.unenumerableServerNames,
        excluded: opts.excluded,
      });
    case "codex":
      return codexEffectiveToolInventory({
        browserEnabled: opts.browserEnabled,
        resumedLegacyTools: opts.resumedLegacyTools,
        excluded: opts.excluded,
      });
    case "pi":
      return piEffectiveToolInventory({ browserEnabled: opts.browserEnabled, excluded: opts.excluded });
  }
}

/** 便捷:从清单里取某来源的工具名集合(冒烟 / 诊断输出用)。 */
export function toolNamesOfSource(inventory: EffectiveToolInventory, source: EffectiveToolSource | string): string[] {
  return inventory.tools.filter((t: EffectiveToolEntry) => t.source === source).map((t) => t.name);
}
