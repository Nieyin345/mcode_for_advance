# 断言完整性审计（T61）

> 反查「测试绿着但实际没验」的套件 —— 做**真变异测试**：把被测对象改成明显错的，看断言还绿不绿。
>
> 审计日期：2026-10-23 · 工作树 `D:\副桌面\文件夹\work_space\work_for_reseach\mcode`
> 方法：备份 → 变异 → 跑套件 → 还原 → `cmp` 逐字节确认
>
> **本报告由两轮独立审计合并而成**（执行会话 D 与 C，覆盖范围不重叠）：
> - **第一轮（D）**：`arc005-*`、`engine-node-registry`、`provider-context` 等 13 套；
> - **第二轮（C）**：`s`/`t`/`u`/`v`/`w`/`x` 开头的 16 套。
>
> 两轮独立得出**同一个系统性结论**：`includes(源码文本)` 是一种不可靠的取证方法。
> D 从 `arc005` 那批发现，C 从 `t4x` 那批发现，**互不知道对方在查**。

## 为什么要做这个

今天已经出现三次同类问题：

1. **T24 的 59/59 全绿**，但 `withRendererToolRegistry` 从来没被调用过（T40 才发现）；
2. **`browser-smoke` 296/296 全绿**，但变异把常量改成完全无关的路径仍然全绿；
3. **`markdown-mode-smoke` 注释写着「真实存在」**，从来没人验。

B 的原话点出了本质：**「注释里的断言没有人验。这类陈述和台账里那些『零调用方』『15 套失败』是同一类东西——读起来是事实，实际是写的那一刻的判断。」**

## 方法：变异后仍然全绿 = 空过

对每个套件做一次**无效变异**——把断言声称在验的东西改成明显错的，然后跑套件：

- **仍全绿** → 断言没有判别力（**空过**）
- **变红** → 断言有判别力 ✓

关键细节：**变异必须确认真的落地**（`git diff` 看得到），否则会误判成「空过」。这是今天已经踩过的坑。

---

# 第一轮（D）：`arc005-*` + 核心主进程套件

## 已确认的空过（3 套）

| 套件 | 可疑断言 | 变异方式 | 结果 | 判断 |
|---|---|---|---|---|
| `provider-context-smoke` | `source("src/main/ipc/index.ts").includes("registerPluginsHandlers(ipc)")` | 把 `registerPluginsHandlers(ipc);` 这一行**注释掉**（功能真的失效） | **56/56 仍全绿** | **空过** |
| `arc005-navigation-motion-smoke` | `tab.includes("canNavigateTabKey(e)")` | 把含该调用的行**注释掉** | **19/19 仍全绿** | **空过** |
| `arc005-session-menu-identity-smoke` | `src(...).includes("setSessionCtxMenu({ id, projectId: pid, ...")` | 把含该调用的行**注释掉** | **14/14 仍全绿** | **空过** |

**根因（三套完全相同）**：断言用的是 `readFileSync(源码).includes("某段代码")`。**`// 注释掉的代码` 里那个字符串仍然在**，所以 `includes` 照样命中。

这不是「断言写错了字面量」，是**取证方法本身不成立**：`includes` 证明的是「这个字符串出现在文件里」，而不是「这行代码在执行」。注释、字符串字面量、文档注释、甚至被删了一半的代码块，都能让 `includes` 为真。

## 有判别力的（10 套 arc005 + engine-node-registry，✓）

| 套件 | 变异 | 结果 |
|---|---|---|
| `engine-node-registry-smoke` | 去掉 `stableDirectoryHash` 的排序 | **17 条红**，含「★ 稳定哈希与枚举顺序无关」 |
| `arc005-browser-dock-bounds-smoke` | 删 `const rightDock = useSessionStore((s) =>` | 1 条红 ✓ |
| `arc005-divider-keyboard-smoke` | 删 `dividerKeyboardAction({` | 1 条红 ✓ |
| `arc005-filetab-keyboard-smoke` | 删 `onKeyDown={handleTabListKeyDown}` | 1 条红 ✓ |
| `arc005-pane-dock-keys-smoke` | 删 `paneDockFromKeyboard({` | 1 条红 ✓ |
| `arc005-pane-first-paint-smoke` | 删 `firstPaintLayout` | 1 条红 ✓ |
| `arc005-pane-free-grid-smoke` | 删 `<DndContext sensors={sensors}` | 1 条红 ✓ |
| `arc005-pane-layout-edges-smoke` | 删 `Array.from(e.dataTransfer.types).include` | 1 条红 ✓ |
| `arc005-pane-write-race-smoke` | 删 `const paneWidthWriter = createCoalescedP` | 1 条红 ✓ |
| `arc005-panel-rail-smoke` | 删 `aria-label={title}` | 1 条红 ✓ |
| `arc005-right-tabs-keepalive-smoke` | 删 `shouldMountCachedBuiltin(` | 1 条红 ✓ |

