# F011｜贡献点：把「只支持 commands」拆成三类

- Status: ready-for-agent
- Category: **P0 扩展主线**（`rainbow-csv` 现在卡在这道）
- Depends on: F009（`eb6ba1cc`，`main` 已通，障碍前移到贡献点）
- Exclusive writable files:
  - `apps/desktop/src/main/modules/vscodeL1Bridge.ts`
  - `apps/desktop/scripts/vsix-contributes-classes-smoke/`（新建）
  - 本卡回写

## Required Skills
- `mcode-smoke`

---

## ⚠️ 并行边界

`apps/desktop/src/main/ipc/**`、`packages/contracts/**`、`renderer/**` 不碰。

---

## 我（总控）实测的分布

本机 28 个有 `contributes` 的扩展：

| 贡献点 | 扩展数 |
|---|---|
| `configuration` | **25** |
| `commands` | 24 |
| `menus` | **24** |
| `submenus` | 10 |
| `views` | 9 |
| `x-azResources` | 9 |
| `walkthroughs` | 8 |
| `languages` | 7 |
| `keybindings` | 7 |
| `grammars` | 6 |
| `jsonValidation` | 6 |

**关键观察：除了 `commands`，其余绝大多数是「声明式」的** ——
`configuration` 是设置项、`languages` / `grammars` 是语法定义、`jsonValidation` 是 schema 关联。
**它们不需要运行时实现，只需要「接受并记录下来」。**

真正需要运行时的只有：`menus`（渲染菜单）、`views`（渲染面板）、`keybindings`（绑定按键）。

---

## 卡里要解决的问题

现在 `contributes` 的校验是：**只认 `commands`，其他一律拒绝**。

F004 当时的决定是对的（拒绝并点名，不静默丢弃）。但它让 `rainbow-csv` 装不进来——
那个扩展有 9 个贡献点，只有 1 个被支持。

**F009 提了一个我认同的前提问题：**

> 放开却不实现，用户会看到菜单项、点了没反应，**比装不上更坏**。

**所以不能一刀切放开。要按「放开之后用户会怎样」分类。**

---

## 任务

### 一、把贡献点分成三类，各自处理

| 类 | 例子 | 处理 | 理由 |
|---|---|---|---|
| **A. 声明式，无害** | `configuration`、`languages`、`grammars`、`jsonValidation`、`colors` | **接受并记录** | 不需要运行时；接受了也不会让用户「点了没反应」 |
| **B. 需要运行时，能部分支持** | `menus`、`keybindings`、`views` | **接受但明确标记「未实现」**，并在**安装时告知用户** | 静默接受会让用户以为能用 |
| **C. 不认识** | 其余 | **拒绝并点名** | 保持现有行为 |

**⚠️ A 类要特别想清楚**：`configuration` 接受了、但用户改了设置项**不会生效**——
**那和「点了没反应」是同一类欺骗，只是不易察觉。**

**所以 A 类的「接受」必须伴随一个**可见的**事实：这些声明被记录，但本宿主不消费它们。
**不要让它看起来像「支持了」。**

**这条我（总控）没法替你决定**：A 类到底算「无害接受」还是「也是欺骗」？
**你在回写区论证，并把结论写进代码注释。**

### 二、用户必须能知道「装进来的这个扩展，哪些部分不会工作」

**这是本卡的核心产品判断。**

现在安装成功的提示大概是「装好了」。装上 `rainbow-csv` 之后，它的菜单项不出现、设置项不生效——
**用户会以为自己装坏了。**

**要求**：安装结果里带上「本宿主忽略了哪些贡献点」，UI 能显示。
**如果安装结果的结构改不了**（契约不在你的范围），就写进回写区，别自己改契约。

### 三、`rainbow-csv` 的 9 个贡献点要逐个给出结论

实测它有哪些：`colors` / `configuration` / `submenus` / `menus` / `languages` / `commands` /
`semanticTokenScopes` / `configurationDefaults` / `grammars`

实测它有哪些（9 个，条目数已核）：

| 贡献点 | 条目 | 大致归类 |
|---|---|---|
| `commands` | **24** | 已在支持 |
| `configuration` | 3 | A（声明式） |
| `configurationDefaults` | 1 | A（声明式） |
| `colors` | 3 | A（声明式） |
| `languages` | 6 | A（声明式） |
| `grammars` | 6 | A（声明式） |
| `semanticTokenScopes` | 1 | A（声明式） |
| `menus` | 3 | **B（需运行时）** |
| `submenus` | 1 | **B（需运行时）** |

**逐个填进那张三类表**，每个给出「本宿主怎么处理」和「用户会看到什么」。

**注意**：上面那列「大致归类」是我的初步判断，**你要自己核** ——
尤其 `languages` / `grammars`（语法高亮）算不算「A 类无害」？
它们**不需要我们的运行时**，但**需要我们的编辑器去消费** —— 如果编辑器不读它们，那就是又一种「接受了但不生效」。**这个我不替你判断。**

