/**
 * **跨通道幂等** —— 桌面 IPC / 手机 RPC / 自定义面板里的写操作，只要调用方带了
 * `operationId`，就过**同一份**操作账本（`appControl/operations.ts` 的
 * `getOperationLedger()`：意图绑定 + 原子领取 + 全态结算，生产为 sql.js durable 版）。
 *
 * ## 它补的是哪条洞（台账 MC-014 的独立复核）
 *
 * 从前幂等只覆盖 `app_api_call` 与五个 Agent 自带工具。桌面原生 IPC（渲染端
 * `window.api.*` 重试）、手机 RPC（网络抖动重试）、自定义面板 `mcode.api.call`
 * 都**没有**「同一个 id 不重复执行」的保障。审核明确要求：统一操作身份必须是
 * **通道无关**的能力，不能绑定到单个工具。
 *
 * ## 边界（有意为之）
 *
 * - **只认显式幂等键**：没有 `operationId` 的调用原样执行、不进账本。匿名读 RPC
 *   不该为一次 fsync 买单；而且"没有身份"本来就无从去重。
 * - **只对有副作用的档位生效**：只读调用传了键也不进账本（领取即写一行 + 整库
 *   fsync，换不来任何正确性）。这一判据与 `app_api_call` 的 `sideEffectClassOf`
 *   同源 —— 见 {@link idempotencyApplies}。
 * - **不吞掉通道自己的结果形状**：本模块只回答「这次该不该执行 / 能不能回放」，
 *   执行与结果封装仍由各通道自己做（手机 RPC 返回 JSON、面板返回 `{ok,...}`）。
 *
 * ## 各通道怎么接
 *
 * - 桌面 IPC：`ipc/index.ts` 的 `createDbGuardedIpc` 在 handler 前跑
 *   {@link runWithIdempotency}（原始入参里的 `__operationId`）。
 * - 手机 RPC：`mobileRpc.ts` 的 `dispatchMobileRpc` 在 handler 前跑同一函数
 *   （请求体的 `operationId` 字段）。
 * - 自定义面板：`ipc/customUiPanel.ts` → `panelApiCall` 的第五条参数。
 *
 * 三处都只是**接线**，判据/账本/结算语义只有这一份。
 */
import { randomUUID } from "node:crypto";
import type { OperationResult } from "@contracts/appControl";
import {
  getOperationLedger,
  intentFingerprint,
  operationIdWithinLimit,
  requestDigestOf,
  type OperationLedger,
} from "@main/appControl/operations.js";
import { API_CATALOG } from "@main/appControl/apiCatalog.generated.js";

/** 一条幂等调用的意图参数（通道无关 —— 谁调都填这几个）。 */
export interface ChannelOperationIntent {
  operationId: string;
  /** 授权主体：桌面 = 会话/用户，手机 = 已配对设备，面板 = 面板宿主。
   *  同一 id 换主体 = 换意图 → CONFLICT（绝不把 A 的成功回执给 B）。 */
  ownerId: string;
  sessionId: string;
  /** 场景标识（`desktop-ipc` / `mobile-rpc` / `custom-ui-panel`），供跨端对账。 */
  sceneId: string;
  /** 被调用的方法名（IPC 通道名 / RPC 方法 / 面板方法）。 */
  method: string;
  /** 请求参数的原始值；摘要在这里算，调用方不用关心。 */
  input: unknown;
  /** 授权档（当前权限模式等），只进审计、不参与意图指纹。 */
  grantRevision?: string;
}

/** 幂等守卫的裁决：执行方据此决定跑不跑、怎么回。 */
export type ChannelIdempotencyDecision =
  /** 领取成功 → **现在可以执行**；执行完必须调一次 `settle`（成功/失败/抛错都要）。 */
  | { kind: "execute"; operationId: string; settle: (r: OperationResult, body?: string) => void }
  /** 同意图已成功结算 → 回放旧结果，**不要重跑**。 */
  | { kind: "replay"; record: OperationResult; body?: string }
  /** 同 id 不同意图。 */
  | { kind: "conflict"; operationId: string; reason: string }
  /** 同意图正在执行中。 */
  | { kind: "in-progress"; operationId: string; reason: string }
  /** 上次结果不确定（UNCERTAIN），不得盲目重试。 */
  | { kind: "uncertain"; operationId: string; reason: string }
  /** 领取无法同步落盘 —— **绝不执行**。 */
  | { kind: "claim-not-durable"; operationId: string; reason: string };

