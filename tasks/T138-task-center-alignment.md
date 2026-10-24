# T138｜任务中心的字号/圆角对齐 Claude

- Status: ready-for-agent
- Category: **P0 产品主线（UI）**
- Priority: **P0**
- Depends on: T121（七档已配）、T128（hover/选中类已落地）

## 一、为什么是它

**我数过（不是估的）**：

| 组件 | 硬写字号 |
|---|---|
| `FilesPanel` | 2 |
| `GitPanel` | **0** |
| **`TaskCenterPanel`** | **21** |
| **`TaskListPanel`** | **19** |

**任务中心是右栏里最没对齐 Claude 的。** 而它是用户每天看的（任务状态、产物、失败原因）。

## 二、任务

### 第一步：把 40 处硬写字号映射到七档

```bash
grep -n "text-\[[0-9.]*px\]\|text-\[[0-9.]*em\]" \
  apps/desktop/src/renderer/components/ide/TaskCenterPanel.tsx \
  apps/desktop/src/renderer/components/ide/TaskListPanel.tsx
```

**映射规则**（和 T121 一致）：

| 现值 | 该用 |
|---|---|
| `10px` / `0.7143em` | `text-caption`（11px）或保留（看用途） |
| `11px` / `0.7857em` | `text-caption`（11/16） |
| `12px` / `0.8571em` | `text-code`（12/16）或 `text-footnote`（12/14） |
| `13px` / `0.9286em` | `text-footnote`（12）—— **13 不在七档里** |
| `14px` | `text-body` |

**⚠️ `13px` 是不该存在的一档**（T121 的「值不在任何一档里」判断法）。**全部归到 12px 或 14px，看用途。**

### 第二步：圆角对齐

```bash
grep -n "rounded-" apps/desktop/src/renderer/components/ide/TaskCenterPanel.tsx | head -20
```

**该用的**：
- **卡片/面板** → `rounded-[var(--radius-panel)]`（10px）
- **按钮/徽标** → `rounded-[var(--radius-btn-xs)]`（6px）或 `-md`（8px）
- **`rounded-full`** → 保留（药丸/圆点）

**⚠️ `rounded-md`（默认 6px）和 `--radius-btn-xs`（6px）数值相同**，但语义不同。**统一成 token，不要留裸值** —— 否则下次调圆角时它们不会跟着变。

### 第三步：选中态检查

**任务列表里应该有「选中某一行」的状态**。核实它现在用什么：

```bash
grep -n "bg-surface-hover\|bg-accent\|isActive\|selected" \
  apps/desktop/src/renderer/components/ide/TaskListPanel.tsx | head
```

**该用**：`--selected-bg` + `--selected-content` + `font-medium`（和右栏其他列表一致）。

**⚠️ 但如果它现在用 `bg-accent/20` 之类**，那是另一套语义（强调而非选中），**先判断再改**。

## 三、验收

1. **硬写字号从 40 处降到 0**（或明确记录保留的及理由）。
2. **`13px` 一处不剩**（不在七档里）。
3. **圆角走 token**，不是裸 `rounded-md`。
4. **选中态和右栏其他列表一致**（或说明为什么不同）。
5. **不回归**：`taskcenter` / `task-*` 套件全绿。

## 四、视觉验证

**跑一次基线**（N 刚加了 `taskcenter` 场景）：

```bash
bash apps/desktop/scripts/arc005-visual-baseline/run.sh
```

**对比 `.tmp/arc005-visual/taskcenter-light-1280.png`**，看字号是否统一、圆角是否一致。

**⚠️ `compare.mjs` 只比 token，不比像素** —— 所以它可能会报差异，**要看 `diff.md` 判断是不是我们动的**。

## 五、变异

| 变异 | 正控（该红） | 负控（该绿） |
|---|---|---|
| 一处 `text-caption` 改回 `text-[13px]` | 1（13px 清零那条） | — |
| 圆角改回裸 `rounded-md` | 1（token 那条） | — |

## 六、边界

**可以改**：
- `components/ide/TaskCenterPanel.tsx`
- `components/ide/TaskListPanel.tsx`
- 新建或延伸套件

