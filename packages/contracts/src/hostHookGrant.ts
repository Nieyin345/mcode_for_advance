/**
 * **主机 Hook 授权(HostHookGrant)** —— MC-061 的授权原语:插件携带的 hook 要**真正执行**,
 * 必须先由宿主经用户授信签发一份「这份来源的这条钩子可以跑」的凭据。**默认不执行**。
 *
 * ## 它补的洞
 *
 * v1 解析并**展示**插件的 hooks,却**永不执行**(见 `PluginHookSummary`)。用户装了一个
 * 「技能 + MCP + hooks」的场景扩展,面板看着像活的,但那几条 hook 从不跑 —— 这是**安全
 * 的默认**(不擅自执行不受信命令),但也不能永远停在「只报不支持」。要真跑,缺的不是
 * 「一个 if」,而是**一条授权链**:谁签的、给哪份来源(插件 + 版本 + 命令摘要)、什么时候失效、
 * 一次触发且仅一次、插件卸载/重载就同步撤权。
 *
 * ## 判据(纯,可直测)
 *
 *  {@link decideHostHookExecution} 只回答「这条(来源, 事件)的钩子此刻准不准跑」:
 *   - 没有匹配的**有效**授权 → `denied`(**默认拒绝**,不是默认允许);
 *   - 有授权但该事件名映射不到统一 `HookEvent` → `unmappable`(即使有授权也不跑 —— 语义
 *     在 Mcode 里没有对应,静默跑等于乱触发);
 *   - 有有效授权且事件可映射,但**来源不符**(别的插件 / 别的版本 / 命令摘要对不上)→
 *     `denied`(授权是**按来源绑定**的,不是"开个全局开关");
 *   - 都满足 → `allowed`。
 *
 * ## 与既有授权的关系
 *
 * 形状对齐 ARC-004 的 `Grant`(有 `expiresAt` / `revoked` / 按来源绑定),但**不共用一份
 * 实现**:PolicyEngine 的 Grant 面向 `app_api_call` 的资源动作,这里的来源身份是
 * `(pluginId, version, commandDigest)`。两处各自解释清楚的代价,比强行合并成一个万能授权小。
 *
 * ⚠️ 唯一**共用**的是「次数预算用尽没有」那一条判据(`countBudgetExhausted`)—— 它不是"万能
 * 授权模型",只是一句 `used >= limit`:两处各写一遍,分家的表现是"某一路上限悄悄多/少一次"，
 * 只在计数里看得出。其余(来源身份、有效期、撤销)两处各管各的。
 */
import { countBudgetExhausted } from "./policyEngine.js";

/** 一条插件 hook 的**来源身份** —— 授权绑定的是它,不是"某条命令文本"。 */
export interface HostHookSource {
  /** 贡献这条 hook 的插件名(manifest name)。 */
  pluginId: string;
  /** 插件版本(签名随版本变;升级 = 新来源,旧授权不自动覆盖)。 */
  version: string | undefined;
  /** hook 命令的**内容摘要**(sha256 或稳定指纹)—— 命令被改过就不该沿用旧授权。 */
  commandDigest: string;
  /** 原生事件名(如 `PreToolUse`),与统一 HookEvent 分开记(映射在判定时做)。 */
  nativeEvent: string;
  /**
   * 【MC-061 复审】hook **matcher** 的稳定摘要(sha256;未声明 matcher 时为空串)。
   *
   * 独立复审点名:来源身份若只含 `(插件, 版本, 事件, 命令摘要)`,则**同命令同事件、不同
   * matcher 的两条 hook** 会共享同一个授权粒度 —— 改 matcher 也不让旧授权失效,而 matcher
   * 恰恰决定这条 hook **对哪些工具/路径**生效(放宽 matcher = 扩大了它管得着的范围)。
   * 把 matcher 摘要纳入身份:`HostHookGrant.commandDigest` 那种「改了就失效」的纪律同样
   * 适用于 matcher。空串 = 不绑定(旧授权向后兼容)。
   */
  matcherDigest?: string;
}

/** 一份签发的授权。`commandDigest` 空串表示「不绑定具体命令」(按插件 + 事件放行,较宽)。 */
export interface HostHookGrant {
  grantId: string;
  pluginId: string;
  version: string | undefined;
  /** 该授权覆盖的原生事件名集合(空 = 不限定事件)。 */
  events: string[];
  /** 命令摘要绑定(空 = 不绑定命令)。 */
  commandDigest: string;
  /**
   * 【MC-061 复审】**matcher 摘要**绑定(空 = 不绑定 matcher,向后兼容旧授权)。
   * 与 `commandDigest` 同一条纪律:matcher 被放宽(它管得着的工具/路径变多)= 来源变了,
   * 旧授权不自动覆盖。
   */
  matcherDigest?: string;
  /** 签发时刻(ms)。 */
  issuedAt: number;
  /** 失效时刻(ms);`<= now` 即视为无效。 */
  expiresAt: number;
  /** 撤销标记;true 即视为无效(与过期同一条纪律)。 */
  revoked: boolean;
  /**
   * 【MC-061 执行预算】**这条授权最多允许真执行多少次**。缺省 = 不限(旧授权语义不变)。
   *
   * 它是「批了几次就只能是几次」这条纪律在**主机 hook 授权**上的落点 —— 与 ARC-004 计划级
   * 授权的 `Grant.maxCount` 是**同一类**约束(判据共用唯一一份 `countBudgetExhausted`,见
   * `@contracts/policyEngine`)。一条插件 hook 挂在 `tool.use` 上时一轮能触发几十次;没有上限
   * 就等于把「一次授信」读成了「永久无限执行」。用尽后该来源回到**默认拒绝**,需重新授权
   * (重签得一份新的、账从 0 起 —— 见 `issueHostHookGrant` 的复用判据)。
   */
  maxRuns?: number;
  /**
   * 【MC-061 执行预算】**已经真执行了多少次**(宿主每真起一次进程记一笔,见
   * `recordHostHookRun`)。只在 `maxRuns` 声明时累加(没有上限的授权不必记,免得一个恒增的
   * 死字段 —— 与 `Grant.recordUse` 只对 `maxBudget` 累加同一条纪律)。缺省 = 0(还没用过)。
   */
  usedRuns?: number;
}

