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
  HooksRemoveSchema,
  HooksSaveSchema,
  HooksTestSchema,
  HostHookGrantListSchema,
  HostHookGrantIssueSchema,
  HostHookGrantRevokeSchema,
} from "@contracts/ipc";
import { hookRunner } from "@main/hooks/HookRunner.js";
import { readHooks, removeHook, saveHook } from "@main/hooks/store.js";
import {
  issueHostHookGrant,
  listHostHookGrants,
  revokeHostHookGrant,
} from "@main/hooks/hostHookGrants.js";

/**
 * 一份新签发主机 hook 授权的**有效期** —— 由宿主定,调用方给不了(`ttlMs` 不在 schema 里)。
 * 24 小时:既不是"一次会话"那么短(用户不想每开一次机就重签),也不是"永久"(撤权/过期这道
 * 纪律要真的有用武之地)。到期即回到**默认拒绝**,要点用就再签一次。
 */
const HOST_HOOK_GRANT_TTL_MS = 24 * 60 * 60 * 1000;

export function registerHookHandlers(ipcMain: IpcMain): void {
  // 无参 handler 不接 raw、也不 parse —— 与 `workflow.list` / `runtimes.list` 同一条
  // 纪律(无参 invoke 时 handler 收到的是 `undefined`)。
  ipcMain.handle(IPC.HOOKS_LIST, async () => readHooks());
  ipcMain.handle(IPC.HOOKS_RUNS, async () => ({ runs: hookRunner.listRuns() }));

  ipcMain.handle(IPC.HOOKS_SAVE, async (_evt, raw) => {
    const input = HooksSaveSchema.parse(raw);
    return saveHook(input.hook);
  });

  ipcMain.handle(IPC.HOOKS_REMOVE, async (_evt, raw) => {
    const input = HooksRemoveSchema.parse(raw);
    return removeHook(input.id);
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
    // 签发失败(fail-safe 落盘异常等)不吞:返回 `{ok:false}` 让界面显示"授权未生效"。
    try {
      const grant = issueHostHookGrant({
        pluginId: input.pluginId,
        ...(input.version !== undefined ? { version: input.version } : {}),
        ...(input.events !== undefined ? { events: input.events } : {}),
        ...(input.commandDigest !== undefined ? { commandDigest: input.commandDigest } : {}),
        ...(input.matcherDigest !== undefined ? { matcherDigest: input.matcherDigest } : {}),
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
