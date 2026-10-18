/**
 * 【ARC-007 · 方案 C】**GenOffice 无头 MCP server 作为可选 MCP 条目**的回归网。
 *
 * 被测：
 *  - `src/main/mcp/genofficeMcp.ts`（条目形状 + 围栏环境的**唯一**生成点）；
 *  - 真 `genoffice mcp` stdio server（真子进程、真 JSON-RPC）；
 *  - Mcode 现有 MCP 登记面（契约 schema / 真相层 / 引擎派生视图）。
 *
 * ## 它钉什么
 *
 *  1. **实机 stdio 协议**：spawn `<cli> mcp`，发 initialize + tools/list，
 *     断言文档工具（docs_read / docs_apply / sheet_read / slides_read / create_docx /
 *     convert / guide 等）
 *     真的在；断言**没有** GenOffice 自己的 agent / chat 工具（那条对话不进 Mcode）。
 *  2. **围栏真的过 MCP 通路**：用 buildGenofficeMcpConfig 产出的 env 起进程，
 *     工作区外的 create（写）与 docs_read（读）都得到 `outside_allowed_roots`，
 *     工作区内的 create/read 正常成功。围栏本体在 GenOffice 的
 *     `GENOFFICE_ALLOWED_ROOTS`（`packages/cli/src/fs.ts`），MCP 拉起的子进程里
 *     没有 Mcode 的 pathGuard —— 所以这个环境变量就是 MCP 通路的唯一围栏。
 *  3. **登记面能表示它**：`McpSaveSchema` 接受（新增/编辑面板同一条路）、真相层
 *     `userServers` + `deriveMcpEngineView` 能把它分配到 claude/codex、停用 stash
 *     能把它收走、引擎矩阵能单独关掉 codex；codex 的 TOML 物化器支持
 *     command/args/env（源码级）。
 *  4. **fail-closed**：allowedRoots 为空 / 相对路径 / CLI 路径非绝对 → 拒绝生成
 *     配置（GenOffice 对未设置围栏的语义是**不限制**，见文件头）。
 *  5. **安装入口接线（§2b）**：真 `ipc/mcp.ts` 的 `mcp.genofficeInstall` handler，
 *     在真 sql.js 库上跑。钉三件事：CLI 缺失 → ok:false 且**不写库**；有根 →
 *     真相层与 claude 派生视图都拿到带围栏 env 的条目；空根 → 拒绝且不写库。
 *     两项输入（CLI 路径 / 根集合）经 `configureGenofficeInstallPorts` 注入 ——
 *     与 `document.ts` 的 `configureDocumentRepoRoot` 同一手法，生产默认不经过它。
 *
 * ⚠️ 需要本机已构建 `genoffice/packages/cli/dist/genoffice.cjs`。bundle 不存在时
 * **实机段显式 SKIP 并打印原因**（配置面断言照跑，不静默跳过）。
 *
 * Run: scripts/genoffice-mcp-smoke/run.sh
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  IPC,
  McpServerConfigSchema,
  McpSaveSchema,
  MCP_MANAGEMENT_SETTING_KEY,
  isReservedMcpServerName,
  type McpServerConfig,
} from "@contracts/ipc";
import {
  GENOFFICE_ALLOWED_ROOTS_ENV,
  GENOFFICE_MCP_SERVER_NAME,
  buildGenofficeMcpConfig,
} from "@main/mcp/genofficeMcp.js";
import { deriveMcpEngineView, setMcpEnginesEntry, type McpEnginesMap } from "@main/lib/mcpEngines.js";
import { resolveGenofficeCliPath } from "@main/document/genofficeCli.js";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}
function section(t: string): void { console.log("\n" + t); }

const repoRoot = process.cwd().replace(/apps[\\/]desktop$/, "");
if (!/apps[\\/]desktop$/.test(process.cwd())) {
  console.log(`FAIL 基准目录不是 apps/desktop:${process.cwd()}（run.sh 应先 cd 到这里）`);
  process.exit(1);
}

const cliPath = resolveGenofficeCliPath(repoRoot);

/* ── 1. 条目形状与 fail-closed ── */
section("1. 条目形状（genofficeMcp.buildGenofficeMcpConfig）");
const work = mkdtempSync(join(tmpdir(), "mcode-genoffice-mcp-work-"));
const outside = mkdtempSync(join(tmpdir(), "mcode-genoffice-mcp-outside-"));
const fakeCli = join(work, "genoffice.cjs");
writeFileSync(fakeCli, "// placeholder so path checks are about shape, not existence\n");

