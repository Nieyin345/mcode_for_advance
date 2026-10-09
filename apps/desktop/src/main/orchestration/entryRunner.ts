/**
 * **清单自带脚本**的节点执行器 —— `runner.kind === "command"` 且填了 `entry` 的那一支。
 *
 * ## 它和内置 `mcode.command` 的区别
 *
 * 内置那种的命令来自**节点参数**(用户在图上一格写什么就跑什么);这一种的命令来自
 * **清单自己**(插件作者随插件发的脚本)。两者跑起来是同一件事,差别只在"命令从哪来"
 * 和"相对谁解析":
 *
 * | | 命令来自 | 相对谁 |
 * |---|---|---|
 * | 内置 `mcode.command` | 节点参数 | 工作目录(用户自己知道在哪) |
 * | 这一种 | `runner.entry` | **清单文件所在目录** |
 *
 * ## 为什么必须防逃逸
 *
 * `entry` 是**第三方写的**。写成 `../../../etc/passwd` 就等于让插件在用户机器上跑任意
 * 位置的任意文件 —— 而"这个插件的脚本"和"插件目录外的那个文件"是两回事。所以解析完
 * 之后**必须核对它仍落在清单目录内**,规则与 `pluginManifest.ts` 的 `resolveInRoot`、
 * `library/fileImport.ts` 的 `startsWith(root + sep)` 同一条。
 *
 * ## 为什么不用 shell
 *
 * 内置那种走 `shell: true`(用户写的就是一整条命令行,管道重定向都算他的自由)。
 * 这一种**不走 shell** —— 命令和参数是**我们拼的**,而脚本路径可能含中文、空格、引号;
 * 过 shell 就得自己转义,漏一处就是命令注入。直接 `spawn(file, args)` 没有这个问题。
 *
 * ## 退出码与失败的规矩**与内置那种逐条一致**
 *
 * 非零退出码**不算这一步失败**(见 `commandRunner.ts` 文件头第 1 条):直跑的语义是
 * "等它跑完",不是"断言它成功"。真的失败只有三种:spawn 起不来、超时被杀、被信号终止。
 */

import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import {
  COMMAND_OUTPUT_TAIL_CHARS,
  NODE_STDOUT_PROTOCOL_PREFIX,
  type NodeArtifact,
  type NodeOutcome,
} from "@contracts/nodeType";
import { normalizeNodeArtifacts } from "./artifactRefs.js";
import { spawnRun, type SpawnFn } from "@main/lib/spawnRun.js";

interface ProtocolResult {
  summary?: string;
  outputs?: Record<string, unknown>;
  artifacts?: NodeArtifact[];
}

/**
 * 把 `entry` 解析成一个绝对路径。**落在清单目录外就返回 null,调用方负责拒绝。**
 *
 * 三道闸:
 *  1. 词法层:绝对路径直接拒(`entry` 的定义就是"相对清单目录");
 *  2. 终审:resolve 之后必须仍在清单目录内 —— 挡的是 `../../x` 这种**词法上合法、
 *     语义上越界**的写法;
 *  3. realpath:清单目录里一个 **junction / 符号链接**指向目录外时,词法层看着仍在里
 *     层、物理上已经出了目录 —— 与 `pluginManifest.resolveInRoot` 同一道闸(这个函数
 *     头上本来就写着"规则与它同一条",少了这一闸就是那两处**又分了家**)。
 *
 * `manifestDir` 缺席(内置类型没有文件)也返回 null。
 */
export function resolveEntryScript(entry: string, manifestDir: string | undefined): string | null {
  if (!manifestDir) return null;
  if (isAbsolute(entry) || entry.includes("\0")) return null;
  const root = resolve(manifestDir);
  const target = resolve(root, entry);
  if (target !== root && !target.startsWith(root + sep)) return null;
  // 只有真存在的路径才谈得上"物理上在不在里层":不存在时没有可解的物理路径,行为与
  // 从前一字不变(照样返回词法路径,由调用方的 `existsSync` 报「脚本不在」)。存在时
  // 再解链接 —— 目录里一个 junction 指向目录外,词法层看着在里、物理上已经出了目录。
  if (existsSync(target)) {
    try {
      const realRoot = realpathSync(root);
      const realTarget = realpathSync(target);
      if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) return null;
    } catch {
      // 解不动(权限/坏链接)—— 证明不了它在里层,按越界处理(失败关闭)。
      return null;
    }
  }
  return target;
}

/**
 * 认一行协议并消费掉。与 `commandRunner.ts` 同一套格式(定义在 `@contracts/nodeType`)——
 * 第三方脚本按它上报进展与结构化产出,格式一变已经写好的脚本就全废。
 */
