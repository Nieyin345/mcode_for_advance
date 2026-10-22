# T9｜GenOffice 10 个 blocked 第三方许可证的版本特定证据与载体策略裁决

- 任务卡：`tasks/T9-genoffice-license-provenance.md`
- 取证日期：2026-10-23
- 取证 HEAD（开工时）：`2c93f70ef863084426790c46c11e916644b43904`（工作树保留他人 7 项 dirty，未 reset/clean）
- 只读证据来源：npm registry 精确版 tarball、GitHub 精确 commit 的 git 对象（`git fetch <sha>` 到隔离 bare 仓库）、GitHub REST API（对象级 SHA 校验）。**没有**执行 npm install/ci，没有解压 tarball 到项目目录，没有修改 manifest/notice/release gate。

## 0. 结论摘要

| 项 | 数 |
|---|---|
| manifest 登记的第三方包 | 18 |
| 已 verified（本次未重研） | 8 |
| manifest 标记 blocked | 10 |
| 本次按「精确版 tarball 内含发布者完整授权正文」判定 VERIFIED | 6（fastdom、hash.js、isarray、ot-json1、strictdom、unicount） |
| 本次判定 CONFLICT | 1（ot-text-unicode） |
| 本次判定 UNRESOLVED | 3（@electron-internal/extract-zip、lazy-val、react-remove-scroll-bar） |
| 仍阻塞发行 | **10**（现行 gate 要求独立许可文件；见第 3 节策略裁决） |

关键事实：**10 个 blocked 包中没有任何一个在精确发布版或精确上游 commit 上存在独立 LICENSE/COPYING/NOTICE 文件。** 6 个包的完整授权条文只以 README 内嵌形式存在；1 个（ot-text-unicode）README 声明 MIT 与 metadata 的 ISC 冲突且 MIT 文本缺保留条款；3 个连 README 全文都没有。

## 1. 方法与可复核性

1. 对每个精确版本从 `https://registry.npmjs.org/<pkg>/-/<pkg>-<version>.tgz` 下载 tarball，**在内存中**计算 `sha512-` Base64 并与 manifest 的 `npmTarballIntegrity` 比对：**10/10 一致**；同时解析 tar header 确认 `package/package.json` 的 `version` 与 manifest 一致：10/10 一致。
2. 枚举 tar 全部条目：**10/10 没有任何独立许可证文件**（`license|licence|copying|notice|unlicense`）。
3. 定位 README 内最后一个 `# License`/`## License`/`# LICENSE` 标题，记录标题后至 EOF 的原始字节区间与 SHA-256（T89/T90 的边界约定是「跳过标题行及其后一个空行」；本报告记录的是**包含**该空行的区间，两者相差一个前导换行，正文内容一致。仅 hash.js 的标题级别为 `#### LICENSE`）。
4. 对 7 个可取的精确 commit 执行 `git fetch <sha>` 到隔离 bare 仓库并 `git ls-tree -r`：全部**无独立法律文件**；另 3 个 gitHead（fastdom、ot-json1、react-remove-scroll-bar）上游 git 直接拒绝（`upload-pack: not our ref`），GitHub REST `git/commits` 返回 404，`codeload` archive 返回 404 —— **这些 commit 在上游仓库中不存在**。
5. 对 README 可用的包，用精确 commit 的 README blob 与 tarball README 做字节对照（去除 CRLF 差异后逐字节相等）。

复现脚本（临时目录，未入库）：`.tmp/t9-license-work/scripts/{scan-tarballs,extract-evidence,probe-github,probe-codeload,deep-dive}.cjs`；中间数据 `.tmp/t9-license-work/reports/*.json`，提取出的原始 README 与许可段 `.tmp/t9-license-work/evidence-extracted/`。这些都在 git-ignored 的 `.tmp/` 下，仅作复核留痕。

## 2. 证据表（10 个 blocked 包）

> 「README 段」列格式：`起始字节/长度/SHA-256`，均为 tarball 内 `package/README.md` 原始字节；`tgz SHA-256` 是完整 tarball 的 SHA-256，可由任何人事后重算核对。

