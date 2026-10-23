# T45｜权限映射生成器会静默放宽：10 条漂移方法一次收进委托面

- Status: done（2026-10-23 执行回写，见文末）
- Category: **bug（安全 / 生成器）**
- Priority: **P0 安全**
- Depends on: T19（`2f899eee` 同轮，危险档逐次审批）、T33（`policy.ts` 档位）
- Exclusive writable files: `apps/desktop/scripts/gen-module-permission-map.mjs`（若存在）、`packages/contracts/src/appPermission.ts`、`apps/desktop/scripts/gen-app-api-catalog.mjs`、新建漂移检测套件。

## Required Skills
- `codebase-design`: 判断「生成器发现未归类方法」时该 fail-closed 还是自动归类。
- `mcode-smoke`: 建回归，做变异验证。

Read before work: `CLAUDE.md`、`tasks/T19-*.md` 回写 §1、`tasks/T20-ai-writes-extensions.md` 回写 §2、`tasks/T33-*.md`、`packages/contracts/src/appPermission.ts`、`apps/desktop/src/main/appControl/policy.ts`。

## 实测结果（总控，2026-10-23，不猜）

我写了探针直接调 `policyFor()` 看这 10 条的实际档位：

| 方法 | `policyFor` 给的 level | 生成器会给的权限 |
|---|---|---|
| `document.apps` | **write** | `document.edit` |
| `document.markdownEdit` | **write** | `document.edit` |
| `document.markdownRead` | **write** | `document.edit` |
| `document.render` | **write** | `document.edit` |
| `document.toolCall` | **write** | `document.edit` |
| `document.toolDescribe` | **write** | `document.edit` |
| `document.toolsList` | **write** | `document.edit` |
| ~~`framework.list`~~ | ~~read~~ | **此条作废：测的时候 `framework.*` 还不存在** |
| ~~`framework.save`~~ | ~~write~~ | 同上 |
| ~~`framework.reset`~~ | ~~write~~ | 同上 |

### 两个都比 T20 的描述更严重的发现

**一、7 条 `document.*` 全部是 `write`，包括 5 条明显只读的。**

`document.apps` / `document.render` / `document.markdownRead` / `document.toolDescribe` / `document.toolsList` —— 这五条**只读命令**（T43 的 `document_render` 描述里自己写着「只读」），`policyFor` 却给 `write`。

**根因**：`policy.ts` 里整个 `document.*` 域没被正确分档，落进了默认的 `write`。**这正是 T33 卡上说的「`document.toolCall` / `document.markdownEdit` 档位偏弱」——但实际范围比 T33 卡上写的更大：不是两条，是整个域。**

后果：生成器会把这 5 条只读方法标成 `document.edit`，**扩展拿到 `document.edit` 权限就能调 `document_render`**（本来应该只要 `document.read`）。

**二、`framework.*` 那条是我测错了（E 会话纠正，总控复核成立）。**

**E 说：`framework.*` 在它动手时仓库里根本不存在。** 我复核了：

```bash
grep -rn '"framework\.' apps/desktop/src/main/appControl/policy.ts    # 零命中
```

**而我的探针之所以报「`framework.list` 是 read」，是因为 `policyFor` 对任何未注册的名字都会兜底：**

```
nonexistent.list       {"level":"read"}   ← 不存在的名字也是 read
totally.made.up.get    {"level":"read"}   ← 同上
foo.read               {"level":"read"}   ← 同上
```

**「末段匹配 `READ_VERB` → read」是兜底逻辑，不是「这个方法存在且是只读」。** 我把兜底结果当成了「它存在」的证据。

**`framework.*` 是 C 的 T34（`f09f4912`）刚建的**，属于 T34 的范围，不是本卡。

### 这条错误的教训

**探针要验「这个符号存在吗」，不能只看 `policyFor` 的返回值。** 正确做法：

```bash
grep -rn '"framework\.' packages/contracts/src/ipc/rpcMap.ts   # 先确认 RPC 在不在
grep -rn '"framework\.' apps/desktop/src/main/appControl/policy.ts  # 再确认档位配没配
```

