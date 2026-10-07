/**
 * 调度器冒烟 · **控制流**:岔路口选路 / 回头(环)/ 读流程记录开关 / 续跑 /
 * 运行前先问 / 自动重试。夹具见 `../scheduler-smoke/harness.js`。
 *
 * Run: scripts/scheduler-flow-smoke/run.sh
 */
import { runWorkflow, type BranchChoice, type RunReport, type RunResume, type RunState } from "@main/orchestration/scheduler.js";
import { join } from "node:path";
import { ASK_EXIT_CHOICE, ASK_REPEAT_CHOICE, ASK_RUN_CHOICE, ASK_SKIP_CHOICE, BRANCH_STOP_CHOICE, isTransientError, retryDelayMs, retryPlanOf, shouldRetryOutcome, type NodeOutcome } from "@contracts/nodeType";
import { WorkflowChoiceOption } from "@contracts/runtime";
import { WorkflowDoc, WorkflowNode } from "@contracts/workflow";
import { check, eq, makePorts, node, branchNode, edge, docOf, outcomeOf, controller, sleep, AGENT, SHELL, LOOSE, BRANCH, CONVERSATION, RETRY_AGENT, MANIFESTS, PLAN, summary, type Harness, type Call } from "../scheduler-smoke/harness.js";

/* ────────────────────── 岔路口:选一条路 ────────────────────── */

console.log("\n岔路口");

/**
 * 写作流程的骨架,也是这套语义全部的意义所在:
 *
 *     A ──> F(下一步做什么) ──[再来一轮]──> B ──┐
 *                          └──[进入查重]──> C ──┴──> D(导出)
 *
 * 两条支路**最后汇到同一步**。用户选了一条,另一条连同它的下游一起作废 —— 而 `D`
 * **必须照跑**。
 *
 * ⚠️ 这一条要是错了,现象是"用户选了路、一路跑下来,最后发现最后一步没了",而卡片上
 * 写的还是"上游没有成功" —— 一份**错的原因**,比没有原因难查得多。
 */
const fork = docOf(
  [node("A"), branchNode("F", "下一步做什么"), node("B"), node("C"), node("D")],
  [
    edge("A", "F"),
    edge("F", "B", { label: "再来一轮", note: "在现有稿子上再改一轮。" }),
    edge("F", "C", { label: "进入查重" }),
    edge("B", "D"),
    edge("C", "D"),
  ],
);

{
  // 用户点**第一条**(再来一轮)。
  const h = makePorts({ pick: (_id, options) => ({ edgeId: options[0]?.id ?? "" }) });
  const result = await runWorkflow({
    doc: fork,
    prompt: "写一篇论文",
    ports: h.ports,
    signal: controller().signal,
  });

  eq("分支节点问了一次", h.choicesAsked.length, 1);
  eq("问的是 F", h.choicesAsked[0]?.nodeId, "F");
  eq("给了两条出路", h.choicesAsked[0]?.options.length, 2);
  eq("选项名来自边上的 label", h.choicesAsked[0]?.options[0]?.label, "再来一轮");
  // 按钮下面要显示"这条通向哪一步" —— 只给一个选项名,用户不知道点了会发生什么。
  eq("出路带着它的目标节点标题", h.choicesAsked[0]?.options[0]?.next, "B");

  check("选中的 B 跑了", h.executed().includes("B"), h.executed());
  check("没选的 C 没跑", !h.executed().includes("C"), h.executed());

  eq("C 是 unselected,不是 skipped", outcomeOf(h, "C")?.status, "unselected");
  eq("★ 汇合点 D 照跑(没走的那条路没有把它拖下水)", outcomeOf(h, "D")?.status, "success");
  eq("unselected 不算失败", result.status, "success");

  // 分支节点**不补结果卡**:它的卡就是那张选择卡,而且上面已经写着"你选了 X"了
  // (见调度器 `settle` 里那条)。补一张的话同一个节点会出现两张卡,一张是空的。
  eq("★ 分支节点不补结果卡", outcomeOf(h, "F"), undefined);

  // 用户选了什么、那条边上的说明、他自己临时写的话 —— 三样都该进下一步的提示词。
  const b = h.calls.find((c) => c.id === "B")?.prompt ?? "";
  check("B 的提示词里有「用户选了一条路」那一段", b.includes("## 本次执行的前置选择"), b.slice(0, 120));
  check("说了用户选的是哪一项", b.includes("「再来一轮」"), b.slice(0, 200));
  check("带上了边上的说明(note)", b.includes("在现有稿子上再改一轮"), b.slice(0, 300));
  // 没写就没有那一句 —— 不能凭空多一行"他另外说了一句:"
  check("用户没临时说话就不出现那一句", !b.includes("用户补充说明:"));

  // **分支是透传的** —— 岔路口不换你手上的行李。
  //
  // B 只能连分支(它再连一条别的上游,那条边是活的,它就不管选哪条路都照跑了),
  // 所以上游的内容只能挂在分支身上过来。没有这条通路,「再改一轮」那一步就得凭一句
  // 话重写一篇它没读过的稿子 —— 分叉等于把东西丢了。
  check("★ B 拿得到上游(A)的内容", b.includes("A 的结果"), b);
  check("那段还是原样,没多套一层分支的标题", !b.includes("### 下一步做什么"), b);
}

{
  // 反过来点**第二条**(进入查重)。B 那一支作废,D 照样得跑。
  const h = makePorts({ pick: (_id, options) => ({ edgeId: options[1]?.id ?? "" }) });
  const result = await runWorkflow({
    doc: fork,
    prompt: "写一篇论文",
    ports: h.ports,
    signal: controller().signal,
  });

  check("选中的 C 跑了", h.executed().includes("C"), h.executed());
  check("没选的 B 没跑", !h.executed().includes("B"), h.executed());
  eq("B 是 unselected", outcomeOf(h, "B")?.status, "unselected");
  eq("★ 换一条路,D 照样跑", outcomeOf(h, "D")?.status, "success");
  eq("还是 success", result.status, "success");

  const c = h.calls.find((x) => x.id === "C")?.prompt ?? "";
  check("C 也拿到了那一段", c.includes("## 本次执行的前置选择"));
  check("C 看到的是「进入查重」", c.includes("「进入查重」"));
  check("C 不该看到 B 那条边的说明", !c.includes("在现有稿子上再改一轮"));
}

{
  // 用户在选择时临时写的一句话。**这是"断点"真正的用法**:不只是点一下,还要说
  // "第三章太啰嗦"这种只对这一次成立的话。
  const h = makePorts({
    pick: (_id, options) => ({ edgeId: options[0]?.id ?? "", comment: "第三章太啰嗦,删掉一半" }),
  });
  await runWorkflow({ doc: fork, prompt: "写一篇论文", ports: h.ports, signal: controller().signal });
  const b = h.calls.find((c) => c.id === "B")?.prompt ?? "";
  check("用户临时写的那句话进了下一步的提示词", b.includes("第三章太啰嗦,删掉一半"), b.slice(0, 400));
}

{
  // **没填 label 就用目标节点的标题。** 一根说不出名字的线对用户没有意义,而"通向谁"
  // 至少说明了它会走到哪 —— 比一个空按钮强。
  const bare = docOf(
    [branchNode("F"), node("写作"), node("查重")],
    [edge("F", "写作"), edge("F", "查重")],
  );
  const h = makePorts();
  await runWorkflow({ doc: bare, prompt: "开始", ports: h.ports, signal: controller().signal });
  eq("没填 label 时用目标节点的标题", h.choicesAsked[0]?.options[0]?.label, "写作");
  eq("第二条同理", h.choicesAsked[0]?.options[1]?.label, "查重");
}

/**
 * **「没走」会沿着链条往下传。**
 *
 *     F(岔路口) ──[改]──> B ──> B2 ──┐
 *                └──[查重]──> C ─────┴──> D
 *
 * 选「查重」之后 B 和 **B2** 都得是 `unselected`,而 D 得上游里有一个是 unselected、
 * 另一个是**成功** —— 这种"混合"是最容易写错的一处:只要"有一个不是成功"就跳过的话,
 * D 会被整步作废,而现象是**最后一步凭空消失**。
 */
{
  const deep = docOf(
    [branchNode("F", "下一步"), node("B"), node("B2"), node("C"), node("D")],
    [
      edge("F", "B", { label: "改" }),
      edge("F", "C", { label: "查重" }),
      edge("B", "B2"),
      edge("B2", "D"),
      edge("C", "D"),
    ],
  );
  const h = makePorts({ pick: (_id, options) => ({ edgeId: options[1]?.id ?? "" }) });
  const result = await runWorkflow({
    doc: deep,
    prompt: "开始",
    ports: h.ports,
    signal: controller().signal,
  });

  eq("B 没走", outcomeOf(h, "B")?.status, "unselected");
  eq("★ B 的下游 B2 也没走(传递)", outcomeOf(h, "B2")?.status, "unselected");
  eq("★ 汇合点 D 的上游一半没走、一半成功 —— 它照跑", outcomeOf(h, "D")?.status, "success");
  eq("整次运行还是 success", result.status, "success");
  check("D 真的被执行了", h.executed().includes("D"), h.executed());
}

