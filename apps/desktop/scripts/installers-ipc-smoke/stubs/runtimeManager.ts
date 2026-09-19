/**
 * `@main/claude/RuntimeManager.js` 的替身 —— 只给无头脚本用。
 *
 * 真的那一个 import 了 providerRegistry / ApprovalBridge / mobileEventBus 一整条链,
 * 会拉起真的 SDK 子进程。本套要验的是 `ipc/runtimes.ts` 里那句**守卫**:
 *
 *     remove() 只要有任何会话在跑就得被拒
 *
 * 守卫读的就是这个 `runningSessionIds()`,所以替身只要把它做成**可摆布**的即可 ——
 * 脚本据此造出"0 个在跑"和"2 个在跑"两种现场。
 *
 * ⚠️ 与 run.sh 里的 `--alias:` 指向**同一个文件**,所以两边看见的是同一份状态
 * (技能文档里那条"两份模块实例"的坑:别名 + 相对 import 指的是不同文件时才发作,
 * 这里两边都是这个文件)。
 */
import type { RuntimeEvent } from "@contracts/runtime";

/** 脚本摆的现场:此刻有几个会话在跑。 */
let running: string[] = [];

/** 摆现场。传 `[]` 就是"一个都没在跑"。 */
export function setRunningSessionIds(ids: string[]): void {
  running = [...ids];
}

/** 按顺序记下 `runningSessionIds()` 被问过几次 —— 用来证明守卫真的问了。 */
export const runningQueries: string[] = [];

export const runtimeManager = {
  runningSessionIds(): string[] {
    runningQueries.push(running.join(","));
    return [...running];
  },
  emitExternal(_event: RuntimeEvent): void {
    /* 本套不碰这条路 */
  },
  subscribe(): () => void {
    return () => {};
  },
};
