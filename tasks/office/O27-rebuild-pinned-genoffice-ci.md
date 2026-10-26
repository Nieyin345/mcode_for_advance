# O27｜从公开上游重建 GenOffice 二开，接入干净 CI 发布链路

更新：2026-10-26。状态：**源代码重建全链路已实现且本机精确重放 PASS；CI 实际完整编译/签名/安装待验**。

## 缺陷与根因

之前 O26 明确发现：旧的 `Mcode-0.1.62-x64.exe` 内只有 `resources/genoffice/availability.json`，`bundled:false`、`editorsBundled:false`；同目录 `win-unpacked` 反而有六编辑器，不能代表安装器内容。发布工作流只有 `actions/checkout` 和 `pnpm package`，但 `genoffice/` 是 Mcode 主仓库 `.gitignore` 中的独立 Git checkout；干净 CI 不存在它，也没有构建六编辑器所需的 npm/Rust 产物。因此仅增加 O26 NSIS 拦截器，仍不能生成真正带 GenOffice 的安装包。

**进一步定位**：既有 `cbec600` 也不是公开上游 SHA，而是基于公开 `1f306a2a496227cae9194097897212c93d00a4e6` 的本地 CLI 补丁。首个审核 PDF 补丁 `73ba918` 同样需要从源代码重建，不能只克隆公开上游 main 后直接检出 `cbec600`。另有 0012 补丁实际 committer 日期与 author 日期相差 22 秒，必须按历史元信息重建该提交，否则即使 Git 源码树相同，提交 SHA 也会改变，来源锁拒绝。

## 实现与审计边界

- 固定公开上游 SHA `1f306a2a496227cae9194097897212c93d00a4e6`，新增离线导出的邮件补丁 `patches/genoffice/0000-upstream-base-cli-source-launch-guard.patch`，其 sha256 为 `ed345f220a1a2ff6d95216bf1d843e99ab21fb2d8dc86e45082622d2dbe3452f`，6547 B。原审核首补丁 `patches/genoffice/0000-fix-pdf-use-privately-owned-atomic-save-temporary-files.patch`，SHA256 `4e59d305ebf8334cb25266512b19e78fe1d11bb33cbf8321fa13c695f1c2fe4f`，3815 B。再应用现有 32 条审核过的 vendor patch。
- 在 `genoffice-upstream.lock.json` 中固定两项重建基线身份与 0012 补丁的独立 committer 日期；`verify-genoffice-upstream.cjs` 新增基线补丁文件存在性/大小/哈希/邮件头验证、真实 baseline parent 校验，原有完整 lineage、最终 HEAD/TREE、忽略源代码防护维持不变。已有所有 Patch SHA 未被改写。
- `prepare-genoffice-release.cjs` 仅在 `CI=true` 且 checkout 不存在时允许从固定公开 upstream 克隆，再逐条 `git am` 并逐个比较实际 commit SHA，失败即拒绝和清理自己新建的 checkout；已经存在的用户 `genoffice/` 只读审查，不 reset、pull、checkout、clean 或覆盖。GitHub 上游 clone 后强制 checkout **公开固定 commit**，不直接使用可变化的 main HEAD。运行 `npm ci --ignore-scripts`、`npm run notices`、六编辑器原厂 build 及 CLI build（Sheets 的原厂 build 同时调用 Cargo 构建 sidecar），**不运行 GenOffice 独立 Electron shell**。最终验证物理 renderer、preload、CLI、WASM、native sidecar 文件与源码锁。
- 为本地/CI Tag version stamping 创建 `release-source-state.cjs`：默认要求 Mcode 源码零修改；仅容许发布工作流明确标记版本、且整个 package.json 在还原 version 后与 Git HEAD 语义完全一致这一种变更。不允许并行 UI/工作流任务的未提交代码混入签发构建。
- `stage-genoffice-resources.cjs` 在 manifest 写入 `genofficeSourceRevision` / `genofficeSourceTree` / `mcodeSourceRevision` / `mcodeSourceClean` / `mcodeReleaseVersion`，符合来源冻结才发布。旧 O25 安装器审核增加版本一致性失败码。`package.json` 把 vendor upstream 来源校验设成**明确开启** `MCODE_INCLUDE_GENOFFICE_BUNDLE=1` 和 `MCODE_INCLUDE_GENOFFICE_EDITORS=1`，不再无参数 opt-out 验证。
- `.github/workflows/release.yml` 在 Mcode package 前安装 Rust 工具链、重建并构建 GenOffice、导出 Tag 对应的 `MCODE_RELEASE_VERSION`。Windows MCP contract gate 额外执行 `genoffice-source-smoke` 和 `genoffice-reconstruct-smoke`，O26 的 **真实 NSIS 负载**检查仍必须在上传前通过。

