/**
 * maint-m32-smoke — 手机端 Git 面板的**旧回包回写**(MAINT-M32 检修项:
 * "切项目 / 切会话后旧请求回写")。
 *
 * Run: scripts/maint-m32-smoke/run.sh
 *
 * 手机走 LAN / 蜂窝,`git:discoverRepos`(要遍历目录)和 `git:status`(要起
 * simple-git)动辄几百毫秒,**回包乱序是常态**,不是边角。这套把两种切换各扣一次:
 *
 *   [1] 切仓库:status(A) 在飞 → 用户在下拉里选了 B → status(B) 先回、status(A) 后回。
 *   [2] 切项目:discoverRepos(P1) 在飞 → 用户切到 P2 → P2 先回、P1 后回。
 *
 * 两种都必须"**新的赢**"。反过来就是一个能让人误操作的状态:文件列表是旧仓库的,
 * 而"暂存 / 提交"按钮打的是 `repoPath`(新仓库)—— 点下去是往另一个仓库发路径。
 */
import { server, callsOf, release } from "./prelude.js";

/** 把某个方法下所有满足条件的挂起回包都放了。 */
function releaseAll(method: string, match: (input: Record<string, unknown>) => boolean): void {
  while (release(method, match)) {
    /* drain */
  }
}
import {
  __mount,
  __flush,
  __nodes,
  __text,
} from "./fakeReact.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { MobileGitScreen } from "@renderer/components/mobile/MobileGitScreen.js";
import { parsePatch } from "@renderer/components/mobile/PatchView.js";
import type { GitRepo, GitStatusResult } from "@contracts/ipc";
import type { Project } from "@contracts/session";

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

function mkProject(id: string): Project {
  return {
    id,
    name: id,
    path: `/w/${id}`,
    archived: false,
    pinnedAt: null,
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
  } as Project;
}

function mkRepo(path: string, name: string): GitRepo {
  return { path, name, isRepo: true };
}

function mkStatus(branch: string, file: string): GitStatusResult {
  return {
    branch,
    ahead: 0,
    behind: 0,
    files: [{ path: file, index: "unmodified", workingTree: "modified" }],
  };
}

/** 下拉里的仓库选择器(repos.length > 1 时才在)。 */
function repoSelect(): { props: Record<string, unknown> } | undefined {
  return __nodes().find((n) => n.type === "select");
}

function reset(): void {
  server.calls.length = 0;
  server.held.length = 0;
  server.hold.clear();
  server.repos = {};
  server.status = {};
}

// ── 1. 切仓库:旧仓库的 status 后到,不许盖掉新仓库 ───────────────────────
console.log("\n[1] 切仓库:status(旧) 后到");
{
  reset();
  const p1 = mkProject("p1");
  server.projects = [p1];
  server.repos["/w/p1"] = [mkRepo("/w/p1/a", "a"), mkRepo("/w/p1/b", "b")];
  server.status["/w/p1/a"] = mkStatus("branch-A", "only-in-a.ts");
  server.status["/w/p1/b"] = mkStatus("branch-B", "only-in-b.ts");
  useSessionStore.setState({ projects: [p1], activeProjectId: "p1" });

  server.hold.add("git:status");
  __mount(() => MobileGitScreen());
  await __flush();

  check("发现仓库后自动选了第一个,并去要它的状态", callsOf("git:status").some((i) => i.repoPath === "/w/p1/a"));

  const sel = repoSelect();
  check("两个仓库时渲染出了仓库下拉", !!sel, __text().slice(0, 120));
  // 用户在下拉里选了 b —— 调的是组件真的那个 onChange。
  (sel?.props.onChange as (e: unknown) => void)({ target: { value: "/w/p1/b" } });
  await __flush();
  check("切过去后要了 b 的状态", callsOf("git:status").some((i) => i.repoPath === "/w/p1/b"));

  // 弱网:新的先回,旧的后回。
  // 一次切换会发**两条** status(`[refresh]` 和 `[gitChangeVersion, refresh]`
  // 两个 effect 各一条),所以按仓库把挂着的全放了 —— 真机上它们也都会回来。
  releaseAll("git:status", (i) => i.repoPath === "/w/p1/b");
  await __flush();
  releaseAll("git:status", (i) => i.repoPath === "/w/p1/a");
  await __flush();

  const text = __text();
  check("显示的是新仓库的分支", text.includes("branch-B"), text.slice(0, 200));
  check("旧仓库的分支没有回写上来", !text.includes("branch-A"), text.slice(0, 200));
  check("文件列表也是新仓库的", text.includes("only-in-b.ts") && !text.includes("only-in-a.ts"), text.slice(0, 300));
}

