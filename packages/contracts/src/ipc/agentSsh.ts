/**
 * **Agent SSH 主机信任审批** —— IPC 契约(设置 → 远程主机信任)。
 *
 * ## 这一层补的是哪个洞(MC-014 / MC-052)
 *
 * `main/mcp/agentRemoteSsh.ts` 早就有 `HostTrustGrant`(绑定 `host:port` + `SHA256:`
 * 指纹、`approvalSource` 必须为 `"user"`、写盘失败拒绝认证)—— 但**没有任何宿主 IPC /
 * UI 入口调用 `grantHostTrust(`**。于是 SSH 首次连接拿到 `PENDING_CONFIRMATION` 后,
 * 普通用户在界面上**根本无法完成首次授信** —— 业务流程没闭环。
 *
 * 这一层是那扇**受信入口**:主进程受信 IPC(`agentSsh:approveHost`)在**用户真实操作**
 * 后签发限 `host:port` / `fingerprint` / `user` / 版本的授权,写盘并回读确认后才允许重试。
 * 模型**不能**经 `agent_ssh_connect` 的参数把候选指纹自复制成批准 —— 授权只从这条路产生。
 *
 * ## 为什么这两条 RPC 不能开给 agent
 *
 * 它们本身就是"用户点头"这件事的**唯一落点**。所以 `appControl/policy.ts` 把
 * `agentSsh.approveHost` 钉死在 `danger` 档(每次弹卡、不给"始终允许"、"完全访问"也照问);
 * 而**真正**成立的屏障是另一条:`agentMcpTools` 的 `app_api_call` **只**面向本机三个引擎,
 * 浏览器扩展 / 公网 MCP 那条路(`webToolHost`)**不挂**。换句话说,拿到公网链接的远端
 * 客户端根本够不到这条 RPC。
 */
import { z } from "zod";

/** 无参列表(保持 schema 一致,避免"空 object schema"那类坑)。 */
export const AgentSshListSchema = z.object({});
export type AgentSshListInput = z.infer<typeof AgentSshListSchema>;

/**
 * 一台**等待用户批准**的 SSH 主机 —— 界面上给用户"带外核对"的那一行。
 *
 * `fingerprint` 是**候选**指纹(服务器在这次握手里实际出示的),**不是**已批准的凭据;
 * 用户必须在别处(服务器控制台 / 管理员)核对它,再在这里点批准。
 */
export interface AgentSshPendingHost {
  /** `host:port`(与 known-hosts 键同形)。 */
  hostPort: string;
  /** 候选主机公钥指纹(OpenSSH `SHA256:` 形状)。 */
  fingerprint: string;
  host: string;
  port: number;
  username: string;
  /** 上一次握手失败的原因(供用户判断"为什么连不上")。 */
  lastError: string | null;
}

/** 一份**已签发**的宿主信任授权(界面"已信任主机"那一列)。 */
export interface AgentSshTrustedHost {
  hostPort: string;
  fingerprint: string;
  /** 批准时刻(ms epoch)。 */
  approvedAt: number;
  /** 授权凭据 id(审计用)。 */
  grantId: string;
}

/** OpenSSH `SHA256:` 指纹形状(与 `agentRemoteSsh.ts` 的 `SHA256_FP_RE` 逐字同形)。 */
const SHA256_FP_RE = /^SHA256:[A-Za-z0-9+/]{43}$/;

/**
 * 批准一台主机的某指纹。
 *
 * ⚠️ **`.strict()` 是承重的,不是洁癖**:`approvalSource` / `grantId` / `approvedAt` /
 * `version` **都由主进程签发**,调用方只能给 `hostPort` + `fingerprint` 这两个"批准什么"
 * 的坐标。给多一个字段(比如 `approvalSource: "agent"`)会被 schema 直接拒 ——
 * 于是"自批自己"这条路从**契约层**就断了,而不是靠 handler 里一句 if 兜着。
 */
export const AgentSshApproveInputSchema = z
  .object({
    hostPort: z.string().min(1).max(300),
    fingerprint: z.string().regex(SHA256_FP_RE),
  })
  .strict();
export type AgentSshApproveInput = z.infer<typeof AgentSshApproveInputSchema>;

/** 撤销某 `host:port` 的授权(用户撤回批准)。 */
export const AgentSshHostPortSchema = z
  .object({ hostPort: z.string().min(1).max(300) })
  .strict();
export type AgentSshHostPortInput = z.infer<typeof AgentSshHostPortSchema>;
