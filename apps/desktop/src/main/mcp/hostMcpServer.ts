/**
 * **mcode-host-mcp 的纯逻辑核心** —— ARC-006 桥 2(`Node-RED → Mcode`)的第一个可测切片。
 *
 * ## 这是什么 / 不是什么
 *
 * 桥 2 的落法是一个 stdio MCP server(`mcode-host-mcp`,与 `genoffice mcp` 同一种形态):
 * 引擎(Node-RED)作为标准 MCP 客户端连上来,`tools/call` 经宿主转到主进程的
 * `invokeAppTool`。**本文件只做那个 server 的纯逻辑核心**:
 *
 *   - 工具表:`ports.tools()` 原样注入 —— 生产装配传 `appMcpTools()` 的**同一份**,
 *     本核心不另写表、不筛选、不加工具;
 *   - 请求分发:未知工具 / 参数不合 `inputSchema` 一律明确失败,不抛异常穿透、不静默;
 *   - 审批纪律:审批端口(`HostMcpApprovalPort`)可注入;write / danger 档没有端口 =
 *     不可弹卡 = **fail-closed**,绝不降级为无审批执行。
 *
 * **不在这里的**(留 U1):真实 stdio 传输、JSON-RPC 帧、主进程 IPC 中继、审批卡在
 * 宿主 UI 的弹出与回填 —— 那些依赖宿主装配与真 Electron。本文件不 import electron,
 * 也不起任何进程/端口。
 *
 * ## 危险判据 —— 全部来自 `appControl` 既有那一份,不新造
 *
 * 一个 app 工具调用的"档"不是工具名能单独回答的(`app_api_call` 里读设置和删项目是
 * 两回事),所以这里按 (name, args) 逐调用分档,判据逐条引用既有实现:
 *
 *   - `app_api_call`:方法档 = `findEntry(method).policy.level`(`policy.ts` 的
 *     `policyFor`:BLOCKED → 凭据本体 → DANGER → EXPLICIT → 动词兜底)。**不在目录里
 *     的方法**归 safe:`invokeAppTool` 在任何副作用之前就明确拒绝(`methodNotFound`),
 *     Agent 侧也从不为它弹卡;blocked 同为 safe(执行器直接拒,不弹卡)。
 *   - `app_ui`:`runUiAction` 里只有两处 `gateAppAction` —— `set_pref`
 *     (permissionMode = danger,其余 = write)与 `interrupt_session`(write);其余动作
 *     (切会话/开文件/弹提示/读面板……)Agent 侧**不 gate**,这里同为 safe。
 *   - 其余自带工具:只读集合 `APP_READONLY_TOOLS`(`tools.ts` 的**唯一一份**)里的 =
 *     safe;剩下的自带工具(`app_session_new` / `app_session_send` /
 *     `app_workflow_run` / `app_workflow_publish` / `app_workflow_unpublish`)在 Agent
 *     侧无条件 `gateAppAction("write")`,这里为 write。
 *
 * ## 没有审批端口时的行为(与 Agent 侧逐档对齐)
 *
 *   - safe(read / ui,以及由执行器直接拒绝的 blocked / 未知方法):直接执行 —— Agent 的
 *     `gateAppAction` 对 read/ui 直接放行,不需要任何审批通道;
 *   - write / danger:明确失败(`approval_unavailable`),**不执行** —— Agent 的
 *     `gateAppAction` 在 `!ctx.requestApproval` 时同样返回
 *     「当前环境没有可用的审批通道,为安全起见未执行。」(fail-closed)。
 *
 * 调用方**不能**用参数伪造批准:分档只看 (name, args) 里的方法与动作,任何
 * `approved: true` 之类的字段都不参与判据;传给 `invoke` 的是 `inputSchema` 校验后的
 * 参数(zod 默认剥掉未声明字段),伪造位连执行器都到不了。
 *
 * ## 生产装配的契约(留给 U1)
 *
 *   - `ports.tools()` 必须是 `appMcpTools()`(同一份;`listTools()` 只是把它投影成
 *     MCP 要的 JSON Schema,与 `appToolDescriptors()` 同一套转换,不是第二张表);
 *   - `ports.invoke()` 必须是**共享执行器** `invokeAppTool`(同一套策略/审批/账本)。
 *     审批已由本核心经端口完成 —— 装配时不得再弹第二张卡(danger 已在核心问过),
 *     怎么把「已批准」交给执行器由 U1 的宿主装配决定;
 *   - 审批端口就是「宿主 UI 还活着、卡弹得出来」的那条桥;端口为 null = 不可弹卡。
 */
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { fail, text, type ToolResult } from "./sdk.js";
import { APP_READONLY_TOOLS, findEntry } from "@main/appControl/tools.js";

