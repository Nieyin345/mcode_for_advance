# 公网 MCP 端点：让 ChatGPT 网页直接调 Mcode 的工具

Mcode 有两处工具出口，**别混淆**：

| 出口 | 谁在用 | 监听 | 鉴权 |
|---|---|---|---|
| 扩展桥的 `/mcp` | 浏览器里的 Mcode 扩展 | 只绑 `127.0.0.1` | `Authorization: Bearer <桥令牌>`，且只放行扩展来源 |
| **公网 MCP 端点**（本文） | **互联网上的 MCP 客户端（ChatGPT 的 Connector）** | 只绑 `127.0.0.1`，由用户自己架隧道暴露 | **URL 路径里的密钥** |

## 为什么鉴权方式不一样

ChatGPT 的自定义 Connector **只支持 OAuth，不收 Bearer / API key**（OpenAI 官方文档明确说不支持自定义 API key），而扩展桥用的就是 Bearer。但 Connector 的 URL 会原样转发，所以走**密钥藏在路径里**这条路：

```
https://<隧道域名>/mcp/<密钥>
```

密钥不对一律回 **404**（不是 401 —— 不透露"这里确实有个端点"）。

## ⚠️ 这条链接等于整台机器的操作权

工具表里有 `agent_*`：读写文件、跑 bash、杀进程、SSH。而且这条路**没有审批闸门**——拿到链接的人想干什么就干什么，不弹卡片。

所以：

- 密钥是 32 字节随机（256 位），不是可猜的；
- **关闭总开关**会停止接收新的公网调用；**换密钥**使旧链接失效；
- 总开关**默认关**。

别把链接贴到任何会被记录的地方（聊天、issue、截图）。如果贴过又担心，点一次「换一把密钥」。

## 怎么用

1. Mcode：设置 → 模型配置 → 网页版 → 找到「公网 MCP 端点」卡片，打开开关
2. 点卡片上的 **「开启公网隧道」** —— Mcode 自己起 cloudflared，等几秒（它要先跑一段连通性预检）
3. 就绪后卡片上出现 **「完整地址」**（形如 `https://xxx.trycloudflare.com/mcp/<密钥>`），一键复制
4. ChatGPT（需要 Plus / Pro / Business 且有 Developer Mode）→ 设置 → Connectors → 高级设置 → 打开开发者模式 → 创建 → 填完整地址，认证选「无」
5. 在对话里说一句话让它调工具，例如"列一下我项目目录里的文件"

> **隧道域名每次重启都会变**，所以每次都要重新填。这是快速隧道的性质（不上账号、随机域名、用完即弃），不是缺陷。
>
> 不想让 Mcode 起隧道的话，卡片上那条「隧道命令」可以自己拿去终端跑，域名自己拼 —— 两种方式都行。

## 文件工具的沙箱

公网进来的调用**没有审批闸门**（见下面的风险段），所以文件工具被限制在一个目录里：

- **沙箱根 = 合成会话挂着的那个项目目录**（卡片上的「沙箱目录」那行显示的就是它）
- `agent_read_file` / `agent_write_file` / `agent_edit_file` / `agent_list_dir` / `agent_glob` / `agent_grep` / PDF / Office 那一组的写操作受它约束；读取可按只读策略访问资料库，并遵守屏蔽规则；技能只开放当前链接绑定项目的 `.claude/skills`。未授权路径会拒绝
- **桌面本机的会话不受这个限制** —— 沙箱只对公网那条通路生效，本机一直在用的自由度没变

### ⚠️ 沙箱是可绕过的

**命令工具不是强沙箱。** cwd 有项目边界检查，agent_bash 另有有限静态写目标检查；这不等于能约束任意 shell 程序的所有读写。不要把防误操作检查当作强隔离。

