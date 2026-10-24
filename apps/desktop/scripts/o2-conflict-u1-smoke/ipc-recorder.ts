/**
 * O2 —— **保存通道回包记录器**（挂在主进程 IPC 层上的取证）。
 *
 * ## 为什么需要它
 *
 * O2 要证的不是「页面把一句话显示出来了」，而是三层各自独立的事实：
 *
 *   4a. **主进程真的拒绝了这次保存**（而且是因为版本冲突）；
 *   4b. **盘上的外部内容逐字节没被覆盖**；
 *   4c. **用户真的看得见提示**（DOM 层，不是 console 日志）。
 *
 * 如果 4a 从 DOM 反推（「看到保存失败字样」），那 4a 与 4c 就成了同一件事：
 * 删掉提示元素时两条一起红，分不清「拦住了但没提示」和「根本没拦住」——而
 * 这两种情况的严重程度差很远（卡 §五变异 2 点名的就是这个）。
 *
 * 所以 4a 的证据必须来自**页面之外**：记下每个保存通道的**真实回包**
 * （返回值 / 抛出的错误）。页面 DOM 归 4c，磁盘字节归 4b，三者互不代偿。
 *
 * ## 两层都要包（第一版只包了第一层，slides 因此漏抓）
 *
 * 1. **之后的注册**：改写 `ipcMain.handle`（Electron 44 上它是自有可写属性；
 *    `mcode-sheets-scoped.ts` 的 Proxy 转调 `target.handle`，也会落到这里）。
 * 2. **之前的注册**：slides 的 vendor 主进程（`slides-main.ts`）在**模块加载时**
 *    就 `ipcMain.handle("slides:save", …)` —— 而它在 `beforeReady` 里被 require
 *    的时刻，可能早于（或被 esbuild 内联到）记录器的安装。本机实测：
 *    `registeredSaveChannels` 里没有 `slides:save`，但页面确实收到了
 *    `{ ok: true }`（`run-g1.log` 的 `genoffice-pane-slides A slides:save: allowed`）。
 *    Electron 把已注册的 invoke handler 放在 `ipcMain._invokeHandlers`（一张
 *    **真的 Map**，本机实测 `Map size` 正确、`set` 后页面确实拿到被包装函数
 *    的回包）。这里给**已存在的**保存通道再包一层。
 *
 * ## 只记「保存通道」，只记投影
 *
 * 全量记录会吞掉大对象（sheets 的 workbook 回包）并撑爆证据。这里只记录六个
 * 保存通道，且只取与判据相关的字段。**不记录、不改写任何回包内容** ——
 * 记录器对产品行为是只读的：监听器照原样执行，返回值/异常照原样透传。
 */

/** 六个格式的真实保存通道（来源逐个注明在 `SAVE_CHANNEL_BY_KIND` 旁）。 */
export const O2_SAVE_CHANNELS: readonly string[] = Object.freeze([
  "mcode:document-view:save",        // docs：preload `saveDocx` → `ipc/documentView.ts`
  "mcode:document-view:slides-save", // slides：Mcode 受限 preload `slidesApi.save()` → `onSlidesSave`（降级路线）
  "slides:save",                     // slides：vendor preload 直调（生产原生视图实际走的这条）
  "workbook:save",                   // sheets：vendor preload `saveWorkbookEdits` → `sheets-main.ts`
  "pdf:save",                        // pdf：vendor preload `pdfApi.save` → `pdf-main.ts`
  "markdown:save",                   // markdown：vendor preload `markdownApi.save` → `markdown-main.ts`
  "html:save",                       // html：vendor preload `htmlApi.save` → `html-main.ts`
]);

export interface SaveReplyRecord {
  /** 单调递增序号：调用**开始**时分配（observe 取 `seq > triggerSeq`）。 */
  seq: number;
  channel: string;
  at: number;
  senderId: number | null;
  /** 回包投影（只保留判据字段）；同步返回时立即写入。 */
  reply: Record<string, unknown> | null;
  /** 处理函数抛出的错误消息（sheets 的冲突形态就是 throw）。 */
  thrown: string | null;
  /** 这条记录是包装哪一层拿到的（诊断：`handle` = 安装后注册；`map` = 安装前已注册）。 */
  via: "handle" | "map";
}

const PROJECTED_KEYS = [
  "ok", "reason", "error", "canceled", "bytes", "path", "currentRevision", "filePath",
] as const;

let installed = false;
let seqCounter = 0;
const records: SaveReplyRecord[] = [];
/** 诊断：被包装过的保存通道（`via` 区分两层）。 */
const wrapped: Array<{ channel: string; via: "handle" | "map" }> = [];
const MAX_RECORDS = 120;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** 把回包收敛成 JSON 安全的小对象；`undefined` 记成 null（"没有回包"与"回包 null"分开处理）。 */
function project(channel: string, reply: unknown): Record<string, unknown> {
  if (reply === null || typeof reply !== "object") {
    return { value: reply === undefined ? null : (reply as string | number | boolean) };
  }
  const source = reply as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of PROJECTED_KEYS) {
    if (!(key in source)) continue;
    const value = source[key];
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    }
  }
  // sheets：`{ canceled:false, file:{ path, fileBytes, sha256 } }` —— 只取落点路径。
  if (channel === "workbook:save") {
    const file = source.file as { path?: unknown } | undefined;
    if (file && typeof file.path === "string") out.filePath = file.path;
  }
  return out;
}

