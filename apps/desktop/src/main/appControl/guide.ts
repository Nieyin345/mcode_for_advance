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
import { BUILTIN_MCODE_COMMANDS } from "@main/modules/builtinMcCommands.js";
import { MODULE_PERMISSION_NAMES } from "@contracts/appPermission";
import { extensionAuthoringGuide } from "./appApiTutorials.js";
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
} from "@contracts/modules";

/** topic 的来源。`kind` 只用于展示分组与 badge,不参与检索判定。 */
export type GuideTopicKind =
  | "domain"
  | "workflow-tool"
  /** 宿主内置命令（`mcode.file.*`）—— 扩展能调，agent 通过 guide 才知道。 */
  | "builtin-command"
  /** 已安装的 Theia 扩展（清单 + 启动后贡献的命令）。 */
  | "installed-extension"
  | "authoring-guide";

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
/** 已安装扩展的一条（派生核只吃数据，不碰 registry）。 */
export interface GuideInstalledExtension {
  id: string;
  version: string;
  enabled: boolean;
  running: boolean;
  corrupted?: boolean;
  /** 启动之后才有 —— 没启动就是 undefined（Theia/VS Code 协议如此，扩展先 activate 才注册命令）。 */
  commands?: readonly string[];
  /** 同上，带显示名。 */
  commandContributions?: readonly { id: string; title?: string; category?: string }[];
}

export interface GuideSources {
  catalog: readonly ApiCatalogEntry[];
  domainLabels: Record<string, string>;
  published: readonly GuidePublishedSource[];
  /** 宿主内置命令表（`mcode.file.*`）。扩展能调，所以要能被 agent 发现。 */
  builtinCommands: readonly { id: string; summary: string }[];
  /** 已安装的 Theia 扩展。`null` = 此刻取不到（无头 / 宿主故障）。 */
  installed: readonly GuideInstalledExtension[] | null;
  policy: (method: string) => AppPolicy;
  /** `installed` 为 null 时的**显式原因**(硬规矩 3:坏了要报出来,不静默当没有扩展)。 */
  installedError?: string;
}

/* ───────────────────────── 取数壳(唯一碰外部状态的地方)───────────────────────── */

/**
 * 从权威源取一次数据。**失败不抛出** —— `app_guide` 不该因为扩展此刻取不到
 * 就连功能域都查不了（与 `publishedToolsWithDocs` 在 DB 未就绪时退回空表的同一取向）；
 * 失败原因写进 `installedError`，由列表工具如实转告。
 */
export async function currentGuideSources(): Promise<GuideSources> {
  // 【EXT-07】扩展系统只有 Theia 扩展一套。
  //
  // 这里能拿到的、和拿不到的，都是协议决定的：
  //   - **拿得到**：已装扩展的清单与状态（registry 持久化的）；
  //   - **拿得到**：**已启动**扩展贡献的命令（`activeSession.commands`）；
  //   - **拿不到**：未启动扩展的命令 —— VS Code / Theia 协议里，命令是
  //     `activate()` 之后由扩展自己注册的，没有启动就没有这张表。VS Code 自己也一样。
  //
  // 所以「没列出来」有两种含义，输出里必须分开写清楚（见 buildGuideDetail）。
  let installed: readonly GuideInstalledExtension[] | null = null;
  let installedError: string | undefined;
  try {
    installed = await readInstalledExtensions();
  } catch (error) {
    installedError = error instanceof Error ? error.message : String(error);
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
    builtinCommands: BUILTIN_MCODE_COMMANDS.map(c => ({ id: c.id, summary: c.summary })),
    installed,
    policy: policyFor,
    ...(installedError ? { installedError } : {}),
  };
}

/** 已装扩展清单的唯一取数点。
 *
 * 抽成单独函数是为了让套件能替换它（`setInstalledExtensionsReader`），
 * 而派生核 `buildGuideTopics` / `buildGuideDetail` 仍然只吃数据、不取数据。 */
async function readInstalledExtensions(): Promise<readonly GuideInstalledExtension[]> {
  const reader = installedReader;
  if (!reader) {
    throw new Error("扩展清单读取器没有装配（生产环境由启动期注入；无头套件应为它注入数据）");
  }
  return reader();
}

export type InstalledExtensionsReader = () => Promise<readonly GuideInstalledExtension[]>;
let installedReader: InstalledExtensionsReader | null = null;

/** 装配入口。生产由 `main/index.ts` 启动期注入（读 Theia registry）；
 *  套件注入假数据。**不装配 = 明确报错**，不静默返回空清单。 */
export function setInstalledExtensionsReader(next: InstalledExtensionsReader | null): void {
  installedReader = next;
}

