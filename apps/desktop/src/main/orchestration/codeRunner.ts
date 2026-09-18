import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { NODE_STDOUT_PROTOCOL_PREFIX, type NodeOutcome } from "@contracts/nodeType";
import { normalizeNodeArtifacts } from "./artifactRefs.js";

export type CodeLanguage = "python" | "node" | "shell" | "powershell";
export interface CodeProgress { percent?: number; message?: string; }
type ProtocolResult = {
  summary?: string;
  outputs?: Record<string, unknown>;
  artifacts?: NodeOutcome["artifacts"];
};

const MAX_CAPTURE_BYTES = 16_000;

function killTree(p: ChildProcess): void {
  if (p.pid === undefined || p.exitCode !== null || p.signalCode !== null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(p.pid), "/T", "/F"], { windowsHide: true });
  } else {
    p.kill("SIGTERM");
  }
}

function spec(language: CodeLanguage, file: string): [string, string[]] {
  if (language === "python") return ["python", ["-u", file]];
  if (language === "node") return [process.execPath, [file]];
  if (language === "powershell") return ["powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file]];
  return process.platform === "win32" ? ["cmd.exe", ["/d", "/s", "/c", file]] : ["sh", [file]];
}

function appendLimited(current: string, chunk: Buffer): string {
  return (current + chunk.toString("utf8")).slice(-MAX_CAPTURE_BYTES);
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
  const ext = a.language === "python" ? "py" : a.language === "node" ? "mjs" : a.language === "powershell" ? "ps1" : "cmd";
  const file = path.join(dir, `main.${ext}`);
  await writeFile(file, a.code, "utf8");
  const [cmd, args] = spec(a.language, file);
  let child: ChildProcess | undefined;
  let stdout = "";
  let stderr = "";
  let lineBuffer = "";
  let result: ProtocolResult | undefined;
  let spawnError: Error | undefined;
  const killed = { abort: false, timeout: false };

  const consumeLine = (line: string) => {
    if (!line.startsWith(NODE_STDOUT_PROTOCOL_PREFIX)) return;
    const payload = line.slice(NODE_STDOUT_PROTOCOL_PREFIX.length).match(/^(\w+)\s+(.*)$/);
    if (!payload) return;
    try {
      const value = JSON.parse(payload[2]);
      if (payload[1] === "progress") a.onProgress?.(value);
      if (payload[1] === "result") result = value;
    } catch {
      // User stdout is allowed to contain arbitrary text; malformed protocol lines are ignored.
    }
  };

  const consumeStdout = (chunk: Buffer) => {
    lineBuffer += chunk.toString("utf8");
    const lines = lineBuffer.split(/\r?\n/);
    lineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith(NODE_STDOUT_PROTOCOL_PREFIX)) consumeLine(line);
      else stdout = appendLimited(stdout, Buffer.from(line + "\n", "utf8"));
    }
  };

  try {
    child = spawn(cmd, args, {
      cwd: a.cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.once("error", (err) => { spawnError = err instanceof Error ? err : new Error(String(err)); });
    child.stdout?.on("data", consumeStdout);
    child.stderr?.on("data", (x: Buffer) => { stderr = appendLimited(stderr, x); });

    const abort = () => { killed.abort = true; killTree(child!); };
    a.signal.addEventListener("abort", abort, { once: true });
    const timer = a.timeoutMs > 0
      ? setTimeout(() => { killed.timeout = true; killTree(child!); }, a.timeoutMs)
      : undefined;

    try {
      child.stdin?.end(JSON.stringify(a.input ?? null) + "\n");
    } catch (err) {
      stderr = appendLimited(stderr, Buffer.from(String(err)));
    }

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child!.once("exit", (code, signal) => resolve({ code, signal }));
      child!.once("error", () => resolve({ code: null, signal: null }));
    });
    if (timer) clearTimeout(timer);
    a.signal.removeEventListener("abort", abort);
    if (lineBuffer) consumeLine(lineBuffer);

    const outputs = {
      ...(result?.outputs ?? {}),
      exitCode: exit.code,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    };
    const artifacts = normalizeNodeArtifacts(result?.artifacts, a.cwd ?? process.cwd());

    const artifactPayload = artifacts.length > 0 ? { artifacts } : {};
    if (killed.abort) return { status: "cancelled", summary: stdout.trim(), outputs, ...artifactPayload };
    if (killed.timeout) {
      return { status: "failed", summary: stdout.trim(), outputs, ...artifactPayload, error: `code node timed out after ${a.timeoutMs} ms` };
    }
    if (spawnError) {
      return { status: "failed", summary: "", outputs, ...artifactPayload, error: `无法启动代码进程: ${spawnError.message}` };
    }
    if (exit.code !== 0) {
      return {
        status: "failed",
        summary: result?.summary ?? stdout.trim(),
        outputs,
        ...artifactPayload,
        error: stderr.trim() || `进程退出码 ${exit.code ?? "unknown"}`,
      };
    }
    return { status: "success", summary: result?.summary ?? stdout.trim(), outputs, ...artifactPayload };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
