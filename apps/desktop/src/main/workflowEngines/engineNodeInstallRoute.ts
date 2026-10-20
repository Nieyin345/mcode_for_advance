/**
 * 【ARC-006 Gate E / MERGE-4】**第三方节点包的安装路由** —— 审批是硬前置，
 * 审批通过后才允许把可执行体写进引擎数据目录。
 *
 * ## 它在链路里的位置
 *
 * `engineNodeRegistry.ts` 只回答「这份包体是否完整、是否有来源/许可/能力声明」，
 * **不回答「用户同不同意装」**。本模块补上那一步：
 *
 * ```
 * installEngineNode({ sourceDir, meta, approval })
 *   ├─ 1. 形状 / 来源 / 哈希由清单自己校验（installFromDirectory 内部）
 *   ├─ 2. **审批**：approval 端口必须返回 true —— 调用方传的 approvedByUser 不被采信
 *   ├─ 3. 同名不同哈希：拒绝（升级必须显式卸载后重走本函数 → 自然重新审批）
 *   └─ 4. installFromDirectory(..., approvedByUser: true)
 * ```
 *
 * ## 防自授权（与 `gateAppAction` / `workflow.approve` 同一条纪律）
 *
 * `EngineNodeInstallMeta` **没有** `approvedByUser` 字段 —— 调用方（渲染端 / Agent /
 * 将来的 npm 路由）**没有表达「已批准」的能力**。批准只能来自 `approval` 端口返回
 * `true`；端口缺失或抛错 = 拒绝（fail-closed）。清单本身仍记录 `approvedByUser: true`，
 * 但它由本函数在端口点头后才写入 —— 记录的是**这次审批的事实**，不是调用方的声明。
 *
 * ## 审批卡必须说清的三件事
 *
 * 1. 装的是**可执行节点包**（不是普通数据）；
 * 2. 能力声明 —— 尤其 `network`（会出网）；
 * 3. 许可与来源（用户要知道装的是谁家的、什么许可）。
 *
 * 卡片文案由 {@link describeEngineNodeInstall} 生成成**结构化字段**，UI/原生框
 * 各自渲染；本模块不拼界面字符串（与 `moduleApproval.ts` 同一分工）。
 *
 * ## 可测性
 *
 * 审批端口是注入的；套件用计数假端口断言「审批端口被调几次」「拒绝时零落盘」。
 * 不 import electron/DB —— 生产装配在 `ipc/index.ts`（或将来的 npm 路由）把原生
 * 确认框作为端口传进来。
 */
import {
  EngineNodeRegistry,
  engineNodeTargetFingerprint,
  type EngineNodeInstallRequest,
  type EngineNodeRecord,
} from "./engineNodeRegistry.js";
import { declaresNetwork } from "@contracts/modules";
import { safeErrorMessage } from "@main/lib/safeErrorMessage.js";

/** 安装请求的**元数据**（调用方能表达的全部事实）。
 *
 *  ⚠️ **刻意没有 `approvedByUser`** —— 那个位只能由审批端口给出（见文件头）。 */
export interface EngineNodeInstallMeta {
  name: string;
  version: string;
  /** 来源：本地目录 / 已下载路径 / npm URL（只作审计）。 */
  source: string;
  /** 包体（目录内容）的**稳定哈希**（`stableDirectoryHash` 的结果）。 */
  sha256: string;
  license: string;
  capabilities: readonly string[];
}

/** 一张审批卡要展示的字段。`risk` 是给渲染层选色调的（不是判据）。 */
export interface EngineNodeInstallApprovalRequest {
  name: string;
  version: string;
  source: string;
  license: string;
  capabilities: readonly string[];
  /** 声明了网络能力（与 `permissionedProcessRunner` 的 allowNetwork 同一判据）。 */
  network: boolean;
  sha256: string;
  /** `install` = 首次安装；`upgrade` = 同名不同哈希（本函数的实现**拒绝**它，
   *  但审批卡类型保留该值，让调用方在提示里说清"为什么又要问一次"）。 */
  intent: "install" | "upgrade";
}

/** 审批端口：**返回 true 才算批准**；抛错 / 返回 false 都是拒绝。
 *  与 `ModuleApprovalPort`（执行前逐次批准）分开：两者批的是不同的事。 */
export type EngineNodeInstallApprovalPort = (
  request: EngineNodeInstallApprovalRequest,
) => Promise<boolean>;

