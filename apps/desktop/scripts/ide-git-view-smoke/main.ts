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

/**
 * `openFile` 的**文件 blob 回包竞态**。
 *
 * `loadCommits` 有 `commitsSeqRef`、`openCommit` 有 `detailSeqRef`(见上),而
 * `openFile` 从前**没有** —— 它 await `git.showFile` 之后直接写 store(开浮窗 tab /
 * 塞 diff pair)。于是"点文件 A(A 慢)→ 点文件 B(B 快)→ A 后到"这一序,会让 **A 的
 * 差异把 B 的盖掉**:用户明明点了 B,屏幕上却是 A 的内容。
 *
 * 判据立在"浮窗里那份差异是谁的"(活动 tab 的 id 与它的 before 内容)。
 */
async function openFileRaceScenario() {
  resetHooks();
  gitHooks.log = async () => ({
    commits: [commit("ccccccc1ccccccc1", "only commit")],
    hasMore: false,
  });
  // 详情:一条提交、两个文件 A、B。
  gitHooks.showCommit = async () => ({
    commit: commit("ccccccc1ccccccc1", "only commit"),
    files: [file("A-only.ts"), file("B-only.ts")],
  });
  // showFile:A 挂起(慢),B 立即回(快)。
  const heldA = deferred<{ before: string; after: string }>();
  gitHooks.showFile = async (input: { filePath: string }) => {
    if (input.filePath.endsWith("A-only.ts")) return heldA.promise;
    return { before: "B-before", after: "B-after" };
  };

  // dialog 打开模式:openFile 走 `openGitDiffDialogTab`(纯 store 写,不碰 Monaco/盘)。
  useSessionStore.setState({
    locale: "zh",
    gitDiffOpenMode: "dialog",
    gitDiffDialogTabs: [],
    gitDiffDialogActiveId: null,
    gitDiffDialogOpen: false,
    gitChangeVersionByRepo: {},
  });
  __mount(() => GitHistoryView({ repos: [REPO] }));
  await __flush();

  // 点唯一那条提交 → 详情(两个文件)落地。
  (commitRows()[0]!.props.onClick as () => void)();
  await __flush();

  // 详情落地后取 `openFile` 闭包(CommitDetail 是子组件、不被调用,但它的 props
  // 带着 `onOpenFile` —— 就是用户点某一行文件时走的那个函数)。
  const onOpenFile = __nodes().find(
    (x) => (x.props as { files?: unknown }).files !== undefined && (x.props as { commit?: unknown }).commit,
  )!.props.onOpenFile as (f: GitCommitFile) => void;

  // 点文件 A(慢,先不回来)…
  onOpenFile(file("A-only.ts"));
  await __flush();
  // …紧接着点文件 B(B 快,先回)。
  onOpenFile(file("B-only.ts"));
  await __flush();

  const activeTab = () => {
    const s = useSessionStore.getState();
    return s.gitDiffDialogTabs.find((t) => t.id === s.gitDiffDialogActiveId);
  };
  check("B 的文件差异先落地(正控)", activeTab()?.before === "B-before", activeTab()?.before);

  // A 的慢回包此刻才到 —— 它就是那条"旧回包"。
  heldA.resolve({ before: "A-before", after: "A-after" });
  await __flush();

  check("★ 迟到的 A 文件差异没有盖掉 B", activeTab()?.before === "B-before", activeTab()?.before);
  check(
    "★ 屏幕上是 B 的差异(before+after 都是 B)",
    activeTab()?.before === "B-before" && activeTab()?.after === "B-after",
    activeTab(),
  );
}

/**
 * **切提交会让在飞的文件打开作废**。
 *
 * 只看 `openFile` 自己的序号还不够:用户点开提交 A 的某个文件(慢,在飞)→ 不等它回来
 * 就点开**提交 B**(看 B 的文件列表)→ A 的文件 blob 这时才到 —— 旧提交的文件差异会
 * 凭空弹进对话框/编辑器,而用户此刻看的是 B。`openCommit` 里那一次 `fileSeqRef.current++`
 * 就是让这种"换上下文"把在飞的旧打开作废。
 *
 * 判据立在"对话框里有没有凭空多出一份旧提交文件的差异"。
 */
async function commitSwitchCancelsInFlightScenario() {
  resetHooks();
  gitHooks.log = async () => ({
    commits: [commit("aaaaaaa1aaaaaaa1", "commit A"), commit("bbbbbbb2bbbbbbb2", "commit B")],
    hasMore: false,
  });
  gitHooks.showCommit = async (input: { commitHash: string }) =>
    input.commitHash.startsWith("aaaa")
      ? { commit: commit(input.commitHash, "commit A"), files: [file("A-only.ts")] }
      : { commit: commit(input.commitHash, "commit B"), files: [file("B-only.ts")] };
  // A 的文件 blob 挂起(慢);B 的立即回。
  const heldAFile = deferred<{ before: string; after: string }>();
  gitHooks.showFile = async (input: { filePath: string }) => {
    if (input.filePath.endsWith("A-only.ts")) return heldAFile.promise;
    return { before: "B-before", after: "B-after" };
  };

  useSessionStore.setState({
    locale: "zh",
    gitDiffOpenMode: "dialog",
    gitDiffDialogTabs: [],
    gitDiffDialogActiveId: null,
    gitDiffDialogOpen: false,
    gitChangeVersionByRepo: {},
  });
  __mount(() => GitHistoryView({ repos: [REPO] }));
  await __flush();

  const rows = commitRows();
  const rowA = rows.find((r) => (r.props.commit as GitCommitInfo).subject === "commit A")!;
  const rowB = rows.find((r) => (r.props.commit as GitCommitInfo).subject === "commit B")!;

  // 打开提交 A 的详情 → 点它的文件(慢,在飞)。
  (rowA.props.onClick as () => void)();
  await __flush();
  const openFromDetail = (): ((f: GitCommitFile) => void) =>
    __nodes().find(
      (x) => (x.props as { files?: unknown }).files !== undefined && (x.props as { commit?: unknown }).commit,
    )!.props.onOpenFile as (f: GitCommitFile) => void;
  openFromDetail()(file("A-only.ts"));
  await __flush();

  // 不等它回来,直接切到提交 B。
  (rowB.props.onClick as () => void)();
  await __flush();
  check("已切到提交 B 的详情", detail()?.commit.subject === "commit B", detail()?.commit.subject);

  // A 的文件 blob 此刻才到 —— 它属于**已经不看的**提交 A。
  heldAFile.resolve({ before: "A-before", after: "A-after" });
  await __flush();

  const tabs = useSessionStore.getState().gitDiffDialogTabs.map((t) => t.id);
  check("★ 切提交后,旧提交文件的差异没有凭空弹出", !tabs.some((id) => id.endsWith("A-only.ts")), tabs);
}

await scenario();
await openFileRaceScenario();
await commitSwitchCancelsInFlightScenario();

console.log(`\nide-git-view-smoke:${checks - failures}/${checks} 通过`);
if (failures > 0) process.exitCode = 1;
