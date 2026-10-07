/**
 * 「按引擎禁用内置工具」策略的回归 —— 纯模块（`lib/engineToolPolicy.ts`），不起 Electron。
 *
 * 钉住三件事：
 *  1. **读容错**：坏 JSON / 非法条目一律按"不禁用"处理（一份坏配置绝不能把某引擎的
 *     工具砍没了）。
 *  2. **最小持久化**：只写非空 exclude；空条目整条删掉（缺省 = 不禁用）。
 *  3. **接线**：Claude 走 `disallowedTools`、Pi 走 `excludeTools`，且都从这份策略读。
 *
 * 用临时文件测读写，不碰 `~/.mcode`。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  defaultEngineToolPolicyPath,
  engineSupportsToolExclusion,
  excludedToolsForEngine,
  readEngineToolPolicyFile,
  writeEngineToolPolicyFile,
} from "@main/lib/engineToolPolicy.js";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  total += 1;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

const dir = mkdtempSync(join(tmpdir(), "mcode-engine-tools-"));
const file = join(dir, "engine-tools.json");

try {
  /* ── 1. 读容错 ─────────────────────────────────────────────────────────── */
  eq("缺文件 → 空策略（都不设限）", readEngineToolPolicyFile(join(dir, "nope.json")), {});
  writeFileSync(file, "{ this is not json");
  eq("坏 JSON → 空策略", readEngineToolPolicyFile(file), {});
  writeFileSync(file, JSON.stringify({ claude: { exclude: "not-an-array" }, pi: ["nope"], codex: 5 }));
  eq("非法条目逐引擎丢弃", readEngineToolPolicyFile(file), {});
  writeFileSync(file, JSON.stringify({ claude: { exclude: ["Bash", "Bash", "  ", 7, "Read"] } }));
  eq(
    "读入时去重、剔非法名、排序",
    readEngineToolPolicyFile(file),
    { claude: { exclude: ["Bash", "Read"] } },
  );

  /* ── 2. 最小持久化 ────────────────────────────────────────────────────── */
  writeEngineToolPolicyFile(file, { claude: { exclude: ["Bash"] }, pi: { exclude: [] } });
  const onDisk = JSON.parse(readFileSync(file, "utf-8"));
  eq("只写非空 exclude，空引擎整条删掉", onDisk, { claude: { exclude: ["Bash"] } });

  writeEngineToolPolicyFile(file, { claude: { exclude: [] } });
  eq("全空 → 落盘成 {}（回到都不设限）", JSON.parse(readFileSync(file, "utf-8")), {});

  /* ── 3. 查询 ───────────────────────────────────────────────────────────── */
  eq(
    "excludedToolsForEngine 读某引擎的列表",
    excludedToolsForEngine({ claude: { exclude: ["Bash", "Read"] } }, "claude"),
    ["Bash", "Read"],
  );
  eq("未设限引擎 → 空数组", excludedToolsForEngine({ claude: { exclude: ["Bash"] } }, "pi"), []);

  /* ── 4. 能力：哪些引擎真能按名删 ──────────────────────────────────────── */
  check("Claude 支持按名禁用", engineSupportsToolExclusion("claude"));
  check("Pi 支持按名禁用", engineSupportsToolExclusion("pi"));
  check("Codex 不支持（只有沙箱/审批档）", !engineSupportsToolExclusion("codex"));

  /* ── 5. 接线：provider 真的读了策略并传给了 SDK ───────────────────────── */
  const claudeSrc = readFileSync(resolve(process.cwd(), "src/main/providers/claude-sdk/ClaudeAgentSdkProvider.ts"), "utf8");
  check(
    "Claude provider 把策略接到 SDK 的 disallowedTools",
    claudeSrc.includes("excludedToolsForEngine(readEngineToolPolicy(), \"claude\")") &&
      /disallowedTools:\s*\(\(\)/.test(claudeSrc),
  );
  const piSrc = readFileSync(resolve(process.cwd(), "src/main/providers/pi-sdk/PiAgentSdkProvider.ts"), "utf8");
  check(
    "Pi provider 把策略接到 createAgentSession 的 excludeTools",
    piSrc.includes("excludedToolsForEngine(readEngineToolPolicy(), \"pi\")") &&
      piSrc.includes("excludeTools: piExcludedTools"),
  );

  /* ── 6. 默认路径在 ~/.mcode 下（不进项目目录）──────────────────────────── */
  check(
    "默认策略文件在 ~/.mcode/engine-tools.json",
    defaultEngineToolPolicyPath().replace(/\\/g, "/").endsWith("/.mcode/engine-tools.json"),
    defaultEngineToolPolicyPath(),
  );

  /* ── 7. agent 只读工具桥：只桥只读的，接到三引擎，cwd 登记 ─────────────── */
  // 统一文档读取(agent_read_document 读 PDF/DOCX/XLSX/PPTX)过去只挂在网页路,
  // 三个桌面引擎一个都没有。桥只桥只读那一小撮,绝不桥写/bash/ssh。
  const bridgeSrc = readFileSync(resolve(process.cwd(), "src/main/mcp/agentEngineBridge.ts"), "utf8");
  check(
    "桥只列只读的三个(文档/图片/环境概况)",
    bridgeSrc.includes('"agent_read_document"') &&
      bridgeSrc.includes('"agent_read_image"') &&
      bridgeSrc.includes('"agent_context"') &&
      !bridgeSrc.includes('"agent_bash"') &&
      !bridgeSrc.includes('"agent_write_file"'),
  );
  check(
    "桥对非只读名显式拒(不静默放行)",
    bridgeSrc.includes("AGENT_READONLY_TOOLS.has(name)"),
  );
  const claudeSrc2 = readFileSync(resolve(process.cwd(), "src/main/providers/claude-sdk/ClaudeAgentSdkProvider.ts"), "utf8");
  const codexSrc = readFileSync(resolve(process.cwd(), "src/main/providers/codex-sdk/CodexAgentSdkProvider.ts"), "utf8");
  const piSrc2 = readFileSync(resolve(process.cwd(), "src/main/providers/pi-sdk/mcodeExtension.ts"), "utf8");
  check("Claude 挂上 agent MCP server", claudeSrc2.includes("buildAgentEngineMcpServer(") && claudeSrc2.includes("AGENT_ENGINE_MCP_SERVER"));
  check("Codex 把 agent 工具加进 dynamicTools 并派发", codexSrc.includes("agentToolDescriptors()") && codexSrc.includes("isAgentToolName(name)"));
  check("Pi 注册 agent 工具并在守卫里放行只读", piSrc2.includes("agentToolDescriptors()") && piSrc2.includes("isAgentReadonlyTool(toolName)"));
  check(
    "三引擎都在开跑时登记会话 cwd",
    claudeSrc2.includes("registerAgentEngineSession(req.sessionId, req.cwd)") &&
      codexSrc.includes("registerAgentEngineSession(req.sessionId, req.cwd)") &&
      piSrc2.includes("invokeAgentTool(tool.name, args, sessionId)") &&
      readFileSync(resolve(process.cwd(), "src/main/providers/pi-sdk/PiAgentSdkProvider.ts"), "utf8").includes("registerAgentEngineSession(req.sessionId, req.cwd)"),
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nengine-tools-smoke: ${total - failures}/${total} checks passed`);
if (failures > 0) process.exit(1);
