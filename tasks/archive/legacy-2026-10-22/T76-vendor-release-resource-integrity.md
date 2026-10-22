# T76｜GenOffice + Node-RED 打包资源、上游来源与依赖许可证完整性门禁

| 项目 | 值 |
|---|---|
| 编号 | T76 |
| 工作包 | FULL-0/FULL-5；ARC-006/007 安装版本真实性 |
| 优先级 | P1，高于装饰性 UI 优化 |
| 路线 | L1 上游 LICENSE/NOTICE/版本与原厂构建产物 + L2 Mcode 既有资源 Staging/Verify 脚本 |
| 可派 | **第一批补充并行**，只测临时打包资源；不和另一完整 installer 构建同时运行 |
| 独占可写 | `apps/desktop/build/stage-genoffice-resources.cjs`、`stage-node-red-resources.cjs`、`verify-genoffice-editors-after-pack.cjs`、`verify-node-red-after-pack.cjs` 中必要最小差异、新建 `apps/desktop/scripts/t76-vendor-release-integrity-smoke/`、本任务卡 |
| 禁写 | `apps/desktop/scripts/release-readiness-smoke/*`（当前 dirty）、`electron.vite.config.ts`（T73）、`electron-builder.yml`、`genoffice/**`、`node-red/**`、`main/modules/*`、`main/appControl/*` |


## 已核实背景
现有 `build/stage-genoffice-resources.cjs` 已预检 CLI、PDFium WASM、六原厂 renderer、Sheets/Slides preload、Rust xlsx-sidecar 和 GenOffice/PDFium LICENSE/NOTICE；`build/stage-node-red-resources.cjs` 固定 Node-RED 5.0.8 源 commit `935b8d3e12ec8be064f3a72ac6547131f778a7b1` 并写 manifest；各有打包后 verify。尚不能仅凭 staging 脚本存在就证明 **真实最终 installer** 的二进制、sidecar、依赖树和第三方许可都完整，尤其 Node-RED 生产依赖目录里的各依赖许可证未见一张逐项证据表。本卡先查确凿缺口再最小加固。

## 开工前必读
1. `audit-ledgers/README.md` 与统一台账 2026-10-20 FULL-0/FULL-5 资源/上游/许可门禁。
2. 上述四份 build 脚本与 `apps/desktop/scripts/genoffice-editors-release-smoke/`、`release-readiness-smoke/`、`apps/desktop/electron-builder.yml`（后三者只读）。
3. `genoffice/LICENSE`、`genoffice/NOTICE`、`node-red/LICENSE`、`node-red/package-lock.json`，及实际资源阶段的 `availability.json`/manifest 格式。
4. 当前正在修改的 `release-readiness-smoke/check-reviewed.cjs` 与模块 T49 未提交工作树；不使用这些文件的混合修改去宣告安装版本通过。

## 执行内容
1. 对六 Editor 原生资源、CLI/wasm/Sidecar、Node-RED 编辑器/运行时/Node 包分别做“上游版本/许可证/源 SHA → staging 路径 → afterPack 路径 → 可验证运行条件”矩阵。
2. 在**隔离的临时输出**做当前验证器的负控：删原生 sidecar、替换 renderer JS、改 Node-RED version/hash、删除 LICENSE/NOTICE、制造符号链接逃逸与不可读资源，验证现有 checker 是否有不安全漏判；绝不修改真实 vendor、现有用户安装包或 `node_modules`。
3. **只修能够证明的漏检**，在原四份构建/验证脚本中增加小而稳定的边界断言与专项 Smoke。不得靠在打包前临时伪造 placeholder 文件使测试绿。
4. 调查 Node-RED 发布版第三方直接/传递依赖的授权说明。若缺可合法打包的许可资源，**报告确切 package 和前置**，除本次 Staging 脚本范围外不搬运未经确认版权文件；不得声称已经完成 SBOM。
5. 若全量 installer 非当前机器/资源可用，单独记录“产物级不可验证”；已有 staging 模拟通过不替代真实 Win/macOS/Linux 安装 U1。此卡原则不执行 `npm ci` 修改上游/外部依赖树或危险构建；必要依赖缺失则停工并回写。

