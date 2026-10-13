/**
 * Headless smoke test for the plugin subsystem (docs/plugin-feasibility.md v1).
 *
 * Covers: manifest discovery across the three layouts, component summaries
 * (skills/commands/agents/hooks/MCP), install from local dir / zip / git /
 * marketplace, enable+delivery queries (skill roots, namespaced MCP entries,
 * per-server denylist), path-escape guards, uninstall cleanup, and
 * marketplace add/list/refresh/remove.
 *
 * Run via run.sh: esbuild-bundled with SettingRepo stubbed (stub-repositories)
 * and HOME redirected to a scratch dir, so ~/.mcode/plugins is faked.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { SettingRepo } from "./stub-repositories.js";

import {
  findPluginManifest,
  pluginSkillsDirs,
  summarizeComponents,
} from "../../src/main/plugins/pluginManifest.js";
import {
  installFromLocal,
  installFromGit,
  installFromMarketplace,
  setPluginEnabled,
  setPluginEngines,
  removePlugin,
  listPlugins,
  getEnabledPlugins,
  getEnabledPluginSkillRoots,
  getPluginMcpServers,
  setPluginMcpDisabled,
  listPluginMcpPanelEntries,
  assertSafeArchiveEntryNames,
  addMarketplace,
  listMarketplaces,
  refreshMarketplace,
  removeMarketplace,
  componentDeliveryReport,
  compatibleProviderIdsForPlugin,
} from "../../src/main/plugins/pluginManager.js";
import { sceneComponentReadiness, COMPONENT_PROVIDER_DELIVERY, PluginManifestSchema, type PluginManifest, type ComponentDeliveryReport, type PluginComponents } from "@contracts/ipc";

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string, extra = ""): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}${extra ? ` — ${extra}` : ""}`);
  }
}
function eq<T>(actual: T, expected: T, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(a === e, label, a === e ? "" : `got ${a}, want ${e}`);
}
function throws(label: string, fn: () => void): void {
  try {
    fn();
    ok(false, label, "expected rejection");
  } catch {
    ok(true, label);
  }
}

throws("archive rejects parent traversal", () => assertSafeArchiveEntryNames(["../outside.txt"]));
throws("archive rejects nested traversal", () => assertSafeArchiveEntryNames(["plugin/a/../../outside.txt"]));
throws("archive rejects POSIX absolute path", () => assertSafeArchiveEntryNames(["/tmp/outside.txt"]));
throws("archive rejects Windows absolute path", () => assertSafeArchiveEntryNames(["C:\\outside.txt"]));
assertSafeArchiveEntryNames(["plugin/.claude-plugin/plugin.json", "plugin/skills/demo/SKILL.md"]);
ok(true, "archive accepts contained member names");

/* ── fixtures ── */

const base = path.join(tmpdir(), `mcode-plugins-smoke-${Date.now()}`);
const fixtureDir = path.join(base, "fixtures");
mkdirSync(path.join(fixtureDir, "demo-plugin", ".claude-plugin"), { recursive: true });
mkdirSync(path.join(fixtureDir, "demo-plugin", "skills", "pdf-helper"), { recursive: true });
mkdirSync(path.join(fixtureDir, "demo-plugin", "skills", "web-tester"), { recursive: true });
mkdirSync(path.join(fixtureDir, "demo-plugin", "commands"), { recursive: true });
mkdirSync(path.join(fixtureDir, "demo-plugin", "agents"), { recursive: true });
mkdirSync(path.join(fixtureDir, "demo-plugin", "hooks"), { recursive: true });

writeFileSync(
  path.join(fixtureDir, "demo-plugin", ".claude-plugin", "plugin.json"),
  JSON.stringify(
    {
      name: "demo-plugin",
      version: "1.2.3",
      description: "Smoke demo plugin",
      author: { name: "smoke" },
    },
    null,
    2,
  ),
);
writeFileSync(
  path.join(fixtureDir, "demo-plugin", "skills", "pdf-helper", "SKILL.md"),
  `---
name: pdf-helper
description: Generate PDF documents
---
# pdf-helper`,
);
writeFileSync(
  path.join(fixtureDir, "demo-plugin", "skills", "web-tester", "SKILL.md"),
  `---
name: web-tester
description: GUI web testing
---
body`,
);
writeFileSync(
  path.join(fixtureDir, "demo-plugin", "commands", "deploy-check.md"),
  `---
description: Pre-deploy verification
---
Run these checks`,
);
writeFileSync(
  path.join(fixtureDir, "demo-plugin", "agents", "code-reviewer.md"),
  `---
description: Reviews code changes
---
You are a reviewer`,
);
writeFileSync(
  path.join(fixtureDir, "demo-plugin", "hooks", "hooks.json"),
  JSON.stringify(
    {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "echo pre" }] },
      ],
      PostToolUse: [{ hooks: [{ type: "command", command: "npm run lint" }] }],
      // 【MC-061】语义在统一 HookEvent 里**没有对应**的事件(映射表显式给 null)——
      // 必须标 `unmappable`,与"能映射但 v1 不执行(unsupported)"区分开。
      SessionStart: [{ hooks: [{ type: "command", command: "echo started" }] }],
    },
    null,
    2,
  ),
);
writeFileSync(
  path.join(fixtureDir, "demo-plugin", ".mcp.json"),
  JSON.stringify({ mcpServers: { fetcher: { command: "node", args: ["server.js"] } } }, null, 2),
);

/* marketplace fixture with a relative-path entry + a github entry. Relative
 * sources resolve INSIDE the marketplace tree, so the plugin dir is copied in. */
const mpDir = path.join(fixtureDir, "marketplace");
mkdirSync(path.join(mpDir, ".claude-plugin"), { recursive: true });
execSync(`cp -R "${path.join(fixtureDir, "demo-plugin")}" "${mpDir}/"`);
writeFileSync(
  path.join(mpDir, ".claude-plugin", "marketplace.json"),
  JSON.stringify(
    {
      name: "test-mp",
      owner: "smoke",
      plugins: [
        { name: "demo-plugin", description: "Demo entry", version: "1.2.3", source: "./demo-plugin" },
        { name: "gh-plugin", description: "GitHub entry", source: { source: "github", repo: "octocat/hello" } },
      ],
    },
    null,
    2,
  ),
);

/* git-source fixture: a local repo cloned via file:// */
const gitRepo = path.join(base, "git-repo");
mkdirSync(path.join(gitRepo, ".claude-plugin"), { recursive: true });
writeFileSync(
  path.join(gitRepo, ".claude-plugin", "plugin.json"),
  JSON.stringify({ name: "git-plugin", version: "0.1.0", description: "from git" }),
);
execSync("git init -q . && git add -A && git -c user.email=s@smoke -c user.name=smoke commit -qm init", {
  cwd: gitRepo,
});

/* git-subdir fixture: a repo whose plugin lives in a subdirectory — the
 * official marketplace's dominant shape ({source:"git-subdir", url, path}) */
const subdirRepo = path.join(base, "subdir-repo");
mkdirSync(path.join(subdirRepo, "plugins", "inner", ".claude-plugin"), { recursive: true });
writeFileSync(
  path.join(subdirRepo, "plugins", "inner", ".claude-plugin", "plugin.json"),
  JSON.stringify({ name: "subdir-plugin", version: "2.2.0", description: "from git-subdir" }),
);
execSync("git init -q . && git add -A && git -c user.email=s@smoke -c user.name=smoke commit -qm init", {
  cwd: subdirRepo,
});

/* official-style marketplace: git-subdir + url + one UNKNOWN source shape —
 * the unknown entry must be skipped without blanking the catalog */
const officialMpDir = path.join(fixtureDir, "official-mp");
mkdirSync(path.join(officialMpDir, ".claude-plugin"), { recursive: true });
writeFileSync(
  path.join(officialMpDir, ".claude-plugin", "marketplace.json"),
  JSON.stringify({
    name: "official-style",
    owner: { name: "smoke" },
    renames: { old: "new-name" },
    plugins: [
      {
        name: "subdir-plugin",
        description: "git-subdir entry",
        category: "dev",
        source: {
          source: "git-subdir",
          url: `file://${subdirRepo}`,
          path: "plugins/inner",
          ref: undefined,
          sha: "deadbeef",
        },
      },
      {
        name: "remote-plugin",
        description: "url entry (not installed in smoke)",
        source: { source: "url", url: "https://example.com/x.zip" },
      },
      {
        name: "future-shape",
        description: "unknown source shape",
        source: { source: "npm", package: "some-plugin" },
      },
    ],
  }),
);

