/**
 * 【MC-040】控制 API 的**教程索引** —— "想做成 X,该按什么顺序调哪些方法"。
 *
 * ## 它补的是哪条洞
 *
 * `app_api_list`/`app_api_describe` 解决"有这个功能吗、参数长什么样";但"创建自动化"
 * 这类**任务**是一串方法按顺序调 + 若干约定(先建图、再存、再开触发器),单看任何一个
 * 方法的说明都拼不出来。台账红例:agent 找得到 `workflow.save` 也未必知道
 * "新建自动化 = newWorkflowDoc 形状的图 + trigger 字段 + automation.watch"。
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

export const APP_API_TUTORIALS: readonly AppApiTutorial[] = [
  {
    id: "create-automation",
    title: "创建一个自动化(事件驱动的图,常驻守望)",
    keywords: ["创建自动化", "新建自动化", "自动化", "守望", "定时", "触发", "automation", "watch", "trigger"],
    steps: [
      { method: "app_api_describe", note: "先 detail=\"full\" 看 workflow.save 的完整工作流结构(嵌套到节点/边)" },
      { method: "workflow.save", note: "存整份图:doc 里 nodes/edges + trigger 字段(触发器节点 mcode.trigger 也是普通节点)" },
      { method: "automation.watch", note: "把这份工作流挂进守望:它是「常驻监听 + 事件驱动运行」的入口,没有这步图只是静态文档" },
      { method: "automation.statusAll", note: "确认守望状态真的起来了" },
      { method: "automation.run", note: "想立刻手动跑一遍验证链路时用它(手动运行不等事件)" },
    ],
    pitfalls: [
      "workflow.save 要求整份图(不是增量 patch)—— 改之前先 workflow.get 拿当前版",
      "trigger 是节点图的一部分(触发器节点),不是 workflow 上的独立开关;边必须连上它",
      "守望是运行期状态:改完图记得 automation.watch 重挂,光保存不会自动生效",
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
