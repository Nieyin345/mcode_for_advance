/**
 * Headless smoke for 设置 → 工作流 (batches C + D).
 *
 * Four layers, because the panel's risk sits in four different places:
 *
 *  1. **The view model** (`workflowView.ts` + `lib/workflowLabels.tsx`) — which fields a
 *     built-in locks, when a document counts as dirty, what gets written back, which
 *     button says 恢复默认 vs 删除, which language a built-in's name comes from.
 *  2. **The editing operations** (`workflowEdit.ts`) — the invariants that keep a graph
 *     valid: deleting a node takes its edges with it, a dependency is idempotent, a
 *     tick that would close a cycle is refused, and a connection pulled out on the
 *     canvas lands on the *same* edge a tick would have made.
 *  3. **The geometry** (`workflowLayout.ts`) — layering, the free-slot search, canvas
 *     bounds, edge paths, edge midpoints, drop-target hit testing. Pure arithmetic, so
 *     it is asserted numerically instead of by looking at a screenshot.
 *  4. **The markup** — `NodeInspector`, `WorkflowListRow`, `WorkflowNodeCard` and the
 *     `WorkflowsPanel` tab container are rendered through `react-dom/server` against
 *     real documents in BOTH locales.
 *
 * What is deliberately NOT exercised: `WorkflowLibraryView`'s RPC wiring and autosave.
 * Effects do not run under SSR, so rendering it would only ever show the empty frame.
 * That layer is thin and typechecked, and its contracts (`workflow.list` / `get` /
 * `save` / `remove` / `nodeTypes`) were verified handler-level when the RPCs landed
 * (batch A). The presentational pieces — the ones a user actually reads — are all here.
 *
 * Run: scripts/workflow-view-smoke/run.sh
 */
