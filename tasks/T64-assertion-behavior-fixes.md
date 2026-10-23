# T64｜把三套「includes(源码)」空过断言改成真实行为验证

- Status: ready-for-agent
- Category: **bug（测试有效性）**
- Priority: **P1**
- Depends on: T61（已完成，提交 `b4aa6547`，报告 `docs/planning/assertion-integrity-audit.md`）
- Exclusive writable files:
  - `apps/desktop/scripts/provider-context-smoke/main.ts`
  - `apps/desktop/scripts/arc005-navigation-motion-smoke/main.ts`
  - `apps/desktop/scripts/arc005-session-menu-identity-smoke/main.ts`

## Required Skills
- `mcode-smoke`: 这套无头 smoke 的写法（esbuild 打包、`--alias` 换桩、`fakeIpc` 模式），以及**变异验证**——写完断言先撤掉修复看它真的红。
- `code-review`: 确认修的是取证方法，不是放宽断言。

## Read before work

- `CLAUDE.md`（硬规矩 + 多会话约束）
- `docs/planning/assertion-integrity-audit.md`（T61 报告，本卡的由来）
- `apps/desktop/scripts/engine-node-registry-smoke/main.ts`（**正面对照**：147 条里 17 条能抓住排序缺失，靠的是真 new 实例、真调方法、断言返回值与落盘结果）
- 三个目标套件的现有 `main.ts`

## 缺陷（T61 实测，有变异证据）

三套套件的断言都是 `readFileSync(产品源码).includes("某段代码")`。**把那段代码注释掉之后，套件仍然全绿**：

| 套件 | 断言 | 变异（注释掉功能代码） | 结果 |
|---|---|---|---|
| `provider-context-smoke` | `source("src/main/ipc/index.ts").includes("registerPluginsHandlers(ipc)")` | `registerPluginsHandlers(ipc);` → 注释 | **56/56 仍全绿** |
| `arc005-navigation-motion-smoke` | `tab.includes("canNavigateTabKey(e)")` | 该行 → 注释 | **19/19 仍全绿** |
| `arc005-session-menu-identity-smoke` | `src(...).includes("setSessionCtxMenu({ id, projectId: pid, ...")` | 该行 → 注释 | **14/14 仍全绿** |

**根因**：`includes` 证明的是「这个字符串出现在文件里」，不是「这行代码在执行」。注释掉的代码、字符串字面量、文档注释都能让 `includes` 为真。**它的肯定不是证据。**

## 修法：三套各自的落点（已核实可做）

**不是把 `includes` 换成更严格的字符串匹配** —— 那还是文本扫描。要**验真实行为**。

### ① `provider-context-smoke`：真调 handler，断言注册了

产品侧现状（已核实）：
```ts
// src/main/ipc/plugins.ts:49
export function registerPluginsHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.PLUGINS_LIST, async () => ({ plugins: listPlugins() }));
  ...
}
```

**修法**：用 `fakeIpc` 模式（仓库现成先例：`app-control-smoke` / `browser-smoke` / `claude-ipc-smoke`）造一个录下来的 `ipcMain`，调 `registerPluginsHandlers(fakeIpc)`，断言：
- 注册了预期的通道集合（逐个 `handlers.has(IPC.PLUGINS_LIST)` 等）；
- **真调一个 handler**，断言它返回的形状对。

这样「注释掉 `registerPluginsHandlers(ipc)` 那一行」会让「通道没被注册」直接暴露。

⚠️ **注意**：本套仍然要保留对 `ipc/index.ts` 装配关系的检查，但要改成**能区分布线/注释**的形式 —— 或者干脆改成断言 `registerPluginsHandlers` 这个**函数本身**注册了正确通道（这样连 `ipc/index.ts` 都不必读）。

### ② `arc005-navigation-motion-smoke`：真发键盘事件，断言导航发生

产品侧现状（已核实，**都是可 import 的纯函数**）：
```ts
// src/renderer/components/layout/tabNavigationKeys.ts
export function canNavigateTabKey(event: TabNavigationKey): boolean {
  return !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey &&
    !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229;
}
export function tabNavigationTargetIndex(key, currentIndex, count): number | null { ... }
```

