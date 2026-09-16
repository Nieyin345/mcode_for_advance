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
 */
import type { IpcMain } from "electron";
import { IPC, HooksRemoveSchema, HooksSaveSchema, HooksTestSchema } from "@contracts/ipc";
import { hookRunner } from "@main/hooks/HookRunner.js";
import { readHooks, removeHook, saveHook } from "@main/hooks/store.js";

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
}
