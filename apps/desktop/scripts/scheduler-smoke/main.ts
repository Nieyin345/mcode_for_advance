/**
 * 调度器冒烟 · **核心**:并发与依赖 / 并发上限 / 失败传播 / 取消 / 前置检查 /
 * 提示词拼装 / 边界。夹具与假执行器见 `./harness.js`(`scheduler-smoke` 三套共用)。
 *
 * Run: scripts/scheduler-smoke/run.sh
 */
import { runWorkflow } from "@main/orchestration/scheduler.js";
import { composeNodePrompt, planOf } from "@main/orchestration/schedulerPrompt.js";
import { join } from "node:path";
import { check, eq, makePorts, node, branchNode, edge, docOf, outcomeOf, controller, sleep, AGENT, SHELL, LOOSE, BRANCH, CONVERSATION, RETRY_AGENT, MANIFESTS, PLAN, summary, type Harness, type Call } from "./harness.js";

/* ────────────────────── 1. 并发与依赖 ────────────────────── */

console.log("\n并发与依赖");

// A、B 互不依赖(两个根);C 只等 A;D 等 A 和 B。
// 关键:C 只该等 A —— **不该等 B**。所以 B 拖长,C 的开始时间仍然贴着 A 的结束。
const diamond = docOf(
  [node("A"), node("B"), node("C"), node("D")],
  [edge("A", "C"), edge("A", "D"), edge("B", "D")],
);

{
  const h = makePorts({ delayMs: (id) => (id === "A" ? 30 : id === "B" ? 90 : 5) });
  const result = await runWorkflow({
    doc: diamond,
    prompt: "把这件事办了",
    ports: h.ports,
    signal: controller().signal,
  });

  const at = (id: string): Call | undefined => h.calls.find((c) => c.id === id);
  const [a, b, c, d] = ["A", "B", "C", "D"].map(at);

  check("四个节点都跑了", h.calls.length === 4, h.executed());
  check("没有节点被跑两次", new Set(h.executed()).size === 4);
  eq("全成功 → status = success", result.status, "success");

  // 同列(这里就是"互不依赖")真的并发:两个根的时间窗必须重叠。
  check(
    "两个根真的并发(A 与 B 的时间窗重叠)",
    a !== undefined && b !== undefined && a.start < b.end && b.start < a.end,
    { a, b },
  );
  // 依赖真的严格:下游在上游**结束之后**才开始。
  check("C 在 A 结束之后才开始", c !== undefined && a !== undefined && c.start >= a.end, {
    aEnd: a?.end,
    cStart: c?.start,
  });
  // 就绪即派发:C 只等 A,不该被慢的 B 拖住。
  check(
    "C 没有被无关的慢节点 B 拖住(C 在 B 结束前就开跑了)",
    c !== undefined && b !== undefined && c.start < b.end,
    { cStart: c?.start, bEnd: b?.end },
  );
  check(
    "D 在上游里最晚结束的那个之后才开始",
    d !== undefined && a !== undefined && b !== undefined && d.start >= Math.max(a.end, b.end),
    { d },
  );

  const startedCount = h.reports.filter((r) => r.kind === "node.started").length;
  eq("每个节点都报了 started", startedCount, 4);
  eq(
    "每个节点都报了 settled",
    h.reports.filter((r) => r.kind === "node.settled").length,
    4,
  );
}

/* ────────────────── 并发上限(一张图一次能烧几路)──────────────────
 *
 * 一张图跑到某一步时,所有就绪的节点会**同时**起跑,而每个节点是一个独立的隐藏会话 +
 * 一个 CLI 子进程 + 一路模型请求。所以"图有多宽"直接等于"同时烧几路"。
 *
 * 这一节盯两件事:**闸真的起作用**(任意时刻在飞的 ≤ 上限),以及**排队不是失败**
 * (被挡下的那些最后**都跑到了**)—— 第二件同样是重点,只验第一件的话,一个"到上限就
 * 把剩下的丢掉"的实现也能过。
 */

console.log("\n并发上限");

/** 六个互不依赖的根 —— 不限并发的话它们会在同一个 tick 里全部起跑。 */
const wide = docOf(
  ["A", "B", "C", "D", "E", "F"].map((id) => node(id)),
  [],
);

