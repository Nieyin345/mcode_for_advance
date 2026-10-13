/**
 * **主机 Hook 授权存储(内存版)** —— MC-061 的授权落地:插件 hook 要执行,得先在这里
 * 有一份**有效**授权(见 `@contracts/hostHookGrant`)。**默认空表 = 默认拒绝**。
 *
 * ## 为什么先做内存版
 *
 * 台账把 MC-061 的完整执行通道划为「一整套新的授权与执行面」。本模块只落**授权那一半的
 * 可测核心**:签发 / 撤销 / 按来源查 / 判定 —— 与 ARC-004 的 `GrantStore` 同姿势(纯逻辑、
 * 可注入时钟、不 import electron/sql)。**真正的执行通道**(宿主 HookRunner 消费判定并在
 * 一次且仅一次 / 带取消预算下真跑)是后续切片;本片让「到底准不准跑」有**唯一判定落点**,
 * 不再是面板里写死的一句 `unsupported`。
 *
 * ## 持久化(跨重启活着)
 *
 * 授权表默认**纯内存**(未装配 = 重启即空,与从前一致)。生产在启动装配点调
 * {@link configureHostHookGrantPersist} 接上落盘版(`hostHookGrantFile.ts`,独立文件,
 * 不参与设置导入导出)。接上后**签发 / 撤销都落盘**,重启经 `load()` 载回 —— 「用户授过信
 * 的这条 hook 每次开机都得重签」这类静默回退因此被堵住。载入是 **fail-safe** 的:坏数据 →
 * 空表(**仍默认拒绝**),绝不把读不懂的当成「全部允许」。
 *
 * ## 撤销 / 卸载同步
 *
 * {@link revokeHostHookGrants} 可按插件名撤掉它全部授权 —— 插件卸载 / 重载时调它,
 * 「卸载后 hook 同步撤销」这条台账要求因此是**一句真的调用**,不是口号。
 */
import { createHash } from "node:crypto";
import {
  decideHostHookExecution,
  isHostHookGrantActive,
  type HostHookDecision,
  type HostHookGrant,
  type HostHookSource,
} from "@contracts/hostHookGrant";

/**
 * 命令内容的**稳定摘要** —— 授权按它绑定(见 `HostHookSource.commandDigest`):命令被改过,
 * 旧授权就不该再覆盖这条 hook。放主进程而不是契约里,是因为契约要能进渲染端,而
 * `node:crypto` 不是渲染端能引的东西。
 */
export function hostHookCommandDigest(command: string): string {
  return `sha256:${createHash("sha256").update(command, "utf8").digest("hex")}`;
}

/**
 * 从一条插件声明的 hook 造出它的**来源身份** —— **唯一构造点**。面板(`toPluginState`)、
 * 宿主执行通道(`HookRunner`)、授权签发,三处必须是**同一份**来源:`commandDigest` 若有
 * 一处漏算,面板标的「已授信」与执行时判的「准不准跑」就会对不上 —— 那正是「看着授了信、
 * 实际不跑」这种最难查的坏。
 */
export function hostHookSourceOf(input: {
  pluginId: string;
  version: string | undefined;
  nativeEvent: string;
  command: string;
  matcher?: string;
}): HostHookSource {
  return {
    pluginId: input.pluginId,
    version: input.version,
    commandDigest: hostHookCommandDigest(input.command),
    nativeEvent: input.nativeEvent,
    // 【MC-061 复审】matcher 摘要:空/未声明 → 空串(不绑定,向后兼容);有值 → 摘要。
    matcherDigest: input.matcher === undefined || input.matcher === "" ? "" : hostHookCommandDigest(input.matcher),
  };
}

/**
 * 一条插件 hook 的**稳定身份** —— 由来源身份(`插件 + 版本 + 原生事件 + 命令摘要`)派生的
 * 短哈希。宿主把它当 `HookSpec.id` 用:同一条 hook 的每一次投递拿的是**同一个 id**,于是
 * 并发闸、交付计数、去重都按「这一条」收口。命令或版本改了,id 就变 —— 与"来源变了、旧
 * 授权作废"是同一条纪律(见 `HostHookSource`)。
 */
