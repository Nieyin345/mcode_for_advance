# T88｜Node-RED 生产依赖第三方许可证覆盖闭环

| 项目 | 值 |
|---|---|
| 编号 | T88 |
| 来源 | T76：Node-RED production dependency license inventory |
| 优先级 | P1；真实发布资源的前置门禁 |
| 依赖 | T76 审计完成；可与 T87 并行 |
| 目标 | 让锁定的 Node-RED 5.0.8 生产依赖树中每个实际包都有可追溯的完整许可证材料与可核验授权元数据；未知项不得被标成 release-eligible |
| 独占可写 | apps/desktop/build/stage-node-red-resources.cjs、apps/desktop/build/verify-node-red-after-pack.cjs、新增 apps/desktop/build/vendor-licenses/node-red/**、新增 apps/desktop/scripts/t88-node-red-license-closure-smoke/**、本任务卡 |
| 仅只读 | node-red/**、node-red/node_modules/**、apps/desktop/scripts/t76-vendor-release-integrity-smoke/**、apps/desktop/build/stage-genoffice-resources.cjs、verify-genoffice-editors-after-pack.cjs、verify-genoffice-upstream.cjs、genoffice/**、patches/genoffice/**、electron-builder.yml、release-readiness-smoke/**、main/modules/**、main/appControl/** |
| 禁止 | 不执行 npm ci / npm install；不改上游 Node-RED checkout 或已有 node_modules；不伪造许可文本、不把 SPDX 标签当全文、不因未知许可而强行放行 |

## T76 已确认的缺口

Node-RED 5.0.8 上游 SHA 固定为 935b8d3e12ec8be064f3a72ac6547131f778a7b1。T76 对实际 production dependency inventory 发现：

- 缺少完整许可证文本的 15 个 package/version：
  1. @node-rs/bcrypt-win32-x64-msvc@1.10.7（MIT）
  2. agent-base@6.0.2（MIT）
  3. boolbase@1.0.0（ISC）
  4. colors@1.0.3（MIT）
  5. cookie-signature@1.0.6（MIT）
  6. cookie-signature@1.0.7（MIT）
  7. https-proxy-agent@5.0.1（MIT）
  8. @npmcli/agent@4.0.2（ISC）
  9. @sigstore/verify@3.1.1（Apache-2.0）
  10. cssesc@3.0.0（MIT）
  11. postcss-selector-parser@7.1.4（MIT）
  12. spdx-exceptions@2.5.0（CC-BY-3.0）
  13. spdx-license-ids@3.0.23（CC0-1.0）
  14. pause@0.0.1（license unknown）
  15. type-fest@4.41.0（MIT OR CC0-1.0）
- cli-table@0.3.11 的包目录存在 LICENSE，但 package/lock 元数据未声明许可；必须核对许可证文件全文和准确来源，不能仅凭文件名判定。
- pause@0.0.1 同时缺少许可证元数据与许可文本。只有查到准确版本的权威许可材料，或通过另行审查的依赖替换消除它，才能关闭该项。
- T76 的 420 个实际包目录覆盖报告是 license coverage audit，**不是 SBOM**；本卡不能将其改名或夸大成 SBOM。

## 执行内容

1. 完整阅读 audit-ledgers/README.md、tasks/README.md、T76 任务卡与当前两个 Node-RED staging/afterPack 脚本。保留 T76 原始回写，不改共享 T76 Smoke。
2. 对上面每个精确 package@version 从该版本的官方发行包、上游仓库 tag/commit 或其他可核验权威源取得许可证全文；逐项记录来源 URL、版本、SPDX 表达式、原始文件名、SHA-256。不得联网执行 npm install；可只读检查现有锁文件、缓存与包目录。
3. 将经审查的全文放入 Mcode 管理的 apps/desktop/build/vendor-licenses/node-red/，用 manifest 显式绑定 package name + version + license expression + source URL + source revision + local file SHA-256。对于多许可表达式（例如 type-fest@4.41.0），按上游声明保留准确表达式并收集足够的全文，不擅自选择对项目更方便的许可。
4. 更新 staging inventory，使它可把经审核的外部许可材料映射到准确 package@version，并在**临时 staged tree** 中携带必要的许可文本/聚合 notice；不要改 node-red/** 或真实 node_modules。重新计算依赖树与 inventory 摘要，保证 afterPack 校验的是最终实际打包树和随包许可材料。
5. cli-table@0.3.11 的元数据可仅在核实完整 LICENSE 后通过显式、版本绑定的审查 override 补齐，并记录证据。对 pause@0.0.1，若权威源仍无法确认，必须保持 releaseEligible=false，列出阻断项；不得写入猜测的 SPDX 许可，也不得为了绿灯静默删包。若确认必须替换/移除依赖，停下并写明最小后续任务及其影响面。
6. 新增独立 t88-node-red-license-closure-smoke，用隔离 fixture 覆盖：每个 package 的准确版本映射、许可全文缺失/篡改、未知 SPDX、元数据冲突、锁版本不匹配、许可材料哈希错误；任一未知项必须 fail-closed。测试不得依赖真实用户数据或改变真实 Node-RED checkout。
7. 运行新增 Smoke、现有 Node-RED afterPack/资源验证可隔离执行的测试、相关 node --check 和双包 TypeScript 检查。由于当前 staging 会触发 npm ci，本卡不得运行实际 staging 或真实 installer；如必须靠真实生产依赖树复验，记录命令与所需审批，留给后续发行验收卡。

## 验收判据

1. 15 个缺文 package 的真实许可全文全部有版本级来源与 SHA；cli-table 的许可元数据问题有权威证据及显式审查记录。
2. pause@0.0.1 已有可验证授权与全文，或仍被明确标为 release blocker；不能将未知状态写成 PASS。
3. 最终 staging/inventory/afterPack 的逻辑只在所有实际 package 与许可证材料匹配时才设置 releaseEligible=true；未知、缺文、错版、篡改、元数据冲突负例必红。
4. 新 Smoke、可隔离执行的 Node-RED 回归与双包 TypeScript 通过；真实 staging、npm ci、installer/U1 不宣称通过。
5. 只提交本卡可写文件；结果回写包含 SHA、每个包的证据来源/摘要、测试命令/日志、变异与还原 hash、剩余发布阻断。

## 不做

不改 Node-RED 上游源代码、package-lock.json 或已安装依赖；不动 GenOffice 相关文件；不运行联网安装或真实 installer；不以测试替代法律来源核实。

## 结果回写区

<!-- 只追加：提交 SHA、license source manifest、覆盖计数、命令/日志、变异/还原和 remaining。 -->
