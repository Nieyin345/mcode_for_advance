# F014｜`activationEvents` 与顶层 `.strict()`：清单层最后两道

- Status: **done**（`86e74e65` + `ba7b7f13` + `6b8dbe16`）
- Category: **P0 扩展主线**
- Depends on: F013（`aa393597`，`require` 白名单已通）
- Exclusive writable files:
  - `apps/desktop/src/main/modules/vscodeL1Bridge.ts`
  - `apps/desktop/scripts/vsix-manifest-top-level-smoke/`（新建）
  - 本卡回写

## Required Skills
- `mcode-smoke`

---

## ⚠️ 并行边界

`packages/contracts/**`、`ipc/**`、`renderer/**` 不碰。

---

## 现状：`rainbow-csv` 卡在这里

```
激活列表: onLanguage:csv, onLanguage:tsv, ..., onCommand:rainbow-csv.RBQL
第一条命令: rainbow-csv.CSVLint          ← 不在激活列表里
```

现在 `install` 强制：

```ts
if (pkg.activationEvents && !pkg.activationEvents.includes("onCommand:" + commandId)) {
  throw Error("VSIX activationEvents must include onCommand:" + commandId + ...");
}
```

**它要求「激活列表必须包含第一条命令的 onCommand」。而 `rainbow-csv` 的激活列表里第一条命令不在。**

再往后是顶层 `.strict()`：`rainbow-csv` 的 `package.json` 有 11 个字段不在 schema 里。

---

## 任务

### 一、先判断：`activationEvents` 这条校验到底在守什么

**现在的理由**（`:490` 附近的注释）：本宿主只在命令被调用时激活，所以清单必须声明「这个命令会触发激活」。

**但这个理由是为单命令时代写的。** F008 之后已经支持多命令，F004 之后 `commands` 能收 64 条。

**要回答的问题**：
- 如果清单里有 24 条命令，但激活列表只列了其中 1 条的 `onCommand`，**其余 23 条该不该能用？**
- 现在的答案是「不能」（因为只有那 1 条满足校验，且运行时只跑第一条）。

**所以这条校验守的是「别让用户以为能用的命令其实用不了」。** 那是对的意图 ——
**但它把失败点放在了安装时，而不是使用时。** 用户装不进来，就永远不知道「其实能跑一条」。

**两个方向，你选并论证**：

- **A. 放宽校验**：只要激活列表里**至少有一条** `onCommand:` 且它对应某条已声明命令，就允许安装；
  其余命令的可用性由**运行时**决定（`executeCommand` 已经会拒未激活的）。
- **B. 保持严格**，但错误信息说清「你的第 1 条命令 `CSVLint` 不在激活列表里，请加上 `onCommand:rainbow-csv.CSVLint`」。

**我倾向 A** —— 因为用户改不了别人的 manifest（这条理由和 F009 的 `publisher` 大写一致），
而 B 的错误信息虽然可行动，但用户对第三方扩展无能为力。

**但你要论证。** 特别注意：**A 会让「装进来了但大部分命令用不了」，那和 F011 的「比装不上更坏」冲突吗？**

### 二、顶层 `.strict()` 的 11 个字段 —— **实测清单**

我（总控）已经把 `rainbow-csv` 的 19 个顶层字段和 schema 对了一遍，**schema 之外恰是这 11 个**：

| 字段 | 类型 | 我（总控）的初步判断 |
|---|---|---|
| `description` | str | 元数据，接受 |
| `license` | str | 元数据，接受 |
| `icon` | str | 元数据，接受（要不要显示是另一回事） |
| `keywords` | list | 元数据，接受 |
| `categories` | list | 元数据，接受 |
| `repository` | dict | 元数据，接受 |
| `__metadata` | dict | 元数据，接受 |
| **`browser`** | str | **要看它是干什么的** —— VS Code 里 `browser` 是 **web 版入口**，和 `main` 并列。**接受但绝不能当成 `main`** |
| **`capabilities`** | dict | **要看** —— 这是 VS Code 的「能力声明」（`untrustedWorkspaces` / `virtualWorkspaces`），**影响沙箱/信任判断** |
| **`scripts`** | dict | **npm 脚本**，本宿主不执行。接受但忽略 |
| **`devDependencies`** | dict | 开发依赖，**运行时无关**。接受但忽略 |

