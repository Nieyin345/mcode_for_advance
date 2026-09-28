/**
 * Headless smoke for **钩子「执行」那一半没人守着的那三个文件**:
 *
 *  - `hooks/store.ts`      —— 钩子怎么落盘、读回来、坏文件怎么退;
 *  - `hooks/runCommand.ts` —— 真起进程、超时、编码、退出码;
 *  - `hooks/eventSubjects.ts` —— 事件 → `matcher` 拿去比的那个"主语"。
 *
 * ## 为什么还要一套
 *
 * `hooks-smoke` 与 `hook-runner-smoke` 都覆盖到了这三个文件(见 `smokes-for.sh`),所以
 * "那两套是绿的"一度被当成验过了。**但它们验的地方和用户会踩的地方不是同一处**:
 *
 *  - `hooks-smoke` 给 `fileSubjects` 的入参是**已经写成 `/` 的**路径 —— 于是"用户从
 *    界面上粘一个 `D:\a\b.md` 进来"那条路一次都没走过(那正是会不响的那条);
 *  - `hooks-smoke` 里 `parseHooksFile` 的容忍规则测得很细,但**落盘那一层**的往返
 *    (存一条 → 读回来 → 再存一条)没测过;手改的文件里有一条坏条目时,保存会不会
 *    顺手把它删掉,也没有人问过;
 *  - 超时那条只验了 `status === "timeout"`。**超时那一刻子进程已经打出来的东西去哪了**
 *    ——没有断言,而那是用户排"我的钩子为什么卡住"时唯一的线索。
 *
 * 用户能看到、也只能看到的故障是同一个形状:**我亲手写的钩子,该响的时候没响 / 该匹配的
 * 没匹配上**。所以下面每一条断言都尽量立在那件事上,而不是立在某个函数的返回值上。
 *
 * ## 真起进程
 *
 * 钩子命令是**真的**跑的(写一个小 `.js` 到 `mktemp -d` 出来的目录里,命令是
 * `node 那个文件`)。数据根也换成临时目录(见 run.sh 的 `--alias`)——
 * **绝不能指到真库**。
 *
 * Run: scripts/hook-exec-smoke/run.sh
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HOOK_OUTPUT_LIMIT,
  matchesHook,
  parseHooksFile,
  type HookPayload,
  type HookSpec,
} from "@contracts/hook";
import type { RuntimeEvent } from "@contracts/runtime";
import { createEventSubjects, fileSubjects } from "@main/hooks/eventSubjects.js";
import { runHookCommand } from "@main/hooks/runCommand.js";
import { hooksFilePath, readHooks, removeHook, saveHook, writeHooks } from "@main/hooks/store.js";

/* ────────────────────── 骨架 ────────────────────── */

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

const WORK = mkdtempSync(join(tmpdir(), "mcode-hook-exec-"));
const DATA = mkdtempSync(join(tmpdir(), "mcode-hook-exec-data-"));
// 存放层通过 `dataRoot()` 拿目录,而那个模块被换成了读这个变量的桩(见 run.sh)。
process.env.MCODE_SMOKE_DATA_ROOT = DATA;

const NODE = process.execPath.replace(/\\/g, "/");
/** 把一段脚本丢进临时目录,返回"跑它"的那条命令。路径一律写成 `/` —— 它要同时活过
 *  cmd.exe 和 sh,而反斜杠在 shell 里是转义符。 */
function script(name: string, body: string): string {
  writeFileSync(join(WORK, name), body, "utf-8");
  return `"${NODE}" "${join(WORK, name).replace(/\\/g, "/")}"`;
}

/** 一条钩子的底稿。每个用例只改它关心的那一两个字段。 */
function hook(patch: Partial<HookSpec> = {}): HookSpec {
  return { id: "h_test", name: "测试钩子", event: "tool.use", command: "echo hi", enabled: true, ...patch };
}

