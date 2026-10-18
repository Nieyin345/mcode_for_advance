/**
 * Hook 运行审计 —— hook_runs 表。
 *
 * 从 `repositories.ts`（3277 行、13 张表挤在一起）按实体拆出。
 * 本文件只管这一张表；**正文是整段搬过来的，没有改写**。
 */
import { getDb, persist } from "../db.js";
import { v } from "../sessionSchema.js";
import { withStatement } from "./withStatement.js";

/* ───────────────────── 插件 hook 执行审计(MC-061)───────────────────── */

/**
 * 【MC-061 审计轮转】`hook_runs` 的**有界保留上限**。每次落一条就轮转一次,只留最近的
 * 这么多行(见 {@link HookRunRepo.prune})。取 500:足够回答"最近这条插件 hook 跑成没有 /
 * 被挡下几次"(排错窗口),又不至于让一条高频插件 hook 把库撑大。
 *
 * ⚠️ 这是**持久审计表**的上限,与 `HookRunner` 那 50 条**内存环**(`RUN_RING`)是两份不同的
 * 东西:环是"这次会话里最近发生了什么"、会被进程重启清掉;本表跨重启活着。ARC-007 明确
 * 禁止的是"把 RUN_RING 从 50 改到 5000"(拿内存环当账本)—— 这里不是那条。
 */
export const HOOK_RUNS_RETAIN = 500;

/**
 * `hook_runs` 表里的一行 —— 一次**钩子执行事实**(审计)。
 *
 * ## 【MC-010】为什么用户手写的钩子也落这一行
 *
 * 从前的判据是「**是不是插件来源**」:只有带插件来源身份的执行进这张表,用户手写的
 * 钩子不进(MC-061 的写放大理由)。但那条判据让「文件保存时跑 eslint」这类用户钩子
 * 的失败**只活在 50 条内存环里** —— 进程一重启就查不到「它到底跑没跑」,恰是最需要
 * 「跑了没、成没成」可见的一类(README 硬规矩 3)。
 *
 * 【MC-010】把判据与来源**解耦**:记不记的判据是「**这是一次真实执行**(真起过进程
 * 或被明确挡下)」;来源身份降为**一列** `source`(`plugin | user`),不决定记不记。
 * 插件行的来源投影列(`plugin_id` / `native_event` / `command_digest`)照旧;用户行
 * 填 `"user"` / 事件名 / 命令摘要,这些是**列不是判据**。
 *
 * ## 没有 payload 列
 *
 * 与 `workflow_runs` / `scene_deployments` 不同 —— 那边要原样保留一个嵌套形状(整条
 * `RunSnapshot` / `SceneDeployment`),所以给一列 `payload`。审计行没有要保留的嵌套形状:
 * 来源身份(插件 / 版本 / 命令摘要 / 原生事件 / matcher 摘要,见 `@contracts/hostHookGrant`
 * 的 `HostHookSource`)与结局都摊成一排**可查询的列**,stdout/stderr **不进这一层**(输出
 * 可达上限那么大,审计要的是「跑没跑、为什么」,不是完整输出)。
 *
 * `run_id` 是主键:先落 `running`、落定再覆盖终态,是靠一次 upsert 完成的(不是两次 INSERT)。
 */
export interface HookRunRow {
  runId: string;
  hookId: string;
  /** 【MC-010】这次执行的**来源** —— `plugin`(不受信来源,经授权驱动)或
   *  `user`(用户手写在 hooks.json 里)。是**一列事实**,不是落不落的判据。 */
  source: "plugin" | "user";
  /** 贡献这条 hook 的插件名(`HostHookSource.pluginId`)。用户手写的钩子填 `"user"`。 */
  pluginId: string;
  /** 插件版本;未声明为 null(授权不限版本的语义与之一致)。用户钩子为 null。 */
  pluginVersion: string | null;
  /** 原生事件名(如 `PreToolUse`)。 */
  nativeEvent: string;
  /** 命令内容摘要(改命令 = 新来源,旧授权作废)。 */
  commandDigest: string;
  /** matcher 摘要;未声明 matcher 为 null(不绑定)。 */
  matcherDigest: string | null;
  /** 统一 HookEvent(映射后的)。 */
  event: string;
  sessionId: string;
  sessionKind: string;
  /** running | ok | failed | timeout | skipped。 */
  status: string;
  exitCode: number | null;
  durationMs: number | null;
  /** 跳过 / 失败的**原因**(含授权拒绝的理由)。 */
  error: string | null;
  startedAt: number;
}

interface HookRunDbRow {
  run_id: string;
  hook_id: string;
  source: string;
  plugin_id: string;
  plugin_version: string | null;
  native_event: string;
  command_digest: string;
  matcher_digest: string | null;
  event: string;
  session_id: string;
  session_kind: string;
  status: string;
  exit_code: number | null;
  duration_ms: number | null;
  error: string | null;
  started_at: number;
}

function rowToHookRun(r: HookRunDbRow): HookRunRow {
  return {
    runId: r.run_id,
    hookId: r.hook_id,
    // 老库迁移来的行 `source` 为空串(ALTER 补列)→ 按插件来源读(那是唯一的旧语义)。
    source: r.source === "user" ? "user" : "plugin",
    pluginId: r.plugin_id,
    pluginVersion: r.plugin_version,
    nativeEvent: r.native_event,
    commandDigest: r.command_digest,
    matcherDigest: r.matcher_digest,
    event: r.event,
    sessionId: r.session_id,
    sessionKind: r.session_kind,
    status: r.status,
    exitCode: r.exit_code,
    durationMs: r.duration_ms,
    error: r.error,
    startedAt: r.started_at,
  };
}