## 验收判据
1. 资源矩阵涵盖六格式 CLI/编辑器/wasm/sidecar、Node-RED 运行时/编辑器/Node pack、LICENSE/NOTICE 与源 SHA；未覆盖明确标记。
2. 每项关键缺失/篡改/越界负例被**实际现有 staging/afterPack 检查**拒绝，并证明不影响前次完整 stage；至少两项撤离检查→断言必红的变异。
3. 有文件漏检时补最小检查且不更改上游构建产物内容；其它已存在行为不回归。
4. 原有 `genoffice-editors-release-smoke`、相关 packaging/verifier tests 与双包 TS 按实际可用性运行，命令/结果/日志记录完整，不能谎报未跑的 installer。
5. 许可证调查对可追溯的 upstream/第三方明确给出已收集/未知/不可分发状态，不把 README 声明当已包含完整许可证。
6. 只提交自己有权写的 build 验证/测试文件；保留 T49 和 release-readiness 在飞差异，错误关联须交回总控拆卡。

## 不做
不发联网 npm install、用户生产包重签名、改版本号伪造成品、改 Electron 构建入口或上游 Node-RED/GenOffice 内核、不改 T73/T64/T65 范围。

## 结果回写区

<!-- 只在下面追加：提交 SHA、旧红→新绿、原始命令/日志、变异/还原字节、剩余未验；不得覆盖本任务正文。 -->

### 执行回写（2026-10-21）

**实现提交 SHA：`ab9149ebc9f7b3e9e1580260a0ebc1d38ed455f7`。**

#### 资源与来源矩阵

| 资源 | 上游版本 / 许可 / SHA | Staging 路径 | afterPack 路径与可验证条件 | 当前状态 |
|---|---|---|---|---|
| GenOffice Docs renderer | 上游锁声明 Apache-2.0；锁定 revision `73ba918083b5e2bedff7633925c3d7f625e04449` | `.tmp/genoffice-release/apps/docs/out/renderer` | `resources/genoffice/apps/docs/out/renderer`；索引引用、资源树 SHA-256 | 合成临时包通过；真实上游 pin 未通过 |
| GenOffice Sheets renderer | 同上 | `apps/sheets/out/renderer` | 同路径复制至 `resources/genoffice`；资源树 SHA-256 | 合成临时包通过；真实上游 pin 未通过 |
| GenOffice Slides renderer | 同上 | `apps/slides/out/renderer` | 同路径复制至 `resources/genoffice`；资源树 SHA-256 | 合成临时包通过；真实上游 pin 未通过 |
| GenOffice PDF renderer | 同上 | `apps/pdf/out/renderer` | 同路径复制至 `resources/genoffice`；资源树 SHA-256 | 合成临时包通过；真实上游 pin 未通过 |
| GenOffice Markdown renderer | 同上 | `apps/markdown/out/renderer` | 同路径复制至 `resources/genoffice`；资源树 SHA-256 | 合成临时包通过；真实上游 pin 未通过 |
| GenOffice HTML renderer | 同上 | `apps/html/out/renderer` | 同路径复制至 `resources/genoffice`；资源树 SHA-256 | 合成临时包通过；真实上游 pin 未通过 |
| Sheets/Slides preload | GenOffice 同一上游 pin | `apps/{sheets,slides}/out/preload` | `resources/genoffice/apps/{sheets,slides}/out/preload`；要求真实 `index.js`、目录链无链接、整树 SHA-256 | 删除、同尺寸篡改及源路径 junction 负例均拒绝 |
| GenOffice CLI 与依赖 | GenOffice 同一上游 pin / Apache-2.0 | `cli/genoffice.cjs`、`cli/node_modules` | `resources/genoffice/cli`；CLI 文件和依赖树 SHA-256 | 合成包通过；未执行 CLI 的真实安装运行 |
| PDFium WASM | GenOffice 随附 PDFium 许可文件 | `wasm/pdfium.wasm` | `resources/genoffice/wasm/pdfium.wasm`；WASM magic + 全文件 SHA-256 | 同尺寸内容篡改和非普通文件负例均拒绝 |
| Sheets xlsx-sidecar | GenOffice Sheets native build 输出；Windows 使用 `xlsx-sidecar.exe`，其他平台使用 `xlsx-sidecar` | `native/<sidecar>` | `resources/genoffice/native/<sidecar>`；必须是非空普通文件并与 staging SHA-256 相同 | 缺失、同尺寸篡改均拒绝；失败 staging 保留前一完整 stage |
| GenOffice/PDFium LICENSE/NOTICE | `genoffice/LICENSE` 为 Apache-2.0；`genoffice/NOTICE` 存在；另有 PDFium 两份 license 文件 | `licenses/{GenOffice-LICENSE,GenOffice-NOTICE,PDFium-LICENSE,PDFium-LICENSE.pdfium}` | `resources/genoffice/licenses`；versioned license digest manifest | 合成 v1/v2 bundle 通过；真实完整 notice 有缺口，见下文 |
| Chromium / GenOffice third-party notices | Chromium 许可取自与 app 中 Electron 版本匹配的 `LICENSES.chromium.html`；strict opt-in 要求第三方 notice 完整 | `licenses/LICENSES.chromium.html`、`licenses/GenOffice-THIRD-PARTY-NOTICES.txt` | `resources/genoffice/licenses`；strict bundle v2 要求六个许可文件及 SHA-256，校验 Electron 版本 | 合成 strict v2 通过；真实 notice 被完整性门禁拒绝 |
| Node-RED runtime/editor/Node 包 | Node-RED 5.0.8；上游 Git SHA `935b8d3e12ec8be064f3a72ac6547131f778a7b1`；根 `LICENSE` 为 Apache-2.0；上游根目录无 `NOTICE` 文件 | `packages/node_modules/node-red`、`packages/node_modules/@node-red/{runtime,editor-api,editor-client}`、`node_modules` | `resources/node-red`；runtime/editor tree 与 production dependency tree SHA-256、包版本、editor JS、lockfile、根 LICENSE | 合成完整包通过；真实 staged 产物旧 manifest，未重打包验证 |
| Node-RED 第三方许可覆盖 | `package-lock.json` 锁定依赖；inventory 明确为 coverage audit，**不是 SBOM** | `third-party-license-inventory.json` | `resources/node-red/third-party-license-inventory.json`；afterPack 重新扫描实际包、许可文本和摘要；覆盖不完整则阻断发布 | 420 个实际包目录中 15 个缺许可文本，2 个许可元数据未知，`releaseEligible=false` |

