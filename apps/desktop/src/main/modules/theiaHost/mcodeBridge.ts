/**
 * 扩展 → Mcode 能力桥。
 *
 * ## 它解决什么
 *
 * Mcode 的功能面（446 条 RPC、工作流、资料库、记忆……）对 `.vsix` 扩展原本不可见。
 * 本模块把那片面**动态**暴露出去：扩展写
 *
 * ```js
 * await vscode.commands.executeCommand("mcode.workflow.run", { ... });
 * ```
 *
 * 前缀 `mcode.` 在 `host.ts` 的 `$executeCommand` 里被截住，转到主进程的派发管线。
 *
 * ## 为什么用「命令」而不是 `vscode.mcode.*` 命名空间
 *
 * `commands.executeCommand(id, ...args)` 是 VS Code 原生机制，而 Theia 的
 * `$executeCommand` 已经在我们的控制下（`COMMAND_REGISTRY_MAIN`）。所以：
 *
 *  - **不用改 `vendor/theia`**（不需要 patch series）；
 *  - **不用出 SDK**（扩展作者不需要学第二套 API）；
 *  - **天然可扩充** —— 派发不查静态表，走 `panelApiCall`，它自己从 `API_CATALOG`
 *    （由 `rpcMap.ts` 生成）里 `findEntry`。加一条 RPC → 重跑生成器 → 扩展立刻能调，
 *    **本文件一行不用改**。
 *
 * ## 权限：与 agent / 自定义面板**同一条**管线
 *
 * `panelApiCall` 内部走 `findEntry` → `policyFor` → `secretSettingRefusal` →
 * `callRpc` → `redactValue`，与 agent 的 `app_api_call`、面板的 `mcode.api.call`
 * 完全同源。所以 blocked 档（`customModel.getToken` 等）扩展够不到，danger 档每次要
 * 用户点头。
 *
 * ⚠️ **不要在这里另写一套权限判定。** 第二份判定迟早和 `policy.ts` 漂移。
 *
 * ## 审批落到哪
 *
 * 扩展代码是一条 `await`，中间插不进用户交互。所以本模块**不接受**扩展自己传
 * `approved`（那等于自批准），而是要求宿主注入审批端口；没有端口 = 写/danger 档
 * fail-closed。
 */
import type { OperationResult } from "@contracts/appControl";
import type { BuiltinMcCommand } from "../builtinMcCommands.js";

/** 扩展发来的 Mcode 命令前缀。`mcode.workflow.run` → `workflow.run`。 */
export const MCODE_COMMAND_PREFIX = "mcode." as const;

/** 一次扩展 → Mcode 调用的结果。**不抛** —— 扩展侧读到的是普通对象。
 *  形状与 `panelApiCall` 的返回保持一致，两条路的消费者读同样的字段。 */
export interface McodeBridgeResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  /** 需要用户批准但没拿到。扩展据此知道「不是坏了，是被挡了」。 */
  needsApproval?: boolean;
  level?: "write" | "danger";
  description?: string;
  operation?: OperationResult;
}

/** 宿主注入的派发器 —— 生产环境是 `panelApiCall` 的薄包装。 */
export type McodeDispatch = (
  method: string,
  input: unknown,
  approved: boolean,
  label: string,
  operationId?: string,
) => Promise<McodeBridgeResult>;

/** 宿主注入的审批端口。**返回 true = 批准**。 */
export type McodeApprovalPort = (request: {
  method: string;
  level: "write" | "danger";
  description: string;
  extensionId: string;
  input: unknown;
}) => Promise<boolean>;

export interface McodeBridgeOptions {
  dispatch: McodeDispatch;
  /** 缺省 = 没有审批通道 → 写/danger 档 fail-closed。 */
  requestApproval?: McodeApprovalPort;
  /** 谁在调 —— 只用于审批框正文与日志，不参与任何判据。 */
  extensionId: () => string;
  /** 内置 Mcode 命令表（`mcode.file.*`）。命中就地执行，不落 `panelApiCall`。 */
  builtinLookup?: (id: string) => BuiltinMcCommand | undefined;
  /** 已知工作区根的判定（内置文件命令的围栏用）。 */
  knownRoot?: (path: string) => boolean;
  log?: (entry: { level: "debug" | "info" | "warn"; message: string }) => void;
}

