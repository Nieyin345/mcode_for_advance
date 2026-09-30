/**
 * 进程内工具表 → **Pi / Codex** 的通用桥(2026-09-30)。
 *
 * Claude 经进程内 MCP server 拿到 mcode 自己那几套工具(库 / 工作流 / 记忆)。Pi 与 Codex
 * 没有进程内 MCP,于是这些工具在那两个引擎下原本一个都没有。内核工具应当与引擎无关 ——
 * 这里把「一份 `McpToolSpec[]` + 它的只读集合」变成两个引擎都能用的三样东西:
 *
 *   - `descriptors()`:名字 + 说明 + JSON Schema,给引擎注册(Pi `registerTool` / Codex 动态工具);
 *   - `invoke()`:按名字派发,入参先过同一份 zod schema(没有 SDK 兜着,必须自己校验);
 *   - `invokeGated()`:带审批的派发,给**没有工具守卫**的引擎(Codex)。
 *
 * ## 审批语义 —— 与 Claude 那条路(`toolRules.shouldAutoApprove`)一致
 *
 * 只读集合里的免问;写操作要用户点头,全放行档除外。闸门落在各引擎**自己的**通道上:
 * Pi 注册的工具天然经过 `mcodeExtension` 的 `tool_call` 守卫(那里用 `isReadonly` 放行只读的);
 * Codex 动态工具没有守卫,由 `invokeGated` 在调用前自己问。没有审批通道时**拒绝**,不静默放行。
 *
 * 纯模块:只依赖 zod 与 `./sdk.js`,工具表由调用方传进来 —— 各套工具的 import 图互不牵连
 * (库工具的冒烟不必拖进工作流那一整摊)。
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ProviderContext } from "@contracts/provider";
import { fail, type McpToolSpec, type ToolResult } from "./sdk.js";

export interface EngineToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface EngineBridge {
  /** 这个名字是不是这套工具里的。 */
  has(name: string): boolean;
  isReadonly(name: string): boolean;
  descriptors(): EngineToolDescriptor[];
  invoke(name: string, args: unknown, sessionId: string): Promise<ToolResult>;
  invokeGated(
    name: string,
    args: unknown,
    sessionId: string,
    ctx: ProviderContext,
    opts: { autoApprove: boolean },
  ): Promise<ToolResult>;
}

/**
 * @param label 出错时说「未知 X 工具」「X 写操作需要批准」里的那个 X(如「资料库」「工作流」)。
 * @param specs 工具表的取法。**每次现取**(与 `memory/engineTools.ts` 同):表本身是无状态的纯构造。
 */
export function makeEngineBridge(label: string, specs: () => McpToolSpec[], readonly: ReadonlySet<string>): EngineBridge {
  const find = (name: string): McpToolSpec | undefined => specs().find((tool) => tool.name === name);

  const invoke = async (name: string, args: unknown, sessionId: string): Promise<ToolResult> => {
    const spec = find(name);
    if (!spec) return fail(`未知${label}工具:${name}`);
    try {
      const input = z.object(spec.inputSchema).parse(args ?? {});
      return await spec.handler(input, { sessionId });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  };

  return {
    has: (name) => find(name) !== undefined,
    isReadonly: (name) => readonly.has(name),
    descriptors: () =>
      specs().map((spec) => ({
        name: spec.name,
        description: spec.description,
        inputSchema: zodToJsonSchema(z.object(spec.inputSchema), { target: "jsonSchema7", $refStrategy: "none" }) as Record<string, unknown>,
      })),
    invoke,
    invokeGated: async (name, args, sessionId, ctx, opts) => {
      let input = args;
      if (!readonly.has(name) && !opts.autoApprove && !(ctx.isToolAlwaysAllowed?.(name) ?? false)) {
        if (!ctx.requestApproval) return fail(`${label}写操作需要用户批准,但审批通道不可用;没有做任何修改。`);
        const decision = await ctx.requestApproval({ requestId: randomUUID(), toolName: name, input: args });
        if (!decision.allow) {
          return fail(decision.reason ? `用户未批准这次${label}操作:${decision.reason}` : `用户未批准这次${label}操作。`);
        }
        if (decision.updatedInput !== undefined) input = decision.updatedInput;
      }
      return invoke(name, input, sessionId);
    },
  };
}
