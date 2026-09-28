import type { NodeOutcome } from "@contracts/nodeType";
import { runCodeNode } from "./codeRunner.js";
import { applyHostActions } from "./adoptFromCode.js";
import type { ExecutionContext } from "./executionContext.js";
import type { NodeExecutor } from "./executorRegistry.js";

/** Built-in executor for Python/Node/shell code workflow nodes. */
export class CodeExecutor implements NodeExecutor {
  readonly kind = "code";

  async execute({ input, cwd, emitProgress }: ExecutionContext): Promise<NodeOutcome> {
    if (!input.code) {
      return {
        status: "failed",
        summary: "",
        error: "Code node is missing execution config",
      };
    }
    const outcome = await runCodeNode({
      ...input.code,
      cwd,
      signal: input.signal,
      onProgress: emitProgress,
    });
    // 脚本在产出里报了「收这些文件进库」/「这几条要挂回」就照办 —— 没报就原样返回。
    // 为什么写库不能由脚本自己做,见 `adoptFromCode.ts` 的文件头。
    return applyHostActions(outcome);
  }
}
