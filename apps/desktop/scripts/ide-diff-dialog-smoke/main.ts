/**
 * ide-diff-dialog-smoke — `GitDiffDialog` 左侧栏的**状态回包竞态**。
 *
 * ## 盯的是什么
 *
 * 这个对话框的左栏镜像"当前活动 tab 所属仓库"的 已暂存 / 更改 列表。切 tab 时会去要
 * 新仓库的 `git.status`(`refreshStatus`)。
 *
 * 仓库里同类加载都补过请求序号守卫(**GitPanel 的 `scanSeqRef`、GitHistoryView 的
 * `commitsSeqRef`** —— 见 `docs/底层修复记录-2026-10-07.md` #38),**唯独这里没有**:
 * 切到 B 仓(B 慢)→ 再切回/切到 A 仓(A 快)→ B 的慢回包后到,会把 **B 的文件列表
 * 盖到 A 仓库那一栏**。用户看着 A 的 tab,左栏却列着 B 的文件,点进去是错的 diff。
 *
 * 判据立在"左栏那份文件列表是哪个仓库的"。
 *
 * ## 它怎么跑
 *
 * esbuild 换 `react` 为 maint-m32-smoke 那套极小 hooks 运行时(组件源码原样跑);
 * 重量级子件(`./FileEditor.js` 的 DiffPane、monacoSetup)换成空壳;api 换成可扣回包的
 * 内存桩。不起浏览器、不连 git、不写盘。
 *
 * Run: scripts/ide-diff-dialog-smoke/run.sh
 */
import "./prelude.js";
import { gitHooks, mkPatch, mkStatus, mkStatusMulti, resetHooks } from "./api-stub.js";
import { __mount, __flush, __nodes } from "./fakeReact.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { GitDiffDialog } from "@renderer/components/ide/GitDiffDialog.js";
import type { GitFileStatus, GitStatusResult } from "@contracts/ipc";

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

const REPO_A = "/w/proj/repoA";
const REPO_B = "/w/proj/repoB";

type El = { type: unknown; props: Record<string, unknown> };

/** 左栏文件条目:GitDiffDialog 里的 SidebarFileGroup 是子组件(不被调用),但它的
 *  props 带着 `files` —— 那正是"左栏现在列出谁的文件"。 */
function sidebarFiles(): string {
  const groups = __nodes().filter((n) => Array.isArray((n.props as { files?: unknown }).files));
  return groups
    .flatMap((g) => (g.props.files as Array<{ path: string }>).map((f) => f.path))
    .join(",");
}

async function scenario() {
  resetHooks();
  // A 仓的 status 挂起(慢),B 仓立即回(快)。这就是乱序:先切到 A,再切到 B。
  const heldA = deferred<{ status: GitStatusResult }>();
  gitHooks.status = async (input: { repoPath: string }) => {
    if (input.repoPath === REPO_A) return heldA.promise;
    return { status: mkStatus("b-branch", "B-only.ts") };
  };

  // 两个 tab:A 仓的文件在前、B 仓在后。活动 tab 初始为 null(取第一个 = A)。
  useSessionStore.setState({
    locale: "zh",
    gitDiffDialogOpen: true,
    gitDiffDialogTabs: [
      { id: `${REPO_A}/a.ts::work`, filePath: `${REPO_A}/a.ts`, before: "a", title: "a.ts", repoPath: REPO_A, source: "working", staged: false },
      { id: `${REPO_B}/b.ts::work`, filePath: `${REPO_B}/b.ts`, before: "b", title: "b.ts", repoPath: REPO_B, source: "working", staged: false },
    ],
    gitDiffDialogActiveId: null,
    gitDiffDialogViewMode: "single",
  });
  __mount(() => GitDiffDialog());
  await __flush();

  // 让活动 tab 是 A(它的 status 会挂住),再切到 B(B 快、先回)。
  const setActive = useSessionStore.getState().setGitDiffDialogActive;
  setActive(`${REPO_A}/a.ts::work`);
  await __flush();
  setActive(`${REPO_B}/b.ts::work`);
  await __flush();
  check("B 仓的文件先落地", sidebarFiles() === "B-only.ts", sidebarFiles());

  // A 的慢回包此刻才到 —— 它就是那条"旧回包"。
  heldA.resolve({ status: mkStatus("a-branch", "A-only.ts") });
  await __flush();

  check("★ 迟到的 A 仓 status 没有盖掉 B", sidebarFiles() === "B-only.ts", sidebarFiles());
  check("★ 左栏列的是 B 仓的文件", sidebarFiles().includes("B-only") && !sidebarFiles().includes("A-only"), sidebarFiles());
}

