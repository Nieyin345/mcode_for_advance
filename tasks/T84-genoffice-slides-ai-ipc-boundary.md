# T84｜Slides Mcode 宿主中的原厂 ai:* 云媒体 IPC 隔离（T75 发现）

| 项目 | 值 |
|---|---|
| 编号 | T84（GenOffice 路线图 T31-S 安全切片） |
| 重要性 | **P0 安全门禁**：独立云图片/媒体路径的真实授权前置未经证明 |
| 来源 | T75 静态断点、ARC-007 与 MC 安全边界（正式 MC 编号由总控先去重再定） |
| 复用 | L1 原厂 Slides 真实 handler、既有 Mcode scoped sender/审批/账户策略；L3 仅对原厂缺宿主身份处做可回放 patch |
| 可派 | **立即**；与 T83/T85/T73/T49 分文件范围并行，**不得并行抢真 Electron** |
| 独占可写 | `genoffice/apps/slides/src/main/ai-ipc.ts` 的 Mcode-hosted 特定通道 guard、确需的 `slides/src/preload/index.ts`、新增 **`patches/genoffice/0012-*.patch`**（编号实际查最新再递增）、新增 `apps/desktop/scripts/t84-slides-ai-boundary-smoke/*`、本任务卡 |
| 禁写 | `apps/desktop/src/main/document/docsAiPorts.ts` (T83)、`main/modules/*`/ `appControl/*`(T49)、`main/browser/*`(T73)、`genoffice/apps/slides/src/main/slides-main.ts` 非必要部分、其它五编辑器业务算法 |


## 现状（E2，不直接宣称已经真实外呼）
T75 查到 `genoffice/apps/slides/src/main/slides-main.ts` 的 `registerSlidesIpc` 会调用 `registerSlidesOnlyAiIpc`。其 `ai-ipc.ts` 有 `ai:generate-image`、`ai:analyze-media` 等直接注册到 Electron `ipcMain` 的原厂通道，调用 `generateImageTool` / `analyzeMediaTool` 并读 `AI_SETTINGS_PATH()`；通用 `mcode-view-ai` 只保护 `ai:stream` 等自己拥有的通路。这属于**可触达独立宿主外呼路径的安全审查缺口**，目前只有静态 E2，没有实际在线请求/凭据调用 E1。不能因为无账号所以请求报错就认为受宿主授权。

## 开工前必读
1. `tasks/T75-genoffice-agent-skills-six-app-audit.md` 的第 3.4 节、T05c/T54/T75 相关审核规范（不要把本任务卡自述视为既有实证）。
2. `genoffice/apps/slides/src/main/ai-ipc.ts` 中 **所有** `ipcMain.handle('ai:*')`，Slides `registerSlidesIpc`、preload 桥和 `patches/genoffice/0011-security-sheets-slides-scoped-ipc.patch`。
3. `apps/desktop/src/main/document/documentViewHost.ts` 的 sender-owner 文件/会话信任边界、`genofficeViewAiVendor.ts` 的失败封套；独立原厂 standalone 运行时的行为也要保留。

## 执行
1. 枚举所有 Slides `ai:* / media` 原生 handler，列 channel→功能→是否访问网络/文件/原厂账号→Mcode-hosted sender 是否可达；通过 mock 工具/禁止外呼的本地端口，**先复现未经过 Host 授权调用可进入 handler 的旧红例**。
2. 用原厂支持的 Hosted / Standalone 区分和已有 sender 签名，收紧 Mcode-hosted 未授权 sender 的独立 handler：请求仅可在 Host 已审批且版本/文件/会话身份一致时执行，或者明确 fail-closed 并告知 Mcode 能力尚未授权。Standalone 同一合法操作保持可用；严禁把 host 原生功能无条件砍掉。
3. 伪 renderer、错误 sender、WebContentsView 已关闭、session 切换、图像路径越界、取消后迟到请求和跨文档引用做负控；实际来源为本地 fixture，不启动网络请求、不读取真实账户凭据。
4. 在 Git 被忽略的 GenOffice 上游 clone 中做的任何必要改动必须产生**可重放、可校验**的新增 `patches/genoffice` 补丁，并经仓库现有 patch 应用/上游版本验证；**不可只改 ignored vendor 后声称已提交生产修复**。
5. 若现有 scoped upstream 入口无法稳定识别 Hosted 状态，记录必要的最窄宿主接线位置并**与 T83/T49 owner 协调后再派后续**，不在本卡创造含混 Host 自签授权。

## 验收
1. 提供所有相关 `ai:*` 通道清单及实际 Hosted/Standalone 门禁；Mcode-hosted 时不允许未经真人授权访问原厂云账户/网络/media。
2. 实测旧红→新绿、合法 standalone 正例、伪 sender/无审批/越界/取消/关闭页负例；不使用真实外部账号。
3. 原厂 renderer 与现有 Host 分别无功能静默降级、失败回执可读；至少两项 guard 撤除变异必红，再恢复上游和补丁 hash。
4. 可从干净固定 GenOffice commit 重放补丁；有新增 source patch 的完整许可证、上游来源说明，避免本地才存在的“鬼修复”。
5. 相关 Slides/文档安全 smoke 与双包 tsc 在隔离环境通过；不能启动真实 Electron 时留 U1 pending。
6. 真云帐号/审批真人/六编辑器总链 U1 另验，本卡没有独立实机时不签 ARC-007 完成。

## 不做
不在主进程额外发外呼，不复制官方云媒介算法，不改变 docsAiPorts（T83），不改 T73 BrowserPicker 或 T49 RPC。

## 结果回写区

<!-- 执行对话只追加：实际提交、旧红→新绿、源码/上游 SHA、失败负控、测试命令与计数、仍未满足的 U1，不要覆盖正文。 -->
