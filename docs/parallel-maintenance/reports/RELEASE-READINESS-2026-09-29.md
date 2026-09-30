# Mcode 打包前检修 — 2026-09-29

> 阶段一（现有 Electron 33 环境）的代码修复与验证结果。基线 `a0073508e9ead0f478e7bdfa684db38cb9048d87`；不 push、不调用真实模型、不操作用户数据库。按模块风险面、生产代码回归、构建与解包实测检查，不宣称逐行穷举或绝无缺陷。

## 尚未关闭的发布项

实际运行时是 Electron 33.0.0，官方支持表列出 33 系列已于 2025-04-28 停止支持。不能将本阶段解包通过等同于正式发布安全通过。用户已再次要求全方面检修，后续将升级受支持运行时并重新验收，不仅修改版本号。2026-09-29 从 npm 公共 registry 查询到最新稳定版为 44.4.5。

依据：Electron 官方发行表 https://releases.electronjs.org/schedule ，支持政策 https://www.electronjs.org/docs/latest/tutorial/electron-timelines 。

## 本轮修复

| 问题 | 修复与生产回归 |
|---|---|
| 手机普通 slash 菜单触发桌面初始化 RPC 并报错 | refetch effect 增加桌面条件；修正浏览器 fixture 真正传入 menuOpen；21/23 红后转绿 23/23，保留手机 `/init-` 明确拒绝 |
| PDF 版本标记掩盖资源缺失、截断 | marker 相同时仍递归检查源/目标文件类型和大小，修复缺失 WASM、CMap 与截断字体；不声称生产逻辑做内容哈希修复 |
| 主窗口任意外链和跨文档导航 | 共用 URL 白名单 http/https/mailto，拒绝凭证和任意 OS 协议；主窗口只允许相同入口路径；主 frame 重定向受控、子 frame 不误拦截 |
| 默认 session 媒体权限过宽 | 仅当前存活主窗口，拒绝其他 webContents、已知子 frame、明确视频请求；保留主界面音频与剪贴板 |
| 内嵌浏览器 popup 系统回退无协议限制 | 复用同一白名单；保留正常网页新标签与 web/mail 回退，不把 local file / 任意协议交给 OS；新增路径不记录原始 URL/token |
| 浏览器异步导航拒绝未处理，关闭后仍导航 | 捕获 cookie restore / loadURL Promise 拒绝；导航前检查 WebContents 生命周期；33/36 红后通过 |
| 打包 dereference 发布失败丢失原链接 | 唯一 staging + 备份链接，发布失败恢复；恢复失败保留备份并准确报错；路径包含关系用 relative 边界；19/20 红后通过 |
| 打包后 Zod peer 入口不存在 | 真实 ASAR 的 Mistral chunk 引用 zod/v4、zod/v4/core，但包内根依赖是 Zod 3.24.0。主进程按实际解析路径打包 Zod 3/4 与转换器，不升级/安装依赖；实际 Vite 混合 peer 回归 36/37 红后 37/37 绿，重新解包验证通过 |

## 阶段一验证（Electron 33，升级后的结果须另行记录）

- 新增 `release-readiness-smoke`：37/37；实际生产函数/方法与实际 Vite 插件配置，不复制业务算法。
- 手机初始化 UI：23/23（浏览器、API/store 隔离，不等同真手机与完整应用视觉验收）。
- smoke runner：10/10。
- 两次全应用生产构建 exit 0；最后主进程修复后，复用正式配置的 main 部分完成重建，最终打包使用这份主进程输出。渲染/预加载输出未再变更。
- 最终全量 **173/173 smoke 通过**，随后再次执行 contracts 与 desktop 双包 typecheck，均 exit 0。对应日志：`apps/desktop/.tmp/smoke-runs/1790690822712-44872-Qb3APC`。
- Windows x64 unsigned `--dir --publish never` 解包通过；复用本地 Electron，不触发发布，不执行真实 workspace dereference 或删除 contracts/dist。
- 解包结果：ASAR 140,481,296 bytes，4,066 个条目；185 个 CMap/字体文件和 PDFium WASM 与安装源 SHA-256 相同；20 个 `.node`/`.dll` 解包为实际文件；87 条主进程/预加载静态 import/export 引用解析通过。
- 隔离 Electron 33.0.0 宿主：限制依赖解析在 app.asar/app.asar.unpacked 内，不能借用开发依赖；内存 SQL 查询、sherpa 原生绑定加载、包内 ConPTY echo 均通过。未创建语音模型、未使用麦克风、未运行 Mcode.exe 或产品 main。
- 最终解包目录：`apps/desktop/.tmp/release-preflight-unpacked-1790690693024/win-unpacked`。
- 包内实测报告：`apps/desktop/.tmp/release-package-check-WQPSiH/result.json`。

