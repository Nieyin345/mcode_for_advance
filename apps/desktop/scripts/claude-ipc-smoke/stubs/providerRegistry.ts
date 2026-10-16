/**
 * `@main/providers/registry.js` 的替身。
 *
 * 真的那一个在模块底部**注册三家引擎**,于是每个 SDK、每个的 MCP 工具表、以及
 * `workflows/seed.js` 那一坨 `?raw` 全在链上。本套只碰它两个地方:
 *
 * - `ipc/claude.ts` 的 `PROVIDER_LIST`(列引擎)—— 空数组是**诚实**的:这个无头
 *   环境里确实一个都没装;
 * - `lib/sessionFork.ts` 取引擎那一行(现为 `getRequired()`;MC-013 之前是
 *   `resolve()`,本桩仍为历史对照保留该成员)—— 只在源会话有 `claudeSessionId` 时
 *   才走到,本套的分叉夹具用它验"引擎不支持复制对话时该抛"。所以这里给一个**可编程**
 *   的桩:默认没有 `forkSession`(多数引擎都没有),要验成功路径时再挂一个。
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
   * 【MC-013】真注册表的 `resolve` **已删除**（全仓无调用端）。本桩保留它仅为历史
   * 对照;真方法不存在了,谁再"退回 resolve"会在编译期就断。
   *
   * ⚠️ 这里**不能**抛(原注释,保留):真的 `resolve` 是「按 id 找,找不到退回第一个
   * 注册的」——它从不抛(除非一个引擎都没注册)。而 `sessionFork.ts` 只要源会话有
   * `claudeSessionId` 就一定会走到取引擎那一行,无论引擎支不支持复制对话 ——
   * **"支不支持"正是靠返回来的这个 provider 上有没有 `forkSession` 判断的**。
   *
   * 这里踩过:最初写成"调到了说明夹具摆错了,直接抛",于是
   * 「引擎不支持复制对话时要抛」那条断言拿到的是本桩的报错文案(`resolve 不该被调到`),
   * 看起来像源码坏了,其实是桩把**被测的判断**整个短路掉了 —— resolve 一抛,
   * `if (!provider.forkSession)` 那一行永远执行不到。
   */
  resolve(id?: string): AgentProvider {
    return makeProvider(id ?? "claude-sdk");
  },
  /**
   * 【MC-056】`sessionFork` 现在用 `getRequired`。真注册表里它"取不到就抛" —— 但本套的
   * 分叉夹具验的是**引擎不支持复制对话**(挂在 provider 上没有 `forkSession` 那一支),
   * 而不是"引擎没注册"。所以这里照 `resolve` 一样返回一个 provider(带不带 `forkSession`
   * 由夹具决定),让那条判断仍然执行得到;真正的"未注册引擎必须拒绝"在 session-fork-smoke 验。
   */
  getRequired(id: string): AgentProvider {
    return makeProvider(id);
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

export async function probeProviderHealth() { return { installed: false, error: "isolated smoke: no provider" }; }
