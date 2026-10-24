# T139｜聊天消息全面对齐 Claude（头部 / 正文 / 工具栏 / 气泡细节）

- Status: ready-for-agent
- Category: **P0 产品主线（UI）—— 用户：「全面参照 claude 来改呀」**
- Priority: **P0**
- Depends on: T134（宽度已对齐 `dda3458f`）、T121（字号档已配）

## 零、这张卡和之前那些 UI 卡的区别

**之前改的是「宽度、颜色、间距」这些数值。这张改的是「消息长什么样」。**

**依据全部来自 `open-claude-ui/code-examples/ChatMessageBubbles.tsx`** —— 上游的真身，不是故事书。

## 一、完整对照表

### 助手消息

| 元素 | Claude | 我们 | 差 |
|---|---|---|---|
| **头部** | `✦` 图标（20px，clay 底）+ `Claude`（semibold）+ 模型角标（mono 10px）+ `•` + 时间（mono 11px） | **没有** | ❌ **整块缺失** |
| 正文字号 | **15px**（`text-[15px]`） | 14px | 小 1px |
| 正文缩进 | `paddingLeft: 4px`（`--cds-assistant-message-text-inset`） | 无 | ❌ |
| 正文行高 | `leading-relaxed`（1.625） | `--chat-md-leading` 1.45 | **更松** |
| **底部工具栏** | `Copy` / 👍 / 👎（`text-xs`，`pt-1`） | **没有** | ❌ **整块缺失** |
| 消息间距 | `space-y-3.5`（14px） | 12px（`--chat-row-gap-assistant`） | 小 2px |

### 用户消息

| 元素 | Claude | 我们 | 差 |
|---|---|---|---|
| 内边距 | `px-4 py-3` = **16 / 12** | `px-3 py-2` = **12 / 8** | 小 |
| 圆角 | `--cds-message-bubble-radius` = **12px** | 12px | ✅ 一致 |
| 正文 | `text-[14.5px]` | 14px | 小 0.5px |
| **阴影** | `0 1px 2px 0 rgba(0,0,0,0.04)` | **无** | ❌ |
| 背景 | `#f0f4f8` / 暗 `rgba(255,255,255,.06)` | ✅ 已对齐 | ✅ |
| 宽度 | `max-w-[85%]` | `max-w-[85%]` | ✅ 一致 |

## 二、任务（按影响排序）

### 第一步：助手消息的头部（**最明显的缺失**）

在 `MessageRow.tsx` 的助手分支加：

```tsx
{!isUser && (
  <div className="flex items-center gap-2 text-xs text-neutral-400 font-medium select-none">
    <span className="size-5 rounded-md bg-clay text-white flex items-center justify-center text-[10px] font-serif font-bold">✦</span>
    <span className="font-semibold text-neutral-900 dark:text-neutral-100">Claude</span>
    {model && (
      <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-neutral-200/60 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300">
        {model}
      </span>
    )}
    <span>•</span>
    <span className="font-mono text-[11px]">{time}</span>
  </div>
)}
```

**⚠️ 三个要注意的**：

1. **`Claude` 这个名字是产品名，不是模型名。** 我们是 Mcode —— **这一行该显示 "Mcode" 还是 "Claude"？**
   **我判断：Mcode。** 因为用户要「像 Claude 的样子」，不是「自称 Claude」。**但这是产品决策，执行前确认。**

2. **模型角标** —— 我们已经有了 `TurnStatRow`（回合统计行），它显示模型 + 用时 + 步数。**新头部会和它重复。**
   **必须先看 `TurnStatRow` 现在显示什么，再决定是「合并」还是「替换」。**

3. **时间** —— `msg.createdAt` 有吗？

### 第二步：底部工具栏

```tsx
<div role="toolbar" aria-label="Assistant message actions"
     className="flex items-center gap-3 pt-1 text-neutral-400 select-none text-xs">
  <button onClick={handleCopy} className="hover:text-neutral-800 ...">Copy</button>
  <button className="hover:text-neutral-800 ...">👍</button>
  <button className="hover:text-neutral-800 ...">👎</button>
</div>
```

**⚠️ 👍👎 我们可能没有反馈机制。** 如果没有，**只做 Copy**，👍👎 留空位或不做。

**⚠️ Copy 我们可能已经有了** —— 先查 `MessageRow.tsx:239` 的 `showCopy`。

### 第三步：用户气泡的细节

- `px-3 py-2` → **`px-4 py-3`**
- 加 `boxShadow: "0 1px 2px 0 rgba(0,0,0,0.04)"`
- 字号 `14px` → **`14.5px`**

**⚠️ 最后一条要小心**：`--chat-font-size` 是用户可配的（默认 14px）。**改成 14.5px 会让「用户可以调字号」这件事和「Claude 是 14.5」冲突。**

**我判断：保留 `--chat-font-size`，不改 14.5。** 因为让用户能调字号比精确 0.5px 重要。**但要在注释里写清这个偏离。**

### 第四步：助手正文 15px + 4px 缩进

```tsx
style={{ paddingLeft: "4px" }}
```

**⚠️ 15px 和我们的 `text-body`（14px）冲突。**

**我判断：用 `text-prose`（15/22）** —— 那是七档里已有的，就是给「长文段落」用的。**助手回答正是长文。**

**这条比用户气泡的 14.5px 重要得多** —— 15 vs 14 是能看出来的。

## 三、⚠️ 动手前必须先核的三件事

**一、`TurnStatRow` 显示什么？**

```bash
grep -n -A 20 "function TurnStatRow" apps/desktop/src/renderer/components/chat/MessageRow.tsx
```

**它已经有模型、时间、步数。新增头部会和它重复。** 必须决定：合并、替换、还是并存。

**二、Copy 按钮现在在哪？**

```bash
grep -n "showCopy" apps/desktop/src/renderer/components/chat/MessageRow.tsx
```

**三、`msg.createdAt` 有没有？**

```bash
grep -n "createdAt" apps/desktop/src/renderer/components/chat/MessageRow.tsx | head -5
```

## 四、验收

1. **助手消息有头部**（图标 + 名字 + 模型角标 + 时间），且**不和 `TurnStatRow` 重复**。
2. **助手正文 15px + 4px 左缩进**。
3. **用户气泡 `px-4 py-3` + 阴影**。
4. **Copy 按钮可达**（无论原来在哪）。
5. **不回归**：`chat-*` / `message-*` 套件全绿。
6. **视觉基线对比**：`messages-light-1280.png` 改前/改后。

## 五、变异

| 变异 | 正控（该红） | 负控（该绿） |
|---|---|---|
| 助手头部去掉 | 1 | — |
| 用户气泡 padding 改回 `px-3 py-2` | 1 | — |
| 助手正文改回 14px | 1 | — |

## 六、边界

**可以改**：
- `components/chat/MessageRow.tsx`
- 相关 i18n（新增 "Copy" 等文案）
- 套件

**不许碰**：
- `components/settings/workflows/`（工作流总控）
- `components/ide/`（另一个子代理在做任务中心）
- `styles.css` 的 token 定义

## 七、回写

1. **`TurnStatRow` 和新增头部怎么处理的**（合并/替换/并存，为什么）
2. 上面三个「必须先核」的答案
3. 哪几项做了、哪几项没做（尤其 👍👎 和 14.5px）
4. 视觉基线对比
5. 套件数字、变异、提交 SHA