**两次 grep 都命中，才算「存在但档位不对」。** 只命中一处，说明是「存在但没配」或「压根不存在」。

### 根因（我读到了 `policyFor` 的实现）

```ts
// appControl/policy.ts:486
export function policyFor(method: string): AppPolicy {
  if (method in BLOCKED) return { level: "blocked", ... };
  const credential = CREDENTIAL_BEARING.get(method);
  if (credential !== undefined) return { level: "blocked", ... };
  if (method in DANGER) return { level: "danger", ... };
  const explicit = EXPLICIT[method];
  if (explicit) return { level: explicit };
  const verb = method.slice(method.lastIndexOf(".") + 1);   // ← 只看最后一段
  if (READ_VERB.test(verb)) return { level: "read" };
  return { level: "write" };                                 // ← 兜底
}
```

**`document.*` 在这五个集合里全都没有条目**（`policy.ts` 只有 5 条 `document.*`，且 `document.read` / `document.capabilities` 还错放在 `BLOCKED`），所以全部走最后两行：

| 方法 | 末段 verb | `READ_VERB` 命中 | 结果 |
|---|---|---|---|
| `document.apps` | `apps` | ❌ | **write** |
| `document.render` | `render` | ❌ | **write** |
| `document.markdownRead` | `markdownRead` | ❌（正则要求**以** read 开头） | **write** |
| `document.toolDescribe` | `toolDescribe` | ❌ | **write** |
| `document.toolsList` | `toolsList` | ❌（要求以 list 开头） | **write** |

**注意 `READ_VERB` 是 `^(list|get|read|...)` —— 要求动词在开头。** `markdownRead` / `toolsList` / `toolDescribe` / `toolCall` 都是**前缀 + 动词**的组合，一个都命中不了。

**这个兜底方向本身是对的**（默认从严，未知即 `write`），但它的副作用是：**所有「前缀+动词」命名的新方法都会被当成写操作**，即使是纯读。

### 所以修法要变

原卡里「生成器 fail-closed」的方向仍然对，但**优先级要调整**：

1. **先修 `policy.ts` 里 `document.*` 的档位**（5 条只读的进 `EXPLICIT` 标 `read`）—— 这是 T33 的活，**本卡依赖 T33**；
2. **再让生成器对「未归类方法」fail-closed**：现在的 `throw Error("No domain grant")` 只兜住 `framework`（域不存在），**兜不住 `document.*` 的档位错误**（域存在，照单全收）；
3. **补 `framework` 域的映射**，或者明确它不该出现在目录里。

**T33 没做完之前，这张卡做不干净。**

### 一个可选的系统性修法（供参考，需论证）

把 `READ_VERB` 从「以动词开头」改成「**以动词结尾或以动词开头**」，或者给 `document.*` 加一张显式的只读名单。**但这会改变所有域的默认行为**，风险远大于收益——**我倾向逐条加进 `EXPLICIT`，不改正则。**

新增一条 `RpcMap` 键后必须重跑两个生成器：

```
gen-app-api-catalog.mjs       → apiCatalog.generated.ts
gen-module-permission-map.mjs → appPermission.ts
```

**问题在第二个**：`appPermission.ts` 重生成时，会把 `apiCatalog.generated.ts` 里**所有方法**收进委托面——包括这 10 条**目录已前进、权限映射尚未归类**的：

```
document.apps
document.markdownEdit
document.markdownRead
document.render
document.toolCall
document.toolDescribe
document.toolsList
framework.list
framework.save
framework.reset
```

**这 10 条现在是「没被归类」，重生成会变成「可委托」——那是放宽方向。**

T20 因此**主动放弃了新增 RpcMap**，改走既有工具面。T19 回写 §1 有同一条论证。**但这意味着：任何需要新增 RPC 的功能，现在都被这个缺陷堵住了。**

## 为什么这是 P0

**它不是「可能出问题」，是「每次加 RPC 都会出问题」，而且是静默的。**

