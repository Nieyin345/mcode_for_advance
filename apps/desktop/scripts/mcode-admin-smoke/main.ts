import { __seedSessionLogs } from "./stubs/repositories.js";
/**
 * Headless smoke for `mcode-workflow`(AI 自己改工作流那一套工具)。
 *
 * ## 验的是什么
 *
 * `main/mcp/mcodeServer.ts` 里有两段东西值得无头断言:
 *
 * 1. **归一化**(`normalizeWorkflow`)—— 模型给一份"大意",代码补成一份能存进去的文档。
 *    它有十来个分支,而每一条走错的后果都很具体:补漏了让 AI 明明写对却被拒,或者反过来
 *    让它存进一份用户看不懂的图。这一份 suite 的大头在这里。
 * 2. **存盘那两道关**(`library.ts` 的 `saveWorkflow`)—— 有环的图、必填没填的参数、
 *    配矛盾的产出约束,都要在**存的时候**被拒,而不是等到跑起来。
 *
 * ## 为什么这一层能无头跑,而 MCP 那一层不能
 *
 * `mcodeServer.ts` 的模块顶层只有 zod schema 和两个 Set —— SDK 是惰性载入的
 * (`./sdk.js`),`buildWorkflowMcpServer()` 不被调用就不会去碰它。所以这里 import
 * 整个模块是安全的。
 *
 * **没覆盖的**:审批卡**弹出来的样子**与用户点下去之后的事(那要真的起一次对话)。
 * `shouldAutoApprove` 认不认前缀、写操作要不要问,**在「记忆工具面」那一节里断言了**
 * (2026-09-22 加的;那里也解释了记忆写入侧为什么是记忆系统缺的那一半)。
 *
 * Run: scripts/mcode-admin-smoke/run.sh
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getWorkflow, importWorkflowInto, saveWorkflow } from "@main/orchestration/library.js";
import { approveWorkflowRevision, workflowReviewError, workflowReviewOf, workflowRevision } from "@main/orchestration/workflowTrust.js";
import { exportWorkflowDoc } from "@main/orchestration/workflowValidation.js";
import { backEdgesOf, forwardEdgesOf, type WorkflowDoc } from "@contracts/workflow";
import { BUILTIN_WORKFLOWS } from "@main/orchestration/builtins.js";
import { loadNodeTypes } from "@main/orchestration/nodeTypes.js";
import { composeNodePrompt, planOf } from "@main/orchestration/schedulerPrompt.js";
import { MAIN_NODE_TYPE_ID, NODE_MODEL_PARAM_KEY, NODE_PARAM_KINDS, NODE_PROVIDER_PARAM_KEY, TRIGGER_NODE_TYPE_ID } from "@contracts/nodeType";
// ⚠️ 这里**破例 import 一个渲染端的模块** —— `workflowEdit.ts` 才是"新建工作流"那条路
// 的实现,而本套件要验的恰恰是"它种出来的东西能不能过**主进程**的校验"。两半各自单测
// 都过、合起来不过,是这一层最典型的坏法(种出来的节点少一个必填参数 → 用户点「新建」
// 得到一个错误弹窗)。它可以无头跑:只依赖 contracts,不碰 React / DOM。
import {
  MAIN_DEFAULT_INSTRUCTION,
  newAutomationDoc,
  newWorkflowDoc,
  seedMainAgent,
  seedTrigger,
} from "@renderer/components/settings/workflows/workflowEdit.js";
import {
  WORKFLOW_MCP_PREFIX,
  WORKFLOW_MCP_SERVER,
  WORKFLOW_READONLY_TOOLS,
  buildWorkflowMcpServer,
  normalizeWorkflow,
  workflowMcpTools,
} from "@main/mcp/mcodeServer.js";
import { workflowEngineBridge } from "@main/mcp/workflowEngineTools.js";
import {
  buildMemoryMcpServer,
  MEMORY_MCP_SERVER,
  MEMORY_READONLY_TOOLS,
} from "@main/mcp/memoryServer.js";
import { isReadOnlyToolName, shouldAutoApprove, BROWSER_MCP_SERVER } from "@main/mcp/toolRules.js";
import { MCP_ALWAYS_ON_SERVERS, MCP_MEMORY_SERVER, MCP_RESERVED_NAME } from "@contracts/ipc";
import { __resetWorkflowRepo, WorkflowRepo } from "./stubs/repositories.js";
import { __takeBroadcasts } from "./stubs/broadcast.js";
import { COMPOSER_MODE_PROMPTS } from "@main/lib/systemPrompt.js";

let failures = 0;
let checks = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  checks += 1;
  if (cond) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

/** `eq` 用 `Object.is`,比不了数组和对象 —— 两个内容一样的 `[]` 也是"不一样"。
 *  要断言"这两个列表相等"就用这个。 */
function deepEq(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

const ROOT = process.env.MCODE_SMOKE_DATA_ROOT;
if (!ROOT) throw new Error("MCODE_SMOKE_DATA_ROOT 没设(见 run.sh)");

/** 数据根下的节点类型目录铺出来 —— 不铺的话 `loadNodeTypes` 会当成"一个都没有", */
/** 而那会把"类型认不出来"那条路上的断言变成假通过。 */
mkdirSync(join(ROOT, "workflows", "node-types"), { recursive: true });

/** 归一化成功时把文档取出来;失败就让这一条直接炸出来(说明预期写错了)。 */
async function ok(raw: Record<string, unknown>): Promise<{ doc: any; notes: string[] }> {
  const res = (await normalizeWorkflow(raw)) as any;
  if (!res.ok) throw new Error(`预期能归一化,却被拒了:${res.error}`);
  return { doc: res.doc, notes: res.notes as string[] };
}

async function rejected(raw: Record<string, unknown>): Promise<string> {
  const res = (await normalizeWorkflow(raw)) as any;
  if (res.ok) throw new Error("预期被拒,却归一化成功了");
  return res.error as string;
}

/* ── 工具面 ──
 *
 * 下面这一段走的是**真的** MCP server:把 `buildWorkflowMcpServer()` 建出来,从里面把
 * SDK 注册好的工具挖出来,直接调它们的 handler。于是"工具叫什么、收什么参数、返回什么"
 * 全都验在真东西上,而不是验在一份手抄的清单上 —— 名字打错一个字母这种事,手抄的清单
 * 是发现不了的。
 *
 * **仍然验不到的**:模型那一侧(它看不看得懂 description、会不会照着 JSON Schema 填)、
 * 以及 `canUseTool` 那条审批链路。那两样要真的跑一次对话。 */

interface RegisteredTool {
  description?: string;
  inputSchema?: unknown;
  /** SDK 往这里写 `anthropic/alwaysLoad`(写了 `alwaysLoad: true` 才有)。 */
  _meta?: Record<string, unknown>;
  handler: (args: unknown) => Promise<{ content: Array<{ type: string; text?: string }> }>;
}

/** `tools/list` 回来的那一项 —— **这就是 CLI(以及模型)看到的东西**。 */
interface ListedTool {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, any>;
    required?: string[];
  };
}

interface Surface {
  /** 按名字取工具,用来直接调 handler。 */
  tools: Map<string, RegisteredTool>;
  /** `tools/list` 的原样结果。 */
  listed: ListedTool[];
}

/**
 * 建出**真的** server,再走它自己的 `tools/list`。
 *
 * `instance._registeredTools` 与 `instance.server._requestHandlers` 都是 MCP SDK 的
 * **私有**字段 —— 用它们,是因为无头环境里只有这条路能拿到"模型到底会看到什么"。
 * 形状变了要**大声失败**:一个静默跳过的检查比没有检查更糟(它会一直绿着,直到某天
 * 真的坏了)。
 */
async function toolSurface(
  build: () => Promise<unknown> = () => buildWorkflowMcpServer({ sessionId: "smoke-session" }),
): Promise<Surface> {
  const server = await build();
  const instance = (server as unknown as { instance?: { _registeredTools?: unknown; server?: unknown } })
    .instance;
  const bucket = instance?._registeredTools;
  const handlers = (instance?.server as { _requestHandlers?: Map<string, unknown> } | undefined)
    ?._requestHandlers;
  const listFn = handlers?.get("tools/list");
  if (!bucket || typeof bucket !== "object" || typeof listFn !== "function") {
    throw new Error(
      "MCP SDK 的内部形状变了(拿不到 _registeredTools / tools/list)—— 这个 suite 需要更新",
    );
  }
  const out = (await (listFn as (r: unknown, e: unknown) => Promise<unknown>)(
    { method: "tools/list", params: {} },
    {},
  )) as { tools?: ListedTool[] };
  if (!Array.isArray(out?.tools)) throw new Error("tools/list 没有返回 tools 数组");
  return {
    tools: new Map(Object.entries(bucket as Record<string, RegisteredTool>)),
    listed: out.tools,
  };
}

/** 取一个工具在 `tools/list` 里的 JSON Schema,一层层往下走。走空了就抛。 */
function schemaAt(listed: ListedTool[], name: string, ...path: string[]): any {
  const tool = listed.find((t) => t.name === name);
  if (!tool) throw new Error(`tools/list 里没有 ${name}`);
  let node: any = tool.inputSchema;
  for (const step of path) {
    node = node?.properties?.[step] ?? node?.items?.properties?.[step] ?? node?.[step];
    if (node === undefined) throw new Error(`${name} 的 schema 里没有 ${path.join(".")} 这一段`);
  }
  return node;
}

/** 调一个工具,把返回的文本拼起来。**失败也走正常结果**(见 mcp/sdk.ts 的 `fail`)。 */
async function call(tools: Map<string, RegisteredTool>, name: string, args: unknown): Promise<string> {
  const tool = tools.get(name);
  if (!tool) throw new Error(`没有这个工具:${name}`);
  const res = await tool.handler(args);
  return res.content.map((c) => c.text ?? "").join("\n");
}

/**
 * 一份最简的图:`n1(主节点) → n2(子 agent)`。**故意不给坐标** —— 那是这条路上最常走的一步。
 *
 * ⚠️ 开头必须是**主节点**(`mcode.main`):工作流必须有且只有一个主节点 —— 它是用户
 * 对话的入口(2026-09-18 产品裁定,见 `workflowValidation.ts` 的 `graph.no-main-node`)。
 * 从前这里两个节点都是 `mcode.agent`,保存闸门不收。
 */
