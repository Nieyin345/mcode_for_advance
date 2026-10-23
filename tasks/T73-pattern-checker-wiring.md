# T73｜反模式检查器没有接进模型链路：`checkDeckPatterns` 生产代码零调用

- Status: ready-for-agent
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