function payload(patch: Partial<HookPayload> = {}): HookPayload {
  return {
    event: "tool.use",
    at: Date.now(),
    session: { id: "s_test", kind: "chat", title: "测试会话", projectId: "p_test" },
    cwd: WORK,
    toolName: "Edit",
    data: { type: "tool.use", toolName: "Edit" },
    ...patch,
  };
}

/** `turn.files` 事件的一条记录 —— 只填 `fileSubjects` 会读的那个字段。 */
function filesEvent(...paths: string[]): RuntimeEvent {
  return {
    type: "turn.files",
    sessionId: "s_test",
    files: paths.map((filePath) => ({ filePath, kind: "modified", adds: 1, dels: 0, before: "" })),
  } as unknown as RuntimeEvent;
}

/* ══════════════════════════════════════════════════════════════════════
 * 1. eventSubjects —— 事件里提出来的那个"主语"
 *
 * 这一节盯的是一件具体的事:**用户在 matcher 里写的东西,能不能比中**。
 * ══════════════════════════════════════════════════════════════════════ */

console.log("\nfileSubjects(路径主语:matcher 拿它去比)");

const WIN = "D:\\proj\\src\\a.ts";
const subjects = fileSubjects([WIN], "D:\\proj");
console.log(`      原始路径 ${WIN} → ${JSON.stringify(subjects)}`);

// 用户想写 `src/*.ts`,也会有人写 `D:/proj/src/*.ts`(正斜杠)—— 这两种是原来就认的。
check("正斜杠的绝对路径在主语里", subjects.includes("D:/proj/src/a.ts"), subjects);
check("正斜杠的相对路径在主语里", subjects.includes("src/a.ts"), subjects);
// ⚠️ **这一条是这一节的重点。** `turn.files` 的路径在 Windows 上是**反斜杠**过来的,
// 而用户从界面上粘一个路径、或者照着资源管理器里的写法填 matcher,填的就是反斜杠。
// 只给正斜杠的话,那条钩子**一次都不会响**,而且一个字都不报。
check("反斜杠的绝对路径也在主语里(用户就是这么粘的)", subjects.includes(WIN), subjects);
check("反斜杠的相对路径也在主语里", subjects.includes("src\\a.ts"), subjects);

// 反过来:把这两种写法喂给 `matchesHook`,是用户真正会看到的那个判断。
const pathHook = (matcher: string): HookSpec =>
  hook({ event: "turn.files", matcher, command: "echo hi" });
const hit = (matcher: string): boolean => matchesHook(pathHook(matcher), "turn.files", subjects);
check("matcher 'src/*.ts'(正斜杠相对)命中", hit("src/*.ts"));
check("matcher 'D:/proj/src/*.ts'(正斜杠绝对)命中", hit("D:/proj/src/*.ts"));
check("matcher '*.ts' 命中", hit("*.ts"));
check("matcher 'D:\\\\proj\\\\src\\\\*.ts'(反斜杠绝对)命中", hit("D:\\proj\\src\\*.ts"));
check("matcher 'src\\\\*.ts'(反斜杠相对)命中", hit("src\\*.ts"));
check("matcher '*.py' 不命中", !hit("*.py"));

// 主语里不该有重复项:一个 `*` 要跑两遍正则,而主语的条数随改动文件数增长。
eq("没有重复主语", new Set(subjects).size, subjects.length);

// 路径一律写成 `/` 的那些(cwd 就是 `/` 风格)不该凭空多出一份 —— 去重那条的另一面。
{
  const posix = fileSubjects(["D:/proj/src/a.ts"], "D:/proj");
  eq("已经是正斜杠的路径不产生重复项", posix.length, new Set(posix).size);
  check("正斜杠的路径照样给相对那一份", posix.includes("src/a.ts"), posix);
}

// 会话目录之外的文件:拿不到相对路径,但绝对路径必须在(否则 `*.ts` 也匹配不上它)。
{
  const outside = fileSubjects(["E:\\别的地方\\x.md"], "D:\\proj");
  check("会话目录之外的文件仍有绝对路径主语", outside.includes("E:/别的地方/x.md"), outside);
  check("它没有相对路径那一份", !outside.some((s) => s === "x.md"), outside);
}