{
  // 上限 2。执行器跑 20ms,期间记一个"同时在跑几个"的峰值。
  let running = 0;
  let peak = 0;
  const h = makePorts({
    delayMs: () => 20,
    maxParallel: () => 2,
    onExecute: () => {
      running += 1;
      peak = Math.max(peak, running);
      return () => {
        running -= 1;
      };
    },
  });
  const result = await runWorkflow({
    doc: wide,
    prompt: "跑六个",
    ports: h.ports,
    signal: controller().signal,
  });

  eq("★ 任意时刻在跑的没超过上限", peak, 2);
  eq("★ 六个最后都跑到了(排队不是失败)", h.calls.length, 6);
  eq("一个都没被跑两次", new Set(h.executed()).size, 6);
  eq("全成功", result.status, "success");
  // 派发顺序是**文档顺序** —— 用户看到的是"按图的先后一批一批来",不是随机。
  eq("头两个是 A、B", h.executed().slice(0, 2).join(","), "A,B");
}

{
  // 上限 ≥ 节点数 = 和今天一模一样(回归)。这一条防的是"加了闸之后把原本并发的弄成串行"。
  let running = 0;
  let peak = 0;
  const h = makePorts({
    delayMs: () => 20,
    maxParallel: () => 99,
    onExecute: () => {
      running += 1;
      peak = Math.max(peak, running);
      return () => {
        running -= 1;
      };
    },
  });
  await runWorkflow({
    doc: wide,
    prompt: "跑六个",
    ports: h.ports,
    signal: controller().signal,
  });
  eq("★ 上限够大时六个一起跑(没有意外串行化)", peak, 6);
}

{
  // ⚠️ **读到一个非法值时不能把图卡死。** 0 / 负数 / NaN 都退回"不限" —— 上限为 0 的话
  // 一个节点都派不出去,而循环会因为"没有在飞的、也没有东西可动"直接退出,现象是
  // "点了运行,什么都没发生"(比多花钱糟得多)。
  for (const bad of [0, -3, Number.NaN]) {
    const h = makePorts({ delayMs: () => 5, maxParallel: () => bad });
    await runWorkflow({
      doc: wide,
      prompt: "跑六个",
      ports: h.ports,
      signal: controller().signal,
    });
    eq(`上限读到 ${String(bad)} 也不卡死(六个都跑了)`, h.calls.length, 6);
  }
}

{
  // 不接 `maxParallel` 这个端口 = 老行为(不限)。这是**向后兼容**那一条:冒烟脚本和
  // 别的宿主实现没接它的时候,一张图照旧全速跑。
  const h = makePorts({ delayMs: () => 5 });
  await runWorkflow({
    doc: wide,
    prompt: "跑六个",
    ports: h.ports,
    signal: controller().signal,
  });
  eq("没接这个端口 = 不限(六个都跑了)", h.calls.length, 6);
}

/* ────────────────────── 2. 失败传播 ────────────────────── */

console.log("\n失败传播");

// A 失败 → C(直接下游)与 E(传递下游)都不该被派发;B 是另一条分支,照常跑完。
const failing = docOf(
  [node("A"), node("B"), node("C"), node("D"), node("E")],
  [edge("A", "C"), edge("C", "E"), edge("B", "D")],
);

{
  const h = makePorts({ fail: (id) => id === "A" });
  const result = await runWorkflow({
    doc: failing,
    prompt: "跑",
    ports: h.ports,
    signal: controller().signal,
  });

  eq("有失败 → status = failed", result.status, "failed");
  eq("失败的节点标 failed", outcomeOf(h, "A")?.status, "failed");
  eq("失败原因来自执行器", outcomeOf(h, "A")?.error, "A 炸了");
  eq("直接下游标 skipped", outcomeOf(h, "C")?.status, "skipped");
  eq("传递下游也标 skipped", outcomeOf(h, "E")?.status, "skipped");
  check(
    "skipped 的原因是「上游没成功」,而且点名是哪一个",
    (outcomeOf(h, "C")?.error ?? "").includes("A"),
    outcomeOf(h, "C")?.error,
  );
  eq("无关分支照常跑完", outcomeOf(h, "D")?.status, "success");

  const ran = h.executed();
  check("被跳过的节点**一次都没被执行**", !ran.includes("C") && !ran.includes("E"), ran);
  eq("只有该跑的两个跑过", ran.length, 3);
  eq("每个节点都有结局(不留空)", result.outcomes.size, 5);
}

/* ────────────────────── 3. 取消 ────────────────────── */

console.log("\n取消");

