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

/**
 * 【MC-089】被淘汰的客户端会话 id —— 淘汰只是把 id 从 {@link issued} 删掉,让它不可再认证;
 * 但它名下**记录过的 owner**(见 {@link syntheticOwners})不会因此消失。若不联动回收,
 * 反复 initialize 会让 `syntheticOwners` 只涨不落(独立复核实测:4400 次签发 → 归属 4401 条,
 * 而最早的身份早已失效)。这里把**刚被淘汰**的 id 记下来,供 {@link pruneOrphanedOwners} 判断
 * 「这个 owner 的会话已失效」。
 */
const evicted = new Set<string>();

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
    for (const [key] of oldest) {
      issued.delete(key);
      // 记下淘汰 —— 归属回收据此判定「这个 owner 的会话已失效」(见 pruneOrphanedOwners)。
      evicted.add(key);
    }
    // 淘汰集本身也要有界:被回收后出队的 id 从 evicted 里清掉(见 pruneOrphanedOwners 的 finally);
    // 这里再兜一个上限,防止「淘汰了但用户一直不回收」把它撑大。
    if (evicted.size > MAX_ISSUED) {
      const drop = [...evicted].slice(0, evicted.size - MAX_ISSUED);
      for (const k of drop) evicted.delete(k);
    }
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
  evicted.clear();
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

/* ─────────────── 【MC-089】淘汰会话的归属回收 ─────────────── */

/**
 * **在途资源探针** —— 某个(可能已被淘汰的)owner 名下**是否还有活资源**(运行中的进程 /
 * 后台搜索 / 未关闭的 SSH 连接)。
 *
 * ## 为什么用「注册」而不是直接 import
 *
 * 本模块是**纯**的(只 import `node:crypto`),而那三个资源管理器是进程级单例、住在
 * `main/mcp/agentTools.ts` —— 直接 import 会把 electron/db/ssh2 整条图拉进来,无头
 * smoke 就断言不了本模块。于是反过来:谁持有那三个管理器,谁在模块加载时把自己的探针
 * **注册**进来(与 `main/mcp/agentSessionCleanup.ts` 的 disposer 注册同一个套路)。
 *
 * ## 它补的洞(MC-089 的「在途资源」那一半)
 *
 * 只有归属记录回收还不够 —— 台账写的是「**仍有任务的 owner 受控保留**」。一个 owner 的
 * 客户端会话即便已被淘汰(旧 id 不可再认证),它**名下还在跑的进程/搜索/SSH 不该被静默
 * 丢掉归属**:丢了就再没人知道「这条老对话名下有活资源」,删合成会话时也释放不到它。
 * 所以 {@link pruneOrphanedOwners} 回收前先问探针 —— 有活资源的孤儿 owner **保留**。
 */
type OwnerWorkProbe = (ownerId: string) => boolean;
const workProbes = new Set<OwnerWorkProbe>();

/** 登记一个「这个 owner 还有在途资源吗」的探针;返回注销函数。 */
export function registerOwnerWorkProbe(fn: OwnerWorkProbe): () => void {
  workProbes.add(fn);
  return () => {
    workProbes.delete(fn);
  };
}

/**
 * 任一探针报「有」即视为有在途资源(**保守:宁可多留,不误删活资源**)。
 *
 * 探针抛错也按「有任务」处理 —— 探针的职责恰是"别让活资源被回收",它失灵时**不能反过来
 * 把 owner 当空闲而误删**(坏东西显式保留,不静默丢失)。
 */