{
  // **引用一个"这次没走"的上游。**
  //
  // 失败是对的 —— 那一步确实没有产出。但**话必须说对**:不拦的话它会掉进 `readVar`
  // 里那句"去那一步的产出变量里把 X 填上",而那句建议在这里是**错的**(补什么都没用,
  // 那条路这次压根没走)。用户会跑去改一个根本没跑的节点,然后发现改了还是报一样的错。
  const h = makePorts({ pick: (_id, options) => ({ edgeId: options[1]?.id ?? "" }) });
  await runWorkflow({
    doc: docOf(
      [branchNode("F"), node("B"), node("C"), node("D", AGENT.id, "用 {{B.初稿}}")],
      [
        edge("F", "B", { label: "改" }),
        edge("F", "C", { label: "查重" }),
        edge("B", "D"),
        edge("C", "D"),
      ],
    ),
    prompt: "开始",
    ports: h.ports,
    signal: controller().signal,
  });
  const d = outcomeOf(h, "D");
  eq("D 失败了(它点名要的东西这次没有)", d?.status, "failed");
  check("说的是「没有走这条路」", d?.error?.includes("没有走这条路") === true, d?.error);
  check(
    "不甩那句「去填产出变量」(在这儿是错的建议)",
    (d?.error ?? "").includes("产出变量里把") === false,
    d?.error,
  );
}

{
  // 但**元信息那几种照给** —— `{{B.status}}` 取到 `unselected` 恰恰是它该有的样子
  // (有人就是要拿它判断"那条路走没走")。拦掉的话这种写法就没法用了。
  const h = makePorts({ pick: (_id, options) => ({ edgeId: options[1]?.id ?? "" }) });
  await runWorkflow({
    doc: docOf(
      [branchNode("F"), node("B"), node("C"), node("D", AGENT.id, "上一步的状态是 {{B.status}}")],
      [
        edge("F", "B", { label: "改" }),
        edge("F", "C", { label: "查重" }),
        edge("B", "D"),
        edge("C", "D"),
      ],
    ),
    prompt: "开始",
    ports: h.ports,
    signal: controller().signal,
  });
  eq("D 跑起来了", outcomeOf(h, "D")?.status, "success");
  check(
    "status 解出来是 unselected",
    h.calls.find((c) => c.id === "D")?.prompt.includes("unselected") === true,
    h.calls.find((c) => c.id === "D")?.prompt.slice(0, 300),
  );
}

{
  // **「就到这儿」** —— 界面自带的那个选项,不是图上的一条边(见 `BRANCH_STOP_CHOICE`)。
  //
  // 它落地的方式很干净:存进 `chosen` 的是一个**谁也匹配不上的 id**,于是这个分支的
  // 每一条出边都判死,下游整片标 `unselected`,这次运行自然收场 —— 调度器里**没有**
  // 第二个"停止"分支要维护,也就不会有第二种收场方式和它对不上。
  const h = makePorts({ pick: () => ({ edgeId: BRANCH_STOP_CHOICE }) });
  const result = await runWorkflow({
    doc: fork,
    prompt: "写一篇论文",
    ports: h.ports,
    signal: controller().signal,
  });

  eq("问过岔路口", h.choicesAsked.length, 1);
  check("除了 A,一个节点都没跑", h.executed().filter((x) => x !== "A").length === 0, h.executed());
  eq("B 是 unselected", outcomeOf(h, "B")?.status, "unselected");
  eq("C 也是 unselected", outcomeOf(h, "C")?.status, "unselected");
  eq("汇合点 D 也没跑(两条路都没走)", outcomeOf(h, "D")?.status, "unselected");
  // **不是失败。** 用户自己按的停止,卡片上不该出现"某一步失败了"那种话。
  eq("整次运行是 success", result.status, "success");
  eq("分支节点自己成功了", result.outcomes.get("F")?.status, "success");
}

{
  // **真失败还是要和"没走"分开。** 上游炸了 → `skipped`,文案说"没有成功";这和
  // "你自己选了别的路"是两句不同的话,混用会让用户去翻一个根本没跑的节点的日志。
  const h = makePorts({ fail: (id) => id === "A" });
  const result = await runWorkflow({
    doc: docOf([node("A"), node("B")], [edge("A", "B")]),
    prompt: "开始",
    ports: h.ports,
    signal: controller().signal,
  });
  eq("上游失败 → 下游是 skipped", outcomeOf(h, "B")?.status, "skipped");
  check("文案说的是「没有成功」", outcomeOf(h, "B")?.error?.includes("没有成功") === true, outcomeOf(h, "B")?.error);
  eq("有失败 → status = failed", result.status, "failed");
  check("下游没被派发", !h.executed().includes("B"), h.executed());
}

{
  // 一根出路都没有的岔路口是**坏图**:图会永远停在那儿,而用户看到的只是一张没有
  // 按钮的卡片。要明确失败,并且说清怎么修。
  const h = makePorts();
  await runWorkflow({
    doc: docOf([branchNode("F", "断了的分支")], []),
    prompt: "开始",
    ports: h.ports,
    signal: controller().signal,
  });
  eq("没有出路 → failed", outcomeOf(h, "F")?.status, "failed");
  check("说清怎么修", outcomeOf(h, "F")?.error?.includes("拉几根线") === true, outcomeOf(h, "F")?.error);
}

{
  // **出边没填选项名时,取的是「标题 ‖ 类型 id」,而且报错里列的就是它**(2026-09-19)。
  //
  // 这个值是一条**取值契约**:模型要把它原样交回来,`matchDecisionOption` 拿它去对边;
  // 对不上这一步就失败。原来这个规则在仓库里有五份,其中收场算产出名字那一份给的是
  // 「标题 ‖ **清单名**」,和这里不一样。今天还没炸(那一份的 `example` 当场被丢了),
  // 但 `example` 的用途就是给模型当样板 —— 两份摆着就是等谁用起来。现在共用一份。
  //
  // 目标节点**留空标题**才踩得到这条兜底 —— `addNode` 总会写上清单名,所以只有导入/
  // 手写的图会这样,而那是合法的(`WorkflowNode.title` 的注释写着"留空则显示类型名")。
  const h = makePorts({ summary: () => '{"出路": "mcode.agent"}' });
  await runWorkflow({
    doc: docOf(
      [
        { ...branchNode("F", "判断"), params: { decider: "model" } },
        // 标题留空 —— 兜底就在这儿。`node()` 默认拿 id 当标题,所以要显式盖掉。
        { ...node("B"), title: "" },
      ],
      [edge("F", "B")],
    ),
    prompt: "开始",
    ports: h.ports,
    signal: controller().signal,
  });
  eq("★ 没起标题的分支选得通(交的就是调度器认的那个名字)", outcomeOf(h, "B")?.status, "success");
  // 反证:交**清单名**对不上。这条同时钉住"上面那条不是恒真"(否则随便交什么都过)。
  const bad = makePorts({ summary: () => '{"出路": "子 agent"}' });
  const badResult = await runWorkflow({
    doc: docOf(
      [
        { ...branchNode("F", "判断"), params: { decider: "model" } },
        { ...node("B"), title: "" },
      ],
      [edge("F", "B")],
    ),
    prompt: "开始",
    ports: bad.ports,
    signal: controller().signal,
  });
  eq("★ 交清单名走不通(证明上面那条不是恒真)", badResult.status, "failed");
  check(
    "报错里列的是调度器认的那个名字(用户照着改就有救)",
    outcomeOf(bad, "F")?.error?.includes("mcode.agent") === true,
    outcomeOf(bad, "F")?.error,
  );
}

{
  // **挂在岔路口时被取消。** 这条只在真实现里才有意义(那里是一个真的 promise),
  // 但调度器这一头必须做到:取消之后这个节点**定案成 cancelled**,而且下游一个都不
  // 派发 —— 不定案的话它会永远停在"没跑",而 `RunResult` 里的收尾逻辑会把它当成
  // "图里有环"报出来。
  const ctl = controller();
  const h = makePorts({ chooseDelayMs: 80 });
  const pending = runWorkflow({
    doc: fork,
    prompt: "写一篇论文",
    ports: h.ports,
    signal: ctl.signal,
  });
  setTimeout(() => ctl.abort(), 30);
  const result = await pending;

  eq("取消 → status = cancelled", result.status, "cancelled");
  check("确实问过岔路口", h.choicesAsked.length === 1, h.choicesAsked.length);
  check("下游一个都没跑", !h.executed().includes("B") && !h.executed().includes("C"), h.executed());
  // 没跑到的节点不能缺席(否则渲染端会一直等一个永不到来的结果)。
  check("B 有结局", outcomeOf(h, "B") !== undefined);
  eq("F 是 cancelled,不是「图里有环」", outcomeOf(h, "F")?.status, "cancelled");
}

/* ────────────────────── 回头 ────────────────────── */

console.log("\n回头:分出去的一条线指回前面");

/** `A → D(成稿) → F(稿子怎么样)`;`F` 的一条出路指回 `D`,另一条通向 `G(定稿)`。 */
function loopDoc(): WorkflowDoc {
  return docOf(
    [node("A"), node("D", AGENT.id, "写初稿"), branchNode("F", "稿子怎么样"), node("G")],
    [
      edge("A", "D"),
      edge("D", "F"),
      edge("F", "D", { label: "再改一轮", note: "只改他提到的地方" }),
      edge("F", "G", { label: "就这样，定稿" }),
    ],
  );
}

const runsOf = (h: Harness, id: string): Call[] => h.calls.filter((c) => c.id === id);

