# T11｜GenOffice 许可证材料集成与发行门禁复验

- Status: ready-for-agent
- Category: bug
- Priority: P0 release blocker
- Depends on: T9 source/provenance policy decision
- Exclusive writable files: GenOffice-specific notices/manifest and dedicated tests only; do not overlap T10 or alter unknown-license policy.
## Required Skills
  - `research`: ensure exact-version source material is supported by primary evidence.
  - `mcode-smoke`: validate notice generation and release gate positive/negative cases.
- Read before work: `CLAUDE.md`, `audit-ledgers/README.md`, release ledger, archived T76/T87/T89/T90.
- Acceptance: include only evidence-backed original license material; all unresolved packages continue to block release. Re-run relevant release-readiness checks and prove a known bad/unknown package remains blocked.
- Execute: do not start until T9 is accepted; stop if required source files overlap another active task.
- Result writeback: evidence-to-notice mapping, tests, unresolved list, commit SHA.

## 结果回写（2026-10-23）

### 起点与边界

开工 HEAD `3e259ee40cd0697254dcfedf56228a76acf58011`。工作树原有 9 项他人未提交修改（`.aoci/baseline.json`、`.gitignore`、`document-view-host-smoke/` 三项、`maint-m35-smoke/pickers-prelude.ts`、`orchestration-ipc-smoke/run.sh`、`release-readiness-smoke/check-reviewed.cjs`、`src/main/ipc/settingsTransfer.ts`）全部保留，未 reset/stash/clean。本卡只写：GenOffice manifest + `licenses/` 新材料、`stage-genoffice-resources.cjs` 许可校验段、T87 计数断言与其缺失的 `run.sh`、新 `t11-genoffice-license-carrier-smoke/`、本卡。

### 第一步：策略裁决——**采纳**「有条件 README 载体」

**裁决：采纳 T9 的有条件 README 载体政策。** 论证：

1. **许可法的条件落在内容而非文件名。** MIT/ISC 的条件是「保留版权声明与许可声明」；没有任何条文要求许可全文必须位于名为 `LICENSE` 的文件。这些包的发布者以 README 作为唯一许可载体是**发布事实**（T9 已核全历史：六包从首发至今从未有独立 LICENSE 文件），不是证据缺失。
2. **载体变了，门槛没有降。** 新政策（`GENOFFICE_LICENSE_SOURCE_KINDS`）要求同时满足：来源 URL **必须等于**该包的精确 npm tarball URL；README 路径必须是 `package/README.md`；记录标题行、整份 README 的 SHA-256、许可段字节区间（`start`/`end`/`length`，`end = start + length` 且 `end ≤ README 字节数`）、区间 SHA-256，且区间哈希必须等于 `licenseTextSha256`；必须附 README 字节相等证明。**任何一项缺失即拒绝**。这比旧规则多出「整份 README 哈希 + 字节区间」两层，旧规则只有单文件哈希。
3. **完整性判据是新的硬门槛，且已用真实反例验证。** 每个 SPDX 文本必须含版权声明、授权、**保留条款**、免责四点（Apache-2.0 用 title/version/terms/grant/liability/end 六点）。T9 的 `ot-text-unicode` 正是「有授权、有免责、缺保留条款」的样本——它在本政策下**依然被拒**（下方负控实测）。
4. **不采纳的代价是永久阻塞。** fastdom 与 ot-json1 的发布 gitHead 在上游根本不存在（git/API/codeload 三路 404），坚持「必须 raw LICENSE 文件」等于这两项永远无法靠取证解除，与卡面「只整合有精确版本证据的材料」的目标相悖。

**弱点如实记录**：README 抽取边界是新的信任面（T9 与 T89/T90 的边界约定就差一个前导换行）。本卡把边界固定为**「标题行之后的首个非空白字节起至 EOF」**并写进 schema 显式字段，六份材料全部按该约定从 tarball 重新截取（不是复用 T9 的 `.tmp` 提取物），区间长度与 README 字节数逐项相等（7525/1515/1890/7457/4146/2022）。fastdom 与 ot-json1 的 gitHead 不可取，只能附「上游公开 commit README 与 tarball 逐字节相同」的**较弱证明链**，该链被单独建模为 `kind: "public-commit-readme-equal-weaker-chain"`，强制记录 commit、`publishedGitHeadRetrievable: false` 与审查签字，缺一即拒绝。

### 第二步：整合结果（14 verified / 4 blocked，`releaseEligible` 仍为 false）

六个包全部按新载体整合，材料从精确 tarball 重新取证（SRI 6/6 匹配）：

