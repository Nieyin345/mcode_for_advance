# T107｜🔴 `filter: () => true` 不是万能的：cpSync 的第三种崩溃形态

- Status: ready-for-agent
- Category: **P0 基础设施（既有修复不完整，且注释把结论说过头了）**
- Priority: **P0 —— 仓库里 15 处 `filter: () => true` 都以为「加了就安全」，其中至少两处在目标可能已存在时仍然崩**
- Depends on: T90（`filter` 修法）、T92（B 修 src 侧崩溃）
- Exclusive writable files:
  - `apps/desktop/src/main/lib/dataRoot.ts`（只改注释 + 补一条断言用的小节，**不改逻辑**）
  - `apps/desktop/src/main/library/adoptMarkdown.ts`（如确认目标可已存在）
  - `apps/desktop/scripts/t88-node-red-license-closure-smoke/main.cjs`
  - `.tmp/` 探针

## Required Skills
- `mcode-smoke`：正负控 + 变异 + 2×2 矩阵。

## 背景：我（总控）今晚实测到的第三个形态

**原先已知两个形态**（T90 / T92）：

| # | 形态 | 现象 |
|---|---|---|
| 1 | **非 ASCII 源** | `0xC0000409` / `0xC0000005`，进程直接死，`c

atch` 接不住 |
| 2 | **非 ASCII 目标** | 静默不复制：日志说成功、函数返回 null、目标空 |

**`filter: () => true` 能修第 1 种**（T90 的结论）。

## 今晚发现的第 3 种

**触发条件：非 ASCII 源 路径 + 目标路径下已存在同名文件。**

**2×2 实测**（`.tmp/probe-matrix.mjs`，Node 22.21.1 / Windows 11）：

| 源路径 | 目标 | 结果 |
|---|---|---|
| ASCII | 新文件 | ✅ OK |
| ASCII | **已有同名文件** | ✅ OK |
| 非 ASCII | 新文件 | ✅ OK |
| **非 ASCII** | **已有同名文件** | **❌ 崩** |

**而且 `filter: () => true` 救不了这一种** —— 上面四次全部带 `filter`。

**报错形态不稳定**：在真实树上是 `ESRCH errno=3 syscall=cp`，在小树上是 `errno=0` 的普通 throw。
**两种都会让 `cpSync` 抛错，而被 `try/catch` 吞掉时表现为「复制了一半」。**

## 它是怎么被发现的（t88）

```
$ bash scripts/t88-node-red-license-closure-smoke/run.sh
Error: ESRCH, The system cannot find the path specified.
  path: ...\current-stage-copy\licenses\node-red\materials\@node-rs\...\LICENSE
```

**t88 的两步**：

```js
// step 1: 整树复制 134MB 的 stage（目标不存在 → 成功）
fs.cpSync(CURRENT_STAGE, stageCopy, { recursive: true, dereference: false, filter: () => true });
// step 2: 把 build/vendor-licenses/.../materials 覆盖进副本里【已存在】的 materials（崩）
copyLicenseTree(stageCopy, SOURCE_MANIFEST);
   → fs.cpSync(SOURCE_ROOT/materials, target/materials, { ... filter: () => true });
```

**`SOURCE_ROOT` 在仓库里**（`D:\副桌面\文件夹\...`，**非 ASCII**），**目标已存在** → 第 3 种。

**关键证据链**：
- `parent listing: []` —— 那个目录**存在但是空的**；
- 源树 17 个文件、目标树 17 个文件、**逐字节相同**；
- 把目标换成全新的目录 → **同一份源复制成功**（T5 基准）。

## 任务

### 一、把「已存在时怎么办」变成显式策略，不要指望 cpSync

**不要试图修 Node 的 bug。修我们的用法。**

**推荐修法（三选一，你论证）**：

**① 先删后拷**（最简单）：
```js
rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true, filter: () => true });
```
**代价**：不是原子的，中途失败会两边都没有。

**② 拷到临时名再 rename**（原子）：
```js
const staging = to + ".staging-" + randomUUID();
cpSync(from, staging, { recursive: true, filter: () => true });   // 目标不存在 → 安全
renameSync(staging, to);                                          // 同盘原子
```
**这是 T90 里 dataRoot 已经用的模式**（`renameSync` 优先、失败才复制），**复用它的思路**。

**③ 逐文件 `copyFileSync` + `mkdirSync`**：
最可控，但要自己写递归。**只有当 ② 在目标已存在时不 renaming 才需要**。

**我倾向 ②**，理由：它把「非 ASCII 源 + 目标已存在」变成「非 ASCII 源 + 目标不存在」（第 1、2 种已经会处理），而且 `renameSync` 在 Windows 上是原子的。

