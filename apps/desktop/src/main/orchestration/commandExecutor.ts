import type { NodeOutcome } from "@contracts/nodeType";
import { runCommandNode } from "./commandRunner.js";
import { runEntryScript } from "./entryRunner.js";
import type { ExecutionContext } from "./executionContext.js";
import type { NodeExecutor } from "./executorRegistry.js";

/**
 * 内置执行器:命令节点。
 *
 * ## 它管**两种**命令,靠 `runner.entry` 分
 *
 * | | 命令来自 | 相对谁 | 走 shell |
 * |---|---|---|---|
 * | `entry` 缺省(内置 `mcode.command`) | 节点参数 | 工作目录 | 是 |
 * | `entry` 填了(第三方插件自带脚本) | 清单自带 | **清单目录** | 否 |
 *
 * 两种都注册在同一个 `kind` 下,因为对**调度器**来说它们是同一件事("跑一条命令")——
 * 分派链一条 `kind ===` 分支都不用加(见 `executorRegistry.ts` 的规矩)。分流在这里,
 * 判据是清单里那个可有可无的 `entry`。
 *
 * 为什么第三方那种不走 shell、为什么脚本的 cwd 是清单目录 —— 见 `entryRunner.ts` 的头注。
 */
export class CommandExecutor implements NodeExecutor {
  readonly kind = "command";

  execute({ input, manifest, cwd, manifestDir, emitProgress }: ExecutionContext): Promise<NodeOutcome> {
    // **清单自带脚本那一支。** 判据只看 `entry` 在不在 —— 它在就说明命令不是用户
    // 在图里写的,而是插件随包发的,解析基准也随之改成清单目录。
    const entry = manifest.runner.kind === "command" ? manifest.runner.entry : undefined;
    if (entry !== undefined) {
      return runEntryScript({
        script: entry,
        ...(manifestDir !== undefined ? { manifestDir } : {}),
        ...(manifest.runner.kind === "command" && manifest.runner.interpreter !== undefined
          ? { interpreter: manifest.runner.interpreter }
          : {}),
        ...(manifest.runner.kind === "command" && manifest.runner.args !== undefined
          ? { args: manifest.runner.args }
          : {}),
        ...(input.command?.input !== undefined ? { input: input.command.input } : {}),
        timeoutMs: input.command?.timeoutMs ?? 0,
        cwd,
        signal: input.signal,
        ...(emitProgress !== undefined ? { onProgress: emitProgress } : {}),
      });
    }

    if (!input.command) {
      return Promise.resolve({
        status: "failed",
        summary: "",
        error: "Command node is missing execution config",
      });
    }
    return runCommandNode({
      ...input.command,
      cwd,
      signal: input.signal,
      onProgress: emitProgress,
    });
  }
}