/** 构造审批卡内容（纯函数；UI 与原生框共用这一份）。 */
export function describeEngineNodeInstall(
  meta: EngineNodeInstallMeta,
  intent: "install" | "upgrade",
): EngineNodeInstallApprovalRequest {
  return {
    name: meta.name,
    version: meta.version,
    source: meta.source,
    license: meta.license,
    capabilities: [...meta.capabilities],
    network: declaresNetwork(meta.capabilities),
    sha256: meta.sha256,
    intent,
  };
}

export type EngineNodeInstallOutcome =
  | { ok: true; entry: EngineNodeRecord; approval: "granted" }
  | { ok: false; reason: string; code: "invalid" | "approval_denied" | "approval_unavailable" | "duplicate" | "install_failed" };

/** Host-only snapshot of the target package identity. The pending-remove
 * marker is a revocation transaction, never a re-installable "installed"
 * state. Re-read after human consent to detect changes during async approval.
 * This is a pre-install guard; the registry owns its separate atomic publish. */
async function existingHash(registry: EngineNodeRegistry, name: string): Promise<
  { ok: true; hash: string | null; fingerprint: string } | { ok: false; reason: string }
> {
  try {
    const state = await registry.readState();
    if (state.kind === "corrupt") {
      return { ok: false, reason: `可执行体清单已损坏，拒绝安装：${state.reason}` };
    }
    if (state.kind === "absent") return { ok: true, hash: null, fingerprint: "absent" };
    if (state.kind !== "ok") return { ok: false, reason: "节点包清单状态未知，拒绝安装" };
    const existing = state.entries.find((entry) => entry.name === name);
    if (existing?.state === "pending-remove") {
      return { ok: false, reason: `节点包 ${name} 正在撤销批准/卸载，必须先完成清理才能重新申请安装` };
    }
    // Identical normalization to Registry's locked publish precondition.
    return { ok: true, hash: existing?.sha256 ?? null,
      fingerprint: engineNodeTargetFingerprint(state, name)! };
  } catch (error) {
    return { ok: false, reason: `可执行体清单读取失败，拒绝安装：${safeErrorMessage(error)}` };
  }
}

/**
 * **安装一个第三方节点包（带硬审批）**。
 *
 * 顺序（失败方向即判据）：
 *   1. 形状校验交给 `installFromDirectory`（本函数先算 `intent`，不改判据）；
 *   2. 没有审批端口 → `approval_unavailable`（fail-closed，**不落盘**）；
 *   3. 同名不同哈希 → `duplicate`（升级必须显式卸载，见 `engineNodeRegistry` 的说明）；
 *   4. 审批端口返回非 true / 抛错 → `approval_denied`（**不落盘**）；
 *   5. 端口点头 → 调 `installFromDirectory(..., approvedByUser: true)`。
 *
 * 关键：`install` 调用里那个 `approvedByUser: true` 是**本函数在端口点头之后**
 * 填的；调用方给 `EngineNodeInstallMeta` 塞不进这个位（类型里没有）。
 */
