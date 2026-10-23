# T47｜模型拿不到 `guide slides design` —— 设计流水线的"教"这一半还是断的

- Status: done（2026-10-23 验收通过：27/27，提交 0bf8a957 + 3e7a9903）
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

## 结果回写（2026-10-23）

### 0. 一句话结论

**缺陷成立且已修。** 模型现在有一条真实可达的路拿到 `guide slides design`
（12,231 字符的完整方法论），`build_deck` 的报错文案也指向那个入口。
提交 **`0bf8a957`**。新套件 **27/27**，变异让 10 条断言变红。

### 1. 缺陷复现（卡判据 1）

**复现方法**：把 `documentToolRuntime.ts` 打包，用生产端口直接调
`documentToolDescribe({tool:"build_deck", app:"slides"})`，检查正文里有没有设计规范的关键标记。

**复现结果（修之前）**：

```
ok: true  chars: 2845
--- 设计规范的关键标记 ---
  有  style.md            ← 只是工具说明里顺带提到的
  有  outline.json        ← 同上
  无  cover_typography_hero      ← 18 种布局名一个都没有
  无  treat as defects           ← 反模式清单整段没有
  无  Express hierarchy          ← 反模式给的替代做法没有
  无  CJK                        ← 排版数值没有
```

**根因确认（三层）**：

| 层 | 事实 |
|---|---|
| CLI | `guideOps(ports, domain, op)` 拼 `["guide", domain, "--json", op]` —— **支持**任意子域 |
| 调用点 | `documentToolDescribe` 传的是 `entry.name`（`load_guide` / `apply_ops`），**不是 `design`** |
| 兜底分支 | `build_deck` 没有 `"apply"` 路由 → 走 `else if (domain !== null && cliOp !== undefined)` → 取**整个 slides guide 的前 4000 字**，正好在反模式清单之前截断 |

**对照实测**：`genoffice guide slides design --json` 的 `summary` 是 **12,231 字符**。

### 2. 修法选择与论证（卡判据「两种做法选一并论证」）

**选 (A)：新增 `document_guide({app, domain, topic})`。**

理由（按重要性）：

1. **`describe` 已经快撑满了**：它现在输出 ~2.8 KB，再塞 12 KB 会让**每一次**工具查询都变贵 ——
   而模型查 `read_blocks` 时根本不需要设计规范。guide 是按需取的。
2. **可发现**：模型可以先不带 `topic` 问「这个域有什么」，再取需要的子域。
   塞进 describe 则只能在查特定工具时被动拿到。
3. **覆盖面更广**：`document_guide` 同时服务 `docs` / `sheets` 的 group guide，
   不只是 slides。卡的选项 (B) 只能覆盖 `build_deck` / `plan_deck`。
4. **不截断**：`describe` 的 4000 字上限**正是**这次缺陷把反模式清单切掉的原因。
   新工具返回原文（12 KB），要分段的调用方自己按 `chars` 决定。

**安全**：`topic` 过白名单正则 `^[a-z][a-z0-9_]{0,63}$`，`domain` 过固定映射表
（`docs|slides|sheets|sheet`）—— **不把 CLI 的 argv 交给模型**。只读、不碰文件，
走与其它命令同一条 `invoke`（不继承宿主环境、限时、限输出）。

### 3. 三处改动

| 位置 | 改了什么 |
|---|---|
| `documentToolRuntime.ts` | 新增 `documentGuide(...)` + `GUIDE_DOMAINS` / `GUIDE_TOPIC_PATTERN` / `GUIDE_TOPIC_HINTS`；`build_deck` 的拒绝文案改为指向 `document_guide` 并给出五步 |
| `appControl/tools.ts` | `appMcpTools()` 新增 `document_guide` 工具（描述里点名 design 规范的价值与反模式清单）；`document_tool_call` 的描述补上 `build_deck` 的完整五步（含「最多两轮修」） |
| `scripts/t47-design-guide-smoke/` | 新套件 27 条 |

### 4. 断言做法（卡判据 2/3/4）

