/**
 * O3 —— 最小 CDP 客户端（连接**已在运行**的 Electron 页面）。
 *
 * ## 为什么不复用 `electron-u1/driver`
 *
 * `electron-u1` 的 driver 是「**自己拥有**那个 Electron 进程」的模式：`build.mjs`
 * 用仓库 node_modules 里的 electron 起一个进程、加载它自己打的 bundle，断言跑在
 * **同一个主进程**里（`WebContents.executeJavaScript`）。本卡验的是**已经打包好的
 * `Mcode.exe`**：主进程是产品自己的，进程里没有我们的执行器，唯一的外部控制面是
 * Chromium 的调试协议（`--remote-debugging-port`）。两者结构不同，"复用"只能是
 * 复用它的证据纪律（证据目录不自动清理、逐条 PASS/FAIL、退出码分档），而不是
 * 代码 —— 假装复用一个用不上的执行器，比不写更糟。
 *
 * ## 客户端本身照抄仓库里已验证的写法
 *
 * `scripts/*-smoke/browser.mjs` 里那份 WebSocket 客户端是仓库里跑了很久的 CDP
 * 写法（超时、pending 表、异常收集）。这里只做两处扩展：`awaitPromise`（产品桥
 * 全是 Promise）与 `Page.captureScreenshot`（画布格式的旁证截图）。
 * **零新依赖**：只用 Node 22 自带的 `WebSocket` 与 `fetch`。
 */

/** 连接一个 target 的 ws 端点。失败信息里带上 label，多 target 时能分清是谁。 */
export async function connectCdp(wsUrl, { label = "cdp", openTimeoutMs = 20_000 } = {}) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: CDP WebSocket 握手超时`)), openTimeoutMs);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error(`${label}: CDP WebSocket 握手失败`)); };
  });

  let seq = 0;
  const pending = new Map();
  /** 页面 console（含 React 未捕获异常）——失败时这就是全部线索。 */
  const consoleLines = [];
  const exceptions = [];

  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(String(event.data)); } catch { return; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`${label}: CDP 错误 ${JSON.stringify(msg.error).slice(0, 400)}`));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === "Runtime.consoleAPICalled") {
      consoleLines.push(`[console.${msg.params.type}] ` +
        (msg.params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 500));
      if (consoleLines.length > 400) consoleLines.shift();
    } else if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      exceptions.push(String(d?.exception?.description ?? d?.text ?? "unknown exception").slice(0, 800));
      if (exceptions.length > 100) exceptions.shift();
    }
  };

  const send = (method, params = {}, { timeoutMs = 20_000 } = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${label}: CDP 超时 ${method}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });

  await send("Runtime.enable");

  /** 页面里求值。`awaitPromise`：产品桥（window.api.*）全是 Promise。 */
  const evaluate = async (expression, { timeoutMs } = {}) => {
    const r = await send("Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true }, { timeoutMs });
    if (r.exceptionDetails) {
      const text = String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "");
      throw new Error(`${label}: 页面异常 ${text.slice(0, 800)}`);
    }
    return r.result?.value;
  };

  /** 轮询到 predicate(值) 为真；超时返回 null（**不抛**，由调用方决定怎么记）。 */
  const waitFor = async (expression, { timeoutMs = 30_000, intervalMs = 250, until = (v) => Boolean(v) } = {}) => {
    const end = Date.now() + timeoutMs;
    for (;;) {
      let value = null;
      try { value = await evaluate(expression); } catch { value = null; }
      if (until(value)) return value;
      if (Date.now() > end) return null;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  };

  const screenshot = async () => {
    const r = await send("Page.captureScreenshot", { format: "png" }, { timeoutMs: 30_000 });
    return r?.data ? Buffer.from(r.data, "base64") : null;
  };

  return { send, evaluate, waitFor, screenshot, consoleLines, exceptions, close: () => { try { ws.close(); } catch { /* 已关闭 */ } } };
}
