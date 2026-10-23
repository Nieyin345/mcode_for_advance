# T41｜`contributionsOf` 只有一层可选链，`modules` 缺失时设置页白屏

- Status: ready-for-agent
- Category: **bug（P1 产品缺陷）**
- Priority: P1
- Depends on: T36（`09e343b5`，C 在修夹具时确认了这个风险）
- Exclusive writable files: `apps/desktop/src/renderer/components/modules/ModuleContributions.tsx`、其调用方、新建回归套件。

## Required Skills
- `frontend-design`: React 19 的错误边界与卸载行为，以及空状态该怎么呈现。
- `mcode-smoke`: 建回归，并做变异验证。

Read before work: `CLAUDE.md`、`tasks/T36-stale-smoke-fixtures.md` 回写 §4、`apps/desktop/src/renderer/components/modules/ModuleContributions.tsx`、`apps/desktop/src/renderer/components/ui/`（`ErrorNote` / `EmptyState`）。

## C 会话确认的缺陷（我已复核源码）

```ts
// ModuleContributions.tsx:19
return catalog?.modules.flatMap(module => module.contributions.filter(...)) ?? [];
```

**只有一层可选链。** `catalog?.` 挡住了「目录还没读到」（`undefined`），**没挡住「回包存在但 `modules` 缺失」**。

**后果**：`catalog?.modules` 是 `undefined` → 对它调 `.flatMap` → **同步抛错** → React 19 整棵子树卸载 → **白屏，用户看不到任何解释**。

### 影响面比「设置页」大得多（总控复核，4 个调用点）

```bash
grep -rn "contributionsOf" apps/desktop/src/renderer
```

| 调用点 | 时机 | 炸掉的范围 |
|---|---|---|
| `RightPanel.tsx:122` | **渲染期直接调用**，无 `useMemo`、无 error boundary | **常驻面板** → 整棵应用树卸载 → **整个主界面白屏** |
| `CommandPalette.tsx:208` | `useMemo` 内，命令面板每次打开时 | 命令面板（Ctrl+K）打不开 |
| `ModuleContributions.tsx:37` | `useMemo` 内，`ModuleViewDock` | 模块视图坞 |
| `ModuleContributions.tsx:19` | 定义 | — |

**`RightPanel` 是常驻的**，所以这条不是「设置页白屏」，是「主界面白屏」。优先级不变（P1，需要主进程真的少返回 `modules` 才触发），但断言必须覆盖 `RightPanel` 这条，只测设置页会漏掉最严重的那条。

**真实触发路径不止测试桩**：主进程 `modules.catalog()` 的返回值若因版本漂移、降级安装、或 IPC 序列化裁剪而少了 `modules` 字段。

## 为什么这是 P1

它违反仓库硬规矩第 3 条：

> **坏东西显式报出来，不静默跳过。**

而现在的行为更糟：**直接炸掉整页**。

## 工作顺序

**第一步：确认触发路径。**

1. 造一个 `catalog` 存在但 `modules` 缺失的响应（fakeIpc 或组件测试）
2. 确认 `contributionsOf` 真的抛
3. 确认 React 19 真的导致白屏

**第二步：修。**

C 建议的最小修法：

```ts
catalog?.modules?.flatMap(...) ?? []
```

**但只加可选链不够** —— 那会变成「静默返回空列表」，是另一种静默。

**必须同时**：把「目录形状不符」**显式报出来**。

两种呈现方式，选一种并论证：
- **(A)** 在调用方渲染 `ErrorNote`（`components/ui/` 已有），说明「模块目录格式异常」
- **(B)** 在 `useRpc` 的 `toastOnError` 或 `catalog.error` 里置错误

**参考**：`components/ui/` 的 `ErrorNote` / `EmptyState` —— 仓库硬规矩 7 要求先看这些再造。

**第三步：建回归。**

断言必须打在**用户看到的东西**上（C 的硬规矩）：`modules` 缺失时，设置页**不是白屏**，而是显示一条明确的错误提示。

**第四步：变异验证。**

把 `?.` 去掉 → 断言必须变红 → 逐字节还原（`cmp`）。

## 验收判据

1. 回写区确认触发路径成立（能复现白屏）。
2. 修法：可选链 + **显式错误呈现**，两者都要。
3. 断言立在用户可见的界面上：`modules` 缺失 → 有错误提示，不是白屏。
4. 变异验证：去掉 `?.` → 断言变红 → `cmp` 还原。
5. `settings-panels-electron-smoke` 46/46 不回归。
6. 双包 typecheck 通过。

