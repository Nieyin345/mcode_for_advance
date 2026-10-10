/**
 * Claude SDK 任务名册的回归 —— 「任务列表」页（`ide/TaskListPanel`）背后那份数据对不对。
 *
 * ## 验的是什么
 *
 * 右栏「任务列表」页要和 Claude Code 桌面端一样:**显示任务类型（Agent / Bash）、
 * 两类都能点开**。它读的是适配器发的 `subagent.update` 里那份名册，而这份名册有三个
 * 容易错、且错了**不报错**的地方:
 *
 *  1. **bash 任务进不进名册。** 从前 `local_bash` 被**专门排除**（那时唯一的消费者是
 *     聊天流的活动胶囊，那里只该有模型分身）。现在任务列表要同时列两类，所以它得进来 ——
 *     而 `local_workflow` 仍要排除（那是 cc 内部的脚本工作流，与 mcode 自己的「工作流节点」
 *     重复）。**这两条要分别钉住**：一起放宽或一起收紧都会错。
 *  2. **主代理交给任务的原话（`prompt`）要落进快照。** 用户点开一行时最想看的就是它。
 *  3. **bash 的输出文件（`task_notification.output_file`）要落进快照。** `task_notification`
 *     这个 subtype 从前**整个没接** —— 没有它，bash 任务点开是空的。
 *
 * ## 为什么这一套单独存在
 *
 * 这几个字段是"进去就对了、错了也不报错"的形状（任务列表只是不显示某个徽标 / 点开是空的），
 * 没有任何一层会红。所以判据必须**立在名册内容上**，而且要在**真适配器**上验 ——
 * 这个文件是"事件进 → 快照出"的纯变换，喂假 SDK 消息即可，不起 Electron、不碰数据库。
 *
 * Run: scripts/task-roster-smoke/run.sh
 */
import { FileSnapshot } from "@main/lib/fileSnapshot.js";
import { SdkMessageAdapter } from "@main/providers/claude-sdk/SdkMessageAdapter.js";
import type { ProviderContext } from "@contracts/provider";
import type { RuntimeEvent, SubagentSnapshot } from "@contracts/runtime";

let checks = 0;
let failures = 0;

