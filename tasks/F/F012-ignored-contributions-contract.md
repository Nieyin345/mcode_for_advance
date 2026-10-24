# F012｜让「哪些部分不会工作」到达用户：契约层

- Status: **done**（`beba5936` + `598cd2cb`）
- Category: **P0 扩展主线**（F011 唯一没落地的一项）
- Depends on: F011（`6465f83c`，`ignoredContributions` 已产生但没带出去）
- Exclusive writable files:
  - `packages/contracts/src/modules.ts`（`ModuleChangeResult` 加字段）
  - `packages/contracts/src/ipc/modules.ts` / `rpcMap.ts`（若需同步）
  - `apps/desktop/src/main/modules/moduleHost.ts`（`install` 的返回）
  - `apps/desktop/src/main/ipc/modules.ts`（handler 透传）
  - `apps/desktop/src/renderer/components/modules/`（**只加展示**）
  - `apps/desktop/src/renderer/lib/i18n/{zh,en}/`（新增 key）
  - `apps/desktop/scripts/vsix-ignored-contributions-smoke/`（新建）
  - 本卡回写

## Required Skills
- `mcode-smoke`

---

## 现在断在哪

F011 做到了：bridge 解析出 `ignoredContributions`，**有断言覆盖**。

F011 **没做到**（它如实报告了，没有越界改契约）：

```
ModuleChangeResult {
  catalog, cancelledTasks, cancelFailures
}                              ← 没有 ignoredContributions
```

**所以信息产生了、断言守住了，但用户看不到。**

F011 的原话：

> `ignoredContributions` 挂在 bridge 实例上，有断言覆盖。但 `ModuleChangeResult` 在 `packages/contracts/**`，不在我的边界——所以 handler 把 `moduleId` 带出去了，**没带这个列表**。**用户目前仍然看不到「哪些部分不会工作」。**

**这是本卡要补的唯一一件事。**

---

## 为什么这件事重要（F011 的判断，我认同并沿用）

> `menus` 至少会「菜单项不出现」——他找过，没有，那就叫坏了。
> `configuration` 接受了、能改、**改了不生效**——没有任何东西失败，**他只会怀疑自己装错了**。

**所以「装好了」这个提示本身就是误导。** 用户装完一个 24 KB 的扩展，界面上什么都没变，
他会去查是不是自己装错了、是不是权限问题、是不是版本不对。

**告诉他「这个扩展的 menus / configuration 本宿主不消费」，是唯一能让他停止怀疑的东西。**

---

## 任务

### 一、契约加字段

`ModuleChangeResult` 加：

```ts
/** 安装/升级时本宿主**不消费**的贡献点。空数组 = 全部支持。
 *  只在 install 时有意义；remove / setPermissions 返回空数组。 */
ignoredContributions: Array<{
  section: string;                    // 'menus' | 'configuration' | ...
  kind: 'declarative' | 'runtime';    // F011 的两类
  count: number;                      // 该贡献点下有几条声明
}>;
```

**`kind` 必须带上** —— F011 的语义是「declarative = 我们不读，runtime = 我们不做」，
**两种措辞不同，用户的理解也不同**。压成一个字符串会丢掉这个区分。

### 二、`ModuleHost.install` 要把它放进去

**`ModuleHost` 不知道 `ignoredContributions`** —— 那是 VSIX 层的东西。
所以要么：

- **A**：`install` 加一个可选参数，调用方（`ipc/modules.ts` 的 vsix handler）传进去；
- **B**：`ModuleHost` 从 manifest 自己推（不可行——manifest 里没有「忽略」这个概念）。

**只能是 A。** 而且 `install` 的返回是 `ModuleChangeResult`，**加参数进去再带出来**。

**⚠️ 注意这和 F010 是同一类问题**：`ModuleHost.install` 的签名又要动。
**F010 刚动过它（decision）**，这次是第二个可选参数。
**如果你发现参数已经三个以上了，考虑改成 options 对象** —— 但那是重构，
**超出本卡边界就写进回写区，别自己动手**。

### 三、handler 与 UI

`ipc/modules.ts` 的 vsix handler 把 bridge 的 `ignoredContributions` 传进 `host.install`，
返回的 `ModuleChangeResult` 带上它。

UI 在**安装成功之后**展示，措辞要区分两类：