这是刻意的取舍，不是疏漏：拦 bash 需要真的解析 shell 语义（管道、重定向、变量展开、`$(...)`……），做不干净反而给人"限制住了"的错觉。所以这里的定位是**防误操作**，不是**防恶意**。真正的边界是那把密钥 —— 别给不信任的人。

## ⚠️ 这条链接等于整台机器的操作权

## 审计：ChatGPT 到底调了什么

第一次有公网调用进来时，Mcode 会建一条标题为 **「ChatGPT 直连」** 的会话（在左栏里）。所有公网来的工具调用都记在这条会话下——**点开就能看到调用的工具名和参数**。

这条会话的权限模式被写死为 `bypassPermissions`，且每次开关一动就会重新钉死（用户改不动，改了也会被改回来）。这是有意的：免审批是这个功能的定义，不是可调的偏好。要收紧就关总开关或换密钥。

## 代码在哪

| 文件 | 职责 |
|---|---|
| `main/providers/bridge/publicMcpServer.ts` | **纯**的监听器：路径解析、常量时间密钥比较、注入合成会话、转交给现成的 `handleMcpRequest`。不拉 electron / db，所以无头 smoke 测得动。 |
| `main/providers/bridge/publicMcpSession.ts` | 不纯的那一半：用 `SettingRepo` 存取开关/密钥/会话 id，建「ChatGPT 直连」会话，钉权限模式，接隧道状态。运行时能力（RuntimeManager）走**注入**——直接 import 会把 provider 图（→ `agentRemoteSsh` → ssh2 原生模块）拉进无关 smoke 的打包链。 |
| `main/providers/bridge/tunnelManager.ts` | Mcode 自己起 cloudflared、从它的日志里抠出域名、超时/失败给明确原因、退出时 kill 进程树。同样不拉 electron/db（spawn 与查找都可注入）。 |
| `main/providers/bridge/mcpEndpoint.ts` | 协议本体（`initialize` / `tools/list` / `tools/call`）。两条通路共用协议实现；公网说明与工具表独立，异步读取请求体后再次检查端点开关。 |
| `main/mcp/webToolHost.ts` | 工具表与闸门。按 public/local 通路分别列举、派发工具；公网列举和直接调用均不接受完整 Agent 委派。 |
| `main/mcp/agentTools.ts` | `resolveAgainstCwd` 里的沙箱判定（`isInsideRoot`）：文件工具的唯一路径入口，23 处调用点共用一份规矩。 |

回归网：`scripts/mcp-endpoint-smoke/`（含公网端点、沙箱、阻塞读、结构化输出那几段断言）、`scripts/tunnel-manager-smoke/`（域名抠取与失败路径）。变异验证：`mut-public-mcp.py` / `mut-sandbox-tunnel.py`。


## 基础工具边界与 SSH 配置（2026-10-03）

