# T38｜三套打包期失败：桩缺导出、`.node` loader、zustand 5 的 default 导入

- Status: ready-for-agent
- Category: bug（测试基础设施）
- Priority: P1
- Depends on: none
- Exclusive writable files: `apps/desktop/scripts/mcode-admin-smoke/stubs/`、`mcp-endpoint-smoke/`、`maint-m35-smoke/stubs/`。

## Required Skills
- `mcode-smoke`: 理解 esbuild 打包期失败与断言失败的区别。

Read before work: `CLAUDE.md`、`apps/desktop/scripts/mcode-admin-smoke/`、`mcp-endpoint-smoke/`、`maint-m35-smoke/`。

## C 会话实测的三条（都卡在打包期，一条断言都没跑到）

### ① `mcode-admin-smoke`：桩缺导出

```
dataRoot.ts 缺 migrateLegacyIntoDataRoot
window.ts 缺 updateTitleBarOverlay
pluginManager.ts 缺 getEnabledPlugins / getPluginMcpServers / getEnabledPluginSkillRoots
libraryServer.ts 缺 buildLibraryMcpServer
```

**产品接口变了，桩没跟。**

### ② `mcp-endpoint-smoke`：`.node` loader

```
No loader is configured for ".node" files: sherpa-onnx.node
```

原生模块缺 `--loader:.node=copy`。

**注意 C 的观察**：`mcp-endpoint` 的 `run.sh` 引了 `mcode-admin-smoke/stubs/dataRoot.ts`，**修一处能同时解两套**。

### ③ `maint-m35-smoke`：zustand 5 的 default 导入

```
stubs/reactEffects/index.ts 没有 default 导出
zustand 5 的 react.mjs 要 `import React from 'react'`
```

## 工作顺序

**第一步：先修 ①（它连带解 ②）。**

补桩的缺失导出。**读产品源码确认签名**，不要凭猜写个空函数。

**第二步：修 ②。**

给 esbuild 加 `--loader:.node=copy`。

**参考**：`document-view-host-smoke/run.sh` 里 T0 加过 `--external:*.node`，看哪个更合适。

**第三步：修 ③。**

`stubs/reactEffects/index.ts` 补 default 导出。

**第四步：逐条验证。**

三套都能打包并跑起来（**不必全绿，但必须不再卡在打包期**）。

## 验收判据

1. 三套都不再卡在打包期。
2. 桩的导出**签名与产品源码一致**（逐个核对）。
3. `mcp-endpoint` 与 `mcode-admin` 共用桩的修复没有互相破坏。
4. 变异验证：撤掉某个桩导出 → 对应套件回到打包失败 → `cmp` 还原。
5. 双包 typecheck 通过。

## 边界

- **只改 `scripts/` 下的桩与 `run.sh`**。
- **不改** `run-smokes.mjs`、产品源码、`electron.vite.config.ts`。
- **不碰** T28/T20/T29/T30 正在改的文件。

## 遇到问题先检索

**报错、API 用法、依赖问题先上网查，不要凭记忆猜。** 尤其 ③ 的 zustand 5 default 导入问题，上游可能有明确说明。

## 提交

`git add` 后**立刻** `git commit`。**绝不读 `.tmp/` 下的文件当提交信息。**

提交信息末尾加：
```

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

## 回写

在 `tasks/T38-smoke-stub-drift.md` 末尾追加 `## 结果回写（2026-10-23）`：三条各自的修法、桩签名核对、变异证据、提交 SHA。

## 结果回写（2026-10-23）

**提交**：`29e4b1c4` — fix(T38): 三套 smoke 不再卡在打包期（桩补齐 + .node external）

### 结论：三条都已修好，三套不再卡打包期

| # | 套件 | 旧红 | 修法 | 新绿 |
|---|---|---|---|---|
| ① | `mcode-admin-smoke` | 5 处 `No matching export` | 补 4 个桩文件（见下） | 289/289 |
| ② | `mcp-endpoint-smoke` | `No loader is configured for ".node"` | run.sh 加两条 `--external` | 784/784 |
| ③ | `maint-m35-smoke` | `No matching export … import "default"` | `reactEffects` 补 default | 全部 passed |

**实际错误比卡上多一条**：`library-mcp-smoke/stubs/window.ts` 还缺
`hasLiveRendererWindow`（`RuntimeManager.ts:13` / `ipc/index.ts:38` 用它）。这条卡上没列，
但它和 `updateTitleBarOverlay` 在同一个桩里，一并补了 —— 该桩被 `mcode-admin-smoke`、
`library-mcp-smoke`、`library-adopt-smoke` 三套共用。

### 桩签名逐条核对（对着产品源码，不是猜的）

