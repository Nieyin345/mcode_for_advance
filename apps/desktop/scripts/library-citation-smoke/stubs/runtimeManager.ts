/**
 * `@main/claude/RuntimeManager.js` 的替身 —— 真的那个会拉起 SDK 子进程,一路拖到
 * 三个引擎实现与 `workflows/seed.ts` 的二十几个 `?raw` 文件(esbuild 认不出那些后缀)。
 *
 * 本套一次都不该调它(不导入、不跑工作流)。所以这里是**显式报错**式的替身而不是
 * 空实现:真被走到了要立刻显形,而不是安静地返回 undefined 让断言去猜。
 */
function notHere(name: string): () => never {
  return () => {
    throw new Error(`本套不该走到 RuntimeManager.${name}`);
  };
}

export const runtimeManager = {
  emitExternal: notHere("emitExternal"),
  subscribe: notHere("subscribe"),
};