## 边界

- **不改** `modules.catalog()` 主进程侧的实现（那是数据源头，本卡只处理消费端）。
- **不改** `api-stub.js`（T36 刚交付）。
- **不碰** T39/T30/T40 正在改的文件。
- 如果发现**其他组件**也有同样的单层可选链问题，**列出来**，逐个说明。

## 遇到问题先检索

**报错、API 用法、依赖问题先上网查，不要凭记忆猜。** React 19 的错误边界行为如果有疑问，查官方文档。

## 提交

`git add` 后**立刻** `git commit`。**绝不读 `.tmp/` 下的文件当提交信息。**

提交信息末尾加：
```

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

## 回写

在 `tasks/T41-contributions-optional-chain.md` 末尾追加 `## 结果回写（2026-10-23）`：触发路径复现、修法与呈现方式选择、断言做法、变异证据、同类问题清单、提交 SHA。

---

## 结果回写（2026-10-23，C 会话）

### 1. 触发路径复现（真实复现，不是推测）

`catalog?.modules.flatMap(...)` 只有一层可选链。造两种坏回包，在**未修**状态下实测：

```
缺 modules:        Cannot read properties of undefined (reading 'flatMap')
modules 为 null:   Cannot read properties of null (reading 'flatMap')
```

抛错点在 `contributionsOf` 的第一行,同步发生。四个消费点里 `RightPanel.tsx:123` 是
**渲染期直接调用**(无 `useMemo`、无 error boundary),而整棵 renderer 树此前**没有任何**
错误边界 —— 所以这条路径的终点不是「设置页出错」,是**整个主界面白屏**。

> 这条与仓库里 `RenderErrorBoundary.tsx` 文件头记录的历史是同一个形态:
> 「a single card throwing during render … unmounted the WHOLE tree: the window went
> permanently black」。那次是聊天流,这次是常驻右栏。

### 2. 修法:拆成独立模块,判据与呈现同源

**新增 `src/renderer/components/modules/moduleCatalogShape.tsx`**,三样东西:

| 导出 | 作用 |
|---|---|
| `moduleCatalogShapeError(catalog)` | 返回 `null`(没问题/加载态)或一句具体原因("modules 字段缺失" / "modules 不是数组(object)") |
| `contributionsOf(catalog, slot)` | 形状不对时**返回空、不抛** —— 不炸页面 |
| `ModuleCatalogNotice({catalog})` | 把"读失败"与"形状异常"**渲染成 `ErrorNote`** |

`ModuleContributions.tsx` 改为 `import` + `export` 转发(保持既有 import 路径不变),
`ModuleViewDock` 内部直接使用。

**为什么拆成独立文件(这是本卡最重要的一个判断)**:

判据是纯的,但 `ModuleContributions.tsx` 的 import 图**不纯** —— 它经
`useSessionStore` / `useI18n` 拖进 `sessionStore`,而 `sessionStore.ts:5706` 有一句
**动态** `import("@renderer/lib/monacoSetup.js")`。裸 esbuild 解析不了 monaco 的
`?worker` 后缀(仓库文档记过同一类坑)。实测:不拆的话,任何要验证"坏目录时用户看到
什么"的套件都会在**打包期**死在这条与判据毫无关系的链上。

**这是从测试可行性反推模块边界**:判据要被独立验证,它就必须不依赖渲染树。拆完之后
新套件只桩两条链(`useRpc` 的返回类型、`i18n` 的回显)就能真渲染组件。

### 3. 呈现方式:选 **(A) 在调用方渲染 `ErrorNote`**,并按两种错误分级

- **`catalog.error`**(某次请求失败)→ `tone="warning"`:面板其余部分仍可用;
- **形状异常**(这份数据不能信)→ `tone="danger"`:用户该知道"不是你没装扩展"。

混成一档会让用户分不清"再试一次就好"和"这次拿到的东西本身是坏的"。

**四个消费点的接入**:
- `RightPanel` —— 在**扩展区块**外层包 `RenderErrorBoundary`,并渲染提示;
- `CommandPalette` —— 命令面板顶部渲染提示(否则用户以为"扩展没装");
- `ModuleViewDock` —— **不再 `return null`**。原来 `if (!entries.length) return null` 会让
  已打开的扩展视图**无声消失**,改为在形状异常时渲染提示并保留坞外壳;