| 包 | 区间（字节） | 材料 SHA-256 | README 证明链 |
|---|---|---|---|
| fastdom 1.0.12 | 6431..7525 | `50c0de64…e08c` | 弱链：公开 commit `1e5915b0e720…` README 逐字节相同（gitHead 不可取，已签字） |
| hash.js 1.1.7 | 410..1515 | `7261b3ab…b5` | 精确 tag commit `fcd35edc…` README 逐字节相同 |
| isarray 1.0.0 | 794..1890 | `a1bd5dea…68` | 精确 tag commit `2a23a281…` README 逐字节相同 |
| ot-json1 1.0.2 | 6696..7457 | `ca44556c…63` | 弱链：公开 commit `888731d4…` README 逐字节相同（gitHead 不可取，已签字） |
| strictdom 1.0.1 | 3052..4146 | `2c0cd14e…73` | 精确 tag commit `a3bbf190…` README 逐字节相同 |
| unicount 1.1.0 | 1295..2022 | `4a80cd8c…f2` | 精确 tag commit `79d4e853…` README 逐字节相同 |

- 六份材料与已入库的 T9 证据（`docs/research/genoffice-license/evidence/*.txt`）去标题行后逐字相等（空白规范化比较，6/6）。
- manifest 升版为 `mcode.genoffice.third-party-license-sources.v2`；`policy` 字段重写为双载体 + 完整性要件 + 弱链签字规则；`resolvedCount=14`、`blockedCount=4`、`releaseEligible=false`。
- 门禁的 `GENOFFICE_LICENSE_MANIFEST_SHA256` 从 `bbb9f634…` 更新为 `ab2335254880cc590e1f73fff20f19b26b6da3bbbee9f3d3460ca5b6858a21ec`（清单必须逐字节复核过才换 pin）。

### 四个 UNRESOLVED 的处理——**全部保持阻塞**

`@electron-internal/extract-zip@1.0.5`、`lazy-val@1.0.5`、`ot-text-unicode@4.0.0`、`react-remove-scroll-bar@2.3.8` 保持 `status: "blocked"`，`licenseSourceUrl/licenseFile/licenseTextSha256` 三项强制为 `null`，`missingEvidence` 改写为 T9 的版本特定结论。**没有任何借用文本**：`licenses/` 下不存在这四包的任何材料文件（套件有专门断言）。其中两处「不得借用」陷阱写进了 `missingEvidence` 文本并由套件断言：
- extract-zip：上游 2026-09-10 才加 LICENSE，且是 **MIT**——与 1.0.5 的 BSD-2-Clause 是不同许可，`MUST NOT be borrowed`；
- react-remove-scroll-bar：上游 2025-05-21 新增 LICENSE 含 2025 年版权、晚于 2.3.8 发布，`MUST NOT be backfilled`。

### 第三步：负控证据

- **缺保留条款 → 拒绝**：以 ot-text-unicode 的真实形态构造（版权+授权+免责、无「The above copyright notice … shall be included」），把它的哈希、区间、README 字节数全部改成自洽值后，门禁仍以 `missing MIT element(s) retention notice` 拒绝（T11 套件 `a self-consistent but retentionless MIT text is rejected on license elements`）。真实 ot-text-unicode 也继续阻塞。
- **撤掉某包材料 → 回到 blocked**：删掉 strictdom 的材料文件，校验立刻 `ENOENT/缺失` 变红；把 strictdom 按流程降级为 blocked（清空三项记录、写 `missingEvidence`、计数改 13/5）后，严格发行门禁重新阻塞并点名 `strictdom@1.0.1`（T11 套件两条对应断言）。
- **载体记录畸形 → 拒绝**：URL 指向网页而非精确 tarball、字节区间不自洽、区间哈希与文本哈希不一致、缺 README 字节相等证明、弱链缺签字、未知 `licenseSourceKind`、独立文件载体用非 raw URL——7 类畸形逐条被拒并逐条还原。
- **notice 永不残缺发布**：真实 14/18 manifest 下 `buildCompleteThirdPartyNotice` 与 `assertThirdPartyNoticeTextComplete` 均拒绝；用临时夹具把 18 项合成完整后，生成的 notice 每节含全文 + `Source:` + `License SHA-256:`，且 `assertThirdPartyNoticeMatchesManifest` 通过（机制证明，夹具文本永不入发行物）。

### 第四步：变异验证

1. **改错 `licenseTextSha256`**：把真实 manifest 中 strictdom 的 `licenseTextSha256` 首字符翻转（`2c0c…`→`0c0c…`），以变异后的清单哈希为期望 pin 调校验 → 红：`range hash differs from the license text hash … package index 17: strictdom`。用备份 `cmp` 还原 → 逐字节相等，清单哈希回到 pin `ab233525…`。
2. **拆掉要素完整性检查**（把 `missingLicenseElements` 结果强制为空）→ T11 套件在缺保留条款用例上 `Missing expected exception` 变红；`cmp` 还原。
3. **把 notice 分段解析改回旧切分**（标题永不匹配）→ T11 套件在 notice 生成用例上红 `package sections do not match`；`cmp` 还原。
4. **同尺寸篡改材料**（翻转 fastdom 材料倒数第二个字节）→ `SHA-256 mismatch: fastdom`；还原后哈希与 manifest 记录相等。

### 附带修复：notice 生成器的真实缺陷

