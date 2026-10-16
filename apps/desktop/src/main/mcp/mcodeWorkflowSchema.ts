/**
 * `mcodeServer` 的**工作流 schema 与规范化**（从 `mcodeServer.ts` 拆出）。
 *
 * 工作流工具的 zod 入参 schema（POSITION/NODE/EDGE/WORKFLOW/MANIFEST/PROFILE）、
 * `normalizeWorkflow`（把模型给的原始对象规范成 `WorkflowDoc`）与 `shapeLine`
 * （把文档压成一行摘要）。只依赖 `@contracts/workflow`、`@contracts/nodeType` 与自身的
 * 小工具 `isObj`/`str`，对 MCP 工具表零引用。**纯搬迁，函数体逐字节一致。**
 */
import * as path from "node:path";
import { z } from "zod";
import {
  WORKFLOW_CAPABILITIES,
  WORKFLOW_TRIGGERS,
  WorkflowDocSchema,
  autoLayout,
  makeEdgeId,
  makeNodeId,
  makeWorkflowId,
  topoLayers,
  type WorkflowDoc,
  type WorkflowEdge,
  type WorkflowNode,
} from "@contracts/workflow";
import {
  IMPLEMENTED_RUNNER_KINDS,
  NodeParamSpecSchema,
  NodeRunnerSchema,
  isNodeRunnable,
  type NodeTypeManifest,
} from "@contracts/nodeType";
import { NODE_AGENT_TYPE_ID, loadNodeTypes } from "@main/orchestration/nodeTypes.js";
import { isBuiltinWorkflowId } from "@main/orchestration/builtins.js";

export const POSITION_IN = z.object({ x: z.number(), y: z.number() });

export const NODE_IN = z.object({
  id: z
    .string()
    .optional()
    .describe(
      "这一步的 id,同一张图里唯一。**要连边就自己写**(`n1`、`n2` 这样就行),边用它来指人;省略则自动生成。",
    ),
  type: z.string().describe("节点类型的 id,来自 node_types_list,例如 `mcode.agent`"),
  title: z
    .string()
    .optional()
    .describe("这一步叫什么。画布上显示的就是它,下游节点也看得到 —— 起个能看懂的名字;省略则用类型名"),
  params: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("这个类型的参数。键名和值的形状见 node_types_list 里那个类型的「参数」"),
  capability: z
    .enum(WORKFLOW_CAPABILITIES)
    .optional()
    .describe("覆盖类型的默认能力(read / write / exec / net)。**不确定就省略**,用类型的默认值"),
  position: POSITION_IN.optional().describe("画布坐标。**一般不用写** —— 不写代码会按依赖自动排"),
});

export const EDGE_IN = z.object({
  from: z.string().describe("上游节点的 id"),
  to: z.string().describe("下游节点的 id"),
  // 下面这两样**只有 `from` 是分支节点时才写得有意义**(见 `@contracts/workflow` 的
  // `WorkflowEdgeSchema`):那时这条边不是"依赖",而是用户在选择卡上能点的一个**选项**。
  // 其余边上写了也不显示,所以别顺手乱填。
  label: z
    .string()
    .optional()
    .describe(
      "**分支节点专用** —— 这条出路的选项名(按钮上那几个字,比如「再来一轮」)。留空就用目标节点的标题",
    ),
  note: z
    .string()
    .optional()
    .describe(
      "**分支节点专用** —— 选了这条之后给下一步的一句说明,会拼进它的提示词。对这条路上的每一步都成立,和用户点的时候临时写的那句并存",
    ),
});

