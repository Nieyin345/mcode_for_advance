# O28｜NSIS 实际全量 GenOffice 资源 SHA256 验证

更新：2026-10-26；状态：**完整资源树验收实现并验证 PASS；旧安装器正式发布仍 BLOCKED**。

## 修复动机

O26 拒绝没有 GenOffice 的旧 NSIS，O27 允许干净 CI 重建已审核的 34 条 Git 补丁，但 O26 的安装器检查只读取内部 `availability.json` 并列出 15 个关键文件路径。一个安装器即使声明六编辑器、且包含全部 15 个入口文件，也可能将数千个 JS/CSS chunk 换成不一致的旧版；旧校验无法直接证明**NSIS 内部完整资源树**与同版本 staging 资产一致。

## 本轮变更

仅改动 `apps/desktop/scripts/office-release-audit/` 中原有四个发布门禁文件。CI 已经调用 `verify-nsis.cjs`，不新增第二套命令、不修改生产 Mcode 或 GenOffice 编辑运行时：

- `nsis-inspector.cjs` 从**安装器本体**提取并流式计算 15 个核心文件的 SHA-256，对比已校验的解压态同名文件，包括 Office CLI、PDFium WASM、XLSX Sidecar、许可证、六编辑器入口和五 preload。
- 对 NSIS 内部属于 `resources/genoffice` 的归档路径先进行严格检查，拒绝绝对/逃逸路径、`..`、空分段和不安全路径。随后仅把该 GenOffice 子树提取到 **新建、独占的系统临时目录**，直接调用原有 `verifyPackagedGenofficeEditorAssets` 完整哈希校验器，覆盖六编辑器所有 chunk、preload、CLI、PDFium、Sidecar 与许可证；验证失败即阻断，成功或失败只删除**本次自己创建的临时目录**。不运行安装器、不安装或卸载 Mcode、不改用户工作区。
- `verify-nsis.cjs` 现在要求归档内 manifest 与 `win-unpacked` manifest 一致、15 个核心文件 SHA256 均匹配，且**整个归档资源树**按原厂 afterPack SHA256 规则核验成功；缺任一证据即非零退出。
- `verify.cjs` 扩展 `NSIS_CORE_ASSET_MISMATCH` 与 `NSIS_FULL_TREE_MISMATCH` 两个发布阻断码。要求的是 NSIS 实际文件，而非将某个解压目录的回归结果冒充 NSIS 内容正确。
- `verify.test.cjs` 加了核心二进制内容替换、缺全树证据、恶意路径阻断、非入口 chunk 篡改、失败后临时目录清理等负判据。

## 可核验证据

- `node --test apps/desktop/scripts/office-release-audit/verify.test.cjs` → **23/23 PASS**，既包括正向样本也包括所有上述 fail-closed 负例。
- `node apps/desktop/scripts/run-smokes.mjs office-release-gate-smoke genoffice-source-smoke` → **2/2 PASS**，日志 `apps/desktop/.tmp/smoke-runs/1792994502123-21128-1bYQDa`。
- Mcode Desktop 和 Contracts 两套 `tsc --noEmit` → **PASS**。
- 在隔离临时目录中，使用现有已验证的 `apps/desktop/release/win-unpacked/resources/genoffice` 生成 **约 2,888 条目录/文件记录的测试 7z 归档**。调用新增的真实 `readPayload(archive, {compareRoot: unpackedGenofficeRoot})`，**缺失核心文件=0，15 个核心文件 SHA256 完全一致，整棵 GenOffice 资源树在实际 7za 解压后通过原厂 afterPack 哈希验证**。测试归档及临时解压产物结束后清理。这是**真实文件正例**，但它只是合成 7z 测试包而非 NSIS 本体，不冒充最新安装包成功。
- 真实的旧 `Mcode-0.1.62-x64.exe` 再跑 `verify-nsis.cjs` → **预期 exit 2 / BLOCKED**：缺六原生编辑器，`installerBundled:false`、`embeddedGenofficePaths:1`，也无完整树证明。

## 仍未达成及边界

- 并行对话还在修改 Mcode，未生成最新干净来源的正式 NSIS；没有真实安装/升级/卸载验收，也没有用户/组织的有效签名证书。
- O27 已证明公开基线加审核补丁在隔离 Git clone 中可精确重建源码树；但是 CI 远端完整编译、Windows NSIS 和 macOS DMG 真正重打包仍需受控发布环境验证。
- 不将本轮的独立 7z 包正向验收等同于 NSIS 正式发布成功；加密 DOCX、WPS/LibreOffice 以及在线 Claude/Pi/Codex 各自完整编辑仍分别保留原台账状态。
- 与其他执行对话同时修改的 UI、workflow、extension、`document-view-host-smoke` 和本目录里其他未提交的 macOS 测试文件均未触碰。

复跑：

```cmd
node --test apps/desktop/scripts/office-release-audit/verify.test.cjs
node apps/desktop/scripts/run-smokes.mjs office-release-gate-smoke genoffice-source-smoke
node apps/desktop/scripts/office-release-audit/verify-nsis.cjs apps/desktop/release/Mcode-0.1.62-x64.exe apps/desktop/release/win-unpacked/resources/genoffice/availability.json
```

最后一行检查旧空安装器**必须 FAIL**，不能算作验收全绿。