**不许碰**：
- `settings/workflows/`（工作流总控在改）
- `FilesPanel` / `GitPanel`（它们基本对齐了，动它们收益低）
- `styles.css` / `tailwind.config.js`

开工前 `git status` 核实。

## 七、回写

1. 40 处分别映射到哪一档（表格）
2. `13px` 那几处怎么处理的
3. 圆角统一成了什么
4. 选中态是否改动、为什么
5. 基线对比结果、套件数字、变异、提交 SHA
6. 你觉得不对但没改的


---

# 回写（2026-10-24）

## 1. 40 处映射到哪一档

**实数是 39 处真实用法 + 1 处注释。** 40 这个数字来自写卡时的 `grep`，它把 `TaskCenterPanel.tsx:429` 注释里引用的 `text-[10.5px]` 也算进去了 —— 那是**记录**，不是用法。

**改完之后的实际分布**（`grep -c` 剥注释口径，和套件用同一个数法）：

| 档位 | TaskCenterPanel | TaskListPanel |
|---|---|---|
| `text-caption`（11/16） | **16** | **19** |
| `text-footnote`（12/14） | **3** | **0** |
| 合计档位用法 | **19** | **19** |

> ⚠️ **TaskCenterPanel 全文里有 19 个 `text-caption` 字样，但其中 3 个在注释里**（446/450/455 行，都是我写的解释）。**代码里是 16 处。** 套件用 `stripComments` 之后数，所以记 16 —— 这两个数都对，只是口径不同。**写回写时我先写成 11，那是错的。**

**`13px` 一处都没有** —— 两个文件里从来没出现过 13px。写卡时假设「13px 是不该存在的一档」，这条在两个文件上不适用。

## 2. `13px` 怎么处理的

**不适用。** 见上。卡里这段是通用规则，不是这两个文件的现状。

## 3. 圆角统一成了什么

**9 处裸 `rounded`（4px）→ token**：

| 位置 | 改成 | 为什么 |
|---|---|---|
| `FilterChip` 外框 | `--radius-btn-xs`（6px） | 小按钮 |
| 失败 / 退回 / 验收 三种色块 | `--radius-btn-md`（8px） | 内容块，比按钮大一号 |
| 验收/退回输入区外框 | `--radius-panel`（10px） | 面板 |
| 输入区 `<textarea>` | `--radius-btn-md`（8px） | 控件 |
| `TaskListPanel` 6 处小控件 | `--radius-btn-xs`（6px） | 徽标 / 小按钮 |

`rounded-full` 全部保留（药丸、圆点）。

## 4. 选中态 —— 核实后**不改**

`TaskCenterPanel` **没有行级选中**（行是「展开」，不是「选中」）。唯一的选中态是 `FilterChip` 的 `aria-pressed`，而 `TaskCenterPanel.tsx:420-427` 的注释写明了理由：

> accent 只留给「运行中 / 需要注意」的信号。筛选条的选中两样都不是 —— 它是选中态，所以走**中性底 + 边框**表达。

**这是对的，而且不是遗漏。** 改它反而会破坏「accent 的语义唯一性」。

## 5. 基线、套件、变异、SHA

### 基线：**它抓到了我引入的回归**

- **改前** `taskcenter-light-1280.png` = `a2c7845f…`（`git stash` 后重跑取得）
- **改后（有 bug）** = `ad9e7037…` —— **筛选条从 2 行变成 3 行**
- **修复后** = `4317c299…` —— 回到 2 行

> ⚠️ 我第一次把「改前」备份建在了改完之后，两张图 sha 相同（`3df34d1c…`），差点当成「改动不可见」。用 `git stash push -u` 重做了改前快照才有意义。

### ⚠️ 最重要的一条：我引入了一个 3 行回归，根因不在我改的地方

`text-[11px]` → `text-caption`，字号 11px → 11px，**本不该有任何变化**。实际 chip 变大了。

根因：**`cn()` 是裸 `twMerge`，它不认识自定义档位名。** `twMerge("text-caption text-content")` → `"text-content"` —— 字号被当作颜色类丢掉，回落到继承值 **16px**（`html/body` 没设 `font-size`）。

