/**
 * 【ARC-002】**统一教程入口 `app_guide(topic)` 的派生核** —— "这个功能域 / 工作流工具 /
 * 扩展能力怎么用、要什么权限、参数长什么样"。
 *
 * ## 它在补哪条洞(台账原文)
 *
 * ARC-002 的 remaining:「**尚无统一任务索引、完整帮助/教程入口**」,设计目标第 4 条:
 * 「**由一份权威 API/权限目录派生三引擎、UI、教程索引,不复制规则**」。
 * 在此之前:功能域目录在 `policy.ts` 的 `DOMAIN_LABELS`、方法/参数在
 * `apiCatalog.generated.ts`、权限在 `policyFor`、用户发布的工作流工具在
 * `orchestration/publishedTools.ts`、扩展能力在 `ModuleHost.catalog()` —— agent 想知道
 * "library 域有哪些方法、哪些要批准、怎么调"必须自己把四份来源拼起来(拼错 = 静默以为
 * 没有这个功能)。本文件把四份权威源汇成**一份可查询的 topic 索引**。
 *
 * ## 为什么必须"从权威源派生",而不是另写一份教程清单
 *
 * 复制一份清单的代价不是多写几行字,而是**漂移**:方法改名 / 新增域 / 装了新扩展之后,
 * 副本不会跟着变,agent 照着过期教程调,报错又回到"猜"。所以这里**只有派生逻辑,没有
 * 第二份名单**:
 *   - 域的清单 = `API_CATALOG` 里出现过的域(方法侧唯一权威);
 *   - 域的标题 = `policy.ts` 的 `DOMAIN_LABELS`(`app_api_list` 用的同一份);
 *   - 权限档 = `policyFor(method)`(与 `app_api_call` 的闸门同一份判定);
 *   - 用户发布的工具 = `publishedToolsWithDocs()`(`app_api_list` 检索用的同一份);
 *   - 扩展能力 = `getModuleHost().catalog()`(`modules.catalog` RPC / 设置页用的同一份)。
 * 派生函数({@link buildGuideTopics} / {@link buildGuideDetail})只吃数据、不取数据,
 * 无头套件可以直接喂一份改过的目录来证明"清单真的跟着权威源变"。
 *
 * ## 与 `app_api_tutorial`(MC-040)的分工
 *
 * - `app_api_tutorial`:「**一串方法按什么顺序调**」(创建自动化 = save → watch → 验证),
 *   内容是手写常量,按任务词检索;
 * - `app_guide`:「**某个主题有什么、什么权限、怎么调**」,内容从权威目录**现场派生**,
 *   按 topic 检索。
 * 两者互补:教程给顺序,指南给该顺序里每一步的权限与参数入口。不把 guide 塞进
 * `app_api_describe`,因为 describe 的键是**方法名**,而 guide 的键横跨域 / 派生工具 /
 * 扩展能力三种对象 —— 塞进去会让一个工具回答两套分类,`method` 的合同也糊掉。
 *
 * ## 示例的边界
 *
 * 示例里的参数对象是从 catalog 的 `input` 形状**解析出来**的(只取必填字段、值用占位符),
 * 不是手抄的调用样例 —— 方法加字段,示例跟着变。解析不了(形状带注释/省略号)的方法
 * 不进示例(宁可少一条,不给一条错的);一个域一条都解析不出时退回"只给方法名"的
 * 调用形式并明说参数形状去 `app_api_describe` 看。
 */
import type { ApiCatalogEntry } from "./apiCatalog.generated.js";
import { API_CATALOG } from "./apiCatalog.generated.js";
import {
  APP_POLICY_LEVEL_LABEL,
  DOMAIN_LABELS,
  domainOfMethod,
  policyFor,
  type AppPolicy,
  type AppPolicyLevel,
} from "./policy.js";
import {
  describeWorkflowToolParams,
  publishedToolsWithDocs,
} from "@main/orchestration/publishedTools.js";
import {
  extensionCapabilityAssignment,
  extensionCapabilityShortName,
  type ModuleCatalog,
  type ModuleManifest,
} from "@contracts/modules";
import type { ModuleCapabilityDescriptor } from "@contracts/moduleCapability";

/** topic 的三种来源。`kind` 只用于展示分组与 badge,不参与检索判定。 */
export type GuideTopicKind = "domain" | "workflow-tool" | "extension-capability";

