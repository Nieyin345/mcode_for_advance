/**
 * 监控面板的 IPC handler(工作流运行的只读查询)。
 *
 * 这一层很薄:注册时顺手把**采集器**挂上(它必须随应用启动就在听 —— 等第一
 * 次 IPC 来了才订阅,已经跑完的那次运行就丢了),查询直接读 NDJSON 存储。
 * 聚合、存储、事件匹配的语义都在 `main/monitoring/` 那边,这里不重复实现。
 *
 * 渠道名先在这里就地定义 —— `@contracts/ipc` 的 `IPC.MONITORING_*` 常量由
 * contracts 侧统一补(gate 时换成 `IPC.*` 引用,字符串两边必须一字不差):
 * 与现有 `usage:stats` / `workflow:list` 同一条命名法。
 */
import type { IpcMain } from "electron";
import { dataRoot } from "@main/lib/dataRoot.js";
import { log } from "@main/lib/logger.js";
import { SessionRepo } from "@main/store/repositories.js";
import { startMonitoringCollector } from "@main/monitoring/collector.js";
import { readRunSummaries } from "@main/monitoring/store.js";
import { aggregateOverview } from "@main/monitoring/aggregate.js";

/** `api.monitoring.overview()` 的渠道。 */
const MONITORING_OVERVIEW = "monitoring:overview";
/** `api.monitoring.runs({ limit? })` 的渠道。 */
const MONITORING_RUNS = "monitoring:runs";

/** 查询端默认最多回多少条 —— 仪表盘先看最近的,更多等用户翻。 */
const DEFAULT_RUNS_LIMIT = 50;
/** 上限挡一手:一次 invoke 拖全量历史出来是自找的内存峰值。 */
const MAX_RUNS_LIMIT = 500;

/** 采集器只挂一次(重复挂 = 同一事件写两遍盘)。 */
let collectorStarted = false;

function ensureCollector(): void {
  if (collectorStarted) return;
  collectorStarted = true;
  startMonitoringCollector({
    root: dataRoot,
    // 事件不带 workflowId,只能查会话行;数据库没起来/行没了 → undefined,采集继续
    lookupWorkflowId: (sessionId) => {
      try {
        return SessionRepo.get(sessionId)?.workflowId;
      } catch (err) {
        // ⚠️ **不能静默。** 这里吞掉的正是"数据库没起来"——启动那几秒里发生的
        // 收口会全部记成空 workflowId,**面板上那张卡看不出跟的是哪张图**,而
        // 界面上没有任何东西提示"这段时间的监控数据是残的"。采集器的设计是
        // "查不到不拦着登记",不是"查不到别说":它自己那条同款 catch 有日志
        // (`collector.ts` 的 "工作流 id 查不到"),存储那条同款 catch 也有
        // (`store.ts` 的 "写盘失败")。三条路一个口径 —— 旁路可以带伤继续,
        // 但伤情要留在 main.log 里,否则排障时唯一的线索就没了。
        log.warn(
          `monitoring: 会话 ${sessionId} 的工作流 id 查不到,这次收口的 workflowId 记空: ${(err as Error).message}`,
        );
        return undefined;
      }
    },
  });
}

export function registerMonitoringHandlers(ipcMain: IpcMain): void {
  ensureCollector();

  // 无参 handler 不接 raw —— 与 `workflow.list` 同一条纪律
  ipcMain.handle(MONITORING_OVERVIEW, async () => aggregateOverview(readRunSummaries(dataRoot())));

  ipcMain.handle(MONITORING_RUNS, async (_evt, raw: unknown) => {
    // 入参就一个可选的 limit:手解而不是 zod schema —— contracts 那边的入参
    // 类型由 contracts 侧统一补,这里先把形状守死(坏值回落默认,不抛给渲染端)
    const limitInput = (raw as { limit?: unknown } | undefined)?.limit;
    const limit =
      typeof limitInput === "number" && Number.isFinite(limitInput)
        ? Math.min(Math.max(Math.trunc(limitInput), 1), MAX_RUNS_LIMIT)
        : DEFAULT_RUNS_LIMIT;
    return readRunSummaries(dataRoot(), limit);
  });
}