---

## 验收判据

1. **三类分法写进代码**（不是一张表放在卡里）；
2. **A 类接受且有断言**（`configuration` 不会让安装失败）；
3. **B 类接受但标记未实现**，且**标记能被读到**（不是只写进日志）；
4. **C 类仍拒绝并点名**（负控：不认识的东西不能被静默接受）；
5. **`rainbow-csv` 的 9 个贡献点全部有明确结论**，安装不再因贡献点失败；
6. 不跑全量、不起 Electron。

---

## 变异表（先写预期红几条，再跑）

| 变异 | 预期 |
|---|---|
| A 类也改成拒绝 | 1 条红（`configuration` 那条） |
| B 类改成静默接受（不标记） | 1 条红（标记那条） |
| C 类改成接受 | 1 条红（未知贡献点负控） |

**⚠️ 变异前先自证，并且问「这条规则在哪一层生效」** ——
F009 的教训：`packageSchema` 只在 `install()` 里 parse，测在 `readMinimalVsix` 层等于没测。

---

## 回写

1. **A 类到底算不算欺骗** —— 你的论证和最终结论；
2. 三类分法的**代码位置**；
3. `rainbow-csv` 9 个贡献点**逐个的结论**；
4. 「用户怎么知道哪些不工作」—— 你做到了哪一步，哪一步受契约限制做不到；
5. 变异三条结果；
6. 提交 SHA。

---

## 结果回写

### 1. A 类到底算不算欺骗 —— **算，而且比 B 类更危险**

**结论：A 类接受，但标记与 B 类同样强制。**

论证的核心是**「用户会不会当场发现」**：

| 类 | 用户看到什么 | 会不会知道坏了 |
|---|---|---|
| **B `menus`** | 菜单里**没有那一项** | **会** —— 他找过，没有 |
| **A `configuration`** | 设置项存在、能改、**改了不生效** | **不会** —— 没有任何东西失败 |

**所以 A 类不能因为「它不报错」被当成无害 —— 它恰恰因为不报错而更难发现。**

装 rainbow-csv 的用户改了设置、发现没用，会怀疑**自己装错了**，而不是「宿主不支持配置」。
**那和「点了没反应」是同一类欺骗，只是时间更晚、更安静。**

`languages` / `grammars` 更微妙：它们不需要我们的**运行时**，但需要**编辑器**去消费。
当前编辑器不读它们 —— 所以归 A 类（接受 + 标记），**不能**归「支持」。

**这条结论写进了文件顶部的注释块**（`CONTRIBUTION_CLASSES` 上方那个大段），
不是只写在卡里。

### 2. 三类分法的代码位置

`apps/desktop/src/main/modules/vscodeL1Bridge.ts`：

| 内容 | 位置 |
|---|---|
| 三类常量 `CONTRIBUTION_CLASSES` | 文件头部（注释块之后） |
| `IgnoredContribution` 类型 | 同上 |
| `classifyContribution()` | 同上 |
| 校验（只拒 C 类） | `packageSchema` 的 `.superRefine` |
| 标记收集 | `install()` 里，构造 manifest 之后 |
| 对外载体 | `VscodeL1Bridge.ignoredContributions`（只读实例字段） |

**⚠️ 这条规则只在 `install()` 层生效** —— `packageSchema.parse` 只在 `install` 里调用，
`readMinimalVsix` 完全不知道它。套件全部走 `install`（F009 的教训）。

### 3. `rainbow-csv` 9 个贡献点逐个结论

| 贡献点 | 条目 | 类 | 本宿主怎么处理 | 用户会看到什么 |
|---|---|---|---|---|
| `commands` | 24 | **支持** | 24 条过 schema，运行时只跑第一条 | 只有第一条能用（F007 待做） |
| `configuration` | 3 | **A** | 接受 + 标记 `declarative` | **设置项不生效，且不提示** |
| `configurationDefaults` | 1 | **A** | 接受 + 标记 `declarative` | 同上 |
| `colors` | 3 | **A** | 接受 + 标记 `declarative` | 主题色不出现 |
| `languages` | 6 | **A** | 接受 + 标记 `declarative` | 语言 id 不注册，`onLanguage:csv` 不触发 |
| `grammars` | 6 | **A** | 接受 + 标记 `declarative` | **无语法高亮** |
| `semanticTokenScopes` | 1 | **A** | 接受 + 标记 `declarative` | 无语义着色 |
| `menus` | 3 | **B** | 接受 + 标记 `runtime` | **右键菜单项不出现** |
| `submenus` | 1 | **B** | 接受 + 标记 `runtime` | 子菜单不出现 |

**实测结果**（`vsix-contributes-classes-smoke` 第 7 组）：**不再因贡献点被拒** ✓

