/**
 * 文档工具链的 IPC handler(设置 → 内核 里新加的那一块)。
 *
 * 检测那三个工具状态在 `env/toolchain.ts`,装/卸在 `env/toolInstall.ts` —— 这里
 * 只做三件事:校验入参、调过去、把**运行态**(正在装 / 上次报错)贴到检测结果上。
 *
 * 为什么运行态不在检测结果里:`checkToolchain` 是"这台机器有什么"的快照,而
 * "正在装"是这次会话的过程状态。混进检测模块会让那个模块必须知道安装器,而
 * 反过来依赖才顺(安装器已经依赖检测器了)。
 *
 * ## 入参校验失败时交出去的是**人话**,不是 zod 的 JSON
 *
 * 这个面板把 handler 交回来的 `error` 原样贴在行上(`ToolchainSection.tsx` 的
 * `setActionError(res.error ?? …)`)。而 `ZodError.message` 是一整段 JSON 数组文本
 * (`[{"code":"invalid_enum_value","options":[…],"path":["tool"],…}]`)—— 直接交出去
 * 就是把内部错误对象的形状漏给用户。所以下面所有 `parse` 都包在同一个 `errText()`
 * 里(`ipc/terminal.ts` 是同一处收口的原生版;两个文件各有一份是因为它只在这个
 * 域的边界上用,抽成模块要动别的文件)。
 */
import type { IpcMain } from "electron";
import { z } from "zod";
import { IPC, ToolchainInstallSchema, ToolchainRemoveSchema } from "@contracts/ipc";
import { checkToolchain } from "@main/env/toolchain.js";
import { installTool, isToolInstalling, lastToolError, removeTool } from "@main/env/toolInstall.js";

/**
 * 把校验错翻译成**一行人话**:`字段名: 那句话`。
 *
 * ⚠️ 不能直接把 `err.message` 交出去:zod 的 `ZodError.message` 是一整段 JSON 数组
 * 文本,而这一层的 error 会被面板原样写进那一行。格式与 `ipc/terminal.ts` 那处一致
 * (`mcp/webToolHost.ts` 的 `describeIssues` 也是 `字段名: 那句话`,只是那边多个字段
 * 用 `;` 串起来 —— 这里给用户看第一句就够)。
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

export function registerToolchainHandlers(ipcMain: IpcMain): void {
  // **无参 handler 不接 raw、也不 parse** —— 与 runtimes.list 同一个写法。
  // 这里曾经写过 `ToolchainCheckSchema.parse(raw)`,结果面板一打开就报
  // `invalid_type … received "undefined"`:不带参数 invoke 时 handler 收到的
  // 就是 undefined,而 `z.object({})` 不接受它。空 schema 的用处只是给
  // RpcMap 那条签名一个输入类型,不是拿来在运行时校验"没有参数"的。
  //
  // (那个 schema 后来连定义一起删了 —— 名字只活在这段注释里。)
  ipcMain.handle(IPC.TOOLCHAIN_CHECK, async () => {
    const tools = await checkToolchain();
    return {
      tools: tools.map((tool) => ({
        ...tool,
        installing: isToolInstalling(tool.id),
        lastError: lastToolError(tool.id),
      })),
    };
  });

  ipcMain.handle(IPC.TOOLCHAIN_INSTALL, async (_evt, raw) => {
    try {
      const input = ToolchainInstallSchema.parse(raw);
      return await installTool(input.tool);
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  });

  ipcMain.handle(IPC.TOOLCHAIN_REMOVE, async (_evt, raw) => {
    try {
      const input = ToolchainRemoveSchema.parse(raw);
      return await removeTool(input.tool);
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  });
}
