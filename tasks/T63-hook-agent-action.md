# T63｜hook 加第二种动作：交给某个代理

| 项目 | 值 |
|---|---|
| 编号 | T63 |
| 类型 | **功能缺口**（优化方向 §③「hook 只能跑 shell 命令」） |
| 优先级 | 高 —— 原文说「是顺序表上最大的剩余项」 |
| 建议并发 | 改 `packages/contracts/src/hook.ts` + `main/hooks/`；**与 T62 不冲突** |
| 预计规模 | 中 |

---

## 前置条件

- **无前置**，可直接派。

---

## 缺口（`优化方向.md` 原文）

> **缺的是动作那一侧。** `HookSpecSchema` 里能配的只有 `command`（一条 shell 命令）。
>
> **怎么办**：给 hook 加第二种动作。`command` 那一支不动（它是通用逃生口），
> 加一种「交给某个代理」：指定一个**代理档案**或一个工作流 id，事件载荷当输入。
> ⚠️ **要防雪崩：hook 触发代理、代理干活又触发 hook，能无限套。先定一条深度上限。**

---

## 已经有的（不要重做）

> 事件这一侧**做得挺全**：18 个事件，按一轮的生命周期排，而且刻意标注了哪些事件
> **不该挂钩子**、为什么。这份"哪些不给"的清单比"给了哪些"更说明设计是想过的。
>
> 匹配也够用：`matcher` 只比两种主语（工具名 / 文件路径），收 glob **不收正则** ——
> 理由写在契约里：正则写错是静默不匹配，而一个不响的钩子比一个写错的钩子难查得多。

**这些全部保留，一个不改。**

---

## 开工前必读

1. `audit-ledgers/README.md`。
2. `packages/contracts/src/hook.ts` **全文** —— `HookSpecSchema` 现在长什么样。
3. `apps/desktop/src/main/hooks/HookRunner.ts` **全文** —— 现在怎么执行 shell 命令。
4. `apps/desktop/src/main/hooks/hostHookGrants.ts` —— **授权链**，代理动作也要走它。
5. `apps/desktop/src/main/orchestration/agentProfiles.ts` —— 代理档案的形状。
6. `apps/desktop/src/main/mcp/mcodeServer.ts` 的 `app_workflow_publish` ——
   工作流 id 的形状。
7. `apps/desktop/src/main/orchestration/runner.ts` 的 `startWorkflowRun` ——
   怎么触发一个工作流。

---

## 执行内容

### 第 1 步：扩展 `HookSpecSchema`

现在只有一支：

```ts
{ event, matcher?, command: string }
```

改成 discriminated union：

```ts
{ event, matcher?, action: { kind: "command"; command: string } }
{ event, matcher?, action: { kind: "agent"; profileId: string; ... } }
{ event, matcher?, action: { kind: "workflow"; workflowId: string; ... } }
```

**向后兼容**：旧的 `command: string` 形状要自动升级成 `{ kind: "command", command }`。
不要强制用户重写已有钩子。

### 第 2 步：防雪崩（**这是本卡最重要的设计**）

**必须定一条深度上限。**

```
hook 触发代理 → 代理用工具 → 工具触发 hook → 又触发代理 → …
```

实现方式：

- 每次 hook 触发时，在上下文里带一个**深度计数**
- 超过上限（建议 **3**）就拒绝并记录
- 计数要跨 Agent 会话传递 —— 不能只在单次调用里有效

**怎么跨会话传递**：`runStore` 或会话 metadata 里带一个 `hookDepth` 字段。
**不要**用全局变量（多会话会串）。

### 第 3 步：授权链

`hostHookGrants.ts` 现有的授权链是针对 `command` 的。

**代理动作要单独授权** —— 一个用户批准了「跑这个 shell 命令」，不等于批准了
「启动一个 agent」。

**做法**：授权记录里加 `actionKind` 字段，`command` 与 `agent` / `workflow` 分开记。

### 第 4 步：事件载荷怎么给代理

`command` 那一支是把载荷塞进环境变量或 stdin。代理那一支：

- 载荷作为**工作流的输入**（`startWorkflowRun` 的 `input`）
- 或者作为**给代理的一条消息**

**看哪个更自然** —— 建议走工作流，因为工作流本来就有输入参数。

### 第 5 步：UI

设置页的 hook 编辑界面要能选动作类型。

**复用**：现有的 hook 列表/编辑面板，加一个 select。

---

## 边界（不要碰）

- **不改 18 个事件的定义与「哪些不该挂钩子」的清单**。
- 不改 `matcher` 的 glob 语义（不收正则这条是对的）。
- 不改 `command` 那一支的行为。
- 不改 `hostHookGrants.ts` 的既有授权语义（只允许加 `actionKind` 维度）。
- 不改工作流的执行逻辑。

---

## 验收判据

1. 一个 `command` 类型的 hook，行为与现在完全一致（有回归断言）。
2. 一个 `agent` 类型的 hook，事件触发后能启动一个代理（有断言）。
3. **深度上限生效**：hook → agent → 工具 → hook → … 到第 4 层被拒绝（有断言）。
4. 深度计数**跨会话传递**，不是全局变量（有断言，两个并发会话各自计数）。
5. 授权：批准 `command` 不等于批准 `agent`（有断言）。
6. 旧格式的 `command: string` 自动升级，不需要用户重写（有断言）。
7. 现有 `hook-*` 套件全绿。
8. 双包 tsc 干净。
9. **变异验证**：撤掉深度上限 → 判据 3 红；撤掉授权分离 → 判据 5 红。

---

## 回写区要回答

- `HookSpecSchema` 最后是什么形状？向后兼容怎么做的？
- 深度上限定在几？为什么？
- 计数怎么跨会话传递的？存在哪？
- `agent` 动作触发时，载荷是怎么给代理的？
- 有没有真的跑一次 hook → agent 的完整链路？

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->
