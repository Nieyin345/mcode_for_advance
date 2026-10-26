# O29｜Mac DMG 与自动更新 ZIP 的真实 GenOffice 负载阻断

更新：2026-10-26。状态：发布门禁代码与跨平台模拟测试 PASS；真实 macOS DMG/ZIP 的系统验收待执行。

## 问题和修复

O26 已证明 Windows 的真实 NSIS 压缩包与旁边的 win-unpacked 可以不一致；O27 完成可重建 GenOffice 二开源码。但发布工作流先前只核查 Windows 安装器实际负载，Mac arm64/x64 的 DMG 和自动更新 ZIP 仍会直接上传。afterPack 只能证明未压缩 App，不代表两种分发格式的最终内容一致。

新增独立只读工具：
- apps/desktop/scripts/office-release-audit/verify-macos-dmg.cjs：macOS 使用 hdiutil attach -readonly -nobrowse 挂载**真实 DMG**到独立 OS 临时目录，仅允许恰好一个非软链接 .app。读取 Contents/Resources/genoffice/availability.json，必须绑定六种原生编辑器，且与 staging 的 availability.json **原始字节完全相同**。检查审核的 GenOffice HEAD/TREE、Mcode commit/tag version/clean source；复用原有 verifyPackagedGenofficeEditorAssets 逐项校验所有 renderer、preload、CLI 依赖树、WASM、Rust sidecar、license 及其 SHA。挂载结束后执行 detach，清理自己创建的目录。
- 同一工具的 verifyMacZip 使用 macOS 系统 ditto -x -k 将**真实自动更新 ZIP**独立解压到自己创建的临时目录，执行同一来源和实体资源校验。DMG 通过不能代替 ZIP 通过。
- apps/desktop/scripts/office-release-audit/verify-macos-artifacts.cjs：严格要求恰好一个 DMG 和一个 ZIP，分别通过后还要保证二者 Mcode/GenOffice SHA 和版本一致。
- .github/workflows/release.yml：在两个 macOS 架构任务上传产物前，增加 Mac 单元测试和真实 DMG/ZIP 门禁。任何一份缺失/不完整即退出非零；Windows NSIS 原检查不变。
- office-release-gate-smoke/run.sh 加入跨平台的 Mac mock 反例测试，不依赖本机 Mac。

## 执行证据

1. Mac 发布门禁隔离模拟测试 **12/12 PASS**。覆盖快照对不上、DMG 禁用编辑器、伪造源码版本、不完整资源、恶意/重复 App、失败时卸载清理、ZIP 独立损坏、DMG 与 ZIP 不同来源等。
2. office-release-gate-smoke **PASS**，日志 apps/desktop/.tmp/smoke-runs/1792994545041-18064-DjzXoX。
3. 原有 Windows 发行门禁 21/21、源码版本测试 4/4，复跑 PASS。
4. Desktop/Contracts TypeScript PASS，GitHub Actions YAML 解析通过（构建流程 19 步，Mac 检查在上传之前）。

**边界：** 以上在 Windows 机器上验证的是检查器的隔离模拟逻辑；macOS hdiutil/ditto 实物运行尚未执行，不能据此宣称两种 Mac 发行物已经通过。真实在线 Claude/Pi/Codex、WPS/LibreOffice、最新 NSIS 安装升级卸载和正式签名仍待验；ARC-007 不改为整体 PASS。