**全仓 27 处同类失效**，最严重的是 `ui/input.tsx`、`ui/select.tsx`、`ui/dialog.tsx`、`ui/textarea.tsx`、`ui/native-controls.tsx` —— **全部共享控件**。

→ **已开 `tasks/T140`**。本卡只在 chip 这一处做了局部规避（内联 `fontSize`），注释写明了原因和「T140 修好后改回来」。

**这个 bug 对 T121/T130/T133 有直接影响**：它们的套件断言源码里「有 `text-caption`」，那是绿的；真正决定渲染的 `cn()` 把它丢了，**没有一条套件看得到**。

### 套件

| 套件 | 结果 |
|---|---|
| `t138-task-center-tokens-smoke`（新建，17 条） | **17/17** |
| `t100-task-center-smoke` | 106/106 |
| `t133-text-scale-smoke` | 4/4 |
| `design-tokens-smoke` | 353/353 |
| `task-roster-smoke` | 15/15 |
| `tsc --noEmit`（双包） | EXIT=0 |

### 变异（每条都先写预期）

| # | 变异 | 预期红 | 实际红 | 红的对不对 |
|---|---|---|---|---|
| M-A | 内联 `fontSize` 改回 `text-caption` | 3（第六节三条） | **3** | ✅ 正是那三条 |
| M-B | `11px` → `13px` | 2–3 | **3** | ✅ 13px 清零 + 冲突两条；**负控「没有 text-caption」正确地保持绿** |
| M-C | `TaskListPanel` 删一处 `text-caption` 不补 | 1（下限） | **1** `{"n":18,"floor":19}` | ✅ |

**M-C 这条值得单独说**：第一版套件只有「`text-caption` 被用上（> 0）」，M-C 会**0 红**。是按文件记下限才抓住的。

### 提交

- **`0a05cabe`** —— 两个组件 + 新套件（4 文件，+256/−43）
- **`edb96811`** —— `tasks/T140`
- **`f42c2e96`** —— `tasks/T141` 追加实测

## 6. 觉得不对但没改的

### ① `cn()` 丢字号（→ T140，已开卡）

见上。**这是本轮最重要的发现，比 T138 本身重要。**

### ② `build.mjs:210` 的 `complete = checks.length === 39`

`result.json` 实测：`checks: 51, failed: [], complete: false`。**51 个场景全部成功，`complete` 只是因为常量写死 39。**

后果：`build.mjs` 每次都 exit 1，**`compare.mjs` 从来没在 `run.sh` 里被调用过**。整个 token 比对门禁是空的。

→ 已补进 `T141`（第十节），并写明「两处必须一起改，只改 `compare.mjs` 看不到任何变化」。

### ③ `taskcenter` 场景的 `measured` 是空的

```js
Object.keys(json.measured).length === 0
```

**基线拍了 PNG，但一个元素都没测量。** 所以它**无法判断字号/圆角是否对齐** —— 只能靠人眼看图。

这正是我这次要靠肉眼发现 3 行回归的原因。**建议在 T141 一起修**，但它不在 T141 现有范围内，我没有擅自扩。

### ④ `FilterChip` 的内联 `fontSize` 是临时规避

T140 修好后应当改回 `text-caption` 并删掉注释。**如果 T140 一直不做，这里会变成一个「为什么别人都用 class 就你用 style」的疑问点。**

### ⑤ 我这轮的取证工具反复出错（记下来给下一个人）

写 T140 卡时，我数错了三次「到底几处真问题」：

1. 第一次说 29 处、其中 2 处误报 —— **数错**；
2. 第二次说 28 处、我判的「两处误判」 —— **还是错**（`LibrarySection` 和 `input.tsx` 都是真问题）；
3. 第三次（`verify-v2-final.mjs`）才对：**27 真 / 1 假**。

根因是括号配对**只跳过了字符串和 `//`，漏了 `/* */`**。块注释里的 `(...)` 让配对永不归零，`slice` 一路返回到文件末尾，把后面组件的 `text-body` 算了进来 —— **于是「`GitDiffDialog:191` 有 `text-body`」这个结论是工具造出来的**。

**这是 CLAUDE.md 第八条第 3 种形态**：改坏了取证工具，却以为在验被测对象。**可靠版本留在 `.tmp/t140-evidence/`。**