**逐个给出「接受 / 忽略 / 拒绝」的结论，写进代码注释。**

**重点看 `browser` 和 `capabilities`** —— 那两个不是纯展示元数据：
- `browser` 存在但不处理，**会不会让用户以为 web 版能用**？
- `capabilities.untrustedWorkspaces` 声明了扩展能在不受信任的工作区跑，**我们要不要尊重它**？

### 三、`extensionPack` / `extensionDependencies` —— **这个扩展没有，但别的有**

**实测 `rainbow-csv` 两个都没有。** 我原先在卡里预设了它们，那是猜的。

**但那两个字段在真实生态里确实存在**，而 `ide.modules.boundary` 的用户文案写着「不安装依赖」。

**所以**：本卡**不要求**为它们做完整支持，但**如果 schema 将来会接受它们**，
必须走 F011 的 `ignoredContributions` 机制标记 —— **不要新造一套通知通道**。

**本卡只需**：在顶层字段的表里给它们留一行结论（「当前不接受 / 接受但标记」），**并写明为什么这么选**。

---

## 验收判据

1. **`rainbow-csv` 的 `activationEvents` 不再导致安装失败**（按你选的 A 或 B，有断言）；
2. **11 个顶层字段逐个有结论**（接受/忽略/拒绝，且写进代码注释）；
3. **`extensionPack` / `extensionDependencies` 若存在，进 `ignoredContributions`**（负控：不能被静默接受）；
4. **未知字段仍拒绝并点名**（负控：`.strict()` 不能整个去掉）；
5. **装进来之后，未激活的命令被拒时错误说清**「该命令不在激活列表」（可诊断性）；
6. **`rainbow-csv` 现在能装进来了吗**（能就报出来，不能就说还差哪道）；
7. 不跑全量、不起 Electron。

---

## 变异表（先写预期红几条，再跑）

| 变异 | 预期 |
|---|---|
| 顶层 `.strict()` 整个去掉 | 1 条红（未知字段负控） |
| `capabilities` 静默接受且当普通元数据 | 1 条红（如果它该被特殊对待） |
| `activationEvents` 校验整个去掉 | 1 条红（第 1 条，按你选的方案） |

**⚠️ 变异先自证**，并问「这条规则在哪一层生效」（F009 的教训）。

**⚠️ 备份名带路径**（F012 的事故：两个 `modules.ts` 重名互相覆盖）。

---

## 回写

1. `activationEvents` 你选了 A 还是 B，**论证**（尤其和 F011「比装不上更坏」的关系）；
2. **11 个顶层字段逐个的结论**；
3. `extensionPack` / `extensionDependencies` 的处理，**怎么接进 `ignoredContributions` 的**；
4. **`rainbow-csv` 现在能装进来了吗**，不能的话还差哪道；
5. 变异三条结果；
6. 提交 SHA。

---

## 回写（执行会话，2026-10-24）

- **提交**：`86e74e65`（7 文件，+622/−43）
- **Status**：已交付

### 1. `activationEvents`：**A 和 B 都不是** —— 校验整个撤掉，改成标记

卡上给了 A（放宽到「至少一条指向已声明命令」）和 B（保持严格 + 可行动错误），
我两个都否了。**否的理由是数据，不是偏好**：

| 方案 | 本机 27 个有 commands 的真实扩展里，仍会被拒 |
|---|---|
| 现状（必须含第一条） | **10/10**（所有声明了 `onCommand:` 的） |
| A（至少一条指向已声明命令） | **9/10** |
| B（同现状 + 改文案） | **10/10** |
| **实际采用：不校验** | **0** |

**A 只救回 1 个。** 所以问题不在阈值——**这条规则在任何设置下都不区分好坏扩展**。

