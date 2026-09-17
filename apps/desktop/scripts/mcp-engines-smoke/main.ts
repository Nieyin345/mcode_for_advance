/**
 * Headless smoke for MCP 服务器 per-engine 可见性 — `main/lib/mcpEngines.ts`.
 *
 * ## 为什么要钉这里
 *
 * MCP 的分配矩阵与技能矩阵同构（missing = enabled、只存 false 键、坏文件
 * 降级为全可见），但底下压着一套**只看代码看不出对错**的状态机：
 *
 *  - 派生视图：`.claude.json` 的 mcpServers 与 codex 的 config.toml 都是
 *    「enabled ∧ 分配给该引擎」的**派生视图**（真相层在管理态的 userServers）。
 *    派生时把 stash 里的（关掉的）也算进去、或把未分配的漏进去，引擎就会
 *    看到用户已经收走的服务器 —— 「他只能看到让他看到的」就破了；
 *  - toggle 行为表：关 = 配置进 stash、启停后视图重算；启一个两层都没有的
 *    名字必须拒绝而不是静默造一个空配置；
 *  - pi 键钉死：pi 没有 MCP 支持，`pi:false` 键是死重，落盘前必须剔掉；
 *  - 纯度：applyUserMcpToggle 不得变异入参 —— handler 靠返回值落盘，静默
 *    变异会让「拒绝」路径也改了状态。
 *
 * 全部走临时文件/纯函数。没有覆盖的：db 绑定的 handler（拉 electron/db）与
 * 两个引擎的物化消费点（要活的会话），靠真机验收。
 *
 * Run: scripts/mcp-engines-smoke/run.sh
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MCP_ENGINES,
  applyUserMcpToggle,
  deriveMcpEngineView,
  mcpEngineEnabled,
  mcpEnginesPath,
  setMcpEnginesEntry,
  type McpEnginesMap,
} from "@main/lib/mcpEngines.js";
import { readEnginesMapFile, writeEnginesMapFile } from "@main/lib/skillEngines.js";
import type { McpManagementState, McpServerConfig } from "@contracts/ipc";

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

function eqDeep(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

const root = mkdtempSync(join(tmpdir(), "mcode-mcp-engines-smoke-"));
try {
  /* ── 引擎清单与路径 ── */
  eqDeep("MCP_ENGINES 只有 claude/codex(pi 无 MCP)", [...MCP_ENGINES], ["claude", "codex"]);
  check(
    "mcpEnginesPath 落在 ~/.mcode 下且不在 skills 根里",
    mcpEnginesPath().includes(".mcode") && !mcpEnginesPath().includes("skills"),
    mcpEnginesPath(),
  );

  /* ── 默认语义:missing = enabled ── */
  const empty: McpEnginesMap = readEnginesMapFile(join(root, "absent.json"));
  eqDeep("无矩阵文件 → 空 map", empty, {});
  eq("空 map:任意名对 claude 可见", mcpEngineEnabled(empty, "anything", "claude"), true);
  eq("空 map:任意名对 codex 可见", mcpEngineEnabled(empty, "anything", "codex"), true);

  /* ── setMcpEnginesEntry:最小化持久化 + pi 钉死 ── */
  const file = join(root, "mcp-engines.json");
  let map: McpEnginesMap = {};
  setMcpEnginesEntry(map, "deepseek", { claude: true, codex: false });
  eqDeep("只给 codex → 落盘 {codex:false}", map, { deepseek: { codex: false } });
  eq("pi 键被剔掉(pi 无 MCP)", "pi" in (map.deepseek ?? {}), false);
  writeEnginesMapFile(file, map);
  eqDeep("round-trip", readEnginesMapFile(file), { deepseek: { codex: false } });

  setMcpEnginesEntry(map, "deepseek", { claude: true, codex: true });
  eqDeep("改回全开 → 条目删除", map, {});
  writeEnginesMapFile(file, map);
  eqDeep("全开落盘 = 空文件语义", readEnginesMapFile(file), {});

  setMcpEnginesEntry(map, "web-search", { claude: false, codex: true });
  eq("关闭 claude 后 mcpEngineEnabled false", mcpEngineEnabled(map, "web-search", "claude"), false);
  eq("codex 仍然可见", mcpEngineEnabled(map, "web-search", "codex"), true);

  /* ── 坏文件防御 ── */
  const bad = join(root, "bad.json");
  rmSync(bad, { force: true });
  for (const content of ['{ not json', '["array"]', '{"x": 5}', '{"x": {"vim": false}}']) {
    writeFileSync(bad, content, "utf-8");
    eqDeep(`坏内容 ${content.slice(0, 12)} → 空 map(全可见)`, readEnginesMapFile(bad), {});
  }

  /* ── deriveMcpEngineView:enabled ∧ assigned ── */
  const stdio = { command: "npx", args: ["-y", "server"] };
  const truth: McpManagementState = {
    userServers: {
      "both-see": stdio,
      "claude-only": { command: "claude-tool" },
      "codex-only": { command: "codex-tool" },
      "switched-off": { command: "off-tool" },
      // 手编文件里 schema 认不出的配置:派生时必须原样带出(面板不列出,但引擎
      // 侧保持迁移前的行为 —— 不因收进真相层而消失)。
      "unmodeled": { whatever: true } as unknown as McpServerConfig,
    },
    userDisabled: { "switched-off": { command: "off-tool" } },
  };
  const restricted: McpEnginesMap = {
    "claude-only": { codex: false },
    "codex-only": { claude: false },
  };
  eqDeep(
    "claude 视图 = 启用 ∧ 分配给 claude",
    deriveMcpEngineView(truth, restricted, "claude"),
    { "both-see": stdio, "claude-only": { command: "claude-tool" }, "unmodeled": { whatever: true } },
  );
  eqDeep(
    "codex 视图 = 启用 ∧ 分配给 codex",
    deriveMcpEngineView(truth, restricted, "codex"),
    { "both-see": stdio, "codex-only": { command: "codex-tool" }, "unmodeled": { whatever: true } },
  );
  eqDeep(
    "无限制矩阵 → 视图只差启停",
    deriveMcpEngineView(truth, {}, "codex"),
    { "both-see": stdio, "claude-only": { command: "claude-tool" }, "codex-only": { command: "codex-tool" }, "unmodeled": { whatever: true } },
  );
  eqDeep(
    "stash 里的(关掉的)两个引擎都不给",
    Object.keys(deriveMcpEngineView(truth, {}, "claude")).includes("switched-off"),
    false,
  );

  /* ── applyUserMcpToggle 行为表 ── */
  const base: McpManagementState = {
    userServers: { a: { command: "a" }, b: { command: "b" } },
    userDisabled: { c: { command: "c" } },
  };
  // 关:a 进 stash;真相层保留配置(新状态机:真相层=全部配置,stash=关闭名单,
  // 派生视图负责把 stash 里的滤掉)。
  const off = applyUserMcpToggle(base, "a", false);
  eq("关:ok", off.ok, true);
  eqDeep("关:stash 有 a", Object.keys(off.state.userDisabled ?? {}), ["c", "a"]);
  eqDeep("关:真相层仍含全部配置", Object.keys(off.state.userServers ?? {}), ["a", "b"]);
  check("关:原 state 不被变异", "a" in (base.userServers ?? {}) && !("a" in (base.userDisabled ?? {})));
  // 关掉的再关:幂等 ok。
  eq("关:重复关 = ok(幂等)", applyUserMcpToggle(off.state, "a", false).ok, true);
  // 开:出 stash;真相层不变。
  const on = applyUserMcpToggle(off.state, "a", true);
  eq("开:ok", on.ok, true);
  eqDeep("开:stash 只剩 c", Object.keys(on.state.userDisabled ?? {}), ["c"]);
  eqDeep("开:真相层不变", Object.keys(on.state.userServers ?? {}), ["a", "b"]);
  // 开:已在真相层 → 幂等 ok。
  eq("开:重复开 = ok(幂等)", applyUserMcpToggle(base, "b", true).ok, true);
  // 两层都没有 → 拒绝。
  eq("开:两层都没有 → 拒", applyUserMcpToggle(base, "ghost", true).ok, false);
  eq("关:两层都没有 → 拒", applyUserMcpToggle(base, "ghost", false).ok, false);
  // toggle 后视图立刻反映。
  const toggledView = deriveMcpEngineView(applyUserMcpToggle(base, "a", false).state, {}, "claude");
  eqDeep("关掉后:claude 视图没有 a", Object.keys(toggledView), ["b"]);

  console.log(`\n${checks - failures}/${checks} passed`);
  if (failures > 0) process.exit(1);
} finally {
  rmSync(root, { recursive: true, force: true });
}
