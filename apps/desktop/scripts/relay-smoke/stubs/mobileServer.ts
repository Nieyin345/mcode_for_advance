/**
 * `@main/mobile/MobileHttpServer.js` 的替身 —— 只给中继这套 smoke 用。
 *
 * ## 为什么要换它
 *
 * 真那个的 `startMobileServer()` 是 `listen(port, "0.0.0.0")` —— **直接调它等于把跑
 * 测试的这台机器挂到局域网上**(同 mobile-pairing-smoke 文件头里那条)。中继本身
 * 只会通过两个口子碰它:
 *
 *   - `isMobileServerRunning()` —— `connect()` 开头那道闸;
 *   - `getMobileServer().port` —— `pipeToLocal()` 拿本机端口做 socket 转发。
 *
 * 所以替身只提供这两件事,外加一个**真的**绑在 `127.0.0.1`(回环 + 随机端口)上的
 * HTTP 服务当哨兵:中继的 `tcp connection` → `pipeToLocal` 那段是**真**跑通的,
 * 走的是真 socket,只是端口落在回环上。
 *
 * ## 三个测试钩子(`__` 前缀)
 *
 * `tsc` 看的是**真模块**(它没有这些成员),所以脚本那边必须走
 * "动态 import + 断言成自定义类型"那一层 —— 见 main.ts 里 `__mobileUp` 那几行。
 * 这是仓库里已有的做法(`mobile-pairing-smoke` 拿 `RuntimeManager.__setRunning`)。
 */

import { createServer, type Server } from "node:http";

/** 回环哨兵服务发回的那串字。中继那条数据通路真跑通时,phone 会收到它。 */
export const LOCAL_SENTINEL = "RELAY_LOCAL_SENTINEL";

let server: Server | null = null;
let port = 0;
let hits = 0;

/** 启一个真的 HTTP 服务(回环,随机端口),当成"本机移动端服务"。 */
export async function __up(): Promise<number> {
  if (server) return port;
  server = createServer((_req, res) => {
    hits += 1;
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(LOCAL_SENTINEL);
  });
  await new Promise<void>((resolve, reject) => {
    server!.on("error", reject);
    server!.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("替身服务拿不到端口");
  port = addr.port;
  return port;
}

/** 关掉它,回到"移动端服务没在跑"那种状态。 */
export async function __down(): Promise<void> {
  if (!server) return;
  const s = server;
  server = null;
  port = 0;
  await new Promise<void>((resolve) => s.close(() => resolve()));
}

/** 这个替身服务被真的连到过几次(用来核对数据通路不是空跑)。 */
export function __hits(): number {
  return hits;
}

/** 与真实现同形:没有起服务时返回一个 `running:false` 的句柄。 */
export function isMobileServerRunning(): boolean {
  return !!server;
}

export function getMobileServer(): { running: boolean; port: number; endpoint: string; stop: () => void } {
  if (!server) return { running: false, port: 0, endpoint: "", stop: () => {} };
  return {
    running: true,
    port,
    endpoint: `http://127.0.0.1:${port}`,
    stop: () => {},
  };
}
