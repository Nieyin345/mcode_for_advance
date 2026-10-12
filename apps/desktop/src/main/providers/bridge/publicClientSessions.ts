/**
 * **公网 MCP 的"哪次客户端对话"标识** —— MC-063 要拆的短期身份那一层。
 *
 * ## 为什么要有它
 *
 * 一个项目链接(credential)会被**多个 ChatGPT 对话复用**。在那之前,mcode 把它们
 * 全归到同一条合成会话,于是几个对话共用一个 owner:互相能读/写/停对方的进程与 SSH,
 * 还挤同一份 8 进程 / 12 搜索配额(见 MC-063)。
 *
 * 修法:长期凭据(`credentialId/projectId`)与短期调用者(`clientSessionId`)分开。
 * 短期标识由**服务端签发**(标准 MCP Streamable HTTP 的 `Mcp-Session-Id` 握手:
 * `initialize` 回一个,客户端后续请求原样带回来),服务端据此把"哪次对话"从共享链接里
 * 分出来,资源(进程/搜索/SSH)按它分桶。
 *
 * ## 不信任外部随意带的会话头作为 owner
 *
 * 只有**本服务签发过、且绑定到同一条凭据**的 id 才算一个独立 owner。客户端带一个我们
 * 没签发过的 `Mcp-Session-Id`(或带别的凭据签发的那条)→ 落到 `legacy:<credentialId>`,
 * 与其它"不会做握手"的老客户端**共享一个 legacy owner** —— 这正是文档写明的
 * legacy shared-workspace 模式,不会因为它乱带 header 就白得一个新 owner。
 *
 * 即便有人反复 `initialize` 铸造新 owner 想绕开 per-owner 配额,也绕不过资源管理器里的
 * **端点/项目全局上限**(见 `agentProcessSessions` / `agentSearchSessions` 的 `*_TOTAL`)。
 *
 * ## 纯模块
 *
 * 只 import `node:crypto`,不碰 electron/db —— 入口(impure 的 `publicMcpSession`)直接
 * 用它,无头 smoke 也能单独断言它。
 */
import { randomUUID } from "node:crypto";

interface IssuedSession {
  credentialId: string;
  at: number;
}

/** 已签发的客户端会话。进程内存 —— 重启后旧 id 作废(客户端会重新 initialize)。 */
const issued = new Map<string, IssuedSession>();

/** 上限,防被反复 initialize 灌爆内存。超了先淘汰最老的。 */
const MAX_ISSUED = 4096;

/** 不会做握手的老客户端共用的 owner —— 每个凭据一个,对应 legacy shared-workspace。 */
export function legacyClientSessionId(credentialId: string): string {
  return `legacy:${credentialId}`;
}

/** 签发一个新的客户端会话,绑定到这条凭据。`initialize` 回它,客户端后续带回来。 */
export function issueClientSession(credentialId: string): string {
  const id = `pcs_${randomUUID()}`;
  issued.set(id, { credentialId, at: Date.now() });
  if (issued.size > MAX_ISSUED) {
    const oldest = [...issued.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, issued.size - MAX_ISSUED);
    for (const [key] of oldest) issued.delete(key);
  }
  return id;
}

/**
 * 解析这次调用该用哪个 owner id。
 *
 * - 客户端带回了**本服务为同一条凭据签发过**的 id → 用它的 id(该对话自己的桶);
 * - **完全没带** header(不会做握手的老客户端)→ `legacy:<credentialId>`,与其它老客户端
 *   共享 —— 这正是文档写明的 legacy shared-workspace 模式;
 * - 其它一切情况(带的是没签发过的 / 别的凭据签发的 / **签发过但已失效**)→
 *   【MC-063 / 第 43.4 节】**不**降级到 legacy,而是返回 `null`(由调用方拒掉)。
 *
 * ⚠️ 从前"带了已失效的 id"与"没带"都落到 `legacy:<credentialId>`。那不是安全降级:
 * 一个**主动声明过身份、但身份已不可验证**的请求,不该因此获得任何共享 owner 的能力
 * (它能读/写/停 legacy 桶里别人的进程与 SSH)。已失效 → 要求重新握手,绝不分到 legacy。
 */
export type ClientSessionResolution =
  | { kind: "valid"; sessionId: string }
  | { kind: "legacy"; sessionId: string }
  | { kind: "expired" };

export function resolveClientSessionDetailed(
  credentialId: string,
  headerValue: string | null | undefined,
): ClientSessionResolution {
  const value = (headerValue ?? "").trim();
  // 完全没带 header → 老客户端走 legacy 共享桶(合法)。
  if (!value) return { kind: "legacy", sessionId: legacyClientSessionId(credentialId) };
  const rec = issued.get(value);
  if (rec && rec.credentialId === credentialId) return { kind: "valid", sessionId: value };
  // 带了 header 但不可验证(没签发过 / 别的凭据 / 已淘汰 / 进程重启丢失)→ 拒。
  return { kind: "expired" };
}

/**
 * 兼容薄壳(旧调用点):返回 owner id,或 `null` 表示"带了 header 但已失效、必须拒"。
 * 新代码请用 {@link resolveClientSessionDetailed} 拿可判别状态。
 */
export function resolveClientSession(credentialId: string, headerValue: string | null | undefined): string | null {
  const r = resolveClientSessionDetailed(credentialId, headerValue);
  return r.kind === "expired" ? null : r.sessionId;
}

/** 测试用:清空已签发集合(每套用例从干净状态开始)。 */
export function __resetPublicClientSessions(): void {
  issued.clear();
  syntheticOwners.clear();
}

/* ─────────────── 合成会话 → 它名下出现过的 owner(删除清理用) ─────────────── */

/**
 * 每条合成会话(「ChatGPT 直连」那条可见的对话)名下**出现过哪些 owner**。
 *
 * 资源(进程/搜索/SSH)现在按**客户端会话**分桶(MC-063),而不是按合成会话;于是
 * 「用户删掉那条合成会话」时,`rowDeletion` 拿到的还是合成会话 id —— 需要据此把该
 * 合成会话名下**所有**客户端 owner 一并释放,否则删了对话还留着在跑的进程/SSH。
 *
 * 纯内存、无上限压力:条目数 = 合成会话数 × 其名下对话数,天然很小。
 */
const syntheticOwners = new Map<string, Set<string>>();

/** 记一条「合成会话 → 客户端 owner」的归属(入口签出快照时调用)。 */
export function rememberSyntheticOwner(syntheticSessionId: string, ownerId: string): void {
  let set = syntheticOwners.get(syntheticSessionId);
  if (!set) {
    set = new Set();
    syntheticOwners.set(syntheticSessionId, set);
  }
  set.add(ownerId);
}

/**
 * 该 (可能被删的)会话名下所有 owner id。`sessionId` 本身**总是**包含在内 ——
 * 本机那条路的资源直接按会话 id 存,删除时同样要放。
 */
export function ownersForSession(sessionId: string): string[] {
  const owners = new Set<string>([sessionId]);
  for (const owner of syntheticOwners.get(sessionId) ?? []) owners.add(owner);
  return [...owners];
}

/** 会话被删:清掉它的归属记录(资源由调用方按 {@link ownersForSession} 释放)。 */
export function forgetSyntheticSession(sessionId: string): void {
  syntheticOwners.delete(sessionId);
}
