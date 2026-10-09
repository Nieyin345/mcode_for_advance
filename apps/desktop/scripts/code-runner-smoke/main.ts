import * as path from "node:path";
import { readFileSync } from "node:fs";
import { runCodeNode } from "@main/orchestration/codeRunner.js";
import { NODE_STDOUT_PROTOCOL_PREFIX } from "@contracts/nodeType";

let total = 0;
let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  total++;
  if (ok) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}
function eq(name: string, actual: unknown, expected: unknown): void { check(name, Object.is(actual, expected), { actual, expected }); }
function controller(): AbortController { return new AbortController(); }

console.log("\nPython · JSON stdin / structured result / progress");
{
  const progress: Array<{ percent?: number; message?: string }> = [];
  const code = [
    "import sys, json",
    "x = json.loads(sys.stdin.readline())",
    `print('${NODE_STDOUT_PROTOCOL_PREFIX}progress ' + json.dumps({'percent': 50, 'message': 'half'}))`,
    `print('${NODE_STDOUT_PROTOCOL_PREFIX}result ' + json.dumps({'summary': 'done', 'outputs': {'value': x['value'] * 2}}))`,
    "print('ordinary stdout')",
  ].join("\n");
  const out = await runCodeNode({ code, language: "python", input: { value: 21 }, timeoutMs: 5000, signal: controller().signal, onProgress: p => progress.push(p) });
  eq("success", out.status, "success");
  eq("result summary", out.summary, "done");
  eq("typed output preserved", out.outputs?.value, 42);
  eq("ordinary stdout preserved", out.outputs?.stdout, "ordinary stdout");
  eq("progress delivered", progress[0]?.percent, 50);
  eq("progress message delivered", progress[0]?.message, "half");
}

console.log("\nNode · non-zero exit / stderr");
{
  const code = "console.error('boom'); process.exit(3);";
  const out = await runCodeNode({ code, language: "node", timeoutMs: 5000, signal: controller().signal });
  eq("non-zero exit is failed", out.status, "failed");
  eq("exit code exposed", out.outputs?.exitCode, 3);
  eq("stderr exposed", out.outputs?.stderr, "boom");
}

console.log("\nNode · timeout / cancellation");
{
  const timed = await runCodeNode({ code: "setInterval(() => {}, 1000);", language: "node", timeoutMs: 300, signal: controller().signal });
  eq("timeout is failed", timed.status, "failed");
  check("timeout says how long", String(timed.error).includes("300"), timed.error);
  // 这行会画在**失败节点卡片**上 —— 与同一文件上下其它失败原因(「代码节点没有填写代码」
  // 「无法启动代码进程」)以及命令节点 `commandRunner` 一样是中文。曾经它是英文。
  check("timeout error is Chinese (matches its sibling node errors)", /超过/.test(String(timed.error)) && !/timed out/.test(String(timed.error)), timed.error);

  const abort = controller();
  const pending = runCodeNode({ code: "setInterval(() => {}, 1000);", language: "node", timeoutMs: 0, signal: abort.signal });
  await new Promise(r => setTimeout(r, 200));
  abort.abort();
  const cancelled = await pending;
  eq("abort is cancelled", cancelled.status, "cancelled");
}

console.log("\nArtifact · relative URI normalization");
{
  const code = [
    "import json, sys",
    `print('${NODE_STDOUT_PROTOCOL_PREFIX}result ' + json.dumps({'summary': 'file ready', 'artifacts': [{'kind': 'file', 'uri': 'outputs/result.json', 'name': 'result.json'}]}))`,
  ].join("\n");
  const cwd = process.cwd();
  const out = await runCodeNode({ code, language: "python", input: {}, timeoutMs: 5000, cwd, signal: controller().signal });
  eq("artifact result success", out.status, "success");
  eq("artifact URI resolved", out.artifacts?.[0]?.uri, path.resolve(cwd, "outputs/result.json"));
  eq("artifact name preserved", out.artifacts?.[0]?.name, "result.json");
}

console.log("\nProtocol · malformed payload must not poison the outcome");
{
  // ★ **协议 payload 逐字段收,不原样信。** 协议行是**用户代码**打的:一个手滑
  //   (`result {"summary": {...}}`)曾会让整个 payload 原样变成结果 —— 于是
  //   `NodeOutcome.summary` 是非字符串,下游调度器的 `producedTextOf` 拿它 `.trim()`
  //   会抛,**整条运行**跟着挂(`progress null` 同理让 emitProgress 读 null.percent 抛)。
  //   `commandRunner` 早就是逐字段收的,这一支必须与它对齐。
  const code = [
    "import json, sys",
    `print('${NODE_STDOUT_PROTOCOL_PREFIX}progress ' + json.dumps(None))`,
    `print('${NODE_STDOUT_PROTOCOL_PREFIX}result ' + json.dumps({'summary': {'中': '毒'}, 'outputs': [1, 2]}))`,
    "print('plain')",
  ].join("\n");
  const progress: Array<{ percent?: number; message?: string }> = [];
  const out = await runCodeNode({ code, language: "python", timeoutMs: 5000, signal: controller().signal, onProgress: p => progress.push(p) });
  eq("malformed protocol still succeeds", out.status, "success");
  check("★ summary 一定是字符串(下游 .trim() 不会抛)", typeof out.summary === "string", out.summary);
  eq("★ 畸形 summary(对象)被丢,退回 stdout", out.summary, "plain");
  check("★ `progress null` 不进回调(不再读 null.percent)", progress.length === 0, progress);
  check("★ 非对象的 outputs 被丢(数组下标没铺进产出)", !("0" in (out.outputs ?? {})), out.outputs);
}

// Exercise the actual spawn path with an Electron host identity; a real Electron
// integration probe additionally verifies natural process termination.
{
  const previous = Object.getOwnPropertyDescriptor(process.versions, "electron");
  try {
    Object.defineProperty(process.versions, "electron", { value: "audit-host", configurable: true });
    const out = await runCodeNode({
      code: "console.log(process.env.ELECTRON_RUN_AS_NODE ?? 'missing');",
      language: "node", timeoutMs: 5000, signal: controller().signal,
    });
    eq("Electron-hosted Node code uses Node mode", out.outputs?.stdout, "1");
    eq("Node code exits naturally", out.status, "success");
  } finally {
    if (previous) Object.defineProperty(process.versions, "electron", previous);
    else Reflect.deleteProperty(process.versions, "electron");
  }
}

console.log("\nLanguage · 用户可见的失败原因一律中文");
{
  // ★ 画在**失败节点卡片**上的那行字必须与兄弟节点同口径。`commandRunner` 里
  //   「命令被信号终止…没有拿到退出码」/`进程退出码 未知` 都是中文,而这一支同一处境
  //   (`run.code === null` —— 进程被信号杀掉,拿不到退出码)从前写死英文 `unknown`。
  //   commit 4e1a9a0a 修了同一文件里**超时**那句英文,漏了这一句。整句写死,不做"读一个
  //   中文字符"那种松断言 —— 那样把中文换成英文哨兵照样绿。
  const src = readFileSync(path.join(process.cwd(), "src/main/orchestration/codeRunner.ts"), "utf8");
  check("★ 拿不到退出码时说的是中文「未知」(不是英文 unknown)", src.includes("run.code ?? \"未知\""), "codeRunner.ts");
  check("★ 不再有 `run.code ?? \"unknown\"` 的英文哨兵", !src.includes('run.code ?? "unknown"'), "codeRunner.ts");
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${total} checks`);
if (failures > 0) process.exit(1);
