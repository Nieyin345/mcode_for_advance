# T87｜GenOffice 上游补丁链与 18 项第三方许可证闭环

| 项目 | 值 |
|---|---|
| 编号 | T87 |
| 来源 | T76：GenOffice upstream gate 与严格 notice 门禁阻断 |
| 优先级 | P1；真实发布资源的前置门禁 |
| 依赖 | 复核 T76 回写；不依赖 T88，可并行 |
| 目标 | 让发行校验能证明“准确上游基线 + 审查过的 Mcode patch series”，并让最终随包 notice 包含 18 个依赖的真实完整许可证文本 |
| 独占可写 | `apps/desktop/build/genoffice-upstream.lock.json`、`apps/desktop/build/verify-genoffice-upstream.cjs`、`apps/desktop/build/stage-genoffice-resources.cjs`、`apps/desktop/build/verify-genoffice-editors-after-pack.cjs`、新增 `apps/desktop/build/vendor-licenses/genoffice/**`、新增 `apps/desktop/scripts/t87-genoffice-provenance-license-smoke/**`、本任务卡 |
| 仅只读 | `genoffice/**`、`patches/genoffice/**`、`apps/desktop/scripts/genoffice-editors-release-smoke/**`、`apps/desktop/scripts/t76-vendor-release-integrity-smoke/**`、`apps/desktop/electron-builder.yml`、`release-readiness-smoke/**`、`main/modules/**`、`main/appControl/**` |
| 禁止 | 不得 reset / checkout 改动当前 `genoffice` 工作树；不改上游生成产物或依赖树；不把锁定 SHA 直接改成当前 HEAD 来消除报错；不伪造 license placeholder；不执行完整 installer |

## 已核实的当前事实

- `apps/desktop/build/genoffice-upstream.lock.json` 当前记录：上游基线 `cbec600ace9c930b2646b6739cf6df3741bb9d6a`，第一条已审查补丁提交 `73ba918083b5e2bedff7633925c3d7f625e04449`，路径仅为 `apps/pdf/src/main/atomic-write.ts` 与 `apps/pdf/tests/page-operation-atomic-write.test.ts`。
- 当前嵌套 checkout 的 HEAD 为 `355e667353ad90da7d0b3c6823fad0f525b729c3`，它在 `73ba9180` 之后还有 **12 个 Mcode integration commits**；仓库内已有 `patches/genoffice/0001-...patch` 至 `0012-...patch`。当前 checkout 干净。
- 当前 `verify-genoffice-upstream.cjs` 的 lineage schema 只表达一条 `approvedPatch`，因此无法验证完整的 12-patch series。这里不能把“HEAD 不等于第一条 patch”直接解释成应回退上游，也不能只把 `revision` 替换成 `355e...`。
- T76 在当前 GenOffice notice 的 570 个版本化 section 中发现 18 项只有 SPDX 声明、没有完整 license text：`@electron-internal/extract-zip@1.0.5`、`@napi-rs/canvas-win32-x64-msvc@1.0.3`、`@nodable/entities@3.0.0`、`@univerjs/protocol@0.25.1`、`emoji-regex@8.0.0`、`fastdom@1.0.12`、`franc-min@6.2.0`、`hash.js@1.1.7`、`is-potential-custom-element-name@1.0.1`、`isarray@1.0.0`、`lazy-val@1.0.5`、`ot-json1@1.0.2`、`ot-text-unicode@4.0.0`、`punycode@2.3.1`、`react-remove-scroll-bar@2.3.8`、`saxes@6.0.0`、`strictdom@1.0.1`、`unicount@1.1.0`。

## 执行内容

1. 完整阅读 `audit-ledgers/README.md`、`tasks/README.md`、`tasks/T76-vendor-release-resource-integrity.md`、当前 lock / verifier、`patches/genoffice` 全部 12 个补丁的 metadata 与内容，以及 T76 的 Smoke。不得改写原 T76 回写。
2. 扩展 lock/verifier schema，使它显式记录并验证：
   - 原始上游基线 `cbec600ace9c930b2646b6739cf6df3741bb9d6a`；
   - 第一条已审查补丁 `73ba918083b5e2bedff7633925c3d7f625e04449` 及其准确 changed-path manifest；
   - `patches/genoffice/0001..0012` 的有序、精确 patch identity / SHA-256 / expected commit lineage；
   - 最终预期 patched HEAD `355e667353ad90da7d0b3c6823fad0f525b729c3`，及嵌套 checkout 的 clean tracked/untracked 状态。
   必须在临时副本里从第一条已审查补丁重放 12 个 patch，确认最终树与当前 HEAD tree 完全一致；不碰真实 `genoffice` checkout。任何额外 commit、patch 缺失/重排/篡改、dirty 文件均应拒绝。
