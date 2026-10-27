# T13｜Node-RED 5.0.8 原生源码 vendor 集成调查与施工地图

> 2026-10-21。证据等级：上游固定源码及 Mcode 当前源码 **E2**；本机依赖安装/构建/模块解析/差异实验 **E1**；未来 installer、真 Electron 编辑链 **E3（尚未实施）**。这是一份**调查方案，不是完成声明**。

## 目标、不可变边界与结论

**结论：可行，但不能仅将源码复制到 resources 后就删除旧画布。** 固定上游 `https://github.com/node-red/node-red.git`，版本 **5.0.8**，tag/commit **`935b8d3e12ec8be064f3a72ac6547131f778a7b1`**；此版本也是 Mcode 台账已锁定的版本。由一份独立的 `node-red/` Git checkout + `mcode/integration` 小补丁维护，以原版 `@node-red/editor-client` 作**唯一画布**、原版 Node-RED runtime 作唯一执行/触发内核、原版 storageModule + Mcode Host 身份/CAS 作单一存储。继续坚持唯一真人审批/执行归属/Agent 入口，绝不让 vendor 自行决定权限。

本次**只在 `.tmp/T13-node-red-5.0.8/` 克隆及实验**，没有创建正式 `node-red/`，未改 `apps/desktop/src/**`、`genoffice/` 或手写画布。实施 vendor、许可清单与安装包增量在后续经用户确认的卡片完成。

**T19 已 vendor（2026-10-21）**：根目录 `node-red/` 为独立 Git checkout，`mcode/integration` 分支，HEAD `935b8d3e12ec8be064f3a72ac6547131f778a7b1`（Node-RED 5.0.8，Apache-2.0）；主 Git 通过 `/node-red/` 忽略该目录。打包由 `apps/desktop/build/stage-node-red-resources.cjs` 从固定版本构建，独立安装 production-only 依赖并 stage 到 resources；不得以此声明 ARC-006 整包交付。

## 一、上游逐项取证（固定 5.0.8）

