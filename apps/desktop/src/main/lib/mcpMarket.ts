/**
 * MCP 市场 —— 设置 → MCP 的「市场」tab。
 *
 * 源 = 说官方 MCP Registry API 的注册中心(`GET <base>/v0.1/servers`)。内置官方那个
 * (registry.modelcontextprotocol.io),用户可以再加自己的(公司内部子注册中心、镜像)。
 * 条目实时查询(官方库有几千个,不在本地存目录),每条换算成现成的安装方式:
 *  - npm → `npx -y <包>@<版本>`;PyPI → `uvx <包>==<版本>`;OCI → `docker run -i --rm`;
 *    NuGet → `dnx`;远程 → http / sse;
 *  - 要用户填的值(环境变量、请求头、必填参数)列成 inputs,渲染端填好后走 `mcp.save`。
 * 这里不写任何配置 —— 安装仍走用户级保存那条老路(名字校验、密钥处理都在那儿)。
 */
import {
  type McpMarketArg,
  type McpMarketEntry,
  type McpMarketInput,
  type McpMarketOption,
  type McpMarketSearchResult,
  type McpMarketSource,
} from "@contracts/ipc";
import { SettingRepo } from "@main/store/repositories.js";

export const MCP_MARKET_SOURCES_SETTING_KEY = "mcp.marketSources";

export const OFFICIAL_MCP_REGISTRY: McpMarketSource = {
  id: "official",
  label: "MCP Registry",
  url: "https://registry.modelcontextprotocol.io",
  builtin: true,
};

const FETCH_TIMEOUT_MS = 20_000;
const PAGE_SIZE = 30;

function readUserSources(): McpMarketSource[] {
  try {
    const raw = SettingRepo.get(MCP_MARKET_SOURCES_SETTING_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(list)) return [];
    return list
      .filter(
        (s): s is McpMarketSource =>
          !!s && typeof s.id === "string" && typeof s.url === "string" && typeof s.label === "string",
      )
      .map((s) => ({ id: s.id, label: s.label, url: s.url, builtin: false }));
  } catch {
    return [];
  }
}

export function listMcpMarketSources(): McpMarketSource[] {
  return [OFFICIAL_MCP_REGISTRY, ...readUserSources().filter((s) => s.id !== OFFICIAL_MCP_REGISTRY.id)];
}

/** `https://x/`, `https://x/v0.1/servers`, `https://x/v0` → `https://x`. */
export function normalizeRegistryBase(input: string): string | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  u.search = "";
  u.hash = "";
  const p = u.pathname.replace(/\/+$/, "").replace(/\/v0(?:\.\d+)?(?:\/servers)?$/i, "");
  return `${u.origin}${p}`;
}

function describeFetchError(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur instanceof Error; depth++) {
    if (cur.message && !parts.includes(cur.message)) parts.push(cur.message);
    cur = (cur as { cause?: unknown }).cause;
  }
  const msg = parts.join(" ← ") || String(err);
  return /aborted|timeout/i.test(msg) ? `连接超时(${FETCH_TIMEOUT_MS / 1000}s)` : msg;
}

async function getJson(url: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "Mcode" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: "follow",
  });
  if (!res.ok) return { status: res.status, body: null };
  return { status: res.status, body: (await res.json()) as unknown };
}

/** `/v0.1/servers` first; registries that predate the freeze only answer `/v0`. */
async function fetchServers(
  base: string,
  params: Record<string, string>,
): Promise<{ servers: unknown[]; nextCursor?: string }> {
  const qs = new URLSearchParams(params).toString();
  let r = await getJson(`${base}/v0.1/servers?${qs}`);
  if (r.status === 404) r = await getJson(`${base}/v0/servers?${qs}`);
  if (r.status !== 200 || !r.body || typeof r.body !== "object") {
    throw new Error(`注册中心返回 HTTP ${r.status}`);
  }
  const body = r.body as { servers?: unknown; metadata?: { nextCursor?: unknown; next_cursor?: unknown } };
  if (!Array.isArray(body.servers)) throw new Error("返回内容不是 MCP 注册中心格式(缺 servers)");
  const next = body.metadata?.nextCursor ?? body.metadata?.next_cursor;
  return { servers: body.servers, ...(typeof next === "string" && next ? { nextCursor: next } : {}) };
}

