# T05b｜GenOffice Docs 迁移（二）：需要权限的操作

| 项目 | 值 |
|---|---|
| 编号 | T05b |
| 类型 | ARC-007 |
| 优先级 | 中高 |
| 建议并发 | 等 T05a 完成后再开（同一批文件） |
| 预计规模 | 中（10 个 handler，但每个都要审批链） |

---

## 本卡范围：10 个需要新权限的 handler

全部是原生 OS 交互或文件写入，**每个都必须默认拒绝 + 用户显式批准**：

| handler | 风险 | 判据 |
|---|---|---|
| `docs:pick-image` | 读任意图片 | 走 Mcode 的文件选择（已有 `api.pickFiles`），不新开对话框 |
| `docs:save-image-as` | **写任意路径** | 默认拒绝；必须走 Mcode 的保存对话框与路径围栏 |
| `docs:pick-export-images-target` | **选写入目录** | 同上 |
| `docs:take-export-pdf` | **写 PDF** | 同上 |
| `docs:printers` | 枚举打印机 | 只读；但要确认不泄漏用户环境信息到日志 |
| `docs:print` | **触发打印** | 每次都要用户确认；不能静默打印 |
| `files:pick` | 读任意文件 | 复用 `api.pickFiles` |
| `files:add` | 加入文档资源 | 路径围栏 |
| `files:read-image` | 读图片字节 | 限工作区内 |

---

## 开工前必读

1. T05a 的任务文件与它的回写区 —— 你会复用同一套边界层。
2. `apps/desktop/src/main/document/docsVendorIpc.ts` —— T05a 扩展后的版本。
3. Mcode 现有的**审批链**：`ModuleHost` 的逐次审批、`appControl` 的
   `app_api_call` 授权。**不要新造一套审批**。
4. `apps/desktop/src/main/document/documentViewCredentialBroker.ts` ——
   已有的凭据中间层，看它怎么把"权限"表达成短期令牌。

---

## 核心原则

**这 10 个 handler 一个都不能「迁移完就放行」。** 正确形态是：

```
GenOffice 页面发起请求
  → mcode-ipc.ts 收到
    → 检查 Mcode 是否已有等价能力（api.pickFiles / 保存对话框 / 路径围栏）
      → 有：转调 Mcode 的，不自己实现
      → 没有：默认拒绝，并返回可读原因
    → 需要用户确认的：走既有审批 UI，**不要新开一个**
```

### 三个必须守住的不变量

1. **不新开 OS 对话框**：所有文件选择走 `api.pickFiles`（已有），
   否则用户会看到两个不同的选择器。
2. **写入必须过围栏**：`save-image-as` / `take-export-pdf` 的目标路径
   必须过 Mcode 的 `pathGuard`，不能直接 `fs.writeFile`。
3. **打印必须显式**：`docs:print` 每次都要确认，不能因为"用户刚才点过"就跳过。

---

## 边界（不要碰）

- 不要碰 T05a 已迁移的 6 组 handler。
- 不要碰 `genoffice/ee/`、其它五个 app、Mcode renderer。
- 不要新造审批机制。
- 所有 `genoffice/` 改动同步产出 patch。

---

## 验收判据

1. 10 个 handler **逐个**有迁移状态与验证方式。
2. 每个「需要权限」的 handler 都有**拒绝路径**断言：
   未授权时收到可读原因，且**没有实际文件被读写**。
3. `save-image-as` / `take-export-pdf` 的路径围栏有断言（越界路径必拒）。
4. 打印有「未确认则不打印」断言。
5. 现有 `document-view-*` 四套 + T05a 新增的 smoke 全绿。
6. 双包 tsc + GenOffice Docs tsc 全绿。
7. **变异验证**：撤掉围栏 → 越界断言必红；撤掉打印确认 → 断言必红。

---

## 你要在回写区回答的问题

- 10 个里哪些是「转调 Mcode 已有能力」、哪些是「新写」？
- 有没有出现两个文件选择器/两套权限判据？
- 打印的确认 UI 用的是哪一个？复用还是新开？

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->

