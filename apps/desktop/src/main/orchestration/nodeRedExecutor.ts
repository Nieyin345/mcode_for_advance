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
 * ## 为什么这个执行器不注册成内置 kind
 *
 * 它是**可选能力**：Node-RED 没装时注册它会让清单里出现一个永远跑不了的 kind。
 * 生产装配在"引擎可用"时才把执行器挂进 `ExecutionEngine`（见 `createWorkflowEngineExecutor`），
 * 这与 `module-capability` 的 fail-closed 是同一种取向。
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

/** 回环判据 —— 与 `checkDocumentViewUrl` 同一份取向（只放行本机回环）。 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

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
  const port = parsed.port === "" ? (parsed.protocol === "https:" ? 443 : 80) : Number(parsed.port);
  if (port !== runtimePort) {
    return {
      ok: false,
      reason: `工作流引擎节点只能访问本引擎的端口（${runtimePort}），拒绝 ${port}`,
    };
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
    kind: "node-red",
    capabilities: {
      supportsCancellation: true,
      supportsArtifacts: false,
      inputKinds: ["json", "text"],
      outputKinds: ["json", "text"],
    },
    async execute(context: ExecutionContext): Promise<NodeOutcome> {
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
      const spec = readRequestSpec(context.node.params);
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
      const controller = new AbortController();
      const onAbort = (): void => controller.abort();
      context.input.signal.addEventListener("abort", onAbort, { once: true });
      try {
        const res = await ports.fetch({
          url: checked.url,
          method: (spec.method || "POST").toUpperCase(),
          headers: { "content-type": "application/json", ...(spec.headers ?? {}) },
          body: spec.body ?? null,
          signal: controller.signal,
        });
        const ok = res.status >= 200 && res.status < 300;
        let parsed: unknown = res.text;
        try {
          parsed = JSON.parse(res.text);
        } catch {
          /* 不是 JSON 就按文本交付 */
        }
        const summaryLine = `Node-RED ${res.status}${res.truncated ? "（响应已截断）" : ""}`;
        if (!ok) {
          return {
            status: "failed",
            summary: summaryLine,
            error: `引擎返回 HTTP ${res.status}${res.truncated ? "（响应已截断）" : ""}`,
            // 5xx 可能是引擎内部瞬时故障；4xx 是请求本身的问题。
            retryable: res.status >= 500,
          };
        }
        return {
          status: "success",
          summary: summaryLine,
          outputs: { status: res.status, body: parsed, truncated: res.truncated },
        };
      } catch (err) {
        const aborted = context.input.signal.aborted;
        return {
          status: aborted ? "cancelled" : "failed",
          summary: "",
          error: aborted
            ? "已取消"
            : `请求工作流引擎失败：${err instanceof Error ? err.message : String(err)}`,
          retryable: !aborted,
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
  return { status: res.status, text: new TextDecoder().decode(merged), truncated };
}
