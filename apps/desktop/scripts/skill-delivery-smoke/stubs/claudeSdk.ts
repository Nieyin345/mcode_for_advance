/**
 * `@anthropic-ai/claude-agent-sdk` 的替身 —— 只给 `skill-delivery-smoke` 用
 * (`--alias:` 认包名)。真那一份会 spawn claude 二进制、打上游。
 *
 * ## 它记的是**引擎真正收到的那份 options**
 *
 * `ClaudeAgentSdkProvider.startTurn` 最后调 `query({ prompt, options })`。本桩把那份
 * `options` 原样记进 `globalThis.__claudeDelivery`,于是「矩阵 / 项目技能 / 损坏回退
 * 之后,Claude 引擎**最终**拿到的 `options.skills` 是什么」变成可断言的**真实交付**,
 * 而不是靠读源码相信调用点接对了。
 *
 * 迭代器立刻 `{done:true}`(空回合),让 `startTurn` 的 `for await` 正常收尾、`done`
 * resolve —— 本套件不验回合内容,只验交给 SDK 的入参。
 *
 * `createSdkMcpServer` / `tool` / `forkSession` / `deleteSession` 是 provider import
 * 图里会用到的另外几个具名导出,给最小形状(本套件不驱动它们的语义)。
 */
interface ClaudeDelivery {
  /** 最近一次 query() 收到的 options.skills(原始值:"all" 或字符串数组)。 */
  skills: unknown;
  /** 最近一次 query() 收到的完整 options。 */
  options: Record<string, unknown> | null;
  /** query() 被调用了几次。 */
  calls: number;
}

function delivery(): ClaudeDelivery {
  const g = globalThis as unknown as { __claudeDelivery?: ClaudeDelivery };
  if (!g.__claudeDelivery) {
    g.__claudeDelivery = { skills: undefined, options: null, calls: 0 };
  }
  return g.__claudeDelivery;
}

export async function* query(args: { options?: Record<string, unknown> }): AsyncGenerator<unknown> {
  const d = delivery();
  d.calls += 1;
  d.options = args.options ?? null;
  d.skills = args.options?.["skills"];
  // 空回合:没有任何消息,迭代立即结束 —— startTurn 的 for-await 正常收尾。
  return;
}

export function createSdkMcpServer(opts: { name: string; version?: string; tools?: unknown[] }) {
  return { type: "sdk", name: opts.name, version: opts.version, instance: {} };
}

export function tool(name: string) {
  return { name };
}

export function forkSession() {
  return Promise.resolve({ sessionId: "fake-fork" });
}

export function deleteSession() {
  return Promise.resolve();
}

export type Options = Record<string, unknown>;

delivery();
