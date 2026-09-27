/**
 * 对一份 `WorkflowDoc` 的**编辑操作** —— 加节点、改参数、连依赖、删依赖、删节点。
 *
 * ## 为什么是纯函数
 *
 * 画布上每一次拖动、每一次改参数都会变成"有未保存的改动"(见 `WorkflowLibraryView`),
 * 所以"改文档"这件事必须是一条**可断言**的路径:给它一份文档,给它一个动作,得到
 * 一份新文档。组件只负责把动作转成调用。
 *
 * ## 三条不变式,都在这里保证
 *
 * 1. **没改就返回原对象。** 所有函数在"这次操作没有产生变化"时原样返回入参 ——
 *    脏不脏比的是引用(`isDocDirty`),返回新对象会让一次没改过的操作也显示成"有未保存的改动"。
 * 2. **删节点要连带删边。** 留下一根指向不存在节点的边,存盘校验会直接拒绝
 *    (`validateDag`),用户看到的是"改不动了"而不是"节点删掉了"。
 * 3. **边的 id 由两端推出**,所以同一条依赖重复勾不会变成两条边。
 */
import { paramsForProfile, type AgentProfile } from "@contracts/agentProfile";
import {
  CONDITION_NODE_TYPE_ID,
  MAIN_NODE_TYPE_ID,
  NODE_TRIGGER_KIND_PARAM_KEY,
  NODE_TRIGGER_PROJECT_PARAM_KEY,
  NODE_TRIGGER_TASK_PARAM_KEY,
  TRIGGER_NODE_TYPE_ID,
  defaultParamsOf,
  type NodeTypeManifest,
} from "@contracts/nodeType";
import {
  buildForwardAdjacency,
  makeNodeId,
  makeWorkflowId,
  type WorkflowDoc,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowPosition,
} from "@contracts/workflow";
import { autoLayout, firstFreeSlot } from "./workflowLayout.js";

/* ── 新建 ── */

// 两个 id 生成器的**实现**在 contracts —— AI 通过 MCP 建图时走的是同一对函数,两处各写
// 一份迟早会让其中一边的 id 不合另一边的假设(见 `@contracts/workflow` 的注释)。这里原样
// 转出去,是因为画布和冒烟脚本一直从本模块取它们(**必须是 re-export,不能只是 import**
// —— 下面 `newWorkflow` 自己也要用)。
export { makeNodeId, makeWorkflowId };

/**
 * 一份空白工作流 —— 用户按「新建」之后看到的那张白纸。
 *
 * **`prompt` 是空串而不是省略**:空串是"它有一条空提示词",省略是"这个字段没人填",
 * 两者在数据上可区分,而新建的工作流两种都不是 —— 它是一条还没写的提示词(图型
 * 工作流也允许另附一段说明,见 `graphPromptNote`)。
 */
export function newWorkflowDoc(id: string, name: string): WorkflowDoc {
  return { id, name, prompt: "", nodes: [], edges: [], builtin: false, updatedAt: 0 };
}

/**
 * 一份空白**自动化** —— 和上面那张白纸只差一个 `trigger`(它有触发器,所以它是一条
 * 自动化,见 `@contracts/workflow` 的 `WorkflowDocSchema.trigger`)。
 *
 * 默认落 `manual` 而不是留空:留空的话它就不是自动化了(判据是"有没有触发器"),
 * 新建出来的东西会立刻出现在**工作流**那一栏 —— 用户刚在自动化页点了「新建」,
 * 却在另一边看到它。
 */
export function newAutomationDoc(id: string, name: string): WorkflowDoc {
  return { ...newWorkflowDoc(id, name), trigger: "manual" };
}

/* ── 节点 ── */

