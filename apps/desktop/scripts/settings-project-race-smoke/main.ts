/**
 * settings-project-race-smoke — 项目作用域设置页(插件/MCP)的**旧回包回写**
 * (与 project-branch-race-smoke / custom-tab-race-smoke 同一类,见底层修复记录 #116-#122)。
 *
 * ## 盯的是什么
 *
 * 「项目插件」「项目 MCP」两页都按 `project.path` 拉各自的 `projectList`。切项目时是**同一个
 * 组件实例换了 `project` prop**,弱网下几百毫秒很正常:
 *
 *   P1 的 projectList 在飞 → 用户切到 P2 → P2 先回 → P1 后回。
 *
 * 没有请求序号守卫时,P1 那句迟到的 `setRows`/`setData` 会把**上一个项目的插件/MCP 行**
 * 画到新项目这一页 —— 用户以为看的是 P2 的 `.mcp.json`,其实画的是 P1 的。
 *
 * ## 判据
 *
 * 立在**页面上那几行字**上:切到 P2、放完所有回包后,页面里必须是 P2 的名字。
 *
 * ## 它怎么跑
 *
 * esbuild 打包真组件;`react` 换极小 hooks 运行时,`ScopeTabs`/`ui`/icons 换直通桩,
 * `@renderer/lib/api.js` 换成**能扣住回包**的替身。两页都是导出的根组件,直接挂载。
 * 不起浏览器、不写盘。
 *
 * Run: scripts/settings-project-race-smoke/run.sh
 */
import "./prelude.js";
import { __mount, __render, __flush, __text } from "./fakeReact.js";
import { server, resetApi, release } from "./api-stub.js";
import { ProjectPluginsView } from "@renderer/components/settings/ProjectPluginsView.js";
import { ProjectMcpView } from "@renderer/components/settings/ProjectMcpView.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  checks++;
  if (cond) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures++;
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

useSessionStore.setState({ locale: "zh" } as never);

const P1 = { id: "p1", name: "PROJ-ONE", path: "/w/one", archived: false, pinnedAt: null, sortOrder: 0, createdAt: 1, updatedAt: 1 };
const P2 = { id: "p2", name: "PROJ-TWO", path: "/w/two", archived: false, pinnedAt: null, sortOrder: 0, createdAt: 1, updatedAt: 1 };
const PROJECTS = [P1, P2];

/* ─────────────────── 1. 项目插件 ─────────────────── */

async function pluginsScenario(): Promise<void> {
  resetApi();
  server.hold.add("plugins:projectList");
  const pluginRow = (name: string) => ({ name, description: "", globalEnabled: true, globalEngines: {}, enabled: true, engines: {}, compatibleProviderIds: [], deliveredProviderIds: [] });
  server.pluginRows[P1.path] = [pluginRow("PLUGIN-OF-P1")];
  server.pluginRows[P2.path] = [pluginRow("PLUGIN-OF-P2")];

  let project = P1;
  __mount(() =>
    ProjectPluginsView({ project, projects: PROJECTS as never, onSelectProject: () => {}, refreshKey: 0 }),
  );
  await __flush();
  check("P1 的 projectList 在飞(被扣住)", server.held.some((h) => h.input.projectPath === P1.path), server.held.map((h) => h.input));

  project = P2;
  __render();
  await __flush();
  check("切到 P2 后发出的是 P2 的 projectList", server.held.some((h) => h.input.projectPath === P2.path), server.held.map((h) => h.input));

  release("plugins:projectList", (i) => i.projectPath === P2.path);
  await __flush();
  check("P2 先回 → 显示 P2 的插件", __text().includes("PLUGIN-OF-P2"), __text());

  release("plugins:projectList", (i) => i.projectPath === P1.path);
  await __flush();
  check(
    "★ 迟到的 P1 插件回包不许盖掉 P2 的列表",
    __text().includes("PLUGIN-OF-P2") && !__text().includes("PLUGIN-OF-P1"),
    __text(),
  );
}

/* ─────────────────── 2. 项目 MCP ─────────────────── */

async function mcpScenario(): Promise<void> {
  resetApi();
  server.hold.add("mcp:projectList");
  server.mcpLists[P1.path] = {
    file: `${P1.path}/.mcp.json`, exists: true, invalid: [],
    servers: [{ name: "MCP-OF-P1", kind: "stdio", detail: "cmd", config: {}, trusted: true }],
  };
  server.mcpLists[P2.path] = {
    file: `${P2.path}/.mcp.json`, exists: true, invalid: [],
    servers: [{ name: "MCP-OF-P2", kind: "stdio", detail: "cmd", config: {}, trusted: true }],
  };

  let project = P1;
  __mount(() =>
    ProjectMcpView({
      project, projects: PROJECTS as never, onSelectProject: () => {},
      userServers: [], refreshKey: 0, onAdd: () => {}, onEdit: () => {},
    }),
  );
  await __flush();
  check("P1 的 projectList 在飞(被扣住)", server.held.some((h) => h.input.projectPath === P1.path), server.held.map((h) => h.input));

  project = P2;
  __render();
  await __flush();
  check("切到 P2 后发出的是 P2 的 projectList", server.held.some((h) => h.input.projectPath === P2.path), server.held.map((h) => h.input));

  release("mcp:projectList", (i) => i.projectPath === P2.path);
  await __flush();
  check("P2 先回 → 显示 P2 的 MCP 服务器", __text().includes("MCP-OF-P2"), __text());

  release("mcp:projectList", (i) => i.projectPath === P1.path);
  await __flush();
  check(
    "★ 迟到的 P1 MCP 回包不许盖掉 P2 的列表",
    __text().includes("MCP-OF-P2") && !__text().includes("MCP-OF-P1"),
    __text(),
  );
}

await pluginsScenario();
await mcpScenario();

console.log(`\nsettings-project-race-smoke:${checks - failures}/${checks} 通过`);
if (failures > 0) process.exitCode = 1;
process.exit(failures > 0 ? 1 : 0);
