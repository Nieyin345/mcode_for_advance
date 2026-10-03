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

### 开关的实际效果

总开关控制端点监听和 Mcode 管理的隧道。关闭后底层禁止重新启动，并在请求入口及异步请求体读取之后阻止新工具派发；启动过程中关闭不会重新挂出端点。已经开始执行的命令不承诺回滚或自动终止，持久远程任务仍须显式取消。外部管理的隧道进程不归 Mcode 所有，不会被这个开关杀掉；但关闭的本机端点不再接受调用。

隧道模式、域名、固定端口仍通过保存配置应用；固定端口占用必须报错而不是悄悄换端口。设置页的旧轮询响应不能覆盖后来的保存/开关结果。

此协议调整后，客户端应刷新 `tools/list`，更新 SSH 参数及日志字节预算；不改写用户自定义工作流。


## 公网工具精简与项目技能（project-compact-v4，本地源码变更）

仅公网工具表从 45 项合并为 **39 项**。桌面引擎、本机扩展、内部 Agent 和工作流保留原有接口；不自动转发第三方 MCP 或插件。

| 旧公网工具 | 新调用 |
|---|---|
| `agent_read_file` / `agent_read_files` | `agent_read_file`：单个 `path` 或批量 `paths`，不能同时传 |
| `agent_skill_list` / `agent_skill_read` | `agent_skill`：`action=list/read` |
| `library_collections/search/items/links` | `library_query`：`action=collections/search/items/links` |
| `agent_process_sessions` | `agent_process_read` 不传 `process_id` |

旧名称不保留隐藏执行入口，直接调用给出迁移指引。更新客户端 `tools/list`；这不是应用版本发布或运行时开关变更。

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
