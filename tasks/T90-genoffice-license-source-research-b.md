# T90｜GenOffice 缺失许可证来源取证 B 组

| 项目 | 值 |
|---|---|
| 编号 | T90 |
| 优先级 | P1 发行阻断解除前置 |
| 来源 | T87：GenOffice 补丁链已可复现，但 18 项依赖仅 8 项有准确版本的完整许可证全文 |
| 目标 | 只对下列 5 个精确 package@version 寻找可核验的上游完整许可证全文，不修改发行实现 |
| 独占可写 | 本任务卡的结果回写区 |
| 只读范围 | `apps/desktop/build/vendor-licenses/genoffice/manifest.json`、其对应的 5 个包材料、T87 任务卡及相关上游/npm 来源 |
| 禁止 | 不改 manifest、stage/afterPack、notice、Smoke 或任何产品源码；不修改 `genoffice/**` / `patches/genoffice/**`；不执行 npm install/ci；不根据 SPDX、README 或相似版本自行补写许可证 |

## 精确调查清单

1. `ot-json1@1.0.2`（ISC）
2. `ot-text-unicode@4.0.0`（ISC）
3. `react-remove-scroll-bar@2.3.8`（MIT）
4. `strictdom@1.0.1`（MIT）
5. `unicount@1.1.0`（ISC）

包版本、tarball integrity、上游 revision 以 T87 manifest 的对应 entry 为事实基准；不要自行替换成最新版本。

## 执行内容

1. 先读 `audit-ledgers/README.md`、`tasks/README.md`、T87 卡和 GenOffice license manifest，逐项复核当前已记录的缺失证据。
2. 对每个精确版本，检查 npm registry packument/tarball、发布 metadata、对应 gitHead/commit、官方 tag/release/archive、仓库历史与包维护者发布的权威来源。不得执行安装脚本。
3. 只有找到可追溯到准确发布版本或准确上游 revision 的完整授权文本，才判定有证据。记录完整来源 URL、revision/commit、源文件路径、SPDX 声明、tarball integrity、全文 SHA-256；区分“发布包本身带有全文”和“同一上游的权威源码文件可证明属于该版本”。
4. 对 T87 已指出的“发布 gitHead 不在当前 advertised refs”问题，检查确切 commit 对象是否可由可信 archive、官方 tag 或发布记录验证；不得用相似版本 commit 代替。
5. 若无全文，记录已查过的来源、具体失败原因、所需的最小额外证据。不要从标准许可证名称、相似版本或其他包复制通用文本。
6. 只在本卡回写每项结论与证据，不创建或修改共享 manifest / 许可证材料。若来源找到，也可记录其全文的准确来源路径和 SHA-256，供后续集成卡消费。
7. 不宣称本任务可以解除发行阻断；T87 strict gate 仍须保持 fail-closed。

## 验收判据

1. 5 个 package@version 均逐项给出 VERIFIED 或 UNRESOLVED，不留空白、不猜测。
2. 每个 VERIFIED 项都有可审计的权威全文来源、准确版本/revision、文件路径和 SHA-256；仅有 SPDX metadata 不算。
3. 未找到来源的条目明确写出已查证据及 remaining，不生成 placeholder，不建议放宽 gate。
4. 仅修改本任务卡；没有执行 npm install/ci，没有改 vendor checkout 或发行代码。

## 结果回写区

<!-- 追加逐包证据、检索路径、SHA-256、命令结果和未解决原因。 -->

## T90 结果回写（2026-10-22）

### 边界、方法与原始证据

