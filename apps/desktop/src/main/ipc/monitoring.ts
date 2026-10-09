/**
 * 监控面板的 IPC handler(工作流运行的只读查询)。
 *
 * 这一层很薄:注册时顺手把**采集器**挂上(它必须随应用启动就在听 —— 等第一
 * 次 IPC 来了才订阅,已经跑完的那次运行就丢了),查询直接读 NDJSON 存储。
 * 聚合、存储、事件匹配的语义都在 `main/monitoring/` 那边,这里不重复实现。
 *
 * 渠道名直接用 `@contracts/ipc` 的 `IPC.MONITORING_*`(契约里已有,见 `rpcMap.ts`)——
 * 从前这里手写了一份字符串、注释还说"由 contracts 侧统一补",其实早就补好了。两份字面量
 * 靠一套 smoke 断言相等兜底,不如直接引用。
 */
import type { IpcMain } from "electron";
import { IPC, MONITORING_RUNS_LIMIT_MAX } from "@contracts/ipc";
import { dataRoot } from "@main/lib/dataRoot.js";
import { log } from "@main/lib/logger.js";
import { SessionRepo } from "@main/store/repositories.js";
import { startMonitoringCollector } from "@main/monitoring/collector.js";
import { readRunSummaries } from "@main/monitoring/store.js";
import { aggregateOverview } from "@main/monitoring/aggregate.js";

/** 查询端默认最多回多少条 —— 仪表盘先看最近的,更多等用户翻。 */
const DEFAULT_RUNS_LIMIT = 50;

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
  ipcMain.handle(IPC.MONITORING_OVERVIEW, async () => aggregateOverview(readRunSummaries(dataRoot())));

  ipcMain.handle(IPC.MONITORING_RUNS, async (_evt, raw: unknown) => {
    // 入参就一个可选的 limit:手解而不是 zod schema —— 坏值回落默认,不抛给渲染端。
    // ⚠️ **上限用契约那个常量**(`MONITORING_RUNS_LIMIT_MAX`)。从前这里自己钉了
    // `MAX_RUNS_LIMIT = 500`,而契约 `MonitoringRunsSchema` 写的是 `.max(50)` —— 两份上界
    // 漂了:`app_api_call` 传 limit:300 会真回 300 行,既越过 declared 类型又是内存峰值入口。
    // 现在两处同一个数(契约里那一份)。
    const limitInput = (raw as { limit?: unknown } | undefined)?.limit;
    const limit =
      typeof limitInput === "number" && Number.isFinite(limitInput)
        ? Math.min(Math.max(Math.trunc(limitInput), 1), MONITORING_RUNS_LIMIT_MAX)
        : DEFAULT_RUNS_LIMIT;
    return readRunSummaries(dataRoot(), limit);
  });
}
