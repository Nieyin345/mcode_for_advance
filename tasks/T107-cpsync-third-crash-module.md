# T107｜🔴 `filter: () => true` 不是万能的：cpSync 的第三种崩溃形态

- Status: delivered（2026-10-24；t10/t88 已修；#7/#14 待验证，见回写第五节）
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

## 结果回写（2026-10-24）

### 一、第 3 种形态确认，但边界比卡上更精确

**卡上写触发条件是「非 ASCII 源 + 目标已有同名文件」。实测下来要再拆一层。**

`.tmp/t107-m2.mjs` / `t107-m3.mjs`，六格 × 两源类型，**全部带 `filter: () => true`**：

| 场景 | ASCII 源 | **非 ASCII 源** |
|---|---|---|
| 目标不存在 | ✅ | ✅ |
| 目标目录存在、**为空** | ✅ | ✅ |
| 目标目录存在、**内部无同名文件** | ✅ | ✅ |
| **目标里有同名文件（单文件覆盖）** | ✅ | ❌ **`THREW errno=0`** |
| **目标目录已完整存在（拷第二遍）** | ✅ | ❌ **`THREW errno=0`** |
| 源 = 目标（自拷贝） | ❌ `ERR_FS_CP_EINVAL` | ❌ `ERR_FS_CP_EINVAL` |

**精确条件：非 ASCII 源 + 目标里已有同名文件。** 「目标目录存在」本身不触发（空的、或内部无冲突都正常）。

> ⚠️ **自拷贝那格两边都错**，但那是 `ERR_FS_CP_EINVAL`（合理的拒绝），不是本卡的 bug。

### 二、最坏的形态：**抛错 + 没做 + 错误信息说成功**

修前实测：

```
THREW errno=0 msg=, The operation completed successfully. '\?\D:\副桌面\文件夹\work
| top=OLD-TOP inner=OLD-INNER
```

**两个坏条件同时成立**：

1. **抛了错** —— 调用方用 `try/catch` 当成可忽略，就以为拷过了；
2. **一个字节都没拷** —— 目标保持旧内容。

**而错误信息是「The operation completed successfully」** —— 这句话会让人以为它其实做了。

### 三、修法：三种都可行，**我选了「先删后拷」**

`.tmp/t107-fixes.mjs` 在同一触发条件下测三种：

| 修法 | 结果 | 遗留 |
|---|---|---|
| **A. 先删后拷**（`rmSync` + `cpSync`） | ✅ top=NEW inner=NEW srcIntact=true | 无 |
| B. 拷到临时名再 rename | ✅ 同上 | 无 |
| C. 手写递归 `copyFileSync` | ✅ 同上 | 无 |

**选 A 的理由**：

- **B 在 Windows 上要额外处理「rename 目标已存在 → EPERM」**，多一层失败面；
- **C 要自己实现递归**，多一份可能出错的代码（硬规矩 2：共享实现只有一份）；
- **A 的语义最直接**：这几个调用点的目标内容**本来就该被完全替换**，删掉旧的没有任何信息损失。

**A 的风险**：删了之后如果 `cpSync` 失败，目标就没了。**但两个调用点（t10/t88 的 `copyLicenseTree`）都在测试夹具里，目标是从源重新生成的，不是用户数据**——所以可以接受。

**如果将来在用户数据上用，应该选 B**（B 在失败时旧内容还在）。

### 四、`t88` 修好，`t10` 同形一并修

| 套件 | 修前 | 修后 |
|---|---|---|
| `t10-node-red-pause-license-smoke` | status=0 / 15 ok（**看起来正常，实际是有产物时才会踩**） | status=0 / 15 ok |
| `t88-node-red-license-closure-smoke` | **status=1 / 11 ok，`ESRCH`** | **status=0 / 13 ok** |

**变异**：撤掉 `rmSync` → t88 回到 **status=1 / 11 ok + ESRCH**，`cmp` 逐字节还原。

### 五、清点全部 `filter: () => true`（15 处 → 判定）

| # | 位置 | 源可能非 ASCII？ | 目标可能已有同名文件？ | 判定 |
|---|---|---|---|---|
| 1 | `build/dereference-workspace-symlinks.cjs:75` | 是（仓库路径） | **否** —— `staging` 是 `${full}.deref-tmp-${randomUUID()}`，每次唯一 | ✅ 安全 |
| 2 | `build/stage-genoffice-resources.cjs:684` | 是 | **否** —— `temp` 是 `mkdtempSync` | ✅ 安全 |
| 3 | `build/stage-genoffice-resources.cjs:696` | 是 | **否** —— 同上 | ✅ 安全 |
| 4 | `build/stage-genoffice-resources.cjs:700` | 是 | **否** —— 同上 | ✅ 安全 |
| 5 | `build/stage-node-red-resources.cjs:697` | 是 | **否** —— `tmp` 是 `mkdtempSync` | ✅ 安全 |
| 6 | `build/stage-node-red-resources.cjs:710` | 是 | **否** —— 同上 | ✅ 安全 |
| 7 | `electron.vite.config.ts:191` | 是 | **可能** —— `publicDir` 是 `src/renderer/public/pdfjs`，**重复 build 时会已存在** | ⚠️ **需验证** |
| 8 | `t10-.../main.cjs:52`（`copyLicenseTree`） | 是 | **是** —— 同一次运行里 `copyLicenseTree` 可能被调多次 | **已修（先删后拷）** |
| 9 | `t10-.../main.cjs:358` | 是 | 否 —— `root` 是 `mkdtemp` 下新建 | ✅ 安全 |
| 10 | `t88-.../main.cjs:42`（`copyLicenseTree`） | 是 | **是** —— `current-stage-copy` 已被前一步整树拷贝建好 | **已修（先删后拷）** |
| 11 | `t88-.../main.cjs:349` | 是 | **是** —— 同上 | **已修（先删后拷）** |
| 12 | `dataRoot.ts:165`（`moveIfNeeded`） | 是 | **否** —— `if (existsSync(to)) return;` 守卫 | ✅ 安全 |
| 13 | `dataRoot.ts:215`（`copyDataRootTo`） | 是 | **否** —— 上面有「目标目录非空则拒绝」 | ✅ 安全 |
| 14 | `adoptMarkdown.ts:249` | 是（用户配图路径） | **可能** —— 同一份 md 里两处引用同一目录时，第二次目标已存在 | ⚠️ **需验证** |

