# O26｜NSIS 安装器实际负载必须包含 GenOffice，禁止以 win-unpacked 代替验收

更新：2026-10-25。状态：**真正的安装器缺陷已查明；发布阻断及 CI 防回归已实现；旧 NSIS 仍不得发布。**

## 根因与实物证据

- `apps/desktop/release/win-unpacked/resources/genoffice/availability.json` 报告 `bundled:true`、`editorsBundled:true`、六格式就绪，之前 O3 解压版六格式 U1 通过。
- **但是**通过 electron-builder 自带 7za **直接读取** `apps/desktop/release/Mcode-0.1.62-x64.exe` 归档内 `resources/genoffice/availability.json`，实际为 `{"format":"mcode.genoffice.resources.v1","bundled":false,"editorsBundled":false,"editors":[]}`。进一步用 7za 路径清单确认 NSIS 中 GenOffice 路径**只有** `resources/genoffice/availability.json`，缺原生 Docs/Sheets/Slides/PDF/Markdown/HTML renderer、五个 preload、CLI、PDFium WASM 和 XLSX sidecar。
- 安装器本体仍是 2026-10-24 的旧包；旁边 `win-unpacked` 资源随后又被阶段构建重新写入，所以**并不是同一次构建快照**。7za 在安装器中看到的是真正将被安装的负载，不能用外部 `win-unpacked` 的哈希证明安装器已包含资源。
- 因此此前的 O3 与 O25 解压态完整性 PASS 不能推出正式 NSIS Office 可用。旧安装器属于明确的**功能不完整发布阻断**，而不仅仅是签名不足。

## 本轮修复

1. 新增 `apps/desktop/scripts/office-release-audit/nsis-inspector.cjs`：自动查找 electron-builder 的用户缓存 7za（或由 `MCODE_OFFICE_7ZA` 显式指定），只读解析真实 NSIS 的 `availability.json` 和 GenOffice 归档目录；硬性要求包含六原生编辑器 renderer、五个 preload、CLI、PDFium WASM、原厂 LICENSE 和 Rust XLSX sidecar；不安装、不执行安装器、不复制数据到用户目录，找不到 7za 即 fail-closed。
2. 扩展已有 `verify.cjs` 发布门禁：实际报告 `installerGenofficeBundled` / `installerEditorsBundled` / `installerGenofficeFiles`，增加 `NSIS_PAYLOAD_MISSING_EDITORS`、`NSIS_MANIFEST_MISMATCH`、`NSIS_INSPECTION_FAILED` 阻断码。对照实际 installer 内嵌 manifest 与旁边解压态 manifest；同机 Windows 的实际旧包必须返回 `BLOCKED`（exit 2），同时保留原有六编辑器资源实体哈希 PASS 诊断。
3. 新增独立 `verify-nsis.cjs` CI 检查：直接以 NSIS 负载和解压态 manifest 为输入，即便 7z 自己的 CRC 测试通过，缺 GenOffice 也返回 exit 2。
4. 在 `.github/workflows/release.yml` 原有 Windows `7z t` 完整性检查之后、上传产物之前插入 `Verify actual NSIS contains six native GenOffice editors`：GitHub Windows Runner 指定 `$env:ProgramFiles/7-Zip/7z.exe`，检查不通过**阻止发布**。这不是修补旧安装器内容；未来仍需在 CI 中提供经审核的 GenOffice fork 和真实 editor 构建产物才能生成正确安装包。不能绕开生产签名与来源验证。
5. 扩充 `verify.test.cjs`：共 **17/17 PASS**，新增真实 NSIS 空包、实际缺 preload、无法读取压缩包（必须拒绝）、CI 只比对解压态的虚假通过等反例。旧实物验证 `verify-nsis.cjs` 返回 exit 2、`installerBundled:false`、`installerEditorsBundled:false`、`embeddedGenofficePaths:1`；`verify.cjs` 新增两条明确的 NSIS 安装器阻断码。

## 尚未满足的外部条件

- 正式安装器仍需要**受控、干净、可审计且带六个 GenOffice native editor 的 CI 构建**；仓库发布工作流目前没有独立下载或编译二开的 GenOffice，已有 `package` 任务依赖该本地源码/构建的存在。未擅自重新打包或向 CI 引入未经审核的第三方网络下载/License 包。
- 旧安装器未签名；正式签名需要用户/组织的真实证书与发布政策。不可用模拟签名冒充。
- 最新 NSIS 安装/升级/卸载的机器端验收仍需在满足上述条件后的新构建进行。本次只是**阻断已知缺陷并修复测试盲区**，不宣称新安装器已造出。
- 在线 Claude/Pi/Codex 三家各一次的授权模型编辑、WPS/LibreOffice 回读、历史 `document-view-host-smoke` 固定 IPC 清单单点失败仍未完成，不改变 ARC-007 的整体状态。

## 复核命令

```cmd
node --test apps/desktop/scripts/office-release-audit/verify.test.cjs
node apps/desktop/scripts/office-release-audit/verify-nsis.cjs apps/desktop/release/Mcode-0.1.62-x64.exe apps/desktop/release/win-unpacked/resources/genoffice/availability.json
node apps/desktop/scripts/office-release-audit/verify.cjs
node apps/desktop/scripts/run-smokes.mjs office-release-gate-smoke genoffice-editors-release-smoke t76-vendor-release-integrity-smoke
```

最后两个针对**旧生产实物**的检查预期 exit 2、BLOCKED，不得在日志里算 PASS；单元测试和三套 smoke 的通过另行报告。
