/**
 * **网页端工具宿主** —— 浏览器里那个扩展通过 `POST /mcp` 调过来时,真正干活的人。
 *
 * ## 它拿的是同一份工具表
 *
 * 工具表([libraryMcpTools] / [workflowMcpTools])就是进程内那两个 server 用的那份,
 * 这里只是**换一种包装**:那边包给 SDK(`toSdkTools`),这边包成
 * {@link McpToolHost} 报给扩展。所以"网页端能调什么"永远等于"桌面端能调什么" ——
 * 加一个工具只需要在表里加一处,不会出现"桌面有、网页没有"的漏项。
 *
 * 入参校验也用**同一份 zod shape**:SDK 那条路由 SDK 按 `inputSchema` 校验,这边由
 * {@link createWebToolHost} 自己 `z.object(shape).safeParse`。校验不过就当一次
 * **失败的结果**回给模型(它能自己改参数重试),不是协议错误。
 *
 * ## 审批:复用 mcode 现有的闸门,不新造机制
 *
 * 工具调用要用户点头时,**走的就是界面上那些审批卡** —— `ApprovalBridge` 的
 * `approval.request` 事件 → `ApprovalCard` → `claude:approve` IPC → 同一个
 * `resolveApproval`。于是权限模式、「始终允许」、跨端同步的 `request.resolved`
 * 全部自动继承(用户的原话:"这个决策和 mcode 的设置一样啊")。
 *
 * 顺序与 Claude 那条通路逐字一致(见 `toolGate.ts`):
 * ①「始终允许」→ ② 权限模式放行(只读工具 / bypass / dontAsk)→ ③ 弹卡问人。
 * 判定本身也共用同一个纯函数,所以两条通路不会漂移。
 *
 * 差别只有两处,都是**通路性质**决定的:
 *   - 名字是裸的(`library_search`,没有 `mcp__mcode-library__` 前缀)—— 扩展是标准
 *     MCP 客户端,它拿到的就是裸名,所以判定走 `shouldAutoApproveWebTool`;
 *   - 弹卡时人在浏览器里,卡片出现在 mcode 窗口上。这是这一期的已知取舍:用户可能
 *     看不见那个窗口。真机用起来别扭的话,下一步是把卡片的提示同步到扩展那侧
 *     (扩展已经有回传通道,不用新开)。
 *
 * ## 没有会话就不放行
 *
 * 闸门的两个状态(权限模式、「始终允许」)都是**按会话**记的,拿不到会话就没有闸门 ——
 * 那时只能拒绝(见 `mcpEndpoint.ts` 的 `MCODE_SESSION_HEADER`)。宁可让模型收到
 * "这次调用没带会话标识",也不能在没有闸门的情况下静默执行写操作。
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { PermissionMode } from "@contracts/runtime";
import type { ApprovalRequest, ProviderApprovalDecision } from "@contracts/provider";
import { shouldAutoApproveWebTool } from "@main/providers/toolGate.js";
import type {
  McpToolCallResult,
  McpToolHost,
  McpToolInfo,
} from "@main/providers/bridge/mcpEndpoint.js";
// ⚠️ 这两个用 `@main/...` 而不是相对路径(同 `toolGate.ts` 的写法)。除了风格一致,
// 还有个具体理由:无头 smoke 是靠 esbuild 的 `--alias:@main/mcp/libraryServer.js=…`
// 换掉整张库表的,而 alias 只按**写下来的那个 specifier**匹配 —— 写成 `./libraryServer.js`
// 就换不掉,真那份会被打进 bundle 并且在模块载入时去找真的 sql.js 库。
import { libraryMcpTools } from "@main/mcp/libraryServer.js";
import { workflowMcpTools } from "@main/mcp/mcodeServer.js";
import type { McpToolSpec } from "@main/mcp/sdk.js";

/**
 * 一次调用的闸门句柄 —— 由 `RuntimeManager` 按会话给出(见那边的 `webToolGate`)。
 *
 * 三个方法就是闸门需要的**全部**:当前模式、「始终允许」的记录、以及"弹一张卡并等
 * 用户点"。刻意不把 `ApprovalBridge` 整个交出去:宿主不该有能力去 resolve 别人的
 * 请求,也不该看见别的会话的状态。
 */
