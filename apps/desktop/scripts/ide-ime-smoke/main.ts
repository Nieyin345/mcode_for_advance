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
import { calls, callsOf, resetCalls } from "./api-stub.js";
import { __mount, __flush, __nodes } from "./fakeReact.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { GitRepoCard } from "@renderer/components/ide/GitRepoCard.js";
import { SearchDialog } from "@renderer/components/ide/SearchDialog.js";
import type { GitRepo } from "@contracts/ipc";

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

await scenario();
await searchDialogScenario();

console.log(`\nide-ime-smoke:${checks - failures}/${checks} 通过`);
if (failures > 0) process.exitCode = 1;
