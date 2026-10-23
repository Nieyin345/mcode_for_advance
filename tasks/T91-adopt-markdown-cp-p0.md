# T91｜🔴 P0：导入中文路径的 Markdown，配图静默丢失

- Status: **ready-for-agent**
- Category: **P0 产品缺陷**（用户数据损坏）
- Priority: **P0 —— 触发条件比 T90 更常见**（用户导入一篇 `D:\我的论文\第一章.md`）
- Depends on: T90（`5f954755`，同根因 + 同型回归可参考）
- Exclusive writable files:
  - `apps/desktop/src/main/library/adoptMarkdown.ts`
  - 新建 `apps/desktop/scripts/t91-adopt-markdown-cp-smoke/`

## Required Skills
- `mcode-smoke`：子进程回归（同 T90 的模式）。

## 背景：设计假设已被打破，但代码不知道

`apps/desktop/src/main/library/adoptMarkdown.ts` 两处 `cpSync`：

```ts
// :242  复制 Markdown 引用的配图
const dest = join(destDir, ...rel.split(/[/\\]/));
cpSync(abs, dest, { recursive: true });

// :313  把用户导入的 md 拷进暂存
// ── ① 先把新的一整包拷进暂存。**这一步失败时老包一个字节都没动。** ──
cpSync(sourcePath, stagedMd);
```

**`:313` 的注释是决定性证据**：设计上依赖「**这一步失败时老包一个字节都没动**」。

**而现在的实际行为**（Node 22.21.1 + Windows）：

| 场景 | 行为 |
|---|---|
| **源路径含非 ASCII**（`D:\我的论文\第一章.md`） | **进程直接崩**（`0xC0000005`），`catch` 接不住 |
| **目标路径含非 ASCII** | **静默不复制**，返回成功，目标为空 |

**第二种是数据损坏**：`stageDir` 里是空的或半截的，而流程以为拷贝成功了。

### ⚠️ 触发条件比本节原来说的窄（B 实测修正，2026-10-24）

**B 实测**：

| 形态 | 中文路径下 |
|---|---|
| 复制**单文件**（带不带 `recursive`） | **不崩** |
| 复制**目录** + `recursive: true` | **`0xC0000409` 崩** |

**所以：**

- **`:313`（`cpSync(sourcePath, stagedMd)` 复制单个 md）根本不触发** —— 本节原文说「设计假设已被打破」，**那是错的**；
- **只有 `:242` 会触发** —— 且**只当 Markdown 引用的是一个目录**（`![图](图表/)`）而不是文件时。

**修正后的触发条件**：**用户导入的 Markdown 里引用了中文路径的目录**。

**这比「导入中文路径的 md」窄得多，但仍然是真实场景**（少数工具会把图放成 `figures/` 而引用写成 `figures/`，`:240` 的注释明写了这一点）。

**原因**：现象如此，**根本原因未查**（`cpSync` 的单文件路径不走 native copyDir fast path，那才是崩的地方）。

### 为什么仍然值得修

- **`:242` 一旦触发就是进程崩溃**（不是静默失败）；
- **修法只有一行**（`filter: () => true`），成本极低；
- **而 `:313` 虽然不崩，但保持一致性也该加**（否则下一个人看不懂为什么一处有一处没有）。

**但卡上的判断要更正**：`:313` 是**安全的**，不是「设计假设已被打破」。

## 任务

### 第一步：先确认 `:242` 的 `abs` 从哪来

```bash
grep -n "abs\s*=\|sourcePath\s*=" apps/desktop/src/main/library/adoptMarkdown.ts | head
```

**判断**：它是**用户文件路径**（危险）还是**已规范化到安全目录的路径**（安全）。

**如果已经规范化到安全位置，`:242` 可能不受影响** —— **那 T91 只需要修 `:313`。**

### 第二步：照 T90 的模式补回归

**新建 `apps/desktop/scripts/t91-adopt-markdown-cp-smoke/`**：

- **`main.ts`（父进程）自己从不碰非 ASCII 的 `cpSync`**，只 `spawnSync` 起子进程读 `status`；
- **`probe.ts`（子进程）调真实的 `adoptMarkdown`**，不是复制一份 `cpSync`；
- **五个场景**（同 T90）：
  1. 纯 ASCII（正控：不崩 + 文件真的复制了）；
  2. `sourcePath` 含中文（负控）；
  3. 配图路径含中文（负控）；
  4. `café` / `Тест`（影响面）；
  5. **对照：源不存在时是「可捕获的失败」，不是崩溃**（证明探针真的在调）。

**第 5 条必须有** —— 没有它，探针什么都不做也可能全绿。

### 第三步：修

```ts
// :242 —— 必改（目录引用会崩）
cpSync(abs, dest, { recursive: true, filter: () => true });

// :313 —— 单文件不崩，但为一致性也加（并注明「单文件本不触发」）
cpSync(sourcePath, stagedMd, { filter: () => true });
```

**注释按 T90 的写法**（写条件 + 出处 + 后果，**不写方案**）：

```ts
// Node 22 on Windows crashes in cpSync's native fast path when the path has
// non-ASCII characters (nodejs/node#54476, #63970). Passing any filter forces
// the JS implementation, which is unaffected. Keep filter even though it
// accepts everything: it is what selects the JS path.
```

### 第四步：还要检查「失败时老包没动」这个承诺

**`:313` 的注释承诺「失败时老包一个字节都没动」。**

**修好 `cpSync` 之后，这个承诺要用断言验证**：

- 构造一个**会让复制失败**的场景（比如目标目录只读）；
- 断言：**老包内容逐字节不变** + **返回错误而不是成功**。

**这是第二十一条**（「不崩」不等于「修好了」）。

## 验收判据

1. **`:242` 的 `abs` 来源判断**（危险 / 安全）。
2. **回归五个场景**（含对照），**必须包含「引用目录」这一形态**（那是真正触发的场景），修复前至少 3 条红。
3. **变异**：撤掉 `filter` → 子进程崩 → `cmp` 还原。
4. **「失败时老包没动」有断言**。
5. 不跑全量、不起 Electron。

## 边界

- 只改 `adoptMarkdown.ts` + 新建套件；
- 不改 `build/`（那是 T92）；
- 不改 `dataRoot.ts`（T90 已修）。

## 回写

`tasks/T91-adopt-markdown-cp-p0.md` 末尾追加 `## 结果回写（2026-10-24）`：
`:242` 判断、五场景结果、变异、老包保护断言、提交 SHA。
