# T155 — Slides 标签关闭绕过原厂未保存保护

**Status**：`done`（实现提交 `439d1f86343b3e35f625948f91fc82ab181a4b8e`；ARC-007 整包仍开放）
**Category**：P1 产品缺陷（GenOffice / ARC-007）
**发现来源**：T94 六编辑器 GUI 只读核查；与 T29 的原厂关闭守卫属于同一关闭通路
**Depends on**：T29（`d46a152a`）、T94（只读证据）、T7 真 Electron U1
**Exclusive writable files**：
- `apps/desktop/src/main/document/documentViewHost.ts`
- `apps/desktop/src/main/document/genofficeNativeVendor.ts`
- `apps/desktop/src/main/document/genofficeNativeVendorStub.ts`
- `apps/desktop/src/main/document/genofficeEntryTypes.d.ts`
- `apps/desktop/src/main/ipc/index.ts`
- `apps/desktop/scripts/t29-document-view-close-u1/journeys/close-journeys.ts`
- `apps/desktop/scripts/t29-document-view-close-u1/journeys/index.ts`
- `apps/desktop/scripts/t29-document-view-close-u1/run.mjs`（更新套件覆盖范围说明）
- 新增 `apps/desktop/scripts/t29-document-view-close-u1/run-slides-close-u1.mjs`（先取得共享 heavy-test lease，再启动真实 Electron U1）
- `apps/desktop/scripts/document-view-host-smoke/main.ts`（更新 T29 (f) 的 Slides 关闭断言；并将已有 `mcode:document-view:write-recovery` 注册通道纳入 stale internal-channel allowlist；保留其他对话的 FILE_URL 修改，绝不暂存/提交该修改）
- `apps/desktop/scripts/t7-genoffice-u1/journeys/slides-open-edit-save-reopen.ts`（同步修正过期关闭路径注释）
- 新增 `apps/desktop/scripts/t29-document-view-close-u1/mutate-slides-close.mjs`
- 本任务卡、`tasks/README.md`、`audit-ledgers/Mcode_统一审查台账.md`

禁止编辑 `genoffice/` 上游源码与 `patches/genoffice/`。`document-view-host-smoke/main.ts` 仅允许修改本卡指定的 Slides 旧行为断言和相邻注释，以及对已有 `write-recovery` 注册通道的测试清单修正；必须保留并排除暂存该文件中其他对话的未提交 `FILE_URL` 修改。保留工作区所有其他变更；不得 reset/clean，不得整文件回滚。

## Required Skills
- `implement`：按任务卡最小实现，精确暂存并提交。
- `mcode-smoke`：旧红 → 修复 → 新绿、变异与逐字节还原。
- `desktop-testing-electron`：真实 Electron U1 与确定性系统弹窗端口。
- `code-review`：完成后审查 diff 是否匹配本卡、是否引入并行实现。

## 开工前必读
- `tasks/README.md`
- `audit-ledgers/README.md`
- `audit-ledgers/Mcode_统一审查台账.md` 中 ARC-007 / GenOffice 关闭与会话相关条目
- `tasks/T29-document-view-close.md`
- `tasks/T94-six-editor-gui.md`
- `apps/desktop/src/main/document/documentViewHost.ts`
- `apps/desktop/src/main/document/genofficeNativeVendor.ts`
- `genoffice/apps/slides/src/main/slides-main.ts` 中 `requestSlidesClose`
- `apps/desktop/scripts/t29-document-view-close-u1/journeys/{index,close-journeys}.ts`

## 根因与失败反例

`DocumentViewHost.closeWithDirtyProtection()` 当前在 `live.editor === "slides"` 时直接调用 `close(docId)`，跳过 `vendorCloseGuard`。Slides 原厂主进程已有 `requestSlidesClose(contents, parent)`：干净时放行；有未保存编辑时遵循原厂自动保存偏好或弹出“保存 / 放弃 / 取消”，保存失败或取消则保持打开。Mcode 目前的四格式转发只覆盖 PDF、Markdown、HTML、Sheets。

失败反例：打开一个 PPTX、通过真实 Slides 编辑会话修改文本但不保存，再调用生产 `documentView:close`；当前宿主直接销毁视图，不询问用户，内存修改可能丢失。T94 的“Slides 走 close-check 并 2 秒超时”描述与当前代码不一致；以当前源码为准，实际问题是 **Slides 绕过关闭保护**，不是超时拒绝。

## 目标

将 Slides 纳入既有 vendor 关闭守卫的同一通路，不复制 dirty 状态或保存实现：
1. `DocumentViewHostPorts.vendorCloseGuard` 与 setter 支持 `slides`；Slides 不再走直接关闭旁路。
2. `genofficeNativeVendor.ts` 直接转发原厂 `requestSlidesClose`；缺失 vendor 快照时 stub 返回 `false`（fail-closed）。
3. 生产 IPC 装配继续注入同一个 `requestNativeViewClose`，不新增平行关闭机制。
4. 扩展现有 T29 真 Electron 关闭旅程覆盖 Slides；原有四家回归不得破坏。
5. 为旧行为编写变异验证：恢复 Slides 直接关闭旁路后，Slides dirty-close 旅程必须变红，随后精确还原。