- 基准：T87 `apps/desktop/build/vendor-licenses/genoffice/manifest.json` 中本组五条 `name/version/spdx/gitHead/npmTarballIntegrity`；调查前主仓库 HEAD `64d81e378524faa2994aac5f37340f04824f45ea`。仅追加本卡，未修改共享 manifest、vendor checkout、补丁、staging、notice 或 Smoke。
- 取证操作（只读、无安装）：使用本机 Node.js `fetch` GET 各准确版本 `https://registry.npmjs.org/<package>/<version>` 及其 `dist.tarball`，对原始 tgz 字节计算 `sha512-` Base64，与 npm `dist.integrity` 和 T87 manifest 的 SRI 逐项比对：**五项全部一致**。仅在内存中 `zlib.gunzipSync` 并逐条解析 TAR；五个 tgz 都没有独立的 `LICENSE` / `COPYING` / `NOTICE` 条目，但均有 `package/README.md`。**有无独立许可证文件，与发布包中是否包含逐字完整授权条款，分开判定。**
- 全文哈希算法：对于发布包 `package/README.md` 的最后一个 `# License` / `## License` / `# LICENSE` 标题，直接截取该标题行换行符**之后直至 README EOF** 的原始 UTF-8 字节（保留紧随标题的空行、最后换行、大小写及 HTML 实体；不人工改写），计算 `SHA-256`。下列 `license-section SHA-256` 均指**这个原样连续字节片段**，不是推测/合成的通用 MIT/ISC 模板；同时提供整份 README 哈希和精确截取字节偏移，可由 SRI 已校验的原始 tarball 重算。仅有 `# License\nMIT` 的 4 字节标签**不算全文**。
- GitHub 官方 API 只读核验：`GET /repos/{owner}/{repo}/git/commits/{gitHead}`；`GET /repos/{owner}/{repo}/tags?per_page=100`、精确 commit/tree 的文件目录以及官方 README/package.json。最初批次对 T87 所列 `josephg/json1`、`ottypes/text`、`theKashey/react-remove-scroll-bar` 的 gitHead 返回 404；`wilsonpage/strictdom`、`josephg/unicount` 的 commit 对象返回 200。另查到 `ottypes/text-unicode` 的官方 `v4.0.0` tag 正好指向 npm 发布的 `bdcfc545...`。后续 GitHub API 请求出现速率限制 HTTP 403，不把 403 误报为 commit 不存在；下述本身由 npm 完整发布包核实的证据不依赖这些 API 的后续可用性。

### 五个准确 package@version 的裁定

**1. `ot-json1@1.0.2` — VERIFIED（准确 npm 发布包内嵌完整 ISC 原文；非上游 commit 已恢复）**

- SPDX：`ISC`；npm 版号：`1.0.2`；`dist.integrity`：`sha512-IhxkqVWQqlkWULoi/Q2AdzKk0N5vQRbUMUwubFXFCPcY4TsOZjmp2YKrk0/z1TeiECPadWEK060sdFdQ3Grokg==`，实算一致。
- 官方 metadata：`https://registry.npmjs.org/ot-json1/1.0.2`；准确发布包：`https://registry.npmjs.org/ot-json1/-/ot-json1-1.0.2.tgz`；原文所在路径：该 tgz 内 `package/README.md` 的 `## License` 标题之后至 EOF。该片段包括 Joseph Gentle 版权、ISC 的完整许可授予和免责声明，并非仅有 SPDX 标签。
- README 全文件 SHA-256：`b4724312356fc700f0044c0ccc0ac4eba002cc3f9834bf180ff7d0c594c373f5`；许可原文起始偏移 **6695 字节**、长度 **762 字节**；**license-section SHA-256 `a8abfe1c53505104f5f8411a4967074337a01a550b57142dc06189978960b170`**。
- npm 发布 `gitHead=4ef85ce5e0ff9e9b9969da13303913b11fec86cf`；`https://github.com/josephg/json1/tree/4ef85ce5e0ff9e9b9969da13303913b11fec86cf`；GitHub commit API 对精确 SHA 为 **404**，官方 tag 列表没有 `v1.0.2`（仅到 `v1.0.1`）。**不把旧 tag / 当前 master 当成此版本证明。** 判定 VERIFIED 的独立依据是准确版本、SRI 校验通过的**发布包本身已经逐字包含全文**；上游 gitHead 的可取得性仍是独立的 provenance 未决项，不伪称已恢复。

**2. `ot-text-unicode@4.0.0` — UNRESOLVED（发现准确提交和全文性质冲突，但未取得准确 ISC 授权全文）**

