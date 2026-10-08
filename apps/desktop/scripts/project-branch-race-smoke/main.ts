/**
 * project-branch-race-smoke — `ProjectBranchIndicator` 的**旧回包回写**
 * (与底层修复记录 #38/#91/#92 同一类:切项目后旧请求回写)。
 *
 * ## 盯的是什么
 *
 * 顶栏那颗「项目 · 分支」药丸由 `ProjectBranchIndicator` 画。切项目时 `projectPath`
 * 是**同一个组件实例**换了个 prop(不是重挂)—— 而 `refresh()` 拉的是 `git.status`,
 * 弱网 / 大仓库下几百毫秒很正常。于是:
 *
 *   P1 的 status 在飞 → 用户切到 P2 → P2 的 status 先回(P2repo)→ P1 的 status 后回。
 *
 * 没有请求序号守卫时,P1 那句迟到的 `setStatus` 会把 P2 的分支**盖掉** —— 顶栏显示
 * 的是又一个别的项目上的分支名,而用户以为看的是当前这个。兄弟组件(`GitPanel` /
 * `GitHistoryView` / `GitDiffDialog`)都靠 `*SeqRef` 挡住了这一类,这一处从前漏了。
 *
 * ## 判据
 *
 * 立在**用户看到的那行字**上:切到 P2、放完所有回包后,药丸上必须是 P2 的分支。
 *
 * ## 它怎么跑
 *
 * esbuild 打包真组件;`react` 换成极小 hooks 运行时(组件源码原样跑),`@base-ui/react/menu`
 * 换成空壳(菜单项不会被调用),`@renderer/lib/api.js` 换成**能扣住回包**的替身。
 * 不起浏览器、不写盘。
 *
 * Run: scripts/project-branch-race-smoke/run.sh
 */
import "./prelude.js";
import { __mount, __render, __flush, __text, __nodes } from "./fakeReact.js";
import { server, resetApi, release, releaseLast } from "./api-stub.js";
import { ProjectBranchIndicator } from "@renderer/components/chat/ProjectBranchIndicator.js";
import { WorktreeMergeToolbarButton } from "@renderer/components/chat/WorktreeMergeBack.js";
import { WorktreeManagerPanel } from "@renderer/components/ide/WorktreeManagerPanel.js";
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

const P1 = "/w/p1";
const P2 = "/w/p2";
const REPO1 = `${P1}/.git-root`;
const REPO2 = `${P2}/.git-root`;

// 顶栏药丸的可见文本(项目名 + 分支)。
function shown(): string {
  return __text();
}

async function scenario(): Promise<void> {
  resetApi();
  server.repos[P1] = [{ path: REPO1, name: "p1", isRepo: true }];
  server.repos[P2] = [{ path: REPO2, name: "p2", isRepo: true }];
  server.statusBranch[REPO1] = "branch-of-P1";
  server.statusBranch[REPO2] = "branch-of-P2";
  // 扣住 status 的回包,由测试按任意顺序放行。
  server.hold.add("git:status");

  let path = P1;
  __mount(() => ProjectBranchIndicator({ projectPath: path, projectName: path }));

  // P1 的 status **一直扣着**(还没回)—— 这才是"旧请求在飞"的现场。
  await __flush();
  check("P1 的 status 确实在飞(被扣住)", server.held.some((h) => h.input.repoPath === REPO1), server.held.map((h) => h.input));

  // 用户切到 P2 —— 同一个组件实例换 prop。P2 的 status 也扣着。
  path = P2;
  __render();
  await __flush();
  check("切到 P2 后发出的是 P2 的 status", server.held.some((h) => h.input.repoPath === REPO2), server.held.map((h) => h.input));

  // ★ P2(新)先回 —— 正常显示 P2 的分支。
  release("git:status", (i) => i.repoPath === REPO2);
  await __flush();
  check("P2 先回 → 显示 P2 的分支", shown().includes("branch-of-P2"), shown());

  // ★★ P1(旧)现在才回 —— 它不许把 P2 的分支盖掉。
  release("git:status", (i) => i.repoPath === REPO1);
  await __flush();
  check("★ 迟到的 P1 回包不许盖掉 P2 的分支", shown().includes("branch-of-P2") && !shown().includes("branch-of-P1"), shown());
}

