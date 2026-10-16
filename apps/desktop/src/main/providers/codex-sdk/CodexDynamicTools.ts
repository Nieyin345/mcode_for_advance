/**
 * Codex 引擎的**动态工具清单**（从 `CodexAgentSdkProvider.ts` 拆出）。
 *
 * `buildDynamicTools` 把各 engineTools 的描述子拼成 thread/start 要的 JSON-schema
 * 函数表。只依赖 `agentToolDescriptors` / `appToolDescriptors` / `libraryToolDescriptors`
 * / `memoryToolDescriptors` / `workflowEngineBridge` 与 `BROWSER_TOOL_SPECS`。
 * **纯搬迁，函数体逐字节一致。**
 */
import { memoryToolDescriptors } from "@main/memory/engineTools.js";
import { appToolDescriptors } from "@main/appControl/engineTools.js";
import { libraryToolDescriptors } from "@main/library/engineTools.js";
import { workflowEngineBridge } from "@main/mcp/workflowEngineTools.js";
import { agentToolDescriptors } from "@main/mcp/agentEngineBridge.js";
import { BROWSER_TOOL_SPECS } from "@main/browser/agentBrowserTools.js";

/** JSON-schema function descriptors handed to thread/start. Names use
 *  snake_case (codex tool conventions).
 *
 *  【MC-100/101】导出给 `orchestration/effectiveToolInventory.ts` 的**只读诊断**复用 ——
 *  诊断要报「模型会看到哪些 dynamicTools」,必须拿**同一份**构造,不能另抄一张名字表
 *  (硬规矩 2:共享实现只有一份)。导出只是把它变可见,不改变任何派发行为。 */
