# T9｜GenOffice 未决第三方许可证来源证据

- Status: ready-for-agent
- Category: bug
- Priority: P0 release blocker
- Depends on: none; T11 integration depends on this evidence/policy result
- Exclusive writable files: research report and exact source/notice evidence paths only; do not modify vendor manifests, notices, packages, or release gates.
## Required Skills
  - `research`: gather high-trust primary-source evidence for exact package versions.
  - `code-review`: validate evidence is version-specific and conclusions do not overreach.
- Read before work: `CLAUDE.md`, `audit-ledgers/README.md`, current release ledger, archived T76/T87/T89/T90.
- Acceptance: resolve each currently unresolved package/version with source URL, exact version, license identifier and original text/provenance. If evidence cannot be proven, preserve explicit unresolved blocker; do not infer license from a newer release.
- Execute: first enumerate the exact unresolved items from current ledger; don't re-research already verified entries.
- Result writeback: evidence table, unresolved list, no release-gate weakening, report commit SHA.

## 结果回写（2026-10-23）

### 起点核对

开工 HEAD `2c93f70ef863084426790c46c11e916644b43904`，保留工作树既有 7 项他人 dirty（未 reset/clean）。从 `apps/desktop/build/vendor-licenses/genoffice/manifest.json` 与 `audit-ledgers/` 交叉核对：`expectedPackageCount=18`、`resolvedCount=8`、`blockedCount=10`、`releaseEligible=false`。8 项 verified 未重研（本地 8 份 license 文件 SHA-256 与 manifest 8/8 匹配）。**未决总数 10**，不是 T89/T90 合计的 4 项。

### 证据表（10 个 blocked，详见报告）

| 包名 | 精确版本 | 结论 | 来源 URL | 证据要点 |
|---|---|---|---|---|
| @electron-internal/extract-zip | 1.0.5 | UNRESOLVED | registry.npmjs.org/@electron-internal/extract-zip/-/extract-zip-1.0.5.tgz | SRI 匹配；tgz 15 条目 0 法律文件；README `## License` 仅 14 字节 `BSD-2-Clause`；tag v1.0.5→`b83e459` 树 27 文件 0 法律文件；上游 LICENSE 首现于 2026-09-10 且为 MIT（晚于 1.0.5 的 2026-07-29、许可不同，禁用） |
| fastdom | 1.0.12 | VERIFIED（README 内嵌全文） | registry.npmjs.org/fastdom/-/fastdom-1.0.12.tgz | SRI 匹配；13 条目 0 法律文件；README 段 6430/1095/`efd1a97a…`：`(The MIT License)` + Wilson Page 2016 版权 + 完整 MIT；npm gitHead `a7b9044` 上游不存在（git/API/codeload 三路 404），但上游 commit `1e5915b0` 与 master 的 README 与 tarball 逐字节相同 |
| hash.js | 1.1.7 | VERIFIED（README；精确 commit 一致） | registry.npmjs.org/hash.js/-/hash.js-1.1.7.tgz | SRI 匹配；19 条目 0 法律文件；README 段 409/1106/`a263df31…`：Fedor Indutny 2014 + 完整 MIT；tag `v1.1.7^{}`→`fcd35ed`（=gitHead），README blob 与 tarball 字节一致 |
| isarray | 1.0.0 | VERIFIED（README；精确 commit 一致） | registry.npmjs.org/isarray/-/isarray-1.0.0.tgz | SRI 匹配；8 条目 0 法律文件；README 段 793/1097/`41199fc5…`：Julian Gruber 2013 + 完整 MIT（HTML 实体为原始字节）；tag `v1.0.0^{}`→`2a23a28`，README 字节一致 |
| lazy-val | 1.0.5 | UNRESOLVED | registry.npmjs.org/lazy-val/-/lazy-val-1.0.5.tgz | SRI 匹配；5 条目 0 法律文件；readme 仅 API 说明、无许可段；gitHead `b69ad411` 可取但树 12 文件 0 法律文件；上游全历史从未有 LICENSE/COPYING/NOTICE |
| ot-json1 | 1.0.2 | VERIFIED（README；段落在全历史稳定） | registry.npmjs.org/ot-json1/-/ot-json1-1.0.2.tgz | SRI 匹配；36 条目 0 法律文件；README 段 6695/762/`a8abfe1c…`：Joseph Gentle 2013-2018 + 完整 ISC；gitHead `4ef85ce` 上游不存在，但上游 `888731d4`（master 祖先）README 与 tarball 逐字节相同，且许可段在全部历史 README 中恒定 |
| ot-text-unicode | 4.0.0 | CONFLICT | registry.npmjs.org/ot-text-unicode/-/ot-text-unicode-4.0.0.tgz | SRI 匹配；11 条目 0 法律文件；npm/tag `v4.0.0`→`bdcfc545` 的 package.json 均为 `ISC`，而 README `# License`（9126/1028/`399b53f8…`）声明 MIT 且**缺保留条款**（上游全历史均缺）——ISC 标识与缺条款 MIT 正文都不能单独构成完整一致授权 |
| react-remove-scroll-bar | 2.3.8 | UNRESOLVED | registry.npmjs.org/react-remove-scroll-bar/-/react-remove-scroll-bar-2.3.8.tgz | SRI 匹配；27 条目 0 法律文件；README `# License` 仅 4 字节 `MIT`；gitHead `b3b1287` 上游不存在；上游 child repo **不存在版本号 2.3.8 的 commit**；2025-05-21 新增的 LICENSE（含 2025 年版权）晚于 2.3.8 发布，禁用 |
| strictdom | 1.0.1 | VERIFIED（README；精确 commit 一致） | registry.npmjs.org/strictdom/-/strictdom-1.0.1.tgz | SRI 匹配；3 条目 0 法律文件；README 段 3051/1095/`797db126…`：Wilson Page 2013 + 完整 MIT；tag `v1.0.1^{}`→`a3bbf19`，README 字节一致 |
| unicount | 1.1.0 | VERIFIED（README；精确 commit 一致） | registry.npmjs.org/unicount/-/unicount-1.1.0.tgz | SRI 匹配；6 条目 0 法律文件；README 段 1294/728/`a2f2f887…`：Joseph Gentle 2019 + 完整 ISC；tag `v1.1.0^{}`→`79d4e85`，README 字节一致 |

