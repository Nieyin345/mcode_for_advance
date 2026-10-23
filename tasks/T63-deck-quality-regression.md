# T63｜把 PPT 产出质量固化成回归断言

- Status: **blocked-on-T62**（等 T62 的验收结果决定断言写什么）
- Category: test（回归网）
- Priority: P1
- Depends on: **T62**（端到端验收）、T43（`0a2aa805`）、T47（`0bf8a957`）
- Exclusive writable files: `apps/desktop/scripts/t43-document-ai-design-pipeline-smoke/`（扩充）或新建 `t63-deck-quality-smoke/`。

## Required Skills
- `mcode-smoke`: 建回归 + 变异验证（**必须有对照组**）。

Read before work: `CLAUDE.md`（**尤其是「任何断言的价值都不超过它取证方法的正确性」与「注释里也有没人验的断言」两节**）、`tasks/T43-document-ai-design-pipeline.md` 回写区、`tasks/T62-doc-ai-end-to-end-acceptance.md` 的**回写区（T62 完成后才有）**、`genoffice/skills/genoffice/SKILL.md` 的 `## Designing a deck`。

## 背景

T43 的套件（57/57）验的是：六格式读取、门禁真跑、create 路线、pptx 围栏可达。
T47 的套件（27/27）验的是：`document_guide` 返回的设计规范内容。

**但没有任何断言在验「产出的 PPT 是不是按规范做的」。**

## 任务

### 第一步：读 T62 的结果

**T62 会回答**：
- 整条流程能不能走通；
- 产出有没有反模式；
- `detail.audit` 报了什么；
- 最该改的是什么。

**你的断言要覆盖 T62 发现的问题。**

### 第二步：设计断言

**候选（按 T62 的结果取舍）**：

1. **`detail.audit` 必须为空**（或只有白名单内的 advisory）——这是几何审计，**能出图就能验**；
2. **`detail.style.offPalette` 必须为空**——用色必须在 style sheet 里；
3. **build 出来的 deck 能再读回**（`slides read`），且页数与 outline 一致；
4. **`render` 产出的 PNG 非空且尺寸正常**。

**如果 T62 发现「反模式仍然存在」**（比如模型没用规范里的 layout），那要加一条：
5. **spec 里的 layout 名必须在规范列出的 18 种之内**。

### 第三步：必须有对照组

**这是本卡最重要的要求。** T24 的 59/59 全绿却漏掉 T40，就是因为它没有对照组。

**至少两条**：
- **正向**：合规的 spec → audit 空、offPalette 空；
- **反向**：**文字溢出** → **audit 必须报 `out_of_bounds`**。

#### ⚠️ 反向用例的构造：我卡上原来写错了（A 会话实测纠正，总控复现）

**原来写「故意写一个超出画布的元素 → audit 必须报出来」——这条不成立：**

- **完全出界的元素在 `create` 阶段就被丢弃**，根本到不了 `audit`：
  ```
  create → error: "...(element 0: outside the 1280x720 canvas, dropped)"
  ```
- **部分出界会被 clamp**，`audit` 也不报。

**真正能让 `audit` 报的是文字溢出**（小盒子塞大字号长文本）——**总控已复现**：

```json
// 夹具：{"type":"text","x":80,"y":60,"w":200,"h":40,"paragraphs":[{"runs":[{"text":"<40 字长文本>","sizePt":40}]}]}
"audit": {
  "counts": {"error": 1, "warning": 0},
  "issues": [{
    "code": "out_of_bounds",
    "level": "error",
    "message": "...556px past the bottom edge",
    "box": {"x":80,"y":60,"w":200,"h":1216}
  }]
}
```

**builder 会把盒子撑高到容纳文本，于是越下边界。** 干净 deck 的对照是 `"1 slide(s), no layout issues"`、`counts:{error:0,warning:0}`。

**反向那条是判别力的证明。** 没有它，正向那条可能是空过的。

### 第四步：变异验证

**撤掉关键断言 → 必须红 → `cmp` 还原。**

## 验收判据

1. **回写区说明你的断言覆盖了 T62 的哪些发现、没覆盖哪些、为什么。**
2. **有正向 + 反向对照组**（反向能证明断言有判别力）。
3. 变异验证：撤掉断言 → 红 → `cmp` 还原。
4. T43 的 57/57、T47 的 27/27 不回归。
5. 双包 typecheck 通过。
6. **不跑全量**（按用户规矩，全量由总控执行）。

