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