function ownerHasInFlightWork(ownerId: string): boolean {
  for (const probe of workProbes) {
    try {
      if (probe(ownerId)) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/** 一次归属回收的结果 —— 如实报出收回了哪些、保留了哪些(不静默)。 */
export interface OwnerPruneReport {
  /** 被回收的 owner:会话**已被淘汰**且**名下无在途资源**,归属记录可以清。 */
  pruned: string[];
  /**
   * **受控保留**的孤儿 owner:会话已被淘汰,但**名下还有在途资源**(运行的进程 / 搜索 /
   * SSH)—— 台账要求「仍有任务的 owner 受控保留」,这里不动它。等资源自己结束(下次
   * prune 再收)、或用户删合成会话时由 `ownersForSession` 统一释放。
   */
  keptBusy: string[];
  /** **因不归本模块管而保留**的 owner:legacy(`legacy:<credentialId>`)或本机会话 id。 */
  keptLegacy: string[];
  /** 仍在用的 owner 数(会话仍有效)—— 保留,不动。 */
  retained: number;
}

/**
 * **回收「客户端会话已被淘汰」的孤儿归属**。返回被清掉的 owner、受控保留的忙于 owner、
 * 及保留数。
 *
 * ## 它补的洞(MC-089)
 *
 * {@link issueClientSession} 超上限时会把最老的 id 从 `issued` 删掉 —— 那个 id **不再能认证**。
 * 但 {@link rememberSyntheticOwner} 早先记下的「合成会话 → 这个 owner」**不会跟着删**,
 * 于是 `syntheticOwners` 只涨不落(独立复核实测 4400 次签发 → 归属 4401 条,而最早的身份早失效)。
 *
 * ## 判据(刻意保守:只清**确定失效且空闲**的)
 *
 *  - 一个 owner 若**仍是** `issued` 里有效的会话 id → **保留**(它还在用);
 *  - legacy owner(`legacy:<credentialId>`)→ **保留**(老客户端没生命周期,不该被清);
 *  - 本机那条路直接用会话 id 做 owner(id 里不带 `pcs_` 前缀)→ **保留**(不归本模块管);
 *  - 形如本服务签发过(`pcs_` 前缀)、**已被淘汰**、**但探针报名下还有在途资源**
 *    (运行中的进程/搜索/SSH)→ **受控保留**({@link OwnerPruneReport.keptBusy};
 *    台账「仍有任务的 owner 受控保留」—— 丢了归属就再没人能释放这些活资源);
 *  - 只有**签发过(`pcs_` 前缀)、已被淘汰、且名下无在途资源**的 owner 才回收 ——
 *    它已不可认证、名下也没活资源,清归属记录不会误伤仍在用的身份或跑着的进程。
 *
 * ⚠️ 本函数只清**归属记录**,不直接释放进程/SSH(那是资源管理器的事,且一个已被淘汰的
 * 客户端已经拿不到那些资源)。有活资源的孤儿只**保留归属**、不迁移/终止资源 —— 安全终止/
 * 迁移/审计是资源管理器的生命周期策略,属更大改造。本切片只把「归属不再只涨不落」这条
 * 修掉,并加上「仍有在途资源的 owner 不与其它孤儿一道被清」这条更保守的护栏。
 */
export function pruneOrphanedOwners(): OwnerPruneReport {
  const pruned: string[] = [];
  const keptBusy: string[] = [];
  const keptLegacy: string[] = [];
  let retained = 0;
  for (const [syntheticId, owners] of syntheticOwners) {
    for (const owner of owners) {
      // 仍是有效会话 → 保留。
      if (issued.has(owner)) { retained += 1; continue; }
      // legacy / 本机会话 id / 其它非本模块签发的 → 保留(不归本模块的生命周期管)。
      if (!owner.startsWith("pcs_")) { keptLegacy.push(owner); continue; }
      // 本服务签发过(pcs_ 前缀)、但已不在 issued 里 = 已被淘汰。
      // 【MC-089 在途资源】名下还有活资源(进程/搜索/SSH)→ 受控保留,不回收归属。
      if (ownerHasInFlightWork(owner)) { keptBusy.push(owner); continue; }
      // 已被淘汰且空闲 → 回收。
      owners.delete(owner);
      pruned.push(owner);
      evicted.delete(owner);
    }
    if (owners.size === 0) syntheticOwners.delete(syntheticId);
  }
  return { pruned, keptBusy, keptLegacy, retained };
}

/** 诊断 / 断言用:当前归属集合里 owner 的总数(去重前)。 */
export function __trackedOwnerCount(): number {
  let n = 0;
  for (const owners of syntheticOwners.values()) n += owners.size;
  return n;
}