| 包名 | 精确版本 | 结论 | 来源 URL | 证据要点 |
|---|---|---|---|---|
| @electron-internal/extract-zip | 1.0.5 | **UNRESOLVED** | `https://registry.npmjs.org/@electron-internal/extract-zip/-/extract-zip-1.0.5.tgz`；`https://github.com/electron/extract-zip/tree/v1.0.5` | tgz SHA-256 `939b4462…5370b`；15 条目、0 法律文件；README `## License` 后仅字面 `BSD-2-Clause`（14 字节，`d778bd6b…63ffe`）。tag `v1.0.5` → commit `b83e459`（与 npm gitHead 一致），该 tree 27 文件、0 法律文件；`package.json`/`Cargo.toml` 均声明 `BSD-2-Clause` 但无条文。仓库全历史仅 28 个 commit，`LICENSE` 首次出现于 **2026-09-10 `3c33b76` “chore: relicense to MIT and add LICENSE file”**，晚于 1.0.5 的 2026-07-29；现 `main` 的 LICENSE 是 **MIT**（`Copyright (c) Contributors to the Electron project`），**与 1.0.5 的 BSD-2-Clause 不同许可，禁止借用**。 |
| fastdom | 1.0.12 | **VERIFIED（README 内嵌全文）** | `https://registry.npmjs.org/fastdom/-/fastdom-1.0.12.tgz` | tgz SHA-256 `15e452be…182265`；13 条目、0 法律文件。README 段 `6430/1095/efd1a97a…47a4`：`(The MIT License)`、`Copyright (c) 2016 Wilson Page <wilsonpage@me.com>`、完整 grant + 保留声明 + 免责。npm gitHead `a7b9044…` 在上游**不存在**（git `not our ref`、API 404、codeload 404）；但上游 commit `1e5915b0`（2020-04-06）的 README 与 tarball 逐字节相同，且 master `README.md` 同样一致；`v1.0.11` 的 `## License` 段正文 hash 与 tarball 相同。即：**发布内容与上游公开 README 一致，但发布 commit 本身不可取**。 |
| hash.js | 1.1.7 | **VERIFIED（README 内嵌全文；精确 commit 可取）** | `https://registry.npmjs.org/hash.js/-/hash.js-1.1.7.tgz`；`https://github.com/indutny/hash.js/tree/v1.1.7` | tgz SHA-256 `8eadfe0c…68ca6`；19 条目、0 法律文件。README 段 `409/1106/a263df31…b8cd9`（标题 `#### LICENSE`）：`Copyright Fedor Indutny, 2014`、完整 MIT。annotated tag `v1.1.7^{}` → `fcd35ed`（= npm gitHead），该 commit tree 21 文件、0 法律文件；README blob 与 tarball **字节一致**（`5df660fe…ba71`）。 |
| isarray | 1.0.0 | **VERIFIED（README 内嵌全文；精确 commit 可取）** | `https://registry.npmjs.org/isarray/-/isarray-1.0.0.tgz`；`https://github.com/juliangruber/isarray/tree/v1.0.0` | tgz SHA-256 `e23c76f1…50c87`；8 条目、0 法律文件。README 段 `793/1097/41199fc5…0bb25`：`Copyright (c) 2013 Julian Gruber &lt;julian@juliangruber.com&gt;`（HTML 实体为原始字节）、完整 MIT。tag `v1.0.0^{}` → `2a23a28`（= npm gitHead），tree 8 文件、0 法律文件；README 与 tarball 字节一致（`ff138e68…22ec7`）。 |
| lazy-val | 1.0.5 | **UNRESOLVED** | `https://registry.npmjs.org/lazy-val/-/lazy-val-1.0.5.tgz`；`https://github.com/develar/lazy-val/tree/b69ad411` | tgz SHA-256 `7d8602ad…35372`；5 条目、0 法律文件；`readme.md` 只有 API 说明、**无任何许可段落**（整份 README 仅 158 字节）。gitHead `b69ad411` 可取，tree 12 文件、0 法律文件；上游全历史 10 个 commit，**从未存在** LICENSE/COPYING/NOTICE；无 tag。 |
| ot-json1 | 1.0.2 | **VERIFIED（README 内嵌全文；段落在上游全历史稳定）** | `https://registry.npmjs.org/ot-json1/-/ot-json1-1.0.2.tgz` | tgz SHA-256 `4ef9cb66…5488e`；36 条目、0 法律文件。README 段 `6695/762/a8abfe1c…b170`：`Copyright (c) 2013-2018, Joseph Gentle &lt;me@josephg.com&gt;` + 完整 ISC（grant + 保留 + 免责）。npm gitHead `4ef85ce…` 上游不存在（git/API/codeload 均 404）；但上游 commit `888731d4`（2018-12-21，master 祖先）的 README 与 tarball 逐字节相同，且该 `## License` 段在 master 与所有历史 README 中 hash 恒为 `72cc460d…`（与 tarball 段正文一致）。 |
| ot-text-unicode | 4.0.0 | **CONFLICT（ISC metadata vs 缺保留条款的 MIT README）** | `https://registry.npmjs.org/ot-text-unicode/-/ot-text-unicode-4.0.0.tgz`；`https://github.com/ottypes/text-unicode/tree/v4.0.0` | tgz SHA-256 `7bab145a…ea23d3`；11 条目、0 法律文件。npm `license` = `ISC`；tag `v4.0.0` → `bdcfc545`（= npm gitHead），其 `package.json` 亦为 `ISC`。但该 commit（及 tarball）README `# License` 段 `9126/1028/399b53f8…eb08` 写「All code contributed to this repository is licensed under the standard MIT license」并给 MIT 正文，**且该正文缺少「The above copyright notice … shall be included」保留条款**（上游 `ottypes/text` 全历史 README 都缺此句，不是本版特有）。两条同源证据指向 4.0.0：其一为缺失条款的 MIT 文本，其二为 `ISC` 标识；**二者都不能单独作为完整、可执行、与 metadata 一致的授权全文**。 |
| react-remove-scroll-bar | 2.3.8 | **UNRESOLVED** | `https://registry.npmjs.org/react-remove-scroll-bar/-/react-remove-scroll-bar-2.3.8.tgz`；`https://github.com/theKashey/react-remove-scroll-bar` | tgz SHA-256 `ccc872d7…46f01`；27 条目、0 法律文件。README `# License` 后仅字面 `MIT`（4 字节，`adc37366…f8b2`），README 全文无 copyright/grant。npm gitHead `b3b1287a` 上游不存在（三路 404）。**上游 child repo 全历史中不存在版本号为 2.3.8 的 commit**（2.3.7 `29e9fcd` 2024-12-15 12:14 +1100 之后直接是 2025-05-21 的 `7301c16` “chore: add LICENSE file”，该 LICENSE 为 `Copyright (c) 2025 Anton Korzunov`，晚于 2.3.8 发布 2024-12-15 且含 2025 年版权，**不能用**）。与 1.0.5 extract-zip 同类：邻近版本与后续 LICENSE 都不得回填。 |
| strictdom | 1.0.1 | **VERIFIED（README 内嵌全文；精确 commit 可取）** | `https://registry.npmjs.org/strictdom/-/strictdom-1.0.1.tgz`；`https://github.com/wilsonpage/strictdom/tree/v1.0.1` | tgz SHA-256 `824b654d…3ffbbb`；3 条目、0 法律文件。README 段 `3051/1095/797db126…dd005`：`Copyright (c) 2013 Wilson Page <wilsonpage@me.com>` + 完整 MIT。tag `v1.0.1^{}` → `a3bbf190`（= npm gitHead），tree 13 文件、0 法律文件；README 与 tarball 字节一致（`9280acca…c202d`）。 |
| unicount | 1.1.0 | **VERIFIED（README 内嵌全文；精确 commit 可取）** | `https://registry.npmjs.org/unicount/-/unicount-1.1.0.tgz`；`https://github.com/josephg/unicount/tree/v1.1.0` | tgz SHA-256 `a41314cc…4385d`；6 条目、0 法律文件。README 段 `1294/728/a2f2f887…a56160`：`Copyright 2019 Joseph Gentle` + 完整 ISC。tag `v1.1.0^{}` → `79d4e853`（= npm gitHead），tree 8 文件、0 法律文件；README 与 tarball 字节一致（`bda82c37…5dd28b`）。 |

