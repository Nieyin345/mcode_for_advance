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
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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
  const stopped = await procs.stop({ ownerSessionId: A, processId: started.processId });
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
    await searches.start({ ownerSessionId: A, type: "files", pattern: "note", root: searchRoot, literalSearch: true, waitMs: 0 });
  }
  check("A 的搜索会话被压在每对话上限内", searches.list(A).length <= 12, searches.list(A).length);
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
  .then(() => {
    rmSync(work, { recursive: true, force: true });
    console.log(`\n${checks - failures}/${checks} checks passed`);
    if (failures > 0) {
      console.error(`maint-m14-smoke: ${failures} failing check(s)`);
      process.exit(1);
    }
  })
  .catch((err: unknown) => {
    rmSync(work, { recursive: true, force: true });
    console.error(`maint-m14-smoke crashed: ${err instanceof Error ? err.stack : String(err)}`);
    process.exit(1);
  });