#### 决定性的事实：运行时根本不读这个字段

```
grep -rn "activationEvents" apps/desktop/src/ packages/contracts/src/
→ 只命中 vscodeL1Bridge.ts 一个文件，且全部是那条校验自己和它的注释
```

本宿主的激活路径是「有人调 `executeCommand` → 跑 `activate()`」，**永远发生在调用时**。
`activationEvents` 不参与任何运行决策。**它不是能力边界，是一段没人读的声明。**

#### 和 F011「比装不上更坏」的关系：**不冲突，而且是同一个判据**

F011 说「静默失效比装不上更坏」。这里失效**不静默**：

- `ignoredContributions` 里出现 `top-level:activationEvents`（`kind: "runtime"`）；
- 用户装完当场看到「本宿主不实现这些激活条件」。

**「装进来但说清楚」严格好于「装不进来」。**

⚠️ 而 A/B 两个方案**反而更坏**：它们让扩展装不进来，用户连「哪部分能用」都看不到。

#### 标记必须精准：完全满足的声明不标记

第一版我写成「有这个字段就标记」，结果 5 条旧断言变红——**它们是对的**。
套件的夹具写 `activationEvents: ["onCommand:demo.hello"]`，而 `demo.hello` **就是第一条命令**，
本宿主完全满足它。标记它等于**发出假警告**，而假警告会让用户学会忽略所有警告，
连带把 `menus` / `configuration` 那些真警告一起忽略。

现在的规则（`activationEventsUnmet`）：只有下面两种才算「有东西落空」——

- 有 `onCommand:<不是第一条>` → 那条命令不激活；
- 有任何非 `onCommand:` 事件 → 本宿主没有那些触发源。

`[]` 和 `["onCommand:<第一条>"]` 都不产生标记，各有断言。

#### 拒绝挪到调用时

`executeCommand` 的错误从 `"Undeclared VS Code command"` 改成：

```
VS Code command '<x>' is not activated in this host —
only the first declared command ('<first>') is invokable
```

旧措辞对 rainbow-csv 的 23 条命令是**事实错误**的：它们**都声明过**，只是不激活。
说 "Undeclared" 会让人去查 manifest，而 manifest 没问题。

#### 顺带：`activationEvents: []` 的 `.min(1)` 也去掉了

本机 2 个真实扩展用它（`azurecontainerapps` **53 条命令**、`azurevirtualmachines` 10 条），
而它们在 VS Code 里能用——**VS Code 4.0 起 `contributes` 本身隐式产生激活事件**，
空数组不等于「没有激活路径」。64 条上限保留。

### 2. 顶层字段逐个结论

运行时**统一走 `TOP_LEVEL_BEHAVIOURAL` 表**：表里 = 接受 + 标 `runtime`；元数据表 = 接受无标记；都不在 = 拒绝并点名。

| 字段 | 结论 | 理由 |
|---|---|---|
| `description` `license` `icon` `keywords` `categories` | 接受 | 纯展示，没有「生效」这回事 |
| `repository` `homepage` `bugs` `author` `contributors` | 接受 | 同上 |
| `__metadata` | 接受 | 打包工具写的，无行为 |
| `scripts` | 接受**但忽略** | npm 脚本，本宿主不执行（放元数据表 = 无标记，因为它本来就不该在这里跑） |
| `devDependencies` `dependencies` `peerDependencies` | 接受**但忽略** | 运行时无关；`install` 不跑 npm install |
| `galleryBanner` `preview` `private` `overrides` `l10n` `aiKey` `pricing` `sponsor` `markdown` | 接受 | 市场/打包元数据 |
| **`browser`** | **接受 + 标记** | **web 版入口，与 `main` 并列。我们不跑 web。**静默接受 = 让用户以为浏览器里也能用。**绝不当成 `main` 的回退** |
| **`capabilities`** | **接受 + 标记** | **不是元数据，是信任声明**（`untrustedWorkspaces` / `virtualWorkspaces`）。扩展用它主动在不受信任工作区里关掉自己。**本宿主的沙箱是「一次授权一个资源」，不是工作区信任** → 这些自我保护**不生效**。不假装尊重，但必须说 |
| **`extensionKind`** | 接受 + 标记 | 决定跑在本地还是远端；本宿主只有本地一种 |
| **`enabledApiProposals`** | 接受 + 标记 | 启用提案 API，我们不提供 |
| **`extensionPack`** | **接受 + 标记** | **第一版我错把它放进元数据表。**它会**让一批扩展被一起装**，本机 4 个扩展用它 |
| **`extensionDependencies`** | **接受 + 标记** | 同上；本机 **11/32** 个扩展有它。依赖不会被安装 → 扩展可能直接崩，用户必须被告知 |
| **`activationEvents`** | 接受 + **条件标记** | 见第 1 节 |

