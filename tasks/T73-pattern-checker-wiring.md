# T73｜反模式检查器没有接进模型链路：`checkDeckPatterns` 生产代码零调用

- Status: delivered（2026-10-23，见末尾回写）
- Category: **产品缺陷（能力已造好但接不上）**
- Priority: **P0** —— 用户抱怨的「AI 做 PPT 又烂又丑」，这一块修好了却没人能用
- Depends on: T65（`f6acf173`，检查器）、T69（`d382ce87`，阈值校准）、T43（`0a2aa805`，build_deck 链路）、T72（措辞改参考线，**并行中**）
- Exclusive writable files: 见「边界」小节（**必须与 E 的 T72 不撞**）

## Required Skills
- `mcode-smoke`：给接线补回归断言。
- `codebase-design`：判断接在哪一层（模型工具面 / build_deck 门禁 / 两者）。

## 背景：能力造好了，但没人调它

```bash
$ grep -rn "checkDeckPatterns" apps/desktop/src/ --include=*.ts | grep -v deckPatternCheck.ts
（零条）
```

**`checkDeckPatterns` 是纯函数，22/22 全绿，判据有正控负控，阈值有实测校准 —— 但生产代码里没有任何地方调用它。**

T65 卡里 E 论证了「不暴露成 `document_check_patterns` 工具」，理由是：

> 模型每写一页就能自己看到这些提示，多一个工具反而增加它要读的 schema。

**这个理由不成立。** 模型看不到 —— 检查器的输出**从来没有出现在任何模型能读到的地方**。它不是一个「模型自己会看到的提示」，它是一个**没人调用的函数**。

### 这正好对应 T62 的原始发现

T62 回写区说：

> `audit` 能抓出界、溢出、重叠，**但抓不到「卡片下半截空着」**。我那三根「空柱子」在所有检查里都是零问题。

T65 把「空柱子」做成了判据。**但模型写 spec 的时候，仍然不会被任何东西告知「你这页只铺了 66.7%」。**

## 任务

### 第一步：先论证接在哪一层（**这是本卡的核心，不要跳**）

三个候选，逐条论证优劣，选一个并说明**为什么不选另外两个**：

| 方案 | 做法 | 优点 | 风险 |
|---|---|---|---|
| **A. `build_deck` 门禁** | 在 `documentToolRuntime.ts` 的 `build_deck` 分支里，`createDeckFromSpec` **之前**读 spec 目录的 `pages/*.json`，跑 `checkDeckPatterns`，把 findings 塞进返回的 `detail` | 模型已经在这条链路上了，零新增工具 | 只覆盖 build 时刻，模型**写完一页就 check** 的时候看不到 |
| **B. 独立工具 `document_check_patterns`** | 新工具，模型主动调 | 每次写完一页就能查，符合设计流水线「逐页 check」 | 新增一个工具要读 schema（E 反对的理由） |
| **C. 接进 `slides check` 的返回** | 模型调 `slides check` 时（CLI 承载）附上反模式 findings | 零新增工具 + 逐页可用 | `slides check` 走 CLI，返回形状是 CLI 的；Mcode 侧要**额外读 spec** 才能算 |

**我倾向 C 或 A+C**，但**由你论证后决定**。判断依据：

- T62 实测的流程是「写页 → `slides check` 逐页 → create」；
- 如果接在 `slides check`，模型**在写下一页之前**就能看到；
- 如果只接在 `build_deck`，模型已经写完全部页了，改起来成本高。

**论证要求**：说清楚「模型在哪一步能拿到这条信息」，以及「如果它不看，会怎样」。

### 第二步：接线

按你选的方案实现。**硬要求**：

1. **不要新增第二套判据** —— 只用 `checkDeckPatterns`，不许重写；
2. **失败要显式** —— 读 spec 失败 / 页面 JSON 解析失败时，要么当作没有 findings 继续（并在返回里说明），要么明确拒绝。**不许静默跳过**（CLAUDE.md 硬规矩 3）；
3. **不影响现有行为** —— `build_deck` 成功时仍然成功；findings 是**附加信息**，不是新的拒绝条件（除非你能论证某条必须是 error）。

### 第三步：断言

**必须有断言证明「模型能看到」**：

```ts
// 反面：如果只断言 checkDeckPatterns 本身能算出来，那 T65 已经验过了
// 正面：断言经过 documentToolCall / slides check 的返回里，真的带着 findings
```