### 2026-10-21｜T05b 执行回写（10 路受控接入；原厂完整导出链仍有边界外缺口）

- **范围与数量**：卡片表格列了 9 个原厂 handler，第 10 个是原厂图片导出必需的 `docs:write-export-image`。十条全部已加独立受信 IPC 通道（`mcode:docs:privileged-*`）与 sender 验证；逐项状态/验证见 `docs/planning/arc007-genoffice-native-integration-map.md` 新增 T05b 表。绝不开放原厂 standalone 的任意文件/打印 handler。
- **旧能力复用 vs 新逻辑**：`pick-image` / `files:pick` 复用 Mcode `dialog.pickFiles` 原有选择服务 `pickFilesForUser`；`pick-export-images-target` 复用 `dialog.pickFolder` 原有选择服务 `pickFolderForUser`；`save-image-as` 走 Mcode 已有 `dialog.showSaveDialog` + `atomicReplaceFile`；`print` 走现成 `dialog.showMessageBox` 真人确认 + Chromium `webContents.print`；`printers` 委托现有 Chromium API；`files:add` / `files:read-image` / `take-export-pdf` / `write-export-image` 新写的仅是 sender/选择许可、尺寸/格式校验和 Mcode `findContainingWorkspaceRoot` 权威路径围栏**适配逻辑**，没有平行 OS 选择器、文件原子写入器、用户审批令牌或打印对话框。
- **是否两套选择器 / 权限**：否。宿主 `pickFilesForUser` / `pickFolderForUser` 分别同时供 Mcode IPC 与原厂受控视图调用；工作区允许列表不在 vendor 中复制，唯一决策为 Mcode `findContainingWorkspaceRoot`，加上物理路径防链接越界。所有入口 fail-closed。未批准时带可读拒绝原因且不触发磁盘文件 IO / OS 打印；文件操作授权路径基于真人 picker 返回、不是 renderer 自报 grant。
- **打印用的确认 UI**：复用 Mcode `DocumentViewHost.setConfirmDirty` 已使用的 Electron `dialog.showMessageBox` 模式（默认/取消按钮都为拒绝），**每次打印**必须经用户确认；不缓存“刚刚批准”的结果，不新建 React 审批面板。
- **版本与补丁**：GenOffice `mcode/integration` 提交 `02d8683ca3f19cf404a48c3f1625140ea5175b46`；主仓 patch `patches/genoffice/0007-feat-docs-gate-privileged-operations.patch`，在 vendor HEAD 上 `git apply --reverse --check` PASS。
- **E1 验证**：`node apps/desktop/scripts/run-smokes.mjs document-view-host-smoke document-view-open-smoke document-view-electron-smoke document-view-vendor-page-smoke document-view-renderer-smoke` 5/5 PASS，日志 `apps/desktop/.tmp/smoke-runs/1792548830335-35916-FluJAk`；`npx tsc --noEmit -p apps/desktop/tsconfig.json`、`-p packages/contracts/tsconfig.json`、`-p genoffice/apps/docs/tsconfig.json` 全绿。新增 10 条预载路径测试 + 10 条非授权 sender 拒绝测试 + 目录/路径、写入、打印、printer 信息最小化等断言。变异：`node apps/desktop/scripts/document-view-host-smoke/mutate-t05b.mjs`，单独撤掉物理围栏→exit 1（越界拒写断言红）；单独撤掉打印确认→exit 1（未经确认打印断言红）；每种变异均核对源码逐字节恢复。
- **明确未达成 / 不能冒称完工的内容**：本卡覆盖的 10 条路由均已受控接线，但图片整条导出流程仍依赖 T05b 范围外、preload 未迁的 `exportPdf`（由 PDF→图片拆页的入口）；`save-image-as` 只处理已内嵌 data:image，原厂 lazy-media/网络源被明确拒绝；原厂附件文本 `files:read` 也不在这张任务表。且没有对新 OS picker/打印审批做真实交互 U1 验证。**不将此切片标记为 ARC-007 整包完成。**
