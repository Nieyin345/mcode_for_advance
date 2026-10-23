# T32｜`genofficeNativeVendor.ts` 的 alias 虚拟模块破坏了 15 套 smoke 打包

- Status: ready-for-agent
- Category: **bug（测试基础设施）**
- Priority: **P0 工具链**
- Depends on: none
- Exclusive writable files: `apps/desktop/src/main/document/genofficeNativeVendor.ts`、`apps/desktop/electron.vite.config.ts` 的 alias 段、`apps/desktop/scripts/run-smokes.mjs`（若需补 alias）、相关 stub。逐个确认后写进回写区。

## Required Skills
- `codebase-design`: 决定是「给 smoke runner 补 alias」还是「让源码可被裸 esbuild 解析」。
- `mcode-smoke`: 理解这套无头 smoke 的打包方式，并验证修复。

Read before work: `CLAUDE.md`、`apps/desktop/src/main/document/genofficeNativeVendor.ts`、`apps/desktop/electron.vite.config.ts`（**第 257/261 行附近**）、`apps/desktop/scripts/run-smokes.mjs`、`apps/desktop/src/main/document/genofficeEntryTypes.d.ts`、`genofficeNativeVendorStub.ts`。

## 缺陷（T31 全量跑实测）

15 套 smoke 在**打包阶段**就失败，同一个根因：

```
X [ERROR] Could not resolve "@main/document/genofficeSheetsEntry.js"
X [ERROR] Could not resolve "@main/document/genofficeSlidesEntry.js"
X [ERROR] Top-level return cannot be used inside an ECMAScript module
```

**来源**：`dc974b2c`（旧卡 T29「connect upstream Sheets and Slides native views」）在 `genofficeNativeVendor.ts` 里 import 了这两个模块。

**问题**：它们是 **electron-vite 配置里的 alias 虚拟模块**（`electron.vite.config.ts:257/261`），**仓库里没有对应源文件**。裸 esbuild 的 smoke runner 没有这个 alias，于是在打包阶段直接失败。

**受影响的 15 套**（T31 列的）：`agent-guide`、`claude-ipc`、`custom-ui-refresh`、`extension-authoring`、`host-mcp-server`、`host-mcp-stdio`、`memory`、`panel-screenshot`、`scene-apply`、`scene-crash-resume`、`watch-templates-cas-electron` 等。

## 两条修法

**(A) 给 smoke runner 补 alias**

在 `run-smokes.mjs` 或各套的 `run.sh` 里，把这些别名指向真实模块或 stub。

- 优点：不改产品源码
- 缺点：每个套件都要加，或者改共享的 runner（影响面大）
- **注意**：仓库里已有 `genofficeNativeVendorStub.ts`，可能就是为此准备的——先看它是什么

**(B) 让源码可被裸 esbuild 解析**

把 `@main/document/genofficeSheetsEntry.js` 这类写法改成运行时 `require()`/动态 import，或提供一个真实存在的入口文件。

- 优点：一次性解决
- 缺点：动产品源码，要验证 electron-vite 构建仍正常

**选一个并论证。** 先查 `genofficeNativeVendorStub.ts` 的用途——如果它就是为此准备的 stub，那 (A) 可能已经有半成品。

## 验收判据

1. 回写区给出：`genofficeNativeVendorStub.ts` 是什么、现在谁在用。
2. 明确修法（A 或 B）与论证。
3. **15 套 smoke 全部能打包并运行**（不必全绿，但必须不再卡在打包阶段）。
4. `electron-vite build` 仍正常（**真跑一次构建**）。
5. T23 的 `production-build-preload-smoke` 18/18、`genoffice-editors-release-smoke` 29/29 不回归。
6. 变异验证：撤掉修复 → 至少一套回到打包失败 → `cmp` 还原。
7. 双包 typecheck 通过。

## 边界

- **不动** T27/T28（`workflowEngines/`）、T19（`appPermission.ts` + `ModuleHost.ts`）。
- **不改** `build/vendor-licenses/`。
- **不改** T31 刚修的三个套件。
- 若改 `run-smokes.mjs`，**必须保证其他 500+ 套不受影响**——改完跑一次全量对照。

## 重要：这个 checkout 是多会话共享的

- **用 `git commit -o <path>` 按路径提交**，不要 `git add` 后停在那里
- **绝对不要读 `.tmp/` 下的文件当提交信息**（我犯过这个错，读了 11 天前的旧文件）
- **绝对不要用 `git worktree` + junction**（前面删过 `packages/contracts/`）

## 结果回写（2026-10-23）

（执行者在此追加：stub 调查、修法与论证、15 套的实际结果、electron-vite 构建验证、变异证据、提交 SHA）
