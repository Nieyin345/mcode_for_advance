# T89｜GenOffice 缺失许可证来源取证 A 组

| 项目 | 值 |
|---|---|
| 编号 | T89 |
| 优先级 | P1 发行阻断解除前置 |
| 来源 | T87：GenOffice 补丁链已可复现，但 18 项依赖仅 8 项有准确版本的完整许可证全文 |
| 目标 | 只对下列 5 个精确 package@version 寻找可核验的上游完整许可证全文，不修改发行实现 |
| 独占可写 | 本任务卡的结果回写区 |
| 只读范围 | `apps/desktop/build/vendor-licenses/genoffice/manifest.json`、其对应的 5 个包材料、T87 任务卡及相关上游/npm 来源 |
| 禁止 | 不改 manifest、stage/afterPack、notice、Smoke 或任何产品源码；不修改 `genoffice/**` / `patches/genoffice/**`；不执行 npm install/ci；不根据 SPDX、README 或相似版本自行补写许可证 |

## 精确调查清单

1. `@electron-internal/extract-zip@1.0.5`（BSD-2-Clause）
2. `fastdom@1.0.12`（MIT）
3. `hash.js@1.1.7`（MIT）
4. `isarray@1.0.0`（MIT）
5. `lazy-val@1.0.5`（MIT）

包版本、tarball integrity、上游 revision 以 T87 manifest 的对应 entry 为事实基准；不要自行替换成最新版本。

## 执行内容

1. 先读 `audit-ledgers/README.md`、`tasks/README.md`、T87 卡和 GenOffice license manifest，逐项复核当前已记录的缺失证据。
2. 对每个精确版本，检查 npm registry packument/tarball、发布 metadata、对应 gitHead/commit、官方 tag/release/archive、仓库历史与包维护者发布的权威来源。不得执行安装脚本。
3. 只有找到可追溯到准确发布版本或准确上游 revision 的完整授权文本，才判定有证据。记录完整来源 URL、revision/commit、源文件路径、SPDX 声明、tarball integrity、全文 SHA-256；区分“发布包本身带有全文”和“同一上游的权威源码文件可证明属于该版本”。
4. 若无全文，记录已查过的来源、具体失败原因、所需的最小额外证据。不要从标准许可证名称、相似版本或其他包复制通用文本。
5. 只在本卡回写每项结论与证据，不创建或修改共享 manifest / 许可证材料。若来源找到，也可记录其全文的准确来源路径和 SHA-256，供后续集成卡消费。
6. 不宣称本任务可以解除发行阻断；T87 strict gate 仍须保持 fail-closed。

## 验收判据

1. 5 个 package@version 均逐项给出 VERIFIED 或 UNRESOLVED，不留空白、不猜测。
2. 每个 VERIFIED 项都有可审计的权威全文来源、准确版本/revision、文件路径和 SHA-256；仅有 SPDX metadata 不算。
3. 未找到来源的条目明确写出已查证据及 remaining，不生成 placeholder，不建议放宽 gate。
4. 仅修改本任务卡；没有执行 npm install/ci，没有改 vendor checkout 或发行代码。

## 结果回写区

<!-- 追加逐包证据、检索路径、SHA-256、命令结果和未解决原因。 -->

## T89 结果回写（2026-10-22；只读取证，未集成）

### 口径及复核方式

