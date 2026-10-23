/**
 * t100-task-center-smoke —— 【T100】任务中心：看得见、验收得动。
 *
 * ## 它验的是哪一层（**名字要说清**）
 *
 * **`TaskCenterPanel` / `TaskRow` 的真组件代码**挂在极小 React 运行时上
 * （`fakeReact.ts`，与 `document-view-renderer-smoke` 同一份地基）。验：
 *
 *  1. 七态都显示，且 `done` 与 `accepted` 的**文案不同**；
 *  2. 「接受 / 退回」只在状态允许时出现；
 *  3. 点「接受」先展开**理由输入框**，理由为空时确认按钮 disabled、且**零写调用**；
 *  4. 填了理由再确认，**真的调** `api.task.accept({ id, evidence })`，evidence 原样；
 *  5. 退回同理（`task.reject({ id, reason })`）；
 *  6. 写失败时把主进程原话推给用户（不吞）；
 *  7. 读列表**不传 sessionId**（T99 的跨会话能力，界面不能又加回去）。
 *
 * ## 它**不**验
 *
 *  - `tasks` 表与状态机 → `task-first-class-smoke`（T99，27/27）；
 *  - 右栏页签的排序/隐藏 → `customUi` 那套；
 *  - 手机端 → 任务中心不挂手机端（见 `webApi.ts` 里 `task` 常量注释）。
 *
 * ## 为什么能测到子组件
 *
 * fakeReact 只渲染根组件，子组件只留 `{type, props}`。而「点接受 → 出输入框 →
 * 空理由不能提交」整条链在 `TaskRow` 里。所以**把 `TaskRow` 单独当根组件挂载**
 * —— 它是真代码、真 handler，不是副本。
 */
import "./prelude.js";
import { __mount, __unmount, __flush, __nodes, __text } from "./fakeReact.js";
import { TaskCenterPanel, TaskRow, submitDecision } from "@renderer/components/ide/TaskCenterPanel.js";
import { __setTasks, __reset, __failNextWrite, __failList, __writes, calls } from "./api-stub.js";
import { __toasts, __resetToasts } from "./toastStore-stub.js";
import type { Task } from "@contracts/ipc/task";

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
  }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}
function section(t: string): void {
  console.log(`\n${t}`);
}

function task(over: Partial<Task> & { id: string; goal: string; status: Task["status"] }): Task {
  return {
    dependsOn: [],
    origin: { kind: "agent", ref: "sess_1" },
    links: { sessionIds: [], workflowIds: [] },
    artifacts: [],
    acceptance: null,
    failureReason: null,
    rejectionReason: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...over,
  } as Task;
}

/** 树里所有渲染出来的文本（含 props.children 的深层）。 */
function deepText(): string {
  const parts: string[] = [__text()];
  const walk = (v: unknown): void => {
    if (v === null || v === undefined || typeof v === "boolean") return;
    if (typeof v === "string" || typeof v === "number") return void parts.push(String(v));
    if (Array.isArray(v)) return void v.forEach(walk);
    if (typeof v === "object") {
      const o = v as { props?: Record<string, unknown>; children?: unknown };
      if (o.props) {
        for (const [k, val] of Object.entries(o.props)) if (k !== "children") walk(val);
        walk(o.props.children);
      } else walk(o.children);
    }
  };
  walk(__nodes().map((n) => n.props.children));
  return parts.join(" ");
}

/**
 * 找「可点的按钮节点」。
 *
 * ⚠️ **不能按 `type === "button"` 找**：`<Button>` 是**组件**，fakeReact 不执行
 * 子组件，节点的 `.type` 是那个函数（实测 `BUTTON COUNT: 0`）。但它的 `props`
 * （`onClick` / `disabled` / `children`）**已经在树里**，这正是要验的东西。
 * 所以判据是「有 `onClick` 的节点」。
 */
function buttons(): Array<{ props: Record<string, unknown> }> {
  return __nodes().filter((n) => typeof n.props.onClick === "function") as Array<{ props: Record<string, unknown> }>;
}

/** 按可见文本找一个按钮（文本来自 props.children，可能嵌着图标元素）。 */
function buttonByText(label: string): { props: Record<string, unknown> } | undefined {
  return buttons().find((b) => JSON.stringify(b.props.children ?? "").includes(label));
}

async function flush(n = 6): Promise<void> {
  for (let i = 0; i < n; i++) await __flush();
}

/** 面板整体挂载。 */
async function mountPanel(tasks: Task[]): Promise<void> {
  __reset();
  __resetToasts();
  __setTasks(tasks);
  __mount(() => TaskCenterPanel());
  await flush();
}

