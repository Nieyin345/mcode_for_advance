# W20｜画布删了，死代码还在：`WorkflowNodeCard` 与一批只服务旧画布的残留

- Status: ready-for-agent
- Category: **技术债（会误导人）**
- Priority: **P2 —— 不影响用户，但让每个读代码的人以为「画布还在」**
- Depends on: W3（§8 第 1、2 条）
- 来源：W3 主动报告

## Required Skills
- `codebase-design`：判断哪些是「真的死了」，哪些还有隐性消费者。
- `mcode-smoke`：删之前先跑覆盖它的套件。

## 事实（W3 实测，我复核过）

```bash
$ grep -rn "WorkflowNodeCard" apps/desktop/src/
nodeTypes.ts:1013            ← 注释
WorkflowBoardPanel.tsx:27    ← 注释
WorkflowFlowMini.tsx:124     ← 注释
WorkflowFlowMini.tsx:580     ← 注释
WorkflowLibraryView.tsx:15   ← 注释（而且这行写着「WorkflowNodeCard 是画布专用的」）
WorkflowNodeCard.tsx:146     ← 定义本身
```

**零渲染调用点。** 唯一真的用它的是 `workflow-view-smoke` 在 SSR 里渲染它
（W3 指出：那套套件里有一批断言指着它）。

`WorkflowNodeCard` 依赖的 `workflowLayout.ts`（12976 字节）几何计算、
`onSelect` / `onStartConnect` 那一整套交互，**都不再有生产路径**。

`WorkflowLibraryView` 里还有一批同源残留（W3 提到 `handleSetDependency` 等）。

## 为什么这值得一张卡

**它不是「代码丑」，是「代码骗人」。**

`WorkflowLibraryView.tsx:15` 的注释原文写着：

> 列表放在左侧栏底部而不是再造一块画布：**`WorkflowNodeCard` 是画布专用的**（今天…

**下一个读到这行的人会以为画布还在。** 而它已经删了四天（T45 / `351e4d9b`）。

这正是 CLAUDE.md 第七条：**注释里的绝对陈述，要么可验，要么别写**。

## 任务

### 一、先分清三类，别一刀切

| 类别 | 判据 | 怎么做 |
|---|---|---|
| **A. 真的死了** | 生产代码零调用，且**没有任何套件在验它** | **删** |
| **B. 只被套件守着** | 生产零调用，但套件在验它 | **两件事一起做**：删代码 + 删/改那些断言。**不能只删代码**（套件会红）**也不能只删断言**（代码还在骗人） |
| **C. 还有隐性消费者** | 生产零**直接**调用，但通过字符串、反射、`data-*` 属性被用到 | **留着**，并在文件头写明「谁在用、怎么用」 |

**先做这张表，写进回写。** 不要先动手删。

### 二、`WorkflowNodeCard` 的处置

它今天在 **B 类**（`workflow-view-smoke` 在 SSR 里验它）。

**所以这不是「删一个文件」，是「删一个文件 + 改一套套件」。**

要求：
1. **`workflow-view-smoke` 里那些断言，先逐条问「它验的东西还有没有意义」**。
   如果某个断言验的是「卡片上的能力标签怎么显示」—— 那个能力今天**没有任何 UI 显示它**，
   断言是在守一个不存在的界面。**删。**
   如果某个断言验的是 `workflowLayout` 的几何（纯函数）—— **那部分可能仍然有意义**，
   因为迁移器或别的代码可能在用 `workflowLayout`。**先 `grep` 确认。**
2. **`workflowLayout.ts` 单独判断**：它是不是只被 `WorkflowNodeCard` 用？
   ```bash
   grep -rn "workflowLayout" apps/desktop/src/ apps/desktop/scripts/
   ```
   如果只有死代码用它 → 一起删。如果迁移器或别处用 → **留着**，但在文件头写清「谁在用」。

### 三、`WorkflowLibraryView` 里的同源残留

W3 提到 `handleSetDependency` 等。**先列清单**：

```bash
# 找出只被自己引用的私有函数
grep -n "^  const handle\|^  function handle" WorkflowLibraryView.tsx
```

**逐个查「有没有 JSX 引用它」**。没有 → A 类。

**⚠️ 注意**：`WorkflowLibraryView` 是 66KB 的大文件，而且 **W15 可能也在碰它**
（W15 的边界是 `WorkflowsPanel.tsx` / `EngineRuntimePanel.tsx`，理论上不冲突，但要确认）。
**开工第一步 `git status --porcelain` 看它有没有未提交改动。**

## 验收判据

