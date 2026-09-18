import type { NodeOutcome } from "@contracts/nodeType";
import { runCommandNode } from "./commandRunner.js";
import type { ExecutionContext } from "./executionContext.js";
import type { NodeExecutor } from "./executorRegistry.js";

/** Built-in executor for shell/command workflow nodes. */
export class CommandExecutor implements NodeExecutor {
  readonly kind = "command";

  execute({ input, cwd, emitProgress }: ExecutionContext): Promise<NodeOutcome> {
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