export function buildDynamicTools(browserToolsEnabled: boolean): Array<Record<string, unknown>> {
  const tools: Array<Record<string, unknown>> = [
    ...memoryToolDescriptors(),
    // mcode-app —— 控制 Mcode 本身(全部功能 + 界面操作)。审批在 invokeAppEngineTool 里按功能分档做。
    ...appToolDescriptors(),
    // 资料库工具 —— Codex 没有进程内 MCP,不在这里挂的话 library_* 一个都没有,
    // 内置工作流的入库 / 挂 PDF / 挂转录会落空。审批在 invokeDynamicTool 那一支做。
    ...libraryToolDescriptors(),
    // 工作流工具(工作流 / 节点类型 / 代理档案 / 对话记录 / 代理通信)—— 同理,审批也在
    // invokeDynamicTool 那一支。见 mcp/workflowEngineTools.ts。
    ...workflowEngineBridge.descriptors(),
    // Agent 只读工具(统一文档/图片读取 + 环境概况)。Codex 没有进程内 MCP,不在这里挂就
    // 一个都没有 —— agent_read_document 处理 PDF/DOCX/XLSX/PPTX,是 Codex 壳命令读不了的
    // 那类。审批在 invokeDynamicTool 那一支做(只读的 invokeGated 直接过)。
    // 见 mcp/agentEngineBridge.ts。
    ...agentToolDescriptors().map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
    {
      type: "function",
      name: "ask_user_question",
      description:
        "Ask the user a question when you need information or a decision. " +
        "Provide a clear question and 2-4 options. After calling this tool, STOP and wait for the answer.",
      inputSchema: {
        type: "object",
        properties: {
          questions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                header: { type: "string", description: "A short label for the question" },
                question: { type: "string", description: "The full question text" },
                multiSelect: { type: "boolean", description: "Whether multiple options can be selected" },
                options: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      label: { type: "string" },
                      description: { type: "string" },
                    },
                    required: ["label"],
                  },
                },
              },
              required: ["header", "question", "multiSelect", "options"],
            },
          },
        },
        required: ["questions"],
      },
    },
    {
      type: "function",
      name: "enter_plan_mode",
      description:
        "进入计划模式:先只读调研、必要时经用户逐项审批做验证,然后用 exit_plan_mode 提交计划。",
      inputSchema: { type: "object", properties: {} },
    },
    {
      type: "function",
      name: "exit_plan_mode",
      description:
        "提交你的执行计划给用户审批。批准后退出计划模式开始执行;拒绝则留在计划模式修改计划。",
      inputSchema: {
        type: "object",
        properties: {
          plan: { type: "string", description: "完整的执行计划(Markdown),包含目标、步骤、影响范围" },
        },
        required: ["plan"],
      },
    },
  ];
  // Browser tools (read-only trio + side-effect ones) — descriptions come
  // from the shared spec so Claude/Pi/Codex stay in sync. Gated by the MCP
  // panel's builtin-browser switch (same flag Claude's in-process MCP server
  // uses).
  if (!browserToolsEnabled) return tools;
  const schema = (props: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
    type: "object",
    properties: props,
    ...(required.length ? { required } : {}),
  });
  const optId = { type: "string", description: "目标浏览器视图 id;省略则用第一个已开视图" };
  tools.push(
    {
      type: "function",
      name: "browser_list",
      description: BROWSER_TOOL_SPECS.browser_list.description,
      inputSchema: schema({}),
    },
    {
      type: "function",
      name: "browser_navigate",
      description: BROWSER_TOOL_SPECS.browser_navigate.description,
      inputSchema: schema({
        url: { type: "string", description: "目标 URL,http(s):// 网页或 file:/// 本地文件" },
        device: { type: "string", enum: ["desktop", "iphone", "android"], description: "打开方式:desktop(PC 全宽,默认)/iphone(移动端)/android(移动端),仅新建视图时生效" },
        newTab: { type: "boolean", description: "true=强制新开一个标签页再导航" },
        browserId: optId,
      }, ["url"]),
    },
    {
      type: "function",
      name: "browser_snapshot",
      description: BROWSER_TOOL_SPECS.browser_snapshot.description,
      inputSchema: schema({ browserId: optId }),
    },
    {
      type: "function",
      name: "browser_click",
      description: BROWSER_TOOL_SPECS.browser_click.description,
      inputSchema: schema({
        index: { type: "number", description: "要点击元素的索引(来自最近一次 browser_snapshot 的 [n]),优先使用" },
        selector: { type: "string", description: "要点击元素的 CSS selector(index 的替代写法)" },
        coordinateX: { type: "number", description: "视口坐标点击的 X(canvas 等无 selector 元素用)" },
        coordinateY: { type: "number", description: "视口坐标点击的 Y" },
        browserId: optId,
      }),
    },
    {
      type: "function",
      name: "browser_type",
      description: BROWSER_TOOL_SPECS.browser_type.description,
      inputSchema: schema({
        index: { type: "number", description: "目标输入元素的索引(来自最近一次 browser_snapshot),优先使用" },
        selector: { type: "string", description: "目标输入元素的 CSS selector(index 的替代写法)" },
        text: { type: "string", description: "要输入的文本内容;空串=清空字段" },
        clear: { type: "boolean", description: "true(默认)=清空后输入;false=追加到现有内容之后" },
        browserId: optId,
      }, ["text"]),
    },
    {
      type: "function",
      name: "browser_keys",
      description: BROWSER_TOOL_SPECS.browser_keys.description,
      inputSchema: schema({
        keys: { type: "string", description: '按键或组合键,如 "Enter" / "Escape" / "Control+a" / "Shift+Enter"' },
        browserId: optId,
      }, ["keys"]),
    },
    {
      type: "function",
      name: "browser_scroll",
      description: BROWSER_TOOL_SPECS.browser_scroll.description,
      inputSchema: schema({
        direction: { type: "string", enum: ["up", "down"], description: "滚动方向" },
        pages: { type: "number", description: "滚动量(单位=视口高,默认 1;10≈滚到底)" },
        selector: { type: "string", description: "改为滚动该元素内部的滚动区" },
        browserId: optId,
      }, ["direction"]),
    },
    {
      type: "function",
      name: "browser_wait",
      description: BROWSER_TOOL_SPECS.browser_wait.description,
      inputSchema: schema({
        selector: { type: "string", description: "等待该 CSS selector 元素出现" },
        text: { type: "string", description: "等待该文本出现在页面中" },
        seconds: { type: "number", description: "固定等待秒数" },
        timeoutSeconds: { type: "number", description: "等待超时(默认 10,上限 30)" },
        browserId: optId,
      }),
    },
    {
      type: "function",
      name: "browser_history",
      description: BROWSER_TOOL_SPECS.browser_history.description,
      inputSchema: schema({
        action: { type: "string", enum: ["back", "forward", "reload"], description: "后退/前进/刷新" },
        browserId: optId,
      }, ["action"]),
    },
    {
      type: "function",
      name: "browser_select",
      description: BROWSER_TOOL_SPECS.browser_select.description,
      inputSchema: schema({
        index: { type: "number", description: "下拉框元素的索引(来自最近一次 browser_snapshot),优先使用" },
        selector: { type: "string", description: "下拉框元素的 CSS selector(index 的替代写法)" },
        value: { type: "string", description: "选项的 value 或精确可见文本" },
        browserId: optId,
      }, ["value"]),
    },
    {
      type: "function",
      name: "browser_find",
      description: BROWSER_TOOL_SPECS.browser_find.description,
      inputSchema: schema({
        selector: { type: "string", description: "按 CSS 查询元素(与 text 二选一)" },
        text: { type: "string", description: "在页面文本中搜索(与 selector 二选一)" },
        regex: { type: "boolean", description: "text 按正则解释(默认字面)" },
        caseSensitive: { type: "boolean", description: "区分大小写(默认不区分)" },
        contextChars: { type: "number", description: "文本匹配的上下文字符数(默认 150)" },
        maxResults: { type: "number", description: "最多返回条数(默认 25)" },
        attributes: { type: "array", items: { type: "string" }, description: 'selector 模式下要提取的属性,如 ["href","src"]' },
        cssScope: { type: "string", description: "把查找范围限定在该 CSS selector 内" },
        browserId: optId,
      }),
    },
    {
      type: "function",
      name: "browser_switch_tab",
      description: BROWSER_TOOL_SPECS.browser_switch_tab.description,
      inputSchema: schema({
        browserId: { type: "string", description: "要切换到的浏览器视图 id(browser_list 查询)" },
      }, ["browserId"]),
    },
    {
      type: "function",
      name: "browser_close_tab",
      description: BROWSER_TOOL_SPECS.browser_close_tab.description,
      inputSchema: schema({
        browserId: { type: "string", description: "要关闭的浏览器视图 id" },
      }, ["browserId"]),
    },
    {
      type: "function",
      name: "browser_upload_file",
      description: BROWSER_TOOL_SPECS.browser_upload_file.description,
      inputSchema: schema({
        index: { type: "number", description: "文件输入框元素的索引(来自最近一次 browser_snapshot),优先使用" },
        selector: { type: "string", description: '文件输入框元素的 CSS selector(index 的替代写法)' },
        paths: {
          type: "array",
          items: { type: "string" },
          description: "要上传的本地文件路径数组(绝对路径,或相对项目根的路径)",
        },
        browserId: optId,
      }, ["paths"]),
    },
    {
      type: "function",
      name: "browser_save_pdf",
      description: BROWSER_TOOL_SPECS.browser_save_pdf.description,
      inputSchema: schema({
        fileName: { type: "string", description: "保存的文件名(不含路径;省略则按时间戳命名)" },
        paperFormat: { type: "string", enum: ["letter", "legal", "tabloid", "a3", "a4", "a5"], description: "纸张格式,默认 a4" },
        landscape: { type: "boolean", description: "横向(默认纵向)" },
        printBackground: { type: "boolean", description: "是否打印背景色/图(默认 true)" },
        scale: { type: "number", description: "缩放 0.1-2(默认 1)" },
        headerFooter: { type: "boolean", description: "显示页眉页脚(默认 false)" },
        browserId: optId,
      }),
    },
    {
      type: "function",
      name: "browser_downloads",
      description: BROWSER_TOOL_SPECS.browser_downloads.description,
      inputSchema: schema({}),
    },
    {
      type: "function",
      name: "browser_evaluate",
      description: BROWSER_TOOL_SPECS.browser_evaluate.description,
      inputSchema: schema({
        script: { type: "string", description: "要在页面中执行的 JavaScript 代码(可访问 document/window 等页面对象)" },
        browserId: optId,
      }, ["script"]),
    },
    {
      type: "function",
      name: "browser_screenshot",
      description: BROWSER_TOOL_SPECS.browser_screenshot.description,
      inputSchema: schema({
        browserId: optId,
        fullPage: { type: "boolean", description: "true=截整页(含滚动外内容)" },
      }),
    },
  );
  return tools;
}