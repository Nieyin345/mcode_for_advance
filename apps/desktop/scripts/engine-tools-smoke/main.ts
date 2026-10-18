/**
 * 「按引擎禁用内置工具」策略的回归 —— 纯模块（`lib/engineToolPolicy.ts`），不起 Electron。
 *
 * 钉住三件事：
 *  1. **读取判别（MC-071 + MC-042 严格 Schema）**：坏 JSON / 错形（`exclude` 非字符串
 *     数组、引擎表非对象、数组内坏项、未知键、缺 `exclude`）一律判 INVALID ——
 *     **绝不**静默过滤后仍判 VALID（那会把「想禁用 Bash」读成「不禁用」，fail-open）；
 *     合法数组仍去重、排序；明确空数组合法。
 *  2. **最小持久化**：只写非空 exclude；空条目整条删掉（缺省 = 不禁用）。
 *  3. **接线**：Claude 走 `disallowedTools`、Pi 走 `excludeTools`，且都从这份策略读。
 *
 * 外加 agent 只读桥的两块 —— 桥只桥只读的（读），以及 cwd 登记表删会话真的摘掉（第 8 节）。
 * 后者是**行为**断言（真的注册、真的删、真的看它查不到），不是"源码里有没有那一行"。
 *
 * 第 9 节【MC-042】用 `fakeIpc` 真驱动 `ipc/engineTools.ts` 的两个 handler（默认路径），
 * 所以 run.sh 把 `HOME` / `USERPROFILE` 指到隔离临时目录；main.ts 开头**校验**没指到就
 * 拒绝运行（照 `pi-models-store-smoke` 的先例——将就默认值 = 拿用户真 `~/.mcode` 当场地）。
 *
 * 用临时文件测读写，不碰 `~/.mcode`。
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  defaultEngineToolPolicyPath,
  engineSupportsToolExclusion,
  excludedToolsForEngine,
  lastGoodEngineToolPolicyPath,
  readEngineToolPolicyDetailed,
  readEngineToolPolicyFile,
  resolveEngineExcludedToolsForProviderFile,
  writeEngineToolPolicyFile,
} from "@main/lib/engineToolPolicy.js";
import { registerEngineToolHandlers } from "@main/ipc/engineTools.js";
import { agentEngineCwdFor, registerAgentEngineSession } from "@main/mcp/agentEngineCwd.js";
import { disposeAgentSession } from "@main/mcp/agentSessionCleanup.js";

/* ── 0. 用户根隔离校验（第 9 节走默认路径，必须先证明没指到真 ~/.mcode）──────────
 * `defaultEngineToolPolicyPath()` 拼 `homedir()`；Windows 读 `USERPROFILE`、其余平台读
 * `HOME`（`os.homedir()` 调用时求值）。run.sh 给 `MCODE_SMOKE_HOME` 并导出这两个变量；
 * 这里**没指到就抛**，不下探"默认值"。 */