## 检查覆盖面

- 启动/退出与持久化：配置及 db/init 路径走查，db-migrate、db-persistence、runtime-state、run-store 回归。
- IPC/权限/移动端：ipc-parity、ipc-wiring、path-guard、mobile-pairing/static/sync、public-mcp-session 等回归；另补生产窗口权限与导航测试。
- 会话/引擎/工作流/自动化/模块：engine-regressions、code-electron、execution-engine、workflow、automation、module-phase2-security/e2e、conversation-queue 等现有回归。
- 界面与资产：项目初始化、设置、Markdown/引用、文件链接、资料库、PDF/Office、编辑保存、终端、语音、更新器等现有回归；重点补手机真实 hook 菜单和离线 PDF 资产检查。
- 构建/打包：正式配置构建、workspace 链接发布失败注入、混合 Zod peer 小型真实构建、完整 ASAR 资源与隔离原生运行检查。
- 这些是风险面审查和自动化验证，不代表对全部源码逐行证明正确，也不代表全部外部服务和设备已实测。

## 执行过程中的失败与处理

- 初次全量在正式构建并行时，code-electron-smoke 的自然退出用例触发 6 秒超时。该轮已停止，不能算通过；随后在无构建竞争时单独复测通过，并在最终 173 套全量中再次通过。未放宽该用例超时阈值。
- 新 post-pack checker 的第一版在 Windows 上未把 ASAR API 路径改为本机分隔符，校验器先失败；修复校验器后暴露真实 Zod 打包缺陷。未把这次校验器错误当作产品修复。
- 本阶段全量及类型检查是本次重新执行的结果，不引用上一轮 172/172；仅提交本轮代码、回归和说明，不 push。

## 验证边界与正式打包

- 本轮不是正式 NSIS 安装、卸载、覆盖升级或签名/公证验收，也不是完整产品启动验收。
- 未测试真实模型账户、下载镜像、外部 MCP/MinerU/OnlyOffice 服务、真手机连接和真实录音设备；macOS/Linux 未做本机打包。
- 本次为离线资源与运行时验证，关闭 Windows signAndEditExecutable；正式 NSIS 仍使用原配置，可能需要本机 winCodeSign/NSIS 缓存及下载网络，不能用本次结果保证这些环境步骤。
- 动态/静态 import 混用与大 chunk 提示仍存在，不是构建失败；后续可单独做体积/冷启动优化。
- 保留初始化确定性、无模型、预览确认、不覆盖与 worktree 作用域；学术仍由通用编排为主，但不是零内置。历史 Markdown 与引用行为不回退。

复跑命令（仓库根）：

```powershell
node --test apps/desktop/scripts/run-smokes.test.mjs
node apps/desktop/scripts/run-smokes.mjs --all
pnpm --filter @mcode/contracts typecheck
pnpm --filter @mcode/desktop typecheck
pnpm --filter @mcode/desktop build
# 正式打包仍由用户执行；该脚本包含 contracts/dist 清理及 workspace 链接实体化。
pnpm --filter @mcode/desktop package
# 对新的 win-unpacked 目录复跑资源/原生验证：
node apps/desktop/scripts/release-readiness-smoke/check-unpacked.cjs apps/desktop/release/win-unpacked
```
