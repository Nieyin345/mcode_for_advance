/**
 * 计划级授权(PolicyEngine)的**跨层契约** —— 资源身份、动作意图、受限授权与判定结果。
 *
 * 背景(ARC-004):现在 `appControl/policy.ts` 按**方法名**给调用分档,`gateAppAction`
 * 每次调用问一次审批。这挡得住单次越权,却绑不住「一整套场景的有限改动」——
 * 一次批准覆盖不了一个计划;而且换了 projectPath / MCP 命令 / Git 远端 / SSH 主机键 /
 * 删除范围之后,**旧批准仍被当成有效**。本模块定义让整个计划跑在一份**受限授权(Grant)**
 * 之下的数据模型;判定逻辑见主进程 `appControl/policyEngine.ts` 的纯函数 `evaluate`。
 *
 * ⚠️ 一条不变的约定:**ResourceIdentity 是宿主解析出来的权威身份,不是模型参数填进来的
 * 字符串**。例如 projectPath 是 realpath 之后的根、MCP 是规范命令 + 环境变量摘要、
 * SSH 是主机键指纹。id 由宿主定,不由调用方给 —— 这正是「符号链接 / junction 指向别处」
 * 这类越权的入口。
 *
 * 本文件只定义**数据形状**,不含任何判定逻辑(判定在主进程,保持纯函数、可无头测)。
 */

/**
 * 与 `main/appControl/policy.ts` 的 `AppPolicyLevel` **同形**。刻意在这里重写一遍同形
 * 联合,而不是从主进程反向 import —— 契约层不能依赖主进程。
 */
export type PolicyCompatibilityLevel = "read" | "ui" | "write" | "danger" | "blocked";

/**
 * **核心意图**里的资源类别。这些字段任一变动 —— 或者删除范围被**扩大** —— 已发出的批准
 * 立即失效,必须重新预览并批准(ARC-004 的验收判据)。
 */
export const CORE_RESOURCE_KINDS = ["projectPath", "mcp", "gitRemote", "sshHostKey", "deleteScope", "scenePlan"] as const;
export type CoreResourceKind = (typeof CORE_RESOURCE_KINDS)[number];

/**
 * 一个资源的**权威身份**。`id` 必须由宿主解析(realpath / 规范化命令 / 主机键指纹),
 * **不能**直接采信调用方传来的原始字符串。`label` 只作展示,不含凭据。
 */
export interface ResourceIdentity {
  kind: "file" | "projectPath" | "mcp" | "gitRemote" | "sshHost" | "deleteScope" | "other";
  /** 权威 id(规范化后)。 */
  id: string;
  /** 给人看的名字(不含凭据)。 */
  label?: string;
}

/** MCP 服务器的权威身份:**规范命令 + 环境变量摘要**(env 常含凭据,只留摘要,不落明文)。 */
export interface McpIdentity {
  /** 规范化的启动命令(如 `npx @x/y`)。 */
  command: string;
  /** 对 env 取出的稳定摘要(哈希);不落明文凭据。 */
  envDigest: string;
}

/** 删除范围的权威身份:被删资源的**权威根** + 是否递归。换根 / 变递归 = 扩大范围。 */
export interface DeleteScopeIdentity {
  /** 被删资源的权威根路径。 */
  root: string;
  recursive: boolean;
}

/**
 * 一个动作的**核心意图** —— 变更其中任一字段,已发出的批准立即失效。
 * 字段都是**权威身份**而非原始参数;全部 optional:一个动作只关心与它相关的那些项。
 */
export interface CoreIntent {
  projectPath?: string;
  mcp?: McpIdentity;
  gitRemote?: string;
  sshHostKey?: string;
  deleteScope?: DeleteScopeIdentity;
  /**
   * 场景计划的**稳定摘要**(`@contracts/scenePlan` 的 `scenePlanDigest` 值)。
   *
   * ARC-004 的验收判据说「审批的对象是计划,不是 spec」:一份覆盖整个场景的授权,绑定的是
   * 批准那一刻编译出来的 `plan.digest`。批准之后 spec 被偷改 → 重编译得到**不同**的
   * `planDigest` → 这次部署的核心意图与之不符 → 批准立即失效,必须重新预览批准。
   * 这条把「模型提出计划」和「计划被执行」之间那道闸钉在了**计划内容**上,而不是
   * 一句「用户点过头了」。缺省(不参与计划级判定)= 普通单动作授权,不受此字段约束。
   */
  scenePlan?: string;
}