### 2.1 已 verified 的 8 项（只做回归核对，未重研）

本地 `apps/desktop/build/vendor-licenses/genoffice/licenses/` 中 8 份文件的实际 SHA-256 与 manifest `licenseTextSha256` **8/8 匹配**。本次未重新取证。

### 2.2 总控预取证据的独立复核

总控在 `docs/research/genoffice-license/evidence-index.md` 与 `evidence/*.txt` 中预取了 6 个包的 README 许可段。独立复核结果：

- 6 份文件在去除 CRLF 差异后，**逐字节等于**对应精确 tarball 内 README 的许可段（含各自 `## License`/`# License` 标题行）——已用子串定位核对 6/6。
- 6 个包的 MIT/ISC 归属与本次独立判定一致。
- 6 份文件均带标题行且使用 CRLF 换行；若未来要作为 bundle 素材，必须决定「是否包含标题行」与「换行规范化」政策，否则 SHA-256 会与本研究记录不一致（本报告记录的是 tarball 原始字节 hash）。

## 3. 策略裁决：README 内嵌全文是否满足「可追溯完整许可证全文」门槛

现行 gate（`apps/desktop/build/stage-genoffice-resources.cjs:181-203`）实际上强制的是**载体形态**：`licenseSourceUrl` 必须以 `https://raw.githubusercontent.com/` 开头、`licenseSourceKind` 必须是 `exact-upstream-source-file`、`licenseFile` 是单文件名，并校验 ≥150 字符 + 含授权语式。这意味着：

