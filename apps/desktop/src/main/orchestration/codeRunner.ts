/**
 * 代码节点的执行器 —— 把用户填的一段代码写成临时文件,起进程跑它,收产出。
 *
 * ## 与命令节点的关系
 *
 * 两者都走 `lib/spawnRun.ts`(起进程、杀树、超时、编码判定全在那一层),差别是
 * **语义**,不是机制:
 *
 * | | 命令节点 | 代码节点 |
 * |---|---|---|
 * | 代码从哪来 | 用户填的一整行命令 | 用户填的一段代码 → 写进临时文件 |
 * | 非零退出码 | **不算失败**(直跑语义) | **算失败**,stderr 进错误 |
 * | stdout / stderr | 合并成一段"输出尾部" | **分开**,各进一个产出变量 |
 * | 临时文件 | 没有 | 跑完删掉 |
 *
 * 第一行那个"代码写文件"是这一层独有的:用户填的是代码不是命令行,所以要先落盘、
 * 再按语言挑解释器。第五行是它必须自己管的资源(跑完删,失败了也删)。
 *
 * ## 语言与解释器
 *
 * `python -u`(不带 `-u` 的话 stdout 是全缓冲的,进度上报会攒到进程结束才出来,
 * 那正好毁掉"实时看训练进度"这件事)、`node` 用 `process.execPath`(用当前这个
 * Node,而不是 PATH 上那个可能不存在的)、PowerShell 与 shell 各有各的调用形状。
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { NODE_STDOUT_PROTOCOL_PREFIX, type NodeOutcome } from "@contracts/nodeType";
import { normalizeNodeArtifacts } from "./artifactRefs.js";
import { spawnRun } from "@main/lib/spawnRun.js";

export type CodeLanguage = "python" | "node" | "shell" | "powershell";
export interface CodeProgress { percent?: number; message?: string; }
type ProtocolResult = {
  summary?: string;
  outputs?: Record<string, unknown>;
  artifacts?: NodeOutcome["artifacts"];
};

/** 输出只留尾部这么多**字节**(见 `spawnRun` 的窗口说明)。 */
const MAX_CAPTURE_BYTES = 16_000;

/** 语言 → 怎么起它。`file` 是已经写好的那个临时文件。 */
function spec(language: CodeLanguage, file: string): [string, string[]] {
  // `-u` = 不做缓冲。少了它进度上报会攒到进程结束才出来,实时看进度就成了空话。
  if (language === "python") return ["python", ["-u", file]];
  // 用**当前这个** Node —— PATH 上那个未必存在(打包后的应用里更是如此)。
  if (language === "node") return [process.execPath, [file]];
  if (language === "powershell") {
    return ["powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file]];
  }
  // ⚠️ Windows 上**不能带 `/s`**(2026-09-27 修)。`/s` 会把 cmd 的「引号保留」规则关掉:
  // 脚本路径一含空格(用户名带空格的机器上,`os.tmpdir()` 就是
  // `C:\Users\John Smith\AppData\Local\Temp`),cmd 会把 Node 加上的引号剥掉、
  // 在空格处把命令切断 —— 实测报「'C:\...\Temp' 不是内部或外部命令」,用户填的
  // shell 代码一行都没跑。去掉 `/s` 之后,带空格的路径被整段保留并执行;
  // 不带空格的老路径本来就没有引号,行为一字不变。
  // (残余:临时路径里含 `&` 这类控制字符时仍不可用 —— 见 M08 报告的观察项。)
  return process.platform === "win32" ? ["cmd.exe", ["/d", "/c", file]] : ["sh", [file]];
}

function extensionOf(language: CodeLanguage): string {
  if (language === "python") return "py";
  if (language === "node") return "mjs";
  if (language === "powershell") return "ps1";
  return "cmd";
}

export async function runCodeNode(a: {
  code: string;
  language: CodeLanguage;
  input?: unknown;
  timeoutMs: number;
  cwd?: string;
  signal: AbortSignal;
  onProgress?: (p: CodeProgress) => void;
}): Promise<NodeOutcome> {
  if (!a.code.trim()) return { status: "failed", summary: "", error: "代码节点没有填写代码" };
  if (a.signal.aborted) return { status: "cancelled", summary: "" };

  const dir = await mkdtemp(path.join(os.tmpdir(), "mcode-code-"));
  try {
    const file = path.join(dir, `main.${extensionOf(a.language)}`);
    await writeFile(file, a.code, "utf8");
    const [cmd, argv] = spec(a.language, file);

    let result: ProtocolResult | undefined;
    /** 认一行协议。返回 `true` = 这一行是协议行,不进 stdout 产出。 */
    const consumeLine = (line: string): boolean => {
      if (!line.startsWith(NODE_STDOUT_PROTOCOL_PREFIX)) return false;
      const payload = line.slice(NODE_STDOUT_PROTOCOL_PREFIX.length).match(/^(\w+)\s+(.*)$/);
      if (!payload) return true;
      try {
        const value = JSON.parse(payload[2]);
        if (payload[1] === "progress") a.onProgress?.(value);
        if (payload[1] === "result") result = value;
      } catch {
        // 用户代码可以往 stdout 打任意文本;坏掉的协议行忽略即可。
      }
      return true;
    };

    const run = await spawnRun({
      command: cmd,
      args: argv,
      // **不走 shell**:命令与参数是这一层自己拼的数组,不是用户写给 shell 的一整行。
      // 走 shell 反而会把临时目录名里的空格/特殊字符再解析一遍。
      shell: false,
      // process.execPath is the app binary inside Electron. Run it as Node, not
      // as another browser/main process (which does not naturally terminate).
      ...(a.language === "node" && process.versions.electron
        ? { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } }
        : {}),
      ...(a.cwd !== undefined ? { cwd: a.cwd } : {}),
      // 输入永远给(哪怕是 `null`)—— 用户代码期望 stdin 上有一行 JSON。
      stdin: JSON.stringify(a.input ?? null) + "\n",
      timeoutMs: a.timeoutMs,
      signal: a.signal,
      limitBytes: MAX_CAPTURE_BYTES,
      onStdoutLine: consumeLine,
    });

    const stdout = run.stdout.trim();
    const stderr = run.stderr.trim();
    const outputs = {
      ...(result?.outputs ?? {}),
      exitCode: run.code,
      stdout,
      stderr,
    };
    const artifacts = normalizeNodeArtifacts(result?.artifacts, a.cwd ?? process.cwd());
    const artifactPayload = artifacts.length > 0 ? { artifacts } : {};

    if (run.killedBy.abort) {
      return { status: "cancelled", summary: stdout, outputs, ...artifactPayload };
    }
    if (run.killedBy.timeout) {
      return {
        status: "failed",
        summary: stdout,
        outputs,
        ...artifactPayload,
        error: `code node timed out after ${a.timeoutMs} ms`,
      };
    }
    if (run.spawnError !== undefined) {
      return {
        status: "failed",
        summary: "",
        outputs,
        ...artifactPayload,
        error: `无法启动代码进程: ${run.spawnError.message}`,
      };
    }
    // **与命令节点相反**:代码节点非零退出码就是失败 —— 用户填的是一段程序,
    // "它跑挂了"和"它跑完了"是两件事。
    if (run.code !== 0) {
      return {
        status: "failed",
        summary: result?.summary ?? stdout,
        outputs,
        ...artifactPayload,
        error: stderr || `进程退出码 ${run.code ?? "unknown"}`,
      };
    }
    return { status: "success", summary: result?.summary ?? stdout, outputs, ...artifactPayload };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