- 生成器不会报错，它会「热心地」把这些方法归进去；
- 生成后的 `appPermission.ts` 看起来正常，diff 里只是多了 10 行；
- **没人会注意到这 10 行意味着「扩展现在可以调用 `document.toolCall` 了」**。

而且它正在**阻塞正当的功能开发**：T20 已经因为它放弃了一条更自然的设计路径。

## 工作顺序

**第一步：确认现状。**

1. 这 10 条方法现在在 `appPermission.ts` 里的实际状态是什么？（缺失？归到 `null`？归到某个域？）
2. **跑一次生成器，看 diff**——但要先备份，因为这会真的改文件。
3. 生成器遇到「目录里有、映射表里没有」的方法时，**当前行为是什么**？自动归类？跳过？报错？

**这三条查清了再动手。**

**第二步：让生成器 fail-closed。**

**推荐：未归类方法 → 生成器直接失败，并列出这些方法。**

```js
const unclassified = catalogMethods.filter(m => !(m in permissionMap));
if (unclassified.length > 0) {
  console.error(`以下 ${unclassified.length} 条方法在目录里但未归类权限：`);
  for (const m of unclassified) console.error(`  ${m}`);
  console.error(`先给它们分类（appPermission.ts 的 source of truth），再重跑生成器。`);
  process.exit(1);
}
```

**理由**：
- 新增 RPC 时，**开发者被迫做一次有意识的分类决定**；
- 未归类不会变成「自动可委托」；
- 这 10 条漂移会立刻暴露，而不是等下一次有人加 RPC 时被顺带收进去。

**第三步：给这 10 条做分类。**

这是**安全判断**，不是机械劳动。逐条论证：
- `document.render` / `document.markdownRead` / `document.toolsList` / `document.toolDescribe` —— 只读，可能是 `read` 档；
- `document.toolCall` / `document.markdownEdit` —— **写操作，必须 `danger` 或 `null`**（T33 正在处理类似问题）；
- `document.apps` —— 只回目录事实，可能是 `read`；
- `framework.list` / `framework.save` / `framework.reset` —— `save`/`reset` 是写，`list` 是读。

**每条都要写清理由，不能只填一个值。**

**第四步：建回归。**

断言必须证明：
1. 生成器遇到未归类方法 → **退出码非 0**；
2. 现有 `appPermission.ts` 与实际目录**完全对齐**（无漂移）；
3. 变异：从映射表里删掉一条 → 生成器必须失败。

## 验收判据

1. 回写区给出这 10 条的**当前实际状态**（不是推断）。
2. 生成器改为 fail-closed，有明确错误信息。
3. 10 条**逐条分类并给出理由**。
4. 断言：未归类 → 生成器退出非 0；变异能证明。
5. 现有 `appPermission.ts` 与目录对齐（有断言）。
6. T19/T33 的套件不回归；双包 typecheck 通过。

## 边界

- **不改** `policy.ts` 的档位逻辑（T33 的活）。
- **不改** `RpcMap` 本身。
- **不碰** `documentToolSurface.ts` / `genofficeCli.ts`（B 的 T43）、`ipc/index.ts`（A 的 T40）、`renderer/`（C 的 T41）、`scripts/genoffice-*-smoke/`（C 的 T44）。
- 如果分类某条时**吃不准该给什么档**，**停下来报告**——安全判断宁可慢，不要猜。

## 为什么这值得单开一张卡

T20 为了绕开它，放弃了一条更自然的设计（新增 RPC）。**T20 的选择是对的，但代价是：下一个做扩展/面板功能的会话会遇到同样的墙。**

修好之后，加 RPC 会变成「生成器提示你分类」而不是「静默放宽」。

## 遇到问题先检索

**报错、API 用法、依赖问题先上网查，不要凭记忆猜。**

## 提交

`git add <明确路径>` 后**立刻** `git commit -m "<信息>" -- <明确路径>`。**`-m` 必须在 `--` 前面。绝不读 `.tmp/` 下的文件当提交信息。**

提交信息末尾加：
```

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

## 回写

在 `tasks/T45-permission-map-drift.md` 末尾追加 `## 结果回写（2026-10-23）`：10 条的当前状态、生成器原行为、fail-closed 改法、逐条分类理由、变异证据、提交 SHA。