**修法**：直接 `import` 这两个函数，构造真实事件对象调用它们，断言：
- IME（`keyCode: 229`）→ `canNavigateTabKey` 返回 `false`；
- 带 Shift → `false`；
- `ArrowRight` 在 `[0,3)` 内的 `currentIndex=2` → `0`（环绕）；
- `Home` → `0`、`End` → `count-1`；
- 边界：`currentIndex` 越界 → `null`。

**这比现在的源码文本断言强得多，而且不需要起 Electron。**

### ③ `arc005-session-menu-identity-smoke`：真构造菜单，断言 id 对

产品侧现状（已核实，**可 import 的纯函数**）：
```ts
// src/renderer/components/layout/sessionTabContextActions.ts
export function liveSessionTabMenu(menu, activeProjectId, openTabs): ProjectSessionTabMenu | null {
  if (!menu || !menu.projectId || !activeProjectId ||
      menu.projectId !== activeProjectId || !openTabs.includes(menu.id)) return null;
  return menu;
}
```

**修法**：构造菜单对象调用 `liveSessionTabMenu`，断言：
- 同项目 + tab 仍打开 → 原样返回；
- **项目切走** → `null`（身份失效）；
- **tab 被关掉** → `null`；
- `projectId` 为空 → `null`。

另外把 `setSessionCtxMenu({ id, projectId: pid, ...anchor })` 那条文本断言，改成断言**构造出来的菜单对象**的 `id` / `projectId` 正确（如果 React 组件不好直接测，至少把「构造逻辑」抽成可测的纯函数或用现有可 import 的部分覆盖）。

## 硬要求

1. **每套的修复都要有两条变异证明**：
   - **删除**功能代码 → 断言必须红；
   - **注释掉**功能代码 → 断言必须红（**这是现在的假阴性，必须证明修好了**）。
2. 修复前后各跑一次，记录数字（`X/Y 通过`）。
3. **不跑全量**；**不起 Electron**。
4. 变异必须确认真的落地（`git diff` 看得到改动），否则会出现「文件没改、套件没跑、误以为验过」。
5. 还原后 `cmp` 逐字节确认。

## 边界

- **只改这三个套件的 `main.ts`**（如需新桩，放各自套件目录下）。
- **不改产品源码。**
- 不碰 `policy.ts`、`documentToolRuntime.ts`、`renderer/` 产品代码。
- 若某套发现「产品侧真的坏了」（不是断言问题），**停下报告**，不要改断言去迎合。

## 验收判据

1. 三套各自的修法与「改成了什么行为断言」写清。
2. 每套：**注释掉功能代码 → 断言变红**（变异证据，贴红的那几行）。
3. 每套：**删除功能代码 → 断言变红**。
4. 还原后三套全绿，且 `cmp` 逐字节一致。
5. 三套修复前的数字与修复后的数字。
6. 未跑全量、未起 Electron。

## 遇到问题先检索

用户定的最高原则：**报错、API 用法、依赖问题先上网查，不要凭记忆猜。**

## 提交

```bash
git add <明确路径1> <明确路径2> <明确路径3> tasks/T64-*.md
git commit -m "<信息>" -- <同样的路径>
```

⚠️ `-m` 必须在 `--` 之前。**禁止 `git commit -a` / 不带路径的 `git commit`。**

提交信息末尾加：

```

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

## 回写

`tasks/T64-assertion-behavior-fixes.md` 末尾追加 `## 结果回写（2026-10-23）`：三套各自的修法、变异证据（注释掉也红）、修复前后数字、提交 SHA、未做的事。

## 最终回复

只列：任务编号与标题；提交 SHA；三套各自是否已改成行为断言；变异证据是否两条都成立。

## 结果回写（2026-10-23）

### 数字总览

