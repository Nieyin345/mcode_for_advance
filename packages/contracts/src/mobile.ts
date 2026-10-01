/**
 * Mobile companion contracts — pairing, devices, and the RPC-over-HTTP shape.
 *
 * The mobile app is a web page served by the desktop's main process over LAN.
 * It pairs via a QR-code + 6-digit verification code, then calls a whitelisted
 * subset of the same operations the renderer uses (but transported over HTTP
 * + SSE instead of Electron IPC). This file defines the wire types shared by
 * the main-process server and the mobile bundle.
 *
 * The pairing protocol is intentionally transport-agnostic: the types below
 * describe a "direct LAN" handshake today, but nothing here assumes a socket
 * — a future relay/TURN transport can reuse the same request/response shape.
 */
import { z } from "zod";

/** Setting key under which the paired-device list (incl. tokens) is persisted.
 *  Value is a JSON-encoded {@link StoredPairedDevice}[] string. */
export const MOBILE_PAIRED_DEVICES_SETTING_KEY = "mobile.pairedDevices";

/** Setting key under which the mobile server port preference is persisted.
 *  Value is a decimal string. Empty/missing → use the default port. */
export const MOBILE_PORT_SETTING_KEY = "mobile.port";

/** Setting key for the master kill-switch. Value is "1" / "0". When "0" the
 *  mobile HTTP server is not started at all (no LAN listener). Default "1". */
export const MOBILE_ENABLED_SETTING_KEY = "mobile.enabled";

/** Default port the mobile HTTP server binds to. Overridable via settings. */
export const MOBILE_DEFAULT_PORT = 7331;

/** How long a pairing nonce stays valid after {@link PairingStartResult}. */
export const PAIRING_TTL_MS = 5 * 60 * 1000;

/** A paired device is considered "active" if it last made a request within this
 *  window (used to derive the live active-device count on the PC UI). */
export const MOBILE_ACTIVE_WINDOW_MS = 3 * 60 * 1000;

/** A device that has successfully paired with this desktop. The wire form
 *  (no token) — the token never leaves the main process except at issuance. */
export interface PairedDevice {
  deviceId: string;
  name: string;
  pairedAt: number;
  lastSeenAt: number;
}

/** Internal stored form: {@link PairedDevice} plus the secret token. Only ever
 *  held in the main process (settings table) — never sent over IPC or HTTP. */
export interface StoredPairedDevice extends PairedDevice {
  deviceToken: string;
}

/** Result of starting a pairing session on the PC. The QR payload is a full
 *  URL the phone opens directly after scanning. */
export interface PairingStartResult {
  /** Full URL encoded into the QR code: `http://<lan-ip>:<port>/?nonce=<nonce>`. */
  qrUrl: string;
  /** LAN endpoint base, e.g. `http://192.168.1.5:7331`. */
  endpoint: string;
  /** One-time pairing nonce (valid for {@link PAIRING_TTL_MS}). */
  nonce: string;
  /** 6-digit verification code the user types on the phone. Shown on the PC. */
  code: string;
  /** Unix ms when the nonce expires. */
  expiresAt: number;
  /** Which endpoint mode this pairing uses. Defaults to "lan" for backward
   *  compatibility. */
  mode?: "lan" | "remote";
}

/** Input the mobile sends back to complete pairing. */
export interface PairingVerifyInput {
  nonce: string;
  code: string;
  deviceName: string;
}

/** Successful pairing response. The token is stored by the mobile in
 *  localStorage and sent as `Authorization: Bearer <deviceToken>` thereafter. */
export interface PairingVerifyResult {
  deviceId: string;
  deviceToken: string;
  endpoint: string;
}

export const PairingVerifyInputSchema = z.object({
  nonce: z.string().min(1).max(64),
  code: z.string().regex(/^\d{4,8}$/),
  deviceName: z.string().min(1).max(64),
});

/* ───────────────────────── 账号密码登录 ───────────────────────── */

/**
 * **账号密码登录**的凭据(JSON:`{ username, salt, hash, n, r, p }`,scrypt)。
 *
 * 扫码配对要求人在电脑旁边(验证码显示在电脑上)。用户要的是**人不在电脑旁也能从
 * 公网地址登录** —— 于是加这一条:在电脑上设好账号密码,手机打开地址输入即可,成功后
 * 发一张和配对完全一样的设备令牌(进设备列表、可撤销)。
 *
 * ⚠️ 只存 scrypt 哈希,从不存明文;这个键不在手机可读写的白名单里
 * (`isMobileAccessibleSettingKey`),配过对的手机也读不到、改不了。未设置 = 不开放。
 */
export const MOBILE_LOGIN_SETTING_KEY = "mobile.passwordLogin";

/** 给电脑端界面看的状态 —— 只有账号名和开没开,哈希永不出主进程。 */
export interface MobileLoginStatus {
  enabled: boolean;
  username: string;
}

/** 手机端提交的登录请求。 */
export const MobileLoginInputSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
  deviceName: z.string().trim().max(64).optional(),
});
export type MobileLoginInput = z.infer<typeof MobileLoginInputSchema>;

/** 电脑端设置账号密码。密码至少 8 位 —— 它挡在公网地址前面。 */
export const SetMobileLoginSchema = z.object({
  username: z.string().trim().min(1).max(64).regex(/^\S+$/, "账号不能包含空格"),
  password: z.string().min(8, "密码至少 8 位").max(256),
});
export type SetMobileLoginInput = z.infer<typeof SetMobileLoginSchema>;

/** A single RPC call from mobile → main. `method` names mirror the IPC channel
 *  names (`RpcMap` keys) for the whitelisted subset; `input` is the method's
 *  zod-validated payload. */
export interface MobileRpcRequest {
  method: string;
  input: unknown;
}

export interface MobileRpcOk<T = unknown> {
  ok: true;
  result: T;
}

export interface MobileRpcError {
  ok: false;
  error: string;
  /** HTTP-ish code for the client to branch on (e.g. 401, 403, 404). */
  status: number;
}

export type MobileRpcResponse = MobileRpcOk | MobileRpcError;

/** SSE event frame pushed from main → mobile. Wraps a {@link RuntimeEvent} with
 *  the same envelope the renderer receives over IPC. */
export interface MobileSseEvent {
  sessionId: string;
  event: unknown;
}

/** A heartbeat comment frame, sent as `: ping\n\n`. Keeps the SSE connection
 *  alive through proxies and lets the client detect a dead link by timeout. */
export const SSE_HEARTBEAT_INTERVAL_MS = 15_000;
