/**
 * 桩:`@main/modules/service` —— 只给 `getModuleHost()`。
 *
 * 真模块经 `dataRoot()` → DB / electron 拉进整条链,而本套是**纯装配**测试(不碰磁盘、
 * 不起 Electron)。场景预检对扩展能力的用法只有一处:读目录、把 `module.*` 能力翻成
 * 预检声明。这里给一个最小目录形状,并允许测试**改写**它(证明"扩展能力真的进了清单"
 * 而不是永远为空)。
 */
import type { ModuleCatalog } from "@contracts/modules";

let catalog: Pick<ModuleCatalog, "capabilities"> = { capabilities: [] };

/** 测试用:替换目录内容(不模拟安装流程,只模拟"宿主目录里有这些能力")。 */
export function setStubModuleCatalog(next: { id: string; kind: "query" | "action" | "task" }[]): void {
  catalog = { capabilities: next };
}
export function resetStubModuleCatalog(): void {
  catalog = { capabilities: [] };
}

export async function getModuleHost(): Promise<{ catalog(): Pick<ModuleCatalog, "capabilities"> }> {
  return { catalog: () => catalog };
}
