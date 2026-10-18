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
 * 生效中的签发上限 —— 生产恒为 {@link MAX_ISSUED}(4096)。**测试**可调小,好让
 * 「小上限端到端链」真的能在 HTTP 面上被触发(而不是只断一个函数级的 `size > 4096`):
 * 起真 HTTP `initialize` 握手几次就把上限顶穿、看到真淘汰。
 */
let maxIssued = MAX_ISSUED;

/** 测试用:把签发上限调小(传 `null` 恢复 {@link MAX_ISSUED})。生产永不调用。 */
export function __setMaxIssuedForTest(next: number | null): void {
  maxIssued = next === null ? MAX_ISSUED : Math.max(1, Math.floor(next));
}

/**
 * 【MC-089】被淘汰的客户端会话 id → **它当初绑定到哪条凭据** —— 淘汰只是把 id 从
 * {@link issued} 删掉,让它不可再认证;但它名下**记录过的 owner**(见 {@link syntheticOwners})
 * 不会因此消失。若不联动回收,反复 initialize 会让 `syntheticOwners` 只涨不落(独立复核实测:
 * 4400 次签发 → 归属 4401 条,而最早的身份早已失效)。这里把**刚被淘汰**的 id 连同它的凭据
 * 记下来,供 {@link pruneOrphanedOwners} 判断「这个 owner 的会话已失效」、并在**留存报告**
 * 里说清「哪条凭据死了,名下还挂着几个活资源」(Value: Map key 被淘汰的会话 id → credentialId)。
 */
const evicted = new Map<string, string>();

/** 不会做握手的老客户端共用的 owner —— 每个凭据一个,对应 legacy shared-workspace。 */
export function legacyClientSessionId(credentialId: string): string {
  return `legacy:${credentialId}`;
}

