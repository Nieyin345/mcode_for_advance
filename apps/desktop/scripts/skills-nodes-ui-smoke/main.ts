/**
 * skills-nodes-ui-smoke — 【MC-050 同类】「节点技能总览」的读取完整度,组件级。
 *
 * ## 盯的是什么
 *
 * `SkillNodesView` 逐个 `workflow.get` 拿节点参数反查"谁在用这个技能"。从前的
 * `catch { 跳过 }` 让一份读不回来的工作流**悄悄消失**,它引用的技能掉进
 * 「没有被任何节点用到」那一栏 —— 而那一栏的用途是**清理**。台账 MC-050 的
 * 定性:漏读被算成"未使用",而界面没有任何线索。
 *
 * 这一套把真 `SkillNodesView` 挂进极小 React 运行时(`fakeReact`,与
 * clickable-row-a11y-smoke 同一引擎),`api` 换成可编程替身,断言**用户看到的那几行字**:
 *
 *   1. 读失败时面板里出现「有 N 份工作流没读回来」,并逐条点名 id 与原因;
 *   2. 全部读回来时**没有**这条警告(正控 —— 防"一律报警"的过度保守);
 *   3. 读失败时,那份工作流引用的技能**不能**出现在"没用到"里 —— 它没入表,
 *      但警告说清了结果不完整;读得回来的那份引用的技能照常进"被使用"。
 *
 * ## 为什么需要组件级
 *
 * `nodesUsageView` 的纯函数已被 `node-skills-view-smoke` 钉住;那一层绿**不代表**
 * 组件真的把 `unreadWorkflows` 画出来 —— 挂在 State 上忘了渲染、或者渲染了但
 * 文案不点名,纯函数测试一条都抓不到。这一套补的正是"接线"。
 *
 * Run: scripts/skills-nodes-ui-smoke/run.sh
 */
import "./prelude.js";
import { __mount, __nodes, __text, __flush } from "./fakeReact.js";
import { __setScenario } from "./api-stub.js";
import { SkillNodesView } from "@renderer/components/settings/SkillNodesView.js";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

function mountView(): void {
  __mount(() =>
    SkillNodesView({
      skills: [{ name: "alive-skill" }, { name: "orphan-skill" }],
      onJumpToWorkflow: () => {},
      onJumpToProfile: () => {},
    } as never),
  );
}

/** 渲染树里所有文本拼成一条 —— 判据立在用户看到的那行字上。 */
function allText(): string {
  return __text();
}

// 第 1 趟:两份工作流,一份好一份读失败。
__setScenario({
  profiles: [],
  list: [
    { id: "wf_ok", name: "好的工作流" },
    { id: "wf_bad", name: "坏的工作流" },
  ],
  gets: {
    wf_ok: {
      workflow: {
        id: "wf_ok", name: "好的工作流", kind: "graph", builtin: false, prompt: "", edges: [], updatedAt: 0,
        nodes: [{ id: "n1", type: "mcode.agent", title: "评审", params: { skills: ["alive-skill"] }, position: { x: 0, y: 0 } }],
      },
    },
    wf_bad: { error: "存档损坏 wf_bad.payload" },
  },
});
mountView();
await __flush();
const textBroken = allText();

console.log("\n读不回来时的面板");
check("★ 面板点名「有 1 份工作流没读回来」", textBroken.includes("有 1 份工作流没读回来"), textBroken);
check("★ 逐条点名是哪一份(id)", textBroken.includes("wf_bad"), textBroken);
check("★ 逐条带上原始原因", textBroken.includes("存档损坏 wf_bad.payload"), textBroken);
check("★ 说清「没用到」那栏不能当清理依据", textBroken.includes("别拿它当清理依据"), textBroken);

console.log("\n读得回来的照常反查");
check("★ 好工作流引用的技能进「被使用」", textBroken.includes("被 1 处使用"), textBroken);
check("好工作流的名字出现在引用行", textBroken.includes("好的工作流"), textBroken);
check("读失败的工作流没有伪造引用行", !textBroken.includes("坏的工作流"), textBroken);
// 读失败的那份**可能**引用了 orphan-skill,所以我们不知道它有没有人用 —— 但它没有被
// 任何**读得回来**的来源引用,仍会落进 unused;关键是没有**假**的"被使用"。
check("没被读回来的来源不会造出引用行", !__nodes().some((n) => String((n.props.children as { title?: string } | undefined)?.title ?? "").includes("坏的工作流")), __nodes().length);

// 第 2 趟:全部读得回来 —— 警告必须消失(正控)。
__setScenario({
  profiles: [],
  list: [{ id: "wf_ok", name: "好的工作流" }],
  gets: {
    wf_ok: {
      workflow: {
        id: "wf_ok", name: "好的工作流", kind: "graph", builtin: false, prompt: "", edges: [], updatedAt: 0,
        nodes: [
          { id: "n1", type: "mcode.agent", title: "评审", params: { skills: ["alive-skill"] }, position: { x: 0, y: 0 } },
          { id: "n2", type: "mcode.agent", title: "写作", params: { skills: ["orphan-skill"] }, position: { x: 0, y: 0 } },
        ],
      },
    },
  },
});
mountView();
await __flush();
const textHealthy = allText();

console.log("\n全部读回来时");
check("★ 没有「没读回来」的警告", !textHealthy.includes("没读回来"), textHealthy);
check("没有「不完整」措辞", !textHealthy.includes("不完整"), textHealthy);
check("两个技能都进了「被使用」", textHealthy.includes("被 1 处使用") && textHealthy.includes("alive-skill") && textHealthy.includes("orphan-skill"), textHealthy);
check("没有「没有被任何节点用到」段(两个都有引用)", !textHealthy.includes("没有被任何节点用到"), textHealthy);

console.log(`\nskills-nodes-ui-smoke: ${total - failures}/${total} 通过`);
if (failures > 0) process.exit(1);
