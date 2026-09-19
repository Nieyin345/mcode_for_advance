/**
 * `@main/providers/registry.js` 的替身。
 *
 * 真的那一个在模块底部**注册三家引擎**,于是每个 SDK、每个的 MCP 工具表、以及
 * `workflows/seed.js` 那一坨 `?raw` 全在链上。本套只碰它两个地方:
 *
 * - `ipc/claude.ts` 的 `PROVIDER_LIST`(列引擎)—— 空数组是**诚实**的:这个无头
 *   环境里确实一个都没装;
 * - `lib/sessionFork.ts` 的 `resolve()` —— 只在源会话有 `claudeSessionId` 时才走到,
 *   本套的分叉夹具用它验"引擎不支持复制对话时该抛"。所以这里给一个**可编程**的桩:
 *   默认没有 `forkSession`(多数引擎都没有),要验成功路径时再挂一个。
 */
import type { AgentProvider } from "@contracts/provider";

/** 每个 provider id 是否支持 `forkSession`。默认一个都不支持。 */
const forks = new Map<string, (sessionId: string, opts: { cwd: string; title: string }) => Promise<string>>();

/** 记下每一次 `forkSession` 的实参,供断言看。 */
export const forkCalls: Array<{ providerId: string; sessionId: string; cwd: string; title: string }> = [];

export function setForkSupport(
  providerId: string,
  fn?: (sessionId: string, opts: { cwd: string; title: string }) => Promise<string>,
): void {
  if (fn) forks.set(providerId, fn);
  else forks.delete(providerId);
}

export function resetRegistryStub(): void {
  forks.clear();
  forkCalls.length = 0;
}

function makeProvider(id: string): AgentProvider {
  const fork = forks.get(id);
  return {
    id,
    displayName: id,
    capabilities: {} as AgentProvider["capabilities"],
    ...(fork
      ? {
          forkSession: async (sessionId: string, opts: { cwd: string; title: string }) => {
            forkCalls.push({ providerId: id, sessionId, cwd: opts.cwd, title: opts.title });
            return fork(sessionId, opts);
          },
        }
      : {}),
  } as unknown as AgentProvider;
}

export const providerRegistry = {
  /** 只有挂过 `forkSession` 的那些算"装了" —— 本套只用到它们。 */
  get(id: string): AgentProvider | undefined {
    return forks.has(id) ? makeProvider(id) : undefined;
  },
  list(): AgentProvider[] {
    // 无头环境里一个引擎都没装。诚实返回空表。
    return [];
  },
  /**
   * ⚠️ 这里**不能**抛。
   *
   * 真的 `resolve` 是「按 id 找,找不到退回第一个注册的」——它从不抛(除非一个引擎都没
   * 注册)。而 `sessionFork.ts:45` 只要源会话有 `claudeSessionId` 就一定会走到这一行,
   * 无论引擎支不支持复制对话 —— **"支不支持"正是靠返回来的这个 provider 上有没有
   * `forkSession` 判断的**。
   *
   * 这里踩过:最初写成"调到了说明夹具摆错了,直接抛",于是
   * 「引擎不支持复制对话时要抛」那条断言拿到的是本桩的报错文案(`resolve 不该被调到`),
   * 看起来像源码坏了,其实是桩把**被测的判断**整个短路掉了 —— resolve 一抛,
   * `if (!provider.forkSession)` 那一行永远执行不到。
   */
  resolve(id?: string): AgentProvider {
    return makeProvider(id ?? "claude-sdk");
  },
  get default(): AgentProvider {
    // `claude:healthCheck` 在没有默认引擎时走"没有 healthCheck 就报 installed:true"
    // 那条兜底。真的那边 `default` 会抛 —— 但那是在**装好之后**才可能发生的状态。
    throw new Error("claude-ipc-smoke:没有注册任何引擎");
  },
  register(_p: AgentProvider): void {
    /* 无头脚本里不注册引擎 */
  },
};