- 公网 MCP 提供基础计算机工具、技能读取及资料库只读查询；不提供完整 Agent 委派、工作流管理或对话历史。`mcode_agent_*` 不仅从工具表移除，缓存旧名称直接调用也会拒绝。旧 `agentDelegate=true` 配置写入会报迁移错误，设置页不再提供该开关。桌面内部 Agent、工作流和自动化机制不移除。
- `agent_context` 默认只查询项目/基本环境，不枚举资料库。确实需要概况时传 `include_library=true`，或直接调用资料库只读工具。已有的类型屏蔽、只读权限继续生效；桌面内部上下文不在这次公网精简范围内。
- SSH 是执行接口，不是认证配置向导。调用前由 AI 与用户确认**真实主机地址、端口、用户名**，并且只指定以下一种已配置方式：`private_key_path`、`password`、`agent_path`。加密私钥可另外传 `passphrase`。用户名必填。
- 不再自动读取 `~/.ssh/config`、扫描默认私钥、读取 `SSH_AUTH_SOCK` 或选择 Windows agent。配置中的主机别名必须先由 AI/用户解析为实际地址。加载密钥、解锁、交互式认证/MFA 等先在工具之外完成；工具不会猜测或自动回答交互提示。
- 显式 agent 示例：Unix 传已确认的 socket 路径；Windows OpenSSH 传已确认的命名管道 `\\.\pipe\openssh-ssh-agent`。不要用文件存在性检查判断命名管道可用性。工具不会启停 agent 或加入密钥。
- `agent_ssh_connect` 未就绪时返回 `isError=true`；已经创建连接记录的结果包含 `connection_id`、`state`、`last_error`、`reconnect_attempt`。认证/配置错误不会自动重试；网络中断可沿用原来明确配置的凭据重连。改变认证字段不会误用旧的已认证连接。
- `agent_remote_job_logs.max_bytes` 范围为 **4–60000**，小于 4 明确报错，以容纳完整 UTF-8 字符。继续读取使用返回的 `next_cursor`。任务结束不等于日志已读尽，应同时检查是否仍有未读日志。
- `agent_process_stop` 是受当前对话身份约束的可重试停止请求，不是任意 OS PID kill 或立即退出的保证；Windows 进程树停止可能暂时返回真实 `running`，客户端应使用 `agent_process_read` 的游标查询直到 `stopped/timed_out/exited`。重复 stop 不会叠加终止请求，不会把已超时的进程重新标成“用户停止”；停止请求一旦发出，不再接收 stdin 写入。对话销毁或应用退出会主动唤醒其在途 read/stop 并明确报告会话失效，不能等待到最长 55 秒后返回已经失效的旧结果。以上为隔离无头行为，真实跨 OS 子进程树停止仍需 U1 验证。
- `agent_search_start`、`agent_search_read` 的结果只对当前搜索会话 owner 有效：会话被删除时，即使后台搜索/轮询早已开始，也会明确报“搜索会话已销毁”，不能继续将其旧结果返回成功。`max_results` 是返回/扫描预算，不是“全盘已经搜索完”的保证；只要命中上限，`partial=true` 并在 `skippedPaths` 标注 `max_results`，即使 `status=completed` 也不能据此认定无更多匹配。无命中且 `partial=false` 才具备本次扫描完整性的含义；这不替代文件系统真实权限与跨 OS U1 验证。 用户主动调用 `agent_search_stop` 也表示提前取消扫描，结果会保留 `status=stopped` 且标记 `partial=true`、记录 `stop requested` 原因；重复停止不会重复计数，停止后未完成的正文上下文不会再补写进已返回的结果。

- `agent_search_start` 的内容扫描只检验和读取同一打开的文件句柄，避免文件头检查后由路径交换/符号链接重新打开另一份正文而泄漏错版内容；单个内容文件超过 **8 MiB** 时跳过并返回 `partial=true`、具体扫描预算原因，不能将结果当作完整搜索。读取范围不允许的子目录和已被选中但不可读的文件同样记录不完整，但**权限围栏明确拒绝的路径不会在 `skippedPaths` 泄露名称**，只给脱敏提示及 `skippedCount`；由 `file_pattern` 主动排除的文件不会虚构 skipped。此为原有 Host 的 L2 有界读预算，不是新造文件索引或 OS 沙箱；大型文件仍可用显式分页读取工具另行处理。

### 开关的实际效果

总开关控制端点监听和 Mcode 管理的隧道。关闭后底层禁止重新启动，并在请求入口及异步请求体读取之后阻止新工具派发；启动过程中关闭不会重新挂出端点。已经开始执行的命令不承诺回滚或自动终止，持久远程任务仍须显式取消。外部管理的隧道进程不归 Mcode 所有，不会被这个开关杀掉；但关闭的本机端点不再接受调用。

隧道模式、域名、固定端口仍通过保存配置应用；固定端口占用必须报错而不是悄悄换端口。设置页的旧轮询响应不能覆盖后来的保存/开关结果。

