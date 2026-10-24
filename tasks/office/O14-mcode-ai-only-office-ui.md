# O14｜Mcode 页面集成 Office UI，GenOffice 原厂 AI UI 退出宿主模式

- Status: **有界交付：2026-10-25，六编辑器真实 Electron U1 6/6 PASS；Mcode 整屏视觉 + 真实在线模型联动仍需验**
- 归属：ARC-007 Office UI 二次集成；继续沿现有 O6 原厂主题/token 换壳，而不是新建 Office 内核
- 用户原话：“不要用genoffice里面的ai，而是用mcode的ai，genoffice对ai的ui删掉，你还要实现office的ui集成，集成到mcode页面里面。”

## 产品边界

1. Mcode 中栏沿用 **GenofficeViewHostPane → DocumentViewHost → GenOffice WebContentsView** 的已存在原生编辑器嵌入链；保留 Docs、Sheets、Slides、PDF、Markdown、HTML 各自的原厂编辑能力和 Mcode 主题换壳，不新增 iframe/OnlyOffice/第二套引擎。
2. **AI 唯一用户入口应是 Mcode 自己的对话、模型和文档工具。** GenOffice 的 Genspark AI 按钮、快捷 AI 功能组、原厂 AI 侧栏、选区弹窗在 Mcode 嵌入视图中**不挂载**。Mcode 的 `docsAiPorts`、`documentToolRuntime` 及既有用户审批不被移除或替换。
3. 独立 GenOffice 运行保留原厂 AI 功能，本次没有删除 vendor 的共享 AI 模块；使用原有 **Electron 产品 UA `Mcode/`** 作为宿主界面的判断，与 O8 主题识别保持同源；不要误把独立 GenOffice 的 `window.desktop` 当成 Mcode 标志。
4. 修复 T7 夹具：测试原先没有调用正式 Mcode `main/index.ts` 的 `app.setName("Mcode")`，导致在真实 Electron 中**确实看见 GenOffice AI 侧栏**（红例），补齐生产产品名且保留 U1 已隔离的 userData 路径后重测正常。此修改只影响 T7 测试宿主，不改公共 Electron 宿主初始化。

## 改动与证据

- vendor 新增 `packages/ui/src/mcode-host.ts`（`isMcodeHostedUi`）、从 `packages/ui/src/index.ts` 导出、附 `tests/mcode-host.test.ts`：**3/3 PASS**（Mcode / 独立 GenOffice / 非法产品名前缀）。新增的宿主 UI 分支跨六个原厂 App 及主要 Ribbon：`apps/docs`、`apps/sheets`、`apps/slides`、`apps/pdf`、`apps/markdown`、`apps/html`。侧栏、Genspark AI Home/Review/Annotate 功能组、选区 AI 浮层不渲染，编辑器画布及非 AI Ribbon 保留。
- 六个 vendor package 的 `typecheck` 均 **PASS**；Docs、HTML、Markdown、PDF、Slides 的 `electron-vite build` **PASS**。Sheets 完整 `npm run build` 因当前命令环境**缺少 `cargo`** 而停在 Rust 编译，但单独的 `npm exec -w @genoffice/sheets -- electron-vite build` **PASS**，借用现有 xlsx-sidecar（并非重编译了 Rust）。
- T7 六份生产旅程每格式额外加入**原厂 AI DOM 不存在**的双断言，保留原有 **打开→编辑→保存→关闭→真正 OS 进程重启→重开**。
  - 首次 Docs 真实 Electron 在修补夹具前**失败**：`.tmp/electron-u1/2026-10-24T20-09-33-025Z`，`mcode-docs-vendor-ai-panel-absent`、`.ai-dock` 命中 1，确实看到 GenOffice AI。修补 T7 的 `app.setName("Mcode")` 后独立 Docs 旅程 **PASS**（含两 OS 进程）：`.tmp/electron-u1/2026-10-24T20-13-06-763Z`。
  - 六格式完整真 Electron **6/6 journeys PASS**，每个走 2 个 OS 进程；新 AI DOM 断言与原内容、编辑、保存、重开断言全部通过；证据：`.tmp/electron-u1/2026-10-24T20-13-26-953Z`。
  - **已知既有边界**：Slides 的编辑动作经同一原厂 IPC/renderer API 而非直接模拟 Konva 点击；本次不扩大用户输入形式断言。
- GenOffice 独立提交 **`5f6b1d9bda041cdfc087218d2f4b77e8e58dd329`**（父 `f6d8e8a3c0e99e9328dc6fa7dd76ca559518545e`，树 `0c7f36855f2acecf4353db516094dcf609d5fa90`）。
- 第 26 条重放补丁 `patches/genoffice/0026-feat-office-mcode-ai-only-ui.patch`，**23436 bytes**，SHA256 `059faea963c3cdf1b968141001c57fd9960207b7d474f313339edd88ac3935c4`；来源锁与固定版验证器改为 **26 patches**，`MCODE_INCLUDE_GENOFFICE_BUNDLE=1` 来源重放核验 **PASS**；`genoffice-source-smoke` + `genoffice-editors-release-smoke` **2/2 PASS**；Mcode Desktop tsc 0 错。
- Mcode 的用户 ChatPane、模型设置/SDK、审批策略、Office 数据文件及其它执行会话的 UI 未提交/未修改，本次只精确写 GenOffice fork、T7 受控验收、官方补丁锁与 Office 进度台账。

## 后续不可冒充已交付的部分

- **实际 Mcode 完整 React 页面**的整体 AI/Office 分栏、工具结果在聊天区的回流、文件页签与编辑器多窗口焦点交互，尚无最终完整 U1；本次验证的是 Mcode 原生 DocumentViewHost 嵌入下的真实编辑器页面，不能替代用户整屏视觉验收。
- Claude/Pi/Codex **在线模型实际操作**、选区/文件路径传递到 Mcode 聊天侧、审批确认和工具回写后格式保真等仍需要分项验证。本次不是把原厂 AI 换个名字继续调用：GenOffice AI UI 在宿主视图真正移除，Mcode AI 保持已有渠道。
- 仍需在真正安装后的产品和 macOS/Linux 做验证；独立 GenOffice 的 AI 完整 GUI 仅由编译和宿主识别单测间接覆盖，没有真实独立版 U1。
