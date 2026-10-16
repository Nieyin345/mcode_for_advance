/**
 * 【MC-041】把用户自建工作流**发布为带参数的派生工具** —— 声明、索引、结构化调用。
 *
 * ## 它补的是哪条洞(源码可确认)
 *
 * `WorkflowDoc.inputSchema/outputSchema` 契约上写着"这张图吃什么/交什么",台账点名的
 * 状态是**没有真实读方**:agent 存的 `paperId: string` 声明没人看,调用端
 * (`app_workflow_run`)只收 `workflow_id/trigger_node_id/prompt/...`,结构化实参无处
 * 可传;`app_api_list` 也只枚举静态 RPC,自建工作流不在任何索引里 —— 用户说
 * 「调用文献整理工具,paperId=123」时宿主**找不到、也传不进**。
 *
 * ## 设计(与台账「统一宿主的用户派生能力声明/发布/撤销接口」对齐,但不另造执行层)
 *
 * - **发布 = 一条设置记录**(`workflow.publishedTools`:`{ [workflowId]: { name,
 *   description, publishedAt } }`)。发布是**用户可见的状态**,重启后仍在;撤销即删除该条。
 * - **索引 = 动态并入 `app_api_list`**(`app_api_list({query:"文献整理"})` 查得到),
 *   名字形如 `workflow.run.<name>`;`app_api_describe` 给它一段由 inputSchema 生成的
 *   参数说明 —— 查询与描述走的是**同一条既有通路**,没有第二套目录。
 * - **结构化调用 = `app_workflow_run({ workflow_id, params })`**:params 按工作流的
 *   `inputSchema`(JSON-Schema 风格子集:string/number/boolean/object/array +
 *   required)在执行前校验;**不符即拒,不执行**(台账验收原文)。合法时把实参渲染成
 *   一段结构化正文拼进 prompt —— 执行仍走既有 `app_workflow_run` 路径(不另造 Agent loop)。
 * - **发布需真人批准**:发布/撤销动作本身是高风险的 ��� 台账「真人授权」),走既有的
 *   `gateAppAction` 审批链;索引只展示**已发布**的工作流。
 *
 * ## 与"只是能跑"的差别(台账失败反例)
 *
 * 反例是「按 ID+prompt 执行 ≠ 具备工具式调用合同」。这里补的正是合同面:发布 →
 * 按**名字**检索 → 看参数 schema → 结构化调用(带校验)→ 撤销。参数不符 / 未发布 /
 * 已撤销都在**执行前**拒绝。
 */
import { SettingRepo } from "@main/store/repositories.js";
import { log } from "@main/lib/logger.js";
import { getWorkflow, listWorkflows } from "./library.js";

/** 发布表:workflowId → 派生工具元数据。整份 JSON 存一行设置。 */
const PUBLISHED_SETTING_KEY = "workflow.publishedTools";

export interface PublishedWorkflowTool {
  /** 派生工具名(用户起;检索按它 + 工作流名 + description 匹配)。 */
  name: string;
  description?: string;
  publishedAt: number;
}

type PublishMap = Record<string, PublishedWorkflowTool>;

/** 设置行损坏时的分类(与 MC-051/053/054 同一协议):坏数据不当空表,读写都拒。 */
type PublishState =
  | { kind: "absent" }
  | { kind: "valid"; map: PublishMap }
  | { kind: "corrupt"; reason: string };

function classifyPublished(): PublishState {
  const raw = SettingRepo.get(PUBLISHED_SETTING_KEY);
  if (raw === null || raw === "") return { kind: "absent" };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { kind: "corrupt", reason: "发布表不是对象" };
    }
    const map: PublishMap = {};
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v !== "object" || v === null) return { kind: "corrupt", reason: `条目 ${id} 不是对象` };
      const t = v as Record<string, unknown>;
      if (typeof t.name !== "string" || typeof t.publishedAt !== "number") {
        return { kind: "corrupt", reason: `条目 ${id} 缺 name/publishedAt` };
      }
      map[id] = { name: t.name, ...(typeof t.description === "string" ? { description: t.description } : {}), publishedAt: t.publishedAt };
    }
    return { kind: "valid", map };
  } catch {
    return { kind: "corrupt", reason: "发布表不是合法 JSON" };
  }
}

/** 读取发布表(损坏时按空表**返回给展示**并记诊断;写入路径另行拒绝 —— 见 publish）。 */
export function publishedWorkflowTools(): { tools: Array<{ workflowId: string; tool: PublishedWorkflowTool }>; corrupted: boolean } {
  const state = classifyPublished();
  if (state.kind === "corrupt") {
    log.warn(`workflow: 派生工具发布表损坏(${state.reason}),本次不列已发布工具;修复请清空 setting「${PUBLISHED_SETTING_KEY}」。`);
    return { tools: [], corrupted: true };
  }
  if (state.kind === "absent") return { tools: [], corrupted: false };
  return {
    tools: Object.entries(state.map).map(([workflowId, tool]) => ({ workflowId, tool })),
    corrupted: false,
  };
}

