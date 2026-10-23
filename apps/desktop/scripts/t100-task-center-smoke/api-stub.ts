/**
 * `@renderer/lib/api.js` 替身 —— 可编程的 `task.*`。
 *
 * 本套的判据是「点接受/退回之后，到底向主进程发了什么」，所以四个方法全部
 * **记录调用**（方法 + 参数 + 全局序号），返回由 `__setTasks()` / `__failNext()`
 * 驱动。其余命名空间走 Proxy 返回 undefined（传递依赖可能顺手读一个，不在判据内）。
 */
import type { Task } from "@contracts/ipc/task";

export interface TaskCall {
  method: "list" | "get" | "accept" | "reject";
  input: unknown;
  seq: number;
}

let seq = 0;
export const calls: TaskCall[] = [];

let tasks: Task[] = [];
/** 下一个写调用抛这个错（验「失败不吞」）。 */
let failNext: string | null = null;
/** 列表读取抛这个错（验加载失败分支）。 */
let failList: string | null = null;

export function __setTasks(next: Task[]): void {
  tasks = next;
}
export function __failNextWrite(msg: string | null): void {
  failNext = msg;
}
export function __failList(msg: string | null): void {
  failList = msg;
}
export function __writes(): TaskCall[] {
  return calls.filter((c) => c.method === "accept" || c.method === "reject");
}
export function __reset(): void {
  calls.length = 0;
  seq = 0;
  tasks = [];
  failNext = null;
  failList = null;
}

export const task = {
  list: async (input: unknown) => {
    calls.push({ method: "list", input, seq: ++seq });
    if (failList !== null) throw new Error(failList);
    return { tasks };
  },
  get: async (input: unknown) => {
    calls.push({ method: "get", input, seq: ++seq });
    return tasks.find((x) => x.id === (input as { id: string }).id) ?? null;
  },
  accept: async (input: unknown) => {
    calls.push({ method: "accept", input, seq: ++seq });
    if (failNext !== null) {
      const msg = failNext;
      failNext = null;
      throw new Error(msg);
    }
    return { ...(tasks[0] ?? {}), status: "accepted" };
  },
  reject: async (input: unknown) => {
    calls.push({ method: "reject", input, seq: ++seq });
    if (failNext !== null) {
      const msg = failNext;
      failNext = null;
      throw new Error(msg);
    }
    return { ...(tasks[0] ?? {}), status: "rejected" };
  },
};

/** 其余命名空间：任何属性都返回一个返回 undefined 的 async 函数。 */
export const api = new Proxy({ task } as Record<string, unknown>, {
  get(target, prop: string) {
    if (prop in target) return target[prop];
    return new Proxy({} as Record<string, unknown>, {
      get: () => async () => undefined,
    });
  },
});

export default api;
