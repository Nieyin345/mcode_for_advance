/**
 * ide-ime-smoke — 文本输入框上的 **Enter 缺 IME 守卫**。
 *
 * ## 盯的是什么
 *
 * 中文/日文输入法里,按 Enter 是"确认候选词"(上屏),**不是**提交。React 的
 * keydown 在编排期间也会以 `key === "Enter"` 到达。仓库里绝大多数 Enter 处理器都带
 * 那条守卫(`e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229`),但有几处
 * 漏了(GitRepoCard 的新建分支名框、SearchDialog 的文件类型框等,见下)。
 *
 * ## 判据
 *
 * 在输入框上派发一个 `isComposing: true` 的 Enter —— 之后对应的动作
 * **不该**被调用。再派发一个正常 Enter —— 应该恰好调用一次(正控,证明这套确实
 * 能观察到提交动作)。
 *
 * ## 它怎么跑
 *
 * esbuild `--alias:react=` 换成 `maint-m32-smoke` 那套极小 hooks 运行时(组件源码原样
 * 跑);`@base-ui/react/*` 与 `@renderer/components/ui/index.js` 换成直通桩(它们只是
 * `{type, props}`,不被调用);`@renderer/lib/api.js` 换成记事桩。不起浏览器、不写盘。
 *
 * Run: scripts/ide-ime-smoke/run.sh
 */
import "./prelude.js";
import { calls, callsOf, resetCalls, setOverride } from "./api-stub.js";
import { __mount, __flush, __nodes, __text } from "./fakeReact.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { GitRepoCard } from "@renderer/components/ide/GitRepoCard.js";
import { SearchDialog } from "@renderer/components/ide/SearchDialog.js";
import type { GitFileStatus, GitRepo, GitStatusResult } from "@contracts/ipc";

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

const REPO: GitRepo = { path: "/w/proj/repo", name: "repo", isRepo: true };

type El = { type: unknown; props: Record<string, unknown> };

/** 树里所有的原生 input。 */
function inputs(): El[] {
  return __nodes().filter((n) => n.type === "input") as El[];
}

/** 新建分支名输入框:靠 placeholder(唯一)认它 —— 「分支名,如 feature/xxx」。 */
function newBranchInput(): El {
  const el = inputs().find(
    (n) => typeof n.props.placeholder === "string" && (n.props.placeholder as string).includes("feature"),
  );
  if (!el) throw new Error("找不到新建分支名输入框");
  return el;
}

/** 操作日志里已记账的 op 序列。`OperationLog` 是子组件(fakeReact 不调用它),
 *  但树里那个元素节点的 props 带着 `logs` —— 那正是"日志里记成了什么 op"的直接判据。 */
function logOps(): string[] {
  const n = __nodes().find((x) => Array.isArray((x.props as { logs?: unknown }).logs));
  return ((n?.props.logs as Array<{ op: string }> | undefined) ?? []).map((e) => e.op);
}

/** 造一个键盘事件对象(React 的合成事件在假的运行时里就是普通对象)。 */
function keyEvent(key: string, opts: { isComposing?: boolean; keyCode?: number } = {}): unknown {
  const native = { isComposing: opts.isComposing ?? false, keyCode: opts.keyCode ?? 0 };
  return {
    key,
    nativeEvent: native,
    isComposing: opts.isComposing ?? false,
    keyCode: opts.keyCode ?? 0,
    preventDefault: () => {},
    stopPropagation: () => {},
  };
}