| 要回答的事实 | 现场观察 / 命令输出 | 可核查的上游证据 |
|---|---|---|
| 上游、最新稳定版本与固定提交 | `git ls-remote --tags --refs https://github.com/node-red/node-red.git "5.*"` 显示末尾正式 tag 为 **5.0.8**，OID `935b8d3...`；`git clone --depth 1 --branch 5.0.8` 与 `git rev-parse HEAD` 同值；没有追踪 `main` | 根 `package.json:2-10`（`version: 5.0.8`、仓库地址）；`git tag --points-at HEAD` 回显 `5.0.8` |
| 许可证/二开 | **Apache-2.0，允许修改、商业集成及再分发**；再分发须保留 LICENSE/NOTICE、版权和修改声明，第三方依赖单独核验；`git ls-tree -d HEAD` 仅 `.github`、`packages`、`scripts`、`test`，**本 tag 无 `ee/` 或 `enterprise/` 源码目录**，不等于所有依赖自动同许可证 | `LICENSE:68-73,91-109`；根 `package.json:6`；`packages/node_modules/{node-red,@node-red/editor-client}/package.json:license`；`README.md:83-85` |
| 编辑器如何构建 | **不需 webpack**：根 `npm run build` → `node scripts/build`，内部 **clean→jsonlint→concat→copy→sass→esbuild minify→attachCopyright**；一次命令含多个阶段。**本机实测构建 2.17 秒（脚本自报 1543 ms）**，`npm ci` 初装 **21.87 秒**，两者均 exit 0 | 根 `package.json:14`、`README.md:44-63`；`scripts/build/index.js:9-33`、`scripts/build/config.js:19-98,134-156`、`scripts/build/minify.js`、`scripts/build/sass.js`；`.tmp/T13-benchmark.ps1` 输出 |
| 入口、源码包关系 | `require("node-red")` 最终定位 `packages/node_modules/node-red/lib/red.js`（**不是** `red.js` CLI）；它 require `@node-red/runtime`、`@node-red/util`、`@node-red/editor-api`，其 package.json 还依赖 `@node-red/nodes`、`express` 等；`node-red/red.js` 是 CLI | `packages/node_modules/node-red/package.json:11,33-45`；`lib/red.js:20-24,50-90` |
| workspace 目录/链接 | `packages/node_modules/{node-red,@node-red/editor-api,@node-red/runtime,@node-red/nodes,@node-red/registry,@node-red/util,@node-red/editor-client}` 全是 **真实 directory，均非 symlink**（`fs.lstatSync`）；项目 `node_modules/` 提供外部 npm 依赖。直接从数据目录的 bootstrap require 时默认**找不到**上游源码：必须明确配置 `NODE_PATH=<vendor>/packages/node_modules;<vendor>/node_modules`，或生成受控 resolver | `node -e` 对上述七包进行 `lstatSync/isSymbolicLink/require.resolve({paths:[base]})` 均 green；隔离解析红/绿见下文 |
| Node 要求 / Electron | root 与内部 `node-red/package.json` 均要求 `engines.node: ">=22.9"`；Mcode `runtimeSupervisor.ts:604` 下限 22.9.0；当前 Electron **44.4.5** 通过 `ELECTRON_RUN_AS_NODE=1` 运行时打印 **Node 24.21.0**，满足要求；**兼容性只是版本门槛，完整 Electron E2E 尚未执行** | 上游根 `package.json:133-135`、`packages/node_modules/node-red/package.json:50-52`；Mcode `apps/desktop/package.json` 与本机 `electron.exe -p "process.versions.node + ' ' + process.versions.electron"` |
| 体积 / 打包基数 | 原始 Git 已跟踪 **1534 文件/34.09 MiB**；浅克隆 `.git` pack 约 **9 MiB**；构建后的上游 `packages/node_modules` **61.45 MiB**（含 editor public **30.53 MiB**）；本机仅发行依赖 `npm install --omit=dev --ignore-scripts node-red@5.0.8` 得 **276 包/88.91 MiB**，该目录 tar.gz **23,298,901 bytes = 22.22 MiB**。构建时根 `node_modules` 为 **278.27 MiB**（**不可整包带进安装器**） | `.tmp/T13-size.ps1` 对文件 `Length` 汇总；`.tmp/T13-prod/node_modules`；`.tmp/T13-prod-node-modules.tgz`；文件聚合数据可复跑 |
| 能否跳过构建 | **可以分发已构建、经过来源哈希核验的 editor 静态产物**，从原版公开资源加载；现行 npm 5.0.8 发行包已含 `@node-red/editor-client/public/red/red.min.js`，现场测得 **1,079,959 bytes**。但**只要修改源 `src/js` / Sass / templates，必须重新编译**；不能把 npm 包代替 vendor 的修改事实源 | 上游 `scripts/build/config.js:9-16,134-156,158-212`；`@node-red/editor-api/lib/editor/theme.js`；`.tmp/T13-module-probe.cjs` |

**实测解析红/绿（E1）：** `powershell -NoProfile -ExecutionPolicy Bypass -File .tmp/T13-resolve-check.ps1`：启动位置为独立的 `.tmp/T13-sim-userdir/bootstrap.cjs`，配置隔离的 `NODE_PATH` 时 `require("node-red")` 验证版本 5.0.8、`init/start` 存在 → **PASS，exit 0**；撤去 `NODE_PATH` → **MODULE_NOT_FOUND，exit 1**；恢复 → **PASS，exit 0**；前后 bootstrap SHA-256 相同（`4E98E7131CC14CFE1F852F692083E52BF12B4E6F00508273F8CC16893C3330CA`）。这证明**源码无需放进数据目录，但必须有受控的模块查找路径**，不等于完成安装版引擎测试。

## 二、Mcode 改动面及范围估算（仅施工预算，非已修改行数）

以下「文件/行」为**拟修改的最小施工预算**，需要实现者在对应任务中给实际 `git diff --stat`；T13 没有产品代码变更。每行都有 smoke 影响，不将方案当已完成。

