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
- **换密钥是唯一的"拉闸"手段**——旧链接立刻失效；
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
- `agent_read_file` / `agent_write_file` / `agent_edit_file` / `agent_list_dir` / `agent_glob` / `agent_grep` / PDF / Office 那一组**全部**受它约束，越界会被明确拒绝（错误里会说清根在哪）
- **桌面本机的会话不受这个限制** —— 沙箱只对公网那条通路生效，本机一直在用的自由度没变

### ⚠️ 沙箱是可绕过的

**`agent_bash` 不受沙箱限制。** 它能 `cd ..`、能 `cat` 任意绝对路径。也就是说，模型**有能力**绕过文件工具的沙箱。

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
| `main/providers/bridge/mcpEndpoint.ts` | 协议本体（`initialize` / `tools/list` / `tools/call`）。**没有为这条路改动**——两条通路共用它。 |
| `main/mcp/webToolHost.ts` | 工具表与闸门。**也没有改动**——合成会话让它照常工作。 |
| `main/mcp/agentTools.ts` | `resolveAgainstCwd` 里的沙箱判定（`isInsideRoot`）：文件工具的唯一路径入口，23 处调用点共用一份规矩。 |

回归网：`scripts/mcp-endpoint-smoke/`（含公网端点、沙箱、阻塞读、结构化输出那几段断言）、`scripts/tunnel-manager-smoke/`（域名抠取与失败路径）。变异验证：`mut-public-mcp.py` / `mut-longtask.py` / `mut-sandbox-tunnel.py`。
