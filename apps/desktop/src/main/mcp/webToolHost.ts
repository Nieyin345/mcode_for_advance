/**
 * **网页端工具宿主** —— 浏览器里那个扩展通过 `POST /mcp` 调过来时,真正干活的人。
 *
 * ## 它拿的是同一份工具表
 *
 * 工具表([libraryMcpTools] / [workflowMcpTools] / [agentMcpTools])就是进程内那些
 * server 用的那份,这里只是**换一种包装**:那边包给 SDK(`toSdkTools`),这边包成
 * {@link McpToolHost} 报给扩展。基础声明共用；公网再经 publicToolSpecs 的精简只读适配表，
 * 不把本机工作流、完整 Agent 或全局技能暴露出去。桌面内部工具不随公网合并。
 *
 * agent 工具段(`agent_*`,读/写/编辑/列目录/glob/grep/bash/技能)是网页端自己的
 * "通用 agent 基础操作":桌面 claude 引擎有原生 Read/Write/Bash,网页模型没有 ——
 * 这一组把同样的能力经 MCP 补给它。它们不在任何 SDK server 里注册(桌面端用不着),
 * 只活在这张表里;cwd 从 `deps.cwdFor` 按会话取,相对路径一律相对会话的工作目录。
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
 * ①「始终允许」→ ② 权限模式放行(只读工具 / bypass)→ ③ dontAsk 直接拒 →
 * ④ 弹卡问人。判定本身也共用同一个纯函数,所以两条通路不会漂移。
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
import { compactPublicTools, PUBLIC_TOOL_MIGRATIONS } from "@main/mcp/publicToolSpecs.js";
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
import { workflowMcpTools } from "@main/mcp/mcodeServer.js";
import { agentMcpTools } from "@main/mcp/agentTools.js";
import { LIBRARY_READONLY_TOOLS, libraryMcpTools } from "@main/mcp/libraryServer.js";
import type { LibraryForAi, SandboxReadCheck } from "@main/mcp/sandboxReadPolicy.js";
// ⚠️ 这张表**平时是空的** —— `mcode_agent_*`(把 mcode agent 整个交给外面的 AI 支使)
// 只在用户亲手打开那个开关后才报出来。引它是安全的:那个文件只依赖 zod 与类型,真正
// 要碰 db/RuntimeManager 的那一半在 `delegateHost.ts`(见它文件头为什么拆两个)。
import { delegateMcpTools } from "@main/mcp/delegateServer.js";
import type { McpToolSpec } from "@main/mcp/sdk.js";
// annotations 的判定从 `toolRules` 直接取(不经 `providers/toolGate.js`)—— 那条链会拉进
// 整个 provider 图,而无头 smoke 只想验工具表。toolRules 本身在 `mcp/` 下,引它安全。
import { annotationsForTool } from "@main/mcp/toolRules.js";

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
  /** 会话 id → 工作目录(agent_* 文件工具的相对路径基准)。
   *  取不到(会话没跑过、项目没有路径)时给 null,agent 工具对相对路径报错。 */
  cwdFor(sessionId: string): string | null;
  /**
   * 会话 id → **沙箱根**(可选)。给了就只允许该目录底下的文件路径,越界拒绝。
   * 只有公网那条通路(免审批)需要它;桌面本机会话不给 = 不限制。
   * 见 `agentTools.ts` 的 `resolveAgainstCwd` —— 它约束文件工具,不约束 bash。
   */
  sandboxRootFor?(sessionId: string): string | null;
  /**
   * **测试用**:额外挂进这张表的工具声明。生产**不要传**。
   *
   * 存在的理由:这张表原来硬挂 `libraryMcpTools()`,而那 22 个库工具已经从网页端
   * 撤掉(见下面 `createWebToolHost` 里那段)。但 `mcp-endpoint-smoke` 要验的是
   * **这张表的派发与闸门**(会话缺失拒、参数校验、只读放行 / 写弹卡 / 拒了不执行),
   * 它需要几件**形状各异**的替身工具来把这些分支踩出来 —— 与"库里有哪些工具"无关。
   * 所以给它一个注入点,而不是让生产硬挂一张它已经不要的表。
   */
  extraTools?: McpToolSpec[];
  /**
   * 公网沙箱外的只读名单(资料库 / 技能库)—— 生产由 `main/index.ts` 传
   * `sandboxReadPolicy.ts` 的那份;不给 = 沙箱外一律拒。走注入是因为那条链要拉库模块,
   * 无头 smoke 的 bundle 装不下。
   */
  sandboxReadCheck?: SandboxReadCheck;
  /** `agent_context` 资料库清单的给 AI 口径,同上由 `main/index.ts` 传。 */
  libraryForAi?: LibraryForAi;
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
  return shapeToJsonSchema(spec.inputSchema);
}

