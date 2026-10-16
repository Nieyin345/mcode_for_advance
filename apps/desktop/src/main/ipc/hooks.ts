/**
 * 钩子的 IPC handler(设置 → 钩子)。
 *
 * 这一层很薄:**校验入参 → 调 `main/hooks/` → 返回**。匹配规则、超时、进程树、执行
 * 记录的语义都在那边,这里不重复实现 —— 同一套规则有两个地方会漂移,而漂移的后果是
 * "界面上说会跑,实际上没跑"。
 *
 * 两条与别处不同的地方:
 *
 * 1. **`hooks.test` 会真的执行一条命令**,而它给的是**还没存下来**的那一份配置
 *    (用户正是想在打开它之前看看会发生什么)。所以它不写盘,只跑一次、返回那一次的
 *    结果。它同样**不进执行记录环** —— 那个环的语义是"真的发生过什么"。
 * 2. **没有"事件推送"**。执行结果不进对话流(理由见 `@contracts/hook` 的 `HookRun`),
 *    设置页自己按需要来拉一次 `hooks.runs`。
 *
 * ## 3.【MC-061】主机 hook 授权(插件 hook 的签发入口)
 *
 * 插件携带的 hook 要**真正执行**,得先有一份主机 hook 授权(见 `@contracts/hostHookGrant`),
 * 而此前**没有任何宿主入口**能签发它 —— 于是「默认拒绝」事实上成了「永远拒绝」。这层加
 * 三条 RPC 补上那扇门:`hooks.listHostHookGrants` / `issueHostHookGrant` /
 * `revokeHostHookGrant`,分别接 `main/hooks/hostHookGrants.ts` 的列表 / 签发 / 撤销。
 *
 * ⚠️ **这三条是"用户点头"的落点,agent 够不到** —— `appControl/policy.ts` 把 issue /
 * revoke 钉死在 **blocked** 档(与 `workflow.approve` / `customModel.getToken` 同一条纪律:
 * agent 任何理由都不该签出/撤销它,故直接封路,不是"每次弹卡")。mobile 也没把它们放进
 * 白名单。真正够得到这两条的只有**桌面渲染端**(`window.api.hooks.*`)—— 设置页那颗按钮
 * = 用户动作。`ttlMs` / `grantId` / 时间 / `revoked` **都由这里签发**,调用方(schema
 * `.strict()`)给不了,于是"自签一份永不过期的授权"从契约层就断了。
 */
import type { IpcMain } from "electron";
import {
  IPC,
  HooksRebuildCorruptSchema,
  HooksRemoveSchema,
  HooksSaveSchema,
  HooksTestSchema,
  HostHookGrantListSchema,
  HostHookGrantIssueSchema,
  HostHookGrantRevokeSchema,
} from "@contracts/ipc";
import { hookRunner } from "@main/hooks/HookRunner.js";
import { log } from "@main/lib/logger.js";
import { classifyHooksFile, readHooks, rebuildCorruptHooksFile, removeHook, saveHook } from "@main/hooks/store.js";
import { HookRunRepo, type HookRunRow } from "@main/store/repositories.js";
import {
  hostHookCommandDigest,
  issueHostHookGrant,
  listHostHookGrants,
  revokeHostHookGrant,
} from "@main/hooks/hostHookGrants.js";

/**
 * 【MC-061】审计读取一次给多少条。审计表有界保留 {@link HOOK_RUNS_RETAIN}(500),这里取
 * 100 —— 界面那栏是"最近发生了什么"的窗口,不是把整张账本灌给渲染端。新的在前。
 */
const HOOK_RUNS_READ_LIMIT = 100;