import "./prelude.js";
import { readFileSync, readdirSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import {
  findNodeType,
  forSave,
  groupNodeTypes,
  isDocDirty,
  isIdentityLocked,
  isNodeDeleteKey,
  isProtectedNode,
  missingRequiredName,
  nodeTitle,
  purposeOf,
  removeActionOf,
  uniqueWorkflowName,
  type WorkflowPurpose,
} from "@renderer/components/settings/workflows/workflowView.js";
import {
  addNode,
  applyLayout,
  connect,
  edgeId,
  makeWorkflowId,
  makeNodeId,
  moveNode,
  newAutomationDoc,
  newWorkflowDoc,
  relayout,
  removeEdge,
  removeNode,
  seedMainAgent,
  setDependency,
  updateEdge,
  updateNode,
  wouldCycle,
} from "@renderer/components/settings/workflows/workflowEdit.js";
import {
  CANVAS_PAD,
  LANE_GAP,
  LANE_INSET,
  LAYER_GAP,
  MIN_CANVAS_H,
  MIN_CANVAS_W,
  NODE_H,
  NODE_W,
  SIBLING_GAP,
  autoLayout,
  backEdgeLanes,
  canvasSize,
  edgeMidpoint,
  edgePath,
  firstFreeSlot,
  hitTestNode,
  isBackEdge,
  type Box,
} from "@renderer/components/settings/workflows/workflowLayout.js";
import { NodeInspector } from "@renderer/components/settings/workflows/NodeInspector.js";
import {
  SaveStateLine,
  type SaveState,
} from "@renderer/components/settings/workflows/SaveStateLine.js";
import {
  insertSnippet,
  insertableGroups,
} from "@renderer/components/settings/workflows/insertVariable.js";
import { AgentProfilesView } from "@renderer/components/settings/workflows/AgentProfilesView.js";
import { WorkflowListRow } from "@renderer/components/settings/workflows/WorkflowListRow.js";
import { WorkflowNodeCard } from "@renderer/components/settings/workflows/WorkflowNodeCard.js";
import { WorkflowCanvas } from "@renderer/components/settings/workflows/WorkflowCanvas.js";
import { BranchChoiceCard } from "@renderer/components/chat/BranchChoiceCard.js";
import { BRANCH_STOP_CHOICE } from "@contracts/nodeType";
import { WorkflowsPanel } from "@renderer/components/settings/workflows/WorkflowsPanel.js";
import {
  isBuiltinWorkflowId,
  workflowDisplayDescription,
  workflowDisplayName,
} from "@renderer/lib/workflowLabels.js";
import {
  makeAgentProfileId,
  paramsForProfile,
  parseAgentProfile,
  profileFromParams,
  validateAgentProfile,
  AGENT_PROFILE_ID_RE,
  type AgentProfile,
} from "@contracts/agentProfile";
import {
  MAIN_NODE_TYPE_ID,
  NODE_PARAM_REF_SOURCES,
  isNodeRunnable,
  isRunnerImplemented,
  mcpServerNamesOf,
  pluginNamesOf,
  providerIdOf,
  renderNodeTypeCatalog,
  skillNamesOf,
  validateNodeParams,
  validateNodeTypeManifest,
  type NodeTypeCatalog,
  type NodeTypeEntry,
  type NodeTypeManifest,
} from "@contracts/nodeType";
import type { WorkflowDoc, WorkflowEdge, WorkflowListEntry, WorkflowNode } from "@contracts/workflow";

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

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

/* ────────────────────────── fixtures ────────────────────────── */

/** A built-in: its name/description live in the dictionary, not in the data. */
const BUILTIN: WorkflowDoc = {
  id: "read",
  name: "文献精读",
  description: "定位、读全文、拆问题/方法/实验/局限。",
  icon: "book",
  prompt: "## 流程\n先定位,再通读。",
  nodes: [],
  edges: [],
  builtin: true,
  updatedAt: 0,
};

/** A user-authored one: nothing about it is translated. */
const CUSTOM: WorkflowDoc = {
  id: "wf_demo",
  name: "我的流程",
  prompt: "先做 A,再做 B。",
  nodes: [],
  edges: [],
  builtin: false,
  updatedAt: 1234,
};

const AGENT_MANIFEST: NodeTypeManifest = {
  id: "mcode.agent",
  manifestVersion: 1,
  name: "子 agent",
  description: "带独立指令的一个步骤。",
  category: "通用",
  runner: { kind: "prompt" },
  capability: "read",
  params: [
    { key: "instruction", kind: "longtext", label: "指令", required: true, help: "这一步要做什么。" },
    { key: "model", kind: "ref", from: "models", label: "模型" },
    // 多选那种形态 —— 技能就是这个形状(`skills` + `multiple`)。
    { key: "skills", kind: "ref", from: "skills", multiple: true, label: "技能" },
    // 引擎(提供方)。和真清单一样是 `ref: providers`,单选。
    { key: "provider", kind: "ref", from: "providers", label: "引擎" },
    // 产出那两项(和真清单一致,见 `@contracts/outputConstraint`)。**夹具要跟真清单一个
    // 形状**:少了它们,下面"表单有没有把产出变量渲染出来"就没得测了。
    { key: "outputContract", kind: "longtext", label: "期望产出" },
    { key: "outputVars", kind: "variables", label: "产出变量" },
  ],
};

const AGENT_ENTRY: NodeTypeEntry = {
  id: AGENT_MANIFEST.id,
  source: "builtin",
  from: "mcode",
  manifest: AGENT_MANIFEST,
};

/** A third-party type that is drawn but cannot run — the `command` runner. */
const COMMAND_MANIFEST: NodeTypeManifest = {
  id: "demo.parse",
  manifestVersion: 1,
  name: "解析",
  runner: { kind: "command", entry: "parse.py" },
  capability: "exec",
  params: [
    { key: "target", kind: "select", label: "目标", required: true, options: [{ value: "a", label: "A" }] },
    { key: "verbose", kind: "boolean", label: "详细" },
  ],
};

const COMMAND_ENTRY: NodeTypeEntry = {
  id: COMMAND_MANIFEST.id,
  source: "plugin",
  from: "demo-plugin",
  manifest: COMMAND_MANIFEST,
};

/** 岔路口。**没有参数** —— 它的选项就是它的出边(见 `WorkflowEdge` 的 label/note)。 */
const BRANCH_MANIFEST: NodeTypeManifest = {
  id: "mcode.branch",
  manifestVersion: 1,
  name: "分支",
  description: "跑到它就把决定权交给你。",
  runner: { kind: "branch" },
  capability: "read",
  params: [],
};

const BRANCH_ENTRY: NodeTypeEntry = {
  id: BRANCH_MANIFEST.id,
  source: "builtin",
  from: "mcode",
  manifest: BRANCH_MANIFEST,
};

/** 对话节点:跑在主对话里那一种。参数表里**只有指令**(见 `@contracts/nodeType`)。 */
const CONVERSATION_MANIFEST: NodeTypeManifest = {
  id: "mcode.conversation",
  manifestVersion: 1,
  name: "对话节点",
  runner: { kind: "conversation" },
  capability: "read",
  params: [
    { key: "instruction", kind: "longtext", label: "指令", required: true, help: "要说的那句话。" },
  ],
};

const CONVERSATION_ENTRY: NodeTypeEntry = {
  id: CONVERSATION_MANIFEST.id,
  source: "builtin",
  from: "mcode",
  manifest: CONVERSATION_MANIFEST,
};

const CATALOG: NodeTypeCatalog = {
  entries: [AGENT_ENTRY, COMMAND_ENTRY, BRANCH_ENTRY],
  problems: [],
};

function node(id: string, x: number, y: number, type = AGENT_MANIFEST.id): WorkflowNode {
  return { id, type, title: id, params: { instruction: `${id} 干什么` }, position: { x, y } };
}

/** A → B, A → C, B → D, C → D. */
const DIAMOND: WorkflowDoc = {
  ...CUSTOM,
  nodes: [
    node("A", 0, 0),
    node("B", 0, 100),
    node("C", 0, 200),
    node("D", 0, 300),
  ],
  edges: [
    { id: edgeId("A", "B"), from: "A", to: "B" },
    { id: edgeId("A", "C"), from: "A", to: "C" },
    { id: edgeId("B", "D"), from: "B", to: "D" },
    { id: edgeId("C", "D"), from: "C", to: "D" },
  ],
};

function entryOf(doc: WorkflowDoc, edited = false): WorkflowListEntry {
  return {
    id: doc.id,
    name: doc.name,
    ...(doc.description ? { description: doc.description } : {}),
    builtin: doc.builtin,
    edited,
    kind: doc.nodes.length > 0 ? "graph" : "prompt",
    updatedAt: doc.updatedAt,
  };
}

/* ────────────────────── 1. 可改的字段 / 脏 ────────────────────── */

console.log("\nisIdentityLocked / isDocDirty");
eq("内置:名称与说明锁定", isIdentityLocked(BUILTIN), true);
eq("自建:名称与说明可改", isIdentityLocked(CUSTOM), false);
check("同一份文档不算脏", !isDocDirty(CUSTOM, CUSTOM));
check("改了 prompt 算脏", isDocDirty({ ...CUSTOM, prompt: "改了" }, CUSTOM));
check("换了 nodes 数组算脏", isDocDirty({ ...CUSTOM, nodes: [node("x", 0, 0)] }, CUSTOM));
check("换了 edges 数组算脏", isDocDirty({ ...CUSTOM, edges: [] as WorkflowDoc["edges"] }, CUSTOM));
// `updatedAt` 由主进程盖,草稿里那份永远是旧的;比它会让"刚存完"立刻又判成脏,自动
// 保存就此进入死循环。
check("只换 updatedAt 不算脏", !isDocDirty({ ...CUSTOM, updatedAt: 999 }, CUSTOM));
check("内置:名字变了也不算脏(界面上显示的是词条)", !isDocDirty({ ...BUILTIN, name: "随便改" }, BUILTIN));

console.log("\nisNodeDeleteKey(键盘删除节点)");
const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => ({
  key: k,
  ctrlKey: mods.ctrlKey ?? false,
  metaKey: mods.metaKey ?? false,
  altKey: mods.altKey ?? false,
});
check("Delete 删", isNodeDeleteKey(key("Delete"), false));
check("Backspace 也删", isNodeDeleteKey(key("Backspace"), false));
// **正在打字的地方不算** —— 检查器里那些输入框里的 Backspace 是删一个字符,而它离
// "删掉整个节点"只差一次误触。这条是这组里最要紧的。
check("正在输入框里打字时不删", !isNodeDeleteKey(key("Backspace"), true));
check("打字时按 Delete 也不删", !isNodeDeleteKey(key("Delete"), true));
// 修饰键按着的时候,这两个键在别处有别的意思。
check("Ctrl+Delete 不删", !isNodeDeleteKey(key("Delete", { ctrlKey: true }), false));
check("⌘+Backspace 不删", !isNodeDeleteKey(key("Backspace", { metaKey: true }), false));
check("Alt+Delete 不删", !isNodeDeleteKey(key("Delete", { altKey: true }), false));
// 别的键一概不管 —— 尤其 Escape(设置页拿它关面板)和方向键。
check("Escape 不删", !isNodeDeleteKey(key("Escape"), false));
check("字母键不删", !isNodeDeleteKey(key("d"), false));
check("方向键不删", !isNodeDeleteKey(key("ArrowDown"), false));
// ⚠️ 这里测的是**判据**。那条监听的挂法(选中才挂、卸载时摘掉)测不到 —— 静态标记里
// 没有键盘事件,要的是真按一下。那一半靠手动验收。

console.log("\nforSave");
const savedBuiltin = forSave({ ...BUILTIN, name: "乱改", description: "乱改", prompt: "新流程" }, BUILTIN);
eq("内置:名称还原成基线", savedBuiltin.name, BUILTIN.name);
eq("内置:说明还原成基线", savedBuiltin.description, BUILTIN.description);
eq("内置:流程文字照写", savedBuiltin.prompt, "新流程");
const savedCustom = forSave({ ...CUSTOM, name: "改过的名字" }, CUSTOM);
eq("自建:原样通过", savedCustom.name, "改过的名字");
// **这条是自动保存的防死循环闸**:`forSave` 丢掉的字段,`isDocDirty` 必须也忽略。
// 否则存完之后那两个字段仍然不同,"脏"永远为真,防抖窗口会一个接一个地写下去。
check("内置:存完之后不再判脏", !isDocDirty(savedBuiltin, savedBuiltin));
check(
  "内置:存完之后 working 与基线也不判脏",
  !isDocDirty({ ...BUILTIN, name: "乱改", description: "乱改", prompt: "新流程" }, savedBuiltin),
);
check("自建:存完之后不再判脏", !isDocDirty(savedCustom, savedCustom));

console.log("\nmissingRequiredName");
check("自建:名称空 → 存不下去", missingRequiredName({ ...CUSTOM, name: "" }));
check("自建:只有空格也算空", missingRequiredName({ ...CUSTOM, name: "   " }));
check("自建:有内容就能存", !missingRequiredName({ ...CUSTOM, name: " 我的流程 " }));
// 内置的名称不可改,界面根本不会让它变空 —— 判据和 `isIdentityLocked` 对齐,
// 否则内置会被误判成"存不下去",自动保存永远不触发。
check("内置:不参与这条判断", !missingRequiredName({ ...BUILTIN, name: "" }));

/* ─────────────────── 2. 「恢复默认」/「删除」/ 命名 ─────────────────── */

console.log("\nremoveActionOf / uniqueWorkflowName");
eq("内置 → 恢复默认", removeActionOf({ builtin: true }), "reset");
eq("自建 → 删除", removeActionOf({ builtin: false }), "delete");
eq("名字没被占 → 原样", uniqueWorkflowName("新工作流", ["别的"]), "新工作流");
eq("名字被占 → 加序号", uniqueWorkflowName("新工作流", ["新工作流"]), "新工作流 2");
eq("序号也被占 → 往下找", uniqueWorkflowName("新工作流", ["新工作流", "新工作流 2"]), "新工作流 3");

/* ────────────────────── 3. 编辑操作 ────────────────────── */

console.log("\naddNode / updateNode / moveNode");
const withNode = addNode(CUSTOM, AGENT_MANIFEST);
eq("加了一个节点", withNode.nodes.length, 1);
eq("节点记的是类型 id", withNode.nodes[0].type, AGENT_MANIFEST.id);
eq("标题先给类型名", withNode.nodes[0].title, AGENT_MANIFEST.name);
eq("参数由清单铺默认值(必填落空串)", withNode.nodes[0].params.instruction, "");
check("可选参数不铺(没有默认值)", !("model" in withNode.nodes[0].params));
check("原文档没被就地改掉", CUSTOM.nodes.length === 0);
check("新节点有唯一 id", withNode.nodes[0].id.startsWith("n_"));
check("两次生成的 id 不同", makeNodeId() !== makeNodeId());
check("两次生成的工作流 id 不同", makeWorkflowId() !== makeWorkflowId());
check("工作流 id 带 wf_ 前缀", makeWorkflowId().startsWith("wf_"));

const missing = updateNode(withNode, "不存在", { title: "x" });
check("改不存在的节点 → 原对象(不白触发一次保存)", missing === withNode);
const retitled = updateNode(withNode, withNode.nodes[0].id, { title: "检索" });
eq("改了标题", retitled.nodes[0].title, "检索");
check("改节点产生的是新数组", retitled.nodes !== withNode.nodes);

const moved = moveNode(retitled, retitled.nodes[0].id, { x: 120, y: 40 });
eq("移动写回 x", moved.nodes[0].position.x, 120);
eq("移动写回 y", moved.nodes[0].position.y, 40);

console.log("\nref 参数(模型 / 技能这类的形状校验)");
check("单选给了字符串 → 通过", validateNodeParams(AGENT_MANIFEST, { instruction: "x", model: "m1" }).ok);
check("单选给了数组 → 拒", !validateNodeParams(AGENT_MANIFEST, { instruction: "x", model: ["m1"] }).ok);
check("多选给了字符串 → 拒", !validateNodeParams(AGENT_MANIFEST, { instruction: "x", skills: "pdf" }).ok);
check("多选给了一组名字 → 通过", validateNodeParams(AGENT_MANIFEST, { instruction: "x", skills: ["pdf"] }).ok);
check("多选给了空数组 → 通过(等于没限制)", validateNodeParams(AGENT_MANIFEST, { instruction: "x", skills: [] }).ok);
check("多选里混进数字 → 拒", !validateNodeParams(AGENT_MANIFEST, { instruction: "x", skills: [1] }).ok);
// 候选在**这台机器上**,所以**不查名字存不存在** —— 换台机器跑,那个技能可能没装。
// 存盘时按"本机装没装"拒绝,等于让工作流没法分享(同"类型缺失不算错误"那条)。
check("名字本机没装也放行", validateNodeParams(AGENT_MANIFEST, { instruction: "x", skills: ["ghost"] }).ok);

console.log("\noptions 参数(输入选项那张表的形状校验)");
// 夹具:在 agent 清单上多声明一个 `options` 参数 —— 真清单里只有主代理带它
// (见 `nodeTypes.ts` 的 `optionsParam`),但校验只认 kind,不认"哪种节点"。
const OPT_MANIFEST: NodeTypeManifest = {
  ...AGENT_MANIFEST,
  params: [...AGENT_MANIFEST.params, { key: "options", kind: "options", label: "输入选项" }],
};
check("名字+内容 → 通过", validateNodeParams(OPT_MANIFEST, { instruction: "x", options: [{ name: "深挖", content: "把这篇讲透" }] }).ok);
check("带解释也通过(note 可选)", validateNodeParams(OPT_MANIFEST, { instruction: "x", options: [{ name: "深挖", content: "c", note: "n" }] }).ok);
check("容忍没填完的空行", validateNodeParams(OPT_MANIFEST, { instruction: "x", options: [{ name: "", content: "", note: "" }, { name: "深挖", content: "c" }] }).ok);
check("给了字符串 → 拒", !validateNodeParams(OPT_MANIFEST, { instruction: "x", options: "深挖" }).ok);
check("一项缺名字 → 拒", !validateNodeParams(OPT_MANIFEST, { instruction: "x", options: [{ content: "c" }] }).ok);
check("一项缺内容 → 拒", !validateNodeParams(OPT_MANIFEST, { instruction: "x", options: [{ name: "深挖" }] }).ok);
check("数组里混进字符串 → 拒", !validateNodeParams(OPT_MANIFEST, { instruction: "x", options: ["深挖"] }).ok);

console.log("\nselects 参数(固定条件那张表的形状校验)");
// 夹具:在 agent 清单上多声明一个 `selects` 参数 —— 真清单里只有主代理带它
// (见 `nodeTypes.ts` 的 `criteriaParam`),但校验只认 kind,不认"哪种节点"。
const SEL_MANIFEST: NodeTypeManifest = {
  ...AGENT_MANIFEST,
  params: [...AGENT_MANIFEST.params, { key: "criteria", kind: "selects", label: "固定条件" }],
};
check("条件名+候选值 → 通过", validateNodeParams(SEL_MANIFEST, { instruction: "x", criteria: [{ name: "时间范围", choices: ["不限", "近三年"] }] }).ok);
check("候选值不是字符串数组 → 拒", !validateNodeParams(SEL_MANIFEST, { instruction: "x", criteria: [{ name: "时间范围", choices: ["不限", 3] }] }).ok);
check("候选值不是数组 → 拒", !validateNodeParams(SEL_MANIFEST, { instruction: "x", criteria: [{ name: "时间范围", choices: "不限" }] }).ok);
check("一项缺条件名 → 拒", !validateNodeParams(SEL_MANIFEST, { instruction: "x", criteria: [{ choices: ["不限"] }] }).ok);
check("容忍没填完的空行", validateNodeParams(SEL_MANIFEST, { instruction: "x", criteria: [{ name: "", choices: [] }, { name: "时间范围", choices: ["不限"] }] }).ok);
check("给了字符串 → 拒", !validateNodeParams(SEL_MANIFEST, { instruction: "x", criteria: "时间范围" }).ok);

console.log("\n引用型清单的校验(装进来的时候就挡住)");
const refManifest = (params: unknown[]): unknown => ({ ...AGENT_MANIFEST, params });
check(
  "ref 写了 from → 通过",
  validateNodeTypeManifest(refManifest([{ key: "a", kind: "ref", from: "skills", label: "A" }])).ok,
);
check(
  "ref 没写 from → 拒(渲染端不知道去哪取候选)",
  !validateNodeTypeManifest(refManifest([{ key: "a", kind: "ref", label: "A" }])).ok,
);
check(
  "不是 ref 却写了 from → 拒",
  !validateNodeTypeManifest(refManifest([{ key: "a", kind: "text", label: "A", from: "skills" }])).ok,
);
check(
  "from 是个没实现的值 → 拒(封闭集合,列进去就等于承诺有用)",
  !validateNodeTypeManifest(refManifest([{ key: "a", kind: "ref", from: "memory", label: "A" }])).ok,
);

console.log("\nskillNamesOf(节点参数 → 这一轮用哪些技能)");
eq("没有这个键 → 空数组", skillNamesOf({}).length, 0);
eq("正常一组", skillNamesOf({ skills: ["pdf", "docx"] }).join(","), "pdf,docx");
eq("单个字符串也认(手写参数的人会这么写)", skillNamesOf({ skills: "pdf" }).join(","), "pdf");
eq("去掉两边空白", skillNamesOf({ skills: ["  pdf  "] })[0], "pdf");
eq("去掉重复", skillNamesOf({ skills: ["pdf", "pdf"] }).length, 1);
eq("去掉空串", skillNamesOf({ skills: ["", "pdf"] }).length, 1);
eq("去掉开头的斜杠(存的是名字,不是 /名字)", skillNamesOf({ skills: ["/pdf", "docx"] }).join(","), "docx");
check("数组里混进别的类型只丢那一个", skillNamesOf({ skills: ["pdf", 7, null] }).join(",") === "pdf");
check("既不是数组也不是字符串 → 空", skillNamesOf({ skills: { a: 1 } }).length === 0);

console.log("\nmcpServerNamesOf / pluginNamesOf(同一条读法的另两个宾语)");
// 三个"可选的东西"共用 `nameListOf` 那一套脏值规则 —— 这里逐个钉一遍,是因为
// "复制粘贴时漏改键名"的后果是**静默的**:参数存下来了,引擎那边永远读到空 = 不限制。
eq("没有这个键 → 空数组", mcpServerNamesOf({}).length, 0);
eq("正常一组", mcpServerNamesOf({ mcp: ["browser", "zotero"] }).join(","), "browser,zotero");
eq("单个字符串也认", mcpServerNamesOf({ mcp: "browser" }).join(","), "browser");
eq("去掉重复", mcpServerNamesOf({ mcp: ["browser", "browser"] }).length, 1);
check("数组里混进别的类型只丢那一个", mcpServerNamesOf({ mcp: ["browser", 7] }).join(",") === "browser");
// **键名各读各的**:`skills` 里那一组不能从 `mcp` 读出来(反之亦然)。少了这一条,
// 把三个访问器写成同一个键也照样过。
eq("mcp 读不到 skills 里的东西", mcpServerNamesOf({ skills: ["pdf"] }).length, 0);
eq("plugins 读不到 mcp 里的东西", pluginNamesOf({ mcp: ["browser"] }).length, 0);
eq("插件那一份照常", pluginNamesOf({ plugins: ["mcode-document-skills"] }).join(","), "mcode-document-skills");
check("插件那一份也丢非字符串", pluginNamesOf({ plugins: ["mcode-document-skills", null] }).length === 1);

console.log("\nrenderNodeTypeCatalog(给模型看的那份目录)");
// 这份文字是"让 AI 自己改工作流"的前提 —— 它得先知道有什么可用(见 contracts 里
// 那个函数的注释)。
const catalogText = renderNodeTypeCatalog([AGENT_ENTRY]);
check("列出类型 id", catalogText.includes("`mcode.agent`"));
check("必填标出来", catalogText.includes("instruction(longtext,必填)"));
// 引用型的**值的形状**必须写出来:候选在用户机器上,模型看不见那份列表,不写它只能猜,
// 而猜错就是一次存盘失败。
check("多选引用写清值是一组名字", catalogText.includes("skills(ref:string[])"), catalogText);
check("单选引用写清值是一个名字", catalogText.includes("model(ref:string)"), catalogText);

console.log("\nrenderNodeTypeCatalog · 参数那一行要说清怎么填");
// 这份目录现在是 `mcp__mcode-workflow__node_types_list` 的返回(见 contracts 里那个
// 函数的注释),所以它必须**够模型把参数填对**:只给键名和类型不够。
const bothText = renderNodeTypeCatalog([AGENT_ENTRY, COMMAND_ENTRY]);
check("带上参数的中文名(label)", bothText.includes("**产出变量**"), bothText);
check("带上作者的说明(help)", bothText.includes("—— 这一步要做什么。"), bothText);
// 变量表是唯一一个"值既不是标量也不是标量数组"的种类 —— 形状不写出来它猜不出来。
check(
  "变量的值形状单独写出来",
  bothText.includes("值的形状:[{ name: 变量名, example: 示例 }]"),
  bothText,
);
// 下拉的候选值同理:模型看不到那个选择框,不列出来只能自己编一个,而校验会拒掉。
check("下拉的候选值列出来", bothText.includes("可选值:a"), bothText);
check("下拉也有中文名", bothText.includes("**目标**"), bothText);

console.log("\nremoveNode(连带删边)");
const stripped = removeNode(DIAMOND, "B");
eq("节点少了一个", stripped.nodes.length, 3);
eq("连到它的两条边一起走了", stripped.edges.length, 2);
check("留下的边都不再引用 B", stripped.edges.every((e) => e.from !== "B" && e.to !== "B"));
check("删不存在的节点 → 原对象", removeNode(DIAMOND, "zzz") === DIAMOND);

console.log("\nseedMainAgent(新建的图自带一个主代理)");
// 夹具就是上面那份子 agent 清单换掉 id 和名字 —— 两份清单的参数表本来就是共用的
// (见 `main/orchestration/nodeTypes.ts` 的 `agentParams`)。
const MAIN_MANIFEST: NodeTypeManifest = { ...AGENT_MANIFEST, id: MAIN_NODE_TYPE_ID, name: "主代理" };
const MAIN_ENTRY: NodeTypeEntry = { id: MAIN_MANIFEST.id, source: "builtin", from: "mcode", manifest: MAIN_MANIFEST };

{
  const seeded = seedMainAgent(newWorkflowDoc("wf_new", "新流程"), MAIN_MANIFEST);
  eq("白纸上多了一个节点", seeded.nodes.length, 1);
  eq("类型就是主代理", seeded.nodes[0].type, MAIN_NODE_TYPE_ID);
  eq("标题先给类型名(不是一张没字的卡片)", seeded.nodes[0].title, "主代理");
  eq("落在原点", seeded.nodes[0].position.x, 0);
  eq("纵坐标也是 0", seeded.nodes[0].position.y, 0);
  // 参数**由清单铺默认值**而不是凭空写一个 —— 必填项因此立刻在检查器里可见可填。
  check("参数按清单铺了(必填的指令在)", "instruction" in seeded.nodes[0].params, seeded.nodes[0].params);
  // ⚠️ 光"有这个键"不够:`validateNodeParams` 把**空串**也当成没填,所以必填项留空的
  // 话整份图存不下去(用户点「新建」得到一个错误弹窗)。跨层那条链在
  // `mcode-admin-smoke` 里验(种出来的东西要过得了主进程的 `saveWorkflow`),这里先
  // 钉住"它不是空的"。
  check(
    "而且指令预填了内容(留空的话整份图存不进去)",
    String(seeded.nodes[0].params.instruction ?? "").trim().length > 0,
    seeded.nodes[0].params,
  );

  const again = seedMainAgent(seeded, MAIN_MANIFEST);
  eq("已经有了就不再叠一个", again.nodes.length, 1);
  check("而且原样返回同一个文档(调用方可以靠引用相等跳过落盘)", again === seeded);

  // **全空的图不在主代理的管辖内**:一份分享来的、或手工拼出来的图可能一个节点都没有。
  eq("种在空图上就是它自己", seedMainAgent(newWorkflowDoc("wf_x", "x"), MAIN_MANIFEST).nodes.length, 1);

  // 两种内置类型都要出现在给模型看的那份目录里 —— 主代理是**新加的**,而"新加的节点
  // 类型 AI 不知道"正是那份目录存在的理由。
  const builtinText = renderNodeTypeCatalog([AGENT_ENTRY, MAIN_ENTRY]);
  check("目录里有主代理", builtinText.includes("`mcode.main`"), builtinText);
  check("目录里也有子 agent", builtinText.includes("`mcode.agent`"));
}

console.log("\nisProtectedNode(主代理删不掉)");
check("主代理受保护", isProtectedNode({ type: MAIN_NODE_TYPE_ID }));
check("子 agent 不受保护", !isProtectedNode({ type: "mcode.agent" }));
// 类型没装的节点**不能**因为"认不出来"就变得删不掉 —— 那种节点恰恰是最想删的。
check("没装的类型也不受保护", !isProtectedNode({ type: "someone.else" }));

console.log("\n规矩落在界面那一层,不在编辑操作里");
// 这一条钉的是**分层**:`removeNode` 是纯粹的编辑操作(给我一份删掉这个节点的文档),
// 拦它的是 `handleRemoveNode`(检查器那个按钮 + 键盘的 Delete 都走它)。哪天有人把
// 判断挪进 `removeNode`,`again` 那种"原样返回"的调用方就会开始拿到被拒绝的结果,
// 而这里会当场说出来。
{
  const doc = seedMainAgent(newWorkflowDoc("wf_p", "p"), MAIN_MANIFEST);
  eq("编辑操作本身照删不误(它不认识规矩)", removeNode(doc, doc.nodes[0].id).nodes.length, 0);
}

console.log("\nsetDependency / wouldCycle");
/** 一条链的底稿。**节点得真的在图上** —— `wouldCycle` 走的是 `buildAdjacency`
 *  (`@contracts/workflow` 里"谁依赖谁"的唯一来源),而它只认两端都在 `nodes` 里的边。
 *  拿一个空图配几条凭空捏的边去问"会不会成环",问的是一件真实文档里不存在的事。 */
const CHAIN_BASE: WorkflowDoc = {
  ...CUSTOM,
  nodes: [node("n1", 0, 0), node("n2", 0, 100), node("n3", 0, 200), node("n4", 0, 300)],
};
const linked = setDependency(CHAIN_BASE, "n2", "n1", true);
eq("连出一条边", linked.edges.length, 1);
eq("边由两端命名", linked.edges[0].id, edgeId("n1", "n2"));
eq("from 是上游", linked.edges[0].from, "n1");
check("重复勾不会多一条边", setDependency(linked, "n2", "n1", true) === linked);
eq("取消勾 → 边没了", setDependency(linked, "n2", "n1", false).edges.length, 0);
check("取消本来就没有的边 → 原对象", setDependency(CHAIN_BASE, "n2", "n1", false) === CHAIN_BASE);
check("不能依赖自己", setDependency(CHAIN_BASE, "n1", "n1", true) === CHAIN_BASE);

const chain = setDependency(setDependency(CHAIN_BASE, "n2", "n1", true), "n3", "n2", true);
/** **没有闸门**的情形 —— 环一律算环(原先的行为,现在仍然是对的:环上没岔路口)。 */
const noGate = (): boolean => false;
check("链上再连一条不算环", !wouldCycle(chain, "n4", "n3", noGate));
check("连回祖先会成环(n1 ← n3 再 n3 → n1)", wouldCycle(chain, "n1", "n3", noGate));
check("自己连自己算成环", wouldCycle(chain, "n1", "n1", noGate));
check("菱形不算环", !wouldCycle(DIAMOND, "D", "B", noGate));

console.log("\n回头:环上有岔路口就合法");
// 真的判据是"这个节点的类型 `runner.kind === \"branch\"`"(见 `isLoopGate` 与
// `@contracts/workflow` 的「回头」)。这里只是个"谁是闸门"的替身。
const gateIs =
  (...ids: string[]) =>
  (id: string): boolean =>
    ids.includes(id);
/** n1 → n2 → n3 → n4。再连一条 `n4 → n1` 就闭出一个四个节点的环。 */
const chain4 = setDependency(chain, "n4", "n3", true);
check("环上有闸门(n2 在环中间)→ 放行", !wouldCycle(chain4, "n1", "n4", gateIs("n2")));
check("环上没有闸门 → 还是拒", wouldCycle(chain4, "n1", "n4", noGate));
// 这一条是"闸门必须在**这个**环上"的钉子:图里另有一个岔路口,和这一圈没关系,
// 绕这一圈可以一次都不经过它 —— 那就还是个没人拦着的死循环。
check("闸门在图里但不在这一圈上 → 拒", wouldCycle(chain4, "n1", "n4", gateIs("n9")));
check("闸门在环的入口上 → 放行", !wouldCycle(chain4, "n1", "n4", gateIs("n1")));
check("闸门在环的出口上 → 放行", !wouldCycle(chain4, "n1", "n4", gateIs("n4")));
check(
  "有闸门也不等于什么都能连(不成环还是不成环)",
  !wouldCycle(chain4, "n3", "n1", gateIs("n2")),
);

console.log("\nconnect / removeEdge(画布上拉线与点线走的那条路)");
const pulled = connect(CHAIN_BASE, "n1", "n2");
eq("拉出来一条边", pulled.edges.length, 1);
eq("from 是先跑完的那个", pulled.edges[0].from, "n1");
eq("to 是后开始的那个", pulled.edges[0].to, "n2");
// 方向反了在画面上只是"箭头画反了",不会报错 —— 所以钉死 id,确认它和勾选框
// 产出的**是同一条边**(同一份 `edgeId`),不是一条看上去差不多的新边。
eq("与勾选框产出的是同一条边", pulled.edges[0].id, edgeId("n1", "n2"));
check("重复拉同一条不会多一条", connect(pulled, "n1", "n2") === pulled);
check("拉向自己 → 原对象", connect(CHAIN_BASE, "n1", "n1") === CHAIN_BASE);
const pulledChain = connect(connect(CHAIN_BASE, "n1", "n2"), "n2", "n3");
eq("两条边的链", pulledChain.edges.length, 2);
eq("按 id 删得掉中间那条", removeEdge(pulledChain, edgeId("n1", "n2")).edges.length, 1);
check("删不存在的边 → 原对象", removeEdge(pulledChain, "e_zzz") === pulledChain);
// 两端有一头已经不在图上了(`nope`)。走 `setDependency` 反着调要先从 edges 里
// 把两端捞出来,这条边捞不出来;点画面的那根线拿到的是边本身,按 id 删照样管用。
const orphanEdge = { id: "e_gone", from: "n1", to: "nope" };
check(
  "坏边也按 id 删得掉",
  removeEdge({ ...CHAIN_BASE, edges: [orphanEdge] }, "e_gone").edges.length === 0,
);

console.log("\npurposeOf / newAutomationDoc(工作流与自动化只差一个 trigger)");
const plainDoc = newWorkflowDoc("wf_a", "甲");
const autoDoc = newAutomationDoc("wf_b", "乙");
check("没有触发器 = 工作流", purposeOf(plainDoc) === "workflow");
check("有触发器 = 自动化", purposeOf(autoDoc) === "automation");
eq("新建的自动化默认手动触发", autoDoc.trigger, "manual");
// 判据是**同一个字段**,文档和列表项都收得下 —— 列表分栏与对话里的选择器过滤走的
// 是这一个函数,两边不会分家。
check("列表项也按同一个字段判", purposeOf({ trigger: "schedule" }) === "automation");
check("列表项没有触发器就是工作流", purposeOf({}) === "workflow");
// 除 `trigger` 外逐字相同 —— 这条钉死"两者共用一份文档"这件事:自动化要是哪天长出
// 自己的字段,这条会先失败,而不是等到有人发现两边的编辑器行为不一样。
// (拿**同 id 同名**的那一张来比:不然比出来的是 id 和名字的差别,不是 trigger 的。)
const autoTwin = newWorkflowDoc("wf_b", "乙");
eq(
  "除 trigger 外与一张新工作流逐字相同",
  JSON.stringify({ ...autoDoc, trigger: undefined }),
  JSON.stringify({ ...autoTwin, trigger: undefined }),
);

console.log("\nrelayout / applyLayout");
const laid = relayout(DIAMOND);
eq("A 在第 0 层", laid.nodes.find((n) => n.id === "A")?.position.y, 0);
eq("D 在第 2 层", laid.nodes.find((n) => n.id === "D")?.position.y, 2 * (NODE_H + LAYER_GAP));
check("B 与 C 同层", laid.nodes.find((n) => n.id === "B")?.position.y === laid.nodes.find((n) => n.id === "C")?.position.y);
check("空 map → 原对象", applyLayout(DIAMOND, new Map()) === DIAMOND);
// 已经排好的图再点一次「整理布局」,算出来的就是当前坐标 —— 那时必须**原样返回**。
// 返回新对象会让自动保存判成"脏了",白写一次整库(见 `workflowEdit` 第 1 条不变式)。
check("整理一次之后坐标真的变了", laid !== DIAMOND);
check("在已排好的图上再整理 → 原对象", relayout(laid) === laid);

/* ────────────────────── 4. 几何 ────────────────────── */

console.log("\nfirstFreeSlot");
const emptySlot = firstFreeSlot([]);
check("空画布落在原点", emptySlot.x === 0 && emptySlot.y === 0, emptySlot);
const slot = firstFreeSlot([node("a", 0, 0)]);
check("不与已有节点重叠", !(slot.x < NODE_W && slot.y < NODE_H), slot);
// **行优先**:流程从上往下走,所以先横着把这一行铺满、再往下一行。第二个占位因此
// 落在同一行的右边,而不是掉到下一层去 —— 那会把"新加的一步"排成并列的一步。
check("第二个占位补在同一行右边", slot.y === 0 && slot.x === NODE_W + SIBLING_GAP, slot);
const slots = firstFreeSlot([node("a", 0, 0), node("b", slot.x, slot.y)]);
check("第三个也不与它们重叠", !(slots.x < NODE_W && slots.y < NODE_H) && slots.x !== slot.x, slots);

console.log("\nautoLayout");
const diamond = autoLayout(DIAMOND.nodes, DIAMOND.edges);
eq("A = 第 0 层", diamond.get("A")?.y, 0);
eq("B = 第 1 层", diamond.get("B")?.y, NODE_H + LAYER_GAP);
eq("C = 第 1 层", diamond.get("C")?.y, NODE_H + LAYER_GAP);
eq("D = 第 2 层(最长路径)", diamond.get("D")?.y, 2 * (NODE_H + LAYER_GAP));
check("B 在 C 左边(按原来的 x)", (diamond.get("B")?.x ?? 0) < (diamond.get("C")?.x ?? 0));
const reversed = autoLayout(
  [node("A", 0, 0), node("B", 999, 0), node("C", 5, 0)],
  [],
);
check("同一层内按当前 x 排(整理不该把顺序推倒)", (reversed.get("C")?.x ?? 0) < (reversed.get("B")?.x ?? 0));

console.log("\ncanvasSize / edgePath");
const empty = canvasSize([]);
eq("空画布给最小宽度", empty.width, MIN_CANVAS_W);
eq("空画布给最小高度", empty.height, MIN_CANVAS_H);
const sized = canvasSize([node("a", 400, 300)]);
check("画布随节点长大", sized.width > MIN_CANVAS_W && sized.height > MIN_CANVAS_H, sized);
eq("多留了四周留白", sized.width, 400 + NODE_W + CANVAS_PAD * 2);
const p = edgePath({ x: 0, y: 0, w: NODE_W, h: NODE_H }, { x: 400, y: 200, w: NODE_W, h: NODE_H });
check("线从源卡片下边中点出发", p.startsWith(`M ${NODE_W / 2} ${NODE_H}`), p);
check("线落在目标卡片上边中点", p.endsWith(`${400 + NODE_W / 2} 200`), p);
check("是三次贝塞尔", p.includes(" C "), p);

console.log("\nedgeMidpoint / hitTestNode(拉线与点线用到的两处几何)");
const fromBox: Box = { x: 0, y: 0, w: NODE_W, h: NODE_H };
const toBox: Box = { x: 400, y: 200, w: NODE_W, h: NODE_H };
const mid = edgeMidpoint(fromBox, toBox);
eq("中点 x 是两端中点", mid.x, (NODE_W / 2 + 400 + NODE_W / 2) / 2);
eq("中点 y 是两端中点", mid.y, (NODE_H + 200) / 2);
// 上面那两行只是照抄公式。真正要钉死的是 `edgeMidpoint` 注释里那句推导:控制点
// 外推量在 t=0.5 处正好抵消。所以把路径拆成四个控制点、真的按贝塞尔求一次值 ——
// 以后改 `edgePath` 的弧度(比如改成按高度算),这个删除钮不会跟着跑偏。
const nums = (p.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
const [bx1, by1, bcx1, bcy1, bcx2, bcy2, bx2, by2] = nums;
eq("路径拆出四个控制点", nums.length, 8);
const bezierAtHalf = {
  x: (bx1 + 3 * bcx1 + 3 * bcx2 + bx2) / 8,
  y: (by1 + 3 * bcy1 + 3 * bcy2 + by2) / 8,
};
check(
  "曲线在 t=0.5 处就是 edgeMidpoint(外推量真的抵消了)",
  Math.abs(bezierAtHalf.x - mid.x) < 1e-9 && Math.abs(bezierAtHalf.y - mid.y) < 1e-9,
  { bezierAtHalf, mid },
);

console.log("\n回头边绕行(不能从中间那几张卡片身上穿过去)");
// 「这几步再来一轮」那条边是从**下面的**节点指回**上面的**节点的。
const backNodes = [node("A", 900, 0), node("B", 900, 116), node("C", 900, 232)];
const boxAt = (n: { position: { x: number; y: number } }): Box => ({
  x: n.position.x + CANVAS_PAD,
  y: n.position.y + CANVAS_PAD,
  w: NODE_W,
  h: NODE_H,
});
const [boxTop, boxMid, boxLow] = backNodes.map(boxAt);
check("目标在上面 = 回头边", isBackEdge(boxLow, boxMid));
check("目标在下面就不是", !isBackEdge(boxMid, boxLow));
check("同一层的边也不算", !isBackEdge(boxTop, boxTop));
const laneOf = (nodes: WorkflowNode[], edges: WorkflowEdge[]): number => {
  const lanes = backEdgeLanes(nodes, edges);
  eq("就这一条回头边", lanes.size, 1);
  return lanes.values().next().value as number;
};
const backEdge = (id: string, from: string, to: string): WorkflowEdge => ({ id, from, to });
const lane0 = laneOf(backNodes, [backEdge("e_loop", "C", "B")]);
// 关键的一条:车道**不是**"整张图最右边再往外",而是贴着两端那一列的右边。
const cardsRight = Math.max(...backNodes.map((n) => n.position.x + NODE_W)) + CANVAS_PAD;
eq("车道贴着两端那一列的右边", lane0, cardsRight + LANE_INSET);
// 而"没有卡片横跨这条车道"才是它存在的理由 —— 钉死这一条,以后改挑法也不会挑到一张
// 卡片身上去。
const crossesLane = (nodes: WorkflowNode[], y0: number, y1: number, x: number): boolean =>
  nodes.some((n) => {
    const b = boxAt(n);
    return b.y < y1 && y0 < b.y + b.h && x >= b.x && x < b.x + b.w;
  });
const loopSpan = (nodes: WorkflowNode[]): [number, number] => [
  boxAt(nodes[1]).y,
  boxAt(nodes[2]).y + NODE_H,
];
check("没有卡片横跨这条车道", !crossesLane(backNodes, ...loopSpan(backNodes), lane0));

// **用户踩的那个坑**:图里另有一条支路,它的终点落在很右边的一列上。回头边只是在左边
// 那一列里绕,压根不经过那张卡片所在的那一段纵向范围,所以不该被它顶到图外面去。
const wideNodes = [...backNodes, node("F", 1200, 232)];
const wideLane = laneOf(wideNodes, [backEdge("e_loop", "C", "B")]);
eq("旁边那条支路的终点不影响这条车道", wideLane, lane0);
check("而且比它靠左得多", wideLane < boxAt(wideNodes[3]).x, {
  wideLane,
  farCard: boxAt(wideNodes[3]).x,
});
// 真的挡在空当上时才往右让 —— 这才叫"让"。`G` 的左边在 1032、右边在 1208,而空当
// 起步的位置是 1120,正好被它压住。
const blocked = [node("A", 900, 0), node("B", 900, 116), node("C", 900, 232), node("G", 1000, 150)];
const blockedLane = laneOf(blocked, [backEdge("e_loop", "C", "B")]);
const blocker = boxAt(blocked[3]);
check("有卡片挡在空当上 → 跳到它右边", blockedLane >= blocker.x + blocker.w, {
  blockedLane,
  blocker,
});
check("跳过去之后那条车道上也没东西", !crossesLane(blocked, ...loopSpan(blocked), blockedLane));
// 两条回头边各占一条,不叠在一起。
const twoLanes = backEdgeLanes(backNodes, [backEdge("e1", "C", "B"), backEdge("e2", "C", "A")]);
eq("两条回头边两条道", twoLanes.size, 2);
check(
  "两条道分得开",
  Math.abs((twoLanes.get("e1") as number) - (twoLanes.get("e2") as number)) >= LANE_GAP,
  [...twoLanes.values()],
);
eq(
  "不是回头边的不占道",
  backEdgeLanes(backNodes, [backEdge("e1", "A", "B"), backEdge("e2", "B", "C")]).size,
  0,
);

// 画布得先把车道宽度留出来,不然最外面那条会画到画布外面。留的正好是四周那圈留白 ——
// 多留就是一块谁也滚不到、什么也看不见的空白。
check(
  "有回头边时画布更宽",
  canvasSize(backNodes, [lane0]).width > canvasSize(backNodes).width,
  { withLane: canvasSize(backNodes, [lane0]).width, without: canvasSize(backNodes).width },
);
eq("车道右边只留一圈和别处一样宽的留白", canvasSize(backNodes, [lane0]).width - lane0, CANVAS_PAD);
eq("没回头边时宽度和以前逐像素相同", canvasSize(backNodes).width, canvasSize(backNodes, []).width);
// 车道在卡片左边时(理论上不会有)不该把画布撑大 —— 取的是两者的最大值。
eq("车道在卡片左边时不额外留宽", canvasSize(backNodes, [0]).width, canvasSize(backNodes).width);

const routed = edgePath(boxLow, boxMid, lane0);
const cx = boxLow.x + NODE_W / 2;
check("还是从源的下边中点出发", routed.startsWith(`M ${cx} ${boxLow.y + NODE_H}`), routed);
check("还是落在目标的上边中点", routed.endsWith(`${cx} ${boxMid.y}`), routed);
/** 每个转折点的**起点**(Q 取的是控制点)。曲线整条都在这几个点的凸包里面,所以拿它当
 *  边界是够的 —— 而边界正是这两条断言要钉的东西。 */
const routePts = [...routed.matchAll(/([MLQ]) (-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)].map((m) => ({
  cmd: m[1],
  x: Number(m[2]),
  y: Number(m[3]),
}));
eq("路径拆得出十个转折点", routePts.length, 10);
// 整条路只在「两端中心的竖线」和「车道」之间活动:不往左甩(那会钻到别的卡片底下),
// 也不越过车道(那就跑到画布外面去了)。
check(
  "只在两端与车道之间活动",
  routePts.every((p) => p.x >= cx - 1e-9 && p.x <= lane0 + 1e-9),
  routePts,
);
check("真的走到了车道上", Math.max(...routePts.map((p) => p.x)) === lane0, routePts);
// **不穿卡片**这件事可以真的证出来,不用采样:整条路只有两种走法 —— 两段横线(出去
// 之后那一段、收回来之前那一段)和一段竖线(在车道上)。竖线整条在所有卡片的右边
// (上面那条断言),横线只要各自落在层与层之间的空当里就行了。
const runYs = [...new Set(routePts.map((p) => p.y))].filter(
  (y) => y !== boxLow.y + NODE_H && y !== boxMid.y,
);
check(
  "横向那两段落在卡片之外",
  runYs.every((y) => [boxTop, boxMid, boxLow].every((b) => y <= b.y || y >= b.y + b.h)),
  runYs,
);
eq("拐弯是圆角,不是直角", routePts.filter((p) => p.cmd === "Q").length, 4);
// 删除钮落在那段垂直的车道上 —— 不在车道上就等于挂在半空中。
const routedMid = edgeMidpoint(boxLow, boxMid, lane0);
eq("删除钮落在车道上", routedMid.x, lane0);
eq("删除钮在纵向正中", routedMid.y, (boxLow.y + NODE_H + boxMid.y) / 2);
// 不给车道时一切都和从前一样(常规边一个像素都没动):上下两点叠在同一列时,它仍然是
// 那条直的贝塞尔 —— 常规边**不**自动改道,改道是调用方按 `isBackEdge` 显式要求的。
check(
  "不给车道 → 还是那条三次贝塞尔",
  !edgePath(boxLow, boxMid).includes("Q ") && (edgePath(boxLow, boxMid).match(/C /g) ?? []).length === 1,
  edgePath(boxLow, boxMid),
);
eq(
  "不给车道 → 中点还是取平均",
  edgeMidpoint(boxLow, boxMid).x,
  (boxLow.x + NODE_W / 2 + boxMid.x + NODE_W / 2) / 2,
);

const boxes = new Map<string, Box>([
  ["a", { x: 0, y: 0, w: NODE_W, h: NODE_H }],
  ["b", { x: 300, y: 0, w: NODE_W, h: NODE_H }],
]);
eq("命中第一张", hitTestNode(boxes, 100, 30), "a");
eq("命中第二张", hitTestNode(boxes, 350, 30), "b");
eq("两张之间的空白不命中", hitTestNode(boxes, 260, 30), null);
eq("默认不外扩:边框外 1px 落空", hitTestNode(boxes, NODE_W + 1, 30), null);
eq("外扩 8px 之后边框外也算命中", hitTestNode(boxes, NODE_W + 1, 30, 8), "a");
// 两张叠在一起时取**最上面**那张。Map 的插入顺序就是 nodes 的顺序、也就是绘制
// 顺序,所以"最后一个命中的"就是用户眼里压在上面的那张。
const stacked = new Map<string, Box>([
  ["under", { x: 0, y: 0, w: NODE_W, h: NODE_H }],
  ["over", { x: 10, y: 10, w: NODE_W, h: NODE_H }],
]);
eq("重叠处取上面那张", hitTestNode(stacked, 100, 30), "over");

/* ────────────────────── 5. 名字与说明 ────────────────────── */

console.log("\nworkflowDisplayName / nodeTitle");
check("read 是内置 id", isBuiltinWorkflowId("read"));
check("wf_demo 不是内置 id", !isBuiltinWorkflowId("wf_demo"));
eq("内置:zh 用中文词条", workflowDisplayName(entryOf(BUILTIN), "zh"), "文献精读");
eq("内置:en 用英文词条", workflowDisplayName(entryOf(BUILTIN), "en"), "Paper reading");
eq("自建:两种语言都用自己起的名字", workflowDisplayName(entryOf(CUSTOM), "en"), "我的流程");
eq(
  "内置:说明取词条(与选择器同源)",
  workflowDisplayDescription(entryOf(BUILTIN), "en"),
  "Read one paper properly: problem, method, experiments, limits",
);
eq("卡片标题:用户起的优先", nodeTitle({ title: "检索", type: "mcode.agent" }, AGENT_ENTRY), "检索");
eq("卡片标题:没起就用清单里的名字", nodeTitle({ title: "", type: "mcode.agent" }, AGENT_ENTRY), "子 agent");
eq("卡片标题:类型没装就退回类型 id", nodeTitle({ title: "", type: "x.y" }, undefined), "x.y");
eq("找得到清单", findNodeType(CATALOG.entries, "mcode.agent")?.manifest.name, "子 agent");
eq("找不到返回 undefined(不是错误)", findNodeType(CATALOG.entries, "x.y"), undefined);

/* ────────────────────── 6. 节点类型分组 ────────────────────── */

console.log("\ngroupNodeTypes");
const grouped = groupNodeTypes([
  { ...AGENT_ENTRY, id: "zz.local", source: "local" },
  AGENT_ENTRY,
  { ...COMMAND_ENTRY, id: "aa.plugin", source: "plugin" },
]);
eq("组顺序:builtin → plugin → local", grouped.map((g) => g.source).join(","), "builtin,plugin,local");
eq("空来源不出现", groupNodeTypes([AGENT_ENTRY]).length, 1);
eq("全空 → 零组", groupNodeTypes([]).length, 0);

/* ─────────────────── 7. SSR:真的画出来 ─────────────────── */

/** Render in a chosen locale.
 *
 *  `renderToStaticMarkup` reads zustand's **server snapshot**, which is the state object
 *  as it was at store creation — `setState` never reaches it. So the locale is written
 *  onto the initial-state object itself, which is exactly what the server-snapshot
 *  selector reads. (If a future zustand stops exposing that object, this fails loudly
 *  rather than silently rendering the wrong language.) */
function withLocale<T>(locale: "zh" | "en", render: () => T): T {
  (useSessionStore.getInitialState() as { locale: string }).locale = locale;
  return render();
}

function html(element: Parameters<typeof renderToStaticMarkup>[0]): string {
  return renderToStaticMarkup(element);
}

/** 配上两个模型再渲染。
 *
 *  `kind: "ref"` 的候选来自**这台机器上有什么**(`useRefOptions` 读的就是这几个
 *  store 字段),而不是清单 —— 所以这一条得先把 store 填上。和 `withLocale` 一样写
 *  的是初始状态对象(`renderToStaticMarkup` 读的是它),渲染完再放回去,免得影响
 *  后面那些"什么都没配"的用例。 */
function withModels<T>(render: () => T): T {
  const state = useSessionStore.getInitialState() as unknown as {
    providerId: string;
    providers: unknown[];
  };
  const prevProviderId = state.providerId;
  const prevProviders = state.providers;
  state.providerId = "claude-sdk";
  state.providers = [
    {
      id: "claude-sdk",
      displayName: "Claude",
      capabilities: { builtinModels: [{ id: "claude-sonnet-5", label: "Sonnet 5" }] },
    },
  ];
  try {
    return render();
  } finally {
    state.providerId = prevProviderId;
    state.providers = prevProviders;
  }
}

/** 同 `withModels`,给技能那份列表用 —— `kind: "ref", from: "skills"` 的候选读的是
 *  store 里的已装技能(与输入框 `/` 菜单、发消息时带上去的清单同源)。 */
function withSkills<T>(
  render: () => T,
  skills: Array<{ name: string; description: string }> = [
    { name: "pdf", description: "解析 PDF" },
    { name: "docx", description: "处理 Word" },
  ],
): T {
  const state = useSessionStore.getInitialState() as unknown as { skills: unknown[] };
  const prev = state.skills;
  state.skills = skills.map((s) => ({ ...s, source: "global" }));
  try {
    return render();
  } finally {
    state.skills = prev;
  }
}

/** 把某个节点的参数换掉。引用型参数那一节要"这一步已经存着某个值"的样子 —— 那正是
 *  展开与否、能不能摘掉一个本机没有的名字这两件事的分水岭。 */
function withNodeParams(
  doc: WorkflowDoc,
  id: string,
  params: Record<string, unknown>,
): WorkflowDoc {
  return {
    ...doc,
    nodes: doc.nodes.map((n) => (n.id === id ? { ...n, params: { ...n.params, ...params } } : n)),
  };
}

/** `readOnly=""` 出现几次 —— 只读字段的条数。 */
const readOnlyCount = (markup: string): number => (markup.match(/readOnly=""/g) ?? []).length;

/** 某个按钮在不在,以及是不是禁用的。**按"文字紧挨着 `</button>`"认** —— 于是
 *  「保存」不会误命中提示语里的那两个字。 */
function button(markup: string, label: string): { found: boolean; disabled: boolean } {
  const at = markup.indexOf(`>${label}</button>`);
  if (at < 0) return { found: false, disabled: false };
  const open = markup.lastIndexOf("<button", at);
  return { found: true, disabled: markup.slice(open, at).includes("disabled=") };
}

/** 同上,但文字后面还有别的东西(图标、后缀箭头)。`添加节点` 那类带下拉箭头的
 *  按钮用这个 —— 它的文字不是按钮的最后一个子节点。 */
function buttonContaining(markup: string, label: string): { found: boolean; disabled: boolean } {
  const at = markup.indexOf(label);
  if (at < 0) return { found: false, disabled: false };
  const open = markup.lastIndexOf("<button", at);
  if (open < 0) return { found: false, disabled: false };
  return { found: true, disabled: markup.slice(open, at).includes("disabled=") };
}

function renderInspector(
  doc: WorkflowDoc,
  locale: "zh" | "en",
  selectedNodeId: string | null = null,
  purpose: WorkflowPurpose = "workflow",
  profiles: AgentProfile[] = [],
): string {
  return withLocale(locale, () =>
    html(
      createElement(NodeInspector, {
        doc,
        catalog: CATALOG,
        profiles,
        profileError: null,
        selectedNodeId,
        purpose,
        onUpdateNode: () => {},
        onUpdateWorkflow: () => {},
        onRemoveNode: () => {},
        onSetDependency: () => {},
        onUpdateEdge: () => {},
        onSaveProfile: async () => {},
        onRemoveProfile: async () => {},
        onRemoveWorkflow: () => {},
      }),
    ),
  );
}

console.log("\nNodeInspector(工作流本体,内置)");
const builtinPanel = renderInspector(BUILTIN, "zh");
check("标题用词条里的名字", builtinPanel.includes("文献精读"));
check("列出 id", builtinPanel.includes(">read<"));
check("名称与说明都只读", readOnlyCount(builtinPanel) === 2, readOnlyCount(builtinPanel));
check("只读框显示界面上真正的名字", builtinPanel.includes(`value="文献精读"`));
check("只读框显示词条里的说明", builtinPanel.includes(`value="把一篇讲透`));
check("给出只读的解释", builtinPanel.includes("跟随界面语言"));
check("按钮叫「恢复默认」", button(builtinPanel, "恢复默认").found);
check("按钮不叫「删除」", !button(builtinPanel, "删除").found);
check("流程文字在", builtinPanel.includes("先定位,再通读。"));

console.log("\nNodeInspector(工作流本体,自建 / en)");
const customPanel = renderInspector(CUSTOM, "zh");
check("自建:名称框可编辑", readOnlyCount(customPanel) === 0);
check("自建:填的是数据里的名字", customPanel.includes(`value="我的流程"`));
check("自建:按钮叫「删除」", button(customPanel, "删除").found);
check("自建:不说「恢复默认」", !button(customPanel, "恢复默认").found);
const customEn = renderInspector(CUSTOM, "en");
check("英文界面:自建的名字不翻译", customEn.includes(`value="我的流程"`));
check("英文界面:按钮跟着变", button(customEn, "Delete").found);
const builtinEn = renderInspector(BUILTIN, "en");
check("英文界面:内置的名字走词条", builtinEn.includes("Paper reading"));
check("英文界面:不冒出中文名字", !builtinEn.includes("文献精读"));
check("英文界面:不留中文提示", !builtinEn.includes("跟随界面语言"));

console.log("\nNodeInspector(选中节点:参数表单按清单生成)");
const nodePanel = renderInspector(DIAMOND, "zh", "B");
check("说的是节点而不是工作流", nodePanel.includes("等待") || nodePanel.includes("Waits") || nodePanel.includes("标题"));
check("显示类型 id", nodePanel.includes("mcode.agent"));
check("显示类型中文名", nodePanel.includes("子 agent"));
check("按清单生成了 instruction 的标签与说明", nodePanel.includes("指令") && nodePanel.includes("这一步要做什么。"));
check("必填项打了星号", nodePanel.includes('text-warning">*'));
check("按清单生成了 model 的标签", nodePanel.includes("模型"));
check("节点标题可改", nodePanel.includes(`value="B"`));
check("有依赖勾选(另外三个节点)", ["A", "C", "D"].every((id) => nodePanel.includes(`>${id}</span>`)));
check("下游那句在(D 依赖 B)", nodePanel.includes("下游"));
check("有删除节点", button(nodePanel, "删除节点").found);

console.log("\nNodeInspector(终末节点:产出变量那张表用不上)");
// 「最后一步」的判据和调度器共用 `nodesWithDownstream` —— 界面上提示的和提示词里那句
// "你是最后一步"必须是同一件事。DIAMOND 里 B 有下游(D),D 没有。
const midPanel = renderInspector(DIAMOND, "zh", "B");
check("有下游:不说什么用不上", !midPanel.includes("不会被用到"));
const lastPanel = renderInspector(DIAMOND, "zh", "D");
check("没有下游:说清这张表用不上", lastPanel.includes("不会被用到"));

console.log("\nNodeInspector(选中节点:引用型参数 —— 单选下拉 / 多选可收起的列表)");
// 单选(model)的候选在 `Select.Portal` 里,而 portal 只在弹出时才渲染 —— 静态标记里
// 看不到候选,所以只能断言到"它是个下拉、空值有自己的说法"。
const modelPanel = withModels(() => renderInspector(DIAMOND, "zh", "B"));
check("配了模型:渲染成下拉而不是手填", modelPanel.includes("不指定"));
// 一个模型都没配时没有候选可列 —— 那时退回手填,而不是给一个空下拉,并且说清原因。
check(
  "没配模型:退回手填并说明",
  !nodePanel.includes("不指定") && nodePanel.includes("这台机器上还没有可选的项"),
);

// —— 多选那一路(技能 / MCP 服务器 / 插件):**收起成一行,按需展开** ——
//
// 三格里九成的答案是留空,铺开三个列表会把大半个检查器占掉。但收起不等于藏起来:
// 那一行仍然写着"有多少可挑"。这两条一起钉住,免得以后改成"干脆不显示"。
const skillPanel = withSkills(() => renderInspector(DIAMOND, "zh", "B"));
check("没选技能时收起成一行", skillPanel.includes("不限制") && skillPanel.includes("可选 2 个"));
check("收起时不再铺开候选", !skillPanel.includes(">pdf<") && !skillPanel.includes(">docx<"));
// 反过来:**已经选过东西的节点直接摊开** —— 选过的人多半是来改的,不该再点一次。
const picked = withSkills(() =>
  renderInspector(withNodeParams(DIAMOND, "B", { skills: ["pdf"] }), "zh", "B"),
);
check("选过技能时直接摊开候选", picked.includes(">pdf<") && picked.includes(">docx<"));
check("技能带上说明", picked.includes('title="处理 Word"'));
check("收起的那一行写着选了几个", picked.includes("已选 1 个"));

// 节点上已经存着的名字,在没装这台机器上也要看得见 —— 否则一份分享来的工作流会
// 显示成"这一步什么都没选",而它其实选了。
const foreignSkills = withSkills(() =>
  renderInspector(withNodeParams(DIAMOND, "B", { skills: ["ghost"] }), "zh", "B"),
);
check("本机没装的技能仍然列出来", foreignSkills.includes(">ghost<"));
check("而且说明了本机没有它", foreignSkills.includes("这台机器上没有这一项"));

// **候选为空时给的是一个能打字的输入框。** 插件一个都没装、或者那几个 list RPC 还没
// 就绪时就是这种状态。以前这里只画已选的标签,而提示语却写着「直接填名字也行」——
// 那句话当时是句空话(多选那一路压根没有输入框)。
const noCandidates = renderInspector(withNodeParams(DIAMOND, "B", { skills: ["ghost"] }), "zh", "B");
check("候选为空时给出输入框", noCandidates.includes('placeholder="输入名字，回车添加"'));
check("并且照旧把那句「直接填名字也行」说出来", noCandidates.includes("直接填名字也行"));

// 筛选框只在**列表真的装不下**的时候出现(见 `FILTER_FROM`):六个以内一眼看得全,
// 上面再压一个框纯是噪声。第 7 个开始才给。
const sevenSkills = Array.from({ length: 7 }, (_, i) => ({
  name: `s${i + 1}`,
  description: `第 ${i + 1} 个技能`,
}));
const manySkills = withSkills(
  () => renderInspector(withNodeParams(DIAMOND, "B", { skills: ["s1"] }), "zh", "B"),
  sevenSkills,
);
check("候选多到装不下时给一个筛选框", manySkills.includes('placeholder="筛选…"'));
check("候选少的时候不给筛选框", !picked.includes('placeholder="筛选…"'));

console.log("\nNodeInspector(选中节点:列表分隔符)");
// A 的下游是 B 和 C —— 两个名字,才看得见分隔符。拼死的顿号在英文界面里很显眼。
const depsEn = renderInspector(DIAMOND, "en", "A");
check("下游那句用英文的分隔符", depsEn.includes("Downstream: B, C"), depsEn.slice(depsEn.indexOf("Downstream"), depsEn.indexOf("Downstream") + 40));
check("英文界面里不冒中文顿号", !depsEn.includes("、"));

console.log("\nNodeInspector(选中节点:第三方类型)");
const thirdPanel = renderInspector(
  { ...CUSTOM, nodes: [node("p1", 0, 0, COMMAND_MANIFEST.id)], edges: [] },
  "zh",
  "p1",
);
check("select 参数渲染成下拉(有「请选择」占位)", thirdPanel.includes("请选择"));

console.log("\nNodeInspector(选中节点:产出 = 一段大白话 + 一张变量表)");
// 「期望产出」是两层:一段**说明**(不强制)+ 一张**变量表**(会被检查)。表里一行是
// 「名字 + 示例」,表底下还有「插入变量」。
check("说明那段在(期望产出)", nodePanel.includes("期望产出"));
check("变量表在(产出变量)", nodePanel.includes("产出变量"));
// **界面上不出现 JSON 这个词** —— 底下是 JSON 是软件的事,用户要回答的只有"交哪几样
// 东西"。`@contracts/outputConstraint` 的文件头写着为什么。
check("表单里看不到 JSON", !nodePanel.includes("JSON"), nodePanel.slice(0, 400));

// 空表要说清楚怎么开始,而不是给一个光秃秃的表头。
check("空表说的是怎么加", nodePanel.includes("加一样"), nodePanel.slice(nodePanel.indexOf("产出变量"), nodePanel.indexOf("产出变量") + 300));

// 表里有东西时,**名字和示例都要端上来** —— 那是用户自己填的,编辑时看不见就没法改。
const varsPanel = renderInspector(
  {
    ...DIAMOND,
    nodes: DIAMOND.nodes.map((n) =>
      n.id === "B"
        ? { ...n, params: { instruction: "x", outputVars: [{ name: "年份", example: "2024" }] } }
        : n,
    ),
  },
  "zh",
  "B",
);
check("填过的变量名端上来了", varsPanel.includes('value="年份"'), varsPanel.slice(varsPanel.indexOf("产出变量"), varsPanel.indexOf("产出变量") + 300));
// 示例渲染成 **`<textarea>` 的文本内容**(不是 `value` 属性)—— 它必须是多行框:
// 示例常常是一整段(那正是模型照着交的样板),单行输入框连一句话都显示不全。
// 用户的原话:「就是一个 txt 编辑框,可以输入很多东西才行」。
check("示例也端上来了", varsPanel.includes(">2024</textarea>"), varsPanel.slice(varsPanel.indexOf("产出变量"), varsPanel.indexOf("产出变量") + 600));
check("示例是多行框,不是单行输入", varsPanel.includes("<textarea"), varsPanel);
check("一行一个删按钮", varsPanel.includes('aria-label="删掉这一行"'));

// 填得不对要**当场**说 —— 否则用户只会在存盘被拒、或者某一步跑完之后才发现。
const badPanel = renderInspector(
  {
    ...DIAMOND,
    nodes: DIAMOND.nodes.map((n) =>
      n.id === "B" ? { ...n, params: { instruction: "x", outputVars: [{ name: "年份", example: "" }] } } : n,
    ),
  },
  "zh",
  "B",
);
check("没填示例当场就说", badPanel.includes("没填示例"), badPanel.slice(badPanel.indexOf("产出变量"), badPanel.indexOf("产出变量") + 400));
const reservedPanel = renderInspector(
  {
    ...DIAMOND,
    nodes: DIAMOND.nodes.map((n) =>
      n.id === "B" ? { ...n, params: { instruction: "x", outputVars: [{ name: "output", example: "x" }] } } : n,
    ),
  },
  "zh",
  "B",
);
check("起了内置的名字当场就说", reservedPanel.includes("内置的名字"));
// 而没填错时**不该**冒出这些话。
check("没填错就不说", !nodePanel.includes("没填示例") && !nodePanel.includes("内置的名字"));

console.log("\n插入变量(挑,不是打)");
// 「插入变量」那个按钮在指令栏下面 —— 它是个弹出层,**候选不在静态标记里**(portal),
// 所以候选本身在下面用纯函数直接测。
check("指令那一栏有「插入变量」", nodePanel.includes("插入变量"), nodePanel.slice(0, 400));
// 没有上游时照样渲染那个按钮:点开是一句"上面还没有别的步骤"—— 那句话本身就在教这个
// 功能怎么才有东西可选,藏起来的话用户永远不知道有这么回事。
check("没有上游时按钮也在", nodePanel.includes("插入变量"));

console.log("\ninsertableGroups(只有上游定过的才列得出来)");
// 候选在弹出层里(portal),静态标记看不到 —— 所以候选本身在这里直接测纯函数。
const withVars = (doc: WorkflowDoc, id: string, vars: Array<{ name: string; example: string }>): WorkflowDoc => ({
  ...doc,
  nodes: doc.nodes.map((n) => (n.id === id ? { ...n, params: { ...n.params, outputVars: vars } } : n)),
});

{
  const doc = withVars(DIAMOND, "A", [
    { name: "年份", example: "2024" },
    { name: "标题", example: "量子" },
  ]);
  const groups = insertableGroups(doc, "B", CATALOG);
  eq("一个上游一组", groups.length, 1);
  eq("组名用的是那一步的标题", groups[0]?.title, "A");
  eq(
    "两个变量都列出来了",
    groups[0]?.items.filter((i) => i.kind === "var").map((i) => i.name).join(","),
    "年份,标题",
  );
  eq("点一下插进去的是短写法", groups[0]?.items[0]?.insert, "{{A.年份}}");
  // 「整段结果」是内置那一条,排在变量后面 —— 它不是一个具体的变量。
  eq("最后一条是整段结果", groups[0]?.items[groups[0].items.length - 1]?.kind, "whole");
  eq("它插的也是整段结果", groups[0]?.items[groups[0].items.length - 1]?.insert, "{{A.output}}");
}

{
  // **间接上游也算**(传递闭包):D 的上游是 A/B/C,C 是它的直接依赖,A 只隔着 B/C。
  // 解算器认的是闭包,菜单就必须给同一份 —— 两处不一致的话,菜单里选得到的东西跑起来
  // 会说"不是这一步的上游"。
  const doc = withVars(DIAMOND, "A", [{ name: "年份", example: "2024" }]);
  const groups = insertableGroups(doc, "D", CATALOG);
  eq("闭包里的三个上游都成组了", groups.map((g) => g.title).join(","), "A,B,C");
  eq("隔了一层的那个也在", groups[0]?.items[0]?.insert, "{{A.年份}}");
}

{
  // 上游**没填过变量** → 那一组只剩「整段结果」。不是不给这一组:那一步的整段结果本来
  // 就是能引用的,只是里面没有可点名要的东西。
  const groups = insertableGroups(DIAMOND, "B", CATALOG);
  eq("一组还在", groups.length, 1);
  eq("但只有整段结果", groups[0]?.items.length, 1);
  eq("就是它", groups[0]?.items[0]?.kind, "whole");
}

{
  // 根节点没有上游 → 一个候选都没有(界面上据此说"上面还没有别的步骤")。
  eq("根节点没有候选", insertableGroups(DIAMOND, "A", CATALOG).length, 0);
}

{
  // **标题重名时插 id** —— 解算器对重名标题是直接报错的,所以插进去的必须是那个一定
  // 解得出来的写法。
  const vars = [{ name: "年份", example: "2024" }];
  const titled = (doc: WorkflowDoc): WorkflowDoc => ({
    ...doc,
    nodes: doc.nodes.map((n) => (n.id === "A" ? { ...n, title: "检索" } : n)),
  });

  // 先看不重名的:用**标题**(好认)。
  const ok = insertableGroups(titled(withVars(DIAMOND, "A", vars)), "B", CATALOG);
  eq("没重名就用标题", ok[0]?.items[0]?.insert, "{{检索.年份}}");

  // 再看 C 也叫「检索」—— 那这个名字就解不出来了(重名),所以退回 id。
  const dup: WorkflowDoc = {
    ...titled(withVars(DIAMOND, "A", vars)),
    nodes: titled(withVars(DIAMOND, "A", vars)).nodes.map((n) =>
      n.id === "C" ? { ...n, title: "检索" } : n,
    ),
  };
  const groups = insertableGroups(dup, "B", CATALOG);
  eq("重名了就退回 id", groups[0]?.items[0]?.insert, "{{A.年份}}");
}

console.log("\ninsertSnippet(光标这件事全是边界情况)");

{
  const r = insertSnippet("把填进去", 1, 1, "{{A.年份}}");
  eq("插在光标处", r.value, "把{{A.年份}}填进去");
  // 光标落在插进来的那段**后面** —— 连着插两个的时候不用再点一次。
  eq("光标停在插进来的那段之后", r.caret, 1 + "{{A.年份}}".length);
}

{
  // 拖选了一段再点插入 = 把那一段换掉。
  const r = insertSnippet("abcdef", 1, 4, "X");
  eq("选中的那一段被替换掉", r.value, "aXef");
  eq("光标停在新内容的后面", r.caret, 2);
}

{
  eq("空文本上插", insertSnippet("", 0, 0, "{{A.年份}}").value, "{{A.年份}}");
  // 没聚焦过的 textarea 给的是 -1,值刚被别处改过时旧位置可能超出长度 —— 都不该崩,
  // 也不该插到奇怪的地方。
  eq("光标是 -1 → 当成开头", insertSnippet("abc", -1, -1, "X").value, "Xabc");
  eq("光标超出长度 → 当成末尾", insertSnippet("abc", 99, 99, "X").value, "abcX");
  eq("NaN 也不崩", insertSnippet("abc", Number.NaN, Number.NaN, "X").value, "Xabc");
  // 选区反了(理论上不该有,但用户拖选的方向是真的会反)也不该把文本吃掉。
  eq("选区反了 → 当成一个点", insertSnippet("abc", 3, 1, "X").value, "abcX");
}
check("boolean 参数渲染成开关", thirdPanel.includes(`aria-label="详细"`));
check("跑不了的执行方式直接说出来", thirdPanel.includes("还没实现"));
// 来源说的是**哪一个插件**,不是"插件"这个类别 —— 排查"这个类型哪来的"时,名字才是答案。
check("来源说清是哪个插件带来的", thirdPanel.includes("demo-plugin"));

console.log("\nNodeInspector(选中节点:类型没装)");
const missingPanel = renderInspector(
  { ...CUSTOM, nodes: [node("m1", 0, 0, "ghost.type")], edges: [] },
  "zh",
  "m1",
);
check("明说类型未安装", missingPanel.includes("类型未安装"));
check("说清后果(能存能看,但跑不了)", missingPanel.includes("画不出也跑不了"));
check("参数区没有硬凑出来的字段", !missingPanel.includes("指令"));

console.log("\nSaveStateLine(保存状态)");
// 它**从检查器里搬出来了**(保存改成手点之后,状态行要和「保存」那颗按钮并排,见
// `SaveStateLine.tsx` 的文件头),所以这里直接画它 —— 比从前隔着检查器画更准,
// 四种状态也能一次盖全。
const stateLine = (state: SaveState, locale: "zh" | "en" = "zh"): string =>
  withLocale(locale, () => html(createElement(SaveStateLine, { state })));
check("没有改动时什么都不说", stateLine({ kind: "clean" }) === "");
check("有改动就说有未保存的", stateLine({ kind: "pending" }).includes("有未保存的改动"));
check("保存中", stateLine({ kind: "saving" }).includes("保存中"));
const blockedState = stateLine({ kind: "error", message: "名称不能为空" });
check("出错时文字是「保存受阻」", blockedState.includes("保存受阻"));
// ★ 原因必须是**看得见的字**,不能只挂在 `title` 上。
//
// 这条断言原来查的是整段 HTML,而 `title="名称不能为空"` 也在里面 —— 于是它一直是绿的,
// 而用户看到的只有「保存受阻」四个字,想知道为什么得把鼠标停上去等一个 tooltip。现象
// 就是"点保存没反应"。把标签连属性一起剥掉,只留渲染出来的文字,才对得上他看到的。
const visibleText = (s: string): string => s.replace(/<[^>]*>/g, " ");
check(
  "★ 出错时把原因写在明面上(不只是 tooltip)",
  visibleText(blockedState).includes("名称不能为空"),
  visibleText(blockedState),
);
check("英文界面跟着换", stateLine({ kind: "pending" }, "en").includes("Unsaved changes"));

console.log("\nNodeInspector(自动化:触发方式)");
const autoPanelHtml = renderInspector(autoDoc, "zh", null, "automation");
check("自动化:有触发方式一栏", autoPanelHtml.includes("触发方式"));
check("自动化:当前触发方式显示出来了", autoPanelHtml.includes("手动"));
check("自动化:解释当前这一种", autoPanelHtml.includes("只有你按「立刻运行一次」的时候才跑"));
// 「执行器还没接」那块警告删掉了(执行器接上了,见 `automationRunner.ts`)。取而代之:
// 这一格**只读**(值由触发器节点反推,见 `library.ts` 的 `deriveTrigger`),下面跟着
// 一句反推的说明,再往下就是运行区(「立刻运行一次」+ 运行历史)。
check("自动化:说清这一格是反推的", autoPanelHtml.includes("这一格跟着触发器节点走"));
check("自动化:不再说执行器还没接", !autoPanelHtml.includes("执行器还没接"));
check("自动化:运行区在(立刻运行一次)", autoPanelHtml.includes("立刻运行一次"));
check("自动化:运行历史在(空的)", autoPanelHtml.includes("还没跑过。"));
const scheduleHtml = renderInspector({ ...autoDoc, trigger: "schedule" }, "zh", null, "automation");
check("换了触发方式就换那句解释", scheduleHtml.includes("到点自己跑"));
check("换了触发方式就不再提手动", !scheduleHtml.includes("只有你按「运行」的时候才跑"));
// 工作流那边**一个字都不该出现** —— 触发器是"这是自动化"的判据,一张普通工作流
// 的检查器里冒出触发方式,等于在说它也能自己跑起来。
const plainInspector = renderInspector(plainDoc, "zh");
check("工作流:不显示触发方式", !plainInspector.includes("触发方式"));
check("工作流:不显示执行器警告", !plainInspector.includes("执行器还没接"));

console.log("\nWorkflowListRow / WorkflowNodeCard");
function renderRow(entry: WorkflowListEntry, active: boolean, locale: "zh" | "en"): string {
  return withLocale(locale, () =>
    html(createElement(WorkflowListRow, { entry, active, onSelect: () => {} })),
  );
}
const ACCENT_BAR = 'bg-accent"';
const plainRow = renderRow(entryOf(BUILTIN), false, "zh");
check("行:显示词条里的名字", plainRow.includes("文献精读"));
check("行:显示词条里的说明", plainRow.includes("把一篇讲透"));
check("行:没选中就没有竖条", !plainRow.includes(ACCENT_BAR));
check("行:没改过就没有「已修改」", !plainRow.includes("已修改"));
const editedRow = renderRow(entryOf(BUILTIN, true), true, "zh");
check("行:选中了有竖条", editedRow.includes(ACCENT_BAR));
check("行:改过了有「已修改」", editedRow.includes("已修改"));
check("行:英文界面下名字是英文", renderRow(entryOf(BUILTIN), false, "en").includes("Paper reading"));

function renderCard(
  target: WorkflowNode,
  entry: NodeTypeEntry | undefined,
  locale: "zh" | "en",
  connectHint: "source" | "ok" | "blocked" | null = null,
): string {
  return withLocale(locale, () =>
    html(
      createElement(WorkflowNodeCard, {
        node: target,
        entry,
        selected: false,
        left: 0,
        top: 0,
        connecting: connectHint !== null,
        connectHint,
        onMouseDown: () => {},
        onStartConnect: () => {},
      }),
    ),
  );
}
const plainCard = renderCard(node("n1", 0, 0), AGENT_ENTRY, "zh");
check("卡片:标题", plainCard.includes(">n1<"));
check("卡片:类型 id(等宽,不翻译)", plainCard.includes("mcode.agent"));
check("卡片:能力标出来", plainCard.includes(">read<"));
check("卡片:参数齐了就没有警告", !plainCard.includes("必填参数"));
const badCard = renderCard({ ...node("n2", 0, 0), params: {} }, AGENT_ENTRY, "zh");
check("卡片:参数没填齐会标出来", badCard.includes("参数没填完"));
const ghostCard = renderCard(node("n3", 0, 0, "ghost.type"), undefined, "zh");
check("卡片:类型没装会标出来", ghostCard.includes("类型未安装"));
const deadCard = renderCard(
  { ...node("n4", 0, 0, COMMAND_MANIFEST.id), params: { target: "a" } },
  COMMAND_ENTRY,
  "zh",
);
check("卡片:执行方式没实现会标出来", deadCard.includes("这个执行方式跑不了"));

// 四种执行方式在画布上**长得不一样**(见 `WorkflowNodeCard` 的 `KIND_LOOK`)—— 左边那道
// 竖条的颜色就是"一眼认得出这是哪一种"的那处。这条断言是那个需求的守门人:哪天有人把
// 分色删了、或者新加一种执行方式忘了给它一档,四张卡片会重新变回一模一样,而"长得一样"
// 不会有任何报错,只能靠人盯着画布看。
{
  const conversationCard = renderCard(node("n7", 0, 0, CONVERSATION_MANIFEST.id), CONVERSATION_ENTRY, "zh");
  const branchCard = renderCard(node("n8", 0, 0, BRANCH_MANIFEST.id), BRANCH_ENTRY, "zh");
  // 主代理和子 agent 是**同一种执行方式**,靠是否入口分档(见 `isProtectedNode`)——
  // 所以这里单独看一张。
  const mainCard = renderCard(node("n9", 0, 0, MAIN_NODE_TYPE_ID), AGENT_ENTRY, "zh");
  const barOf = (html: string): string =>
    ["bg-edge", "bg-accent", "bg-info", "bg-warning", "bg-danger"].find((c) =>
      new RegExp(`class="[^"]*\\b${c}\\b`).test(html),
    ) ?? "(没有竖条)";
  eq("卡片:子 agent 是中性那一档", barOf(plainCard), "bg-edge");
  eq("卡片:主代理是品牌色那一档", barOf(mainCard), "bg-accent");
  eq("卡片:对话节点是 info 那一档", barOf(conversationCard), "bg-info");
  eq("卡片:分支是 warning 那一档", barOf(branchCard), "bg-warning");
  eq("卡片:跑不了的节点是 danger 那一档", barOf(deadCard), "bg-danger");
  check(
    "四张摆在一起两两不同",
    new Set([barOf(plainCard), barOf(conversationCard), barOf(branchCard), barOf(deadCard)]).size === 4,
  );
  // 入线口是个"永远接不上线"的空头承诺 —— 入口节点(主代理)没有入边,所以它身上
  // 只画下面的出线口(见 `WorkflowNodeCard` 的入线口注释)。入线口的特征是
  // `pointer-events-none`(它不接点击),出线口才有 `cursor-crosshair`。
  check("卡片:主代理没有入线口", !mainCard.includes("pointer-events-none"));
  check("卡片:主代理只剩出线口", (mainCard.match(/rounded-full border/g) ?? []).length === 1);
  check("卡片:主代理出线口还在", mainCard.includes("cursor-crosshair"));
}
// 出线口是拉连线的起点。它是 `div` 不是 `button`,所以 `title` 是唯一的说明 ——
// 少了它,卡片右边那个小圆点看上去只是个装饰。
check("卡片:出线口带说明", plainCard.includes("按住往另一个节点拖，连一条依赖"));
check("卡片:两个端口都画了", (plainCard.match(/rounded-full border/g) ?? []).length >= 2);
// 拖到一张会成环的卡片上时,那张卡片当场变红(见 `WorkflowCanvas.targetAt`)。
const blockedCard = renderCard(node("n5", 0, 0), AGENT_ENTRY, "zh", "blocked");
check("卡片:成环的目标标红", blockedCard.includes("border-danger"));
check("卡片:能连的目标标绿", renderCard(node("n6", 0, 0), AGENT_ENTRY, "zh", "ok").includes("border-accent"));
// 拉线时整块画布都是投放区,卡片得从"抓手"变成"十字"——只改 body 盖不住卡片自己
// 写的 cursor-grab(子元素的 cursor 优先),所以这个类要真的从卡片上换掉。
check(
  "卡片:不拉线时是抓手",
  plainCard.includes("cursor-grab"),
);
check(
  "卡片:拉线时不再是抓手",
  !renderCard(node("n7", 0, 0), AGENT_ENTRY, "zh", "ok").includes("cursor-grab"),
);
// 出线口两种状态下都保持十字光标 —— 它本来就是"按住可以拉一条线"的意思,和画布
// 当下在不在拉线无关。
check("卡片:出线口一直是十字光标", plainCard.includes("cursor-crosshair"));

console.log("\nWorkflowCanvas");
function renderCanvas(doc: WorkflowDoc, locale: "zh" | "en"): string {
  return withLocale(locale, () =>
    html(
      createElement(WorkflowCanvas, {
        doc,
        catalog: CATALOG,
        profiles: [],
        selectedNodeId: null,
        onSelectNode: () => {},
        onMoveNode: () => {},
        onAddNode: () => {},
        onRelayout: () => {},
        onConnect: () => {},
        onRemoveEdge: () => {},
      }),
    ),
  );
}
const emptyCanvas = renderCanvas(CUSTOM, "zh");
check("空图给出上手话术", emptyCanvas.includes("这张图还是空的"));
check("空图也留着「添加节点」按钮", buttonContaining(emptyCanvas, "添加节点").found);
check("空图时「整理布局」是禁用的", button(emptyCanvas, "整理布局").disabled === true);

const diamondCanvas = renderCanvas(DIAMOND, "zh");
check("画布:每张卡片都在", ["A", "B", "C", "D"].every((id) => diamondCanvas.includes(`>${id}<`)));
check("画布:四条边画出来了", (diamondCanvas.match(/<path[^>]*marker-end/g) ?? []).length >= 4);
check("画布:边带箭头", diamondCanvas.includes("workflow-edge-arrow"));
check("画布:规模写在工具条上", diamondCanvas.includes("4 个节点 · 4 条依赖"));
check("画布:节点按坐标绝对定位", /style="left:\d+px;top:\d+px;width:\d+px;height:\d+px"/.test(diamondCanvas));
check("画布:有卡片时「整理布局」可用", button(diamondCanvas, "整理布局").disabled === false);
// 1.5px 的线不好点,所以每条边多画了一条 12px 宽的透明带当命中区;点它不仅删边,
// 悬停时还会变红并长出那个 × 钮(见 `WorkflowCanvas`)。
check("画布:边有可点的命中区", diamondCanvas.includes('stroke="transparent"'));
check("画布:点线的意思写在提示里", diamondCanvas.includes("点击删除这条依赖"));
check("画布:悬停时用另一个颜色的箭头", diamondCanvas.includes("workflow-edge-arrow-hover"));

// 回头边在真画布上真的换了道。DIAMOND 没有回头的边,所以单独造一张:分支 B 有一条
// 往回流到 A 的边(环上有岔路口才合法,不过画布只管画,合法性是存盘校验的事)。
// 坐标整体挪到很右边,是为了让画布宽度**不被最小宽度兜住** —— 否则"宽度把车道留出来
// 了"那条断言在两种情况下都会成立,等于什么都没测。
const loopDoc: WorkflowDoc = {
  ...DIAMOND,
  nodes: DIAMOND.nodes.map((n) => ({ ...n, position: { x: n.position.x + 900, y: n.position.y } })),
  edges: [...DIAMOND.edges, { id: edgeId("B", "A"), from: "B", to: "A" }],
};
const loopCanvas = renderCanvas(loopDoc, "zh");
const loopLane = backEdgeLanes(loopDoc.nodes, loopDoc.edges).get(edgeId("B", "A")) as number;
check("画布:回头边绕到旁边的空当上", loopLane !== undefined && loopCanvas.includes(`${loopLane} `), loopLane);
check(
  "画布:回头边是折线(有圆角),不是那条直的贝塞尔",
  (loopCanvas.match(/Q /g) ?? []).length >= 4,
);
// 车道的宽度得先算进画布,不然最外面那条会画到画布外 —— 画布就是内层那个固定尺寸的
// div,超出去的部分既不显示也滚不到。
const loopWidth = canvasSize(loopDoc.nodes, [loopLane]).width;
check("画布:宽度确实比没有车道时宽", loopWidth > canvasSize(loopDoc.nodes).width);
check(
  "画布:按留出车道之后的宽度渲染",
  loopCanvas.includes(`width:${loopWidth}px`),
  { loopWidth, bare: canvasSize(loopDoc.nodes).width },
);

console.log("\nCSS 变量名(写错了不报错,只会画不出来)");
// 这条机械校验是拿一次真事故换来的:画布上的边写着 `rgb(var(--edge-panel))`,而主题
// 里定义的叫 `--panel-edge`(`edge-panel` 是 Tailwind 的颜色名,不是 CSS 变量)。
// 未定义的 `var()` 是个**沉默**的错误:编译过、运行不警告,只是那个属性变成非法值、
// 回落到初始值 —— `stroke` 的初始值恰好是 `none`,于是那条线谁也看不见。
//
// 路径按 **cwd** 解析,不用 `import.meta.url`:run.sh 先 `cd apps/desktop`,而产物被打
// 进一个临时目录(还是 CJS),相对模块的路径会指到别处。
const WORKFLOW_SRC_DIR = "src/renderer/components/settings/workflows";
const themeVars = new Set(
  [...readFileSync("src/renderer/styles.css", "utf8").matchAll(/^\s*(--[\w-]+)\s*:/gm)].map(
    (m) => m[1],
  ),
);
check("主题变量读出来了(读不到的话下面这条是假通过)", themeVars.size > 50, themeVars.size);
const unknownVars: string[] = [];
let varRefs = 0;
for (const file of readdirSync(WORKFLOW_SRC_DIR)) {
  if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;
  const source = readFileSync(`${WORKFLOW_SRC_DIR}/${file}`, "utf8");
  for (const m of source.matchAll(/var\((--[\w-]+)/g)) {
    varRefs += 1;
    if (!themeVars.has(m[1])) unknownVars.push(`${file} → ${m[1]}`);
  }
}
// 先证明这条校验真的看到了东西 —— 正则写错、目录读空都会让上面那条**静默通过**,
// 而"没查"和"查了没问题"在这里必须能区分开。
check("确实扫到了 var() 引用(否则上一条是空过)", varRefs > 0, varRefs);
check("用到的 CSS 变量都在 styles.css 里定义了", unknownVars.length === 0, unknownVars.join("; "));

console.log("\nWorkflowsPanel(页签容器)");
// 回归锚:藏一个页签用的是 `hidden` **类**,不是 `hidden` **属性**。这个 div 同时带
// `flex`,而 preflight 的 `[hidden]{display:none}` 与 `.flex` 同特异性、又排在
// utilities 之前 —— 属性会输,两块面板会一起显示(flex-1 各分一半)。
const panelHtml = withLocale("zh", () => html(createElement(WorkflowsPanel, { purpose: "workflow" })));
const panelClass = (id: string): string =>
  new RegExp(`id="${id}"[^>]*class="([^"]*)"`).exec(panelHtml)?.[1] ?? "";
check(
  "工作流库那一块默认是 flex",
  panelClass("workflows-panel-library").split(" ").includes("flex"),
  panelClass("workflows-panel-library"),
);
check(
  "节点类型那一块默认带 hidden 类",
  panelClass("workflows-panel-nodeTypes").split(" ").includes("hidden"),
  panelClass("workflows-panel-nodeTypes"),
);
check("没有用 hidden 属性(它压不过 .flex)", !panelHtml.includes('hidden=""'));

console.log("\nWorkflowsPanel(自动化:同一块面板的另一种用法)");
const autoPanel = withLocale("zh", () => html(createElement(WorkflowsPanel, { purpose: "automation" })));
check("自动化面板:标题换了", autoPanel.includes("自动化"));
check("自动化面板:页签只剩「库」", !autoPanel.includes('id="automation-tab-nodeTypes"'));
check("自动化面板:节点类型那块整块不渲染", !autoPanel.includes('id="automation-panel-nodeTypes"'));
// id 带前缀 —— 两个用途的面板各自挂在自己的设置页上,id 撞了就是同一份 DOM id 出现
// 两次(按 id 找元素的地方会被第一个截胡)。
check("自动化面板:库那块挂在 automation- 前缀下", autoPanel.includes('id="automation-panel-library"'));
check("工作流面板还是 workflows- 前缀", panelHtml.includes('id="workflows-panel-library"'));
check("两个面板的页签 id 不重名", !autoPanel.includes('id="workflows-tab-library"'));

/* ────────────────────── 代理档案 ────────────────────── */

console.log("\n代理档案");

// 引擎是第三种 ref 来源 —— 加它是往**同一个集合**里加一个值,不是加一个 kind。
check(
  "providers 是一种引用来源",
  (NODE_PARAM_REF_SOURCES as readonly string[]).includes("providers"),
);
// MCP 服务器与插件是往**同一个集合**里加的两个值(见 `NODE_PARAM_REF_SOURCES` 的注释:
// 「加一种新的"可选的东西"是往这里加一个值」)。渲染端那一个 switch 少写一个 case,
// 表现是"这个参数一个候选都没有",而界面上只会说"还没得选" —— 所以要在这里钉住。
check("mcp 是一种引用来源", (NODE_PARAM_REF_SOURCES as readonly string[]).includes("mcp"));
check("plugins 是一种引用来源", (NODE_PARAM_REF_SOURCES as readonly string[]).includes("plugins"));

// 执行方式那张**白名单**(`isRunnerImplemented`)。加一种新的 `runner.kind` 忘了登记,
// 后果是"画布上画得出来、存得进去,一跑就被判成这种执行方式还没实现" —— 而报错听起来
// 像是功能没做,不像是漏了一行。所以各钉一下。
check("prompt 是实现了的执行方式", isRunnerImplemented("prompt"));
check("conversation 也是(它跑得起来,只是跑在主对话里)", isRunnerImplemented("conversation"));
check("branch 也是", isRunnerImplemented("branch"));
check("command 也是(命令来自节点参数的那种)", isRunnerImplemented("command"));
// 白名单的另一半:**不在名单上的要给 false**。`decide` 这个 kind 已经整个删了
// (决策节点收编成分支的 `decider:"model"`),拿它钉"没登记的一律不实现"正合适。
check("没登记过的执行方式一律 false", !(isRunnerImplemented as (k: string) => boolean)("decide"));

// `isNodeRunnable` 是更细的那层:参数型 command 跑得起来,清单自带脚本(entry)的
// command 只定了形状、还没实现 —— 两种说法必须收口成一个函数(调度器的拒绝与渲染端
// 的"跑不了"徽标读同一份答案)。
check(
  "参数型 command 跑得起来",
  isNodeRunnable({ runner: { kind: "command" } } as NodeTypeManifest),
);
check(
  "entry 型 command 还跑不起来",
  !isNodeRunnable({ runner: { kind: "command", entry: "run.sh" } } as NodeTypeManifest),
);
check("真清单里的引擎参数是 ref: providers", AGENT_MANIFEST.params.some((p) => p.from === "providers"));
// 清单校验:ref 必须有 from,非 ref 不许有 from —— 新来源不能绕过这一条。
check(
  "引擎参数过了清单校验",
  validateNodeTypeManifest(AGENT_MANIFEST).ok,
);

console.log("\nproviderIdOf(节点用什么引擎)");
eq("正常取值", providerIdOf({ provider: "codex" }), "codex");
eq("两边空格不算数", providerIdOf({ provider: "  pi  " }), "pi");
eq("空串 = 没选", providerIdOf({ provider: "" }), undefined);
eq("只有空格 = 没选", providerIdOf({ provider: "   " }), undefined);
eq("没这个键 = 没选", providerIdOf({}), undefined);
// 参数是用户和 AI 都能写的自由数据 —— 脏值不能让整条流程炸掉。
eq("存成数字 = 当没选", providerIdOf({ provider: 3 }), undefined);
eq("存成 null = 当没选", providerIdOf({ provider: null }), undefined);

const PROFILE: AgentProfile = profileFromParams({
  id: makeAgentProfileId(1_700_000_000_000),
  name: "读论文",
  type: AGENT_MANIFEST.id,
  params: { instruction: "精读这篇", skills: ["pdf"], provider: "codex" },
  createdAt: 1_700_000_000_000,
});

console.log("\n档案 id");
check("生成出来的 id 合规范", AGENT_PROFILE_ID_RE.test(makeAgentProfileId()));
check("两次生成的 id 不一样", makeAgentProfileId() !== makeAgentProfileId());
// id 同时是**文件名** —— 带路径分隔符的 id 能写到数据根外面去,所以那一条必须拦。
check(
  "带 .. 的 id 进不来",
  !validateAgentProfile({ ...PROFILE, id: "p_../../etc" }).ok,
);
check("中文名不影响 id(名字随便写)", PROFILE.name === "读论文");

console.log("\nparamsForProfile(把档案套到节点上)");
const applied = paramsForProfile(AGENT_MANIFEST, PROFILE);
eq("档案里的值生效", applied.instruction, "精读这篇");
eq("多选的数组原样过来", (applied.skills as string[]).join(","), "pdf");
eq("引擎也带过来", applied.provider, "codex");
// 档案是**过去某一刻**存的:之后清单可能加过参数。缺的那些要由清单的默认值补上,
// 否则界面上是个看不出来的坑(节点能存,跑起来才发现必填项是空的)。
const lean: AgentProfile = { ...PROFILE, params: { provider: "codex" } };
const leanApplied = paramsForProfile(AGENT_MANIFEST, lean);
check(
  "没存的必填项被清单默认值补上(有键、是空值)",
  "instruction" in leanApplied && leanApplied.instruction === "",
  leanApplied,
);
eq("档案里有值的照样生效", leanApplied.provider, "codex");
// 反过来:档案里多余的键留着 —— 删掉它们等于替用户丢数据。
const extra = paramsForProfile(AGENT_MANIFEST, { ...PROFILE, params: { ...PROFILE.params, 早就删了: 1 } });
eq("档案里多余的键原样留着", extra["早就删了"], 1);

console.log("\nparseAgentProfile(用户手改的那个文件)");
check("好的一份读得出来", "profile" in parseAgentProfile(JSON.stringify(PROFILE)));
check("不是 JSON → 报错不抛", "error" in parseAgentProfile("{ 这不是 JSON"));
check("顶层是数组 → 报错", "error" in parseAgentProfile("[]"));
check("id 不合规范 → 报错", "error" in parseAgentProfile(JSON.stringify({ ...PROFILE, id: "abc" })));
check("名字是空的 → 报错", "error" in parseAgentProfile(JSON.stringify({ ...PROFILE, name: "" })));
check("参数不是对象 → 报错", "error" in parseAgentProfile(JSON.stringify({ ...PROFILE, params: 3 })));

console.log("\n画布与检查器里的档案");
const withProfile = renderInspector(withNode, "zh", withNode.nodes[0].id, "workflow", [PROFILE]);
check("检查器里有「档案」那一行", withProfile.includes("档案"));
check("有「存为档案」", withProfile.includes("存为档案"));
check("有「套用一份档案」", withProfile.includes("套用一份档案"));
// 节点**不记住**自己从哪份档案来(见 `ProfileRow` 的注释):套用是个动作,不是绑定。
// 所以档案名不该出现在收起状态的检查器里 —— 出现就说明有人把它显示成了"当前值"。
check("收起的检查器里不显示档案名", !withProfile.includes("读论文"));

const foreign: AgentProfile = { ...PROFILE, id: makeAgentProfileId(), type: "demo.parse" };
const otherType = renderInspector(withNode, "zh", withNode.nodes[0].id, "workflow", [foreign]);
// 只列**同类型**的:一份给别的类型存的参数套到这个节点上只会留下一堆它不认识的键,
// 而 `validateNodeParams` 看不出问题(它只看清单声明过的)。
check("别的类型的档案不出现在这个节点上", !otherType.includes("读论文"));

// 加了引擎参数的清单在画布上照样画得出来(新来源不能把渲染端弄挂)。卡片按标题画 ——
// `withNode` 那个节点的标题就是清单名。
const canvasWithEngine = renderCanvas(withNode, "zh");
check("画布:带引擎来源的节点照常画出来", canvasWithEngine.includes(`>${AGENT_MANIFEST.name}<`));
check("画布:引擎参数没填也不当成错误", !canvasWithEngine.includes("类型没装"));

console.log("\n设置页宽度(写死一个宽度就会和别的页对不齐)");
// 这条机械校验也是拿一次真事故换来的:钩子、技能、模型配置、工作流各写了 `max-w-6xl`
// / `max-w-5xl`,而其余十几个页面是 `max-w-3xl` —— 切设置页时正文宽度会跳一下。没有
// 任何一处是**故意**选那些值的,它们只是各写各的。
//
// 现在只有两档,都定义在 `panelWidth.ts`。守卫就是"别处不许再出现字面量":哪一页用
// 哪一档(以及工作流那页为什么不能压到 `form`)在那一份文件里写着,改的时候要连着
// 理由一起改。
const SETTINGS_SRC_DIR = "src/renderer/components/settings";
const WIDTH_LITERAL = /max-w-[3-7]xl/g;
const widthOffenders: string[] = [];
let settingsFiles = 0;
const scanDir = (dir: string): void => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      scanDir(path);
      continue;
    }
    if (!entry.name.endsWith(".tsx") || entry.name === "panelWidth.ts") continue;
    settingsFiles += 1;
    for (const m of readFileSync(path, "utf8").matchAll(WIDTH_LITERAL)) {
      widthOffenders.push(`${path} → ${m[0]}`);
    }
  }
};
scanDir(SETTINGS_SRC_DIR);
check("确实扫到了设置页的源码(否则下面那条是空过)", settingsFiles > 20, settingsFiles);
check(
  "宽度只用 PANEL_MAX_W,没有写死的 max-w-*xl",
  widthOffenders.length === 0,
  widthOffenders.join("; "),
);
// 「两档宽度不一样」不在这里断言 —— 它是**字面量类型**,两者相同的话 tsc 当场报
// "条件恒假"。运行时那句话是空的,编译期那句话是真的。

console.log("\n代理档案页(节点类型页签里的那一块)");
/** 一份档案的列表 / 编辑器。三个用例只差数据,所以只有一个渲染口。 */
const renderProfiles = (profiles: AgentProfile[], problems: Array<{ file: string; error: string }> = []) =>
  withLocale("zh", () =>
    html(
      createElement(AgentProfilesView, {
        catalog: CATALOG,
        profiles,
        problems,
        error: null,
        onSave: async () => {},
        onRemove: async () => {},
      }),
    ),
  );

const profilesHtml = renderProfiles([PROFILE]);
check("列表里有那份档案", profilesHtml.includes("读论文"));
check("能编辑(二次编辑)", profilesHtml.includes("编辑"));
check("能删", profilesHtml.includes("删掉这份档案"));
check("能从这一页新建", profilesHtml.includes("新建档案"));
const profilesEmptyHtml = renderProfiles([]);
check("空的时候说的是怎么才能有", profilesEmptyHtml.includes("还没有档案"));
// 档案引用了没装的类型 —— **不是错误**,但它跑不了,得说出来(同工作流里"类型缺失
// 不算错误")。这一条同时验证"没装也照样列得出来、删得掉"。
const orphanHtml = renderProfiles([{ ...PROFILE, id: makeAgentProfileId(), type: "demo.没装" }]);
check("类型没装的档案照样列出来", orphanHtml.includes("读论文"));
check("而且标出类型没装", orphanHtml.includes("类型没装"));
// 坏文件不静默丢弃 —— 档案"不见了"时这一页是唯一能解释为什么的地方。
const brokenHtml = renderProfiles([], [{ file: "p_x.json", error: "不是合法的 JSON" }]);
check("读不进来的档案文件会显示出来", brokenHtml.includes("p_x.json"));

// ── 岔路口:选项住在**出边**上 ──────────────────────────────────────────
//
// 一个分支节点的选项**不是**一张填在节点上的表,而是它的出边(见 `WorkflowEdge` 的
// `label` / `note`)。所以 "用户能选什么" 只有一份真相:图上拉了几根线就是几个选项。
// 检查器里那一段做的是**给已有的线起名字**,不是定义选项本身。
console.log("\n分支节点:选项在出边上");
{
  const doc: WorkflowDoc = {
    ...CUSTOM,
    nodes: [node("F", 0, 0, BRANCH_MANIFEST.id), node("B", 200, 0), node("C", 200, 100)],
    edges: [
      { id: edgeId("F", "B"), from: "F", to: "B", label: "再来一轮", note: "在现有稿子上改。" },
      { id: edgeId("F", "C"), from: "F", to: "C" },
    ],
  };

  const named = updateEdge(doc, edgeId("F", "C"), { label: "进查重" });
  eq("起名字写进去了", named.edges[1]?.label, "进查重");
  eq("别的边没被动", named.edges[0]?.label, "再来一轮");
  eq("两端改不了(改两端等于换一条边)", named.edges[1]?.to, "C");
  // 没变就**原样返回** —— 状态行是靠"引用变没变"判有没有未保存改动的(第 1 条不变式)。
  check("改成一样的值 → 原样返回", updateEdge(doc, edgeId("F", "B"), { label: "再来一轮" }) === doc);
  // 清空 = **把字段删掉**,不是留一个空串 —— 不然"没填"和"填了空的"会变成两种状态,
  // 而导出成 JSON 之后一个键在一个文件里、不在另一个文件里。
  const cleared = updateEdge(doc, edgeId("F", "B"), { label: "  " });
  check("清空就把字段删掉", !("label" in (cleared.edges[0] ?? {})));
  eq("别的字段留着", cleared.edges[0]?.note, "在现有稿子上改。");
  check("找不到的边 → 原样返回", updateEdge(doc, "e_不存在", { label: "x" }) === doc);

  // 检查器:分支节点摆出"通向哪几条路",每条两个框。
  const branchPanel = renderInspector(doc, "zh", "F");
  check("分支节点有「通向哪几条路」", branchPanel.includes("通向哪几条路"));
  eq("列出两条出路", (branchPanel.match(/选项名（留空就用那一步的标题）/g) ?? []).length, 2);
  check("选项名带出来了", branchPanel.includes('value="再来一轮"'), branchPanel.slice(0, 200));
  check("说明也带出来了", branchPanel.includes("在现有稿子上改。"));
  check("说了这条路通向哪一步", branchPanel.includes("去往「B」"));
  // 不是分支的节点不该看见这一段 —— 它的出边只是普通依赖,没有"选项"可言。
  const agentPanel = renderInspector(doc, "zh", "B");
  check("普通节点的检查器没有这一段", !agentPanel.includes("通向哪几条路"));

  // 一根出路都没有的岔路口是**坏图**(图会永远停在那儿等人),要当场说出来。
  const orphanBranch = renderInspector(
    { ...CUSTOM, nodes: [node("F", 0, 0, BRANCH_MANIFEST.id)], edges: [] },
    "zh",
    "F",
  );
  check("没有出路时明确警告", orphanBranch.includes("一根出路都没有"));

  // 画布:选项名贴在线的中点上 —— 不然图上只有几根说不出名字的线。
  const branchCanvas = renderCanvas(doc, "zh");
  check("画布上画出了选项名", branchCanvas.includes(">再来一轮<"));
  check("没起名字的那条不画字", !branchCanvas.includes(">进查重<"));
  // 它是**说明**,不是命中区:那一整条线都是"点一下删掉这条依赖"的热区
  // (见 `edgeRemoveHint`),让这几个字抢走点击的话,用户想看清楚会被删掉一条边。
  check(
    "选项名不吃点击(pointer-events: none)",
    /<text[^>]*pointer-events:\s*none[^>]*>\s*再来一轮/.test(branchCanvas),
    branchCanvas.slice(branchCanvas.indexOf("再来一轮") - 120, branchCanvas.indexOf("再来一轮") + 20),
  );
}

// ── 岔路口那张卡 ────────────────────────────────────────────────────────
//
// 它是**活的**:按钮点下去之前这次运行没有结束。所以这里盯的是三件事 —— 选项摆全了、
// 每条写清通向哪一步、以及**「就到这儿」那个自带的选项在**(没有它,想收工的用户得先
// 随便挑一条,而挑哪条都意味着让某一步真的跑起来)。
console.log("\nBranchChoiceCard");
{
  type ChoiceBlock = Parameters<typeof BranchChoiceCard>[0]["block"];
  const card = (extra: Partial<ChoiceBlock>): string =>
    withLocale("zh", () =>
      html(
        createElement(BranchChoiceCard, {
          block: {
            kind: "workflow-branch-choice",
            runId: "run1",
            nodeId: "nF",
            nodeType: "mcode.branch",
            title: "稿子怎么样",
            options: [
              { id: "e_a", label: "再改一轮", next: "修订" },
              { id: "e_b", label: "就这样，定稿", next: "定稿" },
            ],
            ...extra,
          } as ChoiceBlock,
        }),
      ),
    );

  const waiting = card({});
  check("两个选项都在", waiting.includes("再改一轮") && waiting.includes("就这样，定稿"));
  check("每条都写了通向哪一步", waiting.includes("修订") && waiting.includes("定稿"));
  check("★ 自带「就到这儿」", waiting.includes("就到这儿"));
  check("可以顺带写一句话", waiting.includes("还想补充点什么"));
  check("有「继续」", waiting.includes("继续"));
  check("还没选的时候不显示「你选了」", !waiting.includes("你选了"));

  // 选过的那一张:**同一张卡**,只是换成结果 —— 不再摆按钮。
  const settled = card({ chosen: "e_a", comment: "第三章太啰嗦" });
  check("选过之后说他选了哪条", settled.includes("你选了「再改一轮」"));
  check("用户写的那句话也留着", settled.includes("第三章太啰嗦"));
  check("★ 选过之后不再摆按钮", !settled.includes("就到这儿") && !settled.includes("继续"));

  // 点了「就到这儿」之后那一张。**不能把哨兵显示给用户看**(`__stop__`)。
  const stopped = card({ chosen: BRANCH_STOP_CHOICE });
  check("★ 停下来的那张说人话", stopped.includes("你让它停在这儿了"), stopped.slice(0, 300));
  check("哨兵本身不露出来", !stopped.includes("__stop__"));
}

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
