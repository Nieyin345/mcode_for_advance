/**
 * **向网关端点发一次轻请求** —— 设置页「模型配置」里三个引擎共用的那条通道。
 *
 * 两个用途（2026-10-11 加，用户要「拉模型列表」与「连通性测试」两个引擎也要有）：
 *
 *  1. `listEndpointModels` —— 问端点「你有哪些模型」（`GET /models` 或
 *     `/v1/models`，取 `data[].id`），填进设置页的下拉框，省得用户手打模型 id。
 *  2. `probeEndpoint` —— 发一次最小的对话请求，确认「地址 + 密钥 + 模型名」这一组
 *     真能用。返回的 detail/error 原样进设置页那行状态字。
 *
 * ## 为什么单独一个文件
 *
 * 这两件都是「按用户填的地址发 HTTP」——是本应用里少有的**主进程主动外连**的地方。
 * 单独放一处，路径拼接、超时、错误文案只有一份实现（仓库硬规矩：共享实现只有一份），
 * 三个引擎的 handler 都调它。
 *
 * ## 只做最保守的两件事
 *
 * - 只认 http(s)；相对地址、别的协议一律拒。
 * - 超时硬上限（`ENDPOINT_PROBE_TIMEOUT_MS`），绝不无限等。
 *
 * ⚠️ 发出的请求**不带任何 mcode 自己的标识头**（除了调用方明确给的 `headers`）——
 * 不往用户没配的地方撒指纹。
 */

/** 默认超时。比一次真回合短很多 —— 这是连通性探测，不是跑任务。 */
export const ENDPOINT_PROBE_TIMEOUT_MS = 15_000;

export interface EndpointProbeResult {
  ok: boolean;
  /** 成功时的一句话（人话，不是 HTTP 术语）。 */
  detail?: string;
  /** 失败时的原因（已翻成人话，可直接进界面）。 */
  error?: string;
}

/** 地址合法吗：必须是 http(s) 绝对地址。 */
function assertHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("地址不是一个合法的 URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("地址必须以 http:// 或 https:// 开头");
  }
  return url;
}

/** 把 base URL 与「模型列表」的相对路径拼起来，避免 `//` 或丢掉已有路径段。 */
function joinUrl(base: string, suffix: string): string {
  const trimmed = base.replace(/\/+$/, "");
  const path = suffix.startsWith("/") ? suffix : `/${suffix}`;
  return `${trimmed}${path}`;
}

/** 一次带超时的 fetch。返回 Response；网络层失败抛人话。 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } catch (err) {
    // AbortError 与网络错误分开说 —— 前者是「等太久」，后者多半是地址/网络不通。
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`请求超时(超过 ${Math.round(timeoutMs / 1000)} 秒没有响应)`);
    }
    throw new Error(`连不上这个地址:${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 问端点「你有哪些模型」。两种常见形态都试：
 *  - Anthropic 风格：`GET {base}/v1/models`，`data: [{id}]`；
 *  - OpenAI 风格：`GET {base}/models`，`data: [{id}]`。
 *
 * ⚠️ **端点不一定有这条路由**（很多第三方网关没有）。拉不到就是拉不到 —— 抛人话，
 * 由调用方回退到「手动填模型 id」，绝不静默返回空数组假装成功。
 */
export async function listEndpointModels(args: {
  baseUrl: string;
  apiKey?: string;
  /** 认证头形态：`bearer` → `Authorization: Bearer x`；`x-api-key` → `x-api-key: x`。 */
  authMode?: "bearer" | "x-api-key";
  headers?: Record<string, string>;
  /** Anthropic 风格端点要 `anthropic-version` 头才肯列。 */
  anthropicVersion?: boolean;
  timeoutMs?: number;
}): Promise<{ models: string[] }> {
  const base = assertHttpUrl(args.baseUrl).toString();
  const timeoutMs = args.timeoutMs ?? ENDPOINT_PROBE_TIMEOUT_MS;
  const headers: Record<string, string> = { Accept: "application/json", ...(args.headers ?? {}) };
  if (args.apiKey) {
    if (args.authMode === "x-api-key") headers["x-api-key"] = args.apiKey;
    else headers["Authorization"] = `Bearer ${args.apiKey}`;
  }
  if (args.anthropicVersion) headers["anthropic-version"] = "2023-06-01";

  // 两条候选路径都试；先 /v1/models（Anthropic 与多数网关），再 /models。
  const candidates = [joinUrl(base, "/v1/models"), joinUrl(base, "/models")];
  let lastError = "";
  for (const url of candidates) {
    let res: Response;
    try {
      res = await fetchWithTimeout(url, { method: "GET", headers }, timeoutMs);
    } catch (err) {
      lastError = (err as Error).message;
      continue;
    }
    if (!res.ok) {
      lastError = `端点返回 ${res.status}`;
      continue;
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      lastError = "端点返回的不是 JSON";
      continue;
    }
    const ids = extractModelIds(body);
    if (ids.length > 0) return { models: ids };
    lastError = "端点的返回里没有模型列表";
  }
  throw new Error(lastError || "这个端点没有「列出模型」的接口");
}