{
  const abort = controller();
  const chain = docOf([node("A"), node("B")], [edge("A", "B")]);
  const h = makePorts({ delayMs: () => 60 });
  setTimeout(() => abort.abort(), 20);

  const result = await runWorkflow({
    doc: chain,
    prompt: "跑",
    ports: h.ports,
    signal: abort.signal,
  });

  eq("被取消 → status = cancelled", result.status, "cancelled");
  const ran = h.executed();
  check("取消之后没有新的派发(B 没跑过)", !ran.includes("B"), ran);
  eq("没派发到的节点标 cancelled", outcomeOf(h, "B")?.status, "cancelled");
  eq("在飞的那个也收了场", outcomeOf(h, "A")?.status, "cancelled");
  check("每个节点都有结局", result.outcomes.size === 2);
}

/* ────────────────────── 4. 前置检查 ────────────────────── */

console.log("\n前置检查(三种都明确失败,而且往下传播)");

{
  // 类型没装 —— 别人分享来的图会走到这里。
  const h = makePorts();
  const missing = docOf(
    [node("A", "x.ghost"), node("B")],
    [edge("A", "B")],
  );
  await runWorkflow({ doc: missing, prompt: "跑", ports: h.ports, signal: controller().signal });
  eq("类型没装 → failed", outcomeOf(h, "A")?.status, "failed");
  check("失败原因说清是哪个类型", (outcomeOf(h, "A")?.error ?? "").includes("x.ghost"), outcomeOf(h, "A")?.error);
  check("它的下游没有被派发", !h.executed().includes("B"), h.executed());
  eq("下游标 skipped", outcomeOf(h, "B")?.status, "skipped");
}

{
  // `runner.entry`(清单自带脚本)**现在跑得起来了** —— 2026-09-20 实现。
  //
  // 这一条原先断的是"未实现的执行方式 → failed"(那时 `isNodeRunnable` 见到 `entry`
  // 直接判不可跑)。实现之后那个限制没了,所以断言改成钉**新行为**:认可它可跑、
  // 真的把这一步派发下去(而不是像从前那样连执行都不执行)。
  //
  // ⚠️ 脚本本身跑不跑得成是 `entry-runner-smoke` 的事(那边拿假 spawn 钉路径解析
  // 与防逃逸)。这里只钉**调度器认不认它**。
  const h = makePorts();
  await runWorkflow({
    doc: docOf([node("A", SHELL.id)], []),
    prompt: "跑",
    ports: h.ports,
    signal: controller().signal,
  });
  check("entry 型 command 现在可跑了(不再判不可跑)", h.executed().includes("A"), h.executed());
}

{
  // 必填参数没填 —— 存盘时就被拦了,但清单可能在文档存盘之后改过,所以解算前再校验。
  const h = makePorts();
  await runWorkflow({
    doc: docOf([{ ...node("A"), params: {} }], []),
    prompt: "跑",
    ports: h.ports,
    signal: controller().signal,
  });
  eq("必填参数没填 → failed", outcomeOf(h, "A")?.status, "failed");
  check("原因点名是哪个参数", (outcomeOf(h, "A")?.error ?? "").includes("指令"), outcomeOf(h, "A")?.error);
  check("没有真的去执行", h.calls.length === 0);
}

{
  // 提示词节点连指令参数都没声明 —— 校验过得了,拼提示词时才暴露。
  const h = makePorts();
  await runWorkflow({
    doc: docOf([{ ...node("A", LOOSE.id), params: {} }], []),
    prompt: "跑",
    ports: h.ports,
    signal: controller().signal,
  });
  eq("没有指令参数 → failed", outcomeOf(h, "A")?.status, "failed");
  check("失败原因说得出口", (outcomeOf(h, "A")?.error ?? "").includes("instruction"), outcomeOf(h, "A")?.error);
  check("没有真的去执行", h.calls.length === 0);
}

{
  // 取清单那一步自己抛了。**这是"每个节点都必须留下结局"那条不变式的回归用例** ——
  // 没定案的节点会被当成"还没跑"重新派发,那是死循环,而症状是**这个用例根本跑不完**。
  //
  // 判据用的是**类型 id**:端口那一层只知道节点引用了哪个类型,不知道它在图上的 id。
  const h = makePorts({ manifestThrows: (typeId) => typeId === "x.boom" });
  const result = await runWorkflow({
    doc: docOf([node("A", "x.boom"), node("B")], [edge("A", "B")]),
    prompt: "跑",
    ports: h.ports,
    signal: controller().signal,
  });
  eq("取清单抛错 → 那个节点标 failed", outcomeOf(h, "A")?.status, "failed");
  check(
    "抛出来的原因传下来了",
    (outcomeOf(h, "A")?.error ?? "").includes("清单读不出来"),
    outcomeOf(h, "A")?.error,
  );
  check("它的下游没有被派发", !h.executed().includes("B"), h.executed());
  eq("两个节点都有结局", result.outcomes.size, 2);
}

