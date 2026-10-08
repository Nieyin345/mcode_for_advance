/**
 * 监控存储 —— 已收口的工作流运行摘要,**一行一个运行**地追加进 NDJSON。
 *
 * ## 为什么不用数据库
 *
 * 写入频率是"一次运行一条"(一张图几分钟才收一次口),查询是"倒序拿最近几十条"
 * —— 两头都是 O(少量)。为这个上 sqlite 的一张表,换来的是迁移、schema 版本和
 * 一条 `awaitDb()` 的依赖;一个追加写的文本文件两头都更简单,**也天然带着写入
 * 顺序**(追加 = 时间顺序,倒序读 = 最新在前)。
 *
 * ## 为什么不复用 `runStore`(workflow_runs 表)
 *
 * 那份是**续跑存档**,按 sessionId 分桶、每桶只留最近几行、旧行会被 `pruneRuns`
 * 删掉 —— 它的保留策略是"能不能续跑",不是"过去发生了什么"。监控要的是**跨
 * 会话、只增不减**的历史,两种保留策略塞一张表里迟早互相打架。
 *
 * ## 失败语义
 *
 * 写不进去**只记一行警告,不抛** —— 采集是旁路,存储坏了不能反过来影响工作流
 * 的收尾(那里还挂着 turn.done 要发)。读失败同理:返回手里已有的行。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "@main/lib/logger.js";
import type { MonitoringNodeSummary, MonitoringRunSummary } from "./types.js";

/** 数据根下的监控目录名(与 library/ templates/ 平级)。 */
const MONITORING_DIRNAME = "monitoring";
/** 摘要文件名 —— NDJSON,一行一个 JSON。 */
const RUNS_FILENAME = "runs.ndjson";

/** 监控目录:<数据根>/monitoring。`root` 由调用方注入(生产是 `dataRoot()`)。 */
export function monitoringDir(root: string): string {
  return join(root, MONITORING_DIRNAME);
}

function runsFile(root: string): string {
  return join(monitoringDir(root), RUNS_FILENAME);
}

/**
 * 追加一条已收口的运行摘要。**吞错记日志** —— 理由见文件头。
 */
export function appendRunSummary(root: string, summary: MonitoringRunSummary): void {
  try {
    const dir = monitoringDir(root);
    mkdirSync(dir, { recursive: true });
    appendFileSync(runsFile(root), `${JSON.stringify(summary)}\n`, "utf8");
  } catch (err) {
    log.warn(`monitoring: run summary 写盘失败(runId=${summary.runId}): ${(err as Error).message}`);
  }
}

/**
 * 读已收口的运行摘要,**最新的在前**。
 *
 * - 追加序就是时间序,所以从文件尾往前读即可;
 * - **同一个 runId 取最新的一行**(续跑沿用旧 id,一次续跑会追加一条新的
 *   summary —— 卡片按它原地改,这里按它去重);
 * - 坏行(写到一半进程死了、或外来的手改)跳过,不带崩整份查询;
 * - `limit` 给的是**去重之后**还要多少条。
 */
export function readRunSummaries(root: string, limit?: number): MonitoringRunSummary[] {
  const file = runsFile(root);
  if (!existsSync(file)) return [];
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    log.warn(`monitoring: run summary 读不出来,按空历史处理: ${(err as Error).message}`);
    return [];
  }

  const lines = raw.split("\n");
  const seen = new Set<string>();
  const out: MonitoringRunSummary[] = [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    const parsed = parseRunSummary(line);
    if (parsed === undefined) continue;
    if (seen.has(parsed.runId)) continue;
    // `limit` 是"去重之后还要多少条"(见函数头),所以**先判满再 push** ——
    // push 之后才比会让 `limit: 0` 也带出一条,恰好违反这个约定(越界入参的
    // 兜底夹取在 `ipc/monitoring.ts`,这里只保证自己按承诺办事)。
    if (limit !== undefined && out.length >= limit) break;
    seen.add(parsed.runId);
    out.push(parsed);
  }
  return out;
}

/** 一行 NDJSON → 一条摘要。形状不对(缺关键字段、类型不对)返回 undefined。 */
function parseRunSummary(line: string): MonitoringRunSummary | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const rec = parsed as Record<string, unknown>;
  if (typeof rec.runId !== "string" || typeof rec.sessionId !== "string") return undefined;
  if (typeof rec.status !== "string") return undefined;
  if (typeof rec.startedAt !== "number" || typeof rec.durationMs !== "number") return undefined;
  if (!Array.isArray(rec.nodes)) return undefined;

  const nodes: MonitoringNodeSummary[] = [];
  for (const item of rec.nodes) {
    if (typeof item !== "object" || item === null) continue;
    const node = item as Record<string, unknown>;
    if (typeof node.nodeId !== "string" || typeof node.status !== "string") continue;
    nodes.push({
      nodeId: node.nodeId,
      // kind / error 缺了就给个说得过去的兜底 —— 旧数据不带它们也该读得回来
      kind: typeof node.kind === "string" ? node.kind : "",
      status: node.status,
      ...(typeof node.durationMs === "number" ? { durationMs: node.durationMs } : {}),
      ...(typeof node.error === "string" ? { error: node.error } : {}),
    });
  }

  return {
    runId: rec.runId,
    // 旧数据可能没记 workflowId(会话行当时查不到)—— 空字符串比 undefined 好比较
    workflowId: typeof rec.workflowId === "string" ? rec.workflowId : "",
    sessionId: rec.sessionId,
    status: rec.status,
    startedAt: rec.startedAt,
    durationMs: rec.durationMs,
    nodes,
    ...(typeof rec.endedAt === "number" ? { endedAt: rec.endedAt } : {}),
  };
}
