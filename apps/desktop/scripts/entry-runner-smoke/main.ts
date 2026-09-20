/**
 * 第三方节点「自带脚本」(runner.entry)那一支的回归网。
 *
 * ## 它钉的是什么
 *
 * 这一支是**从零实现**的(原先 `isNodeRunnable` 遇到 `entry` 直接判不可跑),而它
 * 跑的是**别人写的脚本** —— 所以两类事必须钉死:
 *
 *  1. **路径不许逃出清单目录。** `entry` 是第三方写的,`../../x` 这种写法在词法上
 *     合法、语义上越界。放它过去 = 让插件在用户机器上跑插件目录外的任意文件。
 *  2. **解析基准是清单目录,不是工作流的工作目录。** 弄反了的表现是"脚本找不到"
 *     (插件在 A 目录、工作流在 B 目录),而脚本作者完全没有办法知道这件事。
 *
 * 另外三条与内置 `mcode.command` **逐条对齐**的行为也钉住:非零退出码不算失败、
 * `@@mcode:result` 协议进产出、超时被杀 = 失败。
 *
 * ## 为什么用假 spawn
 *
 * 真起进程就要依赖 `python` / `node` 装在哪、PATH 长什么样,而这套要验的是
 * **我们拼出来的命令行对不对** —— 那件事看 `spawn` 收到的参数就够了,不需要真跑。
 * 真跑一遍留给人工核对。
 *
 * ⚠️ `dataRoot` 不用换桩:这一支不碰数据库,只碰文件系统。
 */
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveEntryScript, runEntryScript } from "@main/orchestration/entryRunner.js";
import type { SpawnFn } from "@main/lib/spawnRun.js";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

const ROOT = mkdtempSync(join(tmpdir(), "mcode-entry-smoke-"));
/** 清单目录 —— 脚本就"随插件"放在这里。 */
const PLUGIN = join(ROOT, "plugins", "myorg.tools");
/** 另一个目录 —— 用来验"不许逃出清单目录"。 */
const OUTSIDE = join(ROOT, "outside");
mkdirSync(PLUGIN, { recursive: true });
mkdirSync(OUTSIDE, { recursive: true });
writeFileSync(join(PLUGIN, "count.py"), "print(1)\n", "utf8");
writeFileSync(join(OUTSIDE, "secret.py"), "print('secret')\n", "utf8");

/* ──────────────── 1. 路径解析:基准与防逃逸 ──────────────── */

console.log("\n路径解析");

eq(
  "正常相对路径 → 落在清单目录里",
  resolveEntryScript("./count.py", PLUGIN),
  join(PLUGIN, "count.py"),
);
eq(
  "不带 ./ 也认",
  resolveEntryScript("count.py", PLUGIN),
  join(PLUGIN, "count.py"),
);
eq(
  "子目录也认",
  resolveEntryScript("scripts/a.py", PLUGIN),
  join(PLUGIN, "scripts", "a.py"),
);

// ★ 防逃逸 —— 这是这一支最要紧的一条
eq(
  "★ `../outside/secret.py` 被拒(不许逃出清单目录)",
  resolveEntryScript("../outside/secret.py", PLUGIN),
  null,
);
eq(
  "★ 多级 `../../` 被拒",
  resolveEntryScript("../../etc/passwd", PLUGIN),
  null,
);
eq(
  "★ 绝对路径被拒(entry 的定义就是相对清单目录)",
  resolveEntryScript(OUTSIDE + "/secret.py", PLUGIN),
  null,
);
// 词法上看着在里层、resolve 之后才越界的写法
eq(
  "★ `sub/../../outside/secret.py` 被拒(resolve 之后才算数)",
  resolveEntryScript("sub/../../outside/secret.py", PLUGIN),
  null,
);
eq(
  "★ 含 NUL 的路径被拒",
  resolveEntryScript("count.py\0.txt", PLUGIN),
  null,
);
eq(
  "清单目录缺席(内置类型) → 拒,不是崩",
  resolveEntryScript("./count.py", undefined),
  null,
);

/* ──────────────── 2. 命令行怎么拼 ──────────────── */

console.log("\n命令行拼法");

/**
 * 够 `spawnRun` 用的假 child —— 三个事件源 + pid + 两个发事件的闸。
 * 写法与 `command-runner-smoke` 逐字同一个形状(那边也是为同一条缝造的)。
 */
function fakeChild(): ChildProcess & {
  emitExit: (code: number | null, signal: NodeJS.Signals | null) => void;
} {
  const ee = new EventEmitter() as unknown as ChildProcess & {
    emitExit: (code: number | null, signal: NodeJS.Signals | null) => void;
  };
  (ee as { pid?: number }).pid = 4242;
  (ee as { stdout?: EventEmitter }).stdout = new EventEmitter();
  (ee as { stderr?: EventEmitter }).stderr = new EventEmitter();
  (ee as { kill?: () => void }).kill = () => {};
  ee.emitExit = (code, signal) => {
    ee.emit("exit", code, signal);
  };
  return ee;
}

/** 记下 spawn 收到了什么,并按剧本回输出与退出码。
 *
 * ⚠️ **签名是 Node 的三参数形**(`command, args, options`)—— 非 shell 那条路才对
 * `args` 有真值,而这一支**永远走非 shell**(见 `entryRunner.ts` 头注)。 */
