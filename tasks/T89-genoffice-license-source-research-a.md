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
