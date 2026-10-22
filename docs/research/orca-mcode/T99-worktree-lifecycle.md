# T99｜Orca↔Mcode Worktree/项目身份与隔离生命周期源码对照

## 基线与方法

- **Mcode HEAD**：`94524df83eb01669dd93191521f84a593bd0dd95`。开始检查时工作区已有未提交修改：`.aoci/baseline.json`、`.gitignore`、`apps/desktop/scripts/maint-m35-smoke/pickers-prelude.ts`、`apps/desktop/scripts/orchestration-ipc-smoke/run.sh`、`apps/desktop/scripts/release-readiness-smoke/check-reviewed.cjs`、`apps/desktop/src/main/appControl/apiCatalog.generated.ts`、`apps/desktop/src/main/ipc/settingsTransfer.ts`，以及一个名字显示为 `['dev'` 的未跟踪路径。均未修改、暂存或清理。
- **Orca 固定基线**：`ea60ec5d7cb9b542d2b5b3fd986acfc8861e4560`，`orca/package.json` 版本 `1.4.214`；`git -C orca status --short` 为空。调查期间未切换、更新或写入 Orca。
- 仅作静态源码与现有测试位置检查。未启动 Electron、未访问用户数据库或远端、未运行测试或构建；不声称 E1 动态复现或 U1 产品验收。源码事实记为 E2，未实际运行的竞态/利用情景记为 E3。
- 主要依据：Mcode `apps/desktop/src/main/lib/worktreeOps.ts`、`ipc/claude.ts`、`ipc/git.ts`、`lib/sessionStart.ts`、`store/repositories/{project,session}.ts`、`packages/contracts/src/{session.ts,ipc/git.ts}`；Orca 的 worktree create/remove/catalog、host-qualified metadata、Git add/remove 与 path identity 模块。测试仅定位、未执行。本次按 `**/*worktree*.test.ts` / `**/*worktree*.spec.ts` 检索 `apps/desktop` 与 `packages`，未找到专门匹配的 Mcode 测试文件；这只描述该搜索范围，不代表没有其他 smoke coverage。

## 端到端调用链

### 1. 创建、命名冲突与身份落盘

- **Orca 桌面入口**：`orca/src/main/ipc/worktrees/create/register-worktree-create-handlers.ts:37-132` 的 `registerWorktreeCreateHandlers` 接收 `worktrees:create`，先解析 repo、确认 WSL 可写范围，再按 repo 类型分流。普通 Git repo 经过 `requireWorktreeCreateRoute` 后调用 `createLocalWorktree`；folder repo 则直接调用 `createFolderWorkspace`，并不执行 Git checkout。
- **Orca Git worktree 分支**：`orca/src/main/ipc/worktree-remote.ts:994-1050,1209-1378,1434-1529,1558-1659`（`createLocalWorktree` / `performLocalWorktreeCreate`）先选路径与分支、检查已有分支/路径冲突，再调用 Git add；`orca/src/main/git/worktree-add.ts:199-309` 执行 add/回滚相关步骤。随后 `orca/src/main/ipc/created-worktree-reconciliation.ts:42-92` 的 `resolveCreatedWorktree` 先直接描述新 checkout，失败时再用完整 `git worktree list` 查找；`worktree-remote.ts:1564-1659` 再写 worktree metadata、host target、instance id 和 lineage。Orca 还有 runtime 入口：`orca/src/main/runtime/managed-worktree-create-registry.test.ts:104-170` 验证 runtime 创建会在通知前登记，并在失败后清除创建记录。
- **Mcode 对应入口**：`apps/desktop/src/main/ipc/claude.ts:157-179` 的 `CLAUDE_START_SESSION` 调用 `createSessionAndSend`；`apps/desktop/src/main/lib/sessionStart.ts:296-389` 保存 `projectId`、`envMode`、`wtStyle`，新会话的 `worktreePath` 初始为 null。首次 `CLAUDE_SEND_TURN` 进入 `resolveSessionCwd` / `materializeWorktreeSession`（`claude.ts:90-155`），调用 `nextWorktreeDir`（`worktreeOps.ts:133-175`），再调用 `createDetachedWorktree` 或 `createBranchedWorktree`（`worktreeOps.ts:214-266`），成功后通过 `SessionRepo.updateWorktreePath` 持久化（`store/repositories/session.ts:627-640`）。同一 session 有 `materializing` in-flight map，但锁键是 session id。
- **差异**：Orca 的桌面创建是显式 create 命令，folder workspace 也走 catalog；Mcode 是“先保存隔离意图、首次发 turn 才建真实 Git worktree”。两者不应仅按同名的 “worktree” 函数视为等价。

