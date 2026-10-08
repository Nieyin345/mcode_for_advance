/**
 * activity-console-count-smoke — ActivityConsole 「已完成」筛选计数的口径漂移。
 *
 * ## 盯的是什么
 *
 * `ActivityConsole`(node="subagents")把子代理分成运行中 / 已结束两组,四个筛选
 * chip 各带一个计数。「已完成」这个 tab 的**计数**与它的**正文**必须说同一件事:
 * tab `completed` 点下去列出的行数,就该等于 chip 上那个数字。
 *
 * 子代理有四个终态:`completed` / `failed` / `killed`(用户中止或 Task 结束收尾)/
 * `running`。`killed` **不是** completed —— 正文 `SubagentsBody` 的 completed 组
 * 只取 `status === "completed"`,可 chip 的计数却写成 "所有已结束行减去失败行"
 * (`settledAgents.length - failed`),把 `killed` 也算进了「已完成」。
 *
 * 现场:用户中止了一轮(store 的 interrupt() 会把仍在 running 的后台子代理
 * **降级成 `killed`**),或某个 Task 以 killed 收尾。此时:
 *   · 「已完成」chip 显示 2;
 *   · 点进去只有 1 行(那 2 里有 1 个其实是被杀的);
 *   · 数字与正文对不上。同一规则两份实现(硬规矩 2):正文按 `completed` 过滤,
 *     chip 按 `settled - failed` 算 —— 两者只在"没有 killed"时才巧合相等。
 *
 * ## 判据
 *
 * 立在**用户看到的那两个数**上:构造 [running, completed, killed, failed],
 * 断言 chip「已完成」== 1(不是 2),且点进该 tab 后正文恰好列 1 行。
 * 撤掉修复(chip 计数回退成 `settled - failed`)时,第一条断言转红。
 *
 * ## 它怎么跑
 *
 * esbuild 打包真 `ActivityConsole.tsx` + 真 i18n/sessionStore;`react` 换成极小 hooks
 * 运行时(组件源码原样跑),`@tabler/icons-react` 与 `react-icons/*` 换空壳 barrel
 * (惰性 JSX,图标只是 `type`)。不起浏览器、不写盘、不连 IPC。
 *
 * Run: scripts/activity-console-count-smoke/run.sh
 */
import "./prelude.js";
import { __mount, __render, __flush, __nodes, __text } from "./fakeReact.js";
import { ActivityConsole } from "@renderer/components/chat/ActivityConsole.js";
import type { SubagentSnapshot } from "@contracts/runtime";

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

// 四个终态各来一个(git 上的现场就是一个被杀的 + 一个正常完成的)。
const subagents = [
  { taskId: "a-run", status: "running", description: "运行中", durationMs: 12_000, toolUses: 1, totalTokens: 100 },
  { taskId: "b-done", status: "completed", description: "正常完成", durationMs: 5_000, toolUses: 2, totalTokens: 200, endedAt: Date.now() },
  { taskId: "c-kill", status: "killed", description: "被杀的", durationMs: 3_000, toolUses: 1, totalTokens: 150, endedAt: Date.now() },
  { taskId: "d-fail", status: "failed", description: "失败的", durationMs: 4_000, toolUses: 1, totalTokens: 120, endedAt: Date.now() },
] as unknown as SubagentSnapshot[];

// 父级拥有的筛选 tab;onTabChange 回写后手动重渲染(模拟 ActivityCluster 的 setTab)。
const tabs: Record<string, string> = { tasks: "all", subagents: "all", plans: "all", bookmarks: "all" };

function el(): unknown {
  return ActivityConsole({
    node: "subagents",
    subagents,
    todos: [],
    planBlocks: [],
    bookmarks: [],
    tabs: tabs as never,
    onTabChange: (n, t) => {
      tabs[n] = t;
    },
    onClose: () => {},
    onPickPlan: () => {},
    nodeTabs: false,
    showKeyHint: false,
  });
}

