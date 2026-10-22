# T62｜给 AI 加记忆写入工具（记忆系统只进不出的另一半）

| 项目 | 值 |
|---|---|
| 编号 | T62 |
| 类型 | **功能缺口**（优化方向 §一「记忆系统：只进不出」） |
| 优先级 | **高** —— 整套记忆机制现在等于不存在 |
| 建议并发 | 改 `main/mcp/` + `main/memory/`；**与 T61 不冲突** |
| 预计规模 | 中 |

---

## 前置条件

- **无前置**，可直接派。

---

## 缺口（`docs/planning/优化方向.md` 原文）

> **缺的那一半：模型没有写记忆的手段。** `main/mcp/` 下五个文件、共 40 个工具
> （`mcodeServer` 10 + `libraryServer` 21 + `agentTools` 9），**没有一个 memory 工具**。
> `saveMemoryFile`（`memory/store.ts:179`）的唯一调用者是 `ipc/memory.ts:73` —— 渲染端面板。
>
> **为什么是问题**：记忆系统的价值在于"我不用重复说第二遍"。现在模型能读到记忆，
> 但记什么全靠用户自己去面板里手打。用过一次就知道没人会这么干 —— 于是记忆库永远是空的，
> 注入的那段快照永远是空串，**整套机制等于不存在**。

---

## 已经有的（不要重做）

| 件 | 位置 | 状态 |
|---|---|---|
| 存储 | `main/memory/store.ts` | ✅ markdown + frontmatter，六个固定类目，路径校验四道闸 |
| 检索 | `main/memory/retrieval.ts` 的 `memorySnapshotFor()` | ✅ 三道截断闸（单条 600 字 / 12 条 / 总共 6000 字） |
| 注入点 | `lib/sessionAgentProfile.ts:105`（主对话）、`nodeInputBuilders.ts:224`（工作流节点） | ✅ |
| 界面 | `components/memory/MemoryExplorerPanel.tsx` | ✅ 能看能改能删 |

**缺的只有：让模型能写。**

---

## 开工前必读

1. `audit-ledgers/README.md`。
2. `apps/desktop/src/main/memory/store.ts` **全文** —— 尤其 `saveMemoryFile`。
3. `apps/desktop/src/main/memory/retrieval.ts` **全文** —— 尤其 `memorySnapshotFor`。
4. `apps/desktop/src/main/mcp/mcodeServer.ts` —— **工具怎么注册的**（10 个工具的范本）。
5. `apps/desktop/src/main/mcp/libraryServer.ts` —— 21 个工具，另一个范本。
6. `packages/contracts/src/memory.ts` —— `MEMORY_SECTION_TITLE` 与类目定义。
7. `apps/desktop/src/main/lib/rgSearch.ts` —— ripgrep 通路（UTF-8 + GBK 双通道）。
8. `apps/desktop/src/renderer/components/memory/MemoryExplorerPanel.tsx` ——
   界面上要能看见模型写了什么。

---

## 执行内容

### 第 1 步：三个工具

在 `mcodeServer.ts` 加：

```ts
memory_write   // { category, title, content } → 写入
memory_search  // { query, limit? }             → 检索
memory_forget  // { file }                       → 删除
```

**硬要求**：`memory_write` **必须调 `saveMemoryFile`**，不能另写一份。
这是仓库硬规矩 2 —— 「用户点的」和「AI 调的」共用一份实现。

### 第 2 步：写入纪律写进系统提示词

参照 Claude Code 的 auto-memory，只记：

- **用户是谁**（角色、专长、偏好）
- **项目背景**（目标、约束、外部系统在哪）
- **不会从代码里读出来的东西**

**不记**：

- 代码模式（读源码就知道）
- git 历史
- 这次任务的临时状态

**这段判断标准要写进系统提示词**，不能只写在工具 description 里
（优化方向原文点名了这一点）。

### 第 3 步：检索按相关度

现在 `memorySnapshotFor` 是 `updatedAt` 倒序取 12 条 —— **库一大就必然漏掉最该看的那条**。

改成：先按**相关度**（ripgrep 搜当前任务的关键词），再按时间兜底。

**注意**：不要一次改太猛。可以先加一个 `memory_search` 工具让模型自己查，
`memorySnapshotFor` 的自动注入保持原样 —— 让模型在需要时主动搜。

### 第 4 步：界面上能看见

模型写了一条记忆，对话里该有个**轻量提示**（不是弹窗），点得开、改得了。

**复用现有的**：`MemoryExplorerPanel` 已经能看能改能删，只需要一个「跳过去」的入口。

---

## 边界（不要碰）

- 不改 `memory/store.ts` 的路径校验（四道闸是对的）。
- 不改 `memorySnapshotFor` 的三道截断闸。
- 不改 `MemoryExplorerPanel` 的既有行为（只允许加入口）。
- 不改 `libraryServer.ts` / `agentTools.ts` 的既有工具。
- 不改 `packages/contracts/` 的既有形状（只允许加）。

---

## 验收判据