| 判据 | 套件里怎么断言 |
|---|---|
| 2. `document_guide({app:"slides",topic:"design"})` 正文含 style.md 与 outline.json 的要求 | **7 个内容标记**逐个断言：`style.md`、`outline.json`、`cover_typography_hero`、`treat as defects`、`thin vertical accent bar`、`CJK`、`two fix rounds`；再断言 `chars > 8000`（证明没被 4000 字截断） |
| 3. `build_deck` 报错指向真实可达入口 | 读拒绝文案：`includes("document_guide")` **且** `!includes("设计流水线的规范在 \`guide slides design\`")` **且**含 `style.md`/`outline.json`/`build_deck` 三词 |
| 4. 工具描述里有完整步骤 | 读 `tools.ts` 源码里 `document_guide` 与 `document_tool_call` 两块的 description，断言含 design / 反模式 / build_deck / style.md / outline.json / 两轮 |

**另外四条负控**：非法 `domain`、非法 `topic`（`../secrets`）、CLI 不认的 `topic`、
以及「拒绝时给出可用 topic」—— 全部要求**显式报错**，不静默返回空。

### 5. 变异证据（卡判据 5）

```
bash scripts/t47-design-guide-smoke/run.sh                      → 27/27
bash scripts/t47-design-guide-smoke/run.sh --mutate=no-topic    → 10 条红
```

变异内容：让 `documentGuide` **不把 `topic` 传给 `guideOps`** —— 这正是原缺陷的形态。

变红的具体断言（全部报 `chars: 2558`，即顶层 guide 的长度）：

```
FAIL 正文含 style.md 的要求
FAIL 正文含 outline.json 的要求
FAIL 正文含 18 种布局之一（cover_typography_hero）
FAIL 正文含 反模式清单标题（treat as defects）
FAIL 正文含 竖条反模式原文（thin vertical accent bar）
FAIL 正文含 CJK 排版数值
FAIL 正文含 两轮修纪律（two fix rounds）
FAIL 正文远超 4000 字（未被截断）
FAIL 正文含画布尺寸（1280）
FAIL 正文含元素类型（text / image / shape 之一）
```

**2558 这个数字本身就是证据**：它恰好等于「拿错子域时返回的长度」，
而正确路径是 12,231 —— 两者相差 4.8 倍，所以这条变异不可能「红得模棱两可」。

### 6. 回归与门禁

| 项 | 结果 |
|---|---|
| `t47-design-guide-smoke` | **27/27** |
| `t43-document-ai-design-pipeline-smoke` | **57/57**（T43 不回归） |
| `t24-document-tool-surface-smoke` | **59/59** |
| `app-control-smoke` | **574/574** |
| `packages/contracts` typecheck | 通过 |
| `apps/desktop` typecheck | 通过（排除他人正在改的 `RightPanel.tsx` / `CommandPalette.tsx` / `i18n/*` / `moduleCatalogShape.tsx` / `electron-u1/driver/runner.ts`，逐条确认与本卡无关） |

### 7. 过程中修掉的一个真 bug

`documentGuide` 第一版写的是：

```ts
const detail = guide.envelope.detail as { ops?: unknown } | null;
```

CLI 的 `guide slides design` 信封**没有 `detail` 字段**，所以 `detail` 实际是
`undefined`，`Array.isArray(undefined.ops)` 抛 `TypeError` —— 套件第一条断言就崩了。
改成 `(guide.envelope.detail ?? null) as ...`。**这是类型断言骗过了编译器、
但运行时形状不符的典型**，只有真跑才看得见。

### 8. 卡号

按卡里的要求把编号从 T46 改成 **T47**（标题、`tasks/README.md` 索引均已更新；
文件名原本就是 `T47-*.md`）。A 的审批卡 U1 继续用 T46。

### 9. 没做的（如实）

1. **没有把 design 规范预置进 `document_apps` 的输出** —— 那会让每个会话都背 12 KB，
   且与「按需取」的设计相悖。
2. **没有做 op 级 guide 的自动补全**（例如模型查 `insert_content` 时自动附上该 op 的
   guide）。`describe` 已经对 `apply` 路由这么做了，本卡没有扩大范围。
3. **没有验证真 Electron 里模型能否真的调用 `document_guide`** —— 那需要真模型回合，
   归 T7/T30 那类卡；本卡证明的是「入口存在且返回正确内容」。

### 10. 复现

```bash
cd apps/desktop
bash scripts/t47-design-guide-smoke/run.sh                     # 27/27
bash scripts/t47-design-guide-smoke/run.sh --mutate=no-topic   # 期望 10 条红
```