## 结果回写（2026-10-23）

### 0. 第一步：先确认问题还在（按卡面要求，不猜）

```bash
cp packages/contracts/src/appPermission.ts /tmp/appPermission.before.ts   # 备份
node --experimental-strip-types apps/desktop/scripts/gen-module-permission-map.mjs
# → 453 RPC methods 37 used permissions 41 total permissions 77 blocked   exit=0
cmp packages/contracts/src/appPermission.ts /tmp/appPermission.before.ts
# → BYTE-IDENTICAL
```

**卡面记的那 10 条漂移已经不在了**——生成器跑通、零 diff。逐条查了现状：

| 方法 | 现在的映射 | 谁修的 |
|---|---|---|
| `document.apps` | `["document.read"]` | T33 `75f702d0` |
| `document.markdownRead` | `["document.read"]` | T33 |
| `document.render` | `["document.read"]` | T33 |
| `document.toolDescribe` | `["document.read"]` | T33 |
| `document.toolsList` | `["document.read"]` | T33 |
| `document.toolCall` | `null`（不可委托） | T33 + T34 |
| `document.markdownEdit` | `null`（不可委托） | T33 + T34 |
| `framework.list` | `["setting.read"]` | T34 `f09f4912` |
| `framework.save` | `["setting.write"]` | T34 |
| `framework.reset` | `["setting.write"]` | T34 |

所以**本卡不需要修漂移，只需要补守卫**。这与总控在派活时的判断一致。

### 1. 我自己先走错了一次（如实记录）

第一版守卫我写成「**所有**方法必须在 `policy.ts` 的四张显式表里」——跑出来 **204 条报错**。

那不是漂移，是**我把 `policy.ts` 的设计当成了缺陷**。它的文件头写着：

> 判定顺序:显式表(BLOCKED → 凭据本体 → DANGER → WRITE/READ/UI 例外)→ 按动词猜 → 兜底 `write`。
> **兜底是 write 而不是 read —— 新加的 RPC 没人来归类时,宁可多问一次。**

兜底是**有意的**。要求全部显式分档 = 要求重写 policy.ts，超出本卡边界（也不该由生成器决定）。

### 2. 根因：兜底对 agent 是「多问一次」，对扩展是「直接发权限」

同一条兜底，两条路后果不同：

- **agent 侧**：兜底判 `write` → 弹一次审批卡。安全方向正确。
- **扩展侧**：兜底判 `write` → 生成器按 `writePerm[domain]` **发一张域写权限**；
  判 `read` → 发域读权限。**没有人对「该不该给扩展」做过决定**，而且生成器不报错。

实测证明这个洞真实存在（探针，只读）：

```
document.brandNewRead   level=write   reason=undefined   ← 明明只读
document.brandNewWrite  level=write   reason=undefined
someNewDomain.list      level=read    reason=undefined   ← 明明要写
```

`policyFor` 的返回值**分不出**「显式写了」和「兜底猜的」——`git.checkout`（EXPLICIT，write）
与 `document.brandNewWrite`（兜底，write）的 `level` 和 `reason` 完全相同。

### 3. 守卫：判据是「新方法」，不是「所有兜底方法」

`gen-module-permission-map.mjs` 新增一段，在生成 `mapped` **之前**执行：

1. **快照**：`git show HEAD:packages/contracts/src/appPermission.ts` 取上一次生成的结果
   （**不是工作区文件**——否则本地漂移看不见）。目录里有、快照里没有 = 新方法。
2. **新方法三选一才放行**：
   - 在 `policy.ts` 的四张显式表里（BLOCKED / CREDENTIAL_BEARING / DANGER / EXPLICIT）；
   - 在生成器自己的 `overrides` / `nonDelegableOverrides` 里（已逐条写了理由）；
   - 在新增的 `REVIEWED_FALLBACKS` 里**逐条签字**（写明为什么兜底档位对扩展安全）。
