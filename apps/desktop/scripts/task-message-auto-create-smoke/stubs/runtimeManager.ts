/**
 * `RuntimeManager` 桩 —— **只为不把 electron 拉进无头套件**。
 *
 * 本套要验的是 `settleTurn` / `classifyTurn` 这两条**判据 + 写库**（纯逻辑），
 * 不是事件订阅本身。真的 `RuntimeManager` 会沿依赖链拉进 `electron`（窗口、IPC、
 * 原生模块），无头 node 里连 import 都过不去。
 *
 * ## 但它**记账**，因为「接线接上了没有」也必须能断言
 *
 * 一个只返回空函数的桩，会让 `startTaskAutoCreate()` 无论接没接上都"成功" ——
 * 那正是「套件全绿但指的不是它声称的地方」。这里记录回调，套件据此断言：
 * ① 订阅确实发生了；② 喂一个 `turn.files` + `turn.done` 进去，任务真的被建出来。
 *
 * **喂事件不是造假** —— 生产里就是 `RuntimeManager` 把这两个事件交给这个回调，
 * 套件做的是同一件事（只是事件由它自己构造）。走的是生产那一份 `onEvent`。
 */
import type { RuntimeEvent } from "@contracts/runtime";

const listeners = new Set<(e: RuntimeEvent) => void>();

export const runtimeManager = {
  subscribe(fn: (e: RuntimeEvent) => void): () => void {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
};

/** 套件用:有没有活的订阅者（= `startTaskAutoCreate` 真的接上了）。 */
export function __subscriberCount(): number {
  return listeners.size;
}

/** 套件用:替 `RuntimeManager` 投递一个事件（走生产那一份分发）。 */
export function __emit(e: RuntimeEvent): void {
  for (const fn of listeners) fn(e);
}
