# 第三轮 · D 主进程外围

范围:`main/{browser,mobile,relay,lsp,plugins,onlyoffice,voice,terminal,memory,projectInit,monitoring,notifications,customUi,session,library(除 notesImport),lib(未修部分)}`、`main/*.ts`。
验证:增量 tsc 通过;lint-changed 无新增问题(`RelayManager.ts` 的 `conn.on("ready", async …)` no-misused-promises 是原有写法);
相关 smoke 全过:relay、plugins、plugins-ipc、maint-m13、mcp-ipc、mcode-admin。

## 修复的问题

| 编号 | 位置 | 问题 | 修复 |
|---|---|---|---|
| D1 | `plugins/pluginManager.ts` `finalizePluginInstall` / `installedRootOf` | ① 安装成功后清理其它版本用裸 `rmSync`,某个旧目录被占用(Windows 上插件的 MCP 服务正在跑)就抛出,**成功的安装被报成失败**;② 删不掉而残留的 `<版本>.backup-*` / `.swapping-*` 目录按字符串比较比 `<版本>` 大,于是之后**加载的是旧的备份**;③ 字符串比较下 `1.10.0` < `1.9.0` | 清理改为尽力而为(逐个 try,记日志);挑选目录时跳过临时目录,按安装记录时间优先、再按数字感知的版本号比较 |
| D2 | `plugins/pluginManager.ts` `removePlugin` | 直接 `rmSync` 整个插件目录:文件被占用时删掉一半后抛出,插件残缺但仍处于启用状态,界面只拿到异常 | 先整体改名到 `.removing-*`(要么全成功要么什么都没动),失败时返回明确提示(请结束相关对话或重启后再删);改名成功后再尽力删除 |
| D3 | `relay/RelayManager.ts` | 中转:SSH 握手成功但部署转发器失败时,连接**一直开着没人关**;用户再点连接会创建新连接并覆盖引用,旧连接带着 keepalive 挂到应用退出,它迟到的 `close` 还会清掉新连接的引用并触发重连 | 部署失败时关掉该连接;`doConnect` 开始前收掉上一条;`error` / `close` 对已作废的连接只回复等待方,不改状态、不重连 |

## 已排查(无需再查)

- `mobile/`:配对(nonce 96 位 + 6 位验证码 + 5 次上限、常量时间比较)、设备令牌只在 SSE 允许走 query、`/api/rpc` 全部鉴权、吊销时断开连接、手机端读设置的令牌泄露守卫。
- `terminal/TerminalManager.ts`(退出 / kill / disposeAll)、`session/AutoArchiver.ts`、`onlyoffice/localInstall.ts`(下载、提权、取消)、`voice/models.ts` 下载(连接超时 + 停滞超时 + `.part` 改名)。
- `plugins/pluginManager.ts` 的 zip 安全检查(越界路径、符号链接)、git clone 代理回退。
- `lsp/LspManager.ts` 的崩溃恢复 / 重启竞态(已有大量防护注释,抽查无问题)。

## 已知限制(不改)

- 手机服务启动时只取一次局域网 IP,中途换 Wi-Fi 后二维码里的地址是旧的,需要关掉再开启手机服务。
- OnlyOffice 安装包下载没有停滞超时(可以手动取消)。
- 终端回放缓冲按字符截断,可能截在一个 ANSI 转义序列中间,回放开头偶尔出现一个乱字符。

## 打包后请验证

1. 插件:启用一个带 MCP 服务的插件并在对话里用过之后,**重装 / 升级**它:应提示成功,重启后加载的是新版本。
2. 插件:同样情况下**删除**它:要么成功删除,要么提示「文件正被占用」,插件不会变成残缺状态。
3. 中转(VPS)配置一个没有 python/socat 的服务器:应显示部署失败的原因;再点连接不会越连越多(VPS 上 `who` / `ss -tn` 只有一条 SSH)。
