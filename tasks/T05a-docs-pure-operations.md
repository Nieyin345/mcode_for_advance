# T05a｜GenOffice Docs 迁移（一）：纯文档操作

| 项目 | 值 |
|---|---|
| 编号 | T05a（T05 拆分第一张） |
| 类型 | ARC-007 |
| 优先级 | 高（主线） |
| 建议并发 | 不要与任何改 `src/main/document/` 或 `genoffice/` 的任务并行 |
| 预计规模 | 大（约 33 个 `docs:*` handler 中的低风险部分） |

---

## 背景：原卡为什么必须拆

原 T05 写「逐 handler 迁移」。实测原厂 `genoffice/apps/docs/src/main/docs-main.ts`：
**6543 行，76 个 ipcMain 注册**，分五大类：

| 前缀 | 数量 | 归属 |
|---|---|---|
| `docs:*` | 33 | **本卡 + T05b** |
| `ai:*` | 12 | **T05c（默认拒绝 + 显式审批后可用，不删）** |
| `win:*` | 3 | Mcode 自己已有窗口管理，不迁 |
| `files:*` | 3 | **T05b（需权限）** |
| `app:*` | 1 | 归 Mcode 宿主 |

一次做完不现实。本卡只做 **`docs:*` 里不涉及新权限、不涉及原生 OS 对话框的那部分**——
它们是纯文档操作，可以在隔离虚构文件上完整验证。

---

## 开工前必读

1. `audit-ledgers/README.md`（规则）。
2. `docs/planning/arc007-genoffice-native-integration-map.md` 全文，特别是
   2026-10-20 用户拍板那一节。
3. `genoffice/apps/docs/src/main/mcode-ipc.ts`（56 行，现有边界层）与
   `genoffice/apps/docs/src/preload/mcode-view.ts`（第一轮的受限 preload）。
4. `apps/desktop/src/main/document/docsVendorIpc.ts` 与 `docsVendorPreload.ts`。
5. **第一轮的提交与补丁**：`d6f0f320`（Mcode 侧）、`8d379b1d`（GenOffice 侧）、
   `patches/genoffice/0001-*.patch`。理解它的形式——上游改动必须以 patch 同时存在。

---

## 本卡范围：先做这 6 组

按依赖从少到多，**每完成一组单独提交**：

### 1. 文档生命周期（最基础）

`docs:open`、`docs:open-path`、`docs:consume-pending-open`、`docs:consume-new-blank`、
`docs:save-new`、`docs:recent`、`docs:consume-ai-doc-content`

**关键**：这些必须走 Mcode 的路径围栏与 `DocumentViewHost`，**不许**直接用 GenOffice
自己的任意路径访问。第一轮已经把 `docs:open` 接好了，本卡把其余几个接上。

### 2. 语言与字体（第一轮已做一半）

`app:get-language`、`docs:system-locale`、`docs:font-metrics`
—— 这三个第一轮已迁（字体度量、拼写语言）。**核实一遍，别重做**。

### 3. 拼写检查（纯本地计算）

`docs:spell-diag`、`docs:spell-ignore-word`、`docs:spell-add-word`、
`docs:spell-replace`、`docs:spell-languages`、`docs:spell-set-languages`、
`docs:respell-kick`

这些是纯文本处理，无 IO 风险，但要注意**词库写盘位置**——必须落在 Mcode 数据根下，
不能写到 GenOffice 自己的 userData。

### 4. 恢复与替换确认

`docs:write-recovery`、`docs:confirm-document-replace`、`docs:password-intent-revision`

`docs:write-recovery` 涉及写盘恢复，要与 Mcode 的 `fileSnapshot` / 原子写对齐，
**不要**让 GenOffice 自己再写一套恢复逻辑。

### 5. 上下文菜单（纯 UI 状态）

`docs:context-menu-claim`、`docs:context-menu-arm`、`docs:view-menu-state`

### 6. 关闭流程

`docs:close-check-result`、`docs:close-save-result`

**关键**：关闭时如果有未保存内容，必须走 Mcode 已有的脏文件保护，
不能绕过它直接关。

---

## 明确不做（留给 T05b / T05c）

- **T05b**：`docs:pick-image`、`docs:save-image-as`、`docs:pick-export-images-target`、
  `docs:printers`、`docs:print`、`docs:take-export-pdf`、`files:pick`、`files:add`、
  `files:read-image` —— 全是原生对话框/打印/图片 IO，要权限与审批。
- **T05c**：全部 12 个 `ai:*` —— 云 AI。**不是"不要"，是"默认拒绝 + 显式审批后可用"。**
  台账第 5 条写死：上游功能要保留为可受控调用的能力，风险能力显式受限/告知，
  **不得静默删除或平行直连**。GenOffice 的 AI 面板必须能经 Mcode 的三 SDK / 审批
  跑起来，而不是被删掉。
- **不迁**：`win:*`（Mcode 自己有）、`docs:altchunk-html-to-docx`（等 T05b 评估）。

---

## 边界（不要碰）

