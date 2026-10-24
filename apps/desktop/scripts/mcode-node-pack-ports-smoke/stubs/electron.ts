/**
 * `electron` 的替身 —— **记录型**,专给 `mcode-node-pack-ports-smoke` 用。
 *
 * 被测文件里两处 `await import("electron")` 只用到 `dialog.showMessageBox`:
 *   - `chooseBranch` 的真人选路(`Output 0..N-1` + `Cancel`);
 *   - `node-red.call` 的部署审批(`Deny` / `Allow once`)。
 *
 * 这两处都是**安全边界**:「用户点了 Deny 要抛」只有在能**喂返回值**的时候才验得了。
 * 纯抛型桩分不出「拒绝了」和「根本没走到」——所以这里是记录型:调用参数逐条记下来,
 * 返回值由脚本排队喂。没排队就调 = 夹具摆错了,直接抛,不安静返回一个「取消」。
 *
 * `app` 只为 `@main/store/db.ts` 的 `import { app }` 存在(db.ts 实际不调用它);
 * 真正的数据根由 `run-store-smoke/stubs/dataRoot.ts` 接管。
 */
export const app = {
  getPath: () => process.env.MCODE_SMOKE_DATA_ROOT || "/tmp/mcode-node-pack-ports-smoke",
  getAppPath: () => "/tmp/mcode-node-pack-ports-smoke",
  getVersion: () => "0.0.0",
  isPackaged: false,
  on: () => {},
  once: () => {},
  whenReady: () => Promise.resolve(),
  quit: () => {},
};

export interface MessageBoxCall {
  win: unknown;
  options: Record<string, unknown>;
}

/** 每次 `showMessageBox` 收到的参数原样存下来(验 buttons/cancelId/defaultId/type)。 */
export const messageBoxCalls: MessageBoxCall[] = [];

const responseQueue: number[] = [];

/** 预先排好的返回值(`response.response`)。 */
export function pushMessageBoxResponse(response: number): void {
  responseQueue.push(response);
}

/** 清空调用记录**和**队列 —— 每条断言前调一次,免得前面那条的余量影响这条。 */
export function resetDialog(): void {
  messageBoxCalls.length = 0;
  responseQueue.length = 0;
}

export const dialog = {
  showMessageBox: async (win: unknown, options: Record<string, unknown>) => {
    messageBoxCalls.push({ win, options: { ...options } });
    const next = responseQueue.shift();
    if (next === undefined) {
      throw new Error("dialog.showMessageBox 被调了但脚本没喂返回值 —— pushMessageBoxResponse 少了一次");
    }
    return { response: next, checkboxChecked: false };
  },
  showOpenDialog: async () => {
    throw new Error("mcode-node-pack-ports-smoke 不该走到 dialog.showOpenDialog");
  },
  showSaveDialog: async () => {
    throw new Error("mcode-node-pack-ports-smoke 不该走到 dialog.showSaveDialog");
  },
};