/**
 * 读**最近的钩子执行审计**(落盘,跨重启活着)。读盘失败**不抛** —— 审计是附加信息,
 * 坏了不该让整个「钩子」设置页打不开(与 `HookRunner.auditRun` 落盘失败只留日志同一姿势)。
 * `HookRunRow` 与契约的 `HookAuditEntry` 结构逐一对应,直接透传。
 *
 * 【MC-010 第四轮复审】从前这里 `catch { return [] }` —— 「确实一次都没执行」与「审计
 * 数据库读不出来」在界面上长得一模一样。现在把失败**如实带出去**(`auditError` 列),
 * 面板据此把空审计栏换成显式的错误提示(README 硬规矩 3:坏东西显式报出来)。
 */
function readHookAudit(limit: number): { rows: HookRunRow[]; error: string | null } {
  try {
    return { rows: HookRunRepo.list(limit), error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`[hooks] 审计读取失败:${message}`);
    return { rows: [], error: message };
  }
}

/**
 * 一份新签发主机 hook 授权的**有效期** —— 由宿主定,调用方给不了(`ttlMs` 不在 schema 里)。
 * 24 小时:既不是"一次会话"那么短(用户不想每开一次机就重签),也不是"永久"(撤权/过期这道
 * 纪律要真的有用武之地)。到期即回到**默认拒绝**,要点用就再签一次。
 */
const HOST_HOOK_GRANT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 【MC-061 执行预算】一份主机 hook 授权最多允许**真执行**多少次 —— 由**宿主**定,调用方给不了
 * (`maxRuns` 不在 schema 里,与 `ttlMs` 同一条纪律:调用方不该能签出"无限次"的授权)。
 *
 * 这是台账 MC-061 点名的「**取消预算 (cancellation budget)**」在宿主 hook 执行上的落点:
 * 一条挂在 `tool.use` 上的插件 hook 一轮能触发几十次,`ttlMs` 只限时间、不限次数 —— 没有
 * 次数上限,"一次授信"就等价于"24 小时内无限次执行不受信命令"。`decideHostHookExecution`
 * 按它判 `exhausted`(与 ARC-004 的 `Grant.maxCount` 共用 `countBudgetExhausted` 那一份实现):
 * 用尽后该来源回到**默认拒绝**,必须重新授权(重签得一份新的、账从 0 起)。
 *
 * 取 1000:足够覆盖正常的长期使用(一轮几十次 × 一天若干轮),又是**有限**的一个数 ——
 * 用尽即停、需用户重新点头,而不是无声地无限跑下去。
 */
const HOST_HOOK_GRANT_MAX_RUNS = 1000;

