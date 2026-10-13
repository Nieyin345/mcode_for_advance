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

/** 测试 / 装配用:清空全部授权,回到「默认拒绝」。 */
export function resetHostHookGrants(): void {
  grants = new Map();
  seq = 0;
}

/** 当前全部授权(只读快照;诊断 / 断言用)。 */
export function listHostHookGrants(): HostHookGrant[] {
  return [...grants.values()];
}

/**
 * **签发**一份授权。**只有宿主经用户授信时调它** —— 插件自己不能给自己发(本函数不暴露给
 * 插件 manifest 的任何入口)。`ttlMs` 必须为正(与 ARC-004 的 `issueGrant` 同一条纪律)。
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
  seq += 1;
  const grant: HostHookGrant = {
    grantId: `hhg-${seq}`,
    pluginId: input.pluginId,
    version: input.version,
    events: [...(input.events ?? [])],
    commandDigest: input.commandDigest ?? "",
    matcherDigest: input.matcherDigest ?? "",
    issuedAt: input.now,
    expiresAt: input.now + input.ttlMs,
    revoked: false,
  };
  grants.set(grant.grantId, grant);
  return grant;
}

/** 撤销一份授权(幂等)。返回 true 表示这次真的从"有效"翻成"已撤销"。 */
export function revokeHostHookGrant(grantId: string): boolean {
  const g = grants.get(grantId);
  if (!g || g.revoked) return false;
  g.revoked = true;
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
