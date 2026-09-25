# 工作流／自动化：两种入口，可编辑的图

这两个 JSON 可以在「设置 → 工作流」导入，也可以作为新图的改造参考；它们不是程序启动时自动创建的额外任务。文件里的 `id` 是契约要求的占位值，导入新图时应用另分配本机 id、处理重名、校验并标为**待审查**；审查当前版本后才能执行。改图后如审查失效，要重新审查，不能靠导入文件绕过信任闸门。

| 文件 | 怎么起跑 | 图里可以改什么 |
| --- | --- | --- |
| `chat-main-workflow.json` | 主页聊天选择这份**工作流**，用户消息进入 `mcode.main`（原主代理对话），然后走条件／子代理 | 主代理指令、AND/OR 规则、真假两路子代理、输入输出与能力 |
| `event-to-agent-automation.json` | `library.item.downloaded` 事件进入 `mcode.trigger`，并在独立的**自动化会话**中继续，不需要主聊天发消息 | 事件/过滤器、合并窗口、项目、任务、规则、真假两路子代理 |

自动化示例的触发器**默认关闭**（`enabled: false`）。导入并审查、检查是否与现有「下载完自动转 Markdown」自动化重复后，按需编辑触发器并启用；启用后可能产生模型调用及费用。`project` 为空是特意的：资料库的下载完成事件不属于特定项目。示例仅声明子代理 `read` 能力；如果改为写文件或调用有副作用的工具，应显式调整能力和审查。

条件规则只读取上游原始值或 `{{trigger.<键>}}` 载荷，不执行代码：`exists`、`equal`、`contains` 用 AND/OR 拼接。两条出边的标签必须分别是 `true` 与 `false`。示例中 `contains ".pdf"` 只检验**子串**，不是严谨的文件类型／扩展名校验。**合并窗口内多条下载事件会合并**；`{{trigger.itemId}}`／`{{trigger.pdfPath}}` 是首条的扁平字段，自动化的子代理指令明确要求按触发提示里的全部条目处理。若想无模型地逐条处理结构化的 `trigger.items`，可参考现有「下载完自动转 Markdown」图的 code 节点。

本仓库原生 Windows 回归（只使用项目内 esbuild，临时数据库在 `apps/desktop/.tmp`，完成后删除）：

```powershell
cd mcode
powershell -NoProfile -ExecutionPolicy Bypass -File apps/desktop/scripts/event-vertical-smoke/run.ps1
# 既有自动化回归同一安全入口:
powershell -NoProfile -ExecutionPolicy Bypass -File apps/desktop/scripts/event-vertical-smoke/run.ps1 -Suite automation-smoke
```

回归以**真实导入、审查、后台事件订阅、触发器、调度器、条件选路**为被测对象；仅将模型/会话执行替换为记录调用的桩。它不等于真实 Electron 界面、插件、模型输出或外部服务的验收。