/* ────────────────────── 5. 提示词拼装 ────────────────────── */

console.log("\n提示词拼装");

{
  const root = composeNodePrompt({
    userPrompt: "帮我把这篇论文读懂",
    upstream: "",
    instruction: "先定位原文",
    nodeId: "A",
    plan: PLAN,
  });
  check("根节点拿到用户请求", root.includes("帮我把这篇论文读懂"));
  check("根节点拿到本步指令", root.includes("先定位原文"));
  check("根节点没有「上游」那一段", !root.includes("上游步骤的结果"));

  const downstream = composeNodePrompt({
    userPrompt: "帮我把这篇论文读懂",
    upstream: "### 定位\n找到了 3 篇",
    instruction: "整理成表格",
    nodeId: "D",
    plan: PLAN,
  });
  check("非根节点拿到上游结果", downstream.includes("找到了 3 篇"));
  check("非根节点拿到本步指令", downstream.includes("整理成表格"));
  // 这条是刻意的设计(见 `composeNodePrompt` 的注释):不共享对话记录,token 不随
  // 图的大小膨胀。代价是下游指令必须自足。
  check("非根节点**看不到**用户原话", !downstream.includes("帮我把这篇论文读懂"));

  // **「整条流程」是这一节存在的理由**(见 `planSection`)。隔离的节点看不到别的步骤,不给它
  // 看整条流程,第一步就会把整件事干完 —— 用户看到的现象正是"第一个代理全做完了,
  // 后面没东西可传"。
  check("把整条流程列出来了", root.includes("## 流程位置"), root.slice(0, 400));
  check("每一步的名字都在", root.includes("查文献") && root.includes("汇总"), root.slice(0, 400));
  check("标出了自己在哪一格", root.includes("← 你在这里"), root.slice(0, 400));
  check("同层说明它们之间没有先后", root.includes("这几步之间没有先后"), root.slice(0, 400));
  check("而且被按住了:只做「规划」", root.includes("只需完成「规划」这一步"), root.slice(0, 700));
  check("下游节点也看得到整条流程", downstream.includes("查文献"), downstream);
  check("末尾节点知道没人接手", downstream.includes("你负责的是最后一步"), downstream);
  // 末尾节点**不该**被按住 —— 它后面没有人,按住它就是让它别做完。
  check("末尾节点不被按住", !downstream.includes("只需完成「"), downstream);
  check("非根节点知道上游结果在下面", downstream.includes("上游"), downstream);
}

{
  // 技能那一段。**提示词里那一行字和交给提供方的允许清单是两件事**,少一件就是
  // "写了但没用":光有字,模型调不动 Skill 工具;光有清单,模型不知道该用。
  const withSkills = composeNodePrompt({
    userPrompt: "读这篇",
    upstream: "",
    instruction: "先解析原文",
    nodeId: "A",
    plan: PLAN,
    skills: ["pdf", "docx"],
  });
  check("拼出「这一步要用的技能」那一段", withSkills.includes("## 这一步要用的技能"));
  // `/名字` 是输入框里技能药丸的同一种写法 —— 模型认得。
  check(
    "技能写成 /名字",
    withSkills.includes("- /pdf") && withSkills.includes("- /docx"),
    withSkills,
  );
  check(
    "没选技能就不拼那一段",
    !composeNodePrompt({
      userPrompt: "",
      upstream: "",
      instruction: "x",
      nodeId: "A",
      plan: PLAN,
    }).includes("这一步要用的技能"),
  );
}