/* zcode-layout plugin (manifest at .zcode-plugin) */
mkdirSync(path.join(fixtureDir, "zcode-plugin", ".zcode-plugin"), { recursive: true });
writeFileSync(
  path.join(fixtureDir, "zcode-plugin", ".zcode-plugin", "plugin.json"),
  JSON.stringify({ name: "zcode-plugin", version: "2.0.0" }),
);

/* escaping-manifest plugin (component path must be rejected) */
mkdirSync(path.join(fixtureDir, "escape-plugin", ".claude-plugin"), { recursive: true });
mkdirSync(path.join(fixtureDir, "escape-plugin", "skills-local", "local-skill"), { recursive: true });
writeFileSync(
  path.join(fixtureDir, "escape-plugin", "skills-local", "local-skill", "SKILL.md"),
  `---
name: local-skill
description: In-root skill
---
body`,
);
writeFileSync(
  path.join(fixtureDir, "escape-plugin", ".claude-plugin", "plugin.json"),
  JSON.stringify({ name: "escape-plugin", skills: "../../fixtures/demo-plugin/skills" }),
);

/* array-form manifest plugin (Claude's string[] component paths — real
 * official-marketplace manifests use both forms) */
mkdirSync(path.join(fixtureDir, "array-plugin", ".claude-plugin"), { recursive: true });
mkdirSync(path.join(fixtureDir, "array-plugin", "skills-a", "alpha"), { recursive: true });
mkdirSync(path.join(fixtureDir, "array-plugin", "skills-b", "beta"), { recursive: true });
writeFileSync(
  path.join(fixtureDir, "array-plugin", "skills-a", "alpha", "SKILL.md"),
  `---
name: alpha
description: From skills-a
---
body`,
);
writeFileSync(
  path.join(fixtureDir, "array-plugin", "skills-b", "beta", "SKILL.md"),
  `---
name: beta
description: From skills-b
---
body`,
);
writeFileSync(
  path.join(fixtureDir, "array-plugin", ".claude-plugin", "plugin.json"),
  JSON.stringify({ name: "array-plugin", skills: ["./skills-a", "./skills-b"] }),
);

/* invalid-name plugin (zod must reject) */
mkdirSync(path.join(fixtureDir, "badname-plugin", ".claude-plugin"), { recursive: true });
writeFileSync(
  path.join(fixtureDir, "badname-plugin", ".claude-plugin", "plugin.json"),
  JSON.stringify({ name: "../evil" }),
);

/* monorepo layout: README + LICENSE (flat files) + one plugin dir — the
 * official-repo shape where the plugin lives in a child directory */
mkdirSync(path.join(fixtureDir, "mono-repo", "plugin", ".claude-plugin"), { recursive: true });
writeFileSync(path.join(fixtureDir, "mono-repo", "README.md"), "# mono-repo\n");
writeFileSync(path.join(fixtureDir, "mono-repo", "LICENSE"), "MIT");
writeFileSync(
  path.join(fixtureDir, "mono-repo", "plugin", ".claude-plugin", "plugin.json"),
  JSON.stringify({ name: "mono-plugin", version: "1.0.0", description: "from monorepo" }),
);

/* multi-plugin repo (two plugin children) — must name candidates, not install */
for (const sub of ["a", "b"]) {
  mkdirSync(path.join(fixtureDir, "multi-repo", sub, ".claude-plugin"), { recursive: true });
  writeFileSync(
    path.join(fixtureDir, "multi-repo", sub, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: `multi-${sub}`, version: "1.0.0" }),
  );
}

/* nested wrapper chain: wrap2/wrap/plugin/ (double archive nesting) */
mkdirSync(path.join(fixtureDir, "wrap2", "wrap", "plugin", ".claude-plugin"), { recursive: true });
writeFileSync(
  path.join(fixtureDir, "wrap2", "wrap", "plugin", ".claude-plugin", "plugin.json"),
  JSON.stringify({ name: "nested-plugin", version: "0.0.1" }),
);

/* zip of demo-plugin (wrapped in a top-level dir, GitHub-style) */
const zipPath = path.join(base, "demo-plugin.zip");
try {
  execSync(`zip -qr "${zipPath}" demo-plugin`, { cwd: fixtureDir });
} catch {
  // Windows dev boxes often lack the zip CLI; PowerShell's Compress-Archive
  // writes the same standard archive (the installer's bsdtar reads both).
  execSync(
    `powershell -NoProfile -Command "Compress-Archive -Path 'demo-plugin' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force"`,
    { cwd: fixtureDir },
  );
}

/* ── 1. manifest discovery + component summary ── */
console.log("\n[1] manifest discovery & component summary");
const demoRoot = path.join(fixtureDir, "demo-plugin");
const resolved = findPluginManifest(demoRoot);
ok(resolved != null, "finds .claude-plugin manifest");
eq(resolved?.manifestDir, ".claude-plugin", "manifestDir is .claude-plugin");
eq(resolved?.manifest.name, "demo-plugin", "manifest name");

const comps = summarizeComponents(demoRoot, resolved!.manifest);
eq(
  comps.skills.map((s) => s.name),
  ["pdf-helper", "web-tester"],
  "skills parsed (2)",
);
ok(
  comps.skills[0].description === "Generate PDF documents",
  "skill description from frontmatter",
);
eq(comps.commands.length, 1, "commands parsed (1)");
eq(comps.commands[0].name, "deploy-check", "command name = file basename");
eq(comps.agents.length, 1, "agents parsed (1)");
eq(comps.hooks.length, 3, "hooks parsed (3)");
ok(comps.hooks[0].matcher === "Bash" && comps.hooks[0].command === "echo pre", "hook matcher+command");
// 【MC-061】每个 hook 都带**显式执行状态**:v1 不执行(unsupported);事件名映射不到 Mcode
// 统一 HookEvent 的标 unmappable —— 明说不支持,而不是让面板看着像活的、实际静默不跑。
ok(
  comps.hooks.filter((h) => h.event === "PreToolUse" || h.event === "PostToolUse").every((h) => h.execution === "unsupported"),
  "PreToolUse/PostToolUse 可映射 → execution=unsupported",
);
// ★ 映射不到的事件(SessionStart)必须**单独标 unmappable** —— 撤掉这个标注,面板就会把它
// 与"能映射但不执行"混成一句,用户看不出这条 hook 的事件名根本不受支持。
eq(
  comps.hooks.find((h) => h.event === "SessionStart")?.execution,
  "unmappable",
  "★ SessionStart(映射不到)→ execution=unmappable(与 unsupported 区分)",
);
{
  const { mapClaudeHookEvent } = await import("@contracts/hook");
  ok(mapClaudeHookEvent("PreToolUse") === "tool.use", "PreToolUse → tool.use");
  ok(mapClaudeHookEvent("SessionStart") === null, "SessionStart 明确不映射(null)");
  ok(mapClaudeHookEvent("TotallyUnknown") === null, "未知事件名 → null(报不可用,不静默)");
}
eq(comps.mcpServers.length, 1, "mcp servers parsed (1)");
eq(comps.mcpServers[0].name, "fetcher", "mcp server name");
eq(comps.mcpServers[0].kind, "stdio", "mcp server kind stdio");
eq(comps.mcpServers[0].detail, "node server.js", "mcp detail is command line");

const zRes = findPluginManifest(path.join(fixtureDir, "zcode-plugin"));
ok(zRes != null && zRes.manifest.name === "zcode-plugin", ".zcode-plugin layout discovered");

const escSkills = pluginSkillsDirs(path.join(fixtureDir, "escape-plugin"), {
  name: "escape-plugin",
  skills: "../../fixtures/demo-plugin/skills",
} as never);
eq(escSkills, [], "escaping skills path rejected (in-root guard)");

