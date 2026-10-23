# T79｜T73 漏派的三条：fail-closed / `page: null` / 文件名渲染

- Status: ready-for-agent
- Category: **流程修正 + 产品修复**
- Priority: **P0** —— 页号错位让模型改错文件，这是「越改越糟」的直接原因
- Depends on: T73（`da9484b4`）、T65（`f6acf173`）、T70（`99e73df2` + `7f13da22`，A 发现）
- Exclusive writable files:
  - `apps/desktop/src/main/document/documentToolRuntime.ts`
  - `apps/desktop/src/main/document/deckPatternCheck.ts`
  - `apps/desktop/scripts/t73-pattern-wiring-smoke/main.ts`

## Required Skills
- `mcode-smoke`：给三条修复各补正负控。

## ⚠️ 先说一句流程问题（这不是 B 的错）

**这三条我在给 B 的消息里说过，但 T73 卡上没写。** B 执行的是卡，不是消息。

**结果**：B 只做了卡上写的（接线 + 排序），这三条没做。

**所以这张卡的第一层价值是「把口头的派活变成可验收的卡」。** 这正是用户反复强调的规矩：**派活必须走任务卡。**

## 三条漏项

### 一、fail-closed：坏 JSON 导致页号静默错位

**现状**（`documentToolRuntime.ts:809-825`）：

```ts
for (const name of names) {
  try {
    const page = asPageSpec(JSON.parse(readFileSync(file, "utf8")) as unknown);
    if (page === null) {
      notes.push(`${name} 不是页面 spec（形状不符），已跳过。`);
      continue;                              // ← pages 数组少一项
    }
    pages.push(page);
  } catch (error) {
    notes.push(`${name} 解析失败：...`);      // ← 同样只记 note
  }
}
```

**后果**（A 实测）：

```
01.json 正常
02.json 写了一半（坏 JSON）
03.json 正常，但有一条真缺陷

→ { checked: true, findings: [{ page: 1, message: "第 2 页…" }] }
```

**缺陷在第 3 页，报成「第 2 页」。** 模型去改 `pages/02.json`（那个坏文件），改完还是解析不了。

**这是三种坏结果里最隐蔽的一种**：报得对，但指向错的文件。

#### 要求

**任何页面文件解析失败 → 整次 `checked: false`。**

```ts
} catch (error) {
  return {
    checked: false, applied: {}, findings: [],
    notes: [`${name} 解析失败，本次反模式检查整体未执行（页序不可信）。先把 JSON 修好，再谈反模式。`],
  };
}
```

**`asPageSpec` 返回 null（形状不符）也要 fail-closed**，理由相同：**少了任何一页，后面所有页的位置都挪了**。

> 检查器的全部判据都建立在「页序」上（留白按页型、雷同在相邻页之间、页眉条要求每页都有）。少一页不只是「少查一页」，是**把后面所有页的位置都挪了**。

#### 断言

- **负控 1**：`01.json` 正常 + `02.json` 坏 JSON + `03.json` 有缺陷 → `patternChecked === false` **且** `patternFindings` 为空；
- **负控 2**：`02.json` 形状不符（`{not:"a page"}`）→ 同样是 `checked: false`；
- **正控**：三个正常文件 → `checked: true`。

⚠️ **注意区分**：`outline.json` / 非 `.json` 文件**本来就不是页面**，在 filter 阶段已经排除，**不触发 fail-closed**。

### 二、`page: null`：跨页判据不要假装指向某一页

**现状**（`deckPatternCheck.ts`）：

- `header.bar` → `page: 0`
- `layout.repeated` → `page: runStart`

**渲染出来**（`documentToolRuntime.ts:449`）：

```ts
const where = typeof f.page === "number" ? `第 ${f.page + 1} 页` : "整份";
```

**模型读到的是**：

```
- [warning] header.bar · 第 1 页：每一页的同一位置都有同样一块……
- [warning] layout.repeated · 第 1 页：第 1–3 页构图相同……
```

**两行都是矛盾句**：字段说一页，文字说全部。**模型信字段。**

#### 要求

**`PatternFinding.page` 类型从 `number` 改成 `number | null`**，两条跨页判据返回 `null`。

