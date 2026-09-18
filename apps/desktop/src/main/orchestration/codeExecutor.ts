import type { NodeOutcome } from "@contracts/nodeType";
import { runCodeNode } from "./codeRunner.js";
import type { ExecutionContext } from "./executionContext.js";
import type { NodeExecutor } from "./executorRegistry.js";

/** Built-in executor for Python/Node/shell code workflow nodes. */
export class CodeExecutor implements NodeExecutor {
  readonly kind = "code";

  execute({ input, cwd, emitProgress }: ExecutionContext): Promise<NodeOutcome> {
    if (!input.code) {
      return Promise.resolve({
        status: "failed",
        summary: "",
        error: "Code node is missing execution config",
      });
    }
    return runCodeNode({
      ...input.code,
      cwd,
      signal: input.signal,
      onProgress: emitProgress,
    });
  }
}