/** 造一条"记录一次调用"的包装。两层（handle / map）共用同一份执行与记录逻辑。 */
function wrapListener(
  channel: string,
  listener: (event: unknown, ...args: unknown[]) => unknown,
  via: "handle" | "map",
): (event: unknown, ...args: unknown[]) => unknown {
  return (event, ...args) => {
    const sender = (event as { sender?: { id?: unknown } } | null)?.sender;
    const record: SaveReplyRecord = {
      seq: ++seqCounter,
      channel,
      at: Date.now(),
      senderId: sender && typeof sender.id === "number" ? sender.id : null,
      reply: null,
      thrown: null,
      via,
    };
    records.push(record);
    if (records.length > MAX_RECORDS) records.shift();
    // 监听器照原样执行；回包/异常照原样透传（记录器对产品行为只读）。
    try {
      const value = listener(event, ...args);
      if (value !== null && typeof value === "object" && typeof (value as Promise<unknown>).then === "function") {
        return (value as Promise<unknown>).then(
          (settled) => {
            record.reply = project(channel, settled);
            return settled;
          },
          (error: unknown) => {
            record.thrown = errorMessage(error);
            throw error;
          },
        );
      }
      record.reply = project(channel, value);
      return value;
    } catch (error) {
      record.thrown = errorMessage(error);
      throw error;
    }
  };
}

/**
 * 装上记录器。幂等（一个进程只装一次）。
 *
 * **顺序**：先包 `_invokeHandlers` 里**已注册**的保存通道（slides 的 vendor
 * handler 可能在装配前就已注册），再改写 `handle` 管之后的注册。两层都装 =
 * 无论那条 handler 什么时候注册，调用都会经过记录器。
 */
export function installIpcRecorder(): void {
  if (installed) return;
  installed = true;
  // 惰性 require：本模块会被注册表（普通 Node 也会加载）顶层 import，
  // 顶层写 `require("electron")` 会让 `build.mjs` 读旅程名时直接崩。
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ipcMain } = require("electron") as typeof import("electron");

  // ── 第 2 层：已注册的 handler（Electron 内部 Map；不存在就跳过，不假装成功） ──
  const invokeHandlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, (event: unknown, ...args: unknown[]) => unknown> })._invokeHandlers;
  if (invokeHandlers instanceof Map) {
    for (const channel of O2_SAVE_CHANNELS) {
      const existing = invokeHandlers.get(channel);
      if (typeof existing !== "function") continue;
      invokeHandlers.set(channel, wrapListener(channel, existing, "map"));
      wrapped.push({ channel, via: "map" });
    }
  }

  // ── 第 1 层：之后的注册 ──
  const realHandle = ipcMain.handle.bind(ipcMain) as (
    channel: string,
    listener: (event: unknown, ...args: unknown[]) => unknown,
  ) => void;
  const wrappedHandle = (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void => {
    if (!O2_SAVE_CHANNELS.includes(channel)) {
      realHandle(channel, listener);
      return;
    }
    wrapped.push({ channel, via: "handle" });
    realHandle(channel, wrapListener(channel, listener, "handle"));
  };
  // 自有属性可写（Electron 44 实测）；赋到对象本身上，后续 Proxy/直调都落到这里。
  (ipcMain as unknown as { handle: typeof wrappedHandle }).handle = wrappedHandle;
}

/** 当前序号（trigger 步骤在**触发保存之前**取它，observe 只看比它大的记录）。 */
export function recorderLastSeq(): number {
  return seqCounter;
}

/** 诊断：包了哪些通道、装没装上、累计见过几条保存回包。
 *  「4a 说没有到达保存通道」时先看这里 —— 分清「保存没发生」与「记录器没装上」。 */
export function recorderDiagnostics(): {
  installed: boolean;
  wrapped: Array<{ channel: string; via: "handle" | "map" }>;
  total: number;
  channels: string[];
  mapLayerAvailable: boolean;
} {
  let mapLayerAvailable = false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ipcMain } = require("electron") as typeof import("electron");
    mapLayerAvailable = (ipcMain as unknown as { _invokeHandlers?: unknown })._invokeHandlers instanceof Map;
  } catch { mapLayerAvailable = false; }
  return {
    installed,
    wrapped: [...wrapped],
    total: records.length,
    channels: records.map((r) => r.channel),
    mapLayerAvailable,
  };
}

/** 触发器之后开始的保存回包（含尚未完成的记录：reply/thrown 都可能是 null）。 */
export function saveRepliesSince(sinceSeq: number): SaveReplyRecord[] {
  return records.filter((r) => r.seq > sinceSeq).map((r) => ({ ...r }));
}
