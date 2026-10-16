/**
 * 手机端**账号密码登录**(和扫码配对并列的第二种登录方式)。
 *
 * 扫码配对的验证码显示在电脑屏幕上 —— 人得在电脑旁边。用户要的是人不在电脑旁、
 * 直接打开公网地址(例如 Cloudflare 隧道域名)输入账号密码就能登录。登录成功后发的
 * 是和配对**完全一样**的设备令牌(`pairingManager.issueDevice`):进设备列表、能撤销,
 * 后续请求走同一道 Bearer 闸门,不另开权限。
 *
 * 安全要点:
 *  - 只存 scrypt 哈希 + 随机盐(`MOBILE_LOGIN_SETTING_KEY`),从不存明文;这个键不在
 *    手机可读写的白名单里,HTTP 桥还按共享的密钥键判据(`@main/lib/secretKeys`)把它挡在外面。
 *  - 比对恒定时间;账号不存在 / 未开启时也照样算一遍 scrypt,不让耗时泄露账号对不对。
 *  - 失败节流:按来源连续错 5 次起锁,30 秒起步、每多错一次翻倍、最多 15 分钟;
 *    另有全局闸 —— 一小时内总共错满 30 次就整体锁 15 分钟。
 *  - **来源默认取套接字地址**,`cf-connecting-ip` / `x-forwarded-for` 只在直连来源
 *    本身落在可信代理白名单(`mobile.login.trustedProxy`,默认空)时才采信 —— 直连者
 *    伪造转发头换不掉身份,不能靠轮换 key 绕过 per-client 锁。
 *  - 配额**原子预留**:`beginLoginAttempt` 在进 scrypt **之前**就把在途尝试算进来源
 *    预算与全局在途上限(见 `MAX_CONCURRENT_VERIFICATIONS`),堵住并发请求在锁检测
 *    与记录之间挤进去的窗口。
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { SettingRepo } from "@main/store/repositories.js";
import { MOBILE_LOGIN_SETTING_KEY, type MobileLoginStatus } from "@contracts/mobile";
import { log } from "@main/lib/logger.js";

interface StoredLogin {
  username: string;
  salt: string; // hex
  hash: string; // hex
  n: number;
  r: number;
  p: number;
}

const KEYLEN = 32;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

function scrypt(password: string, salt: Buffer, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password.normalize("NFKC"), salt, KEYLEN, { ...opts, maxmem: 64 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

function readStored(): StoredLogin | null {
  const raw = SettingRepo.get(MOBILE_LOGIN_SETTING_KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<StoredLogin>;
    if (
      typeof v.username !== "string" || !v.username ||
      typeof v.salt !== "string" || !/^[0-9a-f]{32,}$/.test(v.salt) ||
      typeof v.hash !== "string" || !/^[0-9a-f]{64}$/.test(v.hash)
    ) return null;
    const n = Number.isInteger(v.n) && (v.n as number) >= 1024 && (v.n as number) <= 1 << 20 ? (v.n as number) : SCRYPT_N;
    const r = Number.isInteger(v.r) && (v.r as number) >= 1 && (v.r as number) <= 32 ? (v.r as number) : SCRYPT_R;
    const p = Number.isInteger(v.p) && (v.p as number) >= 1 && (v.p as number) <= 16 ? (v.p as number) : SCRYPT_P;
    return { username: v.username, salt: v.salt, hash: v.hash, n, r, p };
  } catch {
    return null;
  }
}

/** 给电脑端界面 / 手机端登录页看的状态(不含哈希)。 */
export function getMobileLoginStatus(): MobileLoginStatus {
  const s = readStored();
  return s ? { enabled: true, username: s.username } : { enabled: false, username: "" };
}

export function isMobileLoginEnabled(): boolean {
  return readStored() !== null;
}

/** 设置 / 修改账号密码(调用方已用 `SetMobileLoginSchema` 校验过长度)。 */
export async function setMobileLogin(username: string, password: string): Promise<MobileLoginStatus> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  const stored: StoredLogin = {
    username: username.trim(),
    salt: salt.toString("hex"),
    hash: key.toString("hex"),
    n: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  };
  SettingRepo.set(MOBILE_LOGIN_SETTING_KEY, JSON.stringify(stored));
  resetLoginThrottle();
  log.info(`mobile: password login set (username=${stored.username})`);
  return { enabled: true, username: stored.username };
}