- 只有「上游仓库某一精确 commit 里有一个独立 LICENSE 文件」才能通过；
- README 章节即使逐字完整，也无法进入（提取物不是 raw 文件，且 `licenseSourceUrl` 指向 README 也不符合当前 schema 语义）。

### 支持「README 内嵌全文满足门槛」的理由

1. **许可法不规定载体。** MIT/ISC/BSD 的条件是「保留版权声明与许可声明」，没有任何一条要求许可文本必须位于名为 `LICENSE` 的文件。README 是发布者亲自签发、随包分发的载体。
2. **作者以 README 为唯一许可载体是这些包的历史事实。** hash.js、isarray、ot-json1、strictdom、unicount、fastdom 从首发至今从未发布过独立 LICENSE 文件（已核全历史）；它们的 npm 发布包、上游仓库、官方 tag 三个来源在这一点上完全一致。这不是「证据缺失」，是「载体不同」。
3. **证据强度可做到与独立 LICENSE 文件等价。** 本次对 6 个包均满足：精确 tarball SRI 校验 → README 字节 hash → 精确 commit 的 README blob 字节对照（4 个有 tag 可解的包 4/4 一致；2 个 gitHead 不存在但上游公开 README/历史 commit 一致）。可审计性不低于一份从 raw URL 取来的 LICENSE。
4. **对 fastdom/ot-json1 这类 gitHead 不存在的包，README 证据反而是唯一可追溯路径。** 上游发布流程（可能用了 CI 私有分支）没有把 commit 推回公开仓库；但 tarball 本身由 npm registry 的签名与 `dist.integrity` 保护，且其内容与上游公开 README 一致。若坚持「必须 raw LICENSE 文件」，这两项将永久 UNRESOLVED，除非作者补发许可证，发行阻断无法靠取证解除。
5. **strict gate 的目的（防止 SPDX 标签或相似版本冒充全文）不受影响**：门槛仍可要求「≥150 字符 + 含 grant/免责 + 精确版字节 hash + 来源 URL 固定到精确版本」。

### 反对「README 内嵌全文满足门槛」的理由

1. **README 是可变的叙述性文件，抽取规则本身是新的信任面。** 需要固定「取哪个标题之后」「是否含空行」「是否做换行规范化」，任何一个约定变化都会改变 hash。本报告与 T89/T90 的边界约定已经不同（差一个前导换行），说明这个风险是真实的。
2. **README 章节可能不完整。** 本次实证：ot-text-unicode 的 MIT 段**缺保留条款**；react-remove-scroll-bar 与 extract-zip 的 README 只有 4/14 字节的裸 SPDX 名称。若把「README 内嵌」一律放行，需要额外的最低完整性判据，否则上述三类会混入。
3. **发布包与仓库 commit 可能脱节。** fastdom/ot-json1 的 gitHead 在上游不存在。放行 README 意味着接受「tarball 可信（SRI/签名）但无法映射到公开 commit」的证明链，这比「raw LICENSE at exact commit」弱一档。
4. **现行 policy 是已审核的既有决定。** `manifest.json` 的 `policy` 字段与 T87 的验收都写明「SPDX metadata and package README text are not substitutes for missing license text」。放宽属于发行政策变更，不能由取证方单方面决定（T9 卡也明确禁止改 release gate）。

### 建议（供总控/T11 决策，不由本卡实施）

1. **裁决建议：有条件承认「精确发布包内嵌的完整许可正文」为合格载体**，但必须同时满足下列全部条件，缺一不可：
   - 来源是 SRI 校验通过的**精确版本** npm tarball（或精确 commit 的来源归档），不是相邻版本、不是仓库 HEAD、不是网页；
   - 文本含该许可的**全部要件**：版权声明、授权条款、保留条款（MIT/ISC/BSD 的 notice 要求）、免责声明；缺失任一条即 CONFLICT/UNRESOLVED（例如 ot-text-unicode 缺保留条款 → 不放行）；
   - 记录原始字节区间与 SHA-256，并固定边界约定（建议：**不含标题行、不含标题后的空行，从首个非空字符起至 EOF**），写进 manifest schema 的显式字段（例如 `licenseSourceKind: "exact-npm-release-readme-section"` + `licenseSourceReadmeHeading` + `licenseSourceByteRange`）；
   - 精确 commit 可取时，必须附上「精确 commit README blob 与 tarball README 字节一致」的对照结果；不可取时（gitHead 不存在）必须显式记录「commit 不可取，仅有 SRI + 上游公开 README 一致」这一较弱证明链，并由审查者逐项签字。
