/**
 * Headless smoke for 命令节点的执行器(`main/orchestration/commandRunner.ts`)。
 *
 * ## 验的是什么
 *
 * 命令节点是把"跑一条命令"变成流程里的一步,它有三条**刻意**的规矩(见那个文件的头),
 * 每一条都对应一种最常见的翻车方式:
 *
 * 1. **非零退出码不算失败** —— 直跑的语义是"等它跑完",不是"断言它成功"。退出码
 *    进产出,分流是下游的事。真正算失败的是 **spawn 就没起来**。
 * 2. **输出只留尾部**(`COMMAND_OUTPUT_TAIL_CHARS`)—— 训练日志动辄几万行,全量进
 *    产出变量是把下游的提示词往死里撑。
 * 3. **超时/中止要真把进程杀掉** —— shell 死了孙进程不死,训练偷偷跑,是最招恨的翻车。
 *
 * ## 真进程与假进程各跑一半
 *
 * **真 spawn**(shell 起真进程)钉"与环境的关系":退出码、stderr 并进尾部、截尾的
 * 精确长度、超时、中止 —— 这些交给假 spawn 就成了"测我自己写的 Promise 编排"。
 * **假 spawn**(注入 `deps.spawn`)钉"调用契约"与错误分叉:spawn 的选项(shell /
 * stdio / cwd 透传)、同步抛、`error` 事件(shell:true 下 ENOENT 走事件不走抛出)、
 * 空命令与预中止**根本不 spawn**。这条缝就是文件里留的那个 `SpawnFn`。
 *
 * Run: scripts/command-runner-smoke/run.sh
 */
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { COMMAND_OUTPUT_TAIL_CHARS } from "@contracts/nodeType";
import { runCommandNode, type SpawnFn } from "@main/orchestration/commandRunner.js";

let failures = 0;
let total = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

function controller(): AbortController {
  return new AbortController();
}

/** 真进程用的那条命令:跨平台(shell:true 下 Windows 是 cmd.exe,其余是 sh)。 */
const NODE_EXIT0 = `node -e "console.log('done')"`;
const NODE_EXIT3 = `node -e "console.error('boom-stderr'); process.exit(3)"`;
const NODE_FLOOD = `node -e "process.stdout.write('M'.repeat(9000)); process.stdout.write('TAILMARK')"`;
const NODE_FOREVER = `node -e "setInterval(function(){},1000)"`;

/* ────────────────────────── 1. 真进程:等它跑完 ────────────────────────── */

console.log("\n真进程 · 正常退出");

{
  const out = await runCommandNode({ command: NODE_EXIT0, timeoutMs: 0, signal: controller().signal });
  eq("非零才算失败之外的情况都是 success", out.status, "success");
  eq("退出码 0 进产出", out.outputs?.["退出码"], 0);
  eq("输出进了产出", out.outputs?.["输出"], "done");
  eq("摘要就是输出", out.summary, "done");
}

console.log("\n真进程 · 非零退出码不算这一步失败");

{
  const out = await runCommandNode({ command: NODE_EXIT3, timeoutMs: 0, signal: controller().signal });
  eq("退出码 3 仍然 success", out.status, "success");
  eq("退出码原样进产出(分流是下游的事)", out.outputs?.["退出码"], 3);
  // stderr 并进尾部 —— 报错的东西恰恰是"跑完了要看的东西"。
  check("stderr 也进了输出尾部", String(out.outputs?.["输出"]).includes("boom-stderr"), out.outputs);
}

console.log("\n真进程 · 超长只留尾部");

{
  const out = await runCommandNode({ command: NODE_FLOOD, timeoutMs: 0, signal: controller().signal });
  eq("仍然 success", out.status, "success");
  eq("尾部不多不少就是上限", String(out.outputs?.["输出"]).length, COMMAND_OUTPUT_TAIL_CHARS);
  check("结尾是最后写的那段(尾部语义,不是头部)", String(out.outputs?.["输出"]).endsWith("TAILMARK"), out.outputs);
}

console.log("\n真进程 · 超时杀掉");

{
  const out = await runCommandNode({ command: NODE_FOREVER, timeoutMs: 500, signal: controller().signal });
  eq("超时是失败", out.status, "failed");
  check("错误说清是谁杀的、怎么防", String(out.error).includes("500") && String(out.error).includes("被杀掉"), out.error);
}

console.log("\n真进程 · 中止杀掉");

{
  const signal = controller();
  const pending = runCommandNode({ command: NODE_FOREVER, timeoutMs: 0, signal: signal.signal });
  // 让进程先起来(它不设防,一直挂着),再按停止。
  await new Promise((r) => setTimeout(r, 300));
  signal.abort();
  const out = await pending;
  eq("中止是 cancelled(不是 failed —— 是人让它停的)", out.status, "cancelled");
}

/* ────────────────────────── 2. 假 spawn:调用契约与错误分叉 ────────────────────────── */

/** 够 `runCommandNode` 用的假 child:三个流式事件源 + pid + 两个测试用的发射器。 */
function fakeChild(opts: { pid?: number } = {}): ChildProcess {
  const ee = new EventEmitter() as unknown as ChildProcess & {
    emitExit: (code: number | null, signal: NodeJS.Signals | null) => void;
    emitError: (err: Error) => void;
  };
  (ee as { pid?: number }).pid = opts.pid;
  (ee as { stdout?: EventEmitter }).stdout = new EventEmitter();
  (ee as { stderr?: EventEmitter }).stderr = new EventEmitter();
  ee.emitExit = (code, signal) => {
    ee.emit("exit", code, signal);
  };
  ee.emitError = (err) => {
    ee.emit("error", err);
  };
  return ee as ChildProcess;
}

