import * as path from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { runCodeNode } from "@main/orchestration/codeRunner.js";
import { resolvePythonExe, pickPreferredPython, bundledInterpreterOwner } from "@main/lib/pythonResolve.js";
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

console.log("\n非零退出但只有 summary、没有 stderr —— 失败原因不能退化成裸退出码");
{
  // 报告 D9：`wf_auto_convert` 失败时卡片只显示「进程退出码 1」，而脚本自己的
  // summary（"没有 MinerU token"）被丢了 —— 用户看不出错在哪。脚本**用协议行给出
  // 了原因**、又没往 stderr 写东西时，error 必须带上那段 summary。
  const code = [
    "const p=process.argv;",
    `process.stdout.write(${JSON.stringify(NODE_STDOUT_PROTOCOL_PREFIX)} + "result " + JSON.stringify({summary:"没有配置 MinerU token，跳过这次转换"}) + "\\n");`,
    "process.exit(1);",
  ].join("\n");
  const out = await runCodeNode({ code, language: "node", timeoutMs: 5000, signal: controller().signal });
  eq("still failed", out.status, "failed");
  check("★ 失败原因带上脚本自己给的 summary（不是裸退出码）",
    String(out.error).includes("没有配置 MinerU token"), out.error);
  check("summary 仍原样保留在产出里", String(out.summary).includes("没有配置 MinerU token"), out.summary);
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

console.log("\nOutput · 刷屏时代码被截到尾部,必须写明");
{
  // 代码节点的输出上限是 16000 字节(MAX_CAPTURE_BYTES),超了从头丢。**静默截断**是
  // 缺陷:下游把一段缺了头的输出当成完整的用。这一条与命令节点/入口脚本共用
  // `lib/outBuf.ts` 的 `markTruncatedTail`。
  const big = 16_000 * 2;
  const out = await runCodeNode({
    code: `process.stdout.write("A".repeat(${big}) + "TAILMARK");`,
    language: "node", timeoutMs: 10_000, signal: controller().signal,
  });
  eq("刷屏的代码照样 success", out.status, "success");
  const stdout = String(out.outputs?.stdout);
  check("★ 截断写在了输出前面", stdout.startsWith("…(输出超过"), stdout.slice(0, 60));
  check("★ 说明里带上限字节数", stdout.includes("16000"), stdout.slice(0, 60));
  check("正文仍是尾部(TAILMARK 还在)", stdout.endsWith("TAILMARK"), stdout.slice(-30));
  // **没超长的不加那一行** —— 否则每段普通输出上都挂着一条假告警。
  const small = await runCodeNode({
    code: `process.stdout.write("short");`, language: "node", timeoutMs: 10_000, signal: controller().signal,
  });
  check("★ 没超长的输出不加截断说明", !String(small.outputs?.stdout).includes("输出超过"), small.outputs);
}

console.log("\nLanguage · 用户可见的失败原因一律中文");
{  // ★ 画在**失败节点卡片**上的那行字必须与兄弟节点同口径。`commandRunner` 里
  //   「命令被信号终止…没有拿到退出码」/`进程退出码 未知` 都是中文,而这一支同一处境
  //   (`run.code === null` —— 进程被信号杀掉,拿不到退出码)从前写死英文 `unknown`。
  //   commit 4e1a9a0a 修了同一文件里**超时**那句英文,漏了这一句。整句写死,不做"读一个
  //   中文字符"那种松断言 —— 那样把中文换成英文哨兵照样绿。
  const src = readFileSync(path.join(process.cwd(), "src/main/orchestration/codeRunner.ts"), "utf8");
  check("★ 拿不到退出码时说的是中文「未知」(不是英文 unknown)", src.includes("run.code ?? \"未知\""), "codeRunner.ts");
  check("★ 不再有 `run.code ?? \"unknown\"` 的英文哨兵", !src.includes('run.code ?? "unknown"'), "codeRunner.ts");
}

console.log("\nPython · 代码节点不落到捆绑解释器(LibreOffice 的 python)上");
{
  // `agentEnv` 把 LibreOffice 的 program 目录(里面的捆绑 python.exe)注入到子进程
  // PATH 最前,好让技能敲的裸名 `soffice` 找得到。代码节点从前直接起裸名 `python`,
  // 于是落到那份捆绑解释器上 —— 与用户在终端里敲的不是同一个。现在统一走
  // `pythonResolve`:跳过捆绑家目录、挑用户自己的那份。判据是**纯函数**,直接喂候选
  // (不依赖本机装了哪种 python —— 否则这台机器的答案换台机就变)。
  const LO_PY = "C:\\Program Files\\LibreOffice\\program\\python.exe";
  const USER_PY = "D:\\python\\python.exe";
  eq("★ 有用户自己的 python 就不选 LibreOffice 自带的(哪怕它排在 PATH 最前)",
    pickPreferredPython([LO_PY, USER_PY]), USER_PY);
  eq("★ 捆绑识别走路径(大小写 / 斜杠无关)",
    bundledInterpreterOwner("c:/program files/LIBREOFFICE/program/python.exe"), "LibreOffice");
  eq("★ 普通解释器没有捆绑标记", bundledInterpreterOwner(USER_PY), null);
  // **不是一票否决**:机器上只有捆绑的那一份时,照样用它 —— 否则会把用户唯一的
  // 解释器也排掉,代码节点整条不可用。
  eq("★ 机器上只有捆绑的那一份时仍然用它(不能报「没有 python」)",
    pickPreferredPython([LO_PY]), LO_PY);
  eq("★ 一个候选都没有 → null(退回裸名字那条路)", pickPreferredPython([]), null);
}

console.log("\nPython · 真起进程:代码节点用的就是解析器选中的那个解释器(端到端)");
{
  // 上面是纯函数;这一条**真起一个 python 子进程**,证明 `runCodeNode` 真的把解析到
  // 的解释器接上了(而不是仍盯着裸名)。判据用 `sys.executable` 自报 —— 与解析器
  // 独立算出的那个**逐字对上**,既证明接线、又不依赖本机装的是哪种 python。
  //
  // **决定性**:先把本机真实存在的 LibreOffice `program/` 目录(里面的捆绑 python)
  // 摆到 PATH 最前 —— 这正是 `agentEnv` 在真实应用里干的事。若代码节点仍起裸名
  // `python`,`sys.executable` 会是那份捆绑解释器(与解析器选的非捆绑那个不同),
  // 断言就红;接线生效则是同一个。LO 不在这台机器上时跳过这条(纯函数那组仍覆盖判据)。
  const LO_DIR = "C:\\Program Files\\LibreOffice\\program";
  const loExists = existsSync(path.join(LO_DIR, "python.exe"));
  const savedPath = process.env.PATH;
  if (loExists) process.env.PATH = [LO_DIR, savedPath ?? ""].join(path.delimiter);
  try {
    const resolved = await resolvePythonExe();
    check("本机至少有一个可用的 python(否则这条端到端没意义)", resolved !== null, resolved);
    if (resolved) {
      check("★ 解析器跳过了摆到 PATH 最前的 LibreOffice python",
        bundledInterpreterOwner(resolved) === null, resolved);
      const out = await runCodeNode({
        code: "import sys; print(sys.executable)",
        language: "python", timeoutMs: 15_000, signal: controller().signal,
      });
      const exe = String(out.outputs?.stdout ?? "").trim();
      eq("★ 跑成功了(解析到的解释器真能起)", out.status, "success");
      // 规范化比较:同一路径的不同拼法(大小写 / 斜杠)在 Windows 上等价。
      const norm = (s: string): string => s.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
      eq("★ 脚本自报的解释器 == 解析器选中的那个(接线真的生效了)",
        norm(exe), norm(resolved));
      if (loExists) {
        check("★ 而且**不是**那个摆在 PATH 最前的捆绑解释器(排除裸名那条路)",
          norm(exe) !== norm(path.join(LO_DIR, "python.exe")), exe);
      }
    }
  } finally {
    if (loExists) process.env.PATH = savedPath;
  }
}

console.log("\nDirect caller boundary · malformed language, timeout, code, stdin");
{
  // The NodeInput builder rejects these shapes, but plugin/IPC consumers can
  // call runCodeNode directly. It must return a failed NodeOutcome instead of
  // changing interpreter, disabling the timeout, or throwing a JSON error.
  for (const language of ["ruby", "Powershell ", "toString"]) {
    let outcome: Awaited<ReturnType<typeof runCodeNode>> | undefined;
    let thrown: unknown;
    try {
      outcome = await runCodeNode({ code: "console.log('fixture');", language: language as "node",
        timeoutMs: 1500, signal: controller().signal });
    } catch (err) { thrown = err; }
    check("★ unknown code language is rejected before any interpreter starts",
      thrown === undefined && outcome?.status === "failed"
        && /language|解释器|语言/.test(String(outcome.error)),
      { language, status: outcome?.status, error: outcome?.error, thrown: String(thrown) });
  }
  for (const timeoutMs of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.25, 2_147_483_648]) {
    let outcome: Awaited<ReturnType<typeof runCodeNode>> | undefined;
    let thrown: unknown;
    try {
      outcome = await runCodeNode({ code: "console.log('fixture');", language: "node",
        timeoutMs, signal: controller().signal });
    } catch (err) { thrown = err; }
    check("★ invalid direct timeout cannot disable or corrupt the watchdog",
      thrown === undefined && outcome?.status === "failed"
        && /timeout|超时|毫秒/.test(String(outcome.error)),
      { timeoutMs, status: outcome?.status, error: outcome?.error, thrown: String(thrown) });
  }
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  for (const input of [1n, cyclic]) {
    let outcome: Awaited<ReturnType<typeof runCodeNode>> | undefined;
    let thrown: unknown;
    try {
      outcome = await runCodeNode({ code: "console.log('fixture');", language: "node",
        input, timeoutMs: 1500, signal: controller().signal });
    } catch (err) { thrown = err; }
    check("★ unencodable JSON stdin gets a structured failed outcome",
      thrown === undefined && outcome?.status === "failed"
        && /stdin|JSON|输入/.test(String(outcome.error)),
      { status: outcome?.status, error: outcome?.error, thrown: String(thrown) });
  }
  let wrongCode: Awaited<ReturnType<typeof runCodeNode>> | undefined;
  let codeThrown: unknown;
  try {
    wrongCode = await runCodeNode({ code: 42 as unknown as string,
      language: "node", timeoutMs: 1000, signal: controller().signal });
  } catch (err) { codeThrown = err; }
  check("★ non-text direct code is rejected as a failed outcome, not a TypeError",
    codeThrown === undefined && wrongCode?.status === "failed"
      && /代码|code/.test(String(wrongCode.error)),
    { status: wrongCode?.status, error: wrongCode?.error, thrown: String(codeThrown) });
}