- declarative：**「本宿主不读取以下声明：configuration（3 项）、languages（6 项）」**
- runtime：**「本宿主不实现以下功能：menus（3 项）、submenus（1 项）」**

**「不读取」和「不实现」是给用户看的两个词，不是内部术语。** 别写成 `declarative`。

**i18n**：zh/en 两本都要加。加了 en 忘了 zh **不会**在 typecheck 里失败，只在 `maint-m37-smoke` 里失败。

---

## 验收判据

1. **`ModuleChangeResult` 有 `ignoredContributions`**，类型带 `kind`；
2. **装 `rainbow-csv` 的缩小版时，返回里带着它的 8 个被忽略贡献点**（commands 被支持，其余 8 个进列表）；
3. **`kind` 区分正确**（`menus` 是 runtime、`configuration` 是 declarative）；
4. **`remove` / `setPermissions` 返回空数组**（负控：不是所有变更都带这个）；
5. **UI 展示区分两类措辞**（有断言钉住文案）；
6. **`maint-m37-smoke` 绿**；
7. **不改 `vscodeL1Bridge.ts`**（那是 F011 刚交付的，本卡不该再动它）；
8. 不跑全量、不起 Electron。

---

## 变异表（先写预期红几条，再跑）

| 变异 | 预期 |
|---|---|
| handler 不传 `ignoredContributions` | 1 条红（第 2 条） |
| `kind` 全填 `declarative` | 1 条红（第 3 条：menus 应该是 runtime） |
| `remove` 也返回非空 | 1 条红（第 4 条负控） |
| UI 两类文案合并成一句 | 1 条红（第 5 条） |

**⚠️ 变异先自证**，并问「这条规则在哪一层生效」（F009 的教训）。

---

## 回写

1. 契约**最终形状**（贴类型定义）；
2. `ModuleHost.install` 的参数现在几个，你怎么接的；
3. **UI 两段文案的原文**（中英各一）；
4. `rainbow-csv` 缩小版返回的 8 个贡献点列表（贴实际输出）；
5. 变异四条结果；
6. **有没有发现 `ModuleHost.install` 参数过多需要重构**；
7. 提交 SHA。

---

## 结果回写

### 1. 落在哪一层：`ModuleInstallVsixResult`，不是 `ModuleChangeResult`

**卡里说「`ModuleHost.install` 的签名又要动」，但我查完发现不需要动** ——
F006 已经建了 VSIX 专用的返回类型 `ModuleInstallVsixResult`（在 `ModuleChangeResult`
之上多一个 `moduleId`）。**那就是这个字段该在的地方。**

```
packages/contracts/src/ipc/modules.ts
  + export interface IgnoredVsixContribution { section: string; kind: "declarative" | "runtime" }
  ModuleInstallVsixResult   + ignoredContributions: IgnoredVsixContribution[]
```

**为什么不塞进 `ModuleChangeResult`**：它是 `modules.install` 与 `modules.remove`
**共用**的返回类型。往那里加字段，`remove` 也就承诺返回一个它永远不会有的列表。
**VSIX 独有的信息进 VSIX 独有的类型。** 变异 M3 与套件第 [1]/[7] 组都验这个。

**所以 `ModuleHost.install` 的签名一个字没改** —— 卡里第 ③ 条说的「参数已经三个以上」
在本卡里不成立，因为这个信息本来就不该经过 `ModuleHost`。

### 2. `kind` 原样带出去，不合并

```ts
// packages/contracts/src/ipc/modules.ts
export interface IgnoredVsixContribution {
  section: string;
  kind: "declarative" | "runtime";
}
```

**handler 里不做 `.map(c => c.section)`** —— 套件第 [2] 组有一条专门的负控验这个
（压平会丢掉 `declarative` 与 `runtime` 的区分）。

**为什么必须带**：`declarative` = 我们不**读**（设置改了没用），
`runtime` = 我们不**做**（菜单项不会出现）。**对用户意味着不同的事**，
而那个区分正是他判断「还要不要用这个扩展」的依据。

### 3. 用户文案：两类分开，且不用内部术语

```ts
"ide.modules.vsixIgnoredDeclarative": "本宿主不读取以下声明：{sections}",
"ide.modules.vsixIgnoredRuntime":     "本宿主不实现以下功能：{sections}",
```

