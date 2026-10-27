/**
 * 【EXT-03】**MCP 服务器「测试连接」** —— 真的起一次，报告能不能连上。
 *
 * ## 为什么必须真的起一次
 *
 * 用户填了命令 / URL，界面上显示"已保存"。但那三种失败在"保存成功"里完全看不出来：
 *
 *   1. **命令不存在** —— 保存只写配置，不执行；
 *   2. **起不来** —— 命令在但立即退出（缺依赖、缺 token、crash）；
 *   3. **连上了但没授权** —— 远端 401。
 *
 * 规格要求「命令不存在、起不来时要告诉用户」，那就只能在真的跑一次之后才知道。
 *
 * ## 为什么不用 MCP SDK
 *
 * 仓库里没有这个依赖，而这个功能只需要**握手**（`initialize`）—— 引入一整个 SDK
 * 只为一句话的 JSON-RPC 不值。所以这里手写最小协议：
 *
 *   `{ "jsonrpc":"2.0", "id":1, "method":"initialize", "params":{...} }`
 *
 * stdio 服务器在 stdout 回一行 JSON。读到 `result` = 连上了；进程退出 / 超时 /
 * stderr 有内容 = 没连上，各自给不同的原因。
 *
 * ## 它不做什么
 *
 * - **不落盘**：测试连接不改任何配置；
 * - **不留进程**：测完一定 kill（包括超时路径）；
 * - **不替代运行**：真跑的时候由引擎自己起服务器，这里是独立的一次探针。
 */
import { spawn } from "node:child_process";
import type { McpTestConnectionResult } from "@contracts/ipc";

/** 一次测试的总时限。超过它按"没起来"算 —— 有些服务器会一直等 stdin。 */
const TEST_TIMEOUT_MS = 15_000;

export interface McpTestTarget {
  kind: "stdio" | "http" | "sse";
  /** stdio：可执行文件。 */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** http/sse：地址。 */
  url?: string;
  headers?: Record<string, string>;
}

/** stdio 服务器：起进程、发 initialize、等一行响应。 */
async function testStdio(target: McpTestTarget): Promise<McpTestConnectionResult> {
  const command = target.command?.trim();
  if (!command) return { ok: false, error: "没有填命令", stage: "spawn" };
  const startedAt = Date.now();

  return await new Promise<McpTestConnectionResult>((resolve) => {
    let settled = false;
    const finish = (result: McpTestConnectionResult): void => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* 已经退出 */ }
      resolve(result);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, target.args ?? [], {
        // 合并 stderr 到独立管道（不合并进 stdout —— 那是协议通道）。
        stdio: ["pipe", "pipe", "pipe"],
        // **不用 shell**：shell 会把"命令不存在"变成 exit 127 + 一段 stderr 文本，
        // 而我们想区分"根本没这个可执行文件"与"文件在但跑不起来"。
        shell: false,
        env: { ...process.env, ...(target.env ?? {}) },
        windowsHide: true,
      });
    } catch (err) {
      // ENOENT 会走 'error' 事件；同步抛只在参数非法时发生。
      resolve({
        ok: false,
        error: `起不来：${err instanceof Error ? err.message : String(err)}`,
        stage: "spawn",
      });
      return;
    }

    const stderrChunks: string[] = [];
    child.stderr?.on("data", (chunk: Buffer) => {
      // 只留最后 2 KB —— 服务器可能刷很多日志，全留没意义。
      stderrChunks.push(chunk.toString("utf8"));
      while (stderrChunks.join("").length > 2048) stderrChunks.shift();
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      // ENOENT 就是"命令不存在" —— 这正是规格点名要说清楚的那一种。
      const detail = err.code === "ENOENT"
        ? `找不到命令「${command}」—— 检查它是否已安装、是否在 PATH 里`
        : `起不来：${err.message}`;
      finish({ ok: false, error: detail, stage: "spawn" });
    });

    child.on("exit", (code) => {
      // 还没握手就退出了。把 stderr 尾巴带上 —— 那是用户唯一能拿到的线索。
      const tail = stderrChunks.join("").trim().split("\n").slice(-3).join("\n");
      finish({
        ok: false,
        error: `进程在握手前退出（code ${code ?? "null"}）${tail ? `：\n${tail}` : ""}`,
        stage: "connect",
      });
    });

    // 逐行读 stdout；第一行合法 JSON 且有 result（或 error）就定案。
    let buffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (line === "") continue;
        let parsed: { result?: { serverInfo?: { name?: string; version?: string } }; error?: { message?: string } };
        try {
          parsed = JSON.parse(line) as typeof parsed;
        } catch {
          // 不是 JSON —— 有些服务器会先打 banner。忽略，继续等。
          continue;
        }
        if (parsed.error) {
          finish({
            ok: false,
            error: parsed.error.message ?? "服务端在 initialize 时返回错误",
            stage: "initialize",
          });
          return;
        }
        if (parsed.result !== undefined) {
          finish({
            ok: true,
            ms: Date.now() - startedAt,
            ...(parsed.result.serverInfo?.name !== undefined
              ? { serverName: parsed.result.serverInfo.name } : {}),
            ...(parsed.result.serverInfo?.version !== undefined
              ? { serverVersion: parsed.result.serverInfo.version } : {}),
          });
          return;
        }
      }
    });

    // 发 initialize。协议版本给一个宽范围（服务器自己回它支持的）。
    try {
      child.stdin?.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "mcode-test-connection", version: "1" },
        },
      })}\n`);
    } catch (err) {
      finish({
        ok: false,
        error: `握手请求发不出去：${err instanceof Error ? err.message : String(err)}`,
        stage: "connect",
      });
    }

    setTimeout(() => {
      const tail = stderrChunks.join("").trim().split("\n").slice(-3).join("\n");
      finish({
        ok: false,
        error: `${TEST_TIMEOUT_MS / 1000} 秒内没有完成握手${tail ? `：\n${tail}` : ""}`,
        stage: "connect",
      });
    }, TEST_TIMEOUT_MS).unref?.();
  });
}

/** 远端服务器：探一次 URL，401/403 归到 auth。 */
async function testRemote(target: McpTestTarget): Promise<McpTestConnectionResult> {
  const url = target.url?.trim();
  if (!url) return { ok: false, error: "没有填地址", stage: "connect" };
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      method: "OPTIONS",
      headers: target.headers ?? {},
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        error: `服务端要求授权（HTTP ${response.status}）—— 先在列表里点「登录」`,
        stage: "auth",
      };
    }
    /* **不按 2xx 判成功**：MCP 的 HTTP 端点是按 POST 握手的，对 OPTIONS 回 405/404
     * 很正常。能拿到任何 HTTP 响应就说明"地址活着、网络通"，这已经是这条探针
     * 能给出的全部事实；真正的握手要等引擎起服务器时做。 */
    return { ok: true, ms: Date.now() - startedAt };
  } catch (err) {
    return {
      ok: false,
      error: `连不上：${err instanceof Error ? err.message : String(err)}`,
      stage: "connect",
    };
  }
}

/** 测试一个服务器能不能连上。 */
export async function testMcpConnection(target: McpTestTarget): Promise<McpTestConnectionResult> {
  if (target.kind === "stdio") return await testStdio(target);
  return await testRemote(target);
}
