/**
 * **手机伴侣自己的公网隧道**(「连接手机 → 自有域名」)。
 *
 * 和公网 MCP(设置 → 远程控制)是**两样东西**:那个是给 ChatGPT 的 MCP 服务,公网调用
 * 免审批;这个只是把手机网页(`127.0.0.1:<手机端口>`)挂到你的域名上,进门还得过配对码 /
 * 账号密码。以前手机域名寄生在 MCP 那条隧道上,不打开「开放远程控制」手机就连不上 ——
 * 现在拆开:配置单独存(`MOBILE_TUNNEL_*`),cloudflared 单独起一份
 * (`createTunnelManager("mobile-tunnel")`),彼此开关互不影响。
 *
 * 同一个 Tunnel Token 被 MCP 和手机各起一个 cloudflared 也没问题:Cloudflare 允许一条
 * 隧道有多个连接器,两者都在本机、ingress 一样,请求走哪个都到得了。
 *
 * 老用户迁移:第一次读到「手机这边从没配过」时,把原来存在 MCP 那边的手机域名(和
 * named 模式下的 token)抄一份过来,已经配好的环境不用重填。
 */
import {
  MOBILE_DEFAULT_PORT,
  MOBILE_TUNNEL_AUTOSTART_SETTING_KEY,
  MOBILE_TUNNEL_HOSTNAME_SETTING_KEY,
  MOBILE_TUNNEL_MODE_SETTING_KEY,
  MOBILE_TUNNEL_TOKEN_SETTING_KEY,
  type MobileTunnelMode,
  type MobileTunnelStatus,
  type SetMobileTunnelInput,
} from "@contracts/mobile";
import {
  PUBLIC_MCP_MOBILE_HOSTNAME_SETTING_KEY,
  PUBLIC_MCP_TUNNEL_MODE_SETTING_KEY,
  PUBLIC_MCP_TUNNEL_TOKEN_SETTING_KEY,
} from "@contracts/ipc/settings";
import { SettingRepo } from "@main/store/repositories.js";
import { awaitDb } from "@main/store/db.js";
import { encrypt, decrypt } from "@main/lib/secretStore.js";
import { log } from "@main/lib/logger.js";
import { createTunnelManager } from "@main/providers/bridge/tunnelManager.js";
import { getMobileServer } from "./MobileHttpServer.js";

const tunnel = createTunnelManager("mobile-tunnel");

function normalizeHost(raw: string): string {
  return raw.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
}

function mobilePort(): number {
  return getMobileServer()?.port || MOBILE_DEFAULT_PORT;
}

/** 老配置迁移:手机这边**从没存过**模式时,从 MCP 那边抄手机域名(+ named 的 token)。 */
function migrateFromPublicMcp(): void {
  if (SettingRepo.get(MOBILE_TUNNEL_MODE_SETTING_KEY) !== null) return;
  const host = normalizeHost(SettingRepo.get(PUBLIC_MCP_MOBILE_HOSTNAME_SETTING_KEY) ?? "");
  if (!host) {
    SettingRepo.set(MOBILE_TUNNEL_MODE_SETTING_KEY, "off");
    return;
  }
  const mcpMode = SettingRepo.get(PUBLIC_MCP_TUNNEL_MODE_SETTING_KEY)?.trim();
  const mcpToken = SettingRepo.get(PUBLIC_MCP_TUNNEL_TOKEN_SETTING_KEY) ?? "";
  SettingRepo.set(MOBILE_TUNNEL_HOSTNAME_SETTING_KEY, host);
  if (mcpMode === "named" && mcpToken) {
    // 密文原样抄过去(同一台机器同一把 safeStorage 钥匙,解得开)。
    SettingRepo.set(MOBILE_TUNNEL_TOKEN_SETTING_KEY, mcpToken);
    SettingRepo.set(MOBILE_TUNNEL_MODE_SETTING_KEY, "named");
  } else {
    SettingRepo.set(MOBILE_TUNNEL_MODE_SETTING_KEY, "external");
  }
  log.info(`mobile tunnel: migrated phone domain ${host} from the remote-control (MCP) settings`);
}

function readMode(): MobileTunnelMode {
  migrateFromPublicMcp();
  const raw = SettingRepo.get(MOBILE_TUNNEL_MODE_SETTING_KEY)?.trim();
  return raw === "named" || raw === "external" ? raw : "off";
}

function readHost(): string {
  return normalizeHost(SettingRepo.get(MOBILE_TUNNEL_HOSTNAME_SETTING_KEY) ?? "");
}

function readToken(): string {
  const raw = SettingRepo.get(MOBILE_TUNNEL_TOKEN_SETTING_KEY);
  if (!raw) return "";
  try {
    return decrypt(raw);
  } catch (err) {
    log.error(`mobile tunnel: token decrypt failed: ${(err as Error).message}`);
    return "";
  }
}

/* ───────────────────── external 模式:探测域名通不通 ───────────────────── */

interface Probe {
  key: string;
  at: number;
  inflight: boolean;
  phase: "starting" | "ready" | "failed";
  error: string | null;
  note: string | null;
}
let probe: Probe | null = null;
const PROBE_TTL_MS = 30_000;
const PROBE_TIMEOUT_MS = 10_000;

