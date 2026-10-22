# T91｜Node-RED pause@0.0.1 许可证来源取证

| 项目 | 值 |
|---|---|
| 编号 | T91 |
| 优先级 | P1 发行阻断解除前置 |
| 来源 | T88：Node-RED 第三方许可证门禁已正确 fail-closed，唯一阻断为 `pause@0.0.1` 未能确认授权全文 |
| 目标 | 对准确的 `pause@0.0.1` 发布物取证，确认是否存在可审计的授权来源；不得推断 SPDX |
| 独占可写 | 本任务卡的结果回写区 |
| 只读范围 | `apps/desktop/build/vendor-licenses/node-red/manifest.json`、T88 任务卡、npm registry 元数据与发布包、可信上游/历史归档 |
| 禁止 | 不改 manifest、聚合 notice、staging/afterPack、package-lock、Node-RED 源码或已安装依赖；不执行 npm install/ci，不自行替换依赖，不把未知授权标成通过 |

## 执行内容

1. 先读 `audit-ledgers/README.md`、`tasks/README.md` 和 `tasks/T88-node-red-third-party-license-closure.md`，复核当前 blocker 与 tarball integrity。
2. 只调查 `pause@0.0.1` 这个精确版本：npm packument、tarball 文件列表与内容、发布者/维护者记录、仓库 URL/commit/tag、历史 GitHub archive、可靠的发行包缓存或包内版权声明。不得只因为包名相同就采用别的 pause 包。
3. 如找到授权全文，记录来源 URL、准确 revision/版本关联、源文件路径、SPDX 表达式（必须有证据）和 SHA-256；解释为何它确实适用于 `pause@0.0.1`。
4. 如找不到，写出已核实的阴性证据及尚缺的最小证据；可以提出“移除/替换依赖”的后续建议，但不得修改依赖树或在本卡执行替换。
5. 不改动 T88 的 fail-closed 行为。即使最终仍 unresolved，本卡也必须给出明确、可复查的结论。

## 验收判据

1. 对精确 `pause@0.0.1` 给出 VERIFIED 或 UNRESOLVED，不以猜测填充许可字段。
2. VERIFIED 必须有可审计的权威授权全文、准确版本关联与 SHA-256；单纯 registry metadata、相似包或通用 MIT/ISC 文本不算。
3. UNRESOLVED 必须记录检索过的来源、失败原因及解除 blocker 所需的最小证据。
4. 只修改本任务卡；不改依赖、不运行 npm install/ci，发行门禁继续 fail-closed。

## 结果回写区

<!-- 追加来源链、原始 metadata、文件列表、SHA-256、结论与 remaining。 -->

### 执行回写（2026-10-22；仅 T91 许可证来源取证）

**结论：VERIFIED（针对准确的 `pause@0.0.1`）。** 找到了发布者 TJ Holowaychuk 在 `v0.0.1` 原始 Git tag 对应提交中随包发布的 **MIT 授权全文**。授权并非位于独立的 `LICENSE` 文件，而是 `package/Readme.md` 的 `## License` 节。T88 所说“tarball 不含 LICENSE/LICENCE/COPYING 文件”确实成立，但不足以推出“无授权全文”：**原始 README 就包含授权全文**。没有根据最新版、其他同名包或通用许可证模版推断本版本许可。

#### A. npm 精确版本、发布物完整性、维护者

