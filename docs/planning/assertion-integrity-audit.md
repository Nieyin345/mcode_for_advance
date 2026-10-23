# 断言完整性审计（T61）

> 反查「测试绿着但实际没验」的套件 —— 做**真变异测试**：把被测对象改成明显错的，看断言还绿不绿。
>
> 审计日期：2026-10-23 · 工作树 `D:\副桌面\文件夹\work_space\work_for_reseach\mcode`
> 方法：备份 → 变异 → 跑套件 → 还原 → `cmp` 逐字节确认

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

## 审计结果

### 已确认的空过（3 套）

| 套件 | 可疑断言 | 变异方式 | 结果 | 判断 |
|---|---|---|---|---|
| `provider-context-smoke` | `source("src/main/ipc/index.ts").includes("registerPluginsHandlers(ipc)")` | 把 `registerPluginsHandlers(ipc);` 这一行**注释掉**（功能真的失效） | **56/56 仍全绿** | **空过** |
| `arc005-navigation-motion-smoke` | `tab.includes("canNavigateTabKey(e)")` | 把含该调用的行**注释掉** | **19/19 仍全绿** | **空过** |
| `arc005-session-menu-identity-smoke` | `src(...).includes("setSessionCtxMenu({ id, projectId: pid, ...")` | 把含该调用的行**注释掉** | **14/14 仍全绿** | **空过** |

**根因（三套完全相同）**：断言用的是 `readFileSync(源码).includes("某段代码")`。**`// 注释掉的代码` 里那个字符串仍然在**，所以 `includes` 照样命中。

这不是「断言写错了字面量」，是**取证方法本身不成立**：`includes` 证明的是「这个字符串出现在文件里」，而不是「这行代码在执行」。注释、字符串字面量、文档注释、甚至被删了一半的代码块，都能让 `includes` 为真。

### 有判别力的（13 套，✓）

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

### 未能测的（形态不同，非空过证据）

- `arc005-chrome-polish-smoke` / `arc005-file-picker-error-smoke` / `arc005-library-picker-search-smoke` / `arc005-picker-layer-smoke` —— 有 `includes` 字面量但读源码走的是 `run.sh` 里的别的方式，本轮脚本没覆盖到。
- `arc005-gesture-runtime-smoke` —— 纯运行时假对象测试（不读源码），不是本类问题。
- `arc005-recorder-input-smoke` —— `src()` 读文件，但断言字面量与其他行交叉，脚本未能精确定位。

## 最严重的三条

### 1. `provider-context-smoke` —— 空过，且验的是装配路径

```ts
check("全局插件 handler 继续注册", source("src/main/ipc/index.ts").includes("registerPluginsHandlers(ipc)"));
```

这条声称在验「插件 handler 被注册」。把调用注释掉后仍绿。**这正是 T40 那种「装配路径没验到」的同一形态。**

### 2. `arc005-navigation-motion-smoke` —— 空过

```ts
check("tab navigation ignores IME keyCode229 and Shift", tab.includes("canNavigateTabKey(e)") && ...);
```

注释掉调用后仍绿。**键盘导航的实际行为没有被验。**

### 3. `arc005-session-menu-identity-smoke` —— 空过

```ts
check(..., src(...).includes("setSessionCtxMenu({ id, projectId: pid, ...")
```

注释掉后仍绿。**会话标签右键菜单的身份绑定没有被验。**

## 系统性结论：`includes(源码)` 是一种**不可靠的取证方法**

本轮审计里，**凡是「读产品源码 + includes」的断言，用「注释掉」做变异都会空过**。这不是个案：

```
.includes("某段代码")
  ├─ 代码正常存在        → true ✓
  ├─ 代码被注释掉        → true ✗（假阳性）
  ├─ 代码在字符串字面量里 → true ✗
  ├─ 代码在文档注释里    → true ✗
  └─ 代码被删了一半      → 可能 true ✗
```

**它的肯定不是证据。** 与 CLAUDE.md 里那条「一个从不说不的分类器，它的肯定不是证据」是同一类。

## 建议

### 短期（对已确认的 3 套）

把 `includes` 换成**能区分「代码在执行」与「代码只是出现」**的判据：

- **首选**：断言真实行为（调用一个假的依赖，看它有没有被调用）—— `engine-node-registry-smoke` 就是这么做的，147 条里 17 条能抓住排序缺失。
- **次选**：用**语法级**检查而不是文本匹配（去掉注释后再匹配，或用 TypeScript AST）。
- **最次**：如果坚持文本匹配，至少先剥掉注释再 `includes`。

### 长期（对全仓）

`includes(源码)` 这类断言应当被**系统性识别并替换**。仓库里有多少？本轮的粗扫口径不一（`source(...)` 写法只有 1 套，`readFileSync + includes` 的写法有 46 套），**需要一次专门的 AST 扫描**才能给出可信数字 —— 本轮的 grep 口径不算数。

## 边界与未做

- **只读 + 变异探针**：所有变异都在 `.tmp/` 下备份、跑完还原，`git diff` 复核无残留。
- **未跑全量**：本审计只在明确目标上做变异，没有跑 `--all`。
- **未覆盖**：557 套里本轮只深查了 13 套（10 套 arc005 + engine-node-registry + provider-context + 2 套批量），**其余 544 套未做变异测试**。本轮发现率 3/13 ≈ 23%，不能外推到全仓。
- **未修改任何套件**：本报告只记录发现，修复应另开卡。