console.log("\nProtocol progress · invalid percentage must not reach UI");
{
  const reports: Array<{percent?:number;message?:string}> = [];
  const code = [
    `console.log(${JSON.stringify(NODE_STDOUT_PROTOCOL_PREFIX + "progress ")}+JSON.stringify({percent:-5,message:"low"}));`,
    `console.log(${JSON.stringify(NODE_STDOUT_PROTOCOL_PREFIX + "progress ")}+JSON.stringify({percent:130,message:"high"}));`,
    `console.log(${JSON.stringify(NODE_STDOUT_PROTOCOL_PREFIX + "progress ")}+JSON.stringify({percent:33,message:"normal"}));`,
  ].join("\n");
  const outcome = await runCodeNode({ code, language:"node", timeoutMs:5000,
    signal:controller().signal,onProgress:(p)=>reports.push(p) });
  eq("progress fixture exits successfully",outcome.status,"success");
  eq("progress callback receives three messages",reports.length,3);
  check("★ negative progress never propagates an invalid UI percentage",reports[0]?.percent===undefined,reports);
  check("★ progress over 100 never propagates an invalid UI percentage",reports[1]?.percent===undefined,reports);
  eq("valid progress percentage remains intact",reports[2]?.percent,33);
  eq("invalid percentage still keeps its diagnostic message",reports[1]?.message,"high");
}