const built = buildGenofficeMcpConfig({ cliPath: fakeCli, allowedRoots: [work], execPath: process.execPath });
check("有工作区根时生成成功", built.ok === true, built);
let config: McpServerConfig | null = null;
if (built.ok) {
  config = built.config;
  check("契约 schema（McpServerConfigSchema）接受该形状", McpServerConfigSchema.safeParse(config).success);
  const save = McpSaveSchema.safeParse({ name: GENOFFICE_MCP_SERVER_NAME, config });
  check("面板保存路径（McpSaveSchema）接受该条目", save.success, save.success ? undefined : save.error.issues);
  eq("条目名是 genoffice", GENOFFICE_MCP_SERVER_NAME, "genoffice");
  check("条目名不是 mcode- 保留身份", isReservedMcpServerName(GENOFFICE_MCP_SERVER_NAME) === false);
  if (config.type === "stdio") {
    eq("command 是注入的解释器（默认 process.execPath）", config.command, process.execPath);
    check("args = [cliPath, 'mcp']（CLI 的子命令）", JSON.stringify(config.args) === JSON.stringify([fakeCli, "mcp"]), config.args);
    eq("env.ELECTRON_RUN_AS_NODE = 1", config.env?.ELECTRON_RUN_AS_NODE, "1");
    check(
      "env 带 GENOFFICE_ALLOWED_ROOTS 且包含工作区根",
      (config.env?.[GENOFFICE_ALLOWED_ROOTS_ENV] ?? "").split(";").join(":").includes(work),
      config.env?.[GENOFFICE_ALLOWED_ROOTS_ENV],
    );
  } else {
    check("config.type 是 stdio", false, config);
  }
}

{
  const empty = buildGenofficeMcpConfig({ cliPath: fakeCli, allowedRoots: [], execPath: process.execPath });
  check("★ 空 allowedRoots → 拒绝生成（未设围栏 = GenOffice 不限制）", empty.ok === false, empty);
  const relativeRoot = buildGenofficeMcpConfig({ cliPath: fakeCli, allowedRoots: ["relative/dir"], execPath: process.execPath });
  check("★ 相对工作区根 → 拒绝生成", relativeRoot.ok === false, relativeRoot);
  const relativeCli = buildGenofficeMcpConfig({ cliPath: "genoffice.cjs", allowedRoots: [work], execPath: process.execPath });
  check("相对 CLI 路径 → 拒绝生成", relativeCli.ok === false, relativeCli);
}