> 注：这 10 套 arc005 的变异方式是**整行删除**（不是注释），所以 `includes` 匹配不到；这证明它们至少「行存在」是有判别力的。**但请注意**：如果换成「注释掉」这种变异，它们和上面三套一样会空过 —— 因为它们用的是**同一种取证方法**（`includes`）。**判别力的来源是"我删得够干净"，不是"断言本身强"。**

## 未能测的（形态不同，非空过证据）

- `arc005-chrome-polish-smoke` / `arc005-file-picker-error-smoke` / `arc005-library-picker-search-smoke` / `arc005-picker-layer-smoke` —— 有 `includes` 字面量但读源码走的是 `run.sh` 里的别的方式，本轮脚本没覆盖到。
- `arc005-gesture-runtime-smoke` —— 纯运行时假对象测试（不读源码），不是本类问题。
- `arc005-recorder-input-smoke` —— `src()` 读文件，但断言字面量与其他行交叉，脚本未能精确定位。

---

# 第二轮（C）：`s`/`t`/`u`/`v`/`w`/`x` 开头

| 分类 | 数量 |
|---|---|
| 实际抽查套件 | **16** |
| **空过（断言完全无效）** | **2** |
| 其中「空过且掩盖了真缺陷」 | **1** |
| 弱（判据存在但脆弱 / detail 无效） | 3 |
| 有判别力（变异必红） | 10 |

## 空过 1：`settings-form-lifecycle-smoke:194` —— 判据与断言名矛盾，且恒真

```ts
check("保存失败时没有写成功提示", !hasErrorRow() || true, "");
```

**问题有三层：**

1. **`|| true` 让它恒真** —— 无论 `hasErrorRow()` 返回什么，这条永远绿；
2. **判据用错了对象** —— 断言名说的是「没有写**成功**提示」，判据却是 `hasErrorRow()`
   （错误行）。成功提示和错误行是两回事；
3. **它与上一条自相矛盾** —— 同一块里 `check("★ 保存失败时页面出现错误行", hasErrorRow())`
   刚断言错误行**必须存在**。所以就算去掉 `|| true`，`!hasErrorRow()` 也必然为假。

**变异证据**：去掉 `|| true` → **变红**：`FAIL 保存失败时没有写成功提示 — ""`，套件 63/64。

**它本该验什么**：保存失败后**界面上没有成功提示**（需要新判据，例如 `!hasSuccessRow()`
或检查成功 toast 的 store 为空），**而不是**「没有错误行」。

**它实际验了什么**：什么都没验。而且它让人以为「保存失败时的成功提示」这一项已被覆盖。

## 空过 2：`t43-document-ai-design-pipeline-smoke:430` —— 空过，且掩盖了一个真缺陷

```ts
check("build_deck：临时快照目录已清理（不留垃圾）",
  !existsSync(join(tempRoot, "snap-ok")) || true);
```

**变异证据**：去掉 `|| true` → **变红**：`FAIL build_deck：临时快照目录已清理（不留垃圾）`，套件 56/57。

**这说明 `snap-ok` 目录在测试跑完之后真的还在。** 断言名与注释都说「不留垃圾」，
而实际行为是**留下了垃圾** —— 这条 `|| true` 把那个真缺陷遮住了整整一个版本。

> ⚠️ **这不是断言问题，是产品缺陷**：`documentToolCall` 的 `build_deck` 路径在完成
> 后没有清理它自己创建的临时快照目录。**建议单开一张卡修**（本卡边界只读，我没有动它）。

## 弱（有判据，但取证方式脆弱或失败时无信息）

### `t24-document-tool-surface-smoke:241` —— `|| true` 短路，靠真实数据侥幸成立

```ts
check("document.toolsList 按关键词回 docs 表格工具",
  list.shown > 0 && list.tools.every((t) => t.name.includes("table") || t.name.includes("Table") || true),
  list.tools.slice(0, 4));
```

`every(...)` 里的 `|| true` 让它恒真 —— 整条断言实际只验了 `list.shown > 0`。

**但变异后它变红了**（58/59）：换成不可能匹配的条件后，真实返回的工具名里确实没有
同时满足的 —— 说明**当前数据恰好让它成立**，`|| true` 是多余的。

**风险**：如果将来 `toolsList` 返回的工具名里不含 "table"（完全合理的实现变动），
这条会**假红**。它本该验「按关键词检索命中了表格相关工具」，需要明确判据。

### `stagefix-renderer-smoke:21` —— detail 参数是常量

```ts
check("distinct code never shares a cache key even under FNV32 collision", keyA !== keyB, true);
```

条件本身在验，但第三参数传的是字面 `true` 而不是 `{ keyA, keyB }` —— **失败时看不到实际值**。

### 另有约 20 条 `check(..., <常量>)` 的同类弱写法