还要有：
- **正控**：合规的 spec → 返回里没有该条 finding；
- **负控**：内容只铺 60% 的 spec → 返回里**出现** `layout.whitespace`。

**这是本卡最重要的断言**：它证明「能力真的到得了模型」，而不是「函数算得对」。

## 验收判据

1. **接线方案的论证**（表格 + 结论 + 为什么不选另外两个）。
2. 接线实现，且 **`checkDeckPatterns` 有生产调用点**（`grep` 能证明）。
3. **正控 + 负控**：合规 spec 不报、空页 spec 报，且**都经过真实调用路径**（不是直接调纯函数）。
4. **变异验证**：
   - 撤掉接线（把调用注释掉）→ 负控必须红 → `cmp` 还原；
   - 把 `checkDeckPatterns` 的返回丢掉（`const findings = ...; return` 不带上）→ 负控必须红 → 还原。
5. T43 57/57、T47 27/27、T65 22/22 不回归。
6. 双包 typecheck 通过。
7. **不跑全量**、**不起 Electron**。

## 边界

⚠️ **E 正在并行做 T72，改的是 `deckPatternCheck.ts` 与 `t65-deck-pattern-smoke/main.ts`。**

**你的可写文件集**：

- `apps/desktop/src/main/document/documentToolRuntime.ts`（build_deck 分支 / slides check 分支）
- `apps/desktop/src/main/document/documentToolSurface.ts`（若方案 B，加工具定义）
- `apps/desktop/src/main/appControl/tools.ts`（若方案 B）
- **新建** `apps/desktop/scripts/t73-pattern-wiring-smoke/`

**不可写**（E 的边界）：

- `apps/desktop/src/main/document/deckPatternCheck.ts`
- `apps/desktop/scripts/t65-deck-pattern-smoke/main.ts`

**开工前先 `git status` 确认 E 提交了**（`deckPatternCheck.ts` 应当无未提交改动）。如果还有，**等它交完再动**——两个会话改同一文件必炸。

**其他边界**：
- 不碰 `genoffice/` 上游；
- 不碰 T43 / T47 套件；
- 不碰 `policy.ts`、`ipc/index.ts`、`renderer/`。

## 遇到问题先检索

- `checkDeckPatterns` 的输入形状读 `deckPatternCheck.ts:379`；
- `DeckPageSpec` 的字段读 `genoffice guide slides spec`；
- 先 `grep -rn "slidesCheck\|documentToolCall"` 搞清楚现有调用链，不要凭猜。

## 提交

`git add <明确路径>` + `git commit -m "<信息>" -- <明确路径>`。**`-m` 在 `--` 前面。**
末尾加 `Co-Authored-By: Claude Fable 5.0 <noreply@anthropic.com>`。

## 回写

`tasks/T73-pattern-checker-wiring.md` 末尾追加 `## 结果回写（2026-10-23）`：
方案论证表 + 结论、接线位置与理由、正负控结果、变异证据、四套数字、提交 SHA。

## 结果回写（2026-10-23）

### 一、接在哪一层：选 A（`build_deck` 门禁），不选 B、不选 C

| 方案 | 模型在哪一步能拿到 | 为什么不选 |
|---|---|---|
| **A. `build_deck` 门禁** ✅ | build 完成的那一次返回里 —— 模型**一定会**拿到（它就是来要文件的） | 选它 |
| **B. 独立工具 `document_check_patterns`** | 模型**主动**调才拿到 | ① 卡上引的 E 的理由（多一个 schema 要读）在这个仓库成立：工具面已有 140 条；② 更硬的理由：**它不能证明能力到得了模型** —— 新工具的「已验证」只能靠模型自觉调用，而缺陷恰恰是「没人调」；③ 加工具要动 `documentToolSurface.ts` 与 `appControl/tools.ts`，边界更大 |
| **C. 接进 `slides check` 返回** | 逐页、写下一页前就能看到 | **这条路不存在**：`CLI_TOOL_MAP.slides` 里没有 `check`（只有 `read` / `apply` / `edit_chart` / `guide` / `build_deck`），`slidesCheck()` 在 `genofficeCli.ts:506` 是**零调用点**的导出。选 C 等于**先凭空造一条新链路**再把 findings 挂上去，工作量与风险都大于 A，却并没有让「逐页可用」变成真的 —— 因为造出来的那条链路同样没有任何生产调用方会走 |

**代价（A 的确定缺陷）**：模型只有在**全部页写完、build 完**才看到。改起来比逐页改贵。