| 桩导出 | 产品出处 | 产品签名 |
|---|---|---|
| `migrateLegacyIntoDataRoot` | `src/main/lib/dataRoot.ts:130` | `(): void` |
| `updateTitleBarOverlay` | `src/main/window.ts:79` | `(): void` |
| `hasLiveRendererWindow` | `src/main/window.ts:310` | `(): boolean` |
| `getEnabledPlugins` | `src/main/plugins/pluginManager.ts:1955` | `(projectPath?: string): Promise<EnabledPlugin[]>` |
| `getEnabledPluginSkillRoots` | 同文件 `:2113` | `(pluginNames?: readonly string[], providerId?: string, projectPath?: string): Promise<string[]>` |
| `getPluginMcpServers` | 同文件 `:2194` | `(precomputed?: EnabledPlugin[], providerId?: string): Promise<Array<[string, McpServerConfig]>>` |
| `buildLibraryMcpServer` | `src/main/mcp/libraryServer.ts:629` | `(opts: { sessionId: string })` → `createSdkMcpServer({ name, version, instructions, alwaysLoad: true, tools })` |

`pluginManager` 桩原来自带一份 `PluginNodeTypeSource` 接口定义，改成交集上的
`import type … from "@main/plugins/pluginManager.js"` 再 `export type` 转发 —— 这样产品改字段，
`tsc` 会先在这份桩上报错。`McpServerConfig` 从 `@contracts/ipc` 引（产品 `pluginManager.ts:57`
就是从那儿拿的）。

空实现的语义都写了理由：`migrateLegacyIntoDataRoot` 无头里没有"老位置"可搬；
`updateTitleBarOverlay` 在 `mainWindow === null` 时产品本来就是空操作；
`hasLiveRendererWindow` 恒 false 就是无窗口时的真实答案（推送分支走"没有界面"那一侧）。

### ② 为什么 `--external:*.node` 必须配 `--external:sherpa-onnx-node`

`.node` 那条单独加不够：`sherpa-onnx-node` 包内有一句内层真实
`require('../sherpa-onnx-win-x64/sherpa-onnx.node')`，包名不 external 就仍会在打包期去读它。
两条都写，与 `document-view-host-smoke/run.sh:67` 同一个写法。

### ③ zustand 5 已按卡上要求先检索

`node_modules/zustand/esm/react.mjs` 第 1 行实测就是 `import React from 'react'`，
随后 `React.useSyncExternalStore(...)`。ESM 不会把具名导出并进默认命名空间 —— 这是语言规则，
不是 zustand 的 bug；桩要同时提供 default。default 对象直接聚合上面已有的具名导出，
形状与 `preview-panel-smoke/fakeReact.ts` 的 default 一致，不重复实现。

### 变异证据（逐个确认能判别修复）

| 变异 | 预期 | 实测 |
|---|---|---|
| 删 `dataRoot.ts` 的 `migrateLegacyIntoDataRoot` | admin 回到打包期红 | `X [ERROR] No matching export … "migrateLegacyIntoDataRoot"` |
| 删 run.sh 两条 `--external` | endpoint 回到 `.node` loader 红 | `X [ERROR] No loader is configured for ".node" files: …sherpa-onnx.node` |
| 删 `reactEffects` 的 `export default` | m35 回到 `default` 红 | `X [ERROR] No matching export … for import "default"` |

三次都用 `cmp` 确认源文件逐字节还原（`RESTORED-BYTE-IDENTICAL`）。

### 边界与连带验证

- 改动全部在 `apps/desktop/scripts/` 下的桩与 `run.sh`；**没动** `run-smokes.mjs`、产品源码、
  `electron.vite.config.ts`。
- 消费这四处桩的**全部 15 套** smoke 逐套跑过，全绿：`automation` / `base-capability-matrix` /
  `document-read` / `effective-tools` / `event-vertical` / `library-adopt` / `library-mcp` /
  `maint-m35` / `mcode-admin` / `mcp-endpoint` / `mcp-text` / `pdf-preview-index-notice` /
  `remote-ssh` / `t27-load-entry-deadlock` / `t3-engine-trigger-gate`。
- 双包 typecheck 绿（`apps/desktop` + `packages/contracts`）。提交后重跑三套仍绿。

### 未做 / 需要知道

- **没跑全量 `run-all-smokes.sh`**：本次改动面已被上面 15 套覆盖（`grep` 过所有引用这四处
  桩的 `run.sh`），全量留给提交前的收口。
- 期间 `apps/desktop/scripts/capability-smoke/main.ts` 有一次 TS2532 报错，是**另一会话正在写
  的 T35 代码**（`git diff` 里是 `+` 行），不是我改的；对方随后修好，末次 typecheck 绿。