- 基线：`apps/desktop/build/vendor-licenses/genoffice/manifest.json` 的 5 个精确版本、SPDX、`npm-gitHead`、npm tarball URL 和 SHA-512 SRI；没有替换任何版本或修改该 manifest。
- 逐项请求 npm 官方 `https://registry.npmjs.org/<name>/<version>` 发布元数据，并**在内存中**下载相应 tarball，以 `sha512-<base64>` 对照 manifest SRI；gunzip 后按 tar header 枚举全部文件，读取 `package/package.json` 确认版本。5/5 SRI 一致、5/5 包内版本一致；**没有**执行 npm install/ci、包脚本或向项目写 tarball。
- 核验 GitHub 官方 tag（`git ls-remote --tags`）、对应 commit tree（GitHub REST trees；速率限制后不把 403 误记成文件缺失）、上游 blob；已读取的 exact-commit `README` blob 以 Git SHA-1 blob object ID 校验，并与对应发布包 `README` 的 SHA-256 对照。GitHub raw 经本地 TLS 代理取回时以**预先可信的 tree blob SHA**做对象级核验，没有仅凭不受信任连接认定内容。
- **证据边界**：下述 VERIFIED 是「**精确发布包本身包含发布者撰写的完整许可法律条款**」，而不是「tarball 存在独立 LICENSE 文件」；3 份全文实际上位于发布包 README 的明确 License 章节。**只是直接对准确发布包的原始法律条款做只读取证，未根据 README/SPDX 自行补写/改写许可证，也未生成任何许可证材料。** 后续集成卡需单独审查该证据是否符合严格最终 notice 的取材政策；不允许把本研究结论直接等价为 strict release gate PASS。
- 全文哈希的**无损计算规则**：在 tarball 原始 `package/README.md` 中定位独立行 `## License`（hash.js 是 `#### LICENSE`），跳过该标题及紧随的**一个空行**，将其后直到文件 EOF 的**原始 UTF-8 字节**视为发布者提供的完整法律正文；不去头尾空格、不变换换行、不解码 HTML entities，不复制通用 MIT 模板。以下 SHA-256 均针对**该原始字节片段**，不是整个 README 或重新排版的文本。

### 逐包结论及完整来源

1. **UNRESOLVED — `@electron-internal/extract-zip@1.0.5`（BSD-2-Clause）**
   - 发布元数据：`https://registry.npmjs.org/@electron-internal%2Fextract-zip/1.0.5`；tarball `https://registry.npmjs.org/@electron-internal/extract-zip/-/extract-zip-1.0.5.tgz`；SRI `sha512-+bqFCP98pLI0Tt0XQo1TmlXtwjWchISndDOxCkEcIuUgXWpBnLyRI+2DU+mesvnMMX6L1XDqYNA0lXNDHd/yiA==`，实算匹配。tar 15 entries，独立 LICENSE/LICENCE/COPYING/NOTICE：0。
   - 发布 `gitHead` = `b83e459fd04c53b0a1c8438a6792df8f64be47fc`；官方 tag `refs/tags/v1.0.5` **直接指向该提交**；源 `https://github.com/electron/extract-zip/tree/b83e459fd04c53b0a1c8438a6792df8f64be47fc`。该提交 GitHub tree（36 entries）无 LICENSE/NOTICE/COPYING；其 `README.md` 与 tar 的 `package/README.md` 一致，SHA-256 `61090965f7edb896c4492e9a090bec14e8e6abe2322480e4d2acde2a478c7500`，只有 `## License\n\nBSD-2-Clause`，没有两条 BSD 条款的完整文本。历史准确 tag 已查；不可从当前默认分支的许可证文件跨版本搬用。
   - **remaining**：发行方/维护者提供明确覆盖 `v1.0.5` / `b83e459...` 的完整 BSD-2-Clause 著作权/免责声明/许可文本及可审计 URL 或签名发布资料。不能从 SPDX 代写。

