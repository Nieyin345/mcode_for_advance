/**
 * `@main/lib/agentMail.js` 的替身 —— 真的那份把收件箱与限流窗口放在模块级 `Map` 里,
 * 从外面看不见。换掉才能断言"删会话/删项目时清掉了"。
 *
 * ⚠️ **其余导出原样转发真实现**(相对路径那份,不走 `@main/lib/agentMail.js` 这个别名
 * —— 否则就自己指自己了)。这样桩只覆盖要观察的那一个,别的行为仍是真的,不会因为
 * 桩跟真实现漂了而验错东西。
 */
export * from "../../../src/main/lib/agentMail.js";
import * as real from "../../../src/main/lib/agentMail.js";

/** 记下每一次 `dropAgentMail` 的实参。 */
export const mailDropped: string[] = [];

export function resetAgentMailStub(): void {
  mailDropped.length = 0;
}

/** 真的清(转调真实现),再记一笔 —— 断言既看"调过"、也不破坏桩后面的行为。 */
export function dropAgentMail(sessionId: string): void {
  mailDropped.push(sessionId);
  real.dropAgentMail(sessionId);
}
