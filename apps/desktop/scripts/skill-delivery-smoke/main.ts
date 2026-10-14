/**
 * 【MC-077 / MC-094】三引擎**真实交付负例**回归 —— 驱动真的 provider `startTurn`,
 * 断言「引擎最终拿到的那份技能目录/名单」。
 *
 * ## 为什么需要这一套(补的是台账复审点名的缺口)
 *
 * MC-077 的复审结论是 REVIEW_PARTIAL:缺口**不是**「矩阵 → 纯函数交付集合」的映射
 * (那已由 `skill-engines-smoke` / `mcp-engines-smoke` 覆盖),而是**真实三 SDK 的最终
 * 可见目录、以及切换/损坏后的投递负例未验证**。MC-094 的缺口类似:Pi/Codex 的项目
 * 技能根已接,但「真实模型读 SKILL.md + 文件」这一层未取样。
 *
 * ## 这一套怎么补(比纯函数更靠近引擎一次)
 *
 * 本套件**驱动真的 provider 类**(不做任何生产代码改动),只在 SDK 边界换桩 —— 换桩点
 * 就是引擎真正收东西的那一句:
 *   - Claude:`query({ prompt, options })` 的 `options.skills`;
 *   - Codex:`client.request("skills/extraRoots/set", { extraRoots })` 的 `extraRoots`;
 *   - Pi:`createAgentSession({ resourceLoader })` 收到的那个真 loader 的 `getSkills()`
 *     (名字 + `baseDir`)。
 *
 * 于是「矩阵改了 / 项目里放了同名 / 矩阵文件写坏了」之后,**引擎这一侧最终会看到什么**
 * 是可断言的,而不是靠读源码相信调用点接对了。判据立在交付集合上,不是立在"某段代码
 * 在不在"。
 *
 * ## 覆盖的负例(每个引擎尽可能)
 *   ① 被禁技能**不在**该引擎交付集合;
 *   ② 开关往返 enable→disable→enable 逐次到达交付集合;
 *   ③ 同一目录的**禁用即时生效**(改矩阵→再起一轮→立即消失/恢复,不缓存);
 *   ④ 同名冲突:项目那份覆盖全局那份且**只交付一次**;撤掉项目那份后全局那份**重现**;
 *   ⑤ 损坏(有效 JSON、值类型错)+ **无 last-good** → 交付集合**空**(fail-closed),
 *      绝不给一个"截断但看着合理"的集合;
 *   ⑥ 损坏 + 有 last-good → 按备份恢复,原禁用**不复活**。
 *
 * ## 诚实边界(仍需真模型 / U1)
 *   本套件的桩按各家**公开语义**复刻发现过程(尤其 Pi 的 `<root>/<name>/SKILL.md`
 *   扫描),证的仍是「宿主交给 SDK 的入参正确」这一层。**真** claude/codex/pi 二进制
 *   读到这些根之后**自己**如何扫描、以什么名字暴露、同名谁赢,仍须活会话验收 ——
 *   尤其 Codex(闭源二进制,`skills/extraRoots/set` 是否把一个直接含 SKILL.md 的根当
 *   单个技能,注释里已标 UNVERIFIED)。本套件在结论里如实标注,不冒充到那一步。
 *
 * Run: scripts/skill-delivery-smoke/run.sh
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAgentSdkProvider } from "@main/providers/claude-sdk/ClaudeAgentSdkProvider.js";
import { CodexAgentSdkProvider } from "@main/providers/codex-sdk/CodexAgentSdkProvider.js";
import { PiAgentSdkProvider } from "@main/providers/pi-sdk/PiAgentSdkProvider.js";
import {
  enginesMapPath,
  lastGoodEnginesMapPath,
  writeEnginesMap,
} from "@main/lib/skillEngines.js";

/* ── 断言助手(与其它 smoke 同款) ── */
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
function eqDeep(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}
/** 集合比较(排序无关)。 */
function eqSet(name: string, actual: string[], expected: string[]): void {
  const a = [...actual].sort().join(",");
  const e = [...expected].sort().join(",");
  check(name, a === e, { actual: a, expected: e });
}

