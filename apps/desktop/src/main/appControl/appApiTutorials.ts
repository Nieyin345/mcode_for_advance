/**
 * 【MC-040】控制 API 的**教程索引** —— "想做成 X,该按什么顺序调哪些方法"。
 *
 * ## 它补的是哪条洞
 *
 * `app_api_list`/`app_api_describe` 解决"有这个功能吗、参数长什么样";但"创建自动化"
 * 这类**任务**是一串方法按顺序调 + 若干约定(先建图、再存、再开触发器),单看任何一个
 * 方法的说明都拼不出来。台账红例:agent 找得到 `workflow.save` 也未必知道
 * "新建自动化 = newWorkflowDoc 形状的图 + trigger 字段 + Node-RED 部署"。
 *
 * ## 硬约定(与 MC-039 的目录同一份纪律)
 *
 * 1. **步骤里引用的每个方法都必须真实存在于目录** —— `app-control-smoke` 用生成目录
 *    逐条核对;方法改名而教程没跟 → 测试红(防"过期示例")。
 * 2. **不复制执行/授权逻辑**:教程只给顺序与要点,权限仍由宿主按方法各自判定。
 * 3. 中英任务词可检索 —— 与 `DOMAIN_TASK_ALIASES` 同一口径(子串匹配)。
 * 4. 内容是**代码常量**,不读文档文件 —— 打包后的应用里 `docs/` 不存在,教程必须
 *    在二进制里(这也是与 "docs/custom-ui.md 没连上" 那条台账判语的差别:连接的是
 *    不依赖文件系统的常量索引,不是把 md 读进来)。
 */

export interface AppApiTutorial {
  /** 稳定的短 id(测试引用它)。 */
  id: string;
  /** 标题(人话任务名)。 */
  title: string;
  /** 检索词(中英,子串匹配;与 DOMAIN_TASK_ALIASES 同口径)。 */
  keywords: readonly string[];
  /** 步骤:按顺序的方法 + 一句话要点。`method` 必须是目录里真实存在的方法。 */
  steps: ReadonlyArray<{ method: string; note: string }>;
  /** 常见坑(显式写出来,免得模型按直觉猜)。 */
  pitfalls?: readonly string[];
}

/**
 * T51: full extension authoring topic, packaged into the application (not a docs/
 * file lookup). The permission list is supplied by the canonical contracts source.
 * NOTE: program.source is an OBJECT EXPRESSION evaluated by the isolated runner,
 * not a CommonJS exports.* module; ModuleResult is a flat scalar record.
 */
