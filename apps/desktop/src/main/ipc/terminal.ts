/**
 * IPC handlers for the integrated terminal (create / write / resize / kill / list).
 *
 * Security: every create is scoped to a known project root. `cwd` must resolve
 * inside that root (defaults to the root itself). Write/resize/kill only accept
 * opaque terminalIds issued by us — no path trust issues there.
 *
 * Errors degrade to `{ ok: false, error }` rather than throwing into renderer.
 */
import type { IpcMain } from "electron";
import { resolve } from "node:path";
import {
  IPC,
  TerminalCreateSchema,
  TerminalWriteSchema,
  TerminalResizeSchema,
  TerminalKillSchema,
  TerminalListSchema,
  TERMINAL_SHELL_SETTING_KEY,
} from "@contracts/ipc";
import { isKnownWorkspaceRoot, pathWithin } from "@main/lib/pathGuard.js";
import { SettingRepo } from "@main/store/repositories.js";
import { TerminalManager } from "@main/terminal/TerminalManager.js";
import { log } from "@main/lib/logger.js";
import { z } from "zod";

/**
 * 把校验错翻译成**一行人话**。
 *
 * ⚠️ 不能直接把 `err.message` 交出去:zod 的 `ZodError.message` 是一整段 JSON 数组文本
 * (`[{"code":"too_small","minimum":1,…,"path":["projectPath"]}]`),而这一层的 error 会被
 * 渲染端原样写进 xterm(`TerminalView.tsx` 那句 `term.writeln(… ${result.error})`)。
 * 用户看到的就是一屏 JSON —— 那不是"报错说清楚了",那是把内部错误对象的形状漏了出去。
 *
 * 格式与本仓库既有的那处一致(`mcp/webToolHost.ts` 的 `describeIssues` 也是
 * `字段名: 那句话`,只是那边多个字段用 `;` 串起来 —— 这里给用户看第一句就够)。
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

export function registerTerminalHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.TERMINAL_CREATE, async (_evt, raw) => {
    try {
      const input = TerminalCreateSchema.parse(raw);
      const projectPath = resolve(input.projectPath);

      if (!isKnownWorkspaceRoot(projectPath)) {
        return { ok: false as const, error: "未知项目路径，拒绝创建终端" };
      }

      const cwd = resolve(input.cwd ?? projectPath);
      if (!pathWithin(projectPath, cwd)) {
        return { ok: false as const, error: "cwd 必须位于项目目录内" };
      }

      const shellSetting = SettingRepo.get(TERMINAL_SHELL_SETTING_KEY);

      return await TerminalManager.create({
        projectPath,
        cwd,
        cols: input.cols,
        rows: input.rows,
        shell: input.shell,
        shellSetting,
        // 谁开的。前端不传的时刻(老调用方、渲染端手点)**也必须留下一条来路** ——
        // 落到默认档是"用户手点的",见 `TerminalManager.create`。终端列表靠这个字段
        // 说人话,所以它不允许是空的。
        origin: input.origin,
      });
    } catch (err) {
      const msg = errText(err);
      log.error(`terminal.create failed: ${msg}`);
      return { ok: false as const, error: msg };
    }
  });

  ipcMain.handle(IPC.TERMINAL_WRITE, async (_evt, raw) => {
    try {
      const input = TerminalWriteSchema.parse(raw);
      const ok = TerminalManager.write(input.terminalId, input.data);
      return ok ? { ok: true as const } : { ok: false as const, error: "终端不存在或已退出" };
    } catch (err) {
      const msg = errText(err);
      return { ok: false as const, error: msg };
    }
  });

  ipcMain.handle(IPC.TERMINAL_RESIZE, async (_evt, raw) => {
    try {
      const input = TerminalResizeSchema.parse(raw);
      const ok = TerminalManager.resize(input.terminalId, input.cols, input.rows);
      return ok ? { ok: true as const } : { ok: false as const, error: "终端不存在或已退出" };
    } catch (err) {
      const msg = errText(err);
      return { ok: false as const, error: msg };
    }
  });

  ipcMain.handle(IPC.TERMINAL_KILL, async (_evt, raw) => {
    try {
      const input = TerminalKillSchema.parse(raw);
      // **关一个已经不在的终端仍是成功。** 这是刻意的:用户连点两下「关闭」、
      // 或者一条终端刚自己退出了又被点了一次 —— 从界面那侧看,结果就是"它没了",
      // 和成功关掉一模一样(`TaskListPanel.killTerminal` 见 ok 就 return,不弹错)。
      //
      // ⚠️ **所以这里不能挂 `error`。** 从前回的是 `{ok:true, error:"终端不存在或已退出"}`
      // —— 自相矛盾:`error` 在 `TerminalOpResult` 里只在 `ok:false` 时有意义,而这个
      // 形状两边都用不对(见 ok 就成功,那句原因永远不会显示;若谁改成"见 error 即失败",
      // 又会在真正成功时报一句假错)。这一档的真正含义是"它已经不在了",用 ok 表达即可。
      TerminalManager.kill(input.terminalId);
      return { ok: true as const };
    } catch (err) {
      const msg = errText(err);
      return { ok: false as const, error: msg };
    }
  });

  ipcMain.handle(IPC.TERMINAL_LIST, async (_evt, raw) => {
    try {
      const input = TerminalListSchema.parse(raw ?? {});
      const projectPath = input.projectPath ? resolve(input.projectPath) : undefined;
      return { terminals: TerminalManager.list(projectPath, input.bufferFor) };
    } catch (err) {
      log.warn(`terminal.list failed: ${errText(err)}`);
      return { terminals: [] };
    }
  });
}