/** 发布一个工作流为派生工具。**工作流必须存在**;同名不能撞另一个已发布工具与内置工具名。 */
export function publishWorkflowTool(input: {
  workflowId: string;
  name: string;
  description?: string;
}): { ok: boolean; error?: string } {
  const name = input.name.trim();
  if (!name) return { ok: false, error: "派生工具名不能为空。" };
  const doc = getWorkflow(input.workflowId);
  if (!doc) return { ok: false, error: `工作流 ${input.workflowId} 不存在,不能发布。` };
  const state = classifyPublished();
  if (state.kind === "corrupt") {
    // 与 MC-051 的纪律一致:坏表不覆盖 —— 发布被拒,交给显式修复。
    return { ok: false, error: `派生工具发布表损坏(${state.reason}),已拒绝发布以免覆盖现场;修复请清空 setting「${PUBLISHED_SETTING_KEY}」。` };
  }
  const map: PublishMap = state.kind === "valid" ? { ...state.map } : {};
  const clash = Object.entries(map).find(([id, t]) => id !== input.workflowId && t.name === name);
  if (clash) return { ok: false, error: `派生工具名「${name}」已被工作流 ${clash[0]} 使用。` };
  map[input.workflowId] = {
    name,
    ...(input.description ? { description: input.description } : {}),
    publishedAt: Date.now(),
  };
  SettingRepo.set(PUBLISHED_SETTING_KEY, JSON.stringify(map));
  return { ok: true };
}

/** 撤销发布。幂等:没发布过也返回 ok(目标状态达成)。 */
export function unpublishWorkflowTool(workflowId: string): { ok: boolean; error?: string; existed?: boolean } {
  const state = classifyPublished();
  if (state.kind === "corrupt") {
    return { ok: false, error: `派生工具发布表损坏(${state.reason}),无法安全撤销;修复请清空 setting「${PUBLISHED_SETTING_KEY}」。` };
  }
  if (state.kind === "absent" || !(workflowId in state.map)) return { ok: true, existed: false };
  const map = { ...state.map };
  delete map[workflowId];
  SettingRepo.set(PUBLISHED_SETTING_KEY, JSON.stringify(map));
  return { ok: true, existed: true };
}

/* ─────────────── 结构化实参校验(JSON-Schema 风格子集)─────────────── */

/** 校验结果:`ok` 或一条人能读的错误(直接回给调用端,不执行)。 */
export type ParamsVerdict = { ok: true; normalized: Record<string, unknown> } | { ok: false; error: string };

/**
 * 按工作流的 `inputSchema` 校验结构化实参。
 *
 * 支持 JSON-Schema 的常用子集:`type`(string/number/integer/boolean/object/array)、
 * `required`、`properties`、`description`、`enum`。**不认识的形状一律不拦**(宽松
 * 契约的立场见 `WorkflowDocSchema.inputSchema` 注释:契约层不解释内容)—— 只有
 * 明确写了类型/必填的字段才参与校验,避免误伤比漏拦更糟(把合法调用拒了)。
 */