function twoStep(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "查文献然后总结",
    nodes: [
      { id: "n1", type: "mcode.main", params: { instruction: "查" } },
      { id: "n2", type: "mcode.agent", params: { instruction: "总结" } },
    ],
    edges: [{ from: "n1", to: "n2" }],
    ...extra,
  };
}

async function main(): Promise<void> {
  console.log("\n归一化 · 名字");
  check("没写 name → 拒", (await rejected({ nodes: [] })).includes("name"));
  eq("name 两头空白去掉", (await ok({ name: "  写作  " })).doc.name, "写作");
  check("name 超过 60 字 → 拒", (await rejected({ name: "字".repeat(61) })).includes("太长"));
  check(
    "description 超过 200 字 → 拒",
    (await rejected({ name: "x", description: "字".repeat(201) })).includes("太长"),
  );

  console.log("\n归一化 · id 与 builtin");
  const fresh = await ok(twoStep());
  check("没给 id → 生成一个 wf_ 开头的", fresh.doc.id.startsWith("wf_"), fresh.doc.id);
  eq("自建的 builtin=false", fresh.doc.builtin, false);
  const builtin = await ok(twoStep({ id: "default" }));
  eq("写自带 id → builtin 也是 false(内置退役,恒 false)", builtin.doc.builtin, false);
  check(
    "但仍提醒模型它在覆盖软件自带的那一份",
    builtin.notes.join(" ").includes("自带"),
    builtin.notes,
  );

  console.log("\n归一化 · 节点");
  // 开头放主节点(工作流的硬约束),后面两个才是这条用例要看的"没给 id/标题"的节点。
  const bare = await ok({
    name: "不给 id 和标题",
    nodes: [
      { type: "mcode.main" },
      { type: "mcode.agent", params: {} },
      { type: "mcode.agent" },
    ],
  });
  check("两个节点各自拿到 id", bare.doc.nodes[1].id !== bare.doc.nodes[2].id);
  check("id 是 n_ 开头的", bare.doc.nodes[1].id.startsWith("n_"));
  eq("没给标题 → 退回类型名", bare.doc.nodes[1].title, "子 agent");
  check("params 省略 → 空对象", Object.keys(bare.doc.nodes[2].params).length === 0);

  // ⚠️ **标题超 80 字是截断,必须明说** —— 静默截断会让"用户看到的标题"和"模型以为
  // 写进去的标题"不是一回事,而 schema 的 80 上限又要求它不能原样存。
  const longTitle = "题".repeat(120);
  const truncated = await ok(twoStep({ nodes: [
    { id: "n1", type: "mcode.main", params: { instruction: "查" } },
    { id: "n2", type: "mcode.agent", params: { instruction: "总结" }, title: longTitle },
  ] }));
  eq("超长标题被截到 80 字", (truncated.doc.nodes[1].title as string).length, 80);
  check(
    "…并且通知里明说了截断(不静默)",
    truncated.notes.join(" ").includes("80"),
    truncated.notes,
  );
  // 反向:标题没超长时**不能**冒出一条截断提示(否则每条都报,提示等于噪声)。
  const exact80 = await ok(twoStep({ nodes: [
    { id: "n1", type: "mcode.main", params: { instruction: "查" } },
    { id: "n2", type: "mcode.agent", params: { instruction: "总结" }, title: "题".repeat(80) },
  ] }));
  check("刚好 80 字的标题不报截断", !exact80.notes.join(" ").includes("截"), exact80.notes);

  check(
    "两个节点用同一个 id → 拒",
    (await rejected(twoStep({ nodes: [{ id: "n1", type: "mcode.agent" }, { id: "n1", type: "mcode.agent" }] }))).includes(
      "同一个 id",
    ),
  );
  check(
    "节点没写 type → 拒,并指出是第几个",
    (await rejected(twoStep({ nodes: [{ id: "n1" }] }))).includes("nodes[0]"),
  );
  check(
    "nodes 不是数组 → 拒",
    (await rejected(twoStep({ nodes: "n1,n2" }))).includes("nodes 必须是一个数组"),
  );
  check(
    "params 不是对象 → 拒",
    (await rejected(twoStep({ nodes: [{ id: "n1", type: "mcode.agent", params: "查" }] }))).includes("params"),
  );

  console.log("\n归一化 · 认不出来的类型不算错");
  const unknown = await ok({
    name: "别人分享来的图",
    nodes: [{ id: "n1", type: "someone.else", params: {} }],
  });
  eq("图照样存得下", unknown.doc.nodes.length, 1);
  eq("标题退回类型 id", unknown.doc.nodes[0].title, "someone.else");
  check(
    "但要说清楚那一步跑不了",
    unknown.notes.join(" ").includes("跑不了"),
    unknown.notes,
  );

  console.log("\n归一化 · 边");
  const deduped = await ok(
    twoStep({
      edges: [
        { from: "n1", to: "n2" },
        { from: "n1", to: "n2" },
      ],
    }),
  );
  eq("同一条依赖写两遍 → 去重成一条", deduped.doc.edges.length, 1);
  check("边的 id 自动生成", String(deduped.doc.edges[0].id).startsWith("e_"));
  check("边少了 to → 拒", (await rejected(twoStep({ edges: [{ from: "n1" }] }))).includes("from 或 to"));

  // 边指向不存在的节点**不在这里拦** —— 那是 `validateDag` 的活,见下面"存盘"那一节。
  const dangling = await ok(twoStep({ edges: [{ from: "n1", to: "n9" }] }));
  eq("归一化不拦悬空的边(留给 validateDag)", dangling.doc.edges.length, 1);

  console.log("\n归一化 · 没给坐标就按依赖排");
  // 真菱形:n1 分叉到 n2 / n3,再汇到 n4。
  const diamond = await ok({
    name: "并行三步",
    nodes: [
      { id: "n1", type: "mcode.main" },
      { id: "n2", type: "mcode.agent" },
      { id: "n3", type: "mcode.agent" },
      { id: "n4", type: "mcode.agent" },
    ],
    edges: [
      { from: "n1", to: "n2" },
      { from: "n1", to: "n3" },
      { from: "n2", to: "n4" },
      { from: "n3", to: "n4" },
    ],
  });
  const at = (id: string) => diamond.doc.nodes.find((n: any) => n.id === id).position;
  eq("根在最上一行", at("n1").y, 0);
  check("并行的那两步同一行", at("n2").y === at("n3").y && at("n2").y > 0, [at("n2"), at("n3")]);
  check("同一行的左右错开", at("n2").x !== at("n3").x);
  check("汇总在最后一行", at("n4").y > at("n2").y, at("n4"));

  const given = await ok(twoStep());
  const pinned = await ok({
    ...twoStep(),
    nodes: [
      { id: "n1", type: "mcode.main", position: { x: 999, y: 888 } },
      { id: "n2", type: "mcode.agent", position: { x: 777, y: 666 } },
    ],
  });
  eq("全都给了坐标 → 原样保留", pinned.doc.nodes[0].position.x, 999);
  check("而且不重排", pinned.doc.nodes[1].position.y === 666);
  eq("(对照)没给坐标的那份是排过的", given.doc.nodes[0].position.x, 0);

  const mixed = await ok({
    ...twoStep(),
    nodes: [
      { id: "n1", type: "mcode.main", position: { x: 999, y: 888 } },
      { id: "n2", type: "mcode.agent" },
    ],
  });
  eq("半张有坐标 → 整张重排", mixed.doc.nodes[0].position.x, 0);

  // 半成品坐标(只给了一个、或者给了字符串)**当成没给** —— 留着一半会让那个节点钉在
  // 原点、还躲过整张图的重排,而它在画布上就是叠在别人身上。
  const halfGiven = await ok({
    ...twoStep(),
    nodes: [
      { id: "n1", type: "mcode.main", position: { x: 999, y: 888 } },
      { id: "n2", type: "mcode.agent", position: { x: "5" } },
    ],
  });
  eq("坐标给了半个 → 也没算数,整张重排", halfGiven.doc.nodes[0].position.x, 0);

  console.log("\n归一化 · 提示词型 / 自动化");
  const promptOnly = await ok({ name: "写作流程", prompt: "先列提纲,再写。" });
  eq("没有节点 = 提示词型", promptOnly.doc.nodes.length, 0);
  eq("正文原样带过去", promptOnly.doc.prompt, "先列提纲,再写。");
  const auto = await ok(twoStep({ trigger: "schedule" }));
  eq("给了 trigger → 它是一条自动化", auto.doc.trigger, "schedule");
  eq("没给 trigger 的那份没有这个字段", "trigger" in fresh.doc, false);
  check(
    "trigger 拼错 → 拒(交给 schema 说)",
    (await rejected(twoStep({ trigger: "every-monday" }))).includes("格式不对"),
  );
  check(
    "capability 拼错 → 拒",
    (await rejected({ name: "x", nodes: [{ id: "n1", type: "mcode.agent", capability: "readWrite" }] })).includes(
      "格式不对",
    ),
  );

  console.log("\n存盘 · 两道关真的在");
  __resetWorkflowRepo();
  const good = await ok(twoStep());
  const saved = await saveWorkflow(good.doc);
  check("一份正常的图存得下", saved.ok, saved);
  // 内置退役:第一次走到库那一层时自带工作流会播种进表(BUILTIN_WORKFLOWS 全量),
  // 所以这里是"播种行 + 刚存的这一行"。
  eq("表里真的多了一行(播种行之外)", WorkflowRepo.list().length, BUILTIN_WORKFLOWS.length + 1);

  const cyclic = await ok(
    twoStep({
      nodes: [
        { id: "n1", type: "mcode.main", params: { instruction: "查" } },
        { id: "n2", type: "mcode.agent", params: { instruction: "总结" } },
      ],
      edges: [
        { from: "n1", to: "n2" },
        { from: "n2", to: "n1" },
      ],
    }),
  );
  const cyclicRes = await saveWorkflow(cyclic.doc);
  check("有环的图 → 拒", !cyclicRes.ok);
  check("而且说得出是环", !cyclicRes.ok && cyclicRes.error.includes("环"), cyclicRes);

  // **环上有岔路口就不是坏图** —— 那是"再改一轮"那种画法(见 `@contracts/workflow`
  // 的「回头」)。闸门意味着绕一圈至少要有用户点一下,所以它停得下来。
  const gated = await ok(
    twoStep({
      nodes: [
        { id: "n1", type: "mcode.main", params: { instruction: "写" } },
        { id: "n2", type: "mcode.branch", params: {} },
      ],
      edges: [
        { from: "n1", to: "n2" },
        { from: "n2", to: "n1" },
      ],
    }),
  );
  const gatedRes = await saveWorkflow(gated.doc);
  check("环上有岔路口 → 存得下", gatedRes.ok, gatedRes);

  // ★ **闸门必须在`这个`环上。** 图里另有一个岔路口、和这一圈没关系的话,绕这一圈
  //   可以一次都不经过它 —— 那就还是个没人拦着的死循环。这一条是"退一步就错"的那个
  //   退法:把判据写成"图里有没有分支"的话,它会放行,而用户画出的是一个永远转下去的环。
  const offCycle = await ok(
    twoStep({
      nodes: [
        { id: "n1", type: "mcode.main", params: { instruction: "写" } },
        { id: "n2", type: "mcode.agent", params: { instruction: "改" } },
        { id: "n3", type: "mcode.branch", params: {} },
      ],
      edges: [
        { from: "n1", to: "n2" },
        { from: "n2", to: "n1" },
        { from: "n2", to: "n3" },
      ],
    }),
  );
  const offRes = await saveWorkflow(offCycle.doc);
  check("★ 岔路口在环外 → 还是拒", !offRes.ok, offRes);
  check("而且说的是环,不是别的", !offRes.ok && offRes.error.includes("环"), offRes);

  const danglingRes = await saveWorkflow((await ok(twoStep({ edges: [{ from: "n9", to: "n2" }] }))).doc);
  check("边指向不存在的节点 → 拒", !danglingRes.ok);
  check(
    "错误里带上那个 id",
    !danglingRes.ok && danglingRes.error.includes("n9"),
    danglingRes,
  );

  const emptyInstruction = await saveWorkflow(
    (await ok({ name: "少填了指令", nodes: [{ id: "n1", type: "mcode.main", params: {} }] })).doc,
  );
  check("必填的指令空着 → 拒", !emptyInstruction.ok);
  check(
    "错误里说的是人话(参数的中文名)",
    !emptyInstruction.ok && emptyInstruction.error.includes("指令"),
    emptyInstruction,
  );

  const badVars = await saveWorkflow(
    (
      await ok({
        name: "产出变量没填示例",
        nodes: [
          {
            id: "n1",
            type: "mcode.main",
            params: { instruction: "查", outputVars: [{ name: "年份", example: "" }] },
          },
        ],
      })
    ).doc,
  );
  check("产出变量没填示例 → 拒", !badVars.ok);
  check("错误里说得清是哪一条", !badVars.ok && badVars.error.includes("示例"), badVars);

  console.log("\n导入 / 导出(WF-08)");
  // 这一段的重点是**两条路共用同一道闸门**:导入能进来的东西,必须是当初存得下去的。
  // 所以断言分三组 —— 文本进来得对、名字与 id 定得对、坏东西整份被拒且库里一个字节没变。
  __resetWorkflowRepo();

  const source = await ok(twoStep({ name: "文献综述" }));
  check("打底:源文档存得下", (await saveWorkflow(source.doc)).ok);
  const exported = exportWorkflowDoc(source.doc);
  check("导出的是合法 JSON", (() => {
    try {
      JSON.parse(exported);
      return true;
    } catch {
      return false;
    }
  })());
  check("导出带上 schemaVersion", JSON.parse(exported).schemaVersion !== undefined);
  // 缩进两格 —— 导出的东西是给人读、给人 diff 的(见 `exportWorkflowDoc` 的注释)。
  check("导出是人读得懂的缩进", exported.includes("\n  "));

  const freshImport = await importWorkflowInto(exported);
  check("导入一份新的 → 成功", freshImport.ok, freshImport);
  check(
    "新 id 不是原来那个(新建,不是覆盖)",
    freshImport.ok && freshImport.id !== source.doc.id,
    freshImport,
  );
  check(
    "外面那份的名字被保留(重名才加后缀)",
    freshImport.ok && freshImport.name === "文献综述 2",
    freshImport,
  );
  check("新建之后库里多了一行", WorkflowRepo.list().length === 2, WorkflowRepo.list().map((r) => r.id));

  const imported = freshImport.ok ? getWorkflow(freshImport.id) : null;
  check("导入能保存,却不能自动取得执行权限", imported !== null && workflowReviewOf(imported)?.pending === true);
  if (imported !== null) {
    const revision = workflowRevision(imported);
    check("待审查图禁止执行", workflowReviewError(imported)?.includes("尚未审查") === true);
    check("审批过期版本不能放行", !approveWorkflowRevision(imported, "0".repeat(64)).ok);
    eq("过期审批后仍待审查", workflowReviewOf(imported)?.pending, true);
    check("用户审查确切版本后才允许执行", approveWorkflowRevision(imported, revision).ok);
    eq("批准后的图不再被执行闸门拦住", workflowReviewError(imported), null);
    // Cosmetic edits do not change execution, while any instruction change
    // invalidates that approval even when the workflow id stays the same.
    eq("挪动画布不会作废审批", workflowRevision({ ...imported, nodes: imported.nodes.map((n) => ({ ...n, position: { x: 99, y: 12 } })) }), revision);
    const edited = { ...imported, description: "这份现在做的事变了" };
    check("同 id 修改执行相关内容必须重审", workflowReviewError(edited)?.includes("尚未审查") === true);
  }

  // 覆盖:原样导回来的那份**回到原来那一行**,不是新建。
  const overwrite = await importWorkflowInto(exported, { id: source.doc.id });
  check("带 id 导入 → 覆盖那一行", overwrite.ok && overwrite.id === source.doc.id, overwrite);
  check(
    "覆盖时名字不会变成「文献综述 2」(重名要绕开的是别人)",
    overwrite.ok && overwrite.name === "文献综述",
    overwrite,
  );
  check("覆盖不新增行", WorkflowRepo.list().length === 2, WorkflowRepo.list().map((r) => r.id));

  // **给一个不存在的 id 必须报错**,不能悄悄新建 —— 界面上那条路叫「覆盖当前工作流」,
  // 静默造出一份新的会让用户以为他覆盖的是原来那一份。
  const ghost = await importWorkflowInto(exported, { id: "wf_nope" });
  check("覆盖一个不存在的 id → 拒", !ghost.ok, ghost);
  check("而且说得清是「没有这一份」", !ghost.ok && ghost.errors[0]!.includes("wf_nope"), ghost);

  const before = WorkflowRepo.list().length;
  const badJson = await importWorkflowInto("{ 这不是 JSON");
  check("不是 JSON → 拒", !badJson.ok, badJson);
  const badShape = await importWorkflowInto(JSON.stringify({ name: "" }));
  check("形状不对(name 空)→ 拒", !badShape.ok, badShape);
  const badVersion = await importWorkflowInto(
    JSON.stringify({ ...JSON.parse(exported), schemaVersion: 999 }),
  );
  check("schemaVersion 不认识 → 拒", !badVersion.ok, badVersion);
  const danglingEdge = await importWorkflowInto(
    JSON.stringify({
      ...JSON.parse(exported),
      edges: [{ from: "n1", to: "n9" }],
    }),
  );
  check("悬空的边 → 拒(和存盘同一道闸门)", !danglingEdge.ok, danglingEdge);
  check("被拒之后库里一行都没变", WorkflowRepo.list().length === before, {
    before,
    after: WorkflowRepo.list().length,
  });

  // **类型认不出来只是 warning**(`saveWorkflow` 那一档是 `unknownTypeSeverity: "warning"`)——
  // 别人分享来的图引用了没装的节点类型是常态,那种图照样收得下,只是跑不了。
  const foreignDoc = JSON.parse(exported);
  foreignDoc.nodes[1].type = "acme.没装过的类型";
  const foreign = await importWorkflowInto(JSON.stringify(foreignDoc));
  check("引用了没装的节点类型 → 照样收下(只记 warning)", foreign.ok, foreign);

  console.log("\n存盘 · 由 MCP 写的那份要走同一个落点");
  // `normalizeWorkflow` 出来的文档**就是** `saveWorkflow` 的入参类型 —— 中间没有第二份
  // 转换。这一条钉住它:拿归一化的产物直接存,校验器认。
  const fromModel = await ok({
    name: "AI 建的四步",
    description: "先规划,再两条并行,最后汇总",
    nodes: [
      { id: "plan", type: "mcode.main", title: "规划", params: { instruction: "拆成几步" } },
      { id: "search", type: "mcode.agent", title: "查文献", params: { instruction: "按规划查" } },
      { id: "calc", type: "mcode.agent", title: "算数据", params: { instruction: "按规划算" } },
      { id: "sum", type: "mcode.agent", title: "汇总", params: { instruction: "把两边合起来" } },
    ],
    edges: [
      { from: "plan", to: "search" },
      { from: "plan", to: "calc" },
      { from: "search", to: "sum" },
      { from: "calc", to: "sum" },
    ],
  });
  const four = await saveWorkflow(fromModel.doc);
  check("四步的图存得下", four.ok, four);
  check("那四步的图没被补过什么", fromModel.notes.length === 0, fromModel.notes);

  console.log("\n岔路口:选项住在出边上 —— 跨层也不能掉");
  // 分支节点的选项**就是它的出边**,名字和说明挂在边上的 `label` / `note`
  // (见 `@contracts/workflow` 的 `WorkflowEdgeSchema`)。
  //
  // 这两个字段要穿过四层:模型写的 JSON → MCP 的归一化器(**重建**每一条边)→ zod
  // → 存盘。任何一层漏掉,AI 画出来的岔路口在界面上就是一排**没有名字的按钮**
  // (全回落成"通向某某"),而模型明明写对了 —— 那是"看着没错、用着不对"的坏法,
  // 而且只在真的点下去的时候才看得出来。
  const forkDoc = await ok({
    name: "写作流程",
    nodes: [
      { id: "main", type: "mcode.main", title: "主对话", params: { instruction: "写作" } },
      { id: "f", type: "mcode.branch", title: "下一步做什么" },
      { id: "again", type: "mcode.agent", title: "写作②", params: { instruction: "再改一轮" } },
      { id: "check", type: "mcode.agent", title: "查重", params: { instruction: "查重" } },
    ],
    edges: [
      { from: "main", to: "f" },
      { from: "f", to: "again", label: "再来一轮", note: "在现有稿子上改。" },
      { from: "f", to: "check", label: "进查重" },
    ],
  });
  // 边索引:0 是 main→f(主节点到岔路口),岔路口的两条出边是 1、2。
  eq("选项名穿过了归一化器", forkDoc.doc.edges[1]?.label, "再来一轮");
  eq("说明也穿过了", forkDoc.doc.edges[1]?.note, "在现有稿子上改。");
  eq("没写说明的那条就没有这个键", forkDoc.doc.edges[2]?.note, undefined);
  const forkSaved = await saveWorkflow(forkDoc.doc);
  check("带岔路口的图存得下", forkSaved.ok, forkSaved);
  const forkBack = getWorkflow(forkDoc.doc.id);
  eq("读回来选项名还在", forkBack?.edges[1]?.label, "再来一轮");
  eq("说明也在", forkBack?.edges[1]?.note, "在现有稿子上改。");
  // 别的边上不该被顺手写上这两个字段 —— 它们只对**分支节点的出边**有意义。
  check("普通依赖上没被塞东西", (forkBack?.edges[2]?.note ?? undefined) === undefined);

  console.log("\n新建工作流:种下的主代理要真能存进去(跨层)");
  // 用户点「新建工作流」时,渲染端拿**这份内置清单**种一个主代理,然后走 `saveWorkflow`
  // 落盘。这条断言把两半接起来跑一遍 —— 种出来的节点参数是齐的、图能存、不报错。
  {
    const entries = (await loadNodeTypes()).entries;
    const mainEntry = entries.find((e) => e.id === MAIN_NODE_TYPE_ID);
    check("内置清单里有主代理", mainEntry !== undefined, entries.map((e) => e.id));
    eq("它是内置的(不是插件带来的)", mainEntry?.source, "builtin");
    check(
      "指令是必填的(所以种下去时必须带上它)",
      mainEntry?.manifest.params.some((p) => p.key === "instruction" && p.required === true) === true,
      mainEntry?.manifest.params,
    );
    // ⚠️ **「输入选项」(`kind: "options"`)整套机制已删**(2026-09-19)。它和「固定
    // 条件」是同一个位置上的两套东西,后者就是它多一个解释字段的版本 —— 两个并排只会
    // 让用户理解成两种能力。参数种类从契约里移除了,断言钉住这件事:哪天它被顺手加
    // 回来(参数种类复活、或清单里又出现这个 kind),这两条会红。
    check(
      "参数种类清单里没有「输入选项」了",
      !(NODE_PARAM_KINDS as readonly string[]).includes("options"),
      NODE_PARAM_KINDS,
    );
    check(
      "主代理的参数里也没有它",
      mainEntry?.manifest.params.every((p) => (p.kind as string) !== "options") === true,
      mainEntry?.manifest.params,
    );
    const agentEntry = entries.find((e) => e.id === "mcode.agent");
    check(
      "子 agent 也没有(它从来就没带过)",
      agentEntry?.manifest.params.every((p) => (p.kind as string) !== "options") === true,
    );
    // **「引擎」必须排在「模型」前面,而且模型要声明 `fromParam`。** 两件事缺一不可:
    // 渲染端照**已经渲染过的**参数算候选(见 `NodeParamSpecSchema.fromParam`),顺序
    // 反了就永远读到"还没选",列出来的还是全部模型 —— 现象正是用户报的「模型和引擎
    // 重合了」。这条断言把顺序也一起钉住。
    {
      const params = agentEntry?.manifest.params ?? [];
      const at = (key: string): number => params.findIndex((p) => p.key === key);
      check(
        "子 agent 的参数里有「引擎」和「模型」",
        at(NODE_PROVIDER_PARAM_KEY) >= 0 && at(NODE_MODEL_PARAM_KEY) >= 0,
        params.map((p) => p.key),
      );
      check(
        "「引擎」排在「模型」前面",
        at(NODE_PROVIDER_PARAM_KEY) < at(NODE_MODEL_PARAM_KEY),
        params.map((p) => p.key),
      );
      check(
        "「模型」的候选跟着「引擎」走(fromParam 指对了)",
        params[at(NODE_MODEL_PARAM_KEY)]?.fromParam === NODE_PROVIDER_PARAM_KEY,
        params[at(NODE_MODEL_PARAM_KEY)],
      );
    }
    // 固定条件(`kind: "selects"`)同样是主代理**独有**的参数:输入框上方那排下拉框
    // 的条目表(接过文献检索写死的筛选条)。声明在这里,聊天那头(`SearchFilterBar`)
    // 才有东西可渲染、注入那头(`searchPrefs.ts`)才有东西可注。
    check(
      "主代理带「固定条件」参数",
      mainEntry?.manifest.params.some((p) => p.kind === "selects") === true,
      mainEntry?.manifest.params,
    );
    check(
      "子 agent 也不带它",
      agentEntry?.manifest.params.some((p) => p.kind === "selects") === false,
    );
    // 内置检索图的主节点**预填**了那四条条件 —— 这是"定义搬进节点"的落点:界面上的
    // 下拉框、注入提示词的内容,都从这份预填数据来。候选值里混进非字符串,渲染端和
    // 注入端都会一起瞎。
    const searchDoc = BUILTIN_WORKFLOWS.find((w) => w.id === "search");
    const searchCriteria = searchDoc?.nodes
      .find((n) => n.type === MAIN_NODE_TYPE_ID)
      ?.params["criteria"];
    check(
      "内置检索图的主节点预填了条件表",
      Array.isArray(searchCriteria) && searchCriteria.length >= 4,
      searchCriteria,
    );
    check(
      "预填的每条都是「条件名 + 非空候选值」",
      Array.isArray(searchCriteria) &&
        searchCriteria.every(
          (item) =>
            typeof item === "object" &&
            item !== null &&
            typeof (item as { name?: unknown }).name === "string" &&
            (item as { name: string }).name !== "" &&
            Array.isArray((item as { choices?: unknown }).choices) &&
            (item as { choices: unknown[] }).choices.length > 0 &&
            (item as { choices: unknown[] }).choices.every((c) => typeof c === "string" && c !== ""),
        ),
    );
    if (mainEntry) {
      const seeded = seedMainAgent(newWorkflowDoc("wf_seed", "种出来的"), mainEntry.manifest);
      eq("种出一个节点", seeded.nodes.length, 1);
      const res = await saveWorkflow(seeded);
      check("它**过得了存盘校验**(必填项齐全)", res.ok, res);

      // **单节点时那两句话必须能在同一段提示词里化解掉。** 框架那边看这张图只有一步,
      // 说的是"用户的那件事只有一步,就是你现在做的这个";而种下去的指令如果只说
      // "别自己动手,后面那几步是留给下游的",两句话就挨着打架 —— 用户点「新建」直接
      // 发消息正是这个场景。种子指令的最后一句就是留给这种时候的兜底,而它在不在,
      // 只有把两半拼起来才看得出来(各自单测都过)。
      const first = seeded.nodes[0];
      if (first) {
        const single = composeNodePrompt({
          userPrompt: "帮我做个计划",
          upstream: "",
          instruction: String(first.params.instruction ?? ""),
          nodeId: first.id,
          plan: planOf(seeded, (id) => seeded.nodes.find((n) => n.id === id)?.title ?? id),
        });
        check("单节点:框架说的是「只有一步」", single.includes("只有一步"), single);
        check("单节点:指令留了兜底,不打架", single.includes("整个归你做"), single);
      }

      // 自动化走同一个视图、同一个构造器,只多一个 trigger —— 也要种。
      // **触发器必须种上**:保存闸门(`graph.no-trigger-node`)会拒绝一份没有触发器的
      // 自动化,而 2026-09-18 的产品裁定要求"新建自动化自带触发器"(见 `seedTrigger`)。
      const triggerEntry = entries.find((e) => e.id === TRIGGER_NODE_TYPE_ID);
      check("内置清单里有触发器", triggerEntry !== undefined, entries.map((e) => e.id));
      const autoBase = seedMainAgent(newAutomationDoc("wf_seed_auto", "种出来的自动化"), mainEntry.manifest);
      const auto = triggerEntry ? seedTrigger(autoBase, triggerEntry.manifest, "p_lt") : autoBase;
      const autoSave = await saveWorkflow(auto);
      check("自动化也一样", autoSave.ok, autoSave);
      eq("而且它仍然是一条自动化", auto.trigger, "manual");
      check(
        "新建的自动化自带触发器",
        auto.nodes.some((n) => n.type === TRIGGER_NODE_TYPE_ID),
        auto.nodes.map((n) => n.type),
      );
    }
  }

  console.log("\n参数说明要短(它是悬停浮窗里的一段,不是文档)");
  // 用户原话:「每一个功能下面的解释太长了……简短的一两句就行了,现在都是一段话,6 行了都」。
  //
  // 这条盯的是**长度上界**,因为"说明写长了"没有任何报错:加一个参数时顺手多写两句,
  // 一年之后那个面板上就又全是六行的段落,把真正的控件挤到屏幕外。道理该写在
  // `node-types-README.md` 里 —— 那里才是给想弄明白的人读的地方。
  //
  // 上界从 60 放到 80(2026-09-18):说明**不再印在控件下面**了,改成标题右边一个小
  // 图标、停住一秒才浮出来的小浮窗(`ParamField` 的 `HelpHint`,用户要求「解释隐藏起来」)。
  // 那个浮窗宽 280px、正文 11px ≈ 一行 23 个汉字,80 字≈三行半 —— 仍然拦得住"一段话
  // 写六行",但不再逼着把话说一半。压到 60 字会把「读流程记录」那种"开了之后读到的到底是
  // 什么"的必要限定砍掉,那就不是简洁,是说得不清楚了。
  {
    const MAX = 80;
    // 参数面板宽 ~320px;浮窗宽 280px、说明字号 ~11px → 一行约 23 个汉字,80 字≈三行半。
    const tooLong: string[] = [];
    const missing: string[] = [];
    for (const entry of (await loadNodeTypes()).entries) {
      // 只管内置的:插件带来的清单是别人写的,长短不归这个仓库管。
      if (entry.source !== "builtin") continue;
      for (const spec of entry.manifest.params) {
        const help = spec.help ?? "";
        if (help.trim().length === 0) missing.push(`${entry.id}/${spec.key}`);
        else if (help.length > MAX) tooLong.push(`${entry.id}/${spec.key}(${help.length}字)`);
      }
    }
    check(`内置参数的说明都在 ${MAX} 字以内`, tooLong.length === 0, tooLong);
    // **空着也是错的**:说明是"这个参数干什么"唯一的去处,漏了就只剩一个光秃秃的标签。
    check("每个内置参数都有说明", missing.length === 0, missing);
  }

  console.log("\n内置工作流:改成图的那两个");
  // 文献检索与文献写作是**随应用发布**的图。它们出问题的样子很特别:用户什么都没做错,
  // 一点「新建对话」就撞上「节点类型没有安装」/「参数是必填的」—— 而那是代码里写死的
  // 一份文档,没有任何用户操作能触发它、也就没有任何人会先发现。所以在这里逐张过一遍
  // 存盘那两道关(类型在不在 / 参数齐不齐 / 无环 / 无悬空边)。
  {
    const byId = new Map(BUILTIN_WORKFLOWS.map((w) => [w.id, w]));
    const typeIds = new Set((await loadNodeTypes()).entries.map((e) => e.id));

    for (const id of ["search", "write"]) {
      const doc = byId.get(id);
      check(`内置的 ${id} 还在`, doc !== undefined, [...byId.keys()]);
      if (!doc) continue;
      check(`${id} 是图型(有节点)`, doc.nodes.length > 0, doc.nodes.length);
      // **不留第二份正文** —— 图型的流程文字在节点的指令里,`prompt` 再留一段就是
      // 一份没人读的旧流程,而"到底哪份在跑"从此说不清。
      eq(`${id} 没有 prompt`, doc.prompt, undefined);
      deepEq(
        `${id}:引用的类型都装了`,
        doc.nodes.filter((n) => !typeIds.has(n.type)).map((n) => n.type),
        [],
      );
      check(`${id} 过得了存盘校验`, (await saveWorkflow(doc)).ok, await saveWorkflow(doc));
      // **每一步都写了「做到什么程度算完成」。** 模型靠它判断自己能不能收工 ——
      // 少了它,它容易做一半就停下,而下游拿到的是个半成品(现象是"这步看着挺像回事,
      // 下一步却没法用")。
      //
      // 它是**约定**而不是字段(见 `node-types-README.md` 的「写指令的时候」),所以
      // 没有任何类型系统盯着它 —— 只能在这儿钉一条。改动内置指令时删掉了那一句,
      // 这条会红。
      deepEq(
        `${id}:每一步都写了「做完的样子」`,
        doc.nodes
          .filter((n) => n.type !== "mcode.branch")
          .filter((n) => !String(n.params.instruction ?? "").includes("做完的样子"))
          .map((n) => n.title),
        [],
      );
      // 坐标不能叠在一起 —— 内置的那份是 `autoLayout` 现算的,算错了用户打开看到的
      // 是一坨卡片,而这没有任何功能测试会红。
      eq(
        `${id}:节点没有叠在一起`,
        new Set(doc.nodes.map((n) => `${n.position.x},${n.position.y}`)).size,
        doc.nodes.length,
      );
    }

    // ── 文献写作那个岔路口 ──
    const write = byId.get("write");
    const fork = write?.nodes.find((n) => n.type === "mcode.branch");
    check("写作流程里有一个岔路口", fork !== undefined, write?.nodes.map((n) => n.type));
    const exits = write && fork ? write.edges.filter((e) => e.from === fork.id) : [];
    eq("两条出路", exits.length, 2);
    check("两条都起了名字", exits.every((e) => (e.label ?? "").length > 0), exits.map((e) => e.label));
    check("两条都写了给下一步的说明", exits.every((e) => (e.note ?? "").length > 0), exits.map((e) => e.note));

    // **出路后面那一步,它的"来路"只能有那个岔路口。**
    //
    // 这不是风格问题:再连一条别的上游(哪怕只是想让它"看得见稿子"),**那条边是活的**,
    // 于是不管用户选哪条路这一步都会照跑 —— 岔路口就白设了。稿子靠分支**透传**过去
    // (见调度器 `chooseOne` 那段),不需要额外连线。
    //
    // ⚠️ **回边不算"来路"**(见 `@contracts/workflow` 的「回头」):它从环的出口指回入口,
    // 不参与就绪判断(调度器走 `buildForwardAdjacency`)。「再改一轮」指回「成稿」之后,
    // 「成稿」身上就多了一条来自岔路口的入边 —— 那是这个设计**要的**,不是这里要拦的。
    if (write && fork) {
      const live = new Set(forwardEdgesOf(write.nodes, write.edges).map((e) => e.id));
      const bad = exits
        .map((e) => e.to)
        .filter((to) => write.edges.filter((x) => x.to === to && live.has(x.id)).length !== 1)
        .map((to) => write.nodes.find((n) => n.id === to)?.title ?? to);
      deepEq("★ 出路后面那一步的来路只有岔路口(回边不算)", bad, []);
    }

    // ── 回头:写作流程靠它迭代(用户原话「这样就能不断迭代」) ──
    if (write) {
      const back = backEdgesOf(write.nodes, write.edges);
      eq("★ 写作流程有一条回边", back.length, 1);
      const only = back[0];
      const isGate = (id: string): boolean => write.nodes.find((n) => n.id === id)?.type === "mcode.branch";
      check(
        "★ 回边从岔路口指回去(所以绕一圈必须用户点一下)",
        only !== undefined && isGate(only.edge.from),
        only?.edge,
      );
      // 这一条是"存得下"的**判据本身**:环上有没有闸门。上面那张 `write` 已经过了
      // `saveWorkflow`,这里把"为什么它能过"钉住 —— 不然哪天闸门挪出环外,那条断言
      // 只会红一次,而没人知道它在测什么。
      check("环上有岔路口(所以它才存得下)", only !== undefined && only.cycle.some(isGate), only?.cycle);
      check(
        "回边指回的是「成稿」",
        write.nodes.find((n) => n.id === only?.edge.to)?.title === "成稿",
        only?.edge.to,
      );
    }
  }

  console.log("\n内置工作流:守望模板(起跑通道)");
  // 「长任务守望」不进上面那张循环,因为它的存盘契约不一样:**触发器的「项目」故意
  // 是空的** —— startWatch 起跑时按发起会话补上(见 `automationRunner` 的
  // `startWatch`)。模板里写死哪个项目,守望就只会落在那儿,而它的意义恰恰是
  // "这一回绑哪个会话就落哪"。所以这里验的是**起跑通道**:模板长什么样、起跑补上
  // 项目之后过不过得了存盘那两道关 —— 不过的话,点「开始守望」的第一下就会报错,
  // 而那是这个功能唯一的入口。
  {
    const byId = new Map(BUILTIN_WORKFLOWS.map((w) => [w.id, w]));
    const typeIds = new Set((await loadNodeTypes()).entries.map((e) => e.id));
    const watch = byId.get("watch");
    check("内置的 watch 还在", watch !== undefined, [...byId.keys()]);
    if (watch) {
      check("watch 是图型(有节点)", watch.nodes.length > 0, watch.nodes.length);
      eq("watch 没有 prompt(它不进对话模式下拉)", watch.prompt, undefined);
      deepEq(
        "watch:引用的类型都装了",
        watch.nodes.filter((n) => !typeIds.has(n.type)).map((n) => n.type),
        [],
      );
      const trigger = watch.nodes.find((n) => n.type === "mcode.trigger");
      const command = watch.nodes.find((n) => n.type === "mcode.command");
      const conversation = watch.nodes.find((n) => n.type === "mcode.conversation");
      check(
        "三步齐全:触发器 → 命令 → 对话",
        trigger !== undefined && command !== undefined && conversation !== undefined,
        watch.nodes.map((n) => n.type),
      );
      eq("触发器是手动", trigger?.params["triggerKind"], "manual");
      eq("触发器的项目留空(起跑时补)", trigger?.params["project"], "");
      check(
        "命令写死在参数里",
        typeof command?.params["command"] === "string" &&
          (command.params["command"] as string).length > 0,
        command?.params,
      );
      eq("命令不限时(0 = 不限)", command?.params["timeoutMs"], 0);
      eq("对话节点是发完即走", conversation?.params["injectMode"], "auto");
      eq("对话节点注回发起会话", conversation?.params["injectTarget"], "origin");

      // **起跑通道**:startWatch 把发起会话的项目写进触发器参数再存盘(命令/说明
      // 同理,给了才写)。这一步必须过得了存盘校验 —— task 模板里已带默认值,所以
      // 只补 project。
      const patched: WorkflowDoc = {
        ...watch,
        nodes: watch.nodes.map((n) =>
          n.type === "mcode.trigger"
            ? { ...n, params: { ...n.params, project: "prj_smoke" } }
            : n,
        ),
      };
      check("补上项目后过得了存盘校验", (await saveWorkflow(patched)).ok, await saveWorkflow(patched));
    }
  }

  console.log("\n提示词里的「完成判据」");
  // **每一段会送到模型面前的流程文字,末尾都要有一句「做到什么程度算完成」。**
  //
  // 用户的原话:「节点指令里没有『做到什么程度算完成』—— 只有『要交哪几样』」。少了
  // 那一句,模型容易做一半就收工,而下游拿到的是个半成品 —— 这个坏法不报错,只是结果
  // 差一截,所以没有任何功能测试会红。
  //
  // 它同样是**约定**不是字段(没有类型系统盯着),四处的措辞也刻意统一成两种说法:
  // 图型节点的指令里是 `**做完的样子**`(内置图那一头在上面钉着),提示词型的三个
  // 模式与种下去的主代理指令里是 `**完成的样子**` / `**做完的样子**`。这里两样都认,
  // 因为它们在拼出来的提示词里位置不同,统一的只是"有这一句"。
  {
    const hasDoneCriterion = (text: string): boolean =>
      text.includes("完成的样子") || text.includes("做完的样子");
    deepEq(
      "提示词型的每个模式都写了一句完成判据",
      Object.entries(COMPOSER_MODE_PROMPTS)
        .filter(([, text]) => !hasDoneCriterion(text))
        .map(([id]) => id),
      [],
    );
    check(
      "种下去的主代理指令也写了",
      hasDoneCriterion(MAIN_DEFAULT_INSTRUCTION),
      MAIN_DEFAULT_INSTRUCTION,
    );
  }

  console.log("\n工具面 · 模型到底会看到哪些工具");
  // 把**真的** server 建出来(惰性载入的 SDK 到这里才被 import),再走它自己的
  // `tools/list` —— 建得出来本身就是一条断言:任何一个 `inputSchema` 让 SDK 转不成
  // JSON Schema,`buildWorkflowMcpServer()` 就会在这里抛 —— 而它在生产里是**每一轮
  // 对话**都要走的一步,抛一次就是整个会话起不来。
  const surface = await toolSurface();
  const { tools } = surface;
  const names = surface.listed.map((t) => t.name).sort();
  const EXPECTED = [
    // 2026-09-25 加：代理之间通信（名册 / 通知 / 询问）—— 与上面那些同一张表
    // （`workflowMcpTools()`）。
    "agent_ask",
    "agent_notify",
    "agent_peers",
    "agent_profile_remove",
    "agent_profile_save",
    "agent_profiles_list",
    "node_type_write",
    "node_types_list",
    // 2026-09-24 加：列用户的对话（id + 标题 + 所属项目），与 session_read_log 配套。
    "session_list",
    "session_read_log",
    "workflow_get",
    "workflow_list",
    "workflow_remove",
    "workflow_save",
  ];
  eq("工具就是这十四个", names.join(","), EXPECTED.join(","));
  check(
    "每个工具都有说明(模型只能靠它知道什么时候用)",
    surface.listed.every((t) => (t.description ?? "").length > 20),
  );
  check(
    "每个工具的入参都转成了 JSON Schema 的 object",
    surface.listed.every((t) => t.inputSchema?.type === "object"),
    surface.listed.map((t) => [t.name, t.inputSchema?.type]),
  );

  // ⚠️ 这一段是**安全**断言,不是完整性断言:只读集里混进一个写工具,那个写工具就会在
  // `shouldAutoApprove` 里被自动放行(`ClaudeAgentSdkProvider.ts`);反过来(只读工具忘了
  // 加进去)只是多弹一次审批,不危险。所以两个方向都要对齐**真实注册的工具名** —— 名字
  // 打错一个字母,只读集里就多出一个永远不生效的条目,而写工具照旧弹审批。
  const WRITE = [
    "workflow_save",
    "workflow_remove",
    "agent_profile_save",
    "agent_profile_remove",
    "node_type_write",
    // 代理间通信里**有副作用**的那两个：它们会叫醒另一个会话、让它真的去动文件。
    // 所以它们必须弹审批 —— 那正是用户「看得见、能拦下」的落点。
    "agent_notify",
    "agent_ask",
  ];
  /**
   * **读、但要审批**那一档（2026-09-24 新增）。
   *
   * `session_list` 读的是**用户的对话记录**（不是"用户自己配的东西"），所以它虽然
   * 只读，**不能**进自动放行集 —— 放行它等于让模型不经批准就能枚举用户所有的对话。
   * 与 `session_read_log` 不同：那条要用户先给出 id，"给 id"本身就是授权；列全表没有
   * 这个前提。详见 `mcodeServer.ts` 里 `WORKFLOW_READONLY_TOOLS` 那段。
   */
  const APPROVAL_GATED_READ = ["session_list"];
  for (const read of ["workflow_list", "workflow_get", "node_types_list", "agent_profiles_list"]) {
    check(`只读集里有 ${read}`, WORKFLOW_READONLY_TOOLS.has(read));
  }
  for (const w of WRITE) check(`写工具 ${w} 不在只读集里`, !WORKFLOW_READONLY_TOOLS.has(w));
  for (const r of APPROVAL_GATED_READ) {
    check(`「读但要审批」的 ${r} 不在自动放行集里`, !WORKFLOW_READONLY_TOOLS.has(r));
  }
  eq("只读集就是那六个,不多不少", WORKFLOW_READONLY_TOOLS.size, 6);
  // 这条是上一句真正想要的东西:**每一个真实存在的工具都被分过档**。新加一个工具忘了
  // 归类,它会落进"要审批"那一侧(安全的默认),而这条断言会当场说出来。
  const unclassified = names.filter(
    (n) =>
      !WORKFLOW_READONLY_TOOLS.has(n) &&
      !WRITE.includes(n) &&
      !APPROVAL_GATED_READ.includes(n),
  );
  eq("没有漏归类的工具", unclassified.join(","), "");
  eq("server 名", WORKFLOW_MCP_SERVER, "mcode-workflow");
  eq("前缀是 SDK 认的那个形状", WORKFLOW_MCP_PREFIX, "mcp__mcode-workflow__");

  console.log("\n工具面 · 模型拿到的那份 schema");
  // 上面那句"每个工具都转成了 object"只说明**外层**对。模型真正要照着填的是 `nodes`
  // 里每一项的形状,以及那几个"值不是标量"的参数 —— 那几处是 zod 里最可能转歪的
  // (`z.record` / 联合类型 / 嵌套数组),而转歪了**不会有任何报错**:模型只会看见一个
  // 不收参数的 schema,然后把 `nodes` 拍平到顶层,存进去时才发现不对。
  eq("workflow_save 只收一个 workflow", Object.keys(schemaAt(surface.listed, "workflow_save", "workflow").properties).join(","), "id,name,description,prompt,trigger,nodes,edges");
  check(
    "workflow 里必填的是 name",
    JSON.stringify(schemaAt(surface.listed, "workflow_save", "workflow").required) === '["name"]',
    schemaAt(surface.listed, "workflow_save", "workflow").required,
  );
  // 一路往下:`workflow.nodes[]` → 它的 `type` / `params` / `position`。
  eq("nodes 是一串节点", schemaAt(surface.listed, "workflow_save", "workflow", "nodes").type, "array");
  eq("节点有 type", schemaAt(surface.listed, "workflow_save", "workflow", "nodes", "type").type, "string");
  check(
    "节点的 type 有中文说明(模型得知道那是类型 id)",
    String(schemaAt(surface.listed, "workflow_save", "workflow", "nodes", "type").description ?? "").includes("node_types_list"),
  );
  // `params` 是个自由袋子:`z.record(string, unknown)` 必须转成 `additionalProperties`,
  // 转成 `{}` 之类的空壳会让模型以为这里填不了东西。
  const paramsSchema = schemaAt(surface.listed, "workflow_save", "workflow", "nodes", "params");
  eq("节点的 params 是个自由对象", paramsSchema.type, "object");
  check("而且认任意键", "additionalProperties" in paramsSchema, paramsSchema);
  eq("edges 是一串", schemaAt(surface.listed, "workflow_save", "workflow", "edges").type, "array");
  eq("边有 from", schemaAt(surface.listed, "workflow_save", "workflow", "edges", "from").type, "string");
  // 这一串是 `WorkflowDoc.trigger` 的候选值 —— 它现在是个**开关**(值从触发器节点反推,
  // 见 `library.ts` 的 `deriveTrigger`),所以"哪几种"这件事在契约里仍然要完整。
  // `webhook` 留着是为了**老文档读得回来**:它这一版不接(没有对外的 HTTP 入口),
  // 新写的自动化选不到它(见 `@contracts/nodeType` 的 `TRIGGER_KINDS`)。
  eq(
    "trigger 的候选值就是那五个",
    schemaAt(surface.listed, "workflow_save", "workflow", "trigger").enum.join(","),
    "manual,schedule,file,event,webhook",
  );
  eq("capability 的候选值就是那四个", schemaAt(surface.listed, "workflow_save", "workflow", "nodes", "capability").enum.join(","), "read,write,exec,net");

  // node_type_write 的 `params` 是一串**参数定义**(嵌套对象数组,而且 `NodeParamSpecSchema`
  // 里带条件形状)—— 最容易转歪的一份。
  eq("清单里的 params 是一串参数定义", schemaAt(surface.listed, "node_type_write", "manifest", "params").type, "array");
  eq("参数定义有 key", schemaAt(surface.listed, "node_type_write", "manifest", "params", "key").type, "string");
  check(
    "参数的种类是封闭枚举",
    Array.isArray(schemaAt(surface.listed, "node_type_write", "manifest", "params", "kind").enum),
    schemaAt(surface.listed, "node_type_write", "manifest", "params", "kind"),
  );
  eq("agent_profile_save 只收一个 profile", Object.keys(schemaAt(surface.listed, "agent_profile_save", "profile").properties).join(","), "id,name,description,type,params");
  // 读工具**真的不收参数**:声明了没有的参数,模型会试着编一个填进去。
  eq("workflow_list 不收参数", Object.keys(surface.listed.find((t) => t.name === "workflow_list")?.inputSchema?.properties ?? {}).length, 0);
  eq("node_types_list 不收参数", Object.keys(surface.listed.find((t) => t.name === "node_types_list")?.inputSchema?.properties ?? {}).length, 0);
  eq("agent_profiles_list 不收参数", Object.keys(surface.listed.find((t) => t.name === "agent_profiles_list")?.inputSchema?.properties ?? {}).length, 0);
  eq("workflow_get 要一个 id", Object.keys(surface.listed.find((t) => t.name === "workflow_get")?.inputSchema?.properties ?? {}).join(","), "id");

  // ⚠️ **这一条是花钱的**:这几份 description 每轮对话都会重发(server 是 `alwaysLoad`),
  // 所以工具面的大小是**常驻**的 token 开销,不是"用到才算"。这个项目对 token 很敏感
  // (`mcode-token-economics`),而"给工具写一段更好的说明"和"每轮多烧几 k"是同一件事的
  // 两面 —— 有个上限摆在这里,下次往里塞说明时至少会停下来想一想。
  const payload = JSON.stringify(surface.listed).length;
  console.log(`  (工具面 ${payload} 字节 —— 常驻的话每轮对话都要重发一次)`);
  check("工具面的说明别失控(每个工具平均 2KB 以内)", payload < EXPECTED.length * 2048, payload);

  // ⚠️ **这一条钉的是一个明确的产品决定:这套工具的说明不进每轮的上下文。**
  // SDK 的 `alwaysLoad: true` 等于 API 上的 `defer_loading: false`,也就是"每轮都重发
  // 这几份说明";不写它才是默认(交给 CLI 的工具检索按需拉)。库里和浏览器那两个是
  // **每轮都可能用到**的骨干,所以它们仍然常驻 —— 这一条只管 mcode-workflow。
  // 谁要是哪天顺手把它加回来,成本不会报错、不会崩,只会每次提问都多烧几 k。
  const forced = [...tools.entries()].filter(([, t]) => t._meta?.["anthropic/alwaysLoad"] !== undefined);
  eq("这几个工具都没有被强制常驻(anthropic/alwaysLoad 不在)", forced.map(([n]) => n).join(","), "");

  console.log("\n工具面 · 读工具真的读得出东西");
  __resetWorkflowRepo();
  __takeBroadcasts();
  const savedId = "wf_smoke1";
  const saveOut = await call(tools, "workflow_save", { workflow: twoStep({ name: "查完再总结", id: savedId }) });
  check("存成功时说的是人话(不是 JSON)", saveOut.includes("已保存"), saveOut);
  check("顺带把图的形状回给模型", saveOut.includes("第 1 层"), saveOut);
  check("而且告诉它用户在哪儿能看到", saveOut.includes("设置"), saveOut);
  check("AI 保存不等于启用", saveOut.includes("尚未启用") && workflowReviewOf(getWorkflow(savedId)!)?.pending === true);
  eq("AI 保存记录来源", workflowReviewOf(getWorkflow(savedId)!)?.origin, "ai");
  const reasons = __takeBroadcasts();
  eq("存成功就广播一次", reasons.length, 1);
  check(
    "广播里带上 id(界面据此重拉)",
    (reasons[0] ?? "").includes(savedId),
    reasons,
  );

  const listOut = await call(tools, "workflow_list", {});
  check("workflow_list 列出刚存的那份", listOut.includes("查完再总结"), listOut);
  // (自带行的播种在上面「存盘·两道关」那段已验过:表里 = 播种行 + 新存的一行。
  //  这一段跑在 __resetWorkflowRepo 之后,而播种是**进程内一次性**的,不会重播 ——
  //  删掉的不复活,靠的正是这个;所以这里只有刚存的那份。)
  check("不再标「内置/自建」(那种标注误导模型\"这份删不得\")", !listOut.includes("用户自建"), listOut);

  const getOut = await call(tools, "workflow_get", { id: savedId });
  check("workflow_get 拿得到完整文档", getOut.includes(savedId) && getOut.includes("nodes"), getOut);
  check(
    "取不存在的 id → 失败信息里给指路",
    (await call(tools, "workflow_get", { id: "wf_nope" })).includes("workflow_list"),
  );

  const typesOut = await call(tools, "node_types_list", {});
  check("node_types_list 列出内置那个类型", typesOut.includes("mcode.agent"), typesOut);
  check("并说清参数怎么填", typesOut.includes("instruction(longtext,必填)"), typesOut);
  check("也提醒引用型拿不准就留空", typesOut.includes("留空"), typesOut);
  // 子 agent 与主代理能挂的东西**不止技能** —— MCP 服务器与插件是同一张参数表里的
  // 两个引用型参数。这一条同时盯住两件事:内置清单里真的加了它们,而且目录里写出了
  // 值的形状(候选在用户机器上,模型看不见那份表,不写它只能猜,猜错就是一次存盘失败)。
  check("MCP 服务器也在参数表里", typesOut.includes("mcp(ref:string[])"), typesOut);
  check("插件也在参数表里", typesOut.includes("plugins(ref:string[])"), typesOut);
  // 「对话节点」是**在主对话里跑**的那一种(见 `runner.kind === "conversation"`)。
  // 它得出现在给模型看的目录里,否则 AI 替用户改工作流时根本不知道有这种东西 ——
  // 而它的用法恰恰最难猜(参数表里只有指令,别的全跟着主对话走)。
  check("目录里有对话节点", typesOut.includes("mcode.conversation"), typesOut);
  check("而且说清了它只有指令一个参数", typesOut.includes("instruction(longtext,必填)"), typesOut);

  console.log("\n工具面 · 写工具真的写得进去");
  // 内置退役:自带工作流在首次读取时播种进表,行数断言一律相对这个基数。
  const rowsBeforeCyclic = WorkflowRepo.list().length;
  const cyclicOut = await call(tools, "workflow_save", {
    workflow: {
      name: "有环的图",
      nodes: [{ id: "n1", type: "mcode.agent", params: {} }, { id: "n2", type: "mcode.agent", params: {} }],
      edges: [
        { from: "n1", to: "n2" },
        { from: "n2", to: "n1" },
      ],
    },
  });
  check("有环 → 失败信息而不是抛异常", cyclicOut.startsWith("失败:"), cyclicOut);
  eq("而且没广播(存失败还广播,界面会白重拉一次)", __takeBroadcasts().length, 0);
  eq("表里也没多出东西", WorkflowRepo.list().length, rowsBeforeCyclic);

  const removeOut = await call(tools, "workflow_remove", { id: savedId });
  check("workflow_remove 说得清删了什么", removeOut.includes("已删掉"), removeOut);
  eq("删完广播一次", __takeBroadcasts().length, 1);
  eq("刚存的那行没了(自带的播种行还在)", WorkflowRepo.list().length, rowsBeforeCyclic - 1);
  // 内置退役:自带的与自建的走同一条 removeWorkflow、同一种「已删掉」措辞 ——
  // 上面 removeOut 那两条断言已经盖住(代码里只剩一条删除路径,没有第二种措辞可
  // 分叉)。这一段原本删 `default` 验「恢复成默认」的措辞,那个语义已不存在;此处
  // repo 又在 __resetWorkflowRepo 之后(播种进程内一次性,不重播),表里本来就没有
  // 自带行可删。

  const typeOut = await call(tools, "node_type_write", {
    manifest: {
      id: "demo.summarize",
      name: "摘要",
      description: "把一个文件压成摘要。",
      params: [{ key: "path", kind: "file", label: "文件", required: true }],
    },
  });
  check("node_type_write 写进去了", typeOut.includes("已写入"), typeOut);
  // ★ "跑不跑得起来"的判据只有一处(`isNodeRunnable`)。从前这里写的是
  //   `runner.kind === "prompt"`,于是模型写一个 `conversation`/`command` 类型的节点会被
  //   错误告知"现在跑不了、只能画进图里" —— 与本工具自己的描述矛盾,且是错的。
  const convOut = await call(tools, "node_type_write", {
    manifest: {
      id: "demo.chatty", name: "对话节点", description: "跑一轮对话。",
      runner: { kind: "conversation" },
      params: [{ key: "text", kind: "longtext", label: "提示", required: true }],
    },
  });
  check("★ 写了 conversation 型节点不谎报「跑不了」(isNodeRunnable 认它)", !convOut.includes("跑不了"), convOut);
  // 顺带断言判据与该工具的**唯一权威**一致:`isNodeRunnable`。目前每个合法 runner.kind
  // 都实现了,所以"跑不了"那一支对合法清单**走不到** —— 这条把"判据 == isNodeRunnable"
  // 这件事钉在源码层(有人加了个新 kind 却没进 IMPLEMENTED_RUNNER_KINDS 时,这一致性仍在)。
  {
    const src = readFileSync("src/main/mcp/mcodeServer.ts", "utf8");
    check("★ node_type_write 的 runnable 判据用 isNodeRunnable(不是 kind === \"prompt\")", /const runnable = isNodeRunnable\(manifest\)/.test(src), "");
  }
  const afterWrite = await call(tools, "node_types_list", {});
  check("写完立刻能在列表里看到", afterWrite.includes("demo.summarize"), afterWrite);
  check(
    "保留前缀不能用",
    (await call(tools, "node_type_write", { manifest: { id: "mcode.mine", name: "偷内置的" } })).includes("保留前缀"),
  );
  check(
    "清单不合法 → 失败信息指向具体字段",
    (await call(tools, "node_type_write", { manifest: { id: "没有点号", name: "x" } })).startsWith("失败:"),
  );

  const profileOut = await call(tools, "agent_profile_save", {
    profile: { name: "读论文的", description: "只读,不写盘", params: { instruction: "只读并总结", skills: ["pdf"] } },
  });
  check("agent_profile_save 存下了", profileOut.includes("已保存代理档案"), profileOut);
  const profilesOut = await call(tools, "agent_profiles_list", {});
  check("agent_profiles_list 列得出来", profilesOut.includes("读论文的"), profilesOut);
  check("并说明它预先填了哪些参数", profilesOut.includes("instruction"), profilesOut);
  check(
    "必填项空着的档案 → 拒(插进节点才发现就太晚了)",
    (await call(tools, "agent_profile_save", { profile: { name: "空的", params: {} } })).includes("指令"),
  );
  const profileId = /id=`([^`]+)`/.exec(profileOut)?.[1] ?? "";
  check("档案 id 解得出来", profileId.startsWith("p_"), profileOut);
  check("agent_profile_remove 删得掉", (await call(tools, "agent_profile_remove", { id: profileId })).includes("已删掉"));
  check("删不存在的 → 也算成功,但如实说", (await call(tools, "agent_profile_remove", { id: "p_nope" })).includes("本来就不在"));

  /* ── 记忆 server(mcode-memory)—— 记忆系统的**写入侧** ──
   *
   * 记忆从前只有存储 + 注入两半,**写入口一直是空的**:`saveMemoryFile` 只有渲染端
   * 面板在调,于是"记什么"全靠用户手打,而没人会这么干 —— 记忆库永远是空的,注入的
   * 那段快照永远是空串,整套机制等于不存在。这一段钉住模型那一侧**真有工具**,
   * 以及分档对不对(写工具不能被自动放行 —— 那是安全边界)。
   */
  console.log("\n记忆工具面 · 模型能不能记东西");
  __seedSessionLogs({ sessions: [{ id: "admin-smoke", projectId: "p_memory", title: "Memory", archived: false, updatedAt: 1 }] });
  const memSurface = await toolSurface(() => buildMemoryMcpServer({ sessionId: "admin-smoke", context: {
    emit() {}, log: { info() {}, warn() {}, error() {} }, requestApproval: async () => ({ allow: true }),
  } }));
  const memNames = memSurface.listed.map((t) => t.name).sort();
  // 建得出来 + `tools/list` 出得来,本身就是断言:任何 schema 转不成 JSON Schema,
  // 这一步就抛 —— 而它在生产里**每一轮对话**都要走(见 ClaudeAgentSdkProvider 里
  // 那份 Promise.all),抛一次整个会话起不来。
  eq("记忆工具就是那五个", memNames.join(","), "memory_forget,memory_list,memory_read,memory_search,memory_write");
  check(
    "每个记忆工具都有说明",
    memSurface.listed.every((t) => (t.description ?? "").length > 20),
    memSurface.listed.map((t) => [t.name, (t.description ?? "").length]),
  );
  // ⚠️ 安全断言:`memory_write` / `memory_forget` 混进只读集就会被**自动放行**。
  //    反过来(读工具忘了加)只多弹一次审批,不危险 —— 所以这一个方向最要紧。
  check("只读集里有 memory_list", MEMORY_READONLY_TOOLS.has("memory_list"));
  check("只读集里有 memory_search", MEMORY_READONLY_TOOLS.has("memory_search"));
  check("只读集里有 memory_read", MEMORY_READONLY_TOOLS.has("memory_read"));
  check("★ memory_write 不在只读集里", !MEMORY_READONLY_TOOLS.has("memory_write"));
  check("★ memory_forget 不在只读集里", !MEMORY_READONLY_TOOLS.has("memory_forget"));
  // 每一个真实存在的工具都被分过档(新加工具忘了归类,会落进"要审批"那一侧 ——
  // 安全的默认,而这条会当场说出来)
  const MEM_WRITE = ["memory_write", "memory_forget"];
  eq(
    "没有漏归类的记忆工具",
    memNames.filter((n) => !MEMORY_READONLY_TOOLS.has(n) && !MEM_WRITE.includes(n)).join(","),
    "",
  );
  eq("记忆 server 名", MEMORY_MCP_SERVER, "mcode-memory");
  // 两条通路的名字形状都要认(见 toolRules 文件头:claude 带前缀、网页是裸名)
  check("闸门按裸名认得出记忆的读工具", isReadOnlyToolName("memory_search"));
  check("闸门不把 memory_write 当只读(裸名)", !isReadOnlyToolName("memory_write"));
  check("闸门按前缀认得出记忆的读工具", shouldAutoApprove("default", `mcp__${MEMORY_MCP_SERVER}__memory_list`));
  check("★ 带前缀的 memory_write 在 default 档要问", !shouldAutoApprove("default", `mcp__${MEMORY_MCP_SERVER}__memory_write`));
  check(
    "★ 带前缀的 memory_write 在 acceptEdits 档仍要问(它不是文件编辑工具)",
    !shouldAutoApprove("acceptEdits", `mcp__${MEMORY_MCP_SERVER}__memory_write`),
  );
  // dontAsk 是**更严**的档,不是放行档 —— SDK 的定义是「不弹审批,未经预先批准的直接拒」。
  // 从前这里和工具闸门都把它当无条件放行(与 appControl/tools.ts 的理解相反),写工具
  // 会在用户以为"更保守"的模式下悄悄跑起来。只读工具不受影响(它们本来就不问)。
  check("[dontAsk] 读工具仍然放行", shouldAutoApprove("dontAsk", `mcp__${MEMORY_MCP_SERVER}__memory_list`));
  check("★ [dontAsk] 写工具必须拒绝(而不是无条件放行)", !shouldAutoApprove("dontAsk", `mcp__${MEMORY_MCP_SERVER}__memory_write`));
  check("★ [dontAsk] 文件编辑工具必须拒绝(它不是 acceptEdits)", !shouldAutoApprove("dontAsk", "Edit"));
  // 骨干 server 名要进"始终挂着、不进候选表"那一组 —— 否则工作流节点的「MCP 服务器」
  // 参数会把记忆工具列成"用户装的东西",选了却不生效。
  check("记忆 server 归在骨干那一组", (MCP_ALWAYS_ON_SERVERS as readonly string[]).includes(MCP_MEMORY_SERVER));

  // 内置浏览器 server 名**只有一份**:闸门(用户不许占用保留名)与实际注册的 server
  // 必须是同一个字符串。从前 `toolRules.BROWSER_MCP_SERVER` 与契约 `MCP_RESERVED_NAME`
  // 各写一份字面量 —— 改名时漏一处就"闸门拦的名字 ≠ 实际注册的名字",静默失效。
  eq("★ 内置浏览器 server 名与保留名是同一个(不再两处字面量)", BROWSER_MCP_SERVER, MCP_RESERVED_NAME);

  // 写一条再读回来 —— 证明这个工具面**真能落盘**(不是只有个壳)
  const written = await call(memSurface.tools, "memory_write", {
    category: "rules",
    title: "烟测规则",
    content: "这条是冒烟测试写下的。",
  });
  check("memory_write 说已记下", written.includes("已记下"), written);
  const readBack = await call(memSurface.tools, "memory_read", { path: "projects/p_memory/rules/烟测规则.md" });
  check("memory_read 读得回刚写的那条", readBack.includes("冒烟测试写下的"), readBack);
  const searched = await call(memSurface.tools, "memory_search", { query: "冒烟" });
  check("memory_search 搜得到", searched.includes("烟测规则"), searched);

  // 命中落在长正文深处时，MCP 最终文本也必须把命中附近带回来；只测 retrieval 层不够，
  // 因为模型真正看到的是这里 handler 格式化后的字符串。
  await call(memSurface.tools, "memory_write", {
    category: "experiences",
    title: "长文尾部命中",
    content: "x".repeat(900) + " deep_mcp_tail_keyword",
  });
  const deepSearched = await call(memSurface.tools, "memory_search", { query: "deep_mcp_tail_keyword" });
  check(
    "memory_search 的 MCP 输出包含深处命中关键词",
    deepSearched.includes("长文尾部命中") && deepSearched.includes("deep_mcp_tail_keyword"),
    deepSearched,
  );
  check("MCP 深处命中预览明确标出前文被截断", deepSearched.includes("前文已截断"), deepSearched);

  const forgotten = await call(memSurface.tools, "memory_forget", { path: "projects/p_memory/rules/烟测规则.md", expectedRevision: /revision: ([a-f0-9]{64})/.exec(readBack)?.[1] });
  check("memory_forget 删得掉", forgotten.includes("已删掉"), forgotten);
  const deniedSurface = await toolSurface(() => buildMemoryMcpServer({ sessionId: "admin-smoke" }));
  check("真实 SDK 记忆写入缺审批桥也拒绝", (await call(deniedSurface.tools, "memory_write", { category: "rules", title: "denied", content: "never write" })).includes("审批不可用"));
  const unknownSurface = await toolSurface(() => buildMemoryMcpServer({ sessionId: "unknown-session" }));
  check("真实 SDK 工具无法借匿名会话读库", (await call(unknownSurface.tools, "memory_list", {})).includes("拒绝访问"));

  /* ── 工作流工具桥到 Pi / Codex(2026-09-30)──
   * 原来这一套只挂在 Claude 上;现在经 `workflowEngineBridge` 注册到 Pi(registerTool)与
   * Codex(动态工具)。验:工具表同源、只读清单同源、zod 校验、审批语义、两个引擎确实接上。 */
  console.log("\n— 工作流工具桥(Pi / Codex)—");
  {
    const names = workflowEngineBridge.descriptors().map((d) => d.name).sort();
    deepEq("桥的工具表与 workflowMcpTools() 同一份", names, workflowMcpTools().map((s) => s.name).sort());
    check("桥里有代理通信与对话记录工具", ["agent_peers", "agent_notify", "agent_ask", "session_read_log", "session_list"].every((n) => names.includes(n)), names);
    check("每个描述符的 schema 都是 object", workflowEngineBridge.descriptors().every((d) => d.inputSchema.type === "object"));
    check("只读判定与 WORKFLOW_READONLY_TOOLS 一致", names.every((n) => workflowEngineBridge.isReadonly(n) === WORKFLOW_READONLY_TOOLS.has(n)));
    check("agent_ask / workflow_save 不算只读", !workflowEngineBridge.isReadonly("agent_ask") && !workflowEngineBridge.isReadonly("workflow_save"));
    check("has() 认得工作流工具、不认别家", workflowEngineBridge.has("workflow_list") && !workflowEngineBridge.has("library_search") && !workflowEngineBridge.has("read"));

    const listed = await workflowEngineBridge.invoke("workflow_list", {}, "admin-smoke");
    check("invoke workflow_list 能跑", !listed.isError, listed);
    const unknown = await workflowEngineBridge.invoke("workflow_bogus", {}, "admin-smoke");
    check("未知工具名 → 报错", unknown.isError === true && JSON.stringify(unknown).includes("未知工作流工具"), unknown);
    const badArgs = await workflowEngineBridge.invoke("workflow_get", { id: 42 }, "admin-smoke");
    check("入参过 zod:类型不对 → 报错而不是进 handler", badArgs.isError === true, badArgs);

    const asked: string[] = [];
    const ctxOf = (allow: boolean | null): any => ({
      requestApproval: allow === null ? undefined : async (r: { toolName: string }) => {
        asked.push(r.toolName);
        return { allow };
      },
    });
    const noBridge = await workflowEngineBridge.invokeGated("workflow_remove", { id: "wf_never" }, "admin-smoke", ctxOf(null), { autoApprove: false });
    check("写操作 + 没有审批通道 → 拒绝", noBridge.isError === true && JSON.stringify(noBridge).includes("审批通道不可用"), noBridge);
    const denied = await workflowEngineBridge.invokeGated("workflow_remove", { id: "wf_never" }, "admin-smoke", ctxOf(false), { autoApprove: false });
    check("写操作 + 用户拒绝 → 不执行", denied.isError === true && JSON.stringify(denied).includes("用户未批准"), denied);
    deepEq("审批卡上是这个工具名", asked, ["workflow_remove"]);
    asked.length = 0;
    const readOnly = await workflowEngineBridge.invokeGated("workflow_list", {}, "admin-smoke", ctxOf(false), { autoApprove: false });
    check("只读工具不问、直接跑", !readOnly.isError && asked.length === 0, { readOnly, asked });
    await workflowEngineBridge.invokeGated("workflow_remove", { id: "wf_never" }, "admin-smoke", ctxOf(false), { autoApprove: true });
    eq("全放行档不弹审批", asked.length, 0);

    const piSrc = readFileSync("src/main/providers/pi-sdk/mcodeExtension.ts", "utf8");
    check("Pi 注册了工作流工具", piSrc.includes("workflowEngineBridge.descriptors()") && piSrc.includes("workflowEngineBridge.invoke(tool.name"));
    check("Pi 守卫放行只读工作流工具", piSrc.includes("workflowEngineBridge.isReadonly(toolName)"));
    const cxSrc = readFileSync("src/main/providers/codex-sdk/CodexAgentSdkProvider.ts", "utf8");
    check("Codex 挂了工作流动态工具", cxSrc.includes("...workflowEngineBridge.descriptors()"));
    check("Codex 派发走带审批的那条", cxSrc.includes("workflowEngineBridge.invokeGated(name"));
  }

  console.log(`\n${checks - failures}/${checks} 通过`);
  if (failures > 0) {
    console.log(`${failures} 条失败`);
    process.exitCode = 1;
  }
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
