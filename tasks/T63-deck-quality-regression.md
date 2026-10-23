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
- **反向**：故意写一个超出画布的 element → **audit 必须报出来**。

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
