/**
 * **PolicyEngine —— 计划级授权判定的纯函数核心**(ARC-004 实施步 ①)。
 *
 * 现状:`appControl/policy.ts` 的 `policyFor(method)` 按**方法名**给一个调用分档
 * (read/ui/write/danger/blocked),`tools.ts` 的 `gateAppAction` 每次调用问一次审批。
 * 这挡得住"单次越权",却绑不住"一整套计划的有限改动":一次批准覆盖不了一个计划;而且
 * 换了 projectPath / MCP 命令+env / Git 远端 / SSH 主机键 / 删除范围之后,**旧批准仍被
 * 当成有效**——这正是 ARC-004 要补的洞。
 *
 * 本模块把判定提成**纯函数** `evaluate(intent, grant|null, context)`:
 *   - 低风险动作落在**未过期、在范围内**的授权里 → `allow`;
 *   - 核心意图(项目路径 / MCP 命令+env / Git 远端 / SSH 主机键 / 删除范围**扩大**)
 *     与授权钉住的不一致 → `require-approval`(并点名被改动的字段);
 *   - 授权**过期或撤销** → `deny`;token 作废后所有入口一律拒绝;
 *   - **agent 不能批准自己的请求**:批准主体不是用户本人(user)一律 `deny`。
 *
 * ## 三条硬约定
 * 1. **不自造政策。** 现有 danger/blocked 列表作为**兼容输入**(`compatibilityLevel`,
 *    缺省用 `policyFor(method)` 填)——原政策一条不删(ARC-004:不推倒原政策)。
 * 2. **没有 `allowAll` 逃生口**,也不在这里模拟用户点击;授权状态不落普通 setting。
 * 3. **纯函数。** 不读系统时钟(由 `context.now` 给)、不查数据库、不碰 electron ——
 *    才能在无头 smoke 里逐条钉住失效矩阵。
 *
 * ⚠️ 本模块**不接最终执行点**(那要让 appControl / Workflow / Automation / MCP 的执行闸
 * 逐个迁进来,是后续切片)。本切片只交付可测的判定核。
 */
import type {
  ActionIntent,
  CoreIntent,
  CoreResourceKind,
  DeleteScopeIdentity,
  Grant,
  McpIdentity,
  PolicyCompatibilityLevel,
  PolicyContext,
  PolicyDecision,
} from "@contracts/policyEngine";
import { policyFor } from "./policy.js";

/** 两个 MCP 身份是否相等(命令 + env 摘要)。都缺省 = 相等。 */
function mcpEqual(a: McpIdentity | undefined, b: McpIdentity | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.command === b.command && a.envDigest === b.envDigest;
}

/**
 * 删除范围是否被**扩大**。只允许不扩大:
 *   - 批准时没授权删除、现在要删 → 扩大;
 *   - 删的根不同 → 换目标 = 扩大;
 *   - 从非递归变递归 → 扩大。
 * 反向(递归→非递归、有根→无根)是**收窄**,不失效。
 */
export function isDeleteScopeWidened(granted?: DeleteScopeIdentity, wanted?: DeleteScopeIdentity): boolean {
  if (!wanted) return false; // 现在不删 = 没扩大
  if (!granted) return true; // 批准时没授权删除,现在要删
  if (wanted.root !== granted.root) return true;
  if (wanted.recursive && !granted.recursive) return true;
  return false;
}

/**
 * 算出当前意图相对授权**被改动的核心字段**。空数组 = 核心意图未变。
 * 顺序固定,便于断言与展示。
 */
export function invalidationsFor(wanted: CoreIntent, granted: CoreIntent): CoreResourceKind[] {
  const out: CoreResourceKind[] = [];
  if (wanted.projectPath !== granted.projectPath) out.push("projectPath");
  if (!mcpEqual(wanted.mcp, granted.mcp)) out.push("mcp");
  if (wanted.gitRemote !== granted.gitRemote) out.push("gitRemote");
  if (wanted.sshHostKey !== granted.sshHostKey) out.push("sshHostKey");
  if (isDeleteScopeWidened(granted.deleteScope, wanted.deleteScope)) out.push("deleteScope");
  // 计划级授权绑定的是计划 digest:批准之后 spec 被偷改 → 重编译得到不同的 digest → 失效。
  if (wanted.scenePlan !== granted.scenePlan) out.push("scenePlan");
  return out;
}

/**
 * 从一份编译好的场景计划,算出**计划级授权要钉住的核心意图** —— ARC-004 与 ARC-002 的接缝。
 *
 * 用法:部署前先 `compileScenePlan(spec)` 拿到 `plan`,用本函数产出的 `core` 去申请一份
 * `Grant`(`scopedCore` = 这个值)。部署的每个 write 动作带上同一个 `core`;
 * 若 spec 在批准后被改动,重编译得到的 `plan.digest` 不同 → `invalidationsFor` 点名
 * `scenePlan` → 授权失效 → 回到重新批准。**这条把「审批对象是计划」变成可判定的数据。**
 *
 * 纯函数、无副作用;只读计划里的 digest,**不**碰 spec 正文(免得又把「计划」退化成「spec」)。
 */
export function scenePlanCoreIntent(plan: { digest: string }): CoreIntent {
  return { scenePlan: plan.digest };
}