// cwd 不同 → 相对路径那部分不同。这是**对的**(同一条事件、不同项目各算一遍),也是
// `subjectsOf` 被拆成纯函数的原因。
{
  const a = fileSubjects([WIN], "D:\\proj");
  const b = fileSubjects([WIN], "D:\\elsewhere");
  check("cwd 变了,相对那一份跟着变", a.includes("src/a.ts") && !b.includes("src/a.ts"), b);
  check("绝对那一份不受 cwd 影响", b.includes("D:/proj/src/a.ts"), b);
}

console.log("\ncreateEventSubjects(工具名那一路,以及它的边界)");

{
  const es = createEventSubjects();
  const use = {
    type: "tool.use", sessionId: "s", toolName: "Write", toolCallId: "c1", input: {}, requiresApproval: false,
  } as unknown as RuntimeEvent;
  const result = {
    type: "tool.result", sessionId: "s", toolCallId: "c1", isError: false, content: "ok",
  } as unknown as RuntimeEvent;

  eq("tool.use 的主语就是那个工具名", (es.of(use, WORK).subjects ?? []).join(), "Write");
  // `tool.result` 本身不带工具名(三个提供方都不带)—— 靠前面那条 `tool.use` 回查。
  eq("tool.result 的主语是回查来的工具名", (es.of(result, WORK).subjects ?? []).join(), "Write");
  // 查不到就是**没有主语**,不是"全都匹配"。这两件事必须分清楚:前者是一条带 matcher 的
  // 钩子不响(用户看得见地去查),后者是它**每次都响**(一条挂在 tool.result 上的钩子会
  // 给每一次工具调用都跑一遍)。
  const orphan = createEventSubjects();
  const orphanFacts = orphan.of(result, WORK);
  eq("查不到工具名 → 没有主语(不是'全都匹配')", orphanFacts.subjects, undefined);
  check(
    "没有主语 + 写了 matcher → 不跑",
    !matchesHook(hook({ event: "tool.result", matcher: "Write" }), "tool.result", orphanFacts.subjects),
  );
  check(
    "没有主语 + 没写 matcher → 照常跑",
    matchesHook(hook({ event: "tool.result" }), "tool.result", orphanFacts.subjects),
  );

  // `of()` 是"一次算完",而 `factsOf` 是**回查即消费**的 —— 谁要连着问两遍,必须走
  // `subjectsOf`(见文件头)。这条盯的是那个 bug 的形状。
  const es2 = createEventSubjects();
  es2.factsOf(use);
  eq("第一次回查拿得到", es2.factsOf(result).toolName, "Write");
  eq("第二次回查就没了(消费过了)", es2.factsOf(result).toolName, undefined);

  // 不问工具名的事件:`toolName` 不出现,主语也不出现。
  const done = { type: "turn.done", sessionId: "s", reason: "end_turn" } as unknown as RuntimeEvent;
  const doneFacts = es.of(done, WORK);
  eq("turn.done 没有工具名", doneFacts.toolName, undefined);
  eq("turn.done 没有主语", doneFacts.subjects, undefined);

  // 一轮没改文件 → 空主语列表。**空列表也不匹配任何 matcher**(与"没有主语"同一条判据)。
  const none = es.of(filesEvent(), WORK);
  eq("没改文件 → 主语是空列表(不是 undefined)", (none.subjects ?? []).length, 0);
  check(
    "空主语列表 + 写了 matcher → 不跑",
    !matchesHook(hook({ event: "turn.files", matcher: "*.ts" }), "turn.files", none.subjects),
  );
}

/* ══════════════════════════════════════════════════════════════════════
 * 2. runCommand —— 真起一条进程
 * ══════════════════════════════════════════════════════════════════════ */