3. **三条都不满足 → `process.exit(1)`**，并逐条打印方法名 + 兜底档位 + **它会拿到哪张权限**。

读 `policy.ts` 的四张表用**解析源码文本**（它们没有导出，`policyFor` 又分不出来）。
与生成器读 `apiCatalog.generated.ts` 是同一手法。

**守卫自检**：读到的表条目 < 100 就报错说「表形状变了，先修 `keysOfTable`」——
否则表一改名，全仓库 453 条会被报成「新方法」，那是误导性极强的假红。

**为什么不改 `policy.ts`**：它是 T33 的独占文件（卡面边界），且兜底本身没错。

### 4. 变异证据（两次，各自定点）

**变异 A —— 让守卫短路**（`if (false && unreviewed.length > 0)`）：

```
FAIL ★ 新方法 → 生成器 exit 1 — {"status":0}
FAIL ★ 错误里点名了那条新方法 — ""
FAIL ★ 错误说明了它会拿到哪张权限 — ""
FAIL ★ 错误给了两条出路(显式分档 / REVIEWED_FALLBACKS)
FAIL ★ 失败时不写 appPermission.ts — {"changed":true}
t45-permission-map-drift-smoke: 15/20 通过
```
`cmp` 逐字节还原。

**变异 B —— 只破坏「失败时不写」**（在 `process.exit(1)` 前先 `writeFileSync` 一个坏文件）：

```
FAIL ★ 失败时不写 appPermission.ts — {"changed":true}
t45-permission-map-drift-smoke: 19/20 通过
```
**只有那一条红**，证明它是定点断言不是连带绿。还原后 `git status` 对
`appPermission.ts` 为空。

> 顺带记一次自己的失误：变异 B 第一次写成了 Python 里的 `"...\n..."`（真换行），
> 生成器变成语法错误，套件 14/20 红——那是**变异脚本坏了**，不是断言管用。
> 改用反引号模板串后重做，才是上面这条干净的 19/20。

**变异 C —— 往目录插一条新方法**（套件第 ③ 节内置，每次跑都执行）：
在 `apiCatalog.generated.ts` 里插入 `document.brandNewRead` → 生成器 **exit 1**、
错误点名该方法、说明「兜底 `write` → 会发给扩展 `document.edit`」；`finally` 逐字节还原，
并用 `git status --porcelain` 断言目录文件干净。

### 5. 测试

```
bash apps/desktop/scripts/t45-permission-map-drift-smoke/run.sh   # 20/20
bash apps/desktop/scripts/t33-document-policy-smoke/run.sh        # 30/30
bash apps/desktop/scripts/module-permissions-smoke/run.sh         # 全绿（含 4 条内置变异 RED）
node --experimental-strip-types apps/desktop/scripts/gen-module-permission-map.mjs  # exit 0，零 diff
npx tsc --noEmit -p packages/contracts/tsconfig.json   # exit 0
npx tsc --noEmit -p apps/desktop/tsconfig.json         # 我的两个文件 0 条错误
```

> `module-permissions-smoke` 在 T19 回写里记的那条既有红（`Unmapped RPC method: document.apps`）
> **已经消失**——T33/T34 落地后目录与映射对齐了。

### 6. 未做的事

- **没有给 `framework.*` 做额外的安全论证**：T34 已把它们映射到 `setting.read` / `setting.write`，
  本卡只验证生成器不报新方法，不改它们的档位（那是 T34 的边界）。
- **没有改 `policy.ts` 的兜底逻辑**（卡面明确禁止，且它本身是对的）。
- **`REVIEWED_FALLBACKS` 现在是空表**——这是对的：当前仓库没有「该走兜底」的新方法。
  它的价值在**下一次有人加 RPC 时**：要么显式分档，要么在这里签字，不能静默通过。
- **没有验证「生成器被绕过」（有人手改 `appPermission.ts`）** —— 那属于另一类防御
  （`module-permissions-smoke` 的 closed-world 断言覆盖了一部分），不在本卡。
- 真实 Electron U1 与本卡无关（纯工具链/安全分类）。

### 7. 提交

见下方提交 SHA。
