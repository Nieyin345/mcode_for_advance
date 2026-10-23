# T30｜文档工具面缺真实 Electron U1 —— 只有 fake 端口验证过

- Status: ready-for-agent
- Category: **test（证据缺口）**
- Priority: P1
- Depends on: T24（`ce2913f8`）、T7（`77fdd012`）
- Exclusive writable files: 新建 `apps/desktop/scripts/t30-document-tools-u1/`、复用 `apps/desktop/scripts/electron-u1/driver/`。**不改**产品代码。

## Required Skills
- `mcode-smoke`: 理解 E1 与 U1 的边界，知道 fake 端口能证明什么、不能证明什么。
- `code-review`: 确认断言测的是真实路径，不是桩。

Read before work: `CLAUDE.md`、`tasks/T24-document-tool-surface-redesign.md`（**§九 遗留与移交**）、`tasks/T7-genoffice-native-editors-u1.md`、`apps/desktop/scripts/electron-u1/driver/`、`apps/desktop/scripts/t7-genoffice-u1/`。

## T24 自己承认的遗留（原话）

> **真实 Electron U1 与三引擎在线回合未做**（T7 排期）：本卡的渲染端路线由 **fake 端口**驱动验证了「绑定身份/原始定义/拒绝路径」，**没有在真窗口里让真模型经 `document_tool_call` 调一次原生工具**。

## 这意味着什么

T24 交付的工具面（139 个工具 → 2,595 B，降 98.1%）**只在 fake 端口上验过**。真实链路是：

```
真 Electron 窗口 → 真 GenOffice 渲染端 → 真 AgentSkill.executeTool
→ document_tool_call → 结果回到同一 SDK turn
```

**这条链路从没在真窗口里跑通过。**

## 目标

用 `electron-u1` 骨架，在真 Electron 里验证 `document_tool_call` 的完整往返。

### 必须覆盖

1. **发现链路**：`document_apps()` → `document_tools_list({app})` → `document_tool_describe({tool})` 在真窗口里返回正确结果。
2. **调用链路**：`document_tool_call({tool, input})` 真的让渲染端执行了工具。
3. **结果回传**：工具结果带着 requestId / callId 回到宿主。
4. **负控**：
   - 未打开的文件调渲染端工具 → 拒绝
   - 未知工具 → 拒绝
   - 错误的 docId → 拒绝
5. **至少两个真实编辑器**（建议 Docs + Sheets，它们有成熟的工具面）。

### 不用做的

- **不需要真模型**。用 fake SDK 触发调用即可，但要**真 Electron + 真渲染端**。
- 不需要覆盖全部 139 个工具——验证链路，不是验工具质量。

## 验收判据

1. 真 Electron 起窗口，真 GenOffice 渲染端加载。
2. `document_apps()` / `tools_list` / `describe` 返回正确。
3. `document_tool_call` 让渲染端**真的执行**了一个工具（有可观测证据：DOM 变了 / 文件变了）。
4. 结果带回 requestId / callId。
5. 三条负控全部拒绝。
6. 至少两个编辑器的链路都通。
7. **变异验证**：把断言改成无条件通过 → 应红的必须红 → `cmp` 还原。
8. **不得**宣称 T7 或 T24 的验收被本卡取代。

## 边界

- **不改产品代码**。发现缺陷列出，另开卡。
- **独占 Electron**：开工前 `ps` 确认。
- **不改** `apps/desktop/scripts/electron-u1/driver/`（T16 交付的骨架）。

## 结果回写（2026-10-23）

（执行者在此追加：链路各段的实际证据、两个编辑器的结果、负控证据、变异证据、提交 SHA、发现的缺陷）
