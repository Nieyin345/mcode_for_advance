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