2. **VERIFIED（准确 npm 发布包内嵌全文）— `fastdom@1.0.12`（MIT）**
   - 发布元数据 `https://registry.npmjs.org/fastdom/1.0.12`；tarball `https://registry.npmjs.org/fastdom/-/fastdom-1.0.12.tgz`；SRI `sha512-LB+xjSTEbjHE1cWsxu+tN2Xqr1kpi+V9aADI7sVM5ZMaXyYGPHULQMzpJMYqOTULK/73pUkWVzzObFRBkPr+hg==`，实算匹配；13 tar entries、无独立许可证文件。源路径 **tarball `package/README.md` → `## License`**：包含明确的 `(The MIT License)`、`Copyright (c) 2016 Wilson Page`、完整 grant/retain-notice/disclaimer 全文，不是单纯 SPDX。
   - 原封不动正文：tar file 内偏移 **6431** bytes 起至 EOF、**1094 bytes**，**SHA-256 `50c0de64f5cd5e39859b43f7eca7f5843fb3c3d5ac7e34a453e27419ad51e08c`**；整个 `package/README.md` SHA-256 `cc5669ab6f7741bb061c8a7244addc8e3af1f84ec7d2445744b59d0169a87d11`。
   - npm `gitHead` = `a7b9044d58952b970c8b918dcf0e7c8824ba0ff5`，标称仓库 `https://github.com/wilsonpage/fastdom`。尝试 `https://api.github.com/repos/wilsonpage/fastdom/git/trees/a7b9044d58952b970c8b918dcf0e7c8824ba0ff5?recursive=1` 返回 **422 Invalid object requested**；上游公布 tags 没有 `v1.0.12`。因此 **只验证精确 SRI npm 发行包内全文，不声称复核了该 gitHead 源码树**。
   - **remaining**：尚缺该 `gitHead` 可取回的源码对象和独立 LICENSE；不影响「发行包内已有完整发布者 MIT 条文」这一有限事实。若集成政策不接受 README 内嵌全文，仍需维护者按版本确认的独立授权文件。

3. **VERIFIED（准确 npm 发布包内嵌全文，且 pinned 源文件一致）— `hash.js@1.1.7`（MIT）**
   - 发布元数据 `https://registry.npmjs.org/hash.js/1.1.7`；tarball `https://registry.npmjs.org/hash.js/-/hash.js-1.1.7.tgz`；SRI `sha512-taOaskGt4z4SOANNseOviYDvjEJinIkRgmp7LbKP2YTTmVxWBl87s/uzK9r+44BclBSp2X7K1hqeNfz9JbBeXA==`，实算匹配；19 entries，无独立 LICENSE 文件。
   - `gitHead=fcd35edcc4e30145be4b7a737477ad54e83afc25`，官方 **`v1.1.7^{}`** 解引用正是该 commit；源 `https://raw.githubusercontent.com/indutny/hash.js/fcd35edcc4e30145be4b7a737477ad54e83afc25/README.md`（Git tree blob `006d3bbf5e78cad61af72e5c517f254818d2b2ab`）；上游 README 原字节 SHA-256 与 tar `package/README.md` **一致**：`5df660fe115c8ddcdb81c5d733c117b94abb706b91c26dac3ab7dc817dd9ba71`。
   - 全文源路径：**tarball `package/README.md` → `#### LICENSE`**（同 pinned 上游 `README.md`）；明确 `Copyright Fedor Indutny, 2014` 和完整 MIT 权利/条件/免责正文。标题与空行之后的原字节偏移 **410**，长 **1105 bytes**；全文 **SHA-256 `7261b3ab93df04c6d8f3398f87275d28f0e87d88cbd0033b788fb50402de03c5`**。
   - **remaining**：独立 LICENSE 文件不存在；若 strict notice 证据政策不承认上游 README 内已载完整法律全文，则仍需发行者的独立授权资料，严禁用通用模板补写。