3. 为上述 18 个精确 package@version 收集来自准确上游源码/发行包的完整许可证文本。新增可审查的许可证材料与来源 manifest，逐项记录包名、版本、SPDX 表达式、权威来源 URL/版本、文件 SHA-256。不要从 README、SPDX 标签或网上相似版本推定全文；不得写占位符。优先在 Mcode staging 侧补齐最终 bundle，不要修改嵌套 vendor checkout。
4. 调整 staging/afterPack 检查：验证完整 notice 应针对**最终随包 notice**，且 18 项均有真实全文、版本与来源摘要匹配；仅在测试夹具里模拟缺失/篡改，不改真实 vendor notice。普通开发包仍可保持 opt-out，严格发行 bundle 必须 fail-closed。
5. 新增独立 `t87-genoffice-provenance-license-smoke`，至少覆盖：正确基线+12 补丁通过；额外提交/缺失或改序 patch 拒绝；任一许可证文件删除、篡改、错误版本映射均变红；还原后字节/hash 一致。
6. 运行新增 Smoke、`node apps/desktop/scripts/genoffice-editors-release-smoke/main.cjs`、`node apps/desktop/scripts/t76-vendor-release-integrity-smoke/main.cjs`、相关 `node --check` 和 `pnpm --filter @mcode/desktop typecheck` / `pnpm --filter @mcode/contracts typecheck`。若现有 T76 smoke 因其只认原始上游 notice 而失败，解释共享断言语义，不削弱完整性判据。
7. 不运行真实 installer，不宣称 Win/macOS/Linux U1 已通过。若任何一项许可无法追溯到准确版本，保持发行阻断并列出确切包与所缺证据。

## 验收判据

1. 上游基线、第一条批准补丁、12 个 Mcode patch 文件与最终 HEAD 的 lineage 可重现；不是通过放宽 SHA 检查达成。
2. 完整 notice 中 18/18 项均有来源可追溯的全文，严格 bundle gate 通过；缺失、错版或篡改负例必红。
3. patch lineage 的缺失、重排、改动或额外 commit 负例必红；正确栈在临时副本重放后 tree hash 与当前 clean checkout 一致。
4. 新 Smoke、GenOffice release smoke、T76 资源 Smoke、双包 TypeScript 检查通过；真实 installer / U1 保持未验。
5. 只提交本卡可写文件，结果回写包含提交 SHA、每项测试计数/日志、patch 重放 tree hash、变异/字节还原证据、许可证来源和剩余风险。

## 不做

不修 Node-RED 许可证、不改 `release-readiness-smoke`、不触碰 T49/T73/T83/T84 业务文件、不改 `genoffice/**` 当前 checkout、不运行联网 npm install 或完整 installer。

## 结果回写区

<!-- 只追加：提交 SHA、旧红→新绿、命令/输出、patch stack tree hash、license sources/hashes、变异/还原与 remaining。 -->

## T87 结果回写（2026-10-22）

### 提交与上游 lineage
- 实现提交 SHA：`fe6ee970eae57e64e0438994e1ac790795b735c0`。
- lock schema 升为 v2，固定上游基线 `cbec600ace9c930b2646b6739cf6df3741bb9d6a`、首条审查补丁 `73ba918083b5e2bedff7633925c3d7f625e04449`、12 个 patch 的顺序/提交身份/父提交/SHA-256，以及最终 HEAD `355e667353ad90da7d0b3c6823fad0f525b729c3` 和 tree `2b6c91f23922a8c5a915d6e351dfbf19db6de082`。
- 新 Smoke 从 `73ba9180` 临时 checkout 重放 12 个 patch；12 个中间 tree 均逐一匹配对应上游提交，最终 tree 与当前干净 checkout 完全一致：`2b6c91f23922a8c5a915d6e351dfbf19db6de082`。真实 `genoffice/**` 和原始 `THIRD-PARTY-NOTICES.txt` 未修改。

### 测试结果
- `node apps/desktop/scripts/t87-genoffice-provenance-license-smoke/main.cjs`：**70/70 PASS**。覆盖缺失/重排/篡改 patch、额外提交、tracked/untracked dirty、8 份可用许可证逐份删除/篡改及字节/hash 还原、错误版本映射、strict staging 与 afterPack fail-closed。
- `node apps/desktop/scripts/genoffice-editors-release-smoke/main.cjs`：**25/25 PASS**。
- `node apps/desktop/scripts/t76-vendor-release-integrity-smoke/main.cjs`：**24/24 PASS**。
- 对 `verify-genoffice-upstream.cjs`、`stage-genoffice-resources.cjs`、`verify-genoffice-editors-after-pack.cjs`、T87 Smoke 执行 `node --check`：全部 PASS。
- `pnpm --filter @mcode/desktop typecheck`：PASS；`pnpm --filter @mcode/contracts typecheck`：PASS。
- `MCODE_INCLUDE_GENOFFICE_BUNDLE=1 node apps/desktop/build/verify-genoffice-upstream.cjs`：PASS。
- 严格 staging 命令以 exit 1 拒绝发行（预期）：它明确列出下述 10 项缺失全文；未运行真实 installer，也未宣称 Win/macOS/Linux U1 通过。