/** 签发一个新的客户端会话,绑定到这条凭据。`initialize` 回它,客户端后续带回来。 */
export function issueClientSession(credentialId: string): string {
  const id = `pcs_${randomUUID()}`;
  issued.set(id, { credentialId, at: Date.now() });
  if (issued.size > maxIssued) {
    const oldest = [...issued.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, issued.size - maxIssued);
    for (const [key, rec] of oldest) {
      issued.delete(key);
      // 记下淘汰(连同它当初的凭据)—— 归属回收据此判定「这个 owner 的会话已失效」,
      // 留存报告据此说清「哪条凭据死了」(见 pruneOrphanedOwners / MC-089)。
      evicted.set(key, rec.credentialId);
    }
    // 淘汰集本身也要有界:被回收后出队的 id 从 evicted 里清掉(见 pruneOrphanedOwners);
    // 这里再兜一个上限,防止「淘汰了但用户一直不回收」把它撑大。
    //
    // ★ **MC-034:但受控保留的忙 owner 不能因容量被丢掉凭据映射。** 若最老的那批里正好有
    //   一个**名下还挂着活资源**的 owner,把它从 `evicted` 删掉,过后 `pruneOrphanedOwners`
    //   保留它时 `credentialId` 就变成 `null` —— 运维再也说不清"哪条凭据死了、名下还挂着
    //   资源"(与 MC-089「可溯源」相悖)。所以容量裁剪**跳过**忙 owner:宁可让 `evicted`
    //   比上限多占几个位置(数量有界:受控保留的忙 owner 不会无限增长),也不丢凭据来源。
    if (evicted.size > maxIssued) {
      const overflow = evicted.size - maxIssued;
      const droppable = [...evicted.keys()].filter((k) => !ownerHasInFlightWork(k)).slice(0, overflow);
      for (const k of droppable) evicted.delete(k);
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
  retentionAudit.length = 0;
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

/* ─────────────── 【MC-089】在途资源计数 / 安全释放(供留存报告与宿主显式调用) ─────────────── */

/** 一个 owner 名下**活**资源的计数(按资源管理器分)。用于留存报告说清「N 个资源还在跑」。 */
export interface OwnerResourceCounts {
  processes: number;
  searches: number;
  ssh: number;
}

/**
 * **在途资源计数探针** —— 与 {@link registerOwnerWorkProbe} 同一个套路(注册而非 import,
 * 保持本模块纯净)。区别:探针只回答「有没有」,这个回答「各几个」,供留存报告如实报数。
 */
type OwnerResourceCounter = (ownerId: string) => OwnerResourceCounts;
const resourceCounters = new Set<OwnerResourceCounter>();

/** 登记一个「这个 owner 名下各有多少活资源」的计数探针;返回注销函数。 */
export function registerOwnerResourceCounter(fn: OwnerResourceCounter): () => void {
  resourceCounters.add(fn);
  return () => {
    resourceCounters.delete(fn);
  };
}

/**
 * 汇总所有计数探针。**无探针 / 探针抛错**都给全 0 —— 这里只用于**报告**(如实报数),
 * 不参与「留不留下」的判定(那个由保守的 {@link ownerHasInFlightWork} 决定);报告缺数
 * 不等于「没资源」,所以调用方拿到 0 时应理解为「计数不可得」而非「确无资源」。
 */
function ownerResourceCounts(ownerId: string): OwnerResourceCounts {
  for (const counter of resourceCounters) {
    try {
      return counter(ownerId);
    } catch {
      break;
    }
  }
  return { processes: 0, searches: 0, ssh: 0 };
}

/**
 * **安全释放器** —— 真正去终止/迁移某个 owner 名下资源的钩子(由持有三个资源管理器的
 * `main/mcp/agentTools.ts` 注册,内部调各管理器的 `disposeOwner`)。
 *
 * ⚠️ 本模块只有归属**记录**,没有资源本身(进程/搜索/SSH 都是进程级单例,住在别处)。
 * 所以「安全释放」= 由注册进来的钩子执行终止,再据此回收本模块的归属记录 —— 这样
 * 「谁终止资源」只有**一份实现**(资源管理器自己的 `disposeOwner`),不另造第二张注册表。
 */
type OwnerResourceReleaser = (ownerId: string) => void;
const resourceReleasers = new Set<OwnerResourceReleaser>();

/** 登记一个「终止该 owner 名下所有资源」的释放器;返回注销函数。 */
export function registerOwnerResourceReleaser(fn: OwnerResourceReleaser): () => void {
  resourceReleasers.add(fn);
  return () => {
    resourceReleasers.delete(fn);
  };
}

/** {@link releaseOwnerResources} 的结果 —— 如实报出释放了没、为什么、动了几个资源。 */
export interface OwnerReleaseResult {
  ownerId: string;
  released: boolean;
  /**
   * `released` 的原因:
   *  - `"released"` —— 已终止其名下资源并回收归属;
   *  - `"still-valid"` —— 会话**仍有效**,不是孤儿,拒绝(避免误杀在用 owner);
   *  - `"not-managed"` —— 非本服务签发的 owner(legacy / 本机会话 id)不归本模块释放;
   *  - `"no-releaser"` —— 没有已注册的释放器(资源管理器还没接上),不动;
   *  - `"release-failed"` —— 释放器**跑了但抛错**(终止资源失败,如进程杀不掉/SSH 关闭异常)。
   *    【MC-034 验收条件·失败释放】从前这里复用 `"no-releaser"`,把"释放失败"谎报成
   *    "没有释放器" —— 运维看到前者会去查装配,实际该查的是资源管理器为什么杀不掉。
   *    归属**不**回收,下次还能再试;但原因必须如实分开(坏东西显式报出来)。
   */
  reason: "released" | "still-valid" | "not-managed" | "no-releaser" | "release-failed";
  /** 释放前名下的活资源计数(报告用)。 */
  resources: OwnerResourceCounts;
}

/**
 * **显式释放某个 owner 名下的在途资源**(终止它,并回收其在归属集合里的记录)。
 *
 * ## 为什么需要它(MC-089)
 *
 * 被淘汰的客户端会话若名下有在途资源,{@link pruneOrphanedOwners} 会**受控保留**其归属
 * (不静默丢弃)。但「保留」本身不解决资源:那条老对话的凭据可能已被吊销/换掉,资源却还在跑。
 * 台账要求给出「认证恢复 / 安全迁移或**明确终止**并留审计」的路径 —— 这就是那条**明确终止**
 * 的入口:宿主(或运维)对一个已知失效的 owner 调它,资源经各自管理器的 `disposeOwner` 一并
 * 终止,归属记录随之回收。
 *
 * ## 安全护栏(只动**确定失效**的孤儿)
 *
 *  - 会话**仍有效**(`issued` 里还在)→ 拒绝(`still-valid`),绝不动在用 owner;
 *  - 非 `pcs_` 前缀(legacy / 本机会话 id)→ 拒绝(`not-managed`),不归本模块生命周期;
 *  - 没有已注册的释放器 → 拒绝(`no-releaser`),不假装释放了;
 *  - 释放器抛错 → 拒绝(`release-failed`),归属不回收、下次可重试,且与"没接线"分开报。
 * 只有「本服务签发过、已淘汰」的孤儿才走终止路径 —— 与 `pruneOrphanedOwners` 的保守判据同源。
 */
export function releaseOwnerResources(ownerId: string): OwnerReleaseResult {
  const resources = ownerResourceCounts(ownerId);
  if (issued.has(ownerId)) return { ownerId, released: false, reason: "still-valid", resources };
  if (!ownerId.startsWith("pcs_")) return { ownerId, released: false, reason: "not-managed", resources };
  if (resourceReleasers.size === 0) return { ownerId, released: false, reason: "no-releaser", resources };
  for (const releaser of resourceReleasers) {
    try {
      releaser(ownerId);
    } catch {
      // 释放失败不抛出 —— 归属不回收,下次还能再试(显式,不静默假装成功)。
      // 【MC-034 失败释放】如实报 `release-failed`,不冒用 `no-releaser`(那是"没接线",
      // 与"接了线但杀不掉"是两种运维动作)。
      return { ownerId, released: false, reason: "release-failed", resources };
    }
  }
  // 资源已终止 → 回收归属记录(该 owner 名下所有合成会话里的条目)。
  const credentialId = evicted.get(ownerId) ?? null;
  for (const owners of syntheticOwners.values()) owners.delete(ownerId);
  for (const [syntheticId, owners] of [...syntheticOwners]) if (owners.size === 0) syntheticOwners.delete(syntheticId);
  evicted.delete(ownerId);
  // 【MC-089 持久审计】明确终止这条也留账:跨重启可回读「哪个 owner 的资源被释放了、
  // 它当初是哪条凭据、释放时挂着几个资源」。
  emitRetentionAudit({ kind: "released", at: Date.now(), ownerId, credentialId, resources });
  return { ownerId, released: true, reason: "released", resources };
}

/* ─────────────── 【MC-089】留存审计(谁能看到「旧凭据死了,还挂着活资源」) ─────────────── */

/**
 * 一次淘汰时**受控保留的忙 owner**记录 —— 留存报告/审计的原子。
 *
 * 台账要的是「让运维看得见:这条凭据死了,N 个资源还在它名下跑」。owner id 是随机 uuid,
 * 单看没信息量;配上**它当初的凭据**与**活资源计数**才是一份能给运维读、也能被断言核对的记录。
 */
export interface KeptBusyOwner {
  ownerId: string;
  /** 这个 owner 的客户端会话当初绑定到哪条凭据(吊销/到期时凭此知道"哪条链接死了");未知为 `null`。 */
  credentialId: string | null;
  /** 名下还在跑的活资源计数。 */
  resources: OwnerResourceCounts;
}

/** 一次淘汰留存事件的审计记录(有界环形)。 */
export interface RetentionAuditEvent {
  at: number;
  /** 这次因有在途资源而**受控保留**的孤儿 owner(带凭据与资源计数)。 */
  keptBusy: KeptBusyOwner[];
  /** 这次因确定失效且空闲而回收的 owner 数。 */
  prunedCount: number;
}

const MAX_AUDIT_EVENTS = 64;
const retentionAudit: RetentionAuditEvent[] = [];

/** 诊断 / 运维读:最近的淘汰留存审计(最早的在前,最多 {@link MAX_AUDIT_EVENTS} 条)。 */
export function retentionAuditLog(): readonly RetentionAuditEvent[] {
  return retentionAudit;
}

/**
 * **一条淘汰 / 释放事件的统一审计形状** —— 供**持久审计出口**落盘(见
 * {@link registerRetentionAuditSink})。
 *
 * 进程内的 {@link retentionAuditLog} 是**有界环**,重启即失(台账 remaining 点名的
 * 「留存审计未落盘」)。这里把同一件事折成一条可落盘的记录:宿主接上一个持久出口,
 * 就把「旧凭据死了、名下还挂着活资源」这件事写进**跨重启可回读**的地方。
 *
 * 两种 kind:
 *  - `retained-busy` —— 淘汰时**受控保留**了仍有活资源的孤儿(还挂着资源,等处置);
 *  - `released` —— 宿主显式 {@link releaseOwnerResources} **明确终止**了某 owner 的资源。
 *
 * 两者都带**当初的凭据**与**活资源计数**:单看随机 uuid 没有信息量,配上凭据才是能给
 * 运维读、也能被断言核对的记录(与 {@link KeptBusyOwner} 同一理据)。
 */
export type PublicSessionAuditEvent =
  | {
      kind: "retained-busy";
      at: number;
      /** 受控保留、名下仍有活资源的孤儿 owner(带凭据 + 资源计数)。 */
      keptBusy: KeptBusyOwner[];
      /** 这次因确定失效且空闲被回收的 owner 数。 */
      prunedCount: number;
    }
  | {
      kind: "released";
      at: number;
      /** 被明确终止资源的 owner。 */
      ownerId: string;
      /** 当初绑定的凭据(吊销/到期时凭此知道"哪条链接死了");未知为 `null`。 */
      credentialId: string | null;
      /** 终止前名下的活资源计数。 */
      resources: OwnerResourceCounts;
    };

/**
 * **持久审计出口** —— 一条淘汰/释放事件写进**跨重启可回读**的持久处。与
 * {@link registerOwnerWorkProbe} 同一个注册套路:本模块是纯的(不 import db),谁持有
 * 持久 store(db / 设置表),谁在模块加载或装配时把出口**注册**进来。
 *
 * 为什么复用注册而不是直接 import:`main/providers/bridge/publicMcpSession.ts` 已经在
 * 用 `SettingRepo`(既有持久设置表)保存「公网链接 / 会话」,它顺带把留存审计也落进
 * **同一张设置表**的有界环(不另造一张表 —— 与 `publicMcp.projectLinks` 同一存取姿势)。
 */
type RetentionAuditSink = (event: PublicSessionAuditEvent) => void;
const retentionAuditSinks = new Set<RetentionAuditSink>();

/** 登记一个持久审计出口;返回注销函数。出口抛错**绝不**冒到调用方(审计是旁路)。 */
export function registerRetentionAuditSink(fn: RetentionAuditSink): () => void {
  retentionAuditSinks.add(fn);
  return () => {
    retentionAuditSinks.delete(fn);
  };
}

/** 把一条事件扇出给所有已注册的持久出口;**出口抛错只吞掉,绝不打断淘汰/释放路径**。 */
function emitRetentionAudit(event: PublicSessionAuditEvent): void {
  for (const sink of retentionAuditSinks) {
    try {
      sink(event);
    } catch {
      // 审计是旁路:出口坏了,淘汰/释放照走(不因审计失败半途而废)。
    }
  }
}

/** 一次归属回收的结果 —— 如实报出收回了哪些、保留了哪些(不静默)。 */
export interface OwnerPruneReport {
  /** 被回收的 owner:会话**已被淘汰**且**名下无在途资源**,归属记录可以清。 */
  pruned: string[];
  /**
   * **受控保留**的孤儿 owner(仅 id,便于既有断言):会话已被淘汰,但**名下还有在途资源**
   * (运行的进程 / 搜索 / SSH)—— 台账要求「仍有任务的 owner 受控保留」,这里不动它。
   * 等资源自己结束(下次 prune 再收)、或宿主显式 {@link releaseOwnerResources} 终止、
   * 或用户删合成会话时由 `ownersForSession` 统一释放。
   */
  keptBusy: string[];
  /**
   * {@link keptBusy} 的**明细**(带凭据与活资源计数)—— 留存报告正文:运维据它看到
   * 「哪条凭据死了,名下还挂着几个进程/搜索/SSH」。
   */
  keptBusyDetails: KeptBusyOwner[];
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
  const keptBusySet = new Set<string>();
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
      if (ownerHasInFlightWork(owner)) { keptBusySet.add(owner); continue; }
      // 已被淘汰且空闲 → 回收。
      owners.delete(owner);
      pruned.push(owner);
      evicted.delete(owner);
    }
    if (owners.size === 0) syntheticOwners.delete(syntheticId);
  }
  // 【MC-089 留存审计】把这次受控保留的忙 owner 记成可读记录:带上「它当初的凭据」与
  // 「名下几个活资源」,运维据此看到「这条凭据死了,N 个资源还在跑」(owner id 是随机 uuid,
  // 单看没信息量)。空报告不记,免得审计被无意义事件刷屏。
  const keptBusy = [...keptBusySet];
  const keptBusyDetails: KeptBusyOwner[] = keptBusy.map((ownerId) => ({
    ownerId,
    credentialId: evicted.get(ownerId) ?? null,
    resources: ownerResourceCounts(ownerId),
  }));
  if (keptBusy.length > 0 || pruned.length > 0) {
    const event: RetentionAuditEvent = { at: Date.now(), keptBusy: keptBusyDetails, prunedCount: pruned.length };
    retentionAudit.push(event);
    if (retentionAudit.length > MAX_AUDIT_EVENTS) retentionAudit.splice(0, retentionAudit.length - MAX_AUDIT_EVENTS);
    // 【MC-089 持久审计】同一件事也扇给持久出口(若宿主接了)—— 进程内环重启即失,
    // 有活的孤儿(旧凭据已失效、资源还在跑)必须留下**跨重启可回读**的账。
    if (keptBusyDetails.length > 0) {
      emitRetentionAudit({ kind: "retained-busy", at: event.at, keptBusy: keptBusyDetails, prunedCount: pruned.length });
    }
  }
  return { pruned, keptBusy, keptBusyDetails, keptLegacy, retained };
}

/** 诊断 / 断言用:当前归属集合里 owner 的总数(去重前)。 */
export function __trackedOwnerCount(): number {
  let n = 0;
  for (const owners of syntheticOwners.values()) n += owners.size;
  return n;
}