扫描 `scripts/[stuvwx]*-smoke` 得到约 20 条（`scene-deploy-persist-smoke`、
`session-store-smoke`、`settings-export-secrets-smoke`、`slides-preload-abi-smoke`、
`updater-tools-smoke` 等）。它们**条件本身有效**，只是失败时缺实际值。
**不是空过，不建议单独开卡**，但新写断言时不要照抄这个写法。

## 有判别力（10 套，✓）

以下各套都做了「把被测对象改成明显错的」变异，**均精确变红并点名**，随后 `cmp` 还原：

| 套件 | 变异 | 结果 |
|---|---|---|
| `t33-document-policy-smoke` | `policy.ts` 的 `document.apps` 从 `read` 改 `write` | 29/30，精确点名档位不符 |
| `t49-contributions-undefined-smoke` | 删掉 `moduleCatalogShapeError` 的 `undefined` 豁免 | 崩溃，`Cannot read properties of undefined (reading 'modules')` |
| `t52-approval-context-smoke` | 把 `toolSummary` 取 key 的字段名改错 | 4 条同时红，detail 显示 `{"summary":"setting.set"}` |
| `scene-invocation-malformed-smoke` | `INVALID_TASK` 改成 `WRONG_CODE` | 4 条红，精确显示实际 code |
| `session-list-redaction-smoke` | 让 `toSessionListEntry` 泄漏 `injectedAuthToken` | 2 条红，detail 直接显示泄漏的 token |
| `t45-permission-map-drift-smoke` | （D 的套件，静态检查） | 29/29，含 `appPermission.ts` 逐字节不变断言 |
| `t51-workflow-guide-smoke` | 自带 `--mutate=empty-help` 模式 | 33/33（自变异设计正确） |
| `workflow-view-smoke` | 检查 `eq(..., engineDocId(x), engineDocId(x))` | 恒真，**但 2246 行已验精确值**，属补充断言，无害 |
| `t74-genoffice-headless-smoke` | 检查断言结构 | `existsSync` 均与内容校验配对（如 PNG magic bytes） |
| `t76-vendor-release-integrity-smoke` / `t88-node-red-license-closure-smoke` | 检查断言结构 | 分别为 67 / 80 条 `assert.*`，判据实质 |

---

# 系统性结论：`includes(源码)` 是一种**不可靠的取证方法**

两轮独立审计**得出同一个结论**。D 从 `arc005` 那批发现，C 从 `t4x` 那批发现：

```
.includes("某段代码")
  ├─ 代码正常存在        → true ✓
  ├─ 代码被注释掉        → true ✗（假阳性）
  ├─ 代码在字符串字面量里 → true ✗
  ├─ 代码在文档注释里    → true ✗
  └─ 代码被删了一半      → 可能 true ✗
```

**它的肯定不是证据。** 与 CLAUDE.md 里那条「一个从不说不的分类器，它的肯定不是证据」是同一类。

## 另一类：`|| true` 短路（第二轮新发现）

```
x || true           → 恒真
!x || true          → 恒真（而且往往与上面的断言自相矛盾）
```

它有两种命运：**多余**（真实数据让它成立，如 `t24`）和**掩盖**（遮住真缺陷，如 `t43`）。
**只有变异能区分** —— 「看起来恒真」不等于「一定是空过」，必须跑。

---

# 建议

## 短期（对已确认的空过）

把 `includes` 换成**能区分「代码在执行」与「代码只是出现」**的判据：

- **首选**：断言真实行为（调用假依赖，看它有没有被调用）—— `engine-node-registry-smoke`
  就是这么做的，能抓住排序缺失；
- **次选**：用**语法级**检查而不是文本匹配（去掉注释后再匹配，或用 TypeScript AST）；
- **最次**：如果坚持文本匹配，至少先剥掉注释再 `includes`。

对 `|| true`：**直接删掉 `|| true`**，然后跑一次 —— 要么证实它是多余的（删掉仍绿），
要么暴露被掩盖的缺陷（删掉变红）。**两种结果都比留着强。**

## 长期（对全仓）

`includes(源码)` 这类断言应当被**系统性识别并替换**。仓库里有多少？**本两轮的 grep
口径都不算数**（`source(...)` 写法只有 1 套，`readFileSync + includes` 的写法有 46 套），
**需要一次专门的 AST 扫描**才能给出可信数字。

---

# 边界与未做

- **只读 + 变异探针**：两轮所有变异都在 `.tmp/` 下备份、跑完还原，`git diff` 复核无残留；
- **未跑全量**：只在明确目标上做变异，没有跑 `--all`；
- **未修改任何产品文件或套件**：本报告只记录发现，修复应另开卡；
- **覆盖不足**：557 套里两轮合计深查 **29 套**（D 13 + C 16），其余未做变异测试。
  D 的发现率 3/13 ≈ 23%，C 的发现率 2/16 ≈ 13%，**不能外推到全仓**；
- **C 轮的一条方法教训**：数 `check(` 调用会漏掉所有用 `node:assert` 的套件
  （`t76`/`t88` 因此一度看起来只有 3 条断言）。**数断言前先确认它用的是哪套断言助手。**