export const WORKFLOW_IN = z.object({
  id: z
    .string()
    .optional()
    .describe("改一份**已有的**工作流时填它的 id(先用 workflow_get 拿到);新建时省略,代码会生成一个 `wf_` 开头的"),
  name: z.string().describe("工作流的名字 —— 用户在设置里看到的就是它"),
  description: z.string().optional(),
  prompt: z
    .string()
    .optional()
    .describe("**提示词型**工作流的正文(一段流程说明)。有 nodes 的图型工作流不用它"),
  trigger: z
    .enum(WORKFLOW_TRIGGERS)
    .optional()
    .describe(
      "填了 = 这是一条**自动化**,值是它打算靠什么跑起来。" +
        "manual(只手动跑)/ schedule(定时)/ file(文件变化)/ event(某件事发生)都会真的自己动起来" +
        "(`automationRunner` 在启动后按这几种挂 watcher/定时器);" +
        "webhook **尚未实现** —— 填了它不会自己跑。别把 webhook 说成「会自己动」",
    ),
  nodes: z
    .array(NODE_IN)
    .optional()
    .describe("图上的步骤。**一个节点都没有 = 一份提示词型工作流**(流程写在 prompt 里)"),
  edges: z.array(EDGE_IN).optional().describe("步骤之间的依赖:`from` 做完 `to` 才能开始"),
});

export const MANIFEST_IN = z.object({
  id: z.string().describe("类型 id,形如 `作者.名字`(小写,连字符分词)。`mcode.` 是内置的保留前缀,不能用"),
  name: z.string().describe("类型名,插入菜单里显示的就是它"),
  description: z.string().optional(),
  icon: z.string().optional(),
  category: z.string().optional().describe("插入菜单里的分组;省略归入「其他」"),
  // 省略时补 `{ kind: "prompt" }`(起一个子 agent)。其余几种原语见
  // `@contracts/nodeType` 的 `IMPLEMENTED_RUNNER_KINDS` —— **自带脚本的 `command`**
  // (填了 `entry`)是唯一"能存、能画、跑不了"的形状,见 `isNodeRunnable`。
  runner: NodeRunnerSchema.optional(),
  capability: z
    .enum(WORKFLOW_CAPABILITIES)
    .optional()
    .describe("这个类型的**默认**能力。省略按 `read` —— 保守的默认值,写盘该由节点显式声明"),
  params: z.array(NodeParamSpecSchema).optional().describe("参数清单。省略 = 这个类型没有参数"),
  outputs: z
    .array(z.object({ key: z.string(), label: z.string(), description: z.string().optional() }))
    .optional()
    .describe("声明产出什么。纯说明,给下游节点和结果卡片看,不做强制"),
  usage: z.string().optional().describe("给**模型**看的用法说明"),
  doc: z.string().optional().describe("作者给的说明文档,相对清单目录的 markdown 路径"),
});

export const PROFILE_IN = z.object({
  id: z
    .string()
    .optional()
    .describe("改一份**已有的**档案时填它的 id(来自 agent_profiles_list);新建时省略,代码生成一个 `p_` 开头的"),
  name: z.string().describe("档案名,插入菜单里显示的就是它"),
  description: z.string().optional(),
  type: z.string().optional().describe(`这份档案给哪种节点类型用。省略 = \`${NODE_AGENT_TYPE_ID}\``),
  params: z.record(z.string(), z.unknown()).optional().describe("要预先填好的参数(键名见 node_types_list)"),
});

/* ── 归一化 ── */

export type Obj = Record<string, unknown>;

export function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 取一个字符串字段并去掉首尾空白。**不是字符串就当没给** —— 数字、布尔一律不算值。 */
export function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * 把一条消息的 `content` 抽成**给模型读的纯文本**（`session_read_log` 用）。
 *
 * ## 为什么不能直接把 `content` JSON.stringify 出去
 *
 * 存的是引擎原始形状（Anthropic 的块数组），里面有 tool_use / tool_result /
 * base64 图片 —— 全塞给模型既费 token 又没意义（他要的是"那条对话聊了什么"，
 * 不是重放一次工具调用）。所以只取**文本**，其余跳过。
 *
 * ## `thinking` 为什么也跳过（2026-09-24）
 *
 * 从前这里连 `type: "thinking"` 一起取 —— 于是读一条对话会把模型的**内部思考过程**
 * 整段倒出来。用户的明确要求：「**规避思考过程**」。思考不是"那条对话说了什么"，
 * 它是过程不是内容；而且它往往比正文还长、还夹着没被采纳的中间推断，读多了只会
 * 误导。所以现在**只认 `text`**。
 *
 * ## 形状是开放的，一律防御着读
 *
 * 不同引擎的存法不完全一样（有的是数组、有的是 `{ content: [...] }` 包一层、
 * 有的直接是字符串），**真库还有一种 `{ blocks, turnMeta }` 的外壳**（一轮开场那条
 * 助手消息，见 `toRecords`）。这里**不假装知道全部形状**：认不出来的就跳过，最后拼不出
 * 东西时返回空串（调用方会写"(这条没有文本内容)"）。**宁可少给，也不编**。
 */