const arrRes = findPluginManifest(path.join(fixtureDir, "array-plugin"));
ok(arrRes != null, "array-form skills manifest parses");
const arrComps = summarizeComponents(path.join(fixtureDir, "array-plugin"), arrRes!.manifest);
eq(
  arrComps.skills.map((s) => s.name),
  ["alpha", "beta"],
  "array-form skills merged from both roots",
);
eq(
  pluginSkillsDirs(path.join(fixtureDir, "escape-plugin"), {
    name: "escape-plugin",
    skills: ["../../fixtures/demo-plugin/skills", "./skills-local"],
  } as never),
  [path.join(fixtureDir, "escape-plugin", "skills-local")],
  "array-form: escaping entries dropped, in-root kept",
);

/* ── 2. install from local dir ── */
console.log("\n[2] install from local directory");
const localInstall = await installFromLocal(demoRoot);
ok(localInstall.ok, "install succeeds");
ok(!!localInstall.plugin, "returns plugin state");
eq(localInstall.plugin?.name, "demo-plugin", "plugin name");
eq(localInstall.plugin?.version, "1.2.3", "plugin version");
ok(!localInstall.plugin?.enabled, "installs DISABLED");
eq(localInstall.plugin?.source.kind, "local-dir", "source kind recorded");
ok(
  existsSync(path.join(localInstall.plugin!.rootDir, ".mcode-install.json")),
  "install record written",
);

/* ── 3. enable + delivery queries ── */
console.log("\n[3] enable + provider delivery queries");
eq(setPluginEnabled("demo-plugin", true).ok, true, "setEnabled ok");
// 内置插件(`mcode-document-skills`,随应用发布的那四个文档技能)**2026-09-20 删掉了**
// —— 用户不要内置技能了,以后一律从 GitHub 自己导。所以投递链里现在**只有用户装的**,
// 数长度不用再摘谁。
//
// ⚠️ 这几条断言曾经需要 `.filter((p) => !p.builtin)` 才数得对。删内置之后那个过滤是
// 恒等的(没有 `builtin: true` 的行了)—— 但**留着它是有意的**:将来若再加内置插件
// (期刊分区、文献检索那种),这里立刻又会需要它,而"忘了加"的表现是每次运行都报
// 一个跟被测无关的失败。下面"内置插件不再出现在投递链里"那一条是这条的反面守卫。
const enabled = await getEnabledPlugins();
eq(enabled.length, 1, "one enabled plugin");
eq(enabled[0].name, "demo-plugin", "enabled name");
ok(enabled[0].hasHooks, "hasHooks true (hooks declared)");
// ★ 内置插件删掉之后,**投递链里不该再有任何 `builtin: true` 的行**。
// 这一条钉的是"删干净了" —— 资源目录、`builtinPlugins.ts`、注入点三处少一处,
// 内置项就会重新冒出来。
ok(!enabled.some((p) => p.builtin === true), "投递链里没有内置项了");
// 技能根也只剩用户插件带来的那些(内置那份的根路径已随资源目录删掉)。
const skillRoots = await getEnabledPluginSkillRoots();
eq(skillRoots.filter((r) => r.includes("demo-plugin")).length, 1, "one plugin skill root");
ok(
  skillRoots.some((r) => r.endsWith(path.join("demo-plugin", "1.2.3", "skills"))),
  "skill root path",
);
ok(!skillRoots.some((r) => r.includes("builtin-skills")), "没有内置技能根了");
// 工作流节点可逐轮收窄插件；没有逐轮名单时默认使用全部全局启用的插件。
const scopedSkillRoots = await getEnabledPluginSkillRoots(["demo-plugin"]);
eq(JSON.stringify(scopedSkillRoots), JSON.stringify(skillRoots), "逐轮插件过滤命中时只投递指定插件技能根");
eq(JSON.stringify(await getEnabledPluginSkillRoots(["missing-plugin"])), "[]", "逐轮插件过滤未命中时不泄漏其它全局插件技能");
eq(
  JSON.stringify(await getEnabledPluginSkillRoots(["demo-plugin"], "claude-sdk")),
  JSON.stringify(skillRoots),
  "兼容 provider 可以拿到插件技能根",
);
eq(
  JSON.stringify(await getEnabledPluginSkillRoots(["demo-plugin"], "unsupported-provider")),
  "[]",
  "不兼容 provider 在最终投递层也拿不到插件技能根",
);

const mcp = await getPluginMcpServers();
eq(mcp.length, 1, "one namespaced MCP entry");
eq(mcp[0][0], "demo-plugin__fetcher", "MCP name namespaced plugin__server");
eq(mcp[0][1].command, "node", "MCP config carried through");
eq((await getPluginMcpServers(undefined, "claude-sdk")).length, 1, "兼容 provider 可以拿到插件 MCP");
eq((await getPluginMcpServers(undefined, "unsupported-provider")).length, 0, "不兼容 provider 拿不到插件 MCP");

const panel = await listPluginMcpPanelEntries();
eq(panel.length, 1, "one panel entry");
ok(panel[0].enabled, "panel entry enabled by default");

eq(setPluginMcpDisabled("demo-plugin__fetcher", true).ok, true, "denylist write ok");
eq((await getPluginMcpServers()).length, 0, "denied server excluded from delivery");
eq((await listPluginMcpPanelEntries())[0].enabled, false, "panel reflects disabled");
eq(setPluginMcpDisabled("demo-plugin__fetcher", false).ok, true, "denylist clear ok");
eq((await getPluginMcpServers()).length, 1, "re-enabled server delivered again");

/* ── 4. list state ── */
console.log("\n[4] listPlugins");
const listed = listPlugins();
eq(listed.length, 1, "one installed plugin listed");
eq(listed[0].enabled, true, "enabled flag persisted");
eq(listed[0].components.hooks.length, 3, "components in list");

/* ── 4a. 【ARC-014】列表回读带**逐引擎组件就绪(ALL 语义)** ──
 * 现存面板只拿得到 compatibleProviderIds(ANY:至少一个组件能投递)。这一片让 plugins.list
 * 的每一行真的能回答「这个引擎收不收得到该插件的**全部**声明组件」—— 把场景就绪判据接进
 * 一条真实回读路径,而不是只活在纯函数里。demo-plugin 声明 skills(2)+command(1)+
 * agent(1)+hooks(3)+mcp(1):只有 Claude 全收;Pi 只收 skill(收不到 command/agent/hook/mcp);
 * Codex 收得到 skill/mcp,但收不到 command/agent/hook。 */
{
  const row = listed[0];
  const readiness = row.componentReadiness!;
  ok(readiness !== undefined, "插件行带 componentReadiness(老宿主可缺,本宿主必须给)");
  // Claude:全部组件都交付 → ready(ALL 满足)。
  ok(readiness["claude-sdk"].ready === true, "ARC-014:demo-plugin 对 Claude 全部组件就绪(ready)");
  eq(readiness["claude-sdk"].gaps, [], "ARC-014:Claude 无缺口");
  // Pi:只有 2 个 skill 交付;command/agent/hook/mcp 是缺口,所以 ALL 不成立。
  ok(readiness["pi-sdk"].ready === false, "ARC-014:demo-plugin 对 Pi 不是全就绪(ANY≠ALL 的承重反例)");
  eq(
    readiness["pi-sdk"].satisfied,
    ["skill:0", "skill:1"],
    "ARC-014:Pi 只就绪两个 skill",
  );
  eq(
    readiness["pi-sdk"].gaps.map((g) => g.componentId).sort(),
    ["agent:0", "command:0", "hook:0", "hook:1", "hook:2", "mcp:0"],
    "ARC-014:Pi 的缺口精确列出收不到的每一类组件",
  );
  ok(
    readiness["pi-sdk"].gaps.every((g) => g.status === "INCOMPATIBLE"),
    "ARC-014:Pi 缺口状态都是 INCOMPATIBLE(引擎不支持,不是缺装)",
  );
  ok(readiness["pi-sdk"].providerId === "pi-sdk", "ARC-014:就绪结果带出被检查的引擎");
  // Codex:收得到 skill + mcp,收不到 command/agent/hook。
  ok(readiness["codex-sdk"].ready === false, "ARC-014:demo-plugin 对 Codex 不是全就绪");
  eq(
    readiness["codex-sdk"].satisfied,
    ["skill:0", "skill:1", "mcp:0"],
    "ARC-014:Codex 就绪 skill+mcp",
  );
  eq(
    readiness["codex-sdk"].gaps.map((g) => g.componentId).sort(),
    ["agent:0", "command:0", "hook:0", "hook:1", "hook:2"],
    "ARC-014:Codex 缺口是 Claude 专用的 command/agent/hook",
  );
  // 与兼容列表(ANY)形成对照:三家都在 compatibleProviderIds 里,但只有 Claude「全就绪」。
  eq(
    row.compatibleProviderIds,
    ["claude-sdk", "codex-sdk", "pi-sdk"],
    "ARC-014:兼容列表仍是 ANY(三家都在),与逐引擎 ALL 就绪是两件事",
  );
}