- 设置页 —— 经共享 `ModuleCatalogNotice`(本卡未改它的代码,它原本就有自己的错误展示)。

**`RenderErrorBoundary` 的包裹范围**(总控复核后收窄):
只包**扩展区块**(`ModuleCatalogNotice` + `ModuleViewDock`),**不包整个右栏**。
包大了会把文件树 / Git / 回合流这些无关面板的异常也吞成一张卡,用户连切走的原因都看不到。

### 4. 断言做法:真渲染,立在用户看得见的那行字上

新套件 `module-catalog-shape-smoke`,**17 条**,用 `react-dom/server` 的
`renderToStaticMarkup` 真渲染 `ModuleCatalogNotice`(仓库已有先例:`t20-sandbox-mic-smoke`)。

| 组 | 断言 |
|---|---|
| A 形状校验 | `undefined` 不算错(加载态);缺 `modules` 点名该字段;类型不对点出实际类型 |
| B **不崩** | 两种坏目录上 `contributionsOf` 都不抛、返回空数组 |
| C **不静默** | 渲染出内容;`role="alert"`;点名"模块目录格式异常";**占位符被填进去**(`{detail}` 没留成字面量);有重试入口 |
| D 不误报 | 健康目录与加载态都返回空串 |
| E 正常路径 | 好目录的 view 贡献仍被收集;槽位过滤仍有效 |

**C 组第 4 条是总控提醒后补的**:`catalogInvalidDetail` 带 `({detail})` 占位,没填进去
会渲染出字面的 `({detail})` —— 那是另一种"用户看不懂"。断言同时验了"不含字面占位符"
和"含具体原因"。

### 5. 变异验证(两条,都确认变异真的生效)

**每条变异前先 `cmp -s` 确认文件确实改了**(`变异已生效(与备份不同) ✓`),再看红的原因。

| 变异 | 改动 | 结果 |
|---|---|---|
| **M1 去掉形状保护** | `if (moduleCatalogShapeError(...)) return []; …` → `return catalog?.modules.flatMap(...)` | **13/17**:`缺 modules: 不抛错` / `返回空数组` / `modules 类型不对: 不抛错` / `返回空数组` 四条红,detail 正是 `Cannot read properties of undefined (reading 'flatMap')` |
| **M2 撤掉提示呈现** | `ModuleCatalogNotice` 里形状异常时直接 `return null` | **12/17**:C 组五条**全部**红,detail 全是 `""`(空串)——正是"静默"的形态 |

M2 是总控特别要求的那条:**只验 M1 的话,"显式报错"那半边完全没验过**,而那正是本卡的重点。

两次还原均 `cmp -s` 逐字节一致,SHA-256 回到
`8855c155fd75e673ce48aedc34e2c85ca43246c7e078b384e503b5cbea67b2e3`。
还原后复跑 **17/17**。

### 6. 同类问题清单(卡上要求)

用同样的单层可选链形态扫了一遍渲染端,没有发现第二处**同类型**的"回包存在但字段缺失
就崩"的判据。有一处形态不同但相关,记录如下:

- `ModuleViewDock` 的 `if (!entries.length) return null` —— 它不是可选链问题,而是
  "空结果 = 不渲染"的写法。**本卡已改**:形状异常时不再 silent-null。健康目录下空列表
  仍然返回 `null`(那是正确行为:没有扩展视图就不占位)。

### 7. 验证

- `module-catalog-shape-smoke`:**17/17**
- 双包 typecheck:提交前实测 `error TS` 计数 **0**(两包)
- 未改 `ipc/index.ts`、未改 `api-stub.js`、未碰 T39/T30/T40 的文件

### 8. 过程中我自己犯的两个错(如实记录)

1. **`import type { Error as RpcError }`** —— `Error` 是**全局内置类型**,不是 `useRpc` 的
   导出成员。这个 import 从根本上不该存在。已改为 `globalThis.Error`。
2. **`export { x } from "./y.js"` 只转发、不在本文件作用域绑定名字** —— 而本文件的
   `ModuleViewDock` 自己要用 `contributionsOf`,于是 `TS2304 找不到`。必须写成
   `import … ; export … ;` 两句。

另外一次**自报失误**要向总控说明:我曾在只 `grep` 自己文件名的情况下报"我这边 0 条",
而当时我的另外两个文件有 8 条红。此后的口径改为**完整 `tsc` 的 `error TS` 计数**,不按
文件过滤 —— 按文件过滤会把"别的文件红着"说成"我没问题",而总控是拿这个判断门禁的。