#### 许可调查与明确阻断项

- GenOffice 锁期望 SHA 为 `73ba918083b5e2bedff7633925c3d7f625e04449`，当前 `genoffice/` 实际 HEAD 为 `355e667353ad90da7d0b3c6823fad0f525b729c3`；当前 checkout 干净，但 `node apps/desktop/build/verify-genoffice-upstream.cjs` 在 `MCODE_INCLUDE_GENOFFICE_BUNDLE=1` 下以 commit mismatch 退出。未擅自改锁或 vendor 源码。
- 当前 GenOffice `apps/shell/build/THIRD-PARTY-NOTICES.txt` 共 570 个版本化 section，其中 **18 个缺完整 license text**：`@electron-internal/extract-zip@1.0.5`、`@napi-rs/canvas-win32-x64-msvc@1.0.3`、`@nodable/entities@3.0.0`、`@univerjs/protocol@0.25.1`、`emoji-regex@8.0.0`、`fastdom@1.0.12`、`franc-min@6.2.0`、`hash.js@1.1.7`、`is-potential-custom-element-name@1.0.1`、`isarray@1.0.0`、`lazy-val@1.0.5`、`ot-json1@1.0.2`、`ot-text-unicode@4.0.0`、`punycode@2.3.1`、`react-remove-scroll-bar@2.3.8`、`saxes@6.0.0`、`strictdom@1.0.1`、`unicount@1.1.0`。这些 section 虽列出 SPDX 标签，但标签不是许可证全文。strict bundle gate 正确拒绝；前置是从对应准确上游版本获取并核验完整许可文本，再从 pinned clean source 重生成 notice，不造 placeholder。
- Node-RED 实际生产依赖缺少 license text 的 15 项：`@node-rs/bcrypt-win32-x64-msvc@1.10.7` (MIT)、`agent-base@6.0.2` (MIT)、`boolbase@1.0.0` (ISC)、`colors@1.0.3` (MIT)、`cookie-signature@1.0.6` (MIT)、`cookie-signature@1.0.7` (MIT)、`https-proxy-agent@5.0.1` (MIT)、`@npmcli/agent@4.0.2` (ISC)、`@sigstore/verify@3.1.1` (Apache-2.0)、`cssesc@3.0.0` (MIT)、`postcss-selector-parser@7.1.4` (MIT)、`spdx-exceptions@2.5.0` (CC-BY-3.0)、`spdx-license-ids@3.0.23` (CC0-1.0)、`pause@0.0.1` (license unknown)、`type-fest@4.41.0` (MIT OR CC0-1.0)。
- Node-RED 许可元数据未知的两项为 `cli-table@0.3.11`（目录有许可文件，但包/lock 元数据未声明许可）与 `pause@0.0.1`（既无许可元数据，也无许可文本）。不得仅凭 SPDX 缺省或 README 推定许可。前置：为上述缺文包补入从准确上游版本确认的许可文件；为 `cli-table`、`pause` 查证准确来源与授权，若无法确认则移除/替换依赖或阻断发行。Node-RED 源 checkout SHA 与固定版本一致且干净；当前 `.tmp/node-red-release` 是旧 manifest，尚无本次新增的 inventory/tree digest 字段。未运行 staging 脚本，因为它会触发 `npm ci`；未改 `node-red/**` 或现有 `node_modules`。

