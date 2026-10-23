# T86｜给 t65 套件的输出加一行「验什么、不验什么」

- Status: ready-for-agent
- Category: 测试可读性
- Priority: P2 —— 不是缺陷，但读者会误判覆盖面
- Depends on: T65（`f6acf173`）、T75（`7dbbfc80`）、T73（`da9484b4`）
- Exclusive writable files: `apps/desktop/scripts/t65-deck-pattern-smoke/main.ts`

## Required Skills
- `mcode-smoke`：改套件输出。

## 背景：套件的名字让人以为它验的是整块能力

`t65-deck-pattern-smoke` **46/46 全绿**。但 B 在 T73 复核时发现：

> E 说：他那 40 条断言，**在我改前和改后都是绿的**。

**因为 T65 验的是 `checkDeckPatterns` 这个纯函数，而 T73 改的是调用方。纯函数没变，所以它合理地没红。**

**这不是缺陷——分层是对的。** 问题是**名字**：`t65-deck-pattern-smoke` 听起来像在验整个「反模式检查」能力，实际只验纯函数一层。

**后果**：下一个读到这个名字的人（尤其是执行会话）会以为「反模式这块有 46 条断言守着」，于是不去查接线有没有问题。**而 T73 之前，接线是完全断的。**

## 任务：在套件输出的第一行写清边界

B 的判断（总控认可）：

> **改名不是最有效的那一步。更有效的是在套件输出的第一行写清它验什么、不验什么。**
>
> 因为改名要改目录、`run.sh`、所有引用和它自己的套件输出前缀（4 处以上），而读者真正会读的是**跑起来的第一屏**。一行注释的成本是零。

### 要求

在 `main.ts` 的第一条 `console.log` 之前（或套件启动时），输出一段：

```
t65-deck-pattern-smoke：只验 checkDeckPatterns 纯函数（N 条判据）。
接线（模型是否真的看得到 findings）在 t73-pattern-wiring-smoke。
```

**措辞你自己定**——你是这套判据的作者，最清楚边界在哪。

**但要包含两个信息**：

1. **这个套件验什么**（纯函数，不含接线）；
2. **接线在哪套**（`t73-pattern-wiring-smoke`）。

### 顺带（可在同一次提交里做）

**如果改名成本真的只是 4 处，也做了。** 但**不要为改名单独开一轮**。

B 建议的名字：`t65-deck-pattern-checker-smoke`。**你判断值不值得。**

## 验收判据

1. **套件跑起来第一屏能看到边界说明**（不是埋在某条断言里）。
2. **说明里点名了接线在哪套**。
3. 套件仍全绿（数字不变）。
4. 如果改了名，`run-smokes.mjs` 的发现规则仍能收（目录名仍以 `-smoke` 结尾）。

## 边界

- 只改 `apps/desktop/scripts/t65-deck-pattern-smoke/main.ts`（改名的话连带目录与 `run.sh`）；
- 不改产品代码；
- 不跑全量、不起 Electron。

## 提交

`git add <明确路径>` + `git commit -m "<信息>" -- <明确路径>`。**`-m` 在 `--` 前面。**
末尾加 `Co-Authored-By: Claude Fable 5.0 <noreply@anthropic.com>`。

## 回写

`tasks/T86-t65-scope-note.md` 末尾追加 `## 结果回写（2026-10-23）`：
输出原文、是否改名、套件数字。
