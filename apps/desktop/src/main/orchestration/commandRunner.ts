/**
 * 命令节点的执行器 —— 起一个进程,等它退出,把「退出码」和「输出尾部」交给下游。
 *
 * ## 为什么它不在 `runner.ts` 里
 *
 * `runner.ts` 是"节点会话"那一摊:建会话、绑运行时、订阅回合事件。命令节点**什么会话
 * 都不建** —— 它就是 `spawn` 一个进程然后等。塞进去只会让那边的分岔又多一层。它也
 * 不在调度器里:调度器管的是"什么时候轮到这一步",不管"这一步怎么跑"(跑的办法走
 * `RunPorts.execute` 进来,见 `scheduler.ts`)。
 *
 * ## 三条刻意的规矩(见内置清单 `mcode.command` 的 usage)
 *
 * 1. **非零退出码不算这一步失败。** 直跑的语义是"等它跑完",不是"断言它成功" ——
 *    训练脚本退出码 1,流程照样往下走,分流是下游那个"决定权给模型"的分支看
 *    「退出码」做的事。**spawn 失败**(命令根本没起来)才是失败。
 * 2. **输出只留尾部**(`COMMAND_OUTPUT_TAIL_CHARS`)。长任务动辄几万行日志,全量
 *    进产出变量是把下游的提示词往死里撑;错误栈和最后几行结果都在尾部。
 * 3. **超时和中止都要连子进程一起杀。** `shell: true` 起的是 shell,shell 死了它带的
 *    孙进程不一定死 —— 用户按了停止之后训练还在偷偷跑,是这类功能最招恨的翻车方式。
 *
 * 这三条**只管规矩,不管怎么实现**:起进程、杀树、超时、编码判定全在
 * `lib/spawnRun.ts`(与代码节点共用那一层)。这里只负责把它的结果翻译成节点语义 ——
 * 尤其是第 1 条,那条规矩在代码节点那边是相反的(非零即失败)。
 */

import { COMMAND_OUTPUT_TAIL_CHARS, commandOf } from "@contracts/nodeType";
import { NODE_STDOUT_PROTOCOL_PREFIX, type NodeArtifact, type NodeOutcome } from "@contracts/nodeType";
import { normalizeNodeArtifacts } from "./artifactRefs.js";
import { spawnRun, nativeAbortState, type SpawnFn } from "@main/lib/spawnRun.js";
import { markTruncatedTail } from "@main/lib/outBuf.js";
import { safeErrorMessage } from "@main/lib/ipcError.js";

export interface CommandProgress {
  percent?: number;
  message?: string;
}

interface ProtocolResult {
  summary?: string;
  outputs?: Record<string, unknown>;
  artifacts?: NodeArtifact[];
}
interface ProtocolState {
  result?: ProtocolResult;
  resultSeen?: boolean;
  error?: string;
}

/**
 * 认一行协议并消费掉它。返回 `true` = 这一行是协议行(不进输出尾部)。
 *
 * `@@mcode:progress` / `@@mcode:result` 的格式定义在 `@contracts/nodeType` ——
 * 第三方脚本按它上报进展与结构化产出,格式一变已经写好的脚本就全废,所以它先于
 * 消费者定死。
 */