/* ── 2. Mcode MCP 登记面能表示它 ── */
section("2. 登记面（真相层 + 引擎派生视图 + 物化消费点）");
if (config) {
  eq("管理态设置键是 mcp.management", MCP_MANAGEMENT_SETTING_KEY, "mcp.management");
  const state = { userServers: { [GENOFFICE_MCP_SERVER_NAME]: config } };
  const claudeView = deriveMcpEngineView(state, {}, "claude");
  const codexView = deriveMcpEngineView(state, {}, "codex");
  check("claude 派生视图包含 genoffice", GENOFFICE_MCP_SERVER_NAME in claudeView);
  check("codex 派生视图包含 genoffice", GENOFFICE_MCP_SERVER_NAME in codexView);
  check("真相层经 JSON 持久化后 env 原样保留",
    JSON.parse(JSON.stringify(state)).userServers[GENOFFICE_MCP_SERVER_NAME].env[GENOFFICE_ALLOWED_ROOTS_ENV]
      === (config.type === "stdio" ? config.env?.[GENOFFICE_ALLOWED_ROOTS_ENV] : undefined));
  const stashed = deriveMcpEngineView(
    { userServers: { [GENOFFICE_MCP_SERVER_NAME]: config }, userDisabled: { [GENOFFICE_MCP_SERVER_NAME]: config } },
    {}, "claude",
  );
  check("停用（stash）后 claude 视图收走它", !(GENOFFICE_MCP_SERVER_NAME in stashed));
  const map: McpEnginesMap = {};
  setMcpEnginesEntry(map, GENOFFICE_MCP_SERVER_NAME, { claude: true, codex: false });
  check("引擎矩阵可只关 codex：claude 仍有", GENOFFICE_MCP_SERVER_NAME in deriveMcpEngineView(state, map, "claude"));
  check("引擎矩阵可只关 codex：codex 视图为空", !(GENOFFICE_MCP_SERVER_NAME in deriveMcpEngineView(state, map, "codex")));

  // 物化消费点（源码级，与 ipc-wiring-smoke 同一类判据）：
  //   claude：mcpConfig 把派生视图写进 .claude.json 的 mcpServers；
  //   codex：mcpServerToml 真的输出 command/args/env（env 是围栏的载体）。
  const mcpConfigSrc = readFileSync(join(repoRoot, "apps/desktop/src/main/lib/mcpConfig.ts"), "utf8");
  check("claude 物化点写 cfg.mcpServers", mcpConfigSrc.includes("cfg.mcpServers = view"));
  const codexSrc = readFileSync(join(repoRoot, "apps/desktop/src/main/lib/codexModelsStore.ts"), "utf8");
  check("codex 物化点生成 [mcp_servers.*] 表", codexSrc.includes("[mcp_servers."));
  check("codex 物化点输出 env 表（围栏随条目进 config.toml）", codexSrc.includes("env = {"));
}

/* ── 2b. 安装入口 handler（真 ipc/mcp.ts + 真 sql.js 库） ──
 *
 * 用户点「安装 GenOffice 文档工具」时真正执行的就是这里注册的 handler。这一节
 * 不测 handler 的写法，测它的**结果**：失败时库有没有被动过、成功时真相层与
 * 两个引擎视图里的条目长什么样。
 *
 * 安全前提（与 mcp-ipc-smoke §0 同一条）：HOME 必须已被 run.sh 换成临时目录，
 * 否则 `registerMcpHandlers` 的启动物化会拿空配置覆盖用户真实的 ~/.mcode。
 * 两项输入经 `configureGenofficeInstallPorts` 注入：假 CLI 文件 + 固定根集合，
 * 生产路径（仓库真实 CLI / pathGuard）不经过这个覆盖。 */
