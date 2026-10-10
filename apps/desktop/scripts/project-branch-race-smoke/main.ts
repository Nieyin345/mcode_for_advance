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
import { WorktreeMergeToolbarButton, WorktreeRemoveDialog, WorktreeMergeBackDialog } from "@renderer/components/chat/WorktreeMergeBack.js";
import { WorktreeManagerPanel } from "@renderer/components/ide/WorktreeManagerPanel.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";

// fakeReact 不调用子组件,`<Button>`(ui-stub 里是 Pass)停在 `{type, props}` 这一层 ——
// 它的 `onClick` 就在 props 上,children 里是图标元素 + 文案节点。按**文本 + onClick**
// 找按钮(不认 type:"button",因为 Button 不是原生 <button>)。
function findClickable(label: string): { props: Record<string, unknown> } | undefined {
  return __nodes().find(
    (n) => typeof n.props.onClick === "function" && nodeText(n as never).includes(label),
  ) as { props: Record<string, unknown> } | undefined;
}

function nodeText(n: { props: Record<string, unknown> }): string {
  const parts: string[] = [];
  const walk = (c: unknown): void => {
    if (c === null || c === undefined || c === true || c === false) return;
    if (typeof c === "string" || typeof c === "number") return void parts.push(String(c));
    if (Array.isArray(c)) return void c.forEach(walk);
    if (typeof c === "object") walk((c as { props?: { children?: unknown } }).props?.children);
  };
  walk(n.props.children);
  return parts.join("");
}

// 渲染端没有全局 unhandledrejection 监听 —— 这里挂一个,**只用来观测**"失败是不是
// 只落进了未处理的 rejection"(那正是这个缺陷的症状),不吞掉它。
const unhandled: unknown[] = [];
process.on("unhandledRejection", (r) => { unhandled.push(r); });

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

// ── [5] WorktreeRemoveDialog:IPC 真 reject 时的静默失败 ──
//
// `handleRemove` 从前只有 `try/finally`:IPC reject(参数不过校验 / 传输断)时异常穿过
// `onClick={() => void handleRemove()}` 变成未处理的 rejection —— 渲染端没有全局监听,
// 对话框既不关也不报错,用户看到的是"点了删除,没反应"。孪生 `WorktreeManagerPanel.
// handleRemove` 早已补上 catch(注释逐字写着这件事),这两处漏了。
//
// 判据立在**用户看到的那条错误**上:reject 后对话框里必须画出错误文案,且不冒出未处理的
// rejection。`removeWorktree` 内部把 git/fs 失败收成 `{ok:false}`;这里测的是它**真抛**
// 的那一类(传输断),所以强制 `git:worktreeRemove` reject。
async function worktreeReplaceDialogRejectScenario(): Promise<void> {
  resetApi();
  server.overrides["git:worktreeStatus"] = { status: { dirty: false, merged: true } };
  server.reject.add("git:worktreeRemove");
  unhandled.length = 0;

  let open = true;
  __mount(() =>
    WorktreeRemoveDialog({
      open,
      onOpenChange: (o: boolean) => { open = o; },
      repoPath: "/w/repo",
      worktreePath: "/wt/t1",
      onRemoved: () => {},
    }) as never,
  );
  await __flush();

  const removeBtn = findClickable("删除工作树");
  check("★ 删除工作树按钮渲染出来了", !!removeBtn, __nodes().filter((n) => typeof n.props.onClick === "function").map((n) => nodeText(n as never)));
  (removeBtn?.props.onClick as (() => void))?.();
  await __flush();

  const shown = __text();
  check("★ IPC reject 后对话框里画出错误(不是「点了没反应」)", shown.includes(server.rejectMsg), shown);
  check("★ IPC reject 没有变成未处理的 rejection", unhandled.length === 0, unhandled.map((u) => String(u)));
  check("失败后对话框不关闭(留着重试)", open === true);
}

// ── [6] WorktreeMergeBackDialog.handleRemove:同一道孪生缺口 ──
//
// 合并完成后那颗"删除工作树"按钮走的是 MergeBackDialog 自己的 handleRemove —— 同样只有
// try/finally。判据同上。
async function worktreeMergeBackDialogRejectScenario(): Promise<void> {
  resetApi();
  // 先让 load 跑通:worktreeList 有这棵树、mergePreview 说"没有活"(upToDate)。
  server.overrides["git:worktreeList"] = {
    worktrees: [
      { path: "/w/repo", head: "main0", branch: "main", main: true, dirty: false, missing: false, referencedBy: 0, merged: true },
      { path: "/wt/t1", head: "abc1234", branch: "mcode/x", main: false, dirty: false, missing: false, referencedBy: 1, merged: false },
    ],
  };
  server.overrides["git:mergePreview"] = { ok: true, upToDate: false, fastForward: true, incomingCommits: 1 };
  server.reject.add("git:worktreeRemove");
  unhandled.length = 0;

  let open = true;
  __mount(() =>
    WorktreeMergeBackDialog({
      open,
      onOpenChange: (o: boolean) => { open = o; },
      sessionId: "s1",
      worktreePath: "/wt/t1",
      repoPath: "/w/repo",
    }) as never,
  );
  await __flush();

  // 先合并(默认回值 {} → res.ok 为假会走 setError;这里给个成功的覆盖)。
  server.overrides["git:worktreeMergeBack"] = { ok: true, targetBranch: "main", fastForward: true };
  const mergeBtn = findClickable("合并");
  check("★ 合并按钮可用并渲染", !!mergeBtn, __nodes().filter((n) => typeof n.props.onClick === "function").map((n) => nodeText(n as never)));
  (mergeBtn?.props.onClick as (() => void))?.();
  await __flush();

  // 合并成功 → 出现"删除工作树"。
  const removeBtn = findClickable("删除工作树");
  check("★ 合并完成后「删除工作树」按钮出现", !!removeBtn, __text());
  (removeBtn?.props.onClick as (() => void))?.();
  await __flush();

  const shown = __text();
  check("★ IPC reject 后合并对话框里画出错误", shown.includes(server.rejectMsg), shown);
  check("★ IPC reject 没有变成未处理的 rejection", unhandled.length === 0, unhandled.map((u) => String(u)));
}

