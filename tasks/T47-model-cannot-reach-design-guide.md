# T47｜模型拿不到 `guide slides design` —— 设计流水线的"教"这一半还是断的

- Status: ready-for-agent
- Category: **bug（P0 产品能力）**
- Priority: **P0 —— 这条决定 T43 修完之后 AI 能不能真的做出好看的 deck**
- Depends on: T43（`0a2aa805`，工具面接通）、T40（`9487eaa4`，渲染端通道）
- Exclusive writable files: `apps/desktop/src/main/document/documentToolRuntime.ts`（`documentToolDescribe` / 新增 guide 入口）、`apps/desktop/src/main/document/documentToolSurface.ts`（目录与描述）、`apps/desktop/src/main/appControl/tools.ts`（工具描述）、新建回归套件。

## Required Skills
- `codebase-design`: 判断 guide 该走「新增工具」还是「扩展现有工具的入参」。
- `mcode-smoke`: 建回归 + 变异验证。

Read before work: `CLAUDE.md`、`tasks/T43-document-ai-design-pipeline.md` 回写区、`genoffice/skills/genoffice/SKILL.md`（**`## Designing a deck` 全节**）、`apps/desktop/src/main/document/genofficeCli.ts:430-436`、`apps/desktop/src/main/document/documentToolRuntime.ts:190-230`。

## 缺陷（总控实测）

### `build_deck` 让模型「先跑 guide slides design」，但模型调不到它

```ts
// documentToolRuntime.ts:524 —— build_deck 的拒绝理由里
"先跑 document_tool_describe({tool:\"build_deck\", app:\"slides\"}) 看完整步骤；" +
"设计流水线的规范在 `guide slides design`（style.md → outline.json → 逐页 NN.json → 逐页 check）。"
```

**问题是 `guide slides design` 这一步模型没有入口。**

### 三层证据

**① `guideOps` 本身支持 `design`**：

```ts
// genofficeCli.ts:430
export async function guideOps(
  ports, domain: "docs" | "slides" | "sheet" | "pdf" | "markdown", op?: string, signal?
) {
  const args = ["guide", domain, "--json"];
  if (op !== undefined) args.push(op);        // ← 拼成 `guide slides design`
  return invoke(ports, args, ...);
}
```

CLI 侧**完全支持**（`genoffice guide --help` 原文：`<slides|docs|sheets> [group|op|design|spec]`）。

**② 但 `document_tool_describe` 传的是工具名，不是 `design`**：

```ts
// documentToolRuntime.ts:204
const guide = await guideOps(ports, domain === "sheet" ? "sheet" : domain, entry.name, ports.signal);
//                                                                              ^^^^^^^^^^ = "load_guide" / "apply_ops"，不是 "design"
```

**③ 所以模型没有任何路径拿到 `design` 子域的内容。**

### 后果：模型拿不到的是**一整套设计方法论**

**总控实跑 `genoffice guide slides design --json`，输出约 6000 字**，内容包括：

- **style sheet 的具体字段**：背景色（每种页面类型一个）、颜色（主色/强调色/次强调色/卡片/边框，`#RRGGBB`）、字体（拉丁与 CJK 分开）、**布局库至少两种每类**；
- **18 种布局名**：`cover_typography_hero`、`cover_split_color`、`three_column_cards`、`hero_big_number`、`timeline_horizontal`、`kpi_cards_row`、`chart_with_insight`……
- **排版数值规范**：
  ```
  一行文字约 sizePt × 1.8 px 高（lineSpacingPct 110）
  一个 CJK 字符约 sizePt × 1.35 px 宽，拉丁约 × 0.7
  文本与卡片边缘 ≥ 8px，标题与副标题 ≥ 20px，堆叠文本 ≥ 5px
  字号：大标题 32-48pt，副标题 18-24，正文 12-15，超大数字至 80
  ```
- **反模式清单（明写「treat as defects」）**：
  ```
  - 每张卡片左侧的细竖条、卡片顶部的色条、标题左侧的小色条
    → "Express hierarchy with background, weight and size contrast."
  - 彩虹卡片：每项一个强调色
  - 装饰性角落方块；每页挪来挪去的装饰
  - 每页都是「形状 + 粗副标题 + 描述」列表
  - 封面是平的标题加副标题（要给视觉锚点）
  - 全篇统一的页眉条
  - 用 emoji
  ```