/** 全部 topic(不传参数时 `app_guide` 返回的就是它)。 */
export async function guideTopics(): Promise<GuideTopic[]> {
  return (await guideOverview()).topics;
}

/** 列表 + 扩展目录取不到时的**显式原因**(列表工具把它原样转告,不静默当"没有扩展")。 */
export async function guideOverview(): Promise<{ topics: GuideTopic[]; installedError?: string }> {
  const sources = await currentGuideSources();
  return {
    // Built-in authoring documentation is not a discovered RPC domain. Keep
    // buildGuideTopics() pure so its domain set still matches API_CATALOG.
    topics: [...buildGuideTopics(sources), { id: "extensions", kind: "authoring-guide" as const, title: "extensions — 创建扩展", summary: "AI 编写扩展的 manifest、权限、API、可运行示例与常见错误" },
      // 【T54】单独一道门：`mcode-workflow` 的工具**不在** catalog 里。
      // 不列在这里，找「AI 能不能发现工作流节点」的人就会在 app_api_list 里零命中、
      // 然后得出结论「没有这个能力」（实测发生过）。见 WORKFLOW_TOOL_SURFACE 的注释。
      { id: "workflow-tools", kind: "authoring-guide" as const, title: "workflow-tools — 工作流工具面(mcode-workflow)", summary: `看/写工作流本身的那套 MCP 工具(${WORKFLOW_TOOL_SURFACE.length} 个:node_types_list / workflow_save …) — 不是 app_api_call 的方法` }],
    ...(sources.installedError ? { installedError: sources.installedError } : {}),
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

  // ③ 宿主内置命令（`mcode.file.*`）—— 扩展能调，agent 通过这里才知道有它们。
  //
  // 从 `BUILTIN_MCODE_COMMANDS` **现场派生**，不写第二份名单：加一条内置命令，
  // 这里自动跟上（与本文件顶部「只有派生逻辑，没有第二份名单」同一取向）。
  for (const cmd of [...sources.builtinCommands].sort((a, b) => a.id.localeCompare(b.id))) {
    topics.push({
      id: cmd.id,
      kind: "builtin-command",
      title: `${cmd.id} — 宿主内置命令（扩展可调）`,
      summary: cmd.summary,
    });
  }

  // ④ 已安装的 Theia 扩展。
  //
  // ⚠️ **命令只有扩展启动之后才有**（VS Code / Theia 协议：扩展 `activate()` 时
  // 自己注册命令，没有启动就没有这张表）。所以这里如实分两种：
  //   - 已启动 → 列它贡献的命令；
  //   - 没启动 → 注明「命令要启动后才有」，不是「它没有命令」。
  for (const ext of [...(sources.installed ?? [])].sort((a, b) => a.id.localeCompare(b.id))) {
    const state = ext.corrupted
      ? "安装已损坏"
      : !ext.enabled
        ? "已禁用"
        : ext.running
          ? "运行中"
          : "已装未启动";
    const cmdCount = ext.commands?.length ?? 0;
    const cmdNote = ext.running
      ? `贡献 ${cmdCount} 条命令`
      : "命令未加载（未启动：Theia 协议要求扩展先激活才注册命令）";
    topics.push({
      id: `extension.${ext.id}`,
      kind: "installed-extension",
      title: `扩展 ${ext.id} ${ext.version}（${state}）`,
      summary: `${cmdNote}`,
    });
  }

  return topics;
}

/** 【T54】`mcode-workflow` 那套工具面的**清单** —— 让 `app_guide({topic:"workflow-tools"})` 能列出它们。
 *
 * ## 为什么要有这一条
 *
 * 这个软件有**两套工具面**，而它们各自有各自的入口：
 *
 *   - **appControl**（`apiCatalog.generated.ts` → `app_api_list` / `app_api_call`）：RPC 方法；
 *   - **`mcode-workflow` MCP server**（`mcp/mcodeServer.ts` 的 `workflowMcpTools()`）：
 *     `node_types_list` / `workflow_save` / `workflow_get` … —— **不在 `app_api_call` 的调用面里**，
 *     按名字去 `app_api_list` 搜，一个都搜不到。
 *
 * 后果实测：有人找「AI 能不能发现工作流节点」，在 `app_api_list` 里零命中，于是得出
 * 「没有这个能力」的结论 —— 而 `node_types_list` 早就挂在三家引擎上了。
 * **这是可发现性缺陷，不是能力缺陷。**
 *
 * ## 为什么是「指路」而不是「并进目录」
 *
 * 把 14 个工具名塞进 `app_api_list` 的返回是**有害的**：那张表的语义是「能被
 * `app_api_call` 调的方法」，混进 MCP 工具会让模型用 `app_api_call` 去调它们，
 * 而那条路根本不通。所以这里只给**名字 + 怎么用它们**，并明确写「不是 app_api_call 的方法」。
 *
 * ⚠️ **这张表要跟着 `workflowMcpTools()` 走。** 套件 `t54-workflow-tools-discoverability-smoke`
 * 会拿这里的名字与 `workflowMcpTools()` 的实际返回逐条比对 —— 少一个、多一个都红。
 * 这是刻意的：两份清单分开维护必然漂，让套件把它们钉在一起。
 */
export const WORKFLOW_TOOL_SURFACE: readonly { name: string; readonly_: boolean; summary: string }[] = [
  { name: "workflow_list", readonly_: true, summary: "列出工作流 / 自动化" },
  { name: "workflow_get", readonly_: true, summary: "取一份工作流的完整定义(带版本号,改之前先取)" },
  { name: "node_types_list", readonly_: true, summary: "列出可用的节点类型与各自参数 —— **写工作流之前必调**" },
  { name: "agent_profiles_list", readonly_: true, summary: "列出用户存下来的代理档案(一组预填好的节点参数)" },
  { name: "session_read_log", readonly_: true, summary: "读一段对话记录(按会话 id 取消息)" },
  // ⚠️ `session_list` 默认**不**在工具面上（`workflowMcpTools({includeSessionLogs:false})`），
  // 但 `workflowMcpTools()` 不传参时它是有的（本机三引擎都走这条）。清单照默认形状列。
  // **它读得到本机有哪些对话 —— 所以不在 `WORKFLOW_READONLY_TOOLS` 里，要批准**
  // （见 mcodeServer 的 `SESSION_LOG_TOOLS` 注释：公网那条路要整组摘掉）。
  { name: "session_list", readonly_: false, summary: "列出本机的对话(标题、时间、项目) —— 涉及隐私,需批准" },
  { name: "workflow_save", readonly_: false, summary: "新建或整份覆盖一份工作流(需批准;新建时不传 expectedRevision)" },
  { name: "workflow_remove", readonly_: false, summary: "删掉一份工作流(需批准;删内置的 = 恢复默认)" },
  { name: "node_type_write", readonly_: false, summary: "写一个自定义节点类型(需批准)" },
  { name: "agent_profile_save", readonly_: false, summary: "存一份代理档案(需批准)" },
  { name: "agent_profile_remove", readonly_: false, summary: "删一份代理档案(需批准)" },
  { name: "agent_peers", readonly_: true, summary: "列出本机有哪些代理会话(只读名册)" },
  { name: "agent_notify", readonly_: false, summary: "给另一个代理会话发一条消息(需批准)" },
  { name: "agent_ask", readonly_: false, summary: "问另一个代理会话一个问题,答复到了再叫醒你(需批准)" },
];

/** 【T54】`app_guide({topic:"workflow-tools"})` 的正文。 */
function workflowToolsDetail(): GuideEntry {
  const lines = WORKFLOW_TOOL_SURFACE.map(
    (t) => `- \`${t.name}\` [${t.readonly_ ? "只读·不问" : "需批准"}] — ${t.summary}`,
  );
  return {
    title: "workflow-tools — 工作流工具面(mcode-workflow)",
    body: [
      "这是**另一道门**:下面这些工具由 `mcode-workflow` MCP server 提供,**不是** `app_api_call` 的方法。",
      "它们是**工具**,直接按名字调用即可(与 `browser_*` / `agent_*` 同类)——**不要**用 `app_api_call({method:\"node_types_list\"})`,那条路不通。",
      "",
      "## 要写或改工作流,照这个顺序",
      "1. `node_types_list` —— 看有哪些节点类型、各自的参数名与形状、哪些引用型参数可以留空;",
      "2. `workflow_get` —— 改已有的图时先取,拿它的版本号;",
      "3. `workflow_save` —— 存。**新图的头一步必须是 `mcode.main`**;新建时不传 `expectedRevision`,",
      "   改已有的一定要带上（否则覆盖会被拒绝）。坐标不用写,不给 `position` 的节点会按依赖自动排。",
      "4. 存完**还没启用** —— 要请用户在 设置 → 工作流/自动化 里检查并批准后才会跑。",
      "",
      "## 工具清单",
      ...lines,
      "",
      "## 与 `app_workflow_*` 的分工(容易混)",
      "- `app_workflow_run` / `app_workflow_publish` / `app_workflow_unpublish` —— **跑**和**发布**已有工作流;",
      "- 上面这 14 个 —— **看**和**写**工作流本身。两套不是替代关系。",
    ].join("\n"),
    permissions: [],
    examples: [],
  };
}
export function buildGuideDetail(topic: string, sources: GuideSources): GuideEntry | null {
  const id = topic.trim();
  if (!id) return null;
  if (id === "extensions") return { title: "extensions — 创建扩展", body: extensionAuthoringGuide(MODULE_PERMISSION_NAMES), permissions: [...MODULE_PERMISSION_NAMES], examples: [] };
  // 【T54】另一道门：`mcode-workflow` 那套工具。它不在 catalog 里（不是 RPC），
  // 所以必须在**域查找之前**判掉 —— 否则 `workflow-tools` 会被当成一个不存在的域。
  if (id === "workflow-tools") return workflowToolsDetail();

  const domainMethods = sources.catalog.filter((entry) => domainOfMethod(entry.method) === id);
  if (domainMethods.length > 0) return domainDetail(id, domainMethods, sources);

  const published = sources.published.find((p) => `workflow.run.${p.name}` === id);
  if (published) return publishedDetail(published);

  // 宿主内置命令（`mcode.file.*`）
  const builtin = sources.builtinCommands.find((c) => c.id === id);
  if (builtin) return builtinDetail(builtin);

  // 已安装扩展（`extension.<id>`）
  if (id.startsWith("extension.")) {
    const ext = (sources.installed ?? []).find((e) => `extension.${e.id}` === id);
    if (ext) return installedExtensionDetail(ext);
  }

  return null;
}

/* ───────────────────────── 内置命令 / 已安装扩展 ───────────────────────── */

/** 宿主内置命令的正文。**明确写「扩展可调、不走 RPC 表」** ——
 *  否则 agent 会拿 `mcode.file.inspect` 去 `app_api_call` 撞墙。 */
function builtinDetail(cmd: { id: string; summary: string }): GuideEntry {
  return {
    title: `${cmd.id} — 宿主内置命令`,
    body: [
      `**${cmd.id}** — ${cmd.summary}`,
      "",
      "## 谁能调",
      "- **VS Code 扩展**：`vscode.commands.executeCommand(\"" + cmd.id + "\", 入参)`。",
      "- **不在 `app_api_call` 的方法目录里** —— 它由宿主就地执行（不经 RPC 表），",
      "  所以 `app_api_list` / `app_api_describe` 按名字都查不到。这是**设计**，不是缺陷。",
      "",
      "## 为什么不进 RPC 表",
      "内置命令**优先于** RPC 表解析（`host.ts` 的 `$executeCommand` 先查内置表再派发），",
      "这样扩展注册同名命令**劫持不了**它们。把它塞进 RPC 表反而会削弱这条保护。",
    ].join("\n"),
    permissions: ["只读（就地执行，不弹审批）"],
    examples: [`vscode.commands.executeCommand("${cmd.id}", { path: "/path/to/file" })`],
  };
}

/** 已安装扩展的正文。**边界写在这里**：命令只有启动后才有。 */
function installedExtensionDetail(ext: GuideInstalledExtension): GuideEntry {
  const lines: string[] = [
    `**${ext.id}** v${ext.version}`,
    "",
    "## 状态",
    `- 启用：${ext.enabled ? "是" : "否"}`,
    `- 运行：${ext.running ? "是" : "否"}`,
    ...(ext.corrupted ? ["- **安装已损坏**：需要重装"] : []),
  ];

  if (ext.running && ext.commands && ext.commands.length > 0) {
    lines.push("", `## 它贡献的命令（${ext.commands.length} 条）`);
    const named = new Map((ext.commandContributions ?? []).map((c) => [c.id, c]));
    for (const id of [...ext.commands].sort((a, b) => a.localeCompare(b))) {
      const meta = named.get(id);
      const label = meta?.title ? ` — ${meta.category ? `${meta.category}: ` : ""}${meta.title}` : "";
      lines.push(`- \`${id}\`${label}`);
    }
    lines.push("", "扩展命令用 `vscode.commands.executeCommand(<id>)` 呼出（扩展之间、或 Mcode 命令面板）。");
  } else if (ext.running) {
    lines.push("", "## 命令", "它没有贡献任何命令（或命令表还在注册中）。");
  } else {
    // ⚠️ 这条边界必须写清楚 —— 否则 agent 会读成「这个扩展没有能力」。
    lines.push(
      "",
      "## 命令",
      "**未启动，所以看不到它有哪些命令。**",
      "",
      "这不是「它没有命令」—— VS Code / Theia 协议里，命令是扩展 `activate()` 时",
      "**自己注册**的，没有启动就没有这张表（VS Code 自己也一样）。",
      "要看它的命令：先在「设置 → UI 扩展」里启动它，再回来查。",
    );
  }

  return {
    title: `${ext.id} — 已安装扩展`,
    body: lines.join("\n"),
    permissions: ["扩展在自己的子进程里运行；安装时已告知它会起进程/联网"],
    examples: [],
  };
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

/* ───────────────────────── 小工具 ───────────────────────── */

/** 截断一句说明(只影响展示,不改变判据)。 */
function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
