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

---

# 回写（2026-10-24，T149 执行）

## 1. `.chat-md` 在每个消息场景里都存在吗 —— **只有 6 格有正文**

实测 51 格全量（`.tmp/arc005-visual/*.json` 的 `measured` 里数 `chat-body`）：

```
有正文 (present: true)   6 格
无正文 (present: false)  45 格
探针没产出这一项          0 格
```

**有正文的 6 格**：

```
messages-light-1280     messages-dark-1280     messages-narrow-1024
approval-light-1280     approval-dark-1280     approval-narrow-1024
```

**无正文的 45 格**：`empty` / `tools` / `diff` / `sidechat` / `terminal` / `editor` /
`preview` / `parallel` / `projects` / `settings` / `narrow-window` / `files-pane` /
`git-pane` / `taskcenter` / `workflow-board` 各 3 种条件。

**这正是「只有消息类场景有正文」的预期结果** —— 设置页、空态、纯面板没有 markdown 正文。
但**这是实测出来的，不是推断的**：45 格全部显式 `present: false`，不是探针静默失败。

## 2. 选了 C —— 新增 `chat-body` 选择器 + 缺正文显式记 null

```ts
// probe-assertions.ts
["chat-body", "[data-testid='workspace-main'] .chat-md"],
```

**为什么是 C 不是 A/B**：

| 选项 | 为什么没选 |
|---|---|
| A. 新增但不处理缺失 | 45 格会静默跳过 → 「一半格子没量」看起来和「全都对」一样 |
| B. 把 `message` 改成 `.chat-md` | `message` 的历史含义变了，之前的快照不可比；而且 `message` 量容器本身也有价值 |
| **C（选了）** | **新增独立项，缺正文的场景显式 `present: false` 并计入「已知（场景不适用）」** |

**关键设计**：`present: false` 和「量到了但值不对」在输出里**完全分得开**：

```
| ↳ measured:chat-body | light | 本场景无正文（present=false）| 已知（场景不适用）|
| ↳ measured:chat-body.lineHeight | Mcode=21.75px | 期望=24.375px | 未登记差异 |
```

**第一行是「这个场景本来就没有正文」，第二行是「有正文但行高错了」。**

## 3. ★ `compare.mjs` 能不能报出这种差异 —— **能，但需要我加一条新路径**

**这是这张卡最关键的一步，我核实到一件卡上没写的事：**

**`compare.mjs` 此前只比 `snapshot.tokens`（根 token 值），完全不读 `measured`。**

```js
// 原代码
for(const [key,[reference,upstreamVar,judgment]] of Object.entries({...expected[mode],...geometry,...motion})) {
  const actual = sample.snapshot?.tokens?.[key];   // ← 只读 tokens
  ...
}
```

**所以「加个选择器」是不够的** —— 数据会被采集，但比对侧根本不看。
**加选择器 + 不改 compare = 加了第二个假门禁。**

**我加了一条 `measuredChecks` 比对段**：

```js
const measuredChecks = {
  "chat-body": { fontSize: "15px", lineHeight: "24.375px" },
};

// 主循环内
const measured = Array.isArray(sample.snapshot?.measured) ? sample.snapshot.measured : [];
for (const [name, want] of Object.entries(measuredChecks)) {
  const hit = measured.find((m) => m?.name === name);
  if (!hit) { unknown++; /* 探针未产出 */ continue; }
  if (!hit.present) { known++; /* 场景不适用 */ continue; }
  for (const [field, expectedValue] of Object.entries(want)) {
    const ok = String(hit[field] ?? "").trim() === expectedValue;
    if (!ok) unknown++; else equal++;
  }
}
```

**三态各自记账**：没有这一项 → `unknown`（探针坏了）；`present:false` → `known`（场景不适用）；
有值但不符 → `unknown`（真差异）；有值且符 → `equal`。

## 4. 变异结果 —— **精确命中，`unregistered` 0 → 6**

**方法**：`cp` 备份 + `sha256sum` 核验，Python 精确替换（不用 sed）。

```
改前 --chat-md-leading: 1.625  (occurrences: 1)  → 改后 1.45
```

| 阶段 | equal | known | unregistered | EXIT |
|---|---|---|---|---|
| 正常（1.625） | 845 | 385 | **0** | 0 |
| **变异（1.45）** | 839 | 385 | **6** | 0（rc=2 被 run.sh 当「发现差异」） |
| 还原后 | — | — | — | 逐字节核验 `OK` |

**红的 6 条全部是 `chat-body.lineHeight`，值精确是 `21.75px` vs 期望 `24.375px`**：

```
| ↳ measured:chat-body.lineHeight | Mcode=21.75px | 期望=24.375px | 未登记差异 |   ×6
```

