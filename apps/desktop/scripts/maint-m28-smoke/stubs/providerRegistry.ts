/** 与 node-session-smoke 的桩同形,多两个钩子:让下一次引擎预检**挂起**或**失败**。 */
import type { AgentProvider } from "@contracts/provider";
export const providerRegistry = {
  get(_id: string): AgentProvider | undefined { return undefined; },
  list(): AgentProvider[] { return []; },
  resolve(_id?: string): AgentProvider { throw new Error("maint-m28-smoke:不该走到 providerRegistry.resolve"); },
  get default(): AgentProvider { throw new Error("maint-m28-smoke:没有注册任何引擎"); },
  register(_p: AgentProvider): void { /* 无头脚本里不注册引擎 */ },
};
let healthGate: Promise<void> | undefined;
let healthFailure: Error | undefined;
export let healthProbeCount = 0;
export function holdNextHealth(gate: Promise<void>): void { healthGate = gate; }
export function failNextHealth(error: Error): void { healthFailure = error; }
export async function probeProviderHealth(providerId: string) {
  healthProbeCount += 1;
  const gate = healthGate; healthGate = undefined; if (gate) await gate;
  const fail = healthFailure; healthFailure = undefined; if (fail) throw fail;
  return { providerId, ok: true, code: "ready", installed: true };
}