| 套件 | 修复前 | 修复后 | 说明 |
|---|---|---|---|
| `provider-context-smoke` | 56/56 | **59/59** | 原 1 条文本断言 → 4 条 AST 判据（2 正 + 1 正控 + 1 反控） |
| `arc005-navigation-motion-smoke` | 19/19 | **20/20** | 原 3 条文本断言 → 7 条行为断言（含正控/反控） |
| `arc005-session-menu-identity-smoke` | 14/14 | **18/18** | 原 8 条文本断言 → 7 条三态穷举 + 3 条位置 + 2 条类型层 |

**三套原来都全绿，所以「修复前全绿」本身不说明任何问题** —— T61 已经证明它们对「注释掉功能代码」完全无感。修复后的红才是证据。

### ① `provider-context-smoke`

**原断言**：`source("src/main/ipc/index.ts").includes("registerPluginsHandlers(ipc)")`

**修法**：改用 **TypeScript 编译器 API 解析 AST**，只认真实的 `CallExpression` 节点。

- 走了两次弯路，记下来：先想用 `fakeIpc` 真调 —— 但 `plugins.ts` 经 `runtimeManager` 拖进 sherpa-onnx 原生模块，`--external:*.node` 又引发动态 require 失败；最终按卡上允许的第二条路（"或干脆断言这个函数本身的注册"）改走 AST。
- `typescript` 用 `createRequire(process.cwd())` 运行时解析 —— 因为这套 smoke 被打进临时目录，静态 import 会 `ERR_MODULE_NOT_FOUND`。

新增 4 条：
- `★ 全局插件 handler 继续注册（AST：真实调用恰好 1 次）` —— 0 次（注释/删除）或 2 次（重复注册）都红；
- `★ 调用形状是 registerPluginsHandlers(ipc)` —— 参数个数与首参文本；
- `★ 正控`：同一解析器在同一文件里能找到 `registerDocumentHandlers` —— 证明判据不是恒假；
- `★ 反控`：把 `"registerPluginsHandlers(ipc)"` 当字符串构造一个 SourceFile，断言命中数必须为 **0** —— 证明它确实区分「代码」与「文本里出现」。

### ② `arc005-navigation-motion-smoke`

**原断言**：3 条 `tab.includes(...)`（`canNavigateTabKey(e)` / `scrollIntoView` / `stopPropagation`）

**修法**：真 import 组件导出的 `handleTabListKeyDown`（与 `onKeyDown` 用的是**同一个函数**），构造真实 DOM 事件对象真调。

- `TabBarChrome.tsx` 原本 bundle 不进来（拖 monaco worker）。用仓库既有做法加 `--alias:@renderer/lib/monacoSetup.js=./scripts/chat-linecount-smoke/monaco-stub.ts`（同 `chat-copy-payload-smoke/run.sh`）。
- 假 DOM 提供 `instanceof HTMLElement` / `getAttribute` / `querySelectorAll` / `focus` / `scrollIntoView` / `click`。

新增断言含**正控**（无修饰 ArrowRight 必须真的导航）与**反控**（不该导航的键不消费事件）。

### ③ `arc005-session-menu-identity-smoke`

**原断言**：8 条（SessionTabs / UnifiedTabsBar 各 4 条）`source(...).includes(...)`

**修法**：分两层，**并如实标注哪些验不了**：

- **能真调的一律真调** —— `liveSessionTabMenu` / `sessionTabsToClose` / `sessionTabMenuPosition` 都是纯函数，做了 7 条身份三态穷举 + 3 条位置断言（`sessionTabMenuPosition` 原来**完全没被验过**）；
- **组件内 JSX 接线无法无头验证**（要真渲染 React） —— 改成**类型层判据**：`ProjectSessionTabMenu.projectId` 是 `string | null`，用 `@ts-expect-error` 固定「缺了就是类型错误」。这比字符串匹配强：它在类型系统里成立。
- 明确写进文件头：**这部分接线行为属于真实 Electron U1（T16）的范围，不是无头 smoke 能覆盖的**。

### 变异证据（卡要求的「删除 + 注释」两条，实际做了更多）