console.log("\nrunHookCommand(退出码 / 起不来 / 编码)");

try {
  /* 正常 */
  const ok = await runHookCommand(hook({ command: script("ok.js", `process.stdout.write("done")`) }), payload());
  eq("正常结束 → ok", ok.status, "ok");
  eq("退出码 0", ok.exitCode, 0);
  eq("输出原样收下", ok.stdout, "done");

  /* 非零退出码 */
  const bad = await runHookCommand(
    hook({ command: script("bad.js", `process.stdout.write("before"); process.exit(3)`) }),
    payload(),
  );
  eq("非零退出 → failed", bad.status, "failed");
  eq("退出码记下来了", bad.exitCode, 3);
  check("error 里说了是几", bad.error?.includes("3") === true, bad.error);
  // 挂了之前打出来的东西还在 —— 排错全靠它。
  eq("挂了之前的输出保住了", bad.stdout, "before");

  /* 命令不存在 —— cmd.exe 的提示是它用自己的代码页(中文机器 GBK)打的 */
  const missing = await runHookCommand(hook({ command: "mcode-没有这个命令 --xyz" }), payload());
  eq("命令不存在 → failed", missing.status, "failed");
  check("有可读的原因", (missing.error?.length ?? 0) > 0, missing.error);
  check(
    "cmd.exe 的提示解成了字(不是一个替换字符)",
    (missing.stderr ?? "").length > 0 && !(missing.stderr ?? "").includes("\uFFFD"),
    missing.stderr,
  );

  /* 中文输出 —— 真进程、真管道,GBK 字节不经过任何中间人 */
  const gbk = await runHookCommand(
    hook({
      command: script(
        "gbk.js",
        // GBK 的「中文。」(0xd6d0 0xcec4 0xa1a3)—— 按 UTF-8 解必然是两个替换字符。
        `process.stdout.write(Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xa1, 0xa3]));`,
      ),
    }),
    payload(),
  );
  eq("GBK 输出解对了", gbk.stdout, "中文。");
  // 先证明这段字节按 UTF-8 解**确实**是乱的,上面那条才不是空的。
  check(
    "同一段字节按 UTF-8 解确实是乱码(所以上面那条有意义)",
    new TextDecoder("utf-8").decode(Buffer.from([0xd6, 0xd0, 0xce, 0xc4])).includes("\uFFFD"),
  );

  /* UTF-8 输出不受影响 */
  const utf8 = await runHookCommand(
    hook({ command: script("utf8.js", `process.stdout.write("中文命令")`) }),
    payload(),
  );
  eq("UTF-8 输出照常", utf8.stdout, "中文命令");

  /* 刷屏 */
  const noisy = await runHookCommand(
    hook({ command: script("noisy.js", `process.stdout.write("A".repeat(${HOOK_OUTPUT_LIMIT * 3}) + "END")`) }),
    payload(),
  );
  eq("刷屏照样 ok", noisy.status, "ok");
  check("留下的是结尾(END 还在)", noisy.stdout?.includes("END") === true, noisy.stdout?.slice(-20));
  check("截断写明了", noisy.stdout?.includes("只留了结尾") === true);
  check(
    `截到 ${HOOK_OUTPUT_LIMIT} 字节上下`,
    (noisy.stdout?.length ?? 0) < HOOK_OUTPUT_LIMIT * 2,
    noisy.stdout?.length,
  );

  console.log("\n超时(以及那一刻已经打出来的东西)");

  const HANGS = script(
    "hangs.js",
    `process.stdout.write("跑到这里就卡住了\\n");
     process.stderr.write("stderr 上也有话说\\n");
     setInterval(() => {}, 1000);`,
  );
  const timedOut = await runHookCommand(hook({ command: HANGS, timeoutMs: 700 }), payload());
  eq("超时 → timeout(不是 failed)", timedOut.status, "timeout");
  check("说了超时多少毫秒", timedOut.error?.includes("700") === true, timedOut.error);
  // ⚠️ **这一条是这一节的重点。** 超时那一刻子进程已经打出来的东西,是用户回答
  // "我的钩子为什么卡住"的唯一线索。底层(`lib/spawnRun`)是收着的,而超时那条返回
  // 把它丢掉了 —— 于是设置页上只剩一句"超过 700ms 被中止",一个字的现场都没有。
  eq("超时之前 stdout 打出来的保住了", timedOut.stdout, "跑到这里就卡住了\n");
  eq("超时之前 stderr 打出来的保住了", timedOut.stderr, "stderr 上也有话说\n");

  console.log("\n命令在哪个目录里跑");

  /* cwd 不存在(工作树被删掉、项目被移除)→ 退回宿主目录,而不是起不来 */
  const gone = await runHookCommand(hook({ command: script("cwd.js", `process.stdout.write(process.cwd())`) }), payload({ cwd: join(WORK, "已经不存在的", "子目录") }));
  eq("cwd 不存在时照跑", gone.status, "ok");

  // ⚠️ **cwd 存在,但它是个文件。** `existsSync` 为真,于是它被原样交给了 spawn ——
  // 而 spawn 的报错是 `ENOENT`。那句话指着 cmd.exe 说"找不到",用户去看自己写的命令,
  // 怎么看都是对的。这和"cwd 不存在"是同一件事(那个目录已经不在那儿了),该走同一条退路。
  const asFile = join(WORK, "不是一个目录.txt");
  writeFileSync(asFile, "x", "utf-8");
  const fileCwd = await runHookCommand(
    hook({ command: script("cwd2.js", `process.stdout.write("ran")`) }),
    payload({ cwd: asFile }),
  );
  eq("cwd 是个文件时照跑(退回宿主目录)", fileCwd.status, "ok");
  eq("而且真的跑出东西了", fileCwd.stdout, "ran");
} finally {
  /* 这一段起过真的进程,临时目录一定要收干净(里面是脚本和 cwd 用的文件)。 */
  rmSync(WORK, { recursive: true, force: true });
}

