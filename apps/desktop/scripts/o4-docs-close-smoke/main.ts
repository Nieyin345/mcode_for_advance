/**
 * O4 —— **无头**部分：直接打 `createDbGuardedIpc`（A）与
 * `registerDocumentViewHandlers` 的缺失 `on` 分支（B）。
 *
 * 主判据（真 Electron + 真 docs 页：关得掉、2 秒内）在 `run.sh` 的第二段
 * （`run.mjs` 走的 `electron-u1` 旅程）里；本文件验两个**包装层/注册层**的判据
 * （卡 2.2 / 2.3），它们不需要起 Electron：
 *
 *   A. 包装层接口诚实：返回对象必须有 `on`；注册的监听器在通道事件时真的被调用；
 *      **回调也走 `awaitDb()`**（与 handle 同一道闸 —— 否则数据库未就绪时
 *      `close-check-result` 会以另一种形态丢失，等于把一个 bug 换成另一个）；
 *      `handle` / `removeHandler` / `removeListener` 不能被修坏。
 *   B. 注册层不静默降级：传入**没有 `on`** 的 ipc 桩时，必须喊出来，且消息
 *      **点名缺的是 `on`** 与受影响通道；传有 `on` 的桩时**不许**喊（正控 ——
 *      否则「缺 on 必须喊」在消息恒有时也会绿）。
 *
 * ## 数据库是门闸桩
 *
 * `@main/store/db.js` 换成 `stubs/dbGate.ts`：`awaitDb()` 变成可控门闸，才能
 * 断言「DB 未就绪时 on 回调不执行、就绪后才执行」。真 `awaitDb()` 在 initDb
 * 前立即 resolve（`dbReadyPromise ?? Promise.resolve()`），验不出这条。
 *
 * ## 预期红（修复前）
 *
 * A1 / A1b / A2 / A3 / A5 / A6 全红（`wrapped.on` 与 remove* 都是 undefined），
 * B6 / B6b / B8 红（缺 on 时静默）。看到这些红才说明套件真的指在缺陷上。
 */
import { createDbGuardedIpc } from "@main/ipc/dbGuardedIpc.js";
import { registerDocumentViewHandlers } from "@main/ipc/documentView.js";
import { registeredRpcChannels, clearRpcHandlers } from "@main/appControl/registry.js";
// 测试专用导出直接 import 桩文件（tsc 看不到 `--alias`）；运行期 alias 把
// `@main/store/db.js` / `@main/lib/logger.js` 都指到这两个模块，是**同一份实例**
// （与 `app-control-smoke` import `./stubs/repositories.js` 同一条做法）。
import { __setDbReady } from "./stubs/dbGate.js";
import { capturedLogs, clearCapturedLogs } from "./stubs/logger.js";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail).slice(0, 1200)}`}`);
  }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/* ────────────────────────── 记录式目标 ipcMain ────────────────────────── */

interface RecordedMain {
  handlers: Map<string, (event: unknown, raw: unknown) => unknown>;
  listeners: Map<string, Array<(event: unknown, ...args: unknown[]) => void>>;
  removedHandlers: string[];
  removedListeners: number;
  emit(channel: string, ...args: unknown[]): void;
}

function makeRecordedMain(): RecordedMain {
  const recorded: RecordedMain = {
    handlers: new Map(),
    listeners: new Map(),
    removedHandlers: [],
    removedListeners: 0,
    emit(channel, ...args) {
      for (const listener of [...(recorded.listeners.get(channel) ?? [])]) listener({ sender: "fake" }, ...args);
    },
  };
  return recorded;
}

function asTarget(recorded: RecordedMain): import("electron").IpcMain {
  return {
    handle(channel: string, listener: (event: unknown, raw: unknown) => unknown): void {
      recorded.handlers.set(channel, listener);
    },
    on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown {
      const list = recorded.listeners.get(channel) ?? [];
      list.push(listener);
      recorded.listeners.set(channel, list);
      return this;
    },
    removeHandler(channel: string): void {
      recorded.removedHandlers.push(channel);
      recorded.handlers.delete(channel);
    },
    removeListener(channel: string, listener: (...args: unknown[]) => void): unknown {
      recorded.removedListeners += 1;
      const list = recorded.listeners.get(channel) ?? [];
      recorded.listeners.set(channel, list.filter((entry) => entry !== listener));
      return this;
    },
  } as unknown as import("electron").IpcMain;
}

type WrappedIpc = {
  handle: (channel: string, listener: (event: unknown, raw: unknown) => unknown) => void;
  on?: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => unknown;
  removeHandler?: (channel: string) => void;
  removeListener?: (channel: string, listener: (...args: unknown[]) => void) => unknown;
};

/* ═════════════════════════════ A. 包装层（卡 2.2） ═════════════════════════════ */