此协议调整后，客户端应刷新 `tools/list`，更新 SSH 参数及日志字节预算；不改写用户自定义工作流。


## 公网工具精简与项目技能（project-compact-v4，本地源码变更）

公网工具表早期从 45 项合并为 39 项；新增 PDF 页面图像只读工具后现为 **40 项**。桌面引擎、本机扩展、内部 Agent 和工作流保留原有接口；不自动转发第三方 MCP 或插件。

| 旧公网工具 | 新调用 |
|---|---|
| `agent_read_file` / `agent_read_files` | `agent_read_file`：单个 `path` 或批量 `paths`，不能同时传 |
| `agent_skill_list` / `agent_skill_read` | `agent_skill`：`action=list/read` |
| `library_collections/search/items/links` | `library_query`：`action=collections/search/items/links` |
| `agent_process_sessions` | `agent_process_read` 不传 `process_id` |

旧名称不保留隐藏执行入口，直接调用给出迁移指引。更新客户端 `tools/list`；这不是应用版本发布或运行时开关变更。

### GenOffice 复用、PDF 与图像读取（2026-10-19）

- **避免平行实现**：GenOffice 已有真正的 `docs_read` / `slides_read` / `sheet_read` / `pdf_read`、`render`、`convert`、`guide` 等工具，Office/PDF 复杂功能优先用现成 GenOffice CLI/MCP，不再在公网工具里重新实现 OOXML/PDF 编辑或转换引擎。Mcode 已有 `document.read/edit/convert/capabilities` + `app_api_*` 共用宿主与 GenOffice CLI 适配；需要完整原生工具表时由 MCP 设置安装现有 `genoffice` stdio server，而非向公网 MCP 再复制 20+ 个工具（且不绕过审核/路径围栏）。
- `agent_read_document` 的 `reader` 可选 `auto`（默认，GenOffice 优先，依赖不存在/能力 unavailable 时保留旧兼容读取）、`genoffice`（仅调用 GenOffice，**失败不会悄悄更换解析器**）或 `native`（显式使用旧兼容工具链）。GenOffice 路径由 `document.read` 已有宿主 repo-root 规则查找，仍以公网项目的 `pOfRead` 校验路径后才调用 CLI，并受同一文档读取并发/解压预算保护。`pdf_mode=layout` 的 x/y 坐标目前 GenOffice PDFium 没有提供，因此 `auto` 在此模式保留原有 pdfjs 实现，指定 `reader=genoffice` 则明确报不支持；工作表 `sheet/range/max_rows` 映射到 GenOffice 原生 `--sheet/--range/--max-rows`；PowerPoint `slide_start/max_slides` 从 1 开始，使用 GenOffice 原生 `slides read --slide` 的 0-based 逐页能力组成窗口，默认只预览第 1 页，最多每次 8 页，返回 `next_slide` 可直接续读。每个窗口前限制进程数，绝不先把全份 PPTX 输出后截断。`max_slides>8` 时显式 `reader=genoffice` 报错，`auto` 按公开兼容规则走历史 Python；`reader=native` 支持同样的 `slide_start`，其默认每次 200 页。暂无法无损映射的 Excel `max_cols` 仍交给兼容路径，不静默忽略。GenOffice 上游 sheet read 对显式 `--range` 先按整个区域分配内存，再处理 `--max-rows`，所以公网工具会先用共享 ReadBudget `maxCells=100000` 验证 `A1:D20` 样式的完整区域（含 Excel 实际坐标上限），超限/非法区域在 CLI 启动**之前**拒绝；`max_rows=1` 并不意味着可安全请求百万行范围。PowerPoint 同一 `slide_start/max_slides` 调用中的所有原生分页子进程**共用** 60 秒文档时间预算，并检查原文件的尺寸/文件标识/修改时间在各页读取后未变化，发生变化拒绝拼接；这是最佳努力的元数据一致性检查，不等价于原子文件快照或不可绕过的并发锁。

