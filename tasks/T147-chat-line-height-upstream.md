# T147 — 正文行高：上游是 1.625（`leading-relaxed`），我们是 1.45

**Status**：`ready-for-human`（执行完成，回写见文末「七、回写」；待人工核对观感）
**Category**：P0 产品主线（UI）—— 用户：「全盘模仿 Claude」
**写卡时间**：2026-10-24 21:30。**前提都是这一刻实测的。**

## 一、症状

我们的对话正文行高比 Claude 紧 **2.65px**（约 12%）。

| | 字号 | 行高倍数 | 实际行高 |
|---|---|---|---|
| **上游**（`ChatMessageBubbles.tsx:361`） | `text-[15px]` | `leading-relaxed` = **1.625** | **24.375px** |
| **我们**（`styles.css:1996`） | `--chat-font-size: 15px` | `--chat-md-leading: **1.45**` | **21.75px** |

**我们的注释写的是「CDS 上游 1.42857」—— 那是错的。**

## 二、根因：我们读错了上游的变量

### 我们用的注释依据

```css
/* styles.css:1996 */
--chat-md-leading: 1.45;   /* CDS 上游 1.42857,取整到 1.45 */
```

**`1.42857` 来自 `cds-theme.css:179`：**

```css
--chat-leading: 1.42857;
```

### 但那个变量**没人用**

```bash
grep -rn "chat-leading" open-claude-ui/code-examples/*.tsx
# → ChatMessageBubbles.tsx:7 有一行注释提到，没有任何组件真的用它
```

**和 `--chat-body` 是同一个陷阱**：CSS 里定义了一个值，不代表它在用。

### 真正生效的是 Tailwind 类

```tsx
// open-claude-ui/code-examples/ChatMessageBubbles.tsx:361
<div className="prose text-[15px] leading-relaxed ...">
```

**`leading-relaxed` 是 Tailwind 内置 = 1.625。**

**而上游 `tailwind.config.js` 没有覆盖 `lineHeight`**（我读过全文 93 行，只有 colors / fontFamily / borderRadius / boxShadow / animation）。

## 三、任务

### 第一步：改 `--chat-md-leading` 的三处值

`styles.css` 里有三个密度档：

| 行 | 档 | 现在 | 改成 | 说明 |
|---|---|---|---|---|
| `:1996` | `:root`（默认） | `1.45` | **`1.625`** | 对齐上游 `leading-relaxed` |
| `:2006` | `compact` | `1.42` | **`1.5`** | 紧凑档，比默认紧但不偏离太远 |
| `:2016` | `cozy` | `1.6` | **`1.75`** | 宽松档，本来就该比默认松 |

**⚠️ 三个档的单调关系必须保持：`compact < 默认 < cozy`。**
现在是 `1.42 < 1.45 < 1.6`，改后是 `1.5 < 1.625 < 1.75` —— **关系保持，间距拉大了。**

**⚠️ 如果执行者认为 `compact` 1.5 太紧（相对 1.625 只低 7.7%），可以调成 1.55。**
**关键是「紧凑档必须真的比默认紧」，不是某个具体数字。**

### 第二步：改注释，**删掉错的依据**

```css
/* ❌ 现在 */
--chat-md-leading: 1.45;   /* CDS 上游 1.42857, 取整到 1.45 */

/* ✅ 改成 */
/* 上游真身是 ChatMessageBubbles.tsx:361 的 `leading-relaxed`（Tailwind 内置 1.625）。
 * cds-theme.css 里的 `--chat-leading: 1.42857` 是个没人引用的变量 —— 别再用它。 */
--chat-md-leading: 1.625;
```

**⚠️ 三处都要改。** 只改一处会让另外两处的注释继续误导人。

### 第三步：核实这真的作用到正文

**`--chat-md-leading` 必须真的被 markdown 正文的 `line-height` 读到。** 核实：

```bash
grep -rn "chat-md-leading" apps/desktop/src/renderer/
```

**如果它只出现在 `styles.css` 的定义处，没有任何使用点 —— 那它就是死变量**（就像上游的 `--chat-leading` 一样）。
**这种情况下改它等于什么都没做。**

**⚠️ 这条必须先查。** 卡上的 T134 教训：`--chat-max-w` 在 CSS 里没有定义，
默认值只能由 `ChatPane.tsx` 的 fallback 提供，改表对默认档完全无效。

### 第四步：视觉验证

**T141 已经修好，视觉基线现在能真跑**（`ccd96c4e`，51 格，`unregistered: 0`）。

```bash
bash apps/desktop/scripts/arc005-visual-baseline/run.sh
```

**对比 `.tmp/arc005-visual/messages-light-1280.png` 改前/改后。**

**预期**：正文行距明显变松，同样的文字占据更高的高度。

## 四、验收