1. `memory_write` 写进去的文件，`MemoryExplorerPanel` 能看到（有断言）。
2. `memory_write` **走的是 `saveMemoryFile`**（有断言或代码检查）。
3. 用户说「以后引用都用 APA」→ 模型写了一条记忆 → 新对话的 `memorySnapshotFor` 里包含它（有断言）。
4. `memory_search` 能按关键词查到刚写的条目（有断言）。
5. `memory_forget` 删除后，快照里不再出现（有断言）。
6. 现有 `memory-*` 套件全绿。
7. 双包 tsc 干净。
8. **变异验证**：撤掉 `memory_write` 的 `saveMemoryFile` 调用（改写成直接写文件）→
   判据 2 红；撤掉系统提示词里的写入纪律 → 需要断言提示词包含那段话。

---

## 回写区要回答

- 三个工具实际加进去了吗？在第几个文件？
- 系统提示词的写入纪律写在哪？（哪个文件、哪一段）
- `memorySnapshotFor` 有没有改成按相关度？没改的话为什么？
- 界面上那个「跳过去」的入口长什么样？
- 模型真的会主动写记忆吗？（如果做了真 AI 的试跑，写结果）

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->

### T62 执行回写（2026-10-21）

- **三个工具**：仓库已在 `apps/desktop/src/main/mcp/memoryServer.ts` 的 `memoryMcpTools()` 中提供 `memory_write`、`memory_search`、`memory_forget`，且已接到 `mcode-memory` MCP 服务和各引擎调用/宿主审批链。实际位于**独立记忆 MCP 文件**，不是 `mcodeServer.ts`；为避免相同工具重复注册和实现分叉，本任务没有另造第二套。写入直接调用 `saveMemoryFile`，删除调用 `deleteMemoryFile`，检索调用 `searchMemory`；`notifyMemoryChanged` 驱动已有记忆面板刷新。
- **写入纪律**：`apps/desktop/src/main/memory/policy.ts` 中 `MEMORY_LAYER_INSTRUCTIONS` 新增明确的「记用户稳定角色/专长/偏好、项目长期背景、从代码文件读不出来的事实；不记代码模式、git 历史、任务临时状态」。`apps/desktop/src/main/claude/RuntimeManager.ts` 的提示词装配引用这一常量（系统级约束，不只是工具描述）。
- **相关度策略**：本次**保留** `memorySnapshotFor` 的按时间兜底与原有单条/条数/整段截断闸；模型可以通过现成 `memory_search` 主动调用 `searchMemory` 的相关度评分检索，属于任务允许的渐进方案。未擅自改自动注入算法。
- **轻量入口**：`apps/desktop/src/renderer/components/chat/MessageBlocks.tsx` 中，成功的 `memory_write` 工具卡下方展示小型「记忆与上下文 ↗」入口；点击 `setSettingsOpen(true, "memory")` 进入原有 `MemoryExplorerPanel`，可查看、编辑、删除模型写入的记忆。未改面板既有逻辑。
- **真 AI 试跑**：没有真实引擎在线回合，不能声称模型已经主动调用；做了真实 MCP handler + 面板 IPC + 快照的隔离动态验证（E1）。

**验收与证据：**
1. **通过 E1**：`memory_write` 后真实 `memory:list` IPC 可见（与 `MemoryExplorerPanel` 同一数据源），有断言。
2. **通过 E2 + 变异验证**：代码检查要求 `memory_write` 显式调用 `saveMemoryFile`；改成直接写文件后该 T62 断言确实红。
3. **通过 E1**：「以后引用都用 APA」写入后 `memorySnapshotFor(["preferences"])` 包含原文。
4. **通过 E1**：`memory_search` 关键词命中新写 APA 条目。
5. **通过 E1**：`memory_forget` 后新快照和面板 IPC 列表都不再出现。
6. **通过 E1**：`node apps/desktop/scripts/run-smokes.mjs memory-assistant-row-identity-smoke memory-codex-smoke memory-handoff-atomic-smoke memory-injection-smoke memory-injection-ui-smoke memory-list-integrity-smoke memory-review-smoke memory-smoke`：8/8 通过。
7. **通过**：最终复跑 `node_modules\.bin\tsc.cmd --noEmit -p packages/contracts/tsconfig.json` 与 `node_modules\.bin\tsc.cmd --noEmit -p apps/desktop/tsconfig.json` 均 exit=0，双包 tsc 干净。此前桌面包曾因别的并行任务文件（`app-control-smoke`、`session-store-smoke`、`HooksPanel`）报错；这些文件后来由并行执行者修改，最终复验已通过，本任务未修改那些文件。
8. **通过 E1**：将记忆写入调用临时替换为直接写文件，`memory-smoke` 红（294/305）；恢复后将两条写入纪律临时移出 `MEMORY_LAYER_INSTRUCTIONS`，`memory-smoke` 红（303/305），其中两项 T62 提示词断言红；恢复原文后记忆套件 8/8 通过。变异仅在隔离数据根下测试，最终已还原。