/**
 * 左栏**点文件打开 diff** 的回包竞态(与 GitHistoryView 的 `openFile` 同一类)。
 *
 * `openWorkingFile` 从前没有请求序号守卫:它 `await api.git.diff(...)` 之后直接
 * `openGitDiffDialogTab`(开 tab + 设活动 tab)。于是"点文件 A(A 慢,在飞)→ 点文件
 * B(B 快,先回)→ A 后到"这一序,会让 **A 开了自己的 tab 并把活动 tab 抢走** —— 用户
 * 明明点了 B,左侧高亮/右侧内容却跳去 A。判据立在"现在活动的那个 tab 是谁的"。
 */
async function openWorkingFileRaceScenario() {
  resetHooks();
  const REPO = "/w/proj/repoC";
  // 左栏列出两个文件 A、B。
  gitHooks.status = async () => ({ status: mkStatusMulti("main", ["AA.ts", "BB.ts"]) });
  // diff:A 挂起(慢),B 立即回(快)。
  const heldA = deferred<{ patch: string }>();
  gitHooks.diff = async (input: { filePath: string }) => {
    if (input.filePath.endsWith("AA.ts")) return heldA.promise;
    return { patch: mkPatch("B") };
  };

  useSessionStore.setState({
    locale: "zh",
    gitDiffDialogOpen: true,
    gitDiffDialogTabs: [],
    gitDiffDialogActiveId: null,
    gitDiffDialogViewMode: "single",
    widePanelOpen: false,
  });
  // 一张只含本仓的 tab,让 sidebarRepoPath(活动 tab 的 repo)指向 REPO。
  useSessionStore.getState().openGitDiffDialogTab({
    id: `${REPO}/seed.ts::work`,
    filePath: `${REPO}/seed.ts`,
    before: "",
    title: "seed.ts",
    repoPath: REPO,
    source: "working",
    staged: false,
  });
  __mount(() => GitDiffDialog());
  await __flush();

  // 左栏分组(`SidebarFileGroup` 是子组件,不被调用,但它的 props 带 `files` 与
  // `onSelect` —— `onSelect` 就是用户点那一行文件时走的函数,接收该文件的 GitFileStatus)。
  const groupOnSelect = (): ((f: GitFileStatus) => void) => {
    const g = __nodes().find(
      (x) =>
        typeof (x.props as { onSelect?: unknown }).onSelect === "function" &&
        Array.isArray((x.props as { files?: unknown }).files),
    );
    if (!g) throw new Error("找不到左栏文件分组");
    return g.props.onSelect as (f: GitFileStatus) => void;
  };
  const fileOf = (name: string): GitFileStatus => {
    const g = __nodes().find((x) => Array.isArray((x.props as { files?: unknown }).files))!;
    const f = (g.props.files as GitFileStatus[]).find((x) => x.path.endsWith(name));
    if (!f) throw new Error(`找不到左栏文件:${name}`);
    return f;
  };

  // 点 A(慢,先不回来)…紧接着点 B(B 快,先回)。
  groupOnSelect()(fileOf("AA.ts"));
  await __flush();
  groupOnSelect()(fileOf("BB.ts"));
  await __flush();

  const activeTab = () => {
    const s = useSessionStore.getState();
    return s.gitDiffDialogTabs.find((t) => t.id === s.gitDiffDialogActiveId);
  };
  check("B 的文件差异先落地(正控)", activeTab()?.filePath.endsWith("BB.ts") === true, activeTab()?.filePath);

  // A 的慢回包此刻才到 —— 它就是那条"旧回包"。
  heldA.resolve({ patch: mkPatch("A") });
  await __flush();

  check("★ 迟到的 A 文件打开没有抢走活动 tab", activeTab()?.filePath.endsWith("BB.ts") === true, activeTab()?.filePath);
  check(
    "★ A 的过期打开没有凭空多开一个 tab",
    !useSessionStore.getState().gitDiffDialogTabs.some((t) => t.filePath.endsWith("AA.ts")),
    useSessionStore.getState().gitDiffDialogTabs.map((t) => t.filePath),
  );
}

await scenario();
await openWorkingFileRaceScenario();

console.log(`\nide-diff-dialog-smoke:${checks - failures}/${checks} 通过`);
if (failures > 0) process.exitCode = 1;