/* ── 交付观察窗口(各桩写进 globalThis 的那一份) ── */
interface ClaudeDelivery {
  skills: unknown;
  options: Record<string, unknown> | null;
  calls: number;
}
interface CodexDelivery {
  extraRoots: string[] | null;
  dynamicToolNames: string[] | null;
  calls: string[];
}
interface PiDelivery {
  loader:
    | {
        getSkills(): { skills: Array<{ name: string; baseDir?: string }>; diagnostics: unknown[] };
      }
    | null;
  tools: unknown;
  excludeTools: unknown;
  calls: number;
}
const g = globalThis as unknown as {
  __claudeDelivery?: ClaudeDelivery;
  __codexDelivery?: CodexDelivery;
  __piDelivery?: PiDelivery;
};

/* ── 宿主 ctx 桩:不进入工具执行,只记录事件 ── */
function makeCtx() {
  const events: Array<{ type?: string; code?: string }> = [];
  const ctx = {
    emit: (e: unknown) => {
      events.push(e as never);
    },
    onProviderSessionId: () => {},
    onResumeOutcome: () => {},
    requestApproval: async () => ({ decision: "deny" as const }),
    requestUserInput: async () => ({ answers: [] }),
    requestPlanApproval: async () => ({ decision: "reject" as const }),
    isToolAlwaysAllowed: () => false,
    getPermissionMode: () => "default" as const,
    log: { info() {}, warn() {}, error() {} },
  };
  return { ctx, events };
}

/* ── 夹具:临时家目录(控 defaultSkillsRoot)+ 数据根 + 项目目录 ── */
const root = mkdtempSync(join(tmpdir(), "mcode-skill-delivery-"));
const home = join(root, "home");
mkdirSync(home, { recursive: true });
process.env["HOME"] = home;
process.env["USERPROFILE"] = home;

const skillsRoot = join(home, ".mcode", "skills");
const projectDir = join(root, "proj");
const projectSkillsRoot = join(projectDir, ".claude", "skills");

