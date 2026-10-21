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