export const HookRunRepo = {
  /**
   * 落 / 覆盖一条执行审计行(`run_id` 主键 upsert)。
   *
   * 先落 `running`,命令收口后**用同一个 `runId` 再写一次**把终态(`ok` / `failed` /
   * `timeout`)+ 退出码 / 耗时 / 原因覆盖上去 —— 于是"这一条到底跑成没有"只有**一行**、
   * 一个答案(与 `WorkflowRunRepo.save` 的 upsert 同形状)。来源身份列不参与覆盖:同一次
   * 执行的来源不会中途变(命令摘要绑定,变了就是另一个 `hookId`,另一个 `runId`)。
   *
   * ⚠️ 每次落一条就**轮转一次**(见 {@link prune}):审计是有界保留的,不是无限账本 ——
   * 一条挂在 `tool.use` 上的插件 hook 一轮就能落几十行,不设上限迟早把库撑爆。轮转只丢
   * **最旧**的,保住"最近发生过什么"这个排错窗口。
   */
  record(row: HookRunRow): void {
    getDb().run(
      `INSERT INTO hook_runs
         (run_id, hook_id, source, plugin_id, plugin_version, native_event, command_digest,
          matcher_digest, event, session_id, session_kind, status, exit_code,
          duration_ms, error, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET
         status       = excluded.status,
         exit_code    = excluded.exit_code,
         duration_ms  = excluded.duration_ms,
         error        = excluded.error`,
      [
        v(row.runId),
        v(row.hookId),
        v(row.source),
        v(row.pluginId),
        v(row.pluginVersion),
        v(row.nativeEvent),
        v(row.commandDigest),
        v(row.matcherDigest),
        v(row.event),
        v(row.sessionId),
        v(row.sessionKind),
        v(row.status),
        v(row.exitCode),
        v(row.durationMs),
        v(row.error),
        v(row.startedAt),
      ],
    );
    this.prune(HOOK_RUNS_RETAIN);
    persist();
  },

  /**
   * 【MC-061 审计轮转】**有界保留**:只在表里留下最近的 `retain` 行,更旧的丢掉。
   *
   * 与 `WorkflowRunRepo.pruneSession` 同一条纪律(丢**最旧**的、`run_id` 作并列决胜),
   * 只是这里没有"按会话"那一维 —— 审计窗口是整个插件 hook 执行历史。返回这次删掉几行
   * (可断言"轮转真的发生了")。
   *
   * ⚠️ 不是"把环从 50 改大"那条被禁的做法:本函数管的是**持久审计表**的有界保留,不碰
   * `HookRunner` 那 50 条内存环(那是另一份、语义不同的东西 —— 见 `HookRunner.RUN_RING`)。
   */
  prune(retain: number): number {
    const keep = retain > 0 ? retain : 0;
    const before = getDb().exec("SELECT COUNT(*) FROM hook_runs")[0]?.values[0]?.[0] as number | undefined;
    getDb().run(
      `DELETE FROM hook_runs
        WHERE run_id NOT IN (
          SELECT run_id FROM hook_runs
           ORDER BY started_at DESC, run_id DESC LIMIT ?
        )`,
      [v(keep)],
    );
    const after = getDb().exec("SELECT COUNT(*) FROM hook_runs")[0]?.values[0]?.[0] as number | undefined;
    return Math.max(0, (before ?? 0) - (after ?? 0));
  },

  /** 一条执行审计行。没有返回 null。 */
  get(runId: string): HookRunRow | null {
    const stmt = getDb().prepare("SELECT * FROM hook_runs WHERE run_id = ?");
    return withStatement(stmt, (query) => {
      query.bind([v(runId)]);
      const found = query.step();
      const row = found ? (query.getAsObject() as unknown as HookRunDbRow) : null;
      return row ? rowToHookRun(row) : null;
    });
  },

  /** 某条 hook 的执行历史,**两种来源都含**(MC-010 起),新的在前 ——
   *  跨重启可回读(环只有 50 条、会被顶掉)。 */
  listForHook(hookId: string, limit: number): HookRunRow[] {
    const stmt = getDb().prepare(
      `SELECT * FROM hook_runs
        WHERE hook_id = ?
        ORDER BY started_at DESC, run_id DESC LIMIT ?`,
    );
    return withStatement(stmt, (query) => {
      query.bind([v(hookId), v(limit)]);
      const out: HookRunRow[] = [];
      while (query.step()) out.push(rowToHookRun(query.getAsObject() as unknown as HookRunDbRow));
      return out;
    });
  },

  /** 全部执行审计行,新的在前。 */
  list(limit: number): HookRunRow[] {
    const stmt = getDb().prepare(
      "SELECT * FROM hook_runs ORDER BY started_at DESC, run_id DESC LIMIT ?",
    );
    return withStatement(stmt, (query) => {
      query.bind([v(limit)]);
      const out: HookRunRow[] = [];
      while (query.step()) out.push(rowToHookRun(query.getAsObject() as unknown as HookRunDbRow));
      return out;
    });
  },

  /** 删一条(没有也不算错)—— 回滚 / 人工清理用。 */
  remove(runId: string): void {
    getDb().run("DELETE FROM hook_runs WHERE run_id = ?", [v(runId)]);
    persist();
  },
};