// P2 先切、P1 后回(与上面同型,换一个方向:确认守卫不是"只挡第一个")。
async function reverseScenario(): Promise<void> {
  resetApi();
  server.repos[P2] = [{ path: REPO2, name: "p2", isRepo: true }];
  server.repos[P1] = [{ path: REPO1, name: "p1", isRepo: true }];
  server.statusBranch[REPO1] = "branch-of-P1";
  server.statusBranch[REPO2] = "branch-of-P2";
  server.hold.add("git:status");

  let path = P2;
  __mount(() => ProjectBranchIndicator({ projectPath: path, projectName: path }));
  await __flush();

  path = P1;
  __render();
  await __flush();

  release("git:status", (i) => i.repoPath === REPO1); // 新的(P1)先回
  await __flush();
  release("git:status", (i) => i.repoPath === REPO2); // 旧的(P2)后回
  await __flush();
  check("★ 反向:迟到的 P2 回包不许盖掉 P1 的分支", shown().includes("branch-of-P1") && !shown().includes("branch-of-P2"), shown());
}

// ── [3] WorktreeMergeBack:同一个同类竞态(切工作树后旧回包盖新的"有没有活"判定) ──
//
// `WorktreeMergeToolbarButton` 也按 prop(worktreePath/repoPath)换树,refresh 拉的
// `git.worktreeStatus` 在飞时切到另一棵树,旧回包会把新的判定盖掉 —— 结果是要么该出现的
// 「并回」按钮不出现、要么出现在没有活的树上。
/** 顶栏那颗「并回」按钮在不在树里 —— 按它的 title(渲染出来的 zh 文案)认。 */
function mergeButton(): boolean {
  return __nodes().some(
    (n) =>
      n.type === "button" &&
      typeof n.props.title === "string" &&
      n.props.title.includes("合并回"),
  );
}

function setWorktreeSession(wt: string): void {
  useSessionStore.setState({
    projects: [{ id: "p1", name: "p1", path: "/w/p1", archived: false, pinnedAt: null, sortOrder: 0, createdAt: 1, updatedAt: 1 } as never],
    activeProjectId: "p1",
    activeSessionId: "s1",
    sessionsByProject: { p1: [{ id: "s1", title: "s", kind: "chat", projectId: "p1", worktreePath: wt, archived: false, status: "idle" } as never] },
    pinnedSessions: [],
    sessions: [],
  } as never);
}

async function worktreeScenario(): Promise<void> {
  resetApi();
  server.hold.add("git:worktreeStatus");
  server.worktreeDirty["/wt/A"] = false; // A 没有活
  server.worktreeDirty["/wt/B"] = true; // B 有活 → 应出现「并回」按钮
  setWorktreeSession("/wt/A");
  __mount(() => WorktreeMergeToolbarButton());
  await __flush();
  check("A 的 worktreeStatus 在飞(被扣住)", server.held.some((h) => h.input.worktreePath === "/wt/A"), server.held.map((h) => h.input));

  // 切到 B(同一个组件实例换 prop)。
  setWorktreeSession("/wt/B");
  __render();
  await __flush();
  check("切到 B 后发出的是 B 的 worktreeStatus", server.held.some((h) => h.input.worktreePath === "/wt/B"), server.held.map((h) => h.input));

  // B(有活)先回 → 按钮应出现。
  release("git:worktreeStatus", (i) => i.worktreePath === "/wt/B");
  await __flush();
  check("B 有活 → 「并回」按钮出现", mergeButton(), __nodes().filter((n)=>n.type==="button").map((n)=>n.props.title));

  // A(没活)迟到 → 不许把 B 的按钮弄没。
  release("git:worktreeStatus", (i) => i.worktreePath === "/wt/A");
  await __flush();
  check("★ 迟到的 A(没活)回包不许弄没 B 的「并回」按钮", mergeButton(), __text());
}