/**
 * 新种下去的主代理**预填的指令**。
 *
 * ⚠️ **不能留空。** `instruction` 是必填的,而 `validateNodeParams` 把空串也当成"没填"
 * (`value === ""` 直接走必填那一条),所以一个留空的种子节点会让**整份新工作流存不进去**
 * —— 用户点「新建」得到的是一个错误弹窗。`mcode-admin-smoke` 里有一条断言专门盯这件事
 * (种出来的东西要过得了主进程的 `saveWorkflow`);这条注释和那条断言是一对的。
 *
 * 内容本身也是给用户的**起点**:照着改比对着空白框想快得多,而且它把这张图最容易踩的
 * 坑("主代理自己把活干完了,下游没得干")直接写在脸上。
 *
 * ## 最后那句兜底为什么非有不可
 *
 * 新建出来的图**只有主代理一个节点**,而用户完全可能就这么直接发一条消息试试 ——
 * 那一刻"那几件事分别交给下游的助手去做,后面那几步留给它们"是一句**没有下文的指令**:
 * 框架那边(`planSection`)看这张图只有一步,说的是"用户的那件事只有一步,就是你现在做的
 * 这个",而指令说"分给下游"。两句话挨着,直接打架,结果多半是一份"计划书"而不是答案。
 *
 * 不能靠代码在拼提示词时改这句 —— 指令是**用户改过的文本**,运行时不该悄悄改写它。
 * 所以写成**条件句**,让模型自己判:图长什么样,它每一轮都看得见(`## 整条流程`)。
 *
 * ## 为什么中文,不进 i18n
 *
 * 这一条和下面的 `TRIGGER_DEFAULT_TASK` **故意不进词典**,虽然它们确实出现在界面上
 * (节点参数框里,用户看得见)。理由和 store 里的 `buildPlanKickoffPrompt` 一样:它们
 * 是**要发给模型的文本**,不是界面文字 —— 译文会把措辞改掉,而提示词的效力就在措辞上,
 * 换界面语言顺手换掉一条提示词等于让没验证过的指令上生产。
 */
export const MAIN_DEFAULT_INSTRUCTION =
  "先弄清用户这次到底要什么,把它拆成几步,写清每一步交给谁、那一步要交出什么。" +
  "**你把关的是规划与组织,那几件事分别交给下游的助手去做** —— 它们各自有完整的一轮时间去完成,所以这里交出的是拆解结果。" +
  "但要是「整条流程」里只有你一个(后面没有别的步骤),那就反过来:这件事整个归你做,做到用户能直接用为止。" +
  "**做完的样子**:下游拿到你写的那几步就能各自开工,不必再回来问你。";

/**
 * 给一张新图种上**主代理** —— 新建出来的工作流不该是一张白纸。
 *
 * ## 为什么它是"种下去"的,而不是让用户自己加
 *
 * 主代理在这套图里是**入口**:用户那句话先到它这儿,由它拆成几步分给下游。没有它的
 * 话,新建出来的东西既没有起点、也没有一个能收拢结果的地方 —— 用户看到一张空画布,
 * 第一件要做的事居然是"先加一个节点",而那一步**每次都要做、而且每次做的都是同一个**。
 * 用户的原话:「默认创建一个工作流,本身就有一个主代理,不需要添加」。
 *
 * ## 三条实现上的选择
 *
 * - **坐标写死在原点**:它是图的入口,而 `autoLayout` 也会把它排在第 0 层(最上面一行),
 *   两处一致。不用 `firstFreeSlot` —— 那个是给"往已有的图上加"用的,新图本来就是空的。
 * - **指令预填**(见 `MAIN_DEFAULT_INSTRUCTION`):必填项留空的话这份图根本存不下去。
 * - **已经有了就原样返回**:不叠第二个。这条同时是"一份图只有它一个"的兜底(菜单那边
 *   还会在插入前拦一道,见 `WorkflowCanvas` 的工具条)。
 */
export function seedMainAgent(doc: WorkflowDoc, manifest: NodeTypeManifest): WorkflowDoc {
  if (doc.nodes.some((n) => n.type === MAIN_NODE_TYPE_ID)) return doc;
  const seeded = addNode(doc, manifest, { position: { x: 0, y: 0 } });
  const node = seeded.nodes[seeded.nodes.length - 1];
  return updateNode(seeded, node.id, {
    params: { ...node.params, instruction: MAIN_DEFAULT_INSTRUCTION },
  });
}