| 对应要求 | 当前真实代码 | vendor 后最小变更 | 预计文件数 / 修改行数 | 风险、既有回归 |
|---|---|---|---|---|
| `runtimeSupervisor.createEngineLaunchSpec` | `runtimeSupervisor.ts:735-781` 强制 `<dataDir>/node_modules/<installPackage>/package.json`；Electron-as-Node & secret/token 已集中 | 为 Node-RED 新增明确 vendor 资源目录候选与快照校验；按 vendor/受控 npm fallback 设置**子进程私有** `NODE_PATH`；保留 Node 版本、密钥、出错拒启 | **1 文件，约 30–55 行** | `workflow-engine-runtime-smoke`、`workflow-engine-electron-smoke`、`engine-secret-*-smoke`；严防把未经审批的 dataDir 插件路径加入高优先级执行入口 |
| `registry.BOOTSTRAP` + production `launchSpec` | `registry.ts:83-254` 用 `require("node-red")`；`:511-553` 在 vendor 选择发生之前就检查 dataDir 的 npm 包 | 启动计划统一调用 resolver（vendor 优先、npm fallback 显式）；`BOOTSTRAP` 无需复制入口代码、继续走当前 Admin token + POST /flows 归属围栏 | **1 文件，约 25–50 行** | `workflow-engine-runtime-smoke`、`node-red-e2e-smoke`、`mcode-node-pack-smoke`；不得绕过 `writeEngineBootstrap` 与 owner IPC |
| `engineNodeReadiness` | `engineNodeReadiness.ts:10-71` 真正职责是**第三方已批准节点清单完整性与孤儿包**，不负责查引擎 `node-red` 是否 npm 安装（原任务背景此点要纠偏） | 给 vendor 加**独立且先于 spawn 的哈希/依赖文件/NOTICE 快照验证**，现有社区节点批准扫描仍在用户 dataDir；绝不把官方供应包与未批准的第三方节点混扫 | **1 文件，约 12–30 行**（如抽共享模块，最多另 1 文件/40 行） | `engine-node-readiness-smoke`、`engine-node-orphan-guard-smoke`、`engine-node-preflight-order-smoke`；必须证明坏快照 fail-closed |
| 打包 `electron-builder.yml` / `electron.vite.config.ts` | `electron-builder.yml:103-124` 仅有 GenOffice staged resources；`electron.vite.config.ts:203-253` 负责打包 Mcode 主进程 | 在 **extraResources** 增 Node-RED 完整受控产物与第三方 licenses/manifest；新增可复制静态资源与 Node CJS 运行包的 staging+afterPack 校验；**主进程不直接 bundle upstream CJS**，`electron.vite.config.ts` 可 **0 行** | **3 文件约 160–260 行**：builder YAML ~6–12、新 stage ~90–160、新 afterPack gate ~60–90；vite **0** | `release-readiness-smoke`、新 `node-red-vendor-release-smoke`、真安装版启动；`app.asar` 非普通磁盘路径，避免打入 `files` |
| `.gitignore` | 未忽略 `/node-red/` | 与 `/genoffice/` 相同，正式经许可/体积同意后增 `/node-red/` | **1 文件/1 行** | 路径/补丁可恢复性；`git status --ignored` 核对 vendor 不进主 Git |
| Host/原厂 Editor 会话接线（任务第 3/5 节的后续前置） | `WorkflowLibraryView.tsx:80,1169` 挂 `WorkflowCanvas`；Node-RED 独立本地 HTTP Editor 的 Admin API 要 bearer；Mcode 已有 Host owner/deploy IPC | 宿主生成受限 WebContentsView/Pane 及**短期 editor session/token**，Admin API 同源代理 + 不泄露 engine admin 主令牌；真实原厂 page 和原有 `POST /flows` 统一保存，Mcode AI 调用同一 Host Service | **至少 2–4 文件、约 120–300 行**（只作后续估算） | `node-red-e2e-smoke`、`workflow-engine-electron-smoke`、UI/Agent 双入口与权限验证；不可绕开当前 Admin middleware |

