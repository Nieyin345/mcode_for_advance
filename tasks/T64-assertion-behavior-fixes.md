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