/* ── 4b. per-engine switches (plugins.engines, the skill-matrix twin) ── */
console.log("\n[4b] per-engine switches");
eq(listed[0].engines, { claude: true, codex: true, pi: true }, "engines default to all on");
eq(
  listed[0].deliveredProviderIds,
  ["claude-sdk", "codex-sdk", "pi-sdk"],
  "delivered = compatible while every engine is on",
);
eq(setPluginEngines("demo-plugin", { codex: false }).ok, true, "enginesSet ok");
const narrowed = listPlugins()[0];
eq(narrowed.engines, { claude: true, codex: false, pi: true }, "codex switched off, others untouched");
ok(narrowed.compatibleProviderIds?.includes("codex-sdk") === true, "capability list unchanged by the switch");
eq(narrowed.deliveredProviderIds, ["claude-sdk", "pi-sdk"], "delivered list narrowed");
eq((await getEnabledPluginSkillRoots(undefined, "codex-sdk")).length, 0, "codex no longer gets the skill root");
eq((await getPluginMcpServers(undefined, "codex-sdk")).length, 0, "codex no longer gets the plugin MCP");
eq((await getEnabledPluginSkillRoots(undefined, "pi-sdk")).length, 1, "pi still gets the skill root");
eq((await getPluginMcpServers(undefined, "claude-sdk")).length, 1, "claude still gets the plugin MCP");
eq(
  (await getEnabledPlugins())[0].compatibleProviderIds,
  ["claude-sdk", "pi-sdk"],
  "EnabledPlugin carries the narrowed list (Claude provider filters on it)",
);
eq(setPluginEngines("demo-plugin", { codex: true }).ok, true, "codex back on");
eq(SettingRepo.__dump()["plugins.engines"], "{}", "an all-on plugin leaves no stored entry (sparse)");
eq(setPluginEngines("never-installed", { pi: false }).ok, false, "switching a plugin that is not installed is refused");
eq(setPluginEngines("demo-plugin", { pi: false }).ok, true, "pi off (checked again at uninstall)");

/* ── 5. zip install (wrapper dir descent + same-version reinstall) ── */
console.log("\n[5] install from zip");
const zipInstall = await installFromLocal(zipPath);
ok(zipInstall.ok, "zip install succeeds", zipInstall.error ?? "");
eq(listPlugins().length, 1, "same-version reinstall replaced (still 1)");
ok((await getEnabledPlugins()).length === 1, "still enabled after reinstall");

/* ── 6. git install ── */
console.log("\n[6] install from git (file://)");
const gitInstall = await installFromGit(`file://${gitRepo}`);
ok(gitInstall.ok, "git install succeeds", gitInstall.error ?? "");
eq(gitInstall.plugin?.name, "git-plugin", "git plugin name");
ok(!existsSync(path.join(gitInstall.plugin!.rootDir, ".git")), ".git stripped from install");

/* ── 7. invalid manifests rejected ── */
console.log("\n[7] invalid plugins rejected");
const badName = await installFromLocal(path.join(fixtureDir, "badname-plugin"));
ok(!badName.ok, "illegal name rejected");
const noManifest = await installFromLocal(path.join(base, "not-a-plugin"));
ok(!noManifest.ok, "missing manifest rejected");
const escapeInstall = await installFromLocal(path.join(fixtureDir, "escape-plugin"));
ok(escapeInstall.ok, "escaping plugin still installs (components guarded)");
eq(escapeInstall.plugin?.components.skills.length, 0, "escaped skills NOT summarized");

/* ── 7b. real-world repository layouts ── */
console.log("\n[7b] repository layout tolerance");
const monoInstall = await installFromLocal(path.join(fixtureDir, "mono-repo"));
ok(monoInstall.ok, "monorepo (README+LICENSE+plugin/) installs inner plugin", monoInstall.error ?? "");
eq(monoInstall.plugin?.name, "mono-plugin", "monorepo plugin name");

const nestedInstall = await installFromLocal(path.join(fixtureDir, "wrap2"));
ok(nestedInstall.ok, "double-nested wrapper installs inner plugin", nestedInstall.error ?? "");
eq(nestedInstall.plugin?.name, "nested-plugin", "nested plugin name");

const multiInstall = await installFromLocal(path.join(fixtureDir, "multi-repo"));
ok(!multiInstall.ok, "multi-plugin repo rejected");
ok(
  (multiInstall.error ?? "").includes("多个插件") &&
    (multiInstall.error ?? "").includes("multi-a") &&
    (multiInstall.error ?? "").includes("multi-b"),
  "multi-plugin error lists candidate names",
  multiInstall.error ?? "",
);

const mpAsPlugin = await installFromLocal(mpDir);
ok(!mpAsPlugin.ok, "marketplace repo rejected as plugin");
ok(
  (mpAsPlugin.error ?? "").includes("插件市场"),
  "marketplace repo error redirects to marketplace flow",
  mpAsPlugin.error ?? "",
);

/* ── 8. marketplace lifecycle ── */
console.log("\n[8] marketplace lifecycle");
const mpAdd = await addMarketplace({ kind: "local", ref: mpDir });
ok(mpAdd.ok, "addMarketplace(local) ok", mpAdd.error ?? "");
const mps = listMarketplaces();
eq(mps.length, 4, "user marketplace + the 3 shipped catalogs are listed");
eq(mps[0].ecosystem, "claude", "Claude-layout catalog badged claude");
eq(
  mps.slice(1).map((m) => m.ecosystem),
  ["zcode", "claude", "codex"],
  "built-in ecosystems known before the first fetch",
);
eq(mps[0].name, "test-mp", "marketplace name from manifest");
eq(mps[0].builtin, false, "user marketplace is not built-in");
eq(mps[0].cloned, true, "user marketplace tree is on disk");
// Built-ins are seeded by the list call: user records keep their order, the
// shipped catalogs append, and both are listed BEFORE their first fetch.
eq(
  mps.slice(1).map((m) => m.name),
  ["zcode-plugins-official", "claude-plugins-official", "codex-plugins-official"],
  "shipped catalogs appended in declaration order",
);
eq(
  mps.slice(1).every((m) => m.builtin && !m.cloned && m.plugins.length === 0),
  true,
  "built-ins marked builtin, listed unfetched with an empty catalog",
);
// Shipped catalogs are product surface, not user state: not removable, and
// adding the same repo by hand is refused instead of duplicating the catalog.
const builtinRemove = removeMarketplace("claude-plugins-official");
ok(!builtinRemove.ok, "built-in marketplace cannot be removed", builtinRemove.error ?? "");
const builtinDupAdd = await addMarketplace({
  kind: "git",
  ref: "https://github.com/anthropics/claude-plugins-official.git",
});
ok(
  !builtinDupAdd.ok,
  "same repo cannot be added twice (.git suffix normalized)",
  builtinDupAdd.error ?? "",
);
eq(listMarketplaces().length, 4, "refused mutations changed nothing");
eq(mps[0].plugins.length, 2, "two catalog entries");
eq(mps[0].plugins[0].installed, true, "demo-plugin entry marked installed");
eq(mps[0].plugins[1].installed, false, "gh-plugin entry not installed");

const mpInstall = await installFromMarketplace("test-mp", "demo-plugin");
ok(mpInstall.ok, "install marketplace entry ok", mpInstall.error ?? "");
eq(mpInstall.plugin?.source.kind, "marketplace", "source kind marketplace");

// github entry resolves to the right git URL (resolved lazily on install).
const ghResolveFail = await installFromMarketplace("test-mp", "gh-plugin");
ok(!ghResolveFail.ok, "github entry install fails (repo unreachable) but source resolved");

const mpRefresh = await refreshMarketplace("test-mp");
ok(mpRefresh.ok, "refresh ok", mpRefresh.error ?? "");