所有 10 个 tarball 的 `sha512-` SRI 与 manifest 逐项一致；`package/package.json` 版本 10/10 一致；**10/10 无任何独立许可证文件**。

### 载体策略裁决（建议，未实施）

现行 gate（`stage-genoffice-resources.cjs:181-203`）要求 `raw.githubusercontent.com` 的独立许可证文件。本次**建议有条件承认精确发布包内嵌的完整许可正文**，条件：SRI 精确版来源、含全部要件（版权/grant/保留/免责）、固定字节边界约定并写入 schema、精确 commit 可取时附字节对照、不可取时显式记录较弱证明链并由审查者签字。反对理由与风险见报告第 3 节（README 抽取边界会变、可能缺条款、tarball 与公开 commit 可能脱节、policy 属既有审核决定）。**本卡未改 manifest 或任何 gate。**

### 未决清单与解除条件

- **按现行 gate 阻塞 10 项**：extract-zip 1.0.5、lazy-val 1.0.5、ot-text-unicode 4.0.0、react-remove-scroll-bar 2.3.8 需权利方补发版本特定全文（4 项不能靠取证解除）；fastdom、hash.js、isarray、ot-json1、strictdom、unicount 六项取证已完成，解除取决于载体政策裁决。
- **按建议的有条件 README 政策：6 可解、4 仍阻塞。** `releaseEligible=false` 不变；未宣称发行门禁通过。

### 交付

- 报告：`docs/research/genoffice-license/T9-unresolved-evidence.md`
- 本卡回写：本节
- 提交 SHA：见下方（提交后总控可 `git log -1` 核对）
- 复核留痕（git-ignored，未入库）：`.tmp/t9-license-work/{scripts,reports,evidence-extracted}`
