/**
 * **插件携带的 hook → 宿主可投递的候选** —— MC-061 执行通道的「读声明」那一半。
 *
 * ## 它在补什么
 *
 * v1 解析并**展示**插件的 hooks,却**永不执行**(见 `@contracts/plugin` 的
 * `PluginHookSummary`)。授权原语(`@contracts/hostHookGrant` + `hostHookGrants.ts`)回答了
 * 「这条来源此刻准不准跑」,但**没有人拿它去驱动执行**。本模块把「一个启用插件声明了哪些
 * hook」翻成宿主 `HookRunner` 能匹配、能投递的形状,附上它的**来源身份** —— 于是
 * `HookRunner` 在每条事件上能对每一条候选做**唯一那一份判定**。
 *
 * ## 为什么读声明与判权分开
 *
 * 读声明会碰文件系统(装在第几版、hooks.json 长什么样),判定是纯的(授权表 → 三态)。
 * 分开之后:{@link pluginHookSpecsFrom} 是**纯函数**(给定声明 → 候选),它能被无头脚本
 * 直接喂各种声明;真正读盘的那一层只是把当前启用插件喂进去。两半各测各的,合起来才是
 * 「事件发生时,这条插件 hook 到底跑不跑」。
 *
 * ## 只收**可映射**的
 *
 * 原生事件名映射不到 Mcode 统一 `HookEvent` 的(如 Claude 的 `SessionStart`)在运行时
 * **永远不会匹配任何事件** —— 收进来只会占着一张永不触发的表。它们不进候选:契约那边
 * (`unmappable`)已经在面板上明确报过「映射不到、不投递」,运行时不重复报。
 */
import {
  mapClaudeHookEvent,
  type HookEvent,
  type HookSpec,
} from "@contracts/hook";
import type { HostHookSource } from "@contracts/hostHookGrant";
import { hostHookIdOf, hostHookSourceOf } from "./hostHookGrants.js";

/** 一个启用插件声明的、**可映射**的一条 hook —— 读盘那一半的产物。 */
export interface EnabledPluginHookDeclaration {
  pluginId: string;
  version: string | undefined;
  /** 原生事件名(如 `PreToolUse`)—— 判定按它绑定(见 `HostHookSource.nativeEvent`)。 */
  nativeEvent: string;
  matcher?: string;
  command: string;
}

/** 一条可投递的插件 hook:跑起来用的 `HookSpec` + 它绑定的**来源身份**(判定用)。 */
export interface PluginHookSpecEntry {
  spec: HookSpec;
  source: HostHookSource;
}

/**
 * **纯函数**:把插件声明的 hook 翻成宿主候选。命令/事件/插件/版本任一不同 → 不同 id
 * (见 {@link hostHookIdOf}),于是并发闸、交付计数、去重都按「这一条」收口,而同一条
 * 的每一次投递拿同一个 id。
 *
 * 映射不到统一事件的**丢掉**(见文件头)。`matcher` 原样带过 —— 它比的是工具名/路径,
 * 与用户手写的钩子同一套 glob 规则(`matchesHook`)。
 */
export function pluginHookSpecsFrom(
  declarations: readonly EnabledPluginHookDeclaration[],
): PluginHookSpecEntry[] {
  const out: PluginHookSpecEntry[] = [];
  for (const decl of declarations) {
    const event: HookEvent | null = mapClaudeHookEvent(decl.nativeEvent);
    if (event === null) continue; // 映射不到 —— 运行时不收(面板已报 unmappable)。
    const source = hostHookSourceOf({
      pluginId: decl.pluginId,
      version: decl.version,
      nativeEvent: decl.nativeEvent,
      command: decl.command,
      // 【MC-061 复审】matcher 纳入来源身份 —— 同命令同事件、不同 matcher 的两条 hook
      // 不再共享授权粒度。
      ...(decl.matcher !== undefined ? { matcher: decl.matcher } : {}),
    });
    // `name` 只给执行记录看(`HookSpec.name` 上限 60),id 才是身份。
    const name = `${decl.pluginId}:${decl.nativeEvent}`.slice(0, 60);
    const spec: HookSpec = {
      id: hostHookIdOf(source),
      name,
      event,
      command: decl.command,
      enabled: true,
      ...(decl.matcher !== undefined ? { matcher: decl.matcher } : {}),
    };
    out.push({ spec, source });
  }
  return out;
}