/** 从节点树里摘出一段文本(用于认 chip 的 label)。 */
function textOf(n: unknown): string {
  const parts: string[] = [];
  const walk = (x: unknown): void => {
    if (x == null || typeof x === "boolean") return;
    if (typeof x === "string" || typeof x === "number") return void parts.push(String(x));
    if (Array.isArray(x)) return void x.forEach(walk);
    if (typeof x === "object") walk((x as { props?: { children?: unknown } }).props?.children);
  };
  walk(n);
  return parts.join(" ");
}

/** 按 label 找筛选 chip(FilterChip 是子组件,只以 `{type, props}` 留在树里 ——
 *  fakeReact 不调用子组件,故按它的 props 形状认:`{label, n, active, onClick}`)。 */
function chip(label: string): { n: number | undefined; node: { props: Record<string, unknown> } } | undefined {
  for (const nd of __nodes()) {
    const p = nd.props;
    if (
      typeof p.label === "string" &&
      typeof p.active === "boolean" &&
      typeof p.onClick === "function" &&
      p.label === label
    ) {
      return { n: typeof p.n === "number" ? p.n : undefined, node: nd };
    }
  }
  return undefined;
}

/** 深度收集子树里满足 pred 的节点。 */
function collect(n: unknown, pred: (p: Record<string, unknown>) => boolean): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) return void x.forEach(walk);
    if (!x || typeof x !== "object") return;
    const el = x as { type?: unknown; props?: Record<string, unknown> };
    if (!("type" in el)) return;
    if (pred(el.props ?? {})) out.push(el.props ?? {});
    walk((el.props ?? {}).children);
  };
  walk(n);
  return out;
}

/** 「已完成」/「全部」正文里列出的子代理行 —— SubagentsBody 也是子组件(fakeReact 只渲染
 *  根),这里**手动调用**它(它无 hook,纯过滤),把它的真子树拿出来数 SubagentRow。 */
function bodyRows(): { tab: string; ids: string[] } {
  const body = __nodes().find(
    (nd) => Array.isArray(nd.props.agents) && typeof nd.props.tab === "string",
  );
  if (!body) return { tab: "?", ids: [] };
  const subtree = (body.type as (p: Record<string, unknown>) => unknown)(body.props);
  const ids = collect(subtree, (p) => typeof (p.agent as { taskId?: unknown } | undefined)?.taskId === "string")
    .map((p) => (p.agent as { taskId: string }).taskId);
  return { tab: body.props.tab as string, ids };
}

async function scenario(): Promise<void> {
  __mount(el);
  await __flush();

  // 默认 tab=all:主对话正文按运行中 / 已结束分组。
  const all = chip("全部");
  const running = chip("运行中");
  const completed = chip("已完成");
  const failed = chip("失败");
  check("全部 chip == 4", all?.n === 4, { got: all?.n, subagents: subagents.length });
  check("运行中 chip == 1", running?.n === 1, running?.n);
  check("失败 chip == 1", failed?.n === 1, failed?.n);
  // ★ 核心:被杀的那条不是「已完成」。settled(3) - failed(1) = 2 是错的口径。
  check("★ 已完成 chip == 1(被杀的子代理不算已完成)", completed?.n === 1, {
    got: completed?.n,
    explain: "settled(3) - failed(1) = 2 会把 killed 误算进已完成",
  });

  // all 视图列出全部 4 行(SubagentsBody 按 running/settled 分两组,共 4 条)。
  const allRows = bodyRows();
  check("all 视图列出全部 4 行", allRows.ids.length === 4, { tab: allRows.tab, ids: allRows.ids });

  // 点进「已完成」tab:正文列出的行数必须等于 chip 上的数字(同一口径)。
  (completed?.node.props.onClick as () => void)();
  __render();
  await __flush();
  const rows = bodyRows();
  check("★ 点进「已完成」后正文行数 == chip 计数(=1)", rows.ids.length === 1, {
    rows: rows.ids,
    chip: completed?.n,
  });
  check(
    "★ 「已完成」tab 只列出真正 completed 的那条",
    rows.ids.length === 1 && rows.ids[0] === "b-done",
    rows.ids,
  );
}

await scenario();

console.log(`\nactivity-console-count-smoke:${checks - failures}/${checks} 通过`);
if (failures > 0) process.exit(1);
// useNow 起了 1s 定时器,显式退出避免 Node 挂住。
process.exit(0);
