# Mcode 打包前检修 — 最终验收记录（2026-09-30）

> 阶段一代码修复已提交 `077bf47e8b88743798c3b3c7f1c081350f6a29fb`，见 [阶段一报告](RELEASE-READINESS-2026-09-29.md)。本文记录随后完成的运行时、安全依赖与 SDK 打包链路检修。只提交本轮内容，不 push，不操作真实用户库或调用真实模型。

## 结论

**本轮检修与限定范围的打包门禁已通过，可以进入正式安装器制作及发布前验收。** 同一冻结源码完成 173/173 全量 smoke、runner 10/10、双包 types、完整 build 和 Windows x64 unsigned 目录包实测；官方全依赖公告命中从 96 降至 0。不是“正式发布全部通过”：NSIS / 签名 / 安装升级与真实服务仍须单独验收。

**验收对象是保留用户已有修改的当前工作区，而不是仅 checkout 本轮提交后的净树。** BrowserManager / main index 等文件中的既有修改保留；两处混合文件按 own-only hunk 提交，其余既有工作区修改不夹带。目录包包含构建时工作区内容。

## 主要修复

### 1. 受支持的 Electron 与真实 API 适配

- Electron 从 33.0.0 实际升级并精确锁定到 **44.4.5**；二进制为 Node **24.21.0**、Chromium **152.0.7977.130**、modules **149**，不是只改版本号。
- 清缓存时移除已取消的 `websql`，继续保留 cookies；登录认证没有 webContents 时显式取消，避免空对象访问。
- 图片剪贴板使用 Electron 44 的 PNG Blob / ClipboardItem 数组，并 `await clipboard.write(...)` 后才返回成功，异步错误仍明确反馈。未覆盖用户 OS 剪贴板：写入行为使用隔离 handler 测试，原生测试只构造并读取 ClipboardItem。
- 新 `build/ensure-electron.cjs` / desktop postinstall 显式桥接项目已有 HTTPS mirror，尊重环境覆盖和跳过下载选项，调用上游安装器、传播失败状态；不另写下载器、不弱化 TLS / checksum。
- pnpm 的 canvas 构建脚本为 false；新增 Squirrel 可选安装器也明确为 false，当前 Windows 目标为 NSIS，不无差别批准依赖脚本。