function levelOf(intent: ActionIntent, context: PolicyContext): PolicyCompatibilityLevel {
  return context.compatibilityLevel ?? policyFor(intent.method).level;
}

/**
 * 判定一个动作意图。纯函数 —— 同样的 (intent, grant, context) 永远给同样的结果。
 *
 * @param intent  待判定的动作(`method` + 核心意图 + 配置摘要)。
 * @param grant   这一计划跑在其下的受限授权;`null` = 没有授权。
 * @param context 宿主注入的上下文(时钟 / 发起者 / 批准主体 / 兼容档)。
 */
export function evaluate(intent: ActionIntent, grant: Grant | null, context: PolicyContext): PolicyDecision {
  const level = levelOf(intent, context);

  // ① blocked 从不放行 —— 兼容输入优先。即便有授权也拒绝(这些是"不给模型"的东西)。
  if (level === "blocked") {
    const reason = policyFor(intent.method).reason ?? "安全原因";
    return { verdict: "deny", reason: `这个功能不开放给 agent:${reason}`, compatibilityLevel: level };
  }

  // ② 自批自:批准主体不是用户本人 → 拒。agent / system 都不能批准自己的请求。
  if (context.approver && context.approver.kind !== "user") {
    return {
      verdict: "deny",
      reason: "批准主体不是用户本人 —— agent 不能批准自己的请求。",
      compatibilityLevel: level,
    };
  }

  // ③ 只读 / 界面:低风险,直接放行(与现有 gateAppAction 的 read/ui 一致)。
  if (level === "read" || level === "ui") {
    return { verdict: "allow", reason: "只读/界面操作,无需审批。", compatibilityLevel: level };
  }

  // ④ danger:每次都要用户本人批,受限授权**不能替代**。
  //    (装可执行扩展 / 公网暴露 / SSH 指纹变化 / 密钥读写 / 删不可恢复数据。)
  if (level === "danger") {
    return {
      verdict: "require-approval",
      reason: "高风险操作每次都需要用户本人批准,受限授权不能替代。",
      compatibilityLevel: level,
    };
  }

  // ⑤ write:必须在**有效的**授权范围内,否则重新批准。
  if (!grant) {
    return {
      verdict: "require-approval",
      reason: "没有可用的受限授权,需要用户批准这次操作。",
      compatibilityLevel: level,
    };
  }
  // 授权连"是不是用户发的"都不算数(伪造/agent 自铸) → 直接拒,不给重新批准的机会。
  if (grant.approvalSource.kind !== "user") {
    return {
      verdict: "deny",
      reason: "授权来源不是用户本人 —— agent 不能给自己发授权。",
      grantId: grant.grantId,
      compatibilityLevel: level,
    };
  }
  // 撤销 / 过期 → deny(token 作废后所有入口一律拒绝,不是"重新批准")。
  if (grant.revoked) {
    return {
      verdict: "deny",
      reason: "该授权已被撤销,所有入口一律拒绝。",
      grantId: grant.grantId,
      compatibilityLevel: level,
    };
  }
  if (!(context.now < grant.expiresAt)) {
    return {
      verdict: "deny",
      reason: "该授权已过期,所有入口一律拒绝,需要重新批准。",
      grantId: grant.grantId,
      compatibilityLevel: level,
    };
  }
  // 动作不在授权表内 = 越界(用同一份授权去跑别的动作)。
  if (!grant.allowedActions.includes(intent.method)) {
    return {
      verdict: "require-approval",
      reason: `方法 ${intent.method} 不在授权允许的动作内,需要重新批准。`,
      grantId: grant.grantId,
      compatibilityLevel: level,
    };
  }
  // 目标配置摘要变了(批准时钉住的那份配置 ≠ 现在这份)。
  if (intent.configHash !== undefined && intent.configHash !== grant.configHash) {
    return {
      verdict: "require-approval",
      reason: "目标配置与批准时不一致,需要重新预览并批准。",
      grantId: grant.grantId,
      compatibilityLevel: level,
    };
  }
  // 核心意图变更(TOCTOU:批准之后 intent 被换掉)—— 批准立即失效。
  const invalidatedBy = invalidationsFor(intent.core, grant.scopedCore);
  if (invalidatedBy.length > 0) {
    return {
      verdict: "require-approval",
      reason: `核心意图已改动(${invalidatedBy.join("、")}),批准失效,必须重新批准。`,
      invalidatedBy,
      grantId: grant.grantId,
      compatibilityLevel: level,
    };
  }
  // 次数上限。
  if (grant.maxCount !== undefined && (grant.usedCount ?? 0) >= grant.maxCount) {
    return {
      verdict: "require-approval",
      reason: `已达授权次数上限(${grant.maxCount}),需要重新批准。`,
      grantId: grant.grantId,
      compatibilityLevel: level,
    };
  }
  // 费用上限。
  if (grant.maxBudget !== undefined && (grant.budgetUsed ?? 0) + (intent.estimatedCost ?? 0) > grant.maxBudget) {
    return {
      verdict: "require-approval",
      reason: `超出授权费用上限(${grant.maxBudget}),需要重新批准。`,
      grantId: grant.grantId,
      compatibilityLevel: level,
    };
  }
  return { verdict: "allow", reason: "在受限授权范围内,允许执行。", grantId: grant.grantId, compatibilityLevel: level };
}
