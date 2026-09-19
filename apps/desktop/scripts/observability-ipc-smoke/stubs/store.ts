/**
 * `@main/monitoring/store.js` 的替身 —— 本套要**看** `ipc/monitoring.ts` 到底
 * 拿什么 `limit` 去问存储。
 *
 * ## 为什么需要它(两层夹取会互相遮住)
 *
 * `monitoring.ts` 算出来的 `limit` 是 `Math.min(Math.max(Math.trunc(n), 1), 500)`。
 * 把里面 `Math.max(…, 1)` 那一层**撤掉**,`limit=0` 会变成 0 —— 而这一路
 * **最终结果一点不变**。原因在 `store.ts` 的循环:
 *
 *   ```ts
 *   out.push(parsed);
 *   if (limit !== undefined && out.length >= limit) break;
 *   ```
 *
 * 先 push 再比,所以 `limit: 0` 也先给出 1 条。于是"撤掉下限夹取"在返回值上
 * **没有可观测后果** —— 实测:不做任何事地撤掉它,整套 smoke 全绿。
 *
 * 那不代表那层夹取是废的:`store.ts` 的入参约定就写着"`limit` 给的是去重之后
 * 还要多少条",给它 0 / 负数是在**依赖一个没承诺的行为**。所以判据要立在这里:
 * 看 handler **实际传下去的那个数**,而不是最终条数。传 0 或负数就是越界调用。
 *
 * ## 它是**转发**,不是重写
 *
 * 真的写入/读取照走 —— 本套 §11 灌 600 条、§13 断言盘上多一行,靠的都是真实现。
 * 只在外面记一笔 `readRunSummaries` 收到的 `limit`。
 *
 * 相对路径 import 真模块:`--alias:` 只认包名、换不掉相对 import(见技能文档),
 * 所以这一句拿到的必然是**真**模块,也是主 bundle 里同一份实例。
 *
 * Run: scripts/observability-ipc-smoke/run.sh
 */
import {
  appendRunSummary as realAppend,
  readRunSummaries as realRead,
} from "../../../src/main/monitoring/store.js";
import type {
  MonitoringNodeSummary,
  MonitoringRunSummary,
} from "../../../src/main/monitoring/store.js";

export type { MonitoringNodeSummary, MonitoringRunSummary };
export { monitoringDir } from "../../../src/main/monitoring/store.js";

/** `readRunSummaries` 收到的每一个 limit(`undefined` 表示压根没传)。 */
const seenLimits: Array<number | undefined> = [];

/** 本套的断言语境:只看某一段里传下去的那些 limit。 */
export function limitsSince(mark: number): Array<number | undefined> {
  return seenLimits.slice(mark);
}

export function limitsCount(): number {
  return seenLimits.length;
}

export function appendRunSummary(root: string, summary: MonitoringRunSummary): void {
  realAppend(root, summary);
}

export function readRunSummaries(root: string, limit?: number): MonitoringRunSummary[] {
  seenLimits.push(limit);
  return realRead(root, limit);
}
