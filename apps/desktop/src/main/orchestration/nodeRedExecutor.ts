/**
 * 【ARC-006 WF-INT · 桥 1】**Node-RED 触发执行器**。
 *
 * ## 它做什么
 *
 * Mcode 工作流里的一个节点，向**宿主监管的第三方引擎**（Node-RED）发一次 HTTP
 * 请求，把响应变成普通的 `NodeOutcome` —— 下游节点与结果卡片看到的东西，与
 * `command` / `code` / `module-capability` 节点没有区别。
 *
 * ## 安全边界（逐条，与方案文档一致）
 *
 * 1. **只发回环**：目标 URL 必须落在 `127.0.0.1|<runtimePort>`（或 `localhost` /
 *    `[::1]` 的同端口）。节点参数里写 `https://example.com` 一律拒绝 —— 这不是
 *    "网络请求节点"，第三方引擎的流自己该出网的话由引擎侧治理。
 * 2. **引擎必须 running**：`status()` 不是 running 就失败，不自己去起进程
 *    （起停是用户的动作，节点不该有副作用）。
 * 3. **不信任节点给的 host**：端口只认宿主给的那一个，节点只能给路径、方法、载荷。
 * 4. **响应有上限**：超过 `maxResponseBytes` 截断并如实说明（不让一条大响应撑爆内存）。
 *
 * ## 为什么这个执行器是**条件注册**的
 *
 * 它是**可选能力**：Node-RED 没装/没起时注册它，节点会在派发时失败在"没有执行器"
 * 上，而不是一句能照着做的"去启动引擎"。生产装配在"引擎可用"时才把执行器挂进
 * `ExecutionEngine`（见 `executionEngine.ts` 的 `setWorkflowEngineStatusPort` 与
 * `createBuiltinExecutionEngine`），这与 `module-capability` 的 fail-closed 是同一种取向。
 *
 * ⚠️ **但 `node-red` 在 `IMPLEMENTED_RUNNER_KINDS` 里**（2026-10-18 三处同源落地）。
 * 那张表回答的是"Mcode 有没有实现这种执行方式"，不是"这台机器此刻装没装"。引擎缺席
 * 由清单的 `requirements: [{ kind: "executor", id: "node-red" }]` 表达 —— 调度器的
 * 能力预检拿它对本次运行实际注册的执行器，缺了就以「缺少执行器「node-red」」失败。
 * 把它排除在那张表外会让 `isNodeRunnable` 恒 false：引擎跑着的机器上画布也永远标
 * "跑不了"，而 schema 认得它 → `workflow-extension-seams-smoke` 当场红。
 */
import type { NodeOutcome } from "@contracts/nodeType";
import type { ExecutionContext } from "./executionContext.js";
import type { NodeExecutor } from "./executorRegistry.js";
import type { EngineRuntimeStatus } from "@main/workflowEngines/runtimeSupervisor.js";

/** 执行器只依赖这一个面，便于在套件里注入假引擎/假 fetch。 */
export interface NodeRedEnginePort {
  status(): EngineRuntimeStatus;
}

export interface NodeRedFetchRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  signal: AbortSignal;
}

export interface NodeRedFetchResponse {
  status: number;
  text: string;
  truncated: boolean;
}

export interface NodeRedExecutorPorts {
  engine: NodeRedEnginePort;
  fetch(request: NodeRedFetchRequest): Promise<NodeRedFetchResponse>;
  /** 单次响应上限（字节，按 UTF-8 近似）。 */
  maxResponseBytes?: number;
}

const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;

/** 这种节点的 `runner.kind` —— 与清单 `mcode.node-red` 的 runner 一致（清单 import
 *  本常量，不写字面量）。**在** `IMPLEMENTED_RUNNER_KINDS` 里：执行方式本身已实现，
 *  "这台机器此刻能不能跑"由清单的 executor `requirements` + 条件注册回答（见文件头）。 */
export const NODE_RED_RUNNER_KIND = "node-red";

/** 宿主监管的引擎 id（与 `workflowEngines/registry.ts` 的注册 id 一致）。 */
export const NODE_RED_ENGINE_ID = "node-red";