export function hostHookIdOf(source: HostHookSource): string {
  const digest = createHash("sha256")
    .update(`${source.pluginId}\u0000${source.version ?? ""}\u0000${source.nativeEvent}\u0000${source.commandDigest}\u0000${source.matcherDigest ?? ""}`)
    .digest("hex")
    .slice(0, 16);
  return `ph_${digest}`;
}

/** 主机 hook 授权表。模块级单例(生产在装配点用它;测试可 `resetHostHookGrants` 清空)。 */
let grants = new Map<string, HostHookGrant>();
let seq = 0;

/**
 * 可注入的持久化接口 —— 本模块不实现落盘,只认这个窄接口(与 ARC-004 的 `GrantStorePersist`
 * 同姿势,不 import electron / sql)。生产在装配点接 `hostHookGrantFile.ts` 的落盘版;未接时
 * 为 `undefined`(纯内存,重启即空,与从前一致)。
 */
export interface HostHookGrantPersist {
  /** 载入已存的授权(无则 null)。 */
  load(): HostHookGrant[] | null;
  /** 落盘全量授权。 */
  save(grants: HostHookGrant[]): void;
}

let persist: HostHookGrantPersist | undefined;

/**
 * 从已载入的授权里**续上 id 序号** —— id 形如 `hhg-<n>`,取最大 n 作为 `seq` 起点,于是重启后
 * 新签发的 id 不会与已有授权撞号(撞号 = 新授权静默覆盖旧的同 id 记录,是一类难查的坏)。
 */
