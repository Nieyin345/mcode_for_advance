# T05c｜Docs 的 AI 面板：默认拒绝 + 显式审批后可用

| 项目 | 值 |
|---|---|
| 编号 | T05c |
| 类型 | ARC-007（T05 拆分第三张） |
| 优先级 | 中高 |
| 建议并发 | **不要与 T05b 同时派**（都改 `genoffice/` 与 `src/main/document/`） |
| 预计规模 | 中大 |

---

## 先说清取向（这一条最容易做错）

台账第 5 条写死了：

> 上游原有功能应保留为可受控调用的能力，风险能力应显式受限/告知，
> **而非静默删除或平行直连**。

所以 **12 个 `ai:*` 不是"删掉"，是"默认拒绝 + 显式审批后可用"**。

更要紧的一点：**GenOffice 的 AI 面板必须经 Mcode 的三 SDK 跑，不是它自己的云 AI。**
用户的目标是「对话由 Mcode 的三引擎（Claude / Pi / Codex）驱动」，GenOffice 只是
文档内核。所以这里的正确形态是：

```
GenOffice 的 AI 选区弹框 / 侧栏
  → 不连 GenOffice 自己的 ai-provider / 云账户
  → 转成 Mcode 的 typed action
    → 经 app_api_call 审批 → 三 SDK 之一执行
      → 结果回填到 GenOffice 编辑器
```

**不是**把 `ai:stream` 接上让它自己去调 OpenAI/Anthropic API。

---

## 12 个 handler 的分类

先按「谁执行」分，再决定每个怎么处理：

| handler | 原厂做什么 | 本卡怎么处理 |
|---|---|---|
| `ai:get-settings` / `ai:set-settings` | 读写它自己的 AI 配置 | **不迁**：Mcode 的模型配置是唯一事实源。改为读 Mcode 的 provider 列表 |
| `ai:stream` / `ai:stream-cancel` / `ai:chat` | 直接调云 API 流式对话 | **改造**：转发到 Mcode 的三 SDK，不直连 |
| `ai:codex-models` / `ai:custom-models` | 列模型 | **复用**：读 Mcode 的 `custom-model` 与 provider 能力表 |
| `ai:gsk-login` | GenSpark 账号登录 | **不迁**：用户不要云账户，改为提示「请用 Mcode 的三引擎」 |
| `ai:web-search` / `ai:image-search` / `ai:media-test` / `ai:search-test` | 它的搜索服务 | **不迁**：Mcode 有 `app_api_call` 的搜索能力。要么映射，要么明确 unavailable |

**判据**：每个 handler 都要有明确归属（迁 / 改造 / 复用 / 不迁），写进
`docs/planning/arc007-genoffice-native-integration-map.md` 的 T05c 表。

---

## 开工前必读

1. **T05a 与 T05b 的任务文件与回写区** —— 你会复用它们建立的边界层
   `mcode-ipc.ts` 与 `docsVendorIpc.ts`。
2. `genoffice/apps/docs/src/main/docs-main.ts` 里 12 个 `ai:*` 的实现。
3. `genoffice/apps/docs/src/renderer/ai/` 下的 AI 面板组件（`AiPanel.tsx` 等）——
   看它怎么调用、期望什么形状的回包。
4. `apps/desktop/src/main/document/documentViewCredentialBroker.ts` ——
   已有的凭据中间层。
5. Mcode 的三 SDK 调用入口：`apps/desktop/src/main/claude/`、`pi-sdk/`、`codex-sdk/`
   的 provider 接口。**不要自己写一套 SDK 调用**。
6. 台账 2026-10-19 强制实施指令第 3 条与第 5 条。

---

## 执行内容

### 1. 把「AI 面板 → 三 SDK」的通路建起来（核心）

这是本卡的主要工作，不是逐个迁 handler。

- GenOffice 的 AI 面板发起请求时，**不**走它自己的 `ai:*`，而走一条新的
  窄通道：`mcode-ipc.ts` 里加一个 handler，把「选区文本 + 指令 + 文档上下文」
  转成 Mcode 的 typed action。
- 这个 action 经 `app_api_call` 的既有审批链（不是新开一条）。
- 执行由当前会话选中的 provider（Claude / Pi / Codex）完成。
- 流式结果回填到 GenOffice 的编辑器（它有自己的 selection/insert API）。

**关键约束**：同一次 AI 请求，用户点的和 Agent 调的必须走**同一个函数**。

### 2. 默认拒绝

- 所有 `ai:*` 在被调用时，**默认返回 `unavailable`**，并给出可读原因
  （「请通过 Mcode 的三引擎使用 AI」）。
- 不保留 GenOffice 自己的云 AI 直连路径（`ai-provider` 的调用点要断掉或隔离）。

### 3. 显式审批

- 首次使用时提示用户「文档内 AI 将使用你在 Mcode 里配置的引擎」。
- 危险操作（改写全文、批量替换）要有逐次确认——复用 Mcode 的审批 UI。

### 4. 测试

- 在现有 `document-view-*` 套件里补，不新建平行套件。
- 每个 handler 的归属（迁/改造/复用/不迁）有断言或文档证据。
- 「AI 请求真的走了三 SDK」有断言（不能只验证它返回了内容）。

---

## 边界（不要碰）

- **不要**接上 GenOffice 自己的 `ai-provider` 与云账户。
- **不要**新写一套 SDK 调用（复用现有 provider 接口）。
- **不要**删掉 GenOffice 的 AI 面板 UI（用户要的是能用的面板）。
- 不要碰 sheets / slides / pdf / markdown / html。
- 不要碰 `genoffice/ee/`。
- 与 T05b 的文件边界重叠：**先确认 T05b 已完成**再开。

---

## 验收判据

1. 12 个 handler **逐个**有归属与理由，写进集成地图的 T05c 表。
2. 「AI 面板 → 三 SDK」的通路有真 Electron 验证：面板里发一条指令，
   能在 Mcode 的会话里看到这次调用。
3. `ai:gsk-login` 等云账户路径**不可用**且给出可读原因。
4. 危险操作有逐次确认。
5. 现有 `document-view-*` 四套 + T05a/T05b 的回归全绿。
6. 双包 tsc + GenOffice Docs tsc 全绿。
7. **变异验证**：把「走三 SDK」改成「走 GenOffice 自己的 ai-provider」→
   断言必红；撤掉危险操作确认 → 断言必红。

---

## 回写区要回答

- 12 个 handler 各归到哪一类？不迁的那几个给出什么替代？
- 「AI 面板 → 三 SDK」这条通路，具体经过哪些函数？
- 有没有任何地方仍然直连 GenOffice 的云 AI？
- 危险操作的确认复用哪个组件？

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->