section("2b. 安装入口（mcp.genofficeInstall handler，真库）");
{
  const { MCODE_CONFIG_DIR } = await import("@main/providers/claude-sdk/customEnv.js");
  const fakeHome = homedir();
  check(
    "★ 安全前提:HOME 已是临时目录(物化会写 ~/.mcode)",
    /mcode-genoffice-mcp-smoke-home/.test(fakeHome) && MCODE_CONFIG_DIR === join(fakeHome, ".mcode"),
    { fakeHome, MCODE_CONFIG_DIR },
  );
  check(
    "★ 安全前提:数据根是 run.sh 给的临时目录",
    (process.env.MCODE_SMOKE_DATA_ROOT ?? "").includes("mcode-genoffice-mcp-smoke-data"),
    process.env.MCODE_SMOKE_DATA_ROOT,
  );

  const { initDb } = await import("@main/store/db.js");
  const mcpConfig = await import("@main/lib/mcpConfig.js");
  const { registerMcpHandlers, configureGenofficeInstallPorts } = await import("@main/ipc/mcp.js");
  await initDb();

  const handlers = new Map<string, (event: unknown, raw: unknown) => unknown>();
  registerMcpHandlers({
    handle(channel: string, listener: (event: unknown, raw: unknown) => unknown): void {
      handlers.set(channel, listener);
    },
  } as never);
  await mcpConfig.ensureMcpTruthMigrated();

  const install = (raw?: unknown): Promise<{ ok: boolean; reason?: string; name?: string; roots?: string[]; materialized?: boolean }> => {
    const fn = handlers.get(IPC.MCP_GENOFFICE_INSTALL);
    if (!fn) throw new Error(`registerMcpHandlers 没有注册 ${IPC.MCP_GENOFFICE_INSTALL}`);
    return Promise.resolve(fn(null, raw)) as Promise<{ ok: boolean; reason?: string; name?: string; roots?: string[]; materialized?: boolean }>;
  };

  /** 真相层里现在有没有 genoffice(以及它当前的围栏 env)。 */
  const truthEntry = async (): Promise<McpServerConfig | undefined> =>
    (await mcpConfig.getMcpTruth()).userServers?.[GENOFFICE_MCP_SERVER_NAME];
  const fenceOf = (cfg: McpServerConfig | undefined): string =>
    cfg && cfg.type !== "http" && cfg.type !== "sse" ? (cfg.env?.[GENOFFICE_ALLOWED_ROOTS_ENV] ?? "") : "";
  /** 真 claude 派生视图(落盘的那份 .claude.json)。 */
  const claudeViewNames = async (): Promise<string[]> =>
    Object.keys(mcpConfig.mcpServersOf(await mcpConfig.readUserClaudeJson()));
  /** 真 codex 视图(落盘的 config.toml)。 */
  const codexToml = (): string => {
    const p = join(fakeHome, ".mcode", "codex", "config.toml");
    return existsSync(p) ? readFileSync(p, "utf8") : "";
  };

  // 另一个「工作区」—— 只用于验证 replace 会刷新围栏快照。
  const work2 = mkdtempSync(join(tmpdir(), "mcode-genoffice-mcp-work2-"));
  try {
    // ① CLI 缺失:ok:false 且**不写库**。
    configureGenofficeInstallPorts({ resolveCliPath: () => null, listRoots: () => [work] });
    const noCli = await install({});
    check("★ CLI 缺失 → ok:false(不抛)", noCli.ok === false, noCli);
    check("CLI 缺失的 reason 说清了「CLI 未构建」", (noCli.reason ?? "").includes("CLI 未构建"), noCli.reason);
    check("★ CLI 缺失时没有写库(真相层仍无 genoffice)", (await truthEntry()) === undefined, await truthEntry());

    // ② 空根集合:拒绝,因为空围栏 = GenOffice 不设防。
    configureGenofficeInstallPorts({ resolveCliPath: () => fakeCli, listRoots: () => [] });
    const emptyRoots = await install({});
    check("★ 空根集合 → ok:false(空围栏 = 不设防)", emptyRoots.ok === false, emptyRoots);
    check("空根拒绝的 reason 点明「空围栏等于不设防」", (emptyRoots.reason ?? "").includes("空围栏"), emptyRoots.reason);
    check("★ 空根拒绝时没有写库", (await truthEntry()) === undefined, await truthEntry());

    // ③ 正常安装:真相层 + claude 视图 + codex 视图都拿到带围栏的条目。
    configureGenofficeInstallPorts({ resolveCliPath: () => fakeCli, listRoots: () => [work] });
    const installed = await install({});
    check("★ 有 CLI + 有根 → ok:true", installed.ok === true, installed);
    eq("返回条目名 genoffice", installed.name, GENOFFICE_MCP_SERVER_NAME);
    check("返回的围栏根就是注入的那一组", JSON.stringify(installed.roots) === JSON.stringify([work]), installed.roots);
    check("返回值声明两个引擎视图已物化", installed.materialized === true, installed.materialized);

    const stored = await truthEntry();
    check("★ 真相层 userServers 里出现了 genoffice", stored !== undefined, stored);
    if (stored && stored.type !== "http" && stored.type !== "sse") {
      eq("条目 command 是当前解释器(Electron-as-Node)", stored.command, process.execPath);
      check("条目 args = [CLI 路径, 'mcp']", JSON.stringify(stored.args) === JSON.stringify([fakeCli, "mcp"]), stored.args);
      check(
        "★ 条目 env 带 GENOFFICE_ALLOWED_ROOTS 且含注入的工作区根",
        fenceOf(stored).split(";").join(":").includes(work),
        stored.env,
      );
    } else {
      check("条目是 stdio", false, stored);
    }

    check("★ claude 派生视图(.claude.json)也拿到了 genoffice", (await claudeViewNames()).includes(GENOFFICE_MCP_SERVER_NAME), await claudeViewNames());
    const toml = codexToml();
    check("★ codex 派生视图(config.toml)有 [mcp_servers.genoffice]", toml.includes("[mcp_servers.genoffice]"), toml.slice(0, 400));
    check("codex 物化里带着围栏 env", toml.includes(GENOFFICE_ALLOWED_ROOTS_ENV), toml.slice(0, 800));

    // 面板看到的就是这一行(MCP_LIST 是列表接口,行由真相层派生)。
    const listFn = handlers.get(IPC.MCP_LIST);
    const listed = (await Promise.resolve(listFn!(null, {}))) as { servers: Array<{ name: string; scope: string; kind: string; enabled: boolean }> };
    const row = listed.servers.find((s) => s.name === GENOFFICE_MCP_SERVER_NAME);
    check("★ 面板列表里出现 genoffice(scope=user, stdio, enabled)", row !== undefined && row.scope === "user" && row.kind === "stdio" && row.enabled, row);

    // ④ 重复名:不带 replace 拒绝,且**不**用新根覆盖旧围栏(否则用户以为没装成、实际已经改了围栏)。
    configureGenofficeInstallPorts({ resolveCliPath: () => fakeCli, listRoots: () => [work2] });
    const duplicate = await install({});
    check("★ 已存在且未传 replace → ok:false", duplicate.ok === false, duplicate);
    check("重复名的 reason 提示传 replace", (duplicate.reason ?? "").includes("replace"), duplicate.reason);
    check("★ 重复名拒绝后旧围栏未被改写", fenceOf(await truthEntry()).includes(work) && !fenceOf(await truthEntry()).includes(work2), fenceOf(await truthEntry()));

    // ⑤ replace = 刷新围栏快照:新根进、旧根出(整条替换,不是 merge)。
    const replaced = await install({ replace: true });
    check("★ replace:true → ok:true", replaced.ok === true, replaced);
    const refreshed = fenceOf(await truthEntry());
    check("★ 重装后围栏是新根集合(旧根已被替换掉)", refreshed.includes(work2) && !refreshed.includes(work), refreshed);
  } finally {
    configureGenofficeInstallPorts(null);
    try { rmSync(work2, { recursive: true, force: true }); } catch { /* Windows 句柄 */ }
  }
}