console.log("\nA. createDbGuardedIpc：接口诚实 + on 与 handle 同一道闸");

{
  __setDbReady(true);
  clearRpcHandlers();
  const recorded = makeRecordedMain();
  const wrapped = createDbGuardedIpc(asTarget(recorded)) as unknown as WrappedIpc;

  // A1：包装层宣称自己是 IpcMain，docs 关闭链用的就是 on —— 它必须真的在。
  check("A1 ★ 包装后的 ipc 有 on 方法（typeof wrapped.on === 'function'）",
    typeof wrapped.on === "function", { on: typeof wrapped.on });
  check("A1b 包装后的 ipc 仍有 handle / removeHandler / removeListener（修好 on 不毁别的）",
    typeof wrapped.handle === "function" && typeof wrapped.removeHandler === "function" &&
      typeof wrapped.removeListener === "function",
    {
      handle: typeof wrapped.handle,
      removeHandler: typeof wrapped.removeHandler,
      removeListener: typeof wrapped.removeListener,
    });

  // A2：通过 wrapped.on 注册的监听器，在对应通道 emit 时真的被调用。
  let a2calls = 0;
  let a2payload: unknown = null;
  if (typeof wrapped.on === "function") {
    wrapped.on("o4:a2", (_event: unknown, raw: unknown) => {
      a2calls += 1;
      a2payload = raw;
    });
  }
  recorded.emit("o4:a2", { dirty: false });
  await sleep(30);
  eq("A2 ★ wrapped.on 注册的监听器在通道 emit 时被调用（恰好一次）", a2calls, 1);
  check("A2b 监听器收到页面 payload 原样（值比较，不是对象身份）",
    JSON.stringify(a2payload) === JSON.stringify({ dirty: false }), { actual: a2payload });
  check("A2c 监听器真的挂在目标 ipcMain 的同名通道上（不是只记在包装层里）",
    (recorded.listeners.get("o4:a2") ?? []).length === 1,
    { listeners: (recorded.listeners.get("o4:a2") ?? []).length });

  // A3：on 回调与 handle 走同一道 awaitDb 闸 —— DB 未就绪时不执行，就绪后才执行。
  // ⚠️ 判据必须显式依赖「on 存在」：缺 on 时直接 FAIL，绝不能让 a3calls===0 让它空过。
  if (typeof wrapped.on !== "function") {
    check("A3a ★ DB 未就绪时，on 回调不执行（与 handle 同一道闸）", false, {
      why: "wrapped.on 缺失 —— 无法验 awaitDb 闸（不是通过，是没验）",
    });
    check("A3b ★ DB 就绪放行后，同一回调恰好执行一次", false, { why: "wrapped.on 缺失" });
  } else {
    __setDbReady(false);
    let a3calls = 0;
    wrapped.on("o4:a3", () => {
      a3calls += 1;
    });
    recorded.emit("o4:a3");
    await sleep(50);
    eq("A3a ★ DB 未就绪时，on 回调不执行（与 handle 同一道闸）", a3calls, 0);
    __setDbReady(true);
    await sleep(50);
    eq("A3b ★ DB 就绪放行后，同一回调恰好执行一次", a3calls, 1);
  }
  __setDbReady(true);

  // A4：修好 on 不能把 handle 弄坏 —— 注册、登记进 registry、返回值三条都在。
  let handled = 0;
  wrapped.handle("o4:handle", async (_event: unknown, raw: unknown) => {
    handled += 1;
    const n = (raw as { n?: number } | null)?.n;
    return { doubled: typeof n === "number" ? n * 2 : null };
  });
  check("A4a handle 仍然注册到目标 ipcMain", recorded.handlers.has("o4:handle"));
  eq("A4b handle 包装后仍登记进 recordRpcHandler（app_api_call 看得见）",
    registeredRpcChannels().includes("o4:handle"), true);
  const out = recorded.handlers.has("o4:handle")
    ? await (recorded.handlers.get("o4:handle") as (e: unknown, raw: unknown) => Promise<unknown>)(null, { n: 21 })
    : null;
  eq("A4c handle 的返回值仍是 { doubled: 42 }", JSON.stringify(out), JSON.stringify({ doubled: 42 }));
  eq("A4d handle 真的被执行了一次", handled, 1);

  // A5：removeListener 必须能把**原来那个**函数移除。包装层为了加 awaitDb 会把
  //     监听器换成另一个函数；若 removeListener 原样透传，调用方手里的原函数永远
  //     摘不掉 —— 与「缺 on」同一类静默失败。
  const original = (): void => undefined;
  if (typeof wrapped.on === "function" && typeof wrapped.removeListener === "function") {
    wrapped.on("o4:a5", original);
    const before = (recorded.listeners.get("o4:a5") ?? []).length;
    wrapped.removeListener("o4:a5", original);
    const after = (recorded.listeners.get("o4:a5") ?? []).length;
    check("A5 ★ removeListener(原函数) 真的摘掉了包装后的监听器",
      before === 1 && after === 0, { before, after });
  } else {
    check("A5 ★ removeListener(原函数) 真的摘掉了包装后的监听器", false, {
      on: typeof wrapped.on,
      removeListener: typeof wrapped.removeListener,
    });
  }

  // A6：removeHandler 透传。
  if (typeof wrapped.removeHandler === "function") {
    wrapped.handle("o4:remove-me", () => undefined);
    wrapped.removeHandler("o4:remove-me");
    eq("A6 removeHandler 透传给目标 ipcMain",
      recorded.removedHandlers.includes("o4:remove-me"), true);
  } else {
    eq("A6 removeHandler 透传给目标 ipcMain", false, { removeHandler: typeof wrapped.removeHandler });
  }
}

