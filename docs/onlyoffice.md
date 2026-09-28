# OnlyOffice Document Server 接入说明

Mcode 主页面里 Word / Excel / PowerPoint（`.docx .xlsx .pptx` 及 `.docm .dotx .odt .xlsm .xltx .ods .pptm .potx .odp`）的**可视化编辑**由 [OnlyOffice Docs](https://github.com/ONLYOFFICE/DocumentServer)（AGPL，Community Edition）提供。它是一个独立的 HTTP 服务，Mcode **不内置**，需要用户在本机或局域网装一份。没配置时 Office 文件只有只读预览（`docx-preview` / `@js-preview/excel` / `pptx-preview`）。

## 架构

```
渲染进程 OnlyOfficeEditorPane
   │ 1. onlyoffice:open(filePath)                      (IPC)
   ▼
主进程 OnlyOfficeBridge
   │ 2. 起一个 127.0.0.1 上的 HTTP 服务（仅本机监听）
   │    GET  /oo/file/<token>      → 给 DS 拉原文件
   │    POST /oo/callback/<token>  → DS 回写（status 2/6 = 保存 / 强制保存）
   │ 3. 用 JWT_SECRET 签好 DocEditor 配置，返回 {apiScriptUrl, config, token}
   ▼
渲染进程加载 <serverUrl>/web-apps/apps/api/documents/api.js → new DocsAPI.DocEditor
   │
   ▼
Document Server ──(拉文件 / 回调)──▶ 127.0.0.1:<bridgePort>  或  host.docker.internal:<bridgePort>
```

- token 是每个会话随机的 32 字节，路径未知就拿不到文件；服务只监听回环地址。
- 回写落盘走「写临时文件 → 原子替换」，并给渲染端发 `onlyoffice:saved` 事件（编辑器角标"已保存"）。
- CSP：主进程按配置的 DS origin 动态放行 `script-src / frame-src / connect-src`（`main/index.ts`）。
- 相关文件：`packages/contracts/src/ipc/onlyoffice.ts`、`main/onlyoffice/OnlyOfficeBridge.ts`、`main/ipc/onlyoffice.ts`、`renderer/components/ide/OnlyOfficeEditorPane.tsx`、`renderer/components/settings/OfficePanel.tsx`。

## 安装方式一：设置页一键安装（Windows，推荐，不用 Docker）

设置 → 工作台 → **文档编辑** → 「本机安装」：

1. 面板打开即自动检测 `%ProgramFiles%\ONLYOFFICE\DocumentServer`、`DsDocServiceSvc` 服务、探测端口、读出 `config\local.json` 里的 JWT 密钥。
2. 未安装 → 点「一键下载并安装」：主进程从 `download.onlyoffice.com/install/documentserver/windows/onlyoffice-documentserver.exe`（约 1 GB）流式下载到 `%TEMP%\mcode-onlyoffice\`，然后起一个**提权** PowerShell（弹一次 UAC）执行：
   - `onlyoffice-documentserver.exe /SILENT /DS_PORT=<端口>`（安装器自带 PostgreSQL / RabbitMQ / Erlang 前置件）
   - 给 `config\local.json` 写入 `services.CoAuthoring.request-filtering-agent.allowPrivateIPAddress/allowMetaIPAddress = true`
   - 重启 `DsConverterSvc` / `DsDocServiceSvc`
   然后轮询 `/healthcheck` 直到起来，最后把地址 + 密钥自动写进 Mcode 配置。
3. 已安装 → 「使用这一份」直接套用；`allowPrivateIPAddress` 没开时多出「修复配置」（同一段提权脚本，跳过安装器）。

实现：`main/onlyoffice/localInstall.ts`（检测 / 下载 / 提权脚本 / 进度单例）、`renderer/components/settings/OfficeLocalInstallSection.tsx`（轮询进度）。脚本与日志在 `%TEMP%\mcode-onlyoffice\install.ps1 / install.log`。

## 安装方式二：Docker Desktop

```powershell
docker run -d --name onlyoffice -p 8080:80 --restart=always `
  -e JWT_SECRET=改成你自己的密钥 `
  -e ALLOW_PRIVATE_IP_ADDRESS=true `
  -e ALLOW_META_IP_ADDRESS=true `
  onlyoffice/documentserver
```

两个 `ALLOW_*` 环境变量**必须**给：DS 8.x 默认拒绝访问私网/回环地址（`services.CoAuthoring.request-filtering-agent.allowPrivateIPAddress`），不放开它就拿不到 `127.0.0.1` / `host.docker.internal` 上的文件，编辑器会报「下载失败」。老版本镜像不认这两个变量时，改 `/etc/onlyoffice/documentserver/local.json`：

```json
{ "services": { "CoAuthoring": { "request-filtering-agent": {
  "allowPrivateIPAddress": true, "allowMetaIPAddress": true } } } }
```

然后 `docker exec onlyoffice supervisorctl restart all`。

首次启动约 1–2 分钟；浏览器打开 <http://127.0.0.1:8080> 看到 "Document Server is running" 即可。健康检查：`curl http://127.0.0.1:8080/healthcheck` 返回 `true`。

也可以用官方 Windows 安装包（[下载页](https://www.onlyoffice.com/download-docs.aspx#docs-community)），装完默认端口 80；JWT 密钥在安装向导里设置，`allowPrivateIPAddress` 在 `%ProgramFiles%\ONLYOFFICE\DocumentServer\config\local.json` 改。

## Mcode 里手动配置（Docker / 远程 DS）

设置 → 工作台 → **文档编辑**：

| 字段 | 填什么 |
|---|---|
| 服务地址 | `http://127.0.0.1:8080`（或局域网机器的地址） |
| JWT 密钥 | 与 `JWT_SECRET` 一致 |
| 回连主机名 | 留空自动：本机 DS 用 `127.0.0.1`；**Docker Desktop 里的 DS** 自动改成 `host.docker.internal`。DS 在局域网另一台机器上时填本机的局域网 IP，并放行防火墙。 |

点「测试连接」→ 成功后在主页面打开任意 `.docx` 即进入编辑。工具栏「预览」可切到只读渲染。

## 排错

| 现象 | 原因 / 处理 |
|---|---|
| 「还没有配置 OnlyOffice」 | 服务地址为空 |
| 编辑器加载失败 / 空白 | DS 没起来，或 CSP 没放行（改完地址需重新打开文件） |
| 「下载失败」(error -4) | DS 连不到桥接服务：没放开 `ALLOW_PRIVATE_IP_ADDRESS`，或回连主机名不对（Docker → `host.docker.internal`） |
| 「文档安全令牌未正确构成」(error -20) | JWT 密钥不一致 |
| 改了文件却没落盘 | 看主进程日志 `onlyoffice` 分类；回调 `status` 需为 2/6，DS 需能访问回调 URL |
| 文件在 Mcode 外被改 | 会话 key 含 mtime+size，重新打开文件即生成新会话 |

## 限制

- 老格式 `.doc .xls .ppt .rtf` 不支持编辑（DS 只能转换后查看），仍走"不支持的文件"提示 + 外部打开。
- 手机端（`webApi`）没有 `onlyoffice` 命名空间，Office 文件只有预览。
