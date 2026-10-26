# O29｜完整 Windows 安装包签名与来源校验接入发布上传前

更新：2026-10-26。状态：**CI 发布门禁接通并验证；当前旧 NSIS 保持 BLOCKED，最新正式安装版仍未构建/签名/安装验收**。

## 为什么需要这一项

此前 Windows 发布流水线已经通过 O26/O28 检查真实 NSIS 包里是否存在完整 GenOffice，并完成哈希/资源树比较；但**完整**的 `office-release-audit/verify.cjs`（签名、Git 构建来源、版本、latest.yml、构建时间、脏工作区判断）还没有作为上传 artifacts 的必要步骤。单有真实六编辑器不代表安装器可向用户发布。

本次在 `.github/workflows/release.yml` 的实际 NSIS 资源检查、Windows unpacked 测试之后，在 `actions/upload-artifact@v4` **之前**增加 `Gate Windows installer release signature and provenance`，在 Windows PowerShell 下执行：

```powershell
$env:MCODE_OFFICE_7ZA = "$env:ProgramFiles/7-Zip/7z.exe"
node apps/desktop/scripts/office-release-audit/verify.cjs
if ($LASTEXITCODE -ne 0) { throw "Unsigned, stale, untrusted or incomplete Office installer must not be released" }
```

必须同时通过 Authenticode 状态为 `Valid`、实际 NSIS 负载的完整树和源清单、GenOffice 审核版本、Mcode 源码 SHA/版本及包哈希等判据才允许发布；此步骤不获取/创建签名证书，也不安装软件。没有配置企业或个人合法的 Windows 签名证书时，新 CI 会**正确失败**，不再发布 unsigned 产物。macOS 签名/公证另属其自身发行政策；不能据此声称所有平台安装版都已验收。

## 源码可重建与资源条件核对

- `genoffice-reconstruct-smoke` 及独立全新 Git 克隆的真 34 提交链已通过：公开上游 `1f306a2` → 基线 `cbec600` → 审核 `73ba918` → 32 个 Mcode 补丁 → `f174a91f27c3f499fc5be1d6aa7cc3f63204addd`；源码树固定 `5164ed29fb33cc6d6dd7fc6939861c553648d94c`。
- `prepare-genoffice-release.cjs` 对当前已有的**六编辑器预构建输出**进行了存在性核验并通过，包括 native renderer/preload、CLI dist 和依赖、PDFium WASM、Rust Sheets sidecar、第三方 notice。它只能证明当前本机上已存在对应产物，**不能**替代远程 CI 冷启动的真正全量编译。
- `genoffice-reconstruct-smoke genoffice-source-smoke genoffice-editors-release-smoke office-release-gate-smoke` **4/4 PASS**；Desktop/Contracts `tsc --noEmit` PASS。
- 新增发布流程联动断言：不仅要求 full gate 已注册，还要求 Windows 限定、PowerShell shell、命令错误非零即 throw、且步骤在上传 artifacts 之前。发布审计共 **24/24 PASS**，GitHub Actions YAML 可解析。

## 当前 BLOCKED 的原因

`node apps/desktop/scripts/office-release-audit/verify.cjs` 对现有旧的 `Mcode-0.1.62-x64.exe` 如实返回 exit 2 / **BLOCKED**：Authenticode=`NotSigned`、安装器内 GenOffice `bundled:false` 且实际 native assets 缺失、与随后更新的 win-unpacked 清单不一致、构建来源缺少证明、安装器早于当前 Mcode HEAD、当前并行工作区未冻结。**即便源代码重建和回归都通过，也不应强行上传这一旧安装器。**

## 仍未达成的正式交付

没有可信 Windows 代码签名凭据、无静态来源审核证据的正式远程完整 NSIS 构建、未运行最新版真实安装/升级/卸载。在线 Claude/Pi/Codex 真模型编辑和 WPS/LibreOffice 的完整兼容性同样仍有外部条件，不扩范围，也不勾选 ARC-007 全部验收。