- `agent_read_document({path:"paper.pdf"})` 默认优先通过 GenOffice 的 PDFium 文本层读取并返回分页面信息（不执行 OCR）；在缺失 GenOffice CLI 时才回退到旧 pdfjs 读取，或用 `reader:native` 显式选择旧实现。文本模式现在支持 `page_start` 与 `max_pages` 按页续读，并保留每页的页码标记。`pdf_mode:"layout"` 则逐页返回真实文档书签（如果 PDF 有内嵌 Outline）、页面尺寸、近似文字坐标与 PDF 图像绘制命令数量；可搭配 `page_start:2,max_pages:3` 分页。布局模式每次最多 20 页，防止大文件执行过多绘制算子；坐标只是布局线索，**不能据此声称准确恢复复杂表格、双栏阅读顺序或图片内容**；页码从 1 开始，超出范围会报错。GenOffice 的 `pdf read --max-chars` 属于**每页**预览预算，因此请求多页（实测 220 页）时会先按页数缩小 vendor 每页预览长度，避免 512KiB CLI JSON 信封溢出；这不是逐页全文，长文本应分批分页获取。不要将图片绘制命令数当作图片/图表准确数量。
- `agent_render_pdf_page({path:"paper.pdf",page:2,max_dimension:1400})` 默认复用 GenOffice 的 PDFium 原生 `render` 输出 PNG 图像，仍返回标准 **MCP image content block**；仅在 CLI 不可用或图片需进一步缩小时兼容旧 PyMuPDF JPEG 路径。可加 `renderer:"genoffice"` 禁止回退，或 `renderer:"native"` 明确走旧 Python。GenOffice 只写调用时创建的系统临时目录，读取 PNG 后立即清理，不修改原 PDF 或工作区；最大边 2000px、图像 ≤6 MiB、共用文档并发闸门，不执行 OCR。现在 GenOffice 的 `pdfRead(page)` 会返回可信页数供公网图像标签显示 `第 n/总页数 页`（不再缺总页数）；尺寸探测与图片渲染**共用 30 秒总超时/AbortSignal**，且两阶段检查 PDF 文件大小/修改时间/文件标识，拒绝读取期间换版的结果。显式 `renderer=genoffice` 绝不回退；`auto` 在尺寸探测或渲染阶段确认为 `unavailable` 时才使用 PyMuPDF，非不可用故障仍报错，避免隐蔽跳过坏图。PNG 输出在 6 MiB 上限内，使用 Node 内置 CRC32 校验每一个 PNG chunk 的长度与校验和、唯一 IHDR、存在非空 IDAT、末尾 IEND 无尾随数据；同时验证实际宽高与原厂信封一致、请求页唯一，且真实文件位于本次临时目录。只含 IHDR、坏 CRC、chunk 越界、缺 IEND、尾随内容和重复 IHDR，以及 CRC 正确但 IHDR 色彩/压缩参数非法、未知关键 chunk、IDAT 非连续、PLTE 非法/错位或超出索引位深、tRNS 透明度条目重复/不匹配/顺序异常、chunk 保留位不合法等都拒绝而不假装渲染成功；正常连续多个 IDAT 和已知可跳过的 ancillary chunk 仍兼容。这是受限的 PNG **容器结构/数据校验**，不展开 IDAT 或完整像素解码，不能替代图像解码器验证、病毒扫描或源文件原子快照。支持图片块的客户端才能真正查看画面，公网 ChatGPT 端需安装后独立实测。
- `agent_read_document({path:"report.docx",docx_mode:"structure",block_start:1,max_blocks:30})` 默认使用 GenOffice `docs_read` 的结构块结果，包含段落/表格等原生解析信息；工具层 `block_start` 从 1 开始，自动对应 GenOffice 自己的 0-based block indexes，`max_blocks` 限制返回块数。为避免大 DOCX 先一次性写出超过 512KiB 的 CLI JSON 再截断，现先用 GenOffice `docs read --range 0` 确认真实总块数，再由 GenOffice 原生 `--range a-b --max-chars n` 仅生成目标块的文本预览；不在主进程里拿整份全文后切片。超过本次窗口的文档明确返回 `next_block_start`（1-based），可以继续用 `docx_mode:"structure"` 翻页；普通 `text` 模式默认读取前 30 个块并显式标注未读部分。CLI 的预览长度和客户端最终 `max_chars` 都会截断部分块文本，需区分摘要与全文。当前在输出开头固定呈现可验证的 `blocks=` / `next_block_start=` 游标（同时用于 PPTX `next_slide=`、PDF `next_page=`），即使最终 JSON 正文因低 `max_chars` 截断也不隐藏继续读取位置；本地兼容 DOCX/PDF 同样把续读游标提前。GenOffice 返回的 DOCX 块总数/区间/项数及每一块原生 `index`、PDF 实际读取页号与实际回传页数、所选 Excel 工作表/区域及行数都会核对请求；Excel 原厂结果必须具有可信的 `range`、`rows`、`rowsShown` 和 `rowsTotal`，行宽须与返回区域一致，超过请求的 `max_rows`、错位区域或重复/不规则行不得伪装为成功；空区域、合法截断及反向 A1 范围继续兼容；DOCX/PDF 的探测与实际选中读取若报告的总数发生变化，同样明确失败。供应商输出缺字段、漏页或选择错位时不会作为成功内容展示。原生 PDF/DOCX 的元数据探测与选中内容读取现在共用一份 60 秒总超时/AbortSignal，且每次供应商 CLI 调用后核对文件大小、修改时间和文件标识；即使总页数或块数未变化，只要探测与结果跨源文件版本就拒绝。GenOffice 的 `unavailable` 仍允许 `reader=auto` 按既有规则走 native，但显式 `reader=genoffice` 不回退。这些 CLI 元数据及源文件标识交叉校验是防止静默错页、跨版本混读的最佳努力保护，**不是**原子文档快照或进程沙箱；极端 TOCTOU 竞争仍需后续独立验证。任何其它 GenOffice 全量读命令若自身 JSON stdout 超过 512KiB，适配层也会显式报“输出超过”而不把残缺 JSON 伪称为文档损坏。仅在 `reader=native` 或 CLI 不可用时使用已有 OOXML 只读兼容提取（其表格最多展开 100 行×30 列）；不承诺复杂页面布局、原版样式绝对一致或 OCR。
- 大页 PDF：先用 GenOffice PDFium 自己的 `pdfRead(page)` 取得真实尺寸，再据此设置 `render --scale`。不用以前固定 842pt 的猜测值，宽页先缩放再渲染；真实隔离 2000×500pt PDF 在 max_dimension=700 下返回了 PNG。
- PDF 原始输入预算（ARC-007 文档安全切片）：GenOffice、pdfjs、PyMuPDF 三种读取或渲染路径，均在起解析器之前对文件做统一的 ReadBudget 原始大小检查。`max_chars` 和 `max_dimension` 只是输出限制，不能替代 128 MiB 文件大小上限。超限会显示实际字节数和上限并拒绝。
- 安装包资源：共用 GenOffice CLI resolver 已补安装态目录 `resources/genoffice/cli/genoffice.cjs` 的检索，安装版至少需要 `cli/node_modules` 和 `wasm/pdfium.wasm` 配套资源，缺失时不宣称可用；开发态仍兼容固定 vendor 快照。出包侧已接入按需 staging（默认只产 availability.json(bundled:false)，显式 `MCODE_INCLUDE_GENOFFICE_BUNDLE=1` 才带 CLI/依赖/PDFium WASM/许可到 `resources/genoffice`），仍需合法来源、真实安装包与重启验收；本轮没有编译、安装或重启 MCP。
- `agent_read_image` 仍直接返回本地图片的 MCP 图像块；没有视觉能力的客户端不能单凭返回尺寸理解内容。图片、PDF 页面渲染、文档布局读取都使用**同一套只读项目路径/资料库屏蔽策略**，不新增越权入口。
- 由于公网 MCP 工具表新增了 `agent_render_pdf_page`，须重新启动更新后的 Mcode 并刷新 MCP 客户端工具列表（`tools/list`）；旧连接缓存不会凭源码改动自行出现新接口。