### 2. 删除、合并回主工作区与破坏性边界

- **Orca**：`orca/src/main/ipc/worktrees/removal/register-worktree-removal-handlers.ts:45-162` 的 `remove` 解析 `repoId/worktreePath/hostId`，等待既有删除、合并相同 in-flight 请求，并经 `runWorkspaceLifecycleCommand` 按 host/worktree key 协调终端生命周期。随后 `orca/src/main/ipc/worktrees/removal/execute-worktree-removal.ts:38-187` 复核 Git 注册项、host ownership、worktree lock；正常删除再经 `remove-registered-local-worktree.ts` 的 dirty preflight、archive hook、watcher gate、PTY sweep、Git remove 与 metadata/cache 清理。底层 `orca/src/main/git/worktree-removal.ts:26-111` 使用 Git 删除 checkout，并单独清理分支。
- **Mcode**：`apps/desktop/src/main/ipc/git.ts:1205-1228` 的 merge/remove handler 只先确认 `repoPath` 属于已知项目，然后调用 `mergeBackWorktree` / `removeWorktree`。`worktreeOps.ts:411-514` 会拒绝无法读取的 worktree 状态；dirty tree 先自动 commit，再把 worktree HEAD merge 到主 checkout 当前分支，冲突时不删除 worktree。删除路径在 `worktreeOps.ts:527-725` 阻止正在运行的 session，dirty 时默认拒绝，支持导出完整未合并 patch，删除后 prune，并将关联 session 的 `worktreePath` 清空以便历史会话退回本地模式；生成的 `mcode/*` 分支只尝试 `git branch -d`，未合并分支会保留。
- **结果**：两边都有未提交修改防护；Orca 还有显式的 PTY/watcher/后台删除生命周期门。Mcode 的删除函数中可见的是“运行中的 turn”检查，未看到等价的 watcher/PTY teardown gate；Windows 文件占用及 idle 子进程的实际影响未动态验证。

### 3. 列表、缺失路径、重启与元数据回收

- **Orca**：`orca/src/main/ipc/worktrees/listing/register-worktree-catalog-handlers.ts:68-153,163-221` 对本地 repo 做 Git scan，隐藏尚未完成 metadata 的 in-flight create，并标记 pending removal；fresh scan 再调用 side effects。另有 `orca/src/main/runtime/runtime-managed-worktree-queries.ts:97-185` 的 authoritative scan：只有 scan 成功且未被更新一代覆盖时，才 prune 缺失 metadata/lineage。创建后找不到路径也有 `created-worktree-reconciliation.ts:42-92` 的直接查询 + 列表 fallback。
- **Mcode**：`worktreeOps.ts:289-370` 用 `git worktree list --porcelain` 计算 dirty/missing/referencedBy/merged；`SessionRepo.worktreeReferenceCounts`、`listWorktreeRoots` 位于 `store/repositories/session.ts:653-690`。已物化会话重启后依赖数据库里的 `worktreePath`；`claude.ts:103-110` 只检查目录是否存在，若不存在会报错并要求用户到 Git 面板清理后新建会话。显式 remove 可以处理缺失目录、prune Git 注册并清空旧 session path，但不是与 Orca 相同的后台生命周期/权威 catalog reconciler。

### 4. 普通 folder workspace 与嵌套仓

- **Orca**：`register-worktree-create-handlers.ts:79-101` 将 folder repo 与 Git worktree 分流；`folder-workspace-creation.ts:11-67` 生成 `instanceId` 并持久化 metadata；`folder-workspace-model.ts:11-17,32-46` 的 workspace id 带 instance suffix，但其 path 就是原 folder path，head/branch 为空。folder workspace 是一个 workspace/catalog 实体，不是假装执行过 `git worktree add`。
- **Mcode**：`projects.ts` 与 `ProjectRepo` 保存的是普通 Project 行；`db.ts:163-170` 的 projects 表没有 path 唯一约束。Git 面板 `git.discoverRepos`（`apps/desktop/src/main/ipc/git.ts:649-680`）可在已知 workspace root 下递归发现嵌套仓；但 session worktree 只检查 `project.path/.git`（`claude.ts:115-141`），因此嵌套 repo 的发现不等于 session worktree 会自动以嵌套 repo 为基仓。普通 folder project 与真实 Git worktree 在 Mcode 中应保持不同语义。