export async function installEngineNode(options: {
  registry: EngineNodeRegistry;
  sourceDir: string;
  meta: EngineNodeInstallMeta;
  approval?: EngineNodeInstallApprovalPort;
}): Promise<EngineNodeInstallOutcome> {
  const { registry, sourceDir } = options;
  // IPC and extension callers can pass runtime values that do not match TS
  // types. Check the data *before* opening a human approval card, and snapshot
  // the exact version/capabilities being approved. Otherwise the caller may
  // mutate meta.capabilities while the approval Promise is pending and install
  // a network-enabled executable after the user saw a no-network card.
  // Approval cards are UI messages, not arbitrary documents. Bound every
  // caller-controlled field before cloning arrays or asking a real window.
  // Large values otherwise consume Host/renderer resources and can make the
  // user unable to meaningfully inspect which executable they are approving.
  const MAX_CARD_NAME_CHARS = 256;
  const MAX_CARD_FIELD_CHARS = 512;
  const MAX_CARD_SOURCE_CHARS = 4096;
  const MAX_CARD_CAPABILITIES = 64;
  const MAX_CARD_CAPABILITY_CHARS = 128;
  let meta: EngineNodeInstallMeta;
  try {
    const incoming: unknown = options.meta;
    if (incoming === null || typeof incoming !== "object" || Array.isArray(incoming)) {
      return { ok: false, code: "invalid", reason: "节点包安装元数据必须是对象" };
    }
    const value = incoming as EngineNodeInstallMeta;
    if (typeof value.name !== "string" || value.name.trim() === "" || value.name.length > MAX_CARD_NAME_CHARS
      || typeof value.version !== "string" || value.version.trim() === "" || value.version.length > MAX_CARD_FIELD_CHARS
      || typeof value.source !== "string" || value.source.trim() === "" || value.source.length > MAX_CARD_SOURCE_CHARS
      || typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256)
      || typeof value.license !== "string" || value.license.trim() === "" || value.license.length > MAX_CARD_FIELD_CHARS
      || !Array.isArray(value.capabilities) || value.capabilities.length > MAX_CARD_CAPABILITIES
      || !value.capabilities.every((capability) => typeof capability === "string"
        && capability !== "" && capability.length <= MAX_CARD_CAPABILITY_CHARS)) {
      return { ok: false, code: "invalid", reason: "节点包安装元数据不合法，拒绝发送审批卡" };
    }
    meta = {
      name: value.name, version: value.version, source: value.source,
      sha256: value.sha256, license: value.license,
      capabilities: [...value.capabilities],
    };
  } catch {
    return { ok: false, code: "invalid", reason: "节点包安装元数据读取失败，拒绝发送审批卡" };
  }
  // ⚠️ 先算 intent 再审批：卡片要说清"这是升级/换执行体"还是"首次安装"。
  const prior = await existingHash(registry, meta.name);
  // 根本读不懂原来的安装账，就不能问用户批准一次注定失败的写入。
  // 特别不能让“批准成功”把损坏清单当空表、随后覆盖或删除旧包体。
  if (!prior.ok) return { ok: false, code: "invalid", reason: prior.reason };
  const priorHash = prior.hash;
  const intent: "install" | "upgrade" = priorHash !== null && priorHash !== meta.sha256 ? "upgrade" : "install";

  // 同名不同哈希：**显式拒绝**，不在这里静默替换。调用方要升级 → 先 uninstall，
  // 再走本函数（届时的审批是一次全新的、针对新执行体的批准）。
  if (intent === "upgrade") {
    return {
      ok: false,
      code: "duplicate",
      reason: `已安装同名包 ${meta.name}（sha256 ${priorHash}）。换执行体必须先卸载（uninstall）再安装 —— 升级要重新走一次审批，不能沿用旧批准。`,
    };
  }

  if (options.approval === undefined) {
    return {
      ok: false,
      code: "approval_unavailable",
      reason: "当前环境没有可用的安装审批通道，已拒绝安装（fail-closed：不能未经用户同意装可执行节点包）",
    };
  }

  const request = describeEngineNodeInstall(meta, intent);
  let approved = false;
  try {
    approved = (await options.approval(request)) === true;
  } catch (error) {
    return {
      ok: false,
      code: "approval_denied",
      reason: `安装审批被拒绝或失败：${safeErrorMessage(error)}`,
    };
  }
  if (!approved) {
    return { ok: false, code: "approval_denied", reason: "用户没有批准安装这个可执行节点包（未落盘任何字节）" };
  }

  // Renderer approval is tied to the state the human reviewed. The request
  // can remain pending while another window revokes/removes/installs the same
  // executable. A stale positive click must never authorize the new state.
  const afterApproval = await existingHash(registry, meta.name);
  if (!afterApproval.ok || afterApproval.fingerprint !== prior.fingerprint) {
    return { ok: false, code: "invalid",
      reason: !afterApproval.ok ? afterApproval.reason
        : "节点安装清单在审批期间发生变化，旧审批已失效；请重新检查并申请安装" };
  }

  // 端口点头后才填 `approvedByUser: true` —— 这个位是**审批事实**，不是调用方声明。
  const installMeta: EngineNodeInstallRequest = {
    name: meta.name,
    version: meta.version,
    source: meta.source,
    sha256: meta.sha256,
    license: meta.license,
    capabilities: meta.capabilities,
    approvedByUser: true,
  };
  let result: Awaited<ReturnType<EngineNodeRegistry["installFromDirectory"]>>;
  try {
    // The Registry validates this expectation AGAIN under its exclusive
    // publish transaction. The UI-side second read alone had a TOCTOU gap.
    result = await registry.installFromDirectory(installMeta, sourceDir, prior.fingerprint);
  } catch (error) {
    return { ok: false, code: "install_failed", reason: `节点包安装失败：${safeErrorMessage(error)}` };
  }
  if (!result.ok) {
    // 校验/落盘失败：按 invalid（形状/哈希）或 install_failed（写盘）分类，调用方据此给话术。
    const code = /落盘失败|写盘|暂存目录/.test(result.reason) ? "install_failed" : "invalid";
    return { ok: false, code, reason: result.reason };
  }
  return { ok: true, entry: result.entry, approval: "granted" };
}