## 边界

- 只碰 `apps/desktop/scripts/t43-document-ai-design-pipeline-smoke/` 或新建 `t63-*/`；
- **不改产品源码**（如果发现产品缺陷，报告给总控，另开卡）；
- **不起 Electron**。

## 遇到问题先检索

`genoffice slides check` / `slides audit` / `slides read` 的参数先跑 `--help` 确认。

---

## 完整流程规划（执行者补，2026-10-23）

> 卡是规划文档：下面把这项工作**从研究到交付**的每一步写清，每步都写明产出与判过方式。
> 每一步的**前置条件**也写出来——T62 未回时只有第 0 步可做。

| 步 | 做什么 | 产出 | 判过 | 前置 |
|---|---|---|---|---|
| **0. 研究** | 读 T43 套件、`genofficeCli.ts` 的 `slidesCheck`/`slidesAudit`、CLI 的 `slides check`/`audit` 契约；用真实 CLI 造四种形态确认返回形状 | `tasks/T63-*.md` 本节的「覆盖/未覆盖/怎么加」+ 可复跑探针 `scripts/t63-deck-quality-smoke/probe.mjs` | 探针 `9/9 形态符合预期` | **无（已完成）** |
| **1. 定稿断言集** | 读 T62 回写区，决定 A–D 四组里哪些保留、要不要加第 5 条（layout 白名单） | 卡里的「最终断言清单」小节 | 每条都写明「正控 / 负控 / 取证方法」 | 等 T62 |
| **2. 写套件** | 新建 `scripts/t63-deck-quality-smoke/{main.ts,run.sh}`，复用探针的夹具构造 | 可运行套件 | `bash scripts/t63-deck-quality-smoke/run.sh` 全绿 | 第 1 步 |
| **3. 正反控配对** | 每组断言都要有「该为空」与「该报出来」两半 | 套件里的 `★ 反向控` 断言 | 反向控单独看能红（临时把夹具改回干净 deck 即应转绿 → 证明它在验负控） | 第 2 步 |
| **4. 变异验证** | 逐条撤掉关键断言/夹具，确认对应断言变红，`cmp` 逐字节还原 | 卡里的变异表 | 每次「撤 → 红 → 还原 → 绿」 | 第 3 步 |
| **5. 回归** | 跑 T43（57/57）与 T47（27/27） | 两组数字 | 都保持原数 | 第 4 步 |
| **6. 收尾** | 双包 `tsc`、写回卡、提交（显式路径） | 提交 SHA | `tsc` exit 0 | 第 5 步 |

**不跑全量**（用户规矩）；**不起 Electron**；**不改产品源码**——发现产品缺陷就另开临时卡。

### 第 0 步已完成：研究结果

**T43 已覆盖**：七格式读取（`via` 断言）、2 MiB 截断不切半个 UTF-8 字符、pdf/md/html 门禁真跑 render、docx/xlsx create、pptx 围栏（界外/链接/未知扩展/空目录 + 逐字节副本 + 源不被改）、`build_deck` 经 `documentToolCall` 真走 CLI、工具目录无「三不管」。

**T43 未覆盖**（本轮核心缺口）：

1. **`slides check` 从未被调用** —— 第 292 行只是断言**门禁名** `"audit"`；
2. **`offPalette` 从未被断言**；
3. **`slides audit` 的 findings 从未被断言**（同样只断言了门禁名）；
4. **夹具缺 `outline.json` 与 `style.md`** —— 所以大纲一致性与调色板检查**根本不会被触发**。

**怎么加**：新建 `scripts/t63-deck-quality-smoke/`，用 `slidesCheck` / `slidesAudit` 两个**现成生产包装**（`genofficeCli.ts:506` / `:463`）取证，四组正反控配对：

| 组 | 正控（该为空） | 反向控（该报出来） |
|---|---|---|
| **A 几何审计** | 干净 deck → `audit.detail.counts.error === 0` | 文字溢出页 → `counts.error > 0` 且 `issues[].code === "out_of_bounds"` |
| **B 调色板** | 合规页 → `detail.style.offPalette === []` | 越界颜色 → `offPalette` 含 `#FF00AA` |
| **C 大纲一致** | 页与条目一致 → `detail.outline.findings === []` | 页数超出 outline → findings 里有 `level:"error"` |
| **D 可读回** | 产物 `slides read` 能读回、页数与 outline 一致 | （同 A 的溢出 deck 也应能被读回——证明"读回"与"质量"是两条独立判据） |