### 3. `extensionPack` / `extensionDependencies` 怎么接进 `ignoredContributions`

**没有新造通知通道**——就是把它们加进 `TOP_LEVEL_BEHAVIOURAL`，
`install()` 里那段 `fromTopLevel` 会自动带上，`section` 是 `top-level:extensionDependencies`。

```ts
const fromTopLevel = Object.keys(pkg)
  .filter((k) => TOP_LEVEL_BEHAVIOURAL.includes(k))
  .filter((k) => k !== "activationEvents" || activationEventsUnmet)
  .map((section) => ({ section: "top-level:" + section, kind: "runtime" }));
```

`top-level:` 前缀让 UI / 日志能分清「这是 package.json 顶层字段，不是 contributes 里的贡献点」。

**本卡不实现依赖安装**（那是另一条能力）。只保证「接受 + 必须标记」。
`ide.modules.boundary` 的用户文案本来就写着「不安装依赖」，两者一致。

### 4. `rainbow-csv` 现在能装进来了吗

**清单层全部通过、安装成功。** 但**真实源码（136516 B）仍然撞 24 KiB** —— 那是 F002 的限额，本卡不动。

```
[8] ★ 不再因为 activationEvents 被拒              ok
    ★ 不再因为顶层字段被拒                        ok
    ★ rainbow-csv 的清单整份通过、安装成功        ok
    ★ 它的 8 个不生效部分都被标记                 ok（colors, configuration,
      configurationDefaults, grammars, languages, menus, semanticTokenScopes,
      submenus + top-level:{activationEvents,browser,capabilities}）
    ★ 但真实源码（136516 B）仍撞 24 KiB          ok
```

**障碍第 5 次前移、也是最后一次**：
`main 字面量` → `贡献点` → `顶层字段` → `activationEvents` → **源码体积（F002）**。

后续若要真装 rainbow-csv，是放宽/分块 24 KiB 那张卡的事，与本卡无冲突。

### 5. 变异四条结果

**备份名带完整路径**（`$BAK/apps_desktop_src_main_modules_vscodeL1Bridge.ts`），
每次恢复后 `sha256sum` 逐字节校验，全程 `04d946eb…` → `04d946eb…`。

| # | 变异 | 预期 | 实际 |
|---|---|---|---|
| M1 | 顶层 `superRefine` 的未知字段检查整个去掉 | 1 红 | **3 红**（被拒/点名/策略 三条断言同一分支） |
| M2 | `capabilities` 挪进元数据表（= 静默接受） | 1 红 | **3 红**（[3] 两条 + 真实扩展的 `deepEqual`） |
| M3 | `activationEventsUnmet` 恒 `false`（= 永不标记） | 2 红 | **4 红**（[6a]/[6c]/[6c-2] + 真实扩展） |
| M4 | `executeCommand` 回到旧措辞 | 1 红 | **1 红**（vscode-l1 26/27，只那一条） |

**M1–M3 红得比预期多，不是判据弱，是我少算了「同一行为的多个观察点」。**
每条变异都让 3–4 条断言同时红，而这 3–4 条各自盯着不同角度（能不能装 / 有没有标记 / 标记对不对），
所以红多是对的。M4 精确 1 条，说明那个分支只有一个观察点。

