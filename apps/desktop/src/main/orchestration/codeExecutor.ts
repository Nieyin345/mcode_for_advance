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
        // 用户可见(失败节点卡片上的那行字)—— 与 `codeRunner` 里同一件事的说法一致
        // (`代码节点没有填写代码`)。仓库对「画在卡片上的失败原因」一律用中文;这两处
        // 判据相同、说法必须同源,别一处中文一处英文。
        error: "代码节点没有填写代码",
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