- SPDX：`ISC`；npm `gitHead=bdcfc545c1a2eda48fe5968ae2ce80cf743b9c08`；发布包 `https://registry.npmjs.org/ot-text-unicode/-/ot-text-unicode-4.0.0.tgz`；SRI `sha512-W7ZLU8QXesY2wagYFv47zErXud3E93FGImmSGJsQnBzE+idcPPyo2u2KMilIrTwBh4pbCizy71qRjmmV6aDhcQ==`，校验通过；metadata：`https://registry.npmjs.org/ot-text-unicode/4.0.0`。
- T87 原登记上游 `https://github.com/ottypes/text` 的该 gitHead 在 commit API 为 404。进一步发现同一组织的**正确版本仓库** `https://github.com/ottypes/text-unicode`，官方 tag `v4.0.0` **正指向** `bdcfc545c1a2eda48fe5968ae2ce80cf743b9c08`，其 `package.json` 明示 `name=ot-text-unicode, version=4.0.0`。来源定位：`https://github.com/ottypes/text-unicode/tree/v4.0.0`、`https://github.com/ottypes/text-unicode/blob/v4.0.0/README.md`。
- 但在准确发布包的 `package/README.md` `# License` 中，作者**明确写所有代码以 MIT 授权**，给出 MIT 风格许可文字，而 npm `package.json` 的精确版本声明为 `ISC`；并无独立 ISC 许可文件。作为冲突证据保留：README SHA-256 `2bf9650ed6fb0614f4d830ad27f2c4033c4052204b352bf78469a45c5a7569df`；许可段偏移 **9126 字节**、长度 **1028 字节**、SHA-256 `399b53f8c9741bdaf20771e9e5d8586c82795a3e76098743a9c0c6d06856eb08`。**该哈希是冲突的 MIT 段，不是 ISC 授权全文，不得并入 ISC manifest。**
- remaining：需要官方维护者对该准确 `4.0.0` 发行版 `ISC` metadata 与版本 README 的 MIT 声明作明确解释，并提供准确版可执行的完整授权条款（或可审计的双授权证明）；不能据标签或邻近版本自己重写 ISC 文本。

**3. `react-remove-scroll-bar@2.3.8` — UNRESOLVED（准确发布包仅 MIT 标识，无全文；上游 gitHead 不可取）**

- SPDX：`MIT`；npm `gitHead=b3b1287aad81def2e2ae707274b74531b61ddbaf`；metadata `https://registry.npmjs.org/react-remove-scroll-bar/2.3.8`；tgz `https://registry.npmjs.org/react-remove-scroll-bar/-/react-remove-scroll-bar-2.3.8.tgz`；SRI `sha512-9r+yi9+mgU33AKcj6IbT9oRCO78WriSj6t/cF8DWBZJ9aOGPOTEDvdUDz1FwKim7QXWwmHqtdHnRJfhAxEG46Q==`，校验通过。
- 发布包 `package/README.md` SHA-256 `486442209236ffa3893312e508694699a6b8834d30a2f9c083c1f3379983e4f9`。末尾 `# License` 后仅字面量 `MIT\n`（**4 字节**，SHA-256 `adc37366f403835c1470ab2df93d3837d4719372fc1ef8593d922e06f033f8b2`），不是授予、条件、免责声明的全文。也无独立 `LICENSE` 文件。
- 官方 `https://github.com/theKashey/react-remove-scroll-bar/tree/b3b1287aad81def2e2ae707274b74531b61ddbaf` 的精确 commit API 返回 404；tag 列表最高 `v2.3.7`，不含 `v2.3.8`；`v2.3.7` 的 `package.json` 版本为 `2.3.7`。仓库当前含 `LICENSE` 不能证明发布于 `2.3.8` 时的许可文本，**不借用相邻版本**。
- remaining：需要仓库维护者/发布方可核查的精确 `b3b1287...` commit/官方归档，或者直接明确绑定 npm `2.3.8` 的 MIT 全文及版权信息。不能用通用模板或类似版本 LICENSE 代替。

**4. `strictdom@1.0.1` — VERIFIED（准确 npm 发布包内嵌完整 MIT 原文）**

