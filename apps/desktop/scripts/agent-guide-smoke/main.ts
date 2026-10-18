/**
 * 【ARC-002】`app_guide(topic)` 统一教程入口的回归网。
 *
 * 覆盖三件事:
 *   1. **topic 清单真的从权威源派生**(不是第二份手写清单):纯派生核喂改过的
 *      catalog / DOMAIN_LABELS / 发布表 / 扩展目录 → 清单跟着变;
 *   2. `guideFor` 的正文含权限档与可复制示例,示例参数**从 catalog 的 input 形状派生**;
 *   3. 未知 topic 返回 null,工具给出「没有这个 topic + 现有列表」;
 *   4. 扩展能力 topic 点明 `resource.write` / `network` 是**逐次批准**(与
 *      ModuleHost.invoke 的真实分支同口径)。
 *
 * 活路径(真 DB + 真 ModuleHost)那一段:`guideTopics()` 经 `currentGuideSources()` 取
 * `API_CATALOG` / `DOMAIN_LABELS` / `publishedToolsWithDocs()` / `getModuleHost().catalog()`
 * —— 发布一份工作流后 topic 出现、撤销后消失,证明的是**真实装配**而不只是纯函数。
 * 数据根由 run.sh 的 mktemp 提供(`SettingRepo` 走内存桩,`WorkflowRepo` 走真库)。
 *
 * Run: scripts/agent-guide-smoke/run.sh
 */
import type { ProviderContext } from "@contracts/provider";
import type { ModuleCapabilityDescriptor } from "@contracts/moduleCapability";
import { ModuleCatalogSchema } from "@contracts/moduleCapability";
import { MODULE_CAPABILITY_PREFIX, type ModuleManifest } from "@contracts/modules";
import { API_CATALOG, type ApiCatalogEntry } from "@main/appControl/apiCatalog.generated.js";
import { DOMAIN_LABELS, domainOfMethod, policyFor } from "@main/appControl/policy.js";
import {
  buildGuideDetail,
  buildGuideTopics,
  guideFor,
  guideTopics,
  type GuideSources,
} from "@main/appControl/guide.js";
import {
  findEntry,
  invokeAppTool,
  appMcpTools,
  APP_READONLY_TOOLS,
} from "@main/appControl/tools.js";
import { __clearSettings } from "./stubs/repositories.js";

let total = 0;
let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) console.log("  ok   " + name);
  else {
    failures++;
    console.log("  FAIL " + name + (detail === undefined ? "" : " — " + JSON.stringify(detail)));
  }
}
const textOf = (r: { content: Array<{ type: string; text?: string }> }): string =>
  r.content.map((c) => (c.type === "text" ? c.text ?? "" : "")).join("\n");
const ctx = {} as ProviderContext;

/* ───────────────────────── 夹具 ───────────────────────── */

/** 一条最小的目录项(catalog 的其余字段对本套无意义,照形状补齐)。 */
function entry(method: string, input: string, doc = ""): ApiCatalogEntry {
  return { method, channel: method.replace(".", ":"), doc, input, inputFull: input, output: "unknown" };
}

/** 纯派生核的输入。默认三域三方法,按用例覆盖。 */
function fixtureSources(over: Partial<GuideSources> = {}): GuideSources {
  return {
    catalog: [
      entry("alpha.one", "{ query: string; limit?: number | undefined }", "按关键词查"),
      entry("alpha.two", "(无参数)", "列全部"),
      entry("beta.one", "{ path: string // 带行内注释的形状,本套不猜它 }", "带注释"),
    ],
    domainLabels: { alpha: "甲域", beta: "乙域" },
    published: [],
    modules: null,
    policy: policyFor,
    ...over,
  };
}

