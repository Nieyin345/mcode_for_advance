import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { NODE_STDOUT_PROTOCOL_PREFIX, type NodeOutcome } from "@contracts/nodeType";

export type CodeLanguage = "python" | "node" | "shell" | "powershell";
export interface CodeProgress { percent?: number; message?: string; }

function killTree(p: ChildProcess): void {
  if (p.pid === undefined || p.exitCode !== null || p.signalCode !== null) return;
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(p.pid), "/T", "/F"], { windowsHide: true });
  else p.kill("SIGTERM");
}
function spec(language: CodeLanguage, file: string): [string, string[]] {
  if (language === "python") return ["python", ["-u", file]];
  if (language === "node") return [process.execPath, [file]];
  if (language === "powershell") return ["powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file]];
  return process.platform === "win32" ? ["cmd.exe", ["/d", "/s", "/c", file]] : ["sh", [file]];
}
export async function runCodeNode(a: {
  code: string; language: CodeLanguage; input?: unknown; timeoutMs: number; cwd?: string; signal: AbortSignal;
  onProgress?: (p: CodeProgress) => void;
}): Promise<NodeOutcome> {
  if (!a.code.trim()) return { status: "failed", summary: "", error: "代码节点没有填写代码" };
  if (a.signal.aborted) return { status: "cancelled", summary: "" };
  const dir = await mkdtemp(path.join(os.tmpdir(), "mcode-code-"));
  const ext = a.language === "python" ? "py" : a.language === "node" ? "mjs" : a.language === "powershell" ? "ps1" : "cmd";
  const file = path.join(dir, `main.${ext}`);
  await writeFile(file, a.code, "utf8");
  const [cmd, args] = spec(a.language, file);
  let child: ChildProcess | undefined, stdout = "", stderr = "";
  let result: { summary?: string; outputs?: Record<string, unknown> } | undefined;
  const killed = { abort: false, timeout: false };
  const append = (s: string, x: Buffer) => (s + x.toString("utf8")).slice(-16000);
  try {
    child = spawn(cmd, args, { cwd: a.cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    child.stdout?.on("data", (x: Buffer) => {
      stdout = append(stdout, x);
      for (const line of x.toString("utf8").split(/\r?\n/)) {
        if (!line.startsWith(NODE_STDOUT_PROTOCOL_PREFIX)) continue;
        const m = line.slice(NODE_STDOUT_PREFIX.length).match(/^(\w+)\s+(.*)$/);
        if (!m) continue;
        try { const v = JSON.parse(m[2]); if (m[1] === "progress") a.onProgress?.(v); if (m[1] === "result") result = v; } catch {}
      }
    });
    child.stderr?.on("data", (x: Buffer) => { stderr = append(stderr, x); });
    const abort = () => { killed.abort = true; killTree(child!); };
    a.signal.addEventListener("abort", abort, { once: true });
    const timer = a.timeoutMs > 0 ? setTimeout(() => { killed.timeout = true; killTree(child!); }, a.timeoutMs) : undefined;
    child.stdin?.end(JSON.stringify(a.input ?? null) + "\n");
    const exit = await new Promise<{code:number|null; signal:NodeJS.Signals|null}>((resolve) => {
      child!.once("error", () => resolve({ code: null, signal: null }));
      child!.once("exit", (code, signal) => resolve({ code, signal }));
    });
    if (timer) clearTimeout(timer); a.signal.removeEventListener("abort", abort);
    const outputs = { ...(result?.outputs ?? {}), exitCode: exit.code, stdout: stdout.trim(), stderr: stderr.trim() };
    if (killed.abort) return { status: "cancelled", summary: stdout.trim(), outputs };
    if (killed.timeout) return { status: "failed", summary: stdout.trim(), outputs, error: `code node timed out after ${a.timeoutMs} ms`};
    if (exit.code !== 0) return { status: "failed", summary: result?.summary ?? stdout.trim(), outputs, error: stderr.trim() || `进程退出码 ${exit.code ?? "unknown"}` };
    return { status: "success", summary: result?.summary ?? stdout.trim(), outputs };
  } finally { await rm(dir, { recursive: true, force: true }).catch(() => undefined); }
}
