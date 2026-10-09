/**
 * terminal-panel-worktree-smoke — TerminalPanel 的**工作树终端桶被误清**。
 *
 * ## 盯的是什么
 *
 * `TerminalPanel` 把终端桶**按「环境路径」**存(`ProjectTermState` 的 key =
 * `selectActiveEnvPath(state)`)—— 工作树会话的终端就开在 `session.worktreePath`
 * (`userData/worktrees/…` 下),**那不是任何一个项目根**。
 *
 * 而那个"项目没了就清桶"的 effect 从前只拿 `projects.map(p => p.path)` 当活路径集合:
 * 任何一次 `projects` 数组**换身份**(项目改名 / 分组 / 排序、或别的端碰了项目触发
 * `refreshProjects`)都会跑它 —— 工作树的桶(路径不在任何项目根里)当场被当成"项目没了"
 * 删掉。用户正开着的终端、正在跑的进程标签、回滚缓冲**无声消失**。
 *
 * ## 判据
 *
 * 立在**用户看到的标签条**上:工作树会话活动时,终端标签(标题里带工作树目录名)必须在。
 *   - ① 首次挂载(那个 effect 在挂载时就会跑一次)—— 标签要在。
 *   - ② 项目数组改名换身份(同一项目,新数组)—— 标签**必须还在**(报告的场景)。
 * 正控 ③ 普通(非工作树)会话挂载时标签也正常出现,证明这套确实能看见标签。
 * 源码不变量 ④ 清理 effect 仍会删**真正没人引用的**桶(防止"把清理整个关掉"那种假修复)。
 *
 * ## 它怎么跑
 *
 * esbuild 换 `react` 为极小 hooks 运行时(组件源码原样跑);`@renderer/lib/api.js`
 * 换成记事桩;重量级子件(TerminalView 的 xterm + CSS)换空壳;图标 barrel 换空壳。
 * 不起浏览器、不碰磁盘。
 *
 * Run: scripts/terminal-panel-worktree-smoke/run.sh
 */
import "./prelude.js";
import { __mount, __flush, __text } from "./fakeReact.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { TerminalPanel } from "@renderer/components/ide/TerminalPanel.js";

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

const PROJ = { id: "p1", path: "/p/proj", name: "proj", archived: false };
const WT = "/wt/wt1";

/** 一条会话行 —— 组件只读 id / worktreePath / archived。 */
function sess(id: string, worktreePath?: string | null): Record<string, unknown> {
  return { id, projectId: "p1", worktreePath: worktreePath ?? null, archived: false };
}

/** 当前渲染出的标签条文本(里面会带出 `ide.term.tabTitle` 的标题)。 */
function tabText(): string {
  return __text();
}

async function scenario() {
  // ── ① 工作树会话:终端桶开在 /wt/wt1(不在任何项目根里) ──
  useSessionStore.setState({
    locale: "zh",
    projects: [PROJ],
    activeProjectId: "p1",
    activeSessionId: "s-wt",
    sessions: [sess("s-wt", WT)],
    sessionsByProject: { p1: [sess("s-wt", WT)] },
    archivedSessionsByProject: {},
    pinnedSessions: [],
  } as never);
  __mount(() => TerminalPanel({ active: true }));
  await __flush();

  const first = tabText();
  check(
    "★ 挂载时工作树会话的终端标签就在(清理 effect 挂载时跑一次,不能把它的桶当'项目没了')",
    first.includes("wt1"),
    first,
  );

  // ── ② 项目数组换身份(改名 → 新的 projects 数组,同一项目) ──
  // 这正是报告的场景:别端碰项目 / 本地改名都会让 projects 数组换引用,effect 重跑。
  const renamed = { ...PROJ, name: "proj-renamed" };
  useSessionStore.setState({ projects: [renamed] } as never);
  await __flush();

  const after = tabText();
  check(
    "★ 项目改名(projects 数组换身份)后,工作树终端标签必须还在",
    after.includes("wt1"),
    after,
  );
}

async function positiveControl() {
  // ── ③ 正控:普通(非工作树)会话挂载后标签正常出现 —— 证明判据看得见标签 ──
  useSessionStore.setState({
    locale: "zh",
    projects: [PROJ],
    activeProjectId: "p1",
    activeSessionId: "s-local",
    sessions: [sess("s-local")],
    sessionsByProject: { p1: [sess("s-local")] },
    archivedSessionsByProject: {},
    pinnedSessions: [],
  } as never);
  __mount(() => TerminalPanel({ active: true }));
  await __flush();

  const text = tabText();
  check("正控:普通会话的终端标签出现(标题带项目名)", text.includes("proj"), text);
}

/** 源码不变量:清理 effect 仍必须删**没人引用的**桶(锚在 `termsRef.current.delete(p)`)。 */
async function sourceInvariant() {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const src = readFileSync(
    join(process.cwd(), "src/renderer/components/ide/TerminalPanel.tsx"),
    "utf8",
  );
  // 去注释后再正则 —— 否则注释里的示例代码会把判据喂饱。
  const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  check(
    "清理 effect 仍按 livePaths 删真正没人引用的桶(不是把清理整个关掉)",
    /if \(livePaths\.has\(p\)\) continue;/.test(code) && /termsRef\.current\.delete\(p\);/.test(code),
    code.match(/termsRef\.current\.delete\([^\n]*/g),
  );
}

await scenario();
await positiveControl();
await sourceInvariant();

console.log(`\nterminal-panel-worktree-smoke:${checks - failures}/${checks} 通过`);
process.exit(failures === 0 ? 0 : 1);