/* ══════════════════════════════════════════════════════════════════════
 * 3. store —— hooks.json 的落盘与降级
 *
 * 这个文件是**用户直接改的**(那是把它放成文件的意义),所以他手上会有的形状都得认:
 * 不存在、空、坏 JSON、旧版本、手写错的单条。
 * ══════════════════════════════════════════════════════════════════════ */

console.log("\nstore(读:文件不在 / 坏 JSON / 旧形状)");

const FILE = hooksFilePath();
check("hooks.json 落在(临时)数据根下", FILE.startsWith(DATA), FILE);

/** 直接往盘上写一份 —— 模拟"用户自己改了这个文件"。 */
function putOnDisk(text: string): void {
  writeFileSync(FILE, text, "utf-8");
}

/** 盘上现在是什么。 */
function onDisk(): { version?: unknown; hooks: unknown[] } {
  const raw = JSON.parse(readFileSync(FILE, "utf-8")) as { version?: unknown; hooks?: unknown[] };
  return { version: raw.version, hooks: raw.hooks ?? [] };
}

rmSync(FILE, { force: true });
const missing = readHooks();
eq("文件不在 → 一条钩子都没有", missing.hooks.length, 0);
eq("文件不在 → 不算错误(problems 为空)", missing.problems.length, 0);

putOnDisk("{ 这不是 JSON");
const junk = readHooks();
eq("坏 JSON → 不抛,给空列表", junk.hooks.length, 0);
eq("坏 JSON → 有一条 problem", junk.problems.length, 1);
check("problem 说得清是哪儿", junk.problems[0].where.includes("hooks.json"), junk.problems[0]);
// 整份读不出来时**不许猜**:宁可一条都不跑(用户看得见 problem),也不要把半份东西
// 当成配置跑起来。
check("坏 JSON → 一条钩子都不跑", junk.hooks.length === 0);

