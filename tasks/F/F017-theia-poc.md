# F017｜Theia PoC：`plugin-ext` 到底能不能接进 Mcode

- Status: ready-for-agent
- Category: **PoC / 可行性验证**（不改产品代码）
- Depends on: 用户裁决「贴合 VS Code 扩展机制，尽可能复用 VS Code 扩展」
- Exclusive writable files:
  - 新建 `.tmp/theia-poc/`（**全部产物都在这里，不进 git**）
  - `tasks/F/F017-theia-poc.md` 回写
- **不碰**：`apps/desktop/**`、`packages/contracts/**`、`package.json`、`pnpm-lock.yaml`

## Required Skills
- 无特殊。需要会读源码、会装包、会写探针。

---

## 这张卡要回答的唯一问题

> **`@theia/plugin-ext` 能不能在没有完整 Theia 应用的情况下，接进 Mcode 现在的 Electron，跑起一个真实的 VS Code 扩展？**

**不是「设计上应不应该接」，是「技术上能不能」。**

---

## ⚠️ 先纠正一个数据（我写卡前实测的）

`docs/planning/extension-vscode-compat.md` §6.1 写的是 **19 个直接依赖**。

**那是 `@theia/plugin-ext-vscode`（包装层）的数字。真正的 `@theia/plugin-ext@1.76.0` 有 48 个直接依赖：**

```
@theia/ai-core  @theia/ai-mcp  @theia/bulk-edit  @theia/callhierarchy
@theia/console  @theia/core  @theia/debug  @theia/editor
@theia/editor-preview  @theia/file-search  @theia/filesystem  @theia/markers
@theia/messages  @theia/monaco  @theia/monaco-editor-core  @theia/navigator
@theia/notebook  @theia/output  @theia/plugin  @theia/plugin-utils
@theia/preferences  @theia/scm  @theia/search-in-workspace  @theia/task
@theia/telemetry  @theia/terminal  @theia/test  @theia/timeline
@theia/typehierarchy  @theia/variable-resolver  @theia/workspace
+ node-pty / decompress / vscode-textmate / @vscode/debugprotocol 等 17 个非 theia 包
```

**这 48 个里，`@theia/core` / `@theia/monaco` / `@theia/editor` 会把整个 Theia 编辑器拖进来。**

**所以「只取 plugin-ext 不引入完整 Theia」这个想法，从依赖表看是不成立的。** PoC 要验证的正是这件事的实际后果。

---

## 三个必须回答的问题（按顺序，前一个不成立就不必往下做）

### ① 装得进来吗？

```
- `@theia/plugin-ext@1.76.0` 能否与 Electron 44 + 现有 Monaco 0.56 共存？
- 依赖冲突有哪些？（`@theia/monaco-editor-core` 会带自己那份 Monaco）
- `node-pty` 是原生模块，在 Windows + Electron 44 上要 rebuild —— 能过吗？
```

**产出**：一份「装了什么、冲突在哪、哪些是硬冲突」的清单。

**如果装不进来 → 这张卡就结束，结论「不可行」+ 冲突清单。** 不必往下。

### ② 能不能**只**用它的扩展宿主？

Theia 的 `plugin-ext` 是一组 DI（依赖注入）模块，靠 `@theia/core` 的容器装配。
**问题是：能不能装配出「只有扩展宿主、没有 Theia 的 UI/编辑器」的一个实例？**

**要查的源码**：

```
node_modules/@theia/plugin-ext/lib/*/plugin-*.js        ← 宿主入口在哪
node_modules/@theia/plugin-ext/lib/hosted/node/         ← 子进程宿主
node_modules/@theia/plugin-ext/lib/plugin/plugin-manager*.js  ← 扩展生命周期
```

**关键判断**：`plugin-ext` 是否硬依赖 Theia 的 `Application` / `Shell` / `EditorManager`。

**如果能装配出「无 UI 的扩展宿主」** —— 那 Mcode 只需要提供它要的接口（文件系统、编辑器代理），那是**薄适配**。
**如果它硬依赖 Theia 的 UI** —— 那「只取宿主」不成立，等于整个 Theia。

### ③ 真跑一个扩展

**如果能走到这一步**，用本机已有的最小真实扩展（`siesta.vscode-pdf-translate`，7 KB、只用 `vscode` + `path`）：

```
- 它能不能被加载？
- 它的 3 条命令能不能注册？
- `activate()` 能不能跑？
```

**不需要跑通它的全部功能**（那要 PDF 编辑器），只要 `activate()` 不崩、命令出现在列表里，就说明宿主是活的。

---

## 边界（很严，因为这是 PoC）

**只写 `.tmp/theia-poc/`。** 具体：

- 所有 `npm install` 都在 `.tmp/theia-poc/` 里做，用独立的 `package.json`
- **不修改仓库的 `package.json` / `pnpm-lock.yaml`**
- **不修改 `apps/desktop/**`** 任何文件
- 探针脚本放 `.tmp/theia-poc/probe-*.mjs`

**为什么这么严**：这是可行性验证，不是实现。**一次失败的装包不能污染主仓库的依赖树。**

---

## 验收判据

1. **① 的结论有实测**（装了 / 没装成 + 具体冲突清单），不是「查了 npm 元数据」；
2. **② 的结论引用源码行号**（`plugin-ext` 的哪个文件硬依赖哪个 Theia 服务）；
3. **③ 只有在 ①② 都成立时才做**，做到哪一步算哪一步；
4. **最终给一个明确的「能 / 不能 / 有条件能」**，并说明条件是什么；
5. **仓库 `git status` 里不能出现 `package.json` / `pnpm-lock.yaml` 的改动**（提交前自查）。

---

## 切分指令（最重要的部分）

**这张卡允许「做不到」的结论。** 而且**「做不到」比「硬做出来」更有价值** —— 因为:

- 「做不到 + 为什么」→ 用户能据此决定要不要走另一条路；
- 「硬做出来但很脏」→ 会诱导后面的人继续投入。

**所以：每一步都要如实记「卡在哪」，不要为了让 PoC 成功而绕过障碍。**

**特别是**：如果 ① 就装不进来（依赖冲突、原生模块编译失败），**立刻停下**，写清冲突清单，不要试图「先装个旧版本试试」——那是另一个问题。

---

## 回写

`tasks/F/F017-theia-poc.md` 末尾 `## 结果回写`：

1. **能不能装**（贴 `npm install` 的实际输出/错误）；
2. **原生模块 `node-pty` 在 Windows + Electron 44 上的结果**；
3. **`plugin-ext` 是否硬依赖 Theia UI**（引用源码行号）；
4. **最终结论：能 / 不能 / 有条件能**，条件是什么；
5. **对 `extension-vscode-compat.md` §6.1 的修正建议**（那个 19 应该改成 48，且「自建更省」那条已被证伪）；
6. 仓库 `git status` 确认没污染主依赖树。