const DOMAIN = "user.guide.demo";
const demoManifest: ModuleManifest = {
  apiVersion: 1,
  id: DOMAIN,
  version: "1.0.0",
  title: { zh: "指南演示扩展", en: "Guide demo extension" },
  // 一个模块同时声明写与联网 —— 正是"逐次批准"两条分支都要被讲到的形状。
  permissions: ["resource.read", "resource.write", "network"],
  contributions: [
    {
      id: "convert",
      slot: "files.context",
      title: { zh: "转换文件", en: "Convert file" },
      capability: "module.convert",
      view: { title: { zh: "结果", en: "Result" }, fields: [{ key: "text", title: { zh: "文本", en: "Text" } }] },
    },
    {
      id: "probe",
      slot: "files.context",
      title: { zh: "探测", en: "Probe" },
      capability: "module.probe",
      view: { title: { zh: "探测结果", en: "Probe result" }, fields: [{ key: "ok", title: { zh: "成功", en: "OK" } }] },
    },
  ],
  program: { source: "({ convert: async () => ({ text: 'ok' }), probe: async () => ({ ok: true }) })" },
};

const convertMetadata: ModuleCapabilityDescriptor["metadata"] = {
  schemaVersion: 1,
  version: "1.0.0",
  title: { zh: "扩展转换", en: "Extension convert" },
  description: { zh: "读取选中的文件并写回转换结果。", en: "Read the selected file and write the converted result." },
  permissions: ["resource.read", "resource.write"],
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  supportsCancellation: false,
};
const probeMetadata: ModuleCapabilityDescriptor["metadata"] = {
  schemaVersion: 1,
  version: "1.0.0",
  title: { zh: "扩展探测", en: "Extension probe" },
  description: { zh: "联网查询远端状态。", en: "Query remote status over the network." },
  permissions: ["resource.read"],
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  supportsCancellation: false,
};

const fixtureModules = {
  modules: [demoManifest],
  capabilities: [
    { id: "module.guide.demo.convert", kind: "action", metadata: convertMetadata },
    { id: "module.guide.demo.probe", kind: "query", metadata: probeMetadata },
  ] satisfies ModuleCapabilityDescriptor[],
};

/* ───────────────────────── §1 清单从权威源派生(纯函数)───────────────────────── */
console.log("\n§1 topic 清单从权威源派生(纯函数)");
{
  const sources = fixtureSources();
  const topics = buildGuideTopics(sources);
  const domainIds = topics.filter((t) => t.kind === "domain").map((t) => t.id);
  check("守卫:夹具目录非空", sources.catalog.length === 3, sources.catalog.length);
  check("域 topic = catalog 里出现过的域,不多不少", JSON.stringify(domainIds) === JSON.stringify(["alpha", "beta"]), domainIds);
  check(
    "域标题来自 DOMAIN_LABELS(alpha → 甲域)",
    topics.find((t) => t.id === "alpha")?.title === "alpha — 甲域",
    topics.find((t) => t.id === "alpha"),
  );

  const renamed = buildGuideTopics(fixtureSources({ domainLabels: { alpha: "改名后的甲域", beta: "乙域" } }));
  check(
    "★ 改一条 DOMAIN_LABELS → topic 标题跟着变(证明派生,不是快照)",
    renamed.find((t) => t.id === "alpha")?.title === "alpha — 改名后的甲域",
    renamed.find((t) => t.id === "alpha"),
  );

  const extended = buildGuideTopics(fixtureSources({ catalog: [...sources.catalog, entry("delta.one", "(无参数)")] }));
  check(
    "★ 加一条 catalog 项 → 多一个域 topic",
    extended.some((t) => t.kind === "domain" && t.id === "delta"),
    extended.filter((t) => t.kind === "domain").map((t) => t.id),
  );

  const withPublished = buildGuideTopics(
    fixtureSources({
      published: [
        { workflowId: "wf_demo", name: "文献整理", docName: "文献整理流程", description: "把一篇文献做结构化整理", paramsHint: "{ paperId: string }" },
      ],
    }),
  );
  const tool = withPublished.find((t) => t.kind === "workflow-tool");
  check("★ 已发布的工作流工具各一条 topic(workflow.run.<名字>)", tool?.id === "workflow.run.文献整理", tool);
  check("发布工具 topic 的摘要带工作流名", tool?.summary.includes("文献整理流程") === true, tool?.summary);

  const withModules = buildGuideTopics(fixtureSources({ modules: fixtureModules }));
  const caps = withModules.filter((t) => t.kind === "extension-capability");
  check(
    "★ 每个已装扩展能力一条 topic(含 action 与 query)",
    caps.length === 2 && caps.some((t) => t.id === "module.guide.demo.convert") && caps.some((t) => t.id === "module.guide.demo.probe"),
    caps.map((t) => t.id),
  );

  const noModules = buildGuideTopics(fixtureSources({ modules: null, moduleCatalogError: "宿主未就绪" }));
  check(
    "扩展目录取不到时仍返回域 topic(不把整个清单拖垮)",
    noModules.every((t) => t.kind === "domain") && noModules.length === 2,
    noModules.map((t) => t.id),
  );
}