export function messageTextOf(content: unknown): string {
  const out: string[] = [];

  const take = (v: unknown): void => {
    if (typeof v === "string") {
      const s = v.trim();
      if (s) out.push(s);
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) take(item);
      return;
    }
    if (!isObj(v)) return;
    // ⚠️ **真库里的块用 `kind`，不用 `type`** —— 渲染端的 `Block` 联合类型
    // 就是 `{ kind: "text", text }`（`toRecords` 原样落库）。这里曾经只认
    // `type`，于是真会话读出来全是"(这条没有文本内容)"，而 smoke 夹具灌的是
    // `type` 形状，绿着 —— 恰是"测试绿着问题还在"那类。两种形状都收：引擎
    // 侧的归一化消息（SDK 的 content 数组）确实用 `type`。
    const kind = typeof v["kind"] === "string" ? (v["kind"] as string) : "";
    const type = typeof v["type"] === "string" ? (v["type"] as string) : "";
    // **只认 `text`**。tool_use / tool_result / image 跳过（见上面那段）；
    // `thinking` 也跳过 —— 用户要求规避思考过程（2026-09-24）。
    if (kind === "text" || type === "text") {
      take(v["text"]);
      return;
    }
    // 没有 kind/type 但有 `content`（引擎包了一层）→ 往里看一眼。
    if (kind === "" && type === "" && v["content"] !== undefined) take(v["content"]);
    // ⚠️ **还有一个包了一层的外壳:`{ blocks, turnMeta }`。** 一轮的**开场那条**
    // 助手消息就是这么落的库（见渲染端 `toRecords`:只有带 `turnMeta` 的才包壳，
    // 其余照旧是裸块数组）。前两版判据都只认裸数组，于是**每个回合的第一条助手
    // 回复读出来都是"(这条没有文本内容)"** —— 而这恰恰是用户最想看的那条（他说了
    // 什么、助手怎么答的），现象正是报告 D8 的"读助手回复全为空"。
    // 与 `fromRecords` 同一条读法：认 `blocks` 是数组才收，别把 `turnMeta` 当正文。
    if (kind === "" && type === "" && Array.isArray(v["blocks"])) take(v["blocks"]);
  };

  take(content);
  return out.join("\n\n").trim();
}

export interface Normalized {
  ok: true;
  doc: WorkflowDoc;
  /** 补过什么、以及"能存但跑不了"这类要告诉模型的事。附在成功结果后面。 */
  notes: string[];
}
export type NormalizeResult = Normalized | { ok: false; error: string };

/**
 * 把模型给的那份"大意"补成一份**能存进去**的文档。
 *
 * 原则:**能推出来的都不让模型填**(见文件头)。所以这个过程里唯一会失败的地方是
 * "推不出来"的那些 —— 名字空着、类型认不出来、边指向不存在的节点。
 *
 * 导出是为了无头脚本(`scripts/mcode-admin-smoke`)—— 这是这个 server 里唯一值得
 * 逐条断言的一段:它有十来个分支,而每一条走错的后果都是"AI 存了一份用户看不懂的图"
 * 或者"AI 明明写对了却被拒"。MCP 那一层(工具怎么暴露给模型)不是无头脚本能诚实
 * 验的,那要靠真的跑一次对话。
 */
