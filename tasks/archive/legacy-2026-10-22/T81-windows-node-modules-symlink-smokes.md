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

### 2026-10-21 T81 实施与动态验证（E1 Windows/MSYS，E2 POSIX 分支）

- **范围冻结**：从 T69 60 项逐行提取恰好 27 个「node_modules 链接 Device or resource busy」的 run.sh；开工 HEAD `de6a13e3138d0e59232e8b82c191b5b9da1d036e`，过程有其他会话提交到 `0749408416763a6aca745ac198b00fe099227b1a`。仅将 27 个临时依赖链接行替换为 `source scripts/lib/runtime-node-modules.sh` + `mcode_link_runtime_node_modules "$OUT" "$PWD/node_modules"`（两个使用 `$DESKTOP` 的入口保留原变量），保持所有别名、external、其余断言与原有 cleanup/data root；`archiver-installer-smoke` 的 `CLEAN_OUT` 继续**不**得到模块视野。
- **旧红复现**：`D:\\anaconda1\\Library\\usr\\bin\\bash.exe scripts/library-import-smoke/run.sh`，Windows MSYS 上 exit 1，`ln: failed to create symbolic link '/tmp/.../node_modules': Device or resource busy`。原 `OUT` 每次来自新 `mktemp -d`，负控重演时增加 `test ! -e "$link"` 守卫仍得到同一 EBUSY，排除事前同名链接/并行残留为必要原因。
- **修法**：`lib/runtime-node-modules.sh` 在 MSYS/MINGW/CYGWIN 分支将现有依赖目录/临时目标转 Windows native path（`cygpath -wa`，Git Bash 缺失时 `pwd -W`），由 Node `fs.symlinkSync(..., 'junction')` 建目录链接；在 junction 不可用且平台允许的情况下尝试 `dir` symlink，均失败则显式中断。不复制 `node_modules`，不添加生产 `NODE_PATH`，不固定开发者盘符。Linux/macOS 走原 `ln -s`，保持旧行为；**Linux/macOS 实机未跑**，仅 E2 路径审查。缺源、目标已存在都拒绝。
- **实际 E1**：`D:\\anaconda1\\Library\\usr\\bin\\bash.exe scripts/runtime-node-modules-smoke/run.sh` exit 0：隔离假 node_modules 下真实 ESM `import` + CJS `require.resolve` 正例；双路缺包均拒绝，重复链接拒绝，`rm -rf "$OUT"` 后原假依赖 guard 仍存在。正式 `library-import-smoke` 在原 127 条断言外增加真正 `pdfjs-dist/legacy/build/pdf.mjs` + `require.resolve('pdfjs-dist/package.json')` + 真实 `scripts/fixtures/sample-paper.pdf` 页数/文本提取探针；`runtime pdfjs-dist resolve + true PDF parse PASS` 与 `127/127 passed`，exit 0，未用 stub 冒充 PDF 模块。
- **完整批次**：`node .tmp/t81-batch.cjs`，原生 `D:\\anaconda1\\Library\\usr\\bin\\bash.exe` 在 `apps/desktop` cwd **串行**运行指定 27 个 `run.sh`，每套超时上限 180 秒，各自原有数据根/cleanup 不变；`TOTAL 27 PASS 27 FAIL 0 LINK_FAILURE 0`，exit 0。逐套退出码均为 0：`archiver-installer, claude-ipc, codex-effort, genoffice-mcp, library-adopt, library-delete, library-entry-path, library-import, library-mcp, library-move, library-pdf-writeback-host, library-trash, maint-c-followup, maint-m33, mcp-ipc, md-image-guard, memory-codex, pdf-annotation, pdf-highlights-integrity, pdf-import-atomic, projects-ipc, provider-health, relay, resume-fault, skill-delivery, theme-ipc, updater-tools`（各名后缀均为 `-smoke`）。逐套完整日志在项目忽略的 `.tmp/t81-results/<suite>.log`，并有对应 JSON 退出码/耗时。日志里部分故意注入的负控 `[error]` 属于原断言预期，非 FAIL；结果按真实进程 exit 0 统计。
- **两次故障注入**：`node .tmp/t81-mutate.cjs`，仅临时替换 helper 中 Windows Node 调用，① 改回 `test ! -e "$link" && ln -s "$modules" "$link"` → `library-import` exit 1、`Device or resource busy`；② 刻意不创建 runtime link → `library-import` exit 1、`ERR_MODULE_NOT_FOUND`（新增真实 PDF 探针能抓住缺包）；每次 `finally` 恢复 helper 原 bytes 并逐次计算 SHA256 一致，最终 baseline `library-import` exit 0、127/127 + 真实 PDF 解析 PASS；恢复后 helper SHA256 `77aee14b313fde466bce668e9b4f06fcec9802788cc6d40e715c10b7e5efaee6`。
- **边界/风险**：没有修改真实 `node_modules`、用户数据库、产品源码、T80 独占 `lib/esbuild-path.sh` 或 T49/T64/T65；只变更本卡 27 个 run.sh、新的 runtime-link helper/回归 Smoke 与本卡。POSIX 原链接分支保留但无实机 Linux/macOS E1；全项目 510+ 套不在本卡范围，未声称全绿。