依据：Electron [支持政策](https://www.electronjs.org/docs/latest/tutorial/electron-timelines)、[发行计划](https://releases.electronjs.org/schedule)、安装后的声明与二进制。Electron 33 EOL 项已处理，仍需持续跟随受支持 patch。

### 2. 安全公告不能被“构建成功”掩盖

- 原 registry 镜像没有 audit endpoint；临时改用官方 npm advisory endpoint，未改 `.npmrc` 源配置。
- 初次 `--prod` 命中 **26 条（9 high、16 moderate、1 low）**。进一步查全部依赖，因为前端打包库也放在 devDependencies；完整结果为 **96 条（1 critical、47 high、42 moderate、6 low）**。
- 定向更新后，官方全量依赖检查 **0 条已知公告命中**，没有配置忽略 CVE 或用 audit-level 隐藏告警。这是公告数据库结果，不代表证实所有旧问题在 Mcode 可利用，也不代表不存在未知漏洞。
- 构建工具升级为 **electron-builder 26.15.3、electron-vite 3.1.0、React Vite plugin 4.7.0**；Tiptap 五个直接依赖统一 **3.31.3**。保留 Vite 6 / 业务 Zod 3，不为消除告警盲目切换业务 schema 主版本。
- 对 fast-uri、ip-address、Hono / node-server、js-yaml、qs、DOMPurify、PostCSS、undici、nanoid、ejs、xmldom、brace-expansion、semver 的间接依赖使用限定旧版本范围的修复覆盖。新 builder 消除旧 tar 6 / builder 库安全项；未强行把旧 tar API 全局重映射到新主版本。
- PPTX 的 uuid / ECharts 修复需要跨主版本，分别限定在 pptx-preview 的依赖边上更新到 **11.1.1 / 6.1.0**，并用真实浏览器加载合成 PPTX，验证标题、图表实例、柱图数据及实际渲染面。
- 新根命令 `pnpm audit:deps` 默认检查全部依赖并使用官方公告源。构建宿主最低 Node 版本对齐实际依赖要求 **≥22.19.0**；本机实测 Node 22.21.1 / pnpm 11.16.0。

### 3. SDK 独立 schema 运行时与协议适配

- 扩大包检查后，旧包中 SDK 的 `zod/v4` 入口缺失；不仅检查主 bundle 的静态引用，还检查 SDK 自身解析路径和实际模块加载。
- desktop / contracts 保持 **Zod 3.25.76**；SDK 使用独立 **Zod 4.4.3**。精确限定当前 SDK 版本的 `.pnpmfile.cjs` 修复依赖解析元数据，配套 pnpm package.json patch 让物化后的依赖声明和打包器看到的声明一致。**只用 resolution hook 时 peer 检查虽绿，解包仍误用根 Zod 3；增强包检查确实拦住了这一版。**
- 没有放宽或忽略 SDK 的 Zod 4 要求，也没有把业务契约强迁 Zod 4；最终包检查要求 SDK 实际解析到 Zod 4 并成功导入 SDK，不发起 query。
- 真实类型重新可解析后，修正 MCP tool adapter：同步结果/异常统一转为 Promise，保留文本、图片、isError 和 structuredContent，不用 unknown 强转压掉错误。两条生产回归 **47/49 红 → 49/49 绿**；另补物化依赖一致性检查至 **50/50**。
- Elicitation 的已知字符串答案映射使用明确字符串记录类型，保持原交互和内容语义。

## 最终验证

| 项目 | 结果 / 范围 |
|---|---|
| 全量 smoke | **173/173，0 fail**；Electron 44 最终源码完整重跑，不沿用阶段一结果 |
| runner 自测 | **10/10** |
| release-readiness 行为检查 | **50/50**：真实生产函数、构建插件、安装器、SDK adapter / 依赖元数据 |
| 隔离原生窗口 | **8/8**：主导航/redirect、子 frame、popup、camera denied、不同 file 文档、原生 PNG ClipboardItem |
| 真实浏览器库 | **8/8**：Node 隔离、DOMPurify、Tiptap 原型属性防护及编辑序列化、PPTX 标题/实例/数据/渲染面；无外部网络，无真实用户文档 |
| 双包 typecheck | contracts / desktop 均 exit 0 |
| 完整 main/preload/renderer build | exit 0；分别转换 3070 / 42 / 9918 modules |
| 全依赖公告 / peers | 官方 audit 无已知漏洞；`pnpm peers check` 无不兼容 peer；仍有 6 个上游 deprecated 提示，不等同安全公告命中 |
| 安装一致性 | 实际 pnpm install 的日志已确认 desktop postinstall 执行成功；早期那次 Already up to date 无生命周期日志不冒充执行证据 |
| Windows x64 unsigned 目录包 | **通过**；builder 26.15.3、Electron 44.4.5、pnpm collector，publish never |
| 包内资源 | ASAR **145,966,335 bytes / 4,889 entries**；PDF **185** 文件及 WASM 哈希、解包原生文件 **20**、静态引用 **87** |
| 包内运行 | SDK 模块 / 独立 Zod 4、真实 preload bridge、SQL 内存查询、sherpa 绑定、ConPTY echo、ssh2/simple-git/updater；不加载产品 main / renderer，不借开发依赖 |

证据和产物（以下路径相对仓库根；隔离 `.tmp` 不提交）：

- 全量日志：`apps/desktop/.tmp/smoke-runs/1790746541263-41320-e9MRQ8`。
- 其中原生窗口：`apps/desktop/.tmp/release-window-jgOixR`；真实浏览器：`apps/desktop/.tmp/release-libraries-bpW1Sn`。
- 最终目录包：`apps/desktop/.tmp/release-preflight-unpacked-1790747888443/win-unpacked`。
- 解包检查结果：`apps/desktop/.tmp/release-package-check-HWjOc6/result.json`、`native-result.json`、`references.json`。
- 收尾另执行 **`pnpm install --offline --frozen-lockfile` 成功**（Already up to date，未声称该次重新运行 postinstall），再跑 readiness 50 / native 8 / browser 8；日志：`apps/desktop/.tmp/smoke-runs/1790748005470-29912-Aw7S5x`。workspace 实体化无新增替换，源码复核再次通过。
- 最终串行验收命令 `cmd_9bc6210766b91324d8b26bf682b3c87002af6f28b0d5182f` completed / exit 0；收尾复现命令 `cmd_a7bceecd5653c66d03cda66decaeef1420a8bdb88f776335` completed / exit 0。

**源码一致性**：在 HEAD `077bf47e8b88743798c3b3c7f1c081350f6a29fb` 下，对 **1,844 个 tracked / unignored 输入文件**记录 SHA-256，最终串行链和离线安装复验后均一致。覆盖既有未提交源码；排除报告/状态文档、`.tmp`、构建产物和带时间戳的 Vite 临时配置。快照：`.tmp/release-preflight/runtime-source-freeze.json`，文件 SHA-256 `9af71d89a2cfba0736fef9b4f8940d563514928dedd0cd8be4ad0ae293ed9399`。文档在验收后按结果更新，提交前另核对 fresh SHA；不把文档更新声称为重新执行全部测试。

## 红测试与检修过程说明

- 默认 Electron lazy / upstream 下载 fetch failed；显式项目 HTTPS mirror 后实际成功，不推断为 TLS 或上游完整性失败。
- API 迁移不能只靠 mock：一度沿用旧剪贴板写法，真实 Electron types 拒绝后改为 ClipboardItem 数组并补原生验证。
- 旧 smoke Electron 替身缺少 ClipboardItem 导出，首次全量出现构建期失败；该轮中止，不计通过。四个替身补齐并继续禁止访问 OS 剪贴板，关联 6 套定向回归通过后重跑完整验收。
- 初版 preload 检查误写 `api.clipboard`；生产接口实际是 `api.clipboardFile`，修正测试后验证真实桥，不修改生产接口或删掉检查。
- PPTX 的 chart 在 preview() resolve 后通过 setTimeout 创建；新 fixture 改用带超时的 DOM 观察等待真实渲染，不把检查时序误判成生产缺陷。
- pnpm install 会恢复 workspace 链接。打包前使用正常 dereference 准备，不直接跳过必要步骤；只改 node_modules 中的复制，不改工作区源码。
- isolated Node API 包装器一度使用 npm collector；最终在 **pnpm exec 上下文**检查，与正常 pnpm package 保持一致。所有 unsigned 产物都不代表正式安装器 / 签名通过。

## 覆盖及未验边界

本次覆盖阶段一的持久化、IPC/权限、会话与引擎、通用工作流/自动化/模块、手机链路、初始化、Markdown/引用、文件链接、PDF/Office、终端、语音、更新器回归，并补运行时、安全依赖与实际包检查。不是逐行穷尽证明，也不保证绝无 bug。

- **未执行正式 NSIS 安装、卸载、覆盖升级、签名或公证**；macOS/Linux 未本机打包。
- 未启动 Mcode.exe / 产品 main，未访问真实用户数据库、模型账户、外部 MCP/MinerU/OnlyOffice、真手机或录音硬件。SDK 导入不等于真实模型调用通过。
- 本轮目录包关闭 signAndEditExecutable；正式配置仍可能需要 Windows 签名 / NSIS 缓存和网络。不能用本轮结果保证这些环境步骤。
- 现有 dynamic/static import 混用与 chunk 体积提示仍存在，可另做体积/冷启动优化。
- 确定性初始化、不覆盖、project/worktree 作用域和无模型执行保持；学术以通用编排为主但不是零内置；历史 Markdown 和当前会话引用行为不回退。

## 打包与复跑

仓库根 PowerShell：

```powershell
pnpm peers check
pnpm audit:deps
node --test apps/desktop/scripts/run-smokes.test.mjs
node apps/desktop/scripts/run-smokes.mjs --all
pnpm --filter @mcode/contracts typecheck
pnpm --filter @mcode/desktop typecheck
# 正式打包由用户执行；包含 build、workspace 实体化及 contracts/dist 清理。
pnpm --filter @mcode/desktop package
# 对正式生成的目录复验：
node apps/desktop/scripts/release-readiness-smoke/check-unpacked.cjs apps/desktop/release/win-unpacked
```

Electron 二进制未准备好时可单独运行 `node apps/desktop/build/ensure-electron.cjs`。正式发布前另做隔离用户目录下的安装/升级和关键真实服务验收，不扩大本报告的通过范围。