## 能力对照矩阵

| 主题 | Orca 源码证据 | Mcode 源码证据 | 结论 |
|---|---|---|---|
| **工作树实例身份** | `shared/worktree/id.ts:21-59,72-84` 用 repo id + path 构造定位 id；`host-qualified-worktree-meta.ts:43-54,80-98,128-133` 按 host 读写；创建 metadata 带随机 `instanceId`（`worktree-remote.ts:1576,1635`）。folder workspace 也用随机 instance id。 | Project/Session 有各自的行 id，但 session worktree 只持久化 `worktreePath`（`contracts/src/session.ts:195-213`）；在 `apps/desktop`（3027 个文件）和 `packages`（91 个文件）搜索未发现 worktree instance token。 | **真缺失 / E2**：缺少能区分“同一绝对路径的旧 checkout 与新 checkout”的持久化 worktree 实例代次。 |
| **普通目录与嵌套仓** | folder workspace 与 Git worktree 显式分流，folder identity 由 instance suffix 区分（上述 folder workspace 文件）。 | Project 是任意绝对路径；Git discovery 可递归，但 session worktree 仅基于 project 根目录的 `.git`。 | **部分已有 / E2**：普通目录和嵌套仓能被表示/发现，但 nested repo discovery 不会自动成为 session worktree 的基仓。 |
| **创建重名、分支冲突与失败确认** | `worktree-remote.ts:463-500,1209-1378` 检查既有 local branch 是否存在、base commit 是否一致且未被其他 worktree checkout，并进行有界候选搜索；创建后 `resolveCreatedWorktree` 直接查询 + 列表 fallback。 | `nextWorktreeDir`（`worktreeOps.ts:133-175`）通过 `stat` 和可选 ref 检查找候选；Git add 使用 `--detach` 或 `-b mcode/<name>`。候选检查与 add 之间没有跨 session 的原子预留，锁只按 session id。 | **部分已有 / E2；竞态风险 E3**：存在冲突探测和 Git 自身拒绝，但不能从静态检查证明两个 session 并发时会自动重试或始终无残留。 |
| **同一分支跨工作树 / 分支复用** | `canCheckoutExistingLocalBranch` 仅在 base commit 匹配、且该分支未被 worktree 使用时允许复用；已选复用分支会设置 preserve-on-delete metadata。 | detached 是默认形式，可从同一 HEAD 创建多个 detached checkout；branch 形式总是新建 `mcode/*` ref，不提供“选择并复用已有分支”的同等路径。 | **部分已有 / E2**：隔离 checkout 已有；显式复用已有分支的语义不同，不宜直接照搬 Orca 的 branch selector。 |
| **dirty / merge-back / force 删除** | `execute-worktree-removal.ts:96-104,151-187` 与 `remove-registered-local-worktree.ts` 先过锁/dirty/archive/watcher/PTY gates；Git 层保留未合并分支。 | `worktreeOps.ts:443-455,527-647,692-717` 有 unknown-status fail-safe、dirty 拒绝、可选 patch、force 与 merged-only 分支删除。patch 导出失败会记录日志但继续 force 删除，返回 `patchPath` 可能为空。 | **部分已有 / E2**：数据保护已存在；patch 是 best-effort，不应把“请求导出”当成“必然已备份”。 |
| **路径丢失与重启恢复** | `runtime-managed-worktree-queries.ts:97-185` 仅在权威、未过期 scan 后清理 metadata；remove handler 有 in-flight/background removal 与 stale registration recovery。 | session path 跨重启持久化；`claude.ts:103-110` 检查 path missing 后停止 turn 并要求手动清理；`worktreeOps.ts:545-690` 可 prune stale Git row、清理残留目录、清空 session path。 | **部分已有 / E2**：有显式恢复路径，但没有实例代次校验；缺失后重新占用同一路径的身份混淆风险另见下文。 |
| **Windows/路径别名/host ownership** | `shared/cross-platform-path.ts:9-20,41-90,190-194` 按路径语法处理 Windows case、NFC 与 WSL alias；`registered-worktree-root-owner.ts:29-58` 把 repo id、resolve 后路径和 execution host 纳入 owner key。 | `pathNorm.ts:10-14` 使用共享 path key；`pathGuard.ts:49-113` 通过已知 Project/worktree roots 与物理路径围栏；Git worktree IPC 只校验 repoPath，worktreePath 需要 lifecycle 自己证明 ownership。 | **部分已有 / E2**：本地路径围栏存在；Orca 的 host-qualified identity/WSL alias 模型更完整，Mcode 当前 worktree provider 是本地路径语义。 |
| **merge-back ownership 失败时的 fail-closed** | `execute-worktree-removal.ts:50-95` 先确认 repo/host 与 Git registration；删除路径另有 `findRegisteredDeletableWorktree`、危险路径及 nested approval checks。 | `GitWorktreeMergeBackSchema`（`packages/contracts/src/ipc/git.ts:430-438`）只校验两个 string；IPC（`ipc/git.ts:1205-1215`）只围栏 repoPath；`mergeBackWorktree`（`worktreeOps.ts:428-438`）在 `git worktree list` 查询失败时 `.catch(() => true)`，随后可能进入 `commitAll`（`worktreeOps.ts:443-455`）在 worktreePath 内 `git add -A`。 | **与定位冲突 / E2**：ownership probe 失败时不应把“无法证实”视为“属于该 repo”。这是静态可定位的 fail-open 风险，未动态利用或修改。 |
| **仓库级磁盘回收** | `orca/docs/readme/worktree-storage-maintenance.md:3-45,54-65` 记录 `pnpm reclaim-space` 的 preview/apply、缓存/历史测试 checkout 策略；明确不删 worktree registration，folder workspace 没有 repo-wide sweep，SSH host 不在本机清理范围。 | 本次检查到的 `worktreeOps.ts` 是单个 session worktree 生命周期，没有同类仓库级 reclaim worker。未审计 Mcode 全部磁盘维护任务。 | **证据不足 / E3**：不能据此断言 Mcode 全产品缺少清理能力；仅可确认本生命周期模块没有对应实现。 |