/**
 * 新种下去的触发器**预填的「这次要做什么」**。
 *
 * ⚠️ **不能留空。** `task` 是必填的(`validateNodeParams` 把空串也当成"没填"),留空的
 * 话新建出来的自动化**存不下去** —— 用户点「新建自动化」得到的是一个错误弹窗。
 *
 * 内容是一句**明确的待办**,不是假装填好的正文:用户一看就知道这是要改的。
 */
export const TRIGGER_DEFAULT_TASK = "把这句话改成这次要做什么。";

/**
 * 给一张新图种上**触发器** —— 新建出来的自动化不该是一张白纸。
 *
 * ## 为什么它和主代理一样是"种下去"的
 *
 * 触发器是**自动化的起点**(2026-09-18 产品裁定):什么时候起一次运行由它说。没有它,
 * 这份图就不会自己跑 —— 而用户点的是「新建**自动化**」,那一栏里的东西天然该会自己动。
 * 更硬的一层原因:保存闸门(`workflowValidation.ts` 的 `graph.no-trigger-node`)会**拒绝**
 * 一份没有触发器的自动化,所以新建时不种,用户点完「新建」看到的就是一个错误弹窗。
 *
 * ## 坐标为什么是负的
 *
 * 它排在主代理**上面**一行(`autoLayout` 按依赖分层,触发器是主代理的上游),所以种在
 * `y = -120`。用 `firstFreeSlot` 不行:那是给"往已有的图上加"用的,而这里要的是"新的
 * 在图的上方",不是"找个空位塞进去"。
 *
 * ## 两个必填参数的预填
 *
 * 「这次要做什么」填 {@link TRIGGER_DEFAULT_TASK}(一句待办)。「在哪个项目里跑」**没有
 * 默认值可编** —— 它是用户环境里的事实,所以由调用方从项目列表里挑一个传进来
 * (`fallbackProjectId`);确实一个项目都没有时留空,存盘会拦下并说明原因。
 *
 * 默认触发方式 `manual`(手动运行)—— 和 `newAutomationDoc` 的 `trigger: "manual"` 同一个
 * 值。选它是因为它**最不容易意外触发**:定时/文件/事件都会在应用开着时自己动,而用户
 * 刚建完这份图还没来得及填内容。要自动跑,自己在检查器里改。
 */
export function seedTrigger(
  doc: WorkflowDoc,
  manifest: NodeTypeManifest,
  fallbackProjectId?: string,
): WorkflowDoc {
  if (doc.nodes.some((n) => n.type === TRIGGER_NODE_TYPE_ID)) return doc;
  /**
   * ⚠️ **位置必须是 (0, 0)，不能是负坐标。**
   *
   * 这里从前是 `{ x: 0, y: -120 }` —— 想在画布上把触发器摆在主代理**上方**。
   * 但画布是**从上往下**排的（见 `relayout`），(0,0) 就已经是第一行了，
   * **负 y 直接跑到画布可视区外面**。
   *
   * 用户 2026-09-22 的截图：新建自动化之后画布上**只有一个主代理**，触发器
   * 看不见 —— 他却以为"没给我插触发器"。原话：「你把触发器放到图外面了，看不到」。
   */
  const seeded = addNode(doc, manifest, { position: { x: 0, y: 0 } });
  const node = seeded.nodes[seeded.nodes.length - 1];
  return updateNode(seeded, node.id, {
    params: {
      ...node.params,
      [NODE_TRIGGER_KIND_PARAM_KEY]: "manual",
      [NODE_TRIGGER_TASK_PARAM_KEY]: TRIGGER_DEFAULT_TASK,
      ...(fallbackProjectId !== undefined && fallbackProjectId !== ""
        ? { [NODE_TRIGGER_PROJECT_PARAM_KEY]: fallbackProjectId }
        : {}),
    },
  });
}

/**
 * 加一个节点。`params` 由清单铺默认值(`defaultParamsOf`)—— 必填项落一个空串,
 * 于是它在检查器里立刻可见、立刻能填,而不是一个看不出缺什么的对象。
 */