putOnDisk(JSON.stringify({ version: 1, hooks: [hook({ id: "h_a", name: "好的" }), { nope: 1 }] }));
const mixed = readHooks();
eq("一条写坏 → 别的不受影响", mixed.hooks.length, 1);
eq("坏的那条报出来了(不静默丢弃)", mixed.problems.length, 1);

putOnDisk(JSON.stringify({ version: 99, hooks: [hook({ id: "h_v99", name: "来自将来的版本" })] }));
const future = readHooks();
eq("version 是个不认识的数 → 照样读得出来", future.hooks.length, 1);
eq("而且不报 problem(版本号不是判据)", future.problems.length, 0);

putOnDisk(JSON.stringify(42));
eq("顶层是个数字 → 有 problem", readHooks().problems.length, 1);

/* ── 写:往返、顺序、原子性 ── */

console.log("\nstore(写:往返 / 顺序 / 不留垃圾)");

putOnDisk(JSON.stringify({ version: 1, hooks: [] }));
eq("存得下", saveHook(hook({ id: "h_1", name: "第一条" })).ok, true);
eq("读回来一条", readHooks().hooks.length, 1);
eq("盘上是包了一层壳的形状", onDisk().version, 1);
check("写完没有留下 .tmp(改名是原子的)", !existsSync(`${FILE}.tmp`));

saveHook(hook({ id: "h_2", name: "第二条" }));
saveHook(hook({ id: "h_3", name: "第三条" }));
saveHook(hook({ id: "h_1", name: "改过名的" }));
eq("同 id 是覆盖不是新增", readHooks().hooks.length, 3);
// 顺序 = 设置页里看到的顺序,也是"谁先跑"的顺序。同 id 覆盖时**不挪位置**。
eq("同 id 覆盖不改变它原来的位置", readHooks().hooks.map((h) => h.id).join(","), "h_1,h_2,h_3");
eq("改动生效了", readHooks().hooks[0].name, "改过名的");

// 配错的存不进去 —— 而且**不该动到已经存好的那些**。
const rejected = saveHook(hook({ id: "h_4", event: "error", matcher: "Edit" }));
eq("配错的存不进去", rejected.ok, false);
check("而且说了为什么", !rejected.ok && rejected.error.includes("工具名"), rejected);
eq("配错的那次没动盘上的东西", readHooks().hooks.length, 3);

eq("删得掉", removeHook("h_2").ok, true);
eq("删的只有那一条", readHooks().hooks.map((h) => h.id).join(","), "h_1,h_3");
eq("删一条不存在的也算成功", removeHook("h_没有这个").ok, true);
eq("删不存在的没动别的", readHooks().hooks.map((h) => h.id).join(","), "h_1,h_3");

/* ── 手改的文件里有一条坏条目时,再存一条会怎样 ── */

console.log("\nstore(手改出来的坏条目,不能被下一次保存顺手删掉)");

// 这是这个文件被放成文件的**全部意义**:用户自己写的那几行,我们看不懂就报出来,
// 但**不替他删**。而"删一条"是另一件事,要靠直接改文件(见 `removeHook` 的注释)。
putOnDisk(
  JSON.stringify({
    version: 1,
    hooks: [hook({ id: "h_keep", name: "好的" }), { 我: "看不懂的一条" }],
  }),
);
eq("读的时候:好的那条在", readHooks().hooks.length, 1);
eq("读的时候:坏的那条报出来", readHooks().problems.length, 1);

saveHook(hook({ id: "h_added", name: "新加的" }));
const survived = onDisk();
// 用户自己写的那行还在原来的位置附近 —— 数一下盘上有几条就知道丢没丢:
// 好的那条 + 看不懂的那条 + 新加的 = 3。
eq("保存之后盘上是三条(坏的那条没被吞)", survived.hooks.length, 3);
check(
  "新加的那条在最后",
  (survived.hooks as Array<{ id?: string }>)[2]?.id === "h_added",
  survived.hooks,
);
check(
  "看不懂的那条留在它原来的位置(没被挪到别处、也没被删)",
  (survived.hooks as Array<{ 我?: string }>)[1]?.["我"] === "看不懂的一条",
  survived.hooks,
);

