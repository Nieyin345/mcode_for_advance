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


### 执行回写（2026-10-22）

**实现提交 SHA：`c3614bdca88a3911686c08961f01063bee423791`。**

#### 许可来源清单与逐项摘要

新增 `apps/desktop/build/vendor-licenses/node-red/manifest.json`（15 个版本绑定 entry、16 份 license material、1 个显式 blocker）与 `THIRD-PARTY-LICENSES.txt`。每个 entry 记录 npm registry metadata URL、tarball URL/integrity、包源 revision、SPDX expression、许可证原始文件名、license source URL/revision、material 路径与 SHA-256。聚合 notice 包含全文，并明确这是 license coverage audit、不是 SBOM。

| Package/version | SPDX | 完整文本来源 / revision | 本地全文 SHA-256 |
|---|---|---|---|
| `@node-rs/bcrypt-win32-x64-msvc@1.10.7` | MIT | [node-rs LICENSE](https://github.com/napi-rs/node-rs/blob/83ca124b3e3968c945708136d6ff68d0e0549582/LICENSE)，revision `83ca124b3e3968c945708136d6ff68d0e0549582` | `c748f2e7f93fadae76fcb1ccf6b4199e2a4013611871b5fa61000d11a50011c7` |
| `agent-base@6.0.2` | MIT | [upstream package-specific LICENSE](https://github.com/TooTallNate/node-https-proxy-agent/blob/4813885d3f4e2ff837878ceffdba656a71dc31f0/packages/agent-base/LICENSE)，license revision `4813885d3f4e2ff837878ceffdba656a71dc31f0`；package revision `c4b8ea2e1a11bae023bb09b708050a50418204e9` 的源树没有 LICENSE，manifest 明示这一差异 | `8d8c55319c7729d57be811c747452636688d54f19701ee0752b6b15ad3771d9a` |
| `boolbase@1.0.0` | ISC | [upstream LICENSE](https://github.com/fb55/boolbase/blob/54811f01c797a6bb1c263183ae90b7dd627e0638/LICENSE)，license revision `54811f01c797a6bb1c263183ae90b7dd627e0638`；精确 1.0.0 源 commit `9837d5bf4f30390ac6384a6bc605ca2d69ade4bf` 已核对版本与 ISC 声明，但该 commit 没有 LICENSE 文件 | `cdf4d87ae0a6c160227263bf4e39a0a10e30e89ae7256e0f7ac7bde0836552c6` |
| `colors@1.0.3` | MIT | [MIT-LICENSE.txt](https://github.com/Marak/colors.js/blob/e9e6557cc0fa26dba1a20b0d45e92de982f4047c/MIT-LICENSE.txt)，revision `e9e6557cc0fa26dba1a20b0d45e92de982f4047c` | `44bb8ad1e40e4f995686b99eb610f118b1a1e936b19678ecfe167fa1d78903b0` |
| `cookie-signature@1.0.6` | MIT | [official upstream LICENSE](https://github.com/visionmedia/node-cookie-signature/blob/b7bd4cb9500bfa5e696143f51d61e5f24f7a625d/LICENSE)，license revision `b7bd4cb9500bfa5e696143f51d61e5f24f7a625d`；精确 package revision `391b56cf44d88c493491b7e3fc53208cfb976d2a` 没有 LICENSE，manifest 明示差异 | `0dd4e47333485760cf8c265db5a5e24ae8d7401064c6f2e19793ee81a5bef42f` |
| `cookie-signature@1.0.7` | MIT | [official upstream LICENSE](https://github.com/visionmedia/node-cookie-signature/blob/b7bd4cb9500bfa5e696143f51d61e5f24f7a625d/LICENSE)，license revision `b7bd4cb9500bfa5e696143f51d61e5f24f7a625d`；精确 package revision `432ea0c14fbdd8d24354820faff2c6f6d2426757` 没有 LICENSE，manifest 明示差异 | `0dd4e47333485760cf8c265db5a5e24ae8d7401064c6f2e19793ee81a5bef42f` |
| `https-proxy-agent@5.0.1` | MIT | [package-specific LICENSE](https://github.com/TooTallNate/node-https-proxy-agent/blob/4813885d3f4e2ff837878ceffdba656a71dc31f0/packages/https-proxy-agent/LICENSE)，license revision `4813885d3f4e2ff837878ceffdba656a71dc31f0`；精确 package revision `d0d80cc0482f20495aa8595f802e1a9f3b1b3409` 没有 LICENSE，manifest 明示差异 | `8d8c55319c7729d57be811c747452636688d54f19701ee0752b6b15ad3771d9a` |
| `@npmcli/agent@4.0.2` | ISC | [npm-maintained ISC template](https://github.com/npm/template-oss/blob/f3ddd0d28b1456a18aac2aaa860d65c31650a2fd/LICENSE.md)，license revision `f3ddd0d28b1456a18aac2aaa860d65c31650a2fd`；精确 package revision `db7852869c74ceb8985d7c36b291a2e7a866741c` 没有完整许可文件，manifest 明示来源限制 | `27d998b503b18cdb16c49e93da04069a99ba8a1d7e18d67146de8e242f9a6d21` |
| `@sigstore/verify@3.1.1` | Apache-2.0 | [LICENSE](https://github.com/sigstore/sigstore-js/blob/c1dc7d4778a450787fc72b083f2490ad02b714c6/LICENSE)，revision `c1dc7d4778a450787fc72b083f2490ad02b714c6` | `364a130d2ca340bd56eb1e6d045fc6929bb0f9d0aa018f2c1949b29517e1cdd0` |
| `cssesc@3.0.0` | MIT | [LICENSE-MIT.txt](https://github.com/mathiasbynens/cssesc/blob/cb894eb42f27c8d3cd793f16afe35b3ab38000a1/LICENSE-MIT.txt)，revision `cb894eb42f27c8d3cd793f16afe35b3ab38000a1` | `483acb265f182907d1caf6cff9c16c96f31325ed23792832cc5d8b12d5f88c8a` |
| `postcss-selector-parser@7.1.4` | MIT | [LICENSE-MIT](https://github.com/postcss/postcss-selector-parser/blob/4a7e4e3685db8ab8e52e51ecdbe8162a8568f70c/LICENSE-MIT)，revision `4a7e4e3685db8ab8e52e51ecdbe8162a8568f70c` | `2998094b38f7ace25f141fb36f334d8338f65a1812978d618b1161f4d77ae10e` |
| `spdx-exceptions@2.5.0` | CC-BY-3.0 | [SPDX official license-list legalcode](https://github.com/spdx/license-list-data/blob/31ba1a50e5397e00a304dbadc76531740e89ee48/text/CC-BY-3.0.txt)，revision `31ba1a50e5397e00a304dbadc76531740e89ee48`；包上游没有完整 legalcode 文件，manifest 明示使用的权威 legalcode 来源 | `e6bc9e9c474700b708f568bac9e5a8a9bcb2b1dad53442f5ba449fcb848b8e76` |
| `spdx-license-ids@3.0.23` | CC0-1.0 | [SPDX official license-list legalcode](https://github.com/spdx/license-list-data/blob/31ba1a50e5397e00a304dbadc76531740e89ee48/text/CC0-1.0.txt)，revision `31ba1a50e5397e00a304dbadc76531740e89ee48`；包上游没有完整 legalcode 文件，manifest 明示使用的权威 legalcode 来源 | `a2010f343487d3f7618affe54f789f5487602331c0a8d03f49e9a7c547cf0499` |
| `type-fest@4.41.0` | `(MIT OR CC0-1.0)` | [license-mit](https://github.com/sindresorhus/type-fest/blob/68469722a9521122b6cb40376c4c4544aef28228/license-mit) + [license-cc0](https://github.com/sindresorhus/type-fest/blob/68469722a9521122b6cb40376c4c4544aef28228/license-cc0)，revision `68469722a9521122b6cb40376c4c4544aef28228`；两个许可全文均保留 | MIT `5c932d88256b4ab958f64a856fa48e8bd1f55bc1d96b8149c65689e0c61789d3`；CC0 `a2010f343487d3f7618affe54f789f5487602331c0a8d03f49e9a7c547cf0499` |
| `cli-table@0.3.11`（额外元数据缺口） | MIT override | [LICENSE](https://github.com/Automattic/cli-table/blob/8d8fcd820dac4968f301369af2543514175b0582/LICENSE)，revision `8d8fcd820dac4968f301369af2543514175b0582`；上游全文 SHA 与现有 staged package 目录 `LICENSE` 逐字节一致。仅在 package 与 lock 都缺 license 字段时应用显式 reviewed override | `ca3d2af003b3a718fc9d43e5d232955d5e089c8b5d8b01fcbe9fa26f1e76f0b0` |

**仍未解决的 package：`pause@0.0.1`。** registry metadata `https://registry.npmjs.org/pause/0.0.1` 无 license、repository、homepage、gitHead；[发布包文件列表](https://unpkg.com/pause@0.0.1/?meta) 无 LICENSE/LICENCE/COPYING。只记录 tarball integrity `sha512-KG8UEiEVkR3wGEb4m5yZkVCzigAD+cVEJck2CzYZO37ZGJfctvVptVO192MwrtPhzONn6go8ylnOdMhKqi4nfg==` 作为包来源证据，不伪造 license-file SHA、不推断 SPDX。该项在 manifest 中 `licenseExpression=null`、`status=release-blocker`，发布门禁保持关闭。

#### 实现与实际树核对

- inventory 新增 SPDX 表达式解析/未知 ID fail-closed、精确 package@version 外部许可映射、source revision/文件 SHA 校验、锁定 tarball integrity 匹配（npm bundled package 通过锁定的 npm 父包记录）、cli-table 版本绑定 override、未匹配 manifest entry/blocker 计数。
- staging 将 `licenses/node-red/manifest.json`、`THIRD-PARTY-LICENSES.txt` 和材料树复制到临时 staged tree，并在 release marker 记录 manifest/notice/tree SHA-256；afterPack 重新校验文件、整棵许可树和重算后的 inventory。未知/缺文/错版/锁源不符/元数据冲突均不能得到 `releaseEligible=true`。
- 在现有 `.tmp/node-red-release` 的**隔离副本**注入新 manifest（未改原 stage），实际 420 个 package 目录得到：15 个 reviewed mapping 命中、0 个未匹配 mapping、0 个未知 SPDX、`unknownLicenseMetadata=1`、`missingLicenseText=1`、`releaseBlockers=1`、`releaseEligible=false`；唯一阻断为 `pause@0.0.1`。T76 原 stage 与其回写均保持只读、未改。
- `node apps/desktop/scripts/run-smokes.mjs t88-node-red-license-closure-smoke`：1 suite PASS / 0 FAIL，内部 **13/13**；覆盖完整映射、blocker、未知 SPDX（manifest/包元数据）、metadata conflict、锁版本与 tarball integrity mismatch、缺文、SHA 篡改、cli-table override 篡改、420 包隔离副本与 afterPack tree tamper。
- `node apps/desktop/scripts/run-smokes.mjs t76-vendor-release-integrity-smoke`：1 suite PASS / 0 FAIL，既有 Smoke **24/24**。
- `node --check apps/desktop/build/stage-node-red-resources.cjs`、`node --check apps/desktop/build/verify-node-red-after-pack.cjs`、`node --check apps/desktop/scripts/t88-node-red-license-closure-smoke/main.cjs`：均 exit 0。
- `pnpm --filter @mcode/desktop typecheck`、`pnpm --filter @mcode/contracts typecheck`、`git diff --check`：均 exit 0。
- 变异→还原：原 `verify-node-red-after-pack.cjs` SHA-256 `d27990d1758b54c18dbde0662948d004ffaea0d86f1a2fdb2c9d0ba94cd0c30c`；临时关闭 third-party license tree digest guard 后 SHA-256 `9fbef40743c64e12f96b79fc00b171350c9078def08bd797741278904922777c`，T88 Smoke 以断言错误 exit 1（afterPack 未按预期先报 tree digest mismatch）变红；恢复后 SHA-256 回到原值 `d27990d1758b54c18dbde0662948d004ffaea0d86f1a2fdb2c9d0ba94cd0c30c`，再跑 Smoke 通过。Smoke 内同尺寸材料篡改 SHA `a615eec33aae5c6743d60016dd9da626184f1b5c7fb0216156c2fa01361b8280`，还原 SHA `8d8c55319c7729d57be811c747452636688d54f19701ee0752b6b15ad3771d9a`。
- 未执行 `npm ci`/`npm install`、真实 staging 或 installer/U1；没有宣称真实 installer 通过。

#### 验收判定 / 剩余阻断

1. **未完全达成**：15 个缺文包中 14 个已带版本级全文来源与 SHA；`pause@0.0.1` 仍无法找到权威授权与全文，所以不能满足“15 个全文全部闭环”。
2. **达成**：`pause@0.0.1` 明确为 release blocker，未伪造 SPDX 或全文。
3. **达成**：inventory/staging/afterPack 对未知、缺文、错版、篡改、元数据冲突和锁源不匹配 fail-closed；隔离副本实际 gate 仍为 false。
4. **达成**：新 Smoke、T76 回归、相关 Node 检查与双包 TypeScript 通过；未运行真实 staging/npm ci/installer。
5. **达成**：实现提交只包含本卡可写文件；本回写为后续单独提交，保留其他任务的 dirty 文件不动。