async function probeHealth(
  host: string,
  port: number,
): Promise<{ phase: "ready" | "failed"; error: string | null; note: string | null }> {
  try {
    const res = await fetch(`https://${host}/api/health`, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const body = await res.text().catch(() => "");
    const s = res.status;
    if (s === 200 && body.includes('"ok":true')) return { phase: "ready", error: null, note: null };
    if (s >= 300 && s < 400) {
      // 挂了 Cloudflare Access:手机会先过 Access 登录页,我们这边核对不了,但不算错。
      return { phase: "ready", error: null, note: "这个域名挂了 Cloudflare Access(登录页),无法自动核对隧道;手机上过了 Access 之后会看到 Mcode 登录页。" };
    }
    if (s === 403) return { phase: "failed", error: `https://${host} 被 Cloudflare 拦下了(HTTP 403)。检查 Bot Fight Mode / WAF 规则。`, note: null };
    if (s === 502 || s === 503 || s === 530 || /error code: 10(16|33)/i.test(body)) {
      return { phase: "failed", error: `Cloudflare 连不到你的隧道(HTTP ${s})。确认 cloudflared 在跑,且这个域名的 ingress 指向 http://127.0.0.1:${port}。`, note: null };
    }
    return { phase: "failed", error: `https://${host} 的应答不像 Mcode 手机服务(HTTP ${s})。确认 ingress 指向 http://127.0.0.1:${port}。`, note: null };
  } catch (err) {
    const msg = (err as Error).name === "TimeoutError" ? "超时" : (err as Error).message;
    return { phase: "failed", error: `连不上 https://${host}(${msg})。如果本机访问外网要走代理,这条探测可能误报 —— 以手机实际能否打开为准。`, note: null };
  }
}

function externalView(host: string, port: number): Pick<MobileTunnelStatus, "phase" | "error" | "note"> {
  const key = `${host}|${port}`;
  const stale = !probe || probe.key !== key || (!probe.inflight && Date.now() - probe.at > PROBE_TTL_MS);
  if (stale) {
    const keep = probe && probe.key === key ? probe : null;
    const next: Probe = {
      key,
      at: Date.now(),
      inflight: true,
      phase: keep?.phase ?? "starting",
      error: keep?.error ?? null,
      note: keep?.note ?? null,
    };
    probe = next;
    void probeHealth(host, port).then((r) => {
      if (probe !== next) return;
      next.phase = r.phase;
      next.error = r.error;
      next.note = r.note;
      next.at = Date.now();
      next.inflight = false;
    });
  }
  return { phase: probe!.phase, error: probe!.error, note: probe!.note };
}

/* ───────────────────────────── 对外 ───────────────────────────── */

export async function mobileTunnelStatus(): Promise<MobileTunnelStatus> {
  await awaitDb();
  const mode = readMode();
  const hostname = readHost();
  const token = readToken();
  const port = mobilePort();
  const base = {
    mode,
    hostname,
    tokenHint: token ? `****${token.slice(-4)}` : "",
    mobilePort: port,
    autostart: SettingRepo.get(MOBILE_TUNNEL_AUTOSTART_SETTING_KEY) === "1",
  };
  if (mode === "external" && hostname) return { ...base, ...externalView(hostname, port) };
  if (mode === "named") {
    const s = tunnel.status();
    return { ...base, phase: s.phase, error: s.error, note: null };
  }
  return { ...base, phase: "stopped", error: null, note: null };
}

/** 起 cloudflared(只有 named 模式需要)。 */
export async function startMobileTunnel(): Promise<MobileTunnelStatus> {
  await awaitDb();
  if (readMode() === "named") {
    SettingRepo.set(MOBILE_TUNNEL_AUTOSTART_SETTING_KEY, "1");
    tunnel.start(mobilePort(), false, { mode: "named", token: readToken(), hostname: readHost() });
  }
  return mobileTunnelStatus();
}

export async function stopMobileTunnel(): Promise<MobileTunnelStatus> {
  await awaitDb();
  SettingRepo.set(MOBILE_TUNNEL_AUTOSTART_SETTING_KEY, "0");
  tunnel.stop();
  return mobileTunnelStatus();
}

/** 存配置;隧道正在跑且配置变了就按新配置重起,切到非 named 就停掉。 */
export async function setMobileTunnelConfig(input: SetMobileTunnelInput): Promise<MobileTunnelStatus> {
  await awaitDb();
  const before = { mode: readMode(), host: readHost(), token: readToken() };
  SettingRepo.set(MOBILE_TUNNEL_MODE_SETTING_KEY, input.mode);
  SettingRepo.set(MOBILE_TUNNEL_HOSTNAME_SETTING_KEY, normalizeHost(input.hostname));
  const token = (input.token ?? "").trim();
  if (input.clearToken) SettingRepo.set(MOBILE_TUNNEL_TOKEN_SETTING_KEY, "");
  else if (token) SettingRepo.set(MOBILE_TUNNEL_TOKEN_SETTING_KEY, encrypt(token));
  probe = null;
  log.info(`mobile tunnel: config saved (mode=${input.mode}, host=${normalizeHost(input.hostname) || "-"})`);

  const phase = tunnel.status().phase;
  const active = phase === "starting" || phase === "ready" || phase === "reconnecting";
  const now = { mode: readMode(), host: readHost(), token: readToken() };
  if (now.mode !== "named") {
    if (active) tunnel.stop();
  } else if (active && (before.mode !== now.mode || before.host !== now.host || before.token !== now.token)) {
    tunnel.stop();
    tunnel.start(mobilePort(), false, { mode: "named", token: now.token, hostname: now.host });
  }
  return mobileTunnelStatus();
}

/** 应用启动时调:上次开着(autostart=1)且是 named,就自动拉起。 */
export async function autoStartMobileTunnel(): Promise<void> {
  await awaitDb();
  if (readMode() !== "named" || SettingRepo.get(MOBILE_TUNNEL_AUTOSTART_SETTING_KEY) !== "1") return;
  if (!readToken() || !readHost()) return;
  log.info("mobile tunnel: auto-starting (was on last time)");
  tunnel.start(mobilePort(), false, { mode: "named", token: readToken(), hostname: readHost() });
}

export function disposeMobileTunnel(): void {
  tunnel.dispose();
}