{
  // 参数 → 执行器的那一步(`nodeInputOf`):**执行的这一头也要真的拿到**。
  const h = makePorts();
  await runWorkflow({
    doc: docOf(
      [
        node("A", AGENT.id, "先解析原文", {
          skills: ["pdf"],
          mcp: ["browser", "zotero"],
          plugins: ["mcode-document-skills"],
        }),
        node("B", AGENT.id, "整理"),
      ],
      [edge("A", "B")],
    ),
    prompt: "读这篇",
    ports: h.ports,
    signal: controller().signal,
  });
  const a = h.calls.find((c) => c.id === "A");
  const b = h.calls.find((c) => c.id === "B");
  check("技能的允许清单交给了执行器", (a?.skills ?? []).join(",") === "pdf", a?.skills);
  check("提示词里也有技能那一段", (a?.prompt ?? "").includes("- /pdf"), a?.prompt);
  check("MCP 服务器的允许清单也交给了执行器", (a?.mcpServerNames ?? []).join(",") === "browser,zotero", a?.mcpServerNames);
  check("插件的允许清单也交给了执行器", (a?.pluginNames ?? []).join(",") === "mcode-document-skills", a?.pluginNames);
  // **空数组而不是 undefined**:执行器据此判断"要不要带 skills 上去",让它去猜
  // undefined 和 [] 的区别,就是把契约的细节漏进了实现。
  check("没写技能的节点拿到空数组", Array.isArray(b?.skills) && b.skills.length === 0, b?.skills);
  check("没写技能的节点提示词里没有那一段", !(b?.prompt ?? "").includes("这一步要用的技能"));
  // 三个"可选的东西"必须是同一种读法 —— 少了这一条,以后很容易只给技能做空数组、
  // 另两个漏回 undefined,而"漏回 undefined"在执行器那头正好是**不限制**(全给)。
  check("没写 MCP 的节点也是空数组", Array.isArray(b?.mcpServerNames) && b.mcpServerNames.length === 0, b?.mcpServerNames);
  check("没写插件的节点也是空数组", Array.isArray(b?.pluginNames) && b.pluginNames.length === 0, b?.pluginNames);
  // 脏值(两边带空白、重复)在契约那一头就被滤掉了,执行器拿到的是干净的。
  //
  // ⚠️ **这里只能喂"形状合法但脏"的参数**:`validateNodeParams` 排在前面,混进非字符串
  // 会先被判成"应该是一组名字"、这一步根本跑不到执行器 —— 那是**对的**,存进图里的参数
  // 本来就该是干净的。`nameListOf` 的宽容忍是给"AI 手写的清单"和"别人分享来的图"兜底的,
  // 那几种形状在 `workflow-view-smoke` 里逐个钉过(斜杠项、非字符串、不是数组)。
  const h2 = makePorts();
  await runWorkflow({
    doc: docOf([node("A", AGENT.id, "先解析原文", { mcp: ["  browser  ", "browser"] })], []),
    prompt: "读这篇",
    ports: h2.ports,
    signal: controller().signal,
  });
  check(
    "空白与重复在到执行器之前就清掉了",
    (h2.calls.find((c) => c.id === "A")?.mcpServerNames ?? []).join(",") === "browser",
    h2.calls.find((c) => c.id === "A")?.mcpServerNames,
  );
}

{
  // 拼好的那一份要真的送到执行器手上,而不是只在纯函数里对。
  const h = makePorts();
  await runWorkflow({
    doc: docOf([node("A"), node("B")], [edge("A", "B")]),
    prompt: "用户的请求",
    ports: h.ports,
    signal: controller().signal,
  });
  const a = h.calls.find((c) => c.id === "A");
  const b = h.calls.find((c) => c.id === "B");
  check("根节点那一轮带了用户请求", (a?.prompt ?? "").includes("用户的请求"), a?.prompt);
  check("下游那一轮带了上游结果", (b?.prompt ?? "").includes("A 的结果"), b?.prompt);
  check("下游那一轮没带用户请求", !(b?.prompt ?? "").includes("用户的请求"), b?.prompt);
}

{
  // 「对话节点」**不是**"没实现的执行方式" —— 它和 prompt 一样跑一轮模型,区别只在
  // **在哪儿跑**,而那是执行器的事。调度器该做的和对待 prompt 节点一模一样:拼好提示词、
  // 交给执行器、等产出、按变量表查(它没声明变量表,所以不查)。
  //
  // 为什么值得单钉一条:`isRunnerImplemented` 是一张白名单,新加一种 `runner.kind` 忘
  // 了登记的话,画布上画得出来、存得进去,一跑就被判成"这种执行方式还没实现" —— 而
  // 报错信息听起来像是功能没做,不像是漏登记。
  const h = makePorts();
  await runWorkflow({
    doc: docOf(
      [node("A", AGENT.id, "先查"), node("B", CONVERSATION.id, "按上面的结果写第三章")],
      [edge("A", "B")],
    ),
    prompt: "把这一章写出来",
    ports: h.ports,
    signal: controller().signal,
  });
  eq("对话节点照常派发(没被当成未实现的执行方式)", outcomeOf(h, "B")?.status, "success");
  const b = h.calls.find((c) => c.id === "B");
  check("它也拿得到上游的产出(拼法和其他节点同一条路)", (b?.prompt ?? "").includes("A 的结果"), b?.prompt);
  check("不是根节点就带不到用户那句原话", !(b?.prompt ?? "").includes("把这一章写出来"), b?.prompt);
  check("它的指令在提示词里", (b?.prompt ?? "").includes("按上面的结果写第三章"), b?.prompt);
}