function seqOfLoaded(loaded: readonly HostHookGrant[]): number {
  let max = 0;
  for (const g of loaded) {
    const m = /^hhg-(\d+)$/.exec(g.grantId);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/** 把当前表落盘(未接持久化时是 no-op)。 */
function flush(): void {
  persist?.save([...grants.values()]);
}

/**
 * **装配持久化**(唯一入口)—— 接上可注入的 load/save,并**立即载入**已存授权。
 * 传 `undefined` 复位回内存版。载入是 fail-safe 的:文件不存在 / 坏数据 → `load()` 给
 * `null` / 空 → 空表(**仍默认拒绝**,绝不把读不懂的当成「全部允许」)。
 *
 * ⚠️ 与 `resetHostHookGrants` 的区别:本函数**载入**磁盘上那份;reset 只清内存。
 */
export function configureHostHookGrantPersist(next: HostHookGrantPersist | undefined): void {
  persist = next;
  const loaded = next?.load() ?? null;
  grants = new Map();
  seq = 0;
  if (loaded) {
    for (const g of loaded) grants.set(g.grantId, g);
    seq = seqOfLoaded(loaded);
  }
}

/** 测试 / 装配用:清空全部授权,回到「默认拒绝」。**不动**已接的持久化配置(reset 只清内存)。 */
export function resetHostHookGrants(): void {
  grants = new Map();
  seq = 0;
}

/** 当前全部授权(只读快照;诊断 / 断言用)。 */
export function listHostHookGrants(): HostHookGrant[] {
  return [...grants.values()];
}

/**
 * 一条授权的**幂等键** —— 由来源身份(`插件 + 版本 + 命令摘要 + matcher 摘要`)与它覆盖的
 * 事件集合派生。**同一来源签两次 → 同一个键**(见 {@link issueHostHookGrant})。
 *
 * 为什么要它:「用户授权这条 hook」是一个**可以点两次**的动作(双击、先签后重签、
 * 面板重挂后再点一下)。若每点一次就多一份有效授权,表里会攒下一串覆盖同一来源的
 * 重复条目 —— 撤销时只撤到你点的那一份、其余仍在,于是"我明明撤了它怎么还跑"。
 * 幂等键把这个来源的**当前有效授权**收成一条。
 *
 * 事件集合**排序去重**后入键:声明顺序不同、但覆盖同一组事件的两份授权,语义上是同一份。
 */
function grantIdempotencyKey(input: {
  pluginId: string;
  version: string | undefined;
  events: readonly string[];
  commandDigest: string;
  matcherDigest: string;
}): string {
  const events = [...new Set(input.events)].sort().join(",");
  return [input.pluginId, input.version ?? "", events, input.commandDigest, input.matcherDigest].join("\u0000");
}

/**
 * **签发**一份授权。**只有宿主经用户授信时调它** —— 插件自己不能给自己发(本函数不暴露给
 * 插件 manifest 的任何入口)。`ttlMs` 必须为正(与 ARC-004 的 `issueGrant` 同一条纪律)。
 *
 * **持久幂等**:来源身份与事件集合相同、且**当前仍有效**的授权已存在时,**复用那一份**
 * (返回它、不新建、不续期)。于是"点两次授权"不会在表里留下两条覆盖同一来源的有效授权 ——
 * 撤一次就真的撤干净(见 {@link grantIdempotencyKey})。已撤销 / 已过期的那份**不算数**:
 * 重新授权是**一份新的有效授权**,不是把旧的复活。
 */
export function issueHostHookGrant(input: {
  pluginId: string;
  version?: string;
  events?: string[];
  commandDigest?: string;
  matcherDigest?: string;
  ttlMs: number;
  now: number;
}): HostHookGrant {
  if (!(input.ttlMs > 0)) {
    throw new Error("主机 hook 授权必须有正的有效期(ttlMs > 0)。");
  }
  const commandDigest = input.commandDigest ?? "";
  const matcherDigest = input.matcherDigest ?? "";
  const key = grantIdempotencyKey({
    pluginId: input.pluginId,
    version: input.version,
    events: input.events ?? [],
    commandDigest,
    matcherDigest,
  });
  // 已有**有效**的同来源授权 → 复用它(幂等):不新建第二条覆盖同一来源的活授权。
  for (const g of grants.values()) {
    if (!isHostHookGrantActive(g, input.now)) continue;
    const same = grantIdempotencyKey({
      pluginId: g.pluginId,
      version: g.version,
      events: g.events,
      commandDigest: g.commandDigest,
      matcherDigest: g.matcherDigest ?? "",
    });
    if (same === key) return g;
  }
  seq += 1;
  const grant: HostHookGrant = {
    grantId: `hhg-${seq}`,
    pluginId: input.pluginId,
    version: input.version,
    events: [...(input.events ?? [])],
    commandDigest,
    matcherDigest,
    issuedAt: input.now,
    expiresAt: input.now + input.ttlMs,
    revoked: false,
  };
  grants.set(grant.grantId, grant);
  flush();
  return grant;
}

/** 撤销一份授权(幂等)。返回 true 表示这次真的从"有效"翻成"已撤销"。 */
export function revokeHostHookGrant(grantId: string): boolean {
  const g = grants.get(grantId);
  if (!g || g.revoked) return false;
  g.revoked = true;
  flush();
  return true;
}

/**
 * **按插件撤掉它全部授权** —— 插件卸载 / 重载时调。返回撤掉了几份有效授权。
 * 台账「卸载后 hook 同步撤销」就落在这**一句调用**上(不是需要各入口自己记得)。
 */
export function revokeHostHookGrants(pluginId: string): number {
  let n = 0;
  for (const g of grants.values()) {
    if (g.pluginId === pluginId && !g.revoked) {
      g.revoked = true;
      n += 1;
    }
  }
  if (n > 0) flush();
  return n;
}

/**
 * **判定这条插件 hook 此刻准不准跑** —— 存储侧的入口,把当前全部授权喂给契约的纯判定。
 * 判据全在 `@contracts/hostHookGrant.decideHostHookExecution`,这里只是"取当前表"。
 */
export function decidePluginHookExecution(
  source: HostHookSource,
  mappedEvent: string | null,
  now: number,
): HostHookDecision {
  return decideHostHookExecution(source, mappedEvent, [...grants.values()], now);
}

/** 现在有没有**任何**有效授权(面板据此决定要不要把「已授信」那档显示出来)。 */
export function hasAnyActiveHostHookGrant(now: number): boolean {
  for (const g of grants.values()) if (isHostHookGrantActive(g, now)) return true;
  return false;
}