/**
 * 判断命令 id 是不是「要转给 Mcode」的。
 *
 * ⚠️ **只认 `mcode.` 前缀。** 不用 `startsWith("mcode")` —— 那会把
 * `mcode-something.xxx` 之类的第三方命令也吃进来。前缀后必须还有内容。
 */
export function isMcodeCommand(id: string): boolean {
  return id.startsWith(MCODE_COMMAND_PREFIX) && id.length > MCODE_COMMAND_PREFIX.length;
}

/** `mcode.workflow.run` → `workflow.run`。 */
export function mcodeMethodOf(id: string): string {
  return id.slice(MCODE_COMMAND_PREFIX.length);
}

export function createMcodeBridge(options: McodeBridgeOptions): {
  invoke(id: string, args: readonly unknown[]): Promise<McodeBridgeResult>;
} {
  const { dispatch, requestApproval, extensionId, builtinLookup, knownRoot, log } = options;

  return {
    async invoke(id: string, args: readonly unknown[]): Promise<McodeBridgeResult> {
      const method = mcodeMethodOf(id);
      // 入参：`[input]` 或 `[input, {operationId}]`。
      let input: unknown = args[0];
      let operationId: string | undefined;
      if (args.length > 2) {
        return { ok: false, error: `Mcode 命令 ${id} 最多接受 2 个参数（入参、可选的 { operationId }），收到 ${args.length} 个。` };
      }
      if (args.length === 2) {
        const second = args[1];
        if (
          second !== null && typeof second === "object" &&
          "operationId" in second && typeof (second as { operationId?: unknown }).operationId === "string"
        ) {
          operationId = (second as { operationId: string }).operationId;
        } else {
          // 静默丢掉第二个参数会让扩展以为它传进去了 —— 明确报错。
          return { ok: false, error: `Mcode 命令 ${id} 的第二个参数只接受 { operationId: string }，收到 ${typeof second}。` };
        }
      }

      // **先查内置命令表**（`mcode.file.*`）。顺序是安全属性：内置表在前，
      // 扩展就无法用同名 `mcode.*` 覆盖掉它们。
      if (builtinLookup) {
        const builtin = builtinLookup(id);
        if (builtin) {
          const path = (input as { path?: unknown } | undefined)?.path;
          if (typeof path !== "string" || path.trim() === "") {
            return { ok: false, error: `Mcode 内置命令 ${id} 需要一个 { path } 入参。` };
          }
          try {
            const value = await builtin.run({
              path,
              knownRoot: knownRoot ?? (() => true),
              signal: new AbortController().signal,
            });
            return { ok: true, result: value };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
          }
        }
      }

      // 第一次派发：**不带 approved**。`panelApiCall` 对只读档直接执行；对 write/danger
      // 档返回 `needsApproval`（它自己的契约是不弹框）。
      let outcome: McodeBridgeResult;
      try {
        outcome = await dispatch(method, input, false, "VS Code 扩展：" + extensionId(), operationId);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }

      if (outcome.needsApproval !== true) return outcome;

      // 需要批准。**先看有没有审批通道** —— 没有就 fail-closed。
      if (!requestApproval) {
        log?.({ level: "warn", message: `扩展 ${extensionId()} 调用了 ${method}（${outcome.level ?? "write"} 档）但没有审批通道，已拒绝` });
        return {
          ...outcome,
          ok: false,
          error: outcome.error ?? `Mcode 功能 ${method} 属于 ${outcome.level ?? "write"} 档，需要用户批准；当前环境没有审批通道，未执行。`,
        };
      }

      let approved = false;
      try {
        approved = await requestApproval({
          method,
          level: outcome.level === "danger" ? "danger" : "write",
          description: outcome.description ?? method,
          extensionId: extensionId(),
          input,
        });
      } catch (error) {
        return { ...outcome, ok: false, error: `批准流程失败：${error instanceof Error ? error.message : String(error)}` };
      }
      if (!approved) {
        log?.({ level: "info", message: `用户拒绝了扩展 ${extensionId()} 对 ${method} 的调用` });
        return { ...outcome, ok: false, needsApproval: true, error: `用户拒绝了 ${method} 的执行，未执行。` };
      }

      // 第二次派发：这次带 approved。
      try {
        return await dispatch(method, input, true, "VS Code 扩展：" + extensionId(), operationId);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