/**
 * 一个待判定的动作意图:`method`(与现有 `policyFor` 的方法名对齐)+ 核心意图 + 配置摘要。
 * `configHash` 由宿主按当前配置算出;与授权钉住的不符即失效。
 */
export interface ActionIntent {
  method: string;
  core: CoreIntent;
  /** 目标配置摘要。缺省 = 该项不参与判定(向后兼容)。 */
  configHash?: string;
  /** 该动作触碰的资源身份(用于审计与展示;失效判据是 `core`)。 */
  targets?: ResourceIdentity[];
  /** 预估费用(与 Grant.maxBudget / budgetUsed 配合)。缺省 = 不参与预算判定。 */
  estimatedCost?: number;
}

/** 审批主体 —— **只有 `user` 算数**:agent / system 不能批准自己的请求。 */
export interface ActorRef {
  kind: "user" | "agent" | "system";
  id: string;
}

/**
 * 一份**受限授权(Grant)** —— 一个计划可以跑在它之下。
 *
 * 由宿主在用户点头后铸造,绑定:sceneId、允许的动作、批准时钉住的核心意图、配置摘要、
 * 有效期、费用 / 次数上限、审批来源。任何一项被动过、过期或撤销,都不再算数。
 */
export interface Grant {
  grantId: string;
  sceneId: string;
  /** 允许的动作(method 名)。不在表内 = 越界,须重新批准。 */
  allowedActions: string[];
  /** 批准时钉住的核心意图 —— intent.core 必须与它**相等**(删除范围只允许不扩大)。 */
  scopedCore: CoreIntent;
  /** 审批时的配置摘要;当前配置与之不符即失效。 */
  configHash: string;
  /** 过期时刻(ms epoch)。 */
  expiresAt: number;
  /** 费用上限(可空 = 不限)。 */
  maxBudget?: number;
  /** 已用费用(与 maxBudget 配合)。 */
  budgetUsed?: number;
  /** 次数量上限(可空 = 不限)。 */
  maxCount?: number;
  /** 已用次数。 */
  usedCount?: number;
  /** 审批来源 —— agent / system 铸造的授权一律不算数。 */
  approvalSource: ActorRef;
  /** 是否已被撤销。撤销后所有入口一律拒绝。 */
  revoked?: boolean;
}

export type PolicyVerdict = "allow" | "require-approval" | "deny";

/** 判定结果。 */
export interface PolicyDecision {
  verdict: PolicyVerdict;
  /** 给模型 / 用户看的一句话。 */
  reason: string;
  /** `require-approval` 且因核心意图变动时,列出被改动的核心字段。 */
  invalidatedBy?: CoreResourceKind[];
  /** `allow` 时命中的授权 id。 */
  grantId?: string;
  /** 沿用的兼容档位(来自现有 `policyFor`)。 */
  compatibilityLevel: PolicyCompatibilityLevel;
}

/**
 * 判定上下文 —— **时钟、发起者、批准主体都由宿主注入**,不采信模型参数(ARC-004:
 * 「ActionContext 必须由宿主产生、不可让 Agent 模型参数填写 actorId/projectScope」)。
 */
export interface PolicyContext {
  /** 当前时刻(ms epoch)。纯函数不读系统时钟,由调用方给,便于测过期。 */
  now: number;
  /** 请求发起者。 */
  requester: ActorRef;
  /** 批准主体。缺省视为「等用户来批」;`kind !== "user"` 一律判为自批、拒绝。 */
  approver?: ActorRef;
  /**
   * 现有 `policyFor` 的分类结果,作为**兼容输入**。缺省时由主进程 engine 用
   * `policyFor(intent.method)` 填 —— 不推倒原政策(ARC-004 ②)。
   */
  compatibilityLevel?: PolicyCompatibilityLevel;
}
