/**
 * **mcode-workflow** —— 让模型自己改工作流 / 自动化 / 节点类型 / 代理档案的进程内 MCP server。
 *
 * ## 为什么是 MCP 工具,而不是让 AI 去写文件
 *
 * 工作流的真相在**主进程**里:
 *
 *   - 工作流与自动化 —— `workflows` 表(内存里那个 sql.js 实例,磁盘上那份 `mcode.db`
 *     只是它整份重写的产物);
 *   - 代理档案 / 节点类型 —— 数据根下的 JSON 文件,但**读写都由主进程的加载器管**
 *     (`agentProfiles.ts` / `nodeTypes.ts`)。
 *
 * 让 AI 直接写 `mcode.db` 是错的:应用下一次保存会把整份文件覆盖掉,AI 以为建好了,
 * 界面上什么都没有(同 `libraryServer.ts` 文件头那段)。而工作流还有个更硬的理由:
 * **存盘前必须跑 `validateDag` 与参数校验** —— 一个没有岔路口的环会让调度器永远等不到
 * 就绪节点,那不是报错,是静默卡死。走 `saveWorkflow` 是唯一会过那两道关的路。
 *
 * (AI 因此也能画**回头**(`edges[].from/to` 指回前面的节点)—— 闸门在
 * `saveWorkflow` 里判,它不需要自己做这件事;不合法的话拿回来的就是一句说得清的话。)
 *
 * ## 工具的分档
 *
 * 读(自动放行,不弹审批):`workflow_list` / `workflow_get` / `node_types_list` /
 * `agent_profiles_list`。
 * 写(需要用户点头):`workflow_save` / `workflow_remove` / `agent_profile_save` /
 * `agent_profile_remove` / `node_type_write`。
 *
 * ## ⚠️ 刻意**没有**的东西
 *
 * 没有钩子、没有插件安装、没有 MCP server 安装。不是没做完,是**这一档不该给**:
 *
 *   - 钩子是**事件驱动的命令**,装上之后在没有对话、没有审批界面的时刻执行 —— 一次
 *     误装就是持久化的任意代码执行;
 *   - 插件与 MCP server 都是**从外部拉代码进来**,装的那一刻就等于把信任边界推到了
 *     对方仓库;
 *   - 而这个应用的主要用途是**读论文**,论文是不可信输入。给模型一个"装点什么"的
 *     工具,等于让一篇 PDF 里的注入文字有机会落到用户机器上。
 *
 * 前两档(读 + 改工作流)的危害上限是"用户打开设置页发现图被画坏了",删掉重画即可。
 * 这个差别就是分档的依据。真要放开第三档,那条路应该是**逐次实时审批、批准卡片上
 * 逐字显示要执行的命令,而且不提供「始终允许」**,不能顺手挂在这里。
 *
 * ## 归一化:AI 画出来的图没有坐标
 *
 * 模型不该被要求填 `position` —— 它想的是"先查文献再算数据",不是"x 等于 312"。
 * 所以 `workflow_save` 接受一份**没有坐标**的文档,缺的那部分由 `autoLayout`
 * (`@contracts/workflow`)按依赖补上 —— 那个函数同时是画布「整理布局」的实现,
 * 于是"AI 建出来再点一下整理布局"不会跳。
 *
 * 同一类归一化还有:id 缺了就地生成、边的 id 由两端命名、`builtin` 由 id 是不是内置
 * 推出来、`updatedAt` 由主进程盖。凡是**能推出来的东西都不让模型填** —— 填了就有
 * 填错的可能,而推是不会有分歧的。
 */
import * as path from "node:path";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
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
  NODE_MANIFEST_VERSION,
  NodeParamSpecSchema,
  NodeRunnerSchema,
  RESERVED_NODE_TYPE_PREFIX,
  isNodeRunnable,
  renderNodeTypeCatalog,
  validateNodeParams,
  validateNodeTypeManifest,
  type NodeTypeManifest,
} from "@contracts/nodeType";
import { AGENT_PROFILE_VERSION, makeAgentProfileId, type AgentProfile } from "@contracts/agentProfile";
import { MCP_WORKFLOW_SERVER } from "@contracts/ipc";
import { isBuiltinWorkflowId } from "@main/orchestration/builtins.js";
import {
  readAgentProfiles,
  removeAgentProfile,
  saveAgentProfile,
} from "@main/orchestration/agentProfiles.js";
import { getWorkflow, listWorkflows, removeWorkflow, saveWorkflow } from "@main/orchestration/library.js";
import { workflowSaveVersion } from "@main/orchestration/workflowSaveVersion.js";
import { MessageRepo, ProjectRepo, SessionRepo } from "@main/store/repositories.js";
import type { Session } from "@contracts/session";
import { NODE_AGENT_TYPE_ID, loadNodeTypes, localNodeTypesDir } from "@main/orchestration/nodeTypes.js";
import { notifyWorkflowsChanged } from "@main/orchestration/broadcast.js";
import { requestWorkflowReload } from "@main/orchestration/reloadRequest.js";
import {
  deliver,
  peersOf,
  peekAsk,
  recordAsk,
  resolvePeer,
  selfPeerOf,
  takeAsk,
  undeliveredCount,
  unknownPeerMessage,
} from "@main/lib/agentMail.js";
import { fail, loadCreateMcpServer, text, toSdkTools, type McpToolContext, type McpToolSpec } from "./sdk.js";

/** MCP server 名。SDK 把工具暴露成 `mcp__<这个名字>__<工具名>`。
 *
 *  字面量定义在 `@contracts/ipc` —— 渲染端也要认这个名字(工作流节点的 MCP 候选表
 *  要把它滤掉,见 `NODE_MCP_PARAM_KEY`)。这里只是沿用主进程这一侧一直在用的名字。 */
export const WORKFLOW_MCP_SERVER = MCP_WORKFLOW_SERVER;
export const WORKFLOW_MCP_PREFIX = `mcp__${WORKFLOW_MCP_SERVER}__`;

