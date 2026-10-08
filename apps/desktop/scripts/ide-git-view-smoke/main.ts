/**
 * ide-git-view-smoke — GitHistoryView 的**提交详情回包竞态**。
 *
 * ## 盯的是什么
 *
 * `GitHistoryView` 的**列表加载**(`loadCommits`)有请求序号守卫 —— 文件里那条长注释
 * 写着"在 A 仓点加载更多(在飞)→ 切到 B 仓"必须"新的赢"。
 *
 * 但**详情加载**(`openCommit`)没有这条守卫:它在 await 之前先 `setSelected` +
 * `setDetailLoading`,拿到回包后再 `setSelected(detail.commit)` + `setFiles`。
 * 于是"点提交 A(A 慢)→ 点提交 B(B 快)→ A 后到"这一序,会让 **A 的详情把 B 的盖掉**:
 * 用户明明点了 B,看到的却是 A 的文件列表。
 *
 * 判据立在"用户看到的那份文件列表是谁的"。
 *
 * ## 它怎么跑
 *
 * 用 esbuild `--alias:react=` 换成 `maint-m32-smoke` 那套极小 hooks 运行时(组件源码
 * 原样跑),`@renderer/lib/api.js` 换成可扣回包的桩。不起浏览器、不连 git、不写盘。
 *
 * Run: scripts/ide-git-view-smoke/run.sh
 */
import "./prelude.js";
import { gitHooks, resetHooks } from "./api-stub.js";
import { __mount, __flush, __nodes, __text } from "./fakeReact.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { GitHistoryView } from "@renderer/components/ide/GitHistoryView.js";
import type { GitRepo, GitCommitInfo, GitCommitFile } from "@contracts/ipc";

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

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function commit(hash: string, subject: string): GitCommitInfo {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    subject,
    author: "s",
    authoredAt: "2026-01-01T00:00:00Z",
    parents: [],
  };
}
function file(path: string): GitCommitFile {
  return { path, status: "modified", additions: 1, deletions: 0 };
}

/** 找一行提交(树里那个直接渲染的 button 就是 CommitRow 的 onClick 载体)。 */
function commitRows(): Array<{ props: Record<string, unknown> }> {
  // CommitRow 是子组件:fakeReact 不调用子组件,树里留的是 `{type: CommitRow, props}`。
  // 它的 props 带 commit + onClick。
  return __nodes().filter(
    (n) => n.props && typeof n.props.onClick === "function" && (n.props as { commit?: unknown }).commit,
  );
}

/** CommitDetail 也是子组件(不被调用),但它的 props 里带着**这一屏真正显示什么** ——
 *  即 `files` / `commit` / `loading`。这就是"用户看到的那份文件列表是谁的"的判据。 */
function detail(): { commit: GitCommitInfo; files: GitCommitFile[]; loading: boolean } | undefined {
  const n = __nodes().find((x) => (x.props as { files?: unknown }).files !== undefined && (x.props as { commit?: unknown }).commit);
  return n?.props as { commit: GitCommitInfo; files: GitCommitFile[]; loading: boolean } | undefined;
}

function fileNames(): string {
  return (detail()?.files ?? []).map((f) => f.path).join(",");
}

const REPO: GitRepo = { path: "/w/proj/repo", name: "repo", isRepo: true };

async function scenario() {
  resetHooks();
  // 列表:两条提交 A、B。
  gitHooks.log = async () => ({
    commits: [commit("aaaaaaa1aaaaaaa1", "commit A"), commit("bbbbbbb2bbbbbbb2", "commit B")],
    hasMore: false,
  });

  // 详情:A 挂起(慢),B 立即回(快)。
  const heldA = deferred<{ commit: GitCommitInfo; files: GitCommitFile[] }>();
  gitHooks.showCommit = async (input: { commitHash: string }) => {
    if (input.commitHash.startsWith("aaaa")) return heldA.promise;
    return { commit: commit(input.commitHash, "commit B"), files: [file("B-only.ts")] };
  };

  useSessionStore.setState({ locale: "zh" });
  __mount(() => GitHistoryView({ repos: [REPO] }));
  await __flush();

  const rows = commitRows();
  check("列表渲染出两条提交", rows.length === 2, rows.map((r) => (r.props.commit as GitCommitInfo).subject));

  const rowA = rows.find((r) => (r.props.commit as GitCommitInfo).subject === "commit A")!;
  const rowB = rows.find((r) => (r.props.commit as GitCommitInfo).subject === "commit B")!;

  // 用户点 A(慢,先不回来)…
  (rowA.props.onClick as () => void)();
  await __flush();
  // …紧接着点 B(B 快,先回)。
  (rowB.props.onClick as () => void)();
  await __flush();
  check("B 的详情先落地", fileNames() === "B-only.ts", fileNames());

  // A 的慢回包此刻才到 —— 它就是那条"旧回包"。
  heldA.resolve({ commit: commit("aaaaaaa1aaaaaaa1", "commit A"), files: [file("A-only.ts")] });
  await __flush();

  check("★ 迟到的 A 详情没有盖掉 B", fileNames() === "B-only.ts", fileNames());
  check("★ 屏幕上是 B 的文件", detail()?.commit.subject === "commit B", detail()?.commit.subject);
}

await scenario();

console.log(`\nide-git-view-smoke:${checks - failures}/${checks} 通过`);
if (failures > 0) process.exitCode = 1;
