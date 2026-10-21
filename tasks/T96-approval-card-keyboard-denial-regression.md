# T96｜桌面审批卡键盘拒绝与焦点回归（T78 UI 安全交互）

| 项目 | 值 |
|---|---|
| 编号 | T96 |
| 工作包 | ARC-005 / T78 后续 UI 审批旅程；只测真实组件隔离行为 |
| 优先级 | P1 |
| 可派 | **立即**；与 T89–T95/T97 共享的只是只读 i18n/Store，不改 T92 工具桥 |
| 独占可写 | `apps/desktop/src/renderer/components/chat/ApprovalPrompt.tsx`、`McpToolDecisionCard.tsx`（仅有独立红例时最小修）、新增 `apps/desktop/scripts/t96-approval-keyboard-smoke/**`、本任务卡 |
| 禁写 | `stores/sessionStore.ts`、`hooks/useApprovalArming.ts`、`main/**`、`contracts/**`、`src/renderer/components/chat/ComposerEditor.tsx`、T92 / T71 / T77 文件，其他审批卡 |


## 背景

T78 39/39 场景有“权限审批”视觉格，但探针只检查 `alertdialog` 存在，没有验证用户按 Tab / Escape / Enter、焦点返回、允许与拒绝后的状态。生产 `ApprovalPrompt` 明确声明：显示新卡时焦点应在卡上（不可直接让 Enter 批准），Esc 拒绝，允许按钮有短暂 arming delay，隐藏会话不得消费当前会话的按键；`McpToolDecisionCard` 是 read-only，不得自行决定授权。必须用可执行隔离用例证明这些要求。

## 开工前必读

`audit-ledgers/README.md`、T78 报告与源码 `ApprovalPrompt.tsx`、`McpToolDecisionCard.tsx`、`mcpDecision.ts`、`useApprovalArming.ts`（只读）、现有审批和 focus Smoke；Mcode 危险操作每次真人点的授权规则。

## 执行

1. 先建 jsdom/React 实际组件挂载（若仓库已有框架复用）：pending 初始焦点卡片、无意 Enter 不批准、主动 Tab 到按钮且 arming elapsed 才能批准、Esc 必拒、IME composition/229 不能误拒、卡切换重新 arm、隐藏 keepalive 的 Esc 无效。
2. 测危险 `APP_DANGER_APPROVAL_PREFIX` 不能显示“始终允许”或绕过后端门禁；MCP 卡 pending/running/success/denied 的状态只来源于输入 props，不得在组件 mount/超时后自行合成 permission response。
3. 测用户按拒绝后的焦点返回/可操作性与窄窗按钮可见：若这部分需要上层 ChatPane/focus 管理才能完成，明确缺少的注入 seam，不能篡改 Store 来假装通过。
4. 旧红例经有界源代码归因，只有生产组件确有缺陷才改上述两文件；否则只补测试网且报告 UI U1 未做。
5. 负控移除 Esc gate / arming gate / dangerous always-allow 限制，应使对应断言变红；逐字节恢复。运行旧 focus/approval 代表套和双包 tsc；真 Electron 与 T71/T77 串行。

## 验收判据

1. 无意 Enter 不授权，明确 Tab + armed 的用户动作才授权，Esc 拒绝、IME 不误触发、隐藏 pane 不夺焦点。
2. 危险方法不能永远允许，MCP 结果卡只是可观察状态；拒绝后仍可安全操作。
3. 动态组件测试有旧红→新绿、至少两项变异红→绿；无实证缺陷时不随意改生产源码。
4. 仅提交本任务文件边界；真 Electron U1、在线三 SDK 人工审批另验。

## 不做
不执行实际 Shell/网络/文件写操作、不将自动测试点击当真实人批准、不改 RuntimeManager 或跨进程审批事实源。

## 结果回写区

<!-- 只追加实施提交 SHA、旧红→新绿、测试命令/日志、变异→恢复字节、未验判据和剩余风险。 -->
