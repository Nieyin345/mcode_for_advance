# T81｜T69 环境阻断 A2：27 套 Smoke 临时 node_modules 链接修复

| 项目 | 值 |
|---|---|
| 编号 | T81 |
| 类型 | T52/T68 测试基础设施、Windows/MSYS 临时路径兼容 |
| 优先级 | **P0**，一项策略覆盖 T69 已列 27 套 |
| 复用路线 | L1 Node/Windows 可用的受控运行时模块解析 + 既有测试入口；不做 27 套业务重写 |
| 可派 | **立即**；与 T80 的 22 套 run.sh 文件集合不重合 |
| 独占可写 | T69 的 A 类 `ln: ... /node_modules: Device or resource busy` 的**27 个** `apps/desktop/scripts/<suite>/run.sh`、必要时新增 `apps/desktop/scripts/lib/runtime-node-modules.sh` 或同职责小 helper、新增专用 Smoke、本卡 |
| 禁写 | `scripts/lib/esbuild-path.sh`（T80 独占）、T69 之外其它 Smoke、主进程/渲染端、`node_modules` 安装树与根包锁文件 |


## 旧红例
T69 独立复跑 `library-import-smoke/run.sh`，在临时路径 `$OUT/node_modules` 处 `ln -s "$PWD/node_modules" "$OUT/node_modules"` 报 `Device or resource busy`；已有 27 套同类错误。不能直接删这行：例如 `library-import-smoke` 的动态 `require.resolve("pdfjs-dist/package.json")` **确实需要**从外置 Node runtime bundle 解析依赖；`memory-codex-smoke` 也通过包 external 在临时目录解析。T69 已明确这不是 27 个独立产品 Bug。

## 开工前必读
1. `audit-ledgers/README.md`、T69 60 项表和 A2 建议、T52/T68 的 runner 限流与前置数据隔离要求。
2. `apps/desktop/scripts/library-import-smoke/run.sh`、`memory-codex-smoke/run.sh` 和 T69 中其它 25 个对应 `run.sh`；分析每套需要哪些外置依赖。
3. Node 在 ESM/CJS 的包解析行为、Windows junction/symlink 在 Git Bash/MSYS/NTFS 的区别、已有 `lib/esbuild-path.sh`（只读）。

## 执行步骤
1. 先按 T69 清单列出 27 个 exact suite，复现 `library-import-smoke` 旧红，再确认是 **创建 symlink 失败** 还是有同名目录/并行残留，不能直接归因“Windows 不支持 symlink”。
2. 设计并复用一个在 Windows/MSYS 安全工作、在 Linux/macOS 行为不变的最小链接/解析方式。可考虑 Windows junction 或其它经过真实 Node 模块解析验证的方案，**禁止**把整个 node_modules 大树复制到测试临时目录、禁止使用真实用户家目录、禁止把外部任意目录加入应用的生产搜索路径。
3. 仅修改那 27 个 `run.sh` 的临时依赖视野创建方式，保留 runtime external 和运行期 `require.resolve` 正例、所有数据根、cleanup trap、原有断言。
4. 独立验证 `library-import-smoke` 和至少一个 ESM 外置依赖套件：真 `require.resolve` 或动态 import 可以找到合法依赖，错误/缺包仍明确失败；完整 27 套依安全/资源约束分批复跑、统计每套真实 PASS/FAIL。
5. 变异把复用 helper 改回失败的 ln 行或移除依赖路径，原旧红再次出现；逐字节恢复后基线绿。不得通过跳过外置 PDF 解析测试消除红项。

## 验收判据
1. 27/27 目标套件不再发生 `node_modules` 创建处的环境失败；每套原始断言保留，后续真实业务失败应单独列出。
2. 代表性 `library-import` 的真正 PDF 导入/包解析仍通过，不允许 stub 掩盖模块缺失；其它 27 套尽可能完整跑绿，结果不臆报。
3. Windows Git Bash / MSYS 与 Linux/macOS 路径方案有能力探测和明确 fallback，不能将固定本机磁盘路径写进 repo。
4. 故障注入/负控使新正例正确变红，恢复源 hash 完全一致；不改变实际用户 node_modules tree。
5. 只提交 27 run.sh + 独立 helper/新测试 + 本卡，与 T80 分离，不碰 T49/T64/T65 以及真数据库。

## 不做
不修改产品 Node 模块加载规则、不做 npm install、不修独立 MCP/Settings/Renderer 源码。

## 结果回写区

<!-- 执行对话仅追加证据、提交 SHA、实际命令/计数、原红→新绿、变异/恢复、未验风险。 -->