/* ── 3. 实机：stdio MCP server ── */
section("3. 实机 stdio（spawn <cli> mcp，JSON-RPC over stdin）");
if (cliPath === null) {
  console.log("SKIP 实机段：未找到 genoffice/packages/cli/dist/genoffice.cjs。");
  console.log("     先在 genoffice/ 下构建：`npm install --ignore-scripts && npm run build -w @genoffice/cli`。");
  console.log("     （配置面断言已照常执行；实机段缺席不算通过，也不判红。）");
} else if (config === null || config.type !== "stdio") {
  check("实机段需要一份成功的 stdio 配置", false, config);
} else {
  console.log(`CLI: ${cliPath}`);
  // 实机配置：用真实 CLI + 工作区根（fakeCli 只用于形状断言）。
  const live = buildGenofficeMcpConfig({ cliPath, allowedRoots: [work], execPath: process.execPath });
  if (!live.ok) {
    check("生成实机配置", false, live);
  } else if (live.config.type === "http" || live.config.type === "sse") {
    check("实机段只支持 stdio 配置", false, live.config.type);
  } else {
    const child = spawn(live.config.command, live.config.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // 只给最小集合 + 条目自己的 env（围栏就在其中）。与 genofficeCli.invoke 的取向一致。
      env: {
        PATH: process.env.PATH ?? "",
        TEMP: process.env.TEMP ?? "",
        TMP: process.env.TMP ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
        HOME: process.env.HOME ?? process.env.USERPROFILE ?? "",
        ...live.config.env,
      },
    });
    try {
      const rpc = makeRpcClient(child, 20_000);
      const init = await rpc.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "mcode-genoffice-mcp-smoke", version: "1.0" },
      });
      eq("initialize 返回 genoffice server", init?.result?.serverInfo?.name, "genoffice");
      rpc.notify("notifications/initialized");

      const list = await rpc.request("tools/list", {});
      const names: string[] = (list?.result?.tools ?? []).map((t: { name: string }) => t.name);
      check("tools/list 返回非空工具表", names.length > 0, names.length);
      for (const name of ["docs_read", "docs_apply", "sheet_read", "sheet_apply", "slides_read", "slides_apply", "create_docx", "convert", "guide", "info"]) {
        check(`工具表包含 ${name}`, names.includes(name));
      }
      check("★ 工具表不含 GenOffice 的 agent/chat 工具（那条对话不进 Mcode）",
        names.every((n) => !/agent|chat/i.test(n)), names.filter((n) => /agent|chat/i.test(n)));

      const callTool = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
        const res = await rpc.request("tools/call", { name, arguments: args });
        const raw = res?.result?.content?.[0]?.text;
        const text = typeof raw === "string" ? raw : "";
        try { return JSON.parse(text) as Record<string, unknown>; } catch { return { raw: text }; }
      };

      // 写围栏：工作区内成功，工作区外 outside_allowed_roots。
      const insideDoc = join(work, "inside.docx");
      const inside = await callTool("create_docx", { out: insideDoc, markdown: "# inside" });
      eq("工作区内 create_docx 成功", inside.status, "ok");
      check("工作区内文件真的写出", existsSync(insideDoc));

      const outsideDoc = join(outside, "escape.docx");
      const escaped = await callTool("create_docx", { out: outsideDoc, markdown: "# escape" });
      eq("★ 工作区外 create → outside_allowed_roots", escaped.error, "outside_allowed_roots");
      check("★ 工作区外没有文件被写出", !existsSync(outsideDoc));

      // 读围栏：工作区外已存在的文件同样拒绝。
      const outsideRead = join(outside, "exists.docx");
      writeFileSync(outsideRead, "not a docx");
      const refusedRead = await callTool("docs_read", { file: outsideRead });
      eq("★ 工作区外 docs_read → outside_allowed_roots", refusedRead.error, "outside_allowed_roots");
      const insideRead = await callTool("docs_read", { file: insideDoc });
      eq("工作区内 docs_read 成功（围栏不是一刀切）", insideRead.status, "ok");

      rpc.close();
    } catch (error) {
      check("实机 stdio 会话未抛错", false, (error as Error).message);
    } finally {
      try { child.kill(); } catch { /* already gone */ }
    }
  }
}