async function scenario() {
  resetCalls();
  // git.status 回一个干净的工作区,让卡片渲染出来(不因加载而吞掉分支菜单)。
  useSessionStore.setState({ locale: "zh", activeProjectId: "p1", gitChangeVersionByRepo: {} });
  __mount(() => GitRepoCard({ repo: REPO }));
  await __flush();

  // Dialog.Portal 是直通桩,所以"新建分支"对话框里的输入框一直在树里
  // (真运行时它由 newBranchOpen 控制显隐 —— 我们的判据不依赖那个门,只驱动它的
  //  onKeyDown)。
  //
  // ⚠️ 每个用例前都要**重新取元素并重填名字**:onKeyDown 闭包捕获的是那次渲染时的
  // `newBranchName`,而且一次成功的提交会把名字清空、把对话框关掉。不重填就永远是空串,
  // 后面的用例会假绿。
  const type = async (value: string) => {
    (newBranchInput().props.onChange as (e: unknown) => void)({ target: { value } });
    await __flush();
  };
  const pressEnter = async (opts: { isComposing?: boolean; keyCode?: number } = {}) => {
    (newBranchInput().props.onKeyDown as (e: unknown) => void)(keyEvent("Enter", opts));
    await __flush();
  };

  // ① IME 组词中的 Enter —— 绝不该建分支。
  await type("feature-half");
  calls.length = 0;
  await pressEnter({ isComposing: true });
  check("★ IME 组词中的 Enter 不建分支", callsOf("git.checkout").length === 0, calls);

  // ② 老式 IME 只给 keyCode 229 的 Enter —— 同样不该建分支。
  await type("feature-half");
  calls.length = 0;
  await pressEnter({ keyCode: 229 });
  check("★ keyCode 229 的 Enter 不建分支", callsOf("git.checkout").length === 0, calls);

  // ③ 正常 Enter(正控)—— 应该恰好触发一次 checkout。
  await type("feature-real");
  calls.length = 0;
  await pressEnter();
  check("正常 Enter 建分支一次(正控)", callsOf("git.checkout").length === 1, calls);

  // ④ 操作日志记的 op 必须是「切换分支」,不是「放弃更改」。
  //    ⚠️ 判据立在**用户看到那行字的 op** 上:日志条目的标签由 `OP_LABEL_KEYS[op]`
  //    渲染,而 ③ 那次成功切换分支若记成 `discard`,用户会在操作日志里看到
  //    「放弃更改」——一次他根本没做过的操作。op 就是那行字的唯一决定因素。
  check("★ 切分支记进日志的是 checkout,不是 discard", logOps().includes("checkout"), logOps());
}

/**
 * GitRepoCard 的**操作失败横幅被 refresh 清掉**。
 *
 * `refresh()` 开头会 `setError(null)`(给"上次的错误横幅别黏住"用的),而卡片上每一条
 * git 操作从前一律写成 `if (!res.ok) setError(...); … await refresh();` —— `refresh`
 * 成功回来时把**这一次**刚挂上的失败横幅一起清掉:切分支被拒、推送失败、放弃更改失败,
 * 屏幕上一个字都没有(用户只会以为"点了没反应")。与 `McpPanel` 的 toggle/delete 是同
 * 一族(见 `settings-panel-smoke` §15)。判据立在**屏幕上那行字**上:失败那句在操作走完
 * (含 refresh)之后仍须出现在卡片里。
 */
async function gitErrorBannerScenario(): Promise<void> {
  const stagedStatus: GitStatusResult = {
    branch: "main",
    ahead: 0,
    behind: 0,
    files: [{ path: "a.ts", index: "modified", workingTree: "unmodified" } as GitFileStatus],
  };

  // ① 切分支失败(git 拒了:本地有未提交改动会被覆盖等)—— 新建分支框回车那条路。
  resetCalls();
  useSessionStore.setState({ locale: "zh", activeProjectId: "p1", gitChangeVersionByRepo: {} });
  setOverride("git.checkout", { ok: false, error: "SENTINEL_CHECKOUT_FAILED" });
  __mount(() => GitRepoCard({ repo: REPO }));
  await __flush();
  (newBranchInput().props.onChange as (e: unknown) => void)({ target: { value: "feature-x" } });
  await __flush();
  (newBranchInput().props.onKeyDown as (e: unknown) => void)(keyEvent("Enter"));
  await __flush();
  check("checkout 确实被触发了(正控)", callsOf("git.checkout").length === 1, callsOf("git.checkout"));
  check("★ 切分支失败的话没被 refresh 的 setError(null) 清掉", __text().includes("SENTINEL_CHECKOUT_FAILED"), __text());

  // ② 提交成功但**推送**失败(commit+push 这条路)—— 子步骤的失败同样不许被清掉。
  resetCalls();
  useSessionStore.setState({ locale: "zh", activeProjectId: "p1", gitChangeVersionByRepo: {} });
  setOverride("git.status", { status: stagedStatus });
  setOverride("git.push", { ok: false, error: "SENTINEL_PUSH_FAILED" });
  __mount(() => GitRepoCard({ repo: REPO }));
  await __flush();
  const findCommitBox = () =>
    __nodes().find((n) => typeof (n.props as { onCommit?: unknown }).onCommit === "function") as
      | { props: Record<string, unknown> }
      | undefined;
  check("有已暂存文件时 CommitBox 渲染出来(正控)", !!findCommitBox());
  if (findCommitBox()) {
    // ⚠️ onChange 会重渲染整棵树,CommitBox 元素是**新的一份** —— 必须重新取,
    // 否则拿的是旧闭包,它捕获的 `commitMsg` 还是空串(handleCommit 开头 `if (!msg) return`)。
    (findCommitBox()!.props.onChange as (v: string) => void)("feat: x");
    await __flush();
    (findCommitBox()!.props.onCommit as (m: string) => void)("push");
    await __flush();
    check("★ 提交成功但推送失败的话没被 refresh 清掉", __text().includes("SENTINEL_PUSH_FAILED"), __text());
  }

  // ③ header 的推送按钮(handlePush 那条独立路径)。
  resetCalls();
  useSessionStore.setState({ locale: "zh", activeProjectId: "p1", gitChangeVersionByRepo: {} });
  setOverride("git.push", { ok: false, error: "SENTINEL_PUSH2_FAILED" });
  __mount(() => GitRepoCard({ repo: REPO }));
  await __flush();
  const pushBtn = __nodes().find(
    (n) => typeof (n.props as { onClick?: unknown }).onClick === "function" &&
      typeof (n.props as { title?: unknown }).title === "string" &&
      /Push/.test((n.props as { title: string }).title),
  );
  check("找到 header 的推送按钮(正控)", !!pushBtn);
  if (pushBtn) {
    (pushBtn.props.onClick as () => void)();
    await __flush();
    check("★ header 推送失败的话没被 refresh 清掉", __text().includes("SENTINEL_PUSH2_FAILED"), __text());
  }
}