注意：`registry.ts` 的 `BOOTSTRAP` **现有** `adminAuth.tokens` + `app.use('/flows',...)` 的父进程授权/owner handshake（`:109-230`）是高价值安全资产，vendor 方案必须复用它，不要开一个未审批的 Node-RED 端口绕过去。另一处并非简单 npm 版本检查：`engineNodeRegistry.ts:722-786` 主动发现未经批准的 `node-red-contrib-*` 与 `node-red.nodes`；vendor 核验不可替代它。

## 三、Mcode 能力 ↔ 原厂扩展点，何时真需 fork

| Mcode 目标能力 | 上游源码具体扩展点（5.0.8）及宿主接口 | 可否无 fork | 仍待实施 / 必需源码 fork 位置 |
|---|---|---|---|
| Mcode 自定义节点与 palette | runtime `RED.nodes.registerType(...)`，同名 JS+HTML 节点描述以及 `node-red.nodes` 清单；Editor `src/js/red.js:635-654` 会 `RED.nodes.addNodeSet` 和加载 `nodes/<id>` HTML；Mcode `mcodeNodePack.ts:404-425` 已原生注册 agent 类型 | **可** | 将 `BUILTIN_NODE_TYPES`（Mcode `orchestration/nodeTypes.ts:612+`）按映射/批准策略转换为原厂节点包，不是直接将 TypeScript 清单塞进前端；每类确认可编辑参数/未知字段往返 |
| 审批、运行状态、执行 owner **节点徽章** | `@node-red/editor-client/src/js/ui/view-annotations.js:80-118` 的 `RED.view.annotations.register(id,{type:"badge",show,filter,element,tooltip})`，`unregister`；`RED.hooks.add("viewAddNode.*")`、`RED.view.redraw()` | **可** | 增少量受信 editor 集成脚本和 Host 状态只读订阅；**审批判定必须留 Host**，徽章只展示 |
| 原厂节点模型/画布更新事件 | `src/js/nodes.js` 提供模型操作，`src/js/ui/view.js` 与 `RED.hooks` 提供画布重绘生命周期，`src/js/plugins.js:6-33` 有 plugin 注册 | **可（有限）** | 不直接维护第二套 React Canvas；仅调用被证实存在的 hook，升级时用 U1 验证时序 |
| 项目隔离、受限嵌入式 Editor | `node-red/lib/red.js:50-90,203+` 的 `RED.init(server,{userDir,httpAdminRoot,httpNodeRoot,adminAuth,...})` 和 `RED.httpAdmin/RED.httpNode`；`editor-api/lib/editor/theme.js` 支持主题页面；Node-RED 有多账号 auth，但**并无一进程多 Mcode userDir 共享的成熟隔离 API** | **可（每项目单独实例/端口）** | 按项目隔离 `userDir`、session、Host 身份；**不可用内置账号代替多租户进程隔离**。若强求*同一 Node-RED 实例*承载多 Mcode 项目文件隔离，需 fork `@node-red/runtime/lib/index.js`、`lib/flows/index.js`、`lib/storage/index.js`，**不建议** |
| 发布前真人审批、owner、Admin API | `registry.ts:122-230` 已在 Express **挂载 RED.httpAdmin 前**截获 `POST /flows` 并与 Host 父进程协商；上游 `editor-api/lib/admin/flows.js:43-70` 最终调用 `@node-red/runtime/lib/api/flows.js:66-96`，v2 `rev` 与 409 CAS 内建 | **可（通过现有 Host 接线）** | 所有别名写路由、`/flow`、禁用版 Node-RED node editor install 必须受同一宿主围栏；**若要求原厂内部每条 setFlows 调用都带任意 Host await 审批 hook**，没有统一 pre-deploy 授权钩子，须 fork `@node-red/runtime/lib/api/flows.js:setFlows`、`@node-red/editor-api/lib/admin/flow.js` |
| 原生单份 flow 存储、CAS/迁移 | `@node-red/runtime/lib/storage/index.js:32-71` 支持传**对象形式的 `storageModule`**；`runtime/lib/api/flows.js:66-87` 对请求 `rev` 冲突返回 409；Mcode 已有 `flowMigration.ts`、`flowToWorkflowDoc` | **可（通过 storage adapter）** | 建 Mcode Host-backed adapter，保持 flowId/projectId、credentials、revision、未知字段、备份；**当前并未实现终态的 UI/Agent 单份写入** |
| Agent/approval/module/automation 能力 | Mcode `mcodeNodePack.ts` 提供原生 Node 定义 + Host RPC port；原版 runtime 执行、触发和 `RED.events`；官方有各类节点 | **可（薄原生节点）** | 宿主受信身份绑定/长时审批/触发 owner 硬约束继续维护；不得在 editor 直接调三 SDK |
| 编辑器自定义 CSS/简单 UI、badge | `@node-red/editor-api/lib/editor/theme.js` 的 `editorTheme` 主题与 `editor-client/src/sass/`、`src/js/ui/view-annotations.js` | **可** | 做 Claude 风格外壳/非破坏性主题，不能把整套原厂画布迁入 React 重写 |
| **每条连线的独立标签/备注（native edge metadata）** | 原厂流持久化本质是 `node.wires[port][]` 的目标 id；原版 `view-annotations` 明确只处理**node badge**，不处理 link annotation | **做不到（当前扩展点）** | 如必须在原厂连线上可视化编辑/保真保存 Mcode `edge.label/note`，需 fork **`@node-red/editor-client/src/js/ui/view.js` 的 link 绘制/编辑**，并扩充 **`@node-red/runtime/lib/flows/util.js` 或宿主 storage adapter 的 sidecar 语义**；否则用 Host sidecar 不丢数据但原画布不原生可编辑 |
| **原厂画布 Chrome/布局完全替换为 Mcode 多 Pane DOM** | 官方 `editorTheme` 改 CSS/header，不能把内部全 DOM 切成任意 React pane；`src/js/ui/view.js` 仍拥有 SVG 和交互 | **做到样式与外嵌，不支持任意内部重排** | 若要把 Node-RED *内部* workspace、palette、编辑抽屉拆进任意跨窗口 React DOM，需 fork **`@node-red/editor-client/templates/index.mst`**、`src/js/ui/view.js`、`src/sass/`；**首选将完整原版页面放入 Mcode Pane + 主题**，避免 fork |
| **一进程动态切多个完全隔离 userDir** | 上游 `RED.init` 对整个进程加载单个 `settings.userDir` / storageModule / runtime；不是多租户数据库 | **不可（亦非用户要求）** | 仅若强求该设计才 fork **`@node-red/runtime/lib/index.js`、`lib/storage/index.js`、`lib/flows/index.js`**；采用每项目子进程可避免 fork |