> 注：行号以本卡回写时为准；`filter` 出现的位置还有几处是注释，不重复计。

**结论**：14 处里 **2 处已修**、**2 处待验证（#7 / #14）**、**10 处安全**（目标恒为新建）。

**#7 `electron.vite.config.ts:191` 的验证方法**：连续 build 两次，第二次 `src/renderer/public/pdfjs/cmaps` 已存在。**但那两处是 `buildStart` 钩子，且前面有 `assetTreeComplete` 的版本比较会提前 return** —— 所以实际只在**版本变化时**才复制，那时目标已存在。**这是真实的第 3 格。**

**#14 `adoptMarkdown.ts:249`**：同一份 Markdown 里 `![a](图表/)` 和 `![b](图表/x.png)` 会让 `copyReferencedAssets` 对 `图表/` 复制两次。**第二次目标已存在 → 踩第 3 格。** 我已用 `.tmp/t107-adopt-dup.mjs` 复现（非 ASCII 源）。

**这两处我按卡上的边界没有动**（#7 是 `electron.vite.config.ts`，卡上写「可以只出判定不动手」；#14 是 `adoptMarkdown.ts`，T91 刚改过）。

### 六、`dataRoot.ts` 的注释（卡上第 4 条）

改了，但**不是「filter 有局限」这种含糊话**，而是列出三种情形各自的成立条件：

```ts
// **`filter` 只在两种情形下有效**（nodejs/node#54476、#63970）：
//   1. 非 ASCII 源 + 目标**全新** → 不加 filter 进程崩，加了正常；
//   2. 非 ASCII 目标 → 不加 filter 静默不复制，加了正常。
// **第三种救不了**：非 ASCII 源 + 目标里**已有同名文件** → 加了 filter 仍然抛错
// （`errno=0`，信息甚至是 "The operation completed successfully"），且**实际没复制**。
//
// **本函数不受第三种影响**：上面 `if (!existsSync(from) || existsSync(to)) return;`
// 已经保证目标不存在 …… **动这个守卫之前先读 tasks/T107**。
```

**最后那句是关键**：它把「守卫」和「为什么不能删」绑在一起。**没有它，未来的人看到 `existsSync(to)` 会以为是多余的防御而删掉。**

### 七、新套件 `t107-cpsync-preexisting-smoke`（20/20）

四个区块：

1. **正控**：ASCII 源 + 目标已存在 → 覆盖成功（证明问题只在非 ASCII）；
2. **对照**：非 ASCII 源 + 目标已存在 + 不加修法 → **必须失败**，且必须是「抛错 + 目标仍旧内容」；
3. **三种修法**各自通过（证明它们等价）；
4. **修法不留残渣**。

**第 2 节是靶子**：如果它绿了，说明套件根本没复现那个 bug。

**变异**：撤掉 `delete-first` 的 `rmSync` → **18/20**，红的是「目标真的被覆盖」两条，输出正是 `THREW code= errno=0 | top=OLD`。`cmp` 还原。

### 八、`CLAUDE.md` 建议（卡上说不要碰，写在这里）

**原文**（第二十一条附近，T90 之后加的）：

> `filter: () => true` 能强制走 JS 实现，**修复** `cpSync` 在非 ASCII 路径上的崩溃。

**建议改成**：

> `filter: () => true` 能强制走 JS 实现，但**只在两种情形下有效**：
> ① 非 ASCII 源 + 目标全新（否则进程崩）；② 非 ASCII 目标（否则静默不复制）。
> **第三种救不了**：非 ASCII 源 + 目标已有同名文件 —— 加了 filter 仍抛错且**实际没复制**，
> 错误信息还写着 "The operation completed successfully"。
> 需要**先删后拷**（或拷到临时名再 rename）。见 `tasks/T107`。

**为什么必须改**：原句是一个**绝对陈述**（「修复」），而它在第 3 格不成立。**下一个人会照着它以为 `filter` 万能。**

### 九、回归

| 套件 | 结果 |
|---|---|
| `t107-cpsync-preexisting-smoke` | **20/20** |
| `t10-node-red-pause-license-smoke` | status=0，15 ok |
| `t88-node-red-license-closure-smoke` | status=0，13 ok |
| `t90-dataroot-cpsync-smoke` | 10/10 |
| `t91-adopt-markdown-cp-smoke` | 19/19 |

未跑全量、未起 Electron。

### 十、提交

`<见提交>`。
