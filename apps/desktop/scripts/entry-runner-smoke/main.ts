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
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveEntryScript, runEntryScript } from "@main/orchestration/entryRunner.js";
import type { SpawnFn } from "@main/lib/spawnRun.js";
import { COMMAND_OUTPUT_TAIL_CHARS } from "@contracts/nodeType";

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

// ★ **junction / 符号链接不许借"看着在里层"的路径逃出去。** 清单目录里一个指向目录外
//   的 junction,词法层(`resolve` 后的前缀比较)认不出它 —— 只有解析链接(realpath)
//   之后才知道物理上已经出了目录。这正是 `pluginManifest.resolveInRoot` 那道闸,本函数
//   头上写着"规则与它同一条"(少了这一闸就是又分了家)。
{
  const LINK = join(PLUGIN, "escape");
  let made = false;
  try {
    if (process.platform === "win32") {
      execFileSync("cmd", ["/c", "mklink", "/J", LINK, OUTSIDE], { stdio: "pipe" });
    } else {
      symlinkSync(OUTSIDE, LINK, "dir");
    }
    made = true;
  } catch {
    // 造不出来(权限/平台)就跳过这一档,别把结论押在造夹具上。
  }
  if (made) {
    eq(
      "★ 清单目录里的 junction 指向目录外 → 越界被拒",
      resolveEntryScript("escape/secret.py", PLUGIN),
      null,
    );
    check(
      "★ 里层的正常文件仍照常解析(junction 那道闸不误伤)",
      resolveEntryScript("./count.py", PLUGIN) === join(PLUGIN, "count.py"),
      resolveEntryScript("./count.py", PLUGIN),
    );
  } else {
    check("（跳过:这个环境建不出 junction 夹具）", true);
  }
}

/* ──────────────── 2. 命令行怎么拼 ──────────────── */

console.log("\n命令行拼法");

/**
 * 够 `spawnRun` 用的假 child —— 三个事件源 + pid + 两个发事件的闸 + stdin 记录。
 * 写法与 `command-runner-smoke` 逐字同一个形状(那边也是为同一条缝造的)。
 * `stdin.end` 收下的东西记进调用方给的 sink —— `bind: stdin` 与 `input` JSON 都从
 * 这里过,断言看的是**真的交给了 stdin 的那份文本**。
 */
