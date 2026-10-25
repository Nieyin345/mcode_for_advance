# O25｜GenOffice 三提供方在线前置条件与 Windows 安装版发布门禁

更新：2026-10-25。执行结果：**门禁与构建证明功能已落地；当前 0.1.62 正式发布 BLOCKED，外部验收约束未解**。本轮不扩 UI、不另起 vendor Electron、不消费模型额度、不安装或卸载任何程序，保留并行任务工作区。

## 1. 三 SDK 的实际条件核实（不读取凭据）

- `claude auth status`：`loggedIn:false`、`authMethod:none`（程序显示的配置目录是 Mcode；没有凭据）。
- `codex login status`：`Logged in using ChatGPT`，仅表示本机 Codex CLI 有现存用户会话，并不意味着 Mcode 的 Codex SDK 在线原生工具编辑已完成一次真实回合。
- Pi：`@earendil-works/pi-coding-agent` SDK 已安装、用户主目录中存在 `.pi/agent/auth.json`，只检查文件存在性，**没有读取里面的密钥或测试权限范围**；真实认证有效性仍未知。
- `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` 都未配置。这些事实不等于 Codex/Pi 不可连接；也不代表真实在线账务可免费或无需本人许可。
- **不发送真实 Claude、Pi 或 Codex 模型请求**。这三家在线编辑闭环仍未验收；现有 O1 46/46 SDK 协议替身、O22 真 Docs 编辑与保存但使用确定性 SDK 替身的证据继续有效，二者不能混称在线全绿。

## 2. 最新 NSIS 安装器的发布门禁

新增 `apps/desktop/scripts/office-release-audit/verify.cjs`，纯只读命令，不安装/卸载/重打包：
```powershell
node apps/desktop/scripts/office-release-audit/verify.cjs
```
真正可以发表的产物必须同时满足：`release/latest.yml` 与安装器文件名、大小和 SHA-512 全相符；当前 `package.json` 版本吻合；Windows Authenticode 有效；`win-unpacked/resources/genoffice/availability.json` 列出六编辑器、CLI/PDFium WASM/Rust sidecar 和 SHA-256；**实际调用原厂 afterPack 完整性校验**读取实体依赖和哈希；安装器不能早于当前 Mcode HEAD，也不能早于所对照的 unpacked 资源；打包清单必须声明审核的 GenOffice fork Git HEAD/TREE，以及 Mcode 构建时 HEAD 和 `mcodeSourceClean===true`；本次 Git 工作区必须冻结（无其他未提交修改）。证据不足 -> `BLOCKED`、exit 2；不“乐观通过”。

对 `apps/desktop/build/stage-genoffice-resources.cjs`（此前 O3 禁止修改的阶段现在是未来正式发布功能的一部分）做局部补强：只有真生产包启用六编辑器时才以 Git 检验 fork 的 HEAD/TREE 与 32 条补丁上游锁一致、vendor 工作区没有未提交源修改，并在 `availability.json` 中记录 `genofficeSourceRevision`、`genofficeSourceTree`、`mcodeSourceRevision` 和 `mcodeSourceClean`。所有隔离测试夹具保持不需要 Git checkout；不修改实际 editor 二开源码或额外运行时。它是“构建输入源码指纹”，不声称单凭这些字段已经证明 `out/renderer` 曾由相同 HEAD 编译；资源实体 SHA-256/构建期校验是另一项必要条件。

在当前 0.1.62 旧 installer 上实测返回 `BLOCKED`，报告：
- **UNSIGNED_INSTALLER**：文件 `Mcode-0.1.62-x64.exe` 的 Authenticode = `NotSigned`。
- **STALE_INSTALLER**：安装器的修改时间为 2026-10-24T05:34:17Z，早于当前 Mcode HEAD。
- **STAGED_AFTER_INSTALLER**：现有 win-unpacked 的六编辑器资源清单更新时间为 2026-10-24T11:08:48Z，晚于发布安装器，不能证明二者同一份构建。
- **MISSING_SOURCE_ATTESTATION / UNATTESTED_BUILD**：旧包未嵌入 fork 树指纹 / Mcode 构建来源；本轮新打包脚本已具备生成能力，但**旧包没有被追溯补写**。
- **DIRTY_WORKTREE**：多个并行执行对话仍有独立未提交修改，现阶段不能称为发布冻结状态。
- 与之明确区分：`latest.yml` **文件大小和 SHA512 匹配现有安装器**；现有 `win-unpacked` 的六个 GenOffice 编辑器 **实际资源完整性检查 PASS**。阻断不是资产缺失或哈希坏档。

## 3. 测试

- `node --test apps/desktop/scripts/office-release-audit/verify.test.cjs`：**13/13 PASS**，覆盖正向发布样本、已被篡改但长度相同的安装器、缺资源/缺签名、版本错、源码指纹缺失和不匹配、dirty source、老安装器和超前 staged 资源、恶意 latest asset 命名等。
- `node apps/desktop/scripts/run-smokes.mjs office-release-gate-smoke`：同一份 fixture 试验正式纳入 Mcode smoke 发现器。
- `genoffice-editors-release-smoke`、`t76-vendor-release-integrity-smoke`、`genoffice-source-smoke`：**3/3 PASS**，运行目录 `apps/desktop/.tmp/smoke-runs/1792937912032-11356-LoOHkd`。Desktop/Contracts 双包 TypeScript 及 32 份源码补丁验证通过。
- 真旧 release 的 afterPack GenOffice 编辑器实体哈希核验另行 PASS；未动旧安装器。
- 文档宿主 `document-view-host-smoke` 仍 **537/538**，差异仅 `mcode:document-view:write-recovery` 被旧内部 IPC 固定名单漏记；该文件本轮开始就由其他对话修改，本轮不覆盖。

## 4. 未达成的外部验收

真实在线 Claude、Pi、Codex **三个各一次的授权模型工具编辑**；WPS/LibreOffice 及更多文件复杂组合的实际回读；**最新代码**的 NSIS 安装/升级/卸载（旧 O3 只是 win-unpacked 解压态）和 Windows 有效代码签名。并行工作区冻结、真实签名凭据和用户对可能付费在线模型调用的授权尚未完成，不伪造通过。不把 ARC-007 / 产品“完全后端完成”改成全绿。