**全部夹具走 `create --spec`**（同一个 builder 路径），不手改 pptx——手改会绕过 builder，测不到真实链路。

### 可复跑探针（第 0 步交付）

`apps/desktop/scripts/t63-deck-quality-smoke/probe.mjs`

```bash
node apps/desktop/scripts/t63-deck-quality-smoke/probe.mjs          # 人读
node apps/desktop/scripts/t63-deck-quality-smoke/probe.mjs --json   # 机读
```

实测 **9/9 形态符合预期**，覆盖：干净 deck、文字溢出（反向控）、完全出界（记录它会被 create 丢弃）、合规调色板、越界颜色、outline 一致、页数超出。

退出码 0 = 判据形态未变；1 = 判据变了，第 1 步的断言要重写。

---

## 结果回写（2026-10-23）

### 1. 断言覆盖了 T62 的哪些发现

| T62 发现 | 本套件 | 说明 |
|---|---|---|
| 规范「从不是文档，是检查器」：`offPalette` / `outline.findings` / audit 当场报 | **B / C / A 三组** | 各配正控（合规 → 空）+ 反向控（违规 → 报），把「检查器真的在跑」变成机器断言 |
| 每处写错都被抓住（overlap / text overflow / 调色板外色 / 缺单位） | **A3 / B2 / C2 / C3** | 四条反向控分别对应几何、颜色、页数、标题一致性 |
| `audit` 能抓出界、溢出、重叠 | **A1 / A3** | 正控 error=0；反向控 `code === "out_of_bounds"` |
| 产物能读回 | **D1–D4** | 两页 deck 造得出、读得回、页数对得上；另加 D4 证明「有几何缺陷 ≠ 读不回」（两条判据独立） |

### 2. **没**覆盖的（如实记录）

| T62 发现 | 为什么没覆盖 |
|---|---|
| **① 留白过度（「三根空柱子」audit 报零问题）** | 按总控指令 **D' 延后**——E 的 T65 正在做反模式检查器，若它实现了留白检测，这条要从「记录缺口」改成「验证新检查」。**本卡未写 D'。** |
| **② 反模式第 4/6 条（细竖条、装饰方块）** | `slides check` 不实现，无机器判据可断。 |
| **③ 内容页/数据页构图雷同** | 同上，无检查器。 |
| 渲染出的 PNG 视觉效果好不好看 | 需要人眼看图（T62 已手工验），机器只能验几何与调色板。 |

### 3. 正反控对照（判过方式）

| 组 | 正控 | 反向控 |
|---|---|---|
| **A 几何审计** | `干净 deck → audit.counts.error === 0` | `文字溢出 → issues[].code === "out_of_bounds" && level === "error"` |
| **A4/A5 记录** | 完全出界 → **create 阶段即丢弃**；部分出界 → **被 clamp，audit 不报** | （这是记录，不是反向控） |
| **B 调色板** | `合规页 → detail.style.offPalette === []` | `#FF00AA → offPalette 含它` |
| **C 大纲一致** | `页与条目一致 → detail.outline.findings === []` | 页数超出 → `level:"error"`；标题不符 → `level:"error"` 且 message 含 title |
| **D 可读回** | `两页 → detail.slides === 2 且 detail.pages.length === 2`；两页文本都读得回 | `有几何缺陷的 deck 也读得回`（证明两条判据独立） |

全部夹具走 `create --spec`（同一条 builder 路径），未手改 pptx。

### 4. 变异验证（撤证据源 → 真红 → `cmp` 还原）

⚠️ **第一版变异写错了，如实记录**：我把 `overIssues.some(...)` 换成 `true`，套件仍绿 —— 因为同一条断言里 `overflowAudit.ok && (overCounts?.error ?? 0) > 0` 仍在验。**那是变异选点错，不是断言无效。** 改为撤**证据源**：

| 变异 | 撤了什么 | 变红的断言 |
|---|---|---|
| `A3-overflow-fixture` | 溢出文本换成 `"short"` | **A3**（`counts:{error:0}`）+ **D4**（连带，D4 复用同一份溢出 deck） |
| `B2-palette-fixture` | `#FF00AA` 换回 `#111111` | **B2**（`offPalette:[]`） |
| `C2-extra-page-fixture` | 不写第 2 页 | **C2** + **C3**（连带，同一夹具） |

