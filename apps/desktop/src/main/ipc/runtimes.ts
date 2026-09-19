/**
 * IPC handlers for the settings panel's "Agent Runtimes" section.
 *
 * Three download-on-demand runtimes (claude / codex / pi) — see
 * main/runtimes/runtimeInstaller.ts for the install pipeline. list() is a
 * snapshot (expected vs installed vs registry-latest); install() runs the
 * full download→verify→extract pipeline and resolves when done, streaming
 * coarse progress over the `runtimes:event` push channel; remove() deletes
 * the installed copy.
 *
 * remove() is rejected while ANY turn is running: the runtime binary the
 * turn is executing (or about to spawn) would vanish mid-flight. The guard
 * is intentionally conservative (any session, not per-agent) — removing a
 * ~300MB runtime is rare enough that a "stop your turns first" hint is
 * cheaper than per-provider mapping.
 *
 * ## Errors here are shown verbatim, so they are written for the user
 *
 * `removeFailed` puts this layer's `error` into the panel's `{error}` slot, so
 * it lands on screen as-is — see `RuntimesPanel.tsx`'s `doRemove`. That makes
 * two things non-optional: (1) the guard's sentence has to be plain Chinese,
 * not the `N session(s) still have a running turn` jargon it used to be (its
 * sibling guard in ipc/plugins.ts was already Chinese), and (2) a schema
 * failure must NOT hand out `ZodError.message`, which is a JSON array dump of
 * the internal issue objects. @see errText below.
 */
import type { IpcMain } from "electron";
import { z } from "zod";
import {
  IPC,
  RuntimesInstallSchema,
  RuntimesInstallLocalSchema,
  RuntimesRemoveSchema,
} from "@contracts/ipc";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import {
  listRuntimes,
  installRuntime,
  installRuntimeFromLocalPath,
  removeRuntime,
} from "@main/runtimes/runtimeInstaller.js";

/**
 * 把校验错翻译成**一行人话**。
 *
 * ⚠️ 不能直接把 `err.message` 交出去:zod 的 `ZodError.message` 是一整段 JSON 数组文本
 * (`[{"code":"invalid_enum_value","options":[…],"path":["agent"],…}]`),而这一层的
 * `error` 会被面板原样写进 `settings.runtimes.removeFailed` 的 `{error}` 槽位。
 * 用户看到的就是一屏 JSON —— 那不是"报错说清楚了",那是把内部错误对象的形状漏了出去。
 *
 * 格式与 `ipc/terminal.ts` 那处一致(`字段名: 那句话`),那边也是同一个坑修出来的。
 * 措辞再往细里做(把 zod 自带的英文 message 翻成中文)要按 `issue.code` 映射一张表,
 * 那是整个 `main/ipc/` 的收口,不该由这一个文件单独开头 —— 十几处各写一份不一致的
 * 比现在还糟。
 */
function describeInputError(err: z.ZodError): string {
  const first = err.issues[0];
  const where = first && first.path.length > 0 ? `${first.path.join(".")}: ` : "";
  return `入参不合法(${where}${first?.message ?? "没通过校验"})`;
}

/** catch 里唯一的出口 —— zod 走人话,别的照原样(那些 message 本来就是人写的)。 */
function errText(err: unknown): string {
  if (err instanceof z.ZodError) return describeInputError(err);
  return err instanceof Error ? err.message : String(err);
}

export function registerRuntimesHandlers(ipcMain: IpcMain): void {
  // list takes no input (mirrors lsp.list) — nothing to parse.
  ipcMain.handle(IPC.RUNTIMES_LIST, async () => {
    return { runtimes: await listRuntimes() };
  });

  ipcMain.handle(IPC.RUNTIMES_INSTALL, async (_evt, raw) => {
    try {
      const input = RuntimesInstallSchema.parse(raw);
      return await installRuntime(input.agent);
    } catch (err) {
      const msg = errText(err);
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle(IPC.RUNTIMES_INSTALL_LOCAL, async (_evt, raw) => {
    try {
      const input = RuntimesInstallLocalSchema.parse(raw);
      return await installRuntimeFromLocalPath(input.agent, input.localPath);
    } catch (err) {
      const msg = errText(err);
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle(IPC.RUNTIMES_REMOVE, async (_evt, raw) => {
    try {
      const input = RuntimesRemoveSchema.parse(raw);
      const running = runtimeManager.runningSessionIds();
      if (running.length > 0) {
        return {
          ok: false,
          error: `还有 ${running.length} 个会话正在跑回合——请先停掉它们再卸载这个内核`,
        };
      }
      return await removeRuntime(input.agent);
    } catch (err) {
      const msg = errText(err);
      return { ok: false, error: msg };
    }
  });
}