export function extensionAuthoringGuide(permissions: readonly string[]): string {
  const manifest = {
    apiVersion: 1,
    id: "user.line-counter",
    version: "1.0.0",
    title: { zh: "行数统计", en: "Line counter" },
    permissions: ["files.read"],
    contributions: [{
      id: "count", slot: "files.context",
      title: { zh: "统计行数", en: "Count lines" },
      extensions: [".ts", ".js", ".md"],
      capability: "module.count",
      view: { title: { zh: "行数统计", en: "Line count" },
        fields: [{ key: "lines", title: { zh: "行数", en: "Lines" } }] },
    }],
    program: {
      source: '({ count: async (resource) => { const fs = require("node:fs"); const content = fs.readFileSync(resource.path, "utf8"); return { lines: content.split("\\n").length }; } })',
      timeoutMs: 10000,
    },
  };
  return [
    "# extensions — AI 编写 Mcode 扩展",
    "",
    "## a) manifest 清单（完整可安装格式）",
    "清单是一个 JSON 对象，下面的 program.source 是 JavaScript 对象表达式（不是 exports.count）。",
    "```json", JSON.stringify(manifest, null, 2), "```",
    "贡献点支持 files.context（文件菜单，须带 view.title 和 view.fields）、command（命令名）、view（视图）、settings（设置项）；各自必填字段与可用图标按 ModuleContributionSchema 校验。",
    "capability 必须写 module.<短名>；宿主在安装时分配 module.<模块 slug>.<短名>，不要自行拼完整 id。",
    "",
    "## b) 可申请权限（来自 ModulePermissionSchema）",
    ...permissions.map(p => "- `" + p + "` — " + (({
      "files.read": "读文件", "files.write": "写文件", "resource.read": "访问当前资源",
      "resource.write": "修改当前资源", "session.send": "向对话发送内容",
      "workflow.run": "运行工作流", "library.read": "读资料库", "network": "网络访问（须满足 OS 沙箱）",
    } as Record<string, string>)[p] ?? "相应功能域权限")),
    "",
    "## c) 常用 API（面板与隔离扩展不能混用）",
    "- file.readFile / file.writeFile：文件读写；分别需 files.read / files.write。",
    "- claude.startSession / claude.sendTurn：创建 AI 对话并发送请求；需 session.send（session.send 不是 RPC 方法）。",
    "- workflow.run：运行工作流；需 workflow.run。",
    "- library.search：搜资料库；需 library.read。",
    "- extensionStore.get / extensionStore.set：扩展存储；需 modules.read / modules.write。",
    "- document.read：读文档；依实际映射查看。",
    "使用 app_api_list({query}) 查其余方法，app_api_describe({method}) 查实际参数。",
    "这些方法经 T49 的宿主 core.app.call 桥接，在隔离 program 子进程中用 await mcode.api.call(method,input) 调用；每次由宿主校验扩展身份和已获权限，代码不能自行授权。",
    "",
    "## d) 可运行的最小程序",
    "```js", manifest.program.source, "```",
    "它用 Node 内置 fs 读取**本次经宿主校验并授权的 resource.path**，返回 {lines:number}。",
    "ModuleResult 必须是扁平对象，值只能是 string/number/boolean/null，不能返回 {ok, fields} 嵌套对象。",
    "",
    "## d2) 谁能装 —— 你只能准备，装不了",
    "**Agent 没有安装扩展的能力，这是设计。** 可执行扩展的安装 / 试运行在 `BLOCKED` 档：",
    "- `modules.theiaInstalled`（持久安装 / 启停 / 卸载 .vsix）—— 只能桌面用户本人操作；",
    "- `modules.theiaPreview`（临时试运行）—— 需要一枚**一次性 ticket**，只能由用户在设置页发起。",
    "两条都要求「用户本人的新鲜动作」，Agent 自授权够不到。**所以 d) 段那个程序你写得出来、验得出来，但跑不起来。**",
    "正确的交付方式是**交接到用户手上**：",
    "1. `extension_validate({manifest})` —— 形状 / 权限 / 程序工厂都过一遍，拿 `installable`；",
    "2. 把清单与 `program.source` 原样交给用户，说明它要哪些权限、会碰什么；",
    "3. 用户在 **设置 → UI 扩展** 里装（或自己打成 `.vsix` 再装）。**不要**替用户点，也不要伪造 ticket。",
    "装完之后它贡献的命令 / 菜单才会出现在界面上；`app_guide` 的「已装扩展」一节能看到它们。",
    "",
    "## e) 常见错误",
    "- 忘记 permissions：Schema 拒绝安装，运行时 API 越权也会拒绝。",
    "- require('http') / 网络访问：未声明 network 时守卫拦截；Windows 无可验证 OS 沙箱时默认拒绝可执行扩展，需用户在设置里显式确认风险降级。",
    "- 返回 {ok:true,fields:{...}}：不符合 ModuleResult 的扁平标量形状，调用失败。",
    "- program.source 写成 exports.count：工厂求值不是对象，安装核验失败。",
    "- 把 session.send 当成真实 RPC 方法：实际使用 claude.startSession / claude.sendTurn，调用前先用 app_api_list 核实。",
    "- **去调 `modules.install` / `modules.installVsix` / `modules.remove`**：这三个方法**已经不存在**（ModuleHost 那一代已整体删除，现存的是 Theia VSIX 那条路）。调它只会得到「没有这个方法」。装扩展的入口只有 d2 段那两条，且都不给 Agent。",
    "",
    "## 安装的批准",
    "扩展安装**不是**「一个高风险 Agent 操作」，而是**Agent 根本够不到的操作**（见 d2）。" +
    "清单权限与它会调用的 API 要在交接给用户时说清楚 —— 让用户知道自己批的是什么，而不是让 Agent 代批。",
  ].join("\n");
}