const SMOKE_HOME = process.env.MCODE_SMOKE_HOME;
if (!SMOKE_HOME) {
  throw new Error("MCODE_SMOKE_HOME 没设 —— 第 9 节会走默认策略路径,必须把用户根指到隔离临时目录");
}
const normPath = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "");
if (normPath(homedir()) !== normPath(SMOKE_HOME)) {
  throw new Error(`homedir() 没有指到隔离目录(${homedir()} != ${SMOKE_HOME}),拒绝运行 —— 否则会碰用户真 ~/.mcode`);
}

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
  /* ── 1. 读取判别（MC-071 + MC-042 严格 Schema）────────────────────────────
   *
   * 【MC-042】判据从前是"坏配置读成空 = 不禁用"（容错）。那正是 fail-open 本体：
   * `{"claude":{"exclude":"Bash"}}` 会被读成 `{}`（想禁用 Bash → 不禁用），
   * 而且顶层仍判成功 —— last-good 恢复、拒绝执行、UI 告警三条防线全被绕过。
   * 现在错形一律 INVALID（低层读法返回的 policy 是"实际生效值"，空是兜底值；
   * 判别看 detailed 的 status）。 */
  eq("缺文件 → 空策略（都不设限）", readEngineToolPolicyFile(join(dir, "nope.json")), {});

  writeFileSync(file, "{ this is not json");
  const badJson = readEngineToolPolicyDetailed(file);
  check("★ 坏 JSON → INVALID（不是静默空策略）", badJson.status === "INVALID", badJson);

  // ★ MC-042 核心反例：错形不得再被容错过滤成「VALID + 空」。
  writeFileSync(file, JSON.stringify({ claude: { exclude: "Bash" } }));
  const wrongType = readEngineToolPolicyDetailed(file);
  check(
    "★ MC-042:exclude 是字符串（不是数组）→ INVALID，不再读成「不禁用」",
    wrongType.status === "INVALID" && typeof wrongType.error === "string" && wrongType.error.includes("claude.exclude"),
    wrongType,
  );
  eq("★ MC-042:错形时实际生效值为空兜底（不是把别的引擎砍掉）", wrongType.policy, {});

  writeFileSync(file, JSON.stringify({ claude: { exclude: null } }));
  check(
    "★ MC-042:exclude 是 null → INVALID",
    readEngineToolPolicyDetailed(file).status === "INVALID",
    readEngineToolPolicyDetailed(file),
  );
  writeFileSync(file, JSON.stringify({ pi: ["nope"], codex: 5 }));
  const wrongEngine = readEngineToolPolicyDetailed(file);
  check(
    "★ MC-042:引擎表非对象 → INVALID（不再逐引擎丢弃后判 VALID）",
    wrongEngine.status === "INVALID",
    wrongEngine,
  );
  writeFileSync(file, JSON.stringify({ claude: { exclude: ["Bash", 7, "Read"] } }));
  const badItem = readEngineToolPolicyDetailed(file);
  check(
    "★ MC-042:数组内混入非字符串项 → INVALID（不再逐项剔掉后判 VALID）",
    badItem.status === "INVALID" && badItem.error!.includes("exclude[1]"),
    badItem,
  );
  writeFileSync(file, JSON.stringify({ claude: { exclude: ["  "] } }));
  check(
    "★ MC-042:数组内只有空白名 → INVALID（合法名判据与写入同源）",
    readEngineToolPolicyDetailed(file).status === "INVALID",
    readEngineToolPolicyDetailed(file),
  );
  writeFileSync(file, JSON.stringify({ claud: { exclude: ["Bash"] } }));
  const typoKey = readEngineToolPolicyDetailed(file);
  check(
    "★ MC-042:引擎键写错（claud）→ INVALID（不静默忽略，否则用户以为设了限制）",
    typoKey.status === "INVALID" && typoKey.error!.includes("claud"),
    typoKey,
  );
  writeFileSync(file, JSON.stringify({ claude: {} }));
  check(
    "★ MC-042:引擎对象缺 exclude 字段 → INVALID（明确空要写 []）",
    readEngineToolPolicyDetailed(file).status === "INVALID",
    readEngineToolPolicyDetailed(file),
  );
  writeFileSync(file, JSON.stringify({ claude: { exclude: ["Bash"], nope: 1 } }));
  check(
    "★ MC-042:引擎对象含未知字段 → INVALID（不静默保留不理解的东西）",
    readEngineToolPolicyDetailed(file).status === "INVALID",
    readEngineToolPolicyDetailed(file),
  );

  // 合法形态照常：数组内容去重、排序；明确空数组合法（VALID，不误伤）。
  writeFileSync(file, JSON.stringify({ claude: { exclude: ["Bash", "Bash", "Read"] } }));
  const good = readEngineToolPolicyDetailed(file);
  check("合法配置 → VALID", good.status === "VALID", good);
  eq(
    "读入时去重、排序（合法输入不受严格化影响）",
    good.policy,
    { claude: { exclude: ["Bash", "Read"] } },
  );
  writeFileSync(file, JSON.stringify({ claude: { exclude: [] } }));
  const explicitEmpty = readEngineToolPolicyDetailed(file);
  check(
    "★ 明确空数组（用户主动全启用）→ VALID，不误伤",
    explicitEmpty.status === "VALID" && JSON.stringify(explicitEmpty.policy) === JSON.stringify({}),
    explicitEmpty,
  );
  writeFileSync(file, JSON.stringify({}));
  check("空配置对象 → VALID（都不设限）", readEngineToolPolicyDetailed(file).status === "VALID", readEngineToolPolicyDetailed(file));

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

  /* ── 4d.【MC-071 残余 E1】**行为**测 `resolveEngineExcludedToolsForProviderFile` ───
   *
   * §34.5 的核心残余:旧版/迁移用户**没有 last-good**,主文件一损坏,Provider 经
   * `excludedToolsForEngine(readEngineToolPolicy(), engine)` 拿到**空排除表** → 原本禁用的
   * Bash 被静默重新启用(fail-open)。本段用隔离临时文件直驱**生产同一条判定**
   * (`resolveEngineExcludedToolsForProviderFile`,生产那条只是把路径换成默认值),断言:
   * **无备份的损坏 → 抛错拒绝**(不是返回 `[]`);**有备份 → 按恢复值继续**;
   * **从没设过 → 照常不设限**。 */
  {
    const f = join(dir, "mc071-resolver.json");
    rmSync(f, { force: true }); rmSync(lastGoodEngineToolPolicyPath(f), { force: true });

    // ① 从没设过 → 不设限(MISSING),不抛错。
    const freshDeny = (() => { try { return { ok: true as const, v: resolveEngineExcludedToolsForProviderFile(f, "claude") }; } catch (e) { return { ok: false as const, e: String(e) }; } })();
    check("① 从没设过策略 → 不设限(空排除表,不抛错)", freshDeny.ok === true && freshDeny.v.length === 0, freshDeny);

    // ② 有效配置 → 照常生效。
    writeEngineToolPolicyFile(f, { claude: { exclude: ["Bash"] } });
    const validDeny = resolveEngineExcludedToolsForProviderFile(f, "claude");
    check("② 有效配置 → 照常返回禁用列表", JSON.stringify(validDeny) === JSON.stringify(["Bash"]), validDeny);

    // ③ 主文件损坏 + last-good **存在** → 按恢复值继续(不抛错、不空表)。
    writeFileSync(f, "{ 截断");
    const recDeny = resolveEngineExcludedToolsForProviderFile(f, "claude");
    check("③ 损坏但有备份 → 按恢复值继续(仍禁用 Bash,不抛错)", JSON.stringify(recDeny) === JSON.stringify(["Bash"]), recDeny);

    // ④ ★ 主文件损坏 + **无 last-good**(旧版/迁移用户)→ **抛错拒绝**,绝不返回空排除表。
    rmSync(lastGoodEngineToolPolicyPath(f), { force: true });
    writeFileSync(f, "not json at all");
    const refused = (() => { try { return { threw: false as const, v: resolveEngineExcludedToolsForProviderFile(f, "claude") }; } catch (e) { return { threw: true as const, msg: e instanceof Error ? e.message : String(e) }; } })();
    check("★ ④ 损坏且无备份 → 抛错拒绝(不静默返回空排除表把工具重新启用)", refused.threw === true, refused);
    check("★ ④ 错误带 POLICY_RECOVERY_REQUIRED 标记(供上层识别为需用户确认)", refused.threw === true && String(refused.msg).includes("POLICY_RECOVERY_REQUIRED"), refused);

    // ⑤ 空文件(0 字节)且无 last-good = 首次启动 → MISSING(不设限),不抛错(第 4b 段已测读,这里测 resolver 不误伤)。
    rmSync(lastGoodEngineToolPolicyPath(f), { force: true });
    writeFileSync(f, "");
    const emptyFirst = (() => { try { return { ok: true as const, v: resolveEngineExcludedToolsForProviderFile(f, "pi") }; } catch (e) { return { ok: false as const, e: String(e) }; } })();
    check("⑤ 空文件首次启动(无备份)→ 不设限,不误伤正常首启", emptyFirst.ok === true && emptyFirst.v.length === 0, emptyFirst);
  }

  /* ── 5. 接线：provider 真的读了策略并传给了 SDK ───────────────────────── */
  // 【MC-071 残余 E1】Provider 侧改走 `resolveEngineExcludedToolsForProvider` —— 「读策略
  // 状态」与「执行授权」**同源**的那条:INVALID 且无 last-good 时**抛错拒绝本轮**,而不是
  // 各自 `excludedToolsForEngine(readEngineToolPolicy(), …)` 拿到空排除表把原本禁用的工具
  // 静默重新启用。断言钉的是**那条 resolver 被真的调用**,不是旧的直读形态。
  const claudeSrc = readFileSync(resolve(process.cwd(), "src/main/providers/claude-sdk/ClaudeAgentSdkProvider.ts"), "utf8");
  check(
    "Claude provider 把策略接到 SDK 的 disallowedTools(走同源 resolver)",
    // 【MC-044】解析结果现在解**一次**三处共用(disallowedTools / 系统提示词的工具名 /
    // toolSelection)——断言钉「同源 resolver 被调用」+「disallowedTools 用的是它的结果」，
    // 不再钉旧的内联 IIFE 形状(那个形状随 MC-044 消失，不是行为回退)。
    claudeSrc.includes("resolveEngineExcludedToolsForProvider(\"claude\")") &&
      /disallowedTools:\s*excludedForTurn/.test(claudeSrc),
  );
  const piSrc = readFileSync(resolve(process.cwd(), "src/main/providers/pi-sdk/PiAgentSdkProvider.ts"), "utf8");
  check(
    "Pi provider 把策略接到 createAgentSession 的 excludeTools(走同源 resolver)",
    piSrc.includes("resolveEngineExcludedToolsForProvider(\"pi\")") &&
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
    "桥只列只读的四个(文档/页面图像/图片/环境概况)",
    bridgeSrc.includes('"agent_read_document"') &&
      bridgeSrc.includes('"agent_render_pdf_page"') &&
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
  // ⚠️ 装配序列已从 `index.ts` **抽进** `startup/assembleStartup.ts`(为了给启动链补无头回归网,
  // 见 startup-wiring-smoke)。所以这里要**两处都看**:
  //   ① 装配函数里真的 `setVisionRelayImpl(...)`(登记口是模块级单例,"定义了没人 set"最典型的假绿);
  //   ② `index.ts` **真的调了**那个装配函数 —— 否则成了「抽出去没人接线」的另一种假绿。
  // **先剥注释再匹配** —— 否则那句解释性注释里的 `assembleStartup()` 就命中了,等于用注释
  // 冒充接线(正是本断言要防的假绿)。只认**真调用**:剥注释后仍出现 `assembleStartup({`。
  const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const mainSrc = stripComments(readFileSync(resolve(process.cwd(), "src/main/index.ts"), "utf8"));
  const startupSrc = readFileSync(resolve(process.cwd(), "src/main/startup/assembleStartup.ts"), "utf8");
  check(
    "★ 应用装配时真的登记了中继实现(不是只定义了登记口)",
    startupSrc.includes("setVisionRelayImpl(") && /assembleStartup\(\{/.test(mainSrc),
  );
  const claudeSrc2 = readFileSync(resolve(process.cwd(), "src/main/providers/claude-sdk/ClaudeAgentSdkProvider.ts"), "utf8");
  const codexSrc = readFileSync(resolve(process.cwd(), "src/main/providers/codex-sdk/CodexAgentSdkProvider.ts"), "utf8")
    + "\n" + readFileSync(resolve(process.cwd(), "src/main/providers/codex-sdk/CodexDynamicTools.ts"), "utf8");
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

  /* ── ARC-017:工具结果的文本提取只有一份 ────────────────────────────────
   *
   * 权威实现是 `@main/mcp/sdk` 的 `textBlocksOf` / `toolTextOf`(用判别联合按块类型
   * 取文本,不把 `content` 断言成 `Record[]`)。Pi 与 Codex 从前各自手写一句
   * `result.content.map(c => c.type === "text" ? c.text : "")` —— 那正是 ARC-017 要收口
   * 的"同一份形状抄两遍":SDK 加一种新块(截图/资源)时各抄一份的地方会与真结构漂移。
   * 这里断言它们都改走权威实现、且**不再留**手写的那一句。 */
  check("ARC-017:Codex 结果文本走权威 textBlocksOf(不再手写 map)", codexSrc.includes("textBlocksOf(result)"));
  check("ARC-017:Pi 结果文本走权威 toolTextOf(不再手写 map)", piSrc2.includes("toolTextOf(result)"));
  check(
    "ARC-017:三个引擎源码里都不再手写块提取(同一形状不抄第二遍)",
    !codexSrc.includes('content.map(c => ({ type: "inputText"') &&
      !piSrc2.includes('.content.map(c => c.type === "text"'),
  );
  // 收口也要覆盖 smoke 侧——一条 `document-read-smoke` 曾把同一句
  // `.content.filter(x=>x.type==="text").map(x=>x.text).join("\n")` 抄了 8 遍。
  // 断言它改走权威 toolTextOf,且**不再留**那句手写拼接(与上面 Pi/Codex 同一判据)。
  {
    const docReadSrc = readFileSync(resolve(process.cwd(), "scripts/document-read-smoke/main.ts"), "utf8");
    check("ARC-017:document-read-smoke 走权威 toolTextOf", docReadSrc.includes("toolTextOf"));
    check(
      "ARC-017:document-read-smoke 不再手写块提取(同一形状不抄第二遍)",
      !docReadSrc.includes('.content.filter(x=>x.type==="text")'),
    );
  }

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

  /* ── 9.【MC-042】**行为**测执行路径:错形不再被容错过滤,无恢复时拒绝执行 ──────────
   *
   * 台账红例:`{"claude":{"exclude":"Bash"}}`(想禁用 Bash 的配置被改错形)经真实
   * `readEngineToolPolicyDetailed` 返回 `status:"VALID"` → resolver 返回 `[]` →
   * Provider 拿 `disallowedTools: undefined` 起轮 —— 限制被**静默解除**。
   * 本段是**端到端**复现(真 resolver,显式路径版与默认路径版各一),断言:
   *   - 错形 → INVALID,不再 VALID;
   *   - 无备份 → resolver **抛错拒绝**(`[]` 变拒绝,这正是红例的那个方向);
   *   - 有备份 → 恢复原限制继续(禁用 Bash 还在,不回归);
   *   - 从没设过 / 明确空数组 → 照常不设限(不误伤)。
   */
  {
    const f = join(dir, "mc042-resolver.json");
    rmSync(f, { force: true }); rmSync(lastGoodEngineToolPolicyPath(f), { force: true });

    // ① ★ 台账红例的当前形态:错形 + 无备份。旧代码:VALID + []。现在:INVALID + 拒绝。
    writeFileSync(f, JSON.stringify({ claude: { exclude: "Bash" } }));
    const wrongShape = readEngineToolPolicyDetailed(f);
    check(
      "★ ① 错形配置(想禁 Bash)→ INVALID(不再被容错过滤成 VALID)",
      wrongShape.status === "INVALID" && wrongShape.error!.includes("claude.exclude"),
      wrongShape,
    );
    const hitWall = (() => { try { return { threw: false as const, v: resolveEngineExcludedToolsForProviderFile(f, "claude") }; } catch (e) { return { threw: true as const, msg: e instanceof Error ? e.message : String(e) }; } })();
    check(
      "★ ① 错形且无备份 → resolver 拒绝执行(不再静默返回空排除表)",
      hitWall.threw === true && String(hitWall.msg).includes("POLICY_RECOVERY_REQUIRED"),
      hitWall,
    );

    // ② 有 last-good(写着禁用 Bash)→ 错形后按恢复值继续:限制不丢。
    rmSync(f, { force: true }); rmSync(lastGoodEngineToolPolicyPath(f), { force: true });
    writeEngineToolPolicyFile(f, { claude: { exclude: ["Bash"] } });
    writeFileSync(f, JSON.stringify({ claude: { exclude: "Bash" } }));
    const recovered = resolveEngineExcludedToolsForProviderFile(f, "claude");
    check(
      "★ ② 错形但有备份 → 恢复原限制继续(Bash 仍被禁用,不静默放开)",
      JSON.stringify(recovered) === JSON.stringify(["Bash"]),
      recovered,
    );

    // ③ 明确空数组(用户主动全启用)→ resolver 不误伤,照常不设限。
    rmSync(lastGoodEngineToolPolicyPath(f), { force: true });
    writeFileSync(f, JSON.stringify({ claude: { exclude: [] } }));
    const explicitOpen = (() => { try { return { ok: true as const, v: resolveEngineExcludedToolsForProviderFile(f, "pi") }; } catch (e) { return { ok: false as const, e: String(e) }; } })();
    check("③ 明确空数组 → 不设限、不抛错(用户主动全启用不误伤)", explicitOpen.ok === true && explicitOpen.v.length === 0, explicitOpen);

    // ③b 主文件与 last-good **同时**损坏(验收条件里的组合)→ 仍 INVALID 且拒绝执行。
    rmSync(f, { force: true }); rmSync(lastGoodEngineToolPolicyPath(f), { force: true });
    writeFileSync(f, "{ 主文件也坏了");
    writeFileSync(lastGoodEngineToolPolicyPath(f), "{ 备份也坏了");
    const bothBroken = readEngineToolPolicyDetailed(f);
    check(
      "★ ③b 主文件与 last-good 同时损坏 → INVALID 且 recovered=false(不误报恢复)",
      bothBroken.status === "INVALID" && bothBroken.recovered === false,
      bothBroken,
    );
    const bothRefused = (() => { try { resolveEngineExcludedToolsForProviderFile(f, "claude"); return { threw: false as const }; } catch (e) { return { threw: true as const, msg: e instanceof Error ? e.message : String(e) }; } })();
    check("★ ③b 双损坏 → resolver 拒绝执行(不静默返回空排除表)", bothRefused.threw === true, bothRefused);

    // ④ 覆写损坏原件前先把原始字节备份成 .corrupt-<时间戳>.bak,不静默销毁。
    const f2 = join(dir, "mc042-preserve.json");
    rmSync(f2, { force: true }); rmSync(lastGoodEngineToolPolicyPath(f2), { force: true });
    const brokenBytes = JSON.stringify({ claude: { exclude: "Bash", handwritten: true } });
    writeFileSync(f2, brokenBytes);
    writeEngineToolPolicyFile(f2, { claude: { exclude: ["Read"] } });
    const backups = readdirSync(dir).filter((n) => n.startsWith("mc042-preserve.json.corrupt-") && n.endsWith(".bak"));
    check(
      "★ ④ 覆写损坏原件前留了 .corrupt-<时间戳>.bak 备份",
      backups.length === 1 && readFileSync(join(dir, backups[0]), "utf-8") === brokenBytes,
      { backups },
    );
    const afterFix = readEngineToolPolicyDetailed(f2);
    check(
      "★ ④ 显式保存后配置恢复 VALID(保存是 resolver 拒绝语指向的恢复路径)",
      afterFix.status === "VALID" && JSON.stringify(afterFix.policy) === JSON.stringify({ claude: { exclude: ["Read"] } }),
      afterFix,
    );
    // 正常文件覆写**不**堆备份垃圾(last-good 另算,文件名不同不会命中)。
    writeEngineToolPolicyFile(f2, { claude: { exclude: ["Bash"] } });
    const backupsAfterClean = readdirSync(dir).filter((n) => n.startsWith("mc042-preserve.json.corrupt-"));
    check("④ 正常文件覆写不产生新的 .corrupt 备份", backupsAfterClean.length === 1, { backupsAfterClean });
  }

  /* ── 10.【MC-042】**行为**测 IPC handler(默认路径)─────────────────────────
   *
   * 第 5 节钉的是"Provider 源码里有那行调用";这里用 fakeIpc 真跑
   * `registerEngineToolHandlers` 的两个 handler(它们走 `defaultEngineToolPolicyPath()`,
   * 即本套隔离 HOME 下的 `~/.mcode/engine-tools.json`)——断言用户/Agent 真正看到的
   * 行为:`engineTools.set` 非法名显式拒绝(不再静默剔除)、保存后生效、
   * `engineTools.get` 把损坏状态讲出来(而不是假装"没限制")。 */
  {
    const policyFile = defaultEngineToolPolicyPath();
    rmSync(policyFile, { force: true });
    rmSync(lastGoodEngineToolPolicyPath(policyFile), { force: true });

    const handlers = new Map<string, (evt: unknown, raw: unknown) => Promise<unknown>>();
    const fakeIpc = { handle: (ch: string, fn: never) => handlers.set(ch, fn) } as never;
    registerEngineToolHandlers(fakeIpc);
    const call = (ch: string, raw: unknown): Promise<unknown> => handlers.get(ch)!(null, raw);

    check("fakeIpc 注册了 engineTools.get / set", handlers.has("engineTools:get") && handlers.has("engineTools:set"), [...handlers.keys()]);

    // 从没设过 → 面板显示"不设限"且无告警,设置页能正常用。
    const fresh = (await call("engineTools:get", {})) as { status?: string; engines: Record<string, { exclude: string[] }> };
    check(
      "① 从没设过 → get 返回 MISSING 且无 warning(正常首启不误伤)",
      fresh.status === "MISSING" && JSON.stringify(fresh.engines.claude.exclude) === JSON.stringify([]),
      fresh,
    );

    // 正常保存 → ok,且下一轮真的禁。
    const saved = (await call("engineTools:set", { engine: "claude", exclude: ["Bash"] })) as { ok: boolean; snapshot?: { engines: Record<string, { exclude: string[] }> } };
    check(
      "② set 保存合法列表 → ok 且快照回读一致",
      saved.ok === true && JSON.stringify(saved.snapshot?.engines.claude.exclude) === JSON.stringify(["Bash"]),
      saved,
    );
    check(
      "② 保存后执行路径真的禁用 Bash(同一份默认路径)",
      JSON.stringify(resolveEngineExcludedToolsForProviderFile(policyFile, "claude")) === JSON.stringify(["Bash"]),
      { read: readEngineToolPolicyDetailed(policyFile) },
    );

    // ★ 非法名 → 显式拒绝整个保存(不再静默剔除)。判据立在**用户看到的那行字**上。
    const beforeBad = readFileSync(policyFile, "utf-8");
    const badSave = (await call("engineTools:set", { engine: "claude", exclude: ["Bash", "has space", "Read"] })) as { ok: boolean; error?: string };
    check(
      "★ ③ 非法名 → 整个保存显式拒绝(不再静默剔掉后报成功)",
      badSave.ok === false && typeof badSave.error === "string" && badSave.error.includes("工具名不合法"),
      badSave,
    );
    check("★ ③ 被拒后盘上字节一个都没变", readFileSync(policyFile, "utf-8") === beforeBad);
    check(
      "★ ③ 被拒后 Bash 的禁用照旧(拒绝不是「清空」)",
      JSON.stringify(resolveEngineExcludedToolsForProviderFile(policyFile, "claude")) === JSON.stringify(["Bash"]),
      { read: readEngineToolPolicyDetailed(policyFile) },
    );

    // ★ 文件错形 + **无 last-good** → get 显式告警;执行路径此时拒绝起轮。
    // (先删 last-good,把场景钉在"旧版/迁移用户旧限制丢失"的那条红例上;有备份的
    // 恢复路径在第 9 节②已测。)
    rmSync(lastGoodEngineToolPolicyPath(policyFile), { force: true });
    writeFileSync(policyFile, JSON.stringify({ claude: { exclude: "Bash" } }));
    const corruptView = (await call("engineTools:get", {})) as { status?: string; recovered?: boolean; warning?: string };
    check(
      "★ ④ 错形文件 → get 返回 INVALID + 可读告警(面板能讲清)",
      corruptView.status === "INVALID" && corruptView.recovered !== true &&
        typeof corruptView.warning === "string" && corruptView.warning.includes("损坏"),
      corruptView,
    );
    const providerRefusal = (() => { try { return { threw: false as const, v: resolveEngineExcludedToolsForProviderFile(policyFile, "claude") }; } catch (e) { return { threw: true as const, msg: e instanceof Error ? e.message : String(e) }; } })();
    check(
      "★ ④ 错形 + 无备份 → 执行路径拒绝(与 get 的告警一致,不是「按不设限跑」)",
      providerRefusal.threw === true,
      providerRefusal,
    );

    // ⑤ 经 IPC 显式重存(用户在设置页的动作)→ 恢复 VALID,且损坏原件留了备份。
    const repair = (await call("engineTools:set", { engine: "claude", exclude: ["Bash"] })) as { ok: boolean; snapshot?: { status?: string } };
    check(
      "★ ⑤ 用户重存 → 恢复 ok/VALID(拒绝语指向的恢复路径走得通)",
      repair.ok === true && repair.snapshot?.status === "VALID",
      repair,
    );
    const ipcBackups = readdirSync(join(SMOKE_HOME, ".mcode")).filter((n) => n.startsWith("engine-tools.json.corrupt-") && n.endsWith(".bak"));
    check(
      "★ ⑤ 重存前损坏原件已备份成 .corrupt-<时间戳>.bak(不静默销毁)",
      ipcBackups.length === 1 && readFileSync(join(SMOKE_HOME, ".mcode", ipcBackups[0]), "utf-8").includes('"exclude":"Bash"'),
      { ipcBackups, content: readFileSync(join(SMOKE_HOME, ".mcode", ipcBackups[0]), "utf-8") },
    );
  }

  /* ══════════ 【MC-043】工具使用说明(guidance):只进提示词、不改权限 ══════════
   *
   * 台账:面板只有禁用勾选,用户想在"搜索/读取"上改优先级/默认策略(而不禁用原生工具)
   * 时无处可写。修复后 guidance 存在**同一份**策略文件里(复用严格 Schema / last-good /
   * 损坏保护),三个 provider 各注入一段带硬边界的说明。
   * 判据:①契约不再丢弃该字段;②写进去能读出来;③超限/错形显式拒绝;
   *      ④渲染出的提示词明说"不是权限指令";⑤禁用与说明是两件独立的事。
   */
  {
    const { validateEngineToolPolicy, resolveEngineToolGuidanceForProviderFile } = await import("@main/lib/engineToolPolicy.js");
    const { toolGuidancePrompt, readToolNameForTurn } = await import("@main/lib/systemPrompt.js");

    // ① 严格 Schema 接受 guidance,并保留 exclude。
    const okPolicy = validateEngineToolPolicy({ claude: { exclude: ["Bash"], guidance: "读 PDF 优先 agent_read_document。" } });
    check("★ MC-043:严格 Schema 接受 guidance 且保留 exclude",
      okPolicy.ok === true && okPolicy.policy.claude?.exclude.join() === "Bash" && okPolicy.policy.claude?.guidance === "读 PDF 优先 agent_read_document。",
      okPolicy);

    // ② 单独 guidance(不禁用任何工具)也合法 —— "只改说明"是核心用例。
    const onlyGuidance = validateEngineToolPolicy({ pi: { exclude: [], guidance: "搜索用 grep,不要 bash grep。" } });
    check("★ MC-043:只有 guidance、exclude 为空也合法(只改说明不禁用)",
      onlyGuidance.ok === true && onlyGuidance.policy.pi?.guidance === "搜索用 grep,不要 bash grep。" && onlyGuidance.policy.pi?.exclude.length === 0,
      onlyGuidance);

    // ③ 超限 / 非字符串 / 未知字段 → 显式拒绝(不静默丢)。
    const tooLong = validateEngineToolPolicy({ claude: { exclude: [], guidance: "x".repeat(4001) } });
    check("★ MC-043:guidance 超上限 → 显式拒绝(不静默截断)", tooLong.ok === false && /4000/.test(tooLong.error), tooLong);
    const notString = validateEngineToolPolicy({ claude: { exclude: [], guidance: 42 } });
    check("MC-043:guidance 非字符串 → 显式拒绝", notString.ok === false && /guidance 必须是字符串/.test(notString.error), notString);
    const unknown = validateEngineToolPolicy({ claude: { exclude: [], toolPrompt: "x" } });
    check("MC-043:未知字段仍判 INVALID(写错字段名 = 以为设了实际没设)", unknown.ok === false && /未知字段/.test(unknown.error), unknown);

    // ④ 落盘 → 读回(真文件,隔离 HOME)。
    const { writeEngineToolPolicy, defaultEngineToolPolicyPath } = await import("@main/lib/engineToolPolicy.js");
    writeEngineToolPolicy({ claude: { exclude: [], guidance: "  读资料库 PDF 走 agent_read_document。  " } });
    const readBack = resolveEngineToolGuidanceForProviderFile(defaultEngineToolPolicyPath(), "claude");
    check("★ MC-043:写盘后按引擎读回 guidance(首尾空白被规范化)", readBack === "读资料库 PDF 走 agent_read_document。", readBack);
    check("MC-043:没写说明的引擎读回空串", resolveEngineToolGuidanceForProviderFile(defaultEngineToolPolicyPath(), "pi") === "");

    // ⑤ 提示词渲染:非空才成段,且明说是偏好、不改权限、不能当调用禁用工具的理由。
    const rendered = toolGuidancePrompt("claude", "读 PDF 优先 agent_read_document。");
    check("★ MC-043:提示词段明确标注「偏好,不是权限指令」",
      rendered.includes("用户的工具使用偏好") && rendered.includes("不是权限指令"), rendered.slice(0, 200));
    check("★ MC-043:提示词段写明不改变工具可用性(不能当调用禁用工具的理由)",
      rendered.includes("不改变任何工具的实际可用性"), rendered.slice(0, 300));
    check("MC-043 正控:空 guidance 不产生任何片段(不改变默认行为)", toolGuidancePrompt("claude", "   ") === "");

    // ⑥ 两件事独立:guidance 不影响读工具名的派生(禁用才影响)。
    check("★ MC-043:说明不清除工具名(guidance 与 exclude 互不干扰)",
      readToolNameForTurn("claude", []) === "Read");

    // ⑦ 【ARC-003 验收】「切引擎不串提示」:三份说明并存时各读各的,互不串。
    writeEngineToolPolicy({
      claude: { exclude: [], guidance: "CLAUDE-ONLY 优先 Read" },
      pi: { exclude: [], guidance: "PI-ONLY 用 read" },
      codex: { exclude: [], guidance: "CODEX-ONLY 走 shell" },
    });
    const gClaude = resolveEngineToolGuidanceForProviderFile(defaultEngineToolPolicyPath(), "claude");
    const gPi = resolveEngineToolGuidanceForProviderFile(defaultEngineToolPolicyPath(), "pi");
    const gCodex = resolveEngineToolGuidanceForProviderFile(defaultEngineToolPolicyPath(), "codex");
    check("★ ARC-003:三引擎说明各读各的(切引擎不串提示)",
      gClaude.includes("CLAUDE-ONLY") && !gClaude.includes("PI-ONLY") && !gClaude.includes("CODEX-ONLY") &&
      gPi.includes("PI-ONLY") && !gPi.includes("CLAUDE-ONLY") &&
      gCodex.includes("CODEX-ONLY") && !gCodex.includes("CLAUDE-ONLY"),
      { gClaude, gPi, gCodex });
    // 渲染面同样隔离:每段只含自己那一份。
    check("★ ARC-003:渲染出的片段只含本引擎的说眀",
      toolGuidancePrompt("claude", gClaude).includes("CLAUDE-ONLY") &&
      !toolGuidancePrompt("claude", gClaude).includes("PI-ONLY") &&
      toolGuidancePrompt("pi", gPi).includes("PI-ONLY"));
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nengine-tools-smoke: ${total - failures}/${total} checks passed`);
if (failures > 0) process.exit(1);