### 最关键的 3 条异常/权限/恢复边界

1. **P1｜merge-back ownership probe 失败时继续提交（E2 静态风险）**。可复核路径：向 `git.worktreeMergeBack` 传入一个有效、在项目内的 `repoPath` 与另一个 `worktreePath`；若 `git worktree list --porcelain` 失败，`mergeBackWorktree` 的 catch 会令 `ownsWorktree=true`。因为 schema 没有 session id/owner token，IPC 也不围栏 worktreePath，代码随后可能在该路径的仓库执行 `git add -A` + auto-commit，再尝试 merge 其 HEAD。方法已列入 `apiCatalog.generated.ts:1032-1040`，`policy.ts:252-257` 将 merge-back/remove 归为 DANGER；审批不能替代服务层的 ownership 证明。**未运行利用测试**，但 fail-open 分支是源码事实。
2. **P1｜旧 session path 被新 checkout 重占（代码事实 E2，跨会话隔离后果 E3）**。session A 的 `worktreePath` 持久化后，目录若被外部删除并且 stale Git registration 被 prune，detached 的 `nextWorktreeDir` 只按当前分支名和最低空闲序号找路径；session B 可能再次获得同一路径。A 的 `resolveSessionCwd` 只检查 `stat(path)` 是否存在，不核对 checkout instance/owner，因而可能把 B 的新 checkout 当成 A 的旧 checkout。实际时序尚未用临时仓库复现；建议把 instance token 校验纳入唯一 seam。
3. **P2｜创建在 Git 副作用后失败可能遗留孤儿 checkout（E2 静态事实，实际发生率 E3）**。`createDetachedWorktree` / `createBranchedWorktree` 在 `git worktree add` 后还要读取新 checkout 的 HEAD；若该读取失败，catch 只返回 `{ok:false}`，没有回滚刚创建的 worktree（`worktreeOps.ts:214-266`），而 `materializeWorktreeSession` 会在 `SessionRepo.updateWorktreePath` 之前抛错（`claude.ts:141-153`），session 因而没有记录这个路径。后续 list/remove 可能回收它，但没有自动重试/回滚保证。另有 `nextWorktreeDir` 的 stat/ref 检查与 add 之间的并发窗口（`worktreeOps.ts:158-175`）；未声称任何红例已复现。

## 一个接口 seam（只建议，不实现）

建议在 `apps/desktop/src/main/lib/` 现有 `worktreeOps.ts` 外围收敛一个 **`SessionWorktreeLifecycleProvider`**，继续以 `Project.id`、`Session.id` 和现有 session intent 为输入，不把 Project 改成 Worktree，也不改变普通 Project/Session 的可见语义。统一返回 `{ path, instanceId, branch?, head }`，并由同一 provider 负责 `materialize / inspect / mergeBack / remove`；每个后续操作必须验证 `projectId + sessionId + path + instanceId` 的归属。现有 desktop IPC、`app_api_*` 和 workflow 节点只调用该 provider，不各自实现 Git 生命周期。