**为什么仍然接受**：`build_deck` 的返回里已经带 `render` 的 PNG 路径与 `audit` 的 issues —— 设计流水线本来就把「build → 看图 → 修」当作一轮，findings 加进这一轮不改变流程形状；而 C 需要新建一条模型从未走过的路。

**「如果它不看会怎样」**：findings 在**正文**里（不是 detail JSON，见第三节），和 `输出：xxx.pptx`、QA 门禁同处一段；模型要读「文件造好了没有」就必然读到它。这不是「一定会遵守」，但它不是一条可以忽略的旁路。

### 二、接线位置

`apps/desktop/src/main/document/documentToolRuntime.ts`，`buildDeck()` 里三处：

1. **`snapshotDeckSpec` 之前**：`const patternCheck = readDeckPatterns(ports, specDir);`
   —— 读**源** spec 目录（快照在 `finally` 里会被删，且源目录刚被 `snapshotDeckSpec` 校验过存在）；
2. **`createDeckFromSpec` 之后**：`return { result: withPatternFindings(result, patternCheck), mutated: result.ok };`
3. **`envelopeText()` 里新增一行** `patternFindingsText(env.detail)`。

**新增函数**：`readDeckPatterns`（读页 → 跑检查）、`asPageSpec`（形状归一）、`withPatternFindings`（挂到 `detail`）、`patternFindingsText`（渲染进正文）。

**硬要求逐条**：

1. **没有第二套判据** —— 只调 `checkDeckPatterns(pages)`，`grep` 证明（见第四节）；
2. **失败显式** —— 三种没跑成的情形都进 `notes`：目录读不到 / 没有 `.json` / 全部解析失败；`patternChecked: false` 时正文打印 `⚠️ 反模式检查**没有执行**：<原因>`。另外**页文件被跳过**（形状不符、解析失败）而其余页照常检查时，正文追加 `⚠️ 有页面文件没被检查：02.json 不是页面 spec…`；
3. **不影响现有行为** —— `createDeckFromSpec` 失败时 `withPatternFindings` 原样返回 `result`（`if (!result.ok) return result`）；成功时也**不改** CLI 原有字段，只加 `detail.pattern*`。

### 三、发现的第二个缺陷（本卡真正的坑）

**第一次接完，断言 6/13 全红。** 原因不是检查器算错，而是：

```ts
function envelopeText(result: GenofficeResult): string {
  return [env.summary ?? …, env.output_path ? … : ""].filter(Boolean).join("\n");
  //      ↑ 只取这两项，`detail` 整段被丢掉
}
```

`withPatternFindings` 把 findings 挂到 `envelope.detail` 上 —— **而 `envelopeText` 从不读 `detail`**。模型拿到的是 `created xxx.pptx (1 slides)\n输出：…`，findings 一个字都看不到。

**这正是本卡缺陷的第二层**：即使接上了调用，只要输出路径是「渲染两行正文」，挂 detail 就等于没接。修法是新增 `patternFindingsText(env.detail)` 把 `pattern*` 渲染成几行（只渲染这几项，不倒整个 detail）。

**这个坑值得记住**：`detail` 是给**代码**读的结构化字段，`text` 才是给**模型**读的。任何「让模型看到」的改动，断言必须打在 `text` 上。

### 四、生产调用点（`grep` 证明）

```
$ grep -rn "checkDeckPatterns" apps/desktop/src/ --include=*.ts | grep -v deckPatternCheck.ts
documentToolRuntime.ts:81:  import { checkDeckPatterns, type DeckPageSpec, type PatternFinding } from "./deckPatternCheck.js";
documentToolRuntime.ts:762: *   - `readDeckPatterns`：…并跑 `checkDeckPatterns`；
documentToolRuntime.ts:823:  const report = checkDeckPatterns(pages);
```

`readDeckPatterns` 的唯一调用点是 `buildDeck`（第 720 行），`buildDeck` 由 `executeCliTool` 的 `slides.build_deck` 分支调用。

### 五、正负控（真实调用路径：`documentToolCall({tool:"build_deck"})` → 真 CLI 造 pptx）

套件：`apps/desktop/scripts/t73-pattern-wiring-smoke/`，**22/22 通过**。

