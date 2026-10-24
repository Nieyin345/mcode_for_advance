# T132｜728 处硬抄的字号系数让「对话字号」设置基本失效

- Status: ready-for-agent
- Category: **P0 产品缺陷（用户设置不生效）**
- Priority: **P0**
- Depends on: T121（七档已配）
- **与 T130 的关系**：T130 管硬写 px（657 处），这张管 em（728 处）。**两者是同一件事的两个来源，但判断逻辑不同，所以分开。**

## Exclusive writable files

- `apps/desktop/src/renderer/components/chat/`
- `apps/desktop/src/renderer/components/`
- `apps/desktop/scripts/font-scale-smoke/main.ts`（延伸）

---

## 零、缺陷（我数过）

```
用 var(--chat-fs-*) 变量        55 处
硬抄系数 text-[0.7857em] 等     728 处
```

而这些系数**就是变量本身的值**（`styles.css:618-620`）：

```css
--chat-fs-sm:  calc(var(--chat-font-size) * 0.9286);
--chat-fs-xs:  calc(var(--chat-font-size) * 0.8571);
--chat-fs-xxs: calc(var(--chat-font-size) * 0.7857);
```

**`text-[0.8571em]` 的视觉效果 = `var(--chat-fs-xs)`，但它不跟 `--chat-font-size` 变。**

### 后果

用户在设置里调「对话字号」（`--chat-font-size`），**只有那 55 处跟着变，728 处纹丝不动。**

**这是「设置点了没反应」的一个具体来源。** 而且它比「字号不统一」严重 —— 前者是**功能失效**，后者是**观感问题**。

## 一、先验证这个判断（不要直接改）

**在动手之前，先跑一个最小实验**：

1. 把 `--chat-font-size` 从 14px 改成 20px；
2. **看界面上哪些字变大了**；
3. 如果只有少数变大，而大部分不变 —— **确认缺陷**。

**⚠️ 这个实验必须在真机或 preview 里做**，因为在 CSS 里改一个变量，headless 量不出视觉结果。

**如果做不了视觉验证**，改用静态判断：

```bash
# 找出所有硬抄系数的位置
grep -rn "text-\[0\.7857em\]\|text-\[0\.8571em\]\|text-\[0\.9286em\]\|text-\[0\.7143em\]" \
  apps/desktop/src/renderer/ --include=*.tsx
```

**把每一处的值换算成「它相当于哪一档」**：

| 硬抄值 | 对应变量 | 尺寸（14px 基准） |
|---|---|---|
| `0.6428em` | ？ | 9px |
| `0.7143em` | ？ | 10px |
| `0.7857em` | `--chat-fs-xxs` | 11px |
| `0.8571em` | `--chat-fs-xs` | 12px |
| `0.9286em` | `--chat-fs-sm` | 13px |
| `0.9em` / `0.85em` / `0.92em` | **没有对应变量** | 零碎值 |

**前两行（`0.6428` / `0.7143`）在 `--chat-fs-*` 里没有对应项** —— 它们是「比 xxs 还小」的字。**这 239 + 15 处需要单独判断。**

## 二、修法

### 第一批：有直接对应变量的

```diff
- className="text-[0.7857em]"
+ className="[font-size:var(--chat-fs-xxs)]"
```

```diff
- className="text-[0.8571em]"
+ className="[font-size:var(--chat-fs-xs)]"
```

```diff
- className="text-[0.9286em]"
+ className="[font-size:var(--chat-fs-sm)]"
```

**⚠️ 用 `[font-size:var(--...)]` 而不是 `text-[var(--...)]`。** 后者在 Tailwind 里也能用，但 `text-` 前缀同时管颜色和字号，容易混淆。**先确认项目里现有 55 处用的是什么写法，保持一致。**

```bash
grep -rn "var(--chat-fs" apps/desktop/src/renderer/ --include=*.tsx | head -5
```

### 第二批：没有对应变量的（`0.6428` / `0.7143` / 零碎值）

**239 处 `0.7143em`（=10px）** 和 **15 处 `0.6428em`（=9px）**。

**这两个值在规范七档里没有对应。** 判断和 T130 一样：**先看它们是什么场景，再决定「新增档位」还是「归并」**。

## 三、验收判据

1. **有对应变量的三类（`0.7857` / `0.8571` / `0.9286`）全部改成变量**，共 **621 处**（294+239... 等等，这里要精确，执行时数）。
2. **★ 功能验证**：把 `--chat-font-size` 改成 20px，**界面上所有对话文字都跟着变大** —— 这条是本卡的核心。
3. **不回归**：`font-scale-smoke`、`message-collapse-smoke`、`chat-*` 全绿。
4. **硬抄 em 的数量单调下降**（有断言）。

**第 2 条如果做不了视觉验证，就换成**：断言「没有任何 `.tsx` 里出现 `text-[0.7857em]` 这类字面量」，因为它的存在**就是**变量失效的证据。

## 四、变异

| 变异 | 正控（该红） | 负控（该绿） |
|---|---|---|
| 把一处 `var(--chat-fs-xs)` 改回 `text-[0.8571em]` | 1 | — |
| 改的时候新增一个 `text-[0.88em]` | 1（档位计数） | — |

## 五、⚠️ 这可能比 T130 更值得先做

T130 是「字号不统一」（观感）；**这张是「设置不生效」（功能）**。

**如果只能先做一张，做这张。** 但两张都动 `chat/`，不能并行。

## 六、回写

1. **第一节那个实验做没做、结果是什么**（这条最重要）
2. `0.6428em` / `0.7143em` 的用途（Top 5 场景 + 判断）
3. 改了多少处、硬抄 em 从多少降到多少
4. 套件数字、变异、提交 SHA
5. 你觉得不对但没改的地方