/**
 * 只读工具 —— 在 `shouldAutoApprove` 里自动放行。
 *
 * 它们改不了任何东西:看的是一份工作流的定义、有哪些节点类型、用户存了哪些代理档案。
 * 与只读的浏览器/库工具同一档。写工具一律要用户点头 —— 它们动的是用户自己画的东西。
 *
 * ⚠️ **`session_read_log` 归在这一档,但它和上面几个不是一回事。** 上面几个读的是
 * "用户自己配的东西"(工作流、类型、档案),而它读的是**用户的对话记录**。放行它 =
 * 模型可以不经批准翻看某条对话。
 *
 * 之所以仍然放行:它**只能按 id 读**,而 id 原本只能从用户手里拿到(界面上「复制对话
 * id」那一项),模型自己猜不出、也列不出有哪些对话。也就是说**用户给 id 这个动作本身
 * 就是授权** —— 再弹一次批准没有新信息。
 *
 * ⚠️ **2026-09-24:这个前提被 `session_list` 打破了**（那条注释当初就预警过
 * 「将来若给它加了"列全部对话"的能力,这条归类就得重新想」）。现在模型能自己列出
 * 全部对话、再逐个读 —— 所以：
 *   1. `session_list` **不放进这个集合**（它要用户点头）；
 *   2. **两条都不进公网那张工具表**（见 `workflowMcpTools` 的 `includeSessionLogs`
 *      参数与 `webToolHost` 的调用）—— 否则拿到公网链接的人可以枚举并读光所有对话。
 */
export const WORKFLOW_READONLY_TOOLS = new Set([
  "workflow_list",
  "workflow_get",
  "node_types_list",
  "agent_profiles_list",
  "session_read_log",
  // 只读:它只是列一眼名册,改不了任何东西、也叫不醒谁,所以**不问用户**。
  // (两个有副作用的 —— agent_notify / agent_ask —— 不在这里,它们照常弹审批卡,
  //  那正是用户"看得见、能拦下"的落点。)
  "agent_peers",
]);

/**
 * 代理间通信那一组工具的名字。**公网那条路要把它们整组摘掉**,理由与
 * {@link SESSION_LOG_TOOLS} 同源(甚至更硬):拿到公网链接的人不该有能力**叫醒本机的
 * 会话**(`agent_notify` / `agent_ask`),也不该读到本机有哪些会话(`agent_peers`)。
 *
 * 单列一份是因为它要被两处用:工具表的过滤(这里)和那两条工具自己的归属判断。
 * 硬规矩 2 —— 同一份清单不写两遍。
 */
export const AGENT_MAIL_TOOLS = new Set(["agent_peers", "agent_notify", "agent_ask"]);

/**
 * 读用户对话记录那一组工具的名字。**公网那条路要把它们整组摘掉**（见
 * `workflowMcpTools` 的 `includeSessionLogs`）。
 *
 * 单列一份是因为它要被两处用：工具表的过滤（这里）和 `webToolHost` 的调用。
 * 硬规矩 2 —— 同一份清单不写两遍。
 */
export const SESSION_LOG_TOOLS = new Set(["session_read_log", "session_list"]);

/* ── 输入 schema ──
 *
 * 写工具的入参**声明成完整形状**,而不是一个 `z.record(unknown)`。两个理由:
 *
 * 1. SDK 把 zod 转成 JSON Schema 给模型看 —— 声明了字段名,模型就不用猜 `nodes` 里
 *    每一项该写什么。这份 schema 本身就是这个工具最主要的一份文档。
 * 2. zod 的 object 默认丢掉没声明过的键,于是"模型顺手多塞的字段"到不了归一化那一层。
 *
 * 但 handler 里**仍然逐项自己检查** —— schema 拦不住"字段给了但值不合理"(名字太长、
 * 边指向不存在的节点),而那些要给出中文的、指向具体位置的失败信息。 */

const POSITION_IN = z.object({ x: z.number(), y: z.number() });