export function validateWorkflowParams(
  doc: { inputSchema?: Record<string, unknown> } | null,
  params: unknown,
): ParamsVerdict {
  const schema = doc?.inputSchema;
  if (!schema || Object.keys(schema).length === 0) {
    // 没声明输入:给了实参也不拦(用户可能就是想传点上下文),如实放行。
    if (params === undefined || params === null) return { ok: true, normalized: {} };
    if (typeof params !== "object" || Array.isArray(params)) {
      return { ok: false, error: "params 必须是对象(键值对)。" };
    }
    return { ok: true, normalized: { ...(params as Record<string, unknown>) } };
  }
  if (params === undefined || params === null) params = {};
  if (typeof params !== "object" || Array.isArray(params)) {
    return { ok: false, error: "params 必须是对象(键值对)。" };
  }
  const given = params as Record<string, unknown>;
  const required = Array.isArray(schema.required) ? (schema.required as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const missing = required.filter((k) => given[k] === undefined || given[k] === null);
  if (missing.length > 0) {
    return { ok: false, error: `缺少必填参数:${missing.join(" / ")}。用 app_api_describe({method:"workflow.run.<名字>"}) 看参数说明。` };
  }
  const properties =
    typeof schema.properties === "object" && schema.properties !== null && !Array.isArray(schema.properties)
      ? (schema.properties as Record<string, unknown>)
      : {};
  for (const [key, value] of Object.entries(given)) {
    if (value === undefined || value === null) continue;
    const prop = properties[key];
    if (typeof prop !== "object" || prop === null) continue; // 未声明的字段:不拦
    const p = prop as Record<string, unknown>;
    const type = typeof p.type === "string" ? p.type : undefined;
    if (!type) continue;
    const actual =
      Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
    const expect =
      type === "integer" ? "number" : type === "number" ? "number" : type === "boolean" ? "boolean" : type === "string" ? "string" : type === "object" ? "object" : type === "array" ? "array" : null;
    if (expect === null) continue; // 不认识的 type:不拦
    if (expect === "number" && (actual !== "number" || (type === "integer" && !Number.isInteger(value)))) {
      return { ok: false, error: `参数 ${key} 类型不符:要 ${type},收到 ${actual}(${JSON.stringify(value)})。` };
    }
    if (expect !== "number" && actual !== expect) {
      return { ok: false, error: `参数 ${key} 类型不符:要 ${expect},收到 ${actual}(${JSON.stringify(value)})。` };
    }
    const enumVals = Array.isArray(p.enum) ? p.enum : undefined;
    if (enumVals && !enumVals.some((v) => Object.is(v, value))) {
      return { ok: false, error: `参数 ${key} 只能是 ${enumVals.map((v) => JSON.stringify(v)).join(" / ")},收到 ${JSON.stringify(value)}。` };
    }
  }
  return { ok: true, normalized: given };
}

/** 把结构化实参渲染成一段拼进 prompt 的正文(执行仍走既有 app_workflow_run)。 */
export function renderWorkflowParams(doc: { inputSchema?: Record<string, unknown> } | null, params: Record<string, unknown>): string {
  const keys = Object.keys(params);
  if (keys.length === 0) return "";
  const schema = doc?.inputSchema;
  const props =
    schema && typeof schema.properties === "object" && schema.properties !== null
      ? (schema.properties as Record<string, unknown>)
      : {};
  const lines = keys.map((k) => {
    const prop = props[k];
    const desc = typeof prop === "object" && prop !== null && typeof (prop as Record<string, unknown>).description === "string"
      ? ` —— ${(prop as Record<string, unknown>).description as string}`
      : "";
    return `- ${k}: ${JSON.stringify(params[k])}${desc}`;
  });
  return `本次调用的结构化参数(inputSchema 声明):\n${lines.join("\n")}`;
}

/** 给 `app_api_list`/`app_api_describe` 用:派生工具的"方法名"与参数说明。 */
export function publishedToolMethodName(tool: PublishedWorkflowTool): string {
  return `workflow.run.${tool.name}`;
}

/** 生成派生工具的参数说明文本(与目录里 input/output 同一面孔)。 */
export function describeWorkflowToolParams(workflowId: string): string {
  const doc = getWorkflow(workflowId);
  const schema = doc?.inputSchema;
  if (!schema || typeof schema.properties !== "object" || schema.properties === null) {
    return "(没有声明输入;params 可省略)";
  }
  const required = new Set(Array.isArray(schema.required) ? (schema.required as unknown[]).filter((x): x is string => typeof x === "string") : []);
  const lines = Object.entries(schema.properties as Record<string, unknown>).map(([k, v]) => {
    const p = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
    const type = typeof p.type === "string" ? p.type : "unknown";
    const desc = typeof p.description === "string" ? ` // ${p.description}` : "";
    return `${k}${required.has(k) ? "" : "?"}: ${type}${desc}`;
  });
  return `{ ${lines.join("; ")} }`;
}

/** 发布表里的 workflowId 是否仍然对应一个存在的工作流(列表展示时过滤悬挂项)。
 *
 * ⚠️ **无头套件里 DB 可能还没就绪**(`app-control-smoke` 不 initDb —— 它验的是
 * 目录/权限那些纯面)。那时 `listWorkflows()` 会抛 —— 目录**不该因此整个炸掉**:
 * DB 不可用 = 我们此刻证明不了"派生工具指向现存工作流",那就不把它们并列进目录
 * (保守方向),而不是把 `app_api_list` 变成错误。 */
export function publishedToolsWithDocs(): Array<{ workflowId: string; tool: PublishedWorkflowTool; name: string; docName: string }> {
  const { tools } = publishedWorkflowTools();
  let known: Set<string>;
  try {
    known = new Set(listWorkflows().map((w) => w.id));
  } catch {
    return [];
  }
  return tools
    .filter((t) => known.has(t.workflowId))
    .map((t) => ({ ...t, name: t.tool.name, docName: getWorkflow(t.workflowId)?.name ?? t.workflowId }));
}
