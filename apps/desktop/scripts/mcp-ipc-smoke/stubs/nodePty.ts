/**
 * `node-pty` 的替身 —— 只为无头脚本存在。
 *
 * ## 为什么必须换掉
 *
 * 真 `node-pty` 是原生插件:`require("node-pty")` 会去加载 `.node` 文件,而无头脚本
 * 跑的是 esbuild 打出来的临时 bundle,原生模块的查找路径、ABI、预编译产物全对不上。
 * 本套需要它只有**一个**理由 —— OAuth 那条路的 `loadNodePty()` 是个模块级 import,
 * 不换桩整个 bundle 就加载不起来(见 mcp-ipc-smoke 的 run.sh)。
 *
 * ## 它只提供"能 import 成功"这一件事
 *
 * `ipc/mcp.ts` 里 `spawn` 的调用点住在 `runCaptured()` 里,而 `runCaptured` 只由
 * MCP_AUTHORIZE / MCP_UNAUTHORIZE 两条通道调到 —— 本套对那两条只验**参数守卫**(见
 * main.ts 的文件头),守卫不通过就直接 return,`spawn` 永远走不到。
 *
 * 所以这里的 `spawn` 是**显式抛**而不是安静返回一个假 pty:真被调到了(守卫被人改松、
 * 或者有人在别处接了一条路)要立刻显形。让一条"永远绿的假断言"替它圆场,等于把这条
 * 通道从"验过"名单里划掉却装作还在。
 */
function notHere(name: string): () => never {
  return () => {
    throw new Error(`mcp-ipc-smoke 不该真的 spawn PTY(node-pty.${name})`);
  };
}

export function spawn(): never {
  return notHere("spawn")();
}

export const onData = notHere("onData");
export const onExit = notHere("onExit");