4. **VERIFIED（准确 npm 发布包内嵌全文，且 pinned 源文件一致）— `isarray@1.0.0`（MIT）**
   - 发布元数据 `https://registry.npmjs.org/isarray/1.0.0`；tarball `https://registry.npmjs.org/isarray/-/isarray-1.0.0.tgz`；SRI `sha512-VLghIWNM6ELQzo7zwmcg0NmTVyWKYjvIeM83yjp0wRDTmUnrM678fQbcKBo6n2CJEF0szoG//ytg+TKla89ALQ==`，实算匹配；8 entries，无独立 LICENSE。
   - `gitHead=2a23a281f369e9ae06394c0fb4d2381355a6ba33`，官方 tag `v1.0.0^{}` 解引用指向该 commit；源 `https://raw.githubusercontent.com/juliangruber/isarray/2a23a281f369e9ae06394c0fb4d2381355a6ba33/README.md`（Git blob `16d2c59c6195f9a1ac9af37cb9d75f1a6b85ab01`），与发布包 `package/README.md` 完全一致，SHA-256 `ff138e683771b187f3629c383db72ee7d632009010a36d08e18e8d2a34222ec7`。
   - 全文源路径：**tarball `package/README.md` → `## License`**；包含 Julian Gruber (2013) 著作权、完整 MIT grant/condition/disclaimer。正文起始字节偏移 **794**，长 **1096 bytes**；**SHA-256 `a1bd5deadb6a06dd74efa852c1b8b23f63b67f2214fbe9c8bd591da51da69268`**。注意原文 copyright 邮箱括号写作 HTML 实体 `&lt;` / `&gt;`：这是发行**原字节**，本卡未做实体替换。
   - **remaining**：独立 LICENSE 文件不存在；由最终集成卡决定能否直接使用上游精确 README 法律全文原字节；不能私自反转义或改写版权声明。

5. **UNRESOLVED — `lazy-val@1.0.5`（MIT）**
   - 发布元数据 `https://registry.npmjs.org/lazy-val/1.0.5`；tarball `https://registry.npmjs.org/lazy-val/-/lazy-val-1.0.5.tgz`；SRI `sha512-0/BnGCCfyUMkBpeDgWihanIAF9JmZhHBgUhEqzvf+adhNGLoP6TaiI5oF8oyb3I45P+PcnrqihSf01M0l0G5+Q==`，实算匹配。5 entries，法律文件 0，`package/readme.md` 仅 API 描述 158 bytes、**没有**许可段落；README SHA-256 `87dd77cd27b045ab279f6f2c99acedaeec6b7c92e296a354bb2687b9f2965438`。
   - npm `gitHead=b69ad4119f1b19bdab13c61ee2fcc88d46b89071`；源 `https://github.com/develar/lazy-val/tree/b69ad4119f1b19bdab13c61ee2fcc88d46b89071`；该 commit GitHub tree 14 entries，无 LICENSE/NOTICE/COPYING；精确 `readme.md` 的 Git blob `dde7417819786bc4ff4228b500bc54e244f89366` 已与 tar README 匹配；`git ls-remote --tags https://github.com/develar/lazy-val.git` 无公布 tag。
   - **remaining**：维护者出具覆盖 `1.0.5` / `b69ad411...` 的完整 MIT 著作权与授权免责全文，附该版本确切来源或直接签发的声明。不能从 SPDX MIT 名称、同作者其他包或其他版本推导。

### 验收判定与发行边界

- 判据 1：**PASS**；5/5 精确版本已逐项标注，**3 VERIFIED（仅准确 tarball 中无损、全文的发布者 License 小节），2 UNRESOLVED**。没有对缺失许可证内容猜测。
- 判据 2：**PASS（按本卡“发布包本身带有全文”口径）**；3 个 VERIFIED 的 URL、包名/版本、SRI、源路径、完整 grant + condition + disclaimer、正文 SHA-256 已记录。**注意**：3 份来源是准确发行包 README 内直接存在的完整条款，不是独立 LICENSE 文件；正式认可该格式的审查责任属于后续集成/发行验收。
- 判据 3：**PASS**；2 个 UNRESOLVED 的准确失败事实及最小追加证据已列；对 3 份 README 内全文亦明确留下独立许可证来源的潜在审查限制；未生成任何 placeholder。
- 判据 4：**PASS**；仅改本卡结果回写，未写入或操作共享 manifest、vendor checkout、notice、Smoke、stage/afterPack 或产品代码，未执行 npm install/ci。
- **T87 严格发行门禁仍须 fail-closed；本卡没有集成新许可证、没有改变 strict gate 的 8/18 既有计数，也未宣称 installer eligible。** 其余 5 项缺失由 T90 等其他任务处理。
