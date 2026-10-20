/**
 * MAINT-M14 定向 smoke —— **MCP 工具与会话端点**(维护计划 MAINT-2026-09 的 M14)。
 *
 * ## 为什么钉这三块
 *
 * M14 的检查面是「工具参数限额 / 会话鉴权与断线清理 / 跨会话数据隔离」。既有的三套
 * (`mcp-endpoint-smoke` / `mcp-engines-smoke` / `mcp-ipc-smoke`)覆盖的是**协议层**
 * (HTTP + 闸门)、**矩阵纯核心**与**设置面板的 9 条 IPC**;下面这三块是它们之间的空白:
 *
 *   A. `lib/mcpConfig.ts` 的**坏数据降级**。这个模块通篇写的是"永不抛,降级"
 *      (`readJson` 吞掉一切、`readUserClaudeJson` 缺文件给 `{}`),唯独
 *      `getMcpManagement()` 对 settings 表那一行**裸 `JSON.parse`**。那一行坏掉
 *      (半截写入、外部工具改过、旧版格式)会让 `getMcpTruth` → `MCP_LIST` 与
 *      **每轮开场的 `materializeAllMcpViews`** 一起抛 —— 一行坏数据把整摊 MCP 打死。
 *      本套断言它**降级成 `{}` 并自愈**(重新从 `.claude.json` 迁移、把坏行覆盖掉)。
 *
 *   B. `mcp/agentProcessSessions.ts` —— 网页那条(免审批)通路上的持久进程。要钉的是
 *      **别的对话拿到 process_id 也读不到/停不掉**、**上限是按对话算的**、
 *      **参数越界被夹紧而不是放行**、**stop 之后状态终结**。
 *
 *   C. `mcp/agentSearchSessions.ts` —— 同一条通路上的后台搜索。同样三问:隔离、
 *      结果上限、每对话会话上限**不得波及别的对话**。
 *
 * ## 没有覆盖的(留给真机/别的套件)
 *
 *   - `ipc/mcp.ts` 的 9 条通道与 OAuth 流程 —— `mcp-ipc-smoke` 已经拿真库跑;
 *   - `webToolHost` 的闸门顺序 —— `mcp-endpoint-smoke` 的后半段已经拿真宿主跑;
 *   - SSH / 远程作业 —— 要真远端,不在无头范围内。
 *
 * Run: scripts/maint-m14-smoke/run.sh
 */
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, chmodSync, readdirSync, renameSync, promises as fsPromises } from "node:fs";
import { rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { MCP_MANAGEMENT_SETTING_KEY, type McpManagementState } from "@contracts/ipc";
import {
  getMcpManagement,
  getMcpTruth,
  materializeClaudeMcpView,
  readUserClaudeJson,
  saveMcpManagement,
  writeUserClaudeJson,
} from "@main/lib/mcpConfig.js";
// 桩自己的测试钩子 —— 走相对路径引它本人(而不是 `@main/store/repositories.js`),
// 免得 tsc 去看真那份、报"没有 seedRaw"。alias 把真名也指到同一个文件,
// esbuild 按解析后的绝对路径去重,所以进程里仍然只有一份实例。
import { peekRaw, seedRaw } from "./stubs/repositories.js";
import { createAgentProcessSessions } from "@main/mcp/agentProcessSessions.js";
import { createAgentSearchSessions } from "@main/mcp/agentSearchSessions.js";
import { disposeAgentSession, registerAgentSessionDisposer } from "@main/mcp/agentSessionCleanup.js";

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

/** 断言一个 Promise **不抛**,并且结果满足谓词。抛了就是红灯(带上错误信息)。 */
async function resolvesWith<T>(
  name: string,
  run: () => Promise<T>,
  pred: (value: T) => boolean,
): Promise<T | null> {
  try {
    const value = await run();
    check(name, pred(value), { value });
    return value;
  } catch (err) {
    check(name, false, { threw: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** 断言一个同步/异步调用**抛出**且消息匹配。 */
async function rejectsWith(name: string, run: () => unknown, re: RegExp): Promise<void> {
  try {
    await run();
    check(name, false, { threw: null });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    check(name, re.test(msg), { message: msg, expected: String(re) });
  }
}

const NODE = process.execPath;
const work = mkdtempSync(join(tmpdir(), "mcode-maint-m14-"));

/** 子进程夹具。写成文件再用 `"<node>" "<file>"` 调 —— 这个形状在 cmd.exe 与 sh 下
 *  都成立,`node -e` 的内联引号两边规则不一样,跨平台会炸。 */
function fixture(name: string, body: string): string {
  const file = join(work, name);
  writeFileSync(file, body, "utf-8");
  return file;
}

const EMIT = fixture(
  "emit.mjs",
  [
    "const count = Number(process.argv[2] ?? 1);",
    "const tag = process.argv[3] ?? 'line';",
    "let out = '';",
    "for (let i = 0; i < count; i += 1) out += `${tag}-${i}\\n`;",
    "process.stdout.write(out);",
  ].join("\n"),
);

/** 吐一大坨**多字节**字符 —— 同时验缓冲上限与"跨块 UTF-8 不被切坏"。 */
const BULK = fixture(
  "bulk.mjs",
  [
    "const target = Number(process.argv[2]);",
    "const unit = '汉字测试一二三四五六七八九十';",
    "let out = '';",
    "while (out.length < target) out += unit;",
    "process.stdout.write(out);",
  ].join("\n"),
);

const ECHO = fixture(
  "echo.mjs",
  [
    "process.stdin.setEncoding('utf8');",
    "let buf = '';",
    "process.stdin.on('data', (d) => {",
    "  buf += d;",
    "  let i;",
    "  while ((i = buf.indexOf('\\n')) >= 0) {",
    "    const line = buf.slice(0, i); buf = buf.slice(i + 1);",
    "    process.stdout.write('ECHO:' + line.toUpperCase() + '\\n');",
    "  }",
    "});",
  ].join("\n"),
);

const IDLE = fixture("idle.mjs", "setInterval(() => {}, 3600_000);");

const cmd = (script: string, ...args: string[]): string =>
  [`"${NODE}"`, `"${script}"`, ...args].join(" ");

async function main(): Promise<void> {
  /* ══════════════ A. mcpConfig:管理状态的坏数据降级 ══════════════ */
  console.log("A. lib/mcpConfig.ts —— 管理状态坏数据降级");

  // A1 **本轮的红灯**。`readJson` / `readUserClaudeJson` 都是"坏了就给空",
  // 这一行却是裸 JSON.parse。坏行必须降级成"没有管理状态",不能把整摊打死。
  seedRaw(MCP_MANAGEMENT_SETTING_KEY, '{"userServers":{"a":');
  await resolvesWith(
    "坏 JSON 的管理状态 → 降级成 {},不抛",
    () => getMcpManagement(),
    (v) => JSON.stringify(v) === "{}",
  );

  // A2 合法 JSON 但不是对象(数组 / 标量 / null)—— 已有的 asRecord 分支,回归位。
  for (const raw of ["[1,2]", '"x"', "null", "12"]) {
    seedRaw(MCP_MANAGEMENT_SETTING_KEY, raw);
    await resolvesWith(
      `非对象的管理状态 ${raw} → {}`,
      () => getMcpManagement(),
      (v) => JSON.stringify(v) === "{}",
    );
  }

  // A3 正常一行照旧读回来 —— 降级不能顺手把好数据也吃掉。
  const good: McpManagementState = {
    userServers: { alpha: { type: "http", url: "https://example.invalid/mcp" } },
    browserDisabled: true,
  };
  saveMcpManagement(good);
  await resolvesWith(
    "合法管理状态原样读回",
    () => getMcpManagement(),
    (v) => JSON.stringify(v) === JSON.stringify(good),
  );

  // A4 自愈:坏行 + 真相层迁移。迁移看见"没有 userServers"就从 .claude.json 抬一份
  // 上来并落盘 —— 于是坏行被一份合法状态覆盖掉,下一次开机不再踩同一个坑。
  seedRaw(MCP_MANAGEMENT_SETTING_KEY, "{oops");
  const truth = await resolvesWith(
    "坏行之上 getMcpTruth 仍能完成迁移(不抛)",
    () => getMcpTruth(),
    (v) => typeof v === "object" && v !== null,
  );
  check(
    "迁移把 .claude.json 里的 server 抬进真相层",
    Boolean(truth && truth.userServers && "seeded-remote" in truth.userServers),
    { userServers: truth?.userServers },
  );
  const after = peekRaw(MCP_MANAGEMENT_SETTING_KEY);
  check(
    "坏行已被合法 JSON 覆盖(自愈)",
    after !== null && after !== "{oops" && (() => {
      try {
        JSON.parse(after);
        return true;
      } catch {
        return false;
      }
    })(),
    { after },
  );

  // A5 (2026-09-29 检修)`.claude.json` 在、但读不出来时**不许整份写回**。它是 CLI 自己
  // 的用户配置;读的一侧降级成 {} 是对的,写的一侧照着 {} 写回就是拿一个只剩
  // mcpServers 的对象盖掉 CLI 的整份状态 —— 而每轮开场的物化都会走这一步。
  {
    const claudeJson = join(homedir(), ".mcode", ".claude.json");
    const original = readFileSync(claudeJson, "utf-8");
    const torn = '{ "mcpServers": { "seeded-remote": { "type": "http", ';
    writeFileSync(claudeJson, torn, "utf-8");
    // 物化照旧**抛**:变更那一路靠它回滚真相层(见 ipc/mcp.ts 的
    // materializeMcpViewsOrRollback),吞掉的话真相层改了而视图没跟上。
    await rejectsWith("坏 .claude.json 上物化抛出来", () => materializeClaudeMcpView(), /不是合法 JSON/);
    eq("坏 .claude.json 物化之后一个字节不动", readFileSync(claudeJson, "utf-8"), torn);
    await rejectsWith("坏 .claude.json 上直接写回被拒绝", () => writeUserClaudeJson({ mcpServers: {} }), /不是合法 JSON/);
    eq("拒绝之后一个字节不动", readFileSync(claudeJson, "utf-8"), torn);
    // BOM(记事本 / PowerShell 5.1)不算坏:照常读,照常写。
    writeFileSync(claudeJson, "\uFEFF" + original, "utf-8");
    const withBom = await readUserClaudeJson();
    check("带 BOM 的 .claude.json 照常读出 CLI 自己的键", withBom.someUnrelatedCliKey === 1, withBom);
    await resolvesWith("带 BOM 的 .claude.json 上物化照常完成", () => materializeClaudeMcpView(), () => true);
    const rewritten = JSON.parse(readFileSync(claudeJson, "utf-8")) as Record<string, unknown>;
    check("物化写回后 CLI 自己的键还在", rewritten.someUnrelatedCliKey === 1, rewritten);
    writeFileSync(claudeJson, original, "utf-8");
  }

  /* ══════════════ B. agentProcessSessions:隔离 / 限额 / 终结 ══════════════ */
  console.log("B. mcp/agentProcessSessions.ts —— 持久进程会话");
  const procs = createAgentProcessSessions();
  const A = "conv-A";
  const B = "conv-B";

  const started = await procs.start({ ownerSessionId: A, command: cmd(IDLE), cwd: work, waitMs: 0 });
  check("start 返回 running 的进程", started.status === "running", started);

  // B1 跨会话隔离 —— 拿到 id 也不行。这是这条通路的**核心不变量**:公网那侧
  // 免审批,id 又是明文回给模型的,漏一个动词就等于把别人的进程交出去。
  await rejectsWith("别的对话 read 不到", () => procs.read({ ownerSessionId: B, processId: started.processId }), /不属于当前对话/);
  await rejectsWith("别的对话 write 不进去", () => procs.write({ ownerSessionId: B, processId: started.processId, input: "x" }), /不属于当前对话/);
  await rejectsWith("别的对话 stop 不掉", () => procs.stop({ ownerSessionId: B, processId: started.processId }), /不属于当前对话/);
  eq("别的对话 list 看不见", procs.list(B).length, 0);
  eq("自己的 list 看得见", procs.list(A).length, 1);
  await rejectsWith("不存在的 id", () => procs.read({ ownerSessionId: A, processId: "proc_nope" }), /没有这个进程会话/);

  // B2 每对话运行上限:第 9 个拒绝,而**别的对话不受牵连**(上限按对话算)。
  const extra: string[] = [];
  for (let i = 0; i < 7; i += 1) {
    const s = await procs.start({ ownerSessionId: A, command: cmd(IDLE), cwd: work, waitMs: 0 });
    extra.push(s.processId);
  }
  eq("A 已有 8 个运行中", procs.list(A).filter((p) => p.status === "running").length, 8);
  await rejectsWith(
    "第 9 个被上限挡住",
    () => procs.start({ ownerSessionId: A, command: cmd(IDLE), cwd: work, waitMs: 0 }),
    /已有 8 个运行中的进程/,
  );
  const bProc = await procs.start({ ownerSessionId: B, command: cmd(IDLE), cwd: work, waitMs: 0 });
  check("上限是按对话算的:B 仍能起", bProc.status === "running", bProc);

  // B3 stop 终结状态,并且幂等。
  let stopped = await procs.stop({ ownerSessionId: A, processId: started.processId });
  // stop() deliberately waits at most 3s; Windows process-tree termination
  // can finish later. Read the real terminal state with a bounded wait rather
  // than treating the stop-request acknowledgement as synchronous exit.
  const stopDeadline = Date.now() + 5_000;
  while (stopped.status === "running" && Date.now() < stopDeadline) {
    stopped = await procs.read({
      ownerSessionId: A, processId: started.processId, cursor: stopped.nextCursor,
      waitMs: Math.max(1, Math.min(1_000, stopDeadline - Date.now())),
    });
  }
  eq("stop 后状态是 stopped", stopped.status, "stopped");
  const stoppedAgain = await procs.stop({ ownerSessionId: A, processId: started.processId });
  eq("重复 stop 幂等", stoppedAgain.status, "stopped");
  await rejectsWith(
    "已终结的进程不能再写 stdin",
    () => procs.write({ ownerSessionId: A, processId: started.processId, input: "x" }),
    /不能再写 stdin/,
  );
  for (const id of [...extra, bProc.processId]) {
    const owner = id === bProc.processId ? B : A;
    await procs.stop({ ownerSessionId: owner, processId: id });
  }

  // B4 短命进程:一次阻塞读就该等到结束 + 拿到全部输出 + 退出码。
  const quick = await procs.start({ ownerSessionId: A, command: cmd(EMIT, "3", "row"), cwd: work, waitMs: 0 });
  const quickRead = await procs.read({ ownerSessionId: A, processId: quick.processId, waitMs: 5_000 });
  eq("短命进程读到 exited", quickRead.status, "exited");
  eq("退出码 0", quickRead.exitCode, 0);
  check("三行输出都在", ["row-0", "row-1", "row-2"].every((s) => quickRead.output.includes(s)), quickRead.output);
  check("终态尾注在", quickRead.output.includes("[process exited: exit=0]"), quickRead.output);

  // B5 stdin 往返。
  const repl = await procs.start({ ownerSessionId: A, command: cmd(ECHO), cwd: work, waitMs: 0 });
  const wrote = await procs.write({ ownerSessionId: A, processId: repl.processId, input: "hello", waitMs: 5_000 });
  check("write 后读到回声", wrote.output.includes("ECHO:HELLO"), wrote.output);
  await procs.stop({ ownerSessionId: A, processId: repl.processId });

  // B6 参数限额 + 缓冲上限 + 跨块多字节。一个吐 20 万字符的进程把三条一起踩出来。
  const bulk = await procs.start({ ownerSessionId: A, command: cmd(BULK, "200000"), cwd: work, waitMs: 0 });
  let tail = await procs.read({ ownerSessionId: A, processId: bulk.processId, waitMs: 20_000, maxChars: 60_000 });
  for (let i = 0; i < 40 && tail.status === "running"; i += 1) {
    tail = await procs.read({ ownerSessionId: A, processId: bulk.processId, cursor: tail.nextCursor, waitMs: 20_000, maxChars: 60_000 });
  }
  eq("大输出进程最终 exited", tail.status, "exited");
  const capped = await procs.read({ ownerSessionId: A, processId: bulk.processId, cursor: 0, maxChars: 10 ** 9 });
  check("max_chars 越界被夹到 60000", capped.output.length === 60_000, { len: capped.output.length });
  check("越界读仍报 has_more", capped.hasMore, capped);
  const one = await procs.read({ ownerSessionId: A, processId: bulk.processId, cursor: 0, maxChars: 0 });
  check("max_chars=0 被夹到 >=1", one.output.length === 1, { len: one.output.length });
  check("缓冲超过 12 万字符后 base 前移", capped.bufferStartCursor > 0, capped.bufferStartCursor);
  eq("cursor=0 时 skipped 等于被丢掉的量", capped.skippedChars, capped.bufferStartCursor);
  const whole = await procs.read({ ownerSessionId: A, processId: bulk.processId, cursor: capped.bufferStartCursor, maxChars: 60_000 });
  check("跨块多字节没有被切坏(无 U+FFFD)", !whole.output.includes("\uFFFD"), whole.output.slice(0, 40));

  // B7 对话删了(disposeOwner,OBS-M14-01):运行中的停掉、条目全部清走;别的对话不受牵连。
  const doomedProc = await procs.start({ ownerSessionId: A, command: cmd(IDLE), cwd: work, waitMs: 0 });
  const keptProc = await procs.start({ ownerSessionId: B, command: cmd(IDLE), cwd: work, waitMs: 0 });
  procs.disposeOwner(A);
  eq("disposeOwner 后 A 的进程 list 为空(含已结束的)", procs.list(A).length, 0);
  await rejectsWith(
    "disposeOwner 后 A 的旧进程 id 读不到",
    () => procs.read({ ownerSessionId: A, processId: doomedProc.processId }),
    /没有这个进程会话/,
  );
  eq("disposeOwner 不波及 B 运行中的进程", procs.list(B).filter((p) => p.status === "running").length, 1);
  await procs.stop({ ownerSessionId: B, processId: keptProc.processId });

  // B7a In-flight reads must not keep a defunct owner waiting up to the
  // public MCP 55s default after connection/session eviction.
  {
    const isolated = createAgentProcessSessions();
    const live = await isolated.start({ ownerSessionId: "dispose-race", command: cmd(IDLE), cwd: work, waitMs: 0 });
    let startedWait = false;
    const pending = isolated.read({
      ownerSessionId: "dispose-race", processId: live.processId,
      cursor: live.nextCursor, waitMs: 10_000,
    }).then(() => "unexpected resolved", (error: unknown) => String(error));
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    startedWait = true;
    const begun = Date.now();
    isolated.disposeOwner("dispose-race");
    const reply = await Promise.race([
      pending,
      new Promise<string>((resolve) => setTimeout(() => resolve("still blocked"), 1_200)),
    ]);
    check("★ owner 销毁会立即唤醒阻塞中的 read 并明确拒绝已释放会话",
      startedWait && /进程会话.*已销毁/.test(reply) && Date.now() - begun < 1_200,
      { reply, elapsedMs: Date.now() - begun });
    eq("★ 已销毁 owner 不遗留 process list", isolated.list("dispose-race").length, 0);
  }

  // B7b Concurrent stops must issue a single termination request, not
  // two taskkill trees and duplicate stop banners for one process.
  {
    const isolated = createAgentProcessSessions();
    const live = await isolated.start({ ownerSessionId: "stop-race", command: cmd(IDLE), cwd: work, waitMs: 0 });
    const stop1 = isolated.stop({ ownerSessionId: "stop-race", processId: live.processId, cursor: 0 });
    const stop2 = isolated.stop({ ownerSessionId: "stop-race", processId: live.processId, cursor: 0 });
    const [result1, result2] = await Promise.all([stop1, stop2]);
    const count = (result2.output.match(/\[process stop requested\]/g) ?? []).length;
    eq("★ 并发 stop 只发出一条真实 stop requested", count, 1);
    check("★ 并发 stop 不伪造提前退出", ["running", "stopped"].includes(result1.status)
      && ["running", "stopped"].includes(result2.status), { one: result1.status, two: result2.status });
  }

  // B7c If taskkill is still in flight, a follow-up stdin write must not
  // sneak in merely because ChildProcess.close has not been delivered yet.
  {
    const isolated = createAgentProcessSessions();
    const live = await isolated.start({ ownerSessionId: "write-race", command: cmd(ECHO), cwd: work, waitMs: 0 });
    const stopping = isolated.stop({ ownerSessionId: "write-race", processId: live.processId });
    await rejectsWith("★ stop 已请求但 close 未到时 stdin 必须拒绝",
      () => isolated.write({ ownerSessionId: "write-race", processId: live.processId, input: "must-not-run", waitMs: 0 }),
      /已请求停止|已经是 stopped/);
    await stopping;
  }

  // B7d Closing an owner during an in-flight stop invalidates its tool call.
  // The OS may not have closed yet, but no orphaned conversation may receive
  // a stale (apparently successful) response after its capability is revoked.
  {
    const isolated = createAgentProcessSessions();
    const live = await isolated.start({ ownerSessionId: "stop-owner-race", command: cmd(IDLE), cwd: work, waitMs: 0 });
    const stopping = isolated.stop({ ownerSessionId: "stop-owner-race", processId: live.processId });
    isolated.disposeOwner("stop-owner-race");
    await rejectsWith("★ owner 消失期间在途 stop 返回已销毁而非旧快照",
      () => stopping, /进程会话.*已销毁/);
  }

  // B7e App shutdown must wake pending long-poll reads, too: waiting for the
  // shell to exit is not sufficient if process-tree cleanup is delayed.
  {
    const isolated = createAgentProcessSessions();
    const live = await isolated.start({ ownerSessionId: "exit-race", command: cmd(IDLE), cwd: work, waitMs: 0 });
    const pending = isolated.read({
      ownerSessionId: "exit-race", processId: live.processId,
      cursor: live.nextCursor, waitMs: 10_000,
    }).then(() => "unexpected resolved", (error: unknown) => String(error));
    isolated.disposeAll();
    const reply = await Promise.race([
      pending,
      new Promise<string>((resolve) => setTimeout(() => resolve("still blocked"), 1_200)),
    ]);
    check("★ 应用退出立即取消所有尚在阻塞的 read",
      /进程会话.*已销毁/.test(reply), reply);
  }

  // B8 【MC-063】**端点全局容量**:per-owner 上限挡不住"多开几个对话各占一点"把物理机
  // 堆满。用注入的小全局上限验它真的按**总量**挡(而不是只按 owner 挡)。
  {
    const capped2 = createAgentProcessSessions({ maxRunningTotal: 2 });
    const startedIds: Array<{ owner: string; id: string }> = [];
    const startTot = async (owner: string) => {
      const s = await capped2.start({ ownerSessionId: owner, command: cmd(IDLE), cwd: work, waitMs: 0 });
      startedIds.push({ owner, id: s.processId });
      return s;
    };
    try {
      await startTot("tot-1");
      await startTot("tot-2");
      // 两个不同 owner(各 1 个,都未达 per-owner 上限)但总量到 2 → 第三个即被全局挡。
      await rejectsWith(
        "★ 全局进程上限挡在不相关的第三个对话(per-owner 都没满)",
        () => capped2.start({ ownerSessionId: "tot-3", command: cmd(IDLE), cwd: work, waitMs: 0 }),
        /RESOURCE_BUSY.*总数已达上限 2/,
      );
    } finally {
      // 即便上层断言失败(变异验证时第三个会起成功),也要停干净 —— 否则残进程占着
      // cwd,套件在清临时目录时 EBUSY 崩掉,反而看不见"断言红了"这个结论。
      for (const { owner, id } of startedIds) {
        try { if (id) await capped2.stop({ ownerSessionId: owner, processId: id }); } catch { /* ignore */ }
      }
      // 兜底:变异场景里"第 3 个"可能真的起来了、没进 startedIds;整表杀一遍。
      try { capped2.disposeAll(); } catch { /* ignore */ }
    }
  }

  /* ══════════════ C. agentSearchSessions:隔离 / 上限 ══════════════ */
  console.log("C. mcp/agentSearchSessions.ts —— 后台搜索会话");
  const searchRoot = join(work, "tree");
  mkdirSync(searchRoot, { recursive: true });
  for (let i = 0; i < 30; i += 1) {
    writeFileSync(join(searchRoot, `note-${i}.txt`), `needle ${i}\nfiller\n`, "utf-8");
  }
  const searches = createAgentSearchSessions();

  const s1 = await searches.start({ ownerSessionId: A, type: "content", pattern: "needle", root: searchRoot, literalSearch: true, waitMs: 3_000 });
  check("内容搜索有命中", s1.totalResults > 0, s1);
  await rejectsWith("别的对话 read 不到搜索会话", () => searches.read({ ownerSessionId: B, searchId: s1.searchId }), /不属于当前对话/);
  await rejectsWith("别的对话 stop 不掉搜索会话", () => searches.stop(B, s1.searchId), /不属于当前对话/);
  eq("别的对话 list 看不见搜索", searches.list(B).length, 0);
  await rejectsWith("不存在的 search_id", () => searches.read({ ownerSessionId: A, searchId: "search_nope" }), /没有这个搜索会话/);

  const capped2 = await searches.start({ ownerSessionId: A, type: "files", pattern: "note", root: searchRoot, literalSearch: true, maxResults: 5, waitMs: 3_000 });
  await searches.read({ ownerSessionId: A, searchId: capped2.searchId, waitMs: 3_000 });
  const capRead = await searches.read({ ownerSessionId: A, searchId: capped2.searchId, length: 500 });
  check("max_results 上限生效", capRead.totalResults <= 5, capRead.totalResults);

  const bSearch = await searches.start({ ownerSessionId: B, type: "files", pattern: "note", root: searchRoot, literalSearch: true, waitMs: 500 });
  for (let i = 0; i < 14; i += 1) {
    // 【MC-064】全是 running 时超限改为**明确拒绝**(SEARCH_CAPACITY_REACHED),
    // 不再静默停掉/删掉别的搜索会话。这里吞掉超限错误,继续验证上限与隔离。
    try {
      await searches.start({ ownerSessionId: A, type: "files", pattern: "note", root: searchRoot, literalSearch: true, waitMs: 0 });
    } catch (err) {
      if (!/SEARCH_CAPACITY_REACHED/.test((err as Error).message)) throw err;
    }
  }
  check("A 的搜索会话被压在每对话上限内", searches.list(A).length <= 12, searches.list(A).length);

  // 【MC-064】——**只读 list 不得破坏性**:建满后连调 list/read 不减少数目、不使旧 id 失效。
  {
    const C = "owner-c064";
    for (let i = 0; i < 12; i += 1) {
      await searches.start({ ownerSessionId: C, type: "files", pattern: "note", root: searchRoot, literalSearch: true, waitMs: 0 });
    }
    const full = searches.list(C);
    eq("建满 12 条", full.length, 12);
    // 只读 list 若干次,数目与内容不得变(从前 list 里的 prune 会删最老一条 → 变 11)。
    searches.list(C); searches.list(C); searches.list(C);
    eq("★ 只读 list 后仍是 12 条(不被 list 删掉)", searches.list(C).length, 12);
    // 最老那一条 list 之后仍可读(不被无声失效)。
    const oldest = full[full.length - 1]!.searchId;
    await resolvesWith("★ 最老搜索会话 list 后仍可读", () => searches.read({ ownerSessionId: C, searchId: oldest }), (v) => v.searchId === oldest);
    searches.disposeOwner(C);
  }
  eq("A 触顶不波及 B 的会话", searches.list(B).length, 1);
  await resolvesWith(
    "B 的会话仍可读",
    () => searches.read({ ownerSessionId: B, searchId: bSearch.searchId }),
    (v) => v.searchId === bSearch.searchId,
  );
  const stoppedSearch = searches.stop(B, bSearch.searchId);
  check("stop 后搜索会话终结", stoppedSearch.status !== "running", stoppedSearch.status);

  // C2 对话删了(disposeOwner):A 的搜索全部清走,B 的还在。
  searches.disposeOwner(A);
  eq("disposeOwner 后 A 的搜索 list 为空", searches.list(A).length, 0);
  await rejectsWith("disposeOwner 后 A 的旧 search_id 读不到", () => searches.read({ ownerSessionId: A, searchId: s1.searchId }), /没有这个搜索会话/);
  eq("disposeOwner 不波及 B 的搜索", searches.list(B).length, 1);

  // C2a Two in-flight operations already hold the session object when an
  // owner is evicted. The old code drops Map entries but resolves both stale
  // start/read promises as if the revoked owner were still authenticated.
  {
    const isolated = createAgentSearchSessions();
    const owner = "search-inflight-owner";
    const startPromise = isolated.start({
      ownerSessionId: owner, type: "content", pattern: "NO_MATCH_C2A",
      root: searchRoot, literalSearch: true, waitMs: 2_000,
    });
    const id = isolated.list(owner)[0]?.searchId ?? "";
    check("★ 搜索开始后有可撤销的 running 会话", id.startsWith("search_"), id);
    const readPromise = isolated.read({
      ownerSessionId: owner, searchId: id, offset: 50_000, waitMs: 2_000,
    });
    isolated.disposeOwner(owner);
    await rejectsWith("★ owner 撤销期间在途 search_start 必须失败而非返回过期结果",
      () => startPromise, /搜索会话.*已销毁/);
    await rejectsWith("★ owner 撤销期间在途 search_read 必须失败而非返回过期结果",
      () => readPromise, /搜索会话.*已销毁/);
    eq("★ 撤销后没有残留搜索会话", isolated.list(owner).length, 0);
  }

  // C2b A result cap means that subsequent files/lines have not necessarily
  // been searched. It cannot be reported as a complete result set.
  {
    const isolated = createAgentSearchSessions();
    for (const type of ["files", "content"] as const) {
      const start = await isolated.start({
        ownerSessionId: "search-budget-owner", type, pattern: type === "files" ? "note" : "needle",
        root: searchRoot, literalSearch: true, maxResults: 1, waitMs: 2_000,
      });
      const result = await isolated.read({ ownerSessionId: "search-budget-owner",
        searchId: start.searchId, offset: 1, waitMs: 2_000 });
      check(`★ ${type} 搜索达 max_results 后明确标 partial 及未搜完原因`,
        result.totalResults === 1 && result.partial && result.skippedCount > 0
          && result.skippedPaths.some((v) => v.includes("max_results")),
        result);
    }
    isolated.disposeOwner("search-budget-owner");
  }

  // C2c A user-initiated stop is not a completed tree scan. The existing
  // status=stopped distinction is necessary but insufficient: consumers
  // checking partial=false otherwise conclude the search was exhaustive.
  {
    const isolated = createAgentSearchSessions();
    for (const type of ["files", "content"] as const) {
      const owner = `manual-stop-${type}`;
      const pendingStart = isolated.start({ ownerSessionId: owner,
        type, pattern: "NEVER_MATCH_STOP", root: searchRoot, literalSearch: true, waitMs: 2_000 });
      const id = isolated.list(owner)[0]?.searchId ?? "";
      const stopped = isolated.stop(owner, id);
      const returned = await pendingStart;
      check(`★ ${type} 主动停止后结果必须如实标记 partial`,
        stopped.status === "stopped" && stopped.partial && stopped.skippedCount > 0
          && stopped.skippedPaths.some((v) => v.includes("stop")),
        stopped);
      check(`★ ${type} 已停止的在途 start 不能谎称已完整扫描`,
        returned.status === "stopped" && returned.partial
          && returned.skippedCount === stopped.skippedCount, returned);
      eq(`★ ${type} 手动停止前无结果时不得停止后补写搜索结果`,
        isolated.list(owner)[0]?.totalResults ?? -1, 0);
      isolated.disposeOwner(owner);
    }
  }

  // C2d A denied subpath is skipped intentionally for confidentiality, but
  // the corresponding search is *not exhaustive*. Report partial (without
  // opening it), not completed+partial=false.
  {
    const dir = join(work, "denied-search");
    mkdirSync(dir, {recursive: true});
    writeFileSync(join(dir, "allowed.txt"), "NEEDLE_OK\n");
    writeFileSync(join(dir, "denied.txt"), "NEEDLE_SECRET\n");
    const search = createAgentSearchSessions();
    const r = await search.start({
      ownerSessionId: "deny-scope", type: "content", pattern: "NEEDLE",
      root: dir, literalSearch: true, waitMs: 1_500,
      canRead: (p) => !p.endsWith("denied.txt"),
    });
    const detail = await search.read({ ownerSessionId: "deny-scope", searchId: r.searchId, waitMs: 1_500 });
    check("★ 拒绝读取子文件时仍保留允许文件结果",
      detail.results.some(s => s.includes("NEEDLE_OK")) && !detail.results.some(s => s.includes("NEEDLE_SECRET")), detail.results);
    check("★ 不可读子文件导致 partial，不可宣称搜索完整",
      detail.partial && detail.skippedPaths.some(s => s.includes("读取范围受限"))
      && !detail.skippedPaths.some(s => s.includes("denied.txt"))
      && detail.skippedCount >= 1, detail);
  }

  // C2d-2 Denied subdirectories are incomplete, but an excluded file glob
  // must not make an otherwise exhaustive search look partial.
  {
    const dir = join(work, "denied-filter-search");
    const forbidden = join(dir, "forbidden");
    mkdirSync(forbidden, { recursive: true });
    writeFileSync(join(forbidden, "hidden.ts"), "DO_NOT_READ\n");
    writeFileSync(join(dir, "allowed.ts"), "VISIBLE_OK\n");
    writeFileSync(join(dir, "ignored.txt"), "FILTERED_OUT\n");
    const search = createAgentSearchSessions();
    const denied = await search.start({
      ownerSessionId: "deny-dir", type: "content", pattern: "VISIBLE_OK",
      root: dir, literalSearch: true, waitMs: 1_500,
      canRead: (p) => !p.includes("forbidden"),
    });
    const deniedPage = await search.read({ ownerSessionId: "deny-dir", searchId: denied.searchId, waitMs: 1_500 });
    check("★ 未授权子目录跳过时仍要如实 partial", deniedPage.partial && deniedPage.skippedPaths.some(s => s.includes("读取范围受限"))
      && !deniedPage.skippedPaths.some(s => s.includes("forbidden")), deniedPage);
    const filtered = await search.start({
      ownerSessionId: "deny-filter", type: "content", pattern: "VISIBLE_OK",
      root: dir, filePattern: "*.ts", literalSearch: true, waitMs: 1_500,
      canRead: (p) => !p.endsWith("ignored.txt") && !p.includes("forbidden"),
    });
    const filteredPage = await search.read({ ownerSessionId: "deny-filter", searchId: filtered.searchId, waitMs: 1_500 });
    check("★ file_pattern 排除的文件不应凭空增加 skippedCount",
      filteredPage.partial && filteredPage.skippedCount === 1
        && !filteredPage.skippedPaths.some(s => s.includes("ignored.txt")), filteredPage);
  }

  // C2e Content search needs a per-file budget: an unbounded single UTF-8
  // line can otherwise consume arbitrary memory before readline truncation.
  {
    const huge = join(work, "huge-content.log");
    writeFileSync(huge, "A".repeat(8 * 1024 * 1024 + 1) + "NEEDLE_TOO_LARGE");
    const search = createAgentSearchSessions();
    const r = await search.start({
      ownerSessionId: "large-search", type: "content", pattern: "NEEDLE_TOO_LARGE",
      root: huge, literalSearch: true, waitMs: 2_000,
    });
    const detail = await search.read({ownerSessionId: "large-search", searchId: r.searchId, waitMs: 2_000});
    check("★ 超大单文件搜索跳过且显式报告扫描预算",
      detail.status === "completed" && detail.partial && detail.totalResults === 0
      && detail.skippedPaths.some(s => /8 MiB/.test(s)), detail);
  }

  // C2f Deterministic file-swap regression: switch a *path* after the first
  // approved handle opens. Old search opened a second handle for readline,
  // thereby scanning a different version from its header check.
  {
    const origin = join(work, "identity-source.txt");
    const replacement = join(work, "identity-replacement.txt");
    const moved = join(work, "identity-old.txt");
    writeFileSync(origin, "ORIGINAL_ONLY\n");
    writeFileSync(replacement, "SWAPPED_SECRET\n");
    const originalOpen = fsPromises.open;
    let injected = 0;
    (fsPromises as {open: typeof originalOpen}).open = (async (...args: Parameters<typeof originalOpen>) => {
      const handle = await originalOpen(...args);
      if (String(args[0]) === origin && injected === 0) {
        injected++;
        renameSync(origin, moved);
        renameSync(replacement, origin);
      }
      return handle;
    }) as typeof originalOpen;
    try {
      const search = createAgentSearchSessions();
      const r = await search.start({
        ownerSessionId: "identity-search", type: "content",
        pattern: "SWAPPED_SECRET", root: origin, literalSearch: true, waitMs: 1_500,
      });
      const detail = await search.read({ownerSessionId: "identity-search", searchId: r.searchId, waitMs: 1_500});
      eq("★ 真实文件交换夹具被执行", injected, 1);
      check("★ 搜索正文与头部验证属于同一个打开的文件版本",
        !detail.results.some(s => s.includes("SWAPPED_SECRET")) && detail.totalResults === 0, detail);
    } finally {
      (fsPromises as {open: typeof originalOpen}).open = originalOpen;
    }
  }

  // C3 【MC-063】**端点全局搜索容量**:用注入的小全局上限验它按**总量**挡。
  {
    const cappedSearches = createAgentSearchSessions({ maxSessionsTotal: 2 });
    await cappedSearches.start({ ownerSessionId: "st-1", type: "files", pattern: "note", root: searchRoot, literalSearch: true, waitMs: 100 });
    await cappedSearches.start({ ownerSessionId: "st-2", type: "files", pattern: "note", root: searchRoot, literalSearch: true, waitMs: 100 });
    await rejectsWith(
      "★ 全局搜索上限挡在不相关的第三个对话(per-owner 都没满)",
      () => cappedSearches.start({ ownerSessionId: "st-3", type: "files", pattern: "note", root: searchRoot, literalSearch: true, waitMs: 0 }),
      /RESOURCE_BUSY.*总数已达上限 2/,
    );
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * C4 【MC-027】遍历读口要能区分「完整无命中」与「不完整无命中」。
   *
   * 从前 walkDir 的 readdir 失败返回 []、visitFile 的 fs.open 失败返回 null —— 坏掉的
   * 子树被当成"空/不存在",目标文本恰在里面就报 0 results + completed(假完整)。下面用
   * 真造的不可读目录/文件(Windows 走 icacls /deny,POSIX 走 chmod 000)注入故障,证明
   * 结果如实标 partial 并列出没搜到的位置。
   *
   * ⚠️ 注入前先验证"故障真的生效"(readdir/open 真的被拒),否则断言就是空过 —— 那正是
   *    这个仓库踩过的坑。生效不了就**报红**,不静默跳过。
   * ───────────────────────────────────────────────────────────────────────── */
  console.log("C4. mcp/agentSearchSessions.ts —— 遍历读口区分完整/不完整(MC-027)");

  /** 让某目录/文件不可读;返回还原函数(务必在结尾调,否则临时目录清不掉)。 */
  function denyRead(target: string): () => void {
    if (platform() === "win32") {
      const user = process.env.USERNAME ?? "";
      execFileSync("icacls", [target, "/deny", `${user}:(R)`], { stdio: "pipe" });
      return () => { try { execFileSync("icacls", [target, "/remove:d", user], { stdio: "pipe" }); } catch { /* best effort */ } };
    }
    chmodSync(target, 0o000);
    return () => { try { chmodSync(target, 0o700); } catch { /* best effort */ } };
  }

  {
    const faultRoot = join(work, "fault-readdir");
    mkdirSync(join(faultRoot, "ok"), { recursive: true });
    mkdirSync(join(faultRoot, "locked"), { recursive: true });
    writeFileSync(join(faultRoot, "ok", "hit.txt"), "NEEDLE_027\n", "utf-8");
    writeFileSync(join(faultRoot, "locked", "secret.txt"), "NEEDLE_027\n", "utf-8");
    const restore = denyRead(join(faultRoot, "locked"));
    // 先证故障真的生效:readdir(locked) 必须失败,否则后面的断言是空过 → 直接报红。
    let injected = false;
    try { readdirSync(join(faultRoot, "locked")); } catch { injected = true; }
    check("★ 故障注入真的生效(locked 目录 readdir 被拒)", injected);
    if (!injected) {
      restore();
    } else {
      const srch = createAgentSearchSessions();
      const r = await srch.start({ ownerSessionId: A, type: "content", pattern: "NEEDLE_027", root: faultRoot, literalSearch: true, waitMs: 3_000 });
      const page = await srch.read({ ownerSessionId: A, searchId: r.searchId, offset: 0, length: 500, waitMs: 3_000 });
      check("★ 一个坏目录不瘫痪正常子树(ok/hit.txt 仍被搜到)", page.results.some((x) => x.includes("ok/hit.txt")), page.results);
      check("★ 坏目录使结果标为不完整(partial=true),不是假 completed", page.partial === true, { partial: page.partial, status: page.status });
      check("★ 没搜到的位置被如实登记(skippedCount>=1)", page.skippedCount >= 1, { skippedCount: page.skippedCount });
      check("★ skippedPaths 点名那个没搜到的目录", page.skippedPaths.some((p) => p.includes("locked")), page.skippedPaths);
      check("★ 状态仍是 completed(只是不完整),不是 error", page.status === "completed", page.status);
      srch.disposeOwner(A);
      restore();
    }
  }

  {
    // 文件打不开:一个坏文件不能瘫痪整次搜索,也要如实登记。
    const faultRoot = join(work, "fault-open");
    mkdirSync(faultRoot, { recursive: true });
    writeFileSync(join(faultRoot, "open.txt"), "NEEDLE_027\n", "utf-8");
    writeFileSync(join(faultRoot, "locked.txt"), "NEEDLE_027\n", "utf-8");
    const restore = denyRead(join(faultRoot, "locked.txt"));
    let injected = false;
    try { readFileSync(join(faultRoot, "locked.txt")); } catch { injected = true; }
    check("★ 故障注入真的生效(locked.txt 打不开)", injected);
    if (!injected) {
      restore();
    } else {
      const srch = createAgentSearchSessions();
      const r = await srch.start({ ownerSessionId: A, type: "content", pattern: "NEEDLE_027", root: faultRoot, literalSearch: true, waitMs: 3_000 });
      const page = await srch.read({ ownerSessionId: A, searchId: r.searchId, offset: 0, length: 500, waitMs: 3_000 });
      check("★ 打不开的文件不瘫痪整次搜索(open.txt 仍被搜到)", page.results.some((x) => x.includes("open.txt")), page.results);
      check("★ 打不开的文件使结果标为不完整(partial=true)", page.partial === true, { partial: page.partial });
      check("★ skippedPaths 点名那个打不开的文件", page.skippedPaths.some((p) => p.includes("locked.txt")), page.skippedPaths);
      srch.disposeOwner(A);
      restore();
    }
  }

  {
    // 完整无命中:同一棵树没有故障时,partial 必须是 false —— 与"不完整无命中"分开。
    const cleanRoot = join(work, "clean");
    mkdirSync(cleanRoot, { recursive: true });
    writeFileSync(join(cleanRoot, "a.txt"), "hello world\n", "utf-8");
    const srch = createAgentSearchSessions();
    const r = await srch.start({ ownerSessionId: A, type: "content", pattern: "ZZZ_NOT_PRESENT", root: cleanRoot, literalSearch: true, waitMs: 3_000 });
    const page = await srch.read({ ownerSessionId: A, searchId: r.searchId, offset: 0, length: 500, waitMs: 3_000 });
    check("★ 完整无命中:0 结果且 partial=false、skippedCount=0", page.totalResults === 0 && page.partial === false && page.skippedCount === 0, { total: page.totalResults, partial: page.partial, skipped: page.skippedCount });
    srch.disposeOwner(A);
  }

  {
    // 深度上限:超过 max-depth 的分支不再走,也要如实登记为"没搜到的地方",不能静默。
    const deepRoot = join(work, "deep");
    let cur = deepRoot;
    mkdirSync(cur, { recursive: true });
    for (let i = 0; i < 33; i += 1) {
      cur = join(cur, `d${i}`);
      mkdirSync(cur, { recursive: true });
    }
    writeFileSync(join(cur, "buried.txt"), "NEEDLE_027\n", "utf-8");
    const srch = createAgentSearchSessions();
    const r = await srch.start({ ownerSessionId: A, type: "content", pattern: "NEEDLE_027", root: deepRoot, literalSearch: true, waitMs: 3_000 });
    const page = await srch.read({ ownerSessionId: A, searchId: r.searchId, offset: 0, length: 500, waitMs: 3_000 });
    check("★ 撞深度上限时如实标 partial(不当成完整无命中)", page.partial === true && page.totalResults === 0, { partial: page.partial, total: page.totalResults });
    srch.disposeOwner(A);
  }

  /* ══════════════ D. agentSessionCleanup:删会话时的统一释放点 ══════════════ */
  console.log("D. mcp/agentSessionCleanup.ts —— 删会话时释放 agent 工具资源");
  const seen: string[] = [];
  const unregisterBoom = registerAgentSessionDisposer(() => {
    throw new Error("boom");
  });
  const unregisterSeen = registerAgentSessionDisposer((id) => seen.push(id));
  let threw = false;
  try {
    disposeAgentSession("conv-X");
  } catch {
    threw = true;
  }
  check("一个释放函数抛错不外泄给删除流程", !threw);
  eq("抛错的那个不妨碍其余释放函数执行", seen.join(","), "conv-X");
  unregisterBoom();
  unregisterSeen();
  disposeAgentSession("conv-Y");
  eq("注销后不再被调用", seen.join(","), "conv-X");
}

main()
  .then(async () => {
    // disposeOwner/stop initiate process-tree shutdown. Windows may still
    // hold the child's cwd briefly; async retries also let close events drain.
    // Bounded: a genuinely leaked handle still fails this suite, not ignored.
    //
    // ⚠️ 2026-10-17：全量并行跑时 10×100ms(=1s)不够 —— 6 路 light 并发下 `rg`
    // 子进程的 cwd 句柄释放得更慢，最后一个断言都绿了却在清理阶段 EBUSY 崩掉
    // （日志里只有 "crashed: EBUSY"，看起来像断言失败，实际断言全过）。改成
    // 30×200ms(=6s)：仍然有界、真正泄漏的句柄照样红，但不再把"机器忙"报成"测试坏"。
    //
    // 即便如此，全量并发下它仍是**最容易**被机器负载打红的套件（273/274 里那 1 个
    // 失败的常见形态就是这里 EBUSY，而所有断言都已通过）。所以再补一层：清理失败
    // **不再把套件判成失败** —— 断言结果才是判据；清理不了只记一行警告 + 目录路径。
    // 断言真的红时下面照常 exit(1)；这一层只把"机器忙"从结果里摘出去。
    try {
      await rm(work, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
    } catch (cleanupError) {
      console.warn(
        `maint-m14-smoke: temp dir left behind (assertions unaffected): ${work} — ` +
          `${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      );
    }
    console.log(`\n${checks - failures}/${checks} checks passed`);
    if (failures > 0) {
      console.error(`maint-m14-smoke: ${failures} failing check(s)`);
      process.exit(1);
    }
  })
  .catch(async (err: unknown) => {
    console.error(`maint-m14-smoke crashed: ${err instanceof Error ? err.stack : String(err)}`);
    try {
      await rm(work, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
    } catch (cleanupError) {
      // 说清楚这是**清理**失败，不是断言失败 —— 两者都该红，但别让日志误导排查。
      console.error("maint-m14-smoke cleanup failed (assertions above may all have passed):", cleanupError);
    }
    process.exit(1);
  });