/** 注入表里一个工具的形状 —— 与 `McpToolSpec` 的声明字段同形(handler 由 `invoke` 承担)。 */
export interface HostMcpToolSpec {
  name: string;
  description: string;
  /** zod 裸 shape(同 `McpToolSpec.inputSchema`)。生产装配传 `appMcpTools()` 的同一份。 */
  inputSchema: Record<string, z.ZodTypeAny>;
}

/** MCP `tools/list` 的一项(同一份表的 JSON Schema 投影)。 */
export interface HostMcpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * 审批端口 —— 「宿主 UI 还活着、审批卡弹得出来」的那条桥。
 * 没有这个端口 = 不可弹卡 = write / danger 一律 fail-closed(见文件头)。
 * `request` 收到的 `args` 已过 `inputSchema` 校验(未声明字段已被剥掉)。
 */
export interface HostMcpApprovalPort {
  request(name: string, args: unknown): Promise<{ approved: boolean; reason?: string }>;
}

/** 可注入的宿主端口(生产装配:tools = appMcpTools 的同一份;invoke = invokeAppTool)。 */
export interface HostMcpPorts {
  tools(): ReadonlyArray<HostMcpToolSpec>;
  /**
   * 执行一个**已通过校验(与必要审批)**的调用。生产装配必须是共享执行器
   * `invokeAppTool` —— 同一套策略/审批/账本;不得在这里再弹第二张卡(审批由本核心完成)。
   */
  invoke(name: string, args: unknown, approval: HostMcpApprovalPort | null): Promise<unknown>;
}

/** 一个调用的审批档。 */
export type HostMcpTier = "safe" | "write" | "danger";

/** 核心层明确拒绝的四种原因 —— 调用方按码区分,不靠猜文本。 */
export type HostMcpErrorCode = "unknown_tool" | "invalid_arguments" | "approval_unavailable" | "approval_denied";

export interface HostMcpServer {
  /** 注入表的原样引用 —— 不复制、不筛选、不排序。 */
  tools(): ReadonlyArray<HostMcpToolSpec>;
  /** MCP `tools/list` 形状:同一份表的 JSON Schema 投影(与 `appToolDescriptors()` 同一套转换)。 */
  listTools(): HostMcpToolDescriptor[];
  /** MCP `tools/call`:校验 → 分档 → 审批 → 转发执行。失败一律以 `isError` 结果返回,不抛。 */
  callTool(name: string, args: unknown): Promise<ToolResult>;
}

/**
 * 一个调用落在哪一档 —— 判据见文件头「危险判据」,全部取自 `appControl` 既有实现。
 *
 * ⚠️ 公开导出是为了让测试与 U1 装配共用**同一份**分档,不是为了在这里再维护一张表:
 * 加/改档位请改 `policy.ts` / `tools.ts` 那一份,这里只负责读。
 *
 * `args` 预期是**已过 inputSchema 校验**的参数;未校验的裸输入也不会误判(safe 兜底是
 * "交给执行器",执行器自己会先校验/拒绝)。
 */
export function approvalTierOf(name: string, args: unknown): HostMcpTier {
  const a = (args !== null && typeof args === "object" ? args : {}) as Record<string, unknown>;
  if (name === "app_api_call") {
    const method = typeof a.method === "string" ? a.method.trim() : "";
    const entry = method ? findEntry(method) : undefined;
    // 不在目录里(也没注册)的方法 = 执行器在**任何副作用之前**明确拒绝(methodNotFound),
    // Agent 侧同样不弹卡 —— 与"blocked"同一种「不执行、不用问」。
    if (!entry) return "safe";
    switch (entry.policy.level) {
      case "danger":
        return "danger";
      case "write":
        return "write";
      default:
        return "safe"; // read / ui / blocked(blocked 由执行器直接拒,不弹卡)
    }
  }
  if (name === "app_ui") {
    // 与 `runUiAction` 里两处 gateAppAction 逐条对应(唯一两处会弹卡的 UI 动作)。
    const action = typeof a.action === "string" ? a.action : "";
    if (action === "set_pref") return a.key === "permissionMode" ? "danger" : "write";
    if (action === "interrupt_session") return "write";
    return "safe";
  }
  // 其余工具:只读集合是 `APP_READONLY_TOOLS`(tools.ts 的唯一一份);不在里面的自带工具
  // 在 Agent 侧无条件 gateAppAction("write")。
  return APP_READONLY_TOOLS.has(name) ? "safe" : "write";
}

