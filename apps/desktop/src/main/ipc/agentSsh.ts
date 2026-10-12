/**
 * IPC handlers for the **agent SSH host-trust approval** panel (设置 → 远程主机信任).
 *
 * ## 这一层是什么(MC-014 / MC-052)
 *
 * `main/mcp/agentRemoteSsh.ts` 早就有 `HostTrustGrant`,但 `grantHostTrust(` **只有定义、
 * 没有宿主入口** —— SSH 首连拿到 `PENDING_CONFIRMATION` 后,普通用户在界面上根本没法完成
 * 首次授信。这三条 RPC 就是那扇门:
 *
 *   - `agentSsh:list`        —— 列出待批准候选指纹 + 已信任主机(只读);
 *   - `agentSsh:approveHost` —— **用户真实操作**后,由主进程签发 `approvalSource:"user"`
 *     授权,写盘 + 回读确认。`approvalSource` **由这里写死**,调用方给不了(见 schema 的
 *     `.strict()`);
 *   - `agentSsh:revokeHost`  —— 撤回批准。
 *
 * ## 为什么可以只用 `agentRemoteSsh.js`,不 import `agentTools.js`
 *
 * 授权那几条(`grantHostTrust` / `revokeHostTrustGrant` / `listHostTrustGrants` /
 * `listPendingHostTrust`)都是 `agentRemoteSsh.ts` 导出的**纯函数**,不依赖 manager 实例。
 * 因此这里只 import 那一个模块 —— 不把 `agentTools → 整个 provider 图` 拉进主进程 IPC
 * 的打包链(那正是 `main/index.ts` 注释里反复警告的那条链)。
 */
import type { IpcMain } from "electron";
import {
  IPC,
  AgentSshListSchema,
  AgentSshApproveInputSchema,
  AgentSshHostPortSchema,
} from "@contracts/ipc";
import {
  grantHostTrust,
  revokeHostTrustGrant,
  listHostTrustGrants,
  listPendingHostTrust,
  forgetPendingHostTrust,
  knownHostsStoreInvalid,
  findHostTrustGrant,
} from "@main/mcp/agentRemoteSsh.js";
import { log } from "@main/lib/logger.js";

export function registerAgentSshHandlers(ipcMain: IpcMain): void {
  // ── 列出待批准候选 + 已信任主机 ──
  ipcMain.handle(IPC.AGENT_SSH_LIST, (_evt, raw) => {
    // 无参方法,同 `mcp:list`:app_api_call 省略 input 时 raw 是 undefined。
    AgentSshListSchema.parse(raw ?? {});
    return {
      pending: listPendingHostTrust(),
      trusted: listHostTrustGrants(),
      storeInvalid: knownHostsStoreInvalid(),
    };
  });

  // ── 批准某 host:port 的某指纹(宿主签发 user 授权) ──
  ipcMain.handle(IPC.AGENT_SSH_APPROVE_HOST, (_evt, raw) => {
    const input = AgentSshApproveInputSchema.parse(raw);
    // ⚠️ `approvalSource` **写死为 "user"** —— 这是宿主受信 IPC,不是 agent 工具。
    //    schema 是 `.strict()`,调用方多给字段直接在这里被拒;这里更不能再从 input 读来源。
    const grant = grantHostTrust({
      hostPort: input.hostPort,
      fingerprint: input.fingerprint,
      approvalSource: "user",
    });
    if (!grant) {
      // 写盘失败 / 指纹畸形 / 授权表损坏 —— 一律 ok:false,界面显示"授权未生效"。
      return { ok: false, error: "授权未写入:指纹无效或信任表不可写(可能已损坏)" };
    }
    // **回读确认**:只有真的落盘、且读回来的就是我们刚签的那一份,才算批准成立。
    // (grantHostTrust 内部已 try/catch 写盘,这里再读一次是为了承认"写成功但读不回"也是失败。)
    const readBack = findHostTrustGrant(input.hostPort);
    if (!readBack || readBack.fingerprint !== grant.fingerprint || readBack.grantId !== grant.grantId) {
      log.warn(`agentSsh: 授权写入后回读不一致(hostPort=${input.hostPort});按未生效处理`);
      return { ok: false, error: "授权回读不一致:未生效,请重试" };
    }
    // 该主机不再是"待批准"。
    forgetPendingHostTrust(input.hostPort);
    return {
      ok: true,
      grant: {
        hostPort: grant.hostPort,
        fingerprint: grant.fingerprint,
        approvedAt: grant.approvedAt,
        grantId: grant.grantId,
      },
    };
  });

  // ── 撤销某 host:port 的授权(用户撤回批准 / 不批准这个候选) ──
  ipcMain.handle(IPC.AGENT_SSH_REVOKE_HOST, (_evt, raw) => {
    const input = AgentSshHostPortSchema.parse(raw);
    const ok = revokeHostTrustGrant(input.hostPort);
    if (!ok) return { ok: false, error: "撤销失败:信任表不可写(可能已损坏)" };
    // 「不批准这个候选」也走这里 —— 把候选从待批准表里清掉,否则它会一直挂在面板上。
    // 这**不改** known-hosts / 其他授权,下一次该主机再来时仍会作为新候选出现。
    forgetPendingHostTrust(input.hostPort);
    return { ok: true };
  });
}
