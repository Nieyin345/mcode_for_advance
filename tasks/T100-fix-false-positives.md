# T100｜🔴 判据会把好 deck 判成坏：修 rainbow 色相 + cover 豁免 + 打地鼠

- Status: **ready-for-agent**
- Category: **P0 产品缺陷**（用户能直接看见）
- Priority: **P0 —— 今天的判据会让模型把好设计改坏**
- Depends on: T75（`7dbbfc80`）、T98（F 的验证 `2ce47389`）
- Exclusive writable files:
  - `apps/desktop/src/main/document/deckPatternCheck.ts`
  - `apps/desktop/scripts/t65-deck-pattern-smoke/main.ts`

## Required Skills
- `mcode-smoke`：正控/负控 + 变异。

## 背景：F 实测「按提示改，deck 会更空」

### ① 打地鼠

用「三根空柱子」造 BAD，按判据给的提示改：

| | findings | 元素面积占画布 |
|---|---|---|
| 改前 | `card-whitespace` × 3 | **63%** |
| 按提示缩短卡片 | card-whitespace 清零，**但立刻出现 `layout.whitespace`** | **11%** |

**两条判据方向相反**：

- `card-whitespace`：卡片别高于内容 → **卡片变矮**
- `layout.whitespace`：内容铺满页面 → **需要更多内容**

**卡变矮之后页面当然更空。而提示没说「同时补内容」。**

### ② `palette.rainbow` 没有色相判断（**最严重**）

F 的 GOOD deck（深色封面 + 柱状图 + 同色阶梯）被报 **error**。

那三根柱子是 `#1F3A5F` / `#3E6E9E` / `#6FA3D2` —— **同一蓝色的深浅阶梯，数据可视化的标准做法。**

源码 `deckPatternCheck.ts:171-183`：

```ts
const colors = new Set<string>();
...
colors.add(f);          // ← 按色值字符串去重
if (colors.size <= 2) return [];
```

`isNeutral` 只判「接近灰/极亮/极暗」，**完全没有色相判断**。

**后果：做得好的数据可视化 deck 会被报最高严重度错误，模型会去「修」它。**

### ③ `cover` 豁免形同虚设

```ts
const type = page.type ?? "content";
const threshold = type === "cover" || type === "closing" ? loose : tight;
```

**豁免只认 `page.type === "cover"`。而模型写 spec 时通常不填 `type`** → 默认 `"content"` → 走 tight → **封面必报**。

**豁免在等一个模型不会填的字段。**

## 任务

### 一、`palette.rainbow` 按色相聚类

**把「同一色相不同明度」算作一个色。**

**实现要求**：

1. 把 hex 转 HSL（或 HSV）；
2. **色相接近的归为一组**（阈值你定，写进注释并论证）；
3. 中性色（低饱和度）仍然排除；
4. **同一组的多个明度算 1 个色**；
5. 组数 > 2 才报。

**关键正控/负控**：

| 用例 | 期望 |
|---|---|
| `#1F3A5F` / `#3E6E9E` / `#6FA3D2`（同色相三明度） | **不报** |
| `#FF0000` / `#00FF00` / `#0000FF`（三色相） | **报** |
| 两个强调色 + 一个同色相明度 | **不报**（仍是 2 组） |

**阈值论证**：色相差多少度算「同色相」？**给出理由**（不要拍一个数字）。

### 二、`cover` 豁免改成几何判断

**不再依赖 `page.type`。** 三个可选判据：

- **元素少**（比如 < 6 个）；
- **有满版色块 / 大图**（`isFullBleed` 用到的那套）；
- **从 outline 取 type**（如果 `readDeckPatterns` 能拿到 outline）。

**选一个并论证。** 我倾向「几何特征」，因为它不依赖模型填字段。

**正控/负控**：

| 用例 | 期望 |
|---|---|
| 深色满版底 + 一行大标题（**无 `type` 字段**） | **不报** |
| 普通内容页只铺 60% | **报** |

### 三、打地鼠：两条提示要联动

**`card-whitespace` 报出时，如果页面整体也偏空，消息里要同时说「补内容而不是只缩卡片」。**

**最简单的实现**：`card-whitespace` 的 message 加一句：

> 若页面整体也偏空（下方无其他元素），**缩短卡片前先补足卡内内容**，否则会触发留白判据。

**或者**：当页面同时满足两个条件时，**合并成一条** finding。

**你判断哪种更好，并说明理由。**

## 验收判据

1. **同色相三明度不报**（F 的 GOOD 用例）。
2. **三色相仍报**（判别力没丢）。
3. **封面无 `type` 字段也不报**。
4. **普通内容页只铺 60% 仍报**。
5. **打地鼠的联动提示**（或合并成一条）。
6. **变异**：把色相判断去掉 → 同色相正控必须红。
7. `t65` 套件全绿（数字会涨）。
8. T43 65/65、T73 40/40 不回归。
9. 不跑全量、不起 Electron。

## 边界

- 只改 `deckPatternCheck.ts` 与 `t65-deck-pattern-smoke/main.ts`；
- **不动 `patternFindingsText`**（那是 `documentToolRuntime.ts`）；
- 不改其他 5 条判据。

## 遇到问题先检索

HSL/HSV 色相距离的计算方式先查规范，**不要凭猜**。
「同色相」的常见阈值（比如 15°/30°/60°）要给出选择理由。

## 回写

`tasks/T100-fix-false-positives.md` 末尾追加 `## 结果回写（2026-10-24）`：
色相阈值论证、cover 判据选择、打地鼠方案、正负控、变异、套件数字、提交 SHA。