function consumeProtocolLine(
  line: string,
  onProgress: ((progress: CommandProgress) => void) | undefined,
  state: ProtocolState,
): boolean {
  if (!line.startsWith(NODE_STDOUT_PROTOCOL_PREFIX)) return false;
  const match = line.match(/^@@mcode:(progress|result)\s+(.+)$/);
  if (!match) {
    if (line.startsWith("@@mcode:result")) state.error = "命令返回的结果协议格式错误";
    return true;
  }
  if (match[1] === "result") {
    if (state.resultSeen) {
      state.error = "命令返回了多条结果协议，拒绝以最后一条覆盖先前结果";
      return true;
    }
    state.resultSeen = true;
  }
  try {
    const payload = JSON.parse(match[2]) as unknown;
    if (match[1] === "progress" && payload && typeof payload === "object") {
      const value = payload as Record<string, unknown>;
      const progress: CommandProgress = {};
      // Percent is a UI percentage, not an arbitrary numeric telemetry
      // field. Ignore out-of-range values and never emit a phantom empty
      // progress event for malformed protocol payloads.
      if (typeof value.percent === "number" && Number.isFinite(value.percent) &&
          value.percent >= 0 && value.percent <= 100) progress.percent = value.percent;
      if (typeof value.message === "string" && value.message.length > 0) progress.message = value.message;
      if (progress.percent !== undefined || progress.message !== undefined) onProgress?.(progress);
    } else if (match[1] === "result" && payload && typeof payload === "object" && !Array.isArray(payload)) {
      const value = payload as Record<string, unknown>;
      // The result protocol is a structured contract. Ignore malformed
      // progress telemetry, but never accept a result with incorrectly
      // typed fields as a successful structured output.
      const owns = (key: string) => Object.prototype.hasOwnProperty.call(value, key);
      if ((owns("summary") && typeof value.summary !== "string") ||
          (owns("outputs") && (value.outputs === null || typeof value.outputs !== "object" || Array.isArray(value.outputs))) ||
          (owns("artifacts") && !Array.isArray(value.artifacts))) {
        state.error = "命令返回的结果协议字段类型错误";
        return true;
      }
      state.result = {
        ...(typeof value.summary === "string" ? { summary: value.summary } : {}),
        ...(value.outputs && typeof value.outputs === "object" && !Array.isArray(value.outputs)
          ? { outputs: value.outputs as Record<string, unknown> }
          : {}),
        ...(Array.isArray(value.artifacts) ? { artifacts: value.artifacts as NodeArtifact[] } : {}),
      };
    } else if (match[1] === "result") {
      state.error = "命令返回的结果协议不是 JSON 对象";
    }
  } catch {
    // Progress telemetry is best-effort. A malformed *result*, however,
    // cannot be silently discarded while the command reports success.
    if (match[1] === "result") state.error = "命令返回的结果协议 JSON 无法解析";
  }
  return true;
}

/** `node:child_process` 的 `spawn` 的形状 —— 留一个缝,冒烟脚本能塞假的进来。 */
export type { SpawnFn };

/**
 * 跑一条命令直到它退出。**这个 promise 一定 settle**:退出、超时、中止,三条路都通。
 *
 * `cwd` 省略时进程落在宿主的当前目录 —— 调用方(runner.ts)应当传**项目目录**,
 * 让 `python train.py` 这种相对路径的命令落在用户画图时想的那块地上。
 *
 * `deps.spawn` 只给冒烟测试用:塞一个假的 spawn,不真起进程。
 */