### 许可证来源与 SHA-256
来源清单：`apps/desktop/build/vendor-licenses/genoffice/manifest.json`，SHA-256 `bbb9f634477e715bbf1f7a47eecc89e26560aa951c6f283f8b7d1bb6f018f165`。18 个精确 package@version 的 npm tarball 均从官方 registry 下载并通过各自 `sha512-` SRI 校验；清单固定包名、版本、SPDX、上游 revision/URL、tarball URL/SRI、全文 SHA-256 或明确的缺失证据。

已追溯并收录 8 份完整上游许可证文本：
- `@napi-rs/canvas-win32-x64-msvc@1.0.3`：上游 commit `2aa648fb4ed83fbe87af77922ecf89153184f8b5` 的 `LICENSE`；SHA-256 `8802fecf9da4367bc23bcf20b21cc143785fc6c92b152f3fa7fbe6ce08d344d6`。
- `@nodable/entities@3.0.0`：上游 commit `d2070d76a8ba07e6c7fa142caeb51ffd756e47eb` 的 `LICENSE`；SHA-256 `750cb3fb6362804957ef52caaf9b5c824015be44d494637330d7cd8834d31d40`。
- `@univerjs/protocol@0.25.1`：上游 tag `v0.25.1` / commit `c9c8607471013f110b7a401d79bfb248e59faa1c` 的 Apache-2.0 `LICENSE`；SHA-256 `a6cba85bc92e0cff7a450b1d873c0eaa2e9fc96bf472df0247a26bec77bf3ff9`。
- `emoji-regex@8.0.0`：上游 commit `a9f2e514523d4c0931974aff5059052da10c52c5` 的 `LICENSE-MIT.txt`；SHA-256 `483acb265f182907d1caf6cff9c16c96f31325ed23792832cc5d8b12d5f88c8a`。
- `franc-min@6.2.0`：上游 commit `3f9f0b51a96c5df32a407dad865a3011ac0fa2d1` 的 `license`；SHA-256 `f5e0c5c44706ddda7ac2f9096f848222f1e0e90f88643955041c2735be84592b`。
- `is-potential-custom-element-name@1.0.1`：上游 commit `e24778654416e14cfcf259253b916e32e53aaa75` 的 `LICENSE-MIT.txt`；SHA-256 `483acb265f182907d1caf6cff9c16c96f31325ed23792832cc5d8b12d5f88c8a`。
- `punycode@2.3.1`：上游 commit `9e1b2cda98d215d3a73fcbfe93c62e021f4ba768` 的 `LICENSE-MIT.txt`；SHA-256 `483acb265f182907d1caf6cff9c16c96f31325ed23792832cc5d8b12d5f88c8a`。
- `saxes@6.0.0`：上游 commit `211fa0ebec9b628affc09219199639887174bfc3` 的 `LICENSE`；SHA-256 `0fac2374380621b22e6b50451057721a9c52935b02d16d106a9f04897f061d0e`。

仍缺准确版本完整全文的 10 项：`@electron-internal/extract-zip@1.0.5`、`fastdom@1.0.12`、`hash.js@1.1.7`、`isarray@1.0.0`、`lazy-val@1.0.5`、`ot-json1@1.0.2`、`ot-text-unicode@4.0.0`、`react-remove-scroll-bar@2.3.8`、`strictdom@1.0.1`、`unicount@1.1.0`。这些版本的完整 npm tarball 均无可用的完整法务文本；其中 `fastdom`、`ot-json1`、`ot-text-unicode`、`react-remove-scroll-bar` 的发布 `gitHead` 目前无法从上游已公告 refs 取回，其余对应源码树没有跟踪完整 license 文件。所缺证据是这些准确发布版本/commit 的上游全文或可验证的源归档；没有从 SPDX 标签、README 或相似版本推定，也没有写 placeholder。

### 剩余风险 / 验收判定
- 验收 1、3、4：通过；patch lineage 可复现，所有负例拒绝，T87/T76/GenOffice smoke 与双包 typecheck 通过。
- **验收 2 未达成**：只有 8/18 项具备可追溯完整全文，strict bundle gate 按要求 fail-closed；18/18 notice 和严格发行包尚未完成。
- 原始上游 notice 保持原样；普通开发包仍可 opt-out。待补齐上述 10 项准确来源全文后，才能生成并验证最终 18/18 notice。