/** 一份 zod 裸 shape → MCP 要的 JSON Schema。inputSchema / outputSchema 同一套转法。 */
function shapeToJsonSchema(shape: Record<string, z.ZodTypeAny>): Record<string, unknown> {
  const schema = zodToJsonSchema(z.object(shape), {
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
/** 工具的 `outputSchema` 若没自己声明，用这一个。
 *
 * ## 为什么需要它（以及为什么它是诚实的）
 *
 * ChatGPT 的开发者模式**对每个工具**都提示「建议添加 outputSchema」。而 MCP 规范要求：
 * **声明了 outputSchema 就必须返回符合它的 `structuredContent`**，否则严格客户端让这次
 * 调用**直接失败**（`mcp-outputschema-must-pair-structuredcontent` 那条记忆记的坑）。
 *
 * 所以两条路:① 给 39 个工具各手写一份 schema;② 给"只返回一段文本"的那些一个统一的
 * 形状 —— 它们**确实只有一段文本**,`{ text }` 就是它的真身,不是编出来的字段。
 *
 * 选 ②。手写 39 份的结果大半是敷衍的空壳(编几个对不上的字段),那比不写更坏:
 * 模型会以为那些字段有内容。真正有结构化价值的那些（进程/任务/搜索/环境）**各自
 * 另写了 schema**,不走这个默认。
 *
 * ⚠️ **每个 schema 都必须有 `text`，且只有它必填。** `callTool` 那边**总是**把文本
 * 投影塞进 `structuredContent.text`（见那里），所以"这一支只回文本"（错误、列表、
 * 空结果）永远合规 —— 不用每个分支都编一份完整对象。
 */
const DEFAULT_TEXT_OUTPUT_SHAPE: Record<string, unknown> = {
  type: "object",
  properties: { text: { type: "string", description: "工具返回的文本内容" } },
  required: ["text"],
};

export function createWebToolHost(deps: WebToolHostDeps): McpToolHost {
  // ⚠️ **网页端不再挂 `libraryMcpTools()`。**
  //
  // 那 22 个库工具是"库是文献库"那个时代留下的:检索、加论文、查期刊分区、模版库……
  // 用户要的是**通用文档管理**,资料库的内容用通用文件工具就能读(库是磁盘上的真目录,
  // 见 `library/paths.ts`),库里有什么改用 `agent_context` 一次问清(见那边)。
  //
  // **桌面引擎那条路照旧挂着它**(`ClaudeAgentSdkProvider` 的 `buildLibraryMcpServer`)
  // —— 那边没有 `agent_*` 那套文件工具,库工具是它读资料库的唯一通道,摘掉就瞎了。
  // 所以这一行只影响浏览器里的扩展/网页端(它走的是这张表)。
  const agentSpecs = agentMcpTools({
    cwdFor: deps.cwdFor,
    sandboxRootFor: deps.sandboxRootFor,
    sandboxReadCheck: deps.sandboxReadCheck,
    libraryForAi: deps.libraryForAi,
  });
  // ── 公网那张表(ChatGPT 直连,2026-10-02 用户定):**不给工作流那组**(工作流 / 自动化
  // 不需要远程 AI 去改),**给资料库的只读那组**(用户要远程 AI「能看我的资料库」)。
  // 资料库的写工具(搬、删、改名、写笔记、导入)一个都不给 —— 这条路免审批。
  // 库里的文件本身用 `agent_read_*` 读；公网额外禁止全局技能，技能只属于绑定项目(见
  // `sandboxReadPolicy.ts`,守屏蔽规则)。
  // `extraTools`(测试替身)不进这张表 —— 公网表要验的就是生产给出去的那一份。
  const publicSpecs = compactPublicTools(agentSpecs, libraryMcpTools().filter(spec => LIBRARY_READONLY_TOOLS.has(spec.name)), sessionId => deps.sandboxRootFor?.(sessionId) ?? null);
  // ── 本机浏览器扩展那张表(`/mcp`):照旧。
  const specs: McpToolSpec[] = [
    // ⚠️ **`includeSessionLogs: false`（2026-09-24）—— 读用户对话记录那组工具
    // 不给公网。** 用户明确要求「公网不给」。
    //
    // 理由：这条路是**免审批**的（合成会话 `bypassPermissions`），而
    // `session_read_log` + `session_list` 合起来 = 枚举这台机器上**每一个项目**的
    // 对话并读它们的全文。拿到那条公网链接的人就能读光用户所有的对话记录。
    // 从前只靠"模型拿不到 id"挡着，而 `session_list` 一加就把这道天然闸门拆了 ——
    // 所以在**这条**通路上把整组摘掉（见 `SESSION_LOG_TOOLS`）。
    //
    // ⚠️ **代理间通信那三个工具走在同一条 filter 上**（`AGENT_MAIL_TOOLS`），而且理由
    // 更硬：这条路是免审批的，而 `agent_notify` / `agent_ask` 能**叫醒本机的会话**
    // （替它起一轮，让它真的去动文件），`agent_peers` 能读到本机有哪些会话。
    // `includeSessionLogs` 这个名字是历史遗留 —— 它管的是"用户自己的会话这一摊"，
    // 不止日志。
    //
    // 桌面本机那条路照旧带着它们（`buildWorkflowMcpServer` 不传这个参数）。
    ...workflowMcpTools({ includeSessionLogs: false }),
    ...agentSpecs,
    // 「指挥本机 agent 干整件事」那一组(`delegateMcpTools`)**不在这张静态表里** ——
    // 见下面 listTools / callTool:它每次现问开关。
    // 测试注入的替身工具(生产为空)—— 见 `WebToolHostDeps.extraTools`。
    ...(deps.extraTools ?? []),
  ];
  const byName = new Map(specs.map((spec) => [spec.name, spec]));
  const byNamePublic = new Map(publicSpecs.map((spec) => [spec.name, spec]));
  /**
   * 每个工具**实际报给客户端**的那份 outputSchema。规则：
   *  - 工具自己声明了 → 用它，但**保证 `text` 在里面**（见下），否则"只回文本"的
   *    分支会违反自己的 schema；
   *  - 没声明 → 用默认的那个（只有 `text`）。
   */
  const outputSchemaOf = (spec: McpToolSpec): Record<string, unknown> => {
    if (!spec.outputSchema) return DEFAULT_TEXT_OUTPUT_SHAPE;
    const shape = shapeToJsonSchema(spec.outputSchema);
    const props = (shape.properties ?? {}) as Record<string, unknown>;
    return {
      ...shape,
      properties: {
        ...props,
        // `callTool` 总是把文本投影塞进 `text` —— schema 里不能认它的话，客户端会因
        // "多出一个未声明的字段"而拒绝（取决于校验严格程度）。所以补上。
        text: { type: "string", description: "工具返回的文本内容（总会给）" },
      },
      // ⚠️ **只有 `text` 进 required，且放开 `additionalProperties`。** 一个工具的不同
      // 分支返回**不同形状**（`agent_process_read` 省略 `process_id` 时是"列进程"、
      // 不是一次读取结果；`agent_skill` 的 list 分支另给 `has_more`/`next_offset`）。
      // 而 `zodToJsonSchema` 会把声明里的字段全列进 `required`、并置
      // `additionalProperties:false` —— 于是那些分支要么缺必填字段、要么多出未声明字段，
      // 严格客户端直接判这次调用失败。声明里的具名属性仍描述**类型**（模型据此读字段），
      // 但"哪些字段这一支真的有"由返回值决定，不由 schema 钉死。
      required: ["text"],
      additionalProperties: true,
    };
  };
  let listed: McpToolInfo[] | null = null;
  let listedPublic: McpToolInfo[] | null = null;
  const toInfo = (spec: McpToolSpec): McpToolInfo => ({
    name: spec.name,
    description: spec.description,
    inputSchema: toJsonSchema(spec),
    // 行为提示 —— ChatGPT 靠 readOnlyHint 决定要不要弹确认框(见 toolRules)。
    annotations: annotationsForTool(spec.name),
    // **每个工具都报 outputSchema**（没声明的用默认那个）—— ChatGPT 的开发者
    // 模式对每个工具都提示"建议添加 outputSchema"，而声明了就必须回匹配的结构化
    // 结果（见 DEFAULT_TEXT_OUTPUT_SHAPE 那段）。两者在 `callTool` 里一起兜住。
    outputSchema: outputSchemaOf(spec),
  });
  /** Keep local delegation's existing dynamic dependency/enablement behavior.
   * Public MCP must never append or dispatch these tools, even if an old saved
   * flag is enabled or a client retained their former tool names. */
  const delegateSpecs = (): McpToolSpec[] => delegateMcpTools();

  return {
    listTools(audience): McpToolInfo[] {
      const dynamic = audience === "public" ? [] : delegateSpecs();
      let base: McpToolInfo[];
      if (audience === "public") {
        if (!listedPublic) listedPublic = publicSpecs.map(toInfo);
        base = listedPublic;
      } else {
        if (!listed) listed = specs.map(toInfo);
        base = listed;
      }
      return dynamic.length ? [...base, ...dynamic.map(toInfo)] : base;
    },

    /** 旧(已合并)工具名 → 新用法。`handleCall` 在 `callTool` 之前就把表里没有的名字
     *  挡掉了,所以迁移提示必须在那一层问得到(见 `McpToolHost.migrationHint`)。 */
    migrationHint(name): string | undefined {
      return Object.hasOwn(PUBLIC_TOOL_MIGRATIONS, name) ? PUBLIC_TOOL_MIGRATIONS[name] : undefined;
    },

    async callTool(name, args, ctx): Promise<McpToolCallResult> {
      const table = ctx.audience === "public" ? byNamePublic : byName;
      const spec = table.get(name) ?? (ctx.audience === "public" ? undefined : delegateSpecs().find((s) => s.name === name));
      // 到这儿还没有:要么名字根本不存在(`handleCall` 已用协议错挡过一遍,这里只有
      // 绕开 `handleCall` 的直接调用者会撞到),要么公网会话要一个只在 local 表的工具。
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

      const mode = gate.permissionMode();
      const autoAllowed = gate.isAlwaysAllowed(name) || shouldAutoApproveWebTool(mode, name);
      if (!autoAllowed) {
        // dontAsk:不弹审批。走到这里说明它既不是只读、也没被「始终允许」放行 ——
        // 按 SDK 的定义直接拒,而不是把卡弹出来(弹了就等于 default,用户选这档
        // 本来就是不想被打断)。
        if (mode === "dontAsk") {
          return {
            text: `当前是「不询问」权限模式,${name} 没有被预先允许,未执行。请让用户用「始终允许」提前批准它,或切换到别的权限模式。`,
            isError: true,
          };
        }
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

      const out = await spec.handler(parsed.data, { sessionId, audience: ctx.audience === "public" ? "public" : "local" });
      const textProjection = out.content
        .filter((c): c is Extract<(typeof out.content)[number], { type: "text" }> => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      return {
        text: textProjection,
        content: out.content,
        ...(out.isError ? { isError: true } : {}),
        // **总是带上 `structuredContent`，且 `text` 一定在里面。**
        //
        // 因为每个工具都报了 outputSchema（见 `listTools`），而规范要求声明了就必须
        // 回匹配的结构化结果 —— 缺了会让严格客户端把这次调用判成失败。
        // 工具有自己的字段就带上真字段（进程的 cursor、搜索的 count……）；
        // 没有（错误分支、列表、只回文本的那些）就至少给 `{ text }`，那正是它返回的
        // 全部内容 —— 不是编的。
        structuredContent: { ...(out.structuredContent ?? {}), text: textProjection },
      };
    },
  };
}