/** 收集到的 spawn 调用(命令 + 选项),给"选项契约"那组断言用。 */
function recordingSpawn(child: ChildProcess): { spawn: SpawnFn; calls: Array<{ command: string; options: unknown }> } {
  const calls: Array<{ command: string; options: unknown }> = [];
  const spawn = ((command: string, options: unknown) => {
    calls.push({ command, options });
    // 微任务里就退 —— runCommandNode 的同步段(spawn → 挂监听 → 等 exit)先跑完,
    // 这个 exit 才发得出去、也才有人接。
    queueMicrotask(() => {
      (child as unknown as { emitExit: (c: number | null, s: NodeJS.Signals | null) => void }).emitExit(0, null);
    });
    return child;
  }) as unknown as SpawnFn;
  return { spawn, calls };
}

console.log("\n假 spawn · 调用契约");

{
  const child = fakeChild({ pid: 4321 });
  const { spawn, calls } = recordingSpawn(child);
  const out = await runCommandNode(
    { command: "python train.py", timeoutMs: 0, cwd: "D:/proj", signal: controller().signal },
    { spawn },
  );
  eq("success(假进程退出 0)", out.status, "success");
  eq("就起了一个进程", calls.length, 1);
  eq("命令原样交出去", calls[0]?.command, "python train.py");
  const options = calls[0]?.options as { shell?: boolean; windowsHide?: boolean; cwd?: string; stdio?: string[] } | undefined;
  eq("走 shell(命令是用户写的一整行)", options?.shell, true);
  eq("藏窗口", options?.windowsHide, true);
  eq("工作目录透传(相对路径的命令落在项目里)", options?.cwd, "D:/proj");
  eq("stdout/stderr 都要接住", JSON.stringify(options?.stdio), JSON.stringify(["ignore", "pipe", "pipe"]));
}

console.log("\n假 spawn · 空命令与预中止根本不起进程");

{
  const child = fakeChild();
  const { spawn, calls } = recordingSpawn(child);
  const empty = await runCommandNode({ command: "", timeoutMs: 0, signal: controller().signal }, { spawn });
  eq("空命令是失败", empty.status, "failed");
  check("错误在说命令没填", String(empty.error).includes("没有填"), empty.error);

  const preAborted = await runCommandNode(
    { command: "anything", timeoutMs: 0, signal: AbortSignal.abort() },
    { spawn },
  );
  eq("拿到的 signal 已经中止 → cancelled", preAborted.status, "cancelled");
  eq("两种情况都没起进程", calls.length, 0);
}

console.log("\n假 spawn · spawn 同步抛");

{
  const spawn = (() => {
    throw new Error("bad options");
  }) as unknown as SpawnFn;
  const out = await runCommandNode({ command: "x", timeoutMs: 0, signal: controller().signal }, { spawn });
  eq("同步抛是失败", out.status, "failed");
  check("错误带着原因", String(out.error).includes("命令起不来") && String(out.error).includes("bad options"), out.error);
}

console.log("\n假 spawn · error 事件(shell:true 下 ENOENT 走事件不走抛出)");

{
  const child = fakeChild(); // **pid 还是 undefined** —— shell 都没起来
  const spawn = ((command: string, options: unknown) => {
    queueMicrotask(() => {
      (child as unknown as { emitError: (e: Error) => void }).emitError(new Error("spawn ENOENT"));
      (child as unknown as { emitExit: (c: number | null, s: NodeJS.Signals | null) => void }).emitExit(null, null);
    });
    return child;
  }) as unknown as SpawnFn;
  const out = await runCommandNode({ command: "no-such-tool x", timeoutMs: 0, signal: controller().signal }, { spawn });
  eq("没起来是失败", out.status, "failed");
  check("错误带着 ENOENT", String(out.error).includes("命令起不来") && String(out.error).includes("ENOENT"), out.error);
}

/* ────────────────────────── 3. 流式进来的输出也截尾 ────────────────────────── */

console.log("\n假 spawn · 输出分多块到达时同样只留尾部");

{
  const child = fakeChild({ pid: 7 });
  const spawn = ((command: string, options: unknown) => {
    queueMicrotask(() => {
      const c = child as unknown as {
        stdout: EventEmitter;
        emitExit: (c: number | null, s: NodeJS.Signals | null) => void;
      };
      // 三块:前两块凑 13000(超上限 5000+,第一块要被整个挤出去),最后一块是必须
      // 活下来的那一小段 —— 环形缓冲的语义就是"尾部"。
      c.stdout.emit("data", Buffer.from("A".repeat(5000)));
      c.stdout.emit("data", Buffer.from("B".repeat(8000)));
      c.stdout.emit("data", Buffer.from("LASTCHUNK"));
      c.emitExit(0, null);
    });
    return child;
  }) as unknown as SpawnFn;
  const out = await runCommandNode({ command: "x", timeoutMs: 0, signal: controller().signal }, { spawn });
  const text = String(out.outputs?.["输出"]);
  eq("success", out.status, "success");
  check("总长压在上限内", text.length <= COMMAND_OUTPUT_TAIL_CHARS, text.length);
  check("最后一块在", text.endsWith("LASTCHUNK"), text.slice(-40));
  check("最开头那块被整个挤掉了", !text.startsWith("A") && !text.includes("AAAA"), text.slice(0, 20));
  check("中间那块还在", text.startsWith("B"), text.slice(0, 5));
}

console.log(`\n${total - failures}/${total} checks passed${failures === 0 ? "" : ` — ${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