/** 从各种形态的 `{data:[...]}` / `{models:[...]}` / 裸数组里抠出模型 id。 */
function extractModelIds(body: unknown): string[] {
  const arr = Array.isArray(body)
    ? body
    : body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data)
      ? ((body as { data: unknown[] }).data)
      : body && typeof body === "object" && Array.isArray((body as { models?: unknown }).models)
        ? ((body as { models: unknown[] }).models)
        : [];
  const out: string[] = [];
  for (const item of arr) {
    if (typeof item === "string" && item.trim()) out.push(item.trim());
    else if (item && typeof item === "object") {
      const id = (item as { id?: unknown; name?: unknown }).id ?? (item as { name?: unknown }).name;
      if (typeof id === "string" && id.trim()) out.push(id.trim());
    }
  }
  // 去重，保持出现顺序。
  return [...new Set(out)];
}

/**
 * 连通性测试：发一条最小对话请求，确认地址 + 密钥 + 模型名这组真能用。
 *
 * 形态与 `listEndpointModels` 一致：先 Anthropic 的 `/v1/messages`，再 OpenAI 的
 * `/v1/chat/completions`。任何一条 2xx 就算通；全失败则把最后一次的原因抛出去。
 */
export async function probeEndpoint(args: {
  baseUrl: string;
  apiKey?: string;
  model: string;
  authMode?: "bearer" | "x-api-key";
  headers?: Record<string, string>;
  /** Anthropic 风格端点要 `anthropic-version` 头（与 listEndpointModels 一致）。 */
  anthropicVersion?: boolean;
  timeoutMs?: number;
}): Promise<EndpointProbeResult> {
  const base = assertHttpUrl(args.baseUrl).toString();
  const timeoutMs = args.timeoutMs ?? ENDPOINT_PROBE_TIMEOUT_MS;
  const attempt = async (
    url: string,
    body: unknown,
    extraHeaders: Record<string, string>,
  ): Promise<EndpointProbeResult> => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      Accept: "application/json",
      ...(args.headers ?? {}),
      ...extraHeaders,
    };
    if (args.apiKey) {
      if (args.authMode === "x-api-key") headers["x-api-key"] = args.apiKey;
      else headers["Authorization"] = `Bearer ${args.apiKey}`;
    }
    let res: Response;
    try {
      res = await fetchWithTimeout(url, { method: "POST", headers, body: JSON.stringify(body) }, timeoutMs);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    if (res.ok) return { ok: true, detail: `连接成功(${args.model})` };
    // 读一小段响应体做线索——网关常把「模型不存在」写在里面。
    let snippet = "";
    try {
      snippet = (await res.text()).slice(0, 200);
    } catch {
      /* ignore */
    }
    return { ok: false, error: `端点返回 ${res.status}${snippet ? `:${snippet}` : ""}` };
  };

  // Anthropic Messages 形态（始终带 anthropic-version —— 这条路由本来就是 Anthropic 的）。
  const anthropic = await attempt(
    joinUrl(base, "/v1/messages"),
    { model: args.model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] },
    { "anthropic-version": "2023-06-01" },
  );
  if (anthropic.ok) return anthropic;
  const openai = await attempt(
    joinUrl(base, "/v1/chat/completions"),
    { model: args.model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] },
    {},
  );
  if (openai.ok) return openai;
  // 两条都不通：把 OpenAI 那条的错误报出去（多数第三方网关是这条），
  // 但把 Anthropic 的也带上，免得用户只看一条线索找错方向。
  return { ok: false, error: `${openai.error};另试 /v1/messages:${anthropic.error}` };
}