export const APP_API_TUTORIALS: readonly AppApiTutorial[] = [
  {
    id: "create-automation",
    title: "创建一个自动化(事件触发的图)",
    keywords: ["创建自动化", "新建自动化", "自动化", "定时", "触发", "automation", "watch", "trigger"],
    steps: [
      { method: "app_api_describe", note: "先 detail=\"full\" 看 workflow.save 的完整工作流结构(嵌套到节点/边)" },
      { method: "workflow.save", note: "存整份图:doc 里 nodes/edges + trigger 字段(触发器节点 mcode.trigger 也是普通节点)" },
      { method: "automation.statusAll", note: "确认触发器真的挂上了" },
      { method: "automation.run", note: "想立刻手动跑一遍验证链路时用它(手动运行不等事件)" },
    ],
    pitfalls: [
      "workflow.save 要求整份图(不是增量 patch)—— 改之前先 workflow.get 拿当前版",
      "trigger 是节点图的一部分(触发器节点),不是 workflow 上的独立开关;边必须连上它",
      "触发器是运行期状态:Node-RED 引擎没起或这张图没部署时它不会响",
    ],
  },
  {
    id: "create-custom-panel",
    title: "创建自定义面板/扩展界面",
    keywords: ["创建面板", "自定义面板", "扩展界面", "挂载位", "槽位", "custom panel", "custom ui", "slot"],
    steps: [
      { method: "app_panel_api_list", note: "先看面板 API(window.mcode)、各挂载位能用的动作类型与模板变量 —— 面板的能力边界全在这份清单里" },
      { method: "setting.get", note: "读 customUi.config.v1 拿现有面板配置(先读再写,别整份覆盖)" },
      { method: "setting.set", note: "写回整份配置:条目 id 必须唯一、保留未修改的条目与布局" },
    ],
    pitfalls: [
      "面板跑在隔离 iframe 里,拿不到 node/preload;要调主进程方法必须在面板里 mcode.api.call(method, input)",
      "动作类型是按挂载位白名单的(ACTIONS_BY_SLOT)—— 在别的槽位用会失败",
    ],
  },
  {
    id: "create-workflow-with-agent",
    title: "写一份带 agent 节点的工作流",
    keywords: ["创建工作流", "节点", "图", "agent 节点", "workflow", "node", "graph"],
    steps: [
      { method: "workflow.list", note: "看现状(有没有同名的)" },
      { method: "workflow.nodeTypes", note: "看有哪些节点类型可用、各自参数清单(必填/类型)" },
      { method: "app_api_describe", note: "detail=\"full\" 看 workflow.save 的完整嵌套结构" },
      { method: "workflow.save", note: "存图;节点 params 的合法性由节点类型清单校验" },
    ],
    pitfalls: [
      "节点 params 只当「袋子」,值合法与否按该节点类型的清单判 —— 先 nodeTypes 看清单",
    ],
  },
  {
    id: "import-library-paper",
    title: "把一篇论文导入资料库并挂到对话",
    keywords: ["导入论文", "导入文献", "资料库", "paper", "import", "library"],
    steps: [
      { method: "library.listCollections", note: "找目标分类(没有就先建)" },
      { method: "library.importFiles", note: "把本地 PDF/文件导入(或 library.importUrl 从网址)" },
      { method: "library.list", note: "拿到条目 id(导入是异步转 Markdown,可能需要等)" },
      { method: "library.attachToChat", note: "把条目挂到当前对话,模型才能读它" },
    ],
  },
  {
    id: "engine-model-config",
    title: "设置引擎/模型(Claude / Pi / Codex)",
    keywords: ["设置引擎", "配置模型", "切换模型", "自定义模型", "provider", "model", "engine"],
    steps: [
      { method: "provider.list", note: "看有哪些引擎与可用模型" },
      { method: "customModel.save", note: "自定义网关(Claude 系):地址/密钥/模型清单" },
      { method: "piModels.save", note: "Pi 的模型提供方(Pi 系)" },
      { method: "codexModels.save", note: "Codex 的模型提供方(Codex 系)" },
      { method: "provider.healthCheck", note: "存完做一次连通性/健康检查,别等第一次跑才炸" },
    ],
  },
  {
    id: "handoff-memory",
    title: "把当前对话交接给另一个对话(记忆助手)",
    keywords: ["交接", "记忆助手", "handoff", "memory assistant"],
    steps: [
      { method: "memory.assistant", note: "op=\"start\" 起整理任务(kind=checkpoint),轮询 status 到 ready" },
      { method: "memory.assistant", note: "op=\"deliver\" 带着 jobId + targetSessionId 投递到目标对话" },
      { method: "session.listAll", note: "找同项目里的目标对话 id" },
    ],
    pitfalls: [
      "目标对话必须同项目、是 chat/side 类型、未归档 —— 否则交接被拒",
      "一次只能有一个待接收的交接包",
    ],
  },
];

/** 【MC-040】按任务词检索教程(与 `domainsMatchingTaskWord` 同口径的子串匹配)。 */
export function tutorialsMatchingWord(query: string): AppApiTutorial[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return APP_API_TUTORIALS.filter(
    (t) =>
      t.title.toLowerCase().includes(q) ||
      t.keywords.some((k) => k.toLowerCase().includes(q) || q.includes(k.toLowerCase())) ||
      t.id.includes(q),
  );
}