/* ── 收尾 ── */
console.log(`\ngenoffice-mcp-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exitCode = 1;

try { rmSync(work, { recursive: true, force: true }); } catch { /* Windows 句柄 */ }
try { rmSync(outside, { recursive: true, force: true }); } catch { /* 同上 */ }

/* ── 最小 JSON-RPC 客户端（换行分隔，与 StdioServerTransport 同协议） ── */
/** 本客户端只需要认三个 result 形状；多出来的字段按 Record 放过。 */
type RpcReply = {
  result?: {
    serverInfo?: { name?: string };
    tools?: Array<{ name: string }>;
    content?: Array<{ text?: string }>;
  } & Record<string, unknown>;
  error?: unknown;
};

interface RpcClient {
  request(method: string, params: Record<string, unknown>): Promise<RpcReply>;
  notify(method: string): void;
  close(): void;
}

function makeRpcClient(child: ChildProcessWithoutNullStreams, timeoutMs: number): RpcClient {
  let buf = "";
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: RpcReply) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  const failAll = (err: Error): void => {
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(err); }
    pending.clear();
  };
  child.stdout.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg: RpcReply & { id?: number };
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id === undefined) continue;
      const p = pending.get(msg.id);
      if (!p) continue;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      p.resolve(msg);
    }
  });
  child.once("exit", (code) => failAll(new Error(`MCP server 提前退出（code=${String(code)}）`)));
  child.once("error", (err) => failAll(err));
  return {
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} 超过 ${timeoutMs}ms 没有回应`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    },
    notify(method) {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params: {} }) + "\n");
    },
    close() {
      failAll(new Error("client closed"));
      child.stdin.end();
    },
  };
}