T87 原本的分段切分 `split(/(?=^-{72}\r?$)/m)` 把标题与正文分到不同 chunk，全格式正则在任何真实 notice 上都匹配不到（实测 1171 chunk 0 命中），此前一直没暴露是因为清单不全时它总在更早的 `unresolved` 处抛出。本卡把它改为单次 `matchAll` 的 `noticeSections()`（CRLF 容错，LF/CRLF 各 585 节均解析），并按偏移拼接替换，删除了重复的字符串 split。`assertThirdPartyNoticeMatchesManifest` 与 `buildCompleteThirdPartyNotice` 共用该解析器。

### 依赖许可交叉核对（`dependency-license-audit`，只读）

按 ASF 策略对 18 个精确 package@version 交叉核对：已安装 `package.json` 的许可声明与 manifest 的 SPDX **18/18 一致，零冲突**；全部为 Category A（MIT/ISC/Apache-2.0/BSD-2-Clause），无 Category B、无 Category X、无未知许可。**与 manifest 无冲突，未因审计改动 manifest。**（`license-checker` 未安装，且本卡只读、不装包；以等价的已安装元数据直读完成核对。）

### 测试结果

- `node apps/desktop/scripts/t11-genoffice-license-carrier-smoke/main.cjs`：**47/47 PASS**（新套件）。
- `node apps/desktop/scripts/t87-genoffice-provenance-license-smoke/main.cjs`：**95/95 PASS**（计数断言由 8/10 更新为 14/4；补 `run.sh` 后已可被 `run-smokes.mjs` 发现）。
- `node apps/desktop/scripts/t76-vendor-release-integrity-smoke/main.cjs`：**24/24 PASS**。
- `node apps/desktop/scripts/genoffice-editors-release-smoke/main.cjs`：**29/29 PASS**。
- `genoffice-vendor-freshness-smoke`：PASS。经 `run-smokes.mjs` 五套联合：**5/5 suites PASS**。
- 双包 typecheck：`apps/desktop` exit 0，`packages/contracts` exit 0。
- `node --check`：`stage-genoffice-resources.cjs`、T87 与 T11 `main.cjs` 全 PASS。

**既有失败（非本卡引入，均在干净 HEAD 上同样失败，未修）**：
- `release-readiness-smoke/check-genoffice.cjs` 在 afterPack 夹具上抛 `native CLI/dependency/PDFium integrity manifest is missing or invalid`（HEAD 复跑同样 exit 1）。
- `genoffice-source-smoke` 在 fixture lock 上抛 `GenOffice source lock differs from …`（HEAD 复跑同样 exit 1）。
- `run-smokes.mjs --all` 目前在 `genoffice-file-routing-smoke/run.sh`（T30 交付，只有 `run.mjs`）处拒绝启动；T87 的同款缺口本卡已补，T30 的未动（不在本卡文件边界）。

### 仍阻塞的项与解除条件

| 包 | 状态 | 解除条件 |
|---|---|---|
| @electron-internal/extract-zip 1.0.5 | blocked | 权利方出具覆盖 1.0.5 / `b83e459` 的完整 BSD-2-Clause 全文；**不得**用 2026-09-10 后的 MIT LICENSE；或替换到 v1.0.6+（产品变更，另卡） |
| lazy-val 1.0.5 | blocked | 维护者出具覆盖 1.0.5 / `b69ad411` 的完整 MIT 全文（上游历史从无 LICENSE 文件） |
| ot-text-unicode 4.0.0 | blocked | 权利方对 4.0.0 作单一许可声明（ISC 或 MIT）并提供含保留条款的完整文本 |
| react-remove-scroll-bar 2.3.8 | blocked | 权利方出具绑定 2.3.8 的 MIT 全文及版权行；**不得**回填 2025-05-21 的 LICENSE |

`releaseEligible=false` 不变；严格发行门禁继续 fail-closed。**未宣称发行门禁通过。**

### 提交

- 提交 SHA：见本卡提交后的 `git log`（本节随提交一起入库，SHA 由提交本身确定；以 `git log --grep T11` 复核）。
- 只暂存本卡可写文件；他人 9 项 dirty 保持原样未入提交。

### 留痕（git-ignored，未入库）

`.tmp/t11-license-work/`：`scripts/{extract2,verify-commits,apply-manifest,check-elements,mutate-*,crlf-check}.cjs`、`tarballs/`（6 个精确 tgz）、`six-evidence.json`、`commit-compare.json`、`materials/`。

### 提交后 SHA 落定

- 实现提交 SHA：**`e0793181`**（13 文件，994+/86-）。上节「提交」处的占位以本行为准。
- 提交后复跑（提交状态而非工作区）：`t11-genoffice-license-carrier-smoke`、`t87-genoffice-provenance-license-smoke`、`t76-vendor-release-integrity-smoke`、`genoffice-editors-release-smoke`、`genoffice-vendor-freshness-smoke` 五套经 `run-smokes.mjs` **5/5 PASS**；双包 `tsc --noEmit` exit 0。
