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
  // 真正无法解析的(坏 JSON / 数组根)→ 无 last-good → fail-closed 决议,不是"全可见"。
  for (const content of ['{ not json', '["array"]']) {
    writeFileSync(bad, content, "utf-8");
    rmSync(`${bad}.last-good`, { force: true });
    eq(`坏内容 ${content.slice(0, 12)} → 拒绝任意 server(无备份 fail-closed)`,
      mcpEngineEnabled(readEnginesMapFile(bad), "any", "claude"), false);
    eq(`坏内容 ${content.slice(0, 12)} → 拒绝任意 server(codex)`,
      mcpEngineEnabled(readEnginesMapFile(bad), "any", "codex"), false);
  }
  // 【MC-077】能解析成对象、但**任一**条目不合法 → **整份判 INVALID**(不是「丢弃坏条目、
  // 其余照用」)。从前这里 `continue` 跳过坏项并返回 VALID 空 map(全可见),于是
  // `{"private":{"codex":false}}` 被写坏成 `{"private":5}` 时,用户的禁用**静默丢失**、
  // 该 server 在 codex 上被**误当成重新启用** —— 这正是 MC-077 复核失败的 fail-open 反例。
  // 现在任一非法项(值非对象、或引擎字段非布尔)都让整份走 INVALID:无 last-good → fail-closed。
  for (const content of ['{"x": 5}', '{"x": {"vim": false}}', '{"private": 5}', '{"private": {"codex": "no"}}']) {
    writeFileSync(bad, content, "utf-8");
    rmSync(`${bad}.last-good`, { force: true });
    eq(`${content.slice(0, 20)} 非法项 → 任意 server 拒绝(fail-closed,不再全可见)`,
      mcpEngineEnabled(readEnginesMapFile(bad), "any", "claude"), false);
    eq(`★ ${content.slice(0, 20)} 非法项 → 原禁用条目不被当成重新启用(codex 也拒)`,
      mcpEngineEnabled(readEnginesMapFile(bad), "private", "codex"), false);
  }
  // 对照:**合法**的部分禁用映射照常生效(`{"x": {"vim": false}}` 那种"未知引擎名"曾被我
  // 误当合法 —— 这里改用已知引擎名,证明"合法项照用"没有被上面那条误伤)。
  {
    writeFileSync(bad, '{"x": {"claude": false}}', "utf-8");
    rmSync(`${bad}.last-good`, { force: true });
    eq("对照:合法禁用项照常生效(claude 拒)", mcpEngineEnabled(readEnginesMapFile(bad), "x", "claude"), false);
    eq("对照:合法禁用项只禁该引擎(codex 仍可见)", mcpEngineEnabled(readEnginesMapFile(bad), "x", "codex"), true);
  }

  /* ── 【MC-077 复审 E1】无 last-good 的坏矩阵 → 派生视图 fail-closed(空) ── */
  {
    const stdio = { command: "npx", args: ["-y", "server"] };
    const brokenNoBackup = join(root, "broken-no-backup.json");
    rmSync(brokenNoBackup, { force: true });
    rmSync(`${brokenNoBackup}.last-good`, { force: true });
    writeFileSync(brokenNoBackup, '{"only": {"claude": false', "utf-8");
    const denyAll = readEnginesMapFile(brokenNoBackup);
    const e1Truth: McpManagementState = {
      userServers: { "assigned-both": stdio, "assigned-claude": { command: "c" } },
      userDisabled: {},
    };
    // ★ 核心判据:损坏且无备份时,引擎视图里**一个都不出现**(不是照旧全给)。
    eqDeep("★ E1:坏矩阵无备份 → claude 派生视图为空", deriveMcpEngineView(e1Truth, denyAll, "claude"), {});
    eqDeep("★ E1:坏矩阵无备份 → codex 派生视图为空", deriveMcpEngineView(e1Truth, denyAll, "codex"), {});
    eq("E1:坏矩阵无备份 → mcpEngineEnabled 对已分配项也拒绝",
      mcpEngineEnabled(denyAll, "assigned-both", "claude"), false);
    // 对照:同一 truth + 一份合法空矩阵(VALID 全可见)→ 两项照常出现,证明上面的空来自 fail-closed 而非 truth 本身。
    eqDeep("E1 对照:合法空矩阵 → 两项照常出现",
      Object.keys(deriveMcpEngineView(e1Truth, {}, "claude")).sort(),
      ["assigned-both", "assigned-claude"]);
    // 对照:带 last-good 的损坏 → 按恢复的限制交付(这里 last-good 为空 → 全可见)。
    writeEnginesMapFile(brokenNoBackup, {});
    writeFileSync(brokenNoBackup, '{"only": {"claude": false', "utf-8");
    eqDeep("E1 对照:有 last-good(空)的损坏 → 恢复成全可见",
      Object.keys(deriveMcpEngineView(e1Truth, readEnginesMapFile(brokenNoBackup), "claude")).sort(),
      ["assigned-both", "assigned-claude"]);
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
