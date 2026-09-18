/**
 * 仪表盘汇总 —— 从已收口的运行摘要现算出 `MonitoringOverview`。
 *
 * **纯函数**:输入摘要列表、输出一个对象,不碰磁盘也不碰时钟 —— 数据从
 * `store.readRunSummaries` 来(最新的在前),顺序就是"最新优先"的语义。
 * 单独成文件是因为它该被无头脚本直接喂着验,不该连带任何 I/O。
 */
import type { MonitoringOverview, MonitoringRunSummary } from "./types.js";

/**
 * 聚合入口。`summaries` 按**最新在前**的顺序传(readRunSummaries 的返回序)
 * —— "最近一次失败"取顺序里的第一个失败者。
 *
 * 汇总的口径:
 * - `totalRuns` 是**全部**收口运行(含取消),不只数成败;
 * - `avgDurationMs` 对全部运行平均,拿不到耗时的(理论上有,防御)跳过;
 * - 失败信息取第一个失败运行里**第一个失败节点**的原因 —— 那是链路上最先
 *   断掉的一环,排障从它开始。
 */
export function aggregateOverview(summaries: readonly MonitoringRunSummary[]): MonitoringOverview {
  let succeeded = 0;
  let failed = 0;
  let durationTotal = 0;
  let durationCount = 0;

  for (const summary of summaries) {
    if (summary.status === "success") succeeded += 1;
    else if (summary.status === "failed") failed += 1;
    if (typeof summary.durationMs === "number" && Number.isFinite(summary.durationMs)) {
      durationTotal += summary.durationMs;
      durationCount += 1;
    }
  }

  // 第一个 failed 运行的第一个 failed 节点 —— "最后一条错误"是谁说的
  const firstFailed = summaries.find((s) => s.status === "failed");
  const failedNode = firstFailed?.nodes.find((n) => n.status === "failed");
  const lastErrorAt = firstFailed
    ? (firstFailed.endedAt ?? firstFailed.startedAt + firstFailed.durationMs)
    : undefined;
  const lastErrorMessage = failedNode?.error;

  return {
    totalRuns: summaries.length,
    succeeded,
    failed,
    avgDurationMs: durationCount === 0 ? 0 : Math.round(durationTotal / durationCount),
    ...(lastErrorAt !== undefined && lastErrorMessage !== undefined
      ? { lastErrorAt, lastErrorMessage }
      : {}),
  };
}
