# T149 — 视觉基线量不到**正文**：全 51 格共享的盲区

**Status**：`ready-for-agent`
**Category**：P0 测试基础设施（UI 主线的判据基础）
**发现者**：T147 的执行会话（它改行高时发现「PNG 变了、JSON 一个字段没变」）
**写卡时间**：2026-10-24 21:35。**下面前提都是这一刻实测的。**

## 一、症状

**T147 把对话正文行高从 21.75px 改到 24.375px（+2.625px，12%）。**

- **PNG 变了**：`messages-light-1280.png` 的 sha `495ac0ed…` → `96b099bf…`
- **JSON 一个字段没变**

**为什么会这样：** 探针量的是外层容器，不是正文。

## 二、根因（我核实过）

`apps/desktop/scripts/arc005-visual-baseline/probe-assertions.ts:53`：

```ts
["message", "[data-testid='workspace-main'] .prose, [data-testid='workspace-main'] [data-message-id]"],
```

**`.prose` 是外层容器**，它的 `font-size` / `line-height` 是容器自己的值（16px / 24px）。
**正文是里面那个 `.chat-md`**（`Markdown.tsx:912`）：

```tsx
className="chat-md break-words text-content
  [font-size:var(--chat-font-size)]
  [line-height:var(--chat-md-leading)]
  [font-weight:var(--chat-font-weight)]
  ..."
```

**所以整条链上，任何「正文排版」的改动在基线里都没有机器可查的证据。**

## 三、影响面（这是最要紧的一段）

**全 51 格共享这个缺口。** 而我这整条 UI 线改的恰恰是正文排版：

| 已完成的改动 | 在基线 JSON 里可见吗 |
|---|---|
| T134 正文宽度 1024 → 672 | ❌（宽度也不在这个选择器里） |
| T139 助手正文 15px + 4px 缩进 | ❌ |
| T142 `text-sm` → `text-body` | ❌（但那本来零变化） |
| **T147 正文行高 1.45 → 1.625** | ❌ **（JSON 没变，只有 PNG 变）** |
| T146 若重定标 `prose`/`heading` 行高 | ❌ |

**所以「正文看起来对不对」这件事，到今天为止全部只有肉眼证据。**

**而 T139 的回写自己就写了这句话：**

> 做不到的（必须说清）：视觉夹具的消息不带 `turnMeta`…… **因此截图只证明了「身份头存在且不依赖 turnMeta」，不证明「模型角标与时钟同屏」。后者目前只有源码断言守着。**

**同一个缺口，从 T139 到 T147，一直存在。**

## 四、任务

### 第一步：先确认 `.chat-md` 在每个消息场景里真的存在

```bash
grep -rn "chat-md" apps/desktop/src/renderer/components/chat/Markdown.tsx
grep -n "messages" apps/desktop/scripts/arc005-visual-baseline/probe.ts
```

**如果某些场景没有 `.chat-md`**（比如空态），那条选择器会返回 null —— **要确认探针能处理 null，不是静默跳过。**

### 第二步：加一项选择器

```ts
export const ARC005_MEASURE_SELECTORS: ReadonlyArray<readonly [string, string]> = [
  // ... 现有项
  ["chat-body", "[data-testid='workspace-main'] .chat-md"],   // ← 新增
];
```

**⚠️ 这是基线契约变更** —— T147 的原话：

> 我没擅自加 —— 那会改变 51 格 `measured` 的结构，是基线契约变更。

**所以要考虑：**

| 选项 | 影响 |
|---|---|
| **A. 新增一项 `chat-body`** | `measured` 多一个 key，51 格都多；`compare.mjs` 要能处理「这一项在某些格子里不存在」 |
| **B. 把 `message` 的选择器改成 `.chat-md`** | 原有 `message` 项的含义变了（从容器变正文），历史对比失效 |
| **C. 新增 `chat-body`，并在没有正文的场景里显式记 null** | 同 A，但明确处理缺失 |

**我倾向 C。** 理由：
- A 如果静默跳过缺失场景，会出现「有一半格子没量」而没人知道；
- B 会改变已有项的含义，让历史数据不可比。

### 第三步：`compare.mjs` 要能报这种差异

**现在的 `compare.mjs` 比的是什么？** 先读：

```bash
grep -n "measured" apps/desktop/scripts/arc005-visual-baseline/compare.mjs | head -20
```

**关键问题：如果 `chat-body` 的 `line-height` 从 21.75 变到 24.375，`compare.mjs` 会报什么？**

- 如果报「未登记差异」→ **正确**，那就该登记它（或让它成为「一致」）
- 如果静默通过 → **这个新选择器没用**

**⚠️ 这一条是整张卡的关键。加选择器而不验证 compare 能报差异，等于加了第二个假门禁。**

### 第四步：用 T147 做天然变异

**T147 已经把行高改成 1.625 了。** 所以：

```bash
# 1. 先跑一次，记下 chat-body 的 lineHeight
bash apps/desktop/scripts/arc005-visual-baseline/run.sh

# 2. 把 --chat-md-leading 改回 1.45
# 3. 再跑一次
# 4. 断言：compare 必须报出差异
```

**这是最理想的验证材料** —— 有一个真实的、已知量的改动（21.75 → 24.375）。

## 五、验收

1. **`chat-body` 出现在 `measured` 里**，值是正文的真实 `fontSize` / `lineHeight`（不是容器的）。
2. **`lineHeight` = 24.375px**（T147 后的实际值）。
3. **变异验证**：把 `--chat-md-leading` 改回 1.45，`compare.mjs` 必须报出差异。
4. **缺正文的场景显式记 null**，不是静默跳过。
5. **不回归**：51 格全部仍有图、`unregistered: 0`（或新登记的差异有理由）。

## 六、边界

**可以改**：
- `arc005-visual-baseline/probe-assertions.ts`（加选择器）
- `arc005-visual-baseline/compare.mjs`（如果需要处理新项）
- `docs/design/claude-code-reference-matrix.md`（登记新项）

**不许碰**：
- `styles.css`（T147 刚改完）
- 任何 `components/`
- 51 格里已有的选择器（不要改它们的含义）

**⚠️ 并行提示**：`t145-runsh-path-smoke` 的子代理可能还在提交 `run.sh`。
不要碰 `apps/desktop/scripts/*/run.sh`。

## 七、回写

1. `.chat-md` 在每个消息场景里都存在吗（哪些没有）
2. 选了 A / B / C 哪个，为什么
3. **`compare.mjs` 能不能报出这种差异**（这是验收的核心）
4. 变异结果：改回 1.45 后 compare 报了什么
5. 51 格的新 `measured` 结构长什么样
6. 提交 SHA
7. **你觉得不对但没改的**

---

## 附：为什么这张卡优先级高

**我这整条 UI 线，所有「正文对齐 Claude」的改动，到今天为止都没有机器判据。**

- T134 宽度、T139 缩进与字号、T147 行高 —— 全是 PNG + 肉眼。
- 而 PNG 在这个仓库**本来就不是判据**（`README.md` §3：48 张图两轮连跑只有 12 张逐字节相同）。

**所以「正文对不对」这件事，现在的诚实答案是：我们不知道，我们只看过图。**

**这张卡是把「知道」变成可能的唯一路径。**