### 4. ⚠️ 障碍前移了两格（本轮最重要的发现）

**这次实测 rainbow-csv 装不进的真正原因，已经不是贡献点了：**

```
VSIX activationEvents must include onCommand:rainbow-csv.CSVLint
(this host only activates on that command; other declared events are not honoured)
```

**它的第一条命令不是它激活时用的那条。** 我们要求「`activationEvents` 必须包含
`onCommand:<第一条命令>`」，而 rainbow-csv 的 `contributes.commands[0]` 是 `rainbow-csv.CSVLint`，
但 `activationEvents` 里只有 `onCommand:rainbow-csv.RBQL` 等**别的**命令。

（这是 F004 放宽 `activationEvents` 时保留的那条约束 —— 当时是对的，
因为运行时只激活第一条；但它现在成了 rainbow-csv 的下一道墙。）

**用真清单走 `install` 还看到更后面一格**：顶层的 `.strict()` 拒了
`description` / `license` / `icon` / `keywords` / `categories` / `browser` /
`capabilities` / `scripts` / `devDependencies` / `repository` / `__metadata`
—— **11 个 VS Code 允许而我们没声明的字段**。

**所以现在 rainbow-csv 依次卡在：**
1. `activationEvents` 必须含第一条命令的 `onCommand`（**当前这道**）
2. 顶层未声明字段（11 个）
3. 之后才是 `extension.js` 24 KiB、`require` 白名单、单命令……

### 5. 「用户怎么知道哪些不工作」—— 做到了哪一步

**做到了**：`VscodeL1Bridge.ignoredContributions`，每个条目带 `section` 与
`kind`（`declarative` = 不读 / `runtime` = 不做）。有断言覆盖（第 2/3/4 组）。

**没做到**：**它没有进 `ModuleChangeResult`。**

```ts
// packages/contracts/src/modules.ts:365
export interface ModuleChangeResult {
  catalog: ModuleCatalog;
  cancelledTasks: number;
  cancelFailures: Array<{ taskId: string; reason: string }>;
}
```

**`packages/contracts/**` 不在本卡边界**，所以没改。**后果**：IPC handler
（`ipc/modules.ts` 的 `MODULE_INSTALL_VSIX`）把 `bridge.moduleId` 带出去了，
但**没带 `ignoredContributions`** —— 所以**用户目前仍然看不到这个列表**。

**这一步需要一张合同层的卡**（或由有契约写权限的会话补），把字段加进
`ModuleChangeResult` 并让 handler 透传。**我在回写里点名，没有自己改契约。**

### 6. 变异三条：预期 vs 实际

| 变异 | 预期 | 实际 |
|---|---|---|
| M1 A 类也改成拒绝 | 红 ≥7 | **红 19** |
| M2 B 类改成静默接受（不标记） | 红 ≥4 | **红 7** |
| M3 C 类改成接受 | 红 3 | **红 4** |

**M1 红 19 条**远超预期，因为 A 类一拒，`configuration` 就在每一项用例里出现，
连带第 6、7 组也红。M2 的失败形态正是预期那种：

```
FAIL ★ menus 被标记为 runtime（不做）  {"ignored":[]}
```

**能装、但 `ignored` 是空的** —— 那就是「静默接受」的机器特征。

三条都先自证（打印「改动后行为会怎样」）再跑。

### 7. 两套旧断言因行为变更而更新（不是绕过）

| 套件 | 原断言 | 为何失效 | 改成 |
|---|---|---|---|
| `vscode-l1-smoke:175` | `keybindings` 被拒 | `keybindings` 现在是 **B 类**（接受） | 用 `madeUpContributionSection`（C 类）验「不认识的仍拒」 |
| `vsix-manifest-schema-smoke` [4] | `menus` 被拒 | 同上 | 改成「A/B 接受 + C 拒」两条 |
| `vsix-manifest-schema-smoke` [7] | 「卡在贡献点」 | **障碍前移了** | 改成「卡在顶层未声明字段」 |

**注意第 3 条**：这已经是那条断言**第二次**因障碍前移而改 ——
`main` → 贡献点 → 顶层字段。**「障碍会前移」这件事本身值得记**：
任何「验当前最大障碍」的断言都有保质期。

### 8. 提交

`6465f83c`（6 文件，+418/−51）。`tsc` exit 0，三条变异全部红在正确位置，
还原逐字节 `SAME (be3ef321...)`。

**九套全绿**：`vsix-contributes-classes 33/33`、`vsix-manifest-schema 16/16`、
`vsix-main-path 30/30`、`vsix-command-prefix 14/14`、`vsix-decision-passthrough 15/15`、
`vsix-install-ipc 30/30`、`vsix-deflate 24/24`、`vsix-size-limits 21/21`、
`vscode-l1 27/27`。