/** 回环判据 —— 与 `checkDocumentViewUrl` 同一份取向（只放行本机回环）。 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
// 与 nodeTypes.ts 的画布 select 保持相同方法集合，不允许调用者把
// CONNECT/TRACE 或带 CRLF 的非标准方法直接交给可替换的 HTTP 适配器。
const HTTP_IN_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/** 同端口 ≠ 同进程：真实 EngineRuntime.status 总带宿主生成的 epoch。
 * 旧注入型状态口如果双方都缺 epoch，兼容既有假 SDK/历史测试，不能把
 * 那条 fallback 称为实例身份保证；单边有 epoch 却缺对侧必须拒绝。 */
function sameRunningEngine(initial: EngineRuntimeStatus, current: EngineRuntimeStatus): boolean {
  if (current.state !== "running" || current.port !== initial.port
      || current.engineId !== initial.engineId) return false;
  const before = initial.instanceEpoch;
  const after = current.instanceEpoch;
  if (before === undefined && after === undefined) return true;
  return typeof before === "string" && before.length > 0 && before === after;
}

/**
 * 校验并规范化节点给的 URL：host 必须回环、端口必须等于宿主给的那个。
 * 返回 `null` = 拒绝，并带一句人话。
 */
export function checkEngineRequestUrl(
  raw: string,
  runtimePort: number,
): { ok: true; url: string } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw, `http://127.0.0.1:${runtimePort}/`);
  } catch {
    return { ok: false, reason: `不是合法的 URL：${raw.slice(0, 200)}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: `工作流引擎节点只发 HTTP(S)，拒绝 ${parsed.protocol}` };
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    return { ok: false, reason: `工作流引擎节点只访问本机回环，拒绝远程地址：${parsed.hostname}` };
  }
  // URL userinfo 会隐式产生 Basic Auth；fragment 实际不随 HTTP 发送，二者都
  // 不应成为代理发往受监管引擎的隐式参数。
  if (parsed.username !== "" || parsed.password !== "") {
    return { ok: false, reason: "工作流引擎节点不允许在 URL 中携带用户凭据" };
  }
  if (parsed.hash !== "") {
    return { ok: false, reason: "工作流引擎节点不允许 URL fragment（片段不会发送给引擎）" };
  }
  const port = parsed.port === "" ? (parsed.protocol === "https:" ? 443 : 80) : Number(parsed.port);
  if (port !== runtimePort) {
    return {
      ok: false,
      reason: `工作流引擎节点只能访问本引擎的端口（${runtimePort}），拒绝 ${port}`,
    };
  }
  // 同一端口不意味着同一权限域。生产 Node-RED 将 httpAdminRoot 挂在
  // "/"，HTTP-in 数据面挂在 "/api"；普通 workflow 执行器绝不能
  // 仅凭回环同端口就访问 /flows、/settings 或 /nodes 等管理 API。
  // 使用 URL 规范化后的 pathname，以拒绝 /api/../flows 和 %2e%2e 等穿越。
  if (!parsed.pathname.startsWith("/api/")) {
    return { ok: false, reason: "工作流节点仅允许访问 Node-RED HTTP-in 数据面 /api/，拒绝管理 API 或其他路径" };
  }
  return { ok: true, url: parsed.toString() };
}

/** 从节点参数里读一次请求的形状（不做变量展开 —— 那是调度器的事）。 */
export interface NodeRedRequestSpec {
  path: string;
  method: string;
  headers?: Record<string, string>;
  body?: string | null;
}

export function nodeRedExecutor(ports: NodeRedExecutorPorts): NodeExecutor {
  const maxBytes = ports.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  return {
    kind: NODE_RED_RUNNER_KIND,
    capabilities: {
      supportsCancellation: true,
      supportsArtifacts: false,
      inputKinds: ["json", "text"],
      outputKinds: ["json", "text"],
    },
    async execute(context: ExecutionContext): Promise<NodeOutcome> {
      // AbortSignal 的 abort 事件不会为晚注册的监听器重播；必须先读状态。
      if (context.input.signal.aborted) {
        return { status: "cancelled", summary: "", error: "已取消", retryable: false };
      }
      // 错误配置不能把响应限制静默取消，尤其在自定义 fetch 忽略限额时。
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
        return { status: "failed", summary: "", error: "工作流引擎响应字节上限配置无效", retryable: false };
      }
      const status = ports.engine.status();
      if (status.state !== "running" || status.port === null) {
        return {
          status: "failed",
          summary: "",
          // 终态：引擎没起来，同样的输入重跑也不会变 —— 用户要去启动引擎。
          error: status.state === "failed"
            ? `工作流引擎启动失败：${status.reason ?? "未知原因"}`
            : "工作流引擎尚未运行 —— 请先在「工作流引擎」面板启动它",
          retryable: false,
        };
      }
      // 参数是**三个扁平键**（与清单 `mcode.node-red` 的格子一一对应）：
      // 画布上用户填的就是 path/method/body，不存在一个嵌套的 "engineRequest" 对象。
      // 优先读宿主专用 builder 塑好的 `input.engineRequest` —— 那份经过调度器的
      // 模板解算（`{{上游.字段}}` 在 `engineBody` 里也能用）；执行器手上的
      // `node.params` 是**存盘原值**，只在直接构造上下文的套件里才作为回落来源。
      const spec = context.input.engineRequest ?? readRequestSpec(context.node.params);
      if (spec === null) {
        return {
          status: "failed",
          summary: "",
          error: "节点缺少「路径」参数（enginePath）",
          retryable: false,
        };
      }
      const checked = checkEngineRequestUrl(spec.path, status.port);
      if (!checked.ok) {
        return { status: "failed", summary: "", error: checked.reason, retryable: false };
      }
      const method = (spec.method || "POST").toUpperCase();
      if (!HTTP_IN_METHODS.has(method)) {
        return {
          status: "failed", summary: "",
          error: "HTTP-in 请求方法不在允许范围（GET/POST/PUT/PATCH/DELETE）",
          retryable: false,
        };
      }
      const controller = new AbortController();
      const onAbort = (): void => controller.abort();
      context.input.signal.addEventListener("abort", onAbort, { once: true });
      try {
        // 在读取参数与监听器安装之间仍可能被取消，不能漏过这一窗口。
        if (context.input.signal.aborted) {
          controller.abort();
          return { status: "cancelled", summary: "", error: "已取消", retryable: false };
        }
        const res = await ports.fetch({
          url: checked.url,
          method,
          headers: { "content-type": "application/json", ...(spec.headers ?? {}) },
          body: spec.body ?? null,
          signal: controller.signal,
        });
        // 一些注入的 fetch 实现会忽略 signal，晚到的成功响应也不能覆盖取消态。
        if (context.input.signal.aborted) {
          return { status: "cancelled", summary: "", error: "已取消", retryable: false };
        }
        // 自定义 fetch 可能在引擎已 stop/crash/换端口后才返回上一代的 200。
        // 这不是本次仍可执行的工作流结果，不能交给下游；不自动换引擎重试。
        const current = ports.engine.status();
        if (!sameRunningEngine(status, current)) {
          return {
            status: "failed", summary: "",
            error: "工作流引擎在请求期间已停止或端口切换，拒绝使用过期响应",
            retryable: false,
          };
        }
        // 注入的 fetch 可能没有按限制读取；这里是 Agent 最终输出前的最后一道闸。
        const responseBytes = Buffer.from(res.text, "utf8");
        const overLimit = responseBytes.byteLength > maxBytes;
        let safeText = res.text;
        if (overLimit) {
          // 在 UTF-8 码点边界截断，避免因为半个中文字符产生 U+FFFD 并超出字节限额。
          const decoder = new TextDecoder("utf-8", { fatal: true });
          let end = maxBytes;
          while (end > 0) {
            try {
              safeText = decoder.decode(responseBytes.subarray(0, end));
              break;
            } catch {
              end--;
            }
          }
          if (end === 0) safeText = "";
        }
        const truncated = res.truncated || overLimit;
        const ok = res.status >= 200 && res.status < 300;
        let parsed: unknown = safeText;
        try {
          parsed = JSON.parse(safeText);
        } catch {
          /* 截断或非 JSON 就按文本交付 */
        }
        const summaryLine = `Node-RED ${res.status}${truncated ? "（响应已截断）" : ""}`;
        if (!ok) {
          return {
            status: "failed",
            summary: summaryLine,
            error: `引擎返回 HTTP ${res.status}${truncated ? "（响应已截断）" : ""}`,
            // 5xx 可能是引擎内部瞬时故障；4xx 是请求本身的问题。
            retryable: res.status >= 500,
          };
        }
        return {
          status: "success",
          summary: summaryLine,
          outputs: { status: res.status, body: parsed, truncated },
        };
      } catch (err) {
        const aborted = context.input.signal.aborted;
        // 失效引擎抛出的传输错误并非同一实例的瞬时 HTTP 5xx；
        // 让调度器自动重试可能错误命中新启动/切换项目后的另一个引擎。
        let sameEngine = false;
        try {
          const current = ports.engine.status();
          sameEngine = sameRunningEngine(status, current);
        } catch {
          // 状态本身不可读时也拒绝自动重试。
        }
        return {
          status: aborted ? "cancelled" : "failed",
          summary: "",
          error: aborted
            ? "已取消"
            : sameEngine
              ? `请求工作流引擎失败：${err instanceof Error ? err.message : String(err)}`
              : "工作流引擎请求期间已停止、切换或状态不可读，拒绝自动重试",
          retryable: !aborted && sameEngine,
        };
      } finally {
        context.input.signal.removeEventListener("abort", onAbort);
      }
    },
  };
}

/** 节点参数键 —— 与清单 `mcode.node-red` 的三格一一对应。 */
export const NODE_RED_PATH_PARAM = "enginePath";
export const NODE_RED_METHOD_PARAM = "engineMethod";
export const NODE_RED_BODY_PARAM = "engineBody";

/** 从节点参数读一次请求形状；路径缺失返回 null（执行器报明确错误）。 */
export function readRequestSpec(params: Record<string, unknown>): NodeRedRequestSpec | null {
  const path = params[NODE_RED_PATH_PARAM];
  if (typeof path !== "string" || path.trim() === "") return null;
  const method = params[NODE_RED_METHOD_PARAM];
  const body = params[NODE_RED_BODY_PARAM];
  return {
    path,
    method: typeof method === "string" && method !== "" ? method : "POST",
    body: typeof body === "string" ? body : null,
  };
}

/** 生产 fetch 实现：真发 HTTP，带响应上限。 */
export async function defaultNodeRedFetch(
  request: NodeRedFetchRequest,
  maxBytes = DEFAULT_MAX_RESPONSE_BYTES,
): Promise<NodeRedFetchResponse> {
  const res = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    ...(request.body !== null ? { body: request.body } : {}),
    signal: request.signal,
    redirect: "manual",
  });
  const reader = res.body?.getReader();
  if (reader === undefined) {
    return { status: res.status, text: "", truncated: false };
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) {
      chunks.push(value);
      size += value.byteLength;
      if (size > maxBytes) {
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
    }
  }
  const merged = new Uint8Array(size > maxBytes ? maxBytes : size);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= merged.byteLength) break;
    const take = Math.min(chunk.byteLength, merged.byteLength - offset);
    merged.set(chunk.subarray(0, take), offset);
    offset += take;
  }
  // 字节上限可能正好截在多字节字符中间；TextDecoder 的默认
  // 替换符 U+FFFD 会把未收到的字节误表达成服务端内容。
  // 只在我们主动截断时丢弃末尾不完整码点；原本非法的响应字节仍
  // 交给 TextDecoder 按标准替换，不悄悄丢掉整个消息。
  let validLength = merged.byteLength;
  if (truncated && validLength > 0) {
    let leadIndex = validLength - 1;
    while (leadIndex >= 0 && (merged[leadIndex]! & 0xc0) === 0x80) leadIndex--;
    if (leadIndex < 0) {
      validLength = 0;
    } else {
      const lead = merged[leadIndex]!;
      const width = lead >= 0xf0 && lead <= 0xf4 ? 4
        : lead >= 0xe0 && lead <= 0xef ? 3
        : lead >= 0xc2 && lead <= 0xdf ? 2 : 1;
      if (validLength - leadIndex < width) validLength = leadIndex;
    }
  }
  return { status: res.status, text: new TextDecoder().decode(merged.subarray(0, validLength)), truncated };
}
