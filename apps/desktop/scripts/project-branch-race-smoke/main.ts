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
import { __mount, __render, __flush, __text } from "./fakeReact.js";
import { server, resetApi, release } from "./api-stub.js";
import { ProjectBranchIndicator } from "@renderer/components/chat/ProjectBranchIndicator.js";

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

await scenario();
await reverseScenario();

console.log(`\nproject-branch-race-smoke:${checks - failures}/${checks} 通过`);
if (failures > 0) process.exitCode = 1;