// Plugin input serializers can throw arbitrary JS values; even the error
// reporter must never reject the scheduler with a secondary TypeError.
{
  const nullProtoThrown=Object.create(null) as Record<string,unknown>;
  const errorWithBadMessage=new Error("base");
  Object.defineProperty(errorWithBadMessage,"message",{get(){throw nullProtoThrown;}});
  for(const input of [
    {toJSON(){throw nullProtoThrown;}},
    {toJSON(){throw {toString(){throw Error("secondary");}};}},
    {toJSON(){throw errorWithBadMessage;}}
  ]) {
    let outcome:Awaited<ReturnType<typeof runCodeNode>>|undefined;
    let rejected:unknown;
    try {outcome=await runCodeNode({code:"console.log(1)",language:"node",
      input,timeoutMs:500,signal:controller().signal});}
    catch(err){rejected=err;}
    check("★ noncoercible thrown stdin serializer does not escape CodeRunner",
      rejected===undefined&&outcome?.status==="failed"&&typeof outcome.error==="string"
        &&outcome.error.includes("JSON"),
      {status:outcome?.status,error:outcome?.error,rejected:rejected!==undefined});
  }
}

console.log("\nDirect code API rejects forged cancellation");
{
  for(const bad of [null,{},Object.create(null),{get aborted(){throw Object.create(null);}}]){
    let outcome:Awaited<ReturnType<typeof runCodeNode>>|undefined;
    let rejected=false;
    try {outcome=await runCodeNode({code:"console.log('never')",language:"node",
      timeoutMs:1000,signal:bad as AbortSignal});} catch {rejected=true;}
    check("★ code API returns structured failed outcome for forged AbortSignal",
      !rejected&&outcome?.status==="failed"&&typeof outcome.error==="string",
      {status:outcome?.status,rejected});
  }
}
console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${total} checks`);
if (failures > 0) process.exit(1);
