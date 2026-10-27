# ARC-007 · FULL-0 GenOffice 原版源码锁定与发行前门禁

> 施工边界：此页是 GenOffice 来源 / 许可 / 打包约束的**证据页**，不是完成台账。功能目标见 `docs/功能文档.md`；进度看代码与套件。

## 上游来源（L1 直接复用）

- 官方仓库：<https://github.com/genspark-ai/genoffice>（本机 Git remote 经 `ghfast.top` 镜像访问），独立嵌套 Git 仓：`genoffice/`，被 Mcode 顶层 Git 忽略，**不得用主仓 HEAD 替代它的版本**。
- 当前锁定独立 GenOffice HEAD：`3cb99ab13e1e42989889e15cc338bd6f6c6fff5c`（Mcode 集成补丁系列的第 15 条，tree `5ba6f37b`），固定文件 `apps/desktop/build/genoffice-upstream.lock.json`。已审批基线：`cbec600ace9c930b2646b6739cf6df3741bb9d6a`；在此之上依次叠加 Mcode 的 **15 条 L3 补丁**（`patches/genoffice/0001…0015.patch`），起于一条原厂 PDF 修复 `73ba918`，其余 14 条为 Mcode 集成。门禁额外逐项核实每条补丁 commit 的 parent SHA、changed paths 与 sha256 是否和锁文件相等，并核对 HEAD 与 `HEAD^{tree}`，避免把其它私有改动伪装成这个修复。
  - **不要另建第二套补丁机制**：Mcode 对 GenOffice 的所有改动都走 `patches/genoffice/` 这一条系列，按序 `git am`，并由上面的锁文件逐条校验 commit / changed paths / sha256。另建一套会让「用户装上的 vendor」和「我们验过的 vendor」对不上，而症状是运行期行为差异，不是构建失败。
- 上游许可证：根目录 `genoffice/LICENSE`（Apache-2.0）与 `genoffice/NOTICE`；根 `package.json` / `package-lock.json` 也是原厂构建和依赖版本输入，门禁按源码同等查 Git dirty（已有隔离旧红）；发布的 CLI/PDFium 另由已有 `stage-genoffice-resources.cjs` 搬运第三方许可，不能因原厂页面能运行就跳过下游各依赖许可审查。
- 原生入口按相同顺序：`genoffice/apps/{docs,sheets,slides,pdf,markdown,html}/src/{main,preload,renderer}`，涉及原版 DOCX 引擎、Univer+Rust XLSX、PPTX 包、PDFium、Markdown/HTML 编辑器，不在 Mcode 中复刻其业务内核。

## 新的发行时强制校验（L2 最薄适配）

`apps/desktop/package.json` 的正式 `package` 命令现在按顺序执行：

1. Mcode 现有编译和 workspace 处理。
2. **`node build/verify-genoffice-upstream.cjs`**：当 `MCODE_INCLUDE_GENOFFICE_BUNDLE=1` 时，对照上游锁文件检查：嵌套 Git 工作树根确实是 `genoffice/`、Git HEAD 与固定完整 SHA 一致、`apps/` 或 `packages/` tracked/untracked 源码未漂移、六原始编辑器 main/preload/renderer 目录均存在、Apache-2.0 LICENSE/NOTICE 有效。缺任一项就拒绝进入资源 staging 和 electron-builder，不悄悄使用未知 fork。六编辑器 opt-in 不能绕开 CLI opt-in。
3. 原有 `stage-genoffice-resources.cjs`：只搬既有 GenOffice CLI/WASM/许可证/六套原厂已构建 renderer；保留其资源完整性 SHA 和缺失时原 stage 回滚策略。
4. 原有 electron-builder/afterPack 校验：检查实际复制的 renderer 静态资源及版次一致性。

**默认无 opt-in 构建**只包含明确的 `bundled:false` 资源标记，不要求 CI 持有被 Mcode 忽略的 vendor Git 树；本门禁也不擅自修改、clone、checkout、reset 用户本地 GenOffice。若确实要升级到新上游源码，先由 owner 复核上游代码/许可证/正常与坏输入，再单独审核修改锁 SHA 与相关功能和发行回归，不在打包脚本里自动 `git pull`。

## 已覆盖和仍缺的证据

- 通过隔离 synthetic Git 测试确认正常 HEAD、错误 SHA、dirty tracked 文件、untracked 新 native 源码、六应用缺目录、缺 NOTICE、无效锁、无 opt-in、非法 opt-in，以及正式 package 命令必须先校验再 stage；`genoffice-source-smoke` 对此前没有校验的打包命令产生真实红例。**2026-10-20 L3 升级实证**：GenOffice PDF 原实现以 PID 固定 `.gensave-<pid>.tmp` 命名，同进程写者会互相覆盖/删临时文件，另一开发 owner 已在原厂仓将 `atomic-write.ts` 改为 `randomUUID` + `open(wx)` 私有临时文件 + `fsync` 后 rename + 只清理己方临时文件，且在原厂测试加入并发临时文件保全的红绿。锁保持旧 cbec600 时真实 opt-in 发行校验 **exit1**，更新 73ba918 和补丁血统后真实校验 **exit0**。原厂 `@genoffice/pdf` 的 `page-operation-atomic-write` / `save-pdf` / `edit-ops` 共 **108/108 PASS**、原厂 PDF typecheck exit0；Mcode `genoffice-source-smoke` 从 11 扩展至 **17/17 PASS**，含旧 HEAD、错误补丁父提交、伪造变更文件列表/漏补丁元数据等安全拒绝；与编辑器资源/发行 smoke 合跑 **3/3 套 PASS**，Mcode Desktop/Contracts 双 tsc exit0。
- 可执行命令：`node apps/desktop/scripts/genoffice-source-smoke/main.cjs`；在真实开发源码 checkout 检查 `set MCODE_INCLUDE_GENOFFICE_BUNDLE=1&& node apps/desktop/build/verify-genoffice-upstream.cjs`（Windows cmd）。
- **没有因此完成**：六套原生 GUI 的 main/preload/Host RPC、Rust sidecar 和 PDFium 在离开开发机后的 U1；GenOffice 原版 AI 选区→审阅→撤销的三 SDK 桥；Node-RED 一执行事实源；真实 Electron 六格式编辑/另存/关闭重开、许可证 SBOM；完整安装后的跨 OS E2E-1～6。
- 原始编译目录存在和资源完整性属于 **来源/发布门禁**，不是六格式功能存在的证明。FULL-2～6 仍必须逐项开发并由独立审核验收，ARC-007 双勾不得因本门禁绿而改变。