export async function normalizeWorkflow(raw: Obj): Promise<NormalizeResult> {
  const name = str(raw.name);
  if (!name) return { ok: false, error: "这份工作流没写 name —— 它是用户在设置里看到的那个名字。" };
  if (name.length > 60) return { ok: false, error: `name 太长了(${name.length} 字),最多 60 字。` };
  const description = str(raw.description);
  if (description.length > 200) {
    return { ok: false, error: `description 太长了(${description.length} 字),最多 200 字。` };
  }

  const id = str(raw.id) || makeWorkflowId();
  const notes: string[] = [];
  if (isBuiltinWorkflowId(id)) {
    notes.push(
      `⚠️ \`${id}\` 是软件**自带**工作流的 id,这次保存会覆盖那一行(自带的也只是普通行,可改可删)。` +
        "如果你只是想另做一份,不要填这个 id。",
    );
  }

  const types = new Map<string, NodeTypeManifest>(
    (await loadNodeTypes()).entries.map((e) => [e.id, e.manifest]),
  );

  const rawNodes = raw.nodes ?? [];
  if (!Array.isArray(rawNodes)) return { ok: false, error: "nodes 必须是一个数组。" };
  const nodes: WorkflowNode[] = [];
  const seenNodeIds = new Set<string>();
  /** 有一个节点没给坐标 → 整张图重排。半张有坐标半张没有比全排一遍更难解释。 */
  let hasBareNode = false;

  for (let i = 0; i < rawNodes.length; i++) {
    const n = rawNodes[i];
    if (!isObj(n)) {
      return { ok: false, error: `nodes[${i}] 不是一个对象。每一步至少要写 type 和 params。` };
    }
    const type = str(n.type);
    if (!type) {
      return {
        ok: false,
        error: `nodes[${i}] 没写 type。它是节点类型的 id(形如 mcode.agent),用 node_types_list 看有哪些。`,
      };
    }
    const manifest = types.get(type);
    if (!manifest) {
      // **不算错误**(见 `@contracts/workflow` 文件头):一份分享来的图在这台机器上
      // 可能引用了没装的类型。说清楚就好,它照样能存、能看。
      notes.push(`ℹ️ nodes[${i}] 的类型 \`${type}\` 这台机器上没装 —— 图能存能看,但那一步跑不了。`);
    }
    const params = n.params === undefined ? {} : n.params;
    if (!isObj(params)) {
      return { ok: false, error: `nodes[${i}].params 必须是一个对象(键是参数名,值就是那个参数的值)。` };
    }
    const nodeId = str(n.id) || makeNodeId();
    if (seenNodeIds.has(nodeId)) return { ok: false, error: `两个节点用了同一个 id:${nodeId}` };
    seenNodeIds.add(nodeId);

    // 坐标只认"两个都是数字"的那种。给了个半成品(比如 `{x: "5"}`)当成没给 ——
    // 留着一半会让那个节点钉在原点、还躲过整张图的重排,而它在画布上就是叠在别人身上。
    const position =
      isObj(n.position) && typeof n.position.x === "number" && typeof n.position.y === "number"
        ? { x: n.position.x, y: n.position.y }
        : undefined;
    if (!position) hasBareNode = true;
    // 标题留空时退回类型名 —— 卡片上一行空白比一行 `mcode.agent` 更难认。
    const rawTitle = str(n.title) || manifest?.name || type;
    // ⚠️ **截断要明说,不静默。** schema 的 `title` 上限就是 80(`WorkflowNodeSchema`)——
    // 不截的话整份文档会在 `WorkflowDocSchema` 那步被拒(报一句泛泛的"格式不对"),而
    // 截了却不提,用户看到的标题就和模型以为的不是一回事,模型也无从知道。所以照仓规
    // "坏东西显式报出来":截可以,但附一条 note 告诉模型它写长了。
    if (rawTitle.length > 80) {
      notes.push(
        `ℹ️ nodes[${i}] 的标题超过 80 字,已经截到前 80 字(卡片上显示的就是截过的那个)。` +
          `想改就重存一次,把标题写短一点。`,
      );
    }
    nodes.push({
      id: nodeId,
      type,
      title: rawTitle.slice(0, 80),
      params,
      ...(n.capability === undefined ? {} : { capability: n.capability as WorkflowNode["capability"] }),
      position: position ?? { x: 0, y: 0 },
    });
  }

  const rawEdges = raw.edges ?? [];
  if (!Array.isArray(rawEdges)) return { ok: false, error: "edges 必须是一个数组。" };
  const edges: WorkflowEdge[] = [];
  const seenPairs = new Set<string>();
  for (let i = 0; i < rawEdges.length; i++) {
    const e = rawEdges[i];
    if (!isObj(e)) return { ok: false, error: `edges[${i}] 不是一个对象。一条边要写 from 和 to。` };
    const from = str(e.from);
    const to = str(e.to);
    if (!from || !to) {
      return { ok: false, error: `edges[${i}] 少了 from 或 to(两个都是节点的 id)。` };
    }
    // 去重用的键。**用 JSON 而不是拼一个分隔符** —— 节点的 id 是模型写的,任何
    // 分隔符都可能出现在里面(`n1|n2` 这种),而 JSON.stringify 不会有歧义。
    const key = JSON.stringify([from, to]);
    if (seenPairs.has(key)) continue; // 同一条依赖写两遍没有意义,静默去重
    seenPairs.add(key);
    // `label` / `note` 是**分支节点出路上**那两样(见 `EDGE_IN`)。要带上 —— 这份
    // 归一化器是**重建**一条边的,漏掉它们的话 AI 建出来的岔路口在界面上是一排
    // 没有名字的按钮(全回落成"通向某某"),而模型明明写对了。
    const label = str(e.label).trim();
    const note = str(e.note).trim();
    edges.push({
      id: makeEdgeId(),
      from,
      to,
      ...(label.length > 0 ? { label } : {}),
      ...(note.length > 0 ? { note } : {}),
    });
  }

  if (nodes.length > 0 && hasBareNode) {
    const layout = autoLayout(nodes, edges);
    for (const node of nodes) node.position = layout.get(node.id) ?? node.position;
  }

  const candidate = {
    id,
    name,
    ...(description ? { description } : {}),
    ...(str(raw.prompt) ? { prompt: str(raw.prompt) } : {}),
    ...(raw.trigger === undefined ? {} : { trigger: raw.trigger }),
    nodes,
    edges,
    // 内置退役(2026-09-26):自带的也是普通行,这个字段恒为 false(留着是契约兼容)。
    builtin: false,
    updatedAt: Date.now(),
  };

  // 兜底:前面逐项查的是"能推出来"的那些,剩下的(名字里的非法字符、capability 传了个
  // 别的词、trigger 拼错)交给 schema 说。到这一层已经是**格式**问题了,把第一处指出来
  // 就够 —— 一次报一处的错,模型改一轮。
  const parsed = WorkflowDocSchema.safeParse(candidate);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first && first.path.length > 0 ? `${first.path.join(".")}:` : "";
    return { ok: false, error: `格式不对(${where}${first?.message ?? "没通过校验"})` };
  }
  return { ok: true, doc: parsed.data, notes };
}

/** 用节点名把图排成"第1层 → 第2层"的一行 —— 让模型自己看一眼图是不是它想的那样。 */
export function shapeLine(doc: WorkflowDoc): string {
  const layers = topoLayers(doc.nodes, doc.edges);
  const byLayer = new Map<number, string[]>();
  for (const node of doc.nodes) {
    const layer = layers.get(node.id) ?? 0;
    const list = byLayer.get(layer);
    if (list) list.push(node.title || node.id);
    else byLayer.set(layer, [node.title || node.id]);
  }
  const parts = [...byLayer.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([layer, titles]) => `第 ${layer + 1} 层:${titles.join("、")}`);
  return parts.join(" → ");
}