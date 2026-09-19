/**
 * `@main/ipc/titleGen.js` 的替身。
 *
 * ## 为什么这一刀要切
 *
 * `sendTurn` 在首条消息上**火忘式**调一次 `generateSessionTitle`。真的那一份会走
 * `ipc/git.ts` → `CustomModelStore`(safeStorage 加密的密钥库) → `BridgeRegistry`
 * → 最后真起一个 `query()` 子进程。整条链压在 bundle 里,而无头环境一件都办不到。
 *
 * ⚠️ 而且它是**火忘**的(`void ... .catch(...)`),真跑起来会在套件退出之后继续动 —
 * 那种"跑完了才报错"最难查。换成桩之后这一条路是确定性的。
 *
 * ## 桩要能回答的那件事
 *
 * `ipc/claude.ts` 里有一处**顺序**上的判断,靠的就是这个函数被调到的**时机**:
 *
 *   ⚠️ 放在**分岔之前**:图型工作流那一轮同样要起标题(放在分岔之后时,图型会话
 *   永远拿不到生成的标题)。
 *
 * 所以桩只做一件事:把**每一次调用的会话 id** 按顺序记下来。本套据此断言
 * "图型会话也起了标题"。
 */
export const titleGenCalls: Array<{ sessionId: string; prompt: string }> = [];

export function resetTitleGen(): void {
  titleGenCalls.length = 0;
}

/** 永不 resolve —— 标题是火忘的,本套不关心它的结果,只关心它**被叫到了**。 */
export function generateSessionTitle(
  session: { id: string },
  prompt: string,
): Promise<void> {
  titleGenCalls.push({ sessionId: session.id, prompt });
  return new Promise<void>(() => {});
}