// ── 2. 切项目:旧项目的 discoverRepos 后到 ────────────────────────────────
console.log("\n[2] 切项目:discoverRepos(旧) 后到");
{
  reset();
  const p1 = mkProject("p1");
  const p2 = mkProject("p2");
  server.projects = [p1, p2];
  server.repos["/w/p1"] = [mkRepo("/w/p1/a", "a")];
  server.repos["/w/p2"] = [mkRepo("/w/p2/z", "z")];
  server.status["/w/p1/a"] = mkStatus("branch-P1", "p1-file.ts");
  server.status["/w/p2/z"] = mkStatus("branch-P2", "p2-file.ts");
  useSessionStore.setState({ projects: [p1, p2], activeProjectId: "p1" });

  server.hold.add("git:discoverRepos");
  __mount(() => MobileGitScreen());
  await __flush();
  check("挂上就去发现 p1 的仓库", callsOf("git:discoverRepos").some((i) => i.projectPath === "/w/p1"));

  // 发现还没回来,用户就切了项目。
  useSessionStore.setState({ activeProjectId: "p2" });
  await __flush();
  check("切项目后去发现 p2 的仓库", callsOf("git:discoverRepos").some((i) => i.projectPath === "/w/p2"));

  releaseAll("git:discoverRepos", (i) => i.projectPath === "/w/p2");
  await __flush();
  releaseAll("git:discoverRepos", (i) => i.projectPath === "/w/p1");
  await __flush();

  const text = __text();
  check("显示的是新项目的仓库分支", text.includes("branch-P2"), text.slice(0, 200));
  check("旧项目的仓库没有回写上来", !text.includes("branch-P1"), text.slice(0, 200));
  check(
    "没有为旧项目的仓库补发 status",
    !callsOf("git:status").some((i) => i.repoPath === "/w/p1/a"),
    callsOf("git:status"),
  );
}

// ── 3. PatchView:git diff 结尾的换行标记不能变成幽灵上下文行 ──────────────
// `git diff` 输出**总是以 `\n` 结尾**(那是 diff 那一行自身的终止符,不是被改文件
// 的内容)。旧 `parsePatch` 直接 `patch.split("\n")`,那记尾随换行就成了一个空串,
// 落进 `line === ""` 分支 —— 被当成"空格被传输剥掉的上下文行",于是每份 diff 底部
// 都多画一行空行,行号还比文件实际多 1。真·空上下文行在 git 输出里是 `" "`(一个
// 空格),不是 `""`。这条把两种情形一起钉死。
console.log("\n[3] PatchView:尾随换行不留幽灵行,内部空行仍算上下文");
{
  const patch =
    "diff --git a/f.txt b/f.txt\n" +
    "index 111..222 100644\n" +
    "--- a/f.txt\n" +
    "+++ b/f.txt\n" +
    "@@ -1,3 +1,3 @@\n" +
    " a\n" +        // 真实上下文行
    " \n" +          // 文件里的空行(git 前缀一个空格)
    "-b\n" +
    "+B\n";          // 尾随换行标记
  const rows = parsePatch(patch);
  const last = rows[rows.length - 1];
  check(
    "diff 尾随换行不产生幽灵上下文行",
    !(last.kind === "ctx" && last.text === "" && last.oldNo === 4),
    rows,
  );
  check(
    "文件里真正的空行仍按上下文行渲染",
    rows.some((r) => r.kind === "ctx" && r.text === "" && r.oldNo === 2 && r.newNo === 2),
    rows,
  );
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${checks - failures}/${checks}`);
process.exit(failures === 0 ? 0 : 1);