function consumeProtocolLine(
  line: string,
  onProgress: ((progress: { percent?: number; message?: string }) => void) | undefined,
  state: { result?: ProtocolResult },
): boolean {
  if (!line.startsWith(NODE_STDOUT_PROTOCOL_PREFIX)) return false;
  const match = line.match(/^@@mcode:(progress|result)\s+(.+)$/);
  if (!match) return true;
  try {
    const payload = JSON.parse(match[2]) as unknown;
    if (match[1] === "progress" && payload && typeof payload === "object") {
      const value = payload as Record<string, unknown>;
      // `percent` 多一道**有限性**守卫:payload 是第三方脚本打的,而 `1e999` 在 JSON
      // 里是合法数字、`JSON.parse` 出来却是 `Infinity` —— 只判 `typeof === "number"`
      // 拦不住它。非有限值会原样进进度事件,而两端处置还不一样:桌面端夹到 100%、手机端
      // 过 SSE 的 `JSON.stringify(Infinity)` 变成 `null` 再夹到 0% —— 同一步在两端显示
      // 成两个数。兄弟 `commandRunner` / `codeRunner` 的同名函数都有这一道
      // (`codeRunner` 是 af9ccaa1 补的),这一支当时漏了。
      onProgress?.({
        ...(typeof value.percent === "number" && Number.isFinite(value.percent) ? { percent: value.percent } : {}),
        ...(typeof value.message === "string" ? { message: value.message } : {}),
      });
    } else if (match[1] === "result" && payload && typeof payload === "object") {
      // **逐字段收,不把 payload 原样当结果用。** 这里的 payload 是**第三方脚本**打的,
      // 而它一个手滑(把 summary 打成一个对象、把 outputs 打成数组)就会让
      // `NodeOutcome.summary` 变成非字符串 —— 下游调度器 `producedTextOf` 拿它
      // `.trim()`,整条运行当场抛,不止这一步失败。同一个协议 `commandRunner` 早就是
      // 逐字段收的(见那边的 `consumeProtocolLine`),这一支与它对齐。
      const value = payload as Record<string, unknown>;
      state.result = {
        ...(typeof value.summary === "string" ? { summary: value.summary } : {}),
        ...(value.outputs && typeof value.outputs === "object" && !Array.isArray(value.outputs)
          ? { outputs: value.outputs as Record<string, unknown> }
          : {}),
        ...(Array.isArray(value.artifacts) ? { artifacts: value.artifacts as NodeArtifact[] } : {}),
      };
    }
  } catch {
    /* 协议行解析不了就当普通输出 —— 不因为它让整步失败 */
  }
  return true;
}

/** 交给 {@link runEntryScript} 的一次执行。`cwd` 是**工作流的工作目录**。 */
export interface EntryRunArgs {
  /** 脚本路径,**相对清单目录**写的(见 `NodeRunnerSchema` 的 `entry`)。 */
  script: string;
  manifestDir?: string;
  interpreter?: string;
  args?: string[];
  input?: unknown;
  timeoutMs: number;
  /** 工作流的工作目录。脚本的 `cwd` 另算(见下)。 */
  cwd?: string;
  signal: AbortSignal;
  onProgress?: (progress: { percent?: number; message?: string }) => void;
}

/**
 * 跑一个清单自带的脚本。
 *
 * **脚本的 `cwd` 是清单目录,不是工作流的工作目录。** 脚本里写 `open("data/x.txt")`
 * 相对的是它自己那一包 —— 那是插件作者会预期的行为,也是"带脚本的节点"能自洽的前提。
 * 它要碰工作流的文件就用 `args` 传进来的绝对路径。
 */
export async function runEntryScript(
  args: EntryRunArgs,
  deps?: { spawn?: SpawnFn },
): Promise<NodeOutcome> {
  const { script, manifestDir, interpreter, args: extraArgs, input, timeoutMs, signal, onProgress } = args;

  if (signal.aborted) return { status: "cancelled", summary: "" };

  const abs = resolveEntryScript(script, manifestDir);
  if (abs === null) {
    return {
      status: "failed",
      summary: "",
      error: `这一步的脚本路径不合法:「${script}」必须写在清单目录里`,
    };
  }
  if (!existsSync(abs)) {
    return { status: "failed", summary: "", error: `这一步的脚本不在:${abs}` };
  }

  // `interpreter` 给了就 `python <脚本> <参数…>`,没给就直接执行脚本本身(需要可执行位)。
  const file = interpreter ?? abs;
  const argv = interpreter !== undefined ? [abs, ...(extraArgs ?? [])] : (extraArgs ?? []);

  const protocolState: { result?: ProtocolResult } = {};
  const run = await spawnRun({
    command: file,
    args: argv,
    shell: false,
    // **脚本的工作目录是清单目录** —— 见上面那段。脚本要碰工作流的文件就靠 `args`
    // 传绝对路径进来。
    ...(manifestDir !== undefined ? { cwd: resolve(manifestDir) } : {}),
    ...(input !== undefined ? { stdin: JSON.stringify(input ?? null) + "\n" } : {}),
    timeoutMs,
    signal,
    limitBytes: COMMAND_OUTPUT_TAIL_CHARS,
    mergeStreams: true,
    onStdoutLine: (line) => consumeProtocolLine(line, onProgress, protocolState),
    ...(deps?.spawn !== undefined ? { spawn: deps.spawn } : {}),
  });

  const text = run.stdout.trim();
  const protocol = protocolState.result;
  // 产出里的相对路径按**清单目录**解 —— 脚本是在那儿跑的,它说的 "./out.csv"
  // 相对的是它自己那一包(同上面 `cwd` 那条规矩)。
  const artifacts = normalizeNodeArtifacts(protocol?.artifacts, resolve(manifestDir ?? process.cwd()));

  // spawn 就没成(ENOENT 那一类):进程都没起来,谈不上"跑完了"。
  if (run.spawnError !== undefined && run.code === null && !run.killedBy.timeout && !run.killedBy.abort) {
    return {
      status: "failed",
      summary: text,
      error: `这一步的脚本起不来:${run.spawnError.message}(要跑的是「${file}」)`,
    };
  }
  if (run.killedBy.abort) return { status: "cancelled", summary: text };
  if (run.killedBy.timeout) {
    return {
      status: "failed",
      summary: text,
      error: `这一步的脚本超过 ${timeoutMs} 毫秒还没完,被杀掉了`,
    };
  }
  if (run.code === null) {
    return {
      status: "failed",
      summary: text,
      error: `这一步的脚本被信号终止(${run.signal ?? "未知"}),没有拿到退出码`,
    };
  }
  // **非零退出码照样成功** —— 与内置那种同一条规矩(见文件头)。
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