### 项目技能：发现不等于执行

- 唯一来源是**该链接绑定项目**的 `.claude/skills/<目录>/SKILL.md`，不是最近的 shell cwd。frontmatter `name` 优先，缺省用目录名；同名按目录排序取首个。只接受既有技能名规则。
- **没有全局技能、全局白名单或全局回退**。不会继承其他项目、全局开关矩阵或插件列表；项目技能本来就不参与全局引擎 enable matrix，本轮没有发明额外开关。
- `agent_context` 附带前 30 条名称/描述/路径轻量索引，不读入完整技能正文。`agent_skill` 默认 `action=list`，`query` 对名称/描述做不区分大小写的关键词匹配，多词取 AND；不是语义搜索。`offset` 从 0 起，`limit` 默认 30、最多 100。
- 索引最多扫描排序后的 2000 个候选目录，每个仅读取 SKILL.md 前 8192 字节、描述最多 240 字符；达到候选上限返回 `scan_truncated=true`，不声称完整。大 frontmatter 可能无法在这个窗口内解析，可直接按项目内路径分页读文件。
- 选中后 `agent_skill(action=read, name=...)` 按需读取正文；`page` 接受与文本文件相同的分页和 `expected_sha256` 参数。技能文件读不全时按返回游标继续，不截断后当作全文。
- 模型根据任务决定是否查询/采用技能，不能保证自主模型每次都自动选择。工具不执行技能，技能里的命令不自动获得用户授权；副作用仍按用户确认与当前权限处理。