function fakeChild(stdinSink: string[]): ChildProcess & {
  emitExit: (code: number | null, signal: NodeJS.Signals | null) => void;
} {
  const ee = new EventEmitter() as unknown as ChildProcess & {
    emitExit: (code: number | null, signal: NodeJS.Signals | null) => void;
  };
  (ee as { pid?: number }).pid = 4242;
  (ee as { stdout?: EventEmitter }).stdout = new EventEmitter();
  (ee as { stderr?: EventEmitter }).stderr = new EventEmitter();
  // A real writable stdin is also an EventEmitter and can emit EPIPE. The
  // fake must preserve that interface so the shared process owner can install
  // its error handler instead of leaving a tested-only mismatch.
  const stdin = new EventEmitter() as EventEmitter & { end: (chunk: string) => void };
  stdin.end = (chunk: string) => { stdinSink.push(String(chunk)); };
  (ee as { stdin?: unknown }).stdin = stdin;
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
  calls: Array<{ command: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv; stdin: string[] }>;
  spawn: SpawnFn;
} {
  const calls: Array<{ command: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv; stdin: string[] }> = [];
  const spawn = ((command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
    const stdin: string[] = [];
    const child = fakeChild(stdin);
    calls.push({
      command,
      args,
      ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options?.env !== undefined ? { env: options.env } : {}),
      stdin,
    });
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

/* 外部脚本刷屏 → 输出被截到尾部时,**必须写出来**(与内置命令节点同一条规矩,
   共用 `lib/outBuf.ts` 的 `markTruncatedTail`)。脚本的输出对下游是"它交了什么",
   一段缺了头的输出若不加说明,下一步会当成完整的用。 */
{
  const fake = recordingSpawn({
    stdout: "A".repeat(COMMAND_OUTPUT_TAIL_CHARS + 2000) + "TAILMARK",
    code: 0,
  });
  const out = await runEntryScript(
    { script: "./count.py", manifestDir: PLUGIN, timeoutMs: 0, signal: new AbortController().signal },
    { spawn: fake.spawn },
  );
  eq("刷屏脚本照样 success", out.status, "success");
  const text = String((out.outputs as { stdout?: string })?.stdout);
  check("★ 截断写在了输出前面", text.startsWith("…(输出超过"), text.slice(0, 60));
  check("★ 说明里带上限字节数", text.includes(String(COMMAND_OUTPUT_TAIL_CHARS)), text.slice(0, 60));
  check("正文仍是尾部(TAILMARK 还在)", text.endsWith("TAILMARK"), text.slice(-30));
  check("★ summary 也带说明(下游读的是它)", String(out.summary).includes("输出超过"), String(out.summary).slice(0, 50));
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
  // ★ **非有限 `percent` 不许进回调。** `1e999` 是合法 JSON 数字,`JSON.parse` 却把它
  //   解成 `Infinity` —— 只判 `typeof === "number"` 拦不住。放它过去会让进度事件带上
  //   `Infinity`,而两端处置还不一样:桌面端夹到 100%、手机端过 `JSON.stringify` 变成
  //   `null` 再夹到 0%(同一步在两端显示成两个数)。兄弟 `commandRunner` / `codeRunner`
  //   的同名函数都有 `Number.isFinite` 守卫(`codeRunner` 是 af9ccaa1 补的),这一支漏了。
  const fake = recordingSpawn({
    stdout: '@@mcode:progress {"percent":1e999,"message":"疯进度"}\n',
    code: 0,
  });
  const progress: Array<{ percent?: number; message?: string }> = [];
  await runEntryScript(
    {
      script: "./count.py",
      manifestDir: PLUGIN,
      timeoutMs: 0,
      signal: new AbortController().signal,
      onProgress: (p) => progress.push(p),
    },
    { spawn: fake.spawn },
  );
  // message 是字符串,照样收;只有非有限的 percent 被丢。
  check("★ message 照常进回调(只丢非有限的 percent)", progress.some((p) => p.message === "疯进度"), progress);
  check("★ 非有限 percent 被丢(不进回调,跟 commandRunner/codeRunner 对齐)", progress.every((p) => p.percent === undefined), progress);
}

{
  // ★ **畸形协议 payload 不许把结果污染成非字符串。** 协议行是**第三方脚本**打的,
  //   一个手滑(把 summary 打成一个对象/数字)曾会让 `state.result` 原样收下整个 payload
  //   —— 于是 `NodeOutcome.summary` 变成非字符串,而下游调度器的 `producedTextOf` 拿它
  //   `.trim()`,**整条运行当场抛**(不止这一步失败)。`commandRunner` 早就是逐字段收的,
  //   这一支必须与它对齐。
  const fake = recordingSpawn({
    stdout:
      '@@mcode:result {"summary":{"中":"毒"},"outputs":[1,2]}\n' +
      "hello\n",
    code: 0,
  });
  const out = await runEntryScript(
    { script: "./count.py", manifestDir: PLUGIN, timeoutMs: 0, signal: new AbortController().signal },
    { spawn: fake.spawn },
  );
  eq("★ 畸形协议的 summary(对象)被丢,退回输出尾部", out.summary, "hello");
  check("★ summary 一定是字符串(下游 .trim() 不会抛)", typeof out.summary === "string", out.summary);
  // 数组不是合法的 outputs —— 原样收的话会把下标 `0`/`1` 铺进产出对象。
  check("★ 非对象的 outputs 被丢(没有把数组下标铺进产出)", !("0" in (out.outputs ?? {})), out.outputs);
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

/* ──────────────── 4. bind:参数怎么送到脚本手上 ──────────────── */

console.log("\nbind · argv / env / stdin");

{
  // ★ `arg`(带 flag)、位置参数、`env`、`stdin` 四种声明一次走完。契约(见
  //   `NodeParamBindingSchema`)是唯一语义出处:带 flag 的追加 `flag 值` 两个参数,
  //   不带 flag 的按**声明顺序**做位置参数,env 名原样,stdin 拿到值本身。
  const fake = recordingSpawn({ stdout: "ok\n", code: 0 });
  const out = await runEntryScript(
    {
      script: "./count.py",
      manifestDir: PLUGIN,
      interpreter: "python",
      args: ["--fixed", "yes"],
      timeoutMs: 0,
      signal: new AbortController().signal,
      bindings: [
        { binding: { kind: "arg", flag: "--input" }, value: "带空格 的\"值\";$(rm -rf /)" },
        { binding: { kind: "arg" }, value: "pos-1" },
        { binding: { kind: "arg", flag: "--n" }, value: 42 },
        { binding: { kind: "env", name: "INPUT_FILE" }, value: "a b.txt" },
        { binding: { kind: "stdin" }, value: "payload line\n" },
      ],
    },
    { spawn: fake.spawn },
  );
  eq("★ bind 节点跑通", out.status, "success");
  check(
    "★ flag 追加两个独立参数;位置参数按声明顺序;排在 runner.args 之后",
    JSON.stringify(fake.calls[0]?.args) === JSON.stringify([
      join(PLUGIN, "count.py"), "--fixed", "yes",
      "--input", "带空格 的\"值\";$(rm -rf /)", "pos-1", "--n", "42",
    ]),
    fake.calls[0]?.args,
  );
  // ★ 值**不进 shell 解析**:引号、分号、`$()` 原样是一个 argv 元素,脚本收到的就是它。
  check(
    "★ 带引号/分号/命令替换的值原样是一个 argv 元素(不经 shell)",
    fake.calls[0]?.args.includes("带空格 的\"值\";$(rm -rf /)") === true,
    fake.calls[0]?.args,
  );
  eq("★ env 绑定按声明写进环境变量", fake.calls[0]?.env?.INPUT_FILE, "a b.txt");
  check(
    "★ env 是叠加在继承环境之上的(脚本照常看得到 PATH)",
    fake.calls[0]?.env?.PATH === process.env.PATH || fake.calls[0]?.env?.Path !== undefined,
    { PATH: fake.calls[0]?.env?.PATH, Path: fake.calls[0]?.env?.Path },
  );
  eq("★ stdin 绑定写到进程的 stdin", fake.calls[0]?.stdin[0], "payload line\n");
}

{
  // ★ 没声明 bind 的节点:不传 env(继承父进程)、stdin 仍走 input 的 JSON ——
  //   也就是**这个字段存在之前**的行为一字不差。
  const fake = recordingSpawn({ stdout: "ok\n", code: 0 });
  await runEntryScript(
    {
      script: "./count.py",
      manifestDir: PLUGIN,
      input: { a: 1 },
      timeoutMs: 0,
      signal: new AbortController().signal,
    },
    { spawn: fake.spawn },
  );
  eq("没声明 bind → 不给 env(继承父进程)", fake.calls[0]?.env, undefined);
  eq("没声明 bind → stdin 仍是 input 的 JSON", fake.calls[0]?.stdin[0], '{"a":1}\n');
}

{
  // ★ `stdin` 绑定与 `input` 同时在场:按**声明**来 —— 作者明确说了这个参数走 stdin,
  //   而 input 只是命令节点的默认载荷。两个都写只会有一个生效,静默选错的那个更坏。
  const fake = recordingSpawn({ stdout: "ok\n", code: 0 });
  await runEntryScript(
    {
      script: "./count.py",
      manifestDir: PLUGIN,
      input: { upstream: true },
      timeoutMs: 0,
      signal: new AbortController().signal,
      bindings: [{ binding: { kind: "stdin" }, value: "bound-text" }],
    },
    { spawn: fake.spawn },
  );
  eq("★ stdin 绑定盖过 input 的 JSON(声明优先)", fake.calls[0]?.stdin[0], "bound-text");
}

{
  // ★ 非字符串值转文本:数字/布尔按字面,对象按 JSON —— 与 stdin 的 JSON 读法一致。
  const fake = recordingSpawn({ stdout: "ok\n", code: 0 });
  await runEntryScript(
    {
      script: "./count.py",
      manifestDir: PLUGIN,
      timeoutMs: 0,
      signal: new AbortController().signal,
      bindings: [
        { binding: { kind: "arg", flag: "--flag" }, value: true },
        { binding: { kind: "arg" }, value: { k: "v" } },
      ],
    },
    { spawn: fake.spawn },
  );
  check(
    "★ 布尔与对象值转成文本进 argv",
    // 没给 interpreter → 脚本本身是命令,argv 里只有绑定参数(见上面「直接执行脚本本身」)。
    JSON.stringify(fake.calls[0]?.args) === JSON.stringify(["--flag", "true", '{"k":"v"}']),
    fake.calls[0]?.args,
  );
}

/* ──────────────── Direct plugin/IPC caller boundary ──────────────── */
{
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  for (const input of [1n, cyclic]) {
    const fake = recordingSpawn({ stdout:"should not execute" });
    let outcome: Awaited<ReturnType<typeof runEntryScript>> | undefined;
    let thrown: unknown;
    try {
      outcome = await runEntryScript({script:"./count.py",manifestDir:PLUGIN,input,
        timeoutMs:1000,signal:new AbortController().signal},{spawn:fake.spawn});
    } catch (err) { thrown=err; }
    check("★ malformed unencodable input is structured failure, not Promise rejection",
      thrown===undefined && outcome?.status==="failed" &&
        /stdin|JSON|输入/.test(String(outcome.error)) && fake.calls.length===0,
      {outcome,thrown:String(thrown),spawns:fake.calls.length});
  }
  for (const timeoutMs of [NaN,Infinity,-1,1.5,2_147_483_648]) {
    const fake=recordingSpawn({stdout:"should not execute"});
    let outcome:Awaited<ReturnType<typeof runEntryScript>>|undefined;
    let thrown:unknown;
    try {
      outcome=await runEntryScript({script:"./count.py",manifestDir:PLUGIN,timeoutMs,
        signal:new AbortController().signal},{spawn:fake.spawn});
    } catch (err) { thrown=err; }
    check("★ direct unsafe timeout fails before spawning any plugin interpreter",
      thrown===undefined && outcome?.status==="failed" &&
        /timeout|超时|毫秒/.test(String(outcome.error)) && fake.calls.length===0,
      {timeoutMs:String(timeoutMs),status:outcome?.status,error:outcome?.error,spawns:fake.calls.length,thrown:String(thrown)});
  }
  for (const bindings of [
    [{binding:{kind:"env",name:"__proto__"},value:"forged"}],
    [{binding:{kind:"stdin"},value:"one"},{binding:{kind:"stdin"},value:"two"}],
  ]) {
    const fake=recordingSpawn({stdout:"should not execute"});
    let outcome:Awaited<ReturnType<typeof runEntryScript>>|undefined;
    let thrown:unknown;
    try {
      outcome=await runEntryScript({script:"./count.py",manifestDir:PLUGIN,
        timeoutMs:1000,signal:new AbortController().signal,
        bindings:bindings as never},{spawn:fake.spawn});
    } catch(err){thrown=err;}
    check("★ malformed direct bind declarations fail closed, not silently mutate/override",
      thrown===undefined && outcome?.status==="failed" &&
        /bind|绑定|stdin|env/.test(String(outcome.error)) && fake.calls.length===0,
      {outcome,spawns:fake.calls.length,thrown:String(thrown)});
  }
  const invalid=recordingSpawn({stdout:"should not execute"});
  let brokenScript:Awaited<ReturnType<typeof runEntryScript>>|undefined;
  let scriptThrown:unknown;
  try {
    brokenScript=await runEntryScript({script:42 as unknown as string,manifestDir:PLUGIN,timeoutMs:1000,
      signal:new AbortController().signal},{spawn:invalid.spawn});
  } catch(err){scriptThrown=err;}
  check("★ non-text plugin script path is rejected without TypeError/spawn",
    scriptThrown===undefined && brokenScript?.status==="failed" && invalid.calls.length===0,
    {status:brokenScript?.status,spawns:invalid.calls.length,thrown:String(scriptThrown)});
}

{
  for (const fixture of [
    { interpreter: 47 as unknown as string },
    { args: ["--safe", 22] as unknown as string[] },
    { manifestDir: {not:"a directory"} as unknown as string },
    { bindings: [{binding:{kind:"arg"},value:()=>42}] as never },
  ]) {
    const fake=recordingSpawn({stdout:"SHOULD_NOT_RUN"});
    let outcome:Awaited<ReturnType<typeof runEntryScript>>|undefined;
    let thrown:unknown;
    try {
      outcome=await runEntryScript({script:"count.py",manifestDir:PLUGIN,timeoutMs:1200,
        signal:new AbortController().signal,...fixture},{spawn:fake.spawn});
    } catch(err){thrown=err;}
    check("★ wrong direct manifest/interpreter/argv/bound value shape fails safely before spawn",
      thrown===undefined && outcome?.status==="failed" && fake.calls.length===0,
      {fixture:Object.keys(fixture),status:outcome?.status,error:outcome?.error,spawns:fake.calls.length,thrown:String(thrown)});
  }
  // A third-party bind serializer may throw an arbitrary JavaScript value
  // that cannot be converted to String. Catch/error reporting must not throw.
  const nonCoercible = Object.create(null) as Record<string, unknown>;
  const malicious = { toJSON() { throw nonCoercible; } };
  const throwingToString = { toJSON() { throw { toString() { throw new Error("SECONDARY"); } }; } };
  const accessorError = new Error("base");
  Object.defineProperty(accessorError, "message", { get() { throw nonCoercible; } });
  for (const badValue of [malicious, throwingToString, {toJSON(){throw accessorError;}}]) {
    const fake=recordingSpawn({stdout:"SHOULD_NOT_RUN"});
    let result:Awaited<ReturnType<typeof runEntryScript>>|undefined;
    let thrown:unknown;
    try {
      result=await runEntryScript({script:"count.py",manifestDir:PLUGIN,timeoutMs:1000,
        signal:new AbortController().signal,
        bindings:[{binding:{kind:"arg"},value:badValue}]},{spawn:fake.spawn});
    } catch (err) { thrown=err; }
    check("★ arbitrary noncoercible errors from plugin JSON serialization are structured failure",
      thrown===undefined && result?.status==="failed" && fake.calls.length===0
        && typeof result.error==="string" && result.error.length>0,
      {status:result?.status, error:result?.error, rejected:thrown!==undefined, spawnCalls:fake.calls.length});
  }
  const progress:Array<{percent?:number;message?:string}>=[];
  const fake=recordingSpawn({stdout:[
    '@@mcode:progress {"percent":-1,"message":"low"}',
    '@@mcode:progress {"percent":175,"message":"high"}',
    '@@mcode:progress {"percent":25,"message":"valid"}',
    "",
  ].join("\n")});
  const out=await runEntryScript({script:"count.py",manifestDir:PLUGIN,
    timeoutMs:1200,signal:new AbortController().signal,
    onProgress:(p)=>progress.push(p)},{spawn:fake.spawn});
  eq("progress-check fixture exits successfully",out.status,"success");
  check("★ entry script negative progress does not enter the UI percentage",
    progress[0]?.percent===undefined,progress);
  check("★ entry script progress over 100 does not enter the UI percentage",
    progress[1]?.percent===undefined,progress);
  eq("entry script valid progress remains intact",progress[2]?.percent,25);
  eq("entry script invalid percentage keeps human message",progress[1]?.message,"high");
}

// The entry runner can be called directly by third-party modules rather
// than through the scheduler. Forged cancellation must never reject a run.
{
  for(const bad of [null,{},Object.create(null),{get aborted(){throw Object.create(null);}}]){
    const fake=recordingSpawn({stdout:"SHOULD_NOT_RUN"});
    let outcome:Awaited<ReturnType<typeof runEntryScript>>|undefined;
    let rejected=false;
    try{outcome=await runEntryScript({script:"./count.py",manifestDir:PLUGIN,
      timeoutMs:1000,signal:bad as AbortSignal},{spawn:fake.spawn});}
    catch{rejected=true;}
    check("★ entry API rejects forged AbortSignal as failed outcome without spawn",
      !rejected&&outcome?.status==="failed"&&fake.calls.length===0,
      {status:outcome?.status,rejected,spawns:fake.calls.length});
  }
}
try {
  rmSync(ROOT, { recursive: true, force: true });
} catch {
  /* 清理失败不影响结论 */
}

console.log(`\nentry-runner-smoke: ${total - failures}/${total} 通过`);
if (failures > 0) process.exit(1);