export async function runCommandNode(
  args: {
    command: string;
    /** Optional structured stdin payload from workflow inputs/upstream artifacts. */
    input?: unknown;
    /** 毫秒。0 = 不限(见 `@contracts/nodeType` 的 `commandTimeoutOf`)。 */
    timeoutMs: number;
    cwd?: string;
    signal: AbortSignal;
    onProgress?: (progress: CommandProgress) => void;
  },
  deps?: { spawn?: SpawnFn },
): Promise<NodeOutcome> {
  const { command, input, timeoutMs, cwd, signal, onProgress } = args;
  // Direct/internal callers can bypass the IPC/runner parameter validator.
  // Reuse the contract helper so a numeric/symbol command cannot throw on
  // .trim() and break the scheduler instead of producing a failed outcome.
  if (commandOf({ command }).length === 0) {
    return { status: "failed", summary: "", error: "命令节点没有填要跑的命令" };
  }
  // 预中止:**根本不 spawn** —— 用户已经按了停止,没有理由再起一个进程。
  const aborted = nativeAbortState(signal);
  if (aborted === null) return { status: "failed", summary: "", error: "命令 signal 必须是有效 AbortSignal" };
  if (aborted) return { status: "cancelled", summary: "" };
  // Direct module/IPC callers can bypass the validated NodeInput builder.
  // An invalid timer (NaN, negative, fractional, overflowing) can disable the
  // watchdog or make Node schedule an unintended 1ms immediate timeout.
  if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 0 || timeoutMs > 2_147_483_647) {
    return { status: "failed", summary: "", error: "命令 timeoutMs 必须是 0–2147483647 的整数毫秒" };
  }
  if (cwd !== undefined && (typeof cwd !== "string" || cwd.trim().length === 0)) {
    return { status: "failed", summary: "", error: "命令 cwd 工作目录必须是非空路径字符串" };
  }

  // JSON.stringify can throw on BigInt, circular references, or arbitrary
  // user-supplied toJSON getters (which may even throw null-prototype objects).
  // Its result can also be undefined (function/symbol), not valid JSON.
  // Never spawn a command after a failed input snapshot.
  let serializedInput: string | undefined;
  if (input !== undefined) {
    try {
      const json = JSON.stringify(input);
      if (typeof json !== "string") {
        return { status: "failed", summary: "", error: "命令节点输入无法序列化为 JSON" };
      }
      serializedInput = json + "\n";
    } catch (err) {
      return { status: "failed", summary: "", error: `命令节点输入无法序列化:${safeErrorMessage(err)}` };
    }
  }

  const protocolState: ProtocolState = {};
  const run = await spawnRun({
    command,
    shell: true,
    ...(cwd !== undefined ? { cwd } : {}),
    ...(serializedInput !== undefined ? { stdin: serializedInput } : {}),
    timeoutMs,
    signal,
    limitBytes: COMMAND_OUTPUT_TAIL_CHARS,
    // **两条流并成一段**:下游只认一段"输出尾部",不分 stdout/stderr
    // (见文件头第 2 条)。协议行在任一线上出现都算。
    mergeStreams: true,
    onStdoutLine: (line) => consumeProtocolLine(line, onProgress, protocolState),
    ...(deps?.spawn !== undefined ? { spawn: deps.spawn } : {}),
  });

  // **截断要说出来**(见 `markTruncatedTail`)。`text` 同时是给下游读的正文和
  // `{{那步.stdout}}` 取的值 —— 两处都得让人看见"这是尾巴",否则下游会把一段缺头的
  // 输出当成完整的,据此下结论。
  const rawText = run.stdout.trim();
  const truncated = run.stdoutTruncated;
  const text = truncated ? markTruncatedTail(rawText, COMMAND_OUTPUT_TAIL_CHARS) : rawText;
  const protocol = protocolState.result;
  const artifacts = normalizeNodeArtifacts(protocol?.artifacts, cwd ?? process.cwd());

  // **spawn 就没成**(ENOENT 那一类):shell 都没起来,谈不上"跑完了"。
  // `pid` 有值说明进程真起来了再死的,那种情况下面按退出码走。
  if (run.spawnError !== undefined && run.code === null && !run.killedBy.timeout && !run.killedBy.abort) {
    return { status: "failed", summary: text, error: `命令起不来:${run.spawnError.message}` };
  }
  if (run.killedBy.abort) return { status: "cancelled", summary: text };
  if (run.killedBy.timeout) {
    return {
      status: "failed",
      summary: text,
      error: `命令超过 ${timeoutMs} 毫秒还没完,被杀掉了 —— 要等它就别填超时,或把超时填大些`,
    };
  }
  if (run.code === null) {
    // 不是我们杀的(没有 abort/timeout 标记)却没拿到退出码 —— 被外部信号终止了。
    return {
      status: "failed",
      summary: text,
      error: `命令被信号终止(${run.signal ?? "未知"}),没有拿到退出码`,
    };
  }
  // A malformed/duplicate protocol result is not a reliable structured
  // output. Ordinary command exit codes (including nonzero) retain their
  // documented successful-node semantics, but corrupt control data fails.
  if (protocolState.error) return { status: "failed", summary: text, error: protocolState.error };
  // **非零退出码照样成功** —— 见文件头第 1 条。退出码进产出变量,分流是下游的事。
  return {
    status: "success",
    summary: protocol?.summary ?? text,
    outputs: {
      ...(protocol?.outputs ?? {}),
      exitCode: run.code,
      stdout: text,
    },
    ...(artifacts.length > 0 ? { artifacts } : {}),
  };
}