function recordingSpawn(scripted: { stdout?: string; code?: number }): {
  calls: Array<{ command: string; args: string[]; cwd?: string }>;
  spawn: SpawnFn;
} {
  const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  const spawn = ((command: string, args: string[], options: { cwd?: string }) => {
    const child = fakeChild();
    calls.push({ command, args, ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}) });
    // 微任务里才发 —— `spawnRun` 的同步段(spawn → 挂监听 → 等 exit)要先跑完。
    queueMicrotask(() => {
      if (scripted.stdout) (child as unknown as { stdout: EventEmitter }).stdout.emit("data", Buffer.from(scripted.stdout, "utf8"));
      child.emitExit(scripted.code ?? 0, null);
      child.emit("close", scripted.code ?? 0, null);
    });
    return child;
  }) as unknown as SpawnFn;
  return { calls, spawn };
}

{
  const fake = recordingSpawn({ stdout: "hello\n", code: 0 });
  const out = await runEntryScript(
    {
      script: "./count.py",
      manifestDir: PLUGIN,
      interpreter: "python",
      args: ["--input", "a.txt"],
      timeoutMs: 0,
      signal: new AbortController().signal,
    },
    { spawn: fake.spawn },
  );
  eq("给了 interpreter → 命令就是解释器", fake.calls[0]?.command, "python");
  check(
    "★ 脚本绝对路径是第一个参数,固定参数跟在后面",
    JSON.stringify(fake.calls[0]?.args) === JSON.stringify([join(PLUGIN, "count.py"), "--input", "a.txt"]),
    fake.calls[0]?.args,
  );
  check("★ cwd 是清单目录(不是工作流的工作目录)", fake.calls[0]?.cwd === PLUGIN, fake.calls[0]?.cwd);
  eq("跑通 → success", out.status, "success");
  eq("输出尾部进 summary", out.summary, "hello");
  check("★ 退出码 0 进产出", (out.outputs as { exitCode?: number })?.exitCode === 0, out.outputs);
}

{
  const fake = recordingSpawn({ stdout: "x\n", code: 3 });
  const out = await runEntryScript(
    { script: "./count.py", manifestDir: PLUGIN, timeoutMs: 0, signal: new AbortController().signal },
    { spawn: fake.spawn },
  );
  eq("★ 没给 interpreter → 直接执行脚本本身", fake.calls[0]?.command, join(PLUGIN, "count.py"));
  // 与内置 mcode.command 同一条规矩
  eq("★ 非零退出码**不算失败**", out.status, "success");
  check("★ 退出码照样进产出", (out.outputs as { exitCode?: number })?.exitCode === 3, out.outputs);
}

/* ──────────────── 3. 协议行与失败路径 ──────────────── */

console.log("\n协议与失败");

{
  const fake = recordingSpawn({
    stdout:
      '@@mcode:progress {"percent":50,"message":"读文件中"}\n' +
      "普通输出\n" +
      '@@mcode:result {"summary":"数完了","outputs":{"count":42}}\n',
    code: 0,
  });
  const progress: Array<{ percent?: number }> = [];
  const out = await runEntryScript(
    {
      script: "./count.py",
      manifestDir: PLUGIN,
      timeoutMs: 0,
      signal: new AbortController().signal,
      onProgress: (p) => progress.push(p),
    },
    { spawn: fake.spawn },
  );
  eq("★ 协议行的 summary 盖过输出尾部", out.summary, "数完了");
  check("★ 协议行的 outputs 进产出", (out.outputs as { count?: number })?.count === 42, out.outputs);
  check("协议行进进度回调", progress.some((p) => p.percent === 50), progress);
}

{
  const out = await runEntryScript(
    { script: "./根本没有这个.py", manifestDir: PLUGIN, timeoutMs: 0, signal: new AbortController().signal },
    { spawn: recordingSpawn({}).spawn },
  );
  eq("脚本文件不存在 → 失败", out.status, "failed");
  check("错误里给出它找的那个路径", (out.error ?? "").includes("根本没有这个.py"), out.error);
}

{
  const fake = recordingSpawn({});
  const out = await runEntryScript(
    { script: "../../outside/secret.py", manifestDir: PLUGIN, timeoutMs: 0, signal: new AbortController().signal },
    { spawn: fake.spawn },
  );
  eq("★ 越界路径 → 失败", out.status, "failed");
  check("★ 越界路径**根本没起进程**", fake.calls.length === 0, fake.calls);
  check("错误说的是路径不合法", (out.error ?? "").includes("清单目录"), out.error);
}

{
  const ac = new AbortController();
  ac.abort();
  const fake = recordingSpawn({});
  const out = await runEntryScript(
    { script: "./count.py", manifestDir: PLUGIN, timeoutMs: 0, signal: ac.signal },
    { spawn: fake.spawn },
  );
  eq("已经中止 → cancelled", out.status, "cancelled");
  check("已经中止 → 不 spawn", fake.calls.length === 0, fake.calls);
}

{
  // spawn 抛(ENOENT 那一类在非 shell 下是同步抛或 error 事件)。
  const thrower = (() => {
    throw new Error("spawn count.py ENOENT");
  }) as unknown as SpawnFn;
  const out = await runEntryScript(
    { script: "./count.py", manifestDir: PLUGIN, timeoutMs: 0, signal: new AbortController().signal },
    { spawn: thrower },
  );
  eq("★ 进程起不来 → 失败", out.status, "failed");
  check("错误里带上底层原因", (out.error ?? "").includes("ENOENT"), out.error);
}

try {
  rmSync(ROOT, { recursive: true, force: true });
} catch {
  /* 清理失败不影响结论 */
}

console.log(`\nentry-runner-smoke: ${total - failures}/${total} 通过`);
if (failures > 0) process.exit(1);
