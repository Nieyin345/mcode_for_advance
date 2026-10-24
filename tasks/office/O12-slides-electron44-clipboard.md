# O12｜GenOffice Slides 与 Electron 44 剪贴板兼容

- Status: **已实现、有界 E1 + 真 Electron 回归通过（2026-10-25）**
- Priority: P0 可用性（原厂 Paste/Copy 的旧 IPC 在 Mcode Electron 44 不再成立）
- 基线：O2 真 Electron Slides U1 曾在页面控制台实际抛出 `clipboard.availableFormats is not a function`，先前 `slides-edit-smoke/probe.ts` 还用 text-only mock 替换过真实 `slides:clipboard-probe`，掩盖原生兼容问题。

## 原因与最小范围

Electron 44 将剪贴板 API 改为异步 `ClipboardItem`，移除 `availableFormats/readBuffer/writeBuffer/readHTML/readImage`；见官方迁移说明 https://www.electronjs.org/docs/latest/breaking-changes 。原版 `genoffice/apps/slides/src/main/slides-main.ts` 和 `element-clipboard.ts` 的同步剪贴板假设不再成立，复制页、复制元素、更新 PNG、外部图片/文本粘贴和 Paste 按钮探测均会触达。

遵循用户“直接在 GenOffice 源码上二开”的要求，在 vendor main 侧复用 **同一** `clipboard-compat.ts`，通过能力检测兼容旧版同步接口与 Electron 44 异步接口；`ipcMain.handle` 调用点遵循异步返回，复制后才发布内部剪贴板状态。新接口使用 Electron 官方的 `ClipboardItem` / MIME 和 `electron application/osclipboard;format="..."`，PNG+HTML 单事务写入；renderer、Mcode IPC 权限围栏与编辑核心不变。

## 结果与可复核证据

- GenOffice vendor 提交：`ec21271a1b502154c6be6568c43ba8c4b0ae30e2`，父提交 O11 的 `483ce5442c2c4ce3988427775fa4f79d005a02b1`，最终 tree `a1e47d3ac02f6e2e70755b9536ed3492c2365c95`。
- Mcode 追踪补丁 `patches/genoffice/0024-fix-slides-electron44-clipboard.patch`，25065 字节，SHA256 `5488f55c3ea68a0ba39dcf4bab5f0cd450e49860a4f3d56107e92c6035f5188f`。`genoffice-upstream.lock.json` 与 `verify-genoffice-upstream.cjs` 固定 **24 patches**，核验 exit0。
- `npx vitest run apps/slides/tests/clipboard-compat.test.ts apps/slides/tests/element-clipboard.test.ts`：现代异步 6 + 旧版同步/元素安全 7，共 **13/13 PASS**，全部使用隔离的模拟剪贴板，不触碰用户系统剪贴板。
- `npm run typecheck -w @genoffice/slides` exit0；Mcode Desktop/Contracts `tsc --noEmit` exit0。
- 移除 `apps/desktop/scripts/slides-edit-smoke/probe.ts` 对 `slides:clipboard-probe` 的替代处理器；真实 `slides-edit-smoke` 在**无 mock** 状态 PASS。O2 真 Electron Slides U1 原先抛 `availableFormats is not a function` 的现场复跑现无此异常且 all-pass，日志 `.tmp/electron-u1/2026-10-24T19-08-29-853Z`。
- `node apps/desktop/scripts/run-smokes.mjs genoffice-source-smoke genoffice-editors-release-smoke slides-edit-smoke`：**3/3 suites PASS**。
- 未声明的事项：还未使用真实系统剪贴板对所有图片/跨应用剪贴板格式逐一 U1 验证；macOS/Linux 原生格式的行为也需跨平台实测。避免测试覆盖用户剪贴板；后续应在隔离会话里做真正 copy→paste→保存→重开和撤销验证。O12 有界完成 ≠ ARC-007 整包完成。

## 本轮精确提交

- Mcode 主仓补丁锁及真实 Electron 测试桩移除：`56d1282aa9c6087df3a9241461a117d61be91c1f`（只提交锁文件、校验器、`slides-edit-smoke/probe.ts` 与第 24 条上游补丁）。
- 后续 Office 台账与 O13 根因定位卡另作文档提交，不将其它对话的 Git dirty 文件并入。
- GenOffice 原厂 `npm run build -w @genoffice/slides` 实际编译 main/preload/renderer **PASS**；因此本机 vendor `out/` 产物已同步本补丁，尚未重新执行 Mcode 安装打包。
