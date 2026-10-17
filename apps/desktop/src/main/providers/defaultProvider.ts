/**
 * 【MC-013】「新会话默认引擎」的**唯一出口**。
 *
 * 权威事实是契约常量 `DEFAULT_PROVIDER_ID`(`@contracts/ipc/settings.ts`);本文件只是
 * 它的读取口 —— 存在的意义是让"默认引擎从哪来"在**每一个消费点**都有同一个名字,
 * 而不是十来处各自 import 常量、悄悄长出第二条读法。
 *
 * 刻意**不**回退到"注册表里第一家"或"当前可用的任一引擎":回退本身就是第二份事实。
 * 常量指向的引擎没注册(被卸载/构建裁剪)时,选择失败交给下游的
 * `providerRegistry.getRequired` 变成**可见的结构化失败**。
 *
 * ⚠️ 不要 import `providers/registry.js` —— 那会把三个 Provider 实现拖进只需要一个
 * 字符串常量的模块,而且 `sessionStart` → `RuntimeManager` → `registry` 的链上再
 * 反向拉 `sessionStart` 就是环。这里只依赖契约。
 */
import { DEFAULT_PROVIDER_ID } from "@contracts/ipc";

/** 新会话(以及没有显式给引擎的派生会话)默认使用的引擎 id。 */
export function defaultProviderId(): string {
  return DEFAULT_PROVIDER_ID;
}