{
  // 用户前两轮点「再改一轮」,第三轮点「定稿」—— 迭代两轮之后收工。
  let asked = 0;
  const h = makePorts({
    pick: (_nodeId, options) => {
      asked += 1;
      const want = asked <= 2 ? "再改一轮" : "就这样，定稿";
      const hit = options.find((o) => o.label === want) ?? options[0];
      return { edgeId: hit?.id ?? "", comment: `第 ${asked} 次意见` };
    },
  });

  const result = await runWorkflow({
    doc: loopDoc(),
    prompt: "写一篇引言",
    ports: h.ports,
    signal: controller().signal,
  });

  eq("跑完了,而且成功", result.status, "success");
  eq("环里那一步真的重跑了(成稿跑了三轮)", runsOf(h, "D").length, 3);
  eq("岔路口一次不落地问了三次", h.choicesAsked.length, 3);
  // ★ 这两条是"回卷只抹环体"的钉子。抹多了的话 `A` 会白跑两遍(它和这个环无关,
  //   而重跑它可能很贵 —— 检索、跑脚本都在这一步之后被白白重复)。
  eq("★ 环外的节点只跑一次", runsOf(h, "A").length, 1);
  eq("环的出口跑了一次", runsOf(h, "G").length, 1);

  const d1 = runsOf(h, "D")[0]?.prompt ?? "";
  const d2 = runsOf(h, "D")[1]?.prompt ?? "";
  const d3 = runsOf(h, "D")[2]?.prompt ?? "";
  // ★ 这一条是整件事的意义所在:没有它,"再改一轮"就是"从头再写一遍"。
  //
  //   第二轮拿到的是**整条流程的记录**(见 `flowRecordSection`):开头写着这条流程是
  //   干什么的、用户最初要什么,然后是各步的产出 —— 其中 `### D` 那一条就是它自己
  //   上一版(环体在重跑时**只清"谁跑过了",不清记录**,见 `rewindLoop`)。
  check("★ 第二轮看得到整条流程的记录", d2.includes("## 流程记录"), d2.slice(0, 400));
  check("记录的开头写着这条流程是什么", d2.includes("**本流程**:测试流程"), d2.slice(0, 400));
  check("也知道用户最初要的是什么", d2.includes("**用户最初的要求**:写一篇引言"));
  check("★ 而且自己上一版就在记录里", d2.includes("### D\nD 的结果"), d2.slice(0, 600));
  // 第一轮**也有**记录 —— A 已经跑完了,记录里就有它。要紧的是**没有它自己**:
  // 一个节点不该在自己的输入里看到自己的产出(那会是它还没交的东西)。
  check("第一轮也有记录(前面的 A 已经跑完)", d1.includes("## 流程记录"), d1.slice(0, 400));
  check("★ 但记录里没有它自己", !d1.includes("### D"), d1.slice(0, 600));
  // ★ 用户写的那句话挂在**选择**上,而回头会把 `chosen` 清掉 —— 所以这条钉的是
  //   `lastPick` 那一份:清掉了的话,"第三章太啰嗦"就丢了。
  check("★ 重跑时仍然知道用户点了哪条路", d2.includes("再改一轮"), d2.slice(0, 400));
  check("★ 也知道他当时写了什么", d2.includes("第 1 次意见"));
  // ★ **用户的历次意见一条都不删** —— 与"每一步只留最新一版"正相反。理由是它们是
  //   历史,而历史是迭代里唯一不会过期的信息:第三轮该知道第一轮否掉过什么,否则它会
  //   照着自己的想法再犯一次。
  check(
    "★ 第三轮同时看得见前两次的意见",
    d3.includes("第 1 次意见") && d3.includes("第 2 次意见"),
    d3.slice(0, 800),
  );
  // 而**产出**只留最新一版 —— 第三轮记录里的 D 是它第二轮交的那份,第一版已被换掉。
  // 这条同时钉住"记录不会随轮数线性膨胀":第几轮都好,D 只有一条。
  eq("★ 记录里的产出只留最新一版(D 只出现一次)", d3.split("### D").length - 1, 1);
  check("而且那一条标着是第几轮", d3.includes("### D(第 2 轮)"), d3.slice(0, 800));

  // 岔路口选了之后**不补结果卡**(它的卡就是那张选择卡)—— 回头那两轮同样不补。
  const cards = h.reports.filter((r) => r.kind === "node.settled" && r.node.id === "F");
  eq("岔路口一张结果卡都不发", cards.length, 0);
  eq("岔路口起了三次(证明真的重新派发了)", h.reports.filter((r) => r.kind === "node.started" && r.node.id === "F").length, 3);
  // ★ 不出卡片不等于还在执行(审查 D1):每次起跑都要有一次"停下"——这里是 parked。
  //   少了它,岔路口会一直挂在存档的在飞集合里,这时候关应用,重试就会被当成
  //   "可能已产生副作用"拒掉。
  eq(
    "★ 岔路口每次选完都报 parked(三次),宿主据此移出在飞集合",
    h.reports.filter((r) => r.kind === "node.parked" && r.node.id === "F").length,
    3,
  );
  // **每一轮都报一次定案** —— 调度器该报的照报(渲染端拿 `round` 决定是换卡还是
  // 插卡,见 `WorkflowNodeResultEvent.round`)。这里钉的是**上报次数**和**轮次**:
  // 少报一轮,界面就看不见那一轮;轮次数错,渲染端会把新一版当成新一轮插一张新的。
  const done = h.reports.filter(
    (r): r is Extract<RunReport, { kind: "node.settled" }> =>
      r.kind === "node.settled" && r.node.id === "D",
  );
  eq("每一轮都报一次定案(三张)", done.length, 3);
  eq("轮次从 1 数到 3", done.map((r) => r.round).join(","), "1,2,3");
}

{
  // ★ **节点的存放次序不改变回头的语义**(2026-09-27)。`nodes` 的次序是建节点的先后,
  //   不是流程的先后:用户先拖了一个分支、后补上前面几步,分支就排在最前。原来深搜从
  //   `nodes[0]` 起步,于是把「成稿 → 分支」认成回边 —— 分支没了上游、第一个就跑,
  //   「再改一轮」也不再回卷。同一张图,换个存放次序,行为必须一模一样。
  const base = loopDoc();
  const byId = new Map(base.nodes.map((n) => [n.id, n]));
  const shuffled: WorkflowDoc = {
    ...base,
    nodes: ["F", "D", "G", "A"].map((id) => byId.get(id) as WorkflowNode),
  };
  let asked = 0;
  const h = makePorts({
    pick: (_nodeId, options) => {
      asked += 1;
      const want = asked <= 1 ? "再改一轮" : "就这样，定稿";
      const hit = options.find((o) => o.label === want) ?? options[0];
      return { edgeId: hit?.id ?? "" };
    },
  });
  const result = await runWorkflow({
    doc: shuffled,
    prompt: "写一篇引言",
    ports: h.ports,
    signal: controller().signal,
  });
  eq("[次序打乱] 跑完了,而且成功", result.status, "success");
  eq("[次序打乱] ★ 分支不会第一个跑:第一个执行的是 A", h.executed()[0], "A");
  eq("[次序打乱] ★「再改一轮」照样回卷(成稿跑了两轮)", runsOf(h, "D").length, 2);
  eq("[次序打乱] 岔路口问了两次", h.choicesAsked.length, 2);
  eq("[次序打乱] 环外的 A 只跑一次", runsOf(h, "A").length, 1);
  eq("[次序打乱] 定稿跑了一次", runsOf(h, "G").length, 1);
}

{
  // **回头之后走另一条出路。** 这条钉的是"分支的其它出路要重新可选" —— 第一轮没被
  // 选中那条如果留着一个 `unselected` 的结局,第二轮用户回心转意点它,它**永远不会跑**,
  // 而卡片上写着"没走这条路",用户刚刚才点了它。
  let asked = 0;
  const h = makePorts({
    pick: (_nodeId, options) => {
      asked += 1;
      const want = asked <= 1 ? "再改一轮" : "就这样，定稿";
      const hit = options.find((o) => o.label === want) ?? options[0];
      return { edgeId: hit?.id ?? "" };
    },
  });

  const result = await runWorkflow({
    doc: loopDoc(),
    prompt: "写一篇引言",
    ports: h.ports,
    signal: controller().signal,
  });

  eq("绕一圈之后选了另一条 → 成功", result.status, "success");
  eq("★ 第一条出路走完之后另一条还走得通", runsOf(h, "G").length, 1);
  eq("成稿跑了两轮", runsOf(h, "D").length, 2);
}

{
  // **回头之后点「就到这儿」。** 停下来不是失败(同非环的那种情形,见 `BRANCH_STOP_CHOICE`)。
  let asked = 0;
  const h = makePorts({
    pick: (_nodeId, options) => {
      asked += 1;
      if (asked === 1) {
        const again = options.find((o) => o.label === "再改一轮");
        return { edgeId: again?.id ?? "" };
      }
      return { edgeId: BRANCH_STOP_CHOICE };
    },
  });

  const result = await runWorkflow({
    doc: loopDoc(),
    prompt: "写一篇引言",
    ports: h.ports,
    signal: controller().signal,
  });

  eq("停在环里 → 这次运行仍然算成功", result.status, "success");
  eq("成稿跑了两轮就停下了", runsOf(h, "D").length, 2);
  eq("定稿一次都没跑", runsOf(h, "G").length, 0);
  eq("★ 出口是「没走这条路」,不是「失败」", outcomeOf(h, "G")?.status, "unselected");
}