function check(name: string, condition: boolean, actual?: unknown): void {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${actual === undefined ? "" : ` — ${JSON.stringify(actual)}`}`);
}

function eq<T>(name: string, actual: T, expected: T): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

function makeAdapter(sessionId: string): { adapter: SdkMessageAdapter; events: RuntimeEvent[] } {
  const events: RuntimeEvent[] = [];
  const ctx: ProviderContext = {
    emit: (event) => events.push(event),
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };
  const adapter = new SdkMessageAdapter(ctx, sessionId, false, process.cwd(), new FileSnapshot());
  adapter.setSettleGate(() => {});
  return { adapter, events };
}

/** 最后一次 `subagent.update` 里那条指定 taskId 的快照（没有就 undefined）。 */
function rosterOf(events: RuntimeEvent[], sessionId: string): SubagentSnapshot[] {
  let latest: SubagentSnapshot[] = [];
  for (const e of events) {
    if (e.type === "subagent.update" && e.sessionId === sessionId) latest = e.agents;
  }
  return latest;
}

function find(events: RuntimeEvent[], sessionId: string, taskId: string): SubagentSnapshot | undefined {
  return rosterOf(events, sessionId).find((a) => a.taskId === taskId);
}

const started = (over: Record<string, unknown>): unknown => ({
  type: "system",
  subtype: "task_started",
  task_id: "t1",
  uuid: "u1",
  session_id: "s",
  ...over,
});

const progress = (over: Record<string, unknown>): unknown => ({
  type: "system",
  subtype: "task_progress",
  task_id: "t1",
  uuid: "u2",
  session_id: "s",
  usage: { total_tokens: 100, tool_uses: 2, duration_ms: 3_000 },
  ...over,
});

const notification = (over: Record<string, unknown>): unknown => ({
  type: "system",
  subtype: "task_notification",
  task_id: "t1",
  uuid: "u3",
  session_id: "s",
  status: "completed",
  output_file: "",
  summary: "",
  ...over,
});

async function main(): Promise<void> {
  /* ── 1. 两类任务都进名册，且各带正确的 taskType ── */
  console.log("\n1. 任务类型:Agent 与 Bash 都进名册,且分得开");

  {
    const { adapter, events } = makeAdapter("roster-types");
    await adapter.dispatch(
      started({ task_id: "a1", task_type: "local_agent", description: "查引用", subagent_type: "general-purpose", prompt: "把这三篇文献的引用核对一遍" }) as never,
    );
    await adapter.dispatch(
      started({ task_id: "b1", task_type: "local_bash", description: "pnpm build" }) as never,
    );
    const agent = find(events, "roster-types", "a1");
    const bash = find(events, "roster-types", "b1");
    check("★ Agent 任务进了名册", agent !== undefined, rosterOf(events, "roster-types"));
    check("★ Bash 任务也进了名册(从前被专门排除)", bash !== undefined, rosterOf(events, "roster-types"));
    eq("★ Agent 的类型是 local_agent", agent?.taskType, "local_agent");
    eq("★ Bash 的类型是 local_bash", bash?.taskType, "local_bash");
  }

  /* ── 2. local_workflow 仍然排除（别一起放宽了） ── */
  console.log("\n2. 脚本工作流仍然排除(与 mcode 自己的「工作流节点」不重复)");

  {
    const { adapter, events } = makeAdapter("roster-wf");
    await adapter.dispatch(
      started({ task_id: "w1", task_type: "local_workflow", description: "脚本工作流" }) as never,
    );
    check("★ local_workflow 不进名册", find(events, "roster-wf", "w1") === undefined, rosterOf(events, "roster-wf"));
    // 而且它的后续 progress 也不该把它合成回来（这正是记 taskTypes 的理由）。
    await adapter.dispatch(progress({ task_id: "w1" }) as never);
    check("★ 它的 progress 也不会把它合成回名册", find(events, "roster-wf", "w1") === undefined, rosterOf(events, "roster-wf"));
  }

  /* ── 3. 主代理交给它的原话落进快照 ── */
  console.log("\n3. 主代理交给子代理的任务原文(prompt)");

  {
    const { adapter, events } = makeAdapter("roster-prompt");
    await adapter.dispatch(
      started({ task_id: "a2", task_type: "local_agent", description: "查", prompt: "把 doc/ 下的论文 v5 通读一遍,列出所有引用" }) as never,
    );
    eq(
      "★ prompt 落进快照(点开时顶部要显示的就是它)",
      find(events, "roster-prompt", "a2")?.prompt,
      "把 doc/ 下的论文 v5 通读一遍,列出所有引用",
    );
    // 空 prompt 不该变成一个空串字段（界面上会渲染成一个空白的框）。
    const { adapter: a2, events: e2 } = makeAdapter("roster-prompt-empty");
    await a2.dispatch(started({ task_id: "a3", task_type: "local_agent", description: "x", prompt: "   " }) as never);
    eq("空白 prompt 不落(避免一个空白引用框)", find(e2, "roster-prompt-empty", "a3")?.prompt, undefined);
  }

  /* ── 4. task_notification:状态与 bash 输出文件 ── */
  console.log("\n4. 收场通知(task_notification):状态映射与 bash 输出文件");

  {
    const { adapter, events } = makeAdapter("roster-notify");
    await adapter.dispatch(started({ task_id: "b2", task_type: "local_bash", description: "pnpm test" }) as never);
    await adapter.dispatch(
      notification({ task_id: "b2", status: "completed", output_file: "/tmp/claude/tasks/b2.output", summary: "42 passed" }) as never,
    );
    const bash = find(events, "roster-notify", "b2");
    eq("★ completed 映射成 completed", bash?.status, "completed");
    eq("★ output_file 落进快照(bash 点开看的就是它)", bash?.outputFile, "/tmp/claude/tasks/b2.output");
    check("summary 也落了", bash?.summary === "42 passed", bash?.summary);
    check("结束时补了 endedAt", typeof bash?.endedAt === "number", bash?.endedAt);
  }

  {
    // `stopped` 是我们的状态联合里没有的一档 —— 映射到 killed（"我停的"与"它被杀"对用户是一回事）。
    const { adapter, events } = makeAdapter("roster-stopped");
    await adapter.dispatch(started({ task_id: "a4", task_type: "local_agent", description: "停我" }) as never);
    await adapter.dispatch(notification({ task_id: "a4", status: "stopped" }) as never);
    eq("★ status:stopped 映射成 killed", find(events, "roster-stopped", "a4")?.status, "killed");
  }

  {
    // 没 start 过的 task_notification 不该**凭空造**一条（任务列表会冒出用户没见过的东西）。
    const { adapter, events } = makeAdapter("roster-orphan");
    await adapter.dispatch(notification({ task_id: "never-started", status: "completed" }) as never);
    check("★ 孤儿通知不造条目", rosterOf(events, "roster-orphan").length === 0, rosterOf(events, "roster-orphan"));
  }

  /* ── 5. progress 抢在 start 前面时,类型回填得上 ── */
  console.log("\n5. progress 先到、start 后到:合成出来的条目也要有类型");

  {
    const { adapter, events } = makeAdapter("roster-order");
    // 先 start（记下类型），再模拟"条目被清掉后 progress 单独到达"的合成分支。
    await adapter.dispatch(started({ task_id: "b3", task_type: "local_bash", description: "x" }) as never);
    // 直接抹掉名册里的条目，模拟"合成"那条防御分支。
    (adapter as unknown as { state: { subagents: Map<string, unknown> } }).state.subagents.delete("b3");
    await adapter.dispatch(progress({ task_id: "b3" }) as never);
    eq(
      "★ 合成出来的条目仍带着 taskType(进度事件自己不带它)",
      find(events, "roster-order", "b3")?.taskType,
      "local_bash",
    );
  }

  console.log(`\n${checks - failures}/${checks} task-roster checks passed`);
  if (failures > 0) process.exit(1);
}

void main();