export interface WebToolGate {
  permissionMode(): PermissionMode | undefined;
  isAlwaysAllowed(toolName: string): boolean;
  requestApproval(req: ApprovalRequest): Promise<ProviderApprovalDecision>;
}

export interface WebToolHostDeps {
  /** 会话 id → 闸门。会话不存在(或已经收场)时给 null。 */
  gateFor(sessionId: string): WebToolGate | null;
}

/** 没带会话标识时的回话。写清楚"怎么修"——模型唯一能做的就是告诉用户。 */
const NO_SESSION_TEXT =
  "这次调用没有带会话标识(请求头 x-mcode-session 为空),所以没有审批闸门可用,已拒绝。" +
  "这通常是扩展没配对好,请让用户在 mcode 的网页版设置里重新连接扩展。";

function describeIssues(err: z.ZodError): string {
  return err.issues
    .map((i) => `${i.path.length > 0 ? i.path.join(".") : "(根)"}: ${i.message}`)
    .join(";");
}

/**
 * 工具表的 zod shape → MCP 要的 JSON Schema。
 *
 * `$refStrategy: "none"` 是必须的:默认策略会把复用的子 schema 抽到 `$defs` 里再用
 * `$ref` 指过去,而 MCP 客户端(以及它背后的模型)读到的 `inputSchema` 是一棵**平铺**的
 * 树 —— 遇到 `$ref` 只能靠猜。就地展开就没有这个问题。
 */
function toJsonSchema(spec: McpToolSpec): Record<string, unknown> {
  const schema = zodToJsonSchema(z.object(spec.inputSchema), {
    target: "jsonSchema7",
    $refStrategy: "none",
  }) as Record<string, unknown>;
  // `$schema` 是"这份 schema 用的是哪版 JSON Schema",留给校验器看的。MCP 的
  // `inputSchema` 本身就在 `tools/list` 的 JSON 里,带上它只是噪声。
  delete schema.$schema;
  return schema;
}

/**
 * 装配真实宿主。`main/index.ts` 用 `runtimeManager` 当 `gateFor` 调它。
 *
 * 工具表在**第一次** `listTools()` 时才转 JSON Schema:二十几个 zod 树转换不该挂在
 * 应用启动的那条路上,而扩展连上来之前根本没人问这张表。
 */
export function createWebToolHost(deps: WebToolHostDeps): McpToolHost {
  const specs: McpToolSpec[] = [...libraryMcpTools(), ...workflowMcpTools()];
  const byName = new Map(specs.map((spec) => [spec.name, spec]));
  let listed: McpToolInfo[] | null = null;

  return {
    listTools(): McpToolInfo[] {
      if (!listed) {
        listed = specs.map((spec) => ({
          name: spec.name,
          description: spec.description,
          inputSchema: toJsonSchema(spec),
        }));
      }
      return listed;
    },

    async callTool(name, args, ctx): Promise<McpToolCallResult> {
      const spec = byName.get(name);
      if (!spec) return { text: `没有这个工具:${name}`, isError: true };

      const sessionId = ctx.sessionId;
      if (!sessionId) return { text: NO_SESSION_TEXT, isError: true };
      const gate = deps.gateFor(sessionId);
      if (!gate) {
        return {
          text: `这次调用挂着的会话(${sessionId})不在 mcode 里,已拒绝 —— 请让用户重新发起一次对话。`,
          isError: true,
        };
      }

      const parsed = z.object(spec.inputSchema).safeParse(args ?? {});
      if (!parsed.success) {
        return { text: `参数不合法,${describeIssues(parsed.error)}`, isError: true };
      }

      const autoAllowed =
        gate.isAlwaysAllowed(name) || shouldAutoApproveWebTool(gate.permissionMode(), name);
      if (!autoAllowed) {
        const decision = await gate.requestApproval({
          requestId: randomUUID(),
          toolName: name,
          input: parsed.data,
          description: "来自网页版模型的工具调用(在浏览器里发起)",
        });
        if (!decision.allow) {
          return {
            text:
              "用户拒绝了这次调用。" +
              (decision.reason ? `理由:${decision.reason}` : "") +
              "不要换个说法重试同一个动作。",
            isError: true,
          };
        }
      }

      const out = await spec.handler(parsed.data, { sessionId });
      return { text: out.content.map((c) => c.text).join("\n") };
    },
  };
}