/** 一份授权此刻是否有效(未撤销 **且** 未过期;`now < expiresAt`)。 */
export function isHostHookGrantActive(grant: HostHookGrant, now: number): boolean {
  return !grant.revoked && now < grant.expiresAt;
}

/**
 * 【MC-061 复审】这份授权**覆盖**这条来源吗(不含时间 / 撤销判定)—— 匹配判据的**唯一一份**。
 *
 * 与 {@link isHostHookGrantActive} 拆开,是因为**读表的一方不止一处**:判定(`decideHostHookExecution`)
 * 与记账(`recordHostHookRun` 找要累加的那份授权)必须按**同一把尺子**认「这条来源归哪份授权」。
 * 各写一遍匹配条件的话,迟早出现「判定按 A 放行、记账记到 B 上」—— 而那种错只会让预算在某条
 * 授权上悄悄不承重,不报错。
 */
export function hostHookGrantCovers(grant: HostHookGrant, source: HostHookSource): boolean {
  return (
    grant.pluginId === source.pluginId &&
    (grant.version === undefined || grant.version === source.version) &&
    (grant.events.length === 0 || grant.events.includes(source.nativeEvent)) &&
    (grant.commandDigest === "" || grant.commandDigest === source.commandDigest) &&
    // 【MC-061 复审】matcher 摘要也参与匹配:授权绑定了 matcher(非空)时,来源的 matcher
    // 摘要必须一致 —— 放宽 matcher(管得着的范围变大)= 来源变了,旧授权不再覆盖。
    ((grant.matcherDigest ?? "") === "" || (grant.matcherDigest ?? "") === (source.matcherDigest ?? ""))
  );
}

/** 一次判定 —— 四条互斥的结论,各自是一种**确定的事实**。 */
export type HostHookDecision =
  | { decide: "allowed"; grantId: string }
  | { decide: "denied"; reason: string }
  | { decide: "unmappable"; reason: string }
  /**
   * 【MC-061 执行预算】有有效授权,但它的**执行次数预算已用尽**(`usedRuns >= maxRuns`)。
   *
   * 与 `denied` 分开,是因为这是**另一种确定的事实**:不是"没授过信",而是"授过、用完了"。
   * 面板据此说「本次授权的执行次数已用尽,需要重新授权」而不是「未授信」—— 后者会把用户
   * 往"我明明点过授权"那个方向带偏。与 `denied` 一样**不执行**(用尽即停,不静默重试)。
   */
  | { decide: "exhausted"; reason: string };

/**
 * **这条插件 hook 此刻准不准跑** —— 纯函数,授权判定的唯一落点。
 *
 * @param source 这条 hook 的来源身份。
 * @param mappedEvent 该原生事件映射到的统一 `HookEvent`(null = 映射不到)。
 * @param grants 当前**全部**授权(不改入参;只在里面找匹配且有效的)。
 * @param now 当前时刻(ms)。
 */
export function decideHostHookExecution(
  source: HostHookSource,
  mappedEvent: string | null,
  grants: readonly HostHookGrant[],
  now: number,
): HostHookDecision {
  // 匹配的授权:同一插件 + (同版本或授权不限版本)+ (事件为空集或含该事件)
  // + (摘要为空或与来源一致),且此刻仍有效(未撤销、未过期)。覆盖判据走**唯一一份**
  // `hostHookGrantCovers`(记账也用同一把尺子,见它的注释)。
  const matches = grants.filter((g) => isHostHookGrantActive(g, now) && hostHookGrantCovers(g, source));
  if (matches.length === 0) {
    // **默认拒绝** —— 没有有效授权就不跑。这条分支必须在最前面:它是安全默认。
    return {
      decide: "denied",
      reason: `插件 ${source.pluginId} 的 hook(${source.nativeEvent})没有有效的主机授权 —— 默认不执行不受信命令。`,
    };
  }
  // 有授权,但事件名映射不到统一事件 → 明确报不可用(即使有授权也不该乱触发)。
  if (mappedEvent === null) {
    return {
      decide: "unmappable",
      reason: `插件 ${source.pluginId} 的 hook 事件「${source.nativeEvent}」映射不到 Mcode 的统一事件,无法投递。`,
    };
  }
  // 【MC-061 执行预算】在**覆盖本条来源的有效授权**里,找一份预算**还有余额**的。
  // 判据走**唯一一份** `countBudgetExhausted`(与 ARC-004 的 `Grant.maxCount` 共用,见
  // `@contracts/policyEngine`)—— 「批了几次就只能是几次」只有一份实现。
  const usable = matches.find((g) => !countBudgetExhausted(g.maxRuns, g.usedRuns));
  if (usable === undefined) {
    // 每一份覆盖来源的有效授权都用尽了 → 明确报"用尽",不是"未授信"(两者事实不同)。
    const g = matches[0];
    return {
      decide: "exhausted",
      reason: `插件 ${source.pluginId} 的 hook(${source.nativeEvent})的执行次数已用尽(${g.usedRuns ?? 0} / ${g.maxRuns ?? 0}),需要重新授权。`,
    };
  }
  // 命中:取第一份**有效且仍有余额**的。grantId 供审计/日志用。
  return { decide: "allowed", grantId: usable.grantId };
}
