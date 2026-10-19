import type { NodeOutcome, NodeParamBinding, NodeTypeManifest } from "@contracts/nodeType";
import { runCommandNode } from "./commandRunner.js";
import { runEntryScript } from "./entryRunner.js";
import type { ExecutionContext } from "./executionContext.js";
import type { NodeExecutor } from "./executorRegistry.js";

/**
 * 清单声明了 `bind` 的参数按**声明顺序**排好 —— 位置参数(`flag` 省略)的追加顺序
 * 由它决定。值来自执行器拿到的 `input.command.boundParams`(解算后的那一份),不是
 * 存盘原值 —— 见 `nodeInputBuilders.ts` 的 `boundParamsOf`。
 *
 * 没声明 bind 的参数一个都不收:混进来等于凭空多一个 argv/env。
 */
export function bindingsOf(
  manifest: NodeTypeManifest,
  boundParams: Record<string, unknown> | undefined,
): Array<{ binding: NodeParamBinding; value: unknown }> {
  const out: Array<{ binding: NodeParamBinding; value: unknown }> = [];
  for (const spec of manifest.params) {
    if (spec.bind === undefined) continue;
    // Runtime caller can supply a forged prototype independently of the
    // input builder. Only own bound JSON fields may become argv/env/stdin.
    if (boundParams === undefined || !Object.hasOwn(boundParams, spec.key)) continue;
    out.push({ binding: spec.bind, value: boundParams[spec.key] });
  }
  return out;
}

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
    const bindings = bindingsOf(manifest, input.command?.boundParams);
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
        ...(bindings.length > 0 ? { bindings } : {}),
        ...(input.command?.input !== undefined ? { input: input.command.input } : {}),
        timeoutMs: input.command?.timeoutMs ?? 0,
        cwd,
        signal: input.signal,
        ...(emitProgress !== undefined ? { onProgress: emitProgress } : {}),
      });
    }

    // **命令来自参数的那种形状没有 argv 数组可绑。** 它的命令是一整条 shell 文本
    // (用户画图时自己拼的),`bind` 在这里没有落点 —— 而**静默忽略**正是这类通道最
    // 坏的失败方式:插件作者按 README 在清单里写了 `bind`,运行时一声不吭地把值扔掉,
    // 脚本拿到空参数,表现为"插件坏了"。所以显式拒绝,并说清该往哪边改。
    if (manifest.params.some((p) => p.bind !== undefined)) {
      return Promise.resolve({
        status: "failed",
        summary: "",
        error:
          "这个节点类型给参数声明了 bind,但它的命令写在节点参数里(没有 runner.entry)。" +
          "bind 只对清单自带脚本的 command 节点生效 —— 把命令做成 entry 脚本," +
          "或者在命令文本里用变量语法取值。",
      });
    }

    if (!input.command) {
      return Promise.resolve({
        status: "failed",
        summary: "",
        // 用户可见(失败节点卡片上的那行字)。与 `commandRunner` 里「命令节点没有填要跑的
        // 命令」同一件事、同一说法 —— 别一处中文一处英文。
        error: "命令节点没有填要跑的命令",
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