- **不要**碰 `genoffice/ee/`。
- **不要**碰 sheets / slides / pdf / markdown / html 五个 app。
- **不要**改 Mcode renderer。
- **不要**改 `documentViewHost.ts` 的公开接口签名（可以改实现）。
- **不要**删 `documentViewPreload.ts`（旧 fallback 留到 T05b 之后再评估）。
- 所有 `genoffice/` 改动必须同步产出 patch 到 `patches/genoffice/`。

---

## 验收判据

1. 本卡 6 组 handler **逐个**有迁移状态记录（迁了 / 不迁 / 为什么），写进
   `docs/planning/arc007-genoffice-native-integration-map.md` 的表格。
   **没有验证方式的行视为未完成。**
2. 每组至少一条真 Electron 验证（复用 `document-view-electron-smoke` 的脚手架）：
   打开虚构 `.docx` / `.md` → 操作 → 保存 → 重开 → 字节回读一致。
3. 「不改只关闭」**不得重写文件**（mtime + hash 双断言）。
4. 未保存关闭走 Mcode 脏文件保护（有断言）。
5. 现有四套 `document-view-*` smoke 全绿。
6. 双包 tsc + GenOffice Docs tsc 全绿。
7. **变异验证**：撤掉路径围栏 → 越界路径断言必红；撤掉脏文件保护 → 关闭断言必红。

---

## 你要在回写区回答的问题

- 6 组里各迁了几个？没迁的是哪些、为什么？
- 第一轮那 3 个 handler 核实结果如何（真迁了还是名不副实）？
- 拼写词库写在哪？会不会与 GenOffice 自己的 userData 冲突？
- `docs:write-recovery` 与 Mcode 的 `fileSnapshot` 是什么关系？有没有两套恢复逻辑？

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->

### 2026-10-21｜T05a 执行回写（范围内，未替未接能力报完成）

- **独立 GenOffice 提交**：分支 `mcode/integration` HEAD `2fa633afbe31a14ec3bbcb929c631ae3c828767d`，五次分组增量提交 `684d9dc` / `d8671f6` / `d6eb48e` / `bd08868` / `2fa633a`。补丁 `patches/genoffice/0002-*.patch` 至 `0006-*.patch`，与原 `0001-*.patch` 按顺序在隔离 worktree 从 `73ba918` **git am 全部 6 个 PASS、与 vendor HEAD 零差异**。
- **六组统计**：①生命周期 4 迁/1 部分/2 留待后续；②语言/字体 3 迁；③拼写 7 迁；④恢复/确认 1 迁/2 暂不迁；⑤上下文菜单 2 迁/1 部分；⑥关闭 1 迁/1 暂不迁。25 个原厂 handler 全部逐项列在 `docs/planning/arc007-genoffice-native-integration-map.md` 的 T05a 表，**各有验证对应项**。
- **第一轮 3 handler 复核**：`font-metrics` / `spell-languages` / `spell-set-languages` 的逻辑确实复用了原厂与 Chromium，但原 `mcode-ipc.ts` 缺少 `mcodeNativeDocsIpcAvailable` 导出，导致生产别名不会注册。已补标志并用真 Electron 查到、修复重复 Host 注册冲突，回归由红转绿。
- **存储位置**：T05a 忽略词 journal、spell trace 位于 Mcode `dataRoot()/docs/`；Chromium 自带字典仍由 Mcode 宿主 session/profile 维护，不从 GenOffice standalone userData 导入。严格说 Chromium 自有 profile 并不跟随可迁移 `dataRoot`，后者需要 Mcode 会话级迁移才能完全统一。
- **恢复关系**：`fileSnapshot` 保存 UTF-8 Agent 回退，不是 DOCX 崩溃恢复；`writeRecoveryCopy` 暂时明确 `ok:false` 且不写第二份恢复文件；`password-intent-revision` 暂无加密意图服务而非虚报真实密码功能。关闭 `docs:close-save-result` 没有 Mcode Save 模式触发，未伪装成功。均登记为功能缺口。
- **真 Electron**：`document-view-open-smoke` 新增 native language/spell/context/recovery fail-closed/clean close 段；DOCX 打开与保存重开 hash、clean close 的 mtime/hash 双断言 PASS。4 suites：`document-view-open-smoke` / `document-view-host-smoke` / `document-view-electron-smoke` / `document-view-vendor-page-smoke` **4/4 PASS**（`apps/desktop/.tmp/smoke-runs/1792547282093-26964-HWP63H`）。
- **类型与负例**：`npx tsc --noEmit -p apps/desktop/tsconfig.json`、`npx tsc --noEmit -p genoffice/apps/docs/tsconfig.json`、`npx tsc --noEmit -p packages/contracts/tsconfig.json` PASS。作用域隔离变异 `MCODE_T05A_MUTATE_SCOPE=1` 的真实 Electron 套件 **exit 1**（`1792546794306-39016-hmC0bU`）；脏关闭变异 `MCODE_T05A_MUTATE_DIRTY=1` 的宿主套件 **exit 1**（`1792546811330-32424-9QlXyv`）。两项变异不会持久修改生产源。
- **范围外**：未碰 GenOffice 其它五编辑器、ee/、Mcode renderer 或 T05b/T05c 所列原生对话框及云 AI；其他并发对话在主仓工作区的未提交改动全部未暂存或合并到本任务提交。
