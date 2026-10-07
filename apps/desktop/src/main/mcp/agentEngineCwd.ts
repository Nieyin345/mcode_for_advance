/**
 * 桌面三引擎的**会话 → 工作目录**登记表。
 *
 * `agentEngineBridge` 的 `specs()` 取法没有 session 参数,而 `agentMcpTools` 的 deps
 * 需要 `cwdFor` —— 于是 provider 在开跑前把本轮会话的 cwd 登在这里,`specs()` 现取时
 * 查得到哪个用哪个。
 *
 * ## 为什么单独一个模块,而不是留在桥里
 *
 *   1. **能独立验。** 桥的 import 图里有 `agentTools.ts` → `ssh2`(带原生模块
 *      `cpu-features`),无头套件**打不动这个包**;这张表零依赖,所以"删会话之后登记
 *      真的被摘掉"可以直接跑出来看,而不是只断言源码里有没有那一行。
 *   2. **释放路径得显式。** 从前桥里只有一个**从没人调**的 `unregisterAgentEngineSession`
 *      —— 三个 provider 每轮 `sendTurn` 都 `registerAgentEngineSession(sessionId, cwd)`,
 *      却**没有任何一处**删它。于是 `cwdBySession` 一条会话攒一条、删掉的会话也留着:
 *      单条很小(一个字符串键 + 一个路径),但"打开的会话越多越大"是无界的,长跑的应用
 *      会一直涨。这里在模块加载时就把自己挂进 `agentSessionCleanup` 的按会话释放链。
 *
 * 刻意零依赖(只依赖同样零依赖的 `agentSessionCleanup`):调用方在无头套件里也要能引它。
 */

import { registerAgentSessionDisposer } from "@main/mcp/agentSessionCleanup.js";

const cwdBySession = new Map<string, string>();

/** 登记/覆盖某会话的 cwd(provider 每轮 `sendTurn` 都会调,覆盖旧值即可)。 */
export function registerAgentEngineSession(sessionId: string, cwd: string): void {
  cwdBySession.set(sessionId, cwd);
}

/** 查某会话的 cwd。没登记过 → `null`(调用方据此拒绝相对路径并提示用绝对路径)。 */
export function agentEngineCwdFor(sessionId: string): string | null {
  return cwdBySession.get(sessionId) ?? null;
}

// 会话**真没了**的时候(`lib/rowDeletion.ts`:删会话 / 删项目)摘掉这一条。
registerAgentSessionDisposer((sessionId) => {
  cwdBySession.delete(sessionId);
});