## 验收判据

- [x] 旧行为变异红：恢复 Slides 直接关闭旁路后，dirty-close 返回 `ok:true`、视图/会话销毁且确认框 0 次；证据 `.tmp/electron-u1/2026-10-26T08-37-02-084Z/t29-close-slides-after-unsaved-guard/journey-result.json`。
- [x] Slides 干净关闭成功；未保存关闭调用原厂三按钮确认（通过确定性 Electron dialog port 记录按钮/响应）；选择“取消”后视图与 Host 会话保留，PPTX 磁盘 SHA-256 不变；选择“不保存”后视图关闭。
- [x] Slides 的关闭路径转发原厂 `requestSlidesClose`，不复制 vendor dirty 判定；自动保存偏好仍由 vendor 原实现决定。
- [x] vendor 缺失时 stub 返回 `false`、关闭守卫 fail-closed；Docs 与工作流视图关闭语义不变。
- [x] T29 的 PDF / Markdown / HTML / Sheets 四条既有旅程与新增 Slides 旅程全绿：5/5 PASS。
- [x] 变异验证：恢复旧 Slides 直接关闭分支 → Slides 旅程明确 FAIL；`Buffer.equals` 确认 `documentViewHost.ts` 原字节精确还原。变异前取得共享 heavy-test lease。
- [x] Desktop 与 Contracts `tsc --noEmit`、相关 smoke 与 `git diff --check` 通过；证据、源码 SHA 与剩余风险已回写。
- [x] 实现与回归网已精准提交 `439d1f86`；并行工作区修改未进入提交（`document-view-host-smoke/main.ts` 中其他对话的 `FILE_URL` 变更保留为未提交）。

## 建议验证命令

```bash
node apps/desktop/scripts/t29-document-view-close-u1/run-slides-close-u1.mjs --only=t29-close-slides-after-unsaved-guard
node apps/desktop/scripts/t29-document-view-close-u1/run-slides-close-u1.mjs
node apps/desktop/scripts/run-smokes.mjs document-view-host-smoke
```

Desktop / Contracts 类型检查按仓库现有 `tsconfig` 命令执行。不要把 E1 smoke 或静态源码检查写成 U1。

## 结果回写

### 2026-10-26 结果

- **实现提交**：`439d1f86343b3e35f625948f91fc82ab181a4b8e`（12 文件，251 insertions / 75 deletions）。
- **真实 Electron U1**：`node apps/desktop/scripts/t29-document-view-close-u1/run-slides-close-u1.mjs`，5/5 PASS；证据根 `.tmp/electron-u1/2026-10-26T08-07-46-476Z/`。Slides 单项证据 `.tmp/electron-u1/2026-10-26T08-07-46-476Z/t29-close-slides-after-unsaved-guard/journey-result.json`：干净关闭；修改通过原厂 `slidesApi.editText`；取消后 `stillThere=true`、`sessionStillHeld=true`，按钮为“保存/不保存/取消”；磁盘文件 5918 bytes，SHA-256 `1e69d79fc4f27ebfe628900388380a0eef74cc23fa5fc5e2e30d3d76e9751bf4` 在关闭前后不变；“不保存”后视图销毁。
- **宿主回归**：`node apps/desktop/scripts/run-smokes.mjs document-view-host-smoke` → `541/541`；日志 `apps/desktop/.tmp/smoke-runs/1793002342902-53208-fSFe6L/document-view-host-smoke.log`。其中 `write-recovery` 内部通道清单修正仅更新测试 allowlist；其它对话的 `FILE_URL` 修改未纳入提交。
- **变异**：`node apps/desktop/scripts/t29-document-view-close-u1/mutate-slides-close.mjs` → `detected=true`, `suiteExit=2`，恢复后 `Buffer.equals` 逐字节一致。旧行为证据 `.tmp/electron-u1/2026-10-26T08-37-02-084Z/t29-close-slides-after-unsaved-guard/journey-result.json`，明确 `reply.ok=true`、`stillThere=false`、`sessionStillHeld=false`、`prompts=[]`。
- **类型/静态检查**：`pnpm --filter @mcode/desktop typecheck`、`pnpm --filter @mcode/contracts typecheck`、两个新增 `.mjs` 的 `node --check`、`git diff --check` 均 EXIT=0。
- **源码 SHA-256**：`documentViewHost.ts` `3a8a1df5e28c73d9f2e8c5fcb9362c973cf0b0dc5794384ee8a2bcadf74185fe`；`genofficeNativeVendor.ts` `c31bdfaa24012c8313c76a1e91f70558842db0b8f602bc5576bfea3c7c22d469`；`close-journeys.ts` `14a0f36cc9bef7d5f18a7c4673f3b90ef947030b66b0c041af67683507cdd2a7`。
- **剩余风险**：Electron U1 使用确定性 dialog port 记录/驱动原厂弹窗，不等于验证 Windows 原生模态框的视觉/键盘行为；ARC-007 整包验收、完整 Office 功能矩阵与独立审核仍开放。