/* ═══════════════════════ B. 注册层不静默降级（卡 2.3） ═══════════════════════ */

console.log("\nB. registerDocumentViewHandlers：缺 on 必须喊出来，且点名 on");

/** 注册期只需要 handle/on；宿主方法在 handler 执行前不会被触摸（本段不执行 handler）。 */
const hostStub = {} as unknown as import("@main/document/documentViewHost.js").DocumentViewHost;

let negativeMessage = "";
{
  // B6（负控）：没有 on 的 ipc 桩 → 必须产生一条 warn/error 日志（或抛错），消息点名 `on`。
  clearCapturedLogs();
  const handlers = new Map<string, (event: unknown, raw: unknown) => unknown>();
  const withoutOn = {
    handle(channel: string, listener: (event: unknown, raw: unknown) => unknown): void {
      handlers.set(channel, listener);
    },
  } as unknown as import("electron").IpcMain;
  let threw = "";
  try {
    registerDocumentViewHandlers(withoutOn, hostStub, () => true, undefined, () => true);
  } catch (err) {
    threw = (err as Error).message;
  }
  const complaints = capturedLogs.filter((entry) =>
    (entry.level === "warn" || entry.level === "error") && entry.message.includes("on"));
  check("B6 ★ 缺 on 时 registerDocumentViewHandlers 抛错或 warn/error（不是静默跳过）",
    threw !== "" || complaints.length > 0, { threw, logs: capturedLogs });
  negativeMessage = threw !== "" ? threw : (complaints[0]?.message ?? "");
  const named = /缺少\s*on\(\)/.test(negativeMessage) && negativeMessage.includes("close-check-result");
  check("B6b ★ 消息点名缺的是 on()（且点名受影响通道 close-check-result），不是泛泛的「注册失败」",
    named, { negativeMessage, logs: complaints.map((entry) => entry.message) });
  check("B6c 缺 on 的桩上，handle 通道仍全部注册（喊出来不等于罢工）",
    handlers.has("mcode:document-view:close-check-result") &&
      handlers.has("documentView:open") && handlers.has("documentView:close"),
    { channels: [...handlers.keys()] });

  // B8：文案必须说清**后果** —— 这个缺陷的代价就是「症状（2 秒超时被拒）离原因（缺 on）很远」。
  check("B8 ★ 负控消息把「症状」写出来（关闭 docs 会 2 秒超时被拒），缩短症状与原因的距离",
    negativeMessage.includes("2 秒") && negativeMessage.includes("关闭"),
    { negativeMessage });

  // B7（正控）：有 on 的桩 → **不许**出现那条警告，且监听器真的注册到通道上。
  clearCapturedLogs();
  const handlers2 = new Map<string, (event: unknown, raw: unknown) => unknown>();
  const listeners = new Map<string, Array<(event: unknown, ...args: unknown[]) => void>>();
  const withOn = {
    handle(channel: string, listener: (event: unknown, raw: unknown) => unknown): void {
      handlers2.set(channel, listener);
    },
    on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown {
      const list = listeners.get(channel) ?? [];
      list.push(listener);
      listeners.set(channel, list);
      return this;
    },
  } as unknown as import("electron").IpcMain;
  registerDocumentViewHandlers(withOn, hostStub, () => true, undefined, () => true);
  const falseAlarm = capturedLogs.filter((entry) => /缺少\s*on\(\)/.test(entry.message));
  eq("B7 ★ 正控：有 on 的桩不触发「缺少 on()」警告（判据不是恒报）", falseAlarm.length, 0);
  eq("B7b 有 on 时监听器真的注册到 close-check-result（send 单向通道有对端）",
    (listeners.get("mcode:document-view:close-check-result") ?? []).length, 1);
}

console.log(`\no4-docs-close-smoke(无头): ${total - failures}/${total} 通过`);
if (failures > 0) {
  console.log("o4-docs-close-smoke(无头): FAIL");
  process.exitCode = 1;
} else {
  console.log("o4-docs-close-smoke(无头): PASS");
}