// 再删一条好的,那条坏的照样不该被带走。
removeHook("h_added");
eq("删掉一条之后,坏的那条还在", onDisk().hooks.length, 2);
check(
  "留下的正是用户手写的那条",
  (onDisk().hooks as Array<{ 我?: string }>).some((h) => h?.["我"] === "看不懂的一条"),
  onDisk().hooks,
);

// 整份坏掉时没有任何一条能按原样搬回去 —— 那种情况下只能退化成空,并由 problem 说明。
putOnDisk("{ 这不是 JSON");
eq("整份坏掉时保存仍然不抛", saveHook(hook({ id: "h_fresh" })).ok, true);
eq("整份坏掉之后重建出一份干净的", readHooks().hooks.length, 1);

/* ── 匹配与"命令能不能跑"无关 ── */

console.log("\n匹配不看命令跑不跑得起来");

// 一条钩子该不该跑,判据是事件名 + matcher。**命令写得对不对不参与这个判断** ——
// 写了条跑不起来的命令,该看到的是"failed + 原因",而不是"它压根不触发"。
// 这两种故障长得完全不一样,混在一起会把用户往错的方向带。
writeHooks([hook({ id: "h_ok", matcher: "Edit" }), hook({ id: "h_broken", matcher: "Edit", command: "mcode-没有这个命令" })]);
const loaded = readHooks();
eq("两条都读回来了(顺序不变)", loaded.hooks.map((h) => h.id).join(","), "h_ok,h_broken");
check("跑不起来的那条照样匹配得上", matchesHook(loaded.hooks[1], "tool.use", ["Edit"]), loaded.hooks[1]);

// 坏 JSON 之后 saveHook 会重写一份干净的;这里把它还原成"一条钩子都没有",免得后面
// 的断言看见上一段的残留。
putOnDisk(JSON.stringify({ version: 1, hooks: [] }));
eq("清干净了", readHooks().hooks.length, 0);

/* ── 契约层那条容忍规则的锚点 ── */

console.log("\nparseHooksFile 的进口(确认降级口径是契约定的)");

// 存放层不自己判格式,判据在契约里(纯函数,喂得进无头脚本)。这里只钉住"落盘这一层
// 用的就是那一份",免得将来有人在这儿手写第二份解析。
eq("顶层直接是数组也认(用户手写最自然的写法)", parseHooksFile(JSON.stringify([hook()])).hooks.length, 1);
eq("空文件 = 一条都没有(不是错误)", parseHooksFile("   ").problems.length, 0);

/* ── 带 BOM 的 hooks.json(Windows 记事本 / PowerShell 5.1 写出来的) ── */

console.log("\n带 UTF-8 BOM 的文件照常读、保存不整份重写");

{
  const kept = hook({ id: "bom-kept", name: "手写的那条" });
  putOnDisk("\uFEFF" + JSON.stringify({ version: 1, hooks: [kept] }));
  const loaded = readHooks();
  eq("BOM 不算坏 JSON:一条都没报 problem", loaded.problems.length, 0);
  eq("BOM 后面那条钩子读得出来", loaded.hooks.map((h) => h.id).join(","), "bom-kept");
  eq("契约层同样认", parseHooksFile("\uFEFF[]").problems.length, 0);
  // 读不出来时 commitHooks 会走“整份重写” —— 用户手写的内容就被盖掉了。
  saveHook(hook({ id: "bom-added" }));
  eq("保存一条新的之后,手写的那条还在盘上", onDisk().hooks.map((h) => (h as { id?: string }).id).join(","), "bom-kept,bom-added");
  putOnDisk(JSON.stringify({ version: 1, hooks: [] }));
}

/* ────────────────────── 收尾 ────────────────────── */

rmSync(DATA, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
