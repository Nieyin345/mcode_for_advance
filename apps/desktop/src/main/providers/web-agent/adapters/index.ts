/**
 * 适配器注册表 —— 新增站点只需在这里多一行。
 *
 * **顺序即 UI 里模型列表的顺序**，第一项是默认（provider 的 builtinModels 就是
 * 照这个数组生成的，见 `WebAgentProvider`）。
 */
import type { SiteAdapter } from "./types.js";
import { deepseekAdapter } from "./deepseek.js";

const ADAPTERS: SiteAdapter[] = [deepseekAdapter];

/** 全部已注册站点。 */
export function listAdapters(): SiteAdapter[] {
  return ADAPTERS;
}

/** 按 id 取站点；未知 id 返回 undefined（调用方负责快速失败）。 */
export function adapterById(id: string): SiteAdapter | undefined {
  return ADAPTERS.find((a) => a.id === id);
}

/**
 * 默认站点。
 *
 * 表是模块级常量且恒非空，但**不写非空断言** —— 万一有人清空了 ADAPTERS，
 * 这里抛出的信息比一个 `undefined` 顺着类型断言流到下游好查得多。
 */
export function defaultAdapter(): SiteAdapter {
  const first = ADAPTERS[0];
  if (!first) throw new Error("web-agent: 未注册任何站点适配器");
  return first;
}

export type { SiteAdapter } from "./types.js";