/* ───────────────────────── §2 guideFor 的正文(纯函数)───────────────────────── */
console.log("\n§2 guideFor 的正文:权限档 + 示例");
{
  const sources = fixtureSources();
  const detail = buildGuideDetail("alpha", sources);
  check("守卫:alpha 有详情", detail !== null, detail);
  check("正文含「权限档」段", detail!.body.includes("## 权限档"), detail!.body.slice(0, 120));
  const levels = new Set(sources.catalog.filter((e) => e.method.startsWith("alpha.")).map((e) => sources.policy(e.method).level));
  const labelOf: Record<string, string> = { read: "只读·自动", ui: "界面·自动", write: "需批准", danger: "高风险·每次批准", blocked: "不开放" };
  const missing = [...levels].filter((level) => !detail!.body.includes(labelOf[level]!));
  check("★ 每个方法实际档位的标签都出现在正文里", missing.length === 0, { levels: [...levels], missing });
  check("示例段含可复制的 app_api_call", detail!.examples.length >= 1 && detail!.body.includes("app_api_call({"), detail!.examples);

  const example = detail!.examples[0]!;
  check(
    "★ 示例参数从 catalog 的 input 形状派生:只取必填字段(query),可选 limit 不出现",
    example.includes('"method": "alpha.one"') && example.includes('"query":"<string>"') && !example.includes("limit"),
    example,
  );

  // 带行内注释的形状不解析:退回无参调用形式,绝不猜字段。
  const beta = buildGuideDetail("beta", sources);
  check(
    "★ 形状带注释的方法不给猜出来的参数(退回无参调用形式)",
    beta!.examples[0] === 'app_api_call({ "method": "beta.one" })',
    beta!.examples,
  );

  const gammaSources = fixtureSources({
    catalog: [entry("gamma.one", "{ x: string }"), entry("gamma.two", "(无参数)")],
    domainLabels: { gamma: "丙域" },
    policy: (m) => (m.startsWith("gamma.") ? { level: "blocked", reason: "不开放给 agent" } : policyFor(m)),
  });
  const gamma = buildGuideDetail("gamma", gammaSources);
  check(
    "★ 全 blocked 的域不给可复制示例,并明说原因",
    gamma !== null && gamma.examples.length === 0 && gamma.body.includes("没有可复制的示例") && gamma.body.includes("不开放"),
    gamma === null ? null : { examples: gamma.examples, tail: gamma.body.slice(-160) },
  );

  check("未知 topic → null", buildGuideDetail("zzz-not-a-topic", sources) === null);
}