### 合并时保留的行为

`agent_read_file.paths` 接受 1–20 个字符串或含独立 `path/offset/limit/column_offset/max_chars/expected_sha256` 的对象。顶层分页参数作默认值、单项覆盖。每个结果保留无损 `content`、SHA-256、分页游标和 `isError`；部分失败不丢掉成功结果。单次批量正文最多 80000 字符，未处理项放在 `pending_files`，需再次提交。**已经处理但 `has_more=true` 的文件也要独立续读**。行号预览不是写回数据。

`library_query` 只派发原四个只读 handler，仍遵守原资料库屏蔽规则：`search` 要 `query`，`items` 要 `collectionId`，`links` 要 `itemId`，`collections` 不带这些参数。动作与参数不匹配在执行前拒绝。资料库依然按需查询，不自动塞入普通任务上下文。

命令、持久进程、搜索会话和远程 job 不相互替代；归属隔离、取消和增量日志沿用原实现。合并工具保留 readonly annotations 与权限判断。

### 普通文件路径检查的边界

公网技能发现、按名读取、文本/图片/Office 读取、目录列表、glob、grep 和后台搜索共用项目技能路径限制。普通文件工具拒绝已知全局技能目录（`~/.mcode/skills`、`~/.claude/skills`、`~/.codex/skills`、`~/.agents/skills`）及其他项目的标准技能路径；不会因资料库只读许可而放行。项目内指向项目外的符号链接/junction 也拒绝，递归遍历逐项过滤；修改工具同样不能借该别名隐式读取或改写技能。项目内合法技能及其辅助文件仍可使用。

**这不是操作系统级强隔离**：shell/SSH 可运行任意代码；检查也不承诺防住并发换链、硬链接或把内容复制进普通文件等对抗行为。不能把“公网不提供全局技能”理解为整台机器的强保密沙箱。不要将链接交给不信任的人。
