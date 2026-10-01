/**
 * Mobile companion IPC handlers (PC renderer → main).
 *
 * These drive the PC-side "connect phone" dialog: start/cancel a pairing,
 * list/revoke paired devices, and read server status. The actual LAN HTTP
 * server + pairing handshake lives in `main/mobile/*` — this module only
 * exposes it to the renderer over IPC (the same DB-guarded wrapper as every
 * other domain).
 */
import type { IpcMain } from "electron";
import { z } from "zod";
import { IPC, RevokeMobileDeviceSchema } from "@contracts/ipc";
import { pairingManager, detectLanIp, detectLanIps } from "@main/mobile/PairingManager.js";
import { getMobileServer } from "@main/mobile/MobileHttpServer.js";
import { MOBILE_ACTIVE_WINDOW_MS, SetMobileLoginSchema, SetMobileTunnelSchema } from "@contracts/mobile";
import {
  mobileTunnelStatus,
  setMobileTunnelConfig,
  startMobileTunnel,
  stopMobileTunnel,
} from "@main/mobile/mobileTunnel.js";
import { clearMobileLogin, getMobileLoginStatus, setMobileLogin } from "@main/mobile/mobileLogin.js";
import { log } from "@main/lib/logger.js";

/** Renderer input for `mobile:startPairing` (shape mirrors RpcMap). Validated
 *  like every other channel: `host` is spliced into the LAN endpoint that ends
 *  up in the QR code, so it must be a bare host/IP — no scheme, path or `@`. */
const StartPairingSchema = z
  .object({
    host: z.string().trim().min(1).max(253).regex(/^[A-Za-z0-9.\-:[\]]+$/)
      .transform((host, ctx) => {
        // URL handles hostname/IP syntax; bracket a bare IPv6 address first.
        // Appending our port also rejects an injected second port in `host`.
        const authority = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
        try { return new URL(`http://${authority}:7331`).hostname; }
        catch {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid bare host or IP" });
          return z.NEVER;
        }
      }).optional(),
    mode: z.enum(["lan", "remote"]).optional(),
    endpoint: z.string().trim().min(1).max(2048).refine((value) => {
      try {
        const url = new URL(value);
        return (url.protocol === "http:" || url.protocol === "https:") &&
          !url.username && !url.password && !value.includes("?") && !value.includes("#");
      } catch { return false; }
    }, "endpoint must be an HTTP(S) URL without credentials, query or fragment")
      .transform((value) => new URL(value).href.replace(/\/+$/, "")).optional(),
    force: z.boolean().optional(),
  })
  .superRefine((input, ctx) => {
    if (input.mode === "remote" && !input.endpoint) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["endpoint"], message: "remote pairing requires an endpoint" });
    }
  })
  .optional();

export function registerMobileHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.MOBILE_START_PAIRING, async (_evt, raw) => {
    const server = getMobileServer();
    const input = StartPairingSchema.parse(raw ?? undefined) ?? {};
    const force = { force: input.force === true };

    // Remote mode (SSH relay): the endpoint is the VPS's public URL.
    if (input.mode === "remote" && input.endpoint) {
      const pairing = pairingManager.startPairing(input.endpoint, force);
      return { pairing: { ...pairing, mode: "remote" as const } };
    }

    // LAN mode (default): endpoint is the local HTTP server.
    const lanIp = input.host || detectLanIp();
    const endpoint = `http://${lanIp ?? "localhost"}:${server.port || 7331}`;
    const pairing = pairingManager.startPairing(endpoint, force);
    return { pairing: { ...pairing, mode: "lan" as const } };
  });

  ipcMain.handle(IPC.MOBILE_CANCEL_PAIRING, async () => {
    pairingManager.cancelPairing();
    return { ok: true as const };
  });

  ipcMain.handle(IPC.MOBILE_LIST_DEVICES, async () => {
    const devices = await pairingManager.listDevices();
    return { devices };
  });

  ipcMain.handle(IPC.MOBILE_REVOKE_DEVICE, async (_evt, raw) => {
    const input = RevokeMobileDeviceSchema.parse(raw);
    await pairingManager.revokeDevice(input.deviceId);
    return { ok: true as const };
  });

  ipcMain.handle(IPC.MOBILE_GET_STATUS, async () => {
    const server = getMobileServer();
    return {
      running: server.running,
      port: server.port,
      endpoint: server.endpoint,
      lanIp: detectLanIp(),
      lanIps: detectLanIps(),
    };
  });

  ipcMain.handle(IPC.MOBILE_GET_ACTIVE_COUNT, async () => {
    const devices = await pairingManager.listDevices();
    const cutoff = Date.now() - MOBILE_ACTIVE_WINDOW_MS;
    const count = devices.filter((d) => d.lastSeenAt >= cutoff).length;
    return { count };
  });

  // 账号密码登录:只回账号名 + 开没开,哈希永不出主进程。
  ipcMain.handle(IPC.MOBILE_GET_LOGIN, async () => getMobileLoginStatus());

  ipcMain.handle(IPC.MOBILE_SET_LOGIN, async (_e, raw: unknown) => {
    const input = SetMobileLoginSchema.parse(raw);
    return setMobileLogin(input.username, input.password);
  });

  ipcMain.handle(IPC.MOBILE_CLEAR_LOGIN, async () => clearMobileLogin());

  // 手机自有域名的隧道 —— 和「远程控制」(公网 MCP)无关,单独一份。
  ipcMain.handle(IPC.MOBILE_GET_TUNNEL, async () => mobileTunnelStatus());
  ipcMain.handle(IPC.MOBILE_SET_TUNNEL, async (_e, raw: unknown) =>
    setMobileTunnelConfig(SetMobileTunnelSchema.parse(raw)));
  ipcMain.handle(IPC.MOBILE_START_TUNNEL, async () => startMobileTunnel());
  ipcMain.handle(IPC.MOBILE_STOP_TUNNEL, async () => stopMobileTunnel());

  log.info("mobile: IPC handlers registered");
}