**口径：**表内按 8 个「已有原厂扩展点或 Mcode Host 接线」能力、3 个「严格原生增强才必须 fork」类型归类（其中最后的同进程多租户是**可避免**的伪需求）。徽章/样式/Host 审批不能被误报成“原版支持原生 link 元数据或任何内部 UI 改造”。

## 四、构建、安装包体积与升级/回退决策

**体积与时间的明确估算（E1 测量 + E3 成品预测，须区分）：**

- 推荐的发行方式是以 pinned vendor **源代码**为事实源，构建后只 stage 必需的运行时 CJS 包、递归生产依赖、Editor 静态目录、license/NOTICE/manifest，不带源 Git、dev dependencies、测试和 node_modules 全量开发包。
- 同版生产 npm 依赖目录作**等价依赖集合上界样本**：**88.91 MiB 原始磁盘增量、22.22 MiB gzip 压缩增量**；Editor 静态 public **30.53 MiB** 已包含在发行产物集合之内，不再重复加一次。主程序当前默认**不内置** Node-RED，这就是新增有效载荷的量级。
- **构建额外 2.17 秒/次（热依赖、全量 editor 构建实测）**，全新检出时 npm ci **21.87 秒**；复用经哈希验证的原厂预构建静态文件，未修改 editor 时可跳过 2.17 秒的重新构建。发布中的 stage/copy/压缩和 afterPack 实际耗时尚未实测。
- **不能将 22.22 MiB 冒充 electron-builder NSIS/DMG/ZIP 的精确体积差，也不能把 2.17 秒冒充整个 CI/安装器新增耗时。** 精确 installer delta 必须在后续真正 stage 并分别打有/无 vendor 的**同平台**安装包后比较（`SizeWith - SizeWithout`，同 release 配置，Win/macOS/Linux 各跑）；这是调查本身没有更改打包产线的**未验收项**。