export function addNode(
  doc: WorkflowDoc,
  manifest: NodeTypeManifest,
  options?: { position?: WorkflowPosition; profile?: AgentProfile },
): WorkflowDoc {
  const node: WorkflowNode = {
    id: makeNodeId(),
    type: manifest.id,
    // 标题先给类型名:新节点在画布上不该是一张没字的卡片。用户改掉即可。**套档案时不
    // 用档案名当标题** —— 那是配置的名字,不是这一步的名字(同一份档案可以用在好几个
    // 步骤上),而节点标题是给"这一步在干什么"用的。用户想改随时改。
    title: manifest.name,
    // 套档案 = 在**默认值**上覆盖档案里存的那几个键(见 `paramsForProfile`)—— 顺序
    // 不能反:档案是过去某一刻存的,之后清单可能加过参数,直接覆盖会让新参数缺失。
    params: options?.profile
      ? paramsForProfile(manifest, options.profile)
      : defaultParamsOf(manifest),
    position: options?.position ?? firstFreeSlot(doc.nodes),
  };
  return { ...doc, nodes: [...doc.nodes, node] };
}

/** 改一个节点的字段。**找不到就原样返回** —— 见文件头第 1 条不变式。 */
export function updateNode(
  doc: WorkflowDoc,
  id: string,
  patch: Partial<Omit<WorkflowNode, "id">>,
): WorkflowDoc {
  if (!doc.nodes.some((n) => n.id === id)) return doc;
  return {
    ...doc,
    nodes: doc.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)),
  };
}

/** 拖完写回坐标。单独一个函数,是为了让"拖动"这件事在类型上就只是位置。 */
export function moveNode(
  doc: WorkflowDoc,
  id: string,
  position: WorkflowPosition,
): WorkflowDoc {
  return updateNode(doc, id, { position });
}

/** 删一个节点,**连带删掉所有连到它的边**(见文件头第 2 条不变式)。 */
export function removeNode(doc: WorkflowDoc, id: string): WorkflowDoc {
  if (!doc.nodes.some((n) => n.id === id)) return doc;
  return {
    ...doc,
    nodes: doc.nodes.filter((n) => n.id !== id),
    edges: doc.edges.filter((e) => e.from !== id && e.to !== id),
  };
}

/* ── 依赖 ── */

/** 一条依赖边的 id。**由两端推出**(见文件头第 3 条不变式)。 */
export function edgeId(from: string, to: string): string {
  return `e_${from}__${to}`;
}

/** 勾上/取消一条依赖:`depId` 完成后 `nodeId` 才能开始。 */
export function setDependency(
  doc: WorkflowDoc,
  nodeId: string,
  depId: string,
  on: boolean,
): WorkflowDoc {
  if (nodeId === depId) return doc;
  const id = edgeId(depId, nodeId);
  // **按两端找,不按 id 找**(2026-09-27)。画布自己画的边 id 是 `edgeId(from, to)` 推出来的,
  // 但 AI 走 MCP 存的图、导入的图,边 id 是随机生成的(`makeEdgeId`)。原来按推出来的 id
  // 判"有没有这条边":检查器里那个依赖勾选框看着是勾上的(它读的是邻接表),点一下却
  // 取消不掉(这里判成"本来就没有"、原样返回);反过来再拉一次同一条线,会多出一条重复边。
  const sameEnds = (e: WorkflowEdge): boolean => e.from === depId && e.to === nodeId;
  const exists = doc.edges.some(sameEnds);
  if (on === exists) return doc;
  if (on) {
    // 内置条件一拉线就写上真假标签,不会让「看起来连好了」的图存不下去。
    // 删一条再补时用缺的那档;已有两条时拒绝第 3 条(导入/手改仍由保存闸门检查)。
    const isCondition = doc.nodes.some((n) => n.id === depId && n.type === CONDITION_NODE_TYPE_ID);
    const routes = isCondition ? doc.edges.filter((e) => e.from === depId) : [];
    if (isCondition && routes.length >= 2) return doc;
    const label = routes.some((e) => e.label?.trim() === "true") ? "false" : "true";
    return {
      ...doc,
      edges: [...doc.edges, { id, from: depId, to: nodeId, ...(isCondition ? { label } : {}) }],
    };
  }
  return { ...doc, edges: doc.edges.filter((e) => !sameEnds(e)) };
}