/** 核心层的明确拒绝:可区分的稳定码 + 一句人话。 */
function toolError(code: HostMcpErrorCode, message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true, structuredContent: { host_mcp_error: code } };
}

/** zod 校验失败的逐条说明(与 `webToolHost.describeIssues` 同一口径,不塞内部对象)。 */
function describeIssues(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.length > 0 ? i.path.join(".") : "(根)"}: ${i.message}`).join(";");
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 执行器的返回值统一成 MCP 结果:`ToolResult` 原样透传,其余包装成一段文本。 */
function asToolResult(value: unknown): ToolResult {
  if (value !== null && typeof value === "object" && Array.isArray((value as ToolResult).content)) {
    return value as ToolResult;
  }
  const body = typeof value === "string" ? value : JSON.stringify(value);
  return text(body ?? "完成(无返回值)");
}

/**
 * 装配核心。
 *
 * @param ports    工具表 + 执行器(见 {@link HostMcpPorts} 的契约)。
 * @param approval 审批端口;`null` / 省略 = 不可弹卡,write / danger 一律 fail-closed。
 */
export function createHostMcpServer(
  ports: HostMcpPorts,
  approvalPort?: HostMcpApprovalPort | null,
): HostMcpServer {
  const approval = approvalPort ?? null;

  const findSpec = (name: string): HostMcpToolSpec | undefined =>
    ports.tools().find((tool) => tool.name === name);

  return {
    tools: () => ports.tools(),

    listTools: () =>
      ports.tools().map((spec) => ({
        name: spec.name,
        description: spec.description,
        // 与 `appControl/engineTools.ts` 的 `appToolDescriptors()` **同一套转换**:
        // `$refStrategy: "none"` 让 MCP 客户端拿到一棵平铺树,不必解 $ref。
        inputSchema: zodToJsonSchema(z.object(spec.inputSchema), {
          target: "jsonSchema7",
          $refStrategy: "none",
        }) as Record<string, unknown>,
      })),

    async callTool(name, rawArgs) {
      const spec = findSpec(name);
      if (!spec) {
        return toolError(
          "unknown_tool",
          `未知的 Mcode 控制工具:${name}。工具表与 Agent 的 appMcpTools() 是同一份,没有第二张表;` +
            `先用 tools/list 看有哪些工具。`,
        );
      }
      const parsed = z.object(spec.inputSchema).safeParse(rawArgs ?? {});
      if (!parsed.success) {
        return toolError("invalid_arguments", `参数不合法,${describeIssues(parsed.error)}。未执行。`);
      }
      // 校验后的参数(未声明字段已被 zod 剥掉)—— 分档、审批、执行都只用这一份。
      const args = parsed.data as Record<string, unknown>;

      const tier = approvalTierOf(name, args);
      if (tier !== "safe") {
        if (!approval) {
          return toolError(
            "approval_unavailable",
            tier === "danger"
              ? `「${name}」这一步是高风险操作,每次都需要用户本人批准;` +
                `当前没有可用的审批通道,按 fail-closed 原则未执行(不会降级为无审批执行)。`
              : `「${name}」这一步需要用户批准;` +
                `当前没有可用的审批通道,按 fail-closed 原则未执行(不会降级为无审批执行)。`,
          );
        }
        let decision: { approved: boolean; reason?: string };
        try {
          decision = await approval.request(name, args);
        } catch (err) {
          // 端口在,但请求本身失败(宿主窗口没了 / 桥断了)—— 同样不得放行。
          return toolError(
            "approval_unavailable",
            `审批通道请求失败(${errText(err)});按 fail-closed 原则未执行。`,
          );
        }
        if (decision?.approved !== true) {
          const why = typeof decision?.reason === "string" ? decision.reason.trim() : "";
          return toolError(
            "approval_denied",
            tier === "danger"
              ? `用户拒绝了这次高风险操作${why ? `:${why}` : ""};未执行。`
              : `用户拒绝了这次操作${why ? `:${why}` : ""};未执行。`,
          );
        }
      }

      try {
        return asToolResult(await ports.invoke(name, args, approval));
      } catch (err) {
        return fail(`执行「${name}」时出错:${errText(err)}`);
      }
    },
  };
}
