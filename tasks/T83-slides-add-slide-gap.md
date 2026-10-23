# T83｜`slidesAddSlide` 有通道、零渲染端调用：可视化编辑的断点

- Status: ready-for-agent
- Category: **产品缺陷（能力已造好但接不上）**
- Priority: **P0** —— 用户抱怨「AI 改 Word/PPT 很烂」，而人自己也不能编辑
- Depends on: ARC-007（`documentView:*` 七条通道）、T40（渲染端 registry）
- Exclusive writable files: **只读 + `.tmp/` 探针**。**不改产品代码**（先核清楚再决定要不要开施工卡）。

## Required Skills
- `mcode-smoke`：无头验证。
- `codebase-design`：判断「断在哪一层」。

## 背景：这是今天第二次「能力造好了但接不上」

**第一次**（T73）：`checkDeckPatterns` 纯函数、22/22 全绿、**`src/` 里零调用**。

**这一次**：

```bash
$ grep -rn "slidesAddSlide" apps/desktop/src/ --include=*.ts --include=*.tsx
main/document/slidesBridge.ts:12      ← 文档注释
main/ipc/documentView.ts:322          ← handler 注册
（渲染端：零）
```

而渲染端的文档面板**自己写着**：

```ts
/**
 * 【ARC-007】**GenOffice 文档面板**（用户可达的只读/结构化视图）
 * ...
 * 它**不是**完整编辑器 —— 可视化编辑要等方案 A（受控 WebContentsView）接上；
 * 本面板的作用是让"打开文档 → 看见真实结构 → **知道为什么还不能编辑**"这条链
 * 先可达、可诊断。
 */
// apps/desktop/src/renderer/components/ide/GenofficeDocumentPane.tsx:1-9，共 123 行
```

**这个注释是诚实的。** 但现在要回答：**它诚实地描述了一个断点，还是诚实地描述了「做了一半」？**

## 任务

### 第一步：摸清 `documentView:*` 七条通道各是什么

```bash
grep -n "documentView\." apps/desktop/src/main/ipc/documentView.ts | head -20
```

**逐条列出**：通道名、做什么、**渲染端有没有调用**。

**产出一个表**：

| 通道 | 主进程做什么 | 渲染端有无调用 | preload 有吗 |
|---|---|---|---|

**这一张表就是本卡最重要的产出**——它告诉你断在哪一层（主进程 / preload / 渲染端）。

### 第二步：判断断点在哪一层

三种可能，含义完全不同：

| 断点 | 含义 | 修复成本 |
|---|---|---|
| **preload 没暴露** | 契约有、主进程有、桥没有 | 一行 |
| **渲染端没调用** | 能力齐全，UI 没接 | 一个组件 |
| **UI 根本没有编辑入口** | 需要设计交互（谁选页、怎么确认、撤销怎么办） | **一个方案** |

**要看 `packages/contracts` 的 `documentView` 契约 + preload 白名单 + 渲染端调用点三层。**

### 第三步：回答一个具体问题

**用户现在能不能在 Mcode 里给一个 PPT 加一页？**

- 打开文件 → 看到页列表 → 点「加一页」→ 真的加了 → 保存 → 重新打开还在？

**逐环节确认**。如果任何一环断了，**说清断在哪**。

### 第四步：`GenofficeDocumentPane` 那条注释，是真的吗

它说「可视化编辑要等方案 A（受控 WebContentsView）接上」。

**去查**：方案 A 是指什么？有没有对应的施工卡？**如果 `slidesAddSlide` 已经能工作，那这句注释就过期了。**

**这就是今天反复出现的「注释里的断言没人验」。**

## 验收判据

1. **`documentView:*` 七条通道的完整表**（通道 / 主进程 / 渲染端 / preload）。
2. **断点在哪一层的判断**（preload / 渲染端 / 需要设计）。
3. **「能不能加一页」的明确答案**（逐环节）。
4. **`GenofficeDocumentPane` 那条注释是否过期**的判断。
5. **不改产品代码**。

## 边界

- **只读 + `.tmp/` 探针**；
- **不改产品代码**（这一轮只核清楚；要施工另开卡）；
- 不跑全量、**不起 Electron**；
- 不碰 B 的 `documentToolRuntime.ts`、不碰 A 的扩展线文件。

## 遇到问题先检索

`GenofficeDocumentPane` 的注释提到「方案 A（受控 WebContentsView）」，先 `grep` 找方案 A 的文档或卡，**不要凭猜**。

## 提交

`git add <明确路径>` + `git commit -m "<信息>" -- <明确路径>`。**`-m` 在 `--` 前面。**
末尾加 `Co-Authored-By: Claude Fable 5.0 <noreply@anthropic.com>`。

## 回写

`tasks/T83-slides-add-slide-gap.md` 末尾追加 `## 结果回写（2026-10-23）`：
七条通道的表、断点判断、「能不能加一页」、注释是否过期、提交 SHA。