## 真实执行与回归

1. 在本机从已审核的 vendor clone 拷到只读/隔离临时 Git clone，明确 checkout **公开** `1f306a2`，应用 base + approved + 32 patches，逐个核对精确 commit SHA，最终 **PASS**：
   - HEAD `f174a91f27c3f499fc5be1d6aa7cc3f63204addd`
   - TREE `5164ed29fb33cc6d6dd7fc6939861c553648d94c`
   - 32/32 已审核 vendor 补丁；另含 2 条审核基线补丁
   - 全程在自己的临时目录，未修改生产 vendor checkout。
2. 新增 `genoffice-reconstruct-smoke`，真实隔离 Git clone 与全链式重放 → PASS，日志 `apps/desktop/.tmp/smoke-runs/1792987008247-48248-AYPzGN`。
3. `genoffice-source-smoke` 升级夹具以同时复制公开上游基线补丁和 PDF 首补丁，并新增防篡改反例；重新 PASS。原来新基线刚接入时旧 smoke 因测试夹具没有复制新增补丁而红，修正测试夹具后真实完整 4 套发布相关 smoke `genoffice-source-smoke genoffice-editors-release-smoke t76-vendor-release-integrity-smoke office-release-gate-smoke` → **4/4 PASS**，日志 `apps/desktop/.tmp/smoke-runs/1792986868629-53068-k7EKvs`。
4. `release-source-state.test.cjs` **4/4 PASS**；安装包安全/发布门禁回归 `verify.test.cjs` **18/18 PASS**；Desktop/Contracts 双包 TypeScript PASS，GitHub Actions YAML 解析与“构建 GenOffice 在 Mcode package 前”顺序 PASS。
5. 本机只读 `verifyBuiltAssets(genoffice)` 检查六 renderer、五 preload、CLI、CLI 依赖、PDFium WASM、THIRD-PARTY-NOTICES 及 Rust sidecar 均存在 → PASS；这仅代表本机已有构建产物，不冒充 GitHub Actions 刚进行了正式编译。

## 未达成判据和发布边界

- **未触发 GitHub 真实 CI**，也未在无本地 Git 对象的隔离云机器执行一遍公网 clone + npm 全构建、全平台 Rust 编译、electron-builder、真实 NSIS/DMG 打包。当前只能对本机共享的公开基线祖先对象做完整离线重放和已有构建产物验证。
- 旧的 `0.1.62` 安装器仍没有 GenOffice；O26 阻断不会被取消。尚未生成最新源码的 NSIS 并做安装、升级、卸载验收；未具备真实 Windows 签名证书，不能伪造绿色 Authenticode。
- 三家真实在线 Claude/Pi/Codex 工具调用（收费权限/登录条件）、WPS/LibreOffice、多复杂 Office 文件全保真，和其它对话正在变更的 `document-view-host-smoke` 仍非本项完成内容。
- 发布流水线仍需要在真正的远端构建后检查 installer's embedded availability.json 与六编辑器内容，O26 已有的 `verify-nsis.cjs` 执行该项。ARC-007 整体不得因源码重建通过而标记全面验收 PASS。

## 复跑

```cmd
node apps/desktop/scripts/run-smokes.mjs genoffice-reconstruct-smoke genoffice-source-smoke genoffice-editors-release-smoke t76-vendor-release-integrity-smoke office-release-gate-smoke
node --test apps/desktop/build/release-source-state.test.cjs apps/desktop/scripts/office-release-audit/verify.test.cjs
node -e "require('./apps/desktop/build/prepare-genoffice-release.cjs').verifyBuiltAssets(require('node:path').resolve('genoffice'));console.log('READY')"
```

发布本地工作区有并行未提交代码时，严格阻断正式 staging；切勿为通过 gate 而清理或提交其他对话的文件。
