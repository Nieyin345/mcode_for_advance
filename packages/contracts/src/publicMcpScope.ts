/**
 * **公网 MCP 一次调用的不可变授权快照** —— MC-062 / MC-063 的共同身份层。
 *
 * ## 为什么要有它(而不是继续用会话头)
 *
 * 公网那条通路(ChatGPT 直连)原先把两件**生命周期完全不同**的身份折叠成一个
 * `x-mcode-session` 值:①长期的项目链接/凭据(`Credential/ProjectLink`,用户手动
 * 增删、轮换密钥);②短期的一次外部调用者/对话(`Client/Conversation`)。折在一起
 * 带来两个后果:
 *
 *   - **MC-062** 授权撤销后执行失去作用域:链接删了,`sandboxRootFor` 按**当前**链接
 *     列表动态取根返回 `null`,而执行器把 `null` 当「不限路径」——撤销反而可能放宽在途
 *     请求的范围。
 *   - **MC-063** 多对话共享项目链接:同一个 projectId 复用同一条合成会话,于是几个
 *     ChatGPT 对话共用一个 owner,互相能读/写/停对方的进程与 SSH,并挤同一份配额。
 *
 * 修法是把这两层分开,并由**主进程入口在鉴权成功那一刻固化**成 {@link PublicActionContext}:
 * 长期凭据给 `credentialId/projectId/grantRevision`,短期调用者给
 * `clientSessionId/actorId`,范围给鉴权时刻解析出的 `canonicalRoot`。外部随手带的
 * `x-mcode-session` / IP / User-Agent **一律不作数**。
 *
 * ## 这是契约,不是实现
 *
 * 快照由主进程的可信边界(`providers/bridge/publicMcpServer.ts` 的入口)构造并向下传递;
 * 工具层只**读**它,绝不自己从设置里再推导一遍。这样「用什么根」在鉴权那一刻就钉死了,
 * 撤销不会把在途请求的作用域改宽。
 */

/** 公网 audience 拿不到有效项目作用域时的统一拒绝标记。 */
export const PUBLIC_SCOPE_UNAVAILABLE = "PUBLIC_SCOPE_UNAVAILABLE";

/** 默认(非按项目)链接的凭据 id。 */
export const PUBLIC_MCP_DEFAULT_CREDENTIAL_ID = "default";

/**
 * **长期凭据身份**的快照 —— 项目链接那一层。鉴权成功那一刻由主进程解析并固化。
 *
 * 与 {@link PublicActionContext} 的差别:`PublicCredentialSnapshot` 只含长期身份与
 * 不可变作用域(`canonicalRoot`),不含短期调用者会话 —— 后者要在解析出请求方法
 * (`initialize` 才能签发)之后才补上。
 */
export interface PublicCredentialSnapshot {
  /** 命中哪条链接:默认链接 = {@link PUBLIC_MCP_DEFAULT_CREDENTIAL_ID},否则 = projectId。 */
  credentialId: string;
  /** 这条凭据绑定的项目 id。 */
  projectId: string;
  /** 鉴权时刻解析出的**规范沙箱根**。空串/缺失一律 fail closed,不得回退。 */
  canonicalRoot: string;
  /**
   * 授权修订号(凭据身份 + **绑定项目 id** + 密钥 + 规范根的一份短摘要);复验时比对。
   * 项目身份变化(即使根相同)也会让它变 —— 授权对象换了人,旧快照不得继续用。
   */
  grantRevision: string;
  /** 撤销世代(链接删除/密钥轮换递增);随快照落下,复验时可比对。 */
  revocationEpoch: number;
}

/**
 * 公网调用者身份头(标准 MCP Streamable HTTP 的会话头)。服务端在 `initialize` 时
 * **签发**一个,客户端后续请求原样带回来;服务端据此把「哪次对话」从共享的项目链接里
 * 分出来。缺失 = 退回 legacy 共享工作区(见 MC-063 的向后兼容策略)。
 */
export const PUBLIC_MCP_CLIENT_SESSION_HEADER = "mcp-session-id";

/**
 * 一次公网调用的**不可变授权快照**。由主进程入口在鉴权成功后固化。
 *
 * 长期与短期身份分列,正对应 MC-063 要拆的两层:
 *   - 长期:`credentialId` / `projectId` / `grantRevision` / `revocationEpoch`;
 *   - 短期:`clientSessionId` / `actorId`(每对话一个,服务端签发并校验);
 *   - 作用域:`canonicalRoot`(鉴权那一刻解析出的规范沙箱根)。
 */
export interface PublicActionContext {
  /** 长期凭据身份:命中的是哪条项目链接。默认链接用 {@link PUBLIC_MCP_DEFAULT_CREDENTIAL_ID}。 */
  credentialId: string;
  /** 长期凭据身份:这条链接绑定的项目 id。 */
  projectId: string;
  /** 这次调用挂着的合成会话 id(`webToolHost` 的审批闸门按它取;公网恒为 bypass)。 */
  sessionId: string;
  /**
   * 鉴权时刻解析出的**规范沙箱根**。派发与写/执行前按它再验资源范围,**不重新推导**
   * ——撤销链接不会把在途请求的根改宽或改成不限路径。
   */
  canonicalRoot: string;
  /** 授权修订号:链接/密钥/项目变更时变化,随快照落下供审计与复验。 */
  grantRevision: string;
  /** 撤销世代:链接删除 / 密钥轮换时递增。 */
  revocationEpoch: number;
  /** 短期调用者身份:服务端签发并校验的客户端会话 id(每对话一个)。 */
  clientSessionId: string;
  /** 短期调用者 actor(当前等于 `clientSessionId`;单列以便将来细分真正的调用者)。 */
  actorId: string;
  /** 本次调用的追踪 id(进程/搜索/SSH 归属与审计共用)。 */
  traceId: string;
  /** 一次可能产生副作用的操作的幂等键(可选;由调用方自选键,宿主不复用他人键)。 */
  operationId?: string;
}