- **两轮修的纪律**：「At most two fix rounds; then report what remains.」

**「每张卡片左侧的细竖条」正是 AI 做 PPT 时最常见的丑法，而上游把它明列为缺陷。**

**模型拿不到这段，就必然做出用户说的「毫无审美可言」的东西。**

### 这不是「没接线」，是「接了线但没给说明书」

T43 把 `build_deck` 接通了（能造出 deck），**但模型不知道该怎么设计**。

用户的原话「ai 做 html 很出色因为这就是 ai 的训练数据」在这里完全成立：**spec 是 px 定位的 JSON，不是 AI 的训练数据；不给规范，它只能凭感觉摆元素。**

## 目标

### 必须做到

1. **让模型能拿到 `guide slides design`**。两种做法选一并论证：
   - **(A) 新增一个工具** `document_guide({app, topic})`，`topic` ∈ `design` / `spec` / group / op；
   - **(B) 扩展 `document_tools_list`**：加一个 `guide` 动作，或者在 `document_tool_describe` 里对 `build_deck` / `plan_deck` 这类工具**自动附上 `design` 规范**。

   **我倾向 (A)**：它显式、可发现、能覆盖 `docs` / `sheets` 的 group guide，而且不把大段规范塞进 `describe` 的输出里。

2. **`build_deck` 的报错要指向真实可达的入口**。现在它说「跑 `guide slides design`」，但模型够不到。修完后应该说「调 `document_guide({app:"slides", topic:"design"})`」。

3. **把设计流水线的步骤写进工具描述**（`appMcpTools` 里 `document_apps` 或 `build_deck` 的 description）：
   ```
   1. document_guide({app:"slides", topic:"design"})  → 拿到 style.md / outline.json 的规范
   2. 写 style.md + outline.json + pages/NN.json
   3. document_tool_call({tool:"build_deck", input:{specDir, outline, render:true, audit:true}})
   4. 看 detail.previews 里的 PNG，看 detail.audit 里的几何问题
   5. 最多两轮修
   ```

### 明确不做

- **不改** `genoffice/` 上游（CLI 侧已经支持）。
- **不改** `buildDeck` 的围栏逻辑（T43 交付）。
- **不改** `policy.ts`（E 的 T33 正在改）。

## 验收判据

1. **回写区先证明缺陷成立**：实际调一次，看模型能不能拿到 `design` 内容（不能）。
2. **修完后有一条断言**：`document_guide({app:"slides", topic:"design"})` 返回的正文里**包含 `style.md` 与 `outline.json` 的要求**（不是空、不是报错）。
3. **`build_deck` 的报错文案指向真实可达的入口**（有断言，读那段文字）。
4. **工具描述里有完整步骤**（有断言）。
5. **变异验证**：把 `document_guide` 的实现改成不传 topic → 断言必须红 → `cmp` 还原。
6. T43 的套件 53/53 不回归；双包 typecheck 通过。

## 边界

- **不碰** `ipc/index.ts`（E 的 T40 已交付，但保持不动）。
- **不碰** `policy.ts`（E 的 T33）。
- **不碰** `renderer/`（C 的 T34 相关）。
- **不碰** `scripts/genoffice-*-smoke/`（C 的 T44、F 的 T32）。
- **不碰** `electron-u1/`（A 的 T46 正在做）。

**编号说明**：A 同时在做的审批卡 U1 也叫 T46，编号撞了。本卡已按约定改为 **T47**（文件名与标题均已改），并在 `tasks/README.md` 索引里加了行。

## 遇到问题先检索

**报错、API 用法、依赖问题先上网查，不要凭记忆猜。**
动手前**必须**先跑 `genoffice guide slides design` 看真实输出，确认它给的是什么。

## 提交

`git add <明确路径>` 后**立刻** `git commit -m "<信息>" -- <明确路径>`。**`-m` 必须在 `--` 前面。**

提交信息末尾加：
```

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

## 回写

在 `tasks/T47-model-cannot-reach-design-guide.md` 末尾追加 `## 结果回写（2026-10-23）`：缺陷复现、修法选择与论证、断言做法、变异证据、提交 SHA。