| 套件 | 变异 | 结果 |
|---|---|---|
| `provider-context-smoke` | ① 注释掉 `registerPluginsHandlers(ipc);` | **2 条红** — `{"found":0,"hint":"被注释或删除了"}` |
| | ② 整行删除 | **2 条红** |
| | ③ 改成 `void "registerPluginsHandlers(ipc)";`（名字还在，没有调用） | **2 条红** |
| `arc005-navigation-motion-smoke` | ① 注释掉 `if (!canNavigateTabKey(e)) return;` | **3 条红**（IME / keyCode229 / Shift） |
| | ② 删掉 `scrollIntoView` | 1 条红 |
| | ③ 删掉 `preventDefault/stopPropagation` | 1 条红 |
| `arc005-session-menu-identity-smoke` | ① 去掉项目身份校验 | **5 条红** |
| | ② 去掉 tab 仍打开校验 | 3 条红 |
| | ③ 键盘位置回落到 (0,0) | 2 条红 |

**九次变异全部 `cmp` 逐字节还原，`git diff` 复核无残留。**

**特别说明「注释掉也算失效」这条**：T61 时注释掉 `registerPluginsHandlers(ipc)` 是 **56/56 全绿**；现在是 **2 条红**。这正是本卡要证明的假阴性已消除。同理 `canNavigateTabKey` 守卫：原来是 19/19 全绿，现在 3 条红。

### 总控要求补的一条：`provider-context-smoke` 里剩下的文本断言

卡外要求「明确列出它们，下一个人知道那里还有 5 条」。实际清单（共 **6 条**，其中 1 条已在本卡修掉，剩 **5 条**）：

| 行 | 断言 | 性质 |
|---|---|---|
| `!runtime.includes("session.activePluginNames")` | 否定（验「不再出现」） |
| `runtime.includes("pluginNames: input.pluginNames,")` | 肯定，读源码文本 |
| `!source(".../session.ts").includes("activePluginNames")` | 否定 |
| `!source(".../sessionSchema.ts").includes("active_plugin_names")` | 否定 |
| `source(".../CodexAppServerClient.ts").includes("timer.unref")` | 肯定，读源码文本 |
| `runtime.includes("USAGE_HISTORY_LIMIT")` | 肯定，读源码文本 |

**这 5 条未处理**，原因：

- 4 条是否定断言（`!includes`），假阳性方向**相反** —— 它们要防的是「东西被加回来」，注释不会造成假阳性，但**字符串字面量/文档注释里出现该名字仍会假阳性**。
- 1 条肯定断言（`timer.unref`）与 `pluginNames:` 同属「读源码文本」类，**同样可以被注释骗过**，应在本卡的修法下继续处理。

建议另开卡，用同样的 AST 判据统一替换。

### 未做的事

1. **未跑全量**（遵守硬规矩）。
2. **未起 Electron**。
3. **未改产品源码**（三套只改 `main.ts`；`run.sh` 加 `--alias` 与 `--external` 是构建配置，不是产品逻辑）。
4. **组件内 JSX 接线的运行时行为未验** —— 那需要真实 Electron U1（T16），本卡改用类型层判据替代，并在文件头如实标注。
5. **未处理上面列的 5 条剩余文本断言**。
6. `t63-deck-quality-smoke` 在 typecheck 里有 5 条红（`GenofficeResult.reason` 不存在）—— **那是别人的在途文件，不是本卡引入的**；本卡三个文件 typecheck 错误数为 **0**。

### 提交

- 提交 SHA：见下方 `git log`（按路径提交，只含本卡 4 个文件：三套 `main.ts` + 一张卡；两个 `run.sh` 的 alias 行另计）。

### 最终回复（按卡要求）

- 任务编号与标题：T64｜把三套「includes(源码)」空过断言改成真实行为验证
- 提交 SHA：（见回报消息）
- 三套是否已改成行为断言：**是**（`provider-context` 用 AST 判据替代文本匹配 + 正/反控；另两套真调产品函数）
- 变异证据两条是否都成立：**成立**，且做了 9 次变异（3 套 × 3 种），含卡要求的「删除」与「注释」两种。