export interface GuideTopic {
  /** 稳定 id(域前缀 / `workflow.run.<名字>` / 能力 id)。 */
  id: string;
  kind: GuideTopicKind;
  title: string;
  /** 一句话(列表里给 agent 判断"要不要点进去")。 */
  summary: string;
}

export interface GuideEntry {
  title: string;
  /** 人能读的 Markdown:有哪些方法/能力、权限档、示例。 */
  body: string;
  /** 权限档摘要行(与 body 的「权限」段同源;给需要结构化读取的调用方)。 */
  permissions: string[];
  /** 可直接复制进 `app_api_call` / `app_workflow_run` 的示例。 */
  examples: string[];
}

/** 用户发布的工作流工具(source 里的一类;`paramsHint` 在取数时由
 *  `describeWorkflowToolParams` 生成 —— 派生核不碰 DB)。 */
export interface GuidePublishedSource {
  workflowId: string;
  name: string;
  docName: string;
  description?: string;
  paramsHint: string;
}

/**
 * 派生的**全部输入**。刻意把 `domainLabels` 与 `policy` 也做成可注入 —— 套件据此证明
 * "改一条 DOMAIN_LABELS / 加一条 catalog 项,清单跟着变"(若把它们写死 import,
 * 就只能断言"当前快照长这样",证明不了派生关系)。
 */
export interface GuideSources {
  catalog: readonly ApiCatalogEntry[];
  domainLabels: Record<string, string>;
  published: readonly GuidePublishedSource[];
  /** 扩展能力目录。`null` = 此刻取不到(无头 / 启动早期 / 宿主故障),主题列表仍可用。 */
  modules: ModuleCatalog | null;
  policy: (method: string) => AppPolicy;
  /** `modules` 为 null 时的**显式原因**(硬规矩 3:坏了要报出来,不静默当没有扩展)。 */
  moduleCatalogError?: string;
}

/* ───────────────────────── 取数壳(唯一碰外部状态的地方)───────────────────────── */

/**
 * 从四份权威源取一次数据。扩展能力目录**动态 import、失败不抛出** ——
 * `app_guide` 不该因为宿主此刻取不到扩展目录而连功能域都查不了(与
 * `publishedToolsWithDocs` 在 DB 未就绪时退回空表的同一取向);失败原因写进
 * `moduleCatalogError`,由列表工具如实转告。
 */
export async function currentGuideSources(): Promise<GuideSources> {
  let modules: ModuleCatalog | null = null;
  let moduleCatalogError: string | undefined;
  try {
    // 与 executionEngine / runner 同一条:宿主服务懒加载,import 本模块不碰数据根。
    const { getModuleHost } = await import("@main/modules/service.js");
    modules = (await getModuleHost()).catalog();
  } catch (error) {
    moduleCatalogError = error instanceof Error ? error.message : String(error);
  }
  const published = publishedToolsWithDocs().map((p) => ({
    workflowId: p.workflowId,
    name: p.name,
    docName: p.docName,
    ...(p.tool.description ? { description: p.tool.description } : {}),
    paramsHint: describeWorkflowToolParams(p.workflowId),
  }));
  return {
    catalog: API_CATALOG,
    domainLabels: DOMAIN_LABELS,
    published,
    modules,
    policy: policyFor,
    ...(moduleCatalogError ? { moduleCatalogError } : {}),
  };
}

/** 全部 topic(不传参数时 `app_guide` 返回的就是它)。 */
export async function guideTopics(): Promise<GuideTopic[]> {
  return (await guideOverview()).topics;
}

/** 列表 + 扩展目录取不到时的**显式原因**(列表工具把它原样转告,不静默当"没有扩展")。 */
export async function guideOverview(): Promise<{ topics: GuideTopic[]; moduleCatalogError?: string }> {
  const sources = await currentGuideSources();
  return {
    topics: buildGuideTopics(sources),
    ...(sources.moduleCatalogError ? { moduleCatalogError: sources.moduleCatalogError } : {}),
  };
}

/** 单个 topic 的指南;未知 topic 返回 null(调用方给"没有这个 topic + 现有列表")。 */
export async function guideFor(topic: string): Promise<GuideEntry | null> {
  return buildGuideDetail(topic, await currentGuideSources());
}

/* ───────────────────────── 纯派生核(可被无头套件直接驱动)───────────────────────── */