/** 在 `base/<sub>/<name>/SKILL.md` 放一个技能(frontmatter 名 = name)。 */
function putSkill(base: string, name: string, dirName = name): string {
  const dir = join(base, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\n---\n`, "utf-8");
  return dir;
}

const matrixFile = enginesMapPath(skillsRoot);
function writeMatrix(map: Record<string, Record<string, boolean>>): void {
  writeEnginesMap(skillsRoot, map);
}
/** 写坏主文件并确保没有 last-good(模拟"损坏且无备份")。 */
function corruptNoBackup(text: string): void {
  writeFileSync(matrixFile, text, "utf-8");
  rmSync(lastGoodEnginesMapPath(matrixFile), { force: true });
}

/* ── 驱动一次真实交付(每引擎各一次 startTurn) ── */
async function claudeDeliveredSkills(cwd: string): Promise<unknown> {
  g.__claudeDelivery = { skills: undefined, options: null, calls: 0 };
  const { ctx } = makeCtx();
  const provider = new ClaudeAgentSdkProvider();
  const handle = await provider.startTurn(
    { sessionId: "cl-deliver", cwd, prompt: "hi" } as never,
    ctx as never,
  );
  await handle.done;
  return g.__claudeDelivery.skills;
}

async function codexDeliveredRoots(cwd: string): Promise<string[]> {
  g.__codexDelivery = { extraRoots: null, dynamicToolNames: null, calls: [] };
  const { ctx } = makeCtx();
  const provider = new CodexAgentSdkProvider();
  const handle = await provider.startTurn(
    { sessionId: "cx-deliver", cwd, prompt: "hi" } as never,
    ctx as never,
  );
  await handle.done;
  await new Promise((r) => setTimeout(r, 5));
  return g.__codexDelivery.extraRoots ?? [];
}

async function piDelivered(cwd: string): Promise<Array<{ name: string; baseDir?: string }>> {
  g.__piDelivery = { loader: null, tools: undefined, excludeTools: undefined, calls: 0 };
  const { ctx } = makeCtx();
  const provider = new PiAgentSdkProvider();
  const handle = await provider.startTurn(
    { sessionId: "pi-deliver", cwd, prompt: "hi" } as never,
    ctx as never,
  );
  await handle.done;
  const loader = g.__piDelivery.loader;
  if (!loader) return [];
  return loader.getSkills().skills.map((s) => ({ name: s.name, baseDir: s.baseDir }));
}

/* ── MC-100/101:驱动一次带**画像/预算**的真实 startTurn,回引擎真正收到的工具形态 ── */
type ProfileReq = { toolProfile?: { name: string }; toolBudget?: { maxTools?: number; maxTokens?: number } };

/** Claude:回 `query()` 收到的 options(mcpServers / tools)。 */
async function claudeDeliveredOptions(cwd: string, profile: ProfileReq["toolProfile"], budget?: ProfileReq["toolBudget"]): Promise<Record<string, unknown>> {
  g.__claudeDelivery = { skills: undefined, options: null, calls: 0 };
  const { ctx } = makeCtx();
  const provider = new ClaudeAgentSdkProvider();
  const handle = await provider.startTurn(
    { sessionId: "cl-profile", cwd, prompt: "hi", toolProfile: profile, toolBudget: budget } as never,
    ctx as never,
  );
  await handle.done;
  return g.__claudeDelivery.options ?? {};
}

/** Pi:回 `createAgentSession` 收到的 { tools, excludeTools }。 */
async function piDeliveredTools(cwd: string, profile: ProfileReq["toolProfile"], budget?: ProfileReq["toolBudget"]): Promise<{ tools: unknown; excludeTools: unknown }> {
  g.__piDelivery = { loader: null, tools: undefined, excludeTools: undefined, calls: 0 };
  const { ctx } = makeCtx();
  const provider = new PiAgentSdkProvider();
  const handle = await provider.startTurn(
    { sessionId: "pi-profile", cwd, prompt: "hi", toolProfile: profile, toolBudget: budget } as never,
    ctx as never,
  );
  await handle.done;
  return { tools: g.__piDelivery.tools, excludeTools: g.__piDelivery.excludeTools };
}

/** Codex:回 `thread/start` 收到的 dynamicTools 名字列表。 */
async function codexDeliveredToolNames(cwd: string, profile: ProfileReq["toolProfile"], budget?: ProfileReq["toolBudget"]): Promise<string[] | null> {
  g.__codexDelivery = { extraRoots: null, dynamicToolNames: null, calls: [] };
  const { ctx } = makeCtx();
  const provider = new CodexAgentSdkProvider();
  const handle = await provider.startTurn(
    { sessionId: "cx-profile", cwd, prompt: "hi", toolProfile: profile, toolBudget: budget } as never,
    ctx as never,
  );
  await handle.done;
  await new Promise((r) => setTimeout(r, 5));
  return g.__codexDelivery.dynamicToolNames;
}

/* ── 夹具:全球库 alpha / beta,项目专有 proj-only,同名 shadow ── */
putSkill(skillsRoot, "alpha");
putSkill(skillsRoot, "beta");
putSkill(projectSkillsRoot, "proj-only");

try {
  /* ═════════════ §A Claude:`options.skills` 真实交付 ═════════════ */
  console.log("\n§A Claude:query() 收到的 options.skills(真实 startTurn)");
  {
    // A1 基线:无矩阵 → "all"(引擎自发现)。
    rmSync(matrixFile, { force: true });
    rmSync(lastGoodEnginesMapPath(matrixFile), { force: true });
    eqDeep("A1 无矩阵 → claude 交付 skills = \"all\"(不设限)", await claudeDeliveredSkills(projectDir), "all");

    // A2 限制:beta 对 claude 禁 → 交付集合不再含 beta。
    writeMatrix({ beta: { claude: false } });
    const a2 = (await claudeDeliveredSkills(projectDir)) as string[];
    eqSet("★ A2 claude 禁 beta → 交付集合无 beta(也不给 'all')", a2, ["alpha"]);
    check("★ A2 交付不是 \"all\"(限制后切到显式白名单)", Array.isArray(a2), a2);

    // A3 开关往返:disable → enable,beta 回到交付集合。
    // 保留 gamma 对 claude 的禁用,使矩阵**始终受限**(否则全放行 → 交付退化成 "all",
    // 往返就观察不到数组形态下的复现)。于是交付集合恒是数组,能逐项断言 beta 的去/回。
    putSkill(skillsRoot, "gamma");
    writeMatrix({ gamma: { claude: false } });
    const a3on = (await claudeDeliveredSkills(projectDir)) as string[];
    check("★ A3 往返起点 beta 在 claude 交付集合", Array.isArray(a3on) && a3on.includes("beta"), a3on);
    writeMatrix({ gamma: { claude: false }, beta: { claude: false } });
    const a3off = (await claudeDeliveredSkills(projectDir)) as string[];
    check("★ A3 禁 beta → 交付集合不含 beta", Array.isArray(a3off) && !a3off.includes("beta"), a3off);
    writeMatrix({ gamma: { claude: false } });
    const a3back = (await claudeDeliveredSkills(projectDir)) as string[];
    check("★ A3 再放行 beta → 回到交付集合(重算,不缓存)", Array.isArray(a3back) && a3back.includes("beta"), a3back);
    rmSync(join(skillsRoot, "gamma"), { recursive: true, force: true }); // 清掉辅助技能,不污染 §B/§C

    // A4 损坏(有效 JSON、值类型错)+ 无 last-good → 交付**空**(fail-closed)。
    corruptNoBackup(JSON.stringify({ beta: 5 }));
    const a4 = await claudeDeliveredSkills(projectDir);
    eqDeep("★ A4 损坏无备份 → claude 交付 skills = [](fail-closed,不是 'all' 也不是截断集)", a4, []);
    check("★ A4 也不是 \"all\"(坏文件绝不放行全量)", a4 !== "all", a4);

    // A5 损坏 + 有 last-good → 按备份恢复,原禁用不复活。
    writeMatrix({ beta: { claude: false } }); // 刷新 last-good(禁用仍在)
    writeFileSync(matrixFile, JSON.stringify({ beta: 5 }), "utf-8"); // 主文件写坏
    const a5 = (await claudeDeliveredSkills(projectDir)) as string[];
    check("★ A5 损坏有备份 → claude 恢复 last-good 后 beta 仍不在交付(不复活)",
      Array.isArray(a5) && !a5.includes("beta"), a5);
  }

  /* ═════════════ §B Codex:`skills/extraRoots/set` 真实交付 ═════════════ */
  console.log("\n§B Codex:skills/extraRoots/set 收到的 extraRoots(真实 startTurn)");
  {
    // B1 基线:无矩阵 → 交整根(引擎自己走)。
    rmSync(matrixFile, { force: true });
    rmSync(lastGoodEnginesMapPath(matrixFile), { force: true });
    const b1 = await codexDeliveredRoots(projectDir);
    check("B1 无矩阵 → codex 交付全局技能根整根",
      b1.some((d) => d.replace(/\\/g, "/").endsWith("/.mcode/skills")), b1);

    // B2 §MC-094:项目技能根 `<cwd>/.claude/skills` 到达交付(精确到那条路径,不是"含 proj"的模糊判据)。
    const wantedProjectRoot = projectSkillsRoot.replace(/\\/g, "/");
    check("★ B2 MC-094:项目技能根 <cwd>/.claude/skills 精确到达 codex 交付",
      b1.some((d) => d.replace(/\\/g, "/") === wantedProjectRoot),
      { extraRoots: b1.map((d) => d.replace(/\\/g, "/")), wantedProjectRoot });

    // B3 限制:beta 对 codex 禁 → 交付改为"启用目录",beta 目录不在其中。
    writeMatrix({ beta: { codex: false } });
    const b3 = await codexDeliveredRoots(projectDir);
    check("★ B3 codex 禁 beta → 交付不含 beta 目录", !b3.some((d) => d.split(/[\\/]/).pop() === "beta"), b3);
    check("★ B3 交付的是 alpha(放行项)自己的目录", b3.some((d) => d.split(/[\\/]/).pop() === "alpha"), b3);

    // B4 损坏 + 无 last-good → 交付**空**(fail-closed)。
    corruptNoBackup(JSON.stringify({ beta: 5 }));
    const b4 = await codexDeliveredRoots(projectDir);
    eqDeep("★ B4 损坏无备份 → codex 交付 extraRoots = [](fail-closed,不给截断集)", b4, []);

    // B5 损坏 + 有 last-good → 恢复后 beta 仍不交付。
    writeMatrix({ beta: { codex: false } });
    writeFileSync(matrixFile, JSON.stringify({ beta: 5 }), "utf-8");
    const b5 = await codexDeliveredRoots(projectDir);
    check("★ B5 损坏有备份 → codex 恢复后 beta 目录仍不在交付(不复活)",
      !b5.some((d) => d.split(/[\\/]/).pop() === "beta"), b5);
  }

  /* ═════════════ §C Pi:真 loader 的 getSkills()(名字 + baseDir) ═════════════ */
  console.log("\n§C Pi:createAgentSession 收到的真 loader 解析结果(真实 startTurn)");
  {
    // C1 基线:全局 alpha/beta + 项目 proj-only 都到达 Pi。
    rmSync(matrixFile, { force: true });
    rmSync(lastGoodEnginesMapPath(matrixFile), { force: true });
    const c1 = (await piDelivered(projectDir)).map((s) => s.name);
    eqSet("C1 无矩阵 → Pi 交付 {alpha,beta,proj-only}(全局+项目)",
      c1, ["alpha", "beta", "proj-only"]);

    // C2 §MC-094 同名优先级:全局 + 项目各一份 shadow,只交付一次且是项目那份;
    //    撤掉项目那份→被压住的全局那份**必须重现**(否则上一条可能只是"全局不在")。
    const shadowGlobal = putSkill(skillsRoot, "shadow");
    const shadowProject = putSkill(projectSkillsRoot, "shadow");
    const c2 = (await piDelivered(projectDir)).filter((s) => s.name === "shadow");
    check("★ C2 同名(全局+项目)只交付一次", c2.length === 1, c2.map((s) => s.baseDir));
    check("★ C2 交付的是**项目**那份(baseDir 在 .claude/skills)",
      !!c2[0]?.baseDir && c2[0].baseDir.replace(/\\/g, "/").includes("/.claude/skills/"),
      c2[0]?.baseDir);
    rmSync(shadowProject, { recursive: true, force: true });
    const c2b = (await piDelivered(projectDir)).filter((s) => s.name === "shadow");
    check("★ C2 撤掉项目同名件 → 被压住的全局件重现(优先级真承重)",
      c2b.length === 1 && !!c2b[0]?.baseDir && c2b[0].baseDir.replace(/\\/g, "/").includes("/.mcode/skills/"),
      c2b.map((s) => s.baseDir));
    rmSync(shadowGlobal, { recursive: true, force: true });

    // C3 禁用**即时生效**:同一目录只翻矩阵,每轮重建 provider → 交付立即跟着变。
    writeMatrix({});
    check("★ C3 禁用前 alpha 交付 Pi", (await piDelivered(projectDir)).some((s) => s.name === "alpha"));
    writeMatrix({ alpha: { pi: false } });
    const c3off = (await piDelivered(projectDir)).map((s) => s.name);
    check("★ C3 改矩阵禁 alpha → 重建后立即不交付(不缓存)", !c3off.includes("alpha"), c3off);
    writeMatrix({});
    check("★ C3 矩阵放行后重建 → alpha 立即恢复交付(重算)",
      (await piDelivered(projectDir)).some((s) => s.name === "alpha"));

    // C4 §MC-094 项目技能被矩阵按名禁 → 不交付 Pi(名字是引擎匹配身份,来源不分叉)。
    writeMatrix({ "proj-only": { pi: false } });
    const c4 = (await piDelivered(projectDir)).map((s) => s.name);
    check("★ C4 MC-094:矩阵禁 proj-only → 项目技能不交付 Pi", !c4.includes("proj-only"), c4);
    check("○ C4 同矩阵下其它放行技能仍在", c4.includes("alpha"), c4);

    // C5 损坏 + 无 last-good → Pi 交付**空**(fail-closed)。
    corruptNoBackup(JSON.stringify({ beta: 5 }));
    eqDeep("★ C5 损坏无备份 → Pi 交付集合空(fail-closed,不给截断集)",
      (await piDelivered(projectDir)).map((s) => s.name), []);

    // C6 损坏 + 有 last-good → 恢复后原禁用不复活。
    writeMatrix({ alpha: { pi: false } });
    writeFileSync(matrixFile, JSON.stringify({ alpha: 5 }), "utf-8");
    const c6 = (await piDelivered(projectDir)).map((s) => s.name);
    check("★ C6 损坏有备份 → Pi 恢复后 alpha 仍不交付(不复活)", !c6.includes("alpha"), c6);
  }

  /* ═════════════ §E MC-100/101:工具画像在**真实 startTurn** 里真的裁到了 SDK 入参 ═════════════ */
  // 台账两轮复核反复点名:「发现层/选择层纯函数通过了,但**没证明**各 SDK 在真实请求里照做」。
  // 这一段驱动真的 provider `startTurn`,断言**引擎真正收到的那份工具集**随画像变化 —— 桩捕获的
  // 就是 `query({options})` / `createAgentSession({tools})` / `thread/start({dynamicTools})` 的
  // 真实入参,不是纯函数返回值。
  console.log("\n§E MC-100/101:画像裁到 SDK 真实入参(Claude options.tools / Pi tools / Codex dynamicTools)");
  {
    // 夹具:把矩阵清干净(段 A–C 可能留了受限矩阵),让技能/工具两侧都不受 §A–C 影响。
    rmSync(matrixFile, { force: true });
    rmSync(lastGoodEnginesMapPath(matrixFile), { force: true });

    const fullProfile = { name: "full" as const };
    const minimalProfile = { name: "minimal" as const };
    const researchProfile = { name: "research" as const };

    // E1 Claude:`options.tools` 与 `options.mcpServers` 随画像收窄,floor 的 app server 恒留。
    {
      const full = await claudeDeliveredOptions(projectDir, fullProfile);
      const min = await claudeDeliveredOptions(projectDir, minimalProfile);
      const fullServers = (full["mcpServers"] as Record<string, unknown>) ?? {};
      const minServers = (min["mcpServers"] as Record<string, unknown>) ?? {};
      check("★ E1 Claude full → 不设 options.tools(保留 SDK 预设,全量)",
        full["tools"] === undefined, full["tools"]);
      check("★ E1 Claude minimal → 设了 options.tools(收窄到选中白名单)",
        Array.isArray(min["tools"]), min["tools"]);
      check("★ E1 Claude minimal → mcpServers 少于 full(真实裁掉 server)",
        Object.keys(minServers).length < Object.keys(fullServers).length,
        { min: Object.keys(minServers), full: Object.keys(fullServers) });
      check("★ E1 Claude minimal → app server 恒留(floor 发现通道 app_api_* 在它上面)",
        Object.keys(minServers).includes("mcode-app"), Object.keys(minServers));
      check("★ E1 Claude minimal → 内置白名单仍含计划模式/提问(harness 平面不被裁)",
        Array.isArray(min["tools"]) && (min["tools"] as string[]).includes("EnterPlanMode")
          && (min["tools"] as string[]).includes("AskUserQuestion"), min["tools"]);
    }

    // E2 Pi:`createAgentSession` 的 `tools` 白名单,full → undefined(引擎启用全部)。
    {
      const full = await piDeliveredTools(projectDir, fullProfile);
      const min = await piDeliveredTools(projectDir, minimalProfile);
      check("★ E2 Pi full → tools = undefined(引擎自己的『启用全部』语义)",
        full.tools === undefined, full.tools);
      check("★ E2 Pi minimal → tools 是数组白名单(真实收窄)",
        Array.isArray(min.tools), min.tools);
      check("★ E2 Pi minimal 白名单非空且只含发现通道 floor",
        Array.isArray(min.tools) && (min.tools as string[]).length > 0
          && (min.tools as string[]).includes("app_api_call"), min.tools);
    }

    // E3 Codex:`thread/start` 的 `dynamicTools` 名字集合随画像收窄。
    {
      const full = await codexDeliveredToolNames(projectDir, fullProfile);
      const min = await codexDeliveredToolNames(projectDir, minimalProfile);
      check("★ E3 Codex full → dynamicTools 非空(全量动态工具)",
        Array.isArray(full) && full.length > 0, full);
      check("★ E3 Codex minimal → dynamicTools 少于 full(真实过滤)",
        Array.isArray(min) && Array.isArray(full) && min.length < full.length,
        { min: min?.length, full: full?.length });
    }

    // E4 同一批工具,换**不同**画像 → 引擎收到的集合真的不同(research ≠ minimal,不是两条都一样)。
    {
      const min = await claudeDeliveredOptions(projectDir, minimalProfile);
      const res = await claudeDeliveredOptions(projectDir, researchProfile);
      const minServers = Object.keys((min["mcpServers"] as Record<string, unknown>) ?? {});
      const resServers = Object.keys((res["mcpServers"] as Record<string, unknown>) ?? {});
      check("★ E4 Claude research vs minimal → 交付 server 集合不同(画像真承载信息)",
        minServers.sort().join(",") !== resServers.sort().join(","),
        { min: minServers.sort(), research: resServers.sort() });
      check("★ E4 Claude research → 资料库 server 保留(mcode-library 属 research 桶)",
        resServers.includes("mcode-library"), resServers);
    }

    // E5 预算(toolBudget)在画像之后再收一刀:极小 maxTools → Pi 白名单被截到 floor 附近。
    {
      const full = await piDeliveredTools(projectDir, fullProfile, { maxTools: 3 });
      check("★ E5 Pi full+maxTools=3 → 预算把白名单截到 ≤3 且与 full(undefined)不同",
        Array.isArray(full.tools) && (full.tools as string[]).length <= 3, full.tools);
    }

    // E6 full 画像 + 预算 → Claude 也必须真收窄(不能因画像=full 就走「全量 server」短路把预算丢掉)。
    {
      const fullNoBudget = await claudeDeliveredOptions(projectDir, fullProfile);
      const fullBudget = await claudeDeliveredOptions(projectDir, fullProfile, { maxTools: 3 });
      const noBudgetServers = Object.keys((fullNoBudget["mcpServers"] as Record<string, unknown>) ?? {});
      check("★ E6 Claude full(无预算)→ 不设 options.tools(全量)",
        fullNoBudget["tools"] === undefined, fullNoBudget["tools"]);
      check("★ E6 Claude full+maxTools=3 → tools 被设(预算对 full 也生效,不短路)",
        Array.isArray(fullBudget["tools"]), fullBudget["tools"]);
      check("★ E6 Claude full+maxTools=3 → 收窄后的 server 少于无预算时",
        Object.keys((fullBudget["mcpServers"] as Record<string, unknown>) ?? {}).length < noBudgetServers.length,
        { budgeted: Object.keys((fullBudget["mcpServers"] as Record<string, unknown>) ?? {}), none: noBudgetServers });
    }

    // E7 full 画像 + 预算 → Codex dynamicTools 同样真收窄。
    {
      const fullNoBudget = await codexDeliveredToolNames(projectDir, fullProfile);
      const fullBudget = await codexDeliveredToolNames(projectDir, fullProfile, { maxTools: 3 });
      check("★ E7 Codex full(无预算)→ dynamicTools 全量",
        Array.isArray(fullNoBudget) && fullNoBudget.length > 0, fullNoBudget);
      check("★ E7 Codex full+maxTools=3 → dynamicTools 被预算收窄(少于无预算)",
        Array.isArray(fullBudget) && Array.isArray(fullNoBudget) && fullBudget.length < fullNoBudget.length,
        { budgeted: fullBudget, none: fullNoBudget });
    }
  }

  /* ═════════════ §D 诚实标注(不冒充已做) ═════════════ */
  console.log("\n§D 边界(仍需活模型验收,不在本套件)");
  check("○ 本套件只证「宿主交给 SDK 的入参」正确;真三二进制读到根后如何扫描/命名/同名谁赢 = U1 活会话验收", true);
  check("○ MC-100/101 本段证的是「画像/预算真到达 SDK 入参」;真二进制内部是否照此只暴露这些工具(builtin 权威枚举、SKILL 名解析)仍须 U1 活会话验收", true);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nskill-delivery-smoke:${checks - failures}/${checks} 通过`);
if (failures > 0) process.exit(1);