- 原始版本元数据：`https://registry.npmjs.org/pause/0.0.1`（HTTP 200，`name=pause`、`version=0.0.1`、`_id=pause@0.0.1`；`license`、`repository`、`homepage`、`gitHead` 均**未提供**；不能仅凭元数据证明许可证）。
- 完整 packument：`https://registry.npmjs.org/pause`；`time['0.0.1']=2012-07-19T18:00:32.141Z`、`time.created=2012-07-19T18:00:30.666Z`。注意 packument 当前顶层 MIT/repository 反映后续版本，**未作为 0.0.1 授权依据**。
- 精确 tarball：`https://registry.npmjs.org/pause/-/pause-0.0.1.tgz`，HTTP 200，1459 字节；实算 SHA-256 `d37b84046db0c28c9768be649e8f02bd991ede34b276b5dba7bade23b523235e`，SHA-1 `1d408b3fdb76923b9543d96fb4c9dfd535d9cb5d`，SHA-512 SRI `sha512-KG8UEiEVkR3wGEb4m5yZkVCzigAD+cVEJck2CzYZO37ZGJfctvVptVO192MwrtPhzONn6go8ylnOdMhKqi4nfg==`，与 registry `dist`、现有 T88 blocker 精确一致。
- 原始版本 `author` 为 `TJ Holowaychuk <tj@vision-media.ca>`，`maintainers` 只有 `tjholowaychuk`，`description="Pause streams..."`，`main="index"`，运行时 `dependencies={}`，`devDependencies={mocha:"*",should:"*"}`。这里不存在指向仓库的发布时元数据；下节采用原作者本人签署的 tag + 字节核验建立来源关系。

registry 精确版本的原始 JSON（响应内容，未更正或补猜许可字段）：

```json
{"dist":{"shasum":"1d408b3fdb76923b9543d96fb4c9dfd535d9cb5d","tarball":"https://registry.npmjs.org/pause/-/pause-0.0.1.tgz","integrity":"sha512-KG8UEiEVkR3wGEb4m5yZkVCzigAD+cVEJck2CzYZO37ZGJfctvVptVO192MwrtPhzONn6go8ylnOdMhKqi4nfg==","signatures":[{"sig":"MEUCIB/3fztZPNH4X2gIagkv/5jFhFuGBm+gex5sEBsUFimHAiEAx9hRU3IIosHLdwbd+aLxVOfP3j0jDSbavFmBPQEHIdg=","keyid":"SHA256:jl3bwswu80PjjokCgh0o2w5c2U4LhQAE57gj9cz1kzA"}]},"main":"index","name":"pause","author":{"name":"TJ Holowaychuk","email":"tj@vision-media.ca"},"keywords":[],"description":"Pause streams...","maintainers":[{"name":"tjholowaychuk","email":"tj@vision-media.ca"}],"dependencies":{},"devDependencies":{"mocha":"*","should":"*"},"_id":"pause@0.0.1","version":"0.0.1"}
```

#### B. tarball 内实际文件与逐文件 SHA-256（内存中 gunzip + tar 枚举）

| tarball 内路径 | size (bytes) | SHA-256 |
|---|---:|---|
| `package/package.json` | 254 | `a731c9ebcfbbcc7028e2283d13c64e50df24799c792130e9f5cbcd401a4f4e92` |
| `package/.npmignore` | 29 | `083b765409c2fe14fa2382834cccf719bfcdbc2ff9a90be37d229038e1d0eeae` |
| `package/index.js` | 595 | `3de77f38a2ab5db028c016059d74c1735c93410a9cbd34f6c889b5b639c5933d` |
| `package/History.md` | 60 | `ad458ba179b55baebf93d3bea062f486e4b74fa659ee6c040597d30105149091` |
| `package/Makefile` | 89 | `48ca2ff6176c1b55924240627001ac1f7f13fcae94231671b128c94f8ad7f8bf` |
| **`package/Readme.md`** | **1146** | **`d568e8932b83f0ae0799a3ff43b2ddd8940b5afd0ad33e70d9226a63c3a8505d`** |

**阴性事实（已解释）**：确无单独 `LICENSE` / `LICENCE` / `COPYING`；但是 `Readme.md` 有完整 MIT 条款，不是只有 SPDX 代号。原 `Readme.md` 保留原作者邮件的 `&lt;` / `&gt;` HTML 转义；重新排版/解码会改变材料哈希，若日后复制许可全文必须保留版权行和全部条件。

#### C. 权威上游 revision 与精确版本关联（双向证据链）

