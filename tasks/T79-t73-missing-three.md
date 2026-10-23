# T79｜T73 漏派的三条：fail-closed / `page: null` / 文件名渲染

- Status: delivered（2026-10-23，三条已在 4bbf5c5b；本轮补 9c 覆盖缺口）
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

## 结果回写（2026-10-23）

### 零、先纠正一个事实：三条在 `4bbf5c5b` 里已经做了

总控的 grep 是在 `4bbf5c5b` 之前跑的。当前 HEAD 上：

```bash
$ grep -n "page: null" apps/desktop/src/main/document/deckPatternCheck.ts
391:        page: null,      ← layout.repeated
476:        page: null,      ← header.bar
$ grep -n "整体未执行" apps/desktop/src/main/document/documentToolRuntime.ts
837:        `本次反模式检查整体未执行：页序不可信，报出来的页号会指错文件。…`
844:      return empty([`${name} 不是页面 spec（缺 elements 数组）。本次反模式检查整体未执行：页序不可信。`]);
$ grep -n "pageFiles" apps/desktop/src/main/document/documentToolRuntime.ts
447, 792, 797, …
$ grep -n "x=\${Math.round" apps/desktop/src/main/document/deckPatternCheck.ts
331:        `第 ${i + 1} 页 x=${Math.round(card.x ?? 0)} 处的卡片内部下半截空着：` +
```

**三条漏项 + E 的两条，都在 `4bbf5c5b`（`fix(T73): fail-closed page reading, file-name locations, per-card findings`）里。** 那张提交的回写写在 T73 卡的 `## 结果回写（二）— 复核轮`。

**所以 T79 卡本身的三条任务：无新增代码。**

### 一、但总控指出了一条**真的没覆盖**的缺口 —— 这是本轮唯一的新工作

> 你的套件里那条「坏页报第 2 页」，用的是 `{ not: "a page" }`（形状不符），不是坏 JSON —— 它测的是 `asPageSpec` 返回 null 的路径，**没测 `JSON.parse` 抛异常的路径**。

**这条完全成立，而且比它说的更严重**：我的第 9 节原本写「坏 JSON 不影响 build 成功」，跑出来发现 **CLI 自己就拒绝 build**（`CliError: 02.json: invalid JSON`）。于是那条断言变成在验「CLI 拒绝了」，而**我们的 `catch` 分支从未被执行过**——`withPatternFindings` 对 `!ok` 原样返回，所以从外面完全看不出区别。

**两条路径行为相似、代码不同**（一条 CLI 抛、一条我们 `return empty(...)`），只测前者就是「套件绿着但没覆盖」。

#### 补的断言（第 9c 节，4 条）

直接驱动生产的 `readDeckPatterns`（把它从模块私有改成导出，**不是复制一份**）：

```ts
const outcome = runtime.readDeckPatterns(ports as never, broken);
check("★ checked === false", outcome.checked === false);
check("★ findings 为空（一条都不给，避免错位页号）", outcome.findings.length === 0);
check("★ note 点名了坏掉的文件", outcome.notes.some(n => n.includes("02.json")));
check("★ note 说明了「整体未执行」", outcome.notes.some(n => n.includes("整体未执行")));
```

#### 变异 D：把 fail-closed 改回 `continue` → **37/40**

输出逐字复现了卡上描述的缺陷：

```json
{"checked": true,
 "findings": [{"rule":"layout.whitespace","page":1,"message":"第 2 页内容底边只到…"}],
 "notes": ["02.json 解析失败：Unexpected end of JSON input"],
 "pageFiles": ["01.json", "03.json"]}
```

**缺陷在第 3 页，报成 `page: 1`（第 2 页）。** `pageFiles` 只剩两项 —— 这就是「页号错位」的物证。`cmp` 逐字节还原。

### 二、E 的发现：我的改动他的套件一条都没在测

E 实测：我的三条改动（每张卡各报 / x 坐标 / `page: null`）**在他 40/40 的套件下改前改后都绿** —— 40 条断言没有一条在看这三个行为。他自己补了 6 条并提交（`30a5b608`，只动 `t65-deck-pattern-smoke/main.ts`）。

**这是同一类问题的第三次出现**：T65 的 22/22 曾经也没验到 T75 的改动、我的第 6 节补零命名没验到数字序、现在 E 的 40 条没验到我这三条。**「套件全绿」只有在它真的指过目标时才有意义。**

E 还纠正了自己一个变异选点错误（用 `reduce` 取最高卡来模拟「只报一张」，那没表达 bug 的形态；换成 `slice(0, 1)` 才对）。**变异要模拟 bug 的样子，不是让代码随便变差。**

### 三、套件与门禁

| 项 | 结果 |
|---|---|
| `t73-pattern-wiring-smoke` | **40/40**（36 → 40，新增 9c 四条） |
| `t65-deck-pattern-smoke` | **46/46**（E 已扩到 46，内含针对本轮三条改动的新断言） |
| `t43-document-ai-design-pipeline-smoke` | **57/57** |
| `t47-design-guide-smoke` | **27/27** |
| `tsc` desktop / contracts | **exit 0 / exit 0** |

未跑全量、未起 Electron。

### 四、边界

- 只改 `documentToolRuntime.ts`（`readDeckPatterns` 加 `export`）与 `t73-pattern-wiring-smoke/main.ts`；
- `deckPatternCheck.ts` **本轮没动**（E 已确认归我，但他的 `30a5b608` 只动自己的套件，没撞）；
- `closure()` / `smokes-for` 未动；`card-whitespace` 阈值与等级未动。

### 五、提交

`<见提交>` —— `export(T73/T79): let the suite drive readDeckPatterns directly`。
