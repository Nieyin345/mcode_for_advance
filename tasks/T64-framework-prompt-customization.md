# T64｜框架层提示词可自定义（中间那一层）

| 项目 | 值 |
|---|---|
| 编号 | T64 |
| 类型 | **功能缺口**（优化方向 §③「提示词只有两头能改」） |
| 优先级 | 中高 |
| 建议并发 | 改 `orchestration/schedulerPrompt.ts` + 设置页；**与 T62/T63 不冲突** |
| 预计规模 | 中 |

---

## 前置条件

- **无前置**，可直接派。

---

## 缺口（`优化方向.md` 原文）

| 层 | 内容 | 用户能改吗 |
|---|---|---|
| 身份 | `CLAUDE_IDENTITY_PROMPT` / `PI_*` / `CODEX_*` | **不能**，硬编码 |
| **框架** | 「整条流程」「产出的样子」「记忆快照」（`schedulerPrompt.ts` 615 行） | **不能**，硬编码 |
| 全局指令 | `<数据根>/context/instructions.md` → 物化到各引擎的 CLAUDE.md / AGENTS.md | 能 |
| 输出风格 | `outputStyle` | 能 |
| 节点指令 | 每个节点的 `instruction` 参数 | 能 |
| 代理档案 | 一组节点参数存成一份可分享的文件 | 能 |

> **缺的是中间那一层。** 用户说"各种提示词也可以自定义"，而框架那一层现在改不了。
> 这一层的措辞直接决定代理的行为 —— **做文献评审和做代码审查需要的框架话术并不一样**。

---

## 开工前必读

1. `audit-ledgers/README.md`。
2. `apps/desktop/src/main/orchestration/schedulerPrompt.ts` **全文 615 行** ——
   这是本卡的核心。
3. `apps/desktop/src/main/lib/sessionAgentProfile.ts` —— 身份层怎么注入。
4. `apps/desktop/src/main/orchestration/composeNodePrompt` —— 节点层怎么拼。
5. `apps/desktop/src/renderer/components/settings/OutputStylePanel.tsx` ——
   **可改的提示词现在长什么样**，照它的模式。
6. `open-claude-ui/` —— 如果 Claude 桌面端有类似的「自定义指令」界面，照它。

---

## 执行内容

### 第 1 步：把框架层拆成可编辑的段落

`schedulerPrompt.ts` 现在是一整段硬编码字符串。要拆成**有名字的段落**：

```ts
export const FRAMEWORK_SECTIONS = [
  { id: "flow",        title: "整条流程",   default: "..." },
  { id: "output",      title: "产出的样子", default: "..." },
  { id: "memory",      title: "记忆快照",   default: "..." },  // 这段可能不该改
  // ...
] as const;
```

**每段的默认值就是现在硬编码的那段话。** 用户改了才覆盖。

### 第 2 步：存储

存哪？

- `<数据根>/context/framework/<id>.md`（与 `instructions.md` 同一层）
- 或者 `SettingRepo` 的 SQL

**建议文件**：与 `instructions.md` 一致，而且用户能直接用编辑器打开改。

**空文件 = 用默认值**，不要「删了就没有」。

### 第 3 步：设置页

在「输出风格」旁边加一个「框架提示词」页面：

```
框架提示词
─────────────────────────────
整条流程          [编辑] [恢复默认]
  当前：自定义（已修改）

产出的样子        [编辑] [恢复默认]
  当前：默认

记忆快照          （不可编辑）
  这一段由系统注入，改了会破坏功能
```

**判据是「用户能改，而且知道哪段是能改的」。**

### 第 4 步：哪些段落不该暴露

`memory` 那一段是**系统注入**的（`memorySnapshotFor` 的输出），
用户改了会破坏功能。

**要在 UI 上明确灰显 + 说明原因**，不要让它看起来能改。

同样，`schedulerPrompt.ts` 里如果有「工具调用协议」「权限声明」这类
**改了就会坏** 的段落，也要灰显。

### 第 5 步：生效时机

改了框架提示词，**下一轮对话生效**（与 `outputStyle` 同一条规则）。

不要热更新正在跑的对话 —— 那会让同一轮里前后半截的框架不一样。

---

## 边界（不要碰）

- **不改身份层**（`CLAUDE_IDENTITY_PROMPT` 等）—— 那不属于本卡。
- **不改 `memorySnapshotFor`** —— 记忆快照的内容是系统生成的。
- 不改节点指令层。
- 不改代理档案。
- **不改 `schedulerPrompt.ts` 里「不可改」那些段落的实际内容** —— 只是把它们标出来。

---

## 验收判据

1. 用户改了「整条流程」这段 → 下一轮对话里生效（有断言）。
2. 恢复默认 → 回到硬编码原文（有断言）。
3. 空文件 → 用默认值，不是空串（有断言）。
4. `memory` 段在 UI 上灰显，且说明原因（有断言）。
5. 改动**不影响**正在跑的对话（有断言）。
6. 现有 `scheduler-*` / `orchestration-*` 全绿。
7. 双包 tsc 干净。
8. **变异验证**：撤掉「空文件用默认值」→ 判据 3 红。

---

## 回写区要回答

- `schedulerPrompt.ts` 拆成了几段？每段是什么？
- 哪些段落灰显了？为什么？
- 存文件还是存 SQL？为什么？
- 用户改完之后，怎么知道生效了？（UI 上有没有提示）
- 有没有测「两个对话用不同的框架提示词」？

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->