**升级/许可/回退：**

1. 先取得**用户关于源码 vendor 体积、再分发第三方许可证的确认**，再在根创建 `node-red/` 独立 Git clone；checkout `935b8d3...` 后建 `mcode/integration`，`/.gitignore` 忽略。构建产物 staged 另由主仓 manifests/脚本可重建；不能让一个被忽略的本地 checkout 成为唯一交付途径。
2. 把边界改动以小提交及 `git format-patch <base>..mcode/integration --output-directory patches/node-red` 导出入主仓；新 checkout 先固定基线，再 `git am ../patches/node-red/*.patch`，不能依赖本地 untracked 产物。保存 BASE_COMMIT、patch sha256、每个静态 asset hash、npm lock hash、LICENSE/NOTICE/SBOM。
3. 升级取目标**稳定 tag 后再锁定其完整 commit**（本任务仍固定 5.0.8），在独立 vendor Git 中 `rebase --onto <new> <old> mcode/integration`（先独立备份），冲突必须人工处理；重建 editor，跑 Node-RED 原生 suite、Mcode flow/owner/插件门禁 suite、真 Electron 和安装包 postPack gate；不允许自动「跳过坏补丁」。
4. **保留旧 npm 安装作为**显式** fallback**：仅当用户已安装可信版、批准清单和签名/哈希均验过、且 vendor 可用性失败被 UI 明确报告并由用户选择时，允许同版 5.0.8 的回退；**不允许运行时静默下载、不允许绕过坏快照校验转走另一份可执行体**，坏版本/坏许可/坏 ledger 一律 fail-closed。测试必须覆盖 vendor 缺失、坏哈希、批准的 npm 包可用/不可用、身份与 flows 数据不变。

## 五、685 行手写画布的引用、旧能力与退场门槛

**全量代码引用扫描**（`agent_grep WorkflowCanvas apps/desktop/src`）：
- **仅一个真实 JSX 挂载/导入入口**：`apps/desktop/src/renderer/components/settings/workflows/WorkflowLibraryView.tsx:80` import，`:1169` 渲染 `<WorkflowCanvas>`；其外层 `WorkflowsPanel.tsx:63,197` 挂载 `WorkflowLibraryView`。源码本体 `WorkflowCanvas.tsx:96` 定义和本文件自己的工具条。其它提及仅文档注释：`NodeInspector.tsx:23`、`workflowEdit.ts:123,367`、`workflowLayout.ts:14`、`WorkflowNodeCard.tsx:7,36`。没有查到第二处实际 JSX 挂载。
- **背后的业务依赖不能跟着一删了之**：`WorkflowLibraryView.tsx:246` 调 `api.workflow.list`、`:390,661` 调 `api.workflow.save({workflow,expectedRevision})`；`workflowEdit.ts`（节点/边编辑）、`workflowLayout.ts`（坐标）、`NodeInspector.tsx`（参数）、`workflowNodeTypes` 清单、`WorkflowsPanel` 入口，以及 `workflow.*` Host API/Agent `app_api_list→describe→call`、自动化、执行 owner（`workflowEngines/executorOwnership.ts`）、`flowMigration.ts` 均要接到同一个原厂事实源。删除画布不等于删除审批、工作流库、自动化和 Agent 工具。
- **目前不满足退场**：官方 editor 全量接入 Mcode Pane 与 credentialed session 未 U1 验收；MERGE-1 同存储/revision/CAS 和迁移未知字段双向无损未过门；MERGE-2 Host 节点与参数回读需逐类校验；MERGE-3/4 单 executor/触发 + 权限闭环及坏档回退仍非整包通过。不能把 T13 的构建和 CJS 引导 E1 冒充这些阶段完成。

