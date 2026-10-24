# T122｜AI 聊天区的排版节律与滚动手感（对齐 Claude 桌面端）

- Status: ready-for-agent
- Category: **P0 产品主线（UI）—— 用户原话「最主要的就是 ai 聊天部分的 ui 重构，这部分要和 claude 一模一样最好」**
- Priority: **P0**
- Depends on: T119（`rightSurface` 已并入 `1330e13f`）、T120（缺口 ①② 已并入）
- Exclusive writable files:
  - `apps/desktop/src/renderer/components/chat/ChatPane.tsx`
  - `apps/desktop/src/renderer/components/chat/MessageRow.tsx`
  - `apps/desktop/src/renderer/styles.css`（**只改聊天节律那一段，见边界**）
  - `apps/desktop/scripts/t122-chat-rhythm-smoke/`（新建）

## Required Skills
- `frontend-design`：目测密度与留白。
- `mcode-smoke`：无头挂载验证 + 变异验证。

---

## 零、开工前必须核的三件事（卡上的事实有保质期）

```bash
# 1. 这两个文件有没有别人的在途改动
git status --porcelain apps/desktop/src/renderer/components/chat/ChatPane.tsx \
                      apps/desktop/src/renderer/components/chat/MessageRow.tsx \
                      apps/desktop/src/renderer/styles.css
# 2. 最近有人动过吗（1–2 分钟内改过的先等一下）
git log --oneline -3 -- apps/desktop/src/renderer/components/chat/ChatPane.tsx
# 3. 当前值还在不在
grep -n "chat-row-gap-assistant\|chat-row-gap-user\|chat-leading" apps/desktop/src/renderer/styles.css
```

**写这张卡时（2026-10-24 15:05）**：三个文件里只有 `styles.css` 被 F 在 14:58 改过（已提交 `b736c814`），工作区干净。

---

## 一、这一卡要解决什么：三处**可量化**的差距

**不是「感觉不一样」，是上游文档给了公式，我们算出来对不上。**

### 差距 A：轮次 / 块间距比上游大 33% 与 20%

**上游**（`open-claude-ui/docs/v1/03-会话核心流与指令交互引擎.md:110-112`，`cds-theme.css:179-181`）：

```
--chat-leading: 1.42857
--chat-turn-gap = chat-body × chat-leading × 0.75
--chat-item-gap = chat-body × chat-leading × 0.50
```

在 `chat-body: 14px` 下：**轮次间距 = 15px，块间距 = 10px。**

**Mcode 现在**（`styles.css:1832-1860`，标准密度档）：

| 变量 | 现在 | 上游 | 差 |
|---|---|---|---|
| `--chat-row-gap-assistant` | **12px** | 10px（`chat-item-gap`） | **+20%** |
| `--chat-row-gap-user` | **20px** | 15px（`chat-turn-gap`） | **+33%** |

**而且 `styles.css:1832` 的注释自己写着「阅读行高对齐上游 CDS」** —— 行高确实对齐了（`1.42857`），但**间距没跟着**。这是又一个「抄了一半」的样本。

**⚠️ 但先别直接改数字**：`--chat-row-gap-*` 是**按密度档分组的**（`:1839` 标准 / `:1849` 紧凑 / `:1859` 宽松三套）。三档都要按同一比例下调，否则切密度档时会跳变。**先读 `:1820-1870` 整段，搞清三档之间的关系再动手。**

### 差距 B：AI 回复没有 `text-inset`（上游最显眼的一条）

**上游**（`docs/v1/03-会话核心流与指令交互引擎.md:90`，`ChatMessageBubbles.tsx:9`）：

```css
--cds-assistant-message-text-inset: 4px;
--cds-assistant-message-text-stop: clamp(0px, (100% - 384px) * .175, 56px);
```

**它的作用**：助手文字**不是**从容器左边缘开始，而是有 4px 内缩，并且**随窗口宽度收缩** —— 窄窗口下几乎不缩（0px），宽窗口下最多缩到 56px。

**这是 Claude 桌面端「正文看起来居中、两侧留白随窗口变化」的来源。**

**Mcode 现在**：`grep -rn "assistant-message-text-inset\|text-stop" apps/desktop/src/renderer/` → **零命中**。

**怎么接**：给助手消息（`MessageRow.tsx` 的非 user 分支，约 `:352`）加一个 CSS 变量驱动的左右内边距。**不要写死 px，用上游那条 `clamp()`** —— 写死会在窄窗口下把正文挤窄。

**⚠️ 但 Mcode 的宽度约束和上游不同**（上游有 384px 的 composer 参照，我们是流式右栏）。**先量一下当前对话区在 1200/1600/2000px 窗口下的实际宽度**，再决定 `384px` 这个参照要不要换成我们的。**这一条需要在卡的回写里给出测量值，不能只是照抄。**

### 差距 C：滚动手感（`useClaudeScrollPinning` 零引用）

**上游**（`open-claude-ui/code-examples/useClaudeScrollPinning.ts`）：

1. **150ms 用户输入冷却窗口** —— 用户刚滚动过，别抢他的位置；
2. **40px 底部容差** —— 离底 40px 内算「在底部」；
3. **35vh 底部缓冲区**（`--chat-extra-space`）；
4. **`behavior: "auto"`** —— 防抖时瞬时对齐，不用 smooth，避免「被拽着走」的感觉；
5. **离开底部超过 120px 才显示「跳至最新」**。

