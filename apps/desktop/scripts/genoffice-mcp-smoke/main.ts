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
 *
 * ⚠️ 需要本机已构建 `genoffice/packages/cli/dist/genoffice.cjs`。bundle 不存在时
 * **实机段显式 SKIP 并打印原因**（配置面断言照跑，不静默跳过）。
 *
 * Run: scripts/genoffice-mcp-smoke/run.sh
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
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
