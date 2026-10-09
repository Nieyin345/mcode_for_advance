/**
 * `@main/memory/assistantStore.js` 的替身 —— 真的那份把记忆助手的状态行写进设置表
 * (`memory.assistant.job|source|target.*`),断言"删会话时清掉了"要到表里翻。换掉这
 * 一个函数才能像 `agentMail` 那样**直接观察"调过没有"**,而不必复述那条收尾。
 *
 * ⚠️ **其余导出原样转发真实现**(相对路径那份,不走 `@main/memory/assistantStore.js`
 * 这个别名 —— 否则就自己指自己了)。桩只覆盖要观察的那一个,别的行为仍是真的。
 */
export * from "../../../src/main/memory/assistantStore.js";
import * as real from "../../../src/main/memory/assistantStore.js";

/** 记下每一次 `dropAssistantJobs` 的实参。 */
export const assistantDropped: string[] = [];

export function resetAssistantStoreStub(): void {
  assistantDropped.length = 0;
}

/** 真的清(转调真实现),再记一笔 —— 断言既看"调过"、也不破坏桩后面的行为。 */
export function dropAssistantJobs(sessionId: string): void {
  assistantDropped.push(sessionId);
  real.dropAssistantJobs(sessionId);
}