三次都 `cp` 还原后用 `cmp` 确认**逐字节一致**，复跑 15/15。

### 5. 回归与门禁

- `t63-deck-quality-smoke`：**15/15**
- `t43-document-ai-design-pipeline-smoke`：**57/57**（不回归）
- `t47-design-guide-smoke`：**27/27**（不回归）
- 双包 `tsc --noEmit`：**exit 0**
- **未跑全量**（用户规矩）；**未起 Electron**；**未改产品源码**

### 6. 交付

- 新套件 `apps/desktop/scripts/t63-deck-quality-smoke/`（`main.ts` / `run.sh` / `probe.mjs`）
- 本卡

### 7. 提交

- 实现提交：**`e8b245c7`**（3 文件：`main.ts` / `run.sh` / 本卡回写）。
- 探针提交：**`8e0ad5d2`**（`probe.mjs` + 卡上的完整流程规划）。
- 提交后在该 HEAD 上复跑 `bash apps/desktop/scripts/t63-deck-quality-smoke/run.sh` → **15/15**。

---

## 经验：变异要撤「证据源」，不是改「表达式」

> 本卡第一次做变异时踩到的坑，写在这里给下一个人。

### 我踩的那次

断言长这样：

```ts
check("★ A3 反向控：文字溢出必须被 audit 报成 out_of_bounds",
  overflowAudit.ok === true &&
    (overCounts?.error ?? 0) > 0 &&
    overIssues.some((i) => i.code === "out_of_bounds" && i.level === "error"), ...);
```

我把 `overIssues.some(...)` 换成了 `true`，**预期变红 —— 结果套件 15/15 仍然全绿**。

**原因**：同一条断言里还有 `overflowAudit.ok === true && (overCounts?.error ?? 0) > 0` 两个条件在兜底。
它们仍然为真，所以整条断言继续通过。**这不是「断言无效」，是「变异选点选错了」。**

### 正确的做法：撤证据源

改**喂给断言的东西**，而不是改断言里的某个子表达式：

```ts
// 把溢出夹具的文本换成短文本 —— 于是 audit 真的不该再报 out_of_bounds
text: "THIS IS A VERY LONG LINE ...",   →   text: "short",
```

这次三条变异全部真红，且红在**预期的那条断言**上：

| 撤的证据源 | 变红的断言 |
|---|---|
| 溢出文本 → `"short"` | **A3**（`counts:{error:0}`）+ D4（连带：D4 复用同一份溢出 deck） |
| `#FF00AA` → `#111111` | **B2**（`offPalette:[]`） |
| 不写第 2 页 | **C2** + **C3**（连带：同一份夹具） |

### 判断方法（一句话）

**变异后先自问：这条断言里，还有没有别的条件在为它兜底？**
有 → 你这个变异证明不了判别力，换一个撤证据源的。

### 这是同一类错误的第四种形态

| # | 形态 | 表现 |
|---|---|---|
| 1 | 断言前置条件先炸 | `assert count == 1` 在写文件前就 `AssertionError`，文件没改、套件没跑 |
| 2 | 改得不够干净 | 注释掉 vs 整行删除，判别力来自「删干净了」 |
| 3 | 改出的是运行失败 | 改产品实现让 bundle 崩了 —— 那是崩溃，不是断言红 |
| 4 | **选点被同断言内的其它条件兜底** | **本卡遇到的这次** |

四种都指向同一件事：**变异要撤「证据源」，不是「表达式」。**

### 附：本卡另外两处「以为在测 A，实际测到 B」

同一类错误的变体，也记在这里：

1. **C3 最初假红**：只写了第 2 页却没给它 outline 条目 → 先撞上「no outline entry」，
   测到的不是标题一致性。**补上 outline 条目后才真的在验标题不符。**
2. **D2 最初假红**：`slides read` 的 `detail.slides` 是**页数（数字）**，页面数组在
   `detail.pages`。按数组读拿到 0 条 —— 断言红在「读错字段」，不是「读不回来」。

**共同点：断言红了/绿了，但它验的东西不是你打算验的那个。** 所以写断言时，
除了「它会不会红」，还要问「它红的时候，是因为我以为的那个原因吗」。