1. **`--chat-md-leading` 三个档的值分别是 1.625 / 1.5 / 1.75**（或执行者判断的等价单调序列）。
2. **三处注释都改成了正确依据**（不再引用 `--chat-leading: 1.42857`）。
3. **`--chat-md-leading` 真的被使用**（有 grep 证据，不是死变量）。
4. **视觉基线对比**：`messages-light-1280.png` 行距变松。
5. **不回归**：`t122-chat-rhythm-smoke` / `t134-chat-width-smoke` 全绿。

## 五、变异

| 变异 | 预期红 | 说明 |
|---|---|---|
| 默认档改回 `1.45` | 1 | 「默认档 = 1.625」那条 |
| 三个档改成相同值 | 1 | 单调性那条 |
| 把 `--chat-md-leading` 定义删掉但保留使用点 | 1 | 「确实被使用」那条 |

**⚠️ 第三条变异要注意**：如果它只被 `var(--chat-md-leading)` 引用，
删掉定义后浏览器会回落到 `normal`（约 1.2），**这是静默降级，不会报错**。
断言必须能抓到「值不对」而不是「变量不存在」。

## 六、边界

**可以改**：
- `apps/desktop/src/renderer/styles.css` 的 `--chat-md-leading` 三处 + 注释
- 延伸现有套件（`t122-chat-rhythm-smoke` 或新建）

**不许碰**：
- `--chat-font-size`（T139 刚定成 15px）
- `--chat-row-gap-*` / `--chat-block-gap`（那是间距，不是行高）
- `components/settings/workflows/`（工作流总控）
- `arc005-visual-baseline/`（只跑，不改）
- `tailwind.config.js`（T146 待裁决）

## 七、回写

### 1. `--chat-md-leading` 的使用点（卡上第三步）

**它是活变量，真的被读进 line-height：**

```
components/chat/Markdown.tsx:912
  className="chat-md ... [line-height:var(--chat-md-leading)] ..."
```

其余命中都在注释里（`styles.css:316/486/1951`、`Markdown.tsx:899`）。**所以改定义真的生效。**

### 2. 三个档改成了什么

| 档 | 改前 | 改后 | 依据 |
|---|---|---|---|
| `:root` / comfortable（默认） | 1.45 | **1.625** | 上游 `leading-relaxed`（Tailwind 内置，未被覆盖） |
| `compact` | 1.42 | **1.5** | 默认向下 7.7%，保持「紧凑确实更紧」 |
| `cozy` | 1.6 | **1.75** | 默认向上 7.7%，三档等距 |

**为什么不用别的值**：`1.625` 不是我选的，是 Tailwind `leading-relaxed` 的定义值
（`node_modules/.pnpm/tailwindcss@3.4.19/stubs/config.full.js:610` 实测 `relaxed: '1.625'`），
而上游 `tailwind.config.js` 没有 `lineHeight` 段覆盖它。`compact`/`cozy` 是相对值，
按「默认 ±7.7%」取整 —— 原来三档间距是 0.03/0.15（不对称），现在是对称的 0.125/0.125。

### 3. 视觉基线改前/改后

**改前备份**：`.tmp/t147-before/messages-{light,dark}-1280.{png,json}`（sha 已记）

**跑完整基线**（T141 修好之后第一次在本卡下跑）：

```
arc005-visual-baseline: 51/51 格（3 格登记为拍不出内容）
{"grid":51,"expected":51,"captured":48,"missing":3,"equal":833,"known":340,"unregistered":0}
arc005 visual compare: no unregistered differences
EXIT=0
```

**PNG 确实变了**：

| 文件 | 改前 sha | 改后 sha |
|---|---|---|
| `messages-light-1280.png` | `495ac0ed…` | `96b099bf…` |
| `messages-dark-1280.png` | `e98c350f…` | `6381e615…` |

**⚠️ 但 `measured` 里的字段一个都没变** —— 因为探针的 `message` 选择器是
`[data-testid='workspace-main'] .prose, [data-testid='workspace-main'] [data-message-id]`，
`querySelector` 命中的是**外层容器**（16px/24px），不是 `.chat-md` 正文。**这是基线的
探测缺口，不是本卡的问题**（见第 5 节）。

**所以我另写了一个一次性 Electron 探针直接量 `.chat-md`**（用完已删）：

```
T147-MEASURE {
  "found": true, "fontSize": "15px", "lineHeight": "24.375px", "fontWeight": "450",
  "density": {
    "comfortable": { "lineHeight": "24.375px", "varValue": "1.625" },
    "compact":     { "lineHeight": "22.5px",   "varValue": "1.5"   },
    "cozy":        { "lineHeight": "26.25px",  "varValue": "1.75"  }
  }
}
```

**真 Electron 里默认档 15 × 1.625 = 24.375px，改前是 15 × 1.45 = 21.75px —— 松了 2.625px。**

### 4. 套件、变异、提交

**新套件**：`apps/desktop/scripts/t147-chat-leading-smoke/`（12 条断言）

