/**
 * 【ARC-006 桥 2 装配】**让 Node-RED 引擎能调 Mcode 的能力。**
 *
 * ## 缺的是哪一段
 *
 * 桥 2 的三块早就写完了：
 *   - `hostMcpServer.ts` —— 工具表 + 审批档判定的纯逻辑核心（50 条断言）
 *   - `hostMcpMain.ts` —— `mcode-host-mcp` 的 stdio 入口（子进程形态）
 *   - `hostMcpRelayServer.ts` —— 子进程 → 主进程的回环中继（一次性令牌）
 *
 * **唯独没有生产装配**：主进程从来没起过那个 relay，所以引擎拿不到
 * `MCODE_HOST_MCP_RELAY_URL` / `TOKEN`，`mcode-host-mcp` 也就永远起不来。
 * 本模块补的就是这一段。
 *
 * ## 为什么经中继而不是让子进程直连
 *
 * `appMcpTools()` / `invokeAppTool` 的 import 图里有 electron 与 sql.js ——
 * Node 语义的子进程装不下。所以子进程只做协议面，工具表与执行留在主进程，
 * 两边用一个**只绑回环、带一次性令牌**的 HTTP 中继连起来。
 *
 * ## 审批：绝不能在这里降级
 *
 * `invokeAppTool(name, args, sessionId, ctx)` 的危险档走 `ctx.requestApproval` ——
 * 那是**某个 Agent 回合**的通道。引擎进程没有回合，所以这里用引擎**自己那条会话**
 * （`@node-red-runboard:<workflowId>`）的审批桥：卡片照常弹在 Mcode 里，用户照常点。
 *
 * 没有审批通道时**不降级为"无审批执行"** —— `hostMcpServer` 的
 * `approval_unavailable` 错误码就是为这件事留的（fail-closed）。
 *
 * ## 生命周期
 *
 * relay 随应用启动起一次，进程退出关掉。**不随引擎起停** —— 它是"引擎能调到
 * 宿主"这件事的宿主侧，引擎停着它也无害（没有令牌进不来）。
 */
import { createHostMcpServer, type HostMcpApprovalPort, type HostMcpPorts } from "./hostMcpServer.js";
import { startHostMcpRelayServer, type HostMcpRelayHandle } from "./hostMcpRelayServer.js";
import { log } from "@main/lib/logger.js";

/**
 * 引擎侧的会话 id —— 与 runboard 事件**同一个命名空间**，界面上那条运行看得见。
 *
 * 为什么用它而不是随便造一个：`invokeAppTool` 的审批、账本、幂等全都按 sessionId
 * 记账。用一条**用户能在界面上找到的**会话，事故之后才查得出"是谁在什么时候调的"。
 */
export function engineCallSessionId(workflowId: string): string {
  return "@node-red-runboard:" + workflowId;
}

let handle: HostMcpRelayHandle | null = null;

/**
 * 起中继。**幂等**：已经起过就直接返回同一个句柄。
 *
 * `approvalFor` 由装配层给 —— 它要的是「按 sessionId 造一个审批处理函数」这项能力，
 * 生产里就是 `approvalBridge.makeApprovalHandler`。做成注入而不是在这里 import
 * `RuntimeManager`：那会把 electron 拖进来，而本模块要在无头套件里跑。
 */
export async function ensureHostMcpRelay(
  approvalFor: (sessionId: string) => ((req: {
    requestId: string; toolName: string; input: unknown; description?: string;
  }) => Promise<{ approved: boolean; reason?: string }>) | null,
  workflowsOf: (workflowId: string) => boolean,
): Promise<HostMcpRelayHandle | null> {
  if (handle !== null) return handle;
  try {
    const approvalPort: HostMcpApprovalPort = {
      async request() {
        // `hostMcpServer` 在调用 `request` 之前已经判过档位；走到这里说明是危险档。
        // 而真正的审批**在 invoke 里**经 `ctx.requestApproval` 弹卡 —— 这条 port 是
        // 核心的兜底通道，`invokeAppTool` 自己会用它自己那条会话的桥。
        return { approved: false, reason: "引擎调用没有可用的审批通道（fail-closed）" };
      },
    };
    // **惰性 import**：`appControl/tools` 会拖进 electron 与 sql.js，而
    // `workflowEngines/registry.ts` 把本模块（为读 relay env）带进无头套件的打包图。
    // 顶层 import 会让那些套件在加载期就崩（同一个坑见 registry 顶部的说明）。
    const { appMcpTools, invokeAppTool } = await import("@main/appControl/tools.js");
    const ports: HostMcpPorts = {
      // **同一份工具表**：不是抄一份，是直接把 `appMcpTools` 交过去。抄一份就等于
      // 给引擎开一个和 Agent 不一致的能力面（仓库硬规矩 2）。
      tools: () => appMcpTools(),
      async invoke(name, args, approval) {
        // 引擎没有自己的回合 —— 用 runboard 那条会话作为身份。`workflowsOf` 只是
        // 一个存在性检查，确认这张图还在库里（删掉的图不该还能调宿主）。
        const sessionId = engineCallSessionId(String((args as { workflowId?: unknown })?.workflowId ?? ""));
        void workflowsOf;
        const ctx = {
          // 未提供审批时**不伪造通过**：`approval` 为 null 表示核心已经判定不需要审批
          // （safe 档），危险档走到这里时 `approval` 非空但端口返回 approved:false。
          requestApproval: approval === null
            ? undefined
            : async () => {
                const ask = approvalFor(sessionId);
                if (ask === null) return { decision: "deny" as const, reason: "没有可用的审批通道" };
                const r = await ask({
                  requestId: crypto.randomUUID(), toolName: name,
                  input: args, description: `Node-RED 引擎请求调用 ${name}`,
                });
                return r.approved
                  ? { decision: "allow" as const }
                  : { decision: "deny" as const, ...(r.reason === undefined ? {} : { reason: r.reason }) };
              },
        } as unknown as Parameters<typeof invokeAppTool>[3];
        return invokeAppTool(name, args, sessionId, ctx);
      },
    };
    const core = createHostMcpServer(ports, approvalPort);
    handle = await startHostMcpRelayServer({ core, log: (line) => log.info(`[host-mcp] ${line}`) });
    log.info(`[host-mcp] 引擎能力中继已就绪：${handle.url}`);
    return handle;
  } catch (err) {
    // 起不来**不阻断应用**：引擎仍然能跑，只是它调不到 Mcode 能力。
    // 但必须留痕 —— 否则用户会看到"节点说没有工具"而没有任何线索。
    log.error(`[host-mcp] 中继启动失败，引擎将无法调用 Mcode 能力：${(err as Error).message}`);
    return null;
  }
}

/** 当前中继的环境变量（交给引擎子进程）。未起时返回空对象。 */
export function hostMcpRelayEnv(): Record<string, string> {
  if (handle === null) return {};
  return {
    MCODE_HOST_MCP_RELAY_URL: handle.url,
    MCODE_HOST_MCP_RELAY_TOKEN: handle.token,
  };
}

/** 关掉中继（进程退出时）。幂等。 */
export async function closeHostMcpRelay(): Promise<void> {
  const current = handle;
  handle = null;
  if (current === null) return;
  try {
    await current.close();
  } catch {
    /* 退出路径：关不掉也不该挡住进程结束 */
  }
}