- SPDX：`MIT`；npm `gitHead=a3bbf19013ecc9c9d165dd4ed89e94757161443e`；官方 tag `v1.0.1` 指向该确切 SHA；git commit API 首批请求 HTTP 200；`https://github.com/wilsonpage/strictdom/tree/v1.0.1`，准确版本 `package.json` 的仓库路径 `https://github.com/wilsonpage/strictdom/blob/v1.0.1/package.json`。
- 官方 npm metadata `https://registry.npmjs.org/strictdom/1.0.1`；tgz `https://registry.npmjs.org/strictdom/-/strictdom-1.0.1.tgz`；SRI `sha512-cEmp9QeXXRmjj/rVp9oyiqcvyocWab/HaoN4+bwFeZ7QzykJD6L3yD4v12K1x0tHpqRqVpJevN3gW7kyM39Bqg==`，校验通过。
- 全文源路径：该准确 tgz 的 `package/README.md` `## License` 后至 EOF（版权 `Copyright (c) 2013 Wilson Page`、许可授予、包含版权/许可告知条件、免责声明）；对应上游 `https://github.com/wilsonpage/strictdom/blob/a3bbf19013ecc9c9d165dd4ed89e94757161443e/README.md`。这是真实作者版权与原文，不从标准 MIT 文本合成。
- README SHA-256：`9280accadb9c4d0aa2de2b304da7f477eacb0823504964b71370eb7ab99c202d`；许可段起始偏移 **3051 字节**、长度 **1095 字节**；**license-section SHA-256 `797db126016c3c6e83663b1f2b04a1adf5953032432aa2796b3140840fbdd005`**。来源种类：**准确版本发布包内嵌完整全文**，而非独立许可证文件。

**5. `unicount@1.1.0` — VERIFIED（准确 npm 发布包内嵌完整 ISC 原文）**

- SPDX：`ISC`；npm `gitHead=79d4e85321209b72459cc0ff9d26d51f544039e9`；官方 tag `v1.1.0` 与该 SHA 一致；精确 commit API 首批请求 HTTP 200；`https://github.com/josephg/unicount/tree/v1.1.0`、`https://github.com/josephg/unicount/blob/79d4e85321209b72459cc0ff9d26d51f544039e9/README.md`。
- 官方 npm metadata `https://registry.npmjs.org/unicount/1.1.0`；tgz `https://registry.npmjs.org/unicount/-/unicount-1.1.0.tgz`；SRI `sha512-RlwWt1ywVW4WErPGAVHw/rIuJ2+MxvTME0siJ6lk9zBhpDfExDbspe6SRlWT3qU6AucNjotPl9qAJRVjP7guCQ==`，校验通过。
- 全文源路径：该准确 tgz 内 `package/README.md` 的 `# LICENSE` 后至 EOF；原文包含 Joseph Gentle 2019 版权、ISC 许可授予和完整免责声明。README SHA-256 `bda82c37fba4443f9acb8d311afc4c7c07aed00435d52331a54e6d7f3e5dd28b`；许可段偏移 **1294 字节**、长度 **728 字节**；**license-section SHA-256 `a2f2f887d2d1a5fe20c278917efd26df0f72f72d84437058e405818c53a56160`**。来源种类：**准确版本发布包内嵌完整全文**，不是仅从 LICENSE 标题或 ISC 字样推导。

### 本卡判据及剩余风险

- 判据 1：**PASS**。5/5 逐项定性：**3 VERIFIED**（`ot-json1`、`strictdom`、`unicount`），**2 UNRESOLVED**（`ot-text-unicode`、`react-remove-scroll-bar`）。
- 判据 2：**PASS**。三个 VERIFIED 都有准确版本、npm 官方发布包 URI、SRI 完整一致、原始授权全文的 `package/README.md` 定位、提取原样字节区间与 SHA-256；`strictdom` / `unicount` 还有精确的官方 tag/gitHead。特别注明：它们并无独立 `LICENSE` 文件，完整条款**确实在发布包 README 内**；不能把仅含许可证名称的 README 混为一谈。
- 判据 3：**PASS**。两个 UNRESOLVED 的已查来源、拒绝推断的理由及最小额外证据均如上。没有产生任何许可证 placeholder；`ot-text-unicode` 的 MIT/ISC 冲突不可忽略；`react-remove-scroll-bar` 的 `v2.3.7` 不得充当 `2.3.8`。
- 判据 4：**PASS**。仅本任务卡回写；未运行 `npm install` / `npm ci`；未修改 `genoffice/**`、`patches/genoffice/**`、shared manifest、license bundles、产品源码、release gate 或 Smoke。
- **T87 发行阻断仍有效**：本卡仅提供可供后续授权审查/集成卡消费的证据，未修改严格 notice/bundle 校验，未声称发行合格。准确发布包中的作者全文仍需由集成方按政策独立审查、落入正式 notice 并通过严格 gate；上述两项仍缺可接受证据。