| # | 场景 | 断言 |
|---|---|---|
| 1 | **负控**：内容只铺到 68%（490/720） | 正文出现 `layout.whitespace` + `第 1 页内容底边只到画布高度的 68%` + `发现 0 个 error / 1 个 warning` + `pages/NN.json` 的可执行提示；**build 仍成功** |
| 2 | **正控**：内容铺到画布底部 | 正文是 `✅ 反模式检查未发现问题。`，且**不含** `layout.whitespace`、不含「没有执行」 |
| 3 | 负控：`pages/` 空的 | build 失败，且**不声称**检查通过 |
| 4 | 页文件形状不符（CLI 会丢掉它继续建） | build 仍成功；正文点名 `02.json` 没被检查 |
| 5 | 两页、坏页在第二个文件 | 报**第 2 页**；合规的第 1 页不被误报 |
| 6 | 页名不补零 `1/2/…/10` | 坏页仍报**第 2 页**（数字序，字典序会报成第 3 页） |

第 6 条是本卡第二次自我纠正：**第一版用 `01/02/…/10` 补零命名，那样字典序和数字序结果相同 —— 10 页全绿，什么都没验。**

### 六、变异验证（三次，`cmp` 还原）

| 变异 | 做法 | 结果 | 还原 |
|---|---|---|---|
| 1. 撤掉接线 | `const patternCheck = readDeckPatterns(...)` 换成空 outcome | **11/22**（11 红） | `cmp` 逐字节相同 |
| 2. 丢掉返回 | `withPatternFindings(result, patternCheck)` → `result` | **11/22**（11 红） | `cmp` 逐字节相同 |
| 3. 撤掉正文渲染 | `patternFindingsText(env.detail)` → `""` | **11/22**（11 红） | `cmp` 逐字节相同 |

**三次变异都先确认改动在磁盘上**（`grep MUTATION-n`），不是「脚本写完就红」。

**变异 1 暴露了一条名不副实的断言**：第 1 节原本叫「正文里有反模式检查的结论（**证明检查真的跑了**）」，`sawCheckRan` 对 `反模式检查**没有执行**` 也返回 true —— 变异 1 下「检查没跑」它照样绿。已改名为「正文里有一条关于反模式检查的结论（不静默）」，并在注释里写明它**故意**三种情况都绿，由 `layout.whitespace` 与「未发现问题」两条分工证明「跑了」。

### 七、回归与门禁

| 套件 | 结果 |
|---|---|
| `t73-pattern-wiring-smoke` | **22/22** |
| `t43-document-ai-design-pipeline-smoke` | **57/57** |
| `t47-design-guide-smoke` | **27/27** |
| `t65-deck-pattern-smoke` | **40/40**（卡上写 22/22，T72/T75 之后已扩到 40） |
| `tsc --noEmit`（desktop） | **exit 0** |
| `tsc --noEmit`（contracts） | **exit 0** |

未跑全量、未起 Electron。

### 八、没做的事 / 我认为不对但没改的

1. **B 方案被否不是因为它错，而是因为它不能自证**。如果将来用户抱怨「等 build 完才知道太晚」，B 仍然是正解 —— 那时它和 A 可以并存（A 作兜底，B 作提前量），而不是二选一。
2. **`slidesCheck()`（`genofficeCli.ts:506`）仍是零调用点**。C 方案要成立需先给它一条工具路由（`CLI_TOOL_MAP.slides.check` + `slides check` 的分页参数 + 返回形状转换），这是另一张卡的量级，本卡没做。
3. **`layout.whitespace` 目前是 `warning`，不阻断 build**。卡里允许我论证某条该是 error，我没有论证：T62 的原始问题是「丑」，而「丑」不该让文件造不出来 —— 用户拿到一个可修的 pptx 比拿到一句拒绝有用。这条我保留现状，但如果产品要更强的门禁，应该改的是 `DOCUMENT_QA_GATES` 而不是检查器。
4. `documentToolRuntime.ts` 我动了 `envelopeText` 一处 —— 它同时被 `docs`/`sheets` 的返回复用（第 967、1118 行）。`patternFindingsText` 对没有 `pattern*` 字段的 detail 返回空串，所以 `docs`/`sheets` 的正文**逐字节不变**；T43(57) 与 T24 的既有断言都没红，可作旁证。**但这一点没有专门的断言盯着**，只有既有套件兜着。

### 九、提交

`<SHA 见提交>` —— 只含 `apps/desktop/src/main/document/documentToolRuntime.ts` 与新建的 `apps/desktop/scripts/t73-pattern-wiring-smoke/`。

⚠️ 工作区里还有另一个会话在途的 `apps/desktop/src/main/appControl/tools.ts`（T55 的改动，未提交），**没有**被卷进本次提交。
