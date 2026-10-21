# T80｜T69 环境阻断 A1：22 套 Smoke 的 Windows sort -V 入口修复

| 项目 | 值 |
|---|---|
| 编号 | T80 |
| 类型 | T52/T68 / 测试基础设施，不是产品功能 |
| 优先级 | **P0**；修通已有测试保护网，避免 22 套构建前直接红 |
| 复用路线 | L1 既有 `scripts/lib/esbuild-path.sh` 缓存/可执行解析器，不再每套复制 `find | sort -V` |
| 可派 | **立即**，与 T81 按 22+27 个不重叠 run.sh 切片并行 |
| 独占可写 | T69 60 项矩阵中**A 类 sort -V 的 22 个对应** `apps/desktop/scripts/<suite>/run.sh`、`apps/desktop/scripts/lib/esbuild-path.sh`（必要最小修改）、本任务卡；不能改其它脚本/源码/测试断言 |


## 旧红例/问题定位
T69 独立复跑 `arc005-focus-ownership-smoke/run.sh` 得到 `-V系统找不到指定的文件。`，T68 60 fail 中 22 条为同源。示例 `scripts/arc005-focus-ownership-smoke/run.sh` 使用 `find ../../node_modules/.pnpm -path ... | sort -V | tail -1` 解析 esbuild。现有统一 `scripts/lib/esbuild-path.sh` 已有 `MCODE_ESBUILD`、共享缓存、pnpm glob、find 后备和 npx fallback，但**其自身**也有 `sort -V`，不能只机械替换引用而保留相同错误。

## 开工前必读
1. `audit-ledgers/README.md`、`tasks/T69-60-smoke-failure-triage.md` 完整 60 表与最后 A1 建议、T52/T68 回写。
2. `apps/desktop/scripts/lib/esbuild-path.sh` 与 T69 表中 22 套各自 `run.sh`；理解引导变量、工作目录、ESBuild 路径+回退链和 Windows/Git Bash 差异。
3. `apps/desktop/scripts/run-smokes.mjs` 的调用/缓存、工作目录与轻重套限流规定。

## 执行步骤
1. 以 T69 记录的 **22 个** exact suite 为范围清单，先复现一个失败 `-V` 的既有红例及工具版本/调用命令；禁止扩大到目录下所有脚本。
2. 使用已有 `esbuild-path.sh` 解析功能，让 22 套复用同一信任路径，必要时修其 `sort -V` 在目标 Windows 上的可移植实现。**不能**将排序功能改成挑“任意一个旧 esbuild”，且必须保留环境直给、缓存、版本选择和后备。仅为测试基础设施，不改 `run-smokes.mjs`。
3. 测同一批套件真正完成其原有断言，先跑代表性 light suite，再有界批量执行；环境不具备的分类计数并给详细原因。不能把不再出现 shell 首错视为整体 PASS。
4. 增加一个最小负控：恢复错误 `sort -V` 或刻意喂入两个不同版本路径，确保现有测试或新专项断言真正识别错误选择，恢复后逐字节相同。
5. 保证所有 22 套 `run.sh` 保留原有 `dataRoot`、alias、脚本出入参、cleanup trap、变异测试，不能删除测试或跳过不适用部分。

## 验收判据
1. 22/22 个目标入口不再因 Windows `sort -V` 首错失败；有逐 suite 的运行结果与原因记录（仍 fail 的明确分类）。
2. 原始断言没有减少；代表性套件真正 exit 0，所有 22 套在安全非竞争环境中尽可能绿，不能造全绿。
3. helper 在 Linux/macOS/Windows 对版本解析等价且 fail-closed，不依赖 WSL/Git Bash 指定一个机主固定路径。
4. 负控恢复旧错误选择→明确红例，源码还原后 HASH 相同，最后双包 TS/专项测试不回归。
5. 只提交 22 对应 run.sh + 共用 esbuild helper + 本卡，不抢 T81 的 node_modules helper 或 T49/T64/T65 产品代码。

## 不做
不修 Node-RED、GenOffice、设置页/模块权限业务功能；T69 的 27 项 ln 问题由 T81 处理，不在这里交叉编辑。

## 结果回写区

<!-- 执行对话仅追加证据、提交 SHA、实际命令/计数、原红→新绿、变异/恢复、未验风险。 -->
