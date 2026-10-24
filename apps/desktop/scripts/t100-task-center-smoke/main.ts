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
import type { Approval } from "@contracts/ipc/approval";

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
/**
 * 按**直属文本**找一个按钮（不含子元素里的文本）。
 *
 * ⚠️ 第一版用的是 `JSON.stringify(children).includes(label)` —— **子串匹配太宽**。
 * T111 给整行加了一个可点的展开按钮，它的 children 里包含 goal 文本，
 * 于是 `buttonByText("退回")` 命中了 goal 是「已退回」的那一行的**展开按钮**，
 * 「rejected 行没有按钮」这条断言因此假红。
 *
 * 现在只比**字符串子节点**：`<Button><Icon/>{label}</Button>` 里 `label` 是
 * 一个直接的字符串子节点，而整行展开按钮的 children 是元素 + 元素，不含裸字符串
 * 等于动作按钮名。
 */
function buttonByText(label: string): { props: Record<string, unknown> } | undefined {
  return buttons().find((b) => {
    const kids = b.props.children;
    const flat = Array.isArray(kids) ? kids : [kids];
    return flat.some((k) => typeof k === "string" && k === label);
  });
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

/** 单独挂一行（测按钮、输入框、展开详情）。 */
async function mountRow(props: {
  task: Task;
  decision?: "accept" | "reject" | null;
  draft?: string;
  /** 【T111】展开详情区。与 `decision` 独立 —— 「展开看」和「在填理由」是两件事。 */
  expanded?: boolean;
  sessionTitle?: string | undefined;
  sessionMapReady?: boolean;
  /** 【T109-C】审批记录（默认空 + scope "none"）。 */
  approvals?: Approval[];
  approvalsLoading?: boolean;
  approvalsScope?: "session" | "none";
}): Promise<{ submitted: unknown[]; drafts: string[] }> {
  const submitted: unknown[] = [];
  const drafts: string[] = [];
  const state = { decision: props.decision ?? null, draft: props.draft ?? "" };
  __mount(() =>
    TaskRow({
      task: props.task,
      expanded: props.expanded ?? false,
      decision: state.decision,
      draft: state.draft,
      busy: false,
      sessionTitle: props.sessionTitle,
      sessionMapReady: props.sessionMapReady ?? true,
      // 【T109-C】审批段。默认空 + 未加载 —— 只验「没有它时不渲染」；
      // 有数据的渲染在 5g 节单独挂。
      approvals: props.approvals ?? [],
      approvalsLoading: props.approvalsLoading ?? false,
      approvalsScope: props.approvalsScope ?? "none",
      onToggle: () => submitted.push("toggle"),
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

/* ================== 5b. 来源类型图标（T109-B） ================== */
section("5b. 来源类型：五种 kind 各有图标，且互不相同");
{
  const kinds = ["session", "user", "agent", "workflow", "automation"] as const;
  const seen: Array<{ kind: string; icon: unknown }> = [];
  for (const kind of kinds) {
    await mountRow({
      task: task({
        id: `t_${kind}`,
        goal: `来源-${kind}`,
        status: "running",
        origin: { kind, ref: "ref_1" } as Task["origin"],
      }),
    });
    // 图标节点带 data-origin-kind（见 TaskRow 的渲染）。
    const holder = __nodes().find((n) => n.props["data-origin-kind"] !== undefined);
    check(`★ ${kind} 行画了来源图标`, holder !== undefined, __nodes().length);
    eq(`${kind} 的 data-origin-kind 正确`, holder?.props["data-origin-kind"], kind);
    check(`${kind} 有 title（鼠标悬停能看见是什么来源）`,
      typeof holder?.props.title === "string" && (holder.props.title as string).length > 0,
      holder?.props.title);
    const child = (holder?.props.children ?? null) as { type?: unknown } | null;
    // ⚠️ 这条防的是「只画了 data-origin-kind 这个测试钩子、忘了画图标本身」——
    // 上面那些断言全靠钩子定位，光有钩子没有图标时它们会全绿。
    check(`★ ${kind} 的钩子里真的有一个图标元素（不是只有 data 属性）`,
      child !== null && typeof child === "object" && "type" in child,
      child === null ? null : Object.keys(child as object));
    seen.push({ kind, icon: child?.type });
    __unmount();
  }
  // 五个图标互不相同 —— 否则「分了五种」在界面上看不出区别。
  const uniq = new Set(seen.map((x) => x.icon));
  eq("★ 五种来源的图标互不相同", uniq.size, 5);
  // 正控：证明这条比对不是恒真（把两个 kind 指向同一个图标会掉到 4）。
  check("★ 正控：图标集合确实能区分（5 个独立值）", uniq.size === kinds.length && kinds.length === 5);
}

/* ================== 5c. 任务详情视图（T111） ================== */
section("5c. 详情：展开、顺序、来源三种情况");

/** 详情区里各段的出现顺序（用 data-detail 标记取）。 */
function detailOrder(): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (v === null || v === undefined || typeof v !== "object") return;
    if (Array.isArray(v)) return void v.forEach(walk);
    const o = v as { props?: Record<string, unknown> };
    const mark = o.props?.["data-detail"];
    if (typeof mark === "string") out.push(mark);
    walk(o.props?.children);
  };
  walk(__nodes().map((n) => n.props.children));
  return out;
}
/** 详情区是否渲染了（存在 data-task-detail 容器）。 */
function detailRendered(): boolean {
  return __nodes().some((n) => n.props["data-task-detail"] === "");
}
/** 面板渲染出的任务行（按 data-task-id 取）。 */
function nodesWithId(): Array<{ props: Record<string, unknown> }> {
  return __nodes().filter((n) => n.props["data-task-id"] !== undefined);
}

/** 展开开关按钮。 */
function toggleButton(): { props: Record<string, unknown> } | undefined {
  return __nodes().find((n) => n.props["data-toggle-expand"] === "") as
    | { props: Record<string, unknown> }
    | undefined;
}

{
  // ---- 折叠态：详情不渲染 ----
  await mountRow({ task: task({ id: "d1", goal: "收起状态", status: "done" }) });
  check("★ 折叠时详情区不渲染", !detailRendered());
  const tb = toggleButton();
  check("★ 整行有展开开关（aria-expanded=false）",
    tb !== undefined && tb.props["aria-expanded"] === false, tb?.props["aria-expanded"]);
  __unmount();

  // ---- 展开态：五段按 T111 顺序 ----
  await mountRow({
    task: task({
      id: "d2", goal: "失败的任务", status: "failed",
      failureReason: "脚本超时", artifacts: [{ path: "/w/a.md", description: "报告草稿", createdAt: 1 }],
      // 来源必须是 session 才会去查标题（默认 fixture 是 agent，不看 sessionTitle）。
      origin: { kind: "session", ref: "sess_d2" },
    }),
    expanded: true,
    sessionTitle: "整理销售数据",
  });
  check("★ 展开时详情区渲染", detailRendered());
  const order = detailOrder();
  eq("★ 详情区顺序：失败原因在产物之前", order.slice(0, 2), ["failure", "artifacts"]);
  check("★ 详情区最后是来源与 meta", order.at(-2) === "origin" && order.at(-1) === "meta", order);
  const txt = deepText();
  check("★ 展开后能看到失败原因原文", txt.includes("脚本超时"), txt.slice(0, 120));
  check("★ 展开后能看到产物描述", txt.includes("报告草稿"));
  check("★ 展开后能看到会话标题", txt.includes("整理销售数据"));
  // goal 只该出现一次（详情区不重复它）。数的是**字符串子节点**，
  // 不数 aria/title 等属性里可能出现的同名字串。
  const goalTextNodes = __nodes().filter((n) => {
    const kids = n.props.children;
    const flat = Array.isArray(kids) ? kids : [kids];
    return flat.some((k) => k === "失败的任务");
  });
  eq("★ 详情里不重复 goal（只出现一次）", goalTextNodes.length, 1);
  __unmount();

  // ---- acceptance === null 时不显示验收段 ----
  await mountRow({
    task: task({ id: "d3", goal: "没验收", status: "done" }),
    expanded: true, sessionTitle: "x",
  });
  check("★ acceptance === null 时不渲染验收段", !detailOrder().includes("acceptance"), detailOrder());
  __unmount();

  // ---- accepted 时显示验收证据（且在来源之前） ----
  await mountRow({
    task: task({
      id: "d4", goal: "已验收", status: "accepted",
      acceptance: { round: 1, decidedAt: 2, evidence: "打开看过，8 页都在" },
    }),
    expanded: true, sessionTitle: "x",
  });
  const o4 = detailOrder();
  check("★ accepted 显示验收证据", o4.includes("acceptance"), o4);
  check("★ 验收证据在来源之前", o4.indexOf("acceptance") < o4.indexOf("origin"), o4);
  check("★ 验收证据原文可见", deepText().includes("打开看过，8 页都在"));
  __unmount();
}

section("5d. 来源的三种情况不能混");
{
  // (1) 标题查得到
  await mountRow({
    task: task({ id: "s1", goal: "g", status: "running", origin: { kind: "session", ref: "sess_abc" } }),
    expanded: true, sessionTitle: "我的对话", sessionMapReady: true,
  });
  const t1 = deepText();
  check("★ 有标题：显示会话标题", t1.includes("我的对话"), t1.slice(0, 150));
  check("★ 有标题：也显示会话 id", t1.includes("sess_abc"));
  __unmount();

  // (2) 表已加载但查不到 -> 已删除
  await mountRow({
    task: task({ id: "s2", goal: "g", status: "running", origin: { kind: "session", ref: "sess_gone" } }),
    expanded: true, sessionTitle: undefined, sessionMapReady: true,
  });
  const t2 = deepText();
  check("★ 查不到：说「已删除的对话」，不谎称「来自一个对话」",
    t2.includes("已删除"), t2.slice(0, 150));
  check("★ 查不到：仍显示会话 id 作诊断", t2.includes("sess_gone"));
  __unmount();

  // (3) 表还没加载 -> 不谎称已删除
  await mountRow({
    task: task({ id: "s3", goal: "g", status: "running", origin: { kind: "session", ref: "sess_wait" } }),
    expanded: true, sessionTitle: undefined, sessionMapReady: false,
  });
  const t3 = deepText();
  check("★ 未加载：**不**说已删除（那是「还不知道」）", !t3.includes("已删除"), t3.slice(0, 150));
  check("★ 未加载：仍显示会话 id", t3.includes("sess_wait"));
  __unmount();

  // user：不显示 ref
  await mountRow({
    task: task({ id: "s4", goal: "g", status: "running", origin: { kind: "user", ref: "u_ref_xyz" } }),
    expanded: true, sessionMapReady: true,
  });
  const t4 = deepText();
  check("★ user 不显示 ref（没有可去的地方）", !t4.includes("u_ref_xyz"), t4.slice(0, 150));
  check("★ user 显示「你直接创建的」", t4.includes("你直接创建"));
  __unmount();

  // workflow：显示 ref
  await mountRow({
    task: task({ id: "s5", goal: "g", status: "running", origin: { kind: "workflow", ref: "wf_789" } }),
    expanded: true, sessionMapReady: true,
  });
  check("★ workflow 显示 ref（能去找那个工作流）", deepText().includes("wf_789"));
  __unmount();
}

section("5e. 同时只能展开一条（这是 280px 的后果，不是审美）");
{
  /**
   * ⚠️ **这一节验的是 `TaskRow` 收到的 `expanded` prop**，不是 DOM。
   *
   * 极小 React 运行时（fakeReact）**不执行子组件** —— 面板树里 `TaskRow` 只是一个
   * `{type, props}` 节点，它内部的 `<li data-task-id>` 不会被渲染出来。
   * 所以「哪几行处于展开」只能看**传给每个 TaskRow 的 `expanded`**：
   * 那正是面板 `expandedId` 单值状态的直接投影。
   *
   * 从这个投影能验的就是本条判据的全部内容：**任意时刻最多一行为 true**。
   */
  const rowProps = (): Array<{ id: string; expanded: boolean }> =>
    __nodes()
      .filter((n) => (n.props as { task?: unknown }).task !== undefined)
      .map((n) => ({
        id: ((n.props as { task: { id: string } }).task).id,
        expanded: (n.props as { expanded?: boolean }).expanded === true,
      }));

  await mountPanel([
    task({ id: "e3", goal: "甲", status: "running" }),
    task({ id: "e4", goal: "乙", status: "running" }),
  ]);
  const rows = rowProps();
  eq("★ 正控：面板把两行交给了 TaskRow", rows.map((r) => r.id), ["e3", "e4"]);
  eq("初始：没有任何一行展开", rows.filter((r) => r.expanded).length, 0);

  // 点第一行的展开开关 —— 直接调 TaskRow 的 onToggle（面板传下去的真 handler）。
  const toggles = __nodes().filter((n) => (n.props as { task?: unknown }).task !== undefined);
  (toggles[0]!.props.onToggle as () => void)();
  await flush(3);
  let now = rowProps();
  eq("★ 展开甲：恰好一行为 true", now.filter((r) => r.expanded).length, 1);
  eq("★ 展开的正是甲", now.find((r) => r.expanded)?.id, "e3");

  // 点第二行：甲必须被收起（面板只有**一个** expandedId 槽）。
  const toggles2 = __nodes().filter((n) => (n.props as { task?: unknown }).task !== undefined);
  (toggles2[1]!.props.onToggle as () => void)();
  await flush(3);
  now = rowProps();
  eq("★ 展开乙后**仍然只有一行为 true**（甲被收起）", now.filter((r) => r.expanded).length, 1);
  eq("★ 现在展开的是乙", now.find((r) => r.expanded)?.id, "e4");
  __unmount();

  // 再点同一行 = 收起
  await mountPanel([task({ id: "e5", goal: "丙", status: "running" })]);
  const t1 = __nodes().find((n) => (n.props as { task?: unknown }).task !== undefined);
  (t1!.props.onToggle as () => void)();
  await flush(3);
  eq("展开：一行为 true", rowProps().filter((r) => r.expanded).length, 1);
  const t2 = __nodes().find((n) => (n.props as { task?: unknown }).task !== undefined);
  (t2!.props.onToggle as () => void)();
  await flush(3);
  eq("★ 再点同一行 = 收起（零行为 true）", rowProps().filter((r) => r.expanded).length, 0);
  __unmount();
}

/**
 * 5f. 审批段：**文案必须体现「会话范围」**（T109-C 的核心产品判断）。
 *
 * ## 为什么这条断言比它看起来重要
 *
 * `approvals` 表只有 `session_id`，没有 `task_id` —— 而 `autoCreate.ts` 是
 * **每个 `turn.done` 建一个任务**。所以「按会话拉审批」意味着**每条任务都会显示
 * 整个会话的全部审批**。
 *
 * 两种处理：
 *   ① 假装精确（标题写「本任务的审批」）—— **界面在说谎**；
 *   ② 诚实标注（写「这个对话里的全部」）—— 本实现。
 *
 * **这条断言守的是「不说谎」**：如果哪天有人把标题改成「本任务的审批」，
 * 它必须红。**光有注释不够** —— 注释不会失败。
 */
section("5f. 审批段：显示会话范围，不假装是「本任务的」");
{
  // (a) 没有会话来源时（origin 不是 session）—— 不渲染审批段。
  await mountRow({
    task: task({ id: "ap0", goal: "g", status: "running", origin: { kind: "user", ref: "u1" } }),
    expanded: true, approvalsScope: "none",
  });
  check("★ origin 不是会话时不渲染审批段", !detailOrder().includes("approvals"), detailOrder());
  __unmount();

  // (b) 会话有审批 —— 显示记录 + 范围说明。
  await mountRow({
    task: task({ id: "ap1", goal: "g", status: "failed", failureReason: "x" }),
    expanded: true, sessionTitle: "t", approvalsScope: "session",
    approvals: [
      { id: "a1", sessionId: "s1", kind: "tool", subject: "读取 config.json",
        decision: "allow", always: false, decidedAt: 2, detail: null },
      { id: "a2", sessionId: "s1", kind: "plan", subject: "第一步：收集数据",
        decision: "approved", always: false, decidedAt: 1, detail: null },
    ] as Approval[],
  });
  check("★ 有审批时渲染审批段", detailOrder().includes("approvals"), detailOrder());
  const text = deepText();

  // ⚠️ 核心断言：范围必须说清。
  check("★ 标题说明这是「这个对话里的全部」", text.includes("这个对话里的全部"), text.slice(0, 260));
  // 反向：不许声称是本任务的。
  check("★ 不声称是「本任务的审批」（那会是谎话）",
    !text.includes("本任务的审批") && !text.includes("这条任务的审批"), text.slice(0, 260));

  check("★ 审批条目渲染出来了", text.includes("读取 config.json") && text.includes("第一步：收集数据"));
  check("★ 七种结论各有自己的文案（allow 显示「允许」）", text.includes("允许"), text.slice(0, 260));
  check("★ 计划批准显示「批准了计划」（不是笼统的「允许」）", text.includes("批准了计划"));
  __unmount();

  // (c) 加载中 / 空态
  await mountRow({
    task: task({ id: "ap2", goal: "g", status: "running" }),
    expanded: true, approvalsScope: "session", approvals: [], approvalsLoading: true,
  });
  check("★ 加载中显示「正在读取…」", deepText().includes("正在读取"), deepText().slice(0, 200));
  __unmount();

  await mountRow({
    task: task({ id: "ap3", goal: "g", status: "running" }),
    expanded: true, approvalsScope: "session", approvals: [], approvalsLoading: false,
  });
  const emptyText = deepText();
  check("★ 空态说清「这个对话里还没有审批记录」", emptyText.includes("还没有审批记录"), emptyText.slice(0, 200));
  // 空态不能写成「记录丢了」那类表述 —— 那会让人以为系统出错。
  check("★ 空态不说「丢失 / 失败」", !emptyText.includes("丢失") && !emptyText.includes("记录失败"));
  __unmount();

  // (d) cancelled 不能显示成「拒绝」（T109 的核心区分）
  await mountRow({
    task: task({ id: "ap4", goal: "g", status: "running" }),
    expanded: true, approvalsScope: "session",
    approvals: [
      { id: "c1", sessionId: "s1", kind: "tool", subject: "Write",
        decision: "cancelled", always: false, decidedAt: 1, detail: null },
    ] as Approval[],
  });
  const cancelText = deepText();
  check("★ cancelled 显示「会话取消」", cancelText.includes("会话取消"), cancelText.slice(0, 200));
  check("★ cancelled **不**显示成「拒绝」（用户没拒绝过任何东西）",
    !cancelText.includes("拒绝"), cancelText.slice(0, 200));
  __unmount();
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