/* ───────────────────────── §3 扩展能力:逐次批准口径(纯函数)───────────────────────── */
console.log("\n§3 扩展能力 topic:write / network 逐次批准");
{
  // 守卫:夹具必须是**合法目录形状**(否则测的是不可能的目录)。schema 接受 unknown,
  // 解析通过 = 这份 extensions 目录与生产里 ModuleHost.catalog() 的产物同形。
  const parsed = ModuleCatalogSchema.safeParse(fixtureModules);
  check("守卫:扩展目录夹具通过 ModuleCatalogSchema(与生产目录同形)", parsed.success, parsed.success ? "" : parsed.error.issues);
  check("守卫:能力 id 用的是宿主分配前缀", MODULE_CAPABILITY_PREFIX === "module." && fixtureModules.capabilities[0]!.id.startsWith("module.guide.demo."), fixtureModules.capabilities.map((c) => c.id));

  const sources = fixtureSources({ modules: fixtureModules });
  const action = buildGuideDetail("module.guide.demo.convert", sources);
  check("守卫:action 能力有详情", action !== null, action);
  check(
    "★ action 能力点明 resource.write 每次执行都要批准(安装时声明只是资格)",
    action!.body.includes("resource.write") && action!.body.includes("每次执行前都会弹审批卡") && action!.body.includes("安装时声明"),
    action!.body,
  );
  check(
    "★ action + network 点明联网也要逐次批准(与写审批同一张卡)",
    action!.body.includes("network") && action!.body.includes("逐次批准"),
    action!.permissions,
  );

  const probe = buildGuideDetail("module.guide.demo.probe", sources);
  check(
    "★ 只读 + network 能力点明「每次调用前单独弹联网审批、逐次批准」",
    probe !== null && probe.body.includes("每次调用前单独弹联网审批") && probe.body.includes("逐次批准"),
    probe?.permissions,
  );

  check(
    "★ modules.invoke 示例用的是真实模块/贡献身份与工作区占位",
    action!.examples[0]!.includes('"moduleId":"user.guide.demo"') &&
      action!.examples[0]!.includes('"contributionId":"convert"') &&
      action!.examples[0]!.includes("projectPath"),
    action!.examples,
  );
}

/* ───────────────────────── §4 活路径:真 DB + 真 ModuleHost ───────────────────────── */
console.log("\n§4 活路径:权威源 → guideTopics / guideFor / app_guide");
const { initDb } = await import("@main/store/db.js");
const lib = await import("@main/orchestration/library.js");
const pt = await import("@main/orchestration/publishedTools.js");
__clearSettings();
await initDb();

{
  const topics = await guideTopics();
  const domainIds = topics.filter((t) => t.kind === "domain").map((t) => t.id).sort();
  const catalogDomains = [...new Set(API_CATALOG.map((e) => domainOfMethod(e.method)))].sort();
  check("守卫:活路径至少取到 40 个功能域(防断言空过)", domainIds.length > 40, domainIds.length);
  check("★ 活路径域 topic 集 = API_CATALOG 出现过的域集(逐条对齐,不是数量近似)", JSON.stringify(domainIds) === JSON.stringify(catalogDomains), {
    onlyTopics: domainIds.filter((d) => !catalogDomains.includes(d)),
    onlyCatalog: catalogDomains.filter((d) => !domainIds.includes(d)),
  });
  const labelMismatch = topics
    .filter((t) => t.kind === "domain")
    .filter((t) => t.title !== `${t.id} — ${DOMAIN_LABELS[t.id] ?? "(没有域标签)"}`);
  check("★ 活路径每个域 topic 的标题与 DOMAIN_LABELS 逐字一致", labelMismatch.length === 0, labelMismatch.slice(0, 3));

  const capIds = topics.filter((t) => t.kind === "extension-capability").map((t) => t.id);
  check(
    "★ 活路径含真 ModuleHost.catalog() 里的内置能力(core.file.inspect / core.file.info)",
    capIds.includes("core.file.inspect") && capIds.includes("core.file.info"),
    capIds,
  );

  const setting = await guideFor("setting");
  check("守卫:setting 域有指南", setting !== null, setting);
  check(
    "★ 活路径示例来自真 catalog:setting.get 的 key 占位符",
    setting!.examples.some((ex) => ex.includes('"method": "setting.get"') && ex.includes('"key":"<string>"')),
    setting!.examples,
  );
}