/**
 * 这个档位要不要进账本。只读 → 否；写 / 高风险 → 是。
 *
 * `policyFor` 的档位判据（`commandOutcome.ts` 的 `sideEffectClassOf` 同一处收口）
 * 这里是它的**唯一**复用点 —— 不要再在通道里各写一遍 `level === "write"`。
 */
export function idempotencyApplies(level: string): boolean {
  return level === "write" || level === "danger";
}

/** 幂等键是否可接受（长度上限见契约）。空串/非字符串按「没带」处理返回 null。 */
export function normalizeOperationId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const id = raw.trim();
  return id === "" ? null : id;
}

/* ── 桌面 IPC 用：方法名的档位查询 ───────────────────────────────────────
 *
 * 桌面通道只知道通道名（`IPC.GIT_COMMIT` 这类常量值，形如 `git:commit`），
 * 不知道 `app_api_call` 的点号方法名。策略表 `policyFor` 按**点号方法名**判档，
 * 所以这里做一次**只读**的通道 → 方法映射：直接查生成的 `API_CATALOG`
 * （来源是 `packages/contracts/src/ipc/rpcMap.ts`，与 preload 同源），
 * 不手写第二份表。找不到（渲染端专用通道 / 新加未生成）→ 视为无副作用，
 * 幂等守卫不介入——误把只读当写会让每次重试都 fsync 整库。
 */
export function methodForChannel(channel: string): string | null {
  for (const e of API_CATALOG) {
    if (e.channel === channel) return e.method;
  }
  return null;
}

/**
 * 领取。调用方**必须先拿到 `execute` 才能产生副作用**。
 *
 * 与 `app_api_call` 的 begin 分支逐字同义（那边有它的历史包袱与工具结果封装，
 * 这里给通道一个不带 ToolResult 形状的版本；账本对象是**同一个**）。
 */
export function beginChannelOperation(
  intent: ChannelOperationIntent,
  ledger: OperationLedger = getOperationLedger(),
): ChannelIdempotencyDecision {
  const begin = ledger.begin({
    operationId: intent.operationId,
    ownerId: intent.ownerId,
    sessionId: intent.sessionId,
    sceneId: intent.sceneId,
    method: intent.method,
    requestDigest: requestDigestOf(intent.input ?? null),
    effectKind: "mutating",
    grantRevision: intent.grantRevision ?? "default",
  });
  switch (begin.begin) {
    case "claimed":
      return {
        kind: "execute",
        operationId: intent.operationId,
        settle: (r, body) =>
          ledger.settle(intent.operationId, { status: r.resultKind, result: r, ...(body !== undefined ? { body } : {}) }),
      };
    case "replay":
      return begin.record.result
        ? { kind: "replay", record: begin.record.result, ...(begin.record.body !== undefined ? { body: begin.record.body } : {}) }
        : {
            kind: "uncertain",
            operationId: intent.operationId,
            reason: "同幂等键的操作之前已登记但没有可回放的结果,无法确认;不要盲目重试。",
          };
    case "conflict":
      return {
        kind: "conflict",
        operationId: intent.operationId,
        reason:
          `operationId「${intent.operationId}」之前被用在另一个不同的操作(方法/参数/主体不同)。` +
          "复用同一个幂等键到别的操作上会被拒;换一个 operationId。",
      };
    case "in-progress":
      return {
        kind: "in-progress",
        operationId: intent.operationId,
        reason: `同一 operationId 的这次操作正在执行中,本次没有重复执行(意图指纹 ${intentFingerprint(begin.record).slice(0, 8)}…)。`,
      };
    case "uncertain":
      return {
        kind: "uncertain",
        operationId: intent.operationId,
        reason: "同幂等键的操作上次结果不确定,不要盲目重试;先确认真实状态。",
      };
    case "claim-not-durable":
      return {
        kind: "claim-not-durable",
        operationId: intent.operationId,
        reason: "这次操作的幂等领取无法同步落盘(磁盘写入失败)。为避免重启后重复执行,本次**没有执行**;确认磁盘可写后重试。",
      };
  }
}

/**
 * 各通道的**统一接线**：`run` 只在领取成功时执行；执行结果（含抛错）一定结算。
 *
 * `toResult` 把通道自己的返回值翻译成 `OperationResult`（结算用），可选返回
 * `body` 一并落账（回放时原样还给调用方）；抛错交给 `onError` 分类 —— 写档抛错
 * 通常意味着「可能已部分提交」（UNCERTAIN）。
 *
 * 返回值：`{ ran: true, result }` 或 `{ ran: false, decision }` —— 通道据此决定
 * 是返回自己的结果还是返回一次拒绝/回放。**不在这里吞掉通道自己的错误形状。**
 */