/* official-style marketplace: entry-level tolerance + git-subdir install */
console.log("\n[8b] official-style marketplace (git-subdir / url / unknown shapes)");
const officialAdd = await addMarketplace({ kind: "local", ref: officialMpDir });
ok(officialAdd.ok, "official-style marketplace added", officialAdd.error ?? "");
const allMps = listMarketplaces();
const official = allMps.find((m) => m.name === "official-style");
ok(!!official, "official-style listed");
eq(official?.plugins.length, 2, "unknown source shape skipped, 2 of 3 entries survive");
eq(
  official?.plugins.map((p) => p.name).sort(),
  ["remote-plugin", "subdir-plugin"],
  "git-subdir + url entries listed",
);

const subdirInstall = await installFromMarketplace("official-style", "subdir-plugin");
ok(subdirInstall.ok, "git-subdir entry installs", subdirInstall.error ?? "");
eq(subdirInstall.plugin?.name, "subdir-plugin", "git-subdir plugin name");
eq(subdirInstall.plugin?.version, "2.2.0", "git-subdir plugin version");
ok(subdirInstall.plugin?.source.kind === "marketplace", "git-subdir source kind recorded");
ok(
  !existsSync(path.join(subdirInstall.plugin!.rootDir, ".git")),
  "git-subdir install has no .git",
);
// Only the subdirectory ships — sibling repo content must not leak in.
ok(
  !existsSync(path.join(subdirInstall.plugin!.rootDir, "plugins")),
  "git-subdir installs ONLY the subdirectory",
);

removeMarketplace("official-style");
removePlugin("subdir-plugin");