| 退场阶段 | 进入前置条件与操作边界 | 离开判据 |
|---|---|---|
| **A 并存（调查后试点）** | 有正式 vendor 基线+补丁+资源校验；Node-RED 原版 editor 可以在 Mcode 内通过受限 Host session 完整打开、关闭、重开；旧 UI 作为显式只读/回退编辑入口，不可同时当写入真相 | 同一虚构 flow 原版编辑复制/连线/更参、保存/重开都能原生读回；审核、错身份、错误令牌、坏依赖 fail-closed |
| **B 原画布只读** | MERGE-1 原版 StorageAdapter/CAS/flow migration 报告和原件备份、未知属性无损、旧 WorkflowDoc 写入口已被拒或转同一服务；MERGE-2 Mcode 自定义节点 Host 端口覆盖现有业务字段 | UI 与 Agent 读同 revision、并发写冲突 409；旧画布仅显示不可编辑，与真实 editor 无二次保存；自动化/触发无双重 owner |
| **C 删除手写画布** | MERGE-3 单触发/单 executor/重启/取消/审批与 MERGE-4 社区节点授权全过；至少真 Electron＋真 Node-RED＋三 SDK 的完整 UI/Agent/自动化用户旅程；回退演练保留可恢复的 flow 数据备份 | 删除 `WorkflowCanvas.tsx` 与多余纯前端画布工具，移除 JSX 引用及双写 API（但保留必须的 adapter、工作流库、Host 审批、Agent 发现调用），重新全量跑 release/e2e；ARC-006 由独立复核者决定是否双勾 |

## 六、复核命令、结果与未达成的证据

| 检查 | 命令/材料 | 实测结果 |
|---|---|---|
| 上游固定源 | `git clone --depth 1 --branch 5.0.8 https://github.com/node-red/node-red.git .tmp/T13-node-red-5.0.8`，`git rev-parse HEAD` | PASS；commit `935b8d3...`，有独立 `.git` |
| 原厂依赖/构建 | `powershell -File ..\T13-benchmark.ps1`（在临时 checkout） | **2 步 PASS/0 FAIL**；npm ci 21.87s、npm build 2.17s |
| vendor CJS 可解析 | `powershell -File .tmp/T13-resolve-check.ps1` | **green=2、故意 mutant red=1**；还原 SHA 一致，见第一节 |
| Mcode 既有局部回归 | `node apps/desktop/scripts/run-smokes.mjs workflow-engine-runtime-smoke engine-node-readiness-smoke mcode-node-pack-smoke` | **3 suites PASS/0 FAIL**；日志 `apps/desktop/.tmp/smoke-runs/1792536381321-28796-kCd6yY` |
| size / 发行物 proxy | `powershell -File .tmp/T13-size.ps1 -Src .tmp/T13-node-red-5.0.8 -Prod .tmp/T13-prod`；`tar -czf .tmp/T13-prod-node-modules.tgz -C .tmp/T13-prod node_modules` | 原源码 34.09MiB、Editor public 30.53MiB、生产模块 88.91MiB、tar.gz 22.22MiB；**不是正式 installer** |

**未做/剩余风险（E3）：** 无正式 `node-red/` checkout/分支/patch；无真正双版本 installer 体积和 CI 全耗时 A/B；Node-RED 依赖 LICENSE/NOTICE/SBOM 尚未逐项审计；没有把真实原厂 editor 挂入 Mcode Pane；没有运行真 Node-RED 整条用户流程、真 Electron、跨 OS 发行验收；没有把 `WorkflowCanvas` 删除，也没有修改产品源码。**任务 7 条验收判据中，第 5 条关于「发行安装包增加的精确体积/构建全流程增量」只取得可重现实测 proxy、尚未取得真实 installer A/B，必须如实标为未完全达成。** 本文不新增正式 ARC-006 通过状态。