**⚠️ 但 `renameSync` 在 Windows 上会因为「目标已存在」而 EPERM** —— 所以 ② 仍然是**先删目标**（`rmSync force`）再 rename。**你要实测确认。**

### 二、清点全部 15 处，逐个判断「目标会不会已存在」

```bash
grep -rn "filter: () => true" apps/desktop/src/main/ apps/desktop/scripts/ apps/desktop/build/
```

**已知**：
- `dataRoot.ts:142` —— **有 `if (existsSync(to)) return;` 守卫，不受影响**（只改注释）；
- `dataRoot.ts` 另两处（`~/.mcode` 迁移）—— **要判断**；
- `adoptMarkdown.ts` —— **要判断**（T90 顺手修的，当时没验「目标已存在」）；
- `stage-genoffice-resources.cjs` / `stage-node-red-resources.cjs` / `dereference-workspace-symlinks.cjs` —— **构建链，目标通常新，但 `pnpm build` 重跑时目标已存在**；
- `t10` / `t88` 套件 —— **t88 就是本次的现场**。

**产出**：一张表（文件:行 / 源可能是非 ASCII 吗 / 目标可能已存在吗 / 判定）。

**这是本卡最重要的产出** —— 因为「已存在」就崩这个条件，**每一处都可能已经踩过、只是被 catch 吞了**。

### 三、修 t88

**它是本次的现场，必须修。** 按 §一 选定的方式改 `copyLicenseTree`。

**要有正负控**：
- **正控**：现有流程通过；
- **负控**：把 `build/vendor-licenses` 临时复制到一个**非 ASCII 路径**再跑 —— **必须通过**（这是修复的证明）；
- **对照**：**不加修复**跑同一场景 → **必须红**（否则正控没意义）。

### 四、⚠️ 改注释，但不许把话说满

**现有注释（`dataRoot.ts:155-160`）写着**：

> 修法见 `tasks/T90`：**任何 `filter` 都能强制走 JS 实现**（nodejs/node#63970）

**这句在「目标不存在」时成立，在「目标已存在」时不成立。**

**改法**：**不要写「filter 就没事了」**，要写清条件。

**⚠️ 这是本卡最容易做错的地方**：把注释改成「filter 有局限」很容易写成另一句错误的绝对陈述。

**要求**：
1. 写**触发条件**（非 ASCII 源 + 目标已存在），不写「cpSync 不可靠」这种含糊话；
2. 写**修法**，不写「以后注意」；
3. **`CLAUDE.md` 里那条环境事实也要改** —— 但现在 `CLAUDE.md` 有多个会话在编辑，**你不要碰它，把要改的原文和建议的新文写进回写区，由总控改。**

### 五、变异

1. **删掉修法**（退回裸 cpSync）→ t88 的负控必须红；
2. **把负控的非 ASCII 临时路径改成 ASCII** → 负控会**变绿**（说明它测的是字符集，不是复制本身）。

**第 2 条是判别力证据**：证明你的负控不是「随便找个路径」。

## 验收判据

1. **第 3 种形态的触发条件写清**（2×2 表，有实测）。
2. **15 处清点表**，每处有判定。
3. **t88 修好**：正控绿、负控绿、对照红。
4. **注释改成条件式陈述**，不是另一句绝对陈述。
5. **`CLAUDE.md` 的修改建议写进回写区**（不改文件）。
6. 两次变异各红一次。
7. 不跑全量、不起 Electron。

## 边界

- **不改 Node / 不改 `genoffice/` / 不改 `node-red/`**；
- `dataRoot.ts` **只改注释**（`existsSync(to)` 守卫已经够了）；
- **不碰 `policy.ts` / `documentToolRuntime.ts` / `store/db.ts`**（别人在改）；
- 构

建链（`build/*.cjs`）**可以先只出判定不动手** —— 如果判断「目标已存在」在打包时会发生，先报告。

## 遇到问题先检索

```bash
grep -rn "filter: () => true" apps/desktop/src/main/ apps/desktop/scripts/ apps/desktop/build/
grep -n "cpSync" apps/desktop/src/main/lib/dataRoot.ts
```

**`tasks/T90-*.md` 和 `tasks/T92-*.md` 先读一遍** —— 它们记了前两个形态，本卡是第三个。

**探针留在 `.tmp/probe-matrix.mjs`，可以直接改参数复跑。**

## 回写

`tasks/T107-cpsync-third-crash-module.md` 末尾追加 `## 结果回写（2026-10-24）`：
2×2 实测、15 处清点表、修法论证、t88 正负控与对照、两次变异、`CLAUDE.md` 的建议改法、提交 SHA。