/**
 * 勾上这条依赖会不会**成环**。
 *
 * 存盘时 `validateDag` 也会拒,但那时用户已经点完了,而错误只会以一句"图里有环"
 * 出现在别处 —— 在勾的当口挡住,原因和动作才在同一个地方。
 *
 * ## 成环**不一律**是错的
 *
 * 环上有一个**闸门**就放行(见 `@contracts/workflow` 的「回头」)—— 那正是"再改一轮"
 * 这种画法。判据和存盘那一关**是同一个**:闸门 = 岔路口 + 决定权在用户手上,两半缺一
 * 不可,收口在 `@contracts/workflow` 的 `isLoopGateNode`。这里只负责把"谁是闸门"
 * ({@link isLoopGate},它要读节点类型清单)传进去;自己再判一遍就会漂 —— 这个函数
 * 早先那版就是因为少判了"决定权"那一半,画布上放行的环存盘时被拒。
 *
 * 上游邻接表**不自己建**:`buildForwardAdjacency` 就是"每个节点依赖谁"的唯一来源
 * (见 `@contracts/workflow`)。自己再走一遍 `edges` 是第二份实现 —— 两份迟早会在
 * "边指向一个不存在的节点"这类输入上分家,而那时勾选框和这里会对不上。
 */
export function wouldCycle(
  doc: WorkflowDoc,
  nodeId: string,
  depId: string,
  /** 这个节点是不是**环的闸门**(见上)。由调用方从节点类型表里取,契约层的
   *  `isLoopGateNode` 是那个唯一判据。 */
  isLoopGate: (nodeId: string) => boolean,
): boolean {
  if (nodeId === depId) return true;
  const { dependents } = buildForwardAdjacency(doc.nodes, doc.edges);
  // 新边是 `depId → nodeId`。成环 ⟺ `nodeId` 本来就能沿着边走到 `depId`。
  const after = reachableFrom(dependents, nodeId);
  if (!after.has(depId)) return false;
  // 新边的某一端就是闸门:经过这条新边的**每一圈**都经过它,放行。
  if (isLoopGate(nodeId) || isLoopGate(depId)) return false;
  // 否则要问的是"**每一圈**都经过闸门吗",不是"有没有哪一圈经过闸门"
  // (2026-09-27)。原来只要「nodeId 的下游 ∩ depId 的上游」里有一个闸门就放行,可
  // 那片交集里还可能有一条**绕开闸门**的路:`A→G→C` 加一条 `A→C` 时,从 C 拉回 A 这根线
  // 闭出两圈,`A→G→C→A` 有闸门,`A→C→A` 没有 —— 画布放行,存盘却(应当)拒绝。
  // 等价的判据:不经过任何闸门,`nodeId` 还能不能走到 `depId`。能,就有一圈没人拦。
  return reachableFrom(dependents, nodeId, isLoopGate).has(depId);
}

/** 从 `start` 出发、按 `step` 这张邻接表能走到的全部节点(**含 `start` 自己**)。
 *  给了 `blocked` 时,被它拦下的节点不进结果、也不从它往下走("绕开闸门还能不能到")。 */
function reachableFrom(
  step: Map<string, string[]>,
  start: string,
  blocked?: (id: string) => boolean,
): Set<string> {
  const seen = new Set<string>([start]);
  const stack: string[] = [start];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined) continue;
    for (const next of step.get(id) ?? []) {
      if (seen.has(next)) continue;
      if (blocked?.(next)) continue;
      seen.add(next);
      stack.push(next);
    }
  }
  return seen;
}

/**
 * 从 `from` 拉到 `to`(`from` 先跑完,`to` 才开始)。
 *
 * 画布上拖出来的那条连线走的**就是** {@link setDependency} —— 边的 id 怎么算、
 * 重复连怎么办,只有那一份实现;这里只是把"源头在前"这个方向说清楚,免得调用方
 * 把两个参数写反(反了就是一条**倒着**的依赖,而图上看起来只像是箭头画反了)。
 *
 * 成环的判断**不在这里**:画布在拖的过程中就要拿它给目标卡片标红(见
 * `WorkflowCanvas.targetAt`),等到这里已经太晚了。
 */
