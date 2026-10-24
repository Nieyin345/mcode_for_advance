# O15｜Office 六格式停靠与 Mcode AI 会话草稿交接

- Status: **有界交付，2026-10-25**：路由与草稿行为测试及四套 smoke 通过；真实 Mcode 整屏交互/在线模型仍待验
- 归属：ARC-007；接 O14 去除 GenOffice 自带 AI UI 后的宿主 AI 入口和布局接缝
- 不修改 GenOffice 源码，继续固定 vendor `5f6b1d9`、26 patches。保留其他对话未提交工作。

## 用户可见路径

1. 右侧文档停靠不再只识别 `\.docx`：`RightPanel` 使用 `canDockOfficeFile`，后者复用 `@contracts/genofficeFileRoute`，覆盖 docs/sheets/slides/pdf/markdown/html 六编辑器的文件后缀，未知后缀不能进原生编辑器。
2. Mcode 自有 `GenofficeViewHostPane` 的文档视图上沿增加一个小型工具栏，提供“交给 Mcode AI”（中英文）。它在 Mcode React 宿主内，**不在 GenOffice AI 页面内**；依靠 stageRef 的下方矩形同步原生 OS 子视图，避免原生子视图遮住宿主按钮。
3. 点击时 `handoffOfficeToMcode` 调用当前 `useSessionStore.getState()`：
   - 当前会话不可用或文件扩展名不受支持时 **不执行任何操作**；按钮无会话时禁用并解释。
   - 向 Mcode **现有 ChatPane 草稿**追加 `makeFileTag` 文件引用（`@绝对路径`；不读文件内容、不调用厂商 AI），复用 `deliverComposerDraft` 的 touch 通知使打开的输入框立即同步，保留现有文字、HTML 与其他附件，重复点击同一路径不重复挂载。
   - 使用原 `setLayoutPaneContent('right',{kind:'document'})`、`setRightOpen(true)` 与 `setCenterTabFocus('chat')` 让聊天与 Office 编辑器并排显示；用户在 Mcode 的聊天框自己输入需求、选择模型、点击发送。**不自动发送、不免除审批、不改独立 GenOffice。**
4. Mcode 不新增 Agent loop、模型配置或新的文件写入通道。真正的 Office 修改继续受既有 Mcode document tool/文件系统和审批机制管控。

## 测试证据

- 新增 `apps/desktop/scripts/office-mcode-handoff-smoke/`：六种扩展名、拒绝未知扩展/空路径、保存未发送文字/HTML、文件 tag 形状、重复去重、无会话/错误后缀绝不改状态、动作顺序与目标会话隔离、Mcode 宿主按钮及右侧布局接线检查。
- `node apps/desktop/scripts/run-smokes.mjs office-mcode-handoff-smoke arc005-workspace-rail-polish-smoke arc005-pane-docking-smoke genoffice-file-routing-smoke`：**4 PASS / 0 FAIL**；日志 `apps/desktop/.tmp/smoke-runs/1792873699934-39652-xoU5Ur`。
- `npx tsc --noEmit -p apps/desktop/tsconfig.json`：**PASS**。
- `npx tsc --noEmit -p packages/contracts/tsconfig.json`：**PASS**。
- 只提交属于 Office 接口与右侧停靠的六个文件和两份新测试文件，保留同时工作的 UI、工作流、扩展等其他修改。

## 边界及下一步

- **未做真正完整 Mcode React 整屏 + Office WebContentsView 的可视化 U1**，不能用现有纯逻辑 smoke 冒充最终 UX。
- **没有验证真实在线 Claude/Pi/Codex 的完整工具编辑与格式保真回流**。点击按钮只是草稿交接，是否能按用户指令改变文档仍要单独测试 AI → tool → editor → save → reopen。
- 后续 UI 检查：右栏狭窄窗口下工具栏是否遮挡，Ctrl+Tab/Focus 的键盘焦点，重新布局时 WebContentsView 是否出现孤儿/遮盖，模型修改后打开页面的刷新、冲突与 dirty 提示。

## 追加：PDF 路由 smoke 误报收尾（本轮）

- 在交接后的补充回归中，原 `document-router-smoke` 为 **99/103，4 FAIL**。现场检查 `FileViewer.tsx` 与 `FilePreview.tsx`，真实 PDF 路由仍先于 Office 分支并返回 `PdfPreview`，并无产品回退。
- 根因：`document-router-smoke/main.ts` 使用已经在 O5 删除的 `if (isOnlyOfficeSupportedPath(...))` 作为两个 PDF 分支 slice 的终点；因此 `officeBranchStart=-1` 导致 `pdfBranch=""`，四条断言误红。
- 仅把测试边界更新为 `if (isOfficeDocumentKind(documentKindOf(...)))`，不引入新路由表、不恢复 OnlyOffice、不改生产 PDF 渲染。
- 同样的 `document-router-smoke` 修复后全绿（**103/103**）；联合 `genoffice-file-routing-smoke` 和 `office-mcode-handoff-smoke` **3/3 suites PASS**；日志 `apps/desktop/.tmp/smoke-runs/1792873899098-13608-DPUXob`。保留修前红例日志 `1792873845770-15204-JZaO9b`，证明旧断言真实会红而不是空过。