// 发布一份工作流 → topic 出现 → 指南带参数与权限 → 撤销后消失。
{
  const doc = {
    id: "wf_arc002_guide",
    name: "指南演示流程",
    builtin: false,
    updatedAt: Date.now(),
    prompt: "整理这篇文献。",
    inputSchema: {
      type: "object",
      required: ["paperId"],
      properties: { paperId: { type: "string", description: "文献条目 id" }, depth: { type: "integer", description: "整理深度" } },
    },
    nodes: [],
    edges: [],
  };
  const saved = await lib.saveWorkflow(doc as never, { expectedRevision: null } as never);
  check("守卫:工作流真的存进了库", (saved as { ok?: boolean }).ok !== false && lib.getWorkflow(doc.id) !== null, saved);
  const pub = pt.publishWorkflowTool({ workflowId: doc.id, name: "指南演示工具", description: "把一篇文献做结构化整理" });
  check("守卫:发布成功", pub.ok === true, pub);

  const topics = await guideTopics();
  const toolTopic = topics.find((t) => t.id === "workflow.run.指南演示工具");
  check("★ 发布后活路径清单出现 workflow.run.<名字>(来自 publishedToolsWithDocs)", toolTopic?.kind === "workflow-tool", toolTopic);

  const detail = await guideFor("workflow.run.指南演示工具");
  check("守卫:发布工具的指南存在", detail !== null, detail);
  check(
    "★ 发布工具指南:参数来自工作流 inputSchema(paperId)且权限写「需批准」",
    detail!.body.includes("paperId") && detail!.body.includes("需批准") && detail!.body.includes(doc.id),
    detail!.body,
  );

  // 工具层:不传参数列 topic;传 topic 给正文;未知 topic 给「没有 + 现有列表」。
  const list = await invokeAppTool("app_guide", {}, "me", ctx);
  const listText = textOf(list);
  check(
    "★ app_guide 不带参数:列出功能域与扩展能力(含 library 与 core.file.inspect)",
    !list.isError && listText.includes("library") && listText.includes("core.file.inspect") && listText.includes("workflow.run.指南演示工具"),
    listText.slice(0, 400),
  );

  const hit = await invokeAppTool("app_guide", { topic: "workflow.run.指南演示工具" }, "me", ctx);
  check("★ app_guide({topic}) 返回该 topic 的正文(参数 + 权限 + 示例)", textOf(hit).includes("paperId") && textOf(hit).includes("## 示例"), textOf(hit).slice(0, 300));

  const builtin = await invokeAppTool("app_guide", { topic: "core.file.inspect" }, "me", ctx);
  check(
    "★ app_guide 能展开真宿主里的内置能力(不弹审批口径;它是 task 类,正文点明要起任务)",
    textOf(builtin).includes("core.file.inspect") && textOf(builtin).includes("执行不弹审批") && textOf(builtin).includes("task 能力"),
    textOf(builtin).slice(0, 300),
  );

  const miss = await invokeAppTool("app_guide", { topic: "zzz-not-a-topic" }, "me", ctx);
  const missText = textOf(miss);
  check(
    "★ 未知 topic:报「没有这个 topic」并附现有 topic 列表",
    miss.isError === true && missText.includes("没有这个 topic") && missText.includes("library") && missText.includes("core.file.inspect"),
    missText.slice(0, 300),
  );

  pt.unpublishWorkflowTool(doc.id);
  const after = await guideTopics();
  check("★ 撤销发布后 topic 从清单消失", !after.some((t) => t.id === "workflow.run.指南演示工具"), after.filter((t) => t.kind === "workflow-tool").map((t) => t.id));
}

// 工具注册方式:与 app_api_list 一样是 Agent 自带工具,**不走 app_api_call**。
{
  check("★ app_guide 不是 RPC 方法(findEntry 查不到;它不经 app_api_call)", findEntry("app_guide") === undefined);
  check("★ app_guide 在只读工具集里(自动放行,不问审批)", APP_READONLY_TOOLS.has("app_guide"));
  check("★ app_guide 已登记进工具表", appMcpTools().some((t) => t.name === "app_guide"));
  const unknown = await guideFor("zzz-not-a-topic");
  check("活路径未知 topic 返回 null", unknown === null);
}

console.log(`\nagent-guide-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exitCode = 1;