**Mcode 现在**：`grep -rn "useClaudeScrollPinning" apps/desktop/src/renderer/` → **零引用**。

但**不是没有**：`ChatPane.tsx:744-845` 有一套相当复杂的 `recomputeNearBottom` + `maintainScrollAtEnd` + `anchorSuspension`。**这一条不是「补一个缺失功能」，是「核对两套的语义」** —— Mcode 的 80px 阈值 vs 上游 40px，Mcode 的「跳至最新」阈值 vs 上游 120px。

**⚠️ 这一条风险最高**：`ChatPane.tsx` 的滚动逻辑有大量注释记录过真实 bug（「往上挤」「闪一下」「拽回去」）。**不要重写。先做一张对照表：上游这几条语义，Mcode 对应的行为是什么、值是多少、有没有。** 有差异的地方再单独讨论。

**如果核对下来 Mcode 的语义已经等价（只是名字不同），那就什么都不改，把对照表写进回写区** —— 这也是合格交付。**「没抄上游的代码」不等于「行为不对」。**

---

## 二、优先级与顺序

**按「用户感知 ÷ 风险」排：**

| 顺序 | 项 | 感知 | 风险 | 建议 |
|---|---|---|---|---|
| **1** | 差距 B：`text-inset` | **高**（每次看回复都在看） | 低（加内边距） | **先做** |
| **2** | 差距 A：轮次/块间距 | 中高（密度感，12→15px 差异可辨） | 低（改 CSS 变量） | 接着做 |
| **3** | 差距 C：滚动语义对照 | 中（流式时的手感） | **高** | **只做对照表，不改代码** |

---

## 三、验收判据

1. **A / B 两项要有可变的值，不是「看起来差不多」**
   - 间距：三档（标准/紧凑/宽松）的 `--chat-row-gap-*` 与上游公式的对应关系写清；
   - 内缩：给出 1200/1600/2000px 三档下的实测内缩 px 值。

2. **断言打在**算出来的值**上，不打在源码文本上。**
   - ✅ 套件里读 `styles.css` 的变量 + 执行 `clamp()` 数学，断言 `1200px 宽 → 内缩 X px`；
   - ❌ `src.includes("--chat-row-gap-assistant: 10px")`（注释掉也能通过，见 T119 那 94 处）。

3. **必须有对照组**（这个仓库为此栽过多次）：
   - 间距：把**上游换算值**和**我们的值**同时算出来打印，差为 0 才算过。没有对照组时，「都等于 10」可能是两边都算错了。

4. **每条断言都要做变异**，并**先写预期红几条**：
   - 撤掉 `text-inset` → 应该有 N 条红（预期 N=内缩相关的全部）；
   - 把间距改回 12/20 → 应该有 N 条红。
   - **变异用注释掉（不是删除）** —— 注释掉是移除代码的主要形态，也是上一轮 94 条断言失效的原因。

5. **不回归**：`arc005-*` 五套、`message-collapse-smoke`、`image-panzoom-smoke`、`chat-*` 全部。
6. **不跑全量、不起 Electron。**（用户明确说过不要桌面测试）

---

## 四、边界

**可以改**：
- `ChatPane.tsx` / `MessageRow.tsx`
- `styles.css` 的 **聊天节律段**（`:1800-1870` 附近）+ 需要新增的 `.chat-assistant-inset` 类
- 新建 `apps/desktop/scripts/t122-chat-rhythm-smoke/`

**不许碰**：
- `styles.css` 的**边框段**（`:120-160`）—— F 刚在 `b736c814` 改过，还在验；
- `styles.css` 的 **`--user-bubble`** —— **那是下一张卡（T123），不是这张**；
- `ThreePaneLayout.tsx` / `ClassicShell.tsx` —— T119 的边界；
- `RightPanel.tsx` 内部 —— T120 的边界；
- **滚动逻辑重写** —— 差距 C 只出对照表。

---

## 五、⚠️ 一条必须纠正的卡面事实（T121 里写错了，别照抄）

**T121 §1.2 写「气泡圆角 12px，规范是 18px」。这个判断是错的。**

实测上游代码（`open-claude-ui/code-examples/cds-theme.css:164`）：

```css
--cds-message-bubble-radius: calc(var(--cds-radius, 8px) + calc(.25rem * var(--cds-rem-scale, 1)));
```

`8px + 4px = 12px` 是**默认值**，要 `--cds-rem-scale: 2.5` 才是 18px。
而我们的 `tokens.cds.css:83` 是**逐字相同的公式**：

```css
--m-message-bubble-radius: calc(8px + calc(.25rem * 1));
```

**所以气泡圆角没有差距，不要改它。** T121 那个数字来自故事书的展示表（那可能是某一档 rem-scale 下的值），不是代码默认值。**「文档写的」和「代码算的」不一致时，以代码为准** —— 这条也值得写进下一个人的检查清单。

---

## 六、回写

`tasks/T122-chat-rhythm-and-scroll.md` 末尾追加 `## 结果回写（2026-10-24）`：

1. 差距 A 三档的具体值 + 与上游公式的对照表；
2. 差距 B 的三档窗口实测内缩 + 为什么选那个参照宽度；
3. 差距 C 的语义对照表（**即使决定不改也要写**）；
4. 套件数字、变异结果（红的条数 vs 预期）、提交 SHA；
5. **有没有你觉得不对但没改的地方。**