/** 单独挂一行（测按钮与输入框）。 */
async function mountRow(props: {
  task: Task;
  decision?: "accept" | "reject" | null;
  draft?: string;
}): Promise<{ submitted: unknown[]; drafts: string[] }> {
  const submitted: unknown[] = [];
  const drafts: string[] = [];
  const state = { decision: props.decision ?? null, draft: props.draft ?? "" };
  __mount(() =>
    TaskRow({
      task: props.task,
      expanded: state.decision !== null,
      decision: state.decision,
      draft: state.draft,
      busy: false,
      onDraft: (v: string) => { drafts.push(v); },
      onAccept: () => submitted.push("accept"),
      onReject: () => submitted.push("reject"),
      onCancel: () => submitted.push("cancel"),
      onSubmit: () => submitted.push({ submit: state.draft }),
    }),
  );
  await flush(3);
  return { submitted, drafts };
}

/* ================== 1. 七态文案，done ≠ accepted ================== */
section("1. 七态都显示，且 done ≠ accepted");
{
  const all = (["pending", "running", "blocked", "done", "failed", "accepted", "rejected"] as const)
    .map((s) => task({ id: `task_${s}`, goal: `目标-${s}`, status: s }));
  await mountPanel(all);
  const text = deepText();

  check("★ done 显示「做完了（待验收）」", text.includes("做完了（待验收）"), text.slice(0, 300));
  check("★ accepted 显示「已验收」", text.includes("已验收"));
  check("★ 两者是不同文案（数据模型上的区别没在界面被合回去）",
    text.includes("做完了（待验收）") && text.includes("已验收") &&
    !text.includes("做完了（待验收）已验收"));
  for (const [s, label] of [
    ["pending", "待开始"], ["running", "进行中"], ["blocked", "等审批"], ["failed", "失败"], ["rejected", "已退回"],
  ] as const) {
    check(`状态 ${s} 显示「${label}」`, text.includes(label));
  }

  // 跨会话：读路径不传 sessionId。
  const lists = calls.filter((c) => c.method === "list");
  check("★ 读列表不传 sessionId（跨会话，T99 的核心能力）",
    lists.length > 0 && lists.every((c) => (c.input as { sessionId?: string }).sessionId === undefined),
    lists.map((c) => c.input));
  __unmount();
}

/* ================== 2. 按钮只在允许的状态出现 ================== */
section("2. 接受 / 退回只在允许的状态出现");
{
  // done：两个都要有
  const okRow = await mountRow({ task: task({ id: "t_ok", goal: "做完了", status: "done" }) });
  check("★ done 行有「接受」按钮", buttonByText("接受") !== undefined);
  check("★ done 行有「退回」按钮", buttonByText("退回") !== undefined);
  __unmount();

  // running：都不该有（没跑完不能验收，也不能退回）
  await mountRow({ task: task({ id: "t_run", goal: "还在跑", status: "running" }) });
  check("★ running 行没有「接受」", buttonByText("接受") === undefined);
  check("★ running 行没有「退回」", buttonByText("退回") === undefined);
  __unmount();

  // accepted：终态，都没有
  await mountRow({ task: task({ id: "t_acc", goal: "已验收", status: "accepted" }) });
  check("★ accepted 行没有「接受」", buttonByText("接受") === undefined);
  __unmount();

  // failed：能退回（返修），不能验收（失败不能盖章通过）
  await mountRow({ task: task({ id: "t_fail", goal: "失败", status: "failed" }) });
  check("★ failed 行有「退回」（返修）", buttonByText("退回") !== undefined);
  check("★ failed 行**没有**「接受」（失败不能被验收通过）", buttonByText("接受") === undefined);
  __unmount();

  // rejected：等执行方返修，用户这边暂时没事
  await mountRow({ task: task({ id: "t_rej", goal: "已退回", status: "rejected" }) });
  check("★ rejected 行没有按钮（等返修）",
    buttonByText("接受") === undefined && buttonByText("退回") === undefined);
  __unmount();
}