/** 每个域一条 + 每个已发布工作流工具一条 + 每个已装扩展能力一条。 */
export function buildGuideTopics(sources: GuideSources): GuideTopic[] {
  const topics: GuideTopic[] = [];

  // ① 功能域:方法清单从 catalog 派生(域出现过就有条目),标题从 DOMAIN_LABELS 派生。
  const counts = new Map<string, number>();
  for (const entry of sources.catalog) {
    const domain = domainOfMethod(entry.method);
    counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  for (const domain of [...counts.keys()].sort((a, b) => a.localeCompare(b))) {
    const label = sources.domainLabels[domain] ?? "(没有域标签)";
    topics.push({
      id: domain,
      kind: "domain",
      title: `${domain} — ${label}`,
      summary: `${label}(共 ${counts.get(domain)} 个方法)`,
    });
  }

  // ② 用户发布的工作流工具:一条发布记录一条 topic(名字就是 app_api_list 里检索到的那个)。
  for (const p of [...sources.published].sort((a, b) => a.name.localeCompare(b.name))) {
    topics.push({
      id: `workflow.run.${p.name}`,
      kind: "workflow-tool",
      title: `workflow.run.${p.name} — 用户发布的工作流工具`,
      summary: `工作流「${p.docName}」${p.description ? `:${clip(p.description, 60)}` : ""}(执行需批准)`,
    });
  }

  // ③ 已装扩展能力(含宿主内置 core.* —— 它们同样在 catalog().capabilities 里)。
  if (sources.modules) {
    for (const cap of [...sources.modules.capabilities].sort((a, b) => a.id.localeCompare(b.id))) {
      topics.push({
        id: cap.id,
        kind: "extension-capability",
        title: `${cap.id} — 扩展能力(${cap.kind})`,
        summary: `${cap.metadata?.title.zh ?? cap.id} · ${cap.kind}${cap.metadata?.description.zh ? `:${clip(cap.metadata.description.zh, 60)}` : ""}`,
      });
    }
  }

  return topics;
}

/** 单个 topic 的详情。未知 topic 返回 null。 */
export function buildGuideDetail(topic: string, sources: GuideSources): GuideEntry | null {
  const id = topic.trim();
  if (!id) return null;

  const domainMethods = sources.catalog.filter((entry) => domainOfMethod(entry.method) === id);
  if (domainMethods.length > 0) return domainDetail(id, domainMethods, sources);

  const published = sources.published.find((p) => `workflow.run.${p.name}` === id);
  if (published) return publishedDetail(published);

  const capability = sources.modules?.capabilities.find((cap) => cap.id === id);
  if (capability) return capabilityDetail(capability, sources.modules!);

  return null;
}

/* ───────────────────────── 域 topic ───────────────────────── */

/** 每个档位"要不要人点头"的一句人话(标签本体在 policy.ts,与 app_api_list 同一份)。 */
const LEVEL_EXPLANATION: Record<AppPolicyLevel, string> = {
  read: "直接执行,不问审批",
  ui: "直接执行,只动界面不改数据",
  write: "弹审批卡;用户可勾「始终允许」(按方法记);完全访问模式下不问",
  danger: "每次都要用户本人批准,不给「始终允许」,完全访问模式也照问",
  blocked: "不开放给 agent,调用会被直接拒绝",
};

function domainDetail(domain: string, methods: readonly ApiCatalogEntry[], sources: GuideSources): GuideEntry {
  const label = sources.domainLabels[domain] ?? "(没有域标签)";
  const entries = methods.map((entry) => ({ entry, policy: sources.policy(entry.method) }));

  const methodLines = entries.map(
    ({ entry, policy }) =>
      `- \`${entry.method}\` [${APP_POLICY_LEVEL_LABEL[policy.level]}]${entry.doc ? ` — ${clip(entry.doc, 120)}` : ""}`,
  );

  // 权限档:按档分组(次数 + 前几个方法名),让 agent 一眼看出"哪些会弹卡"。
  const byLevel = new Map<AppPolicyLevel, string[]>();
  for (const { entry, policy } of entries) {
    const list = byLevel.get(policy.level) ?? [];
    list.push(entry.method);
    byLevel.set(policy.level, list);
  }
  const levelOrder: AppPolicyLevel[] = ["read", "ui", "write", "danger", "blocked"];
  const permissionLines = levelOrder
    .filter((level) => byLevel.has(level))
    .map((level) => `${APP_POLICY_LEVEL_LABEL[level]}:${byLevel.get(level)!.length} 个 —— ${LEVEL_EXPLANATION[level]}`);

  const examples = domainExamples(entries);
  const exampleSection =
    examples.length > 0
      ? ["## 示例", "```text", ...examples, "```", "参数形状用 app_api_describe({method:\"<方法名>\"}) 看完整版(detail=\"full\" 展开嵌套)。"]
      : ["## 示例", "这个域没有可直接调用的方法(全部不开放给 agent),没有可复制的示例。"];

  const body = [
    `# ${domain} — ${label}`,
    "",
    `共 ${entries.length} 个方法。`,
    "",
    "## 方法",
    ...methodLines,
    "",
    "## 权限档",
    ...permissionLines,
    "",
    ...exampleSection,
  ].join("\n");

  return {
    title: `${domain} — ${label}`,
    body,
    permissions: permissionLines,
    examples,
  };
}

/**
 * 该域的 1–2 条 `app_api_call` 示例。
 *
 * 选择口径:先只读/界面(不弹卡),再写/高风险;跳过 blocked(示例调了也只会被拒)。
 * 形状解析不了的方法不进示例 —— 见文件头「示例的边界」。一个都解析不出时退回
 * 第一条可调用方法的**无参调用形式**,并靠正文里那句 app_api_describe 提示补参数。
 */
function domainExamples(entries: ReadonlyArray<{ entry: ApiCatalogEntry; policy: AppPolicy }>): string[] {
  const callable = entries
    .filter(({ policy }) => policy.level !== "blocked")
    .slice()
    .sort((a, b) => levelRank(a.policy.level) - levelRank(b.policy.level));
  const examples: string[] = [];
  for (const { entry } of callable) {
    if (examples.length >= 2) break;
    const call = exampleCall(entry);
    if (call) examples.push(call);
  }
  if (examples.length === 0 && callable.length > 0) {
    examples.push(`app_api_call({ "method": "${callable[0]!.entry.method}" })`);
  }
  return examples;
}

function levelRank(level: AppPolicyLevel): number {
  return level === "read" ? 0 : level === "ui" ? 1 : level === "write" ? 2 : level === "danger" ? 3 : 4;
}

/** 一条 `app_api_call` 的调用形式;参数解析不出来返回 null。 */
function exampleCall(entry: ApiCatalogEntry): string | null {
  const input = entry.input.trim();
  if (input === "(无参数)" || input === "{}") return `app_api_call({ "method": "${entry.method}" })`;
  // ⚠️ 带行内注释的形状不解析:注释里可能出现 `;` / `}` / `{`,手写扫描器的边界会错。
  // 宁可这条方法不进示例,也不给 agent 一个缺字段的调用样例。
  if (input.includes("//")) return null;
  const fields = parseObjectShape(input);
  if (fields === null) return null;
  const required = fields.filter((field) => field.required);
  if (required.length === 0) return `app_api_call({ "method": "${entry.method}" })`;
  const inputJson = JSON.stringify(
    Object.fromEntries(required.map((field) => [field.name, placeholderForType(field.type)])),
  );
  return `app_api_call({ "method": "${entry.method}", "input": ${inputJson} })`;
}

/* ───────────────────────── 形状解析(把 catalog 的 TS 形状变成 JSON 占位符)───────────────────────── */

interface ShapeField {
  name: string;
  required: boolean;
  type: string;
}

/**
 * 解析 catalog 生成的**浅层形状**字符串,如
 * `{ id: string; title: string }` / `{ limit?: number | undefined }`。
 *
 * 只支持这件事需要的那一小撮语法(对象、字段、`?`、`undefined |` 前缀);解析不了返回
 * null,由调用方放弃这条方法。**这不是通用 TS 解析器,也不该长成通用解析器**。
 */
function parseObjectShape(shape: string): ShapeField[] | null {
  let text = shape.trim();
  if (text.startsWith("undefined")) {
    const bar = text.indexOf("|");
    if (bar < 0) return null;
    text = text.slice(bar + 1).trim();
  }
  if (!text.startsWith("{") || !text.endsWith("}")) return null;
  const inner = text.slice(1, -1);
  const rawFields: string[] = [];
  let depth = 0;
  let buf = "";
  for (const ch of inner) {
    if (ch === "{") depth += 1;
    if (ch === "}") depth -= 1;
    if (depth < 0) return null;
    if (ch === ";" && depth === 0) {
      rawFields.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim() !== "") rawFields.push(buf);
  if (depth !== 0) return null;

  const fields: ShapeField[] = [];
  for (const raw of rawFields) {
    const match = raw.trim().match(/^([A-Za-z_$][\w$]*)(\?)?:\s*([\s\S]+)$/);
    if (!match) {
      // 解析不了的片段直接放弃整条方法 —— 不猜(猜错比没有更糟)。
      return null;
    }
    fields.push({ name: match[1]!, required: match[2] !== "?", type: match[3]!.trim() });
  }
  return fields;
}

/** 类型 → JSON 占位符(只求"形状对",值本身是给 agent 替换的样例)。 */
function placeholderForType(rawType: string): unknown {
  let type = rawType.trim();
  type = type.replace(/\s*\|\s*undefined$/, "").replace(/\s*\|\s*null$/, "").trim();
  const literal = type.match(/^'([^']*)'/);
  if (literal && /^'.*'(\s*\|\s*'.*')*$/.test(type)) return literal[1];
  if (type === "string") return "<string>";
  if (type === "number" || type === "integer") return 0;
  if (type === "boolean") return false;
  if (type === "null") return null;
  if (type === "{}") return {};
  if (type.startsWith("{") && type.endsWith("}")) {
    const nested = parseObjectShape(type);
    if (nested === null) return {};
    return Object.fromEntries(
      nested.filter((field) => field.required).map((field) => [field.name, placeholderForType(field.type)]),
    );
  }
  if (type.endsWith("[]")) {
    const element = type.slice(0, -2).trim();
    return element.startsWith("{") ? [] : [placeholderForType(element)];
  }
  if (type.startsWith("Record<")) return {};
  return "<值>";
}

/* ───────────────────────── 派生工具 topic ───────────────────────── */

function publishedDetail(published: GuidePublishedSource): GuideEntry {
  const methodName = `workflow.run.${published.name}`;
  const permissions = ["需批准:执行时弹审批卡(发布/撤销本身也要用户批准)"];
  const examples = [
    `app_workflow_run({ "workflow_id": "${published.workflowId}", "params": {} })`,
  ];
  const body = [
    `# ${methodName}`,
    "",
    `类型:用户发布的工作流工具(来自工作流「${published.docName}」)。`,
    `工作流 id:${published.workflowId}`,
    published.description ? `说明:${published.description}` : null,
    `参数:${published.paramsHint}`,
    "",
    "## 权限",
    ...permissions.map((line) => `- ${line}`),
    "",
    "## 示例",
    "```text",
    ...examples,
    "```",
    `params 按工作流 inputSchema 校验,不符会在**执行前**拒绝;参数说明用 app_api_describe({method:"${methodName}"}) 看。`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
  return { title: `${methodName} — 用户发布的工作流工具`, body, permissions, examples };
}

/* ───────────────────────── 扩展能力 topic ───────────────────────── */

function capabilityDetail(capability: ModuleCapabilityDescriptor, catalog: ModuleCatalog): GuideEntry {
  const owner = findOwningModule(capability.id, catalog.modules);
  const moduleTitle = owner?.title.zh ?? "(未找到所属模块)";
  const contribution = owner?.contributions.find((c) => resolveContributionCapability(owner, c.capability) === capability.id);
  const title = capability.metadata?.title.zh ?? contribution?.title.zh ?? capability.id;
  const meta = capability.metadata;
  const permissions: string[] = [];

  if (owner) {
    permissions.push(`模块声明:${owner.permissions.join("、")}`);
  }
  if (meta) {
    permissions.push(`能力自身声明:${meta.permissions.join("、")}`);
  }
  // 审批口径**照 ModuleHost.invoke 的真实分支写**,不是泛泛一句"可能弹卡":
  //   - action(`resource.write`)每次执行前弹一次审批(逐次批准,安装时声明只是资格);
  //   - 非 action 且声明 `network` 时,每次调用前单独弹联网审批(逐次批准);
  //   - action 同时声明 network:由同一张"写"审批卡覆盖,但仍然每次都问。
  const isAction = capability.kind === "action";
  const hasNetwork = owner?.permissions.includes("network") ?? false;
  if (isAction) {
    permissions.push("resource.write:这是 action 能力——每次执行前都会弹审批卡、逐次批准;安装时声明 resource.write 只是一次资格,不是永久放行。");
  }
  if (hasNetwork) {
    permissions.push(
      isAction
        ? "network:这个模块同时声明了联网——执行的每一次都会问(与写审批同一张卡,仍然逐次批准)。"
        : "network:每次调用前单独弹联网审批、逐次批准——装上时声明一次不等于永久出网。",
    );
  }
  if (!isAction && !hasNetwork) {
    // 「不弹审批」照 ModuleHost.invoke 的真实分支:**只有 action 与 network 会问**。
    // task 类不是"只读"(它会跑一段时间的任务、可取消)—— 单独说清楚,别让 agent
    // 以为它和 query 一样瞬时。
    permissions.push(
      capability.kind === "task"
        ? "task 能力:执行不弹审批,但会在宿主里起一个可取消的任务(进度靠 modules.task 拉);仍受工作区根授权与输入校验约束。"
        : "只读能力:执行不弹审批,但仍受工作区根授权与能力自身输入校验约束。",
    );
  }

  const invokeExample = modulesInvokeExample(capability, owner, contribution?.id);
  const examples = [invokeExample];
  const body = [
    `# ${title}(${capability.id})`,
    "",
    `所属模块:${moduleTitle}${owner ? ` \`${owner.id}\`` : ""}`,
    `种类:${capability.kind}`,
    meta?.description.zh ? `说明:${meta.description.zh}` : contribution?.title.zh ? `说明:${contribution.title.zh}` : null,
    meta ? `版本:${meta.version}` : "这个能力没有元数据(没有描述/schema;输入形状见 modules.invoke)。",
    "",
    "## 权限",
    ...permissions.map((line) => `- ${line}`),
    "",
    "## 调用",
    "能力 id 本身就是**宿主/工作流**使用的身份,调用入口是 `modules.invoke`(不是 app_api_call 直接调它):",
    "```text",
    invokeExample,
    "```",
    "参数形状见 app_api_describe({method:\"modules.invoke\"})。resource.projectPath 必须是已登记的工作区根,path 必须是该工作区内的文件。",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  return { title: `${title}(${capability.id})`, body, permissions, examples };
}

/** 找出贡献项指向这个能力的模块(内置 `core.*` 直接比对;扩展的 `module.<短名>`
 *  按宿主分配规则 `module.<slug>.<短名>` 展开后比对 —— 与 ModuleHost 同一份规则)。 */
function findOwningModule(capabilityId: string, modules: readonly ModuleManifest[]): ModuleManifest | undefined {
  return modules.find((module) =>
    module.contributions.some((c) => resolveContributionCapability(module, c.capability) === capabilityId),
  );
}

function resolveContributionCapability(module: ModuleManifest, referenced: string): string {
  const short = extensionCapabilityShortName(referenced);
  return short === undefined ? referenced : extensionCapabilityAssignment(module.id, short);
}

/**
 * `modules.invoke` 的调用示例。字段名**从 catalog 的 `input` 形状派生**(与
 * `exampleCall` 同一条解析路),已知字段填上本能力的真实取值;解析失败才退回手写形状
 * (modules.invoke 是固定合同,退化路径不该发生,但也不能因此让整个 topic 空掉)。
 */
function modulesInvokeExample(
  capability: ModuleCapabilityDescriptor,
  owner: ModuleManifest | undefined,
  contributionId: string | undefined,
): string {
  const knownValues: Record<string, unknown> = {
    moduleId: owner?.id ?? "<模块 id>",
    contributionId: contributionId ?? "<贡献 id>",
    resource: { projectPath: "<已登记的工作区根>", path: "<工作区内文件>" },
    requestId: "<每次调用唯一>",
  };
  const entry = API_CATALOG.find((e) => e.method === "modules.invoke");
  const fields = entry ? parseObjectShape(entry.input) : null;
  const input: Record<string, unknown> = {};
  if (fields) {
    for (const field of fields) {
      if (!field.required) continue;
      input[field.name] = knownValues[field.name] ?? placeholderForType(field.type);
    }
  } else {
    Object.assign(input, knownValues);
  }
  // 字段集合以 catalog 为准;人读的取值优先(上面 knownValues 覆盖)。能力身份不参与入参。
  void capability;
  return `app_api_call({ "method": "modules.invoke", "input": ${JSON.stringify(input)} })`;
}

/* ───────────────────────── 小工具 ───────────────────────── */

/** 截断一句说明(只影响展示,不改变判据)。 */
function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
