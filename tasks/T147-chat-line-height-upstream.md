# T147 — 正文行高：上游是 1.625（`leading-relaxed`），我们是 1.45

**Status**：`ready-for-agent`
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

1. **`--chat-md-leading` 的使用点在哪**（第 3 步的核实结果）
2. 三个档改成了什么，为什么不选别的值
3. 视觉基线的改前/改后（哪个字段变了）
4. 套件数字、变异、提交 SHA
5. **你觉得不对但没改的**

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