const NODE_IN = z.object({
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

const EDGE_IN = z.object({
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

const WORKFLOW_IN = z.object({
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

const MANIFEST_IN = z.object({
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

const PROFILE_IN = z.object({
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

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 取一个字符串字段并去掉首尾空白。**不是字符串就当没给** —— 数字、布尔一律不算值。 */
function str(v: unknown): string {
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
 * 有的直接是字符串）。这里**不假装知道全部形状**：认不出来的就跳过，最后拼不出东西
 * 时返回空串（调用方会写"(这条没有文本内容)"）。**宁可少给，也不编**。
 */
function messageTextOf(content: unknown): string {
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
  };

  take(content);
  return out.join("\n\n").trim();
}

interface Normalized {
  ok: true;
  doc: WorkflowDoc;
  /** 补过什么、以及"能存但跑不了"这类要告诉模型的事。附在成功结果后面。 */
  notes: string[];
}
type NormalizeResult = Normalized | { ok: false; error: string };

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
    nodes.push({
      id: nodeId,
      type,
      // 标题留空时退回类型名 —— 卡片上一行空白比一行 `mcode.agent` 更难认。
      title: (str(n.title) || manifest?.name || type).slice(0, 80),
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
function shapeLine(doc: WorkflowDoc): string {
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

/* ── 构建 ── */


/**
 * 这个 server 的工具表 —— **只有声明,不碰 SDK**。
 *
 * 抽出来的原因见 `./sdk.ts` 的 `McpToolSpec`:同一份表还要给网页端那条通路用
 * (浏览器里的扩展直接向主进程要工具,不经过 SDK)。所以这里返回声明,
 * {@link buildWorkflowMcpServer} 与 `main/mcp/webToolHost.ts` 各自 map 一次。
 *
 * @param includeSessionLogs 要不要带上 `session_read_log` / `session_list`
 *   （见 {@link SESSION_LOG_TOOLS}）。**默认带上**（桌面本机那条路）；公网那条路
 *   （`webToolHost`）传 `false` 把它们摘掉 —— 理由见 `webToolHost` 的调用点：
 *   拿到公网链接的人能枚举并读光用户的全部对话，那是不可接受的。
 */
export function workflowMcpTools(opts?: { includeSessionLogs?: boolean }): McpToolSpec[] {
  const includeSessionLogs = opts?.includeSessionLogs !== false;
  const specs: McpToolSpec[] = [
    /* ─────────────── 读(自动放行)─────────────── */
    {
      name: "workflow_list",
      description:
        "列出用户全部的**工作流**与**自动化**。用 `workflow_get` 拿某一份的完整内容之前先调它。" +
        "软件自带的那几份(`default` / `search` / `read` / `write` / `review` / `code`)也在里面 ——" +
        "它们只是出厂时播种的普通行,可改可删;改/删任何一份前都**先跟用户确认是哪一个**。",
      inputSchema: {},
      handler: async () => {
        const rows = listWorkflows();
        if (rows.length === 0) return text("(一份工作流都没有)");
        const lines = rows.map((r) => {
          const bits = [
            // 内置退役:不再标「内置/自建」—— 全是普通行,那种标注只会误导模型"这份删不得"。
            r.pinned ? "钉过默认" : "",
            r.kind === "graph" ? "图" : "提示词",
            r.trigger ? `自动化(${r.trigger})` : "",
          ].filter(Boolean);
          return `- ${r.name}  id=\`${r.id}\`  (${bits.join(" · ")})\n  ${r.description ?? "无说明"}`;
        });
        return text(`共 ${rows.length} 份:\n\n${lines.join("\n")}`);
      },
    },
    {
      name: "session_read_log",
      description:
        "按 **id 读另一条对话的记录**（用户会在别处把那 id 给你，或者你先用 session_list 查）。" +
        "只在**用户明确让你去读某条对话**时用它 —— 平时不要自己去找 id、也不要拿它当" +
        "\"翻一翻别人聊了什么\"的工具。返回按时间正序的消息，每条只有角色和正文。" +
        "**思考过程不进正文**（那是过程不是内容），工具调用那类内部细节也不进。" +
        "用 `mode` 挑你要看哪一部分：默认 `summary`（用户 + 助手正文，最常用）；" +
        "`user` 只看用户说了什么（想知道对方的需求/意图时用）；" +
        "`result` 只看助手的回复（想知道结论/产出时用）。",
      inputSchema: {
        sessionId: z.string().describe("要读的那条对话的 id（形如 sess_…，来自 session_list 或用户给的）"),
        mode: z
          .enum(["summary", "user", "result"])
          .optional()
          .describe(
            "看哪一部分：summary = 用户 + 助手正文（默认，最常用）；" +
              "user = 只列用户说的话（看需求/意图）；" +
              "result = 只列助手的回复（看结论/产出）。",
          ),
        limit: z.number().int().min(1).max(200).optional().describe("最多返回多少条，默认 50（取**最后**这些条）"),
      },
      handler: async (args: { sessionId: string; mode?: "summary" | "user" | "result"; limit?: number }) => {
        const session = SessionRepo.get(args.sessionId);
        if (!session) {
          return fail(`没有 id 为 \`${args.sessionId}\` 的对话 —— 确认一下 id 抄对了没有。`);
        }
        const mode = args.mode ?? "summary";
        const all = MessageRepo.listBySession(args.sessionId).messages;
        // 先按模式筛**角色**，再取末 N 条 —— 顺序要紧：先截断再筛的话，
        // "只看用户"很可能一条都剩不下（最后 50 条可能全是助手在干活）。
        const byRole =
          mode === "user"
            ? all.filter((m) => m.role === "user")
            : mode === "result"
              ? all.filter((m) => m.role === "assistant")
              : all;
        const limit = args.limit ?? 50;
        // 取**最后** N 条：用户说"看看那条对话"时，他要的多半是最近的进展，
        // 而不是开场白。
        const picked = byRole.length > limit ? byRole.slice(-limit) : byRole;
        const modeNote =
          mode === "user" ? "（只看用户说的话）" : mode === "result" ? "（只看助手的回复）" : "";
        if (picked.length === 0) {
          return text(
            byRole.length === 0 && mode !== "summary"
              ? `对话「${session.title}」里没有符合 \`mode: ${mode}\` 的消息。换成 summary 看一眼全部。`
              : `对话「${session.title}」还没有消息。`,
          );
        }
        const lines = picked.map((m) => {
          const body = messageTextOf(m.content);
          const who = m.role === "user" ? "用户" : m.role === "assistant" ? "助手" : "系统";
          return `### ${who}\n\n${body || "(这条没有文本内容)"}`;
        });
        const head =
          `对话「${session.title}」（id ${session.id}）${modeNote}` +
          (byRole.length > picked.length
            ? `，共 ${all.length} 条（其中 ${byRole.length} 条符合），下面是最后 ${picked.length} 条`
            : `，共 ${all.length} 条，下面是全部 ${picked.length} 条`);
        return text(`${head}\n\n${lines.join("\n\n")}`);
      },
    },
    {
      name: "session_list",
      description:
        "列出这台机器上的**对话**（id + 标题 + 所属项目 + 最后活动时间，最近的在前面）。" +
        "用来找到「要读哪条对话」的那个 id —— 拿到 id 之后用 session_read_log 读内容。" +
        "⚠️ **只在用户让你去翻某条对话、而你没被告知 id 时用**。不要拿它当「看看用户都聊了什么」的工具。",
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional().describe("最多返回多少条，默认 50，最近的在前面"),
        query: z.string().optional().describe("按标题或项目名过滤（不区分大小写，子串匹配）"),
        archived: z.boolean().optional().describe("要不要连已归档的一起列，默认 false（只列活跃的）。已归档**项目**下的对话也归这档管"),
      },
      handler: async (args: { limit?: number; query?: string; archived?: boolean }) => {
        // 跨项目列 —— 用户要"每个会话出自哪个项目"一目了然，所以按项目分组渲染。
        //
        // 逐个项目调 `listByProject`（不另写 SQL）：它本来就按 `updated_at DESC`
        // 排好、也支持 `archived` 过滤。项目数是个位数，几趟查询对一次工具调用
        // 无所谓 —— 换来的是**不新增一份查询口径**。
        //
        // ⚠️ 两处口径要跟"左侧列表"分开（都是审查抓出来的真 bug）：
        //   1. **置顶**：`listByProject` 的活跃档（archived===false）会追加
        //      `pinned_at IS NULL`（置顶的在左栏全局置顶区单独渲染）。工具没有
        //      "置顶区"，漏掉它们就是假阴性 —— 所以活跃档要**补回置顶**的
        //      （`listPinned` 是跨项目的同一批）。
        //   2. **已归档项目**：左侧列表不显示归档项目，但归档项目的对话还在库里、
        //      `session_read_log` 用 id 也读得到 —— 枚举工具读不到就是假阴性。
        //      所以项目层不再按归档过滤，归档项目的会话跟着 `archived` 参数走。
        const limit = args.limit ?? 50;
        const projects = ProjectRepo.list();
        const q = args.query?.trim().toLowerCase();
        const all: Session[] = [];
        for (const p of projects) {
          if (args.archived === true) {
            // 全量档：这个项目下的所有对话（含已归档）都要。
            all.push(...SessionRepo.listByProject(p.id, {}));
          } else {
            // 活跃档 + 补回置顶（listByProject 的活跃档会把置顶滤掉）。
            all.push(...SessionRepo.listByProject(p.id, { archived: false }));
            all.push(...SessionRepo.listPinned().filter((s) => s.projectId === p.id));
          }
        }
        // 跨项目按最后活动时间统一排序，再截断 —— 不然排在前面的项目会把 limit 吃满。
        all.sort((a, b) => b.updatedAt - a.updatedAt);
        const projById = new Map(projects.map((p) => [p.id, p]));
        const matched = q
          ? all.filter((s) => {
              const proj = projById.get(s.projectId);
              return (
                s.title.toLowerCase().includes(q) ||
                (proj?.name ?? "").toLowerCase().includes(q) ||
                (proj?.path ?? "").toLowerCase().includes(q)
              );
            })
          : all;
        const shown = matched.slice(0, limit);
        if (shown.length === 0) {
          return text(
            q ? `没有标题或项目匹配「${args.query}」的对话。` : "这台机器上还没有对话。",
          );
        }
        // 按项目分组：同一条对话属于哪个项目要一眼看得出来（用户明确要求）。
        const byProject = new Map<string, Session[]>();
        for (const s of shown) {
          const bucket = byProject.get(s.projectId);
          if (bucket) bucket.push(s);
          else byProject.set(s.projectId, [s]);
        }
        const blocks: string[] = [];
        for (const [projectId, list] of byProject) {
          const proj = projById.get(projectId);
          const projName = proj?.name ?? projectId;
          const projPath = proj?.path ? `（${proj.path}）` : "";
          const rows = list.map((s) => {
            // 本地时间，不是 UTC —— `toISOString` 会把 GMT+8 的"5 分钟前"画成
            // "昨天"，模型和用户都会判断错哪条是最近的。
            const when = new Date(s.updatedAt)
              .toLocaleString("sv-SE", { hour12: false })
              .slice(0, 16);
            const archivedMark = s.archived ? " · 已归档" : "";
            return `- ${s.title} — id ${s.id} — 最后活动 ${when}${archivedMark}`;
          });
          blocks.push(`## 项目：${projName}${projPath}\n\n${rows.join("\n")}`);
        }
        const head =
          `共 ${shown.length} 条对话` +
          (matched.length > shown.length ? `（匹配 ${matched.length} 条，只列最近的）` : "") +
          (q ? `（过滤「${args.query}」）` : "") +
          `，按所属项目分组：`;
        return text(`${head}\n\n${blocks.join("\n\n")}`);
      },
    },
    {
      name: "workflow_get",
      description:
        "取一份工作流的**完整内容**(节点、边、每一步的参数)。改一份已有的工作流时:" +
        "先调它拿到这份文档 → 按需要改 → 用 `workflow_save` 整份存回去。",
      inputSchema: { id: z.string().describe("工作流 id,来自 workflow_list") },
      handler: async (args: { id: string }) => {
        const doc = getWorkflow(args.id);
        if (!doc) {
          return fail(
            `没有 id 为 \`${args.id}\` 的工作流。用 workflow_list 看看有哪些 —— 内置的那几个用的是` +
              ` default / search / read / write / review / code 这种 id。`,
          );
        }
        return text(
          `${doc.name}${doc.trigger ? `(自动化:${doc.trigger})` : ""}\n版本: ${workflowSaveVersion(doc)}\n\n\`\`\`json\n${JSON.stringify(doc, null, 2)}\n\`\`\``,
        );
      },
    },
    {
      name: "node_types_list",
      description:
        "列出当前可用的**节点类型**,以及每种类型的参数(key、值的形状、必填、可选值)。" +
        "**动手写工作流之前先调它** —— 不知道有哪些类型、参数叫什么就写,只能凭空编一个," +
        "而 `workflow_save` 会直接拒掉。",
      inputSchema: {},
      handler: async () => {
        const catalog = await loadNodeTypes();
        if (catalog.entries.length === 0) return text("(这台机器上一种节点类型都没有,工作流写不了)");
        const problems = catalog.problems.length
          ? `\n\n⚠️ 有 ${catalog.problems.length} 份清单读不进来,它们对应的类型**现在用不了**:\n` +
            catalog.problems.map((p) => `- ${p.file}:${p.error}`).join("\n")
          : "";
        return text(
          renderNodeTypeCatalog(catalog.entries) +
            problems +
            "\n\n注:`skills` / `model` / `provider` 这几个引用型参数的值只查**形状**,不查名字存不存在 ——" +
            "**拿不准就留空**(留空 = 不限制 / 跟着这次对话走),别编一个名字塞进去。",
        );
      },
    },
    {
      name: "agent_profiles_list",
      description:
        "列出用户存下来的**代理档案** —— 一份档案 = 一组预先填好的节点参数(指令、技能、模型…),建节点时直接套用。" +
        "要给某个流程复用一套现成的配置(而不是每次从头填)时看一下这里有没有对得上的。",
      inputSchema: {},
      handler: async () => {
        const catalog = readAgentProfiles();
        const problems = catalog.problems.length
          ? `\n\n⚠️ 有 ${catalog.problems.length} 份档案读不进来:\n` +
            catalog.problems.map((p) => `- ${p.file}:${p.error}`).join("\n")
          : "";
        if (catalog.profiles.length === 0) return text(`(用户还没存过代理档案)${problems}`);
        const lines = catalog.profiles.map(
          (p) =>
            `- ${p.name}  id=\`${p.id}\`  (给 \`${p.type}\` 用)\n  ${p.description ?? "无说明"}\n  已填的参数:${
              Object.keys(p.params).join("、") || "(无)"
            }`,
        );
        return text(`共 ${catalog.profiles.length} 份:\n\n${lines.join("\n")}${problems}`);
      },
    },

    /* ─────────────── 写(需要用户点头)─────────────── */
    {
      name: "workflow_save",
      description:
        "**新建或整份覆盖**一份工作流 / 自动化。改已有的:先用 workflow_get 取出版本,保存时必须携带 expectedRevision；新建时不传。版本不符则拒绝覆盖并重新读取。\n" +
        // 用户在界面上点「新建」时,渲染端会**自动种一个** mcode.main 进去(`workflowEdit.ts`
        // 的 `seedMainAgent`)。AI 这条路不自动种 —— 往一份已经连好边的图里插一个节点并重新
        // 接线,正是最容易插错的活;模型自己建反而更准。所以这里只把规矩说清楚。
        "**新图的头一步必须是 `mcode.main`(主代理)** —— 它是这张图的入口,用户那句话先到它这儿。" +
        "**普通工作流一个都不能少**(存盘时会查 `graph.no-main-node`),而且只能有一个;自动化不查这条,它的入口是触发器。" +
        "界面上的「新建」会自动带一个,你造的图也请照这个形状来:主代理在最前面负责拆任务,后面每个 `mcode.agent` 只做一步。\n" +
        "坐标不用写 —— 不给 `position` 的节点会按依赖自动排好。`builtin`、`updatedAt`、边的 id 也都不用写,代码会补。\n" +
        "写之前请先想清楚**哪些步骤是隔离的**:`mcode.agent` 是**独立会话**,它只看得到你写在 `params.instruction` 里的那段话" +
        "(和上游传下来的结果),看不到别的步骤、也看不到用户在对话里说过的话 —— 所以它的指令要**自足**、也要**写窄**。" +
        "而 `mcode.main` 与 `mcode.conversation` **跑在主对话里**,那一整段聊天记录它们都看得见,指令可以写成「按刚才定的思路改第三章」这样的话。\n" +
        "不论哪种,**别让第一步就把整件事做完** —— 做完了下游就没得干。\n" +
        "存盘前会跑两道校验(图不能有环、每步的参数要符合它那个类型的要求),不通过会告诉你是哪一步、哪里不对,照着改再存一次。",
      inputSchema: { workflow: WORKFLOW_IN, expectedRevision: z.string().regex(/^[0-9a-f]{64}$/).optional() },
      handler: async (args: { workflow: Obj; expectedRevision?: string }) => {
        const normalized = await normalizeWorkflow(args.workflow ?? {});
        if (!normalized.ok) return fail(normalized.error);

        // Approval to SAVE this tool call is not consent to EXECUTE its graph
        // in the background. The pending marker is installed before the write.
        const result = await saveWorkflow(normalized.doc, {
          untrustedOrigin: "ai", expectedRevision: args.expectedRevision ?? null,
        });
        if (!result.ok) return fail(result.error);

        notifyWorkflowsChanged(`mcp:workflow_save:${normalized.doc.id}`);
        // 触发器在**后台**跑:AI 刚改完触发方式,执行器手里那份还是旧的。走
        // `reloadRequest` 那条纯函数缝 —— 原因见那个文件头(这个模块无头也会被 import
        // 并真被调用,直接 import 执行器会把 electron 拖进 `mcode-admin-smoke`)。
        requestWorkflowReload(normalized.doc.id);
        const doc = normalized.doc;
        const head =
          doc.nodes.length > 0
            ? `已保存「${doc.name}」 id=\`${doc.id}\` —— ${doc.nodes.length} 步的图。\n${shapeLine(doc)}\n` +
              "(同一层里的几步之间没有先后;分层是按依赖算的)"
            : `已保存「${doc.name}」 id=\`${doc.id}\` —— 一份提示词型工作流。`;
        const notes = normalized.notes.length > 0 ? `\n\n${normalized.notes.join("\n")}` : "";
        // 校验器的提醒(不拦存盘,但多半画错了)—— 交给模型,让它顺手改掉或向用户说明。
        const hints =
          result.warnings && result.warnings.length > 0
            ? `\n\n⚠️ 已保存,但有 ${result.warnings.length} 条提醒(不拦存盘,多半是画错了,请检查):\n` +
              result.warnings.map((w) => `- ${w}`).join("\n")
            : "";
        return text(`${head}${notes}${hints}\n\n已保存但尚未启用：请用户在 设置 → 工作流/自动化 检查当前版本并明确批准后再运行。`);
      },
    },
    {
      name: "workflow_remove",
      description:
        "删掉一份工作流 / 自动化。⚠️ 对**内置**的那几份,这等于「恢复默认」—— 用户对它的改动会没掉,内置的原始版本回来。" +
        "删之前**先跟用户确认是哪一个** —— 这是用户自己画的东西,别自作主张。",
      inputSchema: { id: z.string().describe("工作流 id,来自 workflow_list") },
      handler: async (args: { id: string }) => {
        const existing = getWorkflow(args.id);
        if (!existing) return fail(`没有 id 为 \`${args.id}\` 的工作流 (用 workflow_list 看看有哪些)`);
        removeWorkflow(args.id);
        notifyWorkflowsChanged(`mcp:workflow_remove:${args.id}`);
        // 删掉之后同理 —— 执行器读不到这一份就把它的触发器撤掉(同 IPC 那条路)。
        requestWorkflowReload(args.id);
        // 内置退役:自带的与自建的同一种删除,措辞不再分叉。
        return text(`已删掉工作流「${existing.name}」。`);
      },
    },
    {
      name: "agent_profile_save",
      description:
        "新建或覆盖一份**代理档案** —— 一组预先填好的节点参数,用户在插入节点时可以直接套用。" +
        "用户说「以后都按这套来」时用它。参数要符合**那个节点类型**的要求(必填项别空着),否则会被拒。",
      inputSchema: { profile: PROFILE_IN },
      handler: async (args: { profile: Obj }) => {
        const raw = args.profile ?? {};
        const name = str(raw.name);
        if (!name) return fail("这份档案没写 name。");
        if (name.length > 60) return fail(`name 太长了(${name.length} 字),最多 60 字。`);
        const description = str(raw.description);
        if (description.length > 200) return fail(`description 太长了(${description.length} 字),最多 200 字。`);

        const type = str(raw.type) || NODE_AGENT_TYPE_ID;
        const params = raw.params === undefined ? {} : raw.params;
        if (!isObj(params)) return fail("params 必须是一个对象(键是参数名,值就是那个参数的值)。");

        const manifest = (await loadNodeTypes()).entries.find((e) => e.id === type)?.manifest;
        if (!manifest) {
          return fail(
            `\`${type}\` 这个节点类型这台机器上没有。用 node_types_list 看看有哪些 —— 档案得挂在一个装了的类型上。`,
          );
        }
        // 档案是**参数的一份快照**,而它插进节点时不再过一遍校验(见 `@contracts/agentProfile`
        // 的 `paramsForProfile`)。在这里拦住,是因为"必填项空着的档案"要到那一步跑起来
        // 才发现,而那已经是很久以后了。界面上允许存半成品,AI 这条路不必。
        const paramsCheck = validateNodeParams(manifest, params);
        if (!paramsCheck.ok) return fail(`这份档案的参数填不了 \`${type}\` 这个类型:${paramsCheck.error}`);

        const wanted = str(raw.id);
        // 覆盖已有的那份时**保住它的 createdAt** —— 一次编辑不该把"什么时候建的"改掉。
        const existing = wanted ? readAgentProfiles().profiles.find((p) => p.id === wanted) : undefined;
        const now = Date.now();
        // ⚠️ 标注类型,不然 `version` 会被推成宽的 `number`,而 schema 要的是字面量 1。
        const profile: AgentProfile = {
          version: AGENT_PROFILE_VERSION,
          id: wanted || makeAgentProfileId(now),
          name,
          type,
          params,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          ...(description ? { description } : {}),
        };
        const result = saveAgentProfile(profile);
        if (!result.ok) return fail(result.error);

        notifyWorkflowsChanged(`mcp:agent_profile_save:${profile.id}`);
        return text(
          `已保存代理档案「${profile.name}」 id=\`${profile.id}\`(给 \`${profile.type}\` 用,预先填了 ${
            Object.keys(profile.params).length
          } 个参数)。用户在 设置 → 工作流 → 代理档案 里能看到它。`,
        );
      },
    },
    {
      name: "agent_profile_remove",
      description: "删掉一份代理档案。已经用这份档案建过的节点**不受影响**(档案只是建节点时套用的一份模板)。",
      inputSchema: { id: z.string().describe("档案 id,来自 agent_profiles_list") },
      handler: async (args: { id: string }) => {
        const existing = readAgentProfiles().profiles.find((p) => p.id === args.id);
        // 找不到也算成功(想要的结局已经在了,见 `agentProfiles.ts`),但如实说一声。
        const result = removeAgentProfile(args.id);
        if (!result.ok) return fail(result.error);
        notifyWorkflowsChanged(`mcp:agent_profile_remove:${args.id}`);
        return text(
          existing ? `已删掉代理档案「${existing.name}」。` : `档案 \`${args.id}\` 本来就不在(要的结果已经在了)。`,
        );
      },
    },
    {
      name: "node_type_write",
      description:
        "写一份**节点类型清单** —— 定义一种新的节点(画布「添加节点」菜单里会多出一项)。" +
        "用户在设置里把它写好了、让你存成类型,或者你想要一种现有的类型表达不了的节点时用它。\n" +
        "⚠️ 只能写**数据**,写不了代码:清单只声明「这个类型要填哪些参数」,**执行方式只能用现成的原语** —— " +
        "省略 `runner` 就是 `prompt`(起一个子 agent);`conversation`(跑在主对话里)、`branch`(岔路口)、`command`、`code` 也都能用。" +
        "但**自带脚本的 `command`**(填了 `entry`)能存、能画进图里,**跑不了**。要生成一个**工作流**请用 `workflow_save`,不是这个。",
      inputSchema: { manifest: MANIFEST_IN },
      handler: async (args: { manifest: Obj }) => {
        const raw = args.manifest ?? {};
        // 能推出来的先补上,再交给唯一的那个校验器 —— 补完还不对,才把它的错报回去。
        const candidate = {
          manifestVersion: NODE_MANIFEST_VERSION,
          capability: "read",
          runner: { kind: "prompt" },
          params: [],
          ...raw,
        };
        const check = validateNodeTypeManifest(candidate);
        if (!check.ok) return fail(`这份清单不合法:${check.error}`);

        const manifest = check.manifest;
        // ⚠️ 保留前缀那一条**不在校验器里**(内置类型自己就叫 `mcode.agent`),只有来源
        // 那一层知道 —— 这里是"AI 也算第三方"的那一层(同 `nodeTypes.ts` 的 `loadDir`)。
        if (manifest.id.startsWith(RESERVED_NODE_TYPE_PREFIX)) {
          return fail(`\`${RESERVED_NODE_TYPE_PREFIX}\` 是内置类型的保留前缀,自定义的类型不能用它。`);
        }

        const dir = localNodeTypesDir();
        const file = path.join(dir, `${manifest.id}.json`);
        const tmp = `${file}.tmp`;
        try {
          mkdirSync(dir, { recursive: true });
          writeFileSync(tmp, JSON.stringify(manifest, null, 2), "utf-8");
          // 先写临时文件再改名 —— 改名在同一个目录里是原子的,所以任何时刻读到的都是
          // 完整的一份(同 `agentProfiles.ts` / `hooks/store.ts` 的写盘)。
          renameSync(tmp, file);
        } catch (err) {
          return fail(`写不进 ${file}:${(err as Error).message}`);
        }

        notifyWorkflowsChanged(`mcp:node_type_write:${manifest.id}`);
        // ⚠️ **判据只有一处:`isNodeRunnable`。** 从前这里写的是
        // `manifest.runner.kind === "prompt"` —— 那是**第二份**"跑不跑得起来"的实现,而且判错:
        // `conversation`/`branch`/`command`/`code`/`condition`/`trigger`/`module-capability`
        // 都实现了、都跑得起来(见 `IMPLEMENTED_RUNNER_KINDS`),这里只认 `prompt`。于是模型
        // 写一个 `conversation` 节点类型,工具回一句"现在跑不了、只能画进图里" —— 错的,还与
        // **本工具自己的描述**矛盾(`node-types-README.md` 也白纸黑字写着"唯一函数是
        // `isNodeRunnable`…不要只看 `runner.kind` 自己判")。
        const runnable = isNodeRunnable(manifest);
        return text(
          `已写入节点类型 \`${manifest.id}\`(${manifest.params.length} 个参数)。` +
            `用户在画布的「添加节点」菜单里就能看到它了。` +
            (runnable
              ? ""
              : `\n\n⚠️ 它的执行方式是 \`${manifest.runner.kind}\`,**现在跑不了** —— 只能画进图里。`),
        );
      },
    },

    /* ── 代理之间通信 ──
     *
     * 这三个是**同一件事的三面**:名册、通知、询问。它们做的事是**在会话之间递话**,
     * 而不是沿图的边传产出(那是 `upstreamText` 那套,方向是单向的)。
     *
     * ⚠️ **这三条不进公网那张工具表**(见 `AGENT_MAIL_TOOLS` 与下面的 filter):
     * 拿到公网链接的人不该有能力叫醒本机的会话,也不该读到本机有哪些会话。
     */
    {
      name: "agent_peers",
      description:
        "列出**当前这个主对话底下**的其他代理(主对话自己 + 这个对话跑过的每一步 + 你在这儿开的子对话)。" +
        "用来知道「现在有谁」以及发给谁 —— 每条给名字和 id,`agent_notify` / `agent_ask` 的 `to` 两者都收。" +
        "**名册是现查的**:你随时新开的子代理会出现,不用重跑流程。" +
        "⚠️ 只列这个对话底下的 —— 别的对话、别的项目里的代理不在里面。",
      inputSchema: {},
      handler: async (_args: Record<string, unknown>, ctx: McpToolContext) => {
        const peers = peersOf(ctx.sessionId);
        if (peers.length === 0) {
          return text("当前没有别的代理 —— 这个对话底下只有你自己。");
        }
        const lines = peers.map((p) => {
          const where = p.kind === "node" ? "流程里的一步" : p.kind === "side" ? "子对话" : "主对话";
          const busy = p.running ? ",此刻正在跑" : "";
          return `- **${p.name}**(${where}${busy}) id=${p.id}`;
        });
        // 未答的提问**必须显式报出来** —— 否则"我问过一个问题、对方还没答"这件事在
        // 界面上没有任何痕迹,而模型会以为对方不理它。见 `undeliveredCount`。
        const waiting = undeliveredCount(ctx.sessionId);
        const tail =
          waiting > 0
            ? `\n\n⚠️ 你有 **${waiting} 条问了还没被回复**的消息。对方的答复到了会再来找你;` +
              `如果它一直不回,再问一次或者换个代理。`
            : "";
        return text(`当前这个对话底下的代理:\n\n${lines.join("\n")}${tail}`);
      },
    },
    {
      name: "agent_notify",
      description:
        "给另一个代理**捎一句话**,发完立刻返回,不等回复(要回复用 `agent_ask`)。" +
        "对方在跑就插进它当前这一轮;它空闲就存下,等它下次开口时带到。" +
        "**用它回别人的问题时带上 `re`**(那条问题给出的编号)—— 不带你那条答复就不知道回给谁。" +
        "用 `agent_peers` 拿名字或 id。",
      inputSchema: {
        to: z.string().describe("发给谁:代理的名字或 id(见 agent_peers)"),
        text: z.string().describe("要说的话"),
        re: z
          .string()
          .optional()
          .describe("**回别人的问题时带上它** —— 那是一条 agent_ask 给出的编号(ask_xxx)"),
      },
      handler: async (args: { to: string; text: string; re?: string }, ctx: McpToolContext) => {
        const self = selfPeerOf(ctx.sessionId);

        // 回信:按 `re` **精确**路由到原提问方。先验发信人、确定投递成功再销账。
        // 否则旁观代理可用编号冒充收信方，或限流拒投时把原问题永久吞掉。
        if (args.re !== undefined) {
          const ask = peekAsk(args.re.trim());
          if (ask === undefined) {
            return fail(
              `没找到编号为 ${args.re} 的提问 —— 它可能已经被回过了,或者编号抄错了。` +
                `再确认一下,别把答复发错人。`,
            );
          }
          if (ask.toSessionId !== ctx.sessionId) {
            return fail(`编号 ${ask.askId} 不是发给你的提问,不能替收信方回信。`);
          }
          const back = resolvePeer(ctx.sessionId, ask.fromSessionId);
          if (back === undefined) {
            return fail(`这条提问的提问方(${ask.fromSessionId})已经不在这个对话里了,送不回去。`);
          }
          const r = deliver(back, {
            fromName: self.name,
            fromId: self.id,
            kind: "notify",
            text: args.text,
            re: ask.askId,
          });
          if (r.outcome === "failed") return fail(r.detail);
          // 同步投递已被接受（插播/叫醒/排队），此时才销掉挂账。
          takeAsk(ask.askId);
          return text(`答复已送回给「${back.name}」。${r.detail}`);
        }

        // 普通通知:先解析目标 —— **名册之外的一律拒掉**,不做"尽力投递"。
        const peer = resolvePeer(ctx.sessionId, args.to);
        if (peer === undefined) {
          return fail(unknownPeerMessage(ctx.sessionId, args.to));
        }
        const r = deliver(peer, {
          fromName: self.name,
          fromId: self.id,
          kind: "notify",
          text: args.text,
        });
        return r.outcome === "failed" ? fail(r.detail) : text(`发给「${peer.name}」:${r.detail}`);
      },
    },
    {
      name: "agent_ask",
      description:
        "**问另一个代理一个问题**,要它回答。与 `agent_notify` 的差别只有一个:这条会记下" +
        "「我还在等它答」,并给它一个编号。" +
        "⚠️ **它不阻塞你** —— 发完你这一轮照常结束。对方的答复到了,宿主会**回头叫醒你**," +
        "把答复交给你。所以你可以一边等一边干别的,也不用担心两个代理互相等死。",
      inputSchema: {
        to: z.string().describe("问谁:代理的名字或 id(见 agent_peers)"),
        text: z.string().describe("你要问的问题"),
      },
      handler: async (args: { to: string; text: string }, ctx: McpToolContext) => {
        const self = selfPeerOf(ctx.sessionId);
        const peer = resolvePeer(ctx.sessionId, args.to);
        if (peer === undefined) {
          return fail(unknownPeerMessage(ctx.sessionId, args.to));
        }
        // **先记挂账再投递。** 反过来的话,对方回得太快(插播那条路是同步的)就有可能
        // 在挂账写下去之前先收到回信 —— 那条答复会因为查不到编号而被拒,而双方都不知道
        // 发生过什么。
        const ask = recordAsk({
          fromSessionId: ctx.sessionId,
          fromName: self.name,
          toSessionId: peer.id,
          question: args.text,
        });
        const r = deliver(peer, {
          fromName: self.name,
          fromId: self.id,
          kind: "ask",
          text: args.text,
          re: ask.askId,
        });
        if (r.outcome === "failed") {
          // 送不出去 → 把挂账撤掉,别留一条永远等不到答复的。
          takeAsk(ask.askId);
          return fail(r.detail);
        }
        return text(
          `问题已发给「${peer.name}」。${r.detail}\n` +
            `**编号 ${ask.askId}** —— 它答了之后宿主要拿这个编号把答复带给你。` +
            `你现在可以接着干别的,不用等。`,
        );
      },
    },
  ];
  // 公网那条路把「读用户对话记录」与「代理间通信」**两组**整组摘掉 —— 见上面参数说明。
  return includeSessionLogs
    ? specs
    : specs.filter((s) => !SESSION_LOG_TOOLS.has(s.name) && !AGENT_MAIL_TOOLS.has(s.name));
}

/**
 * 构建这个 MCP server。与库那个同构:惰性 import SDK(那个模块很大,不能挂在
 * 启动路径上),一次性构造,按需挂到 `options.mcpServers`。
 */
export async function buildWorkflowMcpServer(opts: { sessionId: string }) {
  const createSdkMcpServer = await loadCreateMcpServer();

  return createSdkMcpServer({
    name: WORKFLOW_MCP_SERVER,
    version: "1.0.0",
    instructions:
      "Mcode 自己的工作流那一摊的操作工具。管四样东西:\n" +
      "**工作流 / 自动化** —— 用户画的一张有向无环图,每个节点是一段指令 + 上游的结果。" +
      "**多数节点另开一段独立会话**(`mcode.agent`),互相看不见;入口节点 `mcode.main` 与 `mcode.conversation` 例外,它们跑在主对话里。\n" +
      "`workflow_list` 看有哪些、`workflow_get` 看一份的完整内容、`workflow_save` 整份存回去、`workflow_remove` 删。\n" +
      "**节点类型** —— 节点能是哪种东西(`mcode.agent` 是最常用的子 agent,另外还有主代理、对话节点、岔路口、命令、脚本)。写工作流前先 `node_types_list`。\n" +
      "**代理档案** —— 一组预先填好的节点参数,建节点时套用。\n" +
      "写操作都要用户点头才生效。动手改之前先把用户的意图问清楚 —— 那是他自己画的东西。",
    // ⚠️ **故意不写 `alwaysLoad: true`**(库里和浏览器那两个写了)。
    //
    // 那一项等于 API 上的 `defer_loading: false`,也就是"这几份工具的说明**每轮对话都
    // 重新发一遍**"。实测这套说明是 8359 字节(界面上的起手固定开销是 31k),而它们只有
    // 真要改工作流时才用得上 —— 为了一个偶尔才用一次的能力,让每次提问都多付一份,不值。
    //
    // 不写它 = **交给 CLI 的工具检索**(SDK 的注释:"Default: tools are deferred when tool
    // search is enabled"):模型的上下文里只留一行"还能检索到别的工具",真要动手时按需
    // 拉进来。所以这一行删掉不是"把功能关小",而是把它从"常驻"挪到"按需"。
    //
    // 库里/浏览器那两份仍然是常驻:它们是**每一轮都可能用到**的骨干(读一篇文献、看一眼
    // 网页),被检索挡一层反而会拖慢正常流程。判据是"用到的频率",不是"重不重要"。
    tools: toSdkTools(workflowMcpTools(), { sessionId: opts.sessionId }),
  });
}
