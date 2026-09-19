/**
 * Headless smoke for 钩子.
 *
 * 两块:
 *
 * 1. **纯逻辑** —— 匹配规则、校验、`hooks.json` 的容忍规则。这三种是"配错了不会报错,
 *    只会安静地不跑"的地方。
 * 2. **真起进程** —— `runCommand.ts` 的 `runHookCommand`,喂**真的**命令、真的子进程,
 *    验超时杀树、输出上限、stdin 载荷、环境变量、退出码。它是唯一会起进程的一段,
 *    写错了会在用户机器上留僵尸进程或者卡住一次对话。
 *
 * `HookRunner` 自己(事件匹配 → 执行记录的环、并发互斥、按 mtime 重读)在
 * **`scripts/hook-runner-smoke`** 里 —— 那一段原先写在这里说"要活的 RuntimeManager
 * 和真会话,验不了",后来发现整条链上真正会出错的那几段都不需要真会话,只要换掉
 * RuntimeManager 那一个模块就能全走一遍。这一套只管到 `runHookCommand` 为止。
 *
 * Run: scripts/hooks-smoke/run.sh
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_HOOK_TIMEOUT_MS,
  HOOK_EVENTS,
  HOOK_OUTPUT_LIMIT,
  hookSubjectOf,
  matchesHook,
  parseHooksFile,
  validateHook,
  type HookPayload,
  type HookSpec,
} from "@contracts/hook";
import { decodeOutput, runHookCommand } from "@main/hooks/runCommand.js";
import { readHooks, removeHook, saveHook } from "@main/hooks/store.js";

let failures = 0;
let checks = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  checks += 1;
  if (cond) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 等子进程把自己的 pid 写出来(它是 `writeFileSync`,但要等进程真的起来)。 */