export function connect(doc: WorkflowDoc, from: string, to: string): WorkflowDoc {
  return setDependency(doc, to, from, true);
}

/**
 * 按 id 删一条边 —— 点画布上那根线走的是这里。
 *
 * 不用 {@link setDependency} 反着调(那样要先从 `edges` 里把两端捞出来),因为这条
 * 路手上拿到的**就是那条边本身**:图里可能有一条两端指向已删节点的边(校验会拒,
 * 但正在编辑的文档可以短暂处于这个状态),按 id 删对它照样管用。
 */
export function removeEdge(doc: WorkflowDoc, id: string): WorkflowDoc {
  if (!doc.edges.some((e) => e.id === id)) return doc;
  return { ...doc, edges: doc.edges.filter((e) => e.id !== id) };
}

/**
 * 改一条边上的**附加字段** —— 目前只有分支节点那两个:选项名(`label`)和给下一步的
 * 说明(`note`)。见 `@contracts/workflow` 的 `WorkflowEdgeSchema`。
 *
 * **改不了两端**:一条边的 id 就是 `edgeId(from, to)` 算出来的,改两端等于换一条边 ——
 * 那是"删一条、加一条",而那条路走 {@link removeEdge} + {@link connect}。
 *
 * ⚠️ 这条 id 规则同时意味着**一对节点之间只可能有一条边**。所以一个分支节点不能把两个
 * 选项指向同一步 —— 想做"两条路通向同一个格子、但要做的事不同",那是两个格子(那本来
 * 也该是两个节点,见 `scheduler.ts` 里 `Arrival` 的那段)。
 *
 * 空串 = **把字段删掉**,不是留一个空串:留空串的话"没填"和"填了空的"会变成两种状态,
 * 而导出成 JSON 之后一个键在一个文件里、不在另一个文件里。
 */
export function updateEdge(
  doc: WorkflowDoc,
  id: string,
  patch: { label?: string; note?: string },
): WorkflowDoc {
  const at = doc.edges.findIndex((e) => e.id === id);
  if (at < 0) return doc;
  const cur = doc.edges[at] as WorkflowEdge;
  const next: WorkflowEdge = { ...cur, ...patch };
  if ((next.label ?? "").trim().length === 0) delete next.label;
  if ((next.note ?? "").trim().length === 0) delete next.note;
  // **没变就原样返回**(第 1 条不变式,同 `applyLayout`):不然每次敲一个字符都会换掉
  // 整个 `edges` 数组,而状态行是靠"引用变没变"判有没有未保存改动的。
  if (
    cur.label === next.label &&
    cur.note === next.note &&
    cur.from === next.from &&
    cur.to === next.to
  ) {
    return doc;
  }
  const edges = doc.edges.slice();
  edges[at] = next;
  return { ...doc, edges };
}

/* ── 布局 ── */

/**
 * 把一组坐标一次性写回(「整理布局」用)。空 map 原样返回。
 *
 * **算出来和现在一样也要原样返回**(第 1 条不变式)。这不是多余的判断:在一张已经排
 * 好的图上按「整理布局」,算出来的正是当前坐标 —— 不逐个比的话每次点它都会换掉整个
 * `nodes` 数组,整份图据此判成"脏了" —— 用户什么都没改,状态行却在说有未保存的改动(见文件头第 1 条)。
 */
export function applyLayout(
  doc: WorkflowDoc,
  positions: Map<string, WorkflowPosition>,
): WorkflowDoc {
  if (positions.size === 0) return doc;
  let changed = false;
  const nodes = doc.nodes.map((node) => {
    const position = positions.get(node.id);
    if (!position) return node;
    if (position.x === node.position.x && position.y === node.position.y) return node;
    changed = true;
    return { ...node, position };
  });
  return changed ? { ...doc, nodes } : doc;
}

/** 按依赖重排整张图。 */
export function relayout(doc: WorkflowDoc): WorkflowDoc {
  return applyLayout(doc, autoLayout(doc.nodes, doc.edges));
}