/**
 * SearchDialog 的文件类型过滤框。
 *
 * 这是个**自由文本**字段(接受 `*.java` / `.java` / `java` 乃至全角逗号分隔 —— 见
 * `parseFileTypeInput` 的 `/[,，;；\s]+/`),用户完全可能用中文输入法打备注/中文扩展名
 * 再上屏。按 Enter 会把当前值**记进"最近用过的文件类型"并落盘**(见 line 191 的
 * `setting.set`)。同组件的主搜索框(line 309)已经带 IME 守卫,唯独这个字段漏了。
 *
 * 判据:IME 组词中的 Enter **不该**触发那次落盘(`setting.set` / 键 `ui.search.fileTypes`)。
 */
async function searchDialogScenario() {
  resetCalls();
  useSessionStore.setState({
    locale: "zh",
    activeProjectId: "p1",
    projects: [
      {
        id: "p1",
        name: "p1",
        path: "/w/proj",
        archived: false,
        pinnedAt: null,
        sortOrder: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    searchDialogOpen: true,
  });
  __mount(() => SearchDialog());
  await __flush();

  const field = (): El => {
    const el = __nodes().find(
      (n) => n.type === "input" && (n.props as { list?: string }).list === "search-filetype-list",
    ) as El | undefined;
    if (!el) throw new Error("找不到文件类型过滤框");
    return el;
  };

  const type = async (value: string) => {
    (field().props.onChange as (e: unknown) => void)({ target: { value } });
    await __flush();
  };
  const pressEnter = async (opts: { isComposing?: boolean; keyCode?: number } = {}) => {
    (field().props.onKeyDown as (e: unknown) => void)(keyEvent("Enter", opts));
    await __flush();
  };
  /** 记住的文件类型直接体现在 `<datalist>` 的 `<option>` 上(用户下次输入会看到自动
   *  补全)。这是判据的**直接可观测后果**,不受 `setting.set` 那层 effect 时序/去重的干扰。 */
  const remembered = (): string[] =>
    (__nodes().filter((n) => n.type === "option") as El[])
      .map((n) => n.props.value)
      .filter((v): v is string => typeof v === "string");

  // ① IME 组词中的 Enter —— 不该把半截的值记进历史(每个用例用**不同的值**,
  //    免得 rememberFileType 的去重把后一个悄悄吃掉,造成假绿)。
  await type("jav-one");
  await pressEnter({ isComposing: true });
  check("★ 文件类型框:IME 组词中的 Enter 不记历史", !remembered().includes("jav-one"), remembered());

  // ② keyCode 229 的 Enter —— 同上。
  await type("jav-two");
  await pressEnter({ keyCode: 229 });
  check("★ 文件类型框:keyCode 229 的 Enter 不记历史", !remembered().includes("jav-two"), remembered());

  // ③ 正常 Enter(正控)—— 应该把值记进历史。
  await type("java");
  await pressEnter();
  check("文件类型框:正常 Enter 记历史(正控)", remembered().includes("java"), remembered());
}

/**
 * 两份 `StatusCodeIcon`(GitRepoCard / GitDiffDialog 各画一处 git 文件列表)必须列出
 * **同一组**状态码。它们从前漂了:`unmerged`(合并冲突)只在 GitRepoCard 那份里有,
 * 于是冲突文件在仓库卡片里是红色 `U`、在 diff 对话框左栏是一个灰色 `·` —— 同一个文件
 * 两处两种样子。这是"同一规则写两遍然后漂移"那一类,而组件在无头下跑不出这个差异,
 * 所以判据钉在**源码**上:两份都得处理 `unmerged`。
 */
async function statusCodeParityScenario(): Promise<void> {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const root = process.cwd();
  for (const rel of [
    "src/renderer/components/ide/GitRepoCard.tsx",
    "src/renderer/components/ide/GitDiffDialog.tsx",
  ]) {
    const src = readFileSync(join(root, rel), "utf8");
    const at = src.indexOf("function StatusCodeIcon(");
    const body = at >= 0 ? src.slice(at, at + 900) : "";
    check(`★ ${rel} 的 StatusCodeIcon 处理 unmerged(冲突文件显示红色 U)`, body.includes('code === "unmerged"'), rel);
  }
}

/**
 * 文件树上删文件/删目录失败必须显式报出来。
 *
 * 主进程的 `file:delete` 在三种情况下回 `{ok:false}`:路径不在任何项目里、目标是项目
 * 根本身、`shell.trashItem` 抛错(见 `ipc/files.ts`)。而 `FileTree.tsx` 里**两处**
 * 删除回调从前都是 `if (!result.ok) return;` —— 用户点了删除、确认了,菜单关了、行
 * 还在,什么提示都没有,他只会以为"这个功能坏了"。粘贴一直有失败 toast
 * (`usePasteFailure`),删除却被漏掉 —— 同一类反馈只做了一半。判据钉在**源码**上
 * (组件在无头下跑不出这个差异):每个 `if (!result.ok)` 之后必须紧跟一句 `reportDeleteFailed()`。
 */
async function fileTreeDeleteFailureScenario(): Promise<void> {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const src = readFileSync(join(process.cwd(), "src/renderer/components/ide/FileTree.tsx"), "utf8");
  // 每个删除回调里的 `const result = await api.file.delete(...)` 到下一个 `},` 之间,
  // 失败分支必须报出来。
  const deleteBlocks = src.match(/const result = await api\.file\.delete\([^]*?\n  \}, \[/g) ?? [];
  check("★ FileTree 里两处 file.delete 都被这条断言看到", deleteBlocks.length >= 2, deleteBlocks.length);
  for (const [i, block] of deleteBlocks.entries()) {
    check(`★ 第 ${i + 1} 处删除失败会报出来(不是静默 return)`, /if \(!result\.ok\) \{\s*[\s\S]*?reportDeleteFailed\(\)/.test(block), block.slice(0, 200));
  }
  check("★ 删除失败文案走 i18n(不是硬编码中文)", src.includes('useRowFailure("ide.tree.deleteFailed")'));
}

/**
 * 两个分支切换器(仓库卡片 `GitRepoCard` 的、输入框 chip `ProjectBranchIndicator` 的)
 * 必须**同样**把切换失败说出来。
 *
 * 同一个用户动作(git checkout)有两个入口,而 git 会拒它(本地有未提交改动会被覆盖
 * 等)。`GitRepoCard` 把失败同时摆进 `setError` 与 op-log;`ProjectBranchIndicator`
 * 从前是 `catch {}` —— 外加**连 `res.ok === false` 都不看**,于是用户点了另一个分支、
 * 菜单关了、当前分支没变,屏幕上一个字都没有。判据钉在源码上(组件无头跑不出这个差异):
 * chip 那条路必须检查 `res.ok` 且把失败报出来(toast)。
 */
async function branchSwitchFailureScenario(): Promise<void> {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const chip = readFileSync(join(process.cwd(), "src/renderer/components/chat/ProjectBranchIndicator.tsx"), "utf8");
  const code = chip.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  check("★ 分支 chip 检查 git.checkout 的 {ok:false}(不是只看抛错)", /const res = await api\.git\.checkout\(/.test(code) && /if \(!res\.ok\)/.test(code));
  check("★ 分支 chip 切换失败会报出来(不是静默 catch)", /useToastStore\.getState\(\)\.push\(/.test(code) && code.includes("chat.branch.switchFailed"));
}

await scenario();
await gitErrorBannerScenario();
await searchDialogScenario();
await statusCodeParityScenario();
await fileTreeDeleteFailureScenario();
await branchSwitchFailureScenario();

console.log(`\nide-ime-smoke:${checks - failures}/${checks} 通过`);
if (failures > 0) process.exitCode = 1;