{
  // **调度器真的把位置传下去了吗** —— 上面那几条测的是拼装函数,这几条测的是它有没有
  // 被喂对东西。`planOf` 是自己的单测,这里看的是端到端那一份。
  //
  // 这个夹具叫 diamond,但边是 `A→C、A→D、B→D` —— **两个根**(A 和 B),C 和 D 都收口。
  // 于是分层是:A、B 在第一层,C、D 在第二层(`D` 的上游 A、B 都在第 0 层,所以它是 1)。
  const h = makePorts();
  await runWorkflow({ doc: diamond, prompt: "把这件事办了", ports: h.ports, signal: controller().signal });
  const promptOf = (id: string): string => h.calls.find((c) => c.id === id)?.prompt ?? "";

  check("A 看到自己跟 B 并列", promptOf("A").includes("1. A、B"), promptOf("A").slice(0, 400));
  check("而且标出自己在哪一格", promptOf("A").includes("← 你在这里"), promptOf("A").slice(0, 400));
  check("A 被按住:只做「A」", promptOf("A").includes("只需完成「A」这一步"), promptOf("A"));
  check("C 和 D 在第二层", promptOf("C").includes("2. C、D"), promptOf("C").slice(0, 400));
  check("D 是收口", promptOf("D").includes("你负责的是最后一步"), promptOf("D"));
  check("收口没被按住(后面没人了)", !promptOf("D").includes("只需完成「"), promptOf("D"));
}

console.log("\nplanOf(从图算出来的那份计划)");

{
  const plan = planOf(diamond, (id) => id);
  eq("两层", plan.length, 2);
  eq("第一层是 A、B", plan[0]?.map((s) => s.id).join(","), "A,B");
  eq("第二层是 C、D", plan[1]?.map((s) => s.id).join(","), "C,D");
  eq("A 还有下游", plan[0]?.[0]?.isLast, false);
  eq("C 是收口", plan[1]?.find((s) => s.id === "C")?.isLast, true);
  // **只带名字,不带指令** —— 别人的指令对它没用(白烧 token),而且会引诱它越界
  // (看见"写初稿要写哪几节",它顺手就写了,而我们要的恰恰是它别写)。
  check("计划里没有节点的指令", !JSON.stringify(plan).includes("做什么"), JSON.stringify(plan));
  // 名字取的是**标题**,没起标题才退回类型 id —— 用户在画布上看到的就是这两个之一。
  eq("没起标题时用节点 id", plan[0]?.[1]?.title, "B");
  const titled = planOf(
    { ...diamond, nodes: diamond.nodes.map((n) => (n.id === "A" ? { ...n, title: "规划" } : n)) },
    (id) => (id === "A" ? "规划" : id),
  );
  eq("起了标题就用标题", titled[0]?.[0]?.title, "规划");
}

/* ────────────────────── 6. 边界 ────────────────────── */

console.log("\n边界");

{
  // 空图:一条边都没有,一个节点都没有。不该崩,也不该挂住。
  const h = makePorts();
  const result = await runWorkflow({
    doc: docOf([], []),
    prompt: "跑",
    ports: h.ports,
    signal: controller().signal,
  });
  eq("空图 → success", result.status, "success");
  eq("空图没有节点", result.outcomes.size, 0);
}

{
  // 图里有环:存盘时 `validateDag` 会拦,但真到了这里不能永远挂着。
  const h = makePorts();
  const cyclic = docOf([node("A"), node("B")], [edge("A", "B"), edge("B", "A")]);
  const result = await runWorkflow({
    doc: cyclic,
    prompt: "跑",
    ports: h.ports,
    signal: controller().signal,
  });
  eq("环上的节点有结局(不留空)", result.outcomes.size, 2);
  eq("两个都标 skipped", outcomeOf(h, "A")?.status, "skipped");
}

summary();