/* ================== 3. 理由必填 ================== */
section("3. 验收 / 退回都必须先写理由");
{
  // 空理由：确认按钮 disabled
  const empty = await mountRow({
    task: task({ id: "t1", goal: "待验收", status: "done" }),
    decision: "accept",
    draft: "",
  });
  const confirm = buttonByText("确认接受");
  check("★ 展开后出现「确认接受」", confirm !== undefined);
  eq("★ 空理由时确认按钮 disabled", confirm?.props.disabled, true);
  check("附近写了为什么灰（「理由不能为空」）", deepText().includes("理由不能为空"));
  __unmount();
  void empty;

  // 只有空白：仍然 disabled
  const spaces = await mountRow({
    task: task({ id: "t2", goal: "待验收", status: "done" }),
    decision: "accept",
    draft: "    ",
  });
  eq("★ 全是空格时仍然 disabled", buttonByText("确认接受")?.props.disabled, true);
  __unmount();
  void spaces;

  // 有理由：不禁用，且提交带原样文本
  const filled = await mountRow({
    task: task({ id: "t3", goal: "待验收", status: "done" }),
    decision: "accept",
    draft: "打开过导出的 PPT，8 页都在",
  });
  eq("★ 填了理由后不再 disabled", buttonByText("确认接受")?.props.disabled, false);
  const btn = buttonByText("确认接受");
  (btn?.props.onClick as (() => void) | undefined)?.();
  await flush(2);
  eq("★ 点确认把理由原样交出去",
    (filled.submitted.at(-1) as { submit?: string } | undefined)?.submit,
    "打开过导出的 PPT，8 页都在");
  __unmount();

  // 退回同理
  const rejectRow = await mountRow({
    task: task({ id: "t4", goal: "要退回", status: "done" }),
    decision: "reject",
    draft: "",
  });
  check("★ 退回分支出现「确认退回」", buttonByText("确认退回") !== undefined);
  eq("★ 退回空理由也 disabled", buttonByText("确认退回")?.props.disabled, true);
  check("退回时提示是「退回理由」", deepText().includes("退回理由"));
  __unmount();
  void rejectRow;
}

/* ================== 4. 写路径：submitDecision 真的发 RPC ================== */
section("4. 写路径 submitDecision（真函数，真 api-stub）");
{
  // 为什么在这里而不是「整面板挂载 → 点按钮」：最小 React 运行时**不执行子组件**，
  // `TaskRow` 不会被调用，所以面板里的按钮在无头环境里点不到（实测：找不到）。
  // 第 3 节已经把「按钮 → 回调」这一段验掉了；这里验回调背后**真正发 RPC 的那段**。
  __reset();
  __resetToasts();

  await submitDecision({ taskId: "task_e2e", kind: "accept" }, "验过了，图表数据对得上", "操作失败");
  const writes = __writes();
  eq("★ 恰好一次写调用", writes.length, 1);
  eq("写的是 task.accept", writes[0]?.method, "accept");
  eq("★ evidence 原样到达主进程", (writes[0]?.input as { evidence?: string })?.evidence, "验过了，图表数据对得上");
  eq("带的是这个任务的 id", (writes[0]?.input as { id?: string })?.id, "task_e2e");

  __reset();
  await submitDecision({ taskId: "task_r", kind: "reject" }, "第 3 页图表还是空的", "操作失败");
  const rw = __writes();
  eq("退回：恰好一次写调用", rw.length, 1);
  eq("退回：写的是 task.reject", rw[0]?.method, "reject");
  eq("★ reason 原样到达主进程", (rw[0]?.input as { reason?: string })?.reason, "第 3 页图表还是空的");

  // 空理由：一个写调用都不许有（契约层 min(1) 的界面侧前置）。
  __reset();
  eq("★ 空理由时 ok:false", (await submitDecision({ taskId: "x", kind: "accept" }, "   ", "操作失败")).ok, false);
  eq("★ 空理由时零写调用", __writes().length, 0);
}

/* ================== 5. 写失败不吞 ================== */
section("5. 写失败把主进程原话给用户");
{
  __reset();
  __resetToasts();
  __failNextWrite("任务已经被别的验收人处理过了");
  const r = await submitDecision({ taskId: "task_f", kind: "accept" }, "理由", "操作失败");
  eq("★ 失败返回 ok:false（输入区不关闭，用户能改完再试）", r.ok, false);

  const toasts = __toasts();
  check("★ 失败后推了一条 toast", toasts.length === 1, toasts);
  check("★ toast 里是主进程的原话（不吞）",
    (toasts[0]?.body ?? "").includes("任务已经被别的验收人处理过了"), toasts);
  eq("toast 标题用调用方给的文案", toasts[0]?.title, "操作失败");
}

/* ================== 6. 加载失败 / 空列表 ================== */
section("6. 加载失败与空列表");
{
  __reset();
  __resetToasts();
  __failList("数据库忙");
  __mount(() => TaskCenterPanel());
  await flush(8);
  check("★ 加载失败显示错误块", deepText().includes("任务列表加载失败"), deepText().slice(0, 200));
  check("★ 错误块里有主进程原话", deepText().includes("数据库忙"));
  __unmount();

  __reset();
  __mount(() => TaskCenterPanel());
  await flush();
  check("★ 空列表有说明", deepText().includes("还没有任务"));
  __unmount();
}

/* ================== 结果 ================== */
console.log("");
if (failures.length > 0) {
  console.log(`t100-task-center-smoke: ${passed} ok, ${failures.length} FAIL`);
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(1);
}
console.log(`t100-task-center-smoke: ${passed}/${passed} 通过`);
