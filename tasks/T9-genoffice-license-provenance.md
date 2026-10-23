# T9｜GenOffice 未决第三方许可证来源证据

- Status: done（2026-10-23 验收通过：14 验证 / 4 阻塞，提交 d28de300 + c0b092e0）
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
- 提交 SHA：`d28de3004fe6038aa90a05e2975e5cd37de6afdf`（报告 + 本卡回写）
- 复核留痕（git-ignored，未入库）：`.tmp/t9-license-work/{scripts,reports,evidence-extracted}`

## 独立复核（2026-10-23，F 会话）

**目的**：不信回写数字，从 manifest 与磁盘文件独立重算一遍，确认 14/4 的结论成立。

### 复核结论：**原结论全部成立**，未发现需要推翻项

| 复核项 | 方法 | 结果 |
|---|---|---|
| 计数一致性 | 遍历 `manifest.items[]` 的 `status` 实算，与 `resolvedCount`/`blockedCount`/`expectedPackageCount` 对比 | **一致**：18 项 = 14 verified + 4 blocked |
| 14 份许可证文件存在 | `fs.existsSync` 逐个检查 `licenses/` 下文件 | **14/14 存在** |
| 14 份文件 SHA-256 | 重算 sha256 与 `licenseTextSha256` 对比 | **14/14 匹配** |
| 四要件完整性 | 版权 / grant / 保留条款 / 免责声明逐项正则 + 人工核对全文 | **14/14 齐全** |
| README 段载体（6 条） | 重算文件 sha256 | **6/6 匹配** |
| SRI 字段 | 18 条 `npmTarballIntegrity` 是否 `sha512-` 前缀 | **18/18 齐全** |
| 上游 URL 可追溯 | 13 条 `exact-upstream-source-file` 是否 pinned `raw.githubusercontent.com/<owner>/<repo>/<40位SHA>/` | **13/13 合格** |
| Apache-2.0 特例 | `@univerjs/protocol` 的 URL 用 tag 而非 SHA | **合格：`v0.25.1` 是 annotated tag，`^{}` 解引用 = `c9c8607471…`，与 manifest `licenseSourceVersion` 记录一致** |

### 两次「我的工具错了」的记录（避免误报缺陷）

按总控「先确认不是我没找到或工具用错」的要求，下面两次都是**我的检查器有问题，不是证据有问题**：

1. **路径拼错**：首次校验 14 条全部报「文件不存在」，实际文件在 `licenses/` 子目录，我按 `genoffice/<name>.txt` 找。改路径后 14/14 通过。
2. **正则漏了标准变体**：首次四要件检查 8 条报「缺保留条款」。实际 MIT 标准句是 `The above copyright notice ... shall be included`、ISC 是 `notice ... appear in all copies`，我的正则只认 `must be included`。修正后 13/14 通过；剩下的 `@univerjs/protocol` 是 Apache-2.0，用 MIT/ISC 正则本就不适用，人工核对 §4 保留义务、§7 免责、§8 责任限制、`END OF TERMS AND CONDITIONS` 全部在。

3. **`git ls-remote` 只看第一行会误判**：直接 `refs/tags/v0.25.1` 得到 `d70f3477`，与记录 `c9c86074` 不符，几乎要报缺陷；加上 `refs/tags/v0.25.1^{}` 才看到真 commit 是 `c9c86074` —— annotated tag 的正常行为。

### 4 条 blocked 的阻塞理由，独立复验通过

| 包 | 复验方法 | 结论 |
|---|---|---|
| `lazy-val@1.0.5` | GitHub tree API 查 `b69ad411` 全树 | **14 个文件、0 个 LICENSE/COPYING/NOTICE**，阻塞成立 |
| `react-remove-scroll-bar@2.3.8` | tree API 查 `b3b1287` 全树；再查 master 根目录 | 该 commit **0 个许可证文件**；master **现在有 LICENSE** —— 正是「2.3.8 之后才补、不得回填」的情形，阻塞成立 |
| `extract-zip@1.0.5` | 下载 1.0.5 tarball 查内容 | **0 个许可证文件**，README 许可段确为 `## License\n\nBSD-2-Clause`（14 字节），`package.json` 声明 `BSD-2-Clause`，阻塞成立 |
| `ot-text-unicode@4.0.0` | 复核 manifest 记录的冲突描述 | ISC 标识 vs 缺保留条款的 MIT 正文，两者都不能单独构成完整授权，阻塞成立 |

### 一条需要总控裁决的发现（T9 已记录，我独立确认）

`@electron-internal/extract-zip@1.0.6` 发布于 **2026-10-22 05:22Z**（T9 取证是 2026-10-23 02:12），**带完整 MIT LICENSE**：

- tarball `package/LICENSE` 全文为标准 MIT（`Copyright (c) Contributors to the Electron project`），四要件齐全，sha256 `edab8abb78d9c5b36944c3e00aebf6a90eb32378993f49ac8a3904007029c629`
- 上游 `v1.0.6` tag 树含 `LICENSE`
- 发布说明只有一项：`bump zip to 9.0.3 for RUSTSEC-2026-0367/0368/0369`

**T9 报告第 98 行已写明这条路径**：「备选：替换依赖版本到 v1.0.6+（MIT，且有 LICENSE 文件）并重新过 T87/T76 门禁——但这属于产品变更，不在本卡」。**我独立复核确认这个判断正确**，不是遗漏。

**这条是本卡 4 项阻塞中唯一存在仓库内解除路径的。** 但它不是取证问题，是**依赖升级决策**：`pnpm-lock.yaml` 里 `electron@44.4.5` 与 `electron-winstaller@5.4.0` 都精确锁 `@electron-internal/extract-zip@1.0.5`（不是范围），要改走 `pnpm.overrides` 或升级上游。**需另开卡，不在 T9 范围。**

其余 3 条（`lazy-val`、`ot-text-unicode`、`react-remove-scroll-bar`）的最新版就是当前锁定版，**无版本升级路径**，只能由权利方出具版本特定全文。

### 复核边界

- 只读：未修改 manifest、任何许可证文件、NOTICE、`genoffice/` 源码、gate 脚本。
- 未重跑 T87/T76 门禁（本次只做证据复核，未改任何受门禁约束的文件）。
- `releaseEligible=false` 不变，未宣称发行门禁通过。