{
  // **环上没有岔路口** —— 坏图。存盘时 `validateDag` 会拒,但真到了调度器这一层,
  // 它不能被当成一条直线悄悄跑一遍(用户画的明明是个死循环),也不能永远挂着。
  //
  // ⚠️ 闸门是**两半**:是岔路口,而且决定权在用户手上(见 `@contracts/workflow` 的
  // `isLoopGateNode`)。判"闸门"时漏掉后半句的代价,就是这一组要钉的:一张全靠**模型选**
  // 分支的环会被当成"有闸门",回边照收 —— 而模型会在环里一环一环自己转下去,一次都不过
  // 人手,正是这条规则要拦的那种图。
  //
  // 除了"真跑起来会转飞",还有一个当场看得见的症状:**每一步都必须定案**。没有闸门的环
  // 走的是"依赖永远满足不了"那条路,收尾时会给出那句「依赖没有满足(图里是不是有环?)」
  // —— 认错了闸门的话,A 会被当成正常的岔路口**真跑一轮**,拿不到「出路」,报的是另一句
  // 关于产出的错(用户据此完全找不到方向)。
  const stuck = async (doc: WorkflowDoc, name: string): Promise<void> => {
    const h = makePorts();
    const result = await runWorkflow({
      doc,
      prompt: "跑",
      ports: h.ports,
      signal: controller().signal,
    });
    eq(`${name}:两个都有结局(不留空)`, result.outcomes.size, 2);
    check(
      `${name}:而且说的是实话(不是「失败」,是「依赖没满足」)`,
      outcomeOf(h, "A")?.error?.includes("环") === true,
      outcomeOf(h, "A")?.error,
    );
  };
  await stuck(docOf([node("A"), node("B")], [edge("A", "B"), edge("B", "A")]), "没闸门的环");
  await stuck(
    docOf(
      [
        { ...branchNode("A"), params: { decider: "model" } },
        { ...branchNode("B"), params: { decider: "model" } },
      ],
      [edge("A", "B"), edge("B", "A")],
    ),
    "★ 只有模型选分支的环(不是闸门)",
  );
}

/* ────────────────────── 「读流程记录」那个开关 ────────────────────── */

console.log("\n读流程记录:默认按图的结构,拨过之后归用户");

{
  // `undefined` 和 `false` 必须分得开(见 `flowRecordOf`):前者是"没表过态",该跟着
  // "这个节点在不在环上"走;后者是用户**明确关掉**的,不该被默认值覆盖回去。
  //
  // 所以这一组把两种情形**对着摆**:环上但关了,环外但开了。
  let asked = 0;
  const h = makePorts({
    pick: (_nodeId, options) => {
      asked += 1;
      const want = asked <= 1 ? "再改一轮" : "就这样，定稿";
      const hit = options.find((o) => o.label === want) ?? options[0];
      return { edgeId: hit?.id ?? "" };
    },
  });
  const doc = docOf(
    [
      node("A"),
      // 在环上 —— 默认该读,但这里**明确关掉**。
      node("D", AGENT.id, "写初稿", { flowRecord: false }),
      branchNode("F", "稿子怎么样"),
      // 不在环上 —— 默认该关,但这里**明确打开**。
      node("G", AGENT.id, "G 做什么", { flowRecord: true }),
    ],
    [
      edge("A", "D"),
      edge("D", "F"),
      edge("F", "D", { label: "再改一轮" }),
      edge("F", "G", { label: "就这样，定稿" }),
    ],
  );
  await runWorkflow({ doc, prompt: "写一篇引言", ports: h.ports, signal: controller().signal });

  const runs = (id: string): Call[] => h.calls.filter((c) => c.id === id);
  const d2 = runs("D")[1]?.prompt ?? "";
  const g = runs("G")[0]?.prompt ?? "";
  check("★ 环上、但明确关掉 → 不读记录", !d2.includes("## 流程记录"), d2.slice(0, 300));
  check("退回普通的那种:只给上游产出", d2.includes("## 上游步骤的产出"), d2.slice(0, 400));
  check("★ 不在环上、但明确打开 → 读记录", g.includes("## 流程记录"), g.slice(0, 300));
  check("记录里含它前面那几步的产出", g.includes("### D"), g.slice(0, 600));
}

/* ────────────────────── 续跑 ────────────────────── */

console.log("\n续跑:进程死过一次之后,接着上次断掉的地方往下跑");