export async function runWithIdempotency<T>(
  intent: ChannelOperationIntent,
  run: () => Promise<T> | T,
  toResult: (value: T, operationId: string) => OperationResult | { result: OperationResult; body?: string },
  onError: (error: unknown, operationId: string) => OperationResult,
  ledger: OperationLedger = getOperationLedger(),
): Promise<{ ran: true; result: T; operationId: string } | { ran: false; decision: ChannelIdempotencyDecision }> {
  const decision = beginChannelOperation(intent, ledger);
  if (decision.kind === "replay") {
    return { ran: false, decision };
  }
  if (decision.kind !== "execute") return { ran: false, decision };
  try {
    const value = await run();
    const mapped = toResult(value, intent.operationId);
    if ("resultKind" in mapped) decision.settle(mapped);
    else decision.settle(mapped.result, mapped.body);
    return { ran: true, result: value, operationId: intent.operationId };
  } catch (err) {
    decision.settle(onError(err, intent.operationId));
    throw err;
  }
}

/** 面板通道用的 `OperationResult` 兜底构造（与 `tools.ts` 的 makeOp 同形）。
 *  只给「拒绝/在途」这类没有业务返回值的裁决用。 */
export function channelOperationResult(
  kind: OperationResult["resultKind"],
  method: string,
  operationId: string,
  extra: Partial<OperationResult> = {},
): OperationResult {
  return {
    resultKind: kind,
    operationId,
    method,
    retryable: kind === "REJECTED" || kind === "FAILED",
    warnings: [],
    resources: [],
    ...extra,
  };
}

/** 生成一个宿主侧幂等键（没带键的调用不进账本，但结果里的 operationId 仍要有个值）。 */
export function freshOperationId(): string {
  return randomUUID();
}

/** 校验幂等键字节上限 —— 超限的键一律按「没带」处理（不因一个坏键拒绝整个调用）。 */
export function usableOperationId(raw: unknown): string | null {
  const id = normalizeOperationId(raw);
  return id !== null && operationIdWithinLimit(id) ? id : null;
}

/**
 * 手机 RPC 的**显式**写方法表（通道无关幂等的第二条接线）。
 *
 * 为什么不复用 `policyFor`：手机 RPC 的 `claude:sendTurn` / `session:delete` /
 * `git:push` 等方法**不在** `API_CATALOG` 的点号方法表里（它们是手机专用的传输面），
 * `policyFor` 对未知名字按动词兜底猜档（`sendTurn` → write 属偶然正确，`archive`
 * 这类就猜不准）。这张表是**显式**清单：只有在这里的方法才会在带 `operationId` 时
 * 进账本；新增写方法时**必须**同时加进来，否则重试不去重。
 *
 * 与桌面通道一样：没带键 → 原样执行；只读方法 → 永不进账本。
 */
export const MOBILE_MUTATING_METHODS: ReadonlySet<string> = new Set([
  "claude:startSession",
  "claude:sendTurn",
  "claude:approve",
  "session:rename",
  "session:pin",
  "session:archive",
  "session:delete",
  "session:updateSettings",
  "session:saveMessages",
  "session:upsertMessages",
  "session:truncateAndInsertMessages",
  "session:updateBookmarks",
  "project:archive",
  "project:delete",
  "project:setGroup",
  "project:reorder",
  "project:pin",
  "project:rename",
  "git:stage",
  "git:unstage",
  "git:commit",
  "git:push",
  "git:pull",
  "git:checkout",
]);

/** 手机通道的档位：显式表命中 → 有副作用；否则只读。 */
export function mobileMethodIsMutating(method: string): boolean {
  return MOBILE_MUTATING_METHODS.has(method);
}

/** 桌面 IPC 的幂等键约定：渲染端在入参对象里带 `__operationId`。
 *
 *  为什么放在入参里而不是给 IPC 加第三参数：preload 是 contextBridge 的单层
 *  `invoke(channel, input)`，加参数要改 `RpcMap` 全部 313 个签名；入参里带一个
 *  名字唯一的键是**不侵入契约**的最小接线，且 handler 自己会忽略未知字段（zod
 *  `.object()` 默认 strip）。 */
export const DESKTOP_OPERATION_ID_KEY = "__operationId";

/** 从桌面 IPC 的原始入参里取出幂等键（不改动入参对象）。 */
export function operationIdFromIpcInput(raw: unknown): string | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  return usableOperationId((raw as Record<string, unknown>)[DESKTOP_OPERATION_ID_KEY]);
}

