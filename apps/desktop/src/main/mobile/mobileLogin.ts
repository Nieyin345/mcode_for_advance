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
 *    手机可读写的白名单里,HTTP 桥还把它列进 `LAN_UNREADABLE_SETTING_KEYS`。
 *  - 比对恒定时间;账号不存在 / 未开启时也照样算一遍 scrypt,不让耗时泄露账号对不对。
 *  - 失败节流:按来源(`cf-connecting-ip` → `x-forwarded-for` → 套接字地址)连续错 5 次
 *    起锁,30 秒起步、每多错一次翻倍、最多 15 分钟;另有全局闸 —— 一小时内总共错满
 *    30 次就整体锁 15 分钟(来源头可以伪造,全局闸兜底)。
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

interface ClientState { fails: number; lockedUntil: number; lastAt: number }
const clients = new Map<string, ClientState>();
let globalFails: number[] = [];
let globalLockedUntil = 0;

/** 测试 / 改密码后清空节流状态。 */
export function resetLoginThrottle(): void {
  clients.clear();
  globalFails = [];
  globalLockedUntil = 0;
}

/** 来源标识:经 Cloudflare 时取 `cf-connecting-ip`,其次 `x-forwarded-for` 首段,
 *  最后套接字地址。头可伪造 —— 所以还有全局闸。 */
export function loginClientKey(req: IncomingMessage): string {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf.trim()) return cf.trim().slice(0, 64);
  const xff = req.headers["x-forwarded-for"];
  const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
  if (first) return first.slice(0, 64);
  return req.socket.remoteAddress ?? "unknown";
}

/** 还要锁多久(毫秒);0 = 可以试。 */
export function loginLockRemaining(clientKey: string, now = Date.now()): number {
  const g = globalLockedUntil > now ? globalLockedUntil - now : 0;
  const c = clients.get(clientKey);
  const l = c && c.lockedUntil > now ? c.lockedUntil - now : 0;
  return Math.max(g, l);
}

export function recordLoginResult(clientKey: string, ok: boolean, now = Date.now()): void {
  if (ok) {
    clients.delete(clientKey);
    return;
  }
  const c = clients.get(clientKey) ?? { fails: 0, lockedUntil: 0, lastAt: now };
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