#### 旧红 → 新绿、命令与变异记录

- `node --check apps/desktop/build/stage-genoffice-resources.cjs && node --check apps/desktop/build/stage-node-red-resources.cjs && node --check apps/desktop/build/verify-genoffice-editors-after-pack.cjs && node --check apps/desktop/build/verify-node-red-after-pack.cjs && node --check apps/desktop/scripts/t76-vendor-release-integrity-smoke/main.cjs`：exit 0。
- `node apps/desktop/scripts/t76-vendor-release-integrity-smoke/main.cjs`：**24/24 PASS**。覆盖六 renderer、CLI/依赖树、PDFium、Sheets sidecar、preload、严格 v2 六文件许可包、Node-RED runtime/editor/生产依赖树、LICENSE/manifest/version、符号链接逃逸和源 stage 原子保留。
- `node apps/desktop/scripts/run-smokes.mjs t76-vendor-release-integrity-smoke`：1 pass / 0 fail；`node apps/desktop/scripts/genoffice-editors-release-smoke/main.cjs`：25/25 PASS；`node --test apps/desktop/scripts/run-smokes.test.mjs`：12/12 PASS。
- `pnpm --filter @mcode/desktop typecheck`、`pnpm --filter @mcode/contracts typecheck`：均 exit 0。
- 变异 1：临时禁用 GenOffice CLI SHA-256 guard，专项 smoke 以 `AssertionError: Missing expected exception` 变红；在 `finally` 中恢复原 guard，再运行完整 smoke 通过。
- 变异 2：临时禁用 Node-RED production dependency tree SHA-256 guard，专项 smoke 在依赖文件篡改断言处以 `AssertionError: Missing expected exception` 变红；精确恢复原 guard，再运行完整 smoke 通过。
- 全量 installer / Win、macOS、Linux 真实安装 U1 未运行；按任务要求只测临时资源，不把模拟 afterPack 当成品验证。当前 GenOffice pin mismatch、18 个 notice 缺全文及 Node-RED 15 个缺文 / 2 个未知元数据都是明确的发行阻断/前置，不宣称发布许可完整。

#### 尚未完成 / 后续前置

1. 先由上游维护者确认当前 GenOffice HEAD 与已审查 lock revision 的关系；未经审查不能自动改 lock。
2. 补齐 GenOffice 18 个 notice section 的准确许可全文后，在 pinned clean checkout 重新生成并复验 strict bundle。
3. 为 Node-RED 15 个缺文包补入可追溯许可文本，查证 `cli-table@0.3.11`、`pause@0.0.1` 的授权；重新运行 Node-RED staging（需明确允许其在临时目录执行 `npm ci`）后再做真实 afterPack。
4. 真实 installer 与安装后 U1 仍未验；当前 staged Node-RED 资源旧于新 manifest schema，不能作为新门禁的通过证据。


### 总控复核补充（2026-10-22）：GenOffice pin mismatch 的真实原因与后续任务

- 进一步只读检查确认：lock 中的 `baseRevision=cbec600ace9c930b2646b6739cf6df3741bb9d6a`，第一条已审查补丁为 `73ba918083b5e2bedff7633925c3d7f625e04449`；当前 `genoffice` HEAD `355e667353ad90da7d0b3c6823fad0f525b729c3` 是该补丁之后的 **12 个 Mcode integration commits**，并且仓库有对应 `patches/genoffice/0001..0012` 文件，nested checkout 干净。
- 因此不能直接回退到 `73ba...`，也不能仅把锁 SHA 改成 `355e...`。现有 `verify-genoffice-upstream.cjs` 的 lineage schema 只描述单一 `approvedPatch`，未描述 12 个后续 patch series；后续应验证“批准的上游基线 + 第一条已审查补丁 + 精确的 12 个 Mcode patch + 预期最终 HEAD/tree”，并在临时副本重放 patch 栈证明可重现。这个后续任务为 **T87**。
- Node-RED 的许可证覆盖独立归入 **T88**，可与 T87 并行；两张卡分别拥有自己的 staging/verifier 文件和独立 Smoke，不共享修改 T76 原 Smoke。两卡通过前不得执行真实 installer，不得把模拟 staging 记成发行验收。
