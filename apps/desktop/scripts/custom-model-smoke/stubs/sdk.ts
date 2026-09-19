/**
 * `@anthropic-ai/claude-agent-sdk` 的替身 —— 只给无头脚本用（`run.sh` 的 `--alias`）。
 *
 * ## 为什么换得掉
 *
 * 被测代码里那句是 `await import("@anthropic-ai/claude-agent-sdk")` —— 包名，
 * `--alias:` 认的就是包名（相对 import 才换不掉，见技能文档里那条警告）。
 *
 * ## 为什么必须换掉
 *
 * 真那一份会去 `require.resolve` 那个平台子包、**真的 spawn 一个 claude 二进制**。
 * 这就把两件与被测代码无关的东西变成了这条测试的红：
 *   1. 二进制会读**用户级**配置和登录态（`customModel.ts` 只把 `CLAUDE_CONFIG_DIR`
 *      指到隔离目录，别的路径还在用户根里），于是这一套可能拿用户本机的凭据去打
 *      **真上游** —— 既花钱，结果也取决于网络和额度；
 *   2. 它跑起来要好几秒，而"探测失败"那条路要等满 30s 超时。
 *
 * ## 它替"记住真相"，而不是替"返回什么"
 *
 * 桩把**真实收到的 options** 写进 `MCODE_SMOKE_PROBE_LOG`，于是"探测和真实回合走同
 * 一条链（同一个模型串、同一套 settingSources、真的传了 abortController）"这件事是
 * 可断言的，而不是靠读注释相信。被测代码改坏了这些，断言会红。
 *
 * 消息序列（吐什么）由 `MCODE_SMOKE_PROBE_MESSAGES` 控制，`MCODE_SMOKE_PROBE_THROW`
 * 则让它直接抛 —— 后者模拟的是连不上 / 认证被拒 / 到点 abort 那三种**真的会抛**的形状。
 */
import { appendFileSync } from "node:fs";

interface ProbeOptions {
  abortController?: unknown;
  model?: unknown;
  env?: Record<string, string | undefined>;
  settingSources?: unknown;
  pathToClaudeCodeExecutable?: unknown;
  includePartialMessages?: unknown;
  maxTurns?: unknown;
}

/** 实测出来的**正常**端点形状：信号接口从 v2.1.x 起在 init 之前就真的打上游，
 *  所以顺序是 `assistant… → system/init → assistant… → result`，不是
 *  init 打头。（这正是被测代码那条红色断言要钉的东西。） */
const DEFAULT_SEQUENCE: unknown[] = [
  { type: "assistant", message: { content: [] } },
  { type: "system", subtype: "init", claude_code_version: "9.9.9-smoke" },
  { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } },
  { type: "result", subtype: "success", is_error: false, result: "hello" },
];

async function* fromArray(items: unknown[]): AsyncGenerator<unknown> {
  for (const item of items) yield item;
}

export function query(args: { prompt: string; options: ProbeOptions }): AsyncIterable<unknown> {
  const { options } = args;
  const env = options.env ?? {};

  // 把真相记下来（不在场时静默跳过：这套脚本只在一个进程里跑）。
  const logPath = process.env.MCODE_SMOKE_PROBE_LOG;
  if (logPath) {
    appendFileSync(
      logPath,
      JSON.stringify({
        model: options.model ?? null,
        baseUrl: env.ANTHROPIC_BASE_URL ?? null,
        authToken: env.ANTHROPIC_AUTH_TOKEN ?? null,
        apiKey: env.ANTHROPIC_API_KEY ?? null,
        configDir: env.CLAUDE_CONFIG_DIR ?? null,
        settingsFile: env.CLAUDE_CODE_SETTINGS_FILE ?? null,
        customHeaders: env.ANTHROPIC_CUSTOM_HEADERS ?? null,
        settingSources: options.settingSources ?? null,
        pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable ?? null,
        abortControllerIsAbortController:
          typeof AbortController !== "undefined" && options.abortController instanceof AbortController,
        maxTurns: options.maxTurns ?? null,
      }) + "\n",
    );
  }

  const throwMsg = process.env.MCODE_SMOKE_PROBE_THROW;
  if (throwMsg) {
    return (async function* () {
      throw new Error(throwMsg);
    })();
  }

  const raw = process.env.MCODE_SMOKE_PROBE_MESSAGES;
  const items: unknown[] = raw ? (JSON.parse(raw) as unknown[]) : DEFAULT_SEQUENCE;
  return fromArray(items);
}