- **统一 Provider**：Git/路径实现只有一个，IPC 和 headless 调用复用同一服务；provider 接口不依赖 renderer。
- **审批**：`git.worktreeMergeBack` 与 `git.worktreeRemove` 保持每次用户审批；更重要的是服务层在 ownership/状态未知时 fail closed。不得增加能绕过审批的 workflow/app_api 专用快捷路径。
- **app_api 与工作流**：当前 `git.worktreeList`、`git.worktreeMergeBack`、`git.worktreeRemove` 已在 app control catalog；`commandOutcome.ts:90-91` 将 merge/remove 的 `ok:false` 视为可能部分完成（UNCERTAIN），而不是安全重试。接入新 seam 应复用同一结果合同，不因工作流重试而重复提交或删除。
- **不引入新项目类型**：folder Project 仍是普通 Project；只有真实 Git checkout 才能成为 session 的 `worktreePath`。

## Top 2 借鉴点 + 1 条不宜照搬的设计

1. **借鉴设计｜实例身份与 host-qualified metadata（复杂度 M）**。参考 `shared/worktree/id.ts`、`host-qualified-worktree-meta.ts` 与 folder workspace 的随机 `instanceId`，给 Mcode 的已物化 checkout 加可校验的实例代次；重点解决 path 删除/重占后旧 session 误认新目录，而不是复制 Orca 的 id 字符串格式。回归门：删目录→prune→另一个 session 重建相同候选路径→旧 session 必须拒绝进入新 checkout；同时覆盖 Windows separator/case、Unicode NFC 和并发 session。
2. **小模块适配｜删除/恢复的串行协调 + 权威 reconciliation（复杂度 M/L）**。只吸收“同一 worktree 的并发删除合并为一个生命周期操作、删除中的 row 可见、完整 scan 才能清理 stale metadata”的原则；Mcode 已有 dirty guard、patch export、prune 与 session 回退，不应再建第二套状态源。回归门：重复删除/重试、运行中 turn、未知 Git status、missing checkout、Git 已 deregister 但目录残留、Windows 文件锁、嵌套 worktree、创建失败后列表恢复。
3. **不宜照搬｜Orca 的 folder workspace 合成 worktree catalog 语义（复杂度 S，避免移植）**。Orca 的 folder workspace 虽返回 Worktree-shaped row，但 `path=repo.path`、`head/branch` 为空，且 id 是同一 folder 的多实例后缀（`folder-workspace-model.ts:11-46`）；Mcode 的 `envMode="worktree"` 明确代表独立 Git checkout（`contracts/src/session.ts:195-213`）。若把 synthetic folder row 当作真实 session worktree，会混淆工作目录、Git ownership 和删除语义。保留两者分离；另外不把 Orca PR/push-target 相关 Git remote 配置流程直接塞进本地 session provider。

## 版权与完整回归门（不运行）

- `orca/LICENSE` 声明 MIT；本任务没有复制或提交 Orca 代码。MIT 审查不自动覆盖仓库内嵌资源和第三方依赖，未来若复用代码仍需逐项核查 notice、资产与依赖许可。
- 建议未来在临时 Git repo 上运行真实 Git 集成测试，至少覆盖：两个 session 并发创建同名 worktree；branch 已存在/已被 checkout/base commit 不同；创建后 HEAD 读取或 metadata 持久化失败；dirty 与 untracked tree、status 读取失败；merge conflict；ownership list probe 失败必须拒绝 commit；force+patch 写入失败的 UI/API 返回；删除中重复调用；目录已删除、stale registration/prune、同路径重占；session 重启后恢复；Windows 文件占用；folder Project 与嵌套 repo 的隔离边界。再验证 `app_api_*` 审批和 workflow 重试不会绕过相同 provider/结果合同。
- **本次未运行任何测试或构建**，上述为后续回归门而非 PASS 结果。

## 验收判定与计数

- 对照矩阵共 9 项：**部分已有 6、真缺失 1、与定位冲突 1、证据不足 1、等价已有 0**。
- 证据等级：核心实现结论主要为 E2；并发窗口与旧路径重占后的跨 session 后果为 E3 静态风险推断；E1/U1 均未执行。
- 未修改任何 Mcode 产品代码、Orca 文件、共享配置、用户数据、其他任务卡或其他研究报告。