1. **三类分类表**（每项带判据，不是感觉）；
2. **B 类的处置是「代码 + 断言一起动」**，不是只删一个；
3. **`workflowLayout.ts` 有独立的「还有没有消费者」结论**；
4. **删完之后这些套件全绿**：
   - `workflow-view-smoke`（**断言数会变少，写清从多少变到多少、少了哪些、为什么**）
   - `workflow-node-select-smoke`（W3 新建的）
   - `workflow-ui-smoke`
   - `settings-form-lifecycle-smoke`
   - `maint-m37-smoke`（如果动了 i18n）
5. **`tsc` EXIT=0**；
6. **注释也一起改** —— `WorkflowLibraryView.tsx:15` 那句「`WorkflowNodeCard` 是画布专用的」
   要改成「画布已于 T45 删除」或者删掉。**留下它比留下死代码更坏**；
7. **不跑全量**。

## 边界

**可以改：**

- `apps/desktop/src/renderer/components/settings/workflows/WorkflowNodeCard.tsx`（删或留）
- `apps/desktop/src/renderer/components/settings/workflows/workflowLayout.ts`（**先确认消费者**）
- `apps/desktop/src/renderer/components/settings/workflows/WorkflowLibraryView.tsx`
  （**⚠️ 与 W3 的改动是同一文件，W3 已交付但未提交 —— 先 `git status` 确认**）
- `apps/desktop/scripts/workflow-view-smoke/main.ts`
- i18n（如果删掉的 UI 留下了孤儿 key）

**不许碰：**

- `apps/desktop/src/main/**`
- `apps/desktop/scripts/mcode-node-pack-smoke/`
- `tasks/T*.md`、`tasks/README.md`、`tasks/workflow/README.md`

## 回写

`tasks/workflow/W20-dead-code.md` 末尾追加 `## 结果回写`：

1. 三类分类表；
2. 每个被删的东西：**它曾经被谁引用**（注释也算）、**为什么现在可以删**；
3. `workflow-view-smoke` 的断言数变化（多少 → 多少，少了哪些）；
4. **你没删但查过的东西**，以及为什么留着；
5. **你没能验证的东西**；
6. **卡上写错的地方**。

## 一条提醒

**删代码最危险的不是删错，是删了「只有注释说它还在用」的东西，而那条注释也是错的。**

所以每条删除都要回答：**「我是怎么确认它没被用的？」** —— 不能是「grep 了名字没看到调用」，
因为**名字搜是引用数，不是出口数**（本仓库栽过多次）。


## 2026-10-25 再盘点（只读；未实施删除）

开工时确认 WorkflowNodeCard / workflowLayout / WorkflowLibraryView / workflow-view-smoke 均无未提交改动。但 **W20 任务卡漏列至少三个直接测试消费者**，不能只按原卡的 5 个“可改”文件删除：

| 对象 | 实际消费者 | 处理判断 |
| --- | --- | --- |
| `WorkflowNodeCard.tsx` | 生产代码无 import；`workflow-view-smoke/main.ts` SSR 绘制并验证多条视觉断言；`module-catalog-ui-smoke/main.jsx` 浏览器挂载卡片；`execution-engine-smoke/main.ts` 读取文件字节做权限标签/runner 判据；`design-tokens-smoke/main.ts` 将该文件列在有效视觉 Token 白名单 | **B：仅测试守护，不是 A**。必须先把那三个额外套件改为验证当前真正可用的 `NodeInspector` / `NodeTypesView` / 新 Node-RED 编辑器，按行为替换旧断言，并经各自真跑后才能删。否则删除会制造三套假红。 |
| `workflowLayout.ts` | 生产 `workflowEdit.ts` 调用 `firstFreeSlot/autoLayout`，`workflowEdgeLabels.ts` 通过 `Box` 类型引用；`workflow-view-smoke` 有大量几何断言 | **C：有生产调用，不得整体删除**。可另做小范围精简，但必须保留 `firstFreeSlot` 等生产接口和其覆盖。 |
| `WorkflowLibraryView.handleSetDependency` | 同文件 JSX 将其传入 `NodeInspector.onSetDependency`，可由现有库 UI 触发 | **C：生产依赖存在，不得删**。 |
| `WorkflowLibraryView.tsx` 文件头提到 `WorkflowNodeCard` | 仅一条过时的解释性注释，非运行依赖 | 后续删除卡片时一起修文档，不能拿注释当存在生产视图的依据。 |

**结论**：当前任务卡的独占可写范围未包括三个额外测试套件。为保留并行对话边界，本轮**没有**删除组件、布局或改写其他模块的测试。W20 不能凭“生产零调用”宣布 Done；需总控允许附加 `module-catalog-ui-smoke`、`execution-engine-smoke`、`design-tokens-smoke` 的测试 owner 并对旧卡片断言进行替代。它是测试迁移工作，不是本轮事件触发器运行故障。