function waitForPidFile(file: string): number | null {
  for (let i = 0; i < 40; i += 1) {
    try {
      const pid = Number(readFileSync(file, "utf-8"));
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {
      /* 还没写出来 */
    }
    // 同步等:这一段在顶层 await 之前,没有别的事可做。
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return null;
}

/** 这个 pid 还活着吗。`process.kill(pid, 0)` 不发信号,只探存在性。 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 一条钩子的底稿。每个用例只改它关心的那一两个字段。 */
function hook(patch: Partial<HookSpec> = {}): HookSpec {
  return {
    id: "h_test",
    name: "测试钩子",
    event: "tool.use",
    command: "echo hi",
    enabled: true,
    ...patch,
  };
}

/* ────────────────────── 1. 匹配 ────────────────────── */

console.log("\nmatchesHook(什么时候该跑)");

check("事件对上、开着 → 跑", matchesHook(hook(), "tool.use", ["Edit"]));
check("关掉的钩子不跑", !matchesHook(hook({ enabled: false }), "tool.use", ["Edit"]));
check("事件不对不跑", !matchesHook(hook(), "tool.result", ["Edit"]));
check("没有匹配规则 = 所有工具", matchesHook(hook(), "tool.use", ["随便什么工具"]));
check("带工具名的事件,没给工具名也能跑(没有规则时)", matchesHook(hook(), "tool.use"));

// 精确 / 大小写 / 多值
check("精确匹配", matchesHook(hook({ matcher: "Edit" }), "tool.use", ["Edit"]));
check("对不上就不跑", !matchesHook(hook({ matcher: "Edit" }), "tool.use", ["Write"]));
check("大小写不敏感", matchesHook(hook({ matcher: "edit" }), "tool.use", ["Edit"]));
check("逗号分隔多个,命中一个就行", matchesHook(hook({ matcher: "Bash, Edit" }), "tool.use", ["Edit"]));
check("逗号两边的空格不算数", matchesHook(hook({ matcher: "  Bash ,  Edit  " }), "tool.use", ["Edit"]));

// glob
check("* 匹配任意多个字符", matchesHook(hook({ matcher: "mcp__*" }), "tool.use", ["mcp__github__search"]));
check("* 也能匹配空", matchesHook(hook({ matcher: "mcp__*" }), "tool.use", ["mcp__"]));
check("? 匹配一个字符", matchesHook(hook({ matcher: "Rea?" }), "tool.use", ["Read"]));
check("? 不匹配两个字符", !matchesHook(hook({ matcher: "Rea?" }), "tool.use", ["Readd"]));
check("* 不是万能的", !matchesHook(hook({ matcher: "Read*" }), "tool.use", ["Write"]));
// glob 里的正则元字符要按**字面**处理 —— 否则一个工具名里的点会变成"任意字符"。
check("点号按字面处理", matchesHook(hook({ matcher: "a.b" }), "tool.use", ["a.b"]));
check("点号不等于任意字符", !matchesHook(hook({ matcher: "a.b" }), "tool.use", ["axb"]));

// 空 / 笔误
check("空白串 = 没有限制", matchesHook(hook({ matcher: "   " }), "tool.use", ["任意"]));
// 只写了分隔符是个笔误。两种解释里"不限制"是安全的那种:钩子会跑起来,用户当场就
// 看得见;当成"什么都不匹配"则永远不响,那是最难查的一种坏。
check("只写逗号 = 没有限制(笔误按安全的那边解释)", matchesHook(hook({ matcher: ",,," }), "tool.use", ["任意"]));
check(
  "逗号里混着空项,有效的那项照常生效",
  matchesHook(hook({ matcher: ", Edit ," }), "tool.use", ["Edit"]),
);

// 没有主语的事件
check(
  "没有主语的事件 + 写了匹配规则 → 不跑(配错了,界面上会被拦住)",
  !matchesHook(hook({ event: "turn.done", matcher: "Edit" }), "turn.done"),
);
check("没有主语的事件 + 空白规则 → 照常跑", matchesHook(hook({ event: "turn.done", matcher: "  " }), "turn.done"));

// 一次给**多个**主语(`turn.files` 一轮改好几个文件)—— 命中任一个就算。
const MANY = ["D:/proj/src/a.ts", "src/a.ts", "D:/proj/README.md", "README.md"];
check("多个主语里命中一个就行", matchesHook(hook({ event: "turn.files", matcher: "*.md" }), "turn.files", MANY));
check("一个都没命中才不跑", !matchesHook(hook({ event: "turn.files", matcher: "*.py" }), "turn.files", MANY));
check("空列表(这一轮没改文件)= 不跑", !matchesHook(hook({ event: "turn.files", matcher: "*.ts" }), "turn.files", []));
// 绝对路径和相对路径都给,所以两种写法都该认 —— 只给绝对路径的话 `src/*.ts` 永远匹配
// 不上(真实路径是 `D:/proj/src/a.ts`)。
check("相对写法 src/*.ts 认", matchesHook(hook({ event: "turn.files", matcher: "src/*.ts" }), "turn.files", MANY));
check("只写文件名 package.json 也认", matchesHook(hook({ event: "turn.files", matcher: "*.md" }), "turn.files", MANY));
check("同一个模式的多个主语只编译一次也照样对", matchesHook(hook({ event: "turn.files", matcher: "*.ts" }), "turn.files", MANY));

console.log("\n每个事件的 matcher 比什么");
const SUBJECTS: Record<string, string> = {
  "tool.use": "tool",
  "tool.result": "tool",
  "approval.request": "tool",
  "turn.files": "path",
};
for (const event of HOOK_EVENTS) {
  eq(`${event} → ${SUBJECTS[event] ?? "没有可比的东西"}`, hookSubjectOf(event), SUBJECTS[event] ?? null);
}
// 事件的顺序就是设置页下拉的顺序,按一轮的生命周期排 —— 首尾钉死,免得改的时候顺手挪乱。
eq("第一个事件是一轮的开始", HOOK_EVENTS[0], "user.message");
// 统一资料库后,`library.item.imported`(应用内事件,无可比主语)排在生命周期之后
// —— 所以"最后一个"改判"包含 + 倒数第二",而不是死咬末位。
check("末段有工作流节点结果", HOOK_EVENTS.slice(-2).includes("workflow.node.result"), HOOK_EVENTS.slice(-2));
check("事件不重复", new Set(HOOK_EVENTS).size === HOOK_EVENTS.length);

/* ────────────────────── 2. 校验 ────────────────────── */

console.log("\nvalidateHook(存之前挡住配错的)");

check("带工具名的事件 + 匹配规则 → 过", validateHook(hook({ matcher: "Edit" })).ok);
check("带工具名的事件、没写规则 → 过", validateHook(hook()).ok);
// 「有主语」不止工具名一种 —— `turn.files` 按路径筛,那也是合法的。
check("按文件路径筛 → 过", validateHook(hook({ event: "turn.files", matcher: "*.ts" })).ok);
check("不带工具名的事件、没写规则 → 过", validateHook(hook({ event: "error" })).ok);
const mismatched = validateHook(hook({ event: "error", matcher: "Edit" }));
check("不带工具名的事件 + 写了规则 → 拒", !mismatched.ok);
check(
  "拒的时候说清为什么",
  !mismatched.ok && mismatched.error.includes("工具名"),
  !mismatched.ok ? mismatched.error : null,
);
// 空白规则在**校验**这一层算"没写"(和 matchesHook 的判据一致)—— 否则一个只打了
// 几个空格的人会看到一句莫名其妙的错误。
check("只有空白的规则不算写了", validateHook(hook({ event: "error", matcher: "   " })).ok);

/* ────────────────────── 3. hooks.json 的格式 ────────────────────── */

console.log("\nparseHooksFile(用户手改的那个文件)");

eq("空文件 = 一条都没有(不是错误)", parseHooksFile("").hooks.length, 0);
eq("空文件的 problems 是空的", parseHooksFile("   \n  ").problems.length, 0);

const broken = parseHooksFile("{ 这不是 JSON");
eq("不是 JSON → 没有钩子", broken.hooks.length, 0);
eq("不是 JSON → 一条 problem", broken.problems.length, 1);
check("那条 problem 说得清是哪儿", broken.problems[0].where.includes("hooks.json"));

// 顶层两种形状都认:对象包一层是应用写出去的,直接给数组是用户手写时最自然的写法。
const wrapped = parseHooksFile(JSON.stringify({ version: 1, hooks: [hook()] }));
eq("对象包一层 → 认", wrapped.hooks.length, 1);
eq("对象包一层 → 没有 problem", wrapped.problems.length, 0);
const bare = parseHooksFile(JSON.stringify([hook()]));
eq("顶层直接是数组 → 也认", bare.hooks.length, 1);
eq("顶层直接是数组 → 没有 problem", bare.problems.length, 0);

eq("顶层是数字 → 一条 problem", parseHooksFile("42").problems.length, 1);
eq("hooks 不是数组 → 一条 problem", parseHooksFile(JSON.stringify({ hooks: 3 })).problems.length, 1);

// 坏条目跳过、好的照常 —— 一条写坏的不该让别的钩子一起失效。
const mixed = parseHooksFile(
  JSON.stringify({ hooks: [hook({ id: "h_a", name: "好的" }), { id: "h_b" }, hook({ id: "h_c", name: "也是好的" })] }),
);
eq("坏的那条被跳过", mixed.hooks.length, 2);
eq("好的两条都在", mixed.hooks.map((h) => h.id).join(","), "h_a,h_c");
eq("坏的那条记了一条 problem", mixed.problems.length, 1);
check("problem 里带序号(能在文件里找到是哪条)", mixed.problems[0].where.includes("第 2 条"), mixed.problems[0].where);

const dup = parseHooksFile(JSON.stringify({ hooks: [hook({ id: "h_x", name: "第一条" }), hook({ id: "h_x", name: "第二条" })] }));
eq("id 重复只留第一条", dup.hooks.length, 1);
eq("留的是第一条", dup.hooks[0].name, "第一条");
eq("重复的那条记了一条 problem", dup.problems.length, 1);

// 格式校验之外还有**语义**校验(见 validateHook),两处用同一份判据。
const wrongEvent = parseHooksFile(JSON.stringify({ hooks: [hook({ event: "error", matcher: "Edit" })] }));
eq("语义不对的条目也进不来", wrongEvent.hooks.length, 0);
eq("而且说了原因", wrongEvent.problems.length, 1);

const emptyCmd = parseHooksFile(JSON.stringify({ hooks: [hook({ command: "" })] }));
eq("空命令进不来(契约里 min(1))", emptyCmd.hooks.length, 0);
eq("空命令记了一条 problem", emptyCmd.problems.length, 1);

/* ────────────────────── 4. 默认值 ────────────────────── */

console.log("\n默认值");

eq("默认超时是 30 秒", DEFAULT_HOOK_TIMEOUT_MS, 30_000);
// 一条不带 timeoutMs 的钩子照样能存(它是可选的)。
eq("省略超时也能存", parseHooksFile(JSON.stringify({ hooks: [hook({ timeoutMs: undefined })] })).hooks.length, 1);

/* ────────────────────── 5. 真起进程 ────────────────────── */

console.log("\nrunHookCommand(真跑一条命令)");

const dir = mkdtempSync(join(tmpdir(), "mcode-hooks-smoke-"));
// 反斜杠换成正斜杠:命令是交给 shell 的,而这条路径要同时活过 cmd.exe 和 sh。
const nodeExe = process.execPath.replace(/\\/g, "/");
const script = (name: string): string => `"${nodeExe}" "${join(dir, name).replace(/\\/g, "/")}"`;

function write(name: string, body: string): string {
  writeFileSync(join(dir, name), body, "utf-8");
  return script(name);
}

function payload(patch: Partial<HookPayload> = {}): HookPayload {
  return {
    event: "tool.use",
    at: Date.now(),
    session: { id: "s_test", kind: "chat", title: "测试会话", projectId: "p_test" },
    cwd: process.cwd(),
    toolName: "Edit",
    data: { type: "tool.use", toolName: "Edit" },
    ...patch,
  };
}

/** 把子进程里看到的东西原样报回来 —— 载荷和环境变量各走各的路,都得验。 */
const ECHO = write(
  "echo.js",
  `let s = ""; process.stdin.setEncoding("utf8");
   process.stdin.on("data", (d) => { s += d; });
   process.stdin.on("end", () => process.stdout.write(JSON.stringify({
     env: {
       event: process.env.MCODE_EVENT,
       sessionId: process.env.MCODE_SESSION_ID,
       sessionKind: process.env.MCODE_SESSION_KIND,
       cwd: process.env.MCODE_CWD,
       toolName: process.env.MCODE_TOOL_NAME,
     },
     cwd: process.cwd(),
     stdin: s,
   })));`,
);

try {
  /* 正常跑通 */
  const ok = await runHookCommand(hook({ command: ECHO }), payload({ cwd: dir }));
  eq("正常结束 → ok", ok.status, "ok");
  eq("退出码 0", ok.exitCode, 0);
  eq("ok 时不带 error", ok.error, undefined);

  const seen = JSON.parse(ok.stdout ?? "{}") as {
    env: Record<string, string | undefined>;
    cwd: string;
    stdin: string;
  };

  /* 载荷走 stdin */
  const fed = JSON.parse(seen.stdin) as HookPayload;
  eq("stdin 拿到的是完整载荷", fed.event, "tool.use");
  eq("载荷里的会话 id 没丢", fed.session.id, "s_test");
  eq("载荷里的原始事件原样带过去", (fed.data as { type: string }).type, "tool.use");
  check("载荷里的中文没被转坏", fed.session.title === "测试会话", fed.session.title);

  /* 环境变量那条路 */
  eq("MCODE_EVENT", seen.env.event, "tool.use");
  eq("MCODE_SESSION_ID", seen.env.sessionId, "s_test");
  eq("MCODE_SESSION_KIND(节点会话要靠它区分)", seen.env.sessionKind, "chat");
  eq("MCODE_TOOL_NAME", seen.env.toolName, "Edit");
  eq("MCODE_CWD", seen.env.cwd, dir);

  /* 工作目录真的切过去了(上面那条只是环境变量,这条是进程自己的 cwd) */
  eq("命令在会话的目录里跑", seen.cwd.replace(/\\/g, "/").toLowerCase(), dir.replace(/\\/g, "/").toLowerCase());

  /* 工作目录没了(工作树被删、项目被移除)—— 不能让整条钩子起不来 */
  const gone = await runHookCommand(
    hook({ command: ECHO }),
    payload({ cwd: join(dir, "已经不存在的", "子目录") }),
  );
  eq("cwd 不存在时照跑(退回宿主目录)", gone.status, "ok");

  /* 非零退出 */
  const bad = await runHookCommand(hook({ command: write("fail.js", "process.exit(3)") }), payload());
  eq("非零退出 → failed", bad.status, "failed");
  eq("退出码记下来了", bad.exitCode, 3);
  check("error 里说了是几", bad.error?.includes("3") === true, bad.error);

  /* 命令不存在 */
  const missing = await runHookCommand(hook({ command: "mcode-没有这个命令" }), payload());
  eq("命令不存在 → failed", missing.status, "failed");
  check("命令不存在时有可读的原因", (missing.error?.length ?? 0) > 0, missing.error);
  // cmd.exe 的提示是它用自己的代码页打的(中文机器上是 GBK)。解错编码时整句话会变成
  // U+FFFD,而用户唯一能得到的线索正是那句话。
  check("cmd 的提示里没有乱码", missing.stderr?.includes("�") !== true, missing.stderr);

  /* 编码:命令的输出未必是 UTF-8 */
  // "命令" 的 GBK 字节 —— 从 cmd.exe 自己的提示里取的(`c3bb d3d0 d5e2 b8f6 c3fc c1ee`
  // 是"没有这个命令")。先证明这段字节按 UTF-8 解**确实**是乱的,下面那条断言才不是空的。
  const gbkBytes = Buffer.from([0xc3, 0xfc, 0xc1, 0xee]);
  check(
    "同一段 GBK 字节按 UTF-8 解确实是乱码(所以下面那条有意义)",
    new TextDecoder("utf-8").decode(gbkBytes).includes("�"),
  );
  eq("GBK 字节被认出来", decodeOutput(gbkBytes), "命令");
  // 结尾那一刀是**UTF-8 的规则**,不能拿去切 GBK 的字节 —— 否则最后那个字节会被当成
  // "半个字符"削掉。这段的末字节 0xD0 看着就像某个 UTF-8 序列的头。
  eq("GBK 字节的结尾没被当成半个 UTF-8 字符削掉", decodeOutput(Buffer.from([0xc3, 0xbb, 0xd3, 0xd0])), "没有");
  // **开头同理,而且更容易踩。** GBK 的首字节范围是 0x81-0xFE,与 UTF-8 **续字节**的
  // 区间(0x80-0xBF)重叠 —— 于是 `0xbb` 这种合法的 GBK 首字节会被"削掉开头落单续字节"
  // 那一刀切掉,后面整段跟着错位。
  //
  // 这一条是 2026-09-18 那次重构发现的真实缺陷:代码节点/命令节点改成**逐行解码**之后,
  // cmd.exe 那句「或批处理文件。」(首字节 0xBB)整行变成了「蚺砦募」。原先整体解码时
  // 第一行以 `'`(0x27)开头,碰巧躲过了这一刀 —— 所以这个 bug 一直在,只是没暴露。
  eq(
    "GBK 的首字节不是 UTF-8 续字节,不能被削",
    decodeOutput(Buffer.from([0xbb, 0xf2, 0xc5, 0xfa, 0xb4, 0xa6, 0xa1, 0xa3])),
    "或批处。",
  );
  eq(
    "首字节落在 0x80-0xBF 的 GBK 整句照常解出",
    decodeOutput(Buffer.from([0xbb, 0xf2, 0xc5, 0xfa, 0xb4, 0xa6, 0xc0, 0xed, 0xce, 0xc4, 0xbc, 0xfe, 0xa1, 0xa3])),
    "或批处理文件。",
  );
  eq("本来就是 UTF-8 的不受影响", decodeOutput(Buffer.from("中文命令", "utf8")), "中文命令");
  eq("空输出", decodeOutput(Buffer.alloc(0)), "");
  // 窗口从**中间**截出来时,开头会落在一个多字节字符的半截上(只剩续字节)。留着它,
  // 解码器会以为"这段不是 UTF-8",进而错判成 GBK。
  const cut = Buffer.from("中文命令", "utf8").subarray(1); // "中" 的首字节被切掉了
  eq("窗口开头半截字符被丢掉,后面的照常", decodeOutput(cut), "文命令");
  check("切之前确实是乱的(所以上面那条有意义)", new TextDecoder("utf-8").decode(cut).includes("�"));
  // 结尾同理:窗口正好切在半个字符中间。
  const cutTail = Buffer.from("中文命令", "utf8").subarray(0, 8); // 结尾落在"命"的中间
  eq("窗口结尾半截字符被丢掉,前面的照常", decodeOutput(cutTail), "中文");

  /* 输出上限 —— 一条 `while true; do echo; done` 的钩子不该把主进程内存吃光 */
  const noisy = await runHookCommand(
    hook({
      command: write("noisy.js", `process.stdout.write("A".repeat(${HOOK_OUTPUT_LIMIT * 3}) + "END")`),
    }),
    payload(),
  );
  eq("刷屏的命令照样 ok", noisy.status, "ok");
  check("留下的是结尾(END 还在)", noisy.stdout?.includes("END") === true, noisy.stdout?.slice(-40));
  check(
    `输出被截到 ${HOOK_OUTPUT_LIMIT} 字节上下`,
    (noisy.stdout?.length ?? 0) < HOOK_OUTPUT_LIMIT * 2,
    noisy.stdout?.length,
  );
  check("截断有说明", noisy.stdout?.includes("只留了结尾") === true);

  /* 多字节字符被管道劈成两半 —— 不该变成一个乱码字 */
  const split = await runHookCommand(
    hook({
      command: write(
        "split.js",
        `const b = Buffer.from("中文"); process.stdout.write(b.subarray(0, 1));
         setTimeout(() => process.stdout.write(b.subarray(1)), 120);`,
      ),
    }),
    payload(),
  );
  check("跨 chunk 的中文没被转成乱码", split.stdout?.includes("中文") === true, split.stdout);

  /* 超时 —— 而且**真把进程收掉**,不只是不等它了 */
  const pidFile = join(dir, "slow.pid");
  const slow = await runHookCommand(
    hook({
      command: write(
        "slow.js",
        `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
         setInterval(() => {}, 1000);`,
      ),
      timeoutMs: 600,
    }),
    payload(),
  );
  eq("超时 → timeout", slow.status, "timeout");
  check("说了超时多少毫秒", slow.error?.includes("600") === true, slow.error);

  const slowPid = waitForPidFile(pidFile);
  if (slowPid === null) {
    check("超时的进程留下了 pid(才能验它真死了)", false);
  } else {
    // taskkill /T 是异步起的,给它一点时间落地。
    await sleep(1500);
    check("超时的进程真的被杀了(不留后台僵尸)", !isAlive(slowPid), { pid: slowPid });
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

/* ────────────── 6. 落盘(真的写文件,只是数据根在临时目录) ────────────── */

console.log("\nstore(存进 hooks.json,再读回来)");

const dataDir = mkdtempSync(join(tmpdir(), "mcode-hooks-data-"));
// 存放层通过 `dataRoot()` 拿目录,而那个模块被换成了读这个变量的桩(见 run.sh)。
process.env.MCODE_SMOKE_DATA_ROOT = dataDir;

try {
  eq("一开始一条都没有", readHooks().hooks.length, 0);

  eq("存得下", saveHook(hook({ id: "h_1", name: "第一条", enabled: false })).ok, true);
  const afterSave = readHooks();
  eq("读回来一条", afterSave.hooks.length, 1);
  eq("名字保住了", afterSave.hooks[0].name, "第一条");
  // 关掉的钩子要留在列表里(与"删掉"是两件事)—— 别在存的时候被顺手改成 true。
  eq("enabled 保住了", afterSave.hooks[0].enabled, false);

  saveHook(hook({ id: "h_1", name: "改过名的", enabled: true }));
  eq("同 id 是覆盖不是新增", readHooks().hooks.length, 1);
  eq("改动生效了", readHooks().hooks[0].name, "改过名的");

  saveHook(hook({ id: "h_2", name: "第二条" }));
  eq("再加一条", readHooks().hooks.length, 2);

  const rejected = saveHook(hook({ id: "h_3", event: "error", matcher: "Edit" }));
  eq("配错的存不进去", rejected.ok, false);
  check("而且说了为什么", rejected.ok === false && rejected.error.includes("工具名"));
  eq("配错的那条没落盘", readHooks().hooks.length, 2);

  removeHook("h_1");
  eq("删得掉", readHooks().hooks.length, 1);
  eq("删的是对的那条", readHooks().hooks[0].id, "h_2");
  eq("删一条不存在的也算成功", removeHook("h_没有这个").ok, true);
  eq("删不存在的没动别的", readHooks().hooks.length, 1);

  // **用户直接改这个文件**是把它放成文件的意义所在 —— 手写坏的条目要被看见,而不是
  // 让整个设置页报错或者静默少一条。
  writeFileSync(
    join(dataDir, "hooks.json"),
    JSON.stringify({ version: 1, hooks: [hook({ id: "h_diy", name: "手写的" }), { nope: 1 }] }),
  );
  const diy = readHooks();
  eq("手改的文件认得出来", diy.hooks.length, 1);
  eq("坏条目被跳过并报出来", diy.problems.length, 1);

  writeFileSync(join(dataDir, "hooks.json"), "{ 这不是 JSON");
  const junk = readHooks();
  eq("整份坏掉 → 不抛,给空列表", junk.hooks.length, 0);
  eq("整份坏掉 → 有一条 problem", junk.problems.length, 1);
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

/* ────────────────────── 收尾 ────────────────────── */

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