1. 原始上游仓库：`https://github.com/stream-utils/pause`（历史来源 `visionmedia/node-pause`，但**不依赖**后来的仓库元数据证明准确版本）。
2. **原始 annotated tag `v0.0.1`**：`https://api.github.com/repos/stream-utils/pause/git/refs/tags/v0.0.1` 指向 tag object `2d97aade35125ba0868be19fe36f0cdb82823f80`；tag object `https://api.github.com/repos/stream-utils/pause/git/tags/2d97aade35125ba0868be19fe36f0cdb82823f80` 标明 tagger **TJ Holowaychuk**、日期 **2012-07-19T18:00:26Z**、message `0.0.1`，指向 commit **`11d0dcaca51ee8cdf09915be0ba14c41871009b5`**，与 npm 发布时间相距数秒。
3. **授权全文原始来源**：`https://github.com/stream-utils/pause/blob/11d0dcaca51ee8cdf09915be0ba14c41871009b5/Readme.md`，源文件 `Readme.md` 的 `## License` 段，明示 `(The MIT License)`、`Copyright (c) 2012 TJ Holowaychuk` 和完整授权、保留声明、免责声明。原 commit 的 `package.json` 明示 `"name":"pause","version":"0.0.1"`。
4. **字节级匹配**：从该 GitHub **精确 commit** 的 Contents API 取得 `Readme.md`、`index.js`、`package.json`，分别与 verified npm tarball 的同路径文件进行 Buffer byte-for-byte 比较，三项均 **true**；README SHA-256 = `d568e8932b83f0ae0799a3ff43b2ddd8940b5afd0ad33e70d9226a63c3a8505d`、`index.js` = `3de77f38a2ab5db028c016059d74c1735c93410a9cbd34f6c889b5b639c5933d`、`package.json` = `a731c9ebcfbbcc7028e2283d13c64e50df24799c792130e9f5cbcd401a4f4e92`。这是原发布物本身的授权，不是事后把另一个版本的许可证套过来。
5. 交叉复核（非必要证据）：官方后续 commit `a5e724899490d2dad8be40c815af8acc40d8fee5` 于 2015-07-01 将 `license: "MIT"` 加入 `package.json`；随后 `7d05c8ad83cf8887ca878c587d6e8987869443c6` 将 README 许可移入正式 `LICENSE` 文件，SHA-256 `4fc9e2fc9c86bb5eb4e3a80244aa3e85d34096a7e1fdddf023ead18295cfd2a4`，其修改 diff 保留原版权条款。这不是版本绑定主证据；主证据仍是 **v0.0.1 README 与 npm 原包完全一致**。

**结论字段**：`package=pause`；`version=0.0.1`；`status=VERIFIED`；`SPDX=MIT`（原 `Readme.md` 明示 MIT）；`licenseSourceRevision=11d0dcaca51ee8cdf09915be0ba14c41871009b5`；`licenseSourceFile=Readme.md#License`；`packageLicenseMaterial=package/Readme.md`；`packageLicenseMaterialSha256=d568e8932b83f0ae0799a3ff43b2ddd8940b5afd0ad33e70d9226a63c3a8505d`。若需要对提取的 `## License` 节而不是完整 README 单独审计，按 UTF-8、截取该段到 EOF 并 `trim()` 后的 SHA-256 为 `0227b62b5ea9cf05a0e0f828c5e29138f4c36a233e38574d8ccc956e0e5147dd`（长度 1116 bytes；与原始文件 SHA 不可混用）。

#### D. 验收与 remaining

- **T91 判据 1：达成**。确定性结论 VERIFIED，没有猜测授权字段。
- **T91 判据 2：达成**。原作者原 tag 所含 MIT 全文、版本关联、原始 tarball 与上游文件逐字节相等、材料 SHA-256 均已核验。
- **T91 判据 3：不适用**。该项只针对 UNRESOLVED。
- **T91 判据 4：达成（本卡操作范围）**。所有下载/解压/哈希在 `node -e` 内存内完成；未执行 `npm install` / `npm ci`，未修改依赖、缓存文件、共享 manifest、聚合 notice、Node-RED checkout 或发行脚本。唯一写入为本任务卡的追加回写。
- **remaining（发行）**：现有 `apps/desktop/build/vendor-licenses/node-red/manifest.json` 中 `pause@0.0.1` 依然 `release-blocker`、`licenseExpression=null`，T88 原门禁仍 **fail-closed / releaseEligible=false**。后续由 T88/发行负责方依据本回写另行审查、导入精确版本 MIT 材料并复跑门禁；**本 T91 未解除/修改产品门禁，不能因此宣称 installer 已可发行**。