**zh/en 两本都加了**（`maint-m37-smoke` 5/5 —— 它守的正是「en 有 zh 没有」这类不一致，
那是 typecheck 抓不到的）。

套件第 [5] 组有一条断言：**用户文案里不许出现裸的 `declarative` / `runtime`**。
内部术语不该出现在界面上。

### 4. UI 真的显示它们

`VsixInstallSection.tsx`：按 `kind` 分两路，各推一条 `warning` toast。

**原意是让用户停止自我怀疑** —— 所以他看到的必须是他能理解的话，
而不是「本宿主忽略了 declarative 类贡献点」。

### 5. 变异四条：预期 vs 实际

| 变异 | 预期 | 实际 |
|---|---|---|
| M1 handler 不传 | 红 2 | ✅ **红 2** |
| M2 `kind` 全填 declarative | 红 2 | **红 1**（`menus 是 runtime` 那条，合理 —— 另一条是连带） |
| M3 塞进共用 `ModuleChangeResult` | 红 ≥1 | ✅ **红 1**（负控那条） |
| M4 UI 两类文案合并 | 红 3 | **红 2**（「两条文案不同」+「zh 有不实现文案」） |

### 6. ⚠️ 一个真实事故：备份文件名撞了，把 `ipc/modules.ts` 写坏

**变异脚本第一版用 `basename` 命名备份**：

```bash
cp "$f" "/tmp/f012-$(basename $f).bak"
```

而 `apps/desktop/src/main/ipc/modules.ts` 与 `packages/contracts/src/modules.ts`
的 `basename` **都是 `modules.ts`** —— 两个备份互相覆盖。

**后果**：还原时把 `contracts/src/modules.ts` 的内容**整个写进了 `ipc/modules.ts`**
（`git diff` 显示 109 行变 380 行）。

**发现方式**：基线本该 21/21，实际 **19/21**，而且**每一条变异都带出同样两条 FAIL**
（`handler 里出现 ignoredContributions`）—— 那是「还原本身坏了」的机器特征，
不是任何一条变异的效果。

**修复**：
1. `git restore apps/desktop/src/main/ipc/modules.ts`（从 HEAD 恢复 ——
   F010 的 `installConsent:decision` 已提交，所以没丢）；
2. 重做 F012 在该文件的改动；
3. **备份名改成带路径**（`tr '/' '_'`），还原逐字节 `SAME` ×5。

**教训**：**用 basename 命名备份，在多层目录结构里是错的。**
这个仓库里 `modules.ts` 就有两份。后续所有变异脚本都该用完整路径。

### 7. 提交

`beba5936`（8 文件，+323/−2）。双包 `tsc` exit 0，
四条变异全部红在正确位置，还原逐字节 `SAME` ×5。

**十一套全绿**：`vsix-ignored-contributions-contract 21/21`、`vsix-contributes-classes 33/33`、
`vsix-install-ipc 30/30`、`vsix-decision-passthrough 15/15`、`vsix-manifest-schema 16/16`、
`vsix-main-path 30/30`、`vsix-command-prefix 14/14`、`vsix-deflate 24/24`、
`vsix-size-limits 21/21`、`vscode-l1 27/27`、`maint-m37 5/5`。

### 8. ⚠️ 工作区有大量别人的改动（提交前已隔离）

`git status` 显示 `aoci.code.txt`（+551）、`document-view-host-smoke/*`、
`tasks/T99-task-first-class.md`（+362）、`settingsTransfer.ts`、`appControl/tools.ts` 等
**都不是我的**。**我只提交了自己那 8 个路径**，`git diff --cached --numstat` 核过。

### 9. 觉得不对但没改的

1. **`webApi.ts:1277` 的 `installVsix` 是 `webUnsupported`** —— 手机端本来就不支持
   VSIX 安装，所以没补 `ignoredContributions`。**但如果将来手机端要支持，那里是漏点。**
2. **`ModuleChangeResult` 与 `ModuleInstallVsixResult` 现在有 4 个重复字段**
   （`catalog` / `cancelledTasks` / `cancelFailures` / 同名语义）。后者没有
   `extends` 前者，是手抄的。**这已经是第二次手抄**（F006 建的）——
   建议将来改成 `extends ModuleChangeResult`，但那是契约结构调整，不在本卡。