/** 关闭账号密码登录。已登录的设备不受影响(要踢就在设备列表里撤销)。 */
export function clearMobileLogin(): MobileLoginStatus {
  SettingRepo.set(MOBILE_LOGIN_SETTING_KEY, "");
  log.info("mobile: password login disabled");
  return { enabled: false, username: "" };
}

const DUMMY_SALT = randomBytes(16);

/** 校验账号密码。未开启 / 账号不对时也算一遍 scrypt,耗时不泄露信息。 */
export async function verifyMobileLogin(username: string, password: string): Promise<boolean> {
  const s = readStored();
  if (!s) {
    await scrypt(password, DUMMY_SALT, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
    return false;
  }
  const key = await scrypt(password, Buffer.from(s.salt, "hex"), { N: s.n, r: s.r, p: s.p });
  const expected = Buffer.from(s.hash, "hex");
  const passOk = key.length === expected.length && timingSafeEqual(key, expected);
  const a = Buffer.from(username.trim().normalize("NFKC"));
  const b = Buffer.from(s.username.normalize("NFKC"));
  const userOk = a.length === b.length && timingSafeEqual(a, b);
  return passOk && userOk;
}

/* ───────────────────────── 失败节流 ───────────────────────── */

const PER_CLIENT_FREE_FAILS = 5;
const BASE_LOCK_MS = 30_000;
const MAX_LOCK_MS = 15 * 60_000;
const GLOBAL_WINDOW_MS = 60 * 60_000;
const GLOBAL_MAX_FAILS = 30;
const GLOBAL_LOCK_MS = 15 * 60_000;
/** 同时在跑的 scrypt 校验上限。每个 scrypt 都要 CPU + 内存(N=16384 约 16 MiB),
 *  不设上限时一批并发请求能同时拉起几十个,把主进程拖住(合法用户也跟着卡)。
 *  超出的请求在**进 scrypt 之前**就被 429 挡掉 —— 见 {@link beginLoginAttempt}。 */
const MAX_CONCURRENT_VERIFICATIONS = 8;

/** 可信反向代理的来源地址白名单(逗号分隔的 IP)。**默认空 = 不信任任何代理头**,
 *  一律用套接字地址 —— 直连 LAN 的请求伪造 `cf-connecting-ip` / `x-forwarded-for`
 *  也换不掉自己的身份,按来源轮换 key 绕过锁这条就不成立了。只有当本机确实挂在
 *  一个可信反代(Cloudflare 隧道等)后面、其出口地址写进这里时,才采信转发头。
 *
 *  ⚠️ 形状应移入 `@contracts/mobile`(与其它 `mobile.*` 键并列);本 lane 不改 contracts,
 *  故在本地定义,键名固定为 `mobile.login.trustedProxy`,由设置导入/导出一并携带。 */
export const MOBILE_TRUSTED_PROXY_SETTING_KEY = "mobile.login.trustedProxy";

const EMPTY_TRUSTED = new Set<string>();

/** 读可信代理白名单。读不到 / 坏值一律当空(不信任任何代理头)。 */
function trustedProxies(): Set<string> {
  try {
    const raw = SettingRepo.get(MOBILE_TRUSTED_PROXY_SETTING_KEY);
    if (!raw) return EMPTY_TRUSTED;
    const set = new Set<string>();
    for (const part of raw.split(",")) {
      const ip = normalizeIp(part.trim());
      if (ip) set.add(ip);
    }
    return set;
  } catch {
    return EMPTY_TRUSTED;
  }
}

/** 归一套接字地址:去掉 IPv4-mapped IPv6 前缀(`::ffff:127.0.0.1` → `127.0.0.1`),
 *  好让白名单里的写法与 `remoteAddress` 对得上。 */
function normalizeIp(ip: string | undefined | null): string {
  if (!ip) return "";
  const trimmed = ip.trim();
  return trimmed.startsWith("::ffff:") ? trimmed.slice("::ffff:".length) : trimmed;
}

interface ClientState { fails: number; lockedUntil: number; lastAt: number; /** 在途校验数。 */ pending: number }
const clients = new Map<string, ClientState>();
let globalFails: number[] = [];
let globalLockedUntil = 0;
/** 全局在途 scrypt 校验数(预留了配额、还没出结果的)。 */
let globalPending = 0;

/** 测试 / 改密码后清空节流状态。 */
export function resetLoginThrottle(): void {
  clients.clear();
  globalFails = [];
  globalLockedUntil = 0;
  globalPending = 0;
}

/** 来源标识。**默认只用套接字地址**(转发头可伪造)。仅当直连来源本身在可信代理
 *  白名单里(`mobile.login.trustedProxy`)时,才采信 `cf-connecting-ip` /
 *  `x-forwarded-for` 首段 —— 那是本机确实挂在一个可信反代后面、且反代**就是**这个
 *  来源地址的场景。其余一律回套接字地址,伪造头换不掉身份。 */
export function loginClientKey(req: IncomingMessage): string {
  const socket = normalizeIp(req.socket.remoteAddress) || "unknown";
  if (trustedProxies().has(socket)) {
    const cf = req.headers["cf-connecting-ip"];
    if (typeof cf === "string" && cf.trim()) return cf.trim().slice(0, 64);
    const xff = req.headers["x-forwarded-for"];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
    if (first) return first.slice(0, 64);
  }
  return socket;
}

/** 还要锁多久(毫秒);0 = 可以试。 */
export function loginLockRemaining(clientKey: string, now = Date.now()): number {
  const g = globalLockedUntil > now ? globalLockedUntil - now : 0;
  const c = clients.get(clientKey);
  const l = c && c.lockedUntil > now ? c.lockedUntil - now : 0;
  return Math.max(g, l);
}

export interface LoginReservation {
  /** false = 现在不许验;调用方直接按 retryAfterMs 回 429,不要进 scrypt。 */
  allowed: boolean;
  retryAfterMs: number;
  reason?: "locked" | "quota" | "busy";
}

/** **原子**预留一次校验配额。必须在**进 scrypt 之前**同步调用 —— 这是修掉"并发窗口"
 *  的那一步:从前先查 `loginLockRemaining`、再 await 读体 + await scrypt,一批并发
 *  请求会在任何一次 scrypt 出结果前**全部**通过锁定检测。现在把"在途尝试"也算进
 *  来源的失败预算(以及全局在途上限),于是第 6 个并发请求当场被挡,而不是先跑完
 *  scrypt 再判。校验结束后**必须**调 {@link recordLoginResult} 释放这笔预留。 */
export function beginLoginAttempt(clientKey: string, now = Date.now()): LoginReservation {
  const locked = loginLockRemaining(clientKey, now);
  if (locked > 0) return { allowed: false, retryAfterMs: locked, reason: "locked" };
  const c = clients.get(clientKey);
  if (c && c.fails + c.pending >= PER_CLIENT_FREE_FAILS) {
    // 失败 + 在途 已达免费额度:再放进来的这一发多半又会失败并立即锁死,索性现在拒。
    return { allowed: false, retryAfterMs: BASE_LOCK_MS, reason: "quota" };
  }
  if (globalPending >= MAX_CONCURRENT_VERIFICATIONS) {
    return { allowed: false, retryAfterMs: 1000, reason: "busy" };
  }
  const state: ClientState = c ?? { fails: 0, lockedUntil: 0, lastAt: now, pending: 0 };
  state.pending += 1;
  state.lastAt = now;
  clients.set(clientKey, state);
  globalPending += 1;
  return { allowed: true, retryAfterMs: 0 };
}

export function recordLoginResult(clientKey: string, ok: boolean, now = Date.now()): void {
  // 先释放这笔预留(beginLoginAttempt 配对的另一半)。
  if (globalPending > 0) globalPending -= 1;
  const reserved = clients.get(clientKey);
  if (reserved && reserved.pending > 0) reserved.pending -= 1;

  if (ok) {
    clients.delete(clientKey);
    return;
  }
  const c = clients.get(clientKey) ?? { fails: 0, lockedUntil: 0, lastAt: now, pending: 0 };
  c.fails += 1;
  c.lastAt = now;
  if (c.fails >= PER_CLIENT_FREE_FAILS) {
    const lock = Math.min(MAX_LOCK_MS, BASE_LOCK_MS * 2 ** (c.fails - PER_CLIENT_FREE_FAILS));
    c.lockedUntil = now + lock;
  }
  clients.set(clientKey, c);

  globalFails = globalFails.filter((t) => now - t < GLOBAL_WINDOW_MS);
  globalFails.push(now);
  if (globalFails.length >= GLOBAL_MAX_FAILS) {
    globalLockedUntil = now + GLOBAL_LOCK_MS;
    globalFails = [];
    log.warn("mobile: too many failed password logins — all password logins locked for 15 min");
  }

  if (clients.size > 1000) {
    for (const [k, v] of clients) if (now - v.lastAt > GLOBAL_WINDOW_MS && v.lockedUntil <= now) clients.delete(k);
  }
}
