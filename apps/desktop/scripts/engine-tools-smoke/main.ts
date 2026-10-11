/**
 * 「按引擎禁用内置工具」策略的回归 —— 纯模块（`lib/engineToolPolicy.ts`），不起 Electron。
 *
 * 钉住三件事：
 *  1. **读容错**：坏 JSON / 非法条目一律按"不禁用"处理（一份坏配置绝不能把某引擎的
 *     工具砍没了）。
 *  2. **最小持久化**：只写非空 exclude；空条目整条删掉（缺省 = 不禁用）。
 *  3. **接线**：Claude 走 `disallowedTools`、Pi 走 `excludeTools`，且都从这份策略读。
 *
 * 外加 agent 只读桥的两块 —— 桥只桥只读的（读），以及 cwd 登记表删会话真的摘掉（第 8 节）。
 * 后者是**行为**断言（真的注册、真的删、真的看它查不到），不是"源码里有没有那一行"。
 *
 * 用临时文件测读写，不碰 `~/.mcode`。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  defaultEngineToolPolicyPath,
  engineSupportsToolExclusion,
  excludedToolsForEngine,
  lastGoodEngineToolPolicyPath,
  readEngineToolPolicyDetailed,
  readEngineToolPolicyFile,
  writeEngineToolPolicyFile,
} from "@main/lib/engineToolPolicy.js";
import { agentEngineCwdFor, registerAgentEngineSession } from "@main/mcp/agentEngineCwd.js";
import { disposeAgentSession } from "@main/mcp/agentSessionCleanup.js";

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

  /* ── 4b.【MC-071】MISSING / VALID / INVALID 三态 + 损坏恢复 ────────────── */
  {
    const f = join(dir, "mc071.json");
    rmSync(f, { force: true }); rmSync(lastGoodEngineToolPolicyPath(f), { force: true });
    const missing = readEngineToolPolicyDetailed(f);
    check("★ 缺文件 → MISSING(不是 INVALID)", missing.status === "MISSING", missing);
    eq("MISSING 实际策略为不设限", missing.policy, {});

    // 合法写入 → VALID,并刷新 last-good 备份
    writeEngineToolPolicyFile(f, { claude: { exclude: ["Bash"] } });
    const valid = readEngineToolPolicyDetailed(f);
    check("合法配置 → VALID", valid.status === "VALID", valid);
    eq("VALID 读回禁用列表", valid.policy, { claude: { exclude: ["Bash"] } });
    check("写入后 last-good 备份存在", readEngineToolPolicyDetailed(lastGoodEngineToolPolicyPath(f)).status !== "MISSING");

    // 主文件被截断 → INVALID,且**不 fail-open**:从 last-good 恢复出原本的 Bash 禁用
    writeFileSync(f, '{ "claude": { "exclude": ["Bas');
    const broken = readEngineToolPolicyDetailed(f);
    check("★ 坏 JSON → INVALID(不是静默空策略)", broken.status === "INVALID", broken);
    check("★ 损坏后**保守恢复**到最后一份确认过的策略(不静默启用 Bash)", broken.recovered === true && JSON.stringify(broken.policy) === JSON.stringify({ claude: { exclude: ["Bash"] } }), broken);

    // 破坏性变异点:旧行为是「坏 JSON → {}」 —— 若恢复失效,上面两条会红(工具被静默重新启用)。
    // 没有备份时:仍报 INVALID(不假称用户主动启用),策略按不设限但带 error。
    rmSync(lastGoodEngineToolPolicyPath(f), { force: true });
    writeFileSync(f, "not json at all");
    const noBackup = readEngineToolPolicyDetailed(f);
    check("★ 无备份的损坏仍报 INVALID 且带原因(不静默假装启用)", noBackup.status === "INVALID" && typeof noBackup.error === "string" && noBackup.recovered === false, noBackup);

    // 权限类读取失败(EISDIR:路径是个目录)同样算 INVALID,不得当成 MISSING。
    const dirAsFile = join(dir, "adir");
    writeFileSync(join(dir, "placeholder"), "x");
    // 造一个目录占住路径
    mkdirSync(dirAsFile, { recursive: true });
    const readErr = readEngineToolPolicyDetailed(dirAsFile);
    check("★ 存在但读不出 → INVALID(不当作 MISSING)", readErr.status === "INVALID", readErr);
  }

  /* ── 4c.【MC-071 残余 E1】明确全开后损坏,**不得**恢复更旧的限制 ─────────── */
  {
    const f = join(dir, "mc071-empty.json");
    rmSync(f, { force: true }); rmSync(lastGoodEngineToolPolicyPath(f), { force: true });
    // ① 先设一份禁用 → last-good 记录下来。
    writeEngineToolPolicyFile(f, { claude: { exclude: ["Bash"] } });
    eq("① 初始禁用已落 last-good", readEngineToolPolicyDetailed(lastGoodEngineToolPolicyPath(f)).policy, { claude: { exclude: ["Bash"] } });
    // ② 用户**明确全开**(空策略)→ 这必须成为新的 last-good。
    writeEngineToolPolicyFile(f, { claude: { exclude: [] } });
    eq("② 主文件是全启用", readEngineToolPolicyDetailed(f).policy, {});
    eq("★ ② 明确全开后 last-good 也被刷成空(不残留旧限制)", readEngineToolPolicyDetailed(lastGoodEngineToolPolicyPath(f)).policy, {});
    // ③ 主文件损坏 → 从 last-good 恢复,必须恢复到**最近一次提交**(全启用),不是更旧的禁用。
    writeFileSync(f, "{ 坏了");
    const after = readEngineToolPolicyDetailed(f);
    check("★ ③ 明确全开后损坏 → 恢复到最近一次(全启用),不复活更旧的 Bash 禁用", after.recovered === true && JSON.stringify(after.policy) === JSON.stringify({}), after);
  }

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
  // 视觉中继(报告 D10 / Q1):图片工具得**真的**接上中继,否则这个能力在三个桌面引擎
  // 上一个都不生效 —— 而工具照旧"能拍能读",没人会看出它聋。
  // ⚠️ 判据要**具体到赋值**,不能用 `includes("describeImage")` 这种模糊串:`relay`
  // 那段是条件展开的,光看名字出现在文件里证明不了它被赋进了 deps(改个名照样命中)。
  check(
    "★ 桥把视觉中继接进 agent 工具 deps(否则三引擎都用不上)",
    bridgeSrc.includes("getVisionRelayImpl()") &&
      bridgeSrc.includes("describeImage: (args") &&
      bridgeSrc.includes("visionRelayConfigured: () => relay.configured()"),
  );
  // 装配点也得真的登记 —— 登记口是模块级单例,"定义了但没人 set"是最典型的假绿。
  const mainSrc = readFileSync(resolve(process.cwd(), "src/main/index.ts"), "utf8");
  check(
    "★ 应用装配时真的登记了中继实现(不是只定义了登记口)",
    mainSrc.includes("setVisionRelayImpl(") && mainSrc.includes("visionRelayConfigured"),
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

  /* ── 8. cwd 登记表：删会话真的摘掉（不是"源码里有没有那一行"）────────────────
   *
   * 从前桥里只有一个从没人调的 `unregisterAgentEngineSession`：三个 provider 每轮
   * `sendTurn` 都登记，却没有任何一处删，`cwdBySession` 只涨不落。这条断言**真的注册、
   * 真的删、真的看它查不到** —— 检测泄漏的那一步（`disposeAgentSession`）就是生产代码
   * 删会话/删项目时走的那一步。 */
  registerAgentEngineSession("conv-live", "/tmp/x");
  eq("登记后查得到", agentEngineCwdFor("conv-live"), "/tmp/x");
  registerAgentEngineSession("conv-live", "/tmp/y");
  eq("再登记覆盖旧值（每轮 sendTurn 都会登）", agentEngineCwdFor("conv-live"), "/tmp/y");
  disposeAgentSession("conv-live");
  eq("★ 删会话后登记被摘掉（从前只涨不落）", agentEngineCwdFor("conv-live"), null);
  eq("没登记过的会话查出来是 null", agentEngineCwdFor("conv-never"), null);
  // 释放是**按会话**的：删 A 不能顺手把 B 也清了（B 的对话还在跑）。
  registerAgentEngineSession("conv-a", "/tmp/a");
  registerAgentEngineSession("conv-b", "/tmp/b");
  disposeAgentSession("conv-a");
  eq("按会话释放，不波及别的会话", agentEngineCwdFor("conv-b"), "/tmp/b");
  disposeAgentSession("conv-b");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nengine-tools-smoke: ${total - failures}/${total} checks passed`);
if (failures > 0) process.exit(1);