/* ── 8c. remote-zip marketplace entry (the {source:"url"} path) ── */
console.log("\n[8c] remote-zip marketplace entry over loopback HTTP");
// 152 of the official catalog's 292 entries are {source:"url"} archives, and
// that path used to be a bare `fetch`: no proxy handling (undici ignores the
// proxy env), no retry, and undici's "fetch failed" swallows the cause — which
// is how a whole class of installs died with nothing actionable. It now goes
// through curl with the same proxy discipline as gitClone, so serve the zip
// fixture over loopback and exercise the real transport (machines without curl
// take the fetch fallback — both must pass this).
const zipBytes = readFileSync(zipPath);
const zipServer = createServer((req, res) => {
  // 404 for every other path, so the missing-archive case has something to fail
  // ON and must report the status instead of the old bare "fetch failed".
  if (req.url !== "/demo-plugin.zip") {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  res.writeHead(200, { "content-type": "application/zip" });
  res.end(zipBytes);
});
await new Promise<void>((resolve) => zipServer.listen(0, "127.0.0.1", resolve));
const zipAddr = zipServer.address();
const zipPort = typeof zipAddr === "object" && zipAddr ? zipAddr.port : 0;

const remoteMpDir = path.join(fixtureDir, "remote-mp");
mkdirSync(path.join(remoteMpDir, ".claude-plugin"), { recursive: true });
writeFileSync(
  path.join(remoteMpDir, ".claude-plugin", "marketplace.json"),
  JSON.stringify({
    name: "remote-mp",
    plugins: [
      {
        name: "demo-plugin",
        description: "url entry served over loopback",
        source: { source: "url", url: `http://127.0.0.1:${zipPort}/demo-plugin.zip` },
      },
      {
        name: "missing-plugin",
        description: "url entry pointing at a 404",
        source: { source: "url", url: `http://127.0.0.1:${zipPort}/nope.zip` },
      },
      {
        // The shape 152 of the official catalog's 292 entries use: a url source
        // that is a REPOSITORY, not an archive. It must be cloned — treating it
        // as a download fetched GitHub's HTML page and died in tar with
        // "Unrecognized archive format".
        name: "git-url-plugin",
        description: "url entry that is a git repo",
        source: { source: "url", url: `file://${gitRepo}` },
      },
    ],
  }),
);
const remoteMpAdd = await addMarketplace({ kind: "local", ref: remoteMpDir });
ok(remoteMpAdd.ok, "remote-zip marketplace added", remoteMpAdd.error ?? "");
const gitUrlInstall = await installFromMarketplace("remote-mp", "git-url-plugin");
ok(gitUrlInstall.ok, "url source that is a repo installs (git clone)", gitUrlInstall.error ?? "");
eq(gitUrlInstall.plugin?.name, "git-plugin", "repo-url entry installed under its manifest name");
const remoteInstall = await installFromMarketplace("remote-mp", "demo-plugin");
ok(
  remoteInstall.ok,
  "url-source entry installs (download + extract)",
  remoteInstall.error ?? "",
);
eq(remoteInstall.plugin?.name, "demo-plugin", "archive installed under its manifest name");
ok(
  (remoteInstall.plugin?.components.skills.length ?? 0) > 0,
  "downloaded archive keeps its components",
);
// A dead archive URL must report WHAT failed. Before this, the user got the
// bare "fetch failed" that undici emits for every network error.
const missing404 = await installFromMarketplace("remote-mp", "missing-plugin");
ok(!missing404.ok, "unreachable archive fails the install", missing404.error ?? "");
ok(
  /404/.test(missing404.error ?? ""),
  "failure names the HTTP status instead of a bare 'fetch failed'",
  missing404.error ?? "",
);
await new Promise<void>((resolve) => zipServer.close(() => resolve()));
removeMarketplace("remote-mp");

/* ── 8d. Codex marketplace (openai/plugins layout) ── */
console.log("\n[8d] Codex marketplace (.agents/plugins/marketplace.json)");
const codexMpDir = path.join(fixtureDir, "codex-mp");
const cxSkills = path.join(codexMpDir, "plugins", "cx-skills");
const cxApps = path.join(codexMpDir, "plugins", "cx-apps");
mkdirSync(path.join(codexMpDir, ".agents", "plugins"), { recursive: true });
mkdirSync(path.join(cxSkills, ".codex-plugin"), { recursive: true });
mkdirSync(path.join(cxSkills, "skills", "plan"), { recursive: true });
mkdirSync(path.join(cxApps, ".codex-plugin"), { recursive: true });
writeFileSync(
  path.join(codexMpDir, ".agents", "plugins", "marketplace.json"),
  JSON.stringify({
    name: "codex-test-mp",
    interface: { displayName: "Codex test" },
    plugins: [
      {
        name: "cx-skills",
        source: { source: "local", path: "./plugins/cx-skills" },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Coding",
      },
      { name: "cx-apps", source: { source: "local", path: "./plugins/cx-apps" } },
      {
        name: "cx-hidden",
        source: { source: "local", path: "./plugins/cx-hidden" },
        policy: { installation: "NOT_AVAILABLE" },
      },
    ],
  }),
);
// superpowers-style manifest: inline (empty) hooks object, skills as "./skills/",
// plus inline MCP servers (Claude's object form).
writeFileSync(
  path.join(cxSkills, ".codex-plugin", "plugin.json"),
  JSON.stringify({
    name: "cx-skills",
    version: "0.2.0",
    description: "Codex skills plugin",
    hooks: {},
    skills: "./skills/",
    mcpServers: { docs: { type: "http", url: "https://example.com/mcp" } },
    interface: { displayName: "CX Skills" },
  }),
);
writeFileSync(path.join(cxSkills, "skills", "plan", "SKILL.md"), "---\nname: plan\ndescription: Plan work\n---\nbody");
writeFileSync(
  path.join(cxApps, ".codex-plugin", "plugin.json"),
  JSON.stringify({ name: "cx-apps", version: "0.1.0", description: "Gmail connector", apps: "./.app.json" }),
);
writeFileSync(path.join(cxApps, ".app.json"), JSON.stringify({ apps: { gmail: { id: "connector_x" } } }));

const codexAdd = await addMarketplace({ kind: "local", ref: codexMpDir });
ok(codexAdd.ok, "Codex-layout marketplace is accepted", codexAdd.error ?? "");
const codexMp = listMarketplaces().find((m) => m.name === "codex-test-mp");
eq(codexMp?.ecosystem, "codex", "badged as a Codex catalog");
eq(codexMp?.plugins.map((p) => p.name), ["cx-skills", "cx-apps"], "NOT_AVAILABLE entry hidden");
eq(codexMp?.plugins[0].description, "Codex skills plugin", "description read from the plugin's own manifest");
eq(codexMp?.plugins[0].version, "0.2.0", "version read from the plugin's own manifest");
eq(
  codexMp?.plugins[0].compatibleProviderIds,
  ["claude-sdk", "codex-sdk", "pi-sdk"],
  "engines known before install (skills + MCP)",
);
eq(codexMp?.plugins[1].appsOnly, true, "app-only entry flagged");
const cxInstall = await installFromMarketplace("codex-test-mp", "cx-skills");
ok(cxInstall.ok, "{source:local} entry installs", cxInstall.error ?? "");
eq(cxInstall.plugin?.components.hooks.length, 0, "inline empty hooks object = no hooks (no warning)");
eq(cxInstall.plugin?.components.skills.map((s) => s.name), ["plan"], "skills from ./skills/");
eq(cxInstall.plugin?.components.mcpServers.map((s) => s.name), ["docs"], "inline mcpServers summarized");
eq(setPluginEnabled("cx-skills", true).ok, true, "enable cx-skills");
ok(
  (await getPluginMcpServers(undefined, "codex-sdk")).some(([n]) => n === "cx-skills__docs"),
  "inline MCP server delivered to Codex",
);
const appsInstall = await installFromMarketplace("codex-test-mp", "cx-apps");
ok(appsInstall.ok, "app-only entry still installs when asked", appsInstall.error ?? "");
eq(appsInstall.plugin?.components.apps, ["gmail"], "apps listed by name");
removePlugin("cx-skills");
removePlugin("cx-apps");
removeMarketplace("codex-test-mp");

/* ── 9. remove cleanup ── */
console.log("\n[9] remove cleanup");
setPluginMcpDisabled("demo-plugin__fetcher", true);
eq(removePlugin("demo-plugin").ok, true, "remove ok");
eq((await getEnabledPlugins()).length, 0, "no longer delivered");
eq(
  listPlugins().map((p) => p.name),
  ["escape-plugin", "git-plugin", "mono-plugin", "nested-plugin"],
  "remaining plugins",
);
// denylist cleanup: demo-plugin__ entries dropped by removePlugin
const denylisted = JSON.parse(SettingRepo.__dump()["plugins.mcpDisabled"] ?? "[]");
eq(denylisted.length, 0, "per-plugin MCP denylist cleared on remove");
eq(
  Object.keys(JSON.parse(SettingRepo.__dump()["plugins.engines"] ?? "{}")),
  [],
  "per-plugin engine switches cleared on remove",
);

const mpRemove = removeMarketplace("test-mp");
ok(mpRemove.ok, "marketplace removed");
const afterRemove = listMarketplaces();
eq(afterRemove.filter((m) => !m.builtin).length, 0, "no user marketplaces left");
eq(afterRemove.length, 3, "shipped catalogs survive the removal of every user marketplace");


/* ── 【ARC-014】逐组件交付报告:ANY 兼容 ≠ ALL 就绪 ──
 * 一个"含通用 Skill + Claude 专用 Command"的插件,compatibleProviderIds 里有 Pi,
 * 但 Pi 收不到那个 Command —— 场景"需要 Command"时不能被全绿放行。 */
{
  const mk = (skills: string[], commands: string[], mcp: string[]) => ({
    skills: skills.map((n) => ({ name: n, description: "" })),
    commands: commands.map((n) => ({ name: n, description: "" })),
    agents: [],
    hooks: [],
    mcpServers: mcp.map((n) => ({ name: n, kind: "stdio" as const, detail: "" })),
  });
  const mixed = mk(["generic-skill"], ["claude-cmd"], []);
  // Pi:skill DELIVERED,command INCOMPATIBLE → allDelivered=false(场景需要 Command 就不能放行)。
  const piRep = componentDeliveryReport("demo", "1.0.0", "pi-sdk", mixed, true);
  ok(piRep.entries.find((e) => e.type === "skill")?.status === "DELIVERED", "ARC-014:Pi 收通用 skill(DELIVERED)");
  ok(piRep.entries.find((e) => e.type === "command")?.status === "INCOMPATIBLE", "ARC-014:Pi 收不到 Claude 专用 command(INCOMPATIBLE)");
  ok(piRep.allDelivered === false, "ARC-014:混合插件对 Pi allDelivered=false(ANY≠ALL)");
  // Claude:两者都 DELIVERED → allDelivered=true。
  const claudeRep = componentDeliveryReport("demo", "1.0.0", "claude-sdk", mixed, true);
  ok(claudeRep.allDelivered === true, "ARC-014:同一插件对 Claude 全交付");
  // Pi 不原生挂 MCP。
  const mcpRep = componentDeliveryReport("demo", "1.0.0", "pi-sdk", mk([], [], ["srv"]), true);
  ok(mcpRep.entries.find((e) => e.type === "mcp")?.status === "INCOMPATIBLE", "ARC-014:Pi 不原生挂 MCP(INCOMPATIBLE)");
  // 纯 skill 插件:Pi 全交付(不误杀)。
  const skillOnly = componentDeliveryReport("demo", "1.0.0", "pi-sdk", mk(["s"], [], []), true);
  ok(skillOnly.allDelivered === true, "ARC-014:纯 skill 插件对 Pi 全交付(不误杀有效 skill)");
  // 插件被禁用:全部 DISABLED。
  const disabled = componentDeliveryReport("demo", "1.0.0", "claude-sdk", mixed, false);
  ok(disabled.entries.every((e) => e.status === "DISABLED"), "ARC-014:插件禁用 → 全部 DISABLED");
}


/* ── 【ARC-014】场景组件就绪:按 requiredComponentIds 做 ALL 判定 ──
 * 台账原话:「ScenePlanner 按 requiredComponentId 校验」;「需要 Command 的 Pi 场景
 * 不能被全绿误放行」。这里用 componentDeliveryReport 现造报告,再喂给 sceneComponentReadiness。 */
{
  const mk2 = (skills: string[], commands: string[]) => ({
    skills: skills.map((n) => ({ name: n, description: "" })),
    commands: commands.map((n) => ({ name: n, description: "" })),
    agents: [],
    hooks: [],
    mcpServers: [],
  });
  const mixed = mk2(["generic-skill"], ["claude-cmd"]);
  const piRep = componentDeliveryReport("demo", "1.0.0", "pi-sdk", mixed, true);
  const claudeRep = componentDeliveryReport("demo", "1.0.0", "claude-sdk", mixed, true);

  // 空需求:真空满足,不该凭空报缺。
  const empty = sceneComponentReadiness([], [piRep]);
  ok(empty.ready === true && empty.gaps.length === 0, "ARC-014:无必需组件 → ready(真空满足)");

  // 只需 skill 的 Pi 场景:通过(不误杀有效 skill)。
  const skillOnly = sceneComponentReadiness(["skill:0"], [piRep]);
  ok(skillOnly.ready === true, "ARC-014:只需 skill 的 Pi 场景 → ready");
  eq(skillOnly.satisfied, ["skill:0"], "ARC-014:就绪项列出 skill:0");

  // 「需要 Command」的 Pi 场景**不能**被放行 —— 这是 ANY≠ALL 的承重反例。
  const needCmd = sceneComponentReadiness(["skill:0", "command:0"], [piRep]);
  ok(needCmd.ready === false, "ARC-014:需要 Command 的 Pi 场景不被全绿放行(ALL 判定)");
  eq(needCmd.satisfied, ["skill:0"], "ARC-014:Pi 场景里 skill 就绪、command 是缺口");
  ok(needCmd.gaps.length === 1 && needCmd.gaps[0].componentId === "command:0", "ARC-014:缺口精确指向 command:0");
  ok(needCmd.gaps[0].status === "INCOMPATIBLE", "ARC-014:缺口状态 = 报告里的 INCOMPATIBLE");
  ok(needCmd.providerId === "pi-sdk", "ARC-014:结果带出被检查的 providerId");

  // 同一需求对 Claude:两个组件都 DELIVERED → ready。
  const claudeReady = sceneComponentReadiness(["skill:0", "command:0"], [claudeRep]);
  ok(claudeReady.ready === true && claudeReady.gaps.length === 0, "ARC-014:同需求对 Claude 全就绪 → ready");

  // 被禁用的插件:需求命中 → 缺口 DISABLED,不放行。
  const disabledRep = componentDeliveryReport("demo", "1.0.0", "claude-sdk", mixed, false);
  const disabledScene = sceneComponentReadiness(["command:0"], [disabledRep]);
  ok(disabledScene.ready === false && disabledScene.gaps[0].status === "DISABLED", "ARC-014:插件禁用 → 场景缺口 DISABLED");

  // 没有任何报告提到的组件 id → 缺口 MISSING(不静默通过)。
  const missing = sceneComponentReadiness(["command:9"], [piRep]);
  ok(missing.ready === false && missing.gaps[0].status === "MISSING", "ARC-014:无人交付的组件 → 缺口 MISSING");
  eq(missing.gaps[0].reportedBy, [], "ARC-014:MISSING 缺口没有报告来源");

  // 完全没有报告:每个必需项都是 MISSING。
  const noRep = sceneComponentReadiness(["skill:0", "command:0"], []);
  ok(noRep.ready === false && noRep.gaps.length === 2, "ARC-014:无任何报告 → 两项皆缺口");
  ok(noRep.providerId === undefined, "ARC-014:无报告时不带 providerId");

  // required 去重(保首见顺序);重复的 id 不该算成两个缺口/两次就绪。
  const dup = sceneComponentReadiness(["skill:0", "skill:0", "command:0"], [piRep]);
  eq(dup.satisfied, ["skill:0"], "ARC-014:required 去重后就绪项不重复");
  eq(dup.gaps.map((g) => g.componentId), ["command:0"], "ARC-014:required 去重后缺口不重复");

  // 多报告对同一 id 给不同未交付状态 → 按优先级取「用户要动手改」的(授信撤销优先于引擎不支持)。
  const deniedRep: ComponentDeliveryReport = {
    pluginId: "other",
    providerId: "pi-sdk",
    pluginEnabled: true,
    entries: [{ componentId: "command:0", type: "command", source: "c", status: "DENIED", reason: "MCP 授信被撤销" }],
    allDelivered: false,
  };
  const prio = sceneComponentReadiness(["command:0"], [piRep, deniedRep]);
  ok(prio.gaps[0].status === "DENIED", "ARC-014:多报告冲突 → 取优先级更高的 DENIED");
  eq(prio.gaps[0].reportedBy, ["demo", "other"], "ARC-014:缺口列出所有提到该 id 的插件");

  // 只要有一份报告 DELIVERED,就不算缺口(某个插件交付到即可)。
  const deliveredAnyway = sceneComponentReadiness(["command:0"], [piRep, claudeRep]);
  ok(deliveredAnyway.ready === true, "ARC-014:任一份报告 DELIVERED 即就绪");
}


/* ── 【ARC-003/ARC-014】兼容列表与逐组件报告取**同一份**投递矩阵(去平行事实) ──
 * 两个判据(ANY 兼容 / ALL 交付)本来是各写一遍的,已实测漂移:兼容列表漏了 `apps`
 * (Codex 专用),一个 app-only 插件被谎报成 Claude/Pi 也能用。这里既钉死共享矩阵的
 * 权威值,又钉死两个消费方与矩阵一致。 */
{
  const mkComponents = (over: Partial<PluginComponents>): PluginComponents => ({
    skills: [], commands: [], agents: [], hooks: [], mcpServers: [], ...over,
  });
  const asManifest = (name: string): PluginManifest =>
    PluginManifestSchema.parse({ name, version: "1.0.0" });

  // ① 共享矩阵就是权威 —— app 只有 Codex,mcp 无 Pi,command/agent/hook 只有 Claude。
  eq(COMPONENT_PROVIDER_DELIVERY.app, ["codex-sdk"], "ARC-003:投递矩阵 app 仅 Codex");
  eq(COMPONENT_PROVIDER_DELIVERY.command, ["claude-sdk"], "ARC-003:投递矩阵 command 仅 Claude");
  eq(COMPONENT_PROVIDER_DELIVERY.mcp, ["claude-sdk", "codex-sdk"], "ARC-003:投递矩阵 mcp 无 Pi");
  eq(COMPONENT_PROVIDER_DELIVERY.skill, ["claude-sdk", "codex-sdk", "pi-sdk"], "ARC-003:投递矩阵 skill 三家");

  // ② 真缺陷红例:app-only 插件(clone cx-apps 的形状)不得被谎报成 Claude/Pi 兼容。
  const appOnly = mkComponents({ apps: ["gmail"] });
  eq(
    compatibleProviderIdsForPlugin(asManifest("app-only"), appOnly),
    ["codex-sdk"],
    "ARC-003:app-only 插件的兼容列表只有 Codex(旧规则漏 apps → 谎报三家)",
  );
  // 逐组件报告对同一个 app-only 插件也必须只对 Codex DELIVERED、其余 INCOMPATIBLE。
  ok(
    componentDeliveryReport("app-only", "1.0.0", "claude-sdk", appOnly, true).allDelivered === false,
    "ARC-014:app-only 对 Claude 不交付",
  );
  ok(
    componentDeliveryReport("app-only", "1.0.0", "codex-sdk", appOnly, true).allDelivered === true,
    "ARC-014:app-only 对 Codex 交付",
  );

  // ③ 两个消费方对每个 provider 的 ANY/ALL 必须与共享矩阵一致(混合组件)。
  const mixedAll = mkComponents({
    skills: [{ name: "s", description: "" }],
    commands: [{ name: "c", description: "" }],
    mcpServers: [{ name: "m", kind: "stdio", detail: "" }],
    apps: ["gmail"],
  });
  const compat = compatibleProviderIdsForPlugin(asManifest("mixed"), mixedAll);
  eq(compat, ["claude-sdk", "codex-sdk", "pi-sdk"], "ARC-003:混合插件兼容列表含三家(skill 支撑 Pi)");
  for (const providerId of ["claude-sdk", "codex-sdk", "pi-sdk"]) {
    // ANY 列表里有它 ⟺ 该 provider 至少交付一个组件(逐组件报告里存在一条 DELIVERED)。
    const anyDelivered = componentDeliveryReport("mixed", "1.0.0", providerId, mixedAll, true).entries
      .some((e) => e.status === "DELIVERED");
    ok(
      compat.includes(providerId) === anyDelivered,
      `ARC-003:兼容列表与逐组件报告在 ${providerId} 上一致(ANY 语义同源)`,
    );
  }
}



/* ── 【MC-061】HostHookGrant:插件 hook 的「准不准跑」有唯一判定落点 ──
 * 默认**拒绝**(没有有效授权);签发覆盖来源的授权后 allowed;事件映射不到则 unmappable
 * (即便有授权)。撤销 / 卸载按插件全撤。 */
{
  const { decideHostHookExecution, isHostHookGrantActive } = await import("@contracts/hostHookGrant");
  const { issueHostHookGrant, revokeHostHookGrant, revokeHostHookGrants, resetHostHookGrants, decidePluginHookExecution: decision0 } =
    await import("../../src/main/hooks/hostHookGrants.js");
  const src = { pluginId: "demo-plugin", version: "1.0.0", commandDigest: "sha:abc", nativeEvent: "PreToolUse" };
  const NOW = 1_000_000;

  // 默认拒绝:没有任何授权。
  eq(decideHostHookExecution(src, "tool.use", [], NOW).decide, "denied", "MC-061:无授权 → 默认拒绝");
  // 签发一份覆盖该来源的授权 → allowed(且带 grantId)。
  resetHostHookGrants();
  const g = issueHostHookGrant({ pluginId: "demo-plugin", version: "1.0.0", ttlMs: 60_000, now: NOW });
  const allowed = decision0(src, "tool.use", NOW);
  eq(allowed.decide, "allowed", "MC-061:有有效授权 → allowed");
  ok(allowed.decide === "allowed" && allowed.grantId === g.grantId, "MC-061:allowed 带回命中的 grantId");
  // 事件映射不到 → unmappable(即便有授权也不投)。
  eq(decision0(src, null, NOW).decide, "unmappable", "MC-061:有授权但事件映射不到 → unmappable");
  // 来源不符(别的插件 / 别的版本)→ denied。
  eq(decision0({ ...src, pluginId: "other" }, "tool.use", NOW).decide, "denied", "MC-061:别的插件 → denied");
  eq(decision0({ ...src, version: "2.0.0" }, "tool.use", NOW).decide, "denied", "MC-061:别的版本 → denied");
  // 授权绑事件:只覆盖 PreToolUse 时,PostToolUse 不放行。
  resetHostHookGrants();
  issueHostHookGrant({ pluginId: "demo-plugin", version: "1.0.0", events: ["PreToolUse"], ttlMs: 60_000, now: NOW });
  eq(decision0({ ...src, nativeEvent: "PostToolUse" }, "tool.result", NOW).decide, "denied", "MC-061:事件不在授权覆盖集 → denied");
  eq(decision0({ ...src, nativeEvent: "PreToolUse" }, "tool.use", NOW).decide, "allowed", "MC-061:事件在授权覆盖集 → allowed(正控)");
  // 过期 → 无效。
  resetHostHookGrants();
  const g3 = issueHostHookGrant({ pluginId: "demo-plugin", version: "1.0.0", ttlMs: 60_000, now: NOW });
  ok(!isHostHookGrantActive(g3, NOW + 60_000), "MC-061:过期授权不再有效");
  eq(decideHostHookExecution(src, "tool.use", [g3], NOW + 60_000).decide, "denied", "MC-061:过期 → denied");
  // 撤销 → 无效。
  resetHostHookGrants();
  const g2 = issueHostHookGrant({ pluginId: "demo-plugin", version: "1.0.0", ttlMs: 60_000, now: NOW });
  eq(revokeHostHookGrant(g2.grantId), true, "MC-061:撤销一份有效授权返回 true");
  eq(decision0(src, "tool.use", NOW).decide, "denied", "MC-061:撤销后 → denied");
  eq(revokeHostHookGrant(g2.grantId), false, "MC-061:重复撤销幂等(返回 false)");
  // 按插件全撤(卸载同步撤销):撤掉 2 份该插件的有效授权。
  resetHostHookGrants();
  issueHostHookGrant({ pluginId: "demo-plugin", version: "1.0.0", ttlMs: 60_000, now: NOW });
  issueHostHookGrant({ pluginId: "demo-plugin", version: "1.0.0", events: ["PreToolUse"], ttlMs: 60_000, now: NOW });
  issueHostHookGrant({ pluginId: "keep-me", version: "1.0.0", ttlMs: 60_000, now: NOW });
  eq(revokeHostHookGrants("demo-plugin"), 2, "MC-061:按插件撤掉它全部有效授权");
  eq(decision0(src, "tool.use", NOW).decide, "denied", "MC-061:卸载撤权后该插件 hook → denied");
  const keepSrc = { pluginId: "keep-me", version: "1.0.0", commandDigest: "", nativeEvent: "PreToolUse" };
  eq(decision0(keepSrc, "tool.use", NOW).decide, "allowed", "MC-061:撤 one 插件不波及其它插件(keep-me 仍有授权)");
  resetHostHookGrants();
}

/* ── 【MC-061】面板的执行态走**真命令摘要**的来源身份(与宿主执行时同一份) ──
 * `toPluginState` 此前给来源传的是 `commandDigest: ""`(不绑命令) —— 与执行通道按真摘要
 * 绑定的那份来源**分家**。分家的表现:面板显示「已授信」而执行时 denied(或反之)。这里
 * 用一份**绑真摘要**的授权做正控:面板认得出 → granted。若来源退回 `""`,真摘要授权匹配
 * 不上,面板会显示 unsupported —— 这条就红。 */
{
  const { hostHookSourceOf } = await import("../../src/main/hooks/hostHookGrants.js");
  const { issueHostHookGrant: issue2, resetHostHookGrants: reset2 } = await import(
    "../../src/main/hooks/hostHookGrants.js"
  );
  // demo-plugin 在 [9] remove cleanup 里被卸载了 —— 这里从**源夹具**重新装一份(夹具目录还在)。
  const reinstall = await installFromLocal(demoRoot);
  ok(reinstall.ok, "MC-061:重新装 demo-plugin(夹具还在)", reinstall.error ?? "");
  reset2();
  // demo-plugin 的 PreToolUse / 「echo pre」 —— 真摘要来自**唯一构造点**。
  const realSource = hostHookSourceOf({
    pluginId: "demo-plugin",
    version: "1.2.3",
    nativeEvent: "PreToolUse",
    command: "echo pre",
  });
  issue2({
    pluginId: "demo-plugin",
    version: "1.2.3",
    commandDigest: realSource.commandDigest,
    ttlMs: 600_000,
    now: Date.now(),
  });
  const row = listPlugins().find((p) => p.name === "demo-plugin");
  const preHook = row?.components.hooks.find((h) => h.event === "PreToolUse");
  eq(preHook?.execution, "granted", "MC-061:面板用真命令摘要判定 → 绑真摘要的授权显示 granted");
  // 换一条别的命令的授权不覆盖(命令摘要绑定的负控)。
  reset2();
  const otherDigest = hostHookSourceOf({
    pluginId: "demo-plugin",
    version: "1.2.3",
    nativeEvent: "PreToolUse",
    command: "echo DIFFERENT",
  }).commandDigest;
  issue2({ pluginId: "demo-plugin", version: "1.2.3", commandDigest: otherDigest, ttlMs: 600_000, now: Date.now() });
  const row2 = listPlugins().find((p) => p.name === "demo-plugin");
  eq(
    row2?.components.hooks.find((h) => h.event === "PreToolUse")?.execution,
    "unsupported",
    "MC-061:命令改过(摘要不符)的授权不覆盖 → unsupported(授权按来源绑定)",
  );
  reset2();
}

/* ── 【MC-061 复审修复】停用 / 卸载**真的**撤销该插件的全部 hook 授权 ──
 * 独立复审点名:`setPluginEnabled` / `removePlugin` 里**没有** `revokeHostHookGrants` 调用 ——
 * 「停用插件后它的 hook 仍凭旧授权在跑」是静默的信任残留。这里装一份插件、签发授权,再停用 / 卸载,
 * 断言该插件的授权**真的没了**(而别的插件的授权不受牵连 —— 撤一个不波及另一个)。 */
{
  const { issueHostHookGrant: issue3, resetHostHookGrants: reset3, listHostHookGrants } = await import(
    "../../src/main/hooks/hostHookGrants.js"
  );
  const { decidePluginHookExecution: decide3 } = await import("../../src/main/hooks/hostHookGrants.js");

  // —— 停用即撤权 ——
  await installFromLocal(demoRoot); // 重新装回(前面 [9] 卸过)
  setPluginEnabled("demo-plugin", true);
  reset3();
  const srcD = { pluginId: "demo-plugin", version: "1.2.3", commandDigest: "sha:x", nativeEvent: "PreToolUse" };
  const srcK = { pluginId: "other-plugin", version: "1.0.0", commandDigest: "sha:y", nativeEvent: "PreToolUse" };
  issue3({ pluginId: "demo-plugin", version: "1.2.3", ttlMs: 600_000, now: Date.now() });
  issue3({ pluginId: "other-plugin", ttlMs: 600_000, now: Date.now() });
  eq(decide3(srcD, "tool.use", Date.now()).decide, "allowed", "前置:停用前 demo-plugin 有授权 → allowed");
  setPluginEnabled("demo-plugin", false);
  eq(decide3(srcD, "tool.use", Date.now()).decide, "denied", "★ MC-061:停用插件 → 授权同步撤销 → denied");
  eq(decide3(srcK, "tool.use", Date.now()).decide, "allowed", "★ MC-061:撤一个不波及其它插件(other-plugin 仍 allowed)");

  // —— 卸载即撤权 ——
  reset3();
  setPluginEnabled("demo-plugin", true);
  issue3({ pluginId: "demo-plugin", version: "1.2.3", ttlMs: 600_000, now: Date.now() });
  eq(decide3(srcD, "tool.use", Date.now()).decide, "allowed", "前置:卸载前 demo-plugin 有授权 → allowed");
  eq(removePlugin("demo-plugin").ok, true, "卸载成功");
  eq(decide3(srcD, "tool.use", Date.now()).decide, "denied", "★ MC-061:卸载插件 → 授权同步撤销 → denied");
  eq(listHostHookGrants().filter((g) => g.pluginId === "demo-plugin" && !g.revoked).length, 0, "★ MC-061:卸载后该插件无任何有效授权");
  reset3();
}

/* ── summary ── */
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);