**`"整份"` 分支已经存在**（`documentToolRuntime.ts:449`），只是没有判据返回过 `null`。

**同时改 message**：

| 判据 | 现在 | 改成 |
|---|---|---|
| `header.bar` | 「每一页的同一位置都有同样一块」 | **「第 1、2、3、4 页**的 (x,y,w,h) 位置都有同样一块」 |
| `layout.repeated` | 「第 1–3 页构图相同」 | **「第 1–3 页构图相同（这三页请改成不同构图）」** |

**渲染结果**：

```
- [warning] header.bar · 整份：第 1、2、3、4 页的 (0,0,1280,56) 位置都有同样一块……
- [warning] layout.repeated · 整份：第 1–3 页构图相同（这三页请改成不同构图）……
```

**字段「整份」+ 文字列出具体页号** —— 两者不矛盾。

#### 断言

- 造 4 页都有页眉条的 spec → 断言渲染出「整份」且 message 含「第 1、2、3、4 页」；
- 造 3 页同构的 spec → 断言渲染出「整份」且 message 含「第 1–3 页」。

### 三、文件名渲染：模型要的是能直接打开的文件名

**现状**：`第 ${f.page + 1} 页` —— 模型要自己换算成 `pages/NN.json`。

**A 的实测**：`documentToolRuntime.ts:298157` 的上游 `listPageFiles` 排序规则与本地**曾经**不一致（B 已修），但**文件名映射仍然没有**。

#### 要求

`readDeckPatterns` **已经记了 `names[]`**（已排序、已过滤）。把它传给渲染层，用 `names[f.page]` 得到真实文件名。

```ts
// PatternCheckOutcome 加一个字段
interface PatternCheckOutcome {
  ...
  /** 与 `checkDeckPatterns` 的 page 索引一一对应的文件名。 */
  pageFiles: string[];
}
```

渲染时：

```ts
const where = typeof f.page === "number" && outcome.pageFiles[f.page]
  ? `pages/${outcome.pageFiles[f.page]}`
  : "整份";
```

**注意分层**：`checkDeckPatterns` **不用知道文件名**（纯函数保持纯），映射留在调用方。**这是 A 的建议，总控认可。**

#### 断言

- 页名 `07.json`（故意不连续）→ 断言渲染出 `pages/07.json`，不是「第 1 页」；
- **数字序 + 文件名一起验**：`1.json / 2.json / 10.json`，第二个坏 → 断言渲染出 `pages/2.json`。

## 验收判据

1. **fail-closed**：坏 JSON / 形状不符 → `checked: false` 且 findings 为空；正常 → `checked: true`。
2. **`page: null`**：`header.bar` / `layout.repeated` 返回 `null`，渲染成「整份」+ 具体页号。
3. **文件名渲染**：`pages/NN.json` 出现在正文里。
4. **三条各有一对正控/负控**。
5. **变异验证**（每条一个）：
   - 把 fail-closed 改回 `continue` → 负控红 → `cmp` 还原；
   - 把 `page: null` 改回 `page: 0` → 断言红 → 还原；
   - 把文件名渲染改回 `第 N 页` → 断言红 → 还原。
6. `t73-pattern-wiring-smoke` 全绿（含新增断言）。
7. T43 57/57、T47 27/27、T65 40/40 不回归。
8. 双包 typecheck 通过。
9. **不跑全量**、**不起 Electron**。

## 边界

- 只改上列三个文件；
- **不动 `closure()` / `smokes-for`**（那是 T78）；
- **不改 `layout.card-whitespace` 的阈值或等级**（那是 E 的 T75 定下的）；
- 不碰 T63 / T43 / T47 套件。

## 遇到问题先检索

`genoffice guide slides spec` 的页面文件命名规则先读一遍——**为什么是「一个文件一页」，不是「一个文件多页」**。

## 提交

`git add <明确路径>` + `git commit -m "<信息>" -- <明确路径>`。**`-m` 在 `--` 前面。**
末尾加 `Co-Authored-By: Claude Fable 5.0 <noreply@anthropic.com>`。

## 回写

`tasks/T79-t73-missing-three.md` 末尾追加 `## 结果回写（2026-10-23）`：
三条各自的改前/改后、断言、变异结果、各套数字、提交 SHA。