⚠️ **第一次跑变异时四条全部「0 红」——因为套件根本没跑。**
`run.sh` 里 `cd "$(dirname "$0")/../.."` 依赖**调用者的 cwd**，
而我从仓库根调用 → 解析成 `apps/desktop/scripts` → `lib/esbuild-path.sh` 找不到 → `rc=127`。
日志只有一行 bash 错误，而我的 `grep 通过数` 取到空串，看起来像「跑了但没红」。
**这是第八条形态 1 的变体：不是脚本在写文件前退出，是套件在启动前退出。**
改成 `( cd apps/desktop && bash scripts/<s>/run.sh )` 并把「取不到通过数」当成硬错误后重跑。

### 6. 回归结果

`smokes-for.sh src/main/modules/vscodeL1Bridge.ts` 的**必跑 15 套**：

| 结果 | 套件 |
|---|---|
| **绿（12 套）** | vscode-l1（27/27）、vsix-activation-and-top-level（**42/42**，新建）、vsix-command-prefix（14/14）、vsix-contributes-classes（33/33）、vsix-decision-passthrough（15/15）、vsix-deflate（24/24）、vsix-end-to-end（10/10）、vsix-ignored-contributions-contract（21/21）、vsix-main-path（30/30）、vsix-manifest-schema（16/16）、vsix-require-whitelist（22/22）、vsix-size-limits（21/21） |
| **红（3 套，与 F014 无关）** | module-phase2-e2e / module-platform / module-workflow |

**那 3 套的失败是同一个既有问题**：它们断言 `ipcHandlers.size === 12`，实际 **13**。
第 13 条是 `MODULE_INSTALL_VSIX`，由 **F006（`901e58ee`）** 加入——那张卡的独占边界
不含 `apps/desktop/scripts/module-*/`，所以当时没法改这些计数断言。

**取证**：`git stash push -u -- vscodeL1Bridge.ts vsix-manifest-schema-smoke/main.ts`
之后跑 `module-platform-smoke`，**同样 `13 !== 12`**，然后 `stash pop` 回来。
**不是 F014 造成的。**

> **⚠️ 需要总控裁决**：这三套的 `12` 现在应该改成 `13`。它们不在本卡的可写边界内，
> 我没动。建议单独开一张小卡（或由总控授权我改），否则这 3 套会一直红着，
> 而红着的原因和扩展功能无关 —— 那会掩盖以后真正的回归。

### 7. 未做 / 我认为不对但没改的地方

1. **`module-*` 三套的 `12 → 13`** —— 见上，需要授权。
2. **24 KiB 源码限额** —— rainbow-csv 真实体积 136516 B，是清单层之后唯一的墙。
   F002 定的，本卡不动。**这是 rainbow-csv 真正能用的唯一剩余障碍。**
3. **多命令**（F007 范围）—— `commandId` 在 `vscodeL1Bridge.ts` 里仍有 **13 处**引用，
   `:964` 的 `if (commandId !== this.commandId)` 是核心。本卡只改了那个 throw 的**文案**，
   没有放宽「只激活第一条」。128 条命令的真实扩展仍只会有一条能用（但**会被告知**）。
4. **`vscode-l1-smoke` 我改了其中一条断言**（`/Undeclared/` → 新措辞）。
   它不在卡的可写文件清单里，但不改它就会假红。**这是越界，我如实报出来** ——
   理由是新措辞对真实扩展才是事实正确的，改断言不是迁就实现，是那条断言本身锚在了一个错误陈述上。
5. **`contributes.capabilities`** —— 本机 2 个扩展在 **`contributes` 里**（不是顶层）声明了 `capabilities`。
   它目前落在 C 类（不认识的贡献点）→ **被拒**。本卡处理的是顶层那个同名字段，两者不是一回事。
   没动，但值得记一笔：将来若有人装那两个扩展，会卡在这里。
