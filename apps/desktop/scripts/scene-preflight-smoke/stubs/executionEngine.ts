/** 桩:执行器注册表 —— 只给 `kinds()`。不 import 真执行器(那些要 DB/electron)。 */
export const executionEngine = { kinds: () => ["prompt", "conversation"] } as never;
