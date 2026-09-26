import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCodeNode } from "@main/orchestration/codeRunner.js";

export async function runProbe(mode: string, dir: string): Promise<boolean> {
  const childRoot = join(dir, mode + "-owned-child");
  mkdirSync(childRoot, { recursive: true });
  // The prefix only isolates an erroneously launched Electron browser process.
  // Correct Node mode executes no Electron API and opens no windows.
  const prefix = [
    'import {mkdirSync} from "node:fs";', 'import {join} from "node:path";',
    'import {createRequire} from "node:module";', `const owned=${JSON.stringify(childRoot)};`,
    'if(process.type === "browser"){ const {app}=createRequire(import.meta.url)("electron");',
    'for(const name of ["userData","sessionData","logs","crashDumps"]){const p=join(owned,name);mkdirSync(p,{recursive:true});app.setPath(name,p);}',
    'if(!app.isReady())app.disableHardwareAcceleration();app.commandLine.appendSwitch("disable-background-networking");}',
  ].join("\n") + "\n";
  const start = Date.now();
  const result = await runCodeNode({
    code: prefix + 'let s="";for await(const c of process.stdin)s+=c;console.log(JSON.stringify({marker:"workflow-node-host",processType:process.type??"node",input:JSON.parse(s)}));',
    language: "node", input: { audit: 42 }, timeoutMs: 6000, cwd: dir, signal: new AbortController().signal,
  });
  let natural = false;
  try {
    const value = JSON.parse(String(result.outputs?.stdout)) as { marker?: string; processType?: string; input?: { audit?: number } };
    natural = result.status === "success" && value.marker === "workflow-node-host" && value.processType === "node" && value.input?.audit === 42;
  } catch { /* The raw outcome below explains the failure. */ }
  const nonzero = await runCodeNode({ code: prefix + 'console.error("expected-exit");process.exit(7);', language: "node", timeoutMs: 5000, cwd: dir, signal: new AbortController().signal });
  const timed = await runCodeNode({ code: prefix + 'setInterval(()=>{},1000);', language: "node", timeoutMs: 400, cwd: dir, signal: new AbortController().signal });
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 400);
  const cancelled = await runCodeNode({ code: prefix + 'setInterval(()=>{},1000);', language: "node", timeoutMs: 5000, cwd: dir, signal: abort.signal });
  clearTimeout(timer);
  const checks = [
    { name: "natural exit and JSON stdin in Node mode", passes: natural },
    { name: "nonzero exit propagates", passes: nonzero.status === "failed" && nonzero.outputs?.exitCode === 7 && nonzero.outputs?.stderr === "expected-exit" },
    { name: "timeout propagates", passes: timed.status === "failed" && timed.error?.includes("400") === true },
    { name: "cancellation propagates", passes: cancelled.status === "cancelled" },
  ];
  const row = { mode, host: { electron: process.versions.electron ?? null }, elapsedMs: Date.now() - start, checks, result, nonzero, timed, cancelled };
  writeFileSync(join(dir, "code-" + mode + "-result.json"), JSON.stringify(row, null, 2));
  for (const check of checks) console.log(`${check.passes ? "PASS" : "FAIL"} ${mode}: ${check.name}`);
  return checks.every(c => c.passes);
}