export function registerHookHandlers(ipcMain: IpcMain): void {
  // 无参 handler 不接 raw、也不 parse —— 与 `workflow.list` / `runtimes.list` 同一条
  // 纪律(无参 invoke 时 handler 收到的是 `undefined`)。
  // 【MC-051】`hooks.list` 连**文件健康态**一并给出 —— 面板据此区分「个别条目坏」(problems
  // 非空)与「整份文件损坏」(corrupt/read_error,此时任一普通保存都会被拒,该出「备份并重建」
  // 按钮)。两者都读不懂条目,但用户要做的事完全不同。
  ipcMain.handle(IPC.HOOKS_LIST, async () => {
    const file = readHooks();
    const health = classifyHooksFile();
    return { ...file, fileHealth: health.state };
  });
  // 【MC-061】执行记录两栏:**内存环**(`runs`,含用户手写钩子、会被顶掉)+ **落盘审计**
  // (`audit`,跨重启活着;MC-010 起两种来源都落)。审计读取读盘失败**不该**让这页打不开
  // —— 环那一栏是用户的排错窗口,审计是附加信息;但失败要**如实带出去**(`auditError`),
  // 让面板能把空审计栏换成显式错误,而不是让「一次没执行」和「读不出来」长得一样。
  ipcMain.handle(IPC.HOOKS_RUNS, async () => {
    const audit = readHookAudit(HOOK_RUNS_READ_LIMIT);
    return { runs: hookRunner.listRuns(), audit: audit.rows, auditError: audit.error };
  });

  ipcMain.handle(IPC.HOOKS_SAVE, async (_evt, raw) => {
    const input = HooksSaveSchema.parse(raw);
    return saveHook(input.hook);
  });

  ipcMain.handle(IPC.HOOKS_REMOVE, async (_evt, raw) => {
    const input = HooksRemoveSchema.parse(raw);
    return removeHook(input.id);
  });

  // 【MC-051】损坏文件的**显式重建** —— 普通 save/remove 在整份损坏时拒绝(保住原字节),
  // 这一条是唯一能吃下损坏状态的入口:备份原件 → 校验 sha256 → 才重建。用户必须**明确
  // 点**这个动作(不是保存时顺手替他做)。
  ipcMain.handle(IPC.HOOKS_REBUILD_CORRUPT, async (_evt, raw) => {
    const input = HooksRebuildCorruptSchema.parse(raw);
    return rebuildCorruptHooksFile(input.hooks ?? []);
  });

  ipcMain.handle(IPC.HOOKS_TEST, async (_evt, raw) => {
    const input = HooksTestSchema.parse(raw);
    return { run: await hookRunner.test(input.hook) };
  });

  // ── 【MC-061】主机 hook 授权:列表 / 签发 / 撤销 ──
  // 三条都在**桌面渲染端**这条路上(agent 被 policy 钉在 blocked,够不到这里)。
  ipcMain.handle(IPC.HOOKS_HOST_HOOK_GRANTS_LIST, async (_evt, raw) => {
    HostHookGrantListSchema.parse(raw ?? {});
    return { grants: listHostHookGrants() };
  });

  ipcMain.handle(IPC.HOOKS_HOST_HOOK_GRANT_ISSUE, async (_evt, raw) => {
    const input = HostHookGrantIssueSchema.parse(raw);
    // `ttlMs` / `now` 由**宿主**给 —— 不是从 input 读(schema 里根本没有这两个字段)。
    // 摘要也由**宿主**算:调用方给的是命令/matcher **原文**(渲染端算不了 sha256),
    // 走**唯一一份** `hostHookCommandDigest` —— 与面板、执行通道同一份来源身份。
    const commandDigest =
      input.command !== undefined
        ? hostHookCommandDigest(input.command)
        : input.commandDigest;
    const matcherDigest =
      input.matcher !== undefined
        ? (input.matcher === "" ? "" : hostHookCommandDigest(input.matcher))
        : input.matcherDigest;
    // 签发失败(fail-safe 落盘异常等)不吞:返回 `{ok:false}` 让界面显示"授权未生效"。
    try {
      const grant = issueHostHookGrant({
        pluginId: input.pluginId,
        ...(input.version !== undefined ? { version: input.version } : {}),
        ...(input.events !== undefined ? { events: input.events } : {}),
        ...(commandDigest !== undefined ? { commandDigest } : {}),
        ...(matcherDigest !== undefined ? { matcherDigest } : {}),
        // 【MC-061 执行预算】次数上限由**宿主**盖(调用方给不了)—— 见常量那段。
        maxRuns: HOST_HOOK_GRANT_MAX_RUNS,
        ttlMs: HOST_HOOK_GRANT_TTL_MS,
        now: Date.now(),
      });
      return { ok: true, grant };
    } catch (err) {
      return { ok: false, error: `签发失败:${err instanceof Error ? err.message : String(err)}` };
    }
  });

  ipcMain.handle(IPC.HOOKS_HOST_HOOK_GRANT_REVOKE, async (_evt, raw) => {
    const input = HostHookGrantRevokeSchema.parse(raw);
    // 幂等:已撤销 / 找不到都算"想要的结局已经在了"(与 `hooks.remove` 同一条纪律)——
    // 撤销这份授权后,匹配它的那条插件 hook 立刻回到**默认拒绝**(判定每条事件现算)。
    revokeHostHookGrant(input.grantId);
    return { ok: true };
  });
}