/** 等某个条件成立。轮询而不是固定 `sleep(毫秒)` —— 后者在慢机器上会假失败。 */
async function until(cond: () => boolean, why: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`等不到:${why}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** 把调度器交出来的一份状态包成续跑要的输入 —— 落盘那一头做的就是这件事。 */
function resumeFrom(
  state: RunState,
  answer?: { nodeId: string; choice: BranchChoice },
): RunResume {
  return {
    record: state.record,
    rounds: state.rounds,
    picks: state.picks,
    settled: state.outcomes,
    ...(answer ? { answer } : {}),
  };
}

const roundOf = (state: RunState, id: string): number | undefined =>
  state.rounds.find(([n]) => n === id)?.[1];

/** `RunState.outcomes` 是 `[id, NodeOutcome][]`(落盘友好),不是 Map —— 读的时候包一层。 */
const settledOf = (state: RunState, id: string): NodeOutcome | undefined =>
  state.outcomes.find(([n]) => n === id)?.[1];

{
  // ── 第一次运行:停在「稿子怎么样」那一刻,应用被关掉了 ──
  const doc = loopDoc();
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const h1 = makePorts({ hold: (id) => (id === "F" ? held : undefined) });
  const ac1 = controller();
  const first = runWorkflow({
    doc,
    prompt: "写一篇引言",
    ports: h1.ports,
    signal: ac1.signal,
  });

  await until(() => h1.snapshots.some((s) => s.awaiting.includes("F")), "调度器停在岔路口上");
  // **应用就是在这一刻被关掉的。** 磁盘上留下的就是这一份(见 `runStore`)。
  const parked = h1.snapshots.filter((s) => s.awaiting.includes("F")).at(-1) as RunState;

  eq("★ 停在哪一格里写着", parked.awaiting.join(","), "F");
  eq(
    "那一刻它前面的两步都已经定案",
    parked.outcomes.filter(([, o]) => o.status === "success").length,
    2,
  );
  check(
    "流程记录也在里面(第一步的产出)",
    parked.record.some((e) => e.kind === "step" && e.nodeId === "A"),
    parked.record,
  );
  eq("还没定下来的岔路口,选择表是空的", parked.picks.length, 0);

  // 进程没了:取消 + 放行那次等待(现实中这两件事是一起发生的)。
  ac1.abort();
  release();
  await first;

  // ── 重启之后:用户在那张旧卡片上点了「再改一轮」,顺手写了句话 ──
  const h2 = makePorts({
    pick: (_id, options) => ({
      // 续跑补的那一下之后,岔路口会因为**回头**再问一次 —— 那时收工。
      edgeId: options.find((o) => o.label === "就这样，定稿")?.id ?? "",
    }),
  });
  const second = await runWorkflow({
    doc,
    prompt: "写一篇引言",
    ports: h2.ports,
    signal: controller().signal,
    resume: resumeFrom(parked, {
      nodeId: "F",
      choice: { edgeId: "e_F__D", comment: "第三章删一半" },
    }),
  });

  eq("接着跑完了", second.status, "success");
  // ★ 这是整件事的意义:上次跑过的那两步**一步都没重跑**。
  eq("★ 已经定过案的步骤一步都不重跑", h2.executed().filter((id) => id === "A").length, 0);
  // ★ 而回头那一下**是**要重跑的 —— 它正是"再改一轮"。
  eq("★ 回头的目标重跑了一次", h2.executed().filter((id) => id === "D").length, 1);
  eq("★ 后面那一步也跑到了", h2.executed().filter((id) => id === "G").length, 1);
  // 预置答案不是"跳过问用户",而是"问的那一下已经发生过了" —— 端口照样收到一次调用,
  // 只是带着答案(它要据此把界面上那张卡**原地**改成"你选了 X")。
  eq("预置的答案交给了端口,没有另外再问", h2.presetSeen.length, 1);
  eq("用的就是用户点的那条出路", h2.presetSeen[0]?.edgeId, "e_F__D");
  eq("★ 那个岔路口后来又真问了一次(回头)", h2.choicesAsked.length, 2);
  // 轮次要接着数 —— 从 1 重来的话,记录里会出现两条"第 1 轮"。
  eq("★ 回头那一轮的轮次接着数", roundOf(second.state, "D"), 2);
  // 记录里 D 还是只有一条(**换掉**旧的,不是追加),而且轮次接着数。
  const dStep = second.state.record.find((e) => e.kind === "step" && e.nodeId === "D");
  eq(
    "记录里 D 还是只有一条(换掉旧的,不是追加)",
    second.state.record.filter((e) => e.kind === "step" && e.nodeId === "D").length,
    1,
  );
  eq("而且它标着第 2 轮", dStep?.kind === "step" ? dStep.round : undefined, 2);

  const d2 = h2.calls.find((c) => c.id === "D")?.prompt ?? "";
  // 用户那句话要跟着走 —— 否则"按他说的改"就不知道改哪儿。
  check("★ 用户在选择时写的那句话传下去了", d2.includes("第三章删一半"), d2.slice(0, 600));
  check("记录里也留着那次选择", d2.includes("### 用户的选择"), d2.slice(0, 900));
  // ★ 而且它看得见**自己上一版** —— 没有这一条,"再改一轮"就退化成"从头再写一遍"。
  check("★ 重跑时看得见自己上一版", d2.includes("### D\nD 的结果"), d2.slice(0, 900));
}

/**
 * 两处岔路口、**互不依赖**的那个形状 —— 于是一条运行里两条都在等人(见
 * `RunState.awaiting`:它是列表不是单个,就是为了这一种)。
 */
function twoForksDoc(): WorkflowDoc {
  return docOf(
    [
      node("A"),
      branchNode("F", "先选一个"),
      node("B"),
      node("C"),
      branchNode("H", "再选一个"),
      node("X"),
      node("Y"),
    ],
    [
      edge("A", "F"),
      edge("F", "B", { label: "走 B", note: "按 B 那条路走" }),
      edge("F", "C", { label: "走 C" }),
      edge("A", "H"),
      edge("H", "X", { label: "走 X" }),
      edge("H", "Y", { label: "走 Y" }),
    ],
  );
}

{
  // A ─┬→ F(岔路口)─┬[走 B]→ B
  //    │            └[走 C]→ C
  //    └→ H(岔路口)─┬[走 X]→ X
  //                 └[走 Y]→ Y
  //
  // 用户在第一处点了「走 B」,第二处一直没点,然后应用被关了。
  const doc = twoForksDoc();
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const h1 = makePorts({
    pick: (_id, options) => ({ edgeId: options.find((o) => o.label === "走 B")?.id ?? "" }),
    hold: (id) => (id === "H" ? held : undefined),
    // B 慢一点,好让它**停在半路**上 —— 那一刻它还没有结局,所以重启之后它会重跑。
    delayMs: (id) => (id === "B" ? 3000 : 5),
  });
  const ac1 = controller();
  const first = runWorkflow({ doc, prompt: "跑", ports: h1.ports, signal: ac1.signal });

  const parkedAt = (s: RunState): boolean =>
    s.awaiting.includes("H") &&
    s.outcomes.some(([id, o]) => id === "C" && o.status === "unselected");
  await until(() => h1.snapshots.some(parkedAt), "第一处选完、第二处停着");
  const parked = h1.snapshots.filter(parkedAt).at(-1) as RunState;

  eq("★ 两处岔路口,只有一处还在等", parked.awaiting.join(","), "H");
  eq("★ 第一处选过的那条路记在存档里", parked.picks.length, 1);
  check(
    "★ 跑到一半的 B 没有结局(所以它不是「已定案」)",
    !parked.outcomes.some(([id]) => id === "B"),
  );

  ac1.abort();
  release();
  await first;

  // ── 重启之后,用户点了「走 X」──
  const h2 = makePorts({});
  const second = await runWorkflow({
    doc,
    prompt: "跑",
    ports: h2.ports,
    signal: controller().signal,
    resume: resumeFrom(parked, { nodeId: "H", choice: { edgeId: "e_H__X" } }),
  });

  eq("只派发了该派发的两个", [...h2.executed()].sort().join(","), "B,X");
  eq("★ 第一处岔路口没有被重新问一遍", h2.choicesAsked.length, 1);
  eq("★ 「没走这条路」仍然算没走", second.outcomes.get("C")?.status, "unselected");
  eq("这次选的另一条,两边同样判死", second.outcomes.get("Y")?.status, "unselected");
  eq("收尾是成功的", second.status, "success");

  // ★ 这一条钉的是**存档里的 `picks` 必须恢复**。
  //
  //   B 是"跑到一半被打断"的那一个,所以它会重跑;而它上一轮是从「走 B」那条路上来
  //   的。恢复的是 `lastPick`(见 `rewindLoop` 那段注释:回头会清 `chosen`,而
  //   "这一步是从哪条路来的"要一直说得出来),B 的提示词里才有那一段。
  const b = h2.calls.find((c) => c.id === "B")?.prompt ?? "";
  check(
    "★ 重跑的 B 知道自己上一轮是从哪条路来的",
    b.includes("## 本次执行的前置选择"),
    b.slice(0, 600),
  );
  check("而且那条路上的说明跟着一起回来了", b.includes("按 B 那条路走"), b.slice(0, 800));

  // ── 反证:同一份存档,**不恢复 picks** 会怎样 ──
  //   两处只差这一个字段,所以上面那两条不是"碰巧对"。
  const h3 = makePorts({});
  await runWorkflow({
    doc,
    prompt: "跑",
    ports: h3.ports,
    signal: controller().signal,
    resume: { ...resumeFrom(parked, { nodeId: "H", choice: { edgeId: "e_H__X" } }), picks: [] },
  });
  const b3 = h3.calls.find((c) => c.id === "B")?.prompt ?? "";
  check(
    "★ 少了 picks,重跑的那一步就不知道自己是从哪条路来的",
    !b3.includes("按 B 那条路走"),
    b3.slice(0, 600),
  );
}

/* ────────────── 「运行前先问我」(对话节点上的开关) ──────────────
 *
 * 跑到开了这个开关的对话节点时,先把决定权交给用户,四选一:
 *
 *   | 选项 | 之后 |
 *   |---|---|
 *   | 用这一步的指令 | 照常跑,用户在框里补的话接进提示词 |
 *   | 跳过 | 这一步不跑,`unselected` 往下传 |
 *   | 重复上一个任务 | 上一步连同它的后续作废重跑,**跑完回到这一步再问一次** |
 *   | 退出流程 | 整张图收场 |
 *
 * 四条**都不是图上的边** —— 它们是代码给的哨兵(见 `ASK_CHOICES`)。所以这一节要盯的
 * 是:它们确实影响了调度,而且没把既有的那套(结局传播、回卷、流程记录)弄坏。
 */

/** A →(问)B → C。B 是那个开了"先问我"的对话节点。 */
function askDoc(on = true): WorkflowDoc {
  return docOf(
    [
      node("A"),
      node("B", CONVERSATION.id, "按上面的结果写第三章", on ? { askBeforeRun: true } : {}),
      node("C"),
    ],
    [edge("A", "B"), edge("B", "C")],
  );
}

const askOption = (options: WorkflowChoiceOption[], id: string): string =>
  options.find((o) => o.id === id)?.id ?? "";

console.log("\n运行前先问我");

{
  // ── 用这一步的指令(+ 补充说明)──
  const h = makePorts({
    pick: (_id, options) => ({ edgeId: askOption(options, ASK_RUN_CHOICE), comment: "只改第三节" }),
  });
  const result = await runWorkflow({
    doc: askDoc(),
    prompt: "写一篇论文",
    ports: h.ports,
    signal: controller().signal,
  });

  eq("问了一次", h.choicesAsked.length, 1);
  eq("问的是那一步", h.choicesAsked[0]?.nodeId, "B");
  eq("四个选项", h.choicesAsked[0]?.options.length, 4);
  // 四个哨兵。**一条边都匹配不上** —— 那正是它们能表达"这条路不是图上的路"的原因。
  eq(
    "四个选项就是那四条",
    h.choicesAsked[0]?.options.map((o) => o.id).join(","),
    [ASK_RUN_CHOICE, ASK_SKIP_CHOICE, ASK_REPEAT_CHOICE, ASK_EXIT_CHOICE].join(","),
  );
  // 界面靠这一位决定"弹窗还是卡片"(见 `WorkflowNodeChoiceEvent.ask`)。
  // ⚠️ 它**不是** `runner.kind === "branch"` 那种判断 —— 那一位说的是"代码打算怎么
  // 处理它",不是"它是谁"。
  check("选项里带着输入框提示", h.choicesAsked[0]?.options[0]?.input !== undefined);

  check("B 照常跑了", h.executed().includes("B"), h.executed());
  check("C 也跑了", h.executed().includes("C"), h.executed());
  eq("整张图成功", result.status, "success");

  const b = h.calls.find((c) => c.id === "B")?.prompt ?? "";
  check("提示词里有「前置选择」那一段", b.includes("## 本次执行的前置选择"), b.slice(0, 200));
  check("说了用户选的是哪一项", b.includes("用这一步的指令"), b.slice(0, 300));
  check("★ 用户补的那句话进去了", b.includes("只改第三节"), b.slice(0, 400));
  check("节点自己的指令还在", b.includes("按上面的结果写第三章"));
}

{
  // ── 跳过 ──
  // 标 `unselected` 而**不是** `skipped`:两者对下游的传播完全不同 —— "没走这条路"
  // 会被下游的汇合点忽略掉,而"上游失败了"会把下游一起拖死。
  const h = makePorts({ pick: (_id, options) => ({ edgeId: askOption(options, ASK_SKIP_CHOICE) }) });
  const result = await runWorkflow({
    doc: askDoc(),
    prompt: "写一篇论文",
    ports: h.ports,
    signal: controller().signal,
  });

  check("B 没跑", !h.executed().includes("B"), h.executed());
  eq("★ B 是 unselected,不是 skipped", outcomeOf(h, "B")?.status, "unselected");
  check("C 也没跑(它的来路没走)", !h.executed().includes("C"), h.executed());
  eq("★ C 也是 unselected,不是 skipped", outcomeOf(h, "C")?.status, "unselected");
  eq("跳过不是失败", result.status, "success");
}

{
  // ── 退出流程 ──
  // 收场方式和分支的「就到这儿」**一模一样**:下游整片 `unselected`,没有可派发的节点,
  // 循环自然退出。**不特判"停"这个状态** —— 特判就有第二种收场方式。
  //
  // (用户那段字会由 `runner.ts` 发进主对话。那一半要真会话,在端到端里验,不在这儿。)
  const h = makePorts({
    pick: (_id, options) => ({
      edgeId: askOption(options, ASK_EXIT_CHOICE),
      comment: "算了,我先自己看看",
    }),
  });
  const result = await runWorkflow({
    doc: askDoc(),
    prompt: "写一篇论文",
    ports: h.ports,
    signal: controller().signal,
  });

  check("B 没跑", !h.executed().includes("B"), h.executed());
  eq("B 是 unselected", outcomeOf(h, "B")?.status, "unselected");
  check("★ 后面的 C 一起收场了", !h.executed().includes("C"), h.executed());
  eq("退出不是失败", result.status, "success");
}

{
  // ── ★ 重复上一个任务 ──
  //
  // 这一条是整个功能的重头:上一步**连同它的后续作废重跑**,跑完**回到这一步再问一次**。
  // 机制上它走的是分支回卷那条通路(`pendingLoopBack` → `settle` → `rewindLoop`),只是
  // 标记不是一条边、而是 `ASK_REPEAT_CHOICE` 这个哨兵。
  //
  // 三件必须一起成立,少一件这个选项就是坏的:
  //   1. 上一步真的重跑了(不是跳过去);
  //   2. 重跑完之后**又问了一次**(不是一路往下走);
  //   3. 用户那句"哪里不对"**看得见** —— 否则他写的那段字当着面丢掉。
  let round = 0;
  const h = makePorts({
    pick: (_id, options) => {
      round += 1;
      return round === 1
        ? { edgeId: askOption(options, ASK_REPEAT_CHOICE), comment: "第三节论据不够,重写" }
        : { edgeId: askOption(options, ASK_RUN_CHOICE) };
    },
  });
  const result = await runWorkflow({
    doc: askDoc(),
    prompt: "写一篇论文",
    ports: h.ports,
    signal: controller().signal,
  });

  eq("★ 问了两次(重复完回到同一个节点)", h.choicesAsked.length, 2);
  eq("两次问的是同一个节点", h.choicesAsked[1]?.nodeId, "B");
  eq("★ A 重跑了一遍(一共两次)", h.executed().filter((x) => x === "A").length, 2);
  eq("B 只在第二轮真跑了", h.executed().filter((x) => x === "B").length, 1);
  check("C 照跑", h.executed().includes("C"), h.executed());
  eq("整张图成功", result.status, "success");
  // 轮次**接着数**,不回退 —— "这一步第几次跑"是记录里"第 N 轮"那个数字的来源。
  eq("★ A 的轮次是 2", roundOf(h.snapshots[h.snapshots.length - 1] as RunState, "A"), 2);

  // ★ 重跑那一步的提示词里必须有用户那句意见。它走的是**流程记录**那条通路
  // (不落在任何一步的产出里,见 `askOne` 里那段),所以这里连着验两件事。
  const a2 = h.calls.filter((c) => c.id === "A")[1]?.prompt ?? "";
  check("★ 重跑的 A 读得到流程记录", a2.includes("## 流程记录"), a2.slice(0, 300));
  check("★ 用户那句「哪里不对」看得见", a2.includes("第三节论据不够,重写"), a2);
  check("记录里说了那是用户在谁那儿选的", a2.includes("B"), a2);
}

{
  // **没有上游就不给"重复上一个任务"** —— "上一步"根本不存在,摆一个点了会失败的
  // 按钮比不摆更糟。这也是为什么那四条**由主进程给出**、界面照着摆,而不是界面写死。
  const h = makePorts({ pick: (_id, options) => ({ edgeId: options[0]?.id ?? "" }) });
  await runWorkflow({
    doc: docOf([node("B", CONVERSATION.id, "自己跑", { askBeforeRun: true })], []),
    prompt: "随便",
    ports: h.ports,
    signal: controller().signal,
  });
  eq("三个选项", h.choicesAsked[0]?.options.length, 3);
  check(
    "★ 没有「重复上一个任务」",
    !h.choicesAsked[0]?.options.some((o) => o.id === ASK_REPEAT_CHOICE),
    h.choicesAsked[0]?.options.map((o) => o.id),
  );
}

{
  // **没开这个开关就不问** —— 默认行为一个字没变。这一条是给"新功能别把老图弄坏"兜底的。
  const h = makePorts({});
  await runWorkflow({
    doc: askDoc(false),
    prompt: "写一篇论文",
    ports: h.ports,
    signal: controller().signal,
  });
  eq("没问", h.choicesAsked.length, 0);
  check("B 照常跑", h.executed().includes("B"), h.executed());
}

{
  // ── 续跑:应用关掉之后点那张旧卡 ──
  //
  // 挂起那套东西(落盘、重启、按 `runId + nodeId` 认回来)是**原样复用**的,所以这里
  // 验的是"复用没接歪":`awaiting` 里有它、用存档接得回来、接回来之后**不再问一遍**。
  const parkedController = controller();
  const parked = makePorts({ hold: (id) => (id === "B" ? new Promise<void>(() => {}) : undefined) });
  void runWorkflow({
    doc: askDoc(),
    prompt: "写一篇论文",
    ports: parked.ports,
    signal: parkedController.signal,
  });
  // 等到它真的停在那一问上(等待池是同步写进 snapshot 的)。
  await new Promise((r) => setTimeout(r, 20));
  const state = parked.snapshots[parked.snapshots.length - 1] as RunState;
  check("★ 停着等人时记着是哪一格", (state.awaiting ?? []).includes("B"), state.awaiting);

  // 接回来:带上"用户点了跳过"这个答案。
  const h = makePorts({});
  const resumedResult = await runWorkflow({
    doc: askDoc(),
    prompt: "写一篇论文",
    ports: h.ports,
    signal: controller().signal,
    resume: resumeFrom(state, { nodeId: "B", choice: { edgeId: ASK_SKIP_CHOICE } }),
  });
  // ⚠️ **不能断言"端口没被调用"** —— 它一定会被调用,这是设计:通知与等待必须是同一个
  // 调用(见 `RunPorts.choose`),预置答案只是让那个 promise 立刻就落地。真正该验的是
  // **它没有进等待池** —— 那才是界面上"又挂起了一次"的判据。
  check(
    "★ 接回来之后没进等待池(没有第二次挂起)",
    !h.snapshots.some((s) => (s.awaiting ?? []).includes("B")),
    h.snapshots.map((s) => s.awaiting),
  );
  eq("★ 预置的那个答案被端口收到了", h.presetSeen.length, 1);
  eq("收到的是跳过", h.presetSeen[0]?.edgeId, ASK_SKIP_CHOICE);
  eq("B 按跳过定案", outcomeOf(h, "B")?.status, "unselected");
  check("A 不重跑(它的结局在存档里)", !h.executed().includes("A"), h.executed());
  eq("收场成功", resumedResult.status, "success");

  // 把那次挂着的运行收掉,免得它一直挂在等待池里。
  parkedController.abort();
  await new Promise((r) => setTimeout(r, 20));
}

console.log("\n失败重试:只重跑失败那步 + 它的下游");

/**
 * 「第 8 步炸了」那个形状:A → B → C → D,其中 B 失败。
 *
 * 用户在一张**失败**的卡片上点「再试一次」、写一句话 —— 要的是:
 * 前面成功的步骤(A)**一步不重做**,而失败那一步**连同它的全部下游**(C、D)重跑。
 *
 * 这就是 §一 那条 `rewind` 存在的理由:失败运行落盘的 `outcomes` 是**整张图的完整
 * 结局表**,`settled` 会把它们全灌回去 —— 只摘 B 的话,C、D 留着上一轮的结局,
 * 既不会被重新派发、又拿不到新上游(静默不一致)。
 */
function chainDoc(): WorkflowDoc {
  return docOf(
    [node("A"), node("B"), node("C"), node("D")],
    [edge("A", "B"), edge("B", "C"), edge("C", "D")],
  );
}

{
  // ── 第一次:B 失败。整张图以 failed 收场 ──
  const doc = chainDoc();
  const h1 = makePorts({ fail: (id) => id === "B" });
  const first = await runWorkflow({
    doc,
    prompt: "跑一条链",
    ports: h1.ports,
    signal: controller().signal,
  });

  eq("★ 第一步失败,整张图就是 failed", first.status, "failed");
  eq("只有 A、B 跑过", h1.executed().join(","), "A,B");
  eq("B 定案成 failed", outcomeOf(h1, "B")?.status, "failed");
  // ⚠️ 失败的下游是 `skipped`(不是"缺席")—— 它得有个说得出口的答案。
  eq("C 被标成 skipped", outcomeOf(h1, "C")?.status, "skipped");
  eq("D 也是 skipped", outcomeOf(h1, "D")?.status, "skipped");

  // ── 用户点了「再试一次」,还写了一句"上次哪里不对" ──
  const h2 = makePorts({});
  const second = await runWorkflow({
    doc,
    prompt: "跑一条链",
    ports: h2.ports,
    signal: controller().signal,
    resume: {
      record: first.state.record,
      rounds: first.state.rounds,
      picks: first.state.picks,
      settled: first.state.outcomes,
      rewind: ["B"],
      note: { nodeId: "B", text: "别联网了，用本地那份" },
    },
  });

  eq("★ 重跑之后整张图不再是 failed", second.status, "success");
  // ★ 这是整件事的意义:前面成功的那一步**没重跑** —— 它的钱没白花。
  check("★ 成功的上游一步都不重做", !h2.executed().includes("A"), h2.executed());
  // ★ 而失败那一步**确实**重跑了。
  eq("★ 失败那一步重跑了", h2.executed().filter((id) => id === "B").length, 1);
  // ★ 它的下游也要重跑 —— 上游变了,下游拿到的输入就变了。
  eq("★ 下游 C 也重跑", h2.executed().filter((id) => id === "C").length, 1);
  eq("★ 再下游 D 也重跑", h2.executed().filter((id) => id === "D").length, 1);
  eq("B 这次成功了", outcomeOf(h2, "B")?.status, "success");
  eq("C 也定案了(不是留着旧的 skipped)", outcomeOf(h2, "C")?.status, "success");

  // ★ 那句话**只给被点名的节点看**。
  const bPrompt = h2.calls.find((c) => c.id === "B")?.prompt ?? "";
  check("★ 用户写的那句话进了失败那一步的提示词", bPrompt.includes("别联网了，用本地那份"), bPrompt.slice(0, 600));
  check("而且是以「本次执行的前置选择」那一段的形态", bPrompt.includes("本次执行的前置选择"), bPrompt.slice(0, 600));
  // 别的步骤看不到 —— 它是"这一步的"说明,不是全局指令。
  for (const other of ["A", "C", "D"]) {
    const p = h2.calls.find((c) => c.id === other)?.prompt ?? "";
    check(`★ 别的步骤看不到那句话(${other})`, !p.includes("别联网了"), p.slice(0, 300));
  }
}

{
  // ── 摘的必须是**整个闭包**,不只是失败那一步 ──
  //
  // 只摘 B 的话:C、D 留着一个旧的 `skipped`,`settle` 当初标的那一句还在。它们
  // 既不会被重新派发(上游 B 重新跑完之前不就绪),而等 B 跑完之后 —— 关键就在这 ——
  // `settle` 看到的是"已经有结局了"还是"没有"?答:旧结局会**挡住**新的派发。
  // 所以这里正面断言:重跑之后 C、D 的结局是**新的 success**,而不是旧的 skipped。
  const doc = chainDoc();
  const h1 = makePorts({ fail: (id) => id === "B" });
  const first = await runWorkflow({ doc, prompt: "x", ports: h1.ports, signal: controller().signal });

  const h2 = makePorts({});
  const second = await runWorkflow({
    doc,
    prompt: "x",
    ports: h2.ports,
    signal: controller().signal,
    resume: {
      record: first.state.record,
      rounds: first.state.rounds,
      picks: first.state.picks,
      settled: first.state.outcomes,
      rewind: ["B"],
    },
  });

  eq("★ C 的新结局是 success(不是旧的 skipped)", settledOf(second.state, "C")?.status, "success");
  eq("★ D 的新结局也是 success", settledOf(second.state, "D")?.status, "success");
  // 不在闭包里的 A 保留原结局(它是从 `settled` 进来的,没被抹)。
  eq("★ 闭包外的 A 保留原结局", settledOf(second.state, "A")?.status, "success");
  check("★ 而 A 没有被重新执行过", !h2.executed().includes("A"), h2.executed());
}

{
  // ── 不给 `rewind` 时,行为与今天**逐字一致**(老存档的回归)──
  //
  // 岔路口续跑那条路(见上面那几段)走的就是"只有 settled、没有 rewind"的老形状。
  // 这里正面钉一下:那种调用不该抹掉任何结局。
  const doc = chainDoc();
  const h1 = makePorts({ fail: (id) => id === "B" });
  const first = await runWorkflow({ doc, prompt: "x", ports: h1.ports, signal: controller().signal });

  const h2 = makePorts({});
  const second = await runWorkflow({
    doc,
    prompt: "x",
    ports: h2.ports,
    signal: controller().signal,
    // 老形状:record / rounds / picks / settled,没有 rewind。
    resume: {
      record: first.state.record,
      rounds: first.state.rounds,
      picks: first.state.picks,
      settled: first.state.outcomes,
    },
  });

  eq("老形状下整张图仍然 failed(失败没被抹掉)", second.status, "failed");
  eq("一个节点都没重跑", h2.executed().length, 0);
  eq("B 还是 failed", settledOf(second.state, "B")?.status, "failed");
}

console.log("\n从图上挑一步往下走:分支要重新问,入口不再问");

/**
 * ## 为什么这两段非有不可
 *
 * 上面那几段验的是"重跑的范围对不对"(抹掉闭包)。这里验的是**另外两件**会被闭包
 * 顺带影响、但方向相反的事 —— 它们都能静默错一整天:
 *
 *  1. **被重跑的分支要重新变成"还没决定"。** `chosen` 是存档里带回来的,不清的话,
 *     重跑的那一片**来路只剩当初选的那一条**:用户刚写了「上次哪里不对」,而图照着
 *     上一轮的选择又走了一遍,根本没给他重选的机会。屏幕上什么都看不出来。
 *  2. **图的入口不再问"运行前先问我"。** 用户在图上指着入口说"从这儿往下",那是
 *     已经拍过的板 —— 再弹一次四选一,而答"跳过"会让整张图一步都不跑。
 *
 * 两段的判据都立在人看得见的那一处:①那边是"另一条支路有没有被标死",②那边是
 * "他到底点没点、以及模型读到的是哪句话"。
 */

/** A → B,而 **A 是岔路口**、两条出路通向 B 和 C。B、C 之后汇到 D。 */
function forkDoc(): WorkflowDoc {
  return docOf(
    // ⚠️ A **只出现一次**:`docOf` 不去重,同名两次会让"哪一个是 A"没有唯一答案,
    //    而下游断言看的就是 A 的结局。
    [branchNode("A"), node("B"), node("C"), node("D")],
    [
      // 两条出边:一条去 B(选了它),一条去 C(没选)。
      { id: "e_AB", from: "A", to: "B", label: "走 B" },
      { id: "e_AC", from: "A", to: "C", label: "走 C" },
      edge("B", "D"),
      edge("C", "D"),
    ],
  );
}

{
  // ── ① 重跑一个**含岔路口**的闭包:那个岔路口要重新问 ──
  const doc = forkDoc();
  // 第一次:用户选了"走 B",B 失败,D 跟着 skipped。
  const h1 = makePorts({
    fail: (id) => id === "B",
    pick: () => ({ edgeId: "e_AB" }),
  });
  const first = await runWorkflow({ doc, prompt: "x", ports: h1.ports, signal: controller().signal });

  eq("★ 用户选了 B 那条路", settledOf(first.state, "B")?.status, "failed");
  eq("★ 没选的那条(C)被标成 unselected", settledOf(first.state, "C")?.status, "unselected");
  eq("★ 存档里记着「选了哪条」", first.state.picks.length, 1);

  // 第二次:**从 A 重跑** —— 也就是把那个岔路口自己也抹掉。
  //
  // ⚠️ 这里给的是 `rewind: ["A"]`,闭包是 {A, B, C, D} —— 那个岔路口在闭包里,
  // 所以要重新问(而不是照抄上一轮的答案)。
  const h2 = makePorts({ pick: () => ({ edgeId: "e_AC" }) });
  const second = await runWorkflow({
    doc,
    prompt: "x",
    ports: h2.ports,
    signal: controller().signal,
    resume: {
      record: first.state.record,
      rounds: first.state.rounds,
      picks: first.state.picks,
      settled: first.state.outcomes,
      rewind: ["A"],
    },
  });

  // ★ **这一条就是那件事**:岔路口被重新问了一次 —— 用户这次能选另一条路。
  eq("★ 重跑的分支被重新问了一遍(而不是照抄上一轮)", h2.choicesAsked.length, 1);
  eq("★ 用户这次选了另一条", h2.choicesAsked[0]?.options.length, 2);
  eq("★ 于是走的是 C 那条路", settledOf(second.state, "C")?.status, "success");
  eq("★ 而 B 这次没走", settledOf(second.state, "B")?.status, "unselected");
  // ⚠️ **`presetSeen` 必须是空的** —— 那才是"重新问"的准确判据。`choicesAsked` 在
  //    预置答案那一路**同样会出现**(见 Harness 的注释),所以只看它分不出"问了"和
  //    "直接给了答案"。这里正面钉一下:这一问是真的走了一遍用户。
  eq("★ 而且是真问的,不是拿预置答案顶的", h2.presetSeen.length, 0);
}

{
  // ── ① 的反面:**不在**闭包里的岔路口**不许**重新问 ──
  //
  // 用户点的是下游某一步,而岔路口在它前面(没被抹)。那种情况下照抄上一轮的选择是
  // **对的** —— 他这次没说要改那条路,重新问一遍等于把已经定过的事又翻出来。
  const doc = forkDoc();
  const h1 = makePorts({ fail: (id) => id === "D", pick: () => ({ edgeId: "e_AB" }) });
  const first = await runWorkflow({ doc, prompt: "x", ports: h1.ports, signal: controller().signal });

  // 从 D 重跑 —— A 在闭包**外**。
  const h2 = makePorts({});
  await runWorkflow({
    doc,
    prompt: "x",
    ports: h2.ports,
    signal: controller().signal,
    resume: {
      record: first.state.record,
      rounds: first.state.rounds,
      picks: first.state.picks,
      settled: first.state.outcomes,
      rewind: ["D"],
    },
  });

  eq("★ 闭包外的岔路口不重新问(照抄上一轮的选择)", h2.choicesAsked.length, 0);
  check("★ 而且 A 一步都没重跑", !h2.executed().includes("A"), h2.executed());
}

{
  // ── ② 图的入口开着「运行前先问我」:从它往下走时**不再问** ──
  //
  // 入口是 `mcode.main`(主代理),而它是**对话节点** —— 那个开关只长在对话节点上
  // (`askBeforeRunOf` 只被 conversation 那一支读)。别的重跑起点不会有这一问。
  const doc = docOf(
    [
      node("A", CONVERSATION.id, "A 做什么", { askBeforeRun: true }),
      node("B"),
    ],
    [edge("A", "B")],
  );
  const h1 = makePorts({ fail: (id) => id === "B" });
  const first = await runWorkflow({ doc, prompt: "x", ports: h1.ports, signal: controller().signal });

  // 从入口 A 重跑 —— 它的闭包是整张图。
  const h2 = makePorts({});
  await runWorkflow({
    doc,
    prompt: "x",
    ports: h2.ports,
    signal: controller().signal,
    resume: {
      record: first.state.record,
      rounds: first.state.rounds,
      picks: first.state.picks,
      settled: first.state.outcomes,
      rewind: ["A"],
    },
  });

  // ★ **那一问的答案是预置的,不是现场问出来的。**
  //
  // ⚠️ 这里**不能**拿 `choicesAsked.length === 0` 当判据 —— 那是错的。端口照样收到
  //    一次调用(它要据此把界面上那张卡**原地**改成"你选了 X"),`choicesAsked` 因此
  //    同样会 +1(见 Harness 上 `presetSeen` 那段注释)。分得开这两件事的只有
  //    `presetSeen`:**不为空** = 这一问没等用户。
  eq("★ 那一问是预置的,没让用户再拍一次板", h2.presetSeen.length, 1);
  eq("★ 预置的答案就是「用这一步的指令」", h2.presetSeen[0]?.edgeId, ASK_RUN_CHOICE);
  eq("★ 那一格就是入口", h2.presetSeen[0]?.nodeId, "A");
  check("★ 入口这一步照跑(不是被跳过)", h2.executed().includes("A"), h2.executed());
  // 而他"点了它"这件事要说得出来 —— 模型读到的应当是"从这一步往下",不是"用这一步的指令"。
  const aPrompt = h2.calls.find((c) => c.id === "A")?.prompt ?? "";
  check(
    "★ 入口那一步的提示词里说的是「从这一步往下走」",
    aPrompt.includes("从这一步往下走"),
    aPrompt.slice(0, 500),
  );
  check("★ 而且是以「本次执行的前置选择」那一段的形态", aPrompt.includes("本次执行的前置选择"), aPrompt.slice(0, 500));
  // ★ **反面钉一下**:那句"用这一步的指令"(选项自己的文案)不许露出来 —— 那说的是
  //    "这一步怎么跑",而用户表达的是"从这一步往下",两件事。漏了替换就会是这样。
  check(
    "★ 没有退回到选项自己的文案「用这一步的指令」",
    !aPrompt.includes("用这一步的指令"),
    aPrompt.slice(0, 500),
  );
}

{
  // ── ③ 入口是**岔路口**时,绝不许预置 ──
  //
  // ⚠️ 这条是**真踩过的**:`entryCandidates` 只看"谁没有入边",**不看类型**,而画一张
  //    以分支开头的图是完全合法的。往里塞一个 `ASK_RUN_CHOICE`,分支那一头会拿它去
  //    自己的出边里找 —— 四选一的答案 vs 出边,**一条都对不上**,于是整张图一开跑就
  //    判失败:"选的那条出路不在这个分支上"。加了 `isAskBeforeRun` 那道闸才拦住。
  //
  // 判据立在用户看得见的那一处:**那次运行成不成,以及他到底有没有被问**。
  const doc = forkDoc();
  const h1 = makePorts({ fail: (id) => id === "D", pick: () => ({ edgeId: "e_AB" }) });
  const first = await runWorkflow({ doc, prompt: "x", ports: h1.ports, signal: controller().signal });

  const h2 = makePorts({ pick: () => ({ edgeId: "e_AB" }) });
  const second = await runWorkflow({
    doc,
    prompt: "x",
    ports: h2.ports,
    signal: controller().signal,
    resume: {
      record: first.state.record,
      rounds: first.state.rounds,
      picks: first.state.picks,
      settled: first.state.outcomes,
      rewind: ["A"],
    },
  });

  eq("★ 以分支为入口的图从入口重跑,不能因为预置而失败", second.status, "success");
  eq("★ 那个岔路口是真问的(分支不接受预置答案)", h2.presetSeen.length, 0);
  eq("★ 问的就是它", h2.choicesAsked[0]?.nodeId, "A");
  check("★ 而且照常往下走了", h2.executed().includes("B"), h2.executed());
}

{
  // ── ② 的反面:入口**没开着**那个开关时,什么都没变 ──
  const doc = docOf([node("A"), node("B")], [edge("A", "B")]);
  const h1 = makePorts({ fail: (id) => id === "A" });
  const first = await runWorkflow({ doc, prompt: "x", ports: h1.ports, signal: controller().signal });

  const h2 = makePorts({});
  await runWorkflow({
    doc,
    prompt: "x",
    ports: h2.ports,
    signal: controller().signal,
    resume: {
      record: first.state.record,
      rounds: first.state.rounds,
      picks: first.state.picks,
      settled: first.state.outcomes,
      rewind: ["A"],
    },
  });

  eq("★ 没开那个开关就没有那一问", h2.choicesAsked.length, 0);
  eq("★ 也没有预置答案(那一段不该凭空冒出来)", h2.presetSeen.length, 0);
  check("★ A 照跑", h2.executed().includes("A"), h2.executed());
  // 提示词里**不该**凭空多出那一段 —— 那会告诉模型"用户拍过一个板",而他没有。
  const aPrompt = h2.calls.find((c) => c.id === "A")?.prompt ?? "";
  check("★ 而且提示词里没有凭空多出那一段", !aPrompt.includes("本次执行的前置选择"), aPrompt.slice(0, 400));
}

/* ────────────────────── 自动重试(瞬时故障) ────────────────────── */

console.log("\n自动重试");

{
  // 规则本身先钉住 —— 「该不该再试一次」全写在这几个纯函数里,它们错了的话,
  // 下面那几条端到端的断言只会跟着一起错得很一致。
  eq("没声明 retry = 只试一次(老行为)", retryPlanOf({}).maxAttempts, 1);
  eq("清单写大了会被夹到上限", retryPlanOf({ retry: { maxAttempts: 99 } }).maxAttempts, 5);

  const plan = retryPlanOf({
    retry: { maxAttempts: 4, backoffMs: 1_000, backoffFactor: 3, maxBackoffMs: 5_000 },
  });
  eq("第一次失败等 backoffMs", retryDelayMs(1, plan), 1_000);
  eq("第二次乘一遍 factor", retryDelayMs(2, plan), 3_000);
  eq("封顶不超过 maxBackoffMs", retryDelayMs(3, plan), 5_000);

  check("限流算瞬时", isTransientError("429 Too Many Requests"));
  check("连接被重置算瞬时", isTransientError("socket hang up (ECONNRESET)"));
  check("中文的超时也算", isTransientError("请求超时,请稍后再试"));
  check("参数填错不算瞬时", !isTransientError("「指令」这一格没填"));
  check("产出不合约束不算瞬时", !isTransientError("产出里少了变量「总数」"));

  // 执行器自己表的态**压过**关键词猜测 —— 两个方向都要钉住。
  check(
    "执行器说别试了就不试(哪怕话里带 timeout)",
    !shouldRetryOutcome({ status: "failed", summary: "", error: "timeout", retryable: false }),
  );
  check(
    "执行器说可以试就试(哪怕话里看不出来)",
    shouldRetryOutcome({ status: "failed", summary: "", error: "这一步没交东西", retryable: true }),
  );
  check(
    "取消不是可重试的失败(那是用户的决定)",
    !shouldRetryOutcome({ status: "cancelled", summary: "", error: "运行被取消" }),
  );
}

{
  // ── 第一趟撞限流,第二趟就过了 ──
  const doc = docOf(
    [node("A", RETRY_AGENT.id), node("B", RETRY_AGENT.id)],
    [edge("A", "B")],
  );
  const h = makePorts({
    outcome: (id, attempt) =>
      id === "A" && attempt === 1
        ? { status: "failed", summary: "", error: "429 rate limit" }
        : undefined,
  });
  const result = await runWorkflow({ doc, prompt: "x", ports: h.ports, signal: controller().signal });

  eq("瞬时失败自动再试一趟就成了", result.status, "success");
  eq("A 真的跑了两趟", h.calls.filter((c) => c.id === "A").length, 2);
  eq("最终定案是成功(不是\"失败过\")", result.outcomes.get("A")?.status, "success");
  eq("下游照常跑,没被那次失败拖成 skipped", h.calls.filter((c) => c.id === "B").length, 1);
}

{
  // ── 终态失败一趟都不多跑 ──
  const doc = docOf([node("A", RETRY_AGENT.id)], []);
  const h = makePorts({
    outcome: () => ({ status: "failed", summary: "", error: "「指令」这一格没填" }),
  });
  await runWorkflow({ doc, prompt: "x", ports: h.ports, signal: controller().signal });
  eq("配置类错误不重试(试一百次还是同一句话)", h.calls.filter((c) => c.id === "A").length, 1);
}

{
  // ── 一直瞬时失败:试满上限,而且"试过几次"要说得出口 ──
  const doc = docOf([node("A", RETRY_AGENT.id), node("B", RETRY_AGENT.id)], [edge("A", "B")]);
  const h = makePorts({
    outcome: () => ({ status: "failed", summary: "", error: "503 service unavailable" }),
  });
  const result = await runWorkflow({ doc, prompt: "x", ports: h.ports, signal: controller().signal });

  eq("试满清单声明的次数", h.calls.filter((c) => c.id === "A").length, 3);
  eq("最终还是失败", result.outcomes.get("A")?.status, "failed");
  check(
    "原因里说得出试过几次(用户等的那一分多钟得有个交代)",
    (result.outcomes.get("A")?.error ?? "").includes("已自动重试 2 次"),
    result.outcomes.get("A")?.error,
  );
  // 重试耗尽之后,下游的语义**一个字都不该变** —— 上游没成功,它就是 skipped。
  eq("重试耗尽后下游照旧 skipped", result.outcomes.get("B")?.status, "skipped");
}

{
  // ── 回归:没声明 retry 的类型,行为和这个字段存在之前一模一样 ──
  const doc = docOf([node("A")], []);
  const h = makePorts({
    outcome: () => ({ status: "failed", summary: "", error: "429 rate limit" }),
  });
  await runWorkflow({ doc, prompt: "x", ports: h.ports, signal: controller().signal });
  eq("没声明 retry 的清单:瞬时失败也只跑一趟", h.calls.filter((c) => c.id === "A").length, 1);
}

summary();