2. **明确不放行清单（按此规则仍阻塞）**：extract-zip 1.0.5（README 无条文）、lazy-val 1.0.5（README 无许可段）、react-remove-scroll-bar 2.3.8（README 仅 MIT 字样、gitHead 不存在、2.3.8 无任何上游 commit）、ot-text-unicode 4.0.0（ISC/MIT 冲突 + MIT 缺保留条款）。这 4 项**不能靠取证解除**，只能靠权利方补发或依赖替换/移除。
3. **若决策者不接受 README 载体**：则 10 项全部保持 blocked，其中 6 项（fastdom、hash.js、isarray、ot-json1、strictdom、unicount）的「缺什么」应改写为「作者补发独立 LICENSE，或由法律审查接受 README 载体」，而非「证据未找到」——因为证据已经找到且可复现。
4. **对 ot-text-unicode 的专项建议**：需要权利方（ottypes 维护者）对 4.0.0 明确单一许可（ISC 或 MIT）并给出含保留条款的完整文本；在此之前任何一侧的文本都不应写入 notice。

## 4. 仍阻塞发行的项与解除条件

| 包 | 状态 | 缺什么才能解 |
|---|---|---|
| @electron-internal/extract-zip 1.0.5 | UNRESOLVED | 权利方（Electron 项目）出具覆盖 v1.0.5 / `b83e459` 的完整 BSD-2-Clause 文本（含版权行与免责），或明确许可声明；**不得**使用 2026-09-10 之后的 MIT LICENSE。备选：替换依赖版本到 v1.0.6+（MIT，且有 LICENSE 文件）并重新过 T87/T76 门禁——但这属于产品变更，不在本卡。 |
| lazy-val 1.0.5 | UNRESOLVED | 维护者（develar）出具覆盖 1.0.5 / `b69ad411` 的完整 MIT 文本；上游从未有过 LICENSE 文件，无其他可审计来源。 |
| ot-text-unicode 4.0.0 | CONFLICT | 权利方对 4.0.0 的许可作单一明确声明，并提供含保留条款的完整文本。 |
| react-remove-scroll-bar 2.3.8 | UNRESOLVED | 精确 `b3b1287` commit/归档（上游不存在），或权利方明确绑定 npm 2.3.8 的 MIT 全文及版权行；**不得**使用 2025-05-21 新增的 LICENSE（含 2025 年版权，晚于发布）。 |
| fastdom 1.0.12 | 取证已 VERIFIED（README） | 若接受 README 载体即可解；否则需作者补发独立 LICENSE。 |
| hash.js 1.1.7 | 取证已 VERIFIED（README，精确 commit 一致） | 同上。 |
| isarray 1.0.0 | 取证已 VERIFIED（README，精确 commit 一致） | 同上。 |
| ot-json1 1.0.2 | 取证已 VERIFIED（README，段落在全历史稳定） | 同上。 |
| strictdom 1.0.1 | 取证已 VERIFIED（README，精确 commit 一致） | 同上。 |
| unicount 1.1.0 | 取证已 VERIFIED（README，精确 commit 一致） | 同上。 |

**阻塞计数**：按现行 gate（要求独立许可证文件）= **10 项阻塞**。按第 3 节建议的有条件 README 政策 = **6 项可解、4 项仍阻塞**。无论哪种口径，本卡**不宣称发行门禁通过**，`releaseEligible=false` 不变。

## 5. 本卡未做/不做

- 未修改 `apps/desktop/build/vendor-licenses/genoffice/manifest.json`、`licenses/`、`stage-genoffice-resources.cjs`、任何 release gate、`patches/**`、`package.json`。
- 未执行 `npm install`/`npm ci`，未运行 installer，未宣称任何 U1。
- 未从相邻版本推断任何许可证文本；`react-remove-scroll-bar` 的 2.3.7、`extract-zip` 的 v1.0.6/main、`ottypes/text` 的当前 README 均已核查但**未被采用**为 2.3.8/1.0.5/4.0.0 的证据（文本存在但版本不对/许可不同）。