**6 条 = 6 个有正文的格子**（messages × 3 + approval × 3）。**数目和覆盖范围完全对上** ——
这不是「红得越多越好」，是「每个真正有正文的格子各红一条」。

**负控**：`fontSize` 在变异下**保持绿**（15px 没动）。**证明判据读的是行高字段，不是恒红。**

**还原核验**：`sha256sum -c` → `OK`，`grep` 确认 `--chat-md-leading: 1.625;` 回来了。

## 5. 51 格的新 `measured` 结构

**每格多了一项**（`measured` 数组里多一个元素，不是新增顶层 key）：

```json
{ "name": "chat-body",
  "selector": "[data-testid='workspace-main'] .chat-md",
  "present": true,
  "tag": "DIV",
  "fontSize": "15px",
  "lineHeight": "24.375px",
  "color": ..., "backgroundColor": ..., "borderRadius": ..., "padding": ...,
  "bounds": { "x": ..., "y": ..., "width": 644, "height": 68.375 } }
```

**没正文的格子**：`{ name, selector, present: false }` —— 显式缺席，字段齐全到 `present` 为止。

**总数从 15 项变 16 项。** `compare.mjs` 的汇总计数相应变化：
`equal` 833 → 845（+12 = 6 格 × 2 字段），`known` 340 → 385（+45 = 45 格 present:false）。

**这不影响既有判定**：`unregistered` 仍是 0，`snapshot.tokens` 的比对一字未动。

## 6. 提交

- **`<pending>`** —— `probe-assertions.ts` + `compare.mjs` + `claude-code-reference-matrix.md`

## 7. 觉得不对但没改的

### ① `message` 那一项仍然量的是外层容器 —— **我没改它**

**改了会破坏历史可比性**（`message` 之前的快照都是容器值）。
**而且容器本身也有价值**（能看消息块的整体尺寸）。

**但读者会误以为 `message` 量的是正文。** 我在 `probe-assertions.ts` 的 `chat-body`
注释里写清了这件事，**没有改 `message` 的名字** —— 改名同样破坏可比性。

**如果将来要清理**：`message` 应改名为 `message-container`，但那是另一个契约变更。

### ② 覆盖只有 6 格 —— 想扩大要加场景

**正文排版现在只在 `messages` / `approval` 两个场景被量到。**
如果将来 `tools`（工具卡片里的 markdown）或 `sidechat` 也渲染正文，它们**不在判据里**。

**这条我写进了矩阵**，但**没有擅自加场景** —— 加场景要改 `probe.ts` 的 SCREENS，
那是更大的改动，应该单独裁决。

### ③ `measuredChecks` 的期望值是硬编码的

```js
"chat-body": { fontSize: "15px", lineHeight: "24.375px" }
```

**这是「登记值」不是「从 CSS 推导出来的值」** —— 和 `expected` / `geometry` / `motion`
那三张表同一个模式（它们也都是硬编码的期望值）。

**一致性靠两件事守**：
- `t147-chat-leading-smoke` 断言 `styles.css` 的默认档是 1.625；
- 本文件的 `measuredChecks` 断言计算值是 24.375px。

**两者不同步时会有「未登记差异」** —— 这正是想要的行为。
**但如果有人改了 `styles.css` 又顺手改 `measuredChecks` 而不改 `t147`，那两边会一起漂。**
**这是整个 baseline 的既有结构（期望值靠人登记），不是本卡引入的。**

### ④ `t147-chat-leading-smoke` 与 `measuredChecks` 有重叠但不是重复

- `t147-chat-leading-smoke`：验**源码里的变量值**（快，静态，不起 Electron）
- `measuredChecks`：验**浏览器算出来的计算值**（慢，真 Electron，能抓到「变量改了但没生效」）

**后者抓得住前者的盲区**：`--chat-md-leading` 如果被别的规则覆盖，源码断言仍绿。
**这也是为什么 T149 值得做** —— 它不只是「多一个数字」，它验证了从变量到像素的整条链。

---

## 附：本轮新增的两处「判据自己也要被验」的证据

**这张卡的核心不是加了一个选择器，是加了一条会红的判据。** 三条对照：

| 检查 | 改前 | 改后 |
|---|---|---|
| 探针采集 `chat-body` 吗 | ❌ 没这一项 | ✅ 16 项（6 有值 / 45 present:false） |
| **compare 读 `measured` 吗** | **❌ 完全不读** | ✅ 三态记账 |
| **行高错了会红吗** | **❌ 不可能红**（根本不看） | ✅ **红 6 条，精确指向 lineHeight** |

**第二条是这张卡真正的发现** —— 卡上假设「加选择器就能比」，实际是「比的那一侧从来没读过 `measured`」。
**这和 T141 是同一个形态**：断言存在、数据存在，但两者之间没有连线。