export async function addMcpMarketSource(input: {
  url: string;
  label?: string;
}): Promise<{ ok: boolean; error?: string; id?: string }> {
  const base = normalizeRegistryBase(input.url);
  if (!base) return { ok: false, error: "不是有效的 http(s) 地址" };
  const all = listMcpMarketSources();
  if (all.some((s) => s.url.toLowerCase() === base.toLowerCase())) return { ok: false, error: "这个注册中心已经在列表里了" };
  try {
    await fetchServers(base, { limit: "1" });
  } catch (err) {
    return { ok: false, error: `连不上或不是 MCP 注册中心:${describeFetchError(err)}` };
  }
  const host = new URL(base).hostname;
  let id = `custom-${host.replace(/[^A-Za-z0-9]+/g, "-")}`;
  let i = 2;
  while (all.some((s) => s.id === id)) id = `custom-${host.replace(/[^A-Za-z0-9]+/g, "-")}-${i++}`;
  const label = input.label?.trim() || host;
  const next = [...readUserSources(), { id, label, url: base, builtin: false }];
  SettingRepo.set(MCP_MARKET_SOURCES_SETTING_KEY, JSON.stringify(next.map(({ id: a, label: b, url: c }) => ({ id: a, label: b, url: c }))));
  return { ok: true, id };
}

export function removeMcpMarketSource(id: string): { ok: boolean; error?: string } {
  if (id === OFFICIAL_MCP_REGISTRY.id) return { ok: false, error: "内置注册中心不能移除" };
  const list = readUserSources();
  if (!list.some((s) => s.id === id)) return { ok: false, error: "注册中心不存在" };
  SettingRepo.set(
    MCP_MARKET_SOURCES_SETTING_KEY,
    JSON.stringify(list.filter((s) => s.id !== id).map(({ id: a, label: b, url: c }) => ({ id: a, label: b, url: c }))),
  );
  return { ok: true };
}

/* ── server.json → install options ── */

type Obj = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const objs = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter((x): x is Obj => !!x && typeof x === "object") : []);

/** Registry name → local server name (`io.github.x/my.server` → `my-server`). */
export function suggestMcpServerName(id: string): string {
  const last = id.split("/").pop() ?? id;
  let s = last.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  if (!s) s = "server";
  // `mcode-*` 是保留前缀(Claude 对 mcode-app 的工具自动放行)。
  if (/^mcode[-_]/i.test(s)) s = `x-${s}`;
  return s;
}

/** Arguments of a package → argv template + the inputs it needs. */
function convertArgs(list: unknown, prefix: string, inputs: McpMarketInput[]): McpMarketArg[] {
  const out: McpMarketArg[] = [];
  objs(list).forEach((a, i) => {
    const named = str(a.type) === "named";
    const flag = named ? str(a.name) : "";
    const value = str(a.value) || str(a.default);
    if (value) {
      if (flag) out.push({ value: flag });
      out.push({ value });
      return;
    }
    const required = a.isRequired === true;
    if (!required && !named) return;
    const key = `${prefix}${i}`;
    inputs.push({
      key,
      kind: "arg",
      name: flag,
      description: str(a.description) || str(a.valueHint) || undefined,
      required,
      secret: a.isSecret === true,
    });
    out.push(flag ? { input: key, flag } : { input: key });
  });
  return out;
}

function envInputs(list: unknown): McpMarketInput[] {
  return objs(list)
    .filter((e) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(str(e.name)))
    .map((e) => ({
      key: `env:${str(e.name)}`,
      kind: "env" as const,
      name: str(e.name),
      description: str(e.description) || undefined,
      required: e.isRequired === true,
      secret: e.isSecret === true,
      ...(str(e.default) || str(e.value) ? { default: str(e.default) || str(e.value) } : {}),
    }));
}

const RUNNERS: Record<string, { command: string; label: string }> = {
  npm: { command: "npx", label: "npx (npm)" },
  pypi: { command: "uvx", label: "uvx (PyPI)" },
  oci: { command: "docker", label: "docker (OCI)" },
  nuget: { command: "dnx", label: "dnx (NuGet)" },
};

