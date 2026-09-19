/**
 * `@main/monitoring/collector.js` 的替身 —— 本套要**数**它被调了几次、并且
 * 拿得到 handler 交出去的那份 `deps`。
 *
 * ## 为什么必须换
 *
 * `ipc/monitoring.ts` 的模块级标记 `collectorStarted` 管的是「采集器只挂一次」
 * (重复挂 = 同一份事件写两遍盘)。那条纪律**唯一的可观测后果**是
 * `mobileEventBus` 上多了一个订阅者 —— 生产装配本身只是往总线上挂一个匿名
 * 订阅者,从外面数不出"挂了几次"。所以这里记下每一次调用。
 *
 * 另一件事:handler 交给采集器的 deps(`root` / `lookupWorkflowId`)是**它自己
 * 拼的**,不是契约、也不是导出符号 —— 想验"这个 handler 交出去的东西真的能用"
 * 就只能从调用记录里把它捞出来。
 *
 * ## ⚠️ 但它是**转发**,不是重写
 *
 * 光记账不够。handler 注册进去的是**真的** `MonitoringCollector` 类、真的
 * store、真的 aggregate —— 本套要往真总线喂真事件、再断言盘上多了一行。
 * 桩要是把装配整个换成空实现,"每个通道都真的走一遍"就退化成了一句复述:
 * 事件发出去没人接,断言只会红得莫名其妙。
 *
 * 所以这里**用相对路径** import 真模块,把 `MonitoringCollector` 原样再导出、
 * 并让 `startMonitoringCollector` 转发给真的那一个,只在外面包一层记录。
 *
 * 相对路径是有意的:`--alias:` 只认包名,**换不掉相对 import**(见 mcode-smoke
 * 技能文档),所以这一句拿到的必然是**真**模块 —— 也是主 bundle 里同一份实例
 * (esbuild 按解析后的绝对路径去重),喂进去的事件写出来的是同一份 NDJSON。
 *
 * Run: scripts/observability-ipc-smoke/run.sh
 */
import {
  MonitoringCollector as RealCollector,
  startMonitoringCollector as realStart,
} from "../../../src/main/monitoring/collector.js";
import type { MonitoringCollectorDeps } from "../../../src/main/monitoring/collector.js";

export { RealCollector as MonitoringCollector };
export type {
  MonitoringCollectorDeps,
  MonitoringNodeSummary,
  MonitoringRunSummary,
} from "../../../src/main/monitoring/collector.js";

interface Call {
  deps: MonitoringCollectorDeps;
  /** 转发给真实现拿到的那个退订函数。 */
  unsubscribe: () => void;
}

const calls: Call[] = [];

export function resetCollectorProbe(): void {
  calls.length = 0;
}

/** 每一次 `startMonitoringCollector` 的入参,按顺序(不含被标记挡住的那几次)。 */
export function collectorCalls(): readonly Call[] {
  return calls;
}

/** 唯一那次装配的 deps —— 本套靠它验"handler 交出去的东西真的能用"。 */
export function collectorDeps(): MonitoringCollectorDeps {
  const first = calls[0];
  if (!first) throw new Error("startMonitoringCollector 一次都没被调到");
  return first.deps;
}

/** 生产装配的替身:记账 + **转发**,返回真实现那个退订函数。 */
export function startMonitoringCollector(deps: MonitoringCollectorDeps): () => void {
  const unsubscribe = realStart(deps);
  calls.push({ deps, unsubscribe });
  return unsubscribe;
}