// ── [7] WorktreeMergeBackDialog.load():切工作树后旧回包盖掉新的预览 ──
//
// 与 toolbar 的 `refresh`(#117)同一类:对话框是同一个实例、只换 prop(worktreePath)——
// 弱网下旧树的 `worktreeList` 回包会后到,把新树的 info/preview 盖掉,弹层显示的是**另一棵
// 树**的「将合入 N 个提交」。同文件里 `refresh` 已经加了 `changesSeqRef`(注释逐字写着
// "对话框是同一个实例、只换 prop"),`load` 漏了 —— 同一道闸两处实现只做了一处。
//
// 判据立在用户看到的那行字上:两棵树的 incoming 不同(1 vs 99),切到 B、放完所有回包后,
// 必须显示 B 的 99;迟到的 A 回包不许把它盖成 1。
async function worktreeDialogLoadRaceScenario(): Promise<void> {
  resetApi();
  const main = { path: "/w/repo", head: "main0", branch: "main", main: true, dirty: false, missing: false, referencedBy: 0, merged: true };
  const wtA = { path: "/wt/A", head: "aaaa", branch: "mcode/a", main: false, dirty: false, missing: false, referencedBy: 1, merged: false };
  const wtB = { path: "/wt/B", head: "bbbb", branch: "mcode/b", main: false, dirty: false, missing: false, referencedBy: 1, merged: false };
  server.mergePreviews["aaaa"] = { ok: true, upToDate: false, fastForward: true, incomingCommits: 1 };
  server.mergePreviews["bbbb"] = { ok: true, upToDate: false, fastForward: true, incomingCommits: 99 };
  // 扣住 worktreeList —— 两次 load 的回包由测试按任意顺序放行。
  server.hold.add("git:worktreeList");
  server.worktreeLists["/w/repo"] = [main, wtA];

  let path = "/wt/A";
  __mount(() =>
    WorktreeMergeBackDialog({
      open: true,
      onOpenChange: () => {},
      sessionId: "s1",
      worktreePath: path,
      repoPath: "/w/repo",
    }) as never,
  );
  await __flush();
  check("A 的 worktreeList 在飞(被扣住)", server.held.some((h) => h.input.repoPath === "/w/repo"), server.held.map((h) => h.input));

  // 换到 B(同一个对话框实例换 prop)→ 触发第二次 load。列表回值在**调用那一刻**快照:
  // 先换上含 B 的列表,再让第二次 load 发出。
  path = "/wt/B";
  server.worktreeLists["/w/repo"] = [main, wtB];
  __render();
  await __flush();
  check("换到 B 后发出的是 B 的 worktreeList", server.held.filter((h) => h.input.repoPath === "/w/repo").length >= 2, server.held.map((h) => h.input));

  // B(新)先回 → 预览是 B 的 99。
  releaseLast("git:worktreeList", (i) => i.repoPath === "/w/repo"); // 最后一条 = 第二次 = B
  await __flush();
  check("B 先回 → 显示 B 的「将合入 99 个提交」", __text().includes("99"), __text());

  // A(旧,含 wtA)迟到 → 不许把 B 的预览盖成 A 的 1。
  release("git:worktreeList", (i) => i.repoPath === "/w/repo");
  await __flush();
  check("★ 迟到的 A 回包不许把 B 的预览盖成 A 的", __text().includes("99") && !__text().includes("将合入 1 个提交"), __text());
}

await scenario();
await reverseScenario();
await worktreeScenario();
await worktreeManagerScenario();
await worktreeReplaceDialogRejectScenario();
await worktreeMergeBackDialogRejectScenario();
await worktreeDialogLoadRaceScenario();

console.log(`\nproject-branch-race-smoke:${checks - failures}/${checks} 通过`);
if (failures > 0) process.exitCode = 1;
// WorktreeMergeToolbarButton 起了 12s 轮询的 setInterval —— 无头跑真组件时得显式收尾,
// 否则 node 不退出(这套是"无头驱动真组件"的代价,别的套件没这问题)。
process.exit(failures > 0 ? 1 : 0);