// ── [4] WorktreeManagerPanel:同一类"两次 load 重叠"竞态 ──
//
// 一次 git 变更(合并回/提交/删除工作树)会 bump `gitChangeVersion` 触发重跑,而删除后的
// `onRemoved` 也直接调 `load` —— 两次 `worktreeList` 同时在飞、且**输入相同**时,先发起的
// 那次若后回来,会把新列表用旧数据盖掉(删除过的树又冒出来 / 刚建的不见)。
const WREPO = "/w/repo";
/** 稳定引用 —— 真实场景里 repos 来自 GitPanel 的 state,不是每次渲染新建的数组
 *  (否则 `load` 的 useCallback 依赖每次变 → effect 每渲染都重跑,不是我们要验的重叠)。 */
const WREPOS = [{ path: WREPO, name: "repo", isRepo: true }];

/** 面板把 `entries` 喂给每个 `WorktreeManagerRow` —— 行是子组件,fakeReact 不调用它,
 *  所以读**它 props 里的 info.path**(而不是渲染后的文本)。 */
function listedWorktreePaths(): string[] {
  return __nodes()
    .map((n) => (n.props.info as { path?: string } | undefined)?.path)
    .filter((p): p is string => typeof p === "string");
}

function wtRow(path: string, dirty: boolean): Record<string, unknown> {
  return { path, head: "abc1234", branch: "mcode/x", main: false, dirty, missing: false, referencedBy: 1, merged: false };
}

async function worktreeManagerScenario(): Promise<void> {
  resetApi();
  server.hold.add("git:worktreeList");
  server.worktreeLists[WREPO] = [wtRow("/wt/t1", true), wtRow("/wt/t2", true)];

  __mount(() => WorktreeManagerPanel({ repos: WREPOS as never }));
  await __flush();
  check("第一次 worktreeList 在飞(被扣住)", server.held.some((h) => h.input.repoPath === WREPO), server.held.map((h) => h.input));

  // 触发第二次 load —— 输入**相同**(同一个 repo),只有发起先后不同。
  // 用 store 的 gitChangeVersion 变化驱动(GitPanel 里也是这么触发的)。
  server.worktreeLists[WREPO] = [wtRow("/wt/t2", true)]; // 新数据:t1 已被删掉
  useSessionStore.setState({ gitChangeVersionByRepo: { [WREPO]: 1 } } as never);
  __render();
  await __flush();
  check("第二次 worktreeList 发出(两次重叠)", server.held.filter((h) => h.input.repoPath === WREPO).length >= 2, server.held.map((h) => h.input));

  // ★ 新的(第二次)先回 → 列表只有 t2。
  releaseLast("git:worktreeList", (i) => i.repoPath === WREPO); // 最后一条 = 第二次发起 = 最新
  await __flush();
  check("新列表先回 → 只剩 t2", listedWorktreePaths().includes("/wt/t2") && !listedWorktreePaths().includes("/wt/t1"), { paths: listedWorktreePaths(), titles: __nodes().filter((n)=>n.props.title!==undefined).map((n)=>n.props.title) });

  // ★★ 旧的(第一次,含 t1 t2)迟到 → 不许把 t1 弄回来。
  release("git:worktreeList", (i) => i.repoPath === WREPO);
  await __flush();
  check("★ 迟到的旧列表回包不许把已删的 t1 弄回来", !listedWorktreePaths().includes("/wt/t1"), listedWorktreePaths());
}

await scenario();
await reverseScenario();
await worktreeScenario();
await worktreeManagerScenario();

console.log(`\nproject-branch-race-smoke:${checks - failures}/${checks} 通过`);
if (failures > 0) process.exitCode = 1;
// WorktreeMergeToolbarButton 起了 12s 轮询的 setInterval —— 无头跑真组件时得显式收尾,
// 否则 node 不退出(这套是"无头驱动真组件"的代价,别的套件没这问题)。
process.exit(failures > 0 ? 1 : 0);