| 组 | 守什么 |
|---|---|
| [1] | 三档都定义在（剥注释后的）源码里 |
| [2] | ★ 默认档 === 1.625 + 负控（不等于旧值 1.45） |
| [3] | 三档单调 + 负控（不是同一个值） |
| [4] | 定义恰好 3 处（防止某档被覆盖两次） |
| [5] | ★ 活变量：`Markdown.tsx` 真的把它读进 line-height + 负控 |
| [6] | 注释里不再出现错依据 `"CDS 上游 1.42857"` |

**变异（每条先写预期，再跑）**：

| # | 变异 | 预期红 | 实际红 | 红的是哪几条 |
|---|---|---|---|---|
| M-1 | 默认档 1.625 → 1.45 | **1** | **3** | 默认档断言 ✅ + 负控「不等于 1.45」✅ + **compact < comfortable**（1.5 < 1.45 不成立） |
| M-2 | 三档全改成 1.6 | 3–4 | **4** | 默认档 ✅ + compact<comfortable ✅ + comfortable<cozy ✅ + 负控「三档不是同值」✅ |
| M-3 | 删掉默认档的定义 | 1 | **4** | 默认档 ✅（读到的是 compact 的 1.5）+ compact<comfortable ✅ + 负控 ✅ + **定义恰好 3 处**（count=2）✅ |

**⚠️ M-1 的预期我写错了**：我说红 1 条，实际红 3 条。多出来的两条**不是判据失效** ——
1.45 比 compact 的 1.5 还小，所以单调性**真的**被破坏了。**这是变异同时触发了另一条
真实规则，不是「红错了地方」。** 但预期写 1 是我的记账错误，如实记下。

**还原**：三次都用 `cp 备份 目标` + `cmp` 逐字节核验（`a85c651c…`），**没用 `git checkout`**。
还原后套件 12/12 复绿。

**回归（全绿）**：

| 套件 | 结果 |
|---|---|
| `t122-chat-rhythm-smoke` | 26/26 |
| `t134-chat-width-smoke` | 16/16 |
| `t139-message-alignment-smoke` | 15/15 |
| `t140-cn-tier-smoke` | 17/17 |
| `t142-font-tier-migration-smoke` | 10/10 |
| `design-tokens-smoke` | 353/353 |
| `t147-chat-leading-smoke`（新） | 12/12 |

**typecheck**：`packages/contracts` EXIT=0；`apps/desktop` **EXIT=2，但 14 条错误全部在
`scripts/o4-docs-close-smoke/`**（另一个会话 21:31 起的半成品，`??` 未跟踪）。我把那个目录
单独移开复跑，我的文件**零条错误**（`grep -E "styles.css|t147" → 0`）。

### 5. 觉得不对但没改的

1. **基线探针量不到 `.chat-md`** —— `ARC005_MEASURE_SELECTORS` 的 `message` 项
   （`probe-assertions.ts:53`）命中外层容器，所以**行高变化在基线 JSON 里完全不可见**，
   只能靠 PNG 或独立探针。**这是基线的结构性缺口**：所有「正文排版」类改动都没有
   实测证据，而正文排版恰恰是最常改的。建议另开卡给 `ARC005_MEASURE_SELECTORS`
   加一项 `["chat-body", "[data-testid='workspace-main'] .chat-md"]`。
   **我没擅自加** —— 那会改变所有 51 格的 `measured` 结构，属于基线契约变更。

2. **`smokes-for.sh` 不认 `src/renderer/**` 的覆盖声明** ——
   `SMOKE_COVERS_RE` 写死 `src/main/` 前缀（`smokes-for.py:77`），所以我这套
   虽然读 `styles.css`，`smokes-for.sh src/renderer/styles.css` 仍报「没有套件覆盖」。
   **这是该工具的范围限制**（它为主进程设计），不是本套的问题。改它会影响
   `tsx-coverage-smoke`（那套断言它的输出格式），属于独立工作。

3. **`compact` 1.5 只比默认紧 7.7%**，可能不够「紧凑」。但更紧（如 1.42）会让它
   接近旧的错误值，反而恢复旧观感。**取 1.5 是有意的**；如果用户觉得不够紧，
   应该单独调这一档，而不是拉回默认。

### 6. 提交

- **`5e524381`** —— `apps/desktop/src/renderer/styles.css` + `scripts/t147-chat-leading-smoke/`（3 文件 +242/−7）
- **`<SHA>`** —— 本回写

---

## 附：这张卡和相关卡的关系

| 卡 | 关系 |
|---|---|
| **T146** | 七档尺度和上游不是同一基准（**待用户裁决**）。本卡只改行高，不动字号体系。 |
| **T134** | 聊天宽度。本卡不动宽度。 |
| **T139** | 消息对齐（含 `--chat-font-size: 15px`）。本卡是它的补完：字号对了，行高还错着。 |
| **T122** | 聊天节奏（`--chat-row-gap-*`）。本卡不动间距。 |

**⚠️ 如果 T146 最终决定「放弃七档、全盘照上游」，本卡的 `1.625` 就是正确终点。**
**如果 T146 决定「保留七档并重定标」，`prose: 15/22` 也要跟着改成 15/24.4 —— 那是 T146 的事。**