function packageOption(pkg: Obj, index: number): McpMarketOption | null {
  const registryType = str(pkg.registryType ?? pkg.registry_type).toLowerCase();
  const runner = RUNNERS[registryType];
  const identifier = str(pkg.identifier ?? pkg.name);
  if (!runner || !identifier) return null;
  const transport = str((pkg.transport as Obj | undefined)?.type) || "stdio";
  if (transport !== "stdio") return null; // a local http server needs a URL we cannot know
  const version = str(pkg.version);
  const command = str(pkg.runtimeHint ?? pkg.runtime_hint) || runner.command;
  const inputs: McpMarketInput[] = envInputs(pkg.environmentVariables ?? pkg.environment_variables);
  const runtimeArgs = convertArgs(pkg.runtimeArguments ?? pkg.runtime_arguments, "rt", inputs);
  const packageArgs = convertArgs(pkg.packageArguments ?? pkg.package_arguments, "pk", inputs);
  const pinned = version && version !== "latest";
  const args: McpMarketArg[] = [];
  if (command === "docker") {
    args.push({ value: "run" }, { value: "-i" }, { value: "--rm" });
    for (const e of inputs.filter((x) => x.kind === "env")) args.push({ value: "-e" }, { value: e.name });
    args.push(...runtimeArgs);
    const tagged = /:[^/]+$/.test(identifier) || identifier.includes("@sha256:");
    args.push({ value: pinned && !tagged ? `${identifier}:${version}` : identifier });
  } else if (command === "uvx") {
    args.push(...runtimeArgs, { value: pinned ? `${identifier}==${version}` : identifier });
  } else if (command === "dnx") {
    args.push(...runtimeArgs, { value: pinned ? `${identifier}@${version}` : identifier }, { value: "--yes" });
  } else {
    // npx (or a runtimeHint we pass through): make sure it never prompts.
    if (command === "npx" && !runtimeArgs.some((a) => "value" in a && (a.value === "-y" || a.value === "--yes"))) {
      args.push({ value: "-y" });
    }
    args.push(...runtimeArgs, { value: pinned ? `${identifier}@${version}` : identifier });
  }
  args.push(...packageArgs);
  return { id: `pkg-${index}`, kind: "stdio", label: runner.label, command, args, inputs };
}

function remoteOption(remote: Obj, index: number): McpMarketOption | null {
  const type = str(remote.type).toLowerCase();
  const kind = type === "sse" ? "sse" : type === "streamable-http" || type === "http" ? "http" : null;
  const url = str(remote.url);
  if (!kind || !/^https?:\/\//i.test(url)) return null;
  const inputs: McpMarketInput[] = objs(remote.headers)
    .filter((h) => str(h.name))
    .map((h) => ({
      key: `header:${str(h.name)}`,
      kind: "header" as const,
      name: str(h.name),
      description: str(h.description) || undefined,
      required: h.isRequired === true,
      secret: h.isSecret === true,
      ...(str(h.value) || str(h.default) ? { default: str(h.value) || str(h.default) } : {}),
    }));
  return { id: `remote-${index}`, kind, label: kind === "sse" ? "SSE" : "HTTP", url, inputs };
}

export function registryServerToEntry(item: unknown): McpMarketEntry | null {
  if (!item || typeof item !== "object") return null;
  const wrapper = item as Obj;
  const server = (wrapper.server && typeof wrapper.server === "object" ? wrapper.server : wrapper) as Obj;
  const id = str(server.name);
  if (!id) return null;
  const meta = (wrapper._meta ?? server._meta) as Obj | undefined;
  const official = meta?.["io.modelcontextprotocol.registry/official"] as Obj | undefined;
  if (str(official?.status) === "deleted") return null;
  const options: McpMarketOption[] = [];
  objs(server.remotes).forEach((r, i) => {
    const o = remoteOption(r, i);
    if (o) options.push(o);
  });
  objs(server.packages).forEach((p, i) => {
    const o = packageOption(p, i);
    if (o) options.push(o);
  });
  const repo = server.repository as Obj | undefined;
  return {
    id,
    title: str(server.title) || id.split("/").pop() || id,
    description: str(server.description),
    version: str(server.version),
    ...(str(repo?.url) ? { repositoryUrl: str(repo?.url) } : {}),
    ...(str(server.websiteUrl) ? { websiteUrl: str(server.websiteUrl) } : {}),
    suggestedName: suggestMcpServerName(id),
    options,
  };
}

export async function searchMcpMarket(input: {
  source: string;
  query?: string;
  cursor?: string;
}): Promise<McpMarketSearchResult> {
  const source = listMcpMarketSources().find((s) => s.id === input.source);
  if (!source) return { ok: false, error: "注册中心不存在", entries: [] };
  const params: Record<string, string> = { limit: String(PAGE_SIZE), version: "latest" };
  if (input.query?.trim()) params.search = input.query.trim();
  if (input.cursor) params.cursor = input.cursor;
  try {
    const { servers, nextCursor } = await fetchServers(source.url, params);
    // Older registries ignore `version=latest` and list every version — keep the last seen.
    const byId = new Map<string, McpMarketEntry>();
    for (const item of servers) {
      const entry = registryServerToEntry(item);
      if (entry) byId.set(entry.id, entry);
    }
    return { ok: true, entries: [...byId.values()], ...(nextCursor ? { nextCursor } : {}) };
  } catch (err) {
    return { ok: false, error: describeFetchError(err), entries: [] };
  }
}
